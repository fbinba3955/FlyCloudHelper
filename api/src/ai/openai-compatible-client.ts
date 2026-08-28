import type { AiModelAvailabilityResult } from "../domain.js";

export interface OpenAiCompatibleModelConfiguration {
  baseUrl: string;
  modelName: string;
  apiKey: string | null;
  timeoutMs: number;
}

export interface OpenAiCompatibleJsonResult {
  ok: boolean;
  payload: Record<string, unknown> | null;
  latencyMs: number;
  errorCode: string | null;
  errorMessage: string | null;
}

/** 单次结构化业务请求的生成参数；可用性测试继续使用独立的小请求。 */
export interface OpenAiCompatibleJsonRequestOptions {
  maxTokens?: number;
  temperature?: number;
}

interface StructuredJsonAttemptResult extends OpenAiCompatibleJsonResult {
  retryWithoutResponseFormat: boolean;
}

interface AvailabilityAttemptResult extends AiModelAvailabilityResult {
  retryWithoutResponseFormat: boolean;
}

const maximumResponseBytes = 1024 * 1024;

/** 移除仅用于内部重试判断的字段，返回稳定的业务测试结果。 */
function toAvailabilityResult(attempt: AvailabilityAttemptResult): AiModelAvailabilityResult {
  return {
    available: attempt.available,
    structuredOutput: attempt.structuredOutput,
    latencyMs: attempt.latencyMs,
    errorCode: attempt.errorCode,
    errorMessage: attempt.errorMessage,
  };
}

/** 将模型基础地址转换为 OpenAI Chat Completions 请求地址。 */
function resolveChatCompletionsUrl(baseUrl: string): string {
  const requestUrl = new URL(baseUrl);
  const trimmedPath = requestUrl.pathname.replace(/\/+$/u, "");
  requestUrl.pathname = trimmedPath.endsWith("/chat/completions")
    ? trimmedPath
    : `${trimmedPath}/chat/completions`;
  return requestUrl.toString();
}

/** 限制测试响应体大小，避免错误端点返回大页面占用过多内存。 */
async function readLimitedResponseBody(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > maximumResponseBytes) {
    await response.body?.cancel();
    throw new Error("ai_model_response_too_large");
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let receivedBytes = 0;
  let body = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    receivedBytes += chunk.value.byteLength;
    if (receivedBytes > maximumResponseBytes) {
      await reader.cancel();
      throw new Error("ai_model_response_too_large");
    }
    body += decoder.decode(chunk.value, { stream: true });
  }
  return body + decoder.decode();
}

/** 从兼容接口错误体中提取可安全展示的短错误信息。 */
function readRemoteErrorMessage(responseBody: string, fallback: string): string {
  try {
    const payload = JSON.parse(responseBody) as { error?: { message?: unknown }; message?: unknown };
    const message = typeof payload.error?.message === "string"
      ? payload.error.message
      : typeof payload.message === "string" ? payload.message : fallback;
    return message.slice(0, 300);
  } catch {
    return fallback;
  }
}

/** 将远端 HTTP 状态转换为稳定、脱敏的业务错误。 */
function mapHttpFailure(status: number, responseBody: string, latencyMs: number): AvailabilityAttemptResult {
  let errorCode = "ai_model_request_failed";
  let fallback = `模型接口请求失败（HTTP ${status}）`;
  if (status === 401 || status === 403) {
    errorCode = "ai_model_authentication_failed";
    fallback = "模型接口认证失败，请检查 API Key";
  } else if (status === 404) {
    errorCode = "ai_model_endpoint_or_model_not_found";
    fallback = "模型接口地址或模型名称不存在";
  } else if (status === 429) {
    errorCode = "ai_model_rate_limited";
    fallback = "模型接口当前触发限流";
  } else if (status >= 500) {
    errorCode = "ai_model_server_error";
    fallback = "模型服务暂时不可用";
  }
  return {
    available: false,
    structuredOutput: false,
    latencyMs,
    errorCode,
    errorMessage: readRemoteErrorMessage(responseBody, fallback),
    retryWithoutResponseFormat: status === 400
      && /response[_ -]?format|json[_ -]?(?:object|schema)/iu.test(responseBody),
  };
}

