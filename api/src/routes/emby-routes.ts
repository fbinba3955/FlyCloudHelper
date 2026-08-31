import type { IncomingMessage } from "node:http";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ApiError } from "../errors.js";
import { buildEmbyPath } from "../emby-path.js";
import { EmbyCompatibilityService, type EmbyContext, type EmbyLibraryContext } from "../emby-service.js";
import { providerFetch, providerStream } from "../providers/network.js";
import type { ProviderConnectionContext, ProviderFileAccess } from "../providers/types.js";
import type { ApiRuntime } from "../runtime.js";
import { buildUpstreamHeaders, copyMediaResponseHeaders, resolveRelayAccess, type RelayLibraryRow } from "./media-stream-routes.js";

/** 读取 Emby 查询参数，保留官方 PascalCase 与部分客户端 camelCase。 */
function readQuery(request: FastifyRequest): Record<string, unknown> {
  return (request.query ?? {}) as Record<string, unknown>;
}

/** 从 Query 或 PlaybackInfo 请求体读取 Emby 媒体源 ID。 */
function readMediaSourceId(request: FastifyRequest): string {
  const body = request.body && typeof request.body === "object" ? request.body as Record<string, unknown> : {};
  const query = readQuery(request);
  return String(query.MediaSourceId ?? query.mediaSourceId ?? body.MediaSourceId ?? body.mediaSourceId ?? "");
}

/** 读取当前客户端选择的原始、中转或自动播放路线。 */
function readPlaybackRoute(request: FastifyRequest): "auto" | "origin" | "server" {
  const value = String(request.headers["x-flycloud-playback-route"] ?? readQuery(request).FlyCloudPlaybackRoute ?? "auto").toLowerCase();
  return value === "origin" || value === "server" ? value : "auto";
}

/** 限定 URL 中的用户 ID 只能等于当前 Emby 登录账号。 */
function requireEmbyUser(context: EmbyContext, userId: string): void {
  if (context.accountId !== userId) throw new ApiError(403, "emby_user_scope_mismatch", "不能访问其他 Emby 账号的数据");
}

/** 读取协议前缀对应的真实云服务和中转能力配置。 */
async function getStreamService(runtime: ApiRuntime, serviceId: string): Promise<Record<string, unknown>> {
  const service = await runtime.database.query("cloud_services as s")
    .join("media_libraries as l", "l.id", "s.library_id")
    .select("s.*", "l.emby_relay_playback_enabled")
    .where("s.id", serviceId)
    .whereNull("s.deleted_at")
    .first();
  if (!service) throw new ApiError(404, "emby_service_not_found", "Emby 服务不存在");
  return service;
}

/** 解析网盘临时访问地址，并在 Provider 刷新授权时持久化新的连接配置。 */
async function resolveFileAccess(runtime: ApiRuntime, service: Record<string, unknown>, ownerUserId: string, locator: Record<string, unknown>, signal: AbortSignal): Promise<ProviderFileAccess | null> {
  const adapter = runtime.providers.get(String(service.provider_type));
  if (!adapter.resolveFileAccess) return null;
  const connection = runtime.vault.decrypt(await runtime.repository.getActiveEncryptedConnection(String(service.id), ownerUserId));
  const providerContext: ProviderConnectionContext = {
    persistConnection: async (nextConnection) => runtime.repository.refreshActiveEncryptedConnection({
      serviceId: String(service.id), userId: ownerUserId, credentialRevision: Number(service.credential_revision), encryptedConnection: runtime.vault.encrypt(nextConnection),
    }),
  };
  return adapter.resolveFileAccess(connection, locator, signal, providerContext);
}

/** 判断 Provider 是否明确反馈该网盘文件已经被删除。 */
function isMissingProviderFileError(error: unknown): boolean {
  return error instanceof ApiError && (error.code === "provider_file_not_found" || (error.code === "provider_request_failed" && error.message.trim() === "文件已删除"));
}

