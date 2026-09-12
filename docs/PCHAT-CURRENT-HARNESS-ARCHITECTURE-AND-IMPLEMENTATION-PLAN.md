# Pchat 当前 Harness 架构与实施计划

更新日期：2026-09-08。状态：**P0 技术验证已通过，下一步为 P1 Harness 编码**。本文件优化并取代旧版架构提案；P0 全程未调用付费接口，实测结果见 [P0-VALIDATION-REPORT.md](./P0-VALIDATION-REPORT.md)。

强制运行规则见 [RUNTIME-INVARIANTS.md](./RUNTIME-INVARIANTS.md)，安全范围与验证要求见 [PCHAT-SECURITY-THREAT-MODEL.md](./PCHAT-SECURITY-THREAT-MODEL.md)。

## 1. 本次优化结论

Pchat 不再被定义为“带有 Agent 模块的 Tauri 应用”，而被定义为：

> **一个可以脱离图形界面运行的哲学 Agent Harness，以及连接到它的若干 Host 和 UI。**

系统中心从 Tauri/React 转移到 **PchatHarness**。Tauri 是 Windows Host，React 是 UI；它们都可以被替换，而不改写哲学运行时。系统浏览器和网络版不进入 Windows MVP。

Atelier 原型 [pchat-atelier-prototype.html](../prototypes/pchat-atelier-prototype.html) 仍是视觉与主交互基准，不是运行时实现基准。原型里的固定哲学内容、伪运行状态、故障开关和日记预览不能直接迁入生产数据。

### 相比 v0.2 的主要变化

1. 把 DiscussionEngine 收敛为核心深模块 **PchatHarness**；对外维持小 interface，内部由 TurnCoordinator 等模块协作，避免巨型类。
2. 把前端调用的多个接口缩减为一套 Harness 协议：**dispatch / query / events**。
3. Windows 推荐后台 Runtime；Tauri 负责启动、托盘和 WebView，Windows MVP 不提供系统浏览器入口。
4. Android 复用 Harness 核心与协议，但不照搬永久后台进程。
5. 明确上下文压缩、人物引入、依赖关系和工具权限。
6. 不采用“所有东西都是插件”；稳定内核封闭，只在确实变化的位置建立 seam。
7. 因为产生了真实的多宿主和多 adapter，改为小型 pnpm workspace。

## 2. 系统形态

### 2.1 Windows 推荐形态

~~~~text
Atelier Web UI（React）
        │ Tauri IPC
        ▼
Pchat Desktop Host（Tauri）
├─ WebView、托盘与显式退出
├─ 安全凭证
├─ 启动和监管 Runtime
└─ 转发受限的 Harness 协议
        │ 私有 Host 通道
        ▼
pchat-runtime（本地后台进程）
├─ PchatHarness
├─ SQLite
└─ Model / RAG adapters
~~~~

- 默认体验仍是安装式 Tauri 应用，用户不需要自己启动服务器。
- 关闭主窗口默认隐藏到托盘；只有“退出 Pchat”才在保存检查点后停止 Runtime。
- Windows MVP 不提供“在浏览器中打开”，Runtime 不监听 localhost 或局域网端口。
- React UI 只通过 PchatClient 和 Tauri IPC 工作；Rust Host 再通过私有通道连接 Runtime。
- Tauri Host 只能启动打包内的固定 sidecar；UI 无权执行任意 shell。
- Windows 只允许一个 Pchat 实例和一个 Runtime 拥有数据库；第二次启动只唤醒已有窗口后退出。
- Runtime 的最终打包方式（捆绑 Node Runtime 或 Node SEA）由 P0 spike 决定，不在纸面上假定可用。

### 2.2 Android 推荐形态

Android 共享 PchatHarness、contracts、React UI 和可跨端的 adapters，但不承诺永久后台进程。默认采用应用内 Runtime；进入后台时保存检查点，恢复后根据任务状态继续、失败或要求确认。

若以后要求熄屏后长期生成，需要单独设计 Android Foreground Service、常驻通知、电量与系统限制。这不是 Windows MVP，也不能用桌面 sidecar 假装已经解决。

### 2.3 未来线上形态

线上版本复用 Web UI 与 Harness 协议，但 Runtime 迁移为远端部署，并新增账户、租户、限额、服务端凭证和数据隔离。届时单独实现经过认证的网络 transport，不能直接复用 Windows 的私有 Host 通道。

