import { randomUUID } from "node:crypto";
import type { Knex } from "knex";
import type {
  ServiceMigrationRecord,
  ServiceMigrationStatus,
} from "./domain.js";
import { parseJsonObject } from "./domain.js";
import type { FlyCloudHelperDatabase } from "./database.js";
import { ApiError } from "./errors.js";

const terminalStatuses = new Set<ServiceMigrationStatus>(["completed", "failed", "cancelled"]);
const activeStatuses = new Set<ServiceMigrationStatus>(["validating", "importing", "finalizing"]);

/** 把数据库中的时间差限制为非负运行时长。 */
function calculateActiveSegment(startedAt: unknown, endedAt: unknown): number {
  const start = Date.parse(String(startedAt ?? ""));
  const end = Date.parse(String(endedAt ?? ""));
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0;
}

/** 把数据库迁移行转换成公开状态，并为运行中任务补上当前活动时长。 */
function mapMigration(row: Record<string, unknown>): ServiceMigrationRecord {
  const status = String(row.status) as ServiceMigrationStatus;
  const storedDuration = Number(row.active_duration_ms ?? 0);
  const liveDuration = activeStatuses.has(status) && row.active_started_at
    ? calculateActiveSegment(row.active_started_at, new Date().toISOString())
    : 0;
  const errorCode = row.error_code ? String(row.error_code) : "";
  const result = parseJsonObject(row.result_json);
  return {
    id: String(row.id),
    userId: String(row.user_id),
    serviceId: String(row.service_id),
    libraryId: String(row.library_id),
    requestId: String(row.request_id),
    clientDeviceId: String(row.client_device_id),
    clientServiceId: String(row.client_service_id),
    providerType: String(row.provider_type),
    status,
    stage: String(row.stage) as ServiceMigrationStatus,
    progressPercent: Number(row.progress_percent ?? 0),
    currentOperation: String(row.current_operation ?? ""),
    processedCount: Number(row.processed_count ?? 0),
    totalCount: Number(row.total_count ?? 0),
    uploadedBytes: Number(row.uploaded_bytes ?? 0),
    totalBytes: Number(row.expected_bytes ?? 0),
    uploadedChunkCount: Number(row.uploaded_chunk_count ?? 0),
    totalChunkCount: Number(row.expected_chunk_count ?? 0),
    activeDurationMs: storedDuration + liveDuration,
    error: errorCode ? { code: errorCode, message: String(row.error_message ?? "迁移失败") } : null,
    retryable: Boolean(row.retryable),
    checkpoint: parseJsonObject(row.checkpoint_json),
    result: Object.keys(result).length > 0 ? result : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    finishedAt: row.finished_at ? String(row.finished_at) : null,
  };
}

/** 管理 APP 服务迁移的幂等请求、上传分片和后台任务状态。 */
export class ServiceMigrationRepository {
  private readonly database: FlyCloudHelperDatabase;

  public constructor(database: FlyCloudHelperDatabase) {
    this.database = database;
  }

  /** 按客户端请求 ID 查询已经存在的迁移。 */
  public async findByRequest(
    userId: string,
    clientDeviceId: string,
    requestId: string,
  ): Promise<ServiceMigrationRecord | null> {
    const row = await this.database.query("service_migrations as migration")
      .join("cloud_services as service", "service.id", "migration.service_id")
      .select("migration.*")
      .where({
        "migration.user_id": userId,
        "migration.client_device_id": clientDeviceId,
        "migration.request_id": requestId,
      })
      .whereNull("service.deleted_at")
      .first();
    return row ? mapMigration(row as Record<string, unknown>) : null;
  }

  /** 查询当前本地服务最近一次迁移，用于 APP 恢复关联页面。 */
  public async findLatestForClientService(
    userId: string,
    clientDeviceId: string,
    clientServiceId: string,
  ): Promise<ServiceMigrationRecord | null> {
    const row = await this.database.query("service_migrations as migration")
      .join("cloud_services as service", "service.id", "migration.service_id")
      .select("migration.*")
      .where({
        "migration.user_id": userId,
        "migration.client_device_id": clientDeviceId,
        "migration.client_service_id": clientServiceId,
      })
      .whereNull("service.deleted_at")
      .orderBy("migration.created_at", "desc")
      .first();
    return row ? mapMigration(row as Record<string, unknown>) : null;
  }

