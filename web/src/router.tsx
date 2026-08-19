import {
  Link,
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  useNavigate,
} from "@tanstack/react-router";
import { ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { SessionBoundary } from "@/components/SessionBoundary";
import { ApiClientError, getCurrentUser, getSetupStatus } from "@/lib/api";
import { SetupPage, LoginPage, RegisterPage } from "@/pages/AuthPages";
import { OverviewPage } from "@/pages/OverviewPage";
import {
  AdminServiceCatalogPage,
  AdminServiceCreatePage,
  AdminServiceDetailPage,
  AdminServicesPage,
  ServiceCreatePage,
  UserServiceCatalogPage,
  UserServiceDetailPage,
  UserServicesPage,
} from "@/pages/ServicePages";
import {
  AdminCatalogPage,
  AdminJobsPage,
  UserCatalogPage,
  UserJobsPage,
} from "@/pages/JobCatalogPages";
import {
  AdminAuditPage,
  AdminConfigurationPage,
  AdminOverviewPage,
  AdminPluginsPage,
  AdminSystemPage,
  AdminUsersPage,
} from "@/pages/AdminPages";

/** 根路由容器。 */
function RootRouteComponent() {
  return <Outlet />;
}

/** 普通用户控制台路由容器。 */
function UserConsoleRouteComponent() {
  return <SessionBoundary requiredRole="user" />;
}

/** 超级管理员后台路由容器。 */
function AdminConsoleRouteComponent() {
  return <SessionBoundary requiredRole="super_admin" />;
}

/** 根路径根据初始化状态和当前会话进入正确入口。 */
function RootIndexRouteComponent() {
  const navigate = useNavigate();
  const [message, setMessage] = useState("正在确认实例状态…");

  useEffect(() => {
    let active = true;

    /** 依次判断首次初始化状态和当前登录角色。 */
    async function resolveRootDestination(): Promise<void> {
      try {
        const setupState = await getSetupStatus();
        if (!active) {
          return;
        }
        if (setupState.setupRequired) {
          await navigate({ to: "/setup", replace: true });
          return;
        }

        try {
          const user = await getCurrentUser();
          if (!active) {
            return;
          }
          if (setupState.credentialKeyBackupRequired) {
            if (user.role === "super_admin") {
              await navigate({ to: "/setup", replace: true });
            } else {
              setMessage("实例正在等待超级管理员完成凭据主密钥备份");
            }
            return;
          }
          await navigate({
            to: user.role === "super_admin" ? "/admin" : "/app",
            replace: true,
          });
        } catch (error) {
          if (error instanceof ApiClientError && error.status === 401) {
            await navigate({ to: "/login", replace: true });
            return;
          }
          throw error;
        }
      } catch (error) {
        if (active) {
          setMessage(error instanceof Error ? error.message : "无法读取实例状态");
        }
      }
    }

    void resolveRootDestination();
    return () => {
      active = false;
    };
  }, [navigate]);

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="surface max-w-md p-8 text-center">
        <h1 className="text-xl font-semibold">正在进入 FlyCloudHelper</h1>
        <p className="mt-2 text-sm text-muted-foreground">{message}</p>
      </div>
    </div>
  );
}

/** 接收光鸭官方人机验证回调，把一次性结果发送给打开本窗口的服务配置页。 */
function GuangyaCaptchaCallbackPage() {
  const [message, setMessage] = useState("正在确认光鸭人机验证结果…");

  useEffect(() => {
    const parameters = new URLSearchParams(window.location.search);
    const captchaToken = parameters.get("captcha_token") ?? "";
    const state = parameters.get("state") ?? "";
    if (!captchaToken || !state || !window.opener) {
      setMessage("未收到有效的人机验证结果，请关闭窗口后重新获取验证码");
      return;
    }
    window.opener.postMessage({
      type: "flycloud-helper-guangya-captcha",
      captchaToken,
      state,
    }, window.location.origin);
    setMessage("人机验证已完成，正在关闭窗口…");
    const closeTimer = window.setTimeout(() => window.close(), 300);
    return () => window.clearTimeout(closeTimer);
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="surface max-w-md p-8 text-center">
        <ShieldCheck className="mx-auto size-10 text-success" />
        <h1 className="mt-4 text-xl font-semibold">光鸭人机验证</h1>
        <p className="mt-2 text-sm text-muted-foreground">{message}</p>
      </div>
    </div>
  );
}

/** 处理普通用户服务详情路由参数。 */
function UserServiceDetailRouteComponent() {
  const { serviceId } = userServiceDetailRoute.useParams();
  return <UserServiceDetailPage serviceId={serviceId} />;
}

/** 处理普通用户服务海报墙路由参数。 */
function UserServiceCatalogRouteComponent() {
  const { serviceId } = userServiceCatalogRoute.useParams();
  return <UserServiceCatalogPage serviceId={serviceId} />;
}

/** 处理管理员服务详情路由参数。 */
function AdminServiceDetailRouteComponent() {
  const { serviceId } = adminServiceDetailRoute.useParams();
  return <AdminServiceDetailPage serviceId={serviceId} />;
}

/** 处理管理员服务海报墙路由参数。 */
function AdminServiceCatalogRouteComponent() {
  const { serviceId } = adminServiceCatalogRoute.useParams();
  return <AdminServiceCatalogPage serviceId={serviceId} />;
}

/** 全局 404 页面。 */
function NotFoundPage() {
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="surface max-w-md p-8 text-center">
        <p className="font-display text-6xl font-semibold text-gradient">404</p>
        <h1 className="mt-4 text-xl font-semibold">页面不存在</h1>
        <p className="mt-2 text-sm text-muted-foreground">页面已移动、链接无效，或当前版本尚未实现该页面。</p>
        <Link
          to="/login"
          className="mt-6 inline-flex rounded-lg bg-primary px-4 py-2.5 text-sm text-primary-foreground"
        >
          返回登录
        </Link>
      </div>
    </div>
  );
}

