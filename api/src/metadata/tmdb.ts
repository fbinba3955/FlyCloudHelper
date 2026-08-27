import { createHash } from "node:crypto";
import type { ApiConfig } from "../config.js";
import { FlymbyVideoTitleCleaner } from "../media/flymby-video-title-cleaner.js";
import type { TmdbMetadataCache } from "./tmdb-cache.js";

interface TmdbKeyState {
  key: string;
  inFlight: number;
  cooldownUntil: number;
  disabled: boolean;
  /** 连续临时失败次数，用于计算单 Key 的短暂退避时间。 */
  temporaryFailureCount: number;
  /** 最近一次临时退出调度池的原因，不包含 Key 原文。 */
  temporaryReason: TmdbTemporarilyUnavailableError["reasonCode"] | null;
}

interface TmdbSearchCandidate {
  id: number;
  title: string;
  originalTitle: string;
  overview: string;
  date: string;
  posterPath: string;
  backdropPath: string;
  voteAverage: number;
  popularity: number;
  genreIds: number[];
  originCountries: string[];
}

type TmdbDiagnosticLogger = (fields: Record<string, unknown>) => void;

const TMDB_REQUEST_TIMEOUT_MS = 20_000;

/** 区分 TMDB 的未找到与真实请求失败，避免把网络异常统计成“未匹配”。 */
class TmdbRequestError extends Error {
  public readonly status: number;

  public constructor(message: string, status = 0) {
    super(message);
    this.name = "TmdbRequestError";
    this.status = status;
  }
}

/** 表示 TMDB Key 池暂时没有可用 Key，Worker 应保留检查点并延迟恢复。 */
export class TmdbTemporarilyUnavailableError extends Error {
  public readonly code = "tmdb_temporarily_unavailable";
  public readonly nextRetryAt: string;
  public readonly reasonCode: "tmdb_rate_limit" | "tmdb_server_error" | "tmdb_network";

  public constructor(
    nextRetryAt: string,
    reasonCode: "tmdb_rate_limit" | "tmdb_server_error" | "tmdb_network",
  ) {
    super(`TMDB 暂时不可用，将在 ${nextRetryAt} 后自动恢复`);
    this.name = "TmdbTemporarilyUnavailableError";
    this.nextRetryAt = nextRetryAt;
    this.reasonCode = reasonCode;
  }
}

/** 判断未知异常是否为任务级 TMDB 延迟恢复信号。 */
export function isTmdbTemporarilyUnavailableError(error: unknown): error is TmdbTemporarilyUnavailableError {
  return error instanceof TmdbTemporarilyUnavailableError
    || Boolean(error && typeof error === "object"
      && "code" in error
      && String((error as { code?: string }).code) === "tmdb_temporarily_unavailable"
      && "nextRetryAt" in error);
}

/** 提供给手动匹配页面展示的安全 TMDB 候选摘要。 */
export interface TmdbVideoSearchCandidate {
  id: number;
  mediaType: "movie" | "tv";
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

export interface TmdbPersonMetadata {
  id: number;
  name: string;
  role: string;
  type: "cast" | "crew";
  profileUrl: string | null;
  order: number;
}

export interface TmdbVideoMetadata {
  id: number;
  mediaType: "movie" | "tv";
  title: string;
  originalTitle: string;
  overview: string;
  year: number | null;
  releaseDate: string;
  rating: number;
  genres: string[];
  /** 节目的 TMDB origin_country；电影不参与地区媒体库分类。 */
  originCountries: string[];
  posterUrl: string | null;
  backdropUrl: string | null;
  episodeCount: number;
  people: TmdbPersonMetadata[];
  matchedQuery: string;
  candidateCount: number;
  /** true 表示已经读取详情接口；false 表示当前只有搜索候选摘要。 */
  detailsSynchronized: boolean;
}

export interface TmdbEpisodeMetadata {
  id: number;
  seasonNumber: number;
  episodeNumber: number;
  title: string;
  overview: string;
  airDate: string;
  rating: number;
  stillUrl: string | null;
  durationMs: number;
}

export interface TmdbVideoQuery {
  mediaType: "movie" | "tv";
  title: string;
  /** 目录标题无候选时使用的文件名查询词。 */
  fallbackTitle?: string;
  /** 首次标题没有候选时，延迟生成第二查询词；用于避免正常命中时调用 AI。 */
  resolveSecondSearchTitle?: () => Promise<string>;
  /** 会影响动态第二查询词的识别修订，参与部署级公共缓存键。 */
  cacheRevision?: string;
  year: number | null;
  language: string;
  region: string;
  imdbId?: string;
  explicitTmdbId?: number;
  /** false 时普通标题匹配命中后直接返回搜索摘要，不在扫描阶段读取详情。 */
  includeDetails?: boolean;
  signal?: AbortSignal;
}

const movieGenreNames: Record<number, string> = {
  12: "冒险", 14: "奇幻", 16: "动画", 18: "剧情", 27: "恐怖", 28: "动作", 35: "喜剧",
  36: "历史", 37: "西部", 53: "惊悚", 80: "犯罪", 99: "纪录", 878: "科幻", 9648: "悬疑",
  10402: "音乐", 10749: "爱情", 10751: "家庭", 10752: "战争", 10770: "电视电影",
};

const tvGenreNames: Record<number, string> = {
  16: "动画", 18: "剧情", 35: "喜剧", 37: "西部", 80: "犯罪", 99: "纪录", 9648: "悬疑",
  10751: "家庭", 10759: "动作冒险", 10762: "儿童", 10763: "新闻", 10764: "真人秀",
  10765: "科幻奇幻", 10766: "肥皂剧", 10767: "访谈", 10768: "战争政治",
};

/** 管理部署级 TMDB 多 Key 状态，并实现 Flymby APP 同语义的影视刮削。 */
export class TmdbKeyPool {
  private states: TmdbKeyState[];
  private readonly perKeyConcurrency: number;
  private readonly maxConcurrency: number;
  private readonly diagnosticLogger: TmdbDiagnosticLogger;
  private readonly persistentCache?: TmdbMetadataCache;
  private revisionValue: string;

