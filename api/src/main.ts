import { loadApiConfig } from "./config.js";
import { buildApiServer } from "./server.js";

/** 启动 FlyCloudHelper API 进程。 */
async function startApi(): Promise<void> {
  const config = loadApiConfig();
  const server = await buildApiServer(config);

  try {
    await server.listen({ host: config.host, port: config.port });
    server.log.info({
      日志标记: "flycloud-helper-api",
      事件: "API启动成功",
      监听地址: config.host,
      监听端口: config.port,
      数据库类型: config.databaseType,
    });
    server.log.info({
      日志关键字: "codex-flycloud-helper-provider-network",
      事件: "Provider地址网段限制已移除",
      地址范围: "不限制公网内网回环或保留网段",
    });
  } catch (error) {
    server.log.error({
      日志标记: "flycloud-helper-api",
      事件: "API启动失败",
      错误: error,
    });
    await server.close();
    process.exitCode = 1;
  }
}

void startApi();
