import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
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

/** 校验 APP 传入的华为账号稳定身份摘要。 */
function validateHuaweiAccountIdentity(value: unknown): string {
  if (typeof value !== "string") {
    throw new ApiError(400, "huawei_account_required", "请先在 APP 中登录华为账号");
  }
  const identityHash = value.trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(identityHash)) {
    throw new ApiError(400, "huawei_account_identity_invalid", "华为账号绑定信息无效，请重新登录华为账号后再试");
  }
  return identityHash;
}

/**
 * 配置了受信任签名密钥时校验华为账号绑定凭证。
 * 凭证格式：v1.过期秒时间戳.随机串.HMAC-SHA256(base64url)。
 */
function validateHuaweiBindingProof(
  config: ApiConfig,
  accountIdentity: string,
  value: unknown,
): "verified" | "client_asserted" {
  const secret = config.huaweiBindingProofSecret;
  if (!secret) return "client_asserted";
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ApiError(
      400,
      "huawei_binding_proof_required",
      "当前Fly云助手要求可验证的华为账号绑定凭证，请升级APP后重试",
    );
  }
  const parts = value.trim().split(".");
  if (parts.length !== 4 || parts[0] !== "v1" || !/^\d{10}$/.test(parts[1] ?? "")
    || !/^[A-Za-z0-9_-]{16,128}$/.test(parts[2] ?? "") || !/^[A-Za-z0-9_-]{43}$/.test(parts[3] ?? "")) {
    throw new ApiError(400, "huawei_binding_proof_invalid", "华为账号绑定凭证格式无效");
  }
  const expiresText = parts[1]!;
  const nonce = parts[2]!;
  const signature = parts[3]!;
  const expiresAtSeconds = Number.parseInt(expiresText, 10);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (expiresAtSeconds < nowSeconds || expiresAtSeconds > nowSeconds + 15 * 60) {
    throw new ApiError(400, "huawei_binding_proof_expired", "华为账号绑定凭证已过期，请重新获取");
  }
  const signedText = `v1\n${accountIdentity}\n${expiresText}\n${nonce}`;
  const expected = createHmac("sha256", secret).update(signedText, "utf8").digest();
  const actual = Buffer.from(signature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new ApiError(400, "huawei_binding_proof_invalid", "华为账号绑定凭证校验失败");
  }
  return "verified";
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
      huaweiBindingProofRequired: Boolean(context.config.huaweiBindingProofSecret),
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
    await context.database.createSuperAdminNotificationsSafely({
      category: "security",
      tone: "warning",
      title: "新账号注册",
      message: `账号“${user.username}”通过网页完成注册。`,
      actionPath: "/admin/users",
    });
    context.logBusinessEvent("info", { 事件: "用户注册成功", 用户ID: user.id, 角色: user.role });
    return reply.status(201).send({ user: toUserDto(user), ...result.appTokens });
  });

  server.post<{ Body: Record<string, unknown> }>("/api/v1/auth/app-register", async (request, reply) => {
    if (request.body.role !== undefined) {
      throw new ApiError(400, "validation_error", "APP 注册不能指定角色");
    }
    const username = validateUsername(request.body.username);
    const password = validatePassword(request.body.password);
    validatePasswordConfirmation(password, request.body.passwordConfirmation);
    const accountIdentity = validateHuaweiAccountIdentity(request.body.accountIdentity);
    const identityVerification = validateHuaweiBindingProof(
      context.config,
      accountIdentity,
      request.body.accountBindingProof,
    );
    const identitySuffix = accountIdentity.slice(-8);
    context.logBusinessEvent("info", {
      日志关键字: "codex-flycloud-account-register",
      事件: "APP账号注册开始",
      身份摘要后缀: identitySuffix,
      身份校验方式: identityVerification === "verified" ? "服务端签名" : "客户端摘要",
    });
    try {
      const user = await context.database.createAppUserWithExternalIdentity({
        userId: randomUUID(),
        username,
        usernameLookup: createUsernameLookup(username),
        passwordHash: await hashPassword(password),
        identityId: randomUUID(),
        identityProvider: "huawei",
        identityHash: accountIdentity,
      });
      const result = await createAuthenticationResult(context, user.id);
      setSessionCookie(reply, result.webSession.token, context.config);
      await context.database.createSuperAdminNotificationsSafely({
        category: "security",
        tone: "warning",
        title: "新账号注册",
        message: `账号“${user.username}”通过 Flymby APP 完成注册并绑定华为账号。`,
        actionPath: "/admin/users",
      });
      context.logBusinessEvent("info", {
        日志关键字: "codex-flycloud-account-register",
        事件: "APP账号注册成功",
        用户ID: user.id,
        身份摘要后缀: identitySuffix,
      });
      return reply.status(201).send({
        user: toUserDto(user),
        ...result.appTokens,
        identityBinding: {
          provider: "huawei",
          status: "bound",
          verification: identityVerification,
        },
      });
    } catch (error) {
      context.logBusinessEvent("warn", {
        日志关键字: "codex-flycloud-account-register",
        事件: "APP账号注册失败",
        身份摘要后缀: identitySuffix,
        错误码: error instanceof ApiError ? error.code : "internal_error",
      });
      throw error;
    }
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
