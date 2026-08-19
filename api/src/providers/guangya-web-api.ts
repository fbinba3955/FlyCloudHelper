import { randomBytes, randomUUID } from "node:crypto";
import { ApiError } from "../errors.js";

const GUANGYA_AUTH_BASE_URL = "https://account.guangyapan.com/v1/auth";
const GUANGYA_WEB_API_BASE_URL = "https://api.guangyapan.com";
const GUANGYA_WEB_CLIENT_ID = "aMe-8VSlkrbQXpUR";
const GUANGYA_PROJECT_ID = "356jld6jjlbjvygi5v9";
const GUANGYA_TOKEN_EXPIRED_CODE = 117;
const GUANGYA_AUTHORIZATION_PENDING_CODE = 4050;
const GUANGYA_TOKEN_REFRESH_AHEAD_MS = 5 * 60 * 1_000;
const GUANGYA_LIST_REQUEST_INTERVAL_MS = 210;
const GUANGYA_DEFAULT_AUTH_EXPIRES_SECONDS = 120;
const GUANGYA_DEFAULT_POLL_INTERVAL_SECONDS = 2;
const GUANGYA_AUTHORIZATION_RETENTION_MS = 10 * 60 * 1_000;

type JsonRecord = Record<string, unknown>;

/** Provider 在光鸭 Token 自动刷新后持久化最新加密连接。 */
export type PersistGuangyaConnection = (connection: Record<string, unknown>) => Promise<void>;

/** 光鸭网页扫码授权公开状态；不包含 device_code、二维码密钥或 Token。 */
export interface GuangyaAuthorizationStatus {
  authorizationSessionId: string;
  status: "pending" | "authorized" | "expired" | "failed";
  verificationUri: string;
  verificationUriComplete: string;
  userCode: string;
  expiresAt: string;
  intervalSeconds: number;
  accountLabel: string | null;
  errorMessage: string | null;
}

interface GuangyaDeviceAuthorization {
  deviceCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  userCode: string;
  expiresInSeconds: number;
  intervalSeconds: number;
}

interface GuangyaAuthorizationSession extends GuangyaAuthorizationStatus {
  actorUserId: string;
  targetUserId: string;
  deviceId: string;
  deviceCode: string;
  expiresAtMs: number;
  nextPollAtMs: number;
  connection: Record<string, unknown> | null;
}

interface GuangyaTokenPollResult {
  status: "pending" | "authorized" | "expired" | "failed";
  connection: Record<string, unknown> | null;
  intervalSeconds: number;
  errorMessage: string | null;
}

/** 将未知 JSON 值安全读取为对象。 */
function readRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

/** 从对象的候选字段读取首个非空字符串。 */
function readFirstText(record: JsonRecord, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && String(value).trim()) {
      return String(value).trim();
    }
  }
  return "";
}

