import fs from "node:fs";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import type { ApiConfig } from "./config.js";
import { FlyCloudHelperDatabase } from "./database.js";
import { ApiError } from "./errors.js";
import { LibraryExportService } from "./export-service.js";
import { MusicBrainzClient } from "./metadata/musicbrainz.js";
import { TmdbMetadataCache } from "./metadata/tmdb-cache.js";
import { TmdbKeyPool } from "./metadata/tmdb.js";
import { MetadataPluginManager } from "./plugin-manager.js";
import { ProviderRegistry } from "./providers/registry.js";
import { registerAdminRoutes } from "./routes/admin-routes.js";
import { registerAuthRoutes } from "./routes/auth-routes.js";
import { registerCatalogRoutes } from "./routes/catalog-routes.js";
import { registerGuangyaAuthRoutes } from "./routes/guangya-auth-routes.js";
import { registerMediaStreamRoutes } from "./routes/media-stream-routes.js";
import { registerNotificationRoutes } from "./routes/notification-routes.js";
import { registerPluginRoutes } from "./routes/plugin-routes.js";
import { registerScanFailureReportRoutes } from "./routes/scan-failure-report-routes.js";
import { registerServiceRoutes } from "./routes/service-routes.js";
import { registerServiceMigrationRoutes } from "./routes/service-migration-routes.js";
import type { ApiRuntime } from "./runtime.js";
import { ScanFailureReportService } from "./scan-failure-report-service.js";
import { CredentialVault } from "./secrets.js";
import { ServiceRepository } from "./service-repository.js";
import { ServiceMigrationRepository } from "./service-migration-repository.js";
import { ServiceMigrationWorker } from "./service-migration-worker.js";
import { loadTmdbKeys } from "./system-settings.js";
import { ScanWorker } from "./worker.js";

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

/** 创建并初始化 FlyCloudHelper API、Worker 与全部后台能力。 */
export async function buildApiServer(config: ApiConfig): Promise<FastifyInstance> {
  const server = Fastify({
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
  const repository = new ServiceRepository(database);
  const migrations = new ServiceMigrationRepository(database);
  const tmdbCache = new TmdbMetadataCache(database, logger);
  const tmdb = new TmdbKeyPool(
    config,
    await loadTmdbKeys(database, vault),
    (fields) => server.log.warn(fields),
    tmdbCache,
  );
  const musicBrainz = new MusicBrainzClient(config);
  const plugins = new MetadataPluginManager(database, config, vault);
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
    failureReports,
    logger: server.log,
    config,
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
    plugins,
    exports,
    failureReports,
    logBusinessEvent: logger,
  };

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
    await migrationWorker.stop();
    await worker.stop();
    await tmdbCache.close();
    await database.close();
  });

  server.addHook("preHandler", async (request) => {
    const systemState = request.url.startsWith("/api/") ? await database.getSystemState() : null;
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
    databaseType: config.databaseType,
    worker: worker.getStatus(),
  }));

  server.get("/api/v1/system/info", async () => {
    const state = await database.getSystemState();
    const credentialReady = vault.isConfigured();
    const tmdbStatus = tmdb.getStatus();
    return {
      service: "flycloud-helper",
      serviceInstanceId: state.serviceInstanceId,
      protocolVersion: 1,
      status: state.setupRequired
        ? "setup_required"
        : state.credentialKeyBackupRequired
          ? "credential_key_backup_required"
          : credentialReady ? "ready" : "configuration_required",
      setupRequired: state.setupRequired,
      supportedMediaTypes: ["video"],
      providers: providers.listDescriptors(),
      metadataProviders: [
        {
          id: "builtin.tmdb",
          status: tmdbStatus.healthyCount > 0 ? "available" : tmdbStatus.configuredCount > 0 ? "degraded" : "unavailable",
          supportedMediaTypes: ["video"],
        },
        { id: "builtin.musicbrainz", status: "unavailable", reasonCode: "media_type_not_enabled", supportedMediaTypes: ["music"] },
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
      },
    };
  });

  await registerAuthRoutes(server, { config, database, logBusinessEvent: logger });
  await registerGuangyaAuthRoutes(server, runtime);
  await registerServiceRoutes(server, runtime);
  await registerServiceMigrationRoutes(server, runtime);
  await registerScanFailureReportRoutes(server, runtime);
  await registerCatalogRoutes(server, runtime);
  await registerMediaStreamRoutes(server, runtime);
  await registerNotificationRoutes(server, runtime);
  await registerAdminRoutes(server, runtime);
  await registerPluginRoutes(server, runtime);

  if (fs.existsSync(config.webDistDirectory)) {
    await server.register(fastifyStatic, {
      root: config.webDistDirectory,
      prefix: "/",
      wildcard: false,
    });
    server.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
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
  migrationWorker.start();
  worker.start();
  return server;
}
