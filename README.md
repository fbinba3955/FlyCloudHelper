# FlyCloudHelper

<img src="web/public/flycloud-helper-icon.png" alt="FlyCloudHelper 图标" width="96" />

FlyCloudHelper 是面向 Flymby 客户端的自部署云端媒体扫描、刮削和目录服务。它负责连接用户创建的网盘服务、扫描媒体文件、识别电影与节目、获取元数据并保存媒体目录；Web 管理端用于管理用户、服务、扫描任务、插件和系统配置，并通过海报墙浏览结果，不提供在线播放。

当前版本仅开放影视扫描与刮削。数据模型和处理器接口已预留音乐、有声书及更多网盘 Provider 的扩展能力。

## 界面预览

### 管理概览

![FlyCloudHelper 管理概览](assets/readme/admin-overview.jpg)

### 媒体库

![FlyCloudHelper 媒体库](assets/readme/media-library.jpg)

## 主要功能

- 用户注册、登录和多用户数据隔离。
- 一个用户可创建多个独立网盘服务和媒体库。
- 支持 WebDAV、光鸭、阿里云盘、百度网盘 Provider 接口。
- 配置全量扫描目录、增量扫描目录、本地 NFO、元数据规则和服务级任务并发。
- 扫描任务进度、当前路径、WebDAV 检查点暂停/继续、终止、删除和失败重试。
- TMDB 多 Key 自动切换；全部 Key 因限流或临时故障不可用时，任务保留检查点并到期自动恢复。
- 电影、节目匹配，支持手动匹配和清除匹配结果。
- 用户、服务及管理员范围的媒体海报墙和详情页。
- 超级管理员管理用户、全部服务、任务、插件、TMDB Key 和系统状态。
- 导出 Flymby APP 可导入的媒体库备份文件。

## 运行要求

- Node.js 20.19 或更高版本
- npm
- 默认无需安装外部数据库

## 本地启动

```sh
nvm use 20
npm install
npm run dev
```

启动后访问：

- Web 前端：`http://localhost:9935`
- 后台 API：`http://localhost:9934`
- 首次初始化：`http://localhost:9935/setup`

`npm run dev` 会同时启动前端和后台。也可以分别运行：

```sh
npm run dev:api
npm run dev:web
```

不创建 `.env` 时，服务默认使用 SQLite，数据库文件位于 `data/database/flycloud-helper.db`。首次运行会自动创建数据库结构；超级管理员账号需要在初始化页面中设置。

## Docker 启动

### 默认 SQLite

直接运行 Docker Hub 公开镜像：

```sh
docker run -d \
  --name flycloud-helper \
  --restart unless-stopped \
  -p 9934:9934 \
  -v flycloud_helper_data:/data \
  fbinba3955/flycloud-helper:latest
```

镜像同时支持 `linux/amd64` 和 `linux/arm64`。固定版本可将 `latest` 改为 `0.1.1`。

容器内部端口固定为 `9934`，`-p` 左侧可以修改宿主机端口。`/data` 必须持久化，其中保存 SQLite 数据库、凭据主密钥、插件和导出文件。即使改用 PostgreSQL 或 MySQL，也不能删除这个数据卷。

启动后访问 `http://服务器地址:9934/setup` 设置超级管理员。

### 连接已有 PostgreSQL

创建不会提交到 Git 的 `.env`：

```dotenv
FLYCLOUDHELPER_DATABASE_TYPE=postgres
FLYCLOUDHELPER_DATABASE_HOST=postgres容器名
FLYCLOUDHELPER_DATABASE_PORT=5432
FLYCLOUDHELPER_DATABASE_NAME=flycloud_helper
FLYCLOUDHELPER_DATABASE_USER=flycloud_helper
FLYCLOUDHELPER_DATABASE_PASSWORD=请替换
FLYCLOUDHELPER_DATABASE_AUTO_CREATE=true
```

如果 PostgreSQL 与 FlyCloudHelper 都运行在 Docker 中，应让两个容器加入同一个网络，并把 `DATABASE_HOST` 设置为 PostgreSQL 容器名，不要填写 `127.0.0.1`：

```sh
docker network create flycloud-network
docker network connect flycloud-network 已有PostgreSQL容器名

docker run -d \
  --name flycloud-helper \
  --restart unless-stopped \
  --network flycloud-network \
  --env-file .env \
  -p 9934:9934 \
  -v flycloud_helper_data:/data \
  fbinba3955/flycloud-helper:latest
```

两个容器已经处于同一网络时，不需要重复执行 `docker network connect`。如果数据库运行在其他主机，`DATABASE_HOST` 填写数据库主机的 IP 或域名。

数据库不存在且自动创建开启时，PostgreSQL 用户必须拥有 `CREATEDB` 权限。服务只创建 `DATABASE_NAME` 指定的数据库，并自动初始化 FlyCloudHelper 表结构，不会创建数据库用户。数据库创建完成后可以按部署策略收回该用户的 `CREATEDB` 权限。

### 连接已有 MySQL

MySQL 使用相同的配置方式：

```dotenv
FLYCLOUDHELPER_DATABASE_TYPE=mysql
FLYCLOUDHELPER_DATABASE_HOST=mysql容器名
FLYCLOUDHELPER_DATABASE_PORT=3306
FLYCLOUDHELPER_DATABASE_NAME=flycloud_helper
FLYCLOUDHELPER_DATABASE_USER=flycloud_helper
FLYCLOUDHELPER_DATABASE_PASSWORD=请替换
FLYCLOUDHELPER_DATABASE_AUTO_CREATE=true
```

