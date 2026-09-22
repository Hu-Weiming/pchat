# Pchat 下一对话开发交接

> **2026-09-22更新**：最终358项测试及全部TypeScript/核心门禁通过，Rust离线测试通过，最新0.1.1已重建安装。三个模块提交 `4925437`、`483d316`、`411bbc4`。实际桌面两次萨特问答及依据显示完成；运行中停止因请求提前完成而未验收，退出重开与完整内容审查仍待完成。不要重复已完成的接入和付费连通测试，先看 DEVELOPMENT-PROGRESS.md 的最新条目。

> **2026-09-21接管更新（优先于下方2026-09-18快照）**：两阶段DeepSeek/串行应用工作流/单次最终生成已编码，工作区仍未提交，SQLite v5、Harness协议3。真实显式萨特/康德/福柯，以及自动维特根斯坦/索绪尔/萨丕尔均完成整轮。最新351项全量测试通过，后续一项编者注过滤测试通过；安装包0.1.1正在重建及本机验收。详情始终以 DEVELOPMENT-PROGRESS.md 为准。
>
> 两份新加密凭证已启用到 `D:/Dev/state/pchat/deepseek-personal.vault`、`qianfan-personal.vault`；不要打印明文，不要调用会回显原始用户Key的目标查询工具。构建先加载 `D:/Dev/pchat-env.ps1`。
>
> 13人现均有正确dataset返回记录。远端费希特修复已生效。维特根斯坦最新发布主分支实际比较 `group` 与“维特根斯坦”，故仅本机 workflowRetrieval 对应group已设该值；人物目录分类仍“分析哲学与语言转向”。原配置备份 `D:/Dev/state/pchat/backups/before-wittgenstein-wire-20260921.json`。今后若远端修正为流派值，应同步改回绑定，不要盲目重试。
>
> 内容尚未通过完整验收：切片混有译者序、出版社说明、编者脚注、疑似误收录内容；代码只做保守过滤和精确连续摘录，不能证明每段都是作者立场。同一人物全时期合辑也可能混合思想阶段。最新实际自动三人回答仍须核对引文归属/段落支持与总结边界。不要因为工程/接口成功就把总目标标记完成。
>
> 下一步先看最新进度，不重新创建目标、不重放已完成付费测试。完成最新包安装、界面真实提问/依据/停止/重开验收，记录明确内容阻塞，提交与推送遵循根目录 AGENTS.md 的最新规则。

核对日期：2026-09-18。工作目录：`D:\Pchat`。本文件是一次接管快照；持续更新的唯一进度记录仍是 [`DEVELOPMENT-PROGRESS.md`](./DEVELOPMENT-PROGRESS.md)。开始编码前先读根目录 [`AGENTS.md`](../AGENTS.md) 和 [`DEVELOPMENT-HANDOFF.md`](./DEVELOPMENT-HANDOFF.md)。

## 1. 整个大任务

交付一个可在 Windows 本地安装和真实使用的哲学学习 Agent。用户选择人物/思想阶段或流派，向不同立场发问，得到区分原典陈述、受约束推演与开放拟构的回答和可核验依据；可在同一会话引入 1–3 位人物、查看立场对照，并在回答期间排队下一问题。首版完成后，依次考虑 Android、线上版和 Apple 平台。本次开发的完成目标是 **Windows MVP 的真实账户、真实资料与产品验收**，不能把离线测试或安装成功当成内容质量通过。

确定的本地结构：React/Vite/TypeScript 界面 → Tauri 2 Rust Host → 私有 stdin/stdout → 捆绑 Node Runtime → 纯 TypeScript PchatHarness → SQLite、DeepSeek ModelPort 与百度千帆 RAGPort。生产版不开放 localhost 服务。人物是经过确认的资料包，不是执行代码的插件。产品规则和不能破坏的运行规则分别见 [`PCHAT-CURRENT-PRODUCT-CONSENSUS.md`](./PCHAT-CURRENT-PRODUCT-CONSENSUS.md) 与 [`RUNTIME-INVARIANTS.md`](./RUNTIME-INVARIANTS.md)。

## 2. 当前文件夹的关键入口

