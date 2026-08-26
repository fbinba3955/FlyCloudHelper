import { Link } from "@tanstack/react-router";
import { Copy, Images, Settings2, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { MediaCatalogView, type MediaCatalogQuery } from "@/components/MediaCatalogView";
import { PageHeader, PrimaryButton, SecondaryButton } from "@/components/ConsoleShell";
import { Panel, StatCard, StatusPill } from "@/components/ui-kit";
import {
  clearServiceCatalog,
  getService,
  getServiceAccessSettings,
  listAdminServiceItems,
  listLibraryItems,
  revokeServiceAccessSessions,
  updateServiceAccessCredentials,
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
  const [accessUsername, setAccessUsername] = useState("");
  const [newAccessPassword, setNewAccessPassword] = useState("");
  const service = resource.data?.service;
  const settings = resource.data?.settings;
  const settingsPath = admin ? "/admin/libraries/$serviceId/settings" : "/app/libraries/$serviceId/settings";

  useEffect(() => {
    if (settings?.account.username) setAccessUsername(settings.account.username);
  }, [settings?.account.username]);

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

  /** 保存媒体库的 Jellyfin 访问用户名和可选密码。 */
  async function saveAccessCredentials(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!settings) return;
    const input: { username?: string; password?: string } = {};
    if (accessUsername !== settings.account.username) input.username = accessUsername;
    // 关键变量：已有密码时保存空值表示切换为免密码；默认免密码时空输入不重复提交。
    if (newAccessPassword.length > 0 || settings.account.hasPassword) input.password = newAccessPassword;
    if (input.username === undefined && input.password === undefined) {
      setMessage("访问用户名和密码均未修改");
      return;
    }
    try {
      await updateServiceAccessCredentials(serviceId, input, admin);
      setNewAccessPassword("");
      setMessage(newAccessPassword.length > 0 ? "Jellyfin 访问凭据已保存" : "Jellyfin 已改为免密码登录");
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Jellyfin 访问凭据保存失败");
    }
  }

  /** 二次确认后撤销当前媒体库的全部 Jellyfin 会话。 */
  async function revokeAccessSessions(): Promise<void> {
    if (!window.confirm("确定撤销当前媒体库的全部 Jellyfin 会话吗？播放记录不会删除。")) return;
    try {
      const result = await revokeServiceAccessSessions(serviceId, admin);
      setMessage(`已撤销 ${result.revokedCount} 个 Jellyfin 会话`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Jellyfin 会话撤销失败");
    }
  }

  if (!service || !settings) {
    return <Panel><div className="py-16 text-center text-sm text-muted-foreground">{resource.error ?? "正在读取 Jellyfin 配置…"}</div></Panel>;
  }
  const jellyfinAddress = settings.jellyfinUrl ?? `云助手 API 地址${settings.jellyfinPath}`;
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
      <Panel title="服务地址与账号" className="mt-4">
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
          <form onSubmit={(event) => void saveAccessCredentials(event)} className="mt-4 grid gap-3 border-t border-border pt-4 md:grid-cols-2">
            <label><span className="text-xs text-muted-foreground">访问用户名</span><input value={accessUsername} minLength={4} maxLength={255} onChange={(event) => setAccessUsername(event.target.value)} className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm" /></label>
            <label><span className="text-xs text-muted-foreground">访问密码（可选，默认免密码）</span><input value={newAccessPassword} type="password" autoComplete="new-password" placeholder={settings.account.hasPassword ? "留空保存可切换为免密码" : "当前无需密码"} onChange={(event) => setNewAccessPassword(event.target.value)} className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm" /></label>
            <div className="flex flex-wrap gap-2 md:col-span-2">
              <PrimaryButton type="submit"><Settings2 className="size-4" /> 保存访问设置</PrimaryButton>
              <SecondaryButton type="button" onClick={() => void revokeAccessSessions()}>撤销全部会话</SecondaryButton>
            </div>
          </form>
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
