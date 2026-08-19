import { Link } from "@tanstack/react-router";
import { Download, Pause, Play, Radio, RefreshCw, RotateCcw, Square, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { PageHeader, PrimaryButton, SecondaryButton } from "@/components/ConsoleShell";
import { Panel, ProgressMeter, StatusPill, type StatusTone } from "@/components/ui-kit";
import {
  cancelScanJob,
  deleteScanJob,
  downloadScanFailureReport,
  listJobs,
  listServices,
  pauseScanJob,
  resumeScanJob,
  retryScanJob,
  type JobStatus,
} from "@/lib/api";
import { useApiResource } from "@/lib/use-api-resource";

// 关键变量：扫描任务页固定每 5 秒读取一次进度，避免轮询和 SSE 同时触发重复请求。
const JOB_PROGRESS_REFRESH_INTERVAL_MS = 5_000;

const jobStatusLabels: Record<JobStatus, string> = {
  queued: "排队中",
  running: "运行中",
  retry_waiting: "等待 TMDB 恢复",
  paused: "已暂停",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

const jobStageLabels: Record<string, string> = {
  queued: "等待执行",
  enumerating: "扫描与刮削",
  classifying: "识别媒体",
  scraping: "扫描刮削",
  persisting: "写入目录",
  completed: "已完成",
};

const providerTypeLabels: Record<string, string> = {
  webdav: "WebDAV",
  aliyundrive: "阿里云盘",
  baidupan: "百度网盘",
  guangya: "光鸭",
};

interface JobSnapshotField {
  label: string;
  value: string;
}

interface JobPluginSnapshot {
  pluginId: string;
  version: string;
  configurationRevision: string;
  sha256: string;
}

/** 将任务阶段转换成中文展示名称。 */
function getJobStageLabel(stage: string): string {
  return jobStageLabels[stage] ?? stage;
}

/** 根据服务数据类型显示实际扫描的文件类型。 */
function getScannedMediaLabel(dataType: "video" | "music" | "audiobook"): string {
  return dataType === "video" ? "扫描视频" : "扫描音频";
}

/** 根据服务数据类型显示完成处理的媒体业务对象。 */
function getProcessedMediaLabel(dataType: "video" | "music" | "audiobook"): string {
  if (dataType === "music") return "处理音乐";
  if (dataType === "audiobook") return "处理有声书";
  return "处理影片";
}

/** 旧任务没有保存匹配数量时显示横线，避免把未知误报为零。 */
function formatOptionalCount(value: number | null): string {
  return value === null ? "—" : value.toLocaleString();
}

/** 把服务端 ISO 时间转换为当前浏览器本地时间。 */
function formatCheckpointTime(value: string | null): string {
  if (!value) return "尚未保存";
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? value : timestamp.toLocaleString("zh-CN", { hour12: false });
}

/** 旧任务曾把所有网盘文件计入发现数，改用已处理和错误数避免继续显示非媒体文件总量。 */
function getScannedMediaCount(job: {
  discoveredCount: number;
  processedCount: number;
  errorCount: number;
  matchedCount: number | null;
}): number {
  return job.matchedCount === null ? job.processedCount + job.errorCount : job.discoveredCount;
}

/** 读取任务冻结配置中的已知字段，不向页面输出 JSON 原文。 */
function getJobSnapshotFields(snapshot: Record<string, unknown>): JobSnapshotField[] {
  const providerType = typeof snapshot.providerType === "string" ? snapshot.providerType : "";
  const fields: Array<JobSnapshotField | null> = [
    typeof snapshot.credentialRevision === "number" ? { label: "连接配置修订", value: `r${snapshot.credentialRevision}` } : null,
    typeof snapshot.scanProfileRevision === "number" ? { label: "扫描配置修订", value: `r${snapshot.scanProfileRevision}` } : null,
    typeof snapshot.metadataProfileRevision === "number" ? { label: "元数据配置修订", value: `r${snapshot.metadataProfileRevision}` } : null,
    providerType ? { label: "网盘类型", value: providerTypeLabels[providerType] ?? providerType } : null,
    typeof snapshot.runtimeRevision === "string" ? { label: "扫描程序版本", value: snapshot.runtimeRevision } : null,
    typeof snapshot.tmdbKeyPoolRevision === "string" ? { label: "TMDB Key 池版本", value: snapshot.tmdbKeyPoolRevision } : null,
    typeof snapshot.retryOfJobId === "string" && snapshot.retryOfJobId ? { label: "重试来源任务", value: snapshot.retryOfJobId } : null,
  ];
  return fields.filter((field): field is JobSnapshotField => field !== null);
}

/** 读取任务冻结的插件版本和配置修订。 */
function getJobPluginSnapshots(snapshot: Record<string, unknown>): JobPluginSnapshot[] {
  if (!Array.isArray(snapshot.pluginVersions)) return [];
  return snapshot.pluginVersions.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const plugin = value as Record<string, unknown>;
    if (typeof plugin.pluginId !== "string") return [];
    return [{
      pluginId: plugin.pluginId,
      version: typeof plugin.version === "string" ? plugin.version : "未知",
      configurationRevision: typeof plugin.configurationRevision === "number" ? `r${plugin.configurationRevision}` : "未知",
      sha256: typeof plugin.sha256 === "string" ? plugin.sha256 : "",
    }];
  });
}