  /** 清理本地服务指向已删除云端服务的迁移历史，避免重新关联复用失效服务 ID。 */
  public async deleteStaleForClientService(
    userId: string,
    clientDeviceId: string,
    clientServiceId: string,
  ): Promise<number> {
    return this.database.query.transaction(async (transaction) => {
      const rows = await transaction("service_migrations as migration")
        .leftJoin("cloud_services as service", "service.id", "migration.service_id")
        .select(
          "migration.id as migration_id",
          "service.id as service_id",
          "service.deleted_at as service_deleted_at",
        )
        .where({
          "migration.user_id": userId,
          "migration.client_device_id": clientDeviceId,
          "migration.client_service_id": clientServiceId,
        });

      // 关键变量：只删除服务已经不存在或已经软删除的迁移，不影响仍有效的关联任务。
      const staleMigrationIds = rows
        .filter((row) => {
          const serviceMissing = row.service_id === null || row.service_id === undefined;
          const serviceDeleted = row.service_deleted_at !== null && row.service_deleted_at !== undefined;
          return serviceMissing || serviceDeleted;
        })
        .map((row) => String(row.migration_id));
      if (staleMigrationIds.length === 0) return 0;

      await transaction("service_migration_chunks")
        .whereIn("migration_id", staleMigrationIds)
        .delete();
      const deletedMigrationCount = await transaction("service_migrations")
        .whereIn("id", staleMigrationIds)
        .delete();
      return Number(deletedMigrationCount);
    });
  }

  /** 创建等待 APP 上传本地快照的持久化迁移记录。 */
  public async create(input: {
    migrationId: string;
    userId: string;
    serviceId: string;
    libraryId: string;
    requestId: string;
    clientDeviceId: string;
    clientServiceId: string;
    providerType: string;
    expectedBytes: number;
    expectedChunkCount: number;
    snapshotSha256: string;
    snapshotFormatVersion: number;
  }): Promise<ServiceMigrationRecord> {
    const now = new Date().toISOString();
    await this.database.query("service_migrations").insert({
      id: input.migrationId,
      user_id: input.userId,
      service_id: input.serviceId,
      library_id: input.libraryId,
      request_id: input.requestId,
      client_device_id: input.clientDeviceId,
      client_service_id: input.clientServiceId,
      provider_type: input.providerType,
      status: "uploading",
      stage: "uploading",
      progress_percent: 0,
      current_operation: "等待 APP 上传本地媒体库快照",
      processed_count: 0,
      total_count: input.expectedChunkCount,
      uploaded_bytes: 0,
      expected_bytes: input.expectedBytes,
      uploaded_chunk_count: 0,
      expected_chunk_count: input.expectedChunkCount,
      snapshot_sha256: input.snapshotSha256,
      snapshot_format_version: input.snapshotFormatVersion,
      active_duration_ms: 0,
      active_started_at: null,
      error_code: null,
      error_message: null,
      retryable: 0,
      checkpoint_json: "{}",
      result_json: "{}",
      lease_owner: null,
      lease_expires_at: null,
      created_at: now,
      updated_at: now,
      finished_at: null,
    });
    return this.get(input.migrationId, input.userId);
  }

  /** 按用户归属读取一条迁移。 */
  public async get(migrationId: string, userId?: string): Promise<ServiceMigrationRecord> {
    const query = this.database.query("service_migrations").where({ id: migrationId });
    if (userId) query.where({ user_id: userId });
    const row = await query.first();
    if (!row) throw new ApiError(404, "service_migration_not_found", "服务关联任务不存在");
    return mapMigration(row as Record<string, unknown>);
  }

  /** 列出当前用户的迁移记录。 */
  public async list(userId: string, limit: number, offset: number): Promise<{
    items: ServiceMigrationRecord[];
    total: number;
  }> {
    const [rows, countRow] = await Promise.all([
      this.database.query("service_migrations")
        .where({ user_id: userId })
        .orderBy("created_at", "desc")
        .limit(limit)
        .offset(offset),
      this.database.query("service_migrations")
        .where({ user_id: userId })
        .count<{ count: string | number }[]>({ count: "id" })
        .first(),
    ]);
    return {
      items: rows.map((row) => mapMigration(row as Record<string, unknown>)),
      total: Number(countRow?.count ?? 0),
    };
  }

