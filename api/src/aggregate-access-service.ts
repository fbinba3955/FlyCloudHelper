import { randomUUID } from "node:crypto";
import { createUsernameLookup, hashPassword, verifyPassword } from "./auth.js";
import type { FlyCloudHelperDatabase } from "./database.js";
import { ApiError, validationError } from "./errors.js";
import { validateServiceAccessPassword, validateServiceAccessUsername } from "./service-access.js";

/** 聚合 Jellyfin 或 Emby 地址下的一个独立访问账号。 */
export interface AggregateAccessAccountRecord {
  id: string;
  aggregateServiceId: string;
  username: string;
  hasPassword: boolean;
  credentialRevision: number;
  status: "active" | "disabled";
  createdAt: string;
  updatedAt: string;
}

/** 管理同一个聚合协议地址下相互独立的多个访问账号。 */
export class AggregateAccessService {
  public constructor(private readonly database: FlyCloudHelperDatabase) {}

  /** 为历史和新建聚合服务补齐一个稳定的免密码初始账号。 */
  public async ensureExistingServices(): Promise<number> {
    const services = await this.database.query("aggregate_services as s")
      .leftJoin("aggregate_access_accounts as a", "a.aggregate_service_id", "s.id")
      .select("s.id", "s.user_id")
      .whereNull("s.deleted_at")
      .whereNull("a.id");
    for (const service of services) {
      await this.createInitialAccount(String(service.id), String(service.user_id));
    }
    return services.length;
  }

  /** 为指定聚合服务建立首个免密码账号。 */
  public async createInitialAccount(aggregateServiceId: string, userId: string): Promise<AggregateAccessAccountRecord> {
    const username = `flymby_${aggregateServiceId.replaceAll("-", "").slice(0, 8)}`;
    return this.insertAccount(aggregateServiceId, userId, username, "");
  }

  /** 读取聚合服务的全部账号，初始账号固定排在第一位。 */
  public async list(aggregateServiceId: string, userId: string): Promise<AggregateAccessAccountRecord[]> {
    await this.requireOwnedService(aggregateServiceId, userId);
    const rows = await this.database.query("aggregate_access_accounts")
      .where({ aggregate_service_id: aggregateServiceId, user_id: userId })
      .orderBy("created_at", "asc")
      .orderBy("id", "asc");
    return rows.map((row) => this.mapAccount(row));
  }

  /** 创建额外访问账号；空密码表示免密码登录。 */
  public async create(
    aggregateServiceId: string,
    userId: string,
    input: { username: unknown; password?: unknown },
  ): Promise<AggregateAccessAccountRecord> {
    await this.requireOwnedService(aggregateServiceId, userId);
    const username = validateServiceAccessUsername(input.username);
    const password = input.password === undefined ? "" : validateServiceAccessPassword(input.password);
    return this.insertAccount(aggregateServiceId, userId, username, password);
  }

  /** 验证聚合 Jellyfin 登录使用的用户名和密码。 */
  public async authenticate(
    aggregateServiceId: string,
    usernameInput: unknown,
    passwordInput: unknown,
  ): Promise<AggregateAccessAccountRecord> {
    let username: string;
    try {
      username = validateServiceAccessUsername(usernameInput);
    } catch {
      throw new ApiError(401, "aggregate_jellyfin_login_failed", "用户名或密码错误");
    }
    const row = await this.database.query("aggregate_access_accounts")
      .where({
        aggregate_service_id: aggregateServiceId,
        username_lookup: createUsernameLookup(username),
        status: "active",
      })
      .first();
    const passwordRequired = Number(row?.password_required ?? 1) !== 0;
    const passwordMatched = !passwordRequired || (typeof passwordInput === "string"
      && await verifyPassword(String(row?.password_hash ?? ""), passwordInput));
    if (!row || !passwordMatched) {
      throw new ApiError(401, "aggregate_jellyfin_login_failed", "用户名或密码错误");
    }
    return this.mapAccount(row);
  }

