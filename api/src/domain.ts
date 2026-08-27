export type UserRole = "user" | "super_admin";
export type UserStatus = "active" | "disabled" | "pending_delete";
export type NotificationCategory = "task" | "security" | "system";
export type NotificationTone = "info" | "success" | "warning" | "danger";
export type ServiceStatus = "active" | "scanning" | "reauthorization_required" | "disabled";
export type ScanScheduleType = "interval" | "daily" | "weekly" | "monthly";
export type JobStatus = "queued" | "running" | "retry_waiting" | "paused" | "completed" | "failed" | "cancelled";
export type BackgroundJobType = "scan" | "media_probe";
export type JobStage = "queued" | "enumerating" | "classifying" | "scraping" | "persisting" | "probing" | "completed";
export type MediaType = "video" | "music" | "audiobook";
export type VideoRegionGroup = "chinese" | "japan_korea" | "europe_america" | "other";
export type CatalogSort =
  | "created_desc"
  | "created_asc"
  | "updated_desc"
  | "updated_asc"
  | "year_desc"
  | "year_asc"
  | "premiere_date_desc"
  | "premiere_date_asc"
  | "title_asc"
  | "title_desc";
export type MatchState = "matched" | "needs_review" | "unmatched" | "processing";
export type ServiceMigrationStatus =
  | "preparing"
  | "uploading"
  | "queued"
  | "validating"
  | "importing"
  | "finalizing"
  | "completed"
  | "failed"
  | "cancelled";

export interface PublicUserRecord {
  id: string;
  username: string;
  role: UserRole;
  status: UserStatus;
  createdAt: string;
  lastLoginAt: string | null;
}

/** 控制台右上角展示的持久化通知。 */
export interface NotificationRecord {
  id: string;
  userId: string;
  category: NotificationCategory;
  tone: NotificationTone;
  title: string;
  message: string;
  actionPath: string | null;
  createdAt: string;
}

export interface AuthenticationRecord extends PublicUserRecord {
  passwordHash: string;
}

export interface SystemStateRecord {
  serviceInstanceId: string;
  setupRequired: boolean;
  credentialKeyBackupRequired: boolean;
  credentialKeySource: "file" | "environment" | "generated" | null;
  schemaVersion: number;
}

