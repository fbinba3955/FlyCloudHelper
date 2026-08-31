import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { ZipFile } from "yazl";
import type { ApiConfig } from "./config.js";
import type { FlyCloudHelperDatabase } from "./database.js";
import { parseJsonObject, type ExportRecord } from "./domain.js";
import { ApiError } from "./errors.js";

/** 云端规范快照分片 ZIP 协议版本。 */
const CHUNKED_SNAPSHOT_FORMAT_VERSION = 3;
/** 每次从数据库读取的记录数，避免大型媒体库一次占满 Node.js 内存。 */
const EXPORT_BATCH_SIZE = 1_000;
/** 与 APP 本地云备份保持一致的单个 JSON 分片记录上限。 */
const SNAPSHOT_CHUNK_ROW_LIMIT = 200;
/** ZIP 内的快照索引文件名。 */
const SNAPSHOT_INDEX_FILE_NAME = "index.json";
/** 超过该时间没有更新的运行任务视为服务异常退出遗留。 */
const STALE_EXPORT_INTERVAL_MS = 2 * 60 * 1_000;

type ExportLogger = (
  level: "info" | "warn",
  fields: Record<string, string | number | boolean | null>,
) => void;

/** 把数据库导出行转换为公开导出记录。 */
function mapExportRecord(row: Record<string, unknown>): ExportRecord {
  const status = String(row.status) as ExportRecord["status"];
  const completed = status === "completed";
  return {
    id: String(row.id),
    userId: String(row.user_id),
    libraryId: String(row.library_id),
    exportType: row.export_type as ExportRecord["exportType"],
    status,
    stage: String(row.stage ?? (completed ? "completed" : status)),
    progressPercent: completed ? 100 : Number(row.progress_percent ?? 0),
    processedCount: Number(row.processed_count ?? 0),
    totalCount: Number(row.total_count ?? 0),
    catalogVersion: Number(row.catalog_version ?? 0),
    formatVersion: Number(row.format_version ?? 1),
    filePath: row.file_path ? String(row.file_path) : null,
    fileSize: row.file_size === null || row.file_size === undefined ? null : Number(row.file_size),
    errorMessage: row.error_message
      ? buildSnapshotErrorMessage(new Error(String(row.error_message)))
      : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at ?? row.created_at),
    completedAt: row.completed_at ? String(row.completed_at) : completed ? String(row.created_at) : null,
  };
}

/** 从 count 查询结果中读取跨 SQLite、PostgreSQL 和 MySQL 的整数。 */
function readCount(row: Record<string, unknown> | undefined): number {
  return Math.max(0, Number(row?.count ?? 0));
}

/** 把数据库内部错误转换为客户端可以理解的快照失败原因。 */
function buildSnapshotErrorMessage(error: unknown): string {
  const originalMessage = error instanceof Error ? error.message : "云端快照生成失败";
  if (/could not resize shared memory segment|No space left on device/i.test(originalMessage)) {
    return "数据库共享内存不足，云端快照生成失败，请稍后重试或检查 PostgreSQL 共享内存配置";
  }
  return originalMessage;
}

/** 生成不包含账号密码、网盘凭据和临时播放地址的媒体库快照任务。 */
export class LibraryExportService {
  private readonly database: FlyCloudHelperDatabase;
  private readonly config: ApiConfig;
  private readonly logger: ExportLogger;
  /** 当前进程已经开始处理的任务，防止同一个导出被重复调度。 */
  private readonly runningExportIds = new Set<string>();

  public constructor(database: FlyCloudHelperDatabase, config: ApiConfig, logger?: ExportLogger) {
    this.database = database;
    this.config = config;
    this.logger = logger ?? ((level, fields): void => {
      if (level === "warn") {
        console.warn(JSON.stringify(fields));
        return;
      }
      console.info(JSON.stringify(fields));
    });
  }

