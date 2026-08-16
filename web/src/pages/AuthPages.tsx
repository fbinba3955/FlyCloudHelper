import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowRight, CheckCircle2, Copy, Download, Eye, KeyRound, ShieldCheck } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { StatusPill } from "@/components/ui-kit";
import {
  acknowledgeCredentialKeyBackup,
  ApiClientError,
  getCredentialKeyBackup,
  getSetupStatus,
  initializeSuperAdmin,
  login,
  register,
  type CredentialKeyBackup,
  type AuthUser,
} from "@/lib/api";

interface AuthFieldProps {
  label: string;
  name: string;
  type?: "text" | "password";
  placeholder: string;
  autoComplete: string;
}

/** 渲染认证页面输入字段。 */
function AuthField({
  label,
  name,
  type = "text",
  placeholder,
  autoComplete,
}: AuthFieldProps) {
  return (
    <label className="block">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="relative mt-2 block">
        <input
          name={name}
          type={type}
          autoComplete={autoComplete}
          placeholder={placeholder}
          minLength={4}
          required
          className="w-full rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm outline-none transition-colors focus:border-primary/60"
        />
        {type === "password" && (
          <Eye className="pointer-events-none absolute top-1/2 right-3.5 size-4 -translate-y-1/2 text-muted-foreground" />
        )}
      </span>
    </label>
  );
}

/** 校验用户名、密码和确认密码。 */
function validateAuthForm(form: HTMLFormElement, requireConfirmation: boolean): string | null {
  const values = new FormData(form);
  const username = String(values.get("username") ?? "").trim();
  const password = String(values.get("password") ?? "");
  const confirmation = String(values.get("passwordConfirmation") ?? "");

  if ([...username].length < 4) {
    return "用户名至少需要 4 个字符";
  }
  if ([...password].length < 4) {
    return "密码至少需要 4 个字符";
  }
  if (requireConfirmation && password !== confirmation) {
    return "两次输入的密码不一致";
  }
  return null;
}

/** 渲染认证页面的品牌说明区域。 */
function AuthIntroduction() {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-3">
        <img
          src="/flycloud-helper-icon.png"
          alt="FlyCloudHelper"
          className="size-10 shrink-0 rounded-xl object-cover"
        />
        <span className="font-display text-sm tracking-[0.2em] uppercase">FlyCloudHelper</span>
      </div>
      <h1 className="mt-7 text-3xl leading-tight font-semibold sm:text-5xl">
        云端媒体的
        <span className="text-gradient"> 扫描、刮削与目录</span>
      </h1>
      <p className="mt-5 max-w-lg text-sm leading-relaxed text-muted-foreground">
        Docker 部署的多用户媒体目录服务。配置网盘服务与扫描路径，实时查看任务进度，
        用海报墙浏览视频、音乐与有声书。控制台只负责配置与浏览，不提供播放与下载。
      </p>
      <div className="mt-7 flex flex-wrap gap-2">
        <StatusPill tone="primary">多用户多服务</StatusPill>
        <StatusPill tone="info">SSE 实时进度</StatusPill>
        <StatusPill tone="success">Secret 加密存储</StatusPill>
      </div>
    </div>
  );
}

/** 渲染认证页面通用背景与双栏结构。 */
function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden px-4 py-10">
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-[560px]"
        style={{ backgroundImage: "var(--gradient-glow)" }}
      />
      <div className="grid-noise pointer-events-none absolute inset-0 opacity-40" />
      <div className="relative grid w-full max-w-5xl gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)] lg:items-center">
        <AuthIntroduction />
        {children}
      </div>
    </div>
  );
}

type AuthMode = "setup" | "login" | "register";

