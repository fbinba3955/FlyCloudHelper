import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ApiError } from "../errors.js";
import { buildJellyfinPath } from "../jellyfin-path.js";
import { parseCompletedMediaProbeResult, readJellyfinRunTimeTicks } from "../media/media-probe.js";
import { JellyfinCompatibilityService, type JellyfinContext, type JellyfinLibraryContext } from "../jellyfin-service.js";
import { providerFetch, providerStream } from "../providers/network.js";
import type { ProviderConnectionContext } from "../providers/types.js";
import type { ApiRuntime } from "../runtime.js";
import { buildUpstreamHeaders, copyMediaResponseHeaders, resolveRelayAccess, type RelayLibraryRow } from "./media-stream-routes.js";

/** 统一读取任意 Jellyfin 查询参数。 */
function readQuery(request: FastifyRequest): Record<string, unknown> {
  return (request.query ?? {}) as Record<string, unknown>;
}

/** 读取 Jellyfin 官方小驼峰写法和旧客户端大驼峰写法的媒体源 ID。 */
function readMediaSourceId(request: FastifyRequest): string {
  const query = readQuery(request);
  return String(query.mediaSourceId ?? query.MediaSourceId ?? "");
}

/** 确认 URL 中的用户 ID 就是当前服务访问账号。 */
function requireProtocolUser(context: JellyfinContext, userId: string): void {
  if (userId !== context.accountId) throw new ApiError(403, "jellyfin_user_scope_mismatch", "不能访问其他服务账号的数据");
}

/** 把服务数据库行转换为媒体中转公共上下文。 */
function toRelayLibrary(service: Record<string, unknown>): RelayLibraryRow {
  return {
    id: String(service.library_id), service_id: String(service.id), provider_type: String(service.provider_type),
    service_status: String(service.status), relay_playback_enabled: service.relay_playback_enabled as number,
    credential_revision: Number(service.credential_revision),
  };
}

/** 读取播放路由偏好；标准 Jellyfin 客户端默认自动选择安全原始地址或服务端直放。 */
function readPlaybackRoute(request: FastifyRequest): "auto" | "server" | "origin" {
  const value = String(request.headers["x-flycloud-playback-route"] ?? readQuery(request).FlyCloudPlaybackRoute ?? "auto").toLowerCase();
  if (value === "server" || value === "origin") return value;
  if (value === "auto") return value;
  return "auto";
}

/** 生成 Jellyfin 标准 MediaSourceInfo 的公共默认字段。 */
function buildStandardMediaSourceDefaults(): Record<string, unknown> {
  return {
    EncoderPath: null,
    EncoderProtocol: null,
    ETag: null,
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
    MediaStreams: [],
    MediaAttachments: [],
    Formats: [],
    RequiredHttpHeaders: {},
    TranscodingUrl: null,
    TranscodingSubProtocol: null,
    TranscodingContainer: null,
    AnalyzeDurationMs: null,
    DefaultAudioStreamIndex: null,
    DefaultSubtitleStreamIndex: null,
  };
}

/** 解析文件访问地址，并在 Provider 刷新令牌时安全持久化。 */
async function resolveFileAccess(runtime: ApiRuntime, service: Record<string, unknown>, ownerUserId: string, locator: Record<string, unknown>, signal: AbortSignal) {
  const adapter = runtime.providers.get(String(service.provider_type));
  const connection = runtime.vault.decrypt(await runtime.repository.getActiveEncryptedConnection(String(service.id), ownerUserId));
  const providerContext: ProviderConnectionContext = {
    persistConnection: async (nextConnection) => runtime.repository.refreshActiveEncryptedConnection({
      serviceId: String(service.id), userId: ownerUserId, credentialRevision: Number(service.credential_revision),
      encryptedConnection: runtime.vault.encrypt(nextConnection),
    }),
  };
  if (adapter.resolveFileAccess) return adapter.resolveFileAccess(connection, locator, signal, providerContext);
  return null;
}

