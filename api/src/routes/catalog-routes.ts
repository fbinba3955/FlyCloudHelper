import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { CatalogSort, MatchState, MediaType } from "../domain.js";
import { ApiError } from "../errors.js";
import { readPagination, requireConfirmation, requireRequestUser } from "../http.js";
import {
  applyManualVideoMatch,
  clearManualVideoMatch,
  searchManualVideoMatches,
} from "../media/manual-video-match.js";
import { hydrateRealtimeVideoDetails } from "../media/realtime-video-details.js";
import type { ApiRuntime } from "../runtime.js";

/** APP 首页当前展示的云端视频分类，数量必须与对应分类列表接口一致。 */
const HOME_VIDEO_CATEGORY_KEYS = ["movie", "tv", "anime", "variety", "documentary"];
/** 每个首页分类只返回少量预览条目，完整数量由数据库单独统计。 */
const HOME_VIDEO_CATEGORY_PREVIEW_LIMIT = 18;

/** 查询媒体库并强制当前用户归属。 */
async function requireLibrary(runtime: ApiRuntime, libraryId: string, userId: string) {
  const row = await runtime.database.query("media_libraries as l")
    .join("cloud_services as s", "s.id", "l.service_id")
    .select(
      "l.id", "l.service_id", "l.provider_type", "l.catalog_version", "l.status",
      "l.created_at", "l.updated_at", "s.display_name", "s.data_type", "s.last_scan_at",
    )
    .where("l.id", libraryId)
    .where("l.user_id", userId)
    .whereNull("s.deleted_at")
    .first();
  if (!row) throw new ApiError(404, "library_not_found", "媒体库不存在");
  return row;
}

/** 播放定位只允许使用 APP Bearer Token 的请求读取。 */
function requireAppBearer(request: FastifyRequest): void {
  if (!request.headers.authorization?.startsWith("Bearer ")) {
    throw new ApiError(403, "app_token_required", "文件定位只提供给已登录 APP 客户端");
  }
}

/** 验证媒体条目属于 URL 指定媒体库。 */
async function requireLibraryItem(runtime: ApiRuntime, userId: string, libraryId: string, itemId: string) {
  const item = await runtime.repository.getCatalogItem(itemId, userId);
  if (item.libraryId !== libraryId) {
    throw new ApiError(404, "media_item_not_found", "媒体条目不存在");
  }
  return item;
}

/** 记录普通用户对媒体匹配结果的人工修改。 */
async function auditCatalogAction(
  runtime: ApiRuntime,
  user: { id: string; username: string },
  operationType: string,
  itemId: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await runtime.database.addAudit({
    id: randomUUID(),
    operatorUserId: user.id,
    operatorUsername: user.username,
    operationType,
    targetType: "media_item",
    targetId: itemId,
    result: "success",
    detail,
  });
}

