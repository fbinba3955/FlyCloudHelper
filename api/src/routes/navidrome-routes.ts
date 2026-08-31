import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { MediaItemRecord } from "../domain.js";
import { ApiError } from "../errors.js";
import { providerStream } from "../providers/network.js";
import type { ApiRuntime } from "../runtime.js";
import { buildUpstreamHeaders, copyMediaResponseHeaders, resolveRelayAccess, type RelayLibraryRow } from "./media-stream-routes.js";

const SUBSONIC_VERSION = "1.16.1";
const SUBSONIC_SERVER_TYPE = "navidrome";

interface NavidromeContext {
  serviceId: string;
  ownerUserId: string;
  libraryId: string;
  libraryName: string;
  accountId: string;
  accountUsername: string;
  relayLibrary: RelayLibraryRow;
}

/** 从任意查询值读取第一个字符串。 */
function readQueryString(value: unknown): string {
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : "";
  return typeof value === "string" ? value : "";
}

/** 读取 Subsonic 可重复参数，并限制单次批量操作数量。 */
function readQueryStrings(value: unknown, maximum = 200): string[] {
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return values.filter((item): item is string => typeof item === "string" && item.length > 0).slice(0, maximum);
}

/** 读取 Subsonic 布尔参数，兼容 true/false 与 1/0。 */
function readQueryBoolean(value: unknown, fallback: boolean): boolean {
  const text = readQueryString(value).toLocaleLowerCase("en-US");
  if (["true", "1"].includes(text)) return true;
  if (["false", "0"].includes(text)) return false;
  return fallback;
}

/** 读取并限制 Subsonic 整数参数。 */
function readQueryInteger(query: Record<string, unknown>, key: string, fallback: number, maximum: number): number {
  const value = Number(readQueryString(query[key]));
  return Number.isInteger(value) && value >= 0 ? Math.min(maximum, value) : fallback;
}

/** 转义 XML 属性和值。 */
function escapeXml(value: unknown): string {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

/** 把 Subsonic JSON 结构转换成等价的属性式 XML。 */
function serializeXmlElement(name: string, value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => serializeXmlElement(name, item)).join("");
  if (!value || typeof value !== "object") return `<${name}>${escapeXml(value ?? "")}</${name}>`;
  const object = value as Record<string, unknown>;
  const attributes = Object.entries(object)
    .filter(([key]) => key !== "_text")
    .filter(([, item]) => item === null || ["string", "number", "boolean"].includes(typeof item))
    .map(([key, item]) => ` ${key}="${escapeXml(item ?? "")}"`)
    .join("");
  const children = Object.entries(object)
    .filter(([key]) => key !== "_text")
    .filter(([, item]) => item !== null && (Array.isArray(item) || typeof item === "object"))
    .map(([key, item]) => serializeXmlElement(key, item))
    .join("");
  const text = object._text === undefined ? "" : escapeXml(object._text);
  return children || text ? `<${name}${attributes}>${text}${children}</${name}>` : `<${name}${attributes}/>`;
}

/** 删除只用于 XML 文本节点的内部字段，避免污染 Subsonic JSON 响应。 */
function stripXmlTextMarkers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripXmlTextMarkers);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => key !== "_text")
    .map(([key, item]) => [key, stripXmlTextMarkers(item)]));
}

/** 返回 Subsonic 标准成功或失败信封，并兼容 JSON 与默认 XML。 */
function sendSubsonicResponse(
  reply: FastifyReply,
  query: Record<string, unknown>,
  payload: Record<string, unknown>,
  status: "ok" | "failed" = "ok",
): FastifyReply {
  const response = {
    status,
    version: SUBSONIC_VERSION,
    type: SUBSONIC_SERVER_TYPE,
    serverVersion: "FlyCloudHelper",
    openSubsonic: true,
    ...payload,
  };
  if (readQueryString(query.f).toLocaleLowerCase("en-US") === "json") {
    return reply.type("application/json; charset=utf-8").send({ "subsonic-response": stripXmlTextMarkers(response) });
  }
  const xml = `<?xml version="1.0" encoding="UTF-8"?>${serializeXmlElement("subsonic-response", {
    xmlns: "http://subsonic.org/restapi",
    ...response,
  })}`;
  return reply.type("text/xml; charset=utf-8").send(xml);
}

/** 把内部错误转换为 Subsonic 错误编号，不暴露 Provider 和数据库细节。 */
function sendSubsonicError(reply: FastifyReply, query: Record<string, unknown>, error: unknown): FastifyReply {
  const apiError = error instanceof ApiError ? error : null;
  const code = apiError?.statusCode === 401 ? 40 : apiError?.statusCode === 404 ? 70 : apiError?.statusCode === 403 ? 50 : 0;
  const message = code === 40 ? "用户名或密码错误" : code === 70 ? "请求的音乐内容不存在" : code === 50 ? "当前账号无权访问" : "Navidrome 协议请求失败";
  return sendSubsonicResponse(reply, query, { error: { code, message } }, "failed");
}

/** 读取已启用的音乐协议服务并验证本次 Subsonic 请求。 */
async function authenticateRequest(
  runtime: ApiRuntime,
  pathSuffix: string,
  query: Record<string, unknown>,
): Promise<NavidromeContext> {
  const service = await runtime.database.query("cloud_services as s")
    .join("media_libraries as l", "l.id", "s.library_id")
    .select(
      "s.id", "s.user_id", "s.library_id", "s.display_name", "s.status", "s.provider_type", "s.credential_revision",
      "l.navidrome_enabled",
    )
    .where("l.navidrome_path_suffix_lookup", pathSuffix.toLowerCase())
    .where("s.data_type", "music")
    .whereNull("s.deleted_at")
    .first();
  if (!service || Number(service.navidrome_enabled) !== 1 || service.status === "disabled") {
    throw new ApiError(404, "navidrome_service_disabled", "Navidrome 音乐服务未启用");
  }
  const serviceId = String(service.id); // 关键变量：公开地址后缀只用于寻址，后续数据隔离始终使用真实服务 ID。
  const account = await runtime.serviceAccess.authenticateSubsonic(serviceId, {
    username: readQueryString(query.u),
    password: query.p === undefined ? undefined : readQueryString(query.p),
    token: query.t === undefined ? undefined : readQueryString(query.t),
    salt: query.s === undefined ? undefined : readQueryString(query.s),
  });
  return {
    serviceId,
    ownerUserId: String(service.user_id),
    libraryId: String(service.library_id),
    libraryName: String(service.display_name),
    accountId: account.id,
    accountUsername: account.username,
    relayLibrary: {
      id: String(service.library_id),
      service_id: serviceId,
      provider_type: String(service.provider_type),
      service_status: String(service.status),
      relay_playback_enabled: 1,
      credential_revision: Number(service.credential_revision),
    },
  };
}

/** 批量读取歌曲或专辑关联的第一个内部艺术家 ID。 */
async function loadArtistIds(runtime: ApiRuntime, context: NavidromeContext, itemIds: string[]): Promise<Map<string, string>> {
  if (itemIds.length === 0) return new Map();
  const rows = await runtime.database.query("media_relations")
    .select("child_item_id", "parent_item_id", "sort_order")
    .where({ user_id: context.ownerUserId, library_id: context.libraryId })
    .whereIn("child_item_id", itemIds)
    .whereIn("relation_type", ["artist_album", "artist_track"])
    .orderBy("sort_order", "asc");
  const result = new Map<string, string>();
  rows.forEach((row) => {
    const childId = String(row.child_item_id);
    if (!result.has(childId)) result.set(childId, String(row.parent_item_id));
  });
  return result;
}

/** 批量读取歌曲所属的内部专辑 ID，保证客户端可从歌曲跳回专辑。 */
async function loadAlbumIds(runtime: ApiRuntime, context: NavidromeContext, songIds: string[]): Promise<Map<string, string>> {
  if (songIds.length === 0) return new Map();
  const rows = await runtime.database.query("media_relations")
    .select("child_item_id", "parent_item_id", "sort_order")
    .where({ user_id: context.ownerUserId, library_id: context.libraryId, relation_type: "album_track" })
    .whereIn("child_item_id", songIds)
    .orderBy("sort_order", "asc");
  const result = new Map<string, string>();
  rows.forEach((row) => {
    const songId = String(row.child_item_id);
    if (!result.has(songId)) result.set(songId, String(row.parent_item_id));
  });
  return result;
}

