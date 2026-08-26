import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { config as loadDotEnv } from "dotenv";

export type DatabaseType = "sqlite" | "postgres" | "mysql";

export interface ApiConfig {
  host: string;
  port: number;
  /** 对外公布的实例根地址；配置时优先于数据库设置。 */
  publicBaseUrlOverride: string | null;
  databaseType: DatabaseType;
  sqlitePath: string;
  databaseUrl: string | null;
  databaseAutoCreate: boolean;
  webSessionTtlSeconds: number;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  cookieSecure: boolean;
  credentialMasterKey: string;
  credentialKeyFingerprint: string;
  credentialKeySource: "file" | "environment" | "generated";
  credentialKeyGeneratedNow: boolean;
  credentialKeyFilePath: string | null;
  tmdbPerKeyConcurrency: number;
  tmdbMaxConcurrency: number;
  musicbrainzUserAgent: string;
  acoustidApiKey: string | null;
  fpcalcPath: string | null;
  workerEnabled: boolean;
  workerConcurrency: number;
  workerPollIntervalMs: number;
  /** ffprobe 可执行文件；Docker 镜像固定为 /usr/bin/ffprobe。 */
  ffprobePath: string;
  /** 媒体规格独立 Worker 的低并发数量。 */
  mediaProbeConcurrency: number;
  mediaProbePollIntervalMs: number;
  ffprobeTimeoutMs: number;
  ffprobeAnalyzeDurationUs: number;
  ffprobeProbeSizeBytes: number;
  pluginDirectory: string;
  exportDirectory: string;
  migrationDirectory: string;
  webDistDirectory: string;
  allowInsecureProviderHttp: boolean;
  pluginMaxBytes: number;
  pluginMaxFiles: number;
  migrationChunkMaxBytes: number;
  migrationSnapshotMaxBytes: number;
  /** 可选的华为账号绑定凭证验签密钥；配置后 APP 注册必须携带受信任签名。 */
  huaweiBindingProofSecret: string | null;
}

/** FlyCloudHelper 项目根目录。 */
export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** 从项目根目录读取开发环境配置。 */
loadDotEnv({ path: path.join(projectRoot, ".env"), quiet: true });

/** 旧项目环境变量前缀，仅用于平滑读取现有部署配置。 */
const legacyEnvironmentPrefix = "FLYMBYSCANNER_";

/** 优先读取新名称环境变量，并兼容旧项目名称对应的变量。 */
function readEnvironmentValue(name: string): string | undefined {
  const currentValue = process.env[name]?.trim();
  if (currentValue) {
    return currentValue;
  }
  if (!name.startsWith("FLYCLOUDHELPER_")) {
    return undefined;
  }
  const legacyName = `${legacyEnvironmentPrefix}${name.slice("FLYCLOUDHELPER_".length)}`;
  return process.env[legacyName]?.trim() || undefined;
}

/** 读取正整数环境变量。 */
function readPositiveInteger(name: string, fallback: number): number {
  const rawValue = readEnvironmentValue(name);
  if (!rawValue) {
    return fallback;
  }
  const parsedValue = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    throw new Error(`环境变量 ${name} 必须是正整数`);
  }
  return parsedValue;
}

/** 读取布尔环境变量。 */
function readBoolean(name: string, fallback: boolean): boolean {
  const rawValue = readEnvironmentValue(name);
  if (!rawValue) {
    return fallback;
  }
  if (rawValue === "true") {
    return true;
  }
  if (rawValue === "false") {
    return false;
  }
  throw new Error(`环境变量 ${name} 只能是 true 或 false`);
}

/** 校验环境变量中的公开根地址，避免生成带凭据或查询参数的协议地址。 */
function validateConfiguredPublicBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("环境变量 FLYCLOUDHELPER_PUBLIC_BASE_URL 必须是完整 HTTP 或 HTTPS 地址");
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("环境变量 FLYCLOUDHELPER_PUBLIC_BASE_URL 不能包含账号、查询参数或片段");
  }
  return url.href.replace(/\/+$/u, "");
}

/** 把项目相对路径或绝对路径解析为可直接使用的路径。 */
function resolveProjectPath(configuredPath: string | undefined, fallback: string): string {
  const selectedPath = configuredPath?.trim() || fallback;
  return path.isAbsolute(selectedPath) ? selectedPath : path.resolve(projectRoot, selectedPath);
}