### 2.4 修订后的技术栈

| 位置 | 建议选择 | 说明 |
| --- | --- | --- |
| Web UI | React + TypeScript strict + Vite | 只负责交互投影，通过 PchatClient 工作 |
| 样式 | CSS Modules + Atelier design tokens | 保留原型视觉，不引入重型主题框架 |
| Windows Runtime | Node LTS 承载编译后的 TypeScript | 作为受 Tauri 监管的 sidecar；用户无需另装 Node |
| 数据契约 | TypeScript + Zod | commands、queries、events 和 adapter 返回均运行时校验 |
| Windows 本地通信 | Tauri IPC + 私有 Host 通道 | UI 不开放本机网络端口；命令、查询和流式事件仍遵守统一 Harness 协议 |
| 数据库 | SQLite，由 RuntimeStore 独占 | 启用 foreign keys、WAL、busy timeout、版本迁移和迁移前一致性备份 |
| Windows Host | Tauri 2 + 最小 Rust | 只做 sidecar、托盘、凭证、系统生命周期和安全网络 |
| 测试 | Vitest、Testing Library、MSW、少量安装冒烟 | 默认使用 fake adapters，不依赖付费接口 |

v0.2 中“React 通过 Tauri SQL plugin 访问 SQLite”的方向取消，因为独立 Runtime 必须成为数据唯一所有者。具体 SQLite driver 在 P0 比较 Node 内置 sqlite 与成熟 adapter 的打包、事务、迁移和备份表现后锁定；截至本计划编写时，Node 官方仍把 node:sqlite 标记为 release candidate，因此不提前写成确定依赖。

## 3. 核心依赖关系

~~~~text
Tauri UI ───▶ PchatClient ─▶ Transport ─▶ PchatHarness
CLI/Test ───▶ InProcessTransport ────────┘      │
                                               ▼
                                        TurnCoordinator
                           ┌────────────┬─────┴─────┬───────────┐
                           ▼            ▼           ▼           ▼
                    SessionLedger   Context      RoleRegistry  KnowledgeModePolicy
                           │       Assembler         │           │
                           ▼            │            ▼           ▼
                    RuntimeStore ◀───────┼──────▶ ModelPort    RAGPort
                                        │
                                        ▼
                                   Comparison
~~~~

依赖方向只能从外向内：

- UI 依赖 PchatClient，不能导入 Runtime、SQLite、模型或 RAG adapter。
- Runtime 依赖 Host 注入的 ports，不能导入 React、Tauri、DeepSeek 或某个知识库 SDK。
- adapters 依赖 Harness 定义的 interfaces；Harness 不反向依赖 adapters。
- 人物资料包是校验后的数据，不能执行代码或注册系统命令。
- `packages/harness` 只能依赖 ECMAScript、contracts 和注入的 ports，禁止使用 Node、Tauri、React、文件系统、进程或具体 SQLite driver。时钟与 ID 生成器也由外部注入。

## 4. 核心深模块：PchatHarness

PchatHarness 的 interface 只暴露三个动作：

~~~~ts
dispatch(command: HarnessCommand): Promise<CommandReceipt>
query<K extends keyof QueryMap>(query: QueryMap[K]["request"]): Promise<QueryResult<QueryMap[K]["response"]>>
events(after?: EventCursor): AsyncIterable<HarnessEvent>
~~~~

`QueryMap` 固定每种查询与返回类型的对应关系，调用方不能自行指定任意 `T`。Commands 与 Events 同样使用带明确类型标记的联合类型，并在 trust boundary 用 Zod 校验。`QueryResult` 统一包含 `data` 与 `lastEventSeq`。

它隐藏下面这些实现模块：

- CommandProcessor：接收、校验和持久化命令；
- QueryReader：生成带事件书签的只读投影；
- TurnCoordinator：协调一轮对话，不承载所有具体实现；
- ContextAssembler：冻结上下文和预算；
- RoleExecutor：执行各人物的检索与生成；
- EvidenceEngine 与 Comparison：判断依据并生成对照；
- QueueScheduler：按会话排队并控制全局并发；
- RecoveryManager：检查点和重启恢复；
- EventPublisher：发布可重连事件。

