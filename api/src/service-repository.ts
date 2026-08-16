import { randomUUID } from "node:crypto";
import type { Knex } from "knex";
import type { FlyCloudHelperDatabase } from "./database.js";
import {
  type CloudServiceRecord,
  type CatalogSort,
  type JobEventRecord,
  type JobStage,
  type JobStatus,
  type MatchState,
  type MediaItemRecord,
  type MediaType,
  type ScanJobRecord,
  type ServiceDetailRecord,
  type ServiceStatus,
  type SourceFileRecord,
  parseJsonArray,
  parseJsonObject,
} from "./domain.js";
import { ApiError, toSafeErrorMessage } from "./errors.js";
import { isFlymbyExcludedPath } from "./media/flymby-scan-exclusions.js";
import { createStableId } from "./media/filename.js";
import { parseFlymbyVideoName } from "./media/flymby-video-parser.js";
import type { TmdbVideoMetadata } from "./metadata/tmdb.js";

interface ServiceRow {
  id: string;
  tenant_id: string;
  owner_user_id: string;
  owner_username: string;
  library_id: string;
  display_name: string;
  provider_type: string;
  data_type: MediaType;
  status: ServiceStatus;
  connection_status: string;
  credential_revision: number | string;
  scan_profile_revision: number | string;
  metadata_profile_revision: number | string;
  catalog_version: number | string;
  item_count: number | string;
  last_scan_at: string | null;
  created_at: string;
  updated_at: string;
}

interface JobRow {
  id: string;
  tenant_id: string;
  service_id: string;
  library_id: string;
  owner_username: string;
  service_name: string;
  data_type: MediaType;
  request_id: string;
  client_device_id: string;
  scan_mode: "incremental" | "full";
  status: JobStatus;
  stage: JobStage;
  processed_count: number | string;
  total_count: number | string | null;
  discovered_count: number | string;
  skipped_count: number | string;
  matched_count: number | string | null;
  unmatched_count: number | string | null;
  error_count: number | string;
  current_path: string | null;
  error_code: string | null;
  error_message: string | null;
  snapshot_json: string;
  control_action: "none" | "pause" | "cancel";
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

/** 把服务查询行转换为公开服务摘要。 */
function mapService(row: ServiceRow): CloudServiceRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    ownerUserId: row.owner_user_id,
    ownerUsername: row.owner_username,
    libraryId: row.library_id,
    displayName: row.display_name,
    providerType: row.provider_type,
    dataType: row.data_type,
    status: row.status,
    connectionStatus: row.connection_status,
    credentialRevision: Number(row.credential_revision),
    scanProfileRevision: Number(row.scan_profile_revision),
    metadataProfileRevision: Number(row.metadata_profile_revision),
    catalogVersion: Number(row.catalog_version),
    itemCount: Number(row.item_count),
    lastScanAt: row.last_scan_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 把任务查询行转换为公开任务 DTO。 */
function mapJob(row: JobRow): ScanJobRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    serviceId: row.service_id,
    libraryId: row.library_id,
    ownerUsername: row.owner_username,
    serviceName: row.service_name,
    dataType: row.data_type,
    requestId: row.request_id,
    clientDeviceId: row.client_device_id,
    scanMode: row.scan_mode,
    status: row.status,
    stage: row.stage,
    processedCount: Number(row.processed_count),
    totalCount: row.total_count === null ? null : Number(row.total_count),
    discoveredCount: Number(row.discovered_count),
    skippedCount: Number(row.skipped_count),
    matchedCount: row.matched_count === null || row.matched_count === undefined ? null : Number(row.matched_count),
    unmatchedCount: row.unmatched_count === null || row.unmatched_count === undefined ? null : Number(row.unmatched_count),
    errorCount: Number(row.error_count),
    currentPath: row.current_path,
    errorCode: row.error_code,
    errorMessage: row.error_message ? toSafeErrorMessage(row.error_message, "扫描任务失败") : null,
    snapshot: parseJsonObject(row.snapshot_json),
    controlAction: row.control_action,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    updatedAt: row.updated_at,
  };
}

/** 把大 ID 列表切成数据库方言都能安全处理的小批次。 */
function chunkStrings(values: string[], size = 400): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

// 关键变量：每条目录变化包含 7 个绑定值，400 条可兼容 SQLite、PostgreSQL 和 MySQL 的参数上限。
const CATALOG_CHANGE_INSERT_BATCH_SIZE = 400;

interface CatalogPathRow {
  fileId: string;
  resourceId: string;
  linkedItemId: string;
  linkedItemTitle: string;
  path: string;
  name: string;
  size: number;
  modifiedAt: string | null;
}

interface LinkedSourceRow extends Record<string, unknown> {
  file_link_id: string;
  linked_item_id: string;
  source_file_id: string;
  provider_resource_id: string;
  path: string;
  name: string;
  size: number | string;
  modified_at: string | null;
  locator_json: string;
}

interface ManualMatchSnapshot {
  itemType: string;
  title: string;
  sortTitle: string;
  subtitle: string;
  year: number | null;
  metadata: Record<string, unknown>;
}

/** 手动匹配后仍需保留的扫描来源字段，避免清除匹配时丢失本地识别依据。 */
const sourceMetadataKeys = [
  "sourcePath",
  "scrapeTaskKey",
  "query",
  "seriesTitle",
  "seasonNumber",
  "episodeNumber",
  "episodeNumbers",
  "imdbId",
  "explicitTmdbId",
  "resolution",
  "source",
  "releaseGroup",
] as const;

/** 从媒体元数据中提取扫描阶段产生的字段，不保留外部刮削结果。 */
function pickSourceMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of sourceMetadataKeys) {
    if (metadata[key] !== undefined) result[key] = metadata[key];
  }
  return result;
}

/** 把未知值安全转换为普通对象。 */
function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** 从统一元数据中读取适合数据库排序的首映日期。 */
function readMediaPremiereDate(metadata: Record<string, unknown>): string | null {
  const rawDate = typeof metadata.releaseDate === "string"
    ? metadata.releaseDate
    : typeof metadata.airDate === "string" ? metadata.airDate : "";
  return /^\d{4}-\d{2}-\d{2}/u.test(rawDate) ? rawDate.slice(0, 10) : null;
}

/** 把数据库源文件行转换为视频名称解析器可读取的 Provider 条目。 */
function toVideoProviderEntry(row: Record<string, unknown>) {
  return {
    resourceId: String(row.provider_resource_id),
    parentResourceId: null,
    path: String(row.path),
    name: String(row.name),
    isDirectory: false,
    size: Number(row.size ?? 0),
    modifiedAt: row.modified_at ? String(row.modified_at) : null,
    etag: null,
    locator: {},
  };
}

/** 提供带租户作用域的云端服务、任务和目录数据访问。 */
export class ServiceRepository {
  private readonly database: FlyCloudHelperDatabase;

  public constructor(database: FlyCloudHelperDatabase) {
    this.database = database;
  }

  /** 构造服务摘要公共查询，始终保留租户、所有者和媒体库链路。 */
  private serviceSummaryQuery(transaction: Knex | Knex.Transaction = this.database.query) {
    return transaction("cloud_services as s")
      .join("user_accounts as u", "u.id", "s.owner_user_id")
      .join("media_libraries as l", "l.id", "s.library_id")
      .leftJoin("media_items as m", function joinActiveMedia() {
        this.on("m.library_id", "=", "l.id")
          .andOnNull("m.deleted_at")
          .andOnVal("m.item_type", "<>", "video.episode");
      })
      .select(
        "s.id",
        "s.tenant_id",
        "s.owner_user_id",
        "u.username as owner_username",
        "s.library_id",
        "s.display_name",
        "s.provider_type",
        "s.data_type",
        "s.status",
        "s.connection_status",
        "s.credential_revision",
        "s.scan_profile_revision",
        "s.metadata_profile_revision",
        "l.catalog_version",
        "s.last_scan_at",
        "s.created_at",
        "s.updated_at",
      )
      .count({ item_count: "m.id" })
      .whereNull("s.deleted_at")
      .groupBy(
        "s.id",
        "s.tenant_id",
        "s.owner_user_id",
        "u.username",
        "s.library_id",
        "s.display_name",
        "s.provider_type",
        "s.data_type",
        "s.status",
        "s.connection_status",
        "s.credential_revision",
        "s.scan_profile_revision",
        "s.metadata_profile_revision",
        "l.catalog_version",
        "s.last_scan_at",
        "s.created_at",
        "s.updated_at",
      );
  }

  /** 创建服务、媒体库、加密凭据和首个配置修订。 */
  public async createService(input: {
    serviceId: string;
    libraryId: string;
    tenantId: string;
    ownerUserId: string;
    displayName: string;
    providerType: string;
    dataType: MediaType;
    encryptedConnection: string;
    providerSchemaVersion: number;
    scanProfile: Record<string, unknown>;
    metadataProfile: Record<string, unknown>;
    binding?: { id: string; clientDeviceId: string; clientServiceId: string };
  }): Promise<ServiceDetailRecord> {
    const now = new Date().toISOString();
    await this.database.query.transaction(async (transaction) => {
      await transaction("cloud_services").insert({
        id: input.serviceId,
        tenant_id: input.tenantId,
        owner_user_id: input.ownerUserId,
        library_id: input.libraryId,
        display_name: input.displayName,
        provider_type: input.providerType,
        data_type: input.dataType,
        status: "active",
        connection_status: "valid",
        credential_revision: 1,
        scan_profile_revision: 1,
        metadata_profile_revision: 1,
        last_scan_at: null,
        created_at: now,
        updated_at: now,
        deleted_at: null,
      });
      await transaction("media_libraries").insert({
        id: input.libraryId,
        tenant_id: input.tenantId,
        service_id: input.serviceId,
        provider_type: input.providerType,
        catalog_version: 0,
        status: "active",
        created_at: now,
        updated_at: now,
      });
      await transaction("service_credentials").insert({
        id: randomUUID(),
        tenant_id: input.tenantId,
        service_id: input.serviceId,
        revision: 1,
        encrypted_payload: input.encryptedConnection,
        key_version: 1,
        schema_version: input.providerSchemaVersion,
        status: "active",
        created_at: now,
      });
      await transaction("service_scan_profiles").insert({
        id: randomUUID(),
        tenant_id: input.tenantId,
        service_id: input.serviceId,
        revision: 1,
        configuration_json: JSON.stringify(input.scanProfile),
        created_at: now,
      });
      await transaction("service_metadata_profiles").insert({
        id: randomUUID(),
        tenant_id: input.tenantId,
        service_id: input.serviceId,
        revision: 1,
        configuration_json: JSON.stringify(input.metadataProfile),
        created_at: now,
      });
      if (input.binding) {
        await transaction("client_service_links").insert({
          id: input.binding.id,
          tenant_id: input.tenantId,
          service_id: input.serviceId,
          client_device_id: input.binding.clientDeviceId,
          client_service_id: input.binding.clientServiceId,
          provider_type: input.providerType,
          created_at: now,
          updated_at: now,
        });
      }
    });
    return this.getServiceDetail(input.serviceId, input.tenantId);
  }

