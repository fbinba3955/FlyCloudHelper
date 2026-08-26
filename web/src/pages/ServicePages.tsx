import { Link, useNavigate } from "@tanstack/react-router";
import { CalendarClock, Plus, RefreshCw, ScanLine, Settings2, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { PageHeader, PrimaryButton, SecondaryButton } from "@/components/ConsoleShell";
import { AdminServiceFilters } from "@/components/AdminServiceFilters";
import { GuangyaAuthorizationPanel } from "@/components/GuangyaAuthorizationPanel";
import { ProviderConnectionGuide } from "@/components/ProviderConnectionGuide";
import { ServicePathPicker, toProviderDirectory } from "@/components/ServicePathPicker";
import { Panel, StatCard, StatusPill, type StatusTone } from "@/components/ui-kit";
import {
  ApiClientError,
  backfillExistingMediaProbes,
  createScanJob,
  createService,
  deleteCloudService,
  getService,
  listAdminUsers,
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
  type GuangyaAuthorizationStatus,
  type MediaType,
  type ProviderDirectory,
  type ProviderDescriptor,
  type ServiceStatus,
  type ServiceListFilters,
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

const guangyaLoginModeLabels: Record<"official_api" | "web_qr" | "web_sms", string> = {
  official_api: "官方光鸭",
  web_qr: "三方光鸭（扫码登录）",
  web_sms: "三方光鸭（验证码登录）",
};

/** 根据 Provider 和授权方式返回服务列表使用的中文名称。 */
function getServiceProviderLabel(service: CloudService): string {
  if (service.providerType !== "guangya") return service.providerType;
  if (service.connectionAuthMode === "official_api") return "官方光鸭";
  if (service.connectionAuthMode === "web_qr" || service.connectionAuthMode === "web_sms") return "三方光鸭";
  return "光鸭";
}

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
  probing: "分析视频规格",
  completed: "已完成",
};

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
  /** 扫描时是否同步读取 TMDB 详情、演职人员和节目单集信息。 */
  syncDetails: boolean;
  /** 是否在扫描结束后异步使用 ffprobe 分析实际媒体规格。 */
  analyzeMediaSpecs: boolean;
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
    // 关键变量：旧服务缺少该字段时必须保持关闭，扫描行为才能与 APP 一致。
    syncDetails: videoProfile.syncDetails === true,
    // 关键变量：旧服务默认不读取视频字节，只有用户明确开启后才进入独立队列。
    analyzeMediaSpecs: videoProfile.analyzeMediaSpecs === true,
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
        syncDetails: settings.syncDetails,
        analyzeMediaSpecs: settings.analyzeMediaSpecs,
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
function ServiceCard({ service, admin, onChanged }: { service: CloudService; admin: boolean; onChanged: () => Promise<void> }) {
  const [message, setMessage] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  // 关键变量：同步阻止连续点击在状态刷新前重复发送删除请求。
  const deletingRef = useRef(false);
  const detailPath = admin ? "/admin/services/$serviceId" : "/app/services/$serviceId";

  /** 创建默认增量扫描任务。 */
  async function triggerScan(): Promise<void> {
    setMessage("正在创建扫描任务…");
    try {
      const job = await createScanJob(service.id, "incremental", admin);
      setMessage(`任务 ${job.id} 已进入队列`);
      await onChanged();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "扫描任务创建失败");
    }
  }

  /** 二次确认后从服务卡片删除服务，并同步刷新服务列表。 */
  async function deleteCardService(): Promise<void> {
    if (deletingRef.current) {
      console.warn("codex-flycloud-helper-service-delete", {
        事件: "服务卡片拦截重复删除请求",
        服务ID: service.id,
      });
      return;
    }
    const confirmed = window.confirm(
      `确定删除“${service.displayName}”吗？该服务、媒体库以及对应的 Jellyfin 账号、会话和播放记录都会被删除，此操作无法撤销。`,
    );
    if (!confirmed) return;

    deletingRef.current = true;
    setDeleting(true);
    setMessage("正在删除服务…");
    console.info("codex-flycloud-helper-service-delete", {
      事件: "服务卡片开始删除服务",
      服务ID: service.id,
      服务名称: service.displayName,
      操作入口: admin ? "管理员服务卡片" : "用户服务卡片",
    });
    try {
      await deleteCloudService(service.id, admin);
      console.info("codex-flycloud-helper-service-delete", {
        事件: "服务卡片删除服务成功",
        服务ID: service.id,
        操作入口: admin ? "管理员服务卡片" : "用户服务卡片",
      });
      await onChanged();
    } catch (error) {
      const errorMessage = error instanceof ApiClientError && error.code === "service_has_active_job"
        ? "服务仍有未结束的后台任务，请先终止任务后再删除"
        : error instanceof Error ? error.message : "删除服务失败";
      console.warn("codex-flycloud-helper-service-delete", {
        事件: "服务卡片删除服务失败",
        服务ID: service.id,
        错误码: error instanceof ApiClientError ? error.code : "service_delete_failed",
        错误信息: errorMessage,
      });
      setMessage(errorMessage);
    } finally {
      deletingRef.current = false;
      setDeleting(false);
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
            <p className="truncate font-mono text-[11px] text-muted-foreground">{getServiceProviderLabel(service)} · {service.id}{admin ? ` · ${service.ownerUsername}` : ""}</p>
          </div>
        </div>
        <StatusPill tone={getServiceTone(service.status)}>{serviceStatusLabels[service.status]}</StatusPill>
      </header>

      <dl className="mt-5 grid grid-cols-3 gap-3 text-center">
        <div className="rounded-lg border border-border bg-secondary/40 p-3"><dt className="text-[10px] text-muted-foreground">连接修订</dt><dd className="mt-1 text-xs font-medium">r{service.credentialRevision}</dd></div>
        <div className="rounded-lg border border-border bg-secondary/40 p-3"><dt className="text-[10px] text-muted-foreground">扫描修订</dt><dd className="mt-1 text-xs font-medium">r{service.scanProfileRevision}</dd></div>
        <div className="rounded-lg border border-border bg-secondary/40 p-3"><dt className="text-[10px] text-muted-foreground">最近扫描</dt><dd className="mt-1 truncate text-xs font-medium">{formatTime(service.lastScanAt)}</dd></div>
      </dl>

      <div className="mt-4 flex flex-wrap gap-2">
        <StatusPill>{dataTypeLabels[service.dataType]}</StatusPill>
        <StatusPill>刮削 r{service.metadataProfileRevision}</StatusPill>
      </div>

      <footer className="mt-5 flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => void triggerScan()} className="inline-flex items-center gap-1.5 rounded-lg bg-primary/15 px-3 py-2 text-xs text-primary-soft">
          <ScanLine className="size-3.5" /> 触发增量扫描
        </button>
        <Link to={detailPath} params={{ serviceId: service.id }} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground"><Settings2 className="size-3.5" /> 服务详情与配置</Link>
        <button type="button" onClick={() => void deleteCardService()} disabled={deleting} className="ml-auto inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-destructive bg-destructive px-3 py-2 text-xs font-semibold text-destructive-foreground transition-colors hover:bg-destructive/90 disabled:cursor-not-allowed disabled:opacity-50">
          <Trash2 className="size-3.5" /> {deleting ? "正在删除…" : "删除服务"}
        </button>
      </footer>
      {message && <p className="mt-3 text-xs text-muted-foreground">{message}</p>}
    </article>
  );
}

/** 渲染用户或管理员作用域的服务列表。 */
function ServicesListPage({ admin }: { admin: boolean }) {
  const [filters, setFilters] = useState<ServiceListFilters>({});
  const resource = useApiResource(
    () => listServices(admin, admin ? filters : {}),
    [admin, filters.search, filters.userId, filters.providerType, filters.dataType, filters.status, filters.jellyfinEnabled],
  );
  const filterOptions = useApiResource(async () => {
    if (!admin) return { users: [], providers: [] };
    const [users, providers] = await Promise.all([listAdminUsers(), listProviders()]);
    return { users: users.items, providers };
  }, [admin]);
  return (
    <>
      <PageHeader
        title={admin ? "全部服务" : "我的服务"}
        actions={<Link to={admin ? "/admin/services/new" : "/app/services/new"}><PrimaryButton><Plus className="size-4" /> 创建云端服务</PrimaryButton></Link>}
      />
      {admin && <AdminServiceFilters value={filters} users={filterOptions.data?.users ?? []} providers={filterOptions.data?.providers ?? []} resultCount={resource.data?.total ?? 0} onChange={setFilters} />}
      {resource.error && <Panel><p className="text-sm text-destructive">{resource.error}</p></Panel>}
      <div className="grid gap-4 lg:grid-cols-2">
        {resource.data?.items.map((service) => <ServiceCard key={service.id} service={service} admin={admin} onChanged={async () => { await resource.refresh(); }} />)}
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
  const [adminTargetUserId, setAdminTargetUserId] = useState("");
  const [guangyaAuthorization, setGuangyaAuthorization] = useState<GuangyaAuthorizationStatus | null>(null);
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
    if (descriptor.authenticationMode === "web_qr") {
      if (guangyaAuthorization?.status !== "authorized") {
        setMessage("请先完成三方光鸭扫码或验证码登录，再创建服务");
        return;
      }
      connection.authorizationSessionId = guangyaAuthorization.authorizationSessionId;
    } else {
      descriptor.connectionFields.forEach((field) => {
        const value = String(form.get(`connection.${field.name}`) ?? "").trim();
        if (value) connection[field.name] = value;
      });
    }
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
            syncDetails: false,
            analyzeMediaSpecs: false,
          },
        },
      },
    };
    if (admin) input.userId = adminTargetUserId;
    setMessage("正在验证连接并创建服务，不会自动开始扫描…");
    try {
      const creation = await createService(input, admin);
      await navigate({ to: admin ? "/admin/services/$serviceId" : "/app/services/$serviceId", params: { serviceId: creation.service.id } });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "服务创建失败");
    }
  }

  return (
    <>
      <PageHeader title="创建云端服务" />
      <Panel>
        <form onSubmit={(event) => void submit(event)} className="grid gap-5 lg:grid-cols-2">
          {admin && <label className="block"><span className="text-xs text-muted-foreground">所属用户</span><select name="userId" required value={adminTargetUserId} onChange={(event) => setAdminTargetUserId(event.target.value)} className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm"><option value="">选择目标用户</option>{users.data?.items.map((user) => <option key={user.userId} value={user.userId}>{user.username}</option>)}</select></label>}
          <label className="block"><span className="text-xs text-muted-foreground">服务名称</span><input name="displayName" required maxLength={100} className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm" /></label>
          <label className="block">
            <span className="text-xs text-muted-foreground">数据类型</span>
            <select name="dataType" required defaultValue="video" className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm">
              <option value="video">影视</option>
              <option value="music" disabled>音乐（暂未支持）</option>
              <option value="audiobook" disabled>有声书（暂未支持）</option>
            </select>
          </label>
          <label className="block"><span className="text-xs text-muted-foreground">Provider 类型</span><select name="providerType" required value={selectedProvider?.type ?? ""} onChange={(event) => { setProviderType(event.target.value); setGuangyaAuthorization(null); }} className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm"><option value="">选择 Provider</option>{providers.data?.map((provider) => <option key={provider.type} value={provider.type}>{provider.displayName}</option>)}</select></label>
          {selectedProvider?.authenticationMode === "web_qr"
            ? <GuangyaAuthorizationPanel admin={admin} targetUserId={adminTargetUserId || undefined} resetKey={`${selectedProvider.type}:${adminTargetUserId}`} onAuthorizationChange={setGuangyaAuthorization} />
            : selectedProvider?.connectionFields.map((field) => <label key={field.name} className="block"><span className="text-xs text-muted-foreground">{field.label}</span><input name={`connection.${field.name}`} type={field.type === "password" ? "password" : field.type} required={field.required} autoComplete="off" className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm" /></label>)}
          {selectedProvider && <div className="rounded-xl border border-border bg-secondary/35 p-4 lg:col-span-2"><p className="text-sm font-medium">默认任务并发</p><p className="mt-2 text-xs text-muted-foreground">扫描任务 {selectedProvider.recommendedScanSettings.scanDirectoryConcurrency.default}，刮削任务 {selectedProvider.recommendedScanSettings.scrapeTaskConcurrency.default}。创建后可以在服务详情中修改。</p></div>}
          {selectedProvider && <ProviderConnectionGuide providerType={selectedProvider.type} />}
          <div className="lg:col-span-2 flex items-center justify-between gap-4"><p className="text-xs text-muted-foreground">创建成功后不会自动扫描或刮削，需要先在服务详情中设置扫描路径。</p><PrimaryButton type="submit" disabled={selectedProvider?.authenticationMode === "web_qr" && guangyaAuthorization?.status !== "authorized"}>验证连接并创建服务</PrimaryButton></div>
          {message && <p className="lg:col-span-2 text-sm text-muted-foreground">{message}</p>}
        </form>
      </Panel>
    </>
  );
}

/** 独立管理服务连接，避免完整认证表单长期占用服务详情页面。 */
export function ServiceConnectionPage({ serviceId, admin = false }: { serviceId: string; admin?: boolean }) {
  const resource = useApiResource(() => getService(serviceId, admin), [serviceId, admin]);
  const providers = useApiResource(() => listProviders(), []);
  const [message, setMessage] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const reconnectingRef = useRef(false);
  const service = resource.data;
  const providerDescriptor = providers.data?.find((item) => item.type === service?.providerType);
  const detailPath = admin ? "/admin/services/$serviceId" : "/app/services/$serviceId";

  /** 使用完整新凭据替换当前连接。 */
  async function saveConnection(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!service || !providerDescriptor) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const connection: Record<string, string> = {};
    providerDescriptor.connectionFields.forEach((field) => {
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
      const errorMessage = error instanceof Error ? error.message : "连接保存失败";
      console.warn("codex-flycloud-connection-management", {
        事件: "网页替换服务连接失败",
        服务ID: serviceId,
        网盘类型: service.providerType,
        错误信息: errorMessage,
      });
      setMessage(errorMessage);
    }
  }

  /** 光鸭网页授权成功后，用一次性授权会话替换当前服务连接。 */
  async function saveGuangyaConnection(authorization: GuangyaAuthorizationStatus | null): Promise<void> {
    if (!service || authorization?.status !== "authorized") return;
    const loginMethod = authorization.authMethod === "sms" ? "验证码登录" : "扫码登录";
    setMessage(`三方光鸭${loginMethod}成功，正在验证并保存连接…`);
    try {
      await updateServiceConnection(serviceId, {
        authorizationSessionId: authorization.authorizationSessionId,
      }, admin);
      setMessage("三方光鸭连接已更新，后续访问令牌将由服务端自动刷新");
      await resource.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "光鸭连接保存失败";
      console.warn("codex-flycloud-connection-management", {
        事件: "网页保存光鸭连接失败",
        服务ID: serviceId,
        登录方式: loginMethod,
        错误信息: errorMessage,
      });
      setMessage(errorMessage);
    }
  }

  /** 使用服务端当前保存的配置重新验证连接，并拦截重复点击。 */
  async function reconnectCurrentConnection(): Promise<void> {
    if (reconnectingRef.current) return;
    reconnectingRef.current = true;
    setReconnecting(true);
    setMessage("正在使用当前配置重新连接网盘服务…");
    try {
      await reconnectServiceConnection(serviceId, admin);
      setMessage("当前配置验证成功，服务连接已恢复");
      await resource.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "使用当前配置重连失败";
      console.warn("codex-flycloud-connection-management", {
        事件: "网页使用当前配置重连失败",
        服务ID: serviceId,
        错误信息: errorMessage,
      });
      setMessage(errorMessage);
    } finally {
      reconnectingRef.current = false;
      setReconnecting(false);
    }
  }

  if (!service) {
    return <Panel><div className="py-16 text-center text-sm text-muted-foreground">{resource.error ?? "正在读取连接信息…"}</div></Panel>;
  }

  return (
    <>
      <PageHeader
        title={`${service.displayName} · 连接管理`}
        actions={<Link to={detailPath} params={{ serviceId }} className="inline-flex rounded-lg border border-border px-4 py-2.5 text-sm text-muted-foreground">返回服务详情</Link>}
      />
      {message && <Panel className="mb-4"><p className="text-sm text-muted-foreground">{message}</p></Panel>}
      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="当前连接">
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill tone={getServiceTone(service.status)}>{serviceStatusLabels[service.status]}</StatusPill>
            <StatusPill>{service.connectionAuthMode ? guangyaLoginModeLabels[service.connectionAuthMode] : service.credentialConfigured ? "凭据已配置" : "凭据未配置"}</StatusPill>
            <StatusPill>连接 r{service.credentialRevision}</StatusPill>
          </div>
          <div className="mt-4">
            <SecondaryButton disabled={reconnecting} onClick={() => void reconnectCurrentConnection()}>
              <RefreshCw className={`size-4 ${reconnecting ? "animate-spin" : ""}`} />
              {reconnecting ? "正在重连…" : "使用当前配置重连"}
            </SecondaryButton>
          </div>
        </Panel>
        <Panel title="替换连接" description={providerDescriptor?.authenticationMode === "web_qr" ? "三方光鸭可使用扫码或验证码重新登录；官方光鸭由 Flymby APP 同步。" : "Secret 不回显，保存时必须提交一套完整新连接。"}>
          {providers.loading && <p className="text-sm text-muted-foreground">正在读取网盘连接配置…</p>}
          {providerDescriptor?.authenticationMode === "web_qr" ? (
            <GuangyaAuthorizationPanel admin={admin} targetUserId={admin ? service.userId : undefined} resetKey={`${service.id}:${service.credentialRevision}`} initialLoginMode={service.connectionAuthMode ?? "web_qr"} onAuthorizationChange={(authorization) => void saveGuangyaConnection(authorization)} />
          ) : providerDescriptor ? (
            <form onSubmit={(event) => void saveConnection(event)} className="grid gap-3">
              {providerDescriptor.connectionFields.map((field) => <label key={field.name}><span className="text-xs text-muted-foreground">{field.label}</span><input name={field.name} type={field.type === "password" ? "password" : field.type} required={field.required} autoComplete="off" className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm" /></label>)}
              <PrimaryButton type="submit">验证并保存连接</PrimaryButton>
            </form>
          ) : !providers.loading && <p className="text-sm text-destructive">当前网盘类型缺少连接描述</p>}
        </Panel>
      </div>
    </>
  );
}

/** 云端服务详情与配置页面。 */
export function ServiceDetailPage({ serviceId, admin = false }: { serviceId: string; admin?: boolean }) {
  const navigate = useNavigate();
  const resource = useApiResource(() => getService(serviceId, admin), [serviceId, admin]);
  const providers = useApiResource(() => listProviders(), []);
  const [message, setMessage] = useState<string | null>(null);
  const [updatingStatus, setUpdatingStatus] = useState(false);
  const updatingStatusRef = useRef(false);
  const [deletingService, setDeletingService] = useState(false);
  // 关键变量：同步占用删除操作，避免 React 按钮状态尚未刷新时重复提交。
  const deletingServiceRef = useRef(false);
  const [creatingScanMode, setCreatingScanMode] = useState<"full" | "incremental" | null>(null);
  const creatingScanModeRef = useRef<"full" | "incremental" | null>(null);
  const [backfillingMediaSpecs, setBackfillingMediaSpecs] = useState(false);
  const backfillingMediaSpecsRef = useRef(false);
  const service = resource.data;
  const [fullScanRoots, setFullScanRoots] = useState<ProviderDirectory[]>([]);
  const [incrementalScanRoots, setIncrementalScanRoots] = useState<ProviderDirectory[]>([]);
  const [metadataSettings, setMetadataSettings] = useState<VideoMetadataSettings>({
    providerId: "builtin.tmdb",
    language: "zh-CN",
    region: "CN",
    useNfo: true,
    syncDetails: false,
    analyzeMediaSpecs: false,
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
    if (creatingScanModeRef.current) {
      console.warn("codex-flycloud-helper-job-operation", {
        事件: "拦截重复创建扫描任务",
        服务ID: serviceId,
        正在创建模式: creatingScanModeRef.current,
        本次模式: mode,
      });
      return;
    }
    creatingScanModeRef.current = mode;
    setCreatingScanMode(mode);
    setMessage("正在创建扫描任务…");
    try {
      const job = await createScanJob(serviceId, mode, admin);
      setMessage(`任务 ${job.id} 已进入队列`);
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "创建任务失败");
    } finally {
      creatingScanModeRef.current = null;
      setCreatingScanMode(null);
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
      setMessage("元数据配置已保存，规格开关只影响之后执行的扫描刮削任务");
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
        同步刮削详情: metadataSettings.syncDetails,
        分析媒体规格: metadataSettings.analyzeMediaSpecs,
        错误信息: errorMessage,
      });
      setMessage(errorMessage);
    }
  }

  /** 手动为当前服务已有但缺少规格的视频创建独立后台任务。 */
  async function backfillMediaSpecs(): Promise<void> {
    if (backfillingMediaSpecsRef.current) return;
    backfillingMediaSpecsRef.current = true;
    setBackfillingMediaSpecs(true);
    setMessage("正在检查已有视频的规格缺失情况…");
    try {
      const result = await backfillExistingMediaProbes(serviceId, admin);
      setMessage(result.job
        ? result.job.errorCode === "provider_authentication_failed"
          ? `已创建视频规格后台任务，共 ${result.queuedCount.toLocaleString()} 个待分析视频；当前等待 APP 同步有效登录信息`
          : `已创建视频规格后台任务，共 ${result.queuedCount.toLocaleString()} 个待分析视频`
        : "已有视频均已具备规格，或已在其他后台任务中等待分析");
      await resource.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "创建视频规格后台任务失败";
      console.warn("codex-media-ffprobe-backfill", {
        事件: "触发已有视频规格分析失败",
        服务ID: serviceId,
        错误信息: errorMessage,
      });
      setMessage(errorMessage);
    } finally {
      backfillingMediaSpecsRef.current = false;
      setBackfillingMediaSpecs(false);
    }
  }

  /** 在页面顶部启用或停用当前服务，并拦截重复点击。 */
  async function toggleStatus(): Promise<void> {
    if (updatingStatusRef.current) return;
    updatingStatusRef.current = true;
    setUpdatingStatus(true);
    try {
      await updateServiceStatus(serviceId, activeService.status === "disabled" ? "active" : "disabled", admin);
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "服务状态修改失败");
    } finally {
      updatingStatusRef.current = false;
      setUpdatingStatus(false);
    }
  }

  /** 二次确认后删除当前云端服务，并返回对应的服务列表。 */
  async function deleteCurrentService(): Promise<void> {
    if (deletingServiceRef.current) {
      console.warn("codex-flycloud-helper-service-delete", { 事件: "拦截重复删除请求", 服务ID: serviceId });
      return;
    }
    const confirmed = window.confirm(
      `确定删除“${activeService.displayName}”吗？云端服务、媒体库、扫描结果以及与 APP 的关联都会被移除，此操作无法在页面中撤销。`,
    );
    if (!confirmed) return;

    deletingServiceRef.current = true;
    setDeletingService(true);
    setMessage("正在删除云端服务…");
    console.info("codex-flycloud-helper-service-delete", {
      事件: "开始删除云端服务",
      服务ID: serviceId,
      服务名称: activeService.displayName,
      操作入口: admin ? "管理员服务详情" : "用户服务详情",
    });
    try {
      await deleteCloudService(serviceId, admin);
      console.info("codex-flycloud-helper-service-delete", {
        事件: "删除云端服务成功",
        服务ID: serviceId,
        操作入口: admin ? "管理员服务详情" : "用户服务详情",
      });
      await navigate({ to: admin ? "/admin/services" : "/app/services", replace: true });
    } catch (error) {
      const errorMessage = error instanceof ApiClientError && error.code === "service_has_active_job"
        ? "服务仍有未结束的后台任务，请先终止任务后再删除"
        : error instanceof Error ? error.message : "删除云端服务失败";
      console.warn("codex-flycloud-helper-service-delete", {
        事件: "删除云端服务失败",
        服务ID: serviceId,
        错误码: error instanceof ApiClientError ? error.code : "service_delete_failed",
        错误信息: errorMessage,
      });
      setMessage(errorMessage);
    } finally {
      deletingServiceRef.current = false;
      setDeletingService(false);
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
  // 关键变量：删除服务前必须先处理排队、运行、重试等待或暂停中的任务。
  const hasUnfinishedJob = service.recentJobs.some((job) =>
    job.status === "queued" || job.status === "running" || job.status === "retry_waiting" || job.status === "paused");

  return (
    <>
      <PageHeader
        title={service.displayName}
        actions={(
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill tone={getServiceTone(service.status)}>服务{serviceStatusLabels[service.status]}</StatusPill>
            <SecondaryButton disabled={updatingStatus || service.status === "scanning" || deletingService} onClick={() => void toggleStatus()}>
              {updatingStatus ? "正在更新…" : service.status === "disabled" ? "启用服务" : "停用服务"}
            </SecondaryButton>
            <SecondaryButton disabled={fullScanRoots.length === 0 || creatingScanMode !== null || deletingService} title={fullScanRoots.length === 0 ? "请先配置全量扫描路径" : undefined} onClick={() => void trigger("full")}>{creatingScanMode === "full" ? "正在创建…" : "全量扫描"}</SecondaryButton>
            <PrimaryButton disabled={incrementalScanRoots.length === 0 || creatingScanMode !== null || deletingService} title={incrementalScanRoots.length === 0 ? "请先配置增量扫描路径" : undefined} onClick={() => void trigger("incremental")}><ScanLine className="size-4" /> {creatingScanMode === "incremental" ? "正在创建…" : "增量扫描"}</PrimaryButton>
          </div>
        )}
      />
      {message && <Panel className="mb-4"><p className="text-sm text-muted-foreground">{message}</p></Panel>}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="媒体条目" value={service.itemCount.toLocaleString()} hint="当前已入库" />
        <StatCard label="目录版本" value={`v${service.catalogVersion}`} hint={formatTime(service.lastScanAt)} tone="info" />
        <StatCard label="最近后台任务" value={recentJob ? recentJob.status === "retry_waiting" && recentJob.jobType === "media_probe" ? "等待重试" : jobStatusLabels[recentJob.status] : "暂无"} hint={recentJob ? `${recentJob.jobType === "media_probe" ? "视频规格分析" : "扫描刮削"} · ${getJobStageLabel(recentJob.stage)}` : "尚无任务"} tone="warning" />
        <StatCard
          label="连接状态"
          value={service.status === "reauthorization_required" ? "需重新授权" : service.credentialConfigured ? "已配置" : "未配置"}
          hint={service.connectionAuthMode
            ? guangyaLoginModeLabels[service.connectionAuthMode]
            : service.credentialConfigured ? "Secret 已配置" : "Secret 未配置"}
          tone={service.status === "reauthorization_required" ? "warning" : "muted"}
          action={<Link to={admin ? "/admin/services/$serviceId/connection" : "/app/services/$serviceId/connection"} params={{ serviceId }} className="inline-flex rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground">连接管理</Link>}
        />
      </div>
      <Panel title="配置修订与范围" className="mt-4">
        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded-xl border border-border bg-secondary/40 p-4">
            <p className="text-xs text-muted-foreground">配置修订</p>
            <div className="mt-3 flex flex-wrap gap-2"><StatusPill>{dataTypeLabels[service.dataType]}</StatusPill><StatusPill>连接 r{service.credentialRevision}</StatusPill><StatusPill>扫描 r{service.scanProfileRevision}</StatusPill><StatusPill>元数据 r{service.metadataProfileRevision}</StatusPill></div>
            <p className="mt-4 text-xs text-muted-foreground">全量路径 {fullScanRoots.length} 条 · 增量路径 {incrementalScanRoots.length} 条</p>
          </div>
          <div className="rounded-xl border border-border bg-secondary/40 p-4"><p className="text-xs text-muted-foreground">连接管理</p><p className="mt-2 text-sm">重连、重新授权或替换完整连接。</p><Link to={admin ? "/admin/services/$serviceId/connection" : "/app/services/$serviceId/connection"} params={{ serviceId }} className="mt-3 inline-flex items-center gap-1 text-xs text-primary-soft">打开连接管理 <Settings2 className="size-3.5" /></Link></div>
          <div className="rounded-xl border border-border bg-secondary/40 p-4"><p className="text-xs text-muted-foreground">扫描定时任务</p><p className="mt-2 text-sm">分别设置全量和增量扫描的间隔、每日、每周或每月计划。</p><Link to={admin ? "/admin/services/$serviceId/scan-schedules" : "/app/services/$serviceId/scan-schedules"} params={{ serviceId }} className="mt-3 inline-flex items-center gap-1 text-xs text-primary-soft">打开扫描定时任务 <CalendarClock className="size-3.5" /></Link></div>
        </div>
      </Panel>
      <div className="mt-4 grid gap-4 xl:grid-cols-2">
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
            <div className="rounded-xl border border-border bg-secondary/35 p-4">
              <div className="flex items-center justify-between gap-4">
                <div><p className="text-sm font-medium">同步刮削详情</p><p className="mt-1 text-xs text-muted-foreground">{metadataSettings.syncDetails ? "扫描匹配后同步读取详情、演职人员和节目单集信息，保持原有云助手模式。" : "仅在扫描时完成匹配；打开影片详情时再实时向 TMDB 查询，与 APP 扫描方式一致。"}</p></div>
                <button type="button" role="switch" aria-checked={metadataSettings.syncDetails} aria-label="同步刮削详情" onClick={() => setMetadataSettings((current) => ({ ...current, syncDetails: !current.syncDetails }))} className={`relative h-7 w-12 shrink-0 rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${metadataSettings.syncDetails ? "border-primary bg-primary" : "border-border bg-secondary"}`}>
                  <span className={`absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow-sm transition-transform ${metadataSettings.syncDetails ? "translate-x-5" : "translate-x-0"}`} />
                </button>
              </div>
            </div>
            <div className="rounded-xl border border-border bg-secondary/35 p-4">
              <div className="flex items-center justify-between gap-4">
                <div><p className="text-sm font-medium">扫描时读取视频规格（ffprobe）</p><p className="mt-1 text-xs text-muted-foreground">{metadataSettings.analyzeMediaSpecs ? "后续扫描刮削会为新发现或变化的视频读取时长、编码、分辨率、音轨和字幕。" : "后续扫描刮削不读取视频规格，不影响已经入库的视频和已有规格结果。"}</p></div>
                <button type="button" role="switch" aria-checked={metadataSettings.analyzeMediaSpecs} aria-label="分析视频规格" onClick={() => setMetadataSettings((current) => ({ ...current, analyzeMediaSpecs: !current.analyzeMediaSpecs }))} className={`relative h-7 w-12 shrink-0 rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${metadataSettings.analyzeMediaSpecs ? "border-primary bg-primary" : "border-border bg-secondary"}`}>
                  <span className={`absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow-sm transition-transform ${metadataSettings.analyzeMediaSpecs ? "translate-x-5" : "translate-x-0"}`} />
                </button>
              </div>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border/70 pt-4">
                <p className="text-xs text-muted-foreground">需要补充历史数据时单独执行，不受上方扫描开关影响。</p>
                <SecondaryButton type="button" onClick={() => void backfillMediaSpecs()} disabled={backfillingMediaSpecs}>
                  <ScanLine className="size-4" /> {backfillingMediaSpecs ? "正在创建任务…" : "分析已有缺失规格视频"}
                </SecondaryButton>
              </div>
            </div>
            <div className="flex justify-end"><PrimaryButton type="submit">保存元数据配置</PrimaryButton></div>
          </form>
        </Panel>
        <Panel title="危险操作" description="删除服务会同时删除其媒体库，需要二次确认。">
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => void deleteCurrentService()} disabled={hasUnfinishedJob || deletingService} title={hasUnfinishedJob ? "请先终止该服务未结束的后台任务" : undefined} className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-destructive bg-destructive px-4 py-2.5 text-sm font-semibold text-destructive-foreground shadow-sm transition-colors hover:bg-destructive/90 disabled:cursor-not-allowed disabled:opacity-40"><Trash2 className="size-4" /> {deletingService ? "正在删除…" : "删除服务"}</button>
          </div>
          {hasUnfinishedJob && <p className="mt-3 text-xs text-warning">该服务仍有未结束的后台任务，请先终止任务后再删除服务。</p>}
        </Panel>
      </div>
    </>
  );
}

export function AdminServiceCreatePage() { return <ServiceCreatePage admin />; }
export function UserServiceDetailPage({ serviceId }: { serviceId: string }) { return <ServiceDetailPage serviceId={serviceId} />; }
export function AdminServiceDetailPage({ serviceId }: { serviceId: string }) { return <ServiceDetailPage serviceId={serviceId} admin />; }
export function UserServiceConnectionPage({ serviceId }: { serviceId: string }) { return <ServiceConnectionPage serviceId={serviceId} />; }
export function AdminServiceConnectionPage({ serviceId }: { serviceId: string }) { return <ServiceConnectionPage serviceId={serviceId} admin />; }
