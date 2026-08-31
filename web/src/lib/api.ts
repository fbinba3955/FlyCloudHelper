export type AuthRole = "user" | "super_admin";

export interface AuthUser {
  userId: string;
  username: string;
  role: AuthRole;
  status: "active" | "disabled" | "pending_delete";
  createdAt: string;
}

/** 公共健康接口返回的服务版本与运行状态。 */
export interface ServiceHealth {
  status: "ok";
  version: string;
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

export type TelegramNotificationDestinationType = "chat" | "user";

/** 管理端可读取的 Telegram 脱敏配置，永远不包含 Bot Token 原文。 */
export interface TelegramNotificationSettings {
  enabled: boolean;
  botTokenConfigured: boolean;
  destinationType: TelegramNotificationDestinationType;
  destinationId: string;
  chatId: string;
  telegramUserId: string;
  configurationRevision: number;
}

export interface AdminNotificationSettings {
  telegram: TelegramNotificationSettings;
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
    // 关键变量：没有请求体时不能声明 JSON，否则 Fastify 会把空请求体判定为 JSON 解析失败。
    const requestHeaders = new Headers(init?.headers);
    if (init?.body !== undefined && !requestHeaders.has("Content-Type")) {
      requestHeaders.set("Content-Type", "application/json");
    }
    response = await fetch(path, {
      ...init,
      credentials: "include",
      headers: requestHeaders,
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
export type ScanScheduleType = "interval" | "daily" | "weekly" | "monthly";

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

export type BuiltinMusicSourceId = "musicbrainz" | "netease" | "qmusic" | "kugou" | "migu" | "kuwo";

export interface AdminMusicSourceSettings {
  enabledSources: BuiltinMusicSourceId[];
  configurationRevision: number;
  source: "default" | "database";
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
    apiBaseUrl: string;
    imageBaseUrl: string;
    baseUrlSource: "default" | "database";
    baseUrlConfigurationRevision: number;
    revision: string;
  };
  publicAccess: {
    publicBaseUrl: string | null;
    source: "environment" | "database" | "missing";
    editable: boolean;
  };
  music: {
    sources: AdminMusicSourceSettings;
    musicBrainz: { status: string };
    acoustId: { status: string; configured: boolean; reasonCode: string };
    fingerprint: { status: string; configured: boolean; reasonCode: string };
  };
  credentials: { configured: boolean; source: "file" | "environment" | "generated" };
  plugins: { directoryReady: boolean; installedCount: number; enabledCount: number };
  aiModels: {
    configuredCount: number;
    enabledCount: number;
    availableCount: number;
    unavailableCount: number;
  };
  worker: WorkerStatus;
}

export type AiModelProtocol = "openai_chat_completions";
export type AiModelStatus = "enabled" | "disabled";
export type AiModelCheckStatus = "unknown" | "available" | "unavailable";

/** 管理端 AI 模型记录；API Key 永远不从服务端回显。 */
export interface AiModel {
  id: string;
  displayName: string;
  protocol: AiModelProtocol;
  status: AiModelStatus;
  configurationRevision: number;
  baseUrl: string;
  modelName: string;
  timeoutMs: number;
  maxConcurrency: number;
  apiKeyConfigured: boolean;
  lastCheckStatus: AiModelCheckStatus;
  lastCheckErrorCode: string | null;
  lastCheckErrorMessage: string | null;
  lastCheckLatencyMs: number | null;
  lastCheckStructuredOutput: boolean;
  lastCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SaveAiModelInput {
  displayName: string;
  protocol: AiModelProtocol;
  status: AiModelStatus;
  baseUrl: string;
  modelName: string;
  timeoutMs: number;
  maxConcurrency: number;
  apiKey?: string;
  clearApiKey?: boolean;
}

export interface AiModelAvailabilityResult {
  available: boolean;
  structuredOutput: boolean;
  latencyMs: number;
  errorCode: string | null;
  errorMessage: string | null;
}

/** 服务配置页可读取的最小 AI 模型信息，不包含接口地址和 Secret 状态。 */
export interface AvailableAiModel {
  id: string;
  displayName: string;
  status: AiModelStatus;
  available: boolean;
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
  /** 是否把当前服务的后台任务结果投递到 Telegram 等外部通知渠道。 */
  notificationEnabled: boolean;
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

/** 管理端全部服务和全部媒体库共用的服务摘要筛选条件。 */
export interface ServiceListFilters {
  search?: string;
  userId?: string;
  providerType?: string;
  dataType?: MediaType;
  status?: ServiceStatus;
  jellyfinEnabled?: boolean;
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

export interface ServiceAccessAccount {
  id: string;
  serviceId: string;
  username: string;
  hasPassword: boolean;
  /** 旧密码账号可能需要重新设置一次密码，才能使用 Subsonic token+salt 登录。 */
  subsonicTokenAuthReady: boolean;
  credentialRevision: number;
  status: "active" | "disabled";
  createdAt: string;
  updatedAt: string;
}

export interface ServiceAccessSettings {
  relayPlaybackSupported: boolean;
  appRelayPlaybackEnabled: boolean;
  jellyfinRelayPlaybackEnabled: boolean;
  /** Jellyfin 客户端是否允许下载原始影片文件。 */
  jellyfinDownloadEnabled: boolean;
  /** 是否将 Jellyfin 节目媒体库按地区拆分。 */
  jellyfinRegionLibrariesEnabled: boolean;
  jellyfinEnabled: boolean;
  jellyfinUrl: string | null;
  jellyfinPath: string;
  /** 固定 /j/ 前缀之后的单层可编辑地址后缀。 */
  jellyfinPathSuffix: string;
  /** 仅音乐类型服务支持公开 Navidrome/Subsonic 协议。 */
  navidromeSupported: boolean;
  navidromeEnabled: boolean;
  navidromeUrl: string | null;
  navidromePath: string;
  /** 固定 /n/ 前缀之后的单层可编辑地址后缀。 */
  navidromePathSuffix: string;
  /** 历史最早账号，保留给旧版客户端读取。 */
  account: ServiceAccessAccount;
  /** 同一个 Jellyfin 地址下按创建时间排列的全部账号。 */
  accounts: ServiceAccessAccount[];
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
  waitingReason: "scan_worker_capacity" | "scan_queue_order" | "service_scan_priority" | "media_probe_worker_capacity" | "worker_dispatch" | null;
  waitingForJobs: Array<{
    id: string;
    jobType: "scan" | "media_probe";
    serviceId: string;
    serviceName: string;
    ownerUsername: string;
    status: JobStatus;
  }>;
  hiddenWaitingJobCount: number;
  queueAheadCount: number;
  updatedAt: string;
}

/** 单个扫描任务采用的一条 AI 查询词补充记录。 */
export interface AiSupplementRecord {
  id: string;
  mediaType: "movie" | "tv";
  triggerReason: string;
  ruleTitle: string;
  cleanedTitle: string;
  alternateTitle: string;
  confidence: number;
  fileCount: number;
  modelId: string;
  modelDisplayName: string;
  modelRevision: number;
  createdAt: string;
}

export interface JobAiSupplementResult {
  total: number;
  items: AiSupplementRecord[];
}

/** 服务级扫描或视频规格分析定时任务。 */
export interface ScanSchedule {
  id: string;
  userId: string;
  serviceId: string;
  scanMode: "incremental" | "full" | "media_probe";
  enabled: boolean;
  scheduleType: ScanScheduleType;
  intervalMinutes: number | null;
  timeOfDay: string | null;
  dayOfWeek: number | null;
  dayOfMonth: number | null;
  timezoneOffsetMinutes: number;
  quietPeriodEnabled: boolean;
  quietStartTime: string | null;
  quietEndTime: string | null;
  nextRunAt: string | null;
  lastTriggeredAt: string | null;
  lastJobId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpdateScanScheduleInput {
  enabled: boolean;
  scheduleType: ScanScheduleType;
  intervalMinutes: number;
  timeOfDay: string;
  dayOfWeek: number;
  dayOfMonth: number;
  timezoneOffsetMinutes: number;
  quietPeriodEnabled: boolean;
  quietStartTime: string;
  quietEndTime: string;
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

/** 读取当前 FlyCloudHelper 实例的真实服务版本。 */
export function getServiceHealth(): Promise<ServiceHealth> {
  return requestJson("/api/v1/health");
}

/** 读取用户或管理端服务列表，管理端筛选由服务端作用于完整数据集。 */
export function listServices(
  admin = false,
  filters: ServiceListFilters = {},
): Promise<{ items: CloudService[]; total: number }> {
  return requestJson(withQuery(admin ? "/api/v1/admin/services" : "/api/v1/services", {
    search: filters.search,
    userId: admin ? filters.userId : undefined,
    providerType: filters.providerType,
    dataType: filters.dataType,
    status: filters.status,
    jellyfinEnabled: filters.jellyfinEnabled === undefined ? undefined : String(filters.jellyfinEnabled),
    limit: 200,
  }));
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

/** 读取服务的扫描和视频规格分析计划。 */
export async function getServiceScanSchedules(serviceId: string, admin = false): Promise<ScanSchedule[]> {
  const result = await requestJson<{ schedules: ScanSchedule[] }>(
    admin ? `/api/v1/admin/services/${serviceId}/scan-schedules` : `/api/v1/services/${serviceId}/scan-schedules`,
  );
  return result.schedules;
}

/** 保存一种后台任务的定时计划。 */
export async function updateServiceScanSchedule(
  serviceId: string,
  scanMode: "incremental" | "full" | "media_probe",
  input: UpdateScanScheduleInput,
  admin = false,
): Promise<ScanSchedule> {
  const result = await requestJson<{ schedule: ScanSchedule }>(
    admin
      ? `/api/v1/admin/services/${serviceId}/scan-schedules/${scanMode}`
      : `/api/v1/services/${serviceId}/scan-schedules/${scanMode}`,
    { method: "PUT", body: JSON.stringify(input) },
  );
  return result.schedule;
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

/** 清除当前用户或管理范围内的全部已完成后台任务。 */
export async function clearCompletedScanJobs(admin = false): Promise<number> {
  const result = await requestJson<{ deletedCount: number }>(
    admin ? "/api/v1/admin/jobs/completed" : "/api/v1/scan-jobs/completed",
    { method: "DELETE", body: JSON.stringify({ confirmation: "completed" }) },
  );
  return result.deletedCount;
}

/** 下载任务级扫描或 AI 补充失败报告，并使用服务端文件名保存到本地。 */
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
  // 浏览器需要在点击事件结束后继续读取 Blob URL，延迟释放可避免部分环境没有实际触发下载。
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
}

/** 读取当前任务 AI 补充查询词的总数和最近 20 条采用记录。 */
export function getJobAiSupplements(jobId: string, admin = false): Promise<JobAiSupplementResult> {
  return requestJson(
    admin
      ? `/api/v1/admin/jobs/${encodeURIComponent(jobId)}/ai-supplements`
      : `/api/v1/scan-jobs/${encodeURIComponent(jobId)}/ai-supplements`,
  );
}

/** 创建一次只读取媒体库未匹配记录、并强制刷新 AI 结果的后台任务。 */
export async function createManualAiSupplementJob(serviceId: string, admin = false): Promise<ScanJob> {
  const result = await requestJson<{ job: ScanJob }>(
    admin
      ? `/api/v1/admin/services/${encodeURIComponent(serviceId)}/ai-supplements/retry`
      : `/api/v1/services/${encodeURIComponent(serviceId)}/ai-supplements/retry`,
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

/** 开启或关闭单个服务的后台任务完成通知。 */
export async function updateServiceNotificationSettings(
  serviceId: string,
  notificationEnabled: boolean,
  admin = false,
): Promise<ServiceDetail> {
  const result = await requestJson<{ service: ServiceDetail }>(
    admin
      ? `/api/v1/admin/services/${serviceId}/notification-settings`
      : `/api/v1/services/${serviceId}/notification-settings`,
    { method: "PATCH", body: JSON.stringify({ notificationEnabled }) },
  );
  return result.service;
}

/** 兼容旧版 APP：开启或关闭单个媒体库的 APP 专用中转播放。 */
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

/** 为当前媒体库的同一个 Jellyfin 地址新增登录账号。 */
export async function createServiceAccessAccount(
  serviceId: string,
  input: { username: string; password?: string },
  admin = false,
): Promise<ServiceAccessSettings> {
  const result = await requestJson<{ settings: ServiceAccessSettings }>(
    admin ? `/api/v1/admin/services/${serviceId}/access-accounts` : `/api/v1/services/${serviceId}/access-accounts`,
    { method: "POST", body: JSON.stringify(input) },
  );
  return result.settings;
}

/** 修改、启用或停用指定 Jellyfin 账号。 */
export async function updateServiceAccessAccount(
  serviceId: string,
  accountId: string,
  input: { username?: string; password?: string; status?: "active" | "disabled" },
  admin = false,
): Promise<ServiceAccessSettings> {
  const result = await requestJson<{ settings: ServiceAccessSettings }>(
    admin ? `/api/v1/admin/services/${serviceId}/access-accounts/${accountId}` : `/api/v1/services/${serviceId}/access-accounts/${accountId}`,
    { method: "PATCH", body: JSON.stringify(input) },
  );
  return result.settings;
}

/** 删除指定 Jellyfin 账号及其独立观看记录。 */
export function deleteServiceAccessAccount(serviceId: string, accountId: string, admin = false): Promise<void> {
  return requestJson(
    admin ? `/api/v1/admin/services/${serviceId}/access-accounts/${accountId}` : `/api/v1/services/${serviceId}/access-accounts/${accountId}`,
    { method: "DELETE", body: JSON.stringify({ confirmation: accountId }) },
  );
}

/** 仅撤销指定 Jellyfin 账号的全部登录会话。 */
export function revokeServiceAccessAccountSessions(serviceId: string, accountId: string, admin = false): Promise<{ revokedCount: number }> {
  return requestJson(
    admin ? `/api/v1/admin/services/${serviceId}/access-accounts/${accountId}/revoke-sessions` : `/api/v1/services/${serviceId}/access-accounts/${accountId}/revoke-sessions`,
    { method: "POST", body: "{}" },
  );
}

/** 重置服务协议密码，明文只在本次响应返回。 */
export function resetServiceAccessPassword(serviceId: string, admin = false): Promise<{ settings: ServiceAccessSettings; password: string }> {
  return requestJson(admin ? `/api/v1/admin/services/${serviceId}/access-account/reset-password` : `/api/v1/services/${serviceId}/access-account/reset-password`, { method: "POST", body: "{}" });
}

/** 撤销当前服务的全部 Jellyfin/Emby 兼容会话。 */
export function revokeServiceAccessSessions(serviceId: string, admin = false): Promise<{ revokedCount: number }> {
  return requestJson(admin ? `/api/v1/admin/services/${serviceId}/access-account/revoke-sessions` : `/api/v1/services/${serviceId}/access-account/revoke-sessions`, { method: "POST", body: "{}" });
}

/** 修改单个媒体库的 Jellyfin 开关、自定义地址后缀、下载权限或节目地区分组。 */
export async function updateServiceJellyfinSettings(
  serviceId: string,
  input: {
    jellyfinEnabled?: boolean;
    jellyfinPathSuffix?: string;
    jellyfinDownloadEnabled?: boolean;
    jellyfinRegionLibrariesEnabled?: boolean;
  },
  admin = false,
): Promise<ServiceAccessSettings> {
  const result = await requestJson<{ settings: ServiceAccessSettings }>(admin ? `/api/v1/admin/services/${serviceId}/jellyfin-settings` : `/api/v1/services/${serviceId}/jellyfin-settings`, { method: "PATCH", body: JSON.stringify(input) });
  return result.settings;
}

/** 开启或关闭音乐媒体库的 Navidrome/Subsonic 公开协议。 */
export async function updateServiceNavidromeSettings(
  serviceId: string,
  input: { navidromeEnabled?: boolean; navidromePathSuffix?: string },
  admin = false,
): Promise<ServiceAccessSettings> {
  const result = await requestJson<{ settings: ServiceAccessSettings }>(
    admin ? `/api/v1/admin/services/${serviceId}/navidrome-settings` : `/api/v1/services/${serviceId}/navidrome-settings`,
    { method: "PATCH", body: JSON.stringify(input) },
  );
  return result.settings;
}

/** 分别修改媒体库的 APP 专用中转与 Jellyfin 中转开关。 */
export async function updateLibraryPlaybackSettings(
  serviceId: string,
  input: { appRelayPlaybackEnabled?: boolean; jellyfinRelayPlaybackEnabled?: boolean },
  admin = false,
): Promise<ServiceAccessSettings> {
  const result = await requestJson<{ settings: ServiceAccessSettings }>(
    admin
      ? `/api/v1/admin/services/${serviceId}/library-playback-settings`
      : `/api/v1/services/${serviceId}/library-playback-settings`,
    { method: "PATCH", body: JSON.stringify(input) },
  );
  return result.settings;
}

/** 后台任务列表支持的服务端筛选条件。 */
export interface JobListFilters {
  /** active 同时表示排队、运行、等待恢复和暂停。 */
  status?: JobStatus | "active";
  jobType?: "scan" | "media_probe";
}

/** 读取用户或管理员作用域后台任务，并由服务端完成状态和类型筛选。 */
export function listJobs(admin = false, filters: JobListFilters = {}): Promise<{ items: ScanJob[]; total: number }> {
  const query = new URLSearchParams({ limit: "200" });
  if (filters.status) query.set("status", filters.status);
  if (filters.jobType) query.set("jobType", filters.jobType);
  return requestJson(`${admin ? "/api/v1/admin/jobs" : "/api/v1/scan-jobs"}?${query.toString()}`);
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

/** 读取音乐专辑或歌曲关联的艺术家，不返回播放定位。 */
export async function listMediaItemArtists(
  item: Pick<MediaItem, "id" | "libraryId">,
  admin = false,
): Promise<MediaItem[]> {
  const path = admin
    ? `/api/v1/admin/catalog/items/${item.id}/artists`
    : `/api/v1/libraries/${item.libraryId}/items/${item.id}/artists`;
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

/** 读取系统级外部通知渠道的脱敏设置。 */
export function getAdminNotificationSettings(): Promise<AdminNotificationSettings> {
  return requestJson("/api/v1/admin/notification-settings");
}

/** 保存 Telegram 通知渠道；Bot Token 留空时保留服务端已有值。 */
export async function updateAdminTelegramNotificationSettings(input: {
  enabled: boolean;
  botToken: string;
  chatId: string;
  telegramUserId: string;
}): Promise<TelegramNotificationSettings> {
  const result = await requestJson<{ telegram: TelegramNotificationSettings }>(
    "/api/v1/admin/notification-settings/telegram",
    { method: "PUT", body: JSON.stringify(input) },
  );
  return result.telegram;
}

/** 使用已经保存并启用的 Telegram 配置发送测试通知。 */
export async function testAdminTelegramNotification(input: {
  botToken: string;
  chatId: string;
  telegramUserId: string;
}): Promise<void> {
  await requestJson<{ sent: true }>("/api/v1/admin/notification-settings/telegram/test", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** 读取系统级音乐刮削来源配置。 */
export async function getAdminMusicSourceSettings(): Promise<AdminMusicSourceSettings> {
  const result = await requestJson<{ musicSources: AdminMusicSourceSettings }>("/api/v1/admin/config/music-sources");
  return result.musicSources;
}

/** 保存系统级音乐刮削来源配置。 */
export async function updateAdminMusicSourceSettings(
  enabledSources: BuiltinMusicSourceId[],
): Promise<AdminMusicSourceSettings> {
  const result = await requestJson<{ musicSources: AdminMusicSourceSettings }>("/api/v1/admin/config/music-sources", {
    method: "PUT",
    body: JSON.stringify({ enabledSources }),
  });
  return result.musicSources;
}

/** 读取全部 AI 模型配置，响应不包含 API Key 原文。 */
export function listAdminAiModels(): Promise<{ items: AiModel[]; total: number }> {
  return requestJson("/api/v1/admin/ai-models");
}

/** 读取服务可选择的启用模型，并保留当前已选停用模型用于回显。 */
export function listAvailableAiModels(serviceId: string): Promise<{ items: AvailableAiModel[]; total: number }> {
  return requestJson(`/api/v1/ai-models/available?serviceId=${encodeURIComponent(serviceId)}`);
}

/** 创建 AI 模型和第一份配置修订。 */
export async function createAdminAiModel(input: SaveAiModelInput): Promise<AiModel> {
  const result = await requestJson<{ model: AiModel }>("/api/v1/admin/ai-models", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return result.model;
}

/** 保存 AI 模型的新配置修订；空 API Key 由服务端解释为保留旧值。 */
export async function updateAdminAiModel(modelId: string, input: SaveAiModelInput): Promise<AiModel> {
  const result = await requestJson<{ model: AiModel }>(`/api/v1/admin/ai-models/${encodeURIComponent(modelId)}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
  return result.model;
}

/** 启用或停用 AI 模型。 */
export async function updateAdminAiModelStatus(modelId: string, status: AiModelStatus): Promise<AiModel> {
  const result = await requestJson<{ model: AiModel }>(
    `/api/v1/admin/ai-models/${encodeURIComponent(modelId)}/status`,
    { method: "PATCH", body: JSON.stringify({ status }) },
  );
  return result.model;
}

/** 使用模型当前配置执行真实对话与 JSON 结构化输出测试。 */
export async function testAdminAiModel(modelId: string): Promise<{
  result: AiModelAvailabilityResult;
  model: AiModel;
}> {
  return requestJson(`/api/v1/admin/ai-models/${encodeURIComponent(modelId)}/test`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

/** 用系统配置中的完整新列表替换 TMDB Key 池，Key 原文不会回显。 */
export async function updateAdminTmdbKeys(keys: string[]): Promise<AdminConfigStatus["tmdb"]> {
  const result = await requestJson<{ tmdb: AdminConfigStatus["tmdb"] }>("/api/v1/admin/config/tmdb-keys", {
    method: "PUT",
    body: JSON.stringify({ keys }),
  });
  return result.tmdb;
}

/** 保存 TMDB API 与图片代理地址；两个地址留空时恢复默认值。 */
export async function updateAdminTmdbBaseUrls(
  apiBaseUrl: string,
  imageBaseUrl: string,
): Promise<AdminConfigStatus["tmdb"]> {
  const result = await requestJson<{ tmdb: AdminConfigStatus["tmdb"] }>("/api/v1/admin/config/tmdb-base-urls", {
    method: "PUT",
    body: JSON.stringify({ apiBaseUrl, imageBaseUrl }),
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