/** 注册普通用户和 APP 共用的媒体目录、变更与导出接口。 */
export async function registerCatalogRoutes(server: FastifyInstance, runtime: ApiRuntime): Promise<void> {
  server.get<{ Params: { libraryId: string } }>("/api/v1/libraries/:libraryId", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    const library = await requireLibrary(runtime, request.params.libraryId, user.id);
    const recentJobs = await runtime.repository.listJobs({
      userId: user.id,
      serviceId: String(library.service_id),
      limit: 10,
      offset: 0,
    });
    return {
      library: {
        libraryId: library.id,
        serviceId: library.service_id,
        displayName: library.display_name,
        providerType: library.provider_type,
        dataType: library.data_type,
        catalogVersion: Number(library.catalog_version),
        status: library.status,
        lastScanAt: library.last_scan_at,
        createdAt: library.created_at,
        updatedAt: library.updated_at,
        recentJobs: recentJobs.items,
      },
    };
  });

  server.get<{
    Params: { libraryId: string };
    Querystring: Record<string, unknown>;
  }>("/api/v1/libraries/:libraryId/home", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    const library = await requireLibrary(runtime, request.params.libraryId, user.id);
    const includeItems = request.query.includeItems !== "false"; // 设置页只读统计时不返回海报条目。
    // 关键变量：同一次首页请求并行读取海报和库统计，避免设置页再读取 APP 本地快照。
    const [matchedCountRows, libraryCountRows, episodeCountRow, sourceFileCountRow, sections, categorySections] = await Promise.all([
      runtime.database.query("media_items")
        .select("item_type")
        .count<Array<{ item_type: string; count: string | number }>>({ count: "id" })
        .where({ user_id: user.id, library_id: request.params.libraryId, match_state: "matched" })
        .whereNull("deleted_at")
        .whereIn("item_type", ["video.movie", "video.series"])
        .groupBy("item_type"),
      runtime.database.query("media_items")
        .select("item_type")
        .count<Array<{ item_type: string; count: string | number }>>({ count: "id" })
        .where({ user_id: user.id, library_id: request.params.libraryId })
        .whereNull("deleted_at")
        .whereIn("item_type", ["video.movie", "video.series"])
        .groupBy("item_type"),
      runtime.database.query("media_items")
        .count<{ count: string | number }[]>({ count: "id" })
        .where({ user_id: user.id, library_id: request.params.libraryId, item_type: "video.episode" })
        .whereNull("deleted_at")
        .first(),
      runtime.database.query("source_files")
        .count<{ count: string | number }[]>({ count: "id" })
        .where({ user_id: user.id, library_id: request.params.libraryId, status: "active" })
        .first(),
      includeItems ? Promise.all((["video"] as MediaType[]).map(async (mediaType) => {
        const result = await runtime.repository.listCatalogItems({
          userId: user.id,
          libraryId: request.params.libraryId,
          mediaType,
          matchState: "matched",
          sort: "updated_desc",
          limit: 96,
          offset: 0,
          includeFileCounts: false,
        });
        return { mediaType, total: result.total, items: result.items };
      })) : Promise.resolve([]),
      includeItems ? Promise.all(HOME_VIDEO_CATEGORY_KEYS.map(async (categoryKey) => {
        const result = await runtime.repository.listCatalogItems({
          userId: user.id,
          libraryId: request.params.libraryId,
          mediaType: "video",
          categoryKey,
          sort: "updated_desc",
          limit: HOME_VIDEO_CATEGORY_PREVIEW_LIMIT,
          offset: 0,
          includeFileCounts: false,
        });
        return { key: categoryKey, total: result.total, items: result.items };
      })) : Promise.resolve([]),
    ]);
    const movieCount = Number(matchedCountRows.find((row) => row.item_type === "video.movie")?.count ?? 0);
    const showCount = Number(matchedCountRows.find((row) => row.item_type === "video.series")?.count ?? 0);
    request.log.info({
      日志关键字: "codex-flycloud-home-category",
      事件: "首页分类统计完成",
      媒体库ID: request.params.libraryId,
      分类数量: categorySections.map((section) => `${section.key}:${section.total}`).join(","),
    });
    return {
      catalogVersion: Number(library.catalog_version),
      total: movieCount + showCount,
      movieCount,
      showCount,
      libraryMovieCount: Number(libraryCountRows.find((row) => row.item_type === "video.movie")?.count ?? 0),
      libraryShowCount: Number(libraryCountRows.find((row) => row.item_type === "video.series")?.count ?? 0),
      episodeCount: Number(episodeCountRow?.count ?? 0),
      sourceFileCount: Number(sourceFileCountRow?.count ?? 0),
      sections,
      categorySections,
    };
  });

  server.get<{ Params: { libraryId: string }; Querystring: Record<string, unknown> }>("/api/v1/libraries/:libraryId/facets", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    const library = await requireLibrary(runtime, request.params.libraryId, user.id);
    const rows = await runtime.database.query("media_items")
      .select("media_type", "item_type", "match_state")
      .count<{ count: string | number }[]>({ count: "id" })
      .where({ user_id: user.id, library_id: request.params.libraryId })
      .whereNull("deleted_at")
      .groupBy("media_type", "item_type", "match_state");
    return {
      catalogVersion: Number(library.catalog_version),
      mediaTypes: ["video"],
      sorts: ["created_desc", "year_desc", "premiere_date_desc", "title_asc"],
      combinations: rows.map((row) => ({
        mediaType: row.media_type,
        itemType: row.item_type,
        matchState: row.match_state,
        count: Number(row.count),
      })),
    };
  });

  /** 执行带媒体库作用域的目录列表和搜索。 */
  const listLibraryItems = async (
    request: FastifyRequest<{ Params: { libraryId: string }; Querystring: Record<string, unknown> }>,
  ) => {
    const user = await requireRequestUser(request, runtime.database);
    const library = await requireLibrary(runtime, request.params.libraryId, user.id);
    const sortValue = request.query.sort;
    const supportedSorts = new Set([
      "created_desc", "created_asc", "updated_desc", "updated_asc",
      "year_desc", "year_asc", "premiere_date_desc", "premiere_date_asc",
      "title_asc", "title_desc",
    ]);
    const sort = typeof sortValue === "string" && supportedSorts.has(sortValue)
      ? sortValue as CatalogSort
      : "created_desc";
    const pagination = readPagination(request.query);
    // 关键变量：目录查询耗时用于判断 SQLite 是否再次被扫描任务或慢查询阻塞。
    const queryStartedAt = Date.now();
    request.log.info({
      日志关键字: "codex-catalog-query",
      事件: "媒体目录查询开始",
      媒体库ID: request.params.libraryId,
      排序方式: sort,
      返回上限: pagination.limit,
      偏移量: pagination.offset,
    });
    try {
      const result = await runtime.repository.listCatalogItems({
        userId: user.id,
        libraryId: request.params.libraryId,
        itemIds: typeof request.query.ids === "string"
          ? request.query.ids.split(",").map((value) => value.trim()).filter((value) => value.length > 0).slice(0, 200)
          : undefined,
        mediaType: typeof request.query.mediaType === "string" ? request.query.mediaType as MediaType : undefined,
        itemType: typeof request.query.itemType === "string" ? request.query.itemType : undefined,
        matchState: typeof request.query.matchState === "string" ? request.query.matchState as MatchState : undefined,
        categoryKey: typeof request.query.categoryKey === "string" ? request.query.categoryKey : undefined,
        genre: typeof request.query.genre === "string" ? request.query.genre : undefined,
        search: typeof request.query.search === "string"
          ? request.query.search
          : typeof request.query.q === "string" ? request.query.q : undefined,
        sort,
        ...pagination,
      });
      request.log.info({
        日志关键字: "codex-catalog-query",
        事件: "媒体目录查询完成",
        媒体库ID: request.params.libraryId,
        查询耗时毫秒: Date.now() - queryStartedAt,
        返回数量: result.items.length,
        总数量: result.total,
      });
      return { ...result, catalogVersion: Number(library.catalog_version) };
    } catch (error) {
      request.log.warn({
        日志关键字: "codex-catalog-query",
        事件: "媒体目录查询失败",
        媒体库ID: request.params.libraryId,
        查询耗时毫秒: Date.now() - queryStartedAt,
        错误: error,
      });
      throw error;
    }
  };

  server.get<{ Params: { libraryId: string }; Querystring: Record<string, unknown> }>("/api/v1/libraries/:libraryId/items", listLibraryItems);
  server.get<{ Params: { libraryId: string }; Querystring: Record<string, unknown> }>("/api/v1/libraries/:libraryId/search", listLibraryItems);

  server.get<{ Params: { libraryId: string; itemId: string } }>("/api/v1/libraries/:libraryId/items/:itemId", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    await requireLibrary(runtime, request.params.libraryId, user.id);
    const item = await requireLibraryItem(runtime, user.id, request.params.libraryId, request.params.itemId);
    return { item: await hydrateRealtimeVideoDetails(runtime, item) };
  });

  server.get<{ Params: { libraryId: string; itemId: string } }>("/api/v1/libraries/:libraryId/items/:itemId/children", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    await requireLibrary(runtime, request.params.libraryId, user.id);
    await requireLibraryItem(runtime, user.id, request.params.libraryId, request.params.itemId);
    return { items: await runtime.repository.listCatalogChildren(request.params.itemId, user.id) };
  });

  server.get<{ Params: { libraryId: string; itemId: string } }>("/api/v1/libraries/:libraryId/items/:itemId/paths", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    await requireLibrary(runtime, request.params.libraryId, user.id);
    await requireLibraryItem(runtime, user.id, request.params.libraryId, request.params.itemId);
    return { items: await runtime.repository.listCatalogItemPaths(request.params.itemId, user.id) };
  });

  server.get<{
    Params: { libraryId: string; itemId: string };
    Querystring: Record<string, unknown>;
  }>("/api/v1/libraries/:libraryId/items/:itemId/manual-match/search", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    await requireLibrary(runtime, request.params.libraryId, user.id);
    const item = await requireLibraryItem(runtime, user.id, request.params.libraryId, request.params.itemId);
    return {
      items: await searchManualVideoMatches(runtime, item, {
        query: request.query.query,
        mediaType: request.query.mediaType,
        year: request.query.year,
      }),
    };
  });

  server.post<{
    Params: { libraryId: string; itemId: string };
    Body: Record<string, unknown>;
  }>("/api/v1/libraries/:libraryId/items/:itemId/manual-match", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    await requireLibrary(runtime, request.params.libraryId, user.id);
    const item = await requireLibraryItem(runtime, user.id, request.params.libraryId, request.params.itemId);
    const updatedItem = await applyManualVideoMatch(runtime, item, {
      mediaType: request.body.mediaType,
      tmdbId: request.body.tmdbId,
    });
    await auditCatalogAction(runtime, user, "manual_match_media_item", item.id, {
      匹配类型: request.body.mediaType,
      TMDB编号: request.body.tmdbId,
    });
    return { item: updatedItem };
  });

  server.post<{
    Params: { libraryId: string; itemId: string };
  }>("/api/v1/libraries/:libraryId/items/:itemId/manual-match/clear", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    await requireLibrary(runtime, request.params.libraryId, user.id);
    const item = await requireLibraryItem(runtime, user.id, request.params.libraryId, request.params.itemId);
    const updatedItem = await clearManualVideoMatch(runtime, item);
    await auditCatalogAction(runtime, user, "clear_media_item_match", item.id);
    return { item: updatedItem };
  });

  server.get<{ Params: { libraryId: string; itemId: string } }>("/api/v1/libraries/:libraryId/items/:itemId/files", async (request) => {
    requireAppBearer(request);
    const user = await requireRequestUser(request, runtime.database);
    const library = await requireLibrary(runtime, request.params.libraryId, user.id);
    await requireLibraryItem(runtime, user.id, request.params.libraryId, request.params.itemId);
    return {
      schemaVersion: 1,
      providerType: library.provider_type,
      items: await runtime.repository.listItemFiles(request.params.itemId, user.id),
    };
  });

  server.post<{ Params: { libraryId: string; itemId: string; fileId: string } }>(
    "/api/v1/libraries/:libraryId/items/:itemId/files/:fileId/access",
    async (request) => {
      requireAppBearer(request);
      const user = await requireRequestUser(request, runtime.database);
      const library = await requireLibrary(runtime, request.params.libraryId, user.id);
      await requireLibraryItem(runtime, user.id, request.params.libraryId, request.params.itemId);
      const files = await runtime.repository.listItemFiles(request.params.itemId, user.id);
      // 关键变量：只能为当前媒体条目已绑定的源文件签发访问地址，禁止跨服务猜测 fileId。
      const sourceFile = files.find((file) => String(file.fileId) === request.params.fileId);
      if (!sourceFile) throw new ApiError(404, "source_file_not_found", "媒体源文件不存在");
      const adapter = runtime.providers.get(String(library.provider_type));
      if (!adapter.resolveFileAccess) {
        throw new ApiError(422, "provider_file_access_unsupported", "当前网盘类型暂不支持服务端文件访问");
      }
      const service = await runtime.repository.getServiceDetail(String(library.service_id), user.id);
      const connection = runtime.vault.decrypt(
        await runtime.repository.getActiveEncryptedConnection(service.id, user.id),
      );
      const locator = sourceFile.playbackLocator && typeof sourceFile.playbackLocator === "object"
        ? sourceFile.playbackLocator as Record<string, unknown>
        : {};
      const access = await adapter.resolveFileAccess(connection, locator, undefined, {
        persistConnection: async (nextConnection) => {
          await runtime.repository.refreshActiveEncryptedConnection({
            serviceId: service.id,
            userId: user.id,
            credentialRevision: service.credentialRevision,
            encryptedConnection: runtime.vault.encrypt(nextConnection),
          });
          runtime.logBusinessEvent("info", {
            日志关键字: "codex-flycloud-helper-guangya-token-refresh",
            事件: "文件访问期间保存光鸭刷新令牌",
            用户ID: user.id,
            服务ID: service.id,
            凭据修订: service.credentialRevision,
          });
        },
      });
      return {
        schemaVersion: 1,
        accessType: "temporary_url",
        url: access.url,
        headers: access.headers,
        expiresAt: access.expiresAt,
      };
    },
  );

  server.get<{ Params: { libraryId: string }; Querystring: Record<string, unknown> }>("/api/v1/libraries/:libraryId/changes", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    const library = await requireLibrary(runtime, request.params.libraryId, user.id);
    const afterVersion = Math.max(0, Number.parseInt(String(request.query.afterVersion ?? "0"), 10) || 0);
    const limit = Math.min(1000, Math.max(1, Number.parseInt(String(request.query.limit ?? "500"), 10) || 500));
    const result = await runtime.repository.listCatalogChanges(user.id, request.params.libraryId, afterVersion, limit);
    return { ...result, catalogVersion: Number(library.catalog_version) };
  });

  server.post<{ Params: { libraryId: string }; Body: Record<string, unknown> }>("/api/v1/libraries/:libraryId/exports", async (request, reply) => {
    const user = await requireRequestUser(request, runtime.database);
    await requireLibrary(runtime, request.params.libraryId, user.id);
    const exportType = request.body.exportType ?? "snapshot";
    if (exportType !== "snapshot") {
      throw new ApiError(422, "export_type_not_supported", "当前只支持完整目录 snapshot 导出");
    }
    const record = await runtime.exports.createSnapshotTask(user.id, request.params.libraryId);
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-flycloud-snapshot-task",
      事件: "用户从网页或APP创建云端快照",
      用户ID: user.id,
      媒体库ID: request.params.libraryId,
      导出ID: record.id,
    });
    return reply.status(202).send({ export: { ...record, filePath: undefined } });
  });

  server.get<{
    Params: { libraryId: string };
    Querystring: Record<string, unknown>;
  }>("/api/v1/libraries/:libraryId/exports", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    await requireLibrary(runtime, request.params.libraryId, user.id);
    const limit = Math.min(100, Math.max(1, Number.parseInt(String(request.query.limit ?? "20"), 10) || 20));
    const records = await runtime.exports.listExports(user.id, request.params.libraryId, limit);
    return { exports: records.map((record) => ({ ...record, filePath: undefined })) };
  });

  server.get<{ Params: { exportId: string } }>("/api/v1/exports/:exportId", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    const record = await runtime.exports.getExport(request.params.exportId, user.id);
    return { export: { ...record, filePath: undefined } };
  });

  server.delete<{ Params: { exportId: string }; Body: Record<string, unknown> }>(
    "/api/v1/exports/:exportId",
    async (request, reply) => {
      const user = await requireRequestUser(request, runtime.database);
      requireConfirmation(request.body, request.params.exportId);
      try {
        const record = await runtime.exports.deleteExport(request.params.exportId, user.id);
        await runtime.database.addAudit({
          id: randomUUID(),
          operatorUserId: user.id,
          operatorUsername: user.username,
          operationType: "delete_library_snapshot",
          targetType: "library_export",
          targetId: record.id,
          result: "success",
          detail: { 媒体库ID: record.libraryId, 快照状态: record.status },
        });
      } catch (error) {
        runtime.logBusinessEvent("warn", {
          日志关键字: "codex-flycloud-snapshot-delete",
          事件: "用户删除云端快照失败",
          用户ID: user.id,
          导出ID: request.params.exportId,
          错误码: error && typeof error === "object" && "code" in error
            ? String((error as { code?: string }).code)
            : "snapshot_delete_failed",
        });
        throw error;
      }
      return reply.status(204).send();
    },
  );

  server.get<{ Params: { exportId: string } }>("/api/v1/exports/:exportId/download", async (request, reply) => {
    const user = await requireRequestUser(request, runtime.database);
    const filePath = await runtime.exports.getDownloadPath(request.params.exportId, user.id);
    reply.header(
      "Content-Type",
      filePath.endsWith(".zip")
        ? "application/zip"
        : filePath.endsWith(".jsonl")
          ? "application/x-ndjson"
          : "application/vnd.flymby.scanner-backup+json",
    );
    reply.header("Content-Disposition", `attachment; filename="${path.basename(filePath)}"`);
    return reply.send(fs.createReadStream(filePath));
  });
}
