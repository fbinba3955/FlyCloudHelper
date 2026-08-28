import { randomUUID } from "node:crypto";
import type { Knex } from "knex";
import type { FlyCloudHelperDatabase } from "../database.js";
import {
  type AiModelAvailabilityResult,
  type AiCleaningTriggerMode,
  type AiModelProtocol,
  type AiModelRecord,
  type AiModelStatus,
  type AiModelTaskSnapshot,
  parseJsonObject,
} from "../domain.js";
import { ApiError, validationError } from "../errors.js";
import type { CredentialVault } from "../secrets.js";
import {
  requestOpenAiCompatibleJson,
  testOpenAiCompatibleModel,
  type OpenAiCompatibleJsonResult,
  type OpenAiCompatibleJsonRequestOptions,
} from "./openai-compatible-client.js";

export const AI_VIDEO_NAME_CLEAN_PROMPT_VERSION = "video-name-clean-v3-flymby";

export interface AiStructuredJsonRequestOptions extends OpenAiCompatibleJsonRequestOptions {
  /** 业务请求允许高于模型配置的最低超时，避免批量输出被短连接测试超时截断。 */
  minimumTimeoutMs?: number;
}

export interface AiCleaningSettings {
  enabled: boolean;
  modelId: string;
  triggerMode: AiCleaningTriggerMode;
  minConfidence: number;
}

interface ModelSemaphoreWaiter {
  signal?: AbortSignal;
  resolve: (release: (() => void) | null) => void;
}

/** 为单个不可变模型修订限制独立请求并发，并允许扫描取消排队等待。 */
class ModelRequestSemaphore {
  private activeCount = 0;
  private readonly waiters: ModelSemaphoreWaiter[] = [];

  public constructor(private readonly maximumConcurrency: number) {}

  /** 取得一个模型请求槽位；等待期间任务取消时返回空。 */
  public async acquire(signal?: AbortSignal): Promise<(() => void) | null> {
    if (signal?.aborted) return null;
    return new Promise((resolve) => {
      let waiter: ModelSemaphoreWaiter;
      const abortWhileWaiting = (): void => {
        const waiterIndex = this.waiters.indexOf(waiter);
        if (waiterIndex < 0) return;
        this.waiters.splice(waiterIndex, 1);
        resolve(null);
      };
      waiter = {
        signal,
        resolve: (release) => {
          signal?.removeEventListener("abort", abortWhileWaiting);
          resolve(release);
        },
      };
      signal?.addEventListener("abort", abortWhileWaiting, { once: true });
      this.waiters.push(waiter);
      this.dispatch();
    });
  }

  /** 按先进先出顺序发放空闲槽位。 */
  private dispatch(): void {
    while (this.activeCount < this.maximumConcurrency && this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      if (waiter.signal?.aborted) {
        waiter.resolve(null);
        continue;
      }
      this.activeCount += 1;
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        this.activeCount -= 1;
        this.dispatch();
      });
    }
  }
}

/** 从服务元数据配置中读取 AI 清洗设置，旧服务默认关闭。 */
export function readAiCleaningSettings(metadataProfile: Record<string, unknown>): AiCleaningSettings {
  const profiles = metadataProfile.profiles && typeof metadataProfile.profiles === "object" && !Array.isArray(metadataProfile.profiles)
    ? metadataProfile.profiles as Record<string, unknown>
    : {};
  const videoProfile = profiles.video && typeof profiles.video === "object" && !Array.isArray(profiles.video)
    ? profiles.video as Record<string, unknown>
    : {};
  const aiCleaning = videoProfile.aiCleaning && typeof videoProfile.aiCleaning === "object" && !Array.isArray(videoProfile.aiCleaning)
    ? videoProfile.aiCleaning as Record<string, unknown>
    : {};
  return {
    enabled: aiCleaning.enabled === true,
    modelId: typeof aiCleaning.modelId === "string" ? aiCleaning.modelId.trim() : "",
    triggerMode: aiCleaning.triggerMode === "weak_only" ? "weak_only" : "weak_or_unmatched",
    minConfidence: typeof aiCleaning.minConfidence === "number" ? aiCleaning.minConfidence : 0.75,
  };
}