/** 优先从 Secret 文件读取敏感配置，再读取环境变量。 */
function readSecret(
  environmentName: string,
  fileEnvironmentName: string,
): { value: string | null; source: "file" | "environment" | "missing" } {
  const secretFile = readEnvironmentValue(fileEnvironmentName);
  if (secretFile) {
    const resolvedFile = path.isAbsolute(secretFile)
      ? secretFile
      : path.resolve(projectRoot, secretFile);
    const value = fs.readFileSync(resolvedFile, "utf8").trim();
    return { value: value || null, source: value ? "file" : "missing" };
  }
  const value = readEnvironmentValue(environmentName);
  return { value: value || null, source: value ? "environment" : "missing" };
}

/** 未显式指定 SQLite 文件时，优先继续使用旧项目已经存在的数据文件。 */
function resolveSqlitePath(): string {
  const configuredPath = readEnvironmentValue("FLYCLOUDHELPER_SQLITE_PATH");
  if (configuredPath) {
    return resolveProjectPath(configuredPath, "data/database/flycloud-helper.db");
  }
  const legacyPath = resolveProjectPath(undefined, "data/database/flymby-scanner.db");
  if (fs.existsSync(legacyPath)) {
    return legacyPath;
  }
  return resolveProjectPath(undefined, "data/database/flycloud-helper.db");
}

interface CredentialMasterKeyResult {
  value: string;
  fingerprint: string;
  source: "file" | "environment" | "generated";
  generatedNow: boolean;
  filePath: string | null;
}

/** 读取自动生成的主密钥，并强制文件只允许当前运行用户读写。 */
function readGeneratedCredentialKey(filePath: string): string {
  const fileState = fs.lstatSync(filePath);
  if (!fileState.isFile() || fileState.isSymbolicLink()) {
    throw new Error("自动生成的凭据主密钥路径必须是普通文件，不能使用符号链接");
  }
  if ((fileState.mode & 0o077) !== 0) {
    fs.chmodSync(filePath, 0o600);
  }
  return fs.readFileSync(filePath, "utf8").trim();
}

/** 校验凭据主密钥长度并计算不可逆指纹。 */
function buildCredentialMasterKeyResult(
  value: string,
  source: CredentialMasterKeyResult["source"],
  generatedNow: boolean,
  filePath: string | null,
): CredentialMasterKeyResult {
  if ([...value].length < 32) {
    throw new Error("服务凭据主密钥至少需要 32 个字符");
  }
  return {
    value,
    fingerprint: createHash("sha256").update(value, "utf8").digest("hex"),
    source,
    generatedNow,
    filePath,
  };
}

