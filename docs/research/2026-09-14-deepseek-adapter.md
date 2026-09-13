# DeepSeek Model adapter：接口核对与离线验证

核对日期：2026-09-14。范围：P5 供应商 adapter 的独立工程切片；不代表 Host、凭证、在线账户或哲学内容验收已完成。所有请求均使用测试网络替身，未读取或调用真实 API Key。

## 官方接口事实

- Chat Completions 使用 `POST /chat/completions`，以 `model`、`messages`、`stream` 等字段请求。流式内容通过 SSE `data` 事件发送，使用 `[DONE]` 结束。当前文档的终止原因包括 `stop`、`length`、`content_filter`、`tool_calls`、`insufficient_system_resource` 与 `aborted`。型号目录与参数支持会变，不能将旧型号写死在 Harness 或人物包。[Chat Completions API](https://api-docs.deepseek.com/api/create-chat-completion/)
- JSON 输出需同时设置 `response_format.type=json_object`，在提示中明确要求 JSON 并提供格式示例。该功能仍可能返回空内容；输出预算不足可能截断对象。JSON 模式不等于 Pchat 的 `AnswerSchema` 验证通过。[JSON Output](https://api-docs.deepseek.com/guides/json_mode/)
- 当前思考模式将推理内容放在 `reasoning_content`，正文放在 `content`；无工具调用时无需把推理内容送回历史。思考开关与采样参数的行为取决于供应商版本。Pchat 本切片不保存、展示或回传 `reasoning_content`。[Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/)
- 等待期间可能收到 `: keep-alive` SSE 注释，不能把这些内容视为正文。官方说明等待推理超过十分钟可能关闭连接，因此旧 P0 的统一五秒超时不能直接用于正式生成。[Rate Limit & Isolation](https://api-docs.deepseek.com/quick_start/rate_limit/)
- 官方区分格式、认证、余额、参数、限流和服务器错误。Pchat 的恢复策略比官方错误页中的“重试”建议更保守，仍必须遵守 INV-014，任何不确定结果不得自动重新付费调用。[Error Codes](https://api-docs.deepseek.com/quick_start/error_codes/)
- SSE 要处理 UTF-8、开头 BOM、CR/LF/CRLF、注释、可选空格与多行 `data` 字段；没有空行结束的最后事件不能当作完整事件。[HTML Standard：SSE 解析](https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream)

## 已实现的工程边界

生产入口为 [`DeepSeekModel`](../../packages/providers/src/deepseek.ts)，实现 Harness 的 `ModelPort`。构造参数只包含 `SecureNetworkPort` 与配置解析器。调用使用冻结的 `ModelBinding`；解析器返回的 connection、model 与 revision 必须全部相同，参数必须有效，才发送请求。模型号、输出 token 预算、temperature 与 topP 来自配置，不放进人物资料包。

共享网络 seam 位于 [`network.ts`](../../packages/providers/src/network.ts)：

```ts
request({ connectionId, attemptId, operation, body }, cancellation)
  => Promise<{ ok: true; status: number; body: AsyncIterable<string> }
    | { ok: false; code: "REJECTED" | "OUTCOME_UNKNOWN" }>
```

`operation` 仅接受 `deepseek.chat` 与 `qianfan.search`；`attemptId` 只用于关联和取消，不承诺供应商幂等。此 TypeScript 类型不是 Host 的安全校验替代品。后续 Rust Host 必须验证供应商与操作、请求字段和大小，固定端点、禁止重定向、自行注入凭证、连续解码 UTF-8，并实现总超时、闲置超时、响应字节限制和真正的网络取消。普通模块没有 URL、Header 或 Key 参数。

系统规则与不可信任务数据分开。授权知识模式经过 schema 校验后写入系统规则；人物说明、问题、历史和检索资料仅作为序列化 JSON 数据发送。无工具能力。这里验证的是输入隔离结构，不能把它宣称为已经通过真实模型的 prompt injection 或论断支持度评测；Harness 继续执行模式、引用与 scope 校验。

流式正文使用针对 Answer 的严格 JSON 状态机：只从顶层 `text` 字符串提取解码增量，允许字段换序与合法转义，拒绝未知/重复字段、嵌套替代值、坏转义和不完整对象。正文在整个 JSON 对象完成前即可显示为草稿。必须收到 `stop`、完整 `[DONE]` 事件与有效 `AnswerSchema` 才输出完成结果；最终空白正文也拒绝。供应商 JSON 包装、原始错误正文和推理字段不进入 ModelPort 输出。

完整 4xx 响应以及明确结束的长度限制、过滤或工具请求映射为 `REJECTED`。截断响应、5xx、中断、错误帧、不完整答案和无法确认的结果保守映射为 `OUTCOME_UNKNOWN`。不自动重试。取消能够终止 adapter 等待并隔离迟到结果；物理中止及实际计费仍由 Host 与供应商决定。adapter 另设累计 8,000,000 个 UTF-16 code units、单 SSE 事件 1,000,000、答案 JSON 2,000,000 的内存保护；注释和错误正文也计入限制。这是工程保护上限，不是 token 或人民币预算。

## 验证与后续集成

2026-09-14 01:01 公共 `ModelPort` seam 的首40项离线测试及 package 类型检查、全仓测试类型检查通过。01:05 自审增加“响应头完成与取消竞争时关闭响应”的失败测试并修复后，41项离线测试通过；同时进行的 P3 多人物契约修改暂时使 Harness 类型检查失败，最终集成门禁以唯一进度文档为准。验证命令：

```powershell
. D:\Dev\pchat-env.ps1
pnpm exec vitest run --configLoader runner packages/providers/src/deepseek.test.ts
pnpm --filter @pchat/providers check
pnpm check:tests
```

测试包括真实提前流出 text、逐字符 SSE/JSON 分片、Unicode 转义、BOM、多行 data、保活、终止原因、缺字段、未知/重复键、空/截断正文、4xx 完整性、取消迟到及响应关闭竞争、错误脱敏、冻结配置、恶意资料隔离和累计尺寸限制。测试不检查私有 parser 方法，也不依赖实际模型。

后续仍需：P3 的完整执行与上下文预算配置对接、精确模型输入/提示版本审计；Rust 安全网络与凭证接入；Windows 集成及安装验证；用户提供账户与语料后的权限、模型可用性、流式行为、费用、真实取消、依据支持度和提示攻击评测。未把工程测试当作上述结果。

本切片没有修改持久环境或工具配置，没有自行安装依赖；每条 shell 命令均使用现有 `D:\Dev\pchat-env.ps1`。新增 package 的 workspace 链接由主任务统一离线安装，未下载供应商 SDK。