/** 将任务状态映射为视觉语义。 */
function getJobTone(status: JobStatus): StatusTone {
  if (status === "completed") return "success";
  if (status === "failed" || status === "cancelled") return "danger";
  if (status === "queued" || status === "retry_waiting" || status === "paused") return "warning";
  return "primary";
}

/** 渲染任务列表及选中任务详情。 */
function JobsView({ admin }: { admin: boolean }) {
  const resource = useApiResource(() => listJobs(admin), [admin]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const jobs = resource.data?.items ?? [];
  const activeJob = jobs.find((job) => job.id === selectedJobId) ?? jobs[0];
  // 只有终态失败任务允许生成重试任务，避免把正常扫描误认为重试。
  const canRetryActiveJob = activeJob?.status === "failed" || activeJob?.status === "cancelled";
  const canPauseActiveJob = activeJob?.status === "queued" || activeJob?.status === "running" || activeJob?.status === "retry_waiting";
  const canResumeActiveJob = activeJob?.status === "paused";
  const canCancelActiveJob = Boolean(activeJob && ["queued", "running", "retry_waiting", "paused"].includes(activeJob.status));
  const canDeleteActiveJob = Boolean(activeJob && ["completed", "failed", "cancelled"].includes(activeJob.status));
  const canDownloadFailureReport = Boolean(activeJob && activeJob.status !== "queued");
  const snapshotFields = activeJob ? getJobSnapshotFields(activeJob.snapshot) : [];
  const pluginSnapshots = activeJob ? getJobPluginSnapshots(activeJob.snapshot) : [];

  useEffect(() => {
    /** 页面处于前台时才读取任务进度，后台标签页不继续占用接口。 */
    const refreshVisiblePage = (): void => {
      if (document.visibilityState !== "visible") return;
      void resource.refresh();
    };
    const timer = window.setInterval(refreshVisiblePage, JOB_PROGRESS_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [resource.refresh]);

  useEffect(() => {
    if (!resource.error) return;
    console.warn("codex-job-progress-refresh", { "刷新错误": resource.error, "管理模式": admin });
  }, [admin, resource.error]);

  /** 通过任务重试接口保留原任务关联并创建新任务。 */
  async function retrySelectedJob(): Promise<void> {
    if (!activeJob || !canRetryActiveJob) return;
    setMessage("正在创建重试任务…");
    try {
      const job = await retryScanJob(activeJob.id, admin);
      setSelectedJobId(job.id);
      setMessage(`任务 ${job.id} 已进入队列`);
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "重试失败");
    }
  }

  /** 二次确认后向 Worker 提交终止请求。 */
  async function cancelSelectedJob(): Promise<void> {
    if (!activeJob || !canCancelActiveJob) return;
    if (!window.confirm(`确定终止扫描任务 ${activeJob.id} 吗？已写入的媒体结果不会自动回滚。`)) return;
    setMessage("正在提交终止请求…");
    try {
      await cancelScanJob(activeJob.id, admin);
      setMessage(`任务 ${activeJob.id} 的终止请求已提交`);
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "终止任务失败");
    }
  }

  /** 请求 Worker 在安全边界暂停当前任务。 */
  async function pauseSelectedJob(): Promise<void> {
    if (!activeJob || !canPauseActiveJob) return;
    setMessage("正在提交暂停请求…");
    try {
      await pauseScanJob(activeJob.id, admin);
      setMessage(`任务 ${activeJob.id} 将在安全检查点暂停`);
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "暂停任务失败");
    }
  }

  /** 继续已暂停任务，服务端会从持久化目录游标恢复。 */
  async function resumeSelectedJob(): Promise<void> {
    if (!activeJob || !canResumeActiveJob) return;
    setMessage("正在恢复扫描任务…");
    try {
      await resumeScanJob(activeJob.id, admin);
      setMessage(`任务 ${activeJob.id} 已恢复到队列`);
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "继续任务失败");
    }
  }

  /** 二次确认后删除终态任务及其进度事件。 */
  async function deleteSelectedJob(): Promise<void> {
    if (!activeJob || !canDeleteActiveJob) return;
    if (!window.confirm(`确定删除扫描任务 ${activeJob.id} 吗？该任务的进度和错误记录将无法恢复。`)) return;
    setMessage("正在删除任务…");
    try {
      await deleteScanJob(activeJob.id, admin);
      setSelectedJobId(null);
      setMessage(`任务 ${activeJob.id} 已删除`);
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "删除任务失败");
    }
  }

  /** 下载任务扫描、识别和刮削阶段产生的脱敏失败报告。 */
  async function downloadSelectedFailureReport(): Promise<void> {
    if (!activeJob || !canDownloadFailureReport) return;
    setMessage("正在下载扫描失败报告…");
    try {
      await downloadScanFailureReport(activeJob.id, admin);
      setMessage(`任务 ${activeJob.id} 的失败报告已开始下载`);
    } catch (error) {
      console.warn("codex-scan-failure-report", {
        "事件": "扫描失败报告下载失败",
        "任务ID": activeJob.id,
        "错误信息": error instanceof Error ? error.message : "未知错误",
      });
      setMessage(error instanceof Error ? error.message : "扫描失败报告下载失败");
    }
  }

  return (
    <>
      <PageHeader
        title={admin ? "全部扫描任务" : "扫描任务"}
        actions={<><SecondaryButton onClick={() => void resource.refresh()}><Radio className="size-4" /> 每 5 秒刷新</SecondaryButton><SecondaryButton onClick={() => void pauseSelectedJob()} disabled={!canPauseActiveJob}><Pause className="size-4" /> 暂停</SecondaryButton><SecondaryButton onClick={() => void resumeSelectedJob()} disabled={!canResumeActiveJob}><Play className="size-4" /> 继续</SecondaryButton><SecondaryButton onClick={() => void cancelSelectedJob()} disabled={!canCancelActiveJob}><Square className="size-4" /> 终止任务</SecondaryButton><PrimaryButton onClick={() => void retrySelectedJob()} disabled={!canRetryActiveJob}><RotateCcw className="size-4" /> 重试失败任务</PrimaryButton><button type="button" onClick={() => void deleteSelectedJob()} disabled={!canDeleteActiveJob} className="inline-flex items-center justify-center gap-2 rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-2.5 text-sm text-destructive transition-colors hover:bg-destructive/15 disabled:cursor-not-allowed disabled:opacity-40"><Trash2 className="size-4" /> 删除任务</button></>}
      />
      {message && <Panel className="mb-4"><p className="text-sm text-muted-foreground">{message}</p></Panel>}
      {!activeJob ? <Panel><div className="py-16 text-center text-sm text-muted-foreground">{resource.error ?? "还没有扫描任务"}</div></Panel> : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          <Panel title={`任务详情 ${activeJob.id}`} description={`${activeJob.serviceName} · ${activeJob.scanMode === "full" ? "全量" : "增量"}扫描${admin ? ` · ${activeJob.ownerUsername}` : ""}`}>
            <div className="rounded-xl border border-primary/25 bg-primary/8 p-5">
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3"><div><p className="text-xs text-muted-foreground">当前阶段</p><p className="font-display mt-1 text-2xl font-semibold">{getJobStageLabel(activeJob.stage)}</p></div><StatusPill tone={getJobTone(activeJob.status)}>{jobStatusLabels[activeJob.status]}</StatusPill></div>
              <div className="mt-4"><ProgressMeter value={activeJob.status === "completed" ? 1 : activeJob.processedCount} total={activeJob.status === "completed" ? 1 : activeJob.totalCount} /></div>
              <div className="mt-3 min-w-0 rounded-lg border border-border/70 bg-background/30 px-3 py-2">
                <p className="text-[11px] text-muted-foreground">当前扫描路径</p>
                <p className="mt-1 truncate font-mono text-xs" title={activeJob.currentPath ?? undefined}>{activeJob.currentPath || "准备读取扫描目录"}</p>
                {activeJob.resumeSupported && <p className="mt-2 text-[11px] text-muted-foreground">可恢复检查点：{formatCheckpointTime(activeJob.checkpointUpdatedAt)}</p>}
              </div>
              {activeJob.status === "retry_waiting" && <div className="mt-3 rounded-lg border border-warning/30 bg-warning/8 px-3 py-2"><p className="text-sm font-medium">TMDB 暂时不可用，任务会自动恢复</p><p className="mt-1 text-[11px] text-muted-foreground">预计恢复时间：{formatCheckpointTime(activeJob.nextRetryAt)} · 已等待 {activeJob.retryCount.toLocaleString()} 次</p></div>}
              <div className="mt-3 grid grid-cols-2 gap-3 font-mono text-[11px] text-muted-foreground sm:grid-cols-5">
                <span title="扫描路径中识别出的可处理媒体文件数量">{getScannedMediaLabel(activeJob.dataType)} {getScannedMediaCount(activeJob).toLocaleString()}</span>
                <span title="按 Flymby APP 刮削任务聚合后，已经成功处理或最终失败的完整电影、节目数量">{getProcessedMediaLabel(activeJob.dataType)} {activeJob.processedCount.toLocaleString()}</span>
                <span title="完整电影或节目中取得元数据匹配结果的数量">已匹配 {formatOptionalCount(activeJob.matchedCount)}</span>
                <span title="完整电影或节目中已处理但没有取得元数据匹配结果的数量">未匹配 {formatOptionalCount(activeJob.unmatchedCount)}</span>
                <span title="完整电影或节目处理失败的数量">错误 {activeJob.errorCount.toLocaleString()}</span>
              </div>
              <div className="mt-4 flex justify-end border-t border-border/70 pt-4">
                <SecondaryButton onClick={() => void downloadSelectedFailureReport()} disabled={!canDownloadFailureReport}>
                  <Download className="size-4" /> 下载失败报告
                </SecondaryButton>
              </div>
            </div>
            <h3 className="mt-6 mb-3 text-sm font-semibold">配置快照（只读）</h3>
            <div className="rounded-xl border border-border bg-secondary/40 p-4">
              <dl className="grid gap-3 sm:grid-cols-2">
                {snapshotFields.map((field) => <div key={field.label}><dt className="text-[11px] text-muted-foreground">{field.label}</dt><dd className="mt-1 break-all text-sm">{field.value}</dd></div>)}
              </dl>
              <div className="mt-4 border-t border-border pt-4">
                <p className="text-[11px] text-muted-foreground">元数据插件</p>
                {pluginSnapshots.length === 0 ? <p className="mt-2 text-sm">未使用插件</p> : <ul className="mt-2 space-y-2">{pluginSnapshots.map((plugin) => <li key={`${plugin.pluginId}@${plugin.version}`} className="rounded-lg border border-border bg-background/35 px-3 py-2"><p className="text-sm">{plugin.pluginId} · {plugin.version}</p><p className="mt-1 text-[11px] text-muted-foreground">配置 {plugin.configurationRevision}{plugin.sha256 ? ` · SHA256 ${plugin.sha256.slice(0, 12)}` : ""}</p></li>)}</ul>}
              </div>
            </div>
            {activeJob.status !== "retry_waiting" && (activeJob.errorCode || activeJob.errorMessage) && <div className="mt-4 rounded-xl border border-destructive/30 bg-destructive/8 p-4"><p className="font-mono text-xs text-destructive">{activeJob.errorCode}</p><p className="mt-2 text-sm">{activeJob.errorMessage}</p></div>}
          </Panel>
          <Panel title="任务列表" description={`共 ${resource.data?.total ?? 0} 个任务`}>
            <ul className="space-y-2">
              {jobs.map((job) => <li key={job.id}><button type="button" onClick={() => setSelectedJobId(job.id)} className="w-full rounded-xl border border-border bg-secondary/40 p-3.5 text-left"><div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3"><div className="min-w-0"><p className="truncate font-mono text-xs">{job.id}</p><p className="mt-0.5 truncate text-[11px] text-muted-foreground">{job.serviceName} · {job.scanMode === "full" ? "全量" : "增量"} · {getJobStageLabel(job.stage)}{admin ? ` · ${job.ownerUsername}` : ""}</p></div><StatusPill tone={getJobTone(job.status)}>{jobStatusLabels[job.status]}</StatusPill></div><div className="mt-2.5"><ProgressMeter value={job.status === "completed" ? 1 : job.processedCount} total={job.status === "completed" ? 1 : job.totalCount} /></div></button></li>)}
            </ul>
          </Panel>
        </div>
      )}
    </>
  );
}