这些内部模块默认使用直接的 class/function 协作，不为每个名称制造 interface。只有 Store、Model、RAG、Clock、ID、Credential 和 Transport 等真实变化位置建立 seam。UI 不需要学习内部顺序；CLI、React 和测试都通过相同 interface 驱动 PchatHarness。

## 5. 强依赖、条件依赖与可删除模块

### 5.1 主流程强依赖

| 模块 | 为什么不能删除 |
| --- | --- |
| PchatHarness / TurnCoordinator | 删除后问题无法形成可执行轮次 |
| SessionLedger / RuntimeStore | 队列、历史、恢复和幂等失去可信状态 |
| ContextAssembler | 无法确定模型本轮究竟看到了什么 |
| RoleRegistry | 无法解释人物身份、阶段和资料范围 |
| ModelPort | 无法生成回答 |
| KnowledgeModePolicy | 删除后无法限制原典、推演与拟构模式分别允许说什么 |
| ClaimSupportEvaluator | 删除后无法判断回答内容受到何种程度的依据支持 |
| RAGPort | 原典解读和有据推演无法成立；自由扮演可不使用 |

### 5.2 与主流程耦合但保持内部的模块

- **QueueScheduler 与 RuntimeStore**：领取必须事务化，否则可能重复付费或丢消息。
- **ContextAssembler 与 TokenBudgetPlanner**：压缩必须服从模型窗口和证据预留。
- **RoleRegistry、RAGPort、KnowledgeModePolicy 与 ClaimSupportEvaluator**：资料范围、检索结果、允许陈述的内容和支持等级必须共同判断。
- **RoleRun 与 Comparison**：对照只能使用本轮有效回答，不能重新发明立场。
- **CredentialVault 与 SecureTransport**：凭证值不能穿过普通 UI 协议。

这些耦合是领域本身要求的内聚，不应为了“看起来解耦”再包一层空 interface。

### 5.3 删除后不影响基础哲学问答

- React 或 Tauri WebView：换成测试客户端仍可使用 Harness。
- 多人物对照：删除后仍能进行单人物问答。
- 流派筛选与人物目录页面：人物可直接按 ID 调用。
- 浅/深主题、依据台动画和其他视觉功能。
- 日记、评论、学习模式、自动辩论、社区、同步。
- 故障模拟器、验收场景和架构说明弹窗。
- 本地工具调用与插件市场。
- DeepSeek 或某一家知识库：替换 adapter，不修改 Runtime。

## 6. 上下文系统

### 6.1 上下文不是聊天记录的简单拼接

ContextAssembler 每次为一个 RoleRun 生成不可变的 ContextSnapshot。不同人物共享相同的历史讨论视图，但各自追加自己的角色定义和检索证据。

上下文从高到低分为：

1. 系统安全与证据规则；
2. 当前会话的知识模式；
3. 当前思想阶段资料包；
4. 当前问题与本次人物快照；
5. 当前人物检索到的证据；
6. 最近完整对话；
7. 更早对话的结构化摘要。

待发送消息、思想日记、其他人物的资料包和未来队列项永远不得进入当前轮次。

### 6.2 压缩策略

- 原始消息永久保存在 SQLite；压缩只改变本次模型输入，不删除历史。
- 最近若干完整轮次按 token 预算保留，不按固定消息条数硬切。
- 较早内容压缩为 ConversationCheckpoint，字段固定为：用户明确问题、用户明确主张、已澄清概念、各人物已表达立场、未解决分歧、对应 turn IDs。
- 摘要不得推断用户未表达的思想，不得成为哲学原典依据。
- 每个摘要保留覆盖的起止事件序号和生成版本，可重新生成和审计。
- 摘要失败时降级为缩短历史尾部，不阻塞当前问题，也不伪造摘要。
- 证据预算优先于闲聊历史；响应预算不能被历史无限挤占。

### 6.3 模型执行预算

由 TokenBudgetPlanner 根据实际模型窗口计算，而不是写死字符数：

| 内容 | 初始上限建议 |
| --- | --- |
| 系统规则与模式 | 15% |
| 人物资料包 | 10% |
| 检索证据 | 30% |
| 最近对话与检查点 | 25% |
| 回答输出预留 | 20% |

这些百分比属于可调的 ModelExecutionPolicy，不进入领域模型，也不是哲学规则。领域不变量只保留优先级：系统安全与当前问题优先，其次是人物资料和必要证据，再次是最近对话，较早摘要最后。接入真实模型与真实 RAG 后重新校准具体比例。

