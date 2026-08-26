import { randomUUID } from "node:crypto";
import type { Knex } from "knex";
import { repairDuplicateCatalogFileLinks } from "./catalog-file-link-repair.js";

export const currentSchemaVersion = 36;

/** 仅在目标表缺少字段时追加字段，兼容已完成认证阶段初始化的 SQLite。 */
async function addColumnIfMissing(
  database: Knex,
  tableName: string,
  columnName: string,
  callback: (table: Knex.AlterTableBuilder) => void,
): Promise<void> {
  if (!(await database.schema.hasColumn(tableName, columnName))) {
    await database.schema.alterTable(tableName, callback);
  }
}

/** 单独创建索引并容忍上次迁移中断后已经存在的索引。 */
async function addIndexIfMissing(
  database: Knex,
  tableName: string,
  columns: string[],
  indexName: string,
): Promise<void> {
  try {
    await database.schema.alterTable(tableName, (table) => {
      table.index(columns, indexName);
    });
  } catch (error) {
    const databaseError = error as Error & { code?: string };
    const duplicateIndex = databaseError.code === "42P07"
      || databaseError.code === "42710"
      || databaseError.code === "ER_DUP_KEYNAME"
      || /index .* already exists/iu.test(databaseError.message);
    if (!duplicateIndex) throw error;
  }
}

/** 单独创建唯一约束，并容忍上次迁移已经完成但版本号尚未写回的情况。 */
async function addUniqueIfMissing(
  database: Knex,
  tableName: string,
  columns: string[],
  indexName: string,
): Promise<void> {
  try {
    await database.schema.alterTable(tableName, (table) => {
      table.unique(columns, { indexName });
    });
  } catch (error) {
    const databaseError = error as Error & { code?: string };
    const duplicateIndex = databaseError.code === "42P07"
      || databaseError.code === "23505"
      || databaseError.code === "ER_DUP_KEYNAME"
      || /(?:index|constraint) .* already exists/iu.test(databaseError.message);
    if (!duplicateIndex) throw error;
  }
}

/** 创建认证和实例状态基础表。 */
async function createIdentityTables(database: Knex): Promise<void> {
  if (!(await database.schema.hasTable("system_state"))) {
    await database.schema.createTable("system_state", (table) => {
      table.integer("singleton_id").primary();
      table.string("service_instance_id", 64).notNullable();
      table.string("initial_setup_completed_at", 40).nullable();
      table.string("credential_key_fingerprint", 64).nullable();
      table.string("credential_key_source", 32).nullable();
      table.integer("credential_key_backup_required").notNullable().defaultTo(0);
      table.integer("schema_version").notNullable();
      table.string("created_at", 40).notNullable();
      table.string("updated_at", 40).notNullable();
    });
  } else {
    await addColumnIfMissing(database, "system_state", "service_instance_id", (table) => {
      table.string("service_instance_id", 64).nullable();
    });
    await addColumnIfMissing(database, "system_state", "schema_version", (table) => {
      table.integer("schema_version").nullable();
    });
    await addColumnIfMissing(database, "system_state", "credential_key_fingerprint", (table) => {
      table.string("credential_key_fingerprint", 64).nullable();
    });
    await addColumnIfMissing(database, "system_state", "credential_key_source", (table) => {
      table.string("credential_key_source", 32).nullable();
    });
    await addColumnIfMissing(database, "system_state", "credential_key_backup_required", (table) => {
      table.integer("credential_key_backup_required").notNullable().defaultTo(0);
    });
  }

  if (!(await database.schema.hasTable("user_accounts"))) {
    await database.schema.createTable("user_accounts", (table) => {
      table.string("id", 64).primary();
      table.string("username", 255).notNullable();
      table.string("username_lookup", 255).notNullable().unique();
      table.string("role", 32).notNullable();
      table.string("status", 32).notNullable();
      table.string("last_login_at", 40).nullable();
      table.string("created_at", 40).notNullable();
      table.string("updated_at", 40).notNullable();
    });
  } else {
    await addColumnIfMissing(database, "user_accounts", "last_login_at", (table) => {
      table.string("last_login_at", 40).nullable();
    });
  }

  if (!(await database.schema.hasTable("user_passwords"))) {
    await database.schema.createTable("user_passwords", (table) => {
      table.string("user_id", 64).primary().references("id").inTable("user_accounts").onDelete("CASCADE");
      table.text("password_hash").notNullable();
      table.string("password_changed_at", 40).notNullable();
    });
  }

  if (!(await database.schema.hasTable("user_external_identities"))) {
    await database.schema.createTable("user_external_identities", (table) => {
      table.string("id", 64).primary();
      table.string("user_id", 64).notNullable().references("id").inTable("user_accounts").onDelete("CASCADE");
      table.string("provider", 32).notNullable();
      table.string("identity_hash", 128).notNullable();
      table.string("created_at", 40).notNullable();
      table.unique(["provider", "identity_hash"], { indexName: "uq_user_external_identity" });
      table.unique(["user_id", "provider"], { indexName: "uq_user_external_provider" });
      table.index(["user_id"], "idx_user_external_identities_user");
    });
  }

  if (!(await database.schema.hasTable("user_sessions"))) {
    await database.schema.createTable("user_sessions", (table) => {
      table.string("id", 64).primary();
      table.string("user_id", 64).notNullable().references("id").inTable("user_accounts").onDelete("CASCADE");
      table.string("token_hash", 64).notNullable().unique();
      table.string("expires_at", 40).notNullable();
      table.string("created_at", 40).notNullable();
      table.string("last_seen_at", 40).notNullable();
      table.string("revoked_at", 40).nullable();
      table.index(["user_id"], "idx_user_sessions_user_id");
      table.index(["expires_at"], "idx_user_sessions_expires_at");
    });
  }

  if (!(await database.schema.hasTable("refresh_tokens"))) {
    await database.schema.createTable("refresh_tokens", (table) => {
      table.string("id", 64).primary();
      table.string("user_id", 64).notNullable().references("id").inTable("user_accounts").onDelete("CASCADE");
      table.string("token_hash", 64).notNullable().unique();
      table.string("family_id", 64).notNullable();
      table.string("expires_at", 40).notNullable();
      table.string("created_at", 40).notNullable();
      table.string("rotated_at", 40).nullable();
      table.string("revoked_at", 40).nullable();
      table.index(["user_id"], "idx_refresh_tokens_user_id");
      table.index(["family_id"], "idx_refresh_tokens_family_id");
    });
  }
}

