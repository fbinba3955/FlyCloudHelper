import type { FastifyInstance } from "fastify";
import type { ApiRuntime } from "../runtime.js";
import { requireRequestUser } from "../http.js";

/** 注册当前登录用户的通知读取与清除接口。 */
export async function registerNotificationRoutes(server: FastifyInstance, runtime: ApiRuntime): Promise<void> {
  server.get<{ Querystring: Record<string, unknown> }>("/api/v1/notifications", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    const limit = Math.min(100, Math.max(1, Number.parseInt(String(request.query.limit ?? "30"), 10) || 30));
    return { notifications: await runtime.database.listNotifications(user.id, limit) };
  });

  server.delete<{ Params: { notificationId: string } }>("/api/v1/notifications/:notificationId", async (request, reply) => {
    const user = await requireRequestUser(request, runtime.database);
    const deleted = await runtime.database.deleteNotification(user.id, request.params.notificationId);
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-flycloud-notification",
      事件: deleted ? "用户清除单条通知" : "用户清除不存在的通知",
      用户ID: user.id,
      通知ID: request.params.notificationId,
    });
    return reply.status(204).send();
  });

  server.delete("/api/v1/notifications", async (request) => {
    const user = await requireRequestUser(request, runtime.database);
    const deletedCount = await runtime.database.clearNotifications(user.id);
    runtime.logBusinessEvent("info", {
      日志关键字: "codex-flycloud-notification",
      事件: "用户清除全部通知",
      用户ID: user.id,
      清除数量: deletedCount,
    });
    return { deletedCount };
  });
}
