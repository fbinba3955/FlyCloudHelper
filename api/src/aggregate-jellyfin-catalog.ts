import type { MediaItemRecord } from "./domain.js";
import type { VideoRegionGroup } from "./domain.js";
import type { Knex } from "knex";
import { ApiError } from "./errors.js";
import type { ApiRuntime } from "./runtime.js";

/** 聚合索引使用的稳定内部媒体条目 ID。 */
const AGGREGATE_ITEM_ID_PATTERN = /^aggitm_([0-9a-f]{32})$/iu;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** 聚合目录中一个条目对应的来源媒体版本。 */
export interface AggregateJellyfinMemberItem {
  sourceItem: MediaItemRecord;
  sourceServiceId: string;
  sourceLibraryId: string;
  metadataRank: number;
}

/** 聚合目录中供 Jellyfin 展示的一条媒体记录。 */
export interface AggregateJellyfinItem {
  aggregateItemId: string;
  aggregateServiceId: string;
  itemType: string;
  parentAggregateItemId: string | null;
  sortTitle: string;
  year: number | null;
  premiereDate: string | null;
  createdAt: string;
  updatedAt: string;
  /** 成员优先级最高的条目决定标题、海报、简介等主元数据。 */
  primaryItem: MediaItemRecord;
  members: AggregateJellyfinMemberItem[];
}

/** 聚合播放时保留来源服务归属的文件记录。 */
export interface AggregateJellyfinFile {
  itemId: string;
  fileId: string;
  resourceId: string;
  path: string;
  name: string;
  size: number;
  mediaProbeStatus: unknown;
  mediaProbeResult: unknown;
  playbackLocator: Record<string, unknown>;
  sourceServiceId: string;
  sourceLibraryId: string;
  sourceItemId: string;
}