  /** 幂等记录一个已经写入磁盘并完成哈希校验的上传分片。 */
  public async saveChunk(input: {
    migrationId: string;
    userId: string;
    chunkIndex: number;
    sizeBytes: number;
    sha256: string;
    filePath: string;
  }): Promise<ServiceMigrationRecord> {
    await this.database.query.transaction(async (transaction) => {
      let migrationQuery = transaction("service_migrations")
        .where({ id: input.migrationId, user_id: input.userId });
      if (this.database.databaseType !== "sqlite") migrationQuery = migrationQuery.forUpdate();
      const migration = await migrationQuery.first();
      if (!migration) throw new ApiError(404, "service_migration_not_found", "服务关联任务不存在");
      if (migration.status !== "uploading") {
        throw new ApiError(409, "service_migration_not_uploading", "当前关联任务已经不能继续上传");
      }
      if (input.chunkIndex < 0 || input.chunkIndex >= Number(migration.expected_chunk_count)) {
        throw new ApiError(400, "migration_chunk_index_invalid", "上传分片序号超出范围");
      }
      const existing = await transaction("service_migration_chunks").where({
        migration_id: input.migrationId,
        chunk_index: input.chunkIndex,
      }).first();
      if (existing) {
        if (String(existing.sha256) !== input.sha256 || Number(existing.size_bytes) !== input.sizeBytes) {
          throw new ApiError(409, "migration_chunk_conflict", "相同序号的上传分片内容不一致");
        }
        return;
      }
      await transaction("service_migration_chunks").insert({
        id: randomUUID(),
        migration_id: input.migrationId,
        chunk_index: input.chunkIndex,
        size_bytes: input.sizeBytes,
        sha256: input.sha256,
        file_path: input.filePath,
        created_at: new Date().toISOString(),
      });
      const [countRow, sizeRow] = await Promise.all([
        transaction("service_migration_chunks")
          .where({ migration_id: input.migrationId })
          .count<{ count: string | number }[]>({ count: "id" })
          .first(),
        transaction("service_migration_chunks")
          .where({ migration_id: input.migrationId })
          .sum<{ size: string | number }[]>({ size: "size_bytes" })
          .first(),
      ]);
      const uploadedChunkCount = Number(countRow?.count ?? 0);
      const uploadedBytes = Number(sizeRow?.size ?? 0);
      const progressPercent = Number(migration.expected_bytes) > 0
        ? Math.min(45, Math.floor(uploadedBytes / Number(migration.expected_bytes) * 45))
        : 0;
      await transaction("service_migrations").where({ id: input.migrationId }).update({
        uploaded_chunk_count: uploadedChunkCount,
        uploaded_bytes: uploadedBytes,
        processed_count: uploadedChunkCount,
        progress_percent: progressPercent,
        current_operation: `已上传 ${uploadedChunkCount}/${Number(migration.expected_chunk_count)} 个分片`,
        updated_at: new Date().toISOString(),
      });
    });
    return this.get(input.migrationId, input.userId);
  }

  /** 校验分片数量和总大小后把上传任务幂等提交到后台队列。 */
  public async completeUpload(migrationId: string, userId: string): Promise<ServiceMigrationRecord> {
    await this.database.query.transaction(async (transaction) => {
      let migrationQuery = transaction("service_migrations").where({ id: migrationId, user_id: userId });
      if (this.database.databaseType !== "sqlite") migrationQuery = migrationQuery.forUpdate();
      const migration = await migrationQuery.first();
      if (!migration) throw new ApiError(404, "service_migration_not_found", "服务关联任务不存在");
      if (migration.status !== "uploading") return;
      const chunks = await transaction("service_migration_chunks")
        .select("chunk_index", "size_bytes")
        .where({ migration_id: migrationId })
        .orderBy("chunk_index", "asc");
      if (chunks.length !== Number(migration.expected_chunk_count)
        || chunks.some((chunk, index) => Number(chunk.chunk_index) !== index)) {
        throw new ApiError(409, "migration_chunks_incomplete", "本地媒体库快照尚未完整上传");
      }
      const uploadedBytes = chunks.reduce((sum, chunk) => sum + Number(chunk.size_bytes), 0);
      if (uploadedBytes !== Number(migration.expected_bytes)) {
        throw new ApiError(409, "migration_snapshot_size_mismatch", "上传快照总大小与提交信息不一致");
      }
      const now = new Date().toISOString();
      await transaction("service_migrations").where({ id: migrationId }).update({
        status: "queued",
        stage: "queued",
        progress_percent: 45,
        current_operation: "快照上传完成，等待云助手后台处理",
        processed_count: 0,
        total_count: 0,
        retryable: 0,
        error_code: null,
        error_message: null,
        updated_at: now,
      });
    });
    return this.get(migrationId, userId);
  }

