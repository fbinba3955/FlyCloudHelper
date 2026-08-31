import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { Knex } from "knex";
import { hashSessionToken } from "./auth.js";
import type { CatalogSort, MediaItemRecord, VideoRegionGroup } from "./domain.js";
import { ApiError } from "./errors.js";
import type { ApiRuntime } from "./runtime.js";
import { hydrateRealtimeVideoDetails } from "./media/realtime-video-details.js";
import { parseCompletedMediaProbeResult, readJellyfinRunTimeTicks, type MediaProbeResult } from "./media/media-probe.js";

/** Emby 媒体库读取使用的服务范围；与 Jellyfin 的账号和用户状态完全隔离。 */
export interface EmbyLibraryContext {
  serviceId: string;
  ownerUserId: string;
  libraryId: string;
  /** 是否按媒体地区返回 Emby 虚拟媒体库。 */
  regionLibrariesEnabled: boolean;
}

/** 已完成 Emby 会话认证后的上下文。 */
export interface EmbyContext extends EmbyLibraryContext {
  accountId: string;
  accountUsername: string;
  accountHasPassword: boolean;
  credentialRevision: number;
  accessToken: string;
  downloadEnabled: boolean;
}

interface EmbyFileSummary {
  fileId: string;
  name: string;
  size: number;
  mediaProbe: MediaProbeResult | null;
}

interface EmbyLibraryDefinition {
  internalId: string;
  id: string;
  name: string;
  collectionType: "movies" | "tvshows";
  itemType: "video.movie" | "video.series";
  regionGroup?: VideoRegionGroup;
}

interface EmbyPersonSummary {
  id: string;
  name: string;
  profileUrl: string;
  imageTag: string;
  itemIds: Set<string>;
}

interface EmbyPersonCache {
  catalogVersion: number;
  peopleById: Map<string, EmbyPersonSummary>;
}

interface EmbyAccessAccount {
  id: string;
  username: string;
  hasPassword: boolean;
  credentialRevision: number;
}

/** emby-access.ts 的最小调用约束，避免协议层依赖管理端 DTO。 */
interface EmbyAccessServiceLike {
  authenticate(serviceId: string, username: unknown, password: unknown): Promise<EmbyAccessAccount>;
}

const ITEM_UUID_PREFIX = "f10c0000";
const SEASON_UUID_PREFIX = "f2";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const INTERNAL_ITEM_ID_PATTERN = /^itm_([0-9a-f]{24})$/iu;

/** 格式化为 Emby SDK 可解析的标准 UUID。 */
function formatUuid(value: string): string {
  const hex = value.toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** 为虚拟库、季和人物生成稳定 UUID；Emby 与 Jellyfin 共用媒体 ID 编码但不共用状态数据。 */
function protocolUuid(scope: string, value: string): string {
  const digest = createHash("sha256").update(`flycloud-jellyfin\u0000${scope}\u0000${value}`, "utf8").digest();
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  return formatUuid(digest.toString("hex").slice(0, 32));
}

/** 内部媒体 ID 与既有 Jellyfin 保持同一可逆 UUID，方便客户端跨协议识别同一目录实体。 */
function encodeItemId(itemId: string): string {
  if (UUID_PATTERN.test(itemId)) return itemId.toLowerCase();
  const match = INTERNAL_ITEM_ID_PATTERN.exec(itemId);
  return match?.[1] ? formatUuid(`${ITEM_UUID_PREFIX}${match[1]}`) : protocolUuid("item", itemId);
}

/** 将协议 ID 还原为内部媒体 ID，同时保留旧客户端传入 itm_ ID 的兼容性。 */
function decodeItemId(itemId: string): string {
  const normalized = itemId.trim().toLowerCase();
  if (INTERNAL_ITEM_ID_PATTERN.test(normalized)) return normalized;
  const compact = normalized.replace(/-/gu, "");
  if (compact.length === 32 && compact.startsWith(ITEM_UUID_PREFIX)) return `itm_${compact.slice(ITEM_UUID_PREFIX.length)}`;
  return itemId;
}

/** 将节目和季号转换成无须新建媒体实体的虚拟 UUID。 */
function encodeSeasonId(seriesId: string, seasonNumber: number): string {
  const match = INTERNAL_ITEM_ID_PATTERN.exec(seriesId);
  if (!match?.[1]) return protocolUuid("season", `${seriesId}:${seasonNumber}`);
  const normalizedSeason = Math.min(0xffffff, Math.max(0, Math.floor(seasonNumber)));
  return formatUuid(`${SEASON_UUID_PREFIX}${normalizedSeason.toString(16).padStart(6, "0")}${match[1]}`);
}

/** 解析 Emby 虚拟季 ID。 */
function decodeSeasonId(value: string): { seriesId: string; seasonNumber: number } | null {
  const compact = value.trim().toLowerCase().replace(/-/gu, "");
  if (!/^f2[0-9a-f]{30}$/u.test(compact)) return null;
  return { seriesId: `itm_${compact.slice(8)}`, seasonNumber: Number.parseInt(compact.slice(2, 8), 16) };
}

/** 读取 Emby/MediaBrowser 兼容认证令牌。 */
export function readEmbyToken(request: FastifyRequest): string {
  const direct = request.headers["x-emby-token"] ?? request.headers["x-mediabrowser-token"];
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const query = request.query as Record<string, unknown> | undefined;
  const queryToken = query?.api_key ?? query?.ApiKey ?? query?.access_token;
  if (typeof queryToken === "string" && queryToken.trim()) return queryToken.trim();
  const authorization = request.headers.authorization
    ?? request.headers["x-emby-authorization"]
    ?? request.headers["x-mediabrowser-authorization"]
    ?? "";
  // 关键变量：部分 Emby 客户端只在 X-Emby-Authorization 中携带 Token，不应误判为未登录。
  return (typeof authorization === "string" ? authorization : "")
    .match(/(?:Token|token)\s*=\s*"?([^",\s]+)"?/u)?.[1]?.trim() ?? "";
}

/** 从 Emby Authorization 头读取客户端设备字段。 */
function authorizationAttribute(request: FastifyRequest, key: string): string | null {
  const source = request.headers["x-emby-authorization"] ?? request.headers["x-mediabrowser-authorization"] ?? request.headers.authorization ?? "";
  const header = typeof source === "string" ? source : "";
  const match = header.match(new RegExp(`${key}=(?:"([^"]*)"|([^,\\s]*))`, "iu"));
  return (match?.[1] ?? match?.[2])?.slice(0, 255) ?? null;
}

/** 输出协议图片字段所需的稳定 ETag。 */
function imageTag(url: string): string {
  return createHash("sha256").update(url, "utf8").digest("hex").slice(0, 32);
}

/** 转换外部媒体库 ID 为 Emby 通用 ProviderIds 键。 */
function mapProviderIds(providerIds: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(providerIds).map(([key, value]) => {
    const normalized = key.toLowerCase();
    return [normalized === "tmdb" ? "Tmdb" : normalized === "imdb" ? "Imdb" : normalized === "tvdb" ? "Tvdb" : key, value];
  }));
}

