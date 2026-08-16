import path from "node:path";
import type { ApiConfig } from "./config.js";
import type { MediaType, ScanJobRecord, SourceFileRecord } from "./domain.js";
import { ApiError, toSafeErrorMessage } from "./errors.js";
import {
  createStableId,
  describeMediaDirectory,
  describeMediaFile,
  getFileExtension,
  type MediaDescriptor,
} from "./media/filename.js";
import { isWeakFlymbyScrapeTitle } from "./media/flymby-video-parser.js";
import { FlymbyVideoTitleCleaner } from "./media/flymby-video-title-cleaner.js";
import {
  parseFlymbyNfo,
  toPublicImageValue,
  type FlymbyNfoMetadata,
} from "./media/flymby-nfo-parser.js";
import { MusicBrainzClient } from "./metadata/musicbrainz.js";
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
import { CredentialVault } from "./secrets.js";
import {
  ServiceRepository,
  type ScanCheckpointProgress,
} from "./service-repository.js";

interface WorkerLogger {
  info(fields: Record<string, unknown>): void;
  warn(fields: Record<string, unknown>): void;
  error(fields: Record<string, unknown>): void;
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
  /** 同一电影或节目在一次扫描中只执行一次搜索和详情请求。 */
  video: Map<string, Promise<TmdbVideoMetadata | null>>;
  /** 同一节目季在一次扫描中只请求一次单集列表。 */
  seasons: Map<string, Promise<TmdbEpisodeMetadata[]>>;
}

interface NfoSidecarEntry {
  path: string;
  metadata: FlymbyNfoMetadata;
}

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

/** 使用 Flymby APP 的刮削任务键，把多集节目和电影多版本合并成一个处理任务。 */
function readBusinessTaskKey(descriptor: MediaDescriptor): string {
  const scrapeTaskKey = descriptor.metadata.scrapeTaskKey;
  if (typeof scrapeTaskKey === "string" && scrapeTaskKey.length > 0) {
    return scrapeTaskKey;
  }
  return descriptor.parent?.identityKey || descriptor.identityKey;
}

