import path from "node:path";
import type { ProviderEntry } from "../providers/types.js";
import { FlymbyVideoTitleCleaner } from "./flymby-video-title-cleaner.js";

export type FlymbyParsedVideoType = "movie" | "tv";

// 关键变量：影响影视查询语义的本地清洗规则发生变化时必须提升，避免复用旧 AI 清洗缓存。
export const FLYMBY_VIDEO_NAME_CLEANER_VERSION = "webdav-video-name-parser-2026-08-20";

export interface FlymbyParsedVideoName {
  mediaType: FlymbyParsedVideoType;
  fileName: string;
  baseName: string;
  title: string;
  query: string;
  /** 目录查询无候选时，从原始文件名提取的第二查询词。 */
  fallbackQuery: string;
  /** 本次媒体类型和标题的主要识别依据，仅供诊断日志使用。 */
  recognitionReason: string;
  /** 明确电影目录是否阻止了一次文件名节目误判。 */
  blockedFalseEpisode: boolean;
  /** 是否因文件名为空或过弱而使用父目录标题。 */
  usedParentTitleFallback: boolean;
  /** 是否使用节目目录年份替换了单集文件年份。 */
  seriesYearCorrected: boolean;
  /** 是否由高密度季集文件纠正了上级电影分类。 */
  overrodeMovieCategoryWithEpisodes?: boolean;
  /** 是否从被弱集号规则影响的原始文件名恢复了电影标题。 */
  recoveredNumericMovieTitle?: boolean;
  /** 是否将节目分类目录中的单文件或同片多版本纠正为电影。 */
  overrodeTvCategoryWithMovieVariants?: boolean;
  /** 是否只使用同名电影目录年份，阻止更上层节目年份越级覆盖。 */
  movieDirectoryYearCorrected?: boolean;
  /** 是否通过数字目录名与多数同名前缀季集文件确认了纯数字节目名。 */
  confirmedNumericSeriesTitle?: boolean;
  year: number | null;
  seasonNumber: number;
  episodeNumber: number;
  episodeNumbers: number[];
  imdbId: string;
  tmdbId: number;
  resolution: string;
  source: string;
  releaseGroup: string;
  /** AI 只补充查询词，不修改真实文件名、媒体类型或季集结构。 */
  aiCleanedTitle?: string;
  aiAlternateTitle?: string;
  aiConfidence?: number;
  aiReason?: string;
}