/** 生成不包含转码能力的 PlaybackInfo。 */
async function buildPlaybackInfo(runtime: ApiRuntime, compatibility: JellyfinCompatibilityService, context: JellyfinContext, request: FastifyRequest, itemId: string) {
  const service = await compatibility.requireEnabledService(context.serviceId);
  const item = await runtime.repository.getCatalogItem(itemId, context.ownerUserId);
  if (item.serviceId !== context.serviceId) throw new ApiError(404, "jellyfin_item_not_found", "媒体条目不存在");
  const files = await runtime.repository.listItemFiles(itemId, context.ownerUserId);
  const requestedSource = readMediaSourceId(request);
  // 关键变量：节目查询可能连带返回所有单集文件，PlaybackInfo 只能暴露当前电影或单集自身的多版本文件。
  const itemFiles = files.filter((candidate) => String(candidate.itemId) === itemId);
  const playableFiles = itemFiles;
  const requestedFile = requestedSource
    ? playableFiles.find((candidate) => String(candidate.fileId) === requestedSource)
    : undefined;
  if (requestedSource && !requestedFile) throw new ApiError(404, "jellyfin_media_source_not_found", "指定媒体源不存在");
  // 客户端带 MediaSourceId 重试时只解析指定版本；首次请求则返回当前条目的全部实际文件版本。
  const candidateFiles = requestedFile ? [requestedFile] : playableFiles;
  if (candidateFiles.length === 0) throw new ApiError(404, "jellyfin_media_source_not_found", "媒体条目没有可播放文件");
  const preference = readPlaybackRoute(request);
  const itemMediaProbes = itemFiles.map((file) => (
    context.mediaSpecsEnabled
      ? parseCompletedMediaProbeResult(file.mediaProbeStatus, file.mediaProbeResult)
      : null
  ));
  // 关键变量：多版本影片必须所有实际文件都完成分析，PlaybackInfo 才能返回任何规格字段。
  const mediaSpecsReady = context.mediaSpecsEnabled
    && itemFiles.length > 0
    && itemMediaProbes.every((probe) => probe !== null);
  const mediaProbeByFileId = new Map(itemFiles.map((file, index) => [
    String(file.fileId),
    mediaSpecsReady ? itemMediaProbes[index] ?? null : null,
  ]));
  const runTimeTicks = mediaSpecsReady ? readJellyfinRunTimeTicks(itemMediaProbes) : 0;
  const routeNames = new Set<string>();
  const mediaSources: Array<Record<string, unknown>> = [];
  for (const file of candidateFiles) {
    const locator = (file.playbackLocator && typeof file.playbackLocator === "object" ? file.playbackLocator : {}) as Record<string, unknown>;
    // 强制服务器直放时无需提前向网盘申请临时地址，真正开流时再解析，减少无效 Provider 调用。
    const access = preference === "server"
      ? null
      : await resolveFileAccess(runtime, service, context.ownerUserId, locator, new AbortController().signal);
    // 只有无鉴权头的 HTTP(S) 地址才允许发给客户端，避免泄漏网盘凭据。
    const safeOriginUrl = access && Object.keys(access.headers).length === 0 && /^https?:\/\//iu.test(access.url) ? access.url : null;
    if (preference === "origin" && !safeOriginUrl) continue;
    const useOrigin = preference === "origin" || (preference === "auto" && Boolean(safeOriginUrl));
    const fileName = String(file.name ?? "video.mp4");
    const mediaProbe = mediaProbeByFileId.get(String(file.fileId)) ?? null;
    const directStreamUrl = useOrigin
      ? safeOriginUrl
      : `/Videos/${encodeURIComponent(itemId)}/stream?static=true&mediaSourceId=${encodeURIComponent(String(file.fileId))}`;
    routeNames.add(useOrigin ? "原始地址" : "服务器");
    mediaSources.push({
      ...buildStandardMediaSourceDefaults(),
      // 关键变量：服务器中转在 Jellyfin 中按服务端文件处理；安全原始地址才属于远程 HTTP 媒体源。
      Protocol: useOrigin ? "Http" : "File", Id: String(file.fileId), Path: useOrigin ? safeOriginUrl : fileName,
      Type: "Default", Container: mediaProbe?.container || undefined, Size: mediaProbe?.size || undefined, Name: fileName,
      Bitrate: mediaProbe?.bitRate || undefined,
      IsRemote: useOrigin,
      DirectStreamUrl: directStreamUrl, AddApiKeyToDirectStreamUrl: !useOrigin,
      RunTimeTicks: mediaProbe?.runTimeTicks || runTimeTicks || undefined,
      MediaStreams: mediaProbe?.mediaStreams ?? [],
    });
  }
  if (mediaSources.length === 0 && preference === "origin") {
    throw new ApiError(409, "jellyfin_origin_direct_unavailable", "当前文件不能安全下发原始地址，请改用服务器直放");
  }
  if (mediaSources.length === 0) throw new ApiError(409, "jellyfin_direct_play_unavailable", "当前媒体文件没有可用的直放地址");
  const playbackQuery = readQuery(request);
  const playSessionId = String(playbackQuery.playSessionId ?? playbackQuery.PlaySessionId ?? "") || randomUUID();
  const selectedSourceId = requestedSource || String(mediaSources[0]?.Id ?? "");
  const now = new Date().toISOString();
  // PlaybackInfo 先登记 created 会话；Playing、Progress、Stopped 将在相同会话上继续更新。
  await runtime.database.query("service_playback_sessions").insert({
    id: playSessionId, service_id: context.serviceId, account_id: context.accountId, item_id: itemId,
    media_source_id: selectedSourceId || null, status: "created", position_ticks: 0, paused: 0,
    started_at: now, updated_at: now, stopped_at: null,
  }).onConflict("id").ignore();
  runtime.logBusinessEvent("info", {
    日志关键字: "codex-jellyfin-compat", 事件: "生成Jellyfin直放信息", 服务ID: context.serviceId,
    媒体条目ID: itemId, 播放路由: [...routeNames].join("+"), 路由偏好: preference, 媒体源数量: mediaSources.length,
    规格分析开关: context.mediaSpecsEnabled,
    影片规格是否全部完成: mediaSpecsReady,
    包含已完成规格媒体源数量: candidateFiles.filter((file) => mediaProbeByFileId.get(String(file.fileId)) !== null).length,
  });
  return {
    MediaSources: mediaSources, PlaySessionId: playSessionId, ErrorCode: null,
  };
}

