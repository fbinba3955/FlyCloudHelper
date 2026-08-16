import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { JobStatus, MediaType, ServiceStatus } from "../domain.js";
import { ApiError, validationError } from "../errors.js";
import {
  readPagination,
  requireConfirmation,
  requireObject,
  requireRequestUser,
  requireString,
} from "../http.js";
import type { ApiRuntime } from "../runtime.js";
import {
  createFlymbyRecommendedScanSettings,
  type ProviderAdapter,
  type ProviderRecommendedScanSettings,
  type ScanRoot,
} from "../providers/types.js";
import { streamJobEvents } from "./event-stream.js";

/** 当前版本允许创建的服务数据类型；保留 MediaType 联合类型便于后续扩展。 */
const supportedServiceDataTypes = new Set<MediaType>(["video"]);

/** 校验服务级数据类型，本阶段只开放影视。 */
export function validateServiceDataType(value: unknown): MediaType {
  if (typeof value !== "string" || !supportedServiceDataTypes.has(value as MediaType)) {
    throw validationError("dataType", "本阶段服务数据类型仅支持影视");
  }
  return value as MediaType;
}

/** 判断连接配置中是否包含明文 HTTP Provider 地址，不记录完整地址。 */
export function hasHttpProviderAddress(connection: Record<string, unknown>): boolean {
  return Object.values(connection).some((value) => typeof value === "string" && /^http:\/\//iu.test(value.trim()));
}

/** 校验单个扫描根并移除未声明字段。 */
function validateScanRoot(
  value: unknown,
  index: number,
  fieldName: "fullRoots" | "incrementalRoots" | "roots",
  providerType?: string,
  serviceDataType: MediaType = "video",
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw validationError(`scan.${fieldName}.${index}`, "扫描路径必须是对象");
  }
  const root = value as Record<string, unknown>;
  const readOptionalString = (field: "resourceId" | "displayPath" | "driveId", maxLength: number) => {
    const fieldValue = root[field];
    if (fieldValue === undefined || fieldValue === null || fieldValue === "") {
      return undefined;
    }
    if (typeof fieldValue !== "string" || fieldValue.length > maxLength || fieldValue.includes("\0")) {
      throw validationError(`scan.${fieldName}.${index}.${field}`, `${field} 格式无效`);
    }
    return fieldValue.trim();
  };
  const resourceId = readOptionalString("resourceId", 500);
  const displayPath = readOptionalString("displayPath", 2000);
  const driveId = readOptionalString("driveId", 500);
  if (!resourceId && !displayPath) {
    throw validationError(`scan.${fieldName}.${index}`, "扫描路径必须包含 resourceId 或 displayPath");
  }
  if (providerType === "webdav") {
    for (const pathValue of [resourceId, displayPath]) {
      if (pathValue && (/^[a-z][a-z\d+.-]*:/iu.test(pathValue)
        || pathValue.startsWith("//")
        || pathValue.startsWith("\\")
        || pathValue.includes("?")
        || pathValue.includes("#")
        || pathValue.split(/[\\/]+/u).includes(".."))) {
        throw validationError(`scan.${fieldName}.${index}`, "WebDAV 扫描路径只能使用站内路径");
      }
    }
  }
  const allowedMediaTypes = new Set<MediaType>([serviceDataType]);
  const rootMediaTypes = root.mediaTypes;
  if (rootMediaTypes !== undefined && (!Array.isArray(rootMediaTypes)
    || rootMediaTypes.some((item) => typeof item !== "string" || !allowedMediaTypes.has(item)))) {
    throw validationError(`scan.${fieldName}.${index}.mediaTypes`, "扫描根媒体类型必须与服务数据类型一致，本阶段仅支持影视");
  }
  return {
    ...(resourceId ? { resourceId } : {}),
    ...(displayPath ? { displayPath } : {}),
    ...(driveId ? { driveId } : {}),
    ...(Array.isArray(rootMediaTypes) && rootMediaTypes.length > 0 ? { mediaTypes: rootMediaTypes } : {}),
  };
}