const videoExtensionPattern = /^(?:mp4|mkv|iso|avi|mov|wmv|flv|m4v|ts|m2ts|webm|rmvb|mpg|mpeg|3gp|strm)$/iu;
const categoryDirectoryPattern = /^(?:电影|影片|院线|华语电影|欧美电影|日韩电影|国产|国影|美影|国产剧|国剧|电视剧|连续剧|剧集|美剧|英剧|日剧|韩剧|港剧|台剧|泰剧|陆剧|短剧|网剧|综艺|纪录片|动漫网剧|动漫|动画|番剧|国产动漫|日韩动漫|欧美动漫|日漫|美漫|国漫|4k|1080p|高清|超清|超高清|合集|系列|专题|其他|未分类)$/iu;
const seriesDirectoryHintPattern = /(?:电视剧|剧集|连续剧|国产剧|国剧|美剧|英剧|日剧|韩剧|港剧|台剧|泰剧|陆剧|短剧|网剧|番剧|动漫网剧|国产动漫|日韩动漫|欧美动漫|日漫|美漫|国漫|动漫|动画|动态漫画|动态漫|漫剧|漫画|综艺|tv\s*shows?|shows?|season|series|第\s*[0-9一二三四五六七八九十两]{1,3}\s*(?:季|部)|\d{1,4}\s*集全)/iu;
const seasonDirectoryPattern = /^(?:(?:season|series|s)\s*0*(\d{1,2})|第\s*([0-9一二三四五六七八九十两]{1,3})\s*(?:季|部))(?:$|[\s._\-–—:：].*)/iu;
const genericMovieFilePattern = /^(?:movie|movies|film|feature|video|videos|main|full|index|default|stream|sample|trailer|preview|part\s*\d+|cd\s*\d+|disc\s*\d+|disk\s*\d+|\d{3,4}p|\d{1,4}|正片|影片|电影|视频|样片|预告)$/iu;
const yearPattern = /(?:^|[^\d])((?:19|20)\d{2})(?!\s*[集话話])(?:[^\d]|$)/gu;
const imdbPattern = /tt\d{6,10}/iu;
const tmdbPattern = /(?:tmdbid|tmdb)\s*[-_:：=]?\s*(\d{2,10})/iu;
const resolutionPattern = /\b((?:bd|hd|uhd|fhd)?\s*(?:2160p|1080p|720p|480p)|4k|8k)\b/iu;
const sourcePattern = /\b(web[-.\s]?dl|web[-.\s]?rip|webrip|bluray|blu[-.\s]?ray|bdrip|hdtv|dvdrip|remux)\b/iu;
const htmlAmpersandEntityPattern = /(?:&amp;|&#0*38;|&#x0*26;)/giu;
const explicitTmdbIdTextPattern = /[\{\[\(【（]?\s*(?:tmdbid|tmdb)\s*[-_:：=]?\s*\d{2,10}\s*[\}\]\)】）]?/giu;
const imdbIdGlobalPattern = /tt\d{6,10}/giu;
const trailingBackupTimestampPattern = /(?:^|[\s._\-–—])(?:19\d{2}|20\d{2})\d{4}[\s._\-–—]*\d{4,6}$/gu;
const yearBracketPattern = /(?:[\[\(【（]\s*(?:19\d{2}|20\d{2})\s*[\]\)】）]|(?:^|[\s._\-–—:：])(?:19\d{2}|20\d{2})(?=$|[\s._\-–—:：]))/gu;
const leadingSiteTagPattern = /^\s*(?:[\[\(【（〖『《「]?[^/\\\]\)】）〗』》」]{0,96}(?:www\.|hmxz|haimian|kkapi|海绵小站)[^/\\\]\)】）〗』》」]{0,96}[\]\)】）〗』》」]?[\s._\-–—:：]*)+/iu;
const bracketedNoiseTagPattern = /[\[\(【（〖『《「][^\]\)】）〗』》」]{0,96}(?:www\.|hmxz|haimian|kkapi|海绵小站|日剧|美剧|韩剧|国产剧|英剧|港剧|台剧|泰剧|动漫|动画|电影|剧场版|特别篇|合集|系列|SRENIX|版|秒传|BDrip|WEB[-.\s]?DL|HEVC|x\s*\.?\s*26[45]|H\s*\.?\s*26[45]|FLAC|AAC|DTS|TrueHD|1080p|2160p|4K|HQ|60\s*fps|音轨|字幕|配音|水印|豆瓣|DIY)[^\]\)】）〗』》」]{0,96}[\]\)】）〗』》」]/giu;
const bracketedCollectionRangePattern = /[\[\(【（]\s*\d{1,2}\s*(?:-|–|—|~|至|到)\s*\d{1,2}\s*季\s*(?:\+\s*SP)?\s*[\]\)】）]/giu;
const bracketedTitlePrefixPattern = /^\s*[\[\(【〖『《「][A-Za-z0-9._+\-\s]{1,64}[\]\)】〗』》」]\s*/gu;
const titleCategoryNoisePattern = /(?:^|[\s._+\-–—:：,，;；/\\|·•\[\]\(\){}【】（）〖〗『』《》「」]+)(?:动画电影|华语电影|欧美电影|日韩电影|国产剧|美剧|英剧|日剧|韩剧|港剧|台剧|泰剧|短剧|陆剧|电视剧|连续剧|剧集|番剧|动漫网剧|国产动漫|日韩动漫|欧美动漫|日漫|美漫|国漫|动漫|动画|综艺|纪录片|国影|电影|影片)(?=$|[\s._+\-–—:：,，;；/\\|·•\[\]\(\){}【】（）〖〗『』《》「」]+)/giu;
const titleBracketPattern = /[\[\]\(\){}【】（）〖〗『』《》「」]/gu;
const titleDotPattern = /[._+]+/gu;
const titleSeparatorPattern = /[–—:：,，;；/\\|]/gu;
const videoQualityPattern = /\b(?:(?:bd|hd|uhd|fhd)\s*)?(?:2160p|1080p|720p|480p)\b|\b(?:4k|8k|uhd|fhd|hdr10\+?|hdr|dv|dolby\s*vision|60\s*fps|120\s*fps|hq|raw|clean)\b/giu;
const videoSourceCleanPattern = /\b(?:web[-.\s]?dl|web[-.\s]?rip|webrip|bluray|blu[-.\s]?ray|bdrip|hdtv|dvdrip|remux)\b/giu;
const videoCodecPattern = /\b(?:x\s*\.?\s*26[45]|h\s*\.?\s*26[45]|hevc|avc|10\s*bit|8\s*bit)\b/giu;
const videoAudioCleanPattern = /\b(?:DDP\s*5\s*1|DDP(?:\s*5(?:[.\s]?1)?)?|DD\+?|EAC3|E-AC3|DTS[-\s]*HD(?:[-\s]*MA)?|DTS\s*5\s*1|DTS|TrueHD\s*\d?\s*\d?|Atmos|AAC(?:\s*[25](?:[.\s]?1)?)?|FLAC(?:\s*[25](?:[.\s]?1)?)?|LPCM|PCM(?:\s*\d(?:[.\s]?0)?)?|AC3|AV3A\s*5\s*1|\d+\s*Audios?|\d+\s*Audio)\b/giu;
const videoLanguagePairPattern = /(?:^|[\s._\-–—:：])(?:Mandarin|Cantonese)\s*(?:&|and)\s*(?:Mandarin|Cantonese)(?=$|[\s._\-–—:：])/giu;
const videoEditionPattern = /\b(?:proper|repack|extended|uncut|director'?s\s*cut|multi|dual|chs|cht|subbed|v\d+)\b/giu;
const videoPlatformPattern = /\b(?:nf|netflix|amzn|amazon|dsnp|disney|hulu|hmax|max|itunes|apple\s*tv|hami|wavve|fandango)\b/giu;
const videoDimensionPattern = /\b\d{3,4}\s*[xX×]\s*\d{3,4}\b/gu;
const videoFileSizePattern = /\b\d+(?:\.\d+)?\s*(?:GB|G|MB|M)\b/giu;
const videoResourceCleanPattern = /(?:杜比视界|高码率|高码版|高码|码率|帧率版本|臻彩|内封简繁|内封|中文字幕|双语字幕|特效字幕|歌词字幕|繁英字幕|简英双语|简繁英字幕|简繁双语|中英字幕|英文字幕|纯净版|无水印|完整版|全集|特辑|国英多音轨|国粤英三语|国粤日三语|国粤日多音轨|国英双语|多音轨|音轨|配音|字幕|附全系列|附系列|附全集|国映\s*TV|大包不错集数|动态漫画|动态漫|片名水印|水印|单集\s*\d{1,4}\s*分钟|单集|豆瓣|DIY|共\s*\d{1,4}\s*集(?:全)?|全\s*\d{1,4}\s*集|\d{1,4}\s*集全|完结|已完结|更至\s*\d{1,4}\s*集|更新至\s*\d{1,4}\s*集|更新中|(?:^|[\s._\-–—:：])(?:简繁中字|简繁|繁中|简中|简英|繁英|中字|国语|国配|粤语|英语|日语|韩语|官中|国英|国粤英|国粤日|中英|Mandarin|Cantonese|Korean|Japanese|English|CHS|CHT|CHS-ENG|ENG)(?:$|[\s._\-–—:：]))/giu;
const videoReleaseTagPattern = /\b(?:HiveWeb|HHWEB|HDSWEB|CMCT|CHD|FRDS|WiKi|NTb|BTN|PTer|PTerWEB|OurTV|ADWeb|BillionMeta|BlackTV|MOMOWEB|VARYG|CTRLWEB|EDITH|HONE|MTeam|PandaQT|QuickIO|DreamHD|ParkHD|ZeroTV|ColorTV|FROGWeb|MiniTV|MiniHD|MNHD|HDWinG|SONYHD|HQC|XLYS|Mp4Ba|Mp4Fan|QHstudIo|QHstudio|OFA|OPS|LGNB|oSpecialCN|HDSky|CHDBits|FGT|HDT|DHTCLUB|AngelaBaby|GY|CHN)\b/giu;
const titleMetadataSuffixPattern = /^(.{2,80}?)[\s._\-–—:：]+(?:剧情|犯罪|悬疑|动作|爱情|科幻|奇幻|冒险|惊悚|恐怖|战争|历史|古装|喜剧|家庭|纪录片|真人秀|综艺|动画|动漫)(?:$|[\s._\-–—:：].*)/u;
const leadingResourcePrefixPattern = /^\s*([A-Za-z]{1,3}|\d-\d)[-_]+(.+)$/u;
const trailingRatingPattern = /(?:^|[\s._+\-–—:：,，;；/\\|·•])(?:豆瓣|imdb|国)\s*\d(?:\.\d)?\s*$/iu;
const trailingNumericRangeTextPattern = /[\s._\-–—:：]+\d{1,2}\s*(?:-|–|—|~|至|到)\s*\d{1,2}$/iu;
const titleSeasonRangeTextPattern = /(?:^|[\s._\-–—:：])(?:S\d{1,2}|Season\s*\d{1,2}|Series\s*\d{1,2}|EP\s*\d{1,4}\s*(?:-|–|—|~|至|到)\s*\d{1,4}|第\s*[0-9一二三四五六七八九十两]{1,3}\s*(?:-|–|—|~|至|到)\s*[0-9一二三四五六七八九十两]{1,3}\s*季|第\s*[0-9一二三四五六七八九十两]{1,3}\s*(?:季|部)|\d{1,2}\s*季全|\d{1,2}\s*(?:-|–|—|~|至|到)\s*\d{1,2})(?:$|[\s._\-–—:：])/giu;
const trailingCollectionRangeTextPattern = /(?:^|[\s._\-–—:：])\d{1,2}\s*(?:(?:-|–|—|~|至|到)|\s+)\s*\d{1,2}\s*季\s*(?:\+?\s*SP)?$/iu;
const trailingBracketlessVersionTagPattern = /[\s._\-–—:：]+SRENIX\s*版?$/iu;
const trailingDashPattern = /\s+-\s+$/gu;
const leadingPunctuationPattern = /^[\s.\-_]+/gu;
const trailingPunctuationPattern = /[\s.\-_]+$/gu;
const leadingSortNumberTitlePattern = /^\s*\d{1,3}\s*(?=[\u4e00-\u9fa5])/u;
const genericYearBucketTitlePattern = /^\s*(?:(?:19|20)\d{2}\s*(?:-|–|—|~|至|到)\s*(?:(?:19|20)\d{2}|之前|以前|以后|之后)|(?:19|20)\d{2}\s*(?:年)?)\s*$/iu;
/** APP 中明确表示电影标题的词，优先级高于宽松集号推断。 */
const movieTitleHintPattern = /(?:剧场版|劇場版|电影版|電影版|映画|代号\s*[:：]?\s*白|(?:^|[\s._+\-–—:：,，;；/\\|·•])(?:电影|国影)(?:$|[\s._+\-–—:：,，;；/\\|·•])|\bmovie\b|\bfilm\b)/iu;
/** APP 用于判定电影分类目录的完整词表。 */
const movieDirectoryTypeHintPattern = /(?:剧场版|劇場版|电影版|電影版|映画|电影篇|网络电影合集|网络电影|电影合集|影片合集|大片合集|爆火大片|院线大片|院线|国影|好莱坞巨制|海外巨制|剧情片|动作片|喜剧片|科幻片|奇幻片|悬疑片|犯罪片|惊悚片|恐怖片|爱情片|战争片|动画电影|动漫电影|纪录片\s*&\s*剧情片|(?:^|[\s._+\-–—:：,，;；/\\|·•])(?:影片|电影)(?:$|[\s._+\-–—:：,，;；/\\|·•])|\bmovies?\b|\bfilms?\b|\bmovie\b|\bfilm\b)/iu;
/** APP 用于判定节目分类目录的完整词表。 */
const tvDirectoryTypeHintPattern = /(?:电视剧|剧集|连续剧|国产剧|美剧|英剧|日剧|韩剧|港剧|台剧|泰剧|陆剧|短剧|网剧|番剧|动漫网剧|国产动漫|日韩动漫|欧美动漫|日漫|美漫|国漫|动漫(?!电影)|动画(?!电影)|动态漫画|动态漫|漫剧|漫画|综艺|tv\s*shows?|shows?|season|series|第\s*[0-9一二三四五六七八九十两]{1,3}\s*季|\d{1,4}\s*集全|全\s*\d{1,4}\s*集|更至\s*\d{1,4}\s*集|更新至\s*\d{1,4}\s*集)/iu;
/** 电影合集的范围目录不能被当成单部电影标题。 */
const movieCollectionRangeTitlePattern = /(?:\d{1,2}\s*(?:-|–|—|~|至|到)\s*\d{1,2}\s*部|\d{1,2}\s*(?:-|–|—|~|至|到)\s*\d{1,2}$|\d{1,2}\s*部\s*(?:4k|8k|hdr)?$|[一二三四五六七八九十两]{1,3}\s*[季部])/iu;

type NearestPathMediaType = "none" | "movie" | "tv" | "mixed";

interface DirectoryVideoContext {
  mediaType: "movie" | "tv" | null;
  title: string;
  seasonNumber: number;
  /** 仅供扫描诊断日志记录目录判型依据。 */
  reason?: string;
}

interface EpisodeMarker {
  matched: boolean;
  index: number;
  seasonNumber: number;
  explicitSeason: boolean;
  episodeNumbers: number[];
}

/**
 * 将 Provider 视频文件转换为 Flymby APP 同语义的本地识别结果。
 * 文件名标记优先；标记不足时再使用季目录、剧集分类目录和父目录标题。
 */
export function parseFlymbyVideoName(entry: ProviderEntry, rootPath: string): FlymbyParsedVideoName {
  const fileName = String(entry.name ?? "").trim();
  const baseName = removeKnownVideoExtension(fileName);
  const normalizedPath = normalizeMediaPath(entry.path);
  const marker = parseEpisodeMarker(baseName, normalizedPath);
  const parentPath = path.posix.dirname(normalizedPath);
  // 关键变量：只采信距离文件最近的单类型目录，避免上层“电影和电视剧”混合库污染判型。
  const nearestPathType = findNearestPathMediaType(rootPath, parentPath);
  const hasExplicitEpisode = hasExplicitEpisodeMarker(baseName);
  const shouldForceMovieByName = movieTitleHintPattern.test(fileName) && !hasExplicitEpisode;
  const shouldUseTv = !shouldForceMovieByName
    && (marker.matched || (nearestPathType === "tv" && isNestedBelowRoot(normalizedPath, rootPath)));
  const year = extractYear(baseName) ?? extractNearestPathYear(normalizedPath);
  const common = {
    fileName,
    baseName,
    year,
    imdbId: imdbPattern.exec(baseName)?.[0]?.toLocaleLowerCase("en-US") ?? "",
    tmdbId: Number(tmdbPattern.exec(`${baseName} ${normalizedPath}`)?.[1] ?? 0),
    resolution: resolutionPattern.exec(baseName)?.[1]?.toLocaleUpperCase("en-US") ?? "",
    source: sourcePattern.exec(baseName)?.[1]?.replace(/\s+/gu, " ").toLocaleUpperCase("en-US") ?? "",
    releaseGroup: extractReleaseGroup(baseName),
  };

  if (shouldUseTv) {
    const episodeNumbers = marker.episodeNumbers.length > 0
      ? marker.episodeNumbers
      : inferEpisodeNumbers(baseName);
    const seasonNumber = marker.explicitSeason
      ? marker.seasonNumber
      : resolveSeasonNumber(normalizedPath, marker.seasonNumber);
    const seriesTitle = pickSeriesTitle(baseName, normalizedPath, marker.index);
    const fileSeriesTitle = marker.index > 0 ? cleanSeriesTitle(baseName.slice(0, marker.index)) : seriesTitle;
    const seriesYear = resolveSeriesYearFromPath(normalizedPath, seriesTitle);
    return {
      ...common,
      mediaType: "tv",
      title: seriesTitle,
      query: seriesTitle,
      fallbackQuery: fileSeriesTitle,
      recognitionReason: marker.matched ? "file_episode_marker" : "tv_path_hint",
      blockedFalseEpisode: false,
      usedParentTitleFallback: false,
      seriesYearCorrected: seriesYear !== null && seriesYear !== year,
      year: seriesYear ?? year,
      seasonNumber,
      episodeNumber: episodeNumbers[0] ?? 0,
      episodeNumbers,
    };
  }

  const fileTitle = cleanMovieTitle(baseName);
  const parentTitle = pickMovieDirectoryTitle(normalizedPath, rootPath);
  const preferParent = FlymbyVideoTitleCleaner.shouldPreferDirectoryTitle(fileName, fileTitle, parentTitle)
    || genericMovieFilePattern.test(FlymbyVideoTitleCleaner.normalizeSearchText(fileTitle));
  const title = preferParent && parentTitle ? parentTitle : (fileTitle || parentTitle || baseName);
  const usedParentTitleFallback = Boolean(parentTitle && title === parentTitle && title !== fileTitle);
  const parentDirectoryYear = usedParentTitleFallback
    ? extractMatchingMovieTitleYearFromPath(normalizedPath, title)
    : null;
  return {
    ...common,
    mediaType: "movie",
    title,
    query: title,
    fallbackQuery: fileTitle,
    recognitionReason: usedParentTitleFallback ? "parent_movie_title" : "movie_file_title",
    blockedFalseEpisode: false,
    usedParentTitleFallback,
    seriesYearCorrected: false,
    year: parentDirectoryYear ?? common.year,
    seasonNumber: 0,
    episodeNumber: 0,
    episodeNumbers: [],
  };
}

/**
 * 按 Flymby APP 的目录上下文统一识别同目录视频。
 * APP 会先观察同目录的全部视频，再决定它们是一部节目的一组单集还是相互独立的电影。
 */
export function parseFlymbyVideoDirectory(
  entries: ProviderEntry[],
  rootPath: string,
): Map<string, FlymbyParsedVideoName> {
  const parsedByResourceId = new Map<string, FlymbyParsedVideoName>();
  const videoEntries = entries.filter((entry) => videoExtensionPattern.test(readVideoExtension(entry.name)));
  for (const entry of videoEntries) {
    parsedByResourceId.set(entry.resourceId, parseFlymbyVideoName(entry, rootPath));
  }
  if (videoEntries.length === 0) return parsedByResourceId;

  const currentPath = path.posix.dirname(normalizeMediaPath(videoEntries[0]!.path));
  const directoryContext = buildDirectoryVideoContext(rootPath, currentPath, videoEntries, parsedByResourceId);
  const episodeNumbersByResourceId = new Map<string, number[]>();
  let episodeLikeCount = 0;
  let explicitTvResult: FlymbyParsedVideoName | null = null;
  for (const entry of videoEntries) {
    const parsed = parsedByResourceId.get(entry.resourceId)!;
    const inferredNumbers = parsed.mediaType === "tv" && parsed.episodeNumbers.length > 0
      ? parsed.episodeNumbers
      : inferDirectoryEpisodeNumbers(entry.name, currentPath);
    episodeNumbersByResourceId.set(entry.resourceId, inferredNumbers);
    if (parsed.mediaType === "tv" || inferredNumbers.length > 0) episodeLikeCount += 1;
    if (!explicitTvResult && parsed.mediaType === "tv") explicitTvResult = parsed;
  }

  if (directoryContext.mediaType === "movie") {
    for (const entry of videoEntries) {
      const parsed = parsedByResourceId.get(entry.resourceId)!;
      // 关键变量：直接从原始文件名提取的电影标题，用于恢复 007、12 Years 等数字开头片名。
      const directMovieTitle = cleanMovieTitle(entry.name);
      // 关键变量：电影容器目录的同名正片、分辨率版本和多分段文件共用一个刮削任务。
      const seriesPartTitle = directoryContext.title
        ? ""
        : buildMovieSeriesPartTitle(rootPath, currentPath, entry.name, parsed.title);
      const movieTitle = directoryContext.title || seriesPartTitle
        || (isUsableMovieDirectoryTitle(directMovieTitle) ? directMovieTitle : parsed.title);
      const blockedFalseEpisode = parsed.mediaType === "tv";
      const directoryYear = directoryContext.title
        ? extractMatchingMovieTitleYearFromPath(entry.path, directoryContext.title)
        : null;
      // 关键变量：S00Exx 分段转回电影后恢复文件自身年份，不能保留节目解析阶段清空的年份。
      const recoveredMovieFileYear = blockedFalseEpisode ? extractYear(parsed.baseName) : null;
      // 关键变量：仅当上级确实存在不属于当前影片的年份时，才记录“阻止年份覆盖”的诊断标记。
      const nearestPathYear = directoryContext.title ? extractNearestPathYear(entry.path) : null;
      const recoveredNumericMovieTitle = blockedFalseEpisode
        && /^\s*0*\d{1,3}(?:$|[\s._\-–—:：])/u.test(parsed.baseName)
        && Boolean(directMovieTitle);
      parsedByResourceId.set(entry.resourceId, {
        ...parsed,
        mediaType: "movie",
        title: movieTitle,
        query: movieTitle,
        recognitionReason: blockedFalseEpisode ? "movie_category_guard" : "movie_directory_context",
        blockedFalseEpisode,
        recoveredNumericMovieTitle,
        overrodeTvCategoryWithMovieVariants: directoryContext.reason === "tv_category_movie_variant",
        movieDirectoryYearCorrected: Boolean(directoryContext.title
          && directoryYear === null
          && nearestPathYear
          && parsed.year
          && nearestPathYear !== parsed.year),
        year: directoryYear ?? recoveredMovieFileYear ?? parsed.year,
        seasonNumber: 0,
        episodeNumber: 0,
        episodeNumbers: [],
      });
    }
    return parsedByResourceId;
  }

  const nestedBelowRoot = isNestedBelowRoot(videoEntries[0]!.path, rootPath);
  const nearestPathType = findNearestPathMediaType(rootPath, currentPath);
  const shouldUseTv = directoryContext.mediaType === "tv"
    || Boolean(explicitTvResult || (nearestPathType === "tv" && nestedBelowRoot) || episodeLikeCount >= 2);
  if (!shouldUseTv) return parsedByResourceId;

  // 关键变量：优先使用显式季集标记解析出的剧名，缺失时再逐级回退到最近可用目录。
  const seriesTitle = directoryContext.title || (explicitTvResult && isUsableTitle(explicitTvResult.query)
    ? explicitTvResult.query
    : pickSeriesTitle("", videoEntries[0]!.path, -1));
  const confirmedNumericSeriesTitle = directoryContext.reason === "numeric_series_file_consensus"
    || directoryContext.reason === "numeric_series_title_season_folder";
  if (!isUsableTitle(seriesTitle) && !confirmedNumericSeriesTitle) return parsedByResourceId;
  const seasonNumber = directoryContext.mediaType === "tv"
    ? directoryContext.seasonNumber
    : explicitTvResult?.seasonNumber ?? resolveSeasonNumber(currentPath, 1);
  const fallbackEpisodeByResourceId = new Map<string, number>();
  [...videoEntries]
    .sort((left, right) => left.name.toLocaleLowerCase("zh-CN").localeCompare(
      right.name.toLocaleLowerCase("zh-CN"),
      "zh-CN",
      { numeric: true },
    ))
    .forEach((entry, index) => fallbackEpisodeByResourceId.set(entry.resourceId, index + 1));

  for (const entry of videoEntries) {
    const parsed = parsedByResourceId.get(entry.resourceId)!;
    const inferredNumbers = episodeNumbersByResourceId.get(entry.resourceId) ?? [];
    const episodeNumbers = inferredNumbers.length > 0
      ? inferredNumbers
      : [fallbackEpisodeByResourceId.get(entry.resourceId) ?? 1];
    const seriesYear = resolveSeriesYearFromPath(entry.path, seriesTitle);
    parsedByResourceId.set(entry.resourceId, {
      ...parsed,
      mediaType: "tv",
      title: seriesTitle,
      query: seriesTitle,
      recognitionReason: directoryContext.mediaType === "tv" ? "tv_directory_context" : parsed.recognitionReason,
      overrodeMovieCategoryWithEpisodes:
        directoryContext.reason === "explicit_episode_density_over_movie_category",
      confirmedNumericSeriesTitle,
      seriesYearCorrected: parsed.seriesYearCorrected || (seriesYear !== null && seriesYear !== parsed.year),
      year: seriesYear ?? parsed.year,
      seasonNumber,
      episodeNumber: episodeNumbers[0] ?? 1,
      episodeNumbers,
    });
  }
  return parsedByResourceId;
}

/**
 * 复制 APP 在单目录内先判定媒体容器、再解析单文件的顺序。
 * 这一层决定同目录文件是共享一部电影，还是聚合成一个节目。
 */
function buildDirectoryVideoContext(
  rootPath: string,
  currentPath: string,
  videoEntries: ProviderEntry[],
  parsedByResourceId: Map<string, FlymbyParsedVideoName>,
): DirectoryVideoContext {
  const numericSeriesContext = buildNumericSeriesDirectoryContext(rootPath, currentPath, videoEntries);
  if (numericSeriesContext.mediaType === "tv") return numericSeriesContext;
  const tvCategoryMovieTitle = pickTvCategoryMovieVariantTitle(rootPath, currentPath, videoEntries);
  if (tvCategoryMovieTitle) {
    return {
      mediaType: "movie",
      title: tvCategoryMovieTitle,
      seasonNumber: 0,
      reason: "tv_category_movie_variant",
    };
  }
  const pathTvContext = buildPathTvContext(currentPath);
  if (pathTvContext.mediaType === "tv") return pathTvContext;

  const nearestPathType = findNearestPathMediaType(rootPath, currentPath);
  const currentFolderName = path.posix.basename(currentPath);
  const isCollectionContainer = isCollectionDirectoryTitle(currentFolderName);
  let explicitEpisodeContext: DirectoryVideoContext | null = null;
  for (const entry of videoEntries) {
    if (!hasExplicitEpisodeMarker(removeKnownVideoExtension(entry.name))) continue;
    const parsed = parsedByResourceId.get(entry.resourceId);
    const title = parsed && isUsableTitle(parsed.query)
      ? parsed.query
      : pickSeriesTitle("", entry.path, -1);
    if (isUsableTitle(title)) {
      explicitEpisodeContext = {
        mediaType: "tv",
        title,
        seasonNumber: parsed?.seasonNumber ?? resolveSeasonNumber(currentPath, 1),
      };
      break;
    }
  }
  if (explicitEpisodeContext && shouldExplicitEpisodesOverrideMovieCategory(currentPath, videoEntries)) {
    return { ...explicitEpisodeContext, reason: "explicit_episode_density_over_movie_category" };
  }
  // 明确电影分类优先，避免 Wall-E.2008、H.264 等文件名把整个电影合集误判成节目。
  if (nearestPathType === "movie" || (nearestPathType === "none" && isCollectionContainer)) {
    return {
      mediaType: "movie",
      title: isCollectionContainer ? "" : pickMovieContainerDirectoryTitle(rootPath, currentPath, videoEntries),
      seasonNumber: 0,
    };
  }

  // 非电影目录仍允许单个明确季集标记建立节目上下文。
  if (explicitEpisodeContext) return explicitEpisodeContext;

  // 多个同前缀、按八位播出日期命名的文件视为节目单集，覆盖纪录片等中性目录。
  const dateEpisodeContext = buildDateEpisodeDirectoryContext(currentPath, videoEntries);
  if (dateEpisodeContext.mediaType === "tv") return dateEpisodeContext;

  const episodeLikeCount = videoEntries.reduce((count, entry) => {
    const parsed = parsedByResourceId.get(entry.resourceId);
    return count + ((parsed?.mediaType === "tv" || inferDirectoryEpisodeNumbers(entry.name, currentPath).length > 0) ? 1 : 0);
  }, 0);
  const normalizedRoot = normalizeMediaPath(rootPath).replace(/\/+$/u, "") || "/";
  const normalizedCurrent = normalizeMediaPath(currentPath);
  const canUseDirectoryTvHint = nearestPathType === "tv"
    && !(normalizedCurrent === normalizedRoot && episodeLikeCount === 0);
  if (canUseDirectoryTvHint || (nearestPathType === "none" && episodeLikeCount >= 2)) {
    const title = pickSeriesTitle("", `${normalizedCurrent}/placeholder.mkv`, -1);
    if (isUsableTitle(title)) {
      return {
        mediaType: "tv",
        title,
        seasonNumber: resolveSeasonNumber(currentPath, 1),
      };
    }
  }

  const movieTitle = pickDirectoryMovieTitle(rootPath, currentPath, videoEntries);
  return { mediaType: movieTitle ? "movie" : null, title: movieTitle, seasonNumber: 0 };
}

/**
 * 多数文件都使用强季集标记时允许覆盖上级“电影”分类。
 * 剧场版目录继续按电影处理，避免 S00Exx 分段被误聚合为节目。
 */
function shouldExplicitEpisodesOverrideMovieCategory(
  currentPath: string,
  videoEntries: ProviderEntry[],
): boolean {
  if (videoEntries.length < 2) return false;
  const folderName = path.posix.basename(normalizeMediaPath(currentPath));
  if (/(?:剧场版|劇場版|电影版|電影版|映画)/iu.test(folderName)) return false;
  const explicitEpisodeCount = videoEntries.reduce((count, entry) => {
    return count + (hasExplicitEpisodeMarker(removeKnownVideoExtension(entry.name)) ? 1 : 0);
  }, 0); // 关键变量：真正包含 SxxExx 等强标记的文件数。
  const requiredCount = Math.max(2, Math.ceil(videoEntries.length * 0.6));
  return explicitEpisodeCount >= requiredCount;
}

/**
 * 识别“1883/1883.S01E01”这种没有独立季目录的纯数字节目名。
 * 必须位于节目分类下，并由至少两个、八成以上的同名前缀显式季集文件共同确认。
 */
function buildNumericSeriesDirectoryContext(
  rootPath: string,
  currentPath: string,
  videoEntries: ProviderEntry[],
): DirectoryVideoContext {
  if (videoEntries.length < 2 || findNearestPathMediaType(rootPath, currentPath) !== "tv") {
    return { mediaType: null, title: "", seasonNumber: 0 };
  }
  const folderName = path.posix.basename(normalizeMediaPath(currentPath));
  const numericTitle = /^\s*((?:18|19|20)\d{2})\s*$/u.exec(folderName)?.[1] ?? "";
  if (!numericTitle) return { mediaType: null, title: "", seasonNumber: 0 };
  const repeatedEpisodePattern = new RegExp(
    `^\\s*${numericTitle}[\\s._\\-–—:：]+(?:S\\s*0*\\d{1,2}[\\s._\\-]*E\\s*0*\\d{1,4}|\\d{1,2}x\\d{1,4})`,
    "iu",
  );
  const matchedCount = videoEntries.reduce((count, entry) => {
    const fileStem = removeKnownVideoExtension(entry.name); // 关键变量：保留文件开头的数字节目名和季集标记。
    return count + (repeatedEpisodePattern.test(fileStem) ? 1 : 0);
  }, 0);
  const requiredCount = Math.max(2, Math.ceil(videoEntries.length * 0.8));
  if (matchedCount < requiredCount) return { mediaType: null, title: "", seasonNumber: 0 };
  return {
    mediaType: "tv",
    title: numericTitle,
    seasonNumber: 1,
    reason: "numeric_series_file_consensus",
  };
}

/**
 * 在节目分类目录内识别单个电影正片或同片多版本。
 * 任何显式或纯数字集号都会阻止此规则，避免恢复旧的节目误判退化。
 */
function pickTvCategoryMovieVariantTitle(
  rootPath: string,
  currentPath: string,
  videoEntries: ProviderEntry[],
): string {
  if (findNearestPathMediaType(rootPath, currentPath) !== "tv" || videoEntries.length === 0) return "";
  const folderName = path.posix.basename(normalizeMediaPath(currentPath));
  if (seasonDirectoryPattern.test(folderName)
    || /(?:第\s*)?[0-9一二三四五六七八九十两]{1,3}\s*季|(?:season|series|s)\s*\d{1,2}/iu.test(folderName)
    || isCollectionDirectoryTitle(folderName)) return "";
  const folderTitle = cleanMovieTitle(folderName);
  if (!isUsableMovieDirectoryTitle(folderTitle)) return "";
  const folderYear = /(?:19|20)\d{2}/u.exec(folderName)?.[0] ?? ""; // 关键变量：电影版本必须与目录年份一致。
  if (videoEntries.length > 1 && (videoEntries.length > 8 || !folderYear)) return "";
  let movieReleaseContextCount = 0; // 关键变量：同时包含同年和视频规格的发行版本数量。
  for (const entry of videoEntries) {
    if (hasExplicitEpisodeMarker(removeKnownVideoExtension(entry.name))) return "";
    // 关键变量：发行文件中的年份、AAC2.0、H.264 等弱数字不能再作为节目集号。
    const hasMovieReleaseContext = /(?:19|20)\d{2}/u.test(entry.name)
      && /(?:2160p|1080p|720p|4k|8k|web[-.\s]?dl|web[-.\s]?rip|bluray|blu[-.\s]?ray|remux|hdtv|h[.\s_-]*26[45]|x[.\s_-]*26[45])/iu.test(entry.name);
    if (hasMovieReleaseContext && folderYear && entry.name.includes(folderYear)) movieReleaseContextCount += 1;
    if (!hasMovieReleaseContext && inferDirectoryEpisodeNumbers(entry.name, currentPath).length > 0) return "";
  }
  if (videoEntries.length === 1) {
    return folderYear && videoEntries[0]!.name.includes(folderYear) ? folderTitle : "";
  }
  const titleCounts = new Map<string, number>(); // 关键变量：清洗后相同的多清晰度电影标题计数。
  for (const entry of videoEntries) {
    const fileTitle = cleanMovieTitle(entry.name);
    if (!isUsableMovieDirectoryTitle(fileTitle)) return "";
    const key = FlymbyVideoTitleCleaner.normalizeSearchText(fileTitle);
    titleCounts.set(key, (titleCounts.get(key) ?? 0) + 1);
  }
  const dominantCount = Math.max(0, ...titleCounts.values());
  const requiredCount = Math.max(2, Math.ceil(videoEntries.length * 0.8));
  return dominantCount >= requiredCount && movieReleaseContextCount >= requiredCount ? folderTitle : "";
}

/**
 * 识别“节目名 20180207 单集标题”这类按播出日期归档的节目目录。
 * 至少两个文件共享同一有效前缀才生效，避免普通电影文件中的日期造成误判。
 */
function buildDateEpisodeDirectoryContext(
  currentPath: string,
  videoEntries: ProviderEntry[],
): DirectoryVideoContext {
  if (videoEntries.length < 2) return { mediaType: null, title: "", seasonNumber: 0 };
  const titleCounts = new Map<string, { title: string; count: number }>();
  for (const entry of videoEntries) {
    const stem = removeKnownVideoExtension(entry.name);
    const match = /^(.*?)\s*(?:19|20)\d{2}[01]\d[0-3]\d(?:$|[\s._\-–—:：])/u.exec(stem);
    if (!match?.[1]) continue;
    const title = cleanSeriesTitle(match[1]);
    if (!isUsableTitle(title)) continue;
    const key = FlymbyVideoTitleCleaner.normalizeSearchText(title);
    const previous = titleCounts.get(key);
    titleCounts.set(key, { title, count: (previous?.count ?? 0) + 1 });
  }
  const best = [...titleCounts.values()].sort((left, right) => right.count - left.count)[0];
  const requiredCount = Math.max(2, Math.ceil(videoEntries.length * 0.6));
  if (!best || best.count < requiredCount) return { mediaType: null, title: "", seasonNumber: 0 };
  return {
    mediaType: "tv",
    title: best.title,
    seasonNumber: resolveSeasonNumber(currentPath, 1),
  };
}

/** 识别 Season 01/第一季/剧名第一季以及更深层的季目录。 */
function buildPathTvContext(directoryPath: string): DirectoryVideoContext {
  const normalizedPath = normalizeMediaPath(directoryPath);
  const parts = normalizedPath.split("/").filter(Boolean);
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const folderName = parts[index]!;
    const parentName = index > 0 ? parts[index - 1]! : "";
    const isSpecialSeason = /特别篇/iu.test(folderName);
    const seasonMatch = seasonDirectoryPattern.exec(folderName);
    if (seasonMatch || isSpecialSeason) {
      if (movieCollectionRangeTitlePattern.test(parentName)) break;
      const title = cleanSeriesTitle(parentName);
      if (isUsableTitle(title)) {
        return {
          mediaType: "tv",
          title,
          seasonNumber: isSpecialSeason ? 0 : Number(seasonMatch?.[1] ?? parseChineseNumber(seasonMatch?.[2] ?? "")),
        };
      }
    }
    const namedSeason = /(?:第\s*)?([0-9一二三四五六七八九十两]{1,3})\s*季|(?:season|series|s)\s*0*(\d{1,2})/iu.exec(folderName);
    if (namedSeason) {
      const seasonNumber = Number(namedSeason[2] ?? parseChineseNumber(namedSeason[1] ?? ""));
      const numericSeriesTitle = pickRepeatedNumericSeasonSeriesTitle(folderName, parentName);
      if (numericSeriesTitle) {
        return {
          mediaType: "tv",
          title: numericSeriesTitle,
          seasonNumber,
          reason: "numeric_series_title_season_folder",
        };
      }
      const title = cleanSeriesTitle(folderName.replace(namedSeason[0], " ")) || cleanSeriesTitle(parentName);
      if (isUsableTitle(title)) return { mediaType: "tv", title, seasonNumber };
    }
  }
  return { mediaType: null, title: "", seasonNumber: 0 };
}

