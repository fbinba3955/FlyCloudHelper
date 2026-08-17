import { Link, useNavigate } from "@tanstack/react-router";
import { FolderPlus, Plus, RefreshCw, ScanLine, Settings2, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { MediaCatalogView, type MediaCatalogQuery } from "@/components/MediaCatalogView";
import { PageHeader, PrimaryButton, SecondaryButton } from "@/components/ConsoleShell";
import { ServicePathPicker, toProviderDirectory } from "@/components/ServicePathPicker";
import { Panel, StatCard, StatusPill, type StatusTone } from "@/components/ui-kit";
import {
  clearServiceCatalog,
  createScanJob,
  createService,
  getService,
  listAdminServiceItems,
  listAdminUsers,
  listLibraryItems,
  listProviders,
  listServices,
  reconnectServiceConnection,
  updateServiceConnection,
  updateServiceMetadataProfile,
  updateServiceScanProfile,
  updateServiceStatus,
  type CloudService,
  type CreateCloudServiceInput,
  type JobStatus,
  type MediaType,
  type ProviderDirectory,
  type ProviderDescriptor,
  type ServiceStatus,
} from "@/lib/api";
import { useApiResource } from "@/lib/use-api-resource";

const serviceStatusLabels: Record<ServiceStatus, string> = {
  active: "正常",
  scanning: "扫描中",
  disabled: "已停用",
  reauthorization_required: "需重新授权",
};

const dataTypeLabels: Record<MediaType, string> = {
  video: "影视",
  music: "音乐",
  audiobook: "有声书",
};

// 关键变量：服务详情最近任务卡片只展示中文状态，不修改接口返回的原始状态值。
const jobStatusLabels: Record<JobStatus, string> = {
  queued: "排队中",
  running: "运行中",
  retry_waiting: "等待 TMDB 恢复",
  paused: "已暂停",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

const jobStageLabels: Record<string, string> = {
  queued: "等待执行",
  enumerating: "扫描与刮削",
  classifying: "识别媒体",
  scraping: "扫描刮削",
  persisting: "写入目录",
  completed: "已完成",
};

// 关键变量：单个服务海报墙每页读取 60 个顶层条目，避免一次加载整个媒体库。
const SERVICE_CATALOG_PAGE_SIZE = 60;

/** 将服务状态映射为视觉语义。 */
function getServiceTone(status: ServiceStatus): StatusTone {
  if (status === "active") return "success";
  if (status === "scanning") return "primary";
  if (status === "reauthorization_required") return "warning";
  return "neutral";
}

/** 把 ISO 时间转换为控制台可读时间。 */
function formatTime(value: string | null): string {
  return value ? new Date(value).toLocaleString("zh-CN") : "尚未扫描";
}

/** 将任务阶段转换为中文；未知的新阶段统一显示为处理中，避免页面泄露英文枚举。 */
function getJobStageLabel(stage: string): string {
  return jobStageLabels[stage] ?? "处理中";
}

interface ScanRootValue {
  resourceId?: string;
  displayPath?: string;
  driveId?: string;
  mediaTypes?: string[];
}

interface VideoMetadataSettings {
  providerId: string;
  language: string;
  region: string;
  useNfo: boolean;
}

interface ScanConcurrencySettings {
  scanDirectoryConcurrency: number;
  scrapeTaskConcurrency: number;
}

/** 读取服务并发配置；旧服务缺少字段时直接采用当前 Provider 推荐值。 */
function readScanConcurrencySettings(
  profile: Record<string, unknown>,
  descriptor: ProviderDescriptor | undefined,
): ScanConcurrencySettings {
  const recommended = descriptor?.recommendedScanSettings;
  const scanDefault = recommended?.scanDirectoryConcurrency.default ?? 8;
  const scrapeDefault = recommended?.scrapeTaskConcurrency.default ?? 4;
  return {
    scanDirectoryConcurrency: typeof profile.scanDirectoryConcurrency === "number"
      ? profile.scanDirectoryConcurrency
      : scanDefault,
    scrapeTaskConcurrency: typeof profile.scrapeTaskConcurrency === "number"
      ? profile.scrapeTaskConcurrency
      : scrapeDefault,
  };
}

/** 创建包含最小值和最大值的连续整数选项。 */
function buildConcurrencyOptions(min: number, max: number): number[] {
  return Array.from({ length: max - min + 1 }, (_, index) => min + index);
}

/** 读取影视元数据配置，并兼容早期 sources 数组。 */
function readVideoMetadataSettings(profile: Record<string, unknown>): VideoMetadataSettings {
  const profiles = profile.profiles && typeof profile.profiles === "object" && !Array.isArray(profile.profiles)
    ? profile.profiles as Record<string, unknown>
    : {};
  const videoProfile = profiles.video && typeof profiles.video === "object" && !Array.isArray(profiles.video)
    ? profiles.video as Record<string, unknown>
    : {};
  const firstSource = Array.isArray(videoProfile.sources)
    ? videoProfile.sources.find((item): item is string => typeof item === "string")
    : undefined;
  const configuredProvider = typeof videoProfile.providerId === "string" ? videoProfile.providerId : firstSource;
  return {
    providerId: configuredProvider === "tmdb" || !configuredProvider ? "builtin.tmdb" : configuredProvider,
    language: typeof videoProfile.language === "string" ? videoProfile.language : "zh-CN",
    region: typeof videoProfile.region === "string" ? videoProfile.region : "CN",
    useNfo: videoProfile.useNfo !== false,
  };
}

/** 将中文表单字段写回元数据 Profile，同时保留以后扩展的未知配置。 */
function buildVideoMetadataProfile(
  profile: Record<string, unknown>,
  settings: VideoMetadataSettings,
): Record<string, unknown> {
  const profiles = profile.profiles && typeof profile.profiles === "object" && !Array.isArray(profile.profiles)
    ? profile.profiles as Record<string, unknown>
    : {};
  const videoProfile = profiles.video && typeof profiles.video === "object" && !Array.isArray(profiles.video)
    ? profiles.video as Record<string, unknown>
    : {};
  return {
    ...profile,
    profiles: {
      ...profiles,
      video: {
        ...videoProfile,
        providerId: settings.providerId,
        sources: undefined,
        language: settings.language,
        region: settings.region,
        useNfo: settings.useNfo,
      },
    },
  };
}

/** 返回当前元数据来源的中文名称。 */
function getMetadataProviderLabel(providerId: string): string {
  if (providerId === "builtin.tmdb" || providerId === "tmdb") return "TMDB 在线刮削";
  if (providerId === "local") return "仅使用本地 NFO 和文件名";
  if (providerId.startsWith("plugin:")) return `元数据插件（${providerId.slice("plugin:".length)}）`;
  return `现有来源（${providerId}）`;
}

/** 读取指定扫描模式的路径，并转换成路径选择器可以直接展示的目录。 */
function readScanRoots(profile: Record<string, unknown>, mode: "incremental" | "full"): ProviderDirectory[] {
  const configuredRoots = mode === "full" ? profile.fullRoots : profile.incrementalRoots;
  const roots = Array.isArray(configuredRoots)
    ? configuredRoots
    : Array.isArray(profile.roots) ? profile.roots : [];
  return roots
    .filter((root): root is ScanRootValue => Boolean(root && typeof root === "object"))
    .map((root) => {
      const displayPath = root.displayPath || root.resourceId || "/";
      return toProviderDirectory({
        resourceId: root.resourceId || displayPath,
        displayPath,
        ...(root.driveId ? { driveId: root.driveId } : {}),
      });
    });
}

/** 返回扫描路径供摘要区域展示。 */
function getScanRootLabel(root: ScanRootValue): string {
  return root.displayPath || root.resourceId || "未命名路径";
}

/** 渲染单个云端服务卡片。 */
function ServiceCard({ service, admin, onScanned }: { service: CloudService; admin: boolean; onScanned: () => void }) {
  const [message, setMessage] = useState<string | null>(null);
  const detailPath = admin ? "/admin/services/$serviceId" : "/app/services/$serviceId";
  const catalogPath = admin ? "/admin/services/$serviceId/catalog" : "/app/services/$serviceId/catalog";

  /** 创建默认增量扫描任务。 */
  async function triggerScan(): Promise<void> {
    setMessage("正在创建扫描任务…");
    try {
      const job = await createScanJob(service.id, "incremental", admin);
      setMessage(`任务 ${job.id} 已进入队列`);
      onScanned();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "扫描任务创建失败");
    }
  }

  return (
    <article className="surface p-5">
      <header className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-border text-xs font-semibold" style={{ backgroundImage: "var(--gradient-surface)" }}>
            {service.providerType.slice(0, 2).toUpperCase()}
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold">{service.displayName}</h2>
            <p className="truncate font-mono text-[11px] text-muted-foreground">{service.providerType} · {service.id}{admin ? ` · ${service.ownerUsername}` : ""}</p>
          </div>
        </div>
        <StatusPill tone={getServiceTone(service.status)}>{serviceStatusLabels[service.status]}</StatusPill>
      </header>

      <dl className="mt-5 grid grid-cols-3 gap-3 text-center">
        <div className="rounded-lg border border-border bg-secondary/40 p-3"><dt className="text-[10px] text-muted-foreground">已入库</dt><dd className="mt-1 text-xs font-medium">{service.itemCount.toLocaleString()}</dd></div>
        <div className="rounded-lg border border-border bg-secondary/40 p-3"><dt className="text-[10px] text-muted-foreground">目录版本</dt><dd className="mt-1 text-xs font-medium">v{service.catalogVersion}</dd></div>
        <div className="rounded-lg border border-border bg-secondary/40 p-3"><dt className="text-[10px] text-muted-foreground">最近扫描</dt><dd className="mt-1 truncate text-xs font-medium">{formatTime(service.lastScanAt)}</dd></div>
      </dl>

      <div className="mt-4 flex flex-wrap gap-2">
        <StatusPill>{dataTypeLabels[service.dataType]}</StatusPill>
        <StatusPill>连接 r{service.credentialRevision}</StatusPill>
        <StatusPill>扫描 r{service.scanProfileRevision}</StatusPill>
        <StatusPill>刮削 r{service.metadataProfileRevision}</StatusPill>
      </div>

      <footer className="mt-5 flex flex-wrap gap-2">
        <button type="button" onClick={() => void triggerScan()} className="inline-flex items-center gap-1.5 rounded-lg bg-primary/15 px-3 py-2 text-xs text-primary-soft">
          <ScanLine className="size-3.5" /> 触发增量扫描
        </button>
        <Link to={detailPath} params={{ serviceId: service.id }} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground"><Settings2 className="size-3.5" /> 服务详情与配置</Link>
        <Link to={catalogPath} params={{ serviceId: service.id }} className="rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground">服务海报墙</Link>
      </footer>
      {message && <p className="mt-3 text-xs text-muted-foreground">{message}</p>}
    </article>
  );
}

/** 渲染用户或管理员作用域的服务列表。 */
function ServicesListPage({ admin }: { admin: boolean }) {
  const resource = useApiResource(() => listServices(admin), [admin]);
  return (
    <>
      <PageHeader
        title={admin ? "全部服务" : "我的服务"}
        actions={<Link to={admin ? "/admin/services/new" : "/app/services/new"}><PrimaryButton><Plus className="size-4" /> 创建云端服务</PrimaryButton></Link>}
      />
      {resource.error && <Panel><p className="text-sm text-destructive">{resource.error}</p></Panel>}
      <div className="grid gap-4 lg:grid-cols-2">
        {resource.data?.items.map((service) => <ServiceCard key={service.id} service={service} admin={admin} onScanned={() => void resource.refresh()} />)}
      </div>
      {!resource.loading && resource.data?.items.length === 0 && <Panel><p className="py-10 text-center text-sm text-muted-foreground">还没有云端服务</p></Panel>}
    </>
  );
}

export function UserServicesPage() { return <ServicesListPage admin={false} />; }
export function AdminServicesPage() { return <ServicesListPage admin />; }

/** 创建云端服务表单，字段由 Provider 描述动态生成。 */
export function ServiceCreatePage({ admin = false }: { admin?: boolean }) {
  const navigate = useNavigate();
  const providers = useApiResource(() => listProviders(), []);
  const users = useApiResource(() => admin ? listAdminUsers() : Promise.resolve({ items: [], total: 0 }), [admin]);
  const [providerType, setProviderType] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const selectedProvider: ProviderDescriptor | undefined = providers.data?.find((item) => item.type === providerType) ?? providers.data?.[0];

  /** 收集动态连接字段，只验证连接并创建尚未配置扫描路径的服务。 */
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const selectedType = String(form.get("providerType") ?? "");
    const dataType = String(form.get("dataType") ?? "") as MediaType;
    const descriptor = providers.data?.find((item) => item.type === selectedType);
    if (!descriptor) {
      setMessage("请选择 Provider 类型");
      return;
    }
    if (dataType !== "video") {
      setMessage("本阶段仅支持影视数据类型");
      return;
    }
    const connection: Record<string, string> = {};
    descriptor.connectionFields.forEach((field) => {
      const value = String(form.get(`connection.${field.name}`) ?? "").trim();
      if (value) connection[field.name] = value;
    });
    const input: CreateCloudServiceInput = {
      displayName: String(form.get("displayName") ?? "").trim(),
      dataType,
      provider: { type: selectedType, connection },
      scan: {
        fullRoots: [],
        incrementalRoots: [],
        mediaTypes: [dataType],
        removedRootPolicy: "protect",
        scanDirectoryConcurrency: descriptor.recommendedScanSettings.scanDirectoryConcurrency.default,
        scrapeTaskConcurrency: descriptor.recommendedScanSettings.scrapeTaskConcurrency.default,
      },
      metadata: {
        profiles: {
          video: {
            providerId: "builtin.tmdb",
            language: "zh-CN",
            region: "CN",
            useNfo: true,
          },
        },
      },
    };
    if (admin) input.userId = String(form.get("userId") ?? "");
    setMessage("正在验证连接并创建服务，不会自动开始扫描…");
    try {
      const service = await createService(input, admin);
      await navigate({ to: admin ? "/admin/services/$serviceId" : "/app/services/$serviceId", params: { serviceId: service.id } });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "服务创建失败");
    }
  }

  return (
    <>
      <PageHeader title="创建云端服务" />
      <Panel>
        <form onSubmit={(event) => void submit(event)} className="grid gap-5 lg:grid-cols-2">
          {admin && <label className="block"><span className="text-xs text-muted-foreground">所属用户</span><select name="userId" required className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm"><option value="">选择目标用户</option>{users.data?.items.map((user) => <option key={user.userId} value={user.userId}>{user.username}</option>)}</select></label>}
          <label className="block"><span className="text-xs text-muted-foreground">服务名称</span><input name="displayName" required maxLength={100} className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm" /></label>
          <label className="block">
            <span className="text-xs text-muted-foreground">数据类型</span>
            <select name="dataType" required defaultValue="video" className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm">
              <option value="video">影视</option>
              <option value="music" disabled>音乐（暂未支持）</option>
              <option value="audiobook" disabled>有声书（暂未支持）</option>
            </select>
          </label>
          <label className="block"><span className="text-xs text-muted-foreground">Provider 类型</span><select name="providerType" required value={selectedProvider?.type ?? ""} onChange={(event) => setProviderType(event.target.value)} className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm"><option value="">选择 Provider</option>{providers.data?.map((provider) => <option key={provider.type} value={provider.type}>{provider.displayName}</option>)}</select></label>
          {selectedProvider?.connectionFields.map((field) => <label key={field.name} className="block"><span className="text-xs text-muted-foreground">{field.label}</span><input name={`connection.${field.name}`} type={field.type === "password" ? "password" : field.type} required={field.required} autoComplete="off" className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm" /></label>)}
          {selectedProvider && <div className="rounded-xl border border-border bg-secondary/35 p-4 lg:col-span-2"><p className="text-sm font-medium">默认任务并发</p><p className="mt-2 text-xs text-muted-foreground">扫描任务 {selectedProvider.recommendedScanSettings.scanDirectoryConcurrency.default}，刮削任务 {selectedProvider.recommendedScanSettings.scrapeTaskConcurrency.default}。创建后可以在服务详情中修改。</p></div>}
          <div className="lg:col-span-2 flex items-center justify-between gap-4"><p className="text-xs text-muted-foreground">创建成功后不会自动扫描或刮削，需要先在服务详情中设置扫描路径。</p><PrimaryButton type="submit">验证连接并创建服务</PrimaryButton></div>
          {message && <p className="lg:col-span-2 text-sm text-muted-foreground">{message}</p>}
        </form>
      </Panel>
    </>
  );
}

/** 云端服务详情与配置页面。 */
export function ServiceDetailPage({ serviceId, admin = false }: { serviceId: string; admin?: boolean }) {
  const resource = useApiResource(() => getService(serviceId, admin), [serviceId, admin]);
  const providers = useApiResource(() => listProviders(), []);
  const [message, setMessage] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const service = resource.data;
  const [fullScanRoots, setFullScanRoots] = useState<ProviderDirectory[]>([]);
  const [incrementalScanRoots, setIncrementalScanRoots] = useState<ProviderDirectory[]>([]);
  const [metadataSettings, setMetadataSettings] = useState<VideoMetadataSettings>({
    providerId: "builtin.tmdb",
    language: "zh-CN",
    region: "CN",
    useNfo: true,
  });
  const [scanConcurrencySettings, setScanConcurrencySettings] = useState<ScanConcurrencySettings>({
    scanDirectoryConcurrency: 8,
    scrapeTaskConcurrency: 4,
  });

  useEffect(() => {
    if (!service) return;
    setFullScanRoots(readScanRoots(service.scanProfile, "full"));
    setIncrementalScanRoots(readScanRoots(service.scanProfile, "incremental"));
  }, [serviceId, service?.id, service?.scanProfileRevision]);

  useEffect(() => {
    if (!service) return;
    setMetadataSettings(readVideoMetadataSettings(service.metadataProfile));
  }, [serviceId, service?.id, service?.metadataProfileRevision]);

  useEffect(() => {
    if (!service) return;
    const descriptor = providers.data?.find((item) => item.type === service.providerType);
    setScanConcurrencySettings(readScanConcurrencySettings(service.scanProfile, descriptor));
  }, [serviceId, service?.id, service?.scanProfileRevision, providers.data]);

  if (!service) return <Panel><div className="py-16 text-center text-sm text-muted-foreground">{resource.error ?? "正在读取服务详情…"}</div></Panel>;
  // 关键变量：详情已经通过空值检查，异步回调统一捕获稳定引用，避免刷新期间类型重新变为可空。
  const activeService = service;

  /** 从详情页创建用户选择的扫描任务。 */
  async function trigger(mode: "incremental" | "full"): Promise<void> {
    setMessage("正在创建扫描任务…");
    try {
      const job = await createScanJob(serviceId, mode, admin);
      setMessage(`任务 ${job.id} 已进入队列`);
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "创建任务失败");
    }
  }

  /** 在单个路径选择 Dialog 确认时立即保存全量或增量扫描目录。 */
  async function saveScanPaths(mode: "incremental" | "full", selectedRoots: ProviderDirectory[]): Promise<void> {
    const nextFullScanRoots = mode === "full" ? selectedRoots : fullScanRoots;
    const nextIncrementalScanRoots = mode === "incremental" ? selectedRoots : incrementalScanRoots;
    const nextProfile = {
      ...activeService.scanProfile,
      roots: undefined,
      fullRoots: nextFullScanRoots,
      incrementalRoots: nextIncrementalScanRoots,
      mediaTypes: [activeService.dataType],
    };
    setMessage(`正在验证并保存${mode === "full" ? "全量" : "增量"}扫描目录…`);
    try {
      await updateServiceScanProfile(serviceId, nextProfile, admin);
      setFullScanRoots(nextFullScanRoots);
      setIncrementalScanRoots(nextIncrementalScanRoots);
      setMessage(`扫描路径已保存：全量 ${nextFullScanRoots.length} 条，增量 ${nextIncrementalScanRoots.length} 条`);
      await resource.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "扫描路径保存失败";
      setMessage(errorMessage);
      throw error;
    }
  }

  /** 保存服务级目录扫描和元数据刮削并发。 */
  async function saveScanConcurrency(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const nextProfile = {
      ...activeService.scanProfile,
      scanDirectoryConcurrency: scanConcurrencySettings.scanDirectoryConcurrency,
      scrapeTaskConcurrency: scanConcurrencySettings.scrapeTaskConcurrency,
    };
    setMessage("正在保存扫描与刮削任务并发…");
    try {
      await updateServiceScanProfile(serviceId, nextProfile, admin);
      setMessage(`任务并发已保存：扫描 ${scanConcurrencySettings.scanDirectoryConcurrency}，刮削 ${scanConcurrencySettings.scrapeTaskConcurrency}`);
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "任务并发保存失败");
    }
  }

  /** 保存中文表单中选择的影视元数据来源、语言和地区。 */
  async function saveMetadataProfile(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setMessage("正在保存元数据配置…");
    try {
      const profile = buildVideoMetadataProfile(activeService.metadataProfile, metadataSettings);
      await updateServiceMetadataProfile(serviceId, profile, admin);
      setMessage("元数据配置已保存，新修订只影响之后创建的任务");
      await resource.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "元数据配置保存失败";
      console.warn("codex-metadata-profile-form", {
        事件: "保存元数据配置失败",
        服务ID: serviceId,
        元数据来源: metadataSettings.providerId,
        语言: metadataSettings.language,
        地区: metadataSettings.region,
        使用本地NFO: metadataSettings.useNfo,
        错误信息: errorMessage,
      });
      setMessage(errorMessage);
    }
  }

  /** 使用完整新凭据替换当前连接。 */
  async function saveConnection(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const descriptor = providers.data?.find((item) => item.type === activeService.providerType);
    if (!descriptor) return;
    const connection: Record<string, string> = {};
    descriptor.connectionFields.forEach((field) => {
      const value = String(form.get(field.name) ?? "").trim();
      if (value) connection[field.name] = value;
    });
    setMessage("正在验证并替换连接…");
    try {
      await updateServiceConnection(serviceId, connection, admin);
      setMessage("连接验证通过并已保存");
      formElement.reset();
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "连接保存失败");
    }
  }

  /** 使用服务端当前保存的连接配置重新验证并恢复服务连接状态。 */
  async function reconnectCurrentConnection(): Promise<void> {
    setReconnecting(true);
    setMessage("正在使用当前配置重新连接网盘服务…");
    try {
      await reconnectServiceConnection(serviceId, admin);
      setMessage("当前配置验证成功，服务连接已恢复");
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "使用当前配置重连失败");
    } finally {
      setReconnecting(false);
    }
  }

  /** 启用或停用当前服务。 */
  async function toggleStatus(): Promise<void> {
    try {
      await updateServiceStatus(serviceId, activeService.status === "disabled" ? "active" : "disabled", admin);
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "服务状态修改失败");
    }
  }

  /** 二次确认后仅清空当前服务的扫描与刮削结果。 */
  async function clearCatalog(): Promise<void> {
    if (!window.confirm(`确定清空“${activeService.displayName}”的全部扫描刮削结果吗？服务连接和配置会保留，媒体条目、文件索引和目录版本将被清空。`)) return;
    setMessage("正在清空当前服务的媒体库…");
    try {
      const result = await clearServiceCatalog(serviceId, admin);
      setMessage(`已清空 ${result.mediaItemCount.toLocaleString()} 个媒体条目和 ${result.sourceFileCount.toLocaleString()} 个源文件索引`);
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "清空媒体库失败");
    }
  }

  const providerDescriptor = providers.data?.find((item) => item.type === service.providerType);
  const recommendedScanSettings = providerDescriptor?.recommendedScanSettings;
  const scanConcurrencyOptions = buildConcurrencyOptions(
    recommendedScanSettings?.scanDirectoryConcurrency.min ?? 1,
    recommendedScanSettings?.scanDirectoryConcurrency.max ?? 16,
  );
  const scrapeConcurrencyOptions = buildConcurrencyOptions(
    recommendedScanSettings?.scrapeTaskConcurrency.min ?? 1,
    recommendedScanSettings?.scrapeTaskConcurrency.max ?? 4,
  );
  // 关键变量：最近一条任务用于服务详情顶部状态卡片。
  const recentJob = service.recentJobs[0];

  return (
    <>
      <PageHeader title={service.displayName} actions={<><SecondaryButton disabled={fullScanRoots.length === 0} title={fullScanRoots.length === 0 ? "请先配置全量扫描路径" : undefined} onClick={() => void trigger("full")}>全量扫描</SecondaryButton><PrimaryButton disabled={incrementalScanRoots.length === 0} title={incrementalScanRoots.length === 0 ? "请先配置增量扫描路径" : undefined} onClick={() => void trigger("incremental")}><ScanLine className="size-4" /> 增量扫描</PrimaryButton></>} />
      {message && <Panel className="mb-4"><p className="text-sm text-muted-foreground">{message}</p></Panel>}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="媒体条目" value={service.itemCount.toLocaleString()} hint="当前已入库" />
        <StatCard label="目录版本" value={`v${service.catalogVersion}`} hint={formatTime(service.lastScanAt)} tone="info" />
        <StatCard label="最近任务" value={recentJob ? jobStatusLabels[recentJob.status] : "暂无"} hint={recentJob ? getJobStageLabel(recentJob.stage) : "尚未扫描"} tone="warning" />
        <StatCard
          label="连接状态"
          value={serviceStatusLabels[service.status]}
          hint={service.credentialConfigured ? "Secret 已配置" : "Secret 未配置"}
          tone={service.status === "reauthorization_required" ? "warning" : "muted"}
          action={service.status === "reauthorization_required"
            ? <SecondaryButton disabled={reconnecting} onClick={() => void reconnectCurrentConnection()}><RefreshCw className={`size-4 ${reconnecting ? "animate-spin" : ""}`} />{reconnecting ? "正在重连…" : "使用当前配置重连"}</SecondaryButton>
            : undefined}
        />
      </div>
      <Panel title="配置修订与范围" className="mt-4">
        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded-xl border border-border bg-secondary/40 p-4">
            <p className="text-xs text-muted-foreground">配置修订</p>
            <div className="mt-3 flex flex-wrap gap-2"><StatusPill>{dataTypeLabels[service.dataType]}</StatusPill><StatusPill>连接 r{service.credentialRevision}</StatusPill><StatusPill>扫描 r{service.scanProfileRevision}</StatusPill><StatusPill>元数据 r{service.metadataProfileRevision}</StatusPill></div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div><p className="text-[11px] text-muted-foreground">全量扫描路径 · {fullScanRoots.length}</p><ul className="mt-2 space-y-1 text-xs">{fullScanRoots.length > 0 ? fullScanRoots.map((root, index) => <li key={`${getScanRootLabel(root)}-${index}`} className="truncate">{getScanRootLabel(root)}</li>) : <li className="text-warning">未配置</li>}</ul></div>
              <div><p className="text-[11px] text-muted-foreground">增量扫描路径 · {incrementalScanRoots.length}</p><ul className="mt-2 space-y-1 text-xs">{incrementalScanRoots.length > 0 ? incrementalScanRoots.map((root, index) => <li key={`${getScanRootLabel(root)}-${index}`} className="truncate">{getScanRootLabel(root)}</li>) : <li className="text-warning">未配置</li>}</ul></div>
            </div>
          </div>
          <div className="rounded-xl border border-border bg-secondary/40 p-4"><p className="text-xs text-muted-foreground">服务海报墙</p><p className="mt-2 text-sm">固定当前服务作用域查看扫描结果。</p><Link to={admin ? "/admin/services/$serviceId/catalog" : "/app/services/$serviceId/catalog"} params={{ serviceId }} className="mt-3 inline-flex items-center gap-1 text-xs text-primary-soft">打开服务海报墙 <FolderPlus className="size-3.5" /></Link></div>
        </div>
      </Panel>
      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Panel title="替换连接" description="Secret 不回显，保存时必须提交一套完整新连接。">
          <form onSubmit={(event) => void saveConnection(event)} className="grid gap-3">
            {providers.data?.find((item) => item.type === service.providerType)?.connectionFields.map((field) => <label key={field.name}><span className="text-xs text-muted-foreground">{field.label}</span><input name={field.name} type={field.type === "password" ? "password" : field.type} required={field.required} autoComplete="off" className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm" /></label>)}
            <PrimaryButton type="submit">验证并保存连接</PrimaryButton>
          </form>
        </Panel>
        <Panel title="服务状态" description="停用服务前必须确保没有运行中的扫描任务。">
          <p className="mb-4 text-sm text-muted-foreground">当前状态：{serviceStatusLabels[service.status]}</p>
          <div className="flex flex-wrap gap-2">
            <SecondaryButton onClick={() => void toggleStatus()}>{service.status === "disabled" ? "启用服务" : "停用服务"}</SecondaryButton>
            <button type="button" onClick={() => void clearCatalog()} disabled={service.status === "scanning"} className="inline-flex items-center justify-center gap-2 rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-2.5 text-sm text-destructive transition-colors hover:bg-destructive/15 disabled:cursor-not-allowed disabled:opacity-40"><Trash2 className="size-4" /> 清空扫描刮削结果</button>
          </div>
        </Panel>
        <Panel title="扫描路径" description="全量和增量任务分别选择网盘目录，不需要手动输入路径。" className="xl:col-span-2">
          <div key={service.scanProfileRevision} className="grid gap-4 lg:grid-cols-2">
            <ServicePathPicker serviceId={serviceId} admin={admin} label="全量扫描目录" value={fullScanRoots} onConfirm={(directories) => saveScanPaths("full", directories)} />
            <ServicePathPicker serviceId={serviceId} admin={admin} label="增量扫描目录" value={incrementalScanRoots} onConfirm={(directories) => saveScanPaths("incremental", directories)} />
            <p className="text-xs text-muted-foreground lg:col-span-2">在目录选择 Dialog 中点击“确定”会立即验证并保存对应扫描目录；未选择目录的扫描模式不能创建任务。</p>
          </div>
        </Panel>
        <Panel title="扫描与刮削任务并发" className="xl:col-span-2">
          <form onSubmit={(event) => void saveScanConcurrency(event)} className="grid gap-4 md:grid-cols-2">
            <label className="block">
              <span className="text-xs text-muted-foreground">扫描任务数</span>
              <select value={scanConcurrencySettings.scanDirectoryConcurrency} onChange={(event) => setScanConcurrencySettings((current) => ({ ...current, scanDirectoryConcurrency: Number(event.target.value) }))} className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm">
                {scanConcurrencyOptions.map((value) => <option key={value} value={value}>{value}{value === recommendedScanSettings?.scanDirectoryConcurrency.default ? "（推荐）" : ""}</option>)}
              </select>
              <p className="mt-2 text-xs text-muted-foreground">增量扫描使用该并发；全量扫描按 Flymby APP 规则实际使用 {recommendedScanSettings?.fullScanDirectoryConcurrency ?? 1} 个目录任务。</p>
            </label>
            <label className="block">
              <span className="text-xs text-muted-foreground">刮削任务数</span>
              <select value={scanConcurrencySettings.scrapeTaskConcurrency} onChange={(event) => setScanConcurrencySettings((current) => ({ ...current, scrapeTaskConcurrency: Number(event.target.value) }))} className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm">
                {scrapeConcurrencyOptions.map((value) => <option key={value} value={value}>{value}{value === recommendedScanSettings?.scrapeTaskConcurrency.default ? "（推荐）" : ""}</option>)}
              </select>
              <p className="mt-2 text-xs text-muted-foreground">实际并发不会超过当前可用 TMDB Key 支持的并发数。</p>
            </label>
            <div className="flex justify-end md:col-span-2"><PrimaryButton type="submit">保存任务并发</PrimaryButton></div>
          </form>
        </Panel>
        <Panel title="元数据配置" description="配置影视数据的刮削来源；音乐和有声书将在后续版本开放。">
          <form onSubmit={(event) => void saveMetadataProfile(event)} className="space-y-4">
            <label className="block">
              <span className="text-xs text-muted-foreground">元数据来源</span>
              <select value={metadataSettings.providerId} onChange={(event) => setMetadataSettings((current) => ({ ...current, providerId: event.target.value }))} className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm">
                <option value="builtin.tmdb">TMDB 在线刮削</option>
                <option value="local">仅使用本地 NFO 和文件名</option>
                {metadataSettings.providerId !== "builtin.tmdb" && metadataSettings.providerId !== "local" && <option value={metadataSettings.providerId}>{getMetadataProviderLabel(metadataSettings.providerId)}</option>}
              </select>
            </label>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block">
                <span className="text-xs text-muted-foreground">元数据语言</span>
                <select value={metadataSettings.language} onChange={(event) => setMetadataSettings((current) => ({ ...current, language: event.target.value }))} className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm">
                  <option value="zh-CN">简体中文</option>
                  <option value="zh-TW">繁体中文</option>
                  <option value="en-US">英语</option>
                  <option value="ja-JP">日语</option>
                  <option value="ko-KR">韩语</option>
                  {!(["zh-CN", "zh-TW", "en-US", "ja-JP", "ko-KR"] as string[]).includes(metadataSettings.language) && <option value={metadataSettings.language}>现有语言（{metadataSettings.language}）</option>}
                </select>
              </label>
              <label className="block">
                <span className="text-xs text-muted-foreground">内容地区</span>
                <select value={metadataSettings.region} onChange={(event) => setMetadataSettings((current) => ({ ...current, region: event.target.value }))} className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm">
                  <option value="CN">中国大陆</option>
                  <option value="HK">中国香港</option>
                  <option value="TW">中国台湾</option>
                  <option value="US">美国</option>
                  <option value="JP">日本</option>
                  <option value="KR">韩国</option>
                  {!(["CN", "HK", "TW", "US", "JP", "KR"] as string[]).includes(metadataSettings.region) && <option value={metadataSettings.region}>现有地区（{metadataSettings.region}）</option>}
                </select>
              </label>
            </div>
            <div className="rounded-xl border border-border bg-secondary/35 p-4">
              <div className="flex items-center justify-between gap-4">
                <div><p className="text-sm font-medium">使用本地 NFO</p><p className="mt-1 text-xs text-muted-foreground">{metadataSettings.useNfo ? "优先读取同目录 NFO，没有可用信息时再使用上方来源。" : "忽略同目录 NFO，直接使用上方元数据来源。"}</p></div>
                <button type="button" role="switch" aria-checked={metadataSettings.useNfo} aria-label="使用本地 NFO" onClick={() => setMetadataSettings((current) => ({ ...current, useNfo: !current.useNfo }))} className={`relative h-7 w-12 shrink-0 rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${metadataSettings.useNfo ? "border-primary bg-primary" : "border-border bg-secondary"}`}>
                  <span className={`absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow-sm transition-transform ${metadataSettings.useNfo ? "translate-x-5" : "translate-x-0"}`} />
                </button>
              </div>
            </div>
            <div className="flex justify-end"><PrimaryButton type="submit">保存元数据配置</PrimaryButton></div>
          </form>
        </Panel>
      </div>
    </>
  );
}

/** 固定单一服务作用域的海报墙页面。 */
export function ServiceCatalogPage({ serviceId, admin = false }: { serviceId: string; admin?: boolean }) {
  const [catalogQuery, setCatalogQuery] = useState<MediaCatalogQuery>({
    search: "",
    mediaType: "all",
    videoItemType: "all",
    matchState: "matched",
    sort: "created_desc",
  });
  const [pageOffset, setPageOffset] = useState(0);
  const resource = useApiResource(async () => {
    const service = await getService(serviceId, admin);
    const options = {
      search: catalogQuery.search || undefined,
      mediaType: catalogQuery.mediaType === "all" ? undefined : catalogQuery.mediaType,
      itemType: catalogQuery.videoItemType === "all" ? undefined : catalogQuery.videoItemType,
      matchState: catalogQuery.matchState === "all" ? undefined : catalogQuery.matchState,
      sort: catalogQuery.sort,
      limit: SERVICE_CATALOG_PAGE_SIZE,
      offset: pageOffset,
    };
    const catalog = admin ? await listAdminServiceItems(serviceId, options) : await listLibraryItems(service.libraryId, options);
    return { service, catalog };
  }, [serviceId, admin, catalogQuery.search, catalogQuery.mediaType, catalogQuery.videoItemType, catalogQuery.matchState, catalogQuery.sort, pageOffset]);

  /** 筛选变化后回到第一页；相同筛选不触发重复请求。 */
  const updateCatalogQuery = useCallback((nextQuery: MediaCatalogQuery): void => {
    setCatalogQuery((currentQuery) => {
      const unchanged = currentQuery.search === nextQuery.search
        && currentQuery.mediaType === nextQuery.mediaType
        && currentQuery.videoItemType === nextQuery.videoItemType
        && currentQuery.matchState === nextQuery.matchState
        && currentQuery.sort === nextQuery.sort;
      return unchanged ? currentQuery : nextQuery;
    });
    setPageOffset(0);
  }, []);

  if (!resource.data) return <Panel><div className="py-16 text-center text-sm text-muted-foreground">{resource.error ?? "正在读取服务海报墙…"}</div></Panel>;
  const { service, catalog } = resource.data;
  return (
    <>
      <PageHeader title={`${service.displayName} · 海报墙`} actions={<Link to={admin ? "/admin/services/$serviceId" : "/app/services/$serviceId"} params={{ serviceId }}><SecondaryButton>返回服务详情</SecondaryButton></Link>} />
      {resource.error && <Panel className="mb-4"><p className="text-sm text-destructive">{resource.error}</p></Panel>}
      <MediaCatalogView contextDescription={`${admin ? `用户 ${service.ownerUsername} · ` : ""}${service.displayName} · ${service.libraryId}`} items={catalog.items} total={catalog.total} catalogVersion={service.catalogVersion} fixedService showOwner={admin} admin={admin} loading={resource.loading} onRefresh={() => void resource.refresh()} serverFiltered pageOffset={pageOffset} pageLimit={SERVICE_CATALOG_PAGE_SIZE} onQueryChange={updateCatalogQuery} onPageChange={setPageOffset} />
    </>
  );
}

export function AdminServiceCreatePage() { return <ServiceCreatePage admin />; }
export function UserServiceDetailPage({ serviceId }: { serviceId: string }) { return <ServiceDetailPage serviceId={serviceId} />; }
export function AdminServiceDetailPage({ serviceId }: { serviceId: string }) { return <ServiceDetailPage serviceId={serviceId} admin />; }
export function UserServiceCatalogPage({ serviceId }: { serviceId: string }) { return <ServiceCatalogPage serviceId={serviceId} />; }
export function AdminServiceCatalogPage({ serviceId }: { serviceId: string }) { return <ServiceCatalogPage serviceId={serviceId} admin />; }
