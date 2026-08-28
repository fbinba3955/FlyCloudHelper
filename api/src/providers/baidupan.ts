import { ApiError } from "../errors.js";
import {
  PROVIDER_RATE_LIMIT_MAX_RETRIES,
  providerFetch,
  readProviderRateLimitDelayMs,
  registerProviderSharedRateLimit,
  validateProviderUrl,
  waitForProviderSharedRateLimit,
  type ProviderNetworkOptions,
} from "./network.js";
import {
  type ProviderAdapter,
  type ProviderConnectionContext,
  type ProviderDescriptor,
  type ProviderDirectoryListing,
  type ProviderEntry,
  type ProviderEnumerationOptions,
  type ProviderEnumerationWarning,
  type ProviderFileAccess,
  type ProviderValidationResult,
  type ProviderFileStreamAccess,
  type ScanRoot,
  createProviderRecommendedScanSettings,
  requireConnectionString,
  toFileSize,
} from "./types.js";

interface BaiduFileItem {
  fs_id?: number | string;
  path?: string;
  server_filename?: string;
  isdir?: number;
  size?: number;
  server_mtime?: number;
  md5?: string;
}

const DEFAULT_BAIDUPAN_REFRESH_URL = "https://api.oplist.org/baiduyun/renewapi";
const TOKEN_REFRESH_AHEAD_MS = 5 * 60 * 1000;

/** 百度网盘开放接口 Provider。 */
export class BaiduPanProvider implements ProviderAdapter {
  public readonly descriptor: ProviderDescriptor = {
    type: "baidupan",
    displayName: "百度网盘",
    adapterVersion: "1.0.0",
    credentialSchemaVersion: 2,
    capabilities: ["list", "stableResourceId", "playbackLocator", "directDownload", "relay"],
    recommendedScanSettings: createProviderRecommendedScanSettings({
      // 百度单页可以读取 1000 项，但业务码 31034 对突发并发更敏感。
      scanDirectoryConcurrency: { default: 4, min: 1, max: 4 },
      fullScanDirectoryConcurrency: 2,
    }),
    connectionFields: [
      { name: "accessToken", label: "Access Token", type: "password", required: true, secret: true },
      { name: "refreshToken", label: "Refresh Token", type: "password", required: true, secret: true },
      { name: "refreshUrl", label: "Token 刷新地址", type: "url", required: false, secret: false },
    ],
  };

  private readonly networkOptions: ProviderNetworkOptions;

  public constructor(networkOptions: ProviderNetworkOptions) {
    this.networkOptions = networkOptions;
  }

  /** 读取根目录验证百度网盘 Access Token。 */
  public async validateConnection(
    connection: Record<string, unknown>,
    signal?: AbortSignal,
    context?: ProviderConnectionContext,
  ): Promise<ProviderValidationResult> {
    await this.listDirectory(connection, "/", 0, signal, context?.persistConnection);
    return { valid: true, accountLabel: null, rootAccessible: true };
  }

  /** 验证每个百度网盘扫描根路径可以正常列目录。 */
  public async validateRoots(
    connection: Record<string, unknown>,
    roots: ScanRoot[],
    signal?: AbortSignal,
    context?: ProviderConnectionContext,
  ): Promise<void> {
    const selectedRoots = roots.length > 0 ? roots : [{ displayPath: "/" }];
    for (const root of selectedRoots) {
      await this.listDirectory(connection, root.displayPath || root.resourceId || "/", 0, signal,
        context?.persistConnection);
    }
  }

  /** 返回百度网盘当前路径的直接子目录，供前端目录选择器使用。 */
  public async browseDirectories(
    connection: Record<string, unknown>,
    parent?: ScanRoot,
    signal?: AbortSignal,
    context?: ProviderConnectionContext,
  ): Promise<ProviderDirectoryListing> {
    const directory = parent?.displayPath || parent?.resourceId || "/";
    let start = 0;
    const items: ProviderDirectoryListing["items"] = [];
    while (true) {
      const page = await this.listDirectory(connection, directory, start, signal, context?.persistConnection);
      for (const item of page.items) {
        if (item.isdir !== 1) continue;
        const displayPath = item.path || `${directory.replace(/\/$/u, "")}/${item.server_filename ?? ""}`;
        const resourceId = String(item.fs_id ?? displayPath);
        items.push({
          name: item.server_filename || displayPath.split("/").pop() || resourceId,
          resourceId,
          displayPath,
        });
      }
      if (!page.hasMore || page.items.length === 0) break;
      start += page.items.length;
    }
    items.sort((left, right) => left.name.localeCompare(right.name, "zh-CN", { numeric: true }));
    return {
      current: {
        name: directory === "/" ? "/" : directory.replace(/\/$/u, "").split("/").pop() || "/",
        resourceId: parent?.resourceId || directory,
        displayPath: directory,
      },
      items,
    };
  }