## 7. 思想人物如何引入

思想人物不是类、进程或可执行插件，而是 **ThoughtStagePackage**：

~~~~text
manifest
├─ packageId / packageRevision / status
├─ 人物名与思想阶段
├─ 允许的 corpus scopes / corpusRevision
├─ retrievalConfigRevision / promptPolicyRevision
├─ 适用范围与禁用声明
├─ 人物表达说明
├─ 推荐概念与继续阅读
└─ 完整性与人工确认状态
~~~~

加载流程：

1. PackageLoader 读取内置资料包。
2. SchemaValidator 校验结构和版本。
3. RoleRegistry 按 packageId + packageRevision 注册。
4. 提交问题时分别冻结人物包、资料库、检索规则、提示规则、模型与参数版本。
5. Runtime 按 scope 独立检索。
6. 历史回答保存各项版本与实际执行快照，不随升级静默改变；这些信息用于审计，不承诺随机模型能够逐字复现答案。

新增人物只新增资料包和云端资料范围，不修改 PchatHarness 核心规则。早期与晚期维特根斯坦是两个 packageId。用户自定义包以后可复用同一格式，但 MVP 不开放任意代码。

## 8. 插件与扩展策略

### 8.1 MVP 的真实 seams

| Seam | 首个生产 adapter | 测试/未来 adapter |
| --- | --- | --- |
| ModelPort | DeepSeek | FakeModel；以后 OpenAI 等 |
| RAGPort | 待选知识库 | FakeRAG；以后其他供应商 |
| RuntimeStore | SQLite | InMemoryStore |
| Transport | TauriIpcTransport + 私有 Host 通道 | InProcessTransport；以后 Android HostTransport / BrowserHttpTransport |
| CredentialVault | Windows 安全凭证 adapter | FakeVault；以后 Android adapter |

生产 adapter 与测试 adapter 使这些 seam 真实存在。

ModelPort 与 RAGPort 由 Harness 定义统一 interface，具体供应商 adapter 反向依赖并实现该 interface；Harness 永远不知道 DeepSeek 或具体知识库 SDK。首版先在同一 adapter package 内按供应商目录组织，出现第二个真实供应商或依赖冲突后再拆成独立 package。FakeModel、FakeRAG、InMemoryStore 与 FakeVault 统一放入 `packages/testing`，不混入生产 adapter。

### 8.2 暂不插件化

- FIFO 和轮次状态机；
- 三种知识模式的安全下限；
- ContextSnapshot 的基本结构；
- 证据不足和直接引文规则；
- 命令、事件和持久状态的合法迁移。

这些是 Pchat 身份的一部分。允许插件覆盖它们会让扩展绕过产品承诺。

### 8.3 不照搬“Everything is a plugin”

Pi 的价值在于小内核；DeepSeek Harness 的插件机制适合借鉴扩展思想，但不应复制其全部复杂度。MVP 不提供全局事件拦截器、任意 waterfall hook、运行时代码下载或插件市场。

以后只有在第二个真实需求出现时才增加 typed hook；扩展只能缩小权限，不能放宽系统证据规则。

## 9. 是否包含本地工具调用

Windows MVP **不向哲学人物开放本地文件、Shell、浏览器自动化或任意程序执行**。

模型调用和 RAG 检索是 Runtime 受控依赖，不视为人物自主工具。这样可以避免把哲学学习产品提前变成通用电脑 Agent。

保留未来 ToolPort，但不实现 ToolRuntime。未来若加入原典文件导入、笔记搜索或网页查证，必须同时具备：

- 每工具独立 schema；
- capability 最小权限；
- 调用前授权策略；
- 路径和网络 scope；
- 超时、取消和输出上限；
- 审计记录；
- 工具结果按不可信内容处理；
- 工具不能修改系统规则、人物资料范围或证据等级。

## 10. 命令、事件与持久化

### 10.1 Commands

首版稳定命令：

- CreateConversation
- SubmitQuestion
- ChangeParticipants
- ForkConversationWithMode
- StopTurn
- ResumeQueue
- WithdrawQuestion
- DeleteConversation
- SaveConnection

每个会改变状态的命令携带 commandId。Runtime 持久化处理结果；同一 commandId 重试只能返回原结果，不能重复创建问题、轮次或调用尝试。该幂等规则只约束 Pchat 内部命令，不能保证外部供应商只执行一次。