  public constructor(
    config: ApiConfig,
    keys: string[] = [],
    diagnosticLogger: TmdbDiagnosticLogger = () => undefined,
    persistentCache?: TmdbMetadataCache,
  ) {
    this.states = keys.map((key) => ({
      key,
      inFlight: 0,
      cooldownUntil: 0,
      disabled: false,
      temporaryFailureCount: 0,
      temporaryReason: null,
    }));
    this.perKeyConcurrency = config.tmdbPerKeyConcurrency;
    this.maxConcurrency = config.tmdbMaxConcurrency;
    this.diagnosticLogger = diagnosticLogger;
    this.persistentCache = persistentCache;
    this.revisionValue = this.createRevision(keys);
  }

  /** 返回当前 Key 池修订，不包含 Key 原文。 */
  public get revision(): string {
    return this.revisionValue;
  }

  /** 即时替换系统配置的 Key，同时保留未删除 Key 的健康状态。 */
  public replaceKeys(keys: string[]): void {
    const existingStates = new Map(this.states.map((state) => [state.key, state]));
    this.states = keys.map((key) => existingStates.get(key) ?? {
      key,
      inFlight: 0,
      cooldownUntil: 0,
      disabled: false,
      temporaryFailureCount: 0,
      temporaryReason: null,
    });
    this.revisionValue = this.createRevision(keys);
  }

  /** 返回不含 Key 内容的运行状态。 */
  public getStatus() {
    const now = Date.now();
    const healthy = this.states.filter((state) => !state.disabled && state.cooldownUntil <= now).length;
    const cooling = this.states.filter((state) => !state.disabled && state.cooldownUntil > now).length;
    return {
      configuredCount: this.states.length,
      healthyCount: healthy,
      coolingCount: cooling,
      disabledCount: this.states.filter((state) => state.disabled).length,
      effectiveConcurrency: Math.min(this.maxConcurrency, healthy * this.perKeyConcurrency),
      revision: this.revision,
    };
  }

  /** 所有未禁用 Key 均在冷却时，返回最早可重试时间对应的任务级恢复信号。 */
  public getTemporaryUnavailableError(): TmdbTemporarilyUnavailableError | null {
    const now = Date.now();
    const coolingStates = this.states.filter((state) => !state.disabled && state.cooldownUntil > now);
    const hasHealthyState = this.states.some((state) => !state.disabled && state.cooldownUntil <= now);
    if (hasHealthyState || coolingStates.length === 0) return null;
    const nextState = [...coolingStates].sort((left, right) => left.cooldownUntil - right.cooldownUntil)[0]!;
    const nextRetryTimestamp = nextState.cooldownUntil;
    return new TmdbTemporarilyUnavailableError(
      new Date(Math.max(now + 1_000, nextRetryTimestamp)).toISOString(),
      nextState.temporaryReason ?? "tmdb_network",
    );
  }

  /**
   * 按 APP 的顺序查询电影或节目：目录标题带年份，失败后最多再使用一次文件名或简化标题。
   * 命中候选后继续读取详情和演职人员，避免只把搜索摘要当作完整刮削结果。
   */
  public async scrapeVideo(query: TmdbVideoQuery): Promise<TmdbVideoMetadata | null> {
    if (query.signal?.aborted) return null;
    const explicitTmdbId = Number(query.explicitTmdbId ?? 0);
    if (explicitTmdbId > 0) {
      const directMetadata = await this.readCachedVideo(
        this.buildVideoIdCacheKey(query.mediaType, explicitTmdbId, query.language, query.region),
      );
      if (directMetadata) return directMetadata;
    }
    // 关键变量：查询缓存键包含会影响匹配结果的全部公共参数，不包含用户、服务或网盘身份。
    const queryCacheKey = this.buildVideoQueryCacheKey(query);
    const cachedMetadata = await this.readCachedVideo(queryCacheKey);
    if (cachedMetadata) return cachedMetadata;
    if (this.states.length === 0) return null;
    const metadata = await this.scrapeVideoFromRemote(query);
    if (!metadata) return null;
    await this.writeCachedVideo(queryCacheKey, query.language, query.region, metadata);
    if (metadata.detailsSynchronized) {
      await this.writeCachedVideo(
        this.buildVideoIdCacheKey(metadata.mediaType, metadata.id, query.language, query.region),
        query.language,
        query.region,
        metadata,
      );
    }
    return metadata;
  }