  /** 按目录 path 递归枚举百度网盘文件。 */
  public async *enumerate(
    connection: Record<string, unknown>,
    roots: ScanRoot[],
    signal?: AbortSignal,
    _onWarning?: (warning: ProviderEnumerationWarning) => void,
    options?: ProviderEnumerationOptions,
  ): AsyncGenerator<ProviderEntry> {
    const selectedRoots = roots.length > 0 ? roots : [{ displayPath: "/" }];
    for (let rootIndex = 0; rootIndex < selectedRoots.length; rootIndex += 1) {
      const root = selectedRoots[rootIndex];
      if (!root) continue;
      // 根目录只有完整枚举后才允许扫描收尾清理旧文件；中止或异常不会提交完成状态。
      await options?.onRootStart?.({ rootIndex, root, warningCount: 0 });
      const queue = [root.displayPath || root.resourceId || "/"];
      const visited = new Set<string>();
      const directoryConcurrency = Math.max(1, options?.directoryConcurrency ?? 1);
      while (queue.length > 0) {
        if (signal?.aborted) return;
        const directoryBatch = queue.splice(0, directoryConcurrency)
          .filter((directory) => !visited.has(directory));
        directoryBatch.forEach((directory) => visited.add(directory));
        const batchResults = await Promise.all(directoryBatch.map(async (directory) => {
          let start = 0;
          const entries: BaiduFileItem[] = [];
          while (true) {
            const page = await this.listDirectory(connection, directory, start, signal, options?.persistConnection);
            entries.push(...page.items);
            if (!page.hasMore || page.items.length === 0) break;
            start += page.items.length;
          }
          return { directory, entries };
        }));
        for (const { directory, entries } of batchResults) {
          for (const item of entries) {
            const path = item.path || `${directory.replace(/\/$/u, "")}/${item.server_filename ?? ""}`;
            const resourceId = String(item.fs_id ?? path);
            const name = item.server_filename || path.split("/").pop() || resourceId;
            if (item.isdir === 1) {
              queue.push(path);
            } else {
              yield {
                resourceId,
                parentResourceId: directory,
                path,
                name,
                isDirectory: false,
                size: toFileSize(item.size),
                modifiedAt: item.server_mtime ? new Date(item.server_mtime * 1000).toISOString() : null,
                etag: item.md5 ?? null,
                locator: { providerType: "baidupan", fsId: resourceId, path },
              };
            }
          }
        }
      }
      await options?.onRootComplete?.({ rootIndex, root, warningCount: 0 });
    }
  }

  /** 使用 fs_id 换取百度网盘 dlink，并把本次播放需要的 Token 和请求头临时下发给 APP。 */
  public async resolveFileAccess(
    connection: Record<string, unknown>,
    locator: Record<string, unknown>,
    signal?: AbortSignal,
    context?: ProviderConnectionContext,
  ): Promise<ProviderFileAccess> {
    return this.resolvePlaybackAccess(connection, locator, signal, context);
  }

  /** 使用与直连一致的百度播放地址作为云助手中转上游。 */
  public async resolveFileStreamAccess(
    connection: Record<string, unknown>,
    locator: Record<string, unknown>,
    signal?: AbortSignal,
    context?: ProviderConnectionContext,
  ): Promise<ProviderFileStreamAccess> {
    return this.resolvePlaybackAccess(connection, locator, signal, context);
  }