| 路径 | 用途 |
| --- | --- |
| `AGENTS.md` | 开发入口和 D 盘资源约束 |
| `docs/DEVELOPMENT-PROGRESS.md` | 唯一持续进度、验证证据、提交记录 |
| `docs/DEVELOPMENT-HANDOFF.md` | 详细架构、模块依赖及工程背景 |
| `docs/QIANFAN-AGENT-WORKFLOW-PLAN.md` | 2026-09-18 确认的双阶段工作流与未实现差距 |
| `docs/P2-P5-IMPLEMENTATION-PLAN.md` | 阶段计划及 Windows 验收门槛 |
| `docs/WINDOWS-ACCEPTANCE.md` | 已安装版本的操作与待真实账户验证项目 |
| `docs/BUILDING.md` | D 盘构建、缓存与安装命令 |
| `packages/contracts/`、`packages/harness/` | 统一消息契约及可移植领域核心 |
| `packages/providers/`、`packages/storage-sqlite/` | DeepSeek/千帆适配器及 SQLite Store |
| `apps/runtime-windows/` | Windows Runtime 装配、配置及私有协议 |
| `apps/desktop/` | React 正式界面和 Tauri Rust Host |
| `prototypes/pchat-atelier-prototype.html` | 视觉及主交互参考；其中假数据不是正式回答 |
| `scripts/verify-deepseek-live.mjs` | 当前未提交的真实调用验证脚本；先审查再运行 |

需要寻找人物资料时再检查 `D:\kk\pbooking`。该目录目前存在分类文件夹，但不能据此宣称资料已经导入千帆或通过版权、检索、引用验收。

## 3. 计划列表

| 顺序 | 工作 | 当前状态或完成条件 |
| --- | --- | --- |
| P0 | Windows Tauri、Node sidecar、私有通信、SQLite 与 NSIS 技术验证 | 已完成 |
| P1 | Contracts、Headless Harness、单人物、FIFO、停止/恢复、幂等和事件书签 | 已完成，保持回归门禁 |
| P2 | SQLite 持久化、迁移、备份与进程中断恢复 | 已完成工程验证 |
| P3 | Client、1–3 人物、上下文预算与资料隔离 | 基础执行已完成；语义对照待深化 |
| P4 | 正式 Atelier UI 与完整 Windows 操作入口 | 已接线并安装；用户真实操作验收待做 |
| P5 | DeepSeek/千帆 adapter、DPAPI 凭证、Host 限制网络与安装包 | 离线和安装工程验收已通过；真实账户与真实资料待验收 |
| 当前新增工作 | DeepSeek 受限选路 → 千帆只返回已确认原典 → DeepSeek 最终回答 | 方案已确认；选路及所有模式仅用原典尚未完成编码与验收 |
| 发布收口 | 引文/立场质量、真实费用与取消、长历史、安装升级、签名与分发 | 未完成；逐项保留独立验收证据 |

## 4. 现在进行到哪里

- `main` 最新已提交工作为 2026-09-18 的双阶段工作流设计；Windows 0.1.0 已安装到 `D:\Dev\apps\Pchat`。记录中的 329 项测试、类型、依赖和安装页查询/订阅/退出检查通过。这些是既有工程证据，不是当前脏工作树的最新测试结果。
- 当前工作树已有他人未提交的 DeepSeek 真实调用相关修改：`Cargo.toml`、`Cargo.lock`、Rust `network.rs`、Tauri 配置、Runtime 会话、DeepSeek adapter/测试，以及新建的 `scripts/verify-deepseek-live.mjs`。接管者先逐文件审查、保留并验证，不覆盖、重置或直接当成已完成提交。
- 本机应用配置目前有一个已启用的 DeepSeek 连接；用户后来提供的另一个 DeepSeek Key 已单独加密保存，**未替换现有连接**。千帆“应用会话”Bearer 与 app ID 也已保存，**尚未接入当前纯检索 adapter**。
- 本机 Pchat 配置中当前有 0 个已确认检索绑定和 0 个正式人物包；因此不能声称真实哲学问答已经可用。`D:\kk\pbooking` 存在候选资料目录，但已确认千帆知识库 ID 和导入后的资料清单仍需核实。

## 5. 接下来该做的那一步

**先接管并验证未提交的 DeepSeek 改动。** 读取 diff 和脚本，确认不打印/提交凭证、不绕过 Host 允许清单、不无界调用付费接口；按 [`BUILDING.md`](./BUILDING.md) 将所有输出写到 `D:\Dev`，运行相应类型、测试与 Rust 检查。验证通过后将该切片记入进度；Git 提交与推送遵循根目录 AGENTS.md。

