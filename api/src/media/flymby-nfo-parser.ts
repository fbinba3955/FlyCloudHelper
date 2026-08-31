export type FlymbyNfoRootType = "movie" | "tvshow" | "episodedetails" | "unknown";

export interface FlymbyNfoPerson {
  name: string;
  role: string;
  type: "cast" | "crew";
  profileUrl: string | null;
}

export interface FlymbyNfoMetadata {
  rootType: FlymbyNfoRootType;
  title: string;
  originalTitle: string;
  showTitle: string;
  year: number | null;
  rating: number;
  tmdbId: number;
  overview: string;
  genres: string[];
  people: FlymbyNfoPerson[];
  posterValue: string;
  backdropValue: string;
  logoValue: string;
  seasonNumber: number;
  episodeNumber: number;
  airDate: string;
  durationMs: number;
}

/**
 * 解析 Kodi/Emby/TinyMediaManager 常见 NFO 字段。
 * 与 Flymby APP 一样只消费白名单字段，未知 XML 节点不会进入目录 JSON。
 */
export function parseFlymbyNfo(text: string): FlymbyNfoMetadata {
  const rootType = readRootType(text);
  const runtimeMinutes = readNumber(text, "runtime");
  return {
    rootType,
    title: readFirstTag(text, "title"),
    originalTitle: readFirstTag(text, "originaltitle"),
    showTitle: readFirstTag(text, "showtitle"),
    year: readNumber(text, "year") || readDateYear(readFirstNonEmptyTag(text, ["premiered", "aired"])),
    rating: readRating(text),
    tmdbId: readTmdbId(text),
    overview: readFirstNonEmptyTag(text, ["plot", "outline"]),
    genres: readAllTags(text, "genre"),
    people: readPeople(text),
    posterValue: readPosterValue(text),
    backdropValue: readBackdropValue(text),
    logoValue: readLogoValue(text),
    seasonNumber: readNumber(text, "season"),
    episodeNumber: readNumber(text, "episode"),
    airDate: readFirstNonEmptyTag(text, ["aired", "premiered"]),
    durationMs: runtimeMinutes > 0 ? runtimeMinutes * 60_000 : 0,
  };
}

/** 从根元素判断 NFO 类型。 */
function readRootType(text: string): FlymbyNfoRootType {
  const match = /<\s*(movie|tvshow|episodedetails)(?:\s|>)/iu.exec(text);
  return match?.[1]?.toLocaleLowerCase("en-US") as FlymbyNfoRootType ?? "unknown";
}

/** 读取首个标签文本。 */
function readFirstTag(text: string, tag: string): string {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "iu").exec(text);
  return match?.[1] ? normalizeXmlValue(match[1]) : "";
}

/** 从多个标签中读取首个非空值。 */
function readFirstNonEmptyTag(text: string, tags: string[]): string {
  for (const tag of tags) {
    const value = readFirstTag(text, tag);
    if (value) return value;
  }
  return "";
}

/** 读取同名标签的全部非空文本。 */
function readAllTags(text: string, tag: string): string[] {
  const values: string[] = [];
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "giu");
  let match = pattern.exec(text);
  while (match) {
    const value = match[1] ? normalizeXmlValue(match[1]) : "";
    if (value && !values.includes(value)) values.push(value);
    match = pattern.exec(text);
  }
  return values;
}

