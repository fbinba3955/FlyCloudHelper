import { randomUUID } from "node:crypto";
import type { FlyCloudHelperDatabase } from "./database.js";
import { createUsernameLookup, hashPassword, verifyPassword } from "./auth.js";
import { ApiError, validationError } from "./errors.js";
import {
  generateServiceAccessPassword,
  validateServiceAccessPassword,
  validateServiceAccessUsername,
} from "./service-access.js";

/** Emby 协议账号的公开状态；密码哈希和会话令牌不会离开服务端。 */
export interface EmbyAccessAccountRecord {
  id: string;
  serviceId: string;
  username: string;
  hasPassword: boolean;
  credentialRevision: number;
  status: "active" | "disabled";
  createdAt: string;
  updatedAt: string;
}

/** 创建或重置 Emby 协议账号时仅本次返回的明文密码。 */
export interface GeneratedEmbyAccessCredentials {
  account: EmbyAccessAccountRecord;
  password: string;
}

/**
 * 管理独立 Emby 协议账号和会话。
 *
 * Emby 绝不读取 service_access_accounts 或 service_protocol_sessions，避免与 Jellyfin 登录状态交叉。
 */
export class EmbyAccessService {
  public constructor(private readonly database: FlyCloudHelperDatabase) {}

  /** 为历史服务补齐一个默认 Emby 免密码账号。 */
  public async ensureExistingServices(): Promise<number> {
    const services = await this.database.query("cloud_services as s")
      .leftJoin("service_emby_accounts as a", "a.service_id", "s.id")
      .select("s.id")
      .whereNull("s.deleted_at")
      .whereNull("a.id");
    for (const service of services) await this.createForService(String(service.id));
    return services.length;
  }

  /** 确保媒体库至少存在一个 Emby 默认账号，重复调用不会新增账号。 */
  public async ensureForService(serviceId: string): Promise<EmbyAccessAccountRecord> {
    const existing = await this.database.query("service_emby_accounts")
      .where({ service_id: serviceId })
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .first();
    if (existing) return this.mapAccount(existing);
    try {
      return (await this.createForService(serviceId)).account;
    } catch (error) {
      // 关键变量：并发启用同一协议时，唯一用户名约束产生后重新读取已经创建的默认账号。
      const createdByAnotherRequest = await this.database.query("service_emby_accounts")
        .where({ service_id: serviceId })
        .orderBy("created_at", "asc")
        .orderBy("id", "asc")
        .first();
      if (createdByAnotherRequest) return this.mapAccount(createdByAnotherRequest);
      throw error;
    }
  }

  /** 为一个媒体库创建稳定的默认免密码 Emby 账号。 */
  public async createForService(
    serviceId: string,
    transaction = this.database.query,
  ): Promise<GeneratedEmbyAccessCredentials> {
    const password = ""; // 关键变量：默认账号保持免密码，管理员可随后在媒体库工具页设置密码。
    const username = `emby_${serviceId.replaceAll("-", "").slice(0, 8)}`;
    const accountId = randomUUID();
    const now = new Date().toISOString();
    await transaction("service_emby_accounts").insert({
      id: accountId,
      service_id: serviceId,
      username,
      username_lookup: createUsernameLookup(username),
      password_hash: await hashPassword(password),
      password_required: 0,
      credential_revision: 1,
      status: "active",
      created_at: now,
      updated_at: now,
    });
    return {
      account: {
        id: accountId, serviceId, username, hasPassword: false, credentialRevision: 1,
        status: "active", createdAt: now, updatedAt: now,
      },
      password,
    };
  }

  /** 按创建时间读取媒体库下的全部独立 Emby 账号。 */
  public async listByService(serviceId: string): Promise<EmbyAccessAccountRecord[]> {
    const rows = await this.database.query("service_emby_accounts")
      .where({ service_id: serviceId })
      .orderBy("created_at", "asc")
      .orderBy("id", "asc");
    return rows.map((row) => this.mapAccount(row));
  }

  /** 获取媒体库的默认 Emby 账号。 */
  public async getByService(serviceId: string): Promise<EmbyAccessAccountRecord> {
    const row = await this.database.query("service_emby_accounts")
      .where({ service_id: serviceId })
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .first();
    if (!row) throw new ApiError(404, "emby_access_account_not_found", "Emby 账号不存在");
    return this.mapAccount(row);
  }

