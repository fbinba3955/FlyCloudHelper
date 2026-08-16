# FlyCloudHelper

<img src="web/public/flycloud-helper-icon.png" alt="FlyCloudHelper 图标" width="96" />

FlyCloudHelper 是面向 Flymby 客户端的自部署云端媒体扫描、刮削和目录服务。它负责连接用户创建的网盘服务、扫描媒体文件、识别电影与节目、获取元数据并保存媒体目录；Web 管理端用于管理用户、服务、扫描任务、插件和系统配置，并通过海报墙浏览结果，不提供在线播放。

当前版本仅开放影视扫描与刮削。数据模型和处理器接口已预留音乐、有声书及更多网盘 Provider 的扩展能力。

## 主要功能

- 用户注册、登录和多用户数据隔离。
- 一个用户可创建多个独立网盘服务和媒体库。
- 支持 WebDAV、光鸭、阿里云盘、百度网盘 Provider 接口。
- 配置全量扫描目录、增量扫描目录、本地 NFO、元数据规则和服务级任务并发。
- 扫描任务进度、当前路径、终止、删除和失败重试。
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

- Web 前端：`http://localhost:4173`
- 后台 API：`http://localhost:4174`
- 首次初始化：`http://localhost:4173/setup`

`npm run dev` 会同时启动前端和后台。也可以分别运行：

```sh
npm run dev:api
npm run dev:web
```

不创建 `.env` 时，服务默认使用 SQLite，数据库文件位于 `data/database/flycloud-helper.db`。首次运行会自动创建数据库结构；超级管理员账号需要在初始化页面中设置。

## Docker 启动

```sh
docker compose up -d --build
```

默认通过 `http://localhost:4174` 访问服务。生产镜像由同一个 API 进程提供后台接口、Web 静态文件和扫描 Worker。

使用 PostgreSQL：

```sh
docker compose -f compose.yml -f compose.postgres.yml up -d --build
```

使用 MySQL：

```sh
docker compose -f compose.yml -f compose.mysql.yml up -d --build
```

## 配置方式

复制示例文件后按需修改：

```sh
cp .env.example .env
```

常用环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `FLYCLOUDHELPER_HOST_PORT` | `4174` | Docker 对外端口 |
| `FLYCLOUDHELPER_DATABASE_TYPE` | `sqlite` | 数据库类型：`sqlite`、`postgres` 或 `mysql` |
| `FLYCLOUDHELPER_SQLITE_PATH` | `data/database/flycloud-helper.db` | SQLite 文件位置 |
| `FLYCLOUDHELPER_DATABASE_URL` | 空 | PostgreSQL 或 MySQL 连接地址 |
| `FLYCLOUDHELPER_COOKIE_SECURE` | `false` | HTTPS 部署时设为 `true` |
| `FLYCLOUDHELPER_WORKER_CONCURRENCY` | `2` | 同时执行的扫描任务数 |
| `FLYCLOUDHELPER_ALLOW_INSECURE_HTTP` | `true` | 是否允许 Provider 使用 HTTP |

完整配置见 [.env.example](.env.example)。旧版 `FLYMBYSCANNER_*` 环境变量仍可由后台兼容读取，建议新部署统一改为 `FLYCLOUDHELPER_*`。

TMDB Key 不再通过环境变量配置。超级管理员登录后，在“系统配置”页面中维护一个或多个 Key；后台会根据健康 Key 数量动态调整刮削并发。

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