每次外部模型调用都保存独立的调用尝试记录。若 Runtime 崩溃时请求可能已被供应商接收但本地未取得确定结果，该尝试进入 `OUTCOME_UNKNOWN`；恢复流程不得自动重试。用户明确选择重新生成后，系统创建新的调用尝试，并保留新旧尝试之间的关联。只有某供应商提供且经验证的幂等能力时，对应 adapter 才可安全自动重试。

每个 EvidenceSnapshot 保存当时实际送给模型的依据文本、sourceId、sourceRevision、稳定定位、内容校验值、corpusRevision 与 retrievalConfigRevision。历史回答读取自己的快照，不用知识库当前内容替换；不能只保存可能随重新切分而失效的知识库指针。

### 10.2 状态机

Question、Turn、RoleRun 和外部调用尝试分别拥有明确状态；不得用零散布尔字段代替。一个 Question 只创建一个 Turn，每位参与人物各创建一个 RoleRun；RoleRun 可在全局限制内并发，Turn 在所有 RoleRun 收敛及可选 Comparison 完成后结束。`StopTurn` 作用于该 Turn 下所有未完成的 RoleRun。P1 必须写出完整状态转换表，所有非法转换由 Runtime 拒绝并测试。外部调用结果不确定时，调用尝试进入 `OUTCOME_UNKNOWN`，其 RoleRun 进入等待用户决定状态；不把两者混成同一个状态。

### 10.3 Events

持久事件只记录业务里程碑：

- QuestionAccepted / QuestionWithdrawn
- TurnStarted / TurnStopped / TurnFailed / TurnCompleted
- RoleStarted / RoleCompleted / RoleFailed
- EvidenceCaptured
- ComparisonCompleted
- QueuePaused / QueueResumed

文本 token 增量属于实时事件，不逐 token 永久保存；Runtime 定期保存草稿检查点。`RoleRunProjection` 至少包含 status、textSoFar、revision 与 lastEventSeq。SQLite 中的持久状态是唯一权威，事件流只负责通知变化。每个查询投影都返回 `lastEventSeq` 作为快照书签，UI 随后只订阅该序号之后的事件。断线后重新读取权威投影和新书签，不依赖重放全部 token。

### 10.4 Queue 调度

- 同一 Conversation 同时最多运行一个 Turn，问题严格 FIFO。
- 不同 Conversation 可以并行，由全局调度器限制同时运行的 Turn、RoleRun 和外部调用数量。
- 具体并发数字属于可调运行配置，在真实模型与费用测试后确定。

### 10.5 不采用完整 Event Sourcing

SQLite 规范化表仍是当前状态的权威存储；durable event journal 用于 UI 重连、审计和诊断。避免为了架构形式而把所有状态重建都变成事件回放。

## 11. Windows 本地通信与安全

- Windows MVP 不开启 localhost 网页服务，也不提供系统浏览器入口。
- React UI 通过受限的 Tauri commands / channels 调用 Rust Host，不能访问任意系统能力。
- Rust Host 只转发经过校验的 Harness 命令、查询和事件，不提供任意命令执行或任意网络代理。
- Runtime 与 Host 进行协议版本握手；私有通道的具体实现由 P0 spike 决定。
- 凭证值永远不返回 UI，也不进入普通 Harness 协议。
- 软件和安装包永远不内置 API Key；用户手动填写后，由 Windows CredentialVault 保存。朋友测试只能使用负责人另行提供的测试专用密钥，不能使用长期主密钥。
- Runtime 只能按 connectionId 请求已登记的供应商连接；Rust Host 校验供应商与端点允许清单、注入凭证并发送请求，绝不提供“任意网址＋任意请求”的网络代理。
- 日志不记录 token、授权头或完整敏感请求。
- 显式退出时先暂停领取、保存检查点，再停止 Runtime。

未来真正开发网页版时再新增经过认证的 BrowserHttpTransport，并单独完成网络安全评审。

### 11.1 版本与升级顺序

AppVersion、ProtocolVersion、SchemaVersion 与 PackageSchemaVersion 独立管理。启动时由 Host 先确保旧 Runtime 已退出，再对需要迁移的数据库创建一致性备份、执行迁移、启动版本匹配的 Runtime、完成协议握手，最后显示可操作 UI。任何一步失败都必须停止启动并保留诊断与备份，不能让不匹配版本继续写数据库。