/** 读取整数标签。 */
function readNumber(text: string, tag: string): number {
  const number = Number.parseInt(readFirstTag(text, tag), 10);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

/** 读取评分，兼容 rating 和 ratings/rating/value。 */
function readRating(text: string): number {
  const direct = Number.parseFloat(readFirstTag(text, "rating"));
  if (Number.isFinite(direct) && direct > 0) return Math.min(10, Math.round(direct * 10) / 10);
  const value = Number.parseFloat(readFirstTag(text, "value"));
  return Number.isFinite(value) && value > 0 ? Math.min(10, Math.round(value * 10) / 10) : 0;
}

/** 读取 TMDB ID，兼容 tmdbid、uniqueid type=tmdb 和普通 id。 */
function readTmdbId(text: string): number {
  const direct = readNumber(text, "tmdbid");
  if (direct > 0) return direct;
  const unique = /<uniqueid\b[^>]*\btype\s*=\s*["']tmdb["'][^>]*>(\d+)<\/uniqueid>/iu.exec(text);
  const uniqueId = Number(unique?.[1] ?? 0);
  if (uniqueId > 0) return uniqueId;
  const id = Number(readFirstTag(text, "id"));
  return Number.isFinite(id) && id > 0 ? id : 0;
}

/** 读取演员与主要创作人员。 */
function readPeople(text: string): FlymbyNfoPerson[] {
  const people: FlymbyNfoPerson[] = [];
  const actorPattern = /<actor(?:\s[^>]*)?>([\s\S]*?)<\/actor>/giu;
  let actorMatch = actorPattern.exec(text);
  while (actorMatch && people.length < 20) {
    const block = actorMatch[1] ?? "";
    const name = readFirstTag(block, "name");
    if (name) {
      people.push({
        name,
        role: readFirstTag(block, "role"),
        type: "cast",
        profileUrl: toPublicImageValue(readFirstTag(block, "thumb")),
      });
    }
    actorMatch = actorPattern.exec(text);
  }
  for (const tag of ["director", "credits"] as const) {
    for (const name of readAllTags(text, tag).slice(0, 6)) {
      people.push({ name, role: tag === "director" ? "Director" : "Writer", type: "crew", profileUrl: null });
    }
  }
  return people;
}

/** 读取海报，优先 poster 类型 thumb。 */
function readPosterValue(text: string): string {
  const typed = /<thumb\b[^>]*\baspect\s*=\s*["']poster["'][^>]*>([\s\S]*?)<\/thumb>/iu.exec(text);
  return typed?.[1] ? normalizeXmlValue(typed[1]) : readFirstTag(text, "thumb");
}

/** 读取背景图，兼容 fanart/thumb。 */
function readBackdropValue(text: string): string {
  const fanart = /<fanart(?:\s[^>]*)?>([\s\S]*?)<\/fanart>/iu.exec(text)?.[1] ?? "";
  const thumb = readFirstTag(fanart, "thumb");
  if (thumb) return thumb;
  const typed = /<thumb\b[^>]*\baspect\s*=\s*["']fanart["'][^>]*>([\s\S]*?)<\/thumb>/iu.exec(text);
  return typed?.[1] ? normalizeXmlValue(typed[1]) : "";
}

/** 读取标题 Logo，兼容 clearlogo 标签和 clearlogo 类型 thumb。 */
function readLogoValue(text: string): string {
  const typed = /<thumb\b[^>]*\baspect\s*=\s*["']clearlogo["'][^>]*>([\s\S]*?)<\/thumb>/iu.exec(text);
  return typed?.[1] ? normalizeXmlValue(typed[1]) : readFirstTag(text, "clearlogo");
}

/** 只把公开 HTTP 图片值放进 posterUrl/backdropUrl。 */
export function toPublicImageValue(value: string): string | null {
  return /^https?:\/\//iu.test(value.trim()) ? value.trim() : null;
}

/** 从日期中读取年份。 */
function readDateYear(value: string): number | null {
  return /^\d{4}/u.test(value) ? Number(value.slice(0, 4)) : null;
}

/** 去除 NFO 字段内部的嵌套标签。 */
function stripXmlTags(value: string): string {
  return value.replace(/<[^>]+>/gu, " ");
}

/** 先展开 CDATA 和实体，再清理字段内部的 HTML/XML 标签。 */
function normalizeXmlValue(value: string): string {
  return stripXmlTags(decodeXmlText(value)).replace(/\s+/gu, " ").trim();
}

/** 解码 NFO 中常见 XML 实体。 */
function decodeXmlText(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gu, "$1")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, "\"")
    .replace(/&apos;/giu, "'")
    .replace(/&amp;/giu, "&")
    .replace(/&#(\d+);/gu, (_match, value: string) => String.fromCodePoint(Number(value)))
    .replace(/&#x([0-9a-f]+);/giu, (_match, value: string) => String.fromCodePoint(Number.parseInt(value, 16)));
}