/** 创建云端服务、配置修订和媒体库归属表。 */
async function createServiceTables(database: Knex): Promise<void> {
  if (!(await database.schema.hasTable("cloud_services"))) {
    await database.schema.createTable("cloud_services", (table) => {
      table.string("id", 64).primary();
      table.string("user_id", 64).notNullable().references("id").inTable("user_accounts").onDelete("CASCADE");
      table.string("library_id", 64).notNullable().unique();
      table.string("display_name", 255).notNullable();
      table.string("provider_type", 64).notNullable();
      table.string("data_type", 32).notNullable().defaultTo("video");
      table.string("status", 32).notNullable();
      table.string("connection_status", 64).notNullable();
      table.integer("relay_playback_enabled").notNullable().defaultTo(0);
      table.integer("credential_revision").notNullable();
      table.integer("scan_profile_revision").notNullable();
      table.integer("metadata_profile_revision").notNullable();
      table.string("last_scan_at", 40).nullable();
      table.string("created_at", 40).notNullable();
      table.string("updated_at", 40).notNullable();
      table.string("deleted_at", 40).nullable();
      table.index(["user_id", "status"], "idx_cloud_services_user_status");
    });
  } else {
    await addColumnIfMissing(database, "cloud_services", "data_type", (table) => {
      table.string("data_type", 32).notNullable().defaultTo("video");
    });
    await addColumnIfMissing(database, "cloud_services", "relay_playback_enabled", (table) => {
      table.integer("relay_playback_enabled").notNullable().defaultTo(0);
    });
  }
  if (!(await database.schema.hasTable("media_libraries"))) {
    await database.schema.createTable("media_libraries", (table) => {
      table.string("id", 64).primary();
      table.string("user_id", 64).notNullable().references("id").inTable("user_accounts").onDelete("CASCADE");
      table.string("service_id", 64).notNullable().unique().references("id").inTable("cloud_services").onDelete("CASCADE");
      table.string("provider_type", 64).notNullable();
      table.bigInteger("catalog_version").notNullable().defaultTo(0);
      table.integer("app_relay_playback_enabled").notNullable().defaultTo(0);
      table.integer("jellyfin_relay_playback_enabled").notNullable().defaultTo(1);
      table.integer("jellyfin_region_libraries_enabled").notNullable().defaultTo(0);
      table.integer("jellyfin_enabled").notNullable().defaultTo(0);
      table.string("jellyfin_path_suffix", 255).notNullable();
      table.string("jellyfin_path_suffix_lookup", 255).notNullable();
      table.string("status", 32).notNullable();
      table.string("created_at", 40).notNullable();
      table.string("updated_at", 40).notNullable();
      table.index(["user_id"], "idx_media_libraries_user");
      table.unique(["jellyfin_path_suffix_lookup"], { indexName: "uq_media_libraries_jellyfin_path_suffix" });
    });
  } else {
    await addColumnIfMissing(database, "media_libraries", "app_relay_playback_enabled", (table) => {
      table.integer("app_relay_playback_enabled").notNullable().defaultTo(0);
    });
    await addColumnIfMissing(database, "media_libraries", "jellyfin_relay_playback_enabled", (table) => {
      table.integer("jellyfin_relay_playback_enabled").notNullable().defaultTo(1);
    });
    await addColumnIfMissing(database, "media_libraries", "jellyfin_region_libraries_enabled", (table) => {
      table.integer("jellyfin_region_libraries_enabled").notNullable().defaultTo(0);
    });
    await addColumnIfMissing(database, "media_libraries", "jellyfin_enabled", (table) => {
      table.integer("jellyfin_enabled").notNullable().defaultTo(0);
    });
    await addColumnIfMissing(database, "media_libraries", "jellyfin_path_suffix", (table) => {
      table.string("jellyfin_path_suffix", 255).nullable();
    });
    await addColumnIfMissing(database, "media_libraries", "jellyfin_path_suffix_lookup", (table) => {
      table.string("jellyfin_path_suffix_lookup", 255).nullable();
    });
  }

  if (!(await database.schema.hasTable("service_credentials"))) {
    await database.schema.createTable("service_credentials", (table) => {
      table.string("id", 64).primary();
      table.string("user_id", 64).notNullable();
      table.string("service_id", 64).notNullable().references("id").inTable("cloud_services").onDelete("CASCADE");
      table.integer("revision").notNullable();
      table.text("encrypted_payload").notNullable();
      table.integer("key_version").notNullable();
      table.integer("schema_version").notNullable();
      table.string("status", 32).notNullable();
      table.string("created_at", 40).notNullable();
      table.unique(["user_id", "service_id", "revision"], { indexName: "uq_service_credentials_revision" });
    });
  }

  if (!(await database.schema.hasTable("service_scan_profiles"))) {
    await database.schema.createTable("service_scan_profiles", (table) => {
      table.string("id", 64).primary();
      table.string("user_id", 64).notNullable();
      table.string("service_id", 64).notNullable().references("id").inTable("cloud_services").onDelete("CASCADE");
      table.integer("revision").notNullable();
      table.text("configuration_json").notNullable();
      table.string("created_at", 40).notNullable();
      table.unique(["user_id", "service_id", "revision"], { indexName: "uq_service_scan_profiles_revision" });
    });
  }

  if (!(await database.schema.hasTable("service_metadata_profiles"))) {
    await database.schema.createTable("service_metadata_profiles", (table) => {
      table.string("id", 64).primary();
      table.string("user_id", 64).notNullable();
      table.string("service_id", 64).notNullable().references("id").inTable("cloud_services").onDelete("CASCADE");
      table.integer("revision").notNullable();
      table.text("configuration_json").notNullable();
      table.string("created_at", 40).notNullable();
      table.unique(["user_id", "service_id", "revision"], { indexName: "uq_service_metadata_profiles_revision" });
    });
  }

  if (!(await database.schema.hasTable("client_service_links"))) {
    await database.schema.createTable("client_service_links", (table) => {
      table.string("id", 64).primary();
      table.string("user_id", 64).notNullable();
      table.string("service_id", 64).notNullable().references("id").inTable("cloud_services").onDelete("CASCADE");
      table.string("client_device_id", 200).notNullable();
      table.string("client_service_id", 200).notNullable();
      table.string("provider_type", 64).notNullable();
      table.string("binding_source", 32).notNullable().defaultTo("local_migration");
      table.string("created_at", 40).notNullable();
      table.string("updated_at", 40).notNullable();
      table.unique(["user_id", "client_device_id", "client_service_id"], { indexName: "uq_client_service_links_device" });
      table.unique(["user_id", "service_id", "client_device_id"], { indexName: "uq_client_service_links_cloud_device" });
    });
  } else {
    await addColumnIfMissing(database, "client_service_links", "binding_source", (table) => {
      // 历史绑定均来自 APP 本地服务上行，升级时按 local_migration 回填。
      table.string("binding_source", 32).notNullable().defaultTo("local_migration");
    });
  }

  if (!(await database.schema.hasTable("service_migrations"))) {
    await database.schema.createTable("service_migrations", (table) => {
      table.string("id", 64).primary();
      table.string("user_id", 64).notNullable().references("id").inTable("user_accounts").onDelete("CASCADE");
      table.string("service_id", 64).notNullable().references("id").inTable("cloud_services").onDelete("CASCADE");
      table.string("library_id", 64).notNullable().references("id").inTable("media_libraries").onDelete("CASCADE");
      table.string("request_id", 200).notNullable();
      table.string("client_device_id", 200).notNullable();
      table.string("client_service_id", 200).notNullable();
      table.string("provider_type", 64).notNullable();
      // 关键变量：区分旧版一体迁移与新版向已关联服务迁移，取消时据此决定是否删服务。
      table.integer("owns_service").notNullable().defaultTo(1);
      table.string("status", 32).notNullable();
      table.string("stage", 32).notNullable();
      table.integer("progress_percent").notNullable().defaultTo(0);
      table.text("current_operation").notNullable();
      table.bigInteger("processed_count").notNullable().defaultTo(0);
      table.bigInteger("total_count").notNullable().defaultTo(0);
      table.bigInteger("uploaded_bytes").notNullable().defaultTo(0);
      table.bigInteger("expected_bytes").notNullable();
      table.integer("uploaded_chunk_count").notNullable().defaultTo(0);
      table.integer("expected_chunk_count").notNullable();
      table.string("snapshot_sha256", 64).notNullable();
      table.integer("snapshot_format_version").notNullable();
      table.bigInteger("active_duration_ms").notNullable().defaultTo(0);
      table.string("active_started_at", 40).nullable();
      table.string("error_code", 100).nullable();
      table.text("error_message").nullable();
      table.integer("retryable").notNullable().defaultTo(0);
      table.text("checkpoint_json").notNullable();
      table.text("result_json").notNullable();
      table.string("lease_owner", 100).nullable();
      table.string("lease_expires_at", 40).nullable();
      table.string("created_at", 40).notNullable();
      table.string("updated_at", 40).notNullable();
      table.string("finished_at", 40).nullable();
      table.unique(["user_id", "client_device_id", "request_id"], { indexName: "uq_service_migrations_request" });
      table.index(["user_id", "created_at"], "idx_service_migrations_user_created");
      table.index(["status", "updated_at"], "idx_service_migrations_status_updated");
      table.index(["user_id", "client_device_id", "client_service_id"], "idx_service_migrations_client_service");
    });
  }

  if (!(await database.schema.hasTable("service_transfer_outs"))) {
    await database.schema.createTable("service_transfer_outs", (table) => {
      table.string("id", 64).primary();
      table.string("user_id", 64).notNullable().references("id").inTable("user_accounts").onDelete("CASCADE");
      table.string("service_id", 64).notNullable().references("id").inTable("cloud_services").onDelete("CASCADE");
      table.string("library_id", 64).notNullable().references("id").inTable("media_libraries").onDelete("CASCADE");
      table.string("client_device_id", 200).notNullable();
      table.string("client_service_id", 200).notNullable();
      table.string("export_id", 64).notNullable();
      table.string("status", 32).notNullable();
      table.string("previous_status", 32).notNullable().defaultTo("active");
      table.integer("credential_claimed").notNullable().defaultTo(0);
      table.string("created_at", 40).notNullable();
      table.string("updated_at", 40).notNullable();
      table.unique(["service_id"], { indexName: "uq_service_transfer_outs_service" });
      table.index(["user_id", "updated_at"], "idx_service_transfer_outs_user_updated");
    });
  }
  await addColumnIfMissing(database, "service_transfer_outs", "previous_status", (table) => {
    // 关键变量：早期迁回表没有保存冻结前状态，升级后按正常启用状态恢复，避免迁回任务插入失败。
    table.string("previous_status", 32).notNullable().defaultTo("active");
  });
  if (!(await database.schema.hasColumn("service_migrations", "owns_service"))) {
    await database.schema.alterTable("service_migrations", (table) => {
      // 历史迁移均由旧协议创建并拥有对应服务，升级时按 true 回填。
      table.integer("owns_service").notNullable().defaultTo(1);
    });
  }

  if (!(await database.schema.hasTable("service_migration_chunks"))) {
    await database.schema.createTable("service_migration_chunks", (table) => {
      table.string("id", 64).primary();
      table.string("migration_id", 64).notNullable().references("id").inTable("service_migrations").onDelete("CASCADE");
      table.integer("chunk_index").notNullable();
      table.bigInteger("size_bytes").notNullable();
      table.string("sha256", 64).notNullable();
      table.text("file_path").notNullable();
      table.string("created_at", 40).notNullable();
      table.unique(["migration_id", "chunk_index"], { indexName: "uq_service_migration_chunks_index" });
      table.index(["migration_id"], "idx_service_migration_chunks_migration");
    });
  }

  if (!(await database.schema.hasTable("service_access_accounts"))) {
    await database.schema.createTable("service_access_accounts", (table) => {
      table.string("id", 64).primary();
      table.string("service_id", 64).notNullable().unique().references("id").inTable("cloud_services").onDelete("CASCADE");
      table.string("username", 255).notNullable();
      table.string("username_lookup", 255).notNullable();
      table.text("password_hash").notNullable();
      table.integer("password_required").notNullable().defaultTo(0);
      table.integer("credential_revision").notNullable().defaultTo(1);
      table.string("status", 32).notNullable().defaultTo("active");
      table.string("created_at", 40).notNullable();
      table.string("updated_at", 40).notNullable();
      table.unique(["service_id", "username_lookup"], { indexName: "uq_service_access_username" });
    });
  }
  await addColumnIfMissing(database, "service_access_accounts", "password_required", (table) => {
    // 关键变量：缺少密码状态字段的旧结构按新的默认规则补为免密码。
    table.integer("password_required").notNullable().defaultTo(0);
  });

  if (!(await database.schema.hasTable("service_protocol_sessions"))) {
    await database.schema.createTable("service_protocol_sessions", (table) => {
      table.string("id", 64).primary();
      table.string("service_id", 64).notNullable().references("id").inTable("cloud_services").onDelete("CASCADE");
      table.string("account_id", 64).notNullable().references("id").inTable("service_access_accounts").onDelete("CASCADE");
      table.string("protocol", 32).notNullable();
      table.string("token_hash", 64).notNullable().unique();
      table.integer("credential_revision").notNullable();
      table.string("device_id", 255).nullable();
      table.string("device_name", 255).nullable();
      table.string("client_name", 255).nullable();
      table.string("expires_at", 40).notNullable();
      table.string("last_seen_at", 40).notNullable();
      table.string("revoked_at", 40).nullable();
      table.string("created_at", 40).notNullable();
      table.index(["service_id", "protocol", "revoked_at"], "idx_protocol_sessions_service");
      table.index(["account_id", "expires_at"], "idx_protocol_sessions_account");
    });
  }
}

