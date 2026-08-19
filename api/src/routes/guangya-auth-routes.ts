import type { FastifyInstance, FastifyRequest } from "fastify";
import { ApiError } from "../errors.js";
import { requireRequestUser, requireString, requireSuperAdmin } from "../http.js";
import type { ApiRuntime } from "../runtime.js";

/** 记录光鸭扫码会话结束状态，避免等待阶段重复输出日志。 */
function logAuthorizationResult(
  runtime: ApiRuntime,
  actor: { id: string; role: string },
  authorization: { authorizationSessionId: string; authMethod: "qr" | "sms"; status: string },
): void {
  if (authorization.status === "pending") return;
  const isSms = authorization.authMethod === "sms";
  runtime.logBusinessEvent(authorization.status === "authorized" ? "info" : "warn", {
    日志关键字: isSms
      ? "codex-flycloud-helper-guangya-sms-auth"
      : "codex-flycloud-helper-guangya-qr-auth",
    事件: authorization.status === "authorized"
      ? isSms ? "光鸭网页验证码登录完成" : "光鸭网页二维码登录完成"
      : isSms ? "光鸭网页验证码登录结束" : "光鸭网页二维码登录结束",
    操作者ID: actor.id,
    操作者角色: actor.role,
    授权会话ID: authorization.authorizationSessionId,
    授权状态: authorization.status,
  });
}

/** 校验人机验证回调必须回到本次 FlyCloudHelper 页面来源，避免一次性 Token 被重定向到第三方站点。 */
function requireCaptchaRedirectUri(request: FastifyRequest, body: Record<string, unknown>): string {
  const redirectUri = requireString(body, "captchaRedirectUri", "人机验证回调地址", 1_000);
  const requestOrigin = request.headers.origin;
  if (!requestOrigin) {
    throw new ApiError(422, "guangya_captcha_origin_missing", "只能从 FlyCloudHelper 前台启动光鸭网页验证码登录");
  }
  let parsedRedirectUri: URL;
  let parsedRequestOrigin: URL;
  try {
    parsedRedirectUri = new URL(redirectUri);
    parsedRequestOrigin = new URL(requestOrigin);
  } catch {
    throw new ApiError(422, "guangya_captcha_redirect_invalid", "人机验证回调地址无效");
  }
  if ((parsedRedirectUri.protocol !== "http:" && parsedRedirectUri.protocol !== "https:")
    || parsedRedirectUri.origin !== parsedRequestOrigin.origin
    || parsedRedirectUri.pathname !== "/guangya-captcha-callback") {
    throw new ApiError(422, "guangya_captcha_redirect_invalid", "人机验证回调地址必须返回当前 FlyCloudHelper 页面");
  }
  return parsedRedirectUri.toString();
}

