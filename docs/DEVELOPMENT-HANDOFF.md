# Pchat 正式开发交接

更新日期：2026-09-14

仓库：<https://github.com/Hu-Weiming/pchat>

当前分支：`main`

当前阶段：P0、P1 已完成；用户已授权优化并持续实施 P2–P5，交付可操作的 Windows 产品验收。唯一进度入口为 [DEVELOPMENT-PROGRESS.md](./DEVELOPMENT-PROGRESS.md)，具体顺序见 [P2-P5-IMPLEMENTATION-PLAN.md](./P2-P5-IMPLEMENTATION-PLAN.md)。

## 1. 接管时先确认

1. 阅读本文以及文末列出的权威文档。
2. 执行 `git status --short --branch`，确认工作区状态；保留用户已有修改。
3. 在任何安装、构建或测试前，将本次进程使用的 `TEMP`、`TMP`、包缓存和构建目录指向 `D:\Dev` 下的专用目录。
4. 先执行 `pnpm check` 验证现有基线，再推进当前阶段；P1 完整门禁为 `pnpm check:p1`。
5. P1 测试仍保持纯 Harness 与替身。按优化计划依次增加 SQLite、client、多人物与上下文、正式 UI、安全供应商 adapter 和 Windows 验收，不把未提供 Key/资料的在线结果记为通过。

完成上述检查，且现有类型检查通过后，才视为接管完成。

## 2. 产品目标与首版范围

Pchat 面向哲学初学者和爱好者。系统中的“人物”是受资料约束的思想立场模型，不宣称复活历史人物。目标是帮助用户说清一个问题中至少两个立场的结论、前提、核心概念、分歧和文本依据，并能继续阅读原典。

Windows MVP 包含：

- 单人物问答；
- 用户手动选择二至三位人物进行立场对照；
- 原典、推演、开放拟构三种知识模式；
- 回答生成期间继续接收消息，并按会话严格 FIFO；
- 可收纳的依据视图、会话历史和流式回答；
- 约二十个按思想阶段计数的内置资料包，具体名单由用户决定。

Windows MVP 不包含日记、评论、学习出题、自动辩论、社区、自定义人物、跨设备同步、本地模型和通用本地工具。Android、线上版、Apple 客户端依次后置。

知识模式的权限递增：

- 原典模式：只表达可由原典直接支持的内容；
- 推演模式：允许基于原典原则进行受约束推导，并标明推演性质；
- 开放拟构：只有用户主动选择后才允许创作性回答。

证据不足时可以建议用户切换开放拟构，系统不得自动切换。原典直接引文缺少可核验版本或稳定定位时只能概述，不能伪装成逐字引文。

## 3. 已确定的系统形态

Pchat 的核心是可脱离 UI 测试和运行的 `PchatHarness`。Windows 桌面程序采用已经通过 P0 实测的结构：

```text
React WebView
  → Tauri IPC
  → Rust Host
  → 私有 stdin/stdout
  → 捆绑 Node Runtime
  → PchatHarness
  → SQLite / Model / RAG adapters
```

Windows MVP 不启动 localhost 服务，也不提供系统浏览器入口。关闭窗口时应用隐藏到托盘，显式退出才停止 Runtime。Tauri 保证单实例，Rust Host 负责启动、监管和清理捆绑 Runtime。

Rust Host 只承担平台特权：进程生命周期、托盘、凭证、安全网络和 IPC 转发。哲学对话、队列、上下文、人物调度、证据规则与恢复逻辑属于 TypeScript Runtime。SQLite 由 Runtime 独占写入，UI 不直接访问数据库。

Android 将来复用 contracts、PchatHarness 和可跨端 React UI；Windows Node sidecar、凭证、Store 和生命周期 adapter 不直接复用到 Android。

## 4. 核心模块和依赖方向