  /** 未命中部署级缓存时，按 APP 的搜索、类型纠正和详情读取顺序请求 TMDB。 */
  private async scrapeVideoFromRemote(query: TmdbVideoQuery): Promise<TmdbVideoMetadata | null> {
    if (this.states.length === 0 || query.signal?.aborted) return null;
    const explicitId = Number(query.explicitTmdbId ?? 0);
    if (explicitId > 0) {
      // Flymby APP 在文件名显式 TMDB ID 已失效时不会直接判定未匹配，而是继续使用清洗后的标题搜索。
      const explicitResult = await this.readDetails(
        query.mediaType,
        explicitId,
        query.title,
        1,
        query.language,
        query.region,
        query.signal,
      );
      if (explicitResult) return explicitResult;
      const correctedMediaType = query.mediaType === "movie" ? "tv" : "movie";
      const correctedResult = await this.readDetails(
        correctedMediaType,
        explicitId,
        query.title,
        1,
        query.language,
        query.region,
        query.signal,
      );
      if (correctedResult) {
        this.diagnosticLogger({
          日志关键字: "codex-video-recognition-optimize",
          事件: "显式TMDB编号跨类型纠正成功",
          原媒体类型: query.mediaType === "tv" ? "节目" : "电影",
          纠正后媒体类型: correctedMediaType === "tv" ? "节目" : "电影",
          TMDB编号: explicitId,
          查询标题: query.title,
        });
        return correctedResult;
      }
      this.diagnosticLogger({
        日志关键字: "codex-flycloud-helper-scrape-flow",
        事件: "显式TMDB编号无效后回退标题搜索",
        媒体类型: query.mediaType === "tv" ? "节目" : "电影",
        显式TMDB编号: explicitId,
        回退标题: query.title,
      });
    }
    if (query.imdbId) {
      const externalId = await this.findTmdbIdByImdb(query.imdbId, query.mediaType, query.language, query.signal);
      if (externalId > 0) {
        return this.readDetails(query.mediaType, externalId, query.title, 1, query.language, query.region, query.signal);
      }
    }

    const primaryTitle = query.title.trim();
    const primaryCandidates = await this.searchCandidates(
      query.mediaType,
      primaryTitle,
      query.year,
      query.language,
      query.region,
      query.signal,
    );
    if (primaryCandidates.length > 0) {
      const candidate = this.pickCandidate(query.mediaType, primaryCandidates, primaryTitle, query.year);
      if (query.includeDetails === false) {
        return this.mapSearchCandidateMetadata(query.mediaType, candidate, primaryTitle, primaryCandidates.length);
      }
      return this.readDetails(
        query.mediaType,
        candidate.id,
        primaryTitle,
        primaryCandidates.length,
        query.language,
        query.region,
        query.signal,
        candidate,
      );
    }
    // 关键变量：只有第一次 TMDB 搜索确实没有候选时才延迟请求 AI，仍保持最多两次 TMDB 搜索。
    const aiSecondTitle = query.resolveSecondSearchTitle
      ? String(await query.resolveSecondSearchTitle()).trim()
      : "";
    // 关键变量：文件名回退优先于普通简化标题，并与主查询去重。
    const fileFallbackTitle = String(query.fallbackTitle ?? "").trim();
    const simplifiedTitle = FlymbyVideoTitleCleaner.buildAlternateTmdbSearchQuery(primaryTitle);
    const firstSeriesFallback = query.mediaType === "tv" && !fileFallbackTitle && !simplifiedTitle
      ? this.buildFirstSeriesTitleFallback(primaryTitle)
      : "";
    const normalizedPrimaryTitle = FlymbyVideoTitleCleaner.normalizeSearchText(primaryTitle);
    const validAiSecondTitle = FlymbyVideoTitleCleaner.normalizeSearchText(aiSecondTitle) === normalizedPrimaryTitle
      ? ""
      : aiSecondTitle;
    const alternateTitle = validAiSecondTitle || fileFallbackTitle || simplifiedTitle || firstSeriesFallback;
    const attempts: Array<{ title: string; year: number | null }> = [];
    // 关键变量：第二次查询同时放宽标题和年份，保持每个任务最多两次 TMDB 搜索。
    const relaxedTitle = alternateTitle || (query.year !== null ? primaryTitle : "");
    this.appendSearchAttempt(attempts, relaxedTitle, query.year !== null ? null : query.year);
    for (let attemptIndex = 0; attemptIndex < attempts.length; attemptIndex += 1) {
      const attempt = attempts[attemptIndex]!;
      const candidates = await this.searchCandidates(
        query.mediaType,
        attempt.title,
        attempt.year,
        query.language,
        query.region,
        query.signal,
      );
      if (candidates.length === 0) continue;
      const candidate = this.pickCandidate(query.mediaType, candidates, attempt.title, attempt.year);
      if (query.includeDetails === false) {
        return this.mapSearchCandidateMetadata(query.mediaType, candidate, attempt.title, candidates.length);
      }
      return this.readDetails(
        query.mediaType,
        candidate.id,
        attempt.title,
        candidates.length,
        query.language,
        query.region,
        query.signal,
        candidate,
      );
    }
    return null;
  }

  /** 兼容原电影调用点，内部使用完整电影刮削。 */
  public async searchMovie(
    title: string,
    year: number | null,
    language: string,
    region: string,
    signal?: AbortSignal,
  ): Promise<TmdbVideoMetadata | null> {
    return this.scrapeVideo({ mediaType: "movie", title, year, language, region, signal });
  }

  /** 按用户指定的电影或节目类型返回手动匹配候选，不自动选择结果。 */
  public async searchVideoCandidates(input: {
    mediaType: "movie" | "tv";
    title: string;
    year: number | null;
    language: string;
    region: string;
    signal?: AbortSignal;
  }): Promise<TmdbVideoSearchCandidate[]> {
    if (this.states.length === 0 || input.signal?.aborted || !input.title.trim()) return [];
    const candidates = await this.searchCandidates(
      input.mediaType,
      input.title.trim(),
      input.year,
      input.language,
      input.region,
      input.signal,
    );
    return candidates.slice(0, 20).map((candidate) => ({
      id: candidate.id,
      mediaType: input.mediaType,
      title: candidate.title,
      originalTitle: candidate.originalTitle,
      overview: candidate.overview,
      year: extractDateYear(candidate.date),
      releaseDate: candidate.date,
      posterUrl: buildImageUrl(candidate.posterPath, "w500"),
      backdropUrl: buildImageUrl(candidate.backdropPath, "w1280"),
      rating: candidate.voteAverage,
      popularity: candidate.popularity,
    }));
  }

