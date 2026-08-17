import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  authenticateUser,
  createAppTokenPair,
  createUsernameLookup,
  createWebSession,
  hashPassword,
  hashSessionToken,
  validatePassword,
  validatePasswordConfirmation,
  validateUsername,
} from "../auth.js";
import type { ApiConfig } from "../config.js";
import type { FlyCloudHelperDatabase } from "../database.js";
import { ApiError } from "../errors.js";
import {
  clearSessionCookie,
  readAccessToken,
  requireRequestUser,
  requireSuperAdmin,
  setSessionCookie,
  toUserDto,
} from "../http.js";

interface AuthRoutesContext {
  config: ApiConfig;
  database: FlyCloudHelperDatabase;
  logBusinessEvent: (level: "info" | "warn", fields: Record<string, string | number | boolean | null>) => void;
}

/** 仅在自动生成密钥仍待备份时返回一次性展示内容。 */
async function createCredentialKeyBackup(context: AuthRoutesContext) {
  const state = await context.database.getSystemState();
  if (!state.credentialKeyBackupRequired || context.config.credentialKeySource !== "generated") {
    return null;
  }
  return {
    masterKey: context.config.credentialMasterKey,
    fileName: "flycloud-helper-credential-master-key.txt",
  };
}

/** 为 Web Cookie 和 APP Token 同时创建认证结果。 */
async function createAuthenticationResult(
  context: AuthRoutesContext,
  userId: string,
) {
  const [webSession, appTokens, user] = await Promise.all([
    createWebSession(context.database, userId, context.config.webSessionTtlSeconds),
    createAppTokenPair(
      context.database,
      userId,
      context.config.accessTokenTtlSeconds,
      context.config.refreshTokenTtlSeconds,
    ),
    context.database.findPublicUserById(userId),
  ]);
  return { webSession, appTokens, user };
}

