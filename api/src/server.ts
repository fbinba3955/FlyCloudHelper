import fs from "node:fs";
import path from "node:path";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { AiModelManager } from "./ai/ai-model-manager.js";
import { projectRoot, type ApiConfig } from "./config.js";
import { FlyCloudHelperDatabase } from "./database.js";
import { ApiError } from "./errors.js";
import { LibraryExportService } from "./export-service.js";
import { MusicBrainzClient } from "./metadata/musicbrainz.js";
import { TmdbMetadataCache } from "./metadata/tmdb-cache.js";
import { TmdbKeyPool } from "./metadata/tmdb.js";
import { MetadataPluginManager } from "./plugin-manager.js";
import { ProviderRegistry } from "./providers/registry.js";
import { registerAdminRoutes } from "./routes/admin-routes.js";
import { registerAdminNotificationSettingsRoutes } from "./routes/admin-notification-settings-routes.js";
import { registerAiModelRoutes } from "./routes/ai-model-routes.js";
import { registerAuthRoutes } from "./routes/auth-routes.js";
import { registerCatalogRoutes } from "./routes/catalog-routes.js";
import { registerGuangyaAuthRoutes } from "./routes/guangya-auth-routes.js";
import { registerMediaStreamRoutes } from "./routes/media-stream-routes.js";
import { registerMusicArtworkRoutes } from "./routes/music-artwork-routes.js";
import { registerNavidromeRoutes } from "./routes/navidrome-routes.js";
import { registerNotificationRoutes } from "./routes/notification-routes.js";
import { registerScanScheduleRoutes } from "./routes/scan-schedule-routes.js";
import { registerPluginRoutes } from "./routes/plugin-routes.js";
import { PublicAccessService } from "./public-access.js";
import { ServiceAccessService } from "./service-access.js";
import { EmbyAccessService } from "./emby-access.js";
import { registerScanFailureReportRoutes } from "./routes/scan-failure-report-routes.js";
import { registerServiceRoutes } from "./routes/service-routes.js";
import { registerServiceMigrationRoutes } from "./routes/service-migration-routes.js";
import { registerServiceAccessRoutes } from "./routes/service-access-routes.js";
import { registerJellyfinRoutes } from "./routes/jellyfin-routes.js";
import { registerEmbyRoutes } from "./routes/emby-routes.js";
import { registerAggregateServiceRoutes } from "./routes/aggregate-service-routes.js";
import { AggregateServiceRepository } from "./aggregate-service-repository.js";
import { AggregateIndexService } from "./aggregate-index-service.js";
import { AggregateAccessService } from "./aggregate-access-service.js";
import type { ApiRuntime } from "./runtime.js";
import { ScanScheduleStore, ScanScheduleWorker } from "./scan-schedule-service.js";
import { ScanFailureReportService } from "./scan-failure-report-service.js";
import { CredentialVault } from "./secrets.js";
import { ServiceRepository } from "./service-repository.js";
import { ServiceMigrationRepository } from "./service-migration-repository.js";
import { ServiceMigrationWorker } from "./service-migration-worker.js";
import { loadTmdbBaseUrls, loadTmdbKeys } from "./system-settings.js";
import { ScanWorker } from "./worker.js";
import { MediaProbeWorker } from "./media-probe-worker.js";
import { TelegramNotificationService } from "./telegram-notification-service.js";

/** 判断当前 API 是否允许在首次初始化未完成时访问。 */
function isSetupPublicPath(url: string): boolean {
  const pathname = url.split("?", 1)[0] ?? url;
  return new Set([
    "/api/v1/health",
    "/api/v1/system/info",
    "/api/v1/setup/status",
    "/api/v1/setup/super-admin",
  ]).has(pathname);
}

