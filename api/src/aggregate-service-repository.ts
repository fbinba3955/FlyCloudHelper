import { randomUUID } from "node:crypto";
import type { FlyCloudHelperDatabase } from "./database.js";
import { ApiError, validationError } from "./errors.js";

export type AggregateProtocol = "jellyfin" | "emby";
export type AggregateServiceStatus = "draft" | "building" | "active" | "failed" | "disabled";

export interface AggregateServiceMemberRecord {
  id: string;
  serviceId: string;
  libraryId: string;
  displayName: string;
  providerType: string;
  status: string;
  priority: number;
  enabled: boolean;
  itemCount: number;
  catalogVersion: number;
  lastCatalogVersion: number;
}

export interface AggregateServiceRecord {
  id: string;
  userId: string;
  displayName: string;
  protocol: AggregateProtocol;
  pathSuffix: string;
  path: string;
  status: AggregateServiceStatus;
  catalogVersion: number;
  itemCount: number;
  relayPlaybackEnabled: boolean;
  downloadEnabled: boolean;
  regionLibrariesEnabled: boolean;
  createdAt: string;
  updatedAt: string;
  members: AggregateServiceMemberRecord[];
  latestIndexJob: {
    id: string;
    status: string;
    processedCount: number;
    totalCount: number;
    errorCode: string | null;
    errorMessage: string | null;
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
  } | null;
}

export interface CreateAggregateServiceInput {
  userId: string;
  displayName: unknown;
  protocol: unknown;
  pathSuffix: unknown;
  serviceIds: unknown;
  relayPlaybackEnabled?: unknown;
  downloadEnabled?: unknown;
  regionLibrariesEnabled?: unknown;
}

export interface UpdateAggregateServiceInput {
  userId: string;
  displayName?: unknown;
  pathSuffix?: unknown;
  serviceIds?: unknown;
  relayPlaybackEnabled?: unknown;
  downloadEnabled?: unknown;
  regionLibrariesEnabled?: unknown;
}

/** 判断 SQLite、PostgreSQL 或 MySQL 错误是否来自唯一约束。 */
function isUniqueConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = String((error as Error & { code?: string }).code ?? "");
  return code.startsWith("SQLITE_CONSTRAINT") || code === "23505" || code === "ER_DUP_ENTRY";
}

/** 校验聚合服务名称。 */
function validateDisplayName(input: unknown): string {
  if (typeof input !== "string") throw validationError("displayName", "请输入聚合服务名称");
  const value = input.trim();
  if (value.length < 1 || Array.from(value).length > 100) {
    throw validationError("displayName", "聚合服务名称长度必须为 1 至 100 个字符");
  }
  return value;
}

/** 校验一个聚合服务唯一使用的协议。 */
function validateProtocol(input: unknown): AggregateProtocol {
  if (input === "jellyfin" || input === "emby") return input;
  throw validationError("protocol", "聚合类型只能选择 Jellyfin 或 Emby");
}

/** 校验固定协议前缀后的一级地址后缀。 */
function validatePathSuffix(input: unknown): { value: string; lookup: string } {
  if (typeof input !== "string") throw validationError("pathSuffix", "请输入聚合服务地址后缀");
  const value = input.trim();
  if (value.length < 1 || Array.from(value).length > 64) {
    throw validationError("pathSuffix", "聚合服务地址后缀长度必须为 1 至 64 个字符");
  }
  if (!/^[\p{L}\p{N}_-]+$/u.test(value)) {
    throw validationError("pathSuffix", "地址后缀只能包含文字、数字、短横线或下划线，且只能有一级");
  }
  return { value, lookup: value.toLowerCase() };
}

/** 校验至少两个且不重复的来源服务 ID。 */
function validateServiceIds(input: unknown): string[] {
  if (!Array.isArray(input)) throw validationError("serviceIds", "请选择需要聚合的影视服务");
  const serviceIds = input.map((item) => typeof item === "string" ? item.trim() : "").filter(Boolean);
  const uniqueServiceIds = [...new Set(serviceIds)];
  if (uniqueServiceIds.length < 2) {
    throw validationError("serviceIds", "至少选择两个影视服务进行聚合");
  }
  if (uniqueServiceIds.length !== serviceIds.length) {
    throw validationError("serviceIds", "聚合成员不能重复");
  }
  return uniqueServiceIds;
}