/** 校验全量或增量扫描路径数组。 */
function validateScanRoots(
  value: unknown,
  fieldName: "fullRoots" | "incrementalRoots" | "roots",
  providerType?: string,
  serviceDataType: MediaType = "video",
): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw validationError(`scan.${fieldName}`, "扫描路径必须是数组");
  }
  if (value.length > 100) {
    throw validationError(`scan.${fieldName}`, "每种扫描模式最多支持 100 个根目录");
  }
  return value.map((root, index) => validateScanRoot(root, index, fieldName, providerType, serviceDataType));
}

/** 读取指定扫描模式的路径，并兼容已经保存的旧版 roots 配置。 */
export function getScanRootsForMode(
  profile: Record<string, unknown>,
  scanMode: "incremental" | "full",
): ScanRoot[] {
  const selectedRoots = scanMode === "full" ? profile.fullRoots : profile.incrementalRoots;
  const roots = Array.isArray(selectedRoots)
    ? selectedRoots
    : Array.isArray(profile.roots) ? profile.roots : [];
  return roots.filter((root): root is ScanRoot => Boolean(root && typeof root === "object"));
}

/** 读取路径选择器的当前目录参数；空参数表示 Provider 根目录。 */
export function readProviderDirectoryParent(query: Record<string, unknown>): ScanRoot | undefined {
  const readOptionalValue = (field: "resourceId" | "displayPath" | "driveId", maxLength: number): string | undefined => {
    const value = query[field];
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value !== "string" || value.length > maxLength || value.includes("\0")) {
      throw validationError(field, "目录参数格式无效");
    }
    return value.trim();
  };
  const resourceId = readOptionalValue("resourceId", 500);
  const displayPath = readOptionalValue("displayPath", 2000);
  const driveId = readOptionalValue("driveId", 500);
  if (!resourceId && !displayPath && !driveId) return undefined;
  if (!resourceId && !displayPath) {
    throw validationError("directory", "目录必须包含资源 ID 或显示路径");
  }
  return {
    ...(resourceId ? { resourceId } : {}),
    ...(displayPath ? { displayPath } : {}),
    ...(driveId ? { driveId } : {}),
  };
}

/** 校验服务创建和更新使用的扫描配置。 */
export function validateScanProfile(
  profile: Record<string, unknown>,
  providerType?: string,
  serviceDataType: MediaType = "video",
  recommendedSettings: ProviderRecommendedScanSettings = createFlymbyRecommendedScanSettings(),
): Record<string, unknown> {
  const legacyRoots = profile.roots === undefined
    ? []
    : validateScanRoots(profile.roots, "roots", providerType, serviceDataType);
  const fullRoots = profile.fullRoots === undefined
    ? legacyRoots
    : validateScanRoots(profile.fullRoots, "fullRoots", providerType, serviceDataType);
  const incrementalRoots = profile.incrementalRoots === undefined
    ? legacyRoots
    : validateScanRoots(profile.incrementalRoots, "incrementalRoots", providerType, serviceDataType);
  if (profile.mediaTypes !== undefined && !Array.isArray(profile.mediaTypes)) {
    throw validationError("scan.mediaTypes", "媒体类型必须是数组");
  }
  const mediaTypes = Array.isArray(profile.mediaTypes) ? profile.mediaTypes : [];
  if (mediaTypes.some((value) => value !== serviceDataType)) {
    throw validationError("scan.mediaTypes", "扫描媒体类型必须与服务数据类型一致，本阶段仅支持影视");
  }
  const {
    roots: _legacyRoots,
    fullRoots: _fullRoots,
    incrementalRoots: _incrementalRoots,
    ...otherProfile
  } = profile;
  /** 校验单个并发设置，缺省时直接采用 Provider 推荐值。 */
  const readConcurrency = (
    fieldName: "scanDirectoryConcurrency" | "scrapeTaskConcurrency",
    range: { default: number; min: number; max: number },
  ): number => {
    const value = profile[fieldName];
    if (value === undefined) return range.default;
    if (typeof value !== "number" || !Number.isInteger(value) || value < range.min || value > range.max) {
      const fieldLabel = fieldName === "scanDirectoryConcurrency" ? "扫描任务数" : "刮削任务数";
      throw validationError(`scan.${fieldName}`, `${fieldLabel}必须是 ${range.min}–${range.max} 之间的整数`);
    }
    return value;
  };
  return {
    ...otherProfile,
    fullRoots,
    incrementalRoots,
    mediaTypes: mediaTypes.length > 0 ? mediaTypes : [serviceDataType],
    removedRootPolicy: profile.removedRootPolicy === "delete_missing" ? "delete_missing" : "protect",
    scanDirectoryConcurrency: readConcurrency(
      "scanDirectoryConcurrency",
      recommendedSettings.scanDirectoryConcurrency,
    ),
    scrapeTaskConcurrency: readConcurrency(
      "scrapeTaskConcurrency",
      recommendedSettings.scrapeTaskConcurrency,
    ),
  };
}

