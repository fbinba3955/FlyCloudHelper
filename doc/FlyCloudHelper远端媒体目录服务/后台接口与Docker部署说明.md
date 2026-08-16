# FlyCloudHelper 后台接口与 Docker 部署说明

更新日期：2026-08-16

## 1. 后台组成

当前镜像使用一个 Node.js 20 进程提供以下能力：

1. Fastify REST API、APP Bearer Token、Web HttpOnly Cookie 会话和 SSE 任务事件。
2. SQLite、PostgreSQL、MySQL 共用的 Knex schema 初始化与数据访问层。
3. 内置扫描 Worker、WebDAV 检查点恢复、暂停、继续、取消、重试和目录 generation 对账。
4. WebDAV、阿里云盘开放接口、百度网盘开放接口和光鸭标准网关 Provider。
5. 当前影视扫描已对齐 Flymby APP 的文件名清洗、电影/剧集/季集识别、默认排除目录、同名 NFO 优先和 TMDB 电影/电视剧刮削流程。Worker 在一个目录枚举完成后立即构建影片任务并加入刮削队列，扫描与刮削流水线并行，不等待全盘文件枚举完成；音乐和有声书保留处理器与插件扩展位。
6. 当前开放影视目录、父子关系、APP 文件定位、目录变更和 JSON 快照导出。
7. 普通用户服务管理，以及超级管理员用户、服务、任务、海报墙、插件、系统状态和审计接口。
8. 同源提供 `web/dist` 前端静态文件；Web 页面不返回播放定位。

业务日志关键字为 `flycloud-helper-api` 和 `flycloud-helper-worker`。影视刮削可使用 `codex-flycloud-helper-scrape` 筛查，扫描与刮削流水线入队可使用 `codex-flycloud-helper-streaming-scrape` 筛查，服务并发实际取值可使用 `codex-flycloud-helper-worker-tuning` 筛查，Provider 请求异常可使用 `codex-flycloud-helper-provider-request` 筛查，任务重试可使用 `codex-flycloud-helper-job-retry` 筛查，检查点建立、保存、恢复和停止保留可使用 `codex-flycloud-helper-checkpoint` 筛查，TMDB Key 冷却、任务等待和到期重新入队可使用 `codex-flycloud-helper-tmdb-recovery` 筛查。日志结构中的业务变量使用中文 key，并对 Authorization、Cookie、密码、Token 和连接配置进行脱敏。

失败或已取消任务通过任务级 `retry` 接口创建新任务，原任务状态、错误和快照保持不变；新任务使用服务当前有效配置，并在快照的 `retryOfJobId` 中记录原任务 ID。增量任务重试时也会重新处理上次已经发现的文件，避免未变更判断把上次失败或未匹配的条目直接跳过。运行中、排队中、等待 TMDB 恢复、暂停中和已完成任务不能走手动重试接口，其中暂停任务应使用继续接口，`retry_waiting` 任务会由 Worker 到期自动重新入队。

schema 12 新增 `scan_job_checkpoints`、`scan_root_runs` 和 `source_files.scan_root_key`。WebDAV 每 20 批目录生成一次安全游标候选，Worker 只在上一窗口的刮削和持久化完成后提交游标、统计、NFO 白名单结果和变化条目 ID；检查点不保存密码、Token、Cookie、Authorization 或播放定位。暂停和服务进程退出保留最近安全窗口，继续时复用同一 `scanSessionId/generationId` 并重放最近窗口。全量扫描正常进入持久化时只对完整根执行缺失对账，不完整根保留旧数据；后续根发生致命错误前即时提交前序完整根仍待补齐。阿里云盘、百度网盘和光鸭的分页游标尚未接入。