  /** 把一批快照记录按 APP 的固定上限写为独立 JSON 分片。 */
  private async writeSnapshotChunks(
    snapshotDirectory: string,
    sectionName: string,
    records: Record<string, unknown>[],
    nextChunkIndex: number,
    chunkPaths: string[],
  ): Promise<number> {
    const sectionDirectory = path.join(snapshotDirectory, sectionName);
    await fs.mkdir(sectionDirectory, { recursive: true });
    let offset = 0;
    let chunkIndex = nextChunkIndex;
    while (offset < records.length) {
      const relativePath = `${sectionName}/${String(chunkIndex).padStart(6, "0")}.json`;
      const chunkRecords = records.slice(offset, offset + SNAPSHOT_CHUNK_ROW_LIMIT);
      await fs.writeFile(
        path.join(snapshotDirectory, relativePath),
        JSON.stringify({ records: chunkRecords }),
        { encoding: "utf8", mode: 0o600 },
      );
      chunkPaths.push(relativePath);
      chunkIndex += 1;
      offset += chunkRecords.length;
    }
    return chunkIndex;
  }

  /** 把索引和全部分片压缩为 APP 可直接解压的 ZIP 文件。 */
  private async compressSnapshotDirectory(
    snapshotDirectory: string,
    relativePaths: string[],
    outputPath: string,
  ): Promise<void> {
    const zipFile = new ZipFile();
    const output = createWriteStream(outputPath, { flags: "wx", mode: 0o600 });
    const completed = new Promise<void>((resolve, reject) => {
      output.once("close", resolve);
      output.once("error", reject);
      zipFile.outputStream.once("error", reject);
    });
    zipFile.outputStream.pipe(output);
    for (const relativePath of relativePaths) {
      zipFile.addFile(path.join(snapshotDirectory, relativePath), relativePath, { compress: true });
    }
    zipFile.end();
    await completed;
  }

  /** 更新可供 APP 查询的云端快照生成进度。 */
  private async updateProgress(
    exportId: string,
    stage: string,
    processedCount: number,
    totalCount: number,
  ): Promise<void> {
    const progressPercent = totalCount <= 0
      ? 1
      : Math.min(99, Math.max(1, Math.floor(processedCount * 99 / totalCount)));
    await this.database.query("library_exports").where({ id: exportId }).update({
      status: "running",
      stage,
      progress_percent: progressPercent,
      processed_count: processedCount,
      total_count: totalCount,
      updated_at: new Date().toISOString(),
    });
  }

  /** 查询同一用户媒体库尚未结束的快照任务。 */
  private async findActiveExport(userId: string, libraryId: string): Promise<ExportRecord | null> {
    const row = await this.database.query("library_exports")
      .where({ user_id: userId, library_id: libraryId, export_type: "snapshot" })
      .whereIn("status", ["queued", "running"])
      .orderBy("created_at", "desc")
      .first();
    return row ? mapExportRecord(row as Record<string, unknown>) : null;
  }

  /**
   * 统计快照包含的记录总数。
   * PostgreSQL 使用单事务串行统计，并关闭当前事务的并行查询，避免大型媒体库统计占满容器共享内存。
   */
  private async countSnapshotRecords(
    userId: string,
    libraryId: string,
  ): Promise<{ itemCount: number; relationCount: number; fileCount: number }> {
    return this.database.query.transaction(async (transaction) => {
      if (this.database.databaseType === "postgres") {
        await transaction.raw("SET LOCAL max_parallel_workers_per_gather = 0");
      }
      const itemCountRow = await transaction("media_items")
        .where({ user_id: userId, library_id: libraryId })
        .whereNull("deleted_at").count({ count: "*" }).first();
      const relationCountRow = await transaction("media_relations as r")
        .join("media_items as p", "p.id", "r.parent_item_id")
        .join("media_items as c", "c.id", "r.child_item_id")
        .where({ "r.user_id": userId, "r.library_id": libraryId })
        .whereNull("p.deleted_at").whereNull("c.deleted_at").count({ count: "*" }).first();
      const fileCountRow = await transaction("file_links as fl")
        .join("source_files as f", "f.id", "fl.source_file_id")
        .join("media_items as m", "m.id", "fl.item_id")
        .where({ "fl.user_id": userId, "fl.library_id": libraryId })
        .where("f.status", "active").whereNull("m.deleted_at").count({ count: "*" }).first();
      return {
        itemCount: readCount(itemCountRow as Record<string, unknown> | undefined),
        relationCount: readCount(relationCountRow as Record<string, unknown> | undefined),
        fileCount: readCount(fileCountRow as Record<string, unknown> | undefined),
      };
    });
  }

