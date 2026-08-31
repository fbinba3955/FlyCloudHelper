import { createHash, randomUUID } from "node:crypto";
import type { Knex } from "knex";
import type { FlyCloudHelperDatabase } from "./database.js";
import {
  type CloudServiceRecord,
  type AiModelTaskSnapshot,
  type CatalogSort,
  type JobEventRecord,
  type JobStage,
  type JobStatus,
  type MatchState,
  type MediaItemRecord,
  type MediaProbeFailureRecord,
  type MediaProbeSummaryRecord,
  type MediaType,
  type ScanJobRecord,
  type ServiceDetailRecord,
  type ServiceStatus,
  type SourceFileRecord,
  type VideoRegionGroup,
  parseJsonObject,
} from "./domain.js";
import { ApiError, toSafeErrorMessage } from "./errors.js";
import { isFlymbyExcludedPath } from "./media/flymby-scan-exclusions.js";
import { createStableId } from "./media/filename.js";
import type { FlymbyNfoMetadata } from "./media/flymby-nfo-parser.js";
import { parseFlymbyVideoName } from "./media/flymby-video-parser.js";
import { parseMediaProbeResult, type MediaProbeResult } from "./media/media-probe.js";
import type { TmdbEpisodeMetadata, TmdbVideoMetadata } from "./metadata/tmdb.js";
import {
  AUDIO_TAG_PARSER_VERSION,
  type AudioTagReadResult,
} from "./music/audio-tag-reader.js";
import { ServiceAccessService, type GeneratedServiceAccessCredentials } from "./service-access.js";

type ServiceRepositoryLogger = (
  level: "info" | "warn",
  fields: Record<string, string | number | boolean | null>,
) => void;

interface JellyfinServiceCleanupResult {
  protocolSessionCount: number;
  virtualPreferenceCount: number;
  playbackProgressCount: number;
  playbackSessionCount: number;
  playbackHistoryCount: number;
  accessAccountCount: number;
}

// 关键变量：华语、日韩优先于欧美判断，跨地区合拍节目按更具体的亚洲分组归类。
const CHINESE_REGION_CODES = new Set(["CN", "HK", "TW", "MO"]);
const JAPAN_KOREA_REGION_CODES = new Set(["JP", "KR"]);
const EUROPE_AMERICA_REGION_CODES = new Set(
  ("US CA MX GL BM PM "
    + "BZ CR SV GT HN NI PA AI AG AW BS BB BQ VG KY CU CW DM DO GD GP HT JM MQ MS PR BL KN LC MF VC SX TT TC VI "
    + "AR BO BR CL CO EC FK GF GY PY PE SR UY VE "
    + "GB IE FR DE IT ES PT NL BE LU AT CH DK NO SE FI IS GR PL CZ SK HU RO BG HR SI RS BA ME MK AL EE LV LT UA BY MD RU CY MT AD MC LI SM VA XK "
    + "AU NZ")
    .split(" "),
);

/** 从已解析JSON字段读取字符串数组，过滤非字符串和值为空的条目。 */
function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    : [];
}

/** 根据节目 TMDB origin_country 计算稳定地区分组；电影和缺失数据统一归入 other。 */
function readVideoRegionGroup(itemType: string, metadata: Record<string, unknown>): VideoRegionGroup {
  if (itemType !== "video.series") return "other";
  const countries = Array.isArray(metadata.originCountries)
    ? metadata.originCountries.map((country) => String(country).trim().toUpperCase()).filter(Boolean)
    : [];
  if (countries.some((country) => CHINESE_REGION_CODES.has(country))) return "chinese";
  if (countries.some((country) => JAPAN_KOREA_REGION_CODES.has(country))) return "japan_korea";
  if (countries.some((country) => EUROPE_AMERICA_REGION_CODES.has(country))) return "europe_america";
  return "other";
}

interface ServiceRow {
  id: string;
  user_id: string;
  owner_username: string;
  library_id: string;
  display_name: string;
  provider_type: string;
  data_type: MediaType;
  status: ServiceStatus;
  connection_status: string;
  relay_playback_enabled: number | string | boolean;
  notification_enabled: number | string | boolean;
  jellyfin_enabled: number | string | boolean;
  credential_revision: number | string;
  scan_profile_revision: number | string;
  metadata_profile_revision: number | string;
  catalog_version: number | string;
  item_count: number | string;
  last_scan_at: string | null;
  created_at: string;
  updated_at: string;
}

interface JobRow {
  id: string;
  user_id: string;
  service_id: string;
  library_id: string;
  owner_username: string;
  service_name: string;
  data_type: MediaType;
  request_id: string;
  client_device_id: string;
  scan_mode: "incremental" | "full";
  status: JobStatus;
  stage: JobStage;
  processed_count: number | string;
  total_count: number | string | null;
  discovered_count: number | string;
  skipped_count: number | string;
  matched_count: number | string | null;
  unmatched_count: number | string | null;
  error_count: number | string;
  current_path: string | null;
  error_code: string | null;
  error_message: string | null;
  next_retry_at: string | null;
  retry_count: number | string;
  snapshot_json: string;
  control_action: "none" | "pause" | "cancel";
  checkpoint_updated_at: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  active_duration_ms: number | string;
  active_started_at: string | null;
  updated_at: string;
}

interface MediaProbeJobRow {
  id: string;
  user_id: string;
  service_id: string;
  library_id: string;
  owner_username: string;
  service_name: string;
  status: JobStatus;
  stage: "queued" | "probing" | "completed";
  processed_count: number | string;
  total_count: number | string;
  error_count: number | string;
  current_file_name: string | null;
  error_code: string | null;
  error_message: string | null;
  next_retry_at: string | null;
  control_action: "none" | "pause" | "cancel";
  snapshot_json: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  active_duration_ms: number | string;
  active_started_at: string | null;
  updated_at: string;
}

interface ActiveDurationRow {
  status: JobStatus;
  active_duration_ms: number | string | null;
  active_started_at: string | null;
}

interface JobWaitRow {
  id: string;
  user_id: string;
  service_id: string;
  service_name: string;
  owner_username: string;
  status: JobStatus;
  created_at: string;
}

/** Worker 持久化的业务统计集合；使用稳定任务键避免续扫后重复计数。 */
export interface ScanCheckpointProgress {
  enumeratedEntryCount: number;
  scannedMediaCount: number;
  skippedCount: number;
  currentScanPath: string | null;
  scannedDirectoryCount: number;
  providerWarningKeys: string[];
  taskKeys: string[];
  processedKeys: string[];
  matchedKeys: string[];
  unmatchedKeys: string[];
  failedKeys: string[];
  movieTaskKeys: string[];
  seriesTaskKeys: string[];
}

/** 批量准备源文件后返回的稳定记录及变化判断。 */
export interface PreparedSourceFileRecord {
  sourceFile: SourceFileRecord;
  unchanged: boolean;
  /** 复用的是已匹配目录结果；全量扫描可据此恢复影片级统计。 */
  reusedMatchedCatalog: boolean;
}

/** NFO旁车缓存使用的稳定资源身份和文件指纹。 */
export interface NfoSidecarCacheInput {
  userId: string;
  serviceId: string;
  libraryId: string;
  providerResourceId: string;
  path: string;
  size: number;
  modifiedAt: string | null;
  etag: string | null;
  parserVersion: string;
}

/** 单个扫描任务的安全检查点；不包含任何 Provider 连接凭据。 */
export interface ScanJobCheckpointRecord {
  jobId: string;
  userId: string;
  serviceId: string;
  libraryId: string;
  checkpointVersion: number;
  scanSessionId: string;
  generationId: string;
  providerType: string;
  providerState: Record<string, unknown>;
  progress: ScanCheckpointProgress;
  nfoSidecars: Record<string, unknown>;
  changedItemIds: string[];
  createdAt: string;
  updatedAt: string;
}

/** 扫描根运行记录，用于区分完整枚举和带警告完成。 */
export interface ScanRootRunRecord {
  rootKey: string;
  generationId: string;
  status: "running" | "completed" | "incomplete";
  warningCount: number;
}

/** 规格父任务同步结果，completedNow 只在本次原子更新首次进入完成态时为真。 */
export interface MediaProbeSynchronizationResult {
  job: ScanJobRecord;
  completedNow: boolean;
  completedFileCount: number;
}