/** 把 32 位十六进制文本转换为 Jellyfin 可接受的 UUID。 */
function formatProtocolUuid(hexValue: string): string {
  const hex = hexValue.toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** 将聚合索引 ID 映射为可逆的 Jellyfin 条目 UUID。 */
export function encodeAggregateJellyfinItemId(aggregateItemId: string): string {
  const match = AGGREGATE_ITEM_ID_PATTERN.exec(aggregateItemId);
  return match?.[1] ? formatProtocolUuid(match[1]) : aggregateItemId;
}

/** 在聚合 Jellyfin 地址下把 UUID 还原为聚合索引 ID。 */
export function decodeAggregateJellyfinItemId(protocolItemId: string): string {
  const rawValue = protocolItemId.trim().toLowerCase();
  if (AGGREGATE_ITEM_ID_PATTERN.test(rawValue)) return rawValue;
  if (!UUID_PATTERN.test(rawValue)) return protocolItemId;
  return `aggitm_${rawValue.replace(/-/gu, "")}`;
}

/** 聚合索引的 Jellyfin 读取适配器；只读取索引和来源媒体库，不改变原单服务目录查询。 */
export class AggregateJellyfinCatalog {
  public constructor(private readonly runtime: ApiRuntime) {}

  /** 读取聚合顶层媒体，支持电影、节目、关键词、排序和分页。 */
  public async listTopLevel(input: {
    aggregateServiceId: string;
    ownerUserId: string;
    itemTypes: string[];
    search?: string;
    /** 分类筛选以聚合主元数据为准，保持一部影片只计入一次。 */
    genres?: string[];
    /** 节目地区媒体库按主元数据来源的地区归属筛选。 */
    regionGroup?: VideoRegionGroup;
    sort: "created_desc" | "created_asc" | "updated_desc" | "updated_asc" | "year_desc" | "year_asc" | "premiere_date_desc" | "premiere_date_asc" | "title_asc" | "title_desc";
    limit: number;
    offset: number;
  }): Promise<{ items: AggregateJellyfinItem[]; total: number }> {
    const query = this.runtime.database.query("aggregate_media_items as aggregate_item")
      .where({ "aggregate_item.aggregate_service_id": input.aggregateServiceId, "aggregate_item.status": "active" })
      .whereNull("aggregate_item.deleted_at")
      .whereNull("aggregate_item.parent_aggregate_item_id");
    if (input.itemTypes.length > 0) query.whereIn("aggregate_item.item_type", input.itemTypes);
    if (input.search?.trim()) query.whereLike("aggregate_item.sort_title", `%${input.search.trim()}%`);
    // 分类与地区字段都来自主元数据条目，只连接一次避免 count 和分页产生重复行。
    if ((input.genres && input.genres.length > 0) || input.regionGroup) {
      query.join("media_items as primary_item", "primary_item.id", "aggregate_item.primary_member_item_id");
    }
    if (input.regionGroup) query.where("primary_item.region_group", input.regionGroup);
    if (input.genres && input.genres.length > 0) {
      query.where((builder) => {
        input.genres?.forEach((genre) => builder.orWhereLike("primary_item.metadata_json", `%${genre}%`));
      });
    }
    const countRow = await query.clone().count<{ count: string | number }[]>({ count: "aggregate_item.id" }).first();
    this.applySort(query, input.sort);
    const rows = await query.select("aggregate_item.*").limit(input.limit).offset(input.offset);
    return {
      items: await this.hydrateItems(rows, input.ownerUserId),
      total: Number(countRow?.count ?? 0),
    };
  }

  /** 读取一个节目下的聚合单集，并按季和集排序。 */
  public async listEpisodes(
    aggregateServiceId: string,
    ownerUserId: string,
    parentAggregateItemId: string,
  ): Promise<AggregateJellyfinItem[]> {
    const rows = await this.runtime.database.query("aggregate_media_items")
      .select("*")
      .where({ aggregate_service_id: aggregateServiceId, parent_aggregate_item_id: parentAggregateItemId, item_type: "video.episode", status: "active" })
      .whereNull("deleted_at")
      .orderBy("sort_title", "asc");
    const items = await this.hydrateItems(rows, ownerUserId);
    return items.sort((left, right) => this.readSeasonNumber(left.primaryItem) - this.readSeasonNumber(right.primaryItem)
      || this.readEpisodeNumber(left.primaryItem) - this.readEpisodeNumber(right.primaryItem)
      || left.aggregateItemId.localeCompare(right.aggregateItemId));
  }

  /** 按聚合 ID 读取一个条目，索引不存在或来源已清理时返回稳定的 404。 */
  public async getItem(
    aggregateServiceId: string,
    ownerUserId: string,
    aggregateItemId: string,
  ): Promise<AggregateJellyfinItem> {
    const row = await this.runtime.database.query("aggregate_media_items")
      .where({ id: aggregateItemId, aggregate_service_id: aggregateServiceId, status: "active" })
      .whereNull("deleted_at")
      .first();
    if (!row) throw new ApiError(404, "aggregate_jellyfin_item_not_found", "聚合媒体条目不存在或索引尚未完成");
    const items = await this.hydrateItems([row], ownerUserId);
    if (!items[0]) throw new ApiError(404, "aggregate_jellyfin_item_source_missing", "聚合媒体条目的来源已不存在，请重新构建聚合服务");
    return items[0];
  }

  /** 批量读取聚合条目，保持调用方传入 ID 的顺序。 */
  public async getItems(
    aggregateServiceId: string,
    ownerUserId: string,
    aggregateItemIds: string[],
  ): Promise<AggregateJellyfinItem[]> {
    const uniqueIds = [...new Set(aggregateItemIds.filter(Boolean))];
    if (uniqueIds.length === 0) return [];
    const rows = await this.runtime.database.query("aggregate_media_items")
      .where({ aggregate_service_id: aggregateServiceId, status: "active" })
      .whereIn("id", uniqueIds)
      .whereNull("deleted_at");
    const mapped = new Map((await this.hydrateItems(rows, ownerUserId)).map((item) => [item.aggregateItemId, item]));
    return uniqueIds.map((itemId) => mapped.get(itemId)).filter((item): item is AggregateJellyfinItem => Boolean(item));
  }

  /** 读取聚合条目下全部来源文件；同片多服务版本会同时保留。 */
  public async listFiles(item: AggregateJellyfinItem): Promise<AggregateJellyfinFile[]> {
    const filesByItemId = await this.listFilesForItems([item]);
    return filesByItemId.get(item.aggregateItemId) ?? [];
  }

  /** 批量读取聚合条目的来源文件，避免 Jellyfin 列表逐卡片查询文件表。 */
  public async listFilesForItems(items: AggregateJellyfinItem[]): Promise<Map<string, AggregateJellyfinFile[]>> {
    const filesByItemId = new Map(items.map((item) => [item.aggregateItemId, [] as AggregateJellyfinFile[]]));
    const aggregateItemIds = items.map((item) => item.aggregateItemId);
    if (aggregateItemIds.length === 0) return filesByItemId;
    const rows = await this.runtime.database.query("aggregate_media_item_members as member")
      .join("file_links as link", function joinFileLink() {
        this.on("link.item_id", "=", "member.media_item_id");
      })
      .join("source_files as source_file", "source_file.id", "link.source_file_id")
      .leftJoin("media_file_probes as probe", "probe.source_file_id", "source_file.id")
      .select(
        "member.aggregate_item_id", "member.service_id", "member.library_id", "member.media_item_id", "member.metadata_rank",
        "source_file.id as file_id", "source_file.provider_resource_id", "source_file.path", "source_file.name", "source_file.size",
        "source_file.locator_json as source_locator_json", "link.locator_json as link_locator_json",
        "probe.status as media_probe_status", "probe.result_json as media_probe_result",
      )
      .whereIn("member.aggregate_item_id", aggregateItemIds)
      .where({ "source_file.status": "active" })
      .orderBy("member.metadata_rank", "asc")
      .orderBy("source_file.path", "asc");
    rows.forEach((row) => {
      const aggregateItemId = String(row.aggregate_item_id);
      const target = filesByItemId.get(aggregateItemId);
      if (!target) return;
      target.push({
        itemId: aggregateItemId,
        fileId: String(row.file_id),
        resourceId: String(row.provider_resource_id),
        path: String(row.path),
        name: String(row.name),
        size: Number(row.size ?? 0),
        mediaProbeStatus: row.media_probe_status,
        mediaProbeResult: row.media_probe_result,
        playbackLocator: {
          ...this.parseJsonObject(row.link_locator_json),
          ...this.parseJsonObject(row.source_locator_json),
        },
        sourceServiceId: String(row.service_id),
        sourceLibraryId: String(row.library_id),
        sourceItemId: String(row.media_item_id),
      });
    });
    return filesByItemId;
  }

  /** 根据协议层排序参数排序聚合索引，追加稳定 ID 防止分页重复。 */
  private applySort(query: Knex.QueryBuilder, sort: string): void {
    if (sort === "title_asc" || sort === "title_desc") {
      query.orderBy("aggregate_item.sort_title", sort === "title_asc" ? "asc" : "desc").orderBy("aggregate_item.id", "asc");
      return;
    }
    if (sort === "year_asc" || sort === "year_desc") {
      query.orderByRaw(`?? IS NULL ASC, ?? ${sort === "year_asc" ? "ASC" : "DESC"}, ?? ASC`, ["aggregate_item.year", "aggregate_item.year", "aggregate_item.id"]);
      return;
    }
    if (sort === "premiere_date_asc" || sort === "premiere_date_desc") {
      query.orderByRaw(`?? IS NULL ASC, ?? ${sort === "premiere_date_asc" ? "ASC" : "DESC"}, ?? ASC`, ["aggregate_item.premiere_date", "aggregate_item.premiere_date", "aggregate_item.id"]);
      return;
    }
    if (sort === "updated_asc" || sort === "updated_desc") {
      query.orderBy("aggregate_item.updated_at", sort === "updated_asc" ? "asc" : "desc").orderBy("aggregate_item.id", "asc");
      return;
    }
    query.orderBy("aggregate_item.created_at", sort === "created_asc" ? "asc" : "desc").orderBy("aggregate_item.id", "asc");
  }

  /** 使用索引主条目和成员映射装配协议层可读取的数据。 */
  private async hydrateItems(rows: Array<Record<string, unknown>>, ownerUserId: string): Promise<AggregateJellyfinItem[]> {
    const primaryIds = rows.map((row) => String(row.primary_member_item_id ?? "")).filter(Boolean);
    const allMemberRows = rows.length === 0 ? [] : await this.runtime.database.query("aggregate_media_item_members")
      .select("aggregate_item_id", "media_item_id", "service_id", "library_id", "metadata_rank")
      .whereIn("aggregate_item_id", rows.map((row) => String(row.id)))
      .orderBy("metadata_rank", "asc")
      .orderBy("id", "asc");
    const sourceIds = [...new Set([...primaryIds, ...allMemberRows.map((row) => String(row.media_item_id))])];
    const sourceItems = await this.runtime.repository.listCatalogItemsByIds(sourceIds, ownerUserId);
    const sourceItemById = new Map(sourceItems.map((item) => [item.id, item]));
    const memberRowsByAggregateId = new Map<string, Array<Record<string, unknown>>>();
    allMemberRows.forEach((memberRow) => {
      const aggregateItemId = String(memberRow.aggregate_item_id);
      const group = memberRowsByAggregateId.get(aggregateItemId) ?? [];
      group.push(memberRow);
      memberRowsByAggregateId.set(aggregateItemId, group);
    });
    return rows.flatMap((row) => {
      const aggregateItemId = String(row.id);
      const memberRows = memberRowsByAggregateId.get(aggregateItemId) ?? [];
      const members = memberRows.flatMap((memberRow) => {
        const sourceItem = sourceItemById.get(String(memberRow.media_item_id));
        return sourceItem ? [{
          sourceItem,
          sourceServiceId: String(memberRow.service_id),
          sourceLibraryId: String(memberRow.library_id),
          metadataRank: Number(memberRow.metadata_rank ?? 0),
        }] : [];
      });
      const primaryItem = sourceItemById.get(String(row.primary_member_item_id ?? "")) ?? members[0]?.sourceItem;
      if (!primaryItem) return [];
      return [{
        aggregateItemId,
        aggregateServiceId: String(row.aggregate_service_id),
        itemType: String(row.item_type),
        parentAggregateItemId: row.parent_aggregate_item_id ? String(row.parent_aggregate_item_id) : null,
        sortTitle: String(row.sort_title),
        year: row.year === null || row.year === undefined ? null : Number(row.year),
        premiereDate: row.premiere_date ? String(row.premiere_date) : null,
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
        primaryItem,
        members,
      }];
    });
  }

  /** 读取节目元数据中的季号，缺失时按 0 处理。 */
  private readSeasonNumber(item: MediaItemRecord): number {
    const value = Number(item.metadata.seasonNumber ?? 0);
    return Number.isFinite(value) ? value : 0;
  }

  /** 读取节目元数据中的集号，缺失时按 0 处理。 */
  private readEpisodeNumber(item: MediaItemRecord): number {
    const value = Number(item.metadata.episodeNumber ?? 0);
    return Number.isFinite(value) ? value : 0;
  }

  /** 安全解析来源定位 JSON，旧数据异常时返回空对象避免中断整页目录。 */
  private parseJsonObject(value: unknown): Record<string, unknown> {
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
}