/** Emby 兼容协议服务；其所有用户数据只读写 service_emby_* 表。 */
export class EmbyCompatibilityService {
  private readonly loginFailures = new Map<string, { count: number; firstFailedAt: number; blockedUntil: number }>();
  private readonly personCaches = new Map<string, EmbyPersonCache>();

  public constructor(private readonly runtime: ApiRuntime) {}

  /** 转为公开协议条目 ID。 */
  public toProtocolItemId(itemId: string): string { return encodeItemId(itemId); }

  /** 转为内部目录条目 ID。 */
  public toInternalItemId(itemId: string): string { return decodeItemId(itemId); }

  /** 解析当前条目的主媒体源 ID，额外版本 ID 直接使用 source_files 主键。 */
  public toInternalMediaSourceId(itemId: string, mediaSourceId: string): string {
    if (!mediaSourceId) return mediaSourceId;
    const internalItemId = decodeItemId(itemId);
    return mediaSourceId === encodeItemId(internalItemId) || mediaSourceId === internalItemId ? internalItemId : mediaSourceId;
  }

  /** 根据 /e/{路径} 的自定义后缀找到所属服务。 */
  public async resolveServiceIdByPathSuffix(pathSuffix: string): Promise<string> {
    const row = await this.runtime.database.query("media_libraries as l").join("cloud_services as s", "s.id", "l.service_id")
      .select("l.service_id").where("l.emby_path_suffix_lookup", pathSuffix.toLowerCase()).whereNull("s.deleted_at").first();
    if (!row) throw new ApiError(404, "emby_service_not_found", "Emby 服务地址不存在");
    return String(row.service_id);
  }

  /** 检查 Emby 服务开关，并返回路由、下载和地区库配置。 */
  public async requireEnabledService(serviceId: string) {
    const row = await this.runtime.database.query("cloud_services as s").join("media_libraries as l", "l.id", "s.library_id")
      .select("s.id", "s.user_id", "s.library_id", "s.display_name", "s.status", "l.emby_enabled", "l.emby_relay_playback_enabled", "l.emby_download_enabled", "l.emby_region_libraries_enabled")
      .where("s.id", serviceId).whereNull("s.deleted_at").first();
    if (!row) throw new ApiError(404, "emby_service_not_found", "Emby 服务不存在");
    if (Number(row.emby_enabled) !== 1 || row.status === "disabled") throw new ApiError(404, "emby_service_disabled", "Emby 服务未启用");
    return row;
  }

  /** 图片入口无需认证时使用的媒体归属上下文。 */
  public async resolvePublicImageContext(serviceId: string): Promise<EmbyLibraryContext> {
    const service = await this.requireEnabledService(serviceId);
    return { serviceId, ownerUserId: String(service.user_id), libraryId: String(service.library_id), regionLibrariesEnabled: Number(service.emby_region_libraries_enabled) === 1 };
  }

  /** 服务独立 Emby 账号登录并创建 service_emby_sessions 会话。 */
  public async login(serviceId: string, request: FastifyRequest, body: Record<string, unknown>) {
    const service = await this.requireEnabledService(serviceId);
    const key = `${serviceId}:${request.ip}`;
    this.requireLoginAllowed(key);
    let account: EmbyAccessAccount;
    try {
      const access = (this.runtime as unknown as { embyAccess: EmbyAccessServiceLike }).embyAccess;
      account = await access.authenticate(serviceId, body.Username ?? body.username, body.Pw ?? body.Password ?? body.password);
      this.loginFailures.delete(key);
    } catch (error) {
      const blockedUntil = this.recordLoginFailure(key);
      this.runtime.logBusinessEvent("warn", { 日志关键字: "codex-emby-compat", 事件: "Emby服务账号登录失败", 服务ID: serviceId, 来源地址: request.ip, 是否已临时限制: blockedUntil > Date.now() });
      throw error;
    }
    const token = randomBytes(32).toString("base64url");
    const now = new Date().toISOString();
    const sessionId = randomUUID();
    await this.runtime.database.query("service_emby_sessions").insert({
      id: sessionId, service_id: serviceId, account_id: account.id, token_hash: hashSessionToken(token), credential_revision: account.credentialRevision,
      device_id: authorizationAttribute(request, "DeviceId") ?? null, device_name: authorizationAttribute(request, "Device"), client_name: authorizationAttribute(request, "Client"),
      expires_at: new Date(Date.now() + this.runtime.config.refreshTokenTtlSeconds * 1000).toISOString(), last_seen_at: now, revoked_at: null, created_at: now,
    });
    this.runtime.logBusinessEvent("info", { 日志关键字: "codex-emby-compat", 事件: "Emby服务账号登录成功", 服务ID: serviceId, 服务访问账号ID: account.id, 客户端名称: authorizationAttribute(request, "Client") ?? "Emby" });
    return { User: this.mapUser(account.id, account.username, serviceId, account.hasPassword, Number(service.emby_download_enabled) === 1), SessionInfo: { Id: sessionId, ServerId: serviceId, UserId: account.id, UserName: account.username, Client: authorizationAttribute(request, "Client") ?? "Emby" }, AccessToken: token, ServerId: serviceId };
  }

  /** 验证 service_emby_sessions 和 service_emby_accounts，不访问 Jellyfin 会话或账号表。 */
  public async authenticate(serviceId: string, request: FastifyRequest): Promise<EmbyContext> {
    const token = readEmbyToken(request);
    if (!token) {
      this.runtime.logBusinessEvent("warn", {
        日志关键字: "codex-emby-auth",
        事件: "Emby请求缺少访问令牌",
        服务ID: serviceId,
        请求方法: request.method,
        请求路径: request.url.split("?", 1)[0] ?? request.url,
        是否携带令牌请求头: Boolean(request.headers["x-emby-token"] || request.headers["x-mediabrowser-token"]),
        是否携带查询令牌: Boolean((request.query as Record<string, unknown> | undefined)?.api_key),
      });
      throw new ApiError(401, "emby_token_required", "需要 Emby 访问令牌");
    }
    const row = await this.runtime.database.query("service_emby_sessions as es").join("service_emby_accounts as a", "a.id", "es.account_id")
      .join("cloud_services as s", "s.id", "es.service_id").join("media_libraries as l", "l.id", "s.library_id")
      .select("es.*", "a.username", "a.password_required", "a.credential_revision as account_revision", "a.status as account_status", "s.user_id", "s.library_id", "s.status as service_status", "l.emby_enabled", "l.emby_region_libraries_enabled", "l.emby_download_enabled")
      .where("es.token_hash", hashSessionToken(token)).where("es.service_id", serviceId).whereNull("es.revoked_at").whereNull("s.deleted_at").first();
    const now = new Date().toISOString();
    // 关键变量：会话失效原因只记录布尔状态，绝不输出实际访问令牌。
    const sessionInvalid = !row || String(row.expires_at) <= now || Number(row.credential_revision) !== Number(row.account_revision)
      || row.account_status !== "active" || row.service_status === "disabled" || Number(row.emby_enabled) !== 1;
    if (sessionInvalid) {
      this.runtime.logBusinessEvent("warn", {
        日志关键字: "codex-emby-auth",
        事件: "Emby会话校验失败",
        服务ID: serviceId,
        请求方法: request.method,
        请求路径: request.url.split("?", 1)[0] ?? request.url,
        是否找到会话: Boolean(row),
        是否会话过期: row ? String(row.expires_at) <= now : false,
        是否凭据版本一致: row ? Number(row.credential_revision) === Number(row.account_revision) : false,
        账号是否启用: row ? row.account_status === "active" : false,
        服务是否启用: row ? row.service_status !== "disabled" && Number(row.emby_enabled) === 1 : false,
      });
      throw new ApiError(401, "emby_session_invalid", "Emby 登录已失效，请重新登录");
    }
    if (String(row.last_seen_at) < new Date(Date.now() - 5 * 60 * 1000).toISOString()) await this.runtime.database.query("service_emby_sessions").where({ id: row.id }).update({ last_seen_at: new Date().toISOString() });
    return { serviceId, ownerUserId: String(row.user_id), libraryId: String(row.library_id), regionLibrariesEnabled: Number(row.emby_region_libraries_enabled) === 1, accountId: String(row.account_id), accountUsername: String(row.username), accountHasPassword: Number(row.password_required ?? 1) !== 0, credentialRevision: Number(row.account_revision), accessToken: token, downloadEnabled: Number(row.emby_download_enabled) === 1 };
  }

