import { Link } from "@tanstack/react-router";
import { Copy, Pencil, Plus, Settings2, Trash2 } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { PageHeader, PrimaryButton, SecondaryButton } from "@/components/ConsoleShell";
import { Panel, StatusPill } from "@/components/ui-kit";
import {
  createServiceEmbyAccount,
  deleteServiceEmbyAccount,
  getService,
  getServiceAccessSettings,
  revokeServiceEmbyAccountSessions,
  updateLibraryPlaybackSettings,
  updateServiceEmbyAccount,
  updateServiceEmbySettings,
} from "@/lib/api";
import { useApiResource } from "@/lib/use-api-resource";

/** 复制 Emby 服务地址，并兼容不支持 Clipboard API 的浏览器。 */
async function copyEmbyAddress(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const input = document.createElement("textarea");
    input.value = value;
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.appendChild(input);
    input.select();
    document.execCommand("copy");
    input.remove();
  }
}

/** 管理单个媒体库的独立 Emby 播放、地区分组、地址和多账号。 */
export function LibraryEmbySettingsPage({ serviceId, admin = false }: { serviceId: string; admin?: boolean }) {
  const resource = useApiResource(async () => {
    const [service, settings] = await Promise.all([getService(serviceId, admin), getServiceAccessSettings(serviceId, admin)]);
    return { service, settings };
  }, [serviceId, admin]);
  const [message, setMessage] = useState<string | null>(null);
  const [pathSuffix, setPathSuffix] = useState("");
  const [saving, setSaving] = useState(false);
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [creating, setCreating] = useState(false);
  const [editingAccountId, setEditingAccountId] = useState<string | null>(null);
  const [editingUsername, setEditingUsername] = useState("");
  const [editingPassword, setEditingPassword] = useState("");
  // 关键变量：账号相关操作串行执行，防止刷新前重复修改同一份 Emby 用户状态。
  const [accountAction, setAccountAction] = useState<string | null>(null);
  const service = resource.data?.service;
  const settings = resource.data?.settings;
  const settingsPath = admin ? "/admin/libraries/$serviceId/settings" : "/app/libraries/$serviceId/settings";

  useEffect(() => { if (settings?.embyPathSuffix) setPathSuffix(settings.embyPathSuffix); }, [settings?.embyPathSuffix]);

  /** 保存一个布尔型 Emby 子配置，刷新后避免页面持有过期状态。 */
  async function saveEmbySwitch(key: "embyDownloadEnabled" | "embyRegionLibrariesEnabled", title: string): Promise<void> {
    if (!settings || saving) return;
    setSaving(true);
    try {
      await updateServiceEmbySettings(serviceId, { [key]: !settings[key] }, admin);
      setMessage(`${title}已${settings[key] ? "关闭" : "启用"}`);
      await resource.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : `${title}保存失败`); } finally { setSaving(false); }
  }

  /** 保存 Emby 专用的中转播放开关。 */
  async function toggleRelay(): Promise<void> {
    if (!settings || saving) return;
    setSaving(true);
    try {
      await updateLibraryPlaybackSettings(serviceId, { embyRelayPlaybackEnabled: !settings.embyRelayPlaybackEnabled }, admin);
      setMessage(`Emby 中转播放已${settings.embyRelayPlaybackEnabled ? "关闭" : "启用"}`);
      await resource.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Emby 中转播放保存失败"); } finally { setSaving(false); }
  }

  /** 校验并保存固定 /e/ 后的 Emby 服务地址后缀。 */
  async function savePath(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const value = pathSuffix.trim();
    if (!/^[\p{L}\p{N}_-]{1,64}$/u.test(value)) { setMessage("Emby 地址后缀只能包含文字、数字、短横线或下划线，长度为 1 至 64 个字符"); return; }
    if (saving) return;
    setSaving(true);
    try {
      await updateServiceEmbySettings(serviceId, { embyPathSuffix: value }, admin);
      setMessage("Emby 服务地址已保存");
      await resource.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Emby 服务地址保存失败"); } finally { setSaving(false); }
  }

  /** 新建与 Jellyfin 完全隔离的 Emby 访问账号。 */
  async function createAccount(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (creating) return;
    setCreating(true);
    try {
      await createServiceEmbyAccount(serviceId, { username: newUsername, password: newPassword }, admin);
      setNewUsername(""); setNewPassword(""); setMessage("Emby 访问账号已创建");
      await resource.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "创建 Emby 账号失败"); } finally { setCreating(false); }
  }

  /** 删除一个 Emby 账号及其 Emby 独立状态，不会触碰 Jellyfin 数据。 */
  async function deleteAccount(accountId: string, username: string): Promise<void> {
    if (accountAction) return;
    if (!window.confirm(`确定删除 Emby 账号“${username}”吗？其 Emby 收藏、观看进度和播放历史会一并删除。`)) return;
    setAccountAction(`delete:${accountId}`);
    try {
      await deleteServiceEmbyAccount(serviceId, accountId, admin);
      if (editingAccountId === accountId) setEditingAccountId(null);
      setMessage(`Emby 账号“${username}”已删除`);
      await resource.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "删除 Emby 账号失败"); } finally { setAccountAction(null); }
  }

  /** 打开账号凭据编辑区；密码留空时表示保持现有密码不变。 */
  function beginEditAccount(account: { id: string; username: string }): void {
    setEditingAccountId(account.id);
    setEditingUsername(account.username);
    setEditingPassword("");
  }

  /** 保存 Emby 用户名和可选新密码，保存后由服务端撤销该账号旧会话。 */
  async function saveAccount(event: FormEvent<HTMLFormElement>, account: { id: string; username: string }): Promise<void> {
    event.preventDefault();
    if (accountAction) return;
    const input: { username?: string; password?: string } = {};
    if (editingUsername !== account.username) input.username = editingUsername;
    if (editingPassword.length > 0) input.password = editingPassword;
    if (input.username === undefined && input.password === undefined) { setMessage("账号凭据没有修改"); return; }
    setAccountAction(`save:${account.id}`);
    try {
      await updateServiceEmbyAccount(serviceId, account.id, input, admin);
      setEditingAccountId(null);
      setEditingPassword("");
      setMessage(`Emby 账号“${editingUsername}”已保存，旧会话已撤销`);
      await resource.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "保存 Emby 账号失败"); } finally { setAccountAction(null); }
  }

  /** 将有密码账号切换为免密码登录，规则与 Jellyfin 协议账号保持一致。 */
  async function clearAccountPassword(account: { id: string; username: string; hasPassword: boolean }): Promise<void> {
    if (!account.hasPassword || accountAction || !window.confirm(`确定把 Emby 账号“${account.username}”改为免密码登录吗？`)) return;
    setAccountAction(`passwordless:${account.id}`);
    try {
      await updateServiceEmbyAccount(serviceId, account.id, { password: "" }, admin);
      setMessage(`Emby 账号“${account.username}”已改为免密码登录`);
      await resource.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "切换免密码登录失败"); } finally { setAccountAction(null); }
  }

  /** 启用或停用 Emby 账号，最后一个启用账号由服务端拒绝停用。 */
  async function toggleAccountStatus(account: { id: string; username: string; status: "active" | "disabled" }): Promise<void> {
    if (accountAction) return;
    const nextStatus = account.status === "active" ? "disabled" : "active";
    if (nextStatus === "disabled" && !window.confirm(`确定停用 Emby 账号“${account.username}”吗？其现有 Emby 会话会被撤销。`)) return;
    setAccountAction(`status:${account.id}`);
    try {
      await updateServiceEmbyAccount(serviceId, account.id, { status: nextStatus }, admin);
      setMessage(`Emby 账号“${account.username}”已${nextStatus === "active" ? "启用" : "停用"}`);
      await resource.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "修改 Emby 账号状态失败"); } finally { setAccountAction(null); }
  }

  /** 撤销一个 Emby 账号的全部协议会话。 */
  async function revokeAccountSessions(account: { id: string; username: string }): Promise<void> {
    if (accountAction || !window.confirm(`确定撤销 Emby 账号“${account.username}”的全部会话吗？观看记录不会删除。`)) return;
    setAccountAction(`sessions:${account.id}`);
    try {
      const result = await revokeServiceEmbyAccountSessions(serviceId, account.id, admin);
      setMessage(`Emby 账号“${account.username}”已撤销 ${result.revokedCount} 个会话`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "撤销 Emby 会话失败"); } finally { setAccountAction(null); }
  }

  if (!service || !settings) return <Panel><div className="py-16 text-center text-sm text-muted-foreground">{resource.error ?? "正在读取 Emby 配置…"}</div></Panel>;
  const address = settings.embyUrl ?? `云助手 API 地址${settings.embyPath}`;
  return <>
    <PageHeader title={`${service.displayName} · Emby 配置`} actions={<Link to={settingsPath} params={{ serviceId }}><SecondaryButton>返回媒体库设置</SecondaryButton></Link>} />
    {message && <Panel className="mb-4"><p className="text-sm text-muted-foreground">{message}</p></Panel>}
    <Panel title="客户端服务地址" description="标准地址为 /e/{自定义路径}；Flymby 自动追加的 /emby 入口也会兼容。">
      <div className="rounded-xl border border-border bg-secondary/35 p-4">
        <p className="break-all font-mono text-sm">{address}</p>
        <div className="mt-3"><SecondaryButton type="button" onClick={() => void copyEmbyAddress(settings.embyUrl ?? settings.embyPath).then(() => setMessage("Emby 服务地址已复制"))}><Copy className="size-4" /> 复制地址</SecondaryButton></div>
      </div>
      <form className="mt-4 flex flex-wrap items-end gap-3" onSubmit={(event) => void savePath(event)}>
        <label className="min-w-56 flex-1 text-sm">地址后缀<input value={pathSuffix} onChange={(event) => setPathSuffix(event.target.value)} className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm" /></label>
        <PrimaryButton type="submit" disabled={saving}><Settings2 className="size-4" /> 保存地址</PrimaryButton>
      </form>
    </Panel>
    <Panel title="播放与媒体库" className="mt-4">
      {[["Emby 中转播放", "开启后自动模式由云助手中转，关闭后优先使用网盘原始地址。", settings.embyRelayPlaybackEnabled, toggleRelay], ["允许客户端下载", "允许后客户端可通过标准 Download 接口下载原始文件。", settings.embyDownloadEnabled, () => saveEmbySwitch("embyDownloadEnabled", "Emby 影片下载")], ["节目地区媒体库", "开启后按国语、日韩、欧美、其他返回虚拟电影和剧集媒体库。", settings.embyRegionLibrariesEnabled, () => saveEmbySwitch("embyRegionLibrariesEnabled", "Emby 节目地区分组")]].map(([title, description, checked, action]) => <div key={String(title)} className="flex items-center justify-between gap-4 border-b border-border py-4 last:border-b-0"><div><p className="text-sm font-medium">{String(title)}</p><p className="mt-1 text-xs text-muted-foreground">{String(description)}</p></div><button type="button" role="switch" aria-checked={Boolean(checked)} disabled={saving} onClick={() => void (action as () => Promise<void>)()} className={`relative h-7 w-12 shrink-0 rounded-full border ${checked ? "border-primary bg-primary" : "border-border bg-secondary"}`}><span className={`absolute top-0.5 left-0.5 size-5 rounded-full bg-white transition-transform ${checked ? "translate-x-5" : "translate-x-0"}`} /></button></div>)}
    </Panel>
    <Panel title="Emby 访问账号" description="每个账号有独立的 Emby 收藏、已看、续播和播放历史，不与 Jellyfin 共用。" className="mt-4">
      <div className="space-y-3">{settings.embyAccounts.map((account, index) => {
        const editing = editingAccountId === account.id;
        const pending = accountAction?.endsWith(account.id) ?? false;
        return <article key={account.id} className="rounded-xl border border-border bg-secondary/35 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><p className="truncate text-sm font-medium">{account.username}</p><StatusPill tone={account.status === "active" ? "success" : "neutral"}>{account.status === "active" ? "已启用" : "已停用"}</StatusPill></div><p className="mt-1 text-[11px] text-muted-foreground">{index === 0 ? "第一个账号 · " : ""}{account.hasPassword ? "需要密码" : "免密码"} · 凭据 r{account.credentialRevision}</p></div>
            <div className="flex flex-wrap gap-2">
              <SecondaryButton type="button" disabled={accountAction !== null} onClick={() => beginEditAccount(account)}><Pencil className="size-4" /> 编辑</SecondaryButton>
              <SecondaryButton type="button" disabled={accountAction !== null} onClick={() => void revokeAccountSessions(account)}>撤销会话</SecondaryButton>
              <SecondaryButton type="button" disabled={accountAction !== null || (account.status === "active" && settings.embyAccounts.filter((candidate) => candidate.status === "active").length <= 1)} onClick={() => void toggleAccountStatus(account)}>{account.status === "active" ? "停用" : "启用"}</SecondaryButton>
              <button type="button" disabled={accountAction !== null || settings.embyAccounts.length <= 1} onClick={() => void deleteAccount(account.id, account.username)} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-destructive/40 bg-destructive/8 px-3 py-2 text-xs text-destructive transition-colors hover:bg-destructive/15 disabled:cursor-not-allowed disabled:opacity-40"><Trash2 className="size-3.5" /> {pending && accountAction?.startsWith("delete:") ? "正在删除…" : "删除"}</button>
            </div>
          </div>
          {editing && <form onSubmit={(event) => void saveAccount(event, account)} className="mt-4 grid gap-3 border-t border-border pt-4 md:grid-cols-2"><label><span className="text-xs text-muted-foreground">访问用户名</span><input value={editingUsername} required minLength={4} maxLength={255} onChange={(event) => setEditingUsername(event.target.value)} className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm" /></label><label><span className="text-xs text-muted-foreground">新密码</span><input value={editingPassword} type="password" autoComplete="new-password" placeholder="留空表示不修改" onChange={(event) => setEditingPassword(event.target.value)} className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm" /></label><div className="flex flex-wrap gap-2 md:col-span-2"><PrimaryButton type="submit" disabled={accountAction !== null}><Settings2 className="size-4" /> {pending && accountAction?.startsWith("save:") ? "正在保存…" : "保存账号"}</PrimaryButton>{account.hasPassword && <SecondaryButton type="button" disabled={accountAction !== null} onClick={() => void clearAccountPassword(account)}>改为免密码</SecondaryButton>}<SecondaryButton type="button" disabled={accountAction !== null} onClick={() => setEditingAccountId(null)}>取消</SecondaryButton></div></form>}
        </article>;
      })}</div>
      <form className="mt-4 grid gap-3 rounded-xl border border-border bg-secondary/35 p-4 md:grid-cols-2" onSubmit={(event) => void createAccount(event)}><label><span className="text-xs text-muted-foreground">新账号用户名</span><input required minLength={4} maxLength={255} value={newUsername} onChange={(event) => setNewUsername(event.target.value)} className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm" /></label><label><span className="text-xs text-muted-foreground">登录密码（可选）</span><input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} placeholder="留空则无需密码" className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm" /></label><div className="md:col-span-2"><PrimaryButton type="submit" disabled={creating || accountAction !== null}><Plus className="size-4" /> {creating ? "正在创建…" : "创建账号"}</PrimaryButton></div></form>
    </Panel>
  </>;
}

export function UserLibraryEmbySettingsPage({ serviceId }: { serviceId: string }) { return <LibraryEmbySettingsPage serviceId={serviceId} />; }
export function AdminLibraryEmbySettingsPage({ serviceId }: { serviceId: string }) { return <LibraryEmbySettingsPage serviceId={serviceId} admin />; }