  /** 统一解析百度网盘直连和中转播放需要的临时访问数据。 */
  private async resolvePlaybackAccess(
    connection: Record<string, unknown>,
    locator: Record<string, unknown>,
    signal?: AbortSignal,
    context?: ProviderConnectionContext,
  ): Promise<ProviderFileAccess> {
    await this.ensureValidToken(connection, context?.persistConnection, signal);
    const accessToken = requireConnectionString(connection, "accessToken", "Access Token");
    const fsId = requireConnectionString(locator, "fsId", "文件 ID");
    if (!/^\d+$/u.test(fsId)) {
      this.networkOptions.logConnectionFailure?.({
        日志关键字: "codex-baidupan-cloud-playback",
        事件: "百度网盘播放文件ID格式无效",
        文件ID长度: fsId.length,
        文件ID是否纯数字: false,
      });
      throw new ApiError(422, "baidupan_file_id_invalid", "百度网盘播放文件 ID 无效，请重新扫描后重试");
    }
    const apiBase = typeof connection.apiBaseUrl === "string" && connection.apiBaseUrl ? connection.apiBaseUrl : "https://pan.baidu.com";
    const baseUrl = await validateProviderUrl(apiBase, this.networkOptions);
    const url = new URL("/rest/2.0/xpan/multimedia", baseUrl);
    url.searchParams.set("method", "filemetas");
    url.searchParams.set("access_token", accessToken);
    // 关键变量：fs_id 可能超过 JavaScript 安全整数范围，直接拼接数字 JSON，不能先转换成 Number。
    url.searchParams.set("fsids", `[${fsId}]`);
    url.searchParams.set("dlink", "1");
    const payload = await this.requestBaiduJsonWithRateLimitRetry<{
      errno?: number;
      list?: Array<{ dlink?: string }>;
    }>(url, signal);
    if (payload.errno && payload.errno !== 0) {
      this.networkOptions.logConnectionFailure?.({
        日志关键字: "codex-baidupan-cloud-playback",
        事件: "百度网盘播放地址解析失败",
        业务错误码: payload.errno,
        文件ID长度: fsId.length,
      });
      throw new Error(`百度网盘下载接口错误 ${payload.errno}`);
    }
    const dlink = payload.list?.[0]?.dlink;
    if (!dlink) {
      this.networkOptions.logConnectionFailure?.({
        日志关键字: "codex-baidupan-cloud-playback",
        事件: "百度网盘播放地址为空",
        文件ID长度: fsId.length,
      });
      throw new Error("百度网盘开放接口未返回下载地址");
    }
    const downloadUrl = new URL(dlink);
    downloadUrl.searchParams.set("access_token", accessToken);
    return { url: downloadUrl.href, expiresAt: null, headers: { "User-Agent": "pan.baidu.com" } };
  }

  /** 请求百度网盘 xpan 文件列表接口。 */
  private async listDirectory(
    connection: Record<string, unknown>,
    directory: string,
    start: number,
    signal?: AbortSignal,
    persistConnection?: (connection: Record<string, unknown>) => Promise<void>,
  ): Promise<{ items: BaiduFileItem[]; hasMore: boolean }> {
    await this.ensureValidToken(connection, persistConnection, signal);
    const accessToken = requireConnectionString(connection, "accessToken", "Access Token");
    const apiBase = typeof connection.apiBaseUrl === "string" && connection.apiBaseUrl
      ? connection.apiBaseUrl
      : "https://pan.baidu.com";
    const baseUrl = await validateProviderUrl(apiBase, this.networkOptions);
    const url = new URL("/rest/2.0/xpan/file", baseUrl);
    url.searchParams.set("method", "list");
    url.searchParams.set("access_token", accessToken);
    url.searchParams.set("dir", directory);
    url.searchParams.set("start", String(start));
    url.searchParams.set("limit", "1000");
    url.searchParams.set("web", "1");
    const payload = await this.requestBaiduJsonWithRateLimitRetry<{
      errno?: number;
      list?: BaiduFileItem[];
      has_more?: number;
    }>(url, signal);
    if (payload.errno && payload.errno !== 0) {
      throw new Error(`百度网盘接口错误 ${payload.errno}`);
    }
    return { items: Array.isArray(payload.list) ? payload.list : [], hasMore: payload.has_more === 1 };
  }

