import { providerFetch, validateProviderUrl, type ProviderNetworkOptions } from "./network.js";
import { validationError } from "../errors.js";
import {
  type ProviderAdapter,
  type ProviderConnectionContext,
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

const DEFAULT_ALIYUN_REFRESH_URL = "https://api.oplist.org/alicloud/renewapi";
const TOKEN_REFRESH_AHEAD_MS = 5 * 60 * 1000;
const ALIYUN_RESOURCE_DRIVE_NAME = "资源库";
const ALIYUN_BACKUP_DRIVE_NAME = "备份盘";
const ALIYUN_DIRECTORY_SCOPE_LOG_KEY = "codex-aliyundrive-directory-scope";

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
      { name: "refreshToken", label: "Refresh Token", type: "password", required: true, secret: true },
      { name: "refreshUrl", label: "Token 刷新地址", type: "url", required: false, secret: false },
    ],
  };

  private readonly networkOptions: ProviderNetworkOptions;
  private cachedDriveInfo: { accessToken: string; info: AliyunDriveInfo } | null = null;

  public constructor(networkOptions: ProviderNetworkOptions) {
    this.networkOptions = networkOptions;
  }

  /** 通过自动读取 Drive 信息和根目录首个分页验证 Token。 */
  public async validateConnection(
    connection: Record<string, unknown>,
    signal?: AbortSignal,
    context?: ProviderConnectionContext,
  ): Promise<ProviderValidationResult> {
    const driveId = await this.resolveDefaultDriveId(connection, signal, context?.persistConnection);
    await this.listDirectory(connection, driveId, "root", null, 1, signal, context?.persistConnection);
    return { valid: true, accountLabel: "阿里云盘", rootAccessible: true };
  }

  /** 验证每个阿里云盘扫描根的 Drive ID 和目录资源 ID。 */
  public async validateRoots(
    connection: Record<string, unknown>,
    roots: ScanRoot[],
    signal?: AbortSignal,
    context?: ProviderConnectionContext,
  ): Promise<void> {
    const defaultDriveId = await this.resolveDefaultDriveId(connection, signal, context?.persistConnection);
    const selectedRoots = roots.length > 0 ? roots : [{ resourceId: "root", driveId: defaultDriveId }];
    for (const root of selectedRoots) {
      await this.listDirectory(connection, root.driveId || defaultDriveId, root.resourceId || "root", null, 1,
        signal, context?.persistConnection);
    }
  }

  /** 返回阿里云盘当前目录的直接子目录，保留稳定的 Drive ID 与 file_id。 */
  public async browseDirectories(
    connection: Record<string, unknown>,
    parent?: ScanRoot,
    signal?: AbortSignal,
    context?: ProviderConnectionContext,
  ): Promise<ProviderDirectoryListing> {
    const driveInfo = await this.resolveDriveInfo(connection, signal, context?.persistConnection);
    // 关键变量：未携带资源 ID 和盘 ID 时表示 APP 正在浏览阿里云盘的虚拟总根目录。
    const isVirtualRoot = !parent?.resourceId && !parent?.driveId;
    if (isVirtualRoot) {
      return this.createVirtualDriveListing(driveInfo);
    }
    const driveId = parent?.driveId || driveInfo.defaultDriveId;
    const parentFileId = parent?.resourceId || "root";
    const parentPath = parent?.displayPath || "/";
    let marker: string | null = null;
    const items: ProviderDirectoryListing["items"] = [];
    do {
      const page = await this.listDirectory(connection, driveId, parentFileId, marker, 200, signal,
        context?.persistConnection);
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

  /** 构造与 APP 本地阿里云盘一致的资源库、备份盘虚拟根目录。 */
  private createVirtualDriveListing(driveInfo: AliyunDriveInfo): ProviderDirectoryListing {
    const items: ProviderDirectoryListing["items"] = [];
    if (driveInfo.resourceDriveId.length > 0) {
      items.push(this.createVirtualDriveDirectory(ALIYUN_RESOURCE_DRIVE_NAME, driveInfo.resourceDriveId));
    }
    if (driveInfo.backupDriveId.length > 0 && driveInfo.backupDriveId !== driveInfo.resourceDriveId) {
      items.push(this.createVirtualDriveDirectory(ALIYUN_BACKUP_DRIVE_NAME, driveInfo.backupDriveId));
    }
    console.info(`${ALIYUN_DIRECTORY_SCOPE_LOG_KEY} [阶段=浏览根目录] [结果=返回多盘入口] `
      + `[资源库=${driveInfo.resourceDriveId.length > 0 ? "可用" : "不可用"}] `
      + `[备份盘=${driveInfo.backupDriveId.length > 0 ? "可用" : "不可用"}] [入口数量=${items.length}]`);
    return {
      current: { name: "/", resourceId: "", displayPath: "/", driveId: "" },
      items,
    };
  }

  /** 构造单个阿里云盘虚拟盘入口，真实目录从该盘的 root 开始浏览。 */
  private createVirtualDriveDirectory(name: string, driveId: string): ProviderDirectoryListing["items"][number] {
    return {
      name,
      resourceId: "root",
      displayPath: `/${name}`,
      driveId,
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
    const defaultDriveId = await this.resolveDefaultDriveId(connection, signal, options?.persistConnection);
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
            const page = await this.listDirectory(connection, driveId, directory.id, marker, 200, signal,
              options?.persistConnection);
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
  public async resolveFileAccess(
    connection: Record<string, unknown>,
    locator: Record<string, unknown>,
    signal?: AbortSignal,
    context?: ProviderConnectionContext,
  ): Promise<ProviderFileAccess> {
    await this.ensureValidToken(connection, context?.persistConnection, signal);
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
  public async resolveFileStreamAccess(
    connection: Record<string, unknown>,
    locator: Record<string, unknown>,
    signal?: AbortSignal,
    context?: ProviderConnectionContext,
  ): Promise<ProviderFileAccess> {
    return this.resolveFileAccess(connection, locator, signal, context);
  }

  /** 请求阿里云盘开放接口文件分页。 */
  private async listDirectory(
    connection: Record<string, unknown>,
    driveId: string,
    parentFileId: string,
    marker: string | null,
    limit: number,
    signal?: AbortSignal,
    persistConnection?: (connection: Record<string, unknown>) => Promise<void>,
  ): Promise<{ items: AliyunFileItem[]; nextMarker: string | null }> {
    await this.ensureValidToken(connection, persistConnection, signal);
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

  /** 返回默认盘 ID，具体盘信息读取和缓存统一交给 resolveDriveInfo。 */
  private async resolveDefaultDriveId(
    connection: Record<string, unknown>,
    signal?: AbortSignal,
    persistConnection?: (connection: Record<string, unknown>) => Promise<void>,
  ): Promise<string> {
    const info = await this.resolveDriveInfo(connection, signal, persistConnection);
    return info.defaultDriveId;
  }

  /** 自动读取账号下的默认、资源库和备份盘 Drive ID，旧字段仅作为响应缺失时的兼容兜底。 */
  private async resolveDriveInfo(
    connection: Record<string, unknown>,
    signal?: AbortSignal,
    persistConnection?: (connection: Record<string, unknown>) => Promise<void>,
  ): Promise<AliyunDriveInfo> {
    await this.ensureValidToken(connection, persistConnection, signal);
    const legacyDriveId = typeof connection.driveId === "string" ? connection.driveId.trim() : "";
    const accessToken = requireConnectionString(connection, "accessToken", "Access Token");
    const cached = this.cachedDriveInfo;
    if (cached !== null && cached.accessToken === accessToken && cached.info.defaultDriveId.length > 0) {
      return cached.info;
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
    if (info.resourceDriveId.length === 0) {
      info.resourceDriveId = info.defaultDriveId;
    }
    this.cachedDriveInfo = { accessToken, info };
    return info;
  }

  /** 统一解析阿里云盘开放接口地址，未配置时使用官方固定地址。 */
  private resolveApiBaseUrl(connection: Record<string, unknown>): string {
    const configured = typeof connection.apiBaseUrl === "string" ? connection.apiBaseUrl.trim() : "";
    return configured || "https://openapi.alipan.com";
  }

  /** 临近过期时使用云端持有的 Refresh Token 刷新，并原位保存同一凭据修订。 */
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
      : DEFAULT_ALIYUN_REFRESH_URL;
    const refreshUrl = new URL(configuredRefreshUrl);
    if (refreshUrl.protocol !== "https:") throw validationError("refreshUrl", "阿里云盘 Token 刷新地址必须使用 HTTPS");
    refreshUrl.searchParams.set("refresh_ui", refreshToken);
    refreshUrl.searchParams.set("server_use", "true");
    refreshUrl.searchParams.set("driver_txt", "alicloud_qr");
    const safeRefreshUrl = await validateProviderUrl(refreshUrl.href, this.networkOptions);
    const response = await providerFetch(safeRefreshUrl, { method: "GET" }, this.networkOptions, signal);
    const payload = await response.json() as Record<string, unknown>;
    const nextAccessToken = typeof payload.access_token === "string" ? payload.access_token.trim()
      : typeof payload.accessToken === "string" ? payload.accessToken.trim() : "";
    if (!nextAccessToken) throw new Error("阿里云盘令牌刷新接口未返回 Access Token");
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
    this.cachedDriveInfo = null;
    await persistConnection?.(connection);
  }
}