  /** 查询后台合并快照所需的顺序分片。 */
  public async listChunks(migrationId: string): Promise<Array<{
    chunkIndex: number;
    sizeBytes: number;
    sha256: string;
    filePath: string;
  }>> {
    const rows = await this.database.query("service_migration_chunks")
      .where({ migration_id: migrationId })
      .orderBy("chunk_index", "asc");
    return rows.map((row) => ({
      chunkIndex: Number(row.chunk_index),
      sizeBytes: Number(row.size_bytes),
      sha256: String(row.sha256),
      filePath: String(row.file_path),
    }));
  }

  /** 读取仅供 Worker 校验使用的快照期望值，不向 APP 返回服务端文件路径。 */
  public async getSnapshotExpectation(migrationId: string): Promise<{
    sha256: string;
    totalBytes: number;
    formatVersion: number;
  }> {
    const row = await this.database.query("service_migrations")
      .select("snapshot_sha256", "expected_bytes", "snapshot_format_version")
      .where({ id: migrationId })
      .first();
    if (!row) throw new ApiError(404, "service_migration_not_found", "服务关联任务不存在");
    return {
      sha256: String(row.snapshot_sha256),
      totalBytes: Number(row.expected_bytes),
      formatVersion: Number(row.snapshot_format_version),
    };
  }

  /** 服务启动时把进程中断的活动阶段安全退回队列，不把停机时间计入运行时长。 */
  public async recoverInterrupted(): Promise<number> {
    const rows = await this.database.query("service_migrations")
      .whereIn("status", ["validating", "importing", "finalizing"]);
    for (const row of rows) {
      const previousDuration = Number(row.active_duration_ms ?? 0);
      const activeSegment = calculateActiveSegment(row.active_started_at, row.updated_at);
      await this.database.query("service_migrations").where({ id: row.id }).update({
        status: "queued",
        stage: "queued",
        current_operation: "云助手重启后等待恢复关联任务",
        active_duration_ms: previousDuration + activeSegment,
        active_started_at: null,
        lease_owner: null,
        lease_expires_at: null,
        updated_at: new Date().toISOString(),
      });
    }
    return rows.length;
  }

  /** 原子领取下一条排队迁移，同一任务只能被一个 Worker 执行。 */
  public async claimNext(workerId: string): Promise<ServiceMigrationRecord | null> {
    return this.database.query.transaction(async (transaction) => {
      let query = transaction("service_migrations").where({ status: "queued" }).orderBy("updated_at", "asc");
      if (this.database.databaseType !== "sqlite") query = query.forUpdate().skipLocked();
      const row = await query.first();
      if (!row) return null;
      const now = new Date().toISOString();
      const leaseExpiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      const changed = await transaction("service_migrations")
        .where({ id: row.id, status: "queued" })
        .update({
          status: "validating",
          stage: "validating",
          progress_percent: Math.max(46, Number(row.progress_percent ?? 0)),
          current_operation: "正在校验本地媒体库快照",
          active_started_at: now,
          lease_owner: workerId,
          lease_expires_at: leaseExpiresAt,
          updated_at: now,
        });
      if (changed !== 1) return null;
      const claimed = await transaction("service_migrations").where({ id: row.id }).first();
      return claimed ? mapMigration(claimed as Record<string, unknown>) : null;
    });
  }

  /** 更新后台迁移阶段、计数和检查点，并正确累计上一活动阶段时长。 */
  public async updateActiveStage(input: {
    migrationId: string;
    status: "validating" | "importing" | "finalizing";
    progressPercent: number;
    currentOperation: string;
    processedCount?: number;
    totalCount?: number;
    checkpoint?: Record<string, unknown>;
  }): Promise<void> {
    await this.database.query.transaction(async (transaction) => {
      const row = await transaction("service_migrations").where({ id: input.migrationId }).first();
      if (!row || terminalStatuses.has(String(row.status) as ServiceMigrationStatus)) return;
      const now = new Date().toISOString();
      const changingActiveStage = row.status !== input.status;
      const accumulatedDuration = Number(row.active_duration_ms ?? 0)
        + (changingActiveStage ? calculateActiveSegment(row.active_started_at, now) : 0);
      await transaction("service_migrations").where({ id: input.migrationId }).update({
        status: input.status,
        stage: input.status,
        progress_percent: Math.max(Number(row.progress_percent ?? 0), Math.min(99, input.progressPercent)),
        current_operation: input.currentOperation,
        processed_count: input.processedCount ?? row.processed_count,
        total_count: input.totalCount ?? row.total_count,
        checkpoint_json: input.checkpoint ? JSON.stringify(input.checkpoint) : row.checkpoint_json,
        active_duration_ms: accumulatedDuration,
        active_started_at: changingActiveStage ? now : row.active_started_at,
        updated_at: now,
      });
    });
  }

