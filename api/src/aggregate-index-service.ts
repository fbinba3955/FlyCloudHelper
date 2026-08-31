import { createHash, randomUUID } from "node:crypto";
import type { Knex } from "knex";
import type { FlyCloudHelperDatabase } from "./database.js";

type AggregateLog = (
  level: "info" | "warn",
  fields: Record<string, string | number | boolean | null>,
) => void;

interface AggregateSourceItem {
  id: string;
  serviceId: string;
  libraryId: string;
  memberId: string;
  memberPriority: number;
  itemType: string;
  sortTitle: string;
  year: number | null;
  premiereDate: string | null;
  matchState: string;
  externalIds: Record<string, string>;
  metadata: Record<string, unknown>;
}

interface AggregateItemGroup {
  id: string;
  canonicalKey: string;
  itemType: string;
  parentAggregateItemId: string | null;
  primary: AggregateSourceItem;
  members: AggregateSourceItem[];
}

/** 安全读取数据库 JSON 字段，异常旧数据只按空对象参与索引。 */
function parseJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

/** 将外部 ID 对象转换为仅包含字符串值的字典。 */
function readExternalIds(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(parseJsonObject(value)).map(([key, item]) => [key, String(item)]));
}

/** 为聚合条目生成跨重建稳定的内部 ID。 */
function createAggregateItemId(aggregateServiceId: string, canonicalKey: string): string {
  const digest = createHash("sha256")
    .update(`flycloud-aggregate\u0000${aggregateServiceId}\u0000${canonicalKey}`, "utf8")
    .digest("hex")
    .slice(0, 32);
  return `aggitm_${digest}`;
}

/** 可靠外部 ID 缺失时保持来源隔离，不按标题猜测合并影片。 */
function createTopLevelCanonicalKey(item: AggregateSourceItem): string {
  const externalIds = item.externalIds;
  if (item.itemType === "video.movie") {
    const tmdbId = externalIds.tmdbMovie ?? externalIds.tmdb;
    if (tmdbId) return `tmdb:movie:${tmdbId}`;
    if (externalIds.imdb) return `imdb:movie:${externalIds.imdb}`;
  }
  if (item.itemType === "video.series") {
    const tmdbId = externalIds.tmdbTv ?? externalIds.tmdb;
    if (tmdbId) return `tmdb:tv:${tmdbId}`;
    if (externalIds.tvdb) return `tvdb:series:${externalIds.tvdb}`;
    if (externalIds.imdb) return `imdb:series:${externalIds.imdb}`;
  }
  return `source:${item.serviceId}:${item.id}`;
}

/** 读取合法季集编号，缺少编号的单集保持来源隔离。 */
function readEpisodeNumbers(metadata: Record<string, unknown>): { seasonNumber: number; episodeNumber: number } | null {
  const seasonNumber = Number(metadata.seasonNumber);
  const episodeNumber = Number(metadata.episodeNumber);
  if (!Number.isInteger(seasonNumber) || seasonNumber < 0) return null;
  if (!Number.isInteger(episodeNumber) || episodeNumber < 1) return null;
  return { seasonNumber, episodeNumber };
}

/** 以成员优先级和来源条目 ID 选择稳定主元数据。 */
function selectPrimaryItem(items: AggregateSourceItem[]): AggregateSourceItem {
  return [...items].sort((left, right) => left.memberPriority - right.memberPriority
    || left.id.localeCompare(right.id))[0]!;
}

/** 按固定大小批量写入，兼容 SQLite 的绑定参数上限。 */
async function insertInChunks(transaction: Knex.Transaction, table: string, rows: Array<Record<string, unknown>>, chunkSize: number): Promise<void> {
  for (let index = 0; index < rows.length; index += chunkSize) {
    await transaction(table).insert(rows.slice(index, index + chunkSize));
  }
}

/** 批量新增或更新聚合条目，重建时保留稳定 ID 与最初创建时间。 */
async function upsertAggregateItemsInChunks(
  transaction: Knex.Transaction,
  rows: Array<Record<string, unknown>>,
): Promise<void> {
  const mergeColumns = [
    "item_type", "parent_aggregate_item_id", "primary_member_item_id", "sort_title",
    "year", "premiere_date", "status", "updated_at", "deleted_at",
  ];
  for (let index = 0; index < rows.length; index += 50) {
    await transaction("aggregate_media_items")
      .insert(rows.slice(index, index + 50))
      .onConflict(["aggregate_service_id", "canonical_key"])
      .merge(mergeColumns);
  }
}

