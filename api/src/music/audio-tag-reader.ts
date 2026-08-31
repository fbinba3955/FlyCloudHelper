import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ApiConfig } from "../config.js";
import type { MediaDescriptor } from "../media/filename.js";
import type { ProviderEntry, ProviderFileStreamAccess } from "../providers/types.js";

export const AUDIO_TAG_PARSER_VERSION = "ffprobe-audio-tags-v3";

export interface AudioTagFields {
  title: string;
  artists: string[];
  album: string;
  albumArtists: string[];
  trackNumber: number;
  trackTotal: number;
  discNumber: number;
  discTotal: number;
  date: string;
  year: number | null;
  genres: string[];
  composers: string[];
  lyrics: string;
  isrc: string;
  musicBrainzRecordingId: string;
  musicBrainzReleaseTrackId: string;
  musicBrainzReleaseId: string;
  musicBrainzReleaseGroupId: string;
  musicBrainzArtistIds: string[];
  musicBrainzAlbumArtistIds: string[];
}

export interface AudioTechnicalFields {
  durationMs: number;
  container: string;
  bitRate: number;
  codec: string;
  sampleRate: number;
  channels: number;
  channelLayout: string;
  bitDepth: number;
}

export interface AudioTagReadResult {
  status: "complete" | "partial" | "empty" | "failed";
  tags: AudioTagFields;
  technical: AudioTechnicalFields;
  artwork: { embedded: boolean; url: string | null };
  readBytesLimit: number;
  errorCode: string | null;
  errorMessage: string | null;
  readAt: string;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  sample_rate?: string;
  channels?: number;
  channel_layout?: string;
  bits_per_raw_sample?: string;
  bits_per_sample?: number;
  duration?: string;
  disposition?: { attached_pic?: number };
  tags?: Record<string, unknown>;
}

interface FfprobeDocument {
  format?: {
    format_name?: string;
    duration?: string;
    bit_rate?: string;
    tags?: Record<string, unknown>;
  };
  streams?: FfprobeStream[];
}

/** 构建音频标签缓存指纹，文件或解析器变化后自动失效。 */
export function createAudioTagFingerprint(entry: Pick<ProviderEntry, "resourceId" | "size" | "modifiedAt" | "etag">): string {
  return createHash("sha256")
    .update([entry.resourceId, entry.size, entry.modifiedAt ?? "", entry.etag ?? "", AUDIO_TAG_PARSER_VERSION].join("\u0000"))
    .digest("hex");
}

/** 过滤 ffprobe 可以接收的 HTTP 请求头，避免换行进入子进程参数。 */
function buildFfprobeHeaders(headers: Record<string, string>): string | null {
  const safeHeaders = Object.entries(headers).filter(([name, value]) => (
    /^[A-Za-z0-9-]+$/u.test(name) && !/[\r\n]/u.test(value)
  ));
  return safeHeaders.length > 0
    ? `${safeHeaders.map(([name, value]) => `${name}: ${value}`).join("\r\n")}\r\n`
    : null;
}

/** 将任意标签对象转换为忽略大小写的字符串索引。 */
function indexTags(...sources: Array<Record<string, unknown> | undefined>): Map<string, string> {
  const result = new Map<string, string>();
  for (const source of sources) {
    if (!source) continue;
    for (const [key, value] of Object.entries(source)) {
      const text = typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
      if (text && !result.has(key.toLocaleLowerCase("en-US"))) {
        result.set(key.toLocaleLowerCase("en-US"), text);
      }
    }
  }
  return result;
}

/** 按常见 ffprobe 标签别名读取第一个非空值。 */
function readTag(tags: Map<string, string>, names: string[]): string {
  for (const name of names) {
    const value = tags.get(name.toLocaleLowerCase("en-US"));
    if (value) return value;
  }
  return "";
}

/** 将多值标签拆成稳定数组，不拆分艺术家名称内部的斜线和逗号。 */
function readTagList(value: string): string[] {
  if (!value) return [];
  return [...new Set(value.split(/\u0000|\s*;\s*/u).map((item) => item.trim()).filter(Boolean))];
}

/** 解析 `1/12`、`1 of 12` 等曲序或碟序。 */
function readPosition(value: string): { number: number; total: number } {
  const match = value.match(/^\s*(\d{1,5})(?:\s*(?:\/|of)\s*(\d{1,5}))?/iu);
  return {
    number: match ? Math.max(0, Number(match[1])) : 0,
    total: match?.[2] ? Math.max(0, Number(match[2])) : 0,
  };
}

