import { ExternalLink, LoaderCircle, LogIn, RotateCcw, Send, ShieldCheck } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useRef, useState } from "react";
import { PrimaryButton, SecondaryButton } from "@/components/ConsoleShell";
import { StatusPill } from "@/components/ui-kit";
import {
  pollGuangyaAuthorization,
  completeGuangyaSmsCaptcha,
  startGuangyaAuthorization,
  startGuangyaSmsAuthorization,
  verifyGuangyaSmsAuthorization,
  type GuangyaAuthorizationStatus,
} from "@/lib/api";

type GuangyaLoginMode = "official_api" | "web_qr" | "web_sms";

interface GuangyaCaptchaChallenge {
  captchaSessionId: string;
  verificationUri: string;
  expiresAt: string;
}

interface GuangyaCaptchaCallbackMessage {
  type: "flycloud-helper-guangya-captcha";
  captchaToken: string;
  state: string;
}

interface GuangyaAuthorizationPanelProps {
  admin: boolean;
  targetUserId?: string;
  resetKey: string;
  initialLoginMode?: GuangyaLoginMode;
  onAuthorizationChange: (authorization: GuangyaAuthorizationStatus | null) => void;
}

const authorizationStatusLabels: Record<GuangyaAuthorizationStatus["status"], string> = {
  pending: "等待确认",
  authorized: "授权成功",
  expired: "授权已过期",
  failed: "授权失败",
};

const loginModeLabels: Record<GuangyaLoginMode, string> = {
  official_api: "官方光鸭",
  web_qr: "三方光鸭（扫码登录）",
  web_sms: "三方光鸭（验证码登录）",
};

/** 返回光鸭网页授权状态对应的视觉语义。 */
function getAuthorizationTone(status: GuangyaAuthorizationStatus["status"]): "primary" | "success" | "warning" | "danger" {
  if (status === "authorized") return "success";
  if (status === "expired") return "warning";
  if (status === "failed") return "danger";
  return "primary";
}

/** 清理手机号里常见的国家区号、空格和短横线，前后端使用同一校验口径。 */
function normalizeMainlandPhoneNumber(value: string): string {
  const compactPhoneNumber = value.replace(/[\s-]/gu, "").trim();
  return compactPhoneNumber.replace(/^\+?86/gu, "");
}