export interface CloudServiceRecord {
  id: string;
  userId: string;
  ownerUsername: string;
  libraryId: string;
  displayName: string;
  providerType: string;
  dataType: MediaType;
  status: ServiceStatus;
  connectionStatus: string;
  /** 当前媒体库是否允许 APP 通过 FlyCloudHelper 专用接口中转媒体文件。 */
  relayPlaybackEnabled: boolean;
  /** 当前服务是否对外提供 Jellyfin 兼容接口。 */
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

export interface ServiceDetailRecord extends CloudServiceRecord {
  scanProfile: Record<string, unknown>;
  metadataProfile: Record<string, unknown>;
  credentialConfigured: boolean;
  bindings: Array<Record<string, unknown>>;
  recentJobs: ScanJobRecord[];
}

export interface JobWaitTargetRecord {
  id: string;
  jobType: BackgroundJobType;
  serviceId: string;
  serviceName: string;
  ownerUsername: string;
  status: JobStatus;
}

export interface ScanJobRecord {
  id: string;
  /** 后台任务类型；保留 ScanJobRecord 名称兼容现有 APP 和接口。 */
  jobType: BackgroundJobType;
  userId: string;
  serviceId: string;
  libraryId: string;
  ownerUsername: string;
  serviceName: string;
  dataType: MediaType;
  requestId: string;
  clientDeviceId: string;
  scanMode: "incremental" | "full";
  status: JobStatus;
  stage: JobStage;
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
  /** TMDB 临时不可用时，任务下一次自动恢复的时间。 */
  nextRetryAt: string | null;
  /** 当前任务已经进入延迟恢复状态的累计次数。 */
  retryCount: number;
  snapshot: Record<string, unknown>;
  controlAction: "none" | "pause" | "cancel";
  /** 最近一次可恢复安全检查点时间；终态任务清理后为空。 */
  checkpointUpdatedAt: string | null;
  /** 当前任务是否存在可供暂停/进程恢复使用的检查点。 */
  resumeSupported: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** 任务真正处于扫描刮削运行状态的累计时长，不包含排队、暂停和延迟恢复等待。 */
  elapsedMs: number;
  /** 排队任务当前等待的原因；非排队任务始终为空。 */
  waitingReason: "scan_worker_capacity" | "scan_queue_order" | "service_scan_priority" | "media_probe_worker_capacity" | "worker_dispatch" | null;
  /** 当前权限范围内可以展示的阻塞任务。 */
  waitingForJobs: JobWaitTargetRecord[];
  /** 因账号隔离不能展示详情的阻塞任务数量。 */
  hiddenWaitingJobCount: number;
  /** 当前扫描任务之前尚未被领取的扫描任务数量。 */
  queueAheadCount: number;
  updatedAt: string;
}

/** 服务级扫描或视频规格分析定时计划。 */
export interface ScanScheduleRecord {
  id: string;
  userId: string;
  serviceId: string;
  /** 保留 scanMode 字段兼容现有客户端，media_probe 表示独立 ffprobe 规格任务。 */
  scanMode: "incremental" | "full" | "media_probe";
  enabled: boolean;
  scheduleType: ScanScheduleType;
  intervalMinutes: number | null;
  timeOfDay: string | null;
  dayOfWeek: number | null;
  dayOfMonth: number | null;
  timezoneOffsetMinutes: number;
  /** 是否启用每天重复的禁扫时间段。 */
  quietPeriodEnabled: boolean;
  /** 禁扫时间段开始时间，按计划保存的固定时区解释。 */
  quietStartTime: string | null;
  /** 禁扫时间段结束时间，允许小于开始时间以表示跨零点。 */
  quietEndTime: string | null;
  nextRunAt: string | null;
  lastTriggeredAt: string | null;
  lastJobId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 视频规格后台任务中的失败文件，只返回脱敏后的文件名和错误分类。 */
export interface MediaProbeFailureRecord {
  sourceFileId: string;
  fileName: string;
  errorCode: string;
  errorMessage: string;
}

/** APP 本地媒体库迁移到云助手的持久化状态。 */
export interface ServiceMigrationRecord {
  id: string;
  userId: string;
  serviceId: string;
  libraryId: string;
  requestId: string;
  clientDeviceId: string;
  clientServiceId: string;
  providerType: string;
  /** 当前迁移取消时是否需要同时回收由迁移创建的云端服务。 */
  ownsService: boolean;
  status: ServiceMigrationStatus;
  stage: ServiceMigrationStatus;
  progressPercent: number;
  currentOperation: string;
  processedCount: number;
  totalCount: number;
  uploadedBytes: number;
  totalBytes: number;
  uploadedChunkCount: number;
  totalChunkCount: number;
  activeDurationMs: number;
  error: { code: string; message: string } | null;
  retryable: boolean;
  checkpoint: Record<string, unknown>;
  result: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface SourceFileRecord {
  id: string;
  userId: string;
  serviceId: string;
  libraryId: string;
  providerResourceId: string;
  parentResourceId: string | null;
  path: string;
  name: string;
  extension: string;
  size: number;
  modifiedAt: string | null;
  etag: string | null;
  /** 文件所属的稳定扫描根键，用于只对完整根执行缺失对账。 */
  scanRootKey: string;
  generationId: string;
  /** 最近一次成功生成当前媒体目录结果时使用的元数据配置修订。 */
  metadataProfileRevision: number;
  /** 规则、服务元数据配置、模型和提示词共同组成的有效识别修订。 */
  recognitionRevision: string;
  locator: Record<string, unknown>;
}

export interface MediaItemRecord {
  id: string;
  userId: string;
  serviceId: string;
  libraryId: string;
  mediaType: MediaType;
  itemType: string;
  /** 节目的 Jellyfin 地区分组；电影和缺少地区数据的条目为 other。 */
  regionGroup: VideoRegionGroup;
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
  /** 当前条目及其直接子项已经完成的媒体规格汇总；尚未分析时为空。 */
  mediaProbeSummary: MediaProbeSummaryRecord | null;
  ownerUsername: string;
  serviceName: string;
  createdAt: string;
  updatedAt: string;
}

/** 海报墙和媒体详情使用的 ffprobe 汇总信息。 */
export interface MediaProbeSummaryRecord {
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

export interface JobEventRecord {
  sequence: number;
  userId: string;
  jobId: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface ExportRecord {
  id: string;
  userId: string;
  libraryId: string;
  exportType: "binding" | "snapshot";
  status: "queued" | "running" | "completed" | "failed";
  stage: string;
  progressPercent: number;
  processedCount: number;
  totalCount: number;
  catalogVersion: number;
  formatVersion: number;
  filePath: string | null;
  fileSize: number | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface PluginVersionRecord {
  pluginId: string;
  version: string;
  displayName: string;
  status: "imported" | "enabled" | "disabled";
  sha256: string;
  manifest: Record<string, unknown>;
  configurationRevision: number;
  configurationState: Record<string, boolean>;
  installedPath: string;
  createdAt: string;
  updatedAt: string;
}

export type AiModelProtocol = "openai_chat_completions";
export type AiModelStatus = "enabled" | "disabled";
export type AiModelCheckStatus = "unknown" | "available" | "unavailable";

/** 管理端可见的 AI 模型配置，不包含 API Key 原文。 */
export interface AiModelRecord {
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

/** 单次模型可用性测试的脱敏结果。 */
export interface AiModelAvailabilityResult {
  available: boolean;
  structuredOutput: boolean;
  latencyMs: number;
  errorCode: string | null;
  errorMessage: string | null;
}

export type AiCleaningTriggerMode = "weak_only" | "weak_or_unmatched";

/** 扫描任务冻结的 AI 模型与清洗策略，不包含地址或 API Key。 */
export interface AiModelTaskSnapshot {
  modelId: string;
  configurationRevision: number;
  promptVersion: string;
  triggerMode: AiCleaningTriggerMode;
  minConfidence: number;
}

export interface AuditRecord {
  id: string;
  operatorUserId: string | null;
  operatorUsername: string | null;
  operationType: string;
  targetType: string;
  targetId: string | null;
  result: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

/** 安全解析数据库 JSON 字段，损坏值回退为空对象。 */
export function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || !value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** 安全解析数据库 JSON 数组字段，损坏值回退为空数组。 */
export function parseJsonArray(value: unknown): Array<Record<string, unknown>> {
  if (typeof value !== "string" || !value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
      : [];
  } catch {
    return [];
  }
}