  /** 重新读取用户选中的 TMDB 条目详情，避免信任浏览器回传的元数据内容。 */
  public async readVideoMetadata(
    mediaType: "movie" | "tv",
    tmdbId: number,
    language: string,
    region: string,
    signal?: AbortSignal,
  ): Promise<TmdbVideoMetadata | null> {
    if (tmdbId <= 0 || signal?.aborted) return null;
    const cacheKey = this.buildVideoIdCacheKey(mediaType, tmdbId, language, region);
    const cachedMetadata = await this.readCachedVideo(cacheKey);
    if (cachedMetadata) return cachedMetadata;
    if (this.states.length === 0) return null;
    const metadata = await this.readDetails(mediaType, tmdbId, "手动匹配", 1, language, region, signal);
    if (metadata) await this.writeCachedVideo(cacheKey, language, region, metadata);
    return metadata;
  }

  /** 读取节目季信息，并只返回本地文件实际需要的单集元数据。 */
  public async readTvSeason(
    tvId: number,
    seasonNumber: number,
    language: string,
    signal?: AbortSignal,
  ): Promise<TmdbEpisodeMetadata[]> {
    if (tvId <= 0 || seasonNumber < 0 || signal?.aborted) return [];
    const cacheKey = this.buildTvSeasonCacheKey(tvId, seasonNumber, language);
    const cachedEpisodes = await this.readCachedTvSeason(cacheKey);
    // 空数组也表示已经确认该季没有可用单集，不能再次请求 TMDB。
    if (cachedEpisodes !== null) return cachedEpisodes;
    if (this.states.length === 0) return [];
    const payload = await this.requestJson<Record<string, unknown>>(
      `/tv/${tvId}/season/${seasonNumber}`,
      { language: language || "zh-CN" },
      signal,
    );
    const episodes = Array.isArray(payload?.episodes) ? payload.episodes : [];
    const metadata = episodes.flatMap((raw): TmdbEpisodeMetadata[] => {
      const item = asRecord(raw);
      const episodeNumber = toPositiveNumber(item.episode_number);
      if (episodeNumber <= 0) return [];
      const runtime = toPositiveNumber(item.runtime);
      return [{
        id: toPositiveNumber(item.id),
        seasonNumber: toNonNegativeNumber(item.season_number, seasonNumber),
        episodeNumber,
        title: toText(item.name) || `第 ${episodeNumber} 集`,
        overview: toText(item.overview),
        airDate: toText(item.air_date),
        rating: toNumber(item.vote_average),
        stillUrl: buildImageUrl(toText(item.still_path), "w780"),
        durationMs: runtime * 60_000,
      }];
    });
    await this.writeCachedTvSeason(cacheKey, tvId, seasonNumber, language, metadata);
    return metadata;
  }

  /** 为标题匹配生成部署级公共缓存键，避免不同语言、地区或详情模式互相覆盖。 */
  private buildVideoQueryCacheKey(query: TmdbVideoQuery): string {
    return this.createMetadataCacheKey([
      "v1",
      "video_query",
      query.mediaType,
      this.normalizeCacheQueryText(query.title),
      this.normalizeCacheQueryText(query.fallbackTitle ?? ""),
      query.year ?? null,
      String(query.imdbId ?? "").trim().toLowerCase(),
      Number(query.explicitTmdbId ?? 0),
      this.readLanguage(query.language),
      this.readRegion(query.region),
      query.includeDetails === false ? "summary" : "details",
      String(query.cacheRevision ?? ""),
    ]);
  }

  /** 为已知 TMDB ID 的完整详情生成公共缓存键。 */
  private buildVideoIdCacheKey(
    mediaType: "movie" | "tv",
    tmdbId: number,
    language: string,
    region: string,
  ): string {
    return this.createMetadataCacheKey([
      "v1",
      "video_id",
      mediaType,
      tmdbId,
      this.readLanguage(language),
      this.readRegion(region),
      "details",
    ]);
  }

  /** 为节目季详情生成公共缓存键。 */
  private buildTvSeasonCacheKey(tvId: number, seasonNumber: number, language: string): string {
    return this.createMetadataCacheKey([
      "v1",
      "tv_season",
      tvId,
      seasonNumber,
      this.readLanguage(language),
    ]);
  }

  /** 对结构化参数计算 SHA-256，数据库不保存原始查询标题。 */
  private createMetadataCacheKey(parts: Array<string | number | null>): string {
    return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  }

  /** 只统一 Unicode、大小写和连续空白，避免过度清洗让不同查询误用同一缓存。 */
  private normalizeCacheQueryText(value: string): string {
    return String(value ?? "").normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase();
  }

  /** 读取 TMDB 语言，并统一空值的默认语义。 */
  private readLanguage(language: string): string {
    return String(language || "zh-CN").trim() || "zh-CN";
  }

  /** 读取 TMDB 地区，并统一大小写和空值的默认语义。 */
  private readRegion(region: string): string {
    return (String(region || "CN").trim() || "CN").toUpperCase();
  }