  /** 列出当前租户或管理端指定范围内的服务。 */
  public async listServices(filters: {
    tenantId?: string;
    ownerUserId?: string;
    providerType?: string;
    status?: ServiceStatus;
    keyword?: string;
    limit: number;
    offset: number;
  }): Promise<{ items: CloudServiceRecord[]; total: number }> {
    const query = this.serviceSummaryQuery();
    const countQuery = this.database.query("cloud_services as s").whereNull("s.deleted_at");
    if (filters.tenantId) {
      query.where("s.tenant_id", filters.tenantId);
      countQuery.where("s.tenant_id", filters.tenantId);
    }
    if (filters.ownerUserId) {
      query.where("s.owner_user_id", filters.ownerUserId);
      countQuery.where("s.owner_user_id", filters.ownerUserId);
    }
    if (filters.providerType) {
      query.where("s.provider_type", filters.providerType);
      countQuery.where("s.provider_type", filters.providerType);
    }
    if (filters.status) {
      query.where("s.status", filters.status);
      countQuery.where("s.status", filters.status);
    }
    if (filters.keyword) {
      query.whereLike("s.display_name", `%${filters.keyword}%`);
      countQuery.whereLike("s.display_name", `%${filters.keyword}%`);
    }
    const [rows, countRow] = await Promise.all([
      query.orderBy("s.created_at", "desc").limit(filters.limit).offset(filters.offset) as unknown as Promise<ServiceRow[]>,
      countQuery.count<{ count: string | number }[]>({ count: "s.id" }).first(),
    ]);
    return { items: rows.map(mapService), total: Number(countRow?.count ?? 0) };
  }

  /** 按完整租户作用域查询服务详情，不返回凭据明文。 */
  public async getServiceDetail(serviceId: string, tenantId?: string): Promise<ServiceDetailRecord> {
    const query = this.serviceSummaryQuery().where("s.id", serviceId);
    if (tenantId) {
      query.where("s.tenant_id", tenantId);
    }
    const row = (await query.first()) as ServiceRow | undefined;
    if (!row) {
      throw new ApiError(404, "service_not_found", "云端服务不存在");
    }
    const [scanProfileRow, metadataProfileRow, credentialRow, bindings, recentJobs] = await Promise.all([
      this.database.query("service_scan_profiles").where({ service_id: serviceId, revision: Number(row.scan_profile_revision) }).first(),
      this.database.query("service_metadata_profiles").where({ service_id: serviceId, revision: Number(row.metadata_profile_revision) }).first(),
      this.database.query("service_credentials").where({ service_id: serviceId, revision: Number(row.credential_revision), status: "active" }).first(),
      this.database.query("client_service_links").select("id", "client_device_id", "client_service_id", "provider_type", "updated_at").where({ service_id: serviceId }).orderBy("updated_at", "desc"),
      this.listJobs({ tenantId: row.tenant_id, serviceId, limit: 10, offset: 0 }).then((result) => result.items),
    ]);
    return {
      ...mapService(row),
      scanProfile: parseJsonObject(scanProfileRow?.configuration_json),
      metadataProfile: parseJsonObject(metadataProfileRow?.configuration_json),
      credentialConfigured: Boolean(credentialRow),
      bindings: bindings.map((binding) => ({
        bindingId: binding.id,
        clientDeviceId: binding.client_device_id,
        clientServiceId: binding.client_service_id,
        providerType: binding.provider_type,
        updatedAt: binding.updated_at,
      })),
      recentJobs,
    };
  }

  /** 取得 Worker 使用的冻结连接和配置修订。 */
  public async getJobRuntimeConfiguration(job: ScanJobRecord): Promise<{
    encryptedConnection: string;
    providerType: string;
    scanProfile: Record<string, unknown>;
    metadataProfile: Record<string, unknown>;
  }> {
    const credentialRevision = Number(job.snapshot.credentialRevision);
    const scanProfileRevision = Number(job.snapshot.scanProfileRevision);
    const metadataProfileRevision = Number(job.snapshot.metadataProfileRevision);
    const [service, credential, scanProfile, metadataProfile] = await Promise.all([
      this.database.query("cloud_services").where({ id: job.serviceId, tenant_id: job.tenantId }).whereNull("deleted_at").first(),
      this.database.query("service_credentials").where({ service_id: job.serviceId, tenant_id: job.tenantId, revision: credentialRevision, status: "active" }).first(),
      this.database.query("service_scan_profiles").where({ service_id: job.serviceId, tenant_id: job.tenantId, revision: scanProfileRevision }).first(),
      this.database.query("service_metadata_profiles").where({ service_id: job.serviceId, tenant_id: job.tenantId, revision: metadataProfileRevision }).first(),
    ]);
    if (!service || !credential || !scanProfile || !metadataProfile) {
      throw new ApiError(410, "job_configuration_unavailable", "任务冻结配置已经不可用");
    }
    return {
      encryptedConnection: String(credential.encrypted_payload),
      providerType: String(service.provider_type),
      scanProfile: parseJsonObject(scanProfile.configuration_json),
      metadataProfile: parseJsonObject(metadataProfile.configuration_json),
    };
  }

  /** 读取服务当前活动凭据密文，供扫描根更新前执行真实访问校验。 */
  public async getActiveEncryptedConnection(serviceId: string, tenantId: string): Promise<string> {
    const service = await this.database.query("cloud_services")
      .where({ id: serviceId, tenant_id: tenantId })
      .whereNull("deleted_at")
      .first();
    if (!service) throw new ApiError(404, "service_not_found", "云端服务不存在");
    const credential = await this.database.query("service_credentials").where({
      service_id: serviceId,
      tenant_id: tenantId,
      revision: Number(service.credential_revision),
      status: "active",
    }).first();
    if (!credential) throw new ApiError(410, "service_credential_unavailable", "服务当前凭据不可用");
    return String(credential.encrypted_payload);
  }

  /** 更新服务连接并生成不可变凭据修订。 */
  public async updateConnection(input: {
    serviceId: string;
    tenantId: string;
    encryptedConnection: string;
    providerSchemaVersion: number;
  }): Promise<ServiceDetailRecord> {
    await this.database.query.transaction(async (transaction) => {
      const service = await transaction("cloud_services").where({ id: input.serviceId, tenant_id: input.tenantId }).whereNull("deleted_at").first();
      if (!service) {
        throw new ApiError(404, "service_not_found", "云端服务不存在");
      }
      const revision = Number(service.credential_revision) + 1;
      const now = new Date().toISOString();
      await transaction("service_credentials").insert({
        id: randomUUID(),
        tenant_id: input.tenantId,
        service_id: input.serviceId,
        revision,
        encrypted_payload: input.encryptedConnection,
        key_version: 1,
        schema_version: input.providerSchemaVersion,
        status: "active",
        created_at: now,
      });
      await transaction("cloud_services").where({ id: input.serviceId }).update({
        credential_revision: revision,
        connection_status: "valid",
        status: service.status === "reauthorization_required" ? "active" : service.status,
        updated_at: now,
      });
    });
    return this.getServiceDetail(input.serviceId, input.tenantId);
  }

  /** 当前保存的凭据重新验证成功后恢复连接状态，不创建新的凭据修订。 */
  public async restoreServiceConnection(
    serviceId: string,
    tenantId: string | undefined,
  ): Promise<ServiceDetailRecord> {
    const serviceQuery = this.database.query("cloud_services")
      .where({ id: serviceId })
      .whereNull("deleted_at");
    if (tenantId) serviceQuery.where({ tenant_id: tenantId });
    const service = await serviceQuery.first();
    if (!service) throw new ApiError(404, "service_not_found", "云端服务不存在");
    const now = new Date().toISOString();
    // 关键变量：用户主动停用的服务不能因为连接验证成功被意外启用。
    const nextStatus = service.status === "reauthorization_required" ? "active" : service.status;
    await this.database.query("cloud_services").where({ id: serviceId }).update({
      connection_status: "valid",
      status: nextStatus,
      updated_at: now,
    });
    return this.getServiceDetail(serviceId, tenantId);
  }

  /** 更新扫描配置并生成不可变修订。 */
  public async updateScanProfile(serviceId: string, tenantId: string, profile: Record<string, unknown>): Promise<ServiceDetailRecord> {
    await this.updateProfileRevision("scan", serviceId, tenantId, profile);
    return this.getServiceDetail(serviceId, tenantId);
  }

  /** 更新元数据配置并生成不可变修订。 */
  public async updateMetadataProfile(serviceId: string, tenantId: string, profile: Record<string, unknown>): Promise<ServiceDetailRecord> {
    await this.updateProfileRevision("metadata", serviceId, tenantId, profile);
    return this.getServiceDetail(serviceId, tenantId);
  }

  /** 生成指定类型的配置修订并原子更新当前指针。 */
  private async updateProfileRevision(
    type: "scan" | "metadata",
    serviceId: string,
    tenantId: string,
    profile: Record<string, unknown>,
  ): Promise<void> {
    const tableName = type === "scan" ? "service_scan_profiles" : "service_metadata_profiles";
    const revisionColumn = type === "scan" ? "scan_profile_revision" : "metadata_profile_revision";
    await this.database.query.transaction(async (transaction) => {
      const service = await transaction("cloud_services").where({ id: serviceId, tenant_id: tenantId }).whereNull("deleted_at").first();
      if (!service) {
        throw new ApiError(404, "service_not_found", "云端服务不存在");
      }
      const revision = Number(service[revisionColumn]) + 1;
      const now = new Date().toISOString();
      await transaction(tableName).insert({
        id: randomUUID(),
        tenant_id: tenantId,
        service_id: serviceId,
        revision,
        configuration_json: JSON.stringify(profile),
        created_at: now,
      });
      await transaction("cloud_services").where({ id: serviceId }).update({
        [revisionColumn]: revision,
        updated_at: now,
      });
    });
  }

  /** 建立客户端本地服务到既有云端服务的绑定，不改写服务配置。 */
  public async bindClientService(input: {
    bindingId: string;
    tenantId: string;
    serviceId: string;
    clientDeviceId: string;
    clientServiceId: string;
    providerType: string;
  }): Promise<{ bindingId: string; serviceId: string; libraryId: string; catalogVersion: number }> {
    const service = await this.getServiceDetail(input.serviceId, input.tenantId);
    if (service.providerType !== input.providerType) {
      throw new ApiError(409, "provider_type_conflict", "本地服务与云端服务 Provider 类型不一致");
    }
    const now = new Date().toISOString();
    const existing = await this.database.query("client_service_links").where({
      tenant_id: input.tenantId,
      client_device_id: input.clientDeviceId,
      client_service_id: input.clientServiceId,
    }).first();
    if (existing && existing.service_id !== input.serviceId) {
      throw new ApiError(409, "client_binding_conflict", "该本地服务已经绑定其他云端服务");
    }
    if (existing) {
      await this.database.query("client_service_links").where({ id: existing.id }).update({ updated_at: now });
      return { bindingId: String(existing.id), serviceId: service.id, libraryId: service.libraryId, catalogVersion: service.catalogVersion };
    }
    await this.database.query("client_service_links").insert({
      id: input.bindingId,
      tenant_id: input.tenantId,
      service_id: input.serviceId,
      client_device_id: input.clientDeviceId,
      client_service_id: input.clientServiceId,
      provider_type: input.providerType,
      created_at: now,
      updated_at: now,
    });
    return { bindingId: input.bindingId, serviceId: service.id, libraryId: service.libraryId, catalogVersion: service.catalogVersion };
  }

