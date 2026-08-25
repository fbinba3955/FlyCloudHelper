import type { MediaItemRecord } from "../domain.js";
import type { TmdbEpisodeMetadata } from "../metadata/tmdb.js";
import type { ApiRuntime } from "../runtime.js";

/** 同一进程内合并同一条目的并发详情请求，避免重复占用 TMDB Key。 */
const pendingDetailRequests = new Map<string, Promise<MediaItemRecord>>();
/** 同一进程内合并同一节目季的并发请求，单集列表只读取一次 TMDB 季数据。 */
const pendingSeasonRequests = new Map<string, Promise<TmdbEpisodeMetadata[]>>();

/** 从服务元数据配置中读取 TMDB 语言和地区。 */
function readTmdbLocale(profile: Record<string, unknown>): { language: string; region: string } {
  const profiles = profile.profiles && typeof profile.profiles === "object" && !Array.isArray(profile.profiles)
    ? profile.profiles as Record<string, unknown>
    : {};
  const videoProfile = profiles.video && typeof profiles.video === "object" && !Array.isArray(profiles.video)
    ? profiles.video as Record<string, unknown>
    : {};
  return {
    language: typeof videoProfile.language === "string" ? videoProfile.language : "zh-CN",
    region: typeof videoProfile.region === "string" ? videoProfile.region : "CN",
  };
}

/** 读取一季的 TMDB 单集信息，并合并相同节目季的并发查询。 */
async function readEpisodeSeasonMetadata(
  runtime: ApiRuntime,
  tvId: number,
  seasonNumber: number,
  language: string,
  signal?: AbortSignal,
): Promise<TmdbEpisodeMetadata[]> {
  const requestKey = `${tvId}|${seasonNumber}|${language}`; // 关键变量：相同节目、季和语言共享一次实时请求。
  const existingRequest = pendingSeasonRequests.get(requestKey);
  if (existingRequest) return existingRequest;
  const request = runtime.tmdb.readTvSeason(tvId, seasonNumber, language, signal);
  pendingSeasonRequests.set(requestKey, request);
  try {
    return await request;
  } finally {
    if (pendingSeasonRequests.get(requestKey) === request) pendingSeasonRequests.delete(requestKey);
  }
}

/** 打开单集详情或列表时，按需补全扫描阶段省略的 TMDB 单集信息。 */
async function hydrateRealtimeEpisodeDetails(
  runtime: ApiRuntime,
  item: MediaItemRecord,
  signal?: AbortSignal,
): Promise<MediaItemRecord> {
  if (item.itemType !== "video.episode") return item;
  // 关键变量：简介非空或语言回退已经检查过时才停止补全，兼容此前已同步标题但简介为空的单集。
  const overviewFallbackChecked = item.metadata.tmdbEpisodeOverviewFallbackChecked === true;
  if (item.overview.trim().length > 0 || overviewFallbackChecked) return item;
  let tvId = Number(item.externalIds.tmdbTv ?? item.metadata.tmdbTvId ?? 0);
  if (!Number.isInteger(tvId) || tvId <= 0) {
    const relation = await runtime.database.query("media_relations").where({ child_item_id: item.id }).first();
    if (relation) {
      const parent = await runtime.repository.getCatalogItem(String(relation.parent_item_id), item.userId);
      tvId = Number(parent.externalIds.tmdb ?? parent.metadata.tmdbTvId ?? 0);
    }
  }
  const seasonNumber = Number(item.metadata.seasonNumber ?? -1);
  const episodeNumber = Number(item.metadata.episodeNumber ?? 0);
  if (!Number.isInteger(tvId) || tvId <= 0 || !Number.isInteger(seasonNumber) || seasonNumber < 0
    || !Number.isInteger(episodeNumber) || episodeNumber <= 0) return item;

  const tmdbStatus = runtime.tmdb.getStatus();
  if (tmdbStatus.healthyCount <= 0) return item;
  try {
    const service = await runtime.repository.getServiceDetail(item.serviceId, item.userId);
    const locale = readTmdbLocale(service.metadataProfile);
    const episodes = await readEpisodeSeasonMetadata(runtime, tvId, seasonNumber, locale.language, signal);
    const localizedEpisode = episodes.find((candidate) => candidate.episodeNumber === episodeNumber);
    if (!localizedEpisode) return item;
    let episode = localizedEpisode;
    let overviewLanguage = locale.language;
    if (localizedEpisode.overview.trim().length <= 0 && locale.language.toLowerCase() !== "en-us") {
      // 关键变量：中文等本地化结果可能只有标题没有简介，英文结果用于补充简介，不覆盖本地化标题。
      const fallbackEpisodes = await readEpisodeSeasonMetadata(runtime, tvId, seasonNumber, "en-US", signal);
      const fallbackEpisode = fallbackEpisodes.find((candidate) => candidate.episodeNumber === episodeNumber);
      if (fallbackEpisode && fallbackEpisode.overview.trim().length > 0) {
        episode = { ...localizedEpisode, overview: fallbackEpisode.overview };
        overviewLanguage = "en-US";
      }
    }
    return await runtime.repository.applyRealtimeEpisodeDetails({
      itemId: item.id,
      userId: item.userId,
      metadata: episode,
      overviewLanguage,
      overviewFallbackChecked: true,
    });
  } catch (_error) {
    return item;
  }
}