/** 从对象的候选字段读取首个正数。 */
function readFirstNumber(record: JsonRecord, keys: string[]): number {
  for (const key of keys) {
    const value = Number(record[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

/** 读取光鸭可能位于 data 内或顶层的业务数据。 */
function resolveDataRecord(record: JsonRecord): JsonRecord {
  const data = readRecord(record.data);
  return Object.keys(data).length > 0 ? data : record;
}

/** 限制外部服务错误文案长度并移除控制字符。 */
function sanitizeProviderMessage(value: string, fallback: string): string {
  const sanitized = value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
  return sanitized ? sanitized.slice(0, 200) : fallback;
}

/** 解析响应 JSON；非 JSON 响应统一返回空对象。 */
async function readResponseJson(response: Response): Promise<JsonRecord> {
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    return readRecord(JSON.parse(text));
  } catch {
    return {};
  }
}

/** 从下载响应或签名地址中读取可识别的失效时间。 */
function readDownloadExpiresAt(data: JsonRecord, signedUrl: string): string | null {
  const rawExpiresAt = readFirstNumber(data, ["expiresAt", "expireTime", "expiration"]);
  if (rawExpiresAt > 0) {
    const timestamp = rawExpiresAt < 1_000_000_000_000 ? rawExpiresAt * 1_000 : rawExpiresAt;
    return new Date(timestamp).toISOString();
  }
  try {
    const url = new URL(signedUrl);
    const expires = Number(url.searchParams.get("Expires") ?? url.searchParams.get("expires"));
    return Number.isFinite(expires) && expires > 0 ? new Date(expires * 1_000).toISOString() : null;
  } catch {
    return null;
  }
}

/** 光鸭网页接口客户端，复用官网的扫码登录、文件列表和下载请求契约。 */
export class GuangyaWebApiClient {
  private readonly refreshPromises = new WeakMap<Record<string, unknown>, Promise<void>>();
  private listRequestReservation: Promise<void> = Promise.resolve();
  private nextListRequestAtMs = 0;

  public constructor(
    private readonly logDiagnostic?: (fields: Record<string, string | number | boolean | null>) => void,
  ) {}

  /** 向光鸭账号服务申请一次官方网页扫码登录会话。 */
  public async createDeviceAuthorization(deviceId: string, signal?: AbortSignal): Promise<GuangyaDeviceAuthorization> {
    const response = await this.requestJson(`${GUANGYA_AUTH_BASE_URL}/device/code`, {
      method: "POST",
      headers: this.createAuthHeaders(deviceId),
      body: JSON.stringify({
        scope: "user",
        client_id: GUANGYA_WEB_CLIENT_ID,
      }),
      signal,
    });
    const data = resolveDataRecord(response.body);
    const deviceCode = readFirstText(data, ["device_code", "deviceCode"]);
    const verificationUri = readFirstText(data, ["verification_uri", "verification_url", "verificationUri"]);
    const verificationUriComplete = readFirstText(data, ["verification_uri_complete", "verificationUriComplete"])
      || verificationUri;
    if (!response.ok || !deviceCode || !verificationUriComplete) {
      const message = readFirstText(response.body, ["msg", "message", "error_description", "error"]);
      throw new ApiError(
        503,
        "guangya_authorization_unavailable",
        sanitizeProviderMessage(message, "暂时无法创建光鸭扫码登录，请稍后重试"),
      );
    }
    return {
      deviceCode,
      verificationUri: verificationUri || verificationUriComplete,
      verificationUriComplete,
      userCode: readFirstText(data, ["user_code", "userCode"]),
      expiresInSeconds: readFirstNumber(data, ["expires_in", "expiresIn"]) || GUANGYA_DEFAULT_AUTH_EXPIRES_SECONDS,
      intervalSeconds: readFirstNumber(data, ["interval"]) || GUANGYA_DEFAULT_POLL_INTERVAL_SECONDS,
    };
  }

  /** 按官方 Device Code grant 读取扫码确认结果。 */
  public async pollDeviceAuthorization(
    deviceCode: string,
    deviceId: string,
    intervalSeconds: number,
    signal?: AbortSignal,
  ): Promise<GuangyaTokenPollResult> {
    const response = await this.requestJson(`${GUANGYA_AUTH_BASE_URL}/token`, {
      method: "POST",
      headers: this.createAuthHeaders(deviceId),
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
        client_id: GUANGYA_WEB_CLIENT_ID,
      }),
      signal,
    });
    const connection = this.createConnectionFromTokenResponse(response.body, deviceId);
    if (response.ok && connection) {
      return { status: "authorized", connection, intervalSeconds, errorMessage: null };
    }
    const errorName = readFirstText(response.body, ["error", "code"]);
    const errorCode = Number(response.body.error_code ?? response.body.code ?? 0);
    const errorDescription = readFirstText(response.body, ["error_description", "msg", "message"]);
    if (errorName === "authorization_pending" || errorCode === GUANGYA_AUTHORIZATION_PENDING_CODE) {
      return { status: "pending", connection: null, intervalSeconds, errorMessage: null };
    }
    if (errorName === "slow_down") {
      return { status: "pending", connection: null, intervalSeconds: intervalSeconds + 2, errorMessage: null };
    }
    if (errorName === "expired_token" || errorName === "access_denied") {
      return {
        status: "expired",
        connection: null,
        intervalSeconds,
        errorMessage: errorName === "access_denied" ? "已在光鸭 APP 中拒绝登录" : "光鸭扫码登录已过期，请重新开始",
      };
    }
    return {
      status: "failed",
      connection: null,
      intervalSeconds,
      errorMessage: sanitizeProviderMessage(errorDescription || errorName, "光鸭扫码登录失败，请重新开始"),
    };
  }

  /** 列出光鸭目录；请求起始时间全局限制在每秒五次以内。 */
  public async listChildren(
    connection: Record<string, unknown>,
    parentId: string,
    page: number,
    pageSize: number,
    persistConnection?: PersistGuangyaConnection,
    signal?: AbortSignal,
  ): Promise<JsonRecord> {
    await this.ensureValidToken(connection, persistConnection, signal);
    await this.reserveListRequestSlot();
    const requestBody = {
      page,
      pageSize,
      parentId,
      orderBy: 0,
      sortType: 0,
      needSubFolderStat: true,
    };
    const path = "/userres/v1/file/get_file_list";
    let response = await this.requestBusinessJson(path, requestBody, connection, signal);
    if (this.requiresTokenRefresh(response)) {
      await this.refreshConnection(connection, persistConnection, signal, true);
      await this.reserveListRequestSlot();
      response = await this.requestBusinessJson(path, requestBody, connection, signal);
    }
    this.requireSuccessfulBusinessResponse(response, path);
    return response.body;
  }

  /** 获取单文件的临时签名下载地址，不向调用方暴露光鸭访问令牌。 */
  public async getFileDownloadAccess(
    connection: Record<string, unknown>,
    fileId: string,
    persistConnection?: PersistGuangyaConnection,
    signal?: AbortSignal,
  ): Promise<{ url: string; expiresAt: string | null }> {
    if (!fileId.trim()) throw new ApiError(422, "provider_file_locator_invalid", "光鸭文件定位无效");
    await this.ensureValidToken(connection, persistConnection, signal);
    const path = "/userres/v1/get_res_download_url";
    let response = await this.requestBusinessJson(path, { fileId }, connection, signal);
    if (this.requiresTokenRefresh(response)) {
      await this.refreshConnection(connection, persistConnection, signal, true);
      response = await this.requestBusinessJson(path, { fileId }, connection, signal);
    }
    this.requireSuccessfulBusinessResponse(response, path);
    const data = resolveDataRecord(response.body);
    const signedUrl = readFirstText(data, ["signedURL", "signedUrl", "url", "downloadUrl"]);
    if (!signedUrl || !/^https?:\/\//iu.test(signedUrl)) {
      throw new ApiError(503, "provider_download_url_missing", "光鸭未返回可用的文件下载地址");
    }
    return { url: signedUrl, expiresAt: readDownloadExpiresAt(data, signedUrl) };
  }

  /** 使用根目录文件列表验证当前连接，并返回脱敏账号标识。 */
  public async validateConnection(
    connection: Record<string, unknown>,
    persistConnection?: PersistGuangyaConnection,
    signal?: AbortSignal,
  ): Promise<string | null> {
    await this.listChildren(connection, "", 0, 1, persistConnection, signal);
    const userId = typeof connection.userId === "string" ? connection.userId.trim() : "";
    return userId || null;
  }

  /** 在 access_token 缺失或临近过期时刷新，并合并到当前连接对象。 */
  private async ensureValidToken(
    connection: Record<string, unknown>,
    persistConnection?: PersistGuangyaConnection,
    signal?: AbortSignal,
  ): Promise<void> {
    const accessToken = typeof connection.accessToken === "string" ? connection.accessToken.trim() : "";
    const expiresAt = Number(connection.expiresAt ?? 0);
    if (accessToken && (!Number.isFinite(expiresAt) || expiresAt <= 0 || Date.now() + GUANGYA_TOKEN_REFRESH_AHEAD_MS < expiresAt)) {
      return;
    }
    await this.refreshConnection(connection, persistConnection, signal, false);
  }

  /** 合并并去重同一连接的并发 Token 刷新。 */
  private async refreshConnection(
    connection: Record<string, unknown>,
    persistConnection?: PersistGuangyaConnection,
    signal?: AbortSignal,
    forceRefresh = false,
  ): Promise<void> {
    if (!forceRefresh) {
      const accessToken = typeof connection.accessToken === "string" ? connection.accessToken.trim() : "";
      const expiresAt = Number(connection.expiresAt ?? 0);
      if (accessToken && (!Number.isFinite(expiresAt) || expiresAt <= 0 || Date.now() + GUANGYA_TOKEN_REFRESH_AHEAD_MS < expiresAt)) {
        return;
      }
    }
    const existingPromise = this.refreshPromises.get(connection);
    if (existingPromise) return existingPromise;
    const refreshPromise = this.performRefresh(connection, persistConnection, signal)
      .finally(() => this.refreshPromises.delete(connection));
    this.refreshPromises.set(connection, refreshPromise);
    return refreshPromise;
  }

  /** 调用 refresh_token grant 并持久化轮换后的完整连接。 */
  private async performRefresh(
    connection: Record<string, unknown>,
    persistConnection?: PersistGuangyaConnection,
    signal?: AbortSignal,
  ): Promise<void> {
    const refreshToken = typeof connection.refreshToken === "string" ? connection.refreshToken.trim() : "";
    const deviceId = typeof connection.deviceId === "string" ? connection.deviceId.trim() : "";
    if (!refreshToken) {
      throw new ApiError(410, "provider_authentication_failed", "光鸭登录已失效，请重新扫码登录");
    }
    const response = await this.requestJson(`${GUANGYA_AUTH_BASE_URL}/token`, {
      method: "POST",
      headers: this.createAuthHeaders(deviceId),
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: GUANGYA_WEB_CLIENT_ID,
        refresh_token: refreshToken,
      }),
      signal,
    });
    const nextConnection = this.createConnectionFromTokenResponse(response.body, deviceId, refreshToken);
    if (!response.ok || !nextConnection) {
      throw new ApiError(410, "provider_authentication_failed", "光鸭刷新令牌已失效，请重新扫码登录");
    }
    Object.assign(connection, nextConnection);
    if (persistConnection) await persistConnection(connection);
  }

  /** 把 Token 响应映射成可加密保存的连接对象。 */
  private createConnectionFromTokenResponse(
    body: JsonRecord,
    deviceId: string,
    fallbackRefreshToken = "",
  ): Record<string, unknown> | null {
    const data = resolveDataRecord(body);
    const accessToken = readFirstText(data, ["access_token", "accessToken"]);
    const refreshToken = readFirstText(data, ["refresh_token", "refreshToken"]) || fallbackRefreshToken;
    if (!accessToken) return null;
    const expiresIn = readFirstNumber(data, ["expires_in", "expiresIn"]);
    const rawExpiresAt = readFirstNumber(data, ["expires_at", "expiresAt"]);
    const expiresAt = rawExpiresAt > 0
      ? rawExpiresAt < 1_000_000_000_000 ? rawExpiresAt * 1_000 : rawExpiresAt
      : expiresIn > 0 ? Date.now() + expiresIn * 1_000 : 0;
    return {
      authMode: "web_qr",
      deviceId,
      accessToken,
      refreshToken,
      tokenType: readFirstText(data, ["token_type", "tokenType"]) || "Bearer",
      expiresAt,
      userId: readFirstText(data, ["sub", "user_id", "userId"]),
    };
  }

  /** 发送与光鸭官网一致的 JSON 业务请求。 */
  private async requestBusinessJson(
    path: string,
    body: JsonRecord,
    connection: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; status: number; body: JsonRecord }> {
    const accessToken = typeof connection.accessToken === "string" ? connection.accessToken.trim() : "";
    const tokenType = typeof connection.tokenType === "string" && connection.tokenType.trim()
      ? connection.tokenType.trim()
      : "Bearer";
    const deviceId = typeof connection.deviceId === "string" ? connection.deviceId.trim() : "";
    if (!accessToken) throw new ApiError(410, "provider_authentication_failed", "光鸭登录已失效，请重新扫码登录");
    return this.requestJson(`${GUANGYA_WEB_API_BASE_URL}${path}`, {
      method: "POST",
      headers: {
        Authorization: `${tokenType} ${accessToken}`,
        "Content-Type": "application/json",
        dt: "4",
        ...(deviceId ? { did: deviceId } : {}),
        traceparent: `00-${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-01`,
      },
      body: JSON.stringify(body),
      signal,
    });
  }

  /** 判断业务响应是否要求刷新 Token。 */
  private requiresTokenRefresh(response: { status: number; body: JsonRecord }): boolean {
    return response.status === 401 || Number(response.body.code ?? 0) === GUANGYA_TOKEN_EXPIRED_CODE;
  }

  /** 校验光鸭业务响应并转换为稳定错误。 */
  private requireSuccessfulBusinessResponse(response: { ok: boolean; status: number; body: JsonRecord }, path: string): void {
    const code = Number(response.body.code ?? 0);
    if (!response.ok || code !== 0) {
      this.logDiagnostic?.({
        日志关键字: "codex-flycloud-helper-guangya-webapi",
        事件: "光鸭网页业务请求失败",
        请求路径: path,
        响应状态码: response.status,
        业务错误码: code,
      });
    }
    if (response.status === 403) throw new ApiError(403, "provider_permission_denied", "当前光鸭账号没有文件访问权限");
    if (response.status === 429) throw new ApiError(503, "provider_rate_limited", "光鸭接口访问频率过高，请稍后重试");
    if (response.status === 401 || code === GUANGYA_TOKEN_EXPIRED_CODE) {
      throw new ApiError(410, "provider_authentication_failed", "光鸭登录已失效，请重新扫码登录");
    }
    if (!response.ok || code !== 0) {
      const message = readFirstText(response.body, ["msg", "message"]);
      throw new ApiError(503, "provider_request_failed", sanitizeProviderMessage(message, `光鸭请求失败，错误码 ${code || response.status}`));
    }
  }

  /** 为光鸭账号接口生成固定网页客户端请求头。 */
  private createAuthHeaders(deviceId: string): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "x-client-id": GUANGYA_WEB_CLIENT_ID,
      "x-project-id": GUANGYA_PROJECT_ID,
      ...(deviceId ? { "x-device-id": deviceId } : {}),
    };
  }

  /** 保证文件列表请求发起时间不超过每秒五次。 */
  private async reserveListRequestSlot(): Promise<void> {
    const reservation = this.listRequestReservation.then(async () => {
      const delayMs = Math.max(0, this.nextListRequestAtMs - Date.now());
      if (delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      this.nextListRequestAtMs = Date.now() + GUANGYA_LIST_REQUEST_INTERVAL_MS;
    });
    this.listRequestReservation = reservation.catch(() => undefined);
    await reservation;
  }

  /** 发送固定光鸭域名请求并转换网络错误。 */
  private async requestJson(
    url: string,
    init: RequestInit,
  ): Promise<{ ok: boolean; status: number; body: JsonRecord }> {
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), 30_000);
    const parentSignal = init.signal;
    const abortFromParent = () => timeoutController.abort();
    if (parentSignal?.aborted) timeoutController.abort();
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });
    try {
      const response = await fetch(url, { ...init, signal: timeoutController.signal });
      return { ok: response.ok, status: response.status, body: await readResponseJson(response) };
    } catch (error) {
      this.logDiagnostic?.({
        日志关键字: "codex-flycloud-helper-guangya-webapi",
        事件: "光鸭网页接口网络请求失败",
        请求主机: new URL(url).hostname,
        请求路径: new URL(url).pathname,
        失败类型: error instanceof Error ? error.name : typeof error,
        是否超时: timeoutController.signal.aborted && !parentSignal?.aborted,
      });
      if (timeoutController.signal.aborted && !parentSignal?.aborted) {
        throw new ApiError(503, "provider_connection_timeout", "连接光鸭服务超时");
      }
      if (parentSignal?.aborted) throw error;
      throw new ApiError(503, "provider_network_unreachable", "无法连接光鸭服务，请检查服务器网络和 DNS");
    } finally {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", abortFromParent);
    }
  }
}