/** 校验协议配置开关，避免字符串值被错误当成已启用。 */
function validateBoolean(input: unknown, field: string): boolean {
  if (typeof input !== "boolean") throw validationError(field, "配置开关必须是布尔值");
  return input;
}

/** 管理一个协议对应多个影视来源的聚合服务。 */
export class AggregateServiceRepository {
  public constructor(private readonly database: FlyCloudHelperDatabase) {}

  /** 读取当前用户全部未删除聚合服务及其成员。 */
  public async listByUser(userId: string): Promise<AggregateServiceRecord[]> {
    const rows = await this.database.query("aggregate_services")
      .where({ user_id: userId })
      .whereNull("deleted_at")
      .orderBy("created_at", "desc");
    return this.mapAggregateServices(rows);
  }

  /** 按归属读取一个聚合服务。 */
  public async getById(aggregateServiceId: string, userId: string): Promise<AggregateServiceRecord> {
    const row = await this.database.query("aggregate_services")
      .where({ id: aggregateServiceId, user_id: userId })
      .whereNull("deleted_at")
      .first();
    if (!row) throw new ApiError(404, "aggregate_service_not_found", "聚合服务不存在");
    const records = await this.mapAggregateServices([row]);
    return records[0]!;
  }

  /** 创建一个单协议聚合服务，并按提交顺序保存影视成员优先级。 */
  public async create(input: CreateAggregateServiceInput): Promise<AggregateServiceRecord> {
    const displayName = validateDisplayName(input.displayName);
    const protocol = validateProtocol(input.protocol);
    const pathSuffix = validatePathSuffix(input.pathSuffix);
    const serviceIds = validateServiceIds(input.serviceIds);
    const aggregateServiceId = randomUUID();
    const now = new Date().toISOString();
    const relayPlaybackEnabled = input.relayPlaybackEnabled === undefined
      ? false
      : validateBoolean(input.relayPlaybackEnabled, "relayPlaybackEnabled");
    const downloadEnabled = input.downloadEnabled === undefined
      ? true
      : validateBoolean(input.downloadEnabled, "downloadEnabled");
    const regionLibrariesEnabled = input.regionLibrariesEnabled === undefined
      ? false
      : validateBoolean(input.regionLibrariesEnabled, "regionLibrariesEnabled");

    try {
      await this.database.query.transaction(async (transaction) => {
        const sourceRows = await transaction("cloud_services as s")
          .innerJoin("media_libraries as l", "l.service_id", "s.id")
          .select(
            "s.id as service_id",
            "s.library_id as library_id",
            "s.data_type as data_type",
            "l.catalog_version as catalog_version",
          )
          .where("s.user_id", input.userId)
          .whereNull("s.deleted_at")
          .whereIn("s.id", serviceIds);
        if (sourceRows.length !== serviceIds.length) {
          throw new ApiError(404, "aggregate_source_service_not_found", "部分聚合来源服务不存在或不属于当前账号");
        }
        if (sourceRows.some((row) => String(row.data_type) !== "video")) {
          throw new ApiError(422, "aggregate_video_service_required", "Jellyfin 和 Emby 只能聚合影视类服务");
        }

        const aggregateConflict = await transaction("aggregate_services")
          .select("id")
          .where({ protocol, path_suffix_lookup: pathSuffix.lookup })
          .whereNull("deleted_at")
          .first();
        const legacySuffixColumn = protocol === "jellyfin"
          ? "jellyfin_path_suffix_lookup"
          : "emby_path_suffix_lookup";
        const legacyConflict = await transaction("media_libraries")
          .select("id")
          .where(legacySuffixColumn, pathSuffix.lookup)
          .first();
        if (aggregateConflict || legacyConflict) {
          throw new ApiError(409, "aggregate_path_suffix_conflict", `该 ${protocol === "jellyfin" ? "Jellyfin" : "Emby"} 地址后缀已被使用`);
        }

        await transaction("aggregate_services").insert({
          id: aggregateServiceId,
          user_id: input.userId,
          display_name: displayName,
          protocol,
          path_suffix: pathSuffix.value,
          path_suffix_lookup: pathSuffix.lookup,
          status: "draft",
          catalog_version: 0,
          relay_playback_enabled: relayPlaybackEnabled ? 1 : 0,
          download_enabled: downloadEnabled ? 1 : 0,
          region_libraries_enabled: regionLibrariesEnabled ? 1 : 0,
          created_at: now,
          updated_at: now,
          deleted_at: null,
        });

        const sourceRowsById = new Map(sourceRows.map((row) => [String(row.service_id), row]));
        await transaction("aggregate_service_members").insert(serviceIds.map((serviceId, priority) => {
          const source = sourceRowsById.get(serviceId)!;
          return {
            id: randomUUID(),
            aggregate_service_id: aggregateServiceId,
            user_id: input.userId,
            service_id: serviceId,
            library_id: String(source.library_id),
            priority,
            enabled: 1,
            last_catalog_version: Number(source.catalog_version ?? 0),
            created_at: now,
            updated_at: now,
          };
        }));
      });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (isUniqueConstraintError(error)) {
        throw new ApiError(409, "aggregate_service_conflict", "聚合服务地址或成员关系已经存在");
      }
      throw error;
    }

    return this.getById(aggregateServiceId, input.userId);
  }

