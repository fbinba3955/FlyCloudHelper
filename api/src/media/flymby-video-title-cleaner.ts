/**
 * Flymby APP 同源的视频标题清洗器。
 * 只清理用于识别和刮削的查询词，不修改 Provider 返回的真实文件路径。
 */
export class FlymbyVideoTitleCleaner {
  private static readonly bracketPattern = /[\[\]\(\){}【】（）〖〗『』《》「」]/gu;
  private static readonly separatorPattern = /[._+\-–—:：,，;；/\\|·•]+/gu;
  private static readonly cjkObfuscationJoinerPattern = /([\u4e00-\u9fa5])\s*(?:丨|👉|👈|👇|👆|🤜|[.．])\s*(?=[\u4e00-\u9fa5])/gu;
  private static readonly explicitTmdbIdPattern = /[\{\[\(【（]?\s*(?:tmdbid|tmdb)\s*[-_:：=]?\s*\d{2,10}\s*[\}\]\)】）]?/giu;
  private static readonly subtitleGroupBracketPattern = /[\[\(【（〖『《「][^\]\)】）〗』》」]{0,64}(?:字幕组|字幕社|压制组|翻译组)[^\]\)】）〗』》」]{0,64}[\]\)】）〗』》」]/giu;
  private static readonly collectionRangePattern = /(?:^|[\s._+\-–—:：,，;；/\\|·•])(?:\d{1,4}\s*(?:-|–|—|~|至|到|\s+)\s*\d{1,4}\s*(?:季|集|部)?|第\s*[0-9一二三四五六七八九十两]{1,3}\s*季(?:\s*\d{1,4}\s*(?:-|–|—|~|至|到|\s+)\s*\d{1,4}\s*集?)?|第\s*[0-9一二三四五六七八九十两]{1,3}\s*部|(?:season|series|s)\s*\d{1,2})(?:$|[\s._+\-–—:：,，;；/\\|·•])/giu;
  private static readonly resourceTagPattern = /(?:REMUX\s*蓝光原盘|蓝光原盘|高码率|高码版|普码版|低码版|码率|高码|净版|纯净版|臻彩|国粤英三语|国粤日三语|国粤日多音轨|国粤英日四语|国粤双语|国英双语|中英双字|中英字幕|国语中字|官方中字|内嵌特效|特效字幕|中文字幕|英文字幕|简繁英字幕|简繁中字|简繁|繁中|简中|简英|繁英|中字|粤语版|国语版|英语版|日语版|韩语版|多音轨|音轨|字幕|翡翠台源码|源码|附全系列|附系列|附全集|大包不错集数|国映\s*TV|动态漫画|动态漫|已更最新集|持续更新|长期更新|备用|正片|完整版|全集|单集|完结|已完结|更至\s*\d{1,4}\s*集|更新至\s*\d{1,4}\s*集|更新中)/giu;
  private static readonly videoTechPattern = /\b(?:4k|8k|2160[pi]|1080[pi]|720[pi]|480[pi]|uhd|fhd|full\s*hd|hdr10\+?|hdr|sdr|edr|dv|dolby\s*vision|hq|raw|clean|\d{2,3}\s*fps|web[-.\s]?dl|web[-.\s]?rip|webrip|bluray|blu[-.\s]?ray|bdrip|hdtv|dvdrip|bd\s*remux|bdremux|remux|x\s*\.?\s*26[45]|h\s*\.?\s*26[45]|hevc|avc|vc[-.\s]?1|10\s*bit|8\s*bit|aac|ddp?(?:\s*\d(?:[.\s]\d)?)?|eac3|e-ac3|dts[-.\s]*hd(?:[-.\s]*ma)?|dts[-.\s]*hdma(?:\s*\d(?:[.\s]\d)?)?|hdma(?:\s*\d(?:[.\s]\d)?)?|dts|truehd|atmos|flac(?:\s*\d(?:[.\s]\d)?)?|lpcm|pcm(?:\s*\d(?:[.\s]\d)?)?|ac3|av3a(?:\s*\d(?:[.\s]\d)?)?|chs|cht|dual|multi|\d+\s*audios?|hami|wavve|fandango)\b/giu;
  private static readonly videoEditionPattern = /\b(?:proper|repack|extended|uncut|director'?s\s*cut|multi|dual|chs|cht|subbed|v\d+)\b/giu;
  private static readonly videoPlatformPattern = /\b(?:nf|netflix|amzn|amazon|dsnp|disney|hulu|hmax|max|itunes|apple\s*tv|hami|wavve|fandango)\b/giu;
  private static readonly videoDimensionPattern = /\b\d{3,4}\s*[xX×]\s*\d{3,4}\b/gu;
  private static readonly videoFileSizePattern = /\b\d+(?:\.\d+)?\s*(?:GB|G|MB|M)\b/giu;
  private static readonly videoLanguagePairPattern = /(?:^|[\s._\-–—:：])(?:Mandarin|Cantonese)\s*(?:&|and)\s*(?:Mandarin|Cantonese)(?=$|[\s._\-–—:：])/giu;
  private static readonly videoResourceCleanPattern = /(?:杜比视界|高码率|高码版|高码|码率|帧率版本|臻彩|内封简繁|内封|中文字幕|双语字幕|特效字幕|歌词字幕|繁英字幕|简英双语|简繁英字幕|简繁双语|中英字幕|英文字幕|纯净版|无水印|完整版|全集|特辑|国英多音轨|国粤英三语|国粤日三语|国粤日多音轨|国英双语|多音轨|音轨|配音|字幕|国映\s*TV|大包不错集数|动态漫画|动态漫|片名水印|水印|单集\s*\d{1,4}\s*分钟|豆瓣|DIY|共\s*\d{1,4}\s*集(?:全)?|全\s*\d{1,4}\s*集|\d{1,4}\s*集全|完结|已完结|更至\s*\d{1,4}\s*集|更新至\s*\d{1,4}\s*集|更新中|(?:^|[\s._\-–—:：])(?:简繁中字|简繁|繁中|简中|中字|国语|国配|粤语|英语|日语|韩语|官中|国英|国粤英|国粤日|中英|Mandarin|Cantonese|Korean|Japanese|English|CHS|CHT|CHS-ENG|ENG)(?:$|[\s._\-–—:：]))/giu;
  private static readonly releaseGroupPattern = /\b(?:HiveWeb|HHWEB|HDSWEB|CMCT|CHD|FRDS|WiKi|NTb|BTN|PTer|PTerWEB|OurTV|ADWeb|BillionMeta|BlackTV|MOMOWEB|VARYG|CTRLWEB|EDITH|HONE|MTeam|PandaQT|QuickIO|DreamHD|ParkHD|ZeroTV|ColorTV|FROGWeb|MiniTV|MiniHD|MNHD|HDWinG|SONYHD|HQC|XLYS|Mp4Ba|Mp4Fan|QHstudIo|QHstudio|OFA|OPS|LGNB|oSpecialCN|HDSky|CHDBits|BOTHD|BestWEB|HAN|CHAOSPACE|TAGWEB|FGT|HDT|DHTCLUB|AngelaBaby|GY|CHN|NAHOM|SGF|MgB|playBD|RARBG|DirtyHippie|KAIZEN|Telly|MHDVV|KHN|HDCTV)\b/giu;
  private static readonly categoryPrefixPattern = /(?:^|[\s._+\-–—:：,，;；/\\|·•]+)(?:华语剧|华语电影|国剧|国产剧|国产|国影|美影|美剧|英剧|日剧|韩剧|港剧|台剧|泰剧|陆剧|短剧|网剧|电影|影片|院线|动漫网剧|国产动漫|日韩动漫|欧美动漫|日漫|美漫|国漫|动漫|动画|综艺|纪录片)(?=$|[\s._+\-–—:：,，;；/\\|·•]+)/giu;
  private static readonly genericBucketPattern = /^(?:[A-Za-z]|数字开头|电影和电视剧|盘\d*电影|院线|正片|原盘|蓝光原盘|国影|影片|电影|视频|电视剧|剧集|欧美剧|日韩剧|华语剧|海外媒体流|无字片源|普码|高码|粤语版|国语版|国粤双语|动漫网剧|国产动漫|日韩动漫|欧美动漫|日漫|美漫|国漫|高能反转爽片|超清|高清|超高清|超高清SDR|4K|4K60帧|1080P|720P|专题|合集|系列|其他|未分类)$/iu;
  /** 短剧目录开头用于排序的序号，仅在数字后有明确分隔符时移除。 */
  private static readonly videoMetadataLeadingOrderPattern = /^\s*0*\d{1,4}\s*[.．、_+\-–—:：]\s*/u;
  /** 短剧总集数及其后的演员、版本和类型文本，集数会单独保留给候选匹配。 */
  private static readonly videoMetadataEpisodeSuffixPattern = /[\[\(【（]?\s*\d{1,4}\s*集\s*[\]\)】）]?.*$/iu;
  /** 短剧类型标签，只在独立前后缀位置清理，避免删除剧名中的普通文字。 */
  private static readonly videoMetadataTypePattern = /(?:^|[\s._+\-–—:：,，;；/\\|·•\[\]\(\){}【】（）]+)(?:微短剧|真人短剧|动画短剧|动态漫画|动态漫|有声漫画|有声漫|短剧|漫剧)(?=$|[\s._+\-–—:：,，;；/\\|·•\[\]\(\){}【】（）]+)/giu;
  /** AI 短剧和 AI 漫剧常与日期目录直接相连，需要无条件清理。 */
  private static readonly videoMetadataAiTypePattern = /(?:AI\s*短剧|AI\s*漫剧)/giu;
  /** 带有明确“主演/演员”标记的人员后缀。 */
  private static readonly videoMetadataExplicitActorSuffixPattern = /(?:^|[\s._+\-–—:：,，;；/\\|]+)(?:领衔主演|主演|演员|主角)\s*[:：]?\s*.*$/iu;
  /** 无集数标记时常见的“剧名 演员A＆演员B”后缀。 */
  private static readonly videoMetadataActorPairSuffixPattern = /^(.*[\u4e00-\u9fa5A-Za-z0-9])\s+[\u4e00-\u9fa5·]{2,8}\s*[&＆]\s*[\u4e00-\u9fa5·]{2,8}(?:\s*[&＆]\s*[\u4e00-\u9fa5·]{2,8})*\s*$/u;
  /** 插件查询中不需要保留的标点与特殊符号。 */
  private static readonly videoMetadataSpecialSymbolPattern = /[\[\]\(\){}【】（）〖〗『』《》「」._+\-–—:：,，;；/\\|·•!！?？@#￥$%^*=<>＆&]+/gu;

  /** 生成用于候选评分和任务聚合的比较文本。 */
  public static normalizeSearchText(value: string): string {
    return this.collapseSpaces(String(value ?? "")
      .toLocaleLowerCase("zh-CN")
      .replace(this.bracketPattern, " ")
      .replace(this.separatorPattern, " "));
  }

  /** 清理普通片名或剧名，保留真正用于 TMDB 搜索的部分。 */
  public static cleanTitle(value: string): string {
    const rawText = String(value ?? "");
    let text = rawText;
    text = this.stripExplicitTmdbIdText(text);
    text = this.stripObfuscationJoiners(text);
    text = this.stripSubtitleGroupBrackets(text);
    text = this.stripTrailingSupplementAndSeasonRange(text);
    text = this.stripTrailingRating(text);
    text = this.stripTrailingCollectionRange(text);
    text = text.replace(this.collectionRangePattern, " ");
    text = text.replace(this.categoryPrefixPattern, " ");
    text = this.stripResourceTags(text);
    text = text.replace(this.bracketPattern, " ");
    text = text.replace(this.separatorPattern, " ");
    text = this.stripIsolatedConnectors(text);
    text = this.stripLeadingSingleLetterTitlePrefix(text);
    text = this.stripTrailingYearAndSeason(text);
    text = this.stripTrailingProgramFormat(text);
    text = this.stripTrailingReleaseDescriptors(text, rawText);
    text = this.stripTrailingNoiseNumber(text, rawText);
    text = this.stripTrailingMetadataResidue(text);
    text = this.collapseSpaces(text);
    return this.isGenericBucketTitle(text) ? "" : text;
  }

  /** 按 APP 规则构建视频元数据插件的纯标题查询词。 */
  public static cleanVideoMetadataSearchQuery(value: string): string {
    let text = String(value ?? "").trim();
    if (!text) return "";
    text = this.stripExplicitTmdbIdText(text);
    text = this.stripObfuscationJoiners(text);
    text = text.replace(this.videoMetadataLeadingOrderPattern, " ");
    text = text.replace(this.videoMetadataEpisodeSuffixPattern, " ");
    text = text.replace(this.videoMetadataExplicitActorSuffixPattern, " ");
    const actorPairMatch = this.videoMetadataActorPairSuffixPattern.exec(text);
    if (actorPairMatch?.[1]) {
      text = actorPairMatch[1];
    }
    text = text.replace(this.videoMetadataAiTypePattern, " ");
    text = text.replace(this.videoMetadataTypePattern, " ");
    text = text.replace(this.videoMetadataSpecialSymbolPattern, " ");
    text = this.collapseSpaces(text);
    text = text.replace(/^0*\d{1,4}\s+(?=[\u4e00-\u9fa5A-Za-z])/u, "");
    text = text.replace(/\s+(?:19|20)\d{2}$/u, "");
    text = this.collapseSpaces(text);
    if (/^\d{1,2}月\d{1,2}日$/u.test(text)) return "";
    return this.isGenericBucketTitle(text) ? "" : text;
  }

  /** 生成 APP 相同语义的简化 TMDB 备用查询词。 */
  public static buildAlternateTmdbSearchQuery(query: string): string {
    const raw = String(query ?? "").trim();
    const text = this.cleanTitle(raw);
    const aliasMatch = /(?:^|\s)AKA\s+(.+)$/iu.exec(text);
    if (aliasMatch?.[1]) {
      const aliasTitle = this.collapseSpaces(aliasMatch[1]); // 关键变量：AKA 后可独立查询的别名。
      if (aliasTitle.length > 1 && !this.isGenericBucketTitle(aliasTitle)) return aliasTitle;
    }
    const bilingualQuery = this.buildBilingualQuery(text);
    if (bilingualQuery) return bilingualQuery;
    if (!text || this.normalizeSearchText(text) === this.normalizeSearchText(raw)) return "";
    return text;
  }

  /**
   * 使用原始文件名中的年份和资源规格上下文，清理已经预处理过的电影标题尾词。
   * 该入口不会重新执行整套标题归一化。
   */
  public static stripContextualMovieReleaseDescriptors(title: string, rawValue: string): string {
    return this.collapseSpaces(this.stripTrailingReleaseDescriptors(title, rawValue));
  }

  /** 判断内容是否只是分类桶、范围目录或资源说明，不能用于刮削。 */
  public static isGenericBucketTitle(value: string): boolean {
    const title = this.collapseSpaces(String(value ?? ""));
    if (!title) return true;
    const titleWithoutResource = this.collapseSpaces(this.stripResourceTags(title)
      .replace(this.bracketPattern, " ")
      .replace(this.separatorPattern, " "));
    const normalizedTitle = this.normalizeSearchText(titleWithoutResource);
    if (/^(?:(?:第\s*)?\d{1,4}\s*季\s*)?\d{1,4}\s+\d{1,4}\s*(?:集|话|話)?$/u.test(normalizedTitle)) return true;
    if (/^(?:我的\s*)?活动中心.*(?:免费|空间|免流)/u.test(normalizedTitle)) return true;
    if (/(?:不限速.*库|最全库|资源库|片库)\d*$/u.test(normalizedTitle)) return true;
    return this.testPattern(this.genericBucketPattern, title);
  }

  /** 判断文件名是否主要由清晰度、音轨等组成，应改用父目录片名。 */
  public static shouldPreferDirectoryTitle(fileName: string, parsedTitle: string, parentTitle: string): boolean {
    if (this.isGenericBucketTitle(parentTitle)) return false;
    const cleanedParsedTitle = this.cleanTitle(parsedTitle);
    if (!cleanedParsedTitle || this.isGenericBucketTitle(cleanedParsedTitle)) return true;
    const parentHasChineseTitle = /[\u4e00-\u9fa5]/u.test(parentTitle);
    const titleHasChinese = /[\u4e00-\u9fa5]/u.test(parsedTitle);
    const fileText = `${fileName} ${parsedTitle}`;
    const hasResourceNoise = this.hasResourceNoise(fileText);
    if (parentHasChineseTitle && !titleHasChinese && hasResourceNoise) return true;
    return hasResourceNoise && !this.cleanTitle(fileText);
  }

  /** 移除文件名或目录中的显式 TMDB ID 文本。 */
  public static stripExplicitTmdbIdText(value: string): string {
    return this.collapseSpaces(String(value ?? "").replace(this.explicitTmdbIdPattern, " "));
  }

  /** 移除夹在汉字之间的规避分隔符，例如“祝丨你好运”“走走👉停停”。 */
  private static stripObfuscationJoiners(value: string): string {
    return String(value ?? "").replace(this.cjkObfuscationJoinerPattern, "$1");
  }

  /** 整块移除字幕组括号，避免只剩“UNION 组”一类错误标题。 */
  private static stripSubtitleGroupBrackets(value: string): string {
    return String(value ?? "").replace(this.subtitleGroupBracketPattern, " ");
  }

  /** 删除资源标签清理后遗留的孤立连接符，不影响正常英文片名中的 &。 */
  private static stripIsolatedConnectors(value: string): string {
    return String(value ?? "").replace(/(?:^|\s)[&＆](?=\s|$)/gu, " ");
  }

  /** 删除节目名末尾的播出形式说明，只处理明确尾缀。 */
  private static stripTrailingProgramFormat(value: string): string {
    return String(value ?? "")
      .replace(/([\u4e00-\u9fa5]{2,})(?:年番|季番)$/gu, "$1")
      .replace(/(?:^|\s)(?:年番|季番|周更|日更)\s*$/gu, " ");
  }

  /** 只在存在年份或资源规格时，从标题尾部移除发行地区、版本和制作组描述。 */
  private static stripTrailingReleaseDescriptors(value: string, rawValue: string): string {
    const raw = String(rawValue ?? "");
    const hasTechnicalReleaseContext = this.testPattern(this.videoTechPattern, raw)
      || this.testPattern(this.releaseGroupPattern, raw);
    const hasReleaseContext = /(?:19|20)\d{2}/u.test(raw) || hasTechnicalReleaseContext;
    if (!hasReleaseContext) return value;
    let text = this.collapseSpaces(value);
    let previous = "";
    while (previous !== text) {
      previous = text;
      text = text.replace(/(?:^|\s)(?:Open\s+Matte|Collector'?s\s+Edition|(?:\d{1,3}(?:st|nd|rd|th)\s+)?Anniversary\s+Remastered\s+Edition|Remastered\s+Edition|Remastered|THEATRICAL|COMPLETE|Hybrid|IMAX|BDRemux|Ai\s+Upscaled|RIFE(?:\s+\d+(?:\s+\d+v?\d*)?)?|DoVi|HDR10Plus|泰吉修复|修复)\s*$/iu, " ");
      if (hasTechnicalReleaseContext) {
        text = text.replace(/(?:^|\s)(?:CC|DC|USA|JPN|KOR|KOREA|GER|GBR|ESP|HIN|TAM|FRE|ITA|SPA|POR|HUN|RUS|UKR|ENG|MOC|BFI|FRD|iT|HS|H|国语|粤语|英语|日语|韩语)\s*$/iu, " ");
        text = text.replace(/(?:^|\s)(?:NAHOM|SGF|MgB|playBD|RARBG|DirtyHippie|KAIZEN|Telly|MHDVV|KHN|HDCTV)\s*$/iu, " ");
      }
      text = this.collapseSpaces(text);
    }
    return text;
  }

  /** 移除片名末尾的“1-4 部/季/集”等合集范围。 */
  private static stripTrailingCollectionRange(value: string): string {
    return String(value ?? "").replace(/([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z\s]{0,80}?)\s*\d{1,3}\s*(?:-|–|—|~|至|到)\s*\d{1,3}\s*(?:部|季|集)?(?=$|[\s._+\-–—:：,，;；/\\|·•])/gu, "$1 ");
  }

  /** 移除目录末尾的附带内容数量和整季范围，不处理片名内部数字。 */
  private static stripTrailingSupplementAndSeasonRange(value: string): string {
    let text = String(value ?? "");
    text = text.replace(
      /\s*[\[\(【（]\s*附(?:前|第)?\s*\d{1,3}\s*(?:季|集|部)?\s*[\]\)】）]\s*$/iu,
      " ",
    );
    // 括号可能已被上游解析器清理，此处继续移除残留的“附1/附前/附第1季”。
    text = text.replace(
      /(?:^|[\s._+\-–—:：,，;；/\\|·•])附(?:前|第)?\s*\d{0,3}\s*(?:季|集|部)?\s*$/iu,
      " ",
    );
    text = text.replace(
      /(?:^|[\s._+\-–—:：,，;；/\\|·•])(?:全\s*\d{1,3}\s*季|S\s*\d{1,2}\s*(?:-|–|—|~|至|到)\s*S?\s*\d{1,2})\s*$/iu,
      " ",
    );
    return text;
  }

  /** 移除清晰度、编码、音轨、字幕和发布组标签。 */
  private static stripResourceTags(value: string): string {
    let text = String(value ?? "");
    text = text.replace(this.resourceTagPattern, " ");
    text = text.replace(this.videoTechPattern, " ");
    text = text.replace(this.videoDimensionPattern, " ");
    text = text.replace(this.videoFileSizePattern, " ");
    text = text.replace(this.videoLanguagePairPattern, " ");
    text = text.replace(this.videoEditionPattern, " ");
    text = text.replace(this.videoPlatformPattern, " ");
    text = text.replace(this.videoResourceCleanPattern, " ");
    text = text.replace(this.releaseGroupPattern, " ");
    text = text.replace(/(?:4\s*k|8\s*k)?\s*(?:hq|hdr|sdr|edr)?\s*(?:60|120)?\s*fps/giu, " ");
    text = text.replace(/\d{2,3}\s*帧/giu, " ");
    text = text.replace(/([\u4e00-\u9fa5A-Za-z])(?:2160|1080|720|480)(?=$|[\s._+\-–—:：,，;；/\\|·•])/giu, "$1 ");
    text = text.replace(/(?:超高清|高清|超清|高码率|高码版|高码|码率|帧率)/giu, " ");
    text = text.replace(/(?:^|[\s._+\-–—:：,，;；/\\|·•])率(?=$|[\s._+\-–—:：,，;；/\\|·•])/gu, " ");
    return text;
  }

  /** 移除“豆瓣 8.1、IMDb 7.5、国7.5”等明确评分尾缀。 */
  private static stripTrailingRating(value: string): string {
    return String(value ?? "").replace(
      /(?:^|[\s._+\-–—:：,，;；/\\|·•])(?:豆瓣|imdb|国)\s*\d(?:\.\d)?\s*$/iu,
      " ",
    );
  }

  /** 资源规格被清理后，继续删除由码率、音轨等遗留的孤立尾部数字。 */
  private static stripTrailingNoiseNumber(value: string, rawValue: string): string {
    if (!this.hasResourceNoise(rawValue)) return value;
    let text = this.collapseSpaces(value);
    let match = /^(.*\S)\s+\d{1,4}$/u.exec(text);
    while (match?.[1] && /[A-Za-z\u4e00-\u9fa5]/u.test(match[1])) {
      text = match[1];
      match = /^(.*\S)\s+\d{1,4}$/u.exec(text);
    }
    return text;
  }

  /** 清理资源说明被拆分后残留在标题末尾的独立短词。 */
  private static stripTrailingMetadataResidue(value: string): string {
    let text = String(value ?? "");
    let previous = "";
    while (previous !== text) {
      previous = text;
      text = text.replace(/(?:^|\s)(?:简英|繁英|单集|共|附全系列|附系列|附全集)\s*$/u, " ");
    }
    return text;
  }

  /** 判断原文是否包含足以覆盖片名的资源标签。 */
  private static hasResourceNoise(value: string): boolean {
    const text = String(value ?? "");
    return this.testPattern(this.resourceTagPattern, text)
      || this.testPattern(this.videoTechPattern, text)
      || this.testPattern(this.videoDimensionPattern, text)
      || this.testPattern(this.videoFileSizePattern, text)
      || this.testPattern(this.videoResourceCleanPattern, text)
      || this.testPattern(this.releaseGroupPattern, text)
      || /(?:4\s*k|8\s*k|超高清|高清|超清|高码率|高码|码率|帧率)/iu.test(text);
  }

  /** 移除中文标题前误切出的单字母前缀。 */
  private static stripLeadingSingleLetterTitlePrefix(value: string): string {
    return String(value ?? "").replace(/^\s*[A-Za-z]\s+(?=[\u4e00-\u9fa5])/gu, "").trim();
  }

  /** 移除标题末尾的年份和季度信息。 */
  private static stripTrailingYearAndSeason(value: string): string {
    let text = String(value ?? "");
    text = text.replace(/(?:^|[\s._\-–—:：])(?:19|20)\d{2}(?:$|[\s._\-–—:：])/gu, " ");
    text = text.replace(/([\u4e00-\u9fa5A-Za-z])(?:19|20)\d{2}$/gu, "$1 ");
    text = text.replace(/(?:第\s*)?[0-9一二三四五六七八九十两]{1,3}\s*季(?:$|[\s._\-–—:：].*)/giu, " ");
    text = text.replace(/(?:season|series|s)\s*\d{1,2}(?:$|[\s._\-–—:：].*)/giu, " ");
    return text;
  }

  /** 中英混排时提取中文部分作为 TMDB 备用查询。 */
  private static buildBilingualQuery(query: string): string {
    if (!/[\u4e00-\u9fa5]/u.test(query) || !/[A-Za-z]/u.test(query)) return "";
    const chineseOnly = this.collapseSpaces(query.replace(/[A-Za-z][A-Za-z0-9'’:&.\-\s]*/gu, " "));
    return chineseOnly && chineseOnly.length < query.length ? chineseOnly : "";
  }

  /** 折叠连续空白。 */
  private static collapseSpaces(value: string): string {
    return String(value ?? "").replace(/\s+/gu, " ").trim();
  }

  /** 避免复用全局正则时 lastIndex 影响结果。 */
  private static testPattern(pattern: RegExp, value: string): boolean {
    pattern.lastIndex = 0;
    const matched = pattern.test(value);
    pattern.lastIndex = 0;
    return matched;
  }
}
