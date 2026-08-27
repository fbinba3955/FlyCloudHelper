import type { AvailableAiModel } from "@/lib/api";

export interface AiCleaningSettingsValue {
  enabled: boolean;
  modelId: string;
  triggerMode: "weak_only" | "weak_or_unmatched";
  minConfidence: number;
}

interface AiCleaningSettingsFieldsState {
  value: AiCleaningSettingsValue;
  models: AvailableAiModel[];
  loading: boolean;
  onChange: (value: AiCleaningSettingsValue) => void;
}

/** 编辑服务级 AI 查询词清洗配置；单一 state 入参保证父页面状态变化可以完整刷新。 */
export function AiCleaningSettingsFields({ state }: { state: AiCleaningSettingsFieldsState }) {
  const selectedModel = state.models.find((model) => model.id === state.value.modelId);
  const enabledModels = state.models.filter((model) => model.status === "enabled");

  /** 更新一个字段并保留其他 AI 清洗配置。 */
  function updateValue(patch: Partial<AiCleaningSettingsValue>): void {
    state.onChange({ ...state.value, ...patch });
  }

  return (
    <div className="rounded-xl border border-border bg-secondary/35 p-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-medium">AI 补充目录文件识别</p>
          <p className="mt-1 text-xs text-muted-foreground">只补充刮削查询词，不修改网盘目录、文件名、电影/节目类型和季集号。</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={state.value.enabled}
          aria-label="启用 AI 目录文件清洗"
          onClick={() => updateValue({ enabled: !state.value.enabled })}
          className={`relative h-7 w-12 shrink-0 rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${state.value.enabled ? "border-primary bg-primary" : "border-border bg-secondary"}`}
        >
          <span className={`absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow-sm transition-transform ${state.value.enabled ? "translate-x-5" : "translate-x-0"}`} />
        </button>
      </div>

      {state.value.enabled && (
        <div className="mt-4 grid gap-4 border-t border-border/70 pt-4 sm:grid-cols-2">
          <label className="block">
            <span className="text-xs text-muted-foreground">清洗模型</span>
            <select
              value={state.value.modelId}
              required
              disabled={state.loading}
              onChange={(event) => updateValue({ modelId: event.target.value })}
              className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm"
            >
              <option value="">{state.loading ? "正在读取模型…" : "请选择模型"}</option>
              {state.models.map((model) => (
                <option key={model.id} value={model.id} disabled={model.status !== "enabled"}>
                  {model.displayName}{model.status !== "enabled" ? "（已停用）" : model.available ? "（可用）" : "（未通过可用性测试）"}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-xs text-muted-foreground">触发策略</span>
            <select value={state.value.triggerMode} onChange={(event) => updateValue({ triggerMode: event.target.value as AiCleaningSettingsValue["triggerMode"] })} className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm">
              <option value="weak_or_unmatched">弱识别和首次未匹配时补充</option>
              <option value="weak_only">仅补充弱识别结果</option>
            </select>
          </label>
          <label className="block sm:col-span-2">
            <span className="text-xs text-muted-foreground">最低置信度</span>
            <select value={state.value.minConfidence} onChange={(event) => updateValue({ minConfidence: Number(event.target.value) })} className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm">
              <option value={0.65}>0.65（更积极）</option>
              <option value={0.75}>0.75（推荐）</option>
              <option value={0.85}>0.85（更谨慎）</option>
            </select>
          </label>
          {enabledModels.length === 0 && <p className="text-xs text-warning sm:col-span-2">当前没有启用的 AI 模型，请联系超级管理员先完成模型配置和可用性测试。</p>}
          {selectedModel?.status === "disabled" && <p className="text-xs text-warning sm:col-span-2">当前服务选择的模型已经停用，请改选启用模型后再保存。</p>}
          {selectedModel?.status === "enabled" && !selectedModel.available && <p className="text-xs text-warning sm:col-span-2">该模型尚未通过最近一次可用性测试；可以保存，但建议管理员先确认连接状态。</p>}
        </div>
      )}
    </div>
  );
}
