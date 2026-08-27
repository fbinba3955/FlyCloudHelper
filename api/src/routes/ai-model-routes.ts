import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { CreateAiModelInput, UpdateAiModelInput } from "../ai/ai-model-manager.js";
import { readAiCleaningSettings } from "../ai/ai-model-manager.js";
import type { AiModelRecord } from "../domain.js";
import { requireRequestUser, requireSuperAdmin } from "../http.js";
import type { ApiRuntime } from "../runtime.js";

/** 写入 AI 模型管理审计，不保存地址、API Key 或请求响应原文。 */
async function auditAiModel(
  runtime: ApiRuntime,
  operator: { id: string; username: string },
  operationType: string,
  modelId: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await runtime.database.addAudit({
    id: randomUUID(),
    operatorUserId: operator.id,
    operatorUsername: operator.username,
    operationType,
    targetType: "ai_model",
    targetId: modelId,
    result: "success",
    detail,
  });
}

/** 记录模型配置操作的统一诊断日志，不输出任何 Secret。 */
function logModelConfiguration(
  runtime: ApiRuntime,
  operatorId: string,
  event: string,
  model: AiModelRecord,
): void {
  runtime.logBusinessEvent("info", {
    日志关键字: "codex-flycloud-helper-ai-clean",
    事件: event,
    管理员ID: operatorId,
    模型ID: model.id,
    模型修订: model.configurationRevision,
    模型状态: model.status,
    Key是否配置: model.apiKeyConfigured,
  });
}

/** 查询单个扫描任务采用 AI 查询词的总数和最近 20 条记录。 */
async function readJobAiSupplements(
  runtime: ApiRuntime,
  jobId: string,
  userId?: string,
): Promise<Record<string, unknown>> {
  const job = await runtime.repository.getJob(jobId, userId);
  const totalRow = await runtime.database.query("ai_video_name_clean_usages")
    .where({ job_id: job.id })
    .count({ total: "id" })
    .first();
  const rows = await runtime.database.query("ai_video_name_clean_usages as u")
    .leftJoin("ai_model_profiles as p", "p.id", "u.model_id")
    .select("u.*", "p.display_name as model_display_name")
    .where("u.job_id", job.id)
    .orderBy("u.created_at", "desc")
    .limit(20);
  runtime.logBusinessEvent("info", {
    日志关键字: "codex-flycloud-helper-ai-clean",
    事件: "查看任务AI补充详情",
    任务ID: job.id,
    服务ID: job.serviceId,
    用户ID: job.userId,
    AI补充总数: Number(totalRow?.total ?? 0),
    最近记录数量: rows.length,
  });
  return {
    total: Number(totalRow?.total ?? 0),
    items: rows.map((row) => ({
      id: String(row.id),
      mediaType: row.media_type === "tv" ? "tv" : "movie",
      triggerReason: String(row.trigger_reason),
      ruleTitle: String(row.rule_title),
      cleanedTitle: String(row.cleaned_title),
      alternateTitle: String(row.alternate_title ?? ""),
      confidence: Number(row.confidence),
      fileCount: Number(row.file_count),
      modelId: String(row.model_id),
      modelDisplayName: row.model_display_name ? String(row.model_display_name) : "已删除模型",
      modelRevision: Number(row.model_revision),
      createdAt: String(row.created_at),
    })),
  };
}