/** 将服务数据库行转换为通用媒体中转模块需要的最小媒体库记录。 */
function toRelayLibrary(service: Record<string, unknown>): RelayLibraryRow {
  return { id: String(service.library_id), service_id: String(service.id), provider_type: String(service.provider_type), service_status: String(service.status), relay_playback_enabled: service.emby_relay_playback_enabled as number, credential_revision: Number(service.credential_revision) };
}

/** 代理 Emby 项目图片，图片接口可不带令牌以兼容海报组件。 */
async function sendImage(compatibility: EmbyCompatibilityService, context: EmbyLibraryContext, request: FastifyRequest, reply: FastifyReply, itemId: string, imageType: string) {
  const source = await compatibility.resolveImageSource(context, itemId, imageType);
  let url: URL;
  try { url = new URL(source.url); } catch { throw new ApiError(404, "emby_image_not_found", "图片地址不可用"); }
  if (!/^https?:$/iu.test(url.protocol)) throw new ApiError(422, "emby_image_source_unsupported", "当前图片来源不支持代理");
  const etag = `"${source.imageTag}"`;
  reply.header("ETag", etag).header("Last-Modified", new Date(source.updatedAt).toUTCString());
  if (request.headers["if-none-match"] === etag) return reply.status(304).send();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await providerFetch(url, { method: request.method === "HEAD" ? "HEAD" : "GET" }, { allowInsecureHttp: true }, controller.signal);
    if (!response.ok) throw new ApiError(502, "emby_image_upstream_failed", "图片服务暂时不可用");
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > 20 * 1024 * 1024) throw new ApiError(413, "emby_image_too_large", "图片文件过大");
    const contentType = response.headers.get("content-type") ?? "image/jpeg";
    if (!contentType.toLowerCase().startsWith("image/")) throw new ApiError(502, "emby_image_content_invalid", "图片服务返回了非图片内容");
    reply.header("Content-Type", contentType).header("Cache-Control", "private, max-age=86400");
    if (length > 0) reply.header("Content-Length", length);
    return request.method === "HEAD" ? reply.send() : reply.send(Buffer.from(await response.arrayBuffer()));
  } finally { clearTimeout(timer); }
}

