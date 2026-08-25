import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import knex, { type Knex } from "knex";
import type { ApiConfig } from "./config.js";
import {
  type AuditRecord,
  type AuthenticationRecord,
  type NotificationCategory,
  type NotificationRecord,
  type NotificationTone,
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
  username: string;
  role: UserRole;
  status: UserStatus;
  created_at: string;
  last_login_at: string | null;
}

interface AuthenticationRow extends UserRow {
  password_hash: string;
}

type DatabaseBootstrapLogger = (
  level: "info" | "warn",
  fields: Record<string, string | number | boolean | null>,
) => void;

interface RemoteDatabaseTarget {
  databaseName: string;
  host: string;
  port: number;
  targetUrl: string;
  bootstrapUrl: string;
}

/** 提取数据库驱动错误码，不把连接地址或密码写入日志。 */
function getDatabaseErrorCode(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "unknown";
  }
  const databaseError = error as { code?: string; errno?: number };
  return String(databaseError.code ?? databaseError.errno ?? "unknown");
}

/** 判断连接失败是否仅仅因为目标数据库尚不存在。 */
function isDatabaseMissingError(databaseType: "postgres" | "mysql", error: unknown): boolean {
  const errorCode = getDatabaseErrorCode(error);
  return databaseType === "postgres"
    ? errorCode === "3D000"
    : errorCode === "ER_BAD_DB_ERROR" || errorCode === "1049";
}

/** 解析目标数据库及用于自动建库的服务器级连接地址。 */
function parseRemoteDatabaseTarget(config: ApiConfig): RemoteDatabaseTarget {
  if (!config.databaseUrl || config.databaseType === "sqlite") {
    throw new Error("远端数据库连接配置缺失");
  }
  const targetUrl = new URL(config.databaseUrl);
  const expectedProtocols = config.databaseType === "postgres"
    ? new Set(["postgres:", "postgresql:"])
    : new Set(["mysql:"]);
  if (!expectedProtocols.has(targetUrl.protocol)) {
    throw new Error(`${config.databaseType} 数据库连接协议不正确`);
  }
  const databaseName = decodeURIComponent(targetUrl.pathname.replace(/^\/+/, ""));
  if (!/^[A-Za-z0-9_]+$/.test(databaseName) || databaseName.length > 63) {
    throw new Error("数据库名称只能包含英文字母、数字和下划线，且不能超过 63 个字符");
  }

  const bootstrapUrl = new URL(targetUrl);
  bootstrapUrl.pathname = config.databaseType === "postgres" ? "/postgres" : "/";
  return {
    databaseName,
    host: targetUrl.hostname,
    port: Number(targetUrl.port || (config.databaseType === "postgres" ? 5432 : 3306)),
    targetUrl: targetUrl.toString(),
    bootstrapUrl: bootstrapUrl.toString(),
  };
}

/** 创建一个只用于连通性检查或自动建库的短生命周期连接。 */
function createTemporaryConnection(databaseType: "postgres" | "mysql", connectionUrl: string): Knex {
  return knex({
    client: databaseType === "postgres" ? "pg" : "mysql2",
    connection: connectionUrl,
    pool: { min: 0, max: 1 },
  });
}