/** 把服务查询行转换为公开服务摘要。 */
function mapService(row: ServiceRow): CloudServiceRecord {
  return {
    id: row.id,
    userId: row.user_id,
    ownerUsername: row.owner_username,
    libraryId: row.library_id,
    displayName: row.display_name,
    providerType: row.provider_type,
    dataType: row.data_type,
    status: row.status,
    connectionStatus: row.connection_status,
    relayPlaybackEnabled: Number(row.relay_playback_enabled) === 1 || row.relay_playback_enabled === true,
    notificationEnabled: Number(row.notification_enabled) === 1 || row.notification_enabled === true,
    jellyfinEnabled: Number(row.jellyfin_enabled) === 1 || row.jellyfin_enabled === true,
    credentialRevision: Number(row.credential_revision),
    scanProfileRevision: Number(row.scan_profile_revision),
    metadataProfileRevision: Number(row.metadata_profile_revision),
    catalogVersion: Number(row.catalog_version),
    itemCount: Number(row.item_count),
    lastScanAt: row.last_scan_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 把数据库时长值限制为安全的非负整数。 */
function readActiveDurationMs(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(parsed));
}

/** 计算任务截至指定时刻真正处于 running 状态的累计时长。 */
function calculateActiveDurationMs(row: ActiveDurationRow, nowMs = Date.now()): number {
  const accumulatedMs = readActiveDurationMs(row.active_duration_ms);
  if (row.status !== "running" || !row.active_started_at) return accumulatedMs;
  const activeStartedAtMs = Date.parse(row.active_started_at);
  if (!Number.isFinite(activeStartedAtMs) || nowMs <= activeStartedAtMs) return accumulatedMs;
  return Math.min(Number.MAX_SAFE_INTEGER, accumulatedMs + Math.floor(nowMs - activeStartedAtMs));
}

/** 把任务查询行转换为公开任务 DTO。 */
function mapJob(row: JobRow): ScanJobRecord {
  return {
    id: row.id,
    jobType: "scan",
    userId: row.user_id,
    serviceId: row.service_id,
    libraryId: row.library_id,
    ownerUsername: row.owner_username,
    serviceName: row.service_name,
    dataType: row.data_type,
    requestId: row.request_id,
    clientDeviceId: row.client_device_id,
    scanMode: row.scan_mode,
    status: row.status,
    stage: row.stage,
    processedCount: Number(row.processed_count),
    totalCount: row.total_count === null ? null : Number(row.total_count),
    discoveredCount: Number(row.discovered_count),
    skippedCount: Number(row.skipped_count),
    matchedCount: row.matched_count === null || row.matched_count === undefined ? null : Number(row.matched_count),
    unmatchedCount: row.unmatched_count === null || row.unmatched_count === undefined ? null : Number(row.unmatched_count),
    errorCount: Number(row.error_count),
    currentPath: row.current_path,
    errorCode: row.error_code,
    errorMessage: row.error_message ? toSafeErrorMessage(row.error_message, "扫描任务失败") : null,
    nextRetryAt: row.next_retry_at,
    retryCount: Number(row.retry_count ?? 0),
    snapshot: parseJsonObject(row.snapshot_json),
    controlAction: row.control_action,
    checkpointUpdatedAt: row.checkpoint_updated_at,
    resumeSupported: Boolean(row.checkpoint_updated_at)
      && (row.status === "queued" || row.status === "running" || row.status === "retry_waiting" || row.status === "paused"),
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    elapsedMs: calculateActiveDurationMs(row),
    waitingReason: null,
    waitingForJobs: [],
    hiddenWaitingJobCount: 0,
    queueAheadCount: 0,
    updatedAt: row.updated_at,
  };
}

/** 把媒体规格汇总任务转换为现有后台任务 DTO。 */
function mapMediaProbeJob(row: MediaProbeJobRow): ScanJobRecord {
  const totalCount = Number(row.total_count ?? 0);
  return {
    id: row.id,
    jobType: "media_probe",
    userId: row.user_id,
    serviceId: row.service_id,
    libraryId: row.library_id,
    ownerUsername: row.owner_username,
    serviceName: row.service_name,
    dataType: "video",
    requestId: "",
    clientDeviceId: "server",
    scanMode: "incremental",
    status: row.status,
    stage: row.stage,
    processedCount: Number(row.processed_count ?? 0),
    totalCount,
    discoveredCount: totalCount,
    skippedCount: 0,
    matchedCount: null,
    unmatchedCount: null,
    errorCount: Number(row.error_count ?? 0),
    currentPath: row.current_file_name,
    errorCode: row.error_code,
    errorMessage: row.error_message ? toSafeErrorMessage(row.error_message, "视频规格分析失败") : null,
    nextRetryAt: row.next_retry_at,
    retryCount: 0,
    snapshot: parseJsonObject(row.snapshot_json),
    controlAction: row.control_action,
    checkpointUpdatedAt: null,
    resumeSupported: row.status === "paused",
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    elapsedMs: calculateActiveDurationMs(row),
    waitingReason: null,
    waitingForJobs: [],
    hiddenWaitingJobCount: 0,
    queueAheadCount: 0,
    updatedAt: row.updated_at,
  };
}

/** 把大 ID 列表切成数据库方言都能安全处理的小批次。 */
function chunkStrings(values: string[], size = 400): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

/** 用不包含路径的源文件属性生成媒体规格缓存指纹。 */
function createMediaProbeFingerprint(sourceFile: SourceFileRecord): string {
  return createHash("sha256").update(JSON.stringify({
    资源ID: sourceFile.providerResourceId,
    文件大小: sourceFile.size,
    修改时间: sourceFile.modifiedAt,
    ETag: sourceFile.etag,
  })).digest("hex");
}

/** 安全解析只允许字符串的 JSON 数组。 */
function parseStringArray(value: unknown): string[] {
  if (typeof value !== "string" || !value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

/** 把检查点数据库行转换为 Worker 使用的结构。 */
function mapScanJobCheckpoint(row: Record<string, unknown>): ScanJobCheckpointRecord {
  const rawProgress = parseJsonObject(row.progress_json);
  const readProgressStrings = (key: string): string[] => Array.isArray(rawProgress[key])
    ? (rawProgress[key] as unknown[]).filter((item): item is string => typeof item === "string")
    : [];
  const readProgressNumber = (key: string): number => {
    const value = Number(rawProgress[key] ?? 0);
    return Number.isFinite(value) && value >= 0 ? value : 0;
  };
  return {
    jobId: String(row.job_id),
    userId: String(row.user_id),
    serviceId: String(row.service_id),
    libraryId: String(row.library_id),
    checkpointVersion: Number(row.checkpoint_version),
    scanSessionId: String(row.scan_session_id),
    generationId: String(row.generation_id),
    providerType: String(row.provider_type),
    providerState: parseJsonObject(row.provider_state_json),
    progress: {
      enumeratedEntryCount: readProgressNumber("enumeratedEntryCount"),
      scannedMediaCount: readProgressNumber("scannedMediaCount"),
      skippedCount: readProgressNumber("skippedCount"),
      currentScanPath: typeof rawProgress.currentScanPath === "string" ? rawProgress.currentScanPath : null,
      scannedDirectoryCount: readProgressNumber("scannedDirectoryCount"),
      providerWarningKeys: readProgressStrings("providerWarningKeys"),
      taskKeys: readProgressStrings("taskKeys"),
      processedKeys: readProgressStrings("processedKeys"),
      matchedKeys: readProgressStrings("matchedKeys"),
      unmatchedKeys: readProgressStrings("unmatchedKeys"),
      failedKeys: readProgressStrings("failedKeys"),
      movieTaskKeys: readProgressStrings("movieTaskKeys"),
      seriesTaskKeys: readProgressStrings("seriesTaskKeys"),
    },
    nfoSidecars: parseJsonObject(row.nfo_sidecars_json),
    changedItemIds: parseStringArray(row.changed_item_ids_json),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

// 关键变量：每条目录变化包含 7 个绑定值，400 条可兼容 SQLite、PostgreSQL 和 MySQL 的参数上限。
const CATALOG_CHANGE_INSERT_BATCH_SIZE = 400;

export interface CatalogPathRow {
  fileId: string;
  resourceId: string;
  linkedItemId: string;
  linkedItemTitle: string;
  path: string;
  name: string;
  size: number;
  modifiedAt: string | null;
  mediaProbe: MediaProbeResult | null;
}

interface LinkedSourceRow extends Record<string, unknown> {
  file_link_id: string;
  linked_item_id: string;
  source_file_id: string;
  provider_resource_id: string;
  path: string;
  name: string;
  size: number | string;
  modified_at: string | null;
  locator_json: string;
  source_locator_json?: string;
  media_probe_status?: string | null;
  media_probe_result_json?: string | null;
}

/** 读取 ffprobe 媒体流中的安全字符串字段。 */
function readProbeStreamString(stream: Record<string, unknown> | undefined, key: string): string {
  return typeof stream?.[key] === "string" ? String(stream[key]) : "";
}

/** 读取 ffprobe 媒体流中的安全非负整数。 */
function readProbeStreamNumber(stream: Record<string, unknown> | undefined, key: string): number {
  const value = Number(stream?.[key] ?? 0);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** 从一个条目的已完成文件分析中生成适合海报墙展示的代表规格。 */
function buildMediaProbeSummary(probes: MediaProbeResult[]): MediaProbeSummaryRecord | null {
  if (probes.length === 0) return null;
  let primaryProbe = probes[0]!;
  let primaryVideo: Record<string, unknown> | undefined;
  let primaryPixelCount = 0;
  for (const probe of probes) {
    for (const stream of probe.mediaStreams) {
      if (stream.Type !== "Video") continue;
      const pixelCount = readProbeStreamNumber(stream, "Width") * readProbeStreamNumber(stream, "Height");
      if (!primaryVideo || pixelCount > primaryPixelCount) {
        primaryProbe = probe;
        primaryVideo = stream;
        primaryPixelCount = pixelCount;
      }
    }
  }
  const primaryAudio = primaryProbe.mediaStreams.find((stream) => stream.Type === "Audio" && stream.IsDefault === true)
    ?? primaryProbe.mediaStreams.find((stream) => stream.Type === "Audio");
  // 关键变量：节目可能包含大量单集，音轨和字幕数量展示代表文件的数量，不能把全部单集累加。
  const audioStreamCount = primaryProbe.mediaStreams.filter((stream) => stream.Type === "Audio").length;
  const subtitleStreamCount = primaryProbe.mediaStreams.filter((stream) => stream.Type === "Subtitle").length;
  return {
    analyzedFileCount: probes.length,
    durationMs: Math.floor(Math.max(...probes.map((probe) => probe.runTimeTicks), 0) / 10_000),
    container: primaryProbe.container,
    bitRate: primaryProbe.bitRate,
    videoCodec: readProbeStreamString(primaryVideo, "Codec"),
    width: readProbeStreamNumber(primaryVideo, "Width"),
    height: readProbeStreamNumber(primaryVideo, "Height"),
    videoRange: readProbeStreamString(primaryVideo, "VideoRange"),
    videoRangeType: readProbeStreamString(primaryVideo, "VideoRangeType"),
    audioCodec: readProbeStreamString(primaryAudio, "Codec"),
    audioChannels: readProbeStreamNumber(primaryAudio, "Channels"),
    audioChannelLayout: readProbeStreamString(primaryAudio, "ChannelLayout"),
    audioStreamCount,
    subtitleStreamCount,
  };
}

interface ManualMatchSnapshot {
  itemType: string;
  title: string;
  sortTitle: string;
  subtitle: string;
  year: number | null;
  metadata: Record<string, unknown>;
}

/** 手动匹配后仍需保留的扫描来源字段，避免清除匹配时丢失本地识别依据。 */
const sourceMetadataKeys = [
  "sourcePath",
  "scrapeTaskKey",
  "query",
  "seriesTitle",
  "seasonNumber",
  "episodeNumber",
  "episodeNumbers",
  "imdbId",
  "explicitTmdbId",
  "resolution",
  "source",
  "releaseGroup",
] as const;

/** 从媒体元数据中提取扫描阶段产生的字段，不保留外部刮削结果。 */
function pickSourceMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of sourceMetadataKeys) {
    if (metadata[key] !== undefined) result[key] = metadata[key];
  }
  return result;
}

/** 把未知值安全转换为普通对象。 */
function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** 从统一元数据中读取适合数据库排序的首映日期。 */
function readMediaPremiereDate(metadata: Record<string, unknown>): string | null {
  const rawDate = typeof metadata.releaseDate === "string"
    ? metadata.releaseDate
    : typeof metadata.airDate === "string" ? metadata.airDate : "";
  return /^\d{4}-\d{2}-\d{2}/u.test(rawDate) ? rawDate.slice(0, 10) : null;
}

/** 把数据库源文件行转换为视频名称解析器可读取的 Provider 条目。 */
function toVideoProviderEntry(row: Record<string, unknown>) {
  return {
    resourceId: String(row.provider_resource_id),
    parentResourceId: null,
    path: String(row.path),
    name: String(row.name),
    isDirectory: false,
    size: Number(row.size ?? 0),
    modifiedAt: row.modified_at ? String(row.modified_at) : null,
    etag: null,
    locator: {},
  };
}

/** 提供带用户作用域的云端服务、任务和目录数据访问。 */
export class ServiceRepository {
  private readonly database: FlyCloudHelperDatabase;
  private readonly logger?: ServiceRepositoryLogger;
  private readonly scanWorkerConcurrency: number;
  private readonly mediaProbeConcurrency: number;
  private readonly serviceAccess: ServiceAccessService;
  // 关键变量：阻止同一 API 实例同时执行同一服务的多次清空，跨实例仍由数据库服务行锁兜底。
  private readonly clearingCatalogServiceIds = new Set<string>();

  /** 初始化服务仓储，并保存两个独立任务池的并发上限。 */
  public constructor(
    database: FlyCloudHelperDatabase,
    serviceAccess: ServiceAccessService,
    logger?: ServiceRepositoryLogger,
    queueLimits: { scanWorkerConcurrency: number; mediaProbeConcurrency: number } = {
      scanWorkerConcurrency: 5,
      mediaProbeConcurrency: 1,
    },
  ) {
    this.database = database;
    this.logger = logger;
    this.scanWorkerConcurrency = queueLimits.scanWorkerConcurrency;
    this.mediaProbeConcurrency = queueLimits.mediaProbeConcurrency;
    this.serviceAccess = serviceAccess;
  }

  /**
   * 为排队任务补充当前等待关系。
   * 管理端可以看到全部阻塞任务，普通用户只看到本人任务，其余任务仅返回隐藏数量。
   */
  private async attachQueuedJobWaitDetails(
    jobs: ScanJobRecord[],
    viewerUserId?: string,
    transaction: Knex | Knex.Transaction = this.database.query,
  ): Promise<ScanJobRecord[]> {
    const queuedJobs = jobs.filter((job) => job.status === "queued");
    if (queuedJobs.length === 0) return jobs;

    const selectWaitRows = (tableName: "scan_jobs" | "media_probe_jobs") => transaction(`${tableName} as j`)
      .join("cloud_services as s", "s.id", "j.service_id")
      .join("user_accounts as u", "u.id", "j.user_id")
      .select(
        "j.id",
        "j.user_id",
        "j.service_id",
        "j.status",
        "j.created_at",
        "s.display_name as service_name",
        "u.username as owner_username",
      );

    const [runningScanRows, queuedScanRows, activeScanRows, runningProbeRows, runningProbeFileCountRow] = await Promise.all([
      selectWaitRows("scan_jobs").where("j.status", "running") as unknown as Promise<JobWaitRow[]>,
      selectWaitRows("scan_jobs").where("j.status", "queued") as unknown as Promise<JobWaitRow[]>,
      selectWaitRows("scan_jobs").whereIn("j.status", ["queued", "running", "retry_waiting"]) as unknown as Promise<JobWaitRow[]>,
      selectWaitRows("media_probe_jobs").where("j.status", "running") as unknown as Promise<JobWaitRow[]>,
      transaction("media_file_probes").where("status", "running")
        .count<{ count: string | number }[]>({ count: "source_file_id" }).first(),
    ]);
    // 关键变量：规格并发按正在执行的文件数占槽，一个父任务内部也可能同时占用多个槽位。
    const runningProbeFileCount = Number(runningProbeFileCountRow?.count ?? 0);

    /** 把阻塞任务转换成公开字段，并隔离其他账号的任务详情。 */
    const createWaitTargets = (rows: JobWaitRow[], jobType: "scan" | "media_probe", currentUserId: string) => {
      const visibleRows = viewerUserId ? rows.filter((row) => row.user_id === currentUserId) : rows;
      return {
        targets: visibleRows.map((row) => ({
          id: row.id,
          jobType,
          serviceId: row.service_id,
          serviceName: row.service_name,
          ownerUsername: row.owner_username,
          status: row.status,
        })),
        hiddenCount: rows.length - visibleRows.length,
      };
    };

    return jobs.map((job): ScanJobRecord => {
      if (job.status !== "queued") return job;
      if (job.jobType === "scan") {
        const queueAheadCount = queuedScanRows.filter((row) => row.id !== job.id
          && (row.created_at < job.createdAt || (row.created_at === job.createdAt && row.id < job.id))).length;
        if (runningScanRows.length >= this.scanWorkerConcurrency) {
          const waiting = createWaitTargets(runningScanRows, "scan", job.userId);
          return {
            ...job,
            waitingReason: "scan_worker_capacity",
            waitingForJobs: waiting.targets,
            hiddenWaitingJobCount: waiting.hiddenCount,
            queueAheadCount,
          };
        }
        return {
          ...job,
          waitingReason: queueAheadCount > 0 ? "scan_queue_order" : "worker_dispatch",
          queueAheadCount,
        };
      }

      const sameServiceScans = activeScanRows.filter((row) => row.service_id === job.serviceId);
      if (sameServiceScans.length > 0) {
        const waiting = createWaitTargets(sameServiceScans, "scan", job.userId);
        return {
          ...job,
          waitingReason: "service_scan_priority",
          waitingForJobs: waiting.targets,
          hiddenWaitingJobCount: waiting.hiddenCount,
        };
      }
      if (runningProbeFileCount >= this.mediaProbeConcurrency) {
        const waiting = createWaitTargets(runningProbeRows, "media_probe", job.userId);
        return {
          ...job,
          waitingReason: "media_probe_worker_capacity",
          waitingForJobs: waiting.targets,
          hiddenWaitingJobCount: waiting.hiddenCount,
        };
      }
      return { ...job, waitingReason: "worker_dispatch" };
    });
  }

  /** 构造服务摘要公共查询，始终保留用户和媒体库链路。 */
  private serviceSummaryQuery(transaction: Knex | Knex.Transaction = this.database.query) {
    return transaction("cloud_services as s")
      .join("user_accounts as u", "u.id", "s.user_id")
      .join("media_libraries as l", "l.id", "s.library_id")
      .leftJoin("media_items as m", function joinActiveMedia() {
        this.on("m.library_id", "=", "l.id")
          .andOnNull("m.deleted_at")
          .andOnVal("m.item_type", "<>", "video.episode");
      })
      .select(
        "s.id",
        "s.user_id",
        "u.username as owner_username",
        "s.library_id",
        "s.display_name",
        "s.provider_type",
        "s.data_type",
        "s.status",
        "s.connection_status",
        "l.app_relay_playback_enabled as relay_playback_enabled",
        "s.notification_enabled",
        "l.jellyfin_enabled as jellyfin_enabled",
        "s.credential_revision",
        "s.scan_profile_revision",
        "s.metadata_profile_revision",
        "l.catalog_version",
        "s.last_scan_at",
        "s.created_at",
        "s.updated_at",
      )
      .count({ item_count: "m.id" })
      .whereNull("s.deleted_at")
      .groupBy(
        "s.id",
        "s.user_id",
        "u.username",
        "s.library_id",
        "s.display_name",
        "s.provider_type",
        "s.data_type",
        "s.status",
        "s.connection_status",
        "l.app_relay_playback_enabled",
        "s.notification_enabled",
        "l.jellyfin_enabled",
        "s.credential_revision",
        "s.scan_profile_revision",
        "s.metadata_profile_revision",
        "l.catalog_version",
        "s.last_scan_at",
        "s.created_at",
        "s.updated_at",
      );
  }

  /** 创建服务、媒体库、加密凭据和首个配置修订。 */
  public async createService(input: {
    serviceId: string;
    libraryId: string;
    userId: string;
    displayName: string;
    providerType: string;
    dataType: MediaType;
    encryptedConnection: string;
    providerSchemaVersion: number;
    scanProfile: Record<string, unknown>;
    metadataProfile: Record<string, unknown>;
    binding?: { id: string; clientDeviceId: string; clientServiceId: string };
    initialStatus?: "active" | "disabled";
  }): Promise<{ service: ServiceDetailRecord; accessCredentials: GeneratedServiceAccessCredentials }> {
    const now = new Date().toISOString();
    let accessCredentials: GeneratedServiceAccessCredentials | null = null;
    await this.database.query.transaction(async (transaction) => {
      await transaction("cloud_services").insert({
        id: input.serviceId,
        user_id: input.userId,
        library_id: input.libraryId,
        display_name: input.displayName,
        provider_type: input.providerType,
        data_type: input.dataType,
        status: input.initialStatus ?? "active",
        connection_status: "valid",
        relay_playback_enabled: 0,
        notification_enabled: 0,
        credential_revision: 1,
        scan_profile_revision: 1,
        metadata_profile_revision: 1,
        last_scan_at: null,
        created_at: now,
        updated_at: now,
        deleted_at: null,
      });
      await transaction("media_libraries").insert({
        id: input.libraryId,
        user_id: input.userId,
        service_id: input.serviceId,
        provider_type: input.providerType,
        catalog_version: 0,
        app_relay_playback_enabled: 0,
        jellyfin_relay_playback_enabled: 1,
        jellyfin_download_enabled: 1,
        jellyfin_region_libraries_enabled: 0,
        jellyfin_enabled: 0,
        navidrome_enabled: 0,
        navidrome_path_suffix: input.serviceId,
        navidrome_path_suffix_lookup: input.serviceId.toLowerCase(),
        jellyfin_path_suffix: input.serviceId,
        jellyfin_path_suffix_lookup: input.serviceId.toLowerCase(),
        status: "active",
        created_at: now,
        updated_at: now,
      });
      await transaction("service_credentials").insert({
        id: randomUUID(),
        user_id: input.userId,
        service_id: input.serviceId,
        revision: 1,
        encrypted_payload: input.encryptedConnection,
        key_version: 1,
        schema_version: input.providerSchemaVersion,
        status: "active",
        created_at: now,
      });
      await transaction("service_scan_profiles").insert({
        id: randomUUID(),
        user_id: input.userId,
        service_id: input.serviceId,
        revision: 1,
        configuration_json: JSON.stringify(input.scanProfile),
        created_at: now,
      });
      await transaction("service_metadata_profiles").insert({
        id: randomUUID(),
        user_id: input.userId,
        service_id: input.serviceId,
        revision: 1,
        configuration_json: JSON.stringify(input.metadataProfile),
        created_at: now,
      });
      accessCredentials = await this.serviceAccess.createForService(input.serviceId, transaction);
      if (input.binding) {
        await transaction("client_service_links").insert({
          id: input.binding.id,
          user_id: input.userId,
          service_id: input.serviceId,
          client_device_id: input.binding.clientDeviceId,
          client_service_id: input.binding.clientServiceId,
          provider_type: input.providerType,
          binding_source: "local_migration",
          created_at: now,
          updated_at: now,
        });
      }
    });
    if (!accessCredentials) throw new ApiError(500, "service_access_account_create_failed", "服务访问账号创建失败");
    return { service: await this.getServiceDetail(input.serviceId, input.userId), accessCredentials };
  }

  /** 列出当前用户或管理端指定范围内的服务。 */
  public async listServices(filters: {
    userId?: string;
    providerType?: string;
    dataType?: MediaType;
    status?: ServiceStatus;
    jellyfinEnabled?: boolean;
    keyword?: string;
    limit: number;
    offset: number;
  }): Promise<{ items: CloudServiceRecord[]; total: number }> {
    const query = this.serviceSummaryQuery();
    const countQuery = this.database.query("cloud_services as s")
      .join("media_libraries as l", "l.id", "s.library_id")
      .whereNull("s.deleted_at");
    if (filters.userId) {
      query.where("s.user_id", filters.userId);
      countQuery.where("s.user_id", filters.userId);
    }
    if (filters.providerType) {
      query.where("s.provider_type", filters.providerType);
      countQuery.where("s.provider_type", filters.providerType);
    }
    if (filters.dataType) {
      query.where("s.data_type", filters.dataType);
      countQuery.where("s.data_type", filters.dataType);
    }
    if (filters.status) {
      query.where("s.status", filters.status);
      countQuery.where("s.status", filters.status);
    }
    if (filters.jellyfinEnabled !== undefined) {
      const jellyfinEnabled = filters.jellyfinEnabled ? 1 : 0; // 关键变量：兼容 SQLite、PostgreSQL 和 MySQL 的数值开关字段。
      query.where("l.jellyfin_enabled", jellyfinEnabled);
      countQuery.where("l.jellyfin_enabled", jellyfinEnabled);
    }
    if (filters.keyword) {
      query.whereLike("s.display_name", `%${filters.keyword}%`);
      countQuery.whereLike("s.display_name", `%${filters.keyword}%`);
    }
    const [rows, countRow] = await Promise.all([
      query.orderBy("s.created_at", "desc").limit(filters.limit).offset(filters.offset) as unknown as Promise<ServiceRow[]>,
      countQuery.count<{ count: string | number }[]>({ count: "s.id" }).first(),
    ]);
    return { items: rows.map(mapService), total: Number(countRow?.count ?? 0) };
  }

  /** 按完整用户作用域查询服务详情，不返回凭据明文。 */
  public async getServiceDetail(serviceId: string, userId?: string): Promise<ServiceDetailRecord> {
    const query = this.serviceSummaryQuery().where("s.id", serviceId);
    if (userId) {
      query.where("s.user_id", userId);
    }
    const row = (await query.first()) as ServiceRow | undefined;
    if (!row) {
      throw new ApiError(404, "service_not_found", "云端服务不存在");
    }
    const [scanProfileRow, metadataProfileRow, credentialRow, bindings, recentJobs] = await Promise.all([
      this.database.query("service_scan_profiles").where({ service_id: serviceId, revision: Number(row.scan_profile_revision) }).first(),
      this.database.query("service_metadata_profiles").where({ service_id: serviceId, revision: Number(row.metadata_profile_revision) }).first(),
      this.database.query("service_credentials").where({ service_id: serviceId, revision: Number(row.credential_revision), status: "active" }).first(),
      this.database.query("client_service_links").select("id", "client_device_id", "client_service_id", "provider_type", "updated_at").where({ service_id: serviceId }).orderBy("updated_at", "desc"),
      this.listJobs({ userId: row.user_id, serviceId, limit: 10, offset: 0 }).then((result) => result.items),
    ]);
    return {
      ...mapService(row),
      scanProfile: parseJsonObject(scanProfileRow?.configuration_json),
      metadataProfile: parseJsonObject(metadataProfileRow?.configuration_json),
      credentialConfigured: Boolean(credentialRow),
      bindings: bindings.map((binding) => ({
        bindingId: binding.id,
        clientDeviceId: binding.client_device_id,
        clientServiceId: binding.client_service_id,
        providerType: binding.provider_type,
        updatedAt: binding.updated_at,
      })),
      recentJobs,
    };
  }

  /** 取得 Worker 使用的冻结连接和配置修订。 */
  public async getJobRuntimeConfiguration(job: ScanJobRecord): Promise<{
    encryptedConnection: string;
    providerType: string;
    scanProfile: Record<string, unknown>;
    metadataProfile: Record<string, unknown>;
  }> {
    const credentialRevision = Number(job.snapshot.credentialRevision);
    const scanProfileRevision = Number(job.snapshot.scanProfileRevision);
    const metadataProfileRevision = Number(job.snapshot.metadataProfileRevision);
    const [service, credential, scanProfile, metadataProfile] = await Promise.all([
      this.database.query("cloud_services").where({ id: job.serviceId, user_id: job.userId }).whereNull("deleted_at").first(),
      this.database.query("service_credentials").where({ service_id: job.serviceId, user_id: job.userId, revision: credentialRevision, status: "active" }).first(),
      this.database.query("service_scan_profiles").where({ service_id: job.serviceId, user_id: job.userId, revision: scanProfileRevision }).first(),
      this.database.query("service_metadata_profiles").where({ service_id: job.serviceId, user_id: job.userId, revision: metadataProfileRevision }).first(),
    ]);
    if (!service || !credential || !scanProfile || !metadataProfile) {
      throw new ApiError(410, "job_configuration_unavailable", "任务冻结配置已经不可用");
    }
    return {
      encryptedConnection: String(credential.encrypted_payload),
      providerType: String(service.provider_type),
      scanProfile: parseJsonObject(scanProfile.configuration_json),
      metadataProfile: parseJsonObject(metadataProfile.configuration_json),
    };
  }

  /** 只读取 AI 补充任务冻结的元数据配置，不读取 Provider 凭据和扫描配置。 */
  public async getJobMetadataConfiguration(job: ScanJobRecord): Promise<Record<string, unknown>> {
    const metadataProfileRevision = Number(job.snapshot.metadataProfileRevision);
    const [service, metadataProfile] = await Promise.all([
      this.database.query("cloud_services").where({ id: job.serviceId, user_id: job.userId }).whereNull("deleted_at").first(),
      this.database.query("service_metadata_profiles").where({
        service_id: job.serviceId,
        user_id: job.userId,
        revision: metadataProfileRevision,
      }).first(),
    ]);
    if (!service || !metadataProfile) {
      throw new ApiError(410, "job_metadata_configuration_unavailable", "任务冻结的元数据配置已经不可用");
    }
    return parseJsonObject(metadataProfile.configuration_json);
  }

  /** 读取服务当前活动凭据密文，供扫描根更新前执行真实访问校验。 */
  public async getActiveEncryptedConnection(serviceId: string, userId: string): Promise<string> {
    const service = await this.database.query("cloud_services")
      .where({ id: serviceId, user_id: userId })
      .whereNull("deleted_at")
      .first();
    if (!service) throw new ApiError(404, "service_not_found", "云端服务不存在");
    const credential = await this.database.query("service_credentials").where({
      service_id: serviceId,
      user_id: userId,
      revision: Number(service.credential_revision),
      status: "active",
    }).first();
    if (!credential) throw new ApiError(410, "service_credential_unavailable", "服务当前凭据不可用");
    return String(credential.encrypted_payload);
  }

  /**
   * 原地更新当前活动凭据中的 OAuth Token，不增加用户可见的连接修订。
   * 扫描任务仍冻结同一凭据修订，但后续任务可以读取刷新令牌轮换后的最新密文。
   */
  public async refreshActiveEncryptedConnection(input: {
    serviceId: string;
    userId: string;
    credentialRevision: number;
    encryptedConnection: string;
  }): Promise<void> {
    const updatedCount = await this.database.query("service_credentials")
      .where({
        service_id: input.serviceId,
        user_id: input.userId,
        revision: input.credentialRevision,
        status: "active",
      })
      .update({ encrypted_payload: input.encryptedConnection });
    if (updatedCount !== 1) {
      throw new ApiError(410, "service_credential_unavailable", "OAuth Token 刷新后无法更新当前服务凭据");
    }
  }

  /** 更新服务连接并生成不可变凭据修订。 */
  public async updateConnection(input: {
    serviceId: string;
    userId: string;
    encryptedConnection: string;
    providerSchemaVersion: number;
    expectedRevision?: number;
  }): Promise<ServiceDetailRecord> {
    await this.database.query.transaction(async (transaction) => {
      const service = await transaction("cloud_services").where({ id: input.serviceId, user_id: input.userId }).whereNull("deleted_at").first();
      if (!service) {
        throw new ApiError(404, "service_not_found", "云端服务不存在");
      }
      if (input.expectedRevision !== undefined
        && Number(service.credential_revision) !== input.expectedRevision) {
        throw new ApiError(409, "configuration_revision_conflict", "服务连接已在其他设备更新，请重新加载后再保存");
      }
      const revision = Number(service.credential_revision) + 1;
      const now = new Date().toISOString();
      await transaction("service_credentials").insert({
        id: randomUUID(),
        user_id: input.userId,
        service_id: input.serviceId,
        revision,
        encrypted_payload: input.encryptedConnection,
        key_version: 1,
        schema_version: input.providerSchemaVersion,
        status: "active",
        created_at: now,
      });
      await transaction("cloud_services").where({ id: input.serviceId }).update({
        credential_revision: revision,
        connection_status: "valid",
        status: service.status === "reauthorization_required" ? "active" : service.status,
        updated_at: now,
      });
    });
    // 连接重新配置成功后，自动把因鉴权失效而停止的规格文件放入新的后台任务。
    await this.recoverMediaProbesAfterReauthorization(input.serviceId, input.userId, input.userId);
    return this.getServiceDetail(input.serviceId, input.userId);
  }

  /** 当前保存的凭据重新验证成功后恢复连接状态，不创建新的凭据修订。 */
  public async restoreServiceConnection(
    serviceId: string,
    userId: string | undefined,
  ): Promise<ServiceDetailRecord> {
    const serviceQuery = this.database.query("cloud_services")
      .where({ id: serviceId })
      .whereNull("deleted_at");
    if (userId) serviceQuery.where({ user_id: userId });
    const service = await serviceQuery.first();
    if (!service) throw new ApiError(404, "service_not_found", "云端服务不存在");
    const now = new Date().toISOString();
    // 关键变量：用户主动停用的服务不能因为连接验证成功被意外启用。
    const nextStatus = service.status === "reauthorization_required" ? "active" : service.status;
    await this.database.query("cloud_services").where({ id: serviceId }).update({
      connection_status: "valid",
      status: nextStatus,
      updated_at: now,
    });
    if (nextStatus === "active") {
      await this.recoverMediaProbesAfterReauthorization(serviceId, String(service.user_id), String(service.user_id));
    }
    return this.getServiceDetail(serviceId, userId);
  }

  /** 更新扫描配置并生成不可变修订。 */
  public async updateScanProfile(
    serviceId: string,
    userId: string,
    profile: Record<string, unknown>,
    expectedRevision?: number,
  ): Promise<ServiceDetailRecord> {
    await this.updateProfileRevision("scan", serviceId, userId, profile, expectedRevision);
    return this.getServiceDetail(serviceId, userId);
  }

  /** 更新元数据配置并生成不可变修订。 */
  public async updateMetadataProfile(
    serviceId: string,
    userId: string,
    profile: Record<string, unknown>,
    expectedRevision?: number,
  ): Promise<ServiceDetailRecord> {
    await this.updateProfileRevision("metadata", serviceId, userId, profile, expectedRevision);
    return this.getServiceDetail(serviceId, userId);
  }

  /** 生成指定类型的配置修订并原子更新当前指针。 */
  private async updateProfileRevision(
    type: "scan" | "metadata",
    serviceId: string,
    userId: string,
    profile: Record<string, unknown>,
    expectedRevision?: number,
  ): Promise<void> {
    const tableName = type === "scan" ? "service_scan_profiles" : "service_metadata_profiles";
    const revisionColumn = type === "scan" ? "scan_profile_revision" : "metadata_profile_revision";
    await this.database.query.transaction(async (transaction) => {
      const service = await transaction("cloud_services").where({ id: serviceId, user_id: userId }).whereNull("deleted_at").first();
      if (!service) {
        throw new ApiError(404, "service_not_found", "云端服务不存在");
      }
      if (expectedRevision !== undefined && Number(service[revisionColumn]) !== expectedRevision) {
        throw new ApiError(409, "configuration_revision_conflict", "服务配置已在其他设备更新，请重新加载后再保存");
      }
      const revision = Number(service[revisionColumn]) + 1;
      const now = new Date().toISOString();
      await transaction(tableName).insert({
        id: randomUUID(),
        user_id: userId,
        service_id: serviceId,
        revision,
        configuration_json: JSON.stringify(profile),
        created_at: now,
      });
      await transaction("cloud_services").where({ id: serviceId }).update({
        [revisionColumn]: revision,
        updated_at: now,
      });
    });
  }

  /** 修改云端服务名称，供托管后的原 APP 服务卡片同步展示。 */
  public async updateServiceName(
    serviceId: string,
    userId: string,
    displayName: string,
    expectedUpdatedAt?: string,
  ): Promise<ServiceDetailRecord> {
    await this.database.query.transaction(async (transaction) => {
      const service = await transaction("cloud_services")
        .where({ id: serviceId, user_id: userId })
        .whereNull("deleted_at")
        .first();
      if (!service) throw new ApiError(404, "service_not_found", "云端服务不存在");
      if (expectedUpdatedAt && String(service.updated_at) !== expectedUpdatedAt) {
        throw new ApiError(409, "configuration_revision_conflict", "服务资料已在其他设备更新，请重新加载后再保存");
      }
      await transaction("cloud_services").where({ id: serviceId }).update({
        display_name: displayName,
        updated_at: new Date().toISOString(),
      });
    });
    return this.getServiceDetail(serviceId, userId);
  }

  /** 查询客户端本地服务是否已经归属于某个云端服务。 */
  public async findClientServiceBinding(
    userId: string,
    clientDeviceId: string,
    clientServiceId: string,
  ): Promise<{ serviceId: string; libraryId: string; bindingSource: string } | null> {
    const row = await this.database.query("client_service_links as b")
      .join("cloud_services as s", "s.id", "b.service_id")
      .select("b.service_id", "b.binding_source", "s.library_id")
      .where({
        "b.user_id": userId,
        "b.client_device_id": clientDeviceId,
        "b.client_service_id": clientServiceId,
      })
      .whereNull("s.deleted_at")
      .first();
    return row ? {
      serviceId: String(row.service_id),
      libraryId: String(row.library_id),
      bindingSource: String(row.binding_source || "local_migration"),
    } : null;
  }

  /** 建立客户端本地服务到既有云端服务的绑定，不改写服务配置。 */
  public async bindClientService(input: {
    bindingId: string;
    userId: string;
    serviceId: string;
    clientDeviceId: string;
    clientServiceId: string;
    providerType: string;
  }): Promise<{ bindingId: string; serviceId: string; libraryId: string; catalogVersion: number }> {
    const service = await this.getServiceDetail(input.serviceId, input.userId);
    if (service.providerType !== input.providerType) {
      throw new ApiError(409, "provider_type_conflict", "本地服务与云端服务 Provider 类型不一致");
    }
    const now = new Date().toISOString();
    const existing = await this.database.query("client_service_links").where({
      user_id: input.userId,
      client_device_id: input.clientDeviceId,
      client_service_id: input.clientServiceId,
    }).first();
    if (existing && existing.service_id !== input.serviceId) {
      throw new ApiError(409, "client_binding_conflict", "该本地服务已经绑定其他云端服务");
    }
    if (existing) {
      // 幂等重试只能刷新时间，不能把本地迁入来源改成云端镜像而改变后续删除语义。
      await this.database.query("client_service_links").where({ id: existing.id }).update({
        updated_at: now,
      });
      return { bindingId: String(existing.id), serviceId: service.id, libraryId: service.libraryId, catalogVersion: service.catalogVersion };
    }
    const existingForCloudService = await this.database.query("client_service_links").where({
      user_id: input.userId,
      service_id: input.serviceId,
      client_device_id: input.clientDeviceId,
    }).first();
    if (existingForCloudService) {
      throw new ApiError(409, "cloud_service_already_bound_on_device", "该云端服务已经同步到当前设备");
    }
    await this.database.query("client_service_links").insert({
      id: input.bindingId,
      user_id: input.userId,
      service_id: input.serviceId,
      client_device_id: input.clientDeviceId,
      client_service_id: input.clientServiceId,
      provider_type: input.providerType,
      binding_source: "cloud_import",
      created_at: now,
      updated_at: now,
    });
    return { bindingId: input.bindingId, serviceId: service.id, libraryId: service.libraryId, catalogVersion: service.catalogVersion };
  }

  /** 只解除当前设备的一条客户端绑定，不删除云端服务及其他设备上的绑定。 */
  public async unbindClientService(input: {
    userId: string;
    serviceId: string;
    clientDeviceId: string;
    clientServiceId: string;
  }): Promise<boolean> {
    await this.getServiceDetail(input.serviceId, input.userId);
    const deletedCount = await this.database.query("client_service_links").where({
      user_id: input.userId,
      service_id: input.serviceId,
      client_device_id: input.clientDeviceId,
      client_service_id: input.clientServiceId,
    }).delete();
    return deletedCount > 0;
  }

  /** 创建具备请求幂等和同服务单写互斥的扫描任务。 */
  public async createScanJob(input: {
    jobId: string;
    userId: string;
    serviceId: string;
    requestedByUserId: string;
    requestId: string;
    clientDeviceId: string;
    scanMode: "incremental" | "full";
    runtimeRevision: string;
    tmdbKeyPoolRevision: string;
    aiModel: AiModelTaskSnapshot | null;
    taskPurpose?: "standard" | "ai_supplement_unmatched";
    retryOfJobId?: string;
    pluginVersions: Array<{
      pluginId: string;
      version: string;
      sha256: string;
      configurationRevision: number;
    }>;
  }): Promise<ScanJobRecord> {
    const existing = await this.findJobByRequest(input.userId, input.clientDeviceId, input.requestId);
    if (existing) {
      return existing;
    }
    try {
      return await this.database.query.transaction(async (transaction) => {
        let serviceQuery = transaction("cloud_services")
          .where({ id: input.serviceId, user_id: input.userId })
          .whereNull("deleted_at");
        // 关键变量：同一服务创建或重试任务时锁住服务行，避免不同请求 ID 绕过活动任务检查并生成两条任务。
        if (this.database.databaseType !== "sqlite") serviceQuery = serviceQuery.forUpdate();
        const service = await serviceQuery.first();
        if (!service) {
          throw new ApiError(404, "service_not_found", "云端服务不存在");
        }
        if (service.status === "scanning") {
          throw new ApiError(409, "scan_job_conflict", "当前服务正在扫描，不能重复创建扫描任务");
        }
        if (service.status !== "active") {
          throw new ApiError(409, "service_not_ready", "云端服务当前不能创建扫描任务");
        }
        const conflicting = await transaction("scan_jobs")
          .where({ service_id: input.serviceId })
          .whereIn("status", ["queued", "running", "retry_waiting", "paused"])
          .first();
        if (conflicting) {
          throw new ApiError(409, "scan_job_conflict", "当前服务已有未结束的扫描任务，不能重复创建");
        }
        const now = new Date().toISOString();
        const snapshot = {
          credentialRevision: Number(service.credential_revision),
          scanProfileRevision: Number(service.scan_profile_revision),
          metadataProfileRevision: Number(service.metadata_profile_revision),
          providerType: service.provider_type,
          runtimeRevision: input.runtimeRevision,
          tmdbKeyPoolRevision: input.tmdbKeyPoolRevision,
          aiModel: input.aiModel,
          taskPurpose: input.taskPurpose ?? "standard",
          retryOfJobId: input.retryOfJobId ?? null,
          pluginVersions: input.pluginVersions,
        };
        await transaction("scan_jobs").insert({
          id: input.jobId,
          user_id: input.userId,
          service_id: input.serviceId,
          library_id: service.library_id,
          requested_by_user_id: input.requestedByUserId,
          request_id: input.requestId,
          client_device_id: input.clientDeviceId,
          scan_mode: input.scanMode,
          status: "queued",
          stage: "queued",
          processed_count: 0,
          total_count: null,
          discovered_count: 0,
          skipped_count: 0,
          matched_count: 0,
          unmatched_count: 0,
          error_count: 0,
          current_path: null,
          error_code: null,
          error_message: null,
          next_retry_at: null,
          retry_count: 0,
          snapshot_json: JSON.stringify(snapshot),
          control_action: "none",
          created_at: now,
          started_at: null,
          finished_at: null,
          active_duration_ms: 0,
          active_started_at: null,
          updated_at: now,
        });
        await this.insertJobEvent(transaction, input.userId, input.jobId, "queued", {
          status: "queued",
          stage: "queued",
          retryOfJobId: input.retryOfJobId ?? null,
        });
        return this.getJob(input.jobId, input.userId, transaction);
      });
    } catch (error) {
      // 并发请求可能同时通过事务外查询；唯一索引冲突后返回已经创建的同一任务。
      const racedJob = await this.findJobByRequest(input.userId, input.clientDeviceId, input.requestId);
      if (racedJob) {
        return racedJob;
      }
      throw error;
    }
  }

  /** 按幂等键查询任务。 */
  private async findJobByRequest(userId: string, clientDeviceId: string, requestId: string): Promise<ScanJobRecord | null> {
    const row = await this.jobSummaryQuery().where({
      "j.user_id": userId,
      "j.client_device_id": clientDeviceId,
      "j.request_id": requestId,
    }).first() as JobRow | undefined;
    return row ? mapJob(row) : null;
  }

  /** 构造任务摘要公共查询。 */
  private jobSummaryQuery(transaction: Knex | Knex.Transaction = this.database.query) {
    return transaction("scan_jobs as j")
      .join("cloud_services as s", "s.id", "j.service_id")
      .join("user_accounts as u", "u.id", "s.user_id")
      .leftJoin("scan_job_checkpoints as cp", "cp.job_id", "j.id")
      .select(
        "j.*",
        "s.display_name as service_name",
        "s.data_type",
        "u.username as owner_username",
        "cp.updated_at as checkpoint_updated_at",
      );
  }

  /** 构造视频规格后台任务摘要查询。 */
  private mediaProbeJobSummaryQuery(transaction: Knex | Knex.Transaction = this.database.query) {
    return transaction("media_probe_jobs as j")
      .join("cloud_services as s", "s.id", "j.service_id")
      .join("user_accounts as u", "u.id", "s.user_id")
      .select(
        "j.*",
        "s.display_name as service_name",
        "u.username as owner_username",
      );
  }

  /** 查询单个任务并按需校验用户归属。 */
  public async getJob(
    jobId: string,
    userId?: string,
    transaction: Knex | Knex.Transaction = this.database.query,
  ): Promise<ScanJobRecord> {
    const query = this.jobSummaryQuery(transaction).where("j.id", jobId);
    if (userId) {
      query.where("j.user_id", userId);
    }
    const row = await query.first() as JobRow | undefined;
    if (row) {
      const mappedJob = mapJob(row);
      return (await this.attachQueuedJobWaitDetails([mappedJob], userId, transaction))[0] ?? mappedJob;
    }
    const mediaProbeQuery = this.mediaProbeJobSummaryQuery(transaction).where("j.id", jobId);
    if (userId) mediaProbeQuery.where("j.user_id", userId);
    const mediaProbeRow = await mediaProbeQuery.first() as MediaProbeJobRow | undefined;
    if (mediaProbeRow) {
      const mappedJob = mapMediaProbeJob(mediaProbeRow);
      return (await this.attachQueuedJobWaitDetails([mappedJob], userId, transaction))[0] ?? mappedJob;
    }
    throw new ApiError(404, "background_job_not_found", "后台任务不存在");
  }

  /** 读取任务检查点；没有保存过时返回 null。 */
  public async getScanJobCheckpoint(jobId: string): Promise<ScanJobCheckpointRecord | null> {
    const row = await this.database.query("scan_job_checkpoints").where({ job_id: jobId }).first();
    return row ? mapScanJobCheckpoint(row as Record<string, unknown>) : null;
  }

  /** 为新任务建立固定扫描会话和 generation；恢复任务时复用原记录。 */
  public async getOrCreateScanJobCheckpoint(
    job: ScanJobRecord,
    providerType: string,
  ): Promise<{ checkpoint: ScanJobCheckpointRecord; restored: boolean }> {
    const existing = await this.getScanJobCheckpoint(job.id);
    if (existing) {
      if (existing.checkpointVersion !== 1) {
        throw new ApiError(409, "scan_checkpoint_version_unsupported", "扫描检查点版本不受当前服务支持");
      }
      if (existing.providerType !== providerType) {
        throw new ApiError(409, "scan_checkpoint_provider_mismatch", "扫描检查点与当前网盘类型不一致");
      }
      return { checkpoint: existing, restored: true };
    }
    const now = new Date().toISOString();
    const emptyProgress: ScanCheckpointProgress = {
      enumeratedEntryCount: 0,
      scannedMediaCount: 0,
      skippedCount: 0,
      currentScanPath: null,
      scannedDirectoryCount: 0,
      providerWarningKeys: [],
      taskKeys: [],
      processedKeys: [],
      matchedKeys: [],
      unmatchedKeys: [],
      failedKeys: [],
      movieTaskKeys: [],
      seriesTaskKeys: [],
    };
    await this.database.query("scan_job_checkpoints").insert({
      job_id: job.id,
      user_id: job.userId,
      service_id: job.serviceId,
      library_id: job.libraryId,
      checkpoint_version: 1,
      scan_session_id: randomUUID(),
      generation_id: randomUUID(),
      provider_type: providerType,
      provider_state_json: "{}",
      progress_json: JSON.stringify(emptyProgress),
      nfo_sidecars_json: "{}",
      changed_item_ids_json: "[]",
      created_at: now,
      updated_at: now,
    }).onConflict("job_id").ignore();
    const checkpoint = await this.getScanJobCheckpoint(job.id);
    if (!checkpoint) {
      throw new ApiError(500, "scan_checkpoint_create_failed", "创建扫描检查点失败");
    }
    return { checkpoint, restored: false };
  }

  /** 原子保存目录游标和同一时刻的业务统计，不记录 Provider 凭据。 */
  public async saveScanJobCheckpoint(input: {
    checkpoint: ScanJobCheckpointRecord;
    providerState: Record<string, unknown>;
    progress: ScanCheckpointProgress;
    nfoSidecars: Record<string, unknown>;
    changedItemIds: string[];
  }): Promise<void> {
    const now = new Date().toISOString();
    await this.database.query("scan_job_checkpoints")
      .insert({
        job_id: input.checkpoint.jobId,
        user_id: input.checkpoint.userId,
        service_id: input.checkpoint.serviceId,
        library_id: input.checkpoint.libraryId,
        checkpoint_version: input.checkpoint.checkpointVersion,
        scan_session_id: input.checkpoint.scanSessionId,
        generation_id: input.checkpoint.generationId,
        provider_type: input.checkpoint.providerType,
        provider_state_json: JSON.stringify(input.providerState),
        progress_json: JSON.stringify(input.progress),
        nfo_sidecars_json: JSON.stringify(input.nfoSidecars),
        changed_item_ids_json: JSON.stringify([...new Set(input.changedItemIds)]),
        created_at: input.checkpoint.createdAt,
        updated_at: now,
      })
      .onConflict("job_id")
      .merge({
        provider_state_json: JSON.stringify(input.providerState),
        progress_json: JSON.stringify(input.progress),
        nfo_sidecars_json: JSON.stringify(input.nfoSidecars),
        changed_item_ids_json: JSON.stringify([...new Set(input.changedItemIds)]),
        updated_at: now,
      });
  }

  /** 任务完成或取消后删除检查点，暂停和异常失败继续保留。 */
  public async deleteScanJobCheckpoint(jobId: string): Promise<void> {
    await this.database.query("scan_job_checkpoints").where({ job_id: jobId }).delete();
  }

  /** 建立或恢复单个扫描根运行记录，并固定该根的 generation。 */
  public async startScanRootRun(input: {
    job: ScanJobRecord;
    rootKey: string;
    rootResourceId: string;
    displayPath: string;
  }): Promise<ScanRootRunRecord> {
    const existing = await this.database.query("scan_root_runs").where({
      job_id: input.job.id,
      root_key: input.rootKey,
    }).first();
    const now = new Date().toISOString();
    const generationId = existing ? String(existing.generation_id) : randomUUID();
    await this.database.query("scan_root_runs")
      .insert({
        id: createStableId("root-run", input.job.id, input.rootKey),
        job_id: input.job.id,
        user_id: input.job.userId,
        service_id: input.job.serviceId,
        library_id: input.job.libraryId,
        root_key: input.rootKey,
        root_resource_id: input.rootResourceId,
        display_path: input.displayPath,
        generation_id: generationId,
        status: "running",
        warning_count: existing ? Number(existing.warning_count ?? 0) : 0,
        started_at: existing ? String(existing.started_at) : now,
        finished_at: null,
        updated_at: now,
      })
      .onConflict(["job_id", "root_key"])
      .merge({ status: "running", finished_at: null, updated_at: now });
    return {
      rootKey: input.rootKey,
      generationId,
      status: "running",
      warningCount: existing ? Number(existing.warning_count ?? 0) : 0,
    };
  }

  /** 提交单个扫描根的完整性结果；带目录警告的根标记为 incomplete。 */
  public async finishScanRootRun(input: {
    jobId: string;
    rootKey: string;
    warningCount: number;
  }): Promise<void> {
    const now = new Date().toISOString();
    await this.database.query("scan_root_runs").where({
      job_id: input.jobId,
      root_key: input.rootKey,
    }).update({
      status: input.warningCount > 0 ? "incomplete" : "completed",
      warning_count: input.warningCount,
      finished_at: now,
      updated_at: now,
    });
  }

  /** 返回已经完整枚举的扫描根及其稳定 generation。 */
  public async listCompletedScanRootRuns(jobId: string): Promise<ScanRootRunRecord[]> {
    const rows = await this.database.query("scan_root_runs")
      .select("root_key", "generation_id", "status", "warning_count")
      .where({ job_id: jobId, status: "completed" });
    return rows.map((row) => ({
      rootKey: String(row.root_key),
      generationId: String(row.generation_id),
      status: "completed",
      warningCount: Number(row.warning_count ?? 0),
    }));
  }

  /** 分页查询当前用户或管理端筛选范围内的任务。 */
  public async listJobs(filters: {
    userId?: string;
    serviceId?: string;
    status?: JobStatus;
    /** 组合状态筛选，例如“未结束”同时包含排队、运行、等待恢复和暂停。 */
    statuses?: JobStatus[];
    /** 只读取扫描刮削或视频规格分析任务。 */
    jobType?: "scan" | "media_probe";
    limit: number;
    offset: number;
  }): Promise<{ items: ScanJobRecord[]; total: number }> {
    const query = this.jobSummaryQuery();
    const mediaProbeQuery = this.mediaProbeJobSummaryQuery();
    const countQuery = this.database.query("scan_jobs as j").join("cloud_services as s", "s.id", "j.service_id");
    const mediaProbeCountQuery = this.database.query("media_probe_jobs as j").join("cloud_services as s", "s.id", "j.service_id");
    if (filters.userId) {
      query.where("j.user_id", filters.userId);
      mediaProbeQuery.where("j.user_id", filters.userId);
      countQuery.where("j.user_id", filters.userId);
      mediaProbeCountQuery.where("j.user_id", filters.userId);
    }
    if (filters.serviceId) {
      query.where("j.service_id", filters.serviceId);
      mediaProbeQuery.where("j.service_id", filters.serviceId);
      countQuery.where("j.service_id", filters.serviceId);
      mediaProbeCountQuery.where("j.service_id", filters.serviceId);
    }
    const selectedStatuses = filters.statuses && filters.statuses.length > 0
      ? filters.statuses
      : filters.status ? [filters.status] : [];
    if (selectedStatuses.length > 0) {
      query.whereIn("j.status", selectedStatuses);
      mediaProbeQuery.whereIn("j.status", selectedStatuses);
      countQuery.whereIn("j.status", selectedStatuses);
      mediaProbeCountQuery.whereIn("j.status", selectedStatuses);
    }
    if (filters.jobType === "scan") {
      mediaProbeQuery.whereRaw("1 = 0");
      mediaProbeCountQuery.whereRaw("1 = 0");
    } else if (filters.jobType === "media_probe") {
      query.whereRaw("1 = 0");
      countQuery.whereRaw("1 = 0");
    }
    // 关键变量：两个物理任务表分别读取同一候选窗口，再统一按创建时间分页，保持旧接口兼容。
    const candidateLimit = filters.offset + filters.limit;
    const [rows, mediaProbeRows, countRow, mediaProbeCountRow] = await Promise.all([
      query.orderBy("j.created_at", "desc").limit(candidateLimit) as unknown as Promise<JobRow[]>,
      mediaProbeQuery.orderBy("j.created_at", "desc").limit(candidateLimit) as unknown as Promise<MediaProbeJobRow[]>,
      countQuery.count<{ count: string | number }[]>({ count: "j.id" }).first(),
      mediaProbeCountQuery.count<{ count: string | number }[]>({ count: "j.id" }).first(),
    ]);
    const items = [...rows.map(mapJob), ...mediaProbeRows.map(mapMediaProbeJob)]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(filters.offset, filters.offset + filters.limit);
    return {
      items: await this.attachQueuedJobWaitDetails(items, filters.userId),
      total: Number(countRow?.count ?? 0) + Number(mediaProbeCountRow?.count ?? 0),
    };
  }

  /** 查询一个服务当前尚未结束的扫描任务，供客户端触发前快速拦截重复请求。 */
  public async findUnfinishedScanJob(serviceId: string, userId: string): Promise<ScanJobRecord | null> {
    const row = await this.jobSummaryQuery()
      .where({ "j.service_id": serviceId, "j.user_id": userId })
      .whereIn("j.status", ["queued", "running", "retry_waiting", "paused"])
      .orderBy("j.created_at", "desc")
      .first() as JobRow | undefined;
    return row ? mapJob(row) : null;
  }

  /** 领取一个排队任务，避免同一进程重复执行。 */
  public async claimNextQueuedJob(): Promise<ScanJobRecord | null> {
    return this.database.query.transaction(async (transaction) => {
      const row = await transaction("scan_jobs").where({ status: "queued" }).orderBy("created_at", "asc").first();
      if (!row) {
        return null;
      }
      const now = new Date().toISOString();
      const changed = await transaction("scan_jobs").where({ id: row.id, status: "queued" }).update({
        status: "running",
        stage: "enumerating",
        control_action: "none",
        next_retry_at: null,
        error_code: null,
        error_message: null,
        started_at: row.started_at ?? now,
        active_started_at: now,
        updated_at: now,
      });
      if (changed !== 1) {
        return null;
      }
      await transaction("cloud_services").where({ id: row.service_id }).update({ status: "scanning", updated_at: now });
      await this.insertJobEvent(transaction, String(row.user_id), String(row.id), "progress", {
        status: "running",
        stage: "enumerating",
      });
      return this.getJob(String(row.id), String(row.user_id), transaction);
    });
  }

  /** 单实例进程启动时把异常中断的运行任务恢复到队列。 */
  public async recoverInterruptedJobs(): Promise<number> {
    const rows = await this.database.query("scan_jobs")
      .select("id", "user_id", "service_id", "status", "active_duration_ms", "active_started_at", "updated_at")
      .where({ status: "running" });
    if (rows.length === 0) return 0;
    const now = new Date().toISOString();
    await this.database.query.transaction(async (transaction) => {
      for (const row of rows) {
        // 进程终止到本次启动之间无法确认任务是否执行，因此只累计到最后一次数据库活动时间。
        const lastKnownActiveAtMs = Date.parse(String(row.updated_at));
        const activeDurationMs = calculateActiveDurationMs(
          row as ActiveDurationRow,
          Number.isFinite(lastKnownActiveAtMs) ? lastKnownActiveAtMs : Date.now(),
        );
        await transaction("scan_jobs").where({ id: row.id, status: "running" }).update({
          status: "queued",
          stage: "queued",
          control_action: "none",
          active_duration_ms: activeDurationMs,
          active_started_at: null,
          updated_at: now,
        });
        await transaction("cloud_services").where({ id: row.service_id, status: "scanning" }).update({
          status: "active",
          updated_at: now,
        });
        await this.insertJobEvent(transaction, String(row.user_id), String(row.id), "queued", {
          status: "queued",
          recoveredAfterRestart: true,
        });
      }
    });
    return rows.length;
  }

  /** 把 TMDB 临时不可用的运行任务转为等待状态，并保留现有安全检查点。 */
  public async waitForJobRetry(jobId: string, input: {
    nextRetryAt: string;
    errorCode: string;
    errorMessage: string;
  }): Promise<ScanJobRecord> {
    const current = await this.getJob(jobId);
    if (current.status !== "running") {
      throw new ApiError(409, "scan_job_not_running", "只有运行中的扫描任务可以进入延迟恢复");
    }
    const checkpoint = await this.getScanJobCheckpoint(current.id);
    const now = new Date().toISOString();
    // 关键变量：至少延迟一秒，避免异常时间值造成 Worker 紧密重复领取同一任务。
    const parsedRetryAt = Date.parse(input.nextRetryAt);
    const nextRetryAt = new Date(Math.max(Date.now() + 1_000, Number.isFinite(parsedRetryAt) ? parsedRetryAt : Date.now() + 60_000)).toISOString();
    const waitingPatch: Record<string, unknown> = {
      status: "retry_waiting",
      error_code: input.errorCode,
      error_message: input.errorMessage,
      next_retry_at: nextRetryAt,
      retry_count: current.retryCount + 1,
      control_action: "none",
      finished_at: null,
      updated_at: now,
    };
    if (checkpoint) {
      // 页面回退到最近安全检查点的统计口径，等待期间不展示尚未提交游标的窗口进度。
      waitingPatch.processed_count = checkpoint.progress.processedKeys.length + checkpoint.progress.failedKeys.length;
      waitingPatch.total_count = checkpoint.progress.taskKeys.length;
      waitingPatch.discovered_count = checkpoint.progress.scannedMediaCount;
      waitingPatch.skipped_count = checkpoint.progress.skippedCount;
      waitingPatch.matched_count = checkpoint.progress.matchedKeys.length;
      waitingPatch.unmatched_count = checkpoint.progress.unmatchedKeys.length;
      waitingPatch.error_count = checkpoint.progress.failedKeys.length;
      waitingPatch.current_path = checkpoint.progress.currentScanPath;
    }
    await this.database.query.transaction(async (transaction) => {
      const timingRow = await transaction("scan_jobs")
        .select("status", "active_duration_ms", "active_started_at")
        .where({ id: current.id, status: "running" })
        .first() as ActiveDurationRow | undefined;
      if (!timingRow) {
        throw new ApiError(409, "scan_job_not_running", "只有运行中的扫描任务可以进入延迟恢复");
      }
      waitingPatch.active_duration_ms = calculateActiveDurationMs(timingRow, Date.parse(now));
      waitingPatch.active_started_at = null;
      await transaction("scan_jobs").where({ id: current.id, status: "running" }).update(waitingPatch);
      await transaction("cloud_services").where({ id: current.serviceId, status: "scanning" }).update({
        status: "active",
        updated_at: now,
      });
      await this.insertJobEvent(transaction, current.userId, current.id, "retry_waiting", {
        status: "retry_waiting",
        stage: current.stage,
        nextRetryAt,
        retryCount: current.retryCount + 1,
        errorCode: input.errorCode,
        errorMessage: input.errorMessage,
        checkpointUpdatedAt: checkpoint?.updatedAt ?? current.checkpointUpdatedAt,
      });
    });
    return this.getJob(current.id);
  }

  /** 把到达恢复时间的 TMDB 等待任务重新放回队列。 */
  public async requeueDueRetryJobs(limit = 100): Promise<number> {
    const now = new Date().toISOString();
    return this.database.query.transaction(async (transaction) => {
      // 关键变量：按到期时间和创建时间稳定领取，防止大量等待任务恢复时顺序抖动。
      const rows = await transaction("scan_jobs")
        .select("id", "user_id", "service_id", "retry_count")
        .where({ status: "retry_waiting" })
        .whereNotNull("next_retry_at")
        .where("next_retry_at", "<=", now)
        .orderBy("next_retry_at", "asc")
        .orderBy("created_at", "asc")
        .limit(limit);
      let changedCount = 0;
      for (const row of rows) {
        const changed = await transaction("scan_jobs")
          .where({ id: row.id, status: "retry_waiting" })
          .where("next_retry_at", "<=", now)
          .update({
            status: "queued",
            stage: "queued",
            next_retry_at: null,
            error_code: null,
            error_message: null,
            control_action: "none",
            active_started_at: null,
            updated_at: now,
          });
        if (changed !== 1) continue;
        changedCount += 1;
        await this.insertJobEvent(transaction, String(row.user_id), String(row.id), "queued", {
          status: "queued",
          delayedRetry: true,
          retryCount: Number(row.retry_count ?? 0),
        });
      }
      return changedCount;
    });
  }

  /** 更新任务阶段和进度并写入可重放事件。 */
  public async updateJobProgress(jobId: string, input: {
    stage?: JobStage;
    processedCount?: number;
    totalCount?: number | null;
    discoveredCount?: number;
    skippedCount?: number;
    matchedCount?: number;
    unmatchedCount?: number;
    errorCount?: number;
    currentPath?: string | null;
  }): Promise<ScanJobRecord> {
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (input.stage !== undefined) patch.stage = input.stage;
    if (input.processedCount !== undefined) patch.processed_count = input.processedCount;
    if (input.totalCount !== undefined) patch.total_count = input.totalCount;
    if (input.discoveredCount !== undefined) patch.discovered_count = input.discoveredCount;
    if (input.skippedCount !== undefined) patch.skipped_count = input.skippedCount;
    if (input.matchedCount !== undefined) patch.matched_count = input.matchedCount;
    if (input.unmatchedCount !== undefined) patch.unmatched_count = input.unmatchedCount;
    if (input.errorCount !== undefined) patch.error_count = input.errorCount;
    if (input.currentPath !== undefined) patch.current_path = input.currentPath;
    await this.database.query("scan_jobs").where({ id: jobId }).update(patch);
    const job = await this.getJob(jobId);
    await this.addJobEvent(job.userId, job.id, "progress", {
      status: job.status,
      stage: job.stage,
      processedCount: job.processedCount,
      totalCount: job.totalCount,
      discoveredCount: job.discoveredCount,
      skippedCount: job.skippedCount,
      matchedCount: job.matchedCount,
      unmatchedCount: job.unmatchedCount,
      errorCount: job.errorCount,
      currentPath: job.currentPath,
      elapsedMs: job.elapsedMs,
    });
    return job;
  }

  /** 完成、失败、暂停或取消任务并恢复服务状态。 */
  public async finishJob(jobId: string, input: {
    status: "completed" | "failed" | "paused" | "cancelled";
    errorCode?: string | null;
    errorMessage?: string | null;
    expectedStatus?: JobStatus;
  }): Promise<ScanJobRecord> {
    const current = await this.getJob(jobId);
    const now = new Date().toISOString();
    const finishedAt = input.status === "paused" ? null : now;
    await this.database.query.transaction(async (transaction) => {
      const timingRow = await transaction("scan_jobs")
        .select("status", "active_duration_ms", "active_started_at")
        .where({ id: jobId })
        .first() as ActiveDurationRow | undefined;
      if (!timingRow) {
        throw new ApiError(404, "scan_job_not_found", "扫描任务不存在");
      }
      const activeDurationMs = calculateActiveDurationMs(timingRow, Date.parse(now));
      const finishQuery = transaction("scan_jobs").where({ id: jobId });
      if (input.expectedStatus) {
        finishQuery.where({ status: input.expectedStatus, control_action: "none" });
      }
      const changed = await finishQuery.update({
        status: input.status,
        stage: input.status === "completed" ? "completed" : current.stage,
        error_code: input.errorCode ?? null,
        error_message: input.errorMessage ?? null,
        next_retry_at: null,
        control_action: "none",
        finished_at: finishedAt,
        active_duration_ms: activeDurationMs,
        active_started_at: null,
        updated_at: now,
      });
      if (changed !== 1) {
        throw new ApiError(409, "job_operation_in_progress", "任务正在处理其他操作，请等待状态刷新后再试");
      }
      const servicePatch: Record<string, unknown> = {
        status: input.errorCode === "provider_authentication_failed" ? "reauthorization_required" : "active",
        connection_status: input.errorCode === "provider_authentication_failed" ? "reauthorization_required" : "valid",
        updated_at: now,
      };
      // AI 补充只处理数据库现有未匹配内容，完成时不能伪造一次网盘扫描时间。
      if (input.status === "completed" && current.snapshot.taskPurpose !== "ai_supplement_unmatched") {
        servicePatch.last_scan_at = now;
      }
      await transaction("cloud_services").where({ id: current.serviceId }).update(servicePatch);
      if (input.status === "completed" || input.status === "cancelled") {
        await transaction("scan_job_checkpoints").where({ job_id: current.id }).delete();
      }
      await this.insertJobEvent(transaction, current.userId, current.id, input.status, {
        status: input.status,
        stage: input.status === "completed" ? "completed" : current.stage,
        errorCode: input.errorCode ?? null,
        errorMessage: input.errorMessage ?? null,
      });
    });
    return this.getJob(jobId);
  }

  /** 写入任务控制请求，Worker 在安全检查点执行。 */
  public async requestJobControl(jobId: string, userId: string | undefined, action: "pause" | "cancel"): Promise<ScanJobRecord> {
    const job = await this.getJob(jobId, userId);
    if (job.jobType === "media_probe") return this.requestMediaProbeJobControl(job, action);
    if (!(["queued", "running", "retry_waiting", "paused"] as JobStatus[]).includes(job.status)) {
      throw new ApiError(409, "job_not_controllable", "当前任务状态不能执行该操作");
    }
    if (job.controlAction !== "none") {
      throw new ApiError(409, "job_operation_in_progress", "任务正在处理暂停或终止操作，请等待状态刷新后再试");
    }
    if ((job.status === "queued" || job.status === "retry_waiting" || job.status === "paused") && action === "cancel") {
      return this.finishJob(job.id, { status: "cancelled", expectedStatus: job.status });
    }
    if ((job.status === "queued" || job.status === "retry_waiting") && action === "pause") {
      return this.finishJob(job.id, { status: "paused", expectedStatus: job.status });
    }
    if (job.status === "paused") {
      throw new ApiError(409, "job_already_paused", "任务已经暂停");
    }
    const changed = await this.database.query("scan_jobs").where({
      id: job.id,
      status: job.status,
      control_action: "none",
    }).update({
      control_action: action,
      updated_at: new Date().toISOString(),
    });
    if (changed !== 1) {
      throw new ApiError(409, "job_operation_in_progress", "任务正在处理其他操作，请等待状态刷新后再试");
    }
    return this.getJob(job.id);
  }

  /** 对视频规格后台任务提交暂停或终止操作。 */
  private async requestMediaProbeJobControl(job: ScanJobRecord, action: "pause" | "cancel"): Promise<ScanJobRecord> {
    if (!(["queued", "running", "retry_waiting", "paused"] as JobStatus[]).includes(job.status)) {
      throw new ApiError(409, "job_not_controllable", "当前后台任务状态不能执行该操作");
    }
    if (job.controlAction !== "none") {
      throw new ApiError(409, "job_operation_in_progress", "后台任务正在处理暂停或终止操作，请等待状态刷新后再试");
    }
    if (job.status === "paused" && action === "pause") throw new ApiError(409, "job_already_paused", "后台任务已经暂停");
    const now = new Date().toISOString();
    if (job.status !== "running") {
      await this.database.query.transaction(async (transaction) => {
        if (action === "cancel") {
          await transaction("media_file_probes")
            .where({ probe_job_id: job.id })
            .whereIn("status", ["pending", "retry_waiting"])
            .update({ status: "cancelled", next_retry_at: null, finished_at: now, updated_at: now });
        }
        await transaction("media_probe_jobs").where({ id: job.id, status: job.status }).update({
          status: action === "cancel" ? "cancelled" : "paused",
          control_action: "none",
          next_retry_at: null,
          finished_at: action === "cancel" ? now : null,
          active_started_at: null,
          updated_at: now,
        });
      });
      return this.getJob(job.id, job.userId);
    }
    const changed = await this.database.query("media_probe_jobs").where({
      id: job.id,
      status: "running",
      control_action: "none",
    }).update({ control_action: action, updated_at: now });
    if (changed !== 1) throw new ApiError(409, "job_operation_in_progress", "后台任务正在处理其他操作，请等待状态刷新后再试");
    return this.getJob(job.id, job.userId);
  }

  /** Worker 中断当前 ffprobe 后，将整个规格后台任务稳定落到暂停或取消状态。 */
  public async applyMediaProbeJobControl(jobId: string, action: "pause" | "cancel"): Promise<ScanJobRecord> {
    const now = new Date().toISOString();
    await this.database.query.transaction(async (transaction) => {
      const row = await transaction("media_probe_jobs").where({ id: jobId }).first() as MediaProbeJobRow | undefined;
      if (!row) throw new ApiError(404, "background_job_not_found", "后台任务不存在");
      const nextProbeStatus = action === "cancel" ? "cancelled" : "pending";
      const probePatch: Record<string, unknown> = {
        status: nextProbeStatus,
        next_retry_at: null,
        updated_at: now,
      };
      if (action === "cancel") probePatch.finished_at = now;
      await transaction("media_file_probes")
        .where({ probe_job_id: jobId })
        .whereIn("status", action === "cancel" ? ["pending", "running", "retry_waiting"] : ["running"])
        .update(probePatch);
      await transaction("media_probe_jobs").where({ id: jobId }).update({
        status: action === "cancel" ? "cancelled" : "paused",
        control_action: "none",
        current_file_name: null,
        next_retry_at: null,
        finished_at: action === "cancel" ? now : null,
        active_duration_ms: calculateActiveDurationMs(row, Date.parse(now)),
        active_started_at: null,
        updated_at: now,
      });
    });
    return this.getJob(jobId);
  }

  /** 删除已经进入终态的后台任务及其关联记录；运行中任务必须先取消。 */
  public async deleteScanJob(jobId: string, userId?: string): Promise<void> {
    const job = await this.getJob(jobId, userId);
    if ((["queued", "running", "retry_waiting", "paused"] as JobStatus[]).includes(job.status)) {
      throw new ApiError(409, "scan_job_active", "请先终止后台任务，再删除任务记录");
    }
    if (job.jobType === "media_probe") {
      await this.database.query.transaction(async (transaction) => {
        await transaction("media_file_probes").where({ probe_job_id: job.id }).update({ probe_job_id: null });
        const deleted = await transaction("media_probe_jobs").where({ id: job.id }).delete();
        if (deleted !== 1) throw new ApiError(404, "background_job_not_found", "后台任务不存在");
      });
      return;
    }
    await this.database.query.transaction(async (transaction) => {
      await transaction("scan_job_events").where({ job_id: job.id }).delete();
      const deleted = await transaction("scan_jobs").where({ id: job.id }).delete();
      if (deleted !== 1) throw new ApiError(404, "scan_job_not_found", "扫描任务不存在");
    });
  }

  /** 批量删除指定用户或管理范围内的已完成任务，并返回需要清理失败报告的扫描任务。 */
  public async deleteCompletedJobs(userId?: string): Promise<{
    deletedCount: number;
    scanJobs: Array<{ id: string; userId: string; serviceId: string }>;
  }> {
    return this.database.query.transaction(async (transaction) => {
      let scanJobQuery = transaction("scan_jobs").select("id", "user_id", "service_id").where({ status: "completed" });
      let mediaProbeJobQuery = transaction("media_probe_jobs").select("id").where({ status: "completed" });
      if (userId) {
        scanJobQuery = scanJobQuery.where({ user_id: userId });
        mediaProbeJobQuery = mediaProbeJobQuery.where({ user_id: userId });
      }
      const scanJobRows = await scanJobQuery as Array<{ id: string; user_id: string; service_id: string }>;
      const mediaProbeJobRows = await mediaProbeJobQuery as Array<{ id: string }>;
      // 关键变量：分批操作避免 SQLite 参数上限以及大量历史任务导致单条 SQL 过长。
      const deleteBatchSize = 200;
      for (let offset = 0; offset < scanJobRows.length; offset += deleteBatchSize) {
        const jobIds = scanJobRows.slice(offset, offset + deleteBatchSize).map((row) => row.id);
        await transaction("scan_job_events").whereIn("job_id", jobIds).delete();
        await transaction("scan_jobs").whereIn("id", jobIds).delete();
      }
      for (let offset = 0; offset < mediaProbeJobRows.length; offset += deleteBatchSize) {
        const jobIds = mediaProbeJobRows.slice(offset, offset + deleteBatchSize).map((row) => row.id);
        await transaction("media_file_probes").whereIn("probe_job_id", jobIds).update({ probe_job_id: null });
        await transaction("media_probe_jobs").whereIn("id", jobIds).delete();
      }
      return {
        deletedCount: scanJobRows.length + mediaProbeJobRows.length,
        scanJobs: scanJobRows.map((row) => ({ id: row.id, userId: row.user_id, serviceId: row.service_id })),
      };
    });
  }

  /** 恢复暂停任务，继续使用原冻结配置。 */
  public async resumeJob(jobId: string, userId?: string): Promise<ScanJobRecord> {
    const job = await this.getJob(jobId, userId);
    if (job.status !== "paused") {
      throw new ApiError(409, "job_not_paused", "只有暂停任务可以继续");
    }
    if (job.jobType === "media_probe") {
      const changed = await this.database.query("media_probe_jobs").where({
        id: job.id,
        status: "paused",
        control_action: "none",
      }).update({
        status: "queued",
        stage: "queued",
        next_retry_at: null,
        current_file_name: null,
        updated_at: new Date().toISOString(),
      });
      if (changed !== 1) throw new ApiError(409, "job_operation_in_progress", "后台任务正在处理其他操作，请等待状态刷新后再试");
      return this.getJob(job.id, job.userId);
    }
    const checkpoint = await this.getScanJobCheckpoint(job.id);
    const progress = checkpoint?.progress;
    const patch: Record<string, unknown> = {
      status: "queued",
      stage: "queued",
      control_action: "none",
      next_retry_at: null,
      error_code: null,
      error_message: null,
      active_started_at: null,
      updated_at: new Date().toISOString(),
    };
    if (progress) {
      // 关键变量：Worker 从安全检查点重放，但页面扫描视频数保留暂停前高水位，避免继续后数字倒退。
      patch.processed_count = progress.processedKeys.length + progress.failedKeys.length;
      patch.total_count = progress.taskKeys.length;
      patch.discovered_count = Math.max(job.discoveredCount, progress.scannedMediaCount);
      patch.skipped_count = progress.skippedCount;
      patch.matched_count = progress.matchedKeys.length;
      patch.unmatched_count = progress.unmatchedKeys.length;
      patch.error_count = progress.failedKeys.length;
      patch.current_path = progress.currentScanPath;
    }
    const changed = await this.database.query("scan_jobs").where({
      id: job.id,
      status: "paused",
      control_action: "none",
    }).update(patch);
    if (changed !== 1) {
      throw new ApiError(409, "job_operation_in_progress", "任务正在处理其他操作，请等待状态刷新后再试");
    }
    await this.addJobEvent(job.userId, job.id, "queued", {
      status: "queued",
      resumed: true,
      checkpointRestored: Boolean(checkpoint),
      checkpointUpdatedAt: checkpoint?.updatedAt ?? null,
      resumedDiscoveredCount: progress ? Math.max(job.discoveredCount, progress.scannedMediaCount) : job.discoveredCount,
    });
    return this.getJob(job.id);
  }

  /** 查询 Worker 当前需要执行的控制动作。 */
  public async getJobControl(jobId: string): Promise<"none" | "pause" | "cancel"> {
    const row = await this.database.query("scan_jobs").select("control_action").where({ id: jobId }).first();
    if (row) return (row.control_action as "none" | "pause" | "cancel" | undefined) ?? "cancel";
    const mediaProbeRow = await this.database.query("media_probe_jobs").select("control_action").where({ id: jobId }).first();
    return (mediaProbeRow?.control_action as "none" | "pause" | "cancel" | undefined) ?? "cancel";
  }

  /** 在现有事务内插入任务事件。 */
  private async insertJobEvent(
    transaction: Knex | Knex.Transaction,
    userId: string,
    jobId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await transaction("scan_job_events").insert({
      user_id: userId,
      job_id: jobId,
      event_type: eventType,
      payload_json: JSON.stringify(payload),
      created_at: new Date().toISOString(),
    });
  }

  /** 插入持久化任务事件。 */
  public async addJobEvent(userId: string, jobId: string, eventType: string, payload: Record<string, unknown>): Promise<void> {
    await this.insertJobEvent(this.database.query, userId, jobId, eventType, payload);
  }

  /** 按事件游标读取任务事件。 */
  public async listJobEvents(filters: { userId?: string; jobId?: string; afterSequence: number; limit: number }): Promise<JobEventRecord[]> {
    const query = this.database.query("scan_job_events").where("sequence", ">", filters.afterSequence);
    if (filters.userId) query.where("user_id", filters.userId);
    if (filters.jobId) query.where("job_id", filters.jobId);
    const rows = await query.orderBy("sequence", "asc").limit(filters.limit);
    return rows.map((row) => ({
      sequence: Number(row.sequence),
      userId: String(row.user_id),
      jobId: String(row.job_id),
      eventType: String(row.event_type),
      payload: parseJsonObject(row.payload_json),
      createdAt: String(row.created_at),
    }));
  }

  /** 更新服务启停状态。 */
  public async updateServiceStatus(serviceId: string, userId: string | undefined, status: "active" | "disabled"): Promise<ServiceDetailRecord> {
    if (status === "disabled") {
      const [activeScanJob, activeMediaProbeJob] = await Promise.all([
        this.database.query("scan_jobs").where({ service_id: serviceId }).whereIn("status", ["queued", "running", "retry_waiting", "paused"]).first(),
        this.database.query("media_probe_jobs").where({ service_id: serviceId }).whereIn("status", ["queued", "running", "retry_waiting", "paused"]).first(),
      ]);
      if (activeScanJob || activeMediaProbeJob) throw new ApiError(409, "service_has_active_job", "服务仍有未结束后台任务，不能停用");
    }
    const query = this.database.query("cloud_services").where({ id: serviceId }).whereNull("deleted_at");
    if (userId) query.where({ user_id: userId });
    const changed = await query.update({ status, updated_at: new Date().toISOString() });
    if (changed !== 1) throw new ApiError(404, "service_not_found", "云端服务不存在");
    return this.getServiceDetail(serviceId, userId);
  }

  /** 更新单个媒体库是否允许 APP 专用媒体流经过 FlyCloudHelper 中转。 */
  public async updateRelayPlaybackEnabled(
    serviceId: string,
    userId: string | undefined,
    enabled: boolean,
  ): Promise<ServiceDetailRecord> {
    await this.getServiceDetail(serviceId, userId);
    const changed = await this.database.query("media_libraries").where({ service_id: serviceId }).update({
      app_relay_playback_enabled: enabled ? 1 : 0,
      updated_at: new Date().toISOString(),
    });
    if (changed !== 1) throw new ApiError(404, "library_not_found", "媒体库不存在");
    return this.getServiceDetail(serviceId, userId);
  }

  /** 更新单个服务是否向 Telegram 等外部渠道投递后台任务结果。 */
  public async updateServiceNotificationEnabled(
    serviceId: string,
    userId: string | undefined,
    enabled: boolean,
  ): Promise<ServiceDetailRecord> {
    const query = this.database.query("cloud_services").where({ id: serviceId }).whereNull("deleted_at");
    if (userId) query.where({ user_id: userId });
    const changed = await query.update({
      notification_enabled: enabled ? 1 : 0,
      updated_at: new Date().toISOString(),
    });
    if (changed !== 1) throw new ApiError(404, "service_not_found", "云端服务不存在");
    return this.getServiceDetail(serviceId, userId);
  }

  /** 在任务完成时读取服务最新通知开关，避免长任务沿用过期配置。 */
  public async isServiceNotificationEnabled(serviceId: string): Promise<boolean> {
    const row = await this.database.query("cloud_services")
      .select("notification_enabled")
      .where({ id: serviceId })
      .whereNull("deleted_at")
      .first() as { notification_enabled: number | string | boolean } | undefined;
    return row ? Number(row.notification_enabled) === 1 || row.notification_enabled === true : false;
  }

  /** 统计扫描任务启动后新建的媒体条目，供完成通知展示本次入库数量。 */
  public async getScanCreatedMediaCounts(job: Pick<ScanJobRecord, "serviceId" | "startedAt">): Promise<{
    videoContentCount: number;
    songCount: number;
    albumCount: number;
    artistCount: number;
  }> {
    if (!job.startedAt) return { videoContentCount: 0, songCount: 0, albumCount: 0, artistCount: 0 };
    const rows = await this.database.query("media_items")
      .select("item_type")
      .count<{ item_type: string; count: string | number }[]>({ count: "id" })
      .where({ service_id: job.serviceId })
      .whereNull("deleted_at")
      .where("created_at", ">=", job.startedAt)
      .whereIn("item_type", ["video.movie", "video.series", "music.track", "music.album", "music.artist"])
      .groupBy("item_type");
    // 关键变量：按条目类型读取计数，影视只统计媒体库顶层电影和节目，不把剧集文件重复计入新内容。
    const counts = new Map(rows.map((row) => [String(row.item_type), Number(row.count ?? 0)]));
    return {
      videoContentCount: (counts.get("video.movie") ?? 0) + (counts.get("video.series") ?? 0),
      songCount: counts.get("music.track") ?? 0,
      albumCount: counts.get("music.album") ?? 0,
      artistCount: counts.get("music.artist") ?? 0,
    };
  }

  /** 显式清除服务的 Jellyfin 账号、会话和播放数据，并释放自定义协议地址。 */
  private async deleteJellyfinServiceData(
    transaction: Knex.Transaction,
    serviceId: string,
    now: string,
  ): Promise<JellyfinServiceCleanupResult> {
    // 关键变量：播放表同时关联账号和媒体条目，必须先于服务访问账号删除，不能依赖软删除不会触发的外键级联。
    const virtualPreferenceCount = Number(await transaction("service_jellyfin_virtual_preferences")
      .where({ service_id: serviceId }).delete());
    const playbackHistoryCount = Number(await transaction("service_playback_history")
      .where({ service_id: serviceId }).delete());
    const playbackSessionCount = Number(await transaction("service_playback_sessions")
      .where({ service_id: serviceId }).delete());
    const playbackProgressCount = Number(await transaction("service_playback_progress")
      .where({ service_id: serviceId }).delete());
    const protocolSessionCount = Number(await transaction("service_protocol_sessions")
      .where({ service_id: serviceId }).delete());
    const accessAccountCount = Number(await transaction("service_access_accounts")
      .where({ service_id: serviceId }).delete());
    // 关键变量：删除后的占位后缀按服务 ID 唯一，既满足非空唯一约束，也释放用户原来自定义的 Jellyfin 地址。
    const deletedPathSuffix = `deleted-${serviceId}`;
    await transaction("media_libraries").where({ service_id: serviceId }).update({
      app_relay_playback_enabled: 0,
      jellyfin_relay_playback_enabled: 0,
      jellyfin_download_enabled: 0,
      jellyfin_region_libraries_enabled: 0,
      jellyfin_enabled: 0,
      navidrome_enabled: 0,
      navidrome_path_suffix: deletedPathSuffix,
      navidrome_path_suffix_lookup: deletedPathSuffix.toLowerCase(),
      jellyfin_path_suffix: deletedPathSuffix,
      jellyfin_path_suffix_lookup: deletedPathSuffix.toLowerCase(),
      status: "disabled",
      updated_at: now,
    });
    return {
      protocolSessionCount,
      virtualPreferenceCount,
      playbackProgressCount,
      playbackSessionCount,
      playbackHistoryCount,
      accessAccountCount,
    };
  }

  /** 软删除服务，并同步清除 Jellyfin 数据、活动媒体统计和扫描来源。 */
  public async deleteService(serviceId: string, userId?: string): Promise<void> {
    let jellyfinCleanupResult: JellyfinServiceCleanupResult | undefined;
    await this.database.query.transaction(async (transaction) => {
      const serviceQuery = transaction("cloud_services").where({ id: serviceId }).whereNull("deleted_at");
      if (userId) serviceQuery.where({ user_id: userId });
      const service = await serviceQuery.first();
      if (!service) throw new ApiError(404, "service_not_found", "云端服务不存在");
      const [runningScanJob, runningMediaProbeJob] = await Promise.all([
        transaction("scan_jobs").where({ service_id: serviceId }).whereIn("status", ["queued", "running", "retry_waiting", "paused"]).first(),
        transaction("media_probe_jobs").where({ service_id: serviceId }).whereIn("status", ["queued", "running", "retry_waiting", "paused"]).first(),
      ]);
      if (runningScanJob || runningMediaProbeJob) throw new ApiError(409, "service_has_active_job", "服务仍有未结束后台任务");
      const now = new Date().toISOString();
      jellyfinCleanupResult = await this.deleteJellyfinServiceData(transaction, serviceId, now);
      await transaction("media_items").where({ service_id: serviceId }).whereNull("deleted_at").update({ deleted_at: now, updated_at: now });
      await transaction("source_files").where({ service_id: serviceId }).update({ status: "missing", updated_at: now });
      // 关键变量：释放本机服务唯一绑定，删除或取消迁移后允许同一 APP 服务重新关联。
      await transaction("client_service_links").where({ service_id: serviceId }).delete();
      // 关键变量：删除服务时同步清除迁移历史，避免 APP 重新关联时恢复到已经失效的服务 ID。
      const migrationRows = await transaction("service_migrations")
        .select("id")
        .where({ service_id: serviceId });
      const migrationIds = migrationRows.map((row) => String(row.id));
      if (migrationIds.length > 0) {
        await transaction("service_migration_chunks").whereIn("migration_id", migrationIds).delete();
        await transaction("service_migrations").whereIn("id", migrationIds).delete();
      }
      await transaction("cloud_services").where({ id: serviceId }).update({ status: "disabled", deleted_at: now, updated_at: now });
    });
    if (jellyfinCleanupResult) {
      this.logger?.("info", {
        日志关键字: "codex-jellyfin-service-cleanup",
        事件: "删除服务时同步清除Jellyfin数据",
        服务ID: serviceId,
        删除协议会话数量: jellyfinCleanupResult.protocolSessionCount,
        删除虚拟条目收藏数量: jellyfinCleanupResult.virtualPreferenceCount,
        删除播放进度数量: jellyfinCleanupResult.playbackProgressCount,
        删除播放会话数量: jellyfinCleanupResult.playbackSessionCount,
        删除播放历史数量: jellyfinCleanupResult.playbackHistoryCount,
        删除访问账号数量: jellyfinCleanupResult.accessAccountCount,
      });
    }
  }

  /** 迁回 APP 完成后物理删除服务、凭据和全部目录数据，不保留软删除占位。 */
  public async hardDeleteService(serviceId: string, userId: string): Promise<void> {
    let failureStage = "读取云端服务"; // 关键变量：NAS 上发生数据库约束错误时标识具体删除阶段。
    try {
      await this.database.query.transaction(async (transaction) => {
      const service = await transaction("cloud_services")
        .where({ id: serviceId, user_id: userId })
        .first();
      if (!service) throw new ApiError(404, "service_not_found", "云端服务不存在");
      const libraryId = String(service.library_id);
      const [runningScanJob, runningMediaProbeJob] = await Promise.all([
        transaction("scan_jobs").where({ service_id: serviceId })
          .whereIn("status", ["queued", "running", "retry_waiting", "paused"]).first(),
        transaction("media_probe_jobs").where({ service_id: serviceId })
          .whereIn("status", ["queued", "running", "retry_waiting", "paused"]).first(),
      ]);
      if (runningScanJob || runningMediaProbeJob) {
        throw new ApiError(409, "service_has_active_job", "服务仍有未结束后台任务");
      }
      failureStage = "清理迁移与扫描任务";
      const migrationRows = await transaction("service_migrations").select("id").where({ service_id: serviceId });
      const migrationIds = migrationRows.map((row) => String(row.id));
      if (migrationIds.length > 0) {
        await transaction("service_migration_chunks").whereIn("migration_id", migrationIds).delete();
      }
      const scanJobRows = await transaction("scan_jobs").select("id").where({ service_id: serviceId });
      const scanJobIds = scanJobRows.map((row) => String(row.id));
      if (scanJobIds.length > 0) {
        await transaction("scan_job_events").whereIn("job_id", scanJobIds).delete();
        await transaction("scan_job_checkpoints").whereIn("job_id", scanJobIds).delete();
        await transaction("scan_root_runs").whereIn("job_id", scanJobIds).delete();
      }
      failureStage = "清理媒体目录与规格数据";
      await transaction("media_file_probes").where({ service_id: serviceId }).delete();
      await transaction("media_probe_jobs").where({ service_id: serviceId }).delete();
      await transaction("file_links").where({ library_id: libraryId }).delete();
      await transaction("media_relations").where({ library_id: libraryId }).delete();
      await transaction("catalog_changes").where({ library_id: libraryId }).delete();
      await transaction("source_files").where({ service_id: serviceId }).delete();
      await transaction("media_items").where({ service_id: serviceId }).delete();
      failureStage = "清理播放与协议数据";
      await transaction("service_playback_history").where({ service_id: serviceId }).delete();
      await transaction("service_playback_sessions").where({ service_id: serviceId }).delete();
      await transaction("service_playback_progress").where({ service_id: serviceId }).delete();
      await transaction("service_protocol_sessions").where({ service_id: serviceId }).delete();
      await transaction("service_access_accounts").where({ service_id: serviceId }).delete();
      failureStage = "清理绑定、配置和服务主记录";
      await transaction("client_service_links").where({ service_id: serviceId }).delete();
      await transaction("service_transfer_outs").where({ service_id: serviceId }).delete();
      await transaction("service_migrations").where({ service_id: serviceId }).delete();
      await transaction("scan_jobs").where({ service_id: serviceId }).delete();
      await transaction("library_exports").where({ library_id: libraryId }).delete();
      await transaction("service_metadata_profiles").where({ service_id: serviceId }).delete();
      await transaction("service_scan_profiles").where({ service_id: serviceId }).delete();
      await transaction("service_credentials").where({ service_id: serviceId }).delete();
      await transaction("media_libraries").where({ id: libraryId }).delete();
      await transaction("cloud_services").where({ id: serviceId, user_id: userId }).delete();
      });
    } catch (error) {
      this.logger?.("warn", {
        日志关键字: "codex-flycloud-hard-delete",
        事件: "迁回APP后彻底删除云端服务失败",
        阶段: failureStage,
        用户ID: userId,
        服务ID: serviceId,
        错误码: error instanceof ApiError ? error.code : "internal_error",
        错误信息: error instanceof Error ? error.message : "未知错误",
      });
      throw error;
    }
    this.logger?.("info", {
      日志关键字: "codex-flycloud-hard-delete",
      事件: "迁回APP后彻底删除云端服务",
      用户ID: userId,
      服务ID: serviceId,
    });
  }

  /** 清空单个服务的扫描文件、刮削条目和目录变更，保留服务连接、配置与任务历史。 */
  public async clearServiceCatalog(serviceId: string, userId?: string): Promise<{
    mediaItemCount: number;
    sourceFileCount: number;
  }> {
    if (this.clearingCatalogServiceIds.has(serviceId)) {
      throw new ApiError(409, "service_catalog_clear_in_progress", "当前服务正在清空媒体库，请勿重复操作");
    }
    this.clearingCatalogServiceIds.add(serviceId);
    try {
      return await this.database.query.transaction(async (transaction) => {
        let serviceQuery = transaction("cloud_services").where({ id: serviceId }).whereNull("deleted_at");
        if (userId) serviceQuery.where({ user_id: userId });
        // 关键变量：PostgreSQL/MySQL 对同一服务的重复清空请求必须先争用服务行锁，避免并发删除互相等待关联表事务锁。
        if (this.database.databaseType !== "sqlite") serviceQuery = serviceQuery.forUpdate();
        const service = await serviceQuery.first();
        if (!service) throw new ApiError(404, "service_not_found", "云端服务不存在");
        const [activeScanJob, activeMediaProbeJob] = await Promise.all([
          transaction("scan_jobs").where({ service_id: serviceId }).whereIn("status", ["queued", "running", "retry_waiting", "paused"]).first(),
          transaction("media_probe_jobs").where({ service_id: serviceId }).whereIn("status", ["queued", "running", "retry_waiting", "paused"]).first(),
        ]);
        if (activeScanJob || activeMediaProbeJob) throw new ApiError(409, "service_has_active_job", "请先终止该服务的后台任务，再清空媒体库");

        const libraryId = String(service.library_id);
        const mediaItemCountRow = await transaction("media_items")
          .where({ library_id: libraryId })
          .count<{ count: string | number }[]>({ count: "id" })
          .first();
        const sourceFileCountRow = await transaction("source_files")
          .where({ library_id: libraryId })
          .count<{ count: string | number }[]>({ count: "id" })
          .first();
        // 关键变量：显式按媒体库删除关联表，确保不同服务的数据不会被一起清空。
        await transaction("file_links").where({ library_id: libraryId }).delete();
        await transaction("media_relations").where({ library_id: libraryId }).delete();
        await transaction("media_items").where({ library_id: libraryId }).delete();
        await transaction("nfo_sidecar_cache").where({ library_id: libraryId }).delete();
        await transaction("audio_file_tags").where({ library_id: libraryId }).delete();
        await transaction("source_files").where({ library_id: libraryId }).delete();
        await transaction("catalog_changes").where({ library_id: libraryId }).delete();
        await transaction("media_libraries").where({ id: libraryId }).update({
          catalog_version: 0,
          status: "active",
          updated_at: new Date().toISOString(),
        });
        await transaction("cloud_services").where({ id: serviceId }).update({
          last_scan_at: null,
          updated_at: new Date().toISOString(),
        });
        return {
          mediaItemCount: Number(mediaItemCountRow?.count ?? 0),
          sourceFileCount: Number(sourceFileCountRow?.count ?? 0),
        };
      });
    } finally {
      this.clearingCatalogServiceIds.delete(serviceId);
    }
  }

  /** 文件指纹和解析器版本均未变化时复用音频标签，避免增量扫描再次读取远端字节。 */
  public async readAudioTagCache(sourceFileId: string, fingerprint: string): Promise<AudioTagReadResult | null> {
    const row = await this.database.query("audio_file_tags").where({
      source_file_id: sourceFileId,
      fingerprint,
      parser_version: AUDIO_TAG_PARSER_VERSION,
    }).first();
    if (!row) return null;
    const tags = parseJsonObject(row.tag_json);
    const technical = parseJsonObject(row.technical_json);
    const artwork = parseJsonObject(row.artwork_json);
    return {
      status: row.status as AudioTagReadResult["status"],
      tags: {
        title: String(tags.title ?? ""),
        artists: readStringArray(tags.artists),
        album: String(tags.album ?? ""),
        albumArtists: readStringArray(tags.albumArtists),
        trackNumber: Number(tags.trackNumber ?? 0),
        trackTotal: Number(tags.trackTotal ?? 0),
        discNumber: Number(tags.discNumber ?? 0),
        discTotal: Number(tags.discTotal ?? 0),
        date: String(tags.date ?? ""),
        year: Number.isInteger(Number(tags.year)) && Number(tags.year) > 0 ? Number(tags.year) : null,
        genres: readStringArray(tags.genres),
        composers: readStringArray(tags.composers),
        lyrics: String(tags.lyrics ?? ""),
        isrc: String(tags.isrc ?? ""),
        musicBrainzRecordingId: String(tags.musicBrainzRecordingId ?? ""),
        musicBrainzReleaseTrackId: String(tags.musicBrainzReleaseTrackId ?? ""),
        musicBrainzReleaseId: String(tags.musicBrainzReleaseId ?? ""),
        musicBrainzReleaseGroupId: String(tags.musicBrainzReleaseGroupId ?? ""),
        musicBrainzArtistIds: readStringArray(tags.musicBrainzArtistIds),
        musicBrainzAlbumArtistIds: readStringArray(tags.musicBrainzAlbumArtistIds),
      },
      technical: {
        durationMs: Number(technical.durationMs ?? 0),
        container: String(technical.container ?? ""),
        bitRate: Number(technical.bitRate ?? 0),
        codec: String(technical.codec ?? ""),
        sampleRate: Number(technical.sampleRate ?? 0),
        channels: Number(technical.channels ?? 0),
        channelLayout: String(technical.channelLayout ?? ""),
        bitDepth: Number(technical.bitDepth ?? 0),
      },
      artwork: {
        embedded: artwork.embedded === true,
        url: typeof artwork.url === "string" && artwork.url ? artwork.url : null,
      },
      readBytesLimit: Number(row.read_bytes_limit ?? 0),
      errorCode: row.error_code ? String(row.error_code) : null,
      errorMessage: row.error_message ? String(row.error_message) : null,
      readAt: String(row.read_at),
    };
  }

  /** 保存当前源文件指纹对应的音频标签，不保存临时地址和Provider请求头。 */
  public async saveAudioTagCache(input: {
    sourceFile: SourceFileRecord;
    fingerprint: string;
    result: AudioTagReadResult;
  }): Promise<void> {
    const now = new Date().toISOString();
    await this.database.query("audio_file_tags")
      .insert({
        source_file_id: input.sourceFile.id,
        user_id: input.sourceFile.userId,
        service_id: input.sourceFile.serviceId,
        library_id: input.sourceFile.libraryId,
        fingerprint: input.fingerprint,
        status: input.result.status,
        parser_version: AUDIO_TAG_PARSER_VERSION,
        tag_json: JSON.stringify(input.result.tags),
        technical_json: JSON.stringify(input.result.technical),
        artwork_json: JSON.stringify(input.result.artwork),
        read_bytes_limit: input.result.readBytesLimit,
        error_code: input.result.errorCode,
        error_message: input.result.errorMessage,
        read_at: input.result.readAt,
        created_at: now,
        updated_at: now,
      })
      .onConflict("source_file_id")
      .merge({
        fingerprint: input.fingerprint,
        status: input.result.status,
        parser_version: AUDIO_TAG_PARSER_VERSION,
        tag_json: JSON.stringify(input.result.tags),
        technical_json: JSON.stringify(input.result.technical),
        artwork_json: JSON.stringify(input.result.artwork),
        read_bytes_limit: input.result.readBytesLimit,
        error_code: input.result.errorCode,
        error_message: input.result.errorMessage,
        read_at: input.result.readAt,
        updated_at: now,
      });
  }

  /** 文件指纹未变化时返回已解析的NFO，缺少修改时间和ETag时不冒险复用。 */
  public async readNfoSidecarCache(input: NfoSidecarCacheInput): Promise<FlymbyNfoMetadata | null> {
    if (!input.modifiedAt && !input.etag) return null;
    const row = await this.database.query("nfo_sidecar_cache").where({
      user_id: input.userId,
      library_id: input.libraryId,
      provider_resource_id: input.providerResourceId,
    }).first();
    if (!row
      || String(row.path) !== input.path
      || Number(row.size) !== input.size
      || String(row.modified_at ?? "") !== String(input.modifiedAt ?? "")
      || String(row.etag ?? "") !== String(input.etag ?? "")
      || String(row.parser_version) !== input.parserVersion) {
      return null;
    }
    try {
      const metadata = parseJsonObject(row.metadata_json);
      const rootType = String(metadata.rootType ?? "");
      if (!["movie", "tvshow", "episodedetails", "unknown"].includes(rootType)) return null;
      return metadata as unknown as FlymbyNfoMetadata;
    } catch {
      return null;
    }
  }

  /** 保存当前NFO文件指纹和解析结果，相同稳定资源ID原位更新。 */
  public async saveNfoSidecarCache(
    input: NfoSidecarCacheInput,
    metadata: FlymbyNfoMetadata,
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.database.query("nfo_sidecar_cache")
      .insert({
        id: createStableId("nfo-sidecar", input.userId, input.libraryId, input.providerResourceId),
        user_id: input.userId,
        service_id: input.serviceId,
        library_id: input.libraryId,
        provider_resource_id: input.providerResourceId,
        path: input.path,
        size: input.size,
        modified_at: input.modifiedAt,
        etag: input.etag,
        parser_version: input.parserVersion,
        metadata_json: JSON.stringify(metadata),
        created_at: now,
        updated_at: now,
      })
      .onConflict(["user_id", "library_id", "provider_resource_id"])
      .merge([
        "service_id",
        "path",
        "size",
        "modified_at",
        "etag",
        "parser_version",
        "metadata_json",
        "updated_at",
      ]);
  }

  /** 若源文件属性和播放定位均未变化，只推进本轮扫描标记并返回现有记录。 */
  public async markSourceFileSeenIfUnchanged(input: SourceFileRecord): Promise<SourceFileRecord | null> {
    const row = await this.database.query("source_files").where({
      user_id: input.userId,
      library_id: input.libraryId,
      provider_resource_id: input.providerResourceId,
    }).first();
    if (!row) {
      return null;
    }
    const unchanged = row.status === "active"
      && String(row.scan_root_key ?? "") === input.scanRootKey
      && String(row.parent_resource_id ?? "") === String(input.parentResourceId ?? "")
      && String(row.path) === input.path
      && String(row.name) === input.name
      && Number(row.size) === input.size
      && String(row.modified_at ?? "") === String(input.modifiedAt ?? "")
      && String(row.etag ?? "") === String(input.etag ?? "")
      && String(row.locator_json) === JSON.stringify(input.locator);
    if (!unchanged) {
      return null;
    }
    await this.database.query("source_files").where({ id: row.id }).update({
      scan_root_key: input.scanRootKey,
      generation_id: input.generationId,
      updated_at: new Date().toISOString(),
    });
    return { ...input, id: String(row.id) };
  }

  /**
   * 按目录批量查询并写入扫描发现的源文件。
   * 一次目录只执行分批 SELECT 与 UPSERT，避免每个视频产生多次 PostgreSQL 往返。
   */
  public async prepareSourceFiles(inputs: SourceFileRecord[]): Promise<PreparedSourceFileRecord[]> {
    if (inputs.length === 0) return [];
    const firstInput = inputs[0]!;
    if (inputs.some((input) => input.userId !== firstInput.userId || input.libraryId !== firstInput.libraryId)) {
      throw new Error("批量准备源文件时混入了不同用户或媒体库");
    }

    // 关键变量：同一目录偶尔可能返回重复资源，只允许一条记录参与批量 Upsert。
    const uniqueInputs = [...new Map(inputs.map((input) => [input.providerResourceId, input])).values()];
    return this.database.query.transaction(async (transaction) => {
      // 同一路径只出现一个当前资源时，资源 ID 变化表示文件被替换；路径相同的旧资源不能继续参与播放。
      const currentResourceIdsByPath = new Map<string, Set<string>>();
      for (const input of uniqueInputs) {
        const resourceIds = currentResourceIdsByPath.get(input.path) ?? new Set<string>();
        resourceIds.add(input.providerResourceId);
        currentResourceIdsByPath.set(input.path, resourceIds);
      }
      const replacementPathSet = new Set<string>();
      const replacedSamePathSourceIds: string[] = [];
      const candidateReplacementPaths = [...currentResourceIdsByPath]
        .filter(([, resourceIds]) => resourceIds.size === 1)
        .map(([filePath]) => filePath);
      for (const pathBatch of chunkStrings(candidateReplacementPaths, 200)) {
        const samePathRows = await transaction("source_files")
          .select("id", "path", "provider_resource_id")
          .where({
            user_id: firstInput.userId,
            service_id: firstInput.serviceId,
            library_id: firstInput.libraryId,
            status: "active",
          })
          .whereIn("path", pathBatch);
        for (const row of samePathRows) {
          const currentResourceIds = currentResourceIdsByPath.get(String(row.path));
          if (!currentResourceIds || currentResourceIds.has(String(row.provider_resource_id))) continue;
          replacementPathSet.add(String(row.path));
          replacedSamePathSourceIds.push(String(row.id));
        }
      }
      for (const sourceFileIdBatch of chunkStrings([...new Set(replacedSamePathSourceIds)], 200)) {
        await transaction("source_files").whereIn("id", sourceFileIdBatch).update({
          status: "missing",
          updated_at: new Date().toISOString(),
        });
      }
      if (replacedSamePathSourceIds.length > 0) {
        this.logger?.("warn", {
          日志关键字: "codex-flycloud-source-replacement",
          事件: "扫描准备阶段停用同路径旧源文件",
          用户ID: firstInput.userId,
          媒体库ID: firstInput.libraryId,
          替换路径数量: replacementPathSet.size,
          被替换源文件数量: new Set(replacedSamePathSourceIds).size,
        });
      }

      const existingRows: Record<string, unknown>[] = [];
      for (const resourceIdBatch of chunkStrings(uniqueInputs.map((input) => input.providerResourceId), 200)) {
        const rows = await transaction("source_files")
          .where({ user_id: firstInput.userId, library_id: firstInput.libraryId })
          .whereIn("provider_resource_id", resourceIdBatch);
        existingRows.push(...rows as Record<string, unknown>[]);
      }
      const existingByResourceId = new Map(existingRows.map((row) => [String(row.provider_resource_id), row]));
      const fingerprintUnchangedByResourceId = new Map<string, boolean>();
      const now = new Date().toISOString();

      for (const input of uniqueInputs) {
        const existing = existingByResourceId.get(input.providerResourceId);
        const locatorJson = JSON.stringify(input.locator);
        fingerprintUnchangedByResourceId.set(input.providerResourceId, Boolean(existing)
          && existing!.status === "active"
          && String(existing!.scan_root_key ?? "") === input.scanRootKey
          && String(existing!.parent_resource_id ?? "") === String(input.parentResourceId ?? "")
          && String(existing!.path) === input.path
          && String(existing!.name) === input.name
          && Number(existing!.size) === input.size
          && String(existing!.modified_at ?? "") === String(input.modifiedAt ?? "")
          && String(existing!.etag ?? "") === String(input.etag ?? "")
          && String(existing!.locator_json) === locatorJson);
      }

      // 关键变量：文件发生变化时立即删除旧规格，开关关闭期间也不能向 Jellyfin 返回过期时长和编码信息。
      const changedExistingSourceIds = uniqueInputs
        .filter((input) => existingByResourceId.has(input.providerResourceId)
          && fingerprintUnchangedByResourceId.get(input.providerResourceId) !== true)
        .map((input) => String(existingByResourceId.get(input.providerResourceId)!.id));
      for (const sourceFileIdBatch of chunkStrings(changedExistingSourceIds, 200)) {
        await transaction("media_file_probes").whereIn("source_file_id", sourceFileIdBatch).delete();
      }

      // 关键变量：只有源文件未变化、已有活动文件关联、已匹配且元数据修订一致时才能复用目录结果。
      const fingerprintUnchangedSourceIds = uniqueInputs
        .filter((input) => fingerprintUnchangedByResourceId.get(input.providerResourceId) === true)
        .map((input) => String(existingByResourceId.get(input.providerResourceId)!.id));
      const reusableRows: Record<string, unknown>[] = [];
      for (const sourceFileIdBatch of chunkStrings(fingerprintUnchangedSourceIds, 200)) {
        const rows = await transaction("file_links as fl")
          .join("media_items as m", "m.id", "fl.item_id")
          .select("fl.source_file_id", "m.id as item_id", "m.match_state", "m.deleted_at")
          .where("fl.user_id", firstInput.userId)
          .where("fl.library_id", firstInput.libraryId)
          .whereIn("fl.source_file_id", sourceFileIdBatch);
        reusableRows.push(...rows as Record<string, unknown>[]);
      }
      const reusableItemIdBySourceFileId = new Map<string, string>();
      for (const row of reusableRows) {
        if (String(row.match_state) !== "matched" || row.deleted_at !== null) continue;
        reusableItemIdBySourceFileId.set(String(row.source_file_id), String(row.item_id));
      }
      const reusableByResourceId = new Map<string, boolean>();
      for (const input of uniqueInputs) {
        const existing = existingByResourceId.get(input.providerResourceId);
        const storedMetadataRevision = Number(existing?.metadata_profile_revision ?? 0);
        const revisionMatches = storedMetadataRevision === 0
          || storedMetadataRevision === input.metadataProfileRevision;
        // 关键变量：历史数据没有识别修订时允许复用一次，之后统一写入当前识别修订。
        const storedRecognitionRevision = String(existing?.recognition_revision ?? "");
        const recognitionRevisionMatches = storedRecognitionRevision.length === 0
          || storedRecognitionRevision === input.recognitionRevision;
        reusableByResourceId.set(input.providerResourceId, Boolean(existing)
          && fingerprintUnchangedByResourceId.get(input.providerResourceId) === true
          && !replacementPathSet.has(input.path)
          && revisionMatches
          && recognitionRevisionMatches
          && reusableItemIdBySourceFileId.has(String(existing!.id)));
      }

      for (let index = 0; index < uniqueInputs.length; index += 200) {
        const inputBatch = uniqueInputs.slice(index, index + 200);
        await transaction("source_files")
          .insert(inputBatch.map((input) => ({
            id: existingByResourceId.has(input.providerResourceId)
              ? String(existingByResourceId.get(input.providerResourceId)!.id)
              : input.id,
            user_id: input.userId,
            service_id: input.serviceId,
            library_id: input.libraryId,
            provider_resource_id: input.providerResourceId,
            parent_resource_id: input.parentResourceId,
            path: input.path,
            name: input.name,
            extension: input.extension,
            size: input.size,
            modified_at: input.modifiedAt,
            etag: input.etag,
            scan_root_key: input.scanRootKey,
            generation_id: input.generationId,
            metadata_profile_revision: existingByResourceId.has(input.providerResourceId)
              ? Number(existingByResourceId.get(input.providerResourceId)!.metadata_profile_revision ?? 0)
              : 0,
            recognition_revision: existingByResourceId.has(input.providerResourceId)
              ? String(existingByResourceId.get(input.providerResourceId)!.recognition_revision ?? "") || null
              : null,
            locator_json: JSON.stringify(input.locator),
            status: "active",
            created_at: now,
            updated_at: now,
          })))
          .onConflict(["user_id", "library_id", "provider_resource_id"])
          .merge([
            "service_id",
            "parent_resource_id",
            "path",
            "name",
            "extension",
            "size",
            "modified_at",
            "etag",
            "scan_root_key",
            "generation_id",
            "locator_json",
            "status",
            "updated_at",
          ]);
      }

      // 全量扫描复用目录结果时，源文件、媒体条目和节目父项都要推进到当前 generation，避免缺失对账误删。
      const reusableInputs = uniqueInputs.filter((input) => reusableByResourceId.get(input.providerResourceId) === true);
      const reusableSourceIds = reusableInputs.map((input) => String(existingByResourceId.get(input.providerResourceId)!.id));
      if (reusableSourceIds.length > 0) {
        await transaction("source_files").whereIn("id", reusableSourceIds).update({
          metadata_profile_revision: firstInput.metadataProfileRevision,
          recognition_revision: firstInput.recognitionRevision,
          updated_at: now,
        });
        const reusableItemIds = [...new Set(reusableSourceIds
          .map((sourceFileId) => reusableItemIdBySourceFileId.get(sourceFileId))
          .filter((itemId): itemId is string => Boolean(itemId)))];
        await transaction("media_items").whereIn("id", reusableItemIds).update({
          generation_id: firstInput.generationId,
          updated_at: now,
          deleted_at: null,
        });
        const parentRows = await transaction("media_relations")
          .distinct("parent_item_id")
          .where({ user_id: firstInput.userId, library_id: firstInput.libraryId })
          .whereIn("child_item_id", reusableItemIds);
        const parentItemIds = parentRows.map((row) => String(row.parent_item_id));
        if (parentItemIds.length > 0) {
          await transaction("media_items").whereIn("id", parentItemIds).update({
            generation_id: firstInput.generationId,
            updated_at: now,
            deleted_at: null,
          });
        }
      }

      return inputs.map((input) => ({
        sourceFile: {
          ...input,
          id: existingByResourceId.has(input.providerResourceId)
            ? String(existingByResourceId.get(input.providerResourceId)!.id)
            : input.id,
        },
        unchanged: reusableByResourceId.get(input.providerResourceId) === true,
        reusedMatchedCatalog: reusableByResourceId.get(input.providerResourceId) === true,
      }));
    });
  }

  /** 批量标记已经成功完成媒体落库的源文件所使用的元数据配置和有效识别修订。 */
  public async markSourceFilesMetadataProcessed(
    sourceFileIds: string[],
    metadataProfileRevision: number,
    recognitionRevision: string,
  ): Promise<void> {
    const uniqueSourceFileIds = [...new Set(sourceFileIds)];
    if (uniqueSourceFileIds.length === 0) return;
    for (const sourceFileIdBatch of chunkStrings(uniqueSourceFileIds, 200)) {
      await this.database.query("source_files").whereIn("id", sourceFileIdBatch).update({
        metadata_profile_revision: metadataProfileRevision,
        recognition_revision: recognitionRevision,
        updated_at: new Date().toISOString(),
      });
    }
  }

  /**
   * 把源文件写入独立媒体规格队列；相同指纹不会重复分析，文件变化后才重新排队。
   * forceFailed 只在用户重新开启开关时使用，允许主动重试历史最终失败项。
   */
  public async enqueueMediaProbes(sourceFiles: SourceFileRecord[], forceFailed = false, options: {
    requestedByUserId?: string;
    triggerType?: "manual_backfill" | "scan_completed" | "retry" | "recovered" | "reauthorized" | "scheduled";
    sourceScanJobId?: string;
  } = {}): Promise<{ queuedCount: number; jobId: string | null }> {
    const uniqueSourceFiles = [...new Map(sourceFiles.map((sourceFile) => [sourceFile.id, sourceFile])).values()];
    if (uniqueSourceFiles.length === 0) return { queuedCount: 0, jobId: null };
    const firstSourceFile = uniqueSourceFiles[0]!;
    if (uniqueSourceFiles.some((sourceFile) => sourceFile.serviceId !== firstSourceFile.serviceId)) {
      throw new Error("媒体规格后台任务不能混入不同服务的源文件");
    }
    return this.database.query.transaction(async (transaction) => {
      const probeJobId = randomUUID();
      const now = new Date().toISOString();
      let queuedCount = 0;
      for (let offset = 0; offset < uniqueSourceFiles.length; offset += 200) {
        const sourceFileBatch = uniqueSourceFiles.slice(offset, offset + 200);
        const existingRows = await transaction("media_file_probes")
          .select("source_file_id", "fingerprint", "status")
          .whereIn("source_file_id", sourceFileBatch.map((sourceFile) => sourceFile.id));
        const existingById = new Map(existingRows.map((row) => [String(row.source_file_id), row]));
        const rows = sourceFileBatch.flatMap((sourceFile) => {
          const fingerprint = createMediaProbeFingerprint(sourceFile);
          const existing = existingById.get(sourceFile.id);
          const sameFingerprint = String(existing?.fingerprint ?? "") === fingerprint;
          const shouldRetryFailed = forceFailed && sameFingerprint && ["failed", "cancelled"].includes(String(existing?.status ?? ""));
          if (sameFingerprint && !shouldRetryFailed) return [];
          return [{
            source_file_id: sourceFile.id,
            user_id: sourceFile.userId,
            service_id: sourceFile.serviceId,
            library_id: sourceFile.libraryId,
            probe_job_id: probeJobId,
            fingerprint,
            status: "pending",
            attempt_count: 0,
            result_json: null,
            error_code: null,
            error_message: null,
            next_retry_at: null,
            started_at: null,
            finished_at: null,
            created_at: existing ? undefined : now,
            updated_at: now,
          }];
        });
        queuedCount += rows.length;
        if (rows.length === 0) continue;
        // 关键变量：批量更新列不包含 created_at，历史规格记录重新入队时保留首次创建时间。
        const mediaProbeUpdateColumns = [
          "user_id", "service_id", "library_id", "probe_job_id", "fingerprint", "status",
          "attempt_count", "result_json", "error_code", "error_message", "next_retry_at",
          "started_at", "finished_at", "updated_at",
        ];
        // 一批只执行一条 UPSERT，避免已有视频较多时逐条更新导致接口长时间不返回、父任务不可见。
        await transaction("media_file_probes")
          .insert(rows.map((row) => ({ ...row, created_at: row.created_at ?? now })))
          .onConflict("source_file_id")
          .merge(mediaProbeUpdateColumns);
      }
      if (queuedCount === 0) return { queuedCount: 0, jobId: null };
      const triggerType = options.triggerType ?? "scan_completed";
      await transaction("media_probe_jobs").insert({
        id: probeJobId,
        user_id: firstSourceFile.userId,
        service_id: firstSourceFile.serviceId,
        library_id: firstSourceFile.libraryId,
        requested_by_user_id: options.requestedByUserId ?? firstSourceFile.userId,
        trigger_type: triggerType,
        status: "queued",
        stage: "queued",
        processed_count: 0,
        total_count: queuedCount,
        error_count: 0,
        current_file_name: null,
        error_code: null,
        error_message: null,
        next_retry_at: null,
        control_action: "none",
        snapshot_json: JSON.stringify({
          triggerType,
          sourceScanJobId: options.sourceScanJobId ?? null,
          retryFailedFiles: forceFailed,
        }),
        created_at: now,
        started_at: null,
        finished_at: null,
        active_duration_ms: 0,
        active_started_at: null,
        updated_at: now,
      });
      return { queuedCount, jobId: probeJobId };
    });
  }

  /** 手动或定时触发时，为该服务已有、变化或历史失败的视频建立独立规格后台任务。 */
  public async enqueueExistingServiceMediaProbes(
    serviceId: string,
    userId: string,
    requestedByUserId = userId,
    triggerType: "manual_backfill" | "scheduled" = "manual_backfill",
  ): Promise<{ queuedCount: number; jobId: string | null }> {
    const rows = await this.database.query("source_files")
      .where({ service_id: serviceId, user_id: userId, status: "active" })
      .orderBy("created_at", "asc");
    const sourceFiles = rows.map((row): SourceFileRecord => ({
      id: String(row.id),
      userId: String(row.user_id),
      serviceId: String(row.service_id),
      libraryId: String(row.library_id),
      providerResourceId: String(row.provider_resource_id),
      parentResourceId: row.parent_resource_id ? String(row.parent_resource_id) : null,
      path: String(row.path),
      name: String(row.name),
      extension: String(row.extension ?? ""),
      size: Number(row.size ?? 0),
      modifiedAt: row.modified_at ? String(row.modified_at) : null,
      etag: row.etag ? String(row.etag) : null,
      scanRootKey: String(row.scan_root_key ?? ""),
      generationId: String(row.generation_id),
      metadataProfileRevision: Number(row.metadata_profile_revision ?? 0),
      recognitionRevision: String(row.recognition_revision ?? ""),
      locator: parseJsonObject(row.locator_json),
    }));
    return this.enqueueMediaProbes(sourceFiles, true, { requestedByUserId, triggerType });
  }

  /**
   * Provider 重新授权成功后，把此前因服务级鉴权失效而中止的文件归入新的规格后台任务。
   * 已成功的规格不会重复分析；该恢复动作沿用失败前的显式任务，不受扫描期间规格开关影响。
   */
  public async recoverMediaProbesAfterReauthorization(
    serviceId: string,
    userId: string,
    requestedByUserId: string,
  ): Promise<{ queuedCount: number; jobId: string | null }> {
    const service = await this.getServiceDetail(serviceId, userId);
    if (service.status !== "active") return { queuedCount: 0, jobId: null };
    const rows = await this.database.query("media_file_probes as p")
      .join("source_files as f", "f.id", "p.source_file_id")
      .select("f.*")
      .where({
        "p.service_id": serviceId,
        "p.user_id": userId,
        "p.error_code": "provider_authentication_failed",
        "f.status": "active",
      })
      .whereIn("p.status", ["failed", "cancelled"])
      .orderBy("p.updated_at", "asc");
    const sourceFiles = rows.map((row): SourceFileRecord => ({
      id: String(row.id),
      userId: String(row.user_id),
      serviceId: String(row.service_id),
      libraryId: String(row.library_id),
      providerResourceId: String(row.provider_resource_id),
      parentResourceId: row.parent_resource_id ? String(row.parent_resource_id) : null,
      path: String(row.path),
      name: String(row.name),
      extension: String(row.extension ?? ""),
      size: Number(row.size ?? 0),
      modifiedAt: row.modified_at ? String(row.modified_at) : null,
      etag: row.etag ? String(row.etag) : null,
      scanRootKey: String(row.scan_root_key ?? ""),
      generationId: String(row.generation_id),
      metadataProfileRevision: Number(row.metadata_profile_revision ?? 0),
      recognitionRevision: String(row.recognition_revision ?? ""),
      locator: parseJsonObject(row.locator_json),
    }));
    return this.enqueueMediaProbes(sourceFiles, true, {
      requestedByUserId,
      triggerType: "reauthorized",
    });
  }

  /** 把已创建的手动规格任务置为等待重新授权，保留全部待处理文件供授权成功后自动领取。 */
  public async waitMediaProbeJobForReauthorization(jobId: string, userId?: string): Promise<ScanJobRecord> {
    const job = await this.getJob(jobId, userId);
    if (job.jobType !== "media_probe") throw new ApiError(409, "background_job_type_mismatch", "当前任务不是视频规格任务");
    await this.database.query("media_probe_jobs").where({ id: job.id, status: "queued" }).update({
      status: "retry_waiting",
      error_code: "provider_authentication_failed",
      error_message: "Provider 登录已失效，等待 APP 同步有效登录信息后自动继续",
      next_retry_at: null,
      updated_at: new Date().toISOString(),
    });
    return this.getJob(job.id, userId);
  }

  /**
   * 服务级鉴权失效时一次性停止该服务的全部规格任务，避免对每个视频重复请求已经失效的 Token。
   * 文件保留为可恢复状态，APP 同步有效凭据后会自动建立新的规格后台任务。
   */
  public async failMediaProbeJobsForAuthentication(serviceId: string, userId: string): Promise<string[]> {
    const now = new Date().toISOString();
    return this.database.query.transaction(async (transaction) => {
      const jobRows = await transaction("media_probe_jobs")
        .where({ service_id: serviceId, user_id: userId })
        .whereIn("status", ["queued", "running", "retry_waiting"])
        .select("id", "status", "active_duration_ms", "active_started_at") as Array<ActiveDurationRow & { id: string }>;
      const jobIds = jobRows.map((row) => String(row.id));
      if (jobIds.length > 0) {
        await transaction("media_file_probes")
          .whereIn("probe_job_id", jobIds)
          .whereIn("status", ["pending", "running", "retry_waiting"])
          .update({
            status: "cancelled",
            error_code: "provider_authentication_failed",
            error_message: "Provider 登录已失效，等待重新授权后恢复",
            next_retry_at: null,
            finished_at: now,
            updated_at: now,
          });
        for (const jobRow of jobRows) {
          await transaction("media_probe_jobs").where({ id: jobRow.id }).update({
            status: "failed",
            error_code: "provider_authentication_failed",
            error_message: "Provider 登录已失效，请重新授权；授权成功后会自动恢复未完成文件",
            current_file_name: null,
            next_retry_at: null,
            control_action: "none",
            finished_at: now,
            active_duration_ms: calculateActiveDurationMs(jobRow, Date.parse(now)),
            active_started_at: null,
            updated_at: now,
          });
        }
      }
      await transaction("cloud_services").where({ id: serviceId, user_id: userId }).update({
        status: "reauthorization_required",
        connection_status: "reauthorization_required",
        updated_at: now,
      });
      return jobIds;
    });
  }

  /** 启动恢复时识别上次已经确认的鉴权失败，立即阻止服务继续逐文件重试失效凭据。 */
  public async restoreMediaProbeAuthenticationFailures(): Promise<number> {
    const serviceRows = await this.database.query("media_file_probes as p")
      .join("cloud_services as s", "s.id", "p.service_id")
      .distinct("p.service_id", "p.user_id")
      .where({ "p.error_code": "provider_authentication_failed" })
      .whereIn("p.status", ["failed", "retry_waiting"])
      // 已经等待重新授权的服务可能包含用户后来手动创建的等待任务，重启时不能把它再次改成失败。
      .whereNot("s.status", "reauthorization_required");
    for (const serviceRow of serviceRows) {
      await this.failMediaProbeJobsForAuthentication(String(serviceRow.service_id), String(serviceRow.user_id));
    }
    return serviceRows.length;
  }

  /** 将升级前没有父任务的待处理规格记录归入服务级恢复任务。 */
  public async adoptUnassignedMediaProbeJobs(): Promise<number> {
    const serviceRows = await this.database.query("media_file_probes")
      .distinct("service_id", "user_id", "library_id")
      .whereNull("probe_job_id")
      .whereIn("status", ["pending", "running", "retry_waiting"]);
    let createdJobCount = 0;
    for (const serviceRow of serviceRows) {
      await this.database.query.transaction(async (transaction) => {
        const now = new Date().toISOString();
        const probeJobId = randomUUID();
        const probeRows = await transaction("media_file_probes")
          .select("source_file_id")
          .where({ service_id: serviceRow.service_id })
          .whereNull("probe_job_id")
          .whereIn("status", ["pending", "running", "retry_waiting"]);
        if (probeRows.length === 0) return;
        await transaction("media_probe_jobs").insert({
          id: probeJobId,
          user_id: serviceRow.user_id,
          service_id: serviceRow.service_id,
          library_id: serviceRow.library_id,
          requested_by_user_id: serviceRow.user_id,
          trigger_type: "recovered",
          status: "queued",
          stage: "queued",
          processed_count: 0,
          total_count: probeRows.length,
          error_count: 0,
          current_file_name: null,
          error_code: null,
          error_message: null,
          next_retry_at: null,
          control_action: "none",
          snapshot_json: JSON.stringify({ triggerType: "recovered", sourceScanJobId: null, retryFailedFiles: false }),
          created_at: now,
          started_at: null,
          finished_at: null,
          active_duration_ms: 0,
          active_started_at: null,
          updated_at: now,
        });
        await transaction("media_file_probes")
          .whereIn("source_file_id", probeRows.map((row) => String(row.source_file_id)))
          .update({ probe_job_id: probeJobId, status: "pending", next_retry_at: null, updated_at: now });
        createdJobCount += 1;
      });
    }
    return createdJobCount;
  }

  /** 汇总单个规格后台任务的文件状态，并推进父任务进度或终态。 */
  public async synchronizeMediaProbeJob(
    jobId: string,
    currentFileName: string | null = null,
  ): Promise<MediaProbeSynchronizationResult | null> {
    const jobRow = await this.database.query("media_probe_jobs").where({ id: jobId }).first() as MediaProbeJobRow | undefined;
    if (!jobRow) return null;
    const statusRows = await this.database.query("media_file_probes")
      .select("status")
      .count<{ status: string; count: string | number }[]>({ count: "source_file_id" })
      .where({ probe_job_id: jobId })
      .groupBy("status");
    const counts = new Map(statusRows.map((row) => [String(row.status), Number(row.count ?? 0)]));
    const completedCount = counts.get("completed") ?? 0;
    const failedCount = counts.get("failed") ?? 0;
    const cancelledCount = counts.get("cancelled") ?? 0;
    const pendingCount = counts.get("pending") ?? 0;
    const runningCount = counts.get("running") ?? 0;
    const retryWaitingCount = counts.get("retry_waiting") ?? 0;
    const processedCount = completedCount + failedCount;
    const totalCount = Number(jobRow.total_count ?? 0);
    const now = new Date().toISOString();
    const patch: Record<string, unknown> = {
      processed_count: processedCount,
      error_count: failedCount,
      current_file_name: currentFileName,
      updated_at: now,
    };
    if (jobRow.status !== "paused" && jobRow.status !== "cancelled" && jobRow.status !== "failed") {
      const remainingCount = pendingCount + runningCount + retryWaitingCount;
      if (remainingCount === 0 && processedCount + cancelledCount >= totalCount) {
        patch.status = cancelledCount > 0 && processedCount === 0 ? "cancelled" : "completed";
        patch.stage = "completed";
        patch.finished_at = now;
        patch.current_file_name = null;
        patch.next_retry_at = null;
        patch.active_duration_ms = calculateActiveDurationMs(jobRow, Date.parse(now));
        patch.active_started_at = null;
      } else if (runningCount > 0 || pendingCount > 0) {
        patch.status = "running";
        patch.stage = "probing";
        patch.started_at = jobRow.started_at ?? now;
        patch.active_started_at = jobRow.active_started_at ?? now;
        patch.next_retry_at = null;
      } else if (retryWaitingCount > 0) {
        const nextRetryRow = await this.database.query("media_file_probes")
          .min<{ next_retry_at: string | null }[]>({ next_retry_at: "next_retry_at" })
          .where({ probe_job_id: jobId, status: "retry_waiting" })
          .first();
        patch.status = "retry_waiting";
        patch.stage = "probing";
        patch.next_retry_at = nextRetryRow?.next_retry_at ?? null;
        patch.active_duration_ms = calculateActiveDurationMs(jobRow, Date.parse(now));
        patch.active_started_at = null;
      }
    }
    // 关键变量：限定旧状态可防止并发文件完成时重复宣告父任务完成，也避免较早的进度覆盖终态。
    const changed = await this.database.query("media_probe_jobs")
      .where({ id: jobId, status: jobRow.status })
      .update(patch);
    const completedNow = patch.status === "completed" && changed === 1;
    const updated = await this.mediaProbeJobSummaryQuery().where("j.id", jobId).first() as MediaProbeJobRow | undefined;
    return updated ? { job: mapMediaProbeJob(updated), completedNow, completedFileCount: completedCount } : null;
  }

  /** 返回规格后台任务的失败文件，用于任务详情定位 Provider 或媒体异常。 */
  public async listMediaProbeJobFailures(jobId: string, userId?: string): Promise<MediaProbeFailureRecord[]> {
    const job = await this.getJob(jobId, userId);
    if (job.jobType !== "media_probe") return [];
    const rows = await this.database.query("media_file_probes as p")
      .join("source_files as f", "f.id", "p.source_file_id")
      .select("p.source_file_id", "f.name", "p.error_code", "p.error_message")
      .where({ "p.probe_job_id": job.id, "p.status": "failed" })
      .orderBy("p.updated_at", "desc")
      .limit(500);
    return rows.map((row) => ({
      sourceFileId: String(row.source_file_id),
      fileName: String(row.name ?? "未知文件"),
      errorCode: String(row.error_code ?? "media_probe_failed"),
      errorMessage: String(row.error_code ?? "") === "provider_authentication_failed"
        ? "Provider 登录已失效，请重新授权；授权成功后会自动恢复"
        : String(row.error_message ?? "媒体规格分析失败"),
    }));
  }

  /** 为失败或已取消的规格后台任务重新建立一个只包含未成功文件的新任务。 */
  public async retryMediaProbeJob(jobId: string, userId: string | undefined, requestedByUserId: string): Promise<ScanJobRecord> {
    const job = await this.getJob(jobId, userId);
    if (job.jobType !== "media_probe" || !(["completed", "failed", "cancelled"] as JobStatus[]).includes(job.status)) {
      throw new ApiError(409, "background_job_not_retryable", "当前后台任务不能重试");
    }
    const rows = await this.database.query("media_file_probes as p")
      .join("source_files as f", "f.id", "p.source_file_id")
      .select("f.*")
      .where("p.probe_job_id", job.id)
      .whereIn("p.status", ["failed", "cancelled"])
      .where("f.status", "active");
    const sourceFiles = rows.map((row): SourceFileRecord => ({
      id: String(row.id), userId: String(row.user_id), serviceId: String(row.service_id), libraryId: String(row.library_id),
      providerResourceId: String(row.provider_resource_id), parentResourceId: row.parent_resource_id ? String(row.parent_resource_id) : null,
      path: String(row.path), name: String(row.name), extension: String(row.extension ?? ""), size: Number(row.size ?? 0),
      modifiedAt: row.modified_at ? String(row.modified_at) : null, etag: row.etag ? String(row.etag) : null,
      scanRootKey: String(row.scan_root_key ?? ""), generationId: String(row.generation_id),
      metadataProfileRevision: Number(row.metadata_profile_revision ?? 0), recognitionRevision: String(row.recognition_revision ?? ""),
      locator: parseJsonObject(row.locator_json),
    }));
    const result = await this.enqueueMediaProbes(sourceFiles, true, {
      requestedByUserId,
      triggerType: "retry",
      sourceScanJobId: job.id,
    });
    if (!result.jobId) throw new ApiError(409, "background_job_has_no_failed_files", "当前后台任务没有可重试的失败文件");
    return this.getJob(result.jobId, job.userId);
  }

  /** upsert 扫描发现的源文件并返回稳定记录。 */
  public async upsertSourceFile(input: SourceFileRecord): Promise<SourceFileRecord> {
    const now = new Date().toISOString();
    await this.database.query("source_files")
      .insert({
        id: input.id,
        user_id: input.userId,
        service_id: input.serviceId,
        library_id: input.libraryId,
        provider_resource_id: input.providerResourceId,
        parent_resource_id: input.parentResourceId,
        path: input.path,
        name: input.name,
        extension: input.extension,
        size: input.size,
        modified_at: input.modifiedAt,
        etag: input.etag,
        scan_root_key: input.scanRootKey,
        generation_id: input.generationId,
        metadata_profile_revision: 0,
        locator_json: JSON.stringify(input.locator),
        status: "active",
        created_at: now,
        updated_at: now,
      })
      .onConflict(["user_id", "library_id", "provider_resource_id"])
      .merge({
        parent_resource_id: input.parentResourceId,
        path: input.path,
        name: input.name,
        extension: input.extension,
        size: input.size,
        modified_at: input.modifiedAt,
        etag: input.etag,
        scan_root_key: input.scanRootKey,
        generation_id: input.generationId,
        locator_json: JSON.stringify(input.locator),
        status: "active",
        updated_at: now,
      });
    const row = await this.database.query("source_files").where({
      user_id: input.userId,
      library_id: input.libraryId,
      provider_resource_id: input.providerResourceId,
    }).first();
    return {
      ...input,
      id: String(row.id),
    };
  }

  /** upsert 媒体条目并返回条目内容是否发生真实变化。 */
  public async upsertMediaItem(input: {
    id: string;
    userId: string;
    serviceId: string;
    libraryId: string;
    identityKey: string;
    mediaType: MediaType;
    itemType: string;
    title: string;
    sortTitle: string;
    subtitle: string;
    year: number | null;
    overview: string;
    posterUrl: string | null;
    backdropUrl: string | null;
    matchState: MatchState;
    externalIds: Record<string, string>;
    metadata: Record<string, unknown>;
    generationId: string;
  }): Promise<{ itemId: string; changed: boolean; hasManualMatch: boolean; itemType: string }> {
    const existing = await this.database.query("media_items").where({
      user_id: input.userId,
      library_id: input.libraryId,
      identity_key: input.identityKey,
    }).first();
    const itemId = existing ? String(existing.id) : input.id;
    const existingMetadata = existing ? parseJsonObject(existing.metadata_json) : {};
    const hasManualMatch = Object.keys(asObject(existingMetadata.manualMatch)).length > 0;
    // 关键变量：音乐平台偶发缺图时保留上一轮已成功取得的歌曲、专辑或艺术家图片。
    const artworkPreservingInput = existing && input.mediaType === "music" ? {
      ...input,
      posterUrl: input.posterUrl || (existing.poster_url ? String(existing.poster_url) : null),
      backdropUrl: input.backdropUrl || (existing.backdrop_url ? String(existing.backdrop_url) : null),
    } : input;
    // 关键变量：人工匹配结果优先于后续自动扫描，但扫描仍刷新 generation，避免条目被全量扫描误删。
    const effectiveInput = hasManualMatch && existing ? {
      ...artworkPreservingInput,
      mediaType: existing.media_type as MediaType,
      itemType: String(existing.item_type),
      title: String(existing.title),
      sortTitle: String(existing.sort_title),
      subtitle: String(existing.subtitle),
      year: existing.year === null || existing.year === undefined ? null : Number(existing.year),
      overview: String(existing.overview),
      posterUrl: existing.poster_url ? String(existing.poster_url) : null,
      backdropUrl: existing.backdrop_url ? String(existing.backdrop_url) : null,
      matchState: existing.match_state as MatchState,
      externalIds: Object.fromEntries(Object.entries(parseJsonObject(existing.external_ids_json)).map(([key, value]) => [key, String(value)])),
      metadata: existingMetadata,
    } : artworkPreservingInput;
    const externalIdsJson = JSON.stringify(effectiveInput.externalIds);
    const metadataJson = JSON.stringify(effectiveInput.metadata);
    const regionGroup = readVideoRegionGroup(effectiveInput.itemType, effectiveInput.metadata);
    const premiereDate = readMediaPremiereDate(effectiveInput.metadata);
    const changed = !existing
      || existing.deleted_at !== null
      || String(existing.media_type) !== effectiveInput.mediaType
      || String(existing.item_type) !== effectiveInput.itemType
      || String(existing.region_group ?? "other") !== regionGroup
      || String(existing.title) !== effectiveInput.title
      || String(existing.sort_title) !== effectiveInput.sortTitle
      || String(existing.subtitle) !== effectiveInput.subtitle
      || (existing.year === null ? null : Number(existing.year)) !== effectiveInput.year
      || String(existing.premiere_date ?? "") !== String(premiereDate ?? "")
      || String(existing.overview) !== effectiveInput.overview
      || String(existing.poster_url ?? "") !== String(effectiveInput.posterUrl ?? "")
      || String(existing.backdrop_url ?? "") !== String(effectiveInput.backdropUrl ?? "")
      || String(existing.match_state) !== effectiveInput.matchState
      || String(existing.external_ids_json) !== externalIdsJson
      || String(existing.metadata_json) !== metadataJson;
    const now = new Date().toISOString();
    await this.database.query("media_items")
      .insert({
        id: itemId,
        user_id: input.userId,
        service_id: input.serviceId,
        library_id: input.libraryId,
        identity_key: input.identityKey,
        media_type: effectiveInput.mediaType,
        item_type: effectiveInput.itemType,
        region_group: regionGroup,
        title: effectiveInput.title,
        sort_title: effectiveInput.sortTitle,
        subtitle: effectiveInput.subtitle,
        year: effectiveInput.year,
        premiere_date: premiereDate,
        overview: effectiveInput.overview,
        poster_url: effectiveInput.posterUrl,
        backdrop_url: effectiveInput.backdropUrl,
        match_state: effectiveInput.matchState,
        external_ids_json: externalIdsJson,
        metadata_json: metadataJson,
        generation_id: input.generationId,
        created_at: now,
        updated_at: now,
        deleted_at: null,
      })
      .onConflict(["user_id", "library_id", "identity_key"])
      .merge({
        media_type: effectiveInput.mediaType,
        item_type: effectiveInput.itemType,
        region_group: regionGroup,
        title: effectiveInput.title,
        sort_title: effectiveInput.sortTitle,
        subtitle: effectiveInput.subtitle,
        year: effectiveInput.year,
        premiere_date: premiereDate,
        overview: effectiveInput.overview,
        poster_url: effectiveInput.posterUrl,
        backdrop_url: effectiveInput.backdropUrl,
        match_state: effectiveInput.matchState,
        external_ids_json: externalIdsJson,
        metadata_json: metadataJson,
        generation_id: input.generationId,
        updated_at: now,
        deleted_at: null,
      });
    if (hasManualMatch && effectiveInput.itemType === "video.series") {
      const childIds = await this.database.query("media_relations")
        .select("child_item_id")
        .where({ user_id: input.userId, parent_item_id: itemId });
      if (childIds.length > 0) {
        await this.database.query("media_items")
          .whereIn("id", childIds.map((row) => String(row.child_item_id)))
          .update({ generation_id: input.generationId, updated_at: now, deleted_at: null });
      }
    }
    return { itemId, changed, hasManualMatch, itemType: effectiveInput.itemType };
  }

  /**
   * 关联媒体条目与源文件定位。
   * 返回发生文件归属或同路径替换的条目 ID；同一个媒体库内一个源文件始终只能归属一个条目。
   */
  public async linkItemFile(input: {
    userId: string;
    libraryId: string;
    itemId: string;
    sourceFileId: string;
    locator: Record<string, unknown>;
    /** Worker 已读取目标条目时直接复用，避免每个单集再次查询同一行。 */
    targetItemType?: string;
    targetHasManualMatch?: boolean;
  }): Promise<string[]> {
    return this.database.query.transaction(async (transaction) => {
      let targetItemId = input.itemId;
      const shouldReadTargetItem = input.targetItemType === undefined || input.targetHasManualMatch === undefined;
      const targetRow = shouldReadTargetItem
        ? await transaction("media_items").select("item_type", "metadata_json").where({
          id: input.itemId,
          user_id: input.userId,
          library_id: input.libraryId,
        }).first()
        : undefined;
      const targetItemType = input.targetItemType ?? String(targetRow?.item_type ?? "");
      const targetHasManualMatch = input.targetHasManualMatch
        ?? Object.keys(asObject(parseJsonObject(targetRow?.metadata_json).manualMatch)).length > 0;
      if (targetItemType === "video.series" && targetHasManualMatch) {
        // 人工把电影纠正成节目后，同一源文件后续扫描仍继续关联到已经创建的单集。
        const episodeLink = await transaction("media_relations as mr")
          .join("file_links as fl", "fl.item_id", "mr.child_item_id")
          .select("mr.child_item_id")
          .where("mr.user_id", input.userId)
          .where("mr.parent_item_id", input.itemId)
          .where("fl.source_file_id", input.sourceFileId)
          .first();
        if (episodeLink) targetItemId = String(episodeLink.child_item_id);
      }

      const currentSourceRow = await transaction("source_files")
        .select("path")
        .where({
          id: input.sourceFileId,
          user_id: input.userId,
          library_id: input.libraryId,
        })
        .first();
      // 同一条目下路径相同但资源 ID 不同，表示网盘文件被替换；其他路径仍是独立媒体版本。
      const replacedSamePathRows = currentSourceRow
        ? await transaction("file_links as fl")
          .join("source_files as f", "f.id", "fl.source_file_id")
          .select("fl.id as file_link_id", "fl.source_file_id")
          .where({
            "fl.user_id": input.userId,
            "fl.library_id": input.libraryId,
            "fl.item_id": targetItemId,
            "f.path": String(currentSourceRow.path),
          })
          .whereNot("fl.source_file_id", input.sourceFileId)
        : [];
      if (replacedSamePathRows.length > 0) {
        const replacedLinkIds = replacedSamePathRows.map((row) => String(row.file_link_id));
        const replacedSourceFileIds = replacedSamePathRows.map((row) => String(row.source_file_id));
        await transaction("file_links").whereIn("id", replacedLinkIds).delete();
        await transaction("source_files").whereIn("id", replacedSourceFileIds).update({
          status: "missing",
          updated_at: new Date().toISOString(),
        });
        this.logger?.("warn", {
          日志关键字: "codex-flycloud-source-replacement",
          事件: "扫描发现同路径新文件并停用旧源文件",
          用户ID: input.userId,
          媒体库ID: input.libraryId,
          媒体条目ID: targetItemId,
          新源文件ID: input.sourceFileId,
          被替换源文件数量: replacedSourceFileIds.length,
        });
      }

      // 关键变量：旧条目 ID 用于扫描收尾清理空条目并推进 APP 可见的目录版本。
      const previousRows = await transaction("file_links")
        .distinct("item_id")
        .where({
          user_id: input.userId,
          library_id: input.libraryId,
          source_file_id: input.sourceFileId,
        })
        .whereNot({ item_id: targetItemId });
      const previousItemIds = previousRows.map((row) => String(row.item_id));
      if (previousItemIds.length > 0) {
        await transaction("file_links").where({
          user_id: input.userId,
          library_id: input.libraryId,
          source_file_id: input.sourceFileId,
        }).whereNot({ item_id: targetItemId }).delete();
      }
      await transaction("file_links")
        .insert({
          id: randomUUID(),
          user_id: input.userId,
          library_id: input.libraryId,
          item_id: targetItemId,
          source_file_id: input.sourceFileId,
          locator_json: JSON.stringify(input.locator),
        })
        .onConflict(["user_id", "item_id", "source_file_id"])
        .merge({ locator_json: JSON.stringify(input.locator) });
      return [...new Set([
        ...previousItemIds,
        ...(replacedSamePathRows.length > 0 ? [targetItemId] : []),
      ])];
    });
  }

  /** 创建父子或领域关系，并返回因人工电影归属覆盖而失去文件的旧条目 ID。 */
  public async linkMediaRelation(input: {
    userId: string;
    libraryId: string;
    parentItemId: string;
    childItemId: string;
    relationType: string;
    sortOrder: number;
    /** Worker 已读取父条目时直接复用，避免每个单集再次查询同一节目。 */
    parentItemType?: string;
    parentHasManualMatch?: boolean;
  }): Promise<string[]> {
    const shouldReadParentItem = input.parentItemType === undefined || input.parentHasManualMatch === undefined;
    const parentRow = shouldReadParentItem
      ? await this.database.query("media_items").select("item_type", "metadata_json").where({
        id: input.parentItemId,
        user_id: input.userId,
        library_id: input.libraryId,
      }).first()
      : undefined;
    const parentItemType = input.parentItemType ?? String(parentRow?.item_type ?? "");
    const parentHasManualMatch = input.parentHasManualMatch
      ?? Object.keys(asObject(parseJsonObject(parentRow?.metadata_json).manualMatch)).length > 0;
    if (parentItemType === "video.movie" && parentHasManualMatch) {
      // 人工把节目纠正成电影后，扫描到的单集文件继续汇总到电影条目，不重新生成节目关系。
      const childLinks = await this.database.query("file_links").select("source_file_id", "locator_json").where({
        user_id: input.userId,
        library_id: input.libraryId,
        item_id: input.childItemId,
      });
      const previousItemIds = new Set<string>();
      for (const childLink of childLinks) {
        const replacedItemIds = await this.linkItemFile({
          userId: input.userId,
          libraryId: input.libraryId,
          itemId: input.parentItemId,
          sourceFileId: String(childLink.source_file_id),
          locator: parseJsonObject(childLink.locator_json),
          targetItemType: parentItemType,
          targetHasManualMatch: parentHasManualMatch,
        });
        replacedItemIds.forEach((itemId) => previousItemIds.add(itemId));
      }
      return [...previousItemIds];
    }
    // 单集、曲目和章节只能属于一个同类型父项；解析规则修正后先移除旧父关系，避免海报墙残留错误节目。
    await this.database.query("media_relations").where({
      user_id: input.userId,
      library_id: input.libraryId,
      child_item_id: input.childItemId,
      relation_type: input.relationType,
    }).whereNot({ parent_item_id: input.parentItemId }).delete();
    await this.database.query("media_relations")
      .insert({
        id: randomUUID(),
        user_id: input.userId,
        library_id: input.libraryId,
        parent_item_id: input.parentItemId,
        child_item_id: input.childItemId,
        relation_type: input.relationType,
        sort_order: input.sortOrder,
      })
      .onConflict(["user_id", "parent_item_id", "child_item_id", "relation_type"])
      .merge({ sort_order: input.sortOrder });
    return [];
  }

  /** 原子替换音乐艺术家与专辑、歌曲的关系，支持同一歌曲后续扩展为多艺术家。 */
  public async replaceMusicArtistRelations(input: {
    userId: string;
    libraryId: string;
    artistItemIds: string[];
    albumItemId: string | null;
    trackItemId: string;
  }): Promise<void> {
    // 关键变量：艺术家编号去重后同时用于删除过期关系和写入本轮关系。
    const artistItemIds = [...new Set(input.artistItemIds.filter(Boolean))];
    await this.database.query.transaction(async (transaction) => {
      if (input.albumItemId) {
        const albumRelations = transaction("media_relations").where({
          user_id: input.userId,
          library_id: input.libraryId,
          child_item_id: input.albumItemId,
          relation_type: "artist_album",
        });
        if (artistItemIds.length > 0) albumRelations.whereNotIn("parent_item_id", artistItemIds);
        await albumRelations.delete();
      }
      const trackRelations = transaction("media_relations").where({
        user_id: input.userId,
        library_id: input.libraryId,
        child_item_id: input.trackItemId,
        relation_type: "artist_track",
      });
      if (artistItemIds.length > 0) trackRelations.whereNotIn("parent_item_id", artistItemIds);
      await trackRelations.delete();
      for (const [index, artistItemId] of artistItemIds.entries()) {
        if (input.albumItemId) {
          await transaction("media_relations").insert({
            id: randomUUID(), user_id: input.userId, library_id: input.libraryId,
            parent_item_id: artistItemId, child_item_id: input.albumItemId,
            relation_type: "artist_album", sort_order: index,
          }).onConflict(["user_id", "parent_item_id", "child_item_id", "relation_type"]).merge({ sort_order: index });
        }
        await transaction("media_relations").insert({
          id: randomUUID(), user_id: input.userId, library_id: input.libraryId,
          parent_item_id: artistItemId, child_item_id: input.trackItemId,
          relation_type: "artist_track", sort_order: index,
        }).onConflict(["user_id", "parent_item_id", "child_item_id", "relation_type"]).merge({ sort_order: index });
      }
    });
  }

  /** 在成功 generation 后执行扫描结果对账并推进目录版本。 */
  public async finalizeGeneration(input: {
    userId: string;
    serviceId: string;
    libraryId: string;
    generationId: string;
    /** 只允许这些完整扫描根推进缺失状态。 */
    completedRootGenerations: Array<{ rootKey: string; generationId: string }>;
    deleteMissing: boolean;
    /** 枚举不完整时为 false，禁止执行任何可能删除已有目录内容的清理。 */
    allowDestructiveCleanup: boolean;
    changedItemIds: string[];
  }): Promise<{
    catalogVersion: number;
    missingSourceCount: number;
    updatedMissingItemCount: number;
    deletedMissingItemCount: number;
    deletedOrphanLeafCount: number;
    deletedOrphanParentCount: number;
  }> {
    return this.database.query.transaction(async (transaction) => {
      const now = new Date().toISOString();
      const missingGenerationResult = input.deleteMissing
        ? await this.cleanupCompletedRootMissingFiles(
          transaction,
          input.userId,
          input.libraryId,
          input.completedRootGenerations,
          now,
        )
        : { missingSourceCount: 0, affectedItemIds: [], deletedItemIds: [] };
      // Flymby APP 在任一目录枚举失败后跳过本轮过期清理，避免把未访问目录中的旧数据误删。
      const excludedItemIds = input.allowDestructiveCleanup
        ? await this.cleanupExcludedCatalogPaths(transaction, input.userId, input.libraryId, now)
        : [];
      // 文件改归属是精确写入，不依赖目录枚举完整性；即使某个目录有警告，也可以安全清理真正无文件的旧条目。
      const orphanLeafIds = await this.cleanupOrphanCatalogLeaves(
        transaction,
        input.userId,
        input.libraryId,
        now,
      );
      const orphanParentIds = input.allowDestructiveCleanup || input.deleteMissing || orphanLeafIds.length > 0
        ? await this.cleanupOrphanCatalogParents(transaction, input.userId, input.libraryId, now)
        : [];
      const library = await transaction("media_libraries").where({ id: input.libraryId, user_id: input.userId }).first();
      if (!library) throw new ApiError(404, "library_not_found", "媒体库不存在");
      const previousCatalogVersion = Number(library.catalog_version);
      const deletedItemIds = new Set([
        ...missingGenerationResult.deletedItemIds,
        ...excludedItemIds,
        ...orphanLeafIds,
        ...orphanParentIds,
      ]);
      // 缺失的只是某个播放版本时条目仍然存在，也必须写入 upsert，让 APP 重新同步剩余版本。
      const changedItemIds = [...new Set([
        ...input.changedItemIds,
        ...missingGenerationResult.affectedItemIds,
      ])].filter((itemId) => !deletedItemIds.has(itemId));
      const changes = [
        ...changedItemIds.map((entityId) => ({ entityId, changeType: "upsert" })),
        ...[...deletedItemIds].map((entityId) => ({ entityId, changeType: "delete" })),
      ];
      const catalogVersion = previousCatalogVersion + changes.length;
      await transaction("media_libraries").where({ id: input.libraryId }).update({ catalog_version: catalogVersion, updated_at: now });
      if (changes.length > 0) {
        for (let offset = 0; offset < changes.length; offset += CATALOG_CHANGE_INSERT_BATCH_SIZE) {
          const changeBatch = changes.slice(offset, offset + CATALOG_CHANGE_INSERT_BATCH_SIZE);
          await transaction("catalog_changes").insert(changeBatch.map((change, batchIndex) => ({
            user_id: input.userId,
            library_id: input.libraryId,
            // 每条变化使用独立版本，afterVersion 分页不会跳过同一扫描批次的剩余条目。
            catalog_version: previousCatalogVersion + offset + batchIndex + 1,
            entity_type: "media_item",
            entity_id: change.entityId,
            change_type: change.changeType,
            created_at: now,
          })));
        }
      }
      await transaction("cloud_services").where({ id: input.serviceId }).update({ last_scan_at: now, updated_at: now });
      return {
        catalogVersion,
        missingSourceCount: missingGenerationResult.missingSourceCount,
        updatedMissingItemCount: missingGenerationResult.affectedItemIds.length
          - missingGenerationResult.deletedItemIds.length,
        deletedMissingItemCount: missingGenerationResult.deletedItemIds.length,
        deletedOrphanLeafCount: orphanLeafIds.length,
        deletedOrphanParentCount: orphanParentIds.length,
      };
    });
  }

  /** 只把完整扫描根中未出现在本 generation 的源文件标记缺失，并软删除无活动文件条目。 */
  private async cleanupCompletedRootMissingFiles(
    transaction: Knex.Transaction,
    userId: string,
    libraryId: string,
    completedRoots: Array<{ rootKey: string; generationId: string }>,
    now: string,
  ): Promise<{ missingSourceCount: number; affectedItemIds: string[]; deletedItemIds: string[] }> {
    const missingSourceIds: string[] = [];
    for (const root of completedRoots) {
      const rows = await transaction("source_files")
        .select("id")
        .where({
          user_id: userId,
          library_id: libraryId,
          scan_root_key: root.rootKey,
          status: "active",
        })
        .whereNot({ generation_id: root.generationId });
      missingSourceIds.push(...rows.map((row) => String(row.id)));
    }
    if (missingSourceIds.length === 0) {
      return { missingSourceCount: 0, affectedItemIds: [], deletedItemIds: [] };
    }

    const linkedItemIds: string[] = [];
    for (const sourceIdChunk of chunkStrings([...new Set(missingSourceIds)])) {
      const linkedRows = await transaction("file_links")
        .distinct("item_id")
        .whereIn("source_file_id", sourceIdChunk);
      linkedItemIds.push(...linkedRows.map((row) => String(row.item_id)));
      await transaction("source_files").whereIn("id", sourceIdChunk).update({ status: "missing", updated_at: now });
    }
    const candidateItemIds = [...new Set(linkedItemIds)];
    if (candidateItemIds.length === 0) {
      return {
        missingSourceCount: new Set(missingSourceIds).size,
        affectedItemIds: [],
        deletedItemIds: [],
      };
    }

    const activeItemIds = new Set<string>();
    for (const itemIdChunk of chunkStrings(candidateItemIds)) {
      const activeRows = await transaction("file_links as fl")
        .join("source_files as f", "f.id", "fl.source_file_id")
        .distinct("fl.item_id")
        .whereIn("fl.item_id", itemIdChunk)
        .where("f.status", "active");
      activeRows.forEach((row) => activeItemIds.add(String(row.item_id)));
    }
    const deletedItemIds = candidateItemIds.filter((itemId) => !activeItemIds.has(itemId));
    for (const itemIdChunk of chunkStrings(deletedItemIds)) {
      await transaction("media_items")
        .whereIn("id", itemIdChunk)
        .whereNull("deleted_at")
        .update({ deleted_at: now, updated_at: now });
    }
    return {
      missingSourceCount: new Set(missingSourceIds).size,
      affectedItemIds: candidateItemIds,
      deletedItemIds,
    };
  }

  /** 把 APP 默认排除目录中的旧扫描文件标记缺失，并软删除已经没有活动文件的媒体条目。 */
  private async cleanupExcludedCatalogPaths(
    transaction: Knex.Transaction,
    userId: string,
    libraryId: string,
    now: string,
  ): Promise<string[]> {
    const sourceRows = await transaction("source_files")
      .select("id", "path")
      .where({ user_id: userId, library_id: libraryId, status: "active" });
    const excludedSourceIds = sourceRows
      .filter((row) => isFlymbyExcludedPath(String(row.path)))
      .map((row) => String(row.id));
    if (excludedSourceIds.length === 0) return [];
    const linkedRows: Array<{ item_id: unknown }> = [];
    for (const sourceIdChunk of chunkStrings(excludedSourceIds)) {
      await transaction("source_files").whereIn("id", sourceIdChunk).update({ status: "missing", updated_at: now });
      linkedRows.push(...await transaction("file_links").distinct("item_id").whereIn("source_file_id", sourceIdChunk));
    }
    const candidateItemIds = linkedRows.map((row) => String(row.item_id));
    if (candidateItemIds.length === 0) return [];
    const activeRows: Array<{ item_id: unknown }> = [];
    for (const itemIdChunk of chunkStrings(candidateItemIds)) {
      activeRows.push(...await transaction("file_links as fl")
        .join("source_files as f", "f.id", "fl.source_file_id")
        .distinct("fl.item_id")
        .whereIn("fl.item_id", itemIdChunk)
        .where("f.status", "active"));
    }
    const activeItemIds = new Set(activeRows.map((row) => String(row.item_id)));
    const deletedItemIds = [...new Set(candidateItemIds)].filter((itemId) => !activeItemIds.has(itemId));
    for (const itemIdChunk of chunkStrings(deletedItemIds)) {
      await transaction("media_items").whereIn("id", itemIdChunk).whereNull("deleted_at").update({ deleted_at: now, updated_at: now });
    }
    return deletedItemIds;
  }

  /** 删除已经没有活动源文件的电影、单集、曲目和章节，并解除残留父子关系。 */
  private async cleanupOrphanCatalogLeaves(
    transaction: Knex.Transaction,
    userId: string,
    libraryId: string,
    now: string,
  ): Promise<string[]> {
    const leafRows = await transaction("media_items")
      .select("id")
      .where({ user_id: userId, library_id: libraryId })
      .whereIn("item_type", ["video.movie", "video.episode", "music.track", "audiobook.chapter"])
      .whereNull("deleted_at");
    const leafIds = leafRows.map((row) => String(row.id));
    if (leafIds.length === 0) return [];

    const activeItemIds = new Set<string>();
    for (const leafIdChunk of chunkStrings(leafIds)) {
      const activeRows = await transaction("file_links as fl")
        .join("source_files as f", "f.id", "fl.source_file_id")
        .distinct("fl.item_id")
        .whereIn("fl.item_id", leafIdChunk)
        .where("f.status", "active");
      activeRows.forEach((row) => activeItemIds.add(String(row.item_id)));
    }
    const orphanLeafIds = leafIds.filter((itemId) => !activeItemIds.has(itemId));
    for (const orphanIdChunk of chunkStrings(orphanLeafIds)) {
      await transaction("media_items")
        .whereIn("id", orphanIdChunk)
        .whereNull("deleted_at")
        .update({ deleted_at: now, updated_at: now });
      await transaction("media_relations")
        .whereIn("child_item_id", orphanIdChunk)
        .orWhereIn("parent_item_id", orphanIdChunk)
        .delete();
    }
    return orphanLeafIds;
  }

  /** 删除已经没有活动子项且自身没有活动文件的旧节目、专辑或有声书父项。 */
  private async cleanupOrphanCatalogParents(
    transaction: Knex.Transaction,
    userId: string,
    libraryId: string,
    now: string,
  ): Promise<string[]> {
    const parentRows = await transaction("media_items")
      .select("id")
      .where({ user_id: userId, library_id: libraryId })
      .whereIn("item_type", ["video.series", "music.album", "music.artist", "audiobook.book"])
      .whereNull("deleted_at");
    const parentIds = parentRows.map((row) => String(row.id));
    if (parentIds.length === 0) return [];
    const childRows: Array<{ parent_item_id: unknown }> = [];
    const fileRows: Array<{ item_id: unknown }> = [];
    for (const parentIdChunk of chunkStrings(parentIds)) {
      const [childChunk, fileChunk] = await Promise.all([
        transaction("media_relations as r")
          .join("media_items as c", "c.id", "r.child_item_id")
          .distinct("r.parent_item_id")
          .whereIn("r.parent_item_id", parentIdChunk)
          .whereNull("c.deleted_at"),
        transaction("file_links as fl")
          .join("source_files as f", "f.id", "fl.source_file_id")
          .distinct("fl.item_id")
          .whereIn("fl.item_id", parentIdChunk)
          .where("f.status", "active"),
      ]);
      childRows.push(...childChunk);
      fileRows.push(...fileChunk);
    }
    const parentsWithChildren = new Set(childRows.map((row) => String(row.parent_item_id)));
    const parentsWithFiles = new Set(fileRows.map((row) => String(row.item_id)));
    const orphanIds = parentIds.filter((itemId) => !parentsWithChildren.has(itemId) && !parentsWithFiles.has(itemId));
    for (const orphanIdChunk of chunkStrings(orphanIds)) {
      await transaction("media_items").whereIn("id", orphanIdChunk).whereNull("deleted_at").update({ deleted_at: now, updated_at: now });
    }
    return orphanIds;
  }

  /** 查询当前用户媒体目录，管理端可省略用户并增加服务筛选。 */
  public async listCatalogItems(filters: {
    userId?: string;
    serviceId?: string;
    libraryId?: string;
    itemIds?: string[];
    mediaType?: MediaType;
    itemType?: string;
    matchState?: MatchState;
    categoryKey?: string;
    genre?: string;
    genres?: string[];
    regionGroup?: VideoRegionGroup;
    search?: string;
    sort: CatalogSort;
    limit: number;
    offset: number;
    includeFileCounts?: boolean;
  }): Promise<{ items: MediaItemRecord[]; total: number }> {
    const base = this.database.query("media_items as m")
      .join("cloud_services as s", "s.id", "m.service_id")
      .join("user_accounts as u", "u.id", "s.user_id")
      .whereNull("m.deleted_at")
      .whereNull("s.deleted_at");
    if (filters.userId) base.where("m.user_id", filters.userId);
    if (filters.serviceId) base.where("m.service_id", filters.serviceId);
    if (filters.libraryId) base.where("m.library_id", filters.libraryId);
    if (filters.itemIds && filters.itemIds.length > 0) base.whereIn("m.id", filters.itemIds);
    if (filters.mediaType) base.where("m.media_type", filters.mediaType);
    if (filters.itemType) {
      base.where("m.item_type", filters.itemType);
    } else if (filters.mediaType === "music") {
      // 音乐媒体库默认以专辑为入口，歌曲和艺术家通过显式分类筛选查看。
      base.where("m.item_type", "music.album");
    } else {
      // 通用海报墙不直接展示单集和歌曲；对应分类页可通过 itemType 明确请求。
      base.whereNotIn("m.item_type", ["video.episode", "music.track"]);
    }
    if (filters.regionGroup) base.where("m.region_group", filters.regionGroup);
    if (filters.matchState) base.where("m.match_state", filters.matchState);
    if (filters.categoryKey === "unrecognized") base.whereNot("m.match_state", "matched");
    if (filters.genre) base.whereLike("m.metadata_json", `%${filters.genre}%`);
    if (filters.genres && filters.genres.length > 0) {
      // 关键变量：Jellyfin GenreIds 多选按“任一分类命中”处理，保持分类列表和条目筛选一致。
      base.where((builder) => {
        filters.genres?.forEach((genre) => builder.orWhereLike("m.metadata_json", `%${genre}%`));
      });
    }
    if (filters.categoryKey && filters.categoryKey !== "unrecognized") {
      // 关键变量：分类筛选始终排除未匹配条目，避免普通分类页混入待更正内容。
      base.where("m.match_state", "matched");
      if (filters.categoryKey === "movie") base.where("m.item_type", "video.movie");
      if (filters.categoryKey === "tv") base.where("m.item_type", "video.series");
      if (filters.categoryKey === "anime") {
        base.where((builder) => builder
          .whereLike("m.metadata_json", "%动画%")
          .orWhereLike("m.metadata_json", "%Animation%"));
      }
      if (filters.categoryKey === "variety") {
        base.where("m.item_type", "video.series").where((builder) => builder
          .whereLike("m.metadata_json", "%真人秀%")
          .orWhereLike("m.metadata_json", "%访谈%")
          .orWhereLike("m.metadata_json", "%脱口秀%")
          .orWhereLike("m.metadata_json", "%Reality%")
          .orWhereLike("m.metadata_json", "%Talk%"));
      }
      if (filters.categoryKey === "documentary") {
        base.where((builder) => builder
          .whereLike("m.metadata_json", "%纪录片%")
          .orWhereLike("m.metadata_json", "%Documentary%"));
      }
    }
    if (filters.search) {
      base.where((builder) => {
        builder.whereLike("m.title", `%${filters.search}%`).orWhereLike("m.subtitle", `%${filters.search}%`);
      });
    }
    // cloud_services 和 user_accounts 都是一对一连接，不需要 DISTINCT 产生额外临时表。
    const countRow = await base.clone().count<{ count: string | number }[]>({ count: "m.id" }).first();
    const rowsQuery = base.clone()
      .select("m.*", "u.username as owner_username", "s.display_name as service_name");
    // 所有排序都追加稳定主键，避免同年、同日或同名条目跨页时重复或遗漏。
    if (filters.sort === "title_asc" || filters.sort === "title_desc") {
      rowsQuery.orderBy("m.sort_title", filters.sort === "title_asc" ? "asc" : "desc").orderBy("m.id", "asc");
    } else if (filters.sort === "year_desc" || filters.sort === "year_asc") {
      rowsQuery.orderByRaw(`?? IS NULL ASC, ?? ${filters.sort === "year_asc" ? "ASC" : "DESC"}, ?? ASC`,
        ["m.year", "m.year", "m.id"]);
    } else if (filters.sort === "premiere_date_desc" || filters.sort === "premiere_date_asc") {
      rowsQuery.orderByRaw(
        `?? IS NULL ASC, ?? ${filters.sort === "premiere_date_asc" ? "ASC" : "DESC"}, ?? ASC`,
        ["m.premiere_date", "m.premiere_date", "m.id"],
      );
    } else if (filters.sort === "updated_desc" || filters.sort === "updated_asc") {
      rowsQuery.orderBy("m.updated_at", filters.sort === "updated_asc" ? "asc" : "desc").orderBy("m.id", "asc");
    } else if (filters.sort === "created_asc") {
      rowsQuery.orderBy("m.created_at", "asc").orderBy("m.id", "asc");
    } else {
      rowsQuery.orderBy("m.created_at", "desc").orderBy("m.id", "asc");
    }
    // 关键变量：排序和分页必须全部追加后再执行，不能先 await 成数组。
    const rows = await rowsQuery.limit(filters.limit).offset(filters.offset);
    const [fileCounts, mediaProbeSummaries] = await Promise.all([
      filters.includeFileCounts === false ? Promise.resolve(new Map<string, number>()) : this.loadCatalogFileCounts(rows),
      this.loadCatalogMediaProbeSummaries(rows),
    ]);
    return {
      items: rows.map((row) => this.mapMediaItem({
        ...row,
        file_count: fileCounts.get(String(row.id)) ?? 0,
        media_probe_summary: mediaProbeSummaries.get(String(row.id)) ?? null,
      })),
      total: Number(countRow?.count ?? 0),
    };
  }

  /** 查询媒体条目详情并强制用户作用域。 */
  public async getCatalogItem(itemId: string, userId?: string): Promise<MediaItemRecord> {
    const query = this.database.query("media_items as m")
      .join("cloud_services as s", "s.id", "m.service_id")
      .join("user_accounts as u", "u.id", "s.user_id")
      .select("m.*", "u.username as owner_username", "s.display_name as service_name")
      .where("m.id", itemId)
      .whereNull("m.deleted_at")
      .whereNull("s.deleted_at");
    if (userId) query.where("m.user_id", userId);
    const row = await query.first();
    if (!row) throw new ApiError(404, "media_item_not_found", "媒体条目不存在");
    const [fileCounts, mediaProbeSummaries] = await Promise.all([
      this.loadCatalogFileCounts([row]),
      this.loadCatalogMediaProbeSummaries([row]),
    ]);
    return this.mapMediaItem({
      ...row,
      file_count: fileCounts.get(String(row.id)) ?? 0,
      media_probe_summary: mediaProbeSummaries.get(String(row.id)) ?? null,
    });
  }

  /** 批量统计条目自身及其子项关联的源文件数，避免相关子查询反复扫描完整关联表。 */
  private async loadCatalogFileCounts(rows: Record<string, unknown>[]): Promise<Map<string, number>> {
    const fileIdsByItem = new Map<string, Set<string>>();
    // 关键变量：按用户分组后查询，确保能够使用 user_id 开头的现有复合索引。
    const itemIdsByUser = new Map<string, string[]>();
    rows.forEach((row) => {
      const userId = String(row.user_id);
      const itemId = String(row.id);
      const itemIds = itemIdsByUser.get(userId) ?? [];
      itemIds.push(itemId);
      itemIdsByUser.set(userId, itemIds);
      fileIdsByItem.set(itemId, new Set<string>());
    });

    for (const [userId, itemIds] of itemIdsByUser) {
      for (const itemIdChunk of chunkStrings(itemIds)) {
        const [directRows, childRows] = await Promise.all([
          this.database.query("file_links")
            .select("item_id", "source_file_id")
            .where("user_id", userId)
            .whereIn("item_id", itemIdChunk),
          this.database.query("media_relations as mr")
            .join("file_links as fl", function joinChildFileLinks() {
              this.on("fl.user_id", "=", "mr.user_id")
                .andOn("fl.item_id", "=", "mr.child_item_id");
            })
            .select("mr.parent_item_id as item_id", "fl.source_file_id")
            .where("mr.user_id", userId)
            .whereIn("mr.parent_item_id", itemIdChunk),
        ]);
        [...directRows, ...childRows].forEach((fileRow) => {
          fileIdsByItem.get(String(fileRow.item_id))?.add(String(fileRow.source_file_id));
        });
      }
    }

    return new Map([...fileIdsByItem].map(([itemId, fileIds]) => [itemId, fileIds.size]));
  }

  /** 批量汇总条目自身及直接子项已经完成的媒体规格，避免海报墙逐条查询。 */
  private async loadCatalogMediaProbeSummaries(rows: Record<string, unknown>[]): Promise<Map<string, MediaProbeSummaryRecord>> {
    const probeResultsByItem = new Map<string, Map<string, MediaProbeResult>>();
    // 关键变量：保持与文件数量相同的父子归属口径，节目海报才能汇总其全部单集的分析进度。
    const itemIdsByUser = new Map<string, string[]>();
    rows.forEach((row) => {
      const userId = String(row.user_id);
      const itemId = String(row.id);
      const itemIds = itemIdsByUser.get(userId) ?? [];
      itemIds.push(itemId);
      itemIdsByUser.set(userId, itemIds);
      probeResultsByItem.set(itemId, new Map<string, MediaProbeResult>());
    });
    for (const [userId, itemIds] of itemIdsByUser) {
      for (const itemIdChunk of chunkStrings(itemIds)) {
        const [directRows, childRows] = await Promise.all([
          this.database.query("file_links as fl")
            .join("source_files as f", "f.id", "fl.source_file_id")
            .join("media_file_probes as p", "p.source_file_id", "f.id")
            .select("fl.item_id as item_id", "fl.source_file_id", "p.result_json")
            .where("fl.user_id", userId)
            .where("f.status", "active")
            .where("p.status", "completed")
            .whereIn("fl.item_id", itemIdChunk),
          this.database.query("media_relations as mr")
            .join("file_links as fl", function joinChildProbeFileLinks() {
              this.on("fl.user_id", "=", "mr.user_id")
                .andOn("fl.item_id", "=", "mr.child_item_id");
            })
            .join("source_files as f", "f.id", "fl.source_file_id")
            .join("media_file_probes as p", "p.source_file_id", "f.id")
            .select("mr.parent_item_id as item_id", "fl.source_file_id", "p.result_json")
            .where("mr.user_id", userId)
            .where("f.status", "active")
            .where("p.status", "completed")
            .whereIn("mr.parent_item_id", itemIdChunk),
        ]);
        [...directRows, ...childRows].forEach((probeRow) => {
          const result = parseMediaProbeResult(probeRow.result_json);
          if (!result) return;
          probeResultsByItem.get(String(probeRow.item_id))?.set(String(probeRow.source_file_id), result);
        });
      }
    }
    const summaries = new Map<string, MediaProbeSummaryRecord>();
    probeResultsByItem.forEach((probeResults, itemId) => {
      const summary = buildMediaProbeSummary([...probeResults.values()]);
      if (summary) summaries.set(itemId, summary);
    });
    return summaries;
  }

  /** 映射数据库媒体行。 */
  private mapMediaItem(row: Record<string, unknown>): MediaItemRecord {
    return {
      id: String(row.id),
      userId: String(row.user_id),
      serviceId: String(row.service_id),
      libraryId: String(row.library_id),
      mediaType: row.media_type as MediaType,
      itemType: String(row.item_type),
      regionGroup: String(row.region_group ?? "other") as VideoRegionGroup,
      title: String(row.title),
      sortTitle: String(row.sort_title),
      subtitle: String(row.subtitle),
      year: row.year === null || row.year === undefined ? null : Number(row.year),
      premiereDate: row.premiere_date ? String(row.premiere_date) : null,
      overview: String(row.overview),
      posterUrl: row.poster_url ? String(row.poster_url) : null,
      backdropUrl: row.backdrop_url ? String(row.backdrop_url) : null,
      matchState: row.match_state as MatchState,
      externalIds: Object.fromEntries(Object.entries(parseJsonObject(row.external_ids_json)).map(([key, value]) => [key, String(value)])),
      metadata: parseJsonObject(row.metadata_json),
      fileCount: Number(row.file_count ?? 0),
      mediaProbeSummary: row.media_probe_summary && typeof row.media_probe_summary === "object"
        ? row.media_probe_summary as MediaProbeSummaryRecord
        : null,
      ownerUsername: String(row.owner_username),
      serviceName: String(row.service_name),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  /** 查询媒体条目子项关系。 */
  public async listCatalogChildren(itemId: string, userId?: string): Promise<MediaItemRecord[]> {
    const parent = await this.getCatalogItem(itemId, userId);
    const relationRows = await this.database.query("media_relations").select("child_item_id").where({ parent_item_id: itemId }).orderBy("sort_order", "asc");
    const childIds = relationRows.map((row) => String(row.child_item_id));
    if (childIds.length === 0) return [];
    const childRows = await this.database.query("media_items as m")
      .join("cloud_services as s", "s.id", "m.service_id")
      .join("user_accounts as u", "u.id", "s.user_id")
      .select("m.*", "u.username as owner_username", "s.display_name as service_name")
      .where("m.user_id", parent.userId)
      .whereIn("m.id", childIds)
      .whereNull("m.deleted_at")
      .whereNull("s.deleted_at");
    const [fileCounts, mediaProbeSummaries] = await Promise.all([
      this.loadCatalogFileCounts(childRows),
      this.loadCatalogMediaProbeSummaries(childRows),
    ]);
    const childrenById = new Map(childRows.map((row) => [String(row.id), this.mapMediaItem({
      ...row,
      file_count: fileCounts.get(String(row.id)) ?? 0,
      media_probe_summary: mediaProbeSummaries.get(String(row.id)) ?? null,
    })]));
    // 关键变量：数据库批量查询不保证 IN 条件顺序，返回时恢复媒体关系中的季集排序。
    return childIds.flatMap((childId) => {
      const child = childrenById.get(childId);
      return child ? [child] : [];
    });
  }

  /** 查询音乐专辑或歌曲反向关联的艺术家，不把艺术家混入原有子项列表。 */
  public async listCatalogMusicArtists(itemId: string, userId?: string): Promise<MediaItemRecord[]> {
    const item = await this.getCatalogItem(itemId, userId);
    if (item.itemType !== "music.album" && item.itemType !== "music.track") return [];
    const relationType = item.itemType === "music.album" ? "artist_album" : "artist_track";
    const relationRows = await this.database.query("media_relations")
      .select("parent_item_id")
      .where({
        user_id: item.userId,
        library_id: item.libraryId,
        child_item_id: itemId,
        relation_type: relationType,
      })
      .orderBy("sort_order", "asc");
    const artistIds = relationRows.map((row) => String(row.parent_item_id));
    if (artistIds.length === 0) return [];
    const artistRows = await this.database.query("media_items as m")
      .join("cloud_services as s", "s.id", "m.service_id")
      .join("user_accounts as u", "u.id", "s.user_id")
      .select("m.*", "u.username as owner_username", "s.display_name as service_name")
      .where("m.user_id", item.userId)
      .where("m.library_id", item.libraryId)
      .where("m.item_type", "music.artist")
      .whereIn("m.id", artistIds)
      .whereNull("m.deleted_at")
      .whereNull("s.deleted_at");
    const artistsById = new Map(artistRows.map((row) => [String(row.id), this.mapMediaItem({
      ...row,
      file_count: 0,
      media_probe_summary: null,
    })]));
    // 关键变量：多艺术家专辑按关系顺序返回，数据库 IN 查询自身不保证顺序。
    return artistIds.flatMap((artistId) => {
      const artist = artistsById.get(artistId);
      return artist ? [artist] : [];
    });
  }

  /** 读取当前条目及其直接子项关联的源文件，返回值不包含播放定位和凭据。 */
  public async listCatalogItemPaths(itemId: string, userId?: string): Promise<CatalogPathRow[]> {
    const item = await this.getCatalogItem(itemId, userId);
    const rows = await this.readLinkedSourceRows(this.database.query, itemId, item.userId);
    const uniqueRows = new Map<string, CatalogPathRow>();
    for (const row of rows) {
      if (uniqueRows.has(row.source_file_id)) continue;
      uniqueRows.set(row.source_file_id, {
        fileId: row.source_file_id,
        resourceId: row.provider_resource_id,
        linkedItemId: row.linked_item_id,
        linkedItemTitle: String(row.linked_item_title ?? ""),
        path: row.path,
        name: row.name,
        size: Number(row.size ?? 0),
        modifiedAt: row.modified_at ? String(row.modified_at) : null,
        mediaProbe: parseMediaProbeResult(row.media_probe_result_json),
      });
    }
    return [...uniqueRows.values()];
  }

  /** 批量读取多个顶层电影或节目及其直接子项的活动源文件，避免 AI 补充逐条查询数据库。 */
  public async listAiSupplementCatalogPaths(
    itemIds: string[],
    userId: string,
  ): Promise<Map<string, CatalogPathRow[]>> {
    const uniqueItemIds = [...new Set(itemIds.filter(Boolean))];
    const emptyResult = new Map(uniqueItemIds.map((itemId) => [itemId, [] as CatalogPathRow[]]));
    if (uniqueItemIds.length === 0) return emptyResult;

    const relationRows: Array<{ parent_item_id: string; child_item_id: string }> = [];
    for (const itemIdChunk of chunkStrings(uniqueItemIds)) {
      const rows = await this.database.query("media_relations")
        .select("parent_item_id", "child_item_id")
        .where({ user_id: userId })
        .whereIn("parent_item_id", itemIdChunk);
      relationRows.push(...rows.map((row) => ({
        parent_item_id: String(row.parent_item_id),
        child_item_id: String(row.child_item_id),
      })));
    }

    // 关键变量：电影源文件直接挂在顶层条目，节目源文件通常挂在其直接单集子项。
    const parentItemIdByLinkedItemId = new Map<string, string>(uniqueItemIds.map((itemId) => [itemId, itemId]));
    for (const relation of relationRows) {
      parentItemIdByLinkedItemId.set(relation.child_item_id, relation.parent_item_id);
    }
    const linkedItemIds = [...parentItemIdByLinkedItemId.keys()];
    const linkedRows: LinkedSourceRow[] = [];
    for (const linkedItemIdChunk of chunkStrings(linkedItemIds)) {
      const rows = await this.database.query("file_links as fl")
        .join("source_files as f", "f.id", "fl.source_file_id")
        .join("media_items as linked", "linked.id", "fl.item_id")
        .select(
          "fl.id as file_link_id",
          "fl.item_id as linked_item_id",
          "fl.source_file_id",
          "fl.locator_json",
          "f.locator_json as source_locator_json",
          "f.provider_resource_id",
          "f.path",
          "f.name",
          "f.size",
          "f.modified_at",
          "p.status as media_probe_status",
          "p.result_json as media_probe_result_json",
          "linked.title as linked_item_title",
        )
        .leftJoin("media_file_probes as p", "p.source_file_id", "f.id")
        .where("fl.user_id", userId)
        .whereIn("fl.item_id", linkedItemIdChunk)
        .where("f.status", "active")
        .orderBy("f.path", "asc");
      linkedRows.push(...rows as LinkedSourceRow[]);
    }

    const uniqueRowsByParentItemId = new Map<string, Map<string, CatalogPathRow>>();
    for (const row of linkedRows) {
      const parentItemId = parentItemIdByLinkedItemId.get(String(row.linked_item_id));
      if (!parentItemId) continue;
      const uniqueRows = uniqueRowsByParentItemId.get(parentItemId) ?? new Map<string, CatalogPathRow>();
      if (!uniqueRows.has(String(row.source_file_id))) {
        uniqueRows.set(String(row.source_file_id), {
          fileId: String(row.source_file_id),
          resourceId: String(row.provider_resource_id),
          linkedItemId: String(row.linked_item_id),
          linkedItemTitle: String(row.linked_item_title ?? ""),
          path: String(row.path),
          name: String(row.name),
          size: Number(row.size ?? 0),
          modifiedAt: row.modified_at ? String(row.modified_at) : null,
          mediaProbe: parseMediaProbeResult(row.media_probe_result_json),
        });
      }
      uniqueRowsByParentItemId.set(parentItemId, uniqueRows);
    }
    for (const itemId of uniqueItemIds) {
      emptyResult.set(itemId, [...(uniqueRowsByParentItemId.get(itemId)?.values() ?? [])]);
    }
    return emptyResult;
  }

  /** 将打开详情时实时读取的 TMDB 完整信息合并回顶层电影或节目。 */
  public async applyRealtimeVideoDetails(input: {
    itemId: string;
    userId: string;
    metadata: TmdbVideoMetadata;
  }): Promise<MediaItemRecord> {
    const item = await this.getCatalogItem(input.itemId, input.userId);
    if (item.mediaType !== "video" || (item.itemType !== "video.movie" && item.itemType !== "video.series")) {
      return item;
    }
    const now = new Date().toISOString();
    await this.database.query.transaction(async (transaction) => {
      const row = await transaction("media_items")
        .where({ id: input.itemId, user_id: input.userId })
        .whereNull("deleted_at")
        .first();
      if (!row) throw new ApiError(404, "media_item_not_found", "媒体条目不存在");
      const currentMetadata = parseJsonObject(row.metadata_json);
      const currentExternalIds = parseJsonObject(row.external_ids_json);
      // 关键变量：只补充 TMDB 详情字段，保留扫描识别、人工匹配和文件技术信息。
      const nextMetadata: Record<string, unknown> = {
        ...currentMetadata,
        originalTitle: input.metadata.originalTitle,
        releaseDate: input.metadata.releaseDate,
        rating: input.metadata.rating,
        genres: input.metadata.genres,
        people: input.metadata.people,
        logoUrl: input.metadata.logoUrl,
        episodeCount: input.metadata.episodeCount,
        originCountries: input.metadata.originCountries,
        matchedQuery: input.metadata.matchedQuery,
        candidateCount: input.metadata.candidateCount,
        tmdbDetailsSynchronized: true,
        tmdbArtworkSynchronized: true,
        tmdbDetailsSynchronizedAt: now,
      };
      await transaction("media_items").where({ id: input.itemId, user_id: input.userId }).update({
        title: input.metadata.title || String(row.title),
        sort_title: input.metadata.title || String(row.sort_title),
        year: input.metadata.year,
        premiere_date: input.metadata.releaseDate || null,
        overview: input.metadata.overview,
        poster_url: input.metadata.posterUrl,
        backdrop_url: input.metadata.backdropUrl,
        external_ids_json: JSON.stringify({ ...currentExternalIds, tmdb: String(input.metadata.id) }),
        metadata_json: JSON.stringify(nextMetadata),
        region_group: readVideoRegionGroup(String(row.item_type), nextMetadata),
        updated_at: now,
      });
      await this.recordCatalogItemChanges(transaction, input.userId, String(row.library_id), [input.itemId], now);
    });
    return this.getCatalogItem(input.itemId, input.userId);
  }

  /** 将 AI 补充取得的元数据写回未匹配顶层条目，并按最终类型重建电影或节目结构。 */
  public async applyAiSupplementVideoMatch(input: {
    itemId: string;
    userId: string;
    mediaType: "movie" | "tv";
    title: string;
    subtitle: string;
    year: number | null;
    overview: string;
    posterUrl: string | null;
    backdropUrl: string | null;
    externalIds: Record<string, string>;
    metadata: Record<string, unknown>;
  }): Promise<boolean> {
    return this.database.query.transaction(async (transaction) => {
      const row = await transaction("media_items")
        .where({ id: input.itemId, user_id: input.userId })
        .whereNull("deleted_at")
        .first();
      if (!row) throw new ApiError(404, "media_item_not_found", "媒体条目不存在");
      // 关键变量：任务运行期间如果条目已被其他操作匹配，不允许 AI 补充覆盖较新的结果。
      if (String(row.match_state) === "matched") return false;
      const sourceRows = await this.readLinkedSourceRows(transaction, input.itemId, input.userId);
      // 关键变量：最终类型以元数据匹配结果为准，用于真正纠正规则误判的电影或节目结构。
      const nextItemType = input.mediaType === "tv" ? "video.series" : "video.movie";
      const now = new Date().toISOString();
      const changedItemIds = await this.rebuildManualVideoStructure(
        transaction,
        row,
        nextItemType,
        sourceRows,
        null,
        input.title,
        now,
      );
      const currentMetadata = parseJsonObject(row.metadata_json);
      const currentExternalIds = parseJsonObject(row.external_ids_json);
      const nextMetadata = {
        ...currentMetadata,
        ...input.metadata,
        aiSupplementedAt: now,
        aiSupplementedOriginalItemType: String(row.item_type),
        aiSupplementedMediaType: input.mediaType,
      };
      await transaction("media_items").where({ id: input.itemId, user_id: input.userId }).update({
        item_type: nextItemType,
        title: input.title,
        sort_title: input.title,
        subtitle: input.subtitle,
        year: input.year,
        premiere_date: readMediaPremiereDate(nextMetadata) ?? row.premiere_date ?? null,
        overview: input.overview,
        poster_url: input.posterUrl,
        backdrop_url: input.backdropUrl,
        match_state: "matched",
        external_ids_json: JSON.stringify({ ...currentExternalIds, ...input.externalIds }),
        metadata_json: JSON.stringify(nextMetadata),
        region_group: readVideoRegionGroup(nextItemType, nextMetadata),
        updated_at: now,
      });
      await this.recordCatalogItemChanges(
        transaction,
        input.userId,
        String(row.library_id),
        [input.itemId, ...changedItemIds],
        now,
      );
      this.logger?.("info", {
        日志关键字: "codex-flycloud-helper-ai-clean",
        事件: "AI补充影视类型结构写入完成",
        媒体条目ID: input.itemId,
        原条目类型: String(row.item_type),
        最终条目类型: nextItemType,
        是否纠正媒体类型: String(row.item_type) !== nextItemType,
        关联结构变更数量: changedItemIds.length,
      });
      return true;
    });
  }

  /** 将 Jellyfin 协议实时读取的 TMDB 单集信息合并回单集目录记录。 */
  public async applyRealtimeEpisodeDetails(input: {
    itemId: string;
    userId: string;
    metadata: TmdbEpisodeMetadata;
    overviewLanguage: string;
    overviewFallbackChecked: boolean;
  }): Promise<MediaItemRecord> {
    const item = await this.getCatalogItem(input.itemId, input.userId);
    if (item.mediaType !== "video" || item.itemType !== "video.episode") return item;
    const now = new Date().toISOString();
    await this.database.query.transaction(async (transaction) => {
      const row = await transaction("media_items")
        .where({ id: input.itemId, user_id: input.userId })
        .whereNull("deleted_at")
        .first();
      if (!row) throw new ApiError(404, "media_item_not_found", "媒体条目不存在");
      const currentMetadata = parseJsonObject(row.metadata_json);
      const currentExternalIds = parseJsonObject(row.external_ids_json);
      // 关键变量：只补全单集刮削字段，保留文件识别结果、节目关系和媒体规格信息。
      const nextMetadata: Record<string, unknown> = {
        ...currentMetadata,
        seasonNumber: input.metadata.seasonNumber,
        episodeNumber: input.metadata.episodeNumber,
        airDate: input.metadata.airDate,
        rating: input.metadata.rating,
        durationMs: input.metadata.durationMs,
        tmdbEpisodeId: input.metadata.id,
        tmdbEpisodeDetailsSynchronized: true,
        tmdbEpisodeDetailsSynchronizedAt: now,
        tmdbEpisodeOverviewLanguage: input.overviewLanguage,
        tmdbEpisodeOverviewFallbackChecked: input.overviewFallbackChecked,
      };
      await transaction("media_items").where({ id: input.itemId, user_id: input.userId }).update({
        title: input.metadata.title || String(row.title),
        premiere_date: input.metadata.airDate || row.premiere_date || null,
        overview: input.metadata.overview,
        poster_url: input.metadata.stillUrl || row.poster_url || null,
        external_ids_json: JSON.stringify({
          ...currentExternalIds,
          ...(input.metadata.id > 0 ? { tmdb: String(input.metadata.id) } : {}),
        }),
        metadata_json: JSON.stringify(nextMetadata),
        updated_at: now,
      });
      await this.recordCatalogItemChanges(transaction, input.userId, String(row.library_id), [input.itemId], now);
    });
    return this.getCatalogItem(input.itemId, input.userId);
  }

  /** 将用户选择的 TMDB 电影或节目元数据覆盖到当前顶层影视条目。 */
  public async applyManualVideoMatch(input: {
    itemId: string;
    userId: string;
    metadata: TmdbVideoMetadata;
  }): Promise<MediaItemRecord> {
    const item = await this.getCatalogItem(input.itemId, input.userId);
    this.requireManualMatchableVideo(item);
    await this.database.query.transaction(async (transaction) => {
      const row = await transaction("media_items")
        .where({ id: input.itemId, user_id: input.userId })
        .whereNull("deleted_at")
        .first();
      if (!row) throw new ApiError(404, "media_item_not_found", "媒体条目不存在");
      const sourceRows = await this.readLinkedSourceRows(transaction, input.itemId, input.userId);
      // 关键变量：首次手动匹配前的本地识别快照，用于清除匹配时恢复未匹配状态。
      const original = await this.buildManualMatchSnapshot(transaction, row, sourceRows);
      const nextItemType = input.metadata.mediaType === "tv" ? "video.series" : "video.movie";
      const now = new Date().toISOString();
      const changedItemIds = await this.rebuildManualVideoStructure(
        transaction,
        row,
        nextItemType,
        sourceRows,
        input.metadata,
        input.metadata.title,
        now,
      );
      const nextMetadata: Record<string, unknown> = {
        ...original.metadata,
        originalTitle: input.metadata.originalTitle,
        releaseDate: input.metadata.releaseDate,
        rating: input.metadata.rating,
        genres: input.metadata.genres,
        people: input.metadata.people,
        logoUrl: input.metadata.logoUrl,
        episodeCount: input.metadata.episodeCount,
        originCountries: input.metadata.originCountries,
        matchedQuery: input.metadata.matchedQuery,
        candidateCount: input.metadata.candidateCount,
        tmdbDetailsSynchronized: input.metadata.detailsSynchronized,
        tmdbArtworkSynchronized: input.metadata.detailsSynchronized,
        manualMatch: {
          source: "tmdb",
          tmdbId: input.metadata.id,
          mediaType: input.metadata.mediaType,
          appliedAt: now,
          original,
        },
      };
      await transaction("media_items").where({ id: input.itemId, user_id: input.userId }).update({
        item_type: nextItemType,
        title: input.metadata.title,
        sort_title: input.metadata.title,
        subtitle: input.metadata.originalTitle || (input.metadata.mediaType === "tv" ? "节目" : "电影"),
        year: input.metadata.year,
        premiere_date: input.metadata.releaseDate || null,
        overview: input.metadata.overview,
        poster_url: input.metadata.posterUrl,
        backdrop_url: input.metadata.backdropUrl,
        match_state: "matched",
        external_ids_json: JSON.stringify({ tmdb: String(input.metadata.id) }),
        metadata_json: JSON.stringify(nextMetadata),
        region_group: readVideoRegionGroup(nextItemType, nextMetadata),
        updated_at: now,
      });
      await this.recordCatalogItemChanges(transaction, input.userId, String(row.library_id), [input.itemId, ...changedItemIds], now);
    });
    return this.getCatalogItem(input.itemId, input.userId);
  }

  /** 清除自动或手动刮削结果，并恢复文件名和目录推导出的本地影视信息。 */
  public async clearVideoMatch(itemId: string, userId: string): Promise<MediaItemRecord> {
    const item = await this.getCatalogItem(itemId, userId);
    this.requireManualMatchableVideo(item);
    await this.database.query.transaction(async (transaction) => {
      const row = await transaction("media_items")
        .where({ id: itemId, user_id: userId })
        .whereNull("deleted_at")
        .first();
      if (!row) throw new ApiError(404, "media_item_not_found", "媒体条目不存在");
      const sourceRows = await this.readLinkedSourceRows(transaction, itemId, userId);
      // 关键变量：清除后恢复的本地条目信息，不能继续携带海报、简介和 TMDB 编号。
      const original = await this.buildManualMatchSnapshot(transaction, row, sourceRows);
      const now = new Date().toISOString();
      const changedItemIds = await this.rebuildManualVideoStructure(
        transaction,
        row,
        original.itemType,
        sourceRows,
        null,
        original.title,
        now,
      );
      await transaction("media_items").where({ id: itemId, user_id: userId }).update({
        item_type: original.itemType,
        title: original.title,
        sort_title: original.sortTitle,
        subtitle: original.subtitle,
        year: original.year,
        premiere_date: readMediaPremiereDate(original.metadata),
        overview: "",
        poster_url: null,
        backdrop_url: null,
        match_state: "unmatched",
        external_ids_json: "{}",
        metadata_json: JSON.stringify(original.metadata),
        region_group: readVideoRegionGroup(original.itemType, original.metadata),
        updated_at: now,
      });
      await this.recordCatalogItemChanges(transaction, userId, String(row.library_id), [itemId, ...changedItemIds], now);
    });
    return this.getCatalogItem(itemId, userId);
  }

  /** 要求手动匹配对象是海报墙顶层电影或节目。 */
  private requireManualMatchableVideo(item: MediaItemRecord): void {
    if (item.mediaType !== "video" || (item.itemType !== "video.movie" && item.itemType !== "video.series")) {
      throw new ApiError(422, "manual_match_item_not_supported", "当前只支持对电影和节目执行手动匹配");
    }
  }

  /** 读取顶层媒体及其直接子项的源文件关联，按路径稳定排序。 */
  private async readLinkedSourceRows(
    transaction: Knex | Knex.Transaction,
    itemId: string,
    userId: string,
  ): Promise<LinkedSourceRow[]> {
    const childRows = await transaction("media_relations")
      .select("child_item_id")
      .where({ user_id: userId, parent_item_id: itemId });
    const itemIds = [itemId, ...childRows.map((row) => String(row.child_item_id))];
    const rows = await transaction("file_links as fl")
      .join("source_files as f", "f.id", "fl.source_file_id")
      .join("media_items as linked", "linked.id", "fl.item_id")
      .select(
        "fl.id as file_link_id",
        "fl.item_id as linked_item_id",
        "fl.source_file_id",
        "fl.locator_json",
        "f.locator_json as source_locator_json",
        "f.provider_resource_id",
        "f.path",
        "f.name",
        "f.size",
        "f.modified_at",
        "p.status as media_probe_status",
        "p.result_json as media_probe_result_json",
        "linked.title as linked_item_title",
      )
      .leftJoin("media_file_probes as p", "p.source_file_id", "f.id")
      .where("fl.user_id", userId)
      .whereIn("fl.item_id", itemIds)
      .where("f.status", "active")
      .orderBy("f.path", "asc");
    return rows as LinkedSourceRow[];
  }

  /** 构造清除匹配后使用的本地识别快照，并优先复用首次手动匹配保存的快照。 */
  private async buildManualMatchSnapshot(
    transaction: Knex.Transaction,
    row: Record<string, unknown>,
    sourceRows: LinkedSourceRow[],
  ): Promise<ManualMatchSnapshot> {
    const currentMetadata = parseJsonObject(row.metadata_json);
    const storedOriginal = asObject(asObject(currentMetadata.manualMatch).original);
    if (typeof storedOriginal.itemType === "string" && typeof storedOriginal.title === "string") {
      return {
        itemType: storedOriginal.itemType,
        title: storedOriginal.title,
        sortTitle: typeof storedOriginal.sortTitle === "string" ? storedOriginal.sortTitle : storedOriginal.title,
        subtitle: typeof storedOriginal.subtitle === "string" ? storedOriginal.subtitle : "",
        year: typeof storedOriginal.year === "number" ? storedOriginal.year : null,
        metadata: asObject(storedOriginal.metadata),
      };
    }

    const sourceMetadata: Record<string, unknown> = { ...pickSourceMetadata(currentMetadata) };
    const childIds = [...new Set(sourceRows.map((sourceRow) => sourceRow.linked_item_id).filter((id) => id !== String(row.id)))];
    if (childIds.length > 0) {
      const childMetadataRows = await transaction("media_items").select("metadata_json").whereIn("id", childIds);
      for (const childRow of childMetadataRows) {
        const childMetadata = pickSourceMetadata(parseJsonObject(childRow.metadata_json));
        for (const [key, value] of Object.entries(childMetadata)) {
          if (sourceMetadata[key] === undefined) sourceMetadata[key] = value;
        }
      }
    }
    const originalItemType = String(row.item_type) === "video.series" ? "video.series" : "video.movie";
    const firstSource = sourceRows[0];
    const parsed = firstSource
      ? parseFlymbyVideoName(toVideoProviderEntry(firstSource), "/")
      : null;
    const titleCandidates = originalItemType === "video.series"
      ? [sourceMetadata.seriesTitle, sourceMetadata.query, currentMetadata.matchedQuery, parsed?.title, row.title]
      : [sourceMetadata.query, currentMetadata.matchedQuery, parsed?.title, row.title];
    const localTitle = titleCandidates.find((value) => typeof value === "string" && value.trim()) as string | undefined;
    const localYear = parsed?.year ?? (typeof row.year === "number" ? row.year : row.year ? Number(row.year) : null);
    return {
      itemType: originalItemType,
      title: localTitle?.trim() || String(row.title),
      sortTitle: localTitle?.trim() || String(row.sort_title),
      subtitle: originalItemType === "video.series" ? "节目" : (localYear ? String(localYear) : "电影"),
      year: localYear && Number.isFinite(localYear) ? localYear : null,
      metadata: sourceMetadata,
    };
  }

  /** 在电影和节目之间更正类型时重建父子及文件关联，保持顶层条目 ID 不变。 */
  private async rebuildManualVideoStructure(
    transaction: Knex.Transaction,
    row: Record<string, unknown>,
    nextItemType: string,
    sourceRows: LinkedSourceRow[],
    metadata: TmdbVideoMetadata | null,
    displayTitle: string,
    now: string,
  ): Promise<string[]> {
    const previousItemType = String(row.item_type);
    if (previousItemType === nextItemType) return [];
    const userId = String(row.user_id);
    const libraryId = String(row.library_id);
    const parentItemId = String(row.id);
    const uniqueSourceRows = [...new Map(sourceRows.map((sourceRow) => [sourceRow.source_file_id, sourceRow])).values()];
    const changedItemIds: string[] = [];

    if (nextItemType === "video.movie") {
      const previousChildRows = await transaction("media_relations")
        .select("child_item_id")
        .where({ user_id: userId, library_id: libraryId, parent_item_id: parentItemId });
      const previousChildIds = previousChildRows.map((childRow) => String(childRow.child_item_id));
      for (const sourceRow of uniqueSourceRows) {
        // 唯一归属约束要求先移除单集旧关联，再把同一源文件挂到电影父项。
        await transaction("file_links").where({
          user_id: userId,
          library_id: libraryId,
          source_file_id: sourceRow.source_file_id,
        }).whereNot({ item_id: parentItemId }).delete();
        await transaction("file_links").insert({
          id: randomUUID(),
          user_id: userId,
          library_id: libraryId,
          item_id: parentItemId,
          source_file_id: sourceRow.source_file_id,
          locator_json: sourceRow.locator_json,
        }).onConflict(["user_id", "item_id", "source_file_id"]).merge({ locator_json: sourceRow.locator_json });
      }
      await transaction("media_relations").where({ user_id: userId, parent_item_id: parentItemId }).delete();
      if (previousChildIds.length > 0) {
        await transaction("media_items")
          .whereIn("id", previousChildIds)
          .whereNull("deleted_at")
          .update({ deleted_at: now, updated_at: now });
        changedItemIds.push(...previousChildIds);
      }
      return changedItemIds;
    }

    let fallbackEpisodeNumber = 1;
    for (const sourceRow of uniqueSourceRows) {
      const existingEpisode = await transaction("file_links as fl")
        .join("media_items as m", "m.id", "fl.item_id")
        .select("m.id", "m.metadata_json")
        .where("fl.user_id", userId)
        .where("fl.source_file_id", sourceRow.source_file_id)
        .where("m.item_type", "video.episode")
        .whereNull("m.deleted_at")
        .first();
      const parsed = parseFlymbyVideoName(toVideoProviderEntry(sourceRow), "/");
      const seasonNumber = parsed.mediaType === "tv" ? Math.max(0, parsed.seasonNumber) : 1;
      const episodeNumber = parsed.mediaType === "tv" && parsed.episodeNumber > 0
        ? parsed.episodeNumber
        : fallbackEpisodeNumber;
      fallbackEpisodeNumber = Math.max(fallbackEpisodeNumber + 1, episodeNumber + 1);
      let episodeItemId = existingEpisode ? String(existingEpisode.id) : "";
      if (!episodeItemId) {
        const identityKey = `manual:video:episode:${sourceRow.source_file_id}`;
        episodeItemId = createStableId("itm", userId, libraryId, identityKey);
        const episodeMetadata = {
          sourcePath: sourceRow.path,
          query: displayTitle,
          seriesTitle: displayTitle,
          seasonNumber,
          episodeNumber,
          manualStructure: true,
        };
        await transaction("media_items").insert({
          id: episodeItemId,
          user_id: userId,
          service_id: row.service_id,
          library_id: libraryId,
          identity_key: identityKey,
          media_type: "video",
          item_type: "video.episode",
          title: `第 ${seasonNumber} 季 · 第 ${episodeNumber} 集`,
          sort_title: `${String(seasonNumber).padStart(3, "0")}-${String(episodeNumber).padStart(5, "0")}`,
          subtitle: displayTitle,
          year: metadata?.year ?? row.year,
          overview: "",
          poster_url: metadata?.posterUrl ?? row.poster_url,
          backdrop_url: metadata?.backdropUrl ?? row.backdrop_url,
          match_state: "needs_review",
          external_ids_json: metadata ? JSON.stringify({ tmdbTv: String(metadata.id) }) : "{}",
          metadata_json: JSON.stringify(episodeMetadata),
          generation_id: row.generation_id,
          created_at: now,
          updated_at: now,
          deleted_at: null,
        }).onConflict(["user_id", "library_id", "identity_key"]).merge({
          subtitle: displayTitle,
          year: metadata?.year ?? row.year,
          poster_url: metadata?.posterUrl ?? row.poster_url,
          backdrop_url: metadata?.backdropUrl ?? row.backdrop_url,
          metadata_json: JSON.stringify(episodeMetadata),
          updated_at: now,
          deleted_at: null,
        });
        changedItemIds.push(episodeItemId);
      } else {
        const existingEpisodeMetadata = parseJsonObject(existingEpisode.metadata_json);
        await transaction("media_items").where({ id: episodeItemId, user_id: userId }).update({
          subtitle: displayTitle,
          year: metadata?.year ?? row.year,
          poster_url: metadata?.posterUrl ?? row.poster_url,
          backdrop_url: metadata?.backdropUrl ?? row.backdrop_url,
          external_ids_json: metadata ? JSON.stringify({ tmdbTv: String(metadata.id) }) : "{}",
          metadata_json: JSON.stringify({
            ...existingEpisodeMetadata,
            seriesTitle: displayTitle,
            seasonNumber,
            episodeNumber,
          }),
          generation_id: row.generation_id,
          updated_at: now,
          deleted_at: null,
        });
        changedItemIds.push(episodeItemId);
      }
      // 电影转节目时先删除父项或旧单集的文件归属，再建立新的唯一单集归属。
      await transaction("file_links").where({
        user_id: userId,
        library_id: libraryId,
        source_file_id: sourceRow.source_file_id,
      }).whereNot({ item_id: episodeItemId }).delete();
      await transaction("file_links").insert({
        id: randomUUID(),
        user_id: userId,
        library_id: libraryId,
        item_id: episodeItemId,
        source_file_id: sourceRow.source_file_id,
        locator_json: sourceRow.locator_json,
      }).onConflict(["user_id", "item_id", "source_file_id"]).merge({ locator_json: sourceRow.locator_json });
      await transaction("media_relations").insert({
        id: randomUUID(),
        user_id: userId,
        library_id: libraryId,
        parent_item_id: parentItemId,
        child_item_id: episodeItemId,
        relation_type: "series_episode",
        sort_order: seasonNumber * 100_000 + episodeNumber,
      }).onConflict(["user_id", "parent_item_id", "child_item_id", "relation_type"]).merge({
        sort_order: seasonNumber * 100_000 + episodeNumber,
      });
    }
    return changedItemIds;
  }

  /** 为人工修改的媒体条目递增目录版本，并根据软删除状态写入 upsert 或 delete 变化。 */
  private async recordCatalogItemChanges(
    transaction: Knex.Transaction,
    userId: string,
    libraryId: string,
    itemIds: string[],
    now: string,
  ): Promise<void> {
    const uniqueItemIds = [...new Set(itemIds)];
    if (uniqueItemIds.length === 0) return;
    const library = await transaction("media_libraries").where({ id: libraryId, user_id: userId }).first();
    if (!library) throw new ApiError(404, "library_not_found", "媒体库不存在");
    const deletedItemIds = new Set<string>();
    for (const itemIdBatch of chunkStrings(uniqueItemIds)) {
      const rows = await transaction("media_items").select("id", "deleted_at").whereIn("id", itemIdBatch);
      rows.forEach((row) => {
        if (row.deleted_at !== null) deletedItemIds.add(String(row.id));
      });
    }
    const previousVersion = Number(library.catalog_version);
    await transaction("media_libraries").where({ id: libraryId, user_id: userId }).update({
      catalog_version: previousVersion + uniqueItemIds.length,
      updated_at: now,
    });
    for (let offset = 0; offset < uniqueItemIds.length; offset += CATALOG_CHANGE_INSERT_BATCH_SIZE) {
      const itemIdBatch = uniqueItemIds.slice(offset, offset + CATALOG_CHANGE_INSERT_BATCH_SIZE);
      await transaction("catalog_changes").insert(itemIdBatch.map((entityId, batchIndex) => ({
        user_id: userId,
        library_id: libraryId,
        catalog_version: previousVersion + offset + batchIndex + 1,
        entity_type: "media_item",
        entity_id: entityId,
        change_type: deletedItemIds.has(entityId) ? "delete" : "upsert",
        created_at: now,
      })));
    }
  }

  /** 查询 APP 播放端使用的 Provider 文件定位，不下发服务端凭据。 */
  public async listItemFiles(itemId: string, userId: string): Promise<Array<Record<string, unknown>>> {
    await this.getCatalogItem(itemId, userId);
    // 关键变量：节目必须连同直接子项一起返回，APP 才能把每一集映射到对应源文件。
    const rows = await this.readLinkedSourceRows(this.database.query, itemId, userId);
    return rows.map((row) => {
      // 关键变量：源文件定位包含光鸭 fileId、WebDAV path 等 Provider 播放必需字段。
      const sourceLocator = parseJsonObject(row.source_locator_json ?? row.locator_json);
      // 关键变量：关联定位只描述主文件、置信度等媒体关系，不能单独用于访问网盘文件。
      const linkLocator = parseJsonObject(row.locator_json);
      return {
        itemId: row.linked_item_id,
        fileId: row.source_file_id,
        resourceId: row.provider_resource_id,
        path: row.path,
        name: row.name,
        size: Number(row.size),
        modifiedAt: row.modified_at,
        mediaProbeStatus: row.media_probe_status,
        mediaProbeResult: row.media_probe_result_json,
        sourceLocator,
        playbackLocator: {
          ...linkLocator,
          ...sourceLocator,
        },
      };
    });
  }

  /** 查询指定版本后的目录变更。 */
  public async listCatalogChanges(userId: string, libraryId: string, afterVersion: number, limit: number) {
    const library = await this.database.query("media_libraries").where({ id: libraryId, user_id: userId }).first();
    if (!library) throw new ApiError(404, "library_not_found", "媒体库不存在");
    const rows = await this.database.query("catalog_changes")
      .where({ user_id: userId, library_id: libraryId })
      .where("catalog_version", ">", afterVersion)
      .orderBy("catalog_version", "asc")
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const visibleRows = hasMore ? rows.slice(0, limit) : rows;
    return {
      catalogVersion: Number(library.catalog_version),
      nextVersion: visibleRows.length > 0
        ? Number(visibleRows[visibleRows.length - 1]?.catalog_version ?? afterVersion)
        : afterVersion,
      hasMore,
      changes: visibleRows.map((row) => ({
        version: Number(row.catalog_version),
        entityType: row.entity_type,
        entityId: row.entity_id,
        changeType: row.change_type,
        createdAt: row.created_at,
      })),
    };
  }

  /** 查询用户或全局概览统计。 */
  public async getOverview(userId?: string) {
    const services = this.database.query("cloud_services").whereNull("deleted_at");
    const media = this.database.query("media_items as m")
      .join("cloud_services as s", "s.id", "m.service_id")
      .whereNull("m.deleted_at")
      .whereNull("s.deleted_at")
      // 概览与海报墙使用相同口径：节目单集只计入父节目，不重复计入媒体总数。
      .whereNot("m.item_type", "video.episode");
    const jobs = this.database.query("scan_jobs");
    const mediaProbeJobs = this.database.query("media_probe_jobs");
    if (userId) {
      services.where("user_id", userId);
      media.where("m.user_id", userId);
      jobs.where("user_id", userId);
      mediaProbeJobs.where("user_id", userId);
    }
    const [serviceCount, mediaCount, runningCount, mediaProbeRunningCount, failedCount, mediaProbeFailedCount, reviewCount] = await Promise.all([
      services.clone().count<{ count: string | number }[]>({ count: "id" }).first(),
      media.clone().count<{ count: string | number }[]>({ count: "m.id" }).first(),
      jobs.clone().whereIn("status", ["queued", "running", "retry_waiting", "paused"]).count<{ count: string | number }[]>({ count: "id" }).first(),
      mediaProbeJobs.clone().whereIn("status", ["queued", "running", "retry_waiting", "paused"]).count<{ count: string | number }[]>({ count: "id" }).first(),
      jobs.clone().where("status", "failed").count<{ count: string | number }[]>({ count: "id" }).first(),
      mediaProbeJobs.clone().where((builder) => builder.where("status", "failed").orWhere("error_count", ">", 0)).count<{ count: string | number }[]>({ count: "id" }).first(),
      media.clone().where("m.match_state", "needs_review").count<{ count: string | number }[]>({ count: "m.id" }).first(),
    ]);
    return {
      serviceCount: Number(serviceCount?.count ?? 0),
      mediaCount: Number(mediaCount?.count ?? 0),
      activeJobCount: Number(runningCount?.count ?? 0) + Number(mediaProbeRunningCount?.count ?? 0),
      failedJobCount: Number(failedCount?.count ?? 0) + Number(mediaProbeFailedCount?.count ?? 0),
      needsReviewCount: Number(reviewCount?.count ?? 0),
    };
  }
}
