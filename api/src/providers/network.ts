import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { ApiError } from "../errors.js";

export interface ProviderNetworkOptions {
  allowInsecureHttp: boolean;
  logConnectionFailure?: (fields: Record<string, string | number | boolean | null>) => void;
}

interface ResolvedProviderUrl {
  url: URL;
  address: string;
  family: 4 | 6;
}

/** 从 Node 网络异常、cause 或聚合异常中读取稳定错误码。 */
function readNetworkErrorCode(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "UNKNOWN";
  }
  const directCode = (error as { code?: unknown }).code;
  if (typeof directCode === "string" && directCode) {
    return directCode;
  }
  const cause = (error as { cause?: unknown }).cause;
  if (cause && cause !== error) {
    const causeCode = readNetworkErrorCode(cause);
    if (causeCode !== "UNKNOWN") {
      return causeCode;
    }
  }
  const nestedErrors = (error as { errors?: unknown }).errors;
  if (Array.isArray(nestedErrors)) {
    for (const nestedError of nestedErrors) {
      const nestedCode = readNetworkErrorCode(nestedError);
      if (nestedCode !== "UNKNOWN") {
        return nestedCode;
      }
    }
  }
  return "UNKNOWN";
}

/** 把底层网络错误转换为便于用户处理的稳定 Provider 错误。 */
function createProviderConnectionError(errorCode: string, timedOut: boolean): ApiError {
  if (timedOut || errorCode === "ETIMEDOUT") {
    return new ApiError(503, "provider_connection_timeout", "连接网盘服务超时，请检查地址、端口和网络连通性");
  }
  if (errorCode === "ERR_INVALID_IP_ADDRESS") {
    return new ApiError(
      503,
      "provider_resolved_address_invalid",
      "Provider 域名解析结果无法建立网络连接，请检查 Provider 地址、DNS 或系统代理设置；也可改用可直接访问的 IP 地址",
    );
  }
  if (errorCode === "ECONNREFUSED") {
    return new ApiError(503, "provider_connection_refused", "网盘服务拒绝连接，请检查地址、端口以及网盘服务是否已启动");
  }
  if (["ENETUNREACH", "EHOSTUNREACH", "EAI_AGAIN", "ENOTFOUND"].includes(errorCode)) {
    return new ApiError(503, "provider_network_unreachable", "无法访问网盘服务所在网络，请检查地址和网络连通性");
  }
  if (errorCode.startsWith("ERR_TLS_") || errorCode.includes("CERT")) {
    return new ApiError(503, "provider_tls_failed", "网盘服务 HTTPS 证书校验失败");
  }
  return new ApiError(
    503,
    "provider_unavailable",
    "无法建立网盘网络连接，请检查 Provider 地址、端口、DNS 和代理设置；详细原因可查看后台诊断日志",
  );
}

/** 解析并校验 Provider URL，同时返回本次请求使用的解析地址。 */
async function resolveProviderUrl(
  rawUrl: string | URL,
  options: ProviderNetworkOptions,
): Promise<ResolvedProviderUrl> {
  let url: URL;
  try {
    url = rawUrl instanceof URL ? new URL(rawUrl.href) : new URL(rawUrl);
  } catch {
    throw new ApiError(400, "provider_url_invalid", "Provider 地址格式无效");
  }
  if (url.username || url.password) {
    throw new ApiError(400, "provider_url_invalid", "Provider 地址不能内嵌用户名或密码");
  }
  if (url.protocol !== "https:" && !(options.allowInsecureHttp && url.protocol === "http:")) {
    throw new ApiError(400, "provider_url_insecure", "当前实例不允许 Provider 使用 HTTP，请启用 FLYCLOUDHELPER_ALLOW_INSECURE_HTTP");
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await dns.lookup(url.hostname, { all: true, verbatim: true });
  } catch {
    throw new ApiError(503, "provider_dns_resolution_failed", "无法解析 Provider 域名，请检查地址拼写、DNS 或网络设置");
  }
  if (addresses.length === 0) {
    throw new ApiError(503, "provider_dns_resolution_failed", "Provider 域名没有解析到网络地址，请检查 DNS 或系统代理设置");
  }
  const selectedAddress = addresses[0];
  if (!selectedAddress || (selectedAddress.family !== 4 && selectedAddress.family !== 6)) {
    throw new ApiError(503, "provider_resolved_address_invalid", "Provider 域名未解析到可用的 IPv4 或 IPv6 地址，请检查 DNS 或系统代理设置");
  }
  const selectedFamily: 4 | 6 = selectedAddress.family;
  return { url, address: selectedAddress.address, family: selectedFamily };
}

/** 校验 Provider URL，供 Provider 在构造派生路径前使用。 */
export async function validateProviderUrl(
  rawUrl: string,
  options: ProviderNetworkOptions,
): Promise<URL> {
  return (await resolveProviderUrl(rawUrl, options)).url;
}

