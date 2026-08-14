# FlymbyScanner 远端媒体目录服务涉及系统与修改任务梳理

生成日期：2026-08-14

## 1. 检查范围

| 项目 | 内容 |
| --- | --- |
| 需求文档 | `doc/FlymbyScanner远端媒体目录服务/Spec规格文档.md` |
| 补充材料 | 用户取消 APP 托管模式，明确统一用户名密码且二者都至少 4 个字符；首次使用在无需初始化凭证的 `/setup` 页面设置超级管理员账号密码；APP 云端模式输入地址后登录或注册，再选择已有服务或把当前服务创建为新云端服务；服务端长期管理连接、扫描和刮削配置；TMDB 支持多个 Key并按 Key 数动态调整并发；以及查询接口、Android TV、三类媒体、网盘扩展、多用户多服务、数据库环境变量、FlymbyServer 音乐参考和 Web 前端完整管理闭环 |
| 代码范围 | HarmonyOS `/Users/shijianting/WebstormProjects/flymby`；Android TV `/Users/shijianting/DevecostudioProjects/flymby2/androidtv`；音乐参考 `/Users/shijianting/WebstormProjects/FlymbyServer` |
| 最新口径 | FlymbyScanner 只使用至少 4 个字符的用户名和密码，首次使用现场设置首个 `super_admin`，支持多用户多云端服务和三类媒体；APP 可登录/注册、选择已有服务或创建新服务；TMDB 使用多 Key 池并按健康 Key 数动态调整刮削并发；Web 提供首次设置、登录、注册、普通用户个人控制台和超级管理员后台；数据库默认 SQLite，可切换 PostgreSQL/MySQL |

## 2. 总体结论

需求明确涉及 FlymbyScanner API/Worker、首次设置、用户名密码认证、`user/super_admin` RBAC、长期加密凭据库、云端服务及配置修订、Web 前端、三数据库存储层、HarmonyOS Flymby、Android TV、三类媒体处理器、首批四类网盘及后续 Provider 生态。云端规范身份改为服务端生成的 `serviceId`，APP `clientServiceId` 只负责设备本地绑定。TMDB 从单 Key 草案升级为部署级多 Key 池，新增健康状态、最少在途调度、限流冷却、失效禁用、公平队列和多 Worker 共享并发。空数据库实例首次使用时必须在 `/setup` 设置首个超级管理员账号密码，不要求初始化凭证；完成前关闭其他业务接口，部署者完成设置后才能开放公网。正常运行后普通用户在 `/app` 管理本人服务、任务和目录，超级管理员在 `/admin` 管理全局用户、服务、插件、任务和配置。仍需确认注册开放方式、用户名/密码最大长度与附加复杂度、首次设置前的网络开放流程、凭据主密钥轮换、TMDB 并发默认值、任务控制按钮、第三种后台角色和图片策略。

## 3. 涉及系统汇总

