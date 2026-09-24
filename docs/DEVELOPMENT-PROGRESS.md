# Pchat 当前开发进度

更新日期：2026-09-24。当前阶段：Windows 0.1.1 已完成真实桌面问答、依据抽屉、多人停止与中断重开验收；针对一份失真的冻结萨特证据，新版生成规则重放通过。完整内容质量验收仍未通过。用户确认本机可用为交付目标，授权真实调用费用；新流程为一次选路、串行逐人物检索、等待全部返回后一次合并生成各人物回答/点评/总结。不能把链路成功视为内容质量通过。下方按日期记录，最新条目优先于早期接管快照。

### 2026-09-24 概述与总结保真

- `pchat-discussion-prompt-v3` 要求有据论断逐句保留原典的主语、否定、条件、范围和语气强度，综合总结只能压缩有效回答已经表达的判断。知识模式原有的推演和显式拟构权限不变。排队或恢复时冻结的v1/v2仍使用原版本提示。未增加模型调用阶段或自动重试。
- 复用安装版首个萨特问题的持久依据快照，仅将私有重放输入的提示版本改为v3。一次真实DeepSeek最终生成完成，回答准确区分“选择不由先天价值决定”与“不能选择价值”，总结未再推成“责任受处境限制”。私有证据：`D:/Dev/temp/pchat/content-replay-v3-input.json`、`D:/Dev/temp/pchat/workflow-live-Q9XS7b/discussion-result.json`。该单样例只能证明针对已发现失真的改善，不代表全部人物、阶段或文档的语义支持度通过。
- 聚焦测试先失败再修复；全量38文件365项测试、工作区与测试类型、核心依赖和portable检查通过。Windows 0.1.1已重新打包安装到`D:/Dev/apps/Pchat`，安装版Runtime SHA256与本次构建相同；页面ListConversations、ListRoles、订阅及退出清理通过。私有安装证据：`D:/Dev/temp/pchat/installed-acceptance-16226588-4d50-4293-af6d-9b69f82d17dd/result.json`。未修改环境或工具配置。

### 2026-09-24 无引号逐字摘录校验

- 在公开Harness问答边界复现：来源缺少可核验引文元数据时，模型把长段原文去掉引号并标为PARAPHRASE，旧校验仍会结算。新增省略标点/空格后连续复制片段的保守检测，覆盖中文较长片段和更长的其他文字片段；有完整元数据的合法引用与短概念名称仍按原规则处理。
- 这是逐字复制检测，不证明意思必然正确，也无法发现改写少量字的近似引用。当前人物资料中的编者说明、访谈和跨阶段混入仍需来源治理。
- 聚焦测试先失败再修复；全量38文件368项测试、工作区及测试类型、核心依赖和portable检查通过。0.1.1再次构建并安装，安装版Runtime哈希与构建一致；页面查询、订阅、退出清理通过，私有证据`D:/Dev/temp/pchat/installed-acceptance-8647dd4c-d944-4816-9380-5420b6bf0b2f/result.json`。安装前只读数据库确认没有运行中的轮次；安装后原D盘应用已重新打开。未修改环境或工具配置。

### 2026-09-24 短片段中的编者说明隔离

- 公开RAGPort测试先复现：短检索片段同时包含无标题的“编者按”与作者正文时，旧快速路径会把两段一起当成PRIMARY证据。现在明确标记的编者、译者及校注行触发逐段筛选，去掉该段，并保留命中正文在原始片段中的精确起止位置。没有把访谈一概改判为二手资料。
- 全量38文件369项测试、工作区/测试类型、依赖和portable检查通过；Runtime与前端D盘暂存构建通过。当前安装版尚未包含此最新片段过滤修复，待下一次安装包更新；完整资料作者归属仍需人工审计。本次未修改环境或工具配置。

### 2026-09-24 OCR目录与文件名包装隔离

- 复用已保存的13人检索结果做只读审计，发现克尔凯郭尔一份依据片段包含文件名、独立“目录”行和正文。公开RAGPort测试先复现短片段被整体当作PRIMARY证据；现在丢弃含独立目录行的混合片段，并从其他片段中去掉千帆返回的文件名包装，重新计算原始连续摘录的起止位置。未发起新付费检索。
- 全量38文件371项测试、工作区/测试类型、依赖及portable检查通过；Runtime和前端D盘暂存构建通过。安装版仍待包含此修复，历史证据快照不改写。用户新确认人物本人访谈可用但必须标明访谈来源；将在下一模块记录和实现。未修改环境或工具配置。