/** 优先读取外部配置；未配置时原子生成并持久化一把主密钥。 */
function loadOrCreateCredentialMasterKey(): CredentialMasterKeyResult {
  const configuredSecret = readSecret(
    "FLYCLOUDHELPER_CREDENTIAL_MASTER_KEY",
    "FLYCLOUDHELPER_CREDENTIAL_MASTER_KEY_FILE",
  );
  if (configuredSecret.value) {
    return buildCredentialMasterKeyResult(
      configuredSecret.value,
      configuredSecret.source === "file" ? "file" : "environment",
      false,
      null,
    );
  }

  const generatedKeyPath = resolveProjectPath(
    readEnvironmentValue("FLYCLOUDHELPER_GENERATED_CREDENTIAL_KEY_PATH"),
    "data/secrets/credential-master-key",
  );
  try {
    const existingKey = readGeneratedCredentialKey(generatedKeyPath);
    return buildCredentialMasterKeyResult(existingKey, "generated", false, generatedKeyPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  fs.mkdirSync(path.dirname(generatedKeyPath), { recursive: true, mode: 0o700 });
  const generatedKey = randomBytes(32).toString("hex");
  try {
    fs.writeFileSync(generatedKeyPath, `${generatedKey}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return buildCredentialMasterKeyResult(generatedKey, "generated", true, generatedKeyPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const concurrentlyGeneratedKey = readGeneratedCredentialKey(generatedKeyPath);
    return buildCredentialMasterKeyResult(concurrentlyGeneratedKey, "generated", false, generatedKeyPath);
  }
}

/** 校验并读取数据库类型。 */
function readDatabaseType(): DatabaseType {
  const rawType = readEnvironmentValue("FLYCLOUDHELPER_DATABASE_TYPE")?.toLowerCase() || "sqlite";
  if (rawType !== "sqlite" && rawType !== "postgres" && rawType !== "mysql") {
    throw new Error(`不支持的数据库类型：${rawType}`);
  }
  return rawType;
}

/** 校验自动创建数据库时可安全引用的数据库名称。 */
function validateDatabaseName(databaseName: string): string {
  if (!/^[A-Za-z0-9_]+$/.test(databaseName) || databaseName.length > 63) {
    throw new Error("数据库名称只能包含英文字母、数字和下划线，且不能超过 63 个字符");
  }
  return databaseName;
}

/** 使用拆分环境变量生成数据库连接地址，密码中的特殊字符会被自动编码。 */
function buildSeparatedDatabaseUrl(databaseType: Exclude<DatabaseType, "sqlite">): string {
  const databaseHost = readEnvironmentValue("FLYCLOUDHELPER_DATABASE_HOST");
  const databaseName = readEnvironmentValue("FLYCLOUDHELPER_DATABASE_NAME");
  const databaseUser = readEnvironmentValue("FLYCLOUDHELPER_DATABASE_USER");
  const databasePassword = readSecret(
    "FLYCLOUDHELPER_DATABASE_PASSWORD",
    "FLYCLOUDHELPER_DATABASE_PASSWORD_FILE",
  ).value;
  const missingFields = [
    ["FLYCLOUDHELPER_DATABASE_HOST", databaseHost],
    ["FLYCLOUDHELPER_DATABASE_NAME", databaseName],
    ["FLYCLOUDHELPER_DATABASE_USER", databaseUser],
    ["FLYCLOUDHELPER_DATABASE_PASSWORD", databasePassword],
  ].filter(([, value]) => !value).map(([name]) => name);
  if (missingFields.length > 0) {
    throw new Error(`${databaseType} 模式缺少数据库配置：${missingFields.join("、")}`);
  }

  const connectionUrl = new URL(databaseType === "postgres" ? "postgresql://localhost" : "mysql://localhost");
  connectionUrl.hostname = databaseHost!;
  connectionUrl.port = String(readPositiveInteger(
    "FLYCLOUDHELPER_DATABASE_PORT",
    databaseType === "postgres" ? 5432 : 3306,
  ));
  connectionUrl.username = databaseUser!;
  connectionUrl.password = databasePassword!;
  connectionUrl.pathname = `/${validateDatabaseName(databaseName!)}`;
  return connectionUrl.toString();
}

/** 兼容完整连接 URL，并在未配置 URL 时读取拆分数据库字段。 */
function resolveDatabaseUrl(databaseType: DatabaseType): string | null {
  if (databaseType === "sqlite") {
    return null;
  }
  const databaseSecret = readSecret(
    "FLYCLOUDHELPER_DATABASE_URL",
    "FLYCLOUDHELPER_DATABASE_URL_FILE",
  );
  return databaseSecret.value || buildSeparatedDatabaseUrl(databaseType);
}

/** 加载并校验 API、数据库、Worker 和 Secret 运行配置。 */
export function loadApiConfig(): ApiConfig {
  const databaseType = readDatabaseType();
  const databaseUrl = resolveDatabaseUrl(databaseType);
  const credentialSecret = loadOrCreateCredentialMasterKey();
  const acoustidSecret = readSecret(
    "FLYCLOUDHELPER_ACOUSTID_API_KEY",
    "FLYCLOUDHELPER_ACOUSTID_API_KEY_FILE",
  );
  const huaweiBindingProofSecret = readSecret(
    "FLYCLOUDHELPER_HUAWEI_BINDING_PROOF_SECRET",
    "FLYCLOUDHELPER_HUAWEI_BINDING_PROOF_SECRET_FILE",
  );

  return {
    host: readEnvironmentValue("FLYCLOUDHELPER_API_HOST") || "0.0.0.0",
    port: readPositiveInteger("FLYCLOUDHELPER_API_PORT", 9934),
    publicBaseUrlOverride: readEnvironmentValue("FLYCLOUDHELPER_PUBLIC_BASE_URL")
      ? validateConfiguredPublicBaseUrl(readEnvironmentValue("FLYCLOUDHELPER_PUBLIC_BASE_URL") as string)
      : null,
    databaseType,
    sqlitePath: resolveSqlitePath(),
    databaseUrl,
    databaseAutoCreate: readBoolean("FLYCLOUDHELPER_DATABASE_AUTO_CREATE", true),
    webSessionTtlSeconds: readPositiveInteger(
      "FLYCLOUDHELPER_WEB_SESSION_TTL_SECONDS",
      30 * 24 * 60 * 60,
    ),
    accessTokenTtlSeconds: readPositiveInteger(
      "FLYCLOUDHELPER_ACCESS_TOKEN_TTL_SECONDS",
      60 * 60,
    ),
    refreshTokenTtlSeconds: readPositiveInteger(
      "FLYCLOUDHELPER_REFRESH_TOKEN_TTL_SECONDS",
      30 * 24 * 60 * 60,
    ),
    cookieSecure: readBoolean("FLYCLOUDHELPER_COOKIE_SECURE", false),
    credentialMasterKey: credentialSecret.value,
    credentialKeyFingerprint: credentialSecret.fingerprint,
    credentialKeySource: credentialSecret.source,
    credentialKeyGeneratedNow: credentialSecret.generatedNow,
    credentialKeyFilePath: credentialSecret.filePath,
    tmdbPerKeyConcurrency: readPositiveInteger("FLYCLOUDHELPER_TMDB_PER_KEY_CONCURRENCY", 1),
    tmdbMaxConcurrency: readPositiveInteger("FLYCLOUDHELPER_TMDB_MAX_CONCURRENCY", 32),
    musicbrainzUserAgent: readEnvironmentValue("FLYCLOUDHELPER_MUSICBRAINZ_USER_AGENT")
      || "FlyCloudHelper/0.1.5 (self-hosted)",
    acoustidApiKey: acoustidSecret.value,
    fpcalcPath: readEnvironmentValue("FLYCLOUDHELPER_FPCALC_PATH") || null,
    workerEnabled: readBoolean("FLYCLOUDHELPER_WORKER_ENABLED", true),
    workerConcurrency: readPositiveInteger("FLYCLOUDHELPER_WORKER_CONCURRENCY", 5),
    workerPollIntervalMs: readPositiveInteger("FLYCLOUDHELPER_WORKER_POLL_INTERVAL_MS", 1000),
    ffprobePath: readEnvironmentValue("FLYCLOUDHELPER_FFPROBE_PATH") || "ffprobe",
    mediaProbeConcurrency: readPositiveInteger("FLYCLOUDHELPER_MEDIA_PROBE_CONCURRENCY", 1),
    mediaProbePollIntervalMs: readPositiveInteger("FLYCLOUDHELPER_MEDIA_PROBE_POLL_INTERVAL_MS", 2000),
    ffprobeTimeoutMs: readPositiveInteger("FLYCLOUDHELPER_FFPROBE_TIMEOUT_MS", 60_000),
    ffprobeAnalyzeDurationUs: readPositiveInteger("FLYCLOUDHELPER_FFPROBE_ANALYZE_DURATION_US", 10_000_000),
    ffprobeProbeSizeBytes: readPositiveInteger("FLYCLOUDHELPER_FFPROBE_PROBE_SIZE_BYTES", 10 * 1024 * 1024),
    pluginDirectory: resolveProjectPath(readEnvironmentValue("FLYCLOUDHELPER_PLUGIN_DIR"), "data/plugins"),
    exportDirectory: resolveProjectPath(readEnvironmentValue("FLYCLOUDHELPER_EXPORT_DIR"), "data/exports"),
    migrationDirectory: resolveProjectPath(
      readEnvironmentValue("FLYCLOUDHELPER_MIGRATION_DIR"),
      "data/migrations",
    ),
    webDistDirectory: resolveProjectPath(readEnvironmentValue("FLYCLOUDHELPER_WEB_DIST_DIR"), "web/dist"),
    allowInsecureProviderHttp: readBoolean("FLYCLOUDHELPER_ALLOW_INSECURE_HTTP", true),
    pluginMaxBytes: readPositiveInteger("FLYCLOUDHELPER_PLUGIN_MAX_BYTES", 10 * 1024 * 1024),
    pluginMaxFiles: readPositiveInteger("FLYCLOUDHELPER_PLUGIN_MAX_FILES", 100),
    migrationChunkMaxBytes: readPositiveInteger(
      "FLYCLOUDHELPER_MIGRATION_CHUNK_MAX_BYTES",
      8 * 1024 * 1024,
    ),
    migrationSnapshotMaxBytes: readPositiveInteger(
      "FLYCLOUDHELPER_MIGRATION_SNAPSHOT_MAX_BYTES",
      2 * 1024 * 1024 * 1024,
    ),
    huaweiBindingProofSecret: huaweiBindingProofSecret.value,
  };
}
