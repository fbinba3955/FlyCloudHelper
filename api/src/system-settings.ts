import type { FlyCloudHelperDatabase } from "./database.js";
import { ApiError, validationError } from "./errors.js";
import type { CredentialVault } from "./secrets.js";

/** 系统级 TMDB Key 配置在数据库中的稳定标识。 */
export const tmdbKeySettingName = "tmdb_api_keys";

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
