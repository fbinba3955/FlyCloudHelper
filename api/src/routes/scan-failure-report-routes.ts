import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import { requireRequestUser, requireSuperAdmin } from "../http.js";
import type { ApiRuntime } from "../runtime.js";

/** 发送已完成归属校验的扫描失败报告文件。 */
async function sendFailureReport(
  runtime: ApiRuntime,
  reply: FastifyReply,
  jobId: string,
  userId?: string,
): Promise<FastifyReply> {
  const job = await runtime.repository.getJob(jobId, userId);
  const filePath = await runtime.failureReports.getDownloadPath(job);
  const downloadFileName = `scan-failures-${path.basename(filePath)}`;
  reply.header("Content-Type", "application/x-ndjson; charset=utf-8");
  reply.header("Content-Disposition", `attachment; filename="${downloadFileName}"`);
  reply.header("Cache-Control", "private, no-store");
  runtime.logBusinessEvent("info", {
    日志关键字: "codex-scan-failure-report",
    事件: "下载扫描失败报告",
    任务ID: job.id,
    服务ID: job.serviceId,
    用户ID: job.userId,
  });
  return reply.send(fs.createReadStream(filePath));
}

/** 注册普通用户和超级管理员的扫描失败报告下载接口。 */
export async function registerScanFailureReportRoutes(
  server: FastifyInstance,
  runtime: ApiRuntime,
): Promise<void> {
  server.get<{ Params: { jobId: string } }>("/api/v1/scan-jobs/:jobId/failure-report", async (request, reply) => {
    const user = await requireRequestUser(request, runtime.database);
    return sendFailureReport(runtime, reply, request.params.jobId, user.id);
  });

  server.get<{ Params: { jobId: string } }>("/api/v1/admin/jobs/:jobId/failure-report", async (request, reply) => {
    await requireSuperAdmin(request, runtime.database);
    return sendFailureReport(runtime, reply, request.params.jobId);
  });
}
