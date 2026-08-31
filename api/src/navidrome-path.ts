import { validationError } from "./errors.js";

/** Navidrome 自定义地址后缀的数据库值和唯一比较键。 */
export interface NavidromePathSuffixValue {
  value: string;
  lookup: string;
}

/** 校验固定 /n/ 前缀后的单层 Navidrome 地址。 */
export function validateNavidromePathSuffix(input: unknown): NavidromePathSuffixValue {
  if (typeof input !== "string") throw validationError("navidromePathSuffix", "Navidrome 地址后缀格式无效");
  const value = input.trim();
  if (value.length === 0 || Array.from(value).length > 64) {
    throw validationError("navidromePathSuffix", "Navidrome 地址后缀长度必须为 1 至 64 个字符");
  }
  if (!/^[\p{L}\p{N}_-]+$/u.test(value)) {
    throw validationError("navidromePathSuffix", "Navidrome 地址后缀只能包含文字、数字、短横线或下划线，且只能有一级");
  }
  return { value, lookup: value.toLowerCase() };
}

/** 生成 Navidrome 对外协议使用的固定路径。 */
export function buildNavidromePath(pathSuffix: string): string {
  return `/n/${encodeURIComponent(pathSuffix)}`;
}