| 系统 | 是否明确涉及 | 证据来源 | 影响范围 | 备注 |
| --- | --- | --- | --- | --- |
| FlymbyScanner | 明确涉及 | 用户要求创建 Docker 云端扫描服务并补充三类媒体、TMDB 环境变量和 Web 前端 | API、Worker、首次设置、认证/RBAC、Web 前端、配置、插件、Provider SDK、媒体 Processor、数据库、导出、安全 | 新项目 |
| FlymbyScanner Web 前端 | 明确涉及 | 用户要求首次设置超级管理员，并提供登录、注册、普通用户入口和超级管理员角色 | `/setup`、`/login`、`/register`、`/app`、`/admin`、服务/任务/海报墙、用户/角色、插件、配置状态和审计 | 普通用户仅本人作用域，超级管理员全局作用域；不支持直接播放 |
| FlymbyScanner 数据库存储层 | 明确涉及 | 用户要求默认 SQLite，并可配置 PostgreSQL/MySQL | 配置加载、连接、方言、迁移、迁移锁、排序、搜索和健康状态 | 跨库数据迁移范围待确认 |
| HarmonyOS Flymby | 明确涉及 | APP 云端模式登录/注册、选择或创建云端服务并直接播放 | 服务添加、账号、服务绑定/创建、扫描、目录、搜索、详情、备份 | 保留本地模式；服务端扫描凭据不下发 |
| Android TV | 明确涉及 | 用户询问并确认 TV 使用 | 网盘授权、三类媒体目录、视频播放、音频队列和章节 | 当前无网盘服务类型，音频领域需补充 |
| 视频处理器 | 明确涉及 | 原始扫描刮削需求 | 电影、剧集、NFO、TMDB、图片和关系 | 首个现有能力迁移来源 |
| 音乐处理器 | 明确涉及 | 用户补充三类媒体并指定参考 FlymbyServer | 艺术家、专辑、曲目、标签、封面、候选匹配、多来源聚合和可选声纹 | 技术路线已明确，默认来源、阈值和声纹首期范围待确认 |
| 有声书处理器 | 明确涉及 | 用户最新补充 | 作品、作者、演播者、分卷、章节和时长 | 外部元数据源待确认 |
| FlymbyServer 音乐刮削代码 | 明确涉及 | 用户指定参考已有音乐刮削方法 | `audio_scraper.py`、`audio_metadata_sources.py`、配置、接口模型和管理端能力页 | 只参考/迁移领域方法，不修改 FlymbyServer，不建立默认运行时依赖 |
| WebDAV | 明确涉及 | `CloudDriveProviderType` | 路径枚举、NFO、文件定位 | 建议第一个闭环 |
| 光鸭云盘 | 明确涉及 | `CloudDriveProviderType` | OAuth/Token、分页、fileId | API 型 Provider |
| 阿里云盘 | 明确涉及 | `CloudDriveProviderType` | Token 刷新、driveId/fileId、分页 | API 型 Provider |
| 百度网盘 | 明确涉及 | `CloudDriveProviderType` | Token 刷新、fs_id、分页 | fs_id 必须以字符串传输 |
| 后续网盘 Provider | 明确涉及 | 用户说明后面还会更多 | Provider SDK、能力协商、安装升级和客户端播放适配 | 具体网盘待后续确定 |
| TMDB | 明确涉及 | 用户明确可配置多个 Key 并按数量动态调整刮削并发 | 复数环境变量/Secret、Key 池、健康/冷却/禁用、最少在途调度、公平队列、部署级并发和脱敏状态 | Key 由服务端部署配置提供，普通 API 不暴露数量 |
| 声明式刮削插件 | 明确涉及 | 用户要求可替换刮削源并由前台导入 | 插件包、Manifest、域名、限额、版本、持久卷和安全审核 | 不执行任意代码，不包含 Provider 适配器 |
| 认证/账户 | 明确涉及 | 用户明确用户名和密码均至少 4 个字符，并新增 `super_admin` | 首次设置、注册、登录、Argon2id、令牌轮换、`user/super_admin` RBAC、设备、租户上下文、云端服务和媒体库权限 | 公开注册固定 `user`；最大长度、复杂度和注册开放方式待确认 |
| 运维/合规 | 推断涉及 | 服务对用户开放 | 备案、监控、安全、ICP/等保和用户数据删除 | 公网上线前必须完成 |

## 4. 修改任务清单

