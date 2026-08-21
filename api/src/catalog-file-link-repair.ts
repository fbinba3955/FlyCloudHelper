import type { Knex } from "knex";

/** 单次媒体库文件归属修复结果。 */
export interface CatalogFileLinkRepairResult {
  libraryId: string;
  duplicateSourceFileCount: number;
  removedFileLinkCount: number;
  deletedLeafItemCount: number;
  deletedParentItemCount: number;
  catalogVersion: number;
}

interface DuplicateFileLinkRow {
  link_id: string;
  source_file_id: string;
  item_id: string;
  item_type: string;
  metadata_json: string;
  item_created_at: string;
  item_updated_at: string;
  item_deleted_at: string | null;
}

const REPAIR_BATCH_SIZE = 500;
const LEAF_ITEM_TYPES = ["video.movie", "video.episode", "music.track", "audiobook.chapter"];
const PARENT_ITEM_TYPES = ["video.series", "music.album", "audiobook.book"];

/** 把较大的 ID 数组分批，兼容 SQLite 的参数数量限制。 */
function chunkIds(values: string[]): string[][] {
  const chunks: string[][] = [];
  for (let offset = 0; offset < values.length; offset += REPAIR_BATCH_SIZE) {
    chunks.push(values.slice(offset, offset + REPAIR_BATCH_SIZE));
  }
  return chunks;
}

/** 判断条目是否保存了用户人工匹配结果，人工结果的文件归属优先保留。 */
function hasManualMatch(metadataJson: string): boolean {
  try {
    const metadata = JSON.parse(metadataJson || "{}") as Record<string, unknown>;
    const manualMatch = metadata.manualMatch;
    return manualMatch !== null
      && typeof manualMatch === "object"
      && !Array.isArray(manualMatch)
      && Object.keys(manualMatch as Record<string, unknown>).length > 0;
  } catch {
    return false;
  }
}

/** 比较同一个源文件的候选归属，返回负数表示左侧应当保留。 */
function compareFileLinkCandidates(left: DuplicateFileLinkRow, right: DuplicateFileLinkRow): number {
  const leftActive = left.item_deleted_at === null ? 1 : 0;
  const rightActive = right.item_deleted_at === null ? 1 : 0;
  if (leftActive !== rightActive) return rightActive - leftActive;

  const leftManual = hasManualMatch(left.metadata_json) ? 1 : 0;
  const rightManual = hasManualMatch(right.metadata_json) ? 1 : 0;
  if (leftManual !== rightManual) return rightManual - leftManual;

  const updatedCompare = right.item_updated_at.localeCompare(left.item_updated_at);
  if (updatedCompare !== 0) return updatedCompare;
  const createdCompare = right.item_created_at.localeCompare(left.item_created_at);
  if (createdCompare !== 0) return createdCompare;
  return right.link_id.localeCompare(left.link_id);
}

/** 查询媒体库内仍被活动文件引用的媒体条目 ID。 */
async function readActiveFileItemIds(transaction: Knex.Transaction, libraryId: string): Promise<Set<string>> {
  const rows = await transaction("file_links as fl")
    .join("source_files as f", "f.id", "fl.source_file_id")
    .distinct("fl.item_id")
    .where("fl.library_id", libraryId)
    .where("f.status", "active");
  return new Set(rows.map((row) => String(row.item_id)));
}

/** 软删除已经没有活动源文件的单集、曲目和章节，并移除它们的父子关系。 */
async function deleteOrphanLeafItems(
  transaction: Knex.Transaction,
  libraryId: string,
  now: string,
): Promise<string[]> {
  const activeFileItemIds = await readActiveFileItemIds(transaction, libraryId);
  const leafRows = await transaction("media_items")
    .select("id")
    .where({ library_id: libraryId })
    .whereIn("item_type", LEAF_ITEM_TYPES)
    .whereNull("deleted_at");
  const orphanLeafIds = leafRows
    .map((row) => String(row.id))
    .filter((itemId) => !activeFileItemIds.has(itemId));
  for (const itemIdChunk of chunkIds(orphanLeafIds)) {
    await transaction("media_items")
      .whereIn("id", itemIdChunk)
      .whereNull("deleted_at")
      .update({ deleted_at: now, updated_at: now });
    await transaction("media_relations").whereIn("child_item_id", itemIdChunk).delete();
  }
  return orphanLeafIds;
}

/** 软删除已经没有活动子项且自身没有活动文件的节目、专辑和有声书。 */
async function deleteOrphanParentItems(
  transaction: Knex.Transaction,
  libraryId: string,
  now: string,
): Promise<string[]> {
  const parentRows = await transaction("media_items")
    .select("id")
    .where({ library_id: libraryId })
    .whereIn("item_type", PARENT_ITEM_TYPES)
    .whereNull("deleted_at");
  const parentIds = parentRows.map((row) => String(row.id));
  if (parentIds.length === 0) return [];

  const activeFileItemIds = await readActiveFileItemIds(transaction, libraryId);
  const parentIdsWithActiveChildren = new Set<string>();
  for (const parentIdChunk of chunkIds(parentIds)) {
    const rows = await transaction("media_relations as r")
      .join("media_items as c", "c.id", "r.child_item_id")
      .distinct("r.parent_item_id")
      .whereIn("r.parent_item_id", parentIdChunk)
      .whereNull("c.deleted_at");
    rows.forEach((row) => parentIdsWithActiveChildren.add(String(row.parent_item_id)));
  }
  const orphanParentIds = parentIds.filter((itemId) =>
    !activeFileItemIds.has(itemId) && !parentIdsWithActiveChildren.has(itemId));
  for (const itemIdChunk of chunkIds(orphanParentIds)) {
    await transaction("media_items")
      .whereIn("id", itemIdChunk)
      .whereNull("deleted_at")
      .update({ deleted_at: now, updated_at: now });
    await transaction("media_relations")
      .whereIn("parent_item_id", itemIdChunk)
      .orWhereIn("child_item_id", itemIdChunk)
      .delete();
  }
  return orphanParentIds;
}

