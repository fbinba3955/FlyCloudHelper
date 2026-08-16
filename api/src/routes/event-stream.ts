import type { FastifyReply } from "fastify";
import type { JobEventRecord } from "../domain.js";

/** 把持久化任务事件转换为 SSE 帧。 */
function writeEvent(reply: FastifyReply, event: JobEventRecord): void {
  reply.raw.write(`id: ${event.sequence}\n`);
  reply.raw.write(`event: ${event.eventType}\n`);
  reply.raw.write(`data: ${JSON.stringify({
    jobId: event.jobId,
    createdAt: event.createdAt,
    ...event.payload,
  })}\n\n`);
}

/** 建立支持 Last-Event-ID 断线续传的任务 SSE 流。 */
export function streamJobEvents(
  reply: FastifyReply,
  initialSequence: number,
  fetchEvents: (afterSequence: number) => Promise<JobEventRecord[]>,
): void {
  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  reply.raw.write(": connected\n\n");
  let sequence = initialSequence;
  let closed = false;
  let lastHeartbeatAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | null = null;

  /** 查询新事件并安排下一轮，不让慢查询重叠。 */
  const poll = async (): Promise<void> => {
    if (closed) return;
    try {
      const events = await fetchEvents(sequence);
      for (const event of events) {
        writeEvent(reply, event);
        sequence = event.sequence;
      }
      if (Date.now() - lastHeartbeatAt >= 15_000) {
        reply.raw.write(`: heartbeat ${Date.now()}\n\n`);
        lastHeartbeatAt = Date.now();
      }
      timer = setTimeout(() => void poll(), events.length >= 200 ? 0 : 1000);
    } catch {
      reply.raw.write("event: error\ndata: {\"code\":\"event_stream_failed\"}\n\n");
      reply.raw.end();
    }
  };

  reply.raw.on("close", () => {
    closed = true;
    if (timer) clearTimeout(timer);
  });
  void poll();
}
