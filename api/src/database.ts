import fs from "node:fs";
import path from "node:path";
import knex, { type Knex } from "knex";
import type { ApiConfig } from "./config.js";
import {
  type AuditRecord,
  type AuthenticationRecord,
  type PublicUserRecord,
  type SystemStateRecord,
  type UserRole,
  type UserStatus,
  parseJsonObject,
} from "./domain.js";
import { ApiError } from "./errors.js";
import { currentSchemaVersion, migrateDatabase } from "./schema.js";

interface UserRow {
  id: string;
  tenant_id: string;
  username: string;
  role: UserRole;
  status: UserStatus;
  created_at: string;
  last_login_at: string | null;
}

interface AuthenticationRow extends UserRow {
  password_hash: string;
}

/** 将数据库用户行转换为公开用户结构。 */
function mapPublicUser(row: UserRow): PublicUserRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    username: row.username,
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}

/** 判断 SQLite、PostgreSQL 或 MySQL 异常是否为唯一约束冲突。 */
function isUniqueConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = String((error as Error & { code?: string }).code ?? "");
  return code.startsWith("SQLITE_CONSTRAINT") || code === "23505" || code === "ER_DUP_ENTRY";
}

/** 按配置创建 Knex 数据库连接。 */
function createConnection(config: ApiConfig): Knex {
  if (config.databaseType === "sqlite") {
    fs.mkdirSync(path.dirname(config.sqlitePath), { recursive: true });
    return knex({
      client: "better-sqlite3",
      connection: { filename: config.sqlitePath },
      useNullAsDefault: true,
      pool: { min: 1, max: 1 },
    });
  }
  return knex({
    client: config.databaseType === "postgres" ? "pg" : "mysql2",
    connection: config.databaseUrl ?? undefined,
    pool: { min: 1, max: 10 },
  });
}

/** 管理跨数据库连接、迁移和身份认证基础数据访问。 */
export class FlyCloudHelperDatabase {
  public readonly query: Knex;
  public readonly databaseType: ApiConfig["databaseType"];

  public constructor(config: ApiConfig) {
    this.databaseType = config.databaseType;
    this.query = createConnection(config);
  }

  /** 建立连接、启用 SQLite 安全参数并执行迁移。 */
  public async initialize(): Promise<void> {
    if (this.databaseType === "sqlite") {
      await this.query.raw("PRAGMA journal_mode = WAL");
      await this.query.raw("PRAGMA foreign_keys = ON");
      await this.query.raw("PRAGMA busy_timeout = 5000");
    }
    await migrateDatabase(this.query);
  }

  /** 关闭数据库连接池。 */
  public async close(): Promise<void> {
    await this.query.destroy();
  }

  /** 查询实例身份、schema 和首次初始化状态。 */
  public async getSystemState(): Promise<SystemStateRecord> {
    const row = await this.query("system_state").where({ singleton_id: 1 }).first();
    if (!row) {
      throw new Error("system_state 缺失");
    }
    return {
      serviceInstanceId: String(row.service_instance_id),
      setupRequired: !row.initial_setup_completed_at,
      credentialKeyBackupRequired: Boolean(row.credential_key_backup_required),
      credentialKeySource: row.credential_key_source
        ? String(row.credential_key_source) as SystemStateRecord["credentialKeySource"]
        : null,
      schemaVersion: Number(row.schema_version ?? currentSchemaVersion),
    };
  }

