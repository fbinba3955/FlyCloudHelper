# FlyCloudHelper 扫描刮削流程缺失功能与补齐任务梳理

生成日期：2026-08-16

当前实施进度：P0 第一阶段已落地代码，等待用户运行验证；本次完成 WebDAV 检查点恢复、稳定扫描会话、扫描根运行记录、完整根缺失对账和前端暂停/继续入口。其他 Provider 游标，以及“后续根发生致命错误时立即提交此前完整根”的逐根提交时机仍未完成。

## 1. 检查范围

| 项目 | 内容 |
| --- | --- |
| 最新口径 | 继续以 Flymby APP 的网盘影视扫描刮削流程为基准，整理 FlyCloudHelper 尚未复刻的能力；云同步相关功能不纳入本次范围 |
| Flymby APP 参考范围 | `flymby/main/src/main/ets/webdav/service/WebDavScanService.ets`、`WebdavFullScanService.ets`、`util/WebdavVideoNameParser.ets`、`util/WebdavVideoTitleCleaner.ets` |
| FlyCloudHelper 检查范围 | `api/src/worker.ts`、`api/src/providers/`、`api/src/media/`、`api/src/metadata/`、`api/src/service-repository.ts`、`api/src/schema.ts`、扫描任务接口和 Web 任务页面 |
| 已采用的最新实现 | WebDAV 子目录异常继续扫描、401/403 分离、边扫描边刮削、NFO 开关、目录级电影/节目聚合、TMDB 搜索回退、目录不完整时禁止破坏性清理 |
| 明确排除 | Flymby APP 云同步、播放器、播放地址解析、移动端通知、前后台任务保活、AppStorage 页面状态和设备侧缓存迁移 |

## 2. 当前风险与不确定项

### 2.1 不能按文件直接复制

Flymby APP 是单设备 ArkTS 应用，使用本地数据库、Preferences、AppStorage 和后台任务；FlyCloudHelper 是多用户、多服务、可切换数据库的服务端。需要复刻的是业务语义和状态机，不能直接复制设备生命周期、UI 状态或本地存储代码。

### 2.2 暂停与继续已接入 WebDAV 检查点，但尚未覆盖全部 Provider

FlyCloudHelper 已新增 `scan_job_checkpoints`，WebDAV 会保存待处理目录窗口、稳定 `scanSessionId/generationId`、业务统计集合、NFO 解析结果和变化条目 ID。暂停或进程重启后从最近安全窗口重放，避免从扫描根开始；阿里云盘、百度网盘和光鸭仍需分别补充分页游标，因此当前不能把该能力写成全 Provider 已完成。

### 2.3 单根缺失对账已接入，逐根即时提交仍待补齐

当前已新增 `scan_root_runs` 和 `source_files.scan_root_key`，每个扫描根保存稳定根键、独立 generation、完成状态和警告数。任务正常进入最终持久化时，只对 `completed` 根标记缺失，`incomplete` 根不改旧数据；如果后续扫描根发生会终止整个任务的致命错误，前面已经完整的根尚未在错误发生前即时提交，仍需继续拆分提交时机。

### 2.4 AI 二次清洗缺少来源边界

Flymby APP 已有 AI 清洗结果保存和失败任务重试入口，但 FlyCloudHelper 尚未确定 AI 服务来源、插件契约、隐私边界和部署配置。该能力不能默认绑定某个在线模型，需要先确认是内置接口还是声明式插件扩展。

### 2.5 新能力涉及数据库结构

检查点、根 generation、持久化 TMDB 缓存、刮削任务快照和延迟重试都需要新增持久化结构。虽然当前开发数据库允许删除重建，正式设计仍需兼容 SQLite、PostgreSQL 和 MySQL，并保留后续迁移路径。

## 3. 总体结论

FlyCloudHelper 当前已经具备影视扫描刮削主链路。本文梳理的 9 类对齐项中，TMDB 任务级延迟恢复已经实施，其余项目仍有缺失或部分实现。当前主要缺口是致命错误前的单根即时提交、多集文件落库、失败任务精确重试和持久化元数据队列。这些能力同时影响 Worker、数据库、任务接口和 Web 任务页面，不能只修改文件名解析器。

