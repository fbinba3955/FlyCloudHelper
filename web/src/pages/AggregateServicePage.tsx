import { Link } from "@tanstack/react-router";
import { Film, Layers3, LoaderCircle, Pencil, Plus, RefreshCw, ServerCog, Trash2, UserRound, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { PageHeader, PrimaryButton, SecondaryButton } from "@/components/ConsoleShell";
import { Panel, ProgressMeter, StatusPill } from "@/components/ui-kit";
import {
  createAggregateAccessAccount, createAggregateService, deleteAggregateAccessAccount,
  listAggregateAccessAccounts, listAggregateServices, listServices,
  updateAggregateAccessAccount, updateAggregateService,
  type AggregateAccessAccount, type AggregateProtocol, type AggregateService, type CloudService,
} from "@/lib/api";
import { useApiResource } from "@/lib/use-api-resource";
import { cn } from "@/lib/utils";

interface AggregateProtocolOption { id: AggregateProtocol; name: string; pathPrefix: string }

// 关键变量：一个聚合服务只对外暴露 Jellyfin 或 Emby 其中一种协议。
const aggregateProtocolOptions: AggregateProtocolOption[] = [
  { id: "jellyfin", name: "Jellyfin", pathPrefix: "/j/" },
  { id: "emby", name: "Emby", pathPrefix: "/e/" },
];
const providerTypeLabels: Record<string, string> = {
  webdav: "WebDAV", guangya: "光鸭", baidupan: "百度网盘", aliyundrive: "阿里云盘",
};

/** 返回聚合候选服务使用的简短 Provider 名称。 */
function getProviderLabel(service: CloudService): string {
  return providerTypeLabels[service.providerType] ?? service.providerType;
}

/** 返回聚合服务当前构建状态的中文显示。 */
function getAggregateStatus(service: AggregateService): { label: string; tone: "neutral" | "success" | "warning" | "danger" } {
  if (service.status === "active") return { label: "目录已就绪", tone: "success" };
  if (service.status === "building") return { label: "目录构建中", tone: "warning" };
  if (service.status === "failed") return { label: "构建失败", tone: "danger" };
  if (service.status === "disabled") return { label: "已停用", tone: "neutral" };
  return { label: "配置待构建", tone: "neutral" };
}

/** 显示一个可点击的协议配置开关。 */
function SettingSwitch(props: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <button type="button" aria-pressed={props.checked} onClick={() => props.onChange(!props.checked)} className="flex items-center justify-between gap-4 rounded-xl border border-border bg-secondary/35 p-4 text-left">
      <span className="text-sm font-medium">{props.label}</span>
      <span className={cn("relative h-7 w-12 shrink-0 rounded-full transition-colors", props.checked ? "bg-primary" : "bg-muted")}>
        <span className={cn("absolute top-1 size-5 rounded-full bg-white transition-transform", props.checked ? "translate-x-6" : "translate-x-1")} />
      </span>
    </button>
  );
}