### 2026-09-24 访谈来源标记第一版

- 用户确认人物本人访谈可作原典依据，但必须标明访谈来源；产品共识与INV-025已记录。千帆工作流仅在文档名称明确表明“访谈/Interview”、且摘录中的所有署名发言都属于当前人物时标记INTERVIEW；采访者片段不进入证据，混合文集里只有人物标签、无法核实访谈出处的片段暂不使用。一般正文主题标签仍可用。
- 证据快照新增可选访谈来源形式，旧历史保持可读取。新版`pchat-discussion-prompt-v4`把来源形式传给DeepSeek并要求回答标注访谈；v1-v3的冻结提示和渲染保持不变。前端在有效回答旁及依据抽屉直接显示访谈来源，避免只依赖模型措辞。
- 公开RAGPort与ModelPort测试先失败再修复。并行执行测试与类型检查时5项SQLite/依赖用例因资源争用超时，单独重跑38文件375项全通过；工作区/测试类型、依赖、portable和D盘Runtime/前端暂存构建通过。未发起新付费调用，尚未为现有混合文集里的访谈核实具体来源，也未安装包含本模块的新版。环境或工具配置未修改。

## 早期接管快照（后续已分模块提交）

- 已审查既有未提交改动，接管基线330项测试通过。已启用用户新提供的两份本机加密凭证，配置和旧凭证备份在 `D:/Dev/state/pchat/backups/before-workflow-20260919-000619`；从未把明文写入源码、文档或日志。
- 13人物工作流绑定及两阶段DeepSeek已装配，自动/显式选人、串行检索、原典范围约束、单次最终生成、点评与总结、流式草稿、整轮未知恢复已实现。SQLite v5保存discussion状态与尝试；Harness协议升为3，Windows宿主外层协议仍为2。
- 萨特/康德/福柯真实完整链路通过：`D:/Dev/temp/pchat/workflow-live-ul1QDg/result.json`。一次PLAN、三次RAG、一次DISCUSSION，无自动重试。此前 `workflow-live-xXb9sj` 的最终结果被校验拒绝，保留失败证据，不计为通过。后续加入短引用别名和私有诊断输出以降低长编号错误并定位拒绝原因。
- 内容抽查发现译者序、目录、出版社说明、译名说明和疑似误收录网文。增加保守排除与原文连续区间摘录，保留原始哈希和区间；启发式过滤不能代替资料清理，完整内容验收未通过。
- 13人物逐一真实检索：11人返回资料；费希特、维特根斯坦请求成功但所有output为null。证据 `D:/Dev/temp/pchat/workflow-live-rSgPAg/result.json`，复核响应在 `workflow-live-aMKEv7`。用户2026-09-21确认已修复并发布，继续调查节点执行；不得将其直接认定为未发布或空知识库。
- 最新全量349项测试、业务/测试类型通过；依赖与portable检查此前348项阶段通过。后续新增停止时短草稿保留、按人物占用并发额度两项测试通过，仍需最新全量重跑。
- 独立静态复审：Standards无确定违规；Spec发现短草稿尾段/旧尝试丢失及按轮计数绕过人物额度，均已修复并补测试。尚待安装级验证及最终复核。
- 所有输出仍在D:/Dev。诊断仅用Host读取DPAPI；异步节点诊断端点仅编译进Rust测试程序，不进入发布版。
- 下一步：定位两条全null分支，最新代码真实生成/内容复核，安装升级与队列/停止/重开/依据显示验收，更新交接，Git 提交与推送遵循根目录 AGENTS.md。

### 2026-09-21 真实安装与后续修复