/** 检查目标数据库，不存在时使用同一账号尝试安全创建。 */
async function ensureRemoteDatabase(
  config: ApiConfig,
  logger: DatabaseBootstrapLogger,
): Promise<void> {
  if (config.databaseType === "sqlite") {
    return;
  }
  const databaseType = config.databaseType;
  const target = parseRemoteDatabaseTarget(config);
  const logContext = {
    日志关键字: "codex-flycloud-helper-database-bootstrap",
    数据库类型: databaseType,
    数据库地址: target.host,
    数据库端口: target.port,
    数据库名称: target.databaseName,
  };
  const targetConnection = createTemporaryConnection(databaseType, target.targetUrl);
  try {
    await targetConnection.raw("SELECT 1");
    logger("info", { ...logContext, 事件: "目标数据库已存在" });
    return;
  } catch (error) {
    if (!isDatabaseMissingError(databaseType, error)) {
      throw error;
    }
  } finally {
    await targetConnection.destroy();
  }

  if (!config.databaseAutoCreate) {
    throw new Error(`数据库 ${target.databaseName} 不存在，且数据库自动创建已关闭`);
  }
  logger("warn", { ...logContext, 事件: "目标数据库不存在，开始自动创建" });

  const bootstrapConnection = createTemporaryConnection(databaseType, target.bootstrapUrl);
  try {
    if (databaseType === "postgres") {
      await bootstrapConnection.raw(`CREATE DATABASE "${target.databaseName}" ENCODING 'UTF8'`);
    } else {
      await bootstrapConnection.raw(
        `CREATE DATABASE IF NOT EXISTS \`${target.databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
      );
    }
    logger("info", { ...logContext, 事件: "目标数据库自动创建成功" });
  } catch (error) {
    if (databaseType === "postgres" && getDatabaseErrorCode(error) === "42P04") {
      logger("info", { ...logContext, 事件: "目标数据库已由其他实例创建" });
      return;
    }
    logger("warn", {
      ...logContext,
      事件: "目标数据库自动创建失败",
      错误码: getDatabaseErrorCode(error),
      错误信息: error instanceof Error ? error.message : "未知数据库错误",
    });
    const requiredPermission = databaseType === "postgres" ? "CREATEDB" : "CREATE";
    throw new Error(
      `无法自动创建数据库 ${target.databaseName}，请确认数据库账号拥有 ${requiredPermission} 权限`,
      { cause: error },
    );
  } finally {
    await bootstrapConnection.destroy();
  }
}

/** 将数据库用户行转换为公开用户结构。 */
function mapPublicUser(row: UserRow): PublicUserRecord {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}

/** 把数据库通知行转换为控制台公开结构。 */
function mapNotification(row: Record<string, unknown>): NotificationRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    category: String(row.category) as NotificationCategory,
    tone: String(row.tone) as NotificationTone,
    title: String(row.title),
    message: String(row.message),
    actionPath: row.action_path ? String(row.action_path) : null,
    createdAt: String(row.created_at),
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
  private readonly config: ApiConfig;
  private readonly bootstrapLogger: DatabaseBootstrapLogger;

  public constructor(config: ApiConfig, bootstrapLogger: DatabaseBootstrapLogger) {
    this.config = config;
    this.bootstrapLogger = bootstrapLogger;
    this.databaseType = config.databaseType;
    this.query = createConnection(config);
  }

  /** 建立连接、启用 SQLite 安全参数并执行迁移。 */
  public async initialize(): Promise<void> {
    if (this.databaseType === "sqlite") {
      await this.query.raw("PRAGMA journal_mode = WAL");
      await this.query.raw("PRAGMA foreign_keys = ON");
      await this.query.raw("PRAGMA busy_timeout = 5000");
    } else {
      await ensureRemoteDatabase(this.config, this.bootstrapLogger);
    }
    await migrateDatabase(this.query);
  }

  /** 关闭数据库连接池。 */
  public async close(): Promise<void> {
    await this.query.destroy();
  }

  /** 给指定用户写入一条通知；调用方不得在内容中放入账号密码或 Provider 凭据。 */
  public async createNotification(input: {
    userId: string;
    category: NotificationCategory;
    tone: NotificationTone;
    title: string;
    message: string;
    actionPath?: string | null;
  }): Promise<NotificationRecord> {
    const row = {
      id: randomUUID(),
      user_id: input.userId,
      category: input.category,
      tone: input.tone,
      title: input.title.slice(0, 255),
      message: input.message.slice(0, 2_000),
      action_path: input.actionPath?.slice(0, 500) ?? null,
      created_at: new Date().toISOString(),
    };
    await this.query("user_notifications").insert(row);
    return mapNotification(row);
  }

  /** 给全部启用中的超级管理员分别写入通知，确保每个管理员可以独立清除。 */
  public async createNotificationsForSuperAdmins(input: {
    category: NotificationCategory;
    tone: NotificationTone;
    title: string;
    message: string;
    actionPath?: string | null;
    excludeUserId?: string;
  }): Promise<number> {
    const administrators = await this.query("user_accounts")
      .select("id")
      .where({ role: "super_admin", status: "active" });
    const targetUserIds = administrators
      .map((row) => String(row.id))
      .filter((userId) => userId !== input.excludeUserId);
    if (targetUserIds.length === 0) return 0;
    const now = new Date().toISOString();
    await this.query("user_notifications").insert(targetUserIds.map((userId) => ({
      id: randomUUID(),
      user_id: userId,
      category: input.category,
      tone: input.tone,
      title: input.title.slice(0, 255),
      message: input.message.slice(0, 2_000),
      action_path: input.actionPath?.slice(0, 500) ?? null,
      created_at: now,
    })));
    return targetUserIds.length;
  }

  /** 尽力写入用户通知，数据库异常只记录日志，不影响原业务结果。 */
  public async createNotificationSafely(input: {
    userId: string;
    category: NotificationCategory;
    tone: NotificationTone;
    title: string;
    message: string;
    actionPath?: string | null;
  }): Promise<void> {
    try {
      await this.createNotification(input);
    } catch (error) {
      this.bootstrapLogger("warn", {
        日志关键字: "codex-flycloud-notification",
        事件: "用户通知写入失败",
        用户ID: input.userId,
        通知标题: input.title,
        错误信息: error instanceof Error ? error.message : "未知数据库错误",
      });
    }
  }

  /** 尽力给超级管理员广播通知，失败时不回滚账号、服务或后台任务主流程。 */
  public async createSuperAdminNotificationsSafely(input: {
    category: NotificationCategory;
    tone: NotificationTone;
    title: string;
    message: string;
    actionPath?: string | null;
    excludeUserId?: string;
  }): Promise<void> {
    try {
      await this.createNotificationsForSuperAdmins(input);
    } catch (error) {
      this.bootstrapLogger("warn", {
        日志关键字: "codex-flycloud-notification",
        事件: "管理员通知写入失败",
        通知标题: input.title,
        错误信息: error instanceof Error ? error.message : "未知数据库错误",
      });
    }
  }

  /** 按用户读取最近通知，禁止跨账号查看。 */
  public async listNotifications(userId: string, limit = 30): Promise<NotificationRecord[]> {
    const rows = await this.query("user_notifications")
      .where({ user_id: userId })
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(Math.min(100, Math.max(1, limit)));
    return rows.map((row) => mapNotification(row as Record<string, unknown>));
  }

  /** 清除当前用户的一条通知，返回是否真的删除。 */
  public async deleteNotification(userId: string, notificationId: string): Promise<boolean> {
    return Number(await this.query("user_notifications")
      .where({ id: notificationId, user_id: userId })
      .delete()) > 0;
  }

  /** 清除当前用户的全部通知，不影响其他账号。 */
  public async clearNotifications(userId: string): Promise<number> {
    return Number(await this.query("user_notifications").where({ user_id: userId }).delete());
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

  /** 原子创建首个超级管理员并写入初始化完成标记。 */
  public async initializeSuperAdmin(input: {
    userId: string;
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

  /** 创建普通用户或管理员指定角色用户。 */
  public async createUser(input: {
    userId: string;
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

  /**
   * 原子创建 APP 用户、密码和外部账号绑定。
   * 当前华为身份摘要只用于同一实例内防重复注册，不代表服务端已经完成华为官方凭证验签。
   */
  public async createAppUserWithExternalIdentity(input: {
    userId: string;
    username: string;
    usernameLookup: string;
    passwordHash: string;
    identityId: string;
    identityProvider: "huawei";
    identityHash: string;
  }): Promise<PublicUserRecord> {
    try {
      return await this.query.transaction(async (transaction) => {
        const state = await transaction("system_state").where({ singleton_id: 1 }).first();
        if (!state?.initial_setup_completed_at) {
          throw new ApiError(503, "setup_required", "实例尚未完成首次初始化");
        }

        const existingIdentity = await transaction("user_external_identities")
          .where({
            provider: input.identityProvider,
            identity_hash: input.identityHash,
          })
          .first();
        if (existingIdentity) {
          throw new ApiError(
            409,
            "huawei_account_already_bound",
            "当前华为账号已经注册过 Fly云助手账号，请登录已有账号",
          );
        }

        const now = new Date().toISOString();
        await this.insertUser(transaction, {
          userId: input.userId,
          username: input.username,
          usernameLookup: input.usernameLookup,
          passwordHash: input.passwordHash,
          role: "user",
          now,
        });
        await transaction("user_external_identities").insert({
          id: input.identityId,
          user_id: input.userId,
          provider: input.identityProvider,
          identity_hash: input.identityHash,
          created_at: now,
        });
        return this.findPublicUserById(input.userId, transaction);
      });
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }
      if (isUniqueConstraintError(error)) {
        const existingIdentity = await this.query("user_external_identities")
          .where({
            provider: input.identityProvider,
            identity_hash: input.identityHash,
          })
          .first();
        if (existingIdentity) {
          throw new ApiError(
            409,
            "huawei_account_already_bound",
            "当前华为账号已经注册过 Fly云助手账号，请登录已有账号",
          );
        }
        throw new ApiError(409, "username_conflict", "用户名已被使用");
      }
      throw error;
    }
  }

  /** 在事务中写入用户及密码。 */
  private async insertUser(
    transaction: Knex.Transaction,
    input: {
      userId: string;
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
  }

  /** 按用户 ID 查询公开用户。 */
  public async findPublicUserById(
    userId: string,
    transaction: Knex | Knex.Transaction = this.query,
  ): Promise<PublicUserRecord> {
    const row = (await transaction("user_accounts as u")
      .select(
        "u.id",
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
      .join("user_passwords as p", "p.user_id", "u.id")
      .select(
        "u.id",
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
      .select(
        "u.id",
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
    const base = this.query("user_accounts as u");
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
      const serviceCountRow = await this.query("cloud_services").where({ user_id: row.id }).whereNull("deleted_at").count<{ count: string | number }[]>({ count: "id" }).first();
      const mediaCountRow = await this.query("media_items as m")
        .join("cloud_services as s", "s.id", "m.service_id")
        .where("m.user_id", row.id)
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

  /** 校验待删除用户当前没有仍会写入其数据的后台任务。 */
  public async assertUserCanBePurged(userId: string): Promise<PublicUserRecord> {
    return this.query.transaction(async (transaction) => {
      return this.requireUserCanBePurged(userId, transaction);
    });
  }

  /**
   * 彻底删除待删除用户及其全部业务数据。
   * 文件目录由路由在调用本方法前清理，数据库数据在同一个事务中完成删除。
   */
  public async purgePendingUser(userId: string): Promise<void> {
    await this.query.transaction(async (transaction) => {
      await this.requireUserCanBePurged(userId, transaction);

      // 关键变量：先解除其他用户任务中的管理员请求人标识，避免保留已经删除的用户 ID。
      await transaction("scan_jobs")
        .where({ requested_by_user_id: userId })
        .whereNot({ user_id: userId })
        .update({ requested_by_user_id: transaction.ref("user_id") });
      await transaction("media_probe_jobs")
        .where({ requested_by_user_id: userId })
        .whereNot({ user_id: userId })
        .update({ requested_by_user_id: transaction.ref("user_id") });
      await transaction("system_secret_settings").where({ updated_by_user_id: userId }).update({ updated_by_user_id: null });
      await transaction("system_settings").where({ updated_by_user_id: userId }).update({ updated_by_user_id: null });
      await transaction("audit_log_entries").where({ operator_user_id: userId }).update({
        operator_user_id: null,
        operator_username: null,
      });
      await transaction("audit_log_entries").where({ target_type: "user", target_id: userId }).update({ target_id: null });

      const scanJobRows = await transaction("scan_jobs").select("id").where({ user_id: userId });
      const scanJobIds = scanJobRows.map((row) => String(row.id));
      if (scanJobIds.length > 0) {
        await transaction("scan_job_events").whereIn("job_id", scanJobIds).delete();
        await transaction("scan_job_checkpoints").whereIn("job_id", scanJobIds).delete();
        await transaction("scan_root_runs").whereIn("job_id", scanJobIds).delete();
      }

      const migrationRows = await transaction("service_migrations").select("id").where({ user_id: userId });
      const migrationIds = migrationRows.map((row) => String(row.id));
      if (migrationIds.length > 0) {
        await transaction("service_migration_chunks").whereIn("migration_id", migrationIds).delete();
      }

      const serviceRows = await transaction("cloud_services").select("id").where({ user_id: userId });
      const serviceIds = serviceRows.map((row) => String(row.id));
      if (serviceIds.length > 0) {
        await transaction("service_playback_progress").whereIn("service_id", serviceIds).delete();
        await transaction("service_playback_sessions").whereIn("service_id", serviceIds).delete();
        await transaction("service_playback_history").whereIn("service_id", serviceIds).delete();
        await transaction("service_protocol_sessions").whereIn("service_id", serviceIds).delete();
        await transaction("service_access_accounts").whereIn("service_id", serviceIds).delete();
      }

      await transaction("library_exports").where({ user_id: userId }).delete();
      await transaction("catalog_changes").where({ user_id: userId }).delete();
      await transaction("file_links").where({ user_id: userId }).delete();
      await transaction("media_relations").where({ user_id: userId }).delete();
      await transaction("media_file_probes").where({ user_id: userId }).delete();
      await transaction("media_probe_jobs").where({ user_id: userId }).delete();
      await transaction("scan_jobs").where({ user_id: userId }).delete();
      await transaction("service_migrations").where({ user_id: userId }).delete();
      await transaction("source_files").where({ user_id: userId }).delete();
      await transaction("media_items").where({ user_id: userId }).delete();
      await transaction("client_service_links").where({ user_id: userId }).delete();
      await transaction("service_metadata_profiles").where({ user_id: userId }).delete();
      await transaction("service_scan_profiles").where({ user_id: userId }).delete();
      await transaction("service_credentials").where({ user_id: userId }).delete();
      await transaction("media_libraries").where({ user_id: userId }).delete();
      await transaction("cloud_services").where({ user_id: userId }).delete();
      const deleted = await transaction("user_accounts").where({ id: userId }).delete();
      if (deleted !== 1) {
        throw new ApiError(404, "user_not_found", "用户不存在");
      }
    });
  }

  /** 在事务内锁定并校验一个可以被彻底删除的待删除用户。 */
  private async requireUserCanBePurged(
    userId: string,
    transaction: Knex | Knex.Transaction,
  ): Promise<PublicUserRecord> {
    let userQuery = transaction("user_accounts").where({ id: userId });
    if (this.databaseType !== "sqlite") userQuery = userQuery.forUpdate();
    const row = await userQuery.first();
    if (!row) {
      throw new ApiError(404, "user_not_found", "用户不存在");
    }
    const user = mapPublicUser(row as UserRow);
    if (user.status !== "pending_delete") {
      throw new ApiError(409, "user_not_pending_delete", "只有待删除用户可以彻底删除");
    }
    if (user.role === "super_admin") {
      const activeAdministrator = await transaction("user_accounts")
        .where({ role: "super_admin", status: "active" })
        .whereNot({ id: userId })
        .first();
      if (!activeAdministrator) {
        throw new ApiError(409, "last_super_admin", "不能删除最后一个有效超级管理员");
      }
    }

    const activeJobStatuses = ["queued", "running", "retry_waiting", "paused"];
    const [scanJob, mediaProbeJob, migration, libraryExport] = await Promise.all([
      transaction("scan_jobs").where({ user_id: userId }).whereIn("status", activeJobStatuses).first(),
      transaction("media_probe_jobs").where({ user_id: userId }).whereIn("status", activeJobStatuses).first(),
      transaction("service_migrations")
        .where({ user_id: userId })
        .whereIn("status", ["preparing", "uploading", "queued", "validating", "importing", "finalizing"])
        .first(),
      transaction("library_exports").where({ user_id: userId }).whereIn("status", ["queued", "running"]).first(),
    ]);
    if (scanJob || mediaProbeJob || migration || libraryExport) {
      throw new ApiError(409, "user_has_active_background_job", "该用户仍有未结束后台任务，请先终止后再彻底删除");
    }
    return user;
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
