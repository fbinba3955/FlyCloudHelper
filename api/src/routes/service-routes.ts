import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { CloudServiceRecord, JobStatus, MediaType, ServiceDetailRecord, ServiceStatus } from "../domain.js";
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
  type ProviderConnectionContext,
  type ProviderRecommendedScanSettings,
  type ScanRoot,
} from "../providers/types.js";
import { streamJobEvents } from "./event-stream.js";

/** 当前版本允许创建的服务数据类型；有声书仍保留为后续阶段。 */
const supportedServiceDataTypes = new Set<MediaType>(["video", "music"]);

/** 记录迁回接口的失败阶段，不输出连接配置、Token 或导出文件路径。 */
function logTransferOutFailure(
  runtime: ApiRuntime,
  stage: string,
  userId: string,
  serviceId: string,
  transferId: string,
  error: unknown,
): void {
  runtime.logBusinessEvent("warn", {
    日志关键字: "codex-flycloud-transfer-out",
    事件: "服务迁回接口失败",
    阶段: stage,
    用户ID: userId,
    服务ID: serviceId,
    迁回任务ID: transferId,
    错误码: error instanceof ApiError ? error.code : "internal_error",
    错误信息: error instanceof Error ? error.message : "未知错误",
  });
}

/** 保留明确业务错误，并把未知异常转换成包含安全阶段信息的迁回错误。 */
function toTransferOutApiError(stage: string, error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  return new ApiError(
    500,
    "service_transfer_internal_error",
    `服务迁回处理失败（阶段：${stage}），请查看云助手日志`,
  );
}

/** 校验服务级数据类型，当前开放影视和音乐。 */
export function validateServiceDataType(value: unknown): MediaType {
  if (typeof value !== "string" || !supportedServiceDataTypes.has(value as MediaType)) {
    throw validationError("dataType", "当前服务数据类型仅支持影视或音乐");
  }
  return value as MediaType;
}

