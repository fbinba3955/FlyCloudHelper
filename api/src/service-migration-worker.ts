import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import type { Knex } from "knex";
import yauzl, { type Entry, type ZipFile } from "yauzl";
import type { ApiConfig } from "./config.js";
import type { FlyCloudHelperDatabase } from "./database.js";
import type { ServiceMigrationRecord } from "./domain.js";
import { ApiError, toSafeErrorMessage } from "./errors.js";
import type { LibraryExportService } from "./export-service.js";
import { createStableId } from "./media/filename.js";
import type { ServiceMigrationRepository } from "./service-migration-repository.js";

interface MigrationWorkerLogger {
  info(fields: Record<string, unknown>): void;
  warn(fields: Record<string, unknown>): void;
  error(fields: Record<string, unknown>): void;
}

interface SnapshotRows {
  sourceFiles: Array<Record<string, unknown>>;
  videoItems: Array<Record<string, unknown>>;
  episodes: Array<Record<string, unknown>>;
  fileLinks: Array<Record<string, unknown>>;
}

interface SnapshotIndex extends Record<string, unknown> {
  payloadType: string;
  version: number;
  format: string;
  counts: Record<string, unknown>;
  chunks: Record<string, unknown>;
}

interface ImportStatistics {
  sourceFiles: number;
  movies: number;
  series: number;
  episodes: number;
  fileLinks: number;
}

const allowedSnapshotFolders = new Set(["sourceFiles", "videoItems", "episodes", "fileLinks", "tmdbCache"]);

/** 打开迁移 ZIP，使用惰性 Entry 避免同时创建大量流。 */
function openZip(archivePath: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true, autoClose: true, validateEntrySizes: true }, (error, zipFile) => {
      if (error || !zipFile) {
        reject(new ApiError(415, "migration_snapshot_invalid", "迁移快照不是有效的 ZIP 文件"));
        return;
      }
      resolve(zipFile);
    });
  });
}

/** 打开 ZIP 中的单个文件流。 */
function openEntryStream(zipFile: ZipFile, entry: Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(error ?? new Error("迁移快照文件无法读取"));
        return;
      }
      resolve(stream);
    });
  });
}

/** 校验 ZIP 路径只包含既定索引和 JSON 分片，不允许目录穿越或额外文件。 */
function validateSnapshotEntryPath(fileName: string): string {
  if (!fileName || fileName.includes("\\") || path.posix.isAbsolute(fileName)) {
    throw new ApiError(415, "migration_snapshot_path_invalid", "迁移快照包含非法文件路径");
  }
  const normalized = path.posix.normalize(fileName);
  if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new ApiError(415, "migration_snapshot_path_invalid", "迁移快照包含目录穿越路径");
  }
  if (normalized === "index.json" || normalized.endsWith("/")) return normalized;
  const segments = normalized.split("/");
  if (segments.length !== 2 || !allowedSnapshotFolders.has(segments[0] ?? "")
    || !/^\d+\.json$/u.test(segments[1] ?? "")) {
    throw new ApiError(415, "migration_snapshot_file_invalid", "迁移快照包含未声明的文件");
  }
  return normalized;
}

/** 在固定上限内读取 ZIP Entry，阻止单个 JSON 分片异常膨胀。 */
async function readEntryBuffer(zipFile: ZipFile, entry: Entry, maximumBytes: number): Promise<Buffer> {
  if (entry.uncompressedSize > maximumBytes) {
    throw new ApiError(413, "migration_snapshot_entry_too_large", "迁移快照中的单个 JSON 分片过大");
  }
  const stream = await openEntryStream(zipFile, entry);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > maximumBytes) {
      throw new ApiError(413, "migration_snapshot_entry_too_large", "迁移快照中的单个 JSON 分片过大");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, size);
}

