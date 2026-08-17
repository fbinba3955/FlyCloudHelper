import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ApiConfig } from "./config.js";
import type { FlyCloudHelperDatabase } from "./database.js";
import type { ExportRecord } from "./domain.js";
import { ApiError } from "./errors.js";

/** 把数据库导出行转换为公开导出记录。 */
function mapExportRecord(row: Record<string, unknown>): ExportRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    libraryId: String(row.library_id),
    exportType: row.export_type as ExportRecord["exportType"],
    status: row.status as ExportRecord["status"],
    filePath: row.file_path ? String(row.file_path) : null,
    fileSize: row.file_size === null || row.file_size === undefined ? null : Number(row.file_size),
    errorMessage: row.error_message ? String(row.error_message) : null,
    createdAt: String(row.created_at),
  };
}

/** 生成不包含账号密码、网盘凭据和临时播放地址的媒体库导出文件。 */
export class LibraryExportService {
  private readonly database: FlyCloudHelperDatabase;
  private readonly config: ApiConfig;

  public constructor(database: FlyCloudHelperDatabase, config: ApiConfig) {
    this.database = database;
    this.config = config;
  }

  /** 创建 APP 可识别的 FlyCloudHelper JSON 快照。 */
  public async createSnapshot(userId: string, libraryId: string): Promise<ExportRecord> {
    const library = await this.database.query("media_libraries as l")
      .join("cloud_services as s", "s.id", "l.service_id")
      .select("l.*", "s.display_name", "s.provider_type", "s.data_type")
      .where("l.id", libraryId)
      .where("l.user_id", userId)
      .whereNull("s.deleted_at")
      .first();
    if (!library) {
      throw new ApiError(404, "library_not_found", "媒体库不存在");
    }

    const exportId = randomUUID();
    const now = new Date().toISOString();
    const exportDirectory = path.join(this.config.exportDirectory, userId, libraryId);
    // 备份扩展名属于已经约定的客户端导入协议，项目改名后仍保留旧值。
    const finalPath = path.join(exportDirectory, `${exportId}.flymby-scanner-backup.json`);
    const temporaryPath = `${finalPath}.tmp`;
    await fs.mkdir(exportDirectory, { recursive: true });

    try {
      const [items, relations, files] = await Promise.all([
        this.database.query("media_items")
          .select(
            "id", "identity_key", "media_type", "item_type", "title", "sort_title",
            "subtitle", "year", "overview", "poster_url", "backdrop_url", "match_state",
            "external_ids_json", "metadata_json", "created_at", "updated_at",
          )
          .where({ user_id: userId, library_id: libraryId })
          .whereNull("deleted_at"),
        this.database.query("media_relations")
          .select("parent_item_id", "child_item_id", "relation_type", "sort_order")
          .where({ user_id: userId, library_id: libraryId }),
        this.database.query("file_links as fl")
          .join("source_files as f", "f.id", "fl.source_file_id")
          .select(
            "fl.item_id", "f.id as file_id", "f.provider_resource_id", "f.path", "f.name",
            "f.extension", "f.size", "f.modified_at", "f.etag", "fl.locator_json",
          )
          .where("fl.user_id", userId)
          .where("fl.library_id", libraryId)
          .where("f.status", "active"),
      ]);

      // 导出协议只保存目录和客户端本地授权所需定位，不包含任何服务端凭据。
      const payload = {
        // 格式标识属于客户端兼容协议，不随服务端项目名称变化。
        format: "flymby-scanner-library-backup",
        formatVersion: 1,
        createdAt: now,
        source: {
          libraryId,
          catalogVersion: Number(library.catalog_version),
          providerType: String(library.provider_type),
          dataType: String(library.data_type),
          displayName: String(library.display_name),
        },
        mediaItems: items.map((item) => ({
          id: item.id,
          identityKey: item.identity_key,
          mediaType: item.media_type,
          itemType: item.item_type,
          title: item.title,
          sortTitle: item.sort_title,
          subtitle: item.subtitle,
          year: item.year,
          overview: item.overview,
          posterUrl: item.poster_url,
          backdropUrl: item.backdrop_url,
          matchState: item.match_state,
          externalIds: JSON.parse(String(item.external_ids_json || "{}")),
          metadata: JSON.parse(String(item.metadata_json || "{}")),
          createdAt: item.created_at,
          updatedAt: item.updated_at,
        })),
        relations: relations.map((relation) => ({
          parentItemId: relation.parent_item_id,
          childItemId: relation.child_item_id,
          relationType: relation.relation_type,
          sortOrder: Number(relation.sort_order),
        })),
        files: files.map((file) => ({
          itemId: file.item_id,
          fileId: file.file_id,
          resourceId: file.provider_resource_id,
          displayPath: file.path,
          fileName: file.name,
          extension: file.extension,
          size: Number(file.size),
          modifiedAt: file.modified_at,
          etag: file.etag,
          playbackLocator: JSON.parse(String(file.locator_json || "{}")),
        })),
      };
      await fs.writeFile(temporaryPath, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
      await fs.rename(temporaryPath, finalPath);
      const stat = await fs.stat(finalPath);
      await this.database.query("library_exports").insert({
        id: exportId,
        user_id: userId,
        library_id: libraryId,
        export_type: "snapshot",
        status: "completed",
        file_path: finalPath,
        file_size: stat.size,
        error_message: null,
        created_at: now,
      });
    } catch (error) {
      await fs.rm(temporaryPath, { force: true });
      await this.database.query("library_exports").insert({
        id: exportId,
        user_id: userId,
        library_id: libraryId,
        export_type: "snapshot",
        status: "failed",
        file_path: null,
        file_size: null,
        error_message: error instanceof Error ? error.message : "导出失败",
        created_at: now,
      });
      throw error;
    }
    return this.getExport(exportId, userId);
  }

  /** 查询当前用户的导出记录。 */
  public async getExport(exportId: string, userId: string): Promise<ExportRecord> {
    const row = await this.database.query("library_exports")
      .where({ id: exportId, user_id: userId })
      .first();
    if (!row) {
      throw new ApiError(404, "export_not_found", "导出文件不存在");
    }
    return mapExportRecord(row);
  }

  /** 返回经过用户归属校验的导出文件绝对路径。 */
  public async getDownloadPath(exportId: string, userId: string): Promise<string> {
    const record = await this.getExport(exportId, userId);
    if (record.status !== "completed" || !record.filePath) {
      throw new ApiError(409, "export_not_ready", "导出文件尚不可下载");
    }
    return record.filePath;
  }
}