- 0.1.1已安装到D:/Dev/apps/Pchat；安装页查询/订阅/退出清理通过，证据 `D:/Dev/temp/pchat/installed-acceptance-aecc283b-14c2-4df5-a791-b7f8cb5526de/result.json`。实际界面完成显式萨特原典模式提问、依据抽屉、暂停队列入队与撤回；窗口显示为“Pchat · 思想之间”。启动工具曾误开C盘旧P0，已通过其“保存并退出”关闭，之后明确启动D盘新版；没有修改旧安装配置。
- 13人均已有正确dataset返回记录。费希特在异步节点诊断及普通检索复测通过（`workflow-live-suH8t1`）。维特根斯坦主分支实际将group与“维特根斯坦”比较；本机对应workflowRetrieval.group已适配，原配置备份 `D:/Dev/state/pchat/backups/before-wittgenstein-wire-20260921.json`。诊断证据 `workflow-live-eOTB43`，兼容值实测 `workflow-live-4uVUz9`。
- 自动选择维特根斯坦/索绪尔/萨丕尔整轮通过（`workflow-live-O1OkJJ`）。纯提问commentary为空。
- 安装版追问曾因模型将INSUFFICIENT_EVIDENCE列入有效summary而失败，复用冻结最终输入定位（`workflow-live-POBcoE`）。已让资料不足正常结算、用固定提示代替无依据/越模式的模型文本，并抑制依赖无效立场的总结；不自动重试模型。
- 原来的每文档两段限制会让合辑中先命中的访谈挤掉真正相关章节。已移除该限制，仍保留片段去重、最多6段与7000字符总预算。同一失败问题在PRIMARY模式完成有据概述（`workflow-live-CJt1w3`），不是仅以“资料不足”计通过。
- 三人18段检索曾把本地审计字段错误计入模型预算（`workflow-live-BaBg0N`）。已由provider按实际渲染的prompt计算上界，Harness保留全量审计快照；新增对应测试及计数/实际网络请求一致性断言通过。
- 最新全量356项通过；随后预算修复与新增测试14项通过，待最终全量及最新安装包重新验收。当前安装程序仍需要重建以包含最后这几项修复。UI观察记录在 `D:/Dev/temp/pchat/windows-ui-20260921/acceptance.json`，其中停止点击曾与终态竞态，不能记为停止通过。

### 2026-09-22 最终回归与打包

- 接管类型检查通过；全量358项中有一项失败：某人物的越模式回答被丢弃后，模型仍可通过未声明该人物的共同点评/总结沿用该观点。已修复为出现任一无效立场时不展示共同点评/总结，保留其他有效人物的独立回答；不增加供应商重试。该公开Harness回归测试先失败、修复后通过。
- 最新358项测试、业务类型、测试类型、核心依赖与portable检查全部通过。日志 `D:/Dev/logs/pchat/20260922-tests.log`、`20260922-check.log`。Rust离线凭证测试通过；两项真实付费探针保持显式忽略，没有重放已完成的付费调用。
- 环境沿用已有 `D:/Dev/pchat-env.ps1`，未修改系统或用户配置。Runtime、前端、Rust及安装包仍全部输出到D:/Dev。
- 内容抽查仍未达到整体验收：已有自动三人回答的推演与跨思想阶段归属须人工核对，资料清理问题保留。工程检查通过不等于内容验收通过。
- 最新0.1.1发布编译、NSIS打包及D:/Dev/apps/Pchat覆盖安装完成。安装页查询/订阅/退出清理通过：`D:/Dev/temp/pchat/installed-acceptance-a076a33d-f957-4227-a000-5a2a95e063a0/result.json`。捆绑Runtime与构建文件SHA256一致；宿主仅3字节差异，对应Tauri安装类型标记NSS与打包后恢复的UNK，不是旧程序残留；记录 `D:/Dev/logs/pchat/20260922-installed-build-verification.json`。
- 实际桌面保留原历史与13人目录，新增“新版验收：停止与重开”会话，两次萨特真实请求均完成，4段依据的抽屉显示和已引用标识通过。尝试运行中停止时请求已结束，停止控件失效，不能记为停止通过。记录 `D:/Dev/temp/pchat/windows-ui-20260922/acceptance.json`；本轮没有完成退出后重开验收，应用保持打开供用户检查。
- 分模块本地提交：`4925437`（Contracts/Harness/SQLite及协议消费测试）、`483d316`（DeepSeek/千帆adapter）、`411bbc4`（Windows装配、界面、显式真实探针）。所有私有凭证、配置、数据和实测原文仍在仓库外。

