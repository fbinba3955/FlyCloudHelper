import { Search, X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { SecondaryButton } from "@/components/ConsoleShell";
import { Panel } from "@/components/ui-kit";
import type {
  AdminUser,
  MediaType,
  ProviderDescriptor,
  ServiceListFilters,
  ServiceStatus,
} from "@/lib/api";

const dataTypeLabels: Record<MediaType, string> = {
  video: "影视",
  music: "音乐",
  audiobook: "有声书",
};

const serviceStatusLabels: Record<ServiceStatus, string> = {
  active: "正常",
  scanning: "扫描中",
  disabled: "已停用",
  reauthorization_required: "需重新授权",
};

/** 管理端服务和媒体库列表共用的筛选面板。 */
export function AdminServiceFilters({
  value,
  users,
  providers,
  resultCount,
  onChange,
}: {
  value: ServiceListFilters;
  users: AdminUser[];
  providers: ProviderDescriptor[];
  resultCount: number;
  onChange: (next: ServiceListFilters) => void;
}) {
  const [searchText, setSearchText] = useState(value.search ?? "");

  useEffect(() => {
    setSearchText(value.search ?? "");
  }, [value.search]);

  /** 提交服务名称搜索，不在每次输入时重复请求列表。 */
  function submitSearch(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    onChange({ ...value, search: searchText.trim() || undefined });
  }

  /** 更新一个筛选字段，空值统一表示不限。 */
  function updateFilter(name: keyof ServiceListFilters, rawValue: string): void {
    if (name === "jellyfinEnabled") {
      onChange({ ...value, jellyfinEnabled: rawValue === "enabled" ? true : rawValue === "disabled" ? false : undefined });
      return;
    }
    onChange({ ...value, [name]: rawValue || undefined });
  }

  /** 清除全部筛选并同步清空搜索输入。 */
  function clearFilters(): void {
    setSearchText("");
    onChange({});
  }

  const selectClassName = "w-full rounded-lg border border-input bg-background/50 px-3 py-2.5 text-sm outline-none";
  return (
    <Panel className="mb-4" title="筛选" action={<span className="text-xs text-muted-foreground">共 {resultCount.toLocaleString()} 项</span>}>
      <form onSubmit={submitSearch} className="grid gap-3 md:grid-cols-2 xl:grid-cols-[minmax(220px,1.4fr)_repeat(5,minmax(130px,1fr))_auto]">
        <div className="flex min-w-0 items-center gap-2 rounded-lg border border-input bg-background/50 px-3 py-2.5">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input aria-label="搜索服务名称" placeholder="搜索服务名称" value={searchText} onChange={(event) => setSearchText(event.target.value)} className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
        </div>
        <select aria-label="筛选所属账户" value={value.userId ?? ""} onChange={(event) => updateFilter("userId", event.target.value)} className={selectClassName}>
          <option value="">全部账户</option>
          {users.map((user) => <option key={user.userId} value={user.userId}>{user.username}</option>)}
        </select>
        <select aria-label="筛选网盘类型" value={value.providerType ?? ""} onChange={(event) => updateFilter("providerType", event.target.value)} className={selectClassName}>
          <option value="">全部网盘类型</option>
          {providers.map((provider) => <option key={provider.type} value={provider.type}>{provider.displayName}</option>)}
        </select>
        <select aria-label="筛选数据类型" value={value.dataType ?? ""} onChange={(event) => updateFilter("dataType", event.target.value)} className={selectClassName}>
          <option value="">全部数据类型</option>
          {Object.entries(dataTypeLabels).map(([valueKey, label]) => <option key={valueKey} value={valueKey}>{label}</option>)}
        </select>
        <select aria-label="筛选服务状态" value={value.status ?? ""} onChange={(event) => updateFilter("status", event.target.value)} className={selectClassName}>
          <option value="">全部服务状态</option>
          {Object.entries(serviceStatusLabels).map(([valueKey, label]) => <option key={valueKey} value={valueKey}>{label}</option>)}
        </select>
        <select aria-label="筛选 Jellyfin 状态" value={value.jellyfinEnabled === undefined ? "" : value.jellyfinEnabled ? "enabled" : "disabled"} onChange={(event) => updateFilter("jellyfinEnabled", event.target.value)} className={selectClassName}>
          <option value="">全部 Jellyfin 状态</option>
          <option value="enabled">已开启 Jellyfin</option>
          <option value="disabled">未开启 Jellyfin</option>
        </select>
        <div className="flex gap-2 md:col-span-2 xl:col-span-1">
          <SecondaryButton type="submit"><Search className="size-4" /> 查询</SecondaryButton>
          <SecondaryButton type="button" onClick={clearFilters}><X className="size-4" /> 清除</SecondaryButton>
        </div>
      </form>
    </Panel>
  );
}
