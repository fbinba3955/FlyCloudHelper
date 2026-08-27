import type { FastifyInstance } from "fastify";
import type { ScanScheduleType, ServiceDetailRecord } from "../domain.js";
import { ApiError, validationError } from "../errors.js";
import { requireRequestUser, requireSuperAdmin } from "../http.js";
import type { ApiRuntime } from "../runtime.js";
import type {
  ScanScheduleConfiguration,
  ScanScheduleStore,
} from "../scan-schedule-service.js";

/** 定时器支持的任务类型；media_probe 对应独立 ffprobe 后台任务。 */
type ScheduledTaskMode = "incremental" | "full" | "media_probe";

/** 读取指定扫描模式的路径，并兼容仅保存旧版 roots 的服务。 */
function readConfiguredRoots(scanProfile: Record<string, unknown>, scanMode: "incremental" | "full"): unknown[] {
  const selectedRoots = scanMode === "full" ? scanProfile.fullRoots : scanProfile.incrementalRoots;
  if (Array.isArray(selectedRoots)) return selectedRoots;
  return Array.isArray(scanProfile.roots) ? scanProfile.roots : [];
}

/** 读取受范围保护的整数配置。 */
function readInteger(
  body: Record<string, unknown>,
  fieldName: string,
  displayName: string,
  minimum: number,
  maximum: number,
): number {
  const value = body[fieldName];
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw validationError(fieldName, `${displayName}必须是 ${minimum} 到 ${maximum} 之间的整数`);
  }
  return value;
}

/** 校验并读取单个扫描模式的计划配置。 */
function readScheduleConfiguration(body: Record<string, unknown>): ScanScheduleConfiguration {
  if (typeof body.enabled !== "boolean") throw validationError("enabled", "启用状态必须是布尔值");
  const scheduleType = body.scheduleType;
  const supportedTypes: ScanScheduleType[] = ["interval", "daily", "weekly", "monthly"];
  if (typeof scheduleType !== "string" || !supportedTypes.includes(scheduleType as ScanScheduleType)) {
    throw validationError("scheduleType", "执行方式只支持间隔、每天、每周或每月");
  }
  let intervalMinutes: number | null = null;
  let timeOfDay: string | null = null;
  let dayOfWeek: number | null = null;
  let dayOfMonth: number | null = null;
  if (scheduleType === "interval") {
    intervalMinutes = readInteger(body, "intervalMinutes", "间隔分钟数", 5, 525_600);
  } else {
    if (typeof body.timeOfDay !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(body.timeOfDay)) {
      throw validationError("timeOfDay", "指定时间必须使用 HH:mm 格式");
    }
    timeOfDay = body.timeOfDay;
    if (scheduleType === "weekly") dayOfWeek = readInteger(body, "dayOfWeek", "星期", 1, 7);
    if (scheduleType === "monthly") dayOfMonth = readInteger(body, "dayOfMonth", "每月日期", 1, 31);
  }
  if (body.quietPeriodEnabled !== undefined && typeof body.quietPeriodEnabled !== "boolean") {
    throw validationError("quietPeriodEnabled", "每日禁扫时段启用状态必须是布尔值");
  }
  // 兼容尚未携带禁扫字段的旧版客户端，缺省时保持关闭。
  const quietPeriodEnabled = body.quietPeriodEnabled === true;
  const quietStartTime = typeof body.quietStartTime === "string" ? body.quietStartTime : null;
  const quietEndTime = typeof body.quietEndTime === "string" ? body.quietEndTime : null;
  if (quietPeriodEnabled) {
    const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
    if (!quietStartTime || !timePattern.test(quietStartTime)) {
      throw validationError("quietStartTime", "禁扫开始时间必须使用 HH:mm 格式");
    }
    if (!quietEndTime || !timePattern.test(quietEndTime)) {
      throw validationError("quietEndTime", "禁扫结束时间必须使用 HH:mm 格式");
    }
    if (quietStartTime === quietEndTime) {
      throw validationError("quietEndTime", "禁扫开始时间和结束时间不能相同");
    }
  }
  return {
    enabled: body.enabled,
    scheduleType: scheduleType as ScanScheduleType,
    intervalMinutes,
    timeOfDay,
    dayOfWeek,
    dayOfMonth,
    timezoneOffsetMinutes: readInteger(body, "timezoneOffsetMinutes", "时区偏移分钟数", -720, 840),
    quietPeriodEnabled,
    quietStartTime,
    quietEndTime,
  };
}