## 4. 已完成的主流程基线

以下能力已经实现，不再列入缺失任务：

1. WebDAV 使用 `Depth: 0/1` 逐目录枚举。
2. `401` 表示凭据未被接受，`403` 表示当前资源权限不足。
3. 深层子目录读取失败时记录警告并继续扫描，且禁止本轮破坏性清理。
4. Provider 按目录连续输出，Worker 在目录完成后立即加入刮削队列，实现边扫描边刮削。
5. 本地 NFO 受 `metadata.profiles.video.useNfo` 控制，开启时优先读取。
6. 已按最近目录、季目录和同目录文件上下文识别电影、节目和单集。
7. 同一电影多版本、同一节目和同一集多文件按业务身份合并。
8. TMDB 显式编号不存在时回退标题搜索；搜索候选命中后，详情子步骤失败仍保留可用结果。
9. 扫描视频按文件统计，处理、匹配、未匹配和错误按电影或节目任务统计。

### 4.1 已实施内容

1. 数据库 schema 升级到 12，新增 `scan_job_checkpoints` 和 `scan_root_runs`。
2. 同一任务暂停、进程异常退出和再次领取时复用原 `scanSessionId` 与 `generationId`。
3. WebDAV 每 20 批目录形成一个安全检查点窗口；恢复时重放最近窗口，源文件、媒体、关系和统计均使用稳定身份去重。
4. 源文件写入稳定 `scan_root_key` 和根 generation；全量扫描只对完整根标记缺失，不完整根保留旧数据，多根重叠时使用最深匹配根。
5. Worker 停止时不再把被中止的枚举误提交为完成任务，下次启动由中断任务恢复逻辑重新入队。
6. 普通用户和超级管理员任务页均增加“暂停”“继续”，管理员补齐对应接口和审计记录。
7. 新增日志关键字 `codex-flycloud-helper-checkpoint`，可按任务 ID、扫描会话 ID、游标序号和待扫描目录数排查恢复过程。
8. 数据库升级到 schema 13，任务新增 `retry_waiting`、`nextRetryAt` 和累计等待次数。
9. TMDB `429`、临时 `5xx`、网络异常和请求超时会先切换其他健康 Key；全部未禁用 Key 都在冷却时，任务保存检查点并等待，到期自动重新入队。
10. TMDB `401/403` 仍按永久 Key 问题处理，`404` 和确定没有候选仍按未匹配处理，不进入延迟恢复。
11. 新增日志关键字 `codex-flycloud-helper-tmdb-recovery`，可筛查单 Key 冷却、任务等待和到期恢复。

尚未完成：致命根错误前的逐根即时提交、非 WebDAV Provider 游标、多集文件一对多落库、持久化缓存、失败项精确重试和刮削决策查询。

## 5. 涉及系统汇总

| 系统 | 是否明确涉及 | 证据来源 | 影响范围 | 备注 |
| --- | --- | --- | --- | --- |
| FlyCloudHelper Worker | 明确涉及 | `api/src/worker.ts` 与 APP `WebDavScanService.ets` 主流程对照 | 检查点、根状态、任务队列、多集落库、恢复和重试 | 主要改造位置 |
| FlyCloudHelper Provider | 推断涉及 | 恢复时需要稳定目录身份和游标 | 分页游标、目录继续位置、Provider 能力声明 | WebDAV 为路径型；其他网盘可能使用资源 ID 或分页令牌 |
| FlyCloudHelper 数据库 | 明确涉及 | schema 12 已有检查点、根运行和源文件根归属，schema 13 已有 TMDB 延迟恢复字段，尚无 TMDB 持久缓存与刮削任务表 | 新表、索引、三数据库兼容和清理策略 | 当前开发库可以重建，但文档按正式结构设计 |
| FlyCloudHelper API | 明确涉及 | 普通用户和管理员已具备 pause/resume/cancel/retry，尚未返回完整检查点诊断 | 检查点状态、部分完成、失败项重试和警告查询 | 普通用户与管理员接口均需保持所有权校验 |
| FlyCloudHelper Web 前端 | 明确涉及 | 当前任务页已提供暂停、继续、终止、失败重试和删除 | 恢复位置、部分完成、失败项统计和警告详情 | 危险操作继续二次确认 |
| Flymby APP | 明确涉及（只读参考） | 用户要求以 APP 扫描刮削行为为基准 | 提供业务语义和验收样本 | 本文不修改 APP |
| 云同步功能 | 不涉及 | 用户明确要求忽略云同步相关内容 | 无 | 不复刻 `WebdavVideoCloudSyncService` |

