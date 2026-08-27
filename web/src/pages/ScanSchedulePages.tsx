import { Link } from "@tanstack/react-router";
import { CalendarClock, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { PageHeader, PrimaryButton, SecondaryButton } from "@/components/ConsoleShell";
import { Panel, StatusPill } from "@/components/ui-kit";
import {
  getService,
  getServiceScanSchedules,
  updateServiceScanSchedule,
  type ScanSchedule,
  type ScanScheduleType,
} from "@/lib/api";
import { useApiResource } from "@/lib/use-api-resource";

type IntervalUnit = "minute" | "hour" | "day";

interface ScheduleFormState {
  enabled: boolean;
  scheduleType: ScanScheduleType;
  intervalValue: number;
  intervalUnit: IntervalUnit;
  timeOfDay: string;
  dayOfWeek: number;
  dayOfMonth: number;
  quietPeriodEnabled: boolean;
  quietStartTime: string;
  quietEndTime: string;
}

const weekDayLabels = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

/** 把接口沿用的 scanMode 转换成页面任务名称。 */
function getScheduledTaskName(scanMode: ScanSchedule["scanMode"]): string {
  if (scanMode === "full") return "全量扫描";
  if (scanMode === "incremental") return "增量扫描";
  return "视频规格分析";
}

/** 返回不同定时任务的执行说明。 */
function getScheduledTaskDescription(scanMode: ScanSchedule["scanMode"]): string {
  if (scanMode === "full") return "按计划执行完整扫描与缺失文件对账。";
  if (scanMode === "incremental") return "按计划扫描增量目录并完成刮削。";
  return "按计划为新增、变化或历史失败的视频读取时长、编码、分辨率、音轨和字幕；此计划独立于扫描时规格开关。";
}

/** 把接口分钟数转换成页面更容易编辑的数值和单位。 */
function readInterval(minutes: number | null): { value: number; unit: IntervalUnit } {
  const safeMinutes = Math.max(5, minutes ?? 60);
  if (safeMinutes % 1440 === 0) return { value: safeMinutes / 1440, unit: "day" };
  if (safeMinutes % 60 === 0) return { value: safeMinutes / 60, unit: "hour" };
  return { value: safeMinutes, unit: "minute" };
}

/** 把接口计划转成当前编辑表单。 */
function toFormState(schedule: ScanSchedule): ScheduleFormState {
  const interval = readInterval(schedule.intervalMinutes);
  return {
    enabled: schedule.enabled,
    scheduleType: schedule.scheduleType,
    intervalValue: interval.value,
    intervalUnit: interval.unit,
    timeOfDay: schedule.timeOfDay ?? "03:00",
    dayOfWeek: schedule.dayOfWeek ?? 1,
    dayOfMonth: schedule.dayOfMonth ?? 1,
    quietPeriodEnabled: schedule.quietPeriodEnabled === true,
    quietStartTime: schedule.quietStartTime ?? "00:00",
    quietEndTime: schedule.quietEndTime ?? "07:00",
  };
}

/** 把页面间隔单位换算成服务端统一保存的分钟数。 */
function toIntervalMinutes(form: ScheduleFormState): number {
  if (form.intervalUnit === "day") return form.intervalValue * 1440;
  if (form.intervalUnit === "hour") return form.intervalValue * 60;
  return form.intervalValue;
}

/** 格式化计划执行时间。 */
function formatScheduleTime(value: string | null): string {
  return value ? new Date(value).toLocaleString("zh-CN") : "暂无";
}

/** 生成当前浏览器固定时区偏移说明。 */
function getTimezoneLabel(): string {
  const offset = -new Date().getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const absolute = Math.abs(offset);
  return `UTC${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
}

/** 单独编辑全量或增量扫描计划。 */
function ScheduleEditor({
  schedule,
  admin,
  onSaved,
}: {
  schedule: ScanSchedule;
  admin: boolean;
  onSaved: (schedule: ScanSchedule) => void;
}) {
  const [form, setForm] = useState<ScheduleFormState>(() => toFormState(schedule));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => setForm(toFormState(schedule)), [schedule]);

  /** 保存当前扫描模式的完整计划配置。 */
  async function save(): Promise<void> {
    if (saving) return;
    if (form.quietPeriodEnabled && (!form.quietStartTime || !form.quietEndTime)) {
      setMessage("请完整设置每日禁扫开始和结束时间");
      return;
    }
    if (form.quietPeriodEnabled && form.quietStartTime === form.quietEndTime) {
      setMessage("禁扫开始时间和结束时间不能相同");
      return;
    }
    setSaving(true);
    setMessage("正在保存定时任务…");
    try {
      const saved = await updateServiceScanSchedule(schedule.serviceId, schedule.scanMode, {
        enabled: form.enabled,
        scheduleType: form.scheduleType,
        intervalMinutes: toIntervalMinutes(form),
        timeOfDay: form.timeOfDay,
        dayOfWeek: form.dayOfWeek,
        dayOfMonth: form.dayOfMonth,
        timezoneOffsetMinutes: -new Date().getTimezoneOffset(),
        quietPeriodEnabled: form.quietPeriodEnabled,
        quietStartTime: form.quietStartTime,
        quietEndTime: form.quietEndTime,
      }, admin);
      onSaved(saved);
      setMessage(`${getScheduledTaskName(saved.scanMode)}计划已保存`);
      console.info("codex-flycloud-scan-schedule", {
        事件: "网页保存扫描定时任务成功",
        服务ID: saved.serviceId,
        定时任务类型: getScheduledTaskName(saved.scanMode),
        是否启用: saved.enabled,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "定时任务保存失败";
      setMessage(errorMessage);
      console.warn("codex-flycloud-scan-schedule", {
        事件: "网页保存扫描定时任务失败",
        服务ID: schedule.serviceId,
        定时任务类型: getScheduledTaskName(schedule.scanMode),
        错误信息: errorMessage,
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Panel
      title={`${getScheduledTaskName(schedule.scanMode)}定时任务`}
      description={getScheduledTaskDescription(schedule.scanMode)}
    >
      <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-secondary/40 p-4">
        <div><p className="text-sm font-medium">启用计划</p><p className="mt-1 text-xs text-muted-foreground">关闭后保留配置，但不会创建后台任务。</p></div>
        <button type="button" role="switch" aria-checked={form.enabled} onClick={() => setForm((current) => ({ ...current, enabled: !current.enabled }))} className={`relative h-7 w-12 shrink-0 rounded-full border transition-colors ${form.enabled ? "border-primary bg-primary" : "border-border bg-secondary"}`}>
          <span className={`absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow-sm transition-transform ${form.enabled ? "translate-x-5" : "translate-x-0"}`} />
        </button>
      </div>

      <label className="mt-4 block"><span className="text-xs text-muted-foreground">执行方式</span><select value={form.scheduleType} onChange={(event) => setForm((current) => ({ ...current, scheduleType: event.target.value as ScanScheduleType }))} className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm"><option value="interval">按间隔时间执行</option><option value="daily">每天指定时间</option><option value="weekly">每周指定时间</option><option value="monthly">每月指定时间</option></select></label>

      {form.scheduleType === "interval" ? (
        <div className="mt-4 grid grid-cols-[minmax(0,1fr)_140px] gap-3">
          <label><span className="text-xs text-muted-foreground">间隔数值</span><input type="number" min={1} value={form.intervalValue} onChange={(event) => setForm((current) => ({ ...current, intervalValue: Math.max(1, Number(event.target.value) || 1) }))} className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm" /></label>
          <label><span className="text-xs text-muted-foreground">单位</span><select value={form.intervalUnit} onChange={(event) => setForm((current) => ({ ...current, intervalUnit: event.target.value as IntervalUnit }))} className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm"><option value="minute">分钟</option><option value="hour">小时</option><option value="day">天</option></select></label>
        </div>
      ) : (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {form.scheduleType === "weekly" && <label><span className="text-xs text-muted-foreground">每周日期</span><select value={form.dayOfWeek} onChange={(event) => setForm((current) => ({ ...current, dayOfWeek: Number(event.target.value) }))} className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm">{weekDayLabels.map((label, index) => <option key={label} value={index + 1}>{label}</option>)}</select></label>}
          {form.scheduleType === "monthly" && <label><span className="text-xs text-muted-foreground">每月日期</span><input type="number" min={1} max={31} value={form.dayOfMonth} onChange={(event) => setForm((current) => ({ ...current, dayOfMonth: Math.min(31, Math.max(1, Number(event.target.value) || 1)) }))} className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm" /></label>}
          <label><span className="text-xs text-muted-foreground">执行时间</span><input type="time" value={form.timeOfDay} onChange={(event) => setForm((current) => ({ ...current, timeOfDay: event.target.value }))} className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm" /></label>
        </div>
      )}

      <div className="mt-4 rounded-xl border border-border bg-secondary/30 p-4">
        <div className="flex items-center justify-between gap-3">
          <div><p className="text-sm font-medium">{schedule.scanMode === "media_probe" ? "每日暂停规格分析时段" : "每日禁扫时段"}</p><p className="mt-1 text-xs text-muted-foreground">只顺延当前自动定时任务；手动操作和正在运行的任务不受影响。</p></div>
          <button type="button" role="switch" aria-checked={form.quietPeriodEnabled} onClick={() => setForm((current) => ({ ...current, quietPeriodEnabled: !current.quietPeriodEnabled }))} className={`relative h-7 w-12 shrink-0 rounded-full border transition-colors ${form.quietPeriodEnabled ? "border-primary bg-primary" : "border-border bg-secondary"}`}>
            <span className={`absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow-sm transition-transform ${form.quietPeriodEnabled ? "translate-x-5" : "translate-x-0"}`} />
          </button>
        </div>
        {form.quietPeriodEnabled && (
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label><span className="text-xs text-muted-foreground">开始时间</span><input type="time" value={form.quietStartTime} onChange={(event) => setForm((current) => ({ ...current, quietStartTime: event.target.value }))} className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm" /></label>
            <label><span className="text-xs text-muted-foreground">结束时间</span><input type="time" value={form.quietEndTime} onChange={(event) => setForm((current) => ({ ...current, quietEndTime: event.target.value }))} className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm" /></label>
            <p className="text-xs text-muted-foreground sm:col-span-2">{form.quietStartTime > form.quietEndTime ? "当前时间段跨越零点。" : "每天在该时间段内不启动当前自动任务。"}命中的计划会顺延到结束时间。</p>
          </div>
        )}
      </div>

      <div className="mt-4 grid gap-2 rounded-xl border border-border bg-secondary/30 p-4 text-xs text-muted-foreground sm:grid-cols-2">
        <p>执行时区：{getTimezoneLabel()}</p><p>下次执行：{formatScheduleTime(schedule.nextRunAt)}</p><p>最近触发：{formatScheduleTime(schedule.lastTriggeredAt)}</p><p>最近任务：{schedule.lastJobId ?? "暂无"}</p>
        {schedule.lastError && <p className="sm:col-span-2 text-destructive">最近错误：{schedule.lastError}</p>}
      </div>
      <div className="mt-4 flex items-center gap-3"><PrimaryButton disabled={saving} onClick={() => void save()}><Save className="size-4" /> {saving ? "正在保存…" : "保存计划"}</PrimaryButton>{message && <span className="text-xs text-muted-foreground">{message}</span>}</div>
    </Panel>
  );
}

/** 服务扫描和视频规格分析定时任务独立设置页面。 */
export function ServiceScanSchedulePage({ serviceId, admin = false }: { serviceId: string; admin?: boolean }) {
  const service = useApiResource(() => getService(serviceId, admin), [serviceId, admin]);
  const schedules = useApiResource(() => getServiceScanSchedules(serviceId, admin), [serviceId, admin]);
  const detailPath = admin ? "/admin/services/$serviceId" : "/app/services/$serviceId";

  /** 保存后读取服务端最终计划和下次执行时间。 */
  function applySaved(_saved: ScanSchedule): void {
    void schedules.refresh();
  }

  if (!service.data || !schedules.data) return <Panel><div className="py-16 text-center text-sm text-muted-foreground">{service.error ?? schedules.error ?? "正在读取定时任务…"}</div></Panel>;
  return <><PageHeader title={`${service.data.displayName} · 定时任务`} actions={<Link to={detailPath} params={{ serviceId }}><SecondaryButton>返回服务详情</SecondaryButton></Link>} /><Panel className="mb-4"><div className="flex items-start gap-3"><CalendarClock className="mt-0.5 size-5 text-muted-foreground" /><div><p className="text-sm font-medium">计划由云助手后台执行</p><p className="mt-1 text-xs text-muted-foreground">全量扫描、增量扫描和视频规格分析计划互相独立；暂停时段只顺延自动任务，手动操作始终可以执行。</p></div><StatusPill>{getTimezoneLabel()}</StatusPill></div></Panel><div className="grid gap-4 xl:grid-cols-2">{schedules.data.map((schedule) => <ScheduleEditor key={schedule.scanMode} schedule={schedule} admin={admin} onSaved={applySaved} />)}</div></>;
}

export function UserServiceScanSchedulePage({ serviceId }: { serviceId: string }) { return <ServiceScanSchedulePage serviceId={serviceId} />; }
export function AdminServiceScanSchedulePage({ serviceId }: { serviceId: string }) { return <ServiceScanSchedulePage serviceId={serviceId} admin />; }
