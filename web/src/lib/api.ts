export type AuthRole = "user" | "super_admin";

export interface AuthUser {
  userId: string;
  username: string;
  role: AuthRole;
  status: "active" | "disabled" | "pending_delete";
  createdAt: string;
}

export type ConsoleNotificationTone = "info" | "success" | "warning" | "danger";

/** 控制台右上角展示的账号通知。 */
export interface ConsoleNotification {
  id: string;
  userId: string;
  category: "task" | "security" | "system";
  tone: ConsoleNotificationTone;
  title: string;
  message: string;
  actionPath: string | null;
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

/**
 * 生成扫描请求的幂等标识。
 * 普通 HTTP 页面不一定开放 crypto.randomUUID，因此回退到 Web Crypto 随机字节生成标准 UUID v4。
 */
function createRequestId(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }

  if (typeof cryptoApi?.getRandomValues === "function") {
    // UUID 使用的 16 字节随机数据。
    const randomBytes = new Uint8Array(16);
    cryptoApi.getRandomValues(randomBytes);
    randomBytes[6] = (randomBytes[6]! & 0x0f) | 0x40;
    randomBytes[8] = (randomBytes[8]! & 0x3f) | 0x80;

    // 每个字节固定输出两个十六进制字符。
    const hexadecimalBytes = Array.from(randomBytes, (byte) => byte.toString(16).padStart(2, "0"));
    console.info("codex-flycloudhelper-request-id 生成方式=WebCrypto随机字节 原因=randomUUID不可用");
    return `${hexadecimalBytes.slice(0, 4).join("")}-${hexadecimalBytes.slice(4, 6).join("")}`
      + `-${hexadecimalBytes.slice(6, 8).join("")}-${hexadecimalBytes.slice(8, 10).join("")}`
      + `-${hexadecimalBytes.slice(10, 16).join("")}`;
  }