/** 后台构建聚合媒体身份和来源映射；协议层只查询此索引，不在请求内遍历成员库。 */
export class AggregateIndexService {
  private draining = false;
  private wakeRequested = false;

  public constructor(
    private readonly database: FlyCloudHelperDatabase,
    private readonly log: AggregateLog,
  ) {}

  /** 启动时恢复进程退出前尚未结束的索引任务。 */
  public async start(): Promise<void> {
    const now = new Date().toISOString();
    await this.database.query("aggregate_index_jobs")
      .where("status", "running")
      .update({ status: "queued", started_at: null, updated_at: now });
    this.kick();
  }

  /** 为一个聚合服务排队；已有排队或运行任务时复用，不重复创建。 */
  public async enqueue(aggregateServiceId: string, userId: string, jobType: "initial" | "rebuild" | "incremental" = "initial"): Promise<string> {
    const existing = await this.database.query("aggregate_index_jobs")
      .select("id")
      .where({ aggregate_service_id: aggregateServiceId })
      .whereIn("status", ["queued", "running"])
      .orderBy("created_at", "asc")
      .first();
    if (existing) return String(existing.id);

    const jobId = randomUUID();
    const now = new Date().toISOString();
    await this.database.query.transaction(async (transaction) => {
      await transaction("aggregate_index_jobs").insert({
        id: jobId,
        user_id: userId,
        aggregate_service_id: aggregateServiceId,
        job_type: jobType,
        status: "queued",
        processed_count: 0,
        total_count: 0,
        current_member_id: null,
        error_code: null,
        error_message: null,
        created_at: now,
        started_at: null,
        finished_at: null,
        updated_at: now,
      });
      await transaction("aggregate_services")
        .where({ id: aggregateServiceId, user_id: userId })
        .whereNull("deleted_at")
        .update({ status: "building", updated_at: now });
    });
    this.kick();
    return jobId;
  }

  /** 异步唤醒串行索引循环，避免同一数据库被多个全量聚合任务同时占满。 */
  private kick(): void {
    this.wakeRequested = true;
    if (this.draining) return;
    this.draining = true;
    void (async () => {
      while (this.wakeRequested) {
        this.wakeRequested = false;
        await this.drain();
      }
    })().finally(() => {
      this.draining = false;
      // finally 前又有任务到达时重新唤醒，避免极小时间窗内任务滞留。
      if (this.wakeRequested) this.kick();
    });
  }

  /** 按创建顺序执行等待任务。 */
  private async drain(): Promise<void> {
    while (true) {
      const job = await this.database.query("aggregate_index_jobs")
        .where({ status: "queued" })
        .orderBy("created_at", "asc")
        .first();
      if (!job) return;
      await this.runJob(job);
    }
  }

  /** 执行一次完整聚合索引并记录可诊断进度。 */
  private async runJob(job: Record<string, unknown>): Promise<void> {
    const jobId = String(job.id);
    const aggregateServiceId = String(job.aggregate_service_id);
    const startedAt = new Date().toISOString();
    await this.database.query("aggregate_index_jobs").where({ id: jobId, status: "queued" }).update({
      status: "running",
      started_at: startedAt,
      updated_at: startedAt,
    });
    const startedMs = Date.now();
    try {
      const itemGroups = await this.buildGroups(aggregateServiceId, jobId);
      await this.persistGroups(aggregateServiceId, jobId, itemGroups);
      const finishedAt = new Date().toISOString();
      this.log("info", {
        日志关键字: "codex-aggregate-index",
        事件: "聚合目录索引完成",
        聚合服务ID: aggregateServiceId,
        索引任务ID: jobId,
        聚合条目数量: itemGroups.length,
        耗时毫秒: Date.now() - startedMs,
      });
      await this.database.query("aggregate_index_jobs").where({ id: jobId }).update({
        status: "completed",
        finished_at: finishedAt,
        updated_at: finishedAt,
      });
    } catch (error) {
      const finishedAt = new Date().toISOString();
      const errorMessage = error instanceof Error ? error.message : "聚合目录索引失败";
      await this.database.query.transaction(async (transaction) => {
        await transaction("aggregate_index_jobs").where({ id: jobId }).update({
          status: "failed",
          error_code: "aggregate_index_failed",
          error_message: errorMessage.slice(0, 2_000),
          finished_at: finishedAt,
          updated_at: finishedAt,
        });
        await transaction("aggregate_services").where({ id: aggregateServiceId }).update({
          status: "failed",
          updated_at: finishedAt,
        });
      });
      this.log("warn", {
        日志关键字: "codex-aggregate-index",
        事件: "聚合目录索引失败",
        聚合服务ID: aggregateServiceId,
        索引任务ID: jobId,
        错误信息: errorMessage,
        耗时毫秒: Date.now() - startedMs,
      });
    }
  }