  /** 把长时间未更新的任务改为失败，使用户可以在服务重启后重新生成。 */
  private async failStaleExports(userId: string, libraryId: string): Promise<void> {
    const cutoff = new Date(Date.now() - STALE_EXPORT_INTERVAL_MS).toISOString();
    const now = new Date().toISOString();
    const staleRows = await this.database.query("library_exports")
      .select("id", "user_id", "library_id")
      .where({ user_id: userId, library_id: libraryId, export_type: "snapshot" })
      .whereIn("status", ["queued", "running"])
      .andWhere((builder) => {
        builder.where("updated_at", "<", cutoff).orWhereNull("updated_at");
      });
    if (staleRows.length === 0) return;
    const staleExportIds = staleRows.map((row) => String(row.id));
    await this.database.query("library_exports")
      .whereIn("id", staleExportIds)
      .whereIn("status", ["queued", "running"])
      .update({
        status: "failed",
        stage: "failed",
        error_message: "云端快照生成进程已中断，请重新生成",
        updated_at: now,
        completed_at: now,
      });
    for (const row of staleRows) {
      const exportDirectory = path.join(
        this.config.exportDirectory,
        String(row.user_id),
        String(row.library_id),
      );
      // 关键变量：同时清理新旧快照协议可能留下的确定文件名，不扫描或删除整个目录。
      try {
        await Promise.all([
          fs.rm(path.join(exportDirectory, `${row.id}.flycloud-snapshot-v2.jsonl.tmp`), { force: true }),
          fs.rm(path.join(exportDirectory, `${row.id}.flycloud-snapshot-v3.zip.tmp`), { force: true }),
          fs.rm(path.join(exportDirectory, `${row.id}.flycloud-snapshot-v3.tmp`), { recursive: true, force: true }),
          fs.rm(path.join(exportDirectory, `${row.id}.flymby-scanner-backup.json.tmp`), { force: true }),
        ]);
      } catch (error) {
        this.logger("warn", {
          日志关键字: "codex-flycloud-snapshot-task",
          事件: "中断快照临时文件清理失败",
          导出ID: String(row.id),
          媒体库ID: libraryId,
          错误信息: error instanceof Error ? error.message : "未知文件错误",
        });
      }
    }
    this.logger("warn", {
      日志关键字: "codex-flycloud-snapshot-task",
      事件: "清理长时间未更新的快照任务",
      媒体库ID: libraryId,
      中断任务数: staleRows.length,
      判定超时秒数: STALE_EXPORT_INTERVAL_MS / 1_000,
    });
  }

  /** 创建持久化快照任务并立即返回，实际生成在当前服务进程后台执行。 */
  public async createSnapshotTask(userId: string, libraryId: string): Promise<ExportRecord> {
    await this.failStaleExports(userId, libraryId);
    const exportId = randomUUID();
    const now = new Date().toISOString();
    const record = await this.database.query.transaction(async (transaction) => {
      let libraryQuery = transaction("media_libraries as l")
        .join("cloud_services as s", "s.id", "l.service_id")
        .select("l.id")
        .where("l.id", libraryId)
        .where("l.user_id", userId)
        .whereNull("s.deleted_at");
      if (this.database.databaseType !== "sqlite") {
        libraryQuery = libraryQuery.forUpdate();
      }
      const library = await libraryQuery.first();
      if (!library) {
        throw new ApiError(404, "library_not_found", "媒体库不存在");
      }
      const active = await transaction("library_exports")
        .where({ user_id: userId, library_id: libraryId, export_type: "snapshot" })
        .whereIn("status", ["queued", "running"])
        .first();
      if (active) {
        throw new ApiError(409, "snapshot_export_in_progress", "当前服务正在生成云端快照，请等待完成");
      }
      await transaction("library_exports").insert({
        id: exportId,
        user_id: userId,
        library_id: libraryId,
        export_type: "snapshot",
        status: "queued",
        stage: "queued",
        progress_percent: 0,
        processed_count: 0,
        total_count: 0,
        catalog_version: 0,
        format_version: CHUNKED_SNAPSHOT_FORMAT_VERSION,
        file_path: null,
        file_size: null,
        error_message: null,
        created_at: now,
        updated_at: now,
        completed_at: null,
      });
      return mapExportRecord({
        id: exportId,
        user_id: userId,
        library_id: libraryId,
        export_type: "snapshot",
        status: "queued",
        stage: "queued",
        progress_percent: 0,
        processed_count: 0,
        total_count: 0,
        catalog_version: 0,
        format_version: CHUNKED_SNAPSHOT_FORMAT_VERSION,
        file_path: null,
        file_size: null,
        error_message: null,
        created_at: now,
        updated_at: now,
        completed_at: null,
      });
    });
    setTimeout((): void => {
      void this.runSnapshotTask(record.id, userId, libraryId);
    }, 0);
    return record;
  }