/** 判断连接配置中是否包含明文 HTTP Provider 地址，不记录完整地址。 */
export function hasHttpProviderAddress(connection: Record<string, unknown>): boolean {
  return Object.values(connection).some((value) => typeof value === "string" && /^http:\/\//iu.test(value.trim()));
}

/** 记录阿里云盘和百度网盘的自动配置结果，不输出令牌、地址或文件路径。 */
function logCloudDriveAutomaticConfig(
  runtime: ApiRuntime,
  providerType: string,
  event: "创建服务" | "更新连接",
  serviceId: string,
  userId: string,
): void {
  if (providerType !== "aliyundrive" && providerType !== "baidupan") return;
  runtime.logBusinessEvent("info", {
    日志关键字: "codex-cloud-drive-automatic-config",
    事件: event,
    用户ID: userId,
    服务ID: serviceId,
    网盘类型: providerType,
    云盘标识来源: providerType === "aliyundrive" ? "接口自动获取" : "不适用",
    开放接口地址来源: "官方默认地址",
  });
}

/** 从 APP 同步请求中读取光鸭官方 API 字段，并兼容 APP 当前运行时字段名称。 */
function readGuangyaOfficialApiText(
  connectionInput: Record<string, unknown>,
  names: string[],
  label: string,
  required = true,
  maximumLength = 10_000,
): string {
  for (const name of names) {
    const value = connectionInput[name];
    if (typeof value === "string" && value.trim()) {
      const text = value.trim();
      if ([...text].length > maximumLength || text.includes("\0")) {
        throw validationError(names[0] ?? "connection", `${label}格式无效`);
      }
      return text;
    }
  }
  if (required) throw validationError(names[0] ?? "connection", `${label}不能为空`);
  return "";
}

/** 将 Flymby APP 提交的光鸭官方 API 连接裁剪为允许加密保存的固定字段。 */
function resolveGuangyaOfficialApiConnection(connectionInput: Record<string, unknown>): Record<string, unknown> {
  const rawExpiresAt = Number(connectionInput.expiresAt ?? connectionInput.guangyaTokenExpiresAt ?? 0);
  return {
    authMode: "official_api",
    clientId: readGuangyaOfficialApiText(connectionInput, ["clientId", "guangyaClientId"], "光鸭官方 API clientId", true, 200),
    projectId: readGuangyaOfficialApiText(connectionInput, ["projectId", "guangyaProjectId"], "光鸭官方 API projectId", true, 200),
    signSecret: readGuangyaOfficialApiText(connectionInput, ["signSecret", "guangyaSignSecret"], "光鸭官方 API signSecret", true, 1_000),
    deviceId: readGuangyaOfficialApiText(connectionInput, ["deviceId", "guangyaDeviceId"], "光鸭官方 API deviceId", true, 200),
    accessToken: readGuangyaOfficialApiText(connectionInput, ["accessToken", "guangyaAccessToken"], "光鸭官方 API accessToken", false),
    refreshToken: readGuangyaOfficialApiText(connectionInput, ["refreshToken", "guangyaRefreshToken"], "光鸭官方 API refreshToken"),
    tokenType: readGuangyaOfficialApiText(connectionInput, ["tokenType", "guangyaTokenType"], "光鸭官方 API tokenType", false, 100) || "Bearer",
    expiresAt: Number.isFinite(rawExpiresAt) && rawExpiresAt > 0
      ? rawExpiresAt < 1_000_000_000_000 ? rawExpiresAt * 1_000 : rawExpiresAt
      : 0,
    userId: readGuangyaOfficialApiText(connectionInput, ["userId", "guangyaUserId"], "光鸭账号 ID", false, 500),
  };
}

/** 从已经裁剪的 Provider 连接中读取非空文本，避免比较时把未知值转换成有效身份。 */
function readConnectionIdentityText(connection: Record<string, unknown>, fieldName: string): string {
  const value = connection[fieldName];
  return typeof value === "string" ? value.trim() : "";
}

/** 确认 APP 重新同步的仍是当前服务原来的光鸭官方 API 账号。 */
function requireSameGuangyaOfficialApiAccount(
  currentConnection: Record<string, unknown>,
  nextConnection: Record<string, unknown>,
): void {
  if (readConnectionIdentityText(currentConnection, "authMode") !== "official_api") {
    throw new ApiError(409, "guangya_auth_mode_conflict", "当前服务不是光鸭官方 API 登录，不能从 APP 覆盖登录信息");
  }
  const currentUserId = readConnectionIdentityText(currentConnection, "userId");
  const nextUserId = readConnectionIdentityText(nextConnection, "userId");
  // 关键变量：历史连接可能没有 userId；已有 userId 时必须严格匹配，防止把服务静默切换到另一个光鸭账号。
  if (currentUserId && (!nextUserId || currentUserId !== nextUserId)) {
    throw new ApiError(409, "guangya_account_mismatch", "APP 当前光鸭账号与云助手服务账号不一致，请检查后重试");
  }
}

/**
 * 将光鸭网页一次性授权会话或 APP 官方 API 同步数据解析成服务端连接。
 * 返回的网页授权会话 ID 仅在连接成功落库后消费，验证失败时允许用户直接重试。
 */
export function resolveProviderConnection(
  runtime: ApiRuntime,
  actorUserId: string,
  targetUserId: string,
  providerType: string,
  connectionInput: Record<string, unknown>,
): { connection: Record<string, unknown>; authorizationSessionId: string | null } {
  if (providerType === "aliyundrive" || providerType === "baidupan") {
    const refreshUrl = typeof connectionInput.refreshUrl === "string" ? connectionInput.refreshUrl.trim() : "";
    if (refreshUrl) {
      let parsedRefreshUrl: URL;
      try {
        parsedRefreshUrl = new URL(refreshUrl);
      } catch (_error) {
        throw validationError("connection.refreshUrl", "Token 刷新地址格式无效");
      }
      if (parsedRefreshUrl.protocol !== "https:") {
        throw validationError("connection.refreshUrl", "Token 刷新地址必须使用 HTTPS");
      }
    }
    return { connection: connectionInput, authorizationSessionId: null };
  }
  if (providerType !== "guangya") return { connection: connectionInput, authorizationSessionId: null };
  if (connectionInput.authMode === "official_api") {
    return { connection: resolveGuangyaOfficialApiConnection(connectionInput), authorizationSessionId: null };
  }
  if ((connectionInput.authMode === "web_sms" || connectionInput.authMode === "web_qr")
    && typeof connectionInput.accessToken === "string" && connectionInput.accessToken.trim()
    && typeof connectionInput.refreshToken === "string" && connectionInput.refreshToken.trim()) {
    // APP 迁移边界允许交接当前有效网页令牌；普通网页登录仍使用一次性授权会话。
    const rawExpiresAt = Number(connectionInput.expiresAt ?? 0); // 关键变量：拒绝把 NaN 序列化成空有效期。
    return {
      connection: {
        authMode: connectionInput.authMode,
        deviceId: readGuangyaOfficialApiText(connectionInput, ["deviceId"], "设备 ID", false, 500),
        accessToken: readGuangyaOfficialApiText(connectionInput, ["accessToken"], "Access Token", true),
        refreshToken: readGuangyaOfficialApiText(connectionInput, ["refreshToken"], "Refresh Token", true),
        tokenType: readGuangyaOfficialApiText(connectionInput, ["tokenType"], "Token 类型", false, 100) || "Bearer",
        expiresAt: Number.isFinite(rawExpiresAt) ? Math.max(0, rawExpiresAt) : 0,
        userId: readGuangyaOfficialApiText(connectionInput, ["userId"], "用户 ID", false, 500),
      },
      authorizationSessionId: null,
    };
  }
  const authorizationSessionId = requireString(
    connectionInput,
    "authorizationSessionId",
    "光鸭网页登录会话 ID",
    100,
  );
  return {
    connection: runtime.providers.guangyaAuthorization.getAuthorizedConnection(
      actorUserId,
      targetUserId,
      authorizationSessionId,
    ),
    authorizationSessionId,
  };
}

/** 在服务连接成功落库后销毁光鸭一次性授权会话。 */
export function consumeProviderAuthorization(
  runtime: ApiRuntime,
  actorUserId: string,
  authorizationSessionId: string | null,
): void {
  if (authorizationSessionId) {
    runtime.providers.guangyaAuthorization.consume(actorUserId, authorizationSessionId);
  }
}

/** 为服务摘要或详情追加不含任何凭据的光鸭登录类型。 */
export async function attachConnectionAuthMode<T extends CloudServiceRecord>(
  runtime: ApiRuntime,
  service: T,
): Promise<T & { connectionAuthMode: "official_api" | "web_qr" | "web_sms" | null }> {
  if (service.providerType !== "guangya") return { ...service, connectionAuthMode: null };
  try {
    const encryptedConnection = await runtime.repository.getActiveEncryptedConnection(service.id, service.userId);
    const connection = runtime.vault.decrypt(encryptedConnection);
    const rawAuthMode = typeof connection.authMode === "string" ? connection.authMode.trim() : "";
    // 关键变量：历史网页连接没有 authMode 时仍按扫码登录处理，保持已有服务名称稳定。
    const connectionAuthMode = rawAuthMode === "official_api" || rawAuthMode === "web_sms"
      ? rawAuthMode
      : "web_qr";
    return { ...service, connectionAuthMode };
  } catch (error) {
    // 列表展示名称不能因为单个服务凭据异常而阻断，详情和重连接口仍会返回真实错误。
    runtime.logBusinessEvent("warn", {
      日志关键字: "codex-guangya-auth-mode-display",
      事件: "读取光鸭登录类型失败",
      服务ID: service.id,
      用户ID: service.userId,
      错误类型: error instanceof Error ? error.name : typeof error,
    });
    return { ...service, connectionAuthMode: null };
  }
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
    || rootMediaTypes.some((item) => typeof item !== "string" || !allowedMediaTypes.has(item as MediaType)))) {
    throw validationError(`scan.${fieldName}.${index}.mediaTypes`, "扫描根媒体类型必须与服务数据类型一致");
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
  preserveConcurrency = false,
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
    throw validationError("scan.mediaTypes", "扫描媒体类型必须与服务数据类型一致");
  }
  const {
    roots: _legacyRoots,
    fullRoots: _fullRoots,
    incrementalRoots: _incrementalRoots,
    ...otherProfile
  } = profile;
  /** 读取单个并发设置；Provider 只提供服务默认值，不限制用户设置的任务数量。 */
  const readConcurrency = (
    fieldName: "scanDirectoryConcurrency" | "scrapeTaskConcurrency",
    setting: { default: number },
  ): number => {
    const value = profile[fieldName];
    if (value === undefined) return setting.default;
    // 关键变量：仅保存路径时原样保留该服务的任务数，不让路径修改触发并发配置校验。
    if (preserveConcurrency) return value as number;
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
      const fieldLabel = fieldName === "scanDirectoryConcurrency" ? "扫描任务数" : "刮削任务数";
      throw validationError(`scan.${fieldName}`, `${fieldLabel}必须是正整数`);
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
  context?: ProviderConnectionContext,
): Promise<void> {
  const fullRoots = getScanRootsForMode(scanProfile, "full");
  const incrementalRoots = getScanRootsForMode(scanProfile, "incremental");
  if (fullRoots.length > 0) {
    await adapter.validateRoots(connection, fullRoots, undefined, context);
  }
  if (incrementalRoots.length > 0) {
    await adapter.validateRoots(connection, incrementalRoots, undefined, context);
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
    throw validationError("metadata.profiles", "元数据配置必须与服务数据类型一致");
  }
  const selectedProfile = profiles[serviceDataType];
  if (!selectedProfile || typeof selectedProfile !== "object" || Array.isArray(selectedProfile)) {
    throw validationError(`metadata.profiles.${serviceDataType}`, `${serviceDataType === "music" ? "音乐" : "影视"}元数据配置必须是对象`);
  }
  const metadataSettings = selectedProfile as Record<string, unknown>;
  if (metadataSettings.providerId !== undefined
    && (typeof metadataSettings.providerId !== "string" || !metadataSettings.providerId.trim())) {
    throw validationError(`metadata.profiles.${serviceDataType}.providerId`, "元数据来源必须是非空字符串");
  }
  if (serviceDataType === "music") {
    if (metadataSettings.aggregateMode !== undefined
      && metadataSettings.aggregateMode !== "fast"
      && metadataSettings.aggregateMode !== "complete") {
      throw validationError(`metadata.profiles.${serviceDataType}.aggregateMode`, "音乐元数据聚合模式无效");
    }
    if (metadataSettings.requiredFields !== undefined
      && (!metadataSettings.requiredFields || typeof metadataSettings.requiredFields !== "object" || Array.isArray(metadataSettings.requiredFields))) {
      throw validationError(`metadata.profiles.${serviceDataType}.requiredFields`, "音乐必需字段配置必须是对象");
    }
    return profile;
  }
  if (metadataSettings.useNfo !== undefined && typeof metadataSettings.useNfo !== "boolean") {
    throw validationError(`metadata.profiles.${serviceDataType}.useNfo`, "本地 NFO 开关必须是布尔值");
  }
  if (metadataSettings.syncDetails !== undefined && typeof metadataSettings.syncDetails !== "boolean") {
    throw validationError(`metadata.profiles.${serviceDataType}.syncDetails`, "同步刮削详情开关必须是布尔值");
  }
  if (metadataSettings.analyzeMediaSpecs !== undefined && typeof metadataSettings.analyzeMediaSpecs !== "boolean") {
    throw validationError(`metadata.profiles.${serviceDataType}.analyzeMediaSpecs`, "媒体规格分析开关必须是布尔值");
  }
  if (metadataSettings.aiCleaning !== undefined) {
    if (!metadataSettings.aiCleaning || typeof metadataSettings.aiCleaning !== "object" || Array.isArray(metadataSettings.aiCleaning)) {
      throw validationError(`metadata.profiles.${serviceDataType}.aiCleaning`, "AI 清洗配置必须是对象");
    }
    const aiCleaning = metadataSettings.aiCleaning as Record<string, unknown>;
    if (typeof aiCleaning.enabled !== "boolean") {
      throw validationError(`metadata.profiles.${serviceDataType}.aiCleaning.enabled`, "AI 清洗开关必须是布尔值");
    }
    if (aiCleaning.enabled && (typeof aiCleaning.modelId !== "string" || !aiCleaning.modelId.trim())) {
      throw validationError(`metadata.profiles.${serviceDataType}.aiCleaning.modelId`, "启用 AI 清洗时必须选择模型");
    }
    if (aiCleaning.triggerMode !== undefined
      && aiCleaning.triggerMode !== "weak_only"
      && aiCleaning.triggerMode !== "weak_or_unmatched") {
      throw validationError(`metadata.profiles.${serviceDataType}.aiCleaning.triggerMode`, "AI 清洗策略无效");
    }
    if (aiCleaning.minConfidence !== undefined
      && (typeof aiCleaning.minConfidence !== "number" || aiCleaning.minConfidence < 0.5 || aiCleaning.minConfidence > 1)) {
      throw validationError(`metadata.profiles.${serviceDataType}.aiCleaning.minConfidence`, "AI 清洗最低置信度必须在 0.5 到 1 之间");
    }
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
    同步刮削详情: videoProfile.syncDetails === true,
    分析媒体规格: videoProfile.analyzeMediaSpecs === true,
    启用AI清洗: Boolean(videoProfile.aiCleaning && typeof videoProfile.aiCleaning === "object"
      && (videoProfile.aiCleaning as Record<string, unknown>).enabled === true),
    AI触发策略: videoProfile.aiCleaning && typeof videoProfile.aiCleaning === "object"
      ? String((videoProfile.aiCleaning as Record<string, unknown>).triggerMode ?? "weak_or_unmatched")
      : "disabled",
  };
}

