import { randomUUID } from "node:crypto";
import type { FlyCloudHelperDatabase } from "./database.js";
import type {
  ScanScheduleRecord,
  ScanScheduleType,
} from "./domain.js";
import { ApiError, toSafeErrorMessage } from "./errors.js";
import type { MetadataPluginManager } from "./plugin-manager.js";
import type { ServiceRepository } from "./service-repository.js";
import type { TmdbKeyPool } from "./metadata/tmdb.js";
import type { AiModelManager } from "./ai/ai-model-manager.js";

/** 定时器支持的任务类型；字段名沿用 scanMode 以兼容已经发布的客户端。 */
type ScheduledTaskMode = "incremental" | "full" | "media_probe";

interface ScanScheduleRow {
  id: string;
  user_id: string;
  service_id: string;
  scan_mode: ScheduledTaskMode;
  enabled: number | string | boolean;
  schedule_type: ScanScheduleType;
  interval_minutes: number | string | null;
  time_of_day: string | null;
  day_of_week: number | string | null;
  day_of_month: number | string | null;
  timezone_offset_minutes: number | string;
  quiet_period_enabled: number | string | boolean;
  quiet_start_time: string | null;
  quiet_end_time: string | null;
  next_run_at: string | null;
  last_triggered_at: string | null;
  last_job_id: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScanScheduleConfiguration {
  enabled: boolean;
  scheduleType: ScanScheduleType;
  intervalMinutes: number | null;
  timeOfDay: string | null;
  dayOfWeek: number | null;
  dayOfMonth: number | null;
  timezoneOffsetMinutes: number;
  quietPeriodEnabled: boolean;
  quietStartTime: string | null;
  quietEndTime: string | null;
}

type ScanScheduleLogger = (
  level: "info" | "warn",
  fields: Record<string, string | number | boolean | null>,
) => void;

/** 读取指定扫描模式的路径，并兼容仅保存旧版 roots 的服务。 */
function readConfiguredRoots(scanProfile: Record<string, unknown>, scanMode: "incremental" | "full"): unknown[] {
  const selectedRoots = scanMode === "full" ? scanProfile.fullRoots : scanProfile.incrementalRoots;
  if (Array.isArray(selectedRoots)) return selectedRoots;
  return Array.isArray(scanProfile.roots) ? scanProfile.roots : [];
}

/** 把定时任务类型转换成中文名称，统一日志和错误提示。 */
function readScheduledTaskName(scanMode: ScheduledTaskMode): string {
  if (scanMode === "full") return "全量扫描";
  if (scanMode === "incremental") return "增量扫描";
  return "视频规格分析";
}

/** 把数据库定时计划转换成接口和执行器共用的数据对象。 */
function mapScanSchedule(row: ScanScheduleRow): ScanScheduleRecord {
  return {
    id: row.id,
    userId: row.user_id,
    serviceId: row.service_id,
    scanMode: row.scan_mode,
    enabled: Number(row.enabled) === 1 || row.enabled === true,
    scheduleType: row.schedule_type,
    intervalMinutes: row.interval_minutes === null ? null : Number(row.interval_minutes),
    timeOfDay: row.time_of_day,
    dayOfWeek: row.day_of_week === null ? null : Number(row.day_of_week),
    dayOfMonth: row.day_of_month === null ? null : Number(row.day_of_month),
    timezoneOffsetMinutes: Number(row.timezone_offset_minutes),
    quietPeriodEnabled: Number(row.quiet_period_enabled) === 1 || row.quiet_period_enabled === true,
    quietStartTime: row.quiet_start_time,
    quietEndTime: row.quiet_end_time,
    nextRunAt: row.next_run_at,
    lastTriggeredAt: row.last_triggered_at,
    lastJobId: row.last_job_id,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 生成尚未保存的默认关闭计划，便于页面同时展示全量和增量配置。 */
function createDefaultSchedule(
  userId: string,
  serviceId: string,
  scanMode: ScheduledTaskMode,
): ScanScheduleRecord {
  const now = new Date().toISOString();
  return {
    id: "",
    userId,
    serviceId,
    scanMode,
    enabled: false,
    scheduleType: "interval",
    intervalMinutes: scanMode === "full" ? 7 * 24 * 60 : scanMode === "media_probe" ? 24 * 60 : 6 * 60,
    timeOfDay: "03:00",
    dayOfWeek: 1,
    dayOfMonth: 1,
    timezoneOffsetMinutes: -new Date().getTimezoneOffset(),
    quietPeriodEnabled: false,
    quietStartTime: "00:00",
    quietEndTime: "07:00",
    nextRunAt: null,
    lastTriggeredAt: null,
    lastJobId: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** 读取 HH:mm 中的小时和分钟；配置已经由接口校验。 */
function readClock(timeOfDay: string | null): { hour: number; minute: number } {
  const [hourText, minuteText] = (timeOfDay ?? "00:00").split(":");
  return {
    hour: Number(hourText ?? 0),
    minute: Number(minuteText ?? 0),
  };
}

/** 使用固定时区偏移把当地年月日时分转换成 UTC 毫秒。 */
function localPartsToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezoneOffsetMinutes: number,
): number {
  return Date.UTC(year, month, day, hour, minute, 0, 0) - timezoneOffsetMinutes * 60_000;
}

/** 返回指定年月的最后一天。 */
function getMonthDayCount(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/** 把 HH:mm 转换成当天分钟数，便于判断普通或跨零点禁扫时段。 */
function readClockMinutes(timeOfDay: string | null): number {
  const { hour, minute } = readClock(timeOfDay);
  return hour * 60 + minute;
}

/**
 * 如果候选执行时间落入每日禁扫时段，则顺延到本次禁扫结束。
 * 开始时间大于结束时间表示跨零点，例如 23:00 至 07:00。
 */
function postponeQuietCandidate(candidateMilliseconds: number, configuration: ScanScheduleConfiguration): number {
  if (!configuration.quietPeriodEnabled || !configuration.quietStartTime || !configuration.quietEndTime) {
    return candidateMilliseconds;
  }
  const startMinutes = readClockMinutes(configuration.quietStartTime);
  const endMinutes = readClockMinutes(configuration.quietEndTime);
  if (startMinutes === endMinutes) return candidateMilliseconds;

  const offset = configuration.timezoneOffsetMinutes;
  const localCandidate = new Date(candidateMilliseconds + offset * 60_000);
  const candidateMinutes = localCandidate.getUTCHours() * 60 + localCandidate.getUTCMinutes();
  const year = localCandidate.getUTCFullYear();
  const month = localCandidate.getUTCMonth();
  const day = localCandidate.getUTCDate();
  const { hour: endHour, minute: endMinute } = readClock(configuration.quietEndTime);

  if (startMinutes < endMinutes) {
    const insideSameDayPeriod = candidateMinutes >= startMinutes && candidateMinutes < endMinutes;
    return insideSameDayPeriod
      ? localPartsToUtc(year, month, day, endHour, endMinute, offset)
      : candidateMilliseconds;
  }

  // 关键变量：跨零点时，开始时间之后顺延到次日结束，结束时间之前顺延到当日结束。
  if (candidateMinutes >= startMinutes) {
    return localPartsToUtc(year, month, day + 1, endHour, endMinute, offset);
  }
  if (candidateMinutes < endMinutes) {
    return localPartsToUtc(year, month, day, endHour, endMinute, offset);
  }
  return candidateMilliseconds;
}

/** 根据当前配置计算严格晚于基准时间的下一次执行时间。 */
export function calculateNextScanRunAt(
  configuration: ScanScheduleConfiguration,
  baseTime: Date = new Date(),
): string | null {
  if (!configuration.enabled) return null;
  const baseMilliseconds = baseTime.getTime();
  if (configuration.scheduleType === "interval") {
    const candidate = baseMilliseconds + Math.max(1, configuration.intervalMinutes ?? 1) * 60_000;
    return new Date(postponeQuietCandidate(candidate, configuration)).toISOString();
  }

  const offset = configuration.timezoneOffsetMinutes; // 关键变量：指定时间按保存页面所在时区解释，而不是容器 UTC 时区。
  const localBase = new Date(baseMilliseconds + offset * 60_000);
  const { hour, minute } = readClock(configuration.timeOfDay);
  const year = localBase.getUTCFullYear();
  const month = localBase.getUTCMonth();
  const day = localBase.getUTCDate();

  if (configuration.scheduleType === "daily") {
    let candidate = localPartsToUtc(year, month, day, hour, minute, offset);
    if (candidate <= baseMilliseconds) candidate = localPartsToUtc(year, month, day + 1, hour, minute, offset);
    return new Date(postponeQuietCandidate(candidate, configuration)).toISOString();
  }

  if (configuration.scheduleType === "weekly") {
    const localDayOfWeek = localBase.getUTCDay() === 0 ? 7 : localBase.getUTCDay();
    const targetDayOfWeek = configuration.dayOfWeek ?? 1;
    let daysAhead = (targetDayOfWeek - localDayOfWeek + 7) % 7;
    let candidate = localPartsToUtc(year, month, day + daysAhead, hour, minute, offset);
    if (candidate <= baseMilliseconds) {
      daysAhead += 7;
      candidate = localPartsToUtc(year, month, day + daysAhead, hour, minute, offset);
    }
    return new Date(postponeQuietCandidate(candidate, configuration)).toISOString();
  }

  const requestedDay = configuration.dayOfMonth ?? 1;
  let targetYear = year;
  let targetMonth = month;
  let targetDay = Math.min(requestedDay, getMonthDayCount(targetYear, targetMonth));
  let candidate = localPartsToUtc(targetYear, targetMonth, targetDay, hour, minute, offset);
  if (candidate <= baseMilliseconds) {
    targetMonth += 1;
    if (targetMonth > 11) {
      targetMonth = 0;
      targetYear += 1;
    }
    targetDay = Math.min(requestedDay, getMonthDayCount(targetYear, targetMonth));
    candidate = localPartsToUtc(targetYear, targetMonth, targetDay, hour, minute, offset);
  }
  return new Date(postponeQuietCandidate(candidate, configuration)).toISOString();
}

/** 持久化服务级后台计划，并提供执行器需要的原子领取操作。 */
export class ScanScheduleStore {
  public constructor(private readonly database: FlyCloudHelperDatabase) {}

  /** 读取一个服务的扫描和视频规格计划；缺失模式返回默认关闭配置。 */
  public async listServiceSchedules(userId: string, serviceId: string): Promise<ScanScheduleRecord[]> {
    const rows = await this.database.query("service_scan_schedules")
      .where({ user_id: userId, service_id: serviceId }) as ScanScheduleRow[];
    const mapped = rows.map(mapScanSchedule);
    return (["full", "incremental", "media_probe"] as const).map((scanMode) =>
      mapped.find((item) => item.scanMode === scanMode) ?? createDefaultSchedule(userId, serviceId, scanMode));
  }

  /** 新增或覆盖一个扫描模式的计划，保留最近执行结果。 */
  public async saveServiceSchedule(input: {
    userId: string;
    serviceId: string;
    scanMode: ScheduledTaskMode;
    configuration: ScanScheduleConfiguration;
  }): Promise<ScanScheduleRecord> {
    const existing = await this.database.query("service_scan_schedules").where({
      user_id: input.userId,
      service_id: input.serviceId,
      scan_mode: input.scanMode,
    }).first() as ScanScheduleRow | undefined;
    const now = new Date();
    const nextRunAt = calculateNextScanRunAt(input.configuration, now);
    const values = {
      enabled: input.configuration.enabled ? 1 : 0,
      schedule_type: input.configuration.scheduleType,
      interval_minutes: input.configuration.scheduleType === "interval" ? input.configuration.intervalMinutes : null,
      time_of_day: input.configuration.scheduleType === "interval" ? null : input.configuration.timeOfDay,
      day_of_week: input.configuration.scheduleType === "weekly" ? input.configuration.dayOfWeek : null,
      day_of_month: input.configuration.scheduleType === "monthly" ? input.configuration.dayOfMonth : null,
      timezone_offset_minutes: input.configuration.timezoneOffsetMinutes,
      quiet_period_enabled: input.configuration.quietPeriodEnabled ? 1 : 0,
      quiet_start_time: input.configuration.quietStartTime,
      quiet_end_time: input.configuration.quietEndTime,
      next_run_at: nextRunAt,
      last_error: null,
      updated_at: now.toISOString(),
    };
    if (existing) {
      await this.database.query("service_scan_schedules").where({ id: existing.id }).update(values);
    } else {
      await this.database.query("service_scan_schedules").insert({
        id: randomUUID(),
        user_id: input.userId,
        service_id: input.serviceId,
        scan_mode: input.scanMode,
        ...values,
        last_triggered_at: null,
        last_job_id: null,
        created_at: now.toISOString(),
      });
    }
    const saved = await this.database.query("service_scan_schedules").where({
      user_id: input.userId,
      service_id: input.serviceId,
      scan_mode: input.scanMode,
    }).first() as ScanScheduleRow;
    return mapScanSchedule(saved);
  }

  /** 查询已经到期并仍处于启用状态的计划。 */
  public async listDueSchedules(now: string, limit: number): Promise<ScanScheduleRecord[]> {
    const rows = await this.database.query("service_scan_schedules")
      .where({ enabled: 1 })
      .whereNotNull("next_run_at")
      .where("next_run_at", "<=", now)
      .orderBy("next_run_at", "asc")
      .limit(limit) as ScanScheduleRow[];
    return rows.map(mapScanSchedule);
  }

  /** 原子领取一次到期执行权，同时先推进到下一周期，防止重复创建任务。 */
  public async claimDueSchedule(schedule: ScanScheduleRecord, now: Date): Promise<boolean> {
    // 最终执行闸门：即使旧计划或冲突重试时间落入禁扫时段，也只顺延自动计划，不创建扫描任务。
    const postponedRunAt = postponeQuietCandidate(now.getTime(), schedule);
    if (postponedRunAt > now.getTime()) {
      await this.database.query("service_scan_schedules")
        .where({ id: schedule.id, enabled: 1, next_run_at: schedule.nextRunAt })
        .update({
          next_run_at: new Date(postponedRunAt).toISOString(),
          updated_at: now.toISOString(),
        });
      return false;
    }
    const nextRunAt = calculateNextScanRunAt(schedule, now);
    const updated = await this.database.query("service_scan_schedules")
      .where({ id: schedule.id, enabled: 1, next_run_at: schedule.nextRunAt })
      .update({
        next_run_at: nextRunAt,
        last_triggered_at: now.toISOString(),
        last_error: null,
        updated_at: now.toISOString(),
      });
    return Number(updated) === 1;
  }

  /** 保存定时计划本次创建的后台任务；没有待分析文件时任务 ID 为空。 */
  public async markTriggeredJob(scheduleId: string, jobId: string | null): Promise<void> {
    await this.database.query("service_scan_schedules").where({ id: scheduleId }).update({
      last_job_id: jobId,
      last_error: null,
      updated_at: new Date().toISOString(),
    });
  }

  /** 保存一次计划执行失败；任务冲突时短暂推迟，避免丢失本轮计划。 */
  public async markTriggerFailure(scheduleId: string, errorMessage: string, retrySoon: boolean): Promise<void> {
    const now = new Date();
    await this.database.query("service_scan_schedules").where({ id: scheduleId }).update({
      last_error: errorMessage,
      ...(retrySoon ? { next_run_at: new Date(now.getTime() + 5 * 60_000).toISOString() } : {}),
      updated_at: now.toISOString(),
    });
  }
}

/** 轮询到期计划并复用现有扫描或规格队列，不在定时器线程直接处理媒体。 */
export class ScanScheduleWorker {
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private stopping = false;

  public constructor(private readonly options: {
    store: ScanScheduleStore;
    repository: ServiceRepository;
    plugins: MetadataPluginManager;
    aiModels: AiModelManager;
    tmdb: TmdbKeyPool;
    logger: ScanScheduleLogger;
  }) {}

  /** 启动定时计划轮询。 */
  public start(): void {
    if (this.pollTimer || this.running) return;
    this.stopping = false;
    this.scheduleNextPoll(2_000);
  }

  /** 停止轮询并等待当前一轮数据库操作结束。 */
  public async stop(): Promise<void> {
    this.stopping = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 20));
  }

  /** 安排下一轮轻量轮询。 */
  private scheduleNextPoll(delayMilliseconds: number): void {
    if (this.stopping) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.poll();
    }, delayMilliseconds);
    this.pollTimer.unref?.();
  }

  /** 领取并处理本轮到期计划。 */
  private async poll(): Promise<void> {
    if (this.running || this.stopping) return;
    this.running = true;
    try {
      const now = new Date();
      const dueSchedules = await this.options.store.listDueSchedules(now.toISOString(), 20);
      for (const schedule of dueSchedules) {
        if (this.stopping) break;
        await this.triggerSchedule(schedule, now);
      }
    } catch (error) {
      this.options.logger("warn", {
        日志关键字: "codex-flycloud-scan-schedule",
        事件: "轮询后台定时计划失败",
        错误信息: toSafeErrorMessage(error, "轮询后台定时计划失败"),
      });
    } finally {
      this.running = false;
      this.scheduleNextPoll(30_000);
    }
  }

  /** 把一条到期计划转换成扫描任务或独立 ffprobe 规格任务。 */
  private async triggerSchedule(schedule: ScanScheduleRecord, now: Date): Promise<void> {
    const postponedRunAt = postponeQuietCandidate(now.getTime(), schedule);
    if (!(await this.options.store.claimDueSchedule(schedule, now))) {
      if (postponedRunAt > now.getTime()) {
        this.options.logger("info", {
          日志关键字: "codex-flycloud-scan-schedule",
          事件: "自动任务命中每日禁扫时段",
          服务ID: schedule.serviceId,
          定时任务类型: readScheduledTaskName(schedule.scanMode),
          顺延至: new Date(postponedRunAt).toISOString(),
        });
      }
      return;
    }
    try {
      const service = await this.options.repository.getServiceDetail(schedule.serviceId, schedule.userId);
      if (schedule.scanMode === "media_probe") {
        if (service.dataType !== "video") {
          throw new ApiError(409, "media_probe_video_only", "只有影视服务可以定时分析视频规格");
        }
        if (service.status !== "active") {
          throw new ApiError(409, "service_not_active", "请先启用服务，再执行定时视频规格分析");
        }
        const result = await this.options.repository.enqueueExistingServiceMediaProbes(
          service.id,
          schedule.userId,
          schedule.userId,
          "scheduled",
        );
        await this.options.store.markTriggeredJob(schedule.id, result.jobId);
        this.options.logger("info", {
          日志关键字: "codex-flycloud-scan-schedule",
          事件: result.jobId ? "定时视频规格任务创建成功" : "定时视频规格任务没有待分析文件",
          用户ID: schedule.userId,
          服务ID: schedule.serviceId,
          计划ID: schedule.id,
          任务ID: result.jobId,
          入队文件数量: result.queuedCount,
        });
        return;
      }
      const configuredRoots = readConfiguredRoots(service.scanProfile, schedule.scanMode);
      if (configuredRoots.length === 0) {
        throw new ApiError(409, "scan_paths_not_configured", `未配置${schedule.scanMode === "full" ? "全量" : "增量"}扫描路径`);
      }
      const job = await this.options.repository.createScanJob({
        jobId: randomUUID(),
        userId: schedule.userId,
        serviceId: schedule.serviceId,
        requestedByUserId: schedule.userId,
        requestId: `schedule:${schedule.id}:${schedule.nextRunAt ?? now.toISOString()}`,
        clientDeviceId: "flycloud-helper-scheduler",
        scanMode: schedule.scanMode,
        runtimeRevision: "scanner-worker-v1",
        tmdbKeyPoolRevision: this.options.tmdb.revision,
        aiModel: await this.options.aiModels.buildTaskSnapshot(service.metadataProfile),
        pluginVersions: await this.options.plugins.buildTaskSnapshots(service.metadataProfile),
      });
      await this.options.store.markTriggeredJob(schedule.id, job.id);
      this.options.logger("info", {
        日志关键字: "codex-flycloud-scan-schedule",
        事件: "定时扫描任务创建成功",
        用户ID: schedule.userId,
        服务ID: schedule.serviceId,
        计划ID: schedule.id,
        定时任务类型: readScheduledTaskName(schedule.scanMode),
        任务ID: job.id,
      });
    } catch (error) {
      const errorMessage = toSafeErrorMessage(error, "定时后台任务创建失败");
      const retrySoon = error instanceof ApiError && error.code === "scan_job_conflict";
      await this.options.store.markTriggerFailure(schedule.id, errorMessage, retrySoon);
      this.options.logger("warn", {
        日志关键字: "codex-flycloud-scan-schedule",
        事件: "定时后台任务创建失败",
        用户ID: schedule.userId,
        服务ID: schedule.serviceId,
        计划ID: schedule.id,
        定时任务类型: readScheduledTaskName(schedule.scanMode),
        是否等待任务空闲后重试: retrySoon,
        错误信息: errorMessage,
      });
    }
  }
}