/** 安全解析一个 JSON 对象。 */
function parseObjectJson(buffer: Buffer, errorCode: string, errorMessage: string): Record<string, unknown> {
  try {
    const value = JSON.parse(buffer.toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not_object");
    return value as Record<string, unknown>;
  } catch {
    throw new ApiError(415, errorCode, errorMessage);
  }
}

/** 读取旧版 Flymby 分片 ZIP，并拒绝任何随快照上传的网盘密码。 */
async function readFlymbySnapshot(archivePath: string, maximumBytes: number): Promise<SnapshotRows> {
  const zipFile = await openZip(archivePath);
  const entryPayloads = new Map<string, Buffer>();
  let entryCount = 0;
  let uncompressedBytes = 0;
  await new Promise<void>((resolve, reject) => {
    let processing = false;
    const fail = (error: unknown) => {
      zipFile.close();
      reject(error);
    };
    zipFile.on("error", fail);
    zipFile.on("end", () => {
      if (!processing) resolve();
    });
    zipFile.on("entry", (entry: Entry) => {
      processing = true;
      void (async () => {
        const entryPath = validateSnapshotEntryPath(entry.fileName);
        if (!entryPath.endsWith("/")) {
          entryCount += 1;
          uncompressedBytes += entry.uncompressedSize;
          if (entryCount > 20_000 || uncompressedBytes > maximumBytes * 4) {
            throw new ApiError(413, "migration_snapshot_uncompressed_too_large", "迁移快照解压后大小超出限制");
          }
          if (entryPayloads.has(entryPath)) {
            throw new ApiError(415, "migration_snapshot_duplicate_path", "迁移快照包含重复文件路径");
          }
          entryPayloads.set(entryPath, await readEntryBuffer(zipFile, entry, 32 * 1024 * 1024));
        }
        processing = false;
        zipFile.readEntry();
      })().catch(fail);
    });
    zipFile.readEntry();
  });

  const indexBuffer = entryPayloads.get("index.json");
  if (!indexBuffer) throw new ApiError(415, "migration_snapshot_index_missing", "迁移快照缺少 index.json");
  const rawIndex = parseObjectJson(
    indexBuffer,
    "migration_snapshot_index_invalid",
    "迁移快照索引格式无效",
  );
  if (rawIndex.payloadType !== "webdav_video_library_snapshot" || rawIndex.version !== 1
    || rawIndex.format !== "zip_chunks_v1") {
    throw new ApiError(415, "migration_snapshot_protocol_invalid", "迁移快照协议不受支持");
  }
  if (typeof rawIndex.encryptedPassword === "string" && rawIndex.encryptedPassword.length > 0) {
    throw new ApiError(422, "migration_snapshot_contains_credentials", "迁移快照不能包含网盘密码");
  }
  const index = rawIndex as SnapshotIndex;
  const rows: SnapshotRows = { sourceFiles: [], videoItems: [], episodes: [], fileLinks: [] };
  const appendRows = (folder: keyof SnapshotRows): void => {
    const paths = index.chunks[folder];
    if (!Array.isArray(paths)) {
      throw new ApiError(415, "migration_snapshot_index_invalid", `迁移快照缺少 ${folder} 分片索引`);
    }
    for (const rawPath of paths) {
      if (typeof rawPath !== "string" || !rawPath.startsWith(`${folder}/`)) {
        throw new ApiError(415, "migration_snapshot_index_invalid", `${folder} 分片路径无效`);
      }
      const buffer = entryPayloads.get(rawPath);
      if (!buffer) throw new ApiError(415, "migration_snapshot_chunk_missing", `迁移快照缺少 ${rawPath}`);
      const chunk = parseObjectJson(buffer, "migration_snapshot_chunk_invalid", `${rawPath} 格式无效`);
      if (!Array.isArray(chunk.rows)) {
        throw new ApiError(415, "migration_snapshot_chunk_invalid", `${rawPath} 缺少 rows 数组`);
      }
      for (const value of chunk.rows) {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          throw new ApiError(415, "migration_snapshot_row_invalid", `${rawPath} 包含无效数据行`);
        }
        rows[folder].push(value as Record<string, unknown>);
      }
    }
    const expectedCount = Number(index.counts[folder] ?? 0);
    if (expectedCount !== rows[folder].length) {
      throw new ApiError(415, "migration_snapshot_count_mismatch", `${folder} 数量与索引不一致`);
    }
  };
  appendRows("sourceFiles");
  appendRows("videoItems");
  appendRows("episodes");
  appendRows("fileLinks");
  return rows;
}