/** 从 Markdown 代码块或纯 JSON 文本中读取 JSON 对象。 */
function parseJsonResponseContent(content: string): Record<string, unknown> {
  const trimmedContent = content.trim();
  const jsonText = trimmedContent.startsWith("```")
    ? trimmedContent.replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "")
    : trimmedContent;
  const payload = JSON.parse(jsonText) as unknown;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("invalid json object");
  }
  return payload as Record<string, unknown>;
}

/** 从模型测试响应中验证约定状态。 */
function parseStructuredTestResponse(content: string): boolean {
  return parseJsonResponseContent(content).status === "ok";
}

/** 执行一次模型可用性请求，可选要求兼容端支持 JSON Object 输出。 */
async function executeAvailabilityAttempt(
  configuration: OpenAiCompatibleModelConfiguration,
  requireResponseFormat: boolean,
): Promise<AvailabilityAttemptResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), configuration.timeoutMs);
  try {
    // 关键变量：测试提示词同时验证对话能力和最小 JSON 结构输出，不执行真实目录清洗。
    const requestBody: Record<string, unknown> = {
      model: configuration.modelName,
      messages: [
        { role: "system", content: "你是接口可用性测试助手，只返回 JSON。" },
        { role: "user", content: "请只返回这个 JSON 对象：{\"status\":\"ok\"}" },
      ],
      stream: false,
    };
    if (requireResponseFormat) requestBody.response_format = { type: "json_object" };

    const headers = new Headers({ "Content-Type": "application/json" });
    if (configuration.apiKey) headers.set("Authorization", `Bearer ${configuration.apiKey}`);
    const response = await fetch(resolveChatCompletionsUrl(configuration.baseUrl), {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    const responseBody = await readLimitedResponseBody(response);
    const latencyMs = Date.now() - startedAt;
    if (!response.ok) return mapHttpFailure(response.status, responseBody, latencyMs);

    try {
      const payload = JSON.parse(responseBody) as {
        choices?: Array<{ message?: { content?: unknown } }>;
      };
      const content = payload.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !parseStructuredTestResponse(content)) {
        throw new Error("invalid structured response");
      }
      return {
        available: true,
        structuredOutput: true,
        latencyMs,
        errorCode: null,
        errorMessage: null,
        retryWithoutResponseFormat: false,
      };
    } catch {
      return {
        available: false,
        structuredOutput: false,
        latencyMs,
        errorCode: "ai_model_response_invalid",
        errorMessage: "模型已响应，但未返回约定的 JSON 结构",
        retryWithoutResponseFormat: false,
      };
    }
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    if (error instanceof Error && error.message === "ai_model_response_too_large") {
      return {
        available: false,
        structuredOutput: false,
        latencyMs,
        errorCode: "ai_model_response_too_large",
        errorMessage: "模型接口响应内容超过 1MB 限制",
        retryWithoutResponseFormat: false,
      };
    }
    const timedOut = controller.signal.aborted;
    return {
      available: false,
      structuredOutput: false,
      latencyMs,
      errorCode: timedOut ? "ai_model_timeout" : "ai_model_network_error",
      errorMessage: timedOut ? "模型接口请求超时" : "无法连接模型接口",
      retryWithoutResponseFormat: false,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/** 测试 OpenAI Chat Completions 兼容模型，并兼容不支持 response_format 的服务。 */
export async function testOpenAiCompatibleModel(
  configuration: OpenAiCompatibleModelConfiguration,
): Promise<AiModelAvailabilityResult> {
  const firstAttempt = await executeAvailabilityAttempt(configuration, true);
  if (!firstAttempt.retryWithoutResponseFormat) {
    return toAvailabilityResult(firstAttempt);
  }
  const fallbackAttempt = await executeAvailabilityAttempt(configuration, false);
  return toAvailabilityResult(fallbackAttempt);
}

/** 执行一次通用 JSON 对象请求，供目录文件名清洗复用。 */
async function executeStructuredJsonAttempt(
  configuration: OpenAiCompatibleModelConfiguration,
  systemPrompt: string,
  input: Record<string, unknown>,
  requireResponseFormat: boolean,
  options: OpenAiCompatibleJsonRequestOptions,
  signal?: AbortSignal,
): Promise<StructuredJsonAttemptResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const abortFromParent = (): void => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", abortFromParent, { once: true });
  const timeout = setTimeout(() => controller.abort(), configuration.timeoutMs);
  try {
    const requestBody: Record<string, unknown> = {
      model: configuration.modelName,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: JSON.stringify(input) },
      ],
      stream: false,
    };
    if (typeof options.maxTokens === "number") requestBody.max_tokens = options.maxTokens;
    if (typeof options.temperature === "number") requestBody.temperature = options.temperature;
    if (requireResponseFormat) requestBody.response_format = { type: "json_object" };
    const headers = new Headers({ "Content-Type": "application/json" });
    if (configuration.apiKey) headers.set("Authorization", `Bearer ${configuration.apiKey}`);
    const response = await fetch(resolveChatCompletionsUrl(configuration.baseUrl), {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    const responseBody = await readLimitedResponseBody(response);
    const latencyMs = Date.now() - startedAt;
    if (!response.ok) {
      const failure = mapHttpFailure(response.status, responseBody, latencyMs);
      return {
        ok: false,
        payload: null,
        latencyMs,
        errorCode: failure.errorCode,
        errorMessage: failure.errorMessage,
        retryWithoutResponseFormat: failure.retryWithoutResponseFormat,
      };
    }
    try {
      const responsePayload = JSON.parse(responseBody) as {
        choices?: Array<{ message?: { content?: unknown } }>;
      };
      const content = responsePayload.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new Error("missing content");
      return {
        ok: true,
        payload: parseJsonResponseContent(content),
        latencyMs,
        errorCode: null,
        errorMessage: null,
        retryWithoutResponseFormat: false,
      };
    } catch {
      return {
        ok: false,
        payload: null,
        latencyMs,
        errorCode: "ai_model_response_invalid",
        errorMessage: "模型已响应，但未返回有效 JSON 对象",
        retryWithoutResponseFormat: false,
      };
    }
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    if (error instanceof Error && error.message === "ai_model_response_too_large") {
      return {
        ok: false,
        payload: null,
        latencyMs,
        errorCode: "ai_model_response_too_large",
        errorMessage: "模型接口响应内容超过 1MB 限制",
        retryWithoutResponseFormat: false,
      };
    }
    const requestAborted = signal?.aborted === true;
    return {
      ok: false,
      payload: null,
      latencyMs,
      errorCode: requestAborted ? "ai_model_request_aborted" : controller.signal.aborted ? "ai_model_timeout" : "ai_model_network_error",
      errorMessage: requestAborted ? "模型请求已随扫描任务停止" : controller.signal.aborted ? "模型接口请求超时" : "无法连接模型接口",
      retryWithoutResponseFormat: false,
    };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromParent);
  }
}

/** 请求 OpenAI Chat Completions 兼容模型返回 JSON；明确不支持 response_format 时只回退一次。 */
export async function requestOpenAiCompatibleJson(
  configuration: OpenAiCompatibleModelConfiguration,
  systemPrompt: string,
  input: Record<string, unknown>,
  options: OpenAiCompatibleJsonRequestOptions = {},
  signal?: AbortSignal,
): Promise<OpenAiCompatibleJsonResult> {
  const firstAttempt = await executeStructuredJsonAttempt(configuration, systemPrompt, input, true, options, signal);
  if (!firstAttempt.retryWithoutResponseFormat || signal?.aborted) {
    return {
      ok: firstAttempt.ok,
      payload: firstAttempt.payload,
      latencyMs: firstAttempt.latencyMs,
      errorCode: firstAttempt.errorCode,
      errorMessage: firstAttempt.errorMessage,
    };
  }
  const fallbackAttempt = await executeStructuredJsonAttempt(configuration, systemPrompt, input, false, options, signal);
  return {
    ok: fallbackAttempt.ok,
    payload: fallbackAttempt.payload,
    latencyMs: fallbackAttempt.latencyMs,
    errorCode: fallbackAttempt.errorCode,
    errorMessage: fallbackAttempt.errorMessage,
  };
}
