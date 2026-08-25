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

/** 创建服务时一次性返回给用户的初始凭据。 */
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

  /** 为升级前已经存在的服务补齐账号；初始随机密码不可读取，用户可在详情页重置。 */
  public async ensureExistingServices(): Promise<number> {
    const services = await this.database.query("cloud_services as s")
      .leftJoin("service_access_accounts as a", "a.service_id", "s.id")
      .select("s.id").whereNull("s.deleted_at").whereNull("a.id");
    for (const service of services) await this.createForService(String(service.id));
    return services.length;
  }

  /** 为新服务创建稳定账号，并返回仅本次可见的明文密码。 */
  public async createForService(serviceId: string, transaction = this.database.query): Promise<GeneratedServiceAccessCredentials> {
    const password = generateServiceAccessPassword();
    const username = `flymby_${serviceId.replaceAll("-", "").slice(0, 8)}`;
    const accountId = randomUUID();
    const now = new Date().toISOString();
    await transaction("service_access_accounts").insert({
      id: accountId,
      service_id: serviceId,
      username,
      username_lookup: createUsernameLookup(username),
      password_hash: await hashPassword(password),
      password_required: 1,
      credential_revision: 1,
      status: "active",
      created_at: now,
      updated_at: now,
    });
    return {
      account: { id: accountId, serviceId, username, hasPassword: true, credentialRevision: 1, status: "active", createdAt: now, updatedAt: now },
      password,
    };
  }

  /** 读取服务账号公开状态。 */
  public async getByService(serviceId: string): Promise<ServiceAccessAccountRecord> {
    const row = await this.database.query("service_access_accounts").where({ service_id: serviceId }).first();
    if (!row) throw new ApiError(404, "service_access_account_not_found", "服务访问账号不存在");
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
  public async updateCredentials(serviceId: string, input: { username?: unknown; password?: unknown }): Promise<ServiceAccessAccountRecord> {
    return this.database.query.transaction(async (transaction) => {
      const row = await transaction("service_access_accounts").where({ service_id: serviceId }).first();
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
      await transaction("service_access_accounts").where({ id: row.id }).update(patch);
      await transaction("service_protocol_sessions").where({ account_id: row.id }).whereNull("revoked_at").update({ revoked_at: String(patch.updated_at) });
      return this.mapAccount({ ...row, ...patch });
    });
  }

  /** 重置随机密码，明文只在本次响应中返回。 */
  public async resetPassword(serviceId: string): Promise<GeneratedServiceAccessCredentials> {
    const password = generateServiceAccessPassword();
    const account = await this.updateCredentials(serviceId, { password });
    return { account, password };
  }

  /** 撤销当前服务的指定协议会话，不删除播放记录。 */
  public async revokeSessions(serviceId: string, protocol?: "jellyfin" | "emby"): Promise<number> {
    const now = new Date().toISOString();
    const query = this.database.query("service_protocol_sessions").where({ service_id: serviceId }).whereNull("revoked_at");
    if (protocol) query.where({ protocol });
    return query.update({ revoked_at: now });
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
