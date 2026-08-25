import { FolderOpen, RefreshCw, Search, Trash2, WandSparkles, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  clearMediaItemMatch,
  getMediaItem,
  listMediaItemChildren,
  listMediaItemPaths,
  type CatalogSort,
  type MatchState,
  type MediaItem,
  type MediaPathItem,
  type MediaType,
} from "@/lib/api";
import { FilterChip, Panel, PosterCard, StatusPill } from "@/components/ui-kit";
import { SecondaryButton } from "@/components/ConsoleShell";
import { MediaManualMatchDialog } from "@/components/MediaManualMatchDialog";

const matchStateLabels = {
  matched: "已匹配",
  needs_review: "待确认",
  unmatched: "未匹配",
  processing: "处理中",
} as const;

const itemTypeLabels: Record<string, string> = {
  "video.movie": "电影",
  "video.series": "节目",
  "video.episode": "单集",
  "music.album": "音乐专辑",
  "music.track": "音乐曲目",
  "audiobook.book": "有声书",
  "audiobook.chapter": "有声书章节",
};

const catalogSortLabels: Record<CatalogSort, string> = {
  created_desc: "加入时间",
  year_desc: "年份",
  premiere_date_desc: "首映日期",
  title_asc: "名称",
};

const metadataLabels: Record<string, string> = {
  originalTitle: "原始标题",
  releaseDate: "上映日期",
  airDate: "播出日期",
  rating: "评分",
  genres: "类型",
  people: "演职人员",
  episodeCount: "总集数",
  seasonNumber: "季号",
  episodeNumber: "集号",
  resolution: "分辨率",
  source: "片源",
  releaseGroup: "发布组",
  matchedQuery: "匹配关键词",
  candidateCount: "候选数量",
};

export interface MediaCatalogQuery {
  search: string;
  mediaType: MediaType | "all";
  videoItemType: "all" | "video.movie" | "video.series";
  matchState: MatchState | "all";
  sort: CatalogSort;
}

/** 将媒体详情中的常用元数据转换为可读中文文本。 */
function formatMetadataValue(key: string, value: unknown): string {
  if (key === "people" && Array.isArray(value)) {
    return value.map((raw) => {
      if (!raw || typeof raw !== "object") return "";
      const person = raw as Record<string, unknown>;
      const name = typeof person.name === "string" ? person.name : "";
      const role = typeof person.role === "string" ? person.role : "";
      return name ? `${name}${role ? `（${role}）` : ""}` : "";
    }).filter(Boolean).join("、");
  }
  if (Array.isArray(value)) return value.map(String).join("、");
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "是" : "否";
  return "";
}

/** 筛选能够直接展示的已知媒体元数据，避免在详情页输出 JSON 原文。 */
function getDisplayMetadata(metadata: Record<string, unknown>): Array<{ label: string; value: string }> {
  return Object.entries(metadataLabels).flatMap(([key, label]) => {
    const value = formatMetadataValue(key, metadata[key]);
    return value ? [{ label, value }] : [];
  });
}

/** 将节目单集的季号、集号转换为中文位置；元数据不完整时保留原始标题。 */
function getSeriesEpisodeLabel(child: MediaItem): string {
  const seasonNumber = Number(child.metadata.seasonNumber);
  const episodeNumber = Number(child.metadata.episodeNumber);
  if (!Number.isInteger(seasonNumber) || seasonNumber < 0 || !Number.isInteger(episodeNumber) || episodeNumber < 1) {
    return child.title;
  }
  return `第 ${seasonNumber} 季 第 ${episodeNumber} 集`;
}

/** 生成节目单集副标题，保留单集名称、补充标题和年份。 */
function getSeriesEpisodeDescription(child: MediaItem): string {
  const parts = [child.title];
  if (child.subtitle && child.subtitle !== child.title) parts.push(child.subtitle);
  if (child.year) parts.push(String(child.year));
  return parts.join(" · ");
}