  /** 修改聚合服务名称、地址、来源成员和协议行为；协议类型创建后不可切换。 */
  public async update(
    aggregateServiceId: string,
    input: UpdateAggregateServiceInput,
  ): Promise<{ aggregateService: AggregateServiceRecord; membersChanged: boolean }> {
    const current = await this.getById(aggregateServiceId, input.userId);
    const displayName = input.displayName === undefined ? current.displayName : validateDisplayName(input.displayName);
    const pathSuffix = input.pathSuffix === undefined
      ? { value: current.pathSuffix, lookup: current.pathSuffix.toLowerCase() }
      : validatePathSuffix(input.pathSuffix);
    const serviceIds = input.serviceIds === undefined
      ? current.members.map((member) => member.serviceId)
      : validateServiceIds(input.serviceIds);
    const relayPlaybackEnabled = input.relayPlaybackEnabled === undefined
      ? current.relayPlaybackEnabled
      : validateBoolean(input.relayPlaybackEnabled, "relayPlaybackEnabled");
    const downloadEnabled = input.downloadEnabled === undefined
      ? current.downloadEnabled
      : validateBoolean(input.downloadEnabled, "downloadEnabled");
    const regionLibrariesEnabled = input.regionLibrariesEnabled === undefined
      ? current.regionLibrariesEnabled
      : validateBoolean(input.regionLibrariesEnabled, "regionLibrariesEnabled");
    const previousIds = current.members.map((member) => member.serviceId);
    const membersChanged = previousIds.length !== serviceIds.length
      || previousIds.some((serviceId, index) => serviceIds[index] !== serviceId);
    const now = new Date().toISOString();

    try {
      await this.database.query.transaction(async (transaction) => {
        const sourceRows = await transaction("cloud_services as s")
          .innerJoin("media_libraries as l", "l.service_id", "s.id")
          .select("s.id as service_id", "s.library_id", "s.data_type", "l.catalog_version")
          .where("s.user_id", input.userId)
          .whereNull("s.deleted_at")
          .whereIn("s.id", serviceIds);
        if (sourceRows.length !== serviceIds.length) {
          throw new ApiError(404, "aggregate_source_service_not_found", "部分聚合来源服务不存在或不属于当前账号");
        }
        if (sourceRows.some((row) => String(row.data_type) !== "video")) {
          throw new ApiError(422, "aggregate_video_service_required", "Jellyfin 和 Emby 只能聚合影视类服务");
        }

        const conflict = await transaction("aggregate_services")
          .select("id")
          .where({ protocol: current.protocol, path_suffix_lookup: pathSuffix.lookup })
          .whereNot({ id: aggregateServiceId })
          .whereNull("deleted_at")
          .first();
        const legacySuffixColumn = current.protocol === "jellyfin"
          ? "jellyfin_path_suffix_lookup"
          : "emby_path_suffix_lookup";
        const legacyConflict = await transaction("media_libraries")
          .select("id")
          .where(legacySuffixColumn, pathSuffix.lookup)
          .first();
        if (conflict || legacyConflict) {
          throw new ApiError(409, "aggregate_path_suffix_conflict", `该 ${current.protocol === "jellyfin" ? "Jellyfin" : "Emby"} 地址后缀已被使用`);
        }

        await transaction("aggregate_services").where({ id: aggregateServiceId, user_id: input.userId }).update({
          display_name: displayName,
          path_suffix: pathSuffix.value,
          path_suffix_lookup: pathSuffix.lookup,
          relay_playback_enabled: relayPlaybackEnabled ? 1 : 0,
          download_enabled: downloadEnabled ? 1 : 0,
          region_libraries_enabled: regionLibrariesEnabled ? 1 : 0,
          status: membersChanged ? "draft" : current.status,
          updated_at: now,
        });

        if (membersChanged) {
          await transaction("aggregate_service_members").where({ aggregate_service_id: aggregateServiceId }).delete();
          const rowsByServiceId = new Map(sourceRows.map((row) => [String(row.service_id), row]));
          await transaction("aggregate_service_members").insert(serviceIds.map((serviceId, priority) => {
            const source = rowsByServiceId.get(serviceId)!;
            return {
              id: randomUUID(), aggregate_service_id: aggregateServiceId, user_id: input.userId,
              service_id: serviceId, library_id: String(source.library_id), priority, enabled: 1,
              last_catalog_version: Number(source.catalog_version ?? 0), created_at: now, updated_at: now,
            };
          }));
        }
      });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (isUniqueConstraintError(error)) throw new ApiError(409, "aggregate_service_conflict", "聚合服务地址或成员关系已经存在");
      throw error;
    }

    return { aggregateService: await this.getById(aggregateServiceId, input.userId), membersChanged };
  }

