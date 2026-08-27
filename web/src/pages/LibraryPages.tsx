import { Link } from "@tanstack/react-router";
import { Copy, Images, Pencil, Plus, Settings2, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { MediaCatalogView, type MediaCatalogQuery } from "@/components/MediaCatalogView";
import { PageHeader, PrimaryButton, SecondaryButton } from "@/components/ConsoleShell";
import { Panel, StatCard, StatusPill } from "@/components/ui-kit";
import {
  clearServiceCatalog,
  createServiceAccessAccount,
  deleteServiceAccessAccount,
  getService,
  getServiceAccessSettings,
  listAdminServiceItems,
  listLibraryItems,
  revokeServiceAccessAccountSessions,
  type ServiceAccessAccount,
  updateServiceAccessAccount,
  updateServiceJellyfinSettings,
  updateLibraryPlaybackSettings,
} from "@/lib/api";
import { useApiResource } from "@/lib/use-api-resource";

// 关键变量：单个媒体库海报墙每页读取 60 个顶层条目，避免一次加载完整目录。
const LIBRARY_CATALOG_PAGE_SIZE = 60;

/** 复制媒体库协议地址，并兼容未开放 Clipboard API 的浏览器。 */
async function copyLibraryText(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const temporaryInput = document.createElement("textarea");
    temporaryInput.value = value;
    temporaryInput.style.position = "fixed";
    temporaryInput.style.opacity = "0";
    document.body.appendChild(temporaryInput);
    temporaryInput.select();
    document.execCommand("copy");
    temporaryInput.remove();
  }
}

