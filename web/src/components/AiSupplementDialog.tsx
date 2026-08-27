import { Sparkles, X } from "lucide-react";
import { useEffect } from "react";
import type { JobAiSupplementResult } from "@/lib/api";
import { StatusPill } from "@/components/ui-kit";

interface AiSupplementDialogState {
  open: boolean;
  loading: boolean;
  error: string | null;
  jobId: string;
  result: JobAiSupplementResult | null;
  onClose: () => void;
}

/** 展示单个扫描任务采用 AI 查询词的汇总和最近 20 条内容。 */
export function AiSupplementDialog({ state }: { state: AiSupplementDialogState }) {
  useEffect(() => {
    if (!state.open) return;
    /** 按 Escape 关闭详情，避免键盘用户只能点击右上角按钮。 */
    const closeWithEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") state.onClose();
    };
    window.addEventListener("keydown", closeWithEscape);
    return () => window.removeEventListener("keydown", closeWithEscape);
  }, [state.open, state.onClose]);

  if (!state.open) return null;
  const items = state.result?.items ?? [];

  return (
    <div className="fixed inset-0 z-[1000] grid place-items-center bg-black/65 p-4 backdrop-blur-sm" onMouseDown={(event) => { if (event.target === event.currentTarget) state.onClose(); }}>
      <section role="dialog" aria-modal="true" aria-label="AI补充详情" className="relative flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div>
            <div className="flex items-center gap-2"><Sparkles className="size-5" /><h2 className="text-lg font-semibold">AI补充详情</h2></div>
            <p className="mt-1 font-mono text-[11px] text-muted-foreground">任务 {state.jobId}</p>
          </div>
          <button type="button" aria-label="关闭AI补充详情" onClick={state.onClose} className="rounded-lg border border-border p-2 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"><X className="size-4" /></button>
        </header>

        <div className="overflow-y-auto p-5">
          <div className="rounded-xl border border-border bg-secondary/35 p-5">
            <p className="text-xs text-muted-foreground">本任务总计 AI 补充</p>
            <p className="mt-2 font-display text-3xl font-semibold">{state.loading ? "—" : (state.result?.total ?? 0).toLocaleString()} <span className="text-base font-normal text-muted-foreground">部影片或节目</span></p>
            <p className="mt-2 text-xs text-muted-foreground">统计通过校验并实际采用的 AI 查询词，包含缓存命中；不代表最终一定成功匹配 TMDB。</p>
          </div>

          <div className="mt-5 flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold">最近 20 条内容</h3>
            {!state.loading && <span className="text-xs text-muted-foreground">当前展示 {items.length.toLocaleString()} 条</span>}
          </div>
          {state.loading && <p className="py-12 text-center text-sm text-muted-foreground">正在读取 AI 补充记录…</p>}
          {!state.loading && state.error && <p className="mt-4 rounded-xl border border-destructive/30 bg-destructive/8 p-4 text-sm text-destructive">{state.error}</p>}
          {!state.loading && !state.error && items.length === 0 && <p className="py-12 text-center text-sm text-muted-foreground">当前任务还没有采用 AI 补充内容</p>}
          {!state.loading && !state.error && items.length > 0 && (
            <ul className="mt-3 space-y-3">
              {items.map((item) => (
                <li key={item.id} className="rounded-xl border border-border bg-background/45 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusPill>{item.mediaType === "tv" ? "节目" : "电影"}</StatusPill>
                      <StatusPill>{item.triggerReason === "规则弱标题" ? "弱标题补充" : "首次未匹配补充"}</StatusPill>
                    </div>
                    <span className="text-[11px] text-muted-foreground">{new Date(item.createdAt).toLocaleString("zh-CN")}</span>
                  </div>
                  <dl className="mt-3 grid gap-3 sm:grid-cols-2">
                    <div><dt className="text-[11px] text-muted-foreground">规则查询词</dt><dd className="mt-1 break-words text-sm">{item.ruleTitle || "空标题"}</dd></div>
                    <div><dt className="text-[11px] text-muted-foreground">AI补充查询词</dt><dd className="mt-1 break-words text-sm font-medium">{item.cleanedTitle}</dd></div>
                    {item.alternateTitle && <div className="sm:col-span-2"><dt className="text-[11px] text-muted-foreground">AI备用查询词</dt><dd className="mt-1 break-words text-sm">{item.alternateTitle}</dd></div>}
                  </dl>
                  <p className="mt-3 text-[11px] text-muted-foreground">模型 {item.modelDisplayName} · 修订 {item.modelRevision} · 置信度 {(item.confidence * 100).toFixed(0)}% · 关联文件 {item.fileCount.toLocaleString()} 个</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
