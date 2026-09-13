# P1 工作流基线与 P3 多人物扩展

状态：2026-09-12 P1 门禁通过。依据：产品共识、INV-001—023、安全模型及交接文档 P1；不改变已确认的哲学模式、资料隔离或产品范围。进度与测试证据见 [开发进度](./DEVELOPMENT-PROGRESS.md)。

2026-09-14 扩展：按 [P2—P5 实施计划](./P2-P5-IMPLEMENTATION-PLAN.md) 将人物选择演进为 1—3 个唯一 participantIds。下文标明当前执行语义；P1 的幂等、停止、事务、资料隔离和恢复断言继续保留。

## 执行路径

1. 运行时校验命令，按 commandId 原子去重；相同 ID 与不同内容冲突应拒绝。
2. 同一事务保存命令回执、状态改变和带递增序号的业务事件。失败不能留下半个问题或一个孤立回执。
3. 调度器按会话提交顺序领取问题，同一会话只允许一个 active Turn；不同会话受全局并发与调用预算约束。
4. 提交问题时保存所选人物包集合、知识模式、模型、资料范围和版本意图；领取时创建唯一 Turn 及每个人物自己的 RoleRun。Turn 保存共同问题、选择与历史水位，各 RoleRun 保存独立人物包的 ContextSnapshot，检索和模型只收到该人物范围及依据。后续设置不追溯改变已提交问题；历史只收录之前轮次已完成的人物答案，并在多人答案前保留人物标签，不读未来队列项或未完成草稿。
5. 每次检索/生成分别记录 ExternalAttempt，先持久记录即将外发的状态，再调用 adapter。资料只作为不可信依据数据；Fake 阶段也校验范围与返回结构。
6. 保存实际依据文本、定位、版本与内容校验值；模型通过受控 port 生成。流式草稿通过投影可查询，业务事件只通知变化。
7. 终态提交后才领取下一个问题。任何结果写入前检查运行者代次、attempt 归属和当前状态，隔离旧实例及停止后的迟到结果。

同轮人物分别收敛。个别人失败或结果未知时暂停后续问题，但已经领取的本轮其他人物继续执行；所有人物都不再处于 PENDING、RETRIEVING 或 GENERATING 后，Turn 才进入 WAITING_USER、FAILED 或 COMPLETED。已完成答案不被失败同伴覆盖。

## 三个不同动作

- **StopTurn**：将本轮所有未完成 RoleRun 收敛为 STOPPED，保留已生成草稿，暂停该会话队列，再通知 adapter 取消；不以 adapter 是否立即停止作为状态提交的前提。
- **ResumeQueue**：恢复尚未执行问题的领取；不能自动重做停止或结果未知的调用。若 active Turn 等待用户决定，恢复命令返回明确领域错误。
- **RegenerateRole**：用户针对等待决定的 RoleRun 明确重做；沿用原 Question/Turn/RoleRun 与冻结快照，进入 PENDING 并发布 RoleQueued，获得执行槽后建立关联前一次尝试的新 attemptId，保留旧草稿/尝试，不能覆盖历史未知记录。其他人物仍运行时也可单独重做未知人物；已完成人物保持原样，不提供已完成答案的编辑式重新生成。PENDING 不占外部调用槽，重新激活 Turn 时仍检查全局活跃轮次额度。

Host 暂停和运行时重建通过显式生命周期语义停止领取、收敛未完成外部尝试；恢复时绝不根据事件流猜测供应商是否已执行。普通队列恢复与可能重新收费的重做必须分开。

P1 用 `SuspendRuntime` 暂停领取并保存最新已处理草稿；宿主恢复时重新 `createHarness`，取得新的 Store 运行者代次，再按会话显式恢复队列。旧代次不能写入新运行时的状态。

## 状态转换表

未列出的转换一律拒绝；终态无出边。命令幂等重放返回原回执，不属于重复状态转换。