/** 注册普通用户和管理员使用的光鸭网页二维码、网页验证码登录接口。 */
export async function registerGuangyaAuthRoutes(server: FastifyInstance, runtime: ApiRuntime): Promise<void> {
  server.post("/api/v1/providers/guangya/auth-sessions", async (request, reply) => {
    const user = await requireRequestUser(request, runtime.database);
    const authorization = await runtime.providers.guangyaAuthorization.start(user.id, user.id);
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-flycloud-helper-guangya-qr-auth",
      事件: "用户启动光鸭网页二维码登录",
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
    "/api/v1/providers/guangya/sms-auth-sessions",
    async (request, reply) => {
      const user = await requireRequestUser(request, runtime.database);
      runtime.logBusinessEvent("info", {
        日志关键字: "codex-flycloud-helper-guangya-sms-auth",
        事件: "后台收到用户验证码发送请求",
        用户ID: user.id,
      });
      const authorization = await runtime.providers.guangyaAuthorization.startSms(
        user.id,
        user.id,
        requireString(request.body, "phoneNumber", "手机号", 20),
        requireCaptchaRedirectUri(request, request.body),
      );
      runtime.logBusinessEvent("info", {
        日志关键字: "codex-flycloud-helper-guangya-sms-auth",
        事件: "用户发送光鸭网页登录验证码",
        用户ID: user.id,
        授权会话ID: authorization.authorization?.authorizationSessionId
          ?? authorization.captcha?.captchaSessionId
          ?? "",
        是否需要人机交互: Boolean(authorization.captcha),
      });
      return reply.status(201).send(authorization);
    },
  );

  server.post<{ Params: { captchaSessionId: string }; Body: Record<string, unknown> }>(
    "/api/v1/providers/guangya/sms-auth-sessions/:captchaSessionId/captcha",
    async (request) => {
      const user = await requireRequestUser(request, runtime.database);
      const captchaToken = typeof request.body.captchaToken === "string" ? request.body.captchaToken : null;
      const authorization = await runtime.providers.guangyaAuthorization.completeSmsCaptcha(
        user.id,
        request.params.captchaSessionId,
        captchaToken,
      );
      runtime.logBusinessEvent("info", {
        日志关键字: "codex-flycloud-helper-guangya-sms-auth",
        事件: "用户完成人机验证并发送光鸭验证码",
        用户ID: user.id,
        授权会话ID: authorization.authorizationSessionId,
      });
      return authorization;
    },
  );

  server.post<{ Params: { authorizationSessionId: string }; Body: Record<string, unknown> }>(
    "/api/v1/providers/guangya/sms-auth-sessions/:authorizationSessionId/verify",
    async (request) => {
      const user = await requireRequestUser(request, runtime.database);
      const authorization = await runtime.providers.guangyaAuthorization.verifySms(
        user.id,
        request.params.authorizationSessionId,
        requireString(request.body, "verificationCode", "短信验证码", 8),
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
        日志关键字: "codex-flycloud-helper-guangya-qr-auth",
        事件: "管理员代用户启动光鸭网页二维码登录",
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

  server.post<{ Body: Record<string, unknown> }>(
    "/api/v1/admin/providers/guangya/sms-auth-sessions",
    async (request, reply) => {
      const operator = await requireSuperAdmin(request, runtime.database);
      const targetUserId = requireString(request.body, "userId", "目标用户 ID", 100);
      await runtime.database.findPublicUserById(targetUserId);
      runtime.logBusinessEvent("info", {
        日志关键字: "codex-flycloud-helper-guangya-sms-auth",
        事件: "后台收到管理员验证码发送请求",
        管理员ID: operator.id,
        目标用户ID: targetUserId,
      });
      const authorization = await runtime.providers.guangyaAuthorization.startSms(
        operator.id,
        targetUserId,
        requireString(request.body, "phoneNumber", "手机号", 20),
        requireCaptchaRedirectUri(request, request.body),
      );
      runtime.logBusinessEvent("info", {
        日志关键字: "codex-flycloud-helper-guangya-sms-auth",
        事件: "管理员代用户发送光鸭网页登录验证码",
        管理员ID: operator.id,
        目标用户ID: targetUserId,
        授权会话ID: authorization.authorization?.authorizationSessionId
          ?? authorization.captcha?.captchaSessionId
          ?? "",
        是否需要人机交互: Boolean(authorization.captcha),
      });
      return reply.status(201).send(authorization);
    },
  );

  server.post<{ Params: { captchaSessionId: string }; Body: Record<string, unknown> }>(
    "/api/v1/admin/providers/guangya/sms-auth-sessions/:captchaSessionId/captcha",
    async (request) => {
      const operator = await requireSuperAdmin(request, runtime.database);
      const captchaToken = typeof request.body.captchaToken === "string" ? request.body.captchaToken : null;
      const authorization = await runtime.providers.guangyaAuthorization.completeSmsCaptcha(
        operator.id,
        request.params.captchaSessionId,
        captchaToken,
      );
      runtime.logBusinessEvent("info", {
        日志关键字: "codex-flycloud-helper-guangya-sms-auth",
        事件: "管理员完成人机验证并发送光鸭验证码",
        管理员ID: operator.id,
        授权会话ID: authorization.authorizationSessionId,
      });
      return authorization;
    },
  );

  server.post<{ Params: { authorizationSessionId: string }; Body: Record<string, unknown> }>(
    "/api/v1/admin/providers/guangya/sms-auth-sessions/:authorizationSessionId/verify",
    async (request) => {
      const operator = await requireSuperAdmin(request, runtime.database);
      const authorization = await runtime.providers.guangyaAuthorization.verifySms(
        operator.id,
        request.params.authorizationSessionId,
        requireString(request.body, "verificationCode", "短信验证码", 8),
      );
      logAuthorizationResult(runtime, operator, authorization);
      return authorization;
    },
  );
}