/** 在媒体目录表之后创建服务级播放数据表，确保 PostgreSQL 外键目标已经存在。 */
async function createPlaybackTables(database: Knex): Promise<void> {
  if (!(await database.schema.hasTable("service_playback_progress"))) {
    await database.schema.createTable("service_playback_progress", (table) => {
      table.string("id", 64).primary();
      table.string("service_id", 64).notNullable().references("id").inTable("cloud_services").onDelete("CASCADE");
      table.string("account_id", 64).notNullable().references("id").inTable("service_access_accounts").onDelete("CASCADE");
      table.string("item_id", 64).notNullable().references("id").inTable("media_items").onDelete("CASCADE");
      table.string("media_source_id", 128).nullable();
      table.bigInteger("position_ticks").notNullable().defaultTo(0);
      table.integer("played").notNullable().defaultTo(0);
      table.integer("hidden_from_resume").notNullable().defaultTo(0);
      table.integer("play_count").notNullable().defaultTo(0);
      table.string("last_played_at", 40).nullable();
      table.string("updated_at", 40).notNullable();
      table.unique(["service_id", "account_id", "item_id"], { indexName: "uq_service_playback_progress" });
      table.index(["service_id", "account_id", "updated_at"], "idx_service_progress_resume");
    });
  }
  await addColumnIfMissing(database, "service_playback_progress", "media_source_id", (table) => {
    table.string("media_source_id", 128).nullable();
  });

  if (!(await database.schema.hasTable("service_playback_sessions"))) {
    await database.schema.createTable("service_playback_sessions", (table) => {
      table.string("id", 64).primary();
      table.string("service_id", 64).notNullable().references("id").inTable("cloud_services").onDelete("CASCADE");
      table.string("account_id", 64).notNullable().references("id").inTable("service_access_accounts").onDelete("CASCADE");
      table.string("item_id", 64).notNullable().references("id").inTable("media_items").onDelete("CASCADE");
      table.string("media_source_id", 128).nullable();
      table.string("status", 32).notNullable();
      table.bigInteger("position_ticks").notNullable().defaultTo(0);
      table.integer("paused").notNullable().defaultTo(0);
      table.string("started_at", 40).notNullable();
      table.string("updated_at", 40).notNullable();
      table.string("stopped_at", 40).nullable();
      table.index(["service_id", "account_id", "status"], "idx_service_play_sessions_active");
    });
  }

  if (!(await database.schema.hasTable("service_playback_history"))) {
    await database.schema.createTable("service_playback_history", (table) => {
      table.string("id", 64).primary();
      table.string("service_id", 64).notNullable().references("id").inTable("cloud_services").onDelete("CASCADE");
      table.string("account_id", 64).notNullable().references("id").inTable("service_access_accounts").onDelete("CASCADE");
      table.string("item_id", 64).notNullable().references("id").inTable("media_items").onDelete("CASCADE");
      table.string("play_session_id", 64).notNullable().unique();
      table.bigInteger("position_ticks").notNullable().defaultTo(0);
      table.integer("completed").notNullable().defaultTo(0);
      table.string("started_at", 40).notNullable();
      table.string("stopped_at", 40).notNullable();
      table.index(["service_id", "account_id", "stopped_at"], "idx_service_play_history_recent");
    });
  }
}

