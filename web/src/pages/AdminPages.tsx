import { Link } from "@tanstack/react-router";
import { Plus, Puzzle, RefreshCw, Save, ServerCog, Trash2, Upload } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { PageHeader, PrimaryButton, SecondaryButton } from "@/components/ConsoleShell";
import { Panel, ProgressMeter, StatCard, StatusPill } from "@/components/ui-kit";
import {
  clearAdminTmdbCache,
  createAdminUser,
  deleteAdminUser,
  getAdminConfigStatus,
  getCurrentUser,
  getAdminStatus,
  importPlugin,
  listAdminUsers,
  listAuditEntries,
  listJobs,
  listPlugins,
  listServices,
  purgeAdminUser,
  revokeAdminUserSessions,
  updateAdminUserStatus,
  updateAdminTmdbKeys,
  updateAdminPublicBaseUrl,
  updatePluginStatus,
  type AdminConfigStatus,
  type AdminRuntimeStatus,
  type AuthRole,
  type JobStatus,
} from "@/lib/api";
import { formatJobDateTime } from "@/lib/job-duration";
import { useApiResource } from "@/lib/use-api-resource";

const jobStatusLabels: Record<JobStatus, string> = {
  queued: "排队中", running: "运行中", retry_waiting: "等待 TMDB 恢复", paused: "已暂停", completed: "已完成", failed: "失败", cancelled: "已取消",
};

const userRoleLabels: Record<AuthRole, string> = {
  user: "普通用户",
  super_admin: "超级管理员",
};

// 关键变量：管理概览每 5 秒同步一次系统、服务和任务状态。
const ADMIN_OVERVIEW_REFRESH_INTERVAL_MS = 5_000;

const userStatusLabels = {
  active: "正常",
  disabled: "已停用",
  pending_delete: "待删除",
} as const;

const databaseTypeLabels = {
  sqlite: "SQLite",
  postgres: "PostgreSQL",
  mysql: "MySQL",
} as const;

const configurationSourceLabels = {
  file: "Secret 文件",
  environment: "环境变量",
  generated: "系统自动生成",
  missing: "未配置",
} as const;

/** 展示系统摘要中的单项可读状态。 */
function SystemSummaryItem({
  label,
  value,
  status,
  tone = "neutral",
}: {
  label: string;
  value: string;
  status: string;
  tone?: "neutral" | "primary" | "success" | "warning" | "danger" | "info";
}) {
  return (
    <div className="rounded-xl border border-border bg-secondary/40 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-2 truncate text-sm font-medium">{value}</p></div>
        <StatusPill tone={tone}>{status}</StatusPill>
      </div>
    </div>
  );
}

/** 将后台脱敏配置转换为中文系统摘要，不展示 JSON 原文。 */
function SystemConfigurationSummary({ config }: { config: AdminConfigStatus }) {
  const tmdbConfigured = config.tmdb.configuredCount > 0;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <SystemSummaryItem label="数据库" value={`${databaseTypeLabels[config.database.type]} · 架构 v${config.database.schemaVersion}`} status="正常" tone="success" />
      <SystemSummaryItem label="TMDB" value={`${config.tmdb.healthyCount}/${config.tmdb.configuredCount} 个 Key 可用 · 并发 ${config.tmdb.effectiveConcurrency} · 配置 r${config.tmdb.configurationRevision}`} status={tmdbConfigured ? "已配置" : "未配置"} tone={tmdbConfigured ? "success" : "warning"} />
      <SystemSummaryItem label="音乐刮削" value="MusicBrainz" status={config.music.musicBrainz.status === "available" ? "可用" : "不可用"} tone={config.music.musicBrainz.status === "available" ? "success" : "warning"} />
      <SystemSummaryItem label="凭据主密钥" value={configurationSourceLabels[config.credentials.source]} status={config.credentials.configured ? "已配置" : "未配置"} tone={config.credentials.configured ? "success" : "danger"} />
      <SystemSummaryItem label="元数据插件" value={`已启用 ${config.plugins.enabledCount} / 已安装 ${config.plugins.installedCount}`} status={config.plugins.directoryReady ? "目录正常" : "目录异常"} tone={config.plugins.directoryReady ? "success" : "danger"} />
      <SystemSummaryItem label="扫描 Worker" value={`活动 ${config.worker.activeWorkers} / 并发 ${config.worker.concurrency}`} status={config.worker.running ? "运行中" : "已停止"} tone={config.worker.running ? "success" : "warning"} />
    </div>
  );
}

