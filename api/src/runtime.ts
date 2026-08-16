import type { ApiConfig } from "./config.js";
import type { FlyCloudHelperDatabase } from "./database.js";
import type { LibraryExportService } from "./export-service.js";
import type { MusicBrainzClient } from "./metadata/musicbrainz.js";
import type { TmdbKeyPool } from "./metadata/tmdb.js";
import type { MetadataPluginManager } from "./plugin-manager.js";
import type { ProviderRegistry } from "./providers/registry.js";
import type { CredentialVault } from "./secrets.js";
import type { ServiceRepository } from "./service-repository.js";
import type { ScanWorker } from "./worker.js";

/** 后台路由共享的已初始化运行时依赖。 */
export interface ApiRuntime {
  config: ApiConfig;
  database: FlyCloudHelperDatabase;
  repository: ServiceRepository;
  providers: ProviderRegistry;
  vault: CredentialVault;
  tmdb: TmdbKeyPool;
  musicBrainz: MusicBrainzClient;
  worker: ScanWorker;
  plugins: MetadataPluginManager;
  exports: LibraryExportService;
  logBusinessEvent: (
    level: "info" | "warn",
    fields: Record<string, string | number | boolean | null>,
  ) => void;
}
