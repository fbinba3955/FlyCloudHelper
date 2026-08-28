import type { FlyCloudHelperDatabase } from "./database.js";
import { ApiError, validationError } from "./errors.js";
import type { CredentialVault } from "./secrets.js";

/** 系统级 TMDB Key 配置在数据库中的稳定标识。 */
export const tmdbKeySettingName = "tmdb_api_keys";

/** TMDB API 与图片代理地址在普通系统配置表中的稳定标识。 */
export const tmdbBaseUrlSettingName = "tmdb_base_urls";

/** 云助手与 Flymby APP 对齐后的 TMDB API 默认地址。 */
export const tmdbDefaultApiBaseUrl = "https://api.tmdb.org/3";

/** TMDB 图片默认地址。 */
export const tmdbDefaultImageBaseUrl = "https://image.tmdb.org/t/p";

export interface TmdbBaseUrlSettings {
  /** 当前实际使用的 TMDB API 基础地址。 */
  apiBaseUrl: string;
  /** 当前实际使用的 TMDB 图片基础地址。 */
  imageBaseUrl: string;
  /** 数据库配置修订；0 表示使用默认地址。 */
  configurationRevision: number;
  /** 是否保存过自定义地址。 */
  source: "default" | "database";
}

/** 校验 TMDB 基础地址并移除末尾斜杠，空值恢复默认地址。 */
export function validateTmdbBaseUrl(
  value: unknown,
  fieldName: "apiBaseUrl" | "imageBaseUrl",
  defaultValue: string,
): string {
  if (value === null || value === undefined || value === "") return defaultValue;
  if (typeof value !== "string" || value.length > 1000) {
    throw validationError(fieldName, "TMDB 地址格式无效");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw validationError(fieldName, "TMDB 地址必须是完整 HTTP 或 HTTPS 地址");
  }
  if (!["http:", "https:"].includes(url.protocol)
    || url.username
    || url.password
    || url.search
    || url.hash) {
    throw validationError(fieldName, "TMDB 地址只能使用 HTTP/HTTPS，且不能包含账号、查询参数或片段");
  }
  return url.href.replace(/\/+$/u, "");
}

/** 读取数据库中的 TMDB 地址；没有配置时返回与 Flymby APP 对齐的默认地址。 */
export async function loadTmdbBaseUrls(database: FlyCloudHelperDatabase): Promise<TmdbBaseUrlSettings> {
  const row = await database.query("system_settings").where({ setting_key: tmdbBaseUrlSettingName }).first();
  if (!row) {
    return {
      apiBaseUrl: tmdbDefaultApiBaseUrl,
      imageBaseUrl: tmdbDefaultImageBaseUrl,
      configurationRevision: 0,
      source: "default",
    };
  }
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(String(row.setting_value));
    payload = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    throw new ApiError(503, "tmdb_base_url_configuration_invalid", "TMDB 代理地址系统配置无法读取");
  }
  return {
    apiBaseUrl: validateTmdbBaseUrl(payload.apiBaseUrl, "apiBaseUrl", tmdbDefaultApiBaseUrl),
    imageBaseUrl: validateTmdbBaseUrl(payload.imageBaseUrl, "imageBaseUrl", tmdbDefaultImageBaseUrl),
    configurationRevision: Number(row.revision ?? 0),
    source: "database",
  };
}

/** 保存 TMDB API 与图片地址；两个输入都留空时恢复默认地址并删除数据库覆盖值。 */
export async function saveTmdbBaseUrls(
  database: FlyCloudHelperDatabase,
  input: { apiBaseUrl: unknown; imageBaseUrl: unknown; updatedByUserId: string },
): Promise<TmdbBaseUrlSettings> {
  const apiBaseUrl = validateTmdbBaseUrl(input.apiBaseUrl, "apiBaseUrl", tmdbDefaultApiBaseUrl);
  const imageBaseUrl = validateTmdbBaseUrl(input.imageBaseUrl, "imageBaseUrl", tmdbDefaultImageBaseUrl);
  const usesDefaultUrls = apiBaseUrl === tmdbDefaultApiBaseUrl && imageBaseUrl === tmdbDefaultImageBaseUrl;
  await database.query.transaction(async (transaction) => {
    const existing = await transaction("system_settings").where({ setting_key: tmdbBaseUrlSettingName }).first();
    if (usesDefaultUrls) {
      if (existing) await transaction("system_settings").where({ setting_key: tmdbBaseUrlSettingName }).delete();
      return;
    }
    const now = new Date().toISOString();
    const settingValue = JSON.stringify({ apiBaseUrl, imageBaseUrl });
    if (existing) {
      await transaction("system_settings").where({ setting_key: tmdbBaseUrlSettingName }).update({
        setting_value: settingValue,
        revision: Number(existing.revision) + 1,
        updated_by_user_id: input.updatedByUserId,
        updated_at: now,
      });
      return;
    }
    await transaction("system_settings").insert({
      setting_key: tmdbBaseUrlSettingName,
      setting_value: settingValue,
      revision: 1,
      updated_by_user_id: input.updatedByUserId,
      created_at: now,
      updated_at: now,
    });
  });
  return loadTmdbBaseUrls(database);
}

/** 校验超级管理员提交的 TMDB Key 列表并去除空项和完全重复项。 */
export function validateTmdbKeyList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw validationError("keys", "TMDB Key 必须使用数组提交");
  }
  if (value.length > 100) {
    throw validationError("keys", "TMDB Key 最多支持 100 个");
  }
  const keys: string[] = [];
  value.forEach((item, index) => {
    if (typeof item !== "string") {
      throw validationError(`keys.${index}`, "TMDB Key 必须是字符串");
    }
    const key = item.trim();
    if (!key) {
      return;
    }
    if (key.length > 2048 || /\s/u.test(key)) {
      throw validationError(`keys.${index}`, "TMDB Key 格式无效");
    }
    if (!keys.includes(key)) {
      keys.push(key);
    }
  });
  return keys;
}

/** 从数据库读取并解密 TMDB Key；接口和日志不得调用本方法输出返回值。 */
export async function loadTmdbKeys(
  database: FlyCloudHelperDatabase,
  vault: CredentialVault,
): Promise<string[]> {
  const setting = await database.getSystemSecretSetting(tmdbKeySettingName);
  if (!setting) {
    return [];
  }
  const payload = vault.decrypt(setting.encryptedPayload);
  if (!Array.isArray(payload.keys)) {
    throw new ApiError(503, "tmdb_key_configuration_invalid", "TMDB Key 系统配置无法读取");
  }
  return validateTmdbKeyList(payload.keys);
}