/** 注册超级管理员 AI 模型配置、启停和可用性测试接口。 */
export async function registerAiModelRoutes(server: FastifyInstance, runtime: ApiRuntime): Promise<void> {
  /** 返回服务配置页可选择的模型；已停用但仍被服务选中的模型仅用于回显。 */
  server.get<{ Querystring: { serviceId?: string } }>("/api/v1/ai-models/available", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    let selectedModelId: string | undefined;
    if (request.query.serviceId) {
      const service = user.role === "super_admin"
        ? await runtime.repository.getServiceDetail(request.query.serviceId)
        : await runtime.repository.getServiceDetail(request.query.serviceId, user.id);
      selectedModelId = readAiCleaningSettings(service.metadataProfile).modelId ?? undefined;
    }
    const models = await runtime.aiModels.listAvailableModels(selectedModelId);
    return { items: models, total: models.length };
  });

  server.get<{ Params: { jobId: string } }>("/api/v1/scan-jobs/:jobId/ai-supplements", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    return readJobAiSupplements(runtime, request.params.jobId, user.id);
  });

  server.get<{ Params: { jobId: string } }>("/api/v1/admin/jobs/:jobId/ai-supplements", async (request) => {
    await requireSuperAdmin(request, runtime.database);
    return readJobAiSupplements(runtime, request.params.jobId);
  });

  server.get("/api/v1/admin/ai-models", async (request) => {
    await requireSuperAdmin(request, runtime.database);
    const models = await runtime.aiModels.listModels();
    return { items: models, total: models.length };
  });

  server.post<{ Body: CreateAiModelInput }>("/api/v1/admin/ai-models", async (request, reply) => {
    const operator = await requireSuperAdmin(request, runtime.database);
    const model = await runtime.aiModels.createModel(request.body ?? {});
    logModelConfiguration(runtime, operator.id, "创建AI模型配置", model);
    await auditAiModel(runtime, operator, "create_ai_model", model.id, {
      模型修订: model.configurationRevision,
      模型状态: model.status,
      Key是否配置: model.apiKeyConfigured,
    });
    return reply.status(201).send({ model });
  });

  server.put<{ Params: { modelId: string }; Body: UpdateAiModelInput }>(
    "/api/v1/admin/ai-models/:modelId",
    async (request) => {
      const operator = await requireSuperAdmin(request, runtime.database);
      const model = await runtime.aiModels.updateModel(request.params.modelId, request.body ?? {});
      logModelConfiguration(runtime, operator.id, "更新AI模型配置", model);
      await auditAiModel(runtime, operator, "update_ai_model", model.id, {
        模型修订: model.configurationRevision,
        模型状态: model.status,
        Key是否配置: model.apiKeyConfigured,
      });
      return { model };
    },
  );

  server.patch<{ Params: { modelId: string }; Body: Record<string, unknown> }>(
    "/api/v1/admin/ai-models/:modelId/status",
    async (request) => {
      const operator = await requireSuperAdmin(request, runtime.database);
      const model = await runtime.aiModels.updateStatus(request.params.modelId, request.body?.status);
      logModelConfiguration(runtime, operator.id, model.status === "enabled" ? "启用AI模型" : "停用AI模型", model);
      await auditAiModel(runtime, operator, `${model.status === "enabled" ? "enable" : "disable"}_ai_model`, model.id, {
        模型状态: model.status,
      });
      return { model };
    },
  );

  server.post<{ Params: { modelId: string } }>(
    "/api/v1/admin/ai-models/:modelId/test",
    async (request) => {
      const operator = await requireSuperAdmin(request, runtime.database);
      const result = await runtime.aiModels.testAvailability(request.params.modelId);
      runtime.logBusinessEvent(result.available ? "info" : "warn", {
        日志关键字: "codex-flycloud-helper-ai-clean",
        事件: "测试AI模型可用性",
        管理员ID: operator.id,
        模型ID: request.params.modelId,
        可用状态: result.available,
        结构化输出: result.structuredOutput,
        耗时毫秒: result.latencyMs,
        错误码: result.errorCode,
      });
      await auditAiModel(runtime, operator, "test_ai_model_availability", request.params.modelId, {
        可用状态: result.available,
        结构化输出: result.structuredOutput,
        耗时毫秒: result.latencyMs,
        错误码: result.errorCode,
      });
      return { result, model: await runtime.aiModels.getModel(request.params.modelId) };
    },
  );
}
