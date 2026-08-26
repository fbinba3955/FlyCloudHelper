import type { FlyCloudHelperDatabase } from "../database.js";
import type { TmdbEpisodeMetadata, TmdbVideoMetadata } from "./tmdb.js";

/** 与 Flymby APP 保持一致的 TMDB 正结果缓存有效期。 */
const TMDB_SHARED_CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1_000;
/** 过期数据最多每小时清理一次，避免每条刮削结果都执行删除语句。 */
const TMDB_SHARED_CACHE_CLEANUP_INTERVAL_MS = 60 * 60 * 1_000;
/** 与 APP 的写入批量保持一致，减少远端 PostgreSQL/MySQL 往返。 */
const TMDB_SHARED_CACHE_BATCH_SIZE = 20;
/** 低流量时也要及时把不足一批的缓存写入数据库。 */
const TMDB_SHARED_CACHE_FLUSH_INTERVAL_MS = 1_000;
/** 进程内热缓存只保留最近一批结果，持久数据仍以数据库为准。 */
const TMDB_SHARED_CACHE_MEMORY_LIMIT = 5_000;

type TmdbCacheLogger = (
  level: "info" | "warn",
  fields: Record<string, string | number | boolean | null>,
) => void;

interface TmdbMetadataCacheRow {
  cache_kind: string;
  payload_json: string;
  expires_at: string;
}

interface TmdbPendingCacheRow {
  cache_key: string;
  cache_kind: string;
  media_type: string;
  provider_item_id: number;
  season_number: number | null;
  language: string;
  region: string;
  details_synchronized: number;
  payload_json: string;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

interface TmdbMemoryCacheEntry {
  cacheKind: string;
  payload: unknown;
  expiresAtMs: number;
}

/** 判断数据库中的影视缓存是否仍是当前服务可以读取的结构。 */
function readVideoMetadata(payload: unknown): TmdbVideoMetadata | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const metadata = payload as Partial<TmdbVideoMetadata>;
  if ((metadata.mediaType !== "movie" && metadata.mediaType !== "tv")
    || !Number.isInteger(metadata.id)
    || Number(metadata.id) <= 0
    || typeof metadata.title !== "string") {
    return null;
  }
  // 关键变量：旧节目缓存没有地区字段，正常重新扫描时让它自然失效并重新读取 TMDB，不建立补全任务。
  if (metadata.mediaType === "tv" && !Array.isArray(metadata.originCountries)) return null;
  return {
    ...metadata,
    originCountries: Array.isArray(metadata.originCountries)
      ? metadata.originCountries.map((country) => String(country).toUpperCase()).filter(Boolean)
      : [],
  } as TmdbVideoMetadata;
}

/** 判断数据库中的节目季缓存是否包含有效单集数组。 */
function readSeasonMetadata(payload: unknown): TmdbEpisodeMetadata[] | null {
  if (!Array.isArray(payload)) return null;
  const episodes = payload.filter((item): item is TmdbEpisodeMetadata => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const episode = item as Partial<TmdbEpisodeMetadata>;
    return Number.isInteger(episode.episodeNumber)
      && Number(episode.episodeNumber) > 0
      && Number.isInteger(episode.seasonNumber)
      && Number(episode.seasonNumber) >= 0;
  });
  return episodes.length === payload.length ? episodes : null;
}

/**
 * 部署级 TMDB 共享缓存。
 * 缓存不绑定用户、服务或网盘类型，所有使用内置 TMDB 的影视服务共用同一份公共元数据。
 */
export class TmdbMetadataCache {
  private nextCleanupAt = 0;
  private hitCount = 0;
  private writeCount = 0;
  private closing = false;
  private readonly pendingRows = new Map<string, TmdbPendingCacheRow>();
  private readonly memoryPayloads = new Map<string, TmdbMemoryCacheEntry>();
  private flushTimer: NodeJS.Timeout | null = null;
  private flushChain: Promise<void> = Promise.resolve();

  public constructor(
    private readonly database: FlyCloudHelperDatabase,
    private readonly logger: TmdbCacheLogger,
  ) {}

  /** 按不可逆查询键读取电影或节目元数据。 */
  public async getVideo(cacheKey: string): Promise<TmdbVideoMetadata | null> {
    const payload = await this.readPayload(cacheKey, "video");
    const metadata = readVideoMetadata(payload);
    if (payload !== null && metadata === null) this.logInvalidPayload(cacheKey, "影视");
    if (metadata) this.logHit("影视");
    return metadata;
  }

  /** 保存电影或节目正匹配结果，不缓存未匹配和请求错误。 */
  public async putVideo(input: {
    cacheKey: string;
    language: string;
    region: string;
    metadata: TmdbVideoMetadata;
  }): Promise<void> {
    // 共享载荷只保存 TMDB 公共字段，不保留来自用户目录标题的实际命中查询词。
    const sharedMetadata: TmdbVideoMetadata = { ...input.metadata, matchedQuery: "" };
    this.queuePayload({
      cacheKey: input.cacheKey,
      cacheKind: "video",
      mediaType: sharedMetadata.mediaType,
      providerItemId: sharedMetadata.id,
      seasonNumber: null,
      language: input.language,
      region: input.region,
      detailsSynchronized: sharedMetadata.detailsSynchronized,
      payload: sharedMetadata,
    });
  }