/** 管理多用户网页扫码授权会话，敏感 device_code 与 Token 不下发到浏览器。 */
export class GuangyaAuthorizationManager {
  private readonly sessions = new Map<string, GuangyaAuthorizationSession>();

  public constructor(private readonly client: GuangyaWebApiClient) {}

  /** 为当前操作者和目标用户创建一次官方网页扫码登录会话。 */
  public async start(actorUserId: string, targetUserId: string): Promise<GuangyaAuthorizationStatus> {
    this.purgeExpiredSessions();
    // 关键变量：同一操作者为同一用户重新扫码时废弃旧等待会话，避免旧二维码覆盖新连接。
    for (const [sessionId, session] of this.sessions) {
      if (session.actorUserId === actorUserId && session.targetUserId === targetUserId && session.status === "pending") {
        this.sessions.delete(sessionId);
      }
    }
    // 与光鸭官网 pM() 的回退逻辑一致，浏览器设备标识使用标准 UUID。
    const deviceId = randomUUID();
    const authorization = await this.client.createDeviceAuthorization(deviceId);
    const createdAtMs = Date.now();
    const expiresAtMs = createdAtMs + authorization.expiresInSeconds * 1_000;
    const session: GuangyaAuthorizationSession = {
      authorizationSessionId: randomUUID(),
      actorUserId,
      targetUserId,
      deviceId,
      deviceCode: authorization.deviceCode,
      status: "pending",
      verificationUri: authorization.verificationUri,
      verificationUriComplete: authorization.verificationUriComplete,
      userCode: authorization.userCode,
      expiresAt: new Date(expiresAtMs).toISOString(),
      expiresAtMs,
      intervalSeconds: authorization.intervalSeconds,
      nextPollAtMs: createdAtMs + authorization.intervalSeconds * 1_000,
      accountLabel: null,
      errorMessage: null,
      connection: null,
    };
    this.sessions.set(session.authorizationSessionId, session);
    return this.toPublicStatus(session);
  }