## 12. 推荐 workspace

~~~~text
D:/Pchat/
├─ apps/
│  ├─ web/                    # Atelier React UI
│  ├─ desktop/                # Tauri Host
│  └─ runtime-windows/        # 本地后台装配与私有 Host 通道
├─ packages/
│  ├─ contracts/              # commands, queries, events, schemas
│  ├─ harness/                # PchatHarness、TurnCoordinator 与领域规则；禁止 Node/Tauri API
│  ├─ client/                 # PchatClient
│  ├─ adapters-model/         # DeepSeek；第二个真实供应商出现后再决定是否拆包
│  ├─ adapters-rag/           # cloud RAG；按真实供应商目录组织
│  ├─ adapters-store/         # SQLite
│  └─ testing/                # FakeModel / FakeRAG / InMemoryStore / FakeVault
├─ prototypes/
├─ docs/
├─ pnpm-workspace.yaml
└─ package.json
~~~~

依赖纪律：

~~~~text
contracts ← harness ← runtime-windows
contracts ← client  ← web
harness   ← adapters
web       ← client
desktop   → runtime sidecar（部署关系，不导入 Harness 业务）
~~~~

packages 数量由真实 seams 决定。实现中若某个 adapter 只有少量文件，可以合并目录，不为图表完整制造空包。

## 13. Atelier 原型映射

| 原型能力 | Runtime 归属 | UI 归属 | MVP |
| --- | --- | --- | --- |
| 会话历史 | SessionLedger / Store | 左栏投影 | 是 |
| 调整 1–3 位人物 | 命令与提交快照 | 人物选择器 | 是 |
| 三种知识模式 | KnowledgeModePolicy | 会话创建/分叉入口 | 是 |
| FIFO 等待消息 | QueueScheduler / Store | 输入框上方投影 | 是 |
| 流式人物回答 | RoleRun | 回答卡片 | 是 |
| 依据快照 | ClaimSupportEvaluator / Store | 可收纳依据台 | 是 |
| 立场对照 | Comparison | 折叠对照表 | 是 |
| 人物目录 | RoleRegistry | 目录页面 | 是 |
| 深浅主题 | 无 | UI 偏好 | 是 |
| 故障模拟/验收场景 | Test adapters | 开发界面 | 仅开发 |
| 日记与评论 | 独立未来模块 | 预留导航 | 否 |
| 固定哲学答案和引文 | 无 | 无 | 禁止迁移 |

## 14. 修订后的实施顺序

### P0：六项架构 spike

状态：**已完成**。Windows MVP 采用“捆绑 Node Runtime + 私有 stdin/stdout + `node:sqlite`”；SEA 暂不采用，`better-sqlite3` 保留为可替换后备。完整证据和限制见 [P0 技术验证报告](./P0-VALIDATION-REPORT.md)。

1. Tauri Host 启停固定 sidecar、托盘隐藏和显式退出。
2. 实测 bundled Node + better-sqlite3、bundled Node + node:sqlite、SEA + node:sqlite 三种 Runtime/SQLite 组合；根据安装、启动、签名、杀毒软件、原生依赖、升级、迁移、备份和崩溃表现选择，不预设 SEA 胜出。
3. React 经 Tauri IPC 调用 Rust Host，再由私有 Host 通道连接 Runtime；验证命令、查询和流式事件。
4. Runtime 通过 connectionId 使用凭证与受限网络；验证端点允许清单，且不向 UI 返回 Key。
5. 验证 single-instance、唯一 Runtime 所有者、崩溃清理和孤儿进程恢复。
6. 验证 SQLite 打包、foreign keys、WAL、busy timeout、版本迁移、迁移前一致性备份及恢复。

同时核验 Node LTS、pnpm、Rust stable MSVC、Visual Studio C++ Build Tools、WebView2 和 NSIS。

完成标准：空白 Runtime 可由 Tauri WebView 操作且不开放本机网络端口；重复启动只唤醒已有窗口；关闭窗口不终止任务；显式退出无孤儿进程；测试数据库升级失败时可从备份恢复。若 sidecar 打包或 HostPort 不可靠，回退到“同进程 Harness + Transport interface”，而不是推倒核心。