  /** 创建具备请求幂等和同服务单写互斥的扫描任务。 */
  public async createScanJob(input: {
    jobId: string;
    tenantId: string;
    serviceId: string;
    requestedByUserId: string;
    requestId: string;
    clientDeviceId: string;
    scanMode: "incremental" | "full";
    runtimeRevision: string;
    tmdbKeyPoolRevision: string;
    retryOfJobId?: string;
    pluginVersions: Array<{
      pluginId: string;
      version: string;
      sha256: string;
      configurationRevision: number;
    }>;
  }): Promise<ScanJobRecord> {
    const existing = await this.findJobByRequest(input.tenantId, input.clientDeviceId, input.requestId);
    if (existing) {
      return existing;
    }
    try {
      return await this.database.query.transaction(async (transaction) => {
        const service = await transaction("cloud_services").where({ id: input.serviceId, tenant_id: input.tenantId }).whereNull("deleted_at").first();
        if (!service) {
          throw new ApiError(404, "service_not_found", "云端服务不存在");
        }
        if (service.status !== "active") {
          throw new ApiError(409, "service_not_ready", "云端服务当前不能创建扫描任务");
        }
        const conflicting = await transaction("scan_jobs")
          .where({ service_id: input.serviceId })
          .whereIn("status", ["queued", "running", "paused"])
          .first();
        if (conflicting) {
          throw new ApiError(409, "scan_job_conflict", "该服务已有未结束的扫描任务");
        }
        const now = new Date().toISOString();
        const snapshot = {
          credentialRevision: Number(service.credential_revision),
          scanProfileRevision: Number(service.scan_profile_revision),
          metadataProfileRevision: Number(service.metadata_profile_revision),
          providerType: service.provider_type,
          runtimeRevision: input.runtimeRevision,
          tmdbKeyPoolRevision: input.tmdbKeyPoolRevision,
          retryOfJobId: input.retryOfJobId ?? null,
          pluginVersions: input.pluginVersions,
        };
        await transaction("scan_jobs").insert({
          id: input.jobId,
          tenant_id: input.tenantId,
          service_id: input.serviceId,
          library_id: service.library_id,
          requested_by_user_id: input.requestedByUserId,
          request_id: input.requestId,
          client_device_id: input.clientDeviceId,
          scan_mode: input.scanMode,
          status: "queued",
          stage: "queued",
          processed_count: 0,
          total_count: null,
          discovered_count: 0,
          skipped_count: 0,
          matched_count: 0,
          unmatched_count: 0,
          error_count: 0,
          current_path: null,
          error_code: null,
          error_message: null,
          snapshot_json: JSON.stringify(snapshot),
          control_action: "none",
          created_at: now,
          started_at: null,
          finished_at: null,
          updated_at: now,
        });
        await this.insertJobEvent(transaction, input.tenantId, input.jobId, "queued", {
          status: "queued",
          stage: "queued",
          retryOfJobId: input.retryOfJobId ?? null,
        });
        return this.getJob(input.jobId, input.tenantId, transaction);
      });
    } catch (error) {
      // 并发请求可能同时通过事务外查询；唯一索引冲突后返回已经创建的同一任务。
      const racedJob = await this.findJobByRequest(input.tenantId, input.clientDeviceId, input.requestId);
      if (racedJob) {
        return racedJob;
      }
      throw error;
    }
  }

  /** 按幂等键查询任务。 */
  private async findJobByRequest(tenantId: string, clientDeviceId: string, requestId: string): Promise<ScanJobRecord | null> {
    const row = await this.jobSummaryQuery().where({
      "j.tenant_id": tenantId,
      "j.client_device_id": clientDeviceId,
      "j.request_id": requestId,
    }).first() as JobRow | undefined;
    return row ? mapJob(row) : null;
  }

  /** 构造任务摘要公共查询。 */
  private jobSummaryQuery(transaction: Knex | Knex.Transaction = this.database.query) {
    return transaction("scan_jobs as j")
      .join("cloud_services as s", "s.id", "j.service_id")
      .join("user_accounts as u", "u.id", "s.owner_user_id")
      .select("j.*", "s.display_name as service_name", "s.data_type", "u.username as owner_username");
  }

  /** 查询单个任务并按需校验租户。 */
  public async getJob(
    jobId: string,
    tenantId?: string,
    transaction: Knex | Knex.Transaction = this.database.query,
  ): Promise<ScanJobRecord> {
    const query = this.jobSummaryQuery(transaction).where("j.id", jobId);
    if (tenantId) {
      query.where("j.tenant_id", tenantId);
    }
    const row = await query.first() as JobRow | undefined;
    if (!row) {
      throw new ApiError(404, "scan_job_not_found", "扫描任务不存在");
    }
    return mapJob(row);
  }

  /** 分页查询当前租户或管理端筛选范围内的任务。 */
  public async listJobs(filters: {
    tenantId?: string;
    ownerUserId?: string;
    serviceId?: string;
    status?: JobStatus;
    limit: number;
    offset: number;
  }): Promise<{ items: ScanJobRecord[]; total: number }> {
    const query = this.jobSummaryQuery();
    const countQuery = this.database.query("scan_jobs as j").join("cloud_services as s", "s.id", "j.service_id");
    if (filters.tenantId) {
      query.where("j.tenant_id", filters.tenantId);
      countQuery.where("j.tenant_id", filters.tenantId);
    }
    if (filters.ownerUserId) {
      query.where("s.owner_user_id", filters.ownerUserId);
      countQuery.where("s.owner_user_id", filters.ownerUserId);
    }
    if (filters.serviceId) {
      query.where("j.service_id", filters.serviceId);
      countQuery.where("j.service_id", filters.serviceId);
    }
    if (filters.status) {
      query.where("j.status", filters.status);
      countQuery.where("j.status", filters.status);
    }
    const [rows, countRow] = await Promise.all([
      query.orderBy("j.created_at", "desc").limit(filters.limit).offset(filters.offset) as unknown as Promise<JobRow[]>,
      countQuery.count<{ count: string | number }[]>({ count: "j.id" }).first(),
    ]);
    return { items: rows.map(mapJob), total: Number(countRow?.count ?? 0) };
  }

  /** 领取一个排队任务，避免同一进程重复执行。 */
  public async claimNextQueuedJob(): Promise<ScanJobRecord | null> {
    return this.database.query.transaction(async (transaction) => {
      const row = await transaction("scan_jobs").where({ status: "queued" }).orderBy("created_at", "asc").first();
      if (!row) {
        return null;
      }
      const now = new Date().toISOString();
      const changed = await transaction("scan_jobs").where({ id: row.id, status: "queued" }).update({
        status: "running",
        stage: "enumerating",
        control_action: "none",
        started_at: row.started_at ?? now,
        updated_at: now,
      });
      if (changed !== 1) {
        return null;
      }
      await transaction("cloud_services").where({ id: row.service_id }).update({ status: "scanning", updated_at: now });
      await this.insertJobEvent(transaction, String(row.tenant_id), String(row.id), "progress", {
        status: "running",
        stage: "enumerating",
      });
      return this.getJob(String(row.id), String(row.tenant_id), transaction);
    });
  }

  /** 单实例进程启动时把异常中断的运行任务恢复到队列。 */
  public async recoverInterruptedJobs(): Promise<number> {
    const rows = await this.database.query("scan_jobs")
      .select("id", "tenant_id", "service_id")
      .where({ status: "running" });
    if (rows.length === 0) return 0;
    const now = new Date().toISOString();
    await this.database.query.transaction(async (transaction) => {
      for (const row of rows) {
        await transaction("scan_jobs").where({ id: row.id, status: "running" }).update({
          status: "queued",
          stage: "queued",
          control_action: "none",
          updated_at: now,
        });
        await transaction("cloud_services").where({ id: row.service_id, status: "scanning" }).update({
          status: "active",
          updated_at: now,
        });
        await this.insertJobEvent(transaction, String(row.tenant_id), String(row.id), "queued", {
          status: "queued",
          recoveredAfterRestart: true,
        });
      }
    });
    return rows.length;
  }

  /** 更新任务阶段和进度并写入可重放事件。 */
  public async updateJobProgress(jobId: string, input: {
    stage?: JobStage;
    processedCount?: number;
    totalCount?: number | null;
    discoveredCount?: number;
    skippedCount?: number;
    matchedCount?: number;
    unmatchedCount?: number;
    errorCount?: number;
    currentPath?: string | null;
  }): Promise<ScanJobRecord> {
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (input.stage !== undefined) patch.stage = input.stage;
    if (input.processedCount !== undefined) patch.processed_count = input.processedCount;
    if (input.totalCount !== undefined) patch.total_count = input.totalCount;
    if (input.discoveredCount !== undefined) patch.discovered_count = input.discoveredCount;
    if (input.skippedCount !== undefined) patch.skipped_count = input.skippedCount;
    if (input.matchedCount !== undefined) patch.matched_count = input.matchedCount;
    if (input.unmatchedCount !== undefined) patch.unmatched_count = input.unmatchedCount;
    if (input.errorCount !== undefined) patch.error_count = input.errorCount;
    if (input.currentPath !== undefined) patch.current_path = input.currentPath;
    await this.database.query("scan_jobs").where({ id: jobId }).update(patch);
    const job = await this.getJob(jobId);
    await this.addJobEvent(job.tenantId, job.id, "progress", {
      status: job.status,
      stage: job.stage,
      processedCount: job.processedCount,
      totalCount: job.totalCount,
      discoveredCount: job.discoveredCount,
      skippedCount: job.skippedCount,
      matchedCount: job.matchedCount,
      unmatchedCount: job.unmatchedCount,
      errorCount: job.errorCount,
      currentPath: job.currentPath,
    });
    return job;
  }

  /** 完成、失败、暂停或取消任务并恢复服务状态。 */
  public async finishJob(jobId: string, input: {
    status: "completed" | "failed" | "paused" | "cancelled";
    errorCode?: string | null;
    errorMessage?: string | null;
  }): Promise<ScanJobRecord> {
    const current = await this.getJob(jobId);
    const now = new Date().toISOString();
    const finishedAt = input.status === "paused" ? null : now;
    await this.database.query.transaction(async (transaction) => {
      await transaction("scan_jobs").where({ id: jobId }).update({
        status: input.status,
        stage: input.status === "completed" ? "completed" : current.stage,
        error_code: input.errorCode ?? null,
        error_message: input.errorMessage ?? null,
        control_action: "none",
        finished_at: finishedAt,
        updated_at: now,
      });
      const servicePatch: Record<string, unknown> = {
        status: input.errorCode === "provider_authentication_failed" ? "reauthorization_required" : "active",
        connection_status: input.errorCode === "provider_authentication_failed" ? "reauthorization_required" : "valid",
        updated_at: now,
      };
      if (input.status === "completed") servicePatch.last_scan_at = now;
      await transaction("cloud_services").where({ id: current.serviceId }).update(servicePatch);
      await this.insertJobEvent(transaction, current.tenantId, current.id, input.status, {
        status: input.status,
        stage: input.status === "completed" ? "completed" : current.stage,
        errorCode: input.errorCode ?? null,
        errorMessage: input.errorMessage ?? null,
      });
    });
    return this.getJob(jobId);
  }