  /** 完成迁移并启用云端服务，结果可供 APP 稍后继续本地落标。 */
  public async complete(migrationId: string, result: Record<string, unknown>): Promise<void> {
    await this.database.query.transaction(async (transaction) => {
      const row = await transaction("service_migrations").where({ id: migrationId }).first();
      if (!row || terminalStatuses.has(String(row.status) as ServiceMigrationStatus)) return;
      const now = new Date().toISOString();
      const activeDuration = Number(row.active_duration_ms ?? 0)
        + calculateActiveSegment(row.active_started_at, now);
      await transaction("cloud_services").where({ id: row.service_id, user_id: row.user_id }).update({
        status: "active",
        updated_at: now,
      });
      await transaction("service_migrations").where({ id: migrationId }).update({
        status: "completed",
        stage: "completed",
        progress_percent: 100,
        current_operation: "本地媒体库已迁移到云助手",
        active_duration_ms: activeDuration,
        active_started_at: null,
        result_json: JSON.stringify(result),
        checkpoint_json: "{}",
        lease_owner: null,
        lease_expires_at: null,
        retryable: 0,
        error_code: null,
        error_message: null,
        updated_at: now,
        finished_at: now,
      });
    });
  }

  /** 标记迁移失败，保留上传分片和检查点供用户重试。 */
  public async fail(migrationId: string, code: string, message: string, retryable: boolean): Promise<void> {
    const row = await this.database.query("service_migrations").where({ id: migrationId }).first();
    if (!row || terminalStatuses.has(String(row.status) as ServiceMigrationStatus)) return;
    const now = new Date().toISOString();
    const activeDuration = Number(row.active_duration_ms ?? 0)
      + calculateActiveSegment(row.active_started_at, now);
    await this.database.query("service_migrations").where({ id: migrationId }).update({
      status: "failed",
      stage: "failed",
      current_operation: "服务关联处理失败",
      active_duration_ms: activeDuration,
      active_started_at: null,
      lease_owner: null,
      lease_expires_at: null,
      error_code: code,
      error_message: message,
      retryable: retryable ? 1 : 0,
      updated_at: now,
      finished_at: now,
    });
  }

  /** 把可重试失败任务重新放回后台队列。 */
  public async retry(migrationId: string, userId: string): Promise<ServiceMigrationRecord> {
    const row = await this.database.query("service_migrations").where({ id: migrationId, user_id: userId }).first();
    if (!row) throw new ApiError(404, "service_migration_not_found", "服务关联任务不存在");
    if (row.status !== "failed" || !Boolean(row.retryable)) {
      throw new ApiError(409, "service_migration_not_retryable", "当前服务关联任务不能重试");
    }
    await this.database.query("service_migrations").where({ id: migrationId }).update({
      status: "queued",
      stage: "queued",
      current_operation: "等待重新处理本地媒体库快照",
      error_code: null,
      error_message: null,
      retryable: 0,
      finished_at: null,
      updated_at: new Date().toISOString(),
    });
    return this.get(migrationId, userId);
  }

  /** 取消尚未完成的迁移，不删除原 APP 本地媒体库。 */
  public async cancel(migrationId: string, userId: string): Promise<ServiceMigrationRecord> {
    const row = await this.database.query("service_migrations").where({ id: migrationId, user_id: userId }).first();
    if (!row) throw new ApiError(404, "service_migration_not_found", "服务关联任务不存在");
    if (terminalStatuses.has(String(row.status) as ServiceMigrationStatus)) {
      return mapMigration(row as Record<string, unknown>);
    }
    const now = new Date().toISOString();
    const activeDuration = Number(row.active_duration_ms ?? 0)
      + calculateActiveSegment(row.active_started_at, now);
    await this.database.query("service_migrations").where({ id: migrationId }).update({
      status: "cancelled",
      stage: "cancelled",
      current_operation: "用户已取消服务关联",
      active_duration_ms: activeDuration,
      active_started_at: null,
      lease_owner: null,
      lease_expires_at: null,
      finished_at: now,
      updated_at: now,
    });
    return this.get(migrationId, userId);
  }
}