/** 创建、编辑聚合服务并管理同一地址下的多个访问账号。 */
export function AggregateServicePage() {
  const serviceResource = useApiResource(() => listServices(false, { dataType: "video" }), []);
  const aggregateResource = useApiResource(() => listAggregateServices(), []);
  const [selectedServiceIds, setSelectedServiceIds] = useState<string[]>([]);
  const [selectedProtocol, setSelectedProtocol] = useState<AggregateProtocol>("jellyfin");
  const [displayName, setDisplayName] = useState("");
  const [pathSuffix, setPathSuffix] = useState("");
  const [relayPlaybackEnabled, setRelayPlaybackEnabled] = useState(false);
  const [downloadEnabled, setDownloadEnabled] = useState(true);
  const [regionLibrariesEnabled, setRegionLibrariesEnabled] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editingServiceId, setEditingServiceId] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<AggregateAccessAccount[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [accountSubmitting, setAccountSubmitting] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // 关键变量：同步拦截连续点击，避免状态更新前重复写入配置。
  const submitActionRef = useRef(false);

  const videoServices = useMemo(
    () => (serviceResource.data?.items ?? []).filter((service) => service.dataType === "video"),
    [serviceResource.data?.items],
  );
  const selectedServices = useMemo(
    () => videoServices.filter((service) => selectedServiceIds.includes(service.id)),
    [selectedServiceIds, videoServices],
  );
  const editingService = useMemo(
    () => (aggregateResource.data ?? []).find((service) => service.id === editingServiceId) ?? null,
    [aggregateResource.data, editingServiceId],
  );

  useEffect(() => {
    const availableIds = new Set(videoServices.map((service) => service.id));
    setSelectedServiceIds((current) => current.filter((serviceId) => availableIds.has(serviceId)));
  }, [videoServices]);

  useEffect(() => {
    const active = (aggregateResource.data ?? []).some((service) =>
      service.status === "building" || service.latestIndexJob?.status === "queued" || service.latestIndexJob?.status === "running");
    if (!active) return;
    const timer = window.setInterval(() => void aggregateResource.refresh(), 5_000);
    return () => window.clearInterval(timer);
  }, [aggregateResource.data, aggregateResource.refresh]);

  /** 清空表单并进入新增模式。 */
  function openCreateForm(): void {
    setEditingServiceId(null); setSelectedProtocol("jellyfin"); setDisplayName(""); setPathSuffix("");
    setSelectedServiceIds([]); setRelayPlaybackEnabled(false); setDownloadEnabled(true);
    setRegionLibrariesEnabled(false); setAccounts([]); setNewUsername(""); setNewPassword("");
    setFormOpen(true); setActionMessage(null); setActionError(null);
  }

  /** 把已创建聚合服务配置回填到顶部编辑面板。 */
  async function openEditForm(service: AggregateService): Promise<void> {
    setEditingServiceId(service.id); setSelectedProtocol(service.protocol); setDisplayName(service.displayName);
    setPathSuffix(service.pathSuffix); setSelectedServiceIds(service.members.map((member) => member.serviceId));
    setRelayPlaybackEnabled(service.relayPlaybackEnabled); setDownloadEnabled(service.downloadEnabled);
    setRegionLibrariesEnabled(service.regionLibrariesEnabled); setNewUsername(""); setNewPassword("");
    setFormOpen(true); setActionMessage(null); setActionError(null); setAccountsLoading(true);
    try { setAccounts(await listAggregateAccessAccounts(service.id)); }
    catch (error) { setActionError(error instanceof Error ? error.message : "访问账号读取失败"); }
    finally { setAccountsLoading(false); }
  }

  /** 切换一个影视来源的选中状态。 */
  function toggleService(serviceId: string): void {
    setSelectedServiceIds((current) => current.includes(serviceId)
      ? current.filter((id) => id !== serviceId) : [...current, serviceId]);
  }

  /** 创建或保存当前聚合服务配置。 */
  async function submitAggregateService(): Promise<void> {
    if (submitActionRef.current) return;
    const name = displayName.trim(); const suffix = pathSuffix.trim();
    if (!name) { setActionError("请输入聚合服务名称"); return; }
    if (!suffix) { setActionError("请输入协议地址后缀"); return; }
    if (selectedServiceIds.length < 2) { setActionError("至少选择两个影视服务进行聚合"); return; }
    submitActionRef.current = true; setSubmitting(true); setActionError(null); setActionMessage(null);
    try {
      const input = { displayName: name, pathSuffix: suffix, serviceIds: selectedServiceIds, relayPlaybackEnabled, downloadEnabled, regionLibrariesEnabled };
      const saved = editingServiceId
        ? await updateAggregateService(editingServiceId, input)
        : await createAggregateService({ ...input, protocol: selectedProtocol });
      setActionMessage(`已保存“${saved.displayName}”的配置`);
      await aggregateResource.refresh(); setFormOpen(false); setEditingServiceId(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "聚合服务保存失败";
      console.warn("codex-aggregate-service", { 事件: editingServiceId ? "网页修改聚合服务失败" : "网页创建聚合服务失败", 聚合协议: selectedProtocol, 来源服务数量: selectedServiceIds.length, 错误信息: message });
      setActionError(message);
    } finally { submitActionRef.current = false; setSubmitting(false); }
  }

  /** 为正在编辑的聚合地址添加一个独立账号。 */
  async function addAccount(): Promise<void> {
    if (!editingServiceId || accountSubmitting) return;
    if (newUsername.length < 4) { setActionError("访问用户名至少需要 4 个字符"); return; }
    setAccountSubmitting(true); setActionError(null);
    try {
      await createAggregateAccessAccount(editingServiceId, { username: newUsername, password: newPassword });
      setAccounts(await listAggregateAccessAccounts(editingServiceId));
      setNewUsername(""); setNewPassword(""); setActionMessage("访问账号已添加");
    } catch (error) { setActionError(error instanceof Error ? error.message : "访问账号创建失败"); }
    finally { setAccountSubmitting(false); }
  }

  /** 启用或停用账号，服务端确保至少保留一个启用账号。 */
  async function toggleAccount(account: AggregateAccessAccount): Promise<void> {
    if (!editingServiceId || accountSubmitting) return;
    setAccountSubmitting(true); setActionError(null);
    try {
      await updateAggregateAccessAccount(editingServiceId, account.id, { status: account.status === "active" ? "disabled" : "active" });
      setAccounts(await listAggregateAccessAccounts(editingServiceId));
    } catch (error) { setActionError(error instanceof Error ? error.message : "账号状态修改失败"); }
    finally { setAccountSubmitting(false); }
  }

  /** 二次确认后删除额外账号。 */
  async function removeAccount(account: AggregateAccessAccount): Promise<void> {
    if (!editingServiceId || accountSubmitting) return;
    if (!window.confirm(`确定删除访问账号“${account.username}”吗？该账号的现有登录会话也会失效。`)) return;
    setAccountSubmitting(true); setActionError(null);
    try {
      await deleteAggregateAccessAccount(editingServiceId, account.id);
      setAccounts(await listAggregateAccessAccounts(editingServiceId)); setActionMessage("访问账号已删除");
    } catch (error) { setActionError(error instanceof Error ? error.message : "访问账号删除失败"); }
    finally { setAccountSubmitting(false); }
  }

  return (
    <>
      <PageHeader title="聚合服务" actions={<div className="flex flex-wrap gap-2"><Link to="/app/catalog"><SecondaryButton>返回我的媒体库</SecondaryButton></Link><SecondaryButton onClick={() => void Promise.all([serviceResource.refresh(), aggregateResource.refresh()])}><RefreshCw className="size-4" /> 刷新</SecondaryButton><PrimaryButton disabled={formOpen && !editingServiceId} onClick={openCreateForm}><Plus className="size-4" /> 添加聚合服务</PrimaryButton></div>} />
      {(serviceResource.error || aggregateResource.error || actionError) && <Panel className="mb-4"><p className="text-sm text-destructive">{serviceResource.error ?? aggregateResource.error ?? actionError}</p></Panel>}
      {actionMessage && <Panel className="mb-4"><p className="text-sm text-success">{actionMessage}</p></Panel>}

      {formOpen && <Panel title={editingService ? `编辑 ${editingService.displayName}` : "添加聚合服务"} className="mb-4" action={<button type="button" onClick={() => { setFormOpen(false); setEditingServiceId(null); setActionError(null); }} aria-label="关闭聚合服务表单" className="rounded-lg border border-border p-2 text-muted-foreground hover:text-foreground"><X className="size-4" /></button>}>
        <div className="grid gap-4 md:grid-cols-2">
          <label className="grid gap-2 text-sm"><span className="text-xs font-medium">服务名称</span><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={100} className="rounded-lg border border-input bg-background/50 px-3.5 py-3 outline-none focus:border-foreground/45" /></label>
          <label className="grid gap-2 text-sm"><span className="text-xs font-medium">访问地址</span><span className="flex overflow-hidden rounded-lg border border-input bg-background/50"><span className="border-r border-border bg-background/35 px-3.5 py-2.5 font-mono text-muted-foreground">{selectedProtocol === "jellyfin" ? "/j/" : "/e/"}</span><input value={pathSuffix} onChange={(event) => setPathSuffix(event.target.value)} maxLength={64} className="min-w-0 flex-1 bg-transparent px-3.5 py-2.5 outline-none" /></span></label>
        </div>
        <div className="mt-5 border-t border-border pt-5"><h3 className="text-sm font-medium">聚合类型</h3><div className="mt-3 grid gap-3 sm:grid-cols-2">{aggregateProtocolOptions.map((protocol) => { const selected = selectedProtocol === protocol.id; return <button key={protocol.id} type="button" disabled={Boolean(editingServiceId)} onClick={() => setSelectedProtocol(protocol.id)} className={cn("flex items-center justify-between rounded-xl border p-4 text-left", selected ? "border-foreground/55 bg-secondary/35" : "border-border bg-secondary/35", editingServiceId && !selected && "opacity-45")}><span className="flex items-center gap-3"><ServerCog className="size-5 text-muted-foreground" /><span><span className="block font-medium">{protocol.name}</span><span className="font-mono text-xs text-muted-foreground">{protocol.pathPrefix}自定义后缀</span></span></span><StatusPill>{selected ? "已选择" : "未选择"}</StatusPill></button>; })}</div></div>
        <div className="mt-5 border-t border-border pt-5"><h3 className="text-sm font-medium">协议设置</h3><div className="mt-3 grid gap-3 md:grid-cols-3"><SettingSwitch label="服务中转播放" checked={relayPlaybackEnabled} onChange={setRelayPlaybackEnabled} /><SettingSwitch label="允许客户端下载" checked={downloadEnabled} onChange={setDownloadEnabled} /><SettingSwitch label="按地区拆分媒体库" checked={regionLibrariesEnabled} onChange={setRegionLibrariesEnabled} /></div></div>
        <div className="mt-5 border-t border-border pt-5"><div className="flex items-center justify-between"><h3 className="text-sm font-medium">选择影视服务</h3><StatusPill tone={selectedServices.length >= 2 ? "success" : "neutral"}>已选择 {selectedServices.length}</StatusPill></div><div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{videoServices.map((service) => { const selected = selectedServiceIds.includes(service.id); return <button key={service.id} type="button" onClick={() => toggleService(service.id)} className={cn("rounded-xl border p-4 text-left", selected ? "border-foreground/55 bg-secondary/35" : "border-border bg-secondary/35 hover:border-foreground/25")}><div className="flex items-start justify-between gap-3"><span className="flex min-w-0 items-center gap-3"><Film className="size-5 text-muted-foreground" /><span className="min-w-0"><span className="block truncate text-sm font-medium">{service.displayName}</span><span className="block truncate text-xs text-muted-foreground">{getProviderLabel(service)} · {service.itemCount.toLocaleString()} 项</span></span></span><StatusPill>{selected ? "已选择" : "未选择"}</StatusPill></div></button>; })}</div></div>
        {editingServiceId && <div className="mt-5 border-t border-border pt-5"><div className="flex items-center justify-between"><h3 className="text-sm font-medium">访问账号</h3><StatusPill>{accounts.length} 个</StatusPill></div><div className="mt-3 grid gap-3">{accountsLoading && <p className="text-sm text-muted-foreground">正在读取访问账号…</p>}{accounts.map((account) => <div key={account.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-secondary/35 p-4"><span className="flex items-center gap-3"><UserRound className="size-5 text-muted-foreground" /><span><span className="block text-sm font-medium">{account.username}</span><span className="block text-xs text-muted-foreground">{account.hasPassword ? "已设置密码" : "免密码"}</span></span></span><span className="flex items-center gap-2"><SecondaryButton disabled={accountSubmitting} onClick={() => void toggleAccount(account)}>{account.status === "active" ? "停用" : "启用"}</SecondaryButton><SecondaryButton disabled={accountSubmitting || accounts.length <= 1} onClick={() => void removeAccount(account)}><Trash2 className="size-4" /> 删除</SecondaryButton></span></div>)}</div><div className="mt-4 grid gap-3 md:grid-cols-[1fr_1fr_auto]"><input value={newUsername} onChange={(event) => setNewUsername(event.target.value)} placeholder="新用户名（至少 4 位）" maxLength={255} className="rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm outline-none" /><input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} placeholder="密码（留空为免密码）" className="rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm outline-none" /><PrimaryButton disabled={accountSubmitting || newUsername.length < 4} onClick={() => void addAccount()}><Plus className="size-4" /> 添加账号</PrimaryButton></div></div>}
        <div className="mt-5 flex justify-end gap-2 border-t border-border pt-5"><SecondaryButton disabled={submitting} onClick={() => { setFormOpen(false); setEditingServiceId(null); }}>取消</SecondaryButton><PrimaryButton disabled={submitting || selectedServices.length < 2 || !displayName.trim() || !pathSuffix.trim()} onClick={() => void submitAggregateService()}>{submitting ? <LoaderCircle className="size-4 animate-spin" /> : <Layers3 className="size-4" />}{submitting ? "正在保存" : "保存配置"}</PrimaryButton></div>
      </Panel>}

      {aggregateResource.loading && (aggregateResource.data?.length ?? 0) === 0 && <Panel><p className="py-12 text-center text-sm text-muted-foreground">正在读取聚合服务…</p></Panel>}
      {!aggregateResource.loading && (aggregateResource.data?.length ?? 0) === 0 && <Panel><div className="py-12 text-center"><Layers3 className="mx-auto size-10 text-muted-foreground" /><p className="mt-4 text-sm font-medium">尚未添加聚合服务</p></div></Panel>}
      <div className="grid gap-4 lg:grid-cols-2">{(aggregateResource.data ?? []).map((service) => { const status = getAggregateStatus(service); return <article key={service.id} className={cn("surface p-5", editingServiceId === service.id && "border-foreground/55")}><header className="flex items-start justify-between gap-3"><span className="flex min-w-0 items-center gap-3"><span className="flex size-10 items-center justify-center rounded-lg border border-border bg-background/55"><Layers3 className="size-5 text-muted-foreground" /></span><span className="min-w-0"><span className="block truncate text-sm font-semibold">{service.displayName}</span><span className="block font-mono text-[11px] text-muted-foreground">{service.path}</span></span></span><span className="flex flex-wrap justify-end gap-2"><StatusPill tone="info">{service.protocol === "jellyfin" ? "Jellyfin" : "Emby"}</StatusPill><StatusPill tone={status.tone}>{status.label}</StatusPill></span></header><dl className="mt-5 grid gap-3 text-xs sm:grid-cols-2"><div className="rounded-lg border border-border bg-secondary/40 p-3"><dt className="text-muted-foreground">来源服务</dt><dd className="mt-1 font-medium">{service.members.length}</dd></div><div className="rounded-lg border border-border bg-secondary/40 p-3"><dt className="text-muted-foreground">聚合条目</dt><dd className="mt-1 font-medium">{service.itemCount.toLocaleString()}</dd></div><div className="rounded-lg border border-border bg-secondary/40 p-3"><dt className="text-muted-foreground">播放方式</dt><dd className="mt-1 font-medium">{service.relayPlaybackEnabled ? "服务中转" : "原始地址"}</dd></div><div className="rounded-lg border border-border bg-secondary/40 p-3"><dt className="text-muted-foreground">客户端下载</dt><dd className="mt-1 font-medium">{service.downloadEnabled ? "允许" : "禁止"}</dd></div></dl>{service.latestIndexJob && ["queued", "running"].includes(service.latestIndexJob.status) && <div className="mt-4"><ProgressMeter value={service.latestIndexJob.processedCount} total={service.latestIndexJob.totalCount || null} /></div>}<div className="mt-5 flex justify-end border-t border-border pt-4"><SecondaryButton onClick={() => void openEditForm(service)}><Pencil className="size-4" /> 编辑</SecondaryButton></div></article>; })}</div>
    </>
  );
}