/** 展示管理端运行状态中的关键指标。 */
function SystemRuntimeSummary({ status }: { status: AdminRuntimeStatus }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <SystemSummaryItem label="服务实例" value={status.serviceInstanceId} status="运行中" tone="success" />
      <SystemSummaryItem label="数据库连接" value={databaseTypeLabels[status.database.type]} status={status.database.connected ? "已连接" : "未连接"} tone={status.database.connected ? "success" : "danger"} />
      <SystemSummaryItem label="用户与服务" value={`${status.userCount} 个用户 · ${status.serviceCount} 个服务`} status="正常" tone="info" />
      <SystemSummaryItem label="媒体目录" value={`${status.mediaCount.toLocaleString()} 个条目`} status={`待确认 ${status.needsReviewCount}`} tone={status.needsReviewCount > 0 ? "warning" : "success"} />
      <SystemSummaryItem label="后台任务" value={`${status.activeJobCount} 个活动任务`} status={`含失败 ${status.failedJobCount}`} tone={status.failedJobCount > 0 ? "danger" : "success"} />
      <SystemSummaryItem label="Worker 槽位" value={`${status.worker.availableSlots} 个可用槽位`} status={status.worker.running ? "运行中" : "已停止"} tone={status.worker.running ? "success" : "warning"} />
    </div>
  );
}