/** 提取不含查询内容的音乐元数据配置，用于统一业务日志。 */
export function readMusicMetadataLogFields(profile: Record<string, unknown>): Record<string, unknown> {
  const profiles = profile.profiles && typeof profile.profiles === "object" && !Array.isArray(profile.profiles)
    ? profile.profiles as Record<string, unknown>
    : {};
  const musicProfile = profiles.music && typeof profiles.music === "object" && !Array.isArray(profiles.music)
    ? profiles.music as Record<string, unknown>
    : {};
  return {
    音乐元数据来源: typeof musicProfile.providerId === "string" ? musicProfile.providerId : "auto",
    聚合模式: musicProfile.aggregateMode === "fast" ? "fast" : "complete",
    标签读取方式: "云助手内置",
  };
}

/** 同时验证 Provider 账号连接和本次配置的全部扫描根。 */
export async function validateProviderAccess(
  adapter: ProviderAdapter,
  connection: Record<string, unknown>,
  scanProfile: Record<string, unknown>,
  context?: ProviderConnectionContext,
): Promise<void> {
  const validation = await adapter.validateConnection(connection, undefined, context);
  if (!validation.valid || !validation.rootAccessible) {
    throw new ApiError(422, "provider_connection_invalid", "网盘连接或根目录不可用");
  }
  const fullRoots = getScanRootsForMode(scanProfile, "full");
  const incrementalRoots = getScanRootsForMode(scanProfile, "incremental");
  if (fullRoots.length > 0) await adapter.validateRoots(connection, fullRoots, undefined, context);
  if (incrementalRoots.length > 0) await adapter.validateRoots(connection, incrementalRoots, undefined, context);
}

/** 从 SSE 请求读取兼容 Header 和查询参数的事件游标。 */
function readEventSequence(headers: Record<string, unknown>, query: Record<string, unknown>): number {
  const value = headers["last-event-id"] ?? query.afterSequence ?? 0;
  return Math.max(0, Number.parseInt(String(value), 10) || 0);
}

/** 读取 APP 多端条件更新使用的期望配置修订号。 */
function readExpectedRevision(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const revision = Number(value);
  if (!Number.isInteger(revision) || revision <= 0) {
    throw validationError("expectedRevision", "期望配置修订号必须是正整数");
  }
  return revision;
}

