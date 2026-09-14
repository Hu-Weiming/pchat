# 本地构建与输出目录

构建脚本要求 `PCHAT_DEV_ROOT` 为源码仓库之外的绝对目录。本机使用 `D:\Dev`。脚本只修改当前构建进程及其子进程的环境，不修改系统环境、用户软件配置或 C 盘目录。

## 命令

本机安装依赖、检查和测试前加载仓库外已配置的 `D:\Dev\pchat-env.ps1`。其他开发机应先将 TEMP/TMP、npm/pnpm 缓存指向其开发输出根目录；pnpm 11 使用 `pnpm_config_*` 配置。

```powershell
. D:\Dev\pchat-env.ps1
pnpm install --offline # 依赖已缓存时；首次安装去掉 --offline
pnpm check
pnpm check:tests
pnpm test
pnpm check:deps
pnpm check:portable
pnpm desktop:stage
pnpm p0:desktop:build
```

`desktop:stage` 构建 Runtime 和前端，并准备独立的 Tauri 原生工程；不编译 Rust、不安装应用。`p0:desktop:build` 是沿用的命令名称，通过同一暂存工程调用 Tauri 打包。开发模式使用 `pnpm p0:desktop:dev`。当前界面的产品完成状态以 [开发进度](./DEVELOPMENT-PROGRESS.md) 为准，构建成功不等于产品验收通过。

## 输出与缓存

以下路径相对于 `PCHAT_DEV_ROOT`：

| 内容/配置 | 路径或值 |
| --- | --- |
| TEMP、TMP | `temp/pchat` |
| NODE_COMPILE_CACHE | `cache/pchat/node` |
| npm_config_cache | `cache/pchat/npm` |
| pnpm_config_store_dir | `pnpm-store` |
| pnpm_config_cache_dir、pnpm_config_state_dir | `cache/pchat/pnpm`、`state/pchat/pnpm` |
| pnpm_config_verify_deps_before_run | `false`；构建期间不隐式安装依赖 |
| CARGO_HOME、CARGO_TARGET_DIR | `cargo-home`、`cargo-target/pchat` |
| Runtime、前端 | `build/pchat/runtime/main.mjs`、`build/pchat/frontend` |
| Vite cacheDir | `cache/pchat/vite-desktop` |
| TAURI_APP_PATH | `build/pchat/native-stage` |
| TAURI_FRONTEND_PATH | 源码 `apps/desktop` |
| Node 副本、Tauri 生成 schema | 暂存工程内部 |
| NSIS/WiX 下载 | Cargo target 的 `.tauri`；暂存配置启用 `bundle.useLocalToolsDir` |

Vite 使用 `--configLoader runner`，前端输出清理仅作用于专用的前端构建目录。暂存脚本验证目标后替换 `native-stage`，复制当前受控的 Rust、Cargo、capabilities、icons 和配置，防止旧权限残留；构建期间用专用锁避免并发覆盖。Rust 源码改变后需重新运行包装脚本生成暂存工程。

开发版 Host 从开发输出根目录读取 Runtime；发布版从安装资源读取捆绑 Runtime。正式发行版不启动 localhost 服务，Vite 本地服务器仅用于开发模式。

暂存配置中的 `frontendDist` 必须使用相对目录（当前为 `../frontend`）。Windows 绝对路径会被 Tauri 解析为 URL，导致页面未嵌入并导航到本地目录；安装检查已实际复现此问题。

正式安装产物为 `cargo-target/pchat/release/bundle/nsis/Pchat Agent_0.1.0_x64-setup.exe`。本机使用 `/S /NS /D=D:\Dev\apps\Pchat` 安装；`/NS` 不创建快捷方式，`/D` 必须位于参数末尾。旧版 Pchat P0 保留。

应用运行时将 TEMP/TMP 和 WebView 数据目录设置在状态目录下，默认 `D:\Dev\state\pchat`，可通过当前进程 `PCHAT_DEV_ROOT` 指定另一输出根。SQLite、配置、DPAPI 加密凭证和知识库确认草稿也位于该状态目录。没有设置系统环境变量。

本机已完成 Runtime/前端构建、Rust 发布编译、NSIS 安装、捆绑 Node 的真实目录查询与持久暂停退出，以及 DPAPI 加解密测试。安装后的真实页面查询与事件订阅由 `scripts/verify-installed.ps1` 检查；具体结果见 [开发进度](./DEVELOPMENT-PROGRESS.md)，操作步骤见 [Windows 验收](./WINDOWS-ACCEPTANCE.md)。
