import path from "node:path";
import type { AggregateIndexService } from "./aggregate-index-service.js";
import type { ApiConfig } from "./config.js";
import type { FlyCloudHelperDatabase } from "./database.js";
import type { MediaItemRecord, MediaType, ScanJobRecord, SourceFileRecord } from "./domain.js";
import { ApiError, toSafeErrorMessage } from "./errors.js";
import {
  createStableId,
  buildMediaDirectoryDescriptors,
  describeMediaFile,
  getFileExtension,
  parseMediaDirectory,
  type MediaDescriptor,
} from "./media/filename.js";
import {
  AiVideoNameCleaner,
  buildAiRecognitionRevision,
  buildAiVideoNameCandidateContexts,
  createStoredAiVideoNameCandidateContext,
  readAiModelTaskSnapshot,
  type AiVideoNameCandidateContext,
  type AiVideoNameCleanFailure,
  type AiVideoNameCleanResult,
} from "./media/ai-video-name-cleaner.js";
import type { AiModelManager } from "./ai/ai-model-manager.js";
import { isWeakFlymbyScrapeTitle, parseFlymbyVideoName } from "./media/flymby-video-parser.js";
import { FlymbyVideoTitleCleaner } from "./media/flymby-video-title-cleaner.js";
import {
  parseFlymbyNfo,
  toPublicImageValue,
  type FlymbyNfoMetadata,
} from "./media/flymby-nfo-parser.js";
import { MusicBrainzClient } from "./metadata/musicbrainz.js";
import {
  MUSIC_PLATFORM_SOURCE_ORDER,
  MusicPlatformAggregator,
  type BuiltinMusicPlatformSource,
  type MusicPlatformCandidate,
  type MusicPlatformSource,
} from "./metadata/music-platforms.js";
import {
  applyAudioTagsToDescriptor,
  createAudioTagFingerprint,
  readRemoteAudioTags,
} from "./music/audio-tag-reader.js";
import {
  isTmdbTemporarilyUnavailableError,
  TmdbKeyPool,
  type TmdbTemporarilyUnavailableError,
  type TmdbEpisodeMetadata,
  type TmdbVideoMetadata,
} from "./metadata/tmdb.js";
import { MetadataPluginManager, type PluginTaskSnapshot } from "./plugin-manager.js";
import {
  readProviderConcurrency,
  type ProviderEntry,
  type ProviderEnumerationCheckpoint,
  type ScanRoot,
} from "./providers/types.js";
import { ProviderRegistry } from "./providers/registry.js";
import {
  ScanFailureReportService,
  type ScanFailureRecordInput,
} from "./scan-failure-report-service.js";
import { CredentialVault } from "./secrets.js";
import { loadMusicSourceSettings } from "./system-settings.js";
import {
  ServiceRepository,
  type ScanCreatedMediaCounts,
  type ScanCheckpointProgress,
} from "./service-repository.js";

interface WorkerLogger {
  info(fields: Record<string, unknown>): void;
  warn(fields: Record<string, unknown>): void;
  error(fields: Record<string, unknown>): void;
}

/** 从业务异常读取稳定错误码，缺少错误码时使用调用方给出的分类。 */
function readFailureCode(error: unknown, fallback: string): string {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: string }).code || fallback)
    : fallback;
}

/** 判断任务是否只处理媒体库现有未匹配内容，不进入 Provider 扫描链路。 */
function isStoredAiSupplementJob(job: ScanJobRecord): boolean {
  return job.snapshot.taskPurpose === "ai_supplement_unmatched";
}

interface EnrichedMetadata {
  title: string;
  subtitle: string;
  year: number | null;
  overview: string;
  posterUrl: string | null;
  backdropUrl: string | null;
  matchState: "matched" | "needs_review" | "unmatched" | "processing";
  externalIds: Record<string, string>;
  metadata: Record<string, unknown>;
  parent?: EnrichedMetadata;
}

interface ScanMetadataCache {
  /** 同一电影或节目在一次扫描中只执行一次搜索；是否继续读取详情由服务开关决定。 */
  video: Map<string, Promise<TmdbVideoMetadata | null>>;
  /** 同一节目季在一次扫描中只请求一次单集列表。 */
  seasons: Map<string, Promise<TmdbEpisodeMetadata[]>>;
  /** 完整标签按专辑复用一次图片补全，缺失标签则按曲目复用多平台刮削结果。 */
  music: Map<string, Promise<MusicPlatformCandidate | null>>;
  /** 同一节目父项在一次扫描中只落库一次，避免每一集都对远端数据库重复查询和 upsert。 */
  parentItems: Map<string, Promise<{
    itemId: string;
    changed: boolean;
    hasManualMatch: boolean;
    itemType: string;
  }>>;
  /** 同一影片任务只执行一次 AI 清洗，批量请求中的各候选也复用同一 Promise。 */
  aiResults: Map<string, Promise<AiVideoNameCleanResult | null>>;
  /** 按最终业务任务键保存目录和文件名上下文，供 TMDB 首次未匹配时补充第二查询词。 */
  aiContexts: Map<string, AiVideoNameCandidateContext>;
  /** AI 补充采用记录的任务归属，用于普通用户和管理员任务详情权限隔离。 */
  aiUsageOwner: { userId: string; serviceId: string };
}

interface NfoSidecarEntry {
  path: string;
  metadata: FlymbyNfoMetadata;
}

interface StoredAiSupplementWorkItem {
  /** 本批次待处理的媒体库顶层电影或节目。 */
  item: MediaItemRecord;
  /** 由数据库已保存目录和文件名构建的 AI 上下文。 */
  context: AiVideoNameCandidateContext;
  /** 第一条活动源文件只用于失败报告定位，不参与 Provider 访问。 */
  sourcePath: { path: string; resourceId: string; name: string };
}

/** AI 补充元数据结果同时携带最终影视类型，供落库时纠正电影和节目结构。 */
interface AiSupplementMetadataResolution {
  metadata: EnrichedMetadata;
  mediaType: "movie" | "tv";
}

// 关键变量：解析规则变化时提升版本，旧NFO缓存会自动失效并重新下载解析。
const FLYMBY_NFO_PARSER_CACHE_VERSION = "flymby-nfo-v1";
// 关键变量：音乐平台、字段合并或图片处理变化时提升修订，已有歌曲会在下一次扫描自动补全。
const MUSIC_SCRAPE_RECOGNITION_REVISION = "music-platforms-v1-artwork-v1-audio-specs-v1";
// 关键变量：数据库批量读取与模型请求分别限流，避免几千条未匹配内容一次性占满内存和连接池。
const AI_SUPPLEMENT_DATABASE_BATCH_SIZE = 100;
const AI_SUPPLEMENT_REQUEST_MAXIMUM_CANDIDATES = 10;
const AI_SUPPLEMENT_MAXIMUM_FILE_NAMES_PER_CANDIDATE = 5;
const AI_SUPPLEMENT_REQUEST_MAXIMUM_FILE_NAMES = 50;

interface BusinessTaskProgress {
  /** 本次任务中需要处理的电影或节目聚合键。 */
  taskKeys: Set<string>;
  /** 已经成功完成持久化的电影或节目聚合键。 */
  processedKeys: Set<string>;
  /** 最终至少取得一次元数据匹配的电影或节目聚合键。 */
  matchedKeys: Set<string>;
  /** 已处理但尚未取得元数据匹配的电影或节目聚合键。 */
  unmatchedKeys: Set<string>;
  /** 当前尚未被同任务其他文件成功结果覆盖的失败聚合键。 */
  failedKeys: Set<string>;
}

interface PendingDirectoryMedia {
  /** Provider 返回的媒体文件，用于当前目录枚举完成后立即统一识别。 */
  entry: ProviderEntry;
  /** 当前文件所属扫描根允许的媒体类型。 */
  rootTypes: MediaType[];
  /** 当前文件所属扫描根路径。 */
  rootPath: string;
  /** 增量扫描未变化时为 false，但仍保留为同目录识别上下文。 */
  shouldProcess: boolean;
  /** 全量扫描复用已匹配目录时用于恢复影片级处理与匹配统计。 */
  reusedMatchedCatalog: boolean;
  /** 批量写入数据库前准备好的源文件数据。 */
  sourceFileInput: SourceFileRecord;
  /** 当前枚举窗口是否允许把未变化文件跳过。 */
  skipIfUnchanged: boolean;
  /** 已更新的源文件记录，准备阶段失败时为空。 */
  sourceFile: SourceFileRecord | null;
  /** 枚举阶段写入源文件失败的原始错误。 */
  preparationError: unknown | null;
}

interface PendingBusinessMedia {
  /** 目录上下文识别后的媒体描述。 */
  descriptor: MediaDescriptor;
  /** 对应的待处理文件。 */
  candidate: PendingDirectoryMedia;
}

interface PendingDirectoryFlushResult {
  /** 当前目录真正进入固定刮削执行链的任务。 */
  businessTasks: Promise<void>[];
  /** 增量扫描中经数据库确认未变化的文件数量。 */
  skippedCount: number;
  /** 当前目录真正需要处理的电影或节目聚合键。 */
  businessTaskKeys: string[];
}

/** 创建一次扫描使用的业务任务统计容器。 */
function createBusinessTaskProgress(saved?: ScanCheckpointProgress): BusinessTaskProgress {
  return {
    taskKeys: new Set(saved?.taskKeys ?? []),
    processedKeys: new Set(saved?.processedKeys ?? []),
    matchedKeys: new Set(saved?.matchedKeys ?? []),
    unmatchedKeys: new Set(saved?.unmatchedKeys ?? []),
    failedKeys: new Set(saved?.failedKeys ?? []),
  };
}

/** 把 Worker 内存统计转换为可持久化检查点。 */
function createCheckpointProgress(input: {
  enumeratedEntryCount: number;
  scannedMediaCount: number;
  skippedCount: number;
  currentScanPath: string | null;
  scannedDirectoryCount: number;
  providerWarningKeys: Set<string>;
  businessProgress: BusinessTaskProgress;
  movieTaskKeys: Set<string>;
  seriesTaskKeys: Set<string>;
}): ScanCheckpointProgress {
  return {
    enumeratedEntryCount: input.enumeratedEntryCount,
    scannedMediaCount: input.scannedMediaCount,
    skippedCount: input.skippedCount,
    currentScanPath: input.currentScanPath,
    scannedDirectoryCount: input.scannedDirectoryCount,
    providerWarningKeys: [...input.providerWarningKeys],
    taskKeys: [...input.businessProgress.taskKeys],
    processedKeys: [...input.businessProgress.processedKeys],
    matchedKeys: [...input.businessProgress.matchedKeys],
    unmatchedKeys: [...input.businessProgress.unmatchedKeys],
    failedKeys: [...input.businessProgress.failedKeys],
    movieTaskKeys: [...input.movieTaskKeys],
    seriesTaskKeys: [...input.seriesTaskKeys],
  };
}

/** 只保留指定水位之前的业务任务统计，避免异步检查点混入后续窗口的任务。 */
function createCheckpointBusinessProgress(
  progress: BusinessTaskProgress,
  checkpointTaskKeys: Set<string>,
): BusinessTaskProgress {
  const filterKeys = (values: Set<string>): Set<string> => new Set(
    [...values].filter((value) => checkpointTaskKeys.has(value)),
  );
  return {
    taskKeys: new Set(checkpointTaskKeys),
    processedKeys: filterKeys(progress.processedKeys),
    matchedKeys: filterKeys(progress.matchedKeys),
    unmatchedKeys: filterKeys(progress.unmatchedKeys),
    failedKeys: filterKeys(progress.failedKeys),
  };
}

/** 从可信数据库检查点恢复已经解析的 NFO，不接收外部请求中的任意对象。 */
function restoreNfoSidecars(saved: Record<string, unknown>): Map<string, NfoSidecarEntry> {
  const sidecars = new Map<string, NfoSidecarEntry>();
  for (const [nfoPath, value] of Object.entries(saved)) {
    if (!value || typeof value !== "object") continue;
    const rawEntry = value as Record<string, unknown>;
    if (!rawEntry.metadata || typeof rawEntry.metadata !== "object") continue;
    sidecars.set(nfoPath, {
      path: typeof rawEntry.path === "string" ? rawEntry.path : nfoPath,
      metadata: rawEntry.metadata as FlymbyNfoMetadata,
    });
  }
  return sidecars;
}

/** 把 NFO Map 转换为 JSON 对象，供暂停和进程重启后继续使用。 */
function serializeNfoSidecars(sidecars: Map<string, NfoSidecarEntry>): Record<string, unknown> {
  return Object.fromEntries([...sidecars.entries()].map(([nfoPath, entry]) => [nfoPath, entry]));
}

/** 读取 Provider 检查点序号，非法值按初始序号处理。 */
function readCheckpointSequence(state: Record<string, unknown>): number {
  const value = Number(state.checkpointSequence ?? -1);
  return Number.isInteger(value) && value >= 0 ? value : -1;
}

/** 为扫描根生成不暴露真实路径的稳定键。 */
function createScanRootKey(root: ScanRoot): string {
  return createStableId("scan-root", root.resourceId || root.displayPath || "/");
}

/** 使用 Flymby APP 的刮削任务键；影视按作品聚合，音乐按单个源文件统计曲目处理进度。 */
function readBusinessTaskKey(descriptor: MediaDescriptor): string {
  if (descriptor.mediaType === "music" && descriptor.itemType === "music.track") {
    return descriptor.identityKey;
  }
  const scrapeTaskKey = descriptor.metadata.scrapeTaskKey;
  if (typeof scrapeTaskKey === "string" && scrapeTaskKey.length > 0) {
    return scrapeTaskKey;
  }
  return descriptor.parent?.identityKey || descriptor.identityKey;
}

/** 读取元数据来源的稳定条目标识，支持影视和音乐内置来源及插件编号。 */
function readMetadataIdentity(metadata: EnrichedMetadata): string {
  const preferredKeys = [
    "tmdb", "tmdbTv", "musicbrainzReleaseTrack", "musicbrainzRelease",
    "musicbrainzReleaseGroup", "musicbrainzRecording", "musicbrainzArtist",
  ];
  for (const key of preferredKeys) {
    const value = metadata.externalIds[key];
    if (value) return `${key}:${value}`;
  }
  const pluginIdentity = Object.entries(metadata.externalIds)
    .find(([key, value]) => key.startsWith("plugin:") && value.length > 0);
  return pluginIdentity ? `${pluginIdentity[0]}:${pluginIdentity[1]}` : "";
}

/**
 * 按 APP 的电影/节目任务身份生成目录条目身份，避免同一影片的多个视频版本各生成一张海报。
 * 单集继续附加季集号，使同一集的多个版本共用一个单集条目。
 */
function resolveCatalogIdentityKey(
  descriptor: MediaDescriptor,
  metadata: EnrichedMetadata,
  parent: boolean,
): string {
  const metadataIdentity = readMetadataIdentity(metadata);
  const businessTaskKey = readBusinessTaskKey(descriptor);
  if (descriptor.mediaType === "music") {
    if (parent || descriptor.itemType === "music.album") {
      const releaseId = metadata.externalIds.musicbrainzRelease
        || String(descriptor.metadata.musicBrainzReleaseId ?? "");
      return releaseId
        ? `music:album:release:${releaseId}`
        : descriptor.parent?.identityKey || descriptor.identityKey;
    }
    if (descriptor.itemType === "music.track") {
      const releaseTrackId = metadata.externalIds.musicbrainzReleaseTrack
        || String(descriptor.metadata.musicBrainzReleaseTrackId ?? "");
      if (releaseTrackId) return `music:track:release-track:${releaseTrackId}`;
      const discNumber = Math.max(1, Number(descriptor.metadata.discNumber ?? 1));
      const trackNumber = Math.max(0, Number(descriptor.metadata.trackNumber ?? 0));
      if (trackNumber > 0 && descriptor.parent) {
        return `${descriptor.parent.identityKey}:disc:${discNumber}:track:${trackNumber}`;
      }
      return descriptor.identityKey;
    }
  }
  if (parent || descriptor.itemType === "video.movie") {
    const itemKind = parent ? "series" : "movie";
    return metadataIdentity
      ? `video:${itemKind}:metadata:${metadataIdentity}`
      : `video:${itemKind}:task:${businessTaskKey}`;
  }
  if (descriptor.itemType === "video.episode") {
    const seasonNumber = Math.max(0, Number(descriptor.metadata.seasonNumber ?? 1));
    const episodeNumber = Math.max(1, Number(descriptor.metadata.episodeNumber ?? 1));
    const parentIdentity = metadata.parent ? readMetadataIdentity(metadata.parent) : "";
    const seriesIdentity = parentIdentity || businessTaskKey;
    return `video:episode:${seriesIdentity}:s${seasonNumber}:e${episodeNumber}`;
  }
  return descriptor.identityKey;
}

/** 记录一个电影或节目任务成功；同任务后续匹配成功时覆盖先前的未匹配状态。 */
function recordBusinessTaskSuccess(progress: BusinessTaskProgress, taskKey: string, matched: boolean): void {
  progress.taskKeys.add(taskKey);
  progress.processedKeys.add(taskKey);
  progress.failedKeys.delete(taskKey);
  if (matched) {
    progress.matchedKeys.add(taskKey);
    progress.unmatchedKeys.delete(taskKey);
    return;
  }
  if (!progress.matchedKeys.has(taskKey)) {
    progress.unmatchedKeys.add(taskKey);
  }
}

/** 记录一个电影或节目任务失败；同任务已有其他文件成功时不重复计错。 */
function recordBusinessTaskFailure(progress: BusinessTaskProgress, taskKey: string): void {
  progress.taskKeys.add(taskKey);
  if (!progress.processedKeys.has(taskKey)) {
    progress.failedKeys.add(taskKey);
  }
}

/** 返回 APP 页面“已处理”的同口径数量：成功完成与最终失败的业务任务之和。 */
function getHandledBusinessTaskCount(progress: BusinessTaskProgress): number {
  return progress.processedKeys.size + progress.failedKeys.size;
}

/** 解析扫描配置中的媒体范围；音乐服务与影视服务保持单类型边界。 */
function readMediaTypes(profile: Record<string, unknown>): MediaType[] {
  const values = Array.isArray(profile.mediaTypes) ? profile.mediaTypes : [];
  const types = values.filter((item): item is MediaType => item === "video" || item === "music");
  return types.length > 0 ? types : ["video"];
}

/** 按任务模式解析扫描根，并兼容已经保存的旧版 roots 配置。 */
function readScanRoots(profile: Record<string, unknown>, scanMode: "incremental" | "full"): ScanRoot[] {
  const configuredRoots = scanMode === "full" ? profile.fullRoots : profile.incrementalRoots;
  const roots = Array.isArray(configuredRoots)
    ? configuredRoots
    : Array.isArray(profile.roots) ? profile.roots : [];
  return roots.filter((item): item is ScanRoot => Boolean(item && typeof item === "object"));
}

/** 读取指定媒体类型的元数据 Profile。 */
function readMetadataProfile(profile: Record<string, unknown>, mediaType: MediaType): Record<string, unknown> {
  const profiles = profile.profiles && typeof profile.profiles === "object"
    ? profile.profiles as Record<string, unknown>
    : {};
  const selected = profiles[mediaType];
  return selected && typeof selected === "object" ? selected as Record<string, unknown> : {};
}

/** 兼容早期 sources 数组和当前 providerId 字段。 */
function readMetadataProviderId(profile: Record<string, unknown>): string {
  if (typeof profile.providerId === "string" && profile.providerId) return profile.providerId;
  const firstSource = Array.isArray(profile.sources) ? profile.sources.find((item) => typeof item === "string") : null;
  return firstSource === "tmdb" ? "builtin.tmdb" : typeof firstSource === "string" ? firstSource : "";
}

/** 判断 Provider 返回路径是否属于扫描根，兼容 WebDAV 响应额外携带连接基础路径。 */
function isEntryWithinScanRoot(entryPath: string, root: ScanRoot): boolean {
  const rawRootPath = root.displayPath || root.resourceId || "";
  if (!rawRootPath) return false;
  const normalizedEntryPath = path.posix.normalize(`/${entryPath.replace(/^\/+/, "")}`);
  const normalizedRootPath = path.posix.normalize(`/${rawRootPath.replace(/^\/+/, "")}`).replace(/\/$/u, "") || "/";
  if (normalizedRootPath === "/") return true;
  return normalizedEntryPath === normalizedRootPath
    || normalizedEntryPath.startsWith(`${normalizedRootPath}/`)
    || normalizedEntryPath.endsWith(normalizedRootPath)
    || normalizedEntryPath.includes(`${normalizedRootPath}/`);
}

/** 多个扫描根重叠时选择路径最深的根，避免父根对账覆盖子根文件。 */
function findMatchingScanRoot(entryPath: string, roots: ScanRoot[]): ScanRoot | undefined {
  return roots
    .filter((root) => isEntryWithinScanRoot(entryPath, root))
    .sort((left, right) => {
      const leftPath = left.displayPath || left.resourceId || "/";
      const rightPath = right.displayPath || right.resourceId || "/";
      return rightPath.length - leftPath.length;
    })[0];
}

/** 生成扫描完成通知；影视列出最多五个新入库影片，音乐保持数量摘要。 */
function buildScanCompletionMessage(
  job: Pick<ScanJobRecord, "dataType" | "scanMode" | "serviceName">,
  createdMediaCounts: ScanCreatedMediaCounts,
): string {
  const scanModeLabel = job.scanMode === "full" ? "全量" : "增量";
  if (job.dataType === "music") {
    return `服务“${job.serviceName}”的${scanModeLabel}扫描已完成：新增入库 ${createdMediaCounts.songCount} 首歌曲、${createdMediaCounts.albumCount} 张专辑、${createdMediaCounts.artistCount} 位艺术家。`;
  }
  const videoLines = createdMediaCounts.videoContents.map((content, index) => (
    content.itemType === "video.series"
      ? `${index + 1}. 《${content.title}》（本次新增 ${content.episodeCount ?? 0} 集）`
      : `${index + 1}. 《${content.title}》（电影）`
  ));
  const remainingLine = createdMediaCounts.videoContentCount > 5
    ? `……等 ${createdMediaCounts.videoContentCount} 个影片。`
    : null;
  return [
    `服务“${job.serviceName}”的${scanModeLabel}扫描已完成：新增入库 ${createdMediaCounts.videoContentCount} 个影片。`,
    ...videoLines,
    ...(remainingLine ? [remainingLine] : []),
  ].join("\n");
}