## 6. 缺失能力清单

| 编号 | 能力 | 当前状态 | Flymby APP 依据 | FlyCloudHelper 当前差异 | 优先级 |
| --- | --- | --- | --- | --- | --- |
| GAP-01 | 扫描检查点和真正的中断续扫 | 部分实现，WebDAV 已接入待运行验证 | `WebdavVideoScanCheckpoint`、`saveActiveCheckpoint`、`loadCheckpoint`、`restoreQueueFromCheckpoint` | WebDAV 已保存安全窗口并恢复；其他 Provider 尚无分页游标，未完成跨 Provider 对齐 | P0 |
| GAP-02 | 按单个扫描根提交 generation | 部分实现，正常收尾已按完整根对账 | APP 为每个根维护 `rootRuntime`，完整后才提交该根 generation | 已保存根状态、独立 generation 和源文件根归属；后续根致命失败前尚未即时提交前序完整根 | P0 |
| GAP-03 | 单文件多集拆成多个单集 | 部分实现 | APP 遍历 `episodeNumbers`，为每一集建立对应结果和关联 | 当前解析器保存 `episodeNumbers`，但 `filename.ts` 只用第一个集号生成一个媒体条目 | P1 |
| GAP-04 | 完整特殊文件名防误判规则 | 部分实现 | APP `WebdavVideoNameParser` 和 `WebdavVideoTitleCleaner` 包含更多弱标题、日期、技术参数、特别篇和特殊目录规则 | 当前已覆盖主规则，但少量特殊命名仍可能误判电影/节目或生成弱查询词 | P1 |
| GAP-05 | AI 文件名二次清洗与回写重试 | 未实现 | APP 存储 AI 清洗结果，并用清洗后的标题、类型和年份重试元数据来源 | 服务端没有 AI 清洗任务、结果结构、来源配置和人工确认边界 | P2，需先确认 |
| GAP-06 | TMDB 429 和临时故障后的任务级延迟恢复 | 已实现，待真实 TMDB/网盘联调 | APP 把 429、网络和服务异常识别为可恢复中断，保留检查点后暂停 | 已扩展为多 Key 优先切换、全池临时不可用时 `retry_waiting`，到期后从安全检查点自动继续 | P1 |
| GAP-07 | 持久化 TMDB 缓存和延迟详情补全 | 未实现 | APP 使用 `WebdavTmdbCacheRow`、`applyTmdbCacheOrScrape`、批量写入和过期清理 | 当前只在一次 Worker 任务内使用内存 Promise 缓存，进程重启或新任务无法复用 | P2 |
| GAP-08 | 只重试失败或未匹配的刮削任务 | 部分实现 | APP 保存刮削任务快照，可恢复队列并针对失败项重试 | 当前 retry 接口创建一条新的同模式扫描任务，仍重新枚举扫描根 | P1 |
| GAP-09 | 持久化刮削决策和完整任务诊断 | 部分实现 | APP 记录查询词变化、候选数量、选择原因、刮削阶段和失败原因 | 当前主要依赖进程日志，任务详情无法查询每个业务任务的刮削决策 | P2 |

## 7. 修改任务清单