  /** 读取成员目录并按可靠外部 ID 归并电影、节目和单集。 */
  private async buildGroups(aggregateServiceId: string, jobId: string): Promise<AggregateItemGroup[]> {
    const memberRows = await this.database.query("aggregate_service_members")
      .select("id", "service_id", "library_id", "priority")
      .where({ aggregate_service_id: aggregateServiceId, enabled: 1 })
      .orderBy("priority", "asc");
    const memberByServiceId = new Map(memberRows.map((member) => [String(member.service_id), member]));
    const serviceIds = memberRows.map((member) => String(member.service_id));
    if (serviceIds.length < 2) throw new Error("聚合服务至少需要两个可用影视来源");

    const rows = await this.database.query("media_items")
      .select(
        "id", "service_id", "library_id", "item_type", "sort_title", "year", "premiere_date",
        "match_state", "external_ids_json", "metadata_json",
      )
      .whereIn("service_id", serviceIds)
      .where("media_type", "video")
      .whereIn("item_type", ["video.movie", "video.series", "video.episode"])
      .whereNull("deleted_at");
    await this.database.query("aggregate_index_jobs").where({ id: jobId }).update({
      total_count: rows.length,
      updated_at: new Date().toISOString(),
    });

    const sourceItems: AggregateSourceItem[] = rows.map((row) => {
      const member = memberByServiceId.get(String(row.service_id))!;
      return {
        id: String(row.id),
        serviceId: String(row.service_id),
        libraryId: String(row.library_id),
        memberId: String(member.id),
        memberPriority: Number(member.priority),
        itemType: String(row.item_type),
        sortTitle: String(row.sort_title),
        year: row.year === null || row.year === undefined ? null : Number(row.year),
        premiereDate: row.premiere_date ? String(row.premiere_date) : null,
        matchState: String(row.match_state),
        externalIds: readExternalIds(row.external_ids_json),
        metadata: parseJsonObject(row.metadata_json),
      };
    });

    const topItems = sourceItems.filter((item) => item.itemType !== "video.episode");
    const topGroupsByKey = new Map<string, AggregateSourceItem[]>();
    topItems.forEach((item) => {
      const canonicalKey = createTopLevelCanonicalKey(item);
      const groupItems = topGroupsByKey.get(canonicalKey) ?? [];
      groupItems.push(item);
      topGroupsByKey.set(canonicalKey, groupItems);
    });
    const groups: AggregateItemGroup[] = [];
    const aggregateIdBySourceItemId = new Map<string, string>();
    topGroupsByKey.forEach((items, canonicalKey) => {
      const id = createAggregateItemId(aggregateServiceId, canonicalKey);
      items.forEach((item) => aggregateIdBySourceItemId.set(item.id, id));
      groups.push({
        id,
        canonicalKey,
        itemType: items[0]!.itemType,
        parentAggregateItemId: null,
        primary: selectPrimaryItem(items),
        members: items,
      });
    });

    const episodes = sourceItems.filter((item) => item.itemType === "video.episode");
    const parentRelations = episodes.length > 0
      ? await this.database.query("media_relations")
        .select("parent_item_id", "child_item_id")
        .whereIn("child_item_id", episodes.map((item) => item.id))
      : [];
    const parentByChildId = new Map(parentRelations.map((relation) => [
      String(relation.child_item_id),
      String(relation.parent_item_id),
    ]));
    const episodeGroupsByKey = new Map<string, { parentAggregateItemId: string | null; items: AggregateSourceItem[] }>();
    episodes.forEach((item) => {
      const parentSourceId = parentByChildId.get(item.id) ?? "";
      const parentAggregateItemId = aggregateIdBySourceItemId.get(parentSourceId) ?? null;
      const episodeNumbers = readEpisodeNumbers(item.metadata);
      const canonicalKey = parentAggregateItemId && episodeNumbers
        ? `episode:${parentAggregateItemId}:s${episodeNumbers.seasonNumber}:e${episodeNumbers.episodeNumber}`
        : `source:${item.serviceId}:${item.id}`;
      const existing = episodeGroupsByKey.get(canonicalKey) ?? { parentAggregateItemId, items: [] };
      existing.items.push(item);
      episodeGroupsByKey.set(canonicalKey, existing);
    });
    episodeGroupsByKey.forEach((value, canonicalKey) => {
      groups.push({
        id: createAggregateItemId(aggregateServiceId, canonicalKey),
        canonicalKey,
        itemType: "video.episode",
        parentAggregateItemId: value.parentAggregateItemId,
        primary: selectPrimaryItem(value.items),
        members: value.items,
      });
    });
    return groups;
  }

