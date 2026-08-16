import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ConsoleShell } from "@/components/ConsoleShell";
import { ApiClientError, getCurrentUser, getSetupStatus, type AuthRole, type AuthUser } from "@/lib/api";

type SessionState =
  | { status: "loading" }
  | { status: "ready"; user: AuthUser }
  | { status: "forbidden" }
  | { status: "error"; message: string };

/**
 * 校验 Web 会话和角色后再渲染控制台，防止仅靠隐藏菜单控制访问。
 */
export function SessionBoundary({ requiredRole }: { requiredRole: AuthRole }) {
  const navigate = useNavigate();
  const [sessionState, setSessionState] = useState<SessionState>({ status: "loading" });
  // 关键变量：用户主动重连时递增，使会话校验流程重新执行。
  const [retryVersion, setRetryVersion] = useState(0);

  useEffect(() => {
    let active = true;

    /** 查询当前用户并执行客户端路由保护。 */
    async function resolveSession(): Promise<void> {
      try {
        const setupState = await getSetupStatus();
        if (setupState.setupRequired) {
          await navigate({ to: "/setup", replace: true });
          return;
        }
        const user = await getCurrentUser();
        if (!active) {
          return;
        }
        if (setupState.credentialKeyBackupRequired) {
          if (user.role === "super_admin") {
            await navigate({ to: "/setup", replace: true });
          } else {
            setSessionState({ status: "error", message: "实例正在等待超级管理员完成凭据主密钥备份" });
          }
          return;
        }
        if (requiredRole === "super_admin" && user.role !== "super_admin") {
          setSessionState({ status: "forbidden" });
          return;
        }
        setSessionState({ status: "ready", user });
      } catch (error) {
        if (!active) {
          return;
        }
        if (error instanceof ApiClientError && error.code === "setup_required") {
          await navigate({ to: "/setup", replace: true });
          return;
        }
        if (error instanceof ApiClientError && error.status === 401) {
          await navigate({ to: "/login", replace: true });
          return;
        }
        setSessionState({
          status: "error",
          message: error instanceof Error ? error.message : "无法校验登录状态",
        });
      }
    }

    void resolveSession();
    return () => {
      active = false;
    };
  }, [navigate, requiredRole, retryVersion]);

  if (sessionState.status === "loading") {
    return <CenteredState title="正在验证登录状态" description="正在连接 FlyCloudHelper API…" />;
  }
  if (sessionState.status === "forbidden") {
    return <CenteredState title="无权访问管理后台" description="当前账号不是超级管理员。" />;
  }
  if (sessionState.status === "error") {
    return (
      <CenteredState
        title="无法进入控制台"
        description={sessionState.message}
        onRetry={() => {
          setSessionState({ status: "loading" });
          setRetryVersion((currentVersion) => currentVersion + 1);
        }}
      />
    );
  }

  return (
    <ConsoleShell
      role={requiredRole}
      username={sessionState.user.username}
      actualRole={sessionState.user.role}
    />
  );
}

/** 显示认证加载、无权限或连接失败状态。 */
function CenteredState({
  title,
  description,
  onRetry,
}: {
  title: string;
  description: string;
  onRetry?: () => void;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="surface max-w-md p-8 text-center">
        <h1 className="text-xl font-semibold">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{description}</p>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="mt-6 rounded-lg border border-border bg-secondary px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-secondary/80"
          >
            重新连接
          </button>
        )}
      </div>
    </div>
  );
}