| 编号 | 系统 | 模块/页面/接口 | 修改任务 | 任务类型 | 依赖/风险 | 优先级 |
| --- | --- | --- | --- | --- | --- | --- |
| TASK-01 | 数据库 | `api/src/schema.ts` | 新增扫描检查点表，保存任务 ID、schema 版本、阶段、根索引、待处理目录、活动目录、当前目录游标、计数和更新时间 | 新增 | 检查点不得保存凭据、Token 或完整任务连接配置 | P0 |
| TASK-02 | Worker | `api/src/worker.ts` | 在目录完成、固定文件数量、暂停、临时故障和进程退出前保存检查点 | 修改 | 写入频率过高会造成 SQLite 写锁；需要批量和节流 | P0 |
| TASK-03 | Worker | `api/src/worker.ts` | 任务恢复时复用原 scan session 和 generation，恢复目录队列及未完成刮削任务，不重复统计已完成内容 | 修改 | 必须保证幂等，重复执行不能生成重复海报、关系或文件链接 | P0 |
| TASK-04 | API/Web | `service-routes.ts`、`admin-routes.ts`、`web/src/lib/api.ts`、任务页 | 对外区分“暂停”“可恢复中断”“继续”“重新扫描”，显示检查点时间和恢复路径 | 修改 | 管理端当前只有取消，没有完整暂停/继续入口 | P1 |
| TASK-05 | 数据库 | 新增扫描根运行表或为基线表增加根身份 | 保存 `providerType + rootResourceId + generation + mode + completionStatus` | 新增 | 路径型 Provider 与资源 ID 型 Provider 的根身份必须统一 | P0 |
| TASK-06 | Worker/Repository | generation 对账 | 分根提交完整 generation；失败根保留旧数据，完整根可以独立确认新增、移动和缺失 | 修改 | 多个扫描根重叠时需要明确归属和去重规则 | P0 |
| TASK-07 | 媒体解析 | `api/src/media/filename.ts`、`flymby-video-parser.ts` | 将单个视频描述从一对一扩展为一对多单集描述，按 `episodeNumbers` 生成多个集条目 | 修改 | 不能改变“节目任务只计一次”的统计口径 | P1 |
| TASK-08 | Repository | 条目和文件关联 | 同一个源文件关联多个单集；每集保持独立季集号、排序和 TMDB 单集元数据 | 修改 | 清除、重新匹配和缺失清理必须同时维护多条关联 | P1 |
| TASK-09 | 媒体解析 | APP 特殊命名规则迁移 | 继续补齐日期集、SP/OVA、技术参数、纯数字、短剧大集号、电影合集和弱目录名防误判规则 | 修改 | 需要用真实失败路径样本验收，避免宽松规则污染普通电影 | P1 |
| TASK-10 | TMDB 调度 | `api/src/metadata/tmdb.ts`、Worker | 已把 429、临时网络、超时和 5xx 转换为可恢复任务；保存 `nextRetryAt`，到期后从检查点继续 | 已完成，待联调 | 多 Key 场景先切换健康 Key，全部不可用后才等待 | P1 |
| TASK-11 | 数据库/TMDB | 新增元数据缓存表 | 按来源、媒体类型、查询身份、语言、地区和来源修订缓存搜索/详情结果，设置过期时间 | 新增 | 不缓存鉴权错误；负结果只能使用短 TTL | P2 |
| TASK-12 | Worker | 延迟详情补全队列 | 搜索摘要已命中但详情失败时先保存可用结果，再安排详情补全并产生目录变化 | 新增 | 补全任务必须服从租户、服务和条目所有权 | P2 |
| TASK-13 | 数据库/Worker | 刮削任务快照 | 保存业务任务键、文件集合、查询词、匹配状态、外部 ID、失败原因和重试次数 | 新增 | 不保存播放授权和 Provider Secret | P1 |
| TASK-14 | API/Web | 失败项重试 | 增加“仅错误”“仅未匹配”“错误和未匹配”范围，只重建对应业务任务队列 | 修改 | 与现有“重新执行整个扫描任务”明确区分 | P1 |
| TASK-15 | Worker/API/Web | 刮削决策日志 | 持久化脱敏后的搜索阶段、候选数量、选择原因、回退动作和最终状态，并在任务详情按需展示 | 新增 | 查询词和路径属于用户数据，只允许所属用户和超级管理员查看 | P2 |
| TASK-16 | 文档 | 后台接口与部署说明、开发计划 | 每完成一项同步更新状态、表结构、接口语义、日志关键字和验证边界 | 修改 | 避免再次把“部分实现”写成“已完全对齐” | P1 |

