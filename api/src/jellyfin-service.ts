import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { Knex } from "knex";
import { hashSessionToken } from "./auth.js";
import { parseJsonObject, type CatalogSort, type MediaItemRecord, type VideoRegionGroup } from "./domain.js";
import { ApiError } from "./errors.js";
import type { ApiRuntime } from "./runtime.js";
import { hydrateRealtimeVideoDetails } from "./media/realtime-video-details.js";
import {
  AggregateJellyfinCatalog,
  decodeAggregateJellyfinItemId,
  encodeAggregateJellyfinItemId,
  type AggregateJellyfinItem,
} from "./aggregate-jellyfin-catalog.js";
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
  /** 是否按节目地区拆分 Jellyfin 虚拟媒体库。 */
  regionLibrariesEnabled: boolean;
  /** 当前上下文是否来自多个媒体库组成的聚合 Jellyfin。 */
  aggregateService: boolean;
}

export interface JellyfinContext extends JellyfinLibraryContext {
  accountId: string;
  accountUsername: string;
  accountHasPassword: boolean;
  credentialRevision: number;
  accessToken: string;
  /** 当前媒体库是否允许 Jellyfin 客户端下载原始影片文件。 */
  downloadEnabled: boolean;
}

interface JellyfinFileSummary {
  fileId: string;
  name: string;
  size: number;
  /** 当前源文件已经完成的 ffprobe 结果；尚未完成或失败时为空。 */
  mediaProbe: MediaProbeResult | null;
}

interface JellyfinItemMappingContext {
  progressByItemId: Map<string, Record<string, unknown>>;
  /** 当前账号已收藏的内部媒体条目 ID。 */
  favoriteItemIds: Set<string>;
  filesByItemId: Map<string, JellyfinFileSummary[]>;
}

type JellyfinCollectionType = "movies" | "tvshows";

interface JellyfinLibraryDefinition {
  /** 云助手内部用于识别虚拟媒体库的旧 ID。 */
  internalId: string;
  /** 返回给 Jellyfin 客户端的标准 UUID。 */
  id: string;
  name: string;
  collectionType: JellyfinCollectionType;
  itemType: "video.movie" | "video.series";
  regionGroup?: VideoRegionGroup;
}

interface JellyfinGenreSummary {
  name: string;
  itemCount: number;
}

interface JellyfinSeasonReference {
  seriesId: string;
  seasonNumber: number;
}

/** Jellyfin 标准图片接口实际需要代理的远端图片。 */
export interface JellyfinImageSource {
  url: string;
  imageTag: string;
  updatedAt: string;
  sourceType: "media" | "person";
}

interface JellyfinPersonSummary {
  id: string;
  name: string;
  sourceId: string;
  profileUrl: string;
  imageTag: string;
  updatedAt: string;
  /** 当前演员直接关联的顶层电影或节目 ID。 */
  itemIds: Set<string>;
}

interface JellyfinPersonCache {
  catalogVersion: number;
  peopleById: Map<string, JellyfinPersonSummary>;
}

const JELLYFIN_ITEM_UUID_PREFIX = "f10c0000";
const JELLYFIN_SEASON_UUID_PREFIX = "f2";
const JELLYFIN_USER_STATE_BATCH_SIZE = 50;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const INTERNAL_ITEM_ID_PATTERN = /^itm_([0-9a-f]{24})$/iu;