/** 把未知值读取为去除首尾空格的字符串。 */
function readText(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  return value === undefined || value === null ? "" : String(value).trim();
}

/** 把未知值读取为有限数字。 */
function readNumber(row: Record<string, unknown>, field: string): number {
  const value = Number(row[field] ?? 0);
  return Number.isFinite(value) ? value : 0;
}

/** 把毫秒时间戳转换成数据库 ISO 时间，缺失时使用回退值。 */
function readIsoTime(row: Record<string, unknown>, field: string, fallback: string): string {
  const value = readNumber(row, field);
  return value > 0 ? new Date(value).toISOString() : fallback;
}

/** 解析本地行中保存的 JSON 字符串，损坏值回退为空对象。 */
function readEmbeddedObject(row: Record<string, unknown>, field: string): Record<string, unknown> {
  const value = row[field];
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string" || !value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

/** 解析本地行中保存的任意 JSON 值，数组型演职人员和类型字段也要原样保留。 */
function readEmbeddedValue(row: Record<string, unknown>, field: string): unknown {
  const value = row[field];
  if (value && typeof value === "object") return value;
  if (typeof value !== "string" || !value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

/** 把大量行分批写入，避免 SQLite 单条语句变量数超限。 */
async function batchInsert(
  transaction: Knex.Transaction,
  tableName: string,
  rows: Array<Record<string, unknown>>,
): Promise<void> {
  if (rows.length === 0) return;
  await transaction.batchInsert(tableName, rows, 25);
}

/** 把源文件资源 ID 冲突转换为可读且不可盲目重试的迁移错误。 */
function normalizeMigrationImportError(error: unknown): unknown {
  const errorMessage = error instanceof Error ? error.message : String(error ?? "");
  if (/uq_source_files_resource|source_files\.user_id.*source_files\.library_id.*source_files\.provider_resource_id/iu
    .test(errorMessage)) {
    return new ApiError(
      422,
      "migration_snapshot_duplicate_provider_resource",
      "本地媒体库快照包含重复网盘文件，云助手无法确定唯一文件归属，请使用新版 APP 重新关联",
    );
  }
  return error;
}

/** 把本地 Flymby 视频库快照事务性映射到云助手目录表。 */
async function importSnapshotRows(
  database: FlyCloudHelperDatabase,
  migration: ServiceMigrationRecord,
  snapshot: SnapshotRows,
  logger: MigrationWorkerLogger,
): Promise<ImportStatistics> {
  const now = new Date().toISOString();
  const generationId = migration.id;
  return database.query.transaction(async (transaction) => {
    await transaction("catalog_changes").where({ library_id: migration.libraryId }).delete();
    await transaction("file_links").where({ library_id: migration.libraryId }).delete();
    await transaction("media_relations").where({ library_id: migration.libraryId }).delete();
    await transaction("media_items").where({ library_id: migration.libraryId }).delete();
    await transaction("source_files").where({ library_id: migration.libraryId }).delete();

    const sourceIdByPath = new Map<string, string>();
    const canonicalPathBySourcePath = new Map<string, string>(); // 关键变量：旧路径文件关联要改到最新路径。
    const canonicalSourceByResourceId = new Map<string, Record<string, unknown>>(); // 关键变量：同一网盘文件优先保留更新的路径记录。
    const sourceRows: Array<Record<string, unknown>> = [];
    let duplicateSourceFileCount = 0;
    for (const local of snapshot.sourceFiles) {
      const displayPath = readText(local, "path");
      const providerResourceId = readText(local, "resourceId") || displayPath;
      if (!displayPath || !providerResourceId) continue;
      const currentCanonicalSource = canonicalSourceByResourceId.get(providerResourceId);
      const currentUpdatedAt = currentCanonicalSource ? readNumber(currentCanonicalSource, "updatedAt") : -1;
      const currentIndexedAt = currentCanonicalSource ? readNumber(currentCanonicalSource, "indexedAt") : -1;
      const nextUpdatedAt = readNumber(local, "updatedAt");
      const nextIndexedAt = readNumber(local, "indexedAt");
      if (!currentCanonicalSource || nextUpdatedAt > currentUpdatedAt
        || (nextUpdatedAt === currentUpdatedAt && nextIndexedAt > currentIndexedAt)) {
        canonicalSourceByResourceId.set(providerResourceId, local);
      }
    }
    for (const local of snapshot.sourceFiles) {
      const displayPath = readText(local, "path");
      if (!displayPath || sourceIdByPath.has(displayPath)) continue;
      const explicitResourceId = readText(local, "resourceId");
      if (migration.providerType === "guangya" && !explicitResourceId) {
        throw new ApiError(
          422,
          "guangya_snapshot_locator_missing",
          "光鸭本地快照缺少 fileId，需由新版 APP 重新生成迁移快照",
        );
      }
      const providerResourceId = explicitResourceId || displayPath;
      const canonicalSource = canonicalSourceByResourceId.get(providerResourceId);
      const canonicalDisplayPath = canonicalSource ? readText(canonicalSource, "path") : displayPath;
      canonicalPathBySourcePath.set(displayPath, canonicalDisplayPath || displayPath);
      const sourceId = createStableId("src", migration.userId, migration.libraryId, providerResourceId);
      if (canonicalSource !== local) {
        // 重复路径仍映射到已保留的源文件，后续文件关联不会因为去重而丢失。
        sourceIdByPath.set(displayPath, sourceId);
        duplicateSourceFileCount += 1;
        continue;
      }
      const locator = {
        ...readEmbeddedObject(local, "providerPayloadJson"),
        resourceId: providerResourceId,
        ...(migration.providerType === "guangya" ? { fileId: providerResourceId } : {}),
        displayPath,
        ...(readText(local, "driveId") ? { driveId: readText(local, "driveId") } : {}),
      };
      sourceIdByPath.set(displayPath, sourceId);
      sourceRows.push({
        id: sourceId,
        user_id: migration.userId,
        service_id: migration.serviceId,
        library_id: migration.libraryId,
        provider_resource_id: providerResourceId,
        parent_resource_id: readText(local, "parentResourceId") || readText(local, "parentPath") || null,
        path: displayPath,
        name: readText(local, "name") || path.posix.basename(displayPath),
        extension: readText(local, "extension").slice(0, 32),
        size: Math.max(0, readNumber(local, "size")),
        modified_at: readNumber(local, "modifiedMs") > 0
          ? new Date(readNumber(local, "modifiedMs")).toISOString()
          : null,
        etag: readText(local, "etag") || null,
        scan_root_key: null,
        generation_id: generationId,
        locator_json: JSON.stringify(locator),
        status: readText(local, "isStale") === "true" ? "missing" : "active",
        created_at: readIsoTime(local, "indexedAt", now),
        updated_at: readIsoTime(local, "updatedAt", now),
      });
    }
    if (duplicateSourceFileCount > 0) {
      logger.info({
        日志关键字: "codex-flycloud-migration-source-dedup",
        事件: "云端导入去除重复网盘文件",
        用户ID: migration.userId,
        迁移ID: migration.id,
        服务ID: migration.serviceId,
        重复文件数量: duplicateSourceFileCount,
        保留文件数量: sourceRows.length,
      });
    }

    const itemIdByLocalId = new Map<string, string>();
    const mediaRows: Array<Record<string, unknown>> = [];
    let movieCount = 0;
    let seriesCount = 0;
    for (const local of snapshot.videoItems) {
      const localItemId = readText(local, "itemId");
      const title = readText(local, "title");
      if (!localItemId || !title || itemIdByLocalId.has(localItemId)) continue;
      const itemId = createStableId("itm", migration.userId, migration.libraryId, localItemId);
      const localItemType = readText(local, "itemType");
      const itemType = localItemType === "tv" ? "video.series" : "video.movie";
      if (itemType === "video.series") seriesCount += 1;
      else movieCount += 1;
      const tmdbId = Math.max(0, Math.floor(readNumber(local, "tmdbId")));
      const matchStatus = readText(local, "matchStatus");
      const matchState = matchStatus === "failed" || matchStatus === "skipped"
        ? "unmatched"
        : tmdbId > 0 || matchStatus === "nfo" ? "matched" : "needs_review";
      itemIdByLocalId.set(localItemId, itemId);
      mediaRows.push({
        id: itemId,
        user_id: migration.userId,
        service_id: migration.serviceId,
        library_id: migration.libraryId,
        identity_key: createStableId("identity", "migration", migration.libraryId, localItemId),
        media_type: "video",
        item_type: itemType,
        title,
        sort_title: title,
        subtitle: itemType === "video.series" ? "节目" : (readNumber(local, "year") > 0
          ? String(Math.floor(readNumber(local, "year"))) : "电影"),
        year: readNumber(local, "year") > 0 ? Math.floor(readNumber(local, "year")) : null,
        premiere_date: readText(local, "premiereDate") || null,
        overview: readText(local, "overview"),
        poster_url: readText(local, "posterUrl") || null,
        backdrop_url: readText(local, "backdropUrl") || null,
        match_state: matchState,
        external_ids_json: JSON.stringify(tmdbId > 0 ? { tmdb: String(tmdbId) } : {}),
        metadata_json: JSON.stringify({
          originalTitle: readText(local, "originalTitle"),
          tmdbType: readText(local, "tmdbType"),
          rating: readNumber(local, "rating"),
          episodeCount: readNumber(local, "episodeCount"),
          logoUrl: readText(local, "logoUrl"),
          genres: readEmbeddedValue(local, "genresJson"),
          people: readEmbeddedValue(local, "peopleJson"),
          importedFromFlymby: true,
        }),
        generation_id: generationId,
        created_at: readIsoTime(local, "createdAt", now),
        updated_at: readIsoTime(local, "updatedAt", now),
        deleted_at: null,
      });
    }

    const episodeIdByLocalId = new Map<string, string>();
    const relationRows: Array<Record<string, unknown>> = [];
    for (const local of snapshot.episodes) {
      const localEpisodeId = readText(local, "episodeId");
      const parentId = itemIdByLocalId.get(readText(local, "itemId"));
      if (!localEpisodeId || !parentId || episodeIdByLocalId.has(localEpisodeId)) continue;
      const episodeId = createStableId("itm", migration.userId, migration.libraryId, "episode", localEpisodeId);
      const seasonNumber = Math.max(0, Math.floor(readNumber(local, "seasonNumber")));
      const episodeNumber = Math.max(0, Math.floor(readNumber(local, "episodeNumber")));
      const tmdbId = Math.max(0, Math.floor(readNumber(local, "tmdbId")));
      episodeIdByLocalId.set(localEpisodeId, episodeId);
      mediaRows.push({
        id: episodeId,
        user_id: migration.userId,
        service_id: migration.serviceId,
        library_id: migration.libraryId,
        identity_key: createStableId("identity", "migration", migration.libraryId, "episode", localEpisodeId),
        media_type: "video",
        item_type: "video.episode",
        title: readText(local, "title") || `第 ${episodeNumber} 集`,
        sort_title: `${String(seasonNumber).padStart(4, "0")}-${String(episodeNumber).padStart(6, "0")}`,
        subtitle: `第 ${seasonNumber} 季 · 第 ${episodeNumber} 集`,
        year: null,
        premiere_date: readText(local, "airDate") || null,
        overview: readText(local, "overview"),
        poster_url: readText(local, "stillUrl") || null,
        backdrop_url: null,
        match_state: tmdbId > 0 ? "matched" : "needs_review",
        external_ids_json: JSON.stringify(tmdbId > 0 ? { tmdb: String(tmdbId) } : {}),
        metadata_json: JSON.stringify({
          originalTitle: readText(local, "originalTitle"),
          seasonNumber,
          episodeNumber,
          durationMs: Math.max(0, readNumber(local, "durationMs")),
          importedFromFlymby: true,
        }),
        generation_id: generationId,
        created_at: readIsoTime(local, "createdAt", now),
        updated_at: readIsoTime(local, "updatedAt", now),
        deleted_at: null,
      });
      relationRows.push({
        id: randomUUID(),
        user_id: migration.userId,
        library_id: migration.libraryId,
        parent_item_id: parentId,
        child_item_id: episodeId,
        relation_type: "series_episode",
        sort_order: seasonNumber * 100_000 + episodeNumber,
      });
    }

    const fileLinkRowBySourceId = new Map<string, Record<string, unknown>>();
    const fileLinkUsesCanonicalPath = new Set<string>(); // 关键变量：同一文件优先保留新路径上的影片关联。
    // 关键变量：初次迁移也必须保持一个源文件只有一个媒体归属，避免把 APP 历史异常数据带入云端主库。
    for (const local of snapshot.fileLinks) {
      const localPath = readText(local, "path");
      const sourceFileId = sourceIdByPath.get(localPath);
      const localEpisodeId = readText(local, "episodeId");
      const targetItemId = localEpisodeId
        ? episodeIdByLocalId.get(localEpisodeId)
        : itemIdByLocalId.get(readText(local, "itemId"));
      if (!sourceFileId || !targetItemId) continue;
      const canonicalPath = canonicalPathBySourcePath.get(localPath) || localPath;
      const usesCanonicalPath = canonicalPath === localPath;
      if (fileLinkRowBySourceId.has(sourceFileId)
        && (!usesCanonicalPath || fileLinkUsesCanonicalPath.has(sourceFileId))) continue;
      fileLinkRowBySourceId.set(sourceFileId, {
        id: randomUUID(),
        user_id: migration.userId,
        library_id: migration.libraryId,
        item_id: targetItemId,
        source_file_id: sourceFileId,
        locator_json: JSON.stringify({
          linkType: readText(local, "linkType") || "primary",
          confidence: readNumber(local, "confidence"),
        }),
      });
      if (usesCanonicalPath) fileLinkUsesCanonicalPath.add(sourceFileId);
    }
    const fileLinkRows = Array.from(fileLinkRowBySourceId.values());

    await batchInsert(transaction, "source_files", sourceRows);
    await batchInsert(transaction, "media_items", mediaRows);
    await batchInsert(transaction, "media_relations", relationRows);
    await batchInsert(transaction, "file_links", fileLinkRows);
    const catalogChangeRows = mediaRows.map((row, index) => ({
      user_id: migration.userId,
      library_id: migration.libraryId,
      catalog_version: index + 1,
      entity_type: "media_item",
      entity_id: row.id,
      change_type: "upsert",
      created_at: now,
    }));
    await batchInsert(transaction, "catalog_changes", catalogChangeRows);
    await transaction("media_libraries").where({ id: migration.libraryId }).update({
      catalog_version: mediaRows.length,
      updated_at: now,
    });
    return {
      sourceFiles: sourceRows.length,
      movies: movieCount,
      series: seriesCount,
      episodes: episodeIdByLocalId.size,
      fileLinks: fileLinkRows.length,
    };
  });
}

/** 合并上传分片并同时计算整包 SHA-256。 */
async function assembleSnapshot(
  chunks: Array<{ filePath: string; sizeBytes: number; sha256: string }>,
  targetPath: string,
): Promise<{ sha256: string; sizeBytes: number }> {
  const fileHandle = await fsPromises.open(targetPath, "w", 0o600);
  const digest = createHash("sha256");
  let writtenBytes = 0;
  try {
    for (const chunk of chunks) {
      const payload = await fsPromises.readFile(chunk.filePath);
      const chunkHash = createHash("sha256").update(payload).digest("hex");
      if (payload.length !== chunk.sizeBytes || chunkHash !== chunk.sha256) {
        throw new ApiError(422, "migration_chunk_storage_mismatch", "迁移分片存储校验失败，请重新上传");
      }
      await fileHandle.write(payload, 0, payload.length, writtenBytes);
      digest.update(payload);
      writtenBytes += payload.length;
    }
  } finally {
    await fileHandle.close();
  }
  return { sha256: digest.digest("hex"), sizeBytes: writtenBytes };
}

/** 轮询并执行服务迁移后台任务；APP 上传完成后可直接退出。 */
export class ServiceMigrationWorker {
  private readonly database: FlyCloudHelperDatabase;
  private readonly repository: ServiceMigrationRepository;
  private readonly exports: LibraryExportService;
  private readonly config: ApiConfig;
  private readonly logger: MigrationWorkerLogger;
  private readonly workerId = `migration-worker-${process.pid}-${randomUUID()}`;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active = false;
  private stopping = false;

  public constructor(input: {
    database: FlyCloudHelperDatabase;
    repository: ServiceMigrationRepository;
    exports: LibraryExportService;
    config: ApiConfig;
    logger: MigrationWorkerLogger;
  }) {
    this.database = input.database;
    this.repository = input.repository;
    this.exports = input.exports;
    this.config = input.config;
    this.logger = input.logger;
  }

  /** 启动单并发迁移队列，避免大批量导入挤占扫描 Worker。 */
  public start(): void {
    if (!this.config.workerEnabled || this.timer || this.stopping) return;
    this.schedule(0);
  }

  /** 停止领取新迁移并等待当前事务结束。 */
  public async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.active) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  /** 安排下一次迁移队列轮询。 */
  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.poll();
    }, delayMs);
  }

  /** 领取一条排队迁移并在后台执行。 */
  private async poll(): Promise<void> {
    if (this.stopping) return;
    try {
      if (!this.active) {
        const migration = await this.repository.claimNext(this.workerId);
        if (migration) {
          this.active = true;
          void this.execute(migration).finally(() => {
            this.active = false;
          });
        }
      }
    } catch (error) {
      this.logger.error({
        日志关键字: "codex-flycloud-migration-import",
        事件: "领取服务迁移失败",
        错误信息: toSafeErrorMessage(error),
      });
    } finally {
      this.schedule(this.config.workerPollIntervalMs);
    }
  }

  /** 执行快照合并、校验、导入、规范快照生成和最终提交。 */
  private async execute(migration: ServiceMigrationRecord): Promise<void> {
    const startedAt = Date.now();
    const migrationDirectory = path.join(
      this.config.migrationDirectory,
      migration.userId,
      migration.id,
    );
    const archivePath = path.join(migrationDirectory, "snapshot.zip");
    try {
      this.logger.info({
        日志关键字: "codex-flycloud-migration-import",
        事件: "服务迁移后台处理开始",
        用户ID: migration.userId,
        迁移ID: migration.id,
        服务ID: migration.serviceId,
      });
      const [chunks, expectation] = await Promise.all([
        this.repository.listChunks(migration.id),
        this.repository.getSnapshotExpectation(migration.id),
      ]);
      await fsPromises.mkdir(migrationDirectory, { recursive: true, mode: 0o700 });
      const assembled = await assembleSnapshot(chunks, archivePath);
      if (assembled.sizeBytes !== expectation.totalBytes || assembled.sha256 !== expectation.sha256) {
        throw new ApiError(422, "migration_snapshot_hash_mismatch", "迁移快照总校验失败，请重新上传");
      }
      await this.repository.updateActiveStage({
        migrationId: migration.id,
        status: "importing",
        progressPercent: 55,
        currentOperation: "正在读取本地媒体库快照",
        checkpoint: { archiveVerified: true },
      });
      const snapshot = await readFlymbySnapshot(archivePath, this.config.migrationSnapshotMaxBytes);
      const totalRows = snapshot.sourceFiles.length + snapshot.videoItems.length
        + snapshot.episodes.length + snapshot.fileLinks.length;
      await this.repository.updateActiveStage({
        migrationId: migration.id,
        status: "importing",
        progressPercent: 65,
        currentOperation: "正在把本地扫描刮削结果写入云端媒体库",
        processedCount: 0,
        totalCount: totalRows,
        checkpoint: { archiveVerified: true, snapshotParsed: true },
      });
      const statistics = await importSnapshotRows(this.database, migration, snapshot, this.logger);
      await this.repository.updateActiveStage({
        migrationId: migration.id,
        status: "finalizing",
        progressPercent: 90,
        currentOperation: "正在生成 APP 可用的规范快照",
        processedCount: totalRows,
        totalCount: totalRows,
        checkpoint: { archiveVerified: true, catalogImported: true },
      });
      const exported = await this.exports.createSnapshot(migration.userId, migration.libraryId);
      const service = await this.database.query("cloud_services")
        .select("credential_revision", "scan_profile_revision", "metadata_profile_revision")
        .where({ id: migration.serviceId, user_id: migration.userId })
        .first();
      const library = await this.database.query("media_libraries")
        .select("catalog_version")
        .where({ id: migration.libraryId, user_id: migration.userId })
        .first();
      await this.repository.complete(migration.id, {
        serviceId: migration.serviceId,
        libraryId: migration.libraryId,
        catalogVersion: Number(library?.catalog_version ?? 0),
        credentialRevision: Number(service?.credential_revision ?? 1),
        scanProfileRevision: Number(service?.scan_profile_revision ?? 1),
        metadataProfileRevision: Number(service?.metadata_profile_revision ?? 1),
        importStatistics: statistics,
        snapshot: {
          exportId: exported.id,
          sizeBytes: exported.fileSize,
          createdAt: exported.createdAt,
        },
      });
      await fsPromises.rm(archivePath, { force: true });
      this.logger.info({
        日志关键字: "codex-flycloud-migration-import",
        事件: "服务迁移后台处理完成",
        用户ID: migration.userId,
        迁移ID: migration.id,
        服务ID: migration.serviceId,
        源文件数: statistics.sourceFiles,
        电影数: statistics.movies,
        节目数: statistics.series,
        单集数: statistics.episodes,
        文件关联数: statistics.fileLinks,
        导入耗时毫秒: Date.now() - startedAt,
      });
    } catch (error) {
      const normalizedError = normalizeMigrationImportError(error); // 关键变量：禁止把完整数据库 SQL 暴露给 APP。
      const code = normalizedError instanceof ApiError ? normalizedError.code : "service_migration_failed";
      const retryable = !(normalizedError instanceof ApiError) || normalizedError.statusCode >= 500;
      await this.repository.fail(
        migration.id,
        code,
        toSafeErrorMessage(normalizedError, "服务迁移失败"),
        retryable,
      );
      this.logger.warn({
        日志关键字: "codex-flycloud-migration-import",
        事件: "服务迁移后台处理失败",
        用户ID: migration.userId,
        迁移ID: migration.id,
        服务ID: migration.serviceId,
        错误码: code,
        错误信息: toSafeErrorMessage(normalizedError),
      });
    }
  }
}