  /** 事务内原子替换索引，客户端不会看到半套聚合目录。 */
  private async persistGroups(aggregateServiceId: string, jobId: string, groups: AggregateItemGroup[]): Promise<void> {
    const now = new Date().toISOString();
    await this.database.query.transaction(async (transaction) => {
      await transaction("aggregate_media_item_members").where({ aggregate_service_id: aggregateServiceId }).delete();
      // 先软删除旧索引，再由本次存在的条目恢复；不能物理删除稳定 ID 和未来协议用户状态。
      await transaction("aggregate_media_items").where({ aggregate_service_id: aggregateServiceId }).update({
        status: "deleted",
        deleted_at: now,
        updated_at: now,
      });

      const topGroups = groups.filter((group) => group.parentAggregateItemId === null);
      const childGroups = groups.filter((group) => group.parentAggregateItemId !== null);
      const mapAggregateRows = (targetGroups: AggregateItemGroup[]): Array<Record<string, unknown>> => targetGroups.map((group) => ({
        id: group.id,
        aggregate_service_id: aggregateServiceId,
        canonical_key: group.canonicalKey,
        item_type: group.itemType,
        parent_aggregate_item_id: group.parentAggregateItemId,
        primary_member_item_id: group.primary.id,
        sort_title: group.primary.sortTitle.slice(0, 512),
        year: group.primary.year,
        premiere_date: group.primary.premiereDate,
        status: "active",
        created_at: now,
        updated_at: now,
        deleted_at: null,
      }));
      await upsertAggregateItemsInChunks(transaction, mapAggregateRows(topGroups));
      await upsertAggregateItemsInChunks(transaction, mapAggregateRows(childGroups));

      const memberMappings = groups.flatMap((group) => group.members.map((member) => ({
        id: randomUUID(),
        aggregate_service_id: aggregateServiceId,
        aggregate_item_id: group.id,
        member_id: member.memberId,
        service_id: member.serviceId,
        library_id: member.libraryId,
        media_item_id: member.id,
        metadata_rank: member.memberPriority,
        created_at: now,
        updated_at: now,
      })));
      await insertInChunks(transaction, "aggregate_media_item_members", memberMappings, 60);

      const memberVersions = await transaction("aggregate_service_members as member")
        .innerJoin("media_libraries as library", "library.id", "member.library_id")
        .select("member.id", "library.catalog_version")
        .where("member.aggregate_service_id", aggregateServiceId);
      // 成员数量通常很小，逐成员更新游标可同时兼容 SQLite、PostgreSQL 和 MySQL。
      for (const memberVersion of memberVersions) {
        await transaction("aggregate_service_members").where({ id: memberVersion.id }).update({
          last_catalog_version: Number(memberVersion.catalog_version ?? 0),
          updated_at: now,
        });
      }
      const aggregateService = await transaction("aggregate_services")
        .select("catalog_version")
        .where({ id: aggregateServiceId })
        .first();
      await transaction("aggregate_services").where({ id: aggregateServiceId }).update({
        status: "active",
        catalog_version: Number(aggregateService?.catalog_version ?? 0) + 1,
        last_indexed_at: now,
        updated_at: now,
      });
      const indexJob = await transaction("aggregate_index_jobs").select("total_count").where({ id: jobId }).first();
      await transaction("aggregate_index_jobs").where({ id: jobId }).update({
        processed_count: Number(indexJob?.total_count ?? 0),
        updated_at: now,
      });
    });
  }
}
