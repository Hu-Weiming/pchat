# Pchat 当前开发进度

更新日期：2026-09-14。当前阶段：P1 完整门禁通过，P2–P5 优化计划已写入，P2 SQLite Store 验收通过，继续 P3 执行与宿主接入。

本文件是本次开发唯一的进度入口，每个开发步骤和提交前更新。产品规则仍以产品共识和运行不变量为准；实施细节见 [P1 工作流](./P1-WORKFLOW.md)。

## 已确认范围

- 用户已扩展授权：优化 P2–P5 后持续开发至可操作的 Windows 产品验收；顺序、依赖与门槛见 [P2–P5 计划](./P2-P5-IMPLEMENTATION-PLAN.md)。
- P1 Contracts 与 Headless Harness 已完成：纯 TypeScript、内存 Store、FakeModel/FakeRAG、注入时钟与 ID，单人物完整轮次、FIFO、停止/恢复、内部幂等、查询投影与事件书签。
- 用户在百度千帆控制台上传和管理资料，Pchat 通过独立检索 adapter 读取指定知识库；P5 实现 DeepSeek/千帆接口及配置入口，尚无真实 Key/资料，在线与内容结果另行验证。
- 照顾 Web/Android 复用：数据契约可序列化；核心无 Node/Tauri/React/DOM 依赖；取消和宿主生命周期显式建模，存储与凭证由宿主装配。
- Git 按可验证模块分步本地提交；本次没有推送或发布要求。

## 步骤与验收

| 步骤 | 状态 | 验证证据 |
| --- | --- | --- |
| 接管、权威文档、Git 与基线类型检查 | 已完成 | 初始 main 无业务修改，仅上一轮两份调研草稿；pnpm check 三个包通过 |
| 工作流细化、提交规范、测试环境 | 已完成 | Vitest 5 / Vite 8；输出路径显式要求 PCHAT_DEV_ROOT；Conventional Commits |
| 正式契约与输入校验 | 已完成 | schema 推导共享数据类型；查询类型绑定、严格包配置与投影校验已通过 |
| 注入 ports、内存事务和单人物完整轮次 | 已完成 | 2 项 Harness 测试通过；实际 Fake 依据及 RAG/MODEL 独立尝试可查询；testing 11 项测试 |
| FIFO、上下文冻结、幂等 | 已完成 | A/B/C、20 个并发重复命令、撤回、终态非法命令、运行中修改人物不影响已提交问题通过 |
| 停止、恢复、未知结果和明确重新生成 | 已完成 | 迟到结果、旧运行者隔离、显式重做、提交回执延迟、PREPARED 恢复、结果回滚及连续持久化失败通过 |
| 事件书签、依赖和跨端检查 | 已完成 | AST 23 项；无平台全局完整闭环；事件8项覆盖丢失窗口、并发读取、退订和错误清理 |
| P1 完整验收 | 已完成 | pnpm check:p1：14 文件、137 测试，业务/测试类型、依赖和无平台闭环全部通过；独立审计发现两处问题，修复后回归通过 |
| P2–P5 优化 | 已完成 | 多人物工程前移 P3，千帆与安装工程收口 P5；真实内容评测保留独立门槛 |
| P2 SQLite Store | 已完成 | 16项测试、workspace/测试类型通过：持久化、事务、独占、迁移、备份、真实进程中断恢复、FIFO/停止/书签与差异写入 |
| P3 client 契约 | 进行中 | 14项测试通过，协议/输入/投影校验、幂等与相关性、书签/缺口、挂起退订；无平台VM通过client实际闭环；继续宿主衔接 |
| P3 多人物与上下文 | 进行中 | 1–3人物、独立快照/调度、共享预算、停止与未知重做通过；SQLite v3及旧库迁移通过；上下文预算/检查点继续实施 |
| P5 DeepSeek独立adapter | 进行中 | 41项离线ModelPort测试通过；网络/凭证Host与真实账户未接入 |
| P5 千帆独立adapter | 进行中 | 44项离线RAGPort测试通过；严格确认清单/版本/hash核验；自动只读清单采集继续实施 |
| P4 UI、P5 Host/安装 | 进行中 | 正式Atelier页面、Windows client通道与Host装配开发中 |

