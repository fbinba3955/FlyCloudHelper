import { createHash, randomInt } from "node:crypto";
import type { MusicBrainzClient } from "./musicbrainz.js";

export type MusicPlatformSource = "auto" | "musicbrainz" | "netease" | "qmusic" | "kugou" | "migu" | "kuwo";
export type BuiltinMusicPlatformSource = Exclude<MusicPlatformSource, "auto">;

export interface MusicLyricsMetadata {
  source: "lrclib";
  sourceName: "LRCLIB";
  id: number | null;
  plain: string | null;
  synced: string | null;
  instrumental: boolean;
  durationSeconds: number | null;
}

export interface MusicPlatformCandidate {
  source: BuiltinMusicPlatformSource;
  sourceName: string;
  sourceOfficial: boolean;
  matchScore: number;
  title: string;
  artist: string;
  artists: string[];
  artistIds: string[];
  artistImages: string[];
  album: string;
  albumArtist: string;
  releaseDate: string;
  year: number | null;
  durationMs: number | null;
  trackNumber: number | null;
  discNumber: number | null;
  genres: string[];
  coverUrl: string | null;
  lyrics: MusicLyricsMetadata | null;
  identifiers: Record<string, string>;
}

interface MusicPlatformLogger {
  info(fields: Record<string, unknown>): void;
  warn(fields: Record<string, unknown>): void;
}

interface SearchInput {
  title: string;
  artist: string;
  album: string;
  durationMs: number;
  source: MusicPlatformSource;
  aggregateMode: "fast" | "complete";
  requireCover: boolean;
  requireArtistImage: boolean;
  includeLyrics: boolean;
  /** 当前扫描允许使用的系统级内置音乐来源。 */
  enabledSources: BuiltinMusicPlatformSource[];
  signal: AbortSignal;
}

interface PlatformArtist {
  id: string;
  name: string;
  imageUrl: string;
}

export const MUSIC_PLATFORM_SOURCE_ORDER: BuiltinMusicPlatformSource[] = [
  "musicbrainz", "netease", "qmusic", "kugou", "migu", "kuwo",
];

export const MUSIC_PLATFORM_SOURCE_NAMES: Record<BuiltinMusicPlatformSource, string> = {
  musicbrainz: "MusicBrainz",
  netease: "网易云音乐",
  qmusic: "QQ音乐",
  kugou: "酷狗音乐",
  migu: "咪咕音乐",
  kuwo: "酷我音乐",
};

/** 把未知值读取为普通对象。 */
function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** 把未知值读取为对象数组。 */
function asObjectArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    : [];
}

/** 只接受平台返回的 HTTP(S) 图片，并优先升级为 HTTPS。 */
function readImageUrl(value: unknown): string {
  const url = String(value ?? "").trim();
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("http://")) return `https://${url.slice("http://".length)}`;
  return url.startsWith("https://") ? url : "";
}

/** 删除平台搜索结果中的 HTML 命中标记。 */
function stripSearchHighlight(value: unknown): string {
  return String(value ?? "").replace(/<\/?em>/giu, "").trim();
}

/** 读取正整数，非法值返回 null。 */
function readPositiveInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : null;
}

/** 兼容秒数、毫秒数和 mm:ss 时长。 */
function readDurationMs(value: unknown): number | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (text.includes(":")) {
    const parts = text.split(":").map(Number);
    if (parts.some((part) => !Number.isFinite(part) || part < 0)) return null;
    return Math.round(parts.reduce((seconds, part) => seconds * 60 + part, 0) * 1000);
  }
  const number = Number(text);
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.round(number >= 10_000 ? number : number * 1000);
}