  /** 批量读取聚合服务成员和成员条目数，列表查询不会按卡片数量产生 N+1。 */
  private async mapAggregateServices(rows: Array<Record<string, unknown>>): Promise<AggregateServiceRecord[]> {
    if (rows.length === 0) return [];
    const aggregateServiceIds = rows.map((row) => String(row.id));
    const [memberRows, indexJobRows, aggregateCountRows] = await Promise.all([
      this.database.query("aggregate_service_members as m")
        .innerJoin("cloud_services as s", "s.id", "m.service_id")
        .innerJoin("media_libraries as l", "l.id", "m.library_id")
        .select(
          "m.id",
          "m.aggregate_service_id",
          "m.service_id",
          "m.library_id",
          "m.priority",
          "m.enabled",
          "m.last_catalog_version",
          "s.display_name",
          "s.provider_type",
          "s.status",
          "l.catalog_version",
        )
        .whereIn("m.aggregate_service_id", aggregateServiceIds)
        .orderBy([{ column: "m.aggregate_service_id", order: "asc" }, { column: "m.priority", order: "asc" }]),
      this.database.query("aggregate_index_jobs")
        .select(
          "id", "aggregate_service_id", "status", "processed_count", "total_count",
          "error_code", "error_message", "created_at", "started_at", "finished_at",
        )
        .whereIn("aggregate_service_id", aggregateServiceIds)
        .orderBy("created_at", "desc"),
      this.database.query("aggregate_media_items")
        .select("aggregate_service_id")
        .count({ item_count: "id" })
        .whereIn("aggregate_service_id", aggregateServiceIds)
        .whereNull("deleted_at")
        .groupBy("aggregate_service_id"),
    ]);
    const libraryIds = memberRows.map((member) => String(member.library_id));
    const countRows: Array<{ library_id: string; item_count?: string | number }> = libraryIds.length > 0
      ? await this.database.query("media_items")
        .select("library_id")
        .count({ item_count: "id" })
        .whereIn("library_id", libraryIds)
        .whereNull("deleted_at")
        .groupBy("library_id")
      : [];
    // 关键变量：一次分组统计全部聚合服务的成员条目数量，避免列表页慢查询。
    const itemCounts = new Map(countRows.map((countRow) => [
      String(countRow.library_id),
      Number(countRow.item_count ?? 0),
    ]));
    const membersByAggregateServiceId = new Map<string, Array<Record<string, unknown>>>();
    memberRows.forEach((member) => {
      const aggregateServiceId = String(member.aggregate_service_id);
      const members = membersByAggregateServiceId.get(aggregateServiceId) ?? [];
      members.push(member);
      membersByAggregateServiceId.set(aggregateServiceId, members);
    });
    const latestJobByAggregateServiceId = new Map<string, Record<string, unknown>>();
    indexJobRows.forEach((job) => {
      const aggregateServiceId = String(job.aggregate_service_id);
      if (!latestJobByAggregateServiceId.has(aggregateServiceId)) {
        latestJobByAggregateServiceId.set(aggregateServiceId, job);
      }
    });
    const aggregateItemCountRows = aggregateCountRows as Array<{ aggregate_service_id: string; item_count?: string | number }>;
    const aggregateItemCounts = new Map(aggregateItemCountRows.map((countRow) => [
      String(countRow.aggregate_service_id),
      Number(countRow.item_count ?? 0),
    ]));

    return rows.map((row) => this.mapAggregateServiceRow(
      row,
      membersByAggregateServiceId.get(String(row.id)) ?? [],
      itemCounts,
      latestJobByAggregateServiceId.get(String(row.id)) ?? null,
      aggregateItemCounts.get(String(row.id)) ?? 0,
    ));
  }

