import { BrainCircuit, CheckCircle2, Pencil, Plus, RefreshCw, TestTube2, X } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { PageHeader, PrimaryButton, SecondaryButton } from "@/components/ConsoleShell";
import { Panel, StatusPill, type StatusTone } from "@/components/ui-kit";
import {
  createAdminAiModel,
  listAdminAiModels,
  testAdminAiModel,
  updateAdminAiModel,
  updateAdminAiModelStatus,
  type AiModel,
  type AiModelCheckStatus,
  type SaveAiModelInput,
} from "@/lib/api";
import { useApiResource } from "@/lib/use-api-resource";

const checkStatusLabels: Record<AiModelCheckStatus, string> = {
  unknown: "未测试",
  available: "可用",
  unavailable: "不可用",
};

const checkStatusTones: Record<AiModelCheckStatus, StatusTone> = {
  unknown: "neutral",
  available: "success",
  unavailable: "danger",
};

/** 将最近测试时间转换为当前浏览器时区的中文时间。 */
function formatCheckedAt(checkedAt: string | null): string {
  return checkedAt ? new Date(checkedAt).toLocaleString("zh-CN") : "尚未测试";
}

/** 输出统一前端诊断日志，不包含模型地址、API Key 或远端响应原文。 */
function logAiModelActionFailure(event: string, modelId: string | null, error: unknown): void {
  console.warn("codex-flycloud-helper-ai-clean", {
    事件: event,
    模型ID: modelId ?? "新建模型",
    错误信息: error instanceof Error ? error.message : "未知错误",
  });
}