/**
 * 打开电影、节目或单集详情时，按需读取扫描阶段省略的 TMDB 详情并回写目录。
 * TMDB 暂时不可用时保留搜索摘要，避免详情页因此完全无法打开。
 */
export async function hydrateRealtimeVideoDetails(
  runtime: ApiRuntime,
  item: MediaItemRecord,
  signal?: AbortSignal,
): Promise<MediaItemRecord> {
  if (item.mediaType === "video" && item.itemType === "video.episode") {
    return hydrateRealtimeEpisodeDetails(runtime, item, signal);
  }
  if (item.mediaType !== "video" || (item.itemType !== "video.movie" && item.itemType !== "video.series")) {
    return item;
  }
  if (item.metadata.tmdbDetailsSynchronized !== false) return item;
  const tmdbId = Number(item.externalIds.tmdb ?? 0);
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) return item;

  const existingRequest = pendingDetailRequests.get(item.id);
  if (existingRequest) return existingRequest;
  const request = (async (): Promise<MediaItemRecord> => {
    const tmdbStatus = runtime.tmdb.getStatus();
    if (tmdbStatus.healthyCount <= 0) {
      runtime.logBusinessEvent("warn", {
        日志关键字: "codex-flycloud-helper-realtime-detail",
        事件: "打开详情时没有可用TMDB Key并保留摘要",
        媒体条目ID: item.id,
        TMDB编号: tmdbId,
      });
      return item;
    }
    try {
      const service = await runtime.repository.getServiceDetail(item.serviceId, item.userId);
      const locale = readTmdbLocale(service.metadataProfile);
      const mediaType = item.itemType === "video.series" ? "tv" : "movie";
      const metadata = await runtime.tmdb.readVideoMetadata(
        mediaType,
        tmdbId,
        locale.language,
        locale.region,
        signal,
      );
      if (!metadata || metadata.mediaType !== mediaType) return item;
      const updatedItem = await runtime.repository.applyRealtimeVideoDetails({
        itemId: item.id,
        userId: item.userId,
        metadata,
      });
      runtime.logBusinessEvent("info", {
        日志关键字: "codex-flycloud-helper-realtime-detail",
        事件: "打开详情时实时补全TMDB信息",
        媒体条目ID: item.id,
        媒体类型: mediaType === "tv" ? "节目" : "电影",
        TMDB编号: tmdbId,
      });
      return updatedItem;
    } catch (error) {
      runtime.logBusinessEvent("warn", {
        日志关键字: "codex-flycloud-helper-realtime-detail",
        事件: "打开详情时TMDB补全失败并保留摘要",
        媒体条目ID: item.id,
        TMDB编号: tmdbId,
        错误信息: error instanceof Error ? error.message : "未知错误",
      });
      return item;
    }
  })();
  pendingDetailRequests.set(item.id, request);
  try {
    return await request;
  } finally {
    if (pendingDetailRequests.get(item.id) === request) pendingDetailRequests.delete(item.id);
  }
}