/** 提交真实认证 API，并根据服务端角色进入对应控制台。 */
function useAuthSubmit(mode: AuthMode) {
  const navigate = useNavigate();
  const [message, setMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [credentialKeyBackup, setCredentialKeyBackup] = useState<CredentialKeyBackup | null>(null);

  useEffect(() => {
    let active = true;

    /** 根据服务端初始化状态限制认证入口。 */
    async function resolveSetupState(): Promise<void> {
      try {
        const state = await getSetupStatus();
        if (!active) {
          return;
        }
        if (mode === "setup" && !state.setupRequired) {
          if (state.credentialKeyBackupRequired) {
            try {
              const backup = await getCredentialKeyBackup();
              if (active) setCredentialKeyBackup(backup);
            } catch (error) {
              if (error instanceof ApiClientError && error.code === "authentication_required") {
                await navigate({ to: "/login", replace: true });
              } else {
                throw error;
              }
            }
          } else {
            await navigate({ to: "/login", replace: true });
          }
        } else if (mode !== "setup" && state.setupRequired) {
          await navigate({ to: "/setup", replace: true });
        }
      } catch (error) {
        if (active) {
          setMessage(error instanceof Error ? error.message : "无法读取初始化状态");
        }
      }
    }

    void resolveSetupState();
    return () => {
      active = false;
    };
  }, [mode, navigate]);

  /** 处理认证表单提交。 */
  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const requireConfirmation = mode !== "login";
    const validationMessage = validateAuthForm(event.currentTarget, requireConfirmation);
    if (validationMessage) {
      setMessage(validationMessage);
      return;
    }

    const values = new FormData(event.currentTarget);
    const username = String(values.get("username") ?? "");
    const password = String(values.get("password") ?? "");
    const passwordConfirmation = String(values.get("passwordConfirmation") ?? "");

    setSubmitting(true);
    setMessage(null);
    try {
      let user: AuthUser;
      if (mode === "setup") {
        const result = await initializeSuperAdmin({ username, password, passwordConfirmation });
        user = result.user;
        if (result.credentialKeyBackup) {
          setCredentialKeyBackup(result.credentialKeyBackup);
          return;
        }
      } else if (mode === "register") {
        user = await register({ username, password, passwordConfirmation });
      } else {
        user = await login({ username, password });
      }
      const setupState = await getSetupStatus();
      if (setupState.credentialKeyBackupRequired) {
        if (user.role === "super_admin") {
          await navigate({ to: "/setup", replace: true });
        } else {
          setMessage("实例正在等待超级管理员完成凭据主密钥备份");
        }
        return;
      }
      await navigate({ to: user.role === "super_admin" ? "/admin" : "/app", replace: true });
    } catch (error) {
      if (error instanceof ApiClientError && error.code === "setup_required") {
        await navigate({ to: "/setup", replace: true });
        return;
      }
      if (error instanceof ApiClientError && error.code === "setup_already_completed") {
        await navigate({ to: "/login", replace: true });
        return;
      }
      setMessage(error instanceof Error ? error.message : "认证请求失败");
    } finally {
      setSubmitting(false);
    }
  }

  return { message, submitting, credentialKeyBackup, handleSubmit };
}

/** 下载只包含主密钥正文的备份文件，可直接作为 Docker Secret 使用。 */
function downloadCredentialKeyBackup(backup: CredentialKeyBackup): void {
  const objectUrl = URL.createObjectURL(new Blob([`${backup.masterKey}\n`], { type: "text/plain;charset=utf-8" }));
  const downloadLink = document.createElement("a");
  downloadLink.href = objectUrl;
  downloadLink.download = backup.fileName;
  downloadLink.click();
  URL.revokeObjectURL(objectUrl);
}

/** 复制主密钥，并在受限浏览器中使用临时文本框降级处理。 */
async function copyCredentialKey(masterKey: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(masterKey);
    return;
  } catch {
    const temporaryInput = document.createElement("textarea");
    temporaryInput.value = masterKey;
    temporaryInput.style.position = "fixed";
    temporaryInput.style.opacity = "0";
    document.body.appendChild(temporaryInput);
    temporaryInput.select();
    document.execCommand("copy");
    temporaryInput.remove();
  }
}

