import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { config as loadDotEnv } from "dotenv";

export type DatabaseType = "sqlite" | "postgres" | "mysql";

export interface ApiConfig {
  host: string;
  port: number;
  databaseType: DatabaseType;
  sqlitePath: string;
  databaseUrl: string | null;
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
  pluginDirectory: string;
  exportDirectory: string;
  webDistDirectory: string;
  allowInsecureProviderHttp: boolean;
  pluginMaxBytes: number;
  pluginMaxFiles: number;
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

/** 加载并校验 API、数据库、Worker 和 Secret 运行配置。 */
export function loadApiConfig(): ApiConfig {
  const databaseType = readDatabaseType();
  const databaseSecret = readSecret(
    "FLYCLOUDHELPER_DATABASE_URL",
    "FLYCLOUDHELPER_DATABASE_URL_FILE",
  );
  if (databaseType !== "sqlite" && !databaseSecret.value) {
    throw new Error(`${databaseType} 模式必须配置 FLYCLOUDHELPER_DATABASE_URL 或对应 Secret 文件`);
  }
  const credentialSecret = loadOrCreateCredentialMasterKey();
  const acoustidSecret = readSecret(
    "FLYCLOUDHELPER_ACOUSTID_API_KEY",
    "FLYCLOUDHELPER_ACOUSTID_API_KEY_FILE",
  );

  return {
    host: readEnvironmentValue("FLYCLOUDHELPER_API_HOST") || "0.0.0.0",
    port: readPositiveInteger("FLYCLOUDHELPER_API_PORT", 4174),
    databaseType,
    sqlitePath: resolveSqlitePath(),
    databaseUrl: databaseSecret.value,
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
      || "FlyCloudHelper/0.1.0 (self-hosted)",
    acoustidApiKey: acoustidSecret.value,
    fpcalcPath: readEnvironmentValue("FLYCLOUDHELPER_FPCALC_PATH") || null,
    workerEnabled: readBoolean("FLYCLOUDHELPER_WORKER_ENABLED", true),
    workerConcurrency: readPositiveInteger("FLYCLOUDHELPER_WORKER_CONCURRENCY", 2),
    workerPollIntervalMs: readPositiveInteger("FLYCLOUDHELPER_WORKER_POLL_INTERVAL_MS", 1000),
    pluginDirectory: resolveProjectPath(readEnvironmentValue("FLYCLOUDHELPER_PLUGIN_DIR"), "data/plugins"),
    exportDirectory: resolveProjectPath(readEnvironmentValue("FLYCLOUDHELPER_EXPORT_DIR"), "data/exports"),
    webDistDirectory: resolveProjectPath(readEnvironmentValue("FLYCLOUDHELPER_WEB_DIST_DIR"), "web/dist"),
    allowInsecureProviderHttp: readBoolean("FLYCLOUDHELPER_ALLOW_INSECURE_HTTP", true),
    pluginMaxBytes: readPositiveInteger("FLYCLOUDHELPER_PLUGIN_MAX_BYTES", 10 * 1024 * 1024),
    pluginMaxFiles: readPositiveInteger("FLYCLOUDHELPER_PLUGIN_MAX_FILES", 100),
  };
}