/** 父目录与带季号子目录重复声明同一四位数字时，将其视为《1923》这类节目名。 */
function pickRepeatedNumericSeasonSeriesTitle(folderName: string, parentName: string): string {
  const numericTitle = /^\s*((?:18|19|20)\d{2})\s*$/u.exec(parentName)?.[1] ?? "";
  if (!numericTitle) return "";
  const repeatedTitlePattern = new RegExp(`^\\s*${numericTitle}(?:$|[\\s._\\-–—:：])`, "iu");
  return repeatedTitlePattern.test(folderName) ? numericTitle : "";
}

/** 从叶子目录向根目录查找最近的电影/节目提示，同层双命中时视为混合目录。 */
function findNearestPathMediaType(rootPath: string, currentPath: string): NearestPathMediaType {
  const normalizedRoot = normalizeMediaPath(rootPath);
  let cursor = normalizeMediaPath(currentPath);
  while (cursor !== "/") {
    const folderName = path.posix.basename(cursor);
    const movieMatched = movieDirectoryTypeHintPattern.test(folderName) || movieTitleHintPattern.test(folderName);
    const tvMatched = tvDirectoryTypeHintPattern.test(folderName);
    if (movieMatched && tvMatched) return "mixed";
    if (movieMatched) return "movie";
    if (tvMatched) return "tv";
    if (cursor === normalizedRoot) break;
    cursor = path.posix.dirname(cursor);
  }
  return "none";
}