/** 超级管理员全局概览页面。 */
export function AdminOverviewPage() {
  const resource = useApiResource(async () => {
    const [status, services, jobs, config] = await Promise.all([getAdminStatus(), listServices(true), listJobs(true), getAdminConfigStatus()]);
    return { status, services: services.items, jobs: jobs.items, config };
  }, []);

  useEffect(() => {
    /** 页面处于前台时刷新管理概览，防止后台标签页持续产生请求。 */
    const refreshVisiblePage = (): void => {
      if (document.visibilityState !== "visible") return;
      void resource.refresh();
    };
    const timer = window.setInterval(refreshVisiblePage, ADMIN_OVERVIEW_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [resource.refresh]);

  useEffect(() => {
    if (!resource.error) return;
    console.warn("codex-admin-overview-refresh", { "刷新错误": resource.error });
  }, [resource.error]);

  if (!resource.data) return <Panel><div className="py-16 text-center text-sm text-muted-foreground">{resource.error ?? "正在读取管理概览…"}</div></Panel>;
  const { status, services, jobs, config } = resource.data;
  return (
    <>
      <PageHeader title="管理概览" actions={<><Link to="/admin/users"><PrimaryButton><Plus className="size-4" /> 用户管理</PrimaryButton></Link><Link to="/admin/plugins"><SecondaryButton><Puzzle className="size-4" /> 插件管理</SecondaryButton></Link><Link to="/admin/system"><SecondaryButton><ServerCog className="size-4" /> 系统状态</SecondaryButton></Link></>} />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="用户总数" value={String(status.userCount)} hint="全部已注册账号" tone="primary" />
        <StatCard label="服务总数" value={String(status.serviceCount)} hint={`${services.filter((item) => item.status !== "active").length} 个需处理`} tone="warning" />
        <StatCard label="媒体总数" value={status.mediaCount.toLocaleString()} hint="跨全部用户" tone="info" />
        <StatCard label="活动任务" value={String(status.activeJobCount)} hint={`失败 ${status.failedJobCount}`} tone="muted" />
      </div>
      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <Panel title="系统摘要" description="组件健康状态，只显示脱敏信息">
          <SystemConfigurationSummary config={config} />
        </Panel>
        <Panel title="最近任务" description="跨用户任务进度" className="xl:col-span-2">
          <ul className="space-y-2.5">
            {jobs.slice(0, 8).map((job) => (
              <li key={job.id} className="rounded-xl border border-border bg-secondary/40 p-3.5">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm">{job.serviceName}</p>
                    <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{job.id} · {job.ownerUsername} · {job.jobType === "media_probe" ? "视频规格分析" : "扫描刮削"} · {job.stage}</p>
                  </div>
                  <StatusPill tone={job.status === "failed" ? "danger" : job.status === "completed" ? "success" : job.status === "retry_waiting" || job.status === "paused" || job.status === "queued" ? "warning" : "primary"}>{job.status === "retry_waiting" && job.jobType === "media_probe" ? "等待重试" : jobStatusLabels[job.status]}</StatusPill>
                </div>
                <div className="mt-1.5 grid gap-1 text-[11px] text-muted-foreground sm:grid-cols-2">
                  <span>开始时间：{formatJobDateTime(job.startedAt)}</span>
                  <span>结束时间：{formatJobDateTime(job.finishedAt)}</span>
                </div>
                <div className="mt-2.5"><ProgressMeter value={job.processedCount} total={job.totalCount} /></div>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
      <Panel title="需要处理的服务" className="mt-4"><div className="overflow-x-auto"><table className="w-full min-w-[620px] text-left text-xs"><thead className="text-[10px] text-muted-foreground uppercase"><tr><th className="pb-2.5">服务</th><th className="pb-2.5">所属用户</th><th className="pb-2.5">Provider</th><th className="pb-2.5">状态</th></tr></thead><tbody className="divide-y divide-border">{services.filter((service) => service.status !== "active" || service.connectionStatus !== "valid").map((service) => <tr key={service.id}><td className="py-3">{service.displayName}</td><td className="py-3 text-muted-foreground">{service.ownerUsername}</td><td className="py-3 font-mono text-muted-foreground">{service.providerType}</td><td className="py-3"><StatusPill tone="warning">{service.status}</StatusPill></td></tr>)}</tbody></table></div></Panel>
    </>
  );
}

/** 超级管理员用户管理页面。 */
export function AdminUsersPage() {
  const resource = useApiResource(async () => {
    const [users, currentUser] = await Promise.all([listAdminUsers(), getCurrentUser()]);
    return { ...users, currentUser };
  }, []);
  const [showCreate, setShowCreate] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [deletingUserId, setDeletingUserId] = useState<string | null>(null);
  // 关键变量：同步占用删除操作，避免状态刷新前重复提交同一个敏感请求。
  const deletingUserIdRef = useRef<string | null>(null);

  /** 创建普通用户并刷新用户列表。 */
  async function submitCreate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setMessage("正在创建用户…");
    try {
      await createAdminUser({ username: String(form.get("username") ?? ""), password: String(form.get("password") ?? ""), passwordConfirmation: String(form.get("passwordConfirmation") ?? "") });
      setMessage("用户创建成功");
      setShowCreate(false);
      await resource.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "用户创建失败"); }
  }

  /** 切换用户状态并刷新列表。 */
  async function toggleUser(userId: string, username: string, active: boolean): Promise<void> {
    const actionName = active ? "停用" : "启用";
    if (!window.confirm(`确定要${actionName}用户“${username}”吗？`)) return;
    try {
      await updateAdminUserStatus(userId, active ? "disabled" : "active");
      setMessage(`用户“${username}”已${actionName}`);
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "状态修改失败");
    }
  }

  /** 二次确认后撤销目标用户的全部登录会话。 */
  async function revokeUserSessions(userId: string, username: string): Promise<void> {
    if (!window.confirm(`确定要撤销用户“${username}”的全部登录会话吗？该用户需要重新登录。`)) return;
    try {
      await revokeAdminUserSessions(userId);
      setMessage(`用户“${username}”的全部会话已撤销`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "撤销失败");
    }
  }

  /** 二次确认后将其他账号标记为待删除，并刷新用户列表。 */
  async function deleteUser(userId: string, username: string): Promise<void> {
    if (userId === resource.data?.currentUser.userId) {
      setMessage("不能删除当前登录的超级管理员账号");
      return;
    }
    if (deletingUserIdRef.current) return;
    if (!window.confirm(`确定要删除用户“${username}”吗？该账号会立即退出全部登录并进入待删除状态。`)) return;
    deletingUserIdRef.current = userId;
    setDeletingUserId(userId);
    setMessage(`正在删除用户“${username}”…`);
    try {
      await deleteAdminUser(userId);
      setMessage(`用户“${username}”已进入待删除状态`);
      await resource.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "删除用户失败";
      console.warn("codex-flycloud-helper-user-action", {
        事件: "管理员删除用户失败",
        目标用户ID: userId,
        错误信息: errorMessage,
      });
      setMessage(errorMessage);
    } finally {
      deletingUserIdRef.current = null;
      setDeletingUserId(null);
    }
  }

  /** 二次确认后彻底删除待删除账号及其全部关联数据。 */
  async function purgeUser(userId: string, username: string): Promise<void> {
    if (userId === resource.data?.currentUser.userId) {
      setMessage("不能删除当前登录的超级管理员账号");
      return;
    }
    if (deletingUserIdRef.current) return;
    if (!window.confirm(`确定要彻底删除用户“${username}”吗？该账号、服务、媒体库及相关数据删除后无法恢复。`)) return;
    deletingUserIdRef.current = userId;
    setDeletingUserId(userId);
    setMessage(`正在彻底删除用户“${username}”…`);
    try {
      await purgeAdminUser(userId);
      setMessage(`用户“${username}”及其全部关联数据已彻底删除`);
      await resource.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "彻底删除用户失败";
      console.warn("codex-flycloud-helper-user-action", {
        事件: "管理员彻底删除用户失败",
        目标用户ID: userId,
        错误信息: errorMessage,
      });
      setMessage(errorMessage);
    } finally {
      deletingUserIdRef.current = null;
      setDeletingUserId(null);
    }
  }

  return (
    <>
      <PageHeader title="用户管理" actions={<PrimaryButton onClick={() => setShowCreate((value) => !value)}><Plus className="size-4" /> 创建用户</PrimaryButton>} />
      {showCreate && <Panel className="mb-4" title="创建普通用户"><form onSubmit={(event) => void submitCreate(event)} className="grid gap-3 md:grid-cols-4"><input name="username" required minLength={4} placeholder="用户名" className="rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm" /><input name="password" required minLength={4} type="password" placeholder="密码" className="rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm" /><input name="passwordConfirmation" required minLength={4} type="password" placeholder="确认密码" className="rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm" /><PrimaryButton type="submit">确认创建</PrimaryButton></form></Panel>}
      {message && <p className="mb-4 text-sm text-muted-foreground">{message}</p>}
      <div className="grid gap-4 lg:grid-cols-2">{resource.data?.items.map((user) => {
        const isCurrentUser = user.userId === resource.data?.currentUser.userId;
        const isDeleting = deletingUserId === user.userId;
        return <article key={user.userId} className="surface p-5"><header className="flex items-center justify-between gap-3"><div><h2 className="text-sm font-semibold">{user.username}</h2><p className="mt-1 font-mono text-[11px] text-muted-foreground">{user.userId}</p></div><div className="flex gap-2"><StatusPill tone={user.role === "super_admin" ? "primary" : "neutral"}>{userRoleLabels[user.role]}</StatusPill><StatusPill tone={user.status === "active" ? "success" : "danger"}>{userStatusLabels[user.status]}</StatusPill></div></header><dl className="mt-5 grid grid-cols-2 gap-3 text-center"><div className="rounded-lg border border-border bg-secondary/40 p-3"><dt className="text-[10px] text-muted-foreground">服务数</dt><dd className="mt-1 text-xs font-medium">{user.serviceCount}</dd></div><div className="rounded-lg border border-border bg-secondary/40 p-3"><dt className="text-[10px] text-muted-foreground">媒体数</dt><dd className="mt-1 text-xs font-medium">{user.mediaCount.toLocaleString()}</dd></div></dl><footer className="mt-5 flex flex-wrap gap-2"><button type="button" onClick={() => void toggleUser(user.userId, user.username, user.status === "active")} className="cursor-pointer rounded-lg border border-border bg-secondary/30 px-3 py-2 text-xs text-foreground transition-colors hover:border-foreground/30 hover:bg-secondary">{user.status === "active" ? "停用用户" : "启用用户"}</button><button type="button" onClick={() => void revokeUserSessions(user.userId, user.username)} className="cursor-pointer rounded-lg border border-border bg-secondary/30 px-3 py-2 text-xs text-foreground transition-colors hover:border-warning/50 hover:bg-warning/10 hover:text-warning">撤销全部会话</button>{!isCurrentUser && user.status !== "pending_delete" && <button type="button" disabled={isDeleting} onClick={() => void deleteUser(user.userId, user.username)} className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive transition-colors hover:border-destructive/70 hover:bg-destructive/15 disabled:cursor-not-allowed disabled:opacity-60"><Trash2 className="size-3.5" /> {isDeleting ? "正在删除…" : "删除用户"}</button>}{!isCurrentUser && user.status === "pending_delete" && <button type="button" disabled={isDeleting} onClick={() => void purgeUser(user.userId, user.username)} className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-destructive/60 bg-destructive px-3 py-2 text-xs font-semibold text-destructive-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"><Trash2 className="size-3.5" /> {isDeleting ? "正在彻底删除…" : "彻底删除"}</button>}</footer></article>;
      })}</div>
    </>
  );
}

/** 声明式元数据插件管理页面。 */
export function AdminPluginsPage() {
  const resource = useApiResource(() => listPlugins(), []);
  const [message, setMessage] = useState<string | null>(null);
  /** 导入用户选择的插件包。 */
  async function selectPlugin(file: File | undefined): Promise<void> {
    if (!file) return;
    setMessage("正在导入并预检插件…");
    try { const plugin = await importPlugin(file); setMessage(`${plugin.displayName} ${plugin.version} 导入成功`); await resource.refresh(); } catch (error) { setMessage(error instanceof Error ? error.message : "插件导入失败"); }
  }
  return <><PageHeader title="插件管理" actions={<label className="glow-ring inline-flex cursor-pointer items-center gap-2 rounded-lg px-4 py-2.5 text-sm text-primary-foreground" style={{ backgroundImage: "var(--gradient-primary)" }}><Upload className="size-4" /> 导入插件<input type="file" accept=".flymby-plugin" className="hidden" onChange={(event) => void selectPlugin(event.target.files?.[0])} /></label>} />{message && <p className="mb-4 text-sm text-muted-foreground">{message}</p>}<div className="grid gap-4 lg:grid-cols-2">{resource.data?.items.map((plugin) => <article key={`${plugin.pluginId}@${plugin.version}`} className="surface p-5"><header className="flex items-start justify-between gap-3"><div><h2 className="text-sm font-semibold">{plugin.displayName}</h2><p className="mt-1 font-mono text-[11px] text-muted-foreground">{plugin.pluginId} · {plugin.version}</p></div><StatusPill tone={plugin.status === "enabled" ? "success" : "neutral"}>{plugin.status}</StatusPill></header><div className="mt-4 flex flex-wrap gap-2"><StatusPill tone="info">配置修订 r{plugin.configurationRevision}</StatusPill><StatusPill>SHA256 {plugin.sha256.slice(0, 12)}</StatusPill></div><footer className="mt-5"><button type="button" onClick={() => void updatePluginStatus(plugin, plugin.status !== "enabled").then(() => resource.refresh()).catch((error: unknown) => setMessage(error instanceof Error ? error.message : "插件状态修改失败"))} className="rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground">{plugin.status === "enabled" ? "停用" : "启用"}</button></footer></article>)}</div></>;
}

/** 超级管理员系统配置页面；Secret 只允许整组替换，不回显已有原文。 */
export function AdminConfigurationPage() {
  const resource = useApiResource(() => getAdminConfigStatus(), []);
  const [message, setMessage] = useState<string | null>(null);
  const [clearingTmdbCache, setClearingTmdbCache] = useState(false);

  /** 保存 Jellyfin 等外部协议使用的可选对外地址覆盖值。 */
  async function savePublicBaseUrl(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const publicBaseUrl = String(new FormData(event.currentTarget).get("publicBaseUrl") ?? "").trim();
    try {
      await updateAdminPublicBaseUrl(publicBaseUrl);
      setMessage(publicBaseUrl ? "Jellyfin 对外地址覆盖值已保存" : "地址覆盖值已清空，Jellyfin 将使用云助手 API 地址");
      await resource.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "公开访问地址保存失败"); }
  }

  /** 二次确认后使用表单中的完整列表替换 TMDB Key 池。 */
  async function saveTmdbKeys(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const formElement = event.currentTarget;
    const value = String(new FormData(formElement).get("tmdbKeys") ?? "");
    const keys = value
      .split(/[\r\n,]+/u)
      .map((key) => key.trim())
      .filter((key, index, values) => key.length > 0 && values.indexOf(key) === index);
    if (keys.length === 0) {
      setMessage("请输入至少一个 TMDB Key；如需删除全部 Key，请使用“清空全部 Key”按钮");
      return;
    }
    if (!window.confirm(`确定要使用当前输入的 ${keys.length} 个 Key 替换全部 TMDB Key 吗？`)) return;
    setMessage("正在加密保存并更新 TMDB Key 池…");
    try {
      await updateAdminTmdbKeys(keys);
      formElement.reset();
      setMessage(`TMDB Key 已更新，共 ${keys.length} 个`);
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "TMDB Key 保存失败");
    }
  }

  /** 二次确认后清空系统中保存的全部 TMDB Key。 */
  async function clearTmdbKeys(): Promise<void> {
    if (!window.confirm("确定要清空全部 TMDB Key 吗？清空后视频仍可扫描，但不能使用 TMDB 刮削。")) return;
    setMessage("正在清空 TMDB Key…");
    try {
      await updateAdminTmdbKeys([]);
      setMessage("全部 TMDB Key 已清空");
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "TMDB Key 清空失败");
    }
  }

  /** 二次确认后清空数据库、待写入队列和进程内的全部 TMDB 共享缓存。 */
  async function clearTmdbCache(): Promise<void> {
    if (clearingTmdbCache) return;
    if (!window.confirm("确定要删除全部 TMDB 缓存吗？删除后不会影响已经入库的影片；正在运行的任务仍会继续写入新缓存。")) return;
    setClearingTmdbCache(true);
    setMessage("正在删除 TMDB 缓存…");
    try {
      const result = await clearAdminTmdbCache();
      const clearedCount = result.deletedCount + result.discardedPendingCount;
      setMessage(`TMDB 缓存已删除，共清理 ${clearedCount.toLocaleString()} 条`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "TMDB 缓存删除失败");
    } finally {
      setClearingTmdbCache(false);
    }
  }

  return (
    <>
      <PageHeader title="系统配置" actions={<SecondaryButton onClick={() => void resource.refresh()}><RefreshCw className="size-4" /> 刷新状态</SecondaryButton>} />
      {message && <Panel className="mb-4"><p className="text-sm text-muted-foreground">{message}</p></Panel>}
      {resource.data && <Panel title="当前配置摘要" description="只显示数量和状态，不返回任何 Key 原文。"><SystemConfigurationSummary config={resource.data} /></Panel>}
      <Panel title="Jellyfin 公开地址（可选）" description="不填写时直接使用云助手 API 地址；填写后使用该地址生成 Jellyfin 对外服务地址。" className="mt-4">
        <form onSubmit={(event) => void savePublicBaseUrl(event)} className="flex flex-col gap-3 md:flex-row md:items-end">
          <label className="min-w-0 flex-1"><span className="text-xs font-medium">对外地址覆盖值（可选）</span><input name="publicBaseUrl" type="url" defaultValue={resource.data?.publicAccess.publicBaseUrl ?? ""} disabled={resource.data?.publicAccess.editable === false} placeholder="选填，例如 https://media.example.com" className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm disabled:opacity-60" /></label>
          <PrimaryButton type="submit" disabled={resource.data?.publicAccess.editable === false}><Save className="size-4" /> 保存地址</PrimaryButton>
        </form>
        <p className="mt-3 text-xs text-muted-foreground">作用：仅当使用反向代理、HTTPS 域名，或外部端口与云助手 API 实际地址不一致时填写。系统会在该地址后自动追加媒体库设置中的 /j/{`{自定义后缀}`}；清空不会影响 Jellyfin 的启用和访问。</p>
        <p className="mt-2 text-xs text-muted-foreground">配置来源：{resource.data?.publicAccess.source === "environment" ? "环境变量（控制台只读）" : resource.data?.publicAccess.source === "database" ? "数据库" : "未设置（使用云助手 API 地址）"}</p>
      </Panel>
      <Panel title="TMDB Key 配置" description="支持 API Key 或 Read Access Token；每行一个，也可以使用英文逗号分隔。" className="mt-4">
        <form onSubmit={(event) => void saveTmdbKeys(event)} className="grid gap-4">
          <label className="block">
            <span className="text-xs font-medium">完整新 Key 列表</span>
            <span className="mt-1 block text-[11px] text-muted-foreground">已有 Key 不会回显。保存后会整组替换，并立即更新后续刮削任务使用的 Key 池。</span>
            <textarea name="tmdbKeys" required autoComplete="off" spellCheck={false} placeholder="每行输入一个 TMDB Key 或 Read Access Token" className="mt-2 min-h-52 w-full rounded-lg border border-input bg-background/50 p-3 font-mono text-xs" />
          </label>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">单 Key 并发和部署总并发仍由运行参数控制，实际并发根据健康 Key 数动态变化。</p>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => void clearTmdbKeys()} disabled={(resource.data?.tmdb.configuredCount ?? 0) === 0} className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-2.5 text-sm text-destructive transition-colors hover:bg-destructive/15 disabled:cursor-not-allowed disabled:opacity-40"><Trash2 className="size-4" /> 清空全部 Key</button>
              <PrimaryButton type="submit"><Save className="size-4" /> 替换并保存</PrimaryButton>
            </div>
          </div>
        </form>
      </Panel>
      <Panel title="TMDB 缓存" description="删除当前部署中由所有用户和服务共用的 TMDB 元数据缓存。" className="mt-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">已经入库的媒体数据不会被删除；正在运行的任务仍会继续写入新缓存。</p>
          <button type="button" onClick={() => void clearTmdbCache()} disabled={clearingTmdbCache} className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-2.5 text-sm text-destructive transition-colors hover:bg-destructive/15 disabled:cursor-not-allowed disabled:opacity-40">
            <Trash2 className="size-4" /> {clearingTmdbCache ? "正在删除…" : "删除 TMDB 缓存"}
          </button>
        </div>
      </Panel>
    </>
  );
}