/** 将毫秒时间戳转成 UTC 日期。 */
function readTimestampDate(value: unknown): string {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return "";
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

/** 连接平台返回的艺术家名称。 */
function joinArtistNames(artists: PlatformArtist[]): string {
  return artists.map((artist) => artist.name).filter(Boolean).join(", ");
}

/** 对搜索匹配只做必要的大小写、空白和标点处理。 */
function comparableText(value: string): string {
  return value.trim().toLocaleLowerCase("und").replace(/[\s\p{P}\p{S}]+/gu, "");
}

/** 使用字符二元组计算中英文标题相似度。 */
function textSimilarity(left: string, right: string): number {
  const first = comparableText(left);
  const second = comparableText(right);
  if (!first || !second) return first === second ? 1 : 0;
  if (first === second) return 1;
  if (first.includes(second) || second.includes(first)) {
    return Math.min(first.length, second.length) / Math.max(first.length, second.length);
  }
  const firstPairs = new Map<string, number>();
  for (let index = 0; index < Math.max(1, first.length - 1); index += 1) {
    const pair = first.slice(index, index + 2);
    firstPairs.set(pair, (firstPairs.get(pair) ?? 0) + 1);
  }
  let intersection = 0;
  for (let index = 0; index < Math.max(1, second.length - 1); index += 1) {
    const pair = second.slice(index, index + 2);
    const remaining = firstPairs.get(pair) ?? 0;
    if (remaining <= 0) continue;
    intersection += 1;
    firstPairs.set(pair, remaining - 1);
  }
  return (2 * intersection) / (Math.max(1, first.length - 1) + Math.max(1, second.length - 1));
}

/** 对电影、电视剧等官方曲目说明仅比较括号前的歌曲名，伴奏和现场版仍按完整标题比较。 */
function titleSimilarity(queryTitle: string, candidateTitle: string): number {
  const directScore = textSimilarity(queryTitle, candidateTitle);
  const bracketIndex = candidateTitle.search(/[（(【\[]/u);
  if (bracketIndex <= 0) return directScore;
  const titleSuffix = candidateTitle.slice(bracketIndex);
  const isOfficialDescription = /电影|电视剧|影视|动画|综艺|主题曲|片头曲|片尾曲|插曲|推广曲|宣传曲|陪伴曲|原声/u.test(titleSuffix);
  const isAlternateVersion = /伴奏|纯音乐|现场|live|片段|翻唱|cover|remix/u.test(titleSuffix);
  if (!isOfficialDescription || isAlternateVersion) return directScore;
  return Math.max(directScore, textSimilarity(queryTitle, candidateTitle.slice(0, bracketIndex)));
}

/** 计算平台候选与文件标签的可信度。 */
function calculateMatchScore(input: Pick<SearchInput, "title" | "artist" | "album" | "durationMs">, candidate: {
  title: string;
  artist: string;
  album: string;
  durationMs: number | null;
}): number {
  const titleScore = titleSimilarity(input.title, candidate.title);
  const artistScore = input.artist ? textSimilarity(input.artist, candidate.artist) : 1;
  const albumScore = input.album && candidate.album ? textSimilarity(input.album, candidate.album) : 0;
  const durationDifference = input.durationMs > 0 && candidate.durationMs
    ? Math.abs(input.durationMs - candidate.durationMs)
    : Number.POSITIVE_INFINITY;
  const durationBonus = durationDifference <= 3_000 ? 0.08 : durationDifference <= 10_000 ? 0.04 : 0;
  const albumBonus = albumScore >= 0.9 ? 0.08 : albumScore >= 0.65 ? 0.04 : 0;
  return Math.min(1, Number((titleScore * 0.72 + artistScore * 0.28 + durationBonus + albumBonus).toFixed(4)));
}

/** 创建平台无关的候选对象。 */
function buildCandidate(input: SearchInput, value: {
  source: BuiltinMusicPlatformSource;
  sourceOfficial?: boolean;
  title: string;
  artists: PlatformArtist[];
  album: string;
  albumArtist?: string;
  releaseDate?: string;
  durationMs?: number | null;
  trackNumber?: number | null;
  discNumber?: number | null;
  genres?: string[];
  coverUrl?: string;
  identifiers?: Record<string, string>;
}): MusicPlatformCandidate {
  const artist = joinArtistNames(value.artists);
  const durationMs = value.durationMs ?? null;
  const releaseDate = value.releaseDate ?? "";
  return {
    source: value.source,
    sourceName: MUSIC_PLATFORM_SOURCE_NAMES[value.source],
    sourceOfficial: value.sourceOfficial === true,
    matchScore: calculateMatchScore(input, { title: value.title, artist, album: value.album, durationMs }),
    title: value.title,
    artist,
    artists: value.artists.map((item) => item.name).filter(Boolean),
    artistIds: value.artists.map((item) => item.id).filter(Boolean),
    artistImages: value.artists.map((item) => item.imageUrl),
    album: value.album,
    albumArtist: value.albumArtist || artist,
    releaseDate,
    year: /^\d{4}/u.test(releaseDate) ? Number(releaseDate.slice(0, 4)) : null,
    durationMs,
    trackNumber: value.trackNumber ?? null,
    discNumber: value.discNumber ?? null,
    genres: value.genres ?? [],
    coverUrl: readImageUrl(value.coverUrl),
    lyrics: null,
    identifiers: value.identifiers ?? {},
  };
}

/** 云助手内部多平台音乐刮削器，不调用 FlymbyServer 音频接口。 */
export class MusicPlatformAggregator {
  private readonly musicBrainz: MusicBrainzClient;
  private readonly logger: MusicPlatformLogger;
  private readonly userAgent: string;

  public constructor(musicBrainz: MusicBrainzClient, logger: MusicPlatformLogger, userAgent: string) {
    this.musicBrainz = musicBrainz;
    this.logger = logger;
    this.userAgent = userAgent;
  }

  /** 按指定平台或自动聚合模式返回最可信的一个音乐候选。 */
  public async search(input: SearchInput): Promise<MusicPlatformCandidate | null> {
    const enabledSources = new Set(input.enabledSources);
    const sources = input.source === "auto"
      ? MUSIC_PLATFORM_SOURCE_ORDER.filter((source) => enabledSources.has(source))
      : enabledSources.has(input.source) ? [input.source] : [];
    if (sources.length === 0) {
      this.logger.info({
        日志关键字: "codex-flycloud-helper-music-source-config",
        事件: "音乐刮削未启用可用来源",
        请求来源: input.source,
      });
      return null;
    }
    let candidates: MusicPlatformCandidate[] = [];
    if (input.source === "auto" && input.aggregateMode === "fast") {
      candidates = await this.searchFast(sources, input);
    } else {
      const results = await Promise.allSettled(sources.map((source) => this.searchSource(source, input)));
      results.forEach((result, index) => {
        if (result.status === "fulfilled") {
          candidates.push(...result.value);
          return;
        }
        this.logger.warn({
          日志关键字: "codex-flycloud-helper-music-scrape",
          事件: "音乐平台刮削降级",
          音乐平台: MUSIC_PLATFORM_SOURCE_NAMES[sources[index]!],
          错误信息: result.reason instanceof Error ? result.reason.message : "未知平台错误",
        });
      });
    }
    const rankedCandidates = candidates
      .filter((candidate) => candidate.matchScore >= 0.72)
      .sort((left, right) => this.rankCandidate(right, input) - this.rankCandidate(left, input));
    const selected = rankedCandidates[0] ?? null;
    if (!selected) return null;
    if (input.source === "auto" && input.aggregateMode === "complete") {
      this.mergeSupplementalFields(selected, rankedCandidates.slice(1));
    }
    if (input.includeLyrics) {
      selected.lyrics = await this.searchLyrics(selected.title || input.title, selected.artist || input.artist, input.signal);
    }
    this.logger.info({
      日志关键字: "codex-flycloud-helper-music-scrape",
      事件: "多平台音乐刮削命中",
      音乐平台: selected.sourceName,
      匹配分数: selected.matchScore,
      是否包含封面: Boolean(selected.coverUrl),
      是否包含艺术家图片: selected.artistImages.some(Boolean),
      是否包含歌词: Boolean(selected.lyrics),
    });
    return selected;
  }

  /** 最快模式采用首个满足缺失字段要求且匹配可信的平台。 */
  private async searchFast(
    sources: BuiltinMusicPlatformSource[],
    input: SearchInput,
  ): Promise<MusicPlatformCandidate[]> {
    const controllers = sources.map(() => new AbortController());
    const tasks = sources.map(async (source, index) => {
      const controller = controllers[index]!;
      const candidates = await this.searchSource(source, {
        ...input,
        signal: AbortSignal.any([input.signal, controller.signal]),
      });
      const selected = candidates
        .filter((candidate) => this.acceptCandidate(candidate, input))
        .sort((left, right) => right.matchScore - left.matchScore)[0];
      if (!selected) throw new Error(`${MUSIC_PLATFORM_SOURCE_NAMES[source]}没有满足条件的候选`);
      return selected;
    });
    try {
      return [await Promise.any(tasks)];
    } catch {
      return [];
    } finally {
      controllers.forEach((controller) => controller.abort());
      await Promise.allSettled(tasks);
    }
  }

  /** 校验候选可信度和当前缺失字段。 */
  private acceptCandidate(candidate: MusicPlatformCandidate, input: SearchInput): boolean {
    if (candidate.matchScore < 0.72) return false;
    if (input.requireCover && !candidate.coverUrl) return false;
    if (input.requireArtistImage && !candidate.artistImages.some(Boolean)) return false;
    return true;
  }

  /** 完整聚合优先保留能补齐当前图片字段的候选，但不会因单一字段缺失丢弃其他有效信息。 */
  private rankCandidate(candidate: MusicPlatformCandidate, input: SearchInput): number {
    const coverBonus = input.requireCover && candidate.coverUrl ? 0.08 : 0;
    const artistImageBonus = input.requireArtistImage && candidate.artistImages.some(Boolean) ? 0.08 : 0;
    return candidate.matchScore + coverBonus + artistImageBonus;
  }

  /** 用其他可信平台候选补齐主候选缺少的封面、艺术家图片和通用发行字段。 */
  private mergeSupplementalFields(
    selected: MusicPlatformCandidate,
    supplementalCandidates: MusicPlatformCandidate[],
  ): void {
    for (const supplemental of supplementalCandidates) {
      selected.coverUrl ||= supplemental.coverUrl;
      selected.album ||= supplemental.album;
      selected.albumArtist ||= supplemental.albumArtist;
      selected.releaseDate ||= supplemental.releaseDate;
      selected.year ??= supplemental.year;
      selected.durationMs ??= supplemental.durationMs;
      selected.trackNumber ??= supplemental.trackNumber;
      selected.discNumber ??= supplemental.discNumber;
      if (selected.genres.length === 0 && supplemental.genres.length > 0) {
        selected.genres = supplemental.genres;
      }
      selected.identifiers = { ...supplemental.identifiers, ...selected.identifiers };
      const supplementalImages = new Map(
        supplemental.artists.map((artist, index) => [comparableText(artist), supplemental.artistImages[index] ?? ""]),
      );
      const fallbackImage = supplemental.artistImages.find(Boolean) ?? "";
      selected.artistImages = selected.artists.map((artist, index) => (
        selected.artistImages[index]
        || supplementalImages.get(comparableText(artist))
        || (selected.artists.length === 1 ? fallbackImage : "")
      ));
    }
  }

  /** 调用单个平台适配器。 */
  private async searchSource(
    source: BuiltinMusicPlatformSource,
    input: SearchInput,
  ): Promise<MusicPlatformCandidate[]> {
    if (source === "musicbrainz") return this.searchMusicBrainz(input);
    if (source === "netease") return this.searchNetease(input);
    if (source === "qmusic") return this.searchQqMusic(input);
    if (source === "kugou") return this.searchKugou(input);
    if (source === "migu") return this.searchMigu(input);
    return this.searchKuwo(input);
  }

  /** 使用现有 MusicBrainz 客户端生成统一候选。 */
  private async searchMusicBrainz(input: SearchInput): Promise<MusicPlatformCandidate[]> {
    const result = await this.musicBrainz.searchTrack(input.title, input.artist, input.signal, {
      album: input.album,
      durationMs: input.durationMs,
    });
    if (!result) return [];
    return [buildCandidate(input, {
      source: "musicbrainz",
      sourceOfficial: true,
      title: result.title,
      artists: [{ id: result.artistIds[0] ?? "", name: result.artist, imageUrl: "" }],
      album: result.album,
      albumArtist: result.albumArtist,
      releaseDate: result.year ? String(result.year) : "",
      durationMs: result.durationMs,
      coverUrl: result.coverUrl ?? "",
      identifiers: {
        musicbrainzRecording: result.recordingId,
        musicbrainzReleaseTrack: result.releaseTrackId,
        musicbrainzRelease: result.releaseId,
        musicbrainzReleaseGroup: result.releaseGroupId,
      },
    })];
  }

  /** 查询网易云音乐网页搜索接口。 */
  private async searchNetease(input: SearchInput): Promise<MusicPlatformCandidate[]> {
    const payload = await this.requestJson("netease", "https://music.163.com/api/cloudsearch/pc", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: "https://music.163.com/" },
      body: new URLSearchParams({ s: `${input.title} ${input.artist}`.trim(), type: "1", limit: "5", offset: "0" }),
    }, input.signal);
    const songs = asObjectArray(asObject(payload.result).songs);
    return songs.map((song) => {
      const album = asObject(song.album ?? song.al);
      const artists = asObjectArray(song.artists ?? song.ar).map((artist) => ({
        id: String(artist.id ?? ""),
        name: String(artist.name ?? "").trim(),
        imageUrl: readImageUrl(artist.picUrl ?? artist.img1v1Url),
      }));
      return buildCandidate(input, {
        source: "netease",
        title: stripSearchHighlight(song.name),
        artists,
        album: stripSearchHighlight(album.name),
        albumArtist: joinArtistNames(artists),
        releaseDate: readTimestampDate(album.publishTime ?? song.publishTime),
        durationMs: readPositiveInteger(song.duration ?? song.dt),
        coverUrl: readImageUrl(album.picUrl),
        identifiers: {
          neteaseSongId: String(song.id ?? ""),
          neteaseAlbumId: String(album.id ?? ""),
        },
      });
    }).filter((candidate) => candidate.title);
  }

  /** 查询 QQ 音乐桌面搜索接口。 */
  private async searchQqMusic(input: SearchInput): Promise<MusicPlatformCandidate[]> {
    const requestKey = "music.search.SearchCgiService.DoSearchForQQMusicDesktop";
    const payload = await this.requestJson("qmusic", "https://u.y.qq.com/cgi-bin/musicu.fcg", {
      method: "POST",
      headers: { "Content-Type": "application/json", Referer: "https://y.qq.com/" },
      body: JSON.stringify({
        comm: { ct: "6", cv: "80600", uin: "0" },
        [requestKey]: {
          module: "music.search.SearchCgiService",
          method: "DoSearchForQQMusicDesktop",
          param: { query: `${input.title} ${input.artist}`.trim(), num_per_page: 5, page_num: 1, search_type: 0, remoteplace: "txt.web.search" },
        },
      }),
    }, input.signal);
    const songs = asObjectArray(asObject(asObject(asObject(asObject(payload[requestKey]).data).body).song).list);
    return songs.map((song) => {
      const album = asObject(song.album);
      const albumMid = String(album.mid ?? "").trim();
      const artists = asObjectArray(song.singer).map((artist) => {
        const mid = String(artist.mid ?? "").trim();
        return {
          id: mid || String(artist.id ?? ""),
          name: String(artist.name ?? "").trim(),
          imageUrl: mid ? `https://y.qq.com/music/photo_new/T001R500x500M000${mid}.jpg` : "",
        };
      });
      return buildCandidate(input, {
        source: "qmusic",
        title: String(song.title ?? song.name ?? "").trim(),
        artists,
        album: String(album.title ?? album.name ?? "").trim(),
        albumArtist: joinArtistNames(artists),
        releaseDate: String(song.time_public ?? "").trim(),
        durationMs: readPositiveInteger(song.interval) ? Number(song.interval) * 1000 : null,
        coverUrl: albumMid ? `https://y.qq.com/music/photo_new/T002R500x500M000${albumMid}.jpg` : "",
        identifiers: {
          qqMusicSongMid: String(song.mid ?? ""),
          qqMusicSongId: String(song.id ?? ""),
          qqMusicAlbumMid: albumMid,
        },
      });
    }).filter((candidate) => candidate.title);
  }

  /** 查询酷狗音乐网页搜索接口。 */
  private async searchKugou(input: SearchInput): Promise<MusicPlatformCandidate[]> {
    const requestTime = String(Date.now());
    const fields: Array<[string, string]> = [
      ["bitrate", "0"], ["clienttime", requestTime], ["clientver", "2000"], ["dfid", "-"],
      ["inputtype", "0"], ["iscorrection", "1"], ["isfuzzy", "0"], ["keyword", `${input.title} ${input.artist}`.trim()],
      ["mid", requestTime], ["page", "1"], ["pagesize", "5"], ["platform", "WebFilter"],
      ["privilege_filter", "0"], ["srcappid", "2919"], ["tag", "em"], ["userid", "-1"], ["uuid", requestTime],
    ];
    const salt = "NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt";
    const signature = createHash("md5").update(`${salt}${fields.map(([key, value]) => `${key}=${value}`).join("")}${salt}`).digest("hex").toUpperCase();
    const url = new URL("https://complexsearch.kugou.com/v2/search/song");
    fields.forEach(([key, value]) => url.searchParams.set(key, value));
    url.searchParams.set("signature", signature);
    const payload = await this.requestJson("kugou", url, { headers: { Referer: "https://www.kugou.com/" } }, input.signal);
    const songs = asObjectArray(asObject(payload.data).lists);
    return songs.map((song) => {
      const artistName = stripSearchHighlight(song.SingerName);
      const artistIds = String(song.SingerId ?? "").split(/[,&]/u).map((item) => item.trim()).filter(Boolean);
      const artists = artistName.split(/\s*(?:、|,|&|\/|feat\.)\s*/iu).filter(Boolean).map((name, index) => ({
        id: artistIds[index] ?? "",
        name,
        imageUrl: "",
      }));
      return buildCandidate(input, {
        source: "kugou",
        title: stripSearchHighlight(song.SongName),
        artists,
        album: String(song.AlbumName ?? "").trim(),
        albumArtist: artistName,
        releaseDate: String(song.PublishTime ?? "").trim(),
        durationMs: readDurationMs(song.Duration),
        coverUrl: readImageUrl(String(song.Image ?? "").replace("{size}", "500")),
        identifiers: {
          kugouHash: String(song.FileHash ?? ""),
          kugouAlbumId: String(song.AlbumID ?? ""),
        },
      });
    }).filter((candidate) => candidate.title);
  }

  /** 查询咪咕音乐内容搜索接口。 */
  private async searchMigu(input: SearchInput): Promise<MusicPlatformCandidate[]> {
    const url = new URL("https://c.musicapp.migu.cn/v1.0/content/search_all.do");
    url.searchParams.set("text", `${input.title} ${input.artist}`.trim());
    url.searchParams.set("pageNo", "1");
    url.searchParams.set("pageSize", "5");
    url.searchParams.set("isCopyright", "1");
    url.searchParams.set("sort", "1");
    url.searchParams.set("searchSwitch", JSON.stringify({ song: 1, album: 0, singer: 0, tagSong: 1, mvSong: 0, bestShow: 1 }));
    const payload = await this.requestJson("migu", url, { headers: { Referer: "https://y.migu.cn/" } }, input.signal);
    const songs = asObjectArray(asObject(payload.songResultData).result).slice(0, 5);
    return songs.map((song) => {
      const album = asObjectArray(song.albums)[0] ?? {};
      const artists = asObjectArray(song.singers).map((artist) => {
        const image = asObjectArray(artist.imgItems)[0] ?? {};
        return {
          id: String(artist.id ?? artist.singerId ?? ""),
          name: String(artist.name ?? "").trim(),
          imageUrl: readImageUrl(image.img ?? artist.img ?? artist.picL ?? artist.picM),
        };
      });
      const cover = asObjectArray(song.imgItems).find((item) => item.img) ?? {};
      return buildCandidate(input, {
        source: "migu",
        title: String(song.name ?? "").trim(),
        artists,
        album: String(album.name ?? "").trim(),
        albumArtist: joinArtistNames(artists),
        durationMs: readDurationMs(song.duration),
        coverUrl: readImageUrl(cover.img),
        identifiers: {
          miguCopyrightId: String(song.copyrightId ?? ""),
          miguContentId: String(song.contentId ?? song.id ?? ""),
          miguAlbumId: String(album.id ?? ""),
        },
      });
    }).filter((candidate) => candidate.title);
  }

  /** 查询酷我音乐网页接口。 */
  private async searchKuwo(input: SearchInput): Promise<MusicPlatformCandidate[]> {
    const pageUrl = new URL("https://www.kuwo.cn/search/list");
    pageUrl.searchParams.set("key", `${input.title} ${input.artist}`.trim());
    const page = await this.request("kuwo", pageUrl, {}, input.signal);
    const cookieHeader = page.headers.get("set-cookie") ?? "";
    const cookieMatch = cookieHeader.match(/Hm_Iuvt_cdb524f42f23cer9b268564v7y735ewrq2324=([^;,]+)/u);
    const cookieValue = cookieMatch?.[1] ?? "";
    if (!cookieValue) throw new Error("酷我音乐未返回网页协议 Cookie");
    const url = new URL("https://www.kuwo.cn/search/searchMusicBykeyWord");
    const query = `${input.title} ${input.artist}`.trim();
    Object.entries({
      vipver: "1", client: "kt", ft: "music", cluster: "0", strategy: "2012", encoding: "utf8",
      rformat: "json", mobi: "1", issubtitle: "1", show_copyright_off: "1", pn: "1", rn: "5",
      all: query, httpsStatus: "1", reqId: crypto.randomUUID(), plat: "web_www",
    }).forEach(([key, value]) => url.searchParams.set(key, value));
    const payload = await this.requestJson("kuwo", url, {
      headers: {
        Referer: "https://www.kuwo.cn/",
        Cookie: `Hm_Iuvt_cdb524f42f23cer9b268564v7y735ewrq2324=${cookieValue}`,
        Secret: this.createKuwoSecret(cookieValue),
      },
    }, input.signal);
    return asObjectArray(payload.abslist).map((song) => {
      const artistImagePath = String(song.web_artistpic_short ?? "").trim();
      const artistName = stripSearchHighlight(song.ARTIST);
      const artists = [{
        id: String(song.ARTISTID ?? ""),
        name: artistName,
        imageUrl: artistImagePath ? `https://img1.kuwo.cn/star/starheads/${artistImagePath}` : "",
      }];
      const albumCoverPath = String(song.web_albumpic_short ?? "").trim();
      return buildCandidate(input, {
        source: "kuwo",
        title: stripSearchHighlight(song.SONGNAME ?? song.NAME),
        artists,
        album: String(song.ALBUM ?? "").trim(),
        albumArtist: artistName,
        releaseDate: String(song.RELEASEDATE ?? song.PUBLISHDATE ?? "").trim(),
        durationMs: readDurationMs(song.DURATION),
        coverUrl: albumCoverPath ? `https://img2.kuwo.cn/star/albumcover/${albumCoverPath}` : "",
        identifiers: {
          kuwoMusicId: String(song.MUSICRID ?? song.DC_TARGETID ?? ""),
          kuwoAlbumId: String(song.ALBUMID ?? ""),
        },
      });
    }).filter((candidate) => candidate.title);
  }

  /** 从 LRCLIB 读取与歌曲最接近的普通歌词和逐行歌词。 */
  private async searchLyrics(title: string, artist: string, signal: AbortSignal): Promise<MusicLyricsMetadata | null> {
    const url = new URL("https://lrclib.net/api/search");
    url.searchParams.set("track_name", title);
    if (artist) url.searchParams.set("artist_name", artist);
    try {
      const response = await this.request("musicbrainz", url, {}, signal);
      const payload = await response.json() as unknown;
      const candidates = asObjectArray(payload);
      const selected = candidates.sort((left, right) => {
        const leftScore = textSimilarity(String(left.trackName ?? ""), title) * 0.7
          + textSimilarity(String(left.artistName ?? ""), artist) * 0.3;
        const rightScore = textSimilarity(String(right.trackName ?? ""), title) * 0.7
          + textSimilarity(String(right.artistName ?? ""), artist) * 0.3;
        return rightScore - leftScore;
      })[0];
      if (!selected) return null;
      return {
        source: "lrclib",
        sourceName: "LRCLIB",
        id: readPositiveInteger(selected.id),
        plain: selected.plainLyrics ? String(selected.plainLyrics) : null,
        synced: selected.syncedLyrics ? String(selected.syncedLyrics) : null,
        instrumental: selected.instrumental === true,
        durationSeconds: typeof selected.duration === "number" ? selected.duration : null,
      };
    } catch (error) {
      this.logger.warn({
        日志关键字: "codex-flycloud-helper-music-scrape",
        事件: "音乐歌词补全降级",
        错误信息: error instanceof Error ? error.message : "未知歌词服务错误",
      });
      return null;
    }
  }

  /** 请求固定音乐平台地址并应用超时与任务取消。 */
  private async request(
    source: BuiltinMusicPlatformSource,
    url: string | URL,
    init: RequestInit,
    signal: AbortSignal,
  ): Promise<Response> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timer = setTimeout(() => controller.abort(), 15_000);
    signal.addEventListener("abort", abort, { once: true });
    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
        headers: { "User-Agent": this.userAgent, Accept: "application/json", ...init.headers },
      });
      if (!response.ok) throw new Error(`${MUSIC_PLATFORM_SOURCE_NAMES[source]}返回 HTTP ${response.status}`);
      return response;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }

  /** 请求并校验固定音乐平台 JSON 对象。 */
  private async requestJson(
    source: BuiltinMusicPlatformSource,
    url: string | URL,
    init: RequestInit,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const response = await this.request(source, url, init, signal);
    const payload = await response.json() as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error(`${MUSIC_PLATFORM_SOURCE_NAMES[source]}返回数据无效`);
    }
    return payload as Record<string, unknown>;
  }

  /** 复现酷我网页脚本的 Cookie Secret 编码协议。 */
  private createKuwoSecret(cookieValue: string): string {
    const key = "Hm_Iuvt_cdb524f42f23cer9b268564v7y735ewrq2324";
    const keyDigits = [...key].map((character) => String(character.charCodeAt(0))).join("");
    const sectionLength = Math.floor(keyDigits.length / 5);
    const multiplier = Number([1, 2, 3, 4, 5].map((index) => keyDigits[index * sectionLength] ?? "").join(""));
    const increment = Math.floor((key.length + 1) / 2);
    const modulus = 2 ** 31 - 1;
    const nonce = randomInt(0, 100_000_000);
    let foldedDigits = `${keyDigits}${nonce}`;
    while (foldedDigits.length > 10) {
      foldedDigits = String(Number(foldedDigits.slice(0, 10)) + Number(foldedDigits.slice(10)));
    }
    let state = (multiplier * Number(foldedDigits) + increment) % modulus;
    const encodedParts: string[] = [];
    for (const character of cookieValue) {
      const mask = Math.floor((state / modulus) * 255);
      encodedParts.push((character.charCodeAt(0) ^ mask).toString(16).padStart(2, "0"));
      state = (multiplier * state + increment) % modulus;
    }
    encodedParts.push(nonce.toString(16).padStart(8, "0"));
    return encodedParts.join("");
  }
}
