import type { ApiConfig } from "./config.js";
import type { AiModelManager } from "./ai/ai-model-manager.js";
import type { FlyCloudHelperDatabase } from "./database.js";
import type { LibraryExportService } from "./export-service.js";
import type { MusicBrainzClient } from "./metadata/musicbrainz.js";
import type { TmdbMetadataCache } from "./metadata/tmdb-cache.js";
import type { TmdbKeyPool } from "./metadata/tmdb.js";
import type { MetadataPluginManager } from "./plugin-manager.js";
import type { ProviderRegistry } from "./providers/registry.js";
import type { ScanFailureReportService } from "./scan-failure-report-service.js";
import type { CredentialVault } from "./secrets.js";
import type { ServiceRepository } from "./service-repository.js";
import type { ServiceMigrationRepository } from "./service-migration-repository.js";
import type { ServiceMigrationWorker } from "./service-migration-worker.js";
import type { ScanWorker } from "./worker.js";
import type { PublicAccessService } from "./public-access.js";
import type { ServiceAccessService } from "./service-access.js";
import type { EmbyAccessService } from "./emby-access.js";
import type { MediaProbeWorker } from "./media-probe-worker.js";
import type { ScanScheduleStore, ScanScheduleWorker } from "./scan-schedule-service.js";
import type { TelegramNotificationService } from "./telegram-notification-service.js";
import type { AggregateServiceRepository } from "./aggregate-service-repository.js";
import type { AggregateIndexService } from "./aggregate-index-service.js";
import type { AggregateAccessService } from "./aggregate-access-service.js";

/** 后台路由共享的已初始化运行时依赖。 */
export interface ApiRuntime {
  config: ApiConfig;
  database: FlyCloudHelperDatabase;
  repository: ServiceRepository;
  migrations: ServiceMigrationRepository;
  migrationWorker: ServiceMigrationWorker;
  providers: ProviderRegistry;
  vault: CredentialVault;
  tmdbCache: TmdbMetadataCache;
  tmdb: TmdbKeyPool;
  musicBrainz: MusicBrainzClient;
  worker: ScanWorker;
  mediaProbeWorker: MediaProbeWorker;
  scanSchedules: ScanScheduleStore;
  scanScheduleWorker: ScanScheduleWorker;
  plugins: MetadataPluginManager;
  aiModels: AiModelManager;
  exports: LibraryExportService;
  failureReports: ScanFailureReportService;
  publicAccess: PublicAccessService;
  serviceAccess: ServiceAccessService;
  /** 独立 Emby 协议账号、令牌和会话服务，不能与 Jellyfin 共用。 */
  embyAccess: EmbyAccessService;
  /** 单个 Jellyfin 或 Emby 协议对应多个影视来源的聚合服务。 */
  aggregateServices: AggregateServiceRepository;
  /** 在后台构建聚合媒体身份、来源映射和媒体版本索引。 */
  aggregateIndex: AggregateIndexService;
  /** 同一聚合协议地址下相互独立的多个登录账号。 */
  aggregateAccess: AggregateAccessService;
  telegramNotifications: TelegramNotificationService;
  logBusinessEvent: (
    level: "info" | "warn",
    fields: Record<string, string | number | boolean | null>,
  ) => void;
}