/** 验证扫描配置中已经填写的全量和增量路径。 */
export async function validateConfiguredScanRoots(
  adapter: ProviderAdapter,
  connection: Record<string, unknown>,
  scanProfile: Record<string, unknown>,
): Promise<void> {
  const fullRoots = getScanRootsForMode(scanProfile, "full");
  const incrementalRoots = getScanRootsForMode(scanProfile, "incremental");
  if (fullRoots.length > 0) {
    await adapter.validateRoots(connection, fullRoots);
  }
  if (incrementalRoots.length > 0) {
    await adapter.validateRoots(connection, incrementalRoots);
  }
}

/** 校验元数据 Profile 外层结构以及服务数据类型边界。 */
export function validateMetadataProfile(
  profile: Record<string, unknown>,
  serviceDataType: MediaType = "video",
): Record<string, unknown> {
  if (!profile.profiles || typeof profile.profiles !== "object" || Array.isArray(profile.profiles)) {
    throw validationError("metadata.profiles", "元数据配置必须包含 profiles 对象");
  }
  const profiles = profile.profiles as Record<string, unknown>;
  if (Object.keys(profiles).some((mediaType) => mediaType !== serviceDataType)) {
    throw validationError("metadata.profiles", "元数据配置必须与服务数据类型一致，本阶段仅支持影视");
  }
  const selectedProfile = profiles[serviceDataType];
  if (!selectedProfile || typeof selectedProfile !== "object" || Array.isArray(selectedProfile)) {
    throw validationError(`metadata.profiles.${serviceDataType}`, "影视元数据配置必须是对象");
  }
  const metadataSettings = selectedProfile as Record<string, unknown>;
  if (metadataSettings.useNfo !== undefined && typeof metadataSettings.useNfo !== "boolean") {
    throw validationError(`metadata.profiles.${serviceDataType}.useNfo`, "本地 NFO 开关必须是布尔值");
  }
  return profile;
}

/** 提取不含敏感信息的影视元数据配置，用于统一业务日志。 */
export function readVideoMetadataLogFields(profile: Record<string, unknown>): Record<string, unknown> {
  const profiles = profile.profiles && typeof profile.profiles === "object" && !Array.isArray(profile.profiles)
    ? profile.profiles as Record<string, unknown>
    : {};
  const videoProfile = profiles.video && typeof profiles.video === "object" && !Array.isArray(profiles.video)
    ? profiles.video as Record<string, unknown>
    : {};
  const firstSource = Array.isArray(videoProfile.sources)
    ? videoProfile.sources.find((item) => typeof item === "string")
    : undefined;
  return {
    元数据来源: typeof videoProfile.providerId === "string" ? videoProfile.providerId : firstSource ?? "builtin.tmdb",
    元数据语言: typeof videoProfile.language === "string" ? videoProfile.language : "zh-CN",
    内容地区: typeof videoProfile.region === "string" ? videoProfile.region : "CN",
    使用本地NFO: videoProfile.useNfo !== false,
  };
}

/** 同时验证 Provider 账号连接和本次配置的全部扫描根。 */
export async function validateProviderAccess(
  adapter: ProviderAdapter,
  connection: Record<string, unknown>,
  scanProfile: Record<string, unknown>,
): Promise<void> {
  const validation = await adapter.validateConnection(connection);
  if (!validation.valid || !validation.rootAccessible) {
    throw new ApiError(422, "provider_connection_invalid", "网盘连接或根目录不可用");
  }
  await validateConfiguredScanRoots(adapter, connection, scanProfile);
}

/** 从 SSE 请求读取兼容 Header 和查询参数的事件游标。 */
function readEventSequence(headers: Record<string, unknown>, query: Record<string, unknown>): number {
  const value = headers["last-event-id"] ?? query.afterSequence ?? 0;
  return Math.max(0, Number.parseInt(String(value), 10) || 0);
}

