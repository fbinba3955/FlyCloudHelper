import type { FastifyInstance, FastifyRequest } from "fastify";
import { ApiError } from "../errors.js";
import { requireRequestUser, requireSuperAdmin } from "../http.js";
import { buildJellyfinPath, validateJellyfinPathSuffix } from "../jellyfin-path.js";
import type { ApiRuntime } from "../runtime.js";

/** 通过基础服务校验媒体库归属，并返回一对一关联记录。 */
async function requireManagedService(runtime: ApiRuntime, request: FastifyRequest, serviceId: string, admin: boolean) {
  const operator = admin
    ? await requireSuperAdmin(request, runtime.database)
    : await requireRequestUser(request, runtime.database);
  const service = await runtime.repository.getServiceDetail(serviceId, admin ? undefined : operator.id);
  return { operator, service };
}

/** 构造媒体库协议配置。 */
async function buildServiceAccessSettings(runtime: ApiRuntime, serviceId: string) {
  const service = await runtime.repository.getServiceDetail(serviceId);
  const account = await runtime.serviceAccess.getByService(serviceId);
  const library = await runtime.database.query("media_libraries")
    .select("jellyfin_path_suffix")
    .where({ service_id: serviceId })
    .first();
  // 关键变量：数据库升级尚未完成时临时回退服务 ID，保证设置页仍可读取。
  const jellyfinPathSuffix = String(library?.jellyfin_path_suffix ?? "").trim() || serviceId;
  const jellyfinPath = buildJellyfinPath(jellyfinPathSuffix);
  return {
    jellyfinEnabled: service.jellyfinEnabled,
    jellyfinUrl: await runtime.publicAccess.buildJellyfinUrl(jellyfinPathSuffix),
    jellyfinPath,
    jellyfinPathSuffix,
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
      const changesJellyfinEnabled = request.body.jellyfinEnabled !== undefined;
      const changesPathSuffix = request.body.jellyfinPathSuffix !== undefined;
      if (!changesJellyfinEnabled && !changesPathSuffix) throw new ApiError(422, "jellyfin_settings_empty", "没有需要保存的 Jellyfin 设置");
      if (changesJellyfinEnabled && typeof request.body.jellyfinEnabled !== "boolean") {
        throw new ApiError(422, "jellyfin_enabled_invalid", "Jellyfin 开关必须是布尔值");
      }
      const pathSuffix = changesPathSuffix ? validateJellyfinPathSuffix(request.body.jellyfinPathSuffix) : null;
      const publicAccess = await runtime.publicAccess.getStatus();
      const now = new Date().toISOString();
      if (pathSuffix) {
        const duplicate = await runtime.database.query("media_libraries")
          .select("service_id")
          .where({ jellyfin_path_suffix_lookup: pathSuffix.lookup })
          .whereNot({ service_id: request.params.serviceId })
          .first();
        if (duplicate) throw new ApiError(409, "jellyfin_path_suffix_conflict", "该 Jellyfin 地址后缀已被使用，请更换后缀");
      }
      const updateValues: Record<string, unknown> = { updated_at: now };
      if (changesJellyfinEnabled) updateValues.jellyfin_enabled = request.body.jellyfinEnabled ? 1 : 0;
      if (pathSuffix) {
        updateValues.jellyfin_path_suffix = pathSuffix.value;
        updateValues.jellyfin_path_suffix_lookup = pathSuffix.lookup;
      }
      try {
        await runtime.database.query("media_libraries").where({ service_id: request.params.serviceId }).update(updateValues);
      } catch (error) {
        const databaseError = error as Error & { code?: string };
        const duplicateSuffix = databaseError.code === "23505"
          || databaseError.code === "ER_DUP_ENTRY"
          || /unique|duplicate/iu.test(databaseError.message);
        if (pathSuffix && duplicateSuffix) throw new ApiError(409, "jellyfin_path_suffix_conflict", "该 Jellyfin 地址后缀已被使用，请更换后缀");
        throw error;
      }
      const disabledJellyfin = changesJellyfinEnabled && request.body.jellyfinEnabled === false;
      const revokedCount = disabledJellyfin ? await runtime.serviceAccess.revokeSessions(request.params.serviceId, "jellyfin") : 0;
      runtime.logBusinessEvent("info", {
        日志关键字: "codex-jellyfin-path", 事件: pathSuffix ? "更新媒体库Jellyfin地址" : (request.body.jellyfinEnabled ? "启用媒体库Jellyfin协议" : "停用媒体库Jellyfin协议"),
        操作用户ID: operator.id, 基础服务ID: request.params.serviceId, 撤销会话数: revokedCount,
        Jellyfin地址后缀: pathSuffix?.value,
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
