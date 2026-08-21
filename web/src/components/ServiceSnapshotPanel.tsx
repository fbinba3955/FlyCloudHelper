import { RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { PrimaryButton, SecondaryButton } from "@/components/ConsoleShell";
import { Panel, ProgressMeter, StatusPill, type StatusTone } from "@/components/ui-kit";
import {
  deleteLibrarySnapshot,
  createServiceSnapshot,
  listServiceSnapshots,
  type LibrarySnapshotExport,
  type LibrarySnapshotStatus,
} from "@/lib/api";
import { useApiResource } from "@/lib/use-api-resource";

const snapshotStatusLabels: Record<LibrarySnapshotStatus, string> = {
  queued: "排队中",
  running: "生成中",
  completed: "已完成",
  failed: "失败",
};

const snapshotStageLabels: Record<string, string> = {
  queued: "等待生成",
  preparing: "统计媒体库",
  relations: "写入媒体关系",
  media_items: "写入媒体条目",
  files: "写入源文件",
  compressing: "正在压缩快照",
  completed: "生成完成",
  failed: "生成失败",
};

/** 将快照状态映射为页面状态颜色。 */
function getSnapshotTone(status: LibrarySnapshotStatus): StatusTone {
  if (status === "completed") return "success";
  if (status === "failed") return "danger";
  if (status === "running") return "primary";
  return "warning";
}

/** 将字节数格式化为适合快照列表显示的文件大小。 */
function formatFileSize(value: number | null): string {
  if (value === null || value <= 0) return "尚未生成文件";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 将 ISO 时间转换为快照列表时间。 */
function formatSnapshotTime(value: string | null): string {
  return value ? new Date(value).toLocaleString("zh-CN") : "—";
}

/** 判断快照是否仍由服务端后台生成。 */
function isActiveSnapshot(snapshot: LibrarySnapshotExport): boolean {
  return snapshot.status === "queued" || snapshot.status === "running";
}

/** 在单个服务详情中展示云端快照、生成进度和删除入口。 */
export function ServiceSnapshotPanel({
  serviceId,
  libraryId,
  admin,
}: {
  serviceId: string;
  libraryId: string;
  admin: boolean;
}) {
  const resource = useApiResource(
    () => listServiceSnapshots(serviceId, libraryId, admin),
    [serviceId, libraryId, admin],
  );
  const [deletingExportId, setDeletingExportId] = useState<string | null>(null);
  const deletingExportIdRef = useRef<string | null>(null);
  const [creatingSnapshot, setCreatingSnapshot] = useState(false);
  const creatingSnapshotRef = useRef(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  // 关键变量：项目只接受 v3 ZIP 快照，旧版本不参与展示和页面状态判断。
  const visibleSnapshots = (resource.data ?? []).filter((snapshot) => snapshot.formatVersion === 3);
  const hasActiveSnapshot = visibleSnapshots.some(isActiveSnapshot);

  useEffect(() => {
    if (!hasActiveSnapshot) return;
    // 关键变量：只有存在生成中任务时才每 5 秒刷新，结束后立即停止轮询。
    const timer = window.setInterval(() => void resource.refresh(), 5_000);
    return () => window.clearInterval(timer);
  }, [hasActiveSnapshot, resource.refresh]);

  /** 从网页创建当前服务的 v3 ZIP 云端快照任务。 */
  async function createSnapshot(): Promise<void> {
    if (hasActiveSnapshot) {
      setActionMessage("当前服务已经有正在生成的快照");
      return;
    }
    if (creatingSnapshotRef.current) {
      console.warn("codex-flycloud-snapshot-task", {
        事件: "拦截网页重复创建快照请求",
        服务ID: serviceId,
        媒体库ID: libraryId,
      });
      return;
    }
    creatingSnapshotRef.current = true;
    setCreatingSnapshot(true);
    setActionMessage("正在创建云端快照任务…");
    try {
      const snapshot = await createServiceSnapshot(serviceId, libraryId, admin);
      setActionMessage(`快照任务 ${snapshot.id} 已进入队列`);
      await resource.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "创建云端快照失败";
      console.warn("codex-flycloud-snapshot-task", {
        事件: "网页创建云端快照失败",
        服务ID: serviceId,
        媒体库ID: libraryId,
        错误信息: errorMessage,
      });
      setActionMessage(errorMessage);
    } finally {
      creatingSnapshotRef.current = false;
      setCreatingSnapshot(false);
    }
  }

  /** 二次确认后删除一份已经结束的快照及其服务端文件。 */
  async function deleteSnapshot(snapshot: LibrarySnapshotExport): Promise<void> {
    if (isActiveSnapshot(snapshot)) {
      setActionMessage("正在生成的云端快照不能删除");
      return;
    }
    if (deletingExportIdRef.current !== null) {
      console.warn("codex-flycloud-snapshot-delete", {
        事件: "拦截重复删除快照请求",
        正在删除导出ID: deletingExportIdRef.current,
        本次导出ID: snapshot.id,
      });
      return;
    }
    const confirmed = window.confirm(
      `确定删除目录版本 v${snapshot.catalogVersion} 的云端快照吗？服务端快照文件会同时删除，此操作无法撤销。`,
    );
    if (!confirmed) return;

    deletingExportIdRef.current = snapshot.id;
    setDeletingExportId(snapshot.id);
    setActionMessage("正在删除云端快照…");
    console.info("codex-flycloud-snapshot-delete", {
      事件: "网页开始删除云端快照",
      服务ID: serviceId,
      媒体库ID: libraryId,
      导出ID: snapshot.id,
    });
    try {
      await deleteLibrarySnapshot(snapshot.id, admin);
      setActionMessage("云端快照已删除");
      await resource.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "云端快照删除失败";
      console.warn("codex-flycloud-snapshot-delete", {
        事件: "网页删除云端快照失败",
        服务ID: serviceId,
        媒体库ID: libraryId,
        导出ID: snapshot.id,
        错误信息: errorMessage,
      });
      setActionMessage(errorMessage);
    } finally {
      deletingExportIdRef.current = null;
      setDeletingExportId(null);
    }
  }

  return (
    <Panel
      title="云端快照"
      className="mt-4"
      action={(
        <div className="flex flex-wrap gap-2">
          <SecondaryButton disabled={resource.loading} onClick={() => void resource.refresh()}>
            <RefreshCw className={`size-4 ${resource.loading ? "animate-spin" : ""}`} />
            刷新
          </SecondaryButton>
          <PrimaryButton
            disabled={resource.loading || hasActiveSnapshot || creatingSnapshot || deletingExportId !== null}
            onClick={() => void createSnapshot()}
          >
            {creatingSnapshot ? "正在创建…" : hasActiveSnapshot ? "正在生成" : "生成新快照"}
          </PrimaryButton>
        </div>
      )}
    >
      {resource.error && <p className="mb-4 text-sm text-destructive">{resource.error}</p>}
      {actionMessage && <p className="mb-4 text-sm text-muted-foreground">{actionMessage}</p>}
      {hasActiveSnapshot && <p className="mb-4 text-xs text-muted-foreground">存在正在生成的快照，页面每 5 秒刷新一次进度。</p>}
      <div className="grid gap-3">
        {visibleSnapshots.map((snapshot) => {
          const active = isActiveSnapshot(snapshot);
          const deleting = deletingExportId === snapshot.id;
          return (
            <article key={snapshot.id} className="rounded-xl border border-border bg-secondary/35 p-4">
              <header className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold">目录版本 v{snapshot.catalogVersion}</h3>
                    <StatusPill tone={getSnapshotTone(snapshot.status)}>{snapshotStatusLabels[snapshot.status]}</StatusPill>
                  </div>
                  <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">{snapshot.id}</p>
                </div>
                <button
                  type="button"
                  disabled={active || deletingExportId !== null}
                  title={active ? "正在生成的快照不能删除" : "删除云端快照"}
                  onClick={() => void deleteSnapshot(snapshot)}
                  className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-destructive/45 bg-destructive/10 px-3 py-2 text-xs font-medium text-destructive transition-colors hover:bg-destructive/15 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Trash2 className="size-3.5" />
                  {deleting ? "正在删除…" : "删除"}
                </button>
              </header>

              <div className="mt-4">
                <div className="mb-2 flex items-center justify-between gap-3 text-xs text-muted-foreground">
                  <span>{snapshotStageLabels[snapshot.stage] ?? "处理中"}</span>
                  <span className="tabular-nums">{snapshot.progressPercent}%</span>
                </div>
                <ProgressMeter value={snapshot.progressPercent} total={100} />
                <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[11px] text-muted-foreground">
                  <span>已处理 {snapshot.processedCount.toLocaleString()}</span>
                  <span>总记录 {snapshot.totalCount.toLocaleString()}</span>
                  <span>ZIP 分片</span>
                  <span>{formatFileSize(snapshot.fileSize)}</span>
                </div>
              </div>

              <dl className="mt-4 grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-3">
                <div><dt className="text-muted-foreground">开始生成</dt><dd className="mt-1">{formatSnapshotTime(snapshot.createdAt)}</dd></div>
                <div><dt className="text-muted-foreground">最近更新</dt><dd className="mt-1">{formatSnapshotTime(snapshot.updatedAt)}</dd></div>
                <div><dt className="text-muted-foreground">生成完成</dt><dd className="mt-1">{formatSnapshotTime(snapshot.completedAt)}</dd></div>
              </dl>
              {snapshot.errorMessage && <p className="mt-4 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">{snapshot.errorMessage}</p>}
            </article>
          );
        })}
      </div>
      {!resource.loading && visibleSnapshots.length === 0 && (
        <p className="py-8 text-center text-sm text-muted-foreground">当前服务还没有云端快照</p>
      )}
    </Panel>
  );
}
