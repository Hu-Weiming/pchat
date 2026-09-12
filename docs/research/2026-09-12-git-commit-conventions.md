# P1 Git 提交约定调研

调研日期：2026-09-12。范围：P1 本地 Git 提交及提交说明；不涉及 push、发布或更改 Git 配置。

## 结论与来源

Pchat 采用 Conventional Commits 1.0.0 的消息结构，延续现有 `docs:`、`chore:` 历史。它是一项可选择的轻量约定，不是 Git 或整个行业强制的规则。

- 标题结构为 `type(scope): description`，scope 可省略。`feat` 表示新功能，`fix` 表示修复；规范允许 `docs`、`test`、`refactor`、`build`、`chore` 等其他类型。破坏已有公开契约时使用 `!` 或 `BREAKING CHANGE:`，正文与标题之间空一行。[Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/)
- Git 项目自身的贡献指南建议按逻辑变化拆分提交，标题简短且使用祈使语气，正文说明问题、解决方式及原因。其约 50 字符标题目标是软限制；这是 Git 项目实践，不是 Git 格式限制。[Git SubmittingPatches](https://git-scm.com/docs/SubmittingPatches)
- Git 支持把选定文件或片段加入暂存区后提交，适合控制每个阶段的边界；提交前可检查实际暂存内容。[git-commit](https://git-scm.com/docs/git-commit)

## Pchat 的具体选择

以下是结合当前仓库与本次任务制定的项目约定：

1. 标题使用英文、小写 type、模块 scope 和祈使动词，例如 `feat(harness): enforce conversation FIFO`。正文优先简洁清楚，可使用中文；不要写 `update files`、`WIP` 等无法说明行为的标题。
2. 常用 scope 为 `contracts`、`harness`、`testing`、`p1`；跨模块但同一行为的提交可用 `harness`，不为满足目录边界拆开相互依赖的代码和测试。
3. 每个提交应能独立通过当时适用的检查。TDD 的失败用例先运行并记录到进度文档，再补实现；提交时将相关测试与实现一起纳入。不要为了展示红灯阶段留下不可运行的正式阶段提交。
4. 正文按需要交代“当前问题、完成的改变、实际验证”。只记录已经执行的检查和结果；尚未完成的工作、限制或延期项写入持续维护的进度文档。
5. 提交前查看 `git status --short`、`git diff --cached` 和 `git diff --cached --check`。只暂存该阶段所需的文件，不混入无关修改、凭证、依赖下载、构建产物或本机专用路径配置。
6. 本次仅本地提交。无需新增 commitlint、Git hooks 或修改用户级 Git 配置；无需为了消息格式重写已有共享历史。

提交说明示例（命令和结果应替换为本次实际证据）：

```text
feat(harness): enforce conversation FIFO

Queued questions can arrive while a turn is generating a reply.
Serialize turn selection per conversation and freeze its input snapshot.
Keep queued questions outside the active role context.

Validation: <actual checks and results>
```

## 建议的 P1 阶段提交

实际标题随该提交最终范围调整；以下不是预先声称已完成的工作。

| 阶段 | 建议标题 | 应包含的完整变化 |
| --- | --- | --- |
| 设计与跟踪 | `docs(p1): define portable workflow and progress` | P1 设计细化、跨端边界、状态转换表、进度文档与调研依据 |
| 契约 | `feat(contracts): define harness commands and projections` | 正式命令、查询、事件、投影、错误、输入校验及契约测试 |
| 单人物轮次 | `feat(harness): run single-role turns with injected ports` | 最小 Harness、测试替身、会话与单人物完整轮次及行为测试 |
| 队列与恢复 | `feat(harness): enforce FIFO and recover interrupted turns` | 上下文冻结、停止、恢复、迟到结果保护、幂等与故障场景测试 |
| 查询与验收 | `feat(harness): expose consistent queries and event cursors` | 查询投影、事件书签、丢失窗口测试、依赖检查、最终验收记录 |

进度文档随每个实现阶段同步提交。若一个阶段过大，按可独立验证的行为继续拆分；若查询或幂等是早期行为正确性的前提，应提前实现并在对应阶段提交，避免为了机械遵守本表而推迟必要基础能力。