  /** 缓存读取失败只降级为正常 TMDB 请求，不能让扫描任务失败。 */
  private async readCachedVideo(cacheKey: string): Promise<TmdbVideoMetadata | null> {
    if (!this.persistentCache) return null;
    try {
      return await this.persistentCache.getVideo(cacheKey);
    } catch (error) {
      this.logCacheFailure("共享缓存读取失败", "影视", error);
      return null;
    }
  }

  /** 把成功匹配的电影或节目加入共享缓存写入批次。 */
  private async writeCachedVideo(
    cacheKey: string,
    language: string,
    region: string,
    metadata: TmdbVideoMetadata,
  ): Promise<void> {
    if (!this.persistentCache) return;
    try {
      await this.persistentCache.putVideo({
        cacheKey,
        language: this.readLanguage(language),
        region: this.readRegion(region),
        metadata,
      });
    } catch (error) {
      this.logCacheFailure("共享缓存写入失败", "影视", error);
    }
  }

  /** 缓存节目季读取失败时继续请求 TMDB。 */
  private async readCachedTvSeason(cacheKey: string): Promise<TmdbEpisodeMetadata[] | null> {
    if (!this.persistentCache) return null;
    try {
      return await this.persistentCache.getTvSeason(cacheKey);
    } catch (error) {
      this.logCacheFailure("共享缓存读取失败", "节目季", error);
      return null;
    }
  }

  /** 把节目季结果加入共享缓存写入批次。 */
  private async writeCachedTvSeason(
    cacheKey: string,
    tvId: number,
    seasonNumber: number,
    language: string,
    episodes: TmdbEpisodeMetadata[],
  ): Promise<void> {
    if (!this.persistentCache) return;
    try {
      await this.persistentCache.putTvSeason({
        cacheKey,
        tvId,
        seasonNumber,
        language: this.readLanguage(language),
        episodes,
      });
    } catch (error) {
      this.logCacheFailure("共享缓存写入失败", "节目季", error);
    }
  }

  /** 记录缓存降级信息，不输出标题、Key、服务或用户身份。 */
  private logCacheFailure(event: string, cacheType: string, error: unknown): void {
    this.diagnosticLogger({
      日志关键字: "codex-flycloud-helper-tmdb-cache",
      事件: event,
      缓存类型: cacheType,
      错误信息: error instanceof Error ? error.message : "未知缓存错误",
    });
  }

  /** 将不重复的搜索组合加入 APP 顺序的尝试列表。 */
  private appendSearchAttempt(
    attempts: Array<{ title: string; year: number | null }>,
    title: string,
    year: number | null,
  ): void {
    const cleanedTitle = title.trim();
    if (!cleanedTitle) return;
    const key = `${FlymbyVideoTitleCleaner.normalizeSearchText(cleanedTitle)}|${year ?? ""}`;
    if (!attempts.some((item) => `${FlymbyVideoTitleCleaner.normalizeSearchText(item.title)}|${item.year ?? ""}` === key)) {
      attempts.push({ title: cleanedTitle, year });
    }
  }

  /** 节目主查询无候选时，将紧贴中文标题末尾的“1”作为第一部编号移除。 */
  private buildFirstSeriesTitleFallback(title: string): string {
    const match = /^(.{2,80}[\u4e00-\u9fa5])1$/u.exec(String(title ?? "").trim());
    return match?.[1]?.trim() ?? "";
  }

  /** 请求 TMDB 搜索接口并转换为统一候选。 */
  private async searchCandidates(
    mediaType: "movie" | "tv",
    title: string,
    year: number | null,
    language: string,
    region: string,
    signal?: AbortSignal,
  ): Promise<TmdbSearchCandidate[]> {
    const params: Record<string, string> = {
      query: title,
      language: language || "zh-CN",
      include_adult: "false",
    };
    if (region) params.region = region;
    if (year) params[mediaType === "movie" ? "primary_release_year" : "first_air_date_year"] = String(year);
    const payload = await this.requestJson<Record<string, unknown>>(`/search/${mediaType}`, params, signal);
    const results = Array.isArray(payload?.results) ? payload.results : [];
    return results.flatMap((raw): TmdbSearchCandidate[] => {
      const item = asRecord(raw);
      const id = toPositiveNumber(item.id);
      if (id <= 0) return [];
      const isMovie = mediaType === "movie";
      return [{
        id,
        title: toText(isMovie ? item.title : item.name),
        originalTitle: toText(isMovie ? item.original_title : item.original_name),
        overview: toText(item.overview),
        date: toText(isMovie ? item.release_date : item.first_air_date),
        posterPath: toText(item.poster_path),
        backdropPath: toText(item.backdrop_path),
        voteAverage: toNumber(item.vote_average),
        popularity: toNumber(item.popularity),
        genreIds: toNumberArray(item.genre_ids),
        originCountries: isMovie ? [] : readCountryCodes(item.origin_country),
      }];
    });
  }