  /** 注销当前 Emby 令牌。 */
  public async logout(serviceId: string, request: FastifyRequest): Promise<void> {
    const token = readEmbyToken(request);
    if (token) await this.runtime.database.query("service_emby_sessions").where({ service_id: serviceId, token_hash: hashSessionToken(token) }).whereNull("revoked_at").update({ revoked_at: new Date().toISOString() });
  }

  /** 构造 Emby UserDto，账号不拥有服务管理权限。 */
  public mapUser(accountId: string, username: string, serviceId = "", hasPassword = true, downloadEnabled = true) {
    return { Name: username, ServerId: serviceId, Id: accountId, HasPassword: hasPassword, HasConfiguredPassword: hasPassword, EnableAutoLogin: false, Configuration: {}, Policy: { IsAdministrator: false, IsHidden: false, IsDisabled: false, EnableMediaPlayback: true, EnableAudioPlaybackTranscoding: false, EnableVideoPlaybackTranscoding: false, EnableContentDownloading: downloadEnabled, EnableContentDeletion: false } };
  }

  /** 返回电影、节目及可选地区分组的 Emby 虚拟库。 */
  public async listLibraries(context: EmbyContext) {
    const definitions = this.libraryDefinitions(context);
    const items = await Promise.all(definitions.map(async (library) => {
      const result = await this.runtime.repository.listCatalogItems({ userId: context.ownerUserId, serviceId: context.serviceId, mediaType: "video", itemType: library.itemType, regionGroup: library.regionGroup, sort: "updated_desc", limit: 1, offset: 0, includeFileCounts: false });
      const cover = result.items[0];
      const tag = cover?.posterUrl ? String(Date.parse(cover.updatedAt) || 1) : "";
      return { Name: library.name, ServerId: context.serviceId, Id: library.id, Type: "CollectionFolder", CollectionType: library.collectionType, IsFolder: true, ChildCount: result.total, RecursiveItemCount: result.total, ImageTags: tag ? { Primary: tag } : {}, PrimaryImageTag: tag || undefined, PrimaryImageItemId: tag && cover ? encodeItemId(cover.id) : undefined, UserData: this.emptyUserData() };
    }));
    return { Items: items, TotalRecordCount: items.length, StartIndex: 0 };
  }

  /** 查询普通媒体条目列表，支持 Emby 常用 ParentId、类型、搜索和收藏/观看筛选。 */
  public async listItems(context: EmbyContext, query: Record<string, unknown>) {
    const include = this.queryString(query, "IncludeItemTypes").split(",").map((value) => value.trim()).filter(Boolean);
    const requestedTypes = include.map((type) => type === "Movie" ? "video.movie" : type === "Series" ? "video.series" : type === "Episode" ? "video.episode" : "").filter(Boolean);
    const parentId = this.queryString(query, "ParentId");
    const library = this.libraryDefinitions(context).find((entry) => entry.id === parentId);
    const season = decodeSeasonId(parentId);
    if (season) return this.listEpisodes(context, encodeItemId(season.seriesId), { ...query, Season: season.seasonNumber });
    // 关键变量：部分第三方 Emby 播放器会缓存或自行构造非 UUID 的媒体库 ParentId；不能因此返回空列表。
    // 只有可识别为条目 ID 的父级才按节目读取单集，其他父级退回当前媒体库根列表。
    const parentSeriesId = parentId && !library && (UUID_PATTERN.test(parentId) || INTERNAL_ITEM_ID_PATTERN.test(parentId))
      ? decodeItemId(parentId)
      : "";
    if (parentSeriesId) return this.listEpisodes(context, encodeItemId(parentSeriesId), query);
    const types = requestedTypes.length > 0 ? requestedTypes : library ? [library.itemType] : ["video.movie", "video.series"];
    const records = (await Promise.all(types.map((itemType) => this.runtime.repository.listCatalogItems({ userId: context.ownerUserId, serviceId: context.serviceId, mediaType: "video", itemType, regionGroup: library?.regionGroup, search: this.queryString(query, "SearchTerm") || undefined, sort: this.readSort(query), limit: 500, offset: 0, includeFileCounts: false })))).flatMap((result) => result.items);
    const mapped = await this.mapItems(context, records);
    const result = this.filterAndPaginate(mapped, query);
    this.runtime.logBusinessEvent("info", {
      日志关键字: "codex-emby-route",
      事件: "返回Emby媒体列表",
      服务ID: context.serviceId,
      账号ID: context.accountId,
      父级ID: parentId || null,
      请求条目类型: include.join(",") || "未指定",
      返回条目数量: result.Items.length,
      总条目数量: result.TotalRecordCount,
    });
    return result;
  }

  /** 返回节目季，季仅为协议虚拟项。 */
  public async listSeasons(context: EmbyContext, seriesId: string) {
    const series = await this.requireItem(context, decodeItemId(seriesId));
    const children = await this.runtime.repository.listCatalogChildren(series.id, context.ownerUserId);
    const tag = series.posterUrl ? String(Date.parse(series.updatedAt) || 1) : "";
    const seasons = [...new Set(children.map((item) => Math.max(0, Number(item.metadata.seasonNumber ?? 0)))).values()].sort((a, b) => a - b).map((number) => ({ Name: number === 0 ? "特别篇" : `第 ${number} 季`, Id: encodeSeasonId(series.id, number), ServerId: context.serviceId, Type: "Season", IsFolder: true, SeriesId: encodeItemId(series.id), SeriesName: series.title, IndexNumber: number, ParentId: encodeItemId(series.id), ImageTags: tag ? { Primary: tag } : {}, PrimaryImageTag: tag || undefined, PrimaryImageItemId: tag ? encodeItemId(series.id) : undefined, UserData: this.emptyUserData() }));
    return { Items: seasons, TotalRecordCount: seasons.length, StartIndex: 0 };
  }

