import { Check, ChevronLeft, ChevronRight, Folder, FolderOpen, LoaderCircle, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { PrimaryButton, SecondaryButton } from "@/components/ConsoleShell";
import {
  browseServiceDirectories,
  type ProviderDirectory,
  type ProviderDirectoryListing,
} from "@/lib/api";

interface ServicePathPickerProps {
  serviceId: string;
  admin: boolean;
  label: string;
  value: ProviderDirectory[];
  onConfirm: (directories: ProviderDirectory[]) => Promise<void>;
}

/** 为不同 Provider 生成稳定的目录选择键。 */
function getDirectoryKey(directory: Pick<ProviderDirectory, "driveId" | "resourceId" | "displayPath">): string {
  return `${directory.driveId ?? ""}:${directory.resourceId}`;
}

/** 从已保存扫描根补充仅用于页面展示的目录名称。 */
export function toProviderDirectory(directory: Omit<ProviderDirectory, "name"> & { name?: string }): ProviderDirectory {
  const normalizedPath = directory.displayPath.replace(/\/+$/u, "");
  return {
    ...directory,
    name: directory.name || normalizedPath.split("/").pop() || "/",
  };
}

/** 渲染只能通过网盘目录浏览结果进行选择的扫描路径控件。 */
export function ServicePathPicker({ serviceId, admin, label, value, onConfirm }: ServicePathPickerProps) {
  const [open, setOpen] = useState(false);
  const [draftValue, setDraftValue] = useState<ProviderDirectory[]>([]);
  const [listing, setListing] = useState<ProviderDirectoryListing | null>(null);
  const [history, setHistory] = useState<ProviderDirectory[]>([]);
  const [currentParent, setCurrentParent] = useState<ProviderDirectory | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  // 关键变量：请求序号用于丢弃快速切换目录时较晚返回的旧请求。
  const requestSequence = useRef(0);
  // 关键变量：弹窗内只操作临时选择集，点击确定后才同步给详情页。
  const selectedKeys = new Set(draftValue.map(getDirectoryKey));

  /** 弹窗打开时锁定页面滚动，并支持按 Esc 关闭。 */
  useEffect(() => {
    if (!open) return undefined;
    // 关键变量：保留页面原有滚动设置，关闭弹窗时完整恢复。
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = originalOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  /** 读取根目录或指定目录的直接子目录。 */
  async function loadDirectory(parent?: ProviderDirectory): Promise<void> {
    const currentSequence = requestSequence.current + 1;
    requestSequence.current = currentSequence;
    setCurrentParent(parent ?? null);
    setLoading(true);
    setError(null);
    try {
      const result = await browseServiceDirectories(serviceId, parent, admin);
      if (requestSequence.current !== currentSequence) return;
      const currentDirectoryKey = getDirectoryKey(result.current);
      const childDirectories = result.items.filter((directory) => getDirectoryKey(directory) !== currentDirectoryKey);
      if (childDirectories.length !== result.items.length) {
        console.warn("codex-path-picker-dialog", {
          事件: "过滤目录列表中的当前路径",
          服务ID: serviceId,
          当前路径: result.current.displayPath,
          过滤数量: result.items.length - childDirectories.length,
        });
      }
      setListing({ ...result, items: childDirectories });
    } catch (loadError) {
      if (requestSequence.current !== currentSequence) return;
      const errorMessage = loadError instanceof Error ? loadError.message : "读取网盘目录失败";
      console.warn("codex-path-picker-dialog", {
        事件: "读取网盘目录失败",
        服务ID: serviceId,
        管理模式: admin,
        错误信息: errorMessage,
      });
      setError(errorMessage);
    } finally {
      if (requestSequence.current === currentSequence) setLoading(false);
    }
  }

  /** 打开选择器时始终从 Provider 根目录开始。 */
  function openPicker(): void {
    setDraftValue(value);
    setConfirmError(null);
    setOpen(true);
    setHistory([]);
    setListing(null);
    void loadDirectory();
  }

  /** 进入选中的直接子目录。 */
  function enterDirectory(directory: ProviderDirectory): void {
    if (listing) setHistory((current) => [...current, listing.current]);
    void loadDirectory(directory);
  }

  /** 返回上一层；历史为空时保持在 Provider 根目录。 */
  function returnToParent(): void {
    if (history.length === 0) return;
    const parent = history[history.length - 1];
    setHistory((current) => current.slice(0, -1));
    void loadDirectory(parent);
  }

  /** 添加当前目录或列表中的一个目录，并避免重复选择。 */
  function selectDirectory(directory: ProviderDirectory): void {
    if (selectedKeys.has(getDirectoryKey(directory))) return;
    console.info("codex-path-picker-dialog", {
      事件: "选择扫描目录",
      服务ID: serviceId,
      目录路径: directory.displayPath,
      选择前数量: draftValue.length,
      选择后数量: draftValue.length + 1,
    });
    setDraftValue((current) => [...current, directory]);
  }

  /** 从弹窗的临时选择集中移除一个目录。 */
  function removeDraftDirectory(directory: ProviderDirectory): void {
    const removedKey = getDirectoryKey(directory);
    console.info("codex-path-picker-dialog", {
      事件: "移除已选扫描目录",
      服务ID: serviceId,
      目录路径: directory.displayPath,
      移除前数量: draftValue.length,
      移除后数量: Math.max(0, draftValue.length - 1),
    });
    setDraftValue((current) => current.filter((item) => getDirectoryKey(item) !== removedKey));
  }

  /** 确认本次目录修改，保存成功后才关闭弹窗并同步到详情页。 */
  async function confirmSelection(): Promise<void> {
    setConfirming(true);
    setConfirmError(null);
    try {
      await onConfirm(draftValue);
      setOpen(false);
    } catch (confirmFailure) {
      const errorMessage = confirmFailure instanceof Error ? confirmFailure.message : "扫描路径保存失败";
      console.warn("codex-path-picker-dialog", {
        事件: "确认并保存扫描路径失败",
        服务ID: serviceId,
        路径类型: label,
        已选数量: draftValue.length,
        错误信息: errorMessage,
      });
      setConfirmError(errorMessage);
    } finally {
      setConfirming(false);
    }
  }

  return (
    <div className="rounded-xl border border-border bg-secondary/30 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium">{label}</p>
          <p className="mt-1 text-[11px] text-muted-foreground">已选择 {value.length} 个目录</p>
        </div>
        <SecondaryButton onClick={openPicker}><FolderOpen className="size-4" /> 选择目录</SecondaryButton>
      </div>

      {value.length === 0 ? (
        <div className="mt-4 rounded-lg border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground">尚未选择目录</div>
      ) : (
        <ul className="mt-4 space-y-2">
          {value.map((directory) => (
            <li key={getDirectoryKey(directory)} className="flex items-center gap-3 rounded-lg border border-border bg-background/40 px-3 py-2.5">
              <Folder className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-xs" title={directory.displayPath}>{directory.displayPath}</span>
            </li>
          ))}
        </ul>
      )}

      {open && createPortal(
        <div className="fixed inset-0 z-[1000] grid place-items-center bg-black/65 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={`${label}路径选择`}>
          <div className="surface flex h-[82vh] w-full max-w-3xl flex-col overflow-hidden p-0">
            <header className="flex items-center justify-between gap-4 border-b border-border px-5 py-4">
              <div className="min-w-0">
                <h3 className="text-base font-semibold">选择{label}</h3>
                <p className="mt-1 truncate text-xs text-muted-foreground">{listing?.current.displayPath ?? "正在读取根目录…"}</p>
              </div>
              <button type="button" onClick={() => setOpen(false)} aria-label="关闭路径选择" className="grid size-9 shrink-0 place-items-center rounded-lg border border-border text-muted-foreground hover:text-foreground"><X className="size-4" /></button>
            </header>

            <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3">
              <SecondaryButton onClick={returnToParent} disabled={history.length === 0 || loading}><ChevronLeft className="size-4" /> 上一级</SecondaryButton>
              <PrimaryButton onClick={() => listing && selectDirectory(listing.current)} disabled={!listing || loading || (listing ? selectedKeys.has(getDirectoryKey(listing.current)) : true)}><Check className="size-4" /> 选择当前目录</PrimaryButton>
            </div>

            <div className="flex h-40 shrink-0 flex-col border-b border-border px-5 py-3">
              <p className="text-xs text-muted-foreground">已选目录 · {draftValue.length}</p>
              {draftValue.length === 0 ? (
                <p className="mt-2 grid min-h-0 flex-1 place-items-center rounded-lg border border-dashed border-border px-3 text-center text-xs text-muted-foreground">尚未选择目录</p>
              ) : (
                <ul className="mt-2 min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1 [scrollbar-gutter:stable]">
                  {draftValue.map((directory) => (
                    <li key={getDirectoryKey(directory)} className="flex items-center gap-2 rounded-lg border border-border bg-secondary/35 px-3 py-2">
                      <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate text-xs" title={directory.displayPath}>{directory.displayPath}</span>
                      <button type="button" onClick={() => removeDraftDirectory(directory)} aria-label={`删除已选路径 ${directory.displayPath}`} className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"><X className="size-3.5" /></button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-4 [scrollbar-gutter:stable]">
              {loading && <div className="grid min-h-52 place-items-center text-sm text-muted-foreground"><span className="inline-flex items-center gap-2"><LoaderCircle className="size-4 animate-spin" /> 正在读取网盘目录…</span></div>}
              {!loading && error && <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive"><p>{error}</p><button type="button" onClick={() => void loadDirectory(currentParent ?? undefined)} className="mt-3 rounded-md border border-destructive/40 px-3 py-1.5 text-xs">重新读取</button></div>}
              {!loading && !error && listing?.items.length === 0 && <div className="grid min-h-52 place-items-center text-sm text-muted-foreground">当前目录没有子目录，可以直接选择当前目录。</div>}
              {!loading && !error && listing && listing.items.length > 0 && (
                <ul className="space-y-2">
                  {listing.items.map((directory) => {
                    const selected = selectedKeys.has(getDirectoryKey(directory));
                    return (
                      <li key={getDirectoryKey(directory)} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 rounded-lg border border-border bg-secondary/35 p-2">
                        <button type="button" onClick={() => enterDirectory(directory)} className="flex min-w-0 items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-secondary">
                          <Folder className="size-4 shrink-0 text-muted-foreground" />
                          <span className="min-w-0"><span className="block truncate text-sm">{directory.name}</span><span className="block truncate text-[10px] text-muted-foreground">{directory.displayPath}</span></span>
                        </button>
                        <button type="button" onClick={() => selectDirectory(directory)} disabled={selected} className="w-16 rounded-md border border-border px-2 py-2 text-xs text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45">{selected ? "已选择" : "选择"}</button>
                        <button type="button" onClick={() => enterDirectory(directory)} aria-label={`进入 ${directory.name}`} className="grid size-9 place-items-center rounded-md border border-border text-muted-foreground hover:text-foreground"><ChevronRight className="size-4" /></button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <footer className="border-t border-border px-5 py-4">
              {confirmError && <p className="mb-3 text-xs text-destructive">{confirmError}</p>}
              <div className="flex items-center justify-between gap-4">
                <SecondaryButton onClick={() => setOpen(false)} disabled={confirming}>取消</SecondaryButton>
                <PrimaryButton onClick={() => void confirmSelection()} disabled={confirming}>{confirming ? "正在保存…" : "确定"}</PrimaryButton>
              </div>
            </footer>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