/** 把 32 位十六进制值格式化为 Jellyfin 可以解析的标准 UUID。 */
function formatProtocolUuid(hexValue: string): string {
  const hex = hexValue.toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** 为无法直接编码的虚拟实体生成稳定的 RFC 4122 version 5 形式 UUID。 */
function createProtocolUuid(scope: string, value: string): string {
  const digest = createHash("sha256").update(`flycloud-jellyfin\u0000${scope}\u0000${value}`, "utf8").digest();
  // 关键变量：版本位和变体位按 UUID v5/RFC 4122 设置，严格 SDK 可以直接反序列化。
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  return formatProtocolUuid(digest.toString("hex").slice(0, 32));
}

/** 根据远端图片地址生成稳定的 Jellyfin ImageTag。 */
function createJellyfinImageTag(imageUrl: string): string {
  return createHash("sha256").update(imageUrl, "utf8").digest("hex").slice(0, 32);
}

/** 按 Jellyfin 图片类型读取媒体条目保存的图片地址。 */
function readJellyfinImageUrl(item: MediaItemRecord, imageType: string): string {
  const normalizedType = imageType.trim().toLowerCase();
  if (normalizedType === "backdrop") return String(item.backdropUrl ?? "").trim();
  if (normalizedType === "logo") return String(item.metadata.logoUrl ?? "").trim();
  return String(item.posterUrl ?? "").trim();
}

/** 将内部 itm_ ID 可逆编码为标准 UUID；已有 UUID 保持不变。 */
function encodeProtocolItemId(itemId: string): string {
  if (UUID_PATTERN.test(itemId)) return itemId.toLowerCase();
  const match = INTERNAL_ITEM_ID_PATTERN.exec(itemId);
  if (!match?.[1]) return createProtocolUuid("item", itemId);
  return formatProtocolUuid(`${JELLYFIN_ITEM_UUID_PREFIX}${match[1]}`);
}

/** 将协议 UUID 还原为云助手内部 itm_ ID，同时继续接受旧客户端传入的内部 ID。 */
function decodeProtocolItemId(itemId: string): string {
  const normalized = itemId.trim().toLowerCase();
  if (INTERNAL_ITEM_ID_PATTERN.test(normalized)) return normalized;
  const compact = normalized.replace(/-/gu, "");
  if (compact.length === 32 && compact.startsWith(JELLYFIN_ITEM_UUID_PREFIX)) {
    return `itm_${compact.slice(JELLYFIN_ITEM_UUID_PREFIX.length)}`;
  }
  if (UUID_PATTERN.test(normalized)) return normalized;
  return itemId;
}

/** 将内部节目和季编号编码为可逆的标准 UUID。 */
function encodeProtocolSeasonId(seriesId: string, seasonNumber: number): string {
  const match = INTERNAL_ITEM_ID_PATTERN.exec(seriesId);
  if (!match?.[1]) return createProtocolUuid("season", `${seriesId}:${seasonNumber}`);
  const normalizedSeason = Math.min(0xffffff, Math.max(0, Math.floor(seasonNumber)));
  const seasonPrefix = `${JELLYFIN_SEASON_UUID_PREFIX}${normalizedSeason.toString(16).padStart(6, "0")}`;
  return formatProtocolUuid(`${seasonPrefix}${match[1]}`);
}

/** 把数据库日期转换为 Jellyfin SDK 使用的完整 ISO DateTime。 */
function toJellyfinDateTime(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

/** 将常见外部媒体库键名转换为 Jellyfin 使用的标准大小写。 */
function mapJellyfinProviderIds(providerIds: Record<string, string>): Record<string, string> {
  const mapped: Record<string, string> = {};
  Object.entries(providerIds).forEach(([key, value]) => {
    const normalized = key.toLowerCase();
    const protocolKey = normalized === "tmdb" ? "Tmdb"
      : normalized === "imdb" ? "Imdb"
        : normalized === "tvdb" ? "Tvdb"
          : key;
    mapped[protocolKey] = value;
  });
  return mapped;
}

/** 将 TMDB/NFO 人员类型映射为 Jellyfin PersonKind。 */
function mapJellyfinPersonKind(person: Record<string, unknown>): string {
  const sourceType = String(person.type ?? "").toLowerCase();
  if (sourceType === "cast" || sourceType === "actor") return "Actor";
  const role = String(person.role ?? "").toLowerCase();
  if (role.includes("director")) return "Director";
  if (role.includes("producer")) return "Producer";
  if (role.includes("writer") || role.includes("screenplay") || role.includes("creator")) return "Writer";
  return "Unknown";
}

/** 把目录文件映射为不包含转码能力的标准 Jellyfin MediaSourceInfo。 */
function mapCatalogMediaSource(
  file: JellyfinFileSummary,
  mediaSpecsReady: boolean,
  protocolMediaSourceId: string,
): Record<string, unknown> {
  const fileName = String(file.name || "video.mp4");
  const mediaProbe = mediaSpecsReady ? file.mediaProbe : null;
  const fileRunTimeTicks = mediaProbe?.runTimeTicks ?? 0;
  return {
    Protocol: "File",
    // 关键变量：Jellyfin 客户端使用条目 ID 识别条目自身的主媒体源。
    Id: protocolMediaSourceId,
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
  // 关键变量：演员 UUID 无法反解详情，按媒体库版本缓存演员实体及其关联作品索引。
  private readonly personCaches = new Map<string, JellyfinPersonCache>();
  /** 聚合服务独立读取预构建索引，避免协议请求遍历多个来源媒体库。 */
  private readonly aggregateCatalog: AggregateJellyfinCatalog;

  public constructor(private readonly runtime: ApiRuntime) {
    this.aggregateCatalog = new AggregateJellyfinCatalog(runtime);
  }

  /** 将数据库媒体条目 ID 转换为客户端使用的标准 UUID。 */
  public toProtocolItemId(itemId: string): string {
    return encodeProtocolItemId(itemId);
  }

  /** 将客户端 UUID 或旧内部 ID 转换为数据库媒体条目 ID。 */
  public toInternalItemId(itemId: string): string {
    return decodeProtocolItemId(itemId);
  }

  /** 将主媒体源 UUID 还原为内部条目 ID，其他文件媒体源 ID 保持不变。 */
  public toInternalMediaSourceId(itemId: string, mediaSourceId: string): string {
    if (!mediaSourceId) return mediaSourceId;
    const internalItemId = decodeProtocolItemId(itemId);
    return mediaSourceId === encodeProtocolItemId(internalItemId) || mediaSourceId === internalItemId
      ? internalItemId
      : mediaSourceId;
  }

  /** 按当前协议上下文编码普通或聚合媒体条目 ID。 */
  public toContextProtocolItemId(context: JellyfinLibraryContext, itemId: string): string {
    return context.aggregateService ? encodeAggregateJellyfinItemId(itemId) : encodeProtocolItemId(itemId);
  }

  /** 按当前协议上下文还原普通或聚合媒体条目 ID。 */
  public toContextInternalItemId(context: JellyfinLibraryContext, itemId: string): string {
    return context.aggregateService ? decodeAggregateJellyfinItemId(itemId) : decodeProtocolItemId(itemId);
  }

  /** 聚合条目使用首个版本为主媒体源，其他文件版本继续使用真实源文件 ID。 */
  public toContextInternalMediaSourceId(context: JellyfinLibraryContext, itemId: string, mediaSourceId: string): string {
    if (!mediaSourceId) return mediaSourceId;
    const internalItemId = this.toContextInternalItemId(context, itemId);
    const protocolItemId = this.toContextProtocolItemId(context, internalItemId);
    return mediaSourceId === protocolItemId || mediaSourceId === internalItemId ? internalItemId : mediaSourceId;
  }

  /** 根据媒体库自定义地址后缀解析其基础服务。 */
  public async resolveServiceIdByPathSuffix(pathSuffix: string): Promise<string> {
    const row = await this.runtime.database.query("media_libraries as l")
      .join("cloud_services as s", "s.id", "l.service_id")
      .select("l.service_id")
      .where("l.jellyfin_path_suffix_lookup", pathSuffix.toLowerCase())
      .whereNull("s.deleted_at")
      .first();
    if (row) return String(row.service_id);
    const aggregateRow = await this.runtime.database.query("aggregate_services")
      .select("id")
      .where({ protocol: "jellyfin", path_suffix_lookup: pathSuffix.toLowerCase() })
      .whereNull("deleted_at")
      .first();
    if (!aggregateRow) throw new ApiError(404, "jellyfin_service_not_found", "Jellyfin 服务地址不存在");
    return String(aggregateRow.id);
  }

  /** 校验服务启用状态，不要求客户端已登录。 */
  public async requireEnabledService(serviceId: string) {
    const row = await this.runtime.database.query("cloud_services as s")
      .join("media_libraries as l", "l.id", "s.library_id")
      .select("s.id", "s.user_id", "s.library_id", "s.display_name", "s.status", "l.jellyfin_enabled", "l.jellyfin_relay_playback_enabled", "l.jellyfin_download_enabled", "l.jellyfin_region_libraries_enabled", "s.provider_type", "s.credential_revision")
      .where("s.id", serviceId).whereNull("s.deleted_at").first();
    if (row) {
      if (Number(row.jellyfin_enabled) !== 1 || row.status === "disabled") throw new ApiError(404, "jellyfin_service_disabled", "Jellyfin 服务未启用");
      return { ...row, aggregate_service: 0 };
    }
    const aggregateRow = await this.runtime.database.query("aggregate_services")
      .select(
        "id", "user_id", "display_name", "status", "protocol",
        "relay_playback_enabled", "download_enabled", "region_libraries_enabled",
      )
      .where({ id: serviceId, protocol: "jellyfin" })
      .whereNull("deleted_at")
      .first();
    if (!aggregateRow) throw new ApiError(404, "jellyfin_service_not_found", "Jellyfin 服务不存在");
    if (aggregateRow.status === "disabled") throw new ApiError(404, "jellyfin_service_disabled", "Jellyfin 服务未启用");
    return {
      ...aggregateRow,
      library_id: serviceId,
      jellyfin_enabled: 1,
      jellyfin_relay_playback_enabled: Number(aggregateRow.relay_playback_enabled ?? 0),
      jellyfin_download_enabled: Number(aggregateRow.download_enabled ?? 1),
      jellyfin_region_libraries_enabled: Number(aggregateRow.region_libraries_enabled ?? 0),
      provider_type: "aggregate",
      credential_revision: 1,
      aggregate_service: 1,
    };
  }

  /** 为 Jellyfin 公开图片接口生成仅包含媒体归属的上下文。 */
  public async resolvePublicImageContext(serviceId: string): Promise<JellyfinLibraryContext> {
    const service = await this.requireEnabledService(serviceId);
    return {
      serviceId,
      ownerUserId: String(service.user_id),
      libraryId: String(service.library_id),
      regionLibrariesEnabled: Number(service.jellyfin_region_libraries_enabled) === 1,
      aggregateService: Number(service.aggregate_service ?? 0) === 1,
    };
  }

  /** 使用服务独立账号登录并创建仅属于该服务的 Jellyfin 会话。 */
  public async login(serviceId: string, request: FastifyRequest, body: Record<string, unknown>) {
    const service = await this.requireEnabledService(serviceId);
    const loginKey = `${serviceId}:${request.ip}`;
    this.requireLoginAllowed(loginKey);
    let account;
    try {
      account = Number(service.aggregate_service ?? 0) === 1
        ? await this.runtime.aggregateAccess.authenticate(serviceId, body.Username ?? body.username, body.Pw ?? body.Password ?? body.password)
        : await this.runtime.serviceAccess.authenticate(serviceId, body.Username ?? body.username, body.Pw ?? body.Password ?? body.password);
      this.loginFailures.delete(loginKey);
    } catch (error) {
      const blockedUntil = this.recordLoginFailure(loginKey);
      this.runtime.logBusinessEvent("warn", {
        日志关键字: Number(service.aggregate_service ?? 0) === 1 ? "codex-aggregate-login" : "codex-jellyfin-compat",
        事件: Number(service.aggregate_service ?? 0) === 1 ? "聚合Jellyfin账号登录失败" : "Jellyfin服务账号登录失败",
        服务ID: serviceId, 来源地址: request.ip, 是否已临时限制: blockedUntil > Date.now(),
      });
      throw error;
    }
    const token = randomBytes(32).toString("base64url");
    const protocolSessionId = randomUUID();
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + this.runtime.config.refreshTokenTtlSeconds * 1000).toISOString();
    const sessionTable = Number(service.aggregate_service ?? 0) === 1
      ? "aggregate_protocol_sessions"
      : "service_protocol_sessions";
    await this.runtime.database.query(sessionTable).insert({
      id: protocolSessionId,
      ...(Number(service.aggregate_service ?? 0) === 1
        ? { aggregate_service_id: serviceId }
        : { service_id: serviceId }),
      account_id: account.id, protocol: "jellyfin",
      token_hash: hashSessionToken(token), credential_revision: account.credentialRevision,
      device_id: readAuthorizationAttribute(request, "DeviceId")
        ?? (String((request.query as Record<string, unknown>)?.DeviceId ?? "").slice(0, 255) || null),
      device_name: readAuthorizationAttribute(request, "Device"), client_name: readAuthorizationAttribute(request, "Client"),
      expires_at: expiresAt, last_seen_at: now, revoked_at: null, created_at: now,
    });
    this.runtime.logBusinessEvent("info", {
      日志关键字: Number(service.aggregate_service ?? 0) === 1 ? "codex-aggregate-login" : "codex-jellyfin-compat",
      事件: Number(service.aggregate_service ?? 0) === 1 ? "聚合Jellyfin账号登录成功" : "Jellyfin服务账号登录成功",
      服务ID: serviceId, 服务访问账号ID: account.id, 客户端名称: readAuthorizationAttribute(request, "Client") ?? "未知",
    });
    return {
      User: this.mapUser(
        account.id,
        account.username,
        serviceId,
        account.hasPassword,
        Number(service.jellyfin_download_enabled) === 1,
      ),
      SessionInfo: { Id: protocolSessionId, ServerId: serviceId, UserId: account.id, UserName: account.username, Client: readAuthorizationAttribute(request, "Client") ?? "Jellyfin" },
      AccessToken: token,
      ServerId: serviceId,
    };
  }

  /** 验证 Jellyfin 会话并强制 serviceId、账号和凭据修订一致。 */
  public async authenticate(serviceId: string, request: FastifyRequest): Promise<JellyfinContext> {
    const token = readJellyfinToken(request);
    if (!token) throw new ApiError(401, "jellyfin_token_required", "需要 Jellyfin 访问令牌");
    const aggregateService = await this.runtime.database.query("aggregate_services")
      .select("id")
      .where({ id: serviceId, protocol: "jellyfin" })
      .whereNull("deleted_at")
      .first();
    if (aggregateService) return this.authenticateAggregate(serviceId, token);
    const row = await this.runtime.database.query("service_protocol_sessions as ps")
      .join("service_access_accounts as a", "a.id", "ps.account_id")
      .join("cloud_services as s", "s.id", "ps.service_id")
      .join("media_libraries as l", "l.id", "s.library_id")
      .select(
        "ps.*", "a.username", "a.password_required", "a.credential_revision as account_revision",
        "a.status as account_status", "s.user_id", "s.library_id", "s.status as service_status",
        "l.jellyfin_enabled", "l.jellyfin_region_libraries_enabled", "l.jellyfin_download_enabled",
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
      regionLibrariesEnabled: Number(row.jellyfin_region_libraries_enabled) === 1,
      aggregateService: false,
      accountId: String(row.account_id), accountUsername: String(row.username),
      accountHasPassword: Number(row.password_required ?? 1) !== 0,
      credentialRevision: Number(row.account_revision), accessToken: token,
      downloadEnabled: Number(row.jellyfin_download_enabled) === 1,
    };
  }

  /** 验证聚合 Jellyfin 会话并返回聚合目录上下文。 */
  private async authenticateAggregate(serviceId: string, token: string): Promise<JellyfinContext> {
    const row = await this.runtime.database.query("aggregate_protocol_sessions as ps")
      .join("aggregate_access_accounts as a", "a.id", "ps.account_id")
      .join("aggregate_services as s", "s.id", "ps.aggregate_service_id")
      .select(
        "ps.*", "a.username", "a.password_required", "a.credential_revision as account_revision",
        "a.status as account_status", "s.user_id", "s.status as service_status",
        "s.download_enabled", "s.region_libraries_enabled",
      )
      .where("ps.token_hash", hashSessionToken(token))
      .where("ps.aggregate_service_id", serviceId)
      .where("ps.protocol", "jellyfin")
      .whereNull("ps.revoked_at")
      .whereNull("s.deleted_at")
      .first();
    if (!row || String(row.expires_at) <= new Date().toISOString()
      || Number(row.credential_revision) !== Number(row.account_revision)
      || row.account_status !== "active" || row.service_status === "disabled") {
      throw new ApiError(401, "aggregate_jellyfin_session_invalid", "聚合 Jellyfin 登录已失效，请重新登录");
    }
    if (String(row.last_seen_at) < new Date(Date.now() - 5 * 60 * 1000).toISOString()) {
      await this.runtime.database.query("aggregate_protocol_sessions")
        .where({ id: row.id })
        .update({ last_seen_at: new Date().toISOString() });
    }
    return {
      serviceId,
      ownerUserId: String(row.user_id),
      libraryId: serviceId,
      regionLibrariesEnabled: Number(row.region_libraries_enabled ?? 0) === 1,
      aggregateService: true,
      accountId: String(row.account_id),
      accountUsername: String(row.username),
      accountHasPassword: Number(row.password_required ?? 0) !== 0,
      credentialRevision: Number(row.account_revision),
      accessToken: token,
      downloadEnabled: Number(row.download_enabled ?? 1) === 1,
    };
  }

  /** 撤销当前 Jellyfin 会话。 */
  public async logout(serviceId: string, request: FastifyRequest): Promise<void> {
    const token = readJellyfinToken(request);
    if (!token) return;
    const now = new Date().toISOString();
    await Promise.all([
      this.runtime.database.query("service_protocol_sessions")
        .where({ service_id: serviceId, protocol: "jellyfin", token_hash: hashSessionToken(token) })
        .whereNull("revoked_at").update({ revoked_at: now }),
      this.runtime.database.query("aggregate_protocol_sessions")
        .where({ aggregate_service_id: serviceId, protocol: "jellyfin", token_hash: hashSessionToken(token) })
        .whereNull("revoked_at").update({ revoked_at: now }),
    ]);
  }

  /** 构造 Jellyfin 用户 DTO，服务访问账号没有管理权限。 */
  public mapUser(
    accountId: string,
    username: string,
    serviceId = "",
    hasPassword = true,
    downloadEnabled = true,
  ) {
    return {
      Name: username, ServerId: serviceId, Id: accountId,
      HasPassword: hasPassword, HasConfiguredPassword: hasPassword,
      EnableAutoLogin: false, Configuration: {}, Policy: {
        IsAdministrator: false, IsHidden: false, IsDisabled: false, EnableMediaPlayback: true,
        EnableAudioPlaybackTranscoding: false, EnableVideoPlaybackTranscoding: false,
        EnableContentDownloading: downloadEnabled, EnableContentDeletion: false,
      },
    };
  }

  /** 根据媒体库开关返回电影和节目虚拟媒体库定义。 */
  private getLibraryDefinitions(context: JellyfinLibraryContext): JellyfinLibraryDefinition[] {
    const movieInternalId = `${context.libraryId}:movies`;
    const movieLibrary: JellyfinLibraryDefinition = {
      internalId: movieInternalId,
      id: createProtocolUuid("library", movieInternalId),
      name: "电影", collectionType: "movies", itemType: "video.movie",
    };
    if (!context.regionLibrariesEnabled) {
      const seriesInternalId = `${context.libraryId}:tvshows`;
      return [movieLibrary, {
        internalId: seriesInternalId,
        id: createProtocolUuid("library", seriesInternalId),
        name: "节目", collectionType: "tvshows", itemType: "video.series",
      }];
    }
    /** 地区媒体库使用内部旧 ID 查询，使用稳定 UUID 对外传输。 */
    const regionLibrary = (
      suffix: string,
      name: string,
      regionGroup: VideoRegionGroup,
    ): JellyfinLibraryDefinition => {
      const internalId = `${context.libraryId}:tvshows:${suffix}`;
      return {
        internalId,
        id: createProtocolUuid("library", internalId),
        name,
        collectionType: "tvshows",
        itemType: "video.series",
        regionGroup,
      };
    };
    return [
      movieLibrary,
      regionLibrary("chinese", "华语节目", "chinese"),
      regionLibrary("japan-korea", "日韩节目", "japan_korea"),
      regionLibrary("europe-america", "欧美节目", "europe_america"),
      regionLibrary("other", "其他节目", "other"),
    ];
  }

  /** 根据 Jellyfin 虚拟媒体库 ID 读取媒体类型约束。 */
  private findLibraryDefinition(context: JellyfinLibraryContext, libraryId: string): JellyfinLibraryDefinition | undefined {
    return this.getLibraryDefinitions(context).find((library) => library.id === libraryId || library.internalId === libraryId);
  }

  /** 解析云助手生成的虚拟季 ID，供季集查询和图片路由共用。 */
  private parseSeasonReference(value: string): JellyfinSeasonReference | null {
    const legacyMatch = value.match(/^season:([^:]+):(\d+)$/u);
    if (legacyMatch?.[1]) return { seriesId: legacyMatch[1], seasonNumber: Number(legacyMatch[2] ?? 0) };
    const compact = value.trim().toLowerCase().replace(/-/gu, "");
    if (compact.length !== 32 || !compact.startsWith(JELLYFIN_SEASON_UUID_PREFIX)) return null;
    const seasonNumber = Number.parseInt(compact.slice(2, 8), 16);
    const itemPayload = compact.slice(8);
    if (!Number.isFinite(seasonNumber) || !/^[0-9a-f]{24}$/u.test(itemPayload)) return null;
    return { seriesId: `itm_${itemPayload}`, seasonNumber };
  }

  /** 将 Jellyfin SortBy、SortOrder 映射为云助手目录排序字段。 */
  private readCatalogSort(query: Record<string, unknown>): CatalogSort {
    const requestedFields = String(this.readQueryValue(query, "SortBy") ?? "").split(",")
      .map((field) => field.trim().toLowerCase())
      .filter(Boolean);
    if (requestedFields.length === 0) return "created_desc";
    // Jellyfin 在提供 SortBy 但省略 SortOrder 时默认升序；Flymby 通常会显式传入方向。
    const sortOrder = this.readQueryValue(query, "SortOrder");
    const ascending = sortOrder === undefined
      || String(sortOrder).toLowerCase() === "ascending";
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
    return this.getLibraryDefinitions(context).find((library) => library.collectionType === collectionType
      && (collectionType === "movies" || !context.regionLibrariesEnabled || library.regionGroup === item.regionGroup))
      ?? this.getLibraryDefinitions(context)[0]!;
  }

  /** 将分类名称编码为标准且稳定的 Jellyfin 分类 UUID。 */
  private encodeGenreId(name: string): string {
    return createProtocolUuid("genre", name.trim());
  }

  /** 从 Jellyfin 分类 ID 还原分类名称，拒绝非本服务生成的格式。 */
  private decodeLegacyGenreId(genreId: string): string | null {
    if (!genreId.startsWith("genre:")) return null;
    try {
      const name = Buffer.from(genreId.slice("genre:".length), "base64url").toString("utf8").trim();
      return name || null;
    } catch {
      return null;
    }
  }

  /** 读取 Items 查询中的分类 ID 或分类名称。 */
  private async readGenreNames(context: JellyfinContext, query: Record<string, unknown>): Promise<string[]> {
    const genreIds = String(query.GenreIds ?? "").split(/[|,]/u).map((genreId) => genreId.trim()).filter(Boolean);
    const names = genreIds.map((genreId) => this.decodeLegacyGenreId(genreId))
      .filter((name): name is string => Boolean(name));
    String(query.Genres ?? "").split(/[|,]/u).map((name) => name.trim()).filter(Boolean).forEach((name) => names.push(name));
    const unresolvedIds = new Set(genreIds.filter((genreId) => !genreId.startsWith("genre:")));
    if (unresolvedIds.size > 0) {
      const rows = context.aggregateService
        ? await this.runtime.database.query("aggregate_media_items as aggregate_item")
          .join("media_items as primary_item", "primary_item.id", "aggregate_item.primary_member_item_id")
          .select("primary_item.metadata_json")
          .where({ "aggregate_item.aggregate_service_id": context.serviceId, "aggregate_item.status": "active" })
          .whereNull("aggregate_item.deleted_at")
        : await this.runtime.database.query("media_items")
          .select("metadata_json")
          .where({ user_id: context.ownerUserId, service_id: context.serviceId, media_type: "video" })
          .whereNull("deleted_at");
      // 关键变量：分类 UUID 是稳定单向值，只有收到 GenreIds 过滤时才从当前媒体库名称反查。
      rows.forEach((row) => {
        const metadata = parseJsonObject(row.metadata_json);
        if (!Array.isArray(metadata.genres)) return;
        metadata.genres.map((genre) => String(genre).trim()).filter(Boolean).forEach((name) => {
          if (unresolvedIds.has(this.encodeGenreId(name))) names.push(name);
        });
      });
    }
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
    const ownLogoUrl = String(metadata.logoUrl ?? "").trim();
    const ownLogoTag = ownLogoUrl ? createJellyfinImageTag(ownLogoUrl) : "";
    const parentLogoUrl = String(parent?.metadata.logoUrl ?? "").trim();
    const parentLogoTag = parentLogoUrl ? createJellyfinImageTag(parentLogoUrl) : "";
    // 关键变量：单集没有独立海报时继承节目海报，并明确图片所属条目，避免客户端请求错误的单集图片。
    const primaryImageTag = ownPrimaryTag || (type === "Episode" ? parentPrimaryTag : "");
    const primaryImageItemId = ownPrimaryTag ? item.id : primaryImageTag ? parent?.id : undefined;
    const imageTags: Record<string, string> = {};
    if (primaryImageTag) imageTags.Primary = primaryImageTag;
    if (ownLogoTag) imageTags.Logo = ownLogoTag;
    const people = Array.isArray(metadata.people) ? metadata.people : [];
    const genreNames = Array.isArray(metadata.genres)
      ? [...new Set(metadata.genres.map((genre) => String(genre).trim()).filter(Boolean))]
      : [];
    const itemLibrary = this.getItemLibraryDefinition(context, item);
    const protocolItemId = encodeProtocolItemId(item.id);
    const protocolParentItemId = parent ? encodeProtocolItemId(parent.id) : undefined;
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
          mediaProbe: parseCompletedMediaProbeResult(file.mediaProbeStatus, file.mediaProbeResult),
        }));
    }
    // 关键变量：规格分析开关只控制扫描后是否自动分析；Jellyfin 只判断现有数据是否完整。
    const mediaSpecsReady = itemFiles.length > 0
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
        实际文件数量: itemFiles.length,
        已完成规格文件数量: itemFiles.filter((file) => file.mediaProbe !== null).length,
      });
      this.runtime.logBusinessEvent("info", {
        日志关键字: "codex-jellyfin-artwork",
        事件: "返回Jellyfin详情图片字段",
        服务ID: context.serviceId,
        媒体条目ID: item.id,
        标题Logo标记是否存在: Boolean(ownLogoTag || parentLogoTag),
        演职人员数量: people.length,
        包含头像标记人员数量: people.filter((person) => {
          const profileUrl = String((person as Record<string, unknown>).profileUrl ?? "").trim();
          return Boolean(profileUrl);
        }).length,
      });
    }
    return {
      Name: item.title, OriginalTitle: String(metadata.originalTitle ?? ""), ServerId: context.serviceId,
      Id: protocolItemId, Etag: String(Date.parse(item.updatedAt) || 1), DateCreated: toJellyfinDateTime(item.createdAt),
      SortName: item.sortTitle, PremiereDate: toJellyfinDateTime(item.premiereDate), ProductionYear: item.year,
      Overview: item.overview, CommunityRating: Number(metadata.rating ?? 0) || undefined,
      Type: type, MediaType: "Video", IsFolder: type === "Series", LocationType: "FileSystem",
      CanDownload: context.downloadEnabled && type !== "Series" && itemFiles.length > 0,
      Genres: genreNames,
      GenreItems: genreNames.map((name) => ({ Name: name, Id: this.encodeGenreId(name) })),
      People: people.map((person) => {
        const personRecord = person as Record<string, unknown>;
        const personName = String(personRecord.name ?? "").trim();
        const personSourceId = String(personRecord.id ?? "").trim();
        const profileUrl = String(personRecord.profileUrl ?? "").trim();
        return {
          Name: personName,
          Id: createProtocolUuid("person", personSourceId ? `source:${personSourceId}` : `name:${personName}`),
          Role: String(personRecord.role ?? ""),
          Type: mapJellyfinPersonKind(personRecord),
          PrimaryImageTag: profileUrl ? createJellyfinImageTag(profileUrl) : undefined,
        };
      }),
      ProviderIds: mapJellyfinProviderIds(item.externalIds), ImageTags: imageTags,
      PrimaryImageTag: primaryImageTag || undefined,
      PrimaryImageItemId: primaryImageItemId ? encodeProtocolItemId(primaryImageItemId) : undefined,
      BackdropImageTags: item.backdropUrl ? [String(Date.parse(item.updatedAt) || 1)] : [],
      RunTimeTicks: runTimeTicks || undefined,
      Container: primaryProbe?.container || undefined,
      Bitrate: primaryProbe?.bitRate || undefined,
      MediaStreams: primaryProbe?.mediaStreams,
      MediaSources: itemFiles.map((file, index) => mapCatalogMediaSource(
        file,
        mediaSpecsReady,
        index === 0 ? protocolItemId : file.fileId,
      )),
      SeriesId: type === "Episode" ? protocolParentItemId : undefined, SeriesName: type === "Episode" ? parent?.title ?? item.subtitle : undefined,
      ParentIndexNumber: type === "Episode" ? seasonNumber : undefined, IndexNumber: type === "Episode" ? episodeNumber : undefined,
      SeasonId: type === "Episode" && parent ? encodeProtocolSeasonId(parent.id, seasonNumber) : undefined,
      SeasonName: type === "Episode" ? seasonNumber === 0 ? "特别篇" : `第 ${seasonNumber} 季` : undefined,
      ParentId: type === "Episode" && parent ? encodeProtocolSeasonId(parent.id, seasonNumber) : itemLibrary.id,
      ParentPrimaryImageItemId: type === "Episode" && parentPrimaryTag ? protocolParentItemId : undefined,
      ParentPrimaryImageTag: type === "Episode" ? parentPrimaryTag || undefined : undefined,
      SeriesPrimaryImageTag: type === "Episode" ? parentPrimaryTag || undefined : undefined,
      ParentLogoItemId: type === "Episode" && parentLogoTag ? protocolParentItemId : undefined,
      ParentLogoImageTag: type === "Episode" ? parentLogoTag || undefined : undefined,
      ParentBackdropItemId: type === "Episode" && parent?.backdropUrl ? protocolParentItemId : undefined,
      ParentBackdropImageTags: type === "Episode" && parent?.backdropUrl
        ? [String(Date.parse(parent.updatedAt) || 1)]
        : [],
      DatePlayed: progress?.last_played_at ?? undefined,
      UserData: this.mapUserData(progress, runTimeTicks, mapping?.favoriteItemIds.has(item.id) ?? await this.isMediaItemFavorite(context, item.id), protocolItemId),
    };
  }

  /** 将聚合索引的主来源条目投影为虚拟聚合媒体条目，保留来源元数据但隔离协议 ID 与服务归属。 */
  private toAggregateMediaItem(context: JellyfinLibraryContext, item: AggregateJellyfinItem): MediaItemRecord {
    return {
      ...item.primaryItem,
      id: item.aggregateItemId,
      serviceId: context.serviceId,
      libraryId: context.libraryId,
      itemType: item.itemType,
      sortTitle: item.sortTitle,
      year: item.year,
      premiereDate: item.premiereDate,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  }

  /** 将聚合条目批量映射为 Jellyfin DTO，文件版本来自全部来源成员而不是仅主元数据服务。 */
  private async mapAggregateItems(
    context: JellyfinContext,
    aggregateItems: AggregateJellyfinItem[],
    parentByAggregateItemId = new Map<string, AggregateJellyfinItem>(),
  ): Promise<Array<Record<string, unknown>>> {
    const mapping = await this.loadAggregateItemMappingContext(context, aggregateItems);
    return Promise.all(aggregateItems.map(async (aggregateItem) => {
      const parentAggregate = parentByAggregateItemId.get(aggregateItem.aggregateItemId);
      const item = this.toAggregateMediaItem(context, aggregateItem);
      const parent = parentAggregate ? this.toAggregateMediaItem(context, parentAggregate) : undefined;
      const mapped = await this.mapItem(context, item, parent, mapping) as Record<string, unknown>;
      const protocolItemId = encodeAggregateJellyfinItemId(aggregateItem.aggregateItemId);
      mapped.Id = protocolItemId;
      // 聚合电影和节目自己的海报也必须引用聚合 UUID，避免客户端到普通 itm_ 图片路径取图。
      if (item.posterUrl) mapped.PrimaryImageItemId = protocolItemId;
      // 关键变量：首个 MediaSource 是 Jellyfin 对“条目本身”的默认版本引用。
      // mapItem 先按普通 itm_ 编码生成，聚合服务必须在此替换为聚合条目 UUID，
      // 否则客户端带着旧媒体源 ID 请求 PlaybackInfo 时无法反解到聚合索引。
      const mediaSources = Array.isArray(mapped.MediaSources) ? mapped.MediaSources : [];
      if (mediaSources.length > 0 && mediaSources[0] && typeof mediaSources[0] === "object") {
        (mediaSources[0] as Record<string, unknown>).Id = protocolItemId;
      }
      if (item.itemType === "video.episode" && parentAggregate) {
        const parentProtocolItemId = encodeAggregateJellyfinItemId(parentAggregate.aggregateItemId);
        const seasonNumber = Number(item.metadata.seasonNumber ?? 0);
        const seasonId = `season:${parentAggregate.aggregateItemId}:${Number.isFinite(seasonNumber) ? seasonNumber : 0}`;
        // 关键变量：聚合集季使用可反解的虚拟季 ID，不能沿用单服务 itm_ UUID 解析规则。
        mapped.SeriesId = parentProtocolItemId;
        mapped.SeriesName = parent?.title ?? item.subtitle;
        mapped.SeasonId = seasonId;
        mapped.ParentId = seasonId;
        mapped.ParentPrimaryImageItemId = parent?.posterUrl ? parentProtocolItemId : undefined;
        mapped.ParentLogoItemId = parent?.metadata.logoUrl ? parentProtocolItemId : undefined;
        mapped.ParentBackdropItemId = parent?.backdropUrl ? parentProtocolItemId : undefined;
      }
      return mapped;
    }));
  }

  /** 批量读取聚合 Jellyfin 列表的进度、收藏和版本摘要，避免卡片渲染产生 N+1 查询。 */
  private async loadAggregateItemMappingContext(
    context: JellyfinContext,
    aggregateItems: AggregateJellyfinItem[],
  ): Promise<JellyfinItemMappingContext> {
    const aggregateItemIds = aggregateItems.map((item) => item.aggregateItemId);
    const filesByAggregateItemId = await this.aggregateCatalog.listFilesForItems(aggregateItems);
    const filesByItemId = new Map<string, JellyfinFileSummary[]>();
    filesByAggregateItemId.forEach((files, aggregateItemId) => {
      filesByItemId.set(aggregateItemId, files.map((file) => ({
        fileId: file.fileId,
        name: file.name,
        size: file.size,
        mediaProbe: parseCompletedMediaProbeResult(file.mediaProbeStatus, file.mediaProbeResult),
      })));
    });
    if (aggregateItemIds.length === 0) {
      return { progressByItemId: new Map(), favoriteItemIds: new Set(), filesByItemId };
    }
    const [progressRows, preferenceRows] = await Promise.all([
      this.runtime.database.query("aggregate_playback_progress")
        .where({ aggregate_service_id: context.serviceId, account_id: context.accountId })
        .whereIn("aggregate_item_id", aggregateItemIds),
      this.runtime.database.query("aggregate_item_preferences")
        .select("aggregate_item_id")
        .where({ aggregate_service_id: context.serviceId, account_id: context.accountId })
        .whereIn("aggregate_item_id", aggregateItemIds)
        .whereNotNull("starred_at"),
    ]);
    const progressByItemId = new Map(progressRows.map((row) => [String(row.aggregate_item_id), {
      ...row,
      item_id: String(row.aggregate_item_id),
    }]));
    return {
      progressByItemId,
      favoriteItemIds: new Set(preferenceRows.map((row) => String(row.aggregate_item_id))),
      filesByItemId,
    };
  }

  /** 按聚合索引读取一个节目下的季和集编号。 */
  private async listAggregateSeasons(context: JellyfinContext, aggregateSeriesId: string) {
    const series = await this.aggregateCatalog.getItem(context.serviceId, context.ownerUserId, aggregateSeriesId);
    if (series.itemType !== "video.series") throw new ApiError(404, "aggregate_jellyfin_series_not_found", "聚合节目不存在");
    const episodes = await this.aggregateCatalog.listEpisodes(context.serviceId, context.ownerUserId, aggregateSeriesId);
    const seasonNumbers = [...new Set(episodes.map((episode) => Math.max(0, Number(episode.primaryItem.metadata.seasonNumber ?? 0))))]
      .sort((left, right) => left - right);
    const seriesItem = this.toAggregateMediaItem(context, series);
    const primaryImageTag = seriesItem.posterUrl ? String(Date.parse(seriesItem.updatedAt) || 1) : "";
    const backdropImageTag = seriesItem.backdropUrl ? String(Date.parse(seriesItem.updatedAt) || 1) : "";
    const protocolSeriesId = encodeAggregateJellyfinItemId(series.aggregateItemId);
    const items = seasonNumbers.map((seasonNumber) => ({
      Name: seasonNumber === 0 ? "特别篇" : `第 ${seasonNumber} 季`,
      Id: `season:${series.aggregateItemId}:${seasonNumber}`,
      ServerId: context.serviceId,
      Type: "Season",
      IsFolder: true,
      SeriesId: protocolSeriesId,
      SeriesName: seriesItem.title,
      IndexNumber: seasonNumber,
      ParentId: protocolSeriesId,
      ImageTags: primaryImageTag ? { Primary: primaryImageTag } : {},
      PrimaryImageTag: primaryImageTag || undefined,
      PrimaryImageItemId: primaryImageTag ? protocolSeriesId : undefined,
      SeriesPrimaryImageTag: primaryImageTag || undefined,
      ParentPrimaryImageItemId: primaryImageTag ? protocolSeriesId : undefined,
      ParentPrimaryImageTag: primaryImageTag || undefined,
      BackdropImageTags: backdropImageTag ? [backdropImageTag] : [],
      ParentBackdropItemId: backdropImageTag ? protocolSeriesId : undefined,
      ParentBackdropImageTags: backdropImageTag ? [backdropImageTag] : [],
      UserData: this.mapUserData(null, 0),
    }));
    return { Items: items, TotalRecordCount: items.length, StartIndex: 0 };
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
      PrimaryImageItemId: primaryImageTag && coverItem ? encodeProtocolItemId(coverItem.id) : undefined,
      BackdropImageTags: backdropImageTag ? [backdropImageTag] : [],
      ParentBackdropItemId: backdropImageTag && coverItem ? encodeProtocolItemId(coverItem.id) : undefined,
      UserData: this.mapUserData(null, 0),
    };
  }

  /** 返回指定媒体条目所属的电影或节目媒体库 DTO。 */
  public mapItemLibrary(context: JellyfinContext, item: MediaItemRecord) {
    return this.mapLibrary(context, this.getItemLibraryDefinition(context, item), 0, item);
  }

  /** 按协议条目 ID 读取详情；聚合服务只使用自身索引，普通服务保留原有目录读取。 */
  public async getItemDetail(context: JellyfinContext, protocolItemId: string): Promise<Record<string, unknown>> {
    if (context.aggregateService) {
      const aggregateItem = await this.aggregateCatalog.getItem(
        context.serviceId,
        context.ownerUserId,
        decodeAggregateJellyfinItemId(protocolItemId),
      );
      const parent = aggregateItem.parentAggregateItemId
        ? await this.aggregateCatalog.getItem(context.serviceId, context.ownerUserId, aggregateItem.parentAggregateItemId)
        : undefined;
      const items = await this.mapAggregateItems(
        context,
        [aggregateItem],
        parent ? new Map([[aggregateItem.aggregateItemId, parent]]) : undefined,
      );
      return items[0] ?? {};
    }
    const sourceItem = await this.runtime.repository.getCatalogItem(
      this.toInternalItemId(protocolItemId),
      context.ownerUserId,
    );
    const item = await hydrateRealtimeVideoDetails(this.runtime, sourceItem);
    const parentRelation = item.itemType === "video.episode"
      ? await this.runtime.database.query("media_relations").where({ child_item_id: item.id }).first()
      : null;
    const parent = parentRelation
      ? await this.runtime.repository.getCatalogItem(String(parentRelation.parent_item_id), context.ownerUserId)
      : undefined;
    return await this.mapItem(context, item, parent) as Record<string, unknown>;
  }

  /** 解析聚合播放条目及其全部来源版本，调用方必须使用返回的真实来源服务访问 Provider。 */
  public async getAggregatePlaybackItem(context: JellyfinContext, protocolItemId: string) {
    if (!context.aggregateService) throw new ApiError(422, "aggregate_jellyfin_context_required", "当前不是聚合 Jellyfin 上下文");
    const aggregateItem = await this.aggregateCatalog.getItem(
      context.serviceId,
      context.ownerUserId,
      decodeAggregateJellyfinItemId(protocolItemId),
    );
    return {
      aggregateItem,
      files: await this.aggregateCatalog.listFiles(aggregateItem),
    };
  }

  /** 读取聚合媒体版本实际所属的源服务连接配置，禁止使用聚合虚拟服务访问网盘。 */
  public async getAggregateSourceService(context: JellyfinContext, sourceServiceId: string) {
    const service = await this.runtime.database.query("cloud_services as service")
      .join("media_libraries as library", "library.id", "service.library_id")
      .select(
        "service.id", "service.user_id", "service.library_id", "service.status", "service.provider_type", "service.credential_revision",
        "library.jellyfin_relay_playback_enabled",
      )
      .where({ "service.id": sourceServiceId, "service.user_id": context.ownerUserId })
      .whereNull("service.deleted_at")
      .first();
    if (!service) throw new ApiError(404, "aggregate_jellyfin_source_service_not_found", "聚合媒体来源服务不存在");
    if (service.status === "disabled") throw new ApiError(409, "aggregate_jellyfin_source_service_disabled", "聚合媒体来源服务已停用");
    return service;
  }

  /** 返回条目的 Jellyfin 面包屑；聚合节目和单集始终定位到同一虚拟媒体库。 */
  public async listItemAncestors(context: JellyfinContext, protocolItemId: string): Promise<Array<Record<string, unknown>>> {
    if (context.aggregateService) {
      const aggregateItem = await this.aggregateCatalog.getItem(
        context.serviceId,
        context.ownerUserId,
        decodeAggregateJellyfinItemId(protocolItemId),
      );
      const item = this.toAggregateMediaItem(context, aggregateItem);
      const library = this.mapLibrary(
        context,
        this.getItemLibraryDefinition(context, item),
        0,
        item,
      ) as Record<string, unknown>;
      if (!aggregateItem.parentAggregateItemId) return [library];
      const parent = await this.aggregateCatalog.getItem(context.serviceId, context.ownerUserId, aggregateItem.parentAggregateItemId);
      const parentDto = (await this.mapAggregateItems(context, [parent]))[0];
      return parentDto ? [library, parentDto] : [library];
    }
    const item = await this.runtime.repository.getCatalogItem(this.toInternalItemId(protocolItemId), context.ownerUserId);
    if (item.serviceId !== context.serviceId) throw new ApiError(404, "jellyfin_item_not_found", "媒体条目不存在");
    if (item.itemType !== "video.episode") return [this.mapItemLibrary(context, item)];
    const relation = await this.runtime.database.query("media_relations").where({ child_item_id: item.id }).first();
    if (!relation) return [this.mapItemLibrary(context, item)];
    const parent = await this.runtime.repository.getCatalogItem(String(relation.parent_item_id), context.ownerUserId);
    return [this.mapItemLibrary(context, parent), await this.mapItem(context, parent)];
  }

  /** 返回聚合服务的电影和节目虚拟媒体库；只统计预构建聚合索引中的有效条目。 */
  private async listAggregateLibraries(context: JellyfinContext) {
    const libraries = this.getLibraryDefinitions(context);
    const results = await Promise.all(libraries.map((library) => this.aggregateCatalog.listTopLevel({
      aggregateServiceId: context.serviceId,
      ownerUserId: context.ownerUserId,
      itemTypes: [library.itemType],
      regionGroup: library.regionGroup,
      sort: "updated_desc",
      limit: 24,
      offset: 0,
    })));
    const items = libraries.map((library, index) => {
      const result = results[index];
      const cover = result?.items.find((item) => Boolean(item.primaryItem.posterUrl || item.primaryItem.backdropUrl));
      const coverItem = cover ? this.toAggregateMediaItem(context, cover) : undefined;
      const mapped = this.mapLibrary(context, library, result?.total ?? 0, coverItem) as Record<string, unknown>;
      if (cover) {
        const protocolItemId = encodeAggregateJellyfinItemId(cover.aggregateItemId);
        mapped.PrimaryImageItemId = coverItem?.posterUrl ? protocolItemId : undefined;
        mapped.ParentBackdropItemId = coverItem?.backdropUrl ? protocolItemId : undefined;
      }
      return mapped;
    });
    return { Items: items, TotalRecordCount: items.length, StartIndex: 0 };
  }

  /** 返回当前服务的电影媒体库，以及按开关决定是否拆分地区的节目媒体库。 */
  public async listLibraries(context: JellyfinContext) {
    if (context.aggregateService) return this.listAggregateLibraries(context);
    const libraries = this.getLibraryDefinitions(context);
    const counts = await Promise.all(libraries.map((library) => this.runtime.repository.listCatalogItems({
      userId: context.ownerUserId, serviceId: context.serviceId, mediaType: "video", itemType: library.itemType,
      regionGroup: library.regionGroup,
      sort: "updated_desc", limit: 60, offset: 0, includeFileCounts: false,
    })));
    const items = libraries.map((library, index) => {
      const result = counts[index];
      // 关键变量：虚拟媒体库使用最近更新且真实拥有海报的条目作为封面，不生成无效的虚拟图片地址。
      const coverItem = result?.items.find((item) => Boolean(item.posterUrl))
        ?? result?.items.find((item) => Boolean(item.backdropUrl));
      return this.mapLibrary(context, library, result?.total ?? 0, coverItem);
    });
    return { Items: items, TotalRecordCount: items.length, StartIndex: 0 };
  }

  /** 查询顶层目录，支持 Jellyfin 常用过滤、搜索和分页参数。 */
  public async listItems(context: JellyfinContext, query: Record<string, unknown>) {
    if (this.queryIncludesFilter(query, "IsFavorite", "IsFavorite")) {
      return this.listFavoriteItems(context, query);
    }
    if (this.queryIncludesFilter(query, "IsPlayed", "IsPlayed")) {
      return this.listPlayedItems(context, query);
    }
    if (context.aggregateService) return this.listAggregateItems(context, query);
    const include = String(query.IncludeItemTypes ?? "").split(",").filter(Boolean);
    const parentId = String(query.ParentId ?? "");
    const virtualLibrary = this.findLibraryDefinition(context, parentId);
    if (parentId && parentId !== context.libraryId && !virtualLibrary) {
      const virtualSeason = this.parseSeasonReference(parentId);
      if (virtualSeason) return this.listEpisodes(context, virtualSeason.seriesId, { ...query, SeasonId: parentId });
      const internalParentId = decodeProtocolItemId(parentId);
      const parent = await this.runtime.repository.getCatalogItem(internalParentId, context.ownerUserId);
      if (parent.serviceId !== context.serviceId) throw new ApiError(404, "jellyfin_item_not_found", "媒体条目不存在");
      const children = await this.runtime.repository.listCatalogChildren(internalParentId, context.ownerUserId);
      const hydratedChildren = await Promise.all(children.map((item) => (
        item.itemType === "video.episode" ? hydrateRealtimeVideoDetails(this.runtime, item) : item
      )));
      const mapping = await this.loadItemMappingContext(context, hydratedChildren.map((item) => item.id));
      const items = await Promise.all(hydratedChildren.map((item) => this.mapItem(context, item, parent, mapping)));
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
    const genres = await this.readGenreNames(context, query);
    const personIds = String(query.PersonIds ?? "").split(",")
      .map((personId) => personId.trim().toLowerCase())
      .filter(Boolean);
    if (personIds.length > 0) {
      return this.listItemsByPersonIds(
        context,
        personIds,
        effectiveTypes,
        virtualLibrary,
        genres,
        search,
        sort,
        limit,
        offset,
      );
    }
    let records: MediaItemRecord[];
    let total: number;
    if (effectiveTypes.length > 1) {
      const results = await Promise.all(effectiveTypes.map((requestedType) => this.runtime.repository.listCatalogItems({
        userId: context.ownerUserId, serviceId: context.serviceId, mediaType: "video", itemType: requestedType,
        regionGroup: virtualLibrary?.regionGroup, genres, search, sort, limit: 500, offset: 0, includeFileCounts: false,
      })));
      const combined = results.flatMap((result) => result.items);
      combined.sort((left, right) => this.compareCatalogItems(left, right, sort));
      records = combined.slice(offset, offset + limit);
      total = results.reduce((sum, result) => sum + result.total, 0);
    } else {
      const result = await this.runtime.repository.listCatalogItems({
        userId: context.ownerUserId, serviceId: context.serviceId, mediaType: "video", itemType,
        regionGroup: virtualLibrary?.regionGroup, genres, search, sort, limit, offset, includeFileCounts: false,
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
    this.runtime.logBusinessEvent("info", {
      日志关键字: "codex-jellyfin-standard-id",
      事件: "返回标准UUID媒体条目",
      服务ID: context.serviceId,
      媒体库协议ID: virtualLibrary?.id ?? "根目录",
      返回数量: items.length,
      首条内部ID: records[0]?.id ?? "无",
      首条协议ID: String(items[0]?.Id ?? "无"),
    });
    return { Items: items, TotalRecordCount: total, StartIndex: offset };
  }

  /** 读取聚合 Jellyfin 顶层目录、节目子集和虚拟季；普通服务仍使用原有单库实现。 */
  private async listAggregateItems(context: JellyfinContext, query: Record<string, unknown>) {
    const include = String(query.IncludeItemTypes ?? "").split(",").map((item) => item.trim()).filter(Boolean);
    const requestedTypes = include.map((type) => type === "Movie" ? "video.movie" : type === "Series" ? "video.series" : type === "Episode" ? "video.episode" : "")
      .filter((type) => type.length > 0);
    if (include.length > 0 && requestedTypes.length === 0) return { Items: [], TotalRecordCount: 0, StartIndex: 0 };
    const parentId = String(query.ParentId ?? "").trim();
    const virtualLibrary = this.findLibraryDefinition(context, parentId);
    const virtualSeason = this.parseSeasonReference(parentId);
    if (virtualSeason) return this.listAggregateEpisodes(context, virtualSeason.seriesId, { ...query, SeasonId: parentId });
    if (parentId && parentId !== context.libraryId && !virtualLibrary) {
      const aggregateParentId = decodeAggregateJellyfinItemId(parentId);
      const parent = await this.aggregateCatalog.getItem(context.serviceId, context.ownerUserId, aggregateParentId);
      if (parent.itemType !== "video.series") {
        throw new ApiError(404, "aggregate_jellyfin_parent_not_found", "聚合媒体条目不包含可浏览子项");
      }
      const children = await this.aggregateCatalog.listEpisodes(context.serviceId, context.ownerUserId, aggregateParentId);
      const items = await this.mapAggregateItems(
        context,
        children,
        new Map(children.map((item) => [item.aggregateItemId, parent])),
      );
      return this.paginate(items, query);
    }
    const effectiveTypes = virtualLibrary
      ? requestedTypes.length === 0 || requestedTypes.includes(virtualLibrary.itemType) ? [virtualLibrary.itemType] : []
      : requestedTypes;
    if (virtualLibrary && effectiveTypes.length === 0) return { Items: [], TotalRecordCount: 0, StartIndex: 0 };
    const limit = Math.min(500, Math.max(1, Number(query.Limit ?? 100)));
    const offset = Math.max(0, Number(query.StartIndex ?? 0));
    const genres = await this.readGenreNames(context, query);
    const personIds = String(query.PersonIds ?? "").split(",")
      .map((personId) => personId.trim().toLowerCase())
      .filter(Boolean);
    if (personIds.length > 0) {
      return this.listAggregateItemsByPersonIds(context, personIds, effectiveTypes, virtualLibrary, genres, query);
    }
    const result = await this.aggregateCatalog.listTopLevel({
      aggregateServiceId: context.serviceId,
      ownerUserId: context.ownerUserId,
      itemTypes: effectiveTypes,
      search: typeof query.SearchTerm === "string" ? query.SearchTerm : undefined,
      genres,
      regionGroup: virtualLibrary?.regionGroup,
      sort: this.readCatalogSort(query),
      limit,
      offset,
    });
    const items = await this.mapAggregateItems(context, result.items);
    this.runtime.logBusinessEvent("info", {
      日志关键字: "codex-aggregate-jellyfin",
      事件: "返回聚合Jellyfin目录列表",
      聚合服务ID: context.serviceId,
      媒体库类型: virtualLibrary?.collectionType ?? "全部",
      返回数量: items.length,
      总数量: result.total,
    });
    return { Items: items, TotalRecordCount: result.total, StartIndex: offset };
  }

  /** 批量装配聚合条目及其节目父项，供收藏、历史、继续观看等账号状态列表复用。 */
  private async mapAggregateStateItems(context: JellyfinContext, aggregateItemIds: string[]): Promise<Array<Record<string, unknown>>> {
    const items = await this.aggregateCatalog.getItems(context.serviceId, context.ownerUserId, aggregateItemIds);
    const parentIds = [...new Set(items.map((item) => item.parentAggregateItemId).filter((itemId): itemId is string => Boolean(itemId)))];
    const parents = await this.aggregateCatalog.getItems(context.serviceId, context.ownerUserId, parentIds);
    const parentByAggregateItemId = new Map(parents.map((item) => [item.aggregateItemId, item]));
    const itemParents = new Map<string, AggregateJellyfinItem>();
    items.forEach((item) => {
      if (!item.parentAggregateItemId) return;
      const parent = parentByAggregateItemId.get(item.parentAggregateItemId);
      // 已被删除的来源节目不应该阻断收藏、历史等整个列表，只退化为独立单集卡片。
      if (parent) itemParents.set(item.aggregateItemId, parent);
    });
    return this.mapAggregateItems(context, items, itemParents);
  }

  /** 按聚合演员 ID 从聚合索引过滤作品，演员关联始终指向聚合条目而不是来源服务条目。 */
  private async listAggregateItemsByPersonIds(
    context: JellyfinContext,
    personIds: string[],
    effectiveTypes: string[],
    virtualLibrary: JellyfinLibraryDefinition | undefined,
    genres: string[],
    query: Record<string, unknown>,
  ) {
    const personCache = await this.loadPersonCache(context);
    const aggregateItemIds = new Set<string>();
    personIds.forEach((personId) => personCache.peopleById.get(personId)?.itemIds.forEach((itemId) => aggregateItemIds.add(itemId)));
    const records = await this.aggregateCatalog.getItems(context.serviceId, context.ownerUserId, [...aggregateItemIds]);
    const search = String(query.SearchTerm ?? "").trim().toLocaleLowerCase("zh-CN");
    const filtered = records.filter((item) => {
      if (effectiveTypes.length > 0 && !effectiveTypes.includes(item.itemType)) return false;
      if (virtualLibrary?.regionGroup && item.primaryItem.regionGroup !== virtualLibrary.regionGroup) return false;
      if (search && !item.sortTitle.toLocaleLowerCase("zh-CN").includes(search)) return false;
      const itemGenres = Array.isArray(item.primaryItem.metadata.genres)
        ? item.primaryItem.metadata.genres.map((genre) => String(genre).trim())
        : [];
      return genres.length === 0 || genres.some((genre) => itemGenres.includes(genre));
    });
    const sort = this.readCatalogSort(query);
    filtered.sort((left, right) => this.compareCatalogItems(
      this.toAggregateMediaItem(context, left),
      this.toAggregateMediaItem(context, right),
      sort,
    ));
    const offset = Math.max(0, Number(query.StartIndex ?? 0));
    const limit = Math.min(500, Math.max(1, Number(query.Limit ?? 100)));
    const items = await this.mapAggregateItems(context, filtered.slice(offset, offset + limit));
    return { Items: items, TotalRecordCount: filtered.length, StartIndex: offset };
  }

  /** 返回聚合账号的收藏媒体，收藏状态只保存于 aggregate_item_preferences。 */
  private async listAggregateFavoriteItems(context: JellyfinContext, query: Record<string, unknown>) {
    const rows = await this.runtime.database.query("aggregate_item_preferences")
      .select("aggregate_item_id")
      .where({ aggregate_service_id: context.serviceId, account_id: context.accountId })
      .whereNotNull("starred_at")
      .orderBy("starred_at", "desc")
      .limit(500);
    const items = await this.mapAggregateStateItems(context, rows.map((row) => String(row.aggregate_item_id)));
    return this.paginate(items, query);
  }

  /** 返回聚合账号已经标记已观看的媒体。 */
  private async listAggregatePlayedItems(context: JellyfinContext, query: Record<string, unknown>) {
    const rows = await this.runtime.database.query("aggregate_playback_progress")
      .select("aggregate_item_id")
      .where({ aggregate_service_id: context.serviceId, account_id: context.accountId, played: 1 })
      .orderBy("updated_at", "desc")
      .limit(500);
    const items = await this.mapAggregateStateItems(context, rows.map((row) => String(row.aggregate_item_id)));
    return this.paginate(items, query);
  }

  /** 返回聚合账号可续播的媒体。 */
  private async listAggregateResume(context: JellyfinContext, query: Record<string, unknown>) {
    const rows = await this.runtime.database.query("aggregate_playback_progress")
      .select("aggregate_item_id")
      .where({ aggregate_service_id: context.serviceId, account_id: context.accountId, played: 0, hidden_from_resume: 0 })
      .where("position_ticks", ">", 0)
      .orderBy("updated_at", "desc")
      .limit(500);
    const mappedItems = await this.mapAggregateStateItems(context, rows.map((row) => String(row.aggregate_item_id)));
    // 与普通 Jellyfin 保持一致：低于 60 秒的试播记录不进入继续观看；剧集只展示最近一集。
    const seenSeries = new Set<string>();
    const items = mappedItems.filter((item) => {
      const userData = item.UserData as Record<string, unknown> | undefined;
      if (Number(userData?.PlaybackPositionTicks ?? 0) < 600_000_000) return false;
      const type = String(item.Type ?? "");
      const seriesId = String(item.SeriesId ?? "");
      const groupId = type === "Episode" && seriesId ? `series:${seriesId}` : `item:${String(item.Id ?? "")}`;
      if (seenSeries.has(groupId)) return false;
      seenSeries.add(groupId);
      return true;
    });
    return this.paginate(items, query);
  }

  /** 返回聚合账号的播放历史。 */
  private async listAggregateHistory(context: JellyfinContext, query: Record<string, unknown>) {
    const rows = await this.runtime.database.query("aggregate_playback_progress")
      .select("aggregate_item_id")
      .where({ aggregate_service_id: context.serviceId, account_id: context.accountId })
      .whereNotNull("last_played_at")
      .orderBy("last_played_at", "desc")
      .limit(500);
    const items = await this.mapAggregateStateItems(context, rows.map((row) => String(row.aggregate_item_id)));
    return this.paginate(items, query);
  }

  /** 读取聚合条目总时长；规格未完整时返回 0，沿用普通 Jellyfin 的保守观看规则。 */
  private async readAggregateItemRunTimeTicks(context: JellyfinContext, aggregateItem: AggregateJellyfinItem, mediaSourceId?: string): Promise<number> {
    const files = await this.aggregateCatalog.listFiles(aggregateItem);
    if (files.length === 0) return 0;
    const probes = files.map((file) => parseCompletedMediaProbeResult(file.mediaProbeStatus, file.mediaProbeResult));
    if (probes.some((probe) => probe === null)) return 0;
    if (mediaSourceId) {
      const index = mediaSourceId === aggregateItem.aggregateItemId
        || mediaSourceId === encodeAggregateJellyfinItemId(aggregateItem.aggregateItemId)
        ? 0
        : files.findIndex((file) => file.fileId === mediaSourceId);
      return index >= 0 ? probes[index]?.runTimeTicks ?? 0 : 0;
    }
    return readJellyfinRunTimeTicks(probes);
  }

  /** 读取一个聚合账号的条目进度。 */
  private async readAggregateProgress(context: JellyfinContext, aggregateItemId: string) {
    return this.runtime.database.query("aggregate_playback_progress")
      .where({ aggregate_service_id: context.serviceId, account_id: context.accountId, aggregate_item_id: aggregateItemId })
      .first();
  }

  /** 按当前 Jellyfin 账号返回已收藏的媒体和 Person 条目。 */
  public async listFavoriteItems(context: JellyfinContext, query: Record<string, unknown>) {
    if (context.aggregateService) return this.listAggregateFavoriteItems(context, query);
    const include = String(this.readQueryValue(query, "IncludeItemTypes") ?? "").split(",").map((value) => value.trim()).filter(Boolean);
    const requestedMediaTypes: string[] = include.map((type) => type === "Movie" ? "video.movie" : type === "Series" ? "video.series" : type === "Episode" ? "video.episode" : "")
      .filter(Boolean);
    const includePeople = include.length === 0 || include.includes("Person");
    const includeMedia = include.length === 0 || requestedMediaTypes.length > 0;
    const mediaPreferenceRows = includeMedia
      ? await this.runtime.database.query("service_item_preferences as pref")
        .join("media_items as m", "m.id", "pref.item_id")
        .select("pref.item_id", "pref.starred_at")
        .where({ "pref.service_id": context.serviceId, "pref.account_id": context.accountId })
        .whereNotNull("pref.starred_at")
        .whereNull("m.deleted_at")
        .orderBy("pref.starred_at", "desc")
        .limit(500)
      : [];
    const records: Array<{ item: MediaItemRecord; parent?: MediaItemRecord }> = [];
    for (const row of mediaPreferenceRows) {
      const item = await this.runtime.repository.getCatalogItem(String(row.item_id), context.ownerUserId);
      if (item.serviceId !== context.serviceId) continue;
      if (requestedMediaTypes.length > 0 && !requestedMediaTypes.includes(item.itemType)) continue;
      const parent = item.itemType === "video.episode" ? await this.findParent(item.id, context.ownerUserId) : undefined;
      if (!this.matchesParentScope(context, item, parent, query)) continue;
      const searchTerm = String(this.readQueryValue(query, "SearchTerm") ?? "").trim().toLocaleLowerCase("zh-CN");
      if (searchTerm && !item.title.toLocaleLowerCase("zh-CN").includes(searchTerm)) continue;
      records.push({ item, parent });
    }
    const sort = this.readCatalogSort(query);
    records.sort((left, right) => this.compareCatalogItems(left.item, right.item, sort));
    const mapping = await this.loadItemMappingContext(context, records.map((record) => record.item.id));
    const mediaItems = await Promise.all(records.map((record) => this.mapItem(context, record.item, record.parent, mapping)));

    let personItems: Array<Record<string, unknown>> = [];
    if (includePeople) {
      const virtualRows = await this.runtime.database.query("service_jellyfin_virtual_preferences")
        .select("protocol_item_id")
        .where({ service_id: context.serviceId, account_id: context.accountId, item_type: "Person" })
        .orderBy("starred_at", "desc")
        .limit(500);
      const people = await Promise.all(virtualRows.map((row) => this.getPersonItem(context, String(row.protocol_item_id))));
      personItems = people.filter(Boolean).map((item) => item as unknown as Record<string, unknown>);
      personItems.sort((left, right) => String(left.SortName ?? left.Name ?? "").localeCompare(String(right.SortName ?? right.Name ?? ""), "zh-CN"));
    }
    const items = [...mediaItems, ...personItems];
    this.runtime.logBusinessEvent("info", {
      日志关键字: "codex-jellyfin-user-state",
      事件: "返回Jellyfin收藏列表",
      服务ID: context.serviceId,
      账号ID: context.accountId,
      媒体数量: mediaItems.length,
      人物数量: personItems.length,
    });
    return this.paginate(items, query);
  }

  /** 只返回明确标记为已观看的条目，不将普通播放历史混入。 */
  public async listPlayedItems(context: JellyfinContext, query: Record<string, unknown>) {
    if (context.aggregateService) return this.listAggregatePlayedItems(context, query);
    const include = String(this.readQueryValue(query, "IncludeItemTypes") ?? "").split(",").map((value) => value.trim()).filter(Boolean);
    const requestedTypes: string[] = include.map((type) => type === "Movie" ? "video.movie" : type === "Series" ? "video.series" : type === "Episode" ? "video.episode" : "")
      .filter(Boolean);
    if (include.length > 0 && requestedTypes.length === 0) return { Items: [], TotalRecordCount: 0, StartIndex: 0 };
    const rows = await this.runtime.database.query("service_playback_progress as p")
      .join("media_items as m", "m.id", "p.item_id")
      .select("m.id")
      .where({ "p.service_id": context.serviceId, "p.account_id": context.accountId, "p.played": 1 })
      .whereNull("m.deleted_at")
      .orderBy("p.last_played_at", "desc")
      .limit(500);
    const records: Array<{ item: MediaItemRecord; parent?: MediaItemRecord }> = [];
    for (const row of rows) {
      const item = await this.runtime.repository.getCatalogItem(String(row.id), context.ownerUserId);
      if (requestedTypes.length > 0 && !requestedTypes.includes(item.itemType)) continue;
      const parent = item.itemType === "video.episode" ? await this.findParent(item.id, context.ownerUserId) : undefined;
      if (!this.matchesParentScope(context, item, parent, query)) continue;
      records.push({ item, parent });
    }
    const mapping = await this.loadItemMappingContext(context, records.map((record) => record.item.id));
    const items = await Promise.all(records.map((record) => this.mapItem(context, record.item, record.parent, mapping)));
    this.runtime.logBusinessEvent("info", {
      日志关键字: "codex-jellyfin-user-state",
      事件: "返回Jellyfin已观看列表",
      服务ID: context.serviceId,
      账号ID: context.accountId,
      已观看数量: items.length,
    });
    return this.paginate(items, query);
  }

  /** 按 Jellyfin PersonIds 返回演员直接关联的电影或节目。 */
  private async listItemsByPersonIds(
    context: JellyfinContext,
    personIds: string[],
    effectiveTypes: string[],
    virtualLibrary: JellyfinLibraryDefinition | undefined,
    genres: string[],
    search: string | undefined,
    sort: CatalogSort,
    limit: number,
    offset: number,
  ) {
    const personCache = await this.loadPersonCache(context);
    // 关键变量：多个 PersonIds 按 Jellyfin 的任一人员命中处理，作品 ID 使用集合去重。
    const associatedItemIds = new Set<string>();
    personIds.forEach((personId) => {
      personCache.peopleById.get(personId)?.itemIds.forEach((itemId) => associatedItemIds.add(itemId));
    });
    const itemIds = [...associatedItemIds];
    if (itemIds.length === 0) {
      return { Items: [], TotalRecordCount: 0, StartIndex: offset };
    }
    const requestedTypes = effectiveTypes.length > 0
      ? effectiveTypes
      : ["video.movie", "video.series"];
    const results = await Promise.all(requestedTypes.map((requestedType) => this.runtime.repository.listCatalogItems({
      userId: context.ownerUserId,
      serviceId: context.serviceId,
      mediaType: "video",
      itemType: requestedType,
      itemIds,
      regionGroup: virtualLibrary?.regionGroup,
      genres,
      search,
      sort,
      limit: 500,
      offset: 0,
      includeFileCounts: false,
    })));
    const combined = results.flatMap((result) => result.items);
    combined.sort((left, right) => this.compareCatalogItems(left, right, sort));
    const records = combined.slice(offset, offset + limit);
    const mapping = await this.loadItemMappingContext(context, records.map((item) => item.id));
    const items = await Promise.all(records.map((item) => this.mapItem(context, item, undefined, mapping)));
    this.runtime.logBusinessEvent("info", {
      日志关键字: "codex-jellyfin-artwork",
      事件: "返回Jellyfin演员关联作品",
      服务ID: context.serviceId,
      演员协议ID: personIds.join(","),
      查询媒体类型: requestedTypes.join(","),
      关联作品总数: combined.length,
      返回作品数量: items.length,
    });
    return { Items: items, TotalRecordCount: combined.length, StartIndex: offset };
  }

  /** 聚合当前电影或节目媒体库的 Jellyfin 分类列表。 */
  public async listGenres(context: JellyfinContext, query: Record<string, unknown>) {
    if (context.aggregateService) {
      const parentId = String(query.ParentId ?? "");
      const virtualLibrary = this.findLibraryDefinition(context, parentId);
      const include = String(query.IncludeItemTypes ?? "").split(",").filter(Boolean);
      const requestedTypes = include.map((type) => type === "Movie" ? "video.movie" : type === "Series" ? "video.series" : "")
        .filter((type) => type.length > 0);
      const effectiveTypes = virtualLibrary
        ? requestedTypes.length === 0 || requestedTypes.includes(virtualLibrary.itemType) ? [virtualLibrary.itemType] : []
        : requestedTypes.length > 0 ? requestedTypes : ["video.movie", "video.series"];
      if (effectiveTypes.length === 0) return { Items: [], TotalRecordCount: 0, StartIndex: 0 };
      const genreQuery = this.runtime.database.query("aggregate_media_items as aggregate_item")
        .join("media_items as primary_item", "primary_item.id", "aggregate_item.primary_member_item_id")
        .select("primary_item.metadata_json")
        .where({ "aggregate_item.aggregate_service_id": context.serviceId, "aggregate_item.status": "active" })
        .whereIn("aggregate_item.item_type", effectiveTypes)
        .whereNull("aggregate_item.deleted_at")
        .whereNull("aggregate_item.parent_aggregate_item_id");
      if (virtualLibrary?.regionGroup) genreQuery.where("primary_item.region_group", virtualLibrary.regionGroup);
      const rows = await genreQuery;
      const counts = new Map<string, number>();
      rows.forEach((row) => {
        const metadata = parseJsonObject(row.metadata_json);
        if (!Array.isArray(metadata.genres)) return;
        [...new Set(metadata.genres.map((genre) => String(genre).trim()).filter(Boolean))]
          .forEach((genre) => counts.set(genre, (counts.get(genre) ?? 0) + 1));
      });
      const searchTerm = String(query.SearchTerm ?? "").trim().toLocaleLowerCase("zh-CN");
      const sortDirection = String(query.SortOrder ?? "Ascending").toLowerCase() === "descending" ? -1 : 1;
      const summaries = [...counts].map(([name, itemCount]) => ({ name, itemCount }))
        .filter((genre) => !searchTerm || genre.name.toLocaleLowerCase("zh-CN").includes(searchTerm))
        .sort((left, right) => left.name.localeCompare(right.name, "zh-CN") * sortDirection);
      return this.paginate(summaries.map((genre) => this.mapGenre(context, genre)), query);
    }
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
    const rowsQuery = this.runtime.database.query("media_items")
      .select("metadata_json").where({ user_id: context.ownerUserId, service_id: context.serviceId, media_type: "video" })
      .whereIn("item_type", effectiveTypes).whereNull("deleted_at");
    if (virtualLibrary?.regionGroup) rowsQuery.where("region_group", virtualLibrary.regionGroup);
    const rows = await rowsQuery;
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
    if (context.aggregateService) {
      const rows = await this.runtime.database.query("aggregate_media_items")
        .select("item_type")
        .count<{ item_type: string; count: string | number }[]>({ count: "id" })
        .where({ aggregate_service_id: context.serviceId, status: "active" })
        .whereIn("item_type", ["video.movie", "video.series", "video.episode"])
        .whereNull("deleted_at")
        .groupBy("item_type");
      const countByType = new Map(rows.map((row) => [String(row.item_type), Number(row.count ?? 0)]));
      return {
        MovieCount: countByType.get("video.movie") ?? 0,
        SeriesCount: countByType.get("video.series") ?? 0,
        EpisodeCount: countByType.get("video.episode") ?? 0,
        AlbumCount: 0,
        SongCount: 0,
      };
    }
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
    if (context.aggregateService) {
      const current = await this.aggregateCatalog.getItem(context.serviceId, context.ownerUserId, decodeAggregateJellyfinItemId(itemId));
      const requestedLimit = Math.min(100, Math.max(1, Number(query.Limit ?? 20)));
      const result = await this.aggregateCatalog.listTopLevel({
        aggregateServiceId: context.serviceId,
        ownerUserId: context.ownerUserId,
        itemTypes: [current.itemType],
        genres: Array.isArray(current.primaryItem.metadata.genres)
          ? current.primaryItem.metadata.genres.map((genre) => String(genre).trim()).filter(Boolean).slice(0, 3)
          : [],
        regionGroup: current.itemType === "video.series" && context.regionLibrariesEnabled
          ? current.primaryItem.regionGroup
          : undefined,
        sort: "updated_desc",
        limit: requestedLimit + 1,
        offset: 0,
      });
      const items = await this.mapAggregateItems(context, result.items.filter((item) => item.aggregateItemId !== current.aggregateItemId).slice(0, requestedLimit));
      return { Items: items, TotalRecordCount: items.length, StartIndex: 0 };
    }
    const internalItemId = decodeProtocolItemId(itemId);
    const current = await this.runtime.repository.getCatalogItem(internalItemId, context.ownerUserId);
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
    if (context.aggregateService) {
      return this.listAggregateSeasons(context, decodeAggregateJellyfinItemId(seriesId));
    }
    const internalSeriesId = decodeProtocolItemId(seriesId);
    const series = await this.runtime.repository.getCatalogItem(internalSeriesId, context.ownerUserId);
    if (series.serviceId !== context.serviceId) throw new ApiError(404, "jellyfin_item_not_found", "媒体条目不存在");
    const children = await this.runtime.repository.listCatalogChildren(internalSeriesId, context.ownerUserId);
    const seasons = [...new Set(children.map((item) => Math.max(0, Number(item.metadata.seasonNumber ?? 0))))].sort((left, right) => left - right);
    const primaryImageTag = series.posterUrl ? String(Date.parse(series.updatedAt) || 1) : "";
    const backdropImageTag = series.backdropUrl ? String(Date.parse(series.updatedAt) || 1) : "";
    const protocolSeriesId = encodeProtocolItemId(series.id);
    const items = seasons.map((number) => ({
      Name: number === 0 ? "特别篇" : `第 ${number} 季`, Id: encodeProtocolSeasonId(series.id, number), ServerId: context.serviceId,
      Type: "Season", IsFolder: true, SeriesId: protocolSeriesId, SeriesName: series.title,
      IndexNumber: number, ParentId: protocolSeriesId,
      ImageTags: primaryImageTag ? { Primary: primaryImageTag } : {},
      PrimaryImageTag: primaryImageTag || undefined, PrimaryImageItemId: primaryImageTag ? protocolSeriesId : undefined,
      SeriesPrimaryImageTag: primaryImageTag || undefined,
      ParentPrimaryImageItemId: primaryImageTag ? protocolSeriesId : undefined, ParentPrimaryImageTag: primaryImageTag || undefined,
      BackdropImageTags: backdropImageTag ? [backdropImageTag] : [],
      ParentBackdropItemId: backdropImageTag ? protocolSeriesId : undefined,
      ParentBackdropImageTags: backdropImageTag ? [backdropImageTag] : [],
      UserData: this.mapUserData(null, 0),
    }));
    this.runtime.logBusinessEvent("info", {
      日志关键字: "codex-jellyfin-compat", 事件: "返回Jellyfin节目季列表", 服务ID: context.serviceId,
      节目ID: internalSeriesId, 季数量: items.length, 单集数量: children.length, 是否有节目封面: Boolean(primaryImageTag),
    });
    return { Items: items, TotalRecordCount: items.length, StartIndex: 0 };
  }

  /** 获取节目单集并按季集排序。 */
  public async listEpisodes(context: JellyfinContext, seriesId: string, query: Record<string, unknown>) {
    if (context.aggregateService) {
      return this.listAggregateEpisodes(context, seriesId, query);
    }
    const pathSeason = this.parseSeasonReference(seriesId);
    const querySeason = this.parseSeasonReference(String(query.SeasonId ?? ""));
    const requestedSeriesId = String(query.SeriesId ?? "").trim() || pathSeason?.seriesId || querySeason?.seriesId || seriesId;
    const actualSeriesId = decodeProtocolItemId(requestedSeriesId);
    const explicitSeasonNumber = Number(query.Season ?? query.SeasonNumber);
    const seasonNumber = pathSeason?.seasonNumber ?? querySeason?.seasonNumber
      ?? (Number.isFinite(explicitSeasonNumber) ? explicitSeasonNumber : null);
    const series = await this.runtime.repository.getCatalogItem(actualSeriesId, context.ownerUserId);
    if (series.serviceId !== context.serviceId) throw new ApiError(404, "jellyfin_item_not_found", "媒体条目不存在");
    const children = (await this.runtime.repository.listCatalogChildren(actualSeriesId, context.ownerUserId))
      .filter((item) => seasonNumber === null || Number(item.metadata.seasonNumber ?? 0) === seasonNumber)
      .sort((left, right) => Number(left.metadata.seasonNumber ?? 0) - Number(right.metadata.seasonNumber ?? 0)
        || Number(left.metadata.episodeNumber ?? 0) - Number(right.metadata.episodeNumber ?? 0));
    // 关键变量：关闭同步刮削详情时，Jellyfin 客户端无法自行访问云助手的实时详情接口，需要在标准单集接口中补全。
    const hydratedChildren = await Promise.all(children.map((item) => hydrateRealtimeVideoDetails(this.runtime, item)));
    const mapping = await this.loadItemMappingContext(context, hydratedChildren.map((item) => item.id));
    const items = await Promise.all(hydratedChildren.map((item) => this.mapItem(context, item, series, mapping)));
    const response = this.paginate(items, query);
    this.runtime.logBusinessEvent("info", {
      日志关键字: "codex-jellyfin-compat", 事件: "返回Jellyfin节目单集列表", 服务ID: context.serviceId,
      节目ID: actualSeriesId, 季编号: seasonNumber ?? "全部", 返回数量: response.Items.length,
      总数量: response.TotalRecordCount,
    });
    return response;
  }

  /** 返回聚合节目单集，父节目与每集均使用稳定聚合条目 ID。 */
  private async listAggregateEpisodes(context: JellyfinContext, seriesId: string, query: Record<string, unknown>) {
    const pathSeason = this.parseSeasonReference(seriesId);
    const querySeason = this.parseSeasonReference(String(query.SeasonId ?? ""));
    const requestedSeriesId = String(query.SeriesId ?? "").trim() || pathSeason?.seriesId || querySeason?.seriesId || seriesId;
    const aggregateSeriesId = decodeAggregateJellyfinItemId(requestedSeriesId);
    const explicitSeasonNumber = Number(query.Season ?? query.SeasonNumber);
    const seasonNumber = pathSeason?.seasonNumber ?? querySeason?.seasonNumber
      ?? (Number.isFinite(explicitSeasonNumber) ? explicitSeasonNumber : null);
    const series = await this.aggregateCatalog.getItem(context.serviceId, context.ownerUserId, aggregateSeriesId);
    if (series.itemType !== "video.series") throw new ApiError(404, "aggregate_jellyfin_series_not_found", "聚合节目不存在");
    const episodes = (await this.aggregateCatalog.listEpisodes(context.serviceId, context.ownerUserId, aggregateSeriesId))
      .filter((item) => seasonNumber === null || Number(item.primaryItem.metadata.seasonNumber ?? 0) === seasonNumber);
    const items = await this.mapAggregateItems(
      context,
      episodes,
      new Map(episodes.map((item) => [item.aggregateItemId, series])),
    );
    const response = this.paginate(items, query);
    this.runtime.logBusinessEvent("info", {
      日志关键字: "codex-aggregate-jellyfin",
      事件: "返回聚合Jellyfin节目单集列表",
      聚合服务ID: context.serviceId,
      节目ID: aggregateSeriesId,
      季编号: seasonNumber ?? "全部",
      返回数量: response.Items.length,
      总数量: response.TotalRecordCount,
    });
    return response;
  }

  /** 为普通条目、虚拟媒体库和虚拟季解析实际承载图片的媒体条目。 */
  public async resolveImageItem(context: JellyfinLibraryContext, itemId: string, imageType: string): Promise<MediaItemRecord> {
    if (context.aggregateService) {
      const library = this.findLibraryDefinition(context, itemId);
      if (library) {
        const result = await this.aggregateCatalog.listTopLevel({
          aggregateServiceId: context.serviceId,
          ownerUserId: context.ownerUserId,
          itemTypes: [library.itemType],
          regionGroup: library.regionGroup,
          sort: "updated_desc",
          limit: 60,
          offset: 0,
        });
        const cover = result.items.find((item) => Boolean(readJellyfinImageUrl(item.primaryItem, imageType)))
          ?? result.items.find((item) => Boolean(item.primaryItem.posterUrl || item.primaryItem.backdropUrl));
        if (!cover) throw new ApiError(404, "jellyfin_image_not_found", "聚合媒体库没有可用封面");
        return cover.primaryItem;
      }
      const season = this.parseSeasonReference(itemId);
      const aggregateItemId = season?.seriesId ?? decodeAggregateJellyfinItemId(itemId);
      const aggregateItem = await this.aggregateCatalog.getItem(context.serviceId, context.ownerUserId, aggregateItemId);
      const imageUrl = readJellyfinImageUrl(aggregateItem.primaryItem, imageType);
      if (imageUrl || aggregateItem.itemType !== "video.episode" || !aggregateItem.parentAggregateItemId) {
        return aggregateItem.primaryItem;
      }
      const parent = await this.aggregateCatalog.getItem(
        context.serviceId,
        context.ownerUserId,
        aggregateItem.parentAggregateItemId,
      );
      return readJellyfinImageUrl(parent.primaryItem, imageType) ? parent.primaryItem : aggregateItem.primaryItem;
    }
    const library = this.findLibraryDefinition(context, itemId);
    if (library) {
      const result = await this.runtime.repository.listCatalogItems({
        userId: context.ownerUserId, serviceId: context.serviceId, mediaType: "video", itemType: library.itemType,
        regionGroup: library.regionGroup,
        sort: "updated_desc", limit: 60, offset: 0, includeFileCounts: false,
      });
      const coverItem = result.items.find((item) => Boolean(readJellyfinImageUrl(item, imageType)))
        ?? result.items.find((item) => Boolean(item.posterUrl || item.backdropUrl));
      if (!coverItem) throw new ApiError(404, "jellyfin_image_not_found", "媒体库没有可用封面");
      this.runtime.logBusinessEvent("info", {
        日志关键字: "codex-jellyfin-compat", 事件: "解析Jellyfin图片来源", 服务ID: context.serviceId,
        请求条目ID: itemId, 实际条目ID: coverItem.id, 图片类型: imageType,
      });
      return coverItem;
    }
    const season = this.parseSeasonReference(itemId);
    const resolvedItemId = season?.seriesId ?? decodeProtocolItemId(itemId);
    const item = await this.runtime.repository.getCatalogItem(resolvedItemId, context.ownerUserId);
    if (item.serviceId !== context.serviceId) throw new ApiError(404, "jellyfin_image_not_found", "图片不存在");
    if (resolvedItemId !== itemId) {
      this.runtime.logBusinessEvent("info", {
        日志关键字: "codex-jellyfin-compat", 事件: "解析Jellyfin图片来源", 服务ID: context.serviceId,
        请求条目ID: itemId, 实际条目ID: resolvedItemId, 图片类型: imageType,
      });
    }
    const requestedImageUrl = readJellyfinImageUrl(item, imageType);
    if (requestedImageUrl || item.itemType !== "video.episode") return item;
    // 单集 DTO 可以继承节目海报和背景图；图片请求使用单集 ID 时同样要回退到所属节目。
    const relation = await this.runtime.database.query("media_relations")
      .where({ library_id: context.libraryId, child_item_id: item.id }).first();
    if (!relation) return item;
    const parent = await this.runtime.repository.getCatalogItem(String(relation.parent_item_id), context.ownerUserId);
    const parentImageUrl = readJellyfinImageUrl(parent, imageType);
    if (parent.serviceId !== context.serviceId || !parentImageUrl) return item;
    return parent;
  }

  /** 解析标准图片接口的媒体图片或演员头像来源。 */
  public async resolveImageSource(
    context: JellyfinLibraryContext,
    itemId: string,
    imageType: string,
  ): Promise<JellyfinImageSource> {
    const normalizedType = imageType.trim().toLowerCase();
    // 聚合上下文中的电影和 Person 均为 UUID，先尝试演员头像，再回退为媒体图片。
    if (normalizedType === "primary" && (context.aggregateService || this.isPotentialPersonId(context, itemId))) {
      const personImage = await this.resolvePersonImageSource(context, itemId);
      if (personImage) {
        this.logArtworkResolution(context, itemId, imageType, "演员头像");
        return personImage;
      }
    }
    const item = await this.resolveImageItem(context, itemId, imageType);
    const imageUrl = readJellyfinImageUrl(item, imageType);
    if (!imageUrl) throw new ApiError(404, "jellyfin_image_not_found", "图片不存在");
    const imageTag = normalizedType === "logo"
      ? createJellyfinImageTag(imageUrl)
      : String(Date.parse(item.updatedAt) || 1);
    this.logArtworkResolution(context, itemId, imageType, normalizedType === "logo" ? "标题Logo" : "媒体图片");
    return { url: imageUrl, imageTag, updatedAt: item.updatedAt, sourceType: "media" };
  }

  /** 判断协议 ID 是否可能指向不可逆编码的演员实体。 */
  private isPotentialPersonId(context: JellyfinLibraryContext, itemId: string): boolean {
    const compactItemId = itemId.trim().toLowerCase().replace(/-/gu, "");
    // 聚合媒体条目使用原始 32 位索引摘要编码为 UUID，不带普通 itm_ 前缀，不能误判为演员。
    if (context.aggregateService && UUID_PATTERN.test(itemId)) return false;
    return !INTERNAL_ITEM_ID_PATTERN.test(itemId)
      && !compactItemId.startsWith(JELLYFIN_ITEM_UUID_PREFIX)
      && !this.parseSeasonReference(itemId)
      && !this.findLibraryDefinition(context, itemId);
  }

  /** 按媒体库版本建立演员实体、头像和关联作品索引。 */
  private async loadPersonCache(context: JellyfinLibraryContext): Promise<JellyfinPersonCache> {
    if (context.aggregateService) return this.loadAggregatePersonCache(context);
    const library = await this.runtime.database.query("media_libraries")
      .select("catalog_version")
      .where({ id: context.libraryId, service_id: context.serviceId })
      .first();
    const catalogVersion = Number(library?.catalog_version ?? 0);
    const cacheKey = `${context.ownerUserId}:${context.libraryId}`;
    let cache = this.personCaches.get(cacheKey);
    if (cache && cache.catalogVersion === catalogVersion) return cache;
    // 关键变量：只读取顶层影视条目，单集会重复节目演职人员且不应扩大索引扫描量。
    const rows = await this.runtime.database.query("media_items")
      .select("id", "metadata_json", "updated_at")
      .where({
        user_id: context.ownerUserId,
        service_id: context.serviceId,
        library_id: context.libraryId,
        media_type: "video",
      })
      .whereIn("item_type", ["video.movie", "video.series"])
      .whereNull("deleted_at")
      .orderBy("updated_at", "desc");
    const peopleById = new Map<string, JellyfinPersonSummary>();
    for (const row of rows) {
      const metadata = parseJsonObject(row.metadata_json);
      const people = Array.isArray(metadata.people) ? metadata.people : [];
      for (const person of people) {
        const personRecord = person as Record<string, unknown>;
        const personName = String(personRecord.name ?? "").trim();
        const personSourceId = String(personRecord.id ?? "").trim();
        const profileUrl = String(personRecord.profileUrl ?? "").trim();
        if (!personName) continue;
        const protocolPersonId = createProtocolUuid(
          "person",
          personSourceId ? `source:${personSourceId}` : `name:${personName}`,
        );
        const existing = peopleById.get(protocolPersonId);
        if (existing) {
          existing.itemIds.add(String(row.id));
          if (!existing.profileUrl && /^https?:\/\//iu.test(profileUrl)) {
            existing.profileUrl = profileUrl;
            existing.imageTag = createJellyfinImageTag(profileUrl);
            existing.updatedAt = String(row.updated_at);
          }
          continue;
        }
        const validProfileUrl = /^https?:\/\//iu.test(profileUrl) ? profileUrl : "";
        peopleById.set(protocolPersonId, {
          id: protocolPersonId,
          name: personName,
          sourceId: personSourceId,
          profileUrl: validProfileUrl,
          imageTag: validProfileUrl ? createJellyfinImageTag(validProfileUrl) : "",
          updatedAt: String(row.updated_at),
          itemIds: new Set([String(row.id)]),
        });
      }
    }
    cache = { catalogVersion, peopleById };
    this.personCaches.set(cacheKey, cache);
    return cache;
  }

  /**
   * 建立聚合 Jellyfin 的演员索引。
   * 关键变量：itemIds 存聚合条目 ID，避免用户点击演员后跳回任一来源服务的同名影片。
   */
  private async loadAggregatePersonCache(context: JellyfinLibraryContext): Promise<JellyfinPersonCache> {
    const aggregateService = await this.runtime.database.query("aggregate_services")
      .select("catalog_version")
      .where({ id: context.serviceId, protocol: "jellyfin" })
      .whereNull("deleted_at")
      .first();
    const catalogVersion = Number(aggregateService?.catalog_version ?? 0);
    const cacheKey = `${context.ownerUserId}:aggregate:${context.serviceId}`;
    let cache = this.personCaches.get(cacheKey);
    if (cache && cache.catalogVersion === catalogVersion) return cache;
    const rows = await this.runtime.database.query("aggregate_media_items as aggregate_item")
      .join("media_items as primary_item", "primary_item.id", "aggregate_item.primary_member_item_id")
      .select("aggregate_item.id as aggregate_item_id", "primary_item.metadata_json", "aggregate_item.updated_at")
      .where({ "aggregate_item.aggregate_service_id": context.serviceId, "aggregate_item.status": "active" })
      .whereIn("aggregate_item.item_type", ["video.movie", "video.series"])
      .whereNull("aggregate_item.deleted_at")
      .whereNull("aggregate_item.parent_aggregate_item_id")
      .orderBy("aggregate_item.updated_at", "desc");
    const peopleById = new Map<string, JellyfinPersonSummary>();
    rows.forEach((row) => {
      const metadata = parseJsonObject(row.metadata_json);
      const people = Array.isArray(metadata.people) ? metadata.people : [];
      people.forEach((person) => {
        const personRecord = person as Record<string, unknown>;
        const personName = String(personRecord.name ?? "").trim();
        const personSourceId = String(personRecord.id ?? "").trim();
        if (!personName) return;
        const profileUrl = String(personRecord.profileUrl ?? "").trim();
        const protocolPersonId = createProtocolUuid(
          "person",
          personSourceId ? `source:${personSourceId}` : `name:${personName}`,
        );
        const existing = peopleById.get(protocolPersonId);
        if (existing) {
          existing.itemIds.add(String(row.aggregate_item_id));
          if (!existing.profileUrl && /^https?:\/\//iu.test(profileUrl)) {
            existing.profileUrl = profileUrl;
            existing.imageTag = createJellyfinImageTag(profileUrl);
            existing.updatedAt = String(row.updated_at);
          }
          return;
        }
        const validProfileUrl = /^https?:\/\//iu.test(profileUrl) ? profileUrl : "";
        peopleById.set(protocolPersonId, {
          id: protocolPersonId,
          name: personName,
          sourceId: personSourceId,
          profileUrl: validProfileUrl,
          imageTag: validProfileUrl ? createJellyfinImageTag(validProfileUrl) : "",
          updatedAt: String(row.updated_at),
          itemIds: new Set([String(row.aggregate_item_id)]),
        });
      });
    });
    cache = { catalogVersion, peopleById };
    this.personCaches.set(cacheKey, cache);
    return cache;
  }

  /** 返回标准 Jellyfin Person DTO；非演员协议 ID 返回空。 */
  public async getPersonItem(context: JellyfinContext, personId: string) {
    // 聚合媒体和 Person 都是 UUID；聚合上下文需先查演员缓存，再由调用方回退媒体详情。
    if (!context.aggregateService && !this.isPotentialPersonId(context, personId)) return null;
    const cache = await this.loadPersonCache(context);
    const person = cache.peopleById.get(personId.trim().toLowerCase());
    if (!person) return null;
    const favorite = await this.isVirtualItemFavorite(context, person.id);
    const item = {
      Name: person.name,
      ServerId: context.serviceId,
      Id: person.id,
      Etag: person.imageTag || String(Date.parse(person.updatedAt) || 1),
      DateCreated: toJellyfinDateTime(person.updatedAt),
      SortName: person.name,
      Type: "Person",
      IsFolder: false,
      LocationType: "FileSystem",
      Overview: "",
      ProductionLocations: [],
      ProviderIds: person.sourceId ? { Tmdb: person.sourceId } : {},
      ImageTags: person.imageTag ? { Primary: person.imageTag } : {},
      PrimaryImageTag: person.imageTag || undefined,
      PrimaryImageAspectRatio: person.profileUrl ? 2 / 3 : undefined,
      UserData: this.mapUserData(null, 0, favorite, person.id),
    };
    this.runtime.logBusinessEvent("info", {
      日志关键字: "codex-jellyfin-artwork",
      事件: "返回Jellyfin演员详情",
      服务ID: context.serviceId,
      演员协议ID: person.id,
      演员名称: person.name,
      是否包含头像: Boolean(person.profileUrl),
      关联作品数量: person.itemIds.size,
    });
    return item;
  }

  /** 返回 Jellyfin 标准演员列表。 */
  public async listPersons(context: JellyfinContext, query: Record<string, unknown>) {
    const cache = await this.loadPersonCache(context);
    const searchTerm = String(query.SearchTerm ?? "").trim().toLocaleLowerCase("zh-CN");
    const descending = String(query.SortOrder ?? "Ascending").toLowerCase() === "descending";
    const people = [...cache.peopleById.values()]
      .filter((person) => !searchTerm || person.name.toLocaleLowerCase("zh-CN").includes(searchTerm))
      .sort((left, right) => left.name.localeCompare(right.name, "zh-CN") * (descending ? -1 : 1));
    const offset = Math.max(0, Number(query.StartIndex ?? 0));
    const limit = Math.min(500, Math.max(1, Number(query.Limit ?? 100)));
    const selectedPeople = people.slice(offset, offset + limit);
    const items = await Promise.all(selectedPeople.map((person) => this.getPersonItem(context, person.id)));
    return { Items: items.filter(Boolean), TotalRecordCount: people.length, StartIndex: offset };
  }

  /** 按演员名称读取标准 Jellyfin Person DTO。 */
  public async getPersonByName(context: JellyfinContext, personName: string) {
    const cache = await this.loadPersonCache(context);
    const requestedName = personName.trim().toLocaleLowerCase("zh-CN");
    const person = [...cache.peopleById.values()].find(
      (candidate) => candidate.name.toLocaleLowerCase("zh-CN") === requestedName,
    );
    return person ? this.getPersonItem(context, person.id) : null;
  }

  /** 从演员实体索引读取头像地址。 */
  private async resolvePersonImageSource(
    context: JellyfinLibraryContext,
    personId: string,
  ): Promise<JellyfinImageSource | null> {
    const cache = await this.loadPersonCache(context);
    const person = cache.peopleById.get(personId.trim().toLowerCase());
    if (!person?.profileUrl) return null;
    return {
      url: person.profileUrl,
      imageTag: person.imageTag,
      updatedAt: person.updatedAt,
      sourceType: "person",
    };
  }

  /** 记录 Jellyfin 图片协议解析结果，便于区分 DTO 缺字段和图片代理失败。 */
  private logArtworkResolution(
    context: JellyfinLibraryContext,
    itemId: string,
    imageType: string,
    sourceName: string,
  ): void {
    this.runtime.logBusinessEvent("info", {
      日志关键字: "codex-jellyfin-artwork",
      事件: "解析Jellyfin图片来源",
      服务ID: context.serviceId,
      请求条目ID: itemId,
      图片类型: imageType,
      图片来源: sourceName,
    });
  }

  /** 读取聚合条目的 Jellyfin 用户状态。 */
  private async getAggregateUserData(context: JellyfinContext, protocolItemId: string) {
    const aggregateItem = await this.aggregateCatalog.getItem(
      context.serviceId,
      context.ownerUserId,
      decodeAggregateJellyfinItemId(protocolItemId),
    );
    const [progress, preference, runTimeTicks] = await Promise.all([
      this.readAggregateProgress(context, aggregateItem.aggregateItemId),
      this.runtime.database.query("aggregate_item_preferences")
        .select("id")
        .where({ aggregate_service_id: context.serviceId, account_id: context.accountId, aggregate_item_id: aggregateItem.aggregateItemId })
        .whereNotNull("starred_at")
        .first(),
      this.readAggregateItemRunTimeTicks(context, aggregateItem),
    ]);
    return this.mapUserData(
      progress ? { ...progress, item_id: aggregateItem.aggregateItemId } : null,
      runTimeTicks,
      Boolean(preference),
      encodeAggregateJellyfinItemId(aggregateItem.aggregateItemId),
    );
  }

  /** 写入聚合条目的已观看状态，数据只归属当前聚合服务账号。 */
  private async setAggregatePlayed(context: JellyfinContext, protocolItemId: string, played: boolean) {
    const aggregateItem = await this.aggregateCatalog.getItem(
      context.serviceId,
      context.ownerUserId,
      decodeAggregateJellyfinItemId(protocolItemId),
    );
    const now = new Date().toISOString();
    const episodeIds = aggregateItem.itemType === "video.series"
      ? (await this.aggregateCatalog.listEpisodes(context.serviceId, context.ownerUserId, aggregateItem.aggregateItemId))
        .map((episode) => episode.aggregateItemId)
      : [];
    // 关键变量：父节目自身也保留观看状态，全部单集用于标准 Jellyfin 的递归标记语义。
    const targetItemIds = [...new Set([aggregateItem.aggregateItemId, ...episodeIds])];
    await this.runtime.database.query.transaction(async (transaction) => {
      const existingRows: Array<Record<string, unknown>> = [];
      for (let offset = 0; offset < targetItemIds.length; offset += JELLYFIN_USER_STATE_BATCH_SIZE) {
        existingRows.push(...await transaction("aggregate_playback_progress")
          .where({ aggregate_service_id: context.serviceId, account_id: context.accountId })
          .whereIn("aggregate_item_id", targetItemIds.slice(offset, offset + JELLYFIN_USER_STATE_BATCH_SIZE)));
      }
      const existingByItemId = new Map(existingRows.map((row) => [String(row.aggregate_item_id), row]));
      const rows = targetItemIds.map((aggregateItemId) => {
        const existing = existingByItemId.get(aggregateItemId);
        return {
          id: String(existing?.id ?? randomUUID()),
          aggregate_service_id: context.serviceId,
          account_id: context.accountId,
          aggregate_item_id: aggregateItemId,
          media_source_id: existing?.media_source_id ?? null,
          played: played ? 1 : 0,
          position_ticks: 0,
          hidden_from_resume: played ? 1 : 0,
          play_count: played ? Math.max(1, Number(existing?.play_count ?? 0)) : 0,
          updated_at: now,
          last_played_at: played ? now : null,
        };
      });
      for (let offset = 0; offset < rows.length; offset += JELLYFIN_USER_STATE_BATCH_SIZE) {
        await transaction("aggregate_playback_progress")
          .insert(rows.slice(offset, offset + JELLYFIN_USER_STATE_BATCH_SIZE))
          .onConflict(["aggregate_service_id", "account_id", "aggregate_item_id"])
          .merge(["played", "position_ticks", "hidden_from_resume", "play_count", "last_played_at", "updated_at"]);
      }
    });
    this.runtime.logBusinessEvent("info", {
      日志关键字: "codex-jellyfin-user-state",
      事件: "级联更新聚合Jellyfin观看状态",
      聚合服务ID: context.serviceId,
      账号ID: context.accountId,
      聚合条目ID: aggregateItem.aggregateItemId,
      媒体类型: aggregateItem.itemType,
      是否已观看: played,
      级联单集数量: episodeIds.length,
      清零进度条目数量: targetItemIds.length,
    });
    return this.getAggregateUserData(context, protocolItemId);
  }

  /** 写入聚合条目的收藏状态，不会影响来源服务各自的 Jellyfin 收藏。 */
  private async setAggregateFavorite(context: JellyfinContext, protocolItemId: string, favorite: boolean) {
    const aggregateItem = await this.aggregateCatalog.getItem(
      context.serviceId,
      context.ownerUserId,
      decodeAggregateJellyfinItemId(protocolItemId),
    );
    const now = new Date().toISOString();
    const existing = await this.runtime.database.query("aggregate_item_preferences")
      .where({ aggregate_service_id: context.serviceId, account_id: context.accountId, aggregate_item_id: aggregateItem.aggregateItemId })
      .first();
    if (favorite && existing) await this.runtime.database.query("aggregate_item_preferences").where({ id: existing.id }).update({ starred_at: now, updated_at: now });
    else if (favorite) await this.runtime.database.query("aggregate_item_preferences").insert({
      id: randomUUID(),
      aggregate_service_id: context.serviceId,
      account_id: context.accountId,
      aggregate_item_id: aggregateItem.aggregateItemId,
      starred_at: now,
      rating: 0,
      updated_at: now,
    });
    else if (existing && Number(existing.rating ?? 0) === 0) await this.runtime.database.query("aggregate_item_preferences").where({ id: existing.id }).delete();
    else if (existing) await this.runtime.database.query("aggregate_item_preferences").where({ id: existing.id }).update({ starred_at: null, updated_at: now });
    return this.getAggregateUserData(context, protocolItemId);
  }

  /** 更新聚合播放进度，并在达到 90% 时写入已观看状态。 */
  private async reportAggregatePlayback(context: JellyfinContext, kind: "playing" | "progress" | "stopped", body: Record<string, unknown>): Promise<void> {
    const protocolItemId = String(body.ItemId ?? "");
    if (!protocolItemId) throw new ApiError(422, "playback_item_required", "播放条目 ID 不能为空");
    const aggregateItem = await this.aggregateCatalog.getItem(context.serviceId, context.ownerUserId, decodeAggregateJellyfinItemId(protocolItemId));
    const mediaSourceId = body.MediaSourceId
      ? this.toContextInternalMediaSourceId(context, protocolItemId, String(body.MediaSourceId))
      : null;
    const positionTicks = Math.max(0, Math.floor(Number(body.PositionTicks ?? 0)));
    const durationTicks = await this.readAggregateItemRunTimeTicks(context, aggregateItem, mediaSourceId ?? undefined);
    const completed = durationTicks > 0 && positionTicks * 100 / durationTicks >= 90;
    const playSessionId = String(body.PlaySessionId ?? "") || randomUUID();
    const now = new Date().toISOString();
    await this.runtime.database.query.transaction(async (transaction) => {
      const session = await transaction("aggregate_playback_sessions")
        .where({ id: playSessionId, aggregate_service_id: context.serviceId, account_id: context.accountId }).first();
      const progress = await transaction("aggregate_playback_progress")
        .where({ aggregate_service_id: context.serviceId, account_id: context.accountId, aggregate_item_id: aggregateItem.aggregateItemId }).first();
      const history = kind === "stopped"
        ? await transaction("aggregate_playback_history").where({ play_session_id: playSessionId }).first()
        : null;
      const sessionPatch = { aggregate_item_id: aggregateItem.aggregateItemId, media_source_id: mediaSourceId, status: kind === "stopped" ? "stopped" : "playing", position_ticks: positionTicks, paused: body.IsPaused ? 1 : 0, updated_at: now, stopped_at: kind === "stopped" ? now : null };
      if (session) await transaction("aggregate_playback_sessions").where({ id: playSessionId }).update(sessionPatch);
      else await transaction("aggregate_playback_sessions").insert({ id: playSessionId, aggregate_service_id: context.serviceId, account_id: context.accountId, ...sessionPatch, started_at: now });
      const progressPatch = { media_source_id: mediaSourceId, position_ticks: completed ? 0 : positionTicks, played: completed ? 1 : 0, hidden_from_resume: completed ? 1 : 0, play_count: completed ? Math.max(1, Number(progress?.play_count ?? 0)) : Number(progress?.play_count ?? 0), last_played_at: kind === "stopped" ? now : progress?.last_played_at ?? null, updated_at: now };
      if (progress) await transaction("aggregate_playback_progress").where({ id: progress.id }).update(progressPatch);
      else await transaction("aggregate_playback_progress").insert({ id: randomUUID(), aggregate_service_id: context.serviceId, account_id: context.accountId, aggregate_item_id: aggregateItem.aggregateItemId, ...progressPatch });
      if (kind === "stopped" && !history) await transaction("aggregate_playback_history").insert({ id: randomUUID(), aggregate_service_id: context.serviceId, account_id: context.accountId, aggregate_item_id: aggregateItem.aggregateItemId, play_session_id: playSessionId, position_ticks: positionTicks, completed: completed ? 1 : 0, started_at: session?.started_at ?? now, stopped_at: now });
    });
    this.runtime.logBusinessEvent("info", {
      日志关键字: "codex-aggregate-jellyfin",
      事件: "保存聚合Jellyfin播放进度",
      聚合服务ID: context.serviceId,
      账号ID: context.accountId,
      聚合条目ID: aggregateItem.aggregateItemId,
      上报类型: kind,
      已观看Ticks: positionTicks,
      总时长Ticks: durationTicks,
      是否已完成: completed,
    });
  }

  /** 查询继续观看条目。 */
  public async listResume(context: JellyfinContext, query: Record<string, unknown>) {
    if (context.aggregateService) return this.listAggregateResume(context, query);
    const rows = await this.runtime.database.query("service_playback_progress as p")
      .join("media_items as m", "m.id", "p.item_id")
      .join("file_links as fl", "fl.item_id", "m.id")
      .join("source_files as f", "f.id", "fl.source_file_id")
      .distinct("m.id", "p.updated_at").where({ "p.service_id": context.serviceId, "p.account_id": context.accountId, "p.played": 0, "p.hidden_from_resume": 0, "f.status": "active" })
      // 关键变量：低于 60 秒的试播不进入继续观看，避免首页堆积误触记录。
      .where("p.position_ticks", ">=", 600_000_000).whereNull("m.deleted_at").orderBy("p.updated_at", "desc").limit(500);
    const rawRecords = await Promise.all(rows.map(async (row) => {
      const item = await this.runtime.repository.getCatalogItem(String(row.id), context.ownerUserId);
      const parent = item.itemType === "video.episode" ? await this.findParent(item.id, context.ownerUserId) : undefined;
      return { item, parent };
    }));
    const seenResumeGroups = new Set<string>();
    // 关键变量：单集按父节目聚合，排序后只保留最近播放的一集作为续播入口。
    const records = rawRecords.filter((record) => {
      const groupId = record.item.itemType === "video.episode" && record.parent
        ? `series:${record.parent.id}`
        : `item:${record.item.id}`;
      if (seenResumeGroups.has(groupId)) return false;
      seenResumeGroups.add(groupId);
      return true;
    });
    const mapping = await this.loadItemMappingContext(context, records.map((record) => record.item.id));
    const items = await Promise.all(records.map((record) => this.mapItem(context, record.item, record.parent, mapping)));
    const progressItems = items.filter((item) => Number(item.UserData?.PlaybackPositionTicks ?? 0) > 0);
    const percentageItems = progressItems.filter((item) => Number(item.UserData?.PlayedPercentage ?? 0) > 0);
    this.runtime.logBusinessEvent("info", {
      日志关键字: "codex-jellyfin-playback-progress",
      事件: "返回Jellyfin继续观看进度",
      服务ID: context.serviceId,
      账号ID: context.accountId,
      聚合前记录数量: rawRecords.length,
      继续观看数量: items.length,
      包含已观看时间数量: progressItems.length,
      包含进度百分比数量: percentageItems.length,
    });
    return this.paginate(items, query);
  }

  /** 查询去重后的最近播放记录。 */
  public async listHistory(context: JellyfinContext, query: Record<string, unknown>) {
    if (context.aggregateService) return this.listAggregateHistory(context, query);
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
    if (context.aggregateService) return this.getAggregateUserData(context, itemId);
    if (this.isPotentialPersonId(context, itemId)) {
      const personCache = await this.loadPersonCache(context);
      const protocolPersonId = itemId.trim().toLowerCase();
      if (personCache.peopleById.has(protocolPersonId)) {
        return this.mapUserData(null, 0, await this.isVirtualItemFavorite(context, protocolPersonId), protocolPersonId);
      }
    }
    const internalItemId = decodeProtocolItemId(itemId);
    const item = await this.runtime.repository.getCatalogItem(internalItemId, context.ownerUserId);
    if (item.serviceId !== context.serviceId) throw new ApiError(404, "jellyfin_item_not_found", "媒体条目不存在");
    const progress = await this.readProgress(context, internalItemId);
    const runTimeTicks = await this.readItemRunTimeTicks(item);
    return this.mapUserData(progress, runTimeTicks, await this.isMediaItemFavorite(context, internalItemId), encodeProtocolItemId(internalItemId));
  }

  /** 接收 Jellyfin 用户数据更新，同步处理续播、已观看和收藏状态。 */
  public async updateUserData(context: JellyfinContext, itemId: string, body: Record<string, unknown>) {
    if (context.aggregateService) {
      if (Object.prototype.hasOwnProperty.call(body, "PlaybackPositionTicks")) {
        await this.reportAggregatePlayback(context, "progress", {
          ItemId: itemId,
          PositionTicks: Math.max(0, Math.floor(Number(body.PlaybackPositionTicks ?? 0))),
          MediaSourceId: body.MediaSourceId,
        });
      }
      if (typeof body.Played === "boolean") await this.setAggregatePlayed(context, itemId, body.Played);
      if (typeof body.IsFavorite === "boolean") await this.setAggregateFavorite(context, itemId, body.IsFavorite);
      return this.getAggregateUserData(context, itemId);
    }
    const internalItemId = decodeProtocolItemId(itemId);
    const item = await this.runtime.repository.getCatalogItem(internalItemId, context.ownerUserId);
    if (item.serviceId !== context.serviceId) throw new ApiError(404, "jellyfin_item_not_found", "媒体条目不存在");
    if (Object.prototype.hasOwnProperty.call(body, "PlaybackPositionTicks")) {
      const positionTicks = Math.max(0, Math.floor(Number(body.PlaybackPositionTicks ?? 0)));
      const now = new Date().toISOString();
      const existing = await this.runtime.database.query("service_playback_progress")
        .where({ service_id: context.serviceId, account_id: context.accountId, item_id: internalItemId }).first();
      const patch = {
        position_ticks: positionTicks,
        played: 0,
        hidden_from_resume: 0,
        updated_at: now,
      };
      if (existing) await this.runtime.database.query("service_playback_progress").where({ id: existing.id }).update(patch);
      else await this.runtime.database.query("service_playback_progress").insert({
        id: randomUUID(), service_id: context.serviceId, account_id: context.accountId, item_id: internalItemId,
        media_source_id: null, play_count: 0, last_played_at: null, ...patch,
      });
    }
    if (typeof body.Played === "boolean") await this.setPlayed(context, itemId, body.Played);
    if (typeof body.IsFavorite === "boolean") await this.setFavorite(context, itemId, body.IsFavorite);
    return this.getUserData(context, itemId);
  }

  /** 查询指定节目的下一集。 */
  public async listNextUp(context: JellyfinContext, query: Record<string, unknown>) {
    if (context.aggregateService) {
      const requestedSeriesId = String(query.SeriesId ?? "");
      if (!requestedSeriesId) return { Items: [], TotalRecordCount: 0, StartIndex: 0 };
      const series = await this.aggregateCatalog.getItem(context.serviceId, context.ownerUserId, decodeAggregateJellyfinItemId(requestedSeriesId));
      const episodes = await this.aggregateCatalog.listEpisodes(context.serviceId, context.ownerUserId, series.aggregateItemId);
      const progressRows = episodes.length === 0 ? [] : await this.runtime.database.query("aggregate_playback_progress")
        .where({ aggregate_service_id: context.serviceId, account_id: context.accountId })
        .whereIn("aggregate_item_id", episodes.map((item) => item.aggregateItemId));
      const progressByItemId = new Map(progressRows.map((row) => [String(row.aggregate_item_id), row]));
      const next = episodes.find((item) => Number(progressByItemId.get(item.aggregateItemId)?.played ?? 0) !== 1);
      const items = next ? await this.mapAggregateItems(context, [next], new Map([[next.aggregateItemId, series]])) : [];
      return { Items: items, TotalRecordCount: items.length, StartIndex: 0 };
    }
    const requestedSeriesId = String(query.SeriesId ?? "");
    if (!requestedSeriesId) return { Items: [], TotalRecordCount: 0, StartIndex: 0 };
    const seriesId = decodeProtocolItemId(requestedSeriesId);
    const series = await this.runtime.repository.getCatalogItem(seriesId, context.ownerUserId);
    if (series.serviceId !== context.serviceId) throw new ApiError(404, "jellyfin_item_not_found", "媒体条目不存在");
    const children = (await this.runtime.repository.listCatalogChildren(seriesId, context.ownerUserId))
      .sort((left, right) => Number(left.metadata.seasonNumber ?? 0) - Number(right.metadata.seasonNumber ?? 0)
        || Number(left.metadata.episodeNumber ?? 0) - Number(right.metadata.episodeNumber ?? 0));
    const progressRows = await this.runtime.database.query("service_playback_progress")
      .where({ service_id: context.serviceId, account_id: context.accountId }).whereIn("item_id", children.map((item) => item.id));
    const progressById = new Map(progressRows.map((row) => [String(row.item_id), row]));
    const next = children.find((item) => Number(progressById.get(item.id)?.played ?? 0) !== 1);
    const hydratedNext = next ? await hydrateRealtimeVideoDetails(this.runtime, next) : undefined;
    const items = hydratedNext ? [await this.mapItem(context, hydratedNext, series)] : [];
    return { Items: items, TotalRecordCount: items.length, StartIndex: 0 };
  }

  /** 写入 Playing、Progress 或 Stopped 事件，保证停止事件幂等。 */
  public async reportPlayback(context: JellyfinContext, kind: "playing" | "progress" | "stopped", body: Record<string, unknown>): Promise<void> {
    if (context.aggregateService) return this.reportAggregatePlayback(context, kind, body);
    const protocolItemId = String(body.ItemId ?? "");
    if (!protocolItemId) throw new ApiError(422, "playback_item_required", "播放条目 ID 不能为空");
    const itemId = decodeProtocolItemId(protocolItemId);
    const mediaSourceId = body.MediaSourceId
      ? this.toInternalMediaSourceId(itemId, String(body.MediaSourceId))
      : undefined;
    const item = await this.runtime.repository.getCatalogItem(itemId, context.ownerUserId);
    if (item.serviceId !== context.serviceId) throw new ApiError(404, "jellyfin_item_not_found", "媒体条目不存在");
    const playSessionId = String(body.PlaySessionId ?? "") || randomUUID();
    const positionTicks = Math.max(0, Math.floor(Number(body.PositionTicks ?? 0)));
    // 关键变量：播放进度只与服务端媒体库中的总时长计算，不接受非标准的客户端总时长字段。
    const durationTicks = await this.readItemRunTimeTicks(
      item,
      mediaSourceId,
    );
    const progressPercentage = durationTicks > 0
      ? Math.min(100, positionTicks * 100 / durationTicks)
      : 0;
    // 关键变量：任意播放进度上报达到 90% 即完成，不等待 Stopped 事件。
    const completed = durationTicks > 0 && progressPercentage >= 90;
    const now = new Date().toISOString();
    let automaticallyMarkedPlayed = false;
    await this.runtime.database.query.transaction(async (transaction) => {
      const existing = await transaction("service_playback_sessions").where({ id: playSessionId, service_id: context.serviceId, account_id: context.accountId }).first();
      const existingHistory = kind === "stopped"
        ? await transaction("service_playback_history").where({ play_session_id: playSessionId }).first()
        : null;
      const sessionPatch = { item_id: itemId, media_source_id: mediaSourceId ?? null, status: kind === "stopped" ? "stopped" : "playing", position_ticks: positionTicks, paused: body.IsPaused ? 1 : 0, updated_at: now, stopped_at: kind === "stopped" ? now : null };
      if (existing) await transaction("service_playback_sessions").where({ id: playSessionId }).update(sessionPatch);
      else await transaction("service_playback_sessions").insert({ id: playSessionId, service_id: context.serviceId, account_id: context.accountId, ...sessionPatch, started_at: now });
      automaticallyMarkedPlayed = await this.upsertProgress(
        transaction,
        context,
        itemId,
        mediaSourceId ?? null,
        positionTicks,
        kind === "stopped" && !existingHistory,
        completed,
        now,
      );
      if (kind === "stopped") {
        if (!existingHistory) await transaction("service_playback_history").insert({ id: randomUUID(), service_id: context.serviceId, account_id: context.accountId, item_id: itemId, play_session_id: playSessionId, position_ticks: positionTicks, completed: completed ? 1 : 0, started_at: existing?.started_at ?? now, stopped_at: now });
      }
    });
    if (automaticallyMarkedPlayed) {
      this.runtime.logBusinessEvent("info", {
        日志关键字: "codex-jellyfin-user-state",
        事件: "Jellyfin播放进度达到90%自动标记已观看",
        服务ID: context.serviceId,
        账号ID: context.accountId,
        媒体条目ID: itemId,
        上报类型: kind,
        已观看Ticks: positionTicks,
        总时长Ticks: durationTicks,
        进度百分比: progressPercentage,
      });
    }
    this.runtime.logBusinessEvent("info", {
      日志关键字: "codex-jellyfin-playback-progress",
      事件: "保存Jellyfin播放进度",
      服务ID: context.serviceId,
      账号ID: context.accountId,
      媒体条目ID: itemId,
      上报类型: kind,
      已观看Ticks: positionTicks,
      总时长Ticks: durationTicks,
      进度百分比: progressPercentage,
    });
  }

  /** 设置已播放状态。 */
  public async setPlayed(context: JellyfinContext, itemId: string, played: boolean) {
    if (context.aggregateService) return this.setAggregatePlayed(context, itemId, played);
    const internalItemId = decodeProtocolItemId(itemId);
    const item = await this.runtime.repository.getCatalogItem(internalItemId, context.ownerUserId);
    if (item.serviceId !== context.serviceId) throw new ApiError(404, "jellyfin_item_not_found", "媒体条目不存在");
    const now = new Date().toISOString();
    const episodeIds = item.itemType === "video.series"
      ? (await this.runtime.repository.listCatalogChildren(internalItemId, context.ownerUserId))
        .filter((child) => child.serviceId === context.serviceId && child.itemType === "video.episode")
        .map((episode) => episode.id)
      : [];
    // 关键变量：普通 Jellyfin 与聚合 Jellyfin 保持一致，节目和所有单集在同一事务中更新。
    const targetItemIds = [...new Set([internalItemId, ...episodeIds])];
    await this.runtime.database.query.transaction(async (transaction) => {
      const existingRows: Array<Record<string, unknown>> = [];
      for (let offset = 0; offset < targetItemIds.length; offset += JELLYFIN_USER_STATE_BATCH_SIZE) {
        existingRows.push(...await transaction("service_playback_progress")
          .where({ service_id: context.serviceId, account_id: context.accountId })
          .whereIn("item_id", targetItemIds.slice(offset, offset + JELLYFIN_USER_STATE_BATCH_SIZE)));
      }
      const existingByItemId = new Map(existingRows.map((row) => [String(row.item_id), row]));
      const rows = targetItemIds.map((targetItemId) => {
        const existing = existingByItemId.get(targetItemId);
        return {
          id: String(existing?.id ?? randomUUID()),
          service_id: context.serviceId,
          account_id: context.accountId,
          item_id: targetItemId,
          media_source_id: existing?.media_source_id ?? null,
          played: played ? 1 : 0,
          position_ticks: 0,
          hidden_from_resume: played ? 1 : 0,
          play_count: played ? Math.max(1, Number(existing?.play_count ?? 0)) : 0,
          updated_at: now,
          last_played_at: played ? now : null,
        };
      });
      for (let offset = 0; offset < rows.length; offset += JELLYFIN_USER_STATE_BATCH_SIZE) {
        await transaction("service_playback_progress")
          .insert(rows.slice(offset, offset + JELLYFIN_USER_STATE_BATCH_SIZE))
          .onConflict(["service_id", "account_id", "item_id"])
          .merge(["played", "position_ticks", "hidden_from_resume", "play_count", "last_played_at", "updated_at"]);
      }
    });
    const progress = await this.readProgress(context, internalItemId);
    const runTimeTicks = await this.readItemRunTimeTicks(item);
    const userData = this.mapUserData(
      progress,
      runTimeTicks,
      await this.isMediaItemFavorite(context, internalItemId),
      encodeProtocolItemId(internalItemId),
    );
    this.runtime.logBusinessEvent("info", {
      日志关键字: "codex-jellyfin-user-state",
      事件: "更新Jellyfin已观看状态",
      服务ID: context.serviceId,
      账号ID: context.accountId,
      媒体条目ID: internalItemId,
      媒体类型: item.itemType,
      是否已观看: played,
      级联单集数量: episodeIds.length,
      清零进度条目数量: targetItemIds.length,
    });
    return userData;
  }

  /** 设置媒体或虚拟 Person 条目的 Jellyfin 收藏状态。 */
  public async setFavorite(context: JellyfinContext, itemId: string, favorite: boolean) {
    if (context.aggregateService) return this.setAggregateFavorite(context, itemId, favorite);
    const protocolItemId = itemId.trim().toLowerCase();
    const now = new Date().toISOString();
    if (this.isPotentialPersonId(context, protocolItemId)) {
      const personCache = await this.loadPersonCache(context);
      if (personCache.peopleById.has(protocolItemId)) {
        const existing = await this.runtime.database.query("service_jellyfin_virtual_preferences")
          .where({ service_id: context.serviceId, account_id: context.accountId, protocol_item_id: protocolItemId }).first();
        if (favorite && existing) {
          await this.runtime.database.query("service_jellyfin_virtual_preferences").where({ id: existing.id }).update({ starred_at: now, updated_at: now });
        } else if (favorite) {
          await this.runtime.database.query("service_jellyfin_virtual_preferences").insert({
            id: randomUUID(), service_id: context.serviceId, account_id: context.accountId,
            protocol_item_id: protocolItemId, item_type: "Person", starred_at: now, updated_at: now,
          });
        } else if (existing) {
          await this.runtime.database.query("service_jellyfin_virtual_preferences").where({ id: existing.id }).delete();
        }
        this.logUserFavoriteChange(context, protocolItemId, "Person", favorite);
        return this.mapUserData(null, 0, favorite, protocolItemId);
      }
    }

    const internalItemId = decodeProtocolItemId(itemId);
    const item = await this.runtime.repository.getCatalogItem(internalItemId, context.ownerUserId);
    if (item.serviceId !== context.serviceId) throw new ApiError(404, "jellyfin_item_not_found", "媒体条目不存在");
    const existing = await this.runtime.database.query("service_item_preferences")
      .where({ service_id: context.serviceId, account_id: context.accountId, item_id: internalItemId }).first();
    if (favorite && existing) {
      await this.runtime.database.query("service_item_preferences").where({ id: existing.id }).update({ starred_at: now, updated_at: now });
    } else if (favorite) {
      await this.runtime.database.query("service_item_preferences").insert({
        id: randomUUID(), service_id: context.serviceId, account_id: context.accountId,
        item_id: internalItemId, starred_at: now, rating: 0, updated_at: now,
      });
    } else if (existing && Number(existing.rating ?? 0) === 0) {
      await this.runtime.database.query("service_item_preferences").where({ id: existing.id }).delete();
    } else if (existing) {
      await this.runtime.database.query("service_item_preferences").where({ id: existing.id }).update({ starred_at: null, updated_at: now });
    }
    const progress = await this.readProgress(context, internalItemId);
    const runTimeTicks = await this.readItemRunTimeTicks(item);
    this.logUserFavoriteChange(context, internalItemId, item.itemType, favorite);
    return this.mapUserData(progress, runTimeTicks, favorite, encodeProtocolItemId(internalItemId));
  }

  /** 记录 Jellyfin 收藏状态写入结果。 */
  private logUserFavoriteChange(
    context: JellyfinContext,
    itemId: string,
    itemType: string,
    favorite: boolean,
  ): void {
    this.runtime.logBusinessEvent("info", {
      日志关键字: "codex-jellyfin-user-state",
      事件: "更新Jellyfin收藏状态",
      服务ID: context.serviceId,
      账号ID: context.accountId,
      条目ID: itemId,
      条目类型: itemType,
      是否收藏: favorite,
    });
  }

  /** 从继续观看隐藏或恢复条目。 */
  public async setHiddenFromResume(context: JellyfinContext, itemId: string, hidden: boolean) {
    if (context.aggregateService) {
      const aggregateItem = await this.aggregateCatalog.getItem(context.serviceId, context.ownerUserId, decodeAggregateJellyfinItemId(itemId));
      const now = new Date().toISOString();
      const existing = await this.readAggregateProgress(context, aggregateItem.aggregateItemId);
      if (existing) await this.runtime.database.query("aggregate_playback_progress").where({ id: existing.id }).update({ hidden_from_resume: hidden ? 1 : 0, updated_at: now });
      else await this.runtime.database.query("aggregate_playback_progress").insert({ id: randomUUID(), aggregate_service_id: context.serviceId, account_id: context.accountId, aggregate_item_id: aggregateItem.aggregateItemId, media_source_id: null, position_ticks: 0, played: 0, hidden_from_resume: hidden ? 1 : 0, play_count: 0, last_played_at: null, updated_at: now });
      return;
    }
    const internalItemId = decodeProtocolItemId(itemId);
    const item = await this.runtime.repository.getCatalogItem(internalItemId, context.ownerUserId);
    if (item.serviceId !== context.serviceId) throw new ApiError(404, "jellyfin_item_not_found", "媒体条目不存在");
    const now = new Date().toISOString();
    const existing = await this.runtime.database.query("service_playback_progress").where({ service_id: context.serviceId, account_id: context.accountId, item_id: internalItemId }).first();
    if (existing) await this.runtime.database.query("service_playback_progress").where({ id: existing.id }).update({ hidden_from_resume: hidden ? 1 : 0, updated_at: now });
    else await this.runtime.database.query("service_playback_progress").insert({ id: randomUUID(), service_id: context.serviceId, account_id: context.accountId, item_id: internalItemId, position_ticks: 0, played: 0, hidden_from_resume: hidden ? 1 : 0, play_count: 0, last_played_at: null, updated_at: now });
  }

  /** 读取当前账号的条目进度。 */
  private async readProgress(context: JellyfinContext, itemId: string) {
    return this.runtime.database.query("service_playback_progress").where({ service_id: context.serviceId, account_id: context.accountId, item_id: itemId }).first();
  }

  /** 读取电影或单集实际源文件时长，指定媒体源时只使用该版本。 */
  private async readItemRunTimeTicks(
    item: MediaItemRecord,
    mediaSourceId?: string,
  ): Promise<number> {
    const query = this.runtime.database.query("file_links as fl")
      .join("source_files as f", "f.id", "fl.source_file_id")
      .leftJoin("media_file_probes as p", "p.source_file_id", "f.id")
      .select("fl.source_file_id", "p.status", "p.result_json")
      // 关键变量：只按当前条目仍然有效的实际文件判断完整性，与条目详情和 PlaybackInfo 保持一致。
      .where({
        "fl.user_id": item.userId,
        "fl.item_id": item.id,
        "f.service_id": item.serviceId,
        "f.status": "active",
      })
      .orderBy("f.path", "asc");
    const rows = await query;
    const probes = rows.map((row) => parseCompletedMediaProbeResult(row.status, row.result_json));
    if (rows.length === 0 || probes.some((probe) => probe === null)) return 0;
    if (mediaSourceId) {
      // 关键变量：客户端上报条目 ID 时，对应当前条目的主媒体源。
      const selectedIndex = mediaSourceId === item.id
        ? 0
        : rows.findIndex((row) => String(row.source_file_id) === mediaSourceId);
      return selectedIndex >= 0 ? probes[selectedIndex]?.runTimeTicks ?? 0 : 0;
    }
    return readJellyfinRunTimeTicks(probes);
  }

  /** 批量加载列表 DTO 所需的用户进度和文件摘要，避免对每个条目重复查询。 */
  private async loadItemMappingContext(context: JellyfinContext, itemIds: string[]): Promise<JellyfinItemMappingContext> {
    const uniqueItemIds = [...new Set(itemIds)];
    if (uniqueItemIds.length === 0) return { progressByItemId: new Map(), favoriteItemIds: new Set(), filesByItemId: new Map() };
    const [progressRows, preferenceRows, fileRows] = await Promise.all([
      this.runtime.database.query("service_playback_progress")
        .where({ service_id: context.serviceId, account_id: context.accountId }).whereIn("item_id", uniqueItemIds),
      this.runtime.database.query("service_item_preferences")
        .select("item_id")
        .where({ service_id: context.serviceId, account_id: context.accountId })
        .whereIn("item_id", uniqueItemIds)
        .whereNotNull("starred_at"),
      this.runtime.database.query("file_links as fl")
        .join("source_files as f", "f.id", "fl.source_file_id")
        .leftJoin("media_file_probes as p", "p.source_file_id", "f.id")
        .select("fl.item_id", "f.id as file_id", "f.name", "f.size", "p.status", "p.result_json")
        .whereIn("fl.item_id", uniqueItemIds)
        .where({ "f.service_id": context.serviceId, "f.status": "active" })
        // 关键变量：列表和详情保持同一文件顺序，保证主媒体源选择稳定。
        .orderBy("f.path", "asc"),
    ]);
    const progressByItemId = new Map(progressRows.map((row) => [String(row.item_id), row as Record<string, unknown>]));
    const favoriteItemIds = new Set(preferenceRows.map((row) => String(row.item_id)));
    const filesByItemId = new Map<string, JellyfinFileSummary[]>();
    for (const row of fileRows) {
      const itemId = String(row.item_id);
      const files = filesByItemId.get(itemId) ?? [];
      files.push({
        fileId: String(row.file_id),
        name: String(row.name ?? ""),
        size: Number(row.size ?? 0),
        mediaProbe: parseCompletedMediaProbeResult(row.status, row.result_json),
      });
      filesByItemId.set(itemId, files);
    }
    return { progressByItemId, favoriteItemIds, filesByItemId };
  }

  /** 映射 Jellyfin UserItemDataDto。 */
  private mapUserData(
    progress: Record<string, unknown> | null | undefined,
    runTimeTicks: number,
    favorite = false,
    protocolItemId?: string,
  ) {
    const positionTicks = Number(progress?.position_ticks ?? 0);
    const played = Number(progress?.played ?? 0) === 1;
    const itemId = String(progress?.item_id ?? "");
    const mediaSourceId = String(progress?.media_source_id ?? "");
    // 关键变量：Jellyfin 完播后清零播放位置；播放百分比只根据仍然存在的播放位置派生。
    const playbackPositionTicks = played ? 0 : positionTicks;
    return {
      PlaybackPositionTicks: playbackPositionTicks, PlayCount: Number(progress?.play_count ?? 0), IsFavorite: favorite,
      Played: played, LastPlayedDate: progress?.last_played_at ?? undefined,
      PlayedPercentage: runTimeTicks > 0 && playbackPositionTicks > 0
        ? playbackPositionTicks / runTimeTicks * 100
        : undefined,
      Key: "",
      ItemId: protocolItemId ?? (itemId ? encodeProtocolItemId(itemId) : undefined),
      MediaSourceId: mediaSourceId
        ? INTERNAL_ITEM_ID_PATTERN.test(mediaSourceId) ? encodeProtocolItemId(mediaSourceId) : mediaSourceId
        : undefined,
    };
  }

  /** 读取当前账号的媒体条目收藏状态。 */
  private async isMediaItemFavorite(context: JellyfinContext, itemId: string): Promise<boolean> {
    const preference = await this.runtime.database.query("service_item_preferences")
      .select("id")
      .where({ service_id: context.serviceId, account_id: context.accountId, item_id: itemId })
      .whereNotNull("starred_at")
      .first();
    return Boolean(preference);
  }

  /** 读取 Person 等虚拟 Jellyfin 条目的收藏状态。 */
  private async isVirtualItemFavorite(context: JellyfinContext, protocolItemId: string): Promise<boolean> {
    const preference = await this.runtime.database.query("service_jellyfin_virtual_preferences")
      .select("id")
      .where({ service_id: context.serviceId, account_id: context.accountId, protocol_item_id: protocolItemId.toLowerCase() })
      .first();
    return Boolean(preference);
  }

  /** 判断 Items 查询是否要求某个用户状态过滤。 */
  private queryIncludesFilter(query: Record<string, unknown>, filterName: string, booleanKey: string): boolean {
    const filters = String(this.readQueryValue(query, "Filters") ?? "").split(",").map((value) => value.trim());
    if (filters.includes(filterName)) return true;
    return String(this.readQueryValue(query, booleanKey) ?? "").toLowerCase() === "true";
  }

  /** 读取 Jellyfin 旧客户端 PascalCase 或新 SDK camelCase 查询参数。 */
  private readQueryValue(query: Record<string, unknown>, key: string): unknown {
    const camelCaseKey = `${key.charAt(0).toLowerCase()}${key.slice(1)}`;
    return query[key] ?? query[camelCaseKey];
  }

  /** 判断用户状态列表中的条目是否属于请求的媒体库、节目或季。 */
  private matchesParentScope(
    context: JellyfinContext,
    item: MediaItemRecord,
    parent: MediaItemRecord | undefined,
    query: Record<string, unknown>,
  ): boolean {
    const parentId = String(this.readQueryValue(query, "ParentId") ?? "");
    if (!parentId || parentId === context.libraryId) return true;
    const virtualLibrary = this.findLibraryDefinition(context, parentId);
    if (virtualLibrary) return this.getItemLibraryDefinition(context, item).id === virtualLibrary.id;
    const virtualSeason = this.parseSeasonReference(parentId);
    if (virtualSeason) {
      return parent?.id === virtualSeason.seriesId
        && Number(item.metadata.seasonNumber ?? 0) === virtualSeason.seasonNumber;
    }
    try {
      return parent?.id === decodeProtocolItemId(parentId);
    } catch {
      return false;
    }
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
  ): Promise<boolean> {
    const existing = await transaction("service_playback_progress").where({ service_id: context.serviceId, account_id: context.accountId, item_id: itemId }).first();
    // 关键变量：只有从未观看切换为已观看时才记录自动标记日志。
    const alreadyPlayed = Number(existing?.played ?? 0) === 1;
    const newlyCompleted = completed && !alreadyPlayed;
    const patch = {
      media_source_id: mediaSourceId ?? existing?.media_source_id ?? null,
      position_ticks: completed ? 0 : positionTicks,
      // 已观看状态只由显式“标记未观看”撤销，后续播放上报不能反向清除。
      played: completed || alreadyPlayed ? 1 : 0,
      hidden_from_resume: completed || alreadyPlayed ? 1 : 0,
      last_played_at: now,
      updated_at: now,
    };
    const existingPlayCount = Number(existing?.play_count ?? 0);
    // 进度首次达标时立即保证 PlayCount 至少为 1，Stopped 事件不再对同一次完播重复计数。
    const playCount = newlyCompleted
      ? Math.max(1, existingPlayCount)
      : existingPlayCount + (stopped && !completed ? 1 : 0);
    if (existing) await transaction("service_playback_progress").where({ id: existing.id }).update({ ...patch, play_count: playCount });
    else await transaction("service_playback_progress").insert({ id: randomUUID(), service_id: context.serviceId, account_id: context.accountId, item_id: itemId, ...patch, play_count: playCount });
    return newlyCompleted;
  }

  /** 查找单集父节目。 */
  private async findParent(itemId: string, userId: string): Promise<MediaItemRecord | undefined> {
    const relation = await this.runtime.database.query("media_relations").where({ child_item_id: itemId }).first();
    return relation ? this.runtime.repository.getCatalogItem(String(relation.parent_item_id), userId) : undefined;
  }

  /** 对已经映射的 DTO 执行 Jellyfin 风格分页。 */
  private paginate<T>(items: T[], query: Record<string, unknown>) {
    const start = Math.max(0, Number(this.readQueryValue(query, "StartIndex") ?? 0));
    const limit = Math.min(500, Math.max(1, Number(this.readQueryValue(query, "Limit") ?? (items.length || 100))));
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