/** 显示自动生成主密钥并要求管理员完成外部备份。 */
function CredentialKeyBackupPanel({ backup }: { backup: CredentialKeyBackup }) {
  const navigate = useNavigate();
  const [confirmed, setConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  /** 确认备份状态并进入超级管理员后台。 */
  async function completeBackup(): Promise<void> {
    if (!confirmed) {
      setMessage("请先确认已经将主密钥保存到安全位置");
      return;
    }
    setSubmitting(true);
    setMessage(null);
    try {
      await acknowledgeCredentialKeyBackup();
      await navigate({ to: "/admin", replace: true });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "无法确认备份状态");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="surface min-w-0 p-6 sm:p-8">
      <StatusPill tone="warning"><KeyRound className="size-3" /> 必须备份</StatusPill>
      <h2 className="mt-4 text-lg font-semibold">保存凭据主密钥</h2>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        系统已经自动生成主密钥。它用于解密网盘凭据，丢失后已有网盘连接无法恢复；确认备份后页面不再显示原文。
      </p>
      <div className="mt-6 rounded-xl border border-border bg-background/55 p-4">
        <p className="text-[11px] text-muted-foreground">FLYCLOUDHELPER_CREDENTIAL_MASTER_KEY</p>
        <p className="mt-2 break-all font-mono text-xs leading-relaxed text-foreground">{backup.masterKey}</p>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3">
        <button
          type="button"
          className="flex items-center justify-center gap-2 rounded-lg border border-border px-3 py-2.5 text-xs font-medium hover:bg-muted/60"
          onClick={() => void copyCredentialKey(backup.masterKey).then(() => {
            setCopied(true);
            setMessage(null);
          })}
        >
          {copied ? <CheckCircle2 className="size-4" /> : <Copy className="size-4" />}
          {copied ? "已复制" : "复制密钥"}
        </button>
        <button
          type="button"
          className="flex items-center justify-center gap-2 rounded-lg border border-border px-3 py-2.5 text-xs font-medium hover:bg-muted/60"
          onClick={() => downloadCredentialKeyBackup(backup)}
        >
          <Download className="size-4" /> 下载备份
        </button>
      </div>
      <label className="mt-5 flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 text-xs leading-relaxed">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
          className="mt-0.5 size-4"
        />
        <span>我已将主密钥保存到数据库和 Docker 数据卷之外的安全位置。</span>
      </label>
      <button
        type="button"
        disabled={submitting}
        onClick={() => void completeBackup()}
        className="glow-ring mt-5 flex w-full items-center justify-center gap-2 rounded-lg px-4 py-3 text-sm font-medium text-primary-foreground disabled:cursor-wait disabled:opacity-60"
        style={{ backgroundImage: "var(--gradient-primary)" }}
      >
        {submitting ? "正在确认…" : "已完成备份，进入后台"} <ArrowRight className="size-4" />
      </button>
      {message && <p className="mt-4 text-xs text-warning">{message}</p>}
    </div>
  );
}

/** 首次部署初始化页面。 */
export function SetupPage() {
  const { message, submitting, credentialKeyBackup, handleSubmit } = useAuthSubmit("setup");

  return (
    <AuthLayout>
      {credentialKeyBackup ? (
        <CredentialKeyBackupPanel backup={credentialKeyBackup} />
      ) : (
      <div className="surface min-w-0 p-6 sm:p-8">
        <StatusPill tone="warning">首次部署</StatusPill>
        <h2 className="mt-4 text-lg font-semibold">创建首个超级管理员</h2>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          该入口只在实例尚未初始化时开放。请先在受控网络完成设置，再开放公网地址。
        </p>
        <form className="mt-7 space-y-5" onSubmit={(event) => void handleSubmit(event)}>
          <AuthField label="超级管理员用户名" name="username" placeholder="至少 4 个字符" autoComplete="username" />
          <AuthField label="密码" name="password" type="password" placeholder="至少 4 个字符" autoComplete="new-password" />
          <AuthField label="确认密码" name="passwordConfirmation" type="password" placeholder="再次输入密码" autoComplete="new-password" />
          <button
            type="submit"
            disabled={submitting}
            className="glow-ring flex w-full items-center justify-center gap-2 rounded-lg px-4 py-3 text-sm font-medium text-primary-foreground disabled:cursor-wait disabled:opacity-60"
            style={{ backgroundImage: "var(--gradient-primary)" }}
          >
            {submitting ? "正在初始化…" : "完成初始化"} <ArrowRight className="size-4" />
          </button>
        </form>
        {message && <p className="mt-4 text-xs text-warning">{message}</p>}
        <p className="mt-5 text-[11px] leading-relaxed text-muted-foreground">
          页面不要求一次性初始化凭证。主密钥会由系统自动生成，并在管理员创建成功后提示备份。
        </p>
      </div>
      )}
    </AuthLayout>
  );
}

/** 统一账号登录页面。 */
export function LoginPage() {
  const { message, submitting, handleSubmit } = useAuthSubmit("login");

  return (
    <AuthLayout>
      <div className="surface min-w-0 p-6 sm:p-8">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
          <div>
            <h2 className="text-lg font-semibold">登录</h2>
            <p className="mt-1 text-xs text-muted-foreground">使用已创建的账号登录控制台</p>
          </div>
          <StatusPill tone="success">
            <ShieldCheck className="size-3" /> 安全会话
          </StatusPill>
        </div>
        <form className="mt-7 space-y-5" onSubmit={(event) => void handleSubmit(event)}>
          <AuthField label="用户名" name="username" placeholder="至少 4 个字符" autoComplete="username" />
          <AuthField label="密码" name="password" type="password" placeholder="至少 4 个字符" autoComplete="current-password" />
          <button
            type="submit"
            disabled={submitting}
            className="glow-ring flex w-full items-center justify-center gap-2 rounded-lg px-4 py-3 text-sm font-medium text-primary-foreground disabled:cursor-wait disabled:opacity-60"
            style={{ backgroundImage: "var(--gradient-primary)" }}
          >
            {submitting ? "正在登录…" : "登录"} <ArrowRight className="size-4" />
          </button>
        </form>
        {message && <p className="mt-4 text-xs text-warning">{message}</p>}
        <p className="mt-5 text-center text-xs text-muted-foreground">
          还没有账号？
          <Link to="/register" className="ml-1 text-primary-soft hover:underline">
            注册
          </Link>
        </p>
      </div>
    </AuthLayout>
  );
}

/** 普通用户公开注册页面。 */
export function RegisterPage() {
  const { message, submitting, handleSubmit } = useAuthSubmit("register");

  return (
    <AuthLayout>
      <div className="surface min-w-0 p-6 sm:p-8">
        <StatusPill tone="primary">普通用户</StatusPill>
        <h2 className="mt-4 text-lg font-semibold">创建账号</h2>
        <p className="mt-2 text-xs text-muted-foreground">公开注册固定创建普通用户，不提供角色选择。</p>
        <form className="mt-7 space-y-5" onSubmit={(event) => void handleSubmit(event)}>
          <AuthField label="用户名" name="username" placeholder="至少 4 个字符" autoComplete="username" />
          <AuthField label="密码" name="password" type="password" placeholder="至少 4 个字符" autoComplete="new-password" />
          <AuthField label="确认密码" name="passwordConfirmation" type="password" placeholder="再次输入密码" autoComplete="new-password" />
          <button
            type="submit"
            disabled={submitting}
            className="glow-ring flex w-full items-center justify-center gap-2 rounded-lg px-4 py-3 text-sm font-medium text-primary-foreground disabled:cursor-wait disabled:opacity-60"
            style={{ backgroundImage: "var(--gradient-primary)" }}
          >
            {submitting ? "正在创建…" : "创建账号"} <ArrowRight className="size-4" />
          </button>
        </form>
        {message && <p className="mt-4 text-xs text-warning">{message}</p>}
        <p className="mt-5 text-center text-xs text-muted-foreground">
          已有账号？
          <Link to="/login" className="ml-1 text-primary-soft hover:underline">
            返回登录
          </Link>
        </p>
      </div>
    </AuthLayout>
  );
}