const rootRoute = createRootRoute({
  component: RootRouteComponent,
  notFoundComponent: NotFoundPage,
});

const rootIndexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: RootIndexRouteComponent,
});

const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "setup",
  component: SetupPage,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "login",
  component: LoginPage,
});

const registerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "register",
  component: RegisterPage,
});

const guangyaCaptchaCallbackRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "guangya-captcha-callback",
  component: GuangyaCaptchaCallbackPage,
});

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "app",
  component: UserConsoleRouteComponent,
});

const appIndexRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/",
  component: OverviewPage,
});

const userServicesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "services",
  component: UserServicesPage,
});

const userServiceCreateRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "services/new",
  component: ServiceCreatePage,
});

const userServiceDetailRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "services/$serviceId",
  component: UserServiceDetailRouteComponent,
});

const userServiceCatalogRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "services/$serviceId/catalog",
  component: UserServiceCatalogRouteComponent,
});

const userJobsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "jobs",
  component: UserJobsPage,
});

const userCatalogRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "catalog",
  component: UserCatalogPage,
});

const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "admin",
  component: AdminConsoleRouteComponent,
});

const adminIndexRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/",
  component: AdminOverviewPage,
});

const adminUsersRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "users",
  component: AdminUsersPage,
});

const adminServicesRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "services",
  component: AdminServicesPage,
});

const adminServiceCreateRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "services/new",
  component: AdminServiceCreatePage,
});

const adminServiceDetailRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "services/$serviceId",
  component: AdminServiceDetailRouteComponent,
});

const adminServiceCatalogRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "services/$serviceId/catalog",
  component: AdminServiceCatalogRouteComponent,
});

const adminJobsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "jobs",
  component: AdminJobsPage,
});

const adminCatalogRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "catalog",
  component: AdminCatalogPage,
});

const adminPluginsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "plugins",
  component: AdminPluginsPage,
});

const adminSystemRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "system",
  component: AdminSystemPage,
});

const adminConfigurationRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "config",
  component: AdminConfigurationPage,
});

const adminAuditRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "audit",
  component: AdminAuditPage,
});

/** 组合普通用户控制台子路由。 */
const appRouteTree = appRoute.addChildren([
  appIndexRoute,
  userServicesRoute,
  userServiceCreateRoute,
  userServiceDetailRoute,
  userServiceCatalogRoute,
  userJobsRoute,
  userCatalogRoute,
]);

/** 组合超级管理员后台子路由。 */
const adminRouteTree = adminRoute.addChildren([
  adminIndexRoute,
  adminUsersRoute,
  adminServicesRoute,
  adminServiceCreateRoute,
  adminServiceDetailRoute,
  adminServiceCatalogRoute,
  adminJobsRoute,
  adminCatalogRoute,
  adminPluginsRoute,
  adminConfigurationRoute,
  adminSystemRoute,
  adminAuditRoute,
]);

/** FlyCloudHelper Web 完整路由树。 */
const routeTree = rootRoute.addChildren([
  rootIndexRoute,
  setupRoute,
  loginRoute,
  registerRoute,
  guangyaCaptchaCallbackRoute,
  appRouteTree,
  adminRouteTree,
]);

/** FlyCloudHelper Web 路由实例。 */
export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  scrollRestoration: true,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