/** 展示三种光鸭登录入口；官方 API 只说明 APP 同步，网页方式在本页完成授权。 */
export function GuangyaAuthorizationPanel({
  admin,
  targetUserId,
  resetKey,
  initialLoginMode = "web_qr",
  onAuthorizationChange,
}: GuangyaAuthorizationPanelProps) {
  const [loginMode, setLoginMode] = useState<GuangyaLoginMode>(initialLoginMode);
  const [authorization, setAuthorization] = useState<GuangyaAuthorizationStatus | null>(null);
  const [phoneNumber, setPhoneNumber] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [agreementAccepted, setAgreementAccepted] = useState(false);
  const [captchaChallenge, setCaptchaChallenge] = useState<GuangyaCaptchaChallenge | null>(null);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pollingRevision, setPollingRevision] = useState(0);
  // 关键变量：通过引用保存父级回调，避免父组件重渲染导致授权轮询计时器重复创建。
  const authorizationChangeRef = useRef(onAuthorizationChange);

  useEffect(() => {
    authorizationChangeRef.current = onAuthorizationChange;
  }, [onAuthorizationChange]);

  useEffect(() => {
    setLoginMode(initialLoginMode);
    setAuthorization(null);
    setPhoneNumber("");
    setVerificationCode("");
    setAgreementAccepted(false);
    setCaptchaChallenge(null);
    setMessage(null);
    setPollingRevision(0);
    authorizationChangeRef.current(null);
  }, [initialLoginMode, resetKey]);

  useEffect(() => {
    /** 只接收当前同源回调页和当前人机验证会话返回的一次性 Token。 */
    function receiveCaptchaResult(event: MessageEvent<unknown>): void {
      if (event.origin !== window.location.origin || !captchaChallenge) return;
      if (!event.data || typeof event.data !== "object") return;
      const data = event.data as Partial<GuangyaCaptchaCallbackMessage>;
      if (data.type !== "flycloud-helper-guangya-captcha"
        || data.state !== captchaChallenge.captchaSessionId
        || typeof data.captchaToken !== "string") return;
      void completeCaptchaVerification(data.captchaToken);
    }
    window.addEventListener("message", receiveCaptchaResult);
    return () => window.removeEventListener("message", receiveCaptchaResult);
  }, [admin, captchaChallenge]);

  useEffect(() => {
    if (!authorization || authorization.authMethod !== "qr" || authorization.status !== "pending") return;
    // 关键变量：遵循光鸭返回的最小轮询间隔，避免认证接口被高频访问。
    const pollingDelay = Math.max(2, authorization.intervalSeconds) * 1_000;
    const timer = window.setTimeout(() => {
      void pollGuangyaAuthorization(authorization.authorizationSessionId, admin)
        .then((nextAuthorization) => {
          setAuthorization(nextAuthorization);
          authorizationChangeRef.current(nextAuthorization);
        })
        .catch((error) => {
          setMessage(error instanceof Error ? error.message : "读取光鸭二维码授权状态失败");
          setPollingRevision((current) => current + 1);
        });
    }, pollingDelay);
    return () => window.clearTimeout(timer);
  }, [admin, authorization, pollingRevision]);

  /** 切换登录类型时清除上一个一次性会话，避免错误提交旧授权。 */
  function selectLoginMode(nextMode: GuangyaLoginMode): void {
    setLoginMode(nextMode);
    setAuthorization(null);
    setCaptchaChallenge(null);
    setVerificationCode("");
    setMessage(nextMode === "official_api" ? "请在 Flymby APP 完成官方光鸭登录后，通过接口同步到 Fly云助手。" : null);
    authorizationChangeRef.current(null);
  }

  /** 创建服务端 Device Code 会话，二维码仅展示本次短期官方验证地址。 */
  async function startQrAuthorization(): Promise<void> {
    if (admin && !targetUserId) {
      setMessage("请先选择所属用户，再进行三方光鸭扫码登录");
      return;
    }
    setWorking(true);
    setMessage("正在获取三方光鸭登录二维码…");
    try {
      const nextAuthorization = await startGuangyaAuthorization(admin, targetUserId);
      setAuthorization(nextAuthorization);
      authorizationChangeRef.current(nextAuthorization);
      setMessage("请使用光鸭 APP 扫描二维码并确认登录");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "无法启动三方光鸭扫码登录");
    } finally {
      setWorking(false);
    }
  }

  /** 发送网页验证码，并保留服务端返回的短期授权会话。 */
  async function sendSmsCode(): Promise<void> {
    const normalizedPhoneNumber = normalizeMainlandPhoneNumber(phoneNumber);
    console.info(
      `codex-flycloud-helper-guangya-sms-auth 事件=点击获取验证码 是否管理员=${admin} 是否选择目标用户=${Boolean(targetUserId)} 是否同意协议=${agreementAccepted}`,
    );
    if (admin && !targetUserId) {
      setMessage("请先选择所属用户，再发送三方光鸭验证码");
      return;
    }
    if (!/^1\d{10}$/u.test(normalizedPhoneNumber)) {
      setMessage("请输入正确的中国大陆手机号");
      return;
    }
    if (!agreementAccepted) {
      setMessage("请先阅读并同意光鸭用户协议和隐私政策");
      return;
    }
    setWorking(true);
    setCaptchaChallenge(null);
    setMessage("正在初始化光鸭官网人机验证…");
    try {
      const startResult = await startGuangyaSmsAuthorization(
        normalizedPhoneNumber,
        `${window.location.origin}/guangya-captcha-callback`,
        admin,
        targetUserId,
      );
      if (startResult.captcha) {
        setCaptchaChallenge(startResult.captcha);
        setAuthorization(null);
        authorizationChangeRef.current(null);
        setMessage("光鸭要求完成人机验证，请点击下方按钮打开官方验证页面");
        console.info("codex-flycloud-helper-guangya-sms-auth 事件=等待官方人机验证");
        return;
      }
      if (!startResult.authorization) {
        throw new Error("光鸭未返回验证码会话，请重新获取");
      }
      setAuthorization(startResult.authorization);
      authorizationChangeRef.current(null);
      setMessage(`验证码已发送至 ${startResult.authorization.maskedPhone || "当前手机号"}`);
      console.info("codex-flycloud-helper-guangya-sms-auth 事件=验证码接口返回成功");
    } catch (error) {
      console.warn(
        `codex-flycloud-helper-guangya-sms-auth 事件=验证码接口返回失败 错误类型=${error instanceof Error ? error.name : typeof error}`,
      );
      setMessage(error instanceof Error ? error.message : "发送三方光鸭验证码失败");
    } finally {
      setWorking(false);
    }
  }

  /** 将官方验证页回调的一次性 Token 交回服务端，并继续发送短信验证码。 */
  async function completeCaptchaVerification(captchaToken: string): Promise<void> {
    if (!captchaChallenge) return;
    setWorking(true);
    setMessage("人机验证已完成，正在发送三方光鸭验证码…");
    try {
      const nextAuthorization = await completeGuangyaSmsCaptcha(
        captchaChallenge.captchaSessionId,
        captchaToken,
        admin,
      );
      setCaptchaChallenge(null);
      setAuthorization(nextAuthorization);
      authorizationChangeRef.current(null);
      setMessage(`验证码已发送至 ${nextAuthorization.maskedPhone || "当前手机号"}`);
      console.info("codex-flycloud-helper-guangya-sms-auth 事件=人机验证完成并发送验证码成功");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "光鸭人机验证结果提交失败");
    } finally {
      setWorking(false);
    }
  }

  /** 由用户手势打开光鸭官方验证页，避免浏览器把新窗口当作弹窗拦截。 */
  function openCaptchaVerification(): void {
    if (!captchaChallenge) return;
    const popup = window.open(captchaChallenge.verificationUri, "flycloud-helper-guangya-captcha", "popup,width=420,height=620");
    setMessage(popup
      ? "请在新窗口完成光鸭官网人机验证，完成后会自动发送短信验证码"
      : "浏览器阻止了验证窗口，请允许本站弹出窗口后重试");
  }

  /** 校验网页验证码，成功连接仍只保存在服务端。 */
  async function verifySmsCode(): Promise<void> {
    if (!authorization || authorization.authMethod !== "sms") {
      setMessage("请先获取三方光鸭验证码");
      return;
    }
    if (!/^\d{4,8}$/u.test(verificationCode.trim())) {
      setMessage("请输入正确的短信验证码");
      return;
    }
    setWorking(true);
    setMessage("正在验证并登录光鸭账号…");
    try {
      const nextAuthorization = await verifyGuangyaSmsAuthorization(
        authorization.authorizationSessionId,
        verificationCode.trim(),
        admin,
      );
      setAuthorization(nextAuthorization);
      authorizationChangeRef.current(nextAuthorization);
      setMessage("三方光鸭验证码登录成功");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "三方光鸭验证码登录失败");
    } finally {
      setWorking(false);
    }
  }

  const verificationAddress = authorization?.verificationUriComplete || authorization?.verificationUri || "";
  return (
    <div className="rounded-xl border border-border bg-secondary/25 p-4 lg:col-span-2">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium">光鸭类型</p>
          <p className="mt-1 text-xs text-muted-foreground">官方光鸭与三方光鸭连接彼此独立，凭据均由服务端加密保存。</p>
        </div>
        {authorization && <StatusPill tone={getAuthorizationTone(authorization.status)}>{authorizationStatusLabels[authorization.status]}</StatusPill>}
      </div>

      <div className="mt-4 grid gap-2 md:grid-cols-3">
        {(Object.keys(loginModeLabels) as GuangyaLoginMode[]).map((mode) => (
          <button key={mode} type="button" onClick={() => selectLoginMode(mode)} className={`rounded-lg border px-3 py-2.5 text-left text-sm transition-colors ${loginMode === mode ? "border-primary/60 bg-primary/10 font-semibold" : "border-border bg-background/30 text-muted-foreground hover:text-foreground"}`}>
            {loginModeLabels[mode]}
          </button>
        ))}
      </div>

      {loginMode === "official_api" && (
        <div className="mt-4 rounded-lg border border-border bg-background/35 p-4">
          <p className="text-sm font-medium">仅支持从 Flymby APP 同步</p>
          <p className="mt-2 text-xs leading-6 text-muted-foreground">先在 Flymby APP 中完成官方光鸭登录，再由 APP 使用当前 Fly云助手账号同步。Fly云助手前台不提供官方光鸭登录入口。</p>
        </div>
      )}

      {loginMode === "web_qr" && authorization?.authMethod === "qr" && authorization.status === "pending" && (
        <div className="mt-4 grid gap-4 rounded-lg border border-border bg-background/35 p-4 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center">
          <div className="w-fit rounded-lg bg-white p-2">
            <QRCodeSVG value={verificationAddress} size={176} bgColor="#ffffff" fgColor="#111827" level="M" marginSize={1} title="三方光鸭扫码登录" />
          </div>
          <div>
            <p className="text-sm font-medium">使用光鸭 APP 扫描并确认登录</p>
            {authorization.userCode && <p className="mt-2 text-xs text-muted-foreground">确认码 <span className="font-mono font-semibold text-foreground">{authorization.userCode}</span></p>}
            <p className="mt-2 text-[11px] text-muted-foreground">二维码有效期至 {new Date(authorization.expiresAt).toLocaleTimeString("zh-CN")}</p>
            <a href={verificationAddress} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground"><ExternalLink className="size-3.5" /> 无法扫码时打开官方确认页</a>
          </div>
        </div>
      )}

      {loginMode === "web_sms" && (
        <div className="mt-4 grid gap-3 rounded-lg border border-border bg-background/35 p-4 sm:grid-cols-[minmax(0,1fr)_auto]">
          <label><span className="text-xs text-muted-foreground">手机号</span><input value={phoneNumber} onChange={(event) => setPhoneNumber(event.target.value)} disabled={authorization?.authMethod === "sms" && authorization.status === "authorized"} inputMode="tel" autoComplete="tel" maxLength={18} placeholder="请输入中国大陆手机号" className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm" /></label>
          <div className="self-end"><SecondaryButton type="button" disabled={working} onClick={() => void sendSmsCode()}>{working ? <LoaderCircle className="size-4 animate-spin" /> : <Send className="size-4" />}获取验证码</SecondaryButton></div>
          {captchaChallenge && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-secondary/35 p-3 sm:col-span-2">
              <div>
                <p className="text-sm font-medium">需要完成人机验证</p>
                <p className="mt-1 text-xs text-muted-foreground">验证页面由光鸭官网提供，有效期至 {new Date(captchaChallenge.expiresAt).toLocaleTimeString("zh-CN")}。</p>
              </div>
              <PrimaryButton type="button" disabled={working} onClick={openCaptchaVerification}><ShieldCheck className="size-4" />打开官方验证页面</PrimaryButton>
            </div>
          )}
          <label><span className="text-xs text-muted-foreground">短信验证码</span><input value={verificationCode} onChange={(event) => setVerificationCode(event.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={8} placeholder="请输入短信验证码" className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm" /></label>
          <div className="self-end"><PrimaryButton type="button" disabled={working || authorization?.authMethod !== "sms" || authorization.status !== "pending"} onClick={() => void verifySmsCode()}>{working ? <LoaderCircle className="size-4 animate-spin" /> : <LogIn className="size-4" />}验证并登录</PrimaryButton></div>
          <label className="flex items-start gap-2 text-xs text-muted-foreground sm:col-span-2">
            <input type="checkbox" checked={agreementAccepted} onChange={(event) => setAgreementAccepted(event.target.checked)} className="mt-0.5 size-4" />
            <span>我已阅读并同意 <a href="https://app.guangyapan.com/pan/policy/user-agreement" target="_blank" rel="noreferrer" className="text-foreground hover:underline">光鸭用户协议</a> 和 <a href="https://app.guangyapan.com/pan/policy/privacy" target="_blank" rel="noreferrer" className="text-foreground hover:underline">隐私政策</a>。未注册手机号将按光鸭官网规则创建账号。</span>
          </label>
          <div role="status" aria-live="polite" className="rounded-lg border border-border bg-secondary/35 px-3.5 py-3 text-xs text-muted-foreground sm:col-span-2">
            {message || "填写手机号并同意协议后，点击“获取验证码”。点击后这里会立即显示发送状态。"}
          </div>
        </div>
      )}

      {authorization?.status === "authorized" && <p className="mt-4 text-sm text-success">已完成{loginModeLabels[loginMode]}{authorization.accountLabel ? `，账号 ${authorization.accountLabel}` : ""}。</p>}
      {(authorization?.status === "expired" || authorization?.status === "failed") && <p className="mt-4 text-sm text-destructive">{authorization.errorMessage || "本次三方光鸭登录未完成，请重新登录"}</p>}

      {loginMode === "web_qr" && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {authorization ? (
            <SecondaryButton type="button" disabled={working || authorization.status === "pending"} onClick={() => void startQrAuthorization()}>{working ? <LoaderCircle className="size-4 animate-spin" /> : <RotateCcw className="size-4" />}重新获取二维码</SecondaryButton>
          ) : (
            <PrimaryButton type="button" disabled={working} onClick={() => void startQrAuthorization()}>{working ? <LoaderCircle className="size-4 animate-spin" /> : <LogIn className="size-4" />}{working ? "正在获取…" : "开始三方光鸭扫码登录"}</PrimaryButton>
          )}
        </div>
      )}
      {message && loginMode !== "web_sms" && <p role="status" aria-live="polite" className="mt-3 text-xs text-muted-foreground">{message}</p>}
    </div>
  );
}