/** 将文件大小转换为适合详情页展示的文本。 */
function formatFileSize(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return "大小未知";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = size;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

/** 将毫秒时长转换为海报详情使用的小时分钟文本。 */
function formatMediaDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return "未知";
  const totalMinutes = Math.max(1, Math.round(durationMs / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours} 小时 ${minutes} 分钟` : `${minutes} 分钟`;
}

/** 将媒体码率转换为易读的 Mbps 或 Kbps。 */
function formatMediaBitRate(bitRate: number): string {
  if (!Number.isFinite(bitRate) || bitRate <= 0) return "未知";
  return bitRate >= 1_000_000 ? `${(bitRate / 1_000_000).toFixed(1)} Mbps` : `${Math.round(bitRate / 1000)} Kbps`;
}

/** 把 ffprobe 编码名称转换为用户熟悉的名称。 */
function formatMediaCodec(codec: string): string {
  const labels: Record<string, string> = { h264: "H.264", hevc: "H.265", h265: "H.265", av1: "AV1", vp9: "VP9", aac: "AAC", ac3: "AC3", eac3: "EAC3", truehd: "TrueHD", dts: "DTS" };
  return labels[codec.toLocaleLowerCase("zh-CN")] ?? codec.toLocaleUpperCase("zh-CN");
}

/** 返回视频流的实际宽高和常用清晰度名称。 */
function formatMediaResolution(width: number, height: number): string {
  if (width <= 0 && height <= 0) return "未知";
  const label = width >= 3800 || height >= 2100 ? "4K" : width >= 2500 || height >= 1400 ? "2K" : height > 0 ? `${height}P` : "";
  const sizeText = width > 0 && height > 0 ? `${width} × ${height}` : height > 0 ? `${height}P` : `${width} 像素宽`;
  return `${sizeText}${label ? `（${label}）` : ""}`;
}

/** 将单条 ffprobe 音视频流转换为文件路径下的简短规格。 */
function formatMediaStream(stream: Record<string, unknown>): string {
  const type = String(stream.Type ?? "");
  const codec = formatMediaCodec(String(stream.Codec ?? ""));
  if (type === "Video") {
    const resolution = formatMediaResolution(Number(stream.Width ?? 0), Number(stream.Height ?? 0));
    const videoRange = String(stream.VideoRangeType ?? stream.VideoRange ?? "");
    return ["视频", codec, resolution === "未知" ? "" : resolution, videoRange === "SDR" ? "" : videoRange].filter(Boolean).join(" · ");
  }
  if (type === "Audio") {
    const channels = Number(stream.Channels ?? 0);
    return ["音频", codec, String(stream.Language ?? ""), String(stream.ChannelLayout ?? "") || (channels > 0 ? `${channels} 声道` : "")].filter(Boolean).join(" · ");
  }
  if (type === "Subtitle") return ["字幕", String(stream.Language ?? ""), codec, String(stream.Title ?? "")].filter(Boolean).join(" · ");
  return [type || "数据流", codec].filter(Boolean).join(" · ");
}

/** 返回当前匹配状态的中文名称。 */
function getMatchStateLabel(matchState: MatchState | "all"): string {
  return matchState === "all" ? "全部" : matchStateLabels[matchState];
}

/** 展示只读媒体详情及节目、专辑或作品的子项。 */
function MediaDetailDialog({
  item,
  children,
  paths,
  loading,
  error,
  clearingMatch,
  onManualMatch,
  onClearMatch,
  onClose,
}: {
  item: MediaItem;
  children: MediaItem[];
  paths: MediaPathItem[];
  loading: boolean;
  error: string | null;
  clearingMatch: boolean;
  onManualMatch: () => void;
  onClearMatch: () => void;
  onClose: () => void;
}) {
  const metadata = getDisplayMetadata(item.metadata);
  const externalIds = Object.entries(item.externalIds).filter(([, value]) => Boolean(value));
  const mediaProbeSummary = item.mediaProbeSummary;
  const canMatchVideo = item.mediaType === "video" && (item.itemType === "video.movie" || item.itemType === "video.series");
  // 关键变量：只有节目详情使用季集位置展示子项，电影及其他媒体保持原展示。
  const isSeries = item.itemType === "video.series";

  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-3 sm:p-6">
      <button type="button" aria-label="关闭媒体详情" onClick={onClose} className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
      <section role="dialog" aria-modal="true" aria-label={`${item.title}详情`} className="relative max-h-[92vh] w-full max-w-5xl overflow-y-auto rounded-2xl border border-border bg-background shadow-2xl">
        <div className="relative min-h-48 overflow-hidden border-b border-border p-5 sm:p-7">
          {item.backdropUrl && <img src={item.backdropUrl} alt="" className="absolute inset-0 size-full object-cover opacity-25" />}
          <div className="absolute inset-0 bg-gradient-to-r from-background via-background/90 to-background/55" />
          <button type="button" onClick={onClose} aria-label="关闭" className="absolute top-4 right-4 z-10 grid size-9 place-items-center rounded-full border border-border bg-background/80 text-muted-foreground hover:text-foreground">
            <X className="size-4" />
          </button>
          <div className="relative grid gap-5 sm:grid-cols-[120px_minmax(0,1fr)] sm:items-end">
            <div className="aspect-[2/3] overflow-hidden rounded-xl border border-border bg-secondary">
              {item.posterUrl ? <img src={item.posterUrl} alt={item.title} className="size-full object-cover" /> : <div className="grid size-full place-items-center text-xs text-muted-foreground">暂无海报</div>}
            </div>
            <div className="min-w-0 pb-1">
              <p className="text-xs text-muted-foreground">{itemTypeLabels[item.itemType] ?? "媒体内容"}</p>
              <h2 className="font-display mt-2 text-2xl font-semibold sm:text-3xl">{item.title}</h2>
              {item.subtitle && <p className="mt-2 text-sm text-muted-foreground">{item.subtitle}</p>}
              <div className="mt-4 flex flex-wrap gap-2">
                <StatusPill tone={item.matchState === "matched" ? "success" : item.matchState === "unmatched" ? "danger" : "warning"}>{matchStateLabels[item.matchState]}</StatusPill>
                <StatusPill>{item.year ?? "年份未知"}</StatusPill>
                <StatusPill>{item.fileCount} 个文件</StatusPill>
              </div>
              {canMatchVideo && (
                <div className="mt-4 flex flex-wrap gap-2">
                  <SecondaryButton onClick={onManualMatch}><WandSparkles className="size-4" /> 手动匹配</SecondaryButton>
                  {item.matchState !== "unmatched" && (
                    <button
                      type="button"
                      onClick={onClearMatch}
                      disabled={clearingMatch}
                      className="inline-flex items-center justify-center gap-2 rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-2.5 text-sm text-destructive transition-colors hover:bg-destructive/15 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <Trash2 className="size-4" /> {clearingMatch ? "清除中" : "清除匹配"}
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="grid gap-5 p-5 sm:p-7 lg:grid-cols-[minmax(0,1.3fr)_minmax(280px,0.7fr)]">
          <div className="space-y-5">
            <div>
              <h3 className="text-sm font-semibold">内容简介</h3>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-7 text-muted-foreground">{item.overview || "暂无简介"}</p>
            </div>
            {metadata.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold">媒体信息</h3>
                <dl className="mt-3 grid gap-3 rounded-xl border border-border bg-secondary/30 p-4 sm:grid-cols-2">
                  {metadata.map((entry) => <div key={entry.label}><dt className="text-[11px] text-muted-foreground">{entry.label}</dt><dd className="mt-1 text-sm break-words">{entry.value}</dd></div>)}
                </dl>
              </div>
            )}
            {mediaProbeSummary && (
              <div>
                <h3 className="text-sm font-semibold">视频规格</h3>
                <dl className="mt-3 grid gap-3 rounded-xl border border-border bg-secondary/30 p-4 sm:grid-cols-2">
                  <div><dt className="text-[11px] text-muted-foreground">分析进度</dt><dd className="mt-1 text-sm">{mediaProbeSummary.analyzedFileCount} / {item.fileCount || mediaProbeSummary.analyzedFileCount} 个文件</dd></div>
                  <div><dt className="text-[11px] text-muted-foreground">{isSeries ? "最长单集时长" : "时长"}</dt><dd className="mt-1 text-sm">{formatMediaDuration(mediaProbeSummary.durationMs)}</dd></div>
                  <div><dt className="text-[11px] text-muted-foreground">视频</dt><dd className="mt-1 text-sm">{[formatMediaCodec(mediaProbeSummary.videoCodec), formatMediaResolution(mediaProbeSummary.width, mediaProbeSummary.height), mediaProbeSummary.videoRangeType || mediaProbeSummary.videoRange].filter((value) => value && value !== "未知" && value !== "SDR").join(" · ") || "未知"}</dd></div>
                  <div><dt className="text-[11px] text-muted-foreground">音频</dt><dd className="mt-1 text-sm">{[formatMediaCodec(mediaProbeSummary.audioCodec), mediaProbeSummary.audioChannelLayout || (mediaProbeSummary.audioChannels > 0 ? `${mediaProbeSummary.audioChannels} 声道` : "")].filter(Boolean).join(" · ") || "未知"}</dd></div>
                  <div><dt className="text-[11px] text-muted-foreground">封装与码率</dt><dd className="mt-1 text-sm">{[mediaProbeSummary.container.toLocaleUpperCase("zh-CN"), formatMediaBitRate(mediaProbeSummary.bitRate)].filter((value) => value && value !== "未知").join(" · ") || "未知"}</dd></div>
                  <div><dt className="text-[11px] text-muted-foreground">内置流</dt><dd className="mt-1 text-sm">音轨 {mediaProbeSummary.audioStreamCount} · 字幕 {mediaProbeSummary.subtitleStreamCount}</dd></div>
                </dl>
              </div>
            )}
            {externalIds.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold">外部编号</h3>
                <div className="mt-3 flex flex-wrap gap-2">{externalIds.map(([key, value]) => <StatusPill key={key}>{key.toLocaleUpperCase("zh-CN")}：{value}</StatusPill>)}</div>
              </div>
            )}
            <div>
              <h3 className="flex items-center gap-2 text-sm font-semibold"><FolderOpen className="size-4" /> 文件路径</h3>
              {loading ? <p className="mt-3 text-sm text-muted-foreground">正在读取路径…</p> : paths.length > 0 ? (
                <ul className="mt-3 max-h-72 space-y-2 overflow-y-auto pr-1">
                  {paths.map((pathItem) => (
                    <li key={pathItem.fileId} className="rounded-lg border border-border bg-secondary/30 p-3">
                      <p className="break-all font-mono text-xs leading-5">{pathItem.path}</p>
                      <p className="mt-1 text-[11px] text-muted-foreground">{pathItem.linkedItemTitle || pathItem.name} · {formatFileSize(pathItem.size)}</p>
                      {pathItem.mediaProbe && (
                        <div className="mt-2 space-y-1.5 border-t border-border/70 pt-2">
                          <p className="text-[11px] text-muted-foreground">
                            {[formatMediaDuration(pathItem.mediaProbe.runTimeTicks / 10_000), pathItem.mediaProbe.container.toLocaleUpperCase("zh-CN"), formatMediaBitRate(pathItem.mediaProbe.bitRate)].filter((value) => value && value !== "未知").join(" · ")}
                          </p>
                          <div className="flex flex-wrap gap-1.5">
                            {pathItem.mediaProbe.mediaStreams.map((stream, streamIndex) => (
                              <span key={`${pathItem.fileId}-${streamIndex}`} className="rounded-md border border-border bg-background/60 px-2 py-1 text-[10px] text-muted-foreground">
                                {formatMediaStream(stream)}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              ) : <p className="mt-3 text-sm text-muted-foreground">当前条目没有可展示的文件路径</p>}
            </div>
          </div>

          <div>
            <h3 className="text-sm font-semibold">{isSeries ? "剧集列表" : "子项"}</h3>
            {loading ? <p className="mt-3 text-sm text-muted-foreground">正在读取详情…</p> : error ? <p className="mt-3 text-sm text-destructive">{error}</p> : children.length > 0 ? (
              <ul className="mt-3 max-h-96 space-y-2 overflow-y-auto pr-1">
                {children.map((child) => (
                  <li key={child.id} className="rounded-lg border border-border bg-secondary/30 p-3">
                    <p className="text-sm">{isSeries ? getSeriesEpisodeLabel(child) : child.title}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {isSeries
                        ? getSeriesEpisodeDescription(child)
                        : `${child.subtitle || itemTypeLabels[child.itemType] || "子项"}${child.year ? ` · ${child.year}` : ""}`}
                    </p>
                  </li>
                ))}
              </ul>
            ) : <p className="mt-3 text-sm text-muted-foreground">{isSeries ? "当前节目没有剧集" : "当前条目没有子项"}</p>}
            <div className="mt-5 rounded-xl border border-border bg-secondary/30 p-4 text-xs leading-6 text-muted-foreground">
              所属用户：{item.ownerUsername}<br />所属服务：{item.serviceName}<br />该页面不提供播放、下载或网盘地址。
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

/**
 * 展示个人、服务或管理员作用域下的无播放海报墙。
 */
export function MediaCatalogView({
  contextDescription,
  items,
  fixedService = false,
  showOwner = false,
  total,
  catalogVersion,
  admin = false,
  loading = false,
  onRefresh,
  serverFiltered = false,
  pageOffset = 0,
  pageLimit = 60,
  onQueryChange,
  onPageChange,
}: {
  contextDescription: string;
  items: MediaItem[];
  fixedService?: boolean;
  showOwner?: boolean;
  total?: number;
  catalogVersion?: number;
  admin?: boolean;
  loading?: boolean;
  onRefresh?: () => void;
  serverFiltered?: boolean;
  pageOffset?: number;
  pageLimit?: number;
  onQueryChange?: (query: MediaCatalogQuery) => void;
  onPageChange?: (offset: number) => void;
}) {
  const [search, setSearch] = useState("");
  const [mediaType, setMediaType] = useState<MediaType | "all">("all");
  // 关键变量：影视子类型和匹配状态共同决定海报墙可见条目，匹配状态按需求默认已匹配。
  const [videoItemType, setVideoItemType] = useState<"all" | "video.movie" | "video.series">("all");
  const [matchState, setMatchState] = useState<MatchState | "all">("matched");
  const [sort, setSort] = useState<CatalogSort>("created_desc");
  const [selectedItem, setSelectedItem] = useState<MediaItem | null>(null);
  const [selectedChildren, setSelectedChildren] = useState<MediaItem[]>([]);
  const [selectedPaths, setSelectedPaths] = useState<MediaPathItem[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  // 关键变量：人工匹配窗口与清除操作状态独立，避免关闭内层窗口时误关媒体详情。
  const [manualMatchOpen, setManualMatchOpen] = useState(false);
  const [clearingMatch, setClearingMatch] = useState(false);
  const [localItems, setLocalItems] = useState<Record<string, MediaItem>>({});
  const displayItems = useMemo(() => items.map((item) => localItems[item.id] ?? item), [items, localItems]);
  const locallyFilteredItems = useMemo(() => displayItems.filter((item) => {
    const matchesMediaType = mediaType === "all" || item.mediaType === mediaType;
    const matchesVideoItemType = videoItemType === "all" || item.itemType === videoItemType;
    const matchesState = matchState === "all" || item.matchState === matchState;
    const keyword = search.trim().toLocaleLowerCase("zh-CN");
    return matchesMediaType && matchesVideoItemType && matchesState
      && (!keyword || `${item.title} ${item.subtitle}`.toLocaleLowerCase("zh-CN").includes(keyword));
  }), [displayItems, matchState, mediaType, search, videoItemType]);
  const visibleItems = serverFiltered ? displayItems : locallyFilteredItems;

  useEffect(() => {
    if (!onQueryChange) return undefined;
    // 搜索输入稍作等待，按钮筛选则立即提交服务端，避免每个按键都请求媒体库。
    const delay = search.trim() ? 350 : 0;
    const timer = window.setTimeout(() => onQueryChange({
      search: search.trim(),
      mediaType,
      videoItemType,
      matchState,
      sort,
    }), delay);
    return () => window.clearTimeout(timer);
  }, [matchState, mediaType, onQueryChange, search, sort, videoItemType]);

  useEffect(() => {
    if (!selectedItem) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (manualMatchOpen) setManualMatchOpen(false);
      else setSelectedItem(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [manualMatchOpen, selectedItem]);

  /** 打开海报详情并并行读取最新条目和子项。 */
  async function openMediaDetail(item: MediaItem): Promise<void> {
    setSelectedItem(item);
    setSelectedChildren([]);
    setSelectedPaths([]);
    setDetailError(null);
    setDetailLoading(true);
    try {
      const [detail, children, paths] = await Promise.all([
        getMediaItem(item, admin),
        listMediaItemChildren(item, admin),
        listMediaItemPaths(item, admin),
      ]);
      setSelectedItem(detail);
      setSelectedChildren(children);
      setSelectedPaths(paths);
      if (detail.itemType === "video.series") {
        const missingPositionCount = children.filter((child) => {
          const seasonNumber = Number(child.metadata.seasonNumber);
          const episodeNumber = Number(child.metadata.episodeNumber);
          return !Number.isInteger(seasonNumber) || seasonNumber < 0 || !Number.isInteger(episodeNumber) || episodeNumber < 1;
        }).length;
        console.info("codex-media-series-children", {
          事件: "加载节目剧集列表",
          节目ID: detail.id,
          子项数量: children.length,
          缺少季集位置数量: missingPositionCount,
        });
      }
    } catch (error) {
      setDetailError(error instanceof Error ? error.message : "媒体详情读取失败");
    } finally {
      setDetailLoading(false);
    }
  }

  /** 接收手动匹配结果并刷新详情、路径和海报墙数据。 */
  async function applyManualMatchResult(updatedItem: MediaItem): Promise<void> {
    setLocalItems((current) => ({ ...current, [updatedItem.id]: updatedItem }));
    setSelectedItem(updatedItem);
    setManualMatchOpen(false);
    setDetailLoading(true);
    setDetailError(null);
    try {
      const [children, paths] = await Promise.all([
        listMediaItemChildren(updatedItem, admin),
        listMediaItemPaths(updatedItem, admin),
      ]);
      setSelectedChildren(children);
      setSelectedPaths(paths);
      onRefresh?.();
    } catch (error) {
      setDetailError(error instanceof Error ? error.message : "媒体详情刷新失败");
    } finally {
      setDetailLoading(false);
    }
  }

  /** 二次确认后清除匹配结果并刷新当前海报详情。 */
  async function clearSelectedMatch(): Promise<void> {
    if (!selectedItem || clearingMatch) return;
    if (!window.confirm(`确定清除“${selectedItem.title}”的匹配结果吗？海报、简介和外部编号将被移除。`)) return;
    setClearingMatch(true);
    setDetailError(null);
    try {
      const updatedItem = await clearMediaItemMatch(selectedItem, admin);
      await applyManualMatchResult(updatedItem);
    } catch (error) {
      setDetailError(error instanceof Error ? error.message : "匹配结果清除失败");
    } finally {
      setClearingMatch(false);
    }
  }

  return (
    <>
      <Panel
        className="mb-4"
        title="筛选上下文"
        description={contextDescription}
        action={
          <SecondaryButton onClick={onRefresh}>
            <RefreshCw className="size-4" /> 有新内容，点击刷新
          </SecondaryButton>
        }
      >
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto]">
          <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-secondary/50 px-3 py-2.5">
            <Search className="size-4 shrink-0 text-muted-foreground" />
            <input
              aria-label="搜索媒体"
              placeholder="搜索标题、艺术家、作者"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">媒体类型</span>
            <FilterChip active={mediaType === "all"} onClick={() => { setMediaType("all"); setVideoItemType("all"); }}>全部</FilterChip>
            <FilterChip active={mediaType === "video"} onClick={() => setMediaType("video")}>影视</FilterChip>
            <FilterChip active={mediaType === "music"} onClick={() => { setMediaType("music"); setVideoItemType("all"); }}>音乐</FilterChip>
            <FilterChip active={mediaType === "audiobook"} onClick={() => { setMediaType("audiobook"); setVideoItemType("all"); }}>有声书</FilterChip>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">影视类型</span>
          <FilterChip active={videoItemType === "all"} onClick={() => setVideoItemType("all")}>全部</FilterChip>
          <FilterChip active={videoItemType === "video.movie"} onClick={() => { setMediaType("video"); setVideoItemType("video.movie"); }}>电影</FilterChip>
          <FilterChip active={videoItemType === "video.series"} onClick={() => { setMediaType("video"); setVideoItemType("video.series"); }}>节目</FilterChip>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">匹配状态</span>
          <FilterChip active={matchState === "matched"} onClick={() => setMatchState("matched")}>已匹配</FilterChip>
          <FilterChip active={matchState === "needs_review"} onClick={() => setMatchState("needs_review")}>待确认</FilterChip>
          <FilterChip active={matchState === "unmatched"} onClick={() => setMatchState("unmatched")}>未匹配</FilterChip>
          <FilterChip active={matchState === "processing"} onClick={() => setMatchState("processing")}>处理中</FilterChip>
          <FilterChip active={matchState === "all"} onClick={() => setMatchState("all")}>全部</FilterChip>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">排序方式</span>
          {(Object.entries(catalogSortLabels) as Array<[CatalogSort, string]>).map(([value, label]) => (
            <FilterChip key={value} active={sort === value} onClick={() => setSort(value)}>{label}</FilterChip>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <StatusPill tone="primary">
            {fixedService ? "服务作用域：已锁定" : "服务：全部"}
          </StatusPill>
          {showOwner && <StatusPill>用户：全部</StatusPill>}
          <StatusPill>匹配状态：{getMatchStateLabel(matchState)}</StatusPill>
          <StatusPill tone="warning">{serverFiltered ? "本页" : ""}待确认 {displayItems.filter((item) => item.matchState === "needs_review").length}</StatusPill>
          {catalogVersion !== undefined && <StatusPill tone="info">目录版本 v{catalogVersion}</StatusPill>}
          <StatusPill>显示 {visibleItems.length} / 共 {total ?? displayItems.length} 项</StatusPill>
        </div>
      </Panel>

      {loading ? (
        <Panel><div className="py-12 text-center text-sm text-muted-foreground">正在读取媒体目录…</div></Panel>
      ) : visibleItems.length > 0 ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {visibleItems.map((item) => (
            <PosterCard key={item.id} item={item} onClick={() => void openMediaDetail(item)} />
          ))}
        </div>
      ) : (
        <Panel>
          <div className="py-12 text-center">
            <p className="text-sm">{displayItems.length > 0 ? "没有符合当前筛选条件的媒体" : "当前作用域还没有媒体内容"}</p>
            <p className="mt-2 text-xs text-muted-foreground">{displayItems.length > 0 ? "可以调整媒体类型、影视类型或匹配状态。" : "完成扫描后，已提交条目会实时出现在这里。"}</p>
          </div>
        </Panel>
      )}

      {onPageChange && total !== undefined && total > 0 && (
        <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
          <SecondaryButton disabled={pageOffset <= 0 || loading} onClick={() => onPageChange(Math.max(0, pageOffset - pageLimit))}>上一页</SecondaryButton>
          <span className="text-xs text-muted-foreground">第 {Math.floor(pageOffset / pageLimit) + 1} / {Math.max(1, Math.ceil(total / pageLimit))} 页</span>
          <SecondaryButton disabled={pageOffset + pageLimit >= total || loading} onClick={() => onPageChange(pageOffset + pageLimit)}>下一页</SecondaryButton>
        </div>
      )}

      {selectedItem && (
        <MediaDetailDialog
          item={selectedItem}
          children={selectedChildren}
          paths={selectedPaths}
          loading={detailLoading}
          error={detailError}
          clearingMatch={clearingMatch}
          onManualMatch={() => setManualMatchOpen(true)}
          onClearMatch={() => void clearSelectedMatch()}
          onClose={() => { setManualMatchOpen(false); setSelectedItem(null); }}
        />
      )}
      {selectedItem && manualMatchOpen && (
        <MediaManualMatchDialog
          item={selectedItem}
          admin={admin}
          onApplied={(updatedItem) => { void applyManualMatchResult(updatedItem); }}
          onClose={() => setManualMatchOpen(false)}
        />
      )}
    </>
  );
}