export function UserJobsPage() { return <JobsView admin={false} />; }
export function AdminJobsPage() { return <JobsView admin />; }

/** 按服务选择独立媒体库，不把不同服务的条目合并到同一个海报墙。 */
function CatalogServiceSelector({ admin }: { admin: boolean }) {
  const resource = useApiResource(() => listServices(admin), [admin]);
  const services = resource.data?.items ?? [];
  return (
    <>
      <PageHeader title={admin ? "媒体库管理" : "我的媒体库"} actions={<SecondaryButton onClick={() => void resource.refresh()}><RefreshCw className="size-4" /> 刷新</SecondaryButton>} />
      {resource.error && <Panel className="mb-4"><p className="text-sm text-destructive">{resource.error}</p></Panel>}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {services.map((service) => (
          <Link key={service.id} to={admin ? "/admin/services/$serviceId/catalog" : "/app/services/$serviceId/catalog"} params={{ serviceId: service.id }} className="surface block p-5 transition-colors hover:border-primary/40">
            <div className="flex items-start justify-between gap-3"><div className="min-w-0"><h2 className="truncate text-sm font-semibold">{service.displayName}</h2><p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">{service.providerType} · {service.libraryId}</p></div><StatusPill tone={service.status === "active" ? "success" : "warning"}>{service.status === "active" ? "正常" : "需处理"}</StatusPill></div>
            <div className="mt-5 flex items-center justify-between text-xs text-muted-foreground"><span>{service.itemCount.toLocaleString()} 个顶层条目</span>{admin && <span>{service.ownerUsername}</span>}</div>
          </Link>
        ))}
      </div>
      {!resource.loading && services.length === 0 && <Panel><p className="py-12 text-center text-sm text-muted-foreground">还没有可用的云端服务</p></Panel>}
    </>
  );
}

export function UserCatalogPage() { return <CatalogServiceSelector admin={false} />; }
export function AdminCatalogPage() { return <CatalogServiceSelector admin />; }