/** AI 模型新建和编辑表单。 */
function AiModelForm({
  model,
  submitting,
  onCancel,
  onSubmit,
}: {
  model: AiModel | null;
  submitting: boolean;
  onCancel: () => void;
  onSubmit: (input: SaveAiModelInput) => Promise<void>;
}) {
  /** 从浏览器表单读取明确类型的模型配置。 */
  async function submitForm(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const apiKey = String(form.get("apiKey") ?? "").trim();
    await onSubmit({
      displayName: String(form.get("displayName") ?? "").trim(),
      protocol: "openai_chat_completions",
      status: String(form.get("status") ?? "enabled") === "disabled" ? "disabled" : "enabled",
      baseUrl: String(form.get("baseUrl") ?? "").trim(),
      modelName: String(form.get("modelName") ?? "").trim(),
      timeoutMs: Number(form.get("timeoutMs") ?? 30000),
      maxConcurrency: Number(form.get("maxConcurrency") ?? 1),
      ...(apiKey ? { apiKey } : {}),
      ...(model && form.get("clearApiKey") === "on" ? { clearApiKey: true } : {}),
    });
  }

  const inputClassName = "mt-2 w-full rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm";
  return (
    <Panel
      title={model ? `编辑模型：${model.displayName}` : "添加 AI 模型"}
      description="首期支持 OpenAI Chat Completions 兼容接口；接口地址可填写 /v1 或完整 /chat/completions 地址。"
      className="mb-4"
      action={<button type="button" onClick={onCancel} aria-label="关闭模型表单" className="rounded-lg border border-border p-2 text-muted-foreground hover:text-foreground"><X className="size-4" /></button>}
    >
      <form onSubmit={(event) => void submitForm(event)} className="grid gap-4 md:grid-cols-2">
        <label>
          <span className="text-xs font-medium">显示名称</span>
          <input name="displayName" required maxLength={100} defaultValue={model?.displayName ?? ""} placeholder="例如：本地 Qwen" className={inputClassName} />
        </label>
        <label>
          <span className="text-xs font-medium">模型名称</span>
          <input name="modelName" required maxLength={255} defaultValue={model?.modelName ?? ""} placeholder="例如：qwen3-8b" className={inputClassName} />
        </label>
        <label className="md:col-span-2">
          <span className="text-xs font-medium">接口地址</span>
          <input name="baseUrl" required type="url" maxLength={1000} defaultValue={model?.baseUrl ?? ""} placeholder="例如：http://192.168.1.10:11434/v1" className={inputClassName} />
        </label>
        <label>
          <span className="text-xs font-medium">API Key（可选）</span>
          <input name="apiKey" type="password" maxLength={4096} autoComplete="new-password" placeholder={model?.apiKeyConfigured ? "留空保留当前 Key" : "本地无鉴权模型可留空"} className={inputClassName} />
        </label>
        <label>
          <span className="text-xs font-medium">状态</span>
          <select name="status" defaultValue={model?.status ?? "enabled"} className={inputClassName}>
            <option value="enabled">启用</option>
            <option value="disabled">停用</option>
          </select>
        </label>
        <label>
          <span className="text-xs font-medium">超时时间（毫秒）</span>
          <input name="timeoutMs" required type="number" min={3000} max={120000} step={1000} defaultValue={model?.timeoutMs ?? 30000} className={inputClassName} />
        </label>
        <label>
          <span className="text-xs font-medium">最大并发</span>
          <select name="maxConcurrency" defaultValue={model?.maxConcurrency ?? 1} className={inputClassName}>
            {[1, 2, 3, 4].map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        {model?.apiKeyConfigured && (
          <label className="flex items-center gap-2 text-xs text-muted-foreground md:col-span-2">
            <input name="clearApiKey" type="checkbox" className="size-4 rounded border-input" />
            明确清除当前 API Key
          </label>
        )}
        <p className="text-xs text-muted-foreground md:col-span-2">API Key 只会加密保存且不会回显。保存配置后，最近一次可用性测试状态会重置为“未测试”。</p>
        <div className="flex flex-wrap justify-end gap-2 md:col-span-2">
          <SecondaryButton onClick={onCancel} disabled={submitting}>取消</SecondaryButton>
          <PrimaryButton type="submit" disabled={submitting}>{submitting ? "正在保存…" : model ? "保存新修订" : "添加模型"}</PrimaryButton>
        </div>
      </form>
    </Panel>
  );
}

/** 超级管理员 AI 模型配置与可用性测试页面。 */
export function AdminAiModelsPage() {
  const resource = useApiResource(() => listAdminAiModels(), []);
  const [formOpen, setFormOpen] = useState(false);
  const [editingModel, setEditingModel] = useState<AiModel | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [activeAction, setActiveAction] = useState<string | null>(null);
  // 关键变量：同步占用保存、启停和测试操作，避免状态刷新前重复提交。
  const activeActionRef = useRef<string | null>(null);

  /** 打开新增模型表单并清除上一次编辑对象。 */
  function openCreateForm(): void {
    setEditingModel(null);
    setFormOpen(true);
    setMessage(null);
  }

  /** 打开指定模型编辑表单。 */
  function openEditForm(model: AiModel): void {
    setEditingModel(model);
    setFormOpen(true);
    setMessage(null);
  }

  /** 在页面级互斥锁中执行模型操作，并统一记录失败信息。 */
  async function runAction(actionKey: string, event: string, modelId: string | null, action: () => Promise<void>): Promise<void> {
    if (activeActionRef.current) return;
    activeActionRef.current = actionKey;
    setActiveAction(actionKey);
    try {
      await action();
    } catch (error) {
      logAiModelActionFailure(event, modelId, error);
      setMessage(error instanceof Error ? error.message : "AI 模型操作失败");
    } finally {
      activeActionRef.current = null;
      setActiveAction(null);
    }
  }

  /** 创建模型或保存已有模型的新配置修订。 */
  async function saveModel(input: SaveAiModelInput): Promise<void> {
    const actionKey = editingModel ? `save:${editingModel.id}` : "save:new";
    await runAction(actionKey, editingModel ? "更新AI模型配置失败" : "创建AI模型配置失败", editingModel?.id ?? null, async () => {
      const model = editingModel
        ? await updateAdminAiModel(editingModel.id, input)
        : await createAdminAiModel(input);
      setFormOpen(false);
      setEditingModel(null);
      setMessage(`${model.displayName} 已保存，当前配置修订 r${model.configurationRevision}`);
      await resource.refresh();
    });
  }

  /** 切换模型启停状态。 */
  async function toggleModelStatus(model: AiModel): Promise<void> {
    const nextStatus = model.status === "enabled" ? "disabled" : "enabled";
    await runAction(`status:${model.id}`, "修改AI模型状态失败", model.id, async () => {
      const updatedModel = await updateAdminAiModelStatus(model.id, nextStatus);
      setMessage(`${updatedModel.displayName} 已${nextStatus === "enabled" ? "启用" : "停用"}`);
      await resource.refresh();
    });
  }

  /** 执行真实模型对话和 JSON 输出测试。 */
  async function testModel(model: AiModel): Promise<void> {
    await runAction(`test:${model.id}`, "测试AI模型可用性失败", model.id, async () => {
      setMessage(`正在测试 ${model.displayName}…`);
      const response = await testAdminAiModel(model.id);
      setMessage(response.result.available
        ? `${model.displayName} 可用，结构化输出通过，耗时 ${response.result.latencyMs} 毫秒`
        : `${model.displayName} 不可用：${response.result.errorMessage ?? response.result.errorCode ?? "未知原因"}`);
      await resource.refresh();
    });
  }

  const models = resource.data?.items ?? [];
  return (
    <>
      <PageHeader
        title="AI 模型"
        actions={(
          <>
            <SecondaryButton onClick={() => void resource.refresh()} disabled={resource.loading}><RefreshCw className="size-4" /> 刷新</SecondaryButton>
            <PrimaryButton onClick={openCreateForm}><Plus className="size-4" /> 添加模型</PrimaryButton>
          </>
        )}
      />
      {formOpen && (
        <AiModelForm
          key={editingModel?.id ?? "new"}
          model={editingModel}
          submitting={activeAction?.startsWith("save:") === true}
          onCancel={() => { setFormOpen(false); setEditingModel(null); }}
          onSubmit={saveModel}
        />
      )}
      {(message || resource.error) && <Panel className="mb-4"><p className={resource.error ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>{resource.error ?? message}</p></Panel>}
      {resource.loading && models.length === 0 && <Panel><p className="py-12 text-center text-sm text-muted-foreground">正在读取 AI 模型配置…</p></Panel>}
      {!resource.loading && models.length === 0 && (
        <Panel>
          <div className="py-12 text-center">
            <BrainCircuit className="mx-auto size-10 text-muted-foreground" />
            <p className="mt-4 text-sm font-medium">尚未添加 AI 模型</p>
            <p className="mt-2 text-xs text-muted-foreground">添加 OpenAI Chat Completions 兼容模型后，可先在这里验证接口可用性。</p>
          </div>
        </Panel>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        {models.map((model) => (
          <article key={model.id} className="surface p-5">
            <header className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="truncate text-sm font-semibold">{model.displayName}</h2>
                <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">{model.modelName}</p>
              </div>
              <div className="flex flex-wrap justify-end gap-2">
                <StatusPill tone={model.status === "enabled" ? "success" : "neutral"}>{model.status === "enabled" ? "已启用" : "已停用"}</StatusPill>
                <StatusPill tone={checkStatusTones[model.lastCheckStatus]}>{checkStatusLabels[model.lastCheckStatus]}</StatusPill>
              </div>
            </header>
            <dl className="mt-5 grid gap-3 text-xs sm:grid-cols-2">
              <div className="rounded-lg border border-border bg-secondary/40 p-3"><dt className="text-muted-foreground">配置修订</dt><dd className="mt-1 font-medium">r{model.configurationRevision}</dd></div>
              <div className="rounded-lg border border-border bg-secondary/40 p-3"><dt className="text-muted-foreground">API Key</dt><dd className="mt-1 font-medium">{model.apiKeyConfigured ? "已加密配置" : "未配置"}</dd></div>
              <div className="rounded-lg border border-border bg-secondary/40 p-3"><dt className="text-muted-foreground">超时与并发</dt><dd className="mt-1 font-medium">{model.timeoutMs.toLocaleString()} ms · {model.maxConcurrency}</dd></div>
              <div className="rounded-lg border border-border bg-secondary/40 p-3"><dt className="text-muted-foreground">最近测试</dt><dd className="mt-1 font-medium">{formatCheckedAt(model.lastCheckedAt)}</dd></div>
            </dl>
            <p className="mt-3 truncate font-mono text-[11px] text-muted-foreground" title={model.baseUrl}>{model.baseUrl}</p>
            {model.lastCheckStatus === "available" && (
              <p className="mt-3 flex items-center gap-2 text-xs text-success"><CheckCircle2 className="size-4" /> JSON 结构化输出通过 · {model.lastCheckLatencyMs ?? 0} 毫秒</p>
            )}
            {model.lastCheckStatus === "unavailable" && (
              <p className="mt-3 text-xs text-destructive">{model.lastCheckErrorMessage ?? model.lastCheckErrorCode ?? "模型测试失败"}</p>
            )}
            <footer className="mt-5 flex flex-wrap gap-2">
              <button type="button" disabled={Boolean(activeAction)} onClick={() => void testModel(model)} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-secondary/30 px-3 py-2 text-xs hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-40"><TestTube2 className="size-3.5" /> {activeAction === `test:${model.id}` ? "测试中…" : "测试可用性"}</button>
              <button type="button" disabled={Boolean(activeAction)} onClick={() => openEditForm(model)} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-secondary/30 px-3 py-2 text-xs hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-40"><Pencil className="size-3.5" /> 编辑</button>
              <button type="button" disabled={Boolean(activeAction)} onClick={() => void toggleModelStatus(model)} className="rounded-lg border border-border bg-secondary/30 px-3 py-2 text-xs hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-40">{activeAction === `status:${model.id}` ? "处理中…" : model.status === "enabled" ? "停用" : "启用"}</button>
            </footer>
          </article>
        ))}
      </div>
    </>
  );
}