  /** 修改账号名称、密码或启用状态，并撤销它现有的全部协议会话。 */
  public async update(
    aggregateServiceId: string,
    accountId: string,
    userId: string,
    input: { username?: unknown; password?: unknown; status?: unknown },
  ): Promise<AggregateAccessAccountRecord> {
    await this.requireOwnedService(aggregateServiceId, userId);
    const row = await this.database.query("aggregate_access_accounts")
      .where({ id: accountId, aggregate_service_id: aggregateServiceId, user_id: userId })
      .first();
    if (!row) throw new ApiError(404, "aggregate_access_account_not_found", "聚合服务访问账号不存在");
    if (input.username === undefined && input.password === undefined && input.status === undefined) {
      throw validationError("account", "至少需要修改账号的一项配置");
    }
    if (input.status !== undefined && input.status !== "active" && input.status !== "disabled") {
      throw validationError("status", "账号状态不正确");
    }
    if (input.status === "disabled" && String(row.status) === "active") {
      const activeCount = await this.countAccounts(aggregateServiceId, "active");
      if (activeCount <= 1) throw new ApiError(409, "last_active_aggregate_account", "至少需要保留一个启用的访问账号");
    }

    const now = new Date().toISOString();
    const patch: Record<string, unknown> = {
      credential_revision: Number(row.credential_revision ?? 1) + 1,
      updated_at: now,
    };
    if (input.username !== undefined) {
      const username = validateServiceAccessUsername(input.username);
      patch.username = username;
      patch.username_lookup = createUsernameLookup(username);
    }
    if (input.password !== undefined) {
      const password = validateServiceAccessPassword(input.password);
      patch.password_hash = await hashPassword(password);
      patch.password_required = password.length > 0 ? 1 : 0;
    }
    if (input.status !== undefined) patch.status = input.status;

    try {
      await this.database.query.transaction(async (transaction) => {
        await transaction("aggregate_access_accounts").where({ id: accountId }).update(patch);
        await transaction("aggregate_protocol_sessions")
          .where({ account_id: accountId })
          .whereNull("revoked_at")
          .update({ revoked_at: now });
      });
    } catch (error) {
      this.throwUsernameConflict(error);
    }
    return this.getById(aggregateServiceId, accountId, userId);
  }

  /** 删除一个额外账号；聚合服务始终至少保留一个账号。 */
  public async delete(aggregateServiceId: string, accountId: string, userId: string): Promise<void> {
    await this.requireOwnedService(aggregateServiceId, userId);
    const accountCount = await this.countAccounts(aggregateServiceId);
    if (accountCount <= 1) throw new ApiError(409, "last_aggregate_access_account", "至少需要保留一个访问账号");
    const deleted = await this.database.query("aggregate_access_accounts")
      .where({ id: accountId, aggregate_service_id: aggregateServiceId, user_id: userId })
      .delete();
    if (deleted !== 1) throw new ApiError(404, "aggregate_access_account_not_found", "聚合服务访问账号不存在");
  }

  /** 写入聚合访问账号，并转换跨数据库的用户名冲突错误。 */
  private async insertAccount(
    aggregateServiceId: string,
    userId: string,
    username: string,
    password: string,
  ): Promise<AggregateAccessAccountRecord> {
    const id = randomUUID();
    const now = new Date().toISOString();
    try {
      await this.database.query("aggregate_access_accounts").insert({
        id,
        aggregate_service_id: aggregateServiceId,
        user_id: userId,
        username,
        username_lookup: createUsernameLookup(username),
        password_hash: await hashPassword(password),
        password_required: password.length > 0 ? 1 : 0,
        credential_revision: 1,
        status: "active",
        created_at: now,
        updated_at: now,
      });
    } catch (error) {
      this.throwUsernameConflict(error);
    }
    return this.getById(aggregateServiceId, id, userId);
  }

  /** 读取并验证账号归属。 */
  private async getById(aggregateServiceId: string, accountId: string, userId: string): Promise<AggregateAccessAccountRecord> {
    const row = await this.database.query("aggregate_access_accounts")
      .where({ id: accountId, aggregate_service_id: aggregateServiceId, user_id: userId })
      .first();
    if (!row) throw new ApiError(404, "aggregate_access_account_not_found", "聚合服务访问账号不存在");
    return this.mapAccount(row);
  }

  /** 校验聚合服务属于当前登录用户。 */
  private async requireOwnedService(aggregateServiceId: string, userId: string): Promise<void> {
    const row = await this.database.query("aggregate_services")
      .select("id")
      .where({ id: aggregateServiceId, user_id: userId })
      .whereNull("deleted_at")
      .first();
    if (!row) throw new ApiError(404, "aggregate_service_not_found", "聚合服务不存在");
  }

  /** 统计指定聚合服务的全部或启用账号数量。 */
  private async countAccounts(aggregateServiceId: string, status?: "active"): Promise<number> {
    const query = this.database.query("aggregate_access_accounts").where({ aggregate_service_id: aggregateServiceId });
    if (status) query.where({ status });
    const row = await query.count<{ count: string | number }[]>({ count: "id" }).first();
    return Number(row?.count ?? 0);
  }

  /** 将数据库账号行映射为不包含密码摘要的公开结构。 */
  private mapAccount(row: Record<string, unknown>): AggregateAccessAccountRecord {
    return {
      id: String(row.id),
      aggregateServiceId: String(row.aggregate_service_id),
      username: String(row.username),
      hasPassword: Number(row.password_required ?? 0) !== 0,
      credentialRevision: Number(row.credential_revision ?? 1),
      status: String(row.status) as "active" | "disabled",
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  /** 把唯一约束错误转换成稳定的重复用户名提示。 */
  private throwUsernameConflict(error: unknown): never {
    const databaseError = error as Error & { code?: string };
    const duplicate = databaseError.code === "23505"
      || databaseError.code === "ER_DUP_ENTRY"
      || /unique|duplicate/iu.test(databaseError.message);
    if (duplicate) throw new ApiError(409, "aggregate_access_username_conflict", "当前聚合服务已经存在相同用户名");
    throw error;
  }
}
