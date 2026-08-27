import { Link } from "@tanstack/react-router";
import { Download, Images, Pause, Play, Radio, RefreshCw, RotateCcw, Settings2, Sparkles, Square, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { PageHeader, PrimaryButton, SecondaryButton } from "@/components/ConsoleShell";
import { AdminServiceFilters } from "@/components/AdminServiceFilters";
import { AiSupplementDialog } from "@/components/AiSupplementDialog";
import { Panel, ProgressMeter, StatusPill, type StatusTone } from "@/components/ui-kit";
import {
  cancelScanJob,
  clearCompletedScanJobs,
  deleteScanJob,
  downloadScanFailureReport,
  getJobAiSupplements,
  listJobs,
  listAdminUsers,
  listMediaProbeJobFailures,
  listProviders,
  listServices,
  pauseScanJob,
  resumeScanJob,
  retryScanJob,
  type JobStatus,
  type JobAiSupplementResult,
  type MediaProbeFailure,
  type ScanJob,
  type ServiceListFilters,
} from "@/lib/api";
import { useApiResource } from "@/lib/use-api-resource";
import { formatJobDateTime, formatJobDuration, getJobDurationLabel } from "@/lib/job-duration";

// 关键变量：后台任务页固定每 5 秒读取一次进度，避免轮询和 SSE 同时触发重复请求。
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
  probing: "分析视频规格",
  completed: "已完成",
};

const backgroundJobTypeLabels = {
  scan: "扫描刮削",
  media_probe: "视频规格分析",
} as const;

type JobStatusFilter = "all" | "active" | JobStatus;
type JobTypeFilter = "all" | keyof typeof backgroundJobTypeLabels;

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

type JobOperation = "pause" | "resume" | "cancel" | "retry" | "delete";

const jobOperationLabels: Record<JobOperation, string> = {
  pause: "暂停",
  resume: "继续",
  cancel: "终止",
  retry: "重试",
  delete: "删除",
};

/** 将任务阶段转换成中文展示名称。 */
function getJobStageLabel(stage: string): string {
  return jobStageLabels[stage] ?? stage;
}

