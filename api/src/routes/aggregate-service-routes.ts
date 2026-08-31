import type { FastifyInstance } from "fastify";
import { requireRequestUser } from "../http.js";
import type { ApiRuntime } from "../runtime.js";

/** 注册当前用户单协议聚合服务的创建与读取接口。 */
export async function registerAggregateServiceRoutes(server: FastifyInstance, runtime: ApiRuntime): Promise<void> {
  server.get("/api/v1/aggregate-services", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    return { items: await runtime.aggregateServices.listByUser(user.id) };
  });

  server.post<{ Body: Record<string, unknown> }>("/api/v1/aggregate-services", async (request, reply) => {
    const user = await requireRequestUser(request, runtime.database);
    const createdAggregateService = await runtime.aggregateServices.create({
      userId: user.id,
      displayName: request.body.displayName,
      protocol: request.body.protocol,
      pathSuffix: request.body.pathSuffix,
      serviceIds: request.body.serviceIds,
      relayPlaybackEnabled: request.body.relayPlaybackEnabled,
      downloadEnabled: request.body.downloadEnabled,
      regionLibrariesEnabled: request.body.regionLibrariesEnabled,
    });
    await runtime.aggregateAccess.createInitialAccount(createdAggregateService.id, user.id);
    const indexJobId = await runtime.aggregateIndex.enqueue(createdAggregateService.id, user.id, "initial");
    const aggregateService = await runtime.aggregateServices.getById(createdAggregateService.id, user.id);
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-aggregate-service",
      事件: "创建单协议聚合服务",
      用户ID: user.id,
      聚合服务ID: aggregateService.id,
      聚合协议: aggregateService.protocol,
      成员数量: aggregateService.members.length,
      地址后缀: aggregateService.pathSuffix,
      索引任务ID: indexJobId,
    });
    return reply.status(201).send({ aggregateService });
  });

  server.get<{ Params: { aggregateServiceId: string } }>(
    "/api/v1/aggregate-services/:aggregateServiceId",
    async (request) => {
      const user = await requireRequestUser(request, runtime.database);
      return {
        aggregateService: await runtime.aggregateServices.getById(request.params.aggregateServiceId, user.id),
      };
    },
  );

  server.patch<{ Params: { aggregateServiceId: string }; Body: Record<string, unknown> }>(
    "/api/v1/aggregate-services/:aggregateServiceId",
    async (request) => {
      const user = await requireRequestUser(request, runtime.database);
      const updated = await runtime.aggregateServices.update(request.params.aggregateServiceId, {
        userId: user.id,
        displayName: request.body.displayName,
        pathSuffix: request.body.pathSuffix,
        serviceIds: request.body.serviceIds,
        relayPlaybackEnabled: request.body.relayPlaybackEnabled,
        downloadEnabled: request.body.downloadEnabled,
        regionLibrariesEnabled: request.body.regionLibrariesEnabled,
      });
      let indexJobId: string | null = null;
      if (updated.membersChanged) {
        indexJobId = await runtime.aggregateIndex.enqueue(updated.aggregateService.id, user.id, "rebuild");
      }
      runtime.logBusinessEvent("info", {
        日志关键字: "codex-aggregate-service",
        事件: "修改聚合服务配置",
        用户ID: user.id,
        聚合服务ID: updated.aggregateService.id,
        成员是否变更: updated.membersChanged,
        索引任务ID: indexJobId,
      });
      return { aggregateService: await runtime.aggregateServices.getById(updated.aggregateService.id, user.id) };
    },
  );

  server.get<{ Params: { aggregateServiceId: string } }>(
    "/api/v1/aggregate-services/:aggregateServiceId/accounts",
    async (request) => {
      const user = await requireRequestUser(request, runtime.database);
      return { accounts: await runtime.aggregateAccess.list(request.params.aggregateServiceId, user.id) };
    },
  );

  server.post<{ Params: { aggregateServiceId: string }; Body: Record<string, unknown> }>(
    "/api/v1/aggregate-services/:aggregateServiceId/accounts",
    async (request, reply) => {
      const user = await requireRequestUser(request, runtime.database);
      const account = await runtime.aggregateAccess.create(request.params.aggregateServiceId, user.id, {
        username: request.body.username,
        password: request.body.password,
      });
      runtime.logBusinessEvent("info", {
        日志关键字: "codex-aggregate-account",
        事件: "创建聚合服务访问账号",
        用户ID: user.id,
        聚合服务ID: request.params.aggregateServiceId,
        访问账号ID: account.id,
      });
      return reply.status(201).send({ account });
    },
  );

  server.patch<{ Params: { aggregateServiceId: string; accountId: string }; Body: Record<string, unknown> }>(
    "/api/v1/aggregate-services/:aggregateServiceId/accounts/:accountId",
    async (request) => {
      const user = await requireRequestUser(request, runtime.database);
      return {
        account: await runtime.aggregateAccess.update(
          request.params.aggregateServiceId,
          request.params.accountId,
          user.id,
          { username: request.body.username, password: request.body.password, status: request.body.status },
        ),
      };
    },
  );

  server.delete<{ Params: { aggregateServiceId: string; accountId: string } }>(
    "/api/v1/aggregate-services/:aggregateServiceId/accounts/:accountId",
    async (request, reply) => {
      const user = await requireRequestUser(request, runtime.database);
      await runtime.aggregateAccess.delete(request.params.aggregateServiceId, request.params.accountId, user.id);
      runtime.logBusinessEvent("warn", {
        日志关键字: "codex-aggregate-account",
        事件: "删除聚合服务访问账号",
        用户ID: user.id,
        聚合服务ID: request.params.aggregateServiceId,
        访问账号ID: request.params.accountId,
      });
      return reply.status(204).send();
    },
  );
}