| 实体 | 当前状态 | 允许后续状态 |
| --- | --- | --- |
| Question | QUEUED | RUNNING、WITHDRAWN |
| Question | RUNNING | COMPLETED、FAILED、STOPPED、WAITING_USER |
| Question | WAITING_USER | RUNNING、STOPPED |
| Question | COMPLETED / FAILED / STOPPED / WITHDRAWN | 无 |
| Turn | RUNNING | COMPLETED、FAILED、STOPPED、WAITING_USER |
| Turn | WAITING_USER | RUNNING、STOPPED |
| Turn | COMPLETED / FAILED / STOPPED | 无 |
| RoleRun | PENDING | RETRIEVING、GENERATING、STOPPED、WAITING_USER |
| RoleRun | RETRIEVING | GENERATING、FAILED、STOPPED、WAITING_USER |
| RoleRun | GENERATING | COMPLETED、FAILED、STOPPED、WAITING_USER |
| RoleRun | WAITING_USER | PENDING、STOPPED |
| RoleRun | COMPLETED / FAILED / STOPPED | 无 |
| ExternalAttempt | PREPARED | IN_FLIGHT、CANCELLED |
| ExternalAttempt | IN_FLIGHT | SUCCEEDED、FAILED、OUTCOME_UNKNOWN |
| ExternalAttempt | SUCCEEDED / FAILED / CANCELLED / OUTCOME_UNKNOWN | 无 |

IN_FLIGHT 表示请求可能已经发出；停止或重建运行时不能把它随意记为确定无费用的 CANCELLED。OUTCOME_UNKNOWN 是外部尝试终态，等待用户决定是 RoleRun/Turn 的状态，两者分离。

## Store 与事件书签

RuntimeStore 提供事务与一致快照。P1 用内存 adapter 实现相同的原子提交要求，P2 SQLite adapter 实现持久性。领域状态、commandId 回执和业务事件在一次提交中变化；通知发布失败不回滚已提交事实，订阅可从 Store 的 journal 补读。

Store 订阅时同步发送当前 CommitNotice，此后在实际提交完成、异步事务回执返回之前同步通知 epoch、暂停标志和可执行 Turn。执行器据此立即撤销停止、暂停或旧运行者的权限，不把延迟回执误当成仍可外发。连续保存结果/失败状态均失败时，当前 Harness 进入 RUNTIME_UNAVAILABLE 并停止调度；重新打开后由持久状态进入显式恢复，不能在原运行者上自动再次付费调用。

query 的 data 与 lastEventSeq 从同一快照读取。events(after) 只返回 after 之后的事件，先补读已提交事件，再等待新的提交；订阅建立期间也必须再检查 journal，避免“先查询、后订阅”的丢失窗口。草稿保存在可查询投影中，不依赖重放全部 token。迭代器结束时解除监听；不使用全局事件总线。

## 跨平台纪律

- 协议仅包含经过校验的 JSON 数据、稳定错误码和版本，不发送 class、回调、平台路径或凭证。
- 核心只使用 ECMAScript、contracts 和注入 ports；时间、ID、取消、存储、模型和检索不读取宿主全局对象。
- Web 将来提供经过认证的远端 transport；Android 提供自己的生命周期、存储和凭证 adapter。现有纯 TypeScript client 通过相同协议读取投影和事件，不把平台适配放进核心。
- 无平台全局对象的沙箱验证证明核心可运行；真实宿主兼容性仍需后续各端测试。

## 实施范围

P1 验收时只开放单人物输入。P3 当前扩展开放手选 1—3 人物及答案摘录列：只有本轮至少两个 COMPLETED 且非 INSUFFICIENT_EVIDENCE 的答案才形成 comparison，逐列保留 roleRunId、participantId、人物标签和原答案结构，并列出排除的 RoleRun。此结构用于追溯已有回答，不代表已经完成结论、前提或概念的语义差异分析，也不会追加模型请求生成未经原回答支持的总结。

Turn、RoleRun 与外部请求使用三个独立的全局并发上限。PENDING RoleRun 尚未领取执行槽，不创建外部 attempt；已领取人物的检索与生成分别申请外部调用槽，等待槽时不预留调用费用。取消后的已发出请求保留槽直到实际排空；不会忽略尚未结束的调用。费用使用注入的每种请求预留单位，上限在创建尝试的事务中跨全部人物检查；除明确未发送的 CANCELLED 外均保留预留，尤其不自动退还 OUTCOME_UNKNOWN。这些是假接口的预算约束，不能替代 P5 的真实价格、usage、限流与供应商额度验证。

首个生产 RAG adapter 采用百度千帆独立检索，用户在百度控制台管理文档；以后开发机服务实现同一个 RAGPort。参考 [千帆预研](./research/2026-09-12-qianfan-rag-preflight.md) 与 [pi 参考](./research/2026-09-12-pi-harness-preflight.md)，不直接照搬它们的队列或权限机制。
