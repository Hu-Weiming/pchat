# P1 当前进度

更新日期：2026-09-12。当前阶段：单人物闭环通过，进入队列与恢复故障场景。

本文件是本次开发唯一的进度入口，每个开发步骤和提交前更新。产品规则仍以产品共识和运行不变量为准；实施细节见 [P1 工作流](./P1-WORKFLOW.md)。

## 已确认范围

- 交付 P1 Contracts 与 Headless Harness：纯 TypeScript、内存 Store、FakeModel/FakeRAG、注入时钟与 ID，单人物完整轮次、FIFO、停止/恢复、内部幂等、查询投影与事件书签。
- 用户在百度千帆控制台上传和管理资料，Pchat 通过独立检索 adapter 读取指定知识库；生产 adapter、真实 DeepSeek、真实资料评测、SQLite、正式 UI 留到后续阶段。
- 照顾 Web/Android 复用：数据契约可序列化；核心无 Node/Tauri/React/DOM 依赖；取消和宿主生命周期显式建模，存储与凭证由宿主装配。
- Git 按可验证模块分步本地提交；本次没有推送或发布要求。

## 步骤与验收

| 步骤 | 状态 | 验证证据 |
| --- | --- | --- |
| 接管、权威文档、Git 与基线类型检查 | 已完成 | 初始 main 无业务修改，仅上一轮两份调研草稿；pnpm check 三个包通过 |
| 工作流细化、提交规范、测试环境 | 已完成 | Vitest 5 / Vite 8；输出路径显式要求 PCHAT_DEV_ROOT；Conventional Commits |
| 正式契约与输入校验 | 进行中 | 基础命令、查询、回执、事件和状态枚举 4 项测试通过；执行投影随下一垂直切片补齐 |
| 注入 ports、内存事务和单人物完整轮次 | 已完成 | 2 项 Harness 测试通过；实际 Fake 依据及 RAG/MODEL 独立尝试可查询；testing 11 项测试 |
| FIFO、上下文冻结、幂等 | 待实施 | A/B/C、并发重复 commandId、设置与输入隔离 |
| 停止、恢复、未知结果和明确重新生成 | 待实施 | 迟到结果、崩溃替身、旧运行者隔离、新 attempt 关联 |
| 事件书签、依赖和跨端检查 | 进行中 | AST 检查 23 个正反例；无平台全局对象的完整单人物闭环通过；书签竞态待验 |
| 完整验收、审查及本地提交 | 待实施 | 全部相关检查、验收映射和最终 Git 状态 |

## TDD 记录

采用已确认的公共测试面：contracts schema、PchatHarness 的 dispatch/query/events、Store 与 Model/RAG ports。不通过私有方法断言业务状态。每次推进一个失败场景，再实现通过；提交仅包含通过验证的完整切片。

- 基线：`pnpm check` 通过（contracts、runtime-windows、desktop）。
- 契约四轮 red → green：依次观察缺少 schema、SubmitQuestion discriminator、控制命令 discriminator、查询 schema 导致的失败，再实现；当前 4 项契约测试通过。
- `pnpm check` 和 `pnpm check:tests` 通过。尚未宣称 Harness 业务场景通过。
- 环境负例：未设置 PCHAT_DEV_ROOT 时测试明确失败；Vite 临时配置、cache 和 coverage 未写入仓库，Vitest cache 位于开发根目录。
- Harness 创建用例先因缺少实现失败，再通过；单人物完整轮次先因 SubmitQuestion 拒绝失败，再通过。
- InMemoryStore 的事务、回滚、输入输出引用隔离和通知隔离已做 red → green；Fake ports 支持逐次控制和无视取消的迟到返回。
- `pnpm check`、`pnpm check:tests`、AST 依赖检查及 `check:portable` 通过。portable 检查器先证明会拒绝平台全局访问与不完成的流程，真实闭环从 Question submission failed 到通过。

## 本地环境

所有安装、测试和检查前在当前命令中加载仓库外的本地环境配置。TEMP/TMP、npm/pnpm 缓存、pnpm virtual store、Node 编译缓存与输出根目录都在用户指定 D 盘开发根目录。机器绝对路径不加入共享工具配置。测试工具通过 `PCHAT_DEV_ROOT` 派生缓存、覆盖率和构建输出路径。

没有修改系统环境、C 盘系统目录或已安装软件配置。具体本地路径随执行在对话中逐项报告。

## 提交记录

本次起点：`54b383c`。

1. `67ddc9c docs(p1): define portable workflow and progress`：设计、进度与三份一手调研。
2. `bc4b41e feat(contracts): add validated portable harness messages`：基础契约与 Vitest 工具；4 项契约测试、业务及测试类型检查通过。
3. `feat(harness): run single-role turns with injected ports`：单人物、Store/Fake ports、查询与初始 journal；新增依赖与跨端检查，综合门禁为 pnpm check:p1。

## 待后续阶段验证的风险

- 内存事务和恢复替身不能证明 SQLite 断电持久性、迁移或多进程行为。
- FakeModel/FakeRAG 不能证明真实调用费用、取消效果、召回或哲学回答质量。
- 核心跨平台检查不能替代 Android/Web 宿主的生命周期、网络、凭证与集成测试。
