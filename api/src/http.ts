import type { FastifyReply, FastifyRequest } from "fastify";
import type { ApiConfig } from "./config.js";
import type { FlyCloudHelperDatabase } from "./database.js";
import type { PublicUserRecord } from "./domain.js";
import { ApiError, validationError } from "./errors.js";
import { hashSessionToken } from "./auth.js";

export const sessionCookieName = "flycloud_helper_session";

/** 转换为 Web 和 APP 共用的公开用户 DTO。 */
export function toUserDto(user: PublicUserRecord) {
  return {
    userId: user.id,
    username: user.username,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
  };
}

/** 把浏览器安全会话写入 HttpOnly Cookie。 */
export function setSessionCookie(reply: FastifyReply, token: string, config: ApiConfig): void {
  reply.setCookie(sessionCookieName, token, {
    path: "/",
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: "lax",
    maxAge: config.webSessionTtlSeconds,
  });
}

/** 清除浏览器安全会话 Cookie。 */
export function clearSessionCookie(reply: FastifyReply, config: ApiConfig): void {
  reply.clearCookie(sessionCookieName, {
    path: "/",
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: "lax",
  });
}

/** 从 Bearer 或 Cookie 读取访问 Token，Bearer 优先供 APP 使用。 */
export function readAccessToken(request: FastifyRequest): string | null {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Bearer ")) {
    const token = authorization.slice("Bearer ".length).trim();
    return token || null;
  }
  return request.cookies[sessionCookieName] ?? null;
}

/** 从请求解析有效登录用户。 */
export async function resolveRequestUser(
  request: FastifyRequest,
  database: FlyCloudHelperDatabase,
): Promise<PublicUserRecord | null> {
  const token = readAccessToken(request);
  return token ? database.findUserBySessionTokenHash(hashSessionToken(token)) : null;
}

/** 强制要求请求具有有效会话。 */
export async function requireRequestUser(
  request: FastifyRequest,
  database: FlyCloudHelperDatabase,
): Promise<PublicUserRecord> {
  const user = await resolveRequestUser(request, database);
  if (!user) {
    throw new ApiError(401, "authentication_required", "请先登录");
  }
  return user;
}

/** 强制要求当前用户为超级管理员。 */
export async function requireSuperAdmin(
  request: FastifyRequest,
  database: FlyCloudHelperDatabase,
): Promise<PublicUserRecord> {
  const user = await requireRequestUser(request, database);
  if (user.role !== "super_admin") {
    throw new ApiError(403, "administrator_required", "当前账号无权访问管理接口");
  }
  return user;
}

/** 读取必填字符串字段并限制最大长度。 */
export function requireString(
  input: Record<string, unknown>,
  fieldName: string,
  displayName: string,
  maxLength = 500,
): string {
  const value = input[fieldName];
  if (typeof value !== "string" || !value.trim()) {
    throw validationError(fieldName, `${displayName}不能为空`);
  }
  if ([...value].length > maxLength) {
    throw validationError(fieldName, `${displayName}长度不能超过 ${maxLength} 个字符`);
  }
  return value.trim();
}

/** 读取必填 JSON 对象字段。 */
export function requireObject(
  input: Record<string, unknown>,
  fieldName: string,
  displayName: string,
): Record<string, unknown> {
  const value = input[fieldName];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw validationError(fieldName, `${displayName}格式无效`);
  }
  return value as Record<string, unknown>;
}

/** 读取受上限保护的分页参数。 */
export function readPagination(query: Record<string, unknown>): { limit: number; offset: number } {
  const limit = Math.min(200, Math.max(1, Number.parseInt(String(query.limit ?? "50"), 10) || 50));
  const offset = Math.max(0, Number.parseInt(String(query.offset ?? "0"), 10) || 0);
  return { limit, offset };
}

/** 要求危险管理操作携带明确确认值。 */
export function requireConfirmation(input: Record<string, unknown>, expected: string): void {
  if (input.confirmation !== expected) {
    throw validationError("confirmation", `请输入确认值 ${expected}`);
  }
}