  /** 将当前主密钥指纹绑定到数据库，阻止密钥丢失后静默生成新密钥。 */
  public async bindCredentialMasterKey(input: {
    fingerprint: string;
    source: "file" | "environment" | "generated";
    generatedNow: boolean;
  }): Promise<void> {
    const state = await this.query("system_state").where({ singleton_id: 1 }).first();
    if (!state) throw new Error("system_state 缺失");
    if (state.credential_key_fingerprint) {
      if (String(state.credential_key_fingerprint) !== input.fingerprint) {
        throw new Error("凭据主密钥与数据库记录不一致，请恢复原主密钥后重启");
      }
      if (String(state.credential_key_source ?? "") !== input.source
        || (input.source !== "generated" && Boolean(state.credential_key_backup_required))) {
        await this.query("system_state").where({ singleton_id: 1 }).update({
          credential_key_source: input.source,
          credential_key_backup_required: input.source === "generated"
            ? Number(state.credential_key_backup_required ?? 0)
            : 0,
          updated_at: new Date().toISOString(),
        });
      }
      return;
    }

    const [credentialCountRow, pluginSecretCountRow, systemSecretCountRow] = await Promise.all([
      this.query("service_credentials").count<{ count: string | number }[]>({ count: "id" }).first(),
      this.query("metadata_plugin_configurations")
        .whereNotNull("encrypted_secrets")
        .count<{ count: string | number }[]>({ count: "id" })
        .first(),
      this.query("system_secret_settings").count<{ count: string | number }[]>({ count: "setting_key" }).first(),
    ]);
    const encryptedRecordCount = Number(credentialCountRow?.count ?? 0)
      + Number(pluginSecretCountRow?.count ?? 0)
      + Number(systemSecretCountRow?.count ?? 0);
    if (input.generatedNow && encryptedRecordCount > 0) {
      throw new Error("数据库已有加密凭据但原主密钥缺失，请恢复原主密钥，禁止使用新生成密钥覆盖");
    }

    const now = new Date().toISOString();
    await this.query("system_state").where({ singleton_id: 1 }).update({
      credential_key_fingerprint: input.fingerprint,
      credential_key_source: input.source,
      credential_key_backup_required: input.source === "generated" ? 1 : 0,
      updated_at: now,
    });
  }

  /** 标记管理员已经完成自动生成主密钥的外部备份。 */
  public async acknowledgeCredentialKeyBackup(): Promise<void> {
    await this.query("system_state").where({ singleton_id: 1 }).update({
      credential_key_backup_required: 0,
      updated_at: new Date().toISOString(),
    });
  }

  /** 读取系统级加密配置，不向调用方暴露数据库之外的其他信息。 */
  public async getSystemSecretSetting(settingKey: string): Promise<{
    encryptedPayload: string;
    revision: number;
  } | null> {
    const row = await this.query("system_secret_settings").where({ setting_key: settingKey }).first();
    return row ? {
      encryptedPayload: String(row.encrypted_payload),
      revision: Number(row.revision),
    } : null;
  }

  /** 原子新增或替换系统级加密配置并递增修订号。 */
  public async saveSystemSecretSetting(input: {
    settingKey: string;
    encryptedPayload: string;
    updatedByUserId: string;
  }): Promise<number> {
    return this.query.transaction(async (transaction) => {
      const existing = await transaction("system_secret_settings")
        .where({ setting_key: input.settingKey })
        .first();
      const now = new Date().toISOString();
      const revision = Number(existing?.revision ?? 0) + 1;
      if (existing) {
        await transaction("system_secret_settings").where({ setting_key: input.settingKey }).update({
          encrypted_payload: input.encryptedPayload,
          revision,
          updated_by_user_id: input.updatedByUserId,
          updated_at: now,
        });
      } else {
        await transaction("system_secret_settings").insert({
          setting_key: input.settingKey,
          encrypted_payload: input.encryptedPayload,
          revision,
          updated_by_user_id: input.updatedByUserId,
          created_at: now,
          updated_at: now,
        });
      }
      return revision;
    });
  }

  /** 查询实例是否仍需要首次初始化。 */
  public async isSetupRequired(): Promise<boolean> {
    return (await this.getSystemState()).setupRequired;
  }

