import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import yauzl, { type Entry, type ZipFile } from "yauzl";
import type { ApiConfig } from "./config.js";
import type { FlyCloudHelperDatabase } from "./database.js";
import type { PluginVersionRecord } from "./domain.js";
import { parseJsonObject } from "./domain.js";
import { ApiError, validationError } from "./errors.js";
import type { CredentialVault } from "./secrets.js";
import { validateProviderUrl } from "./providers/network.js";

const allowedMediaTypes = new Set(["video", "music", "audiobook"]);
const allowedConfigurationTypes = new Set(["string", "secret", "number", "boolean", "select"]);
const prohibitedExtensions = new Set([
  ".js", ".mjs", ".cjs", ".ts", ".ets", ".py", ".java", ".kt", ".kts", ".sh",
  ".bash", ".zsh", ".so", ".dll", ".dylib", ".exe", ".bin", ".jar", ".har", ".hsp",
  ".html", ".htm", ".svg",
]);

interface PluginManifest extends Record<string, unknown> {
  id: string;
  name: string;
  version: string;
  protocolVersion: number;
  pluginType: "media_metadata";
  mediaTypes: string[];
  allowedHosts: string[];
  configurationSchema?: Array<Record<string, unknown>>;
}

export interface PluginTaskSnapshot {
  pluginId: string;
  version: string;
  sha256: string;
  configurationRevision: number;
}

export interface PluginMetadataQuery {
  mediaType: "video" | "music" | "audiobook";
  title: string;
  subtitle: string;
  year: number | null;
  artist?: string;
  album?: string;
}

export interface PluginMetadataResult {
  title: string;
  subtitle: string;
  year: number | null;
  overview: string;
  posterUrl: string | null;
  backdropUrl: string | null;
  externalId: string | null;
  metadata: Record<string, unknown>;
}

/** 打开 ZIP 并返回可等待的句柄。 */
function openZip(archivePath: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true, autoClose: true }, (error, zipFile) => {
      if (error || !zipFile) {
        reject(error ?? new Error("插件压缩包无法打开"));
        return;
      }
      resolve(zipFile);
    });
  });
}

/** 打开单个 ZIP 文件流。 */
function openEntryStream(zipFile: ZipFile, entry: Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(error ?? new Error("插件文件无法读取"));
        return;
      }
      resolve(stream);
    });
  });
}

/** 校验压缩包路径不会逃逸目标目录。 */
function validateArchivePath(fileName: string): string {
  if (!fileName || fileName.includes("\\") || path.posix.isAbsolute(fileName)) {
    throw new ApiError(415, "plugin_path_invalid", "插件包含非法文件路径");
  }
  const normalized = path.posix.normalize(fileName);
  if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new ApiError(415, "plugin_path_invalid", "插件包含目录穿越路径");
  }
  return normalized;
}

/** 判断 ZIP Entry 是否为符号链接。 */
function isSymbolicLink(entry: Entry): boolean {
  const unixMode = (entry.externalFileAttributes >>> 16) & 0o170000;
  return unixMode === 0o120000;
}

