import { createHash } from "node:crypto";
import path from "node:path";
import type { MediaType } from "../domain.js";
import type { ProviderEntry } from "../providers/types.js";
import {
  buildFlymbyScrapeTaskKey,
  parseFlymbyVideoDirectory,
  parseFlymbyVideoName,
  type FlymbyParsedVideoName,
} from "./flymby-video-parser.js";

const videoExtensions = new Set([
  "mp4", "mkv", "avi", "mov", "wmv", "flv", "m4v", "ts", "m2ts", "mpg", "mpeg", "rmvb", "webm", "3gp", "iso", "strm",
]);
const audioExtensions = new Set(["mp3", "flac", "m4a", "aac", "ogg", "opus", "wav", "ape", "wma", "mka"]);

export interface MediaDescriptor {
  identityKey: string;
  mediaType: MediaType;
  itemType: string;
  title: string;
  sortTitle: string;
  subtitle: string;
  year: number | null;
  matchState: "matched" | "needs_review" | "unmatched" | "processing";
  metadata: Record<string, unknown>;
  parent?: {
    identityKey: string;
    itemType: string;
    title: string;
    subtitle: string;
    year: number | null;
    sortOrder: number;
    relationType: string;
  };
}

/** 按稳定作用域生成不暴露文件路径的确定性资源 ID。 */
export function createStableId(prefix: string, ...parts: string[]): string {
  const digest = createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 24);
  return `${prefix}_${digest}`;
}

/** 提取文件扩展名，不保留句点。 */
export function getFileExtension(name: string): string {
  return path.posix.extname(name).slice(1).toLocaleLowerCase("en-US");
}

/** 清理发布组、分辨率和年份标记，保留可用于刮削的可读标题。 */
function cleanMediaTitle(rawName: string): { title: string; year: number | null } {
  const withoutExtension = rawName.replace(/\.[^.]+$/u, "");
  const yearMatch = withoutExtension.match(/(?:^|[. _\-(])((?:19|20)\d{2})(?:$|[. _\-)])/u);
  const year = yearMatch ? Number(yearMatch[1]) : null;
  const title = withoutExtension
    .replace(/\[[^\]]*\]/gu, " ")
    .replace(/\b(?:2160p|1080p|720p|4k|bluray|web[- .]?dl|webrip|hdtv|x264|x265|hevc|av1)\b.*$/iu, " ")
    .replace(/(?:^|[. _\-(])(?:19|20)\d{2}(?:$|[. _\-)])/u, " ")
    .replace(/[._]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return { title: title || withoutExtension, year };
}

/** 按根目录媒体范围和路径特征区分音乐与有声书。 */
function resolveAudioType(entry: ProviderEntry, allowedTypes: MediaType[]): MediaType {
  if (allowedTypes.length === 1 && allowedTypes[0] === "audiobook") {
    return "audiobook";
  }
  if (allowedTypes.length === 1 && allowedTypes[0] === "music") {
    return "music";
  }
  return /(?:有声书|听书|audiobook|audio[ _.-]?book)/iu.test(entry.path)
    ? "audiobook"
    : "music";
}

/** 把 Provider 文件名和目录层级转换为通用三类媒体描述。 */
export function describeMediaFile(
  entry: ProviderEntry,
  allowedTypes: MediaType[],
  scanRootPath = "/",
  parsedVideo?: FlymbyParsedVideoName,
): MediaDescriptor | null {
  const extension = getFileExtension(entry.name);
  if (videoExtensions.has(extension) && allowedTypes.includes("video")) {
    return describeVideo(entry, scanRootPath, parsedVideo);
  }
  if (audioExtensions.has(extension)) {
    const audioType = resolveAudioType(entry, allowedTypes);
    if (!allowedTypes.includes(audioType)) {
      return null;
    }
    return audioType === "music" ? describeMusic(entry) : describeAudiobook(entry);
  }
  return null;
}

/** 按目录上下文批量识别媒体，确保同一节目下的单集共享一个刮削任务。 */
export function describeMediaDirectory(
  entries: ProviderEntry[],
  allowedTypes: MediaType[],
  scanRootPath = "/",
): Map<string, MediaDescriptor> {
  const descriptors = new Map<string, MediaDescriptor>();
  const parsedVideos = allowedTypes.includes("video")
    ? parseFlymbyVideoDirectory(entries, scanRootPath)
    : new Map<string, FlymbyParsedVideoName>();
  for (const entry of entries) {
    const descriptor = describeMediaFile(entry, allowedTypes, scanRootPath, parsedVideos.get(entry.resourceId));
    if (descriptor) descriptors.set(entry.resourceId, descriptor);
  }
  return descriptors;
}

