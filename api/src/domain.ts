export type UserRole = "user" | "super_admin";
export type UserStatus = "active" | "disabled" | "pending_delete";
export type ServiceStatus = "active" | "scanning" | "reauthorization_required" | "disabled";
export type JobStatus = "queued" | "running" | "paused" | "completed" | "failed" | "cancelled";
export type JobStage = "queued" | "enumerating" | "classifying" | "scraping" | "persisting" | "completed";
export type MediaType = "video" | "music" | "audiobook";
export type CatalogSort = "created_desc" | "year_desc" | "premiere_date_desc" | "title_asc";
export type MatchState = "matched" | "needs_review" | "unmatched" | "processing";

export interface PublicUserRecord {
  id: string;
  tenantId: string;
  username: string;
  role: UserRole;
  status: UserStatus;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface AuthenticationRecord extends PublicUserRecord {
  passwordHash: string;
}

export interface SystemStateRecord {
  serviceInstanceId: string;
  setupRequired: boolean;
  credentialKeyBackupRequired: boolean;
  credentialKeySource: "file" | "environment" | "generated" | null;
  schemaVersion: number;
}

export interface CloudServiceRecord {
  id: string;
  tenantId: string;
  ownerUserId: string;
  ownerUsername: string;
  libraryId: string;
  displayName: string;
  providerType: string;
  dataType: MediaType;
  status: ServiceStatus;
  connectionStatus: string;
  credentialRevision: number;
  scanProfileRevision: number;
  metadataProfileRevision: number;
  catalogVersion: number;
  itemCount: number;
  lastScanAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ServiceDetailRecord extends CloudServiceRecord {
  scanProfile: Record<string, unknown>;
  metadataProfile: Record<string, unknown>;
  credentialConfigured: boolean;
  bindings: Array<Record<string, unknown>>;
  recentJobs: ScanJobRecord[];
}

export interface ScanJobRecord {
  id: string;
  tenantId: string;
  serviceId: string;
  libraryId: string;
  ownerUsername: string;
  serviceName: string;
  dataType: MediaType;
  requestId: string;
  clientDeviceId: string;
  scanMode: "incremental" | "full";
  status: JobStatus;
  stage: JobStage;
  processedCount: number;
  totalCount: number | null;
  discoveredCount: number;
  skippedCount: number;
  matchedCount: number | null;
  unmatchedCount: number | null;
  errorCount: number;
  currentPath: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  snapshot: Record<string, unknown>;
  controlAction: "none" | "pause" | "cancel";
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

export interface SourceFileRecord {
  id: string;
  tenantId: string;
  serviceId: string;
  libraryId: string;
  providerResourceId: string;
  parentResourceId: string | null;
  path: string;
  name: string;
  extension: string;
  size: number;
  modifiedAt: string | null;
  etag: string | null;
  generationId: string;
  locator: Record<string, unknown>;
}

export interface MediaItemRecord {
  id: string;
  tenantId: string;
  serviceId: string;
  libraryId: string;
  mediaType: MediaType;
  itemType: string;
  title: string;
  sortTitle: string;
  subtitle: string;
  year: number | null;
  premiereDate: string | null;
  overview: string;
  posterUrl: string | null;
  backdropUrl: string | null;
  matchState: MatchState;
  externalIds: Record<string, string>;
  metadata: Record<string, unknown>;
  fileCount: number;
  ownerUsername: string;
  serviceName: string;
  createdAt: string;
  updatedAt: string;
}

export interface JobEventRecord {
  sequence: number;
  tenantId: string;
  jobId: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface ExportRecord {
  id: string;
  tenantId: string;
  libraryId: string;
  exportType: "binding" | "snapshot";
  status: "completed" | "failed";
  filePath: string | null;
  fileSize: number | null;
  errorMessage: string | null;
  createdAt: string;
}

export interface PluginVersionRecord {
  pluginId: string;
  version: string;
  displayName: string;
  status: "imported" | "enabled" | "disabled";
  sha256: string;
  manifest: Record<string, unknown>;
  configurationRevision: number;
  configurationState: Record<string, boolean>;
  installedPath: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuditRecord {
  id: string;
  operatorUserId: string | null;
  operatorUsername: string | null;
  operationType: string;
  targetType: string;
  targetId: string | null;
  result: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

/** 安全解析数据库 JSON 字段，损坏值回退为空对象。 */
export function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || !value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** 安全解析数据库 JSON 数组字段，损坏值回退为空数组。 */
export function parseJsonArray(value: unknown): Array<Record<string, unknown>> {
  if (typeof value !== "string" || !value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
      : [];
  } catch {
    return [];
  }
}