| 编号 | 系统 | 模块/页面/接口 | 修改任务 | 任务类型 | 依赖/风险 | 优先级 |
| --- | --- | --- | --- | --- | --- | --- |
| T-001 | FlymbyScanner | 项目基础 | 确定技术栈并新增 API/Worker/Docker/配置骨架 | 新增 | 技术栈待确认 | P0 |
| T-002 | FlymbyScanner | OpenAPI | 新增系统、首次设置、注册登录、角色、云端服务列表/创建/绑定/配置、媒体库、任务、三类媒体目录、Provider 能力、变更和导出契约 | 新增 | 用户名/密码最大长度、会话参数和备份 schema 待确认 | P0 |
| T-003 | FlymbyScanner | 认证/授权 | 新增用户名/密码至少 4 字符统一校验、注册固定 `user`、登录、Argon2id、访问/刷新令牌轮换、`user/super_admin` RBAC、`TenantContext`、设备绑定和媒体库权限 | 新增 | 注册开放方式与会话参数待确认 | P0 |
| T-004 | FlymbyScanner | Secret Store | 新增每服务长期凭据加密、主密钥 Secret、密钥版本、只写不读、重新授权和轮换 | 新增 | 凭据泄露或主密钥丢失风险高 | P0 |
| T-005 | FlymbyScanner | 数据库 | 在 SQLite、PostgreSQL、MySQL 建立账号、`cloud_service`、配置修订、凭据、客户端绑定和媒体目录的同一逻辑模型及唯一约束 | 新增 | 三库的 JSON、时间、索引、排序和搜索方言不同 | P0 |
| T-006 | FlymbyScanner | Provider SDK | 新增开放 ID、能力、凭据 schema、统一资源、错误和适配器生命周期 | 新增 | 插件分发与信任边界待确认 | P0 |
| T-007 | FlymbyScanner | Provider | 新增 WebDAV 适配器并完成第一个闭环 | 新增 | 路径型身份与弱 ETag | P1 |
| T-008 | FlymbyScanner | Provider | 新增光鸭、阿里云盘和百度网盘适配器 | 新增 | 正式 API、限额、Token 轮换 | P1 |
| T-009 | FlymbyScanner | Scanner | 迁移通用枚举、增量基线、generation、检查点、删除保护和 Processor 路由 | 新增/迁移 | 不能直接复制视频/ArkUI 依赖 | P1 |
| T-010 | FlymbyScanner | 视频 Processor | 迁移电影、剧集、NFO、TMDB 和视频插件 | 新增/迁移 | SSRF、接口限额和匹配质量 | P1 |
| T-011 | FlymbyScanner | 音乐 Processor | 新增艺术家、专辑、曲目、标签、封面；参考 FlymbyServer 迁移多来源 Provider 注册、`fast/complete` 聚合、统一候选、匹配状态和可选声纹后备 | 新增/参考迁移 | 格式、默认来源、阈值和声纹范围待确认；禁止默认依赖 FlymbyServer API | P1 |
| T-012 | FlymbyScanner | 有声书 Processor | 新增作品、作者、演播者、分卷、章节、标签和时长 | 新增 | 格式与来源待确认 | P1 |
| T-013 | FlymbyScanner | Catalog | 新增首页、facets、列表、详情、children、文件、搜索和变更 API | 新增 | 事务一致性和索引 | P1 |
| T-014 | FlymbyScanner | Jobs/SSE | 新增租户/服务作用域任务状态机、冻结凭据/扫描/刮削/插件修订、服务互斥、幂等、暂停继续重试和断线补变更 | 新增 | 多设备并发、配置漂移和跨租户隔离 | P1 |
| T-015 | FlymbyScanner | Export | 新增带媒体类型和扩展 schema 的绑定文件及离线快照；跨租户恢复创建新绑定 | 新增 | 格式与所有权转移规则待确认 | P2 |
| T-016 | HarmonyOS | `ServerInfoData` | 新增云端模式、Scanner 实例 ID、协议版本、`serviceId/libraryId`；现有 `serverId` 仅作为 `clientServiceId` 本地绑定别名 | 修改 | 编辑/复制/备份恢复需重新定义绑定语义 | P1 |
| T-017 | HarmonyOS | 网盘添加入口 | 新增“云端地址检测 → 已有账户登录/新建账户 → 已有服务选择/当前服务新建”流程、Provider 能力和保存校验 | 修改 | 选择已有服务不得覆盖云端配置；账号令牌需安全存储 | P1 |
| T-018 | HarmonyOS | 扫描入口 | 按绑定 `serviceId` 触发扫描并订阅 SSE，不再提交连接、扫描根和刮削配置 | 修改 | 保留本地扫描兼容 | P1 |
| T-019 | HarmonyOS | 目录 Repository | 新增本地与远端实现及视频/音乐/有声书领域映射 | 新增/修改 | 当前页面数据模型分散 | P1 |
| T-020 | HarmonyOS | 播放 | 将 `playbackLocator` 映射到视频播放或 `AudioService` | 修改 | 不修改 libmpv | P1 |
| T-021 | Android TV | 服务模型/管理 | 新增可扩展网盘、本地播放授权、用户名密码登录/注册、账号服务列表、`serviceId/libraryId` 绑定和 Keystore | 新增/修改 | 当前不支持 WebDAV；页面/Dialog 必须有初始焦点 | P1 |
| T-022 | Android TV | 目录 Client/UI | 新增三类媒体 Client、Repository、页面和搜索接入 | 新增/修改 | TV 焦点与断线恢复 | P2 |
| T-023 | Android TV | 播放定位 | 新增 Provider URL/Headers 解析，以及音乐队列和有声书章节播放域 | 新增 | 没有凭据时只能浏览 | P1 |
| T-024 | 运维/合规 | 公网发布 | 完成隐私、用户协议、安全、ICP/许可、等保、数据出境和用户数据删除 | 配置/流程 | 运营主体待确认 | P0（公网上线前） |
| T-025 | FlymbyScanner | 服务归属与隔离 | 实现服务端生成 `serviceId + libraryId`、客户端绑定事务、Provider 冲突检测，以及 Repository、缓存、队列、SSE、对象存储和导出的 `tenantId + serviceId + libraryId` 强制作用域 | 新增 | 任一遗漏都可能造成串库或越权 | P0 |
| T-026 | FlymbyScanner | 配置加载 | 实现 `FLYMBYSCANNER_TMDB_API_KEYS`、逐行 Secret 文件、单 Key/全局并发、去空去重、池修订、API/Worker 一致性和脱敏配置状态 | 新增 | Key 泄露、重复 Key 虚增容量和进程配置不一致 | P0 |
| T-027 | FlymbyScanner | Web 前端框架 | 新增 `/setup`、`/login`、`/register`、`/app`、`/admin`、按角色导航、概览、权限、配置状态和审计页面 | 新增 | CSRF/CSP、安全会话、初始化门禁和角色范围 | P1 |
| T-028 | FlymbyScanner | 插件导入 | 新增 `.flymby-plugin` 流式上传、解压保护、Manifest 校验、SHA-256、版本化持久化、启停和引用保护删除 | 新增 | 包签名和资源上限待确认；禁止任意代码 | P0 |
| T-029 | FlymbyScanner | 数据库配置与迁移 | 实现默认 SQLite 路径、`DATABASE_TYPE`、连接 URL/Secret、三方言适配、迁移锁、schema 门禁和脱敏状态 | 新增 | SQLite 多副本限制、连接泄露和跨库切换误解 | P0 |
| T-030 | FlymbyScanner | 音乐来源与声纹配置 | 实现来源启用列表、MusicBrainz User-Agent、AcoustID Key/Secret、固定 fpcalc 路径、临时文件上限、能力状态和敏感值隐藏 | 新增/参考迁移 | Docker 依赖、上游限流、临时磁盘和 Key 泄露 | P1 |
| T-031 | FlymbyScanner | 管理用户、角色与服务 API | 新增普通用户创建/密码重置、受保护角色授予/撤销、服务创建/连接验证/配置修订/扫描触发、列表、详情、状态、会话撤销和受保护删除；保护最后一个超级管理员 | 新增 | 跨租户查询、角色提权、误删除、凭据和认证动作边界 | P0 |
| T-032 | FlymbyScanner | 管理任务与 SSE | 新增按用户、服务、媒体库、媒体类型和状态筛选的任务详情与实时事件，支持游标续传、聚合节流和脱敏错误 | 新增 | 跨租户事件、连接负载和敏感路径泄露 | P1 |
| T-033 | FlymbyScanner | 管理海报墙 API | 新增三类媒体海报墙、搜索、facets、排序、游标分页、目录版本和只读详情 DTO；删除所有播放定位和网盘请求字段 | 新增 | 不能复用客户端 files/playback DTO，必须保留租户资源链校验 | P0 |
| T-034 | FlymbyScanner | 个人与管理页面 | 新增普通用户个人服务/任务/海报墙，以及超级管理员用户/角色、服务、全局任务、海报墙、媒体只读详情和审计页面；页面不提供播放器、播放按钮或媒体预览 | 新增 | 依赖 T-031～T-033 接口和服务端 RBAC | P1 |
| T-035 | FlymbyScanner | 插件配置 | Manifest 增加受限 `configurationSchema`，实现 schema 表单、Secret 加密/掩码、连接校验、不可变 `configurationRevision` 和任务修订绑定 | 新增 | Secret 泄露、运行任务配置漂移和 schema 兼容 | P0 |
| T-036 | FlymbyScanner | 云端服务配置 | 新增 `cloud_service`、连接/扫描/刮削配置修订、客户端绑定，以及选择已有与创建新服务的不同写入语义 | 新增 | 隐式覆盖会影响多端正在使用的服务 | P0 |
| T-037 | FlymbyScanner | 账户安全 | 新增注册策略、登录限频、刷新令牌轮换、退出/撤销、密码重置、公开注册防角色提权和最后超级管理员保护 | 新增 | 账号枚举、撞库、角色提权和管理员锁死风险 | P0 |
| T-038 | FlymbyScanner | TMDB Key 池调度 | 实现健康 Key 动态并发、最少在途加轮询、限流冷却、认证失败禁用、公平队列、多 Worker 共享信号量和容量指标 | 新增 | 无全局上限会压垮服务；无共享状态会按副本数放大并发 | P0 |
| T-039 | FlymbyScanner | 首次设置 | 新增持久化 `initialSetupCompletedAt`、`setup_required`、`/setup`、初始化状态/提交 API、超级管理员账号密码现场设置、数据库初始化锁和初始化完成后永久关闭；不要求初始化凭证 | 新增 | 无额外凭证时若提前暴露公网可能被抢占；部署必须先设置后开放公网，管理员异常缺失不能自动重开初始化 | P0 |