/** 集中管理单个媒体库的 Jellyfin 总开关、APP 播放和数据清理。 */
export function LibrarySettingsPage({ serviceId, admin = false }: { serviceId: string; admin?: boolean }) {
  const resource = useApiResource(async () => {
    const [service, settings] = await Promise.all([
      getService(serviceId, admin),
      getServiceAccessSettings(serviceId, admin),
    ]);
    return { service, settings };
  }, [serviceId, admin]);
  const [message, setMessage] = useState<string | null>(null);
  const [updatingJellyfin, setUpdatingJellyfin] = useState(false);
  const [updatingRelayPlayback, setUpdatingRelayPlayback] = useState(false);
  const [clearingCatalog, setClearingCatalog] = useState(false);
  // 关键变量：同步占用清空操作，避免按钮状态刷新前重复提交。
  const clearingCatalogRef = useRef(false);
  const service = resource.data?.service;
  const settings = resource.data?.settings;
  const catalogPath = admin ? "/admin/libraries/$serviceId/catalog" : "/app/libraries/$serviceId/catalog";
  const jellyfinPath = admin ? "/admin/libraries/$serviceId/jellyfin" : "/app/libraries/$serviceId/jellyfin";
  const librariesPath = admin ? "/admin/catalog" : "/app/catalog";

  /** 立即保存当前媒体库的 Jellyfin 协议开关。 */
  async function toggleJellyfin(): Promise<void> {
    if (!settings || updatingJellyfin) return;
    setUpdatingJellyfin(true);
    try {
      await updateServiceJellyfinSettings(serviceId, { jellyfinEnabled: !settings.jellyfinEnabled }, admin);
      setMessage(settings.jellyfinEnabled ? "Jellyfin 协议已关闭" : "Jellyfin 协议已启用");
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Jellyfin 设置保存失败");
    } finally {
      setUpdatingJellyfin(false);
    }
  }

  /** 独立保存 APP 专用中转播放开关。 */
  async function toggleAppRelayPlayback(): Promise<void> {
    if (!settings || updatingRelayPlayback) return;
    const nextEnabled = !settings.appRelayPlaybackEnabled;
    setUpdatingRelayPlayback(true);
    setMessage(`正在${nextEnabled ? "启用" : "关闭"} APP 专用中转播放…`);
    try {
      await updateLibraryPlaybackSettings(serviceId, { appRelayPlaybackEnabled: nextEnabled }, admin);
      setMessage(`APP 专用中转播放已${nextEnabled ? "启用" : "关闭"}`);
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "媒体库中转播放设置保存失败");
    } finally {
      setUpdatingRelayPlayback(false);
    }
  }

  /** 二次确认后清空媒体库中的扫描和刮削结果。 */
  async function clearCatalog(): Promise<void> {
    if (!service || clearingCatalogRef.current) return;
    if (!window.confirm(`确定清空“${service.displayName}”媒体库的全部内容吗？媒体条目、文件索引和目录版本将被清空，服务连接与扫描配置会保留。`)) return;
    clearingCatalogRef.current = true;
    setClearingCatalog(true);
    setMessage("正在清空当前媒体库…");
    try {
      await clearServiceCatalog(serviceId, admin);
      setMessage("媒体库已清空");
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "清空媒体库失败");
    } finally {
      clearingCatalogRef.current = false;
      setClearingCatalog(false);
    }
  }

  if (!service || !settings) {
    return <Panel><div className="py-16 text-center text-sm text-muted-foreground">{resource.error ?? "正在读取媒体库设置…"}</div></Panel>;
  }

  return (
    <>
      <PageHeader
        title={`${service.displayName} · 媒体库设置`}
        actions={(
          <div className="flex flex-wrap gap-2">
            <Link to={librariesPath}><SecondaryButton>返回媒体库</SecondaryButton></Link>
            <Link to={catalogPath} params={{ serviceId }}><PrimaryButton><Images className="size-4" /> 海报墙</PrimaryButton></Link>
          </div>
        )}
      />
      {message && <Panel className="mb-4"><p className="text-sm text-muted-foreground">{message}</p></Panel>}
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="媒体条目" value={service.itemCount.toLocaleString()} hint="当前已入库" />
        <StatCard label="目录版本" value={`v${service.catalogVersion}`} tone="info" />
        <StatCard label="Jellyfin" value={settings.jellyfinEnabled ? "已启用" : "未启用"} tone="muted" />
      </div>
      <Panel title="APP 专用播放" description="仅控制 Flymby 通过云助手媒体库播放时是否使用中转。" className="mt-4">
        <div className="rounded-xl border border-border bg-secondary/35 p-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">APP 专用中转播放</p>
              <p className="mt-1 text-xs text-muted-foreground">开启后，Flymby 的云助手媒体库播放流量会经过 FlyCloudHelper。</p>
            </div>
            <button type="button" role="switch" aria-checked={settings.appRelayPlaybackEnabled} aria-label="启用 APP 专用中转播放" disabled={(!settings.relayPlaybackSupported && !settings.appRelayPlaybackEnabled) || updatingRelayPlayback} onClick={() => void toggleAppRelayPlayback()} className={`relative h-7 w-12 shrink-0 rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${settings.appRelayPlaybackEnabled ? "border-primary bg-primary" : "border-border bg-secondary"}`}>
              <span className={`absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow-sm transition-transform ${settings.appRelayPlaybackEnabled ? "translate-x-5" : "translate-x-0"}`} />
            </button>
          </div>
        </div>
        {!settings.relayPlaybackSupported && <p className="mt-3 text-xs text-muted-foreground">当前网盘类型暂不支持中转播放。</p>}
      </Panel>
      <Panel title="Jellyfin 协议" className="mt-4">
        <div className="rounded-xl border border-border bg-secondary/35 p-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">启用 Jellyfin 协议</p>
              <p className="mt-1 text-xs text-muted-foreground">关闭后会撤销当前媒体库的 Jellyfin 会话，保留播放记录。</p>
            </div>
            <button type="button" role="switch" aria-checked={settings.jellyfinEnabled} aria-label="启用 Jellyfin 协议" disabled={updatingJellyfin} onClick={() => void toggleJellyfin()} className={`relative h-7 w-12 shrink-0 rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${settings.jellyfinEnabled ? "border-primary bg-primary" : "border-border bg-secondary"}`}>
              <span className={`absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow-sm transition-transform ${settings.jellyfinEnabled ? "translate-x-5" : "translate-x-0"}`} />
            </button>
          </div>
        </div>
      </Panel>
      <Panel title="媒体库工具" className="mt-4">
        <div className="flex flex-wrap gap-2">
          <Link to={jellyfinPath} params={{ serviceId }}><SecondaryButton><Settings2 className="size-4" /> Jellyfin 配置</SecondaryButton></Link>
        </div>
      </Panel>
      <Panel title="危险操作" className="mt-4">
        <button type="button" onClick={() => void clearCatalog()} disabled={service.status === "scanning" || clearingCatalog} className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-2.5 text-sm font-medium text-destructive transition-colors hover:bg-destructive/15 disabled:cursor-not-allowed disabled:opacity-40"><Trash2 className="size-4" /> {clearingCatalog ? "正在清空…" : "清空媒体库"}</button>
      </Panel>
    </>
  );
}

