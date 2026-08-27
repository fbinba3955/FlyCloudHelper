import { spawn } from "node:child_process";
import type { ApiConfig } from "./config.js";
import type { FlyCloudHelperDatabase } from "./database.js";
import { parseJsonObject } from "./domain.js";
import { parseFfprobeOutput, type MediaProbeResult } from "./media/media-probe.js";
import type { ProviderRegistry } from "./providers/registry.js";
import type { ProviderConnectionContext, ProviderFileStreamAccess } from "./providers/types.js";
import type { CredentialVault } from "./secrets.js";
import type { ServiceRepository } from "./service-repository.js";

interface MediaProbeLogger {
  info(fields: Record<string, unknown>): void;
  warn(fields: Record<string, unknown>): void;
  error(fields: Record<string, unknown>): void;
}

/** 数据库队列与源文件合并后的单个 ffprobe 工作项。 */
interface MediaProbeJob {
  /** 聚合展示和控制当前文件分析的服务级后台任务。 */
  batchJobId: string;
  sourceFileId: string;
  userId: string;
  serviceId: string;
  providerType: string;
  credentialRevision: number;
  locator: Record<string, unknown>;
  size: number;
  fileName: string;
  fingerprint: string;
  attemptCount: number;
}

/** 读取服务当前元数据修订中的媒体规格开关。 */
function isMediaProbeEnabled(profileJson: unknown): boolean {
  const profile = parseJsonObject(profileJson);
  const profiles = profile.profiles && typeof profile.profiles === "object" && !Array.isArray(profile.profiles)
    ? profile.profiles as Record<string, unknown>
    : {};
  const video = profiles.video && typeof profiles.video === "object" && !Array.isArray(profiles.video)
    ? profiles.video as Record<string, unknown>
    : {};
  return video.analyzeMediaSpecs === true;
}

/** 过滤 ffprobe 可接收的 HTTP 头，禁止换行注入命令参数。 */
function buildFfprobeHeaders(headers: Record<string, string>): string | null {
  const safeHeaders = Object.entries(headers).filter(([name, value]) => (
    /^[A-Za-z0-9-]+$/u.test(name) && !/[\r\n]/u.test(value)
  ));
  return safeHeaders.length > 0
    ? `${safeHeaders.map(([name, value]) => `${name}: ${value}`).join("\r\n")}\r\n`
    : null;
}

/** 只保留 ffprobe 错误类别，避免临时 URL 或请求头进入日志和数据库。 */
function readProbeFailureCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = String((error as { code?: unknown }).code ?? "");
    if (code === "ENOENT") return "ffprobe_unavailable";
    if (code) return code.slice(0, 100);
  }
  if (error instanceof SyntaxError) return "ffprobe_output_invalid";
  if (error instanceof Error && error.message === "ffprobe_timeout") return "ffprobe_timeout";
  if (error instanceof Error && error.message === "ffprobe_output_too_large") return "ffprobe_output_too_large";
  return "ffprobe_failed";
}

/** 使用无 shell 参数执行 ffprobe，输出和运行时间均有硬限制。 */
function executeFfprobe(
  config: ApiConfig,
  access: ProviderFileStreamAccess,
  fallbackSize: number,
  fileName: string,
  signal: AbortSignal,
): Promise<MediaProbeResult> {
  const args = [
    "-hide_banner",
    "-v", "error",
    "-print_format", "json",
    "-show_streams",
    "-show_chapters",
    "-show_format",
    "-analyzeduration", String(config.ffprobeAnalyzeDurationUs),
    "-probesize", String(config.ffprobeProbeSizeBytes),
  ];
  const headerText = buildFfprobeHeaders(access.headers);
  if (headerText) args.push("-headers", headerText);
  args.push("-i", access.url);

  return new Promise<MediaProbeResult>((resolve, reject) => {
    // 关键变量：不用 shell，避免 Provider 临时地址中的特殊字符参与命令解析。
    const child = spawn(config.ffprobePath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const outputChunks: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      callback();
    };
    // 收到后台任务终止信号时立即结束 ffprobe 子进程。
    const abort = (): void => {
      child.kill("SIGKILL");
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new Error("ffprobe_timeout")));
    }, config.ffprobeTimeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > 8 * 1024 * 1024) {
        child.kill("SIGKILL");
        finish(() => reject(new Error("ffprobe_output_too_large")));
        return;
      }
      outputChunks.push(chunk);
    });
    // stderr 可能包含临时 URL，因此只消费不保存、不输出。
    child.stderr.resume();
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (exitCode) => {
      if (settled) return;
      if (signal.aborted) {
        finish(() => reject(new Error("ffprobe_aborted")));
        return;
      }
      if (exitCode !== 0) {
        finish(() => reject(new Error("ffprobe_failed")));
        return;
      }
      finish(() => {
        try {
          const fallbackContainer = fileName.includes(".") ? fileName.split(".").pop() ?? "" : "";
          resolve(parseFfprobeOutput(Buffer.concat(outputChunks).toString("utf8"), fallbackSize, fallbackContainer));
        } catch (error) {
          reject(error);
        }
      });
    });
  });
}