  /**
   * 按 Flymby APP 的实际选择规则挑选候选：电影优先同年首项，否则使用首项；节目按标题、年份和流行度评分。
   * APP 在搜索已经返回候选时不会再追加一层“低相关拒绝”，避免服务端比 APP 产生更多未匹配。
   */
  private pickCandidate(
    mediaType: "movie" | "tv",
    candidates: TmdbSearchCandidate[],
    query: string,
    year: number | null,
  ): TmdbSearchCandidate {
    if (mediaType === "movie") {
      if (year) {
        const sameYearCandidate = candidates.find((candidate) => extractDateYear(candidate.date) === year);
        if (sameYearCandidate) return sameYearCandidate;
      }
      return candidates[0]!;
    }
    const normalizedQuery = FlymbyVideoTitleCleaner.normalizeSearchText(query);
    return [...candidates].sort((left, right) => {
      const score = (candidate: TmdbSearchCandidate): number => {
        const names = [candidate.title, candidate.originalTitle].map((item) => FlymbyVideoTitleCleaner.normalizeSearchText(item));
        let value = candidate.popularity;
        if (year && extractDateYear(candidate.date) === year) value += 120;
        for (const name of names) {
          if (name === normalizedQuery) value += 1000;
          else if (name.includes(normalizedQuery) || normalizedQuery.includes(name)) value += 80;
          if (normalizedQuery.length >= 2 && name.startsWith(normalizedQuery) && name.length > normalizedQuery.length
            && /[\u4e00-\u9fa5]/u.test(name.slice(normalizedQuery.length, normalizedQuery.length + 1))) {
            value -= 450;
          }
        }
        return value;
      };
      return score(right) - score(left);
    })[0]!;
  }

  /** 查询详情和演职人员；详情失败时保留已命中的搜索摘要。 */
  private async readDetails(
    mediaType: "movie" | "tv",
    id: number,
    matchedQuery: string,
    candidateCount: number,
    language: string,
    region: string,
    signal?: AbortSignal,
    fallbackCandidate?: TmdbSearchCandidate,
  ): Promise<TmdbVideoMetadata | null> {
    const appendToResponse = mediaType === "movie" ? "credits" : "aggregate_credits";
    let payload: Record<string, unknown> | null = null;
    try {
      payload = await this.requestJson<Record<string, unknown>>(
        `/${mediaType}/${id}`,
        { language: language || "zh-CN", region, append_to_response: appendToResponse },
        signal,
      );
    } catch (error) {
      if (!fallbackCandidate) throw error;
      // APP 已选中搜索候选后，详情或演职人员子步骤失败仍保留搜索摘要作为成功匹配。
      this.diagnosticLogger({
        日志关键字: "codex-flycloud-helper-scrape-flow",
        事件: "TMDB详情失败已保留搜索候选",
        媒体类型: mediaType === "tv" ? "节目" : "电影",
        TMDB编号: id,
        错误信息: error instanceof Error ? error.message : "未知错误",
      });
    }
    if (!payload && !fallbackCandidate) return null;
    const details = payload ?? {};
    const isMovie = mediaType === "movie";
    const title = toText(isMovie ? details.title : details.name) || fallbackCandidate?.title || matchedQuery;
    const date = toText(isMovie ? details.release_date : details.first_air_date) || fallbackCandidate?.date || "";
    const posterPath = toText(details.poster_path) || fallbackCandidate?.posterPath || "";
    const backdropPath = toText(details.backdrop_path) || fallbackCandidate?.backdropPath || "";
    const genreIds = fallbackCandidate?.genreIds ?? [];
    // 关键变量：节目详情缺少地区时继续沿用搜索结果，电影始终不参与地区分类。
    const detailOriginCountries = isMovie ? [] : readCountryCodes(details.origin_country);
    return {
      id,
      mediaType,
      title,
      originalTitle: toText(isMovie ? details.original_title : details.original_name) || fallbackCandidate?.originalTitle || "",
      overview: toText(details.overview) || fallbackCandidate?.overview || "",
      year: extractDateYear(date),
      releaseDate: date,
      rating: toNumber(details.vote_average) || fallbackCandidate?.voteAverage || 0,
      genres: readGenres(details.genres, genreIds, mediaType),
      originCountries: isMovie
        ? []
        : detailOriginCountries.length > 0
          ? detailOriginCountries
          : fallbackCandidate?.originCountries ?? [],
      posterUrl: buildImageUrl(posterPath, "w500"),
      backdropUrl: buildImageUrl(backdropPath, "w1280"),
      episodeCount: isMovie ? 0 : toPositiveNumber(details.number_of_episodes),
      people: readPeople(isMovie ? details.credits : details.aggregate_credits),
      matchedQuery,
      candidateCount,
      detailsSynchronized: Boolean(payload),
    };
  }

  /** 将 TMDB 搜索候选转换为扫描可直接落库的摘要，不触发详情接口调用。 */
  private mapSearchCandidateMetadata(
    mediaType: "movie" | "tv",
    candidate: TmdbSearchCandidate,
    matchedQuery: string,
    candidateCount: number,
  ): TmdbVideoMetadata {
    return {
      id: candidate.id,
      mediaType,
      title: candidate.title || matchedQuery,
      originalTitle: candidate.originalTitle,
      overview: candidate.overview,
      year: extractDateYear(candidate.date),
      releaseDate: candidate.date,
      rating: candidate.voteAverage,
      genres: readGenres(undefined, candidate.genreIds, mediaType),
      originCountries: mediaType === "tv" ? candidate.originCountries : [],
      posterUrl: buildImageUrl(candidate.posterPath, "w500"),
      backdropUrl: buildImageUrl(candidate.backdropPath, "w1280"),
      episodeCount: 0,
      people: [],
      matchedQuery,
      candidateCount,
      detailsSynchronized: false,
    };
  }

  /** 使用 IMDB ID 查找对应类型的 TMDB ID。 */
  private async findTmdbIdByImdb(
    imdbId: string,
    mediaType: "movie" | "tv",
    language: string,
    signal?: AbortSignal,
  ): Promise<number> {
    const payload = await this.requestJson<Record<string, unknown>>(
      `/find/${encodeURIComponent(imdbId)}`,
      { external_source: "imdb_id", language: language || "zh-CN" },
      signal,
    );
    const results = mediaType === "movie" ? payload?.movie_results : payload?.tv_results;
    const first = Array.isArray(results) ? asRecord(results[0]) : {};
    return toPositiveNumber(first.id);
  }

