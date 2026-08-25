import { providerFetch, validateProviderUrl, type ProviderNetworkOptions } from "./network.js";
import { validationError } from "../errors.js";
import {
  type ProviderAdapter,
  type ProviderDescriptor,
  type ProviderDirectoryListing,
  type ProviderEntry,
  type ProviderEnumerationOptions,
  type ProviderEnumerationWarning,
  type ProviderValidationResult,
  type ProviderFileAccess,
  type ScanRoot,
  createFlymbyRecommendedScanSettings,
  requireConnectionString,
  toFileSize,
} from "./types.js";

interface AliyunFileItem {
  file_id?: string;
  parent_file_id?: string;
  name?: string;
  type?: string;
  size?: number;
  updated_at?: string;
  content_hash?: string;
}

interface AliyunDriveInfo {
  defaultDriveId: string;
  resourceDriveId: string;
  backupDriveId: string;
}

/** 阿里云盘开放接口 Provider，使用 APP 上送的开放平台访问令牌。 */
export class AliyunDriveProvider implements ProviderAdapter {
  public readonly descriptor: ProviderDescriptor = {
    type: "aliyundrive",
    displayName: "阿里云盘",
    adapterVersion: "1.0.0",
    credentialSchemaVersion: 2,
    capabilities: ["list", "stableResourceId", "playbackLocator", "directDownload", "relay"],
    recommendedScanSettings: createFlymbyRecommendedScanSettings(),
    connectionFields: [
      { name: "accessToken", label: "Access Token", type: "password", required: true, secret: true },
    ],
  };

  private readonly networkOptions: ProviderNetworkOptions;
  private cachedDriveInfo: { accessToken: string; info: AliyunDriveInfo } | null = null;

  public constructor(networkOptions: ProviderNetworkOptions) {
    this.networkOptions = networkOptions;
  }

  /** 通过自动读取 Drive 信息和根目录首个分页验证 Token。 */
  public async validateConnection(connection: Record<string, unknown>, signal?: AbortSignal): Promise<ProviderValidationResult> {
    const driveId = await this.resolveDefaultDriveId(connection, signal);
    await this.listDirectory(connection, driveId, "root", null, 1, signal);
    return { valid: true, accountLabel: "阿里云盘", rootAccessible: true };
  }

  /** 验证每个阿里云盘扫描根的 Drive ID 和目录资源 ID。 */
  public async validateRoots(connection: Record<string, unknown>, roots: ScanRoot[], signal?: AbortSignal): Promise<void> {
    const defaultDriveId = await this.resolveDefaultDriveId(connection, signal);
    const selectedRoots = roots.length > 0 ? roots : [{ resourceId: "root", driveId: defaultDriveId }];
    for (const root of selectedRoots) {
      await this.listDirectory(connection, root.driveId || defaultDriveId, root.resourceId || "root", null, 1, signal);
    }
  }

  /** 返回阿里云盘当前目录的直接子目录，保留稳定的 Drive ID 与 file_id。 */
  public async browseDirectories(
    connection: Record<string, unknown>,
    parent?: ScanRoot,
    signal?: AbortSignal,
  ): Promise<ProviderDirectoryListing> {
    const defaultDriveId = await this.resolveDefaultDriveId(connection, signal);
    const driveId = parent?.driveId || defaultDriveId;
    const parentFileId = parent?.resourceId || "root";
    const parentPath = parent?.displayPath || "/";
    let marker: string | null = null;
    const items: ProviderDirectoryListing["items"] = [];
    do {
      const page = await this.listDirectory(connection, driveId, parentFileId, marker, 200, signal);
      for (const item of page.items) {
        const resourceId = String(item.file_id ?? "");
        const name = String(item.name ?? resourceId);
        if (!resourceId || item.type !== "folder") continue;
        items.push({
          name,
          resourceId,
          displayPath: `${parentPath.replace(/\/$/u, "")}/${name}`,
          driveId,
        });
      }
      marker = page.nextMarker;
    } while (marker);
    items.sort((left, right) => left.name.localeCompare(right.name, "zh-CN", { numeric: true }));
    return {
      current: {
        name: parentFileId === "root" ? "/" : parentPath.replace(/\/$/u, "").split("/").pop() || "/",
        resourceId: parentFileId,
        displayPath: parentPath,
        driveId,
      },
      items,
    };
  }

  /** 按稳定 file_id 广度优先递归枚举文件。 */
  public async *enumerate(
    connection: Record<string, unknown>,
    roots: ScanRoot[],
    signal?: AbortSignal,
    _onWarning?: (warning: ProviderEnumerationWarning) => void,
    options?: ProviderEnumerationOptions,
  ): AsyncGenerator<ProviderEntry> {
    const defaultDriveId = await this.resolveDefaultDriveId(connection, signal);
    const selectedRoots = roots.length > 0 ? roots : [{ resourceId: "root", driveId: defaultDriveId }];
    for (const root of selectedRoots) {
      const driveId = root.driveId || defaultDriveId;
      const queue: Array<{ id: string; path: string }> = [{
        id: root.resourceId || "root",
        path: root.displayPath || "/",
      }];
      const visited = new Set<string>();
      const directoryConcurrency = Math.max(1, options?.directoryConcurrency ?? 1);
      while (queue.length > 0) {
        if (signal?.aborted) return;
        const directoryBatch = queue.splice(0, directoryConcurrency)
          .filter((directory) => !visited.has(`${driveId}:${directory.id}`));
        directoryBatch.forEach((directory) => visited.add(`${driveId}:${directory.id}`));
        const batchResults = await Promise.all(directoryBatch.map(async (directory) => {
          let marker: string | null = null;
          const entries: AliyunFileItem[] = [];
          do {
            const page = await this.listDirectory(connection, driveId, directory.id, marker, 200, signal);
            entries.push(...page.items);
            marker = page.nextMarker;
          } while (marker);
          return { directory, entries };
        }));
        for (const { directory, entries } of batchResults) {
          for (const item of entries) {
            const id = String(item.file_id ?? "");
            const name = String(item.name ?? id);
            if (!id) continue;
            const itemPath = `${directory.path.replace(/\/$/u, "")}/${name}`;
            const isDirectory = item.type === "folder";
            if (isDirectory) {
              queue.push({ id, path: itemPath });
            } else {
              yield {
                resourceId: id,
                parentResourceId: item.parent_file_id ?? directory.id,
                path: itemPath,
                name,
                isDirectory: false,
                size: toFileSize(item.size),
                modifiedAt: item.updated_at ?? null,
                etag: item.content_hash ?? null,
                locator: { providerType: "aliyundrive", driveId, fileId: id },
              };
            }
          }
        }
      }
    }
  }

