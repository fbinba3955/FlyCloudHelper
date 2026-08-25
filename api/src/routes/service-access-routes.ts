import type { FastifyInstance, FastifyRequest } from "fastify";
import { ApiError } from "../errors.js";
import { requireRequestUser, requireSuperAdmin } from "../http.js";
import type { ApiRuntime } from "../runtime.js";

/** 校验服务归属，并返回服务的 Jellyfin 开关状态。 */
async function requireManagedService(runtime: ApiRuntime, request: FastifyRequest, serviceId: string, admin: boolean) {
  const operator = admin
    ? await requireSuperAdmin(request, runtime.database)
    : await requireRequestUser(request, runtime.database);
  const service = await runtime.repository.getServiceDetail(serviceId, admin ? undefined : operator.id);
  return { operator, service };
}

/** 构造服务协议配置，密码只会在创建或重置的单次响应中出现。 */
async function buildServiceAccessSettings(runtime: ApiRuntime, serviceId: string) {
  const service = await runtime.repository.getServiceDetail(serviceId);
  const account = await runtime.serviceAccess.getByService(serviceId);
  /** 未设置公开地址覆盖值时，前端用于提示和复制的 Jellyfin 服务路径。 */
  const jellyfinPath = `/jellyfin/${encodeURIComponent(serviceId)}`;
  return {
    jellyfinEnabled: service.jellyfinEnabled,
    jellyfinUrl: await runtime.publicAccess.buildJellyfinUrl(serviceId),
    jellyfinPath,
    account,
  };
}

/** 注册用户端与管理端共用的服务协议设置接口。 */
export async function registerServiceAccessRoutes(server: FastifyInstance, runtime: ApiRuntime): Promise<void> {
  const registerScopedRoutes = (prefix: string, admin: boolean) => {
    server.get<{ Params: { serviceId: string } }>(`${prefix}/:serviceId/access-account`, async (request) => {
      await requireManagedService(runtime, request, request.params.serviceId, admin);
      return { settings: await buildServiceAccessSettings(runtime, request.params.serviceId) };
    });

    server.patch<{ Params: { serviceId: string }; Body: Record<string, unknown> }>(`${prefix}/:serviceId/access-account`, async (request) => {
      const { operator } = await requireManagedService(runtime, request, request.params.serviceId, admin);
      const account = await runtime.serviceAccess.updateCredentials(request.params.serviceId, {
        username: request.body.username,
        password: request.body.password,
      });
      runtime.logBusinessEvent("info", {
        日志关键字: "codex-service-access-credential", 事件: "修改服务访问凭据并撤销旧会话",
        操作用户ID: operator.id, 服务ID: request.params.serviceId, 凭据修订: account.credentialRevision,
        是否需要密码: account.hasPassword,
      });
      return { settings: await buildServiceAccessSettings(runtime, request.params.serviceId) };
    });

    server.post<{ Params: { serviceId: string } }>(`${prefix}/:serviceId/access-account/reset-password`, async (request) => {
      const { operator } = await requireManagedService(runtime, request, request.params.serviceId, admin);
      const generated = await runtime.serviceAccess.resetPassword(request.params.serviceId);
      runtime.logBusinessEvent("info", {
        日志关键字: "codex-jellyfin-compat", 事件: "重置服务访问密码并撤销旧会话",
        操作用户ID: operator.id, 服务ID: request.params.serviceId, 凭据修订: generated.account.credentialRevision,
      });
      return { settings: await buildServiceAccessSettings(runtime, request.params.serviceId), password: generated.password };
    });

    server.post<{ Params: { serviceId: string } }>(`${prefix}/:serviceId/access-account/revoke-sessions`, async (request) => {
      const { operator } = await requireManagedService(runtime, request, request.params.serviceId, admin);
      const revokedCount = await runtime.serviceAccess.revokeSessions(request.params.serviceId);
      runtime.logBusinessEvent("info", {
        日志关键字: "codex-jellyfin-compat", 事件: "撤销服务全部协议会话",
        操作用户ID: operator.id, 服务ID: request.params.serviceId, 撤销会话数: revokedCount,
      });
      return { revokedCount };
    });

    server.patch<{ Params: { serviceId: string }; Body: Record<string, unknown> }>(`${prefix}/:serviceId/jellyfin-settings`, async (request) => {
      const { operator } = await requireManagedService(runtime, request, request.params.serviceId, admin);
      if (typeof request.body.jellyfinEnabled !== "boolean") throw new ApiError(422, "jellyfin_enabled_invalid", "Jellyfin 开关必须是布尔值");
      const publicAccess = await runtime.publicAccess.getStatus();
      const now = new Date().toISOString();
      await runtime.database.query("cloud_services").where({ id: request.params.serviceId }).update({ jellyfin_enabled: request.body.jellyfinEnabled ? 1 : 0, updated_at: now });
      const revokedCount = request.body.jellyfinEnabled ? 0 : await runtime.serviceAccess.revokeSessions(request.params.serviceId, "jellyfin");
      runtime.logBusinessEvent("info", {
        日志关键字: "codex-jellyfin-compat", 事件: request.body.jellyfinEnabled ? "启用Jellyfin兼容服务" : "停用Jellyfin兼容服务",
        操作用户ID: operator.id, 服务ID: request.params.serviceId, 撤销会话数: revokedCount,
        公开地址来源: publicAccess.source, 是否使用云助手请求地址: !publicAccess.publicBaseUrl,
      });
      return { settings: await buildServiceAccessSettings(runtime, request.params.serviceId) };
    });
  };

  registerScopedRoutes("/api/v1/services", false);
  registerScopedRoutes("/api/v1/admin/services", true);

  server.get("/api/v1/admin/config/public-access", async (request) => {
    await requireSuperAdmin(request, runtime.database);
    return { publicAccess: await runtime.publicAccess.getStatus() };
  });
  server.put<{ Body: Record<string, unknown> }>("/api/v1/admin/config/public-access", async (request) => {
    const operator = await requireSuperAdmin(request, runtime.database);
    if (!runtime.publicAccess || (await runtime.publicAccess.getStatus()).source === "environment") {
      throw new ApiError(409, "public_base_url_environment_locked", "公开访问地址由环境变量控制，不能在控制台修改");
    }
    const publicAccess = await runtime.publicAccess.save(request.body.publicBaseUrl, operator.id);
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-jellyfin-compat", 事件: "更新实例公开访问地址",
      操作用户ID: operator.id, 配置来源: publicAccess.source, 是否已配置: Boolean(publicAccess.publicBaseUrl),
    });
    return { publicAccess };
  });
}
