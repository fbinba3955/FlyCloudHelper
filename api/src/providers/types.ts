import { validationError } from "../errors.js";

export interface ScanRoot {
  resourceId?: string;
  displayPath?: string;
  driveId?: string;
  mediaTypes?: string[];
}

export interface ProviderEntry {
  resourceId: string;
  parentResourceId: string | null;
  path: string;
  name: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: string | null;
  etag: string | null;
  locator: Record<string, unknown>;
}

export interface ProviderValidationResult {
  valid: boolean;
  accountLabel: string | null;
  rootAccessible: boolean;
}

export interface ProviderEnumerationWarning {
  code: string;
  message: string;
  path: string;
}

/** Provider 可持久化的目录枚举位置；内容不得包含连接凭据。 */
export interface ProviderEnumerationCheckpoint {
  providerType: string;
  version: number;
  checkpointSequence: number;
  rootIndex: number;
  rootWarningCount: number;
  pendingDirectories: Array<{
    resourcePath: string;
    isRoot: boolean;
  }>;
}

/** Provider 单个扫描根的运行状态，用于判断该根是否完整枚举。 */
export interface ProviderRootRunState {
  rootIndex: number;
  root: ScanRoot;
  warningCount: number;
}

/** 前端路径选择器使用的单个网盘目录。 */
export interface ProviderDirectory {
  name: string;
  resourceId: string;
  displayPath: string;
  driveId?: string;
}

/** 前端逐级浏览目录时返回当前目录及其直接子目录。 */
export interface ProviderDirectoryListing {
  current: ProviderDirectory;
  items: ProviderDirectory[];
}

/** Provider 建议的扫描和刮削并发范围，默认值与 Flymby APP 保持一致。 */
export interface ProviderRecommendedScanSettings {
  scanDirectoryConcurrency: {
    default: number;
    min: number;
    max: number;
  };
  scrapeTaskConcurrency: {
    default: number;
    min: number;
    max: number;
  };
  /** 全量扫描为了避免持续占满网盘连接，实际目录并发不超过该值。 */
  fullScanDirectoryConcurrency: number;
}

/** Worker 交给 Provider 的单次枚举运行参数。 */
export interface ProviderEnumerationOptions {
  directoryConcurrency: number;
  /** 上一次安全检查点保存的 Provider 游标。 */
  resumeState?: Record<string, unknown> | null;
  /** 每处理多少批目录生成一次可持久化游标。 */
  checkpointDirectoryInterval?: number;
  /** 只上报检查点候选，是否持久化由 Worker 在业务任务落库后决定。 */
  onCheckpoint?: (checkpoint: ProviderEnumerationCheckpoint) => void;
  /** 扫描根开始时通知 Worker 建立根运行记录。 */
  onRootStart?: (state: ProviderRootRunState) => Promise<void>;
  /** 扫描根完成时通知 Worker 提交根运行结果。 */
  onRootComplete?: (state: ProviderRootRunState) => Promise<void>;
}

export interface ProviderDescriptor {
  type: string;
  displayName: string;
  adapterVersion: string;
  credentialSchemaVersion: number;
  capabilities: string[];
  recommendedScanSettings: ProviderRecommendedScanSettings;
  connectionFields: Array<{
    name: string;
    label: string;
    type: "text" | "password" | "url";
    required: boolean;
    secret: boolean;
  }>;
}

export interface ProviderAdapter {
  readonly descriptor: ProviderDescriptor;
  validateConnection(connection: Record<string, unknown>, signal?: AbortSignal): Promise<ProviderValidationResult>;
  validateRoots(connection: Record<string, unknown>, roots: ScanRoot[], signal?: AbortSignal): Promise<void>;
  browseDirectories(
    connection: Record<string, unknown>,
    parent?: ScanRoot,
    signal?: AbortSignal,
  ): Promise<ProviderDirectoryListing>;
  enumerate(
    connection: Record<string, unknown>,
    roots: ScanRoot[],
    signal?: AbortSignal,
    onWarning?: (warning: ProviderEnumerationWarning) => void,
    options?: ProviderEnumerationOptions,
  ): AsyncGenerator<ProviderEntry>;
  /** Provider 支持读取小型文本文件时提供，用于 NFO 等本地元数据。 */
  readText?(
    connection: Record<string, unknown>,
    entry: ProviderEntry,
    signal?: AbortSignal,
  ): Promise<string>;
}

/**
 * 返回 Flymby APP 当前网盘影视扫描的推荐参数。
 * Provider 描述各自保存一份该配置，后续接入网盘时可以独立调整。
 */
export function createFlymbyRecommendedScanSettings(): ProviderRecommendedScanSettings {
  return {
    scanDirectoryConcurrency: { default: 8, min: 1, max: 16 },
    scrapeTaskConcurrency: { default: 4, min: 1, max: 4 },
    fullScanDirectoryConcurrency: 1,
  };
}

/** 把用户配置限制在 Provider 声明的并发范围内。 */
export function readProviderConcurrency(
  value: unknown,
  range: { default: number; min: number; max: number },
): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed)) return range.default;
  return Math.min(range.max, Math.max(range.min, parsed));
}

/** 读取 Provider 连接中的必填字符串。 */
export function requireConnectionString(
  connection: Record<string, unknown>,
  fieldName: string,
  displayName: string,
): string {
  const value = connection[fieldName];
  if (typeof value !== "string" || !value.trim()) {
    throw validationError(fieldName, `${displayName}不能为空`);
  }
  return value.trim();
}

/** 把未知值转换为安全的非负文件大小。 */
export function toFileSize(value: unknown): number {
  const size = Number(value ?? 0);
  return Number.isFinite(size) && size >= 0 ? size : 0;
}
