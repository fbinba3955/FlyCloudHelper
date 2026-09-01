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

interface AggregateBuildResult {
  groups: AggregateItemGroup[];
  /** 关键变量：构建读取来源数据前的目录版本，用于判断构建期间是否又发生变化。 */
  memberCatalogVersions: Array<{ memberId: string; catalogVersion: number }>;
}

export interface SourceCatalogChangeInput {
  userId: string;
  serviceId: string;
  libraryId: string;
  scanJobId: string;
  previousCatalogVersion: number;
  catalogVersion: number;
}

const EPISODE_RELATION_QUERY_BATCH_SIZE = 1_000;

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

/** 从数据库异常中提取真正原因，避免超长 SQL 参数列表占满任务错误字段。 */
function formatAggregateIndexError(error: unknown): string {
  if (!(error instanceof Error)) return "聚合目录索引失败";
  const rawMessage = error.message.trim();
  // 关键变量：Knex 通常以“SQL - 数据库错误”返回异常，最后一段才是需要展示的失败原因。
  const separatorIndex = rawMessage.lastIndexOf(" - ");
  const databaseMessage = separatorIndex >= 0
    ? rawMessage.slice(separatorIndex + 3).trim()
    : rawMessage;
  const errorCode = String((error as Error & { code?: string }).code ?? "").trim();
  return `${errorCode ? `[${errorCode}] ` : ""}${databaseMessage || "聚合目录索引失败"}`.slice(0, 2_000);
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
  // 关键变量：同一进程内合并同一聚合服务的并发入队请求，避免多个来源同时扫描完成时重复建任务。
  private readonly enqueueOperations = new Map<string, Promise<string>>();

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
    const pendingOperation = this.enqueueOperations.get(aggregateServiceId);
    if (pendingOperation) return pendingOperation;
    const enqueueOperation = this.enqueueOnce(aggregateServiceId, userId, jobType);
    this.enqueueOperations.set(aggregateServiceId, enqueueOperation);
    try {
      return await enqueueOperation;
    } finally {
      if (this.enqueueOperations.get(aggregateServiceId) === enqueueOperation) {
        this.enqueueOperations.delete(aggregateServiceId);
      }
    }
  }

  /** 在单个聚合服务的串行入队窗口中复用活动任务或新建任务。 */
  private async enqueueOnce(aggregateServiceId: string, userId: string, jobType: "initial" | "rebuild" | "incremental"): Promise<string> {
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

  /** 来源扫描确实推进目录版本后，为包含该来源且尚未同步的聚合服务排队。 */
  public async enqueueForSourceCatalogChange(input: SourceCatalogChangeInput): Promise<number> {
    if (input.catalogVersion <= input.previousCatalogVersion) return 0;
    const rows = await this.database.query("aggregate_service_members as member")
      .innerJoin("aggregate_services as aggregate_service", "aggregate_service.id", "member.aggregate_service_id")
      .select("aggregate_service.id", "aggregate_service.user_id", "aggregate_service.display_name")
      .where({
        "member.service_id": input.serviceId,
        "member.library_id": input.libraryId,
        "member.enabled": 1,
        "aggregate_service.user_id": input.userId,
      })
      .whereNull("aggregate_service.deleted_at")
      .whereNot("aggregate_service.status", "disabled")
      .where("member.last_catalog_version", "<", input.catalogVersion);

    // 关键变量：一个来源在同一聚合服务中只有一个成员，但仍按服务 ID 去重，兼容历史脏数据。
    const aggregateServices = [...new Map(rows.map((row) => [String(row.id), row])).values()];
    for (const aggregateService of aggregateServices) {
      const indexJobId = await this.enqueue(String(aggregateService.id), String(aggregateService.user_id), "incremental");
      this.log("info", {
        日志关键字: "codex-aggregate-index",
        事件: "来源扫描变化自动触发聚合索引",
        扫描任务ID: input.scanJobId,
        来源服务ID: input.serviceId,
        来源媒体库ID: input.libraryId,
        扫描前目录版本: input.previousCatalogVersion,
        扫描后目录版本: input.catalogVersion,
        聚合服务ID: String(aggregateService.id),
        聚合服务名称: String(aggregateService.display_name),
        聚合索引任务ID: indexJobId,
      });
    }
    return aggregateServices.length;
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
      const buildResult = await this.buildGroups(aggregateServiceId, jobId);
      await this.persistGroups(
        aggregateServiceId,
        jobId,
        buildResult.groups,
        buildResult.memberCatalogVersions,
      );
      const finishedAt = new Date().toISOString();
      this.log("info", {
        日志关键字: "codex-aggregate-index",
        事件: "聚合目录索引完成",
        聚合服务ID: aggregateServiceId,
        索引任务ID: jobId,
        聚合条目数量: buildResult.groups.length,
        耗时毫秒: Date.now() - startedMs,
      });
      await this.database.query("aggregate_index_jobs").where({ id: jobId }).update({
        status: "completed",
        finished_at: finishedAt,
        updated_at: finishedAt,
      });
      await this.enqueueFollowUpForOutdatedMembers(aggregateServiceId, jobId);
    } catch (error) {
      const finishedAt = new Date().toISOString();
      const errorMessage = formatAggregateIndexError(error);
      await this.database.query.transaction(async (transaction) => {
        await transaction("aggregate_index_jobs").where({ id: jobId }).update({
          status: "failed",
          error_code: "aggregate_index_failed",
          error_message: errorMessage,
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

  /** 构建期间来源目录再次变化时追加一轮任务，避免复用运行中任务后遗漏最新变化。 */
  private async enqueueFollowUpForOutdatedMembers(aggregateServiceId: string, completedJobId: string): Promise<void> {
    try {
      const service = await this.database.query("aggregate_services")
        .select("id", "user_id")
        .where({ id: aggregateServiceId })
        .whereNull("deleted_at")
        .first();
      if (!service) return;
      const outdatedMember = await this.database.query("aggregate_service_members as member")
        .innerJoin("media_libraries as library", "library.id", "member.library_id")
        .select("member.id", "member.last_catalog_version", "library.catalog_version")
        .where({ "member.aggregate_service_id": aggregateServiceId, "member.enabled": 1 })
        .whereRaw("?? > ??", ["library.catalog_version", "member.last_catalog_version"])
        .first();
      if (!outdatedMember) return;
      const followUpJobId = await this.enqueue(aggregateServiceId, String(service.user_id), "incremental");
      this.log("info", {
        日志关键字: "codex-aggregate-index",
        事件: "构建期间来源变化追加聚合索引",
        聚合服务ID: aggregateServiceId,
        已完成索引任务ID: completedJobId,
        后续索引任务ID: followUpJobId,
        来源构建版本: Number(outdatedMember.last_catalog_version ?? 0),
        来源最新版本: Number(outdatedMember.catalog_version ?? 0),
      });
    } catch (error) {
      this.log("warn", {
        日志关键字: "codex-aggregate-index",
        事件: "检查聚合构建期间来源变化失败",
        聚合服务ID: aggregateServiceId,
        已完成索引任务ID: completedJobId,
        错误信息: formatAggregateIndexError(error),
      });
    }
  }

  /** 读取成员目录并按可靠外部 ID 归并电影、节目和单集。 */
  private async buildGroups(aggregateServiceId: string, jobId: string): Promise<AggregateBuildResult> {
    const memberRows = await this.database.query("aggregate_service_members as member")
      .innerJoin("media_libraries as library", "library.id", "member.library_id")
      .select("member.id", "member.service_id", "member.library_id", "member.priority", "library.catalog_version")
      .where({ "member.aggregate_service_id": aggregateServiceId, "member.enabled": 1 })
      .orderBy("member.priority", "asc");
    const memberCatalogVersions = memberRows.map((member) => ({
      memberId: String(member.id),
      catalogVersion: Number(member.catalog_version ?? 0),
    }));
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
    const episodeIds = episodes.map((item) => item.id);
    const parentRelations: Array<Record<string, unknown>> = [];
    if (episodeIds.length > 0) {
      const relationBatchCount = Math.ceil(episodeIds.length / EPISODE_RELATION_QUERY_BATCH_SIZE);
      this.log("info", {
        日志关键字: "codex-aggregate-index",
        事件: "分批读取聚合单集父子关系",
        聚合服务ID: aggregateServiceId,
        索引任务ID: jobId,
        单集数量: episodeIds.length,
        每批数量: EPISODE_RELATION_QUERY_BATCH_SIZE,
        查询批次数: relationBatchCount,
      });
      for (let index = 0; index < episodeIds.length; index += EPISODE_RELATION_QUERY_BATCH_SIZE) {
        const relationRows = await this.database.query("media_relations")
          .select("parent_item_id", "child_item_id")
          .whereIn("child_item_id", episodeIds.slice(index, index + EPISODE_RELATION_QUERY_BATCH_SIZE));
        parentRelations.push(...relationRows);
      }
    }
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
    return { groups, memberCatalogVersions };
  }

  /** 事务内原子替换索引，客户端不会看到半套聚合目录。 */
  private async persistGroups(
    aggregateServiceId: string,
    jobId: string,
    groups: AggregateItemGroup[],
    memberCatalogVersions: Array<{ memberId: string; catalogVersion: number }>,
  ): Promise<void> {
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

      // 只能保存构建开始时的来源版本，不能把构建过程中出现的新版本误标为已同步。
      for (const memberVersion of memberCatalogVersions) {
        await transaction("aggregate_service_members").where({ id: memberVersion.memberId }).update({
          last_catalog_version: memberVersion.catalogVersion,
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
