# SQLite RuntimeStore：API、所有权与恢复验证

日期：2026-09-14。用于 P2；不改变产品共识、运行不变量或 Harness 队列规则。

## 一手来源与实际环境

- 本机 `D:\nodejss\node.exe` 实测为 Node **24.12.0**，`node:sqlite` 的 `DatabaseSync` 与 `backup` 存在，内置 SQLite **3.50.4**。运行仍打印实验性警告，Store 必须可替换。该版本支持同步数据库操作、busy timeout，以及返回 Promise 的备份 API。[Node 24.12.0 文档](https://nodejs.org/download/release/v24.12.0/docs/api/sqlite.html)
- SQLite 在线备份读取数据库的一致状态；不能用单独复制主数据库文件代替，因为提交数据可能仍在 WAL 中。[SQLite backup API](https://sqlite.org/c3ref/backup_finish.html)、[WAL 文件语义](https://sqlite.org/wal.html#the_wal_file)
- 非 WAL 数据库的 `BEGIN EXCLUSIVE` 获得排他的事务锁。WAL 中的 EXCLUSIVE 与 IMMEDIATE 行为相同，因此不能把主库的一次 WAL 事务误当成覆盖整个 Runtime 生命周期的所有权。[SQLite 事务模式](https://sqlite.org/lang_transaction.html#deferred_immediate_and_exclusive_transactions)
- SQLite 使用平台文件锁，Windows 实现依赖系统锁 API。进程退出通常释放持有的锁，必须等待真实进程退出后验证重新获取；仅有 PID 或锁文件存在不能证明仍有所有者。[平台锁与文件系统边界](https://sqlite.org/lockingv3.html#how_to_corrupt_your_database_files)、[进程锁生命周期](https://sqlite.org/atomiccommit.html#acquiring_a_read_lock)
- 删除或重命名仍在使用的数据库可能分裂文件身份。因此不以“锁文件过期”为由删除 owner 文件，也不通过清除 journal/WAL 绕过锁。[SQLite 文件替换风险](https://sqlite.org/howtocorrupt.html#unlinking_or_renaming_a_database_file_while_in_use)

## 实现选择

`@pchat/storage-sqlite` 暴露 `openSqliteStore({ path, backupDirectory })`，返回实现 `RuntimeStore.read/transaction/subscribe` 的对象及幂等 `close()`。路径必须由宿主提供绝对路径；本包不选择机器目录、不创建密钥或供应商依赖。

所有权使用永久保留的 `<database>.owner.sqlite`，在 DELETE journal 下持有 `BEGIN EXCLUSIVE` 直到主库关闭。获取 owner 之后才打开、备份、迁移主库；获得失败即停止。路径解析实际父目录/已存在文件以避免普通符号路径别名。owner 锁文件损坏或 I/O 失败不会自动删除重建。该协议约束遵守约定的 Runtime，不阻止用户另开 SQLite 管理工具；仅针对本地文件系统，不承诺网络盘或恶意硬链接安全。

主库启动时设置并立即读回 `foreign_keys=ON`、`journal_mode=WAL`、`synchronous=FULL`、`busy_timeout=2000`，任一不匹配即失败。同步 writer 在 SQL 事务里只操作领域数据；回调异步返回、异常或 SQL 约束失败均回滚。COMMIT 后、Promise 回执前同步发布独立的 CommitNotice，隔离订阅者异常。关闭时先发撤销执行权限的通知，再关闭数据库和 owner；该关闭通知不是持久暂停命令，正常退出仍应先由 Harness 执行 `SuspendRuntime`。

会话、原始问题、轮次、人物执行、外部尝试、依据快照、命令回执和事件分别保存到关系表。身份、状态、关系、排序和费用预留使用列；冻结的上下文/人物配置/依据及结构化回答使用 JSON 快照。领域状态为权威，查询不靠事件重建，也不将全库塞入一个 JSON blob。

每次事务读取并隔离完整领域状态，根据前后主键及字段比较写入差异：只删除实际移除项、upsert 新增或变化行。未改变的历史上下文、依据和 journal 不重写。排序槽位只在同一 SQL 事务内暂移后恢复；提交失败仍完整回滚。当前 Store seam 仍有完整状态读取、校验、复制及差异比较的 CPU/内存成本，长历史后续需要实测优化，不能声称已具备无限历史规模。

## Schema 与迁移

- 当前版本 **2**，application ID 为 `PCHT`。v1 保存正式实体；v2 增加队列、轮次和尝试状态索引。`src/fixtures/schema-v1.sql` 是固定的旧格式测试工件，不能随当前 schema 自动同步。
- 全新空库可以直接创建；版本 0 但已有未知对象的数据库拒绝接管。P0 probe 是独立实验数据库，不伪称正式业务迁移来源。
- 对旧正式库，持有 owner 并暂停业务写入，使用 Node backup API 创建唯一 `.incomplete` 目标；等待成功并检查 quick check、外键、application ID 和旧版本，再重命名为已完成备份。
- 备份成功后才开始迁移事务，迁移 SQL、记录及 `user_version` 同事务提交。备份或迁移失败均拒绝打开，保留可用旧库和已完成备份，不把备份覆盖到仍打开的主库。未来版本拒绝写入。
- 后续契约字段或冻结快照格式改变时，需要显式升级 schema 与兼容迁移，不得直接让旧快照按新 schema 静默解析。

## 本次验证证据

2026-09-14，在 D 盘开发环境执行 `pnpm test packages/storage-sqlite`：**3 个文件、16 项测试通过**；包类型检查及根 `check:tests` 通过。

- Harness 完整单人物轮次关库重开后，保存回答依据、尝试、原回执与书签；同 commandId 不产生新调用。
- SQLite 上的 FIFO、当前上下文隔离、停止、迟到结果屏蔽、显式恢复及查询后订阅通过。
- Store 状态/返回值隔离、异常及约束回滚、同步通知、异步 writer 拒绝、关闭撤销、第二 owner 拒绝通过。
- 旧数据库连接保持打开且提交内容仍在 WAL 时，备份包含该内容；备份失败即停、迁移中途 SQL 失败完整回滚、迁移记录与已完成备份保留、修复后可重新获得 owner 通过。
- 真正启动独立 Node Runtime 进程，收到问题回执与草稿 checkpoint 后强制终止并等待 exit。重开后保留两条问题、草稿和原回执；在途模型尝试成为 `OUTCOME_UNKNOWN`，没有自动检索或生成。明确重新生成才创建关联的新尝试；队列仍暂停，明确恢复后处理下一题。进程活着时第二 owner 被拒绝，退出后可获取。
- 回归场景保留 12 个真实 Harness 历史轮次（每题约 8 KB），固定一个数据库历史读快照后执行 16 个小草稿 checkpoint。旧整库重写使 WAL 增长 **26,384,480 字节**，差异写入实现通过 **小于 1 MiB** 门槛，同时完整读回历史和最终草稿。这是针对历史重写的存储回归，不代替长期性能评测。

所有本次数据库、owner、WAL、备份、子进程 bundle 和测试缓存均由 `D:\Dev\pchat-env.ps1` 与 `PCHAT_DEV_ROOT` 指向 D 盘；没有修改 C 盘或持久工具配置。强制进程终止测试不等价于物理断电、磁盘损坏或安装升级实测；这些仍属于后续 Windows 验收边界。
