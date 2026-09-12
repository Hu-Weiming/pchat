# Pi 对 P1 Harness 的参考建议

访问日期：2026-09-12。性质：一手实现调研与建议，不修改产品共识或运行不变量；尚未开始 P1 编码。使用 `main` 在线源码，后续落地时应重新核验并固定参考提交。

## 来源与适用范围

项目已有的 [pi.dev](https://pi.dev/) 是本次参考对象。原 [badlogic/pi-mono](https://github.com/badlogic/pi-mono) 当前重定向到 [earendil-works/pi](https://github.com/earendil-works/pi)。官网强调小型 Harness、可嵌入 SDK、stdin/stdout RPC 和模型可替换；无需另向用户确认项目身份。[官网](https://pi.dev/)

## 可借鉴的实现

- **把调用循环与宿主分开。** `agentLoop` 接收上下文、配置、取消信号与注入的 `streamFn`，输出类型化事件。Pchat 可保留相同的依赖方向，用 FakeModel/FakeRAG 驱动核心，不把供应商和桌面能力放入 Harness。[agent-loop.ts](https://github.com/earendil-works/pi/blob/main/packages/agent/src/agent-loop.ts)
- **领域消息到模型输入只在边界转换。** Pi 先 `transformContext`，再 `convertToLlm`，最后调用模型。Pchat 的 ContextAssembler 应从冻结快照组装人物允许使用的资料与历史，再由 ModelPort adapter 转换；排队问题不能先混入输入后再寄望提示词忽略。[agent-loop.ts](https://github.com/earendil-works/pi/blob/main/packages/agent/src/agent-loop.ts)
- **显式生命周期与流式事件。** Pi 区分 agent、turn、message 和 tool 事件；`Agent.processEvents` 先更新自身状态再等待订阅者。Pchat 可借鉴事件命名与完成边界，但仍应由 Store 原子提交状态、事件序号和命令回执。[Agent README](https://github.com/earendil-works/pi/blob/main/packages/agent/README.md)、[agent.ts](https://github.com/earendil-works/pi/blob/main/packages/agent/src/agent.ts)
- **统一模型边界和可替换 provider。** Pi 的模型集合统一调用接口，provider 可以由认证、模型列表和具体 API 实现组成。Pchat 应借鉴这一分层，而不把 Pi 的认证解析直接搬进 Harness；凭证继续留在 Host 安全边界。[AI README](https://github.com/earendil-works/pi/blob/main/packages/ai/README.md)

## 必须保留的 Pchat 差异

| 主题 | Pi 当前实现 | Pchat P1 的处理建议 |
| --- | --- | --- |
| 轮次含义 | Pi 的 turn 是一次模型响应及其工具执行；一次运行可包含多次 turn | 不映射成 Pchat 的业务 Turn；Pchat 一个 Question 只创建一个 Turn，各人物有 RoleRun |
| 队列 | steering 在工具轮次结束后进入下一模型输入；follow-up 在本次工作本来将结束时消费，支持逐条或全部消费 | 只实现会话 Question 严格 FIFO；B、C 不进入 A 的冻结上下文；不引入 steering 改写当前问题 |
| 上下文 | 开始时复制顶层消息/工具数组；`prepareNextTurn` 可更新后续内部轮次的配置 | 冻结人物、模式、模型、资料范围与版本，不能把浅拷贝当成领域不可变保证 |
| 停止 | `abort()` 发取消信号；`waitForIdle()` 等执行及被等待的监听器结束 | StopTurn 先确定终态，再传播取消；以终态/attempt 归属检查拒绝迟到结果，不能只相信 adapter 遵守取消 |
| 恢复 | `continue()` 从现有上下文继续；模型文档展示中止后显式发起新请求 | 内部命令去重与外部付费调用分开；可能已接收的未知尝试记为 OUTCOME_UNKNOWN，不自动重发；用户明确重新生成才创建关联的新 attemptId |
| 查询与事件 | 低层事件流保序，但不等待异步消费者全部处理；不是 Pchat 的查询书签承诺 | query 的投影与 lastEventSeq 来自同一快照；events(after) 必须回放书签后已提交的事件，再连续接收新事件 |

表中 Pi 行为来源：[循环源码](https://github.com/earendil-works/pi/blob/main/packages/agent/src/agent-loop.ts)、[Agent 源码](https://github.com/earendil-works/pi/blob/main/packages/agent/src/agent.ts)、[事件文档](https://github.com/earendil-works/pi/blob/main/packages/agent/README.md)、[取消与续接文档](https://github.com/earendil-works/pi/blob/main/packages/ai/README.md#continuing-after-abort)。Pchat 约束来源：[INV-001—018、021—022](../RUNTIME-INVARIANTS.md)、[P1 验收](../DEVELOPMENT-HANDOFF.md#7-p1-实施任务)。上述 Pchat 实现方式是建议，并非 Pi 已提供同等保证；本次未审计 Pi 全部持久化与重试代码。

## 版本差异与下一步

官网仍描述 steering 在当前工具后打断剩余工具；本次 Agent README 和循环源码则显示工具批次完成后才轮询 steering。研究时以具体版本源码为准，不把官网简述当成稳定契约。[官网](https://pi.dev/)、[Agent README](https://github.com/earendil-works/pi/blob/main/packages/agent/README.md#steering-and-follow-up)、[循环源码](https://github.com/earendil-works/pi/blob/main/packages/agent/src/agent-loop.ts)

P1 测试优先覆盖：A/B/C 排队与输入隔离、同 commandId 并发重试、停止后 adapter 仍返回成功、OUTCOME_UNKNOWN 恢复不重发、查询完成与订阅建立之间插入事件。无需用户决定内部类名、队列算法或 Pi API 是否直接复用。Pi 是参考来源；现有 Pchat 权威文档继续决定行为。

本次只读取公开网页并新增此笔记；未安装依赖、未调用付费接口、未修改环境或工具配置。