  /** 使用开放平台 file_id 换取短期下载地址，可直接下发或作为中转上游。 */
  public async resolveFileAccess(connection: Record<string, unknown>, locator: Record<string, unknown>, signal?: AbortSignal): Promise<ProviderFileAccess> {
    const accessToken = requireConnectionString(connection, "accessToken", "Access Token");
    const driveId = requireConnectionString(locator, "driveId", "Drive ID");
    const fileId = requireConnectionString(locator, "fileId", "File ID");
    const apiBase = this.resolveApiBaseUrl(connection);
    const baseUrl = await validateProviderUrl(apiBase, this.networkOptions);
    const response = await providerFetch(new URL("/adrive/v1.0/openFile/getDownloadUrl", baseUrl), {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ drive_id: driveId, file_id: fileId }),
    }, this.networkOptions, signal);
    const payload = await response.json() as { url?: string; expiration?: string };
    if (!payload.url) throw new Error("阿里云盘开放接口未返回下载地址");
    return { url: payload.url, expiresAt: payload.expiration ?? null, headers: {} };
  }

  /** 阿里云盘短期地址不含额外请求凭据，可直接复用为中转上游。 */
  public async resolveFileStreamAccess(connection: Record<string, unknown>, locator: Record<string, unknown>, signal?: AbortSignal): Promise<ProviderFileAccess> {
    return this.resolveFileAccess(connection, locator, signal);
  }

  /** 请求阿里云盘开放接口文件分页。 */
  private async listDirectory(
    connection: Record<string, unknown>,
    driveId: string,
    parentFileId: string,
    marker: string | null,
    limit: number,
    signal?: AbortSignal,
  ): Promise<{ items: AliyunFileItem[]; nextMarker: string | null }> {
    const accessToken = requireConnectionString(connection, "accessToken", "Access Token");
    const apiBase = this.resolveApiBaseUrl(connection);
    const baseUrl = await validateProviderUrl(apiBase, this.networkOptions);
    const response = await providerFetch(new URL("/adrive/v1.0/openFile/list", baseUrl), {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ drive_id: driveId, parent_file_id: parentFileId, limit, marker: marker ?? "" }),
    }, this.networkOptions, signal);
    const payload = await response.json() as { items?: AliyunFileItem[]; next_marker?: string };
    return { items: Array.isArray(payload.items) ? payload.items : [], nextMarker: payload.next_marker || null };
  }

  /** 自动读取账号下的默认、资源库和备份盘 Drive ID，旧字段仅作为响应缺失时的兼容兜底。 */
  private async resolveDefaultDriveId(connection: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const legacyDriveId = typeof connection.driveId === "string" ? connection.driveId.trim() : "";
    const accessToken = requireConnectionString(connection, "accessToken", "Access Token");
    const cached = this.cachedDriveInfo;
    if (cached !== null && cached.accessToken === accessToken && cached.info.defaultDriveId.length > 0) {
      return cached.info.defaultDriveId;
    }
    const apiBase = this.resolveApiBaseUrl(connection);
    const baseUrl = await validateProviderUrl(apiBase, this.networkOptions);
    const response = await providerFetch(new URL("/adrive/v1.0/user/getDriveInfo", baseUrl), {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: "{}",
    }, this.networkOptions, signal);
    const payload = await response.json() as {
      default_drive_id?: string;
      resource_drive_id?: string;
      backup_drive_id?: string;
    };
    const info: AliyunDriveInfo = {
      defaultDriveId: `${payload.default_drive_id ?? payload.resource_drive_id ?? payload.backup_drive_id ?? ""}`.trim(),
      resourceDriveId: `${payload.resource_drive_id ?? ""}`.trim(),
      backupDriveId: `${payload.backup_drive_id ?? ""}`.trim(),
    };
    if (info.defaultDriveId.length === 0 && legacyDriveId.length === 0) {
      throw validationError("accessToken", "阿里云盘授权未返回 Drive ID");
    }
    if (info.defaultDriveId.length === 0) {
      info.defaultDriveId = legacyDriveId;
    }
    this.cachedDriveInfo = { accessToken, info };
    return info.defaultDriveId;
  }

  /** 统一解析阿里云盘开放接口地址，未配置时使用官方固定地址。 */
  private resolveApiBaseUrl(connection: Record<string, unknown>): string {
    const configured = typeof connection.apiBaseUrl === "string" ? connection.apiBaseUrl.trim() : "";
    return configured || "https://openapi.alipan.com";
  }
}
