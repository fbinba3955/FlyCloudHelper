import { validationError } from "./errors.js";

/** Jellyfin 自定义地址后缀的数据库值和唯一比较键。 */
export interface JellyfinPathSuffixValue {
  value: string;
  lookup: string;
}

/** 校验 Jellyfin 地址后缀；只允许单个路径层级。 */
export function validateJellyfinPathSuffix(input: unknown): JellyfinPathSuffixValue {
  if (typeof input !== "string") throw validationError("jellyfinPathSuffix", "Jellyfin 地址后缀格式无效");
  const value = input.trim();
  if (value.length === 0 || Array.from(value).length > 64) {
    throw validationError("jellyfinPathSuffix", "Jellyfin 地址后缀长度必须为 1 至 64 个字符");
  }
  if (!/^[\p{L}\p{N}_-]+$/u.test(value)) {
    throw validationError("jellyfinPathSuffix", "Jellyfin 地址后缀只能包含文字、数字、短横线或下划线，且只能有一级");
  }
  return { value, lookup: value.toLowerCase() };
}

/** 生成 Jellyfin 对外协议使用的固定路径。 */
export function buildJellyfinPath(pathSuffix: string): string {
  return `/j/${encodeURIComponent(pathSuffix)}`;
}