/** 输出 Emby 视频直放或原文件下载；保留 Range 和 Provider 所需请求头。 */
async function sendMediaStream(runtime: ApiRuntime, compatibility: EmbyCompatibilityService, context: EmbyContext, request: FastifyRequest, reply: FastifyReply, itemId: string, download = false) {
  if (download && !context.downloadEnabled) throw new ApiError(403, "emby_download_disabled", "当前 Emby 服务未允许下载影片");
  const service = await getStreamService(runtime, context.serviceId);
  const route = readPlaybackRoute(request);
  const relayEnabled = Number(service.emby_relay_playback_enabled) === 1 || service.emby_relay_playback_enabled === true;
  // 关键变量：自动模式遵循 Emby 专用中转开关；下载永远由云助手安全转发字节流。
  const effectiveRoute = download ? "server" : route === "auto" ? relayEnabled ? "server" : "origin" : route;
  const internalItemId = compatibility.toInternalItemId(itemId);
  const item = await runtime.repository.getCatalogItem(internalItemId, context.ownerUserId);
  if (item.serviceId !== context.serviceId) throw new ApiError(404, "emby_item_not_found", "媒体条目不存在");
  const files = (await runtime.repository.listItemFiles(item.id, context.ownerUserId)).filter((file) => String(file.itemId) === item.id);
  const sourceId = compatibility.toInternalMediaSourceId(item.id, readMediaSourceId(request));
  const selected = !sourceId || sourceId === item.id ? files[0] : files.find((file) => String(file.fileId) === sourceId);
  if (!selected) throw new ApiError(404, "emby_media_source_not_found", "媒体源不存在");
  const candidates = [selected, ...files.filter((file) => file !== selected && String(file.path) === String(selected.path))];
  const controller = new AbortController(); const abort = () => controller.abort();
  request.raw.once("aborted", abort); reply.raw.once("close", abort);
  let upstreamBody: IncomingMessage | null = null;
  try {
    let access: ProviderFileAccess | null = null; let file: Record<string, unknown> | undefined;
    for (const candidate of candidates) {
      const locator = candidate.playbackLocator && typeof candidate.playbackLocator === "object" ? candidate.playbackLocator as Record<string, unknown> : {};
      try {
        const originAccess = effectiveRoute === "origin" ? await resolveFileAccess(runtime, service, context.ownerUserId, locator, controller.signal) : null;
        if (effectiveRoute === "origin" && originAccess && Object.keys(originAccess.headers).length === 0) {
          reply.header("Cache-Control", "private, no-store");
          return reply.redirect(originAccess.url, 307);
        }
        if (effectiveRoute === "origin" && originAccess && !relayEnabled) throw new ApiError(409, "emby_origin_headers_required", "当前原始播放地址需要专用请求头，请启用 Emby 中转播放");
        access = originAccess ?? await resolveRelayAccess(runtime, toRelayLibrary(service), context.ownerUserId, locator, controller.signal);
        file = candidate;
        break;
      } catch (error) { if (!isMissingProviderFileError(error)) throw error; }
    }
    if (!access || !file) throw new ApiError(404, "emby_provider_file_not_found", "当前播放版本对应的网盘文件已删除");
    const headers = buildUpstreamHeaders(request, access.headers);
    if (download) headers.Accept = "*/*";
    const upstream = await providerStream(access.url, { method: request.method, headers }, { allowInsecureHttp: runtime.config.allowInsecureProviderHttp, logConnectionFailure: (fields) => runtime.logBusinessEvent("warn", fields) }, controller.signal);
    upstreamBody = upstream.body;
    copyMediaResponseHeaders(reply, upstream.headers);
    if (download) reply.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(String(file.name ?? item.title))}`);
    reply.status(upstream.statusCode);
    runtime.logBusinessEvent("info", { 日志关键字: download ? "codex-emby-download" : "codex-emby-playback", 事件: download ? "建立Emby影片下载连接" : "建立Emby播放连接", 服务ID: context.serviceId, 媒体条目ID: item.id, 源文件ID: String(file.fileId), 播放路线: effectiveRoute, 是否Range请求: Boolean(request.headers.range), 上游状态码: upstream.statusCode });
    return reply.send(upstream.body);
  } finally { if (!upstreamBody) { request.raw.removeListener("aborted", abort); reply.raw.removeListener("close", abort); } }
}

/** 返回当前请求实际可访问的 Emby 规范根地址，永远不返回 Flymby alias。 */
async function buildLocalAddress(runtime: ApiRuntime, request: FastifyRequest, suffix: string): Promise<string> {
  const configured = await runtime.publicAccess.buildEmbyUrl(suffix);
  if (configured) return configured;
  const protocol = String(request.headers["x-forwarded-proto"] ?? request.protocol).split(",", 1)[0]?.trim() || request.protocol;
  const host = String(request.headers["x-forwarded-host"] ?? request.headers.host ?? "").split(",", 1)[0]?.trim();
  const path = buildEmbyPath(suffix);
  if (!host) return path;
  try { return `${new URL(`${protocol}://${host}`).origin}${path}`; } catch { return path; }
}

/** 注册 Emby 4.8+ 兼容接口及 Flymby 的 /emby 追加路径 alias。 */
export async function registerEmbyRoutes(server: FastifyInstance, runtime: ApiRuntime): Promise<void> {
  const compatibility = new EmbyCompatibilityService(runtime);
  const registerPrefix = (prefix: string) => {
    const suffix = (request: FastifyRequest) => String((request.params as { embyPathSuffix: string }).embyPathSuffix);
    const serviceId = (request: FastifyRequest) => compatibility.resolveServiceIdByPathSuffix(suffix(request));
    const authenticated = async (request: FastifyRequest) => compatibility.authenticate(await serviceId(request), request);
    const publicImageContext = async (request: FastifyRequest) => compatibility.resolvePublicImageContext(await serviceId(request));
    server.get(`${prefix}/System/Info/Public`, async (request) => { const id = await serviceId(request); const service = await compatibility.requireEnabledService(id); return { LocalAddress: await buildLocalAddress(runtime, request, suffix(request)), ServerName: service.display_name, Version: "4.8.11.0", ProductName: "Emby Server", OperatingSystem: process.platform, Id: id, StartupWizardCompleted: true }; });
    server.get(`${prefix}/System/Info`, async (request) => { const context = await authenticated(request); const service = await compatibility.requireEnabledService(context.serviceId); return { LocalAddress: await buildLocalAddress(runtime, request, suffix(request)), ServerName: service.display_name, Version: "4.8.11.0", ProductName: "Emby Server", OperatingSystem: process.platform, Id: context.serviceId, StartupWizardCompleted: true }; });
    server.get(`${prefix}/System/Ping`, async (_request, reply) => reply.status(204).send());
    server.post(`${prefix}/Users/AuthenticateByName`, async (request) => compatibility.login(await serviceId(request), request, (request.body ?? {}) as Record<string, unknown>));
    server.post(`${prefix}/Sessions/Logout`, async (request, reply) => { await compatibility.logout(await serviceId(request), request); return reply.status(204).send(); });
    server.get(`${prefix}/Users/:userId`, async (request) => { const context = await authenticated(request); requireEmbyUser(context, String((request.params as { userId: string }).userId)); return compatibility.mapUser(context.accountId, context.accountUsername, context.serviceId, context.accountHasPassword, context.downloadEnabled); });
    server.get(`${prefix}/Users/Me`, async (request) => { const context = await authenticated(request); return compatibility.mapUser(context.accountId, context.accountUsername, context.serviceId, context.accountHasPassword, context.downloadEnabled); });
    server.get(`${prefix}/Users/Public`, async (request) => { await authenticated(request); return []; });
    server.get(`${prefix}/Users/:userId/Views`, async (request) => { const context = await authenticated(request); requireEmbyUser(context, String((request.params as { userId: string }).userId)); return compatibility.listLibraries(context); });
    server.get(`${prefix}/UserViews`, async (request) => compatibility.listLibraries(await authenticated(request)));
    server.get(`${prefix}/Users/:userId/Items/Resume`, async (request) => { const context = await authenticated(request); requireEmbyUser(context, String((request.params as { userId: string }).userId)); return compatibility.listResume(context, readQuery(request)); });
    server.get(`${prefix}/Users/:userId/Items/Root`, async (request) => { const context = await authenticated(request); requireEmbyUser(context, String((request.params as { userId: string }).userId)); return compatibility.listLibraries(context); });
    server.get(`${prefix}/Users/:userId/Items/Latest`, async (request) => { const context = await authenticated(request); requireEmbyUser(context, String((request.params as { userId: string }).userId)); return (await compatibility.listItems(context, { ...readQuery(request), SortBy: "DateCreated", SortOrder: "Descending" })).Items; });
    server.get(`${prefix}/Users/:userId/Items/:itemId`, async (request) => { const context = await authenticated(request); const params = request.params as { userId: string; itemId: string }; requireEmbyUser(context, params.userId); return compatibility.getItem(context, params.itemId); });
    server.get(`${prefix}/Users/:userId/Items/:itemId/UserData`, async (request) => { const context = await authenticated(request); const params = request.params as { userId: string; itemId: string }; requireEmbyUser(context, params.userId); const item = await compatibility.getItem(context, params.itemId) as { UserData?: unknown }; return item.UserData ?? {}; });
    server.get(`${prefix}/Users/:userId/Items`, async (request) => { const context = await authenticated(request); requireEmbyUser(context, String((request.params as { userId: string }).userId)); const query = readQuery(request); const favorite = String(query.IsFavorite ?? query.Filters ?? "").includes("true") || String(query.Filters ?? "").includes("IsFavorite"); const played = String(query.IsPlayed ?? query.Filters ?? "").includes("true") || String(query.Filters ?? "").includes("IsPlayed"); return favorite ? compatibility.listFavoriteItems(context, query) : played ? compatibility.listPlayedItems(context, query) : String(query.SortBy ?? "").includes("DatePlayed") ? compatibility.listHistory(context, query) : compatibility.listItems(context, query); });
    server.get(`${prefix}/Items`, async (request) => compatibility.listItems(await authenticated(request), readQuery(request)));
    server.get(`${prefix}/Items/:itemId`, async (request) => compatibility.getItem(await authenticated(request), String((request.params as { itemId: string }).itemId)));
    server.get(`${prefix}/Items/:itemId/Ancestors`, async (_request) => []);
    server.get(`${prefix}/Items/:itemId/Similar`, async (_request) => ({ Items: [], TotalRecordCount: 0, StartIndex: 0 }));
    server.get(`${prefix}/Search/Hints`, async (request) => { const result = await compatibility.listItems(await authenticated(request), { ...readQuery(request), Limit: readQuery(request).Limit ?? 50 }); return { SearchHints: result.Items.map((item) => ({ ItemId: item.Id, Id: item.Id, Name: item.Name, Type: item.Type, ProductionYear: item.ProductionYear, PrimaryImageTag: (item.ImageTags as Record<string, unknown> | undefined)?.Primary })), TotalRecordCount: result.TotalRecordCount }; });
    server.get(`${prefix}/Items/Counts`, async (request) => compatibility.getItemCounts(await authenticated(request)));
    server.get(`${prefix}/Persons`, async (request) => compatibility.listPersons(await authenticated(request), readQuery(request)));
    server.get(`${prefix}/Persons/:name`, async (request) => { const context = await authenticated(request); const result = await compatibility.listPersons(context, { SearchTerm: String((request.params as { name: string }).name), Limit: 1 }); const person = result.Items[0]; if (!person) throw new ApiError(404, "emby_person_not_found", "演员不存在"); return person; });
    server.get(`${prefix}/Genres`, async (request) => compatibility.listGenres(await authenticated(request), readQuery(request)));
    server.get(`${prefix}/Shows/:seriesId/Seasons`, async (request) => compatibility.listSeasons(await authenticated(request), String((request.params as { seriesId: string }).seriesId)));
    server.get(`${prefix}/Shows/:seriesId/Episodes`, async (request) => compatibility.listEpisodes(await authenticated(request), String((request.params as { seriesId: string }).seriesId), readQuery(request)));
    server.get(`${prefix}/Shows/NextUp`, async (request) => ({ Items: [], TotalRecordCount: 0, StartIndex: 0 }));
    server.route({ method: ["GET", "POST"], url: `${prefix}/Items/:itemId/PlaybackInfo`, handler: async (request) => { const context = await authenticated(request); return compatibility.buildPlaybackInfo(context, String((request.params as { itemId: string }).itemId), { mediaSourceId: readMediaSourceId(request) || undefined, playSessionId: String(readQuery(request).PlaySessionId ?? readQuery(request).playSessionId ?? "") || undefined, route: readPlaybackRoute(request) }); } });
    server.route({ method: ["GET", "HEAD"], url: `${prefix}/Items/:itemId/Download`, handler: async (request, reply) => sendMediaStream(runtime, compatibility, await authenticated(request), request, reply, String((request.params as { itemId: string }).itemId), true) });
    server.route({ method: ["GET", "HEAD"], url: `${prefix}/Items/:itemId/File`, handler: async (request, reply) => sendMediaStream(runtime, compatibility, await authenticated(request), request, reply, String((request.params as { itemId: string }).itemId), true) });
    server.route({ method: ["GET", "HEAD"], url: `${prefix}/Video/:itemId/stream`, handler: async (request, reply) => sendMediaStream(runtime, compatibility, await authenticated(request), request, reply, String((request.params as { itemId: string }).itemId)) });
    server.route({ method: ["GET", "HEAD"], url: `${prefix}/Videos/:itemId/stream`, handler: async (request, reply) => sendMediaStream(runtime, compatibility, await authenticated(request), request, reply, String((request.params as { itemId: string }).itemId)) });
    server.route({ method: ["GET", "HEAD"], url: `${prefix}/Videos/:itemId/stream.:container`, handler: async (request, reply) => sendMediaStream(runtime, compatibility, await authenticated(request), request, reply, String((request.params as { itemId: string }).itemId)) });
    server.route({ method: ["GET", "HEAD"], url: `${prefix}/Items/:itemId/Images/:imageType`, handler: async (request, reply) => sendImage(compatibility, await publicImageContext(request), request, reply, String((request.params as { itemId: string }).itemId), String((request.params as { imageType: string }).imageType)) });
    server.route({ method: ["GET", "HEAD"], url: `${prefix}/Items/:itemId/Images/:imageType/:index`, handler: async (request, reply) => sendImage(compatibility, await publicImageContext(request), request, reply, String((request.params as { itemId: string }).itemId), String((request.params as { imageType: string }).imageType)) });
    server.route({ method: ["GET", "HEAD"], url: `${prefix}/Items/:itemId/Images/:imageType/:index/:tag/:format/:maxWidth/:maxHeight/:percentPlayed/:unplayedCount`, handler: async (request, reply) => sendImage(compatibility, await publicImageContext(request), request, reply, String((request.params as { itemId: string }).itemId), String((request.params as { imageType: string }).imageType)) });
    server.post(`${prefix}/Sessions/Playing`, async (request, reply) => { await compatibility.reportPlayback(await authenticated(request), "playing", (request.body ?? {}) as Record<string, unknown>); return reply.status(204).send(); });
    server.post(`${prefix}/Sessions/Playing/Progress`, async (request, reply) => { await compatibility.reportPlayback(await authenticated(request), "progress", (request.body ?? {}) as Record<string, unknown>); return reply.status(204).send(); });
    server.post(`${prefix}/Sessions/Playing/Stopped`, async (request, reply) => { await compatibility.reportPlayback(await authenticated(request), "stopped", (request.body ?? {}) as Record<string, unknown>); return reply.status(204).send(); });
    server.post(`${prefix}/Users/:userId/PlayedItems/:itemId`, async (request) => { const context = await authenticated(request); const params = request.params as { userId: string; itemId: string }; requireEmbyUser(context, params.userId); return compatibility.setPlayed(context, params.itemId, true); });
    server.delete(`${prefix}/Users/:userId/PlayedItems/:itemId`, async (request) => { const context = await authenticated(request); const params = request.params as { userId: string; itemId: string }; requireEmbyUser(context, params.userId); return compatibility.setPlayed(context, params.itemId, false); });
    server.post(`${prefix}/Users/:userId/FavoriteItems/:itemId`, async (request) => { const context = await authenticated(request); const params = request.params as { userId: string; itemId: string }; requireEmbyUser(context, params.userId); return compatibility.setFavorite(context, params.itemId, true); });
    server.delete(`${prefix}/Users/:userId/FavoriteItems/:itemId`, async (request) => { const context = await authenticated(request); const params = request.params as { userId: string; itemId: string }; requireEmbyUser(context, params.userId); return compatibility.setFavorite(context, params.itemId, false); });
    server.post(`${prefix}/Users/:userId/Items/:itemId/HideFromResume`, async (request, reply) => { const context = await authenticated(request); const params = request.params as { userId: string; itemId: string }; requireEmbyUser(context, params.userId); await compatibility.setHiddenFromResume(context, params.itemId, true); return reply.status(204).send(); });
    server.delete(`${prefix}/Users/:userId/Items/:itemId/HideFromResume`, async (request, reply) => { const context = await authenticated(request); const params = request.params as { userId: string; itemId: string }; requireEmbyUser(context, params.userId); await compatibility.setHiddenFromResume(context, params.itemId, false); return reply.status(204).send(); });
    server.post(`${prefix}/Sessions/Capabilities`, async (_request, reply) => reply.status(204).send());
    server.post(`${prefix}/Sessions/Capabilities/Full`, async (_request, reply) => reply.status(204).send());
  };
  registerPrefix("/e/:embyPathSuffix");
  // 关键变量：Flymby 的 Emby 客户端会自动追加 /emby；这里只是同一独立 Emby 协议的路径别名。
  registerPrefix("/e/:embyPathSuffix/emby");
}
