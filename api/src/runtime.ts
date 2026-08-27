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
import type { MediaProbeWorker } from "./media-probe-worker.js";
import type { ScanScheduleStore, ScanScheduleWorker } from "./scan-schedule-service.js";

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
  logBusinessEvent: (
    level: "info" | "warn",
    fields: Record<string, string | number | boolean | null>,
  ) => void;
}