### P1：Contracts 与 Headless Harness

- 建立 workspace、contracts、PchatHarness 和 TurnCoordinator。
- 先用 InMemoryStore、FakeModel、FakeRAG。
- 用测试/最小 CLI 驱动 CreateConversation、Submit、Stop、Resume。
- 完成正式状态转换表、commandId 幂等和带快照书签的事件重连。
- 使用 QueryMap 固定每种查询与返回类型的对应关系，并为 Commands、Queries、Events 建立运行时校验。
- 用依赖检查阻止 harness 导入 Node、Tauri、React 和具体 adapter。

完成标准：不启动 React 或 Tauri，也能跑通单人物完整轮次。

### P2：SQLite、FIFO 与恢复

- 建立 SessionLedger、问题、轮次、RoleRun、依据、检查点和 event journal。
- 实现按 Conversation 的事务领取、撤回、停止、恢复和迟到事件隔离；不同 Conversation 由全局调度器控制并发。
- 固化 SQLite 连接设置、schema_version、migration table、事务边界、迁移前一致性备份与恢复流程。

完成标准：A 运行时提交 B/C，A 看不到 B/C；崩溃恢复不得自动重新执行接收状态未知的外部调用，并能提示用户确认是否重新生成。

### P3：上下文与 Fake 闭环

- 完成 ContextAssembler、可重建摘要与 ModelExecutionPolicy。
- 使用 FakeModel、FakeRAG 验证资料隔离、上下文冻结、预算优先级和草稿检查点。

完成标准：无需真实模型或正式 UI，能够证明排队中的新问题不进入当前轮次，人物不读取其他人物资料，压缩不编造用户观点。

### P4：Atelier Web UI 与 Tauri Host

- 将原型 design tokens 与布局迁移到 React。
- UI 只依赖 PchatClient，不直接访问数据库或 provider。
- 完成 Tauri 默认窗口和托盘。

完成标准：WebView 与测试 client 通过同一 Harness 协议操作，行为一致。

### P5：DeepSeek 与安全连接

- 实现 ModelPort 的 DeepSeek adapter。
- 完成 CredentialVault、SecureTransport、流、取消、超时、限流、未知用量与脱敏日志。
- SecureTransport 只接受 connectionId 和结构化供应商请求，由 Host 校验允许的供应商端点并注入凭证。
- 模型与端点属于 Connection，不写入人物包。

完成标准：本机最小真实调用成功；Key 不出现在 UI、Harness 协议、SQLite、日志或测试快照。

### P6：真实 RAG 与证据

- 确定知识库后实现 RAGPort adapter。
- 先接入 1–2 个经确认的 ThoughtStagePackage。
- 验证原典/研究资料、空结果、缺元数据、引文降级和包含实际依据文本及版本信息的历史依据快照。
- 用真实 token 统计校准 ModelExecutionPolicy 与 Checkpoint。

完成标准：单人物真实 RAG 闭环，回答能够区分原典陈述、推演和拟构。

### P7：多人物与对照

- 复用同一 Runtime 执行 2–3 个 RoleRun。
- 一个问题只创建一个 Turn，每位人物创建一个 RoleRun；`StopTurn` 停止该 Turn 下所有未完成 RoleRun。
- 新人物看到讨论语境，但不能继承其他人的证据。
- 至少两个有效回答后才产生 Comparison。

完成标准：无串库、冒名补答、模式污染和伪对照；并发与费用预算生效。

### P8：内容评测

- 分批接入约 20 个思想阶段，逐包记录准备、确认和验收状态。
- 分别评测检索召回、论断支持度、引文完整性、上下文压缩损失和阶段混淆。

完成标准：首批资料包通过检索召回、论断支持度、引文完整性、上下文压缩损失和阶段混淆的发布门槛。

### P9：Windows 打包、升级与发布

- 构建 NSIS 测试安装包，验证安装、升级、四类版本匹配、数据库迁移、显式退出和卸载数据策略。
- 在干净 Windows 环境、升级环境和模拟迁移失败环境完成冒烟测试。

发布阻断项：串库、虚构出处、Key 泄漏、Tauri 权限越界、恢复流程自动重试状态未知的付费调用、孤儿后台进程和已确认问题丢失。

### Windows 后的 Android 阶段

