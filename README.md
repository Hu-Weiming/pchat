# Pchat Agent

Pchat Agent 是一个面向哲学初学者和爱好者的本地 AI 对话项目。它尝试把思想家按思想阶段组织为受资料约束的“立场模型”，通过原典检索、受约束推演和多人物对照，帮助用户理解一个问题中的结论、前提、概念、分歧与文本依据。

项目当前处于 **P0 技术验证阶段**，还不是可供日常使用的完整产品。现有代码验证了 Windows 上的 Tauri 桌面宿主、TypeScript Runtime、私有进程通信、SQLite 恢复机制和安装打包。真实模型、真实知识库、正式人物资料和完整对话流程尚未接入。

## 当前技术结构

```text
React WebView
  → Tauri IPC
  → Rust Host
  → 私有 stdin/stdout
  → 随安装包捆绑的 Node Runtime
  → SQLite
```

- 桌面界面：React、TypeScript、Vite
- 桌面宿主：Tauri 2、Rust
- 本地运行时：Node.js、TypeScript
- 数据契约：Zod
- 工作区与依赖管理：pnpm workspace

当前结构是风险验证结果，不代表最终架构已经冻结。编码前的产品共识、架构方案和安全约束位于 [`docs`](./docs) 目录。

## 仓库结构

```text
apps/desktop/          Tauri 桌面宿主与 React 界面
apps/runtime-windows/  Windows 本地 Runtime 技术验证
packages/contracts/    跨模块数据契约
prototypes/            Atelier 静态交互原型
docs/                  产品共识、架构、安全与验证文档
scripts/               构建辅助脚本
```

## 开发状态

已经完成：

- Windows P0 技术验证与 NSIS 安装验证
- Tauri Host 对 Runtime 的启动、通信与退出管理
- 无 localhost 端口的私有 IPC 验证
- SQLite 迁移、备份和失败恢复验证
- 凭证句柄与网络允许清单的边界验证（仅使用假密钥）

尚未完成：

- 正式会话状态机与队列
- 模型和 RAG 供应商接入
- 思想阶段资料包与证据校验
- 多人物回答与立场对照
- Android、线上版与 Apple 客户端

详细结果见 [`docs/P0-VALIDATION-REPORT.md`](./docs/P0-VALIDATION-REPORT.md)。

## 本地开发

当前开发环境以 Windows 为准。需要 Node.js、pnpm、Rust、Visual Studio C++ Build Tools 和 WebView2。

```powershell
pnpm install
pnpm check
pnpm p0:desktop:dev
```

生成 Windows 安装包：

```powershell
pnpm p0:desktop:build
```

构建产物、缓存、数据库和本地凭证文件不会提交到仓库。项目不会包含任何真实 API Key。

## 项目原则

- 思想人物是受资料约束的立场模型，不宣称复活历史人物。
- 原典陈述、受约束推演和开放拟构必须清楚区分。
- 模型与知识库供应商通过适配层隔离，业务逻辑不绑定 DeepSeek。
- 首版不向人物开放 Shell、任意文件访问或浏览器自动化。
- 首版顺序为 Windows、Android、线上项目，最后再考虑 Apple 平台。

## 许可证

本项目使用 [MIT License](./LICENSE)。仓库中的第三方依赖仍适用其各自许可证。