  /** 使用当前可用 Key 请求 TMDB JSON；404 表示资源不存在，其余请求失败必须进入错误统计。 */
  private async requestJson<T>(pathname: string, params: Record<string, string>, signal?: AbortSignal): Promise<T | null> {
    const attemptedKeys = new Set<string>();
    let lastError: TmdbRequestError | null = null;
    let temporaryReason: TmdbTemporarilyUnavailableError["reasonCode"] | null = null;
    while (attemptedKeys.size < this.states.length) {
      const state = await this.acquireKey(signal, attemptedKeys);
      // 关键变量：已有 Key 请求失败后若没有其他可尝试 Key，必须在循环后抛出原错误，不能误报为未匹配。
      if (!state) break;
      attemptedKeys.add(state.key);
      const requestSignal = createTimedRequestSignal(signal, TMDB_REQUEST_TIMEOUT_MS);
      try {
        const url = new URL(`https://api.themoviedb.org/3${pathname}`);
        Object.entries(params).forEach(([key, value]) => {
          if (value) url.searchParams.set(key, value);
        });
        const headers: Record<string, string> = { Accept: "application/json" };
        if (state.key.startsWith("eyJ")) headers.Authorization = `Bearer ${state.key}`;
        else url.searchParams.set("api_key", state.key);
        const response = await fetch(url, { headers, signal: requestSignal.signal });
        if (response.status === 401 || response.status === 403) {
          state.disabled = true;
          lastError = new TmdbRequestError("TMDB Key 无效或无权访问", response.status);
          continue;
        }
        if (response.status === 429) {
          const retryAfter = readRetryAfterSeconds(response.headers.get("retry-after"));
          state.temporaryFailureCount += 1;
          state.cooldownUntil = Date.now() + retryAfter * 1000;
          temporaryReason = "tmdb_rate_limit";
          state.temporaryReason = temporaryReason;
          lastError = new TmdbRequestError("TMDB 请求被限流，请稍后重试", response.status);
          this.logTemporaryKeyFailure(state, response.status, retryAfter, temporaryReason);
          continue;
        }
        if (response.status === 404) return null;
        if (response.status >= 500) {
          const retryAfter = readRetryAfterSeconds(
            response.headers.get("retry-after"),
            createTemporaryBackoffSeconds(state.temporaryFailureCount),
          );
          state.temporaryFailureCount += 1;
          state.cooldownUntil = Date.now() + retryAfter * 1000;
          temporaryReason = "tmdb_server_error";
          state.temporaryReason = temporaryReason;
          lastError = new TmdbRequestError(`TMDB 服务暂时异常，状态码 ${response.status}`, response.status);
          this.logTemporaryKeyFailure(state, response.status, retryAfter, temporaryReason);
          continue;
        }
        if (!response.ok) {
          throw new TmdbRequestError(`TMDB 请求失败，状态码 ${response.status}`, response.status);
        }
        const payload = await response.json() as T;
        state.temporaryFailureCount = 0;
        if (state.cooldownUntil <= Date.now()) state.temporaryReason = null;
        return payload;
      } catch (error) {
        if (signal?.aborted) throw error;
        if (error instanceof TmdbRequestError) {
          lastError = error;
          break;
        }
        const retryAfter = createTemporaryBackoffSeconds(state.temporaryFailureCount);
        state.temporaryFailureCount += 1;
        state.cooldownUntil = Date.now() + retryAfter * 1000;
        temporaryReason = "tmdb_network";
        state.temporaryReason = temporaryReason;
        lastError = new TmdbRequestError(error instanceof Error ? `TMDB 请求失败：${error.message}` : "TMDB 请求失败");
        this.logTemporaryKeyFailure(state, 0, retryAfter, temporaryReason);
        continue;
      } finally {
        requestSignal.dispose();
        state.inFlight -= 1;
      }
    }
    const temporaryError = this.getTemporaryUnavailableError();
    if (temporaryError) throw temporaryError;
    if (lastError) throw lastError;
    return null;
  }

