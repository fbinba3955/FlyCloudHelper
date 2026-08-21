import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { ApiError, validationError } from "../errors.js";
import {
  readPagination,
  requireObject,
  requireRequestUser,
  requireString,
} from "../http.js";
import type { ApiRuntime } from "../runtime.js";
import {
  consumeProviderAuthorization,
  resolveProviderConnection,
  validateMetadataProfile,
  validateProviderAccess,
  validateScanProfile,
  validateServiceDataType,
} from "./service-routes.js";

/** 校验快照字节数，避免客户端声明超出实例限制的迁移包。 */
function readSnapshotBytes(value: unknown, maximumBytes: number): number {
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > maximumBytes) {
    throw validationError("snapshot.totalBytes", `迁移快照大小必须在 1 到 ${maximumBytes} 字节之间`);
  }
  return bytes;
}

/** 校验快照分片数量，当前协议按从 0 开始的连续序号上传。 */
function readSnapshotChunkCount(value: unknown): number {
  const count = Number(value);
  if (!Number.isInteger(count) || count <= 0 || count > 4096) {
    throw validationError("snapshot.totalChunks", "迁移快照分片数必须是 1–4096 之间的整数");
  }
  return count;
}

/** 校验 SHA-256 十六进制摘要并统一为小写。 */
function readSha256(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || !/^[a-f\d]{64}$/iu.test(value.trim())) {
    throw validationError(fieldName, "SHA-256 摘要格式无效");
  }
  return value.trim().toLowerCase();
}

/** 校验 URL 路径中的上传分片序号。 */
function readChunkIndex(value: string): number {
  const index = Number(value);
  if (!Number.isInteger(index) || index < 0) {
    throw validationError("chunkIndex", "上传分片序号无效");
  }
  return index;
}

interface WebdavMigrationPathMappingResult {
  scanProfile: Record<string, unknown>;
  mappedRootCount: number;
  connectionRoot: string;
}

/** 解码并整理 WebDAV URL 路径，解码失败时保留原始路径继续比较。 */
function normalizeWebdavUrlPath(value: string): string {
  let decodedPath = value;
  try {
    decodedPath = decodeURIComponent(value);
  } catch (_error) {
    decodedPath = value;
  }
  const normalizedPath = path.posix.normalize(`/${decodedPath.replace(/^\/+/, "")}`);
  return normalizedPath === "." ? "/" : normalizedPath;
}

/** 把旧版 APP 上传的完整站点路径转换成 WebDAV baseUrl 下的相对扫描路径。 */
function toWebdavConnectionRelativePath(connectionRoot: string, value: string): string {
  const normalizedPath = normalizeWebdavUrlPath(value);
  if (connectionRoot === "/") return normalizedPath;
  if (normalizedPath === connectionRoot) return "/";
  if (normalizedPath.startsWith(`${connectionRoot}/`)) {
    return normalizeWebdavUrlPath(normalizedPath.slice(connectionRoot.length));
  }
  return normalizedPath;
}

/**
 * 兼容旧版 APP 的 WebDAV 迁移请求。
 *
 * 旧版会同时提交包含 /dav 的 baseUrl 和 /dav/... 扫描根，若不在迁移边界转换，
 * Provider 会把请求错误拼成 /dav/dav/...。
 */
function normalizeWebdavMigrationScanProfile(
  providerType: string,
  connection: Record<string, unknown>,
  scanProfile: Record<string, unknown>,
): WebdavMigrationPathMappingResult {
  if (providerType !== "webdav" || typeof connection.baseUrl !== "string") {
    return { scanProfile, mappedRootCount: 0, connectionRoot: "/" };
  }
  let connectionRoot = "/";
  try {
    connectionRoot = normalizeWebdavUrlPath(new URL(connection.baseUrl).pathname);
  } catch (_error) {
    return { scanProfile, mappedRootCount: 0, connectionRoot };
  }
  if (connectionRoot === "/") {
    return { scanProfile, mappedRootCount: 0, connectionRoot };
  }

  let mappedRootCount = 0;
  /** 转换单组扫描根，并保留 driveId、mediaTypes 等既有字段。 */
  const mapRoots = (value: unknown): unknown => {
    if (!Array.isArray(value)) return value;
    return value.map((rootValue) => {
      if (!rootValue || typeof rootValue !== "object" || Array.isArray(rootValue)) return rootValue;
      const root = rootValue as Record<string, unknown>;
      const mappedRoot = { ...root };
      let rootChanged = false;
      for (const field of ["resourceId", "displayPath"] as const) {
        const fieldValue = root[field];
        if (typeof fieldValue !== "string") continue;
        const mappedPath = toWebdavConnectionRelativePath(connectionRoot, fieldValue);
        if (mappedPath !== fieldValue) rootChanged = true;
        mappedRoot[field] = mappedPath;
      }
      if (rootChanged) mappedRootCount += 1;
      return mappedRoot;
    });
  };

  return {
    scanProfile: {
      ...scanProfile,
      fullRoots: mapRoots(scanProfile.fullRoots),
      incrementalRoots: mapRoots(scanProfile.incrementalRoots),
    },
    mappedRootCount,
    connectionRoot,
  };
}

