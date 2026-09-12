# Pchat P0 技术验证报告

更新日期：2026-09-08。结论：**P0 通过，可以进入 P1。**

P0 没有调用任何真实模型或付费接口，也没有使用真实 API 密钥。

## 1. 验证结论

| 验证项 | 结果 | 结论 |
| --- | --- | --- |
| Tauri 管理后台 Runtime | 通过 | Host 能自动启动、通信并清理 Runtime |
| 三种 Runtime/SQLite 路线 | 通过比较 | MVP 采用“捆绑 Node + `node:sqlite`”，SEA 暂不采用，`better-sqlite3` 保留为后备 |
| 私有通信 | 通过 | React → Tauri IPC → Rust Host → stdin/stdout Runtime；支持请求、响应和流式事件 |
| 凭证与网络能力边界 | 通过 | Runtime 只提交 `connectionId`；Host 拒绝未知连接和未知操作；密钥值不返回 UI/Runtime |
| 单实例与进程恢复 | 通过 | 第二次启动自动退出；窗口关闭后任务继续；Host 被强制结束后无孤儿 Runtime |
| SQLite 安全设置与恢复 | 通过 | FK、WAL、5 秒 busy timeout、事务迁移、迁移前备份及失败恢复均通过 |

## 2. 最终选择

Windows MVP 采用：

```text
React WebView
  → Tauri IPC
  → Rust Host
  → 私有 stdin/stdout
  → 随安装包捆绑的 Node Runtime
  → node:sqlite（隔离在 Store adapter 后）
```

选择理由：这条路线已经通过真实 NSIS 安装验证，不要求用户另装 Node，没有额外 SQLite 原生扩展，也不开放本机端口。`node:sqlite` 在当前 Node 24.12.0 中仍会打印实验性警告，因此必须继续隔离在 Store adapter 后；如果 P2 遇到功能或稳定性问题，可换成 `better-sqlite3`，不修改 Harness。

### 未选路线

- `better-sqlite3 13.0.3`：本机 Node 24 读写测试通过，也提供 Windows x64 预编译文件；但引入原生扩展、平台文件和额外打包规则。当前没有足够收益抵消复杂度，保留为后备。
- Node SEA：本机能生成约 90.8 MB 的单文件 Runtime 并正常通信，但注入过程报告可执行文件签名被破坏，而且 Node 官方仍标为 Active development。MVP 不采用。

## 3. 实测证据

- Node 24.12.0、pnpm 11.19.0、Rust 1.95.0、MSVC Build Tools 和 WebView2 均可用。
- TypeScript 全项目检查通过。
- Rust 安全边界测试：3 项通过，0 项失败。
- 发布版 Runtime 自动检测通过：ping、3 个流式事件、受限供应商通道、SQLite 升级和失败恢复。
- SQLite 实测：`foreign_keys=1`、`journal_mode=wal`、`busy_timeout=5000`、主库版本 2、备份版本 1；模拟迁移失败后恢复为版本 1，未遗留失败迁移表。
- 发布版与 NSIS 安装包均构建成功。安装后使用捆绑 Runtime，不依赖系统 Node。
- Runtime 网络套接字数量为 0。
- 第二次启动后实例数量仍为 1。
- 窗口关闭后 Host 与 Runtime 均继续运行；模拟 Host 崩溃后，两者均退出，无孤儿进程。
- Windows Defender 对安装包扫描结果：未发现威胁。

安装包：`D:\Pchat\apps\desktop\src-tauri\target\release\bundle\nsis\Pchat P0_0.0.0_x64-setup.exe`

SHA-256：`7A01FE2505D752D8247193880712FE47545A484120FB4DF69A294F9C6C13CDF4`

测试版已安装到：`C:\Users\胡炜铭\AppData\Local\Pchat P0`

## 4. 后续边界

- P0 使用的凭证是 Host 内的假值，只验证“handle + 允许清单 + 不泄露”的结构。用户真实密钥接入和 Windows 凭证库落地属于真实模型接入阶段。
- 当前安装包未做商业代码签名；正式发布前需要发布证书和签名流程。
- P0 验证的是数据库升级与恢复。跨正式应用版本的升级测试应在出现第二个可安装版本后持续加入发布检查。
- 开发模式的 Vite 会使用 `127.0.0.1:1420` 提供临时页面；发布程序不包含该开发服务器，Runtime 始终不开放 localhost 服务。

## 5. P1 准入结论

六项 P0 风险都已经得到可运行证据，没有发现需要推翻架构的阻塞问题。下一步按计划进入 Contracts 与 Headless Harness，实现纯核心、正式状态机、内存测试替身以及不依赖界面的单人物完整轮次。