/** 主密钥待备份期间仅开放恢复登录和完成备份所需接口。 */
function isCredentialBackupAllowedPath(url: string): boolean {
  const pathname = url.split("?", 1)[0] ?? url;
  return new Set([
    "/api/v1/health",
    "/api/v1/system/info",
    "/api/v1/setup/status",
    "/api/v1/setup/credential-key-backup",
    "/api/v1/setup/credential-key-backup/acknowledge",
    "/api/v1/auth/login",
    "/api/v1/auth/refresh",
    "/api/v1/auth/me",
    "/api/v1/auth/logout",
  ]).has(pathname);
}

/** 记录不包含凭据、Key、数据库地址和完整媒体路径的中文业务日志。 */
function createBusinessLogger(server: FastifyInstance) {
  return (
    level: "info" | "warn",
    fields: Record<string, string | number | boolean | null>,
  ): void => {
    server.log[level]({ 日志标记: "flycloud-helper-api", ...fields });
  };
}

/** 从根包清单读取当前服务版本，确保 Docker 与本地部署展示同一版本号。 */
function readServiceVersion(): string {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"),
    ) as { version?: unknown };
    return typeof manifest.version === "string" && manifest.version.trim()
      ? manifest.version.trim()
      : "unknown";
  } catch {
    return "unknown";
  }
}