/** 系统配置和依赖脱敏状态页面。 */
export function AdminSystemPage() {
  const resource = useApiResource(async () => ({ status: await getAdminStatus(), config: await getAdminConfigStatus() }), []);
  return <><PageHeader title="系统状态" actions={<SecondaryButton onClick={() => void resource.refresh()}><RefreshCw className="size-4" /> 刷新</SecondaryButton>} />{resource.error && <Panel><p className="text-sm text-destructive">{resource.error}</p></Panel>}<div className="grid gap-4 xl:grid-cols-2">{resource.data ? <><Panel title="运行状态" description="实例、数据库、任务与媒体目录状态"><SystemRuntimeSummary status={resource.data.status} /></Panel><Panel title="配置状态" description="数据库、刮削源、凭据、插件与 Worker 配置"><SystemConfigurationSummary config={resource.data.config} /></Panel></> : <Panel className="xl:col-span-2"><p className="py-12 text-center text-sm text-muted-foreground">正在读取系统状态…</p></Panel>}</div></>;
}

/** 超级管理员脱敏审计日志页面。 */
export function AdminAuditPage() {
  const resource = useApiResource(() => listAuditEntries(), []);
  return <><PageHeader title="审计日志" actions={<SecondaryButton onClick={() => void resource.refresh()}><RefreshCw className="size-4" /> 刷新</SecondaryButton>} /><Panel><ul className="divide-y divide-border">{resource.data?.items.map((entry) => <li key={entry.id} className="flex items-center justify-between gap-3 py-3.5"><div className="min-w-0"><p className="truncate text-sm">{entry.operationType} · {entry.targetType}{entry.targetId ? ` ${entry.targetId}` : ""}</p><p className="mt-0.5 font-mono text-[11px] text-muted-foreground">{new Date(entry.createdAt).toLocaleString("zh-CN")} · {entry.operatorUsername ?? "系统"}</p></div><StatusPill tone={entry.result === "success" ? "success" : "danger"}>{entry.result}</StatusPill></li>)}</ul></Panel></>;
}