/** 批量统计父条目的指定关系子项数量。 */
async function loadRelationCounts(
  runtime: ApiRuntime,
  context: NavidromeContext,
  parentIds: string[],
  relationType: "artist_album" | "album_track",
): Promise<Map<string, number>> {
  if (parentIds.length === 0) return new Map();
  const rows = await runtime.database.query("media_relations")
    .select("parent_item_id")
    .count<Array<{ parent_item_id: string; count: string | number }>>({ count: "child_item_id" })
    .where({ user_id: context.ownerUserId, library_id: context.libraryId, relation_type: relationType })
    .whereIn("parent_item_id", parentIds)
    .groupBy("parent_item_id");
  return new Map(rows.map((row) => [String(row.parent_item_id), Number(row.count)]));
}

/** 映射 Subsonic 艺术家对象。 */
function mapArtist(item: MediaItemRecord, albumCount = 0): Record<string, unknown> {
  return {
    id: item.id,
    isDir: true,
    name: item.title,
    albumCount,
    coverArt: item.posterUrl ? item.id : undefined,
    artistImageUrl: item.posterUrl ?? undefined,
  };
}

/** 映射 Subsonic 专辑对象。 */
function mapAlbum(item: MediaItemRecord, artistId = "", songCount = 0, duration = 0): Record<string, unknown> {
  const genres = Array.isArray(item.metadata.genres) ? item.metadata.genres.map(String).filter(Boolean) : [];
  return {
    id: item.id,
    isDir: true,
    parent: artistId || undefined,
    name: item.title,
    title: item.title,
    album: item.title,
    artist: String(item.metadata.albumArtist ?? item.subtitle ?? ""),
    artistId: artistId || undefined,
    coverArt: item.posterUrl ? item.id : undefined,
    songCount,
    duration,
    created: item.createdAt,
    year: item.year ?? undefined,
    genre: genres[0] || undefined,
  };
}

/** 按文件扩展名返回常见音频 MIME。 */
function readAudioContentType(extension: string): string {
  return ({ mp3: "audio/mpeg", flac: "audio/flac", m4a: "audio/mp4", aac: "audio/aac", ogg: "audio/ogg", opus: "audio/ogg", wav: "audio/wav", ape: "audio/ape", wma: "audio/x-ms-wma" } as Record<string, string>)[extension] ?? "application/octet-stream";
}

/** 映射 Subsonic 歌曲对象，文件字段只包含格式与大小，不返回网盘路径。 */
function mapSong(
  item: MediaItemRecord,
  artistId = "",
  albumId = "",
  coverArtId = "",
  file?: Record<string, unknown>,
  accountState?: { starredAt: string | null; rating: number; playCount: number; lastPlayedAt: string | null },
): Record<string, unknown> {
  const extension = String(file?.name ?? "").split(".").pop()?.toLocaleLowerCase("en-US") ?? String(item.metadata.audioContainer ?? "").toLocaleLowerCase("en-US");
  const durationMs = Number(item.metadata.durationMs ?? 0);
  const genres = Array.isArray(item.metadata.genres) ? item.metadata.genres.map(String).filter(Boolean) : [];
  return {
    id: item.id,
    parent: albumId || undefined,
    isDir: false,
    title: item.title,
    album: String(item.metadata.album ?? ""),
    artist: String(item.metadata.artist ?? item.subtitle ?? ""),
    artistId: artistId || undefined,
    albumId: albumId || undefined,
    track: Number(item.metadata.trackNumber ?? 0) || undefined,
    discNumber: Number(item.metadata.discNumber ?? 0) || undefined,
    year: item.year ?? undefined,
    genre: genres[0] || undefined,
    coverArt: coverArtId || undefined,
    size: Number(file?.size ?? 0) || undefined,
    contentType: readAudioContentType(extension),
    suffix: extension || undefined,
    duration: durationMs > 0 ? Math.round(durationMs / 1000) : undefined,
    bitRate: Number(item.metadata.audioBitRate ?? 0) > 0 ? Math.round(Number(item.metadata.audioBitRate) / 1000) : undefined,
    bitDepth: Number(item.metadata.audioBitDepth ?? 0) || undefined,
    samplingRate: Number(item.metadata.audioSampleRate ?? 0) || undefined,
    channelCount: Number(item.metadata.audioChannels ?? 0) || undefined,
    type: "music",
    isVideo: false,
    created: item.createdAt,
    starred: accountState?.starredAt ?? undefined,
    userRating: accountState?.rating || undefined,
    playCount: accountState?.playCount || undefined,
    played: accountState?.lastPlayedAt ?? undefined,
  };
}

/** 批量读取当前协议账号的歌曲收藏、评分和播放次数。 */
async function loadSongAccountStates(
  runtime: ApiRuntime,
  context: NavidromeContext,
  songIds: string[],
): Promise<Map<string, { starredAt: string | null; rating: number; playCount: number; lastPlayedAt: string | null }>> {
  if (songIds.length === 0) return new Map();
  const [preferences, progressRows] = await Promise.all([
    runtime.database.query("service_item_preferences")
      .select("item_id", "starred_at", "rating")
      .where({ service_id: context.serviceId, account_id: context.accountId })
      .whereIn("item_id", songIds),
    runtime.database.query("service_playback_progress")
      .select("item_id", "play_count", "last_played_at")
      .where({ service_id: context.serviceId, account_id: context.accountId })
      .whereIn("item_id", songIds),
  ]);
  const result = new Map<string, { starredAt: string | null; rating: number; playCount: number; lastPlayedAt: string | null }>();
  songIds.forEach((songId) => result.set(songId, { starredAt: null, rating: 0, playCount: 0, lastPlayedAt: null }));
  preferences.forEach((row) => {
    const itemId = String(row.item_id);
    const current = result.get(itemId);
    if (current) result.set(itemId, { ...current, starredAt: row.starred_at ? String(row.starred_at) : null, rating: Number(row.rating ?? 0) });
  });
  progressRows.forEach((row) => {
    const itemId = String(row.item_id);
    const current = result.get(itemId);
    if (current) result.set(itemId, { ...current, playCount: Number(row.play_count ?? 0), lastPlayedAt: row.last_played_at ? String(row.last_played_at) : null });
  });
  return result;
}

/** 批量读取当前账号的条目收藏和评分。 */
async function loadItemPreferences(
  runtime: ApiRuntime,
  context: NavidromeContext,
  itemIds: string[],
): Promise<Map<string, { starredAt: string | null; rating: number }>> {
  if (itemIds.length === 0) return new Map();
  const rows = await runtime.database.query("service_item_preferences")
    .select("item_id", "starred_at", "rating")
    .where({ service_id: context.serviceId, account_id: context.accountId })
    .whereIn("item_id", itemIds);
  return new Map(rows.map((row) => [String(row.item_id), {
    starredAt: row.starred_at ? String(row.starred_at) : null,
    rating: Number(row.rating ?? 0),
  }]));
}

/** 为艺术家或专辑协议对象附加当前账号的收藏和评分。 */
function attachPreference(mapped: Record<string, unknown>, preference?: { starredAt: string | null; rating: number }): Record<string, unknown> {
  return {
    ...mapped,
    starred: preference?.starredAt ?? undefined,
    userRating: preference?.rating || undefined,
  };
}

/** 为歌曲批量加载第一个可播放文件并完成协议映射。 */
async function mapSongs(runtime: ApiRuntime, context: NavidromeContext, songs: MediaItemRecord[]): Promise<Record<string, unknown>[]> {
  const artistIds = await loadArtistIds(runtime, context, songs.map((song) => song.id));
  const albumIds = await loadAlbumIds(runtime, context, songs.map((song) => song.id));
  const accountStates = await loadSongAccountStates(runtime, context, songs.map((song) => song.id));
  // 关键变量：歌曲没有独立图片时，Subsonic coverArt 应引用所属专辑，供 FlyMusic 播放页和播控中心复用。
  const uniqueAlbumIds = [...new Set(albumIds.values())];
  const albumCoverRows = uniqueAlbumIds.length > 0
    ? await runtime.database.query("media_items")
      .select("id")
      .where({ user_id: context.ownerUserId, library_id: context.libraryId })
      .whereIn("id", uniqueAlbumIds)
      .whereNotNull("poster_url")
      .whereNull("deleted_at")
    : [];
  const albumCoverIds = new Set(albumCoverRows.map((row) => String(row.id)));
  let albumCoverFallbackCount = 0;
  const mappedSongs = await Promise.all(songs.map(async (song) => {
    const files = await runtime.repository.listItemFiles(song.id, context.ownerUserId);
    const file = files.find((candidate) => String(candidate.itemId) === song.id);
    const albumId = albumIds.get(song.id) ?? "";
    const coverArtId = song.posterUrl ? song.id : albumCoverIds.has(albumId) ? albumId : "";
    if (!song.posterUrl && coverArtId) albumCoverFallbackCount += 1;
    return mapSong(song, artistIds.get(song.id), albumId, coverArtId, file, accountStates.get(song.id));
  }));
  if (albumCoverFallbackCount > 0) {
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-flycloud-helper-navidrome-cover",
      事件: "歌曲使用所属专辑封面",
      服务ID: context.serviceId,
      协议账号ID: context.accountId,
      降级歌曲数: albumCoverFallbackCount,
    });
  }
  return mappedSongs;
}