/** 对导入 Manifest 执行声明式插件白名单校验。 */
function validateManifest(input: unknown): PluginManifest {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ApiError(415, "plugin_manifest_invalid", "插件 Manifest 格式无效");
  }
  const manifest = input as Record<string, unknown>;
  const id = typeof manifest.id === "string" ? manifest.id.trim() : "";
  const name = typeof manifest.name === "string" ? manifest.name.trim() : "";
  const version = typeof manifest.version === "string" ? manifest.version.trim() : "";
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/u.test(id)) {
    throw validationError("manifest.id", "插件 ID 必须是 3 到 64 位小写字母、数字、点、横线或下划线");
  }
  if (!name || [...name].length > 100) {
    throw validationError("manifest.name", "插件名称不能为空且不能超过 100 个字符");
  }
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(version)) {
    throw validationError("manifest.version", "插件版本必须使用 SemVer 格式");
  }
  if (manifest.protocolVersion !== 1 || manifest.pluginType !== "media_metadata") {
    throw new ApiError(422, "plugin_protocol_not_supported", "只支持协议版本 1 的 media_metadata 声明式插件");
  }
  const mediaTypes = Array.isArray(manifest.mediaTypes)
    ? manifest.mediaTypes.filter((item): item is string => typeof item === "string")
    : [];
  if (mediaTypes.length === 0 || mediaTypes.some((item) => !allowedMediaTypes.has(item))) {
    throw validationError("manifest.mediaTypes", "插件媒体类型配置无效");
  }
  const allowedHosts = Array.isArray(manifest.allowedHosts)
    ? manifest.allowedHosts.filter((item): item is string => typeof item === "string")
    : [];
  for (const host of allowedHosts) {
    if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/iu.test(host)) {
      throw validationError("manifest.allowedHosts", `插件允许域名格式无效：${host}`);
    }
  }
  const requestTemplates = manifest.requestTemplates;
  if (!requestTemplates || typeof requestTemplates !== "object" || Array.isArray(requestTemplates)) {
    throw validationError("manifest.requestTemplates", "插件必须声明按媒体类型区分的请求模板");
  }
  for (const mediaType of mediaTypes) {
    const template = (requestTemplates as Record<string, unknown>)[mediaType];
    if (!template || typeof template !== "object" || Array.isArray(template)) {
      throw validationError("manifest.requestTemplates", `插件缺少 ${mediaType} 请求模板`);
    }
    const templateRecord = template as Record<string, unknown>;
    if (templateRecord.method !== "GET" && templateRecord.method !== "POST") {
      throw validationError("manifest.requestTemplates", "插件请求方法只支持 GET 或 POST");
    }
    let requestUrl: URL;
    try {
      requestUrl = new URL(String(templateRecord.url ?? ""));
    } catch {
      throw validationError("manifest.requestTemplates", "插件请求 URL 格式无效");
    }
    if (requestUrl.protocol !== "https:" || requestUrl.username || requestUrl.password || !allowedHosts.includes(requestUrl.hostname)) {
      throw validationError("manifest.requestTemplates", "插件请求 URL 必须使用 HTTPS 且主机位于 allowedHosts");
    }
  }
  const responseMappings = manifest.responseMappings;
  if (!responseMappings || typeof responseMappings !== "object" || Array.isArray(responseMappings)) {
    throw validationError("manifest.responseMappings", "插件必须声明响应字段映射");
  }
  const schema = Array.isArray(manifest.configurationSchema)
    ? manifest.configurationSchema as Array<Record<string, unknown>>
    : [];
  const names = new Set<string>();
  for (const field of schema) {
    const fieldName = typeof field.name === "string" ? field.name : "";
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(fieldName) || names.has(fieldName)) {
      throw validationError("manifest.configurationSchema", "插件配置字段名称无效或重复");
    }
    names.add(fieldName);
    if (!allowedConfigurationTypes.has(String(field.type))) {
      throw validationError("manifest.configurationSchema", `插件配置字段类型无效：${fieldName}`);
    }
  }
  return {
    ...manifest,
    id,
    name,
    version,
    protocolVersion: 1,
    pluginType: "media_metadata",
    mediaTypes,
    allowedHosts,
    configurationSchema: schema,
  };
}