```text
UI → PchatClient → Transport → PchatHarness
                              ├─ TurnCoordinator
                              ├─ SessionLedger / QueueScheduler
                              ├─ ContextAssembler
                              ├─ RoleRegistry / RoleExecutor
                              ├─ KnowledgeModePolicy / EvidenceEngine
                              ├─ Comparison / RecoveryManager
                              └─ injected ports
                                  ├─ RuntimeStore
                                  ├─ ModelPort
                                  ├─ RAGPort
                                  ├─ Clock / IdGenerator
                                  └─ EventPublisher
```

`PchatHarness` 是核心深模块，对外 interface 维持三个动作：

```ts
dispatch(command: HarnessCommand): Promise<CommandReceipt>
query<K extends keyof QueryMap>(query: QueryMap[K]["request"]): Promise<QueryResult<QueryMap[K]["response"]>>
events(after?: EventCursor): AsyncIterable<HarnessEvent>
```

interface 包括类型、状态约束、排序、错误和幂等语义。内部模块默认直接协作；只有存在生产 adapter 与测试 adapter 的位置才建立 seam。不要为每个内部类创建透传 interface，也不要加入容器式 DI 框架、全局事件总线或任意插件 hook。

依赖纪律：

- UI 只依赖 `PchatClient` 和展示模型；
- `packages/harness` 只依赖 ECMAScript、`packages/contracts` 和注入的 ports；
- Harness 禁止导入 Node、Tauri、React、SQLite driver、DeepSeek 或具体知识库 SDK；
- adapter 依赖并实现 Harness 定义的 interface，Harness 不反向依赖 adapter；
- 人物资料包是经 schema 校验的数据，不能执行代码或注册命令。

## 5. 已确定的技术栈

| 位置 | 选择 |
| --- | --- |
| 工作区 | pnpm workspace |
| 主要语言 | TypeScript strict；Rust 仅用于 Tauri Host |
| UI | React + Vite + CSS Modules / Atelier design tokens |
| 桌面宿主 | Tauri 2 |
| Windows Runtime | 捆绑 Node LTS，TypeScript 编译后运行 |
| 数据契约 | TypeScript discriminated unions + Zod trust-boundary 校验 |
| 本地通信 | Tauri IPC + Rust/Runtime 私有 stdin/stdout |
| 数据库 | SQLite；P0 选择 `node:sqlite`，封装在 `RuntimeStore` 后 |
| 测试 | Vitest、Testing Library、MSW、fake adapters、少量安装冒烟 |
| 安装包 | Tauri NSIS |

`node:sqlite` 在 P0 环境仍有实验性警告，因此 Store seam 必须保持可替换。`better-sqlite3` 是后备；Node SEA 因签名破坏和成熟度问题未采用。项目根 `package.json` 的 `private: true` 只阻止误发布 npm 包，不影响 GitHub 仓库公开。

## 6. 当前仓库实际状态

```text
apps/desktop/          P0 React 诊断界面与 Tauri Rust Host
apps/runtime-windows/  P0 Node Runtime、SQLite 与私有协议 probe
packages/contracts/    P0 probe 与正式 Harness 协议、投影和 Zod schema
packages/harness/      P1 纯 TypeScript 领域核心与 ports
packages/testing/      InMemoryStore、可控模型/检索替身、时钟与 ID
prototypes/            已确认的 Atelier 静态交互原型
docs/                  产品、架构、安全、验证和资料审计
scripts/               Node sidecar 打包准备脚本
```

P0 代码已证明以下能力可行：

- Tauri 启停并清理捆绑 Node Runtime；
- Tauri IPC 和 stdin/stdout 请求、响应、流式事件；
- single-instance、托盘隐藏和显式退出；
- SQLite foreign keys、WAL、busy timeout、迁移备份和失败恢复；
- `connectionId`、供应商允许清单和假密钥不泄露结构；
- NSIS 构建与安装。