export function UserLibrarySettingsPage({ serviceId }: { serviceId: string }) { return <LibrarySettingsPage serviceId={serviceId} />; }
export function AdminLibrarySettingsPage({ serviceId }: { serviceId: string }) { return <LibrarySettingsPage serviceId={serviceId} admin />; }

/** 集中管理单个媒体库的 Jellyfin 中转、地区分组、地址和访问账号。 */
export function LibraryJellyfinSettingsPage({ serviceId, admin = false }: { serviceId: string; admin?: boolean }) {
  const resource = useApiResource(async () => {
    const [service, settings] = await Promise.all([
      getService(serviceId, admin),
      getServiceAccessSettings(serviceId, admin),
    ]);
    return { service, settings };
  }, [serviceId, admin]);
  const [message, setMessage] = useState<string | null>(null);
  const [updatingPlayback, setUpdatingPlayback] = useState(false);
  const [updatingRegionLibraries, setUpdatingRegionLibraries] = useState(false);
  const [savingJellyfinPath, setSavingJellyfinPath] = useState(false);
  const [jellyfinPathSuffix, setJellyfinPathSuffix] = useState("");
  const [showCreateAccount, setShowCreateAccount] = useState(false);
  const [newAccountUsername, setNewAccountUsername] = useState("");
  const [newAccountPassword, setNewAccountPassword] = useState("");
  const [editingAccountId, setEditingAccountId] = useState<string | null>(null);
  const [editingAccountUsername, setEditingAccountUsername] = useState("");
  const [editingAccountPassword, setEditingAccountPassword] = useState("");
  const [pendingAccountAction, setPendingAccountAction] = useState<string | null>(null);
  // 关键变量：账号操作同步写入引用，拦截 React 更新按钮状态之前的重复提交。
  const pendingAccountActionRef = useRef<string | null>(null);
  const service = resource.data?.service;
  const settings = resource.data?.settings;
  const settingsPath = admin ? "/admin/libraries/$serviceId/settings" : "/app/libraries/$serviceId/settings";

  useEffect(() => {
    if (settings?.jellyfinPathSuffix) setJellyfinPathSuffix(settings.jellyfinPathSuffix);
  }, [settings?.jellyfinPathSuffix]);

  /** 保存 Jellyfin 专用中转播放开关。 */
  async function toggleJellyfinRelayPlayback(): Promise<void> {
    if (!settings || updatingPlayback) return;
    const nextEnabled = !settings.jellyfinRelayPlaybackEnabled;
    setUpdatingPlayback(true);
    try {
      await updateLibraryPlaybackSettings(serviceId, { jellyfinRelayPlaybackEnabled: nextEnabled }, admin);
      setMessage(`Jellyfin 中转播放已${nextEnabled ? "启用" : "关闭"}`);
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Jellyfin 中转播放设置保存失败");
    } finally {
      setUpdatingPlayback(false);
    }
  }

  /** 保存 Jellyfin 节目地区媒体库开关。 */
  async function toggleRegionLibraries(): Promise<void> {
    if (!settings || updatingRegionLibraries) return;
    const nextEnabled = !settings.jellyfinRegionLibrariesEnabled;
    setUpdatingRegionLibraries(true);
    try {
      await updateServiceJellyfinSettings(serviceId, { jellyfinRegionLibrariesEnabled: nextEnabled }, admin);
      setMessage(nextEnabled ? "Jellyfin 节目地区分组已启用" : "Jellyfin 节目地区分组已关闭");
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Jellyfin 节目地区分组设置保存失败");
    } finally {
      setUpdatingRegionLibraries(false);
    }
  }

  /** 校验并保存固定 /j/ 前缀后的单层 Jellyfin 地址后缀。 */
  async function saveJellyfinPath(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!settings || savingJellyfinPath) return;
    const pathSuffix = jellyfinPathSuffix.trim();
    if (pathSuffix.length === 0 || Array.from(pathSuffix).length > 64) {
      setMessage("Jellyfin 地址后缀长度必须为 1 至 64 个字符");
      return;
    }
    if (!/^[\p{L}\p{N}_-]+$/u.test(pathSuffix)) {
      setMessage("Jellyfin 地址后缀只能包含文字、数字、短横线或下划线，且只能有一级");
      return;
    }
    if (pathSuffix === settings.jellyfinPathSuffix) {
      setMessage("Jellyfin 服务地址没有修改");
      return;
    }
    setSavingJellyfinPath(true);
    try {
      const nextSettings = await updateServiceJellyfinSettings(serviceId, { jellyfinPathSuffix: pathSuffix }, admin);
      setJellyfinPathSuffix(nextSettings.jellyfinPathSuffix);
      setMessage("Jellyfin 服务地址已保存");
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Jellyfin 服务地址保存失败");
    } finally {
      setSavingJellyfinPath(false);
    }
  }

  /** 占用全页账号操作槽，避免多个账号操作和刷新互相覆盖。 */
  function beginAccountAction(action: string): boolean {
    if (pendingAccountActionRef.current) return false;
    pendingAccountActionRef.current = action;
    setPendingAccountAction(action);
    return true;
  }

  /** 释放账号操作槽。 */
  function finishAccountAction(): void {
    pendingAccountActionRef.current = null;
    setPendingAccountAction(null);
  }

  /** 创建共享当前 Jellyfin 地址的新登录账号。 */
  async function createAccessAccount(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!settings || !beginAccountAction("create")) return;
    try {
      await createServiceAccessAccount(serviceId, {
        username: newAccountUsername,
        password: newAccountPassword,
      }, admin);
      setNewAccountUsername("");
      setNewAccountPassword("");
      setShowCreateAccount(false);
      setMessage("Jellyfin 账号已创建，可使用同一个服务地址登录");
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "创建 Jellyfin 账号失败");
    } finally {
      finishAccountAction();
    }
  }

  /** 打开指定账号的用户名和密码编辑区。 */
  function beginEditAccount(account: ServiceAccessAccount): void {
    setEditingAccountId(account.id);
    setEditingAccountUsername(account.username);
    setEditingAccountPassword("");
  }

  /** 保存指定 Jellyfin 账号的用户名和可选新密码。 */
  async function saveAccessAccount(event: FormEvent<HTMLFormElement>, account: ServiceAccessAccount): Promise<void> {
    event.preventDefault();
    if (!settings || !beginAccountAction(`save:${account.id}`)) return;
    const input: { username?: string; password?: string } = {};
    if (editingAccountUsername !== account.username) input.username = editingAccountUsername;
    // 关键变量：编辑时密码留空表示不修改，避免仅改用户名时意外清空现有密码。
    if (editingAccountPassword.length > 0) input.password = editingAccountPassword;
    if (input.username === undefined && input.password === undefined) {
      setMessage("访问用户名和密码均未修改");
      finishAccountAction();
      return;
    }
    try {
      await updateServiceAccessAccount(serviceId, account.id, input, admin);
      setEditingAccountId(null);
      setEditingAccountPassword("");
      setMessage(`账号“${editingAccountUsername}”已保存，原登录会话已撤销`);
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Jellyfin 访问凭据保存失败");
    } finally {
      finishAccountAction();
    }
  }

  /** 将指定账号改为免密码登录，同时撤销其旧会话。 */
  async function clearAccessAccountPassword(account: ServiceAccessAccount): Promise<void> {
    if (!account.hasPassword || !window.confirm(`确定把账号“${account.username}”改为免密码登录吗？`)) return;
    if (!beginAccountAction(`passwordless:${account.id}`)) return;
    try {
      await updateServiceAccessAccount(serviceId, account.id, { password: "" }, admin);
      setMessage(`账号“${account.username}”已改为免密码登录`);
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "切换免密码登录失败");
    } finally {
      finishAccountAction();
    }
  }

  /** 启用或停用指定账号，停用前需要二次确认。 */
  async function toggleAccessAccountStatus(account: ServiceAccessAccount): Promise<void> {
    const nextStatus = account.status === "active" ? "disabled" : "active";
    if (nextStatus === "disabled" && !window.confirm(`确定停用账号“${account.username}”吗？该账号现有 Jellyfin 会话会被撤销。`)) return;
    if (!beginAccountAction(`status:${account.id}`)) return;
    try {
      await updateServiceAccessAccount(serviceId, account.id, { status: nextStatus }, admin);
      setMessage(`账号“${account.username}”已${nextStatus === "active" ? "启用" : "停用"}`);
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "修改 Jellyfin 账号状态失败");
    } finally {
      finishAccountAction();
    }
  }

  /** 二次确认后只撤销指定账号的 Jellyfin 会话。 */
  async function revokeAccessAccountSessions(account: ServiceAccessAccount): Promise<void> {
    if (!window.confirm(`确定撤销账号“${account.username}”的全部 Jellyfin 会话吗？观看记录不会删除。`)) return;
    if (!beginAccountAction(`sessions:${account.id}`)) return;
    try {
      const result = await revokeServiceAccessAccountSessions(serviceId, account.id, admin);
      setMessage(`账号“${account.username}”已撤销 ${result.revokedCount} 个会话`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Jellyfin 会话撤销失败");
    } finally {
      finishAccountAction();
    }
  }

  /** 二次确认后删除账号及其独立观看记录。 */
  async function deleteAccessAccount(account: ServiceAccessAccount): Promise<void> {
    if (!window.confirm(`确定删除账号“${account.username}”吗？该账号的会话、观看进度和播放历史都会删除，此操作无法撤销。`)) return;
    if (!beginAccountAction(`delete:${account.id}`)) return;
    try {
      await deleteServiceAccessAccount(serviceId, account.id, admin);
      if (editingAccountId === account.id) setEditingAccountId(null);
      setMessage(`账号“${account.username}”及其独立观看记录已删除`);
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "删除 Jellyfin 账号失败");
    } finally {
      finishAccountAction();
    }
  }

  if (!service || !settings) {
    return <Panel><div className="py-16 text-center text-sm text-muted-foreground">{resource.error ?? "正在读取 Jellyfin 配置…"}</div></Panel>;
  }
  const jellyfinAddress = settings.jellyfinUrl ?? `云助手 API 地址${settings.jellyfinPath}`;
  // 关键变量：旧服务响应没有 accounts 时仍把历史单账号作为列表中的第一个账号显示。
  const accessAccounts = settings.accounts?.length > 0 ? settings.accounts : [settings.account];
  const activeAccountCount = accessAccounts.filter((account) => account.status === "active").length;
  return (
    <>
      <PageHeader title={`${service.displayName} · Jellyfin 配置`} actions={<Link to={settingsPath} params={{ serviceId }}><SecondaryButton>返回媒体库设置</SecondaryButton></Link>} />
      {message && <Panel className="mb-4"><p className="text-sm text-muted-foreground">{message}</p></Panel>}
      <Panel title="播放设置" description="仅影响通过 Jellyfin 协议播放，和 APP 专用播放设置互不影响。">
        <div className="rounded-xl border border-border bg-secondary/35 p-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">Jellyfin 中转播放</p>
              <p className="mt-1 text-xs text-muted-foreground">开启后，Jellyfin 自动模式可在原始地址不可用时通过 FlyCloudHelper 播放。</p>
            </div>
            <button type="button" role="switch" aria-checked={settings.jellyfinRelayPlaybackEnabled} aria-label="启用 Jellyfin 中转播放" disabled={(!settings.relayPlaybackSupported && !settings.jellyfinRelayPlaybackEnabled) || updatingPlayback} onClick={() => void toggleJellyfinRelayPlayback()} className={`relative h-7 w-12 shrink-0 rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${settings.jellyfinRelayPlaybackEnabled ? "border-primary bg-primary" : "border-border bg-secondary"}`}>
              <span className={`absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow-sm transition-transform ${settings.jellyfinRelayPlaybackEnabled ? "translate-x-5" : "translate-x-0"}`} />
            </button>
          </div>
        </div>
        {!settings.relayPlaybackSupported && <p className="mt-3 text-xs text-muted-foreground">当前网盘类型暂不支持中转播放。</p>}
      </Panel>
      <Panel title="媒体库分类" className="mt-4">
        <div className="rounded-xl border border-border bg-secondary/35 p-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">节目按地区分组</p>
              <p className="mt-1 text-xs text-muted-foreground">关闭时返回“电影、节目”；开启后节目拆分为“华语、日韩、欧美、其他”，电影不拆分。</p>
            </div>
            <button type="button" role="switch" aria-checked={settings.jellyfinRegionLibrariesEnabled} aria-label="启用 Jellyfin 节目地区分组" disabled={updatingRegionLibraries} onClick={() => void toggleRegionLibraries()} className={`relative h-7 w-12 shrink-0 rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${settings.jellyfinRegionLibrariesEnabled ? "border-primary bg-primary" : "border-border bg-secondary"}`}>
              <span className={`absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow-sm transition-transform ${settings.jellyfinRegionLibrariesEnabled ? "translate-x-5" : "translate-x-0"}`} />
            </button>
          </div>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">已有节目没有地区数据时归入“其他节目”；后续正常扫描会按刮削结果更新，不增加单独的地区补全任务。</p>
      </Panel>
      <Panel title="服务地址" className="mt-4">
        <div className="rounded-xl border border-border bg-secondary/35 p-4">
          <form onSubmit={(event) => void saveJellyfinPath(event)}>
            <p className="text-xs text-muted-foreground">Jellyfin 服务地址</p>
            <div className="mt-2 flex flex-col gap-2 md:flex-row">
              <div className="flex min-w-0 flex-1 overflow-hidden rounded-lg border border-input bg-background/50">
                <span className="flex shrink-0 items-center border-r border-border bg-secondary/60 px-3 font-mono text-sm text-muted-foreground">/j/</span>
                <input value={jellyfinPathSuffix} maxLength={64} onChange={(event) => setJellyfinPathSuffix(event.target.value)} aria-label="Jellyfin 地址后缀" className="min-w-0 flex-1 bg-transparent px-3 py-2.5 font-mono text-sm outline-none" />
              </div>
              <PrimaryButton type="submit" disabled={savingJellyfinPath}><Settings2 className="size-4" /> {savingJellyfinPath ? "正在保存…" : "保存地址"}</PrimaryButton>
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">固定前缀不可修改；后缀在全部媒体库中不能重复，只支持文字、数字、短横线或下划线，不能包含多级路径。</p>
          </form>
          <div className="mt-3 flex items-start justify-between gap-3 border-t border-border pt-3">
            <p className="min-w-0 break-all font-mono text-xs">{jellyfinAddress}</p>
            <SecondaryButton type="button" onClick={() => void copyLibraryText(settings.jellyfinUrl ?? settings.jellyfinPath).then(() => setMessage(settings.jellyfinUrl ? "Jellyfin 服务地址已复制" : "Jellyfin 服务路径已复制"))}><Copy className="size-4" /> 复制</SecondaryButton>
          </div>
        </div>
      </Panel>
      <Panel
        title="Jellyfin 账号"
        description={`共 ${accessAccounts.length} 个账号，共享同一个服务地址，观看记录按账号独立保存。`}
        className="mt-4"
        action={<SecondaryButton type="button" disabled={pendingAccountAction !== null} onClick={() => setShowCreateAccount((value) => !value)}><Plus className="size-4" /> 添加账号</SecondaryButton>}
      >
        {showCreateAccount && (
          <form onSubmit={(event) => void createAccessAccount(event)} className="mb-4 grid gap-3 rounded-xl border border-border bg-secondary/35 p-4 md:grid-cols-2">
            <label><span className="text-xs text-muted-foreground">新账号用户名</span><input value={newAccountUsername} required minLength={4} maxLength={255} onChange={(event) => setNewAccountUsername(event.target.value)} className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm" /></label>
            <label><span className="text-xs text-muted-foreground">登录密码（可选）</span><input value={newAccountPassword} type="password" autoComplete="new-password" placeholder="留空则无需密码" onChange={(event) => setNewAccountPassword(event.target.value)} className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm" /></label>
            <div className="flex flex-wrap gap-2 md:col-span-2">
              <PrimaryButton type="submit" disabled={pendingAccountAction !== null}><Plus className="size-4" /> {pendingAccountAction === "create" ? "正在创建…" : "创建账号"}</PrimaryButton>
              <SecondaryButton type="button" disabled={pendingAccountAction !== null} onClick={() => setShowCreateAccount(false)}>取消</SecondaryButton>
            </div>
          </form>
        )}
        <div className="space-y-3">
          {accessAccounts.map((account, index) => {
            const editing = editingAccountId === account.id;
            const accountPending = pendingAccountAction?.endsWith(account.id) ?? false;
            return (
              <article key={account.id} className="rounded-xl border border-border bg-secondary/35 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-sm font-medium">{account.username}</p>
                      <StatusPill tone={account.status === "active" ? "success" : "neutral"}>{account.status === "active" ? "已启用" : "已停用"}</StatusPill>
                    </div>
                    <p className="mt-1 text-[11px] text-muted-foreground">{index === 0 ? "第一个账号 · " : ""}{account.hasPassword ? "需要密码" : "免密码"} · 凭据 r{account.credentialRevision}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <SecondaryButton type="button" disabled={pendingAccountAction !== null} onClick={() => beginEditAccount(account)}><Pencil className="size-4" /> 编辑</SecondaryButton>
                    <SecondaryButton type="button" disabled={pendingAccountAction !== null} onClick={() => void revokeAccessAccountSessions(account)}>撤销会话</SecondaryButton>
                    <SecondaryButton type="button" disabled={pendingAccountAction !== null || (account.status === "active" && activeAccountCount <= 1)} onClick={() => void toggleAccessAccountStatus(account)}>{account.status === "active" ? "停用" : "启用"}</SecondaryButton>
                    <button type="button" disabled={pendingAccountAction !== null || accessAccounts.length <= 1} onClick={() => void deleteAccessAccount(account)} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-destructive/40 bg-destructive/8 px-3 py-2 text-xs text-destructive transition-colors hover:bg-destructive/15 disabled:cursor-not-allowed disabled:opacity-40"><Trash2 className="size-3.5" /> {accountPending && pendingAccountAction?.startsWith("delete:") ? "正在删除…" : "删除"}</button>
                  </div>
                </div>
                {editing && (
                  <form onSubmit={(event) => void saveAccessAccount(event, account)} className="mt-4 grid gap-3 border-t border-border pt-4 md:grid-cols-2">
                    <label><span className="text-xs text-muted-foreground">访问用户名</span><input value={editingAccountUsername} required minLength={4} maxLength={255} onChange={(event) => setEditingAccountUsername(event.target.value)} className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm" /></label>
                    <label><span className="text-xs text-muted-foreground">新密码</span><input value={editingAccountPassword} type="password" autoComplete="new-password" placeholder="留空表示不修改" onChange={(event) => setEditingAccountPassword(event.target.value)} className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm" /></label>
                    <div className="flex flex-wrap gap-2 md:col-span-2">
                      <PrimaryButton type="submit" disabled={pendingAccountAction !== null}><Settings2 className="size-4" /> {accountPending && pendingAccountAction?.startsWith("save:") ? "正在保存…" : "保存账号"}</PrimaryButton>
                      {account.hasPassword && <SecondaryButton type="button" disabled={pendingAccountAction !== null} onClick={() => void clearAccessAccountPassword(account)}>改为免密码</SecondaryButton>}
                      <SecondaryButton type="button" disabled={pendingAccountAction !== null} onClick={() => setEditingAccountId(null)}>取消</SecondaryButton>
                    </div>
                  </form>
                )}
              </article>
            );
          })}
        </div>
      </Panel>
    </>
  );
}