  /** 处理百度网盘以 HTTP 200 返回 errno=31034 的业务限流。 */
  private async requestBaiduJsonWithRateLimitRetry<T extends { errno?: number }>(
    url: URL,
    signal?: AbortSignal,
  ): Promise<T> {
    let retryCount = 0;
    while (true) {
      // HTTP 429 由 providerFetch 统一退避，这里只处理响应体中的百度业务限流码。
      const response = await providerFetch(url, { method: "GET" }, this.networkOptions, signal);
      const responseText = await response.text();
      // 关键变量：百度 fs_id 可能超过安全整数范围，必须在 JSON.parse 前转成字符串保留原始十进制值。
      const stableIdResponseText = responseText.replace(/("fs_id"\s*:\s*)(-?\d+)/gu, "$1\"$2\"");
      const payload = JSON.parse(stableIdResponseText) as T;
      if (payload.errno !== 31034) return payload;
      if (retryCount >= PROVIDER_RATE_LIMIT_MAX_RETRIES || signal?.aborted) {
        this.networkOptions.logConnectionFailure?.({
          日志关键字: "codex-flycloud-provider-rate-limit",
          性能日志关键字: "codex-flycloud-scan-performance",
          事件: "百度网盘业务限流重试后仍未恢复",
          请求路径: url.pathname,
          业务错误码: payload.errno,
          已重试次数: retryCount,
        });
        throw new ApiError(503, "provider_rate_limited", "百度网盘访问频率受限，自动重试后仍未恢复，请稍后重试");
      }
      const retryDelayMs = readProviderRateLimitDelayMs(null, retryCount);
      retryCount += 1;
      const sharedCooldownUntilMs = registerProviderSharedRateLimit(url, retryDelayMs);
      this.networkOptions.logConnectionFailure?.({
        日志关键字: "codex-flycloud-provider-rate-limit",
        性能日志关键字: "codex-flycloud-scan-performance",
        事件: "百度网盘业务限流后等待重试",
        请求路径: url.pathname,
        业务错误码: payload.errno,
        当前重试次数: retryCount,
        最大重试次数: PROVIDER_RATE_LIMIT_MAX_RETRIES,
        等待毫秒: retryDelayMs,
        共享冷却截止时间: new Date(sharedCooldownUntilMs).toISOString(),
      });
      await waitForProviderSharedRateLimit(url, signal);
    }
  }

  /** 临近过期时刷新百度令牌，并把轮换后的 Refresh Token 原位加密保存。 */
  private async ensureValidToken(
    connection: Record<string, unknown>,
    persistConnection?: (connection: Record<string, unknown>) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    const accessToken = typeof connection.accessToken === "string" ? connection.accessToken.trim() : "";
    const expiresAt = Number(connection.expiresAt ?? 0);
    if (accessToken && (expiresAt <= 0 || Date.now() + TOKEN_REFRESH_AHEAD_MS < expiresAt)) return;
    const refreshToken = requireConnectionString(connection, "refreshToken", "Refresh Token");
    const configuredRefreshUrl = typeof connection.refreshUrl === "string" && connection.refreshUrl.trim()
      ? connection.refreshUrl.trim()
      : DEFAULT_BAIDUPAN_REFRESH_URL;
    const refreshUrl = new URL(configuredRefreshUrl);
    if (refreshUrl.protocol !== "https:") throw new Error("百度网盘 Token 刷新地址必须使用 HTTPS");
    refreshUrl.searchParams.set("refresh_ui", refreshToken);
    refreshUrl.searchParams.set("server_use", "true");
    refreshUrl.searchParams.set("driver_txt", "baiduyun_go");
    const safeRefreshUrl = await validateProviderUrl(refreshUrl.href, this.networkOptions);
    const response = await providerFetch(safeRefreshUrl, { method: "GET" }, this.networkOptions, signal);
    const payload = await response.json() as Record<string, unknown>;
    const nextAccessToken = typeof payload.access_token === "string" ? payload.access_token.trim()
      : typeof payload.accessToken === "string" ? payload.accessToken.trim() : "";
    if (!nextAccessToken) throw new Error("百度网盘令牌刷新接口未返回 Access Token");
    const nextRefreshToken = typeof payload.refresh_token === "string" && payload.refresh_token.trim()
      ? payload.refresh_token.trim()
      : typeof payload.refreshToken === "string" && payload.refreshToken.trim()
        ? payload.refreshToken.trim() : refreshToken;
    // 关键变量：刷新站响应可能不包含有效期，避免将 NaN 写入加密连接。
    const rawExpiresIn = Number(payload.expires_in ?? payload.expiresIn ?? 0);
    const expiresIn = Number.isFinite(rawExpiresIn) ? Math.max(0, rawExpiresIn) : 0;
    connection.accessToken = nextAccessToken;
    connection.refreshToken = nextRefreshToken;
    connection.expiresAt = expiresIn > 0 ? Date.now() + expiresIn * 1000 : 0;
    connection.refreshUrl = configuredRefreshUrl;
    await persistConnection?.(connection);
  }
}