schema 13 为 `scan_jobs` 增加 `next_retry_at`、`retry_count` 及到期查询索引。TMDB 请求遇到 `429`、临时 `5xx`、网络异常或 20 秒请求超时时，先把当前 Key 移入独立冷却并尝试其他健康 Key；只有全部未禁用 Key 都在冷却时，任务才进入 `retry_waiting`。等待任务保留最近安全检查点并回退页面统计，到达 `nextRetryAt` 后由 Worker 自动重新入队，从 WebDAV 检查点窗口继续。`401/403` 会禁用对应 Key，TMDB `404` 或确定没有候选仍按未匹配处理，不进入延迟恢复。单次 `Retry-After` 最长采用 30 分钟，网络和 `5xx` 使用 15 秒起步、最长 5 分钟的单 Key 退避；当前实现未设置累计等待次数上限，用户可以暂停或终止等待任务。

创建云端服务时必须提交服务级 `dataType`。页面展示影视、音乐和有声书三个选项，当前只允许选择 `video`（影视）；后台会拒绝 `music` 和 `audiobook`，并要求扫描范围与元数据配置和服务数据类型一致。现有服务在 schema 7 升级时默认补为 `video`。

## 2. Docker 环境变量在代码中的体现

环境变量不是只写在 Docker 文件里，而是按下面的调用链真正进入后台：

```text
.env / Compose environment / Docker Secret
                  ↓
           api/src/config.ts
                  ↓
 数据库连接、凭据库、TMDB Key 池、Worker、插件与导出目录
```

| 位置 | 作用 |
| --- | --- |
| `.env.example` | 列出可配置项、默认值和敏感项说明，复制为 `.env` 后供 Compose 插值 |
| `compose.yml` | 把宿主机配置传入容器，默认使用 SQLite 和 `/data` 持久卷 |
| `compose.postgres.yml` | 覆盖数据库类型并增加 PostgreSQL 容器 |
| `compose.mysql.yml` | 覆盖数据库类型并增加 MySQL 8.4 容器 |
| `compose.secrets.yml` | 可选：使用部署者提供的凭据主密钥覆盖自动生成配置 |
| `Dockerfile` | 设置容器内部固定目录、端口、非 root 用户、健康检查和启动命令 |
| `api/src/config.ts` | 读取、校验并转换所有环境变量；`*_FILE` 优先于同名明文变量 |

主要变量：

| 环境变量 | 默认值/要求 | 实际用途 |
| --- | --- | --- |
| `FLYCLOUDHELPER_DATABASE_TYPE` | `sqlite` | 选择 `better-sqlite3`、`pg` 或 `mysql2` |
| `FLYCLOUDHELPER_SQLITE_PATH` | 容器内 `/data/database/flycloud-helper.db` | SQLite 持久化文件 |
| `FLYCLOUDHELPER_DATABASE_URL` / `_FILE` | PostgreSQL/MySQL 必填 | 数据库连接池；管理接口不会回显地址 |
| `FLYCLOUDHELPER_CREDENTIAL_MASTER_KEY` / `_FILE` | 可选，显式配置时至少 32 个字符 | 覆盖自动生成密钥，用于 AES-256-GCM 加密网盘凭据和插件 Secret |
| `FLYCLOUDHELPER_GENERATED_CREDENTIAL_KEY_PATH` | `/data/secrets/credential-master-key` | 未提供外部密钥时生成并持久化主密钥的位置 |
| `FLYCLOUDHELPER_TMDB_PER_KEY_CONCURRENCY` | `1` | 单个 TMDB Key 的最大在途请求数 |
| `FLYCLOUDHELPER_TMDB_MAX_CONCURRENCY` | `32` | TMDB 部署级并发上限 |
| `FLYCLOUDHELPER_WORKER_ENABLED` | `true` | 是否启动内置扫描 Worker |
| `FLYCLOUDHELPER_WORKER_CONCURRENCY` | `2` | 同时执行的扫描任务数 |
| `FLYCLOUDHELPER_PLUGIN_DIR` | `/data/plugins` | 声明式插件版本目录 |
| `FLYCLOUDHELPER_EXPORT_DIR` | `/data/exports` | APP 目录快照目录 |
| `FLYCLOUDHELPER_COOKIE_SECURE` | `false` | HTTPS 部署时应设置为 `true` |
| `FLYCLOUDHELPER_ALLOW_INSECURE_HTTP` | `true` | 是否允许 Provider 使用 HTTP；设为 `false` 时强制 Provider 使用 HTTPS |

