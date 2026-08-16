import { createHash } from "node:crypto";
import type { ApiConfig } from "../config.js";
import { FlymbyVideoTitleCleaner } from "../media/flymby-video-title-cleaner.js";

interface TmdbKeyState {
  key: string;
  inFlight: number;
  cooldownUntil: number;
  disabled: boolean;
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
}

type TmdbDiagnosticLogger = (fields: Record<string, unknown>) => void;

/** 区分 TMDB 的未找到与真实请求失败，避免把网络异常统计成“未匹配”。 */
class TmdbRequestError extends Error {
  public readonly status: number;

  public constructor(message: string, status = 0) {
    super(message);
    this.name = "TmdbRequestError";
    this.status = status;
  }
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
  posterUrl: string | null;
  backdropUrl: string | null;
  episodeCount: number;
  people: TmdbPersonMetadata[];
  matchedQuery: string;
  candidateCount: number;
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
  year: number | null;
  language: string;
  region: string;
  imdbId?: string;
  explicitTmdbId?: number;
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
  private revisionValue: string;

  public constructor(config: ApiConfig, keys: string[] = [], diagnosticLogger: TmdbDiagnosticLogger = () => undefined) {
    this.states = keys.map((key) => ({ key, inFlight: 0, cooldownUntil: 0, disabled: false }));
    this.perKeyConcurrency = config.tmdbPerKeyConcurrency;
    this.maxConcurrency = config.tmdbMaxConcurrency;
    this.diagnosticLogger = diagnosticLogger;
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

  /**
   * 按 APP 的顺序查询电影或节目：原查询带年份、简化查询带年份、原查询去年份、简化查询去年份。
   * 命中候选后继续读取详情和演职人员，避免只把搜索摘要当作完整刮削结果。
   */
  public async scrapeVideo(query: TmdbVideoQuery): Promise<TmdbVideoMetadata | null> {
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
    const alternateTitle = FlymbyVideoTitleCleaner.buildAlternateTmdbSearchQuery(primaryTitle);
    const attempts: Array<{ title: string; year: number | null }> = [];
    this.appendSearchAttempt(attempts, primaryTitle, query.year);
    this.appendSearchAttempt(attempts, alternateTitle, query.year);
    if (query.year) {
      this.appendSearchAttempt(attempts, primaryTitle, null);
      this.appendSearchAttempt(attempts, alternateTitle, null);
    }
    for (const attempt of attempts) {
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
    if (this.states.length === 0 || tmdbId <= 0 || signal?.aborted) return null;
    return this.readDetails(mediaType, tmdbId, "手动匹配", 1, language, region, signal);
  }

  /** 读取节目季信息，并只返回本地文件实际需要的单集元数据。 */
  public async readTvSeason(
    tvId: number,
    seasonNumber: number,
    language: string,
    signal?: AbortSignal,
  ): Promise<TmdbEpisodeMetadata[]> {
    if (tvId <= 0 || seasonNumber < 0) return [];
    const payload = await this.requestJson<Record<string, unknown>>(
      `/tv/${tvId}/season/${seasonNumber}`,
      { language: language || "zh-CN" },
      signal,
    );
    const episodes = Array.isArray(payload?.episodes) ? payload.episodes : [];
    return episodes.flatMap((raw): TmdbEpisodeMetadata[] => {
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
      posterUrl: buildImageUrl(posterPath, "w500"),
      backdropUrl: buildImageUrl(backdropPath, "w1280"),
      episodeCount: isMovie ? 0 : toPositiveNumber(details.number_of_episodes),
      people: readPeople(isMovie ? details.credits : details.aggregate_credits),
      matchedQuery,
      candidateCount,
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
    while (attemptedKeys.size < this.states.length) {
      const state = await this.acquireKey(signal, attemptedKeys);
      // 关键变量：已有 Key 请求失败后若没有其他可尝试 Key，必须在循环后抛出原错误，不能误报为未匹配。
      if (!state) break;
      attemptedKeys.add(state.key);
      try {
        const url = new URL(`https://api.themoviedb.org/3${pathname}`);
        Object.entries(params).forEach(([key, value]) => {
          if (value) url.searchParams.set(key, value);
        });
        const headers: Record<string, string> = { Accept: "application/json" };
        if (state.key.startsWith("eyJ")) headers.Authorization = `Bearer ${state.key}`;
        else url.searchParams.set("api_key", state.key);
        const response = await fetch(url, { headers, signal });
        if (response.status === 401 || response.status === 403) {
          state.disabled = true;
          lastError = new TmdbRequestError("TMDB Key 无效或无权访问", response.status);
          continue;
        }
        if (response.status === 429) {
          const retryAfter = Number(response.headers.get("retry-after") ?? 60);
          state.cooldownUntil = Date.now() + Math.max(1, retryAfter) * 1000;
          lastError = new TmdbRequestError("TMDB 请求被限流，请稍后重试", response.status);
          continue;
        }
        if (response.status === 404) return null;
        if (!response.ok) {
          throw new TmdbRequestError(`TMDB 请求失败，状态码 ${response.status}`, response.status);
        }
        return await response.json() as T;
      } catch (error) {
        if (signal?.aborted) throw error;
        lastError = error instanceof TmdbRequestError
          ? error
          : new TmdbRequestError(error instanceof Error ? `TMDB 请求失败：${error.message}` : "TMDB 请求失败");
        break;
      } finally {
        state.inFlight -= 1;
      }
    }
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