/** 为电影目录选择可聚合的目录标题，不将“电影/合集/1-5部”本身当片名。 */
function pickDirectoryMovieTitle(rootPath: string, currentPath: string, videoEntries: ProviderEntry[]): string {
  const folderName = path.posix.basename(normalizeMediaPath(currentPath));
  const folderTitle = cleanMovieTitle(folderName);
  if (!isUsableMovieDirectoryTitle(folderTitle) || isCollectionDirectoryTitle(folderName)) return "";
  const nearestPathType = findNearestPathMediaType(rootPath, currentPath);
  if (videoEntries.length === 1) {
    const fileTitle = cleanMovieTitle(videoEntries[0]!.name);
    if (nearestPathType === "movie" || fileTitleMatchesDirectoryTitle(fileTitle, folderTitle)) return folderTitle;
    return "";
  }
  const shouldGroup = videoEntries.every((entry) => {
    const fileTitle = cleanMovieTitle(entry.name);
    // 关键变量：S00Exx 等电影分段先按节目规则取得目录标题，再与电影容器标题比较。
    const parsedTitle = hasExplicitEpisodeMarker(removeKnownVideoExtension(entry.name))
      ? parseFlymbyVideoName(entry, rootPath).title
      : fileTitle;
    return genericMovieFilePattern.test(FlymbyVideoTitleCleaner.normalizeSearchText(fileTitle))
      || fileTitleMatchesDirectoryTitle(fileTitle, folderTitle)
      || fileTitleMatchesDirectoryTitle(parsedTitle, folderTitle);
  });
  return shouldGroup ? folderTitle : "";
}

