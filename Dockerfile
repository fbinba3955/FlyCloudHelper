# syntax=docker/dockerfile:1
# check=skip=SecretsUsedInArgOrEnv

# 编译阶段固定使用构建主机架构，避免在跨架构仿真中运行 esbuild。
FROM --platform=$BUILDPLATFORM node:20-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
COPY api/package.json api/tsconfig.json api/tsconfig.build.json ./api/
COPY web/package.json web/tsconfig.json ./web/
RUN npm ci

COPY api ./api
COPY web ./web
RUN npm run build

# 运行依赖按目标架构单独安装，确保 argon2、better-sqlite3 等原生模块可用。
FROM node:20-bookworm-slim AS production-dependencies

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
COPY api/package.json api/tsconfig.json api/tsconfig.build.json ./api/
COPY web/package.json web/tsconfig.json ./web/
RUN npm ci --omit=dev

FROM node:20-bookworm-slim AS runtime

# 这里只声明容器管理界面需要展示的变量名和安全默认值；真实密码必须在运行容器时注入。
ENV NODE_ENV=production \
    FLYCLOUDHELPER_API_HOST=0.0.0.0 \
    FLYCLOUDHELPER_API_PORT=9934 \
    FLYCLOUDHELPER_PUID=1000 \
    FLYCLOUDHELPER_PGID=1000 \
    FLYCLOUDHELPER_PUBLIC_BASE_URL= \
    FLYCLOUDHELPER_DATABASE_TYPE=sqlite \
    FLYCLOUDHELPER_DATABASE_HOST= \
    FLYCLOUDHELPER_DATABASE_PORT= \
    FLYCLOUDHELPER_DATABASE_NAME= \
    FLYCLOUDHELPER_DATABASE_USER= \
    FLYCLOUDHELPER_DATABASE_PASSWORD= \
    FLYCLOUDHELPER_DATABASE_AUTO_CREATE=true \
    FLYCLOUDHELPER_SQLITE_PATH=/data/database/flycloud-helper.db \
    FLYCLOUDHELPER_COOKIE_SECURE=false \
    FLYCLOUDHELPER_ALLOW_INSECURE_HTTP=true \
    FLYCLOUDHELPER_WORKER_CONCURRENCY=5 \
    FLYCLOUDHELPER_HUAWEI_BINDING_PROOF_SECRET= \
    FLYCLOUDHELPER_GENERATED_CREDENTIAL_KEY_PATH=/data/secrets/credential-master-key \
    FLYCLOUDHELPER_PLUGIN_DIR=/data/plugins \
    FLYCLOUDHELPER_EXPORT_DIR=/data/exports \
    FLYCLOUDHELPER_MIGRATION_DIR=/data/migrations \
    FLYCLOUDHELPER_WEB_DIST_DIR=/app/web/dist \
    FLYCLOUDHELPER_FFPROBE_PATH=/usr/bin/ffprobe \
    FLYCLOUDHELPER_MEDIA_PROBE_CONCURRENCY=1

WORKDIR /app

COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=production-dependencies --chown=node:node /app/api/node_modules ./api/node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/api/package.json ./api/package.json
COPY --from=build --chown=node:node /app/api/dist ./api/dist
COPY --from=build --chown=node:node /app/web/dist ./web/dist
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# Debian 的 ffmpeg 软件包提供原生 ffprobe；gosu 用于修复 NAS 挂载权限后降权启动服务。
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg gosu \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data/database /data/secrets /data/plugins /data/exports /data/migrations \
    && chown -R node:node /data

# 入口脚本需要先修复 NAS 挂载目录，随后立即通过 gosu 降权运行 Node 服务。
USER root
EXPOSE 9934
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.FLYCLOUDHELPER_API_PORT + '/api/v1/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "api/dist/main.js"]
