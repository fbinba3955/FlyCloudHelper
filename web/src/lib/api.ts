export type AuthRole = "user" | "super_admin";

export interface AuthUser {
  userId: string;
  username: string;
  role: AuthRole;
  status: "active" | "disabled" | "pending_delete";
  createdAt: string;
}

export interface CredentialKeyBackup {
  masterKey: string;
  fileName: string;
}

export interface InitializeSuperAdminResult {
  user: AuthUser;
  credentialKeyBackup: CredentialKeyBackup | null;
}

interface ApiErrorResponse {
  error?: {
    code?: string;
    message?: string;
  };
}

/** 表示 API 返回的可识别业务错误。 */
export class ApiClientError extends Error {
  public readonly status: number;
  public readonly code: string;

  public constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiClientError";
    this.status = status;
    this.code = code;
  }
}

/** 发起同源 API 请求并统一处理错误响应。 */
async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...init?.headers,
      },
    });
  } catch {
    throw new ApiClientError(0, "network_error", "无法连接 FlyCloudHelper API");
  }

  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as ApiErrorResponse;
    throw new ApiClientError(
      response.status,
      payload.error?.code ?? "request_failed",
      payload.error?.message ?? "请求失败",
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

export type MediaType = "video" | "music" | "audiobook";
export type CatalogSort = "created_desc" | "year_desc" | "premiere_date_desc" | "title_asc";
export type MatchState = "matched" | "needs_review" | "unmatched" | "processing";
export type ServiceStatus = "active" | "scanning" | "disabled" | "reauthorization_required";
export type JobStatus = "queued" | "running" | "retry_waiting" | "paused" | "completed" | "failed" | "cancelled";

export interface OverviewResult {
  serviceCount: number;
  mediaCount: number;
  activeJobCount: number;
  failedJobCount: number;
  needsReviewCount: number;
}

export interface WorkerStatus {
  enabled: boolean;
  running: boolean;
  activeWorkers: number;
  concurrency: number;
  availableSlots: number;
}

export interface AdminRuntimeStatus extends OverviewResult {
  service: string;
  serviceInstanceId: string;
  schemaVersion: number;
  userCount: number;
  worker: WorkerStatus;
  database: { type: "sqlite" | "postgres" | "mysql"; connected: boolean };
}

export interface AdminConfigStatus {
  database: { type: "sqlite" | "postgres" | "mysql"; schemaVersion: number };
  tmdb: {
    source: "system" | "missing";
    configurationRevision: number;
    configuredCount: number;
    healthyCount: number;
    coolingCount: number;
    disabledCount: number;
    effectiveConcurrency: number;
    revision: string;
  };
  music: {
    musicBrainz: { status: string };
    acoustId: { status: string; configured: boolean; reasonCode: string };
    fingerprint: { status: string; configured: boolean; reasonCode: string };
  };
  credentials: { configured: boolean; source: "file" | "environment" | "generated" };
  plugins: { directoryReady: boolean; installedCount: number; enabledCount: number };
  worker: WorkerStatus;
}

export interface CloudService {
  id: string;
  userId: string;
  ownerUsername: string;
  libraryId: string;
  displayName: string;
  providerType: string;
  dataType: MediaType;
  status: ServiceStatus;
  connectionStatus: string;
  credentialRevision: number;
  scanProfileRevision: number;
  metadataProfileRevision: number;
  catalogVersion: number;
  itemCount: number;
  lastScanAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 创建云端服务时由 Web 端提交的完整配置。 */
export interface CreateCloudServiceInput {
  displayName: string;
  dataType: MediaType;
  provider: {
    type: string;
    connection: Record<string, string>;
  };
  scan: Record<string, unknown>;
  metadata: Record<string, unknown>;
  userId?: string;
}

export interface ScanJob {
  id: string;
  userId: string;
  serviceId: string;
  libraryId: string;
  ownerUsername: string;
  serviceName: string;
  dataType: MediaType;
  scanMode: "incremental" | "full";
  status: JobStatus;
  stage: string;
  processedCount: number;
  totalCount: number | null;
  discoveredCount: number;
  skippedCount: number;
  matchedCount: number | null;
  unmatchedCount: number | null;
  errorCount: number;
  currentPath: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  nextRetryAt: string | null;
  retryCount: number;
  snapshot: Record<string, unknown>;
  checkpointUpdatedAt: string | null;
  resumeSupported: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

export interface ServiceDetail extends CloudService {
  scanProfile: Record<string, unknown>;
  metadataProfile: Record<string, unknown>;
  credentialConfigured: boolean;
  bindings: Array<{
    bindingId: string;
    clientDeviceId: string;
    clientServiceId: string;
    providerType: string;
    updatedAt: string;
  }>;
  recentJobs: ScanJob[];
}

export interface MediaItem {
  id: string;
  userId: string;
  serviceId: string;
  libraryId: string;
  mediaType: MediaType;
  itemType: string;
  title: string;
  sortTitle: string;
  subtitle: string;
  year: number | null;
  premiereDate: string | null;
  overview: string;
  posterUrl: string | null;
  backdropUrl: string | null;
  matchState: MatchState;
  externalIds: Record<string, string>;
  metadata: Record<string, unknown>;
  fileCount: number;
  ownerUsername: string;
  serviceName: string;
  createdAt: string;
  updatedAt: string;
}

export interface MediaPathItem {
  fileId: string;
  resourceId: string;
  linkedItemId: string;
  linkedItemTitle: string;
  path: string;
  name: string;
  size: number;
  modifiedAt: string | null;
}

export type ManualVideoMatchType = "movie" | "tv";

export interface ManualVideoMatchCandidate {
  id: number;
  mediaType: ManualVideoMatchType;
  title: string;
  originalTitle: string;
  overview: string;
  year: number | null;
  releaseDate: string;
  posterUrl: string | null;
  backdropUrl: string | null;
  rating: number;
  popularity: number;
}

export interface ProviderDescriptor {
  type: string;
  displayName: string;
  adapterVersion: string;
  credentialSchemaVersion: number;
  capabilities: string[];
  recommendedScanSettings: {
    scanDirectoryConcurrency: { default: number; min: number; max: number };
    scrapeTaskConcurrency: { default: number; min: number; max: number };
    fullScanDirectoryConcurrency: number;
  };
  connectionFields: Array<{
    name: string;
    label: string;
    type: "text" | "password" | "url";
    required: boolean;
    secret: boolean;
  }>;
}

/** 路径选择器显示并保存的网盘目录。 */
export interface ProviderDirectory {
  name: string;
  resourceId: string;
  displayPath: string;
  driveId?: string;
}

export interface ProviderDirectoryListing {
  current: ProviderDirectory;
  items: ProviderDirectory[];
}

export interface AdminUser extends AuthUser {
  serviceCount: number;
  mediaCount: number;
  lastLoginAt?: string | null;
}

export interface PluginVersion {
  pluginId: string;
  version: string;
  displayName: string;
  status: "imported" | "enabled" | "disabled";
  sha256: string;
  manifest: Record<string, unknown>;
  configurationRevision: number;
  configurationState: Record<string, boolean>;
  createdAt: string;
  updatedAt: string;
}

export interface AuditEntry {
  id: string;
  operatorUsername: string | null;
  operationType: string;
  targetType: string;
  targetId: string | null;
  result: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

/** 为分页和筛选接口构造查询字符串。 */
function withQuery(path: string, values: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  Object.entries(values).forEach(([name, value]) => {
    if (value !== undefined && value !== "") query.set(name, String(value));
  });
  const serialized = query.toString();
  return serialized ? `${path}?${serialized}` : path;
}

/** 读取当前用户概览。 */
export function getOverview(): Promise<OverviewResult> {
  return requestJson("/api/v1/overview");
}

/** 读取用户或管理端服务列表。 */
export function listServices(admin = false): Promise<{ items: CloudService[]; total: number }> {
  return requestJson(admin ? "/api/v1/admin/services?limit=200" : "/api/v1/services?limit=200");
}

/** 读取用户或管理端服务详情。 */
export async function getService(serviceId: string, admin = false): Promise<ServiceDetail> {
  const result = await requestJson<{ service: ServiceDetail }>(
    admin ? `/api/v1/admin/services/${serviceId}` : `/api/v1/services/${serviceId}`,
  );
  return result.service;
}

/** 读取单个服务中某个目录的直接子目录。 */
export function browseServiceDirectories(
  serviceId: string,
  parent?: Pick<ProviderDirectory, "resourceId" | "displayPath" | "driveId">,
  admin = false,
): Promise<ProviderDirectoryListing> {
  const path = admin
    ? `/api/v1/admin/services/${serviceId}/directories`
    : `/api/v1/services/${serviceId}/directories`;
  return requestJson(withQuery(path, {
    resourceId: parent?.resourceId,
    displayPath: parent?.displayPath,
    driveId: parent?.driveId,
  }));
}

/** 读取可配置的 Provider 描述。 */
export async function listProviders(): Promise<ProviderDescriptor[]> {
  return (await requestJson<{ items: ProviderDescriptor[] }>("/api/v1/providers")).items;
}

/** 创建用户或管理员代建的云端服务。 */
export async function createService(
  input: CreateCloudServiceInput,
  admin = false,
): Promise<ServiceDetail> {
  const result = await requestJson<{ service: ServiceDetail }>(admin ? "/api/v1/admin/services" : "/api/v1/services", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return result.service;
}

/** 创建扫描任务；Web 控制台使用稳定设备标识和随机请求 ID。 */
export async function createScanJob(serviceId: string, scanMode: "incremental" | "full", admin = false): Promise<ScanJob> {
  const result = await requestJson<{ job: ScanJob }>(
    admin ? `/api/v1/admin/services/${serviceId}/scan-jobs` : `/api/v1/services/${serviceId}/scan-jobs`,
    {
      method: "POST",
      body: JSON.stringify({
        scanMode,
        requestId: crypto.randomUUID(),
        clientDeviceId: "flycloud-helper-web",
      }),
    },
  );
  return result.job;
}

/** 为失败或已取消任务创建一条保留原扫描模式的新任务。 */
export async function retryScanJob(jobId: string, admin = false): Promise<ScanJob> {
  const result = await requestJson<{ job: ScanJob }>(
    admin ? `/api/v1/admin/jobs/${jobId}/retry` : `/api/v1/scan-jobs/${jobId}/retry`,
    {
      method: "POST",
      body: JSON.stringify({
        requestId: crypto.randomUUID(),
        clientDeviceId: "flycloud-helper-web",
      }),
    },
  );
  return result.job;
}

/** 请求终止排队中、运行中或已暂停的扫描任务。 */
export async function cancelScanJob(jobId: string, admin = false): Promise<ScanJob> {
  const result = await requestJson<{ job: ScanJob }>(
    admin ? `/api/v1/admin/jobs/${jobId}/cancel` : `/api/v1/scan-jobs/${jobId}/cancel`,
    { method: "POST", body: JSON.stringify({}) },
  );
  return result.job;
}

/** 请求在安全检查点暂停排队中或运行中的扫描任务。 */
export async function pauseScanJob(jobId: string, admin = false): Promise<ScanJob> {
  const result = await requestJson<{ job: ScanJob }>(
    admin ? `/api/v1/admin/jobs/${jobId}/pause` : `/api/v1/scan-jobs/${jobId}/pause`,
    { method: "POST", body: JSON.stringify({}) },
  );
  return result.job;
}

/** 继续已暂停任务；服务端复用原扫描会话和目录检查点。 */
export async function resumeScanJob(jobId: string, admin = false): Promise<ScanJob> {
  const result = await requestJson<{ job: ScanJob }>(
    admin ? `/api/v1/admin/jobs/${jobId}/resume` : `/api/v1/scan-jobs/${jobId}/resume`,
    { method: "POST", body: JSON.stringify({}) },
  );
  return result.job;
}

/** 删除已经结束的扫描任务记录。 */
export async function deleteScanJob(jobId: string, admin = false): Promise<void> {
  return requestJson(admin ? `/api/v1/admin/jobs/${jobId}` : `/api/v1/scan-jobs/${jobId}`, {
    method: "DELETE",
    body: JSON.stringify({ confirmation: jobId }),
  });
}

/** 清空单个服务的扫描与刮削结果，保留服务连接和配置。 */
export function clearServiceCatalog(
  serviceId: string,
  admin = false,
): Promise<{ mediaItemCount: number; sourceFileCount: number }> {
  return requestJson(admin ? `/api/v1/admin/services/${serviceId}/catalog` : `/api/v1/services/${serviceId}/catalog`, {
    method: "DELETE",
    body: JSON.stringify({ confirmation: serviceId }),
  });
}

/** 用完整新凭据替换服务连接；Secret 不从服务端回显。 */
export async function updateServiceConnection(
  serviceId: string,
  connection: Record<string, string>,
  admin = false,
): Promise<ServiceDetail> {
  const result = await requestJson<{ service: ServiceDetail }>(
    admin ? `/api/v1/admin/services/${serviceId}/connection` : `/api/v1/services/${serviceId}/connection`,
    { method: "PUT", body: JSON.stringify({ connection }) },
  );
  return result.service;
}

/** 使用服务端当前保存的连接配置重新验证并恢复连接状态。 */
export async function reconnectServiceConnection(
  serviceId: string,
  admin = false,
): Promise<ServiceDetail> {
  const result = await requestJson<{ service: ServiceDetail }>(
    admin
      ? `/api/v1/admin/services/${serviceId}/connection/reconnect`
      : `/api/v1/services/${serviceId}/connection/reconnect`,
    { method: "POST", body: JSON.stringify({}) },
  );
  return result.service;
}

/** 保存新的扫描配置修订。 */
export async function updateServiceScanProfile(
  serviceId: string,
  scan: Record<string, unknown>,
  admin = false,
): Promise<ServiceDetail> {
  const result = await requestJson<{ service: ServiceDetail }>(
    admin ? `/api/v1/admin/services/${serviceId}/scan-profile` : `/api/v1/services/${serviceId}/scan-profile`,
    { method: "PUT", body: JSON.stringify({ scan }) },
  );
  return result.service;
}

/** 保存新的元数据配置修订。 */
export async function updateServiceMetadataProfile(
  serviceId: string,
  metadata: Record<string, unknown>,
  admin = false,
): Promise<ServiceDetail> {
  const result = await requestJson<{ service: ServiceDetail }>(
    admin ? `/api/v1/admin/services/${serviceId}/metadata-profile` : `/api/v1/services/${serviceId}/metadata-profile`,
    { method: "PUT", body: JSON.stringify({ metadata }) },
  );
  return result.service;
}

/** 启用或停用云端服务。 */
export async function updateServiceStatus(
  serviceId: string,
  status: "active" | "disabled",
  admin = false,
): Promise<ServiceDetail> {
  const result = await requestJson<{ service: ServiceDetail }>(
    admin ? `/api/v1/admin/services/${serviceId}/status` : `/api/v1/services/${serviceId}/status`,
    { method: "PATCH", body: JSON.stringify({ status }) },
  );
  return result.service;
}

/** 读取用户或管理员作用域扫描任务。 */
export function listJobs(admin = false): Promise<{ items: ScanJob[]; total: number }> {
  return requestJson(admin ? "/api/v1/admin/jobs?limit=200" : "/api/v1/scan-jobs?limit=200");
}

/** 读取单个媒体库的海报墙条目。 */
export function listLibraryItems(
  libraryId: string,
  options: {
    search?: string;
    mediaType?: MediaType;
    itemType?: string;
    matchState?: MatchState;
    sort?: CatalogSort;
    limit?: number;
    offset?: number;
  } = {},
): Promise<{ items: MediaItem[]; total: number; catalogVersion: number }> {
  return requestJson(withQuery(`/api/v1/libraries/${libraryId}/items`, {
    search: options.search,
    mediaType: options.mediaType,
    itemType: options.itemType,
    matchState: options.matchState,
    sort: options.sort,
    limit: options.limit ?? 200,
    offset: options.offset ?? 0,
  }));
}

/** 读取管理端指定服务的海报墙条目。 */
export function listAdminServiceItems(
  serviceId: string,
  options: {
    search?: string;
    mediaType?: MediaType;
    itemType?: string;
    matchState?: MatchState;
    sort?: CatalogSort;
    limit?: number;
    offset?: number;
  } = {},
): Promise<{ items: MediaItem[]; total: number }> {
  return requestJson(withQuery("/api/v1/admin/catalog/items", {
    serviceId,
    search: options.search,
    mediaType: options.mediaType,
    itemType: options.itemType,
    matchState: options.matchState,
    sort: options.sort,
    limit: options.limit ?? 200,
    offset: options.offset ?? 0,
  }));
}

/** 读取普通用户或管理员作用域的单个媒体详情。 */
export async function getMediaItem(item: Pick<MediaItem, "id" | "libraryId">, admin = false): Promise<MediaItem> {
  const path = admin
    ? `/api/v1/admin/catalog/items/${item.id}`
    : `/api/v1/libraries/${item.libraryId}/items/${item.id}`;
  return (await requestJson<{ item: MediaItem }>(path)).item;
}

/** 读取节目、专辑或有声书作品下的子项，不返回播放定位。 */
export async function listMediaItemChildren(
  item: Pick<MediaItem, "id" | "libraryId">,
  admin = false,
): Promise<MediaItem[]> {
  const path = admin
    ? `/api/v1/admin/catalog/items/${item.id}/children`
    : `/api/v1/libraries/${item.libraryId}/items/${item.id}/children`;
  return (await requestJson<{ items: MediaItem[] }>(path)).items;
}

/** 构造普通用户或管理员作用域下的媒体条目 API 根路径。 */
function getMediaItemApiPath(item: Pick<MediaItem, "id" | "libraryId">, admin: boolean): string {
  return admin
    ? `/api/v1/admin/catalog/items/${item.id}`
    : `/api/v1/libraries/${item.libraryId}/items/${item.id}`;
}

/** 读取媒体条目及其子项关联的只读网盘路径，不读取播放定位。 */
export async function listMediaItemPaths(
  item: Pick<MediaItem, "id" | "libraryId">,
  admin = false,
): Promise<MediaPathItem[]> {
  return (await requestJson<{ items: MediaPathItem[] }>(`${getMediaItemApiPath(item, admin)}/paths`)).items;
}

/** 使用系统 TMDB 配置搜索电影或节目候选。 */
export async function searchManualVideoMatches(
  item: Pick<MediaItem, "id" | "libraryId">,
  input: { query: string; mediaType: ManualVideoMatchType; year?: number | null },
  admin = false,
): Promise<ManualVideoMatchCandidate[]> {
  const path = withQuery(`${getMediaItemApiPath(item, admin)}/manual-match/search`, {
    query: input.query,
    mediaType: input.mediaType,
    year: input.year ?? undefined,
  });
  return (await requestJson<{ items: ManualVideoMatchCandidate[] }>(path)).items;
}

/** 提交用户选中的 TMDB 条目并返回更新后的媒体详情。 */
export async function applyManualVideoMatch(
  item: Pick<MediaItem, "id" | "libraryId">,
  input: { mediaType: ManualVideoMatchType; tmdbId: number },
  admin = false,
): Promise<MediaItem> {
  return (await requestJson<{ item: MediaItem }>(`${getMediaItemApiPath(item, admin)}/manual-match`, {
    method: "POST",
    body: JSON.stringify(input),
  })).item;
}

/** 清除当前媒体条目的外部匹配结果。 */
export async function clearMediaItemMatch(
  item: Pick<MediaItem, "id" | "libraryId">,
  admin = false,
): Promise<MediaItem> {
  return (await requestJson<{ item: MediaItem }>(`${getMediaItemApiPath(item, admin)}/manual-match/clear`, {
    method: "POST",
    body: "{}",
  })).item;
}

/** 读取管理后台用户列表。 */
export async function listAdminUsers(): Promise<{ items: AdminUser[]; total: number }> {
  const result = await requestJson<{
    items: Array<Omit<AdminUser, "userId"> & { id: string }>;
    total: number;
  }>("/api/v1/admin/users?limit=200");
  return {
    total: result.total,
    items: result.items.map(({ id, ...user }) => ({ ...user, userId: id })),
  };
}

/** 创建一个普通用户。 */
export async function createAdminUser(input: { username: string; password: string; passwordConfirmation: string }): Promise<AuthUser> {
  return (await requestJson<{ user: AuthUser }>("/api/v1/admin/users", {
    method: "POST",
    body: JSON.stringify(input),
  })).user;
}

/** 启用或停用指定用户。 */
export async function updateAdminUserStatus(userId: string, status: "active" | "disabled"): Promise<AuthUser> {
  return (await requestJson<{ user: AuthUser }>(`/api/v1/admin/users/${userId}/status`, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  })).user;
}

/** 撤销指定用户的全部 Web 和 APP 会话。 */
export async function revokeAdminUserSessions(userId: string): Promise<void> {
  await requestJson<void>(`/api/v1/admin/users/${userId}/sessions/revoke`, { method: "POST", body: "{}" });
}

/** 读取管理后台运行摘要。 */
export function getAdminStatus(): Promise<AdminRuntimeStatus> {
  return requestJson("/api/v1/admin/status");
}

/** 读取管理后台脱敏配置状态。 */
export function getAdminConfigStatus(): Promise<AdminConfigStatus> {
  return requestJson("/api/v1/admin/config/status");
}

/** 用系统配置中的完整新列表替换 TMDB Key 池，Key 原文不会回显。 */
export async function updateAdminTmdbKeys(keys: string[]): Promise<AdminConfigStatus["tmdb"]> {
  const result = await requestJson<{ tmdb: AdminConfigStatus["tmdb"] }>("/api/v1/admin/config/tmdb-keys", {
    method: "PUT",
    body: JSON.stringify({ keys }),
  });
  return result.tmdb;
}

/** 读取已安装的声明式插件版本。 */
export function listPlugins(): Promise<{ items: PluginVersion[]; total: number }> {
  return requestJson("/api/v1/admin/plugins?limit=200");
}

/** 导入声明式插件包。 */
export async function importPlugin(file: File): Promise<PluginVersion> {
  const form = new FormData();
  form.set("file", file);
  const response = await fetch("/api/v1/admin/plugins/import", { method: "POST", body: form, credentials: "include" });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as ApiErrorResponse;
    throw new ApiClientError(response.status, payload.error?.code ?? "request_failed", payload.error?.message ?? "插件导入失败");
  }
  return (await response.json() as { plugin: PluginVersion }).plugin;
}

/** 启用或停用一个插件版本。 */
export async function updatePluginStatus(plugin: PluginVersion, enabled: boolean): Promise<PluginVersion> {
  const result = await requestJson<{ plugin: PluginVersion }>(
    `/api/v1/admin/plugins/${encodeURIComponent(plugin.pluginId)}/versions/${encodeURIComponent(plugin.version)}/${enabled ? "enable" : "disable"}`,
    { method: "POST", body: "{}" },
  );
  return result.plugin;
}

/** 读取脱敏审计记录。 */
export function listAuditEntries(): Promise<{ items: AuditEntry[]; total: number }> {
  return requestJson("/api/v1/admin/audit-logs?limit=200");
}

/** 查询实例首次初始化状态。 */
export async function getSetupStatus(): Promise<{
  setupRequired: boolean;
  credentialKeyBackupRequired: boolean;
}> {
  return requestJson("/api/v1/setup/status");
}

/** 原子创建首个超级管理员并建立 Web 会话。 */
export async function initializeSuperAdmin(input: {
  username: string;
  password: string;
  passwordConfirmation: string;
}): Promise<InitializeSuperAdminResult> {
  return requestJson<InitializeSuperAdminResult>("/api/v1/setup/super-admin", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** 读取尚未确认备份的自动生成凭据主密钥。 */
export async function getCredentialKeyBackup(): Promise<CredentialKeyBackup> {
  return requestJson("/api/v1/setup/credential-key-backup");
}

/** 确认管理员已经把凭据主密钥保存到数据库之外。 */
export async function acknowledgeCredentialKeyBackup(): Promise<void> {
  await requestJson<void>("/api/v1/setup/credential-key-backup/acknowledge", {
    method: "POST",
    body: JSON.stringify({ confirmed: true }),
  });
}

/** 使用用户名和密码登录。 */
export async function login(input: { username: string; password: string }): Promise<AuthUser> {
  const result = await requestJson<{ user: AuthUser }>("/api/v1/auth/login", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return result.user;
}

/** 公开注册普通用户并建立 Web 会话。 */
export async function register(input: {
  username: string;
  password: string;
  passwordConfirmation: string;
}): Promise<AuthUser> {
  const result = await requestJson<{ user: AuthUser }>("/api/v1/auth/register", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return result.user;
}

/** 查询当前 Web 会话用户。 */
export async function getCurrentUser(): Promise<AuthUser> {
  const result = await requestJson<{ user: AuthUser }>("/api/v1/auth/me");
  return result.user;
}

/** 撤销当前 Web 会话。 */
export async function logout(): Promise<void> {
  await requestJson<void>("/api/v1/auth/logout", { method: "POST" });
}