MySQL 容器同样需要与 FlyCloudHelper 处于同一个 Docker 网络。自动创建要求用户对目标数据库拥有 `CREATE` 及后续建表、索引和读写权限；服务不会创建数据库用户。

### 使用项目 Compose 创建数据库

由项目同时创建 PostgreSQL 时，在 `.env` 中设置：

```dotenv
POSTGRES_DB=flycloud_helper
POSTGRES_USER=flymby
POSTGRES_PASSWORD=请替换
```

然后执行：

```sh
docker compose -f compose.yml -f compose.postgres.yml up -d --build
```

由项目同时创建 MySQL 时，在 `.env` 中设置：

```dotenv
MYSQL_DATABASE=flycloud_helper
MYSQL_USER=flymby
MYSQL_PASSWORD=请替换
MYSQL_ROOT_PASSWORD=请替换
```

然后执行：

```sh
docker compose -f compose.yml -f compose.mysql.yml up -d --build
```

### 从源码构建

从源码构建并启动：

```sh
docker compose up -d --build
```

默认通过 `http://localhost:9934` 访问服务。生产镜像由同一个 API 进程提供后台接口、Web 静态文件和扫描 Worker。

## 配置方式

复制示例文件后按需修改：

```sh
cp .env.example .env
```

常用环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `FLYCLOUDHELPER_HOST_PORT` | `9934` | Docker 对外端口 |
| `FLYCLOUDHELPER_DATABASE_TYPE` | `sqlite` | 数据库类型：`sqlite`、`postgres` 或 `mysql` |
| `FLYCLOUDHELPER_SQLITE_PATH` | `data/database/flycloud-helper.db` | SQLite 文件位置 |
| `FLYCLOUDHELPER_DATABASE_HOST` | 空 | PostgreSQL 或 MySQL 地址 |
| `FLYCLOUDHELPER_DATABASE_PORT` | `5432`/`3306` | PostgreSQL 或 MySQL 端口 |
| `FLYCLOUDHELPER_DATABASE_NAME` | 空 | FlyCloudHelper 使用的数据库名称 |
| `FLYCLOUDHELPER_DATABASE_USER` | 空 | 数据库用户名 |
| `FLYCLOUDHELPER_DATABASE_PASSWORD` | 空 | 数据库密码，支持使用同名 `_FILE` 变量读取 Secret |
| `FLYCLOUDHELPER_DATABASE_AUTO_CREATE` | `true` | 数据库不存在时尝试自动创建 |
| `FLYCLOUDHELPER_DATABASE_URL` | 空 | 兼容原有完整连接地址，配置后优先于拆分字段 |
| `FLYCLOUDHELPER_COOKIE_SECURE` | `false` | HTTPS 部署时设为 `true` |
| `FLYCLOUDHELPER_WORKER_CONCURRENCY` | `2` | 同时执行的扫描任务数 |
| `FLYCLOUDHELPER_ALLOW_INSECURE_HTTP` | `true` | 是否允许 Provider 使用 HTTP |

完整配置见 [.env.example](.env.example)。旧版 `FLYMBYSCANNER_*` 环境变量仍可由后台兼容读取，建议新部署统一改为 `FLYCLOUDHELPER_*`。

TMDB Key 不再通过环境变量配置。超级管理员登录后，在“系统配置”页面中维护一个或多个 Key；后台会根据健康 Key 数量动态调整刮削并发。

PostgreSQL 与 MySQL 使用拆分字段时，服务会自动处理密码中的特殊字符。目标数据库不存在且自动创建开启时，PostgreSQL 用户需要 `CREATEDB` 权限，MySQL 用户需要 `CREATE` 权限；服务只创建指定数据库，之后自动初始化自身表结构，不会创建数据库用户。

网盘服务默认使用 Flymby APP 的任务参数：扫描任务数为 8、刮削任务数为 4。扫描任务数可在 1–16 之间调整，刮削任务数可在 1–4 之间调整；全量扫描的实际目录并发固定不超过 1，增量扫描使用服务设置。实际刮削并发还会受当前可用 TMDB Key 容量限制。

## 数据与密钥

本地开发数据保存在 `data/`，Docker 数据保存在 `flycloud_helper_data` 持久卷。未配置凭据主密钥时，服务首次启动会随机生成并保存到 `data/secrets/credential-master-key`；设置超级管理员时需要按页面提示备份该密钥。密钥丢失后，数据库中已有的网盘凭据将无法解密。

切换 SQLite、PostgreSQL 或 MySQL 不会自动迁移数据，需要自行执行导出、导入或数据库迁移。

## 项目结构

```text
api/       Fastify API、数据库、Provider、扫描 Worker 与刮削逻辑
web/       React 管理前端
doc/       规格、页面、接口和开发计划文档
data/      本地数据库、密钥、插件和导出文件（不会提交到 Git）
```

## 更多文档

- [项目说明](项目说明.md)
- [Spec 规格文档](doc/FlyCloudHelper远端媒体目录服务/Spec规格文档.md)
- [前端页面功能文档](doc/FlyCloudHelper远端媒体目录服务/前端页面功能文档.md)
- [后台接口与 Docker 部署说明](doc/FlyCloudHelper远端媒体目录服务/后台接口与Docker部署说明.md)
- [开发计划文档](doc/FlyCloudHelper远端媒体目录服务/开发计划文档.md)
- [需求与接口对照文档](doc/FlyCloudHelper远端媒体目录服务/需求与接口对照文档.md)