  /** 轮询官方 Token 接口，并把授权结果保留在仅服务端可读的会话中。 */
  public async poll(actorUserId: string, authorizationSessionId: string): Promise<GuangyaAuthorizationStatus> {
    const session = this.requireOwnedSession(actorUserId, authorizationSessionId);
    if (session.status !== "pending") return this.toPublicStatus(session);
    if (Date.now() >= session.expiresAtMs) {
      session.status = "expired";
      session.errorMessage = "光鸭扫码登录已过期，请重新开始";
      return this.toPublicStatus(session);
    }
    if (Date.now() < session.nextPollAtMs) return this.toPublicStatus(session);
    const result = await this.client.pollDeviceAuthorization(
      session.deviceCode,
      session.deviceId,
      session.intervalSeconds,
    );
    session.intervalSeconds = result.intervalSeconds;
    session.nextPollAtMs = Date.now() + result.intervalSeconds * 1_000;
    if (result.status === "authorized" && result.connection) {
      session.connection = result.connection;
      session.accountLabel = await this.client.validateConnection(result.connection);
      session.status = "authorized";
      session.errorMessage = null;
    } else if (result.status !== "pending") {
      session.status = result.status;
      session.errorMessage = result.errorMessage;
    }
    return this.toPublicStatus(session);
  }

