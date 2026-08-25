import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { Knex } from "knex";
import { hashSessionToken } from "./auth.js";
import { parseJsonObject, type CatalogSort, type MediaItemRecord } from "./domain.js";
import { ApiError } from "./errors.js";
import type { ApiRuntime } from "./runtime.js";
import {
  parseCompletedMediaProbeResult,
  readJellyfinRunTimeTicks,
  type MediaProbeResult,
} from "./media/media-probe.js";

/** Jellyfin 媒体库和图片读取共用的服务上下文。 */
export interface JellyfinLibraryContext {
  serviceId: string;
  ownerUserId: string;
  libraryId: string;
}

export interface JellyfinContext extends JellyfinLibraryContext {
  accountId: string;
  accountUsername: string;
  accountHasPassword: boolean;
  /** 当前服务是否启用了视频规格分析。 */
  mediaSpecsEnabled: boolean;
  credentialRevision: number;
  accessToken: string;
}

interface JellyfinFileSummary {
  fileId: string;
  name: string;
  size: number;
  /** 当前源文件已经完成的 ffprobe 结果；未开启或仍在队列时为空。 */
  mediaProbe: MediaProbeResult | null;
}

interface JellyfinItemMappingContext {
  progressByItemId: Map<string, Record<string, unknown>>;
  filesByItemId: Map<string, JellyfinFileSummary[]>;
}

type JellyfinCollectionType = "movies" | "tvshows";

interface JellyfinLibraryDefinition {
  id: string;
  name: string;
  collectionType: JellyfinCollectionType;
  itemType: "video.movie" | "video.series";
}

interface JellyfinGenreSummary {
  name: string;
  itemCount: number;
}

interface JellyfinSeasonReference {
  seriesId: string;
  seasonNumber: number;
}

/** 读取服务当前元数据配置中的视频规格分析开关。 */
function isJellyfinMediaSpecsEnabled(profileJson: unknown): boolean {
  const profile = parseJsonObject(profileJson);
  const profiles = profile.profiles && typeof profile.profiles === "object" && !Array.isArray(profile.profiles)
    ? profile.profiles as Record<string, unknown>
    : {};
  const videoProfile = profiles.video && typeof profiles.video === "object" && !Array.isArray(profiles.video)
    ? profiles.video as Record<string, unknown>
    : {};
  return videoProfile.analyzeMediaSpecs === true;
}

/** 把目录文件映射为不包含转码能力的标准 Jellyfin MediaSourceInfo。 */
function mapCatalogMediaSource(file: JellyfinFileSummary, mediaSpecsReady: boolean): Record<string, unknown> {
  const fileName = String(file.name || "video.mp4");
  const mediaProbe = mediaSpecsReady ? file.mediaProbe : null;
  const fileRunTimeTicks = mediaProbe?.runTimeTicks ?? 0;
  return {
    Protocol: "File",
    Id: file.fileId,
    Path: fileName,
    EncoderPath: null,
    EncoderProtocol: null,
    Type: "Default",
    Container: mediaProbe?.container || undefined,
    Size: mediaProbe?.size || undefined,
    Name: fileName,
    IsRemote: false,
    ETag: null,
    RunTimeTicks: fileRunTimeTicks || undefined,
    ReadAtNativeFramerate: false,
    IgnoreDts: false,
    IgnoreIndex: false,
    GenPtsInput: false,
    SupportsTranscoding: false,
    SupportsDirectStream: true,
    SupportsDirectPlay: true,
    IsInfiniteStream: false,
    UseMostCompatibleTranscodingProfile: false,
    RequiresOpening: false,
    OpenToken: null,
    RequiresClosing: false,
    LiveStreamId: null,
    BufferMs: null,
    RequiresLooping: false,
    SupportsProbing: false,
    MediaStreams: mediaProbe?.mediaStreams ?? [],
    MediaAttachments: [],
    Formats: [],
    Bitrate: mediaProbe?.bitRate || undefined,
    RequiredHttpHeaders: {},
    TranscodingUrl: null,
    TranscodingSubProtocol: null,
    TranscodingContainer: null,
    AnalyzeDurationMs: null,
    DefaultAudioStreamIndex: null,
    DefaultSubtitleStreamIndex: null,
  };
}

/** 从 MediaBrowser 认证头或 Jellyfin 常见参数中读取访问令牌。 */
export function readJellyfinToken(request: FastifyRequest): string {
  const direct = request.headers["x-emby-token"] ?? request.headers["x-mediabrowser-token"];
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const query = request.query as Record<string, unknown> | undefined;
  const queryToken = query?.api_key ?? query?.ApiKey ?? query?.access_token;
  if (typeof queryToken === "string" && queryToken.trim()) return queryToken.trim();
  const authorization = request.headers.authorization ?? "";
  const match = authorization.match(/(?:Token|token)\s*=\s*"?([^",\s]+)"?/u);
  return match?.[1]?.trim() ?? "";
}

/** 读取认证头中的客户端和设备字段，仅用于会话展示。 */
function readAuthorizationAttribute(request: FastifyRequest, key: string): string | null {
  const mediaBrowserHeader = request.headers["x-emby-authorization"] ?? request.headers["x-mediabrowser-authorization"];
  const authorization = typeof mediaBrowserHeader === "string" ? mediaBrowserHeader : request.headers.authorization ?? "";
  const match = authorization.match(new RegExp(`${key}=(?:"([^"]*)"|([^,\\s]*))`, "iu"));
  return (match?.[1] ?? match?.[2])?.slice(0, 255) ?? null;
}

/** Jellyfin 协议的认证、目录和播放进度服务。 */
export class JellyfinCompatibilityService {
  // 关键变量：登录失败按服务和来源地址隔离，避免攻击一个服务影响其他服务。
  private readonly loginFailures = new Map<string, { count: number; firstFailedAt: number; blockedUntil: number }>();

  public constructor(private readonly runtime: ApiRuntime) {}

  /** 根据媒体库自定义地址后缀解析其基础服务。 */
  public async resolveServiceIdByPathSuffix(pathSuffix: string): Promise<string> {
    const row = await this.runtime.database.query("media_libraries as l")
      .join("cloud_services as s", "s.id", "l.service_id")
      .select("l.service_id")
      .where("l.jellyfin_path_suffix_lookup", pathSuffix.toLowerCase())
      .whereNull("s.deleted_at")
      .first();
    if (!row) throw new ApiError(404, "jellyfin_service_not_found", "Jellyfin 服务地址不存在");
    return String(row.service_id);
  }

  /** 校验服务启用状态，不要求客户端已登录。 */
  public async requireEnabledService(serviceId: string) {
    const row = await this.runtime.database.query("cloud_services as s")
      .join("media_libraries as l", "l.id", "s.library_id")
      .select("s.id", "s.user_id", "s.library_id", "s.display_name", "s.status", "l.jellyfin_enabled", "s.relay_playback_enabled", "s.provider_type", "s.credential_revision")
      .where("s.id", serviceId).whereNull("s.deleted_at").first();
    if (!row) throw new ApiError(404, "jellyfin_service_not_found", "Jellyfin 服务不存在");
    if (Number(row.jellyfin_enabled) !== 1 || row.status === "disabled") throw new ApiError(404, "jellyfin_service_disabled", "Jellyfin 服务未启用");
    return row;
  }

  /** 为 Jellyfin 公开图片接口生成仅包含媒体归属的上下文。 */
  public async resolvePublicImageContext(serviceId: string): Promise<JellyfinLibraryContext> {
    const service = await this.requireEnabledService(serviceId);
    return {
      serviceId,
      ownerUserId: String(service.user_id),
      libraryId: String(service.library_id),
    };
  }

