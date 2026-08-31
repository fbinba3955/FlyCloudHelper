import { validationError } from "./errors.js";

/** Emby 自定义地址后缀的数据库值和唯一比较键。 */
export interface EmbyPathSuffixValue {
  value: string;
  lookup: string;
}

/** 校验 Emby 地址后缀；只允许固定 /e/ 后的单个路径层级。 */
export function validateEmbyPathSuffix(input: unknown): EmbyPathSuffixValue {
  if (typeof input !== "string") throw validationError("embyPathSuffix", "Emby 地址后缀格式无效");
  // 关键变量：保留用户输入的展示大小写，唯一校验统一使用小写键。
  const value = input.trim();
  if (value.length === 0 || Array.from(value).length > 64) {
    throw validationError("embyPathSuffix", "Emby 地址后缀长度必须为 1 至 64 个字符");
  }
  if (!/^[\p{L}\p{N}_-]+$/u.test(value)) {
    throw validationError("embyPathSuffix", "Emby 地址后缀只能包含文字、数字、短横线或下划线，且只能有一级");
  }
  return { value, lookup: value.toLowerCase() };
}

/** 生成 Emby 对外协议使用的规范根路径。 */
export function buildEmbyPath(pathSuffix: string): string {
  return `/e/${encodeURIComponent(pathSuffix)}`;
}