/** 独立消费媒体规格队列；领取时跳过正在扫描的服务，避免反压视频发现。 */
export class MediaProbeWorker {
  private readonly database: FlyCloudHelperDatabase;
  private readonly repository: ServiceRepository;
  private readonly providers: ProviderRegistry;
  private readonly vault: CredentialVault;
  private readonly logger: MediaProbeLogger;
  private readonly config: ApiConfig;
  private readonly abortControllers = new Map<AbortController, string>();
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private activeWorkers = 0;
  private stopping = false;

  public constructor(input: {
    database: FlyCloudHelperDatabase;
    repository: ServiceRepository;
    providers: ProviderRegistry;
    vault: CredentialVault;
    logger: MediaProbeLogger;
    config: ApiConfig;
  }) {
    this.database = input.database;
    this.repository = input.repository;
    this.providers = input.providers;
    this.vault = input.vault;
    this.logger = input.logger;
    this.config = input.config;
  }

  /** 启动媒体规格队列。 */
  public start(): void {
    if (!this.config.workerEnabled || this.pollTimer || this.stopping) return;
    this.schedulePoll(0);
  }

  /** 停止领取并终止当前 ffprobe 子进程。 */
  public async stop(): Promise<void> {
    this.stopping = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.abortControllers.forEach((_jobId, controller) => controller.abort());
    while (this.activeWorkers > 0) await new Promise((resolve) => setTimeout(resolve, 20));
  }

  /** 返回健康检查和管理概览使用的媒体规格 Worker 状态。 */
  public getStatus() {
    return {
      enabled: this.config.workerEnabled,
      running: !this.stopping && this.config.workerEnabled,
      activeWorkers: this.activeWorkers,
      concurrency: this.config.mediaProbeConcurrency,
      availableSlots: Math.max(0, this.config.mediaProbeConcurrency - this.activeWorkers),
    };
  }

  /** 立即中断指定规格后台任务当前正在执行的 ffprobe。 */
  public interruptJobControl(jobId: string, _action: "pause" | "cancel"): boolean {
    let interrupted = false;
    this.abortControllers.forEach((activeJobId, controller) => {
      if (activeJobId !== jobId) return;
      controller.abort();
      interrupted = true;
    });
    return interrupted;
  }

  /** 进程启动后把上次中断的 ffprobe 工作项恢复为待处理。 */
  public async recoverInterrupted(): Promise<number> {
    const recoveredCount = await this.database.query("media_file_probes").where({ status: "running" }).update({
      status: "pending",
      error_code: "process_interrupted",
      error_message: "服务进程中断，等待重新分析",
      next_retry_at: null,
      updated_at: new Date().toISOString(),
    });
    await this.database.query("media_probe_jobs").where({ status: "running" }).update({
      status: "queued",
      stage: "queued",
      control_action: "none",
      current_file_name: null,
      active_started_at: null,
      updated_at: new Date().toISOString(),
    });
    await this.repository.adoptUnassignedMediaProbeJobs();
    const authenticationFailureServiceCount = await this.repository.restoreMediaProbeAuthenticationFailures();
    if (authenticationFailureServiceCount > 0) {
      this.logger.warn({
        日志关键字: "codex-media-ffprobe",
        事件: "启动恢复时停止鉴权失效的规格任务",
        受影响服务数量: authenticationFailureServiceCount,
        处理说明: "等待APP同步有效登录信息后自动恢复",
      });
    }
    return recoveredCount;
  }