  /**
   * 兼容服务迁移流程：创建云端快照后等待完成。
   * 若 APP 已经触发同媒体库生成，则复用该任务，不再创建第二份运行任务。
   */
  public async createSnapshot(userId: string, libraryId: string): Promise<ExportRecord> {
    let task: ExportRecord | null = null;
    try {
      task = await this.createSnapshotTask(userId, libraryId);
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== "snapshot_export_in_progress") {
        throw error;
      }
      task = await this.findActiveExport(userId, libraryId);
    }
    if (task === null) throw new Error("云端快照任务不存在");
    while (true) {
      const current = await this.getExport(task.id, userId);
      if (current.status === "completed") return current;
      if (current.status === "failed") throw new Error(current.errorMessage || "云端快照生成失败");
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
    }
  }

  /** 按稳定主键分页，把完整媒体目录写成分片并压缩为 ZIP。 */
  private async runSnapshotTask(exportId: string, userId: string, libraryId: string): Promise<void> {
    if (this.runningExportIds.has(exportId)) return;
    this.runningExportIds.add(exportId);
    const exportDirectory = path.join(this.config.exportDirectory, userId, libraryId);
    const finalPath = path.join(exportDirectory, `${exportId}.flycloud-snapshot-v3.zip`);
    const temporaryPath = `${finalPath}.tmp`;
    const snapshotDirectory = path.join(exportDirectory, `${exportId}.flycloud-snapshot-v3.tmp`);
    const startedAt = Date.now();
    // 关键变量：异常发生在媒体库查询前时使用通用名称，避免通知写入依赖已经失败的查询。
    let libraryDisplayName = "当前媒体库";
    let serviceId: string | null = null;
    // 关键变量：快照属于服务级后台任务，外部投递必须遵循该服务当前保存的通知开关。
    let notificationEnabled = false;
    // 关键变量：ZIP 压缩阶段可能长时间没有记录计数变化，独立心跳防止其他实例误判任务中断。
    const heartbeatTimer = setInterval((): void => {
      void this.database.query("library_exports")
        .where({ id: exportId, status: "running" })
        .update({ updated_at: new Date().toISOString() })
        .catch((error: unknown) => {
          this.logger("warn", {
            日志关键字: "codex-flycloud-snapshot-task",
            事件: "云端快照心跳更新失败",
            导出ID: exportId,
            媒体库ID: libraryId,
            错误信息: error instanceof Error ? error.message : "未知数据库错误",
          });
        });
    }, 30_000);
    heartbeatTimer.unref();
    try {
      const library = await this.database.query("media_libraries as l")
        .join("cloud_services as s", "s.id", "l.service_id")
        .select("l.*", "s.display_name", "s.provider_type", "s.data_type", "s.notification_enabled")
        .where("l.id", libraryId).where("l.user_id", userId).whereNull("s.deleted_at").first();
      if (!library) throw new ApiError(404, "library_not_found", "媒体库不存在");
      libraryDisplayName = String(library.display_name || "当前媒体库");
      serviceId = String(library.service_id || "") || null;
      notificationEnabled = Number(library.notification_enabled) === 1 || library.notification_enabled === true;
      const catalogVersion = Number(library.catalog_version ?? 0);
      await this.database.query("library_exports").where({ id: exportId }).update({
        status: "running",
        stage: "preparing",
        progress_percent: 1,
        catalog_version: catalogVersion,
        updated_at: new Date().toISOString(),
      });
      this.logger("info", {
        日志关键字: "codex-flycloud-snapshot-task",
        事件: "云端快照开始生成",
        导出ID: exportId,
        媒体库ID: libraryId,
        目录版本: catalogVersion,
      });
      // 关键变量：统计阶段是 PostgreSQL 共享内存压力最高的步骤，必须使用低资源统计模式。
      const { itemCount, relationCount, fileCount } = await this.countSnapshotRecords(userId, libraryId);
      const totalCount = itemCount + relationCount + fileCount;
      await fs.mkdir(exportDirectory, { recursive: true });
      await fs.rm(temporaryPath, { force: true });
      await fs.rm(snapshotDirectory, { recursive: true, force: true });
      await fs.mkdir(snapshotDirectory, { recursive: true });
      await this.database.query("library_exports").where({ id: exportId }).update({
        status: "running", stage: "preparing", progress_percent: 1,
        processed_count: 0, total_count: totalCount, catalog_version: catalogVersion,
        updated_at: new Date().toISOString(),
      });
      let processedCount = 0;
      const relationChunkPaths: string[] = [];
      const mediaItemChunkPaths: string[] = [];
      const fileChunkPaths: string[] = [];
      let relationChunkIndex = 0;
      let mediaItemChunkIndex = 0;
      let fileChunkIndex = 0;
      let lastRelationId = "";
      while (true) {
        const rows = await this.database.query("media_relations as r")
          .join("media_items as p", "p.id", "r.parent_item_id")
          .join("media_items as c", "c.id", "r.child_item_id")
          .select("r.id as relation_id", "r.parent_item_id", "r.child_item_id", "r.relation_type", "r.sort_order")
          .where({ "r.user_id": userId, "r.library_id": libraryId })
          .whereNull("p.deleted_at").whereNull("c.deleted_at").andWhere("r.id", ">", lastRelationId)
          .orderBy("r.id", "asc").limit(EXPORT_BATCH_SIZE);
        if (rows.length === 0) break;
        const records = rows.map((relation) => ({
              parentItemId: relation.parent_item_id,
              childItemId: relation.child_item_id,
              relationType: relation.relation_type,
              sortOrder: Number(relation.sort_order),
        }));
        relationChunkIndex = await this.writeSnapshotChunks(
          snapshotDirectory, "relations", records, relationChunkIndex, relationChunkPaths,
        );
        lastRelationId = String(rows[rows.length - 1]?.relation_id ?? lastRelationId);
        processedCount += rows.length;
        await this.updateProgress(exportId, "relations", processedCount, totalCount);
      }

      let lastItemId = "";
      while (true) {
        const rows = await this.database.query("media_items")
          .select(
            "id", "identity_key", "media_type", "item_type", "title", "sort_title",
            "subtitle", "year", "premiere_date", "overview", "poster_url", "backdrop_url", "match_state",
            "external_ids_json", "metadata_json", "created_at", "updated_at",
          )
          .where({ user_id: userId, library_id: libraryId })
          .whereNull("deleted_at").andWhere("id", ">", lastItemId)
          .orderBy("id", "asc").limit(EXPORT_BATCH_SIZE);
        if (rows.length === 0) break;
        const records = rows.map((item) => ({
              id: item.id,
              identityKey: item.identity_key,
              mediaType: item.media_type,
              itemType: item.item_type,
              title: item.title,
              sortTitle: item.sort_title,
              subtitle: item.subtitle,
              year: item.year,
              premiereDate: item.premiere_date,
              overview: item.overview,
              posterUrl: item.poster_url,
              backdropUrl: item.backdrop_url,
              matchState: item.match_state,
              externalIds: parseJsonObject(item.external_ids_json),
              metadata: parseJsonObject(item.metadata_json),
              createdAt: item.created_at,
              updatedAt: item.updated_at,
        }));
        mediaItemChunkIndex = await this.writeSnapshotChunks(
          snapshotDirectory, "mediaItems", records, mediaItemChunkIndex, mediaItemChunkPaths,
        );
        lastItemId = String(rows[rows.length - 1]?.id ?? lastItemId);
        processedCount += rows.length;
        await this.updateProgress(exportId, "media_items", processedCount, totalCount);
      }

      let lastLinkId = "";
      while (true) {
        const rows = await this.database.query("file_links as fl")
          .join("source_files as f", "f.id", "fl.source_file_id")
          .join("media_items as m", "m.id", "fl.item_id")
          .select(
            "fl.id as link_id", "fl.item_id", "f.id as file_id", "f.provider_resource_id", "f.parent_resource_id",
            "f.path", "f.name", "f.extension", "f.size", "f.modified_at", "f.etag",
            "f.locator_json as source_locator_json",
          )
          .where({ "fl.user_id": userId, "fl.library_id": libraryId })
          .where("f.status", "active").whereNull("m.deleted_at").andWhere("fl.id", ">", lastLinkId)
          .orderBy("fl.id", "asc").limit(EXPORT_BATCH_SIZE);
        if (rows.length === 0) break;
        const records = rows.map((file) => ({
              itemId: file.item_id,
              fileId: file.file_id,
              resourceId: file.provider_resource_id,
              parentResourceId: file.parent_resource_id,
              displayPath: file.path,
              fileName: file.name,
              extension: file.extension,
              size: Number(file.size),
              modifiedAt: file.modified_at,
              etag: file.etag,
              sourceLocator: parseJsonObject(file.source_locator_json),
        }));
        fileChunkIndex = await this.writeSnapshotChunks(
          snapshotDirectory, "files", records, fileChunkIndex, fileChunkPaths,
        );
        lastLinkId = String(rows[rows.length - 1]?.link_id ?? lastLinkId);
        processedCount += rows.length;
        await this.updateProgress(exportId, "files", processedCount, totalCount);
      }
      // 关键变量：导出期间目录版本变化会产生不一致快照，必须丢弃并由用户重新生成。
      const latestLibrary = await this.database.query("media_libraries")
        .select("catalog_version").where({ id: libraryId, user_id: userId }).first();
      if (Number(latestLibrary?.catalog_version ?? -1) !== catalogVersion) {
        throw new ApiError(409, "snapshot_catalog_changed", "生成期间媒体库发生变化，请重新生成快照");
      }
      const index = {
        format: "flycloud-helper-library-snapshot-chunks",
        formatVersion: CHUNKED_SNAPSHOT_FORMAT_VERSION,
        createdAt: new Date().toISOString(),
        source: {
          libraryId,
          catalogVersion,
          providerType: String(library.provider_type),
          dataType: String(library.data_type),
          displayName: String(library.display_name),
        },
        counts: { mediaItems: itemCount, relations: relationCount, files: fileCount, total: totalCount },
        chunks: {
          relations: relationChunkPaths,
          mediaItems: mediaItemChunkPaths,
          files: fileChunkPaths,
        },
      };
      await fs.writeFile(
        path.join(snapshotDirectory, SNAPSHOT_INDEX_FILE_NAME),
        JSON.stringify(index),
        { encoding: "utf8", mode: 0o600 },
      );
      await this.updateProgress(exportId, "compressing", processedCount, totalCount);
      await this.compressSnapshotDirectory(
        snapshotDirectory,
        [SNAPSHOT_INDEX_FILE_NAME, ...relationChunkPaths, ...mediaItemChunkPaths, ...fileChunkPaths],
        temporaryPath,
      );
      await fs.rename(temporaryPath, finalPath);
      await fs.rm(snapshotDirectory, { recursive: true, force: true });
      const stat = await fs.stat(finalPath);
      const completedAt = new Date().toISOString();
      await this.database.query("library_exports").where({ id: exportId }).update({
        status: "completed", stage: "completed", progress_percent: 100,
        processed_count: processedCount, total_count: totalCount,
        catalog_version: catalogVersion, format_version: CHUNKED_SNAPSHOT_FORMAT_VERSION,
        file_path: finalPath, file_size: stat.size, error_message: null,
        updated_at: completedAt, completed_at: completedAt,
      });
      await this.database.createNotificationSafely({
        userId,
        category: "task",
        tone: "success",
        title: "云端快照已生成",
        message: `服务“${libraryDisplayName}”的目录版本 v${catalogVersion} 快照已经生成完成。`,
        actionPath: serviceId ? `/app/services/${serviceId}/snapshots` : "/app/services",
        deliverExternally: notificationEnabled,
      });
      this.logger("info", {
        日志关键字: "codex-flycloud-snapshot-task",
        事件: "云端快照生成完成",
        导出ID: exportId,
        媒体库ID: libraryId,
        目录版本: catalogVersion,
        记录总数: totalCount,
        分片总数: relationChunkPaths.length + mediaItemChunkPaths.length + fileChunkPaths.length,
        文件字节数: stat.size,
        耗时毫秒: Date.now() - startedAt,
      });
    } catch (error) {
      await fs.rm(temporaryPath, { force: true });
      await fs.rm(snapshotDirectory, { recursive: true, force: true });
      const completedAt = new Date().toISOString();
      const originalMessage = error instanceof Error ? error.message : "云端快照生成失败";
      const message = buildSnapshotErrorMessage(error);
      await this.database.query("library_exports").where({ id: exportId }).update({
        status: "failed", stage: "failed", error_message: message,
        updated_at: completedAt, completed_at: completedAt,
      });
      await this.database.createNotificationSafely({
        userId,
        category: "task",
        tone: "danger",
        title: "云端快照生成失败",
        message: `服务“${libraryDisplayName}”的云端快照生成失败：${message}`,
        actionPath: serviceId ? `/app/services/${serviceId}/snapshots` : "/app/services",
        deliverExternally: notificationEnabled,
      });
      this.logger("warn", {
        日志关键字: "codex-flycloud-snapshot-task",
        事件: "云端快照生成失败",
        导出ID: exportId,
        媒体库ID: libraryId,
        错误信息: message,
        数据库错误信息: originalMessage,
      });
    } finally {
      clearInterval(heartbeatTimer);
      this.runningExportIds.delete(exportId);
    }
  }

  /** 列出当前用户某个媒体库的云端快照，最新记录排在前面。 */
  public async listExports(userId: string, libraryId: string, limit = 20): Promise<ExportRecord[]> {
    await this.failStaleExports(userId, libraryId);
    const rows = await this.database.query("library_exports")
      .where({ user_id: userId, library_id: libraryId, export_type: "snapshot" })
      .orderBy("created_at", "desc").limit(Math.min(100, Math.max(1, limit)));
    return rows.map((row) => mapExportRecord(row as Record<string, unknown>));
  }

  /** 查询当前用户的单个快照记录。 */
  public async getExport(exportId: string, userId: string): Promise<ExportRecord> {
    const row = await this.database.query("library_exports")
      .where({ id: exportId, user_id: userId }).first();
    if (!row) throw new ApiError(404, "export_not_found", "云端快照不存在");
    return mapExportRecord(row as Record<string, unknown>);
  }

  /**
   * 删除已经结束的云端快照记录和对应文件。
   * userId 为空仅供已经完成超级管理员鉴权的路由使用。
   */
  public async deleteExport(exportId: string, userId?: string): Promise<ExportRecord> {
    return this.database.query.transaction(async (transaction) => {
      let exportQuery = transaction("library_exports").where({ id: exportId });
      if (userId) exportQuery = exportQuery.where({ user_id: userId });
      if (this.database.databaseType !== "sqlite") exportQuery = exportQuery.forUpdate();
      const row = await exportQuery.first();
      if (!row) throw new ApiError(404, "export_not_found", "云端快照不存在");
      const record = mapExportRecord(row as Record<string, unknown>);
      if (record.status === "queued" || record.status === "running") {
        throw new ApiError(409, "snapshot_export_in_progress", "正在生成的云端快照不能删除");
      }

      this.logger("info", {
        日志关键字: "codex-flycloud-snapshot-delete",
        事件: "开始删除云端快照",
        导出ID: exportId,
        媒体库ID: record.libraryId,
        快照状态: record.status,
      });
      let localFileDeleted = false;
      if (record.filePath) {
        const exportRoot = path.resolve(this.config.exportDirectory);
        const resolvedFilePath = path.resolve(record.filePath);
        // 关键变量：只允许删除导出目录内的单个文件，防止异常数据库路径扩大删除范围。
        const relativeFilePath = path.relative(exportRoot, resolvedFilePath);
        const outsideExportRoot = relativeFilePath === ""
          || relativeFilePath === ".."
          || relativeFilePath.startsWith(`..${path.sep}`)
          || path.isAbsolute(relativeFilePath);
        if (outsideExportRoot) {
          this.logger("warn", {
            日志关键字: "codex-flycloud-snapshot-delete",
            事件: "快照文件属于其他部署实例，仅删除数据库记录",
            导出ID: exportId,
            媒体库ID: record.libraryId,
            当前导出目录: exportRoot,
          });
        } else {
          await fs.rm(resolvedFilePath, { force: true });
          localFileDeleted = true;
        }
      }
      await transaction("library_exports").where({ id: exportId }).delete();
      this.logger("info", {
        日志关键字: "codex-flycloud-snapshot-delete",
        事件: "云端快照删除完成",
        导出ID: exportId,
        媒体库ID: record.libraryId,
        是否删除本机快照文件: localFileDeleted,
      });
      return record;
    });
  }

  /** 返回经过用户归属校验的快照绝对路径。 */
  public async getDownloadPath(exportId: string, userId: string): Promise<string> {
    const record = await this.getExport(exportId, userId);
    if (record.status !== "completed" || !record.filePath) {
      throw new ApiError(409, "export_not_ready", "云端快照尚未生成完成");
    }
    return record.filePath;
  }
}
