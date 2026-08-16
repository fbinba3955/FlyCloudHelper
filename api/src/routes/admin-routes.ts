import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { authenticateUser, createUsernameLookup, hashPassword, validatePassword, validatePasswordConfirmation, validateUsername } from "../auth.js";
import type { JobStatus, MatchState, MediaType, ServiceStatus, UserRole, UserStatus } from "../domain.js";
import { ApiError, validationError } from "../errors.js";
import {
  readPagination,
  requireConfirmation,
  requireObject,
  requireString,
  requireSuperAdmin,
  toUserDto,
} from "../http.js";
import {
  applyManualVideoMatch,
  clearManualVideoMatch,
  searchManualVideoMatches,
} from "../media/manual-video-match.js";
import type { ApiRuntime } from "../runtime.js";
import { tmdbKeySettingName, validateTmdbKeyList } from "../system-settings.js";
import { streamJobEvents } from "./event-stream.js";
import {
  getScanRootsForMode,
  hasHttpProviderAddress,
  readProviderDirectoryParent,
  readVideoMetadataLogFields,
  validateConfiguredScanRoots,
  validateMetadataProfile,
  validateProviderAccess,
  validateScanProfile,
  validateServiceDataType,
} from "./service-routes.js";

/** 写入统一的超级管理员操作审计。 */
async function audit(
  runtime: ApiRuntime,
  operator: { id: string; username: string },
  operationType: string,
  targetType: string,
  targetId: string | null,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await runtime.database.addAudit({
    id: randomUUID(),
    operatorUserId: operator.id,
    operatorUsername: operator.username,
    operationType,
    targetType,
    targetId,
    result: "success",
    detail,
  });
}

/** 要求管理员用当前密码完成高风险角色操作的重新认证。 */
async function requireRecentAuthentication(runtime: ApiRuntime, operator: { username: string }, body: Record<string, unknown>): Promise<void> {
  if (typeof body.currentPassword !== "string") {
    throw validationError("currentPassword", "高风险操作需要输入当前管理员密码");
  }
  await authenticateUser(runtime.database, operator.username, body.currentPassword);
}

/** 返回不含 Key 原文或局部值的 TMDB 系统配置状态。 */
async function getTmdbConfigurationStatus(runtime: ApiRuntime) {
  const setting = await runtime.database.getSystemSecretSetting(tmdbKeySettingName);
  const status = runtime.tmdb.getStatus();
  return {
    source: status.configuredCount > 0 ? "system" : "missing",
    configurationRevision: setting?.revision ?? 0,
    ...status,
  };
}