随后按 [`QIANFAN-AGENT-WORKFLOW-PLAN.md`](./QIANFAN-AGENT-WORKFLOW-PLAN.md) 实现：

1. DeepSeek 首次调用只提出已登记人物/思想阶段或流派 ID 和中性检索问题。用户显式选人优先；Pchat 限定数量、校验目录并冻结本轮资料范围。无效结果停止，不猜测知识库 ID。
2. 每个人物只检索自己已确认的原典范围；三个知识模式均不让二手研究文本冒充原典。保留原始片段、来源、定位、版本和哈希；零证据不得生成伪有据回答。
3. DeepSeek 第二次调用依据分组编号原文生成回答；核验引用编号、人物归属、知识模式和历史 EvidenceSnapshot。
4. 用假模型/假检索验证 FIFO、停止、未知付费结果、预算和串库；有真实知识库与账户后再做小额度在线冒烟和内容评测。多人物对照需补结论、前提、概念、分歧的可追溯语义整理。
5. 重新打包 Windows 版并完成真实操作验收。未具备资料、账户权限或预算时，明确列出阻塞项，不将其写成通过。

“循环直到成品”以可复核的验收结果为终点：正式页面能用真实已确认人物完成上述完整流程，队列/停止/恢复保持正确，回答与依据可追溯，安装与升级可重复验证，关键安全和内容质量门槛通过。若缺少用户才能提供的知识库 ID、原典导入或供应商权限，应暂停该依赖分支并继续其他安全工作；不要用无限重试、预制答案或扩大权限伪造完成。

## 6. 本机私有凭证交接

以下文件位于公开仓库外、当前 Windows 用户可解密的 `D:\Dev\state\pchat`。文档和聊天均不复制明文 Key。新对话在同一 Windows 用户账户下可以按需使用 DPAPI `CurrentUser` 在内存中解密，并直接送入受限凭证保存/验证流程；不得打印、写日志、加入源码、测试快照或提交。先确认供应商与 endpoint 匹配，再决定是否用于付费验证。

| 文件 | 含义 | 当前状态 |
| --- | --- | --- |
| `deepseek-supplied-20260918.vault` | 用户新提供的 DeepSeek API Key | 已加密保存并回读验证；不同于现有启用的 Key |
| `deepseek-personal.vault` | Pchat 当前 DeepSeek 连接的既有 Key | 不覆盖，除非明确决定切换；现有模型配置见本地 `configuration.json` |
| `qianfan-assistant.vault` | 用户给出的百度千帆 Bearer | 已加密保存并回读验证；属于下述应用会话配置，未证明可访问纯检索接口 |
| `qianfan-assistant-config.json` | 千帆 app ID、`/v2/app/conversation` 地址及状态 | 不含密钥；这是应用会话 API，不是当前 RAG 使用的 `/v2/knowledgebases/search` |

已在聊天中暴露过的密钥应由用户在供应商后台轮换。轮换后更新本机加密凭证，并重新验证，旧值不得进入最终安装包。

## 7. 新对话启动文本

> 请接管 `D:\Pchat`，完整阅读 `AGENTS.md`、`docs/DEVELOPMENT-HANDOFF.md` 和 `docs/NEXT-SESSION-HANDOFF.md`；最新进度以 `docs/DEVELOPMENT-PROGRESS.md` 为准。目标是把 Windows Pchat 做到真实可验收的哲学问答成品。先审查并验证现有未提交改动，再按 `docs/QIANFAN-AGENT-WORKFLOW-PLAN.md` 实现 DeepSeek 受限选路、千帆只检索已确认原典、DeepSeek 最终回答及证据核验，持续测试，Git 提交与推送遵循根目录 AGENTS.md。两个用户新提供的 Key 已在 `D:\Dev\state\pchat` 的 DPAPI vault 中，具体文件和用途见交接文档；只在同一 Windows 用户下按需解密到内存，绝不输出明文。千帆给的是应用会话接口，不要冒充知识库检索；缺少知识库 ID 或已导入资料时明确报告。构建、缓存、日志和临时文件一律放到 D 盘，每次修改配置逐项报告。直到满足交接文档的验收条件，或遇到确实需要用户提供外部资料/权限的阻塞项，再结束循环。