  /** 返回已授权连接的副本，且强制校验目标用户归属。 */
  public getAuthorizedConnection(
    actorUserId: string,
    targetUserId: string,
    authorizationSessionId: string,
  ): Record<string, unknown> {
    const session = this.requireOwnedSession(actorUserId, authorizationSessionId);
    if (session.targetUserId !== targetUserId) {
      throw new ApiError(403, "guangya_authorization_owner_mismatch", "光鸭授权不属于目标用户");
    }
    if (session.status !== "authorized" || !session.connection) {
      throw new ApiError(409, "guangya_authorization_incomplete", "请先完成光鸭扫码登录");
    }
    return { ...session.connection };
  }

  /** 服务连接成功落库后消费一次性授权会话。 */
  public consume(actorUserId: string, authorizationSessionId: string): void {
    this.requireOwnedSession(actorUserId, authorizationSessionId);
    this.sessions.delete(authorizationSessionId);
  }

  /** 读取操作者拥有的授权会话。 */
  private requireOwnedSession(actorUserId: string, authorizationSessionId: string): GuangyaAuthorizationSession {
    const session = this.sessions.get(authorizationSessionId);
    if (!session) {
      throw new ApiError(404, "guangya_authorization_not_found", "光鸭扫码登录会话不存在或已经失效");
    }
    if (session.actorUserId !== actorUserId) {
      throw new ApiError(403, "guangya_authorization_owner_mismatch", "无权访问该光鸭扫码登录会话");
    }
    return session;
  }

  /** 清理超过保留期的内存授权会话。 */
  private purgeExpiredSessions(): void {
    const now = Date.now();
    for (const [sessionId, session] of this.sessions) {
      if (now > session.expiresAtMs + GUANGYA_AUTHORIZATION_RETENTION_MS) {
        this.sessions.delete(sessionId);
      }
    }
  }

  /** 剥离授权会话中的 device_code、设备标识和 Token。 */
  private toPublicStatus(session: GuangyaAuthorizationSession): GuangyaAuthorizationStatus {
    return {
      authorizationSessionId: session.authorizationSessionId,
      status: session.status,
      verificationUri: session.verificationUri,
      verificationUriComplete: session.verificationUriComplete,
      userCode: session.userCode,
      expiresAt: session.expiresAt,
      intervalSeconds: session.intervalSeconds,
      accountLabel: session.accountLabel,
      errorMessage: session.errorMessage,
    };
  }
}