Provider 地址不限制公网、内网、回环、链路本地或保留网段，也不再提供私网地址开关；部署者需要自行控制哪些用户可以创建或修改 Provider 连接。

凭据主密钥的读取顺序为 `*_FILE`、明文环境变量、持久化自动生成文件。前两者都未配置时，服务生成 32 字节随机值，以 `0600` 权限保存；后续启动会拒绝符号链接并自动把过宽的现有文件权限收紧到 `0600`。主密钥只在首次超级管理员初始化后的备份步骤中返回原文，相关响应使用 `no-store`。数据库仅保存不可逆 SHA-256 指纹和是否完成备份的状态；启动时指纹不一致会直接失败，禁止使用新密钥静默覆盖。TMDB Key 由超级管理员在“系统配置”页面录入，使用该主密钥加密后写入数据库；Key 原文不进入读取响应、日志、任务快照、目录导出或普通用户页面。数据库地址、主密钥原文和 AcoustID Key同样不得进入这些位置。

## 3. SQLite Docker 启动

```sh
cp .env.example .env
```

`.env` 中的凭据主密钥可以保持为空，首次启动会自动生成。然后执行：

```sh
docker compose up -d --build
docker compose logs -f flycloud-helper
```

浏览器访问 `http://服务器地址:4174/setup`，首次设置超级管理员。管理员创建成功后页面显示自动生成的主密钥，提供复制和下载操作；必须勾选已经保存到数据库及 Docker 数据卷之外，确认后才能进入后台。首次设置不需要一次性初始化凭证，因此应先在受控网络完成设置，再开放公网端口。

持久数据全部位于命名卷 `flycloud_helper_data`：

```text
/data/database   SQLite 数据库
/data/secrets    自动生成的凭据主密钥
/data/plugins    声明式元数据插件
/data/exports    APP 目录导出文件
```

## 4. Docker Secret 启动

先创建以下不会提交 Git 的文件：

```text
secrets/credential-master-key.txt
```

然后执行：

```sh
docker compose -f compose.yml -f compose.secrets.yml up -d --build
```

使用 Docker Secret 时页面不会再次显示外部主密钥。无论使用自动生成文件还是 Docker Secret，主密钥丢失后数据库中的既有网盘连接和插件 Secret 都无法解密，所以数据库备份与主密钥备份必须分开保管。

TMDB Key 不再通过 Docker Secret 或环境变量传入。超级管理员登录后从左侧进入“系统配置”，录入完整 Key 列表并二次确认；保存后立即更新运行中的 TMDB Key 池，无需重启容器。

## 5. PostgreSQL 与 MySQL

PostgreSQL 示例 `.env`：

```dotenv
POSTGRES_PASSWORD=请替换
FLYCLOUDHELPER_DATABASE_URL=postgresql://flymby:请替换@postgres:5432/flycloud_helper
```

```sh
docker compose -f compose.yml -f compose.postgres.yml up -d --build
```

MySQL 示例 `.env`：

```dotenv
MYSQL_PASSWORD=请替换
MYSQL_ROOT_PASSWORD=请替换
FLYCLOUDHELPER_DATABASE_URL=mysql://flymby:请替换@mysql:3306/flycloud_helper
```

```sh
docker compose -f compose.yml -f compose.mysql.yml up -d --build
```

切换数据库类型或连接地址不会自动复制原数据库数据。新数据库中原管理员、用户、服务、任务、媒体目录和插件配置都不存在，需要重新初始化；切回原连接后旧数据仍在。自动生成的主密钥位于独立持久卷文件中，单纯切库不会删除；如果需要把原数据带入新数据库，必须停止写入后执行单独的数据迁移流程，并保证 API、Worker 和迁移过程使用同一把主密钥。

## 6. 本地开发启动

本项目要求 Node.js 20：

```sh
nvm use 20
npm install
npm run dev
```

- Web 开发服务器：`http://localhost:4173`
- API：`http://localhost:4174`
- Vite 自动把 `/api` 代理到后台。

生产方式本地启动：

```sh
npm run build
npm run start:api
```

