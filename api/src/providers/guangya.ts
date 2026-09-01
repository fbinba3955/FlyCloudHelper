import { ApiError } from "../errors.js";
import { isFlymbyExcludedFolderName } from "../media/flymby-scan-exclusions.js";
import { GuangyaWebApiClient } from "./guangya-web-api.js";
import { GuangyaOpenApiClient } from "./guangya-open-api.js";
import {
  type ProviderAdapter,
  type ProviderConnectionContext,
  type ProviderDescriptor,
  type ProviderDirectoryListing,
  type ProviderEntry,
  type ProviderEnumerationCheckpoint,
  type ProviderEnumerationOptions,
  type ProviderEnumerationWarning,
  type ProviderValidationResult,
  type ScanRoot,
  createProviderRecommendedScanSettings,
  toFileSize,
} from "./types.js";

type JsonRecord = Record<string, unknown>;

interface GuangyaItem {
  fileId: string;
  parentId: string;
  name: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: string | null;
  bizId: string;
}

interface GuangyaListResult {
  items: GuangyaItem[];
  hasMore: boolean;
}

interface GuangyaCheckpoint extends ProviderEnumerationCheckpoint {
  providerType: "guangya";
}

/** 光鸭两套文件 API 对 Provider 暴露的统一最小能力。 */
interface GuangyaFileApiClient {
  validateConnection(
    connection: Record<string, unknown>,
    persistConnection?: (connection: Record<string, unknown>) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<string | null>;
  listChildren(
    connection: Record<string, unknown>,
    parentId: string,
    page: number,
    pageSize: number,
    persistConnection?: (connection: Record<string, unknown>) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<JsonRecord>;
  getFileDownloadAccess(
    connection: Record<string, unknown>,
    fileId: string,
    persistConnection?: (connection: Record<string, unknown>) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<{ url: string; expiresAt: string | null }>;
}

/** 将未知 JSON 值安全读取为对象。 */
function readRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

/** 从候选字段读取首个非空文本。 */
function readFirstText(record: JsonRecord, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return "";
}

/** 从候选字段读取首个非负数字。 */
function readFirstNumber(record: JsonRecord, keys: string[]): number {
  for (const key of keys) {
    const value = Number(record[key]);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return 0;
}

/** 将秒、毫秒或 ISO 时间统一转换为 ISO 文本。 */
function readModifiedAt(record: JsonRecord): string | null {
  const raw = readFirstText(record, ["utime", "updatedAt", "modifiedAt", "modifyTime", "createdAt", "ctime"]);
  if (!raw) return null;
  const numeric = Number(raw);
  const timestamp = Number.isFinite(numeric) && numeric > 0
    ? numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric
    : Date.parse(raw);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

/** 兼容光鸭网页接口不同版本的目录标记。 */
function isDirectory(record: JsonRecord): boolean {
  const fileType = readFirstText(record, ["fileType"]).toLowerCase();
  const resType = readFirstText(record, ["resType"]).toLowerCase();
  return record.isFolder === true || record.isDir === true || record.dir === true
    || fileType === "folder" || resType === "folder" || resType === "2";
}

/** 从列表响应中读取文件数组。 */
function resolveRawItems(body: JsonRecord): JsonRecord[] {
  const rawData = body.data;
  if (Array.isArray(rawData)) return rawData.map(readRecord);
  const data = readRecord(rawData);
  for (const key of ["list", "items", "records", "fileList", "files"]) {
    const value = data[key];
    if (Array.isArray(value)) return value.map(readRecord);
  }
  return [];
}

/** 映射单个光鸭文件或目录。 */
function mapGuangyaItem(record: JsonRecord, fallbackParentId: string): GuangyaItem | null {
  const fileId = readFirstText(record, ["fileId", "id"]);
  if (!fileId) return null;
  return {
    fileId,
    parentId: readFirstText(record, ["parentId"]) || fallbackParentId,
    name: readFirstText(record, ["name", "fileName"]) || fileId,
    isDirectory: isDirectory(record),
    size: toFileSize(readFirstNumber(record, ["size", "fileSize"])),
    modifiedAt: readModifiedAt(record),
    bizId: readFirstText(record, ["bizId", "biziId"]),
  };
}

/** 把根目录虚拟 ID 转成光鸭网页接口使用的空 parentId。 */
function toWebApiParentId(resourceId: string): string {
  return resourceId === "root" ? "" : resourceId;
}

/** 将光鸭队列目录编码到不含凭据的检查点字段。 */
function encodeCheckpointDirectory(directory: { id: string; path: string }): string {
  return JSON.stringify(directory);
}

/** 从检查点还原光鸭目录，格式异常时忽略该项。 */
function decodeCheckpointDirectory(value: string): { id: string; path: string } | null {
  try {
    const record = readRecord(JSON.parse(value));
    const id = readFirstText(record, ["id"]);
    const path = readFirstText(record, ["path"]);
    return id && path ? { id, path } : null;
  } catch {
    return null;
  }
}

/** 校验并读取光鸭 Provider 检查点。 */
function readGuangyaCheckpoint(value: Record<string, unknown> | null | undefined): GuangyaCheckpoint | null {
  if (!value || value.providerType !== "guangya" || Number(value.version) !== 1) return null;
  const pendingDirectories = Array.isArray(value.pendingDirectories)
    ? value.pendingDirectories.flatMap((item) => {
      const record = readRecord(item);
      const resourcePath = readFirstText(record, ["resourcePath"]);
      return resourcePath ? [{ resourcePath, isRoot: record.isRoot === true }] : [];
    })
    : [];
  return {
    providerType: "guangya",
    version: 1,
    checkpointSequence: Math.max(0, Number(value.checkpointSequence) || 0),
    rootIndex: Math.max(0, Number(value.rootIndex) || 0),
    rootWarningCount: Math.max(0, Number(value.rootWarningCount) || 0),
    pendingDirectories,
  };
}

/** 光鸭 Provider 按登录类型分流官方开放平台与网页文件 API。 */
export class GuangyaProvider implements ProviderAdapter {
  public readonly descriptor: ProviderDescriptor = {
    type: "guangya",
    displayName: "光鸭云盘",
    adapterVersion: "4.0.0-three-auth-modes",
    credentialSchemaVersion: 4,
    capabilities: [
      "list",
      "stableResourceId",
      "playbackLocator",
      "officialApiSync",
      "webQrLogin",
      "webSmsLogin",
      "directDownload",
      "relayPlayback",
    ],
    recommendedScanSettings: createProviderRecommendedScanSettings({
      // 光鸭文件接口内部按 210ms 排队并可能返回业务 429，保持较低并发可避免重试抵消收益。
      scanDirectoryConcurrency: { default: 4 },
    }),
    authenticationMode: "web_qr",
    connectionFields: [],
  };

  public constructor(
    private readonly webClient: GuangyaWebApiClient,
    private readonly openApiClient: GuangyaOpenApiClient,
  ) {}

  /** 使用对应登录类型的根目录列表验证连接。 */
  public async validateConnection(
    connection: Record<string, unknown>,
    signal?: AbortSignal,
    context?: ProviderConnectionContext,
  ): Promise<ProviderValidationResult> {
    const accountLabel = await this.resolveClient(connection)
      .validateConnection(connection, context?.persistConnection, signal);
    return { valid: true, accountLabel, rootAccessible: true };
  }

  /** 验证每个光鸭扫描根可以读取首个分页。 */
  public async validateRoots(
    connection: Record<string, unknown>,
    roots: ScanRoot[],
    signal?: AbortSignal,
    context?: ProviderConnectionContext,
  ): Promise<void> {
    const selectedRoots = roots.length > 0 ? roots : [{ resourceId: "root" }];
    for (const root of selectedRoots) {
      await this.listDirectory(connection, root.resourceId || "root", 0, 1, context?.persistConnection, signal);
    }
  }

  /** 根据扫描落库的稳定 fileId 获取临时下载地址。 */
  public async resolveFileAccess(
    connection: Record<string, unknown>,
    locator: Record<string, unknown>,
    signal?: AbortSignal,
    context?: ProviderConnectionContext,
  ): Promise<{ url: string; expiresAt: string | null; headers: Record<string, string> }> {
    const fileId = typeof locator.fileId === "string" ? locator.fileId.trim() : "";
    if (!fileId) throw new ApiError(422, "provider_file_locator_invalid", "光鸭文件定位无效");
    const access = await this.resolveClient(connection).getFileDownloadAccess(
      connection,
      fileId,
      context?.persistConnection,
      signal,
    );
    return { ...access, headers: {} };
  }

  /** 返回当前目录的直接子目录，供前端路径选择器使用。 */
  public async browseDirectories(
    connection: Record<string, unknown>,
    parent?: ScanRoot,
    signal?: AbortSignal,
    context?: ProviderConnectionContext,
  ): Promise<ProviderDirectoryListing> {
    const parentId = parent?.resourceId || "root";
    const parentPath = parent?.displayPath || "/";
    const items: ProviderDirectoryListing["items"] = [];
    let page = 0;
    let hasMore = false;
    do {
      const result = await this.listDirectory(connection, parentId, page, 100, context?.persistConnection, signal);
      for (const item of result.items) {
        if (!item.isDirectory || isFlymbyExcludedFolderName(item.name)) continue;
        items.push({
          name: item.name,
          resourceId: item.fileId,
          displayPath: `${parentPath.replace(/\/$/u, "")}/${item.name}` || "/",
        });
      }
      hasMore = result.hasMore;
      page += 1;
    } while (hasMore);
    items.sort((left, right) => left.name.localeCompare(right.name, "zh-CN", { numeric: true }));
    return {
      current: {
        name: parentId === "root" ? "/" : parentPath.replace(/\/$/u, "").split("/").pop() || "/",
        resourceId: parentId,
        displayPath: parentPath,
      },
      items,
    };
  }

  /** 按稳定 fileId 广度优先枚举，并生成可恢复的 Provider 检查点。 */
  public async *enumerate(
    connection: Record<string, unknown>,
    roots: ScanRoot[],
    signal?: AbortSignal,
    onWarning?: (warning: ProviderEnumerationWarning) => void,
    options?: ProviderEnumerationOptions,
  ): AsyncGenerator<ProviderEntry> {
    const selectedRoots = roots.length > 0 ? roots : [{ resourceId: "root", displayPath: "/" }];
    const resumeCheckpoint = readGuangyaCheckpoint(options?.resumeState);
    const resumeRootIndex = resumeCheckpoint && resumeCheckpoint.rootIndex < selectedRoots.length
      ? resumeCheckpoint.rootIndex
      : 0;
    let nextCheckpointSequence = resumeCheckpoint?.checkpointSequence ?? 0;
    for (let rootIndex = resumeRootIndex; rootIndex < selectedRoots.length; rootIndex += 1) {
      const root = selectedRoots[rootIndex];
      if (!root) continue;
      const rootId = root.resourceId || "root";
      const rootPath = root.displayPath || "/";
      const restoredQueue = resumeCheckpoint && rootIndex === resumeRootIndex
        ? resumeCheckpoint.pendingDirectories
          .map((item) => decodeCheckpointDirectory(item.resourcePath))
          .filter((item): item is { id: string; path: string } => item !== null)
        : [];
      const queue = restoredQueue.length > 0 ? restoredQueue : [{ id: rootId, path: rootPath }];
      const visited = new Set<string>();
      const directoryConcurrency = Math.max(1, options?.directoryConcurrency ?? 1);
      const checkpointDirectoryInterval = Math.max(1, options?.checkpointDirectoryInterval ?? 20);
      let completedDirectoryBatchCount = 0;
      let rootWarningCount = resumeCheckpoint && rootIndex === resumeRootIndex
        ? resumeCheckpoint.rootWarningCount
        : 0;
      await options?.onRootStart?.({ rootIndex, root, warningCount: rootWarningCount });
      while (queue.length > 0) {
        if (signal?.aborted) return;
        if (completedDirectoryBatchCount === 0) {
          options?.onCheckpoint?.({
            providerType: "guangya",
            version: 1,
            checkpointSequence: nextCheckpointSequence,
            rootIndex,
            rootWarningCount,
            pendingDirectories: queue.map((directory) => ({
              resourcePath: encodeCheckpointDirectory(directory),
              isRoot: directory.id === rootId,
            })),
          });
          nextCheckpointSequence += 1;
        }
        const directoryBatch = queue.splice(0, directoryConcurrency)
          .filter((directory) => !visited.has(directory.id));
        directoryBatch.forEach((directory) => visited.add(directory.id));
        const batchResults = await Promise.all(directoryBatch.map(async (directory) => {
          try {
            const entries: GuangyaItem[] = [];
            let page = 0;
            let hasMore = false;
            do {
              const result = await this.listDirectory(
                connection,
                directory.id,
                page,
                100,
                options?.persistConnection,
                signal,
              );
              entries.push(...result.items);
              hasMore = result.hasMore;
              page += 1;
            } while (hasMore);
            return { directory, entries, error: null as unknown };
          } catch (error) {
            return { directory, entries: [] as GuangyaItem[], error };
          }
        }));
        for (const result of batchResults) {
          if (result.error) {
            if (result.directory.id === rootId) throw result.error;
            rootWarningCount += 1;
            const errorCode = result.error instanceof ApiError ? result.error.code : "provider_directory_unavailable";
            const errorMessage = result.error instanceof Error ? result.error.message : "光鸭子目录访问失败";
            onWarning?.({ code: errorCode, message: errorMessage, path: result.directory.path });
            continue;
          }
          result.entries.sort((left, right) => left.name.localeCompare(right.name, "zh-CN", { numeric: true }));
          for (const item of result.entries) {
            const itemPath = `${result.directory.path.replace(/\/$/u, "")}/${item.name}`;
            if (item.isDirectory) {
              if (!isFlymbyExcludedFolderName(item.name)) queue.push({ id: item.fileId, path: itemPath });
              continue;
            }
            yield {
              resourceId: item.fileId,
              parentResourceId: item.parentId || result.directory.id,
              path: itemPath,
              name: item.name,
              isDirectory: false,
              size: item.size,
              modifiedAt: item.modifiedAt,
              etag: null,
              locator: { providerType: "guangya", fileId: item.fileId, bizId: item.bizId },
            };
          }
        }
        completedDirectoryBatchCount = (completedDirectoryBatchCount + 1) % checkpointDirectoryInterval;
      }
      await options?.onRootComplete?.({ rootIndex, root, warningCount: rootWarningCount });
    }
  }

  /** 读取并映射光鸭单页目录响应。 */
  private async listDirectory(
    connection: Record<string, unknown>,
    parentId: string,
    page: number,
    pageSize: number,
    persistConnection?: (connection: Record<string, unknown>) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<GuangyaListResult> {
    const body = await this.resolveClient(connection).listChildren(
      connection,
      toWebApiParentId(parentId),
      page,
      pageSize,
      persistConnection,
      signal,
    );
    const items = resolveRawItems(body)
      .map((record) => mapGuangyaItem(record, parentId))
      .filter((item): item is GuangyaItem => item !== null);
    const data = readRecord(body.data);
    const total = readFirstNumber(data, ["total", "count", "totalCount"]);
    const explicitHasMore = data.hasMore;
    const hasMore = typeof explicitHasMore === "boolean"
      ? explicitHasMore
      : total > 0 ? (page + 1) * pageSize < total : items.length >= pageSize;
    return { items, hasMore };
  }

  /** 根据加密连接中的类型选择文件 API；旧数据默认视为网页二维码登录。 */
  private resolveClient(connection: Record<string, unknown>): GuangyaFileApiClient {
    const authMode = typeof connection.authMode === "string" && connection.authMode.trim()
      ? connection.authMode.trim()
      : "web_qr";
    if (authMode === "official_api") return this.openApiClient;
    if (authMode === "web_qr" || authMode === "web_sms") return this.webClient;
    throw new ApiError(422, "guangya_auth_mode_invalid", "不支持的光鸭登录类型");
  }
}