/** 注册首次设置、注册登录、Token 刷新和退出接口。 */
export async function registerAuthRoutes(server: FastifyInstance, context: AuthRoutesContext): Promise<void> {
  server.get("/api/v1/setup/status", async () => {
    const state = await context.database.getSystemState();
    return {
      setupRequired: state.setupRequired,
      credentialKeyBackupRequired: state.credentialKeyBackupRequired,
    };
  });

  server.post<{ Body: Record<string, unknown> }>("/api/v1/setup/super-admin", async (request, reply) => {
    if (request.body.role !== undefined) {
      throw new ApiError(400, "validation_error", "首次初始化不能指定角色");
    }
    const username = validateUsername(request.body.username);
    const password = validatePassword(request.body.password);
    validatePasswordConfirmation(password, request.body.passwordConfirmation);
    const user = await context.database.initializeSuperAdmin({
      userId: randomUUID(),
      username,
      usernameLookup: createUsernameLookup(username),
      passwordHash: await hashPassword(password),
      auditId: randomUUID(),
    });
    const result = await createAuthenticationResult(context, user.id);
    setSessionCookie(reply, result.webSession.token, context.config);
    const credentialKeyBackup = await createCredentialKeyBackup(context);
    if (credentialKeyBackup) {
      reply.header("Cache-Control", "no-store");
      reply.header("Pragma", "no-cache");
    }
    context.logBusinessEvent("info", { 事件: "首次初始化成功", 用户ID: user.id, 角色: user.role });
    return reply.status(201).send({
      user: toUserDto(user),
      ...result.appTokens,
      credentialKeyBackup,
    });
  });

  server.get("/api/v1/setup/credential-key-backup", async (request, reply) => {
    await requireSuperAdmin(request, context.database);
    const backup = await createCredentialKeyBackup(context);
    if (!backup) {
      throw new ApiError(410, "credential_key_backup_completed", "凭据主密钥已经确认备份或由外部配置提供");
    }
    reply.header("Cache-Control", "no-store");
    reply.header("Pragma", "no-cache");
    return backup;
  });

  server.post<{ Body: Record<string, unknown> }>("/api/v1/setup/credential-key-backup/acknowledge", async (request, reply) => {
    const administrator = await requireSuperAdmin(request, context.database);
    if (request.body?.confirmed !== true) {
      throw new ApiError(400, "backup_confirmation_required", "请先确认已经安全备份凭据主密钥");
    }
    if (!(await context.database.getSystemState()).credentialKeyBackupRequired) {
      throw new ApiError(410, "credential_key_backup_completed", "凭据主密钥已经确认备份或由外部配置提供");
    }
    await context.database.acknowledgeCredentialKeyBackup();
    await context.database.addAudit({
      id: randomUUID(),
      operatorUserId: administrator.id,
      operatorUsername: administrator.username,
      operationType: "acknowledge_credential_key_backup",
      targetType: "system",
      targetId: null,
      result: "success",
    });
    context.logBusinessEvent("info", { 事件: "凭据主密钥备份已确认", 用户ID: administrator.id });
    return reply.status(204).send();
  });

  server.post<{ Body: Record<string, unknown> }>("/api/v1/auth/register", async (request, reply) => {
    if (request.body.role !== undefined) {
      throw new ApiError(400, "validation_error", "公开注册不能指定角色");
    }
    const username = validateUsername(request.body.username);
    const password = validatePassword(request.body.password);
    validatePasswordConfirmation(password, request.body.passwordConfirmation);
    const user = await context.database.createUser({
      userId: randomUUID(),
      username,
      usernameLookup: createUsernameLookup(username),
      passwordHash: await hashPassword(password),
    });
    const result = await createAuthenticationResult(context, user.id);
    setSessionCookie(reply, result.webSession.token, context.config);
    context.logBusinessEvent("info", { 事件: "用户注册成功", 用户ID: user.id, 角色: user.role });
    return reply.status(201).send({ user: toUserDto(user), ...result.appTokens });
  });

  server.post<{ Body: Record<string, unknown> }>("/api/v1/auth/login", async (request, reply) => {
    const user = await authenticateUser(context.database, request.body.username, request.body.password);
    const result = await createAuthenticationResult(context, user.id);
    setSessionCookie(reply, result.webSession.token, context.config);
    context.logBusinessEvent("info", { 事件: "用户登录成功", 用户ID: user.id, 角色: user.role });
    return { user: toUserDto(result.user), ...result.appTokens };
  });

  server.post<{ Body: Record<string, unknown> }>("/api/v1/auth/refresh", async (request) => {
    const refreshToken = request.body.refreshToken;
    if (typeof refreshToken !== "string" || !refreshToken) {
      throw new ApiError(401, "refresh_token_invalid", "刷新令牌无效");
    }
    const consumed = await context.database.consumeRefreshToken(hashSessionToken(refreshToken));
    if (!consumed || consumed.user.status !== "active") {
      throw new ApiError(401, "refresh_token_invalid", "刷新令牌无效或已轮换");
    }
    const tokens = await createAppTokenPair(
      context.database,
      consumed.user.id,
      context.config.accessTokenTtlSeconds,
      context.config.refreshTokenTtlSeconds,
      consumed.familyId,
    );
    return { user: toUserDto(consumed.user), ...tokens };
  });

  server.get("/api/v1/auth/me", async (request) => ({
    user: toUserDto(await requireRequestUser(request, context.database)),
  }));

  server.post<{ Body: Record<string, unknown> }>("/api/v1/auth/logout", async (request, reply) => {
    const accessToken = readAccessToken(request);
    if (accessToken) await context.database.revokeSession(hashSessionToken(accessToken));
    if (typeof request.body?.refreshToken === "string") {
      await context.database.revokeRefreshToken(hashSessionToken(request.body.refreshToken));
    }
    clearSessionCookie(reply, context.config);
    return reply.status(204).send();
  });
}