/** 通过 Jellyfin 图片接口代理媒体库已经保存的公开 HTTP 图片。 */
async function sendItemImage(compatibility: JellyfinCompatibilityService, context: JellyfinLibraryContext, request: FastifyRequest, reply: FastifyReply, itemId: string, imageType: string) {
  const item = await compatibility.resolveImageItem(context, itemId, imageType);
  const rawUrl = imageType.toLowerCase() === "backdrop" ? item.backdropUrl : item.posterUrl;
  if (!rawUrl) throw new ApiError(404, "jellyfin_image_not_found", "图片不存在");
  let imageUrl: URL;
  try { imageUrl = new URL(rawUrl); } catch { throw new ApiError(404, "jellyfin_image_not_found", "图片地址不可用"); }
  if (imageUrl.protocol !== "https:" && imageUrl.protocol !== "http:") {
    throw new ApiError(422, "jellyfin_image_source_unsupported", "当前图片来源暂不支持协议代理");
  }
  const imageTag = String(Date.parse(item.updatedAt) || 1);
  const responseEtag = `"${imageTag}"`;
  reply.header("ETag", responseEtag);
  reply.header("Last-Modified", new Date(item.updatedAt).toUTCString());
  if (request.headers["if-none-match"] === responseEtag) return reply.status(304).send();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await providerFetch(imageUrl, { method: request.method === "HEAD" ? "HEAD" : "GET" }, {
      // 图片 URL 已经是媒体库元数据的一部分；协议层同时兼容 NFO 中常见的 HTTP 图片地址。
      allowInsecureHttp: true,
    }, controller.signal);
    if (!response.ok) throw new ApiError(502, "jellyfin_image_upstream_failed", "图片服务暂时不可用");
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > 20 * 1024 * 1024) throw new ApiError(413, "jellyfin_image_too_large", "图片文件过大");
    const contentType = response.headers.get("content-type") ?? "image/jpeg";
    if (!contentType.toLowerCase().startsWith("image/")) throw new ApiError(502, "jellyfin_image_content_invalid", "图片服务返回了非图片内容");
    reply.header("Content-Type", contentType);
    reply.header("Cache-Control", "private, max-age=86400");
    if (length > 0) reply.header("Content-Length", length);
    if (request.method === "HEAD") return reply.send();
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > 20 * 1024 * 1024) throw new ApiError(413, "jellyfin_image_too_large", "图片文件过大");
    return reply.send(body);
  } finally { clearTimeout(timer); }
}