P1 已实现正式 Harness 契约、单人物轮次、FIFO、幂等、停止/恢复、快照和事件书签；完整门禁137项测试及类型、依赖、无平台闭环通过。`apps/desktop/src/App.tsx` 仍是 P0 诊断界面。正式 SQLite schema、生产模型/RAG adapter、正式 UI 和人工确认的人物内容待后续阶段实现。仓库中没有真实 API Key。

构建产物、`node_modules`、数据库、临时目录、捆绑 Node 二进制和 Tauri 生成 schema 已被 `.gitignore` 排除。历史构建缓存可能仍占用本地磁盘，但不属于 Git 内容。

## 7. P1 验收基线（已通过，后续必须保持）

P1 应增加这些 package：

```text
packages/harness/   纯 TypeScript 领域核心
packages/testing/   InMemoryStore、FakeModel、FakeRAG、FakeClock、FakeId
```

`packages/client` 只在确实需要接 UI/Transport 时创建，不要为了目录图提前创建空包。P1 按以下顺序推进：

1. 在 `packages/contracts` 定义正式的 Command、Query、Event、Projection 和错误联合类型，并在外部输入处提供 Zod schema。
2. 写出 Question、Turn、RoleRun、ExternalAttempt 的完整状态转换表；非法转换必须返回领域错误。
3. 实现最小 `PchatHarness`、会话创建、问题提交、单人物 Turn、停止和恢复队列。
4. 注入 InMemoryStore、FakeModel、FakeRAG、Clock 和 IdGenerator；禁止在 Harness 内自行创建具体依赖。
5. 实现 commandId 内部幂等、查询 `lastEventSeq` 和 `events(after)`。
6. 增加依赖检查，证明 Harness 在没有 Node、React 和 Tauri 的环境中可运行。

P1 必须通过的场景：

- 创建会话并提交一个问题，可得到一个单人物完整轮次；
- A 正在回答时提交 B、C，执行顺序严格为 A、B、C，且 A 的上下文不包含 B、C；
- 相同 commandId 重试不产生第二个问题、轮次或调用尝试；
- `StopTurn` 终止本轮所有未完成 RoleRun，迟到结果不能覆盖最终状态；
- 非法状态转换被拒绝；
- 查询投影和事件书签之间不存在丢失窗口；
- 整套测试不启动 React、Tauri、SQLite 或付费接口。

满足全部场景，并通过类型检查和依赖检查后，P1 才完成。

## 8. 实现时不可破坏的规则

- 一个 Conversation 同时最多有一个 active Turn；同一会话的问题严格 FIFO。
- Turn 开始后冻结人物、知识模式、模型、资料范围和版本；后续设置变化不影响本轮。
- 每位人物只能使用自己的 corpus scope；其他人物发言不能替代其资料依据。
- Comparison 只能整理本轮至少两个有效回答已经表达的内容，不能新增哲学论断。
- 原始消息保存在 SQLite；上下文压缩只改变模型输入，不删除历史。
- 排队问题、思想日记、其他人物资料包不得进入当前 RoleRun 上下文。
- commandId 只保证 Pchat 内部幂等。供应商结果不确定时记录 `OUTCOME_UNKNOWN`，不得自动重试。
- SQLite 持久状态是权威；实时事件只负责通知变化。
- API Key 不进入安装包、UI、Harness 协议、SQLite、日志或测试快照。
- Model 与 RAG 只通过统一 port 和 adapter 接入。MVP 不向人物开放 Shell、文件系统、浏览器自动化或任意工具执行。

完整且编号化的不变量以 [`RUNTIME-INVARIANTS.md`](./RUNTIME-INVARIANTS.md) 为唯一来源。若实现确实需要改变规则，先更新产品共识和不变量，再修改代码。

## 9. D 盘开发约束

C 盘空间不足。后续所有构建、测试和安装操作应使用 `D:\Dev` 下的项目专用目录，例如：

```text
D:\Dev\temp\pchat
D:\Dev\pnpm-store
D:\Dev\cargo-home
D:\Dev\cargo-target\pchat
D:\Dev\logs\pchat
```

