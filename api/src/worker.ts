import path from "node:path";
import type { ApiConfig } from "./config.js";
import type { FlyCloudHelperDatabase } from "./database.js";
import type { MediaType, ScanJobRecord, SourceFileRecord } from "./domain.js";
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
  readAiModelTaskSnapshot,
  type AiVideoNameCandidateContext,
  type AiVideoNameCleanResult,
} from "./media/ai-video-name-cleaner.js";
import type { AiModelManager } from "./ai/ai-model-manager.js";
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
import {
  ScanFailureReportService,
  type ScanFailureRecordInput,
} from "./scan-failure-report-service.js";
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

/** 从业务异常读取稳定错误码，缺少错误码时使用调用方给出的分类。 */
function readFailureCode(error: unknown, fallback: string): string {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: string }).code || fallback)
    : fallback;
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

// 关键变量：解析规则变化时提升版本，旧NFO缓存会自动失效并重新下载解析。
const FLYMBY_NFO_PARSER_CACHE_VERSION = "flymby-nfo-v1";

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
  private readonly database: FlyCloudHelperDatabase;
  private readonly repository: ServiceRepository;
  private readonly providers: ProviderRegistry;
  private readonly vault: CredentialVault;
  private readonly tmdb: TmdbKeyPool;
  private readonly musicBrainz: MusicBrainzClient;
  private readonly plugins: MetadataPluginManager;
  private readonly aiVideoNameCleaner: AiVideoNameCleaner;
  private readonly failureReports: ScanFailureReportService;
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
    logger: WorkerLogger;
    config: ApiConfig;
  }) {
    this.database = input.database;
    this.repository = input.repository;
    this.providers = input.providers;
    this.vault = input.vault;
    this.tmdb = input.tmdb;
    this.musicBrainz = input.musicBrainz;
    this.plugins = input.plugins;
    this.aiVideoNameCleaner = new AiVideoNameCleaner(input.database, input.aiModels, input.logger);
    this.failureReports = input.failureReports;
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
    this.logger.info({
      日志标记: "flycloud-helper-worker",
      事件: "扫描任务开始",
      任务ID: job.id,
      服务ID: job.serviceId,
    });
    try {
      await this.scan(job, controller.signal);
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
        errorMessage: toSafeErrorMessage(error, "扫描任务失败"),
      });
      await this.database.createNotificationSafely({
        userId: job.userId,
        category: "task",
        tone: "danger",
        title: "扫描任务失败",
        message: `服务“${job.serviceName}”的${job.scanMode === "full" ? "全量" : "增量"}扫描失败：${toSafeErrorMessage(error, "扫描任务失败")}`,
        actionPath: "/app/jobs",
      });
      this.logger.warn({
        日志标记: "flycloud-helper-worker",
        事件: "扫描任务失败",
        任务ID: job.id,
        错误码: code,
      });
    } finally {
      this.abortControllers.delete(job.id);
      this.failureReports.release(job.id);
    }
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
    const videoMetadataProfile = readMetadataProfile(runtime.metadataProfile, "video");
    const videoMetadataProviderId = readMetadataProviderId(videoMetadataProfile);
    const usesBuiltinTmdb = !videoMetadataProviderId
      || videoMetadataProviderId === "tmdb"
      || videoMetadataProviderId === "builtin.tmdb";
    // 关键变量：前端保存的 metadata.profiles.video.useNfo 是本地 NFO 的唯一开关。
    const useLocalVideoNfo = videoMetadataProfile.useNfo !== false;
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
    // 关键变量：前端按 5 秒轮询任务，Worker 使用相同间隔写入任务表，避免无效高频数据库更新。
    const progressPublishIntervalMs = 5_000;
    // 关键变量：跨进程控制最多每 500ms 读取一次数据库；同进程控制仍由 AbortSignal 立即打断。
    const jobControlPollIntervalMs = 500;
    let nextJobControlPollAt = 0;
    // 关键变量：与 Flymby APP 的刮削任务相同，按完整电影或节目聚合统计，不按视频文件累计。
    const businessProgress = createBusinessTaskProgress(savedProgress);
    // 关键变量：重试任务必须重新处理上次已落库的未匹配文件，不能套用普通增量扫描的未变更跳过规则。
    const isRetryJob = typeof job.snapshot.retryOfJobId === "string" && job.snapshot.retryOfJobId.length > 0;
    // 仅把真实变化的媒体条目写入目录变化流，避免每轮扫描生成全量 upsert。
    const changedItemIds = new Set(checkpoint.changedItemIds);
    // 关键变量：任务级刮削缓存，避免同一节目数百个单集重复请求 TMDB。
    const metadataCache: ScanMetadataCache = {
      video: new Map(),
      seasons: new Map(),
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
    // 关键变量：全量扫描按Provider独立上限运行，避免统一单目录串行，也防止高并发触发网盘限流。
    const effectiveScanDirectoryConcurrency = job.scanMode === "full"
      ? Math.min(configuredScanDirectoryConcurrency, recommendedSettings.fullScanDirectoryConcurrency)
      : configuredScanDirectoryConcurrency;
    const configuredScrapeTaskConcurrency = readProviderConcurrency(
      runtime.scanProfile.scrapeTaskConcurrency,
      recommendedSettings.scrapeTaskConcurrency,
    );
    // 关键变量：影片解析和落库使用 APP 配置的任务并发；TMDB Key 池在请求层独立限制网络并发。
    const scrapeConcurrency = Math.max(1, configuredScrapeTaskConcurrency);
    const tmdbRequestConcurrency = this.tmdb.getStatus().effectiveConcurrency;
    const metadataProfileRevision = Number(job.snapshot.metadataProfileRevision ?? 0);
    // 关键变量：任务始终使用创建时冻结的模型修订，暂停恢复后也不会切换到新配置。
    const aiModelSnapshot = readAiModelTaskSnapshot(job.snapshot.aiModel);
    const recognitionRevision = buildAiRecognitionRevision(metadataProfileRevision, aiModelSnapshot);
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
    };
    /** 控制扫描中进度写入频率；前端每 5 秒读取一次，数据库使用相同更新间隔。 */
    const shouldPublishProgress = (): boolean => enumeratedEntryCount === 1
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
      全量扫描并发上限: recommendedSettings.fullScanDirectoryConcurrency,
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
              metadataProfiles: runtime.metadataProfile,
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
                error: new Error(mediaResult.providerUnavailable ? "当前没有可用的影视元数据来源" : "没有匹配到影视元数据"),
                recovered: false,
                mediaPath: candidate.entry.path,
                resourceId: candidate.entry.resourceId,
                fileName: candidate.entry.name,
                itemType: descriptor.itemType,
                parsedTitle: descriptor.title,
                businessTaskKey,
                context: {
                  使用元数据Provider: readMetadataProviderId(videoMetadataProfile) || "builtin.tmdb",
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

          // 关键变量：先完成源文件复用判断，只为本轮确实需要处理且没有同目录 NFO 的弱标题调用模型。
          const directoryPath = path.posix.dirname(firstItem.entry.path);
          const directoryHasNfo = [...nfoSidecars.keys()].some((nfoPath) => path.posix.dirname(nfoPath) === directoryPath);
          if (aiModelSnapshot && !directoryHasNfo && directoryItems.some((candidate) => candidate.shouldProcess)) {
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

          const directoryTasks = new Map<string, PendingBusinessMedia[]>();
          for (const candidate of directoryItems) {
            if (!candidate.shouldProcess) continue;
            const descriptor = descriptors.get(candidate.entry.resourceId);
            if (!descriptor) continue;
            const businessTaskKey = readBusinessTaskKey(descriptor);
            const aiContext = aiContextsByResourceId.get(candidate.entry.resourceId);
            if (aiContext) metadataCache.aiContexts.set(businessTaskKey, aiContext);
            const taskItems = directoryTasks.get(businessTaskKey) ?? [];
            taskItems.push({ descriptor, candidate });
            directoryTasks.set(businessTaskKey, taskItems);
            businessProgress.taskKeys.add(businessTaskKey);
            if (descriptor.itemType === "video.movie") movieTaskKeys.add(businessTaskKey);
            else seriesTaskKeys.add(businessTaskKey);
          }
          const businessTasks = [...directoryTasks].map(([businessTaskKey, taskItems]) => (
            enqueueBusinessTask(businessTaskKey, taskItems)
          ));
          if (directoryTasks.size > 0 && (scannedDirectoryCount <= 10 || scannedDirectoryCount % 50 === 0)) {
            this.logger.info({
              日志关键字: "codex-flycloud-helper-streaming-scrape",
              事件: "目录影片任务已加入刮削队列",
              任务ID: job.id,
              目录标识: flushedDirectoryKey,
              目录视频数量: directoryItems.length,
              目录任务数量: directoryTasks.size,
              待准备目录数量: pendingDirectoryFlushTasks.size,
              待完成刮削数量: pendingBusinessTasks.size,
              已发现影片任务数量: businessProgress.taskKeys.size,
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
    this.logger.info({
      日志关键字: "codex-flycloud-helper-task-count",
      事件: "扫描刮削流水线完成任务聚合",
      任务ID: job.id,
      扫描视频数量: scannedMediaCount,
      目录数量: scannedDirectoryCount,
      电影节目任务数量: businessProgress.taskKeys.size,
      电影任务数量: movieTaskKeys.size,
      节目任务数量: seriesTaskKeys.size,
      待准备目录数量: pendingDirectoryFlushTasks.size,
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
      // 带警告根不会进入 completedRootRuns，因此不会据此判断该根文件已经消失。
      deleteMissing: job.scanMode === "full"
        && removedRootPolicy === "delete_missing"
        && completedRootRuns.length > 0,
      allowDestructiveCleanup,
      changedItemIds: [...changedItemIds],
    });
    this.logger.info({
      日志关键字: "codex-flycloud-file-link-repair",
      事件: "扫描收尾文件唯一归属对账完成",
      任务ID: job.id,
      媒体库ID: job.libraryId,
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
    await this.database.createNotificationSafely({
      userId: job.userId,
      category: "task",
      tone: businessProgress.failedKeys.size > 0 ? "warning" : "success",
      title: "扫描任务已完成",
      message: `服务“${job.serviceName}”的${job.scanMode === "full" ? "全量" : "增量"}扫描已完成：处理 ${getHandledBusinessTaskCount(businessProgress)}，匹配 ${businessProgress.matchedKeys.size}，未匹配 ${businessProgress.unmatchedKeys.size}，错误 ${businessProgress.failedKeys.size}。`,
      actionPath: "/app/jobs",
    });
    this.logger.info({
      日志关键字: "codex-flycloud-helper-task-count",
      性能日志关键字: "codex-flycloud-scan-performance",
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
      复用已匹配文件数量: reusedMatchedSourceFileCount,
      复用NFO缓存数量: reusedNfoSidecarCount,
      下载NFO数量: downloadedNfoSidecarCount,
      当前扫描路径: currentScanPath,
      目录变化数量: changedItemIds.size,
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
        处理电影节目数量: getHandledBusinessTaskCount(businessProgress),
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
    let parentItemState: {
      itemId: string;
      changed: boolean;
      hasManualMatch: boolean;
      itemType: string;
    } | null = null;
    if (input.descriptor.parent) {
      const parentMetadata = metadata.parent ?? metadata;
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
      const tmdbResult = await this.enrichVideoFromTmdb(descriptor, profile, jobSnapshot, cache, jobId, signal);
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
        resolveSecondSearchTitle: aiModelSnapshot?.triggerMode === "weak_or_unmatched"
          && explicitTmdbId <= 0
          && !imdbId
          && aiContext
          ? () => this.aiVideoNameCleaner.resolveSecondSearchTitle({
            context: aiContext,
            snapshot: aiModelSnapshot,
            jobId,
            userId: cache.aiUsageOwner.userId,
            serviceId: cache.aiUsageOwner.serviceId,
            taskCache: cache.aiResults,
            signal,
          })
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
        episodeCount: result.episodeCount,
        matchedQuery: result.matchedQuery,
        candidateCount: result.candidateCount,
        tmdbDetailsSynchronized: result.detailsSynchronized,
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
