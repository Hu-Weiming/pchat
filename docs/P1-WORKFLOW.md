# P1 工作流与接口语义

状态：2026-09-12 实施细化。依据：产品共识、INV-001—023、安全模型及交接文档 P1；不改变已确认的哲学模式、资料隔离或产品范围。进度与测试证据见 [P1-PROGRESS](./P1-PROGRESS.md)。

## 执行路径

1. 运行时校验命令，按 commandId 原子去重；相同 ID 与不同内容冲突应拒绝。
2. 同一事务保存命令回执、状态改变和带递增序号的业务事件。失败不能留下半个问题或一个孤立回执。
3. 调度器按会话提交顺序领取问题，同一会话只允许一个 active Turn；不同会话受全局并发与调用预算约束。
4. 创建唯一 Turn 与人物 RoleRun，冻结人物包、知识模式、模型、资料范围和版本；只读取已完成历史与当前问题，不读未来队列项。
5. 每次检索/生成分别记录 ExternalAttempt，先持久记录即将外发的状态，再调用 adapter。资料只作为不可信依据数据；Fake 阶段也校验范围与返回结构。
6. 保存实际依据文本、定位、版本与内容校验值；模型通过受控 port 生成。流式草稿通过投影可查询，业务事件只通知变化。
7. 终态提交后才领取下一个问题。任何结果写入前检查运行者代次、attempt 归属和当前状态，隔离旧实例及停止后的迟到结果。

## 三个不同动作

- **StopTurn**：将本轮所有未完成 RoleRun 收敛为 STOPPED，保留已生成草稿，暂停该会话队列，再通知 adapter 取消；不以 adapter 是否立即停止作为状态提交的前提。
- **ResumeQueue**：恢复尚未执行问题的领取；不能自动重做停止或结果未知的调用。若 active Turn 等待用户决定，恢复命令返回明确领域错误。
- **RegenerateRole**：用户针对等待决定的 RoleRun 明确重做；沿用原 Question/Turn/RoleRun 与冻结快照，建立关联前一次尝试的新 attemptId，保留旧草稿/尝试，不能覆盖历史未知记录。P1 不提供已完成答案的编辑式重新生成。

Host 暂停和运行时重建通过显式生命周期语义停止领取、收敛未完成外部尝试；恢复时绝不根据事件流猜测供应商是否已执行。普通队列恢复与可能重新收费的重做必须分开。

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
| RoleRun | RETRIEVING | GENERATING、FAILED、STOPPED、WAITING_USER |
| RoleRun | GENERATING | COMPLETED、FAILED、STOPPED、WAITING_USER |
| RoleRun | WAITING_USER | RETRIEVING、GENERATING、STOPPED |
| RoleRun | COMPLETED / FAILED / STOPPED | 无 |
| ExternalAttempt | PREPARED | IN_FLIGHT、CANCELLED |
| ExternalAttempt | IN_FLIGHT | SUCCEEDED、FAILED、OUTCOME_UNKNOWN |
| ExternalAttempt | SUCCEEDED / FAILED / CANCELLED / OUTCOME_UNKNOWN | 无 |

IN_FLIGHT 表示请求可能已经发出；停止或重建运行时不能把它随意记为确定无费用的 CANCELLED。OUTCOME_UNKNOWN 是外部尝试终态，等待用户决定是 RoleRun/Turn 的状态，两者分离。

## Store 与事件书签

RuntimeStore 提供事务与一致快照。P1 用内存 adapter 实现相同的原子提交要求，未来 SQLite adapter 负责真实持久性。领域状态、commandId 回执和业务事件在一次提交中变化；通知发布失败不回滚已提交事实，订阅可从 Store 的 journal 补读。

query 的 data 与 lastEventSeq 从同一快照读取。events(after) 只返回 after 之后的事件，先补读已提交事件，再等待新的提交；订阅建立期间也必须再检查 journal，避免“先查询、后订阅”的丢失窗口。草稿保存在可查询投影中，不依赖重放全部 token。迭代器结束时解除监听；不使用全局事件总线。

## 跨平台纪律

- 协议仅包含经过校验的 JSON 数据、稳定错误码和版本，不发送 class、回调、平台路径或凭证。
- 核心只使用 ECMAScript、contracts 和注入 ports；时间、ID、取消、存储、模型和检索不读取宿主全局对象。
- Web 将来提供经过认证的远端 transport；Android 提供自己的生命周期、存储和凭证 adapter。P1 不提前增加服务器、Android 工程或空 client 包。
- 无平台全局对象的沙箱验证证明核心可运行；真实宿主兼容性仍需后续各端测试。

## 实施范围

P1 只开放单人物输入；对照、长上下文压缩、供应商安全网络和正式持久化依既有阶段安排后置。核心调度和取消按 RoleRun 集合处理，便于未来多人物扩展，但不提前交付对照功能。有限并发与预算使用可调注入配置，Fake 验证额度保留及未知结果不自动释放费用。

首个生产 RAG adapter 采用百度千帆独立检索，用户在百度控制台管理文档；以后开发机服务实现同一个 RAGPort。参考 [千帆预研](./research/2026-09-12-qianfan-rag-preflight.md) 与 [pi 参考](./research/2026-09-12-pi-harness-preflight.md)，不直接照搬它们的队列或权限机制。
