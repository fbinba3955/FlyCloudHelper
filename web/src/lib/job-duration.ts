import type { JobStatus } from "@/lib/api";

// 关键变量：任务时间统一显示到秒，便于对照后台任务日志和执行记录。
const jobDateTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

/** 把任务累计运行毫秒转换为紧凑的中文时长。 */
export function formatJobDuration(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}天 ${hours}小时 ${minutes}分钟`;
  if (hours > 0) return `${hours}小时 ${minutes}分钟 ${seconds}秒`;
  if (minutes > 0) return `${minutes}分钟 ${seconds}秒`;
  return `${seconds}秒`;
}

/** 终态任务展示总时长，其他状态展示当前已经累计的运行时长。 */
export function getJobDurationLabel(status: JobStatus): "总时长" | "已运行时长" {
  return status === "completed" || status === "failed" || status === "cancelled" ? "总时长" : "已运行时长";
}

/** 把服务端任务时间转换为当前浏览器时区下的中文日期时间。 */
export function formatJobDateTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : jobDateTimeFormatter.format(date);
}