/** 创建扫描任务、源文件和媒体目录表。 */
async function createCatalogTables(database: Knex): Promise<void> {
  if (!(await database.schema.hasTable("scan_jobs"))) {
    await database.schema.createTable("scan_jobs", (table) => {
      table.string("id", 64).primary();
      table.string("user_id", 64).notNullable();
      table.string("service_id", 64).notNullable().references("id").inTable("cloud_services").onDelete("CASCADE");
      table.string("library_id", 64).notNullable().references("id").inTable("media_libraries").onDelete("CASCADE");
      table.string("requested_by_user_id", 64).notNullable();
      table.string("request_id", 200).notNullable();
      table.string("client_device_id", 200).notNullable();
      table.string("scan_mode", 32).notNullable();
      table.string("status", 32).notNullable();
      table.string("stage", 32).notNullable();
      table.bigInteger("processed_count").notNullable().defaultTo(0);
      table.bigInteger("total_count").nullable();
      table.bigInteger("discovered_count").notNullable().defaultTo(0);
      table.bigInteger("skipped_count").notNullable().defaultTo(0);
      table.bigInteger("matched_count").nullable();
      table.bigInteger("unmatched_count").nullable();
      table.bigInteger("error_count").notNullable().defaultTo(0);
      table.text("current_path").nullable();
      table.string("error_code", 100).nullable();
      table.text("error_message").nullable();
      table.string("next_retry_at", 40).nullable();
      table.integer("retry_count").notNullable().defaultTo(0);
      table.text("snapshot_json").notNullable();
      table.string("control_action", 32).notNullable().defaultTo("none");
      table.string("created_at", 40).notNullable();
      table.string("started_at", 40).nullable();
      table.string("finished_at", 40).nullable();
      table.bigInteger("active_duration_ms").notNullable().defaultTo(0);
      table.string("active_started_at", 40).nullable();
      table.string("updated_at", 40).notNullable();
      table.unique(["user_id", "client_device_id", "request_id"], { indexName: "uq_scan_jobs_request" });
      table.index(["user_id", "status"], "idx_scan_jobs_user_status");
      table.index(["service_id", "status"], "idx_scan_jobs_service_status");
      table.index(["status", "next_retry_at"], "idx_scan_jobs_retry_due");
    });
  }
  await addColumnIfMissing(database, "scan_jobs", "matched_count", (table) => {
    table.bigInteger("matched_count").nullable();
  });
  await addColumnIfMissing(database, "scan_jobs", "unmatched_count", (table) => {
    table.bigInteger("unmatched_count").nullable();
  });
  await addColumnIfMissing(database, "scan_jobs", "current_path", (table) => {
    table.text("current_path").nullable();
  });
  await addColumnIfMissing(database, "scan_jobs", "next_retry_at", (table) => {
    table.string("next_retry_at", 40).nullable();
    // 关键索引：Worker 只按等待状态和到期时间查询，不扫描全部历史任务。
    table.index(["status", "next_retry_at"], "idx_scan_jobs_retry_due");
  });
  await addColumnIfMissing(database, "scan_jobs", "retry_count", (table) => {
    table.integer("retry_count").notNullable().defaultTo(0);
  });
  await addColumnIfMissing(database, "scan_jobs", "active_duration_ms", (table) => {
    table.bigInteger("active_duration_ms").notNullable().defaultTo(0);
  });
  await addColumnIfMissing(database, "scan_jobs", "active_started_at", (table) => {
    table.string("active_started_at", 40).nullable();
  });
  // 兼容升级时已经处于运行中的旧任务：从本次升级时刻开始计时，不追算之前可能包含暂停或停机的时间。
  await database("scan_jobs")
    .where({ status: "running" })
    .whereNull("active_started_at")
    .update({ active_started_at: new Date().toISOString() });

  if (!(await database.schema.hasTable("service_scan_schedules"))) {
    await database.schema.createTable("service_scan_schedules", (table) => {
      table.string("id", 64).primary();
      table.string("user_id", 64).notNullable();
      table.string("service_id", 64).notNullable().references("id").inTable("cloud_services").onDelete("CASCADE");
      table.string("scan_mode", 32).notNullable();
      table.integer("enabled").notNullable().defaultTo(0);
      table.string("schedule_type", 32).notNullable();
      table.integer("interval_minutes").nullable();
      table.string("time_of_day", 5).nullable();
      table.integer("day_of_week").nullable();
      table.integer("day_of_month").nullable();
      table.integer("timezone_offset_minutes").notNullable().defaultTo(0);
      table.string("next_run_at", 40).nullable();
      table.string("last_triggered_at", 40).nullable();
      table.string("last_job_id", 64).nullable();
      table.text("last_error").nullable();
      table.string("created_at", 40).notNullable();
      table.string("updated_at", 40).notNullable();
      table.unique(["user_id", "service_id", "scan_mode"], { indexName: "uq_service_scan_schedules_mode" });
      table.index(["enabled", "next_run_at"], "idx_service_scan_schedules_due");
    });
  }

  if (!(await database.schema.hasTable("scan_job_events"))) {
    await database.schema.createTable("scan_job_events", (table) => {
      table.increments("sequence").primary();
      table.string("user_id", 64).notNullable();
      table.string("job_id", 64).notNullable().references("id").inTable("scan_jobs").onDelete("CASCADE");
      table.string("event_type", 64).notNullable();
      table.text("payload_json").notNullable();
      table.string("created_at", 40).notNullable();
      table.index(["job_id", "sequence"], "idx_scan_job_events_job_sequence");
      table.index(["user_id", "sequence"], "idx_scan_job_events_user_sequence");
    });
  }

  if (!(await database.schema.hasTable("scan_job_checkpoints"))) {
    await database.schema.createTable("scan_job_checkpoints", (table) => {
      table.string("job_id", 64).primary().references("id").inTable("scan_jobs").onDelete("CASCADE");
      table.string("user_id", 64).notNullable();
      table.string("service_id", 64).notNullable();
      table.string("library_id", 64).notNullable();
      table.integer("checkpoint_version").notNullable();
      table.string("scan_session_id", 64).notNullable();
      table.string("generation_id", 64).notNullable();
      table.string("provider_type", 64).notNullable();
      table.text("provider_state_json").notNullable();
      table.text("progress_json").notNullable();
      table.text("nfo_sidecars_json").notNullable();
      table.text("changed_item_ids_json").notNullable();
      table.string("created_at", 40).notNullable();
      table.string("updated_at", 40).notNullable();
      table.index(["user_id", "updated_at"], "idx_scan_job_checkpoints_user_updated");
      table.index(["service_id", "updated_at"], "idx_scan_job_checkpoints_service_updated");
    });
  }

  if (!(await database.schema.hasTable("scan_root_runs"))) {
    await database.schema.createTable("scan_root_runs", (table) => {
      table.string("id", 64).primary();
      table.string("job_id", 64).notNullable().references("id").inTable("scan_jobs").onDelete("CASCADE");
      table.string("user_id", 64).notNullable();
      table.string("service_id", 64).notNullable();
      table.string("library_id", 64).notNullable();
      table.string("root_key", 64).notNullable();
      table.text("root_resource_id").notNullable();
      table.text("display_path").notNullable();
      table.string("generation_id", 64).notNullable();
      table.string("status", 32).notNullable();
      table.bigInteger("warning_count").notNullable().defaultTo(0);
      table.string("started_at", 40).notNullable();
      table.string("finished_at", 40).nullable();
      table.string("updated_at", 40).notNullable();
      table.unique(["job_id", "root_key"], { indexName: "uq_scan_root_runs_job_root" });
      table.index(["library_id", "status"], "idx_scan_root_runs_library_status");
    });
  }

  if (!(await database.schema.hasTable("tmdb_metadata_cache"))) {
    await database.schema.createTable("tmdb_metadata_cache", (table) => {
      // 缓存键为查询条件的 SHA-256，不保存用户、服务、网盘凭据或原始查询标题。
      table.string("cache_key", 64).primary();
      table.string("cache_kind", 32).notNullable();
      table.string("media_type", 16).notNullable();
      table.bigInteger("provider_item_id").notNullable();
      table.integer("season_number").nullable();
      table.string("language", 32).notNullable();
      table.string("region", 16).notNullable();
      table.integer("details_synchronized").notNullable().defaultTo(0);
      table.text("payload_json").notNullable();
      table.string("expires_at", 40).notNullable();
      table.string("created_at", 40).notNullable();
      table.string("updated_at", 40).notNullable();
      table.index(["expires_at"], "idx_tmdb_metadata_cache_expires");
      table.index(["cache_kind", "provider_item_id"], "idx_tmdb_metadata_cache_provider_item");
    });
  }

  if (!(await database.schema.hasTable("source_files"))) {
    await database.schema.createTable("source_files", (table) => {
      table.string("id", 64).primary();
      table.string("user_id", 64).notNullable();
      table.string("service_id", 64).notNullable();
      table.string("library_id", 64).notNullable();
      table.string("provider_resource_id", 512).notNullable();
      table.string("parent_resource_id", 512).nullable();
      table.text("path").notNullable();
      table.text("name").notNullable();
      table.string("extension", 32).notNullable();
      table.bigInteger("size").notNullable();
      table.string("modified_at", 40).nullable();
      table.string("etag", 255).nullable();
      table.string("scan_root_key", 64).nullable();
      table.string("generation_id", 64).notNullable();
      table.integer("metadata_profile_revision").notNullable().defaultTo(0);
      table.text("locator_json").notNullable();
      table.string("status", 32).notNullable();
      table.string("created_at", 40).notNullable();
      table.string("updated_at", 40).notNullable();
      table.unique(["user_id", "library_id", "provider_resource_id"], { indexName: "uq_source_files_resource" });
      table.index(["library_id", "generation_id"], "idx_source_files_generation");
      table.index(["library_id", "scan_root_key", "generation_id"], "idx_source_files_root_generation");
    });
  }
  await addColumnIfMissing(database, "source_files", "scan_root_key", (table) => {
    table.string("scan_root_key", 64).nullable();
  });
  await addColumnIfMissing(database, "source_files", "metadata_profile_revision", (table) => {
    table.integer("metadata_profile_revision").notNullable().defaultTo(0);
  });

  if (!(await database.schema.hasTable("media_probe_jobs"))) {
    await database.schema.createTable("media_probe_jobs", (table) => {
      table.string("id", 64).primary();
      table.string("user_id", 64).notNullable();
      table.string("service_id", 64).notNullable().references("id").inTable("cloud_services").onDelete("CASCADE");
      table.string("library_id", 64).notNullable().references("id").inTable("media_libraries").onDelete("CASCADE");
      table.string("requested_by_user_id", 64).notNullable();
      table.string("trigger_type", 32).notNullable();
      table.string("status", 32).notNullable();
      table.string("stage", 32).notNullable();
      table.bigInteger("processed_count").notNullable().defaultTo(0);
      table.bigInteger("total_count").notNullable().defaultTo(0);
      table.bigInteger("error_count").notNullable().defaultTo(0);
      table.text("current_file_name").nullable();
      table.string("error_code", 100).nullable();
      table.text("error_message").nullable();
      table.string("next_retry_at", 40).nullable();
      table.string("control_action", 32).notNullable().defaultTo("none");
      table.text("snapshot_json").notNullable();
      table.string("created_at", 40).notNullable();
      table.string("started_at", 40).nullable();
      table.string("finished_at", 40).nullable();
      table.bigInteger("active_duration_ms").notNullable().defaultTo(0);
      table.string("active_started_at", 40).nullable();
      table.string("updated_at", 40).notNullable();
      table.index(["user_id", "status", "created_at"], "idx_media_probe_jobs_user_status");
      table.index(["service_id", "status"], "idx_media_probe_jobs_service_status");
    });
  }
  await addColumnIfMissing(database, "media_probe_jobs", "error_code", (table) => {
    table.string("error_code", 100).nullable();
  });
  await addColumnIfMissing(database, "media_probe_jobs", "error_message", (table) => {
    table.text("error_message").nullable();
  });

  if (!(await database.schema.hasTable("media_file_probes"))) {
    await database.schema.createTable("media_file_probes", (table) => {
      // 关键变量：一个源文件只保存一份当前指纹对应的规格结果，文件变化时原位重新排队。
      table.string("source_file_id", 64).primary().references("id").inTable("source_files").onDelete("CASCADE");
      table.string("user_id", 64).notNullable();
      table.string("service_id", 64).notNullable();
      table.string("library_id", 64).notNullable();
      table.string("probe_job_id", 64).nullable();
      table.string("fingerprint", 64).notNullable();
      table.string("status", 32).notNullable();
      table.integer("attempt_count").notNullable().defaultTo(0);
      table.text("result_json").nullable();
      table.string("error_code", 100).nullable();
      table.text("error_message").nullable();
      table.string("next_retry_at", 40).nullable();
      table.string("started_at", 40).nullable();
      table.string("finished_at", 40).nullable();
      table.string("created_at", 40).notNullable();
      table.string("updated_at", 40).notNullable();
      table.index(["status", "next_retry_at", "created_at"], "idx_media_file_probes_queue");
      table.index(["service_id", "status"], "idx_media_file_probes_service_status");
      table.index(["library_id"], "idx_media_file_probes_library");
      table.index(["probe_job_id", "status"], "idx_media_file_probes_job_status");
    });
  }
  await addColumnIfMissing(database, "media_file_probes", "probe_job_id", (table) => {
    table.string("probe_job_id", 64).nullable();
    table.index(["probe_job_id", "status"], "idx_media_file_probes_job_status");
  });

  if (!(await database.schema.hasTable("media_items"))) {
    await database.schema.createTable("media_items", (table) => {
      table.string("id", 64).primary();
      table.string("user_id", 64).notNullable();
      table.string("service_id", 64).notNullable();
      table.string("library_id", 64).notNullable();
      table.string("identity_key", 128).notNullable();
      table.string("media_type", 32).notNullable();
      table.string("item_type", 64).notNullable();
      table.string("region_group", 32).notNullable().defaultTo("other");
      table.text("title").notNullable();
      table.text("sort_title").notNullable();
      table.text("subtitle").notNullable();
      table.integer("year").nullable();
      table.string("premiere_date", 40).nullable();
      table.text("overview").notNullable();
      table.text("poster_url").nullable();
      table.text("backdrop_url").nullable();
      table.string("match_state", 32).notNullable();
      table.text("external_ids_json").notNullable();
      table.text("metadata_json").notNullable();
      table.string("generation_id", 64).notNullable();
      table.string("created_at", 40).notNullable();
      table.string("updated_at", 40).notNullable();
      table.string("deleted_at", 40).nullable();
      table.unique(["user_id", "library_id", "identity_key"], { indexName: "uq_media_items_identity" });
      table.index(["user_id", "library_id", "media_type"], "idx_media_items_library_type");
      table.index(["library_id"], "idx_media_items_library");
      table.index(["service_id", "media_type"], "idx_media_items_service_type");
      table.index(["service_id", "item_type", "region_group", "deleted_at"], "idx_media_items_service_region");
      table.index(["user_id", "library_id", "deleted_at", "created_at"], "idx_media_items_catalog_created");
      table.index(["user_id", "library_id", "deleted_at", "sort_title"], "idx_media_items_catalog_title");
      table.index(["user_id", "library_id", "deleted_at", "year"], "idx_media_items_catalog_year");
      table.index(["user_id", "library_id", "deleted_at", "premiere_date"], "idx_media_items_catalog_premiere");
      table.index(["user_id", "deleted_at", "match_state"], "idx_media_items_user_match");
    });
  }
  await addColumnIfMissing(database, "media_items", "region_group", (table) => {
    // 关键变量：历史节目不执行地区补全，升级后统一留在“其他节目”。
    table.string("region_group", 32).notNullable().defaultTo("other");
  });
  await addIndexIfMissing(
    database,
    "media_items",
    ["service_id", "item_type", "region_group", "deleted_at"],
    "idx_media_items_service_region",
  );

  if (!(await database.schema.hasTable("media_relations"))) {
    await database.schema.createTable("media_relations", (table) => {
      table.string("id", 64).primary();
      table.string("user_id", 64).notNullable();
      table.string("library_id", 64).notNullable();
      table.string("parent_item_id", 64).notNullable().references("id").inTable("media_items").onDelete("CASCADE");
      table.string("child_item_id", 64).notNullable().references("id").inTable("media_items").onDelete("CASCADE");
      table.string("relation_type", 64).notNullable();
      table.integer("sort_order").notNullable().defaultTo(0);
      table.unique(["user_id", "parent_item_id", "child_item_id", "relation_type"], { indexName: "uq_media_relations_pair" });
      table.index(["library_id"], "idx_media_relations_library");
      table.index(["parent_item_id"], "idx_media_relations_parent_item");
      table.index(["child_item_id"], "idx_media_relations_child_item");
    });
  }

  if (!(await database.schema.hasTable("file_links"))) {
    await database.schema.createTable("file_links", (table) => {
      table.string("id", 64).primary();
      table.string("user_id", 64).notNullable();
      table.string("library_id", 64).notNullable();
      table.string("item_id", 64).notNullable().references("id").inTable("media_items").onDelete("CASCADE");
      table.string("source_file_id", 64).notNullable().references("id").inTable("source_files").onDelete("CASCADE");
      table.text("locator_json").notNullable();
      table.unique(["user_id", "item_id", "source_file_id"], { indexName: "uq_file_links_item_file" });
      table.unique(["user_id", "library_id", "source_file_id"], { indexName: "uq_file_links_source_owner" });
      table.index(["library_id"], "idx_file_links_library");
      table.index(["item_id"], "idx_file_links_item");
      table.index(["source_file_id"], "idx_file_links_source_file");
    });
  }

  if (!(await database.schema.hasTable("catalog_changes"))) {
    await database.schema.createTable("catalog_changes", (table) => {
      table.increments("id").primary();
      table.string("user_id", 64).notNullable();
      table.string("library_id", 64).notNullable();
      table.bigInteger("catalog_version").notNullable();
      table.string("entity_type", 64).notNullable();
      table.string("entity_id", 64).notNullable();
      table.string("change_type", 32).notNullable();
      table.string("created_at", 40).notNullable();
      table.index(["user_id", "library_id", "catalog_version"], "idx_catalog_changes_version");
      table.index(["library_id"], "idx_catalog_changes_library");
    });
  }
}