  /** 原子创建首个超级管理员、个人租户和初始化完成标记。 */
  public async initializeSuperAdmin(input: {
    userId: string;
    tenantId: string;
    username: string;
    usernameLookup: string;
    passwordHash: string;
    auditId: string;
  }): Promise<PublicUserRecord> {
    try {
      return await this.query.transaction(async (transaction) => {
        const now = new Date().toISOString();
        const changedRows = await transaction("system_state")
          .where({ singleton_id: 1 })
          .whereNull("initial_setup_completed_at")
          .update({ initial_setup_completed_at: now, updated_at: now });
        if (changedRows !== 1) {
          throw new ApiError(409, "setup_already_completed", "首次初始化已经完成");
        }
        const existingAdministrator = await transaction("user_accounts")
          .where({ role: "super_admin" })
          .first();
        if (existingAdministrator) {
          throw new ApiError(409, "setup_already_completed", "首次初始化已经完成");
        }
        await this.insertUser(transaction, {
          userId: input.userId,
          tenantId: input.tenantId,
          username: input.username,
          usernameLookup: input.usernameLookup,
          passwordHash: input.passwordHash,
          role: "super_admin",
          now,
        });
        await transaction("audit_log_entries").insert({
          id: input.auditId,
          operator_user_id: input.userId,
          operator_username: input.username,
          operation_type: "initialize_super_admin",
          target_type: "user",
          target_id: input.userId,
          result: "success",
          detail_json: "{}",
          created_at: now,
        });
        return this.findPublicUserById(input.userId, transaction);
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ApiError(409, "username_conflict", "用户名已被使用");
      }
      throw error;
    }
  }

  /** 创建普通用户或管理员指定角色用户及其个人租户。 */
  public async createUser(input: {
    userId: string;
    tenantId: string;
    username: string;
    usernameLookup: string;
    passwordHash: string;
    role?: UserRole;
  }): Promise<PublicUserRecord> {
    try {
      return await this.query.transaction(async (transaction) => {
        const state = await transaction("system_state").where({ singleton_id: 1 }).first();
        if (!state?.initial_setup_completed_at) {
          throw new ApiError(503, "setup_required", "实例尚未完成首次初始化");
        }
        const now = new Date().toISOString();
        await this.insertUser(transaction, {
          ...input,
          role: input.role ?? "user",
          now,
        });
        return this.findPublicUserById(input.userId, transaction);
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ApiError(409, "username_conflict", "用户名已被使用");
      }
      throw error;
    }
  }

  /** 在事务中写入用户、密码和个人租户。 */
  private async insertUser(
    transaction: Knex.Transaction,
    input: {
      userId: string;
      tenantId: string;
      username: string;
      usernameLookup: string;
      passwordHash: string;
      role: UserRole;
      now: string;
    },
  ): Promise<void> {
    await transaction("user_accounts").insert({
      id: input.userId,
      username: input.username,
      username_lookup: input.usernameLookup,
      role: input.role,
      status: "active",
      last_login_at: null,
      created_at: input.now,
      updated_at: input.now,
    });
    await transaction("user_passwords").insert({
      user_id: input.userId,
      password_hash: input.passwordHash,
      password_changed_at: input.now,
    });
    await transaction("tenants").insert({
      id: input.tenantId,
      user_id: input.userId,
      status: "active",
      created_at: input.now,
    });
  }

  /** 按用户 ID 查询公开用户。 */
  public async findPublicUserById(
    userId: string,
    transaction: Knex | Knex.Transaction = this.query,
  ): Promise<PublicUserRecord> {
    const row = (await transaction("user_accounts as u")
      .join("tenants as t", "t.user_id", "u.id")
      .select(
        "u.id",
        "t.id as tenant_id",
        "u.username",
        "u.role",
        "u.status",
        "u.created_at",
        "u.last_login_at",
      )
      .where("u.id", userId)
      .first()) as UserRow | undefined;
    if (!row) {
      throw new ApiError(404, "user_not_found", "用户不存在");
    }
    return mapPublicUser(row);
  }

  /** 按大小写不敏感用户名查询认证记录。 */
  public async findAuthenticationByUsername(usernameLookup: string): Promise<AuthenticationRecord | null> {
    const row = (await this.query("user_accounts as u")
      .join("tenants as t", "t.user_id", "u.id")
      .join("user_passwords as p", "p.user_id", "u.id")
      .select(
        "u.id",
        "t.id as tenant_id",
        "u.username",
        "u.role",
        "u.status",
        "u.created_at",
        "u.last_login_at",
        "p.password_hash",
      )
      .where("u.username_lookup", usernameLookup)
      .first()) as AuthenticationRow | undefined;
    return row ? { ...mapPublicUser(row), passwordHash: row.password_hash } : null;
  }

  /** 记录用户成功登录时间。 */
  public async markUserLogin(userId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.query("user_accounts").where({ id: userId }).update({
      last_login_at: now,
      updated_at: now,
    });
  }

  /** 创建浏览器或 APP 访问会话。 */
  public async createSession(input: {
    sessionId: string;
    userId: string;
    tokenHash: string;
    expiresAt: string;
  }): Promise<void> {
    const now = new Date().toISOString();
    await this.query("user_sessions").insert({
      id: input.sessionId,
      user_id: input.userId,
      token_hash: input.tokenHash,
      expires_at: input.expiresAt,
      created_at: now,
      last_seen_at: now,
      revoked_at: null,
    });
  }

  /** 根据访问 Token 哈希查询当前用户。 */
  public async findUserBySessionTokenHash(tokenHash: string): Promise<PublicUserRecord | null> {
    const now = new Date().toISOString();
    const row = (await this.query("user_sessions as s")
      .join("user_accounts as u", "u.id", "s.user_id")
      .join("tenants as t", "t.user_id", "u.id")
      .select(
        "u.id",
        "t.id as tenant_id",
        "u.username",
        "u.role",
        "u.status",
        "u.created_at",
        "u.last_login_at",
      )
      .where("s.token_hash", tokenHash)
      .whereNull("s.revoked_at")
      .where("s.expires_at", ">", now)
      .where("u.status", "active")
      .first()) as UserRow | undefined;
    if (!row) {
      return null;
    }
    await this.query("user_sessions").where({ token_hash: tokenHash }).update({ last_seen_at: now });
    return mapPublicUser(row);
  }

  /** 撤销单个访问会话。 */
  public async revokeSession(tokenHash: string): Promise<void> {
    await this.query("user_sessions")
      .where({ token_hash: tokenHash })
      .whereNull("revoked_at")
      .update({ revoked_at: new Date().toISOString() });
  }

  /** 创建 APP 刷新令牌记录。 */
  public async createRefreshToken(input: {
    id: string;
    userId: string;
    tokenHash: string;
    familyId: string;
    expiresAt: string;
  }): Promise<void> {
    await this.query("refresh_tokens").insert({
      id: input.id,
      user_id: input.userId,
      token_hash: input.tokenHash,
      family_id: input.familyId,
      expires_at: input.expiresAt,
      created_at: new Date().toISOString(),
      rotated_at: null,
      revoked_at: null,
    });
  }

  /** 原子轮换有效刷新令牌，并返回对应用户及令牌家族。 */
  public async consumeRefreshToken(tokenHash: string): Promise<{
    user: PublicUserRecord;
    familyId: string;
  } | null> {
    return this.query.transaction(async (transaction) => {
      const now = new Date().toISOString();
      const row = await transaction("refresh_tokens")
        .where({ token_hash: tokenHash })
        .whereNull("rotated_at")
        .whereNull("revoked_at")
        .where("expires_at", ">", now)
        .first();
      if (!row) {
        return null;
      }
      const changed = await transaction("refresh_tokens")
        .where({ id: row.id })
        .whereNull("rotated_at")
        .update({ rotated_at: now });
      if (changed !== 1) {
        return null;
      }
      return {
        user: await this.findPublicUserById(String(row.user_id), transaction),
        familyId: String(row.family_id),
      };
    });
  }

  /** 撤销单个刷新令牌。 */
  public async revokeRefreshToken(tokenHash: string): Promise<void> {
    await this.query("refresh_tokens")
      .where({ token_hash: tokenHash })
      .whereNull("revoked_at")
      .update({ revoked_at: new Date().toISOString() });
  }

  /** 撤销用户全部访问和刷新会话。 */
  public async revokeAllUserSessions(userId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.query.transaction(async (transaction) => {
      await transaction("user_sessions").where({ user_id: userId }).whereNull("revoked_at").update({ revoked_at: now });
      await transaction("refresh_tokens").where({ user_id: userId }).whereNull("revoked_at").update({ revoked_at: now });
    });
  }

  /** 查询用户列表和其服务、媒体数量。 */
  public async listUsers(filters: {
    keyword?: string;
    role?: UserRole;
    status?: UserStatus;
    limit: number;
    offset: number;
  }): Promise<{ items: Array<PublicUserRecord & { serviceCount: number; mediaCount: number }>; total: number }> {
    const base = this.query("user_accounts as u").join("tenants as t", "t.user_id", "u.id");
    if (filters.keyword) {
      base.whereLike("u.username", `%${filters.keyword}%`);
    }
    if (filters.role) {
      base.where("u.role", filters.role);
    }
    if (filters.status) {
      base.where("u.status", filters.status);
    }
    const countRow = await base.clone().count<{ count: string | number }[]>({ count: "u.id" }).first();
    const rows = (await base
      .clone()
      .select(
        "u.id",
        "t.id as tenant_id",
        "u.username",
        "u.role",
        "u.status",
        "u.created_at",
        "u.last_login_at",
      )
      .orderBy("u.created_at", "desc")
      .limit(filters.limit)
      .offset(filters.offset)) as UserRow[];
    const items = await Promise.all(rows.map(async (row) => {
      const serviceCountRow = await this.query("cloud_services").where({ tenant_id: row.tenant_id }).whereNull("deleted_at").count<{ count: string | number }[]>({ count: "id" }).first();
      const mediaCountRow = await this.query("media_items as m")
        .join("cloud_services as s", "s.id", "m.service_id")
        .where("m.tenant_id", row.tenant_id)
        .whereNull("m.deleted_at")
        .whereNull("s.deleted_at")
        .count<{ count: string | number }[]>({ count: "m.id" })
        .first();
      return {
        ...mapPublicUser(row),
        serviceCount: Number(serviceCountRow?.count ?? 0),
        mediaCount: Number(mediaCountRow?.count ?? 0),
      };
    }));
    return { items, total: Number(countRow?.count ?? 0) };
  }

  /** 更新用户密码并撤销全部旧会话。 */
  public async resetUserPassword(userId: string, passwordHash: string): Promise<void> {
    const now = new Date().toISOString();
    const changed = await this.query("user_passwords").where({ user_id: userId }).update({
      password_hash: passwordHash,
      password_changed_at: now,
    });
    if (changed !== 1) {
      throw new ApiError(404, "user_not_found", "用户不存在");
    }
    await this.revokeAllUserSessions(userId);
  }

  /** 修改用户角色，并保护最后一个有效超级管理员。 */
  public async updateUserRole(userId: string, role: UserRole): Promise<PublicUserRecord> {
    await this.query.transaction(async (transaction) => {
      const target = await transaction("user_accounts").where({ id: userId }).first();
      if (!target) {
        throw new ApiError(404, "user_not_found", "用户不存在");
      }
      if (target.role === "super_admin" && role !== "super_admin") {
        const count = await transaction("user_accounts")
          .where({ role: "super_admin", status: "active" })
          .count<{ count: string | number }[]>({ count: "id" })
          .first();
        if (Number(count?.count ?? 0) <= 1) {
          throw new ApiError(409, "last_super_admin", "不能撤销最后一个有效超级管理员");
        }
      }
      await transaction("user_accounts").where({ id: userId }).update({
        role,
        updated_at: new Date().toISOString(),
      });
    });
    await this.revokeAllUserSessions(userId);
    return this.findPublicUserById(userId);
  }

  /** 修改用户状态，并保护最后一个有效超级管理员。 */
  public async updateUserStatus(userId: string, status: UserStatus): Promise<PublicUserRecord> {
    const user = await this.findPublicUserById(userId);
    if (user.role === "super_admin" && user.status === "active" && status !== "active") {
      const count = await this.query("user_accounts")
        .where({ role: "super_admin", status: "active" })
        .count<{ count: string | number }[]>({ count: "id" })
        .first();
      if (Number(count?.count ?? 0) <= 1) {
        throw new ApiError(409, "last_super_admin", "不能停用最后一个有效超级管理员");
      }
    }
    await this.query("user_accounts").where({ id: userId }).update({
      status,
      updated_at: new Date().toISOString(),
    });
    if (status !== "active") {
      await this.revokeAllUserSessions(userId);
    }
    return this.findPublicUserById(userId);
  }

  /** 写入不含敏感值的管理审计记录。 */
  public async addAudit(input: {
    id: string;
    operatorUserId: string | null;
    operatorUsername: string | null;
    operationType: string;
    targetType: string;
    targetId: string | null;
    result: string;
    detail?: Record<string, unknown>;
  }): Promise<void> {
    await this.query("audit_log_entries").insert({
      id: input.id,
      operator_user_id: input.operatorUserId,
      operator_username: input.operatorUsername,
      operation_type: input.operationType,
      target_type: input.targetType,
      target_id: input.targetId,
      result: input.result,
      detail_json: JSON.stringify(input.detail ?? {}),
      created_at: new Date().toISOString(),
    });
  }

  /** 分页查询脱敏管理审计记录。 */
  public async listAuditLogs(limit: number, offset: number): Promise<{ items: AuditRecord[]; total: number }> {
    const countRow = await this.query("audit_log_entries").count<{ count: string | number }[]>({ count: "id" }).first();
    const rows = await this.query("audit_log_entries").orderBy("created_at", "desc").limit(limit).offset(offset);
    return {
      items: rows.map((row) => ({
        id: String(row.id),
        operatorUserId: row.operator_user_id ? String(row.operator_user_id) : null,
        operatorUsername: row.operator_username ? String(row.operator_username) : null,
        operationType: String(row.operation_type),
        targetType: String(row.target_type),
        targetId: row.target_id ? String(row.target_id) : null,
        result: String(row.result),
        detail: parseJsonObject(row.detail_json),
        createdAt: String(row.created_at),
      })),
      total: Number(countRow?.count ?? 0),
    };
  }
}
