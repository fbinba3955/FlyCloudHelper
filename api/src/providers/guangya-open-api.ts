import { createHash, randomBytes } from "node:crypto";
import { ApiError } from "../errors.js";
import {
  PROVIDER_RATE_LIMIT_MAX_RETRIES,
  readProviderRateLimitDelayMs,
  waitForProviderRateLimit,
} from "./network.js";
import type { PersistGuangyaConnection } from "./guangya-web-api.js";

const GUANGYA_OPEN_API_BASE_URL = "https://openapi.guangyapan.com/openapi/v1";
const GUANGYA_OPEN_AUTH_BASE_URL = "https://openapi-account.guangyapan.com/v1/auth";
const GUANGYA_TOKEN_EXPIRED_CODE = 117;
const GUANGYA_TOKEN_REFRESH_AHEAD_MS = 5 * 60 * 1_000;
const GUANGYA_LIST_REQUEST_INTERVAL_MS = 210;

type JsonRecord = Record<string, unknown>;

/** 将未知 JSON 值安全读取为普通对象。 */
function readRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

/** 从候选字段读取第一个非空文本。 */
function readFirstText(record: JsonRecord, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return "";
}

/** 从候选字段读取第一个正数。 */
function readFirstNumber(record: JsonRecord, keys: string[]): number {
  for (const key of keys) {
    const value = Number(record[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

/** 读取 data 对象，兼容字段直接位于顶层的响应。 */
function resolveDataRecord(record: JsonRecord): JsonRecord {
  const data = readRecord(record.data);
  return Object.keys(data).length > 0 ? data : record;
}

/** 清理第三方错误文本，避免控制字符进入接口响应。 */
function sanitizeProviderMessage(value: string, fallback: string): string {
  const sanitized = value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
  return sanitized ? sanitized.slice(0, 200) : fallback;
}

/** 解析 JSON 响应；非 JSON 内容统一作为空对象处理。 */
async function readResponseJson(response: Response): Promise<JsonRecord> {
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    return readRecord(JSON.parse(text));
  } catch {
    return {};
  }
}

/** 从响应或签名地址读取下载链接过期时间。 */
function readDownloadExpiresAt(data: JsonRecord, signedUrl: string): string | null {
  const rawExpiresAt = readFirstNumber(data, ["expiresAt", "expires_at", "expireTime", "expiration"]);
  if (rawExpiresAt > 0) {
    const timestamp = rawExpiresAt < 1_000_000_000_000 ? rawExpiresAt * 1_000 : rawExpiresAt;
    return new Date(timestamp).toISOString();
  }
  const durationSeconds = readFirstNumber(data, ["urlDuration", "duration", "expiresIn", "expires_in"]);
  if (durationSeconds > 0) return new Date(Date.now() + durationSeconds * 1_000).toISOString();
  try {
    const url = new URL(signedUrl);
    const expires = Number(url.searchParams.get("Expires") ?? url.searchParams.get("expires"));
    return Number.isFinite(expires) && expires > 0 ? new Date(expires * 1_000).toISOString() : null;
  } catch {
    return null;
  }
}

/**
 * 光鸭开放平台客户端。
 * 连接由 Flymby APP 完成官方授权后同步，Fly云助手只负责刷新、签名和文件访问。
 */
export class GuangyaOpenApiClient {
  private readonly refreshPromises = new WeakMap<Record<string, unknown>, Promise<void>>();
  private listRequestReservation: Promise<void> = Promise.resolve();
  private nextListRequestAtMs = 0;

  public constructor(
    private readonly logDiagnostic?: (fields: Record<string, string | number | boolean | null>) => void,
  ) {}

  /** 列出开放平台目录，并在令牌失效时只刷新一次后重试。 */
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
    const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (parentId) query.set("parentId", parentId);
    const path = "/file/get_file_list";
    let response = await this.requestBusinessJsonWithRateLimitRetry(path, query, connection, signal);
    if (this.requiresTokenRefresh(response)) {
      await this.refreshConnection(connection, persistConnection, signal, true);
      await this.reserveListRequestSlot();
      response = await this.requestBusinessJsonWithRateLimitRetry(path, query, connection, signal);
    }
    this.requireSuccessfulBusinessResponse(response, path);
    return response.body;
  }

  /** 读取开放平台临时下载地址，调用方不会拿到授权令牌。 */
  public async getFileDownloadAccess(
    connection: Record<string, unknown>,
    fileId: string,
    persistConnection?: PersistGuangyaConnection,
    signal?: AbortSignal,
  ): Promise<{ url: string; expiresAt: string | null }> {
    if (!fileId.trim()) throw new ApiError(422, "provider_file_locator_invalid", "光鸭文件定位无效");
    await this.ensureValidToken(connection, persistConnection, signal);
    const query = new URLSearchParams({ fileId });
    const path = "/file/get_res_download_url";
    let response = await this.requestBusinessJsonWithRateLimitRetry(path, query, connection, signal);
    if (this.requiresTokenRefresh(response)) {
      await this.refreshConnection(connection, persistConnection, signal, true);
      response = await this.requestBusinessJsonWithRateLimitRetry(path, query, connection, signal);
    }
    this.requireSuccessfulBusinessResponse(response, path);
    const data = resolveDataRecord(response.body);
    const signedUrl = readFirstText(data, ["signedURL", "signedUrl", "signed_url", "url", "downloadUrl"]);
    if (!signedUrl || !/^https?:\/\//iu.test(signedUrl)) {
      throw new ApiError(503, "provider_download_url_missing", "光鸭未返回可用的文件下载地址");
    }
    return { url: signedUrl, expiresAt: readDownloadExpiresAt(data, signedUrl) };
  }

  /** 使用根目录读取验证 APP 同步的官方 API 连接。 */
  public async validateConnection(
    connection: Record<string, unknown>,
    persistConnection?: PersistGuangyaConnection,
    signal?: AbortSignal,
  ): Promise<string | null> {
    await this.listChildren(connection, "", 0, 1, persistConnection, signal);
    const userId = typeof connection.userId === "string" ? connection.userId.trim() : "";
    return userId || null;
  }

  /** 在令牌缺失或临近过期时刷新官方 API 令牌。 */
  private async ensureValidToken(
    connection: Record<string, unknown>,
    persistConnection?: PersistGuangyaConnection,
    signal?: AbortSignal,
  ): Promise<void> {
    const accessToken = this.readConnectionText(connection, "accessToken");
    const expiresAt = Number(connection.expiresAt ?? 0);
    if (accessToken && (!Number.isFinite(expiresAt) || expiresAt <= 0 || Date.now() + GUANGYA_TOKEN_REFRESH_AHEAD_MS < expiresAt)) {
      return;
    }
    await this.refreshConnection(connection, persistConnection, signal, false);
  }

  /** 合并同一连接的并发刷新，避免刷新令牌被重复轮换。 */
  private async refreshConnection(
    connection: Record<string, unknown>,
    persistConnection?: PersistGuangyaConnection,
    signal?: AbortSignal,
    forceRefresh = false,
  ): Promise<void> {
    if (!forceRefresh) {
      const accessToken = this.readConnectionText(connection, "accessToken");
      const expiresAt = Number(connection.expiresAt ?? 0);
      if (accessToken && (!Number.isFinite(expiresAt) || expiresAt <= 0 || Date.now() + GUANGYA_TOKEN_REFRESH_AHEAD_MS < expiresAt)) return;
    }
    const existingPromise = this.refreshPromises.get(connection);
    if (existingPromise) return existingPromise;
    const refreshPromise = this.performRefresh(connection, persistConnection, signal)
      .finally(() => this.refreshPromises.delete(connection));
    this.refreshPromises.set(connection, refreshPromise);
    return refreshPromise;
  }

  /** 调用 APP 官方 API 同源 refresh_token 接口并持久化轮换后的令牌。 */
  private async performRefresh(
    connection: Record<string, unknown>,
    persistConnection?: PersistGuangyaConnection,
    signal?: AbortSignal,
  ): Promise<void> {
    const clientId = this.requireConnectionText(connection, "clientId", "光鸭官方 API clientId 缺失");
    const projectId = this.requireConnectionText(connection, "projectId", "光鸭官方 API projectId 缺失");
    const deviceId = this.requireConnectionText(connection, "deviceId", "光鸭官方 API deviceId 缺失");
    const refreshToken = this.requireConnectionText(connection, "refreshToken", "光鸭官方 API 登录已失效，请在 Flymby APP 重新授权并同步");
    const response = await this.requestJson(`${GUANGYA_OPEN_AUTH_BASE_URL}/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-client-id": clientId,
        "x-project-id": projectId,
        "x-device-id": deviceId,
      },
      body: JSON.stringify({ grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken }),
      signal,
    });
    const data = resolveDataRecord(response.body);
    const accessToken = readFirstText(data, ["access_token", "accessToken"]);
    if (!response.ok || !accessToken) {
      this.logDiagnostic?.({
        日志关键字: "codex-flycloud-helper-guangya-official-api",
        事件: "光鸭官方API刷新令牌失败",
        响应状态码: response.status,
        业务错误码: readFirstText(response.body, ["error", "code", "error_code"]) || null,
      });
      throw new ApiError(410, "provider_authentication_failed", "光鸭官方 API 登录已失效，请在 Flymby APP 重新授权并同步");
    }
    const expiresIn = readFirstNumber(data, ["expires_in", "expiresIn"]);
    const rawExpiresAt = readFirstNumber(data, ["expires_at", "expiresAt"]);
    Object.assign(connection, {
      authMode: "official_api",
      accessToken,
      refreshToken: readFirstText(data, ["refresh_token", "refreshToken"]) || refreshToken,
      tokenType: readFirstText(data, ["token_type", "tokenType"]) || "Bearer",
      expiresAt: rawExpiresAt > 0
        ? rawExpiresAt < 1_000_000_000_000 ? rawExpiresAt * 1_000 : rawExpiresAt
        : expiresIn > 0 ? Date.now() + expiresIn * 1_000 : 0,
      userId: readFirstText(data, ["sub", "user_id", "userId"]) || this.readConnectionText(connection, "userId"),
    });
    if (persistConnection) await persistConnection(connection);
  }

  /** 发送带开放平台签名的 GET 请求。 */
  private async requestBusinessJson(
    path: string,
    query: URLSearchParams,
    connection: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; status: number; body: JsonRecord }> {
    const clientId = this.requireConnectionText(connection, "clientId", "光鸭官方 API clientId 缺失");
    const signSecret = this.requireConnectionText(connection, "signSecret", "光鸭官方 API signSecret 缺失");
    const accessToken = this.requireConnectionText(connection, "accessToken", "光鸭官方 API 登录已失效，请在 Flymby APP 重新授权并同步");
    const projectId = this.readConnectionText(connection, "projectId");
    const tokenType = this.readConnectionText(connection, "tokenType") || "Bearer";
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const sign = createHash("md5")
      .update(`client_id=${clientId}&timestamp=${timestamp}&secret=${signSecret}`)
      .digest("hex")
      .toLowerCase();
    return this.requestJson(`${GUANGYA_OPEN_API_BASE_URL}${path}?${query.toString()}`, {
      method: "GET",
      headers: {
        Authorization: `${tokenType} ${accessToken}`,
        "Content-Type": "application/json",
        client_id: clientId,
        timestamp,
        sign,
        traceparent: `00-${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-01`,
        ...(projectId ? { project_id: projectId } : {}),
      },
      signal,
    });
  }

  /** 对光鸭官方 API 的只读请求执行有限限流退避，不重试登录和授权写操作。 */
  private async requestBusinessJsonWithRateLimitRetry(
    path: string,
    query: URLSearchParams,
    connection: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; status: number; body: JsonRecord }> {
    let retryCount = 0;
    while (true) {
      const response = await this.requestBusinessJson(path, query, connection, signal);
      // 关键变量：兼容 HTTP 429 和成功 HTTP 中返回业务码 429 的两种限流形式。
      const isRateLimited = response.status === 429 || Number(response.body.code ?? 0) === 429;
      if (!isRateLimited || signal?.aborted) return response;
      if (retryCount >= PROVIDER_RATE_LIMIT_MAX_RETRIES) {
        this.logDiagnostic?.({
          日志关键字: "codex-flycloud-provider-rate-limit",
          事件: "光鸭官方API限流重试后仍未恢复",
          请求路径: path,
          已重试次数: retryCount,
        });
        return response;
      }
      const retryDelayMs = readProviderRateLimitDelayMs(null, retryCount);
      retryCount += 1;
      this.logDiagnostic?.({
        日志关键字: "codex-flycloud-provider-rate-limit",
        事件: "光鸭官方API请求被限流后等待重试",
        请求路径: path,
        当前重试次数: retryCount,
        最大重试次数: PROVIDER_RATE_LIMIT_MAX_RETRIES,
        等待毫秒: retryDelayMs,
      });
      await waitForProviderRateLimit(retryDelayMs, signal);
    }
  }

  /** 判断开放平台业务响应是否要求刷新 Token。 */
  private requiresTokenRefresh(response: { status: number; body: JsonRecord }): boolean {
    return response.status === 401 || Number(response.body.code ?? 0) === GUANGYA_TOKEN_EXPIRED_CODE;
  }

  /** 把开放平台失败响应转换为稳定的 Provider 错误。 */
  private requireSuccessfulBusinessResponse(
    response: { ok: boolean; status: number; body: JsonRecord },
    path: string,
  ): void {
    const code = Number(response.body.code ?? 0);
    if (!response.ok || code !== 0) {
      this.logDiagnostic?.({
        日志关键字: "codex-flycloud-helper-guangya-official-api",
        事件: "光鸭官方API业务请求失败",
        请求路径: path,
        响应状态码: response.status,
        业务错误码: code,
      });
    }
    if (response.status === 403) throw new ApiError(403, "provider_permission_denied", "当前光鸭账号没有文件访问权限");
    if (response.status === 429 || code === 429) {
      throw new ApiError(503, "provider_rate_limited", "光鸭接口访问频率过高，自动重试后仍未恢复，请稍后重试");
    }
    if (response.status === 401 || code === GUANGYA_TOKEN_EXPIRED_CODE) {
      throw new ApiError(410, "provider_authentication_failed", "光鸭官方 API 登录已失效，请在 Flymby APP 重新授权并同步");
    }
    if (!response.ok || code !== 0) {
      const message = readFirstText(response.body, ["msg", "message"]);
      throw new ApiError(503, "provider_request_failed", sanitizeProviderMessage(message, `光鸭官方 API 请求失败，错误码 ${code || response.status}`));
    }
  }

  /** 保证目录请求发起时间不超过每秒五次。 */
  private async reserveListRequestSlot(): Promise<void> {
    const reservation = this.listRequestReservation.then(async () => {
      const delayMs = Math.max(0, this.nextListRequestAtMs - Date.now());
      if (delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      this.nextListRequestAtMs = Date.now() + GUANGYA_LIST_REQUEST_INTERVAL_MS;
    });
    this.listRequestReservation = reservation.catch(() => undefined);
    await reservation;
  }

  /** 从官方 API 连接读取文本。 */
  private readConnectionText(connection: Record<string, unknown>, key: string): string {
    return typeof connection[key] === "string" ? connection[key].trim() : "";
  }

  /** 读取官方 API 必填连接字段。 */
  private requireConnectionText(connection: Record<string, unknown>, key: string, message: string): string {
    const value = this.readConnectionText(connection, key);
    if (!value) throw new ApiError(422, "provider_connection_invalid", message);
    return value;
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
        日志关键字: "codex-flycloud-helper-guangya-official-api",
        事件: "光鸭官方API网络请求失败",
        请求主机: new URL(url).hostname,
        请求路径: new URL(url).pathname,
        失败类型: error instanceof Error ? error.name : typeof error,
        是否超时: timeoutController.signal.aborted && !parentSignal?.aborted,
      });
      if (timeoutController.signal.aborted && !parentSignal?.aborted) {
        throw new ApiError(503, "provider_connection_timeout", "连接光鸭官方 API 超时");
      }
      if (parentSignal?.aborted) throw error;
      throw new ApiError(503, "provider_network_unreachable", "无法连接光鸭官方 API，请检查服务器网络和 DNS");
    } finally {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", abortFromParent);
    }
  }
}