/** 读取元数据来源的稳定条目标识，优先使用 TMDB，其次使用插件返回的外部编号。 */
function readMetadataIdentity(metadata: EnrichedMetadata): string {
  const preferredKeys = ["tmdb", "tmdbTv"];
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

/** 解析扫描配置中的媒体范围；当前版本只执行影视扫描。 */
function readMediaTypes(profile: Record<string, unknown>): MediaType[] {
  const values = Array.isArray(profile.mediaTypes) ? profile.mediaTypes : [];
  const types = values.filter((item): item is MediaType => item === "video");
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

/** 轮询数据库任务队列并执行 Provider 扫描；当前只开放影视持久化。 */
export class ScanWorker {
  private readonly repository: ServiceRepository;
  private readonly providers: ProviderRegistry;
  private readonly vault: CredentialVault;
  private readonly tmdb: TmdbKeyPool;
  private readonly musicBrainz: MusicBrainzClient;
  private readonly plugins: MetadataPluginManager;
  private readonly logger: WorkerLogger;
  private readonly config: ApiConfig;
  private readonly abortControllers = new Map<string, AbortController>();
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private activeWorkers = 0;
  private stopping = false;

  public constructor(input: {
    repository: ServiceRepository;
    providers: ProviderRegistry;
    vault: CredentialVault;
    tmdb: TmdbKeyPool;
    musicBrainz: MusicBrainzClient;
    plugins: MetadataPluginManager;
    logger: WorkerLogger;
    config: ApiConfig;
  }) {
    this.repository = input.repository;
    this.providers = input.providers;
    this.vault = input.vault;
    this.tmdb = input.tmdb;
    this.musicBrainz = input.musicBrainz;
    this.plugins = input.plugins;
    this.logger = input.logger;
    this.config = input.config;
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
    this.logger.info({
      日志标记: "flycloud-helper-worker",
      事件: "扫描任务开始",
      任务ID: job.id,
      服务ID: job.serviceId,
    });
    try {
      await this.scan(job, controller.signal);
    } catch (error) {
      if (isTmdbTemporarilyUnavailableError(error)) {
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
      const code = error && typeof error === "object" && "code" in error
        ? String((error as { code?: string }).code)
        : "scan_failed";
      await this.repository.finishJob(job.id, {
        status: "failed",
        errorCode: code,
        errorMessage: toSafeErrorMessage(error, "扫描任务失败"),
      });
      this.logger.warn({
        日志标记: "flycloud-helper-worker",
        事件: "扫描任务失败",
        任务ID: job.id,
        错误码: code,
      });
    } finally {
      this.abortControllers.delete(job.id);
    }
  }

  /** 完成 Provider 枚举、分类、刮削、持久化和 generation 对账。 */
  private async scan(job: ScanJobRecord, signal: AbortSignal): Promise<void> {
    const runtime = await this.repository.getJobRuntimeConfiguration(job);
    const connection = this.vault.decrypt(runtime.encryptedConnection);
    const adapter = this.providers.get(runtime.providerType);
    const roots = readScanRoots(runtime.scanProfile, job.scanMode);
    if (roots.length === 0) {
      throw new ApiError(409, "scan_paths_not_configured", `未配置${job.scanMode === "full" ? "全量" : "增量"}扫描路径`);
    }
    const defaultMediaTypes = readMediaTypes(runtime.scanProfile);
    const videoMetadataProfile = readMetadataProfile(runtime.metadataProfile, "video");
    const videoMetadataProviderId = readMetadataProviderId(videoMetadataProfile);
    const usesBuiltinTmdb = !videoMetadataProviderId
      || videoMetadataProviderId === "tmdb"
      || videoMetadataProviderId === "builtin.tmdb";
    // 关键变量：前端保存的 metadata.profiles.video.useNfo 是本地 NFO 的唯一开关。
    const useLocalVideoNfo = videoMetadataProfile.useNfo !== false;
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
    if (defaultMediaTypes.includes("video") && !useLocalVideoNfo && usesBuiltinTmdb) {
      const temporaryError = this.tmdb.getTemporaryUnavailableError();
      if (temporaryError) throw temporaryError;
    }
    const savedProgress = checkpoint.progress;
    // 关键变量：暂停、进程退出和再次领取任务时始终复用同一 generation，避免续扫被当成新扫描。
    const generationId = checkpoint.generationId;
    let enumeratedEntryCount = savedProgress.enumeratedEntryCount;
    let scannedMediaCount = savedProgress.scannedMediaCount;
    let skippedCount = savedProgress.skippedCount;
    const providerWarningKeys = new Set(savedProgress.providerWarningKeys);
    let currentScanPath: string | null = savedProgress.currentScanPath;
    let lastProgressPublishedAt = 0;
    // 关键变量：与 Flymby APP 的刮削任务相同，按完整电影或节目聚合统计，不按视频文件累计。
    const businessProgress = createBusinessTaskProgress(savedProgress);
    // 关键变量：重试任务必须重新处理上次已落库的未匹配文件，不能套用普通增量扫描的未变更跳过规则。
    const isRetryJob = typeof job.snapshot.retryOfJobId === "string" && job.snapshot.retryOfJobId.length > 0;
    // 仅把真实变化的媒体条目写入目录变化流，避免每轮扫描生成全量 upsert。
    const changedItemIds = new Set(checkpoint.changedItemIds);
    // 关键变量：任务级刮削缓存，避免同一节目数百个单集重复请求 TMDB。
    const metadataCache: ScanMetadataCache = { video: new Map(), seasons: new Map() };
    // 关键变量：已经在目录枚举中读取的 NFO，按远端绝对路径索引且不写入凭据。
    const nfoSidecars = restoreNfoSidecars(checkpoint.nfoSidecars);
    const recommendedSettings = adapter.descriptor.recommendedScanSettings;
    const configuredScanDirectoryConcurrency = readProviderConcurrency(
      runtime.scanProfile.scanDirectoryConcurrency,
      recommendedSettings.scanDirectoryConcurrency,
    );
    // 关键变量：Flymby APP 全量扫描固定为单目录并发，增量扫描才使用服务配置值。
    const effectiveScanDirectoryConcurrency = job.scanMode === "full"
      ? Math.min(configuredScanDirectoryConcurrency, recommendedSettings.fullScanDirectoryConcurrency)
      : configuredScanDirectoryConcurrency;
    const configuredScrapeTaskConcurrency = readProviderConcurrency(
      runtime.scanProfile.scrapeTaskConcurrency,
      recommendedSettings.scrapeTaskConcurrency,
    );
    // 关键变量：服务配置是上限，实际刮削并发还要受当前可用 TMDB Key 数量限制。
    const scrapeConcurrency = Math.max(
      1,
      Math.min(configuredScrapeTaskConcurrency, Math.max(1, this.tmdb.getStatus().effectiveConcurrency)),
    );
    // 关键变量：只缓存当前目录，目录枚举完成后立即加入刮削队列，避免等待全盘扫描结束。
    let activeDirectoryKey: string | null = null;
    let activeDirectoryItems: PendingDirectoryMedia[] = [];
    let scannedDirectoryCount = savedProgress.scannedDirectoryCount;
    // 关键变量：刮削队列允许扫描适度领先，确保只有一个 TMDB Key 时也能真正并行扫描与刮削。
    const scrapeQueueLimit = Math.max(scrapeConcurrency * 4, scrapeConcurrency + 4);
    const pendingBusinessTasks = new Set<Promise<void>>();
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
    // 关键变量：源文件使用所属扫描根的稳定 generation，完整根才能独立执行缺失对账。
    const scanRootGenerations = new Map<string, string>();
    /** 把当前业务任务集合和扫描路径发布到数据库，供 5 秒轮询页面读取。 */
    const publishProgress = async (stage: "enumerating" | "scraping" | "persisting"): Promise<void> => {
      await this.repository.updateJobProgress(job.id, {
        stage,
        processedCount: getHandledBusinessTaskCount(businessProgress),
        totalCount: businessProgress.taskKeys.size,
        discoveredCount: scannedMediaCount,
        skippedCount,
        matchedCount: businessProgress.matchedKeys.size,
        unmatchedCount: businessProgress.unmatchedKeys.size,
        errorCount: businessProgress.failedKeys.size,
        currentPath: currentScanPath,
      });
      lastProgressPublishedAt = Date.now();
    };
    /** 控制扫描中进度写入频率，目录较慢时也至少每秒更新一次当前路径。 */
    const shouldPublishProgress = (): boolean => enumeratedEntryCount === 1
      || enumeratedEntryCount % 20 === 0
      || Date.now() - lastProgressPublishedAt >= 1_000;
    this.logger.info({
      日志关键字: "codex-flycloud-helper-worker-tuning",
      事件: "扫描刮削并发已确定",
      任务ID: job.id,
      网盘类型: runtime.providerType,
      扫描模式: job.scanMode,
      扫描配置并发: configuredScanDirectoryConcurrency,
      扫描实际并发: effectiveScanDirectoryConcurrency,
      刮削配置并发: configuredScrapeTaskConcurrency,
      刮削实际并发: scrapeConcurrency,
      TMDB可用Key数量: this.tmdb.getStatus().healthyCount,
    });
    this.logger.info({
      日志关键字: "codex-flycloud-helper-scrape-flow",
      事件: "影视扫描元数据流程已确定",
      任务ID: job.id,
      本地NFO优先: useLocalVideoNfo,
      元数据来源: videoMetadataProviderId || "builtin.tmdb",
      扫描模式: job.scanMode,
    });
    this.logger.info({
      日志关键字: "codex-flycloud-helper-checkpoint",
      事件: checkpointResult.restored ? "扫描任务已恢复检查点" : "扫描任务已建立检查点",
      任务ID: job.id,
      扫描会话ID: checkpoint.scanSessionId,
      扫描代次ID: generationId,
      Provider游标序号: restoredCheckpointSequence,
      恢复扫描视频数量: scannedMediaCount,
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

    /** 等待已经入队的刮削链结束，再把恢复信号抛给任务状态机。 */
    const throwTmdbRecoveryAfterDraining = async (): Promise<void> => {
      if (!tmdbRecoveryError) return;
      const recoveryError = tmdbRecoveryError;
      await Promise.allSettled([...pendingBusinessTasks]);
      throw recoveryError;
    };

    /** 完成一个完整电影或节目目录片段，全部文件结束后才更新该业务任务统计。 */
    const processBusinessTask = async (
      businessTaskKey: string,
      taskItems: PendingBusinessMedia[],
    ): Promise<void> => {
      let successfulFileCount = 0;
      let matched = false;
      let providerUnavailableFileCount = 0;
      for (const item of taskItems) {
        if (tmdbRecoveryError) break;
        const { candidate, descriptor } = item;
        if (!candidate.sourceFile) {
          this.logMediaItemFailure(
            job.id,
            candidate.entry.resourceId,
            candidate.preparationError ?? new Error("源文件记录未准备完成"),
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
            metadataProfiles: runtime.metadataProfile,
            metadataCache,
            nfoSidecars,
            forceCatalogChange: isRetryJob,
            signal,
          });
          successfulFileCount += 1;
          matched = matched || mediaResult.matched;
          if (mediaResult.providerUnavailable) providerUnavailableFileCount += 1;
          mediaResult.changedItemIds.forEach((itemId) => changedItemIds.add(itemId));
        } catch (error) {
          if (rememberTmdbRecoveryError(error)) {
            this.logger.warn({
              日志关键字: "codex-flycloud-helper-tmdb-recovery",
              事件: "影片刮削触发任务级延迟恢复",
              任务ID: job.id,
              影片任务标识: businessTaskKey,
              下次重试时间: tmdbRecoveryError?.nextRetryAt,
            });
            break;
          }
          this.logMediaItemFailure(job.id, candidate.entry.resourceId, error);
        }
      }
      // 当前窗口将从上一安全检查点重放，因此临时失败任务不写入成功、未匹配或错误统计。
      if (tmdbRecoveryError) return;
      if (successfulFileCount > 0 && (matched || providerUnavailableFileCount < successfulFileCount)) {
        recordBusinessTaskSuccess(businessProgress, businessTaskKey, matched);
      } else {
        recordBusinessTaskFailure(businessProgress, businessTaskKey);
      }
    };

    /** 把目录识别结果立即送入刮削队列；同一电影或节目跨目录时按加入顺序串行执行。 */
    const enqueueBusinessTask = (businessTaskKey: string, taskItems: PendingBusinessMedia[]): void => {
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
    };

    /** 队列达到上限时等待任意刮削任务完成，控制内存并让扫描与刮削保持流水线运行。 */
    const waitForScrapeQueueCapacity = async (): Promise<void> => {
      while (pendingBusinessTasks.size >= scrapeQueueLimit) {
        await Promise.race(pendingBusinessTasks);
        await throwTmdbRecoveryAfterDraining();
        if (Date.now() - lastProgressPublishedAt >= 1_000) {
          await publishProgress("enumerating");
        }
      }
    };

    /** 当前目录枚举结束后立即识别电影或节目，并把需要处理的内容加入刮削队列。 */
    const flushActiveDirectory = async (): Promise<void> => {
      const directoryItems = activeDirectoryItems;
      const flushedDirectoryKey = activeDirectoryKey;
      activeDirectoryItems = [];
      activeDirectoryKey = null;
      if (directoryItems.length === 0) return;

      scannedDirectoryCount += 1;
      const firstItem = directoryItems[0];
      if (!firstItem) return;
      const descriptors = describeMediaDirectory(
        directoryItems.map((item) => item.entry),
        firstItem.rootTypes,
        firstItem.rootPath,
      );
      const directoryTasks = new Map<string, PendingBusinessMedia[]>();
      for (const candidate of directoryItems) {
        if (!candidate.shouldProcess) continue;
        const descriptor = descriptors.get(candidate.entry.resourceId);
        if (!descriptor) continue;
        const businessTaskKey = readBusinessTaskKey(descriptor);
        const taskItems = directoryTasks.get(businessTaskKey) ?? [];
        taskItems.push({ descriptor, candidate });
        directoryTasks.set(businessTaskKey, taskItems);
        businessProgress.taskKeys.add(businessTaskKey);
        if (descriptor.itemType === "video.movie") {
          movieTaskKeys.add(businessTaskKey);
        } else {
          seriesTaskKeys.add(businessTaskKey);
        }
      }
      for (const [businessTaskKey, taskItems] of directoryTasks) {
        enqueueBusinessTask(businessTaskKey, taskItems);
      }
      if (directoryTasks.size > 0 && (scannedDirectoryCount <= 10 || scannedDirectoryCount % 50 === 0)) {
        this.logger.info({
          日志关键字: "codex-flycloud-helper-streaming-scrape",
          事件: "目录影片任务已加入刮削队列",
          任务ID: job.id,
          目录标识: flushedDirectoryKey,
          目录视频数量: directoryItems.length,
          目录任务数量: directoryTasks.size,
          待完成刮削数量: pendingBusinessTasks.size,
          已发现影片任务数量: businessProgress.taskKeys.size,
        });
      }
      await waitForScrapeQueueCapacity();
    };

    /** 在当前 Provider 批次开始前，把上一窗口的刮削结果和枚举游标一起提交为安全检查点。 */
    const persistCheckpointCandidate = async (): Promise<void> => {
      const candidate = checkpointCandidate;
      checkpointCandidate = null;
      if (!candidate || candidate.checkpointSequence === savedCheckpointSequence) return;
      await flushActiveDirectory();
      await Promise.all([...pendingBusinessTasks]);
      // 不能把包含 TMDB 临时失败的窗口保存成新游标，否则恢复后会漏掉该窗口的影片。
      await throwTmdbRecoveryAfterDraining();
      await publishProgress("enumerating");
      await this.repository.saveScanJobCheckpoint({
        checkpoint,
        providerState: candidate as unknown as Record<string, unknown>,
        progress: createCheckpointProgress({
          enumeratedEntryCount,
          scannedMediaCount,
          skippedCount,
          currentScanPath,
          scannedDirectoryCount,
          providerWarningKeys,
          businessProgress,
          movieTaskKeys,
          seriesTaskKeys,
        }),
        nfoSidecars: serializeNfoSidecars(nfoSidecars),
        changedItemIds: [...changedItemIds],
      });
      savedCheckpointSequence = candidate.checkpointSequence;
      if (replayingCheckpointWindow && candidate.checkpointSequence > restoredCheckpointSequence) {
        replayingCheckpointWindow = false;
      }
      this.logger.info({
        日志关键字: "codex-flycloud-helper-checkpoint",
        事件: "扫描安全检查点已保存",
        任务ID: job.id,
        扫描会话ID: checkpoint.scanSessionId,
        Provider游标序号: candidate.checkpointSequence,
        扫描根序号: candidate.rootIndex,
        待扫描目录数量: candidate.pendingDirectories.length,
        扫描视频数量: scannedMediaCount,
        处理影片数量: getHandledBusinessTaskCount(businessProgress),
      });
    };

    for await (const entry of adapter.enumerate(connection, roots, signal, (warning) => {
      providerWarningKeys.add(`${warning.code}\u0000${warning.path}`);
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
      checkpointDirectoryInterval: 20,
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
      await persistCheckpointCandidate();
      await throwTmdbRecoveryAfterDraining();
      const requestedControl = await this.repository.getJobControl(job.id);
      if (requestedControl !== "none") {
        // 当前窗口不覆盖上一安全检查点；恢复时重放该窗口，避免进度和游标跨时刻造成漏扫。
        await flushActiveDirectory();
        await Promise.all([...pendingBusinessTasks]);
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
        ? matchingRoot.mediaTypes.filter((item): item is MediaType => item === "video")
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
            const nfoText = await adapter.readText(connection, entry, signal);
            const nfoPath = path.posix.normalize(entry.path);
            nfoSidecars.set(nfoPath, { path: nfoPath, metadata: parseFlymbyNfo(nfoText) });
            this.logger.info({
              日志关键字: "codex-flycloud-helper-scrape",
              事件: "读取NFO成功",
              任务ID: job.id,
              NFO路径: nfoPath,
              NFO类型: nfoSidecars.get(nfoPath)?.metadata.rootType ?? "unknown",
            });
          } catch (error) {
            this.logger.warn({
              日志关键字: "codex-flycloud-helper-scrape",
              事件: "读取NFO失败并回退在线刮削",
              任务ID: job.id,
              NFO路径: entry.path,
              错误码: error && typeof error === "object" && "code" in error
                ? String((error as { code?: string }).code)
                : "nfo_read_failed",
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
        sourceFile: null,
        preparationError: null,
      };
      activeDirectoryItems.push(candidate);
      try {
        const sourceFileInput: SourceFileRecord = {
          id: createStableId("src", job.tenantId, job.libraryId, entry.resourceId),
          tenantId: job.tenantId,
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
          locator: entry.locator,
        };
        const unchangedSource = await this.repository.markSourceFileSeenIfUnchanged(sourceFileInput);
        if (job.scanMode === "incremental" && unchangedSource && !isRetryJob && !replayingCheckpointWindow) {
          candidate.shouldProcess = false;
          skippedCount += 1;
          if (shouldPublishProgress()) {
            await publishProgress("enumerating");
          }
          continue;
        }
        candidate.sourceFile = await this.repository.upsertSourceFile(sourceFileInput);
      } catch (error) {
        candidate.preparationError = error;
      }
      if (shouldPublishProgress()) {
        await publishProgress("enumerating");
      }
    }

    if (signal.aborted) {
      // 进程关闭时保留 running 状态和最近安全检查点；下次启动由 recoverInterruptedJobs 重新入队。
      await Promise.allSettled([...pendingBusinessTasks]);
      this.logger.info({
        日志关键字: "codex-flycloud-helper-checkpoint",
        事件: "Worker停止后保留扫描检查点",
        任务ID: job.id,
        扫描会话ID: checkpoint.scanSessionId,
        Provider游标序号: savedCheckpointSequence,
      });
      return;
    }

    // Provider 已停止返回文件，最后一个目录也必须立即入队，再等待队列中剩余的刮削任务完成。
    await flushActiveDirectory();
    this.logger.info({
      日志关键字: "codex-flycloud-helper-task-count",
      事件: "扫描刮削流水线完成任务聚合",
      任务ID: job.id,
      扫描视频数量: scannedMediaCount,
      目录数量: scannedDirectoryCount,
      电影节目任务数量: businessProgress.taskKeys.size,
      电影任务数量: movieTaskKeys.size,
      节目任务数量: seriesTaskKeys.size,
      待完成刮削数量: pendingBusinessTasks.size,
      TMDB可用Key数量: this.tmdb.getStatus().healthyCount,
    });
    if (businessProgress.taskKeys.size > 0 && this.tmdb.getStatus().healthyCount <= 0) {
      this.logger.warn({
        日志关键字: "codex-flycloud-helper-task-count",
        事件: "当前没有可用TMDB Key",
        任务ID: job.id,
        影响: "没有本地NFO匹配的电影节目将计入错误，不计入未匹配",
        电影节目任务数量: businessProgress.taskKeys.size,
      });
    }
    await publishProgress("scraping");
    await Promise.all(pendingBusinessTasks);
    await throwTmdbRecoveryAfterDraining();
    await publishProgress("scraping");

    if (signal.aborted) {
      this.logger.info({
        日志关键字: "codex-flycloud-helper-checkpoint",
        事件: "刮削阶段停止后保留扫描检查点",
        任务ID: job.id,
        扫描会话ID: checkpoint.scanSessionId,
        Provider游标序号: savedCheckpointSequence,
      });
      return;
    }

    await publishProgress("persisting");
    this.logger.info({
      日志关键字: "codex-flycloud-helper-catalog-batch",
      事件: "准备分批写入目录变化",
      任务ID: job.id,
      目录变化数量: changedItemIds.size,
    });
    const removedRootPolicy = String(runtime.scanProfile.removedRootPolicy ?? "protect");
    const providerWarningCount = providerWarningKeys.size;
    const completedRootRuns = await this.repository.listCompletedScanRootRuns(job.id);
    // 关键变量：全局排除项清理仍要求所有根完整；缺失文件只对各自完整根执行。
    const allowDestructiveCleanup = providerWarningCount === 0 && completedRootRuns.length === roots.length;
    if (!allowDestructiveCleanup) {
      this.logger.warn({
        日志关键字: "codex-flycloud-helper-scrape-flow",
        事件: "目录枚举不完整已跳过过期数据清理",
        任务ID: job.id,
        Provider警告数量: providerWarningCount,
        配置扫描根数量: roots.length,
        完整扫描根数量: completedRootRuns.length,
      });
    }
    this.logger.info({
      日志关键字: "codex-flycloud-helper-checkpoint",
      事件: "扫描根对账范围已确定",
      任务ID: job.id,
      配置扫描根数量: roots.length,
      完整扫描根数量: completedRootRuns.length,
      不完整目录警告数量: providerWarningCount,
      执行缺失对账: job.scanMode === "full"
        && removedRootPolicy === "delete_missing"
        && completedRootRuns.length > 0,
    });
    await this.repository.finalizeGeneration({
      tenantId: job.tenantId,
      serviceId: job.serviceId,
      libraryId: job.libraryId,
      generationId,
      completedRootGenerations: completedRootRuns.map((rootRun) => ({
        rootKey: rootRun.rootKey,
        generationId: rootRun.generationId,
      })),
      // 带警告根不会进入 completedRootRuns，因此不会据此判断该根文件已经消失。
      deleteMissing: job.scanMode === "full"
        && removedRootPolicy === "delete_missing"
        && completedRootRuns.length > 0,
      allowDestructiveCleanup,
      changedItemIds: [...changedItemIds],
    });
    await this.repository.finishJob(job.id, { status: "completed" });
    this.logger.info({
      日志关键字: "codex-flycloud-helper-task-count",
      事件: "扫描增量结果",
      任务ID: job.id,
      扫描模式: job.scanMode,
      枚举文件数量: enumeratedEntryCount,
      扫描媒体文件数量: scannedMediaCount,
      电影节目任务数量: businessProgress.taskKeys.size,
      处理电影节目数量: getHandledBusinessTaskCount(businessProgress),
      匹配电影节目数量: businessProgress.matchedKeys.size,
      未匹配电影节目数量: businessProgress.unmatchedKeys.size,
      错误电影节目数量: businessProgress.failedKeys.size,
      Provider警告数量: providerWarningCount,
      跳过数量: skippedCount,
      当前扫描路径: currentScanPath,
      目录变化数量: changedItemIds.size,
    });
    this.logger.info({
      日志标记: "flycloud-helper-worker",
      事件: "扫描任务完成",
      任务ID: job.id,
      已处理: getHandledBusinessTaskCount(businessProgress),
      已跳过: skippedCount,
      错误数: businessProgress.failedKeys.size,
    });
  }

  /** 完成单个已发现视频的刮削、父子条目落库和文件定位关联。 */
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
    if (input.descriptor.parent) {
      const parentMetadata = metadata.parent ?? metadata;
      const parentIdentityKey = resolveCatalogIdentityKey(input.descriptor, parentMetadata, true);
      const parentResult = await this.repository.upsertMediaItem({
        id: createStableId("itm", input.job.tenantId, input.job.libraryId, parentIdentityKey),
        tenantId: input.job.tenantId,
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
      parentItemId = parentResult.itemId;
      if (parentResult.changed || input.forceCatalogChange) changedItemIds.push(parentResult.itemId);
    }
    const itemIdentityKey = resolveCatalogIdentityKey(input.descriptor, metadata, false);
    const itemResult = await this.repository.upsertMediaItem({
      id: createStableId("itm", input.job.tenantId, input.job.libraryId, itemIdentityKey),
      tenantId: input.job.tenantId,
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
    await this.repository.linkItemFile({
      tenantId: input.job.tenantId,
      libraryId: input.job.libraryId,
      itemId: itemResult.itemId,
      sourceFileId: input.sourceFile.id,
      locator: input.entryLocator,
    });
    if (parentItemId && input.descriptor.parent) {
      await this.repository.linkMediaRelation({
        tenantId: input.job.tenantId,
        libraryId: input.job.libraryId,
        parentItemId,
        childItemId: itemResult.itemId,
        relationType: input.descriptor.parent.relationType,
        sortOrder: input.descriptor.parent.sortOrder,
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
          return {
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
        }
      }
      if (profile.retryProviderId === null || profile.retryProviderId === undefined) {
        return this.createLocalMetadata(descriptor);
      }
    }
    if (descriptor.mediaType === "video" && (!providerId || providerId === "tmdb" || providerId === "builtin.tmdb")) {
      const tmdbResult = await this.enrichVideoFromTmdb(descriptor, profile, cache, jobId, signal);
      if (tmdbResult) return tmdbResult;
    }
    if (descriptor.mediaType === "music" && descriptor.itemType === "music.track") {
      const selectedProviderId = providerId.startsWith("plugin:")
        ? String(profile.retryProviderId ?? "")
        : providerId || "auto";
      if (selectedProviderId === "auto") {
        const automaticResult = await this.searchAutomaticMusicMetadata(descriptor, profile, jobSnapshot, signal);
        if (automaticResult) return automaticResult;
      } else if (selectedProviderId === "builtin.musicbrainz" || selectedProviderId === "musicbrainz") {
        const musicBrainzResult = await this.searchMusicBrainzMetadata(descriptor, signal);
        if (musicBrainzResult) return musicBrainzResult;
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
        localPosterValue: nfo.posterValue,
        localBackdropValue: nfo.backdropValue,
      },
    };
  }

  /** 按电影或节目聚合键执行 TMDB 刮削，并给单集附加季接口返回的元数据。 */
  private async enrichVideoFromTmdb(
    descriptor: MediaDescriptor,
    profile: Record<string, unknown>,
    cache: ScanMetadataCache,
    jobId: string,
    signal: AbortSignal,
  ): Promise<EnrichedMetadata | null> {
    const mediaType = descriptor.itemType === "video.episode" ? "tv" : "movie";
    const query = String(descriptor.metadata.query ?? descriptor.parent?.title ?? descriptor.title).trim();
    if (!query) return null;
    const language = String(profile.language ?? "zh-CN");
    const region = String(profile.region ?? "CN");
    const imdbId = typeof descriptor.metadata.imdbId === "string" ? descriptor.metadata.imdbId : "";
    const explicitTmdbId = Number(descriptor.metadata.explicitTmdbId ?? 0);
    const temporaryError = this.tmdb.getTemporaryUnavailableError();
    if (temporaryError) throw temporaryError;
    if (this.tmdb.getStatus().healthyCount <= 0) return null;
    if (explicitTmdbId <= 0 && !imdbId && isWeakFlymbyScrapeTitle(query)) {
      this.logger.warn({
        日志关键字: "codex-flycloud-helper-match-guard",
        事件: "跳过弱标题自动匹配",
        任务ID: jobId,
        媒体类型: mediaType === "tv" ? "节目" : "电影",
        查询标题: query,
      });
      return null;
    }
    const cacheKey = `${mediaType}|${String(descriptor.metadata.scrapeTaskKey ?? query)}|${language}|${region}`;
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
        year: descriptor.year,
        language,
        region,
        imdbId,
        explicitTmdbId,
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
      });
    }

    const parentMetadata = this.mapTmdbVideoMetadata(result, descriptor.parent?.subtitle ?? descriptor.subtitle);
    if (mediaType === "movie") return parentMetadata;
    const seasonNumber = Math.max(0, Number(descriptor.metadata.seasonNumber ?? 1));
    const episodeNumber = Math.max(1, Number(descriptor.metadata.episodeNumber ?? 1));
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
        resolution: descriptor.metadata.resolution,
        source: descriptor.metadata.source,
        releaseGroup: descriptor.metadata.releaseGroup,
      },
      parent: parentMetadata,
    };
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
        people: result.people,
        episodeCount: result.episodeCount,
        matchedQuery: result.matchedQuery,
        candidateCount: result.candidateCount,
      },
    };
  }

  /** 使用本地文件识别结果构造不依赖外部来源的元数据。 */
  private createLocalMetadata(descriptor: MediaDescriptor): EnrichedMetadata {
    const localMetadata: EnrichedMetadata = {
      title: descriptor.title,
      subtitle: descriptor.subtitle,
      year: descriptor.year,
      overview: "",
      posterUrl: null,
      backdropUrl: null,
      matchState: descriptor.matchState,
      externalIds: {} as Record<string, string>,
      metadata: {} as Record<string, unknown>,
    };
    if (descriptor.parent) {
      // 关键变量：未匹配单集必须仍以节目目录标题创建父项，不能把“第 N 集”写成节目名称。
      localMetadata.parent = {
        title: descriptor.parent.title,
        subtitle: descriptor.parent.subtitle,
        year: descriptor.parent.year,
        overview: "",
        posterUrl: null,
        backdropUrl: null,
        matchState: descriptor.matchState,
        externalIds: {},
        metadata: {},
      };
    }
    return localMetadata;
  }

  /** 参考 FlymbyServer 的 fast/complete 策略并发聚合 MusicBrainz 与已启用音乐插件。 */
  private async searchAutomaticMusicMetadata(
    descriptor: MediaDescriptor,
    profile: Record<string, unknown>,
    jobSnapshot: Record<string, unknown>,
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
    const tasks: Array<Promise<EnrichedMetadata | null>> = [this.searchMusicBrainzMetadata(descriptor, signal)];
    for (const snapshot of pluginSnapshots) {
      tasks.push(this.plugins.scrape(snapshot, query, signal).then((result) => result ? {
        title: result.title,
        subtitle: result.subtitle || descriptor.subtitle,
        year: result.year ?? descriptor.year,
        overview: result.overview,
        posterUrl: result.posterUrl,
        backdropUrl: result.backdropUrl,
        matchState: "matched" as const,
        externalIds: result.externalId ? { [`plugin:${snapshot.pluginId}`]: result.externalId } : {},
        metadata: { ...result.metadata, metadataPluginId: snapshot.pluginId, metadataPluginVersion: snapshot.version },
      } : null).catch(() => null));
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

  /** 查询 MusicBrainz 并转换为目录统一字段。 */
  private async searchMusicBrainzMetadata(descriptor: MediaDescriptor, signal: AbortSignal): Promise<EnrichedMetadata | null> {
    const artist = String(descriptor.metadata.artist ?? "");
    const result = await this.musicBrainz.searchTrack(descriptor.title, artist, signal);
    if (!result || result.score < 80) return null;
    return {
      title: result.title,
      subtitle: `${result.artist} · ${result.album}`,
      year: result.year,
      overview: "",
      posterUrl: result.coverUrl,
      backdropUrl: null,
      matchState: "matched",
      externalIds: { musicbrainz: result.recordingId },
      metadata: {
        artist: result.artist,
        album: result.album,
        albumArtist: result.albumArtist,
        durationMs: result.durationMs,
        matchScore: result.score,
      },
    };
  }
}