  /** 写入任务控制请求，Worker 在安全检查点执行。 */
  public async requestJobControl(jobId: string, tenantId: string | undefined, action: "pause" | "cancel"): Promise<ScanJobRecord> {
    const job = await this.getJob(jobId, tenantId);
    if (!(["queued", "running", "paused"] as JobStatus[]).includes(job.status)) {
      throw new ApiError(409, "job_not_controllable", "当前任务状态不能执行该操作");
    }
    if ((job.status === "queued" || job.status === "paused") && action === "cancel") {
      return this.finishJob(job.id, { status: "cancelled" });
    }
    if (job.status === "queued" && action === "pause") {
      return this.finishJob(job.id, { status: "paused" });
    }
    if (job.status === "paused") {
      throw new ApiError(409, "job_already_paused", "任务已经暂停");
    }
    await this.database.query("scan_jobs").where({ id: job.id }).update({
      control_action: action,
      updated_at: new Date().toISOString(),
    });
    return this.getJob(job.id);
  }

  /** 删除已经进入终态的扫描任务及其事件；运行中任务必须先取消。 */
  public async deleteScanJob(jobId: string, tenantId?: string): Promise<void> {
    const job = await this.getJob(jobId, tenantId);
    if ((["queued", "running", "paused"] as JobStatus[]).includes(job.status)) {
      throw new ApiError(409, "scan_job_active", "请先终止扫描任务，再删除任务记录");
    }
    await this.database.query.transaction(async (transaction) => {
      await transaction("scan_job_events").where({ job_id: job.id }).delete();
      const deleted = await transaction("scan_jobs").where({ id: job.id }).delete();
      if (deleted !== 1) throw new ApiError(404, "scan_job_not_found", "扫描任务不存在");
    });
  }

  /** 恢复暂停任务，继续使用原冻结配置。 */
  public async resumeJob(jobId: string, tenantId?: string): Promise<ScanJobRecord> {
    const job = await this.getJob(jobId, tenantId);
    if (job.status !== "paused") {
      throw new ApiError(409, "job_not_paused", "只有暂停任务可以继续");
    }
    await this.database.query("scan_jobs").where({ id: job.id }).update({
      status: "queued",
      control_action: "none",
      updated_at: new Date().toISOString(),
    });
    await this.addJobEvent(job.tenantId, job.id, "queued", { status: "queued", resumed: true });
    return this.getJob(job.id);
  }

  /** 查询 Worker 当前需要执行的控制动作。 */
  public async getJobControl(jobId: string): Promise<"none" | "pause" | "cancel"> {
    const row = await this.database.query("scan_jobs").select("control_action").where({ id: jobId }).first();
    return (row?.control_action as "none" | "pause" | "cancel" | undefined) ?? "cancel";
  }

  /** 在现有事务内插入任务事件。 */
  private async insertJobEvent(
    transaction: Knex | Knex.Transaction,
    tenantId: string,
    jobId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await transaction("scan_job_events").insert({
      tenant_id: tenantId,
      job_id: jobId,
      event_type: eventType,
      payload_json: JSON.stringify(payload),
      created_at: new Date().toISOString(),
    });
  }

  /** 插入持久化任务事件。 */
  public async addJobEvent(tenantId: string, jobId: string, eventType: string, payload: Record<string, unknown>): Promise<void> {
    await this.insertJobEvent(this.database.query, tenantId, jobId, eventType, payload);
  }

  /** 按事件游标读取任务事件。 */
  public async listJobEvents(filters: { tenantId?: string; jobId?: string; afterSequence: number; limit: number }): Promise<JobEventRecord[]> {
    const query = this.database.query("scan_job_events").where("sequence", ">", filters.afterSequence);
    if (filters.tenantId) query.where("tenant_id", filters.tenantId);
    if (filters.jobId) query.where("job_id", filters.jobId);
    const rows = await query.orderBy("sequence", "asc").limit(filters.limit);
    return rows.map((row) => ({
      sequence: Number(row.sequence),
      tenantId: String(row.tenant_id),
      jobId: String(row.job_id),
      eventType: String(row.event_type),
      payload: parseJsonObject(row.payload_json),
      createdAt: String(row.created_at),
    }));
  }

  /** 更新服务启停状态。 */
  public async updateServiceStatus(serviceId: string, tenantId: string | undefined, status: "active" | "disabled"): Promise<ServiceDetailRecord> {
    if (status === "disabled") {
      const activeJob = await this.database.query("scan_jobs")
        .where({ service_id: serviceId })
        .whereIn("status", ["queued", "running", "paused"])
        .first();
      if (activeJob) throw new ApiError(409, "service_has_active_job", "服务仍有未结束任务，不能停用");
    }
    const query = this.database.query("cloud_services").where({ id: serviceId }).whereNull("deleted_at");
    if (tenantId) query.where({ tenant_id: tenantId });
    const changed = await query.update({ status, updated_at: new Date().toISOString() });
    if (changed !== 1) throw new ApiError(404, "service_not_found", "云端服务不存在");
    return this.getServiceDetail(serviceId, tenantId);
  }

  /** 软删除服务，并同步从活动媒体统计和扫描来源中移除关联数据。 */
  public async deleteService(serviceId: string, tenantId?: string): Promise<void> {
    await this.database.query.transaction(async (transaction) => {
      const serviceQuery = transaction("cloud_services").where({ id: serviceId }).whereNull("deleted_at");
      if (tenantId) serviceQuery.where({ tenant_id: tenantId });
      const service = await serviceQuery.first();
      if (!service) throw new ApiError(404, "service_not_found", "云端服务不存在");
      const running = await transaction("scan_jobs").where({ service_id: serviceId }).whereIn("status", ["queued", "running", "paused"]).first();
      if (running) throw new ApiError(409, "service_has_active_job", "服务仍有未结束任务");
      const now = new Date().toISOString();
      await transaction("media_items").where({ service_id: serviceId }).whereNull("deleted_at").update({ deleted_at: now, updated_at: now });
      await transaction("source_files").where({ service_id: serviceId }).update({ status: "missing", updated_at: now });
      await transaction("media_libraries").where({ service_id: serviceId }).update({ status: "disabled", updated_at: now });
      await transaction("cloud_services").where({ id: serviceId }).update({ status: "disabled", deleted_at: now, updated_at: now });
    });
  }

  /** 清空单个服务的扫描文件、刮削条目和目录变更，保留服务连接、配置与任务历史。 */
  public async clearServiceCatalog(serviceId: string, tenantId?: string): Promise<{
    mediaItemCount: number;
    sourceFileCount: number;
  }> {
    return this.database.query.transaction(async (transaction) => {
      const serviceQuery = transaction("cloud_services").where({ id: serviceId }).whereNull("deleted_at");
      if (tenantId) serviceQuery.where({ tenant_id: tenantId });
      const service = await serviceQuery.first();
      if (!service) throw new ApiError(404, "service_not_found", "云端服务不存在");
      const activeJob = await transaction("scan_jobs")
        .where({ service_id: serviceId })
        .whereIn("status", ["queued", "running", "paused"])
        .first();
      if (activeJob) throw new ApiError(409, "service_has_active_job", "请先终止该服务的扫描任务，再清空媒体库");

      const libraryId = String(service.library_id);
      const mediaItemCountRow = await transaction("media_items")
        .where({ library_id: libraryId })
        .count<{ count: string | number }[]>({ count: "id" })
        .first();
      const sourceFileCountRow = await transaction("source_files")
        .where({ library_id: libraryId })
        .count<{ count: string | number }[]>({ count: "id" })
        .first();
      // 关键变量：显式按媒体库删除关联表，确保不同服务的数据不会被一起清空。
      await transaction("file_links").where({ library_id: libraryId }).delete();
      await transaction("media_relations").where({ library_id: libraryId }).delete();
      await transaction("media_items").where({ library_id: libraryId }).delete();
      await transaction("source_files").where({ library_id: libraryId }).delete();
      await transaction("catalog_changes").where({ library_id: libraryId }).delete();
      await transaction("media_libraries").where({ id: libraryId }).update({
        catalog_version: 0,
        status: "active",
        updated_at: new Date().toISOString(),
      });
      await transaction("cloud_services").where({ id: serviceId }).update({
        last_scan_at: null,
        updated_at: new Date().toISOString(),
      });
      return {
        mediaItemCount: Number(mediaItemCountRow?.count ?? 0),
        sourceFileCount: Number(sourceFileCountRow?.count ?? 0),
      };
    });
  }

  /** 若源文件属性和播放定位均未变化，只推进本轮扫描标记并返回现有记录。 */
  public async markSourceFileSeenIfUnchanged(input: SourceFileRecord): Promise<SourceFileRecord | null> {
    const row = await this.database.query("source_files").where({
      tenant_id: input.tenantId,
      library_id: input.libraryId,
      provider_resource_id: input.providerResourceId,
    }).first();
    if (!row) {
      return null;
    }
    const unchanged = row.status === "active"
      && String(row.parent_resource_id ?? "") === String(input.parentResourceId ?? "")
      && String(row.path) === input.path
      && String(row.name) === input.name
      && Number(row.size) === input.size
      && String(row.modified_at ?? "") === String(input.modifiedAt ?? "")
      && String(row.etag ?? "") === String(input.etag ?? "")
      && String(row.locator_json) === JSON.stringify(input.locator);
    if (!unchanged) {
      return null;
    }
    await this.database.query("source_files").where({ id: row.id }).update({
      generation_id: input.generationId,
      updated_at: new Date().toISOString(),
    });
    return { ...input, id: String(row.id) };
  }

  /** upsert 扫描发现的源文件并返回稳定记录。 */
  public async upsertSourceFile(input: SourceFileRecord): Promise<SourceFileRecord> {
    const now = new Date().toISOString();
    await this.database.query("source_files")
      .insert({
        id: input.id,
        tenant_id: input.tenantId,
        service_id: input.serviceId,
        library_id: input.libraryId,
        provider_resource_id: input.providerResourceId,
        parent_resource_id: input.parentResourceId,
        path: input.path,
        name: input.name,
        extension: input.extension,
        size: input.size,
        modified_at: input.modifiedAt,
        etag: input.etag,
        generation_id: input.generationId,
        locator_json: JSON.stringify(input.locator),
        status: "active",
        created_at: now,
        updated_at: now,
      })
      .onConflict(["tenant_id", "library_id", "provider_resource_id"])
      .merge({
        parent_resource_id: input.parentResourceId,
        path: input.path,
        name: input.name,
        extension: input.extension,
        size: input.size,
        modified_at: input.modifiedAt,
        etag: input.etag,
        generation_id: input.generationId,
        locator_json: JSON.stringify(input.locator),
        status: "active",
        updated_at: now,
      });
    const row = await this.database.query("source_files").where({
      tenant_id: input.tenantId,
      library_id: input.libraryId,
      provider_resource_id: input.providerResourceId,
    }).first();
    return {
      ...input,
      id: String(row.id),
    };
  }

