# Pchat 开发入口

开始架构、编码、测试或发布工作前，完整阅读 [`docs/DEVELOPMENT-HANDOFF.md`](./docs/DEVELOPMENT-HANDOFF.md)。产品规则以 `docs/PCHAT-CURRENT-PRODUCT-CONSENSUS.md` 为准，运行时规则以 `docs/RUNTIME-INVARIANTS.md` 为准。

C 盘空间不足。构建输出、日志、缓存、临时文件和包管理下载统一优先放在 `D:\Dev`，通过当前命令的 `TEMP`、`TMP` 及 npm、pnpm、Cargo、Gradle、Maven 等工具配置实现。不要移动或修改 C 盘系统目录及已安装软件的配置目录。每次修改环境或工具配置后，向用户列出具体修改项。