/** 把当前内置 Provider 支持的请求体转换为原生 HTTP 可写数据。 */
function toRequestBody(body: RequestInit["body"]): string | Uint8Array | undefined {
  if (body === undefined || body === null) {
    return undefined;
  }
  if (typeof body === "string" || body instanceof Uint8Array) {
    return body;
  }
  if (body instanceof ArrayBuffer) {
    return new Uint8Array(body);
  }
  throw new ApiError(500, "provider_request_body_unsupported", "Provider 请求体类型不受支持");
}

/** 使用本次已经解析的地址发送请求，保证请求过程中解析结果一致。 */
async function requestResolvedProvider(
  target: ResolvedProviderUrl,
  init: RequestInit,
  signal: AbortSignal,
): Promise<Response> {
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((value, name) => {
    headers[name] = value;
  });
  const body = toRequestBody(init.body);
  if (body !== undefined && headers["content-length"] === undefined) {
    headers["content-length"] = String(Buffer.byteLength(body));
  }
  const transport = target.url.protocol === "https:" ? https : http;

  return new Promise<Response>((resolve, reject) => {
    const request = transport.request(target.url, {
      method: init.method ?? "GET",
      headers,
      lookup: (_hostname, _options, callback) => {
        callback(null, target.address, target.family);
      },
    }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer | string) => {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      });
      incoming.once("end", () => {
        const responseHeaders = new Headers();
        Object.entries(incoming.headers).forEach(([name, value]) => {
          if (Array.isArray(value)) {
            value.forEach((item) => responseHeaders.append(name, item));
          } else if (value !== undefined) {
            responseHeaders.set(name, value);
          }
        });
        const responseBody = Buffer.concat(chunks);
        resolve(new Response(responseBody.length > 0 ? responseBody : null, {
          status: incoming.statusCode ?? 500,
          statusText: incoming.statusMessage,
          headers: responseHeaders,
        }));
      });
    });
    request.once("error", reject);
    const abortRequest = () => request.destroy(new Error("provider_request_aborted"));
    signal.addEventListener("abort", abortRequest, { once: true });
    request.once("close", () => signal.removeEventListener("abort", abortRequest));
    if (body !== undefined) {
      request.write(body);
    }
    request.end();
  });
}

/** 对 Provider 请求执行地址校验、DNS 固定和超时，并转换为稳定业务错误。 */
export async function providerFetch(
  url: string | URL,
  init: RequestInit,
  options: ProviderNetworkOptions,
  parentSignal?: AbortSignal,
): Promise<Response> {
  const timeoutController = new AbortController();
  const startedAt = Date.now();
  let resolvedTarget: ResolvedProviderUrl | null = null;
  const timeout = setTimeout(() => timeoutController.abort(), 30_000);
  const abortParent = () => timeoutController.abort();
  parentSignal?.addEventListener("abort", abortParent, { once: true });
  try {
    resolvedTarget = await resolveProviderUrl(url, options);
    const response = await requestResolvedProvider(resolvedTarget, init, timeoutController.signal);
    if (response.status === 401) {
      // 401 表示服务端没有接受当前凭据；保留 410 业务状态，避免被前端误认为 FlyCloudHelper 登录会话失效。
      throw new ApiError(410, "provider_authentication_failed", "网盘凭据未被接受，服务端返回 401");
    }
    if (response.status === 403) {
      // 403 表示凭据已被识别，但当前资源不允许访问，不能再误报为整个网盘凭据失效。
      throw new ApiError(403, "provider_permission_denied", "网盘目录或文件权限不足，服务端返回 403");
    }
    if (response.status === 404) {
      options.logConnectionFailure?.({
        日志关键字: "codex-flycloud-helper-provider-request",
        事件: "Provider资源不存在",
        请求方法: init.method ?? "GET",
        请求路径: resolvedTarget.url.pathname,
        响应状态码: response.status,
      });
      throw new ApiError(404, "provider_resource_not_found", "网盘目录或文件不存在，可能已经被移动或删除");
    }
    if (!response.ok && response.status !== 207) {
      options.logConnectionFailure?.({
        日志关键字: "codex-flycloud-helper-provider-request",
        事件: "Provider请求返回错误",
        请求方法: init.method ?? "GET",
        请求路径: resolvedTarget.url.pathname,
        响应状态码: response.status,
      });
      throw new ApiError(503, "provider_request_failed", `网盘请求失败，状态码 ${response.status}`);
    }
    return response;
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    const errorCode = readNetworkErrorCode(error);
    options.logConnectionFailure?.({
      日志关键字: "codex-flycloud-helper-provider-connect",
      事件: "Provider网络连接失败",
      协议: resolvedTarget?.url.protocol ?? "未解析",
      主机: resolvedTarget?.url.hostname ?? "未解析",
      端口: resolvedTarget?.url.port || (resolvedTarget?.url.protocol === "https:" ? "443" : "80"),
      解析地址: resolvedTarget?.address ?? "未解析",
      系统错误码: errorCode,
      失败类型: error instanceof Error ? error.name : typeof error,
      已等待毫秒: Date.now() - startedAt,
    });
    throw createProviderConnectionError(errorCode, timeoutController.signal.aborted && !parentSignal?.aborted);
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", abortParent);
  }
}
