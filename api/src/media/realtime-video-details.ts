import type { MediaItemRecord } from "../domain.js";
import type { ApiRuntime } from "../runtime.js";

/** 同一进程内合并同一条目的并发详情请求，避免重复占用 TMDB Key。 */
const pendingDetailRequests = new Map<string, Promise<MediaItemRecord>>();

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

/**
 * 打开电影或节目详情时，按需读取扫描阶段省略的 TMDB 详情并回写目录。
 * TMDB 暂时不可用时保留搜索摘要，避免详情页因此完全无法打开。
 */
export async function hydrateRealtimeVideoDetails(
  runtime: ApiRuntime,
  item: MediaItemRecord,
  signal?: AbortSignal,
): Promise<MediaItemRecord> {
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
