FROM node:20-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
COPY api/package.json api/tsconfig.json api/tsconfig.build.json ./api/
COPY web/package.json web/tsconfig.json ./web/
RUN npm ci

COPY api ./api
COPY web ./web
RUN npm run build
RUN npm prune --omit=dev

FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production \
    FLYCLOUDHELPER_API_HOST=0.0.0.0 \
    FLYCLOUDHELPER_API_PORT=4174 \
    FLYCLOUDHELPER_DATABASE_TYPE=sqlite \
    FLYCLOUDHELPER_SQLITE_PATH=/data/database/flycloud-helper.db \
    FLYCLOUDHELPER_GENERATED_CREDENTIAL_KEY_PATH=/data/secrets/credential-master-key \
    FLYCLOUDHELPER_PLUGIN_DIR=/data/plugins \
    FLYCLOUDHELPER_EXPORT_DIR=/data/exports \
    FLYCLOUDHELPER_WEB_DIST_DIR=/app/web/dist

WORKDIR /app

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/api/package.json ./api/package.json
COPY --from=build --chown=node:node /app/api/dist ./api/dist
COPY --from=build --chown=node:node /app/web/dist ./web/dist

RUN mkdir -p /data/database /data/secrets /data/plugins /data/exports && chown -R node:node /data

USER node
EXPOSE 4174
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.FLYCLOUDHELPER_API_PORT + '/api/v1/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "api/dist/main.js"]
