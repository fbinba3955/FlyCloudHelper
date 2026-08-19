import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ApiError } from "../errors.js";
import { requireRequestUser } from "../http.js";
import { providerStream } from "../providers/network.js";
import type { ProviderConnectionContext, ProviderFileStreamAccess } from "../providers/types.js";
import type { ApiRuntime } from "../runtime.js";

interface RelayLibraryRow {
  id: string;
  service_id: string;
  provider_type: string;
  service_status: string;
  relay_playback_enabled: number | string | boolean;
  credential_revision: number | string;
}

interface RelayStreamParams {
  libraryId: string;
  itemId: string;
  fileId: string;
}

/** 只有 APP Bearer Token 可以请求媒体流，浏览器 Cookie 不能直接播放。 */
function requireAppBearer(request: FastifyRequest): void {
  if (!request.headers.authorization?.startsWith("Bearer ")) {
    throw new ApiError(403, "app_token_required", "中转播放只提供给已登录 APP 客户端");
  }
}

/** 判断数据库中的服务级中转播放开关是否已经启用。 */
function isRelayPlaybackEnabled(value: RelayLibraryRow["relay_playback_enabled"]): boolean {
  return value === true || Number(value) === 1;
}

/** 校验并读取播放器允许转发的单段或多段 HTTP Range。 */
function readRangeHeader(request: FastifyRequest): string | null {
  const value = request.headers.range;
  if (!value) return null;
  // 关键变量：仅允许标准 bytes Range，避免把任意客户端请求头透传给网盘。
  if (value.length > 200 || !/^bytes=(?:\d+-\d*|-\d+)(?:\s*,\s*(?:\d+-\d*|-\d+))*$/iu.test(value)) {
    throw new ApiError(416, "range_header_invalid", "媒体 Range 请求格式无效");
  }
  return value;
}

/** 生成上游媒体请求头，只增加播放所需字段，不转发 APP 的认证信息。 */
function buildUpstreamHeaders(
  request: FastifyRequest,
  providerHeaders: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = { ...providerHeaders, "Accept-Encoding": "identity" };
  const range = readRangeHeader(request);
  if (range) headers.Range = range;
  if (typeof request.headers["if-range"] === "string" && request.headers["if-range"].length <= 500) {
    headers["If-Range"] = request.headers["if-range"];
  }
  if (typeof request.headers.accept === "string" && request.headers.accept.length <= 500) {
    headers.Accept = request.headers.accept;
  }
  if (typeof request.headers["user-agent"] === "string" && request.headers["user-agent"].length <= 500) {
    headers["User-Agent"] = request.headers["user-agent"];
  }
  return headers;
}

/** 仅复制媒体播放需要的上游响应头，过滤 Cookie、认证挑战和连接级响应头。 */
function copyMediaResponseHeaders(reply: FastifyReply, headers: IncomingHttpHeaders): void {
  const allowedHeaders = [
    "accept-ranges",
    "content-disposition",
    "content-encoding",
    "content-length",
    "content-range",
    "content-type",
    "etag",
    "expires",
    "last-modified",
    "vary",
  ];
  for (const headerName of allowedHeaders) {
    const value = headers[headerName];
    if (value === undefined) continue;
    reply.header(headerName, Array.isArray(value) ? value.join(", ") : value);
  }
  // 关键变量：认证媒体响应禁止被共享缓存保存，且要求 Nginx 等反向代理关闭正文缓冲。
  reply.header("Cache-Control", "private, no-store");
  reply.header("X-Accel-Buffering", "no");
}

/** 根据服务凭据和源文件 locator 解析仅供服务端使用的上游媒体地址。 */
async function resolveRelayAccess(
  runtime: ApiRuntime,
  library: RelayLibraryRow,
  userId: string,
  locator: Record<string, unknown>,
  signal: AbortSignal,
): Promise<ProviderFileStreamAccess> {
  const adapter = runtime.providers.get(library.provider_type);
  const connection = runtime.vault.decrypt(
    await runtime.repository.getActiveEncryptedConnection(library.service_id, userId),
  );
  const context: ProviderConnectionContext = {
    persistConnection: async (nextConnection) => {
      await runtime.repository.refreshActiveEncryptedConnection({
        serviceId: library.service_id,
        userId,
        credentialRevision: Number(library.credential_revision),
        encryptedConnection: runtime.vault.encrypt(nextConnection),
      });
      runtime.logBusinessEvent("info", {
        日志关键字: "codex-flycloud-helper-provider-connection-refresh",
        事件: "媒体中转期间保存Provider刷新令牌",
        用户ID: userId,
        服务ID: library.service_id,
        网盘类型: library.provider_type,
      });
    },
  };
  if (adapter.resolveFileStreamAccess) {
    return adapter.resolveFileStreamAccess(connection, locator, signal, context);
  }
  // 安全的临时直链同样可以作为中转上游；不会把地址返回给本次 APP 请求。
  if (adapter.resolveFileAccess) {
    return adapter.resolveFileAccess(connection, locator, signal, context);
  }
  throw new ApiError(422, "provider_relay_playback_unsupported", "当前网盘类型暂不支持中转播放");
}

/** 清理客户端断开监听，避免一次播放结束后保留请求对象引用。 */
function removeClientAbortListeners(
  request: FastifyRequest,
  reply: FastifyReply,
  listener: () => void,
): void {
  request.raw.removeListener("aborted", listener);
  reply.raw.removeListener("close", listener);
}

