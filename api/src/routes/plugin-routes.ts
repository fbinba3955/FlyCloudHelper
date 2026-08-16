import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import { ApiError } from "../errors.js";
import { readPagination, requireConfirmation, requireObject, requireSuperAdmin } from "../http.js";
import type { ApiRuntime } from "../runtime.js";

/** 写入插件管理审计，不包含配置值和上传内容。 */
async function auditPlugin(
  runtime: ApiRuntime,
  operator: { id: string; username: string },
  operationType: string,
  pluginId: string,
  version: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await runtime.database.addAudit({
    id: randomUUID(),
    operatorUserId: operator.id,
    operatorUsername: operator.username,
    operationType,
    targetType: "metadata_plugin",
    targetId: `${pluginId}@${version}`,
    result: "success",
    detail,
  });
}

/** 注册声明式元数据插件导入、配置、启停和删除接口。 */
export async function registerPluginRoutes(server: FastifyInstance, runtime: ApiRuntime): Promise<void> {
  server.get<{ Querystring: Record<string, unknown> }>("/api/v1/admin/plugins", async (request) => {
    await requireSuperAdmin(request, runtime.database);
    const pagination = readPagination(request.query);
    return runtime.plugins.listVersions(pagination.limit, pagination.offset);
  });

  server.post("/api/v1/admin/plugins/import", async (request, reply) => {
    const operator = await requireSuperAdmin(request, runtime.database);
    const part = await request.file({ limits: { fileSize: runtime.config.pluginMaxBytes, files: 1 } });
    if (!part) throw new ApiError(400, "plugin_file_required", "请选择插件文件");
    if (!part.filename.toLowerCase().endsWith(".flymby-plugin")) {
      part.file.resume();
      throw new ApiError(415, "plugin_file_type_invalid", "插件文件扩展名必须是 .flymby-plugin");
    }
    const incomingDirectory = path.join(runtime.config.pluginDirectory, ".uploads");
    await fsPromises.mkdir(incomingDirectory, { recursive: true });
    const temporaryDirectory = await fsPromises.mkdtemp(path.join(incomingDirectory, "upload-"));
    const archivePath = path.join(temporaryDirectory, "package.flymby-plugin");
    try {
      await pipeline(part.file, fs.createWriteStream(archivePath, { mode: 0o600 }));
      if (part.file.truncated) throw new ApiError(413, "plugin_too_large", "插件包超过大小限制");
      const plugin = await runtime.plugins.importArchive(archivePath);
      await auditPlugin(runtime, operator, "import_plugin", plugin.pluginId, plugin.version, { SHA256: plugin.sha256 });
      return reply.status(201).send({ plugin });
    } finally {
      await fsPromises.rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  server.get<{ Params: { pluginId: string; version: string } }>("/api/v1/admin/plugins/:pluginId/versions/:version", async (request) => {
    await requireSuperAdmin(request, runtime.database);
    return { plugin: await runtime.plugins.getVersion(request.params.pluginId, request.params.version) };
  });

  server.get<{ Params: { pluginId: string; version: string } }>("/api/v1/admin/plugins/:pluginId/versions/:version/configuration", async (request) => {
    await requireSuperAdmin(request, runtime.database);
    const plugin = await runtime.plugins.getVersion(request.params.pluginId, request.params.version);
    return {
      configurationSchema: plugin.manifest.configurationSchema ?? [],
      configurationRevision: plugin.configurationRevision,
      configurationState: plugin.configurationState,
    };
  });

  server.put<{ Params: { pluginId: string; version: string }; Body: Record<string, unknown> }>("/api/v1/admin/plugins/:pluginId/versions/:version/configuration", async (request) => {
    const operator = await requireSuperAdmin(request, runtime.database);
    const configuration = requireObject(request.body, "configuration", "插件配置");
    const plugin = await runtime.plugins.saveConfiguration(request.params.pluginId, request.params.version, configuration);
    await auditPlugin(runtime, operator, "configure_plugin", plugin.pluginId, plugin.version, { 配置修订: plugin.configurationRevision });
    return { plugin };
  });

  server.post<{ Params: { pluginId: string; version: string }; Body: Record<string, unknown> }>("/api/v1/admin/plugins/:pluginId/versions/:version/configuration/validate", async (request) => {
    await requireSuperAdmin(request, runtime.database);
    await runtime.plugins.validateConfiguration(
      request.params.pluginId,
      request.params.version,
      requireObject(request.body, "configuration", "插件配置"),
    );
    return { valid: true };
  });

  for (const action of ["enable", "disable"] as const) {
    server.post<{ Params: { pluginId: string; version: string } }>(`/api/v1/admin/plugins/:pluginId/versions/:version/${action}`, async (request) => {
      const operator = await requireSuperAdmin(request, runtime.database);
      const plugin = await runtime.plugins.setStatus(
        request.params.pluginId,
        request.params.version,
        action === "enable" ? "enabled" : "disabled",
      );
      await auditPlugin(runtime, operator, `${action}_plugin`, plugin.pluginId, plugin.version);
      return { plugin };
    });
  }

  server.delete<{ Params: { pluginId: string; version: string }; Body: Record<string, unknown> }>("/api/v1/admin/plugins/:pluginId/versions/:version", async (request, reply) => {
    const operator = await requireSuperAdmin(request, runtime.database);
    requireConfirmation(request.body, `${request.params.pluginId}@${request.params.version}`);
    await runtime.plugins.deleteVersion(request.params.pluginId, request.params.version);
    await auditPlugin(runtime, operator, "delete_plugin", request.params.pluginId, request.params.version);
    return reply.status(204).send();
  });
}