  /** 把一条聚合服务和已批量读取的成员映射为公开结构。 */
  private mapAggregateServiceRow(
    row: Record<string, unknown>,
    memberRows: Array<Record<string, unknown>>,
    itemCounts: Map<string, number>,
    latestIndexJob: Record<string, unknown> | null,
    aggregateItemCount: number,
  ): AggregateServiceRecord {
    const protocol = String(row.protocol) as AggregateProtocol;
    return {
      id: String(row.id),
      userId: String(row.user_id),
      displayName: String(row.display_name),
      protocol,
      pathSuffix: String(row.path_suffix),
      // 返回人类可读地址；浏览器请求时会自行对非 ASCII 后缀编码。
      path: `${protocol === "jellyfin" ? "/j/" : "/e/"}${String(row.path_suffix)}`,
      status: String(row.status) as AggregateServiceStatus,
      catalogVersion: Number(row.catalog_version ?? 0),
      itemCount: aggregateItemCount,
      relayPlaybackEnabled: Number(row.relay_playback_enabled ?? 0) === 1,
      downloadEnabled: Number(row.download_enabled ?? 1) === 1,
      regionLibrariesEnabled: Number(row.region_libraries_enabled ?? 0) === 1,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      members: memberRows.map((member) => ({
        id: String(member.id),
        serviceId: String(member.service_id),
        libraryId: String(member.library_id),
        displayName: String(member.display_name),
        providerType: String(member.provider_type),
        status: String(member.status),
        priority: Number(member.priority),
        enabled: Number(member.enabled) === 1,
        itemCount: itemCounts.get(String(member.library_id)) ?? 0,
        catalogVersion: Number(member.catalog_version ?? 0),
        lastCatalogVersion: Number(member.last_catalog_version ?? 0),
      })),
      latestIndexJob: latestIndexJob ? {
        id: String(latestIndexJob.id),
        status: String(latestIndexJob.status),
        processedCount: Number(latestIndexJob.processed_count ?? 0),
        totalCount: Number(latestIndexJob.total_count ?? 0),
        errorCode: latestIndexJob.error_code ? String(latestIndexJob.error_code) : null,
        errorMessage: latestIndexJob.error_message ? String(latestIndexJob.error_message) : null,
        createdAt: String(latestIndexJob.created_at),
        startedAt: latestIndexJob.started_at ? String(latestIndexJob.started_at) : null,
        finishedAt: latestIndexJob.finished_at ? String(latestIndexJob.finished_at) : null,
      } : null,
    };
  }
}