  /** 返回节目单集，并补全实时详情以保持单集简介一致。 */
  public async listEpisodes(context: EmbyContext, seriesId: string, query: Record<string, unknown>) {
    const seasonRef = decodeSeasonId(seriesId) ?? decodeSeasonId(this.queryString(query, "SeasonId"));
    const rawSeriesId = this.queryString(query, "SeriesId") || seasonRef?.seriesId || decodeItemId(seriesId);
    const series = await this.requireItem(context, decodeItemId(rawSeriesId));
    const requestedSeason = seasonRef?.seasonNumber ?? Number(this.queryString(query, "Season") || this.queryString(query, "SeasonNumber"));
    const useSeason = Number.isFinite(requestedSeason);
    const children = (await this.runtime.repository.listCatalogChildren(series.id, context.ownerUserId)).filter((item) => item.itemType === "video.episode" && (!useSeason || Number(item.metadata.seasonNumber ?? 0) === requestedSeason)).sort((a, b) => Number(a.metadata.seasonNumber ?? 0) - Number(b.metadata.seasonNumber ?? 0) || Number(a.metadata.episodeNumber ?? 0) - Number(b.metadata.episodeNumber ?? 0));
    const hydrated = await Promise.all(children.map((item) => hydrateRealtimeVideoDetails(this.runtime, item)));
    return this.paginate(await this.mapItems(context, hydrated, new Map(hydrated.map((item) => [item.id, series]))), query);
  }

  /** 返回单条详情；路由可直接把该 DTO 返回给 /Users/{id}/Items/{id}。 */
  public async getItem(context: EmbyContext, itemId: string) {
    const item = await this.requireItem(context, decodeItemId(itemId));
    const parent = item.itemType === "video.episode" ? await this.findParent(item.id, context.ownerUserId) : undefined;
    return this.mapItem(context, item, parent);
  }

  /** 按当前 Emby 账户返回收藏媒体及演员虚拟项。 */
  public async listFavoriteItems(context: EmbyContext, query: Record<string, unknown>) {
    const rows = await this.runtime.database.query("service_emby_item_preferences as pref").join("media_items as m", "m.id", "pref.item_id").select("pref.item_id").where({ "pref.service_id": context.serviceId, "pref.account_id": context.accountId }).whereNotNull("pref.starred_at").whereNull("m.deleted_at").orderBy("pref.starred_at", "desc").limit(500);
    const media: Record<string, unknown>[] = [];
    for (const row of rows) { try { media.push(await this.getItem(context, encodeItemId(String(row.item_id)))); } catch { /* 目录变更后忽略已删除条目。 */ } }
    const include = this.queryString(query, "IncludeItemTypes");
    if (!include || include.split(",").includes("Person")) {
      const personRows = await this.runtime.database.query("service_emby_virtual_preferences").select("protocol_item_id").where({ service_id: context.serviceId, account_id: context.accountId, item_type: "Person" }).orderBy("starred_at", "desc").limit(500);
      for (const row of personRows) { const person = await this.getPersonItem(context, String(row.protocol_item_id)); if (person) media.push(person); }
    }
    return this.filterAndPaginate(media, query);
  }

  /** 返回明确已观看的 Emby 条目。 */
  public async listPlayedItems(context: EmbyContext, query: Record<string, unknown>) {
    const rows = await this.runtime.database.query("service_emby_playback_progress as p").join("media_items as m", "m.id", "p.item_id").select("m.id").where({ "p.service_id": context.serviceId, "p.account_id": context.accountId, "p.played": 1 }).whereNull("m.deleted_at").orderBy("p.last_played_at", "desc").limit(500);
    const items: Record<string, unknown>[] = [];
    for (const row of rows) { try { items.push(await this.getItem(context, encodeItemId(String(row.id)))); } catch { /* 扫描移除后跳过。 */ } }
    return this.filterAndPaginate(items, query);
  }

  /** 继续观看只返回未看完且未隐藏的电影/单集。 */
  public async listResume(context: EmbyContext, query: Record<string, unknown>) {
    const rows = await this.runtime.database.query("service_emby_playback_progress as p").join("media_items as m", "m.id", "p.item_id").select("m.id").where({ "p.service_id": context.serviceId, "p.account_id": context.accountId, "p.played": 0, "p.hidden_from_resume": 0 }).where("p.position_ticks", ">", 0).whereNull("m.deleted_at").orderBy("p.updated_at", "desc").limit(500);
    const items: Record<string, unknown>[] = [];
    for (const row of rows) { try { items.push(await this.getItem(context, encodeItemId(String(row.id)))); } catch { /* 删除条目不返回。 */ } }
    return this.paginate(items, query);
  }

  /** 返回播放历史，避免把单纯进度数据误当作历史。 */
  public async listHistory(context: EmbyContext, query: Record<string, unknown>) {
    const rows = await this.runtime.database.query("service_emby_playback_history as h").join("media_items as m", "m.id", "h.item_id").select("m.id").where({ "h.service_id": context.serviceId, "h.account_id": context.accountId }).whereNull("m.deleted_at").orderBy("h.stopped_at", "desc").limit(500);
    const seen = new Set<string>(); const items: Record<string, unknown>[] = [];
    for (const row of rows) { const id = String(row.id); if (seen.has(id)) continue; seen.add(id); try { items.push(await this.getItem(context, encodeItemId(id))); } catch { /* 删除条目不返回。 */ } }
    return this.paginate(items, query);
  }

  /** 返回演员详情，支持演员收藏和演员图片路由。 */
  public async getPersonItem(context: EmbyContext, personId: string): Promise<Record<string, unknown> | null> {
    const person = (await this.loadPersonCache(context)).peopleById.get(personId.toLowerCase());
    if (!person) return null;
    const favorite = await this.isVirtualFavorite(context, person.id);
    return { Name: person.name, Id: person.id, ServerId: context.serviceId, Type: "Person", IsFolder: true, ImageTags: person.imageTag ? { Primary: person.imageTag } : {}, PrimaryImageTag: person.imageTag || undefined, UserData: this.userData(null, 0, favorite, person.id) };
  }

  /** 列出演员，支持 SearchTerm 和分页。 */
  public async listPersons(context: EmbyContext, query: Record<string, unknown>) {
    const search = this.queryString(query, "SearchTerm").toLocaleLowerCase("zh-CN");
    const cache = await this.loadPersonCache(context);
    const items = await Promise.all([...cache.peopleById.values()].filter((person) => !search || person.name.toLocaleLowerCase("zh-CN").includes(search)).sort((a, b) => a.name.localeCompare(b.name, "zh-CN")).map((person) => this.getPersonItem(context, person.id)));
    return this.paginate(items.filter(Boolean) as Record<string, unknown>[], query);
  }

  /** 返回演员关联的电影和节目。 */
  public async listItemsByPerson(context: EmbyContext, personIds: string[], query: Record<string, unknown>) {
    const cache = await this.loadPersonCache(context); const ids = new Set<string>();
    personIds.forEach((personId) => cache.peopleById.get(personId.toLowerCase())?.itemIds.forEach((itemId) => ids.add(itemId)));
    const records: MediaItemRecord[] = [];
    for (const id of ids) { try { const item = await this.requireItem(context, id); if (item.itemType !== "video.episode") records.push(item); } catch { /* 条目已删除。 */ } }
    return this.filterAndPaginate(await this.mapItems(context, records), query);
  }