export interface CreateAiModelInput {
  displayName?: unknown;
  protocol?: unknown;
  status?: unknown;
  baseUrl?: unknown;
  modelName?: unknown;
  timeoutMs?: unknown;
  maxConcurrency?: unknown;
  apiKey?: unknown;
}

export interface UpdateAiModelInput {
  displayName?: unknown;
  protocol?: unknown;
  status?: unknown;
  baseUrl?: unknown;
  modelName?: unknown;
  timeoutMs?: unknown;
  maxConcurrency?: unknown;
  apiKey?: unknown;
  clearApiKey?: unknown;
}

interface AiModelConfigurationRow {
  id: string;
  display_name: string;
  protocol: AiModelProtocol;
  status: AiModelStatus;
  configuration_revision: number;
  base_url: string;
  model_name: string;
  timeout_ms: number;
  max_concurrency: number;
  encrypted_secrets: string | null;
  configuration_state_json: string;
  last_check_status: "unknown" | "available" | "unavailable";
  last_check_error_code: string | null;
  last_check_error_message: string | null;
  last_check_latency_ms: number | null;
  last_check_structured_output: number;
  last_checked_at: string | null;
  created_at: string;
  updated_at: string;
}

const supportedProtocol: AiModelProtocol = "openai_chat_completions";

/** 读取必填短文本并按字段给出明确校验错误。 */
function requireText(value: unknown, field: string, label: string, maximumLength: number): string {
  if (typeof value !== "string" || !value.trim()) throw validationError(field, `${label}不能为空`);
  const text = value.trim();
  if (text.length > maximumLength) throw validationError(field, `${label}不能超过 ${maximumLength} 个字符`);
  return text;
}

/** 校验当前阶段唯一支持的 OpenAI Chat Completions 兼容协议。 */
function validateProtocol(value: unknown): AiModelProtocol {
  const protocol = value === undefined ? supportedProtocol : value;
  if (protocol !== supportedProtocol) {
    throw validationError("protocol", "当前只支持 OpenAI Chat Completions 兼容协议");
  }
  return supportedProtocol;
}

/** 校验模型启停状态。 */
function validateStatus(value: unknown, fallback: AiModelStatus = "enabled"): AiModelStatus {
  const status = value === undefined ? fallback : value;
  if (status !== "enabled" && status !== "disabled") {
    throw validationError("status", "模型状态必须为 enabled 或 disabled");
  }
  return status;
}

/** 校验 HTTP(S) 模型地址，不允许把凭据、查询参数或锚点混入地址。 */
function validateBaseUrl(value: unknown): string {
  const baseUrl = requireText(value, "baseUrl", "模型接口地址", 1000);
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(baseUrl);
  } catch {
    throw validationError("baseUrl", "模型接口地址格式不正确");
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw validationError("baseUrl", "模型接口地址只支持 HTTP 或 HTTPS");
  }
  if (parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
    throw validationError("baseUrl", "模型接口地址不能包含账号、密码、查询参数或锚点");
  }
  return baseUrl;
}

/** 校验整数配置，避免隐式转换隐藏管理端输入错误。 */
function validateInteger(
  value: unknown,
  field: string,
  label: string,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  const result = value === undefined ? fallback : value;
  if (typeof result !== "number" || !Number.isInteger(result) || result < minimum || result > maximum) {
    throw validationError(field, `${label}必须是 ${minimum} 到 ${maximum} 之间的整数`);
  }
  return result;
}

/** 校验可选 API Key；空字符串表示本次没有提交新 Key。 */
function validateApiKey(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw validationError("apiKey", "API Key 格式不正确");
  const apiKey = value.trim();
  if (!apiKey) return null;
  if (apiKey.length > 4096) throw validationError("apiKey", "API Key 不能超过 4096 个字符");
  return apiKey;
}