/** 把数据库插件行转换为不含 Secret 的管理 DTO。 */
function mapPlugin(row: Record<string, unknown>): PluginVersionRecord {
  return {
    pluginId: String(row.plugin_id),
    version: String(row.version),
    displayName: String(row.display_name),
    status: row.status as PluginVersionRecord["status"],
    sha256: String(row.sha256),
    manifest: parseJsonObject(row.manifest_json),
    configurationRevision: Number(row.configuration_revision ?? 0),
    configurationState: parseJsonObject(row.configuration_state_json) as Record<string, boolean>,
    installedPath: String(row.installed_path),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/** 管理只包含声明文件和静态资源的受限元数据插件。 */
export class MetadataPluginManager {
  private readonly database: FlyCloudHelperDatabase;
  private readonly config: ApiConfig;
  private readonly vault: CredentialVault;

  public constructor(database: FlyCloudHelperDatabase, config: ApiConfig, vault: CredentialVault) {
    this.database = database;
    this.config = config;
    this.vault = vault;
  }

  /** 流式接收完成后校验、解压并安装一个不可覆盖的插件版本。 */
  public async importArchive(archivePath: string): Promise<PluginVersionRecord> {
    const digest = createHash("sha256");
    const archiveStream = fs.createReadStream(archivePath);
    for await (const chunk of archiveStream) {
      digest.update(chunk as Buffer);
    }
    const sha256 = digest.digest("hex");
    const incomingRoot = path.join(this.config.pluginDirectory, ".incoming");
    await fsPromises.mkdir(incomingRoot, { recursive: true });
    const extractionPath = await fsPromises.mkdtemp(path.join(incomingRoot, "plugin-"));
    try {
      const extraction = await this.extractArchive(archivePath, extractionPath);
      const manifestPath = path.join(extractionPath, "manifest.json");
      const manifestText = await fsPromises.readFile(manifestPath, "utf8").catch(() => "");
      if (!manifestText || Buffer.byteLength(manifestText) > 1024 * 1024) {
        throw new ApiError(415, "plugin_manifest_missing", "插件必须包含有效的 manifest.json");
      }
      let manifestInput: unknown;
      try {
        manifestInput = JSON.parse(manifestText);
      } catch {
        throw new ApiError(415, "plugin_manifest_invalid", "插件 Manifest 不是有效 JSON");
      }
      const manifest = validateManifest(manifestInput);
      const exists = await this.database.query("metadata_plugin_versions")
        .where({ plugin_id: manifest.id, version: manifest.version })
        .first();
      if (exists) {
        throw new ApiError(409, "plugin_version_conflict", "相同插件版本已经存在，不能覆盖安装");
      }
      const finalPath = path.join(this.config.pluginDirectory, manifest.id, manifest.version);
      await fsPromises.mkdir(path.dirname(finalPath), { recursive: true });
      try {
        await fsPromises.rename(extractionPath, finalPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new ApiError(409, "plugin_version_conflict", "相同插件版本目录已经存在");
        }
        throw error;
      }
      const now = new Date().toISOString();
      try {
        await this.database.query("metadata_plugin_versions").insert({
          id: randomUUID(),
          plugin_id: manifest.id,
          version: manifest.version,
          display_name: manifest.name,
          status: "imported",
          sha256,
          manifest_json: JSON.stringify(manifest),
          installed_path: finalPath,
          configuration_revision: 0,
          created_at: now,
          updated_at: now,
        });
      } catch (error) {
        await fsPromises.rm(finalPath, { recursive: true, force: true });
        throw error;
      }
      const plugin = await this.getVersion(manifest.id, manifest.version);
      return {
        ...plugin,
        manifest: {
          ...plugin.manifest,
          preflight: {
            fileCount: extraction.fileCount,
            uncompressedBytes: extraction.uncompressedBytes,
          },
        },
      };
    } finally {
      await fsPromises.rm(extractionPath, { recursive: true, force: true });
    }
  }

  /** 逐 Entry 解压，并执行文件数、解压大小、路径、链接和扩展名限制。 */
  private async extractArchive(archivePath: string, destination: string): Promise<{ fileCount: number; uncompressedBytes: number }> {
    const zipFile = await openZip(archivePath);
    let fileCount = 0;
    let uncompressedBytes = 0;
    const paths = new Set<string>();
    return new Promise((resolve, reject) => {
      let processing = false;
      const fail = (error: unknown) => {
        zipFile.close();
        reject(error);
      };
      zipFile.on("error", fail);
      zipFile.on("end", () => {
        if (!processing) resolve({ fileCount, uncompressedBytes });
      });
      zipFile.on("entry", (entry: Entry) => {
        processing = true;
        void (async () => {
          const normalized = validateArchivePath(entry.fileName);
          if (paths.has(normalized)) {
            throw new ApiError(415, "plugin_duplicate_path", "插件包含重复文件路径");
          }
          paths.add(normalized);
          if (isSymbolicLink(entry)) {
            throw new ApiError(415, "plugin_symbolic_link", "插件不能包含符号链接");
          }
          if (normalized.endsWith("/")) {
            await fsPromises.mkdir(path.join(destination, normalized), { recursive: true });
          } else {
            fileCount += 1;
            uncompressedBytes += entry.uncompressedSize;
            if (fileCount > this.config.pluginMaxFiles) {
              throw new ApiError(413, "plugin_too_many_files", "插件文件数量超过限制");
            }
            if (uncompressedBytes > this.config.pluginMaxBytes * 5) {
              throw new ApiError(413, "plugin_uncompressed_too_large", "插件解压大小超过限制");
            }
            if (prohibitedExtensions.has(path.extname(normalized).toLowerCase())) {
              throw new ApiError(415, "plugin_executable_file", `插件包含禁止文件类型：${path.extname(normalized)}`);
            }
            const targetPath = path.join(destination, normalized);
            await fsPromises.mkdir(path.dirname(targetPath), { recursive: true });
            const readStream = await openEntryStream(zipFile, entry);
            await pipeline(readStream, fs.createWriteStream(targetPath, { mode: 0o600 }));
          }
          processing = false;
          zipFile.readEntry();
        })().catch(fail);
      });
      zipFile.readEntry();
    });
  }

  /** 分页列出全部插件版本。 */
  public async listVersions(limit: number, offset: number): Promise<{ items: PluginVersionRecord[]; total: number }> {
    const [rows, countRow] = await Promise.all([
      this.database.query("metadata_plugin_versions as p")
        .leftJoin("metadata_plugin_configurations as c", function joinCurrentConfiguration() {
          this.on("c.plugin_id", "=", "p.plugin_id")
            .andOn("c.version", "=", "p.version")
            .andOn("c.revision", "=", "p.configuration_revision");
        })
        .select("p.*", "c.configuration_state_json")
        .orderBy("p.updated_at", "desc")
        .limit(limit)
        .offset(offset),
      this.database.query("metadata_plugin_versions").count<{ count: string | number }[]>({ count: "id" }).first(),
    ]);
    return { items: rows.map(mapPlugin), total: Number(countRow?.count ?? 0) };
  }

  /** 查询指定插件版本和当前配置状态。 */
  public async getVersion(pluginId: string, version: string): Promise<PluginVersionRecord> {
    const row = await this.database.query("metadata_plugin_versions as p")
      .leftJoin("metadata_plugin_configurations as c", function joinCurrentConfiguration() {
        this.on("c.plugin_id", "=", "p.plugin_id")
          .andOn("c.version", "=", "p.version")
          .andOn("c.revision", "=", "p.configuration_revision");
      })
      .select("p.*", "c.configuration_state_json")
      .where("p.plugin_id", pluginId)
      .where("p.version", version)
      .first();
    if (!row) {
      throw new ApiError(404, "plugin_not_found", "插件版本不存在");
    }
    return mapPlugin(row);
  }

  /** 校验并保存新的实例级配置修订，Secret 只写不读。 */
  public async saveConfiguration(pluginId: string, version: string, input: Record<string, unknown>): Promise<PluginVersionRecord> {
    const plugin = await this.getVersion(pluginId, version);
    const schema = Array.isArray(plugin.manifest.configurationSchema)
      ? plugin.manifest.configurationSchema as Array<Record<string, unknown>>
      : [];
    const current = plugin.configurationRevision > 0
      ? await this.database.query("metadata_plugin_configurations").where({
        plugin_id: pluginId,
        version,
        revision: plugin.configurationRevision,
      }).first()
      : null;
    const publicConfiguration = parseJsonObject(current?.configuration_json);
    const secretConfiguration = current?.encrypted_secrets
      ? this.vault.decrypt(String(current.encrypted_secrets))
      : {};
    const configurationState: Record<string, boolean> = {};
    for (const field of schema) {
      const name = String(field.name);
      const type = String(field.type);
      const supplied = input[name];
      if (type === "secret") {
        if (typeof supplied === "string" && supplied.length > 0) {
          secretConfiguration[name] = supplied;
        }
        configurationState[name] = typeof secretConfiguration[name] === "string" && String(secretConfiguration[name]).length > 0;
      } else if (supplied !== undefined) {
        publicConfiguration[name] = this.validateConfigurationValue(field, supplied);
        configurationState[name] = true;
      } else {
        configurationState[name] = publicConfiguration[name] !== undefined;
      }
      if (field.required === true && !configurationState[name]) {
        throw validationError(name, `插件配置 ${name} 为必填项`);
      }
    }
    const revision = plugin.configurationRevision + 1;
    const now = new Date().toISOString();
    await this.database.query.transaction(async (transaction) => {
      await transaction("metadata_plugin_configurations").insert({
        id: randomUUID(),
        plugin_id: pluginId,
        version,
        revision,
        configuration_json: JSON.stringify(publicConfiguration),
        encrypted_secrets: Object.keys(secretConfiguration).length > 0 ? this.vault.encrypt(secretConfiguration) : null,
        configuration_state_json: JSON.stringify(configurationState),
        created_at: now,
      });
      await transaction("metadata_plugin_versions").where({ plugin_id: pluginId, version }).update({
        configuration_revision: revision,
        updated_at: now,
      });
    });
    return this.getVersion(pluginId, version);
  }

  /** 只校验待提交配置，不持久化且不返回 Secret。 */
  public async validateConfiguration(pluginId: string, version: string, input: Record<string, unknown>): Promise<void> {
    const plugin = await this.getVersion(pluginId, version);
    const schema = Array.isArray(plugin.manifest.configurationSchema)
      ? plugin.manifest.configurationSchema as Array<Record<string, unknown>>
      : [];
    for (const field of schema) {
      const name = String(field.name);
      const value = input[name];
      const hasCurrentValue = plugin.configurationState[name] === true;
      if (String(field.type) === "secret") {
        if (value !== undefined && (typeof value !== "string" || value.length > 2000)) {
          throw validationError(name, `${name} 必须是长度不超过 2000 的字符串`);
        }
        if (field.required === true && !hasCurrentValue && !(typeof value === "string" && value.length > 0)) {
          throw validationError(name, `插件配置 ${name} 为必填项`);
        }
      } else if (value !== undefined) {
        this.validateConfigurationValue(field, value);
      } else if (field.required === true && !hasCurrentValue) {
        throw validationError(name, `插件配置 ${name} 为必填项`);
      }
    }
  }

  /** 从服务元数据 Profile 冻结新任务实际使用的插件版本和配置修订。 */
  public async buildTaskSnapshots(metadataProfile: Record<string, unknown>): Promise<PluginTaskSnapshot[]> {
    const providerIds = new Set<string>();
    let includeAutomaticMusicPlugins = false;
    const profiles = metadataProfile.profiles && typeof metadataProfile.profiles === "object" && !Array.isArray(metadataProfile.profiles)
      ? metadataProfile.profiles as Record<string, unknown>
      : {};
    for (const [mediaType, profileValue] of Object.entries(profiles)) {
      if (!profileValue || typeof profileValue !== "object" || Array.isArray(profileValue)) continue;
      const profile = profileValue as Record<string, unknown>;
      if (mediaType === "music" && profile.providerId === "auto") {
        includeAutomaticMusicPlugins = true;
      }
      for (const fieldName of ["providerId", "retryProviderId"]) {
        const providerId = profile[fieldName];
        if (typeof providerId === "string" && providerId.startsWith("plugin:")) {
          providerIds.add(providerId.slice("plugin:".length));
        }
      }
    }
    const snapshots: PluginTaskSnapshot[] = [];
    for (const reference of providerIds) {
      const separator = reference.lastIndexOf("@");
      const pluginId = separator > 0 ? reference.slice(0, separator) : reference;
      const requestedVersion = separator > 0 ? reference.slice(separator + 1) : null;
      const query = this.database.query("metadata_plugin_versions")
        .where({ plugin_id: pluginId, status: "enabled" });
      if (requestedVersion) query.where({ version: requestedVersion });
      const row = await query.orderBy("updated_at", "desc").first();
      if (!row) {
        throw new ApiError(422, "metadata_plugin_unavailable", `元数据插件不可用：${pluginId}`);
      }
      snapshots.push({
        pluginId,
        version: String(row.version),
        sha256: String(row.sha256),
        configurationRevision: Number(row.configuration_revision ?? 0),
      });
    }
    if (includeAutomaticMusicPlugins) {
      const enabledRows = await this.database.query("metadata_plugin_versions")
        .where({ status: "enabled" })
        .orderBy("updated_at", "desc");
      for (const row of enabledRows) {
        const manifest = parseJsonObject(row.manifest_json);
        const mediaTypes = Array.isArray(manifest.mediaTypes) ? manifest.mediaTypes : [];
        if (!mediaTypes.includes("music") || snapshots.some((item) => item.pluginId === String(row.plugin_id))) continue;
        snapshots.push({
          pluginId: String(row.plugin_id),
          version: String(row.version),
          sha256: String(row.sha256),
          configurationRevision: Number(row.configuration_revision ?? 0),
        });
      }
    }
    return snapshots;
  }

  /** 在受限声明式宿主中执行一次元数据查询。 */
  public async scrape(
    snapshot: PluginTaskSnapshot,
    query: PluginMetadataQuery,
    signal?: AbortSignal,
  ): Promise<PluginMetadataResult | null> {
    const plugin = await this.database.query("metadata_plugin_versions")
      .where({ plugin_id: snapshot.pluginId, version: snapshot.version, sha256: snapshot.sha256 })
      .first();
    if (!plugin) throw new ApiError(410, "plugin_snapshot_unavailable", "任务引用的插件版本已经不可用");
    const manifest = validateManifest(JSON.parse(String(plugin.manifest_json)) as unknown);
    const configurationRow = snapshot.configurationRevision > 0
      ? await this.database.query("metadata_plugin_configurations").where({
        plugin_id: snapshot.pluginId,
        version: snapshot.version,
        revision: snapshot.configurationRevision,
      }).first()
      : null;
    if (snapshot.configurationRevision > 0 && !configurationRow) {
      throw new ApiError(410, "plugin_configuration_unavailable", "任务引用的插件配置已经不可用");
    }
    const configuration = {
      ...parseJsonObject(configurationRow?.configuration_json),
      ...(configurationRow?.encrypted_secrets ? this.vault.decrypt(String(configurationRow.encrypted_secrets)) : {}),
    };
    const requestTemplates = manifest.requestTemplates as Record<string, Record<string, unknown>>;
    const template = requestTemplates[query.mediaType];
    if (!template) return null;
    const requestUrl = new URL(this.renderTemplate(String(template.url), query, configuration));
    if (!manifest.allowedHosts.includes(requestUrl.hostname)) {
      throw new ApiError(422, "plugin_host_not_allowed", "插件请求主机不在允许列表");
    }
    await validateProviderUrl(requestUrl.href, { allowInsecureHttp: false });
    const method = template.method === "POST" ? "POST" : "GET";
    const headers = this.renderRecord(template.headers, query, configuration);
    // 请求头名称不区分大小写，统一按小写比较可避免插件通过混合大小写覆盖受保护请求头。
    const forbiddenHeaders = new Set(["host", "cookie", "content-length", "x-forwarded-for", "x-forwarded-host"]);
    for (const headerName of Object.keys(headers)) {
      if (forbiddenHeaders.has(headerName.toLowerCase())) delete headers[headerName];
    }
    const renderedQuery = this.renderRecord(template.query, query, configuration);
    Object.entries(renderedQuery).forEach(([key, value]) => requestUrl.searchParams.set(key, value));
    const requestController = new AbortController();
    const timeout = setTimeout(() => requestController.abort(), 15_000);
    const abortParent = () => requestController.abort();
    signal?.addEventListener("abort", abortParent, { once: true });
    try {
      const bodyValue = template.body && typeof template.body === "object"
        ? this.renderJsonValue(template.body, query, configuration)
        : undefined;
      const response = await fetch(requestUrl, {
        method,
        headers: {
          Accept: "application/json",
          ...(bodyValue ? { "Content-Type": "application/json" } : {}),
          ...headers,
        },
        body: bodyValue ? JSON.stringify(bodyValue) : undefined,
        redirect: "error",
        signal: requestController.signal,
      });
      if (!response.ok) return null;
      const responseLength = Number(response.headers.get("content-length") ?? 0);
      if (responseLength > 1024 * 1024) throw new ApiError(413, "plugin_response_too_large", "插件响应超过大小限制");
      const responseText = await response.text();
      if (Buffer.byteLength(responseText) > 1024 * 1024) throw new ApiError(413, "plugin_response_too_large", "插件响应超过大小限制");
      const payload = JSON.parse(responseText) as unknown;
      const mappings = manifest.responseMappings as Record<string, Record<string, unknown>>;
      return this.mapPluginResponse(payload, mappings[query.mediaType]);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      return null;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortParent);
    }
  }

  /** 只替换白名单查询和配置变量，不提供表达式执行能力。 */
  private renderTemplate(template: string, query: PluginMetadataQuery, configuration: Record<string, unknown>): string {
    return template.replace(/\{\{(query|config)\.([A-Za-z][A-Za-z0-9_]*)\}\}/gu, (_match, scope: string, name: string) => {
      const source = scope === "query" ? query as unknown as Record<string, unknown> : configuration;
      const value = source[name];
      return value === null || value === undefined ? "" : String(value);
    });
  }

  /** 渲染字符串键值对象，非字符串值被拒绝。 */
  private renderRecord(value: unknown, query: PluginMetadataQuery, configuration: Record<string, unknown>): Record<string, string> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => {
      if (typeof item !== "string") throw validationError("requestTemplates", "插件请求头和查询参数必须是字符串");
      return [key, this.renderTemplate(item, query, configuration)];
    }));
  }

  /** 递归渲染 JSON 请求体，同时限制嵌套深度。 */
  private renderJsonValue(value: unknown, query: PluginMetadataQuery, configuration: Record<string, unknown>, depth = 0): unknown {
    if (depth > 8) throw validationError("requestTemplates", "插件请求体嵌套过深");
    if (typeof value === "string") return this.renderTemplate(value, query, configuration);
    if (Array.isArray(value)) return value.map((item) => this.renderJsonValue(item, query, configuration, depth + 1));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        this.renderJsonValue(item, query, configuration, depth + 1),
      ]));
    }
    return value;
  }

  /** 按点路径读取 JSON 值，不执行脚本或 JSONPath 表达式。 */
  private readPath(value: unknown, dottedPath: string): unknown {
    if (!dottedPath) return value;
    return dottedPath.split(".").reduce<unknown>((current, segment) => {
      if (Array.isArray(current) && /^\d+$/u.test(segment)) return current[Number(segment)];
      if (current && typeof current === "object" && !Array.isArray(current)) return (current as Record<string, unknown>)[segment];
      return undefined;
    }, value);
  }

  /** 把插件 JSON 响应映射为统一元数据结果。 */
  private mapPluginResponse(payload: unknown, mapping: Record<string, unknown> | undefined): PluginMetadataResult | null {
    if (!mapping) return null;
    const itemsValue = this.readPath(payload, String(mapping.itemsPath ?? ""));
    const candidate = Array.isArray(itemsValue) ? itemsValue[0] : itemsValue;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
    const fields = mapping.fields && typeof mapping.fields === "object" && !Array.isArray(mapping.fields)
      ? mapping.fields as Record<string, unknown>
      : {};
    const readField = (name: string): unknown => {
      const fieldPath = fields[name];
      return typeof fieldPath === "string" ? this.readPath(candidate, fieldPath) : undefined;
    };
    const title = readField("title");
    if (typeof title !== "string" || !title.trim()) return null;
    const yearValue = Number(readField("year"));
    const externalId = readField("externalId");
    return {
      title: title.trim(),
      subtitle: typeof readField("subtitle") === "string" ? String(readField("subtitle")) : "",
      year: Number.isInteger(yearValue) && yearValue > 0 ? yearValue : null,
      overview: typeof readField("overview") === "string" ? String(readField("overview")) : "",
      posterUrl: typeof readField("posterUrl") === "string" ? String(readField("posterUrl")) : null,
      backdropUrl: typeof readField("backdropUrl") === "string" ? String(readField("backdropUrl")) : null,
      externalId: typeof externalId === "string" || typeof externalId === "number" ? String(externalId) : null,
      metadata: { pluginFields: Object.keys(fields) },
    };
  }

  /** 按 Manifest 字段类型校验非 Secret 配置值。 */
  private validateConfigurationValue(field: Record<string, unknown>, value: unknown): unknown {
    const name = String(field.name);
    const type = String(field.type);
    if (type === "boolean" && typeof value !== "boolean") {
      throw validationError(name, `${name} 必须是布尔值`);
    }
    if (type === "number") {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw validationError(name, `${name} 必须是数字`);
      }
      if (typeof field.min === "number" && value < field.min) throw validationError(name, `${name} 小于最小值`);
      if (typeof field.max === "number" && value > field.max) throw validationError(name, `${name} 大于最大值`);
    }
    if ((type === "string" || type === "select") && typeof value !== "string") {
      throw validationError(name, `${name} 必须是字符串`);
    }
    if (type === "string" && typeof value === "string" && [...value].length > 2000) {
      throw validationError(name, `${name} 长度超过限制`);
    }
    if (type === "select" && Array.isArray(field.options) && !field.options.includes(value)) {
      throw validationError(name, `${name} 不在允许选项内`);
    }
    return value;
  }

  /** 启用或停用插件版本；同一插件只有一个版本可启用。 */
  public async setStatus(pluginId: string, version: string, status: "enabled" | "disabled"): Promise<PluginVersionRecord> {
    const plugin = await this.getVersion(pluginId, version);
    if (status === "enabled") {
      const schema = Array.isArray(plugin.manifest.configurationSchema) ? plugin.manifest.configurationSchema : [];
      const hasRequiredFields = schema.some((field) => field && typeof field === "object" && (field as Record<string, unknown>).required === true);
      if (hasRequiredFields && plugin.configurationRevision === 0) {
        throw new ApiError(409, "plugin_configuration_required", "插件必须先完成必填配置");
      }
    }
    await this.database.query.transaction(async (transaction) => {
      if (status === "enabled") {
        await transaction("metadata_plugin_versions").where({ plugin_id: pluginId, status: "enabled" }).update({
          status: "disabled",
          updated_at: new Date().toISOString(),
        });
      }
      await transaction("metadata_plugin_versions").where({ plugin_id: pluginId, version }).update({
        status,
        updated_at: new Date().toISOString(),
      });
    });
    return this.getVersion(pluginId, version);
  }

  /** 删除未启用且未被任务快照引用的插件版本。 */
  public async deleteVersion(pluginId: string, version: string): Promise<void> {
    const plugin = await this.getVersion(pluginId, version);
    if (plugin.status === "enabled") {
      throw new ApiError(409, "plugin_enabled", "启用中的插件不能删除");
    }
    const referenced = await this.database.query("scan_jobs")
      .whereLike("snapshot_json", `%\"pluginId\":\"${pluginId}\"%`)
      .whereLike("snapshot_json", `%\"version\":\"${version}\"%`)
      .first();
    if (referenced) {
      throw new ApiError(409, "plugin_in_use", "插件版本仍被历史任务引用");
    }
    await this.database.query.transaction(async (transaction) => {
      await transaction("metadata_plugin_configurations").where({ plugin_id: pluginId, version }).delete();
      await transaction("metadata_plugin_versions").where({ plugin_id: pluginId, version }).delete();
    });
    await fsPromises.rm(plugin.installedPath, { recursive: true, force: true });
  }
}