## 8. 建议数据结构

以下为目标结构。其中 `scan_job_checkpoints` 和 `scan_root_runs` 的第一阶段字段已在 schema 12 中建立；`media_scrape_tasks` 仍是后续设计。

### 8.1 扫描检查点 `scan_job_checkpoints`

| 字段 | 说明 |
| --- | --- |
| `job_id` | 对应原扫描任务，唯一 |
| `tenant_id/service_id/library_id` | 所有权边界 |
| `checkpoint_version` | 检查点格式版本，升级后可拒绝不兼容恢复 |
| `scan_session_id` | 一次扫描会话稳定 ID |
| `generation_id` | 恢复后继续使用的 generation |
| `provider_type/provider_state_json` | Provider 类型、当前根序号、待处理目录和 Provider 游标；不得包含凭据 |
| `progress_json` | 扫描视频、业务任务、匹配、未匹配和错误计数 |
| `nfo_sidecars_json` | 已解析的 NFO 白名单字段，恢复后继续使用 |
| `changed_item_ids_json` | 已产生真实变化的媒体条目 ID |
| `created_at/updated_at` | 建立时间和最近安全保存时间 |

### 8.2 扫描根运行状态 `scan_root_runs`

| 字段 | 说明 |
| --- | --- |
| `job_id/root_key` | 根运行身份；`root_key` 为稳定散列键 |
| `root_resource_id/display_path` | 根资源 ID 和展示路径，只允许所属用户或超级管理员读取 |
| `generation_id` | 当前根 generation |
| `status` | running、completed、incomplete |
| `warning_count` | 当前根目录异常数量 |
| `started_at/finished_at` | 根运行时间 |

`source_files.scan_root_key` 保存文件所属稳定根键。全量缺失判断使用 `scan_root_key + root generation`，不再使用整库媒体 generation 直接删除其他根条目。

### 8.3 刮削任务快照 `media_scrape_tasks`

| 字段 | 说明 |
| --- | --- |
| `job_id/task_key` | 电影或节目业务任务身份 |
| `media_type/item_type` | 影视和电影/节目类型 |
| `query/year` | 脱敏后的识别查询 |
| `source_file_ids_json` | 参与任务的源文件 ID，不保存播放定位 |
| `status` | queued、running、matched、unmatched、failed、retry_waiting |
| `provider_id/external_id` | 元数据来源和匹配 ID |
| `decision_json` | 候选数量、回退阶段和选择原因 |
| `retry_count/next_retry_at` | 延迟重试状态 |
| `error_code/error_message` | 脱敏错误 |

## 9. 跨系统依赖

| 依赖项 | 上游系统 | 下游系统 | 依赖内容 | 阻塞影响 |
| --- | --- | --- | --- | --- |
| 稳定扫描会话 | 数据库 | Worker | 检查点、generation 和任务快照必须使用同一 scan session | 没有该能力就无法真正续扫 |
| Provider 游标能力 | Provider | Worker | 路径型目录、资源 ID 和分页令牌的恢复方式 | 影响后续阿里云盘、百度网盘和光鸭续扫 |
| 单根完整性 | Worker | Repository | 每个根独立报告完成或部分失败 | 决定是否允许标记缺失和删除历史条目 |
| 多集描述 | 媒体解析 | Repository/API | 一个文件生成多个单集及文件关联 | 影响详情路径、排序、清理和手动匹配 |
| 可恢复 TMDB 错误 | TMDB 调度 | 任务状态机/Web | `Retry-After`、Key 池状态和恢复时间 | 影响任务显示为错误还是等待恢复 |
| AI 清洗来源 | 系统配置/插件 | Worker | 请求契约、配置和隐私边界 | 未确认前不能实施 GAP-05 |