/**
 * 从电影容器提取首选标题；当前目录只是 S00Exx 分段等弱文件容器时回退到上级片名。
 * 该顺序与 Flymby APP 的 pickMovieContainerDirectoryTitle 保持一致。
 */
function pickMovieContainerDirectoryTitle(
  rootPath: string,
  currentPath: string,
  videoEntries: ProviderEntry[],
): string {
  const currentTitle = pickDirectoryMovieTitle(rootPath, currentPath, videoEntries);
  if (currentTitle) return currentTitle;
  const normalizedCurrent = normalizeMediaPath(currentPath);
  if (normalizedCurrent === normalizeMediaPath(rootPath)) return "";
  const parentName = path.posix.basename(path.posix.dirname(normalizedCurrent));
  const parentTitle = cleanMovieTitle(parentName); // 关键变量：当前目录无法成片时使用的近层上级电影标题。
  return isUsableMovieDirectoryTitle(parentTitle) ? parentTitle : "";
}

/** 判断原始目录是否为电影系列/合集容器。 */
function isCollectionDirectoryTitle(value: string): boolean {
  const raw = String(value ?? "").trim();
  const normalized = FlymbyVideoTitleCleaner.normalizeSearchText(raw);
  return /(?:系列|合集|collection|trilogy)/iu.test(raw)
    || movieCollectionRangeTitlePattern.test(raw)
    || normalized === "系列"
    || normalized === "合集";
}

/** 判断目录标题是否足以作为电影查询词。 */
function isUsableMovieDirectoryTitle(value: string): boolean {
  return isUsableTitle(value)
    && !genericMovieFilePattern.test(FlymbyVideoTitleCleaner.normalizeSearchText(value))
    && !isCollectionDirectoryTitle(value);
}

/** 按 APP 的包含关系判断文件标题和目录标题是否同一部影片。 */
function fileTitleMatchesDirectoryTitle(fileTitle: string, directoryTitle: string): boolean {
  const left = FlymbyVideoTitleCleaner.normalizeSearchText(fileTitle);
  const right = FlymbyVideoTitleCleaner.normalizeSearchText(directoryTitle);
  return Boolean(left && right && (left === right || left.includes(right) || right.includes(left)));
}

/**
 * 从“系列/合集”目录与文件部号构建单部电影查询词。
 * 例如“速度与激情系列/10.mkv”会得到“速度与激情10”，避免所有部数聚合到同一任务。
 */
function buildMovieSeriesPartTitle(
  rootPath: string,
  currentPath: string,
  fileName: string,
  parsedTitle: string,
): string {
  const partNumber = extractMovieSeriesPartNumber(fileName) || extractMovieSeriesPartNumber(path.posix.basename(currentPath));
  if (partNumber <= 0) return "";
  const normalizedRoot = normalizeMediaPath(rootPath);
  let cursor = normalizeMediaPath(currentPath);
  for (let depth = 0; cursor !== "/" && depth < 4; depth += 1) {
    const folderName = path.posix.basename(cursor);
    if (isCollectionDirectoryTitle(folderName)) {
      const baseTitle = cleanMovieTitle(folderName.replace(/(?:系列电影|电影系列|系列|合集|collection|trilogy)/giu, " "));
      if (isUsableMovieDirectoryTitle(baseTitle)) {
        const normalizedParsed = FlymbyVideoTitleCleaner.normalizeSearchText(parsedTitle);
        const normalizedBase = FlymbyVideoTitleCleaner.normalizeSearchText(baseTitle);
        if (isWeakFlymbyScrapeTitle(parsedTitle)
          || genericMovieFilePattern.test(normalizedParsed)
          || normalizedParsed.includes(normalizedBase)
          || normalizedBase.includes(normalizedParsed)) {
          return `${baseTitle}${partNumber}`;
        }
      }
    }
    if (cursor === normalizedRoot) break;
    cursor = path.posix.dirname(cursor);
  }
  return "";
}

/** 从第 N 部、Part N 或纯数字文件名提取常见电影系列部号。 */
function extractMovieSeriesPartNumber(fileName: string): number {
  const stem = removeKnownVideoExtension(fileName);
  const explicitPart = /第\s*([0-9一二三四五六七八九十两]{1,3})\s*部/u.exec(stem);
  if (explicitPart?.[1]) return normalizeMovieSeriesPartNumber(parseChineseNumber(explicitPart[1]));
  const englishPart = /(?:^|[\s._\-–—])(?:part|pt)\s*0*([1-9]|[12]\d|30)(?:$|[\s._\-–—])/iu.exec(stem);
  if (englishPart?.[1]) return normalizeMovieSeriesPartNumber(Number(englishPart[1]));
  const genericNumber = /^0*([1-9]|[12]\d|30)$/u.exec(FlymbyVideoTitleCleaner.normalizeSearchText(stem));
  return normalizeMovieSeriesPartNumber(Number(genericNumber?.[1] ?? 0));
}

/** 电影系列部号只接受 APP 限定的 1 到 30。 */
function normalizeMovieSeriesPartNumber(value: number): number {
  return Number.isInteger(value) && value > 0 && value <= 30 ? value : 0;
}