/** 注册普通用户作用域的服务、任务、连接和配置接口。 */
export async function registerServiceRoutes(server: FastifyInstance, runtime: ApiRuntime): Promise<void> {
  server.get("/api/v1/overview", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    return runtime.repository.getOverview(user.id);
  });

  server.get<{ Querystring: Record<string, unknown> }>("/api/v1/providers", async (request) => {
    await requireRequestUser(request, runtime.database);
    return { items: runtime.providers.listDescriptors() };
  });

  server.post<{ Body: Record<string, unknown> }>("/api/v1/providers/:providerType/validate", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    const providerType = String((request.params as { providerType: string }).providerType);
    const resolved = resolveProviderConnection(
      runtime,
      user.id,
      user.id,
      providerType,
      requireObject(request.body, "connection", "连接配置"),
    );
    const connection = resolved.connection;
    const result = await runtime.providers.get(providerType).validateConnection(connection);
    return { providerType, ...result };
  });

  server.get<{ Querystring: Record<string, unknown> }>("/api/v1/services", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    const pagination = readPagination(request.query);
    const status = typeof request.query.status === "string" ? request.query.status as ServiceStatus : undefined;
    const result = await runtime.repository.listServices({
      userId: user.id,
      providerType: typeof request.query.providerType === "string" ? request.query.providerType : undefined,
      status,
      keyword: typeof request.query.search === "string" ? request.query.search : undefined,
      ...pagination,
    });
    // 关键变量：列表中的登录类型只用于区分官方光鸭与三方光鸭，不返回任何授权凭据。
    const items = await Promise.all(result.items.map((service) => attachConnectionAuthMode(runtime, service)));
    return { ...result, items };
  });

  server.post<{ Body: Record<string, unknown> }>("/api/v1/services", async (request, reply) => {
    const user = await requireRequestUser(request, runtime.database);
    const displayName = requireString(request.body, "displayName", "服务名称", 100);
    const dataType = validateServiceDataType(request.body.dataType);
    const provider = requireObject(request.body, "provider", "Provider");
    const providerType = requireString(provider, "type", "Provider 类型", 64);
    const clientDeviceId = typeof request.body.clientDeviceId === "string" ? request.body.clientDeviceId.trim() : "";
    const clientServiceId = typeof request.body.clientServiceId === "string" ? request.body.clientServiceId.trim() : "";
    if (clientDeviceId && clientServiceId) {
      const existingBinding = await runtime.repository.findClientServiceBinding(user.id, clientDeviceId, clientServiceId);
      if (existingBinding) {
        const existingService = await runtime.repository.getServiceDetail(existingBinding.serviceId, user.id);
        if (existingService.providerType !== providerType) {
          throw new ApiError(409, "provider_type_conflict", "本地服务已经关联其他 Provider 类型的云端服务");
        }
        runtime.logBusinessEvent("info", {
          日志关键字: "codex-flycloud-service-association",
          事件: "复用本地服务已有云端关联",
          用户ID: user.id,
          服务ID: existingService.id,
          客户端服务ID: clientServiceId,
          网盘类型: providerType,
        });
        return reply.status(200).send({ service: existingService, serviceAccessCredentials: null });
      }
    }
    const resolvedConnection = resolveProviderConnection(
      runtime,
      user.id,
      user.id,
      providerType,
      requireObject(provider, "connection", "连接配置"),
    );
    const connection = resolvedConnection.connection;
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
    await runtime.aiModels.validateMetadataProfile(metadataProfile);
    await validateProviderAccess(adapter, connection, scanProfile);
    const creation = await runtime.repository.createService({
      serviceId: randomUUID(),
      libraryId: randomUUID(),
      userId: user.id,
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
    const service = creation.service;
    consumeProviderAuthorization(runtime, user.id, resolvedConnection.authorizationSessionId);
    logCloudDriveAutomaticConfig(runtime, providerType, "创建服务", service.id, user.id);
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-flycloud-helper-service-data-type",
      事件: "创建云端服务",
      用户ID: user.id,
      服务ID: service.id,
      网盘类型: providerType,
      数据类型: dataType,
      自动创建扫描任务: false,
    });
    if (providerType === "guangya" && connection.authMode === "official_api") {
      runtime.logBusinessEvent("info", {
        日志关键字: "codex-flycloud-helper-guangya-official-api",
        事件: "用户从APP同步光鸭官方API连接并创建服务",
        用户ID: user.id,
        服务ID: service.id,
      });
    }
    if (hasHttpProviderAddress(connection)) {
      runtime.logBusinessEvent("info", {
        日志关键字: "codex-flycloud-helper-provider-http",
        事件: "使用HTTP地址创建Provider服务",
        用户ID: user.id,
        服务ID: service.id,
        网盘类型: providerType,
      });
    }
    return reply.status(201).send({
      service,
      serviceAccessCredentials: {
        username: creation.accessCredentials.account.username,
        password: creation.accessCredentials.password,
      },
    });
  });

  server.get<{ Params: { serviceId: string } }>("/api/v1/services/:serviceId", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    const service = await runtime.repository.getServiceDetail(request.params.serviceId, user.id);
    return { service: await attachConnectionAuthMode(runtime, service) };
  });

  server.patch<{ Params: { serviceId: string }; Body: Record<string, unknown> }>("/api/v1/services/:serviceId", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    const displayName = requireString(request.body, "displayName", "服务名称", 100);
    const expectedUpdatedAt = request.body.expectedUpdatedAt === undefined
      ? undefined
      : requireString(request.body, "expectedUpdatedAt", "服务更新时间", 40);
    return {
      service: await runtime.repository.updateServiceName(
        request.params.serviceId,
        user.id,
        displayName,
        expectedUpdatedAt,
      ),
    };
  });

  server.get<{ Params: { serviceId: string }; Querystring: Record<string, unknown> }>("/api/v1/services/:serviceId/directories", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    const service = await runtime.repository.getServiceDetail(request.params.serviceId, user.id);
    const connection = runtime.vault.decrypt(await runtime.repository.getActiveEncryptedConnection(service.id, user.id));
    const listing = await runtime.providers.get(service.providerType).browseDirectories(
      connection,
      readProviderDirectoryParent(request.query),
      undefined,
      {
        persistConnection: async (nextConnection) => {
          await runtime.repository.refreshActiveEncryptedConnection({
            serviceId: service.id,
            userId: user.id,
            credentialRevision: service.credentialRevision,
            encryptedConnection: runtime.vault.encrypt(nextConnection),
          });
          runtime.logBusinessEvent("info", {
            日志关键字: "codex-flycloud-provider-token-refresh",
            事件: "目录浏览期间保存Provider刷新令牌",
            用户ID: user.id,
            服务ID: service.id,
            凭据修订: service.credentialRevision,
          });
        },
      },
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
      userId: user.id,
      serviceId: request.params.serviceId,
      clientDeviceId: requireString(request.body, "clientDeviceId", "客户端设备 ID", 200),
      clientServiceId: requireString(request.body, "clientServiceId", "客户端服务 ID", 200),
      providerType: requireString(request.body, "providerType", "Provider 类型", 64),
    });
    return reply.status(201).send(result);
  });

  /** 仅移除当前设备上的镜像绑定，云端服务和其他设备保持不变。 */
  server.delete<{ Params: { serviceId: string }; Body: Record<string, unknown> }>(
    "/api/v1/services/:serviceId/client-bindings",
    async (request) => {
      const user = await requireRequestUser(request, runtime.database);
      const clientDeviceId = requireString(request.body, "clientDeviceId", "客户端设备 ID", 200);
      const clientServiceId = requireString(request.body, "clientServiceId", "客户端服务 ID", 200);
      const removed = await runtime.repository.unbindClientService({
        userId: user.id,
        serviceId: request.params.serviceId,
        clientDeviceId,
        clientServiceId,
      });
      runtime.logBusinessEvent("info", {
        日志关键字: "codex-flycloud-client-binding",
        事件: "移除当前设备服务绑定",
        用户ID: user.id,
        云端服务ID: request.params.serviceId,
        客户端设备ID: clientDeviceId,
        客户端服务ID: clientServiceId,
        是否移除: removed,
      });
      return { removed };
    },
  );

  /** 冻结服务并创建迁回 APP 所需的完整目录导出任务。 */
  server.post<{ Params: { serviceId: string }; Body: Record<string, unknown> }>(
    "/api/v1/services/:serviceId/transfer-outs",
    async (request, reply) => {
      const user = await requireRequestUser(request, runtime.database);
      let failureStage = "读取服务和设备绑定"; // 关键变量：NAS 日志据此定位创建迁回任务的失败边界。
      try {
      const service = await runtime.repository.getServiceDetail(request.params.serviceId, user.id);
      const clientDeviceId = requireString(request.body, "clientDeviceId", "客户端设备 ID", 200);
      const clientServiceId = requireString(request.body, "clientServiceId", "客户端服务 ID", 200);
      const binding = await runtime.repository.findClientServiceBinding(user.id, clientDeviceId, clientServiceId);
      if (!binding || binding.serviceId !== service.id) {
        throw new ApiError(409, "client_service_binding_required", "只有当前服务已绑定的设备才能发起迁回");
      }
      // 关键变量：无论服务最初由 APP 迁入，还是从云端同步到本机，只要当前设备仍有有效绑定即可完整迁回。
      failureStage = "恢复或复用已有迁回任务";
      const existingTransfer = await runtime.database.query("service_transfer_outs")
        .where({ user_id: user.id, service_id: service.id }).first();
      let previousStatus: string = service.status; // 关键变量：导出失败重建任务时仍恢复最初的服务状态。
      if (existingTransfer) {
        const existingExport = await runtime.exports.getExport(String(existingTransfer.export_id), user.id);
        if (existingExport.status !== "failed") {
          return reply.status(200).send({
            transfer: {
              id: String(existingTransfer.id),
              serviceId: service.id,
              libraryId: service.libraryId,
              status: existingExport.status === "completed" ? "ready" : String(existingTransfer.status),
              exportId: String(existingTransfer.export_id),
              export: { ...existingExport, filePath: undefined },
              credentialClaimed: Number(existingTransfer.credential_claimed) === 1,
            },
          });
        }
        previousStatus = String(existingTransfer.previous_status || "active");
        await runtime.exports.deleteExport(existingExport.id, user.id);
        await runtime.database.query("service_transfer_outs").where({ id: existingTransfer.id }).delete();
        await runtime.database.query("cloud_services").where({ id: service.id, user_id: user.id }).update({
          status: previousStatus,
          updated_at: new Date().toISOString(),
        });
      }
      const [activeScanJob, activeMediaProbeJob] = await Promise.all([
        runtime.database.query("scan_jobs").where({ service_id: service.id })
          .whereIn("status", ["queued", "running", "retry_waiting", "paused"]).first(),
        runtime.database.query("media_probe_jobs").where({ service_id: service.id })
          .whereIn("status", ["queued", "running", "retry_waiting", "paused"]).first(),
      ]);
      if (activeScanJob || activeMediaProbeJob) {
        throw new ApiError(409, "service_has_active_job", "请先结束当前服务的扫描或规格分析任务");
      }
      failureStage = "创建云端目录导出任务";
      const exportRecord = await runtime.exports.createSnapshotTask(user.id, service.libraryId);
      const transferId = randomUUID();
      const now = new Date().toISOString();
      failureStage = "冻结服务并保存迁回任务";
      await runtime.database.query.transaction(async (transaction) => {
        await transaction("cloud_services").where({ id: service.id, user_id: user.id }).update({
          status: "disabled",
          updated_at: now,
        });
        await transaction("service_transfer_outs").insert({
          id: transferId,
          user_id: user.id,
          service_id: service.id,
          library_id: service.libraryId,
          client_device_id: clientDeviceId,
          client_service_id: clientServiceId,
          export_id: exportRecord.id,
          status: "exporting",
          previous_status: previousStatus,
          credential_claimed: 0,
          created_at: now,
          updated_at: now,
        });
      });
      runtime.logBusinessEvent("info", {
        日志关键字: "codex-flycloud-transfer-out",
        事件: "创建服务迁回任务",
        用户ID: user.id,
        服务ID: service.id,
        迁回任务ID: transferId,
        客户端设备ID: clientDeviceId,
      });
      return reply.status(202).send({
        transfer: {
          id: transferId,
          serviceId: service.id,
          libraryId: service.libraryId,
          status: "exporting",
          exportId: exportRecord.id,
          export: { ...exportRecord, filePath: undefined },
          credentialClaimed: false,
        },
      });
      } catch (error) {
        logTransferOutFailure(runtime, failureStage, user.id, request.params.serviceId, "", error);
        throw toTransferOutApiError(failureStage, error);
      }
    },
  );

  /** 查询迁回任务和底层目录导出的实时状态。 */
  server.get<{ Params: { serviceId: string; transferId: string } }>(
    "/api/v1/services/:serviceId/transfer-outs/:transferId",
    async (request) => {
      const user = await requireRequestUser(request, runtime.database);
      let failureStage = "读取迁回任务"; // 关键变量：轮询失败时区分任务读取、导出读取和状态保存。
      try {
        const transfer = await runtime.database.query("service_transfer_outs").where({
          id: request.params.transferId,
          user_id: user.id,
          service_id: request.params.serviceId,
        }).first();
        if (!transfer) throw new ApiError(404, "service_transfer_not_found", "迁回任务不存在");
        failureStage = "读取云端目录导出状态";
        const exportRecord = await runtime.exports.getExport(String(transfer.export_id), user.id);
        const status = exportRecord.status === "completed" ? "ready"
          : exportRecord.status === "failed" ? "failed" : "exporting";
        if (status !== String(transfer.status)) {
          failureStage = "保存迁回任务状态";
          await runtime.database.query("service_transfer_outs").where({ id: transfer.id }).update({
            status,
            updated_at: new Date().toISOString(),
          });
        }
        return {
          transfer: {
            id: String(transfer.id),
            serviceId: String(transfer.service_id),
            libraryId: String(transfer.library_id),
            status,
            exportId: String(transfer.export_id),
            export: { ...exportRecord, filePath: undefined },
            credentialClaimed: Number(transfer.credential_claimed) === 1,
          },
        };
      } catch (error) {
        logTransferOutFailure(
          runtime, failureStage, user.id, request.params.serviceId, request.params.transferId, error,
        );
        throw toTransferOutApiError(failureStage, error);
      }
    },
  );

  /** 目录准备完成后只向发起设备交接冻结后的最新 Provider 凭据与配置。 */
  server.post<{ Params: { serviceId: string; transferId: string }; Body: Record<string, unknown> }>(
    "/api/v1/services/:serviceId/transfer-outs/:transferId/credentials/claim",
    async (request, reply) => {
      const user = await requireRequestUser(request, runtime.database);
      let failureStage = "读取迁回任务"; // 关键变量：区分任务、凭据读取和解密阶段。
      try {
      const clientDeviceId = requireString(request.body, "clientDeviceId", "客户端设备 ID", 200);
      const clientServiceId = requireString(request.body, "clientServiceId", "客户端服务 ID", 200);
      const transfer = await runtime.database.query("service_transfer_outs").where({
        id: request.params.transferId,
        user_id: user.id,
        service_id: request.params.serviceId,
        client_device_id: clientDeviceId,
        client_service_id: clientServiceId,
      }).first();
      if (!transfer) throw new ApiError(404, "service_transfer_not_found", "迁回任务不存在或不属于当前设备");
      const exportRecord = await runtime.exports.getExport(String(transfer.export_id), user.id);
      if (exportRecord.status !== "completed") {
        throw new ApiError(409, "service_transfer_catalog_not_ready", "云端目录尚未完成导出");
      }
      failureStage = "读取并解密Provider凭据";
      const service = await runtime.repository.getServiceDetail(request.params.serviceId, user.id);
      const encryptedConnection = await runtime.repository.getActiveEncryptedConnection(service.id, user.id);
      const connection = runtime.vault.decrypt(encryptedConnection); // 关键变量：先完成解密再写已领取标记。
      failureStage = "保存凭据领取状态";
      await runtime.database.query("service_transfer_outs").where({ id: transfer.id }).update({
        credential_claimed: 1,
        status: "claimed",
        updated_at: new Date().toISOString(),
      });
      // Provider 凭据只能用于本次迁回，不允许浏览器、代理或系统缓存响应正文。
      return reply.header("Cache-Control", "no-store").header("Pragma", "no-cache").send({
        transferId: String(transfer.id),
        providerType: service.providerType,
        connection,
        scanProfile: service.scanProfile,
        metadataProfile: service.metadataProfile,
        credentialRevision: service.credentialRevision,
        scanProfileRevision: service.scanProfileRevision,
        metadataProfileRevision: service.metadataProfileRevision,
      });
      } catch (error) {
        logTransferOutFailure(
          runtime, failureStage, user.id, request.params.serviceId, request.params.transferId, error,
        );
        throw toTransferOutApiError(failureStage, error);
      }
    },
  );

  /** APP 确认目录和凭据均已落盘后，物理删除云端服务及所有设备绑定。 */
  server.post<{ Params: { serviceId: string; transferId: string }; Body: Record<string, unknown> }>(
    "/api/v1/services/:serviceId/transfer-outs/:transferId/complete",
    async (request) => {
      const user = await requireRequestUser(request, runtime.database);
      let failureStage = "校验迁回完成请求"; // 关键变量：物理删除失败时记录最后完成的安全阶段。
      try {
      requireConfirmation(request.body, request.params.transferId);
      const transfer = await runtime.database.query("service_transfer_outs").where({
        id: request.params.transferId,
        user_id: user.id,
        service_id: request.params.serviceId,
      }).first();
      if (!transfer) {
        // 云端物理删除成功但响应丢失时，APP 会重试完成请求；服务和任务都不存在即视为已经完成。
        const remainingService = await runtime.database.query("cloud_services").select("id").where({
          id: request.params.serviceId,
          user_id: user.id,
        }).first();
        if (!remainingService) {
          runtime.logBusinessEvent("info", {
            日志关键字: "codex-flycloud-transfer-out",
            事件: "迁回完成请求幂等命中",
            用户ID: user.id,
            服务ID: request.params.serviceId,
            迁回任务ID: request.params.transferId,
          });
          return {
            completed: true,
            alreadyCompleted: true,
            serviceId: request.params.serviceId,
            transferId: request.params.transferId,
          };
        }
        throw new ApiError(404, "service_transfer_not_found", "迁回任务不存在");
      }
      if (Number(transfer.credential_claimed) !== 1) {
        throw new ApiError(409, "service_transfer_credential_not_claimed", "APP 尚未接收 Provider 凭据");
      }
      try {
        failureStage = "确认云端目录导出完成";
        const completedExport = await runtime.exports.getExport(String(transfer.export_id), user.id);
        if (completedExport.status !== "completed") {
          throw new ApiError(409, "service_transfer_catalog_not_ready", "云端目录尚未完成导出");
        }
      } catch (error) {
        // 上次完成请求可能已清理导出文件但在物理删除服务前中断，此时允许幂等继续。
        if (!(error instanceof ApiError) || error.code !== "export_not_found") throw error;
      }
      failureStage = "清理云端目录导出文件";
      while (true) {
        const exports = await runtime.exports.listExports(user.id, String(transfer.library_id), 100);
        if (exports.length === 0) break;
        for (const record of exports) {
          if (record.status === "queued" || record.status === "running") {
            throw new ApiError(409, "service_transfer_export_active", "服务仍有未结束的目录导出任务");
          }
          await runtime.exports.deleteExport(record.id, user.id);
        }
      }
      failureStage = "物理删除云端服务数据";
      await runtime.repository.hardDeleteService(request.params.serviceId, user.id);
      runtime.logBusinessEvent("info", {
        日志关键字: "codex-flycloud-transfer-out",
        事件: "服务迁回云端清理完成",
        用户ID: user.id,
        服务ID: request.params.serviceId,
        迁回任务ID: request.params.transferId,
      });
      return { completed: true, serviceId: request.params.serviceId, transferId: request.params.transferId };
      } catch (error) {
        logTransferOutFailure(
          runtime, failureStage, user.id, request.params.serviceId, request.params.transferId, error,
        );
        throw toTransferOutApiError(failureStage, error);
      }
    },
  );

  server.post<{ Params: { serviceId: string }; Body: Record<string, unknown> }>("/api/v1/services/:serviceId/connection/validate", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    const service = await runtime.repository.getServiceDetail(request.params.serviceId, user.id);
    const connection = resolveProviderConnection(
      runtime,
      user.id,
      user.id,
      service.providerType,
      requireObject(request.body, "connection", "连接配置"),
    ).connection;
    return runtime.providers.get(service.providerType).validateConnection(connection);
  });

  server.put<{ Params: { serviceId: string }; Body: Record<string, unknown> }>("/api/v1/services/:serviceId/connection", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    const service = await runtime.repository.getServiceDetail(request.params.serviceId, user.id);
    const resolvedConnection = resolveProviderConnection(
      runtime,
      user.id,
      user.id,
      service.providerType,
      requireObject(request.body, "connection", "连接配置"),
    );
    const connection = resolvedConnection.connection;
    const adapter = runtime.providers.get(service.providerType);
    await validateProviderAccess(adapter, connection, service.scanProfile);
    const updated = await runtime.repository.updateConnection({
      serviceId: service.id,
      userId: user.id,
      encryptedConnection: runtime.vault.encrypt(connection),
      providerSchemaVersion: adapter.descriptor.credentialSchemaVersion,
      expectedRevision: readExpectedRevision(request.body.expectedRevision),
    });
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-flycloud-provider-sync",
      事件: "更新托管服务登录状态",
      用户ID: user.id,
      服务ID: service.id,
      网盘类型: service.providerType,
      凭据修订: updated.credentialRevision,
    });
    consumeProviderAuthorization(runtime, user.id, resolvedConnection.authorizationSessionId);
    logCloudDriveAutomaticConfig(runtime, service.providerType, "更新连接", service.id, user.id);
    if (service.providerType === "guangya" && connection.authMode === "official_api") {
      runtime.logBusinessEvent("info", {
        日志关键字: "codex-flycloud-helper-guangya-official-api",
        事件: "用户从APP同步光鸭官方API连接并更新服务",
        用户ID: user.id,
        服务ID: service.id,
      });
    }
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

  /** 使用 APP 当前有效的光鸭官方 API 登录信息原地刷新服务凭据，不创建新的配置修订。 */
  server.put<{ Params: { serviceId: string }; Body: Record<string, unknown> }>(
    "/api/v1/services/:serviceId/connection/guangya-official-api",
    async (request) => {
      const user = await requireRequestUser(request, runtime.database);
      const service = await runtime.repository.getServiceDetail(request.params.serviceId, user.id);
      try {
        if (service.providerType !== "guangya") {
          throw new ApiError(409, "provider_type_mismatch", "只有光鸭服务可以同步官方 API 登录信息");
        }
        const expectedRevision = readExpectedRevision(request.body.expectedRevision);
        if (expectedRevision !== undefined && expectedRevision !== service.credentialRevision) {
          throw new ApiError(409, "configuration_revision_conflict", "服务连接已在其他设备更新，请刷新服务列表后重试");
        }
        const currentConnection = runtime.vault.decrypt(
          await runtime.repository.getActiveEncryptedConnection(service.id, user.id),
        );
        const nextConnection = resolveGuangyaOfficialApiConnection(
          requireObject(request.body, "connection", "光鸭官方 API 登录信息"),
        );
        requireSameGuangyaOfficialApiAccount(currentConnection, nextConnection);
        const adapter = runtime.providers.get("guangya");
        // 关键变量：验证期间若光鸭再次轮换 Token，只更新待保存对象，验证通过后一次性加密落库。
        const providerContext: ProviderConnectionContext = {
          persistConnection: async (refreshedConnection) => {
            Object.assign(nextConnection, refreshedConnection);
          },
        };
        const validation = await adapter.validateConnection(nextConnection, undefined, providerContext);
        if (!validation.valid || !validation.rootAccessible) {
          throw new ApiError(422, "provider_connection_invalid", "APP 当前光鸭登录信息不可用");
        }
        await runtime.repository.refreshActiveEncryptedConnection({
          serviceId: service.id,
          userId: user.id,
          credentialRevision: service.credentialRevision,
          encryptedConnection: runtime.vault.encrypt(nextConnection),
        });
        const updated = await runtime.repository.restoreServiceConnection(service.id, user.id);
        runtime.logBusinessEvent("info", {
          日志关键字: "codex-guangya-official-resync",
          事件: "APP重新同步光鸭官方API登录信息成功",
          用户ID: user.id,
          服务ID: service.id,
          凭据修订: service.credentialRevision,
        });
        return { service: await attachConnectionAuthMode(runtime, updated) };
      } catch (error) {
        runtime.logBusinessEvent("warn", {
          日志关键字: "codex-guangya-official-resync",
          事件: "APP重新同步光鸭官方API登录信息失败",
          用户ID: user.id,
          服务ID: service.id,
          凭据修订: service.credentialRevision,
          错误码: error && typeof error === "object" && "code" in error
            ? String((error as { code?: string }).code)
            : "guangya_official_resync_failed",
        });
        throw error;
      }
    },
  );

  server.post<{ Params: { serviceId: string } }>("/api/v1/services/:serviceId/connection/reconnect", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    const service = await runtime.repository.getServiceDetail(request.params.serviceId, user.id);
    const adapter = runtime.providers.get(service.providerType);
    const connection = runtime.vault.decrypt(
      await runtime.repository.getActiveEncryptedConnection(service.id, user.id),
    );
    try {
      await validateProviderAccess(adapter, connection, service.scanProfile, {
        persistConnection: async (nextConnection) => {
          await runtime.repository.refreshActiveEncryptedConnection({
            serviceId: service.id,
            userId: user.id,
            credentialRevision: service.credentialRevision,
            encryptedConnection: runtime.vault.encrypt(nextConnection),
          });
          runtime.logBusinessEvent("info", {
            日志关键字: "codex-flycloud-provider-token-refresh",
            事件: "重连期间保存Provider刷新令牌",
            用户ID: user.id,
            服务ID: service.id,
            凭据修订: service.credentialRevision,
          });
        },
      });
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
    const updated = await runtime.repository.restoreServiceConnection(service.id, user.id);
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
    const service = await runtime.repository.getServiceDetail(request.params.serviceId, user.id);
    const updateScope = request.body.updateScope === "paths" ? "paths" : "profile";
    const profile = validateScanProfile(
      requireObject(request.body, "scan", "扫描配置"),
      service.providerType,
      service.dataType,
      runtime.providers.get(service.providerType).descriptor.recommendedScanSettings,
      updateScope === "paths",
    );
    const recommendedSettings = runtime.providers.get(service.providerType).descriptor.recommendedScanSettings;
    const connection = runtime.vault.decrypt(await runtime.repository.getActiveEncryptedConnection(service.id, user.id));
    await validateConfiguredScanRoots(runtime.providers.get(service.providerType), connection, profile, {
      persistConnection: async (nextConnection) => {
        await runtime.repository.refreshActiveEncryptedConnection({
          serviceId: service.id,
          userId: user.id,
          credentialRevision: service.credentialRevision,
          encryptedConnection: runtime.vault.encrypt(nextConnection),
        });
        runtime.logBusinessEvent("info", {
          日志关键字: "codex-flycloud-provider-token-refresh",
          事件: "扫描路径验证期间保存Provider刷新令牌",
          用户ID: user.id,
          服务ID: service.id,
          凭据修订: service.credentialRevision,
        });
      },
    });
    const updatedService = await runtime.repository.updateScanProfile(
      request.params.serviceId,
      user.id,
      profile,
      readExpectedRevision(request.body.expectedRevision),
    );
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-scan-concurrency",
      事件: updateScope === "paths" ? "保存扫描路径并保留服务任务数" : "按服务配置保存无上限任务数",
      用户ID: user.id,
      服务ID: service.id,
      扫描任务数: Number(profile.scanDirectoryConcurrency),
      刮削任务数: Number(profile.scrapeTaskConcurrency),
      Provider默认扫描任务数: recommendedSettings.scanDirectoryConcurrency.default,
      Provider默认刮削任务数: recommendedSettings.scrapeTaskConcurrency.default,
    });
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-flycloud-helper-scan-path",
      事件: "更新服务扫描路径",
      用户ID: user.id,
      服务ID: service.id,
      全量路径数: getScanRootsForMode(profile, "full").length,
      增量路径数: getScanRootsForMode(profile, "incremental").length,
      扫描目录并发: Number(profile.scanDirectoryConcurrency ?? 0),
      刮削任务并发: Number(profile.scrapeTaskConcurrency ?? 0),
    });
    return { service: updatedService };
  });

  server.put<{ Params: { serviceId: string }; Body: Record<string, unknown> }>("/api/v1/services/:serviceId/metadata-profile", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    const service = await runtime.repository.getServiceDetail(request.params.serviceId, user.id);
    const profile = validateMetadataProfile(
      requireObject(request.body, "metadata", "元数据配置"),
      service.dataType,
    );
    await runtime.aiModels.validateMetadataProfile(profile);
    const updatedService = await runtime.repository.updateMetadataProfile(
      request.params.serviceId,
      user.id,
      profile,
      readExpectedRevision(request.body.expectedRevision),
    );
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-flycloud-helper-metadata-profile",
      事件: service.dataType === "music" ? "更新音乐元数据配置" : "更新影视元数据配置",
      用户ID: user.id,
      服务ID: service.id,
      ...(service.dataType === "music" ? readMusicMetadataLogFields(profile) : readVideoMetadataLogFields(profile)),
    });
    return { service: updatedService };
  });

  /** 手动为已有但缺少规格的活动视频建立独立后台任务，不改变扫描期间规格开关。 */
  server.post<{ Params: { serviceId: string } }>("/api/v1/services/:serviceId/media-probes/backfill", async (request, reply) => {
    const user = await requireRequestUser(request, runtime.database);
    const service = await runtime.repository.getServiceDetail(request.params.serviceId, user.id);
    if (service.dataType !== "video") throw new ApiError(409, "media_probe_video_only", "只有影视服务可以分析视频规格");
    if (service.status !== "active" && service.status !== "reauthorization_required") {
      throw new ApiError(409, "service_not_active", "请先启用服务，再分析已有视频规格");
    }
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-media-ffprobe-backfill",
      事件: "开始创建已有视频规格后台任务",
      用户ID: user.id,
      服务ID: service.id,
    });
    const result = await runtime.repository.enqueueExistingServiceMediaProbes(service.id, user.id, user.id);
    const job = result.jobId
      ? service.status === "reauthorization_required"
        ? await runtime.repository.waitMediaProbeJobForReauthorization(result.jobId, user.id)
        : await runtime.repository.getJob(result.jobId, user.id)
      : null;
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-media-ffprobe-backfill",
      事件: "用户触发已有视频规格分析",
      用户ID: user.id,
      服务ID: service.id,
      后台任务ID: result.jobId,
      入队文件数量: result.queuedCount,
      是否等待重新授权: service.status === "reauthorization_required",
    });
    return reply.status(result.jobId ? 202 : 200).send({ job, queuedCount: result.queuedCount });
  });

  server.patch<{ Params: { serviceId: string }; Body: Record<string, unknown> }>("/api/v1/services/:serviceId/playback-settings", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    if (typeof request.body.relayPlaybackEnabled !== "boolean") {
      throw validationError("relayPlaybackEnabled", "APP 专用中转播放开关必须是布尔值");
    }
    const currentService = await runtime.repository.getServiceDetail(request.params.serviceId, user.id);
    if (request.body.relayPlaybackEnabled
      && !runtime.providers.get(currentService.providerType).descriptor.capabilities.some((capability) => capability === "relayPlayback" || capability === "relay")) {
      throw new ApiError(422, "provider_relay_playback_unsupported", "当前网盘类型暂不支持中转播放");
    }
    const service = await runtime.repository.updateRelayPlaybackEnabled(
      request.params.serviceId,
      user.id,
      request.body.relayPlaybackEnabled,
    );
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-flycloud-helper-relay-playback-setting",
      事件: "用户通过兼容接口更新媒体库APP专用中转开关",
      用户ID: user.id,
      服务ID: service.id,
      是否启用APP专用中转: service.relayPlaybackEnabled,
    });
    return { service };
  });

  /** 保存当前账号所属服务的任务完成通知开关。 */
  server.patch<{ Params: { serviceId: string }; Body: Record<string, unknown> }>("/api/v1/services/:serviceId/notification-settings", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    if (typeof request.body.notificationEnabled !== "boolean") {
      throw validationError("notificationEnabled", "任务完成通知开关必须是布尔值");
    }
    const service = await runtime.repository.updateServiceNotificationEnabled(
      request.params.serviceId,
      user.id,
      request.body.notificationEnabled,
    );
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-flycloud-helper-service-notification",
      事件: "用户更新服务任务通知开关",
      用户ID: user.id,
      服务ID: service.id,
      是否启用任务通知: service.notificationEnabled,
    });
    return { service };
  });

  server.patch<{ Params: { serviceId: string }; Body: Record<string, unknown> }>("/api/v1/services/:serviceId/status", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    const status = request.body.status;
    if (status !== "active" && status !== "disabled") {
      throw validationError("status", "服务状态只支持 active 或 disabled");
    }
    return { service: await runtime.repository.updateServiceStatus(request.params.serviceId, user.id, status) };
  });

  server.delete<{ Params: { serviceId: string }; Body: Record<string, unknown> }>("/api/v1/services/:serviceId", async (request, reply) => {
    const user = await requireRequestUser(request, runtime.database);
    requireConfirmation(request.body, request.params.serviceId);
    // 关键变量：删除后服务记录不可再读取，先保存通知所需的脱敏名称与归属。
    const service = await runtime.repository.getServiceDetail(request.params.serviceId, user.id);
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-flycloud-helper-service-delete",
      事件: "用户开始删除云端服务",
      用户ID: user.id,
      服务ID: request.params.serviceId,
    });
    try {
      await runtime.repository.deleteService(request.params.serviceId, user.id);
    } catch (error) {
      runtime.logBusinessEvent("warn", {
        日志关键字: "codex-flycloud-helper-service-delete",
        事件: "用户删除云端服务失败",
        用户ID: user.id,
        服务ID: request.params.serviceId,
        错误码: error && typeof error === "object" && "code" in error
          ? String((error as { code?: string }).code)
          : "service_delete_failed",
      });
      throw error;
    }
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-flycloud-helper-service-delete",
      事件: "用户删除云端服务成功",
      用户ID: user.id,
      服务ID: request.params.serviceId,
    });
    await runtime.database.createNotificationSafely({
      userId: user.id,
      category: "security",
      tone: "warning",
      title: "服务已删除",
      message: `云端服务“${service.displayName}”及其媒体库数据已删除。`,
      actionPath: "/app/services",
    });
    await runtime.database.createSuperAdminNotificationsSafely({
      category: "security",
      tone: "warning",
      title: "用户删除服务",
      message: `账号“${user.username}”删除了云端服务“${service.displayName}”。`,
      actionPath: "/admin/services",
      excludeUserId: user.id,
    });
    return reply.status(204).send();
  });

  server.delete<{ Params: { serviceId: string }; Body: Record<string, unknown> }>("/api/v1/services/:serviceId/catalog", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    requireConfirmation(request.body, request.params.serviceId);
    const service = await runtime.repository.getServiceDetail(request.params.serviceId, user.id);
    const clearStartedAtMs = Date.now();
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-flycloud-helper-catalog-clear",
      事件: "用户开始清空服务媒体库",
      用户ID: user.id,
      服务ID: request.params.serviceId,
    });
    const cleared = await runtime.repository.clearServiceCatalog(request.params.serviceId, user.id);
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
      清空耗时毫秒: Date.now() - clearStartedAtMs,
    });
    await runtime.database.createNotificationSafely({
      userId: user.id,
      category: "security",
      tone: "warning",
      title: "媒体库数据已清空",
      message: `服务“${service.displayName}”的 ${cleared.mediaItemCount} 个媒体条目和 ${cleared.sourceFileCount} 个源文件索引已清空。`,
      actionPath: `/app/services/${service.id}`,
    });
    await runtime.database.createSuperAdminNotificationsSafely({
      category: "security",
      tone: "warning",
      title: "用户清空媒体库",
      message: `账号“${user.username}”清空了服务“${service.displayName}”的媒体库数据。`,
      actionPath: "/admin/services",
      excludeUserId: user.id,
    });
    return cleared;
  });

  server.post<{ Params: { serviceId: string }; Body: Record<string, unknown> }>("/api/v1/services/:serviceId/scan-jobs", async (request, reply) => {
    const user = await requireRequestUser(request, runtime.database);
    const scanMode = request.body.scanMode;
    if (scanMode !== "incremental" && scanMode !== "full") {
      throw validationError("scanMode", "扫描模式只支持 incremental 或 full");
    }
    const service = await runtime.repository.getServiceDetail(request.params.serviceId, user.id);
    const unfinishedJob = await runtime.repository.findUnfinishedScanJob(request.params.serviceId, user.id);
    if (service.status === "scanning" || unfinishedJob) {
      throw new ApiError(409, "scan_job_conflict", "当前服务正在扫描或已有未结束任务，不能重复启动");
    }
    if (getScanRootsForMode(service.scanProfile, scanMode).length === 0) {
      throw new ApiError(409, "scan_paths_not_configured", `请先配置${scanMode === "full" ? "全量" : "增量"}扫描路径`);
    }
    const job = await runtime.repository.createScanJob({
      jobId: randomUUID(),
      userId: user.id,
      serviceId: request.params.serviceId,
      requestedByUserId: user.id,
      requestId: requireString(request.body, "requestId", "请求 ID", 200),
      clientDeviceId: requireString(request.body, "clientDeviceId", "客户端设备 ID", 200),
      scanMode,
      runtimeRevision: "scanner-worker-v1",
      tmdbKeyPoolRevision: runtime.tmdb.revision,
      aiModel: await runtime.aiModels.buildTaskSnapshot(service.metadataProfile),
      pluginVersions: await runtime.plugins.buildTaskSnapshots(service.metadataProfile),
    });
    runtime.logBusinessEvent("info", { 事件: "创建扫描任务", 用户ID: user.id, 服务ID: job.serviceId, 任务ID: job.id });
    return reply.status(202).send({ job });
  });

  server.get<{ Querystring: Record<string, unknown> }>("/api/v1/scan-jobs", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    const status = typeof request.query.status === "string" ? request.query.status : "";
    const supportedStatuses: JobStatus[] = ["queued", "running", "retry_waiting", "paused", "completed", "failed", "cancelled"];
    if (status && status !== "active" && !supportedStatuses.includes(status as JobStatus)) {
      throw validationError("status", "任务状态筛选值无效");
    }
    const jobType = typeof request.query.jobType === "string" ? request.query.jobType : "";
    if (jobType && jobType !== "scan" && jobType !== "media_probe") {
      throw validationError("jobType", "任务类型筛选值无效");
    }
    return runtime.repository.listJobs({
      userId: user.id,
      serviceId: typeof request.query.serviceId === "string" ? request.query.serviceId : undefined,
      status: status && status !== "active" ? status as JobStatus : undefined,
      statuses: status === "active" ? ["queued", "running", "retry_waiting", "paused"] : undefined,
      jobType: jobType ? jobType as "scan" | "media_probe" : undefined,
      ...readPagination(request.query),
    });
  });

  server.get<{ Params: { jobId: string } }>("/api/v1/scan-jobs/:jobId", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    return { job: await runtime.repository.getJob(request.params.jobId, user.id) };
  });

  server.get<{ Params: { jobId: string }; Querystring: Record<string, unknown> }>("/api/v1/scan-jobs/:jobId/events", async (request, reply) => {
    const user = await requireRequestUser(request, runtime.database);
    await runtime.repository.getJob(request.params.jobId, user.id);
    const start = readEventSequence(request.headers as Record<string, unknown>, request.query);
    streamJobEvents(reply, start, (afterSequence) => runtime.repository.listJobEvents({
      userId: user.id,
      jobId: request.params.jobId,
      afterSequence,
      limit: 200,
    }));
  });

  for (const action of ["pause", "cancel"] as const) {
    server.post<{ Params: { jobId: string } }>(`/api/v1/scan-jobs/:jobId/${action}`, async (request) => {
      const user = await requireRequestUser(request, runtime.database);
      const job = await runtime.repository.requestJobControl(request.params.jobId, user.id, action);
      const interrupted = job.jobType === "media_probe"
        ? runtime.mediaProbeWorker.interruptJobControl(job.id, action)
        : runtime.worker.interruptJobControl(job.id, action);
      // 规格分析任务可能正处于两个文件之间；没有 ffprobe 可中断时由接口直接完成状态切换。
      const updatedJob = job.jobType === "media_probe" && !interrupted && job.status === "running"
        ? await runtime.repository.applyMediaProbeJobControl(job.id, action)
        : job;
      runtime.logBusinessEvent("info", {
        日志关键字: "codex-flycloud-helper-job-control",
        事件: action === "cancel" ? "用户终止后台任务" : "用户暂停后台任务",
        用户ID: user.id,
        任务ID: job.id,
        后台任务类型: job.jobType,
        控制动作: action,
        是否中断运行请求: interrupted,
      });
      return { job: updatedJob };
    });
  }

  server.delete<{ Body: Record<string, unknown> }>("/api/v1/scan-jobs/completed", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    requireConfirmation(request.body, "completed");
    const result = await runtime.repository.deleteCompletedJobs(user.id);
    for (const job of result.scanJobs) await runtime.failureReports.remove(job);
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-flycloud-helper-job-clear",
      事件: "用户清除已完成任务",
      用户ID: user.id,
      删除任务数量: result.deletedCount,
    });
    return { deletedCount: result.deletedCount };
  });

  server.delete<{ Params: { jobId: string }; Body: Record<string, unknown> }>("/api/v1/scan-jobs/:jobId", async (request, reply) => {
    const user = await requireRequestUser(request, runtime.database);
    requireConfirmation(request.body, request.params.jobId);
    const job = await runtime.repository.getJob(request.params.jobId, user.id);
    await runtime.repository.deleteScanJob(request.params.jobId, user.id);
    if (job.jobType === "scan") await runtime.failureReports.remove(job);
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-flycloud-helper-job-delete",
      事件: "用户删除后台任务",
      用户ID: user.id,
      任务ID: request.params.jobId,
    });
    return reply.status(204).send();
  });

  server.post<{ Params: { jobId: string } }>("/api/v1/scan-jobs/:jobId/resume", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    const job = await runtime.repository.resumeJob(request.params.jobId, user.id);
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-flycloud-helper-job-control",
      事件: "用户继续后台任务",
      用户ID: user.id,
      任务ID: job.id,
      控制动作: "resume",
    });
    return { job };
  });

  server.post<{ Params: { jobId: string }; Body: Record<string, unknown> }>("/api/v1/scan-jobs/:jobId/retry", async (request, reply) => {
    const user = await requireRequestUser(request, runtime.database);
    const sourceJob = await runtime.repository.getJob(request.params.jobId, user.id);
    if (sourceJob.jobType === "media_probe") {
      const job = await runtime.repository.retryMediaProbeJob(sourceJob.id, user.id, user.id);
      runtime.logBusinessEvent("info", {
        日志关键字: "codex-media-ffprobe",
        事件: "用户重试规格后台任务",
        用户ID: user.id,
        原任务ID: sourceJob.id,
        新任务ID: job.id,
      });
      return reply.status(202).send({ job });
    }
    if (sourceJob.status !== "failed" && sourceJob.status !== "cancelled") {
      throw new ApiError(409, "job_not_retryable", "只有失败或已取消任务可以重试");
    }
    const service = await runtime.repository.getServiceDetail(sourceJob.serviceId, user.id);
    const retriesAiSupplement = sourceJob.snapshot.taskPurpose === "ai_supplement_unmatched";
    const aiModelSnapshot = retriesAiSupplement
      ? await runtime.aiModels.buildUnmatchedSupplementTaskSnapshot(service.metadataProfile)
      : await runtime.aiModels.buildTaskSnapshot(service.metadataProfile);
    if (retriesAiSupplement && !aiModelSnapshot) {
      throw new ApiError(409, "ai_cleaning_not_enabled", "请先在服务元数据配置中启用 AI 目录文件清洗");
    }
    const job = await runtime.repository.createScanJob({
      jobId: randomUUID(),
      userId: user.id,
      serviceId: sourceJob.serviceId,
      requestedByUserId: user.id,
      requestId: requireString(request.body, "requestId", "请求 ID", 200),
      clientDeviceId: requireString(request.body, "clientDeviceId", "客户端设备 ID", 200),
      scanMode: sourceJob.scanMode,
      runtimeRevision: "scanner-worker-v1",
      tmdbKeyPoolRevision: runtime.tmdb.revision,
      aiModel: aiModelSnapshot,
      taskPurpose: retriesAiSupplement ? "ai_supplement_unmatched" : "standard",
      retryOfJobId: sourceJob.id,
      pluginVersions: await runtime.plugins.buildTaskSnapshots(service.metadataProfile),
    });
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-flycloud-helper-job-retry",
      事件: retriesAiSupplement ? "用户重试AI补充未匹配任务" : "用户重试扫描任务",
      用户ID: user.id,
      原任务ID: sourceJob.id,
      新任务ID: job.id,
      服务ID: job.serviceId,
    });
    return reply.status(202).send({ job });
  });

  server.get<{ Params: { jobId: string } }>("/api/v1/scan-jobs/:jobId/media-probe-failures", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    return { items: await runtime.repository.listMediaProbeJobFailures(request.params.jobId, user.id) };
  });
}