### 2026-09-22 多人停止与中断重开验收

- 安装版显式选择萨特、康德、福柯，在生成期间点击“停止本轮”，三人均显示已停止，保留175/212/8字未完成草稿，队列自动暂停。此记录替代此前停止点击竞态造成的未通过状态。
- 暂停时从真实界面提交B、C，顺序显示正确，没有执行新轮次。确认全库没有RUNNING轮次后，仅对本次验收启动的Host及其捆绑Runtime做受控强制关闭，再启动同一D盘安装程序。
- 重开后界面保留历史、三人停止状态、草稿和B/C队列。只读快照比对包括会话、问题、轮次、人物、证据及discussion尝试，前后SHA256均为 `557d1acf85dbc9b5a66f4b94c89347030260c92f8ead4619c974d95247067460`，没有自动重试。该项是暂停后中断恢复测试；正常退出清理由既有安装探针覆盖。
- 私有证据：`D:/Dev/temp/pchat/windows-ui-20260922/persistence-before-result.json`、`persistence-after-result.json`、`before-restart.txt`、`after-restart.txt`。验收会话保持暂停供用户检查，B/C尚未执行，不将队列显示顺序误记为真实接口FIFO完成；调度FIFO由Harness测试覆盖。
- GitHub推送此前两次因443连接超时失败，四个提交仍在本地，未声称远端已更新。继续按AGENTS.md每个完成模块独立提交并尝试已授权推送。

### 2026-09-22 引文标签绕过修复

- 核对安装版两份萨特完成回答与其已引用片段。选择/责任概述有对应文本；处境/选择回答在PARAPHRASE标签下包含长篇逐字引文，但来源版本、译者、稳定定位均为空，违反既有引用规则。
- 经公开Harness边界先复现PARAPHRASE/INFERENCE两种漏检，再增加正文校验：识别引用来源中逐字出现的长篇引号内容，要求匹配来源具备完整引用元数据；保留短概念标签及有完整元数据的合法嵌入引文。无效输出拒绝结算为有效回答，不自动重复付费。
- 这是已观察到的逐字引用格式绕过防线，不是对所有语义归属或所有标点变体的证明。未更改原典/推演/拟构权限，也没有改写历史回答。完整语义和资料归属审查仍是未完成项。
- 362项全量测试、业务/测试类型、依赖与portable全部通过，证据 `D:/Dev/logs/pchat/20260922-quote-tests.log`、`20260922-quote-check.log`。当前安装包尚需包含此最新修复；安装结果另记。
- GitHub已成功接收 `4925437`；推送下一个模块时再次443连接超时，其余提交尚未确认远端同步。

### 2026-09-22 开放拟构空检索修复

- 双阶段流程原先在任何模式检索全空时直接结算资料不足，并额外拒绝空证据的FICTION；这与已有单人物流程允许用户主动开启创作的规则不一致。公开Harness测试先复现最终生成未调用，修复后仅显式FICTION可以继续生成并标注拟构，PRIMARY/INFERENCE仍保留证据不足限制，虚构引用仍被拒绝。
- 最终生成提示升级为 `pchat-discussion-prompt-v2`，明确区分资料不足与用户主动允许拟构。排队/恢复中冻结的v1输入继续使用原v1提示；按各自真实渲染计算预算。未知提示版本在网络调用前拒绝。
- 364项全量测试、业务/测试类型、依赖与portable检查通过：`D:/Dev/logs/pchat/20260922-fiction-tests.log`、`20260922-fiction-check.log`。没有为此增加付费调用。此修复完成后独立提交，随后更新安装包。
- 引文修复版已通过安装查询/订阅/退出清理：`D:/Dev/temp/pchat/installed-acceptance-7e341939-e232-475c-8df1-7a72b67108e5/result.json`；Runtime哈希与构建一致。GitHub已收到 `483d316`，后续模块仍受连接超时影响。

### 2026-09-22 最新安装与待内容验收

