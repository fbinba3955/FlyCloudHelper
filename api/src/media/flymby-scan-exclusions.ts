/** Flymby APP 默认排除的系统、回收站和临时目录。 */
export const flymbyExcludedFolderNames = new Set([
  "@eadir", "#recycle", "@recycle", "$recycle.bin", ".trash", ".trashes", "__macosx",
  ".appledouble", ".deletedbytmm", "tmp", "temp", "cache", ".cache",
]);

/** 判断单个目录名是否属于 APP 默认排除范围。 */
export function isFlymbyExcludedFolderName(name: string): boolean {
  return flymbyExcludedFolderNames.has(String(name ?? "").trim().toLocaleLowerCase("en-US"));
}

/** 判断完整 Provider 路径中是否包含 APP 默认排除目录。 */
export function isFlymbyExcludedPath(value: string): boolean {
  return String(value ?? "")
    .replace(/\\/gu, "/")
    .split("/")
    .some((segment) => isFlymbyExcludedFolderName(segment));
}