interface SubsonicLyricLine {
  start?: number;
  value: string;
}

interface ParsedSubsonicLyrics {
  synced: boolean;
  offset: number;
  lines: SubsonicLyricLine[];
}

/** 读取音乐条目中已入库的歌词文本。 */
function readStoredLyrics(item: MediaItemRecord): string {
  const lyrics = item.metadata.lyrics;
  if (typeof lyrics === "string") return lyrics.trim();
  if (!lyrics || typeof lyrics !== "object" || Array.isArray(lyrics)) return "";
  const lyricsMetadata = lyrics as Record<string, unknown>;
  // 关键变量：优先返回逐行歌词，没有时再使用纯文本歌词。
  const syncedLyrics = typeof lyricsMetadata.synced === "string" ? lyricsMetadata.synced.trim() : "";
  if (syncedLyrics) return syncedLyrics;
  return typeof lyricsMetadata.plain === "string" ? lyricsMetadata.plain.trim() : "";
}

/** 把 LRC 或纯文本歌词转换为 OpenSubsonic 结构化歌词。 */
function parseStoredLyrics(lyrics: string): ParsedSubsonicLyrics {
  let offset = 0;
  const timedLines: SubsonicLyricLine[] = [];
  const plainLines: SubsonicLyricLine[] = [];
  lyrics.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n").forEach((sourceLine) => {
    const line = sourceLine.trim();
    if (!line) return;
    const offsetMatch = line.match(/^\[offset:([+-]?\d+)\]$/iu);
    if (offsetMatch) {
      offset = Number(offsetMatch[1] ?? 0);
      return;
    }
    // 关键变量：一行可能带多个时间标签，必须为每个时间点生成一条结构化歌词。
    const timestamps = [...line.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/gu)];
    const value = line.replace(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/gu, "").trim();
    if (timestamps.length > 0 && value) {
      timestamps.forEach((match) => {
        const fractionText = match[3] ?? "0";
        const fractionMs = fractionText.length === 1 ? Number(fractionText) * 100
          : fractionText.length === 2 ? Number(fractionText) * 10
            : Number(fractionText.slice(0, 3));
        timedLines.push({ start: Number(match[1]) * 60_000 + Number(match[2]) * 1_000 + fractionMs, value });
      });
      return;
    }
    if (!/^\[[a-z][^\]]*\]$/iu.test(line)) plainLines.push({ value: line });
  });
  if (timedLines.length > 0) {
    timedLines.sort((left, right) => Number(left.start ?? 0) - Number(right.start ?? 0));
    return { synced: true, offset, lines: timedLines };
  }
  return { synced: false, offset: 0, lines: plainLines };
}

/** 直接返回云助手缓存的内嵌音乐封面，避免 Subsonic 客户端处理二次跳转。 */
async function sendLocalMusicCover(
  runtime: ApiRuntime,
  fileName: string,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  if (!/^[a-f0-9]{64}\.jpg$/u.test(fileName)) {
    throw new ApiError(404, "navidrome_cover_not_found", "封面不存在");
  }
  const filePath = path.join(runtime.config.musicArtworkDirectory, fileName);
  try {
    const file = await fs.promises.stat(filePath);
    if (!file.isFile() || file.size <= 0 || file.size > 10 * 1024 * 1024) {
      throw new ApiError(404, "navidrome_cover_not_found", "封面不存在");
    }
    reply.header("Content-Type", "image/jpeg");
    reply.header("Content-Length", file.size);
    reply.header("Cache-Control", "private, max-age=86400");
    return request.method === "HEAD" ? reply.send() : reply.send(fs.createReadStream(filePath));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(404, "navidrome_cover_not_found", "封面不存在");
  }
}

/** 代理返回在线刮削封面，让所有 Navidrome 客户端都只访问已鉴权的 getCoverArt。 */
async function sendRemoteMusicCover(
  runtime: ApiRuntime,
  imageUrl: string,
  itemId: string,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  request.raw.once("aborted", abort);
  reply.raw.once("close", abort);
  let upstreamBody: IncomingMessage | null = null;
  try {
    const upstream = await providerStream(imageUrl, {
      method: request.method,
      headers: {
        Accept: typeof request.headers.accept === "string" ? request.headers.accept : "image/*",
        "User-Agent": runtime.config.musicbrainzUserAgent,
      },
    }, {
      allowInsecureHttp: runtime.config.allowInsecureProviderHttp,
      logConnectionFailure: (fields) => runtime.logBusinessEvent("warn", fields),
    }, controller.signal);
    upstreamBody = upstream.body;
    upstream.body.once("close", () => {
      request.raw.removeListener("aborted", abort);
      reply.raw.removeListener("close", abort);
    });
    copyMediaResponseHeaders(reply, upstream.headers);
    if (!upstream.headers["content-type"]) reply.header("Content-Type", "image/jpeg");
    reply.header("Content-Disposition", "inline");
    reply.status(upstream.statusCode);
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-flycloud-helper-navidrome-cover",
      事件: "直接代理返回协议封面",
      媒体条目ID: itemId,
      响应状态码: upstream.statusCode,
    });
    return reply.send(upstream.body);
  } catch (error) {
    request.raw.removeListener("aborted", abort);
    reply.raw.removeListener("close", abort);
    upstreamBody?.destroy();
    throw error;
  }
}

/** 按封面存储类型直接输出图片内容，不向 FlyMusic 暴露二次跳转。 */
async function sendNavidromeCoverArt(
  runtime: ApiRuntime,
  item: MediaItemRecord,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const posterUrl = item.posterUrl ?? "";
  const localArtworkMatch = posterUrl.match(/^\/api\/v1\/music-artwork\/([a-f0-9]{64}\.jpg)$/u);
  if (localArtworkMatch?.[1]) {
    return sendLocalMusicCover(runtime, localArtworkMatch[1], request, reply);
  }
  if (/^https?:\/\//iu.test(posterUrl)) {
    return sendRemoteMusicCover(runtime, posterUrl, item.id, request, reply);
  }
  throw new ApiError(404, "navidrome_cover_not_found", "封面不存在");
}

/** 读取当前音乐库指定类型的目录条目。 */
async function listMusicItems(
  runtime: ApiRuntime,
  context: NavidromeContext,
  itemType: "music.artist" | "music.album" | "music.track",
  options: { search?: string; sort?: "created_desc" | "updated_desc" | "title_asc"; limit?: number; offset?: number } = {},
): Promise<MediaItemRecord[]> {
  return (await runtime.repository.listCatalogItems({
    userId: context.ownerUserId,
    libraryId: context.libraryId,
    mediaType: "music",
    itemType,
    search: options.search,
    sort: options.sort ?? "title_asc",
    limit: options.limit ?? 5000,
    offset: options.offset ?? 0,
  })).items;
}

/** 校验账号操作使用的条目确实属于当前音乐库。 */
async function requireMusicItem(runtime: ApiRuntime, context: NavidromeContext, itemId: string): Promise<MediaItemRecord> {
  const item = await runtime.repository.getCatalogItem(itemId, context.ownerUserId);
  if (item.libraryId !== context.libraryId || !["music.artist", "music.album", "music.track"].includes(item.itemType)) {
    throw new ApiError(404, "navidrome_item_not_found", "音乐条目不存在");
  }
  return item;
}

