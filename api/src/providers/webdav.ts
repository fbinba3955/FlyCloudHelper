import { XMLParser } from "fast-xml-parser";
import { ApiError } from "../errors.js";
import { isFlymbyExcludedFolderName } from "../media/flymby-scan-exclusions.js";
import { providerFetch, validateProviderUrl, type ProviderNetworkOptions } from "./network.js";
import {
  type ProviderAdapter,
  type ProviderDescriptor,
  type ProviderDirectoryListing,
  type ProviderEntry,
  type ProviderEnumerationOptions,
  type ProviderEnumerationCheckpoint,
  type ProviderEnumerationWarning,
  type ProviderFileStreamAccess,
  type ProviderValidationResult,
  type ScanRoot,
  createFlymbyRecommendedScanSettings,
  requireConnectionString,
  toFileSize,
} from "./types.js";

/** 将单值或数组统一转换为数组。 */
function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

/** 对 URL 路径执行容错解码。 */
function decodePath(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

/** 去除 WebDAV 目录尾部斜杠，确保 PROPFIND 返回的当前目录不会混入子目录列表。 */
function normalizeDirectoryPath(pathname: string): string {
  return decodePath(pathname).replace(/\/+$/u, "") || "/";
}

/** 将 WebDAV 返回的已解码路径逐段编码，避免 #、?、空格等字符被 URL 构造器解释为结构字符。 */
function encodeDecodedWebDavPath(resourcePath: string): string {
  const normalizedPath = resourcePath.startsWith("/") ? resourcePath : `/${resourcePath}`;
  return normalizedPath.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

/** NFO 需要先于同目录视频交给 Worker，保证本地元数据优先于在线刮削。 */
function sortDirectoryEntries(entries: ProviderEntry[]): ProviderEntry[] {
  return [...entries].sort((left, right) => {
    const priority = (entry: ProviderEntry): number => entry.isDirectory ? 2 : /\.nfo$/iu.test(entry.name) ? 0 : 1;
    return priority(left) - priority(right);
  });
}

/** 读取 WebDAV 目录异常对应的原始 HTTP 状态码，便于从日志区分认证失败和目录权限不足。 */
function readWebDavResponseStatus(error: unknown): number | null {
  if (!(error instanceof ApiError)) {
    return null;
  }
  if (error.code === "provider_authentication_failed") {
    return 401;
  }
  if (error.code === "provider_permission_denied") {
    return 403;
  }
  return error.statusCode;
}

/** 校验并读取 WebDAV 枚举检查点，损坏或其他 Provider 的游标直接忽略。 */
function readWebDavCheckpoint(value: Record<string, unknown> | null | undefined): ProviderEnumerationCheckpoint | null {
  if (!value
    || value.providerType !== "webdav"
    || Number(value.version) !== 1
    || !Number.isInteger(Number(value.rootIndex))
    || !Array.isArray(value.pendingDirectories)) {
    return null;
  }
  const pendingDirectories = value.pendingDirectories.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const rawItem = item as Record<string, unknown>;
    if (typeof rawItem.resourcePath !== "string" || !rawItem.resourcePath) return [];
    return [{ resourcePath: rawItem.resourcePath, isRoot: rawItem.isRoot === true }];
  });
  return {
    providerType: "webdav",
    version: 1,
    checkpointSequence: Math.max(0, Number(value.checkpointSequence) || 0),
    rootIndex: Math.max(0, Number(value.rootIndex) || 0),
    rootWarningCount: Math.max(0, Number(value.rootWarningCount) || 0),
    pendingDirectories,
  };
}

/** 标准 RFC 4918 WebDAV Provider。 */
export class WebDavProvider implements ProviderAdapter {
  public readonly descriptor: ProviderDescriptor = {
    type: "webdav",
    displayName: "WebDAV",
    adapterVersion: "1.0.0",
    credentialSchemaVersion: 1,
    capabilities: ["list", "readText", "rangeRead", "pathIdentity", "playbackLocator", "relayPlayback"],
    recommendedScanSettings: createFlymbyRecommendedScanSettings(),
    connectionFields: [
      { name: "baseUrl", label: "WebDAV 地址", type: "url", required: true, secret: false },
      { name: "username", label: "用户名", type: "text", required: false, secret: false },
      { name: "password", label: "密码", type: "password", required: false, secret: true },
      { name: "bearerToken", label: "Bearer Token", type: "password", required: false, secret: true },
    ],
  };

  private readonly networkOptions: ProviderNetworkOptions;
  private readonly xmlParser = new XMLParser({ removeNSPrefix: true, ignoreAttributes: false });

