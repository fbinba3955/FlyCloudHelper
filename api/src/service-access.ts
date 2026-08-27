import { randomBytes, randomUUID } from "node:crypto";
import type { FlyCloudHelperDatabase } from "./database.js";
import { createUsernameLookup, hashPassword, verifyPassword } from "./auth.js";
import { ApiError, validationError } from "./errors.js";

/** 服务访问账号的公开状态；密码哈希永不离开服务端。 */
export interface ServiceAccessAccountRecord {
  id: string;
  serviceId: string;
  username: string;
  hasPassword: boolean;
  credentialRevision: number;
  status: "active" | "disabled";
  createdAt: string;
  updatedAt: string;
}

/** 创建服务或重置密码时返回给用户的访问凭据；免密码账号的 password 为空。 */
export interface GeneratedServiceAccessCredentials {
  account: ServiceAccessAccountRecord;
  password: string;
}

/** 校验服务级协议用户名，不对用户输入做额外归一化。 */
export function validateServiceAccessUsername(value: unknown): string {
  if (typeof value !== "string" || [...value].length < 4 || [...value].length > 255 || value.trim() !== value) {
    throw validationError("username", "服务访问用户名需为 4 至 255 个字符，且不能包含首尾空白");
  }
  return value;
}

/** 校验服务级协议密码；允许任意长度，空字符串表示 Jellyfin 与后续 Emby 均无需密码。 */
export function validateServiceAccessPassword(value: unknown): string {
  if (typeof value !== "string") {
    throw validationError("password", "服务访问密码必须是字符串");
  }
  return value;
}

/** 生成不含易混淆字符的 20 位随机初始密码。 */
export function generateServiceAccessPassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%";
  const bytes = randomBytes(20);
  return [...bytes].map((value) => alphabet[value % alphabet.length]).join("");
}

/** 服务访问账号和协议会话的集中数据服务。 */
export class ServiceAccessService {
  public constructor(private readonly database: FlyCloudHelperDatabase) {}

  /** 为升级前已经存在的服务补齐默认免密码账号。 */
  public async ensureExistingServices(): Promise<number> {
    const services = await this.database.query("cloud_services as s")
      .leftJoin("service_access_accounts as a", "a.service_id", "s.id")
      .select("s.id").whereNull("s.deleted_at").whereNull("a.id");
    for (const service of services) await this.createForService(String(service.id));
    return services.length;
  }

