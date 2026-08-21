import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import {
  Activity,
  Bell,
  ChevronRight,
  HardDrive,
  LayoutDashboard,
  LibraryBig,
  ListChecks,
  Menu,
  Puzzle,
  ScrollText,
  Search,
  ServerCog,
  Settings2,
  Users,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ComponentType, type ReactNode } from "react";
import {
  clearNotifications,
  deleteNotification,
  listNotifications,
  logout,
  type AuthRole,
  type ConsoleNotification,
  type ConsoleNotificationTone,
} from "@/lib/api";
import { useApiResource } from "@/lib/use-api-resource";
import { cn } from "@/lib/utils";
import { StatusPill } from "@/components/ui-kit";

interface NavigationItem {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
}

const notificationCategoryLabels: Record<ConsoleNotification["category"], string> = {
  task: "任务",
  security: "敏感操作",
  system: "系统",
};

const notificationToneClasses: Record<ConsoleNotificationTone, string> = {
  info: "bg-primary",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-destructive",
};

/** 把通知时间格式化为当前浏览器所在时区的中文时间。 */
function formatNotificationTime(createdAt: string): string {
  return new Date(createdAt).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 普通用户控制台导航。 */
const userNavigation: NavigationItem[] = [
  { to: "/app", label: "概览", icon: LayoutDashboard },
  { to: "/app/services", label: "我的服务", icon: HardDrive },
  { to: "/app/jobs", label: "扫描任务", icon: ListChecks },
  { to: "/app/catalog", label: "媒体库", icon: LibraryBig },
];

/** 超级管理员后台导航。 */
const adminNavigation: NavigationItem[] = [
  { to: "/admin", label: "管理概览", icon: Activity },
  { to: "/admin/users", label: "用户管理", icon: Users },
  { to: "/admin/services", label: "全部服务", icon: HardDrive },
  { to: "/admin/jobs", label: "扫描任务", icon: ListChecks },
  { to: "/admin/catalog", label: "媒体库", icon: LibraryBig },
  { to: "/admin/plugins", label: "插件管理", icon: Puzzle },
  { to: "/admin/config", label: "系统配置", icon: Settings2 },
  { to: "/admin/system", label: "系统状态", icon: ServerCog },
  { to: "/admin/audit", label: "审计日志", icon: ScrollText },
];

/** 判断导航项是否与当前路由匹配。 */
function isNavigationActive(currentPath: string, targetPath: string): boolean {
  if (targetPath === "/app" || targetPath === "/admin") {
    return currentPath === targetPath || currentPath === `${targetPath}/`;
  }
  return currentPath === targetPath || currentPath.startsWith(`${targetPath}/`);
}

/** 渲染指定角色的控制台导航。 */
function NavigationList({
  items,
  onNavigate,
}: {
  items: NavigationItem[];
  onNavigate?: () => void;
}) {
  const currentPath = useRouterState({ select: (state) => state.location.pathname });

  return (
    <nav>
      <ul className="space-y-1">
        {items.map(({ to, label, icon: Icon }) => {
          const active = isNavigationActive(currentPath, to);
          return (
            <li key={to}>
              <Link
                to={to}
                onClick={onNavigate}
                className={cn(
                  "group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors",
                  active
                    ? "bg-primary/15 text-foreground"
                    : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
                )}
              >
                <Icon className={cn("size-4 shrink-0", active && "text-primary-soft")} />
                <span className="truncate">{label}</span>
                {active && <span className="ml-auto h-4 w-0.5 rounded-full bg-primary" />}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** 渲染 FlyCloudHelper 品牌标识。 */
function Brand() {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <img
        src="/flycloud-helper-icon.png"
        alt="FlyCloudHelper"
        className="size-9 shrink-0 rounded-xl object-cover"
      />
      <div className="min-w-0">
        <p className="font-display truncate text-sm font-semibold">FlyCloudHelper</p>
        <p className="truncate text-[10px] tracking-wider text-muted-foreground">
          云端媒体扫描与目录服务
        </p>
      </div>
    </div>
  );
}

/**
 * 渲染普通用户或超级管理员的控制台框架。
 */
export function ConsoleShell({
  role,
  username,
  actualRole,
}: {
  role: AuthRole;
  username: string;
  actualRole: AuthRole;
}) {
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const [notificationOpen, setNotificationOpen] = useState(false);
  const [notificationActionId, setNotificationActionId] = useState<string | null>(null);
  const [notificationError, setNotificationError] = useState<string | null>(null);
  const notificationPanelRef = useRef<HTMLDivElement | null>(null);
  // 关键变量：同步占用清除操作，避免 React 按钮状态刷新前重复提交。
  const notificationActionRef = useRef<string | null>(null);
  const notifications = useApiResource(() => listNotifications(30), []);
  const navigationItems = role === "super_admin" ? adminNavigation : userNavigation;
  const notificationItems = notifications.data ?? [];

  useEffect(() => {
    // 通知不要求扫描进度级实时性，每 10 秒检查一次任务完成与敏感操作。
    const timer = window.setInterval(() => void notifications.refresh(), 10_000);
    return () => window.clearInterval(timer);
  }, [notifications.refresh]);

  useEffect(() => {
    if (!notificationOpen) return;
    /** 点击通知面板之外的区域时收起面板。 */
    function closeNotificationPanel(event: MouseEvent): void {
      if (!notificationPanelRef.current?.contains(event.target as Node)) {
        setNotificationOpen(false);
      }
    }
    document.addEventListener("mousedown", closeNotificationPanel);
    return () => document.removeEventListener("mousedown", closeNotificationPanel);
  }, [notificationOpen]);

  /** 清除一条当前账号通知，并拦截重复操作。 */
  async function removeNotification(notificationId: string): Promise<void> {
    if (notificationActionRef.current !== null) return;
    notificationActionRef.current = notificationId;
    setNotificationActionId(notificationId);
    setNotificationError(null);
    try {
      await deleteNotification(notificationId);
      await notifications.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "通知清除失败";
      console.warn("codex-flycloud-notification", {
        事件: "网页清除单条通知失败",
        通知ID: notificationId,
        错误信息: errorMessage,
      });
      setNotificationError(errorMessage);
    } finally {
      notificationActionRef.current = null;
      setNotificationActionId(null);
    }
  }

  /** 清除当前账号全部通知，并拦截清除期间的其他操作。 */
  async function removeAllNotifications(): Promise<void> {
    if (notificationActionRef.current !== null || notificationItems.length === 0) return;
    notificationActionRef.current = "all";
    setNotificationActionId("all");
    setNotificationError(null);
    try {
      await clearNotifications();
      await notifications.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "全部通知清除失败";
      console.warn("codex-flycloud-notification", {
        事件: "网页清除全部通知失败",
        错误信息: errorMessage,
      });
      setNotificationError(errorMessage);
    } finally {
      notificationActionRef.current = null;
      setNotificationActionId(null);
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <div
        className="pointer-events-none fixed inset-x-0 top-0 h-[420px]"
        style={{ backgroundImage: "var(--gradient-glow)" }}
      />

      <aside className="fixed top-0 bottom-0 left-0 z-30 hidden w-[248px] flex-col border-r border-sidebar-border bg-sidebar/80 px-4 py-6 backdrop-blur-xl lg:flex">
        <Brand />
        <div className="mt-9 flex-1 overflow-y-auto">
          <p className="px-3 pb-2 text-[10px] tracking-[0.22em] text-muted-foreground uppercase">
            {role === "super_admin" ? "超级管理员" : "个人控制台"}
          </p>
          <NavigationList items={navigationItems} />
        </div>
        <div className="mt-4 space-y-3">
          <div className="rounded-xl border border-border bg-secondary/50 p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] text-muted-foreground">SSE 实时连接</p>
              <StatusPill tone="success">正常</StatusPill>
            </div>
            <p className="mt-2 font-mono text-[10px] text-muted-foreground">最后更新 14:07:22</p>
          </div>
          {actualRole === "super_admin" && (
            <Link
              to={role === "super_admin" ? "/app" : "/admin"}
              className="block rounded-lg border border-border px-3 py-2.5 text-center text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              {role === "super_admin" ? "进入个人控制台" : "进入管理后台"}
            </Link>
          )}
          <button
            type="button"
            onClick={() => {
              void logout().finally(() => {
                window.location.assign("/login");
              });
            }}
            className="w-full rounded-lg border border-border px-3 py-2.5 text-center text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            退出登录
          </button>
        </div>
      </aside>

      {mobileNavigationOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            aria-label="关闭导航遮罩"
            onClick={() => setMobileNavigationOpen(false)}
            className="absolute inset-0 bg-background/80 backdrop-blur-sm"
          />
          <div className="absolute top-0 bottom-0 left-0 w-[272px] border-r border-sidebar-border bg-sidebar px-4 py-6">
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
              <Brand />
              <button
                type="button"
                aria-label="关闭导航"
                onClick={() => setMobileNavigationOpen(false)}
                className="grid size-8 shrink-0 place-items-center rounded-lg border border-border text-muted-foreground"
              >
                <X className="size-4" />
              </button>
            </div>
            <div className="mt-8">
              <NavigationList
                items={navigationItems}
                onNavigate={() => setMobileNavigationOpen(false)}
              />
            </div>
          </div>
        </div>
      )}

      <div className="lg:pl-[248px]">
        <header className="sticky top-0 z-20 border-b border-border bg-background/70 backdrop-blur-xl">
          <div className="mx-auto grid max-w-[1400px] grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-3.5 sm:px-6">
            <div className="flex min-w-0 items-center gap-3">
              <button
                type="button"
                aria-label="打开导航"
                onClick={() => setMobileNavigationOpen(true)}
                className="grid size-9 shrink-0 place-items-center rounded-lg border border-border text-muted-foreground lg:hidden"
              >
                <Menu className="size-4" />
              </button>
              <div className="hidden items-center gap-1.5 text-[11px] text-muted-foreground sm:flex">
                <span>{role === "super_admin" ? "超级管理员" : "个人控制台"}</span>
                <ChevronRight className="size-3" />
                <span className="text-foreground/80">FlyCloudHelper</span>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <div className="hidden items-center gap-2 rounded-lg border border-border bg-secondary/50 px-3 py-2 md:flex">
                <Search className="size-3.5 text-muted-foreground" />
                <input
                  aria-label="全局搜索"
                  placeholder="搜索服务、任务、媒体"
                  className="w-44 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
                />
              </div>
              <div ref={notificationPanelRef} className="relative">
                <button
                  type="button"
                  aria-label="通知"
                  aria-expanded={notificationOpen}
                  onClick={() => {
                    setNotificationOpen((current) => !current);
                    if (!notificationOpen) void notifications.refresh();
                  }}
                  className="relative grid size-9 place-items-center rounded-lg border border-border text-muted-foreground transition-colors hover:text-foreground"
                >
                  <Bell className="size-4" />
                  {notificationItems.length > 0 && <span className="absolute top-2 right-2.5 size-1.5 rounded-full bg-destructive" />}
                </button>
                {notificationOpen && (
                  <div className="absolute top-11 right-0 z-50 w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-border bg-background shadow-2xl">
                    <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
                      <div>
                        <p className="text-sm font-semibold">通知</p>
                        <p className="mt-0.5 text-[11px] text-muted-foreground">共 {notificationItems.length} 条</p>
                      </div>
                      <button
                        type="button"
                        disabled={notificationItems.length === 0 || notificationActionId !== null}
                        onClick={() => void removeAllNotifications()}
                        className="text-xs text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {notificationActionId === "all" ? "正在清除…" : "全部清除"}
                      </button>
                    </div>
                    {notificationError && <p className="border-b border-border px-4 py-2 text-xs text-destructive">{notificationError}</p>}
                    <div className="max-h-[min(30rem,70vh)] overflow-y-auto">
                      {notifications.loading && notificationItems.length === 0 && <p className="px-4 py-10 text-center text-xs text-muted-foreground">正在读取通知…</p>}
                      {!notifications.loading && notificationItems.length === 0 && <p className="px-4 py-10 text-center text-xs text-muted-foreground">暂无通知</p>}
                      {notificationItems.map((notification) => {
                        const content = (
                          <>
                            <div className="flex items-center gap-2">
                              <span className={cn("size-2 shrink-0 rounded-full", notificationToneClasses[notification.tone])} />
                              <span className="text-[10px] text-muted-foreground">{notificationCategoryLabels[notification.category]}</span>
                              <span className="ml-auto text-[10px] text-muted-foreground">{formatNotificationTime(notification.createdAt)}</span>
                            </div>
                            <p className="mt-2 pr-7 text-sm font-medium text-foreground">{notification.title}</p>
                            <p className="mt-1 pr-7 text-xs leading-5 text-muted-foreground">{notification.message}</p>
                            {notification.actionPath && <p className="mt-2 text-[11px] text-primary-soft">查看详情</p>}
                          </>
                        );
                        return (
                          <article key={notification.id} className="relative border-b border-border px-4 py-3 last:border-b-0 hover:bg-secondary/35">
                            {notification.actionPath ? <a href={notification.actionPath} onClick={() => setNotificationOpen(false)}>{content}</a> : content}
                            <button
                              type="button"
                              aria-label={`清除通知：${notification.title}`}
                              title="清除这条通知"
                              disabled={notificationActionId !== null}
                              onClick={() => void removeNotification(notification.id)}
                              className="absolute right-3 top-9 grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              <X className="size-3.5" />
                            </button>
                          </article>
                        );
                      })}
                    </div>
                    {notifications.error && <p className="border-t border-border px-4 py-2 text-xs text-destructive">{notifications.error}</p>}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2 rounded-lg border border-border bg-secondary/50 py-1.5 pr-3 pl-1.5">
                <span
                  className="grid size-6 place-items-center rounded-md text-[11px] font-semibold text-primary-foreground"
                  style={{ backgroundImage: "var(--gradient-primary)" }}
                >
                  C
                </span>
                <span className="hidden text-xs sm:block">{username}</span>
                <StatusPill tone="primary" className="hidden md:inline-flex">
                  {role === "super_admin" ? "超级管理员" : "普通用户"}
                </StatusPill>
              </div>
            </div>
          </div>
        </header>

        <main className="relative mx-auto max-w-[1400px] px-4 pt-6 pb-16 sm:px-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

/** 页面标题和操作区；页面级标题不再显示说明性副标题。 */
export function PageHeader({
  title,
  actions,
}: {
  title: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold sm:text-2xl">{title}</h1>
      </div>
      {actions && <div className="flex flex-wrap gap-2 sm:justify-end">{actions}</div>}
    </div>
  );
}

/** 主要操作按钮。 */
export function PrimaryButton({
  children,
  type = "button",
  ...buttonProps
}: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }) {
  return (
    <button
      type={type}
      {...buttonProps}
      className="glow-ring inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium text-primary-foreground transition-transform hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:translate-y-0"
      style={{ backgroundImage: "var(--gradient-primary)" }}
    >
      {children}
    </button>
  );
}

/** 次要操作按钮。 */
export function SecondaryButton({
  children,
  type = "button",
  ...buttonProps
}: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }) {
  return (
    <button
      type={type}
      {...buttonProps}
      className="inline-flex items-center justify-center gap-2 rounded-lg border border-border bg-secondary/50 px-4 py-2.5 text-sm text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}