/** 将 Provider 原始媒体流转发给 Jellyfin 客户端。 */
async function sendMediaStream(runtime: ApiRuntime, compatibility: JellyfinCompatibilityService, context: JellyfinContext, request: FastifyRequest, reply: FastifyReply, itemId: string) {
  const service = await compatibility.requireEnabledService(context.serviceId);
  // Jellyfin 的标准 Videos 接口本身就是服务端媒体入口，不受 APP 专用中转开关限制。
  const item = await runtime.repository.getCatalogItem(itemId, context.ownerUserId);
  if (item.serviceId !== context.serviceId) throw new ApiError(404, "jellyfin_item_not_found", "媒体条目不存在");
  const files = await runtime.repository.listItemFiles(itemId, context.ownerUserId);
  const fileId = readMediaSourceId(request);
  const itemFiles = files.filter((candidate) => String(candidate.itemId) === itemId);
  const file = fileId ? itemFiles.find((candidate) => String(candidate.fileId) === fileId) : itemFiles[0];
  if (!file) throw new ApiError(404, "jellyfin_media_source_not_found", "媒体源不存在");
  const abortController = new AbortController();
  const abort = () => abortController.abort();
  request.raw.once("aborted", abort); reply.raw.once("close", abort);
  let upstreamBody: IncomingMessage | null = null;
  try {
    const access = await resolveRelayAccess(runtime, toRelayLibrary(service), context.ownerUserId,
      (file.playbackLocator ?? {}) as Record<string, unknown>, abortController.signal);
    const upstream = await providerStream(access.url, { method: request.method, headers: buildUpstreamHeaders(request, access.headers) }, {
      allowInsecureHttp: runtime.config.allowInsecureProviderHttp,
      logConnectionFailure: (fields) => runtime.logBusinessEvent("warn", fields),
    }, abortController.signal);
    upstreamBody = upstream.body;
    copyMediaResponseHeaders(reply, upstream.headers);
    reply.status(upstream.statusCode);
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-jellyfin-compat", 事件: "建立Jellyfin服务器直放连接", 服务ID: context.serviceId,
      媒体条目ID: itemId, 源文件ID: String(file.fileId), 是否Range请求: Boolean(request.headers.range), 上游状态码: upstream.statusCode,
    });
    return reply.send(upstream.body);
  } finally {
    if (!upstreamBody) { request.raw.removeListener("aborted", abort); reply.raw.removeListener("close", abort); }
  }
}

/**
 * 返回客户端可访问的 Jellyfin 服务地址。
 * 显式配置的公开地址用于覆盖反向代理、HTTPS 域名或端口映射；未配置时使用当前请求的协议和 Host。
 */
async function buildJellyfinLocalAddress(runtime: ApiRuntime, request: FastifyRequest, pathSuffix: string): Promise<string> {
  const configuredUrl = await runtime.publicAccess.buildJellyfinUrl(pathSuffix);
  if (configuredUrl) return configuredUrl;
  // 关键变量：反向代理后的协议和主机优先使用标准转发头，直接访问时再使用 Fastify 当前请求值。
  const forwardedProtocol = String(request.headers["x-forwarded-proto"] ?? "").split(",", 1)[0]?.trim().toLowerCase();
  const forwardedHost = String(request.headers["x-forwarded-host"] ?? "").split(",", 1)[0]?.trim();
  const requestProtocol = forwardedProtocol === "http" || forwardedProtocol === "https" ? forwardedProtocol : request.protocol;
  /** Host 保留当前请求实际使用的端口，适用于直接访问云助手 API 的场景。 */
  const requestHost = forwardedHost || String(request.headers.host ?? "").trim();
  const jellyfinPath = buildJellyfinPath(pathSuffix);
  if (!requestHost) return jellyfinPath;
  try {
    return `${new URL(`${requestProtocol}://${requestHost}`).origin}${jellyfinPath}`;
  } catch {
    return jellyfinPath;
  }
}