  /** 返回分类名称，供 Emby 浏览页面使用。 */
  public async listGenres(context: EmbyContext, query: Record<string, unknown>) {
    const library = this.libraryDefinitions(context).find((entry) => entry.id === this.queryString(query, "ParentId"));
    const rowsQuery = this.runtime.database.query("media_items").select("metadata_json").where({ user_id: context.ownerUserId, service_id: context.serviceId, media_type: "video" }).whereIn("item_type", library ? [library.itemType] : ["video.movie", "video.series"]).whereNull("deleted_at");
    if (library?.regionGroup) rowsQuery.where("region_group", library.regionGroup);
    const rows = await rowsQuery;
    const counts = new Map<string, number>();
    rows.forEach((row) => { try { const metadata = JSON.parse(String(row.metadata_json ?? "{}")) as Record<string, unknown>; if (Array.isArray(metadata.genres)) metadata.genres.map((genre) => String(genre).trim()).filter(Boolean).forEach((name) => counts.set(name, (counts.get(name) ?? 0) + 1)); } catch { /* 无效旧元数据不阻断列表。 */ } });
    const items = [...counts.entries()].sort(([a], [b]) => a.localeCompare(b, "zh-CN")).map(([name, count]) => ({ Name: name, Id: protocolUuid("genre", name), Type: "Genre", IsFolder: true, ChildCount: count, RecursiveItemCount: count, UserData: this.emptyUserData() }));
    return this.paginate(items, query);
  }

  /** 返回电影、节目和单集总数。 */
  public async getItemCounts(context: EmbyContext) {
    const rows = await this.runtime.database.query("media_items").select("item_type").count<{ item_type: string; count: string | number }[]>({ count: "id" }).where({ user_id: context.ownerUserId, service_id: context.serviceId, media_type: "video" }).whereNull("deleted_at").groupBy("item_type");
    const counts = new Map(rows.map((row) => [String(row.item_type), Number(row.count ?? 0)]));
    return { MovieCount: counts.get("video.movie") ?? 0, SeriesCount: counts.get("video.series") ?? 0, EpisodeCount: counts.get("video.episode") ?? 0, AlbumCount: 0, SongCount: 0 };
  }

  /** 读取图片来源；路由应代理该 URL，不能把第三方图片地址直接返回客户端。 */
  public async resolveImageSource(context: EmbyLibraryContext, itemId: string, imageType: string): Promise<{ url: string; imageTag: string; updatedAt: string; sourceType: "media" | "person" }> {
    const person = (await this.loadPersonCache(context)).peopleById.get(itemId.toLowerCase());
    if (person && imageType.toLowerCase() === "primary" && person.profileUrl) return { url: person.profileUrl, imageTag: person.imageTag, updatedAt: new Date().toISOString(), sourceType: "person" };
    const season = decodeSeasonId(itemId); const actualItemId = season?.seriesId ?? decodeItemId(itemId);
    const item = await this.runtime.repository.getCatalogItem(actualItemId, context.ownerUserId);
    if (item.serviceId !== context.serviceId) throw new ApiError(404, "emby_image_not_found", "图片条目不存在");
    const type = imageType.toLowerCase(); const url = type === "backdrop" ? String(item.backdropUrl ?? "") : type === "logo" ? String(item.metadata.logoUrl ?? "") : String(item.posterUrl ?? "");
    if (!url) throw new ApiError(404, "emby_image_not_found", "图片不存在");
    return { url, imageTag: imageTag(url), updatedAt: item.updatedAt, sourceType: "media" };
  }

  /** 建立 Emby PlaybackInfo，并登记独立播放会话。 */
  public async buildPlaybackInfo(context: EmbyContext, itemId: string, input: { mediaSourceId?: string; playSessionId?: string; route?: "auto" | "origin" | "server" }) {
    const service = await this.requireEnabledService(context.serviceId); const internalItemId = decodeItemId(itemId); const item = await this.requireItem(context, internalItemId);
    const files = (await this.runtime.repository.listItemFiles(item.id, context.ownerUserId)).filter((file) => String(file.itemId) === item.id);
    if (files.length === 0) throw new ApiError(404, "emby_media_source_not_found", "媒体条目没有可播放文件");
    const requested = this.toInternalMediaSourceId(item.id, input.mediaSourceId ?? "");
    const selectedFiles = requested ? files.filter((file, index) => String(file.fileId) === requested || (index === 0 && requested === item.id)) : files;
    if (requested && selectedFiles.length === 0) throw new ApiError(404, "emby_media_source_not_found", "指定媒体源不存在");
    const playSessionId = input.playSessionId || randomUUID(); const protocolId = encodeItemId(item.id);
    const probes = selectedFiles.map((file) => parseCompletedMediaProbeResult(file.mediaProbeStatus, file.mediaProbeResult)); const ready = probes.every(Boolean); const duration = ready ? readJellyfinRunTimeTicks(probes) : 0;
    const sources = selectedFiles.map((file, index) => {
      const sourceId = index === 0 ? protocolId : String(file.fileId);
      const probe = probes[index]; const route = input.route ?? "auto";
      // 关键变量：部分播放器不会处理 AddApiKeyToDirectStreamUrl，直放地址必须自行携带当前 Emby 会话令牌。
      const query = new URLSearchParams({ static: "true", MediaSourceId: sourceId, PlaySessionId: playSessionId, FlyCloudPlaybackRoute: route, api_key: context.accessToken });
      // 关键变量：Emby 客户端会将相对 /Videos 地址拼接到当前服务器根路径；不能重复写入 /e/{路径}，否则部分播放器会产生双重路径并返回 404。
      const container = probe?.container || "mp4";
      return { Protocol: "File", Id: sourceId, Path: String(file.name ?? "video.mp4"), Name: String(file.name ?? "video.mp4"), Type: "Default", Container: probe?.container || undefined, Size: Number(file.size ?? 0) || undefined, Bitrate: probe?.bitRate || undefined, RunTimeTicks: probe?.runTimeTicks || duration || undefined, MediaStreams: probe?.mediaStreams ?? [], SupportsTranscoding: false, SupportsDirectStream: true, SupportsDirectPlay: true, IsRemote: false, DirectStreamUrl: `/Videos/${protocolId}/stream.${container}?${query.toString()}`, AddApiKeyToDirectStreamUrl: false, RequiredHttpHeaders: {} };
    });
    const now = new Date().toISOString(); const selectedId = this.toInternalMediaSourceId(item.id, String(sources[0]?.Id ?? ""));
    await this.runtime.database.query("service_emby_playback_sessions").insert({ id: playSessionId, service_id: context.serviceId, account_id: context.accountId, item_id: item.id, media_source_id: selectedId || null, status: "created", position_ticks: 0, paused: 0, started_at: now, updated_at: now, stopped_at: null }).onConflict("id").ignore();
    this.runtime.logBusinessEvent("info", { 日志关键字: "codex-emby-playback", 事件: "生成Emby直放信息", 服务ID: context.serviceId, 账号ID: context.accountId, 媒体条目ID: item.id, 媒体源数量: sources.length, 请求播放路由: input.route ?? "auto", 直放相对路径: String(sources[0]?.DirectStreamUrl ?? "").split("?", 1)[0] ?? "", 地址是否携带鉴权: true, 是否允许中转: Number(service.emby_relay_playback_enabled) === 1 });
    return { MediaSources: sources, PlaySessionId: playSessionId, ErrorCode: null };
  }

