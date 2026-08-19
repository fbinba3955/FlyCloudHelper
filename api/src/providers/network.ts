import dns from "node:dns/promises";
import http, { type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
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

/**
 * 创建固定到本次 DNS 结果的 Node lookup 回调。
 * Node 20 开启自动地址族选择时会传入 all=true，此时回调必须返回地址数组。
 */
function createPinnedProviderLookup(target: ResolvedProviderUrl): LookupFunction {
  return (_hostname, lookupOptions, callback) => {
    // 关键变量：all=true 时即使只有一个固定地址也必须保留数组形态，否则 Node 会抛出 ERR_INVALID_IP_ADDRESS。
    if (lookupOptions.all === true) {
      callback(null, [{ address: target.address, family: target.family }]);
      return;
    }
    callback(null, target.address, target.family);
  };
}

/** Provider 媒体中转建立完成后的原生流响应。 */
export interface ProviderStreamResponse {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: IncomingMessage;
  finalUrl: URL;
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
      lookup: createPinnedProviderLookup(target),
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

/** 使用固定 DNS 解析结果建立不会预读媒体正文的上游流请求。 */
async function requestResolvedProviderStream(
  target: ResolvedProviderUrl,
  init: RequestInit,
  signal: AbortSignal,
): Promise<IncomingMessage> {
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((value, name) => {
    headers[name] = value;
  });
  const transport = target.url.protocol === "https:" ? https : http;
  return new Promise<IncomingMessage>((resolve, reject) => {
    const request = transport.request(target.url, {
      method: init.method ?? "GET",
      headers,
      lookup: createPinnedProviderLookup(target),
    }, resolve);
    request.once("error", reject);
    const abortRequest = () => request.destroy(new Error("provider_stream_aborted"));
    signal.addEventListener("abort", abortRequest, { once: true });
    request.once("close", () => signal.removeEventListener("abort", abortRequest));
    request.end();
  });
}

/** 判断 Provider 响应是否要求客户端跳转到新的资源地址。 */
function isProviderRedirectStatus(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status);
}

/** 跨域重定向时移除不能转发给新主机的敏感请求头。 */
function buildRedirectRequestInit(init: RequestInit, isCrossOrigin: boolean): RequestInit {
  if (!isCrossOrigin) return init;
  const headers = new Headers(init.headers);
  headers.delete("authorization");
  headers.delete("proxy-authorization");
  headers.delete("cookie");
  return { ...init, headers };
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
    // 关键变量：每次跳转都重新执行 URL 和 DNS 校验，最多跟随五次以阻止循环重定向。
    let currentUrl: string | URL = url instanceof URL ? new URL(url.href) : url;
    let currentInit = init;
    let redirectCount = 0;
    let response: Response;
    while (true) {
      resolvedTarget = await resolveProviderUrl(currentUrl, options);
      response = await requestResolvedProvider(resolvedTarget, currentInit, timeoutController.signal);
      const requestMethod = String(currentInit.method ?? "GET").toUpperCase();
      const location = response.headers.get("location");
      if (!isProviderRedirectStatus(response.status) || !location || !["GET", "HEAD"].includes(requestMethod)) {
        break;
      }
      if (redirectCount >= 5) {
        throw new ApiError(503, "provider_redirect_limit_exceeded", "网盘资源重定向次数过多");
      }
      let nextUrl: URL;
      try {
        nextUrl = new URL(location, resolvedTarget.url);
      } catch {
        throw new ApiError(503, "provider_redirect_invalid", "网盘资源返回了无效的重定向地址");
      }
      const isCrossOrigin = nextUrl.origin !== resolvedTarget.url.origin;
      redirectCount += 1;
      options.logConnectionFailure?.({
        日志关键字: "codex-video-recognition-optimize",
        事件: "Provider文本资源跟随重定向",
        请求方法: requestMethod,
        原请求路径: resolvedTarget.url.pathname,
        重定向状态码: response.status,
        是否跨域: isCrossOrigin,
        重定向次数: redirectCount,
      });
      currentInit = buildRedirectRequestInit(currentInit, isCrossOrigin);
      currentUrl = nextUrl;
    }
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

/**
 * 建立 Provider 媒体流并保留原生 IncomingMessage，让 Fastify 直接执行背压转发。
 * 只限制建立响应头的等待时间；流建立后不设置总时长上限，直到播放完成或客户端断开。
 */
export async function providerStream(
  url: string | URL,
  init: RequestInit,
  options: ProviderNetworkOptions,
  parentSignal?: AbortSignal,
): Promise<ProviderStreamResponse> {
  const requestController = new AbortController();
  const startedAt = Date.now();
  let resolvedTarget: ResolvedProviderUrl | null = null;
  let finalBody: IncomingMessage | null = null;
  let connectionTimedOut = false;
  const timeout = setTimeout(() => {
    connectionTimedOut = true;
    requestController.abort();
  }, 30_000);
  const abortParent = () => requestController.abort();
  parentSignal?.addEventListener("abort", abortParent, { once: true });
  const cleanup = () => {
    clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", abortParent);
  };
  try {
    // 关键变量：每次重定向重新校验协议和 DNS，跨域时移除 WebDAV Authorization 等敏感请求头。
    let currentUrl: string | URL = url instanceof URL ? new URL(url.href) : url;
    let currentInit = init;
    let redirectCount = 0;
    while (true) {
      resolvedTarget = await resolveProviderUrl(currentUrl, options);
      const response = await requestResolvedProviderStream(
        resolvedTarget,
        currentInit,
        requestController.signal,
      );
      const requestMethod = String(currentInit.method ?? "GET").toUpperCase();
      const location = response.headers.location;
      if (isProviderRedirectStatus(response.statusCode ?? 500) && location && ["GET", "HEAD"].includes(requestMethod)) {
        response.destroy();
        if (redirectCount >= 5) {
          throw new ApiError(503, "provider_redirect_limit_exceeded", "网盘媒体重定向次数过多");
        }
        let nextUrl: URL;
        try {
          nextUrl = new URL(location, resolvedTarget.url);
        } catch {
          throw new ApiError(503, "provider_redirect_invalid", "网盘媒体返回了无效的重定向地址");
        }
        const isCrossOrigin = nextUrl.origin !== resolvedTarget.url.origin;
        redirectCount += 1;
        currentInit = buildRedirectRequestInit(currentInit, isCrossOrigin);
        currentUrl = nextUrl;
        continue;
      }

      const statusCode = response.statusCode ?? 500;
      if (statusCode === 401) {
        response.destroy();
        throw new ApiError(410, "provider_authentication_failed", "网盘凭据未被接受，媒体请求返回 401");
      }
      if (statusCode === 403) {
        response.destroy();
        throw new ApiError(403, "provider_permission_denied", "网盘文件权限不足，媒体请求返回 403");
      }
      if (statusCode === 404) {
        response.destroy();
        throw new ApiError(404, "provider_resource_not_found", "网盘媒体文件不存在，可能已经被移动或删除");
      }
      if ((statusCode < 200 || statusCode >= 300) && statusCode !== 416) {
        response.destroy();
        throw new ApiError(503, "provider_stream_request_failed", `网盘媒体请求失败，状态码 ${statusCode}`);
      }

      finalBody = response;
      clearTimeout(timeout);
      response.once("close", cleanup);
      return {
        statusCode,
        headers: response.headers,
        body: response,
        finalUrl: resolvedTarget.url,
      };
    }
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    if (requestController.signal.aborted) {
      if (connectionTimedOut) {
        throw new ApiError(503, "provider_connection_timeout", "连接网盘媒体文件超时");
      }
      throw new ApiError(499, "provider_stream_aborted", "媒体中转请求已取消");
    }
    const errorCode = readNetworkErrorCode(error);
    options.logConnectionFailure?.({
      日志关键字: "codex-flycloud-helper-media-stream",
      事件: "建立Provider媒体流失败",
      协议: resolvedTarget?.url.protocol ?? "未解析",
      主机: resolvedTarget?.url.hostname ?? "未解析",
      端口: resolvedTarget?.url.port || (resolvedTarget?.url.protocol === "https:" ? "443" : "80"),
      系统错误码: errorCode,
      已等待毫秒: Date.now() - startedAt,
    });
    throw createProviderConnectionError(errorCode, false);
  } finally {
    if (!finalBody) cleanup();
  }
}
