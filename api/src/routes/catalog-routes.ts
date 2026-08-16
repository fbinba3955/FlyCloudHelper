import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { MatchState, MediaType } from "../domain.js";
import { ApiError } from "../errors.js";
import { readPagination, requireRequestUser } from "../http.js";
import {
  applyManualVideoMatch,
  clearManualVideoMatch,
  searchManualVideoMatches,
} from "../media/manual-video-match.js";
import type { ApiRuntime } from "../runtime.js";

/** 查询媒体库并强制当前租户归属。 */
async function requireLibrary(runtime: ApiRuntime, libraryId: string, tenantId: string) {
  const row = await runtime.database.query("media_libraries as l")
    .join("cloud_services as s", "s.id", "l.service_id")
    .select(
      "l.id", "l.service_id", "l.provider_type", "l.catalog_version", "l.status",
      "l.created_at", "l.updated_at", "s.display_name", "s.data_type", "s.last_scan_at",
    )
    .where("l.id", libraryId)
    .where("l.tenant_id", tenantId)
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
async function requireLibraryItem(runtime: ApiRuntime, tenantId: string, libraryId: string, itemId: string) {
  const item = await runtime.repository.getCatalogItem(itemId, tenantId);
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
    const library = await requireLibrary(runtime, request.params.libraryId, user.tenantId);
    const recentJobs = await runtime.repository.listJobs({
      tenantId: user.tenantId,
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

  server.get<{ Params: { libraryId: string } }>("/api/v1/libraries/:libraryId/home", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    const library = await requireLibrary(runtime, request.params.libraryId, user.tenantId);
    const sections = await Promise.all((["video"] as MediaType[]).map(async (mediaType) => {
      const result = await runtime.repository.listCatalogItems({
        tenantId: user.tenantId,
        libraryId: request.params.libraryId,
        mediaType,
        sort: "created_desc",
        limit: 24,
        offset: 0,
      });
      return { mediaType, total: result.total, items: result.items };
    }));
    return { catalogVersion: Number(library.catalog_version), sections };
  });

  server.get<{ Params: { libraryId: string }; Querystring: Record<string, unknown> }>("/api/v1/libraries/:libraryId/facets", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    const library = await requireLibrary(runtime, request.params.libraryId, user.tenantId);
    const rows = await runtime.database.query("media_items")
      .select("media_type", "item_type", "match_state")
      .count<{ count: string | number }[]>({ count: "id" })
      .where({ tenant_id: user.tenantId, library_id: request.params.libraryId })
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
    const library = await requireLibrary(runtime, request.params.libraryId, user.tenantId);
    const sortValue = request.query.sort;
    const sort = sortValue === "title_asc"
      || sortValue === "year_desc"
      || sortValue === "premiere_date_desc"
      ? sortValue
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
        tenantId: user.tenantId,
        libraryId: request.params.libraryId,
        mediaType: typeof request.query.mediaType === "string" ? request.query.mediaType as MediaType : undefined,
        itemType: typeof request.query.itemType === "string" ? request.query.itemType : undefined,
        matchState: typeof request.query.matchState === "string" ? request.query.matchState as MatchState : undefined,
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
    await requireLibrary(runtime, request.params.libraryId, user.tenantId);
    return { item: await requireLibraryItem(runtime, user.tenantId, request.params.libraryId, request.params.itemId) };
  });

  server.get<{ Params: { libraryId: string; itemId: string } }>("/api/v1/libraries/:libraryId/items/:itemId/children", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    await requireLibrary(runtime, request.params.libraryId, user.tenantId);
    await requireLibraryItem(runtime, user.tenantId, request.params.libraryId, request.params.itemId);
    return { items: await runtime.repository.listCatalogChildren(request.params.itemId, user.tenantId) };
  });

  server.get<{ Params: { libraryId: string; itemId: string } }>("/api/v1/libraries/:libraryId/items/:itemId/paths", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    await requireLibrary(runtime, request.params.libraryId, user.tenantId);
    await requireLibraryItem(runtime, user.tenantId, request.params.libraryId, request.params.itemId);
    return { items: await runtime.repository.listCatalogItemPaths(request.params.itemId, user.tenantId) };
  });

  server.get<{
    Params: { libraryId: string; itemId: string };
    Querystring: Record<string, unknown>;
  }>("/api/v1/libraries/:libraryId/items/:itemId/manual-match/search", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    await requireLibrary(runtime, request.params.libraryId, user.tenantId);
    const item = await requireLibraryItem(runtime, user.tenantId, request.params.libraryId, request.params.itemId);
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
    await requireLibrary(runtime, request.params.libraryId, user.tenantId);
    const item = await requireLibraryItem(runtime, user.tenantId, request.params.libraryId, request.params.itemId);
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
    await requireLibrary(runtime, request.params.libraryId, user.tenantId);
    const item = await requireLibraryItem(runtime, user.tenantId, request.params.libraryId, request.params.itemId);
    const updatedItem = await clearManualVideoMatch(runtime, item);
    await auditCatalogAction(runtime, user, "clear_media_item_match", item.id);
    return { item: updatedItem };
  });

  server.get<{ Params: { libraryId: string; itemId: string } }>("/api/v1/libraries/:libraryId/items/:itemId/files", async (request) => {
    requireAppBearer(request);
    const user = await requireRequestUser(request, runtime.database);
    const library = await requireLibrary(runtime, request.params.libraryId, user.tenantId);
    await requireLibraryItem(runtime, user.tenantId, request.params.libraryId, request.params.itemId);
    return {
      schemaVersion: 1,
      providerType: library.provider_type,
      items: await runtime.repository.listItemFiles(request.params.itemId, user.tenantId),
    };
  });

  server.get<{ Params: { libraryId: string }; Querystring: Record<string, unknown> }>("/api/v1/libraries/:libraryId/changes", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    const library = await requireLibrary(runtime, request.params.libraryId, user.tenantId);
    const afterVersion = Math.max(0, Number.parseInt(String(request.query.afterVersion ?? "0"), 10) || 0);
    const limit = Math.min(1000, Math.max(1, Number.parseInt(String(request.query.limit ?? "500"), 10) || 500));
    const result = await runtime.repository.listCatalogChanges(user.tenantId, request.params.libraryId, afterVersion, limit);
    return { ...result, catalogVersion: Number(library.catalog_version) };
  });

  server.post<{ Params: { libraryId: string }; Body: Record<string, unknown> }>("/api/v1/libraries/:libraryId/exports", async (request, reply) => {
    const user = await requireRequestUser(request, runtime.database);
    await requireLibrary(runtime, request.params.libraryId, user.tenantId);
    const exportType = request.body.exportType ?? "snapshot";
    if (exportType !== "snapshot") {
      throw new ApiError(422, "export_type_not_supported", "当前只支持完整目录 snapshot 导出");
    }
    const record = await runtime.exports.createSnapshot(user.tenantId, request.params.libraryId);
    return reply.status(201).send({ export: { ...record, filePath: undefined } });
  });

  server.get<{ Params: { exportId: string } }>("/api/v1/exports/:exportId", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    const record = await runtime.exports.getExport(request.params.exportId, user.tenantId);
    return { export: { ...record, filePath: undefined } };
  });

  server.get<{ Params: { exportId: string } }>("/api/v1/exports/:exportId/download", async (request, reply) => {
    const user = await requireRequestUser(request, runtime.database);
    const filePath = await runtime.exports.getDownloadPath(request.params.exportId, user.tenantId);
    reply.header("Content-Type", "application/vnd.flymby.scanner-backup+json");
    reply.header("Content-Disposition", `attachment; filename="${path.basename(filePath)}"`);
    return reply.send(fs.createReadStream(filePath));
  });
}