/** 按 Flymby APP 的文件名、季目录和媒体分类目录规则识别电影或剧集文件。 */
function describeVideo(
  entry: ProviderEntry,
  scanRootPath: string,
  parsedVideo?: FlymbyParsedVideoName,
): MediaDescriptor {
  const parsed = parsedVideo ?? parseFlymbyVideoName(entry, scanRootPath);
  const scrapeTaskKey = buildFlymbyScrapeTaskKey(parsed) || `movie|path|${entry.resourceId}`;
  if (parsed.mediaType === "movie") {
    return {
      identityKey: `video:file:${entry.resourceId}`,
      mediaType: "video",
      itemType: "video.movie",
      title: parsed.title || entry.name,
      sortTitle: parsed.title,
      subtitle: parsed.year ? String(parsed.year) : "电影",
      year: parsed.year,
      matchState: "unmatched",
      metadata: {
        sourcePath: entry.path,
        scrapeTaskKey,
        query: parsed.query,
        imdbId: parsed.imdbId,
        explicitTmdbId: parsed.tmdbId,
        resolution: parsed.resolution,
        source: parsed.source,
        releaseGroup: parsed.releaseGroup,
      },
    };
  }
  const season = parsed.seasonNumber;
  const episodeNumbers = parsed.episodeNumbers.length > 0
    ? parsed.episodeNumbers
    : parsed.episodeNumber > 0 ? [parsed.episodeNumber] : [1];
  const episode = episodeNumbers[0] ?? 1;
  const episodeTitle = episodeNumbers.length > 1
    ? `第 ${season} 季 · 第 ${episodeNumbers[0]}-${episodeNumbers[episodeNumbers.length - 1]} 集`
    : `第 ${season} 季 · 第 ${episode} 集`;
  return {
    identityKey: `video:episode:${entry.resourceId}`,
    mediaType: "video",
    itemType: "video.episode",
    title: episodeTitle,
    sortTitle: `${String(season).padStart(3, "0")}-${String(episode).padStart(5, "0")}`,
    subtitle: parsed.title,
    year: parsed.year,
    matchState: "unmatched",
    metadata: {
      sourcePath: entry.path,
      scrapeTaskKey,
      query: parsed.query,
      seriesTitle: parsed.title,
      seasonNumber: season,
      episodeNumber: episode,
      episodeNumbers,
      imdbId: parsed.imdbId,
      explicitTmdbId: parsed.tmdbId,
      resolution: parsed.resolution,
      source: parsed.source,
      releaseGroup: parsed.releaseGroup,
    },
    parent: {
      identityKey: `video:series:${scrapeTaskKey}`,
      itemType: "video.series",
      title: parsed.title,
      subtitle: "剧集",
      year: parsed.year,
      sortOrder: season * 100_000 + episode,
      relationType: "series_episode",
    },
  };
}

/** 按“艺术家/专辑/曲目”目录惯例识别音乐条目。 */
function describeMusic(entry: ProviderEntry): MediaDescriptor {
  const fileTitle = cleanMediaTitle(entry.name).title;
  const directory = path.posix.dirname(entry.path);
  const album = cleanMediaTitle(path.posix.basename(directory)).title;
  const artistDirectory = path.posix.dirname(directory);
  const artist = cleanMediaTitle(path.posix.basename(artistDirectory)).title;
  const trackMatch = entry.name.match(/^\s*(\d{1,3})(?:[-._ ]|$)/u);
  const trackNumber = trackMatch ? Number(trackMatch[1]) : 0;
  const title = fileTitle.replace(/^\s*\d{1,3}\s*[-._ ]\s*/u, "").trim() || fileTitle;
  return {
    identityKey: `music:track:${entry.resourceId}`,
    mediaType: "music",
    itemType: "music.track",
    title,
    sortTitle: String(trackNumber).padStart(5, "0"),
    subtitle: `${artist} · ${album}`,
    year: cleanMediaTitle(album).year,
    matchState: "unmatched",
    metadata: { artist, album, trackNumber },
    parent: {
      identityKey: `music:album:${directory}`,
      itemType: "music.album",
      title: album,
      subtitle: artist,
      year: cleanMediaTitle(album).year,
      sortOrder: trackNumber,
      relationType: "album_track",
    },
  };
}

/** 按“作品/章节”目录惯例识别有声书条目。 */
function describeAudiobook(entry: ProviderEntry): MediaDescriptor {
  const directory = path.posix.dirname(entry.path);
  const bookTitle = cleanMediaTitle(path.posix.basename(directory)).title;
  const rawChapter = cleanMediaTitle(entry.name).title;
  const chapterMatch = entry.name.match(/^\s*(\d{1,5})(?:[-._ ]|$)/u);
  const chapterNumber = chapterMatch ? Number(chapterMatch[1]) : 0;
  const chapterTitle = rawChapter.replace(/^\s*\d{1,5}\s*[-._ ]\s*/u, "").trim() || rawChapter;
  return {
    identityKey: `audiobook:chapter:${entry.resourceId}`,
    mediaType: "audiobook",
    itemType: "audiobook.chapter",
    title: chapterTitle,
    sortTitle: String(chapterNumber).padStart(7, "0"),
    subtitle: bookTitle,
    year: null,
    matchState: "unmatched",
    metadata: { chapterNumber },
    parent: {
      identityKey: `audiobook:book:${directory}`,
      itemType: "audiobook.book",
      title: bookTitle,
      subtitle: "有声书",
      year: null,
      sortOrder: chapterNumber,
      relationType: "book_chapter",
    },
  };
}