/** 按当前账号保存或取消收藏，其他协议账号的数据不受影响。 */
async function updateStarredItems(runtime: ApiRuntime, context: NavidromeContext, itemIds: string[], starred: boolean): Promise<void> {
  const items = await Promise.all(itemIds.map((itemId) => requireMusicItem(runtime, context, itemId)));
  const now = new Date().toISOString();
  await runtime.database.query.transaction(async (transaction) => {
    for (const item of items) {
      const existing = await transaction("service_item_preferences")
        .where({ service_id: context.serviceId, account_id: context.accountId, item_id: item.id })
        .first();
      if (existing) {
        await transaction("service_item_preferences").where({ id: existing.id }).update({
          starred_at: starred ? now : null,
          updated_at: now,
        });
      } else if (starred) {
        await transaction("service_item_preferences").insert({
          id: randomUUID(),
          service_id: context.serviceId,
          account_id: context.accountId,
          item_id: item.id,
          starred_at: now,
          rating: 0,
          updated_at: now,
        });
      }
    }
  });
}

/** 按当前账号保存条目评分，评分为 0 时只清除评分。 */
async function updateItemRating(runtime: ApiRuntime, context: NavidromeContext, itemId: string, rating: number): Promise<void> {
  const item = await requireMusicItem(runtime, context, itemId);
  if (!Number.isInteger(rating) || rating < 0 || rating > 5) throw new ApiError(422, "navidrome_rating_invalid", "评分必须是 0 至 5 的整数");
  const now = new Date().toISOString();
  const existing = await runtime.database.query("service_item_preferences")
    .where({ service_id: context.serviceId, account_id: context.accountId, item_id: item.id })
    .first();
  if (existing) {
    await runtime.database.query("service_item_preferences").where({ id: existing.id }).update({ rating, updated_at: now });
  } else {
    await runtime.database.query("service_item_preferences").insert({
      id: randomUUID(), service_id: context.serviceId, account_id: context.accountId, item_id: item.id,
      starred_at: null, rating, updated_at: now,
    });
  }
}

/** 保存当前账号的正在播放或播放完成上报。 */
async function recordScrobble(runtime: ApiRuntime, context: NavidromeContext, songId: string, submission: boolean): Promise<void> {
  const song = await requireMusicItem(runtime, context, songId);
  if (song.itemType !== "music.track") throw new ApiError(422, "navidrome_scrobble_song_required", "播放上报只能使用歌曲 ID");
  const now = new Date().toISOString();
  await runtime.database.query.transaction(async (transaction) => {
    if (!submission) {
      await transaction("service_playback_sessions")
        .where({ service_id: context.serviceId, account_id: context.accountId, item_id: song.id, status: "active" })
        .update({ status: "stopped", stopped_at: now, updated_at: now });
      await transaction("service_playback_sessions").insert({
        id: randomUUID(), service_id: context.serviceId, account_id: context.accountId, item_id: song.id,
        media_source_id: null, status: "active", position_ticks: 0, paused: 0,
        started_at: now, updated_at: now, stopped_at: null,
      });
      return;
    }

    const progress = await transaction("service_playback_progress")
      .where({ service_id: context.serviceId, account_id: context.accountId, item_id: song.id })
      .first();
    if (progress) {
      await transaction("service_playback_progress").where({ id: progress.id }).update({
        position_ticks: 0,
        played: 1,
        play_count: Number(progress.play_count ?? 0) + 1,
        last_played_at: now,
        updated_at: now,
      });
    } else {
      await transaction("service_playback_progress").insert({
        id: randomUUID(), service_id: context.serviceId, account_id: context.accountId, item_id: song.id,
        media_source_id: null, position_ticks: 0, played: 1, hidden_from_resume: 0,
        play_count: 1, last_played_at: now, updated_at: now,
      });
    }
    const activeSession = await transaction("service_playback_sessions")
      .where({ service_id: context.serviceId, account_id: context.accountId, item_id: song.id, status: "active" })
      .orderBy("started_at", "desc")
      .first();
    if (activeSession) {
      await transaction("service_playback_sessions").where({ id: activeSession.id }).update({ status: "stopped", stopped_at: now, updated_at: now });
    }
    await transaction("service_playback_history").insert({
      id: randomUUID(), service_id: context.serviceId, account_id: context.accountId, item_id: song.id,
      play_session_id: randomUUID(), position_ticks: 0, completed: 1,
      started_at: activeSession?.started_at ?? now, stopped_at: now,
    });
  });
}

/** 读取当前账号的收藏条目并按收藏时间倒序返回。 */
async function listStarredItems(runtime: ApiRuntime, context: NavidromeContext): Promise<Array<{ item: MediaItemRecord; starredAt: string }>> {
  const rows = await runtime.database.query("service_item_preferences")
    .select("item_id", "starred_at")
    .where({ service_id: context.serviceId, account_id: context.accountId })
    .whereNotNull("starred_at")
    .orderBy("starred_at", "desc")
    .limit(5000);
  const items = await Promise.all(rows.map(async (row) => ({
    item: await runtime.repository.getCatalogItem(String(row.item_id), context.ownerUserId),
    starredAt: String(row.starred_at),
  })));
  return items.filter(({ item }) => item.libraryId === context.libraryId);
}

/** 按当前账号最近播放的歌曲反查专辑，避免不同账号共享“最近播放”。 */
async function listRecentlyPlayedAlbums(
  runtime: ApiRuntime,
  context: NavidromeContext,
  offset: number,
  limit: number,
): Promise<MediaItemRecord[]> {
  const rows = await runtime.database.query("service_playback_history as h")
    .join("media_relations as r", function joinAlbumRelation() {
      this.on("r.child_item_id", "=", "h.item_id").andOnVal("r.relation_type", "=", "album_track");
    })
    .select("r.parent_item_id", "h.stopped_at")
    .where({ "h.service_id": context.serviceId, "h.account_id": context.accountId, "r.library_id": context.libraryId })
    .orderBy("h.stopped_at", "desc")
    .limit(Math.min(5000, offset + limit + 500));
  const albumIds: string[] = [];
  const seenAlbumIds = new Set<string>();
  for (const row of rows) {
    const albumId = String(row.parent_item_id);
    if (seenAlbumIds.has(albumId)) continue;
    seenAlbumIds.add(albumId);
    albumIds.push(albumId);
  }
  const selectedAlbumIds = albumIds.slice(offset, offset + limit);
  return Promise.all(selectedAlbumIds.map((albumId) => runtime.repository.getCatalogItem(albumId, context.ownerUserId)));
}

/** 读取当前账号的常听、收藏或高评分专辑。 */
async function listAccountSelectedAlbums(
  runtime: ApiRuntime,
  context: NavidromeContext,
  type: "frequent" | "starred" | "highest",
  offset: number,
  limit: number,
): Promise<MediaItemRecord[]> {
  if (type === "starred") {
    return (await listStarredItems(runtime, context))
      .map(({ item }) => item)
      .filter((item) => item.itemType === "music.album")
      .slice(offset, offset + limit);
  }
  if (type === "highest") {
    const preferences = await runtime.database.query("service_item_preferences")
      .select("item_id")
      .where({ service_id: context.serviceId, account_id: context.accountId })
      .where("rating", ">", 0)
      .orderBy("rating", "desc")
      .orderBy("updated_at", "desc")
      .limit(Math.min(5000, offset + limit + 500));
    const items = await Promise.all(preferences.map((row) => runtime.repository.getCatalogItem(String(row.item_id), context.ownerUserId)));
    return items.filter((item) => item.libraryId === context.libraryId && item.itemType === "music.album").slice(offset, offset + limit);
  }
  const progressRows = await runtime.database.query("service_playback_progress")
    .select("item_id", "play_count")
    .where({ service_id: context.serviceId, account_id: context.accountId })
    .where("play_count", ">", 0)
    .limit(5000);
  const songIds = progressRows.map((row) => String(row.item_id));
  const albumIds = await loadAlbumIds(runtime, context, songIds);
  const playCounts = new Map<string, number>();
  progressRows.forEach((row) => {
    const albumId = albumIds.get(String(row.item_id));
    if (albumId) playCounts.set(albumId, (playCounts.get(albumId) ?? 0) + Number(row.play_count ?? 0));
  });
  const selectedAlbumIds = [...playCounts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(offset, offset + limit)
    .map(([albumId]) => albumId);
  return Promise.all(selectedAlbumIds.map((albumId) => runtime.repository.getCatalogItem(albumId, context.ownerUserId)));
}

/** 校验并读取当前账号拥有的播放列表。 */
async function requirePlaylist(runtime: ApiRuntime, context: NavidromeContext, playlistId: string): Promise<Record<string, unknown>> {
  const playlist = await runtime.database.query("service_music_playlists")
    .where({ id: playlistId, service_id: context.serviceId, account_id: context.accountId })
    .first();
  if (!playlist) throw new ApiError(404, "navidrome_playlist_not_found", "播放列表不存在");
  return playlist;
}

/** 按播放列表顺序读取当前音乐库中的歌曲。 */
async function listPlaylistSongs(runtime: ApiRuntime, context: NavidromeContext, playlistId: string): Promise<MediaItemRecord[]> {
  const rows = await runtime.database.query("service_music_playlist_items")
    .select("item_id")
    .where({ playlist_id: playlistId })
    .orderBy("sort_order", "asc");
  const songs = await Promise.all(rows.map((row) => runtime.repository.getCatalogItem(String(row.item_id), context.ownerUserId)));
  return songs.filter((song) => song.libraryId === context.libraryId && song.itemType === "music.track");
}

/** 映射当前账号的 Subsonic 播放列表摘要。 */
function mapPlaylist(playlist: Record<string, unknown>, songs: MediaItemRecord[], username: string): Record<string, unknown> {
  const duration = songs.reduce((total, song) => total + Math.max(0, Math.round(Number(song.metadata.durationMs ?? 0) / 1000)), 0);
  return {
    id: String(playlist.id),
    name: String(playlist.name),
    comment: playlist.comment ? String(playlist.comment) : undefined,
    owner: username,
    public: Number(playlist.is_public ?? 0) === 1,
    songCount: songs.length,
    duration,
    created: String(playlist.created_at),
    changed: String(playlist.updated_at),
    coverArt: songs.find((song) => song.posterUrl)?.id,
  };
}

/** 校验播放列表名称，保留用户输入文字但拒绝空名称。 */
function validatePlaylistName(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || Array.from(value.trim()).length > 255) {
    throw new ApiError(422, "navidrome_playlist_name_invalid", "播放列表名称长度必须为 1 至 255 个字符");
  }
  return value.trim();
}