  /** upsert 媒体条目并返回条目内容是否发生真实变化。 */
  public async upsertMediaItem(input: {
    id: string;
    tenantId: string;
    serviceId: string;
    libraryId: string;
    identityKey: string;
    mediaType: MediaType;
    itemType: string;
    title: string;
    sortTitle: string;
    subtitle: string;
    year: number | null;
    overview: string;
    posterUrl: string | null;
    backdropUrl: string | null;
    matchState: MatchState;
    externalIds: Record<string, string>;
    metadata: Record<string, unknown>;
    generationId: string;
  }): Promise<{ itemId: string; changed: boolean }> {
    const existing = await this.database.query("media_items").where({
      tenant_id: input.tenantId,
      library_id: input.libraryId,
      identity_key: input.identityKey,
    }).first();
    const itemId = existing ? String(existing.id) : input.id;
    const existingMetadata = existing ? parseJsonObject(existing.metadata_json) : {};
    const hasManualMatch = Object.keys(asObject(existingMetadata.manualMatch)).length > 0;
    // 关键变量：人工匹配结果优先于后续自动扫描，但扫描仍刷新 generation，避免条目被全量扫描误删。
    const effectiveInput = hasManualMatch && existing ? {
      ...input,
      mediaType: existing.media_type as MediaType,
      itemType: String(existing.item_type),
      title: String(existing.title),
      sortTitle: String(existing.sort_title),
      subtitle: String(existing.subtitle),
      year: existing.year === null || existing.year === undefined ? null : Number(existing.year),
      overview: String(existing.overview),
      posterUrl: existing.poster_url ? String(existing.poster_url) : null,
      backdropUrl: existing.backdrop_url ? String(existing.backdrop_url) : null,
      matchState: existing.match_state as MatchState,
      externalIds: Object.fromEntries(Object.entries(parseJsonObject(existing.external_ids_json)).map(([key, value]) => [key, String(value)])),
      metadata: existingMetadata,
    } : input;
    const externalIdsJson = JSON.stringify(effectiveInput.externalIds);
    const metadataJson = JSON.stringify(effectiveInput.metadata);
    const premiereDate = readMediaPremiereDate(effectiveInput.metadata);
    const changed = !existing
      || existing.deleted_at !== null
      || String(existing.media_type) !== effectiveInput.mediaType
      || String(existing.item_type) !== effectiveInput.itemType
      || String(existing.title) !== effectiveInput.title
      || String(existing.sort_title) !== effectiveInput.sortTitle
      || String(existing.subtitle) !== effectiveInput.subtitle
      || (existing.year === null ? null : Number(existing.year)) !== effectiveInput.year
      || String(existing.premiere_date ?? "") !== String(premiereDate ?? "")
      || String(existing.overview) !== effectiveInput.overview
      || String(existing.poster_url ?? "") !== String(effectiveInput.posterUrl ?? "")
      || String(existing.backdrop_url ?? "") !== String(effectiveInput.backdropUrl ?? "")
      || String(existing.match_state) !== effectiveInput.matchState
      || String(existing.external_ids_json) !== externalIdsJson
      || String(existing.metadata_json) !== metadataJson;
    const now = new Date().toISOString();
    await this.database.query("media_items")
      .insert({
        id: itemId,
        tenant_id: input.tenantId,
        service_id: input.serviceId,
        library_id: input.libraryId,
        identity_key: input.identityKey,
        media_type: effectiveInput.mediaType,
        item_type: effectiveInput.itemType,
        title: effectiveInput.title,
        sort_title: effectiveInput.sortTitle,
        subtitle: effectiveInput.subtitle,
        year: effectiveInput.year,
        premiere_date: premiereDate,
        overview: effectiveInput.overview,
        poster_url: effectiveInput.posterUrl,
        backdrop_url: effectiveInput.backdropUrl,
        match_state: effectiveInput.matchState,
        external_ids_json: externalIdsJson,
        metadata_json: metadataJson,
        generation_id: input.generationId,
        created_at: now,
        updated_at: now,
        deleted_at: null,
      })
      .onConflict(["tenant_id", "library_id", "identity_key"])
      .merge({
        media_type: effectiveInput.mediaType,
        item_type: effectiveInput.itemType,
        title: effectiveInput.title,
        sort_title: effectiveInput.sortTitle,
        subtitle: effectiveInput.subtitle,
        year: effectiveInput.year,
        premiere_date: premiereDate,
        overview: effectiveInput.overview,
        poster_url: effectiveInput.posterUrl,
        backdrop_url: effectiveInput.backdropUrl,
        match_state: effectiveInput.matchState,
        external_ids_json: externalIdsJson,
        metadata_json: metadataJson,
        generation_id: input.generationId,
        updated_at: now,
        deleted_at: null,
      });
    if (hasManualMatch && effectiveInput.itemType === "video.series") {
      const childIds = await this.database.query("media_relations")
        .select("child_item_id")
        .where({ tenant_id: input.tenantId, parent_item_id: itemId });
      if (childIds.length > 0) {
        await this.database.query("media_items")
          .whereIn("id", childIds.map((row) => String(row.child_item_id)))
          .update({ generation_id: input.generationId, updated_at: now, deleted_at: null });
      }
    }
    return { itemId, changed };
  }

  /** 关联媒体条目与源文件定位。 */
  public async linkItemFile(input: { tenantId: string; libraryId: string; itemId: string; sourceFileId: string; locator: Record<string, unknown> }): Promise<void> {
    let targetItemId = input.itemId;
    const parentRow = await this.database.query("media_items").select("item_type", "metadata_json").where({
      id: input.itemId,
      tenant_id: input.tenantId,
      library_id: input.libraryId,
    }).first();
    const parentHasManualMatch = Object.keys(asObject(parseJsonObject(parentRow?.metadata_json).manualMatch)).length > 0;
    if (parentRow?.item_type === "video.series" && parentHasManualMatch) {
      // 人工把电影纠正成节目后，同一源文件后续扫描仍继续关联到已经创建的单集。
      const episodeLink = await this.database.query("media_relations as mr")
        .join("file_links as fl", "fl.item_id", "mr.child_item_id")
        .select("mr.child_item_id")
        .where("mr.tenant_id", input.tenantId)
        .where("mr.parent_item_id", input.itemId)
        .where("fl.source_file_id", input.sourceFileId)
        .first();
      if (episodeLink) targetItemId = String(episodeLink.child_item_id);
    }
    await this.database.query("file_links")
      .insert({
        id: randomUUID(),
        tenant_id: input.tenantId,
        library_id: input.libraryId,
        item_id: targetItemId,
        source_file_id: input.sourceFileId,
        locator_json: JSON.stringify(input.locator),
      })
      .onConflict(["tenant_id", "item_id", "source_file_id"])
      .merge({ locator_json: JSON.stringify(input.locator) });
  }

  /** 创建父子或领域关系，重复关系保持幂等。 */
  public async linkMediaRelation(input: { tenantId: string; libraryId: string; parentItemId: string; childItemId: string; relationType: string; sortOrder: number }): Promise<void> {
    const parentRow = await this.database.query("media_items").select("item_type", "metadata_json").where({
      id: input.parentItemId,
      tenant_id: input.tenantId,
      library_id: input.libraryId,
    }).first();
    const parentHasManualMatch = Object.keys(asObject(parseJsonObject(parentRow?.metadata_json).manualMatch)).length > 0;
    if (parentRow?.item_type === "video.movie" && parentHasManualMatch) {
      // 人工把节目纠正成电影后，扫描到的单集文件继续汇总到电影条目，不重新生成节目关系。
      const childLinks = await this.database.query("file_links").select("source_file_id", "locator_json").where({
        tenant_id: input.tenantId,
        library_id: input.libraryId,
        item_id: input.childItemId,
      });
      for (const childLink of childLinks) {
        await this.database.query("file_links").insert({
          id: randomUUID(),
          tenant_id: input.tenantId,
          library_id: input.libraryId,
          item_id: input.parentItemId,
          source_file_id: childLink.source_file_id,
          locator_json: childLink.locator_json,
        }).onConflict(["tenant_id", "item_id", "source_file_id"]).merge({ locator_json: childLink.locator_json });
      }
      return;
    }
    // 单集、曲目和章节只能属于一个同类型父项；解析规则修正后先移除旧父关系，避免海报墙残留错误节目。
    await this.database.query("media_relations").where({
      tenant_id: input.tenantId,
      library_id: input.libraryId,
      child_item_id: input.childItemId,
      relation_type: input.relationType,
    }).whereNot({ parent_item_id: input.parentItemId }).delete();
    await this.database.query("media_relations")
      .insert({
        id: randomUUID(),
        tenant_id: input.tenantId,
        library_id: input.libraryId,
        parent_item_id: input.parentItemId,
        child_item_id: input.childItemId,
        relation_type: input.relationType,
        sort_order: input.sortOrder,
      })
      .onConflict(["tenant_id", "parent_item_id", "child_item_id", "relation_type"])
      .merge({ sort_order: input.sortOrder });
  }

  /** 在成功 generation 后执行删除保护对账并推进目录版本。 */
  public async finalizeGeneration(input: {
    tenantId: string;
    serviceId: string;
    libraryId: string;
    generationId: string;
    deleteMissing: boolean;
    /** 枚举不完整时为 false，禁止执行任何可能删除已有目录内容的清理。 */
    allowDestructiveCleanup: boolean;
    changedItemIds: string[];
  }): Promise<number> {
    return this.database.query.transaction(async (transaction) => {
      const now = new Date().toISOString();
      const missingGenerationItems = input.deleteMissing
        ? await transaction("media_items")
          .select("id")
          .where({ tenant_id: input.tenantId, library_id: input.libraryId })
          .whereNot({ generation_id: input.generationId })
          .whereNull("deleted_at")
        : [];
      if (input.deleteMissing) {
        await transaction("source_files")
          .where({ tenant_id: input.tenantId, library_id: input.libraryId })
          .whereNot({ generation_id: input.generationId })
          .update({ status: "missing", updated_at: now });
        await transaction("media_items")
          .where({ tenant_id: input.tenantId, library_id: input.libraryId })
          .whereNot({ generation_id: input.generationId })
          .whereNull("deleted_at")
          .update({ deleted_at: now, updated_at: now });
      }
      // Flymby APP 在任一目录枚举失败后跳过本轮过期清理，避免把未访问目录中的旧数据误删。
      const excludedItemIds = input.allowDestructiveCleanup
        ? await this.cleanupExcludedCatalogPaths(transaction, input.tenantId, input.libraryId, now)
        : [];
      const orphanParentIds = input.allowDestructiveCleanup
        ? await this.cleanupOrphanCatalogParents(transaction, input.tenantId, input.libraryId, now)
        : [];
      const library = await transaction("media_libraries").where({ id: input.libraryId, tenant_id: input.tenantId }).first();
      if (!library) throw new ApiError(404, "library_not_found", "媒体库不存在");
      const previousCatalogVersion = Number(library.catalog_version);
      const deletedItemIds = new Set([
        ...missingGenerationItems.map((item) => String(item.id)),
        ...excludedItemIds,
        ...orphanParentIds,
      ]);
      const changedItemIds = [...new Set(input.changedItemIds)].filter((itemId) => !deletedItemIds.has(itemId));
      const changes = [
        ...changedItemIds.map((entityId) => ({ entityId, changeType: "upsert" })),
        ...[...deletedItemIds].map((entityId) => ({ entityId, changeType: "delete" })),
      ];
      const catalogVersion = previousCatalogVersion + changes.length;
      await transaction("media_libraries").where({ id: input.libraryId }).update({ catalog_version: catalogVersion, updated_at: now });
      if (changes.length > 0) {
        for (let offset = 0; offset < changes.length; offset += CATALOG_CHANGE_INSERT_BATCH_SIZE) {
          const changeBatch = changes.slice(offset, offset + CATALOG_CHANGE_INSERT_BATCH_SIZE);
          await transaction("catalog_changes").insert(changeBatch.map((change, batchIndex) => ({
            tenant_id: input.tenantId,
            library_id: input.libraryId,
            // 每条变化使用独立版本，afterVersion 分页不会跳过同一扫描批次的剩余条目。
            catalog_version: previousCatalogVersion + offset + batchIndex + 1,
            entity_type: "media_item",
            entity_id: change.entityId,
            change_type: change.changeType,
            created_at: now,
          })));
        }
      }
      await transaction("cloud_services").where({ id: input.serviceId }).update({ last_scan_at: now, updated_at: now });
      return catalogVersion;
    });
  }