/** 把旧版本同一扫描批次共享的目录版本迁移为逐条单调递增版本。 */
async function migrateCatalogChangeVersions(database: Knex): Promise<void> {
  const libraries = await database("media_libraries").select("id", "catalog_version");
  for (const library of libraries) {
    const changes = await database("catalog_changes")
      .select("id")
      .where({ library_id: library.id })
      .orderBy("id", "asc");
    if (changes.length === 0) {
      continue;
    }
    const previousVersion = Number(library.catalog_version);
    const firstVersion = Math.max(0, previousVersion - changes.length);
    await database.transaction(async (transaction) => {
      for (const [index, change] of changes.entries()) {
        await transaction("catalog_changes").where({ id: change.id }).update({
          catalog_version: firstVersion + index + 1,
        });
      }
      await transaction("media_libraries").where({ id: library.id }).update({
        catalog_version: firstVersion + changes.length,
      });
    });
  }
}

/** 为媒体目录分页、排序和概览统计补充查询索引。 */
async function migrateCatalogQueryIndexes(database: Knex): Promise<void> {
  await database.schema.alterTable("media_items", (table) => {
    table.index(["user_id", "library_id", "deleted_at", "created_at"], "idx_media_items_catalog_created");
    table.index(["user_id", "library_id", "deleted_at", "sort_title"], "idx_media_items_catalog_title");
    table.index(["user_id", "library_id", "deleted_at", "year"], "idx_media_items_catalog_year");
    table.index(["user_id", "deleted_at", "match_state"], "idx_media_items_user_match");
  });
}

