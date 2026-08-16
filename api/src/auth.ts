import { createHash, randomBytes, randomUUID } from "node:crypto";
import argon2 from "argon2";
import type {
  AuthenticationRecord,
  PublicUserRecord,
} from "./domain.js";
import type { FlyCloudHelperDatabase } from "./database.js";
import { ApiError, validationError } from "./errors.js";

export interface SessionCreationResult {
  token: string;
  expiresAt: string;
}

export interface AppTokenPair {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
}

/** 按 Unicode 码点计算字符数量。 */
function getUnicodeLength(value: string): number {
  return [...value].length;
}

/** 校验并返回不含首尾空白的用户名。 */
export function validateUsername(input: unknown): string {
  if (typeof input !== "string") {
    throw validationError("username", "用户名不能为空");
  }
  if (input.trim() !== input) {
    throw validationError("username", "用户名不能包含首尾空白");
  }
  if (getUnicodeLength(input) < 4) {
    throw validationError("username", "用户名至少需要 4 个字符");
  }
  if (getUnicodeLength(input) > 255) {
    throw validationError("username", "用户名不能超过 255 个字符");
  }
  return input;
}

/** 校验并返回密码原值，不自动裁剪或变更大小写。 */
export function validatePassword(input: unknown): string {
  if (typeof input !== "string" || getUnicodeLength(input) < 4) {
    throw validationError("password", "密码至少需要 4 个字符");
  }
  if (getUnicodeLength(input) > 256) {
    throw validationError("password", "密码不能超过 256 个字符");
  }
  return input;
}

/** 校验确认密码。 */
export function validatePasswordConfirmation(password: string, confirmation: unknown): void {
  if (typeof confirmation !== "string" || confirmation !== password) {
    throw validationError("passwordConfirmation", "两次输入的密码不一致");
  }
}

/** 生成用户名唯一查询值；不做无关的广泛归一化。 */
export function createUsernameLookup(username: string): string {
  return username.toLocaleLowerCase("en-US");
}

/** 使用 Argon2id 生成密码哈希。 */
export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19_456,
    timeCost: 3,
    parallelism: 1,
  });
}

/** 验证密码；异常统一视为验证失败。 */
export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(passwordHash, password);
  } catch {
    return false;
  }
}

/** 为数据库会话保存值生成不可逆 Token 哈希。 */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** 创建随机 Web 会话并只把哈希写入数据库。 */
export async function createWebSession(
  database: FlyCloudHelperDatabase,
  userId: string,
  ttlSeconds: number,
): Promise<SessionCreationResult> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  await database.createSession({
    sessionId: randomUUID(),
    userId,
    tokenHash: hashSessionToken(token),
    expiresAt,
  });
  return { token, expiresAt };
}

/** 创建 APP 使用的短期访问令牌和可轮换刷新令牌。 */
export async function createAppTokenPair(
  database: FlyCloudHelperDatabase,
  userId: string,
  accessTtlSeconds: number,
  refreshTtlSeconds: number,
  familyId: string = randomUUID(),
): Promise<AppTokenPair> {
  const accessSession = await createWebSession(database, userId, accessTtlSeconds);
  const refreshToken = randomBytes(48).toString("base64url");
  const refreshTokenExpiresAt = new Date(Date.now() + refreshTtlSeconds * 1000).toISOString();
  await database.createRefreshToken({
    id: randomUUID(),
    userId,
    tokenHash: hashSessionToken(refreshToken),
    familyId,
    expiresAt: refreshTokenExpiresAt,
  });
  return {
    accessToken: accessSession.token,
    accessTokenExpiresAt: accessSession.expiresAt,
    refreshToken,
    refreshTokenExpiresAt,
  };
}

/** 从登录凭据解析有效用户，错误响应不区分账号和密码。 */
export async function authenticateUser(
  database: FlyCloudHelperDatabase,
  username: unknown,
  password: unknown,
): Promise<PublicUserRecord> {
  const validatedUsername = validateUsername(username);
  const validatedPassword = validatePassword(password);
  const authentication = await database.findAuthenticationByUsername(
    createUsernameLookup(validatedUsername),
  );
  if (!authentication || !(await verifyPassword(authentication.passwordHash, validatedPassword))) {
    throw new ApiError(401, "invalid_credentials", "用户名或密码错误");
  }
  if (authentication.status !== "active") {
    throw new ApiError(403, "user_disabled", "账号当前不可用");
  }
  await database.markUserLogin(authentication.id);
  return toPublicUser(authentication);
}

/** 删除认证记录中的密码哈希。 */
function toPublicUser(record: AuthenticationRecord): PublicUserRecord {
  const { passwordHash: _passwordHash, ...publicUser } = record;
  return publicUser;
}
