import { Link } from "@tanstack/react-router";
import { ArrowUpRight, Plus, TriangleAlert } from "lucide-react";
import { PageHeader, PrimaryButton } from "@/components/ConsoleShell";
import { Panel, PosterCard, ProgressMeter, StatCard, StatusPill } from "@/components/ui-kit";
import {
  getOverview,
  listJobs,
  listLibraryItems,
  listServices,
  type JobStatus,
  type ServiceStatus,
} from "@/lib/api";
import { formatJobDateTime } from "@/lib/job-duration";
import { useApiResource } from "@/lib/use-api-resource";

const serviceStatusLabels: Record<ServiceStatus, string> = {
  active: "正常",
  scanning: "扫描中",
  disabled: "已停用",
  reauthorization_required: "需重新授权",
};

const jobStatusLabels: Record<JobStatus, string> = {
  queued: "排队中",
  running: "运行中",
  retry_waiting: "等待 TMDB 恢复",
  paused: "已暂停",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

/** 普通用户个人概览页面。 */
export function OverviewPage() {
  const resource = useApiResource(async () => {
    const [overview, services, jobs] = await Promise.all([
      getOverview(),
      listServices(),
      listJobs(),
    ]);
    const recentCatalogs = await Promise.all(services.items.slice(0, 4).map((service) => (
      listLibraryItems(service.libraryId, { limit: 6 }).catch(() => ({ items: [], total: 0, catalogVersion: 0 }))
    )));
    return { overview, services: services.items, jobs: jobs.items, recentItems: recentCatalogs.flatMap((item) => item.items).slice(0, 6) };
  }, []);

  if (!resource.data) {
    return <Panel><div className="py-16 text-center text-sm text-muted-foreground">{resource.error ?? "正在读取个人概览…"}</div></Panel>;
  }

  const { overview, services, jobs, recentItems } = resource.data;
  const abnormalServices = services.filter((service) => service.status !== "active" || service.connectionStatus !== "valid");

  return (
    <>
      <PageHeader
        title="个人概览"
        actions={
          <Link to="/app/services/new">
            <PrimaryButton><Plus className="size-4" /> 创建云端服务</PrimaryButton>
          </Link>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="云端服务" value={String(overview.serviceCount)} hint={`${services.filter((item) => item.status === "active").length} 个连接正常`} tone="primary" />
        <StatCard label="媒体总数" value={overview.mediaCount.toLocaleString()} hint="当前账户全部媒体" tone="info" />
        <StatCard label="运行中任务" value={String(overview.activeJobCount)} hint={`失败 ${overview.failedJobCount}`} tone="warning" />
        <StatCard label="待确认条目" value={overview.needsReviewCount.toLocaleString()} hint="等待人工确认元数据" tone="muted" />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <Panel title="异常提醒" description="需要用户处理的服务和任务">
          <div className="flex items-start gap-3 rounded-xl border border-warning/30 bg-warning/8 p-4">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
            <div>
              <p className="text-sm">{abnormalServices.length > 0 ? `${abnormalServices.length} 个服务需要处理` : "暂无本人服务异常"}</p>
              <p className="mt-1 text-xs text-muted-foreground">失败任务 {overview.failedJobCount} 个。</p>
            </div>
          </div>
        </Panel>

        <Panel
          title="最近任务"
          description="任务状态来自服务端，刷新页面可获取最新进度"
          className="xl:col-span-2"
          action={<Link to="/app/jobs" className="inline-flex items-center gap-1 text-xs text-primary-soft">全部任务 <ArrowUpRight className="size-3.5" /></Link>}
        >
          <ul className="divide-y divide-border">
            {jobs.slice(0, 3).map((job) => (
              <li key={job.id} className="py-3.5 first:pt-0 last:pb-0">
                <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{job.serviceName}</p>
                    <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{job.id} · {job.jobType === "media_probe" ? "视频规格分析" : `${job.scanMode === "full" ? "全量" : "增量"}扫描刮削`} · {job.stage}</p>
                  </div>
                  <StatusPill tone={job.status === "completed" ? "success" : job.status === "failed" ? "danger" : job.status === "retry_waiting" || job.status === "paused" || job.status === "queued" ? "warning" : "primary"}>{job.status === "retry_waiting" && job.jobType === "media_probe" ? "等待重试" : jobStatusLabels[job.status]}</StatusPill>
                </div>
                <div className="mt-1.5 grid gap-1 text-[11px] text-muted-foreground sm:grid-cols-2">
                  <span>开始时间：{formatJobDateTime(job.startedAt)}</span>
                  <span>结束时间：{formatJobDateTime(job.finishedAt)}</span>
                </div>
                <div className="mt-2.5 flex items-center gap-3">
                  <ProgressMeter value={job.processedCount} total={job.totalCount} />
                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground">已处理 {job.processedCount.toLocaleString()} 项</span>
                </div>
              </li>
            ))}
            {jobs.length === 0 && <li className="py-6 text-center text-sm text-muted-foreground">还没有后台任务</li>}
          </ul>
        </Panel>
      </div>

      <Panel title="我的服务" className="mt-4" action={<Link to="/app/services" className="inline-flex items-center gap-1 text-xs text-primary-soft">管理服务 <ArrowUpRight className="size-3.5" /></Link>}>
        <div className="grid gap-3 sm:grid-cols-2">
          {services.map((service) => (
            <div key={service.id} className="rounded-xl border border-border bg-secondary/40 p-4">
              <div className="flex items-start justify-between gap-3">
                <p className="truncate text-sm font-medium">{service.displayName}</p>
                <StatusPill tone={service.status === "active" ? "success" : "warning"}>{serviceStatusLabels[service.status]}</StatusPill>
              </div>
              <p className="mt-1 font-mono text-[11px] text-muted-foreground">{service.providerType} · {service.id}</p>
              <div className="mt-3 flex items-center justify-between text-[11px] text-muted-foreground">
                <span>连接 r{service.credentialRevision} · 扫描 r{service.scanProfileRevision}</span>
                <Link to="/app/services/$serviceId" params={{ serviceId: service.id }} className="text-primary-soft">服务设置</Link>
              </div>
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="最近入库" description="只展示服务端媒体目录，不提供播放与下载" className="mt-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {recentItems.map((item) => <PosterCard key={item.id} item={item} />)}
          {recentItems.length === 0 && <p className="col-span-full py-8 text-center text-sm text-muted-foreground">完成扫描后，媒体会出现在这里。</p>}
        </div>
      </Panel>
    </>
  );
}