## 5. 跨系统依赖

| 依赖项 | 上游系统 | 下游系统 | 依赖内容 | 阻塞影响 |
| --- | --- | --- | --- | --- |
| 服务归属键 | FlymbyScanner 认证/HarmonyOS/Android TV | 所有 API、Worker 和存储 | 服务端 `tenantId + serviceId + libraryId` 所有权链；客户端 `clientServiceId` 仅作设备绑定别名 | 未冻结会导致跨用户串库、多端无法选择同一服务或本地绑定误覆盖 |
| OpenAPI 契约 | FlymbyScanner | HarmonyOS/Android TV | DTO、枚举、错误、SSE、播放定位 | 未冻结会导致两端分叉 |
| 云端服务配置 | APP/Web 个人控制台/超级管理员后台 | FlymbyScanner Service/Worker | 长期加密凭据、扫描根、媒体类型、元数据 Profile 及各自不可变修订 | 修订不完整会导致任务漂移或无法恢复 |
| 目录查询 | FlymbyScanner | HarmonyOS/Android TV | 三类媒体首页、facets、列表、详情、children、搜索 | 没有通用查询 API 会再次形成三套协议 |
| 播放定位 | FlymbyScanner | 客户端 Provider | 稳定文件身份与 Provider schema | 缺少时客户端无法直接播放 |
| 元数据插件 | `super_admin`/插件包 | FlymbyScanner 管理 API与 Metadata Processor | Manifest、版本、SHA-256、字段、域名、限额和启停状态 | 无安全预检会带来 SSRF、资源消耗和稳定性风险 |
| TMDB 多 Key 池 | Docker 环境变量/Secret/共享调度状态 | FlymbyScanner API/Worker/任务队列/管理前台 | 相同池修订、Key 状态、动态有效并发、部署总上限和脱敏统计 | 配置不一致会导致能力判断错误；未共享上限会按 Worker 数放大并发 |
| 数据库部署配置 | Docker 环境变量/Secret/持久卷 | FlymbyScanner API/Worker/迁移器/管理前台 | 默认 SQLite 或统一 PostgreSQL/MySQL 连接、schema 版本和健康状态 | 配置不一致会造成任务与目录数据分裂 |
| 数据库方言 | Storage Repository | Catalog/Jobs/Search/Export | 事务、唯一约束、JSON、时间、分页、排序、搜索和索引 | 任一方言缺失会导致三后端结果不一致 |
| 插件管理前台 | `super_admin`/管理 API | Metadata Processor/任务快照 | 插件预检、版本、SHA-256、启停、持久卷和引用状态 | 契约不稳会导致覆盖安装、任务版本漂移或任意代码进入服务 |
| 首次设置 | 空数据库状态/部署者 | 认证系统/Web/全部业务接口 | `setup_required`、无凭证 `/setup`、首个 `super_admin` 原子创建和“先设置后公网”流程 | 若无门禁或提前暴露公网，可能被抢占超级管理员；若无事务锁，并发请求会争抢首个账号 |
| 用户、角色与服务管理 | `super_admin` 认证/租户模型 | 超级管理员后台/云端服务/Catalog | 用户创建/密码重置、角色授予撤销、服务创建/配置/扫描、状态、会话撤销、影响范围、软停用和受保护删除 | 资源链校验不完整会串库，角色校验缺失会提权，Secret 回显或删除边界不清会泄露/误删 |
| 管理任务事件 | Jobs/SSE | 管理前台 | 用户/服务/媒体库筛选、阶段、计数、游标续传和脱敏错误 | 复用普通租户 SSE 或推送完整路径会越权并泄露数据 |
| 管理海报墙 | Catalog/Search/图片策略 | 管理前台 | 三类媒体卡片、facets、排序、分页、目录版本和无播放只读 DTO | 复用客户端 DTO 会把播放定位暴露给浏览器 |
| 插件配置修订 | 插件 Manifest/Secret Store | Metadata Processor/任务快照/管理前台 | `configurationSchema`、Secret 状态、连接校验和不可变修订 | 可变配置会让运行中任务漂移，Secret 回显会泄露密钥 |
| Provider SDK | FlymbyScanner 适配器 | 服务端 Scanner/客户端播放端 | 能力、资源身份、凭据 schema、定位 schema 和版本 | 契约不稳会导致每增加网盘都改核心 |
| 媒体 Processor | Scanner | Catalog/HarmonyOS/Android TV | 通用条目、类型扩展和关系 | 模型不稳会导致视频字段污染音乐和有声书 |
| 音乐参考实现 | FlymbyServer 源码 | FlymbyScanner 音乐 Processor | 来源适配器、统一候选、聚合策略、MusicBrainz 限流、Chromaprint/AcoustID 后备和能力状态 | 若直接依赖现有 HTTP 接口，会引入认证不匹配、跨服务故障和租户信息转发 |
| 用户名密码认证 | 首次设置/注册策略/账号模型 | FlymbyScanner Web 和两客户端 | 用户名密码至少 4 字符、注册、登录、Argon2id、访问/刷新令牌、`user/super_admin`、租户上下文、用户、设备、云端服务和媒体库权限 | 多用户服务、Web 权限与多端同步无法安全上线 |
| 服务凭据主密钥 | Docker Secret/运维 | Secret Store/Worker/备份恢复 | 主密钥、密钥版本、启动门禁、轮换和与数据库分离备份 | 丢失会使全部服务连接不可恢复，泄露会扩大网盘风险 |
| 合规与部署地区 | 运营/合规 | FlymbyScanner 部署 | 境内/境外数据、元数据源、备案与日志 | 阻塞官方公网服务 |

