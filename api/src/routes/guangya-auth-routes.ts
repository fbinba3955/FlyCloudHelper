import type { FastifyInstance } from "fastify";
import { requireRequestUser, requireString, requireSuperAdmin } from "../http.js";
import type { ApiRuntime } from "../runtime.js";

/** 记录光鸭扫码会话结束状态，避免等待阶段重复输出日志。 */
function logAuthorizationResult(
  runtime: ApiRuntime,
  actor: { id: string; role: string },
  authorization: { authorizationSessionId: string; status: string },
): void {
  if (authorization.status === "pending") return;
  runtime.logBusinessEvent(authorization.status === "authorized" ? "info" : "warn", {
    日志关键字: "codex-flycloud-helper-guangya-auth",
    事件: authorization.status === "authorized" ? "光鸭扫码登录完成" : "光鸭扫码登录结束",
    操作者ID: actor.id,
    操作者角色: actor.role,
    授权会话ID: authorization.authorizationSessionId,
    授权状态: authorization.status,
  });
}

/** 注册普通用户和管理员使用的光鸭官方网页扫码登录接口。 */
export async function registerGuangyaAuthRoutes(server: FastifyInstance, runtime: ApiRuntime): Promise<void> {
  server.post("/api/v1/providers/guangya/auth-sessions", async (request, reply) => {
    const user = await requireRequestUser(request, runtime.database);
    const authorization = await runtime.providers.guangyaAuthorization.start(user.id, user.id);
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-flycloud-helper-guangya-auth",
      事件: "用户启动光鸭官方扫码登录",
      用户ID: user.id,
      授权会话ID: authorization.authorizationSessionId,
      过期时间: authorization.expiresAt,
      轮询间隔秒: authorization.intervalSeconds,
    });
    return reply.status(201).send(authorization);
  });

  server.get<{ Params: { authorizationSessionId: string } }>(
    "/api/v1/providers/guangya/auth-sessions/:authorizationSessionId",
    async (request) => {
      const user = await requireRequestUser(request, runtime.database);
      const authorization = await runtime.providers.guangyaAuthorization.poll(
        user.id,
        request.params.authorizationSessionId,
      );
      logAuthorizationResult(runtime, user, authorization);
      return authorization;
    },
  );

  server.post<{ Body: Record<string, unknown> }>(
    "/api/v1/admin/providers/guangya/auth-sessions",
    async (request, reply) => {
      const operator = await requireSuperAdmin(request, runtime.database);
      const targetUserId = requireString(request.body, "userId", "目标用户 ID", 100);
      await runtime.database.findPublicUserById(targetUserId);
      const authorization = await runtime.providers.guangyaAuthorization.start(operator.id, targetUserId);
      runtime.logBusinessEvent("info", {
        日志关键字: "codex-flycloud-helper-guangya-auth",
        事件: "管理员代用户启动光鸭官方扫码登录",
        管理员ID: operator.id,
        目标用户ID: targetUserId,
        授权会话ID: authorization.authorizationSessionId,
        过期时间: authorization.expiresAt,
        轮询间隔秒: authorization.intervalSeconds,
      });
      return reply.status(201).send(authorization);
    },
  );

  server.get<{ Params: { authorizationSessionId: string } }>(
    "/api/v1/admin/providers/guangya/auth-sessions/:authorizationSessionId",
    async (request) => {
      const operator = await requireSuperAdmin(request, runtime.database);
      const authorization = await runtime.providers.guangyaAuthorization.poll(
        operator.id,
        request.params.authorizationSessionId,
      );
      logAuthorizationResult(runtime, operator, authorization);
      return authorization;
    },
  );
}