在当前终端或项目级配置中设置 `TEMP`、`TMP`、pnpm store、`CARGO_HOME` 和 `CARGO_TARGET_DIR`。Android 阶段再为 Gradle 增加 D 盘缓存。不要移动 C 盘系统目录，不要改动已安装软件自身的配置目录。每次配置修改后向用户报告变量、工具配置、路径和作用范围。

目前 Rust 依赖曾使用 `D:\Rust\.cargo`，但下一轮仍需检查实际环境，不能只依赖本文记录。不得把机器专用绝对路径提交进共享源码配置；优先使用会话环境变量或不提交的本地配置。

## 10. 已知风险和未决项

- 首个 RAG adapter 已由用户选定为百度千帆：用户在控制台上传文档，Pchat 检索；未来开发机 RAG 通过同一 port 扩展，本次不实现。真实哲学资料尚未准备，召回与引用评测仍待完成。
- DeepSeek 是首个模型 adapter，但型号、参数、端点和 Key 均不能写进领域核心或人物包。
- CredentialVault 目前只有假凭证边界验证，真实 Windows 凭证保存尚待实现。
- P0 证明 sidecar 可打包和管理，不等于业务状态机、付费调用恢复和长期升级已经可靠。
- 模型供应商通常无法提供 Pchat 可验证的 exactly-once；崩溃后的不确定调用必须由用户决定是否重新生成。
- 上下文预算百分比是待真实模型校准的执行策略，不是固定领域规则。
- 人物资料由用户准备，但导入成功不代表资料正确；上线前需要检索召回、引文完整性、论断支持度和阶段混淆评测。
- 当前安装包没有商业代码签名；正式分发前仍需解决签名和升级测试。

## 11. 权威文档顺序

发生冲突时按以下方式处理：

1. [`PCHAT-CURRENT-PRODUCT-CONSENSUS.md`](./PCHAT-CURRENT-PRODUCT-CONSENSUS.md)：产品目标、范围和用户行为。
2. [`RUNTIME-INVARIANTS.md`](./RUNTIME-INVARIANTS.md)：必须保持的运行规则。
3. [`PCHAT-SECURITY-THREAT-MODEL.md`](./PCHAT-SECURITY-THREAT-MODEL.md)：安全要求与发布阻断项。
4. [`PCHAT-CURRENT-HARNESS-ARCHITECTURE-AND-IMPLEMENTATION-PLAN.md`](./PCHAT-CURRENT-HARNESS-ARCHITECTURE-AND-IMPLEMENTATION-PLAN.md)：模块、技术选择与阶段计划。
5. [`P0-VALIDATION-REPORT.md`](./P0-VALIDATION-REPORT.md)：已经完成的技术实测证据。
6. [`../CONTEXT.md`](../CONTEXT.md)：领域词汇定义。
7. [`../prototypes/pchat-atelier-prototype.html`](../prototypes/pchat-atelier-prototype.html)：视觉和主交互参考，不是业务数据或运行时规范。

资料来源审计位于本目录的 `PHILOSOPHY-*` 文档，只在处理人物选择、原典来源和版权时读取。

## 12. 新对话启动文本

可将下面内容直接作为新开发对话的第一条消息：

> 请继续 `D:\Pchat` 的正式开发。先完整阅读根目录 `AGENTS.md` 和 `docs/DEVELOPMENT-HANDOFF.md`，再按权威顺序核对实现及 `docs/DEVELOPMENT-PROGRESS.md`。保持 P1 验收通过，按 `docs/P2-P5-IMPLEMENTATION-PLAN.md` 持续开发至可操作的 Windows 产品验收。首个模型 adapter 为 DeepSeek，首个 RAG adapter 为百度千帆独立检索；用户稍后填写 Key 和准备知识库，在线及内容评测不得虚报通过。所有构建输出、缓存、日志和临时文件放到 `D:\Dev`，修改配置后逐项报告。采用 TDD、完整验证并分步提交到本地 Git，不推送。