/** 轮询数据库任务队列并执行 Provider 扫描；当前只开放影视持久化。 */
export class ScanWorker {
  private readonly database: FlyCloudHelperDatabase;
  private readonly repository: ServiceRepository;
  private readonly providers: ProviderRegistry;
  private readonly vault: CredentialVault;
  private readonly tmdb: TmdbKeyPool;
  private readonly musicBrainz: MusicBrainzClient;
  private readonly musicPlatforms: MusicPlatformAggregator;
  private readonly plugins: MetadataPluginManager;
  private readonly aiVideoNameCleaner: AiVideoNameCleaner;
  private readonly failureReports: ScanFailureReportService;
  private readonly aggregateIndex: AggregateIndexService;
  private readonly logger: WorkerLogger;
  private readonly config: ApiConfig;
  private readonly abortControllers = new Map<string, AbortController>();
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private activeWorkers = 0;
  private stopping = false;

  public constructor(input: {
    database: FlyCloudHelperDatabase;
    repository: ServiceRepository;
    providers: ProviderRegistry;
    vault: CredentialVault;
    tmdb: TmdbKeyPool;
    musicBrainz: MusicBrainzClient;
    plugins: MetadataPluginManager;
    aiModels: AiModelManager;
    failureReports: ScanFailureReportService;
    aggregateIndex: AggregateIndexService;
    logger: WorkerLogger;
    config: ApiConfig;
  }) {
    this.database = input.database;
    this.repository = input.repository;
    this.providers = input.providers;
    this.vault = input.vault;
    this.tmdb = input.tmdb;
    this.musicBrainz = input.musicBrainz;
    this.musicPlatforms = new MusicPlatformAggregator(input.musicBrainz, input.logger, input.config.musicbrainzUserAgent);
    this.plugins = input.plugins;
    this.aiVideoNameCleaner = new AiVideoNameCleaner(input.database, input.aiModels, input.logger);
    this.failureReports = input.failureReports;
    this.aggregateIndex = input.aggregateIndex;
    this.logger = input.logger;
    this.config = input.config;
  }

  /** 尽力读取服务通知开关；通知配置查询失败时不影响后台任务本身和站内通知。 */
  private async readServiceNotificationEnabled(serviceId: string): Promise<boolean> {
    try {
      return await this.repository.isServiceNotificationEnabled(serviceId);
    } catch (error) {
      this.logger.warn({
        日志关键字: "codex-flycloud-helper-service-notification",
        事件: "读取服务任务通知开关失败",
        服务ID: serviceId,
        错误信息: error instanceof Error ? error.message : "未知数据库错误",
      });
      return false;
    }
  }

  /** 尽力统计本次扫描新增入库内容；统计失败时使用零值完成原任务。 */
  private async readScanCreatedMediaCounts(
    job: Pick<ScanJobRecord, "serviceId" | "startedAt">,
  ): Promise<ScanCreatedMediaCounts> {
    try {
      return await this.repository.getScanCreatedMediaCounts(job);
    } catch (error) {
      this.logger.warn({
        日志关键字: "codex-flycloud-helper-service-notification",
        事件: "统计扫描新增入库数量失败",
        服务ID: job.serviceId,
        错误信息: error instanceof Error ? error.message : "未知数据库错误",
      });
      return { videoContentCount: 0, videoContents: [], songCount: 0, albumCount: 0, artistCount: 0 };
    }
  }

  /** 尽力读取影视媒体库目录版本，版本读取失败不能反向导致扫描任务失败。 */
  private async readVideoCatalogVersion(job: ScanJobRecord): Promise<number | null> {
    if (job.dataType !== "video") return null;
    try {
      const library = await this.database.query("media_libraries")
        .select("catalog_version")
        .where({ id: job.libraryId, user_id: job.userId })
        .first();
      return library ? Number(library.catalog_version ?? 0) : null;
    } catch (error) {
      this.logger.warn({
        日志关键字: "codex-aggregate-index",
        事件: "读取扫描前影视目录版本失败",
        扫描任务ID: job.id,
        来源服务ID: job.serviceId,
        来源媒体库ID: job.libraryId,
        错误信息: error instanceof Error ? error.message : "未知数据库错误",
      });
      return null;
    }
  }

  /** 扫描成功后仅在目录版本实际推进时触发关联聚合服务，失败不影响已完成的来源扫描。 */
  private async enqueueChangedAggregateIndexes(job: ScanJobRecord, previousCatalogVersion: number | null): Promise<void> {
    if (job.dataType !== "video" || previousCatalogVersion === null) return;
    try {
      const completedJob = await this.repository.getJob(job.id);
      if (completedJob.status !== "completed") return;
      const catalogVersion = await this.readVideoCatalogVersion(job);
      if (catalogVersion === null) return;
      if (catalogVersion <= previousCatalogVersion) {
        this.logger.info({
          日志关键字: "codex-aggregate-index",
          事件: "扫描目录无变化跳过聚合索引",
          扫描任务ID: job.id,
          来源服务ID: job.serviceId,
          来源媒体库ID: job.libraryId,
          扫描前目录版本: previousCatalogVersion,
          扫描后目录版本: catalogVersion,
        });
        return;
      }
      const aggregateServiceCount = await this.aggregateIndex.enqueueForSourceCatalogChange({
        userId: job.userId,
        serviceId: job.serviceId,
        libraryId: job.libraryId,
        scanJobId: job.id,
        previousCatalogVersion,
        catalogVersion,
      });
      this.logger.info({
        日志关键字: "codex-aggregate-index",
        事件: "扫描目录变化聚合触发检查完成",
        扫描任务ID: job.id,
        来源服务ID: job.serviceId,
        来源媒体库ID: job.libraryId,
        扫描前目录版本: previousCatalogVersion,
        扫描后目录版本: catalogVersion,
        触发聚合服务数量: aggregateServiceCount,
      });
    } catch (error) {
      this.logger.warn({
        日志关键字: "codex-aggregate-index",
        事件: "扫描完成后自动触发聚合索引失败",
        扫描任务ID: job.id,
        来源服务ID: job.serviceId,
        来源媒体库ID: job.libraryId,
        错误信息: error instanceof Error ? error.message : "未知数据库错误",
      });
    }
  }

  /** 启动内置数据库任务轮询器。 */
  public start(): void {
    if (!this.config.workerEnabled || this.pollTimer || this.stopping) {
      return;
    }
    this.schedulePoll(0);
  }