/** 注册 APP 本地服务迁移、分片上传和后台状态查询接口。 */
export async function registerServiceMigrationRoutes(
  server: FastifyInstance,
  runtime: ApiRuntime,
): Promise<void> {
  server.get("/api/v1/service-migrations/capabilities", async (request) => {
    await requireRequestUser(request, runtime.database);
    return {
      snapshotFormatVersion: 1,
      chunkMaxBytes: runtime.config.migrationChunkMaxBytes,
      snapshotMaxBytes: runtime.config.migrationSnapshotMaxBytes,
      supportedProviderTypes: ["webdav", "guangya"],
      supportedDataTypes: ["video"],
    };
  });

  server.post<{ Body: Record<string, unknown> }>("/api/v1/service-migrations", async (request, reply) => {
    const user = await requireRequestUser(request, runtime.database);
    const requestId = requireString(request.body, "requestId", "请求 ID", 200);
    const clientDeviceId = requireString(request.body, "clientDeviceId", "客户端设备 ID", 200);
    const clientServiceId = requireString(request.body, "clientServiceId", "客户端服务 ID", 200);
    const staleMigrationCount = await runtime.migrations.deleteStaleForClientService(
      user.id,
      clientDeviceId,
      clientServiceId,
    );
    if (staleMigrationCount > 0) {
      runtime.logBusinessEvent("info", {
        日志关键字: "codex-flycloud-service-reassociation",
        事件: "清理已删除服务的历史关联",
        用户ID: user.id,
        客户端设备ID: clientDeviceId,
        客户端服务ID: clientServiceId,
        清理迁移数量: staleMigrationCount,
      });
    }
    const existingByRequest = await runtime.migrations.findByRequest(user.id, clientDeviceId, requestId);
    if (existingByRequest) return reply.status(200).send({ migration: existingByRequest });

    const existingForService = await runtime.migrations.findLatestForClientService(
      user.id,
      clientDeviceId,
      clientServiceId,
    );
    if (existingForService && existingForService.status !== "cancelled" && existingForService.status !== "failed") {
      return reply.status(200).send({ migration: existingForService });
    }
    if (existingForService) {
      // 失败或取消任务对应的服务从未正式启用，释放旧绑定后允许 APP 用新请求重新关联。
      try {
        await runtime.repository.deleteService(existingForService.serviceId, user.id);
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== "service_not_found") throw error;
      }
    }
    const existingBinding = await runtime.repository.findClientServiceBinding(
      user.id,
      clientDeviceId,
      clientServiceId,
    );
    if (existingBinding) {
      throw new ApiError(
        409,
        "client_service_already_cloud_managed",
        "该本地服务已经关联云助手，后续只能从云助手同步数据；如需重新上传，请先删除原云端服务并解除关联",
      );
    }

    const displayName = requireString(request.body, "displayName", "服务名称", 100);
    const dataType = validateServiceDataType(request.body.dataType);
    const provider = requireObject(request.body, "provider", "Provider");
    const providerType = requireString(provider, "type", "Provider 类型", 64);
    if (providerType !== "webdav" && providerType !== "guangya") {
      throw new ApiError(422, "migration_provider_unsupported", "当前只支持迁移 WebDAV 和光鸭影视库");
    }
    const resolvedConnection = resolveProviderConnection(
      runtime,
      user.id,
      user.id,
      providerType,
      requireObject(provider, "connection", "连接配置"),
    );
    const adapter = runtime.providers.get(providerType);
    const validatedScanProfile = validateScanProfile(
      requireObject(request.body, "scan", "扫描配置"),
      providerType,
      dataType,
      adapter.descriptor.recommendedScanSettings,
    );
    // 关键变量：兼容旧版 APP 完整路径的结果必须先于 Provider 根目录验证使用。
    const pathMapping = normalizeWebdavMigrationScanProfile(
      providerType,
      resolvedConnection.connection,
      validatedScanProfile,
    );
    const scanProfile = pathMapping.scanProfile;
    if (pathMapping.mappedRootCount > 0) {
      runtime.logBusinessEvent("info", {
        日志关键字: "codex-flycloud-webdav-path-mapping",
        事件: "兼容旧版APP迁移扫描路径",
        用户ID: user.id,
        客户端服务ID: clientServiceId,
        转换目录数: pathMapping.mappedRootCount,
        WebDAV连接根: pathMapping.connectionRoot,
      });
    }
    const metadataProfile = validateMetadataProfile(
      requireObject(request.body, "metadata", "元数据配置"),
      dataType,
    );
    const snapshot = requireObject(request.body, "snapshot", "迁移快照信息");
    const expectedBytes = readSnapshotBytes(snapshot.totalBytes, runtime.config.migrationSnapshotMaxBytes);
    const expectedChunkCount = readSnapshotChunkCount(snapshot.totalChunks);
    const snapshotSha256 = readSha256(snapshot.sha256, "snapshot.sha256");
    const snapshotFormatVersion = Number(snapshot.formatVersion ?? 1);
    if (snapshotFormatVersion !== 1) {
      throw new ApiError(422, "migration_snapshot_version_unsupported", "当前只支持第 1 版迁移快照");
    }

    await validateProviderAccess(adapter, resolvedConnection.connection, scanProfile);
    const serviceId = randomUUID();
    const libraryId = randomUUID();
    const migrationId = randomUUID();
    const service = await runtime.repository.createService({
      serviceId,
      libraryId,
      userId: user.id,
      displayName,
      providerType,
      dataType,
      encryptedConnection: runtime.vault.encrypt(resolvedConnection.connection),
      providerSchemaVersion: adapter.descriptor.credentialSchemaVersion,
      scanProfile,
      metadataProfile,
      binding: { id: randomUUID(), clientDeviceId, clientServiceId },
      initialStatus: "disabled",
    });
    try {
      const migration = await runtime.migrations.create({
        migrationId,
        userId: user.id,
        serviceId: service.id,
        libraryId: service.libraryId,
        requestId,
        clientDeviceId,
        clientServiceId,
        providerType,
        expectedBytes,
        expectedChunkCount,
        snapshotSha256,
        snapshotFormatVersion,
      });
      consumeProviderAuthorization(runtime, user.id, resolvedConnection.authorizationSessionId);
      runtime.logBusinessEvent("info", {
        日志关键字: "codex-flycloud-service-migration",
        事件: "创建服务迁移",
        用户ID: user.id,
        迁移ID: migration.id,
        服务ID: migration.serviceId,
        客户端服务ID: clientServiceId,
        网盘类型: providerType,
      });
      return reply.status(201).send({ migration });
    } catch (error) {
      // 该服务只属于本次尚未成功创建的迁移，失败时回收不会影响任何既有用户数据。
      await runtime.repository.deleteService(service.id, user.id);
      throw error;
    }
  });

  server.get<{ Querystring: Record<string, unknown> }>("/api/v1/service-migrations", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    const pagination = readPagination(request.query);
    return runtime.migrations.list(user.id, pagination.limit, pagination.offset);
  });

  server.get<{ Querystring: Record<string, unknown> }>("/api/v1/service-migrations/resolve", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    const clientDeviceId = requireString(request.query, "clientDeviceId", "客户端设备 ID", 200);
    const clientServiceId = requireString(request.query, "clientServiceId", "客户端服务 ID", 200);
    return {
      migration: await runtime.migrations.findLatestForClientService(user.id, clientDeviceId, clientServiceId),
    };
  });

  server.get<{ Params: { migrationId: string } }>("/api/v1/service-migrations/:migrationId", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    return { migration: await runtime.migrations.get(request.params.migrationId, user.id) };
  });

  server.post<{ Params: { migrationId: string; chunkIndex: string } }>(
    "/api/v1/service-migrations/:migrationId/chunks/:chunkIndex",
    async (request, reply) => {
      const user = await requireRequestUser(request, runtime.database);
      const migration = await runtime.migrations.get(request.params.migrationId, user.id);
      if (migration.status !== "uploading") {
        throw new ApiError(409, "service_migration_not_uploading", "当前关联任务已经不能继续上传");
      }
      const chunkIndex = readChunkIndex(request.params.chunkIndex);
      if (chunkIndex >= migration.totalChunkCount) {
        throw validationError("chunkIndex", "上传分片序号超出范围");
      }
      const expectedChunkSha256 = readSha256(request.headers["x-chunk-sha256"], "x-chunk-sha256");
      const part = await request.file({
        limits: { fileSize: runtime.config.migrationChunkMaxBytes, files: 1 },
      });
      if (!part) throw validationError("file", "请选择需要上传的迁移分片");
      const payload = await part.toBuffer();
      if (payload.length <= 0 || payload.length > runtime.config.migrationChunkMaxBytes) {
        throw new ApiError(413, "migration_chunk_too_large", "迁移分片大小超出实例限制");
      }
      const actualChunkSha256 = createHash("sha256").update(payload).digest("hex");
      if (actualChunkSha256 !== expectedChunkSha256) {
        throw new ApiError(422, "migration_chunk_hash_mismatch", "迁移分片校验失败，请重新上传");
      }

      const chunkDirectory = path.join(
        runtime.config.migrationDirectory,
        user.id,
        migration.id,
        "chunks",
      );
      const chunkPath = path.join(chunkDirectory, `${chunkIndex}.part`);
      await fs.mkdir(chunkDirectory, { recursive: true, mode: 0o700 });
      try {
        await fs.writeFile(chunkPath, payload, { flag: "wx", mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existingPayload = await fs.readFile(chunkPath);
        const existingHash = createHash("sha256").update(existingPayload).digest("hex");
        if (existingPayload.length !== payload.length || existingHash !== actualChunkSha256) {
          throw new ApiError(409, "migration_chunk_conflict", "相同序号的上传分片内容不一致");
        }
      }
      const updated = await runtime.migrations.saveChunk({
        migrationId: migration.id,
        userId: user.id,
        chunkIndex,
        sizeBytes: payload.length,
        sha256: actualChunkSha256,
        filePath: chunkPath,
      });
      runtime.logBusinessEvent("info", {
        日志关键字: "codex-flycloud-migration-upload",
        事件: "保存迁移上传分片",
        用户ID: user.id,
        迁移ID: migration.id,
        分片序号: chunkIndex,
        分片大小: payload.length,
        已完成分片数: updated.uploadedChunkCount,
      });
      return reply.status(200).send({ migration: updated });
    },
  );

  server.post<{ Params: { migrationId: string } }>(
    "/api/v1/service-migrations/:migrationId/complete-upload",
    async (request, reply) => {
      const user = await requireRequestUser(request, runtime.database);
      const migration = await runtime.migrations.completeUpload(request.params.migrationId, user.id);
      runtime.logBusinessEvent("info", {
        日志关键字: "codex-flycloud-service-migration",
        事件: "迁移上传已提交后台处理",
        用户ID: user.id,
        迁移ID: migration.id,
        服务ID: migration.serviceId,
      });
      return reply.status(202).send({ migration });
    },
  );

  server.post<{ Params: { migrationId: string } }>(
    "/api/v1/service-migrations/:migrationId/retry",
    async (request, reply) => {
      const user = await requireRequestUser(request, runtime.database);
      return reply.status(202).send({
        migration: await runtime.migrations.retry(request.params.migrationId, user.id),
      });
    },
  );

  server.post<{ Params: { migrationId: string } }>(
    "/api/v1/service-migrations/:migrationId/cancel",
    async (request) => {
      const user = await requireRequestUser(request, runtime.database);
      const beforeCancel = await runtime.migrations.get(request.params.migrationId, user.id);
      const migration = await runtime.migrations.cancel(request.params.migrationId, user.id);
      if (migration.status === "cancelled" && beforeCancel.status !== "cancelled") {
        await runtime.repository.deleteService(migration.serviceId, user.id);
      }
      return { migration };
    },
  );
}