/** 从历史元数据 JSON 中读取可排序的电影上映日或节目首播日。 */
function readHistoricalPremiereDate(metadataJson: unknown): string | null {
  try {
    const metadata = JSON.parse(String(metadataJson ?? "{}")) as Record<string, unknown>;
    const rawDate = typeof metadata.releaseDate === "string"
      ? metadata.releaseDate
      : typeof metadata.airDate === "string" ? metadata.airDate : "";
    return /^\d{4}-\d{2}-\d{2}/u.test(rawDate) ? rawDate.slice(0, 10) : null;
  } catch {
    return null;
  }
}

/** 为首映日期排序增加独立字段、历史数据回填和复合索引。 */
async function migrateMediaPremiereDate(database: Knex): Promise<void> {
  await addColumnIfMissing(database, "media_items", "premiere_date", (table) => {
    table.string("premiere_date", 40).nullable();
  });
  // 关键变量：只读取顶层已匹配条目，避免把数万单集的播出日期误当成节目首映日期。
  const matchedTopLevelRows = await database("media_items")
    .select("id", "metadata_json")
    .where({ match_state: "matched" })
    .whereIn("item_type", ["video.movie", "video.series"])
    .whereNull("premiere_date");
  await database.transaction(async (transaction) => {
    for (const row of matchedTopLevelRows) {
      const premiereDate = readHistoricalPremiereDate(row.metadata_json);
      if (!premiereDate) continue;
      await transaction("media_items").where({ id: row.id }).update({ premiere_date: premiereDate });
    }
  });
  await database.schema.alterTable("media_items", (table) => {
    table.index(
      ["user_id", "library_id", "deleted_at", "premiere_date"],
      "idx_media_items_catalog_premiere",
    );
  });
}