  /** 等待并取得健康且在途请求最少的 Key。 */
  private async acquireKey(signal?: AbortSignal, excludedKeys: Set<string> = new Set()): Promise<TmdbKeyState | null> {
    while (true) {
      if (signal?.aborted) throw new Error("scan cancelled");
      const candidates = this.states.filter((state) => !state.disabled && !excludedKeys.has(state.key));
      if (candidates.length === 0) return null;
      const now = Date.now();
      // 所有剩余候选都在冷却时立即交回调用方，避免单次请求在 Key 池内部无限等待。
      if (!candidates.some((state) => state.cooldownUntil <= now)) return null;
      const globalInFlight = this.states.reduce((sum, state) => sum + state.inFlight, 0);
      const available = candidates
        .filter((state) => state.cooldownUntil <= now && state.inFlight < this.perKeyConcurrency)
        .sort((left, right) => left.inFlight - right.inFlight)[0];
      if (available && globalInFlight < this.maxConcurrency) {
        available.inFlight += 1;
        return available;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /** 根据 Key 顺序生成只供任务快照比对的池修订。 */
  private createRevision(keys: string[]): string {
    return createHash("sha256").update(keys.join("\u0000")).digest("hex").slice(0, 16);
  }

  /** 记录单 Key 临时退出调度池的原因，不输出 Key 原文。 */
  private logTemporaryKeyFailure(
    state: TmdbKeyState,
    status: number,
    retryAfterSeconds: number,
    reasonCode: TmdbTemporarilyUnavailableError["reasonCode"],
  ): void {
    this.diagnosticLogger({
      日志关键字: "codex-flycloud-helper-tmdb-recovery",
      事件: "TMDB Key进入临时冷却",
      原因代码: reasonCode,
      响应状态码: status,
      连续临时失败次数: state.temporaryFailureCount,
      冷却秒数: retryAfterSeconds,
      下次可用时间: new Date(state.cooldownUntil).toISOString(),
    });
  }
}

/** 读取 Retry-After 秒数并限制为 1 秒到 30 分钟，非法值使用调用方默认值。 */
function readRetryAfterSeconds(value: string | null, fallback = 60): number {
  const numericSeconds = Number(value);
  if (Number.isFinite(numericSeconds) && numericSeconds > 0) {
    return Math.min(1_800, Math.max(1, Math.ceil(numericSeconds)));
  }
  if (value) {
    const dateTimestamp = Date.parse(value);
    if (Number.isFinite(dateTimestamp)) {
      return Math.min(1_800, Math.max(1, Math.ceil((dateTimestamp - Date.now()) / 1_000)));
    }
  }
  return Math.min(1_800, Math.max(1, Math.ceil(fallback)));
}

/** 为 5xx 和网络异常计算单 Key 指数退避，最大等待 5 分钟。 */
function createTemporaryBackoffSeconds(failureCount: number): number {
  return Math.min(300, 15 * (2 ** Math.min(4, Math.max(0, failureCount))));
}

/** 合并扫描取消信号和单次 TMDB 请求超时，释放时同步移除监听器。 */
function createTimedRequestSignal(parentSignal: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  /** 扫描任务取消时立即取消当前 TMDB 请求。 */
  const abortFromParent = (): void => controller.abort();
  if (parentSignal?.aborted) controller.abort();
  else parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", abortFromParent);
    },
  };
}

/** 将未知 JSON 值收窄为普通对象。 */
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** 将未知值转换为字符串。 */
function toText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 将未知值转换为有限数字。 */
function toNumber(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

/** 将未知值转换为正整数。 */
function toPositiveNumber(value: unknown): number {
  const number = Math.floor(toNumber(value));
  return number > 0 ? number : 0;
}

/** 将未知值转换为非负整数。 */
function toNonNegativeNumber(value: unknown, fallback: number): number {
  const number = Math.floor(toNumber(value));
  return number >= 0 ? number : fallback;
}

/** 将未知数组转换为数字数组。 */
function toNumberArray(value: unknown): number[] {
  return Array.isArray(value) ? value.map(toNumber).filter((item) => item > 0) : [];
}

/** 读取 TMDB 国家或地区代码数组，只保留非空 ISO 代码。 */
function readCountryCodes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => {
    if (typeof item === "string") return item.trim().toUpperCase();
    return toText(asRecord(item).iso_3166_1).trim().toUpperCase();
  }).filter(Boolean))];
}

/** 将 TMDB 图片路径转换为公开图片地址。 */
function buildImageUrl(filePath: string, size: string): string | null {
  return filePath ? `https://image.tmdb.org/t/p/${size}${filePath}` : null;
}

/** 从 TMDB 日期读取年份。 */
function extractDateYear(value: string): number | null {
  return /^\d{4}/u.test(value) ? Number(value.slice(0, 4)) : null;
}

/** 读取详情 genre，并在详情缺失时使用搜索摘要 genre_ids。 */
function readGenres(value: unknown, fallbackIds: number[], mediaType: "movie" | "tv"): string[] {
  if (Array.isArray(value)) {
    const names = value.map((item) => toText(asRecord(item).name)).filter(Boolean);
    if (names.length > 0) return [...new Set(names)];
  }
  const dictionary = mediaType === "movie" ? movieGenreNames : tvGenreNames;
  return [...new Set(fallbackIds.map((id) => dictionary[id]).filter((item): item is string => Boolean(item)))];
}

/** 读取电影 credits 或节目 aggregate_credits 中的主要演职人员。 */
function readPeople(value: unknown): TmdbPersonMetadata[] {
  const credits = asRecord(value);
  const people: TmdbPersonMetadata[] = [];
  const cast = Array.isArray(credits.cast) ? credits.cast.slice(0, 16) : [];
  cast.forEach((raw, index) => {
    const item = asRecord(raw);
    const roles = Array.isArray(item.roles) ? item.roles : [];
    const firstRole = roles.length > 0 ? asRecord(roles[0]) : {};
    people.push({
      id: toPositiveNumber(item.id),
      name: toText(item.name),
      role: toText(item.character) || toText(firstRole.character),
      type: "cast",
      profileUrl: buildImageUrl(toText(item.profile_path), "w185"),
      order: toNonNegativeNumber(item.order, index),
    });
  });
  const crew = Array.isArray(credits.crew) ? credits.crew : [];
  crew.filter((raw) => ["Director", "Creator", "Writer", "Screenplay", "Producer"].includes(toText(asRecord(raw).job)))
    .slice(0, 6)
    .forEach((raw, index) => {
      const item = asRecord(raw);
      people.push({
        id: toPositiveNumber(item.id),
        name: toText(item.name),
        role: toText(item.job),
        type: "crew",
        profileUrl: buildImageUrl(toText(item.profile_path), "w185"),
        order: 100 + index,
      });
    });
  return people.filter((item) => item.id > 0 && item.name);
}