  /** 使用服务独立账号登录并创建仅属于该服务的 Jellyfin 会话。 */
  public async login(serviceId: string, request: FastifyRequest, body: Record<string, unknown>) {
    const service = await this.requireEnabledService(serviceId);
    const loginKey = `${serviceId}:${request.ip}`;
    this.requireLoginAllowed(loginKey);
    let account;
    try {
      account = await this.runtime.serviceAccess.authenticate(serviceId, body.Username ?? body.username, body.Pw ?? body.Password ?? body.password);
      this.loginFailures.delete(loginKey);
    } catch (error) {
      const blockedUntil = this.recordLoginFailure(loginKey);
      this.runtime.logBusinessEvent("warn", {
        日志关键字: "codex-jellyfin-compat", 事件: "Jellyfin服务账号登录失败",
        服务ID: serviceId, 来源地址: request.ip, 是否已临时限制: blockedUntil > Date.now(),
      });
      throw error;
    }
    const token = randomBytes(32).toString("base64url");
    const protocolSessionId = randomUUID();
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + this.runtime.config.refreshTokenTtlSeconds * 1000).toISOString();
    await this.runtime.database.query("service_protocol_sessions").insert({
      id: protocolSessionId, service_id: serviceId, account_id: account.id, protocol: "jellyfin",
      token_hash: hashSessionToken(token), credential_revision: account.credentialRevision,
      device_id: readAuthorizationAttribute(request, "DeviceId")
        ?? (String((request.query as Record<string, unknown>)?.DeviceId ?? "").slice(0, 255) || null),
      device_name: readAuthorizationAttribute(request, "Device"), client_name: readAuthorizationAttribute(request, "Client"),
      expires_at: expiresAt, last_seen_at: now, revoked_at: null, created_at: now,
    });
    this.runtime.logBusinessEvent("info", {
      日志关键字: "codex-jellyfin-compat", 事件: "Jellyfin服务账号登录成功",
      服务ID: serviceId, 服务访问账号ID: account.id, 客户端名称: readAuthorizationAttribute(request, "Client") ?? "未知",
    });
    return {
      User: this.mapUser(account.id, account.username, serviceId, account.hasPassword),
      SessionInfo: { Id: protocolSessionId, ServerId: serviceId, UserId: account.id, UserName: account.username, Client: readAuthorizationAttribute(request, "Client") ?? "Jellyfin" },
      AccessToken: token,
      ServerId: serviceId,
    };
  }

  /** 验证 Jellyfin 会话并强制 serviceId、账号和凭据修订一致。 */
  public async authenticate(serviceId: string, request: FastifyRequest): Promise<JellyfinContext> {
    const token = readJellyfinToken(request);
    if (!token) throw new ApiError(401, "jellyfin_token_required", "需要 Jellyfin 访问令牌");
    const row = await this.runtime.database.query("service_protocol_sessions as ps")
      .join("service_access_accounts as a", "a.id", "ps.account_id")
      .join("cloud_services as s", "s.id", "ps.service_id")
      .join("media_libraries as l", "l.id", "s.library_id")
      .leftJoin("service_metadata_profiles as mp", function joinCurrentMetadataProfile() {
        this.on("mp.service_id", "s.id").andOn("mp.revision", "s.metadata_profile_revision");
      })
      .select(
        "ps.*", "a.username", "a.password_required", "a.credential_revision as account_revision",
        "a.status as account_status", "s.user_id", "s.library_id", "s.status as service_status",
        "l.jellyfin_enabled", "mp.configuration_json as metadata_profile_json",
      )
      .where("ps.token_hash", hashSessionToken(token)).where("ps.service_id", serviceId).where("ps.protocol", "jellyfin").whereNull("ps.revoked_at").whereNull("s.deleted_at").first();
    if (!row || String(row.expires_at) <= new Date().toISOString() || Number(row.credential_revision) !== Number(row.account_revision)
      || row.account_status !== "active" || row.service_status === "disabled" || Number(row.jellyfin_enabled) !== 1) {
      throw new ApiError(401, "jellyfin_session_invalid", "Jellyfin 登录已失效，请重新登录");
    }
    // 关键变量：媒体 Range 和图片请求频繁，最多每五分钟落一次会话活跃时间，避免播放期间持续写库。
    if (String(row.last_seen_at) < new Date(Date.now() - 5 * 60 * 1000).toISOString()) {
      await this.runtime.database.query("service_protocol_sessions").where({ id: row.id }).update({ last_seen_at: new Date().toISOString() });
    }
    return {
      serviceId, ownerUserId: String(row.user_id), libraryId: String(row.library_id),
      accountId: String(row.account_id), accountUsername: String(row.username),
      accountHasPassword: Number(row.password_required ?? 1) !== 0,
      mediaSpecsEnabled: isJellyfinMediaSpecsEnabled(row.metadata_profile_json),
      credentialRevision: Number(row.account_revision), accessToken: token,
    };
  }

  /** 撤销当前 Jellyfin 会话。 */
  public async logout(serviceId: string, request: FastifyRequest): Promise<void> {
    const token = readJellyfinToken(request);
    if (!token) return;
    await this.runtime.database.query("service_protocol_sessions")
      .where({ service_id: serviceId, protocol: "jellyfin", token_hash: hashSessionToken(token) })
      .whereNull("revoked_at").update({ revoked_at: new Date().toISOString() });
  }

  /** 构造 Jellyfin 用户 DTO，服务访问账号没有管理权限。 */
  public mapUser(accountId: string, username: string, serviceId = "", hasPassword = true) {
    return {
      Name: username, ServerId: serviceId, Id: accountId,
      HasPassword: hasPassword, HasConfiguredPassword: hasPassword,
      EnableAutoLogin: false, Configuration: {}, Policy: {
        IsAdministrator: false, IsHidden: false, IsDisabled: false, EnableMediaPlayback: true,
        EnableAudioPlaybackTranscoding: false, EnableVideoPlaybackTranscoding: false,
        EnableContentDownloading: true, EnableContentDeletion: false,
      },
    };
  }

  /** 返回当前服务固定的电影、节目两个虚拟媒体库定义。 */
  private getLibraryDefinitions(context: JellyfinLibraryContext): JellyfinLibraryDefinition[] {
    return [
      { id: `${context.libraryId}:movies`, name: "电影", collectionType: "movies", itemType: "video.movie" },
      { id: `${context.libraryId}:tvshows`, name: "节目", collectionType: "tvshows", itemType: "video.series" },
    ];
  }

  /** 根据 Jellyfin 虚拟媒体库 ID 读取媒体类型约束。 */
  private findLibraryDefinition(context: JellyfinLibraryContext, libraryId: string): JellyfinLibraryDefinition | undefined {
    return this.getLibraryDefinitions(context).find((library) => library.id === libraryId);
  }

  /** 解析云助手生成的虚拟季 ID，供季集查询和图片路由共用。 */
  private parseSeasonReference(value: string): JellyfinSeasonReference | null {
    const match = value.match(/^season:([^:]+):(\d+)$/u);
    if (!match?.[1]) return null;
    return { seriesId: match[1], seasonNumber: Number(match[2] ?? 0) };
  }

  /** 将 Jellyfin SortBy、SortOrder 映射为云助手目录排序字段。 */
  private readCatalogSort(query: Record<string, unknown>): CatalogSort {
    const requestedFields = String(query.SortBy ?? "").split(",")
      .map((field) => field.trim().toLowerCase())
      .filter(Boolean);
    if (requestedFields.length === 0) return "created_desc";
    // Jellyfin 在提供 SortBy 但省略 SortOrder 时默认升序；Flymby 通常会显式传入方向。
    const ascending = query.SortOrder === undefined
      || String(query.SortOrder).toLowerCase() === "ascending";
    for (const field of requestedFields) {
      if (field === "sortname" || field === "name") return ascending ? "title_asc" : "title_desc";
      if (field === "productionyear") return ascending ? "year_asc" : "year_desc";
      if (field === "premieredate" || field === "lastcontentpremieredate") {
        return ascending ? "premiere_date_asc" : "premiere_date_desc";
      }
      if (field === "datelastcontentadded" || field === "datemodified") {
        return ascending ? "updated_asc" : "updated_desc";
      }
      if (field === "datecreated") return ascending ? "created_asc" : "created_desc";
    }
    return "created_desc";
  }

  /** 合并多种媒体类型后继续按数据库相同规则排序，避免跨类型列表顺序失效。 */
  private compareCatalogItems(left: MediaItemRecord, right: MediaItemRecord, sort: CatalogSort): number {
    if (sort === "title_asc" || sort === "title_desc") {
      const compared = left.sortTitle.localeCompare(right.sortTitle, "zh-CN");
      return sort === "title_asc" ? compared : -compared;
    }
    if (sort === "year_asc" || sort === "year_desc") {
      const leftYear = left.year ?? (sort === "year_asc" ? Number.MAX_SAFE_INTEGER : Number.MIN_SAFE_INTEGER);
      const rightYear = right.year ?? (sort === "year_asc" ? Number.MAX_SAFE_INTEGER : Number.MIN_SAFE_INTEGER);
      return sort === "year_asc" ? leftYear - rightYear : rightYear - leftYear;
    }
    if (sort === "premiere_date_asc" || sort === "premiere_date_desc") {
      const leftDate = left.premiereDate ?? "";
      const rightDate = right.premiereDate ?? "";
      if (!leftDate && rightDate) return 1;
      if (leftDate && !rightDate) return -1;
      return sort === "premiere_date_asc" ? leftDate.localeCompare(rightDate) : rightDate.localeCompare(leftDate);
    }
    const leftDate = sort.startsWith("updated_") ? left.updatedAt : left.createdAt;
    const rightDate = sort.startsWith("updated_") ? right.updatedAt : right.createdAt;
    return sort.endsWith("_asc") ? leftDate.localeCompare(rightDate) : rightDate.localeCompare(leftDate);
  }

  /** 获取媒体条目在 Jellyfin 中所属的电影或节目媒体库。 */
  private getItemLibraryDefinition(context: JellyfinContext, item: MediaItemRecord): JellyfinLibraryDefinition {
    const collectionType: JellyfinCollectionType = item.itemType === "video.movie" ? "movies" : "tvshows";
    return this.getLibraryDefinitions(context).find((library) => library.collectionType === collectionType)
      ?? this.getLibraryDefinitions(context)[0]!;
  }

  /** 将分类名称编码为稳定且可以从 GenreIds 还原的 Jellyfin 分类 ID。 */
  private encodeGenreId(name: string): string {
    return `genre:${Buffer.from(name, "utf8").toString("base64url")}`;
  }

  /** 从 Jellyfin 分类 ID 还原分类名称，拒绝非本服务生成的格式。 */
  private decodeGenreId(genreId: string): string | null {
    if (!genreId.startsWith("genre:")) return null;
    try {
      const name = Buffer.from(genreId.slice("genre:".length), "base64url").toString("utf8").trim();
      return name || null;
    } catch {
      return null;
    }
  }

  /** 读取 Items 查询中的分类 ID 或分类名称。 */
  private readGenreNames(query: Record<string, unknown>): string[] {
    const names = String(query.GenreIds ?? "").split(",")
      .map((genreId) => this.decodeGenreId(genreId.trim()))
      .filter((name): name is string => Boolean(name));
    String(query.Genres ?? "").split(/[|,]/u).map((name) => name.trim()).filter(Boolean).forEach((name) => names.push(name));
    return [...new Set(names)];
  }

  /** 将分类名称映射为 Jellyfin Genre 条目。 */
  private mapGenre(context: JellyfinContext, genre: JellyfinGenreSummary) {
    return {
      Name: genre.name, ServerId: context.serviceId, Id: this.encodeGenreId(genre.name), Type: "Genre",
      IsFolder: true, ChildCount: genre.itemCount, RecursiveItemCount: genre.itemCount,
      ImageTags: {}, BackdropImageTags: [], UserData: this.mapUserData(null, 0),
    };
  }

  /** 将数据库媒体条目映射为 Flymby 所需的 Jellyfin BaseItemDto。 */
  public async mapItem(context: JellyfinContext, item: MediaItemRecord, parent?: MediaItemRecord, mapping?: JellyfinItemMappingContext) {
    if (item.serviceId !== context.serviceId) throw new ApiError(404, "jellyfin_item_not_found", "媒体条目不存在");
    const progress = mapping ? mapping.progressByItemId.get(item.id) : await this.readProgress(context, item.id);
    const metadata = item.metadata;
    const type = item.itemType === "video.series" ? "Series" : item.itemType === "video.episode" ? "Episode" : "Movie";
    const seasonNumber = Number(metadata.seasonNumber ?? 0);
    const episodeNumber = Number(metadata.episodeNumber ?? 0);
    const ownPrimaryTag = item.posterUrl ? String(Date.parse(item.updatedAt) || 1) : "";
    const parentPrimaryTag = parent?.posterUrl ? String(Date.parse(parent.updatedAt) || 1) : "";
    // 关键变量：单集没有独立海报时继承节目海报，并明确图片所属条目，避免客户端请求错误的单集图片。
    const primaryImageTag = ownPrimaryTag || (type === "Episode" ? parentPrimaryTag : "");
    const primaryImageItemId = ownPrimaryTag ? item.id : primaryImageTag ? parent?.id : undefined;
    const imageTags: Record<string, string> = primaryImageTag ? { Primary: primaryImageTag } : {};
    const people = Array.isArray(metadata.people) ? metadata.people : [];
    const genreNames = Array.isArray(metadata.genres)
      ? [...new Set(metadata.genres.map((genre) => String(genre).trim()).filter(Boolean))]
      : [];
    const itemLibrary = this.getItemLibraryDefinition(context, item);
    let itemFiles: JellyfinFileSummary[];
    if (mapping) {
      itemFiles = mapping.filesByItemId.get(item.id) ?? [];
    } else {
      const linkedFiles = await this.runtime.repository.listItemFiles(item.id, context.ownerUserId);
      // 关键变量：单条回退查询可能带出节目子集文件，只有当前电影或单集自身的文件才能作为它的版本。
      itemFiles = linkedFiles.filter((file) => String(file.itemId) === item.id)
        .map((file) => ({
          fileId: String(file.fileId),
          name: String(file.name ?? ""),
          size: Number(file.size ?? 0),
          mediaProbe: context.mediaSpecsEnabled
            ? parseCompletedMediaProbeResult(file.mediaProbeStatus, file.mediaProbeResult)
            : null,
        }));
    }
    // 关键变量：多版本影片必须所有实际文件都分析完成，协议才整体返回时长和视频规格。
    const mediaSpecsReady = context.mediaSpecsEnabled
      && itemFiles.length > 0
      && itemFiles.every((file) => file.mediaProbe !== null);
    const runTimeTicks = mediaSpecsReady
      ? readJellyfinRunTimeTicks(itemFiles.map((file) => file.mediaProbe))
      : 0;
    const primaryProbe = mediaSpecsReady ? itemFiles[0]?.mediaProbe ?? null : null;
    if (!mapping) {
      this.runtime.logBusinessEvent("info", {
        日志关键字: "codex-jellyfin-media-specs",
        事件: mediaSpecsReady ? "返回Jellyfin媒体规格" : "省略未完成的Jellyfin媒体规格",
        服务ID: context.serviceId,
        媒体条目ID: item.id,
        规格分析开关: context.mediaSpecsEnabled,
        已完成规格文件数量: itemFiles.filter((file) => file.mediaProbe !== null).length,
      });
    }
    return {
      Name: item.title, OriginalTitle: String(metadata.originalTitle ?? ""), ServerId: context.serviceId,
      Id: item.id, Etag: String(Date.parse(item.updatedAt) || 1), DateCreated: item.createdAt,
      SortName: item.sortTitle, PremiereDate: item.premiereDate, ProductionYear: item.year,
      Overview: item.overview, CommunityRating: Number(metadata.rating ?? 0) || undefined,
      Type: type, MediaType: "Video", IsFolder: type === "Series", LocationType: "FileSystem",
      Genres: genreNames,
      GenreItems: genreNames.map((name) => ({ Name: name, Id: this.encodeGenreId(name) })),
      People: people.map((person) => ({ Name: String((person as Record<string, unknown>).name ?? ""), Role: String((person as Record<string, unknown>).role ?? ""), Type: String((person as Record<string, unknown>).type ?? "Actor") })),
      ProviderIds: item.externalIds, ImageTags: imageTags,
      PrimaryImageTag: primaryImageTag || undefined, PrimaryImageItemId: primaryImageItemId,
      BackdropImageTags: item.backdropUrl ? [String(Date.parse(item.updatedAt) || 1)] : [],
      RunTimeTicks: runTimeTicks || undefined,
      Container: primaryProbe?.container || undefined,
      Bitrate: primaryProbe?.bitRate || undefined,
      MediaStreams: primaryProbe?.mediaStreams,
      MediaSources: itemFiles.map((file) => mapCatalogMediaSource(file, mediaSpecsReady)),
      SeriesId: type === "Episode" ? parent?.id : undefined, SeriesName: type === "Episode" ? parent?.title ?? item.subtitle : undefined,
      ParentIndexNumber: type === "Episode" ? seasonNumber : undefined, IndexNumber: type === "Episode" ? episodeNumber : undefined,
      SeasonId: type === "Episode" && parent ? `season:${parent.id}:${seasonNumber}` : undefined,
      SeasonName: type === "Episode" ? seasonNumber === 0 ? "特别篇" : `第 ${seasonNumber} 季` : undefined,
      ParentId: type === "Episode" && parent ? `season:${parent.id}:${seasonNumber}` : itemLibrary.id,
      ParentPrimaryImageItemId: type === "Episode" && parentPrimaryTag ? parent?.id : undefined,
      ParentPrimaryImageTag: type === "Episode" ? parentPrimaryTag || undefined : undefined,
      SeriesPrimaryImageTag: type === "Episode" ? parentPrimaryTag || undefined : undefined,
      ParentBackdropItemId: type === "Episode" && parent?.backdropUrl ? parent.id : undefined,
      ParentBackdropImageTags: type === "Episode" && parent?.backdropUrl
        ? [String(Date.parse(parent.updatedAt) || 1)]
        : [],
      DatePlayed: progress?.last_played_at ?? undefined,
      UserData: this.mapUserData(progress, runTimeTicks),
    };
  }

  /** 映射一个电影或节目虚拟媒体库。 */
  public mapLibrary(context: JellyfinContext, library: JellyfinLibraryDefinition, itemCount = 0, coverItem?: MediaItemRecord) {
    const primaryImageTag = coverItem?.posterUrl ? String(Date.parse(coverItem.updatedAt) || 1) : "";
    const backdropImageTag = coverItem?.backdropUrl ? String(Date.parse(coverItem.updatedAt) || 1) : "";
    return {
      Name: library.name, ServerId: context.serviceId, Id: library.id, Type: "CollectionFolder",
      CollectionType: library.collectionType, IsFolder: true, LocationType: "FileSystem",
      ChildCount: itemCount, RecursiveItemCount: itemCount,
      ImageTags: primaryImageTag ? { Primary: primaryImageTag } : {},
      PrimaryImageTag: primaryImageTag || undefined,
      PrimaryImageItemId: primaryImageTag ? coverItem?.id : undefined,
      BackdropImageTags: backdropImageTag ? [backdropImageTag] : [],
      ParentBackdropItemId: backdropImageTag ? coverItem?.id : undefined,
      UserData: this.mapUserData(null, 0),
    };
  }

  /** 返回指定媒体条目所属的电影或节目媒体库 DTO。 */
  public mapItemLibrary(context: JellyfinContext, item: MediaItemRecord) {
    return this.mapLibrary(context, this.getItemLibraryDefinition(context, item), 0, item);
  }

  /** 返回当前服务的电影、节目两个媒体库及各自条目数量。 */
  public async listLibraries(context: JellyfinContext) {
    const libraries = this.getLibraryDefinitions(context);
    const counts = await Promise.all(libraries.map((library) => this.runtime.repository.listCatalogItems({
      userId: context.ownerUserId, serviceId: context.serviceId, mediaType: "video", itemType: library.itemType,
      sort: "updated_desc", limit: 60, offset: 0, includeFileCounts: false,
    })));
    const items = libraries.map((library, index) => {
      const result = counts[index];
      // 关键变量：虚拟媒体库使用最近更新且真实拥有海报的条目作为封面，不生成无效的虚拟图片地址。
      const coverItem = result?.items.find((item) => Boolean(item.posterUrl))
        ?? result?.items.find((item) => Boolean(item.backdropUrl));
      return this.mapLibrary(context, library, result?.total ?? 0, coverItem);
    });
    this.runtime.logBusinessEvent("info", {
      日志关键字: "codex-jellyfin-compat", 事件: "返回Jellyfin电影节目媒体库", 服务ID: context.serviceId,
      电影数量: counts[0]?.total ?? 0, 节目数量: counts[1]?.total ?? 0,
    });
    return { Items: items, TotalRecordCount: items.length, StartIndex: 0 };
  }

  /** 查询顶层目录，支持 Jellyfin 常用过滤、搜索和分页参数。 */
  public async listItems(context: JellyfinContext, query: Record<string, unknown>) {
    const include = String(query.IncludeItemTypes ?? "").split(",").filter(Boolean);
    const parentId = String(query.ParentId ?? "");
    const virtualLibrary = this.findLibraryDefinition(context, parentId);
    if (parentId && parentId !== context.libraryId && !virtualLibrary) {
      const virtualSeason = parentId.match(/^season:([^:]+):(\d+)$/u);
      if (virtualSeason) return this.listEpisodes(context, virtualSeason[1] ?? "", { ...query, SeasonId: parentId });
      const parent = await this.runtime.repository.getCatalogItem(parentId, context.ownerUserId);
      if (parent.serviceId !== context.serviceId) throw new ApiError(404, "jellyfin_item_not_found", "媒体条目不存在");
      const children = await this.runtime.repository.listCatalogChildren(parentId, context.ownerUserId);
      const mapping = await this.loadItemMappingContext(context, children.map((item) => item.id));
      const items = await Promise.all(children.map((item) => this.mapItem(context, item, parent, mapping)));
      return this.paginate(items, query);
    }
    const requestedTypes = include.map((type) => type === "Movie" ? "video.movie" : type === "Series" ? "video.series" : type === "Episode" ? "video.episode" : "")
      .filter((type) => type.length > 0);
    if (include.length > 0 && requestedTypes.length === 0) return { Items: [], TotalRecordCount: 0, StartIndex: 0 };
    // 关键变量：虚拟电影/节目库必须与 IncludeItemTypes 取交集，不能因客户端查询再次混回其他类型。
    const effectiveTypes = virtualLibrary
      ? requestedTypes.length === 0 || requestedTypes.includes(virtualLibrary.itemType) ? [virtualLibrary.itemType] : []
      : requestedTypes;
    if (virtualLibrary && effectiveTypes.length === 0) return { Items: [], TotalRecordCount: 0, StartIndex: 0 };
    const itemType = effectiveTypes.length === 1 ? effectiveTypes[0] : undefined;
    const limit = Math.min(500, Math.max(1, Number(query.Limit ?? 100)));
    const offset = Math.max(0, Number(query.StartIndex ?? 0));
    const sort = this.readCatalogSort(query);
    const search = typeof query.SearchTerm === "string" ? query.SearchTerm : undefined;
    const genres = this.readGenreNames(query);
    let records: MediaItemRecord[];
    let total: number;
    if (effectiveTypes.length > 1) {
      const results = await Promise.all(effectiveTypes.map((requestedType) => this.runtime.repository.listCatalogItems({
        userId: context.ownerUserId, serviceId: context.serviceId, mediaType: "video", itemType: requestedType,
        genres, search, sort, limit: 500, offset: 0, includeFileCounts: false,
      })));
      const combined = results.flatMap((result) => result.items);
      combined.sort((left, right) => this.compareCatalogItems(left, right, sort));
      records = combined.slice(offset, offset + limit);
      total = results.reduce((sum, result) => sum + result.total, 0);
    } else {
      const result = await this.runtime.repository.listCatalogItems({
        userId: context.ownerUserId, serviceId: context.serviceId, mediaType: "video", itemType,
        genres, search, sort, limit, offset, includeFileCounts: false,
      });
      records = result.items;
      total = result.total;
    }
    const mapping = await this.loadItemMappingContext(context, records.map((item) => item.id));
    const items = await Promise.all(records.map((item) => this.mapItem(context, item, undefined, mapping)));
    this.runtime.logBusinessEvent("info", {
      日志关键字: "codex-jellyfin-compat", 事件: "返回Jellyfin排序列表", 服务ID: context.serviceId,
      媒体库类型: virtualLibrary?.collectionType ?? "全部", 排序字段: String(query.SortBy ?? "DateCreated"),
      排序方向: String(query.SortOrder ?? (query.SortBy === undefined ? "Descending" : "Ascending")),
      内部排序: sort, 返回数量: items.length, 总数量: total,
    });
    return { Items: items, TotalRecordCount: total, StartIndex: offset };
  }

  /** 聚合当前电影或节目媒体库的 Jellyfin 分类列表。 */
  public async listGenres(context: JellyfinContext, query: Record<string, unknown>) {
    const parentId = String(query.ParentId ?? "");
    const virtualLibrary = this.findLibraryDefinition(context, parentId);
    const include = String(query.IncludeItemTypes ?? "").split(",").filter(Boolean);
    const requestedTypes = include.map((type) => type === "Movie" ? "video.movie" : type === "Series" ? "video.series" : "")
      .filter((type) => type.length > 0);
    if (include.length > 0 && requestedTypes.length === 0) return { Items: [], TotalRecordCount: 0, StartIndex: 0 };
    const effectiveTypes = virtualLibrary
      ? requestedTypes.length === 0 || requestedTypes.includes(virtualLibrary.itemType) ? [virtualLibrary.itemType] : []
      : requestedTypes.length > 0 ? requestedTypes : ["video.movie", "video.series"];
    if (effectiveTypes.length === 0) return { Items: [], TotalRecordCount: 0, StartIndex: 0 };
    const rows = await this.runtime.database.query("media_items")
      .select("metadata_json").where({ user_id: context.ownerUserId, service_id: context.serviceId, media_type: "video" })
      .whereIn("item_type", effectiveTypes).whereNull("deleted_at");
    const counts = new Map<string, number>();
    rows.forEach((row) => {
      const metadata = parseJsonObject(row.metadata_json);
      if (!Array.isArray(metadata.genres)) return;
      const itemGenres = [...new Set(metadata.genres.map((genre) => String(genre).trim()).filter(Boolean))];
      itemGenres.forEach((genre) => counts.set(genre, (counts.get(genre) ?? 0) + 1));
    });
    const searchTerm = String(query.SearchTerm ?? "").trim().toLocaleLowerCase("zh-CN");
    const sortDirection = String(query.SortOrder ?? "Ascending").toLowerCase() === "descending" ? -1 : 1;
    const summaries = [...counts].map(([name, itemCount]) => ({ name, itemCount }))
      .filter((genre) => !searchTerm || genre.name.toLocaleLowerCase("zh-CN").includes(searchTerm))
      .sort((left, right) => left.name.localeCompare(right.name, "zh-CN") * sortDirection);
    const response = this.paginate(summaries.map((genre) => this.mapGenre(context, genre)), query);
    this.runtime.logBusinessEvent("info", {
      日志关键字: "codex-jellyfin-compat", 事件: "返回Jellyfin分类列表", 服务ID: context.serviceId,
      媒体库类型: virtualLibrary?.collectionType ?? "movies+tvshows", 分类数量: summaries.length,
    });
    return response;
  }

  /** 返回 Flymby 媒体中心读取的电影、节目和单集数量。 */
  public async getItemCounts(context: JellyfinContext) {
    const rows = await this.runtime.database.query("media_items")
      .select("item_type").count<{ item_type: string; count: string | number }[]>({ count: "id" })
      .where({ user_id: context.ownerUserId, service_id: context.serviceId, media_type: "video" })
      .whereIn("item_type", ["video.movie", "video.series", "video.episode"])
      .whereNull("deleted_at").groupBy("item_type");
    const countByType = new Map(rows.map((row) => [String(row.item_type), Number(row.count ?? 0)]));
    const response = {
      MovieCount: countByType.get("video.movie") ?? 0,
      SeriesCount: countByType.get("video.series") ?? 0,
      EpisodeCount: countByType.get("video.episode") ?? 0,
      AlbumCount: 0, SongCount: 0,
    };
    this.runtime.logBusinessEvent("info", {
      日志关键字: "codex-jellyfin-compat", 事件: "返回Jellyfin媒体数量", 服务ID: context.serviceId,
      电影数量: response.MovieCount, 节目数量: response.SeriesCount, 单集数量: response.EpisodeCount,
    });
    return response;
  }

  /** 按同类型和共同分类返回相关推荐，未命中时返回空列表而不是中断详情页。 */
  public async listSimilar(context: JellyfinContext, itemId: string, query: Record<string, unknown>) {
    const current = await this.runtime.repository.getCatalogItem(itemId, context.ownerUserId);
    if (current.serviceId !== context.serviceId) throw new ApiError(404, "jellyfin_item_not_found", "媒体条目不存在");
    const genreNames = Array.isArray(current.metadata.genres)
      ? current.metadata.genres.map((genre) => String(genre).trim()).filter(Boolean).slice(0, 3)
      : [];
    const requestedLimit = Math.min(100, Math.max(1, Number(query.Limit ?? 20)));
    const result = await this.runtime.repository.listCatalogItems({
      userId: context.ownerUserId, serviceId: context.serviceId, mediaType: "video", itemType: current.itemType,
      genres: genreNames, sort: "updated_desc", limit: requestedLimit + 1, offset: 0, includeFileCounts: false,
    });
    const records = result.items.filter((item) => item.id !== current.id).slice(0, requestedLimit);
    const mapping = await this.loadItemMappingContext(context, records.map((item) => item.id));
    const items = await Promise.all(records.map((item) => this.mapItem(context, item, undefined, mapping)));
    return { Items: items, TotalRecordCount: items.length, StartIndex: 0 };
  }

  /** 获取节目季列表，季使用可逆虚拟 ID，不新增重复媒体实体。 */
  public async listSeasons(context: JellyfinContext, seriesId: string) {
    const series = await this.runtime.repository.getCatalogItem(seriesId, context.ownerUserId);
    if (series.serviceId !== context.serviceId) throw new ApiError(404, "jellyfin_item_not_found", "媒体条目不存在");
    const children = await this.runtime.repository.listCatalogChildren(seriesId, context.ownerUserId);
    const seasons = [...new Set(children.map((item) => Math.max(0, Number(item.metadata.seasonNumber ?? 0))))].sort((left, right) => left - right);
    const primaryImageTag = series.posterUrl ? String(Date.parse(series.updatedAt) || 1) : "";
    const backdropImageTag = series.backdropUrl ? String(Date.parse(series.updatedAt) || 1) : "";
    const items = seasons.map((number) => ({
      Name: number === 0 ? "特别篇" : `第 ${number} 季`, Id: `season:${seriesId}:${number}`, ServerId: context.serviceId,
      Type: "Season", IsFolder: true, SeriesId: seriesId, SeriesName: series.title,
      IndexNumber: number, ParentId: seriesId,
      ImageTags: primaryImageTag ? { Primary: primaryImageTag } : {},
      PrimaryImageTag: primaryImageTag || undefined, PrimaryImageItemId: primaryImageTag ? seriesId : undefined,
      SeriesPrimaryImageTag: primaryImageTag || undefined,
      ParentPrimaryImageItemId: primaryImageTag ? seriesId : undefined, ParentPrimaryImageTag: primaryImageTag || undefined,
      BackdropImageTags: backdropImageTag ? [backdropImageTag] : [],
      ParentBackdropItemId: backdropImageTag ? seriesId : undefined,
      ParentBackdropImageTags: backdropImageTag ? [backdropImageTag] : [],
      UserData: this.mapUserData(null, 0),
    }));
    this.runtime.logBusinessEvent("info", {
      日志关键字: "codex-jellyfin-compat", 事件: "返回Jellyfin节目季列表", 服务ID: context.serviceId,
      节目ID: seriesId, 季数量: items.length, 单集数量: children.length, 是否有节目封面: Boolean(primaryImageTag),
    });
    return { Items: items, TotalRecordCount: items.length, StartIndex: 0 };
  }

  /** 获取节目单集并按季集排序。 */
  public async listEpisodes(context: JellyfinContext, seriesId: string, query: Record<string, unknown>) {
    const pathSeason = this.parseSeasonReference(seriesId);
    const querySeason = this.parseSeasonReference(String(query.SeasonId ?? ""));
    const actualSeriesId = String(query.SeriesId ?? "").trim() || pathSeason?.seriesId || querySeason?.seriesId || seriesId;
    const explicitSeasonNumber = Number(query.Season ?? query.SeasonNumber);
    const seasonNumber = pathSeason?.seasonNumber ?? querySeason?.seasonNumber
      ?? (Number.isFinite(explicitSeasonNumber) ? explicitSeasonNumber : null);
    const series = await this.runtime.repository.getCatalogItem(actualSeriesId, context.ownerUserId);
    if (series.serviceId !== context.serviceId) throw new ApiError(404, "jellyfin_item_not_found", "媒体条目不存在");
    const children = (await this.runtime.repository.listCatalogChildren(actualSeriesId, context.ownerUserId))
      .filter((item) => seasonNumber === null || Number(item.metadata.seasonNumber ?? 0) === seasonNumber)
      .sort((left, right) => Number(left.metadata.seasonNumber ?? 0) - Number(right.metadata.seasonNumber ?? 0)
        || Number(left.metadata.episodeNumber ?? 0) - Number(right.metadata.episodeNumber ?? 0));
    const mapping = await this.loadItemMappingContext(context, children.map((item) => item.id));
    const items = await Promise.all(children.map((item) => this.mapItem(context, item, series, mapping)));
    const response = this.paginate(items, query);
    this.runtime.logBusinessEvent("info", {
      日志关键字: "codex-jellyfin-compat", 事件: "返回Jellyfin节目单集列表", 服务ID: context.serviceId,
      节目ID: actualSeriesId, 季编号: seasonNumber ?? "全部", 返回数量: response.Items.length, 总数量: response.TotalRecordCount,
    });
    return response;
  }

  /** 为普通条目、虚拟媒体库和虚拟季解析实际承载图片的媒体条目。 */
  public async resolveImageItem(context: JellyfinLibraryContext, itemId: string, imageType: string): Promise<MediaItemRecord> {
    const library = this.findLibraryDefinition(context, itemId);
    if (library) {
      const result = await this.runtime.repository.listCatalogItems({
        userId: context.ownerUserId, serviceId: context.serviceId, mediaType: "video", itemType: library.itemType,
        sort: "updated_desc", limit: 60, offset: 0, includeFileCounts: false,
      });
      const prefersBackdrop = imageType.toLowerCase() === "backdrop";
      const coverItem = result.items.find((item) => prefersBackdrop ? Boolean(item.backdropUrl) : Boolean(item.posterUrl))
        ?? result.items.find((item) => Boolean(item.posterUrl || item.backdropUrl));
      if (!coverItem) throw new ApiError(404, "jellyfin_image_not_found", "媒体库没有可用封面");
      this.runtime.logBusinessEvent("info", {
        日志关键字: "codex-jellyfin-compat", 事件: "解析Jellyfin图片来源", 服务ID: context.serviceId,
        请求条目ID: itemId, 实际条目ID: coverItem.id, 图片类型: imageType,
      });
      return coverItem;
    }
    const season = this.parseSeasonReference(itemId);
    const resolvedItemId = season?.seriesId ?? itemId;
    const item = await this.runtime.repository.getCatalogItem(resolvedItemId, context.ownerUserId);
    if (item.serviceId !== context.serviceId) throw new ApiError(404, "jellyfin_image_not_found", "图片不存在");
    if (resolvedItemId !== itemId) {
      this.runtime.logBusinessEvent("info", {
        日志关键字: "codex-jellyfin-compat", 事件: "解析Jellyfin图片来源", 服务ID: context.serviceId,
        请求条目ID: itemId, 实际条目ID: resolvedItemId, 图片类型: imageType,
      });
    }
    const requestedImageUrl = imageType.toLowerCase() === "backdrop" ? item.backdropUrl : item.posterUrl;
    if (requestedImageUrl || item.itemType !== "video.episode") return item;
    // 单集 DTO 可以继承节目海报和背景图；图片请求使用单集 ID 时同样要回退到所属节目。
    const relation = await this.runtime.database.query("media_relations")
      .where({ library_id: context.libraryId, child_item_id: item.id }).first();
    if (!relation) return item;
    const parent = await this.runtime.repository.getCatalogItem(String(relation.parent_item_id), context.ownerUserId);
    const parentImageUrl = imageType.toLowerCase() === "backdrop" ? parent.backdropUrl : parent.posterUrl;
    if (parent.serviceId !== context.serviceId || !parentImageUrl) return item;
    return parent;
  }

  /** 查询继续观看条目。 */
  public async listResume(context: JellyfinContext, query: Record<string, unknown>) {
    const rows = await this.runtime.database.query("service_playback_progress as p")
      .join("media_items as m", "m.id", "p.item_id")
      .join("file_links as fl", "fl.item_id", "m.id")
      .join("source_files as f", "f.id", "fl.source_file_id")
      .distinct("m.id", "p.updated_at").where({ "p.service_id": context.serviceId, "p.account_id": context.accountId, "p.played": 0, "p.hidden_from_resume": 0, "f.status": "active" })
      // 关键变量：低于 60 秒的试播不进入继续观看，避免首页堆积误触记录。
      .where("p.position_ticks", ">=", 600_000_000).whereNull("m.deleted_at").orderBy("p.updated_at", "desc").limit(500);
    const records = await Promise.all(rows.map(async (row) => {
      const item = await this.runtime.repository.getCatalogItem(String(row.id), context.ownerUserId);
      const parent = item.itemType === "video.episode" ? await this.findParent(item.id, context.ownerUserId) : undefined;
      return { item, parent };
    }));
    const mapping = await this.loadItemMappingContext(context, records.map((record) => record.item.id));
    const items = await Promise.all(records.map((record) => this.mapItem(context, record.item, record.parent, mapping)));
    const progressItems = items.filter((item) => Number(item.UserData?.PlaybackPositionTicks ?? 0) > 0);
    const percentageItems = progressItems.filter((item) => Number(item.UserData?.PlayedPercentage ?? 0) > 0);
    this.runtime.logBusinessEvent("info", {
      日志关键字: "codex-jellyfin-playback-progress",
      事件: "返回Jellyfin继续观看进度",
      服务ID: context.serviceId,
      账号ID: context.accountId,
      继续观看数量: items.length,
      包含已观看时间数量: progressItems.length,
      包含进度百分比数量: percentageItems.length,
    });
    return this.paginate(items, query);
  }

  /** 查询去重后的最近播放记录。 */
  public async listHistory(context: JellyfinContext, query: Record<string, unknown>) {
    const rows = await this.runtime.database.query("service_playback_progress as p")
      .join("media_items as m", "m.id", "p.item_id").select("m.id")
      .where({ "p.service_id": context.serviceId, "p.account_id": context.accountId })
      .whereNotNull("p.last_played_at").whereNull("m.deleted_at").orderBy("p.last_played_at", "desc").limit(500);
    const records = await Promise.all(rows.map(async (row) => {
      const item = await this.runtime.repository.getCatalogItem(String(row.id), context.ownerUserId);
      const parent = item.itemType === "video.episode" ? await this.findParent(item.id, context.ownerUserId) : undefined;
      return { item, parent };
    }));
    const mapping = await this.loadItemMappingContext(context, records.map((record) => record.item.id));
    const items = await Promise.all(records.map((record) => this.mapItem(context, record.item, record.parent, mapping)));
    return this.paginate(items, query);
  }

  /** 获取单条用户进度 DTO。 */
  public async getUserData(context: JellyfinContext, itemId: string) {
    const item = await this.runtime.repository.getCatalogItem(itemId, context.ownerUserId);
    if (item.serviceId !== context.serviceId) throw new ApiError(404, "jellyfin_item_not_found", "媒体条目不存在");
    const progress = await this.readProgress(context, itemId);
    const runTimeTicks = await this.readItemRunTimeTicks(context, item);
    return this.mapUserData(progress, runTimeTicks);
  }

  /** 接收 Jellyfin 用户数据更新；第一期只允许修改续播位置。 */
  public async updateUserData(context: JellyfinContext, itemId: string, body: Record<string, unknown>) {
    const item = await this.runtime.repository.getCatalogItem(itemId, context.ownerUserId);
    if (item.serviceId !== context.serviceId) throw new ApiError(404, "jellyfin_item_not_found", "媒体条目不存在");
    const positionTicks = Math.max(0, Math.floor(Number(body.PlaybackPositionTicks ?? 0)));
    const now = new Date().toISOString();
    const existing = await this.runtime.database.query("service_playback_progress")
      .where({ service_id: context.serviceId, account_id: context.accountId, item_id: itemId }).first();
    const metadataDurationTicks = await this.readItemRunTimeTicks(context, item);
    const patch = {
      position_ticks: positionTicks,
      played: 0,
      hidden_from_resume: 0,
      updated_at: now,
    };
    if (existing) await this.runtime.database.query("service_playback_progress").where({ id: existing.id }).update(patch);
    else await this.runtime.database.query("service_playback_progress").insert({
      id: randomUUID(), service_id: context.serviceId, account_id: context.accountId, item_id: itemId,
      media_source_id: null, play_count: 0, last_played_at: null, ...patch,
    });
    return this.mapUserData({ ...existing, ...patch, item_id: itemId }, metadataDurationTicks);
  }

  /** 查询指定节目的下一集。 */
  public async listNextUp(context: JellyfinContext, query: Record<string, unknown>) {
    const seriesId = String(query.SeriesId ?? "");
    if (!seriesId) return { Items: [], TotalRecordCount: 0, StartIndex: 0 };
    const series = await this.runtime.repository.getCatalogItem(seriesId, context.ownerUserId);
    if (series.serviceId !== context.serviceId) throw new ApiError(404, "jellyfin_item_not_found", "媒体条目不存在");
    const children = (await this.runtime.repository.listCatalogChildren(seriesId, context.ownerUserId))
      .sort((left, right) => Number(left.metadata.seasonNumber ?? 0) - Number(right.metadata.seasonNumber ?? 0)
        || Number(left.metadata.episodeNumber ?? 0) - Number(right.metadata.episodeNumber ?? 0));
    const progressRows = await this.runtime.database.query("service_playback_progress")
      .where({ service_id: context.serviceId, account_id: context.accountId }).whereIn("item_id", children.map((item) => item.id));
    const progressById = new Map(progressRows.map((row) => [String(row.item_id), row]));
    const next = children.find((item) => Number(progressById.get(item.id)?.played ?? 0) !== 1);
    const items = next ? [await this.mapItem(context, next, series)] : [];
    return { Items: items, TotalRecordCount: items.length, StartIndex: 0 };
  }

  /** 写入 Playing、Progress 或 Stopped 事件，保证停止事件幂等。 */
  public async reportPlayback(context: JellyfinContext, kind: "playing" | "progress" | "stopped", body: Record<string, unknown>): Promise<void> {
    const itemId = String(body.ItemId ?? "");
    if (!itemId) throw new ApiError(422, "playback_item_required", "播放条目 ID 不能为空");
    const item = await this.runtime.repository.getCatalogItem(itemId, context.ownerUserId);
    if (item.serviceId !== context.serviceId) throw new ApiError(404, "jellyfin_item_not_found", "媒体条目不存在");
    const playSessionId = String(body.PlaySessionId ?? "") || randomUUID();
    const positionTicks = Math.max(0, Math.floor(Number(body.PositionTicks ?? 0)));
    // 关键变量：播放进度只与服务端媒体库中的总时长计算，不接受非标准的客户端总时长字段。
    const durationTicks = await this.readItemRunTimeTicks(
      context,
      item,
      body.MediaSourceId ? String(body.MediaSourceId) : undefined,
    );
    const completed = kind === "stopped" && durationTicks > 0 && positionTicks >= durationTicks * 0.9;
    const now = new Date().toISOString();
    await this.runtime.database.query.transaction(async (transaction) => {
      const existing = await transaction("service_playback_sessions").where({ id: playSessionId, service_id: context.serviceId, account_id: context.accountId }).first();
      const existingHistory = kind === "stopped"
        ? await transaction("service_playback_history").where({ play_session_id: playSessionId }).first()
        : null;
      const sessionPatch = { item_id: itemId, media_source_id: body.MediaSourceId ? String(body.MediaSourceId) : null, status: kind === "stopped" ? "stopped" : "playing", position_ticks: positionTicks, paused: body.IsPaused ? 1 : 0, updated_at: now, stopped_at: kind === "stopped" ? now : null };
      if (existing) await transaction("service_playback_sessions").where({ id: playSessionId }).update(sessionPatch);
      else await transaction("service_playback_sessions").insert({ id: playSessionId, service_id: context.serviceId, account_id: context.accountId, ...sessionPatch, started_at: now });
      await this.upsertProgress(
        transaction,
        context,
        itemId,
        body.MediaSourceId ? String(body.MediaSourceId) : null,
        positionTicks,
        kind === "stopped" && !existingHistory,
        completed,
        now,
      );
      if (kind === "stopped") {
        if (!existingHistory) await transaction("service_playback_history").insert({ id: randomUUID(), service_id: context.serviceId, account_id: context.accountId, item_id: itemId, play_session_id: playSessionId, position_ticks: positionTicks, completed: completed ? 1 : 0, started_at: existing?.started_at ?? now, stopped_at: now });
      }
    });
    this.runtime.logBusinessEvent("info", {
      日志关键字: "codex-jellyfin-playback-progress",
      事件: "保存Jellyfin播放进度",
      服务ID: context.serviceId,
      账号ID: context.accountId,
      媒体条目ID: itemId,
      上报类型: kind,
      已观看Ticks: positionTicks,
      总时长Ticks: durationTicks,
      进度百分比: durationTicks > 0 ? Math.min(100, positionTicks * 100 / durationTicks) : 0,
    });
  }

  /** 设置已播放状态。 */
  public async setPlayed(context: JellyfinContext, itemId: string, played: boolean) {
    const item = await this.runtime.repository.getCatalogItem(itemId, context.ownerUserId);
    if (item.serviceId !== context.serviceId) throw new ApiError(404, "jellyfin_item_not_found", "媒体条目不存在");
    const now = new Date().toISOString();
    const existing = await this.runtime.database.query("service_playback_progress").where({ service_id: context.serviceId, account_id: context.accountId, item_id: itemId }).first();
    const patch = { played: played ? 1 : 0, position_ticks: played ? Number(existing?.position_ticks ?? 0) : 0, hidden_from_resume: played ? 1 : 0, updated_at: now, last_played_at: played ? now : existing?.last_played_at ?? null };
    if (existing) await this.runtime.database.query("service_playback_progress").where({ id: existing.id }).update(patch);
    else await this.runtime.database.query("service_playback_progress").insert({ id: randomUUID(), service_id: context.serviceId, account_id: context.accountId, item_id: itemId, play_count: played ? 1 : 0, ...patch });
    return this.mapUserData({ ...existing, ...patch }, 0);
  }

  /** 从继续观看隐藏或恢复条目。 */
  public async setHiddenFromResume(context: JellyfinContext, itemId: string, hidden: boolean) {
    const item = await this.runtime.repository.getCatalogItem(itemId, context.ownerUserId);
    if (item.serviceId !== context.serviceId) throw new ApiError(404, "jellyfin_item_not_found", "媒体条目不存在");
    const now = new Date().toISOString();
    const existing = await this.runtime.database.query("service_playback_progress").where({ service_id: context.serviceId, account_id: context.accountId, item_id: itemId }).first();
    if (existing) await this.runtime.database.query("service_playback_progress").where({ id: existing.id }).update({ hidden_from_resume: hidden ? 1 : 0, updated_at: now });
    else await this.runtime.database.query("service_playback_progress").insert({ id: randomUUID(), service_id: context.serviceId, account_id: context.accountId, item_id: itemId, position_ticks: 0, played: 0, hidden_from_resume: hidden ? 1 : 0, play_count: 0, last_played_at: null, updated_at: now });
  }

  /** 读取当前账号的条目进度。 */
  private async readProgress(context: JellyfinContext, itemId: string) {
    return this.runtime.database.query("service_playback_progress").where({ service_id: context.serviceId, account_id: context.accountId, item_id: itemId }).first();
  }

  /** 读取电影或单集实际源文件时长，指定媒体源时只使用该版本。 */
  private async readItemRunTimeTicks(
    context: JellyfinContext,
    item: MediaItemRecord,
    mediaSourceId?: string,
  ): Promise<number> {
    if (!context.mediaSpecsEnabled) return 0;
    const query = this.runtime.database.query("file_links as fl")
      .leftJoin("media_file_probes as p", "p.source_file_id", "fl.source_file_id")
      .select("fl.source_file_id", "p.status", "p.result_json")
      .where({ "fl.user_id": item.userId, "fl.item_id": item.id });
    const rows = await query;
    const probes = rows.map((row) => parseCompletedMediaProbeResult(row.status, row.result_json));
    if (rows.length === 0 || probes.some((probe) => probe === null)) return 0;
    if (mediaSourceId) {
      const selectedIndex = rows.findIndex((row) => String(row.source_file_id) === mediaSourceId);
      return selectedIndex >= 0 ? probes[selectedIndex]?.runTimeTicks ?? 0 : 0;
    }
    return readJellyfinRunTimeTicks(probes);
  }

  /** 批量加载列表 DTO 所需的用户进度和文件摘要，避免对每个条目重复查询。 */
  private async loadItemMappingContext(context: JellyfinContext, itemIds: string[]): Promise<JellyfinItemMappingContext> {
    const uniqueItemIds = [...new Set(itemIds)];
    if (uniqueItemIds.length === 0) return { progressByItemId: new Map(), filesByItemId: new Map() };
    const [progressRows, fileRows] = await Promise.all([
      this.runtime.database.query("service_playback_progress")
        .where({ service_id: context.serviceId, account_id: context.accountId }).whereIn("item_id", uniqueItemIds),
      this.runtime.database.query("file_links as fl")
        .join("source_files as f", "f.id", "fl.source_file_id")
        .leftJoin("media_file_probes as p", "p.source_file_id", "f.id")
        .select("fl.item_id", "f.id as file_id", "f.name", "f.size", "p.status", "p.result_json")
        .whereIn("fl.item_id", uniqueItemIds).where({ "f.service_id": context.serviceId, "f.status": "active" }),
    ]);
    const progressByItemId = new Map(progressRows.map((row) => [String(row.item_id), row as Record<string, unknown>]));
    const filesByItemId = new Map<string, JellyfinFileSummary[]>();
    for (const row of fileRows) {
      const itemId = String(row.item_id);
      const files = filesByItemId.get(itemId) ?? [];
      files.push({
        fileId: String(row.file_id),
        name: String(row.name ?? ""),
        size: Number(row.size ?? 0),
        mediaProbe: context.mediaSpecsEnabled
          ? parseCompletedMediaProbeResult(row.status, row.result_json)
          : null,
      });
      filesByItemId.set(itemId, files);
    }
    return { progressByItemId, filesByItemId };
  }

  /** 映射 Jellyfin UserItemDataDto。 */
  private mapUserData(progress: Record<string, unknown> | null | undefined, runTimeTicks: number) {
    const positionTicks = Number(progress?.position_ticks ?? 0);
    const played = Number(progress?.played ?? 0) === 1;
    return {
      PlaybackPositionTicks: played ? 0 : positionTicks, PlayCount: Number(progress?.play_count ?? 0), IsFavorite: false,
      Played: played, LastPlayedDate: progress?.last_played_at ?? undefined,
      PlayedPercentage: runTimeTicks > 0
        ? (played ? 100 : Math.min(100, positionTicks / runTimeTicks * 100))
        : undefined,
      Key: "", ItemId: progress?.item_id, MediaSourceId: progress?.media_source_id ?? undefined,
    };
  }

  /** 跨数据库执行播放进度新增或更新。 */
  private async upsertProgress(
    transaction: Knex | Knex.Transaction,
    context: JellyfinContext,
    itemId: string,
    mediaSourceId: string | null,
    positionTicks: number,
    stopped: boolean,
    completed: boolean,
    now: string,
  ): Promise<void> {
    const existing = await transaction("service_playback_progress").where({ service_id: context.serviceId, account_id: context.accountId, item_id: itemId }).first();
    const patch = {
      media_source_id: mediaSourceId ?? existing?.media_source_id ?? null,
      position_ticks: completed ? 0 : positionTicks,
      played: completed ? 1 : 0,
      hidden_from_resume: completed ? 1 : 0,
      last_played_at: now,
      updated_at: now,
    };
    if (existing) await transaction("service_playback_progress").where({ id: existing.id }).update({ ...patch, play_count: Number(existing.play_count ?? 0) + (stopped ? 1 : 0) });
    else await transaction("service_playback_progress").insert({ id: randomUUID(), service_id: context.serviceId, account_id: context.accountId, item_id: itemId, ...patch, play_count: stopped ? 1 : 0 });
  }

  /** 查找单集父节目。 */
  private async findParent(itemId: string, userId: string): Promise<MediaItemRecord | undefined> {
    const relation = await this.runtime.database.query("media_relations").where({ child_item_id: itemId }).first();
    return relation ? this.runtime.repository.getCatalogItem(String(relation.parent_item_id), userId) : undefined;
  }

  /** 对已经映射的 DTO 执行 Jellyfin 风格分页。 */
  private paginate<T>(items: T[], query: Record<string, unknown>) {
    const start = Math.max(0, Number(query.StartIndex ?? 0));
    const limit = Math.min(500, Math.max(1, Number(query.Limit ?? (items.length || 100))));
    return { Items: items.slice(start, start + limit), TotalRecordCount: items.length, StartIndex: start };
  }

  /** 登录连续失败达到阈值时拒绝继续校验密码。 */
  private requireLoginAllowed(key: string): void {
    const attempt = this.loginFailures.get(key);
    if (!attempt || attempt.blockedUntil <= Date.now()) return;
    throw new ApiError(429, "jellyfin_login_rate_limited", "登录失败次数过多，请稍后再试");
  }

  /** 记录十分钟窗口内的失败；第八次失败后限制十五分钟。 */
  private recordLoginFailure(key: string): number {
    const now = Date.now();
    const previous = this.loginFailures.get(key);
    const current = !previous || now - previous.firstFailedAt > 10 * 60 * 1000
      ? { count: 1, firstFailedAt: now, blockedUntil: 0 }
      : { ...previous, count: previous.count + 1 };
    if (current.count >= 8) current.blockedUntil = now + 15 * 60 * 1000;
    this.loginFailures.set(key, current);
    // 限制异常来源长期堆积内存；这里只删除已经过期的失败窗口。
    if (this.loginFailures.size > 10_000) {
      for (const [attemptKey, attempt] of this.loginFailures) {
        if (attempt.blockedUntil < now && now - attempt.firstFailedAt > 10 * 60 * 1000) this.loginFailures.delete(attemptKey);
      }
    }
    return current.blockedUntil;
  }
}
