import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { ApiError } from "../errors.js";
import type { ApiRuntime } from "../runtime.js";

/** 注册内容寻址的音乐内嵌封面读取接口；摘要文件名不包含用户或网盘信息。 */
export async function registerMusicArtworkRoutes(server: FastifyInstance, runtime: ApiRuntime): Promise<void> {
  server.get<{ Params: { fileName: string } }>("/api/v1/music-artwork/:fileName", async (request, reply) => {
    const fileName = request.params.fileName;
    if (!/^[a-f0-9]{64}\.jpg$/u.test(fileName)) {
      throw new ApiError(404, "music_artwork_not_found", "音乐封面不存在");
    }
    const filePath = path.join(runtime.config.musicArtworkDirectory, fileName);
    try {
      const file = await fs.promises.stat(filePath);
      if (!file.isFile() || file.size <= 0 || file.size > 10 * 1024 * 1024) {
        throw new ApiError(404, "music_artwork_not_found", "音乐封面不存在");
      }
      reply.header("Content-Type", "image/jpeg");
      reply.header("Content-Length", file.size);
      reply.header("Cache-Control", "public, max-age=31536000, immutable");
      return reply.send(fs.createReadStream(filePath));
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(404, "music_artwork_not_found", "音乐封面不存在");
    }
  });
}