  public constructor(networkOptions: ProviderNetworkOptions) {
    this.networkOptions = networkOptions;
  }

  /** 使用 Depth:0 PROPFIND 验证连接和根目录访问。 */
  public async validateConnection(
    connection: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ProviderValidationResult> {
    const baseUrl = requireConnectionString(connection, "baseUrl", "WebDAV 地址");
    const url = await validateProviderUrl(baseUrl, this.networkOptions);
    await this.propfind(url, connection, "0", signal);
    return {
      valid: true,
      accountLabel: typeof connection.username === "string" ? connection.username : null,
      rootAccessible: true,
    };
  }

  /** 逐个验证配置的 WebDAV 扫描根，并同时执行同源限制。 */
  public async validateRoots(
    connection: Record<string, unknown>,
    roots: ScanRoot[],
    signal?: AbortSignal,
  ): Promise<void> {
    const baseUrl = await validateProviderUrl(
      requireConnectionString(connection, "baseUrl", "WebDAV 地址"),
      this.networkOptions,
    );
    const selectedRoots = roots.length > 0 ? roots : [{ displayPath: "/" }];
    for (const root of selectedRoots) {
      await this.propfind(
        this.resolveSameOriginPath(baseUrl, root.resourceId || root.displayPath || "/"),
        connection,
        "0",
        signal,
      );
    }
  }

  /** 返回当前 WebDAV 目录的直接子目录，供前端逐级选择扫描路径。 */
  public async browseDirectories(
    connection: Record<string, unknown>,
    parent?: ScanRoot,
    signal?: AbortSignal,
  ): Promise<ProviderDirectoryListing> {
    const baseUrl = await validateProviderUrl(
      requireConnectionString(connection, "baseUrl", "WebDAV 地址"),
      this.networkOptions,
    );
    const selectedPath = parent?.resourceId || parent?.displayPath || "/";
    const directoryUrl = this.resolveSameOriginPath(baseUrl, selectedPath);
    const entries = await this.propfind(directoryUrl, connection, "1", signal);
    // 关键变量：WebDAV 服务可能用不同的尾斜杠格式返回当前目录。
    const currentDirectoryPath = normalizeDirectoryPath(directoryUrl.pathname);
    const items = entries
      .filter((entry) => entry.isDirectory && normalizeDirectoryPath(entry.resourceId) !== currentDirectoryPath)
      .filter((entry) => !isFlymbyExcludedFolderName(entry.name))
      .map((entry) => {
        this.resolveEnumeratedPath(baseUrl, entry.resourceId);
        const configuredPath = this.toConfiguredPath(baseUrl, entry.resourceId);
        return {
          name: entry.name,
          resourceId: configuredPath,
          displayPath: configuredPath,
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name, "zh-CN", { numeric: true }));
    return {
      current: {
        name: selectedPath === "/" ? "/" : selectedPath.replace(/\/+$/u, "").split("/").pop() || "/",
        resourceId: selectedPath,
        displayPath: selectedPath,
      },
      items,
    };
  }

  /** 按扫描根递归枚举 WebDAV 文件，避免使用可能被服务端禁用的 Depth:infinity。 */
  public async *enumerate(
    connection: Record<string, unknown>,
    roots: ScanRoot[],
    signal?: AbortSignal,
    onWarning?: (warning: ProviderEnumerationWarning) => void,
    options?: ProviderEnumerationOptions,
  ): AsyncGenerator<ProviderEntry> {
    const baseUrl = await validateProviderUrl(
      requireConnectionString(connection, "baseUrl", "WebDAV 地址"),
      this.networkOptions,
    );
    const selectedRoots = roots.length > 0 ? roots : [{ displayPath: "/" }];
    const resumeCheckpoint = readWebDavCheckpoint(options?.resumeState);
    const resumeRootIndex = resumeCheckpoint && resumeCheckpoint.rootIndex < selectedRoots.length
      ? resumeCheckpoint.rootIndex
      : 0;
    let nextCheckpointSequence = resumeCheckpoint?.checkpointSequence ?? 0;
    for (let rootIndex = resumeRootIndex; rootIndex < selectedRoots.length; rootIndex += 1) {
      const root = selectedRoots[rootIndex];
      if (!root) continue;
      const rootPath = root.resourceId || root.displayPath || "/";
      const rootUrl = this.resolveSameOriginPath(baseUrl, rootPath);
      // 关键变量：根目录异常必须终止，扫描过程中任一子目录读取异常则按 APP 的容错语义跳过。
      const resumedDirectories = resumeCheckpoint && rootIndex === resumeRootIndex
        ? resumeCheckpoint.pendingDirectories
        : [];
      const queue: Array<{ url: URL; isRoot: boolean }> = resumedDirectories.length > 0
        ? resumedDirectories.map((directory) => ({
          url: this.resolveEnumeratedPath(baseUrl, directory.resourcePath),
          isRoot: directory.isRoot,
        }))
        : [{ url: rootUrl, isRoot: true }];
      const visited = new Set<string>();
      const directoryConcurrency = Math.max(1, options?.directoryConcurrency ?? 1);
      const checkpointDirectoryInterval = Math.max(1, options?.checkpointDirectoryInterval ?? 20);
      let completedDirectoryBatchCount = 0;
      let rootWarningCount = resumeCheckpoint && rootIndex === resumeRootIndex
        ? resumeCheckpoint.rootWarningCount
        : 0;
      await options?.onRootStart?.({ rootIndex, root, warningCount: rootWarningCount });
      while (queue.length > 0) {
        if (signal?.aborted) {
          return;
        }
        if (completedDirectoryBatchCount === 0) {
          // 关键变量：游标包含尚未处理的当前批次；Worker 崩溃或暂停后最多重放一个检查点窗口。
          options?.onCheckpoint?.({
            providerType: "webdav",
            version: 1,
            checkpointSequence: nextCheckpointSequence,
            rootIndex,
            rootWarningCount,
            pendingDirectories: queue.map((directory) => ({
              resourcePath: decodePath(directory.url.pathname),
              isRoot: directory.isRoot,
            })),
          });
          nextCheckpointSequence += 1;
        }
        // 关键变量：一批目录并行读取，但每个目录的条目仍连续产出，保证 Worker 可以按目录聚合影片。
        const directoryBatch = queue.splice(0, directoryConcurrency)
          .filter((directory) => !visited.has(directory.url.href));
        directoryBatch.forEach((directory) => visited.add(directory.url.href));
        const batchResults = await Promise.all(directoryBatch.map(async (queuedDirectory) => {
          try {
            const entries = await this.propfind(queuedDirectory.url, connection, "1", signal);
            return { queuedDirectory, entries, error: null };
          } catch (error) {
            return { queuedDirectory, entries: [] as ProviderEntry[], error };
          }
        }));
        for (const result of batchResults) {
          const directoryUrl = result.queuedDirectory.url;
          if (result.error) {
            // Flymby APP 的 scanOneDirectory 会记录任意单目录读取异常并继续，避免一个受限或临时故障目录拖垮整次扫描。
            if (!result.queuedDirectory.isRoot) {
              const errorCode = result.error instanceof ApiError ? result.error.code : "provider_directory_unavailable";
              const errorMessage = result.error instanceof Error ? result.error.message : "WebDAV 子目录访问失败";
              rootWarningCount += 1;
              onWarning?.({ code: errorCode, message: errorMessage, path: decodePath(directoryUrl.pathname) });
              this.networkOptions.logConnectionFailure?.({
                日志关键字: "codex-flycloud-helper-webdav-directory",
                事件: "扫描时跳过无法访问的子目录",
                请求方法: "PROPFIND",
                目录路径: decodePath(directoryUrl.pathname),
                是否扫描根目录: false,
                响应状态码: readWebDavResponseStatus(result.error),
                错误码: errorCode,
                错误信息: errorMessage,
              });
              continue;
            }
            this.networkOptions.logConnectionFailure?.({
              日志关键字: "codex-flycloud-helper-webdav-directory",
              事件: "扫描根目录访问失败",
              请求方法: "PROPFIND",
              目录路径: decodePath(directoryUrl.pathname),
              是否扫描根目录: true,
              响应状态码: readWebDavResponseStatus(result.error),
              错误码: result.error instanceof ApiError ? result.error.code : "provider_directory_unavailable",
              错误信息: result.error instanceof Error ? result.error.message : "WebDAV 扫描根目录访问失败",
            });
            throw result.error;
          }
          for (const entry of sortDirectoryEntries(result.entries)) {
            if (entry.resourceId === decodePath(directoryUrl.pathname)) continue;
            if (entry.isDirectory) {
              if (!isFlymbyExcludedFolderName(entry.name)) {
                queue.push({ url: this.resolveEnumeratedPath(baseUrl, entry.resourceId), isRoot: false });
              }
            } else {
              // Worker 和 Flymby APP 都使用相对 WebDAV 连接根的路径进行扫描根判断与标题识别。
              const configuredPath = this.toConfiguredPath(baseUrl, entry.path);
              yield {
                ...entry,
                path: configuredPath,
                // 关键变量：资源 ID 和播放定位继续保留 Provider 原值，避免已有媒体身份发生变化。
                locator: entry.locator,
              };
            }
          }
        }
        completedDirectoryBatchCount = (completedDirectoryBatchCount + 1) % checkpointDirectoryInterval;
      }
      await options?.onRootComplete?.({ rootIndex, root, warningCount: rootWarningCount });
    }
  }

  /**
   * 生成仅供 FlyCloudHelper 中转使用的 WebDAV 上游请求。
   * Authorization 只保留在服务端内存中，不能复用 APP 临时地址响应。
   */
  public async resolveFileStreamAccess(
    connection: Record<string, unknown>,
    locator: Record<string, unknown>,
  ): Promise<ProviderFileStreamAccess> {
    const baseUrl = await validateProviderUrl(
      requireConnectionString(connection, "baseUrl", "WebDAV 地址"),
      this.networkOptions,
    );
    // 关键变量：扫描时保存的原始 WebDAV 路径用于准确恢复带空格、井号和中文的文件地址。
    const resourcePath = typeof locator.path === "string" && locator.path.trim()
      ? locator.path
      : typeof locator.resourceId === "string" && locator.resourceId.trim()
        ? locator.resourceId
        : "";
    if (!resourcePath) {
      throw new ApiError(422, "provider_file_locator_invalid", "WebDAV 文件定位无效");
    }
    return {
      url: this.resolveEnumeratedPath(baseUrl, resourcePath).href,
      headers: this.createAuthorizationHeaders(connection),
      expiresAt: null,
    };
  }

  /** 读取扫描发现的 NFO 等小型文本文件，内容上限避免异常文件占用过多内存。 */
  public async readText(
    connection: Record<string, unknown>,
    entry: ProviderEntry,
    signal?: AbortSignal,
  ): Promise<string> {
    const baseUrl = await validateProviderUrl(
      requireConnectionString(connection, "baseUrl", "WebDAV 地址"),
      this.networkOptions,
    );
    if (entry.size > 2 * 1024 * 1024) {
      throw new ApiError(422, "provider_text_file_too_large", "NFO 文件超过 2 MiB，已跳过读取");
    }
    // 关键变量：优先使用播放定位中的原始 WebDAV 路径，兼容后续其他路径表现形式。
    const rawResourcePath = typeof entry.locator.path === "string" ? entry.locator.path : entry.resourceId;
    const response = await providerFetch(
      this.resolveEnumeratedPath(baseUrl, rawResourcePath),
      { method: "GET", headers: this.createAuthorizationHeaders(connection) },
      this.networkOptions,
      signal,
    );
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > 2 * 1024 * 1024) {
      throw new ApiError(422, "provider_text_file_too_large", "NFO 文件超过 2 MiB，已跳过读取");
    }
    return text;
  }

  /** 发起 PROPFIND 并解析 Multi-Status 资源列表。 */
  private async propfind(
    url: URL,
    connection: Record<string, unknown>,
    depth: "0" | "1",
    signal?: AbortSignal,
  ): Promise<ProviderEntry[]> {
    const response = await providerFetch(url, {
      method: "PROPFIND",
      headers: {
        ...this.createAuthorizationHeaders(connection),
        Depth: depth,
        "Content-Type": "application/xml; charset=utf-8",
      },
      body: `<?xml version="1.0" encoding="utf-8" ?><D:propfind xmlns:D="DAV:"><D:prop><D:displayname/><D:resourcetype/><D:getcontentlength/><D:getlastmodified/><D:getetag/></D:prop></D:propfind>`,
    }, this.networkOptions, signal);
    const document = this.xmlParser.parse(await response.text()) as Record<string, unknown>;
    const multistatus = document.multistatus as Record<string, unknown> | undefined;
    const resources = toArray(multistatus?.response as Record<string, unknown> | Record<string, unknown>[] | undefined);
    return resources.flatMap((resource): ProviderEntry[] => {
      const href = typeof resource.href === "string" ? resource.href : "";
      if (!href) {
        return [];
      }
      const propstats = toArray(resource.propstat as Record<string, unknown> | Record<string, unknown>[] | undefined);
      const successful = propstats.find((item) => String(item.status ?? "").includes(" 200 ")) ?? propstats[0];
      const prop = successful?.prop as Record<string, unknown> | undefined;
      if (!prop) {
        return [];
      }
      const resourceType = prop.resourcetype as Record<string, unknown> | undefined;
      const isDirectory = Boolean(resourceType && Object.prototype.hasOwnProperty.call(resourceType, "collection"));
      const resolvedUrl = new URL(href, url);
      const path = decodePath(resolvedUrl.pathname);
      const trimmedPath = path.replace(/\/$/u, "");
      const name = typeof prop.displayname === "string" && prop.displayname
        ? prop.displayname
        : trimmedPath.split("/").pop() || "/";
      return [{
        resourceId: path,
        parentResourceId: trimmedPath.includes("/")
          ? `${trimmedPath.slice(0, trimmedPath.lastIndexOf("/") + 1)}`
          : null,
        path,
        name,
        isDirectory,
        size: toFileSize(prop.getcontentlength),
        modifiedAt: typeof prop.getlastmodified === "string"
          ? new Date(prop.getlastmodified).toISOString()
          : null,
        etag: typeof prop.getetag === "string" ? prop.getetag : null,
        locator: { providerType: "webdav", path, resourceId: path },
      }];
    });
  }

  /** 把扫描根限制为当前 WebDAV 地址下的路径，禁止切换协议、主机或端口。 */
  private resolveSameOriginPath(baseUrl: URL, rawPath: string): URL {
    const selectedPath = rawPath.trim() || "/";
    if (/^[a-z][a-z\d+.-]*:/iu.test(selectedPath)
      || selectedPath.startsWith("//")
      || selectedPath.startsWith("\\")
      || selectedPath.includes("?")
      || selectedPath.includes("#")
      || selectedPath.split(/[\\/]+/u).includes("..")) {
      throw new ApiError(422, "provider_root_invalid", "WebDAV 扫描路径只能使用不包含查询参数的站内路径");
    }
    const directoryBase = baseUrl.href.endsWith("/") ? baseUrl : new URL(`${baseUrl.href}/`);
    const resolved = new URL(selectedPath.replace(/^\/+/, ""), directoryBase);
    if (resolved.origin !== baseUrl.origin) {
      throw new ApiError(422, "provider_root_invalid", "WebDAV 扫描路径不能切换到其他站点");
    }
    this.requirePathWithinBase(baseUrl, resolved);
    return resolved;
  }

  /** 把 WebDAV 响应中的绝对路径还原到同一站点，并限制在连接根目录内。 */
  private resolveEnumeratedPath(baseUrl: URL, resourcePath: string): URL {
    const resolved = new URL(encodeDecodedWebDavPath(resourcePath), `${baseUrl.origin}/`);
    if (resolved.origin !== baseUrl.origin) {
      throw new ApiError(502, "provider_response_invalid", "WebDAV 返回了跨站目录地址");
    }
    this.requirePathWithinBase(baseUrl, resolved);
    return resolved;
  }

  /** 把 WebDAV 绝对响应路径转换为相对连接根的可保存扫描路径。 */
  private toConfiguredPath(baseUrl: URL, resourcePath: string): string {
    const basePath = decodePath(baseUrl.pathname).replace(/\/+$/u, "");
    const normalizedResourcePath = `/${resourcePath.replace(/^\/+|\/+$/gu, "")}`;
    if (!basePath || basePath === "/") {
      return normalizedResourcePath === "//" ? "/" : normalizedResourcePath;
    }
    if (normalizedResourcePath === basePath) {
      return "/";
    }
    const relativePath = normalizedResourcePath.slice(basePath.length);
    return relativePath.startsWith("/") ? relativePath : `/${relativePath}`;
  }

  /** 确保派生地址没有逃逸 WebDAV 连接配置的根目录。 */
  private requirePathWithinBase(baseUrl: URL, resolved: URL): void {
    const basePath = `${baseUrl.pathname.replace(/\/+$/u, "")}/`;
    const resolvedPath = `${resolved.pathname.replace(/\/+$/u, "")}/`;
    if (basePath !== "/" && !resolvedPath.startsWith(basePath)) {
      throw new ApiError(422, "provider_root_invalid", "WebDAV 扫描路径不能超出连接根目录");
    }
  }

  /** 根据 Bearer 或 Basic 凭据生成请求头。 */
  private createAuthorizationHeaders(connection: Record<string, unknown>): Record<string, string> {
    if (typeof connection.bearerToken === "string" && connection.bearerToken) {
      return { Authorization: `Bearer ${connection.bearerToken}` };
    }
    const username = typeof connection.username === "string" ? connection.username : "";
    const password = typeof connection.password === "string" ? connection.password : "";
    return username || password
      ? { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` }
      : {};
  }
}