/** 记录上游媒体流结束或中断，日志不包含文件路径、URL、请求头和凭据。 */
function observeRelayStream(
  runtime: ApiRuntime,
  body: IncomingMessage,
  fields: { userId: string; serviceId: string; itemId: string; fileId: string; startedAt: number },
): void {
  let finished = false;
  body.once("end", () => {
    finished = true;
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-flycloud-helper-media-stream",
      事件: "媒体中转正常结束",
      用户ID: fields.userId,
      服务ID: fields.serviceId,
      媒体条目ID: fields.itemId,
      源文件ID: fields.fileId,
      中转时长毫秒: Date.now() - fields.startedAt,
    });
  });
  body.once("error", (error) => {
    if (finished) return;
    finished = true;
    runtime.logBusinessEvent("warn", {
      日志关键字: "codex-flycloud-helper-media-stream",
      事件: "媒体中转上游流异常",
      用户ID: fields.userId,
      服务ID: fields.serviceId,
      媒体条目ID: fields.itemId,
      源文件ID: fields.fileId,
      错误类型: error.name,
      中转时长毫秒: Date.now() - fields.startedAt,
    });
  });
}

/** 注册 APP 使用的服务端媒体中转接口。 */
export async function registerMediaStreamRoutes(server: FastifyInstance, runtime: ApiRuntime): Promise<void> {
  server.route<{ Params: RelayStreamParams }>({
    method: ["GET", "HEAD"],
    url: "/api/v1/libraries/:libraryId/items/:itemId/files/:fileId/stream",
    handler: async (request, reply) => {
      requireAppBearer(request);
      const user = await requireRequestUser(request, runtime.database);
      const library = await runtime.database.query("media_libraries as l")
        .join("cloud_services as s", "s.id", "l.service_id")
        .select(
          "l.id",
          "l.service_id",
          "l.provider_type",
          "s.status as service_status",
          "s.relay_playback_enabled",
          "s.credential_revision",
        )
        .where("l.id", request.params.libraryId)
        .where("l.user_id", user.id)
        .whereNull("s.deleted_at")
        .first() as RelayLibraryRow | undefined;
      if (!library) throw new ApiError(404, "library_not_found", "媒体库不存在");
      if (!isRelayPlaybackEnabled(library.relay_playback_enabled)) {
        throw new ApiError(409, "relay_playback_disabled", "当前服务未启用中转播放");
      }
      if (library.service_status === "disabled") {
        throw new ApiError(409, "service_disabled", "当前服务已停用，不能中转播放");
      }

      const mediaItem = await runtime.repository.getCatalogItem(request.params.itemId, user.id);
      if (mediaItem.libraryId !== request.params.libraryId) {
        throw new ApiError(404, "media_item_not_found", "媒体条目不存在");
      }
      const files = await runtime.repository.listItemFiles(request.params.itemId, user.id);
      const sourceFile = files.find((file) => String(file.fileId) === request.params.fileId);
      if (!sourceFile) throw new ApiError(404, "source_file_not_found", "媒体源文件不存在");

      const startedAt = Date.now();
      const abortController = new AbortController();
      const abortUpstream = () => {
        if (!reply.raw.writableEnded) abortController.abort();
      };
      request.raw.once("aborted", abortUpstream);
      reply.raw.once("close", abortUpstream);
      let upstreamBody: IncomingMessage | null = null;
      try {
        const locator = sourceFile.playbackLocator && typeof sourceFile.playbackLocator === "object"
          ? sourceFile.playbackLocator as Record<string, unknown>
          : {};
        const access = await resolveRelayAccess(runtime, library, user.id, locator, abortController.signal);
        const upstream = await providerStream(access.url, {
          method: request.method,
          headers: buildUpstreamHeaders(request, access.headers),
        }, {
          allowInsecureHttp: runtime.config.allowInsecureProviderHttp,
          logConnectionFailure: (fields) => runtime.logBusinessEvent("warn", fields),
        }, abortController.signal);
        upstreamBody = upstream.body;
        upstream.body.once("close", () => {
          removeClientAbortListeners(request, reply, abortUpstream);
        });
        observeRelayStream(runtime, upstream.body, {
          userId: user.id,
          serviceId: library.service_id,
          itemId: request.params.itemId,
          fileId: request.params.fileId,
          startedAt,
        });
        runtime.logBusinessEvent("info", {
          日志关键字: "codex-flycloud-helper-media-stream",
          事件: "媒体中转连接建立",
          用户ID: user.id,
          服务ID: library.service_id,
          媒体条目ID: request.params.itemId,
          源文件ID: request.params.fileId,
          请求方式: request.method,
          是否Range请求: Boolean(request.headers.range),
          上游状态码: upstream.statusCode,
          建立耗时毫秒: Date.now() - startedAt,
        });
        copyMediaResponseHeaders(reply, upstream.headers);
        reply.status(upstream.statusCode);
        return reply.send(upstream.body);
      } catch (error) {
        if (!upstreamBody) removeClientAbortListeners(request, reply, abortUpstream);
        runtime.logBusinessEvent("warn", {
          日志关键字: "codex-flycloud-helper-media-stream",
          事件: "媒体中转请求失败",
          用户ID: user.id,
          服务ID: library.service_id,
          媒体条目ID: request.params.itemId,
          源文件ID: request.params.fileId,
          错误码: error && typeof error === "object" && "code" in error
            ? String((error as { code?: string }).code)
            : "relay_playback_failed",
          已等待毫秒: Date.now() - startedAt,
        });
        throw error;
      }
    },
  });
}