  /** 为新服务创建稳定的默认免密码账号。 */
  public async createForService(serviceId: string, transaction = this.database.query): Promise<GeneratedServiceAccessCredentials> {
    const password = ""; // 关键变量：新服务默认允许 Jellyfin 免密码登录，用户仍可在详情页主动设置密码。
    const username = `flymby_${serviceId.replaceAll("-", "").slice(0, 8)}`;
    const accountId = randomUUID();
    const now = new Date().toISOString();
    await transaction("service_access_accounts").insert({
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
      account: { id: accountId, serviceId, username, hasPassword: false, credentialRevision: 1, status: "active", createdAt: now, updatedAt: now },
      password,
    };
  }

  /** 按创建时间读取一个服务的全部协议账号，历史账号始终排在第一位。 */
  public async listByService(serviceId: string): Promise<ServiceAccessAccountRecord[]> {
    const rows = await this.database.query("service_access_accounts")
      .where({ service_id: serviceId })
      .orderBy("created_at", "asc")
      .orderBy("id", "asc");
    return rows.map((row) => this.mapAccount(row));
  }

  /** 读取服务账号公开状态。 */
  public async getByService(serviceId: string): Promise<ServiceAccessAccountRecord> {
    const row = await this.database.query("service_access_accounts")
      .where({ service_id: serviceId })
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .first();
    if (!row) throw new ApiError(404, "service_access_account_not_found", "服务访问账号不存在");
    return this.mapAccount(row);
  }

  /** 为同一 Jellyfin 地址创建新的独立登录账号。 */
  public async createAccount(serviceId: string, input: { username: unknown; password?: unknown }): Promise<ServiceAccessAccountRecord> {
    const username = validateServiceAccessUsername(input.username);
    const password = input.password === undefined ? "" : validateServiceAccessPassword(input.password);
    const accountId = randomUUID();
    const now = new Date().toISOString();
    try {
      await this.database.query("service_access_accounts").insert({
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

  /** 读取服务下的指定协议账号，避免账号 ID 越过媒体库边界。 */
  public async getById(serviceId: string, accountId: string): Promise<ServiceAccessAccountRecord> {
    const row = await this.database.query("service_access_accounts").where({ id: accountId, service_id: serviceId }).first();
    if (!row) throw new ApiError(404, "service_access_account_not_found", "Jellyfin 账号不存在");
    return this.mapAccount(row);
  }

  /** 验证当前服务的协议登录账号密码。 */
  public async authenticate(serviceId: string, username: unknown, password: unknown): Promise<ServiceAccessAccountRecord> {
    let validatedUsername: string;
    try {
      validatedUsername = validateServiceAccessUsername(username);
    } catch {
      throw new ApiError(401, "service_login_failed", "用户名或密码错误");
    }
    const row = await this.database.query("service_access_accounts")
      .where({ service_id: serviceId, username_lookup: createUsernameLookup(validatedUsername), status: "active" })
      .first();
    const passwordRequired = Number(row?.password_required ?? 1) !== 0; // 关键变量：历史账号在字段缺失时仍按需要密码处理。
    const passwordMatched = !passwordRequired || (typeof password === "string"
      && await verifyPassword(String(row?.password_hash ?? ""), password));
    if (!row || !passwordMatched) {
      throw new ApiError(401, "service_login_failed", "用户名或密码错误");
    }
    return this.mapAccount(row);
  }

  /** 修改用户名或密码，并让所有协议的旧会话立即失效。 */
  public async updateCredentials(serviceId: string, accountId: string, input: { username?: unknown; password?: unknown }): Promise<ServiceAccessAccountRecord> {
    return this.database.query.transaction(async (transaction) => {
      const row = await transaction("service_access_accounts").where({ id: accountId, service_id: serviceId }).first();
      if (!row) throw new ApiError(404, "service_access_account_not_found", "服务访问账号不存在");
      const patch: Record<string, unknown> = { credential_revision: Number(row.credential_revision) + 1, updated_at: new Date().toISOString() };
      if (input.username !== undefined) {
        patch.username = validateServiceAccessUsername(input.username);
        patch.username_lookup = createUsernameLookup(String(patch.username));
      }
      if (input.password !== undefined) {
        const password = validateServiceAccessPassword(input.password);
        patch.password_hash = await hashPassword(password);
        patch.password_required = password.length > 0 ? 1 : 0;
      }
      if (input.username === undefined && input.password === undefined) {
        throw validationError("credentials", "至少需要修改用户名或密码中的一项");
      }
      try {
        await transaction("service_access_accounts").where({ id: row.id }).update(patch);
      } catch (error) {
        this.throwUsernameConflict(error);
      }
      await transaction("service_protocol_sessions").where({ account_id: row.id }).whereNull("revoked_at").update({ revoked_at: String(patch.updated_at) });
      return this.mapAccount({ ...row, ...patch });
    });
  }

  /** 重置随机密码，明文只在本次响应中返回。 */
  public async resetPassword(serviceId: string, accountId: string): Promise<GeneratedServiceAccessCredentials> {
    const password = generateServiceAccessPassword();
    const account = await this.updateCredentials(serviceId, accountId, { password });
    return { account, password };
  }

  /** 启用或停用指定账号；停用时撤销该账号全部协议会话。 */
  public async updateStatus(serviceId: string, accountId: string, status: unknown): Promise<ServiceAccessAccountRecord> {
    if (status !== "active" && status !== "disabled") {
      throw validationError("status", "Jellyfin 账号状态不正确");
    }
    const account = await this.getById(serviceId, accountId);
    if (account.status === status) return account;
    if (status === "disabled") {
      const activeCountRow = await this.database.query("service_access_accounts")
        .where({ service_id: serviceId, status: "active" })
        .count<{ count: string | number }[]>({ count: "id" })
        .first();
      if (Number(activeCountRow?.count ?? 0) <= 1) {
        throw new ApiError(409, "last_active_service_access_account", "至少需要保留一个启用的 Jellyfin 账号");
      }
    }
    const now = new Date().toISOString();
    await this.database.query.transaction(async (transaction) => {
      await transaction("service_access_accounts").where({ id: accountId, service_id: serviceId }).update({ status, updated_at: now });
      if (status === "disabled") {
        await transaction("service_protocol_sessions").where({ account_id: accountId }).whereNull("revoked_at").update({ revoked_at: now });
      }
    });
    return this.getById(serviceId, accountId);
  }

  /** 删除指定账号及其独立会话和观看记录，但始终保留至少一个账号。 */
  public async deleteAccount(serviceId: string, accountId: string): Promise<void> {
    await this.getById(serviceId, accountId);
    const countRow = await this.database.query("service_access_accounts")
      .where({ service_id: serviceId })
      .count<{ count: string | number }[]>({ count: "id" })
      .first();
    if (Number(countRow?.count ?? 0) <= 1) {
      throw new ApiError(409, "last_service_access_account", "至少需要保留一个 Jellyfin 账号");
    }
    const deleted = await this.database.query("service_access_accounts").where({ id: accountId, service_id: serviceId }).delete();
    if (deleted !== 1) throw new ApiError(404, "service_access_account_not_found", "Jellyfin 账号不存在");
  }

  /** 撤销当前服务的指定协议会话，不删除播放记录。 */
  public async revokeSessions(serviceId: string, protocol?: "jellyfin" | "emby", accountId?: string): Promise<number> {
    const now = new Date().toISOString();
    const query = this.database.query("service_protocol_sessions").where({ service_id: serviceId }).whereNull("revoked_at");
    if (protocol) query.where({ protocol });
    if (accountId) query.where({ account_id: accountId });
    return query.update({ revoked_at: now });
  }

  /** 将数据库唯一约束错误转换成稳定的同媒体库用户名冲突提示。 */
  private throwUsernameConflict(error: unknown): never {
    const databaseError = error as Error & { code?: string };
    const duplicate = databaseError.code === "23505"
      || databaseError.code === "ER_DUP_ENTRY"
      || /unique|duplicate/iu.test(databaseError.message);
    if (duplicate) throw new ApiError(409, "service_access_username_conflict", "当前媒体库已经存在相同用户名");
    throw error;
  }

  /** 将数据库行转换为公开账号状态。 */
  private mapAccount(row: Record<string, unknown>): ServiceAccessAccountRecord {
    return {
      id: String(row.id), serviceId: String(row.service_id), username: String(row.username),
      hasPassword: Number(row.password_required ?? 1) !== 0,
      credentialRevision: Number(row.credential_revision), status: String(row.status) as "active" | "disabled",
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    };
  }
}