  /** 按节目、季号和语言读取单集元数据。 */
  public async getTvSeason(cacheKey: string): Promise<TmdbEpisodeMetadata[] | null> {
    const payload = await this.readPayload(cacheKey, "tv_season");
    const episodes = readSeasonMetadata(payload);
    if (payload !== null && episodes === null) this.logInvalidPayload(cacheKey, "节目季");
    if (episodes) this.logHit("节目季");
    return episodes;
  }

  /** 保存节目季正结果；空季也可以缓存，避免重复请求确定不存在的季。 */
  public async putTvSeason(input: {
    cacheKey: string;
    tvId: number;
    seasonNumber: number;
    language: string;
    episodes: TmdbEpisodeMetadata[];
  }): Promise<void> {
    this.queuePayload({
      cacheKey: input.cacheKey,
      cacheKind: "tv_season",
      mediaType: "tv",
      providerItemId: input.tvId,
      seasonNumber: input.seasonNumber,
      language: input.language,
      region: "",
      detailsSynchronized: true,
      payload: input.episodes,
    });
  }

  /** 读取未过期且类型一致的缓存载荷。 */
  private async readPayload(cacheKey: string, cacheKind: string): Promise<unknown | null> {
    const memoryEntry = this.memoryPayloads.get(cacheKey);
    if (memoryEntry) {
      if (memoryEntry.cacheKind === cacheKind && memoryEntry.expiresAtMs > Date.now()) {
        return memoryEntry.payload;
      }
      this.memoryPayloads.delete(cacheKey);
    }
    const row = await this.database.query("tmdb_metadata_cache")
      .select("cache_kind", "payload_json", "expires_at")
      .where({ cache_key: cacheKey, cache_kind: cacheKind })
      .where("expires_at", ">", new Date().toISOString())
      .first() as TmdbMetadataCacheRow | undefined;
    if (!row) return null;
    try {
      const payload = JSON.parse(String(row.payload_json));
      const expiresAtMs = Date.parse(String(row.expires_at));
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) return null;
      this.rememberPayload(cacheKey, cacheKind, payload, expiresAtMs);
      return payload;
    } catch {
      return null;
    }
  }

  /** 先写入进程内缓存并进入批量队列，避免刮削任务等待单条远端数据库写入。 */
  private queuePayload(input: {
    cacheKey: string;
    cacheKind: string;
    mediaType: string;
    providerItemId: number;
    seasonNumber: number | null;
    language: string;
    region: string;
    detailsSynchronized: boolean;
    payload: unknown;
  }): void {
    const now = new Date();
    const expiresAtMs = now.getTime() + TMDB_SHARED_CACHE_TTL_MS;
    const row: TmdbPendingCacheRow = {
      cache_key: input.cacheKey,
      cache_kind: input.cacheKind,
      media_type: input.mediaType,
      provider_item_id: input.providerItemId,
      season_number: input.seasonNumber,
      language: input.language,
      region: input.region,
      details_synchronized: input.detailsSynchronized ? 1 : 0,
      payload_json: JSON.stringify(input.payload),
      expires_at: new Date(expiresAtMs).toISOString(),
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    };
    this.pendingRows.set(input.cacheKey, row);
    this.rememberPayload(input.cacheKey, input.cacheKind, input.payload, expiresAtMs);
    if (this.pendingRows.size >= TMDB_SHARED_CACHE_BATCH_SIZE) {
      void this.flush();
      return;
    }
    this.scheduleFlush();
  }

  /** 把当前批次原子写入数据库；服务关闭或低流量定时器也可以显式调用。 */
  public async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const rows = [...this.pendingRows.values()];
    if (rows.length === 0) {
      await this.flushChain;
      return;
    }
    this.pendingRows.clear();
    const previousFlush = this.flushChain;
    this.flushChain = previousFlush.catch(() => undefined).then(async () => {
      try {
        await this.database.query("tmdb_metadata_cache")
          .insert(rows)
          .onConflict("cache_key")
          .merge([
            "cache_kind",
            "media_type",
            "provider_item_id",
            "season_number",
            "language",
            "region",
            "details_synchronized",
            "payload_json",
            "expires_at",
            "updated_at",
          ]);
        this.writeCount += rows.length;
        if (this.writeCount === rows.length || Math.floor(this.writeCount / 100)
          !== Math.floor((this.writeCount - rows.length) / 100)) {
          this.logger("info", {
            日志关键字: "codex-flycloud-helper-tmdb-cache",
            事件: "共享缓存批量写入",
            本批数量: rows.length,
            累计写入数量: this.writeCount,
          });
        }
        await this.cleanupExpiredIfNeeded(Date.now());
      } catch (error) {
        // 关键变量：数据库短暂失败时保留较新的同键结果，下次定时批量重试。
        if (!this.closing) {
          rows.forEach((row) => {
            if (!this.pendingRows.has(row.cache_key)) this.pendingRows.set(row.cache_key, row);
          });
        }
        this.logger("warn", {
          日志关键字: "codex-flycloud-helper-tmdb-cache",
          事件: "共享缓存批量写入失败",
          待重试数量: rows.length,
          错误信息: error instanceof Error ? error.message : "未知数据库错误",
        });
        if (!this.closing) this.scheduleFlush();
      }
    });
    await this.flushChain;
    if (!this.closing && this.pendingRows.size > 0) this.scheduleFlush();
  }

  /**
   * 清空部署级 TMDB 共享缓存。
   * 先等待正在执行的批量写入结束，再删除数据库、待写入队列和进程内热缓存，避免旧批次在清理完成后重新落库。
   */
  public async clearAll(): Promise<{
    deletedCount: number;
    discardedPendingCount: number;
    clearedMemoryCount: number;
  }> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flushChain.catch(() => undefined);
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    // 关键变量：未写入数据库的旧缓存也属于本次清理范围，不能在清理后被定时器重新写回。
    const discardedPendingCount = this.pendingRows.size;
    const clearedMemoryCount = this.memoryPayloads.size;
    this.pendingRows.clear();
    this.memoryPayloads.clear();
    const deletedCount = Number(await this.database.query("tmdb_metadata_cache").delete());
    this.nextCleanupAt = 0;
    this.logger("info", {
      日志关键字: "codex-flycloud-helper-tmdb-cache",
      事件: "共享缓存已手动清空",
      数据库删除数量: deletedCount,
      丢弃待写入数量: discardedPendingCount,
      清空内存数量: clearedMemoryCount,
    });
    return { deletedCount, discardedPendingCount, clearedMemoryCount };
  }

  /** 服务关闭时尽量提交最后一批缓存，并确保失败后不再创建定时器阻止进程退出。 */
  public async close(): Promise<void> {
    this.closing = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }

  /** 低于批量阈值时延迟一次写入，多个结果共用同一个定时器。 */
  private scheduleFlush(): void {
    if (this.closing || this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, TMDB_SHARED_CACHE_FLUSH_INTERVAL_MS);
  }

  /** 保存进程内热数据并使用明确上限控制内存占用。 */
  private rememberPayload(cacheKey: string, cacheKind: string, payload: unknown, expiresAtMs: number): void {
    if (this.memoryPayloads.size >= TMDB_SHARED_CACHE_MEMORY_LIMIT && !this.memoryPayloads.has(cacheKey)) {
      const oldestKey = this.memoryPayloads.keys().next().value as string | undefined;
      if (oldestKey) this.memoryPayloads.delete(oldestKey);
    }
    this.memoryPayloads.delete(cacheKey);
    this.memoryPayloads.set(cacheKey, { cacheKind, payload, expiresAtMs });
  }

  /** 按时间窗口批量删除过期缓存，清理失败不影响已经完成的元数据写入。 */
  private async cleanupExpiredIfNeeded(nowMs: number): Promise<void> {
    if (nowMs < this.nextCleanupAt) return;
    this.nextCleanupAt = nowMs + TMDB_SHARED_CACHE_CLEANUP_INTERVAL_MS;
    try {
      const deletedCount = await this.database.query("tmdb_metadata_cache")
        .where("expires_at", "<=", new Date(nowMs).toISOString())
        .delete();
      if (Number(deletedCount) > 0) {
        this.logger("info", {
          日志关键字: "codex-flycloud-helper-tmdb-cache",
          事件: "过期缓存清理完成",
          删除数量: Number(deletedCount),
        });
      }
    } catch (error) {
      this.logger("warn", {
        日志关键字: "codex-flycloud-helper-tmdb-cache",
        事件: "过期缓存清理失败",
        错误信息: error instanceof Error ? error.message : "未知数据库错误",
      });
    }
  }

  /** 按里程碑记录缓存命中，避免全量扫描时为每个影片输出一条日志。 */
  private logHit(cacheType: string): void {
    this.hitCount += 1;
    if (this.hitCount !== 1 && this.hitCount % 100 !== 0) return;
    this.logger("info", {
      日志关键字: "codex-flycloud-helper-tmdb-cache",
      事件: "共享缓存命中",
      缓存类型: cacheType,
      累计命中数量: this.hitCount,
    });
  }

  /** 记录损坏载荷时只输出哈希键前缀，不输出查询标题。 */
  private logInvalidPayload(cacheKey: string, cacheType: string): void {
    this.logger("warn", {
      日志关键字: "codex-flycloud-helper-tmdb-cache",
      事件: "共享缓存内容无效",
      缓存类型: cacheType,
      缓存键前缀: cacheKey.slice(0, 12),
    });
  }
}
