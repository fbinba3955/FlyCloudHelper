export type UserRole = "user" | "super_admin";
export type UserStatus = "active" | "disabled" | "pending_delete";
export type NotificationCategory = "task" | "security" | "system";
export type NotificationTone = "info" | "success" | "warning" | "danger";
export type ServiceStatus = "active" | "scanning" | "reauthorization_required" | "disabled";
export type JobStatus = "queued" | "running" | "retry_waiting" | "paused" | "completed" | "failed" | "cancelled";
export type BackgroundJobType = "scan" | "media_probe";
export type JobStage = "queued" | "enumerating" | "classifying" | "scraping" | "persisting" | "probing" | "completed";
export type MediaType = "video" | "music" | "audiobook";
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
  /** 当前服务是否允许 APP 通过 FlyCloudHelper 中转媒体文件。 */
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
  locator: Record<string, unknown>;
}

export interface MediaItemRecord {
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