/** 创建并初始化 FlyCloudHelper API、Worker 与全部后台能力。 */
export async function buildApiServer(config: ApiConfig): Promise<FastifyInstance> {
  // 关键变量：服务进程启动后版本保持不变，健康检查无需重复读取磁盘。
  const serviceVersion = readServiceVersion();
  const server = Fastify({
    // Jellyfin 官方 ASP.NET 路由不区分大小写，兼容客户端可能混用 Items/items、Videos/videos。
    caseSensitive: false,
    logger: {
      level: process.env.NODE_ENV === "production" ? "info" : "debug",
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "password",
          "accessToken",
          "refreshToken",
          "masterKey",
          "credentialKeyBackup.masterKey",
          "connection",
          "apiKey",
          "body.apiKey",
          "req.body.apiKey",
          "botToken",
          "body.botToken",
          "req.body.botToken",
        ],
        censor: "[已脱敏]",
      },
    },
    bodyLimit: Math.max(
      1024 * 1024,
      config.pluginMaxBytes + 1024 * 1024,
      config.migrationChunkMaxBytes + 1024 * 1024,
    ),
  });
  const database = new FlyCloudHelperDatabase(config, (level, fields) => {
    server.log[level](fields);
  });
  await database.initialize();
  await database.bindCredentialMasterKey({
    fingerprint: config.credentialKeyFingerprint,
    source: config.credentialKeySource,
    generatedNow: config.credentialKeyGeneratedNow,
  });
  const logger = createBusinessLogger(server);
  const providers = new ProviderRegistry(config, (fields) => logger("warn", fields));
  const vault = new CredentialVault(config.credentialMasterKey);
  const telegramNotifications = new TelegramNotificationService(database, vault, logger);
  database.setNotificationDeliveryHandler((notification) => telegramNotifications.enqueue(notification));
  const serviceAccess = new ServiceAccessService(database, vault);
  const embyAccess = new EmbyAccessService(database);
  const aggregateServices = new AggregateServiceRepository(database);
  const aggregateIndex = new AggregateIndexService(database, logger);
  const aggregateAccess = new AggregateAccessService(database);
  const backfilledAggregateAccounts = await aggregateAccess.ensureExistingServices();
  if (backfilledAggregateAccounts > 0) {
    logger("info", {
      日志关键字: "codex-aggregate-account",
      事件: "补齐聚合服务初始访问账号",
      补齐账号数量: backfilledAggregateAccounts,
    });
  }
  const repository = new ServiceRepository(database, serviceAccess, logger, {
    scanWorkerConcurrency: config.workerConcurrency,
    mediaProbeConcurrency: config.mediaProbeConcurrency,
  });
  const publicAccess = new PublicAccessService(database, config);
  const backfilledServiceAccessAccounts = await serviceAccess.ensureExistingServices();
  const backfilledEmbyAccessAccounts = await embyAccess.ensureExistingServices();
  if (backfilledServiceAccessAccounts > 0) {
    logger("info", {
      日志关键字: "codex-jellyfin-compat", 事件: "为历史服务补齐独立访问账号",
      补齐账号数量: backfilledServiceAccessAccounts,
    });
  }
  if (backfilledEmbyAccessAccounts > 0) {
    logger("info", {
      日志关键字: "codex-emby-account",
      事件: "为历史服务补齐独立Emby访问账号",
      补齐账号数量: backfilledEmbyAccessAccounts,
    });
  }
  const migrations = new ServiceMigrationRepository(database);
  const tmdbCache = new TmdbMetadataCache(database, logger);
  const tmdbBaseUrls = await loadTmdbBaseUrls(database); // 关键变量：启动时一次读取当前 TMDB API 与图片地址。
  const tmdb = new TmdbKeyPool(
    config,
    await loadTmdbKeys(database, vault),
    (fields) => server.log.warn(fields),
    tmdbCache,
    tmdbBaseUrls,
  );
  logger("info", {
    日志关键字: "codex-flycloud-helper-tmdb-proxy",
    事件: "TMDB代理地址启动配置已加载",
    配置来源: tmdbBaseUrls.source === "database" ? "系统设置" : "默认地址",
    配置修订: tmdbBaseUrls.configurationRevision,
  });
  const musicBrainz = new MusicBrainzClient(config);
  const plugins = new MetadataPluginManager(database, config, vault);
  const aiModels = new AiModelManager(database, vault);
  const failureReports = new ScanFailureReportService(config, server.log);
  const exports = new LibraryExportService(database, config, (level, fields) => {
    if (level === "warn") {
      server.log.warn(fields);
      return;
    }
    server.log.info(fields);
  });
  const worker = new ScanWorker({
    database,
    repository,
    providers,
    vault,
    tmdb,
    musicBrainz,
    plugins,
    aiModels,
    failureReports,
    logger: server.log,
    config,
  });
  const mediaProbeWorker = new MediaProbeWorker({
    database,
    repository,
    providers,
    vault,
    logger: server.log,
    config,
  });
  const scanSchedules = new ScanScheduleStore(database);
  const scanScheduleWorker = new ScanScheduleWorker({
    store: scanSchedules,
    repository,
    plugins,
    aiModels,
    tmdb,
    logger,
  });
  const migrationWorker = new ServiceMigrationWorker({
    database,
    repository: migrations,
    exports,
    config,
    logger: server.log,
  });
  const runtime: ApiRuntime = {
    config,
    database,
    repository,
    migrations,
    migrationWorker,
    providers,
    vault,
    tmdbCache,
    tmdb,
    musicBrainz,
    worker,
    mediaProbeWorker,
    scanSchedules,
    scanScheduleWorker,
    plugins,
    aiModels,
    exports,
    failureReports,
    publicAccess,
    serviceAccess,
    embyAccess,
    aggregateServices,
    aggregateIndex,
    aggregateAccess,
    telegramNotifications,
    logBusinessEvent: logger,
  };
  await aggregateIndex.start();

  await server.register(cookie);
  await server.register(multipart, {
    limits: {
      fileSize: Math.max(config.pluginMaxBytes, config.migrationChunkMaxBytes),
      files: 1,
      fields: 10,
      parts: 12,
    },
  });
  server.addHook("onClose", async () => {
    await telegramNotifications.close();
    await scanScheduleWorker.stop();
    await migrationWorker.stop();
    await worker.stop();
    await mediaProbeWorker.stop();
    await tmdbCache.close();
    await database.close();
  });

  server.addHook("preHandler", async (request) => {
    // 关键变量：对外媒体协议同样依赖数据库和凭据主密钥，初始化或主密钥待备份时不能绕过后台保护状态。
    const requiresReadyState = request.url.startsWith("/api/")
      || request.url.startsWith("/j/")
      || request.url.startsWith("/e/")
      || request.url.startsWith("/n/");
    const systemState = requiresReadyState ? await database.getSystemState() : null;
    if (systemState?.setupRequired && !isSetupPublicPath(request.url)) {
      throw new ApiError(503, "setup_required", "实例尚未完成首次初始化");
    }
    if (systemState?.credentialKeyBackupRequired && !systemState.setupRequired
      && !isCredentialBackupAllowedPath(request.url)) {
      throw new ApiError(503, "credential_key_backup_required", "请先使用超级管理员完成凭据主密钥备份");
    }
    const mutatingMethod = request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS";
    const usesCookieSession = Boolean(request.cookies.flycloud_helper_session) && !request.headers.authorization;
    if (request.url.startsWith("/api/") && mutatingMethod && usesCookieSession) {
      const origin = request.headers.origin;
      const fetchSite = request.headers["sec-fetch-site"];
      if (fetchSite === "cross-site") {
        throw new ApiError(403, "csrf_rejected", "跨站请求已被拒绝");
      }
      if (origin) {
        let originHost = "";
        try {
          originHost = new URL(origin).host;
        } catch {
          throw new ApiError(403, "csrf_rejected", "请求来源无效");
        }
        const requestHost = request.headers["x-forwarded-host"] ?? request.headers.host;
        if (originHost !== requestHost) {
          request.log.warn({
            日志关键字: "codex-flycloud-helper-csrf",
            事件: "CSRF来源主机不一致",
            来源主机: originHost,
            请求主机: requestHost ?? "",
            原始请求主机: request.headers.host ?? "",
            转发请求主机: request.headers["x-forwarded-host"] ?? "",
            Fetch站点: fetchSite ?? "",
          });
          throw new ApiError(403, "csrf_rejected", "跨站请求已被拒绝");
        }
      }
    }
  });

  server.addHook("onSend", async (request, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "same-origin");
    reply.header("X-Frame-Options", "DENY");
    if (!request.url.startsWith("/api/")) {
      reply.header(
        "Content-Security-Policy",
        "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
      );
    }
    return payload;
  });

  server.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      logger("warn", {
        事件: "业务请求失败",
        请求路径: request.url.split("?", 1)[0] ?? request.url,
        错误码: error.code,
        状态码: error.statusCode,
      });
      return reply.status(error.statusCode).send({
        error: { code: error.code, message: error.message, fields: error.fields },
      });
    }
    const statusCode = error && typeof error === "object" && "statusCode" in error && typeof error.statusCode === "number"
      ? error.statusCode
      : 500;
    request.log.error({ 日志标记: "flycloud-helper-api", 事件: "未处理异常", 错误: error });
    return reply.status(statusCode).send({
      error: {
        code: statusCode === 413 ? "request_too_large" : "internal_error",
        message: statusCode === 413 ? "请求内容超过大小限制" : "服务内部错误",
      },
    });
  });

  server.get("/api/v1/health", async () => ({
    status: "ok",
    version: serviceVersion,
    databaseType: config.databaseType,
    worker: worker.getStatus(),
    mediaProbeWorker: mediaProbeWorker.getStatus(),
  }));

  server.get("/api/v1/system/info", async () => {
    const state = await database.getSystemState();
    const credentialReady = vault.isConfigured();
    const tmdbStatus = tmdb.getStatus();
    return {
      service: "flycloud-helper",
      version: serviceVersion,
      serviceInstanceId: state.serviceInstanceId,
      protocolVersion: 1,
      status: state.setupRequired
        ? "setup_required"
        : state.credentialKeyBackupRequired
          ? "credential_key_backup_required"
          : credentialReady ? "ready" : "configuration_required",
      setupRequired: state.setupRequired,
      supportedMediaTypes: ["video", "music"],
      providers: providers.listDescriptors(),
      metadataProviders: [
        {
          id: "builtin.tmdb",
          status: tmdbStatus.healthyCount > 0 ? "available" : tmdbStatus.configuredCount > 0 ? "degraded" : "unavailable",
          supportedMediaTypes: ["video"],
        },
        { id: "builtin.music-platforms", status: "available", supportedMediaTypes: ["music"] },
        { id: "builtin.musicbrainz", status: "available", supportedMediaTypes: ["music"], legacyAliasOf: "builtin.music-platforms" },
        { id: "musicbrainz", status: "available", supportedMediaTypes: ["music"] },
        { id: "netease", status: "available", supportedMediaTypes: ["music"] },
        { id: "qmusic", status: "available", supportedMediaTypes: ["music"] },
        { id: "kugou", status: "available", supportedMediaTypes: ["music"] },
        { id: "migu", status: "available", supportedMediaTypes: ["music"] },
        { id: "kuwo", status: "available", supportedMediaTypes: ["music"] },
        {
          id: "builtin.acoustid",
          status: "unavailable",
          reasonCode: "provider_media_stream_not_implemented",
          configured: Boolean(config.acoustidApiKey && config.fpcalcPath),
          supportedMediaTypes: ["music"],
        },
      ],
      features: {
        firstUseSetup: true,
        scan: true,
        metadataProcessing: true,
        pluginMetadata: true,
        metadataPluginImport: true,
        adminConsole: true,
        userPortal: true,
        selfRegistration: true,
        adminUserManagement: true,
        adminServiceManagement: true,
        adminJobRealtime: true,
        adminCatalogBrowse: true,
        pluginConfiguration: true,
        webPlayback: false,
        realtimeEvents: true,
        catalogQuery: true,
        catalogExport: true,
        relayPlayback: true,
        jellyfinCompatibility: true,
        embyCompatibility: true,
        navidromeCompatibility: true,
      },
    };
  });

  await registerAuthRoutes(server, { config, database, logBusinessEvent: logger });
  await registerGuangyaAuthRoutes(server, runtime);
  await registerServiceRoutes(server, runtime);
  await registerScanScheduleRoutes(server, runtime, scanSchedules);
  await registerServiceAccessRoutes(server, runtime);
  await registerAggregateServiceRoutes(server, runtime);
  await registerServiceMigrationRoutes(server, runtime);
  await registerScanFailureReportRoutes(server, runtime);
  await registerCatalogRoutes(server, runtime);
  await registerMusicArtworkRoutes(server, runtime);
  await registerMediaStreamRoutes(server, runtime);
  await registerJellyfinRoutes(server, runtime);
  await registerEmbyRoutes(server, runtime);
  await registerNavidromeRoutes(server, runtime);
  await registerNotificationRoutes(server, runtime);
  await registerAdminNotificationSettingsRoutes(server, runtime);
  await registerAdminRoutes(server, runtime);
  await registerAiModelRoutes(server, runtime);
  await registerPluginRoutes(server, runtime);

  if (fs.existsSync(config.webDistDirectory)) {
    await server.register(fastifyStatic, {
      root: config.webDistDirectory,
      prefix: "/",
      wildcard: false,
    });
    server.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/") || request.url.startsWith("/j/") || request.url.startsWith("/e/") || request.url.startsWith("/n/")) {
        return reply.status(404).send({ error: { code: "not_found", message: "接口不存在" } });
      }
      return reply.sendFile("index.html");
    });
  }

  const recoveredJobs = await repository.recoverInterruptedJobs();
  if (recoveredJobs > 0) {
    logger("warn", { 事件: "恢复中断扫描任务", 任务数量: recoveredJobs });
  }
  const recoveredMigrations = await migrations.recoverInterrupted();
  if (recoveredMigrations > 0) {
    logger("warn", {
      日志关键字: "codex-flycloud-service-migration",
      事件: "恢复中断服务迁移",
      迁移数量: recoveredMigrations,
    });
  }
  const recoveredMediaProbes = await mediaProbeWorker.recoverInterrupted();
  if (recoveredMediaProbes > 0) {
    logger("warn", {
      日志关键字: "codex-media-ffprobe",
      事件: "恢复中断媒体规格任务",
      任务数量: recoveredMediaProbes,
    });
  }
  migrationWorker.start();
  worker.start();
  mediaProbeWorker.start();
  scanScheduleWorker.start();
  return server;
}
