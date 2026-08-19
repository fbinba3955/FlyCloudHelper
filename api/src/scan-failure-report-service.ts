import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ApiConfig } from "./config.js";
import type { ScanJobRecord } from "./domain.js";
import { ApiError, toSafeErrorMessage } from "./errors.js";

interface FailureReportLogger {
  info(fields: Record<string, unknown>): void;
  warn(fields: Record<string, unknown>): void;
}

export type ScanFailureStage = "enumerating" | "classifying" | "scraping" | "persisting" | "task";

export interface ScanFailureRecordInput {
  /** 失败发生的流水线阶段。 */
  stage: ScanFailureStage;
  /** 稳定错误码，用于后续对同类问题聚合统计。 */
  errorCode: string;
  /** 原始错误只提取消息文本，不序列化堆栈或内部对象。 */
  error: unknown;
  /** true 表示已回退到其他刮削路径，任务仍可继续。 */
  recovered: boolean;
  mediaPath?: string | null;
  resourceId?: string | null;
  fileName?: string | null;
  itemType?: string | null;
  parsedTitle?: string | null;
  businessTaskKey?: string | null;
  /** 只允许调用方传入经过挑选的简单诊断字段。 */
  context?: Record<string, string | number | boolean | null>;
}

/** 把错误消息中可能出现的凭据参数脱敏，同时保留算法诊断所需文本。 */
function sanitizeFailureMessage(error: unknown): string {
  return toSafeErrorMessage(error, "扫描刮削失败")
    .replace(/(bearer\s+)[a-z\d._~+/=-]+/giu, "$1[已脱敏]")
    .replace(/([?&](?:access_token|refresh_token|token|password|secret|api_key|key)=)[^&\s#]+/giu, "$1[已脱敏]")
    .replace(/((?:access_token|refresh_token|token|password|secret|api_key)\s*[:=]\s*)[^,;\s]+/giu, "$1[已脱敏]");
}

/** 把数据库标识转换为不可越出报告目录的文件路径片段。 */
function toSafePathSegment(value: string): string {
  if (/^[a-z\d_-]+$/iu.test(value)) return value;
  return createHash("sha256").update(value).digest("hex");
}

/** 管理按扫描任务追加的 JSON Lines 失败报告。 */
export class ScanFailureReportService {
  private readonly config: ApiConfig;
  private readonly logger: FailureReportLogger;
  /** 关键变量：同一任务的并发刮削失败必须串行写入，避免 JSON 行互相穿插。 */
  private readonly appendChains = new Map<string, Promise<void>>();
  /** 关键变量：缓存任务已经写入的记录 ID，避免检查点重放产生重复失败行。 */
  private readonly recordIdsByJob = new Map<string, Set<string>>();

  public constructor(config: ApiConfig, logger: FailureReportLogger) {
    this.config = config;
    this.logger = logger;
  }

  /** 追加一条脱敏失败记录；报告写入异常只记日志，不影响扫描任务。 */
  public async record(job: ScanJobRecord, input: ScanFailureRecordInput): Promise<void> {
    const previousAppend = this.appendChains.get(job.id) ?? Promise.resolve();
    const currentAppend = previousAppend
      .catch(() => undefined)
      .then(() => this.appendRecord(job, input));
    this.appendChains.set(job.id, currentAppend);
    try {
      await currentAppend;
    } catch (error) {
      this.logger.warn({
        日志关键字: "codex-scan-failure-report",
        事件: "扫描失败报告写入失败",
        任务ID: job.id,
        服务ID: job.serviceId,
        失败阶段: input.stage,
        错误信息: toSafeErrorMessage(error, "报告文件写入失败"),
      });
    } finally {
      if (this.appendChains.get(job.id) === currentAppend) {
        this.appendChains.delete(job.id);
      }
    }
  }

  /** 返回经过任务归属校验后使用的报告路径；不存在报告时返回明确业务错误。 */
  public async getDownloadPath(job: ScanJobRecord): Promise<string> {
    const reportPath = this.getReportPath(job.userId, job.id);
    try {
      const stat = await fs.stat(reportPath);
      if (!stat.isFile() || stat.size <= 0) throw new Error("报告文件为空");
      return reportPath;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(404, "scan_failure_report_not_found", "当前扫描任务还没有失败报告");
    }
  }

  /** 任务结束或转入等待后释放去重缓存，下次续跑会从报告文件重新恢复。 */
  public release(jobId: string): void {
    this.recordIdsByJob.delete(jobId);
  }

  /** 删除任务时同步清理对应报告，避免任务不存在后遗留不可访问文件。 */
  public async remove(job: ScanJobRecord): Promise<void> {
    this.recordIdsByJob.delete(job.id);
    try {
      await fs.rm(this.getReportPath(job.userId, job.id), { force: true });
    } catch (error) {
      this.logger.warn({
        日志关键字: "codex-scan-failure-report",
        事件: "扫描失败报告清理失败",
        任务ID: job.id,
        服务ID: job.serviceId,
        错误信息: toSafeErrorMessage(error, "报告文件清理失败"),
      });
    }
  }

  /** 写入报告头和单条失败记录。 */
  private async appendRecord(job: ScanJobRecord, input: ScanFailureRecordInput): Promise<void> {
    const reportPath = this.getReportPath(job.userId, job.id);
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    const createdAt = new Date().toISOString();
    const header = {
      记录类型: "报告信息",
      格式版本: 1,
      任务ID: job.id,
      用户ID: job.userId,
      服务ID: job.serviceId,
      媒体库ID: job.libraryId,
      服务名称: job.serviceName,
      Provider类型: typeof job.snapshot.providerType === "string" ? job.snapshot.providerType : "unknown",
      扫描模式: job.scanMode,
      创建时间: createdAt,
      安全说明: "不包含服务凭据、Token、请求头和播放定位信息",
    };
    try {
      await fs.writeFile(reportPath, `${JSON.stringify(header)}\n`, { flag: "wx", mode: 0o600 });
    } catch (error) {
      const errorCode = error && typeof error === "object" && "code" in error
        ? String((error as { code?: string }).code)
        : "";
      if (errorCode !== "EEXIST") throw error;
    }

    // 关键变量：记录 ID 不含时间，相同检查点重放产生的重复失败可以在分析时直接去重。
    const recordId = createHash("sha256").update(JSON.stringify({
      jobId: job.id,
      stage: input.stage,
      errorCode: input.errorCode,
      mediaPath: input.mediaPath ?? "",
      resourceId: input.resourceId ?? "",
      businessTaskKey: input.businessTaskKey ?? "",
    })).digest("hex");
    const recordedIds = await this.loadRecordIds(job.id, reportPath);
    if (recordedIds.has(recordId)) {
      this.logger.info({
        日志关键字: "codex-video-recognition-optimize",
        事件: "扫描失败重复记录已跳过",
        任务ID: job.id,
        服务ID: job.serviceId,
        记录ID: recordId,
        错误码: input.errorCode,
      });
      return;
    }
    const record = {
      记录类型: "失败记录",
      记录ID: recordId,
      发生时间: createdAt,
      失败阶段: input.stage,
      是否已降级继续: input.recovered,
      错误码: input.errorCode,
      错误信息: sanitizeFailureMessage(input.error),
      媒体路径: input.mediaPath ?? null,
      资源ID: input.resourceId ?? null,
      文件名: input.fileName ?? null,
      媒体条目类型: input.itemType ?? null,
      识别标题: input.parsedTitle ?? null,
      影片任务标识: input.businessTaskKey ?? null,
      诊断上下文: input.context ?? {},
    };
    recordedIds.add(recordId);
    try {
      await fs.appendFile(reportPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    } catch (error) {
      recordedIds.delete(recordId);
      throw error;
    }
    this.logger.info({
      日志关键字: "codex-scan-failure-report",
      事件: "扫描失败记录已写入报告",
      任务ID: job.id,
      服务ID: job.serviceId,
      失败阶段: input.stage,
      错误码: input.errorCode,
      是否已降级继续: input.recovered,
    });
  }

  /** 首次写入任务时读取已有报告，恢复进程重启前已经落盘的记录 ID。 */
  private async loadRecordIds(jobId: string, reportPath: string): Promise<Set<string>> {
    const cachedIds = this.recordIdsByJob.get(jobId);
    if (cachedIds) return cachedIds;
    const recordedIds = new Set<string>();
    try {
      const content = await fs.readFile(reportPath, "utf8");
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try {
          const item = JSON.parse(line) as { 记录ID?: unknown };
          if (typeof item.记录ID === "string" && item.记录ID) recordedIds.add(item.记录ID);
        } catch {
          // 单行损坏不阻止后续报告继续追加，下载后仍可根据其余有效行分析。
        }
      }
    } catch (error) {
      const errorCode = error && typeof error === "object" && "code" in error
        ? String((error as { code?: string }).code)
        : "";
      if (errorCode !== "ENOENT") throw error;
    }
    this.recordIdsByJob.set(jobId, recordedIds);
    return recordedIds;
  }

  /** 生成任务专属报告绝对路径。 */
  private getReportPath(userId: string, jobId: string): string {
    return path.join(
      this.config.exportDirectory,
      "scan-failures",
      toSafePathSegment(userId),
      `${toSafePathSegment(jobId)}.jsonl`,
    );
  }
}