/** 创建当前账号独享的播放列表。 */
async function createPlaylist(runtime: ApiRuntime, context: NavidromeContext, name: unknown, songIds: string[]): Promise<Record<string, unknown>> {
  const playlistName = validatePlaylistName(name);
  const songs = await Promise.all(songIds.map(async (songId) => {
    const item = await requireMusicItem(runtime, context, songId);
    if (item.itemType !== "music.track") throw new ApiError(422, "navidrome_playlist_song_required", "播放列表只能加入歌曲");
    return item;
  }));
  const playlistId = randomUUID();
  const now = new Date().toISOString();
  await runtime.database.query.transaction(async (transaction) => {
    await transaction("service_music_playlists").insert({
      id: playlistId, service_id: context.serviceId, account_id: context.accountId,
      name: playlistName, comment: null, is_public: 0, created_at: now, updated_at: now,
    });
    if (songs.length > 0) {
      await transaction("service_music_playlist_items").insert(songs.map((song, index) => ({
        id: randomUUID(), playlist_id: playlistId, item_id: song.id, sort_order: index, created_at: now,
      })));
    }
  });
  return mapPlaylist(await requirePlaylist(runtime, context, playlistId), songs, context.accountUsername);
}

/** 修改当前账号播放列表及歌曲顺序。 */
async function updatePlaylist(
  runtime: ApiRuntime,
  context: NavidromeContext,
  playlistId: string,
  input: { name?: string; comment?: string; isPublic?: boolean; removeIndexes: number[]; addSongIds: string[] },
): Promise<void> {
  const playlist = await requirePlaylist(runtime, context, playlistId);
  const existingRows = await runtime.database.query("service_music_playlist_items")
    .select("item_id")
    .where({ playlist_id: playlistId })
    .orderBy("sort_order", "asc");
  const itemIds = existingRows.map((row) => String(row.item_id));
  [...new Set(input.removeIndexes)].sort((left, right) => right - left).forEach((index) => {
    if (Number.isInteger(index) && index >= 0 && index < itemIds.length) itemIds.splice(index, 1);
  });
  for (const songId of input.addSongIds) {
    const song = await requireMusicItem(runtime, context, songId);
    if (song.itemType !== "music.track") throw new ApiError(422, "navidrome_playlist_song_required", "播放列表只能加入歌曲");
    itemIds.push(song.id);
  }
  const now = new Date().toISOString();
  const patch: Record<string, unknown> = { updated_at: now };
  if (input.name !== undefined) patch.name = validatePlaylistName(input.name);
  if (input.comment !== undefined) patch.comment = input.comment.slice(0, 5000);
  if (input.isPublic !== undefined) patch.is_public = input.isPublic ? 1 : 0;
  await runtime.database.query.transaction(async (transaction) => {
    await transaction("service_music_playlists").where({ id: playlist.id }).update(patch);
    await transaction("service_music_playlist_items").where({ playlist_id: playlistId }).delete();
    if (itemIds.length > 0) {
      await transaction("service_music_playlist_items").insert(itemIds.map((itemId, index) => ({
        id: randomUUID(), playlist_id: playlistId, item_id: itemId, sort_order: index, created_at: now,
      })));
    }
  });
}

/** 发送 Navidrome 原音频流，不提供转码。 */
async function streamSong(runtime: ApiRuntime, context: NavidromeContext, itemId: string, request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const item = await runtime.repository.getCatalogItem(itemId, context.ownerUserId);
  if (item.libraryId !== context.libraryId || item.itemType !== "music.track") throw new ApiError(404, "navidrome_song_not_found", "歌曲不存在");
  const files = await runtime.repository.listItemFiles(item.id, context.ownerUserId);
  const file = files.find((candidate) => String(candidate.itemId) === item.id);
  if (!file) throw new ApiError(404, "navidrome_song_file_not_found", "歌曲文件不存在");
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.raw.once("aborted", abort);
  reply.raw.once("close", abort);
  let upstreamBody: IncomingMessage | null = null;
  try {
    const locator = file.playbackLocator && typeof file.playbackLocator === "object" ? file.playbackLocator as Record<string, unknown> : {};
    const access = await resolveRelayAccess(runtime, context.relayLibrary, context.ownerUserId, locator, controller.signal);
    const upstream = await providerStream(access.url, {
      method: request.method,
      headers: buildUpstreamHeaders(request, access.headers),
    }, {
      allowInsecureHttp: runtime.config.allowInsecureProviderHttp,
      logConnectionFailure: (fields) => runtime.logBusinessEvent("warn", fields),
    }, controller.signal);
    upstreamBody = upstream.body;
    upstream.body.once("close", () => {
      request.raw.removeListener("aborted", abort);
      reply.raw.removeListener("close", abort);
    });
    copyMediaResponseHeaders(reply, upstream.headers);
    reply.header("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(String(file.name ?? item.title))}`);
    reply.status(upstream.statusCode);
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-flycloud-helper-navidrome",
      事件: "Navidrome歌曲流连接建立",
      服务ID: context.serviceId,
      服务访问账号ID: context.accountId,
      歌曲ID: item.id,
      是否Range请求: Boolean(request.headers.range),
      上游状态码: upstream.statusCode,
    });
    return reply.send(upstream.body);
  } catch (error) {
    if (!upstreamBody) {
      request.raw.removeListener("aborted", abort);
      reply.raw.removeListener("close", abort);
    }
    throw error;
  }
}