  /** 安排下一次轮询。 */
  private schedulePoll(delay: number): void {
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.poll();
    }, delay);
  }

  /** 按低并发槽位领取规格任务。 */
  private async poll(): Promise<void> {
    if (this.stopping) return;
    try {
      while (this.activeWorkers < this.config.mediaProbeConcurrency) {
        const job = await this.claimNextJob();
        if (!job) break;
        this.activeWorkers += 1;
        void this.executeJob(job).finally(() => { this.activeWorkers -= 1; });
      }
    } catch (error) {
      this.logger.error({ 日志关键字: "codex-media-ffprobe", 事件: "领取媒体规格任务失败", 错误码: readProbeFailureCode(error) });
    } finally {
      this.schedulePoll(this.config.mediaProbePollIntervalMs);
    }
  }

  /** 原子领取一个当前仍启用规格分析、且服务不在扫描中的文件。 */
  private async claimNextJob(): Promise<MediaProbeJob | null> {
    return this.database.query.transaction(async (transaction) => {
      const now = new Date().toISOString();
      const candidates = await transaction("media_file_probes as p")
        .join("source_files as f", "f.id", "p.source_file_id")
        .join("media_probe_jobs as j", "j.id", "p.probe_job_id")
        .join("cloud_services as s", "s.id", "p.service_id")
        .join("service_metadata_profiles as mp", function joinCurrentProfile() {
          this.on("mp.service_id", "s.id").andOn("mp.revision", "s.metadata_profile_revision");
        })
        .select(
          "p.source_file_id", "p.user_id", "p.service_id", "p.probe_job_id", "p.fingerprint", "p.attempt_count",
          "j.trigger_type",
          "f.locator_json", "f.size", "f.name", "s.provider_type", "s.credential_revision", "mp.configuration_json",
        )
        .whereIn("p.status", ["pending", "retry_waiting"])
        .whereIn("j.status", ["queued", "running", "retry_waiting"])
        .where("j.control_action", "none")
        .where("f.status", "active")
        .whereNotIn("s.status", ["disabled", "scanning", "reauthorization_required"])
        .whereNull("s.deleted_at")
        // 关键变量：同服务已经排队的下一次扫描也优先，避免两个 Worker 在状态切换间隙争用网盘连接。
        .whereNotExists(
          transaction("scan_jobs as sj")
            .select(transaction.raw("1"))
            .whereRaw("sj.service_id = p.service_id")
            .whereIn("sj.status", ["queued", "running", "retry_waiting"]),
        )
        .andWhere((builder) => builder.whereNull("p.next_retry_at").orWhere("p.next_retry_at", "<=", now))
        .orderBy("p.created_at", "asc")
        .limit(20);
      for (const row of candidates) {
        // 手动、定时和重新授权恢复都是显式任务；只有扫描自动产生的规格任务受服务开关控制。
        if (!isMediaProbeEnabled(row.configuration_json)
          && row.trigger_type !== "manual_backfill"
          && row.trigger_type !== "scheduled"
          && row.trigger_type !== "reauthorized") continue;
        const changed = await transaction("media_file_probes")
          .where({ source_file_id: row.source_file_id })
          .whereIn("status", ["pending", "retry_waiting"])
          .update({ status: "running", started_at: now, updated_at: now });
        if (changed !== 1) continue;
        await transaction("media_probe_jobs").where({ id: row.probe_job_id }).whereIn("status", ["queued", "running", "retry_waiting"]).update({
          status: "running",
          stage: "probing",
          current_file_name: String(row.name ?? ""),
          error_code: null,
          error_message: null,
          next_retry_at: null,
          started_at: transaction.raw("COALESCE(started_at, ?)", [now]),
          active_started_at: transaction.raw("COALESCE(active_started_at, ?)", [now]),
          updated_at: now,
        });
        return {
          batchJobId: String(row.probe_job_id),
          sourceFileId: String(row.source_file_id),
          userId: String(row.user_id),
          serviceId: String(row.service_id),
          providerType: String(row.provider_type),
          credentialRevision: Number(row.credential_revision),
          locator: parseJsonObject(row.locator_json),
          size: Number(row.size ?? 0),
          fileName: String(row.name ?? ""),
          fingerprint: String(row.fingerprint),
          attemptCount: Number(row.attempt_count ?? 0),
        };
      }
      return null;
    });
  }

  /** 解析上游地址、执行 ffprobe 并保存标准媒体流字段。 */
  private async executeJob(job: MediaProbeJob): Promise<void> {
    const controller = new AbortController();
    this.abortControllers.set(controller, job.batchJobId);
    const startedAt = Date.now();
    try {
      // 关键变量：领取文件与注册中断控制器之间存在极短窗口，先确认父任务仍允许运行，避免暂停或终止后继续分析。
      const parentJob = await this.repository.getJob(job.batchJobId, job.userId);
      if (parentJob.status !== "running" || parentJob.controlAction !== "none") return;
      const access = await this.resolveAccess(job, controller.signal);
      const result = await executeFfprobe(this.config, access, job.size, job.fileName, controller.signal);
      const completedCount = await this.database.query("media_file_probes").where({
        source_file_id: job.sourceFileId,
        fingerprint: job.fingerprint,
        status: "running",
      }).update({
        status: "completed",
        result_json: JSON.stringify(result),
        error_code: null,
        error_message: null,
        next_retry_at: null,
        finished_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      if (completedCount !== 1) return;
      this.logger.info({
        日志关键字: "codex-media-ffprobe", 事件: "媒体规格分析完成",
        服务ID: job.serviceId, 源文件ID: job.sourceFileId,
        媒体流数量: result.mediaStreams.length, 总时长Ticks: result.runTimeTicks,
        分析耗时毫秒: Date.now() - startedAt,
      });
    } catch (error) {
      if (controller.signal.aborted && this.stopping) return;
      if (controller.signal.aborted) {
        const controlAction = await this.repository.getJobControl(job.batchJobId);
        if (controlAction === "pause" || controlAction === "cancel") {
          await this.repository.applyMediaProbeJobControl(job.batchJobId, controlAction);
          this.logger.info({
            日志关键字: "codex-media-ffprobe",
            事件: controlAction === "cancel" ? "规格后台任务已终止" : "规格后台任务已暂停",
            后台任务ID: job.batchJobId,
            服务ID: job.serviceId,
          });
          return;
        }
        // 另一个并发文件可能已确认服务鉴权失效并终止父任务，本文件不能再覆盖已经取消的状态。
        const parentJob = await this.repository.getJob(job.batchJobId, job.userId);
        if (parentJob.status !== "running") return;
      }
      const attemptCount = job.attemptCount + 1;
      const retryDelays = [60_000, 5 * 60_000, 30 * 60_000];
      const retryDelay = retryDelays[attemptCount - 1];
      const failureCode = readProbeFailureCode(error);
      if (failureCode === "provider_authentication_failed") {
        const stoppedJobIds = await this.repository.failMediaProbeJobsForAuthentication(job.serviceId, job.userId);
        // 关键变量：同一服务可能配置多个规格并发，服务级鉴权失败后立即中断其余正在取地址或分析的文件。
        for (const stoppedJobId of stoppedJobIds) this.interruptJobControl(stoppedJobId, "cancel");
        this.logger.warn({
          日志关键字: "codex-media-ffprobe",
          事件: "Provider鉴权失效停止规格后台任务",
          服务ID: job.serviceId,
          后台任务ID: job.batchJobId,
          停止任务数量: stoppedJobIds.length,
          错误码: failureCode,
          处理说明: "等待APP同步有效登录信息后自动恢复",
        });
        return;
      }
      const failedCount = await this.database.query("media_file_probes").where({
        source_file_id: job.sourceFileId,
        fingerprint: job.fingerprint,
        status: "running",
      }).update({
        status: retryDelay ? "retry_waiting" : "failed",
        attempt_count: attemptCount,
        error_code: failureCode,
        error_message: retryDelay ? "媒体规格分析失败，等待重试" : "媒体规格分析失败",
        next_retry_at: retryDelay ? new Date(Date.now() + retryDelay).toISOString() : null,
        finished_at: retryDelay ? null : new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      if (failedCount !== 1) return;
      this.logger.warn({
        日志关键字: "codex-media-ffprobe", 事件: retryDelay ? "媒体规格分析失败等待重试" : "媒体规格分析最终失败",
        服务ID: job.serviceId, 源文件ID: job.sourceFileId, 错误码: failureCode,
        已尝试次数: attemptCount, 分析耗时毫秒: Date.now() - startedAt,
      });
    } finally {
      this.abortControllers.delete(controller);
      try {
        await this.repository.synchronizeMediaProbeJob(job.batchJobId);
      } catch (error) {
        this.logger.error({
          日志关键字: "codex-media-ffprobe",
          事件: "同步规格后台任务进度失败",
          后台任务ID: job.batchJobId,
          服务ID: job.serviceId,
          错误码: readProbeFailureCode(error),
        });
      }
    }
  }

  /** 使用当前服务凭据解析短期上游地址；刷新后的连接仍写回同一凭据修订。 */
  private async resolveAccess(job: MediaProbeJob, signal: AbortSignal): Promise<ProviderFileStreamAccess> {
    const adapter = this.providers.get(job.providerType);
    const connection = this.vault.decrypt(
      await this.repository.getActiveEncryptedConnection(job.serviceId, job.userId),
    );
    const context: ProviderConnectionContext = {
      persistConnection: async (nextConnection) => this.repository.refreshActiveEncryptedConnection({
        serviceId: job.serviceId,
        userId: job.userId,
        credentialRevision: job.credentialRevision,
        encryptedConnection: this.vault.encrypt(nextConnection),
      }),
    };
    if (adapter.resolveFileStreamAccess) return adapter.resolveFileStreamAccess(connection, job.locator, signal, context);
    if (adapter.resolveFileAccess) return adapter.resolveFileAccess(connection, job.locator, signal, context);
    throw Object.assign(new Error("当前 Provider 不支持媒体规格分析"), { code: "provider_media_probe_unsupported" });
  }
}
