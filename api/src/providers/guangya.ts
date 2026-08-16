import { providerFetch, validateProviderUrl, type ProviderNetworkOptions } from "./network.js";
import {
  type ProviderAdapter,
  type ProviderDescriptor,
  type ProviderDirectoryListing,
  type ProviderEntry,
  type ProviderEnumerationOptions,
  type ProviderEnumerationWarning,
  type ProviderValidationResult,
  type ScanRoot,
  createFlymbyRecommendedScanSettings,
  requireConnectionString,
  toFileSize,
} from "./types.js";

interface GuangyaItem {
  id?: string;
  parentId?: string;
  name?: string;
  path?: string;
  type?: "file" | "folder";
  size?: number;
  modifiedAt?: string;
  etag?: string;
}

/** 光鸭 Provider 通过用户部署的标准 JSON 网关接入，避免核心猜测私有接口。 */
export class GuangyaProvider implements ProviderAdapter {
  public readonly descriptor: ProviderDescriptor = {
    type: "guangya",
    displayName: "光鸭云盘",
    adapterVersion: "1.0.0-gateway",
    credentialSchemaVersion: 1,
    capabilities: ["list", "stableResourceId", "playbackLocator", "gatewayContract"],
    recommendedScanSettings: createFlymbyRecommendedScanSettings(),
    connectionFields: [
      { name: "baseUrl", label: "光鸭 Provider 网关", type: "url", required: true, secret: false },
      { name: "accessToken", label: "网关 Token", type: "password", required: true, secret: true },
    ],
  };

  private readonly networkOptions: ProviderNetworkOptions;

  public constructor(networkOptions: ProviderNetworkOptions) {
    this.networkOptions = networkOptions;
  }

  /** 调用标准网关健康接口验证连接。 */
  public async validateConnection(connection: Record<string, unknown>, signal?: AbortSignal): Promise<ProviderValidationResult> {
    const payload = await this.request(connection, "/api/v1/provider/info", {}, signal) as { accountLabel?: string };
    return { valid: true, accountLabel: payload.accountLabel ?? null, rootAccessible: true };
  }

  /** 验证每个光鸭网关扫描根可以正常读取首个目录分页。 */
  public async validateRoots(connection: Record<string, unknown>, roots: ScanRoot[], signal?: AbortSignal): Promise<void> {
    const selectedRoots = roots.length > 0 ? roots : [{ resourceId: "root" }];
    for (const root of selectedRoots) {
      await this.request(connection, "/api/v1/files", { parentId: root.resourceId || "root", cursor: "" }, signal);
    }
  }

  /** 返回光鸭网关当前目录的直接子目录，供前端目录选择器使用。 */
  public async browseDirectories(
    connection: Record<string, unknown>,
    parent?: ScanRoot,
    signal?: AbortSignal,
  ): Promise<ProviderDirectoryListing> {
    const parentId = parent?.resourceId || "root";
    const parentPath = parent?.displayPath || "/";
    let cursor = "";
    const items: ProviderDirectoryListing["items"] = [];
    do {
      const payload = await this.request(connection, "/api/v1/files", { parentId, cursor }, signal) as {
        items?: GuangyaItem[];
        nextCursor?: string;
      };
      for (const item of Array.isArray(payload.items) ? payload.items : []) {
        const resourceId = item.id || "";
        if (!resourceId || item.type !== "folder") continue;
        const name = item.name || resourceId;
        items.push({
          name,
          resourceId,
          displayPath: item.path || `${parentPath.replace(/\/$/u, "")}/${name}`,
        });
      }
      cursor = payload.nextCursor || "";
    } while (cursor);
    items.sort((left, right) => left.name.localeCompare(right.name, "zh-CN", { numeric: true }));
    return {
      current: {
        name: parentId === "root" ? "/" : parentPath.replace(/\/$/u, "").split("/").pop() || "/",
        resourceId: parentId,
        displayPath: parentPath,
      },
      items,
    };
  }

  /** 按标准网关分页协议递归枚举光鸭文件。 */
  public async *enumerate(
    connection: Record<string, unknown>,
    roots: ScanRoot[],
    signal?: AbortSignal,
    _onWarning?: (warning: ProviderEnumerationWarning) => void,
    options?: ProviderEnumerationOptions,
  ): AsyncGenerator<ProviderEntry> {
    const selectedRoots = roots.length > 0 ? roots : [{ resourceId: "root", displayPath: "/" }];
    for (const root of selectedRoots) {
      const queue: Array<{ id: string; path: string }> = [{ id: root.resourceId || "root", path: root.displayPath || "/" }];
      const directoryConcurrency = Math.max(1, options?.directoryConcurrency ?? 1);
      while (queue.length > 0) {
        if (signal?.aborted) return;
        const directoryBatch = queue.splice(0, directoryConcurrency);
        const batchResults = await Promise.all(directoryBatch.map(async (directory) => {
          let cursor = "";
          const entries: GuangyaItem[] = [];
          do {
            const payload = await this.request(connection, "/api/v1/files", { parentId: directory.id, cursor }, signal) as { items?: GuangyaItem[]; nextCursor?: string };
            entries.push(...(Array.isArray(payload.items) ? payload.items : []));
            cursor = payload.nextCursor || "";
          } while (cursor);
          return { directory, entries };
        }));
        for (const { directory, entries } of batchResults) {
          for (const item of entries) {
            const id = item.id || "";
            if (!id) continue;
            const name = item.name || id;
            const itemPath = item.path || `${directory.path.replace(/\/$/u, "")}/${name}`;
            if (item.type === "folder") {
              queue.push({ id, path: itemPath });
            } else {
              yield {
                resourceId: id,
                parentResourceId: item.parentId ?? directory.id,
                path: itemPath,
                name,
                isDirectory: false,
                size: toFileSize(item.size),
                modifiedAt: item.modifiedAt ?? null,
                etag: item.etag ?? null,
                locator: { providerType: "guangya", fileId: id },
              };
            }
          }
        }
      }
    }
  }

  /** 请求光鸭标准 Provider 网关。 */
  private async request(
    connection: Record<string, unknown>,
    pathname: string,
    query: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const baseUrl = await validateProviderUrl(
      requireConnectionString(connection, "baseUrl", "光鸭 Provider 网关"),
      this.networkOptions,
    );
    const token = requireConnectionString(connection, "accessToken", "网关 Token");
    const url = new URL(pathname, baseUrl);
    Object.entries(query).forEach(([key, value]) => url.searchParams.set(key, value));
    const response = await providerFetch(
      url,
      { method: "GET", headers: { Authorization: `Bearer ${token}` } },
      this.networkOptions,
      signal,
    );
    return response.json();
  }
}