  /** 接收 /Sessions/Playing、/Progress、/Stopped 并写入 service_emby_* 播放表。 */
  public async reportPlayback(context: EmbyContext, kind: "playing" | "progress" | "stopped", body: Record<string, unknown>): Promise<void> {
    const rawItemId = String(body.ItemId ?? body.itemId ?? ""); if (!rawItemId) return;
    const item = await this.requireItem(context, decodeItemId(rawItemId)); const playSessionId = String(body.PlaySessionId ?? body.playSessionId ?? randomUUID());
    const positionTicks = Math.max(0, Number(body.PositionTicks ?? body.positionTicks ?? 0)); const mediaSourceId = this.toInternalMediaSourceId(item.id, String(body.MediaSourceId ?? body.mediaSourceId ?? ""));
    const durationTicks = await this.readItemRunTimeTicks(item, mediaSourceId); const completed = durationTicks > 0 && positionTicks / durationTicks >= 0.9; const now = new Date().toISOString();
    await this.runtime.database.query.transaction(async (transaction: Knex.Transaction) => {
      const existingSession = await transaction("service_emby_playback_sessions").where({ id: playSessionId, service_id: context.serviceId, account_id: context.accountId }).first();
      const sessionPatch = { item_id: item.id, media_source_id: mediaSourceId || null, status: kind === "stopped" ? "stopped" : kind, position_ticks: positionTicks, paused: body.IsPaused === true || body.isPaused === true ? 1 : 0, updated_at: now, stopped_at: kind === "stopped" ? now : null };
      if (existingSession) await transaction("service_emby_playback_sessions").where({ id: playSessionId }).update(sessionPatch); else await transaction("service_emby_playback_sessions").insert({ id: playSessionId, service_id: context.serviceId, account_id: context.accountId, ...sessionPatch, started_at: now });
      await this.upsertProgress(transaction, context, item.id, mediaSourceId || null, positionTicks, kind === "stopped", completed, now);
      if (kind === "stopped") { const history = await transaction("service_emby_playback_history").where({ service_id: context.serviceId, account_id: context.accountId, play_session_id: playSessionId }).first(); if (!history) await transaction("service_emby_playback_history").insert({ id: randomUUID(), service_id: context.serviceId, account_id: context.accountId, item_id: item.id, play_session_id: playSessionId, position_ticks: positionTicks, completed: completed ? 1 : 0, started_at: existingSession?.started_at ?? now, stopped_at: now }); }
    });
    this.runtime.logBusinessEvent("info", { 日志关键字: "codex-emby-playback", 事件: completed ? "Emby播放进度达到90%自动标记已观看" : "保存Emby播放进度", 服务ID: context.serviceId, 账号ID: context.accountId, 媒体条目ID: item.id, 上报类型: kind, 已观看Ticks: positionTicks, 总时长Ticks: durationTicks });
  }

  /** 手动切换已观看状态。 */
  public async setPlayed(context: EmbyContext, itemId: string, played: boolean) {
    const item = await this.requireItem(context, decodeItemId(itemId)); const now = new Date().toISOString(); const existing = await this.readProgress(context, item.id);
    const patch = { played: played ? 1 : 0, position_ticks: 0, hidden_from_resume: played ? 1 : 0, play_count: played ? Math.max(1, Number(existing?.play_count ?? 0)) : 0, last_played_at: played ? now : existing?.last_played_at ?? null, updated_at: now };
    if (existing) await this.runtime.database.query("service_emby_playback_progress").where({ id: existing.id }).update(patch); else await this.runtime.database.query("service_emby_playback_progress").insert({ id: randomUUID(), service_id: context.serviceId, account_id: context.accountId, item_id: item.id, ...patch });
    return this.userData({ ...existing, ...patch, item_id: item.id }, await this.readItemRunTimeTicks(item), await this.isFavorite(context, item.id), encodeItemId(item.id));
  }

  /** 收藏媒体条目，或收藏 Emby Person 虚拟条目。 */
  public async setFavorite(context: EmbyContext, itemId: string, favorite: boolean) {
    const person = await this.getPersonItem(context, itemId); const now = new Date().toISOString();
    if (person) {
      const existing = await this.runtime.database.query("service_emby_virtual_preferences").where({ service_id: context.serviceId, account_id: context.accountId, protocol_item_id: itemId.toLowerCase() }).first();
      if (favorite && existing) await this.runtime.database.query("service_emby_virtual_preferences").where({ id: existing.id }).update({ starred_at: now, updated_at: now });
      else if (favorite) await this.runtime.database.query("service_emby_virtual_preferences").insert({ id: randomUUID(), service_id: context.serviceId, account_id: context.accountId, protocol_item_id: itemId.toLowerCase(), item_type: "Person", starred_at: now, updated_at: now });
      else if (existing) await this.runtime.database.query("service_emby_virtual_preferences").where({ id: existing.id }).delete();
      return this.userData(null, 0, favorite, itemId);
    }
    const item = await this.requireItem(context, decodeItemId(itemId)); const existing = await this.runtime.database.query("service_emby_item_preferences").where({ service_id: context.serviceId, account_id: context.accountId, item_id: item.id }).first();
    if (favorite && existing) await this.runtime.database.query("service_emby_item_preferences").where({ id: existing.id }).update({ starred_at: now, updated_at: now });
    else if (favorite) await this.runtime.database.query("service_emby_item_preferences").insert({ id: randomUUID(), service_id: context.serviceId, account_id: context.accountId, item_id: item.id, starred_at: now, rating: 0, updated_at: now });
    else if (existing && Number(existing.rating ?? 0) === 0) await this.runtime.database.query("service_emby_item_preferences").where({ id: existing.id }).delete();
    else if (existing) await this.runtime.database.query("service_emby_item_preferences").where({ id: existing.id }).update({ starred_at: null, updated_at: now });
    return this.userData(await this.readProgress(context, item.id), await this.readItemRunTimeTicks(item), favorite, encodeItemId(item.id));
  }

  /** 从继续观看隐藏或恢复项目。 */
  public async setHiddenFromResume(context: EmbyContext, itemId: string, hidden: boolean): Promise<void> {
    const item = await this.requireItem(context, decodeItemId(itemId)); const existing = await this.readProgress(context, item.id); const now = new Date().toISOString();
    if (existing) await this.runtime.database.query("service_emby_playback_progress").where({ id: existing.id }).update({ hidden_from_resume: hidden ? 1 : 0, updated_at: now });
    else await this.runtime.database.query("service_emby_playback_progress").insert({ id: randomUUID(), service_id: context.serviceId, account_id: context.accountId, item_id: item.id, media_source_id: null, position_ticks: 0, played: 0, hidden_from_resume: hidden ? 1 : 0, play_count: 0, last_played_at: null, updated_at: now });
  }