- 包含正文引文校验及FICTION修复的0.1.1已重建并安装到D:/Dev/apps/Pchat。安装页面查询、订阅、退出清理通过：`D:/Dev/temp/pchat/installed-acceptance-3fd505dd-b73a-461c-8d7a-874231c98e4c/result.json`。捆绑Runtime与本次构建哈希一致；原验收会话快照保持完整。没有修改环境配置。
- 所有模块已逐次推送到GitHub main，截至 `e319ea8`；此前连接失败已恢复。后续继续执行每完成一个功能/模块立即独立Commit的规则。
- [内容验收记录](./CONTENT-ACCEPTANCE-20260922.md)列出两份真实萨特回答的具体结论：主体来源可追溯，但个别概述/总结扩大原意；引文格式漏洞已修复，完整语义支持度仍未通过。总目标保持进行中。

本文件是本次开发唯一的进度入口，每个开发步骤和提交前更新。产品规则仍以产品共识和运行不变量为准；实施细节见 [P1 工作流](./P1-WORKFLOW.md)。

## 已确认范围

- 用户已扩展授权：优化 P2–P5 后持续开发至可操作的 Windows 产品验收；顺序、依赖与门槛见 [P2–P5 计划](./P2-P5-IMPLEMENTATION-PLAN.md)。
- P1 Contracts 与 Headless Harness 已完成：纯 TypeScript、内存 Store、FakeModel/FakeRAG、注入时钟与 ID，单人物完整轮次、FIFO、停止/恢复、内部幂等、查询投影与事件书签。
- 用户在百度千帆控制台上传和管理资料，Pchat 通过独立检索 adapter 读取指定知识库；P5 实现 DeepSeek/千帆接口及配置入口，尚无真实 Key/资料，在线与内容结果另行验证。
- 2026-09-18 用户确认知识库只返哲学家原始文本和中性来源；DeepSeek 先识别人物/流派，再根据检索证据作最终回答。设计见[双阶段工作流](./QIANFAN-AGENT-WORKFLOW-PLAN.md)；第一次选路及所有模式只检索原典仍待实现。
- 照顾 Web/Android 复用：数据契约可序列化；核心无 Node/Tauri/React/DOM 依赖；取消和宿主生命周期显式建模，存储与凭证由宿主装配。
- Git 规则统一见根目录 AGENTS.md；用户于2026-09-22确认按此前要求推送 GitHub。
- 最新推进要求：以可操作产品和真实接入为近期目标，已有验证通过后不重复扩展测试或重构；仅为实际问题补验证，保留局部替换边界，不建设插件平台。

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
| P3 client 契约 | 已完成 | 15项client及12项Windows通道测试通过；正式Host与安装页面已接线 |
| P3 多人物与上下文 | 基础执行完成 | 1–3人物、独立快照/调度、共享预算、停止与未知重做；按窗口保留完整历史/摘录检查点，SQLite v4保存实际MODEL输入；语义对照仍需深化 |
| P5 DeepSeek独立adapter | 工程接入完成 | 41项离线ModelPort测试通过；Host白名单网络与DPAPI凭证已装配，真实账户待验证 |
| P5 千帆独立adapter | 工程接入完成 | 46项RAG与10项采集测试通过；设置页可只读采集、人工确认并启用资料版本，真实账户待验证 |
| P4 UI、P5 Host/安装 | 工程验收通过，待用户操作验收 | 正式Atelier页面、Host与Runtime、发布编译及D盘安装通过；真实安装页查询/订阅/退出清理通过；修复Windows绝对前端路径被解释成URL及验收日志并发写入问题 |

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
- Windows私有通道及前端transport共12项通过：查询到订阅间隙补发、事件早于订阅回执、重复订阅、迟到监听清理、取消挂起订阅、宿主背压、1024事件缓冲上限和坏协议拒绝。补发从持久书签读取；超过缓冲明确要求刷新。01:26全测试类型检查尚被并行UI与context-budget新TDD测试阻断，不能宣称此时全量门禁通过。
- Runtime私有会话增加7项：分片UTF-8、暂停提交后再确认退出、宿主管道丢失保留UNKNOWN、1MiB帧和64个待处理请求上限、暂停写入失败不虚报成功、坏编码/截断输入停止。01:35 Runtime包类型检查及全部19项桌面通信测试通过。Rust原生暂存基线cargo check通过（1m48s）；尚未装配正式main/Host，不能替代最终安装验收。
- 15:47全量325项通过；工作区类型、测试类型、依赖门禁与无平台问答通过。上下文保存执行策略、完整历史及本次实际输入；检查点只摘录问题/原答案，未验证语义字段留空；SQLite v4独立保存输入审计。生产暂用UTF-8保守预算，真实供应商token统计待账户验证。
- 18:16正式页面生产构建通过，已检查窄屏布局和设置窗口；页面通过PchatClient接Tauri，主入口已从P0诊断替换为SQLite/Harness/供应商适配器。捆绑Node真实进程的ready→空目录查询→持久暂停退出通过（production-runtime-smoke.json）。Rust网络/凭证编译通过，Windows DPAPI加解密实际测试通过。尚无真实Key/资料，没有宣称真实检索/计费验收通过。
- 18:29全量329项通过：包含清单读取→人工确认→新Runtime目录可见的真实文件/SQLite集成，以及私有网络UTF-8分片。千帆生产绑定通过详情原值+实际检索文本hash核验，避开未证实的时间单位转换。安装包已进入NSIS打包；安装及正式窗口接线仍待验证。
- 18:46最终329项测试、工作区/测试类型、依赖与无平台检查通过，Rust发布构建通过。NSIS 0.1.0在 `D:\Dev\apps\Pchat` 安装成功。安装脚本对旧包实际失败，修复后真实页面成功执行 ListRoles、ListConversations、harness.subscribe，退出后无捆绑Runtime残留。证据：`D:\Dev\temp\pchat\installed-acceptance-cf77f242-ef19-44c5-b95b-d2b3ea54cff7\result.json`。没有启动Vite或供应商请求。
- 最终安装包 SHA256：`197A1F03365E6CC8E987DE629265BE7AF0E42899E3558784C389CB27C8D54498`。操作和配置步骤见 [Windows验收指南](./WINDOWS-ACCEPTANCE.md)。未使用真实Key、未导入用户真实资料，语义对照/内容质量/签名分发不宣称已完成。