/** 为按服务清空媒体库补齐过滤和外键级联删除索引，避免 PostgreSQL 逐条全表扫描。 */
async function migrateCatalogDeletionIndexes(database: Knex): Promise<void> {
  await addIndexIfMissing(database, "media_items", ["library_id"], "idx_media_items_library");
  await addIndexIfMissing(database, "media_relations", ["library_id"], "idx_media_relations_library");
  await addIndexIfMissing(database, "media_relations", ["parent_item_id"], "idx_media_relations_parent_item");
  await addIndexIfMissing(database, "media_relations", ["child_item_id"], "idx_media_relations_child_item");
  await addIndexIfMissing(database, "file_links", ["library_id"], "idx_file_links_library");
  await addIndexIfMissing(database, "file_links", ["item_id"], "idx_file_links_item");
  await addIndexIfMissing(database, "file_links", ["source_file_id"], "idx_file_links_source_file");
  await addIndexIfMissing(database, "catalog_changes", ["library_id"], "idx_catalog_changes_library");
}

/** 清理历史重复文件归属，并从数据库层保证一个源文件只能归属一个媒体条目。 */
async function migrateUniqueSourceFileOwnership(database: Knex): Promise<void> {
  const results = await repairDuplicateCatalogFileLinks(database);
  for (const result of results) {
    console.info(JSON.stringify({
      日志关键字: "codex-flycloud-file-link-repair",
      事件: "历史重复文件归属修复完成",
      媒体库ID: result.libraryId,
      重复源文件数量: result.duplicateSourceFileCount,
      删除旧关联数量: result.removedFileLinkCount,
      删除孤立子项数量: result.deletedLeafItemCount,
      删除孤立父项数量: result.deletedParentItemCount,
      最新目录版本: result.catalogVersion,
    }));
  }
  await addUniqueIfMissing(
    database,
    "file_links",
    ["user_id", "library_id", "source_file_id"],
    "uq_file_links_source_owner",
  );
}

/** 创建导出、插件和扩展审计表。 */
async function createOperationTables(database: Knex): Promise<void> {
  if (!(await database.schema.hasTable("user_notifications"))) {
    await database.schema.createTable("user_notifications", (table) => {
      table.string("id", 64).primary();
      table.string("user_id", 64).notNullable().references("id").inTable("user_accounts").onDelete("CASCADE");
      table.string("category", 32).notNullable();
      table.string("tone", 32).notNullable();
      table.string("title", 255).notNullable();
      table.text("message").notNullable();
      table.string("action_path", 500).nullable();
      table.string("created_at", 40).notNullable();
      table.index(["user_id", "created_at"], "idx_user_notifications_user_created");
    });
  }

  if (!(await database.schema.hasTable("system_secret_settings"))) {
    await database.schema.createTable("system_secret_settings", (table) => {
      table.string("setting_key", 100).primary();
      table.text("encrypted_payload").notNullable();
      table.integer("revision").notNullable();
      table.string("updated_by_user_id", 64).nullable();
      table.string("created_at", 40).notNullable();
      table.string("updated_at", 40).notNullable();
    });
  }
  if (!(await database.schema.hasTable("system_settings"))) {
    await database.schema.createTable("system_settings", (table) => {
      table.string("setting_key", 100).primary();
      table.text("setting_value").notNullable();
      table.integer("revision").notNullable().defaultTo(1);
      table.string("updated_by_user_id", 64).nullable();
      table.string("created_at", 40).notNullable();
      table.string("updated_at", 40).notNullable();
    });
  }

  if (!(await database.schema.hasTable("library_exports"))) {
    await database.schema.createTable("library_exports", (table) => {
      table.string("id", 64).primary();
      table.string("user_id", 64).notNullable();
      table.string("library_id", 64).notNullable();
      table.string("export_type", 32).notNullable();
      table.string("status", 32).notNullable();
      table.string("stage", 32).notNullable().defaultTo("queued");
      table.integer("progress_percent").notNullable().defaultTo(0);
      table.bigInteger("processed_count").notNullable().defaultTo(0);
      table.bigInteger("total_count").notNullable().defaultTo(0);
      table.bigInteger("catalog_version").notNullable().defaultTo(0);
      table.integer("format_version").notNullable().defaultTo(1);
      table.text("file_path").nullable();
      table.bigInteger("file_size").nullable();
      table.text("error_message").nullable();
      table.string("created_at", 40).notNullable();
      table.string("updated_at", 40).nullable();
      table.string("completed_at", 40).nullable();
    });
  }
  await addColumnIfMissing(database, "library_exports", "stage", (table) => {
    table.string("stage", 32).notNullable().defaultTo("completed");
  });
  await addColumnIfMissing(database, "library_exports", "progress_percent", (table) => {
    table.integer("progress_percent").notNullable().defaultTo(0);
  });
  await addColumnIfMissing(database, "library_exports", "processed_count", (table) => {
    table.bigInteger("processed_count").notNullable().defaultTo(0);
  });
  await addColumnIfMissing(database, "library_exports", "total_count", (table) => {
    table.bigInteger("total_count").notNullable().defaultTo(0);
  });
  await addColumnIfMissing(database, "library_exports", "catalog_version", (table) => {
    table.bigInteger("catalog_version").notNullable().defaultTo(0);
  });
  await addColumnIfMissing(database, "library_exports", "format_version", (table) => {
    table.integer("format_version").notNullable().defaultTo(1);
  });
  await addColumnIfMissing(database, "library_exports", "updated_at", (table) => {
    table.string("updated_at", 40).nullable();
  });
  await addColumnIfMissing(database, "library_exports", "completed_at", (table) => {
    table.string("completed_at", 40).nullable();
  });
  await addIndexIfMissing(
    database,
    "library_exports",
    ["user_id", "library_id", "created_at"],
    "idx_library_exports_user_library_created",
  );
  await addIndexIfMissing(
    database,
    "library_exports",
    ["library_id", "status"],
    "idx_library_exports_library_status",
  );

  if (!(await database.schema.hasTable("metadata_plugin_versions"))) {
    await database.schema.createTable("metadata_plugin_versions", (table) => {
      table.string("id", 64).primary();
      table.string("plugin_id", 64).notNullable();
      table.string("version", 100).notNullable();
      table.string("display_name", 255).notNullable();
      table.string("status", 32).notNullable();
      table.string("sha256", 64).notNullable();
      table.text("manifest_json").notNullable();
      table.text("installed_path").notNullable();
      table.integer("configuration_revision").notNullable().defaultTo(0);
      table.string("created_at", 40).notNullable();
      table.string("updated_at", 40).notNullable();
      table.unique(["plugin_id", "version"], { indexName: "uq_metadata_plugin_versions" });
    });
  }

  if (!(await database.schema.hasTable("metadata_plugin_configurations"))) {
    await database.schema.createTable("metadata_plugin_configurations", (table) => {
      table.string("id", 64).primary();
      table.string("plugin_id", 64).notNullable();
      table.string("version", 100).notNullable();
      table.integer("revision").notNullable();
      table.text("configuration_json").notNullable();
      table.text("encrypted_secrets").nullable();
      table.text("configuration_state_json").notNullable();
      table.string("created_at", 40).notNullable();
      table.unique(["plugin_id", "version", "revision"], { indexName: "uq_metadata_plugin_configurations" });
    });
  }

  if (!(await database.schema.hasTable("audit_log_entries"))) {
    await database.schema.createTable("audit_log_entries", (table) => {
      table.string("id", 64).primary();
      table.string("operator_user_id", 64).nullable();
      table.string("operator_username", 255).nullable();
      table.string("operation_type", 100).notNullable();
      table.string("target_type", 64).notNullable();
      table.string("target_id", 255).nullable();
      table.string("result", 32).notNullable();
      table.text("detail_json").notNullable();
      table.string("created_at", 40).notNullable();
      table.index(["created_at"], "idx_audit_log_entries_created_at");
      table.index(["operator_user_id"], "idx_audit_log_entries_operator");
    });
  }
}