  private libraryDefinitions(context: EmbyLibraryContext): EmbyLibraryDefinition[] {
    const roots: EmbyLibraryDefinition[] = [{ internalId: `${context.libraryId}:movies`, id: protocolUuid("library", `${context.libraryId}:movies`), name: "电影", collectionType: "movies", itemType: "video.movie" }, { internalId: `${context.libraryId}:tvshows`, id: protocolUuid("library", `${context.libraryId}:tvshows`), name: "剧集", collectionType: "tvshows", itemType: "video.series" }];
    if (!context.regionLibrariesEnabled) return roots;
    const regions: Array<[VideoRegionGroup, string]> = [["chinese", "国语"], ["japan_korea", "日韩"], ["europe_america", "欧美"], ["other", "其他"]];
    return roots.flatMap((root) => regions.map(([regionGroup, name]) => ({ ...root, internalId: `${root.internalId}:${regionGroup}`, id: protocolUuid("library", `${root.internalId}:${regionGroup}`), name: `${root.name}-${name}`, regionGroup })));
  }

  private async mapItems(context: EmbyContext, records: MediaItemRecord[], parents = new Map<string, MediaItemRecord | undefined>) { return Promise.all(records.map(async (item) => this.mapItem(context, item, parents.get(item.id) ?? (item.itemType === "video.episode" ? await this.findParent(item.id, context.ownerUserId) : undefined)))); }

  private async mapItem(context: EmbyContext, item: MediaItemRecord, parent?: MediaItemRecord): Promise<Record<string, unknown>> {
    if (item.serviceId !== context.serviceId) throw new ApiError(404, "emby_item_not_found", "媒体条目不存在");
    const files = (await this.runtime.repository.listItemFiles(item.id, context.ownerUserId)).filter((file) => String(file.itemId) === item.id);
    const probes = files.map((file) => parseCompletedMediaProbeResult(file.mediaProbeStatus, file.mediaProbeResult)); const specsReady = files.length > 0 && probes.every(Boolean); const ticks = specsReady ? readJellyfinRunTimeTicks(probes) : 0;
    const type = item.itemType === "video.series" ? "Series" : item.itemType === "video.episode" ? "Episode" : "Movie"; const primaryTag = item.posterUrl ? String(Date.parse(item.updatedAt) || 1) : type === "Episode" && parent?.posterUrl ? String(Date.parse(parent.updatedAt) || 1) : "";
    const ownLogo = String(item.metadata.logoUrl ?? ""); const people = Array.isArray(item.metadata.people) ? item.metadata.people as Array<Record<string, unknown>> : []; const protocolId = encodeItemId(item.id);
    const season = Number(item.metadata.seasonNumber ?? 0); const favorite = await this.isFavorite(context, item.id); const progress = await this.readProgress(context, item.id);
    return { Name: item.title, OriginalTitle: String(item.metadata.originalTitle ?? ""), ServerId: context.serviceId, Id: protocolId, Etag: String(Date.parse(item.updatedAt) || 1), DateCreated: item.createdAt, SortName: item.sortTitle, PremiereDate: item.premiereDate ?? undefined, ProductionYear: item.year ?? undefined, Overview: item.overview, CommunityRating: Number(item.metadata.rating ?? 0) || undefined, Type: type, MediaType: "Video", IsFolder: type === "Series", LocationType: "FileSystem", CanDownload: context.downloadEnabled && type !== "Series" && files.length > 0, ProviderIds: mapProviderIds(item.externalIds), Genres: Array.isArray(item.metadata.genres) ? item.metadata.genres.map(String) : [], ImageTags: { ...(primaryTag ? { Primary: primaryTag } : {}), ...(ownLogo ? { Logo: imageTag(ownLogo) } : {}) }, PrimaryImageTag: primaryTag || undefined, PrimaryImageItemId: item.posterUrl ? protocolId : parent?.posterUrl ? encodeItemId(parent.id) : undefined, BackdropImageTags: item.backdropUrl ? [String(Date.parse(item.updatedAt) || 1)] : [], RunTimeTicks: ticks || undefined, Container: probes[0]?.container || undefined, Bitrate: probes[0]?.bitRate || undefined, MediaStreams: probes[0]?.mediaStreams ?? [], MediaSources: files.map((file, index) => ({ Protocol: "File", Id: index === 0 ? protocolId : String(file.fileId), Path: String(file.name ?? "video.mp4"), Name: String(file.name ?? "video.mp4"), Type: "Default", Size: Number(file.size ?? 0) || undefined, Container: probes[index]?.container || undefined, SupportsTranscoding: false, SupportsDirectStream: true, SupportsDirectPlay: true })), SeriesId: type === "Episode" && parent ? encodeItemId(parent.id) : undefined, SeriesName: type === "Episode" ? parent?.title ?? item.subtitle : undefined, ParentIndexNumber: type === "Episode" ? season : undefined, IndexNumber: type === "Episode" ? Number(item.metadata.episodeNumber ?? 0) : undefined, SeasonId: type === "Episode" && parent ? encodeSeasonId(parent.id, season) : undefined, SeasonName: type === "Episode" ? season === 0 ? "特别篇" : `第 ${season} 季` : undefined, ParentId: type === "Episode" && parent ? encodeSeasonId(parent.id, season) : this.libraryForItem(context, item).id, People: people.map((person) => { const name = String(person.name ?? "").trim(); const profile = String(person.profileUrl ?? "").trim(); return { Name: name, Id: this.personId(person), Role: String(person.role ?? ""), Type: String(person.type ?? "").toLowerCase() === "cast" ? "Actor" : "Unknown", PrimaryImageTag: profile ? imageTag(profile) : undefined }; }), UserData: this.userData(progress, ticks, favorite, protocolId), DatePlayed: progress?.last_played_at ?? undefined };
  }