  /** 停止领取新任务并取消当前扫描。 */
  public async stop(): Promise<void> {
    this.stopping = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.abortControllers.forEach((controller) => controller.abort());
    while (this.activeWorkers > 0) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  /** 返回管理端使用的 Worker 状态。 */
  public getStatus() {
    return {
      enabled: this.config.workerEnabled,
      running: !this.stopping && this.config.workerEnabled,
      activeWorkers: this.activeWorkers,
      concurrency: this.config.workerConcurrency,
      availableSlots: Math.max(0, this.config.workerConcurrency - this.activeWorkers),
    };
  }

  /**
   * 收到暂停或终止请求后立即打断当前任务的 Provider、TMDB 和插件网络请求。
   * 数据库控制动作已经由路由先行写入，Worker 退出当前窗口后据此落为暂停或已取消状态。
   */
  public interruptJobControl(jobId: string, action: "pause" | "cancel"): boolean {
    const controller = this.abortControllers.get(jobId); // 关键变量：当前进程正在执行该任务的取消控制器。
    if (!controller || controller.signal.aborted) {
      this.logger.info({
        日志关键字: "codex-scan-control-resume",
        事件: "任务控制未命中运行中的Worker",
        任务ID: jobId,
        控制动作: action,
      });
      return false;
    }
    controller.abort();
    this.logger.info({
      日志关键字: "codex-scan-control-resume",
      事件: "任务控制已中断运行请求",
      任务ID: jobId,
      控制动作: action,
    });
    return true;
  }

  /** 安排下一次队列轮询。 */
  private schedulePoll(delay: number): void {
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.poll();
    }, delay);
  }

  /** 按 Worker 并发槽位领取排队任务。 */
  private async poll(): Promise<void> {
    if (this.stopping) {
      return;
    }
    try {
      const recoveredCount = await this.repository.requeueDueRetryJobs();
      if (recoveredCount > 0) {
        this.logger.info({
          日志关键字: "codex-flycloud-helper-tmdb-recovery",
          事件: "到期TMDB等待任务已重新入队",
          恢复任务数量: recoveredCount,
        });
      }
      while (this.activeWorkers < this.config.workerConcurrency) {
        const job = await this.repository.claimNextQueuedJob();
        if (!job) break;
        this.activeWorkers += 1;
        void this.executeJob(job).finally(() => {
          this.activeWorkers -= 1;
        });
      }
    } catch (error) {
      this.logger.error({
        日志标记: "flycloud-helper-worker",
        事件: "领取扫描任务失败",
        错误: error,
      });
    } finally {
      this.schedulePoll(this.config.workerPollIntervalMs);
    }
  }

  /** 执行单个任务并把异常转换为脱敏任务错误。 */
  private async executeJob(job: ScanJobRecord): Promise<void> {
    const controller = new AbortController();
    this.abortControllers.set(job.id, controller);
    // 关键变量：只有任务成功结束且目录版本大于此值时，才允许触发聚合索引。
    const previousCatalogVersion = await this.readVideoCatalogVersion(job);
    this.logger.info({
      日志标记: "flycloud-helper-worker",
      事件: isStoredAiSupplementJob(job) ? "AI补充未匹配任务开始" : "扫描任务开始",
      任务ID: job.id,
      服务ID: job.serviceId,
    });
    try {
      if (isStoredAiSupplementJob(job)) {
        await this.supplementStoredUnmatchedMedia(job, controller.signal);
      } else {
        await this.scan(job, controller.signal);
      }
      await this.enqueueChangedAggregateIndexes(job, previousCatalogVersion);
    } catch (error) {
      if (controller.signal.aborted) {
        await this.applyAbortedJobState(job, "任务执行异常出口");
        return;
      }
      if (isTmdbTemporarilyUnavailableError(error)) {
        await this.failureReports.record(job, {
          stage: "scraping",
          errorCode: error.code,
          error,
          recovered: true,
          context: {
            恢复方式: "任务延迟后自动重试",
            下次重试时间: error.nextRetryAt,
            原因代码: error.reasonCode,
          },
        });
        const waitingJob = await this.repository.waitForJobRetry(job.id, {
          nextRetryAt: error.nextRetryAt,
          errorCode: error.code,
          errorMessage: error.message,
        });
        this.logger.warn({
          日志关键字: "codex-flycloud-helper-tmdb-recovery",
          事件: "扫描任务等待TMDB恢复",
          任务ID: job.id,
          原因代码: error.reasonCode,
          下次重试时间: waitingJob.nextRetryAt,
          累计等待次数: waitingJob.retryCount,
          检查点时间: waitingJob.checkpointUpdatedAt,
        });
        return;
      }
      const code = readFailureCode(error, "scan_failed");
      await this.failureReports.record(job, {
        stage: "task",
        errorCode: code,
        error,
        recovered: false,
        mediaPath: job.currentPath,
      });
      await this.repository.finishJob(job.id, {
        status: "failed",
        errorCode: code,
        errorMessage: toSafeErrorMessage(error, isStoredAiSupplementJob(job) ? "AI 补充任务失败" : "扫描任务失败"),
      });
      const notificationEnabled = await this.readServiceNotificationEnabled(job.serviceId);
      await this.database.createNotificationSafely({
        userId: job.userId,
        category: "task",
        tone: "danger",
        title: isStoredAiSupplementJob(job) ? "AI 补充任务失败" : "扫描任务失败",
        message: isStoredAiSupplementJob(job)
          ? `服务“${job.serviceName}”的未匹配内容 AI 补充失败：${toSafeErrorMessage(error, "AI 补充任务失败")}`
          : `服务“${job.serviceName}”的${job.scanMode === "full" ? "全量" : "增量"}扫描失败：${toSafeErrorMessage(error, "扫描任务失败")}`,
        actionPath: "/app/jobs",
        deliverExternally: notificationEnabled,
      });
      this.logger.warn({
        日志标记: "flycloud-helper-worker",
        事件: isStoredAiSupplementJob(job) ? "AI补充未匹配任务失败" : "扫描任务失败",
        任务ID: job.id,
        错误码: code,
      });
    } finally {
      this.abortControllers.delete(job.id);
      this.failureReports.release(job.id);
    }
  }

  /** 只读取媒体库未匹配条目及已保存文件名，通过 AI 查询词重新请求元数据，不访问 Provider。 */
  private async supplementStoredUnmatchedMedia(job: ScanJobRecord, signal: AbortSignal): Promise<void> {
    const metadataProfile = await this.repository.getJobMetadataConfiguration(job);
    const profile = readMetadataProfile(metadataProfile, "video");
    const providerId = readMetadataProviderId(profile);
    const aiModelSnapshot = readAiModelTaskSnapshot(job.snapshot.aiModel);
    if (!aiModelSnapshot) {
      throw new ApiError(409, "ai_cleaning_snapshot_missing", "AI 补充任务缺少可用模型快照");
    }

    // 关键变量：先固定本任务开始时的未匹配顶层条目，后续逐条写入匹配结果不会影响分页范围。
    const unmatchedItems: MediaItemRecord[] = [];
    let offset = 0;
    const pageSize = 500;
    while (true) {
      const page = await this.repository.listCatalogItems({
        userId: job.userId,
        serviceId: job.serviceId,
        mediaType: "video",
        categoryKey: "unrecognized",
        sort: "updated_asc",
        limit: pageSize,
        offset,
      });
      unmatchedItems.push(...page.items.filter((item) =>
        item.itemType === "video.movie" || item.itemType === "video.series"));
      offset += page.items.length;
      if (page.items.length === 0 || offset >= page.total) break;
    }

    await this.repository.updateJobProgress(job.id, {
      stage: "classifying",
      processedCount: 0,
      totalCount: unmatchedItems.length,
      discoveredCount: unmatchedItems.length,
      matchedCount: 0,
      unmatchedCount: 0,
      errorCount: 0,
      currentPath: "准备分批读取媒体库未匹配内容",
    });
    if (unmatchedItems.length === 0) {
      await this.repository.finishJob(job.id, { status: "completed" });
      const notificationEnabled = await this.readServiceNotificationEnabled(job.serviceId);
      await this.database.createNotificationSafely({
        userId: job.userId,
        category: "task",
        tone: "success",
        title: "AI 补充未识别内容完成",
        message: `服务“${job.serviceName}”的 AI 补充已完成：0 部影片完成了 AI 补充。`,
        actionPath: "/app/jobs",
        deliverExternally: notificationEnabled,
      });
      this.logger.info({
        日志关键字: "codex-flycloud-helper-ai-clean",
        事件: "AI补充任务没有未匹配内容",
        任务ID: job.id,
        服务ID: job.serviceId,
        是否访问Provider: false,
      });
      return;
    }
    if (await this.applyControlAction(job)) return;

    const pluginSnapshots = Array.isArray(job.snapshot.pluginVersions)
      ? job.snapshot.pluginVersions.filter((item): item is PluginTaskSnapshot => Boolean(item && typeof item === "object"))
      : [];
    const recognitionRevision = buildAiRecognitionRevision(Number(job.snapshot.metadataProfileRevision ?? 0), aiModelSnapshot);
    const taskCache = new Map<string, Promise<AiVideoNameCleanResult | null>>();
    // 关键变量：按候选保存模型请求或校验失败，避免失败报告只剩统一的“不可用”原因。
    const taskFailures = new Map<string, AiVideoNameCleanFailure>();
    let processedCount = 0;
    let matchedCount = 0;
    let unmatchedCount = 0;
    let errorCount = 0;
    let lastProgressPublishedAt = 0;
    // 关键变量：跨数据库批次记住源文件第一次归属，用日志暴露历史脏关联，不在补充任务中擅自改库。
    const firstItemIdBySourceFileId = new Map<string, string>();
    const loggedDuplicateSourceFileIds = new Set<string>();
    this.logger.info({
      日志关键字: "codex-flycloud-helper-ai-clean",
      事件: "AI补充未匹配任务参数已确认",
      任务ID: job.id,
      服务ID: job.serviceId,
      待补充条目数量: unmatchedItems.length,
      模型ID: aiModelSnapshot.modelId,
      模型修订: aiModelSnapshot.configurationRevision,
      数据库批次上限: AI_SUPPLEMENT_DATABASE_BATCH_SIZE,
      AI单批候选上限: AI_SUPPLEMENT_REQUEST_MAXIMUM_CANDIDATES,
      单候选文件样例上限: AI_SUPPLEMENT_MAXIMUM_FILE_NAMES_PER_CANDIDATE,
      AI单批文件样例上限: AI_SUPPLEMENT_REQUEST_MAXIMUM_FILE_NAMES,
      是否访问Provider: false,
    });

    /** 把 AI 补充未采用、未匹配或异常的媒体条目写入任务失败报告。 */
    const recordAiSupplementFailure = async (input: {
      item: MediaItemRecord;
      errorCode: string;
      error: unknown;
      recovered: boolean;
      processingResult: string;
      sourcePath?: { path: string; resourceId: string; name: string };
      ruleTitle?: string;
      aiQuery?: string;
      failureStage?: AiVideoNameCleanFailure["stage"] | "metadata";
      ruleMediaType?: "movie" | "tv";
      aiMediaType?: "movie" | "tv";
    }): Promise<void> => {
      await this.failureReports.record(job, {
        stage: "scraping",
        errorCode: input.errorCode,
        error: input.error,
        recovered: input.recovered,
        mediaPath: input.sourcePath?.path ?? null,
        resourceId: input.sourcePath?.resourceId ?? null,
        fileName: input.sourcePath?.name ?? null,
        itemType: input.item.itemType,
        parsedTitle: input.item.title,
        businessTaskKey: input.item.id,
        context: {
          任务类型: "AI补充未识别内容",
          模型ID: aiModelSnapshot.modelId,
          模型修订: aiModelSnapshot.configurationRevision,
          规则查询词: input.ruleTitle ?? input.item.title,
          AI查询词: input.aiQuery ?? "",
          失败阶段: input.failureStage ?? "metadata",
          规则媒体类型: input.ruleMediaType ?? (input.item.itemType === "video.series" ? "tv" : "movie"),
          AI媒体类型: input.aiMediaType ?? "",
          处理结果: input.processingResult,
        },
      });
      this.logger.warn({
        日志关键字: "codex-flycloud-helper-ai-clean",
        事件: "AI补充失败内容已写入报告",
        任务ID: job.id,
        服务ID: job.serviceId,
        媒体条目ID: input.item.id,
        媒体标题: input.item.title,
        错误码: input.errorCode,
        失败阶段: input.failureStage ?? "metadata",
        规则媒体类型: input.ruleMediaType ?? (input.item.itemType === "video.series" ? "tv" : "movie"),
        AI媒体类型: input.aiMediaType ?? "",
        是否后续重试: input.recovered,
      });
    };

    /** 使用当前服务冻结的元数据来源处理单条 AI 建议。 */
    const resolveSupplementMetadata = async (
      workItem: StoredAiSupplementWorkItem,
      aiResult: AiVideoNameCleanResult | null | undefined,
    ): Promise<AiSupplementMetadataResolution | null> => {
      if (!aiResult) return null;
      this.logger.info({
        日志关键字: "codex-flycloud-helper-ai-clean",
        事件: "AI补充开始匹配元数据",
        任务ID: job.id,
        服务ID: job.serviceId,
        媒体条目ID: workItem.item.id,
        规则查询词: workItem.context.ruleTitle,
        AI查询词: aiResult.cleanedTitle,
        规则媒体类型: workItem.context.ruleMediaType,
        AI媒体类型: aiResult.mediaType,
        是否纠正媒体类型: workItem.context.ruleMediaType !== aiResult.mediaType,
        元数据来源: providerId || "builtin.tmdb",
      });
      if (providerId.startsWith("plugin:")) {
        const reference = providerId.slice("plugin:".length);
        const separator = reference.lastIndexOf("@");
        const pluginId = separator > 0 ? reference.slice(0, separator) : reference;
        const requestedVersion = separator > 0 ? reference.slice(separator + 1) : null;
        const snapshot = pluginSnapshots.find((value) => value.pluginId === pluginId
          && (!requestedVersion || value.version === requestedVersion));
        const pluginResult = snapshot ? await this.plugins.scrape(snapshot, {
          mediaType: "video",
          title: aiResult.cleanedTitle,
          subtitle: workItem.item.subtitle,
          year: aiResult.year ?? workItem.item.year,
        }, signal) : null;
        return pluginResult ? {
          mediaType: aiResult.mediaType,
          metadata: {
            title: pluginResult.title,
            subtitle: pluginResult.subtitle || workItem.item.subtitle,
            year: pluginResult.year ?? workItem.item.year,
            overview: pluginResult.overview,
            posterUrl: pluginResult.posterUrl,
            backdropUrl: pluginResult.backdropUrl,
            matchState: "matched",
            externalIds: pluginResult.externalId ? { [`plugin:${pluginId}`]: pluginResult.externalId } : {},
            metadata: {
              ...pluginResult.metadata,
              matchedQuery: aiResult.cleanedTitle,
              metadataPluginId: pluginId,
              metadataPluginVersion: snapshot!.version,
            },
          },
        } : null;
      }
      if (providerId && providerId !== "tmdb" && providerId !== "builtin.tmdb") return null;
      const tmdbResult = await this.tmdb.scrapeVideo({
        mediaType: aiResult.mediaType,
        title: aiResult.cleanedTitle,
        fallbackTitle: aiResult.alternateTitle || workItem.context.ruleTitle,
        year: aiResult.year ?? workItem.item.year,
        language: String(profile.language ?? "zh-CN"),
        region: String(profile.region ?? "CN"),
        includeDetails: profile.syncDetails === true,
        cacheRevision: recognitionRevision,
        signal,
      });
      return tmdbResult ? {
        mediaType: tmdbResult.mediaType,
        metadata: this.mapTmdbVideoMetadata(
          tmdbResult,
          tmdbResult.mediaType === "tv" ? "节目" : (tmdbResult.originalTitle || workItem.item.subtitle),
        ),
      } : null;
    };

    /** 把当前累计结果写入任务表，前端下一次轮询即可看到进度变化。 */
    const publishBatchProgress = async (currentOperation: string, stage: "classifying" | "scraping"): Promise<void> => {
      await this.repository.updateJobProgress(job.id, {
        stage,
        processedCount,
        totalCount: unmatchedItems.length,
        discoveredCount: unmatchedItems.length,
        matchedCount,
        unmatchedCount,
        errorCount,
        currentPath: currentOperation,
      });
    };

    const databaseBatchCount = Math.ceil(unmatchedItems.length / AI_SUPPLEMENT_DATABASE_BATCH_SIZE);
    for (let databaseBatchIndex = 0; databaseBatchIndex < databaseBatchCount; databaseBatchIndex += 1) {
      if (signal.aborted) throw new Error("AI 补充任务已中断");
      if (await this.applyControlAction(job)) return;
      const databaseBatch = unmatchedItems.slice(
        databaseBatchIndex * AI_SUPPLEMENT_DATABASE_BATCH_SIZE,
        (databaseBatchIndex + 1) * AI_SUPPLEMENT_DATABASE_BATCH_SIZE,
      );
      const databaseBatchLabel = `${databaseBatchIndex + 1}/${databaseBatchCount}`;
      await publishBatchProgress(`正在读取媒体库第 ${databaseBatchLabel} 批关联文件`, "classifying");
      const sourcePathsByItemId = await this.repository.listAiSupplementCatalogPaths(
        databaseBatch.map((item) => item.id),
        job.userId,
      );
      const workItems: StoredAiSupplementWorkItem[] = [];
      let missingSourceCount = 0;
      for (const item of databaseBatch) {
        const sourcePaths = sourcePathsByItemId.get(item.id) ?? [];
        if (sourcePaths.length === 0) {
          missingSourceCount += 1;
          await recordAiSupplementFailure({
            item,
            errorCode: "ai_supplement_source_file_missing",
            error: new Error("媒体条目没有关联的活动源文件，无法构建 AI 识别上下文"),
            recovered: false,
            processingResult: "保持未匹配",
          });
          continue;
        }
        const firstPath = sourcePaths[0]!.path;
        const directoryPath = path.posix.dirname(firstPath);
        const parentDirectoryPath = path.posix.dirname(directoryPath);
        const metadataQuery = typeof item.metadata.query === "string" ? item.metadata.query.trim() : "";
        const seriesTitle = typeof item.metadata.seriesTitle === "string" ? item.metadata.seriesTitle.trim() : "";
        const fallbackQuery = typeof item.metadata.fallbackQuery === "string" ? item.metadata.fallbackQuery.trim() : "";
        const ruleTitle = metadataQuery || seriesTitle || item.title;
        const sampleSourcePaths = sourcePaths.slice(0, AI_SUPPLEMENT_MAXIMUM_FILE_NAMES_PER_CANDIDATE);
        // 与 Flymby AI 辅助一致，先用本地规则解析代表文件，再把结构化结果作为 samplesJson 提交给模型。
        const fileSamples = sampleSourcePaths.map((sourcePath) => {
          const parsed = parseFlymbyVideoName({
            resourceId: sourcePath.resourceId,
            parentResourceId: null,
            path: sourcePath.path,
            name: sourcePath.name,
            isDirectory: false,
            size: sourcePath.size,
            modifiedAt: sourcePath.modifiedAt,
            etag: null,
            locator: {},
          }, "/");
          const sampleParentPath = path.posix.dirname(sourcePath.path);
          return {
            name: sourcePath.name.slice(0, 500),
            parentPath: sampleParentPath.slice(0, 600),
            parentName: path.posix.basename(sampleParentPath).slice(0, 300),
            parsedTitle: parsed.title.slice(0, 300),
            parsedQuery: parsed.query.slice(0, 300),
            parsedMediaType: parsed.mediaType,
            year: parsed.year,
            seasonNumber: parsed.seasonNumber,
            episodeNumber: parsed.episodeNumber,
            episodeNumbers: parsed.episodeNumbers.slice(0, 20),
          };
        });
        const firstParsedSample = fileSamples[0];
        const normalizedRuleTitle = FlymbyVideoTitleCleaner.normalizeSearchText(ruleTitle);
        const normalizedFileTitle = FlymbyVideoTitleCleaner.normalizeSearchText(
          firstParsedSample?.parsedQuery || firstParsedSample?.parsedTitle || "",
        );
        if (normalizedRuleTitle && normalizedFileTitle
          && normalizedRuleTitle !== normalizedFileTitle
          && !isWeakFlymbyScrapeTitle(firstParsedSample?.parsedQuery || firstParsedSample?.parsedTitle || "")) {
          this.logger.warn({
            日志关键字: "codex-flycloud-helper-ai-clean",
            事件: "AI补充条目标题与源文件识别不一致",
            任务ID: job.id,
            服务ID: job.serviceId,
            媒体条目ID: item.id,
            条目规则标题: ruleTitle,
            文件识别标题: firstParsedSample?.parsedQuery || firstParsedSample?.parsedTitle || "",
            文件名: sampleSourcePaths[0]?.name ?? "",
            文件路径: sampleSourcePaths[0]?.path ?? "",
          });
        }
        for (const sourcePath of sourcePaths) {
          const firstItemId = firstItemIdBySourceFileId.get(sourcePath.fileId);
          if (firstItemId && firstItemId !== item.id && !loggedDuplicateSourceFileIds.has(sourcePath.fileId)) {
            loggedDuplicateSourceFileIds.add(sourcePath.fileId);
            this.logger.warn({
              日志关键字: "codex-flycloud-helper-ai-clean",
              事件: "AI补充发现源文件关联多个顶层条目",
              任务ID: job.id,
              服务ID: job.serviceId,
              源文件ID: sourcePath.fileId,
              源文件路径: sourcePath.path,
              首次媒体条目ID: firstItemId,
              当前媒体条目ID: item.id,
            });
          } else if (!firstItemId) {
            firstItemIdBySourceFileId.set(sourcePath.fileId, item.id);
          }
        }
        workItems.push({
          item,
          sourcePath: {
            path: sourcePaths[0]!.path,
            resourceId: sourcePaths[0]!.resourceId,
            name: sourcePaths[0]!.name,
          },
          context: createStoredAiVideoNameCandidateContext({
            currentDirectoryName: path.posix.basename(directoryPath).slice(0, 300),
            parentDirectoryNames: [
              path.posix.basename(parentDirectoryPath),
              path.posix.basename(path.posix.dirname(parentDirectoryPath)),
            ].filter(Boolean).map((directoryName) => directoryName.slice(0, 300)),
            // 与 Flymby AI 辅助一致，每个电影或节目只提交前 5 个代表文件名。
            fileNames: sampleSourcePaths
              .map((sourcePath) => sourcePath.name.slice(0, 500)),
            fileSamples,
            ruleTitle: ruleTitle.slice(0, 300),
            ruleAlternateTitle: fallbackQuery.slice(0, 300),
            ruleYear: item.year,
            ruleMediaType: item.itemType === "video.series" ? "tv" : "movie",
            recognitionReason: "媒体库未匹配后手动补充",
            resourceIds: sourcePaths.map((sourcePath) => sourcePath.resourceId),
          }),
        });
      }

      // 没有关联活动文件的条目无法构建 AI 上下文，但也必须计入本任务已处理和仍未匹配。
      processedCount += missingSourceCount;
      unmatchedCount += missingSourceCount;
      const requestBatches: StoredAiSupplementWorkItem[][] = [];
      let currentRequestBatch: StoredAiSupplementWorkItem[] = [];
      let currentRequestFileCount = 0;
      for (const workItem of workItems) {
        const fileCount = workItem.context.fileNames.length;
        if (currentRequestBatch.length >= AI_SUPPLEMENT_REQUEST_MAXIMUM_CANDIDATES
          || currentRequestFileCount + fileCount > AI_SUPPLEMENT_REQUEST_MAXIMUM_FILE_NAMES) {
          if (currentRequestBatch.length > 0) requestBatches.push(currentRequestBatch);
          currentRequestBatch = [];
          currentRequestFileCount = 0;
        }
        currentRequestBatch.push(workItem);
        currentRequestFileCount += fileCount;
      }
      if (currentRequestBatch.length > 0) requestBatches.push(currentRequestBatch);

      this.logger.info({
        日志关键字: "codex-flycloud-helper-ai-clean",
        事件: "读取AI补充媒体库批次完成",
        任务ID: job.id,
        服务ID: job.serviceId,
        数据库批次: databaseBatchLabel,
        条目数量: databaseBatch.length,
        有效上下文数量: workItems.length,
        无活动文件数量: missingSourceCount,
        AI子批次数量: requestBatches.length,
      });

      for (let requestBatchIndex = 0; requestBatchIndex < requestBatches.length; requestBatchIndex += 1) {
        if (signal.aborted) throw new Error("AI 补充任务已中断");
        if (await this.applyControlAction(job)) return;
        const requestBatch = requestBatches[requestBatchIndex]!;
        const requestBatchLabel = `${requestBatchIndex + 1}/${requestBatches.length}`;
        await publishBatchProgress(
          `媒体库第 ${databaseBatchLabel} 批，正在执行 AI 子批次 ${requestBatchLabel}`,
          "classifying",
        );
        this.logger.info({
          日志关键字: "codex-flycloud-helper-ai-clean",
          事件: "AI补充子批次开始",
          任务ID: job.id,
          服务ID: job.serviceId,
          数据库批次: databaseBatchLabel,
          AI子批次: requestBatchLabel,
          候选数量: requestBatch.length,
          文件样例数量: requestBatch.reduce((total, workItem) => total + workItem.context.fileNames.length, 0),
        });
        const aiResolution = await this.aiVideoNameCleaner.resolveStoredUnmatchedContexts({
          contexts: requestBatch.map((workItem) => workItem.context),
          snapshot: aiModelSnapshot,
          jobId: job.id,
          userId: job.userId,
          serviceId: job.serviceId,
          taskCache,
          taskFailures,
          signal,
        });

        for (let workItemIndex = 0; workItemIndex < requestBatch.length; workItemIndex += 1) {
          const workItem = requestBatch[workItemIndex]!;
          if (signal.aborted) throw new Error("AI 补充任务已中断");
          const aiResult = aiResolution.results.get(workItem.context.cacheKey);
          try {
            if (!aiResult) {
              const cleanFailure = aiResolution.failures.get(workItem.context.cacheKey);
              unmatchedCount += 1;
              await recordAiSupplementFailure({
                item: workItem.item,
                sourcePath: workItem.sourcePath,
                errorCode: cleanFailure?.errorCode ?? "ai_supplement_clean_result_unavailable",
                error: new Error(cleanFailure?.errorMessage ?? "AI 没有返回可采用的影视名称或类型结果"),
                recovered: false,
                ruleTitle: workItem.context.ruleTitle,
                failureStage: cleanFailure?.stage ?? "validation",
                ruleMediaType: workItem.context.ruleMediaType,
                processingResult: "保持未匹配",
              });
            } else {
              const metadataResolution = await resolveSupplementMetadata(workItem, aiResult);
              if (metadataResolution) {
                const enrichedMetadata = metadataResolution.metadata;
                const applied = await this.repository.applyAiSupplementVideoMatch({
                  itemId: workItem.item.id,
                  userId: job.userId,
                  mediaType: metadataResolution.mediaType,
                  title: enrichedMetadata.title,
                  subtitle: enrichedMetadata.subtitle,
                  year: enrichedMetadata.year,
                  overview: enrichedMetadata.overview,
                  posterUrl: enrichedMetadata.posterUrl,
                  backdropUrl: enrichedMetadata.backdropUrl,
                  externalIds: enrichedMetadata.externalIds,
                  metadata: enrichedMetadata.metadata,
                });
                if (applied) {
                  matchedCount += 1;
                  this.logger.info({
                    日志关键字: "codex-flycloud-helper-ai-clean",
                    事件: "AI补充元数据匹配并写入成功",
                    任务ID: job.id,
                    服务ID: job.serviceId,
                    媒体条目ID: workItem.item.id,
                    原媒体类型: workItem.context.ruleMediaType,
                    最终媒体类型: metadataResolution.mediaType,
                    是否纠正媒体类型: workItem.context.ruleMediaType !== metadataResolution.mediaType,
                    AI查询词: aiResult.cleanedTitle,
                    匹配标题: enrichedMetadata.title,
                  });
                }
                // 任务运行期间已被其他操作匹配不属于 AI 补充失败，不写入失败报告。
                else {
                  unmatchedCount += 1;
                  this.logger.info({
                    日志关键字: "codex-flycloud-helper-ai-clean",
                    事件: "AI补充跳过已被其他操作匹配的条目",
                    任务ID: job.id,
                    服务ID: job.serviceId,
                    媒体条目ID: workItem.item.id,
                  });
                }
              } else {
                unmatchedCount += 1;
                await recordAiSupplementFailure({
                  item: workItem.item,
                  sourcePath: workItem.sourcePath,
                  errorCode: "ai_supplement_metadata_not_matched",
                  error: new Error("AI 已生成查询词，但没有匹配到影视元数据"),
                  recovered: false,
                  ruleTitle: workItem.context.ruleTitle,
                  aiQuery: aiResult.cleanedTitle,
                  failureStage: "metadata",
                  ruleMediaType: workItem.context.ruleMediaType,
                  aiMediaType: aiResult.mediaType,
                  processingResult: "保持未匹配",
                });
              }
            }
          } catch (error) {
            if (isTmdbTemporarilyUnavailableError(error)) {
              await recordAiSupplementFailure({
                item: workItem.item,
                sourcePath: workItem.sourcePath,
                errorCode: error.code,
                error,
                recovered: true,
                ruleTitle: workItem.context.ruleTitle,
                aiQuery: aiResult?.cleanedTitle,
                failureStage: "request",
                ruleMediaType: workItem.context.ruleMediaType,
                aiMediaType: aiResult?.mediaType,
                processingResult: "等待任务自动重试",
              });
              throw error;
            }
            errorCount += 1;
            await recordAiSupplementFailure({
              item: workItem.item,
              sourcePath: workItem.sourcePath,
              errorCode: readFailureCode(error, "ai_supplement_item_failed"),
              error,
              recovered: false,
              ruleTitle: workItem.context.ruleTitle,
              aiQuery: aiResult?.cleanedTitle,
              failureStage: "metadata",
              ruleMediaType: workItem.context.ruleMediaType,
              aiMediaType: aiResult?.mediaType,
              processingResult: "本条处理失败",
            });
            this.logger.warn({
              日志关键字: "codex-flycloud-helper-ai-clean",
              事件: "单条未匹配内容AI补充失败",
              任务ID: job.id,
              服务ID: job.serviceId,
              媒体条目ID: workItem.item.id,
              媒体标题: workItem.item.title,
              规则媒体类型: workItem.context.ruleMediaType,
              AI媒体类型: aiResult?.mediaType ?? "",
              错误码: readFailureCode(error, "ai_supplement_item_failed"),
              错误信息: error instanceof Error ? error.message : "未知错误",
            });
          }
          processedCount += 1;
          if (Date.now() - lastProgressPublishedAt >= 5_000) {
            await publishBatchProgress(
              `媒体库第 ${databaseBatchLabel} 批，正在匹配 AI 子批次 ${requestBatchLabel}（${workItemIndex + 1}/${requestBatch.length}）`,
              "scraping",
            );
            lastProgressPublishedAt = Date.now();
          }
        }
        await publishBatchProgress(
          `媒体库第 ${databaseBatchLabel} 批，AI 子批次 ${requestBatchLabel} 已完成`,
          "scraping",
        );
        lastProgressPublishedAt = Date.now();
        this.logger.info({
          日志关键字: "codex-flycloud-helper-ai-clean",
          事件: "AI补充子批次完成",
          任务ID: job.id,
          服务ID: job.serviceId,
          数据库批次: databaseBatchLabel,
          AI子批次: requestBatchLabel,
          本批条目数量: requestBatch.length,
          累计处理数量: processedCount,
          剩余待补充数量: Math.max(0, unmatchedItems.length - processedCount),
          累计匹配数量: matchedCount,
          累计未匹配数量: unmatchedCount,
          累计错误数量: errorCount,
        });
      }
      if (requestBatches.length === 0) {
        await publishBatchProgress(`媒体库第 ${databaseBatchLabel} 批已完成`, "scraping");
      }
    }

    await this.repository.updateJobProgress(job.id, { stage: "persisting", currentPath: null });
    await this.repository.finishJob(job.id, { status: "completed" });
    const notificationEnabled = await this.readServiceNotificationEnabled(job.serviceId);
    await this.database.createNotificationSafely({
      userId: job.userId,
      category: "task",
      tone: errorCount > 0 ? "warning" : "success",
      title: "AI 补充未识别内容完成",
      message: `服务“${job.serviceName}”的 AI 补充已完成：${matchedCount} 部影片完成了 AI 补充。共处理 ${processedCount} 部，仍未匹配 ${unmatchedCount} 部，错误 ${errorCount} 部。`,
      actionPath: "/app/jobs",
      deliverExternally: notificationEnabled,
    });
    this.logger.info({
      日志关键字: "codex-flycloud-helper-ai-clean",
      事件: "AI补充未匹配任务完成",
      任务ID: job.id,
      服务ID: job.serviceId,
      处理数量: processedCount,
      新增匹配数量: matchedCount,
      仍未匹配数量: unmatchedCount,
      错误数量: errorCount,
      是否访问Provider: false,
    });
  }

  /** 完成 Provider 枚举、分类、刮削、持久化和 generation 对账。 */
  private async scan(job: ScanJobRecord, signal: AbortSignal): Promise<void> {
    const scanStartedAt = Date.now();
    const runtime = await this.repository.getJobRuntimeConfiguration(job);
    const connection = this.vault.decrypt(runtime.encryptedConnection);
    const adapter = this.providers.get(runtime.providerType);
    /** 记录当前任务的脱敏失败信息，扫描业务不依赖报告文件写入结果。 */
    const recordScanFailure = (input: ScanFailureRecordInput): Promise<void> => (
      this.failureReports.record(job, input)
    );
    const roots = readScanRoots(runtime.scanProfile, job.scanMode);
    if (roots.length === 0) {
      throw new ApiError(409, "scan_paths_not_configured", `未配置${job.scanMode === "full" ? "全量" : "增量"}扫描路径`);
    }
    const defaultMediaTypes = readMediaTypes(runtime.scanProfile);
    const musicSourceSettings = defaultMediaTypes.includes("music")
      ? await loadMusicSourceSettings(this.database)
      : { enabledSources: [] as BuiltinMusicPlatformSource[], configurationRevision: 0, source: "default" as const };
    const storedProfiles = runtime.metadataProfile.profiles && typeof runtime.metadataProfile.profiles === "object"
      ? runtime.metadataProfile.profiles as Record<string, unknown>
      : {};
    const storedMusicProfile = readMetadataProfile(runtime.metadataProfile, "music");
    // 关键变量：系统来源集合在任务启动时冻结，当前扫描不会因管理员中途保存而切换平台。
    const effectiveMetadataProfile = defaultMediaTypes.includes("music") ? {
      ...runtime.metadataProfile,
      profiles: {
        ...storedProfiles,
        music: { ...storedMusicProfile, systemEnabledSources: musicSourceSettings.enabledSources },
      },
    } : runtime.metadataProfile;
    const videoMetadataProfile = readMetadataProfile(effectiveMetadataProfile, "video");
    const videoMetadataProviderId = readMetadataProviderId(videoMetadataProfile);
    const musicMetadataProfile = readMetadataProfile(effectiveMetadataProfile, "music");
    const configuredMusicMetadataProviderId = readMetadataProviderId(musicMetadataProfile);
    const musicMetadataProviderId = configuredMusicMetadataProviderId === "builtin.musicbrainz"
      ? "auto"
      : configuredMusicMetadataProviderId || "auto";
    const usesBuiltinTmdb = !videoMetadataProviderId
      || videoMetadataProviderId === "tmdb"
      || videoMetadataProviderId === "builtin.tmdb";
    // 关键变量：前端保存的 metadata.profiles.video.useNfo 是本地 NFO 的唯一开关。
    const useLocalVideoNfo = defaultMediaTypes.includes("video") && videoMetadataProfile.useNfo !== false;
    // 关键变量：旧服务没有 syncDetails 字段时默认关闭，使扫描匹配方式与 Flymby APP 一致。
    const synchronizeVideoDetails = videoMetadataProfile.syncDetails === true;
    // 关键变量：规格分析只收集源文件，真正的 ffprobe 在扫描完成后由独立 Worker 执行。
    const analyzeMediaSpecs = videoMetadataProfile.analyzeMediaSpecs === true;
    const mediaProbeSourceFiles = new Map<string, SourceFileRecord>();
    const tmdbStatusAtStart = this.tmdb.getStatus();
    // 没有配置 Key 或全部 Key 已永久禁用时不可恢复；冷却中的 Key 在建立检查点后进入延迟恢复。
    if (defaultMediaTypes.includes("video")
      && !useLocalVideoNfo
      && usesBuiltinTmdb
      && tmdbStatusAtStart.healthyCount <= 0
      && tmdbStatusAtStart.coolingCount <= 0) {
      this.logger.warn({
        日志关键字: "codex-flycloud-helper-metadata-source",
        事件: "扫描启动前发现没有可用影视元数据源",
        任务ID: job.id,
        使用本地NFO: false,
        TMDB已配置Key数量: tmdbStatusAtStart.configuredCount,
        TMDB已禁用Key数量: tmdbStatusAtStart.disabledCount,
      });
      throw new ApiError(
        409,
        "video_metadata_source_unavailable",
        "未启用本地 NFO，且系统没有可用的 TMDB Key，请先配置至少一个 TMDB Key 或开启本地 NFO",
      );
    }
    const checkpointResult = await this.repository.getOrCreateScanJobCheckpoint(job, runtime.providerType);
    const checkpoint = checkpointResult.checkpoint;
    // Key 临时冷却时仍先进入扫描，让已有 TMDB 共享缓存继续工作；首次缓存未命中再保存检查点并等待恢复。
    const savedProgress = checkpoint.progress;
    // 关键变量：暂停、进程退出和再次领取任务时始终复用同一 generation，避免续扫被当成新扫描。
    const generationId = checkpoint.generationId;
    let enumeratedEntryCount = savedProgress.enumeratedEntryCount;
    let scannedMediaCount = savedProgress.scannedMediaCount;
    // 关键变量：安全检查点可能落后于暂停前页面进度；重放窗口期间页面仍保留已展示过的扫描数量。
    const visibleScannedMediaHighWater = Math.max(savedProgress.scannedMediaCount, job.discoveredCount);
    let skippedCount = savedProgress.skippedCount;
    // 关键变量：统计本轮全量扫描直接复用的已匹配源文件，便于区分枚举耗时与重复刮削耗时。
    let reusedMatchedSourceFileCount = 0;
    // 关键变量：区分NFO缓存命中和真实网盘下载，便于确认重复扫描的网络请求是否下降。
    let reusedNfoSidecarCount = 0;
    let downloadedNfoSidecarCount = 0;
    const providerWarningKeys = new Set(savedProgress.providerWarningKeys);
    let currentScanPath: string | null = savedProgress.currentScanPath;
    let lastProgressPublishedAt = 0;
    let lastProgressPublishedMediaCount = scannedMediaCount;
    // 关键变量：前端按 5 秒轮询任务，Worker 使用相同间隔写入任务表，避免无效高频数据库更新。
    const progressPublishIntervalMs = 5_000;
    // 关键变量：同一目录音乐过多时分批进入标签读取和落库链路，避免枚举结束后才一次性开始处理。
    const musicDirectoryBatchSize = 16;
    // 关键变量：Provider 枚举很快时也按文件增量发布一次，避免页面长时间停在第一个文件。
    const progressPublishMediaStep = 50;
    // 关键变量：跨进程控制最多每 500ms 读取一次数据库；同进程控制仍由 AbortSignal 立即打断。
    const jobControlPollIntervalMs = 500;
    let nextJobControlPollAt = 0;
    // 关键变量：影视按完整电影或节目聚合统计，音乐按每个曲目源文件统计。
    const businessProgress = createBusinessTaskProgress(savedProgress);
    // 关键变量：重试任务必须重新处理上次已落库的未匹配文件，不能套用普通增量扫描的未变更跳过规则。
    const isRetryJob = typeof job.snapshot.retryOfJobId === "string" && job.snapshot.retryOfJobId.length > 0;
    // 仅把真实变化的媒体条目写入目录变化流，避免每轮扫描生成全量 upsert。
    const changedItemIds = new Set(checkpoint.changedItemIds);
    // 关键变量：任务级刮削缓存，避免同一节目数百个单集重复请求 TMDB。
    const metadataCache: ScanMetadataCache = {
      video: new Map(),
      seasons: new Map(),
      music: new Map(),
      parentItems: new Map(),
      aiResults: new Map(),
      aiContexts: new Map(),
      aiUsageOwner: { userId: job.userId, serviceId: job.serviceId },
    };
    // 关键变量：已经在目录枚举中读取的 NFO，按远端绝对路径索引且不写入凭据。
    const nfoSidecars = restoreNfoSidecars(checkpoint.nfoSidecars);
    const recommendedSettings = adapter.descriptor.recommendedScanSettings;
    const configuredScanDirectoryConcurrency = readProviderConcurrency(
      runtime.scanProfile.scanDirectoryConcurrency,
      recommendedSettings.scanDirectoryConcurrency,
    );
    // 关键变量：全量和增量扫描都使用当前服务自己的任务数，Provider 参数只负责提供初始默认值。
    const effectiveScanDirectoryConcurrency = configuredScanDirectoryConcurrency;
    const configuredScrapeTaskConcurrency = readProviderConcurrency(
      runtime.scanProfile.scrapeTaskConcurrency,
      recommendedSettings.scrapeTaskConcurrency,
    );
    // 关键变量：影片解析和落库使用 APP 配置的任务并发；TMDB Key 池在请求层独立限制网络并发。
    const scrapeConcurrency = Math.max(1, configuredScrapeTaskConcurrency);
    // 关键变量：音乐标签读取使用云助手内置四任务并发，不接受APP同步参数覆盖。
    const audioTagConcurrency = 4;
    const tmdbRequestConcurrency = this.tmdb.getStatus().effectiveConcurrency;
    const metadataProfileRevision = Number(job.snapshot.metadataProfileRevision ?? 0);
    // 关键变量：任务始终使用创建时冻结的模型修订，暂停恢复后也不会切换到新配置。
    const aiModelSnapshot = readAiModelTaskSnapshot(job.snapshot.aiModel);
    const videoRecognitionRevision = buildAiRecognitionRevision(metadataProfileRevision, aiModelSnapshot);
    const recognitionRevision = defaultMediaTypes.includes("music")
      ? `${videoRecognitionRevision}-${MUSIC_SCRAPE_RECOGNITION_REVISION}-sources-r${musicSourceSettings.configurationRevision}`
      : videoRecognitionRevision;
    if (defaultMediaTypes.includes("music")) {
      this.logger.info({
        日志关键字: "codex-flycloud-helper-music-source-config",
        事件: "音乐扫描已加载刮削来源配置",
        任务ID: job.id,
        启用来源: musicSourceSettings.enabledSources,
        启用来源数量: musicSourceSettings.enabledSources.length,
        配置修订: musicSourceSettings.configurationRevision,
      });
    }
    this.logger.info({
      日志关键字: "codex-flycloud-helper-ai-clean",
      事件: "读取扫描任务AI清洗快照",
      任务ID: job.id,
      是否启用AI清洗: aiModelSnapshot !== null,
      模型ID: aiModelSnapshot?.modelId ?? "无",
      模型修订: aiModelSnapshot?.configurationRevision ?? 0,
      触发策略: aiModelSnapshot?.triggerMode ?? "disabled",
      有效识别修订: recognitionRevision,
    });
    // 关键变量：同一节目目录内的单集落库允许并发，远端数据库连接池负责限制部署级总连接数。
    const mediaFilePersistenceConcurrency = 4;
    // 关键变量：只缓存当前目录，目录枚举完成后立即加入刮削队列，避免等待全盘扫描结束。
    let activeDirectoryKey: string | null = null;
    let activeDirectoryItems: PendingDirectoryMedia[] = [];
    let scannedDirectoryCount = savedProgress.scannedDirectoryCount;
    const pendingBusinessTasks = new Set<Promise<void>>();
    // 关键变量：目录识别和源文件准备异步执行，Provider 枚举不再等待远端数据库写入。
    const pendingDirectoryFlushTasks = new Set<Promise<PendingDirectoryFlushResult>>();
    // 关键变量：源文件批量准备固定最多 4 路，不用无界数据库并发换取表面扫描速度。
    const sourcePreparationConcurrency = Math.max(1, Math.min(4, configuredScanDirectoryConcurrency));
    const sourcePreparationChains = Array.from({ length: sourcePreparationConcurrency }, () => Promise.resolve());
    let nextSourcePreparationWorkerIndex = 0;
    // 关键变量：任意刮削任务发现全部 TMDB Key 临时不可用后，停止提交新结果并在安全窗口回退。
    let tmdbRecoveryError: TmdbTemporarilyUnavailableError | null = null;
    // 同一节目可能跨多个季目录，必须串行处理这些目录片段，避免相互覆盖同一节目状态。
    const businessTaskChains = new Map<string, Promise<void>>();
    // 关键变量：固定数量的刮削执行链对应 TMDB Key 动态并发，等待队列本身不会额外占用并发。
    const scrapeWorkerChains = Array.from({ length: scrapeConcurrency }, () => Promise.resolve());
    let nextScrapeWorkerIndex = 0;
    const movieTaskKeys = new Set(savedProgress.movieTaskKeys);
    const seriesTaskKeys = new Set(savedProgress.seriesTaskKeys);
    // 关键变量：恢复后第一个检查点窗口会重放，期间不能把已写源文件误判成普通增量未变化项。
    const restoredCheckpointSequence = readCheckpointSequence(checkpoint.providerState);
    // 首个安全游标尚未生成时也要重放起始窗口，否则增量恢复会把已写源文件误判为未变化而漏刮削。
    let replayingCheckpointWindow = checkpointResult.restored;
    let checkpointCandidate: ProviderEnumerationCheckpoint | null = null;
    let savedCheckpointSequence = restoredCheckpointSequence;
    let scheduledCheckpointSequence = restoredCheckpointSequence;
    let checkpointCommitError: unknown | null = null;
    // 关键变量：检查点按 Provider 序号串行提交，但不阻塞后续目录枚举。
    let checkpointCommitChain: Promise<void> = Promise.resolve();
    // 关键变量：源文件使用所属扫描根的稳定 generation，完整根才能独立执行缺失对账。
    const scanRootGenerations = new Map<string, string>();
    /** 把当前业务任务集合和扫描路径发布到数据库，供 5 秒轮询页面读取。 */
    const publishProgress = async (stage: "enumerating" | "scraping" | "persisting"): Promise<void> => {
      await this.repository.updateJobProgress(job.id, {
        stage,
        processedCount: getHandledBusinessTaskCount(businessProgress),
        totalCount: businessProgress.taskKeys.size,
        discoveredCount: Math.max(scannedMediaCount, visibleScannedMediaHighWater),
        skippedCount,
        matchedCount: businessProgress.matchedKeys.size,
        unmatchedCount: businessProgress.unmatchedKeys.size,
        errorCount: businessProgress.failedKeys.size,
        currentPath: currentScanPath,
      });
      lastProgressPublishedAt = Date.now();
      lastProgressPublishedMediaCount = scannedMediaCount;
    };
    /** 控制扫描中进度写入频率；前端每 5 秒读取一次，数据库使用相同更新间隔。 */
    const shouldPublishProgress = (): boolean => enumeratedEntryCount === 1
      || scannedMediaCount - lastProgressPublishedMediaCount >= progressPublishMediaStep
      || Date.now() - lastProgressPublishedAt >= progressPublishIntervalMs;

    /** 等待当前刮削任务或一个进度发布窗口，完成较快时及时进入下一批而不遗留定时器。 */
    const waitForScrapeProgressWindow = async (tasks: Promise<void>[]): Promise<void> => {
      let progressTimer: ReturnType<typeof setTimeout> | null = null;
      const progressWindow = new Promise<void>((resolve) => {
        progressTimer = setTimeout(resolve, progressPublishIntervalMs);
      });
      await Promise.race([
        Promise.allSettled(tasks).then(() => undefined),
        progressWindow,
      ]);
      if (progressTimer) clearTimeout(progressTimer);
    };

    /** Provider 枚举结束后持续排空刮削队列，并每 5 秒把真实处理数量同步到任务表。 */
    const waitForBusinessTasksWithProgress = async (): Promise<void> => {
      let lastLoggedHandledCount = getHandledBusinessTaskCount(businessProgress);
      while (pendingBusinessTasks.size > 0) {
        await waitForScrapeProgressWindow([...pendingBusinessTasks]);
        const handledCount = getHandledBusinessTaskCount(businessProgress);
        const queueDrained = pendingBusinessTasks.size === 0;
        if (queueDrained || Date.now() - lastProgressPublishedAt >= progressPublishIntervalMs) {
          await publishProgress("scraping");
        }
        if (queueDrained || handledCount - lastLoggedHandledCount >= 100) {
          this.logger.info({
            日志关键字: "codex-flycloud-helper-task-progress",
            事件: queueDrained ? "刮削队列已排空" : "刮削队列进度已发布",
            任务ID: job.id,
            已处理影片数量: handledCount,
            影片任务总数量: businessProgress.taskKeys.size,
            待完成刮削数量: pendingBusinessTasks.size,
          });
          lastLoggedHandledCount = handledCount;
        }
      }
    };
    this.logger.info({
      日志关键字: "codex-flycloud-helper-worker-tuning",
      性能日志关键字: "codex-flycloud-scan-performance",
      事件: "扫描刮削并发已确定",
      任务ID: job.id,
      网盘类型: runtime.providerType,
      扫描模式: job.scanMode,
      扫描配置并发: configuredScanDirectoryConcurrency,
      扫描实际并发: effectiveScanDirectoryConcurrency,
      刮削配置并发: configuredScrapeTaskConcurrency,
      影片任务实际并发: scrapeConcurrency,
      单任务文件落库并发: mediaFilePersistenceConcurrency,
      TMDB请求实际并发: tmdbRequestConcurrency,
      源文件准备并发: sourcePreparationConcurrency,
      TMDB可用Key数量: this.tmdb.getStatus().healthyCount,
    });
    this.logger.info({
      日志关键字: "codex-flycloud-helper-title-clean-alignment",
      事件: "Flymby APP同源文件名清洗已启用",
      任务ID: job.id,
      清洗规则版本: "webdav-video-name-parser-2026-08-20",
      清洗范围: "站点标签、资源规格、编码位深、音轨字幕、平台与发布组",
    });
    this.logger.info({
      日志关键字: "codex-flycloud-helper-discovery-decoupled",
      事件: "目录发现已与源文件写入和详情刮削解耦",
      任务ID: job.id,
      源文件准备并发: sourcePreparationConcurrency,
      刮削执行并发: scrapeConcurrency,
      目录发现是否等待刮削: false,
      任务控制数据库轮询毫秒: jobControlPollIntervalMs,
    });
    this.logger.info({
      日志关键字: "codex-flycloud-helper-scrape-flow",
      事件: "影视扫描元数据流程已确定",
      任务ID: job.id,
      本地NFO优先: useLocalVideoNfo,
      元数据来源: videoMetadataProviderId || "builtin.tmdb",
      同步刮削详情: synchronizeVideoDetails,
      扫描模式: job.scanMode,
    });
    if (defaultMediaTypes.includes("music")) {
      this.logger.info({
        日志关键字: "codex-flycloud-helper-music-scan",
        事件: "音乐扫描主链路已启动",
        任务ID: job.id,
        服务ID: job.serviceId,
        元数据来源: musicMetadataProviderId,
        标签读取并发: audioTagConcurrency,
        扫描模式: job.scanMode,
      });
    }
    this.logger.info({
      日志关键字: "codex-flycloud-helper-checkpoint",
      事件: checkpointResult.restored ? "扫描任务已恢复检查点" : "扫描任务已建立检查点",
      任务ID: job.id,
      扫描会话ID: checkpoint.scanSessionId,
      扫描代次ID: generationId,
      Provider游标序号: restoredCheckpointSequence,
      恢复扫描视频数量: scannedMediaCount,
      页面保留扫描视频数量: visibleScannedMediaHighWater,
      恢复处理影片数量: getHandledBusinessTaskCount(businessProgress),
    });

    /** 记录并合并并发刮削任务返回的 TMDB 临时错误，优先使用最早恢复时间。 */
    const rememberTmdbRecoveryError = (error: unknown): boolean => {
      if (!isTmdbTemporarilyUnavailableError(error)) return false;
      const currentRetryAt = tmdbRecoveryError ? Date.parse(tmdbRecoveryError.nextRetryAt) : Number.POSITIVE_INFINITY;
      const candidateRetryAt = Date.parse(error.nextRetryAt);
      if (!tmdbRecoveryError || candidateRetryAt < currentRetryAt) {
        tmdbRecoveryError = error;
      }
      return true;
    };

    /** 等待已经发现的目录完成准备，并排空它们产生的刮削任务。 */
    const drainScanPipeline = async (): Promise<void> => {
      await Promise.allSettled([...pendingDirectoryFlushTasks]);
      await Promise.allSettled([...pendingBusinessTasks]);
    };

    /** 等待已经入队的目录和刮削链结束，再把恢复信号抛给任务状态机。 */
    const throwTmdbRecoveryAfterDraining = async (): Promise<void> => {
      if (!tmdbRecoveryError) return;
      const recoveryError = tmdbRecoveryError;
      await drainScanPipeline();
      throw recoveryError;
    };

    /** 完成一个完整电影或节目目录片段，全部文件结束后才更新该业务任务统计。 */
    const processBusinessTask = async (
      businessTaskKey: string,
      taskItems: PendingBusinessMedia[],
    ): Promise<void> => {
      const taskPersistenceStartedAt = Date.now();
      let successfulFileCount = 0;
      const successfullyPersistedSourceFileIds: string[] = [];
      let matched = false;
      let providerUnavailableFileCount = 0;
      let nextTaskItemIndex = 0;
      /** 领取当前电影或节目中的下一个文件，避免节目单集对远端数据库逐条串行等待。 */
      const processNextTaskItem = async (): Promise<void> => {
        while (!tmdbRecoveryError && !signal.aborted) {
          const taskItemIndex = nextTaskItemIndex;
          nextTaskItemIndex += 1;
          const item = taskItems[taskItemIndex];
          if (!item) return;
          const { candidate, descriptor } = item;
          if (!candidate.sourceFile) {
            const preparationError = candidate.preparationError ?? new Error("源文件记录未准备完成");
            await recordScanFailure({
              stage: "persisting",
              errorCode: readFailureCode(preparationError, "source_file_prepare_failed"),
              error: preparationError,
              recovered: false,
              mediaPath: candidate.entry.path,
              resourceId: candidate.entry.resourceId,
              fileName: candidate.entry.name,
              itemType: descriptor.itemType,
              parsedTitle: descriptor.title,
              businessTaskKey,
            });
            this.logMediaItemFailure(
              job.id,
              candidate.entry.resourceId,
              preparationError,
            );
            continue;
          }
          try {
            const mediaResult = await this.persistScannedMedia({
              job,
              descriptor,
              sourceFile: candidate.sourceFile,
              entryLocator: candidate.entry.locator,
              generationId,
              metadataProfiles: effectiveMetadataProfile,
              metadataCache,
              nfoSidecars,
              forceCatalogChange: isRetryJob,
              signal,
            });
            if (signal.aborted) break;
            successfulFileCount += 1;
            successfullyPersistedSourceFileIds.push(candidate.sourceFile.id);
            matched = matched || mediaResult.matched;
            if (mediaResult.providerUnavailable) providerUnavailableFileCount += 1;
            mediaResult.changedItemIds.forEach((itemId) => changedItemIds.add(itemId));
            if (!mediaResult.matched) {
              const errorCode = mediaResult.providerUnavailable
                ? "metadata_provider_unavailable"
                : "metadata_not_matched";
              await recordScanFailure({
                stage: "scraping",
                errorCode,
                error: new Error(mediaResult.providerUnavailable
                  ? "当前没有可用的元数据来源"
                  : descriptor.mediaType === "music" ? "没有匹配到音乐元数据" : "没有匹配到影视元数据"),
                recovered: false,
                mediaPath: candidate.entry.path,
                resourceId: candidate.entry.resourceId,
                fileName: candidate.entry.name,
                itemType: descriptor.itemType,
                parsedTitle: descriptor.title,
                businessTaskKey,
                context: {
                  使用元数据Provider: descriptor.mediaType === "music"
                    ? musicMetadataProviderId
                    : readMetadataProviderId(videoMetadataProfile) || "builtin.tmdb",
                },
              });
            }
          } catch (error) {
            if (signal.aborted) break;
            if (rememberTmdbRecoveryError(error)) {
              const recoveryError = error as TmdbTemporarilyUnavailableError;
              this.logger.warn({
                日志关键字: "codex-flycloud-helper-tmdb-recovery",
                事件: "影片刮削触发任务级延迟恢复",
                任务ID: job.id,
                影片任务标识: businessTaskKey,
                下次重试时间: recoveryError.nextRetryAt,
              });
              break;
            }
            await recordScanFailure({
              stage: "scraping",
              errorCode: readFailureCode(error, "media_item_failed"),
              error,
              recovered: false,
              mediaPath: candidate.entry.path,
              resourceId: candidate.entry.resourceId,
              fileName: candidate.entry.name,
              itemType: descriptor.itemType,
              parsedTitle: descriptor.title,
              businessTaskKey,
            });
            this.logMediaItemFailure(job.id, candidate.entry.resourceId, error);
          }
        }
      };
      const taskFileWorkerCount = Math.min(mediaFilePersistenceConcurrency, taskItems.length);
      await Promise.all(Array.from({ length: taskFileWorkerCount }, () => processNextTaskItem()));
      try {
        await this.repository.markSourceFilesMetadataProcessed(
          successfullyPersistedSourceFileIds,
          metadataProfileRevision,
          recognitionRevision,
        );
      } catch (error) {
        // 标记失败只会让下次全量扫描重新处理，不影响本次已经落库的数据。
        this.logger.warn({
          日志关键字: "codex-flycloud-helper-persist-concurrency",
          事件: "源文件元数据修订批量标记失败",
          任务ID: job.id,
          文件数量: successfullyPersistedSourceFileIds.length,
          错误信息: error instanceof Error ? error.message : "未知数据库错误",
        });
      }
      const taskPersistenceElapsedMs = Date.now() - taskPersistenceStartedAt;
      if (taskItems.length >= 20 || taskPersistenceElapsedMs >= 3_000) {
        this.logger.info({
          日志关键字: "codex-flycloud-helper-persist-concurrency",
          事件: "影片任务文件并发落库完成",
          任务ID: job.id,
          文件数量: taskItems.length,
          文件落库并发: taskFileWorkerCount,
          数据库与元数据耗时毫秒: taskPersistenceElapsedMs,
          成功文件数量: successfulFileCount,
        });
      }
      // 当前窗口将从上一安全检查点重放，因此临时失败任务不写入成功、未匹配或错误统计。
      if (tmdbRecoveryError || signal.aborted) return;
      if (successfulFileCount > 0 && (matched || providerUnavailableFileCount < successfulFileCount)) {
        recordBusinessTaskSuccess(businessProgress, businessTaskKey, matched);
      } else {
        recordBusinessTaskFailure(businessProgress, businessTaskKey);
      }
    };

    /** 把目录识别结果立即送入刮削队列；同一电影或节目跨目录时按加入顺序串行执行。 */
    const enqueueBusinessTask = (businessTaskKey: string, taskItems: PendingBusinessMedia[]): Promise<void> => {
      const previousTask = businessTaskChains.get(businessTaskKey) ?? Promise.resolve();
      const workerIndex = nextScrapeWorkerIndex % scrapeWorkerChains.length;
      nextScrapeWorkerIndex += 1;
      const previousWorkerTask = scrapeWorkerChains[workerIndex] ?? Promise.resolve();
      const mediaTask = Promise.all([
        previousTask.catch(() => undefined),
        previousWorkerTask.catch(() => undefined),
      ])
        .then(() => processBusinessTask(businessTaskKey, taskItems));
      scrapeWorkerChains[workerIndex] = mediaTask;
      businessTaskChains.set(businessTaskKey, mediaTask);
      pendingBusinessTasks.add(mediaTask);
      void mediaTask.finally(() => {
        pendingBusinessTasks.delete(mediaTask);
        if (businessTaskChains.get(businessTaskKey) === mediaTask) {
          businessTaskChains.delete(businessTaskKey);
        }
      }).catch(() => undefined);
      return mediaTask;
    };

    /** 为当前目录需要处理的音乐读取或复用标签，并将结果合并进音乐描述。 */
    const applyDirectoryAudioTags = async (
      descriptors: Map<string, MediaDescriptor>,
      directoryItems: PendingDirectoryMedia[],
      directoryKey: string | null,
    ): Promise<void> => {
      const musicCandidates = directoryItems.filter((candidate) => (
        candidate.shouldProcess
        && candidate.sourceFile !== null
        && descriptors.get(candidate.entry.resourceId)?.mediaType === "music"
      ));
      if (musicCandidates.length === 0) return;
      let nextCandidateIndex = 0;
      let cacheHitCount = 0;
      let readSuccessCount = 0;
      let emptyTagCount = 0;
      let readFailureCount = 0;
      let embeddedArtworkCount = 0;
      let extractedArtworkCount = 0;
      let technicalSpecificationCount = 0;
      const readNextCandidate = async (): Promise<void> => {
        while (!signal.aborted) {
          const candidateIndex = nextCandidateIndex;
          nextCandidateIndex += 1;
          const candidate = musicCandidates[candidateIndex];
          if (!candidate?.sourceFile) return;
          const descriptor = descriptors.get(candidate.entry.resourceId);
          if (!descriptor) continue;
          const fingerprint = createAudioTagFingerprint(candidate.entry);
          try {
            let tagResult = await this.repository.readAudioTagCache(candidate.sourceFile.id, fingerprint);
            if (tagResult) {
              cacheHitCount += 1;
            } else {
              if (!adapter.resolveFileStreamAccess) {
                readFailureCount += 1;
                descriptors.set(candidate.entry.resourceId, {
                  ...descriptor,
                  metadata: { ...descriptor.metadata, tagStatus: "failed", tagErrorCode: "provider_stream_unsupported" },
                });
                continue;
              }
              const access = await adapter.resolveFileStreamAccess(
                connection,
                candidate.entry.locator,
                signal,
                {
                  persistConnection: async (nextConnection) => {
                    const credentialRevision = Number(job.snapshot.credentialRevision);
                    await this.repository.refreshActiveEncryptedConnection({
                      serviceId: job.serviceId,
                      userId: job.userId,
                      credentialRevision,
                      encryptedConnection: this.vault.encrypt(nextConnection),
                    });
                  },
                },
              );
              tagResult = await readRemoteAudioTags({
                config: this.config,
                access,
                fileName: candidate.entry.name,
                signal,
              });
              // 临时网络或ffprobe错误不写入稳定缓存，下次扫描仍可重新读取。
              if (tagResult.status !== "failed") {
                await this.repository.saveAudioTagCache({
                  sourceFile: candidate.sourceFile,
                  fingerprint,
                  result: tagResult,
                });
              }
            }
            if (tagResult.status === "failed") {
              readFailureCount += 1;
              descriptors.set(candidate.entry.resourceId, {
                ...descriptor,
                metadata: {
                  ...descriptor.metadata,
                  tagStatus: "failed",
                  tagErrorCode: tagResult.errorCode ?? "audio_tag_failed",
                },
              });
              continue;
            }
            if (tagResult.artwork.embedded) embeddedArtworkCount += 1;
            if (tagResult.artwork.url) extractedArtworkCount += 1;
            if (tagResult.technical.codec || tagResult.technical.container || tagResult.technical.sampleRate > 0) {
              technicalSpecificationCount += 1;
            }
            if (tagResult.status === "empty") emptyTagCount += 1;
            else readSuccessCount += 1;
            descriptors.set(candidate.entry.resourceId, applyAudioTagsToDescriptor(descriptor, tagResult));
          } catch (error) {
            readFailureCount += 1;
            descriptors.set(candidate.entry.resourceId, {
              ...descriptor,
              metadata: {
                ...descriptor.metadata,
                tagStatus: "failed",
                tagErrorCode: readFailureCode(error, "audio_tag_failed"),
              },
            });
            this.logger.warn({
              日志关键字: "codex-flycloud-helper-music-scan",
              事件: "音乐标签读取降级",
              任务ID: job.id,
              服务ID: job.serviceId,
              源文件ID: candidate.sourceFile.id,
              音频格式: getFileExtension(candidate.entry.name),
              错误码: readFailureCode(error, "audio_tag_failed"),
            });
          }
        }
      };
      const workerCount = Math.min(audioTagConcurrency, musicCandidates.length);
      await Promise.all(Array.from({ length: workerCount }, () => readNextCandidate()));
      this.logger.info({
        日志关键字: "codex-flycloud-helper-music-scan",
        事件: "目录音乐标签处理完成",
        任务ID: job.id,
        服务ID: job.serviceId,
        目录标识: directoryKey,
        音乐文件数量: musicCandidates.length,
        标签缓存命中数量: cacheHitCount,
        标签读取成功数量: readSuccessCount,
        无标签数量: emptyTagCount,
        标签读取失败数量: readFailureCount,
        成功读取音频规格数量: technicalSpecificationCount,
        检测到内嵌封面数量: embeddedArtworkCount,
        成功缓存内嵌封面数量: extractedArtworkCount,
      });
    };

    /** 当前目录枚举结束后提交异步准备，Provider 目录发现不等待数据库和 TMDB。 */
    const flushActiveDirectory = async (): Promise<void> => {
      const directoryItems = activeDirectoryItems;
      const flushedDirectoryKey = activeDirectoryKey;
      activeDirectoryItems = [];
      activeDirectoryKey = null;
      if (directoryItems.length === 0) return;

      scannedDirectoryCount += 1;
      const firstItem = directoryItems[0];
      if (!firstItem) return;
      const candidatesToPrepare = directoryItems.filter((candidate) => candidate.shouldProcess);
      const directoryEntries = directoryItems.map((item) => item.entry);
      const ruleParsedVideos = parseMediaDirectory(
        directoryEntries,
        firstItem.rootTypes,
        firstItem.rootPath,
      );
      const ruleDescriptors = buildMediaDirectoryDescriptors(
        directoryEntries,
        firstItem.rootTypes,
        firstItem.rootPath,
        ruleParsedVideos,
      );
      const videoFileNames = directoryItems.map((item) => item.entry.name);
      const explicitEpisodeFileCount = videoFileNames.filter((fileName) =>
        /(?:s\s*\d{1,2}\s*e\s*\d{1,4}|第\s*[0-9一二三四五六七八九十两]{1,4}\s*集)/iu.test(fileName),
      ).length;
      const dateEpisodeFileCount = videoFileNames.filter((fileName) =>
        /(?:^|\D)(?:19|20)\d{2}[01]\d[0-3]\d(?:\D|$)/u.test(fileName),
      ).length;
      const recognizedEpisodeCount = [...ruleDescriptors.values()].filter((descriptor) =>
        descriptor.itemType === "video.episode",
      ).length;
      const directoryName = path.posix.basename(String(flushedDirectoryKey ?? ""));
      const movieTextConflictCorrected = /(?:影片|电影)/u.test(directoryName)
        && explicitEpisodeFileCount > 0
        && recognizedEpisodeCount > 0;
      const dateEpisodeRuleApplied = dateEpisodeFileCount >= 2 && recognizedEpisodeCount >= 2;
      if (movieTextConflictCorrected || dateEpisodeRuleApplied) {
        this.logger.info({
          日志关键字: "codex-video-recognition-optimize",
          事件: "目录节目判型优化规则生效",
          任务ID: job.id,
          目录标识: flushedDirectoryKey,
          识别依据: movieTextConflictCorrected ? "显式季集标记优先" : "八位播出日期序列",
          显式季集文件数量: explicitEpisodeFileCount,
          日期节目文件数量: dateEpisodeFileCount,
          已识别节目文件数量: recognizedEpisodeCount,
        });
      }
      const sourceWorkerIndex = nextSourcePreparationWorkerIndex % sourcePreparationChains.length;
      nextSourcePreparationWorkerIndex += 1;
      const previousSourceTask = sourcePreparationChains[sourceWorkerIndex] ?? Promise.resolve();
      const directoryFlushTask = previousSourceTask
        .catch(() => undefined)
        .then(async (): Promise<PendingDirectoryFlushResult> => {
          if (signal.aborted || tmdbRecoveryError) return { businessTasks: [], skippedCount: 0, businessTaskKeys: [] };
          const sourceBatchStartedAt = Date.now();
          let directorySkippedCount = 0;
          let descriptors = ruleDescriptors;
          let aiContextsByResourceId = buildAiVideoNameCandidateContexts(directoryEntries, ruleParsedVideos);
          try {
            const preparedFiles = await this.repository.prepareSourceFiles(
              candidatesToPrepare.map((candidate) => candidate.sourceFileInput),
            );
            if (analyzeMediaSpecs) {
              preparedFiles.forEach((prepared) => mediaProbeSourceFiles.set(prepared.sourceFile.id, prepared.sourceFile));
            }
            preparedFiles.forEach((prepared, index) => {
              const candidate = candidatesToPrepare[index];
              if (!candidate) return;
              candidate.sourceFile = prepared.sourceFile;
              if (candidate.skipIfUnchanged && prepared.unchanged) {
                candidate.shouldProcess = false;
                candidate.reusedMatchedCatalog = prepared.reusedMatchedCatalog;
                skippedCount += 1;
                directorySkippedCount += 1;
                if (job.scanMode === "full" && candidate.reusedMatchedCatalog) {
                  reusedMatchedSourceFileCount += 1;
                  const reusedDescriptor = descriptors.get(candidate.entry.resourceId);
                  if (reusedDescriptor) {
                    const reusedTaskKey = readBusinessTaskKey(reusedDescriptor);
                    recordBusinessTaskSuccess(businessProgress, reusedTaskKey, true);
                    if (reusedDescriptor.itemType === "video.movie") movieTaskKeys.add(reusedTaskKey);
                    else seriesTaskKeys.add(reusedTaskKey);
                  }
                }
              }
            });
            const sourceBatchElapsedMs = Date.now() - sourceBatchStartedAt;
            if (candidatesToPrepare.length >= 100 || sourceBatchElapsedMs >= 1_000) {
              this.logger.info({
                日志关键字: "codex-flycloud-helper-source-batch",
                性能日志关键字: "codex-flycloud-scan-performance",
                事件: "目录源文件批量准备完成",
                任务ID: job.id,
                目录标识: flushedDirectoryKey,
                文件数量: candidatesToPrepare.length,
                复用已匹配文件数量: preparedFiles.filter((prepared) => prepared.reusedMatchedCatalog).length,
                数据库耗时毫秒: sourceBatchElapsedMs,
              });
            }
          } catch (error) {
            candidatesToPrepare.forEach((candidate) => {
              candidate.preparationError = error;
            });
            this.logger.warn({
              日志关键字: "codex-flycloud-helper-source-batch",
              性能日志关键字: "codex-flycloud-scan-performance",
              事件: "目录源文件批量准备失败",
              任务ID: job.id,
              目录标识: flushedDirectoryKey,
              文件数量: candidatesToPrepare.length,
              错误信息: error instanceof Error ? error.message : "未知数据库错误",
            });
          }
          if (signal.aborted || tmdbRecoveryError) {
            return { businessTasks: [], skippedCount: directorySkippedCount, businessTaskKeys: [] };
          }

          await applyDirectoryAudioTags(descriptors, directoryItems, flushedDirectoryKey);

          // 关键变量：先完成源文件复用判断，只为本轮确实需要处理且没有同目录 NFO 的弱标题调用模型。
          const directoryPath = path.posix.dirname(firstItem.entry.path);
          const directoryHasNfo = [...nfoSidecars.keys()].some((nfoPath) => path.posix.dirname(nfoPath) === directoryPath);
          if (firstItem.rootTypes.includes("video")
            && aiModelSnapshot
            && !directoryHasNfo
            && directoryItems.some((candidate) => candidate.shouldProcess)) {
            const cleanedDirectory = await this.aiVideoNameCleaner.cleanWeakDirectory({
              entries: directoryEntries,
              parsedVideos: ruleParsedVideos,
              snapshot: aiModelSnapshot,
              jobId: job.id,
              userId: job.userId,
              serviceId: job.serviceId,
              taskCache: metadataCache.aiResults,
              signal,
            });
            descriptors = buildMediaDirectoryDescriptors(
              directoryEntries,
              firstItem.rootTypes,
              firstItem.rootPath,
              cleanedDirectory.parsedVideos,
            );
            aiContextsByResourceId = cleanedDirectory.contextsByResourceId;
          }

          const expectedMusicCandidateCount = directoryItems.filter((candidate) => (
            candidate.shouldProcess
            && candidate.rootTypes.includes("music")
            && !candidate.rootTypes.includes("video")
          )).length;
          const directoryTasks = new Map<string, PendingBusinessMedia[]>();
          let directoryMusicCandidateCount = 0;
          for (const candidate of directoryItems) {
            if (!candidate.shouldProcess) continue;
            const descriptor = descriptors.get(candidate.entry.resourceId);
            if (!descriptor) continue;
            if (descriptor.mediaType === "music") directoryMusicCandidateCount += 1;
            const businessTaskKey = readBusinessTaskKey(descriptor);
            const aiContext = aiContextsByResourceId.get(candidate.entry.resourceId);
            if (aiContext) metadataCache.aiContexts.set(businessTaskKey, aiContext);
            const taskItems = directoryTasks.get(businessTaskKey) ?? [];
            taskItems.push({ descriptor, candidate });
            directoryTasks.set(businessTaskKey, taskItems);
            businessProgress.taskKeys.add(businessTaskKey);
            if (descriptor.itemType === "video.movie") movieTaskKeys.add(businessTaskKey);
            else if (descriptor.itemType === "video.series" || descriptor.itemType === "video.episode") {
              seriesTaskKeys.add(businessTaskKey);
            }
          }
          const businessTasks = [...directoryTasks].map(([businessTaskKey, taskItems]) => (
            enqueueBusinessTask(businessTaskKey, taskItems)
          ));
          if (expectedMusicCandidateCount > 0 && directoryMusicCandidateCount === 0) {
            this.logger.error({
              日志关键字: "codex-flycloud-helper-music-scan",
              事件: "音乐目录未生成曲目任务",
              任务ID: job.id,
              服务ID: job.serviceId,
              目录标识: flushedDirectoryKey,
              待处理音乐文件数量: expectedMusicCandidateCount,
            });
          }
          if (directoryTasks.size > 0 && (scannedDirectoryCount <= 10 || scannedDirectoryCount % 50 === 0)) {
            this.logger.info({
              日志关键字: directoryMusicCandidateCount > 0
                ? "codex-flycloud-helper-music-scan"
                : "codex-flycloud-helper-streaming-scrape",
              事件: directoryMusicCandidateCount > 0
                ? "目录音乐曲目任务已加入刮削队列"
                : "目录影片任务已加入刮削队列",
              任务ID: job.id,
              目录标识: flushedDirectoryKey,
              目录媒体文件数量: directoryItems.length,
              目录音乐文件数量: directoryMusicCandidateCount,
              目录任务数量: directoryTasks.size,
              待准备目录数量: pendingDirectoryFlushTasks.size,
              待完成刮削数量: pendingBusinessTasks.size,
              已发现媒体任务数量: businessProgress.taskKeys.size,
            });
          }
          return {
            businessTasks,
            skippedCount: directorySkippedCount,
            businessTaskKeys: [...directoryTasks.keys()],
          };
        });
      sourcePreparationChains[sourceWorkerIndex] = directoryFlushTask.then(() => undefined, () => undefined);
      pendingDirectoryFlushTasks.add(directoryFlushTask);
      void directoryFlushTask.finally(() => {
        pendingDirectoryFlushTasks.delete(directoryFlushTask);
      }).catch(() => undefined);
    };

    /** 如果异步检查点提交失败，在下一次安全边界终止任务，避免继续扫描却无法恢复。 */
    const throwCheckpointCommitError = (): void => {
      if (checkpointCommitError) throw checkpointCommitError;
    };

    /**
     * 在当前 Provider 批次开始前记录完成水位，并异步提交上一窗口检查点。
     * 只等待水位之前已经提交的目录准备和刮削任务，不阻塞后续 Provider 枚举。
     */
    const scheduleCheckpointCandidate = async (): Promise<void> => {
      const candidate = checkpointCandidate;
      checkpointCandidate = null;
      if (!candidate || candidate.checkpointSequence <= scheduledCheckpointSequence) return;
      await flushActiveDirectory();
      const checkpointProviderWarningKeys = new Set(providerWarningKeys);
      const checkpointNfoSidecars = serializeNfoSidecars(nfoSidecars);
      const directoryTasksBeforeCheckpoint = [...pendingDirectoryFlushTasks];
      const businessTasksAlreadyQueued = [...pendingBusinessTasks];
      const checkpointTaskKeysBeforePreparation = new Set(businessProgress.taskKeys);
      const checkpointEnumeratedEntryCount = enumeratedEntryCount;
      const checkpointScannedMediaCount = scannedMediaCount;
      const checkpointSkippedCount = skippedCount;
      const checkpointCurrentScanPath = currentScanPath;
      const checkpointScannedDirectoryCount = scannedDirectoryCount;
      scheduledCheckpointSequence = candidate.checkpointSequence;

      checkpointCommitChain = checkpointCommitChain
        .then(async () => {
          if (checkpointCommitError) return;
          const directoryResults = await Promise.all(directoryTasksBeforeCheckpoint);
          const tasksBeforeCheckpoint = [...new Set([
            ...businessTasksAlreadyQueued,
            ...directoryResults.flatMap((result) => result.businessTasks),
          ])];
          await Promise.all(tasksBeforeCheckpoint);
          // 不能把包含 TMDB 临时失败的窗口保存成新游标，否则恢复后会漏掉该窗口的影片。
          if (tmdbRecoveryError) return;
          // 关键变量：只合并当前游标水位内目录返回的任务键，后续并发目录不会提前进入检查点。
          const checkpointTaskKeys = new Set([
            ...checkpointTaskKeysBeforePreparation,
            ...directoryResults.flatMap((result) => result.businessTaskKeys),
          ]);
          const preparedSkippedCount = directoryResults.reduce((total, result) => total + result.skippedCount, 0);
          const checkpointBusinessProgress = createCheckpointBusinessProgress(
            businessProgress,
            checkpointTaskKeys,
          );
          await this.repository.saveScanJobCheckpoint({
            checkpoint,
            providerState: candidate as unknown as Record<string, unknown>,
            progress: createCheckpointProgress({
              enumeratedEntryCount: checkpointEnumeratedEntryCount,
              scannedMediaCount: checkpointScannedMediaCount,
              skippedCount: checkpointSkippedCount + preparedSkippedCount,
              currentScanPath: checkpointCurrentScanPath,
              scannedDirectoryCount: checkpointScannedDirectoryCount,
              providerWarningKeys: checkpointProviderWarningKeys,
              businessProgress: checkpointBusinessProgress,
              movieTaskKeys: new Set([...movieTaskKeys].filter((key) => checkpointTaskKeys.has(key))),
              seriesTaskKeys: new Set([...seriesTaskKeys].filter((key) => checkpointTaskKeys.has(key))),
            }),
            nfoSidecars: checkpointNfoSidecars,
            // 水位任务完成后读取当前集合；即使包含后续窗口条目，恢复重放仍保持幂等且不会漏通知。
            changedItemIds: [...changedItemIds],
          });
          savedCheckpointSequence = candidate.checkpointSequence;
          if (replayingCheckpointWindow && candidate.checkpointSequence > restoredCheckpointSequence) {
            replayingCheckpointWindow = false;
          }
          this.logger.info({
            日志关键字: "codex-flycloud-helper-checkpoint",
            事件: "扫描安全检查点异步保存完成",
            任务ID: job.id,
            扫描会话ID: checkpoint.scanSessionId,
            Provider游标序号: candidate.checkpointSequence,
            扫描根序号: candidate.rootIndex,
            待扫描目录数量: candidate.pendingDirectories.length,
            扫描视频数量: checkpointScannedMediaCount,
            处理影片数量: getHandledBusinessTaskCount(checkpointBusinessProgress),
          });
        })
        .catch((error) => {
          checkpointCommitError = error;
          this.logger.error({
            日志关键字: "codex-flycloud-helper-checkpoint",
            事件: "扫描安全检查点异步保存失败",
            任务ID: job.id,
            Provider游标序号: candidate.checkpointSequence,
            错误信息: error instanceof Error ? error.message : "未知检查点错误",
          });
        });
    };

    try {
      for await (const entry of adapter.enumerate(connection, roots, signal, (warning) => {
        providerWarningKeys.add(`${warning.code}\u0000${warning.path}`);
        void recordScanFailure({
          stage: "enumerating",
          errorCode: warning.code,
          error: new Error(warning.message),
          recovered: true,
          mediaPath: warning.path,
          context: { 处理结果: "已跳过异常子目录并继续扫描" },
        });
        this.logger.warn({
          日志关键字: "codex-flycloud-helper-provider-request",
          事件: "扫描任务跳过异常子目录",
          任务ID: job.id,
          目录路径: warning.path,
          错误码: warning.code,
          错误信息: warning.message,
        });
      }, {
      directoryConcurrency: effectiveScanDirectoryConcurrency,
      resumeState: checkpoint.providerState,
      checkpointDirectoryInterval: 50,
      persistConnection: async (nextConnection) => {
        const credentialRevision = Number(job.snapshot.credentialRevision);
        await this.repository.refreshActiveEncryptedConnection({
          serviceId: job.serviceId,
          userId: job.userId,
          credentialRevision,
          encryptedConnection: this.vault.encrypt(nextConnection),
        });
        this.logger.info({
          日志关键字: "codex-flycloud-provider-token-refresh",
          事件: "扫描期间保存Provider刷新令牌",
          任务ID: job.id,
          服务ID: job.serviceId,
          凭据修订: credentialRevision,
        });
      },
      onCheckpoint: (providerCheckpoint) => {
        checkpointCandidate = providerCheckpoint;
      },
      onRootStart: async (state) => {
        const rootPath = state.root.resourceId || state.root.displayPath || "/";
        const rootRun = await this.repository.startScanRootRun({
          job,
          rootKey: createScanRootKey(state.root),
          rootResourceId: rootPath,
          displayPath: state.root.displayPath || rootPath,
        });
        scanRootGenerations.set(rootRun.rootKey, rootRun.generationId);
      },
      onRootComplete: async (state) => {
        await this.repository.finishScanRootRun({
          jobId: job.id,
          rootKey: createScanRootKey(state.root),
          warningCount: state.warningCount,
        });
        this.logger.info({
          日志关键字: "codex-flycloud-helper-checkpoint",
          事件: state.warningCount > 0 ? "扫描根枚举不完整" : "扫描根枚举完成",
          任务ID: job.id,
          扫描根序号: state.rootIndex,
          扫描根路径: state.root.displayPath || state.root.resourceId || "/",
          目录警告数量: state.warningCount,
        });
      },
      })) {
      await scheduleCheckpointCandidate();
      throwCheckpointCommitError();
      await throwTmdbRecoveryAfterDraining();
      let requestedControl: "none" | "pause" | "cancel" = "none";
      if (signal.aborted || Date.now() >= nextJobControlPollAt) {
        requestedControl = await this.repository.getJobControl(job.id);
        nextJobControlPollAt = Date.now() + jobControlPollIntervalMs;
      }
      if (requestedControl !== "none") {
        if (signal.aborted) {
          await drainScanPipeline();
          await checkpointCommitChain;
          await this.applyAbortedJobState(job, "枚举条目控制检查点");
          this.logger.info({
            日志关键字: "codex-scan-control-resume",
            事件: requestedControl === "pause" ? "任务已快速暂停" : "任务已快速终止",
            任务ID: job.id,
            保留检查点: requestedControl === "pause",
            Provider游标序号: savedCheckpointSequence,
          });
          return;
        }
        // 当前窗口不覆盖上一安全检查点；恢复时重放该窗口，避免进度和游标跨时刻造成漏扫。
        await flushActiveDirectory();
        await drainScanPipeline();
        await checkpointCommitChain;
        throwCheckpointCommitError();
        await publishProgress("enumerating");
        await this.applyControlAction(job);
        this.logger.info({
          日志关键字: "codex-flycloud-helper-checkpoint",
          事件: requestedControl === "pause" ? "任务已在安全边界暂停" : "任务已在安全边界取消",
          任务ID: job.id,
          保留检查点: requestedControl === "pause",
          Provider游标序号: savedCheckpointSequence,
        });
        return;
      }
      enumeratedEntryCount += 1;
      const entryDirectory = path.posix.dirname(entry.path) || "/";
      currentScanPath = entryDirectory;
      const matchingRoot = findMatchingScanRoot(entry.path, roots);
      const effectiveRoot = matchingRoot ?? roots[0];
      const rootTypes = Array.isArray(matchingRoot?.mediaTypes)
        ? matchingRoot.mediaTypes.filter((item): item is MediaType => item === "video" || item === "music")
        : defaultMediaTypes;
      const rootPath = matchingRoot?.displayPath || matchingRoot?.resourceId || "/";
      const scanRootKey = createScanRootKey(effectiveRoot ?? { displayPath: rootPath });
      const sourceGenerationId = scanRootGenerations.get(scanRootKey) ?? generationId;
      const directoryKey = `${rootPath}\u0000${entryDirectory}`;
      // Provider 按目录连续返回文件；切换目录表示上一个目录已完整，可立即识别并开始刮削。
      if (activeDirectoryKey !== null && activeDirectoryKey !== directoryKey) {
        await flushActiveDirectory();
      }
      if (activeDirectoryKey === null) {
        activeDirectoryKey = directoryKey;
      }
      if (/\.nfo$/iu.test(entry.name) && useLocalVideoNfo) {
        skippedCount += 1;
        if (adapter.readText) {
          try {
            const nfoPath = path.posix.normalize(entry.path);
            // 关键变量：超长Provider资源ID先转为稳定摘要，和源文件表保持相同上限处理。
            const nfoProviderResourceId = entry.resourceId.length <= 500
              ? entry.resourceId
              : createStableId("resource", entry.resourceId);
            const cacheInput = {
              userId: job.userId,
              serviceId: job.serviceId,
              libraryId: job.libraryId,
              providerResourceId: nfoProviderResourceId,
              path: nfoPath,
              size: entry.size,
              modifiedAt: entry.modifiedAt,
              etag: entry.etag,
              parserVersion: FLYMBY_NFO_PARSER_CACHE_VERSION,
            };
            let nfoMetadata: FlymbyNfoMetadata | null = null;
            try {
              nfoMetadata = await this.repository.readNfoSidecarCache(cacheInput);
            } catch (cacheError) {
              // 缓存异常只降低扫描速度，不影响NFO正常读取和影片刮削。
              this.logger.warn({
                日志关键字: "codex-flycloud-scan-performance",
                事件: "读取NFO缓存失败并回退网盘下载",
                任务ID: job.id,
                NFO路径: nfoPath,
                错误信息: cacheError instanceof Error ? cacheError.message : "未知缓存错误",
              });
            }
            let nfoSource = "持久化缓存";
            if (nfoMetadata) {
              reusedNfoSidecarCount += 1;
            } else {
              const nfoText = await adapter.readText(connection, entry, signal);
              nfoMetadata = parseFlymbyNfo(nfoText);
              downloadedNfoSidecarCount += 1;
              nfoSource = "网盘下载";
              try {
                await this.repository.saveNfoSidecarCache(cacheInput, nfoMetadata);
              } catch (cacheError) {
                // 写入缓存失败不改变本次NFO解析结果，下次扫描会重新尝试下载。
                this.logger.warn({
                  日志关键字: "codex-flycloud-scan-performance",
                  事件: "保存NFO缓存失败",
                  任务ID: job.id,
                  NFO路径: nfoPath,
                  错误信息: cacheError instanceof Error ? cacheError.message : "未知缓存错误",
                });
              }
            }
            nfoSidecars.set(nfoPath, { path: nfoPath, metadata: nfoMetadata });
            this.logger.info({
              日志关键字: "codex-flycloud-helper-scrape",
              事件: "读取NFO成功",
              任务ID: job.id,
              NFO路径: nfoPath,
              NFO类型: nfoMetadata.rootType,
              NFO来源: nfoSource,
            });
          } catch (error) {
            if (signal.aborted) throw error;
            await recordScanFailure({
              stage: "scraping",
              errorCode: readFailureCode(error, "nfo_read_failed"),
              error,
              recovered: true,
              mediaPath: entry.path,
              resourceId: entry.resourceId,
              fileName: entry.name,
              context: { 处理结果: "已回退到在线刮削" },
            });
            this.logger.warn({
              日志关键字: "codex-flycloud-helper-scrape",
              事件: "读取NFO失败并回退在线刮削",
              任务ID: job.id,
              NFO路径: entry.path,
              错误码: readFailureCode(error, "nfo_read_failed"),
            });
          }
        }
        if (shouldPublishProgress()) {
          await publishProgress("enumerating");
        }
        continue;
      }
      const preliminaryDescriptor = describeMediaFile(
        entry,
        rootTypes,
        matchingRoot?.displayPath || matchingRoot?.resourceId || "/",
      );
      if (!preliminaryDescriptor) {
        skippedCount += 1;
        if (shouldPublishProgress()) {
          await publishProgress("enumerating");
        }
        continue;
      }
      scannedMediaCount += 1;
      // 关键变量：未变化文件也参与目录节目识别，但只有真实变化文件进入本轮处理任务。
      const candidate: PendingDirectoryMedia = {
        entry,
        rootTypes,
        rootPath,
        shouldProcess: true,
        sourceFileInput: {
          id: createStableId("src", job.userId, job.libraryId, entry.resourceId),
          userId: job.userId,
          serviceId: job.serviceId,
          libraryId: job.libraryId,
          providerResourceId: entry.resourceId.length <= 500
            ? entry.resourceId
            : createStableId("resource", entry.resourceId),
          parentResourceId: entry.parentResourceId && entry.parentResourceId.length > 500
            ? createStableId("resource", entry.parentResourceId)
            : entry.parentResourceId,
          path: entry.path,
          name: entry.name,
          extension: getFileExtension(entry.name),
          size: entry.size,
          modifiedAt: entry.modifiedAt,
          etag: entry.etag,
          scanRootKey,
          generationId: sourceGenerationId,
          metadataProfileRevision,
          recognitionRevision,
          locator: entry.locator,
        },
        skipIfUnchanged: !isRetryJob
          && !replayingCheckpointWindow,
        reusedMatchedCatalog: false,
        sourceFile: null,
        preparationError: null,
      };
      activeDirectoryItems.push(candidate);
      const isMusicOnlyDirectory = rootTypes.includes("music") && !rootTypes.includes("video");
      if (isMusicOnlyDirectory && activeDirectoryItems.length >= musicDirectoryBatchSize) {
        await flushActiveDirectory();
      }
      if (shouldPublishProgress()) {
        await publishProgress("enumerating");
      }
      }
    } catch (error) {
      if (!signal.aborted) throw error;
      this.logger.info({
        日志关键字: "codex-scan-control-resume",
        事件: "任务控制已打断Provider枚举",
        任务ID: job.id,
        错误信息: error instanceof Error ? error.message : "Provider请求已中断",
      });
    }

    if (signal.aborted) {
      // 人工控制落为暂停/取消；进程关闭没有控制动作时保留 running，重启后重新入队。
      await drainScanPipeline();
      await checkpointCommitChain;
      await this.applyAbortedJobState(job, "Provider枚举出口");
      this.logger.info({
        日志关键字: "codex-scan-control-resume",
        事件: "任务控制后保留扫描检查点",
        任务ID: job.id,
        扫描会话ID: checkpoint.scanSessionId,
        Provider游标序号: savedCheckpointSequence,
      });
      return;
    }

    // Provider 已停止返回文件，最后一个目录也必须立即入队，再等待队列中剩余的刮削任务完成。
    await flushActiveDirectory();
    await Promise.all([...pendingDirectoryFlushTasks]);
    if (defaultMediaTypes.includes("music") && scannedMediaCount > 0 && businessProgress.taskKeys.size === 0) {
      this.logger.error({
        日志关键字: "codex-flycloud-helper-music-scan",
        事件: "音乐扫描发现文件但未生成曲目任务",
        任务ID: job.id,
        服务ID: job.serviceId,
        扫描音乐文件数量: scannedMediaCount,
        扫描批次数量: scannedDirectoryCount,
      });
      throw new ApiError(
        500,
        "music_scan_task_missing",
        "扫描发现了音乐文件，但没有生成曲目处理任务，请通过日志关键字 codex-flycloud-helper-music-scan 排查",
      );
    }
    this.logger.info({
      日志关键字: "codex-flycloud-helper-task-count",
      事件: "扫描刮削流水线完成任务聚合",
      任务ID: job.id,
      扫描媒体文件数量: scannedMediaCount,
      目录数量: scannedDirectoryCount,
      媒体任务数量: businessProgress.taskKeys.size,
      电影任务数量: movieTaskKeys.size,
      节目任务数量: seriesTaskKeys.size,
      待准备目录数量: pendingDirectoryFlushTasks.size,
      待完成刮削数量: pendingBusinessTasks.size,
      TMDB可用Key数量: this.tmdb.getStatus().healthyCount,
    });
    if (defaultMediaTypes.includes("video")
      && businessProgress.taskKeys.size > 0
      && this.tmdb.getStatus().healthyCount <= 0) {
      this.logger.warn({
        日志关键字: "codex-flycloud-helper-task-count",
        事件: "当前没有可用TMDB Key",
        任务ID: job.id,
        影响: "没有本地NFO匹配的电影节目将计入错误，不计入未匹配",
        电影节目任务数量: businessProgress.taskKeys.size,
      });
    }
    await publishProgress("scraping");
    await waitForBusinessTasksWithProgress();
    await checkpointCommitChain;
    throwCheckpointCommitError();
    await throwTmdbRecoveryAfterDraining();
    await publishProgress("scraping");

    if (signal.aborted) {
      await this.applyAbortedJobState(job, "刮削队列出口");
      this.logger.info({
        日志关键字: "codex-scan-control-resume",
        事件: "刮削阶段任务控制后保留扫描检查点",
        任务ID: job.id,
        扫描会话ID: checkpoint.scanSessionId,
        Provider游标序号: savedCheckpointSequence,
      });
      return;
    }

    await publishProgress("persisting");
    if (signal.aborted) {
      await this.applyAbortedJobState(job, "持久化开始前");
      return;
    }
    this.logger.info({
      日志关键字: "codex-flycloud-helper-catalog-batch",
      事件: "准备分批写入目录变化",
      任务ID: job.id,
      目录变化数量: changedItemIds.size,
    });
    const providerWarningCount = providerWarningKeys.size;
    const completedRootRuns = await this.repository.listCompletedScanRootRuns(job.id);
    // 关键变量：全局排除项清理仍要求所有根完整；缺失文件只对各自完整根执行。
    const allowDestructiveCleanup = providerWarningCount === 0 && completedRootRuns.length === roots.length;
    if (!allowDestructiveCleanup) {
      this.logger.warn({
        日志关键字: "codex-flycloud-scan-reconcile",
        事件: "目录枚举不完整已限制对账范围",
        任务ID: job.id,
        Provider警告数量: providerWarningCount,
        配置扫描根数量: roots.length,
        完整扫描根数量: completedRootRuns.length,
        缺失文件处理范围: "仅完整扫描根",
      });
    }
    this.logger.info({
      日志关键字: "codex-flycloud-helper-checkpoint",
      事件: "扫描根对账范围已确定",
      任务ID: job.id,
      配置扫描根数量: roots.length,
      完整扫描根数量: completedRootRuns.length,
      不完整目录警告数量: providerWarningCount,
      执行缺失对账: completedRootRuns.length > 0,
    });
    if (signal.aborted) {
      await this.applyAbortedJobState(job, "目录对账前");
      return;
    }
    const finalization = await this.repository.finalizeGeneration({
      userId: job.userId,
      serviceId: job.serviceId,
      libraryId: job.libraryId,
      generationId,
      completedRootGenerations: completedRootRuns.map((rootRun) => ({
        rootKey: rootRun.rootKey,
        generationId: rootRun.generationId,
      })),
      // 每个成功完整枚举的扫描根都必须与 Provider 当前内容一致；带警告根不会进入列表，不执行删除。
      deleteMissing: completedRootRuns.length > 0,
      allowDestructiveCleanup,
      changedItemIds: [...changedItemIds],
    });
    this.logger.info({
      日志关键字: "codex-flycloud-scan-reconcile",
      事件: "扫描成功后媒体目录与Provider对账完成",
      任务ID: job.id,
      媒体库ID: job.libraryId,
      扫描模式: job.scanMode,
      完整扫描根数量: completedRootRuns.length,
      停用缺失源文件数量: finalization.missingSourceCount,
      刷新剩余版本条目数量: finalization.updatedMissingItemCount,
      删除无版本条目数量: finalization.deletedMissingItemCount,
      删除无文件子条目数量: finalization.deletedOrphanLeafCount,
      删除无内容父条目数量: finalization.deletedOrphanParentCount,
      最新目录版本: finalization.catalogVersion,
    });
    if (signal.aborted) {
      await this.applyAbortedJobState(job, "任务完成前");
      return;
    }
    if (analyzeMediaSpecs && mediaProbeSourceFiles.size > 0) {
      const queuedProbeResult = await this.repository.enqueueMediaProbes([...mediaProbeSourceFiles.values()], false, {
        requestedByUserId: job.userId,
        triggerType: "scan_completed",
        sourceScanJobId: job.id,
      });
      const queuedProbeCount = queuedProbeResult.queuedCount;
      this.logger.info({
        日志关键字: "codex-media-ffprobe",
        事件: "扫描完成后写入媒体规格队列",
        任务ID: job.id,
        服务ID: job.serviceId,
        扫描文件数量: mediaProbeSourceFiles.size,
        新增或变化文件数量: queuedProbeCount,
        后台任务ID: queuedProbeResult.jobId,
      });
    }
    await this.repository.finishJob(job.id, { status: "completed" });
    const [notificationEnabled, createdMediaCounts] = await Promise.all([
      this.readServiceNotificationEnabled(job.serviceId),
      this.readScanCreatedMediaCounts(job),
    ]);
    // 关键变量：影视与音乐使用不同业务单位，只有本次任务确实有新内容入库时才投递 Telegram。
    const createdContentCount = job.dataType === "music"
      ? createdMediaCounts.songCount + createdMediaCounts.albumCount + createdMediaCounts.artistCount
      : createdMediaCounts.videoContentCount;
    const deliverScanNotificationExternally = notificationEnabled && createdContentCount > 0;
    const completionMessage = buildScanCompletionMessage(job, createdMediaCounts);
    await this.database.createNotificationSafely({
      userId: job.userId,
      category: "task",
      tone: businessProgress.failedKeys.size > 0 ? "warning" : "success",
      title: "扫描任务已完成",
      message: completionMessage,
      actionPath: "/app/jobs",
      deliverExternally: deliverScanNotificationExternally,
    });
    this.logger.info({
      日志关键字: "codex-flycloud-helper-task-count",
      性能日志关键字: "codex-flycloud-scan-performance",
      事件: "扫描增量结果",
      任务ID: job.id,
      扫描模式: job.scanMode,
      枚举文件数量: enumeratedEntryCount,
      扫描媒体文件数量: scannedMediaCount,
      媒体任务数量: businessProgress.taskKeys.size,
      处理媒体数量: getHandledBusinessTaskCount(businessProgress),
      匹配媒体数量: businessProgress.matchedKeys.size,
      未匹配媒体数量: businessProgress.unmatchedKeys.size,
      错误媒体数量: businessProgress.failedKeys.size,
      Provider警告数量: providerWarningCount,
      跳过数量: skippedCount,
      复用已匹配文件数量: reusedMatchedSourceFileCount,
      复用NFO缓存数量: reusedNfoSidecarCount,
      下载NFO数量: downloadedNfoSidecarCount,
      当前扫描路径: currentScanPath,
      目录变化数量: changedItemIds.size,
      新增影视内容数量: createdMediaCounts.videoContentCount,
      新增歌曲数量: createdMediaCounts.songCount,
      新增专辑数量: createdMediaCounts.albumCount,
      新增艺术家数量: createdMediaCounts.artistCount,
      通知展示影视数量: createdMediaCounts.videoContents.length,
      服务任务通知已启用: notificationEnabled,
      是否存在新增入库内容: createdContentCount > 0,
      是否投递外部通知: deliverScanNotificationExternally,
      扫描耗时毫秒: Date.now() - scanStartedAt,
      平均每秒枚举文件数量: Number((enumeratedEntryCount / Math.max(1, (Date.now() - scanStartedAt) / 1_000)).toFixed(2)),
    });
    if (reusedMatchedSourceFileCount > 0) {
      this.logger.info({
        日志关键字: "codex-flycloud-helper-full-scan-reuse",
        事件: "全量扫描已复用未变化的匹配目录",
        任务ID: job.id,
        复用已匹配文件数量: reusedMatchedSourceFileCount,
        扫描媒体文件数量: scannedMediaCount,
        处理媒体数量: getHandledBusinessTaskCount(businessProgress),
      });
    }
    this.logger.info({
      日志标记: "flycloud-helper-worker",
      事件: "扫描任务完成",
      任务ID: job.id,
      已处理: getHandledBusinessTaskCount(businessProgress),
      已跳过: skippedCount,
      错误数: businessProgress.failedKeys.size,
    });
  }

  /** 完成单个已发现媒体的刮削、父子条目落库和文件定位关联。 */
  private async persistScannedMedia(input: {
    job: ScanJobRecord;
    descriptor: MediaDescriptor;
    sourceFile: SourceFileRecord;
    entryLocator: Record<string, unknown>;
    generationId: string;
    metadataProfiles: Record<string, unknown>;
    metadataCache: ScanMetadataCache;
    nfoSidecars: Map<string, NfoSidecarEntry>;
    forceCatalogChange: boolean;
    signal: AbortSignal;
  }): Promise<{ changedItemIds: string[]; matched: boolean; providerUnavailable: boolean }> {
    const metadata = await this.enrichMetadata(
      input.descriptor,
      input.metadataProfiles,
      input.job.snapshot,
      input.metadataCache,
      input.nfoSidecars,
      input.job.id,
      input.signal,
    );
    const changedItemIds: string[] = [];
    let parentItemId: string | null = null;
    let parentItemState: {
      itemId: string;
      changed: boolean;
      hasManualMatch: boolean;
      itemType: string;
    } | null = null;
    if (input.descriptor.parent) {
      const parentMetadata = metadata.parent ?? (input.descriptor.mediaType === "music" ? {
        ...metadata,
        title: String(metadata.metadata.album ?? input.descriptor.metadata.album ?? input.descriptor.parent.title),
        subtitle: String(metadata.metadata.albumArtist ?? metadata.metadata.artist ?? input.descriptor.parent.subtitle),
        metadata: {
          album: metadata.metadata.album ?? input.descriptor.parent.title,
          albumArtist: metadata.metadata.albumArtist ?? metadata.metadata.artist ?? input.descriptor.parent.subtitle,
          genres: metadata.metadata.genres ?? input.descriptor.metadata.genres,
          artistIds: metadata.metadata.artistIds ?? input.descriptor.metadata.musicBrainzArtistIds,
        },
      } : metadata);
      const parentIdentityKey = resolveCatalogIdentityKey(input.descriptor, parentMetadata, true);
      const parentCacheKey = createStableId(
        "parent-cache",
        input.job.userId,
        input.job.libraryId,
        parentIdentityKey,
        input.generationId,
      );
      let parentPromise = input.metadataCache.parentItems.get(parentCacheKey);
      if (!parentPromise) {
        parentPromise = this.repository.upsertMediaItem({
          id: createStableId("itm", input.job.userId, input.job.libraryId, parentIdentityKey),
          userId: input.job.userId,
          serviceId: input.job.serviceId,
          libraryId: input.job.libraryId,
          identityKey: createStableId("identity", parentIdentityKey),
          mediaType: input.descriptor.mediaType,
          itemType: input.descriptor.parent.itemType,
          title: parentMetadata.title || input.descriptor.parent.title,
          sortTitle: parentMetadata.title || input.descriptor.parent.title,
          subtitle: parentMetadata.subtitle || input.descriptor.parent.subtitle,
          year: parentMetadata.year ?? input.descriptor.parent.year,
          overview: parentMetadata.overview,
          posterUrl: parentMetadata.posterUrl,
          backdropUrl: parentMetadata.backdropUrl,
          matchState: parentMetadata.matchState,
          externalIds: parentMetadata.externalIds,
          metadata: parentMetadata.metadata,
          generationId: input.generationId,
        });
        input.metadataCache.parentItems.set(parentCacheKey, parentPromise);
      }
      try {
        parentItemState = await parentPromise;
      } catch (error) {
        // 数据库短暂异常时移除失败 Promise，允许同一节目的后续单集重新建立父项。
        if (input.metadataCache.parentItems.get(parentCacheKey) === parentPromise) {
          input.metadataCache.parentItems.delete(parentCacheKey);
        }
        throw error;
      }
      if (!parentItemState) throw new Error("节目父条目落库结果缺失");
      parentItemId = parentItemState.itemId;
      if (parentItemState.changed || input.forceCatalogChange) changedItemIds.push(parentItemState.itemId);
    }
    const itemIdentityKey = resolveCatalogIdentityKey(input.descriptor, metadata, false);
    const itemResult = await this.repository.upsertMediaItem({
      id: createStableId("itm", input.job.userId, input.job.libraryId, itemIdentityKey),
      userId: input.job.userId,
      serviceId: input.job.serviceId,
      libraryId: input.job.libraryId,
      identityKey: createStableId("identity", itemIdentityKey),
      mediaType: input.descriptor.mediaType,
      itemType: input.descriptor.itemType,
      title: metadata.title,
      sortTitle: input.descriptor.sortTitle,
      subtitle: metadata.subtitle,
      year: metadata.year,
      overview: metadata.overview,
      posterUrl: metadata.posterUrl,
      backdropUrl: metadata.backdropUrl,
      matchState: metadata.matchState,
      externalIds: metadata.externalIds,
      metadata: { ...input.descriptor.metadata, ...metadata.metadata },
      generationId: input.generationId,
    });
    if (itemResult.changed || input.forceCatalogChange) changedItemIds.push(itemResult.itemId);
    const replacedByFileLink = await this.repository.linkItemFile({
      userId: input.job.userId,
      libraryId: input.job.libraryId,
      itemId: itemResult.itemId,
      sourceFileId: input.sourceFile.id,
      locator: input.entryLocator,
      targetItemType: itemResult.itemType,
      targetHasManualMatch: itemResult.hasManualMatch,
    });
    if (replacedByFileLink.length > 0) {
      changedItemIds.push(itemResult.itemId, ...replacedByFileLink);
    }
    if (parentItemId && parentItemState && input.descriptor.parent) {
      const replacedByRelation = await this.repository.linkMediaRelation({
        userId: input.job.userId,
        libraryId: input.job.libraryId,
        parentItemId,
        childItemId: itemResult.itemId,
        relationType: input.descriptor.parent.relationType,
        sortOrder: input.descriptor.parent.sortOrder,
        parentItemType: parentItemState.itemType,
        parentHasManualMatch: parentItemState.hasManualMatch,
      });
      if (replacedByRelation.length > 0) {
        changedItemIds.push(parentItemId, itemResult.itemId, ...replacedByRelation);
      }
    }
    if (input.descriptor.mediaType === "music") {
      const artistNames = Array.isArray(metadata.metadata.artists)
        ? metadata.metadata.artists.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
        : [String(metadata.metadata.albumArtist ?? metadata.metadata.artist ?? input.descriptor.metadata.artist ?? "").trim()].filter(Boolean);
      const rawArtistIds = Array.isArray(metadata.metadata.artistIds)
        ? metadata.metadata.artistIds
        : Array.isArray(metadata.metadata.musicBrainzArtistIds) ? metadata.metadata.musicBrainzArtistIds : [];
      const artistIds = rawArtistIds.filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
      const rawArtistImages = Array.isArray(metadata.metadata.artistImages)
        ? metadata.metadata.artistImages
        : [];
      const artistImages = rawArtistImages.map((item) => typeof item === "string" ? item : "");
      const fallbackArtistImage = typeof metadata.metadata.artistImageUrl === "string"
        ? metadata.metadata.artistImageUrl
        : "";
      const hasEmbeddedMusicBrainzArtistIds = Array.isArray(input.descriptor.metadata.musicBrainzArtistIds)
        && input.descriptor.metadata.musicBrainzArtistIds.length > 0;
      const artistSource = typeof metadata.metadata.artistSource === "string" && metadata.metadata.artistSource
        ? metadata.metadata.artistSource
        : hasEmbeddedMusicBrainzArtistIds ? "musicbrainz" : "name";
      const artistItemIds: string[] = [];
      for (const [index, artistName] of [...new Set(artistNames)].entries()) {
        const platformArtistId = artistIds[index] ?? "";
        const artistImageUrl = artistImages[index] || fallbackArtistImage || null;
        const artistIdentityKey = platformArtistId && artistSource === "musicbrainz"
          ? `music:artist:${artistSource}:${platformArtistId}`
          : `music:artist:name:${artistName.toLocaleLowerCase("und")}`;
        const artistResult = await this.repository.upsertMediaItem({
          id: createStableId("itm", input.job.userId, input.job.libraryId, artistIdentityKey),
          userId: input.job.userId,
          serviceId: input.job.serviceId,
          libraryId: input.job.libraryId,
          identityKey: createStableId("identity", artistIdentityKey),
          mediaType: "music",
          itemType: "music.artist",
          title: artistName,
          sortTitle: artistName,
          subtitle: "艺术家",
          year: null,
          overview: "",
          posterUrl: artistImageUrl,
          backdropUrl: null,
          matchState: metadata.matchState,
          externalIds: platformArtistId ? { [`${artistSource}Artist`]: platformArtistId } : {},
          metadata: { artist: artistName, artistSource, artistImageUrl },
          generationId: input.generationId,
        });
        artistItemIds.push(artistResult.itemId);
        if (artistResult.changed || input.forceCatalogChange) changedItemIds.push(artistResult.itemId);
      }
      await this.repository.replaceMusicArtistRelations({
        userId: input.job.userId,
        libraryId: input.job.libraryId,
        artistItemIds,
        albumItemId: parentItemId,
        trackItemId: itemResult.itemId,
      });
    }
    const matched = metadata.matchState === "matched";
    return {
      changedItemIds,
      matched,
      providerUnavailable: !matched && this.isVideoMetadataProviderUnavailable(
        input.descriptor,
        input.metadataProfiles,
      ),
    };
  }

  /** 判断影视任务是否因为当前没有可用刮削源而未实际执行，避免误计为“未匹配”。 */
  private isVideoMetadataProviderUnavailable(
    descriptor: MediaDescriptor,
    metadataProfiles: Record<string, unknown>,
  ): boolean {
    if (descriptor.mediaType !== "video") return false;
    const profile = readMetadataProfile(metadataProfiles, descriptor.mediaType);
    const providerId = readMetadataProviderId(profile);
    const usesTmdb = !providerId || providerId === "tmdb" || providerId === "builtin.tmdb";
    return usesTmdb && this.tmdb.getStatus().healthyCount <= 0;
  }

  /** 统一记录单条媒体失败，不输出凭据和播放定位。 */
  private logMediaItemFailure(jobId: string, resourceId: string, error: unknown): void {
    this.logger.warn({
      日志关键字: "codex-flycloud-helper-scrape",
      事件: "媒体条目处理失败",
      任务ID: jobId,
      资源ID: resourceId,
      错误码: error && typeof error === "object" && "code" in error
        ? String((error as { code?: string }).code)
        : "media_item_failed",
      错误信息: error instanceof Error ? error.message : "未知错误",
    });
  }

  /** 在安全检查点执行暂停或取消请求。 */
  private async applyControlAction(job: ScanJobRecord): Promise<boolean> {
    const action = await this.repository.getJobControl(job.id);
    if (action === "pause") {
      await this.repository.finishJob(job.id, { status: "paused" });
      return true;
    }
    if (action === "cancel") {
      await this.repository.finishJob(job.id, { status: "cancelled" });
      return true;
    }
    return false;
  }

  /** AbortSignal 生效后把数据库控制动作落为终态；进程关闭没有控制动作时继续保留 running 供重启恢复。 */
  private async applyAbortedJobState(job: ScanJobRecord, boundary: string): Promise<void> {
    const action = await this.repository.getJobControl(job.id); // 关键变量：区分人工控制和进程整体停止。
    if (action === "pause") {
      await this.repository.finishJob(job.id, { status: "paused" });
    } else if (action === "cancel") {
      await this.repository.finishJob(job.id, { status: "cancelled" });
    }
    this.logger.info({
      日志关键字: "codex-scan-control-resume",
      事件: action === "none" ? "Worker停止并保留任务" : "任务控制状态已生效",
      任务ID: job.id,
      控制动作: action,
      退出边界: boundary,
    });
  }

  /** 根据媒体 Profile 调用 TMDB 或 MusicBrainz，并保留本地识别结果作为降级。 */
  private async enrichMetadata(
    descriptor: MediaDescriptor,
    metadataProfiles: Record<string, unknown>,
    jobSnapshot: Record<string, unknown>,
    cache: ScanMetadataCache,
    nfoSidecars: Map<string, NfoSidecarEntry>,
    jobId: string,
    signal: AbortSignal,
  ): Promise<EnrichedMetadata> {
    const profile = readMetadataProfile(metadataProfiles, descriptor.mediaType);
    const providerId = readMetadataProviderId(profile);
    // 关键变量：旧配置未包含 useNfo 时保持原有的 NFO 优先行为。
    const useNfo = profile.useNfo !== false;
    const nfoMetadata = useNfo ? this.enrichVideoFromNfo(descriptor, nfoSidecars) : null;
    if (nfoMetadata) {
      this.logger.info({
        日志关键字: "codex-flycloud-helper-scrape",
        事件: "使用NFO刮削结果",
        任务ID: jobId,
        媒体类型: descriptor.itemType,
        查询标题: descriptor.title,
      });
      return nfoMetadata;
    }
    if (providerId.startsWith("plugin:")) {
      const reference = providerId.slice("plugin:".length);
      const separator = reference.lastIndexOf("@");
      const pluginId = separator > 0 ? reference.slice(0, separator) : reference;
      const requestedVersion = separator > 0 ? reference.slice(separator + 1) : null;
      const snapshots = Array.isArray(jobSnapshot.pluginVersions)
        ? jobSnapshot.pluginVersions.filter((item): item is PluginTaskSnapshot => Boolean(item && typeof item === "object"))
        : [];
      const snapshot = snapshots.find((item) => item.pluginId === pluginId && (!requestedVersion || item.version === requestedVersion));
      if (snapshot) {
        // 关键变量：视频插件查询词使用 APP 的目录与文件名清洗口径，避免把集数、演员或资源标签提交给插件。
        const rawPluginTitle = String(descriptor.metadata.query ?? descriptor.parent?.title ?? descriptor.title);
        const pluginTitle = descriptor.mediaType === "video"
          ? FlymbyVideoTitleCleaner.cleanVideoMetadataSearchQuery(
            rawPluginTitle,
          ) || descriptor.title
          : descriptor.title;
        if (descriptor.mediaType === "video" && pluginTitle !== rawPluginTitle) {
          this.logger.info({
            日志关键字: "codex-flycloud-helper-title-clean",
            事件: "视频插件查询标题已按APP规则清洗",
            任务ID: jobId,
            原始标题: rawPluginTitle,
            清洗标题: pluginTitle,
          });
        }
        const result = await this.plugins.scrape(snapshot, {
          mediaType: descriptor.mediaType,
          title: pluginTitle,
          subtitle: descriptor.subtitle,
          year: descriptor.year,
          artist: typeof descriptor.metadata.artist === "string" ? descriptor.metadata.artist : undefined,
          album: typeof descriptor.metadata.album === "string" ? descriptor.metadata.album : undefined,
        }, signal);
        if (result) {
          const pluginMetadata: EnrichedMetadata = {
            title: result.title,
            subtitle: result.subtitle || descriptor.subtitle,
            year: result.year ?? descriptor.year,
            overview: result.overview,
            posterUrl: result.posterUrl,
            backdropUrl: result.backdropUrl,
            matchState: "matched",
            externalIds: result.externalId ? { [`plugin:${pluginId}`]: result.externalId } : {},
            metadata: { ...result.metadata, metadataPluginId: pluginId, metadataPluginVersion: snapshot.version },
          };
          return descriptor.mediaType === "music"
            ? this.mergeMusicMetadataWithLocal(descriptor, pluginMetadata)
            : pluginMetadata;
        }
      }
      if (profile.retryProviderId === null || profile.retryProviderId === undefined) {
        return this.createLocalMetadata(descriptor);
      }
    }
    if (descriptor.mediaType === "video" && (!providerId || providerId === "tmdb" || providerId === "builtin.tmdb")) {
      const tmdbResult = await this.enrichVideoFromTmdb(descriptor, profile, jobSnapshot, cache, jobId, signal);
      if (tmdbResult) return tmdbResult;
    }
    if (descriptor.mediaType === "music" && descriptor.itemType === "music.track") {
      const configuredProviderId = providerId.startsWith("plugin:")
        ? String(profile.retryProviderId ?? "")
        : providerId || "auto";
      if (configuredProviderId === "local") {
        return this.createLocalMetadata(descriptor);
      }
      const selectedSource = this.readMusicPlatformSource(configuredProviderId);
      if (selectedSource === "auto") {
        const automaticResult = await this.searchAutomaticMusicMetadata(descriptor, profile, jobSnapshot, cache, signal);
        if (automaticResult) return automaticResult;
      } else {
        const platformResult = await this.searchMusicPlatformMetadata(descriptor, profile, cache, selectedSource, signal);
        if (platformResult) return platformResult;
      }
    }
    return this.createLocalMetadata(descriptor);
  }

  /** 按 APP 的 movie/tvshow/episodedetails 优先级选择本地 NFO 元数据。 */
  private enrichVideoFromNfo(
    descriptor: MediaDescriptor,
    sidecars: Map<string, NfoSidecarEntry>,
  ): EnrichedMetadata | null {
    if (descriptor.mediaType !== "video" || sidecars.size === 0) return null;
    const sourcePath = String(descriptor.metadata.sourcePath ?? "");
    if (!sourcePath) return null;
    const normalizedSourcePath = path.posix.normalize(sourcePath);
    const directory = path.posix.dirname(normalizedSourcePath);
    const stem = path.posix.basename(normalizedSourcePath, path.posix.extname(normalizedSourcePath));
    const sameStemNfo = sidecars.get(path.posix.join(directory, `${stem}.nfo`))?.metadata;

    if (descriptor.itemType === "video.movie") {
      const primary = sameStemNfo?.rootType === "movie"
        ? sameStemNfo
        : sidecars.get(path.posix.join(directory, "movie.nfo"))?.metadata;
      if (!primary || primary.rootType !== "movie") return null;
      return this.mapNfoMetadata(primary, descriptor.title, descriptor.subtitle, descriptor.year);
    }

    let cursor = directory;
    let seriesNfo: FlymbyNfoMetadata | undefined;
    while (cursor !== "/" && !seriesNfo) {
      const candidate = sidecars.get(path.posix.join(cursor, "tvshow.nfo"))?.metadata;
      if (candidate?.rootType === "tvshow") seriesNfo = candidate;
      cursor = path.posix.dirname(cursor);
    }
    const episodeNfo = sameStemNfo?.rootType === "episodedetails" ? sameStemNfo : undefined;
    if (!seriesNfo && !episodeNfo) return null;
    const parentSource = seriesNfo ?? episodeNfo!;
    const parent = this.mapNfoMetadata(
      parentSource,
      episodeNfo?.showTitle || descriptor.parent?.title || descriptor.subtitle,
      descriptor.parent?.subtitle || "剧集",
      descriptor.parent?.year ?? descriptor.year,
    );
    const seasonNumber = episodeNfo?.seasonNumber || Number(descriptor.metadata.seasonNumber ?? 1);
    const episodeNumber = episodeNfo?.episodeNumber || Number(descriptor.metadata.episodeNumber ?? 1);
    return {
      title: episodeNfo?.title || descriptor.title,
      subtitle: parent.title,
      year: parent.year,
      overview: episodeNfo?.overview || "",
      posterUrl: toPublicImageValue(episodeNfo?.posterValue ?? "") ?? parent.posterUrl,
      backdropUrl: parent.backdropUrl,
      matchState: "matched",
      externalIds: episodeNfo?.tmdbId ? { tmdb: String(episodeNfo.tmdbId) } : {},
      metadata: {
        metadataSource: "local.nfo",
        seasonNumber,
        episodeNumber,
        episodeNumbers: descriptor.metadata.episodeNumbers,
        airDate: episodeNfo?.airDate ?? "",
        rating: episodeNfo?.rating ?? 0,
        durationMs: episodeNfo?.durationMs ?? 0,
        localPosterValue: episodeNfo?.posterValue ?? "",
      },
      parent,
    };
  }

  /** 将 movie 或 tvshow NFO 转换为目录统一字段。 */
  private mapNfoMetadata(
    nfo: FlymbyNfoMetadata,
    fallbackTitle: string,
    subtitle: string,
    fallbackYear: number | null,
  ): EnrichedMetadata {
    return {
      title: nfo.title || nfo.showTitle || fallbackTitle,
      subtitle,
      year: nfo.year ?? fallbackYear,
      overview: nfo.overview,
      posterUrl: toPublicImageValue(nfo.posterValue),
      backdropUrl: toPublicImageValue(nfo.backdropValue),
      matchState: "matched",
      externalIds: nfo.tmdbId > 0 ? { tmdb: String(nfo.tmdbId) } : {},
      metadata: {
        metadataSource: "local.nfo",
        originalTitle: nfo.originalTitle,
        releaseDate: nfo.airDate,
        rating: nfo.rating,
        genres: nfo.genres,
        people: nfo.people,
        logoUrl: toPublicImageValue(nfo.logoValue),
        localPosterValue: nfo.posterValue,
        localBackdropValue: nfo.backdropValue,
      },
    };
  }

  /** 按电影或节目聚合键执行 TMDB 刮削，并给单集附加季接口返回的元数据。 */
  private async enrichVideoFromTmdb(
    descriptor: MediaDescriptor,
    profile: Record<string, unknown>,
    jobSnapshot: Record<string, unknown>,
    cache: ScanMetadataCache,
    jobId: string,
    signal: AbortSignal,
  ): Promise<EnrichedMetadata | null> {
    const mediaType = descriptor.itemType === "video.episode" ? "tv" : "movie";
    const query = String(descriptor.metadata.query ?? descriptor.parent?.title ?? descriptor.title).trim();
    if (!query) return null;
    // 关键变量：仅在目录查询无候选时交给 TMDB 客户端执行一次的文件名回退查询。
    const rawFallbackQuery = String(descriptor.metadata.fallbackQuery ?? "").trim();
    const fallbackQuery = FlymbyVideoTitleCleaner.normalizeSearchText(rawFallbackQuery)
      === FlymbyVideoTitleCleaner.normalizeSearchText(query) ? "" : rawFallbackQuery;
    const language = String(profile.language ?? "zh-CN");
    const region = String(profile.region ?? "CN");
    const imdbId = typeof descriptor.metadata.imdbId === "string" ? descriptor.metadata.imdbId : "";
    const explicitTmdbId = Number(descriptor.metadata.explicitTmdbId ?? 0);
    const aiModelSnapshot = readAiModelTaskSnapshot(jobSnapshot.aiModel);
    const businessTaskKey = readBusinessTaskKey(descriptor);
    const aiContext = cache.aiContexts.get(businessTaskKey);
    // 关键变量：关闭时普通标题命中后只保留搜索摘要，详情在打开条目时实时补查。
    const synchronizeDetails = profile.syncDetails === true;
    // TMDB 客户端必须先检查部署级共享缓存；仅在缓存未命中时才由 Key 池决定返回空结果或延迟恢复。
    const confirmedNumericSeriesTitle = Boolean(descriptor.metadata.confirmedNumericSeriesTitle);
    if (explicitTmdbId <= 0 && !imdbId &&
      !confirmedNumericSeriesTitle && isWeakFlymbyScrapeTitle(query)) {
      return null;
    }
    const recognitionRevision = buildAiRecognitionRevision(Number(jobSnapshot.metadataProfileRevision ?? 0), aiModelSnapshot);
    const cacheKey = `${mediaType}|${String(descriptor.metadata.scrapeTaskKey ?? query)}|${language}|${region}|${recognitionRevision}`;
    let videoPromise = cache.video.get(cacheKey);
    const isFirstTaskQuery = !videoPromise;
    if (!videoPromise) {
      this.logger.info({
        日志关键字: "codex-flycloud-helper-scrape",
        事件: "开始TMDB刮削",
        任务ID: jobId,
        媒体类型: mediaType === "tv" ? "节目" : "电影",
        查询标题: query,
        查询年份: descriptor.year ?? 0,
        显式TMDB编号: explicitTmdbId,
        IMDB编号: imdbId || "无",
      });
      videoPromise = this.tmdb.scrapeVideo({
        mediaType,
        title: query,
        fallbackTitle: fallbackQuery,
        year: descriptor.year,
        language,
        region,
        imdbId,
        explicitTmdbId,
        includeDetails: synchronizeDetails,
        cacheRevision: recognitionRevision,
        resolveSecondSearchSuggestion: aiModelSnapshot?.triggerMode === "weak_or_unmatched"
          && explicitTmdbId <= 0
          && !imdbId
          && aiContext
          ? async () => {
            const suggestion = await this.aiVideoNameCleaner.resolveSecondSearchSuggestion({
              context: aiContext,
              snapshot: aiModelSnapshot,
              jobId,
              userId: cache.aiUsageOwner.userId,
              serviceId: cache.aiUsageOwner.serviceId,
              taskCache: cache.aiResults,
              signal,
            });
            return suggestion ? {
              title: suggestion.cleanedTitle,
              mediaType: suggestion.mediaType,
            } : null;
          }
          : undefined,
        signal,
      });
      cache.video.set(cacheKey, videoPromise);
    }
    const result = await videoPromise;
    if (!result) {
      if (isFirstTaskQuery) {
        this.logger.warn({
          日志关键字: "codex-flycloud-helper-scrape",
          事件: "TMDB未匹配",
          任务ID: jobId,
          媒体类型: mediaType === "tv" ? "节目" : "电影",
          查询标题: query,
          查询年份: descriptor.year ?? 0,
          可用Key数量: this.tmdb.getStatus().healthyCount,
        });
      }
      return null;
    }
    this.applyTmdbMediaTypeCorrection(descriptor, result, jobId);
    if (isFirstTaskQuery) {
      this.logger.info({
        日志关键字: "codex-flycloud-helper-scrape",
        事件: "TMDB匹配成功",
        任务ID: jobId,
        媒体类型: mediaType === "tv" ? "节目" : "电影",
        查询标题: query,
        匹配标题: result.title,
        TMDB编号: result.id,
        候选数量: result.candidateCount,
        已同步详情: result.detailsSynchronized,
      });
    }

    const parentMetadata = this.mapTmdbVideoMetadata(result, descriptor.parent?.subtitle ?? descriptor.subtitle);
    if (result.mediaType === "movie") return parentMetadata;
    const seasonNumber = Math.max(0, Number(descriptor.metadata.seasonNumber ?? 1));
    const episodeNumber = Math.max(1, Number(descriptor.metadata.episodeNumber ?? 1));
    if (!synchronizeDetails) {
      return {
        title: descriptor.title,
        subtitle: result.title,
        year: result.year ?? descriptor.year,
        overview: "",
        posterUrl: result.posterUrl,
        backdropUrl: result.backdropUrl,
        matchState: "matched",
        externalIds: { tmdbTv: String(result.id) },
        metadata: {
          seasonNumber,
          episodeNumber,
          episodeNumbers: descriptor.metadata.episodeNumbers,
          tmdbTvId: result.id,
          tmdbDetailsSynchronized: false,
          resolution: descriptor.metadata.resolution,
          source: descriptor.metadata.source,
          releaseGroup: descriptor.metadata.releaseGroup,
        },
        parent: parentMetadata,
      };
    }
    const seasonKey = `${result.id}|${seasonNumber}|${language}`;
    let seasonPromise = cache.seasons.get(seasonKey);
    if (!seasonPromise) {
      seasonPromise = this.tmdb.readTvSeason(result.id, seasonNumber, language, signal);
      cache.seasons.set(seasonKey, seasonPromise);
    }
    let episodeRows: TmdbEpisodeMetadata[] = [];
    try {
      episodeRows = await seasonPromise;
    } catch (error) {
      // Flymby APP 的单集信息属于刮削子步骤，失败时仍使用已命中的节目详情完成落库。
      this.logger.warn({
        日志关键字: "codex-flycloud-helper-scrape-flow",
        事件: "TMDB单集信息读取失败已保留节目匹配",
        任务ID: jobId,
        节目TMDB编号: result.id,
        季号: seasonNumber,
        错误信息: error instanceof Error ? error.message : "未知错误",
      });
    }
    const episode = episodeRows.find((item) => item.episodeNumber === episodeNumber);
    return {
      title: episode?.title || descriptor.title,
      subtitle: result.title,
      year: result.year ?? descriptor.year,
      overview: episode?.overview || "",
      posterUrl: episode?.stillUrl ?? result.posterUrl,
      backdropUrl: result.backdropUrl,
      matchState: "matched",
      externalIds: {
        tmdbTv: String(result.id),
        ...(episode?.id ? { tmdb: String(episode.id) } : {}),
      },
      metadata: {
        seasonNumber,
        episodeNumber,
        episodeNumbers: descriptor.metadata.episodeNumbers,
        tmdbTvId: result.id,
        tmdbEpisodeId: episode?.id ?? 0,
        airDate: episode?.airDate ?? "",
        rating: episode?.rating ?? 0,
        durationMs: episode?.durationMs ?? 0,
        tmdbDetailsSynchronized: result.detailsSynchronized,
        resolution: descriptor.metadata.resolution,
        source: descriptor.metadata.source,
        releaseGroup: descriptor.metadata.releaseGroup,
      },
      parent: parentMetadata,
    };
  }

  /**
   * 显式 TMDB ID 命中另一种媒体类型时，同步改写目录模型，避免只换详情但仍按错误类型落库。
   */
  private applyTmdbMediaTypeCorrection(
    descriptor: MediaDescriptor,
    result: TmdbVideoMetadata,
    jobId: string,
  ): void {
    const originalType = descriptor.itemType === "video.episode" ? "tv" : "movie";
    if (originalType === result.mediaType) return;
    const originalTaskKey = String(descriptor.metadata.scrapeTaskKey ?? descriptor.identityKey);
    const correctedTaskKey = originalTaskKey.replace(/^(?:movie|tv)\|/u, `${result.mediaType}|`);
    descriptor.metadata.scrapeTaskKey = correctedTaskKey;
    if (result.mediaType === "tv") {
      const seasonNumber = originalType === "tv"
        ? Math.max(0, Number(descriptor.metadata.seasonNumber ?? 1))
        : 1;
      const episodeNumber = Math.max(1, Number(descriptor.metadata.episodeNumber ?? 1));
      descriptor.itemType = "video.episode";
      descriptor.title = `第 ${seasonNumber} 季 · 第 ${episodeNumber} 集`;
      descriptor.sortTitle = `${String(seasonNumber).padStart(3, "0")}-${String(episodeNumber).padStart(5, "0")}`;
      descriptor.subtitle = result.title;
      descriptor.metadata.seriesTitle = result.title;
      descriptor.metadata.seasonNumber = seasonNumber;
      descriptor.metadata.episodeNumber = episodeNumber;
      descriptor.metadata.episodeNumbers = [episodeNumber];
      descriptor.parent = {
        identityKey: `video:series:${correctedTaskKey}`,
        itemType: "video.series",
        title: result.title,
        subtitle: "剧集",
        year: result.year ?? descriptor.year,
        sortOrder: seasonNumber * 100_000 + episodeNumber,
        relationType: "series_episode",
      };
    } else {
      descriptor.itemType = "video.movie";
      descriptor.title = result.title;
      descriptor.sortTitle = result.title;
      descriptor.subtitle = result.year ? String(result.year) : "电影";
      descriptor.metadata.seasonNumber = 0;
      descriptor.metadata.episodeNumber = 0;
      descriptor.metadata.episodeNumbers = [];
      delete descriptor.parent;
    }
    descriptor.year = result.year ?? descriptor.year;
    this.logger.info({
      日志关键字: "codex-video-recognition-optimize",
      事件: "影片目录类型已按显式TMDB编号纠正",
      任务ID: jobId,
      原媒体类型: originalType === "tv" ? "节目" : "电影",
      纠正后媒体类型: result.mediaType === "tv" ? "节目" : "电影",
      TMDB编号: result.id,
      原影片任务标识: originalTaskKey,
      新影片任务标识: correctedTaskKey,
    });
  }

  /** 把 TMDB 详情转换为媒体目录统一字段。 */
  private mapTmdbVideoMetadata(result: TmdbVideoMetadata, subtitle: string): EnrichedMetadata {
    return {
      title: result.title,
      subtitle,
      year: result.year,
      overview: result.overview,
      posterUrl: result.posterUrl,
      backdropUrl: result.backdropUrl,
      matchState: "matched",
      externalIds: { tmdb: String(result.id) },
      metadata: {
        originalTitle: result.originalTitle,
        releaseDate: result.releaseDate,
        rating: result.rating,
        genres: result.genres,
        originCountries: result.originCountries,
        people: result.people,
        logoUrl: result.logoUrl,
        episodeCount: result.episodeCount,
        matchedQuery: result.matchedQuery,
        candidateCount: result.candidateCount,
        tmdbDetailsSynchronized: result.detailsSynchronized,
        tmdbArtworkSynchronized: result.detailsSynchronized,
      },
    };
  }

  /** 使用本地文件识别结果构造不依赖外部来源的元数据。 */
  private createLocalMetadata(descriptor: MediaDescriptor): EnrichedMetadata {
    const isMusic = descriptor.mediaType === "music";
    const fieldSources = descriptor.metadata.metadataFieldSources
      && typeof descriptor.metadata.metadataFieldSources === "object"
      && !Array.isArray(descriptor.metadata.metadataFieldSources)
      ? descriptor.metadata.metadataFieldSources as Record<string, unknown>
      : {};
    const hasReadableMusicTags = isMusic
      && fieldSources.title === "embedded_tag"
      && fieldSources.artist === "embedded_tag"
      && fieldSources.album === "embedded_tag";
    const embeddedArtworkUrl = isMusic && typeof descriptor.metadata.embeddedArtworkUrl === "string"
      ? descriptor.metadata.embeddedArtworkUrl
      : null;
    const localMetadata: EnrichedMetadata = {
      title: descriptor.title,
      subtitle: descriptor.subtitle,
      year: descriptor.year,
      overview: "",
      posterUrl: embeddedArtworkUrl,
      backdropUrl: null,
      matchState: hasReadableMusicTags ? "matched" : descriptor.matchState,
      externalIds: isMusic && typeof descriptor.metadata.musicbrainzRecordingId === "string"
        ? { musicbrainzRecording: descriptor.metadata.musicbrainzRecordingId }
        : {},
      metadata: { ...descriptor.metadata },
    };
    if (descriptor.parent) {
      // 关键变量：未匹配单集必须仍以节目目录标题创建父项，不能把“第 N 集”写成节目名称。
      localMetadata.parent = {
        title: descriptor.parent.title,
        subtitle: descriptor.parent.subtitle,
        year: descriptor.parent.year,
        overview: "",
        posterUrl: embeddedArtworkUrl,
        backdropUrl: null,
        matchState: hasReadableMusicTags ? "matched" : descriptor.matchState,
        externalIds: isMusic && typeof descriptor.metadata.musicbrainzReleaseId === "string"
          ? { musicbrainzRelease: descriptor.metadata.musicbrainzReleaseId }
          : {},
        metadata: isMusic ? {
          album: descriptor.metadata.album ?? descriptor.parent.title,
          albumArtist: descriptor.metadata.albumArtist ?? descriptor.metadata.artist ?? descriptor.parent.subtitle,
          genres: descriptor.metadata.genres,
          artistIds: descriptor.metadata.musicbrainzArtistIds,
        } : {},
      };
    }
    return localMetadata;
  }

  /** 读取音乐来源；历史 MusicBrainz 默认值升级为多平台自动聚合，显式 musicbrainz 仍只查单个平台。 */
  private readMusicPlatformSource(providerId: string): MusicPlatformSource {
    if (!providerId || providerId === "auto" || providerId === "builtin.music-platforms" || providerId === "builtin.musicbrainz") {
      return "auto";
    }
    if (["musicbrainz", "netease", "qmusic", "kugou", "migu", "kuwo"].includes(providerId)) {
      return providerId as MusicPlatformSource;
    }
    return "auto";
  }

  /** 把多平台候选转换为目录统一字段，歌曲和专辑共享同一封面。 */
  private mapMusicPlatformCandidate(candidate: MusicPlatformCandidate): EnrichedMetadata {
    const externalIds = Object.fromEntries(
      Object.entries(candidate.identifiers).filter(([, value]) => Boolean(value)),
    );
    return {
      title: candidate.title,
      subtitle: [candidate.artist, candidate.album].filter(Boolean).join(" · "),
      year: candidate.year,
      overview: "",
      posterUrl: candidate.coverUrl,
      backdropUrl: null,
      matchState: "matched",
      externalIds,
      metadata: {
        metadataSource: candidate.source,
        metadataSourceName: candidate.sourceName,
        artistSource: candidate.source,
        matchScore: candidate.matchScore,
        artist: candidate.artist,
        artists: candidate.artists,
        artistIds: candidate.artistIds,
        artistImages: candidate.artistImages,
        artistImageUrl: candidate.artistImages.find(Boolean) ?? "",
        album: candidate.album,
        albumArtist: candidate.albumArtist,
        releaseDate: candidate.releaseDate,
        durationMs: candidate.durationMs,
        trackNumber: candidate.trackNumber,
        discNumber: candidate.discNumber,
        genres: candidate.genres,
        lyrics: candidate.lyrics,
      },
      parent: {
        title: candidate.album || "未知专辑",
        subtitle: candidate.albumArtist || candidate.artist,
        year: candidate.year,
        overview: "",
        posterUrl: candidate.coverUrl,
        backdropUrl: null,
        matchState: "matched",
        externalIds,
        metadata: {
          metadataSource: candidate.source,
          metadataSourceName: candidate.sourceName,
          artistSource: candidate.source,
          album: candidate.album,
          albumArtist: candidate.albumArtist,
          artistIds: candidate.artistIds,
          artistImages: candidate.artistImages,
          artistImageUrl: candidate.artistImages.find(Boolean) ?? "",
          genres: candidate.genres,
        },
      },
    };
  }

  /** 内嵌标签字段优先，在线结果只补充文件中缺少的信息和图片。 */
  private mergeMusicMetadataWithLocal(descriptor: MediaDescriptor, online: EnrichedMetadata): EnrichedMetadata {
    const local = this.createLocalMetadata(descriptor);
    const fieldSources = descriptor.metadata.metadataFieldSources
      && typeof descriptor.metadata.metadataFieldSources === "object"
      && !Array.isArray(descriptor.metadata.metadataFieldSources)
      ? descriptor.metadata.metadataFieldSources as Record<string, unknown>
      : {};
    const localArtists = Array.isArray(descriptor.metadata.artists)
      ? descriptor.metadata.artists.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
      : [];
    const onlineArtists = Array.isArray(online.metadata.artists)
      ? online.metadata.artists.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
      : [];
    const title = fieldSources.title === "embedded_tag" ? descriptor.title : online.title || descriptor.title;
    const artist = fieldSources.artist === "embedded_tag"
      ? String(descriptor.metadata.artist ?? localArtists[0] ?? "")
      : String(online.metadata.artist ?? onlineArtists[0] ?? descriptor.metadata.artist ?? "");
    const artists = fieldSources.artist === "embedded_tag" && localArtists.length > 0 ? localArtists : onlineArtists;
    const album = fieldSources.album === "embedded_tag"
      ? String(descriptor.metadata.album ?? descriptor.parent?.title ?? "")
      : String(online.metadata.album ?? online.parent?.title ?? descriptor.metadata.album ?? "");
    const albumArtist = String(descriptor.metadata.albumArtist ?? "")
      || String(online.metadata.albumArtist ?? artist);
    const embeddedArtworkUrl = typeof descriptor.metadata.embeddedArtworkUrl === "string"
      ? descriptor.metadata.embeddedArtworkUrl
      : "";
    const embeddedLyrics = typeof descriptor.metadata.lyrics === "string"
      ? descriptor.metadata.lyrics.trim()
      : "";
    const localGenres = Array.isArray(descriptor.metadata.genres)
      ? descriptor.metadata.genres.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
      : [];
    const metadata: Record<string, unknown> = {
      ...descriptor.metadata,
      ...online.metadata,
      title,
      artist,
      artists: artists.length > 0 ? artists : artist ? [artist] : [],
      album,
      albumArtist,
      releaseDate: String(descriptor.metadata.date ?? "") || online.metadata.releaseDate,
      genres: localGenres.length > 0 ? localGenres : online.metadata.genres,
      trackNumber: Number(descriptor.metadata.trackNumber ?? 0) > 0
        ? descriptor.metadata.trackNumber
        : online.metadata.trackNumber,
      discNumber: Number(descriptor.metadata.discNumber ?? 0) > 0
        ? descriptor.metadata.discNumber
        : online.metadata.discNumber,
      durationMs: Number(descriptor.metadata.durationMs ?? 0) > 0
        ? descriptor.metadata.durationMs
        : online.metadata.durationMs,
      // 内嵌歌词与其他文件标签一致，优先级高于在线补全结果。
      lyrics: embeddedLyrics || online.metadata.lyrics,
      embeddedArtworkUrl: embeddedArtworkUrl || null,
    };
    const posterUrl = embeddedArtworkUrl || online.posterUrl || local.posterUrl;
    const parentOnline = online.parent ?? online;
    return {
      ...online,
      title,
      subtitle: [artist, album].filter(Boolean).join(" · "),
      year: descriptor.year ?? online.year,
      posterUrl,
      matchState: online.matchState === "matched" || local.matchState === "matched" ? "matched" : local.matchState,
      externalIds: { ...local.externalIds, ...online.externalIds },
      metadata,
      parent: descriptor.parent ? {
        ...parentOnline,
        title: album || descriptor.parent.title,
        subtitle: albumArtist || artist || descriptor.parent.subtitle,
        year: descriptor.year ?? parentOnline.year,
        posterUrl,
        matchState: online.matchState === "matched" || local.matchState === "matched" ? "matched" : local.matchState,
        externalIds: { ...(local.parent?.externalIds ?? {}), ...parentOnline.externalIds },
        metadata: {
          ...(local.parent?.metadata ?? {}),
          ...parentOnline.metadata,
          album: album || descriptor.parent.title,
          albumArtist,
          artistIds: metadata.artistIds,
          artistImages: metadata.artistImages,
          artistImageUrl: metadata.artistImageUrl,
          genres: metadata.genres,
        },
      } : undefined,
    };
  }

  /** 查询单个内置平台或六平台聚合，并按一次扫描的曲目/专辑键复用结果。 */
  private async searchMusicPlatformMetadata(
    descriptor: MediaDescriptor,
    profile: Record<string, unknown>,
    cache: ScanMetadataCache,
    source: MusicPlatformSource,
    signal: AbortSignal,
  ): Promise<EnrichedMetadata | null> {
    const fieldSources = descriptor.metadata.metadataFieldSources
      && typeof descriptor.metadata.metadataFieldSources === "object"
      && !Array.isArray(descriptor.metadata.metadataFieldSources)
      ? descriptor.metadata.metadataFieldSources as Record<string, unknown>
      : {};
    const embeddedTagsComplete = fieldSources.title === "embedded_tag"
      && fieldSources.artist === "embedded_tag"
      && fieldSources.album === "embedded_tag";
    const requiredFields = profile.requiredFields && typeof profile.requiredFields === "object" && !Array.isArray(profile.requiredFields)
      ? profile.requiredFields as Record<string, unknown>
      : {};
    const artist = String(descriptor.metadata.artist ?? "");
    const album = String(descriptor.metadata.album ?? descriptor.parent?.title ?? "");
    const embeddedArtworkUrl = String(descriptor.metadata.embeddedArtworkUrl ?? "");
    const includeLyrics = requiredFields.lyrics === true;
    const configuredSources = Array.isArray(profile.systemEnabledSources)
      ? profile.systemEnabledSources.filter((item): item is BuiltinMusicPlatformSource => (
        typeof item === "string" && MUSIC_PLATFORM_SOURCE_ORDER.includes(item as BuiltinMusicPlatformSource)
      ))
      : MUSIC_PLATFORM_SOURCE_ORDER;
    const cacheScope = embeddedTagsComplete && !includeLyrics
      ? `album:${artist}:${album}`
      : `track:${descriptor.title}:${artist}:${album}`;
    const cacheKey = `${configuredSources.join(",")}|${source}|${profile.aggregateMode === "fast" ? "fast" : "complete"}|${cacheScope}`;
    let candidatePromise = cache.music.get(cacheKey);
    if (!candidatePromise) {
      candidatePromise = this.musicPlatforms.search({
        title: descriptor.title,
        artist,
        album,
        durationMs: Number(descriptor.metadata.durationMs ?? 0),
        source,
        aggregateMode: profile.aggregateMode === "fast" ? "fast" : "complete",
        requireCover: !embeddedArtworkUrl,
        requireArtistImage: true,
        includeLyrics,
        enabledSources: configuredSources,
        signal,
      });
      cache.music.set(cacheKey, candidatePromise);
    }
    const candidate = await candidatePromise;
    return candidate ? this.mergeMusicMetadataWithLocal(descriptor, this.mapMusicPlatformCandidate(candidate)) : null;
  }

  /** 参考 FlymbyServer 的 fast/complete 策略并发聚合六个内置平台与已启用音乐插件。 */
  private async searchAutomaticMusicMetadata(
    descriptor: MediaDescriptor,
    profile: Record<string, unknown>,
    jobSnapshot: Record<string, unknown>,
    cache: ScanMetadataCache,
    signal: AbortSignal,
  ): Promise<EnrichedMetadata | null> {
    const pluginSnapshots = Array.isArray(jobSnapshot.pluginVersions)
      ? jobSnapshot.pluginVersions.filter((item): item is PluginTaskSnapshot => Boolean(item && typeof item === "object"))
      : [];
    const query = {
      mediaType: "music" as const,
      title: descriptor.title,
      subtitle: descriptor.subtitle,
      year: descriptor.year,
      artist: typeof descriptor.metadata.artist === "string" ? descriptor.metadata.artist : undefined,
      album: typeof descriptor.metadata.album === "string" ? descriptor.metadata.album : undefined,
    };
    const tasks: Array<Promise<EnrichedMetadata | null>> = [
      this.searchMusicPlatformMetadata(descriptor, profile, cache, "auto", signal),
    ];
    for (const snapshot of pluginSnapshots) {
      tasks.push(this.plugins.scrape(snapshot, query, signal).then((result) => result ? this.mergeMusicMetadataWithLocal(descriptor, {
        title: result.title,
        subtitle: result.subtitle || descriptor.subtitle,
        year: result.year ?? descriptor.year,
        overview: result.overview,
        posterUrl: result.posterUrl,
        backdropUrl: result.backdropUrl,
        matchState: "matched" as const,
        externalIds: result.externalId ? { [`plugin:${snapshot.pluginId}`]: result.externalId } : {},
        metadata: { ...result.metadata, metadataPluginId: snapshot.pluginId, metadataPluginVersion: snapshot.version },
      }) : null).catch(() => null));
    }
    const requiredFields = profile.requiredFields && typeof profile.requiredFields === "object" && !Array.isArray(profile.requiredFields)
      ? profile.requiredFields as Record<string, unknown>
      : {};
    const accepts = (item: EnrichedMetadata | null): item is EnrichedMetadata => {
      if (!item) return false;
      if (requiredFields.cover === true && !item.posterUrl) return false;
      if (requiredFields.artist === true && typeof item.metadata.artist !== "string") return false;
      if (requiredFields.album === true && typeof item.metadata.album !== "string") return false;
      return true;
    };
    if (profile.aggregateMode === "fast") {
      try {
        return await Promise.any(tasks.map(async (task) => {
          const item = await task;
          if (!accepts(item)) throw new Error("metadata candidate rejected");
          return item;
        }));
      } catch {
        return null;
      }
    }
    const results = await Promise.allSettled(tasks);
    for (const result of results) {
      if (result.status === "fulfilled" && accepts(result.value)) return result.value;
    }
    return null;
  }
}
