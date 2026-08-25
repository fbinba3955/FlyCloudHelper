import type { ApiConfig } from "./config.js";
import type { FlyCloudHelperDatabase } from "./database.js";
import { validationError } from "./errors.js";

const publicBaseUrlSettingKey = "public_base_url";

/** 当前公开地址及其配置来源。 */
export interface PublicAccessStatus {
  publicBaseUrl: string | null;
  source: "environment" | "database" | "missing";
  editable: boolean;
}

/** 校验实例公开地址并统一移除末尾斜杠。 */
export function validatePublicBaseUrl(value: unknown, allowEmpty = false): string | null {
  if ((value === null || value === undefined || value === "") && allowEmpty) return null;
  if (typeof value !== "string" || value.length > 1000) throw validationError("publicBaseUrl", "公开访问地址格式无效");
  let url: URL;
  try { url = new URL(value); } catch { throw validationError("publicBaseUrl", "公开访问地址必须是完整 HTTP 或 HTTPS 地址"); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw validationError("publicBaseUrl", "公开访问地址只能使用 HTTP/HTTPS，且不能包含账号、查询参数或片段");
  }
  return url.href.replace(/\/+$/u, "");
}

/** 合并环境变量和数据库配置，环境变量始终优先。 */
export class PublicAccessService {
  public constructor(private readonly database: FlyCloudHelperDatabase, private readonly config: ApiConfig) {}

  /** 读取当前实际生效的公开地址。 */
  public async getStatus(): Promise<PublicAccessStatus> {
    if (this.config.publicBaseUrlOverride) return { publicBaseUrl: this.config.publicBaseUrlOverride, source: "environment", editable: false };
    const row = await this.database.query("system_settings").where({ setting_key: publicBaseUrlSettingKey }).first();
    return row
      ? { publicBaseUrl: String(row.setting_value), source: "database", editable: true }
      : { publicBaseUrl: null, source: "missing", editable: true };
  }

  /** 保存数据库公开地址；清空表示恢复未配置状态。 */
  public async save(value: unknown, updatedByUserId: string): Promise<PublicAccessStatus> {
    const publicBaseUrl = validatePublicBaseUrl(value, true);
    await this.database.query.transaction(async (transaction) => {
      const existing = await transaction("system_settings").where({ setting_key: publicBaseUrlSettingKey }).first();
      if (!publicBaseUrl) { if (existing) await transaction("system_settings").where({ setting_key: publicBaseUrlSettingKey }).delete(); return; }
      const now = new Date().toISOString();
      if (existing) await transaction("system_settings").where({ setting_key: publicBaseUrlSettingKey }).update({ setting_value: publicBaseUrl, revision: Number(existing.revision) + 1, updated_by_user_id: updatedByUserId, updated_at: now });
      else await transaction("system_settings").insert({ setting_key: publicBaseUrlSettingKey, setting_value: publicBaseUrl, revision: 1, updated_by_user_id: updatedByUserId, created_at: now, updated_at: now });
    });
    return this.getStatus();
  }

  /** 生成某个服务对外提供的 Jellyfin 根地址。 */
  public async buildJellyfinUrl(serviceId: string): Promise<string | null> {
    const status = await this.getStatus();
    return status.publicBaseUrl ? `${status.publicBaseUrl}/jellyfin/${encodeURIComponent(serviceId)}` : null;
  }
}