/** 从 ffprobe JSON 映射云助手使用的音频标签白名单。 */
function mapFfprobeDocument(document: FfprobeDocument, readBytesLimit: number): AudioTagReadResult {
  const streams = Array.isArray(document.streams) ? document.streams : [];
  const audioStream = streams.find((stream) => stream.codec_type === "audio");
  const tags = indexTags(document.format?.tags, audioStream?.tags);
  const track = readPosition(readTag(tags, ["track", "tracknumber"]));
  const disc = readPosition(readTag(tags, ["disc", "discnumber", "disk"]));
  const date = readTag(tags, ["date", "year", "originaldate"]);
  const yearMatch = date.match(/(?:^|\D)((?:19|20)\d{2})(?:\D|$)/u);
  const artists = readTagList(readTag(tags, ["artist", "artists", "performer"]));
  const albumArtists = readTagList(readTag(tags, ["album_artist", "albumartist"]));
  const mappedTags: AudioTagFields = {
    title: readTag(tags, ["title"]),
    artists,
    album: readTag(tags, ["album"]),
    albumArtists,
    trackNumber: track.number,
    trackTotal: track.total,
    discNumber: disc.number,
    discTotal: disc.total,
    date,
    year: yearMatch ? Number(yearMatch[1]) : null,
    genres: readTagList(readTag(tags, ["genre"])),
    composers: readTagList(readTag(tags, ["composer"])),
    // 关键变量：ffprobe 会按容器把 USLT、Vorbis LYRICS 等标签映射为不同名称。
    lyrics: readTag(tags, ["lyrics", "unsyncedlyrics", "unsynced_lyrics", "syncedlyrics", "synced_lyrics"]),
    isrc: readTag(tags, ["isrc"]),
    musicBrainzRecordingId: readTag(tags, ["musicbrainz_trackid", "musicbrainz_recordingid"]),
    musicBrainzReleaseTrackId: readTag(tags, ["musicbrainz_releasetrackid"]),
    musicBrainzReleaseId: readTag(tags, ["musicbrainz_albumid", "musicbrainz_releaseid"]),
    musicBrainzReleaseGroupId: readTag(tags, ["musicbrainz_releasegroupid"]),
    musicBrainzArtistIds: readTagList(readTag(tags, ["musicbrainz_artistid"])),
    musicBrainzAlbumArtistIds: readTagList(readTag(tags, ["musicbrainz_albumartistid"])),
  };
  const durationSeconds = Number(document.format?.duration ?? audioStream?.duration ?? 0);
  const technical: AudioTechnicalFields = {
    durationMs: Number.isFinite(durationSeconds) && durationSeconds > 0 ? Math.round(durationSeconds * 1000) : 0,
    container: String(document.format?.format_name ?? "").split(",", 1)[0] ?? "",
    bitRate: Math.max(0, Number(document.format?.bit_rate ?? 0) || 0),
    codec: String(audioStream?.codec_name ?? ""),
    sampleRate: Math.max(0, Number(audioStream?.sample_rate ?? 0) || 0),
    channels: Math.max(0, Number(audioStream?.channels ?? 0) || 0),
    channelLayout: String(audioStream?.channel_layout ?? ""),
    bitDepth: Math.max(0, Number(audioStream?.bits_per_raw_sample ?? audioStream?.bits_per_sample ?? 0) || 0),
  };
  const hasTag = Boolean(mappedTags.title || mappedTags.artists.length > 0 || mappedTags.album || mappedTags.albumArtists.length > 0);
  const hasTechnical = Boolean(technical.codec || technical.durationMs || technical.sampleRate);
  return {
    status: hasTag ? "complete" : hasTechnical ? "empty" : "partial",
    tags: mappedTags,
    technical,
    artwork: { embedded: streams.some((stream) => stream.disposition?.attached_pic === 1), url: null },
    readBytesLimit,
    errorCode: null,
    errorMessage: null,
    readAt: new Date().toISOString(),
  };
}

/** 返回一个不包含凭据、地址或文件路径的失败结果。 */
function createFailureResult(errorCode: string, errorMessage: string, readBytesLimit: number): AudioTagReadResult {
  return {
    status: "failed",
    tags: {
      title: "", artists: [], album: "", albumArtists: [], trackNumber: 0, trackTotal: 0,
      discNumber: 0, discTotal: 0, date: "", year: null, genres: [], composers: [], lyrics: "", isrc: "",
      musicBrainzRecordingId: "", musicBrainzReleaseTrackId: "", musicBrainzReleaseId: "",
      musicBrainzReleaseGroupId: "", musicBrainzArtistIds: [], musicBrainzAlbumArtistIds: [],
    },
    technical: {
      durationMs: 0, container: "", bitRate: 0, codec: "", sampleRate: 0, channels: 0,
      channelLayout: "", bitDepth: 0,
    },
    artwork: { embedded: false, url: null },
    readBytesLimit,
    errorCode,
    errorMessage,
    readAt: new Date().toISOString(),
  };
}

