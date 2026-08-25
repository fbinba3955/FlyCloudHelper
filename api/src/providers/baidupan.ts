import { providerFetch, validateProviderUrl, type ProviderNetworkOptions } from "./network.js";
import {
  type ProviderAdapter,
  type ProviderDescriptor,
  type ProviderDirectoryListing,
  type ProviderEntry,
  type ProviderEnumerationOptions,
  type ProviderEnumerationWarning,
  type ProviderValidationResult,
  type ProviderFileStreamAccess,
  type ScanRoot,
  createFlymbyRecommendedScanSettings,
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

/** 百度网盘开放接口 Provider。 */
export class BaiduPanProvider implements ProviderAdapter {
  public readonly descriptor: ProviderDescriptor = {
    type: "baidupan",
    displayName: "百度网盘",
    adapterVersion: "1.0.0",
    credentialSchemaVersion: 2,
    capabilities: ["list", "stableResourceId", "playbackLocator", "relay"],
    recommendedScanSettings: createFlymbyRecommendedScanSettings(),
    connectionFields: [
      { name: "accessToken", label: "Access Token", type: "password", required: true, secret: true },
    ],
  };

  private readonly networkOptions: ProviderNetworkOptions;

  public constructor(networkOptions: ProviderNetworkOptions) {
    this.networkOptions = networkOptions;
  }

  /** 读取根目录验证百度网盘 Access Token。 */
  public async validateConnection(connection: Record<string, unknown>, signal?: AbortSignal): Promise<ProviderValidationResult> {
    await this.listDirectory(connection, "/", 0, signal);
    return { valid: true, accountLabel: null, rootAccessible: true };
  }

  /** 验证每个百度网盘扫描根路径可以正常列目录。 */
  public async validateRoots(connection: Record<string, unknown>, roots: ScanRoot[], signal?: AbortSignal): Promise<void> {
    const selectedRoots = roots.length > 0 ? roots : [{ displayPath: "/" }];
    for (const root of selectedRoots) {
      await this.listDirectory(connection, root.displayPath || root.resourceId || "/", 0, signal);
    }
  }

  /** 返回百度网盘当前路径的直接子目录，供前端目录选择器使用。 */
  public async browseDirectories(
    connection: Record<string, unknown>,
    parent?: ScanRoot,
    signal?: AbortSignal,
  ): Promise<ProviderDirectoryListing> {
    const directory = parent?.displayPath || parent?.resourceId || "/";
    let start = 0;
    const items: ProviderDirectoryListing["items"] = [];
    while (true) {
      const page = await this.listDirectory(connection, directory, start, signal);
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
    for (const root of selectedRoots) {
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
            const page = await this.listDirectory(connection, directory, start, signal);
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
    }
  }

  /** 使用 fs_id 换取百度网盘 dlink；令牌只保留在中转上游地址中，不下发客户端。 */
  public async resolveFileStreamAccess(connection: Record<string, unknown>, locator: Record<string, unknown>, signal?: AbortSignal): Promise<ProviderFileStreamAccess> {
    const accessToken = requireConnectionString(connection, "accessToken", "Access Token");
    const fsId = requireConnectionString(locator, "fsId", "文件 ID");
    const apiBase = typeof connection.apiBaseUrl === "string" && connection.apiBaseUrl ? connection.apiBaseUrl : "https://pan.baidu.com";
    const baseUrl = await validateProviderUrl(apiBase, this.networkOptions);
    const url = new URL("/rest/2.0/xpan/multimedia", baseUrl);
    url.searchParams.set("method", "filemetas");
    url.searchParams.set("access_token", accessToken);
    url.searchParams.set("fsids", JSON.stringify([Number.isFinite(Number(fsId)) ? Number(fsId) : fsId]));
    url.searchParams.set("dlink", "1");
    const response = await providerFetch(url, { method: "GET" }, this.networkOptions, signal);
    const payload = await response.json() as { errno?: number; list?: Array<{ dlink?: string }> };
    if (payload.errno && payload.errno !== 0) throw new Error(`百度网盘下载接口错误 ${payload.errno}`);
    const dlink = payload.list?.[0]?.dlink;
    if (!dlink) throw new Error("百度网盘开放接口未返回下载地址");
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
  ): Promise<{ items: BaiduFileItem[]; hasMore: boolean }> {
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
    const response = await providerFetch(url, { method: "GET" }, this.networkOptions, signal);
    const payload = await response.json() as { errno?: number; list?: BaiduFileItem[]; has_more?: number };
    if (payload.errno && payload.errno !== 0) {
      throw new Error(`百度网盘接口错误 ${payload.errno}`);
    }
    return { items: Array.isArray(payload.list) ? payload.list : [], hasMore: payload.has_more === 1 };
  }
}