/** 把联表结果转换为不含 Secret 的管理端模型记录。 */
function mapAiModel(row: AiModelConfigurationRow): AiModelRecord {
  const configurationState = parseJsonObject(row.configuration_state_json);
  return {
    id: String(row.id),
    displayName: String(row.display_name),
    protocol: row.protocol,
    status: row.status,
    configurationRevision: Number(row.configuration_revision),
    baseUrl: String(row.base_url),
    modelName: String(row.model_name),
    timeoutMs: Number(row.timeout_ms),
    maxConcurrency: Number(row.max_concurrency),
    apiKeyConfigured: configurationState.apiKeyConfigured === true,
    lastCheckStatus: row.last_check_status,
    lastCheckErrorCode: row.last_check_error_code ? String(row.last_check_error_code) : null,
    lastCheckErrorMessage: row.last_check_error_message ? String(row.last_check_error_message) : null,
    lastCheckLatencyMs: row.last_check_latency_ms === null ? null : Number(row.last_check_latency_ms),
    lastCheckStructuredOutput: Number(row.last_check_structured_output) === 1,
    lastCheckedAt: row.last_checked_at ? String(row.last_checked_at) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/** 统一生成模型与当前配置修订的联表查询。 */
function createCurrentConfigurationQuery(database: Knex): Knex.QueryBuilder {
  return database("ai_model_profiles as p")
    .join("ai_model_configurations as c", function joinCurrentConfiguration() {
      this.on("c.model_id", "=", "p.id").andOn("c.revision", "=", "p.configuration_revision");
    })
    .select(
      "p.id",
      "p.display_name",
      "p.protocol",
      "p.status",
      "p.configuration_revision",
      "p.last_check_status",
      "p.last_check_error_code",
      "p.last_check_error_message",
      "p.last_check_latency_ms",
      "p.last_check_structured_output",
      "p.last_checked_at",
      "p.created_at",
      "p.updated_at",
      "c.base_url",
      "c.model_name",
      "c.timeout_ms",
      "c.max_concurrency",
      "c.encrypted_secrets",
      "c.configuration_state_json",
    );
}

/** 管理 AI 模型配置修订、加密 Key 与可用性测试状态。 */
export class AiModelManager {
  private readonly requestSemaphores = new Map<string, ModelRequestSemaphore>();

  public constructor(
    private readonly database: FlyCloudHelperDatabase,
    private readonly vault: CredentialVault,
  ) {}

  /** 按最近更新时间返回全部模型。 */
  public async listModels(): Promise<AiModelRecord[]> {
    const rows = await createCurrentConfigurationQuery(this.database.query)
      .orderBy("p.updated_at", "desc") as AiModelConfigurationRow[];
    return rows.map(mapAiModel);
  }

  /** 读取指定模型及当前配置修订。 */
  public async getModel(modelId: string): Promise<AiModelRecord> {
    return mapAiModel(await this.requireCurrentConfiguration(modelId));
  }

  /** 校验服务启用的模型仍存在且处于启用状态。 */
  public async validateMetadataProfile(metadataProfile: Record<string, unknown>): Promise<void> {
    const settings = readAiCleaningSettings(metadataProfile);
    if (!settings.enabled) return;
    const profile = await this.database.query("ai_model_profiles").where({ id: settings.modelId }).first();
    if (!profile) throw validationError("metadata.profiles.video.aiCleaning.modelId", "选择的 AI 模型不存在");
    if (profile.status !== "enabled") {
      throw validationError("metadata.profiles.video.aiCleaning.modelId", "选择的 AI 模型已停用");
    }
  }

  /** 为新扫描任务冻结当前模型修订和服务级触发策略。 */
  public async buildTaskSnapshot(metadataProfile: Record<string, unknown>): Promise<AiModelTaskSnapshot | null> {
    const settings = readAiCleaningSettings(metadataProfile);
    if (!settings.enabled) return null;
    const profile = await this.database.query("ai_model_profiles")
      .select("id", "status", "configuration_revision")
      .where({ id: settings.modelId })
      .first();
    if (!profile || profile.status !== "enabled") {
      throw new ApiError(409, "ai_model_not_enabled", "服务选择的 AI 模型不存在或已停用，请先修改元数据配置");
    }
    return {
      modelId: String(profile.id),
      configurationRevision: Number(profile.configuration_revision),
      promptVersion: AI_VIDEO_NAME_CLEAN_PROMPT_VERSION,
      triggerMode: settings.triggerMode,
      minConfidence: settings.minConfidence,
    };
  }

  /** 为媒体库未匹配内容补充任务冻结模型，并强制重新请求而不复用历史成功缓存。 */
  public async buildUnmatchedSupplementTaskSnapshot(
    metadataProfile: Record<string, unknown>,
  ): Promise<AiModelTaskSnapshot | null> {
    const snapshot = await this.buildTaskSnapshot(metadataProfile);
    return snapshot ? {
      ...snapshot,
      triggerMode: "weak_or_unmatched",
      forceRefresh: true,
    } : null;
  }

  /** 返回用户可选择的启用模型，并按需附带当前服务已选择但后来停用的模型。 */
  public async listAvailableModels(selectedModelId = ""): Promise<Array<{
    id: string;
    displayName: string;
    status: AiModelStatus;
    available: boolean;
  }>> {
    const query = this.database.query("ai_model_profiles")
      .select("id", "display_name", "status", "last_check_status")
      .where({ status: "enabled" });
    if (selectedModelId) query.orWhere({ id: selectedModelId });
    const rows = await query.orderBy("display_name", "asc");
    return rows.map((row) => ({
      id: String(row.id),
      displayName: String(row.display_name),
      status: row.status === "disabled" ? "disabled" : "enabled",
      available: row.status === "enabled" && row.last_check_status === "available",
    }));
  }

  /** 使用任务冻结的配置修订发送 JSON 请求，并受单模型并发和扫描取消控制。 */
  public async requestStructuredJson(
    snapshot: AiModelTaskSnapshot,
    systemPrompt: string,
    input: Record<string, unknown>,
    options: AiStructuredJsonRequestOptions = {},
    signal?: AbortSignal,
  ): Promise<OpenAiCompatibleJsonResult> {
    const configuration = await this.database.query("ai_model_configurations")
      .where({ model_id: snapshot.modelId, revision: snapshot.configurationRevision })
      .first();
    if (!configuration) {
      return {
        ok: false,
        payload: null,
        latencyMs: 0,
        errorCode: "ai_model_configuration_missing",
        errorMessage: "扫描任务冻结的 AI 模型配置修订不存在",
      };
    }
    const secrets = configuration.encrypted_secrets ? this.vault.decrypt(String(configuration.encrypted_secrets)) : {};
    const semaphoreKey = `${snapshot.modelId}@${snapshot.configurationRevision}`;
    let semaphore = this.requestSemaphores.get(semaphoreKey);
    if (!semaphore) {
      semaphore = new ModelRequestSemaphore(Number(configuration.max_concurrency));
      this.requestSemaphores.set(semaphoreKey, semaphore);
    }
    const release = await semaphore.acquire(signal);
    if (!release) {
      return {
        ok: false,
        payload: null,
        latencyMs: 0,
        errorCode: "ai_model_request_aborted",
        errorMessage: "模型请求已随扫描任务停止",
      };
    }
    try {
      const result = await requestOpenAiCompatibleJson({
        baseUrl: String(configuration.base_url),
        modelName: String(configuration.model_name),
        apiKey: typeof secrets.apiKey === "string" ? secrets.apiKey : null,
        timeoutMs: Math.max(Number(configuration.timeout_ms), Number(options.minimumTimeoutMs ?? 0)),
      }, systemPrompt, input, options, signal);
      if (result.errorCode !== "ai_model_request_aborted") {
        await this.database.query("ai_model_profiles")
          .where({ id: snapshot.modelId, configuration_revision: snapshot.configurationRevision })
          .update({
            last_check_status: result.ok ? "available" : "unavailable",
            last_check_error_code: result.errorCode,
            last_check_error_message: result.errorMessage,
            last_check_latency_ms: result.latencyMs,
            last_check_structured_output: result.ok ? 1 : 0,
            last_checked_at: new Date().toISOString(),
          });
      }
      return result;
    } finally {
      release();
    }
  }

  /** 创建模型和第一份不可变配置修订。 */
  public async createModel(input: CreateAiModelInput): Promise<AiModelRecord> {
    const displayName = requireText(input.displayName, "displayName", "显示名称", 100);
    const protocol = validateProtocol(input.protocol);
    const status = validateStatus(input.status);
    const baseUrl = validateBaseUrl(input.baseUrl);
    const modelName = requireText(input.modelName, "modelName", "模型名称", 255);
    const timeoutMs = validateInteger(input.timeoutMs, "timeoutMs", "超时时间", 3000, 120000, 30000);
    const maxConcurrency = validateInteger(input.maxConcurrency, "maxConcurrency", "最大并发", 1, 4, 1);
    const apiKey = validateApiKey(input.apiKey);
    const modelId = randomUUID();
    const now = new Date().toISOString();

    await this.database.query.transaction(async (transaction) => {
      await transaction("ai_model_profiles").insert({
        id: modelId,
        display_name: displayName,
        protocol,
        status,
        configuration_revision: 1,
        last_check_status: "unknown",
        last_check_structured_output: 0,
        created_at: now,
        updated_at: now,
      });
      await transaction("ai_model_configurations").insert({
        id: randomUUID(),
        model_id: modelId,
        revision: 1,
        base_url: baseUrl,
        model_name: modelName,
        timeout_ms: timeoutMs,
        max_concurrency: maxConcurrency,
        encrypted_secrets: apiKey ? this.vault.encrypt({ apiKey }) : null,
        configuration_state_json: JSON.stringify({ apiKeyConfigured: Boolean(apiKey) }),
        created_at: now,
      });
    });
    return this.getModel(modelId);
  }

  /** 保存新的模型配置修订；空 Key 保留旧值，明确清除时才删除。 */
  public async updateModel(modelId: string, input: UpdateAiModelInput): Promise<AiModelRecord> {
    if (input.clearApiKey !== undefined && typeof input.clearApiKey !== "boolean") {
      throw validationError("clearApiKey", "清除 API Key 标记格式不正确");
    }
    const submittedApiKey = validateApiKey(input.apiKey);
    if (input.clearApiKey === true && submittedApiKey) {
      throw validationError("apiKey", "不能同时提交新 API Key 和清除 API Key");
    }

    await this.database.query.transaction(async (transaction) => {
      const current = await createCurrentConfigurationQuery(transaction)
        .where("p.id", modelId)
        .first() as AiModelConfigurationRow | undefined;
      if (!current) throw new ApiError(404, "ai_model_not_found", "AI 模型不存在");

      const displayName = input.displayName === undefined
        ? current.display_name
        : requireText(input.displayName, "displayName", "显示名称", 100);
      const protocol = input.protocol === undefined ? current.protocol : validateProtocol(input.protocol);
      const status = input.status === undefined ? current.status : validateStatus(input.status, current.status);
      const baseUrl = input.baseUrl === undefined ? current.base_url : validateBaseUrl(input.baseUrl);
      const modelName = input.modelName === undefined
        ? current.model_name
        : requireText(input.modelName, "modelName", "模型名称", 255);
      const timeoutMs = validateInteger(input.timeoutMs, "timeoutMs", "超时时间", 3000, 120000, Number(current.timeout_ms));
      const maxConcurrency = validateInteger(input.maxConcurrency, "maxConcurrency", "最大并发", 1, 4, Number(current.max_concurrency));
      const currentSecrets = current.encrypted_secrets ? this.vault.decrypt(current.encrypted_secrets) : {};
      // 关键变量：只有提交新 Key 或明确勾选清除时才改变当前密钥，编辑普通字段不会误删 Secret。
      const apiKey = input.clearApiKey === true
        ? null
        : submittedApiKey ?? (typeof currentSecrets.apiKey === "string" ? currentSecrets.apiKey : null);
      const configurationRevision = Number(current.configuration_revision) + 1;
      const now = new Date().toISOString();

      await transaction("ai_model_configurations").insert({
        id: randomUUID(),
        model_id: modelId,
        revision: configurationRevision,
        base_url: baseUrl,
        model_name: modelName,
        timeout_ms: timeoutMs,
        max_concurrency: maxConcurrency,
        encrypted_secrets: apiKey ? this.vault.encrypt({ apiKey }) : null,
        configuration_state_json: JSON.stringify({ apiKeyConfigured: Boolean(apiKey) }),
        created_at: now,
      });
      await transaction("ai_model_profiles").where({ id: modelId }).update({
        display_name: displayName,
        protocol,
        status,
        configuration_revision: configurationRevision,
        last_check_status: "unknown",
        last_check_error_code: null,
        last_check_error_message: null,
        last_check_latency_ms: null,
        last_check_structured_output: 0,
        last_checked_at: null,
        updated_at: now,
      });
    });
    return this.getModel(modelId);
  }

  /** 只修改模型启停状态，不创建不必要的配置修订。 */
  public async updateStatus(modelId: string, statusValue: unknown): Promise<AiModelRecord> {
    if (statusValue === undefined) throw validationError("status", "模型状态不能为空");
    const status = validateStatus(statusValue);
    const changedRows = await this.database.query("ai_model_profiles").where({ id: modelId }).update({
      status,
      updated_at: new Date().toISOString(),
    });
    if (changedRows !== 1) throw new ApiError(404, "ai_model_not_found", "AI 模型不存在");
    return this.getModel(modelId);
  }

  /** 使用当前配置执行真实对话与 JSON 结构测试，并持久化最后一次结果。 */
  public async testAvailability(modelId: string): Promise<AiModelAvailabilityResult> {
    const current = await this.requireCurrentConfiguration(modelId);
    const secrets = current.encrypted_secrets ? this.vault.decrypt(current.encrypted_secrets) : {};
    const result = await testOpenAiCompatibleModel({
      baseUrl: current.base_url,
      modelName: current.model_name,
      apiKey: typeof secrets.apiKey === "string" ? secrets.apiKey : null,
      timeoutMs: Number(current.timeout_ms),
    });
    const checkedAt = new Date().toISOString();
    // 关键变量：测试期间如果管理员保存了新修订，旧配置的测试结果不能覆盖新修订状态。
    await this.database.query("ai_model_profiles")
      .where({ id: modelId, configuration_revision: Number(current.configuration_revision) })
      .update({
        last_check_status: result.available ? "available" : "unavailable",
        last_check_error_code: result.errorCode,
        last_check_error_message: result.errorMessage,
        last_check_latency_ms: result.latencyMs,
        last_check_structured_output: result.structuredOutput ? 1 : 0,
        last_checked_at: checkedAt,
        updated_at: checkedAt,
      });
    return result;
  }

  /** 返回系统配置摘要所需的模型数量和最近可用状态。 */
  public async getSummary(): Promise<{
    configuredCount: number;
    enabledCount: number;
    availableCount: number;
    unavailableCount: number;
  }> {
    const rows = await this.database.query("ai_model_profiles").select("status", "last_check_status");
    return {
      configuredCount: rows.length,
      enabledCount: rows.filter((row) => row.status === "enabled").length,
      availableCount: rows.filter((row) => row.status === "enabled" && row.last_check_status === "available").length,
      unavailableCount: rows.filter((row) => row.status === "enabled" && row.last_check_status === "unavailable").length,
    };
  }

  /** 读取当前修订联表记录，不存在时返回统一业务错误。 */
  private async requireCurrentConfiguration(modelId: string): Promise<AiModelConfigurationRow> {
    const row = await createCurrentConfigurationQuery(this.database.query)
      .where("p.id", modelId)
      .first() as AiModelConfigurationRow | undefined;
    if (!row) throw new ApiError(404, "ai_model_not_found", "AI 模型不存在");
    return row;
  }
}