/** 注册超级管理员的用户、服务、任务、目录与系统状态接口。 */
export async function registerAdminRoutes(server: FastifyInstance, runtime: ApiRuntime): Promise<void> {
  server.get("/api/v1/admin/status", async (request) => {
    await requireSuperAdmin(request, runtime.database);
    const [overview, userCount, state] = await Promise.all([
      runtime.repository.getOverview(),
      runtime.database.query("user_accounts").count<{ count: string | number }[]>({ count: "id" }).first(),
      runtime.database.getSystemState(),
    ]);
    return {
      service: "flycloud-helper",
      serviceInstanceId: state.serviceInstanceId,
      schemaVersion: state.schemaVersion,
      userCount: Number(userCount?.count ?? 0),
      ...overview,
      worker: runtime.worker.getStatus(),
      database: { type: runtime.config.databaseType, connected: true },
    };
  });

  server.get("/api/v1/admin/config/status", async (request) => {
    await requireSuperAdmin(request, runtime.database);
    const [pluginCount, enabledPluginCount, tmdbStatus] = await Promise.all([
      runtime.database.query("metadata_plugin_versions").count<{ count: string | number }[]>({ count: "id" }).first(),
      runtime.database.query("metadata_plugin_versions").where({ status: "enabled" }).count<{ count: string | number }[]>({ count: "id" }).first(),
      getTmdbConfigurationStatus(runtime),
    ]);
    return {
      database: { type: runtime.config.databaseType, schemaVersion: (await runtime.database.getSystemState()).schemaVersion },
      tmdb: tmdbStatus,
      music: {
        musicBrainz: { status: "unavailable", reasonCode: "media_type_not_enabled" },
        acoustId: {
          status: "unavailable",
          configured: Boolean(runtime.config.acoustidApiKey),
          reasonCode: "provider_media_stream_not_implemented",
        },
        fingerprint: {
          status: "unavailable",
          configured: Boolean(runtime.config.fpcalcPath),
          reasonCode: "provider_media_stream_not_implemented",
        },
      },
      credentials: { configured: Boolean(runtime.config.credentialMasterKey), source: runtime.config.credentialKeySource },
      plugins: {
        directoryReady: true,
        installedCount: Number(pluginCount?.count ?? 0),
        enabledCount: Number(enabledPluginCount?.count ?? 0),
      },
      worker: runtime.worker.getStatus(),
    };
  });

  server.put<{ Body: Record<string, unknown> }>("/api/v1/admin/config/tmdb-keys", async (request) => {
    const operator = await requireSuperAdmin(request, runtime.database);
    const keys = validateTmdbKeyList(request.body.keys);
    const configurationRevision = await runtime.database.saveSystemSecretSetting({
      settingKey: tmdbKeySettingName,
      encryptedPayload: runtime.vault.encrypt({ keys }),
      updatedByUserId: operator.id,
    });
    runtime.tmdb.replaceKeys(keys);
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-flycloud-helper-tmdb-config",
      事件: keys.length > 0 ? "更新TMDB系统配置" : "清空TMDB系统配置",
      用户ID: operator.id,
      配置修订: configurationRevision,
      Key数量: keys.length,
      有效并发: runtime.tmdb.getStatus().effectiveConcurrency,
    });
    await audit(runtime, operator, "update_tmdb_keys", "system_configuration", tmdbKeySettingName, {
      配置修订: configurationRevision,
      Key数量: keys.length,
    });
    return { tmdb: await getTmdbConfigurationStatus(runtime) };
  });

  server.get<{ Querystring: Record<string, unknown> }>("/api/v1/admin/users", async (request) => {
    await requireSuperAdmin(request, runtime.database);
    return runtime.database.listUsers({
      keyword: typeof request.query.search === "string" ? request.query.search : undefined,
      role: typeof request.query.role === "string" ? request.query.role as UserRole : undefined,
      status: typeof request.query.status === "string" ? request.query.status as UserStatus : undefined,
      ...readPagination(request.query),
    });
  });

  server.post<{ Body: Record<string, unknown> }>("/api/v1/admin/users", async (request, reply) => {
    const operator = await requireSuperAdmin(request, runtime.database);
    const username = validateUsername(request.body.username);
    const password = validatePassword(request.body.password);
    validatePasswordConfirmation(password, request.body.passwordConfirmation);
    const user = await runtime.database.createUser({
      userId: randomUUID(),
      tenantId: randomUUID(),
      username,
      usernameLookup: createUsernameLookup(username),
      passwordHash: await hashPassword(password),
      role: "user",
    });
    await audit(runtime, operator, "create_user", "user", user.id);
    return reply.status(201).send({ user: toUserDto(user) });
  });

  server.get<{ Params: { userId: string } }>("/api/v1/admin/users/:userId", async (request) => {
    await requireSuperAdmin(request, runtime.database);
    const user = await runtime.database.findPublicUserById(request.params.userId);
    const [services, jobs, overview] = await Promise.all([
      runtime.repository.listServices({ tenantId: user.tenantId, limit: 200, offset: 0 }),
      runtime.repository.listJobs({ tenantId: user.tenantId, limit: 50, offset: 0 }),
      runtime.repository.getOverview(user.tenantId),
    ]);
    return { user: toUserDto(user), overview, services: services.items, recentJobs: jobs.items };
  });

  server.post<{ Params: { userId: string }; Body: Record<string, unknown> }>("/api/v1/admin/users/:userId/password-reset", async (request, reply) => {
    const operator = await requireSuperAdmin(request, runtime.database);
    const password = validatePassword(request.body.password);
    validatePasswordConfirmation(password, request.body.passwordConfirmation);
    await runtime.database.resetUserPassword(request.params.userId, await hashPassword(password));
    await audit(runtime, operator, "reset_user_password", "user", request.params.userId);
    return reply.status(204).send();
  });

  server.put<{ Params: { userId: string }; Body: Record<string, unknown> }>("/api/v1/admin/users/:userId/role", async (request) => {
    const operator = await requireSuperAdmin(request, runtime.database);
    requireConfirmation(request.body, request.params.userId);
    await requireRecentAuthentication(runtime, operator, request.body);
    const role = request.body.role;
    if (role !== "user" && role !== "super_admin") {
      throw validationError("role", "角色只支持 user 或 super_admin");
    }
    const user = await runtime.database.updateUserRole(request.params.userId, role);
    await audit(runtime, operator, "update_user_role", "user", user.id, { 新角色: role });
    return { user: toUserDto(user) };
  });

  server.patch<{ Params: { userId: string }; Body: Record<string, unknown> }>("/api/v1/admin/users/:userId/status", async (request) => {
    const operator = await requireSuperAdmin(request, runtime.database);
    const status = request.body.status;
    if (status !== "active" && status !== "disabled") {
      throw validationError("status", "用户状态只支持 active 或 disabled");
    }
    const user = await runtime.database.updateUserStatus(request.params.userId, status);
    await audit(runtime, operator, "update_user_status", "user", user.id, { 新状态: status });
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-flycloud-helper-user-action",
      事件: status === "active" ? "启用用户" : "停用用户",
      用户ID: operator.id,
      目标用户ID: user.id,
    });
    return { user: toUserDto(user) };
  });

  server.post<{ Params: { userId: string } }>("/api/v1/admin/users/:userId/sessions/revoke", async (request, reply) => {
    const operator = await requireSuperAdmin(request, runtime.database);
    await runtime.database.findPublicUserById(request.params.userId);
    await runtime.database.revokeAllUserSessions(request.params.userId);
    await audit(runtime, operator, "revoke_user_sessions", "user", request.params.userId);
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-flycloud-helper-user-action",
      事件: "撤销用户全部会话",
      用户ID: operator.id,
      目标用户ID: request.params.userId,
    });
    return reply.status(204).send();
  });

  server.delete<{ Params: { userId: string }; Body: Record<string, unknown> }>("/api/v1/admin/users/:userId", async (request, reply) => {
    const operator = await requireSuperAdmin(request, runtime.database);
    requireConfirmation(request.body, request.params.userId);
    if (request.params.userId === operator.id) {
      throw new ApiError(409, "cannot_delete_current_user", "不能删除当前登录的超级管理员");
    }
    await runtime.database.updateUserStatus(request.params.userId, "pending_delete");
    await audit(runtime, operator, "schedule_user_delete", "user", request.params.userId);
    return reply.status(202).send({ status: "pending_delete" });
  });

  server.get<{ Querystring: Record<string, unknown> }>("/api/v1/admin/services", async (request) => {
    await requireSuperAdmin(request, runtime.database);
    return runtime.repository.listServices({
      ownerUserId: typeof request.query.userId === "string" ? request.query.userId : undefined,
      providerType: typeof request.query.providerType === "string" ? request.query.providerType : undefined,
      status: typeof request.query.status === "string" ? request.query.status as ServiceStatus : undefined,
      keyword: typeof request.query.search === "string" ? request.query.search : undefined,
      ...readPagination(request.query),
    });
  });

  server.post<{ Body: Record<string, unknown> }>("/api/v1/admin/services", async (request, reply) => {
    const operator = await requireSuperAdmin(request, runtime.database);
    const owner = await runtime.database.findPublicUserById(requireString(request.body, "userId", "目标用户 ID", 100));
    const dataType = validateServiceDataType(request.body.dataType);
    const provider = requireObject(request.body, "provider", "Provider");
    const providerType = requireString(provider, "type", "Provider 类型", 64);
    const connection = requireObject(provider, "connection", "连接配置");
    const adapter = runtime.providers.get(providerType);
    const scanProfile = validateScanProfile(
      request.body.scan === undefined
        ? { fullRoots: [], incrementalRoots: [] }
        : requireObject(request.body, "scan", "扫描配置"),
      providerType,
      dataType,
      adapter.descriptor.recommendedScanSettings,
    );
    await validateProviderAccess(adapter, connection, scanProfile);
    const service = await runtime.repository.createService({
      serviceId: randomUUID(),
      libraryId: randomUUID(),
      tenantId: owner.tenantId,
      ownerUserId: owner.id,
      displayName: requireString(request.body, "displayName", "服务名称", 100),
      providerType,
      dataType,
      encryptedConnection: runtime.vault.encrypt(connection),
      providerSchemaVersion: adapter.descriptor.credentialSchemaVersion,
      scanProfile,
      metadataProfile: validateMetadataProfile(
        requireObject(request.body, "metadata", "元数据配置"),
        dataType,
      ),
    });
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-flycloud-helper-service-data-type",
      事件: "管理员创建云端服务",
      用户ID: operator.id,
      服务ID: service.id,
      网盘类型: providerType,
      数据类型: dataType,
      自动创建扫描任务: false,
    });
    if (hasHttpProviderAddress(connection)) {
      runtime.logBusinessEvent("info", {
        日志关键字: "codex-flycloud-helper-provider-http",
        事件: "管理员使用HTTP地址创建Provider服务",
        用户ID: operator.id,
        服务ID: service.id,
        网盘类型: providerType,
      });
    }
    await audit(runtime, operator, "create_service", "service", service.id, {
      目标用户ID: owner.id,
      网盘类型: providerType,
      数据类型: dataType,
    });
    return reply.status(201).send({ service });
  });

  server.get<{ Params: { serviceId: string } }>("/api/v1/admin/services/:serviceId", async (request) => {
    await requireSuperAdmin(request, runtime.database);
    return { service: await runtime.repository.getServiceDetail(request.params.serviceId) };
  });

  server.get<{ Params: { serviceId: string }; Querystring: Record<string, unknown> }>("/api/v1/admin/services/:serviceId/directories", async (request) => {
    const operator = await requireSuperAdmin(request, runtime.database);
    const service = await runtime.repository.getServiceDetail(request.params.serviceId);
    const connection = runtime.vault.decrypt(await runtime.repository.getActiveEncryptedConnection(service.id, service.tenantId));
    const listing = await runtime.providers.get(service.providerType).browseDirectories(
      connection,
      readProviderDirectoryParent(request.query),
    );
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-flycloud-helper-directory-picker",
      事件: "管理员浏览网盘目录",
      管理员ID: operator.id,
      服务ID: service.id,
      网盘类型: service.providerType,
      子目录数量: listing.items.length,
    });
    return listing;
  });

  server.post<{ Params: { serviceId: string }; Body: Record<string, unknown> }>("/api/v1/admin/services/:serviceId/connection/validate", async (request) => {
    await requireSuperAdmin(request, runtime.database);
    const service = await runtime.repository.getServiceDetail(request.params.serviceId);
    return runtime.providers.get(service.providerType).validateConnection(requireObject(request.body, "connection", "连接配置"));
  });

  server.put<{ Params: { serviceId: string }; Body: Record<string, unknown> }>("/api/v1/admin/services/:serviceId/connection", async (request) => {
    const operator = await requireSuperAdmin(request, runtime.database);
    const service = await runtime.repository.getServiceDetail(request.params.serviceId);
    const connection = requireObject(request.body, "connection", "连接配置");
    const adapter = runtime.providers.get(service.providerType);
    await validateProviderAccess(adapter, connection, service.scanProfile);
    const updated = await runtime.repository.updateConnection({
      serviceId: service.id,
      tenantId: service.tenantId,
      encryptedConnection: runtime.vault.encrypt(connection),
      providerSchemaVersion: adapter.descriptor.credentialSchemaVersion,
    });
    if (hasHttpProviderAddress(connection)) {
      runtime.logBusinessEvent("info", {
        日志关键字: "codex-flycloud-helper-provider-http",
        事件: "管理员使用HTTP地址更新Provider连接",
        用户ID: operator.id,
        服务ID: service.id,
        网盘类型: service.providerType,
      });
    }
    await audit(runtime, operator, "update_service_connection", "service", service.id);
    return { service: updated };
  });

  server.post<{ Params: { serviceId: string } }>("/api/v1/admin/services/:serviceId/connection/reconnect", async (request) => {
    const operator = await requireSuperAdmin(request, runtime.database);
    const service = await runtime.repository.getServiceDetail(request.params.serviceId);
    const adapter = runtime.providers.get(service.providerType);
    const connection = runtime.vault.decrypt(
      await runtime.repository.getActiveEncryptedConnection(service.id, service.tenantId),
    );
    try {
      await validateProviderAccess(adapter, connection, service.scanProfile);
    } catch (error) {
      runtime.logBusinessEvent("warn", {
        日志关键字: "codex-flycloud-helper-provider-reconnect",
        事件: "管理员使用当前配置重连失败",
        管理员ID: operator.id,
        服务ID: service.id,
        网盘类型: service.providerType,
        错误码: error && typeof error === "object" && "code" in error
          ? String((error as { code?: string }).code)
          : "provider_reconnect_failed",
      });
      throw error;
    }
    const updated = await runtime.repository.restoreServiceConnection(service.id, service.tenantId);
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-flycloud-helper-provider-reconnect",
      事件: "管理员使用当前配置重连成功",
      管理员ID: operator.id,
      服务ID: service.id,
      网盘类型: service.providerType,
      凭据修订: service.credentialRevision,
    });
    await audit(runtime, operator, "reconnect_service_connection", "service", service.id, {
      凭据修订: service.credentialRevision,
    });
    return { service: updated };
  });

  server.put<{ Params: { serviceId: string }; Body: Record<string, unknown> }>("/api/v1/admin/services/:serviceId/scan-profile", async (request) => {
    const operator = await requireSuperAdmin(request, runtime.database);
    const service = await runtime.repository.getServiceDetail(request.params.serviceId);
    const scanProfile = validateScanProfile(
      requireObject(request.body, "scan", "扫描配置"),
      service.providerType,
      service.dataType,
      runtime.providers.get(service.providerType).descriptor.recommendedScanSettings,
    );
    const connection = runtime.vault.decrypt(await runtime.repository.getActiveEncryptedConnection(service.id, service.tenantId));
    await validateConfiguredScanRoots(runtime.providers.get(service.providerType), connection, scanProfile);
    const updated = await runtime.repository.updateScanProfile(
      service.id,
      service.tenantId,
      scanProfile,
    );
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-flycloud-helper-scan-path",
      事件: "管理员更新服务扫描路径",
      用户ID: operator.id,
      服务ID: service.id,
      全量路径数: getScanRootsForMode(scanProfile, "full").length,
      增量路径数: getScanRootsForMode(scanProfile, "incremental").length,
      扫描目录并发: scanProfile.scanDirectoryConcurrency,
      刮削任务并发: scanProfile.scrapeTaskConcurrency,
    });
    await audit(runtime, operator, "update_service_scan_profile", "service", service.id);
    return { service: updated };
  });

  server.put<{ Params: { serviceId: string }; Body: Record<string, unknown> }>("/api/v1/admin/services/:serviceId/metadata-profile", async (request) => {
    const operator = await requireSuperAdmin(request, runtime.database);
    const service = await runtime.repository.getServiceDetail(request.params.serviceId);
    const updated = await runtime.repository.updateMetadataProfile(
      service.id,
      service.tenantId,
      validateMetadataProfile(requireObject(request.body, "metadata", "元数据配置"), service.dataType),
    );
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-flycloud-helper-metadata-profile",
      事件: "管理员更新影视元数据配置",
      管理员ID: operator.id,
      服务ID: service.id,
      ...readVideoMetadataLogFields(updated.metadataProfile),
    });
    await audit(runtime, operator, "update_service_metadata_profile", "service", service.id);
    return { service: updated };
  });

  server.post<{ Params: { serviceId: string }; Body: Record<string, unknown> }>("/api/v1/admin/services/:serviceId/scan-jobs", async (request, reply) => {
    const operator = await requireSuperAdmin(request, runtime.database);
    const service = await runtime.repository.getServiceDetail(request.params.serviceId);
    const scanMode = request.body.scanMode;
    if (scanMode !== "incremental" && scanMode !== "full") throw validationError("scanMode", "扫描模式无效");
    if (getScanRootsForMode(service.scanProfile, scanMode).length === 0) {
      throw new ApiError(409, "scan_paths_not_configured", `请先配置${scanMode === "full" ? "全量" : "增量"}扫描路径`);
    }
    const job = await runtime.repository.createScanJob({
      jobId: randomUUID(),
      tenantId: service.tenantId,
      serviceId: service.id,
      requestedByUserId: operator.id,
      requestId: requireString(request.body, "requestId", "请求 ID", 200),
      clientDeviceId: typeof request.body.clientDeviceId === "string" ? request.body.clientDeviceId : `admin:${operator.id}`,
      scanMode,
      runtimeRevision: "scanner-worker-v1",
      tmdbKeyPoolRevision: runtime.tmdb.revision,
      pluginVersions: await runtime.plugins.buildTaskSnapshots(service.metadataProfile),
    });
    await audit(runtime, operator, "create_scan_job", "scan_job", job.id, { 服务ID: service.id });
    return reply.status(202).send({ job });
  });

  server.patch<{ Params: { serviceId: string }; Body: Record<string, unknown> }>("/api/v1/admin/services/:serviceId/status", async (request) => {
    const operator = await requireSuperAdmin(request, runtime.database);
    const status = request.body.status;
    if (status !== "active" && status !== "disabled") throw validationError("status", "服务状态无效");
    const service = await runtime.repository.updateServiceStatus(request.params.serviceId, undefined, status);
    await audit(runtime, operator, "update_service_status", "service", service.id, { 新状态: status });
    return { service };
  });

  server.delete<{ Params: { serviceId: string }; Body: Record<string, unknown> }>("/api/v1/admin/services/:serviceId", async (request, reply) => {
    const operator = await requireSuperAdmin(request, runtime.database);
    requireConfirmation(request.body, request.params.serviceId);
    await runtime.repository.deleteService(request.params.serviceId);
    await audit(runtime, operator, "delete_service", "service", request.params.serviceId);
    return reply.status(204).send();
  });

  server.delete<{ Params: { serviceId: string }; Body: Record<string, unknown> }>("/api/v1/admin/services/:serviceId/catalog", async (request) => {
    const operator = await requireSuperAdmin(request, runtime.database);
    requireConfirmation(request.body, request.params.serviceId);
    const cleared = await runtime.repository.clearServiceCatalog(request.params.serviceId);
    await audit(runtime, operator, "clear_service_catalog", "service", request.params.serviceId, {
      清空媒体条目数: cleared.mediaItemCount,
      清空源文件数: cleared.sourceFileCount,
    });
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-flycloud-helper-catalog-clear",
      事件: "管理员清空服务媒体库",
      管理员ID: operator.id,
      服务ID: request.params.serviceId,
      清空媒体条目数: cleared.mediaItemCount,
      清空源文件数: cleared.sourceFileCount,
    });
    return cleared;
  });

  server.get<{ Querystring: Record<string, unknown> }>("/api/v1/admin/jobs", async (request) => {
    await requireSuperAdmin(request, runtime.database);
    return runtime.repository.listJobs({
      ownerUserId: typeof request.query.userId === "string" ? request.query.userId : undefined,
      serviceId: typeof request.query.serviceId === "string" ? request.query.serviceId : undefined,
      status: typeof request.query.status === "string" ? request.query.status as JobStatus : undefined,
      ...readPagination(request.query),
    });
  });

  server.get<{ Params: { jobId: string } }>("/api/v1/admin/jobs/:jobId", async (request) => {
    await requireSuperAdmin(request, runtime.database);
    return { job: await runtime.repository.getJob(request.params.jobId) };
  });

  server.post<{ Params: { jobId: string } }>("/api/v1/admin/jobs/:jobId/cancel", async (request) => {
    const operator = await requireSuperAdmin(request, runtime.database);
    const job = await runtime.repository.requestJobControl(request.params.jobId, undefined, "cancel");
    await audit(runtime, operator, "cancel_scan_job", "scan_job", job.id);
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-flycloud-helper-job-control",
      事件: "管理员终止扫描任务",
      管理员ID: operator.id,
      任务ID: job.id,
      控制动作: "cancel",
    });
    return { job };
  });

  server.post<{ Params: { jobId: string } }>("/api/v1/admin/jobs/:jobId/pause", async (request) => {
    const operator = await requireSuperAdmin(request, runtime.database);
    const job = await runtime.repository.requestJobControl(request.params.jobId, undefined, "pause");
    await audit(runtime, operator, "pause_scan_job", "scan_job", job.id);
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-flycloud-helper-job-control",
      事件: "管理员暂停扫描任务",
      管理员ID: operator.id,
      任务ID: job.id,
      控制动作: "pause",
    });
    return { job };
  });

  server.post<{ Params: { jobId: string } }>("/api/v1/admin/jobs/:jobId/resume", async (request) => {
    const operator = await requireSuperAdmin(request, runtime.database);
    const job = await runtime.repository.resumeJob(request.params.jobId);
    await audit(runtime, operator, "resume_scan_job", "scan_job", job.id);
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-flycloud-helper-job-control",
      事件: "管理员继续扫描任务",
      管理员ID: operator.id,
      任务ID: job.id,
      控制动作: "resume",
    });
    return { job };
  });

  server.delete<{ Params: { jobId: string }; Body: Record<string, unknown> }>("/api/v1/admin/jobs/:jobId", async (request, reply) => {
    const operator = await requireSuperAdmin(request, runtime.database);
    requireConfirmation(request.body, request.params.jobId);
    await runtime.repository.deleteScanJob(request.params.jobId);
    await audit(runtime, operator, "delete_scan_job", "scan_job", request.params.jobId);
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-flycloud-helper-job-delete",
      事件: "管理员删除扫描任务",
      管理员ID: operator.id,
      任务ID: request.params.jobId,
    });
    return reply.status(204).send();
  });

  /** 管理员为失败或已取消任务创建新的关联重试任务，原任务记录保持不变。 */
  server.post<{ Params: { jobId: string }; Body: Record<string, unknown> }>("/api/v1/admin/jobs/:jobId/retry", async (request, reply) => {
    const operator = await requireSuperAdmin(request, runtime.database);
    const sourceJob = await runtime.repository.getJob(request.params.jobId);
    if (sourceJob.status !== "failed" && sourceJob.status !== "cancelled") {
      throw new ApiError(409, "job_not_retryable", "只有失败或已取消任务可以重试");
    }
    const service = await runtime.repository.getServiceDetail(sourceJob.serviceId, sourceJob.tenantId);
    const job = await runtime.repository.createScanJob({
      jobId: randomUUID(),
      tenantId: sourceJob.tenantId,
      serviceId: sourceJob.serviceId,
      requestedByUserId: operator.id,
      requestId: requireString(request.body, "requestId", "请求 ID", 200),
      clientDeviceId: typeof request.body.clientDeviceId === "string" ? request.body.clientDeviceId : `admin:${operator.id}`,
      scanMode: sourceJob.scanMode,
      runtimeRevision: "scanner-worker-v1",
      tmdbKeyPoolRevision: runtime.tmdb.revision,
      retryOfJobId: sourceJob.id,
      pluginVersions: await runtime.plugins.buildTaskSnapshots(service.metadataProfile),
    });
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-flycloud-helper-job-retry",
      事件: "管理员重试扫描任务",
      管理员ID: operator.id,
      原任务ID: sourceJob.id,
      新任务ID: job.id,
      服务ID: job.serviceId,
    });
    await audit(runtime, operator, "retry_scan_job", "scan_job", job.id, { 原任务ID: sourceJob.id });
    return reply.status(202).send({ job });
  });

  server.get<{ Querystring: Record<string, unknown> }>("/api/v1/admin/jobs/events", async (request, reply) => {
    await requireSuperAdmin(request, runtime.database);
    const jobId = typeof request.query.jobId === "string" ? request.query.jobId : undefined;
    let tenantId: string | undefined;
    if (typeof request.query.userId === "string") {
      tenantId = (await runtime.database.findPublicUserById(request.query.userId)).tenantId;
    }
    if (jobId) await runtime.repository.getJob(jobId, tenantId);
    const headerValue = request.headers["last-event-id"];
    const sequence = Math.max(0, Number.parseInt(String(headerValue ?? request.query.afterSequence ?? 0), 10) || 0);
    streamJobEvents(reply, sequence, (afterSequence) => runtime.repository.listJobEvents({
      tenantId,
      jobId,
      afterSequence,
      limit: 200,
    }));
  });

  server.get<{ Querystring: Record<string, unknown> }>("/api/v1/admin/catalog/items", async (request) => {
    await requireSuperAdmin(request, runtime.database);
    const ownerUserId = typeof request.query.userId === "string" ? request.query.userId : undefined;
    const serviceId = typeof request.query.serviceId === "string" ? request.query.serviceId : undefined;
    if (!ownerUserId && !serviceId) {
      throw validationError("userId", "全局海报墙必须指定用户或服务范围");
    }
    const sortValue = request.query.sort;
    return runtime.repository.listCatalogItems({
      ownerUserId,
      serviceId,
      libraryId: typeof request.query.libraryId === "string" ? request.query.libraryId : undefined,
      mediaType: typeof request.query.mediaType === "string" ? request.query.mediaType as MediaType : undefined,
      itemType: typeof request.query.itemType === "string" ? request.query.itemType : undefined,
      matchState: typeof request.query.matchState === "string" ? request.query.matchState as MatchState : undefined,
      search: typeof request.query.search === "string" ? request.query.search : undefined,
      sort: sortValue === "title_asc"
        || sortValue === "year_desc"
        || sortValue === "premiere_date_desc"
        ? sortValue
        : "created_desc",
      ...readPagination(request.query),
    });
  });

  server.get<{ Params: { itemId: string } }>("/api/v1/admin/catalog/items/:itemId", async (request) => {
    await requireSuperAdmin(request, runtime.database);
    return { item: await runtime.repository.getCatalogItem(request.params.itemId) };
  });

  server.get<{ Params: { itemId: string } }>("/api/v1/admin/catalog/items/:itemId/children", async (request) => {
    await requireSuperAdmin(request, runtime.database);
    return { items: await runtime.repository.listCatalogChildren(request.params.itemId) };
  });

  server.get<{ Params: { itemId: string } }>("/api/v1/admin/catalog/items/:itemId/paths", async (request) => {
    await requireSuperAdmin(request, runtime.database);
    return { items: await runtime.repository.listCatalogItemPaths(request.params.itemId) };
  });

  server.get<{
    Params: { itemId: string };
    Querystring: Record<string, unknown>;
  }>("/api/v1/admin/catalog/items/:itemId/manual-match/search", async (request) => {
    await requireSuperAdmin(request, runtime.database);
    const item = await runtime.repository.getCatalogItem(request.params.itemId);
    return {
      items: await searchManualVideoMatches(runtime, item, {
        query: request.query.query,
        mediaType: request.query.mediaType,
        year: request.query.year,
      }),
    };
  });

  server.post<{
    Params: { itemId: string };
    Body: Record<string, unknown>;
  }>("/api/v1/admin/catalog/items/:itemId/manual-match", async (request) => {
    const operator = await requireSuperAdmin(request, runtime.database);
    const item = await runtime.repository.getCatalogItem(request.params.itemId);
    const updatedItem = await applyManualVideoMatch(runtime, item, {
      mediaType: request.body.mediaType,
      tmdbId: request.body.tmdbId,
    });
    await audit(runtime, operator, "manual_match_media_item", "media_item", item.id, {
      匹配类型: request.body.mediaType,
      TMDB编号: request.body.tmdbId,
      所属用户: item.ownerUsername,
    });
    return { item: updatedItem };
  });

  server.post<{ Params: { itemId: string } }>("/api/v1/admin/catalog/items/:itemId/manual-match/clear", async (request) => {
    const operator = await requireSuperAdmin(request, runtime.database);
    const item = await runtime.repository.getCatalogItem(request.params.itemId);
    const updatedItem = await clearManualVideoMatch(runtime, item);
    await audit(runtime, operator, "clear_media_item_match", "media_item", item.id, {
      所属用户: item.ownerUsername,
    });
    return { item: updatedItem };
  });

  server.get<{ Querystring: Record<string, unknown> }>("/api/v1/admin/audit-logs", async (request) => {
    await requireSuperAdmin(request, runtime.database);
    const pagination = readPagination(request.query);
    return runtime.database.listAuditLogs(pagination.limit, pagination.offset);
  });
}