  /** 把 APP 默认排除目录中的旧扫描文件标记缺失，并软删除已经没有活动文件的媒体条目。 */
  private async cleanupExcludedCatalogPaths(
    transaction: Knex.Transaction,
    tenantId: string,
    libraryId: string,
    now: string,
  ): Promise<string[]> {
    const sourceRows = await transaction("source_files")
      .select("id", "path")
      .where({ tenant_id: tenantId, library_id: libraryId, status: "active" });
    const excludedSourceIds = sourceRows
      .filter((row) => isFlymbyExcludedPath(String(row.path)))
      .map((row) => String(row.id));
    if (excludedSourceIds.length === 0) return [];
    const linkedRows: Array<{ item_id: unknown }> = [];
    for (const sourceIdChunk of chunkStrings(excludedSourceIds)) {
      await transaction("source_files").whereIn("id", sourceIdChunk).update({ status: "missing", updated_at: now });
      linkedRows.push(...await transaction("file_links").distinct("item_id").whereIn("source_file_id", sourceIdChunk));
    }
    const candidateItemIds = linkedRows.map((row) => String(row.item_id));
    if (candidateItemIds.length === 0) return [];
    const activeRows: Array<{ item_id: unknown }> = [];
    for (const itemIdChunk of chunkStrings(candidateItemIds)) {
      activeRows.push(...await transaction("file_links as fl")
        .join("source_files as f", "f.id", "fl.source_file_id")
        .distinct("fl.item_id")
        .whereIn("fl.item_id", itemIdChunk)
        .where("f.status", "active"));
    }
    const activeItemIds = new Set(activeRows.map((row) => String(row.item_id)));
    const deletedItemIds = [...new Set(candidateItemIds)].filter((itemId) => !activeItemIds.has(itemId));
    for (const itemIdChunk of chunkStrings(deletedItemIds)) {
      await transaction("media_items").whereIn("id", itemIdChunk).whereNull("deleted_at").update({ deleted_at: now, updated_at: now });
    }
    return deletedItemIds;
  }

  /** 删除已经没有活动子项且自身没有活动文件的旧节目、专辑或有声书父项。 */
  private async cleanupOrphanCatalogParents(
    transaction: Knex.Transaction,
    tenantId: string,
    libraryId: string,
    now: string,
  ): Promise<string[]> {
    const parentRows = await transaction("media_items")
      .select("id")
      .where({ tenant_id: tenantId, library_id: libraryId })
      .whereIn("item_type", ["video.series", "music.album", "audiobook.book"])
      .whereNull("deleted_at");
    const parentIds = parentRows.map((row) => String(row.id));
    if (parentIds.length === 0) return [];
    const childRows: Array<{ parent_item_id: unknown }> = [];
    const fileRows: Array<{ item_id: unknown }> = [];
    for (const parentIdChunk of chunkStrings(parentIds)) {
      const [childChunk, fileChunk] = await Promise.all([
        transaction("media_relations as r")
          .join("media_items as c", "c.id", "r.child_item_id")
          .distinct("r.parent_item_id")
          .whereIn("r.parent_item_id", parentIdChunk)
          .whereNull("c.deleted_at"),
        transaction("file_links as fl")
          .join("source_files as f", "f.id", "fl.source_file_id")
          .distinct("fl.item_id")
          .whereIn("fl.item_id", parentIdChunk)
          .where("f.status", "active"),
      ]);
      childRows.push(...childChunk);
      fileRows.push(...fileChunk);
    }
    const parentsWithChildren = new Set(childRows.map((row) => String(row.parent_item_id)));
    const parentsWithFiles = new Set(fileRows.map((row) => String(row.item_id)));
    const orphanIds = parentIds.filter((itemId) => !parentsWithChildren.has(itemId) && !parentsWithFiles.has(itemId));
    for (const orphanIdChunk of chunkStrings(orphanIds)) {
      await transaction("media_items").whereIn("id", orphanIdChunk).whereNull("deleted_at").update({ deleted_at: now, updated_at: now });
    }
    return orphanIds;
  }

  /** 查询当前租户媒体目录，管理端可省略租户并增加用户/服务筛选。 */
  public async listCatalogItems(filters: {
    tenantId?: string;
    ownerUserId?: string;
    serviceId?: string;
    libraryId?: string;
    mediaType?: MediaType;
    itemType?: string;
    matchState?: MatchState;
    search?: string;
    sort: CatalogSort;
    limit: number;
    offset: number;
  }): Promise<{ items: MediaItemRecord[]; total: number }> {
    const base = this.database.query("media_items as m")
      .join("cloud_services as s", "s.id", "m.service_id")
      .join("user_accounts as u", "u.id", "s.owner_user_id")
      .whereNull("m.deleted_at")
      .whereNull("s.deleted_at");
    if (filters.tenantId) base.where("m.tenant_id", filters.tenantId);
    if (filters.ownerUserId) base.where("s.owner_user_id", filters.ownerUserId);
    if (filters.serviceId) base.where("m.service_id", filters.serviceId);
    if (filters.libraryId) base.where("m.library_id", filters.libraryId);
    if (filters.mediaType) base.where("m.media_type", filters.mediaType);
    if (filters.itemType) {
      base.where("m.item_type", filters.itemType);
    } else {
      // 海报墙只展示电影、节目、专辑和有声书等顶层条目；单集通过父条目的 children 接口读取。
      base.whereNot("m.item_type", "video.episode");
    }
    if (filters.matchState) base.where("m.match_state", filters.matchState);
    if (filters.search) {
      base.where((builder) => {
        builder.whereLike("m.title", `%${filters.search}%`).orWhereLike("m.subtitle", `%${filters.search}%`);
      });
    }
    // cloud_services 和 user_accounts 都是一对一连接，不需要 DISTINCT 产生额外临时表。
    const countRow = await base.clone().count<{ count: string | number }[]>({ count: "m.id" }).first();
    const rowsQuery = base.clone()
      .select("m.*", "u.username as owner_username", "s.display_name as service_name");
    // 所有排序都追加稳定主键，避免同年、同日或同名条目跨页时重复或遗漏。
    if (filters.sort === "title_asc") {
      rowsQuery.orderBy("m.sort_title", "asc").orderBy("m.id", "asc");
    } else if (filters.sort === "year_desc") {
      rowsQuery.orderByRaw("?? IS NULL ASC, ?? DESC, ?? ASC", ["m.year", "m.year", "m.id"]);
    } else if (filters.sort === "premiere_date_desc") {
      rowsQuery.orderByRaw("?? IS NULL ASC, ?? DESC, ?? ASC", ["m.premiere_date", "m.premiere_date", "m.id"]);
    } else {
      rowsQuery.orderBy("m.created_at", "desc").orderBy("m.id", "asc");
    }
    // 关键变量：排序和分页必须全部追加后再执行，不能先 await 成数组。
    const rows = await rowsQuery.limit(filters.limit).offset(filters.offset);
    const fileCounts = await this.loadCatalogFileCounts(rows);
    return {
      items: rows.map((row) => this.mapMediaItem({
        ...row,
        file_count: fileCounts.get(String(row.id)) ?? 0,
      })),
      total: Number(countRow?.count ?? 0),
    };
  }

  /** 查询媒体条目详情并强制租户作用域。 */
  public async getCatalogItem(itemId: string, tenantId?: string): Promise<MediaItemRecord> {
    const query = this.database.query("media_items as m")
      .join("cloud_services as s", "s.id", "m.service_id")
      .join("user_accounts as u", "u.id", "s.owner_user_id")
      .select("m.*", "u.username as owner_username", "s.display_name as service_name")
      .where("m.id", itemId)
      .whereNull("m.deleted_at")
      .whereNull("s.deleted_at");
    if (tenantId) query.where("m.tenant_id", tenantId);
    const row = await query.first();
    if (!row) throw new ApiError(404, "media_item_not_found", "媒体条目不存在");
    const fileCounts = await this.loadCatalogFileCounts([row]);
    return this.mapMediaItem({ ...row, file_count: fileCounts.get(String(row.id)) ?? 0 });
  }

  /** 批量统计条目自身及其子项关联的源文件数，避免相关子查询反复扫描完整关联表。 */
  private async loadCatalogFileCounts(rows: Record<string, unknown>[]): Promise<Map<string, number>> {
    const fileIdsByItem = new Map<string, Set<string>>();
    // 关键变量：按租户分组后查询，确保能够使用 tenant_id 开头的现有复合索引。
    const itemIdsByTenant = new Map<string, string[]>();
    rows.forEach((row) => {
      const tenantId = String(row.tenant_id);
      const itemId = String(row.id);
      const itemIds = itemIdsByTenant.get(tenantId) ?? [];
      itemIds.push(itemId);
      itemIdsByTenant.set(tenantId, itemIds);
      fileIdsByItem.set(itemId, new Set<string>());
    });

    for (const [tenantId, itemIds] of itemIdsByTenant) {
      for (const itemIdChunk of chunkStrings(itemIds)) {
        const [directRows, childRows] = await Promise.all([
          this.database.query("file_links")
            .select("item_id", "source_file_id")
            .where("tenant_id", tenantId)
            .whereIn("item_id", itemIdChunk),
          this.database.query("media_relations as mr")
            .join("file_links as fl", function joinChildFileLinks() {
              this.on("fl.tenant_id", "=", "mr.tenant_id")
                .andOn("fl.item_id", "=", "mr.child_item_id");
            })
            .select("mr.parent_item_id as item_id", "fl.source_file_id")
            .where("mr.tenant_id", tenantId)
            .whereIn("mr.parent_item_id", itemIdChunk),
        ]);
        [...directRows, ...childRows].forEach((fileRow) => {
          fileIdsByItem.get(String(fileRow.item_id))?.add(String(fileRow.source_file_id));
        });
      }
    }

    return new Map([...fileIdsByItem].map(([itemId, fileIds]) => [itemId, fileIds.size]));
  }