## 本地环境

所有安装、测试和检查前在当前命令中加载仓库外的本地环境配置。TEMP/TMP、npm/pnpm 缓存、pnpm virtual store、Node 编译缓存与输出根目录都在用户指定 D 盘开发根目录。机器绝对路径不加入共享工具配置。测试工具通过 `PCHAT_DEV_ROOT` 派生缓存、覆盖率和构建输出路径。

构建包装脚本自动设置自身/子进程的输出与缓存环境，Runtime/前端产物及Tauri暂存工程均在开发根目录；详见 [构建说明](./BUILDING.md)。Rust发布编译及NSIS安装已执行。安装目录为 `D:\Dev\apps\Pchat`，运行状态和WebView数据也在D盘。安装冒烟临时覆盖 `PCHAT_DEV_ROOT` 并启用 `PCHAT_ACCEPTANCE_PROBE`，脚本结束恢复原值；诊断WebView日志参数只用于一次测试进程。

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
14. `feat(desktop): bridge client commands and bookmarked events`：平台bridge注入、Windows通道与取消/重连协议；正式进程和Rust命令尚待装配。
15. `feat(runtime): suspend durably across private pipe shutdown`：有界管道解析、并发请求与持久暂停生命周期；后续由正式启动入口装配。
16. `feat(context): persist budgeted model inputs and extractive checkpoints`：按冻结窗口预算选取模型输入、原始历史保留、可审计摘录与SQLite v4。
17. `feat(qianfan): collect reviewable manifests and verify detail revisions`：只读分页采集、内容hash与详情版本核验；不需要用户填写哈希值。
18. `feat(desktop): deliver installed Windows workspace and secure provider setup`：正式前端、DPAPI凭证、Host受限网络、SQLite Runtime装配、千帆确认入口、安装冒烟与操作指南；329项及真实安装接线通过。

## 待后续阶段验证的风险

- SQLite已验证迁移与真实多进程中断恢复；仍不能替代物理断电、目标安装环境与长历史性能验证。
- FakeModel/FakeRAG 不能证明真实调用费用、取消效果、召回或哲学回答质量。
- 核心跨平台检查不能替代 Android/Web 宿主的生命周期、网络、凭证与集成测试。