/** 从远端音频提取第一张内嵌封面，按内容摘要写入本地缓存并返回公开相对地址。 */
async function extractAndCacheEmbeddedArtwork(input: {
  config: ApiConfig;
  access: ProviderFileStreamAccess;
  signal: AbortSignal;
}): Promise<string | null> {
  const args = ["-hide_banner", "-v", "error"];
  const headerText = buildFfprobeHeaders(input.access.headers);
  if (headerText) args.push("-headers", headerText);
  args.push(
    "-i", input.access.url,
    "-map", "0:v:0",
    "-frames:v", "1",
    "-f", "image2pipe",
    "-vcodec", "mjpeg",
    "pipe:1",
  );
  const artwork = await new Promise<Buffer | null>((resolve) => {
    const child = spawn(input.config.ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    const output: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const finish = (value: Buffer | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      input.signal.removeEventListener("abort", abort);
      resolve(value);
    };
    const abort = (): void => {
      child.kill("SIGKILL");
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, Math.min(input.config.ffprobeTimeoutMs, 30_000));
    input.signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > 10 * 1024 * 1024) {
        child.kill("SIGKILL");
        finish(null);
        return;
      }
      output.push(chunk);
    });
    child.stderr.resume();
    child.once("error", () => finish(null));
    child.once("close", (exitCode) => {
      if (exitCode !== 0 || outputBytes === 0) {
        finish(null);
        return;
      }
      finish(Buffer.concat(output));
    });
  });
  if (!artwork) return null;
  const artworkId = createHash("sha256").update(artwork).digest("hex");
  const fileName = `${artworkId}.jpg`;
  await fs.promises.mkdir(input.config.musicArtworkDirectory, { recursive: true });
  try {
    await fs.promises.writeFile(path.join(input.config.musicArtworkDirectory, fileName), artwork, { flag: "wx" });
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error;
  }
  return `/api/v1/music-artwork/${fileName}`;
}

/** 使用 ffprobe 从 Provider 临时地址读取标签，不通过 shell，也不保存 stderr。 */
export function readRemoteAudioTags(input: {
  config: ApiConfig;
  access: ProviderFileStreamAccess;
  fileName: string;
  signal: AbortSignal;
}): Promise<AudioTagReadResult> {
  // 关键变量：音频标签只使用较小探测窗口；超出窗口无法读取的格式按部分标签降级。
  const readBytesLimit = Math.min(input.config.ffprobeProbeSizeBytes, 2 * 1024 * 1024);
  const args = [
    "-hide_banner", "-v", "error", "-print_format", "json",
    "-show_format", "-show_streams", "-analyzeduration", "0", "-probesize", String(readBytesLimit),
    "-show_entries",
    "format=format_name,duration,bit_rate:format_tags:stream=codec_type,codec_name,sample_rate,channels,channel_layout,bits_per_raw_sample,bits_per_sample,duration,disposition:stream_tags",
  ];
  const headerText = buildFfprobeHeaders(input.access.headers);
  if (headerText) args.push("-headers", headerText);
  args.push("-i", input.access.url);

  return new Promise((resolve) => {
    const child = spawn(input.config.ffprobePath, args, { stdio: ["ignore", "pipe", "pipe"] });
    const output: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const finish = (result: AudioTagReadResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      input.signal.removeEventListener("abort", abort);
      resolve(result);
    };
    const abort = (): void => {
      child.kill("SIGKILL");
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(createFailureResult("audio_tag_timeout", "音频标签读取超时", readBytesLimit));
    }, Math.min(input.config.ffprobeTimeoutMs, 15_000));
    input.signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > 2 * 1024 * 1024) {
        child.kill("SIGKILL");
        finish(createFailureResult("audio_tag_output_too_large", "音频标签解析结果过大", readBytesLimit));
        return;
      }
      output.push(chunk);
    });
    // stderr 可能包含带令牌的临时 URL，只消费不保存。
    child.stderr.resume();
    child.once("error", (error: NodeJS.ErrnoException) => {
      finish(createFailureResult(error.code === "ENOENT" ? "ffprobe_unavailable" : "audio_tag_probe_failed", "音频标签读取失败", readBytesLimit));
    });
    child.once("close", async (exitCode) => {
      if (settled) return;
      clearTimeout(timeout);
      input.signal.removeEventListener("abort", abort);
      if (input.signal.aborted) {
        finish(createFailureResult("audio_tag_aborted", "音频标签读取已终止", readBytesLimit));
        return;
      }
      if (exitCode !== 0) {
        finish(createFailureResult("audio_tag_probe_failed", "音频标签读取失败", readBytesLimit));
        return;
      }
      try {
        const result = mapFfprobeDocument(JSON.parse(Buffer.concat(output).toString("utf8")) as FfprobeDocument, readBytesLimit);
        if (result.artwork.embedded) {
          result.artwork.url = await extractAndCacheEmbeddedArtwork({
            config: input.config,
            access: input.access,
            signal: input.signal,
          });
        }
        finish(result);
      } catch {
        finish(createFailureResult("audio_tag_output_invalid", "音频标签解析结果无效", readBytesLimit));
      }
    });
  });
}