  /** 映射数据库媒体行。 */
  private mapMediaItem(row: Record<string, unknown>): MediaItemRecord {
    return {
      id: String(row.id),
      tenantId: String(row.tenant_id),
      serviceId: String(row.service_id),
      libraryId: String(row.library_id),
      mediaType: row.media_type as MediaType,
      itemType: String(row.item_type),
      title: String(row.title),
      sortTitle: String(row.sort_title),
      subtitle: String(row.subtitle),
      year: row.year === null || row.year === undefined ? null : Number(row.year),
      premiereDate: row.premiere_date ? String(row.premiere_date) : null,
      overview: String(row.overview),
      posterUrl: row.poster_url ? String(row.poster_url) : null,
      backdropUrl: row.backdrop_url ? String(row.backdrop_url) : null,
      matchState: row.match_state as MatchState,
      externalIds: Object.fromEntries(Object.entries(parseJsonObject(row.external_ids_json)).map(([key, value]) => [key, String(value)])),
      metadata: parseJsonObject(row.metadata_json),
      fileCount: Number(row.file_count ?? 0),
      ownerUsername: String(row.owner_username),
      serviceName: String(row.service_name),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  /** 查询媒体条目子项关系。 */
  public async listCatalogChildren(itemId: string, tenantId?: string): Promise<MediaItemRecord[]> {
    await this.getCatalogItem(itemId, tenantId);
    const relationRows = await this.database.query("media_relations").select("child_item_id").where({ parent_item_id: itemId }).orderBy("sort_order", "asc");
    return Promise.all(relationRows.map((row) => this.getCatalogItem(String(row.child_item_id), tenantId)));
  }

  /** 读取当前条目及其直接子项关联的源文件，返回值不包含播放定位和凭据。 */
  public async listCatalogItemPaths(itemId: string, tenantId?: string): Promise<CatalogPathRow[]> {
    const item = await this.getCatalogItem(itemId, tenantId);
    const rows = await this.readLinkedSourceRows(this.database.query, itemId, item.tenantId);
    const uniqueRows = new Map<string, CatalogPathRow>();
    for (const row of rows) {
      if (uniqueRows.has(row.source_file_id)) continue;
      uniqueRows.set(row.source_file_id, {
        fileId: row.source_file_id,
        resourceId: row.provider_resource_id,
        linkedItemId: row.linked_item_id,
        linkedItemTitle: String(row.linked_item_title ?? ""),
        path: row.path,
        name: row.name,
        size: Number(row.size ?? 0),
        modifiedAt: row.modified_at ? String(row.modified_at) : null,
      });
    }
    return [...uniqueRows.values()];
  }

  /** 将用户选择的 TMDB 电影或节目元数据覆盖到当前顶层影视条目。 */
  public async applyManualVideoMatch(input: {
    itemId: string;
    tenantId: string;
    metadata: TmdbVideoMetadata;
  }): Promise<MediaItemRecord> {
    const item = await this.getCatalogItem(input.itemId, input.tenantId);
    this.requireManualMatchableVideo(item);
    await this.database.query.transaction(async (transaction) => {
      const row = await transaction("media_items")
        .where({ id: input.itemId, tenant_id: input.tenantId })
        .whereNull("deleted_at")
        .first();
      if (!row) throw new ApiError(404, "media_item_not_found", "媒体条目不存在");
      const sourceRows = await this.readLinkedSourceRows(transaction, input.itemId, input.tenantId);
      // 关键变量：首次手动匹配前的本地识别快照，用于清除匹配时恢复未匹配状态。
      const original = await this.buildManualMatchSnapshot(transaction, row, sourceRows);
      const nextItemType = input.metadata.mediaType === "tv" ? "video.series" : "video.movie";
      const now = new Date().toISOString();
      const changedItemIds = await this.rebuildManualVideoStructure(
        transaction,
        row,
        nextItemType,
        sourceRows,
        input.metadata,
        input.metadata.title,
        now,
      );
      const nextMetadata: Record<string, unknown> = {
        ...original.metadata,
        originalTitle: input.metadata.originalTitle,
        releaseDate: input.metadata.releaseDate,
        rating: input.metadata.rating,
        genres: input.metadata.genres,
        people: input.metadata.people,
        episodeCount: input.metadata.episodeCount,
        matchedQuery: input.metadata.matchedQuery,
        candidateCount: input.metadata.candidateCount,
        manualMatch: {
          source: "tmdb",
          tmdbId: input.metadata.id,
          mediaType: input.metadata.mediaType,
          appliedAt: now,
          original,
        },
      };
      await transaction("media_items").where({ id: input.itemId, tenant_id: input.tenantId }).update({
        item_type: nextItemType,
        title: input.metadata.title,
        sort_title: input.metadata.title,
        subtitle: input.metadata.originalTitle || (input.metadata.mediaType === "tv" ? "节目" : "电影"),
        year: input.metadata.year,
        premiere_date: input.metadata.releaseDate || null,
        overview: input.metadata.overview,
        poster_url: input.metadata.posterUrl,
        backdrop_url: input.metadata.backdropUrl,
        match_state: "matched",
        external_ids_json: JSON.stringify({ tmdb: String(input.metadata.id) }),
        metadata_json: JSON.stringify(nextMetadata),
        updated_at: now,
      });
      await this.recordCatalogItemUpserts(transaction, input.tenantId, String(row.library_id), [input.itemId, ...changedItemIds], now);
    });
    return this.getCatalogItem(input.itemId, input.tenantId);
  }

  /** 清除自动或手动刮削结果，并恢复文件名和目录推导出的本地影视信息。 */
  public async clearVideoMatch(itemId: string, tenantId: string): Promise<MediaItemRecord> {
    const item = await this.getCatalogItem(itemId, tenantId);
    this.requireManualMatchableVideo(item);
    await this.database.query.transaction(async (transaction) => {
      const row = await transaction("media_items")
        .where({ id: itemId, tenant_id: tenantId })
        .whereNull("deleted_at")
        .first();
      if (!row) throw new ApiError(404, "media_item_not_found", "媒体条目不存在");
      const sourceRows = await this.readLinkedSourceRows(transaction, itemId, tenantId);
      // 关键变量：清除后恢复的本地条目信息，不能继续携带海报、简介和 TMDB 编号。
      const original = await this.buildManualMatchSnapshot(transaction, row, sourceRows);
      const now = new Date().toISOString();
      const changedItemIds = await this.rebuildManualVideoStructure(
        transaction,
        row,
        original.itemType,
        sourceRows,
        null,
        original.title,
        now,
      );
      await transaction("media_items").where({ id: itemId, tenant_id: tenantId }).update({
        item_type: original.itemType,
        title: original.title,
        sort_title: original.sortTitle,
        subtitle: original.subtitle,
        year: original.year,
        premiere_date: readMediaPremiereDate(original.metadata),
        overview: "",
        poster_url: null,
        backdrop_url: null,
        match_state: "unmatched",
        external_ids_json: "{}",
        metadata_json: JSON.stringify(original.metadata),
        updated_at: now,
      });
      await this.recordCatalogItemUpserts(transaction, tenantId, String(row.library_id), [itemId, ...changedItemIds], now);
    });
    return this.getCatalogItem(itemId, tenantId);
  }

  /** 要求手动匹配对象是海报墙顶层电影或节目。 */
  private requireManualMatchableVideo(item: MediaItemRecord): void {
    if (item.mediaType !== "video" || (item.itemType !== "video.movie" && item.itemType !== "video.series")) {
      throw new ApiError(422, "manual_match_item_not_supported", "当前只支持对电影和节目执行手动匹配");
    }
  }

  /** 读取顶层媒体及其直接子项的源文件关联，按路径稳定排序。 */
  private async readLinkedSourceRows(
    transaction: Knex | Knex.Transaction,
    itemId: string,
    tenantId: string,
  ): Promise<LinkedSourceRow[]> {
    const childRows = await transaction("media_relations")
      .select("child_item_id")
      .where({ tenant_id: tenantId, parent_item_id: itemId });
    const itemIds = [itemId, ...childRows.map((row) => String(row.child_item_id))];
    const rows = await transaction("file_links as fl")
      .join("source_files as f", "f.id", "fl.source_file_id")
      .join("media_items as linked", "linked.id", "fl.item_id")
      .select(
        "fl.id as file_link_id",
        "fl.item_id as linked_item_id",
        "fl.source_file_id",
        "fl.locator_json",
        "f.provider_resource_id",
        "f.path",
        "f.name",
        "f.size",
        "f.modified_at",
        "linked.title as linked_item_title",
      )
      .where("fl.tenant_id", tenantId)
      .whereIn("fl.item_id", itemIds)
      .where("f.status", "active")
      .orderBy("f.path", "asc");
    return rows as LinkedSourceRow[];
  }

  /** 构造清除匹配后使用的本地识别快照，并优先复用首次手动匹配保存的快照。 */
  private async buildManualMatchSnapshot(
    transaction: Knex.Transaction,
    row: Record<string, unknown>,
    sourceRows: LinkedSourceRow[],
  ): Promise<ManualMatchSnapshot> {
    const currentMetadata = parseJsonObject(row.metadata_json);
    const storedOriginal = asObject(asObject(currentMetadata.manualMatch).original);
    if (typeof storedOriginal.itemType === "string" && typeof storedOriginal.title === "string") {
      return {
        itemType: storedOriginal.itemType,
        title: storedOriginal.title,
        sortTitle: typeof storedOriginal.sortTitle === "string" ? storedOriginal.sortTitle : storedOriginal.title,
        subtitle: typeof storedOriginal.subtitle === "string" ? storedOriginal.subtitle : "",
        year: typeof storedOriginal.year === "number" ? storedOriginal.year : null,
        metadata: asObject(storedOriginal.metadata),
      };
    }

    const sourceMetadata: Record<string, unknown> = { ...pickSourceMetadata(currentMetadata) };
    const childIds = [...new Set(sourceRows.map((sourceRow) => sourceRow.linked_item_id).filter((id) => id !== String(row.id)))];
    if (childIds.length > 0) {
      const childMetadataRows = await transaction("media_items").select("metadata_json").whereIn("id", childIds);
      for (const childRow of childMetadataRows) {
        const childMetadata = pickSourceMetadata(parseJsonObject(childRow.metadata_json));
        for (const [key, value] of Object.entries(childMetadata)) {
          if (sourceMetadata[key] === undefined) sourceMetadata[key] = value;
        }
      }
    }
    const originalItemType = String(row.item_type) === "video.series" ? "video.series" : "video.movie";
    const firstSource = sourceRows[0];
    const parsed = firstSource
      ? parseFlymbyVideoName(toVideoProviderEntry(firstSource), "/")
      : null;
    const titleCandidates = originalItemType === "video.series"
      ? [sourceMetadata.seriesTitle, sourceMetadata.query, currentMetadata.matchedQuery, parsed?.title, row.title]
      : [sourceMetadata.query, currentMetadata.matchedQuery, parsed?.title, row.title];
    const localTitle = titleCandidates.find((value) => typeof value === "string" && value.trim()) as string | undefined;
    const localYear = parsed?.year ?? (typeof row.year === "number" ? row.year : row.year ? Number(row.year) : null);
    return {
      itemType: originalItemType,
      title: localTitle?.trim() || String(row.title),
      sortTitle: localTitle?.trim() || String(row.sort_title),
      subtitle: originalItemType === "video.series" ? "节目" : (localYear ? String(localYear) : "电影"),
      year: localYear && Number.isFinite(localYear) ? localYear : null,
      metadata: sourceMetadata,
    };
  }

  /** 在电影和节目之间更正类型时重建父子及文件关联，保持顶层条目 ID 不变。 */
  private async rebuildManualVideoStructure(
    transaction: Knex.Transaction,
    row: Record<string, unknown>,
    nextItemType: string,
    sourceRows: LinkedSourceRow[],
    metadata: TmdbVideoMetadata | null,
    displayTitle: string,
    now: string,
  ): Promise<string[]> {
    const previousItemType = String(row.item_type);
    if (previousItemType === nextItemType) return [];
    const tenantId = String(row.tenant_id);
    const libraryId = String(row.library_id);
    const parentItemId = String(row.id);
    const uniqueSourceRows = [...new Map(sourceRows.map((sourceRow) => [sourceRow.source_file_id, sourceRow])).values()];
    const changedItemIds: string[] = [];

    if (nextItemType === "video.movie") {
      for (const sourceRow of uniqueSourceRows) {
        await transaction("file_links").insert({
          id: randomUUID(),
          tenant_id: tenantId,
          library_id: libraryId,
          item_id: parentItemId,
          source_file_id: sourceRow.source_file_id,
          locator_json: sourceRow.locator_json,
        }).onConflict(["tenant_id", "item_id", "source_file_id"]).merge({ locator_json: sourceRow.locator_json });
      }
      await transaction("media_relations").where({ tenant_id: tenantId, parent_item_id: parentItemId }).delete();
      return changedItemIds;
    }

    let fallbackEpisodeNumber = 1;
    for (const sourceRow of uniqueSourceRows) {
      const existingEpisode = await transaction("file_links as fl")
        .join("media_items as m", "m.id", "fl.item_id")
        .select("m.id", "m.metadata_json")
        .where("fl.tenant_id", tenantId)
        .where("fl.source_file_id", sourceRow.source_file_id)
        .where("m.item_type", "video.episode")
        .whereNull("m.deleted_at")
        .first();
      const parsed = parseFlymbyVideoName(toVideoProviderEntry(sourceRow), "/");
      const seasonNumber = parsed.mediaType === "tv" ? Math.max(0, parsed.seasonNumber) : 1;
      const episodeNumber = parsed.mediaType === "tv" && parsed.episodeNumber > 0
        ? parsed.episodeNumber
        : fallbackEpisodeNumber;
      fallbackEpisodeNumber = Math.max(fallbackEpisodeNumber + 1, episodeNumber + 1);
      let episodeItemId = existingEpisode ? String(existingEpisode.id) : "";
      if (!episodeItemId) {
        const identityKey = `manual:video:episode:${sourceRow.source_file_id}`;
        episodeItemId = createStableId("itm", tenantId, libraryId, identityKey);
        const episodeMetadata = {
          sourcePath: sourceRow.path,
          query: displayTitle,
          seriesTitle: displayTitle,
          seasonNumber,
          episodeNumber,
          manualStructure: true,
        };
        await transaction("media_items").insert({
          id: episodeItemId,
          tenant_id: tenantId,
          service_id: row.service_id,
          library_id: libraryId,
          identity_key: identityKey,
          media_type: "video",
          item_type: "video.episode",
          title: `第 ${seasonNumber} 季 · 第 ${episodeNumber} 集`,
          sort_title: `${String(seasonNumber).padStart(3, "0")}-${String(episodeNumber).padStart(5, "0")}`,
          subtitle: displayTitle,
          year: metadata?.year ?? row.year,
          overview: "",
          poster_url: metadata?.posterUrl ?? row.poster_url,
          backdrop_url: metadata?.backdropUrl ?? row.backdrop_url,
          match_state: "needs_review",
          external_ids_json: metadata ? JSON.stringify({ tmdbTv: String(metadata.id) }) : "{}",
          metadata_json: JSON.stringify(episodeMetadata),
          generation_id: row.generation_id,
          created_at: now,
          updated_at: now,
          deleted_at: null,
        }).onConflict(["tenant_id", "library_id", "identity_key"]).merge({
          subtitle: displayTitle,
          year: metadata?.year ?? row.year,
          poster_url: metadata?.posterUrl ?? row.poster_url,
          backdrop_url: metadata?.backdropUrl ?? row.backdrop_url,
          metadata_json: JSON.stringify(episodeMetadata),
          updated_at: now,
          deleted_at: null,
        });
        changedItemIds.push(episodeItemId);
      } else {
        const existingEpisodeMetadata = parseJsonObject(existingEpisode.metadata_json);
        await transaction("media_items").where({ id: episodeItemId, tenant_id: tenantId }).update({
          subtitle: displayTitle,
          year: metadata?.year ?? row.year,
          poster_url: metadata?.posterUrl ?? row.poster_url,
          backdrop_url: metadata?.backdropUrl ?? row.backdrop_url,
          external_ids_json: metadata ? JSON.stringify({ tmdbTv: String(metadata.id) }) : "{}",
          metadata_json: JSON.stringify({
            ...existingEpisodeMetadata,
            seriesTitle: displayTitle,
            seasonNumber,
            episodeNumber,
          }),
          generation_id: row.generation_id,
          updated_at: now,
          deleted_at: null,
        });
        changedItemIds.push(episodeItemId);
      }
      await transaction("file_links").insert({
        id: randomUUID(),
        tenant_id: tenantId,
        library_id: libraryId,
        item_id: episodeItemId,
        source_file_id: sourceRow.source_file_id,
        locator_json: sourceRow.locator_json,
      }).onConflict(["tenant_id", "item_id", "source_file_id"]).merge({ locator_json: sourceRow.locator_json });
      await transaction("file_links").where({
        tenant_id: tenantId,
        item_id: parentItemId,
        source_file_id: sourceRow.source_file_id,
      }).delete();
      await transaction("media_relations").insert({
        id: randomUUID(),
        tenant_id: tenantId,
        library_id: libraryId,
        parent_item_id: parentItemId,
        child_item_id: episodeItemId,
        relation_type: "series_episode",
        sort_order: seasonNumber * 100_000 + episodeNumber,
      }).onConflict(["tenant_id", "parent_item_id", "child_item_id", "relation_type"]).merge({
        sort_order: seasonNumber * 100_000 + episodeNumber,
      });
    }
    return changedItemIds;
  }

  /** 为人工修改的媒体条目递增目录版本并追加变更记录。 */
  private async recordCatalogItemUpserts(
    transaction: Knex.Transaction,
    tenantId: string,
    libraryId: string,
    itemIds: string[],
    now: string,
  ): Promise<void> {
    const uniqueItemIds = [...new Set(itemIds)];
    if (uniqueItemIds.length === 0) return;
    const library = await transaction("media_libraries").where({ id: libraryId, tenant_id: tenantId }).first();
    if (!library) throw new ApiError(404, "library_not_found", "媒体库不存在");
    const previousVersion = Number(library.catalog_version);
    await transaction("media_libraries").where({ id: libraryId, tenant_id: tenantId }).update({
      catalog_version: previousVersion + uniqueItemIds.length,
      updated_at: now,
    });
    for (let offset = 0; offset < uniqueItemIds.length; offset += CATALOG_CHANGE_INSERT_BATCH_SIZE) {
      const itemIdBatch = uniqueItemIds.slice(offset, offset + CATALOG_CHANGE_INSERT_BATCH_SIZE);
      await transaction("catalog_changes").insert(itemIdBatch.map((entityId, batchIndex) => ({
        tenant_id: tenantId,
        library_id: libraryId,
        catalog_version: previousVersion + offset + batchIndex + 1,
        entity_type: "media_item",
        entity_id: entityId,
        change_type: "upsert",
        created_at: now,
      })));
    }
  }

  /** 查询 APP 播放端使用的 Provider 文件定位，不下发服务端凭据。 */
  public async listItemFiles(itemId: string, tenantId: string): Promise<Array<Record<string, unknown>>> {
    await this.getCatalogItem(itemId, tenantId);
    const rows = await this.database.query("file_links as fl")
      .join("source_files as f", "f.id", "fl.source_file_id")
      .select("f.id", "f.provider_resource_id", "f.path", "f.name", "f.size", "f.modified_at", "fl.locator_json")
      .where("fl.item_id", itemId)
      .where("fl.tenant_id", tenantId)
      .where("f.status", "active");
    return rows.map((row) => ({
      fileId: row.id,
      resourceId: row.provider_resource_id,
      path: row.path,
      name: row.name,
      size: Number(row.size),
      modifiedAt: row.modified_at,
      playbackLocator: parseJsonObject(row.locator_json),
    }));
  }

  /** 查询指定版本后的目录变更。 */
  public async listCatalogChanges(tenantId: string, libraryId: string, afterVersion: number, limit: number) {
    const library = await this.database.query("media_libraries").where({ id: libraryId, tenant_id: tenantId }).first();
    if (!library) throw new ApiError(404, "library_not_found", "媒体库不存在");
    const rows = await this.database.query("catalog_changes")
      .where({ tenant_id: tenantId, library_id: libraryId })
      .where("catalog_version", ">", afterVersion)
      .orderBy("catalog_version", "asc")
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const visibleRows = hasMore ? rows.slice(0, limit) : rows;
    return {
      catalogVersion: Number(library.catalog_version),
      nextVersion: visibleRows.length > 0
        ? Number(visibleRows[visibleRows.length - 1]?.catalog_version ?? afterVersion)
        : afterVersion,
      hasMore,
      changes: visibleRows.map((row) => ({
        version: Number(row.catalog_version),
        entityType: row.entity_type,
        entityId: row.entity_id,
        changeType: row.change_type,
        createdAt: row.created_at,
      })),
    };
  }

  /** 查询用户或全局概览统计。 */
  public async getOverview(tenantId?: string) {
    const services = this.database.query("cloud_services").whereNull("deleted_at");
    const media = this.database.query("media_items as m")
      .join("cloud_services as s", "s.id", "m.service_id")
      .whereNull("m.deleted_at")
      .whereNull("s.deleted_at")
      // 概览与海报墙使用相同口径：节目单集只计入父节目，不重复计入媒体总数。
      .whereNot("m.item_type", "video.episode");
    const jobs = this.database.query("scan_jobs");
    if (tenantId) {
      services.where("tenant_id", tenantId);
      media.where("m.tenant_id", tenantId);
      jobs.where("tenant_id", tenantId);
    }
    const [serviceCount, mediaCount, runningCount, failedCount, reviewCount] = await Promise.all([
      services.clone().count<{ count: string | number }[]>({ count: "id" }).first(),
      media.clone().count<{ count: string | number }[]>({ count: "m.id" }).first(),
      jobs.clone().whereIn("status", ["queued", "running", "paused"]).count<{ count: string | number }[]>({ count: "id" }).first(),
      jobs.clone().where("status", "failed").count<{ count: string | number }[]>({ count: "id" }).first(),
      media.clone().where("m.match_state", "needs_review").count<{ count: string | number }[]>({ count: "m.id" }).first(),
    ]);
    return {
      serviceCount: Number(serviceCount?.count ?? 0),
      mediaCount: Number(mediaCount?.count ?? 0),
      activeJobCount: Number(runningCount?.count ?? 0),
      failedJobCount: Number(failedCount?.count ?? 0),
      needsReviewCount: Number(reviewCount?.count ?? 0),
    };
  }
}