  /** 在同一个 Emby 服务地址下创建一个新的独立登录账号。 */
  public async createAccount(
    serviceId: string,
    input: { username: unknown; password?: unknown },
  ): Promise<EmbyAccessAccountRecord> {
    const username = validateServiceAccessUsername(input.username);
    const password = input.password === undefined ? "" : validateServiceAccessPassword(input.password);
    const accountId = randomUUID();
    const now = new Date().toISOString();
    try {
      await this.database.query("service_emby_accounts").insert({
        id: accountId,
        service_id: serviceId,
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
    return this.getById(serviceId, accountId);
  }

  /** 读取同一媒体库内的指定 Emby 账号，避免账号 ID 跨服务访问。 */
  public async getById(serviceId: string, accountId: string): Promise<EmbyAccessAccountRecord> {
    const row = await this.database.query("service_emby_accounts")
      .where({ id: accountId, service_id: serviceId })
      .first();
    if (!row) throw new ApiError(404, "emby_access_account_not_found", "Emby 账号不存在");
    return this.mapAccount(row);
  }

  /** 验证 Emby AuthenticateByName 使用的账号与密码。 */
  public async authenticate(serviceId: string, username: unknown, password: unknown): Promise<EmbyAccessAccountRecord> {
    let validatedUsername: string;
    try {
      validatedUsername = validateServiceAccessUsername(username);
    } catch {
      throw new ApiError(401, "emby_login_failed", "用户名或密码错误");
    }
    const row = await this.database.query("service_emby_accounts")
      .where({ service_id: serviceId, username_lookup: createUsernameLookup(validatedUsername), status: "active" })
      .first();
    const passwordRequired = Number(row?.password_required ?? 1) !== 0;
    const passwordMatched = !passwordRequired || (typeof password === "string"
      && await verifyPassword(String(row?.password_hash ?? ""), password));
    if (!row || !passwordMatched) {
      throw new ApiError(401, "emby_login_failed", "用户名或密码错误");
    }
    return this.mapAccount(row);
  }

  /** 修改 Emby 用户名或密码，并撤销该账号的全部旧 Emby 会话。 */
  public async updateCredentials(
    serviceId: string,
    accountId: string,
    input: { username?: unknown; password?: unknown },
  ): Promise<EmbyAccessAccountRecord> {
    return this.database.query.transaction(async (transaction) => {
      const row = await transaction("service_emby_accounts").where({ id: accountId, service_id: serviceId }).first();
      if (!row) throw new ApiError(404, "emby_access_account_not_found", "Emby 账号不存在");
      if (input.username === undefined && input.password === undefined) {
        throw validationError("credentials", "至少需要修改用户名或密码中的一项");
      }
      const now = new Date().toISOString();
      const patch: Record<string, unknown> = {
        credential_revision: Number(row.credential_revision) + 1,
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
      try {
        await transaction("service_emby_accounts").where({ id: accountId }).update(patch);
      } catch (error) {
        this.throwUsernameConflict(error);
      }
      await transaction("service_emby_sessions").where({ account_id: accountId }).whereNull("revoked_at").update({ revoked_at: now });
      return this.mapAccount({ ...row, ...patch });
    });
  }

  /** 生成随机 Emby 密码，明文只在当前调用结果中返回。 */
  public async resetPassword(serviceId: string, accountId: string): Promise<GeneratedEmbyAccessCredentials> {
    const password = generateServiceAccessPassword();
    const account = await this.updateCredentials(serviceId, accountId, { password });
    return { account, password };
  }

  /** 启用或停用 Emby 账号；停用账号时同时撤销其会话。 */
  public async updateStatus(serviceId: string, accountId: string, status: unknown): Promise<EmbyAccessAccountRecord> {
    if (status !== "active" && status !== "disabled") {
      throw validationError("status", "Emby 账号状态不正确");
    }
    const account = await this.getById(serviceId, accountId);
    if (account.status === status) return account;
    if (status === "disabled") {
      const activeCountRow = await this.database.query("service_emby_accounts")
        .where({ service_id: serviceId, status: "active" })
        .count<{ count: string | number }[]>({ count: "id" })
        .first();
      if (Number(activeCountRow?.count ?? 0) <= 1) {
        throw new ApiError(409, "last_active_emby_access_account", "至少需要保留一个启用的 Emby 账号");
      }
    }
    const now = new Date().toISOString();
    await this.database.query.transaction(async (transaction) => {
      await transaction("service_emby_accounts").where({ id: accountId, service_id: serviceId }).update({ status, updated_at: now });
      if (status === "disabled") {
        await transaction("service_emby_sessions").where({ account_id: accountId }).whereNull("revoked_at").update({ revoked_at: now });
      }
    });
    return this.getById(serviceId, accountId);
  }

  /** 删除一个 Emby 账号及其独立的会话、观看记录和收藏状态。 */
  public async deleteAccount(serviceId: string, accountId: string): Promise<void> {
    await this.getById(serviceId, accountId);
    const countRow = await this.database.query("service_emby_accounts")
      .where({ service_id: serviceId })
      .count<{ count: string | number }[]>({ count: "id" })
      .first();
    if (Number(countRow?.count ?? 0) <= 1) {
      throw new ApiError(409, "last_emby_access_account", "至少需要保留一个 Emby 账号");
    }
    const deleted = await this.database.query("service_emby_accounts").where({ id: accountId, service_id: serviceId }).delete();
    if (deleted !== 1) throw new ApiError(404, "emby_access_account_not_found", "Emby 账号不存在");
  }

  /** 撤销媒体库内全部或指定账号的 Emby 会话，不影响 Jellyfin 会话。 */
  public async revokeSessions(serviceId: string, accountId?: string): Promise<number> {
    const query = this.database.query("service_emby_sessions")
      .where({ service_id: serviceId })
      .whereNull("revoked_at");
    if (accountId) query.where({ account_id: accountId });
    return query.update({ revoked_at: new Date().toISOString() });
  }

  /** 把数据库唯一键错误转换为面向 Emby 的稳定接口错误。 */
  private throwUsernameConflict(error: unknown): never {
    const databaseError = error as Error & { code?: string };
    const duplicate = databaseError.code === "23505"
      || databaseError.code === "ER_DUP_ENTRY"
      || /unique|duplicate/iu.test(databaseError.message);
    if (duplicate) throw new ApiError(409, "emby_access_username_conflict", "当前媒体库已经存在相同 Emby 用户名");
    throw error;
  }

  /** 将数据库行映射成不会泄露密码字段的 Emby 账号对象。 */
  private mapAccount(row: Record<string, unknown>): EmbyAccessAccountRecord {
    return {
      id: String(row.id),
      serviceId: String(row.service_id),
      username: String(row.username),
      hasPassword: Number(row.password_required ?? 1) !== 0,
      credentialRevision: Number(row.credential_revision),
      status: String(row.status) as "active" | "disabled",
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }
}
