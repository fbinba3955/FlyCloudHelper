import { ExternalLink, LoaderCircle, LogIn, RotateCcw } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useRef, useState } from "react";
import { PrimaryButton, SecondaryButton } from "@/components/ConsoleShell";
import { StatusPill } from "@/components/ui-kit";
import {
  pollGuangyaAuthorization,
  startGuangyaAuthorization,
  type GuangyaAuthorizationStatus,
} from "@/lib/api";

interface GuangyaAuthorizationPanelProps {
  admin: boolean;
  targetUserId?: string;
  resetKey: string;
  onAuthorizationChange: (authorization: GuangyaAuthorizationStatus | null) => void;
}

const authorizationStatusLabels: Record<GuangyaAuthorizationStatus["status"], string> = {
  pending: "等待扫码确认",
  authorized: "授权成功",
  expired: "授权已过期",
  failed: "授权失败",
};

/** 返回光鸭网页授权状态对应的视觉语义。 */
function getAuthorizationTone(status: GuangyaAuthorizationStatus["status"]): "primary" | "success" | "warning" | "danger" {
  if (status === "authorized") return "success";
  if (status === "expired") return "warning";
  if (status === "failed") return "danger";
  return "primary";
}

/** 展示光鸭官网同款扫码登录，并只向服务端轮询脱敏授权状态。 */
export function GuangyaAuthorizationPanel({
  admin,
  targetUserId,
  resetKey,
  onAuthorizationChange,
}: GuangyaAuthorizationPanelProps) {
  const [authorization, setAuthorization] = useState<GuangyaAuthorizationStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pollingRevision, setPollingRevision] = useState(0);
  // 关键变量：通过引用保存父级回调，避免父组件重渲染导致授权轮询计时器重复创建。
  const authorizationChangeRef = useRef(onAuthorizationChange);

  useEffect(() => {
    authorizationChangeRef.current = onAuthorizationChange;
  }, [onAuthorizationChange]);

  useEffect(() => {
    setAuthorization(null);
    setMessage(null);
    setPollingRevision(0);
    authorizationChangeRef.current(null);
  }, [resetKey]);

  useEffect(() => {
    if (!authorization || authorization.status !== "pending") return;
    // 关键变量：遵循光鸭返回的最小轮询间隔，避免认证接口被高频访问。
    const pollingDelay = Math.max(2, authorization.intervalSeconds) * 1000;
    const timer = window.setTimeout(() => {
      void pollGuangyaAuthorization(authorization.authorizationSessionId, admin)
        .then((nextAuthorization) => {
          setAuthorization(nextAuthorization);
          authorizationChangeRef.current(nextAuthorization);
        })
        .catch((error) => {
          setMessage(error instanceof Error ? error.message : "读取光鸭授权状态失败");
          setPollingRevision((current) => current + 1);
        });
    }, pollingDelay);
    return () => window.clearTimeout(timer);
  }, [admin, authorization, pollingRevision]);

  /** 创建服务端 Device Code 会话，二维码仅展示本次短期官方验证地址。 */
  async function startAuthorization(): Promise<void> {
    if (admin && !targetUserId) {
      setMessage("请先选择所属用户，再进行光鸭扫码登录");
      return;
    }
    setStarting(true);
    setMessage("正在获取光鸭官方登录二维码…");
    try {
      const nextAuthorization = await startGuangyaAuthorization(admin, targetUserId);
      setAuthorization(nextAuthorization);
      authorizationChangeRef.current(nextAuthorization);
      setMessage("请使用光鸭 APP 扫描二维码并确认登录");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "无法启动光鸭扫码登录");
    } finally {
      setStarting(false);
    }
  }

  const verificationAddress = authorization?.verificationUriComplete || authorization?.verificationUri || "";
  return (
    <div className="rounded-xl border border-border bg-secondary/25 p-4 lg:col-span-2">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium">光鸭扫码登录</p>
          <p className="mt-1 text-xs text-muted-foreground">登录凭据由服务端安全保存，页面不会显示 Access Token 或 Refresh Token。</p>
        </div>
        {authorization && <StatusPill tone={getAuthorizationTone(authorization.status)}>{authorizationStatusLabels[authorization.status]}</StatusPill>}
      </div>

      {authorization?.status === "pending" && (
        <div className="mt-4 grid gap-4 rounded-lg border border-border bg-background/35 p-4 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center">
          <div className="w-fit rounded-lg bg-white p-2">
            <QRCodeSVG
              value={verificationAddress}
              size={176}
              bgColor="#ffffff"
              fgColor="#111827"
              level="M"
              marginSize={1}
              title="光鸭官方扫码登录二维码"
            />
          </div>
          <div>
            <p className="text-sm font-medium">使用光鸭 APP 扫描并确认登录</p>
            {authorization.userCode && <p className="mt-2 text-xs text-muted-foreground">确认码 <span className="font-mono font-semibold text-foreground">{authorization.userCode}</span></p>}
            <p className="mt-2 text-[11px] text-muted-foreground">二维码有效期至 {new Date(authorization.expiresAt).toLocaleTimeString("zh-CN")}</p>
            <a href={verificationAddress} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground">
              <ExternalLink className="size-3.5" /> 无法扫码时打开官方确认页
            </a>
          </div>
        </div>
      )}

      {authorization?.status === "authorized" && (
        <p className="mt-4 text-sm text-success">已完成扫码登录{authorization.accountLabel ? `，账号 ${authorization.accountLabel}` : ""}。</p>
      )}
      {(authorization?.status === "expired" || authorization?.status === "failed") && (
        <p className="mt-4 text-sm text-destructive">{authorization.errorMessage || "本次扫码登录未完成，请重新登录"}</p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        {authorization ? (
          <SecondaryButton type="button" disabled={starting || authorization.status === "pending"} onClick={() => void startAuthorization()}>
            {starting ? <LoaderCircle className="size-4 animate-spin" /> : <RotateCcw className="size-4" />}
            重新扫码登录
          </SecondaryButton>
        ) : (
          <PrimaryButton type="button" disabled={starting} onClick={() => void startAuthorization()}>
            {starting ? <LoaderCircle className="size-4 animate-spin" /> : <LogIn className="size-4" />}
            {starting ? "正在获取…" : "使用光鸭扫码登录"}
          </PrimaryButton>
        )}
        {message && <p className="text-xs text-muted-foreground">{message}</p>}
      </div>
    </div>
  );
}