## 10. 待确认项

| 编号 | 问题 | 影响 | 建议 |
| --- | --- | --- | --- |
| Q-01 | AI 文件名清洗使用内置服务、元数据插件还是独立插件类型 | 决定配置、网络请求和插件接口 | 建议新增独立声明式 `filename_cleaner` 插件能力，不默认绑定外部模型 |
| Q-02 | 暂停任务允许保留多久 | 决定检查点和临时快照清理策略 | 建议默认保留 7 天，可由管理员配置 |
| Q-03 | 429 自动等待的最长时间 | 当前单次 `Retry-After` 最长采用 30 分钟，但未限制累计等待次数 | 当前保持 `retry_waiting` 并允许用户暂停或终止；累计上限仍可后续配置化 |
| Q-04 | 多扫描根发生路径重叠时由哪个根负责缺失对账 | 决定根 generation 和源文件唯一约束 | 建议保存最深匹配根，配置保存时提示并禁止完全重复根 |
| Q-05 | 失败重试是否默认包含未匹配任务 | 影响按钮默认行为和 TMDB 请求量 | 建议默认只重试错误，未匹配由用户显式选择 |

## 11. 建议实施顺序

1. 先实现 GAP-01 扫描检查点和稳定 scan session，修正暂停/继续语义。
2. 实现 GAP-02 单根 generation 和根完整性，先保证多根扫描的数据安全。
3. 实现 GAP-08 刮削任务快照和失败项精确重试，为后续恢复与诊断建立基础。
4. 已实现 GAP-06 TMDB 可恢复错误和延迟重试，并接入检查点状态机；下一步进行真实限流、断网和恢复联调。
5. 实现 GAP-03 单文件多集拆分以及对应文件关联、详情和清理。
6. 继续补齐 GAP-04 特殊文件名样本，逐批对照真实目录结果。
7. 实现 GAP-07 持久化 TMDB 缓存和延迟详情补全。
8. 在 AI 来源契约确认后实施 GAP-05。
9. 最后完善 GAP-09 持久化刮削决策、Web 展示和方案文档。

## 12. 验收口径

1. 任务扫描到一半暂停或服务进程重启后，继续任务不会从扫描根重新开始，也不会重复累计进度。
2. 多根全量扫描中，一个根出现目录错误时，该根不执行缺失清理；其他完整根仍可独立提交 generation。
3. `S01E01-E02` 或等价命名的一个视频文件生成两个单集条目，两个条目都关联同一个源文件，但节目处理数只计一个。
4. 同一电影的 1080P、4K 和分段文件只生成一个电影海报条目。
5. TMDB 返回 429 时先切换其他健康 Key；全部 Key 暂不可用时任务进入可恢复等待，到期后从检查点继续。
6. 仅重试失败项时，不重新请求已经匹配成功的电影和节目。
7. 搜索候选已命中但详情暂时失败时先保留已匹配条目，后续补全不会生成第二个海报条目。
8. 所有检查点、任务快照和诊断记录都不包含密码、Token、Cookie、Authorization 或可直接播放的定位信息。
9. SQLite、PostgreSQL 和 MySQL 使用相同业务语义；开发库允许重建，但表结构和索引不能只适配 SQLite。

## 13. 非目标

本轮缺失项补齐不包含以下内容：

- Flymby 云同步、云端备份同步和设备间同步队列。
- 服务端视频或音频播放、转码、代理和播放 URL 下发。
- 复制 Flymby 的页面状态、系统通知、后台保活和 HarmonyOS 生命周期代码。
- 音乐和有声书的完整刮削实现；当前仅保证新增任务模型不阻塞后续扩展。
- 未经确认自动接入任何第三方 AI 服务。
