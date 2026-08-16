import { Check, Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import { PrimaryButton, SecondaryButton } from "@/components/ConsoleShell";
import { StatusPill } from "@/components/ui-kit";
import {
  applyManualVideoMatch,
  searchManualVideoMatches,
  type ManualVideoMatchCandidate,
  type ManualVideoMatchType,
  type MediaItem,
} from "@/lib/api";
import { cn } from "@/lib/utils";

/** 从当前标题和扫描元数据生成与 Flymby APP 同语义的辅助搜索词。 */
function buildSearchHints(item: MediaItem): string[] {
  const values = [
    item.metadata.query,
    item.metadata.seriesTitle,
    item.metadata.matchedQuery,
    item.metadata.originalTitle,
    item.title,
  ];
  const hints = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || !value.trim()) continue;
    const text = value.trim();
    hints.add(text);
    const simplified = text
      .replace(/[（(\[].*?[）)\]]/gu, " ")
      .replace(/[._·_-]+/gu, " ")
      .replace(/\s+/gu, " ")
      .trim();
    if (simplified) hints.add(simplified);
  }
  return [...hints].slice(0, 8);
}

/** 显示电影或节目候选，并将最终选择交给服务端重新读取详情后保存。 */
export function MediaManualMatchDialog({
  item,
  admin,
  onApplied,
  onClose,
}: {
  item: MediaItem;
  admin: boolean;
  onApplied: (item: MediaItem) => void;
  onClose: () => void;
}) {
  const initialQuery = typeof item.metadata.query === "string"
    ? item.metadata.query
    : typeof item.metadata.matchedQuery === "string" ? item.metadata.matchedQuery : item.title;
  const [query, setQuery] = useState(initialQuery);
  const [year, setYear] = useState(item.year ? String(item.year) : "");
  const [mediaType, setMediaType] = useState<ManualVideoMatchType>(item.itemType === "video.series" ? "tv" : "movie");
  // 关键变量：候选 ID 只用于用户确认，提交后后台会重新读取完整 TMDB 详情。
  const [candidates, setCandidates] = useState<ManualVideoMatchCandidate[]>([]);
  const [selectedCandidateId, setSelectedCandidateId] = useState<number | null>(null);
  const [searching, setSearching] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchHints = useMemo(() => buildSearchHints(item), [item]);
  const selectedCandidate = candidates.find((candidate) => candidate.id === selectedCandidateId) ?? null;

  /** 按当前电影或节目类型搜索 TMDB 候选。 */
  async function search(): Promise<void> {
    if (!query.trim() || searching) return;
    setSearching(true);
    setError(null);
    setSelectedCandidateId(null);
    try {
      const result = await searchManualVideoMatches(item, {
        query: query.trim(),
        mediaType,
        year: year ? Number(year) : null,
      }, admin);
      setCandidates(result);
      if (result.length === 0) setError("没有找到匹配结果，请修改名称、年份或影视类型后重试");
    } catch (searchError) {
      setCandidates([]);
      setError(searchError instanceof Error ? searchError.message : "匹配结果搜索失败");
    } finally {
      setSearching(false);
    }
  }

  /** 确认选择后只提交候选 ID 和类型，完整详情由后台重新读取。 */
  async function applySelectedCandidate(): Promise<void> {
    if (!selectedCandidate || applying) return;
    setApplying(true);
    setError(null);
    try {
      const updatedItem = await applyManualVideoMatch(item, {
        mediaType: selectedCandidate.mediaType,
        tmdbId: selectedCandidate.id,
      }, admin);
      onApplied(updatedItem);
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : "手动匹配保存失败");
    } finally {
      setApplying(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] grid place-items-center p-3 sm:p-6">
      <button type="button" aria-label="关闭手动匹配" onClick={onClose} className="absolute inset-0 bg-black/75 backdrop-blur-sm" />
      <section role="dialog" aria-modal="true" aria-label="手动匹配影视信息" className="relative flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-2xl">
        <div className="flex items-center gap-3 border-b border-border px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold">手动匹配</h2>
            <p className="mt-1 text-xs text-muted-foreground">选择电影或节目，并从 TMDB 搜索结果中确认正确条目</p>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭" className="ml-auto grid size-9 place-items-center rounded-full border border-border text-muted-foreground hover:text-foreground">
            <X className="size-4" />
          </button>
        </div>

        <div className="border-b border-border p-5">
          <div className="grid gap-3 sm:grid-cols-[auto_minmax(0,1fr)_110px_auto]">
            <div className="flex rounded-lg border border-border bg-secondary/40 p-1">
              {([{"value":"movie","label":"电影"},{"value":"tv","label":"节目"}] as const).map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => {
                    setMediaType(option.value);
                    setCandidates([]);
                    setSelectedCandidateId(null);
                    setError(null);
                  }}
                  className={cn("rounded-md px-3 py-2 text-sm", mediaType === option.value ? "bg-foreground font-semibold text-background" : "text-muted-foreground")}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") void search(); }}
              aria-label="影视名称"
              placeholder="输入影视名称"
              className="rounded-lg border border-input bg-background/50 px-3 py-2 text-sm outline-none focus:border-foreground/40"
            />
            <input
              value={year}
              onChange={(event) => setYear(event.target.value.replace(/\D/gu, "").slice(0, 4))}
              aria-label="年份"
              inputMode="numeric"
              placeholder="年份"
              className="rounded-lg border border-input bg-background/50 px-3 py-2 text-sm outline-none focus:border-foreground/40"
            />
            <PrimaryButton onClick={() => void search()} disabled={searching || !query.trim()}>
              <Search className="size-4" /> {searching ? "搜索中" : "搜索"}
            </PrimaryButton>
          </div>
          {searchHints.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {searchHints.map((hint) => (
                <button key={hint} type="button" onClick={() => setQuery(hint)} className="rounded-full border border-border bg-secondary/40 px-3 py-1 text-xs text-muted-foreground hover:text-foreground">
                  {hint}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="min-h-64 flex-1 overflow-y-auto p-5">
          {error && <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
          {searching ? (
            <div className="grid min-h-56 place-items-center text-sm text-muted-foreground">正在搜索 TMDB…</div>
          ) : candidates.length > 0 ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {candidates.map((candidate) => {
                const selected = selectedCandidateId === candidate.id;
                return (
                  <button
                    key={`${candidate.mediaType}-${candidate.id}`}
                    type="button"
                    onClick={() => setSelectedCandidateId(candidate.id)}
                    className={cn("grid grid-cols-[72px_minmax(0,1fr)_24px] gap-3 rounded-xl border p-3 text-left", selected ? "border-foreground/50 bg-secondary" : "border-border bg-secondary/25 hover:bg-secondary/50")}
                  >
                    <div className="aspect-[2/3] overflow-hidden rounded-lg bg-secondary">
                      {candidate.posterUrl ? <img src={candidate.posterUrl} alt="" className="size-full object-cover" /> : <div className="grid size-full place-items-center text-[10px] text-muted-foreground">暂无海报</div>}
                    </div>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <StatusPill>{candidate.mediaType === "tv" ? "节目" : "电影"}</StatusPill>
                        <span className="text-xs text-muted-foreground">TMDB {candidate.id}</span>
                      </div>
                      <p className="mt-2 line-clamp-2 text-sm font-medium">{candidate.title}</p>
                      <p className="mt-1 truncate text-xs text-muted-foreground">{candidate.originalTitle || "无原始标题"} · {candidate.year ?? "年份未知"}</p>
                      <p className="mt-2 line-clamp-2 text-xs leading-5 text-muted-foreground">{candidate.overview || "暂无简介"}</p>
                    </div>
                    <span className={cn("mt-1 grid size-5 place-items-center rounded-full border", selected ? "border-foreground bg-foreground text-background" : "border-border text-transparent")}>
                      <Check className="size-3" />
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="grid min-h-56 place-items-center text-sm text-muted-foreground">输入名称后搜索电影或节目</div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-5 py-4">
          <SecondaryButton onClick={onClose}>取消</SecondaryButton>
          <PrimaryButton onClick={() => void applySelectedCandidate()} disabled={!selectedCandidate || applying}>
            {applying ? "保存中" : "确定匹配"}
          </PrimaryButton>
        </div>
      </section>
    </div>
  );
}