## TDD 记录

采用已确认的公共测试面：contracts schema、PchatHarness 的 dispatch/query/events、Store 与 Model/RAG ports。不通过私有方法断言业务状态。每次推进一个失败场景，再实现通过；提交仅包含通过验证的完整切片。

- 基线：`pnpm check` 通过（contracts、runtime-windows、desktop）。
- 契约四轮 red → green：依次观察缺少 schema、SubmitQuestion discriminator、控制命令 discriminator、查询 schema 导致的失败，再实现；当前 4 项契约测试通过。
- `pnpm check` 和 `pnpm check:tests` 通过。尚未宣称 Harness 业务场景通过。
- 环境负例：未设置 PCHAT_DEV_ROOT 时测试明确失败；Vite 临时配置、cache 和 coverage 未写入仓库，Vitest cache 位于开发根目录。
- Harness 创建用例先因缺少实现失败，再通过；单人物完整轮次先因 SubmitQuestion 拒绝失败，再通过。
- InMemoryStore 的事务、回滚、输入输出引用隔离和通知隔离已做 red → green；Fake ports 支持逐次控制和无视取消的迟到返回。
- `pnpm check`、`pnpm check:tests`、AST 依赖检查及 `check:portable` 通过。portable 检查器先证明会拒绝平台全局访问与不完成的流程，真实闭环从 Question submission failed 到通过。
- 队列 4 项、恢复 4 项通过：停止/暂停/撤回先失败再实现；FIFO、并发幂等及后加恢复变体为已有基础能力的回归，不冒充新的红灯。
- 事件 8 项：前4项竞态回归原实现通过；后4项先失败，修复挂起read退订、重复return、read错误清理与超前书签。
- 证据策略20项 red → green：范围/版本/重复ID、知识模式、来源类型、引文元数据；空依据原典/推演直接输出资料不足，不调用模型。
- 配置与类型42项：非法输入、配置快照隔离、安全错误、QueryMap编译负例；配置0费用合法，但调用必须受预算控制。
- 调用上限与预算3项 red → green：唯一外部槽、未知费用保留、重新生成不绕过全局执行上限。
- 故障3项 red → green：旧执行者等到 IN_FLIGHT 提交回执后仍外发、连续两次持久化失败后自动重复调用，均已复现并修复。Store 的同步提交状态通知负责立即撤销执行权限，存储持续失败时停止执行器。
- 生命周期9项回归通过：停止/暂停自身回执被延迟仍不得外发、延迟工厂被新运行者替代、PREPARED 取消、结果事务单次回滚、命令原子回滚后同 ID 仅接受一次。
- 2026-09-12 20:40 本机完整 P1 验收通过，共134项；测试不启动 React、Tauri、SQLite 或付费服务。

- 2026-09-14：独立审计补 PREPARED 写入回滚预算释放（RAG/MODEL两项）与 FICTION 非法引用一项，均经过红→绿；P1 137项完整门禁通过。

- Client 14项（逐步红→绿）：独立 requestId 重试同一 commandId、输入/响应校验、错误脱敏、事件连续性、退订和调用者输入快照。依赖检查扩展client新增10项负例，当前纯核心测试147项通过，另14项client测试通过。

- P3 目录投影：新增 ListRoles（保留草稿/确认区分，草稿不能创建执行会话）与 Conversation.settings；两项公共查询测试先红再绿，149项纯核心回归、测试类型与无平台client闭环通过。

- P2 Store 16项通过：真实子进程确认问题/草稿后强制结束并等待exit，重开保持未知尝试且不自动外发；显式重新生成保留关联。12轮8KB历史+16次checkpoint的WAL增长由26,384,480字节降至小于1MiB；仍完整读取/复制状态，超长历史CPU成本需后续测量。

- DeepSeek ModelPort 41项离线测试通过：SSE/严格JSON提前流式正文、冻结配置、取消与迟到清理、终止原因、错误脱敏和大小限制；01:06由主任务复跑通过。独立包类型曾通过，当前共享core正在多人物迁移，统一类型门禁待收口。未用真实网络/Key。