/** 只判断文件名中明确的季集标记，不把目录推断出的数字集号算作显式标记。 */
function hasExplicitEpisodeMarker(baseName: string): boolean {
  if (/[Ss]\d{1,2}[\s._-]*[Ee]\d{1,4}/u.test(baseName)
    || /(?:Season|Series)\s*\d{1,2}[\s._\-–—:：]*(?:Episode|EP|E)\s*\d{1,4}/iu.test(baseName)
    || /(?:^|[\s._\-\[])(\d{1,2})x\d{1,4}(?:\D|$)/iu.test(baseName)
    || /第\s*[0-9一二三四五六七八九十两]{1,3}\s*[季部]\s*第?\s*\d{1,4}\s*[集话話]/u.test(baseName)
    || /(?:第\s*0*\d{1,4}\s*[集话話]|(?:^|[\s._\-\[【(（])0*\d{1,4}\s*[集话話])/u.test(baseName)
    || /(?:^|[\s._\-\[【(（])(?:SP|Special)(?:[\s._-]*\d{1,4})?(?:$|[\s._\-–—:：\]】)）])/iu.test(baseName)) {
    return true;
  }
  const episodeOnly = /(?:^|[\s._\-\[【(（])(?:Episode|EP|E)[\s._-]*0*(\d{1,4})(?:\s*v\d+)?(?:$|[\s._\-–—:：\]】)）])/iu.exec(baseName);
  return isUsableEpisodeMarkerNumber(Number(episodeOnly?.[1] ?? 0));
}

/** 生成 APP 刮削任务使用的稳定聚合键。 */
export function buildFlymbyScrapeTaskKey(parsed: FlymbyParsedVideoName): string {
  if (parsed.tmdbId > 0) return `${parsed.mediaType}|tmdb|${parsed.tmdbId}`;
  if (parsed.imdbId) return `${parsed.mediaType}|imdb|${parsed.imdbId}`;
  const query = FlymbyVideoTitleCleaner.normalizeSearchText(parsed.query);
  return query ? `${parsed.mediaType}|${query}|${parsed.year ?? ""}` : "";
}

/** 判断标题是否弱到不应直接请求 TMDB。 */
export function isWeakFlymbyScrapeTitle(value: string): boolean {
  const raw = String(value ?? "").trim();
  const normalized = FlymbyVideoTitleCleaner.normalizeSearchText(raw);
  if (!normalized || FlymbyVideoTitleCleaner.isGenericBucketTitle(normalized)) return true;
  if (/^\d{1,4}$/u.test(normalized)) return true;
  if (/^\d{1,4}\s*(?:-|–|—|~|至|到|\s+)\s*\d{1,4}(?:\s*(?:集|话|話|季))?$/u.test(normalized)) return true;
  return /^(?:(?:season|series|s)\s*\d{1,2}|第\s*[0-9一二三四五六七八九十两]{1,3}\s*(?:季|部))$/iu.test(raw);
}

/** 解析 APP 支持的常见季集标记，包括多集合并文件。 */
function parseEpisodeMarker(baseName: string, filePath: string): EpisodeMarker {
  const sxe = /[Ss](\d{1,2})[\s._-]*[Ee](\d{1,4}(?:[\s._-]*(?:E|[-–—~至到])[\s._-]*\d{1,4})*)/iu.exec(baseName);
  if (sxe) {
    return {
      matched: true,
      index: sxe.index,
      seasonNumber: Number(sxe[1]),
      explicitSeason: true,
      episodeNumbers: collectEpisodeNumbers(sxe[2] ?? ""),
    };
  }
  const seasonEpisode = /(?:Season|Series)\s*0*(\d{1,2})[\s._\-–—:：]*(?:Episode|EP|E)\s*0*(\d{1,4})/iu.exec(baseName);
  if (seasonEpisode) {
    return markerFromMatch(seasonEpisode, Number(seasonEpisode[1]), true, [Number(seasonEpisode[2])]);
  }
  const oneX = /(?:^|[\s._\-\[])\s*(\d{1,2})x(\d{1,4})(?:\D|$)/iu.exec(baseName);
  if (oneX) return markerFromMatch(oneX, Number(oneX[1]), true, [Number(oneX[2])]);
  const chineseSeasonEpisode = /第\s*([0-9一二三四五六七八九十两]{1,3})\s*[季部]\s*第?\s*0*(\d{1,4})\s*[集话話]/u.exec(baseName);
  if (chineseSeasonEpisode) {
    return markerFromMatch(chineseSeasonEpisode, parseChineseNumber(chineseSeasonEpisode[1] ?? ""), true, [Number(chineseSeasonEpisode[2])]);
  }
  const chineseSeasonTrailingEpisode = /第\s*([0-9一二三四五六七八九十两]{1,3})\s*[季部]\s*0*(\d{1,4})(?:\s*v\d+)?(?:$|[\s._\-–—:：\]】)）])/u.exec(baseName);
  if (chineseSeasonTrailingEpisode) {
    return markerFromMatch(
      chineseSeasonTrailingEpisode,
      parseChineseNumber(chineseSeasonTrailingEpisode[1] ?? ""),
      true,
      [Number(chineseSeasonTrailingEpisode[2])],
    );
  }
  const chineseEpisode = /(?:第\s*0*(\d{1,4})\s*[集话話]|(?:^|[\s._\-\[【(（])0*(\d{1,4})\s*[集话話])/u.exec(baseName);
  if (chineseEpisode) {
    return markerFromMatch(chineseEpisode, resolveSeasonNumber(filePath, 0), false, [Number(chineseEpisode[1] ?? chineseEpisode[2])]);
  }
  const episodeOnly = /(?:^|[\s._\-\[【(（])(?:Episode|EP|E)[\s._-]*0*(\d{1,4})(?:\s*v\d+)?(?:$|[\s._\-–—:：\]】)）])/iu.exec(baseName);
  if (episodeOnly && isUsableEpisodeMarkerNumber(Number(episodeOnly[1]))) {
    const episodeNumbers = [...baseName.matchAll(/(?:Episode|EP|E)[\s._-]*0*(\d{1,4})/giu)]
      .map((item) => Number(item[1]))
      .filter((value) => isUsableEpisodeMarkerNumber(value));
    return markerFromMatch(
      episodeOnly,
      resolveSeasonNumber(filePath, 0),
      false,
      episodeNumbers.length > 0 ? episodeNumbers : [Number(episodeOnly[1])],
    );
  }
  const special = /(?:^|[\s._\-\[【(（])(?:SP|Special)(?:[\s._-]*0*(\d{1,4})(?:\s*v\d+)?)?(?:$|[\s._\-–—:：\]】)）])/iu.exec(baseName);
  if (special) {
    return markerFromMatch(special, 0, true, [Number(special[1] || 1)]);
  }
  const trailing = endsWithVideoCodecNumber(baseName)
    ? null
    : /^(.*?[A-Za-z\u4e00-\u9fa5])[\s._-]*0*(\d{1,4})(?:\s*v\d+)?$/u.exec(baseName);
  if (trailing
    && seriesDirectoryHintPattern.test(filePath)
    && !startsWithAirDate(baseName)
    && !containsResolutionDimension(baseName)) {
    return markerFromMatch(trailing, resolveSeasonNumber(filePath, 0), false, [Number(trailing[2])]);
  }
  if (seriesDirectoryHintPattern.test(filePath) && !startsWithAirDate(baseName) && !containsResolutionDimension(baseName)) {
    const inferredEpisodes = inferEpisodeNumbers(baseName);
    if (inferredEpisodes.length > 0) {
      return {
        matched: true,
        index: 0,
        seasonNumber: resolveSeasonNumber(filePath, 0),
        explicitSeason: false,
        episodeNumbers: inferredEpisodes,
      };
    }
  }
  return { matched: false, index: -1, seasonNumber: 0, explicitSeason: false, episodeNumbers: [] };
}

/** 将正则结果转换为统一季集标记。 */
function markerFromMatch(match: RegExpExecArray, seasonNumber: number, explicitSeason: boolean, episodeNumbers: number[]): EpisodeMarker {
  return {
    matched: true,
    index: match.index,
    seasonNumber,
    explicitSeason,
    episodeNumbers: normalizeEpisodeNumbers(episodeNumbers),
  };
}

/** 解析 E01-E03、E01E02 等连续或离散集合。 */
function collectEpisodeNumbers(value: string): number[] {
  const numbers = String(value ?? "").match(/\d{1,4}/gu)?.map(Number) ?? [];
  if (numbers.length === 2 && /[-–—~至到]/u.test(value) && numbers[1]! >= numbers[0]! && numbers[1]! - numbers[0]! <= 50) {
    const range: number[] = [];
    for (let number = numbers[0]!; number <= numbers[1]!; number += 1) range.push(number);
    return range;
  }
  return normalizeEpisodeNumbers(numbers);
}

/** 从纯数字或“01.mp4”形式补充单集编号。 */
function inferEpisodeNumbers(baseName: string): number[] {
  const direct = /^\s*[\[（(【]?\s*0*(\d{1,4})(?:\s*v\d+)?\s*[\]）)】]?\s*$/u.exec(baseName);
  const number = Number(direct?.[1] ?? 0);
  return number > 0 && number <= 5000 && (number < 1900 || number > 2099) ? [number] : [];
}

/**
 * 在目录级上下文中补充 APP 使用的宽松集号识别。
 * 对“2040集完/2001-2500/2001.mp4”这类目录，纯数字允许作为大于 500 的真实集号。
 */
function inferDirectoryEpisodeNumbers(fileName: string, directoryPath: string): number[] {
  const baseName = removeKnownVideoExtension(fileName);
  const direct = /^\s*[\[（(【]?\s*0*(\d{1,4})(?:\s*v\d+)?\s*[\]）)】]?\s*$/u.exec(baseName);
  const directNumber = Number(direct?.[1] ?? 0);
  const directoryHasEpisodeRange = /(?:\d{1,4}\s*集|\d{1,4}\s*[-–—~至到]\s*\d{1,4})/u.test(directoryPath);
  if (directNumber > 0 && directNumber <= 5000
    && ((directNumber < 1900 || directNumber > 2099) || directoryHasEpisodeRange)) {
    return [directNumber];
  }
  if (startsWithAirDate(baseName) || containsResolutionDimension(baseName)) return [];
  const leading = /^\s*[\[（(【]?\s*0*(\d{1,4})(?=$|[\s._\-–—:：\]）)】]|(?=[\u4e00-\u9fa5]))/u.exec(baseName);
  const trailing = /(?:^|[\s._\-–—:：])0*(\d{1,4})(?:\s*[集话話])?\s*$/u.exec(baseName);
  const number = Number(leading?.[1] ?? trailing?.[1] ?? 0);
  if (number <= 0 || number > 5000) return [];
  if (number >= 1900 && number <= 2099 && !directoryHasEpisodeRange) return [];
  if ([264, 265, 480, 720, 1080, 2160].includes(number)) return [];
  return [number];
}

/** 判断文件名是否以播出日期开头，避免把月份或日期误认为集号。 */
function startsWithAirDate(value: string): boolean {
  return /^\s*(?:19|20)\d{2}[-_.]\d{1,2}[-_.]\d{1,2}(?:$|[\s._\-–—:：])/u.test(value);
}

/** 判断文件名是否包含分辨率尺寸，避免把宽高数字误认为单集编号。 */
function containsResolutionDimension(value: string): boolean {
  return /\b\d{3,4}\s*[xX×]\s*\d{3,4}\b/u.test(value);
}

/** 从文件名前缀、季目录上级或最近可用目录选择节目名称。 */
function pickSeriesTitle(baseName: string, filePath: string, markerIndex: number): string {
  const prefix = markerIndex > 0 ? cleanSeriesTitle(baseName.slice(0, markerIndex)) : "";
  if (isUsableTitle(prefix)) return prefix;
  const directoryParts = directoryPartsForFile(filePath);
  const seasonIndex = findSeasonDirectoryIndex(directoryParts);
  if (seasonIndex > 0) {
    const seasonParentTitle = cleanSeriesTitle(directoryParts[seasonIndex - 1]!);
    if (isUsableTitle(seasonParentTitle)) return seasonParentTitle;
  }
  for (let index = directoryParts.length - 1; index >= 0; index -= 1) {
    if (isGenericMediaRootDirectoryName(directoryParts[index]!)) continue;
    if (/(?:字幕组|字幕社|压制组|翻译组)/iu.test(directoryParts[index]!)) continue;
    const candidate = cleanSeriesTitle(directoryParts[index]!);
    if (isUsableTitle(candidate) && !seasonDirectoryPattern.test(directoryParts[index]!)) return candidate;
  }
  return cleanSeriesTitle(baseName) || baseName;
}

/** 从最近可用父目录取得电影名称，适用于“正片/2160p/年份”文件名。 */
function pickMovieDirectoryTitle(filePath: string, rootPath: string): string {
  const root = normalizeMediaPath(rootPath).replace(/\/+$/u, "");
  const directoryParts = directoryPartsForFile(filePath);
  for (let index = directoryParts.length - 1; index >= 0; index -= 1) {
    const candidatePath = `/${directoryParts.slice(0, index + 1).join("/")}`;
    if (root && root !== "/" && candidatePath.length < root.length) break;
    if (isGenericMediaRootDirectoryName(directoryParts[index]!)) continue;
    const candidate = cleanMovieTitle(directoryParts[index]!);
    if (isUsableTitle(candidate) && !categoryDirectoryPattern.test(directoryParts[index]!)) return candidate;
  }
  return "";
}

/** 清理电影文件名并优先截断季集标记后的文本。 */
function cleanMovieTitle(value: string): string {
  const stem = removeKnownVideoExtension(value);
  // “1917：逆战救兵”开头的四位数字属于片名，不作为发行年份删除。
  const numericTitleMatch = /^((?:19|20)\d{2})\s*[:：]\s*/u.exec(stem);
  const numericTitlePrefix = numericTitleMatch?.[1] ?? "";
  const titleStem = numericTitleMatch ? stem.slice(numericTitleMatch[0].length) : stem;
  // 带年份的电影文件末尾常用 -1、-2 表示分段或版本，不属于片名。
  const withoutVersionPart = /(?:19|20)\d{2}/u.test(titleStem)
    ? titleStem.replace(/([\]\)】）])?\s*[-_.]\s*(?:(?:cd|disc|disk|part|pt)\s*)?\d{1,2}\s*$/iu, "$1")
    : titleStem;
  const withoutAttachedYear = withoutVersionPart.replace(
    /([A-Za-z])((?:19|20)\d{2})(?=$|[\s._\-–—:：])/gu,
    "$1 ",
  );
  let text = cleanTitleSegment(withoutAttachedYear);
  if (!text) {
    text = removeKnownVideoExtension(value).replace(/(?:^|[^\d])(?:19|20)\d{2}(?:[^\d]|$)/gu, " ");
    text = cleanTitleSegment(text);
  }
  const cleanedTitle = stripDetectedReleaseGroup(text, stem);
  // 关键变量：使用未被预清洗丢失的原始文件名上下文，只删除标题尾部的版本和地区说明。
  const contextualTitle = FlymbyVideoTitleCleaner.stripContextualMovieReleaseDescriptors(cleanedTitle, stem);
  return [numericTitlePrefix, contextualTitle].filter(Boolean).join(" ").trim();
}

/**
 * 在文件名确实包含资源规格时，移除动态发布组尾词。
 * 例如 CHS-ENG.JKYY 会提取 ENG.JKYY，但只删除清洗后仍残留的 JKYY。
 */
function stripDetectedReleaseGroup(title: string, rawValue: string): string {
  const releaseGroup = extractReleaseGroup(rawValue); // 关键变量：文件名最后一个短横线后的发布组文本。
  const hasReleaseContext = resolutionPattern.test(rawValue)
    || sourcePattern.test(rawValue)
    || /\b(?:x\s*\.?\s*26[45]|h\s*\.?\s*26[45]|hevc|avc|aac|ddp|dts|truehd|atmos|ac3)\b/iu.test(rawValue);
  if (!releaseGroup || !hasReleaseContext) return title;
  const groupParts = releaseGroup.split(/[._\-]+/u).filter((part) => Boolean(part));
  const titleParts = title.split(/\s+/u).filter((part) => Boolean(part));
  while (titleParts.length > 0) {
    const lastPart = titleParts[titleParts.length - 1]!;
    if (!groupParts.some((part) => part.toLocaleLowerCase("en-US") === lastPart.toLocaleLowerCase("en-US"))) break;
    titleParts.pop();
  }
  return titleParts.join(" ").trim();
}

/** 清理节目标题中的季集、年份和资源信息。 */
function cleanSeriesTitle(value: string): string {
  let text = removeKnownVideoExtension(value);
  text = text.replace(/[Ss]\d{1,2}[\s._-]*[Ee]\d{1,4}.*$/u, " ");
  text = text.replace(/第\s*[0-9一二三四五六七八九十两]{1,3}\s*[季部].*$/u, " ");
  text = text.replace(/(?:Season|Series)\s*\d{1,2}.*$/iu, " ");
  text = text.replace(trailingBackupTimestampPattern, " ");
  text = text.replace(yearBracketPattern, " ");
  return cleanTitleSegment(text).replace(/[\s._\-–—:：]+\d{1,2}$/u, " ").trim();
}

/** 对齐 APP 的目录和文件标题清洗主链，删除站点、ID、资源规格和发布组噪声。 */
function cleanTitleSegment(value: string): string {
  const rawValue = String(value ?? "");
  let text = rawValue.replace(htmlAmpersandEntityPattern, "&");
  text = removeKnownVideoExtension(text);
  text = text.replace(leadingSiteTagPattern, " ");
  text = stripLeadingResourcePrefix(text);
  text = text.replace(explicitTmdbIdTextPattern, " ");
  text = text.replace(bracketedCollectionRangePattern, " ");
  text = text.replace(bracketedNoiseTagPattern, " ");
  text = removeTitleCategoryNoise(text);
  text = text.replace(trailingBackupTimestampPattern, " ");
  text = text.replace(bracketedTitlePrefixPattern, " ");
  text = text.replace(leadingSortNumberTitlePattern, " ");
  text = text.replace(imdbIdGlobalPattern, " ");
  text = text.replace(trailingRatingPattern, " ");
  text = text.replace(titleBracketPattern, " ");
  text = text.replace(titleDotPattern, " ");
  text = text.replace(trailingNumericRangeTextPattern, " ");
  text = text.replace(titleSeparatorPattern, " ");
  text = text.replace(videoQualityPattern, " ");
  text = text.replace(videoDimensionPattern, " ");
  text = text.replace(videoSourceCleanPattern, " ");
  text = text.replace(videoCodecPattern, " ");
  text = text.replace(videoAudioCleanPattern, " ");
  text = text.replace(videoLanguagePairPattern, " ");
  text = text.replace(videoEditionPattern, " ");
  text = text.replace(videoPlatformPattern, " ");
  text = text.replace(videoFileSizePattern, " ");
  text = text.replace(videoResourceCleanPattern, " ");
  text = removeTrailingMetadataResidue(text);
  text = text.replace(videoReleaseTagPattern, " ");
  text = text.replace(titleSeasonRangeTextPattern, " ");
  text = text.replace(trailingCollectionRangeTextPattern, " ");
  text = text.replace(trailingBracketlessVersionTagPattern, " ");
  text = truncateTitleAtMetadataSuffix(text);
  text = removeTrailingNoiseNumber(text, rawValue);
  text = text.replace(trailingDashPattern, " ");
  text = text.replace(leadingPunctuationPattern, " ");
  text = text.replace(trailingPunctuationPattern, " ");
  text = text.replace(trailingCollectionRangeTextPattern, " ");
  return FlymbyVideoTitleCleaner.cleanTitle(collapseTitleSpaces(text));
}

/** 移除 APP 支持的资源短前缀，例如“BD-片名”和“1-1_片名”。 */
function stripLeadingResourcePrefix(value: string): string {
  const match = leadingResourcePrefixPattern.exec(value);
  if (!match) return value;
  const prefix = match[1] ?? ""; // 关键变量：前缀必须是短英文资源标记或“数字-数字”。
  const rest = String(match[2] ?? "").trim();
  if (!rest) return value;
  return prefix.includes("-") || prefix.length > 1 || /^[\u4e00-\u9fa5]/u.test(rest) ? rest : value;
}

/** 循环清理连续出现的电影、节目和动漫分类词。 */
function removeTitleCategoryNoise(value: string): string {
  let text = String(value ?? "");
  let previousText = ""; // 关键变量：连续分类词需要多轮替换，直到结果稳定。
  while (previousText !== text) {
    previousText = text;
    text = text.replace(titleCategoryNoisePattern, " ");
  }
  return text;
}

/** 清理资源标签被拆分后遗留在标题末尾的独立短词。 */
function removeTrailingMetadataResidue(value: string): string {
  let text = String(value ?? "");
  let previousText = ""; // 关键变量：同一标题可能连续遗留多个短词。
  while (previousText !== text) {
    previousText = text;
    text = text.replace(/(?:^|\s)(?:简英|繁英|单集|共|附全系列|附系列|附全集)\s*$/u, " ");
  }
  return text;
}

/** 在明确类型元数据开始处截断标题，避免剧情、动作等标签参与 TMDB 查询。 */
function truncateTitleAtMetadataSuffix(value: string): string {
  const text = collapseTitleSpaces(value);
  const match = titleMetadataSuffixPattern.exec(text);
  const title = String(match?.[1] ?? "").trim();
  if (!title || title.length < 2 || isWeakFlymbyScrapeTitle(title)) return value;
  return title;
}

/** 资源规格清理后若遗留独立尾部数字，则按 APP 规则继续删除。 */
function removeTrailingNoiseNumber(value: string, rawValue: string): string {
  let text = collapseTitleSpaces(value);
  if (!/[A-Za-z\u4e00-\u9fa5]/u.test(text)) return value;
  // 关键变量：只有原始名称确实包含资源或发布信息时，尾部数字才视为清洗残留。
  const hasResourceContext = testGlobalPattern(videoFileSizePattern, rawValue)
    || testGlobalPattern(videoResourceCleanPattern, rawValue)
    || testGlobalPattern(videoReleaseTagPattern, rawValue)
    || testGlobalPattern(videoAudioCleanPattern, rawValue)
    || testGlobalPattern(videoSourceCleanPattern, rawValue);
  if (!hasResourceContext) return value;
  let match = /^(.*\S)\s+\d{1,4}$/u.exec(text);
  while (match?.[1] && /[A-Za-z\u4e00-\u9fa5]/u.test(match[1])) {
    text = match[1];
    match = /^(.*\S)\s+\d{1,4}$/u.exec(text);
  }
  return text;
}

/** 安全执行带全局标记的正则，避免 lastIndex 污染后续解析。 */
function testGlobalPattern(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  const matched = pattern.test(value);
  pattern.lastIndex = 0;
  return matched;
}

/** 折叠标题中的连续空白。 */
function collapseTitleSpaces(value: string): string {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

/** 判断清理后的标题是否可用于刮削。 */
function isUsableTitle(value: string): boolean {
  return Boolean(value)
    && !categoryDirectoryPattern.test(value)
    && !isIgnoredDirectoryTitle(value)
    && !isSpecialEpisodeContainerTitle(value)
    && !isStoryArcContainerTitle(value)
    && !FlymbyVideoTitleCleaner.isGenericBucketTitle(value)
    && !isWeakFlymbyScrapeTitle(value);
}

/** 过滤 APP 明确不允许作为片名或剧名的年份桶、求片目录和推广目录。 */
function isIgnoredDirectoryTitle(value: string): boolean {
  const raw = String(value ?? "").trim();
  const normalized = FlymbyVideoTitleCleaner.normalizeSearchText(raw);
  return genericYearBucketTitlePattern.test(raw)
    || genericYearBucketTitlePattern.test(normalized)
    || normalized === "人人影视"
    || /^(?:年份未标|年代未标|年代未详|年份未知|未知年份|之前|以前|以后|之后|求片|求片求片|求片求片求片|未分类|其他|公众号)$/u.test(normalized)
    || normalized.startsWith("公众号 ")
    || normalized.includes(" 公众号 ");
}

/** 过滤剧场版、特别篇和番外等单独容器目录，避免覆盖真正节目名称。 */
function isSpecialEpisodeContainerTitle(value: string): boolean {
  const normalized = FlymbyVideoTitleCleaner.normalizeSearchText(value);
  return /^(?:剧场版|劇場版|特别篇|番外)(?:\s|$)/u.test(normalized);
}

/** 过滤 APP 中已知的故事篇章容器目录，避免把篇章名当成节目名。 */
function isStoryArcContainerTitle(value: string): boolean {
  const raw = String(value ?? "").trim();
  const title = FlymbyVideoTitleCleaner.cleanTitle(raw);
  if (!title.endsWith("篇")) return false;
  return /^\d{1,3}[\s._\-–—:：]*[\u4e00-\u9fa5]{1,12}篇$/u.test(raw)
    || /^(?:月红篇|王权篇|竹业篇|尾生篇|南国篇|千颜篇|沐天城篇|金晨曦篇|无暮篇)$/u.test(title);
}

/** 从季目录读取季号，未声明时与 APP 一样默认为第 1 季。 */
function resolveSeasonNumber(filePath: string, fallback: number): number {
  const directories = directoryPartsForFile(filePath);
  for (let index = directories.length - 1; index >= 0; index -= 1) {
    const match = seasonDirectoryPattern.exec(directories[index]!);
    if (match) return Number(match[1] ?? parseChineseNumber(match[2] ?? ""));
  }
  return fallback > 0 ? fallback : 1;
}

/** 找到距离文件最近的季目录。 */
function findSeasonDirectoryIndex(parts: string[]): number {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (seasonDirectoryPattern.test(parts[index]!)) return index;
  }
  return -1;
}

/** 提取目录部分，并过滤 URL 的空段。 */
function directoryPartsForFile(filePath: string): string[] {
  return path.posix.dirname(normalizeMediaPath(filePath)).split("/").filter(Boolean);
}

/** 判断文件是否位于扫描根的子目录，用于分类目录推断。 */
function isNestedBelowRoot(filePath: string, rootPath: string): boolean {
  const parent = path.posix.dirname(normalizeMediaPath(filePath));
  const root = normalizeMediaPath(rootPath).replace(/\/+$/u, "") || "/";
  return root === "/" ? parent !== "/" : parent !== root && parent.startsWith(`${root}/`);
}

/** 从节目文件路径提取节目首播年份，返回 0 表示节目目录存在但没有首播年份。 */
function resolveSeriesYearFromPath(filePath: string, seriesTitle: string): number | null {
  const directories = directoryPartsForFile(filePath);
  const seasonIndex = findSeasonDirectoryIndex(directories);
  if (seasonIndex > 0) {
    const parentYear = extractYear(directories[seasonIndex - 1]!);
    if (parentYear !== null) return parentYear;
  }
  const normalizedSeriesTitle = FlymbyVideoTitleCleaner.normalizeSearchText(seriesTitle);
  let matchedSeasonScopedTitle = false; // 关键变量：匹配到分季目录后继续向上查找节目根目录。
  for (let index = directories.length - 1; index >= 0; index -= 1) {
    const folderName = directories[index]!;
    if (FlymbyVideoTitleCleaner.normalizeSearchText(cleanSeriesTitle(folderName)) !== normalizedSeriesTitle) continue;
    const isSeasonScopedFolder = /(?:第\s*[0-9一二三四五六七八九十两]{1,3}\s*[季部]|(?:season|series|s)\s*\d{1,2})/iu.test(folderName);
    if (isSeasonScopedFolder) {
      matchedSeasonScopedTitle = true;
      continue;
    }
    const folderYear = extractYear(folderName);
    if (folderYear !== null) return folderYear;
    return 0;
  }
  return matchedSeasonScopedTitle ? 0 : null;
}

/** 从叶子目录向上读取最近年份，遇到明确媒体分类桶后停止。 */
function extractNearestPathYear(filePath: string): number | null {
  const directories = directoryPartsForFile(filePath);
  for (let index = directories.length - 1; index >= 0; index -= 1) {
    const folderName = directories[index]!;
    if (seasonDirectoryPattern.test(folderName)) continue;
    if (categoryDirectoryPattern.test(folderName) || isGenericMediaRootDirectoryName(folderName)) return null;
    const folderYear = extractYear(folderName);
    if (folderYear !== null) return folderYear;
  }
  return null;
}

/** 只读取与当前电影标题相同目录上的年份，禁止越级采用上层节目年份。 */
function extractMatchingMovieTitleYearFromPath(filePath: string, movieTitle: string): number | null {
  const normalizedMovieTitle = FlymbyVideoTitleCleaner.normalizeSearchText(movieTitle);
  if (!normalizedMovieTitle) return null;
  const directories = directoryPartsForFile(filePath);
  for (let index = directories.length - 1; index >= 0; index -= 1) {
    const folderName = directories[index]!;
    if (FlymbyVideoTitleCleaner.normalizeSearchText(cleanMovieTitle(folderName)) !== normalizedMovieTitle) continue;
    return extractYear(folderName);
  }
  return null;
}

/** 读取普通文件名或“.mkv”这种仅扩展名文件的后缀。 */
function readVideoExtension(fileName: string): string {
  const value = String(fileName ?? "").trim();
  if (/^\.[A-Za-z0-9]{2,8}$/u.test(value)) return value.slice(1);
  return path.posix.extname(value).slice(1);
}

/** E 标记不能把 1900 到 2099 的年份当成集号。 */
function isUsableEpisodeMarkerNumber(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= 5000 && (value < 1900 || value > 2099);
}

/** 判断文件名是否以 H.264、H265、x264 或 x265 等编码编号结尾。 */
function endsWithVideoCodecNumber(value: string): boolean {
  return /(?:^|[\s._\-])(?:h|x)[\s._\-]*26[45]\s*$/iu.test(String(value ?? ""));
}

/** 过滤“影视资源大合集”一类扫描根目录，避免其覆盖真实电影文件名。 */
function isGenericMediaRootDirectoryName(value: string): boolean {
  const text = FlymbyVideoTitleCleaner.normalizeSearchText(value);
  return /(?:影视|电影|影片).*资源.*(?:合集|大全)/u.test(text)
    || /资源大合集/u.test(text)
    || /(?:影视资源大|资源大)\s*\d*$/u.test(text);
}

/** 读取文件名或路径中的最后一个有效年份，兼容片名本身带年份的情况。 */
function extractYear(value: string): number | null {
  yearPattern.lastIndex = 0;
  let lastYear: number | null = null;
  let match = yearPattern.exec(value);
  while (match) {
    const yearText = match[1] ?? "";
    const yearIndex = match.index + match[0].indexOf(yearText);
    const remainingText = value.slice(yearIndex + yearText.length);
    if (!(yearIndex === 0 && /^\s*[:：]/u.test(remainingText))) {
      lastYear = yearText ? Number(yearText) : lastYear;
    }
    yearPattern.lastIndex = yearIndex + yearText.length;
    match = yearPattern.exec(value);
  }
  yearPattern.lastIndex = 0;
  return lastYear;
}

/** 提取末尾发布组，但不把普通中文标题当作发布组。 */
function extractReleaseGroup(value: string): string {
  const match = /-([A-Za-z0-9._]{2,32})$/u.exec(value);
  return match?.[1] ?? "";
}

/** 去除最多三层已知视频扩展名。 */
function removeKnownVideoExtension(fileName: string): string {
  let value = String(fileName ?? "").trim();
  for (let count = 0; count < 3; count += 1) {
    const dotIndex = value.lastIndexOf(".");
    if (dotIndex === 0) {
      return videoExtensionPattern.test(value.slice(1)) ? "" : value;
    }
    if (dotIndex <= 0) break;
    const extension = value.slice(dotIndex + 1);
    if (!videoExtensionPattern.test(extension)) break;
    value = value.slice(0, dotIndex);
  }
  return value;
}

/** 仅保留有效且不重复的集号。 */
function normalizeEpisodeNumbers(values: number[]): number[] {
  return [...new Set(values.filter((value) => Number.isInteger(value) && value > 0 && value <= 5000))];
}

/** 解析十以内及“十、十一、二十”等中文数字。 */
function parseChineseNumber(value: string): number {
  const digits: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const text = String(value ?? "").trim();
  if (/^\d+$/u.test(text)) return Number(text);
  if (digits[text] !== undefined) return digits[text];
  const tenIndex = text.indexOf("十");
  if (tenIndex < 0) return 0;
  const tens = tenIndex === 0 ? 1 : (digits[text.slice(0, tenIndex)] ?? 0);
  const onesText = text.slice(tenIndex + 1);
  const ones = onesText ? (digits[onesText] ?? 0) : 0;
  return tens > 0 ? tens * 10 + ones : 0;
}

/** 统一 Provider 路径分隔符。 */
function normalizeMediaPath(value: string): string {
  const normalized = `/${String(value ?? "").replace(/\\/gu, "/").replace(/^\/+|\/+$/gu, "")}`;
  return normalized === "/" ? normalized : normalized.replace(/\/{2,}/gu, "/");
}