/** 注册普通用户作用域的服务、任务、连接和配置接口。 */
export async function registerServiceRoutes(server: FastifyInstance, runtime: ApiRuntime): Promise<void> {
  server.get("/api/v1/overview", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    return runtime.repository.getOverview(user.tenantId);
  });

  server.get<{ Querystring: Record<string, unknown> }>("/api/v1/providers", async (request) => {
    await requireRequestUser(request, runtime.database);
    return { items: runtime.providers.listDescriptors() };
  });

  server.post<{ Body: Record<string, unknown> }>("/api/v1/providers/:providerType/validate", async (request) => {
    await requireRequestUser(request, runtime.database);
    const providerType = String((request.params as { providerType: string }).providerType);
    const connection = requireObject(request.body, "connection", "连接配置");
    const result = await runtime.providers.get(providerType).validateConnection(connection);
    return { providerType, ...result };
  });

  server.get<{ Querystring: Record<string, unknown> }>("/api/v1/services", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    const pagination = readPagination(request.query);
    const status = typeof request.query.status === "string" ? request.query.status as ServiceStatus : undefined;
    return runtime.repository.listServices({
      tenantId: user.tenantId,
      providerType: typeof request.query.providerType === "string" ? request.query.providerType : undefined,
      status,
      keyword: typeof request.query.search === "string" ? request.query.search : undefined,
      ...pagination,
    });
  });

  server.post<{ Body: Record<string, unknown> }>("/api/v1/services", async (request, reply) => {
    const user = await requireRequestUser(request, runtime.database);
    const displayName = requireString(request.body, "displayName", "服务名称", 100);
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
    const metadataProfile = validateMetadataProfile(
      requireObject(request.body, "metadata", "元数据配置"),
      dataType,
    );
    await validateProviderAccess(adapter, connection, scanProfile);
    const clientDeviceId = typeof request.body.clientDeviceId === "string" ? request.body.clientDeviceId.trim() : "";
    const clientServiceId = typeof request.body.clientServiceId === "string" ? request.body.clientServiceId.trim() : "";
    const service = await runtime.repository.createService({
      serviceId: randomUUID(),
      libraryId: randomUUID(),
      tenantId: user.tenantId,
      ownerUserId: user.id,
      displayName,
      providerType,
      dataType,
      encryptedConnection: runtime.vault.encrypt(connection),
      providerSchemaVersion: adapter.descriptor.credentialSchemaVersion,
      scanProfile,
      metadataProfile,
      binding: clientDeviceId && clientServiceId
        ? { id: randomUUID(), clientDeviceId, clientServiceId }
        : undefined,
    });
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-flycloud-helper-service-data-type",
      事件: "创建云端服务",
      用户ID: user.id,
      服务ID: service.id,
      网盘类型: providerType,
      数据类型: dataType,
      自动创建扫描任务: false,
    });
    if (hasHttpProviderAddress(connection)) {
      runtime.logBusinessEvent("info", {
        日志关键字: "codex-flycloud-helper-provider-http",
        事件: "使用HTTP地址创建Provider服务",
        用户ID: user.id,
        服务ID: service.id,
        网盘类型: providerType,
      });
    }
    return reply.status(201).send({ service });
  });

  server.get<{ Params: { serviceId: string } }>("/api/v1/services/:serviceId", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    return { service: await runtime.repository.getServiceDetail(request.params.serviceId, user.tenantId) };
  });

  server.get<{ Params: { serviceId: string }; Querystring: Record<string, unknown> }>("/api/v1/services/:serviceId/directories", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    const service = await runtime.repository.getServiceDetail(request.params.serviceId, user.tenantId);
    const connection = runtime.vault.decrypt(await runtime.repository.getActiveEncryptedConnection(service.id, user.tenantId));
    const listing = await runtime.providers.get(service.providerType).browseDirectories(
      connection,
      readProviderDirectoryParent(request.query),
    );
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-flycloud-helper-directory-picker",
      事件: "用户浏览网盘目录",
      用户ID: user.id,
      服务ID: service.id,
      网盘类型: service.providerType,
      子目录数量: listing.items.length,
    });
    return listing;
  });

  server.post<{ Params: { serviceId: string }; Body: Record<string, unknown> }>("/api/v1/services/:serviceId/client-bindings", async (request, reply) => {
    const user = await requireRequestUser(request, runtime.database);
    const result = await runtime.repository.bindClientService({
      bindingId: randomUUID(),
      tenantId: user.tenantId,
      serviceId: request.params.serviceId,
      clientDeviceId: requireString(request.body, "clientDeviceId", "客户端设备 ID", 200),
      clientServiceId: requireString(request.body, "clientServiceId", "客户端服务 ID", 200),
      providerType: requireString(request.body, "providerType", "Provider 类型", 64),
    });
    return reply.status(201).send(result);
  });

  server.post<{ Params: { serviceId: string }; Body: Record<string, unknown> }>("/api/v1/services/:serviceId/connection/validate", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    const service = await runtime.repository.getServiceDetail(request.params.serviceId, user.tenantId);
    const connection = requireObject(request.body, "connection", "连接配置");
    return runtime.providers.get(service.providerType).validateConnection(connection);
  });

  server.put<{ Params: { serviceId: string }; Body: Record<string, unknown> }>("/api/v1/services/:serviceId/connection", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    const service = await runtime.repository.getServiceDetail(request.params.serviceId, user.tenantId);
    const connection = requireObject(request.body, "connection", "连接配置");
    const adapter = runtime.providers.get(service.providerType);
    await validateProviderAccess(adapter, connection, service.scanProfile);
    const updated = await runtime.repository.updateConnection({
      serviceId: service.id,
      tenantId: user.tenantId,
      encryptedConnection: runtime.vault.encrypt(connection),
      providerSchemaVersion: adapter.descriptor.credentialSchemaVersion,
    });
    if (hasHttpProviderAddress(connection)) {
      runtime.logBusinessEvent("info", {
        日志关键字: "codex-flycloud-helper-provider-http",
        事件: "使用HTTP地址更新Provider连接",
        用户ID: user.id,
        服务ID: service.id,
        网盘类型: service.providerType,
      });
    }
    return { service: updated };
  });

  server.post<{ Params: { serviceId: string } }>("/api/v1/services/:serviceId/connection/reconnect", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    const service = await runtime.repository.getServiceDetail(request.params.serviceId, user.tenantId);
    const adapter = runtime.providers.get(service.providerType);
    const connection = runtime.vault.decrypt(
      await runtime.repository.getActiveEncryptedConnection(service.id, user.tenantId),
    );
    try {
      await validateProviderAccess(adapter, connection, service.scanProfile);
    } catch (error) {
      runtime.logBusinessEvent("warn", {
        日志关键字: "codex-flycloud-helper-provider-reconnect",
        事件: "使用当前配置重连失败",
        用户ID: user.id,
        服务ID: service.id,
        网盘类型: service.providerType,
        错误码: error && typeof error === "object" && "code" in error
          ? String((error as { code?: string }).code)
          : "provider_reconnect_failed",
      });
      throw error;
    }
    const updated = await runtime.repository.restoreServiceConnection(service.id, user.tenantId);
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-flycloud-helper-provider-reconnect",
      事件: "使用当前配置重连成功",
      用户ID: user.id,
      服务ID: service.id,
      网盘类型: service.providerType,
      凭据修订: service.credentialRevision,
    });
    return { service: updated };
  });

  server.put<{ Params: { serviceId: string }; Body: Record<string, unknown> }>("/api/v1/services/:serviceId/scan-profile", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    const service = await runtime.repository.getServiceDetail(request.params.serviceId, user.tenantId);
    const profile = validateScanProfile(
      requireObject(request.body, "scan", "扫描配置"),
      service.providerType,
      service.dataType,
      runtime.providers.get(service.providerType).descriptor.recommendedScanSettings,
    );
    const connection = runtime.vault.decrypt(await runtime.repository.getActiveEncryptedConnection(service.id, user.tenantId));
    await validateConfiguredScanRoots(runtime.providers.get(service.providerType), connection, profile);
    const updatedService = await runtime.repository.updateScanProfile(request.params.serviceId, user.tenantId, profile);
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-flycloud-helper-scan-path",
      事件: "更新服务扫描路径",
      用户ID: user.id,
      服务ID: service.id,
      全量路径数: getScanRootsForMode(profile, "full").length,
      增量路径数: getScanRootsForMode(profile, "incremental").length,
      扫描目录并发: profile.scanDirectoryConcurrency,
      刮削任务并发: profile.scrapeTaskConcurrency,
    });
    return { service: updatedService };
  });

  server.put<{ Params: { serviceId: string }; Body: Record<string, unknown> }>("/api/v1/services/:serviceId/metadata-profile", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    const service = await runtime.repository.getServiceDetail(request.params.serviceId, user.tenantId);
    const profile = validateMetadataProfile(
      requireObject(request.body, "metadata", "元数据配置"),
      service.dataType,
    );
    const updatedService = await runtime.repository.updateMetadataProfile(request.params.serviceId, user.tenantId, profile);
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-flycloud-helper-metadata-profile",
      事件: "更新影视元数据配置",
      用户ID: user.id,
      服务ID: service.id,
      ...readVideoMetadataLogFields(profile),
    });
    return { service: updatedService };
  });

  server.patch<{ Params: { serviceId: string }; Body: Record<string, unknown> }>("/api/v1/services/:serviceId/status", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    const status = request.body.status;
    if (status !== "active" && status !== "disabled") {
      throw validationError("status", "服务状态只支持 active 或 disabled");
    }
    return { service: await runtime.repository.updateServiceStatus(request.params.serviceId, user.tenantId, status) };
  });

  server.delete<{ Params: { serviceId: string }; Body: Record<string, unknown> }>("/api/v1/services/:serviceId", async (request, reply) => {
    const user = await requireRequestUser(request, runtime.database);
    requireConfirmation(request.body, request.params.serviceId);
    await runtime.repository.deleteService(request.params.serviceId, user.tenantId);
    runtime.logBusinessEvent("info", { 事件: "删除云端服务", 用户ID: user.id, 服务ID: request.params.serviceId });
    return reply.status(204).send();
  });

  server.delete<{ Params: { serviceId: string }; Body: Record<string, unknown> }>("/api/v1/services/:serviceId/catalog", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    requireConfirmation(request.body, request.params.serviceId);
    const cleared = await runtime.repository.clearServiceCatalog(request.params.serviceId, user.tenantId);
    await runtime.database.addAudit({
      id: randomUUID(),
      operatorUserId: user.id,
      operatorUsername: user.username,
      operationType: "clear_service_catalog",
      targetType: "service",
      targetId: request.params.serviceId,
      result: "success",
      detail: { 清空媒体条目数: cleared.mediaItemCount, 清空源文件数: cleared.sourceFileCount },
    });
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-flycloud-helper-catalog-clear",
      事件: "用户清空服务媒体库",
      用户ID: user.id,
      服务ID: request.params.serviceId,
      清空媒体条目数: cleared.mediaItemCount,
      清空源文件数: cleared.sourceFileCount,
    });
    return cleared;
  });

  server.post<{ Params: { serviceId: string }; Body: Record<string, unknown> }>("/api/v1/services/:serviceId/scan-jobs", async (request, reply) => {
    const user = await requireRequestUser(request, runtime.database);
    const scanMode = request.body.scanMode;
    if (scanMode !== "incremental" && scanMode !== "full") {
      throw validationError("scanMode", "扫描模式只支持 incremental 或 full");
    }
    const service = await runtime.repository.getServiceDetail(request.params.serviceId, user.tenantId);
    if (getScanRootsForMode(service.scanProfile, scanMode).length === 0) {
      throw new ApiError(409, "scan_paths_not_configured", `请先配置${scanMode === "full" ? "全量" : "增量"}扫描路径`);
    }
    const job = await runtime.repository.createScanJob({
      jobId: randomUUID(),
      tenantId: user.tenantId,
      serviceId: request.params.serviceId,
      requestedByUserId: user.id,
      requestId: requireString(request.body, "requestId", "请求 ID", 200),
      clientDeviceId: requireString(request.body, "clientDeviceId", "客户端设备 ID", 200),
      scanMode,
      runtimeRevision: "scanner-worker-v1",
      tmdbKeyPoolRevision: runtime.tmdb.revision,
      pluginVersions: await runtime.plugins.buildTaskSnapshots(service.metadataProfile),
    });
    runtime.logBusinessEvent("info", { 事件: "创建扫描任务", 用户ID: user.id, 服务ID: job.serviceId, 任务ID: job.id });
    return reply.status(202).send({ job });
  });

  server.get<{ Querystring: Record<string, unknown> }>("/api/v1/scan-jobs", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    return runtime.repository.listJobs({
      tenantId: user.tenantId,
      serviceId: typeof request.query.serviceId === "string" ? request.query.serviceId : undefined,
      status: typeof request.query.status === "string" ? request.query.status as JobStatus : undefined,
      ...readPagination(request.query),
    });
  });

  server.get<{ Params: { jobId: string } }>("/api/v1/scan-jobs/:jobId", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    return { job: await runtime.repository.getJob(request.params.jobId, user.tenantId) };
  });

  server.get<{ Params: { jobId: string }; Querystring: Record<string, unknown> }>("/api/v1/scan-jobs/:jobId/events", async (request, reply) => {
    const user = await requireRequestUser(request, runtime.database);
    await runtime.repository.getJob(request.params.jobId, user.tenantId);
    const start = readEventSequence(request.headers as Record<string, unknown>, request.query);
    streamJobEvents(reply, start, (afterSequence) => runtime.repository.listJobEvents({
      tenantId: user.tenantId,
      jobId: request.params.jobId,
      afterSequence,
      limit: 200,
    }));
  });

  for (const action of ["pause", "cancel"] as const) {
    server.post<{ Params: { jobId: string } }>(`/api/v1/scan-jobs/:jobId/${action}`, async (request) => {
      const user = await requireRequestUser(request, runtime.database);
      const job = await runtime.repository.requestJobControl(request.params.jobId, user.tenantId, action);
      runtime.logBusinessEvent("info", {
        日志关键字: "codex-flycloud-helper-job-control",
        事件: action === "cancel" ? "用户终止扫描任务" : "用户暂停扫描任务",
        用户ID: user.id,
        任务ID: job.id,
        控制动作: action,
      });
      return { job };
    });
  }

  server.delete<{ Params: { jobId: string }; Body: Record<string, unknown> }>("/api/v1/scan-jobs/:jobId", async (request, reply) => {
    const user = await requireRequestUser(request, runtime.database);
    requireConfirmation(request.body, request.params.jobId);
    await runtime.repository.deleteScanJob(request.params.jobId, user.tenantId);
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-flycloud-helper-job-delete",
      事件: "用户删除扫描任务",
      用户ID: user.id,
      任务ID: request.params.jobId,
    });
    return reply.status(204).send();
  });

  server.post<{ Params: { jobId: string } }>("/api/v1/scan-jobs/:jobId/resume", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    return { job: await runtime.repository.resumeJob(request.params.jobId, user.tenantId) };
  });

  server.post<{ Params: { jobId: string }; Body: Record<string, unknown> }>("/api/v1/scan-jobs/:jobId/retry", async (request, reply) => {
    const user = await requireRequestUser(request, runtime.database);
    const sourceJob = await runtime.repository.getJob(request.params.jobId, user.tenantId);
    if (sourceJob.status !== "failed" && sourceJob.status !== "cancelled") {
      throw new ApiError(409, "job_not_retryable", "只有失败或已取消任务可以重试");
    }
    const job = await runtime.repository.createScanJob({
      jobId: randomUUID(),
      tenantId: user.tenantId,
      serviceId: sourceJob.serviceId,
      requestedByUserId: user.id,
      requestId: requireString(request.body, "requestId", "请求 ID", 200),
      clientDeviceId: requireString(request.body, "clientDeviceId", "客户端设备 ID", 200),
      scanMode: sourceJob.scanMode,
      runtimeRevision: "scanner-worker-v1",
      tmdbKeyPoolRevision: runtime.tmdb.revision,
      retryOfJobId: sourceJob.id,
      pluginVersions: await runtime.plugins.buildTaskSnapshots(
        (await runtime.repository.getServiceDetail(sourceJob.serviceId, user.tenantId)).metadataProfile,
      ),
    });
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-flycloud-helper-job-retry",
      事件: "用户重试扫描任务",
      用户ID: user.id,
      原任务ID: sourceJob.id,
      新任务ID: job.id,
      服务ID: job.serviceId,
    });
    return reply.status(202).send({ job });
  });
}
