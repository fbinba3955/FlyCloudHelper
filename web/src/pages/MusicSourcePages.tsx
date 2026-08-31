import { Link } from "@tanstack/react-router";
import { Music2, RefreshCw, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { PageHeader, PrimaryButton, SecondaryButton } from "@/components/ConsoleShell";
import { Panel, StatusPill } from "@/components/ui-kit";
import {
  getAdminMusicSourceSettings,
  updateAdminMusicSourceSettings,
  type BuiltinMusicSourceId,
} from "@/lib/api";
import { useApiResource } from "@/lib/use-api-resource";

interface MusicSourceOption {
  id: BuiltinMusicSourceId;
  name: string;
  description: string;
}

/** 云助手内置音乐来源及其页面说明，顺序同时表达自动聚合的默认查询顺序。 */
const musicSourceOptions: MusicSourceOption[] = [
  { id: "musicbrainz", name: "MusicBrainz", description: "补充标准发行、录音、艺术家和专辑标识。" },
  { id: "netease", name: "网易云音乐", description: "补充中文歌曲、专辑信息和专辑封面。" },
  { id: "qmusic", name: "QQ 音乐", description: "补充歌曲、专辑封面以及艺术家图片。" },
  { id: "kugou", name: "酷狗音乐", description: "补充中文歌曲匹配、专辑和封面信息。" },
  { id: "migu", name: "咪咕音乐", description: "补充歌曲、发行信息和专辑封面。" },
  { id: "kuwo", name: "酷我音乐", description: "补充歌曲信息、专辑封面和艺术家图片。" },
];

/** 系统级音乐刮削源管理页面。 */
export function AdminMusicSourcesPage() {
  const resource = useApiResource(() => getAdminMusicSourceSettings(), []);
  const [selectedSources, setSelectedSources] = useState<BuiltinMusicSourceId[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const effectiveSources = selectedSources ?? resource.data?.enabledSources ?? [];

  useEffect(() => {
    if (!resource.data) return;
    setSelectedSources(resource.data.enabledSources);
  }, [resource.data]);

  /** 启用或停用一个来源，保留页面定义的固定来源顺序。 */
  function toggleSource(sourceId: BuiltinMusicSourceId): void {
    setSelectedSources((current) => {
      const values = current ?? resource.data?.enabledSources ?? [];
      const selected = new Set(values);
      if (selected.has(sourceId)) selected.delete(sourceId);
      else selected.add(sourceId);
      return musicSourceOptions.map((option) => option.id).filter((id) => selected.has(id));
    });
    setMessage(null);
  }

  /** 保存当前来源集合，之后新启动的音乐扫描使用新配置。 */
  async function saveSources(): Promise<void> {
    if (saving || selectedSources === null) return;
    setSaving(true);
    setMessage("正在保存音乐刮削源…");
    try {
      const saved = await updateAdminMusicSourceSettings(selectedSources);
      setSelectedSources(saved.enabledSources);
      setMessage(saved.enabledSources.length > 0
        ? `音乐刮削源已保存，已启用 ${saved.enabledSources.length} 个来源`
        : "内置音乐刮削源已全部关闭，扫描不会访问这些音乐平台");
      await resource.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "音乐刮削源保存失败";
      console.warn("codex-flycloud-helper-music-source-config", {
        事件: "网页保存音乐刮削源失败",
        错误信息: errorMessage,
      });
      setMessage(errorMessage);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <PageHeader
        title="音乐刮削源管理"
        actions={<Link to="/admin/config"><SecondaryButton>返回系统配置</SecondaryButton></Link>}
      />
      {message && <Panel className="mb-4"><p className="text-sm text-muted-foreground">{message}</p></Panel>}
      <Panel title="歌曲信息补充来源" description="选择自动聚合和指定来源刮削允许访问的平台；文件内嵌标签始终优先。">
        {!resource.data && !resource.error ? (
          <p className="py-12 text-center text-sm text-muted-foreground">正在读取音乐刮削源…</p>
        ) : resource.error ? (
          <div className="py-10 text-center">
            <p className="text-sm text-destructive">{resource.error}</p>
            <SecondaryButton className="mt-4" onClick={() => void resource.refresh()}><RefreshCw className="size-4" /> 重新读取</SecondaryButton>
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {musicSourceOptions.map((source) => {
              const selected = effectiveSources.includes(source.id);
              return (
                <button
                  key={source.id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => toggleSource(source.id)}
                  className={`rounded-xl border p-4 text-left transition-colors ${selected ? "border-primary/60 bg-primary/5" : "border-border bg-secondary/30 hover:bg-secondary/50"}`}
                >
                  <span className="flex items-start justify-between gap-3">
                    <span className="flex min-w-0 items-start gap-3">
                      <span className="mt-0.5 rounded-lg border border-border bg-background/70 p-2"><Music2 className="size-4" /></span>
                      <span className="min-w-0">
                        <span className="block text-sm font-medium">{source.name}</span>
                        <span className="mt-1 block text-xs leading-5 text-muted-foreground">{source.description}</span>
                      </span>
                    </span>
                    <StatusPill tone={selected ? "success" : "neutral"}>{selected ? "已启用" : "已停用"}</StatusPill>
                  </span>
                </button>
              );
            })}
          </div>
        )}
        {resource.data && (
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5">
            <div className="text-xs text-muted-foreground">
              <p>已启用 {effectiveSources.length} / {musicSourceOptions.length} 个来源；完整聚合会在这些来源之间补齐缺失字段和图片。</p>
              <p className="mt-1">当前配置：{resource.data.source === "default" ? "系统默认全部启用" : `自定义 · r${resource.data.configurationRevision}`}。全部关闭时不会请求这些内置音乐平台。</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <SecondaryButton type="button" onClick={() => setSelectedSources(musicSourceOptions.map((source) => source.id))}>全部启用</SecondaryButton>
              <SecondaryButton type="button" onClick={() => setSelectedSources([])}>全部停用</SecondaryButton>
              <PrimaryButton type="button" disabled={saving} onClick={() => void saveSources()}><Save className="size-4" /> {saving ? "正在保存…" : "保存来源"}</PrimaryButton>
            </div>
          </div>
        )}
      </Panel>
      <Panel title="生效规则" className="mt-4">
        <ul className="space-y-2 text-xs leading-6 text-muted-foreground">
          <li>文件中的标题、艺术家、专辑、曲号、年份、流派和内嵌封面优先保留，在线来源只补充缺失内容。</li>
          <li>保存后影响之后新开始的音乐扫描；正在运行的扫描继续使用启动时读取到的来源集合。</li>
          <li>某个音乐服务如果指定了已停用的单一来源，该来源不会被访问，歌曲将使用本地标签结果。</li>
          <li>这里不管理已安装的音乐元数据插件，插件仍按服务自身的元数据配置执行。</li>
        </ul>
      </Panel>
    </>
  );
}