export function UserLibraryJellyfinSettingsPage({ serviceId }: { serviceId: string }) { return <LibraryJellyfinSettingsPage serviceId={serviceId} />; }
export function AdminLibraryJellyfinSettingsPage({ serviceId }: { serviceId: string }) { return <LibraryJellyfinSettingsPage serviceId={serviceId} admin />; }

/** 展示固定单一媒体库作用域的海报墙。 */
export function LibraryCatalogPage({ serviceId, admin = false }: { serviceId: string; admin?: boolean }) {
  const [catalogQuery, setCatalogQuery] = useState<MediaCatalogQuery>({
    search: "",
    mediaType: "all",
    videoItemType: "all",
    matchState: "matched",
    sort: "created_desc",
  });
  const [pageOffset, setPageOffset] = useState(0);
  const resource = useApiResource(async () => {
    const service = await getService(serviceId, admin);
    const options = {
      search: catalogQuery.search || undefined,
      mediaType: catalogQuery.mediaType === "all" ? undefined : catalogQuery.mediaType,
      itemType: catalogQuery.videoItemType === "all" ? undefined : catalogQuery.videoItemType,
      matchState: catalogQuery.matchState === "all" ? undefined : catalogQuery.matchState,
      sort: catalogQuery.sort,
      limit: LIBRARY_CATALOG_PAGE_SIZE,
      offset: pageOffset,
    };
    const catalog = admin
      ? await listAdminServiceItems(serviceId, options)
      : await listLibraryItems(service.libraryId, options);
    return { service, catalog };
  }, [serviceId, admin, catalogQuery.search, catalogQuery.mediaType, catalogQuery.videoItemType, catalogQuery.matchState, catalogQuery.sort, pageOffset]);

  /** 筛选变化后回到第一页，相同筛选不触发重复请求。 */
  const updateCatalogQuery = useCallback((nextQuery: MediaCatalogQuery): void => {
    setCatalogQuery((currentQuery) => {
      const unchanged = currentQuery.search === nextQuery.search
        && currentQuery.mediaType === nextQuery.mediaType
        && currentQuery.videoItemType === nextQuery.videoItemType
        && currentQuery.matchState === nextQuery.matchState
        && currentQuery.sort === nextQuery.sort;
      return unchanged ? currentQuery : nextQuery;
    });
    setPageOffset(0);
  }, []);

  if (!resource.data) {
    return <Panel><div className="py-16 text-center text-sm text-muted-foreground">{resource.error ?? "正在读取媒体库海报墙…"}</div></Panel>;
  }
  const { service, catalog } = resource.data;
  const librariesPath = admin ? "/admin/catalog" : "/app/catalog";
  const settingsPath = admin ? "/admin/libraries/$serviceId/settings" : "/app/libraries/$serviceId/settings";
  return (
    <>
      <PageHeader title={`${service.displayName} · 海报墙`} actions={<div className="flex flex-wrap gap-2"><Link to={librariesPath}><SecondaryButton>返回媒体库</SecondaryButton></Link><Link to={settingsPath} params={{ serviceId }}><SecondaryButton>媒体库设置</SecondaryButton></Link></div>} />
      {resource.error && <Panel className="mb-4"><p className="text-sm text-destructive">{resource.error}</p></Panel>}
      <MediaCatalogView contextDescription={`${admin ? `用户 ${service.ownerUsername} · ` : ""}${service.displayName} · ${service.libraryId}`} items={catalog.items} total={catalog.total} catalogVersion={service.catalogVersion} fixedService showOwner={admin} admin={admin} loading={resource.loading} onRefresh={() => void resource.refresh()} serverFiltered pageOffset={pageOffset} pageLimit={LIBRARY_CATALOG_PAGE_SIZE} onQueryChange={updateCatalogQuery} onPageChange={setPageOffset} />
    </>
  );
}

export function UserLibraryCatalogPage({ serviceId }: { serviceId: string }) { return <LibraryCatalogPage serviceId={serviceId} />; }
export function AdminLibraryCatalogPage({ serviceId }: { serviceId: string }) { return <LibraryCatalogPage serviceId={serviceId} admin />; }
