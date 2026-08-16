import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { MatchState, MediaItem } from "@/lib/api";

export type StatusTone = "neutral" | "primary" | "success" | "warning" | "danger" | "info";

/** 展示带文字的业务状态，状态不能只依赖颜色表达。 */
export function StatusPill({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: StatusTone;
  className?: string;
}) {
  const toneClass: Record<StatusTone, string> = {
    neutral: "border-border bg-secondary text-muted-foreground",
    primary: "border-primary/30 bg-primary/15 text-primary-soft",
    success: "border-success/25 bg-success/12 text-success",
    warning: "border-warning/25 bg-warning/12 text-warning",
    danger: "border-destructive/25 bg-destructive/12 text-destructive",
    info: "border-info/25 bg-info/12 text-info",
  };

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium tracking-wide",
        toneClass[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** 展示页面中的带标题内容面板。 */
export function Panel({
  title,
  description,
  action,
  children,
  className,
}: {
  title?: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("surface p-5 sm:p-6", className)}>
      {(title || action) && (
        <header className="mb-5 grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
          <div className="min-w-0">
            {title && <h2 className="truncate text-base font-semibold">{title}</h2>}
            {description && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

/** 展示概览统计值。 */
export function StatCard({
  label,
  value,
  hint,
  action,
  tone = "primary",
}: {
  label: string;
  value: string;
  hint?: string;
  action?: ReactNode;
  tone?: "primary" | "info" | "warning" | "muted";
}) {
  const topBar: Record<string, string> = {
    primary: "from-primary to-primary-soft",
    info: "from-info to-primary-soft",
    warning: "from-warning to-destructive",
    muted: "from-muted-foreground/60 to-muted-foreground/20",
  };

  return (
    <div className="surface relative overflow-hidden p-5">
      <div className={cn("absolute inset-x-0 top-0 h-px bg-gradient-to-r opacity-80", topBar[tone])} />
      <p className="text-xs tracking-wide text-muted-foreground">{label}</p>
      <p className="font-display mt-3 text-3xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="mt-2 text-[11px] text-muted-foreground">{hint}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** 展示任务确定或不确定进度。 */
export function ProgressMeter({ value, total }: { value: number; total: number | null }) {
  const percent = total && total > 0 ? Math.min(100, Math.round((value / total) * 100)) : null;

  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
      {percent === null ? (
        <div className="h-full w-1/3 animate-pulse rounded-full bg-gradient-to-r from-primary/40 via-primary to-primary/40" />
      ) : (
        <div
          className="h-full rounded-full bg-gradient-to-r from-primary to-primary-soft"
          style={{ width: `${percent}%` }}
        />
      )}
    </div>
  );
}

/** 展示可切换的紧凑筛选项。 */
export function FilterChip({
  children,
  active = false,
  onClick,
}: {
  children: ReactNode;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "shrink-0 rounded-full border px-3.5 py-1.5 text-xs transition-colors",
        active
          ? "border-primary/40 bg-primary/15 text-primary-soft"
          : "border-border bg-secondary/60 text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

/** 展示可进入只读详情、但不提供播放能力的媒体海报卡片。 */
export function PosterCard({ item, onClick }: { item: MediaItem; onClick?: () => void }) {
  const statusTone: Record<MatchState, StatusTone> = {
    matched: "success",
    needs_review: "warning",
    unmatched: "danger",
    processing: "info",
  };
  const statusLabels: Record<MatchState, string> = {
    matched: "已匹配",
    needs_review: "待确认",
    unmatched: "未匹配",
    processing: "处理中",
  };
  const mediaTypeLabels = { video: "视频", music: "音乐", audiobook: "有声书" } as const;
  const itemTypeLabels: Record<string, string> = {
    "video.movie": "电影",
    "video.series": "节目",
    "music.album": "音乐专辑",
    "audiobook.book": "有声书",
  };
  const hue = [...item.id].reduce((sum, character) => sum + character.charCodeAt(0), 0) % 360;

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`查看${item.title}详情`}
      className="group w-full cursor-pointer text-left"
    >
      <div
        className={cn(
          "relative overflow-hidden rounded-xl border border-border transition-all duration-300 group-hover:-translate-y-1 group-hover:glow-ring",
          item.mediaType === "video" ? "aspect-[2/3]" : "aspect-square",
        )}
        style={{
          background: `linear-gradient(150deg, oklch(0.44 0.1 ${hue}), oklch(0.19 0.035 264) 78%)`,
        }}
      >
        {item.posterUrl && (
          <img src={item.posterUrl} alt="" className="absolute inset-0 size-full object-cover" loading="lazy" />
        )}
        <div className="grid-noise absolute inset-0 opacity-60" />
        <div className="absolute inset-0 bg-gradient-to-t from-background/85 via-transparent to-transparent" />
        <span className="font-display absolute top-3 left-3 text-[11px] tracking-[0.2em] text-foreground/70 uppercase">
          {itemTypeLabels[item.itemType] ?? mediaTypeLabels[item.mediaType]}
        </span>
        <div className="absolute inset-x-3 bottom-3">
          <StatusPill tone={statusTone[item.matchState]}>{statusLabels[item.matchState]}</StatusPill>
        </div>
      </div>
      <h3 className="mt-2.5 truncate text-sm font-medium">{item.title}</h3>
      <p className="truncate text-[11px] text-muted-foreground">
        {item.subtitle || item.itemType} · {item.year ?? "年份未知"}
      </p>
    </button>
  );
}