/** 将内嵌标签补充到路径识别结果，保留原始路径推断作为字段降级。 */
export function applyAudioTagsToDescriptor(
  descriptor: MediaDescriptor,
  result: AudioTagReadResult,
): MediaDescriptor {
  if (descriptor.mediaType !== "music" || descriptor.itemType !== "music.track") return descriptor;
  const originalMetadata = descriptor.metadata;
  const tagArtist = result.tags.artists[0] ?? "";
  const tagAlbumArtist = result.tags.albumArtists[0] ?? "";
  const artist = tagArtist || String(originalMetadata.artist ?? "");
  const albumArtist = tagAlbumArtist || artist || String(originalMetadata.artist ?? "");
  const album = result.tags.album || String(originalMetadata.album ?? descriptor.parent?.title ?? "未知专辑");
  const title = result.tags.title || descriptor.title;
  const trackNumber = result.tags.trackNumber || Number(originalMetadata.trackNumber ?? 0);
  const discNumber = result.tags.discNumber || 1;
  const year = result.tags.year ?? descriptor.year;
  return {
    ...descriptor,
    title,
    sortTitle: `${String(discNumber).padStart(3, "0")}-${String(trackNumber).padStart(5, "0")}`,
    subtitle: [artist, album].filter(Boolean).join(" · "),
    year,
    metadata: {
      ...originalMetadata,
      artist,
      artists: result.tags.artists.length > 0 ? result.tags.artists : artist ? [artist] : [],
      album,
      albumArtist,
      albumArtists: result.tags.albumArtists.length > 0 ? result.tags.albumArtists : albumArtist ? [albumArtist] : [],
      trackNumber,
      trackTotal: result.tags.trackTotal,
      discNumber,
      discTotal: result.tags.discTotal,
      genres: result.tags.genres,
      composers: result.tags.composers,
      lyrics: result.tags.lyrics || originalMetadata.lyrics,
      isrc: result.tags.isrc,
      durationMs: result.technical.durationMs,
      audioCodec: result.technical.codec,
      audioContainer: result.technical.container,
      audioBitRate: result.technical.bitRate,
      audioSampleRate: result.technical.sampleRate,
      audioChannels: result.technical.channels,
      audioChannelLayout: result.technical.channelLayout,
      audioBitDepth: result.technical.bitDepth,
      embeddedArtwork: result.artwork.embedded,
      embeddedArtworkUrl: result.artwork.url,
      tagStatus: result.status,
      tagParserVersion: AUDIO_TAG_PARSER_VERSION,
      musicBrainzRecordingId: result.tags.musicBrainzRecordingId,
      musicBrainzReleaseTrackId: result.tags.musicBrainzReleaseTrackId,
      musicBrainzReleaseId: result.tags.musicBrainzReleaseId,
      musicBrainzReleaseGroupId: result.tags.musicBrainzReleaseGroupId,
      musicBrainzArtistIds: result.tags.musicBrainzArtistIds,
      musicBrainzAlbumArtistIds: result.tags.musicBrainzAlbumArtistIds,
      metadataFieldSources: {
        title: result.tags.title ? "embedded_tag" : "path",
        artist: tagArtist ? "embedded_tag" : "path",
        album: result.tags.album ? "embedded_tag" : "path",
        lyrics: result.tags.lyrics ? "embedded_tag" : "missing",
        trackNumber: result.tags.trackNumber > 0 ? "embedded_tag" : "filename",
      },
    },
    parent: descriptor.parent ? {
      ...descriptor.parent,
      title: album,
      subtitle: albumArtist || artist,
      year,
      sortOrder: discNumber * 100_000 + trackNumber,
    } : undefined,
  };
}