  // 请求 ID 仅用于避免任务重复创建，不作为认证或加密凭据。
  const timePart = Date.now().toString(36);
  const randomPart = Math.random().toString(36).slice(2);
  console.warn("codex-flycloudhelper-request-id 生成方式=兼容随机值 原因=WebCrypto不可用");
  return `flycloud-helper-web-${timePart}-${randomPart}`;
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
export type LibrarySnapshotStatus = "queued" | "running" | "completed" | "failed";

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
  publicAccess: {
    publicBaseUrl: string | null;
    source: "environment" | "database" | "missing";
    editable: boolean;
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
  /** 光鸭服务的登录类型；列表接口不返回任何授权凭据。 */
  connectionAuthMode?: "official_api" | "web_qr" | "web_sms" | null;
  relayPlaybackEnabled: boolean;
  jellyfinEnabled: boolean;
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

export interface ServiceAccessSettings {
  jellyfinEnabled: boolean;
  jellyfinUrl: string | null;
  jellyfinPath: string;
  /** 固定 /j/ 前缀之后的单层可编辑地址后缀。 */
  jellyfinPathSuffix: string;
  account: {
    id: string;
    serviceId: string;
    username: string;
    hasPassword: boolean;
    credentialRevision: number;
    status: "active" | "disabled";
    createdAt: string;
    updatedAt: string;
  };
}

export interface CreateCloudServiceResult {
  service: ServiceDetail;
  serviceAccessCredentials: { username: string; password: string };
}

export interface ScanJob {
  id: string;
  /** 后台任务类型；scan 为扫描刮削，media_probe 为视频规格分析。 */
  jobType: "scan" | "media_probe";
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
  controlAction: "none" | "pause" | "cancel";
  snapshot: Record<string, unknown>;
  checkpointUpdatedAt: string | null;
  resumeSupported: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  elapsedMs: number;
  updatedAt: string;
}

/** 视频规格后台任务详情中的失败文件。 */
export interface MediaProbeFailure {
  sourceFileId: string;
  fileName: string;
  errorCode: string;
  errorMessage: string;
}

/** 网页服务详情展示的云端媒体库快照任务。 */
export interface LibrarySnapshotExport {
  id: string;
  userId: string;
  libraryId: string;
  exportType: "snapshot";
  status: LibrarySnapshotStatus;
  stage: string;
  progressPercent: number;
  processedCount: number;
  totalCount: number;
  catalogVersion: number;
  formatVersion: number;
  fileSize: number | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface ServiceDetail extends CloudService {
  /** 光鸭服务当前使用的登录类型；其他 Provider 为 null。 */
  connectionAuthMode: "official_api" | "web_qr" | "web_sms" | null;
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
  /** 当前条目及其剧集已完成的 ffprobe 规格汇总。 */
  mediaProbeSummary: MediaProbeSummary | null;
  ownerUsername: string;
  serviceName: string;
  createdAt: string;
  updatedAt: string;
}

/** 海报卡片和媒体详情使用的视频规格汇总。 */
export interface MediaProbeSummary {
  analyzedFileCount: number;
  durationMs: number;
  container: string;
  bitRate: number;
  videoCodec: string;
  width: number;
  height: number;
  videoRange: string;
  videoRangeType: string;
  audioCodec: string;
  audioChannels: number;
  audioChannelLayout: string;
  audioStreamCount: number;
  subtitleStreamCount: number;
}

/** 单个源文件已经完成的 ffprobe 结果。 */
export interface MediaProbeResult {
  probeVersion: number;
  container: string;
  runTimeTicks: number;
  bitRate: number;
  size: number;
  mediaStreams: Array<Record<string, unknown>>;
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
  /** 当前源文件已经完成的 ffprobe 结果；未分析时为空。 */
  mediaProbe: MediaProbeResult | null;
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
  authenticationMode?: "form" | "web_qr";
  connectionFields: Array<{
    name: string;
    label: string;
    type: "text" | "password" | "url";
    required: boolean;
    secret: boolean;
  }>;
}

/** 光鸭网页登录状态；手机号、验证码和 Token 始终不会由接口回显。 */
export interface GuangyaAuthorizationStatus {
  authorizationSessionId: string;
  authMethod: "qr" | "sms";
  status: "pending" | "authorized" | "expired" | "failed";
  verificationUri: string;
  verificationUriComplete: string;
  userCode: string;
  expiresAt: string;
  intervalSeconds: number;
  accountLabel: string | null;
  maskedPhone: string | null;
  errorMessage: string | null;
}

/** 启动短信登录后的服务端结果；光鸭要求交互时先打开官方人机验证页面。 */
export interface GuangyaSmsAuthorizationStartResult {
  authorization: GuangyaAuthorizationStatus | null;
  captcha: {
    captchaSessionId: string;
    verificationUri: string;
    expiresAt: string;
  } | null;
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

/** 读取当前服务最近的云端快照任务，管理员接口自动使用服务所属用户。 */
export async function listServiceSnapshots(
  serviceId: string,
  libraryId: string,
  admin = false,
): Promise<LibrarySnapshotExport[]> {
  const path = admin
    ? `/api/v1/admin/services/${serviceId}/exports?limit=20`
    : `/api/v1/libraries/${libraryId}/exports?limit=20`;
  return (await requestJson<{ exports: LibrarySnapshotExport[] }>(path)).exports;
}

/** 从用户端或管理端网页创建当前服务的云端快照后台任务。 */
export async function createServiceSnapshot(
  serviceId: string,
  libraryId: string,
  admin = false,
): Promise<LibrarySnapshotExport> {
  const path = admin
    ? `/api/v1/admin/services/${serviceId}/exports`
    : `/api/v1/libraries/${libraryId}/exports`;
  return (await requestJson<{ export: LibrarySnapshotExport }>(path, {
    method: "POST",
    body: JSON.stringify({ exportType: "snapshot" }),
  })).export;
}

/** 二次确认后删除已完成或失败的云端快照。 */
export async function deleteLibrarySnapshot(exportId: string, admin = false): Promise<void> {
  await requestJson<void>(admin ? `/api/v1/admin/exports/${exportId}` : `/api/v1/exports/${exportId}`, {
    method: "DELETE",
    body: JSON.stringify({ confirmation: exportId }),
  });
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

/** 启动光鸭网页二维码登录；管理员需要同时绑定目标用户。 */
export function startGuangyaAuthorization(
  admin = false,
  userId?: string,
): Promise<GuangyaAuthorizationStatus> {
  return requestJson(
    admin
      ? "/api/v1/admin/providers/guangya/auth-sessions"
      : "/api/v1/providers/guangya/auth-sessions",
    {
      method: "POST",
      body: JSON.stringify(admin ? { userId } : {}),
    },
  );
}

/** 发送光鸭网页验证码；服务端只返回脱敏手机号和短期会话 ID。 */
export function startGuangyaSmsAuthorization(
  phoneNumber: string,
  captchaRedirectUri: string,
  admin = false,
  userId?: string,
): Promise<GuangyaSmsAuthorizationStartResult> {
  return requestJson(
    admin
      ? "/api/v1/admin/providers/guangya/sms-auth-sessions"
      : "/api/v1/providers/guangya/sms-auth-sessions",
    {
      method: "POST",
      body: JSON.stringify(admin
        ? { userId, phoneNumber, captchaRedirectUri }
        : { phoneNumber, captchaRedirectUri }),
    },
  );
}

/** 提交光鸭官方人机验证回调 Token，并真正发送短信验证码。 */
export function completeGuangyaSmsCaptcha(
  captchaSessionId: string,
  captchaToken: string,
  admin = false,
): Promise<GuangyaAuthorizationStatus> {
  return requestJson(
    admin
      ? `/api/v1/admin/providers/guangya/sms-auth-sessions/${captchaSessionId}/captcha`
      : `/api/v1/providers/guangya/sms-auth-sessions/${captchaSessionId}/captcha`,
    {
      method: "POST",
      body: JSON.stringify({ captchaToken }),
    },
  );
}

/** 提交光鸭网页短信验证码并换取仅服务端可见的连接。 */
export function verifyGuangyaSmsAuthorization(
  authorizationSessionId: string,
  verificationCode: string,
  admin = false,
): Promise<GuangyaAuthorizationStatus> {
  return requestJson(
    admin
      ? `/api/v1/admin/providers/guangya/sms-auth-sessions/${authorizationSessionId}/verify`
      : `/api/v1/providers/guangya/sms-auth-sessions/${authorizationSessionId}/verify`,
    {
      method: "POST",
      body: JSON.stringify({ verificationCode }),
    },
  );
}

/** 读取由服务端轮询光鸭官网推进的授权状态。 */
export function pollGuangyaAuthorization(
  authorizationSessionId: string,
  admin = false,
): Promise<GuangyaAuthorizationStatus> {
  return requestJson(
    admin
      ? `/api/v1/admin/providers/guangya/auth-sessions/${authorizationSessionId}`
      : `/api/v1/providers/guangya/auth-sessions/${authorizationSessionId}`,
  );
}

/** 创建用户或管理员代建的云端服务。 */
export async function createService(
  input: CreateCloudServiceInput,
  admin = false,
): Promise<CreateCloudServiceResult> {
  return requestJson<CreateCloudServiceResult>(admin ? "/api/v1/admin/services" : "/api/v1/services", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** 创建扫描任务；Web 控制台使用稳定设备标识和随机请求 ID。 */
export async function createScanJob(serviceId: string, scanMode: "incremental" | "full", admin = false): Promise<ScanJob> {
  const result = await requestJson<{ job: ScanJob }>(
    admin ? `/api/v1/admin/services/${serviceId}/scan-jobs` : `/api/v1/services/${serviceId}/scan-jobs`,
    {
      method: "POST",
      body: JSON.stringify({
        scanMode,
        requestId: createRequestId(),
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
        requestId: createRequestId(),
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

/** 下载任务级扫描刮削失败报告，并使用服务端文件名保存到本地。 */
export async function downloadScanFailureReport(jobId: string, admin = false): Promise<void> {
  let response: Response;
  try {
    response = await fetch(
      admin ? `/api/v1/admin/jobs/${jobId}/failure-report` : `/api/v1/scan-jobs/${jobId}/failure-report`,
      { credentials: "include" },
    );
  } catch {
    throw new ApiClientError(0, "network_error", "无法连接 FlyCloudHelper API");
  }
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as ApiErrorResponse;
    throw new ApiClientError(
      response.status,
      payload.error?.code ?? "scan_failure_report_download_failed",
      payload.error?.message ?? "扫描失败报告下载失败",
    );
  }

  const contentDisposition = response.headers.get("Content-Disposition") ?? "";
  // 关键变量：接口文件名只包含任务 ID；解析失败时仍使用可识别的本地文件名。
  const fileName = contentDisposition.match(/filename="?([^";]+)"?/iu)?.[1]
    ?? `scan-failures-${jobId}.jsonl`;
  const objectUrl = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(objectUrl);
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

/** 删除单个云端服务，并由服务端同时解除 APP 服务关联。 */
export function deleteCloudService(serviceId: string, admin = false): Promise<void> {
  return requestJson(admin ? `/api/v1/admin/services/${serviceId}` : `/api/v1/services/${serviceId}`, {
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

/** 手动为已有但缺少规格的视频创建独立后台任务。 */
export function backfillExistingMediaProbes(
  serviceId: string,
  admin = false,
): Promise<{ job: ScanJob | null; queuedCount: number }> {
  return requestJson(
    admin
      ? `/api/v1/admin/services/${serviceId}/media-probes/backfill`
      : `/api/v1/services/${serviceId}/media-probes/backfill`,
    { method: "POST", body: JSON.stringify({}) },
  );
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

/** 开启或关闭单个服务的媒体中转播放。 */
export async function updateServiceRelayPlayback(
  serviceId: string,
  relayPlaybackEnabled: boolean,
  admin = false,
): Promise<ServiceDetail> {
  const result = await requestJson<{ service: ServiceDetail }>(
    admin
      ? `/api/v1/admin/services/${serviceId}/playback-settings`
      : `/api/v1/services/${serviceId}/playback-settings`,
    { method: "PATCH", body: JSON.stringify({ relayPlaybackEnabled }) },
  );
  return result.service;
}

/** 读取当前服务的协议账号和 Jellyfin 地址。 */
export async function getServiceAccessSettings(serviceId: string, admin = false): Promise<ServiceAccessSettings> {
  const result = await requestJson<{ settings: ServiceAccessSettings }>(admin ? `/api/v1/admin/services/${serviceId}/access-account` : `/api/v1/services/${serviceId}/access-account`);
  return result.settings;
}

/** 修改服务协议用户名或密码。 */
export async function updateServiceAccessCredentials(serviceId: string, input: { username?: string; password?: string }, admin = false): Promise<ServiceAccessSettings> {
  const result = await requestJson<{ settings: ServiceAccessSettings }>(admin ? `/api/v1/admin/services/${serviceId}/access-account` : `/api/v1/services/${serviceId}/access-account`, { method: "PATCH", body: JSON.stringify(input) });
  return result.settings;
}

/** 重置服务协议密码，明文只在本次响应返回。 */
export function resetServiceAccessPassword(serviceId: string, admin = false): Promise<{ settings: ServiceAccessSettings; password: string }> {
  return requestJson(admin ? `/api/v1/admin/services/${serviceId}/access-account/reset-password` : `/api/v1/services/${serviceId}/access-account/reset-password`, { method: "POST", body: "{}" });
}

/** 撤销当前服务的全部 Jellyfin/Emby 兼容会话。 */
export function revokeServiceAccessSessions(serviceId: string, admin = false): Promise<{ revokedCount: number }> {
  return requestJson(admin ? `/api/v1/admin/services/${serviceId}/access-account/revoke-sessions` : `/api/v1/services/${serviceId}/access-account/revoke-sessions`, { method: "POST", body: "{}" });
}

/** 修改单个媒体库的 Jellyfin 开关或自定义地址后缀。 */
export async function updateServiceJellyfinSettings(
  serviceId: string,
  input: { jellyfinEnabled?: boolean; jellyfinPathSuffix?: string },
  admin = false,
): Promise<ServiceAccessSettings> {
  const result = await requestJson<{ settings: ServiceAccessSettings }>(admin ? `/api/v1/admin/services/${serviceId}/jellyfin-settings` : `/api/v1/services/${serviceId}/jellyfin-settings`, { method: "PATCH", body: JSON.stringify(input) });
  return result.settings;
}

/** 读取用户或管理员作用域扫描任务。 */
export function listJobs(admin = false): Promise<{ items: ScanJob[]; total: number }> {
  return requestJson(admin ? "/api/v1/admin/jobs?limit=200" : "/api/v1/scan-jobs?limit=200");
}

/** 读取视频规格后台任务最终失败的文件列表。 */
export function listMediaProbeJobFailures(jobId: string, admin = false): Promise<{ items: MediaProbeFailure[] }> {
  return requestJson(admin
    ? `/api/v1/admin/jobs/${jobId}/media-probe-failures`
    : `/api/v1/scan-jobs/${jobId}/media-probe-failures`);
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

/** 将指定的其他用户标记为待删除，并立即撤销其全部会话。 */
export async function deleteAdminUser(userId: string): Promise<void> {
  await requestJson<{ status: "pending_delete" }>(`/api/v1/admin/users/${userId}`, {
    method: "DELETE",
    body: JSON.stringify({ confirmation: userId }),
  });
}

/** 彻底删除一个已经进入待删除状态的其他用户。 */
export async function purgeAdminUser(userId: string): Promise<void> {
  await requestJson<void>(`/api/v1/admin/users/${userId}/purge`, {
    method: "DELETE",
    body: JSON.stringify({ confirmation: userId }),
  });
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

/** 保存实例对外公开根地址；环境变量配置时服务端会拒绝修改。 */
export async function updateAdminPublicBaseUrl(publicBaseUrl: string): Promise<AdminConfigStatus["publicAccess"]> {
  const result = await requestJson<{ publicAccess: AdminConfigStatus["publicAccess"] }>("/api/v1/admin/config/public-access", { method: "PUT", body: JSON.stringify({ publicBaseUrl }) });
  return result.publicAccess;
}

/** 清空数据库、待写入队列和进程内的部署级 TMDB 共享缓存。 */
export function clearAdminTmdbCache(): Promise<{
  deletedCount: number;
  discardedPendingCount: number;
  clearedMemoryCount: number;
}> {
  return requestJson("/api/v1/admin/config/tmdb-cache", {
    method: "DELETE",
    body: JSON.stringify({ confirmation: "tmdb-cache" }),
  });
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

/** 读取当前登录账号最近的通知。 */
export async function listNotifications(limit = 30): Promise<ConsoleNotification[]> {
  const result = await requestJson<{ notifications: ConsoleNotification[] }>(`/api/v1/notifications?limit=${limit}`);
  return result.notifications;
}

/** 清除当前账号的一条通知。 */
export async function deleteNotification(notificationId: string): Promise<void> {
  await requestJson<void>(`/api/v1/notifications/${notificationId}`, { method: "DELETE" });
}

/** 清除当前账号的全部通知。 */
export async function clearNotifications(): Promise<number> {
  const result = await requestJson<{ deletedCount: number }>("/api/v1/notifications", { method: "DELETE" });
  return result.deletedCount;
}

/** 撤销当前 Web 会话。 */
export async function logout(): Promise<void> {
  await requestJson<void>("/api/v1/auth/logout", { method: "POST" });
}