/** 返回后台任务状态文案，规格任务的等待原因不引用 TMDB。 */
function getJobStatusLabel(job: { jobType: "scan" | "media_probe"; status: JobStatus; errorCode: string | null }): string {
  if (job.jobType === "media_probe" && job.status === "retry_waiting"
    && job.errorCode === "provider_authentication_failed") return "等待重新授权";
  if (job.status === "retry_waiting" && job.jobType === "media_probe") return "等待重试";
  return jobStatusLabels[job.status];
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
    typeof snapshot.triggerType === "string" ? { label: "触发方式", value: snapshot.triggerType === "manual_backfill" ? "手动分析已有视频" : snapshot.triggerType === "scan_completed" ? "扫描完成" : snapshot.triggerType === "retry" ? "重试失败文件" : snapshot.triggerType === "reauthorized" ? "重新授权后恢复" : "服务恢复" } : null,
    typeof snapshot.sourceScanJobId === "string" && snapshot.sourceScanJobId ? { label: "来源后台任务", value: snapshot.sourceScanJobId } : null,
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

/** 生成排队任务的简短等待说明，列表和详情保持同一套含义。 */
function getQueuedJobWaitSummary(job: ScanJob): string {
  if (job.status !== "queued") return "";
  const visibleTargets = job.waitingForJobs
    .slice(0, 3)
    .map((target) => `${target.serviceName}（${target.id.slice(0, 8)}）`);
  const omittedTargetCount = Math.max(0, job.waitingForJobs.length - visibleTargets.length);
  const targetParts = [...visibleTargets];
  if (omittedTargetCount > 0) targetParts.push(`另 ${omittedTargetCount} 个`);
  if (job.hiddenWaitingJobCount > 0) targetParts.push(`其他账号 ${job.hiddenWaitingJobCount} 个`);
  const targetText = targetParts.length > 0 ? `：${targetParts.join("、")}` : "";
  const queueText = job.queueAheadCount > 0 ? `，前方另有 ${job.queueAheadCount} 个扫描任务排队` : "";
  if (job.waitingReason === "service_scan_priority") return `等待同服务扫描任务结束${targetText}`;
  if (job.waitingReason === "scan_worker_capacity") return `等待任一运行中的扫描任务结束${targetText}${queueText}`;
  if (job.waitingReason === "media_probe_worker_capacity") return `等待视频规格执行槽位${targetText}`;
  if (job.waitingReason === "scan_queue_order") return `前方还有 ${job.queueAheadCount} 个扫描任务排队`;
  return "等待后台 Worker 领取任务";
}

/** 判断任务是否支持重试；规格任务完成但包含失败文件时也可以只重试失败项。 */
function canRetryJob(job: ScanJob): boolean {
  return job.status === "failed" || job.status === "cancelled"
    || (job.jobType === "media_probe" && job.status === "completed" && job.errorCount > 0);
}

/** 判断任务是否可以进入暂停状态。 */
function canPauseJob(job: ScanJob): boolean {
  return job.status === "queued" || job.status === "running" || job.status === "retry_waiting";
}

/** 判断任务是否可以继续执行。 */
function canResumeJob(job: ScanJob): boolean {
  return job.status === "paused";
}

/** 判断任务是否允许终止。 */
function canCancelJob(job: ScanJob): boolean {
  return ["queued", "running", "retry_waiting", "paused"].includes(job.status);
}

/** 判断任务是否已经进入允许删除的终态。 */
function canDeleteJob(job: ScanJob): boolean {
  return ["completed", "failed", "cancelled"].includes(job.status);
}

/** 渲染任务列表及选中任务详情。 */
function JobsView({ admin }: { admin: boolean }) {
  const [statusFilter, setStatusFilter] = useState<JobStatusFilter>("all");
  const [jobTypeFilter, setJobTypeFilter] = useState<JobTypeFilter>("all");
  const resource = useApiResource(
    () => listJobs(admin, {
      status: statusFilter === "all" ? undefined : statusFilter,
      jobType: jobTypeFilter === "all" ? undefined : jobTypeFilter,
    }),
    [admin, statusFilter, jobTypeFilter],
  );
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [mediaProbeFailures, setMediaProbeFailures] = useState<MediaProbeFailure[]>([]);
  const [mediaProbeFailuresLoaded, setMediaProbeFailuresLoaded] = useState(false);
  const [aiSupplementDialogOpen, setAiSupplementDialogOpen] = useState(false);
  const [aiSupplementDialogJobId, setAiSupplementDialogJobId] = useState("");
  const [aiSupplementResult, setAiSupplementResult] = useState<JobAiSupplementResult | null>(null);
  const [aiSupplementLoading, setAiSupplementLoading] = useState(false);
  const [aiSupplementError, setAiSupplementError] = useState<string | null>(null);
  const [pendingJobOperations, setPendingJobOperations] = useState<Record<string, JobOperation>>({});
  const [clearingCompletedJobs, setClearingCompletedJobs] = useState(false);
  // 关键变量：引用中的任务操作会在事件处理入口同步写入，阻止 React 状态刷新前发生的连续点击。
  const pendingJobOperationsRef = useRef<Map<string, JobOperation>>(new Map());
  // 关键变量：批量清理请求同步占位，避免确认框关闭到 React 刷新之间重复提交。
  const clearingCompletedJobsRef = useRef(false);
  // 关键变量：Dialog 请求归属任务，切换任务或关闭后忽略旧请求返回。
  const aiSupplementRequestJobIdRef = useRef<string | null>(null);
  const jobs = resource.data?.items ?? [];
  const activeJob = jobs.find((job) => job.id === selectedJobId) ?? jobs[0];
  const pendingActiveJobOperation = activeJob ? pendingJobOperations[activeJob.id] : undefined;
  const activeJobOperationBlocked = Boolean(activeJob && (pendingActiveJobOperation || activeJob.controlAction !== "none"));
  const canRetryActiveJob = Boolean(activeJob && canRetryJob(activeJob));
  const canPauseActiveJob = Boolean(activeJob && canPauseJob(activeJob));
  const canResumeActiveJob = Boolean(activeJob && canResumeJob(activeJob));
  const canCancelActiveJob = Boolean(activeJob && canCancelJob(activeJob));
  const canDeleteActiveJob = Boolean(activeJob && canDeleteJob(activeJob));
  const canDownloadFailureReport = Boolean(activeJob && activeJob.jobType === "scan" && activeJob.status !== "queued");
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

  useEffect(() => {
    console.info("codex-job-list-filter", {
      "事件": "切换后台任务筛选",
      "管理模式": admin ? "管理员" : "用户",
      "状态筛选": statusFilter,
      "类型筛选": jobTypeFilter,
    });
  }, [admin, jobTypeFilter, statusFilter]);

  useEffect(() => {
    if (!activeJob || activeJob.jobType !== "media_probe" || activeJob.errorCount <= 0) {
      setMediaProbeFailures([]);
      setMediaProbeFailuresLoaded(false);
      return;
    }
    let cancelled = false;
    setMediaProbeFailuresLoaded(false);
    void listMediaProbeJobFailures(activeJob.id, admin).then((result) => {
      if (!cancelled) {
        setMediaProbeFailures(result.items);
        setMediaProbeFailuresLoaded(true);
      }
    }).catch((error) => {
      if (cancelled) return;
      setMediaProbeFailuresLoaded(true);
      console.warn("codex-media-ffprobe-task", {
        事件: "读取规格后台任务失败文件失败",
        后台任务ID: activeJob.id,
        错误信息: error instanceof Error ? error.message : "未知错误",
      });
    });
    return () => { cancelled = true; };
  }, [activeJob?.errorCount, activeJob?.id, activeJob?.jobType, admin]);

  /** 同步占用当前任务的操作槽，避免同一任务同时提交暂停、终止等互斥请求。 */
  function beginJobOperation(jobId: string, operation: JobOperation): boolean {
    const existingOperation = pendingJobOperationsRef.current.get(jobId);
    if (existingOperation) {
      console.warn("codex-flycloud-helper-job-operation", {
        事件: "拦截重复任务操作",
        任务ID: jobId,
        正在处理: jobOperationLabels[existingOperation],
        本次操作: jobOperationLabels[operation],
      });
      return false;
    }
    pendingJobOperationsRef.current.set(jobId, operation);
    setPendingJobOperations(Object.fromEntries(pendingJobOperationsRef.current));
    return true;
  }

  /** 释放指定任务操作槽；请求成功、失败都允许用户在状态刷新后重新操作。 */
  function finishJobOperation(jobId: string): void {
    pendingJobOperationsRef.current.delete(jobId);
    setPendingJobOperations(Object.fromEntries(pendingJobOperationsRef.current));
  }

  /** 通过任务重试接口保留原任务关联并创建新任务。 */
  async function retryJob(targetJob: ScanJob): Promise<void> {
    if (!canRetryJob(targetJob)) return;
    const targetJobId = targetJob.id;
    if (!beginJobOperation(targetJobId, "retry")) return;
    setMessage("正在创建重试任务…");
    try {
      const job = await retryScanJob(targetJobId, admin);
      setSelectedJobId(job.id);
      setMessage(`任务 ${job.id} 已进入队列`);
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "重试失败");
    } finally {
      finishJobOperation(targetJobId);
    }
  }

  /** 二次确认后向对应 Worker 提交后台任务终止请求。 */
  async function cancelJob(targetJob: ScanJob): Promise<void> {
    if (!canCancelJob(targetJob)) return;
    if (!window.confirm(`确定终止后台任务 ${targetJob.id} 吗？已经完成的处理结果不会自动回滚。`)) return;
    const targetJobId = targetJob.id;
    if (!beginJobOperation(targetJobId, "cancel")) return;
    setMessage("正在提交终止请求…");
    try {
      await cancelScanJob(targetJobId, admin);
      setMessage(`任务 ${targetJobId} 的终止请求已提交`);
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "终止任务失败");
    } finally {
      finishJobOperation(targetJobId);
    }
  }

  /** 请求对应 Worker 在安全边界暂停当前后台任务。 */
  async function pauseJob(targetJob: ScanJob): Promise<void> {
    if (!canPauseJob(targetJob)) return;
    const targetJobId = targetJob.id;
    if (!beginJobOperation(targetJobId, "pause")) return;
    setMessage("正在提交暂停请求…");
    try {
      await pauseScanJob(targetJobId, admin);
      setMessage(`任务 ${targetJobId} 将在安全检查点暂停`);
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "暂停任务失败");
    } finally {
      finishJobOperation(targetJobId);
    }
  }

  /** 继续已暂停后台任务，扫描任务恢复目录游标，规格任务继续剩余文件。 */
  async function resumeJob(targetJob: ScanJob): Promise<void> {
    if (!canResumeJob(targetJob)) return;
    const targetJobId = targetJob.id;
    if (!beginJobOperation(targetJobId, "resume")) return;
    setMessage("正在恢复后台任务…");
    try {
      await resumeScanJob(targetJobId, admin);
      setMessage(`任务 ${targetJobId} 已恢复到队列`);
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "继续任务失败");
    } finally {
      finishJobOperation(targetJobId);
    }
  }

  /** 二次确认后删除终态任务及其进度事件。 */
  async function deleteJob(targetJob: ScanJob): Promise<void> {
    if (!canDeleteJob(targetJob)) return;
    if (!window.confirm(`确定删除后台任务 ${targetJob.id} 吗？该任务的进度和错误记录将无法恢复。`)) return;
    const targetJobId = targetJob.id;
    if (!beginJobOperation(targetJobId, "delete")) return;
    setMessage("正在删除任务…");
    try {
      await deleteScanJob(targetJobId, admin);
      setSelectedJobId((currentJobId) => currentJobId === targetJobId ? null : currentJobId);
      setMessage(`任务 ${targetJobId} 已删除`);
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "删除任务失败");
    } finally {
      finishJobOperation(targetJobId);
    }
  }

  /** 二次确认后清除权限范围内全部已完成任务，其他状态任务保持不变。 */
  async function clearCompletedJobs(): Promise<void> {
    if (clearingCompletedJobsRef.current) return;
    if (!window.confirm("确定清除全部已完成任务吗？本操作只删除状态为“已完成”的任务；失败、已取消、排队、运行、等待重试和暂停任务都会保留。")) return;
    clearingCompletedJobsRef.current = true;
    setClearingCompletedJobs(true);
    setMessage("正在清除已完成任务…");
    try {
      const deletedCount = await clearCompletedScanJobs(admin);
      setSelectedJobId(null);
      setMessage(`已清除 ${deletedCount.toLocaleString()} 个已完成任务`);
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "清除已完成任务失败");
    } finally {
      clearingCompletedJobsRef.current = false;
      setClearingCompletedJobs(false);
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

  /** 打开当前扫描任务的 AI 补充汇总，并读取最近 20 条采用内容。 */
  async function openAiSupplementDialog(): Promise<void> {
    if (!activeJob || activeJob.jobType !== "scan") return;
    const targetJobId = activeJob.id;
    aiSupplementRequestJobIdRef.current = targetJobId;
    setAiSupplementDialogJobId(targetJobId);
    setAiSupplementDialogOpen(true);
    setAiSupplementLoading(true);
    setAiSupplementError(null);
    setAiSupplementResult(null);
    try {
      const result = await getJobAiSupplements(targetJobId, admin);
      if (aiSupplementRequestJobIdRef.current !== targetJobId) return;
      setAiSupplementResult(result);
    } catch (error) {
      if (aiSupplementRequestJobIdRef.current !== targetJobId) return;
      const errorMessage = error instanceof Error ? error.message : "读取 AI 补充详情失败";
      console.warn("codex-flycloud-helper-ai-clean", {
        事件: "读取任务AI补充详情失败",
        任务ID: targetJobId,
        错误信息: errorMessage,
      });
      setAiSupplementError(errorMessage);
    } finally {
      if (aiSupplementRequestJobIdRef.current === targetJobId) setAiSupplementLoading(false);
    }
  }

  /** 关闭 AI 补充详情并使尚未完成的旧请求失效。 */
  function closeAiSupplementDialog(): void {
    aiSupplementRequestJobIdRef.current = null;
    setAiSupplementDialogOpen(false);
  }

  return (
    <>
      <PageHeader
        title={admin ? "全部后台任务" : "后台任务"}
        actions={<>
          <SecondaryButton onClick={() => void resource.refresh()}><Radio className="size-4" /> 每 5 秒刷新</SecondaryButton>
          <SecondaryButton onClick={() => { if (activeJob) void pauseJob(activeJob); }} disabled={!canPauseActiveJob || activeJobOperationBlocked}><Pause className="size-4" /> {pendingActiveJobOperation === "pause" || activeJob?.controlAction === "pause" ? "暂停处理中…" : "暂停"}</SecondaryButton>
          <SecondaryButton onClick={() => { if (activeJob) void resumeJob(activeJob); }} disabled={!canResumeActiveJob || activeJobOperationBlocked}><Play className="size-4" /> {pendingActiveJobOperation === "resume" ? "正在继续…" : "继续"}</SecondaryButton>
          <SecondaryButton onClick={() => { if (activeJob) void cancelJob(activeJob); }} disabled={!canCancelActiveJob || activeJobOperationBlocked}><Square className="size-4" /> {pendingActiveJobOperation === "cancel" || activeJob?.controlAction === "cancel" ? "终止处理中…" : "终止任务"}</SecondaryButton>
          <PrimaryButton onClick={() => { if (activeJob) void retryJob(activeJob); }} disabled={!canRetryActiveJob || activeJobOperationBlocked}><RotateCcw className="size-4" /> {pendingActiveJobOperation === "retry" ? "正在重试…" : "重试失败内容"}</PrimaryButton>
          <button type="button" onClick={() => { if (activeJob) void deleteJob(activeJob); }} disabled={!canDeleteActiveJob || activeJobOperationBlocked} className="inline-flex items-center justify-center gap-2 rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-2.5 text-sm text-destructive transition-colors hover:bg-destructive/15 disabled:cursor-not-allowed disabled:opacity-40"><Trash2 className="size-4" /> {pendingActiveJobOperation === "delete" ? "正在删除…" : "删除任务"}</button>
        </>}
      />
      {message && <Panel className="mb-4"><p className="text-sm text-muted-foreground">{message}</p></Panel>}
      <Panel className="mb-4" title="筛选任务">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1.5 text-xs text-muted-foreground">
            任务状态
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as JobStatusFilter)}
              className="rounded-lg border border-input bg-background/50 px-3 py-2 text-sm text-foreground outline-none focus:border-ring"
            >
              <option value="all">全部状态</option>
              <option value="active">未结束</option>
              <option value="queued">排队中</option>
              <option value="running">运行中</option>
              <option value="retry_waiting">等待重试</option>
              <option value="paused">已暂停</option>
              <option value="completed">已完成</option>
              <option value="failed">失败</option>
              <option value="cancelled">已取消</option>
            </select>
          </label>
          <label className="grid gap-1.5 text-xs text-muted-foreground">
            任务类型
            <select
              value={jobTypeFilter}
              onChange={(event) => setJobTypeFilter(event.target.value as JobTypeFilter)}
              className="rounded-lg border border-input bg-background/50 px-3 py-2 text-sm text-foreground outline-none focus:border-ring"
            >
              <option value="all">全部类型</option>
              <option value="scan">扫描刮削</option>
              <option value="media_probe">视频规格分析</option>
            </select>
          </label>
        </div>
      </Panel>
      {!activeJob ? <Panel><div className="py-16 text-center text-sm text-muted-foreground">{resource.error ?? (statusFilter === "all" && jobTypeFilter === "all" ? "还没有后台任务" : "当前筛选条件下没有任务")}</div></Panel> : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          <Panel title={`任务详情 ${activeJob.id}`} description={`${activeJob.serviceName} · ${activeJob.jobType === "media_probe" ? "视频规格分析" : `${activeJob.scanMode === "full" ? "全量" : "增量"}扫描刮削`}${admin ? ` · ${activeJob.ownerUsername}` : ""}`}>
            <div className="rounded-xl border border-primary/25 bg-primary/8 p-5">
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3"><div><p className="text-xs text-muted-foreground">当前阶段</p><p className="font-display mt-1 text-2xl font-semibold">{getJobStageLabel(activeJob.stage)}</p><p className="mt-1 text-xs text-muted-foreground">{getJobDurationLabel(activeJob.status)}：{formatJobDuration(activeJob.elapsedMs)}</p></div><StatusPill tone={getJobTone(activeJob.status)}>{getJobStatusLabel(activeJob)}</StatusPill></div>
              <div className="mt-4"><ProgressMeter value={activeJob.status === "completed" ? 1 : activeJob.processedCount} total={activeJob.status === "completed" ? 1 : activeJob.totalCount} /></div>
              {activeJob.status === "queued" && <div className="mt-3 rounded-lg border border-warning/30 bg-warning/8 px-3 py-2.5">
                <p className="text-xs font-medium">{getQueuedJobWaitSummary(activeJob)}</p>
                {activeJob.waitingForJobs.length > 0 && <ul className="mt-2 space-y-1.5">
                  {activeJob.waitingForJobs.map((target) => <li key={`${target.jobType}:${target.id}`} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 text-[11px] text-muted-foreground">
                    <span className="min-w-0 truncate" title={`${target.serviceName} · ${target.id}`}>{target.serviceName} · <span className="font-mono">{target.id}</span>{admin ? ` · ${target.ownerUsername}` : ""}</span>
                    <span>{jobStatusLabels[target.status]}</span>
                  </li>)}
                </ul>}
              </div>}
              <div className="mt-3 min-w-0 rounded-lg border border-border/70 bg-background/30 px-3 py-2">
                <p className="text-[11px] text-muted-foreground">{activeJob.jobType === "media_probe" ? "当前分析文件" : "当前扫描路径"}</p>
                <p className="mt-1 truncate font-mono text-xs" title={activeJob.currentPath ?? undefined}>{activeJob.currentPath || (activeJob.jobType === "media_probe" ? "等待领取视频文件" : "准备读取扫描目录")}</p>
                {activeJob.jobType === "scan" && activeJob.resumeSupported && <p className="mt-2 text-[11px] text-muted-foreground">可恢复检查点：{formatCheckpointTime(activeJob.checkpointUpdatedAt)}</p>}
              </div>
              {activeJob.status === "retry_waiting" && <div className="mt-3 rounded-lg border border-warning/30 bg-warning/8 px-3 py-2"><p className="text-sm font-medium">{activeJob.jobType === "media_probe" ? activeJob.errorCode === "provider_authentication_failed" ? "Provider 登录已失效，等待 APP 同步有效登录信息" : "上游地址或文件读取暂时失败，任务会自动重试" : "TMDB 暂时不可用，任务会自动恢复"}</p><p className="mt-1 text-[11px] text-muted-foreground">{activeJob.jobType === "media_probe" && activeJob.errorCode === "provider_authentication_failed" ? "同步成功后后台任务会自动继续" : <>预计恢复时间：{formatCheckpointTime(activeJob.nextRetryAt)}{activeJob.jobType === "scan" ? ` · 已等待 ${activeJob.retryCount.toLocaleString()} 次` : ""}</>}</p></div>}
              {activeJob.jobType === "media_probe" ? (
                <div className="mt-3 grid grid-cols-3 gap-3 font-mono text-[11px] text-muted-foreground">
                  <span>总文件 {activeJob.totalCount?.toLocaleString() ?? "0"}</span>
                  <span>已处理 {activeJob.processedCount.toLocaleString()}</span>
                  <span>失败 {activeJob.errorCount.toLocaleString()}</span>
                </div>
              ) : (
                <div className="mt-3 grid grid-cols-2 gap-3 font-mono text-[11px] text-muted-foreground sm:grid-cols-5">
                  <span title="扫描路径中识别出的可处理媒体文件数量">{getScannedMediaLabel(activeJob.dataType)} {getScannedMediaCount(activeJob).toLocaleString()}</span>
                  <span title="按 Flymby APP 刮削任务聚合后，已经成功处理或最终失败的完整电影、节目数量">{getProcessedMediaLabel(activeJob.dataType)} {activeJob.processedCount.toLocaleString()}</span>
                  <span title="完整电影或节目中取得元数据匹配结果的数量">已匹配 {formatOptionalCount(activeJob.matchedCount)}</span>
                  <span title="完整电影或节目中已处理但没有取得元数据匹配结果的数量">未匹配 {formatOptionalCount(activeJob.unmatchedCount)}</span>
                  <span title="完整电影或节目处理失败的数量">错误 {activeJob.errorCount.toLocaleString()}</span>
                </div>
              )}
              {activeJob.jobType === "scan" && <div className="mt-4 flex flex-wrap justify-end gap-2 border-t border-border/70 pt-4">
                <SecondaryButton onClick={() => void openAiSupplementDialog()}>
                  <Sparkles className="size-4" /> AI补充详情
                </SecondaryButton>
                <SecondaryButton onClick={() => void downloadSelectedFailureReport()} disabled={!canDownloadFailureReport}>
                  <Download className="size-4" /> 下载失败报告
                </SecondaryButton>
              </div>}
            </div>
            <h3 className="mt-6 mb-3 text-sm font-semibold">配置快照（只读）</h3>
            <div className="rounded-xl border border-border bg-secondary/40 p-4">
              <dl className="grid gap-3 sm:grid-cols-2">
                {snapshotFields.map((field) => <div key={field.label}><dt className="text-[11px] text-muted-foreground">{field.label}</dt><dd className="mt-1 break-all text-sm">{field.value}</dd></div>)}
              </dl>
              {activeJob.jobType === "scan" && <div className="mt-4 border-t border-border pt-4">
                <p className="text-[11px] text-muted-foreground">元数据插件</p>
                {pluginSnapshots.length === 0 ? <p className="mt-2 text-sm">未使用插件</p> : <ul className="mt-2 space-y-2">{pluginSnapshots.map((plugin) => <li key={`${plugin.pluginId}@${plugin.version}`} className="rounded-lg border border-border bg-background/35 px-3 py-2"><p className="text-sm">{plugin.pluginId} · {plugin.version}</p><p className="mt-1 text-[11px] text-muted-foreground">配置 {plugin.configurationRevision}{plugin.sha256 ? ` · SHA256 ${plugin.sha256.slice(0, 12)}` : ""}</p></li>)}</ul>}
              </div>}
            </div>
            {activeJob.jobType === "media_probe" && activeJob.errorCount > 0 && (
              <div className="mt-4 rounded-xl border border-warning/30 bg-warning/8 p-4">
                <h3 className="text-sm font-semibold">失败文件</h3>
                {mediaProbeFailures.length > 0 ? <ul className="mt-3 max-h-72 space-y-2 overflow-y-auto pr-1">{mediaProbeFailures.map((failure) => (
                  <li key={failure.sourceFileId} className="rounded-lg border border-border bg-background/35 px-3 py-2">
                    <p className="truncate text-xs" title={failure.fileName}>{failure.fileName}</p>
                    <p className="mt-1 font-mono text-[10px] text-muted-foreground">{failure.errorCode} · {failure.errorMessage}</p>
                  </li>
                ))}</ul> : <p className="mt-2 text-xs text-muted-foreground">{mediaProbeFailuresLoaded ? "没有需要逐文件展示的失败记录" : "正在读取失败文件…"}</p>}
              </div>
            )}
            {activeJob.status !== "retry_waiting" && (activeJob.errorCode || activeJob.errorMessage) && <div className="mt-4 rounded-xl border border-destructive/30 bg-destructive/8 p-4"><p className="font-mono text-xs text-destructive">{activeJob.errorCode}</p><p className="mt-2 text-sm">{activeJob.errorMessage}</p></div>}
          </Panel>
          <Panel
            title="任务列表"
            description={`共 ${resource.data?.total ?? 0} 个任务`}
            action={<button type="button" title="只清除状态为已完成的任务" onClick={() => void clearCompletedJobs()} disabled={clearingCompletedJobs} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-destructive/40 bg-destructive/8 px-3 py-2 text-xs text-destructive transition-colors hover:bg-destructive/15 disabled:cursor-not-allowed disabled:opacity-40"><Trash2 className="size-3.5" /> {clearingCompletedJobs ? "正在清除…" : "清除已完成"}</button>}
          >
            <ul className="space-y-2">
              {jobs.map((job) => {
                const selected = activeJob?.id === job.id;
                const pendingOperation = pendingJobOperations[job.id];
                const operationBlocked = Boolean(pendingOperation || job.controlAction !== "none");
                return <li key={job.id}>
                  <article className={`overflow-hidden rounded-xl border bg-secondary/40 transition-colors ${selected ? "border-foreground/45" : "border-border hover:border-foreground/25"}`}>
                    <button type="button" aria-pressed={selected} onClick={() => setSelectedJobId(job.id)} className="w-full p-3.5 text-left">
                      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
                        <div className="min-w-0">
                          <p className="truncate font-mono text-xs">{job.id}</p>
                          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{job.serviceName} · {backgroundJobTypeLabels[job.jobType]} · {job.jobType === "scan" ? `${job.scanMode === "full" ? "全量" : "增量"} · ` : ""}{getJobStageLabel(job.stage)}{admin ? ` · ${job.ownerUsername}` : ""}</p>
                          <p className="mt-1 text-[11px] text-muted-foreground">{getJobDurationLabel(job.status)}：{formatJobDuration(job.elapsedMs)}</p>
                          {job.status === "queued" && <p className="mt-1 truncate text-[11px] text-warning" title={getQueuedJobWaitSummary(job)}>{getQueuedJobWaitSummary(job)}</p>}
                          <div className="mt-1 grid gap-1 text-[11px] text-muted-foreground sm:grid-cols-2"><span>开始时间：{formatJobDateTime(job.startedAt)}</span><span>结束时间：{formatJobDateTime(job.finishedAt)}</span></div>
                        </div>
                        <StatusPill tone={getJobTone(job.status)}>{getJobStatusLabel(job)}</StatusPill>
                      </div>
                      <div className="mt-2.5"><ProgressMeter value={job.status === "completed" ? 1 : job.processedCount} total={job.status === "completed" ? 1 : job.totalCount} /></div>
                    </button>
                    <div className="flex flex-wrap justify-end gap-2 border-t border-border/70 px-3.5 py-2.5">
                      {canPauseJob(job) && <button type="button" onClick={() => { setSelectedJobId(job.id); void pauseJob(job); }} disabled={operationBlocked} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background/35 px-2.5 py-1.5 text-[11px] text-foreground transition-colors hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-40"><Pause className="size-3.5" />{pendingOperation === "pause" || job.controlAction === "pause" ? "暂停处理中…" : "暂停"}</button>}
                      {canResumeJob(job) && <button type="button" onClick={() => { setSelectedJobId(job.id); void resumeJob(job); }} disabled={operationBlocked} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background/35 px-2.5 py-1.5 text-[11px] text-foreground transition-colors hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-40"><Play className="size-3.5" />{pendingOperation === "resume" ? "正在继续…" : "继续"}</button>}
                      {canCancelJob(job) && <button type="button" onClick={() => { setSelectedJobId(job.id); void cancelJob(job); }} disabled={operationBlocked} className="inline-flex items-center gap-1.5 rounded-lg border border-destructive/35 bg-destructive/8 px-2.5 py-1.5 text-[11px] text-destructive transition-colors hover:bg-destructive/15 disabled:cursor-not-allowed disabled:opacity-40"><Square className="size-3.5" />{pendingOperation === "cancel" || job.controlAction === "cancel" ? "终止处理中…" : "终止"}</button>}
                      {canRetryJob(job) && <button type="button" onClick={() => { setSelectedJobId(job.id); void retryJob(job); }} disabled={operationBlocked} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background/35 px-2.5 py-1.5 text-[11px] text-foreground transition-colors hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-40"><RotateCcw className="size-3.5" />{pendingOperation === "retry" ? "正在重试…" : "重试"}</button>}
                      {canDeleteJob(job) && <button type="button" onClick={() => { setSelectedJobId(job.id); void deleteJob(job); }} disabled={operationBlocked} className="inline-flex items-center gap-1.5 rounded-lg border border-destructive/35 bg-destructive/8 px-2.5 py-1.5 text-[11px] text-destructive transition-colors hover:bg-destructive/15 disabled:cursor-not-allowed disabled:opacity-40"><Trash2 className="size-3.5" />{pendingOperation === "delete" ? "正在删除…" : "删除"}</button>}
                    </div>
                  </article>
                </li>;
              })}
            </ul>
          </Panel>
        </div>
      )}
      <AiSupplementDialog state={{
        open: aiSupplementDialogOpen,
        loading: aiSupplementLoading,
        error: aiSupplementError,
        jobId: aiSupplementDialogJobId,
        result: aiSupplementResult,
        onClose: closeAiSupplementDialog,
      }} />
    </>
  );
}

export function UserJobsPage() { return <JobsView admin={false} />; }
export function AdminJobsPage() { return <JobsView admin />; }

/** 按服务选择独立媒体库，不把不同服务的条目合并到同一个海报墙。 */
function CatalogServiceSelector({ admin }: { admin: boolean }) {
  const [filters, setFilters] = useState<ServiceListFilters>({});
  const resource = useApiResource(
    () => listServices(admin, admin ? filters : {}),
    [admin, filters.search, filters.userId, filters.providerType, filters.dataType, filters.status, filters.jellyfinEnabled],
  );
  const filterOptions = useApiResource(async () => {
    if (!admin) return { users: [], providers: [] };
    const [users, providers] = await Promise.all([listAdminUsers(), listProviders()]);
    return { users: users.items, providers };
  }, [admin]);
  const services = resource.data?.items ?? [];
  return (
    <>
      <PageHeader title={admin ? "媒体库管理" : "我的媒体库"} actions={<SecondaryButton onClick={() => void resource.refresh()}><RefreshCw className="size-4" /> 刷新</SecondaryButton>} />
      {admin && <AdminServiceFilters value={filters} users={filterOptions.data?.users ?? []} providers={filterOptions.data?.providers ?? []} resultCount={resource.data?.total ?? 0} onChange={setFilters} />}
      {resource.error && <Panel className="mb-4"><p className="text-sm text-destructive">{resource.error}</p></Panel>}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {services.map((service) => (
          <article key={service.id} className="surface p-5">
            <div className="flex items-start justify-between gap-3"><div className="min-w-0"><h2 className="truncate text-sm font-semibold">{service.displayName}</h2><p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">{service.providerType} · {service.libraryId}</p></div><StatusPill tone={service.status === "active" ? "success" : "warning"}>{service.status === "active" ? "来源服务正常" : "来源服务需处理"}</StatusPill></div>
            <dl className="mt-5 grid grid-cols-2 gap-3 text-center">
              <div className="rounded-lg border border-border bg-secondary/40 p-3"><dt className="text-[10px] text-muted-foreground">媒体条目</dt><dd className="mt-1 text-xs font-medium">{service.itemCount.toLocaleString()}</dd></div>
              <div className="rounded-lg border border-border bg-secondary/40 p-3"><dt className="text-[10px] text-muted-foreground">目录版本</dt><dd className="mt-1 text-xs font-medium">v{service.catalogVersion}</dd></div>
            </dl>
            <div className="mt-4 flex flex-wrap gap-2">
              <StatusPill tone={service.jellyfinEnabled ? "success" : "neutral"}>Jellyfin {service.jellyfinEnabled ? "已启用" : "未启用"}</StatusPill>
              {admin && <StatusPill>{service.ownerUsername}</StatusPill>}
            </div>
            <footer className="mt-5 flex flex-wrap gap-2">
              <Link to={admin ? "/admin/libraries/$serviceId/catalog" : "/app/libraries/$serviceId/catalog"} params={{ serviceId: service.id }} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground"><Images className="size-3.5" /> 海报墙</Link>
              <Link to={admin ? "/admin/libraries/$serviceId/settings" : "/app/libraries/$serviceId/settings"} params={{ serviceId: service.id }} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground"><Settings2 className="size-3.5" /> 媒体库设置</Link>
            </footer>
          </article>
        ))}
      </div>
      {!resource.loading && services.length === 0 && <Panel><p className="py-12 text-center text-sm text-muted-foreground">还没有可用的云端服务</p></Panel>}
    </>
  );
}

export function UserCatalogPage() { return <CatalogServiceSelector admin={false} />; }
export function AdminCatalogPage() { return <CatalogServiceSelector admin />; }