- P3 多人物12场景通过：2/3人物、PENDING、独立槽/共享预算、资料不足排除、保留已完成同伴、全员停止、单人物未知重做、恢复与FIFO。对照保存有效原答案列，不宣称已完成结论/前提/概念的语义分析。client协议升级为2，旧版本明确拒绝。
- SQLite v3 23项通过：固定非空v2旧库真实迁移、原commandId/回执幂等、关联未知尝试和事件保留、迁移失败回滚、2/3人物重开；独立role_contexts表避免流式草稿反复写长历史，保持原WAL增长门槛。
- 01:21主任务复跑核心、client、SQLite、脚本与Windows通道，共23文件206测试通过；完整check:p1亦通过（162项及工作区/测试类型、依赖与无平台门禁）。通道6项涵盖回放、取消、背压与协议拒绝；正式Host接线和页面仍在开发。
- 千帆44项离线RAGPort测试通过，01:25主任务复跑providers共85项通过：限定单知识库与文档、核验切片版本/内容hash、保留来源、取消与错误脱敏。官方search/详情时间格式示例差异仍需真实账户验证，不能宣称联网版本核验已通过；自动只读清单采集正在实施。

## 本地环境

所有安装、测试和检查前在当前命令中加载仓库外的本地环境配置。TEMP/TMP、npm/pnpm 缓存、pnpm virtual store、Node 编译缓存与输出根目录都在用户指定 D 盘开发根目录。机器绝对路径不加入共享工具配置。测试工具通过 `PCHAT_DEV_ROOT` 派生缓存、覆盖率和构建输出路径。

构建包装脚本现自动设置自身/子进程的输出与缓存环境，Runtime/前端产物及Tauri暂存工程均在开发根目录；详见 [构建说明](./BUILDING.md)。Runtime/前端构建、暂存、Tauri info与捆绑Node通信冒烟通过，尚未运行原生编译/安装。

没有修改系统环境、C 盘系统目录或已安装软件配置。具体本地路径随执行在对话中逐项报告。

## 提交记录

本次起点：`54b383c`。

1. `67ddc9c docs(p1): define portable workflow and progress`：设计、进度与三份一手调研。
2. `bc4b41e feat(contracts): add validated portable harness messages`：基础契约与 Vitest 工具；4 项契约测试、业务及测试类型检查通过。
3. `feat(harness): run single-role turns with injected ports`：单人物、Store/Fake ports、查询与初始 journal；新增依赖与跨端检查，综合门禁为 pnpm check:p1。
4. `feat(harness): enforce queue recovery and evidence policies`：停止/恢复、幂等与非法转换、事件清理、证据模式、配置及预算边界。

5. `df0388a fix(harness): fence cancelled and uncertain external attempts`：同步撤销外发权限、持久化失败停机、未发尝试释放预算与引用完整性；137项P1门禁通过。

6. `a59806b docs: align delivery plan with Windows product acceptance`：统一进度入口并同步P2–P5交付计划。
7. `e60d540 feat(client): add validated portable harness transport`：版本化通信、client与InProcessTransport、事件生命周期、client跨端门禁。

8. `feat(harness): expose role catalog and conversation settings`：前端可读取可选资料包及当前设置，保留查询快照。

9. `cc48b20 feat(storage): persist harness state with crash-safe SQLite ownership`：关系表、差异事务、在线迁移备份及真实进程恢复验收。

10. `build: route desktop artifacts through the development output root`：构建/缓存路由、独立原生暂存与本机说明。

11. `feat(providers): adapt DeepSeek streams behind secure network port`：仅通过connectionId/attemptId/结构化操作与测试网络交互；不代表真实接入验收。

12. `feat(harness): coordinate multiple roles with durable snapshots`：多人物执行、协议2与SQLite v3迁移；保留原P1停止、幂等和恢复约束。
13. `feat(providers): retrieve Qianfan evidence against confirmed manifests`：独立RAG adapter及离线负面/取消/响应边界测试；不上传用户资料，不调用真实账户。

## 待后续阶段验证的风险

- SQLite已验证迁移与真实多进程中断恢复；仍不能替代物理断电、目标安装环境与长历史性能验证。
- FakeModel/FakeRAG 不能证明真实调用费用、取消效果、召回或哲学回答质量。
- 核心跨平台检查不能替代 Android/Web 宿主的生命周期、网络、凭证与集成测试。