/** 校验任务前置条件并保存一个服务的定时计划。 */
async function saveSchedule(
  runtime: ApiRuntime,
  store: ScanScheduleStore,
  service: ServiceDetailRecord,
  scanMode: string,
  body: Record<string, unknown>,
  operatorId: string,
  administrator: boolean,
) {
  if (scanMode !== "full" && scanMode !== "incremental" && scanMode !== "media_probe") {
    throw validationError("scanMode", "定时任务只支持 full、incremental 或 media_probe");
  }
  const scheduledTaskMode = scanMode as ScheduledTaskMode;
  const configuration = readScheduleConfiguration(body);
  if (scheduledTaskMode === "media_probe") {
    if (service.dataType !== "video") {
      throw new ApiError(409, "media_probe_video_only", "只有影视服务可以配置视频规格分析定时任务");
    }
  } else {
    const roots = readConfiguredRoots(service.scanProfile, scheduledTaskMode);
    if (configuration.enabled && roots.length === 0) {
      throw new ApiError(409, "scan_paths_not_configured", `请先配置${scheduledTaskMode === "full" ? "全量" : "增量"}扫描路径`);
    }
  }
  const schedule = await store.saveServiceSchedule({
    userId: service.userId,
    serviceId: service.id,
    scanMode: scheduledTaskMode,
    configuration,
  });
  runtime.logBusinessEvent("info", {
    日志关键字: "codex-flycloud-scan-schedule",
    事件: "保存后台定时任务",
    操作用户ID: operatorId,
    是否管理员操作: administrator,
    服务ID: service.id,
    计划ID: schedule.id,
    定时任务类型: scheduledTaskMode === "full" ? "全量扫描" :
      scheduledTaskMode === "incremental" ? "增量扫描" : "视频规格分析",
    是否启用: schedule.enabled,
    执行方式: schedule.scheduleType,
    是否启用每日禁扫: schedule.quietPeriodEnabled,
    禁扫开始时间: schedule.quietStartTime,
    禁扫结束时间: schedule.quietEndTime,
    下次执行时间: schedule.nextRunAt,
  });
  return { schedule };
}

/** 注册普通用户和超级管理员共用的后台定时计划接口。 */
export async function registerScanScheduleRoutes(
  server: FastifyInstance,
  runtime: ApiRuntime,
  store: ScanScheduleStore,
): Promise<void> {
  server.get<{ Params: { serviceId: string } }>("/api/v1/services/:serviceId/scan-schedules", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    const service = await runtime.repository.getServiceDetail(request.params.serviceId, user.id);
    const schedules = await store.listServiceSchedules(service.userId, service.id);
    return { schedules: service.dataType === "video" ? schedules : schedules.filter((item) => item.scanMode !== "media_probe") };
  });

  server.put<{ Params: { serviceId: string; scanMode: string }; Body: Record<string, unknown> }>(
    "/api/v1/services/:serviceId/scan-schedules/:scanMode",
    async (request) => {
      const user = await requireRequestUser(request, runtime.database);
      const service = await runtime.repository.getServiceDetail(request.params.serviceId, user.id);
      return saveSchedule(runtime, store, service, request.params.scanMode, request.body, user.id, false);
    },
  );

  server.get<{ Params: { serviceId: string } }>("/api/v1/admin/services/:serviceId/scan-schedules", async (request) => {
    await requireSuperAdmin(request, runtime.database);
    const service = await runtime.repository.getServiceDetail(request.params.serviceId);
    const schedules = await store.listServiceSchedules(service.userId, service.id);
    return { schedules: service.dataType === "video" ? schedules : schedules.filter((item) => item.scanMode !== "media_probe") };
  });

  server.put<{ Params: { serviceId: string; scanMode: string }; Body: Record<string, unknown> }>(
    "/api/v1/admin/services/:serviceId/scan-schedules/:scanMode",
    async (request) => {
      const operator = await requireSuperAdmin(request, runtime.database);
      const service = await runtime.repository.getServiceDetail(request.params.serviceId);
      return saveSchedule(runtime, store, service, request.params.scanMode, request.body, operator.id, true);
    },
  );
}