/** 为修复影响的媒体条目追加连续目录变化，并返回新的目录版本。 */
async function recordRepairCatalogChanges(
  transaction: Knex.Transaction,
  libraryId: string,
  affectedItemIds: string[],
  now: string,
): Promise<number> {
  const library = await transaction("media_libraries").select("user_id", "catalog_version").where({ id: libraryId }).first();
  if (!library) return 0;
  const uniqueItemIds = [...new Set(affectedItemIds)];
  if (uniqueItemIds.length === 0) return Number(library.catalog_version);

  const deletedItemIds = new Set<string>();
  for (const itemIdChunk of chunkIds(uniqueItemIds)) {
    const rows = await transaction("media_items").select("id", "deleted_at").whereIn("id", itemIdChunk);
    rows.forEach((row) => {
      if (row.deleted_at !== null) deletedItemIds.add(String(row.id));
    });
  }
  const previousVersion = Number(library.catalog_version);
  const catalogVersion = previousVersion + uniqueItemIds.length;
  for (let offset = 0; offset < uniqueItemIds.length; offset += REPAIR_BATCH_SIZE) {
    const itemIdChunk = uniqueItemIds.slice(offset, offset + REPAIR_BATCH_SIZE);
    await transaction("catalog_changes").insert(itemIdChunk.map((itemId, index) => ({
      user_id: String(library.user_id),
      library_id: libraryId,
      catalog_version: previousVersion + offset + index + 1,
      entity_type: "media_item",
      entity_id: itemId,
      change_type: deletedItemIds.has(itemId) ? "delete" : "upsert",
      created_at: now,
    })));
  }
  await transaction("media_libraries").where({ id: libraryId }).update({
    catalog_version: catalogVersion,
    updated_at: now,
  });
  return catalogVersion;
}

/**
 * 修复历史上同一个源文件同时归属新旧媒体条目的数据。
 * 每个媒体库独立事务执行，避免任一媒体库失败时影响其他用户的数据。
 */
export async function repairDuplicateCatalogFileLinks(database: Knex): Promise<CatalogFileLinkRepairResult[]> {
  const libraryRows = await database("file_links")
    .select("library_id")
    .groupBy("library_id")
    .havingRaw("COUNT(*) > COUNT(DISTINCT source_file_id)");
  const results: CatalogFileLinkRepairResult[] = [];

  for (const libraryRow of libraryRows) {
    const libraryId = String(libraryRow.library_id);
    const result = await database.transaction(async (transaction): Promise<CatalogFileLinkRepairResult> => {
      const duplicateRows = await transaction("file_links")
        .select("source_file_id")
        .where({ library_id: libraryId })
        .groupBy("source_file_id")
        .havingRaw("COUNT(*) > 1");
      const duplicateSourceFileIds = duplicateRows.map((row) => String(row.source_file_id));
      const removedLinkIds: string[] = [];
      const affectedItemIds = new Set<string>();

      for (const sourceFileIdChunk of chunkIds(duplicateSourceFileIds)) {
        const candidateRows = await transaction("file_links as fl")
          .join("media_items as m", "m.id", "fl.item_id")
          .select(
            "fl.id as link_id",
            "fl.source_file_id",
            "fl.item_id",
            "m.item_type",
            "m.metadata_json",
            "m.created_at as item_created_at",
            "m.updated_at as item_updated_at",
            "m.deleted_at as item_deleted_at",
          )
          .where("fl.library_id", libraryId)
          .whereIn("fl.source_file_id", sourceFileIdChunk) as DuplicateFileLinkRow[];
        const candidatesBySourceFile = new Map<string, DuplicateFileLinkRow[]>();
        for (const candidate of candidateRows) {
          const candidates = candidatesBySourceFile.get(candidate.source_file_id) ?? [];
          candidates.push(candidate);
          candidatesBySourceFile.set(candidate.source_file_id, candidates);
        }
        for (const candidates of candidatesBySourceFile.values()) {
          candidates.sort(compareFileLinkCandidates);
          const keptCandidate = candidates[0];
          if (!keptCandidate) continue;
          affectedItemIds.add(keptCandidate.item_id);
          for (let index = 1; index < candidates.length; index += 1) {
            const removedCandidate = candidates[index];
            if (!removedCandidate) continue;
            removedLinkIds.push(removedCandidate.link_id);
            affectedItemIds.add(removedCandidate.item_id);
          }
        }
      }

      for (const linkIdChunk of chunkIds(removedLinkIds)) {
        await transaction("file_links").whereIn("id", linkIdChunk).delete();
      }
      const now = new Date().toISOString();
      const deletedLeafItemIds = await deleteOrphanLeafItems(transaction, libraryId, now);
      deletedLeafItemIds.forEach((itemId) => affectedItemIds.add(itemId));
      const deletedParentItemIds = await deleteOrphanParentItems(transaction, libraryId, now);
      deletedParentItemIds.forEach((itemId) => affectedItemIds.add(itemId));
      const catalogVersion = await recordRepairCatalogChanges(
        transaction,
        libraryId,
        [...affectedItemIds],
        now,
      );
      return {
        libraryId,
        duplicateSourceFileCount: duplicateSourceFileIds.length,
        removedFileLinkCount: removedLinkIds.length,
        deletedLeafItemCount: deletedLeafItemIds.length,
        deletedParentItemCount: deletedParentItemIds.length,
        catalogVersion,
      };
    });
    results.push(result);
  }
  return results;
}