生产后台会从 `web/dist` 同源提供页面，因此只需要对外暴露 API 的 `4174` 端口，不需要再启动 Vite。

## 7. API 范围

| 范围 | 主要接口 |
| --- | --- |
| 实例探测 | `/api/v1/health`、`/api/v1/system/info`、`/api/v1/setup/status` |
| 认证 | `/api/v1/setup/super-admin`、`/api/v1/auth/register`、`login`、`refresh`、`logout`、`me` |
| 普通用户服务 | `/api/v1/providers*`、`/api/v1/services*`、连接验证、`POST connection/reconnect` 当前配置重连、扫描/元数据配置、客户端绑定 |
| 网盘目录选择 | `/api/v1/services/{serviceId}/directories` 和管理端对应接口；使用已保存凭据逐级返回直接子目录，不返回文件或 Secret |
| 扫描任务 | `/api/v1/services/{serviceId}/scan-jobs`、`/api/v1/scan-jobs*`、暂停/继续/终止/重试，以及二次确认删除已结束任务；Web 任务页每 5 秒刷新 |
| 服务媒体库清理 | `DELETE /api/v1/services/{serviceId}/catalog` 和管理端对应接口；只清空单一服务的媒体、文件索引和目录变更，保留连接与配置，活动任务存在时拒绝 |
| 目录 | `/api/v1/libraries/{libraryId}`、`home`、`facets`、`items`、`children`、`paths`、`search`、`changes` |
| 影视人工匹配 | `/api/v1/libraries/{libraryId}/items/{itemId}/manual-match/search`、`POST manual-match`、`POST manual-match/clear`；管理端提供对应 `/api/v1/admin/catalog/items/{itemId}/*` 接口 |
| APP 文件定位 | `/api/v1/libraries/{libraryId}/items/{itemId}/files`，必须使用 Bearer Token |
| 导出 | `/api/v1/libraries/{libraryId}/exports`、`/api/v1/exports/{exportId}`、`download` |
| 超级管理员 | `/api/v1/admin/status`、用户、服务、任务、目录、插件、`GET /api/v1/admin/config/status`、`PUT /api/v1/admin/config/tmdb-keys` 和审计接口 |

所有普通用户资源都从认证上下文取得 `tenantId`。APP 提交的 `serviceId`、`libraryId`、`clientServiceId` 或本地备份均不能代替用户认证。

`GET /api/v1/providers` 的每个 Provider 描述包含 `recommendedScanSettings`。当前四类网盘均沿用 Flymby APP 的影视扫描默认值：`scanDirectoryConcurrency=8`（范围 1–16）、`scrapeTaskConcurrency=4`（范围 1–4）、`fullScanDirectoryConcurrency=1`。创建服务时写入推荐值，旧服务缺少字段时运行期同样使用推荐值；用户可通过扫描配置接口手动修改前两个值。全量任务固定按 1 个目录并发枚举，增量任务按服务配置并发枚举；刮削实际并发取服务配置与 TMDB Key 池当前有效并发的较小值。

服务进入 `reauthorization_required` 后，用户或管理员可以调用 `POST /api/v1/services/{serviceId}/connection/reconnect` 及管理端对应接口。后台只读取并解密当前凭据修订，重新验证 Provider 和已经配置的扫描根；成功后恢复连接状态，不新建凭据修订、不修改配置且不自动触发扫描。诊断日志关键字为 `codex-flycloud-helper-provider-reconnect`。

目录详情的 `paths` 接口只返回当前条目及直接子项关联的只读路径、文件名、大小和修改时间，不返回 `playbackLocator`、Provider 请求头、临时 URL 或凭据。手动匹配只接受 `movie/tv + tmdbId`，后台必须重新读取 TMDB 详情后落库；人工匹配结果会优先于后续自动扫描，清除匹配后恢复本地识别信息。操作日志关键字为 `codex-flycloud-helper-manual-match`。

媒体目录列表支持 `sort=created_desc|year_desc|premiere_date_desc|title_asc`，分别表示按加入时间、年份、首映日期和名称排序。已匹配电影或节目会把上映日/首播日写入独立的 `premiere_date` 列；历史顶层已匹配条目会从元数据 JSON 回填该字段，列表查询不需要逐行解析 JSON。