/** 注册一个 API 前缀；同时支持标准 Jellyfin 根路径和 Flymby 使用的 /emby 路径。 */
function registerProtocolPrefix(server: FastifyInstance, runtime: ApiRuntime, compatibility: JellyfinCompatibilityService, prefix: string): void {
  /** 读取路由中的单层自定义后缀。 */
  const readPathSuffix = (request: FastifyRequest): string => String((request.params as { jellyfinPathSuffix: string }).jellyfinPathSuffix);
  /** 使用自定义后缀找到真实服务 ID。 */
  const resolveServiceId = async (request: FastifyRequest): Promise<string> => compatibility.resolveServiceIdByPathSuffix(readPathSuffix(request));
  const authenticated = async (request: FastifyRequest) => compatibility.authenticate(await resolveServiceId(request), request);
  /** 图片读取按 Jellyfin 标准不要求客户端图片组件附带访问令牌。 */
  const publicImageContext = async (request: FastifyRequest) => compatibility.resolvePublicImageContext(await resolveServiceId(request));
  server.get(`${prefix}/System/Info/Public`, async (request) => {
    const serviceId = await resolveServiceId(request);
    const service = await compatibility.requireEnabledService(serviceId);
    return { LocalAddress: await buildJellyfinLocalAddress(runtime, request, readPathSuffix(request)), ServerName: service.display_name, Version: "10.10.0", ProductName: "FlyCloudHelper", OperatingSystem: process.platform, Id: serviceId, StartupWizardCompleted: true };
  });
  server.get(`${prefix}/System/Info`, async (request) => {
    const context = await authenticated(request); const service = await compatibility.requireEnabledService(context.serviceId);
    return { LocalAddress: await buildJellyfinLocalAddress(runtime, request, readPathSuffix(request)), ServerName: service.display_name, Version: "10.10.0", ProductName: "FlyCloudHelper", OperatingSystem: process.platform, Id: context.serviceId, StartupWizardCompleted: true };
  });
  server.post(`${prefix}/Users/AuthenticateByName`, async (request) => compatibility.login(await resolveServiceId(request), request, (request.body ?? {}) as Record<string, unknown>));
  server.post(`${prefix}/Sessions/Logout`, async (request, reply) => { await compatibility.logout(await resolveServiceId(request), request); return reply.status(204).send(); });
  server.get(`${prefix}/Users/:userId`, async (request) => { const context = await authenticated(request); requireProtocolUser(context, String((request.params as { userId: string }).userId)); return compatibility.mapUser(context.accountId, context.accountUsername, context.serviceId, context.accountHasPassword); });
  server.get(`${prefix}/Users/:userId/Views`, async (request) => { const context = await authenticated(request); requireProtocolUser(context, String((request.params as { userId: string }).userId)); return compatibility.listLibraries(context); });
  server.get(`${prefix}/UserViews`, async (request) => compatibility.listLibraries(await authenticated(request)));
  server.get(`${prefix}/Users/:userId/Items/Resume`, async (request) => { const context = await authenticated(request); requireProtocolUser(context, String((request.params as { userId: string }).userId)); return compatibility.listResume(context, readQuery(request)); });
  server.get(`${prefix}/Users/:userId/Items/Latest`, async (request) => { const context = await authenticated(request); requireProtocolUser(context, String((request.params as { userId: string }).userId)); const result = await compatibility.listItems(context, { ...readQuery(request), SortBy: "DateCreated", SortOrder: "Descending" }); return result.Items; });
  server.get(`${prefix}/Users/:userId/Items/:itemId`, async (request) => { const context = await authenticated(request); const params = request.params as { userId: string; itemId: string }; requireProtocolUser(context, params.userId); const item = await runtime.repository.getCatalogItem(params.itemId, context.ownerUserId); const parent = item.itemType === "video.episode" ? await runtime.database.query("media_relations").where({ child_item_id: item.id }).first() : null; return compatibility.mapItem(context, item, parent ? await runtime.repository.getCatalogItem(String(parent.parent_item_id), context.ownerUserId) : undefined); });
  server.get(`${prefix}/Users/:userId/Items`, async (request) => { const context = await authenticated(request); requireProtocolUser(context, String((request.params as { userId: string }).userId)); const query = readQuery(request); return String(query.SortBy ?? "").includes("DatePlayed") || String(query.Filters ?? "").includes("IsPlayed") ? compatibility.listHistory(context, query) : compatibility.listItems(context, query); });
  server.get(`${prefix}/Users/:userId/Items/:itemId/UserData`, async (request) => { const context = await authenticated(request); const params = request.params as { userId: string; itemId: string }; requireProtocolUser(context, params.userId); return compatibility.getUserData(context, params.itemId); });
  server.post(`${prefix}/Users/:userId/Items/:itemId/UserData`, async (request) => { const context = await authenticated(request); const params = request.params as { userId: string; itemId: string }; requireProtocolUser(context, params.userId); return compatibility.updateUserData(context, params.itemId, (request.body ?? {}) as Record<string, unknown>); });
  server.get(`${prefix}/Items/Counts`, async (request) => compatibility.getItemCounts(await authenticated(request)));
  server.get(`${prefix}/Items/:itemId/Similar`, async (request) => compatibility.listSimilar(await authenticated(request), String((request.params as { itemId: string }).itemId), readQuery(request)));
  server.get(`${prefix}/Items/:itemId`, async (request) => { const context = await authenticated(request); const item = await runtime.repository.getCatalogItem(String((request.params as { itemId: string }).itemId), context.ownerUserId); return compatibility.mapItem(context, item); });
  server.get(`${prefix}/Items`, async (request) => compatibility.listItems(await authenticated(request), readQuery(request)));
  server.get(`${prefix}/Items/:itemId/Ancestors`, async (request) => {
    const context = await authenticated(request);
    const item = await runtime.repository.getCatalogItem(String((request.params as { itemId: string }).itemId), context.ownerUserId);
    if (item.serviceId !== context.serviceId) throw new ApiError(404, "jellyfin_item_not_found", "媒体条目不存在");
    if (item.itemType !== "video.episode") return [compatibility.mapItemLibrary(context, item)];
    const relation = await runtime.database.query("media_relations").where({ child_item_id: item.id }).first();
    if (!relation) return [compatibility.mapItemLibrary(context, item)];
    const parent = await runtime.repository.getCatalogItem(String(relation.parent_item_id), context.ownerUserId);
    return [compatibility.mapItemLibrary(context, parent), await compatibility.mapItem(context, parent)];
  });
  server.get(`${prefix}/Genres`, async (request) => compatibility.listGenres(await authenticated(request), readQuery(request)));
  server.get(`${prefix}/Search/Hints`, async (request) => { const context = await authenticated(request); const result = await compatibility.listItems(context, { ...readQuery(request), SearchTerm: readQuery(request).SearchTerm, Limit: readQuery(request).Limit ?? 50 }); return { SearchHints: result.Items.map((item: Record<string, unknown>) => ({ ItemId: item.Id, Id: item.Id, Name: item.Name, Type: item.Type, ProductionYear: item.ProductionYear, PrimaryImageTag: (item.ImageTags as Record<string, unknown>)?.Primary })), TotalRecordCount: result.TotalRecordCount }; });
  server.get(`${prefix}/Shows/:seriesId/Seasons`, async (request) => compatibility.listSeasons(await authenticated(request), String((request.params as { seriesId: string }).seriesId)));
  server.get(`${prefix}/Shows/:seriesId/Episodes`, async (request) => compatibility.listEpisodes(await authenticated(request), String((request.params as { seriesId: string }).seriesId), readQuery(request)));
  server.get(`${prefix}/Shows/NextUp`, async (request) => compatibility.listNextUp(await authenticated(request), readQuery(request)));
  server.route({ method: ["GET", "POST"], url: `${prefix}/Items/:itemId/PlaybackInfo`, handler: async (request) => buildPlaybackInfo(runtime, compatibility, await authenticated(request), request, String((request.params as { itemId: string }).itemId)) });
  // 官方 Jellyfin 使用 /Videos；Fastify 已按 Jellyfin 行为配置为大小写不敏感，Flymby 的 /videos 同样命中。
  server.route({ method: ["GET", "HEAD"], url: `${prefix}/Videos/:itemId/stream.:container`, handler: async (request, reply) => sendMediaStream(runtime, compatibility, await authenticated(request), request, reply, String((request.params as { itemId: string }).itemId)) });
  server.route({ method: ["GET", "HEAD"], url: `${prefix}/Videos/:itemId/stream`, handler: async (request, reply) => sendMediaStream(runtime, compatibility, await authenticated(request), request, reply, String((request.params as { itemId: string }).itemId)) });
  server.route({ method: ["GET", "HEAD"], url: `${prefix}/Items/:itemId/Images/:imageType`, handler: async (request, reply) => sendItemImage(compatibility, await publicImageContext(request), request, reply, String((request.params as { itemId: string }).itemId), String((request.params as { imageType: string }).imageType)) });
  server.route({ method: ["GET", "HEAD"], url: `${prefix}/Items/:itemId/Images/:imageType/:index`, handler: async (request, reply) => sendItemImage(compatibility, await publicImageContext(request), request, reply, String((request.params as { itemId: string }).itemId), String((request.params as { imageType: string }).imageType)) });
  // 兼容 Jellyfin 旧客户端仍在使用的完整图片路径参数形式，实际缩放参数由上游图片承担。
  server.route({ method: ["GET", "HEAD"], url: `${prefix}/Items/:itemId/Images/:imageType/:index/:tag/:format/:maxWidth/:maxHeight/:percentPlayed/:unplayedCount`, handler: async (request, reply) => sendItemImage(compatibility, await publicImageContext(request), request, reply, String((request.params as { itemId: string }).itemId), String((request.params as { imageType: string }).imageType)) });
  server.post(`${prefix}/Sessions/Playing`, async (request, reply) => { await compatibility.reportPlayback(await authenticated(request), "playing", (request.body ?? {}) as Record<string, unknown>); return reply.status(204).send(); });
  server.post(`${prefix}/Sessions/Playing/Progress`, async (request, reply) => { await compatibility.reportPlayback(await authenticated(request), "progress", (request.body ?? {}) as Record<string, unknown>); return reply.status(204).send(); });
  server.post(`${prefix}/Sessions/Playing/Stopped`, async (request, reply) => { await compatibility.reportPlayback(await authenticated(request), "stopped", (request.body ?? {}) as Record<string, unknown>); return reply.status(204).send(); });
  server.post(`${prefix}/Users/:userId/PlayedItems/:itemId`, async (request) => { const context = await authenticated(request); const params = request.params as { userId: string; itemId: string }; requireProtocolUser(context, params.userId); return { UserData: await compatibility.setPlayed(context, params.itemId, true) }; });
  server.delete(`${prefix}/Users/:userId/PlayedItems/:itemId`, async (request) => { const context = await authenticated(request); const params = request.params as { userId: string; itemId: string }; requireProtocolUser(context, params.userId); return { UserData: await compatibility.setPlayed(context, params.itemId, false) }; });
  server.post(`${prefix}/Users/:userId/Items/:itemId/HideFromResume`, async (request, reply) => { const context = await authenticated(request); const params = request.params as { userId: string; itemId: string }; requireProtocolUser(context, params.userId); await compatibility.setHiddenFromResume(context, params.itemId, true); return reply.status(204).send(); });
  server.delete(`${prefix}/Users/:userId/Items/:itemId/HideFromResume`, async (request, reply) => { const context = await authenticated(request); const params = request.params as { userId: string; itemId: string }; requireProtocolUser(context, params.userId); await compatibility.setHiddenFromResume(context, params.itemId, false); return reply.status(204).send(); });
}

/** 注册 Jellyfin 协议兼容接口。 */
export async function registerJellyfinRoutes(server: FastifyInstance, runtime: ApiRuntime): Promise<void> {
  const compatibility = new JellyfinCompatibilityService(runtime);
  registerProtocolPrefix(server, runtime, compatibility, "/j/:jellyfinPathSuffix");
  registerProtocolPrefix(server, runtime, compatibility, "/j/:jellyfinPathSuffix/emby");
}