- 使用相同 contracts、harness 与 React UI。
- 新建 Android HostTransport、CredentialVault 和生命周期 adapter。
- 先验证前台运行、后台暂停/恢复和系统杀进程；再决定是否需要 Foreground Service。
- 真机验证键盘、安全区、长文、网络切换和 SQLite 迁移。

Android 不进入 Windows MVP 完成条件。

Android 复用的是 contracts、PchatHarness 领域规则与可跨端 React UI，不复用 Windows 的 Node sidecar。Android 阶段必须提供自己的 Store、Credential、Transport 和生命周期 adapters；Windows 开发期间通过依赖检查和无 Node 环境测试保证 Harness 可移植，不提前实现 Android。

## 15. 测试结构

| 测试面 | 主要验证 |
| --- | --- |
| PchatHarness interface | 命令结果、合法状态迁移、事件顺序、带书签的查询投影；测试不穿透内部模块 |
| Store contract | 事务领取、幂等、WAL、迁移、备份恢复和崩溃恢复 |
| Model/RAG contracts | 分片、缺字段、鉴权、断流和取消 |
| Context fixtures | 压缩前后保留用户主张、分歧和 turn IDs，不产生新观点 |
| Transport contract | InProcess 与 Tauri IPC 对同一命令产生等价结果 |
| UI | 只断言用户可见状态，不读取 Runtime 内部变量 |
| Windows 安装 | single-instance、sidecar、托盘、WebView2、退出、升级和迁移失败恢复 |

测试遵守“replace, do not layer”：主要通过深模块 interface 验证行为；内部重构不应迫使所有测试改写。

## 16. 暂不实现

- 人物自主本地工具、Shell、文件和浏览器自动化；
- 任意第三方运行时代码插件、插件市场；
- 日记、评论、学习模式、自动辩论、社区；
- Android、线上版、Apple 客户端；
- 本地模型和跨设备同步；
- 安装包内置 Key、朋友使用负责人长期主 Key、系统浏览器入口或局域网访问。

## 17. 已确认决策与设计停止线

### 已经确定

- Tauri 2 + TypeScript；
- Windows → Android → 线上 → Apple 的顺序；
- Atelier 原型作为视觉和交互基准；
- 模型和知识库供应商可替换；
- 人物按思想阶段和独立资料范围组织。

### 本轮确认

1. Pchat 的产品核心定义为 Headless Harness，而不是 Tauri UI。
2. Windows 使用 Tauri Host + 后台 TS Runtime + 单一 WebView 入口；不开放 localhost 网页服务。
3. 外部 Harness interface 只保留 dispatch、query、events。
4. PchatHarness 是核心深模块；TurnCoordinator 只负责协调，队列、上下文、证据和恢复由内部模块协作。
5. 人物是数据包，不是可执行插件。
6. MVP 不提供本地工具调用和任意插件。
7. 使用小型 pnpm workspace 支持真实的多宿主与 adapter。
8. Android 复用逻辑架构，但不保证复用 Windows daemon 进程形态。

架构审查与 P0 六项技术验证均已完成，下一步进入 P1 Harness 编码。除非实现证据证明当前路线不可行，否则不再增加微服务、完整 Event Sourcing、复杂 DI 框架、插件系统或其他预想扩展。若后续 Windows sidecar 或 HostPort 出现实测问题，保留相同 Harness interface 并替换部署 adapter，不推翻领域核心。

## 18. 官方事实依据

- [Tauri：嵌入并受限启动 sidecar](https://v2.tauri.app/develop/sidecar/)
- [Tauri：前端 SPA 与 Vite](https://v2.tauri.app/start/frontend/)
- [Tauri：Capabilities 权限](https://v2.tauri.app/security/capabilities/)
- [Tauri：Content Security Policy](https://v2.tauri.app/security/csp/)
- [Tauri：Windows 与 Android 前置要求](https://v2.tauri.app/start/prerequisites/)
- [Node.js：Single Executable Applications 仍处于 active development](https://nodejs.org/api/single-executable-applications.html)
- [Node.js：node:sqlite 当前稳定性与接口](https://nodejs.org/api/sqlite.html)
- [Android：Foreground Service 约束](https://developer.android.com/develop/background-work/services/fgs)
- [Pi：Minimal Agent Harness](https://pi.dev/)
- [DeepSeek Harness：Everything is a plugin（Developer Preview）](https://www.deepseek.com/harness/en/)