## 8. Provider 与插件说明

- WebDAV 使用 RFC 4918 `PROPFIND` 的 `Depth: 0/1` 递归枚举。
- WebDAV 暂停/继续使用持久化目录窗口；普通用户接口为 `POST /api/v1/scan-jobs/{jobId}/pause|resume`，管理员接口为 `POST /api/v1/admin/jobs/{jobId}/pause|resume`。继续不是新建任务，不更换冻结配置、扫描会话或 generation。
- WebDAV 返回的目录 `href` 会先解码用于目录身份，再按路径分段重新编码后发起请求，避免 `#`、`?`、空格或中文被解释成 URL 结构。连接验证或扫描根目录访问失败仍终止任务；扫描中的任意单个子目录读取失败时按 Flymby APP 的 `scanOneDirectory` 行为记录并跳过，继续处理其余目录。`401` 表示凭据未被接受，`403` 表示当前资源权限不足，不再把两者都标记为整个服务凭据失效。只要本轮存在目录警告，就禁止缺失文件、排除路径和孤立父项清理，避免不完整枚举误删历史媒体。目录异常筛查关键字为 `codex-flycloud-helper-webdav-directory`，变量 `目录路径`、`响应状态码` 和 `错误码` 表示实际异常请求；通用 Provider 异常仍使用 `codex-flycloud-helper-provider-request`。
- 阿里云盘使用开放平台文件列表契约，保存 `driveId + fileId` 定位。
- 百度网盘使用 xpan 文件列表契约，`fsId` 始终按字符串返回。
- 光鸭目前没有可确认的稳定公开接口，后台使用明确的 JSON 网关契约，不猜测或绑定私有接口。
- 后续网盘通过实现统一 `ProviderAdapter` 并注册到 `ProviderRegistry` 增加，不修改目录主模型。
- Provider 目录枚举按 `directoryConcurrency` 分批并发请求，每个目录的返回仍连续交给 Worker，保证电影和节目聚合不跨目录串组。Flymby APP 没有额外目录请求间隔，当前服务也不虚构定时扫描或请求间隔配置。
- Worker 按目录完成一次电影/节目上下文识别后立即加入刮削队列，扫描与刮削并行执行。电影多版本按影片任务身份合并，节目按节目身份合并，单集按节目、季号和集号合并；本地 NFO 是否参与只读取 `metadata.profiles.video.useNfo`。TMDB 显式编号不存在时回退标题搜索，搜索已命中但详情或单集子步骤失败时保留可用候选结果。流程诊断关键字为 `codex-flycloud-helper-scrape-flow`。
- Provider 连接失败会区分域名解析失败、解析地址无法使用、端口拒绝、网络不可达、连接超时和 HTTPS 证书错误，页面返回具体中文原因和处理建议；后台诊断日志关键字为 `codex-flycloud-helper-provider-connect`，只记录协议、主机、端口、解析地址和系统错误码，不记录账号、密码或 Token。
- Web 前台导入的插件只允许 `media_metadata` 声明式 ZIP，不允许 JavaScript、ArkTS、Python、Shell、动态库、Provider 适配器或符号链接。
- 任务入队时冻结插件 ID、版本、SHA-256 和配置修订；插件停用不会改变运行中和历史任务。

## 9. 当前验证边界

此前版本已在 Node.js 20 下完成 TypeScript API/Web 全量构建，并实际验证 SQLite schema 初始化、系统探测、首次超级管理员创建、Cookie 会话、管理员用户查询、个人概览和生产静态页面返回。本次 schema 12/13、WebDAV 检查点、暂停/继续及 TMDB 延迟恢复改动按用户要求未编译、未运行真实网盘或限流恢复验证，目前只完成静态差异检查。

当前开发机没有 Docker CLI，因此尚未实际执行镜像构建、Compose 健康检查、PostgreSQL 容器或 MySQL 容器联调。四种真实网盘也需要用户使用自己的有效授权进行连接、分页、限流与大目录验证。
