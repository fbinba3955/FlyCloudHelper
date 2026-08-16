import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * 合并条件类名并处理 Tailwind 类名冲突。
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
