import type { MediaItemRecord } from "../domain.js";
import { ApiError, validationError } from "../errors.js";
import type { ApiRuntime } from "../runtime.js";

export type ManualVideoMatchType = "movie" | "tv";

/** 校验手动匹配只作用于海报墙顶层电影或节目。 */
function requireManualVideoItem(item: MediaItemRecord): void {
  if (item.mediaType !== "video" || (item.itemType !== "video.movie" && item.itemType !== "video.series")) {
    throw new ApiError(422, "manual_match_item_not_supported", "当前只支持对电影和节目执行手动匹配");
  }
}

/** 读取并校验电影或节目类型。 */
export function readManualVideoMatchType(value: unknown): ManualVideoMatchType {
  if (value !== "movie" && value !== "tv") {
    throw validationError("mediaType", "匹配类型必须是电影或节目");
  }
  return value;
}

/** 使用系统 TMDB Key 搜索人工选择的影视候选。 */
export async function searchManualVideoMatches(
  runtime: ApiRuntime,
  item: MediaItemRecord,
  input: { query: unknown; mediaType: unknown; year?: unknown; signal?: AbortSignal },
) {
  requireManualVideoItem(item);
  if (typeof input.query !== "string" || !input.query.trim()) {
    throw validationError("query", "请输入需要匹配的影视名称");
  }
  if ([...input.query.trim()].length > 200) {
    throw validationError("query", "影视名称长度不能超过 200 个字符");
  }
  const mediaType = readManualVideoMatchType(input.mediaType);
  const parsedYear = input.year === undefined || input.year === null || input.year === ""
    ? null
    : Number(input.year);
  if (parsedYear !== null && (!Number.isInteger(parsedYear) || parsedYear < 1800 || parsedYear > 2200)) {
    throw validationError("year", "年份必须在 1800 到 2200 之间");
  }
  const tmdbStatus = runtime.tmdb.getStatus();
  if (tmdbStatus.configuredCount === 0) {
    throw new ApiError(503, "tmdb_not_configured", "系统尚未配置 TMDB Key");
  }
  if (tmdbStatus.healthyCount === 0) {
    throw new ApiError(503, "tmdb_temporarily_unavailable", "当前没有可用的 TMDB Key，请稍后重试");
  }
  return runtime.tmdb.searchVideoCandidates({
    mediaType,
    title: input.query.trim(),
    year: parsedYear,
    language: "zh-CN",
    region: "CN",
    signal: input.signal,
  });
}

/** 重新读取用户选中的 TMDB 详情并持久化人工匹配结果。 */
export async function applyManualVideoMatch(
  runtime: ApiRuntime,
  item: MediaItemRecord,
  input: { mediaType: unknown; tmdbId: unknown; signal?: AbortSignal },
): Promise<MediaItemRecord> {
  requireManualVideoItem(item);
  const mediaType = readManualVideoMatchType(input.mediaType);
  const tmdbId = Number(input.tmdbId);
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
    throw validationError("tmdbId", "请选择有效的 TMDB 匹配结果");
  }
  const tmdbStatus = runtime.tmdb.getStatus();
  if (tmdbStatus.configuredCount === 0) {
    throw new ApiError(503, "tmdb_not_configured", "系统尚未配置 TMDB Key");
  }
  const metadata = await runtime.tmdb.readVideoMetadata(mediaType, tmdbId, "zh-CN", "CN", input.signal);
  if (!metadata) {
    throw new ApiError(502, "tmdb_item_unavailable", "无法读取所选 TMDB 条目，请重新搜索后再试");
  }
  const updatedItem = await runtime.repository.applyManualVideoMatch({
    itemId: item.id,
    userId: item.userId,
    metadata,
  });
  runtime.logBusinessEvent("info", {
    日志关键字: "codex-flycloud-helper-manual-match",
    事件: "手动匹配影视条目",
    媒体条目ID: item.id,
    匹配类型: mediaType === "tv" ? "节目" : "电影",
    TMDB编号: tmdbId,
  });
  return updatedItem;
}

/** 清除当前条目的刮削结果并恢复本地识别信息。 */
export async function clearManualVideoMatch(runtime: ApiRuntime, item: MediaItemRecord): Promise<MediaItemRecord> {
  requireManualVideoItem(item);
  const updatedItem = await runtime.repository.clearVideoMatch(item.id, item.userId);
  runtime.logBusinessEvent("info", {
    日志关键字: "codex-flycloud-helper-manual-match",
    事件: "清除影视匹配结果",
    媒体条目ID: item.id,
    原匹配状态: item.matchState,
  });
  return updatedItem;
}