## 6. 待确认项

| 编号 | 问题 | 影响 | 建议确认对象 |
| --- | --- | --- | --- |
| Q-01 | 自助注册默认开放、需要注册码，还是管理员审核 | APP 新建账户表单、滥用防护和部署默认值 | 产品/运营/安全 |
| Q-02 | 服务端技术栈和三数据库方言/迁移框架 | 项目骨架、ORM、迁移锁和首个开发任务 | 技术负责人 |
| Q-03 | 用户名允许字符和最大长度、密码最大长度/附加复杂度、令牌有效期和刷新轮换参数 | 最小长度已固定为用户名和密码均至少 4 个字符；剩余规则影响注册登录、多端同步和账号安全 | 产品/安全 |
| Q-04 | 音乐是否默认启用 MusicBrainz 之外的来源、匹配阈值、声纹范围，以及有声书元数据源、Key、字段和图片缓存方式 | 音乐技术路线已参考 FlymbyServer，仍影响运行成本、误匹配、缓存和限额；有声书来源仍未确定 | 产品/服务端 |
| Q-05 | 备份 schema | APP 导入兼容和多端迁移 | HarmonyOS/Android TV/服务端 |
| Q-06 | 收藏与播放记录是否同步 | API 范围和冲突模型 | 产品 |
| Q-07 | 官方多租户上线地区和收费方式 | ICP/许可、数据出境和用户协议 | 运营/合规 |
| Q-08 | Provider 插件安装和升级方式 | 扩展效率、供应链安全和兼容性 | 技术/安全 |
| Q-09 | 音乐和有声书首批格式、标签与章节标准 | Processor 范围和验收 | 产品/客户端/服务端 |
| Q-10 | 旧 `serverId` 作为本地绑定别名的兼容周期 | APP 编辑/复制、备份恢复和重新选择云端服务 | HarmonyOS/Android TV |
| Q-11 | 是否支持跨账号转移媒体库 | 所有权、审计、原租户撤权和 `libraryId` 处理 | 产品/安全 |
| Q-12 | 首次设置前的网络开放流程和用户密码重置交付方式 | 初始化已固定为无需初始化凭证的 `/setup`；仍需冻结 Docker 默认监听、反向代理启用时机、一次性临时密码/重置链接、强制改密和会话撤销 | 产品/安全/运维 |
| Q-13 | `.flymby-plugin` 是否强制签名以及资源限制 | 插件来源、离线导入、上传提示和服务器资源保护 | 产品/技术/安全 |
| Q-14 | 首期是否提供 SQLite、PostgreSQL、MySQL 之间的专用迁移命令 | 默认 SQLite 用户后续扩容时的停机、校验和回滚 | 技术/运维 |
| Q-15 | 音乐候选自动采用/拒绝阈值及人工确认入口 | 决定低置信度候选是否覆盖本地标签 | 产品/客户端/服务端 |
| Q-16 | 声纹后备默认策略、单文件大小、并发和临时文件 TTL | Docker 镜像依赖、网盘流量、任务耗时和临时盘容量 | 产品/服务端/运维 |
| Q-17 | 服务凭据主密钥采用在线轮换还是停机命令轮换 | 凭据恢复、密钥泄露响应和部署复杂度 | 安全/运维 |
| Q-18 | 是否允许管理员暂停、继续或取消用户扫描任务 | 已明确可触发和重试；仍影响其他任务按钮、并发状态机和审计 | 产品/运营 |
| Q-19 | 海报图片采用浏览器直连、服务端缓存或混合模式 | 页面性能、隐私、带宽、存储和来源失效 | 产品/服务端 |
| Q-20 | 是否增加只读运维员等第三种后台角色 | 首期固定 `user/super_admin`；新增角色会影响菜单、按钮、用户服务数据权限和审计查看范围 | 产品/安全 |
| Q-21 | 本地播放授权是否要求与云端扫描账号一致 | 共享服务边界、Provider 校验和无法播放时的提示 | 产品/客户端/安全 |
| Q-22 | TMDB 单 Key 并发默认 1、部署总并发默认 32 是否正式采用 | 默认吞吐、上游限流概率和不同硬件容量 | 技术/运维 |