/** 将旧版服务级 Jellyfin 开关一次性迁移到对应媒体库。 */
async function migrateLibraryJellyfinOwnership(database: Knex): Promise<void> {
  if (!(await database.schema.hasColumn("cloud_services", "jellyfin_enabled"))) return;
  // 关键变量：只迁移旧结构中明确启用的服务，默认关闭的媒体库不需要逐条更新。
  const enabledServices = await database("cloud_services")
    .select("id")
    .where({ jellyfin_enabled: 1 })
    .whereNull("deleted_at");
  const serviceIds = enabledServices.map((service) => String(service.id));
  if (serviceIds.length > 0) {
    await database("media_libraries").whereIn("service_id", serviceIds).update({ jellyfin_enabled: 1 });
  }
}

/** 为已有媒体库生成默认 Jellyfin 地址后缀，并建立全局唯一约束。 */
async function migrateLibraryJellyfinPathSuffix(database: Knex): Promise<void> {
  const libraries = await database("media_libraries")
    .select("service_id", "jellyfin_path_suffix", "jellyfin_path_suffix_lookup");
  for (const library of libraries) {
    // 关键变量：历史媒体库继续使用服务 ID 作为后缀，避免升级时发生地址归属冲突。
    const pathSuffix = String(library.jellyfin_path_suffix ?? "").trim() || String(library.service_id);
    const pathSuffixLookup = String(library.jellyfin_path_suffix_lookup ?? "").trim() || pathSuffix.toLowerCase();
    await database("media_libraries").where({ service_id: library.service_id }).update({
      jellyfin_path_suffix: pathSuffix,
      jellyfin_path_suffix_lookup: pathSuffixLookup,
    });
  }
  await addUniqueIfMissing(database, "media_libraries", ["jellyfin_path_suffix_lookup"], "uq_media_libraries_jellyfin_path_suffix");
}

/** 将旧服务级中转开关迁移为媒体库 APP 中转开关，并保留 Jellyfin 原有中转能力。 */
async function migrateLibraryRelayPlaybackSettings(database: Knex): Promise<void> {
  const services = await database("cloud_services")
    .select("id", "relay_playback_enabled", "deleted_at");
  for (const service of services) {
    // 关键变量：APP 中转沿用升级前的服务开关，Jellyfin 中转默认启用以保持升级前行为。
    const serviceDeleted = Boolean(service.deleted_at);
    await database("media_libraries").where({ service_id: service.id }).update({
      app_relay_playback_enabled: !serviceDeleted && Number(service.relay_playback_enabled) === 1 ? 1 : 0,
      jellyfin_relay_playback_enabled: serviceDeleted ? 0 : 1,
    });
  }
}

/** 每台设备只保留一个指向同一云端服务的本地卡片绑定。 */
async function migrateUniqueCloudServiceDeviceBinding(database: Knex): Promise<void> {
  const bindings = await database("client_service_links")
    .select("id", "user_id", "service_id", "client_device_id", "updated_at")
    .orderBy("updated_at", "desc");
  const seen = new Set<string>(); // 关键变量：排序后第一条是需要保留的最新绑定。
  const duplicateIds: string[] = [];
  for (const binding of bindings) {
    const key = `${binding.user_id}:${binding.service_id}:${binding.client_device_id}`;
    if (seen.has(key)) duplicateIds.push(String(binding.id));
    else seen.add(key);
  }
  if (duplicateIds.length > 0) await database("client_service_links").whereIn("id", duplicateIds).delete();
  await addUniqueIfMissing(
    database,
    "client_service_links",
    ["user_id", "service_id", "client_device_id"],
    "uq_client_service_links_cloud_device",
  );
}

/** 创建或升级 FlyCloudHelper 全部后台表。 */
export async function migrateDatabase(database: Knex): Promise<void> {
  await createIdentityTables(database);
  await createServiceTables(database);
  await createCatalogTables(database);
  await createPlaybackTables(database);
  await createOperationTables(database);

  const now = new Date().toISOString();
  const existingState = await database("system_state").where({ singleton_id: 1 }).first();
  if (!existingState) {
    await database("system_state").insert({
      singleton_id: 1,
      service_instance_id: randomUUID(),
      initial_setup_completed_at: null,
      credential_key_fingerprint: null,
      credential_key_source: null,
      credential_key_backup_required: 0,
      schema_version: currentSchemaVersion,
      created_at: now,
      updated_at: now,
    });
  } else {
    if (Number(existingState.schema_version ?? 0) < 5) {
      await migrateCatalogChangeVersions(database);
    }
    if (Number(existingState.schema_version ?? 0) < 8) {
      await migrateCatalogQueryIndexes(database);
    }
    if (Number(existingState.schema_version ?? 0) < 11) {
      await migrateMediaPremiereDate(database);
    }
    if (Number(existingState.schema_version ?? 0) < 16) {
      await migrateCatalogDeletionIndexes(database);
    }
    if (Number(existingState.schema_version ?? 0) < 20) {
      await migrateUniqueSourceFileOwnership(database);
    }
    if (Number(existingState.schema_version ?? 0) < 29) {
      await migrateLibraryJellyfinOwnership(database);
    }
    if (Number(existingState.schema_version ?? 0) < 30) {
      await migrateLibraryJellyfinPathSuffix(database);
    }
    if (Number(existingState.schema_version ?? 0) < 31) {
      await migrateLibraryRelayPlaybackSettings(database);
    }
    if (Number(existingState.schema_version ?? 0) < 32) {
      await migrateUniqueCloudServiceDeviceBinding(database);
    }
    await database("system_state").where({ singleton_id: 1 }).update({
      service_instance_id: existingState.service_instance_id || randomUUID(),
      schema_version: currentSchemaVersion,
      updated_at: now,
    });
  }
}