  private libraryForItem(context: EmbyLibraryContext, item: MediaItemRecord): EmbyLibraryDefinition { const roots = this.libraryDefinitions(context); return roots.find((entry) => entry.itemType === (item.itemType === "video.movie" ? "video.movie" : "video.series") && entry.regionGroup === (context.regionLibrariesEnabled ? item.regionGroup : undefined)) ?? roots[0]!; }
  private personId(person: Record<string, unknown>): string { const source = String(person.id ?? "").trim(); const name = String(person.name ?? "").trim(); return protocolUuid("person", source ? `source:${source}` : `name:${name}`).toLowerCase(); }
  private async requireItem(context: EmbyLibraryContext, itemId: string): Promise<MediaItemRecord> { const item = await this.runtime.repository.getCatalogItem(itemId, context.ownerUserId); if (item.serviceId !== context.serviceId) throw new ApiError(404, "emby_item_not_found", "媒体条目不存在"); return item; }
  private async findParent(itemId: string, userId: string) { const relation = await this.runtime.database.query("media_relations").where({ child_item_id: itemId }).first(); return relation ? this.runtime.repository.getCatalogItem(String(relation.parent_item_id), userId) : undefined; }
  private async readProgress(context: EmbyContext, itemId: string) { return this.runtime.database.query("service_emby_playback_progress").where({ service_id: context.serviceId, account_id: context.accountId, item_id: itemId }).first(); }
  private async isFavorite(context: EmbyContext, itemId: string) { return Boolean(await this.runtime.database.query("service_emby_item_preferences").select("id").where({ service_id: context.serviceId, account_id: context.accountId, item_id: itemId }).whereNotNull("starred_at").first()); }
  private async isVirtualFavorite(context: EmbyContext, itemId: string) { return Boolean(await this.runtime.database.query("service_emby_virtual_preferences").select("id").where({ service_id: context.serviceId, account_id: context.accountId, protocol_item_id: itemId.toLowerCase() }).first()); }
  private emptyUserData() { return this.userData(null, 0, false); }
  private userData(progress: Record<string, unknown> | null | undefined, runTimeTicks: number, favorite: boolean, protocolItemId?: string) { const played = Number(progress?.played ?? 0) === 1; const position = played ? 0 : Number(progress?.position_ticks ?? 0); const source = String(progress?.media_source_id ?? ""); return { PlaybackPositionTicks: position, PlayCount: Number(progress?.play_count ?? 0), IsFavorite: favorite, Played: played, LastPlayedDate: progress?.last_played_at ?? undefined, PlayedPercentage: runTimeTicks > 0 && position > 0 ? position / runTimeTicks * 100 : undefined, Key: "", ItemId: protocolItemId, MediaSourceId: source ? (INTERNAL_ITEM_ID_PATTERN.test(source) ? encodeItemId(source) : source) : undefined }; }
  private async readItemRunTimeTicks(item: MediaItemRecord, mediaSourceId?: string) { const files = (await this.runtime.repository.listItemFiles(item.id, item.userId)).filter((file) => String(file.itemId) === item.id); const probes = files.map((file) => parseCompletedMediaProbeResult(file.mediaProbeStatus, file.mediaProbeResult)); if (files.length === 0 || probes.some((probe) => !probe)) return 0; if (mediaSourceId) { const index = mediaSourceId === item.id ? 0 : files.findIndex((file) => String(file.fileId) === mediaSourceId); return index >= 0 ? probes[index]?.runTimeTicks ?? 0 : 0; } return readJellyfinRunTimeTicks(probes); }
  private async upsertProgress(transaction: Knex | Knex.Transaction, context: EmbyContext, itemId: string, mediaSourceId: string | null, position: number, stopped: boolean, completed: boolean, now: string) { const existing = await transaction("service_emby_playback_progress").where({ service_id: context.serviceId, account_id: context.accountId, item_id: itemId }).first(); const alreadyPlayed = Number(existing?.played ?? 0) === 1; const newlyCompleted = completed && !alreadyPlayed; const playCount = newlyCompleted ? Math.max(1, Number(existing?.play_count ?? 0)) : Number(existing?.play_count ?? 0) + (stopped && !completed ? 1 : 0); const patch = { media_source_id: mediaSourceId ?? existing?.media_source_id ?? null, position_ticks: completed ? 0 : position, played: completed || alreadyPlayed ? 1 : 0, hidden_from_resume: completed || alreadyPlayed ? 1 : 0, last_played_at: now, updated_at: now, play_count: playCount }; if (existing) await transaction("service_emby_playback_progress").where({ id: existing.id }).update(patch); else await transaction("service_emby_playback_progress").insert({ id: randomUUID(), service_id: context.serviceId, account_id: context.accountId, item_id: itemId, ...patch }); }
  private async loadPersonCache(context: EmbyLibraryContext): Promise<EmbyPersonCache> { const cacheKey = `${context.serviceId}:${context.libraryId}`; const version = Number((await this.runtime.database.query("media_libraries").select("catalog_version").where({ id: context.libraryId }).first())?.catalog_version ?? 0); const cached = this.personCaches.get(cacheKey); if (cached?.catalogVersion === version) return cached; const records = (await Promise.all(["video.movie", "video.series"].map(async (itemType) => (await this.runtime.repository.listCatalogItems({ userId: context.ownerUserId, serviceId: context.serviceId, mediaType: "video", itemType, sort: "updated_desc", limit: 5000, offset: 0, includeFileCounts: false })).items))).flat(); const peopleById = new Map<string, EmbyPersonSummary>(); for (const item of records) { const people = Array.isArray(item.metadata.people) ? item.metadata.people as Array<Record<string, unknown>> : []; for (const raw of people) { const name = String(raw.name ?? "").trim(); if (!name) continue; const id = this.personId(raw); const entry = peopleById.get(id) ?? { id, name, profileUrl: String(raw.profileUrl ?? "").trim(), imageTag: String(raw.profileUrl ?? "").trim() ? imageTag(String(raw.profileUrl)) : "", itemIds: new Set<string>() }; entry.itemIds.add(item.id); peopleById.set(id, entry); } } const next = { catalogVersion: version, peopleById }; this.personCaches.set(cacheKey, next); return next; }
  private queryString(query: Record<string, unknown>, key: string): string { const camel = `${key.charAt(0).toLowerCase()}${key.slice(1)}`; return String(query[key] ?? query[camel] ?? "").trim(); }
  private readSort(query: Record<string, unknown>): CatalogSort { const sort = this.queryString(query, "SortBy").toLowerCase(); const desc = this.queryString(query, "SortOrder").toLowerCase() === "descending"; if (sort.includes("productionyear")) return desc ? "year_desc" : "year_asc"; if (sort.includes("premieredate")) return desc ? "premiere_date_desc" : "premiere_date_asc"; if (sort.includes("sortname") || sort.includes("name")) return desc ? "title_desc" : "title_asc"; return desc || !sort ? "created_desc" : "created_asc"; }
  private paginate<T>(items: T[], query: Record<string, unknown>) { const start = Math.max(0, Number(this.queryString(query, "StartIndex") || 0)); const limit = Math.min(500, Math.max(1, Number(this.queryString(query, "Limit") || items.length || 100))); return { Items: items.slice(start, start + limit), TotalRecordCount: items.length, StartIndex: start }; }
  private filterAndPaginate(items: Record<string, unknown>[], query: Record<string, unknown>) { const favorite = this.queryString(query, "IsFavorite") === "true" || this.queryString(query, "Filters").split(",").includes("IsFavorite"); const played = this.queryString(query, "IsPlayed") === "true" || this.queryString(query, "Filters").split(",").includes("IsPlayed"); return this.paginate(items.filter((item) => (!favorite || Boolean((item.UserData as Record<string, unknown> | undefined)?.IsFavorite)) && (!played || Boolean((item.UserData as Record<string, unknown> | undefined)?.Played))), query); }
  private requireLoginAllowed(key: string) { const value = this.loginFailures.get(key); if (value && value.blockedUntil > Date.now()) throw new ApiError(429, "emby_login_rate_limited", "登录失败次数过多，请稍后再试"); }
  private recordLoginFailure(key: string) { const now = Date.now(); const old = this.loginFailures.get(key); const next = !old || now - old.firstFailedAt > 10 * 60 * 1000 ? { count: 1, firstFailedAt: now, blockedUntil: 0 } : { ...old, count: old.count + 1 }; if (next.count >= 8) next.blockedUntil = now + 15 * 60 * 1000; this.loginFailures.set(key, next); return next.blockedUntil; }
}