/** 注册公开的 Navidrome/Subsonic 只读音乐协议。 */
export async function registerNavidromeRoutes(server: FastifyInstance, runtime: ApiRuntime): Promise<void> {
  if (!server.hasContentTypeParser("application/x-www-form-urlencoded")) {
    server.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, body, done) => {
      // 关键变量：Subsonic 客户端可能用表单 POST，转换后与查询参数走同一处理流程。
      const formValues: Record<string, string | string[]> = {};
      for (const [key, value] of new URLSearchParams(String(body))) {
        const existing = formValues[key];
        formValues[key] = existing === undefined ? value : Array.isArray(existing) ? [...existing, value] : [existing, value];
      }
      done(null, formValues);
    });
  }
  server.route<{ Params: { pathSuffix: string; method: string }; Querystring: Record<string, unknown>; Body: Record<string, unknown> }>({
    method: ["GET", "HEAD", "POST"],
    url: "/n/:pathSuffix/rest/:method",
    logLevel: "silent",
    handler: async (request, reply) => {
      const query = {
        ...(request.query ?? {}),
        ...(request.body && typeof request.body === "object" ? request.body : {}),
      } as Record<string, unknown>;
      const requestedMethod = request.params.method;
      const method = requestedMethod.replace(/\.(?:view|json)$/iu, "");
      // 关键变量：部分客户端使用 .json 后缀代替 f=json，服务端应返回同样的 JSON 信封。
      if (/\.json$/iu.test(requestedMethod) && query.f === undefined) query.f = "json";
      try {
        const context = await authenticateRequest(runtime, request.params.pathSuffix, query);
        if (method === "stream" || method === "download") {
          const itemId = readQueryString(query.id);
          if (!itemId) throw new ApiError(422, "navidrome_song_id_required", "缺少歌曲 ID");
          return await streamSong(runtime, context, itemId, request, reply);
        }
        if (method === "getCoverArt") {
          const itemId = readQueryString(query.id);
          const item = await runtime.repository.getCatalogItem(itemId, context.ownerUserId);
          if (item.libraryId !== context.libraryId || !item.posterUrl) throw new ApiError(404, "navidrome_cover_not_found", "封面不存在");
          return sendNavidromeCoverArt(runtime, item, request, reply);
        }
        if (method === "getLyricsBySongId") {
          const song = await requireMusicItem(runtime, context, readQueryString(query.id));
          if (song.itemType !== "music.track") throw new ApiError(404, "navidrome_song_not_found", "歌曲不存在");
          const storedLyrics = readStoredLyrics(song);
          const parsedLyrics = parseStoredLyrics(storedLyrics);
          runtime.logBusinessEvent("info", {
            日志关键字: "codex-flycloud-helper-navidrome-lyrics",
            事件: "返回OpenSubsonic歌词",
            服务ID: context.serviceId,
            协议账号ID: context.accountId,
            歌曲ID: song.id,
            是否有歌词: storedLyrics.length > 0,
            是否逐行: parsedLyrics.synced,
            歌词行数: parsedLyrics.lines.length,
          });
          return sendSubsonicResponse(reply, query, {
            lyricsList: {
              structuredLyrics: storedLyrics ? [{
                displayArtist: String(song.metadata.artist ?? song.subtitle ?? ""),
                displayTitle: song.title,
                lang: String(song.metadata.language ?? "und"),
                offset: parsedLyrics.offset,
                synced: parsedLyrics.synced,
                line: parsedLyrics.lines,
              }] : [],
            },
          });
        }
        if (method === "getLyrics") {
          const title = readQueryString(query.title).trim();
          const artist = readQueryString(query.artist).trim();
          const candidates = title
            ? await listMusicItems(runtime, context, "music.track", { search: title, limit: 100 })
            : [];
          // 关键变量：旧版接口没有歌曲 ID，优先使用标题和艺术家同时精确命中的条目。
          const exactSong = candidates.find((candidate) => candidate.title.trim().toLocaleLowerCase("en-US") === title.toLocaleLowerCase("en-US")
            && (!artist || String(candidate.metadata.artist ?? candidate.subtitle ?? "").trim().toLocaleLowerCase("en-US") === artist.toLocaleLowerCase("en-US")));
          const song = exactSong ?? candidates.find((candidate) => candidate.title.trim().toLocaleLowerCase("en-US") === title.toLocaleLowerCase("en-US"))
            ?? candidates[0];
          const storedLyrics = song ? readStoredLyrics(song) : "";
          runtime.logBusinessEvent("info", {
            日志关键字: "codex-flycloud-helper-navidrome-lyrics",
            事件: "返回Subsonic旧版歌词",
            服务ID: context.serviceId,
            协议账号ID: context.accountId,
            请求歌曲: title,
            请求艺术家: artist,
            是否命中: Boolean(song),
            是否有歌词: storedLyrics.length > 0,
          });
          return sendSubsonicResponse(reply, query, {
            lyrics: {
              artist: song ? String(song.metadata.artist ?? song.subtitle ?? artist) : artist,
              title: song?.title ?? title,
              value: storedLyrics,
              _text: storedLyrics,
            },
          });
        }
        if (method === "ping") return sendSubsonicResponse(reply, query, {});
        if (method === "getLicense") return sendSubsonicResponse(reply, query, { license: { valid: true } });
        if (method === "getMusicFolders") {
          return sendSubsonicResponse(reply, query, { musicFolders: { musicFolder: [{ id: context.libraryId, name: context.libraryName }] } });
        }
        if (method === "getArtists" || method === "getIndexes") {
          const artists = await listMusicItems(runtime, context, "music.artist");
          const albumCounts = await loadRelationCounts(runtime, context, artists.map((artist) => artist.id), "artist_album");
          const preferences = await loadItemPreferences(runtime, context, artists.map((artist) => artist.id));
          const mappedArtists = artists.map((artist) => attachPreference(mapArtist(artist, albumCounts.get(artist.id) ?? 0), preferences.get(artist.id)));
          const indexes = new Map<string, Record<string, unknown>[]>();
          mappedArtists.forEach((artist) => {
            const name = String(artist.name ?? "");
            const indexName = /^[A-Za-z]/u.test(name) ? name[0]!.toLocaleUpperCase("en-US") : "#";
            indexes.set(indexName, [...(indexes.get(indexName) ?? []), artist]);
          });
          const index = [...indexes.entries()].map(([name, artist]) => ({ name, artist }));
          const container = { ignoredArticles: "The El La Los Las Le Les", index };
          return sendSubsonicResponse(reply, query, method === "getArtists" ? { artists: container } : { indexes: { ...container, lastModified: Date.now() } });
        }
        if (method === "getArtist") {
          const artist = await runtime.repository.getCatalogItem(readQueryString(query.id), context.ownerUserId);
          if (artist.libraryId !== context.libraryId || artist.itemType !== "music.artist") throw new ApiError(404, "navidrome_artist_not_found", "艺术家不存在");
          const children = await runtime.repository.listCatalogChildren(artist.id, context.ownerUserId);
          const albums = children.filter((item) => item.itemType === "music.album");
          const songCounts = await loadRelationCounts(runtime, context, albums.map((album) => album.id), "album_track");
          const preferences = await loadItemPreferences(runtime, context, [artist.id, ...albums.map((album) => album.id)]);
          return sendSubsonicResponse(reply, query, {
            artist: {
              ...attachPreference(mapArtist(artist, albums.length), preferences.get(artist.id)),
              album: albums.map((album) => attachPreference(mapAlbum(album, artist.id, songCounts.get(album.id) ?? 0), preferences.get(album.id))),
            },
          });
        }
        if (method === "getAlbum") {
          const album = await runtime.repository.getCatalogItem(readQueryString(query.id), context.ownerUserId);
          if (album.libraryId !== context.libraryId || album.itemType !== "music.album") throw new ApiError(404, "navidrome_album_not_found", "专辑不存在");
          const songs = (await runtime.repository.listCatalogChildren(album.id, context.ownerUserId)).filter((item) => item.itemType === "music.track");
          const artistIds = await loadArtistIds(runtime, context, [album.id]);
          const preference = (await loadItemPreferences(runtime, context, [album.id])).get(album.id);
          const mappedSongs = await mapSongs(runtime, context, songs);
          const duration = mappedSongs.reduce((total, song) => total + Number(song.duration ?? 0), 0);
          return sendSubsonicResponse(reply, query, { album: { ...attachPreference(mapAlbum(album, artistIds.get(album.id), songs.length, duration), preference), song: mappedSongs } });
        }
        if (method === "getMusicDirectory") {
          const item = await runtime.repository.getCatalogItem(readQueryString(query.id), context.ownerUserId);
          if (item.libraryId !== context.libraryId || !["music.artist", "music.album"].includes(item.itemType)) {
            throw new ApiError(404, "navidrome_directory_not_found", "音乐目录不存在");
          }
          const children = await runtime.repository.listCatalogChildren(item.id, context.ownerUserId);
          if (item.itemType === "music.artist") {
            const albums = children.filter((child) => child.itemType === "music.album");
            const counts = await loadRelationCounts(runtime, context, albums.map((album) => album.id), "album_track");
            const preferences = await loadItemPreferences(runtime, context, albums.map((album) => album.id));
            return sendSubsonicResponse(reply, query, {
              directory: { id: item.id, name: item.title, child: albums.map((album) => attachPreference(mapAlbum(album, item.id, counts.get(album.id) ?? 0), preferences.get(album.id))) },
            });
          }
          const songs = children.filter((child) => child.itemType === "music.track");
          return sendSubsonicResponse(reply, query, {
            directory: { id: item.id, parent: (await loadArtistIds(runtime, context, [item.id])).get(item.id), name: item.title, child: await mapSongs(runtime, context, songs) },
          });
        }
        if (method === "getSong") {
          const song = await runtime.repository.getCatalogItem(readQueryString(query.id), context.ownerUserId);
          if (song.libraryId !== context.libraryId || song.itemType !== "music.track") throw new ApiError(404, "navidrome_song_not_found", "歌曲不存在");
          return sendSubsonicResponse(reply, query, { song: (await mapSongs(runtime, context, [song]))[0] });
        }
        if (method === "getAlbumList2" || method === "getAlbumList") {
          const type = readQueryString(query.type);
          const sort = ["alphabeticalByName", "alphabeticalByArtist"].includes(type) ? "title_asc" : type === "recent" ? "updated_desc" : "created_desc";
          const size = readQueryInteger(query, "size", 10, 500);
          const offset = readQueryInteger(query, "offset", 0, 100_000);
          const filtersLocally = ["random", "byGenre", "byYear"].includes(type);
          let albums = type === "recent"
            ? await listRecentlyPlayedAlbums(runtime, context, offset, size)
            : ["frequent", "starred", "highest"].includes(type)
              ? await listAccountSelectedAlbums(runtime, context, type as "frequent" | "starred" | "highest", offset, size)
              : await listMusicItems(runtime, context, "music.album", {
              sort,
              limit: filtersLocally ? 5000 : size,
              offset: filtersLocally ? 0 : offset,
              });
          if (type === "byGenre") {
            const genre = readQueryString(query.genre);
            albums = albums.filter((album) => Array.isArray(album.metadata.genres) && album.metadata.genres.map(String).includes(genre));
          }
          if (type === "byYear") {
            const fromYear = Number(readQueryString(query.fromYear));
            const toYear = Number(readQueryString(query.toYear));
            const normalizedFromYear = Number.isInteger(fromYear) ? fromYear : 0;
            const normalizedToYear = Number.isInteger(toYear) ? toYear : 9999;
            const lowerYear = Math.min(normalizedFromYear, normalizedToYear);
            const upperYear = Math.max(normalizedFromYear, normalizedToYear);
            albums = albums.filter((album) => album.year !== null && album.year >= lowerYear && album.year <= upperYear);
          }
          if (type === "random") albums = albums.sort(() => Math.random() - 0.5);
          if (filtersLocally) albums = albums.slice(offset, offset + size);
          const artistIds = await loadArtistIds(runtime, context, albums.map((album) => album.id));
          const counts = await loadRelationCounts(runtime, context, albums.map((album) => album.id), "album_track");
          const preferences = await loadItemPreferences(runtime, context, albums.map((album) => album.id));
          const key = method === "getAlbumList2" ? "albumList2" : "albumList";
          return sendSubsonicResponse(reply, query, { [key]: { album: albums.map((album) => attachPreference(mapAlbum(album, artistIds.get(album.id), counts.get(album.id) ?? 0), preferences.get(album.id))) } });
        }
        if (method === "search3" || method === "search2") {
          const search = readQueryString(query.query).slice(0, 200);
          const artistCount = readQueryInteger(query, "artistCount", 20, 200);
          const albumCount = readQueryInteger(query, "albumCount", 20, 200);
          const songCount = readQueryInteger(query, "songCount", 20, 500);
          const artistOffset = readQueryInteger(query, "artistOffset", 0, 100_000);
          const albumOffset = readQueryInteger(query, "albumOffset", 0, 100_000);
          const songOffset = readQueryInteger(query, "songOffset", 0, 100_000);
          const [artists, albums, songs] = await Promise.all([
            listMusicItems(runtime, context, "music.artist", { search, limit: artistCount, offset: artistOffset }),
            listMusicItems(runtime, context, "music.album", { search, limit: albumCount, offset: albumOffset }),
            listMusicItems(runtime, context, "music.track", { search, limit: songCount, offset: songOffset }),
          ]);
          const albumArtistIds = await loadArtistIds(runtime, context, albums.map((album) => album.id));
          const preferences = await loadItemPreferences(runtime, context, [...artists.map((artist) => artist.id), ...albums.map((album) => album.id)]);
          const mappedSongs = await mapSongs(runtime, context, songs);
          const key = method === "search3" ? "searchResult3" : "searchResult2";
          return sendSubsonicResponse(reply, query, { [key]: {
            artist: artists.map((artist) => attachPreference(mapArtist(artist), preferences.get(artist.id))),
            album: albums.map((album) => attachPreference(mapAlbum(album, albumArtistIds.get(album.id)), preferences.get(album.id))),
            song: mappedSongs,
          } });
        }
        if (method === "getRandomSongs") {
          const size = readQueryInteger(query, "size", 10, 500);
          const songs = (await listMusicItems(runtime, context, "music.track", { limit: Math.min(2000, size * 4), sort: "updated_desc" }))
            .sort(() => Math.random() - 0.5)
            .slice(0, size);
          return sendSubsonicResponse(reply, query, { randomSongs: { song: await mapSongs(runtime, context, songs) } });
        }
        if (method === "getGenres") {
          const songs = await listMusicItems(runtime, context, "music.track");
          const counts = new Map<string, number>();
          songs.forEach((song) => {
            const genres = Array.isArray(song.metadata.genres) ? song.metadata.genres.map(String).filter(Boolean) : [];
            genres.forEach((genre) => counts.set(genre, (counts.get(genre) ?? 0) + 1));
          });
          return sendSubsonicResponse(reply, query, { genres: { genre: [...counts.entries()].map(([value, songCount]) => ({ value, _text: value, songCount, albumCount: 0 })) } });
        }
        if (method === "getSongsByGenre") {
          const genre = readQueryString(query.genre);
          const count = readQueryInteger(query, "count", 10, 500);
          const offset = readQueryInteger(query, "offset", 0, 100_000);
          const songs = (await listMusicItems(runtime, context, "music.track"))
            .filter((song) => Array.isArray(song.metadata.genres) && song.metadata.genres.map(String).includes(genre))
            .slice(offset, offset + count);
          return sendSubsonicResponse(reply, query, { songsByGenre: { song: await mapSongs(runtime, context, songs) } });
        }
        if (["getArtistInfo", "getArtistInfo2"].includes(method)) {
          const artist = await runtime.repository.getCatalogItem(readQueryString(query.id), context.ownerUserId);
          if (artist.libraryId !== context.libraryId || artist.itemType !== "music.artist") throw new ApiError(404, "navidrome_artist_not_found", "艺术家不存在");
          const artistInfo = {
            biography: String(artist.overview ?? ""),
            musicBrainzId: String(artist.metadata.musicBrainzArtistId ?? "") || undefined,
            smallImageUrl: artist.posterUrl ?? undefined,
            mediumImageUrl: artist.posterUrl ?? undefined,
            largeImageUrl: artist.posterUrl ?? undefined,
            similarArtist: [],
          };
          return sendSubsonicResponse(reply, query, { [method === "getArtistInfo2" ? "artistInfo2" : "artistInfo"]: artistInfo });
        }
        if (["getAlbumInfo", "getAlbumInfo2"].includes(method)) {
          const album = await runtime.repository.getCatalogItem(readQueryString(query.id), context.ownerUserId);
          if (album.libraryId !== context.libraryId || album.itemType !== "music.album") throw new ApiError(404, "navidrome_album_not_found", "专辑不存在");
          const albumInfo = {
            notes: String(album.overview ?? ""),
            musicBrainzId: String(album.metadata.musicBrainzReleaseId ?? "") || undefined,
            smallImageUrl: album.posterUrl ?? undefined,
            mediumImageUrl: album.posterUrl ?? undefined,
            largeImageUrl: album.posterUrl ?? undefined,
          };
          return sendSubsonicResponse(reply, query, { [method === "getAlbumInfo2" ? "albumInfo2" : "albumInfo"]: albumInfo });
        }
        if (method === "getUser") {
          return sendSubsonicResponse(reply, query, { user: {
            username: context.accountUsername,
            scrobblingEnabled: true,
            downloadRole: true,
            streamRole: true,
            jukeboxRole: false,
            shareRole: false,
            videoConversionRole: false,
            folder: [context.libraryId],
          } });
        }
        if (method === "getNowPlaying") {
          const activeSince = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
          const sessions = await runtime.database.query("service_playback_sessions")
            .select("item_id", "started_at")
            .where({ service_id: context.serviceId, account_id: context.accountId, status: "active" })
            .where("updated_at", ">=", activeSince)
            .orderBy("updated_at", "desc")
            .limit(100);
          const songs = (await Promise.all(sessions.map((session) => runtime.repository.getCatalogItem(String(session.item_id), context.ownerUserId))))
            .filter((item) => item.libraryId === context.libraryId && item.itemType === "music.track");
          const mappedSongs = await mapSongs(runtime, context, songs);
          return sendSubsonicResponse(reply, query, { nowPlaying: { entry: mappedSongs.map((song, index) => ({
            ...song,
            username: context.accountUsername,
            minutesAgo: Math.max(0, Math.floor((Date.now() - Date.parse(String(sessions[index]?.started_at ?? new Date().toISOString()))) / 60000)),
            playerName: "Navidrome",
          })) } });
        }
        if (method === "getInternetRadioStations") return sendSubsonicResponse(reply, query, { internetRadioStations: { internetRadioStation: [] } });
        if (method === "getBookmarks") return sendSubsonicResponse(reply, query, { bookmarks: { bookmark: [] } });
        if (method === "getShares") return sendSubsonicResponse(reply, query, { shares: { share: [] } });
        if (method === "getStarred" || method === "getStarred2") {
          const starredItems = await listStarredItems(runtime, context);
          const artists = starredItems.filter(({ item }) => item.itemType === "music.artist");
          const albums = starredItems.filter(({ item }) => item.itemType === "music.album");
          const songs = starredItems.filter(({ item }) => item.itemType === "music.track");
          const albumArtistIds = await loadArtistIds(runtime, context, albums.map(({ item }) => item.id));
          const albumCounts = await loadRelationCounts(runtime, context, albums.map(({ item }) => item.id), "album_track");
          const mappedSongs = await mapSongs(runtime, context, songs.map(({ item }) => item));
          const songStarredAt = new Map(songs.map(({ item, starredAt }) => [item.id, starredAt]));
          return sendSubsonicResponse(reply, query, { [method === "getStarred2" ? "starred2" : "starred"]: {
            artist: artists.map(({ item, starredAt }) => ({ ...mapArtist(item), starred: starredAt })),
            album: albums.map(({ item, starredAt }) => ({ ...mapAlbum(item, albumArtistIds.get(item.id), albumCounts.get(item.id) ?? 0), starred: starredAt })),
            song: mappedSongs.map((song) => ({ ...song, starred: songStarredAt.get(String(song.id)) })),
          } });
        }
        if (method === "getPlaylists") {
          const playlists = await runtime.database.query("service_music_playlists")
            .where({ service_id: context.serviceId, account_id: context.accountId })
            .orderBy("updated_at", "desc")
            .limit(1000);
          const mapped = await Promise.all(playlists.map(async (playlist) => mapPlaylist(
            playlist,
            await listPlaylistSongs(runtime, context, String(playlist.id)),
            context.accountUsername,
          )));
          return sendSubsonicResponse(reply, query, { playlists: { playlist: mapped } });
        }
        if (method === "getPlaylist") {
          const playlist = await requirePlaylist(runtime, context, readQueryString(query.id));
          const songs = await listPlaylistSongs(runtime, context, String(playlist.id));
          return sendSubsonicResponse(reply, query, { playlist: {
            ...mapPlaylist(playlist, songs, context.accountUsername),
            entry: await mapSongs(runtime, context, songs),
          } });
        }
        if (method === "createPlaylist") {
          const playlist = await createPlaylist(runtime, context, query.name, readQueryStrings(query.songId, 5000));
          runtime.logBusinessEvent("info", {
            日志关键字: "codex-flycloud-helper-navidrome", 事件: "创建Navidrome账号播放列表",
            服务ID: context.serviceId, 服务访问账号ID: context.accountId, 播放列表ID: String(playlist.id),
          });
          return sendSubsonicResponse(reply, query, { playlist });
        }
        if (method === "updatePlaylist") {
          const removeIndexes = readQueryStrings(query.songIndexToRemove, 5000)
            .map(Number)
            .filter((value) => Number.isInteger(value) && value >= 0);
          await updatePlaylist(runtime, context, readQueryString(query.playlistId), {
            name: query.name === undefined ? undefined : readQueryString(query.name),
            comment: query.comment === undefined ? undefined : readQueryString(query.comment),
            isPublic: query.public === undefined ? undefined : readQueryBoolean(query.public, false),
            removeIndexes,
            addSongIds: readQueryStrings(query.songIdToAdd, 5000),
          });
          runtime.logBusinessEvent("info", {
            日志关键字: "codex-flycloud-helper-navidrome", 事件: "更新Navidrome账号播放列表",
            服务ID: context.serviceId, 服务访问账号ID: context.accountId, 播放列表ID: readQueryString(query.playlistId),
          });
          return sendSubsonicResponse(reply, query, {});
        }
        if (method === "deletePlaylist") {
          const playlist = await requirePlaylist(runtime, context, readQueryString(query.id));
          await runtime.database.query("service_music_playlists").where({ id: playlist.id }).delete();
          runtime.logBusinessEvent("info", {
            日志关键字: "codex-flycloud-helper-navidrome", 事件: "删除Navidrome账号播放列表",
            服务ID: context.serviceId, 服务访问账号ID: context.accountId, 播放列表ID: String(playlist.id),
          });
          return sendSubsonicResponse(reply, query, {});
        }
        if (method === "getScanStatus") return sendSubsonicResponse(reply, query, { scanStatus: { scanning: false, count: 0 } });
        if (method === "getOpenSubsonicExtensions") {
          return sendSubsonicResponse(reply, query, { openSubsonicExtensions: [{ name: "formPost", versions: [1] }] });
        }
        if (method === "scrobble") {
          const songIds = readQueryStrings(query.id);
          if (songIds.length === 0) throw new ApiError(422, "navidrome_scrobble_id_required", "缺少歌曲 ID");
          const submission = readQueryBoolean(query.submission, true);
          for (const songId of songIds) await recordScrobble(runtime, context, songId, submission);
          runtime.logBusinessEvent("info", {
            日志关键字: "codex-flycloud-helper-navidrome",
            事件: submission ? "保存Navidrome账号播放记录" : "保存Navidrome账号正在播放",
            服务ID: context.serviceId,
            服务访问账号ID: context.accountId,
            歌曲数量: songIds.length,
          });
          return sendSubsonicResponse(reply, query, {});
        }
        if (method === "star" || method === "unstar") {
          const itemIds = [...new Set([
            ...readQueryStrings(query.id),
            ...readQueryStrings(query.artistId),
            ...readQueryStrings(query.albumId),
          ])];
          if (itemIds.length === 0) throw new ApiError(422, "navidrome_star_id_required", "缺少收藏条目 ID");
          await updateStarredItems(runtime, context, itemIds, method === "star");
          runtime.logBusinessEvent("info", {
            日志关键字: "codex-flycloud-helper-navidrome",
            事件: method === "star" ? "保存Navidrome账号收藏" : "取消Navidrome账号收藏",
            服务ID: context.serviceId,
            服务访问账号ID: context.accountId,
            条目数量: itemIds.length,
          });
          return sendSubsonicResponse(reply, query, {});
        }
        if (method === "setRating") {
          const itemId = readQueryString(query.id);
          const rating = Number(readQueryString(query.rating));
          await updateItemRating(runtime, context, itemId, rating);
          runtime.logBusinessEvent("info", {
            日志关键字: "codex-flycloud-helper-navidrome", 事件: "保存Navidrome账号评分",
            服务ID: context.serviceId, 服务访问账号ID: context.accountId, 条目ID: itemId, 评分: rating,
          });
          return sendSubsonicResponse(reply, query, {});
        }
        return sendSubsonicResponse(reply, query, { error: { code: 0, message: `暂不支持 ${method}` } }, "failed");
      } catch (error) {
        runtime.logBusinessEvent("warn", {
          日志关键字: "codex-flycloud-helper-navidrome",
          事件: "Navidrome协议请求失败",
          Navidrome地址后缀: request.params.pathSuffix,
          协议方法: method,
          错误码: error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code ?? "") : "navidrome_request_failed",
        });
        return sendSubsonicError(reply, query, error);
      }
    },
  });
}