## 7. 建议实施顺序

1. 先实现无凭证 `/setup`、`setup_required` 业务门禁、首次初始化事务锁、用户名密码至少 4 字符、`user/super_admin` RBAC、注册/登录/令牌、`serviceInstanceId + userId + tenantId + serviceId + libraryId` 身份链、客户端绑定和数据库唯一约束。
2. 确认技术栈、凭据主密钥、TMDB 单 Key/部署总并发默认值及多 Worker 共享调度方式、三数据库方言/迁移框架、跨库数据迁移范围和合规边界。
3. 冻结 Web 首次设置与登录/注册/角色路由、APP 登录/注册/选择/创建服务流程、数据库/TMDB 多 Key/音乐配置名、首次设置前的网络开放流程、管理任务动作、管理 SSE、海报墙无播放 DTO、插件包和 `configurationSchema`/修订及管理 API。
4. 完成账号认证、云端服务及配置修订、TMDB Key 池动态并发、默认 SQLite、PostgreSQL/MySQL 适配、迁移锁、租户隔离、长期凭据安全和配置加载。
5. 分别验证三数据库的首次初始化锁、唯一约束、事务、排序、搜索、任务和目录版本，再完成 Web 个人控制台、超级管理员后台、任务 SSE、无播放海报墙、审计及声明式插件导入/配置闭环。
6. 以 WebDAV 分别完成视频、音乐、有声书扫描、目录和 HarmonyOS 播放闭环；音乐验证 FlymbyServer 参考聚合链路、来源降级和可选声纹，并验证两个租户与多个服务不会串库。
7. 用同一 Provider SDK 扩展光鸭、阿里云盘和百度网盘，确认没有改动扫描核心和目录主模型。
8. 在目录契约稳定后完成 Android TV 网盘和播放定位接入。
9. 完成备份、可选跨库迁移、运维、安全、合规和公网上线准备。
