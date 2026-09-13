# 千帆 RAG adapter 与资料清单采集预研

核对日期：2026-09-14。本切片只实现 P5 的独立检索 adapter，使用网络替身与注入的 SHA-256；没有真实 Key、线上调用或知识库资料。用户继续在百度控制台上传和管理文档。

## 官方检索接口

当前接口为 `POST https://qianfan.baidubce.com/v2/knowledgebases/search`，使用 API Key 鉴权；`knowledgebase_ids` 限定知识库，`metadata_filters.filters` 的 `doc_id in [...]` 限定文档。支持显式 recall、rerank、top_k、score_threshold，并可关闭图谱与扩展。返回 `chunks`、片段文本及元信息。`meta.update_time` 是片段更新时间，字段表写 string、示例给 number；`doc_info.doc_id` 和更新时间为可选字段，响应不承诺返回知识库 ID 或不可变库版本。[知识库检索](https://cloud.baidu.com/doc/qianfan-api/s/5mgq9zd5a)

## 冻结与来源校验

[`QianfanRAG`](../../packages/providers/src/qianfan.ts) 实现已有 `RAGPort`；配置 resolver 必须返回与请求 connectionId、corpusId、corpusRevision、retrievalConfigRevision 完全相同的配置。每次调用复制确认清单，后续设置变更不能替换本次资料范围或来源标签。请求只包含一个知识库和清单中的文档 IDs，不开放 URL、Header、凭证、上传或千帆应用聊天能力。

确认清单按文档保留 sourceId、sourceRevision、PRIMARY/RESEARCH 分类及经审核的作品信息；按片段保留 chunkId、预期更新时间、SHA-256 与可空的稳定定位。返回片段必须属于清单，更新时间类型和值相同，实际文本 SHA-256 相同；未确认片段、跨文档、可识别的跨库字段、缺元信息、变更、重复或图谱/扩展内容均拒绝。多段 text 按原顺序以一个换行连接，保留原文空白；采集器必须使用同一规则。

这只能证明**实际返回的片段符合已确认快照**，不能证明整个远端库没变、所有片段仍可检索或召回排名可复现。没有返回片段时允许得到空结果，不据此推断库是否完整。`corpusRevision` 是 Pchat 已确认清单的标识，不是供应商提供的远端不可变版本。

返回 Evidence 保存实际文本、`sha256:` 校验值和经审核的来源版本。id 由连接、知识库、文档、片段和来源版本等身份信息的 SHA-256 生成。作品名不从文件名推断，版本、译者或稳定定位缺失时保持 null；供应商附加字段不能把 RESEARCH 变成 PRIMARY。Hash 由注入的 `ContentHasher` 提供，生产 package 不依赖 Node crypto 或浏览器 API。测试使用 Node crypto，并包含标准 `abc` SHA-256 向量。

## 错误、取消与资源

完整 4xx 响应表示明确拒绝；5xx、断流、截断 JSON 和无法确定的错误保守返回 OUTCOME_UNKNOWN。合法响应中不满足清单或结构约束的内容返回 REJECTED。不自动重试，不回传原始供应商或传输错误文字。

请求头等待、响应读取和异步 hash 均受取消控制，迟到结果不会作为 Evidence 返回；释放流时也覆盖响应头完成与取消之间的竞争。总响应上限为8,000,000个 UTF-16 code units，错误响应同样计数。真正的 UTF-8 解码、超时、字节限制、网络取消和凭证注入仍由 Host 负责。

## 后续自动采集资料版本

清单应由 Pchat 自动读取并交给用户确认，不能要求用户逐片段填写 hash 或时间。官方已提供以下只读操作（HTTP 方法虽然为 POST，语义为查询）：

| 操作 | 固定端点 | 采集要点 |
| --- | --- | --- |
| 文档列表 | `/v2/knowledgeBase?Action=DescribeDocuments` | knowledgeBaseId；marker、maxKeys≤100；nextMarker、isTruncated。2025-12 变更说明把 id 改为 documentId、displayStatus 改为 status，旧示例尚未同步；需明确兼容校验。[文档列表](https://cloud.baidu.com/doc/qianfan-api/s/hm7wy40z3) |
| 切片列表 | `/v2/knowledgeBase?Action=DescribeChunks` | knowledgeBaseId、documentId；分页同上。content 的说明标有截断，不能直接作为完整文本 hash 的输入。[切片列表](https://cloud.baidu.com/doc/qianfan-api/s/Om7wrvnmy) |
| 切片详情 | `/v2/knowledgeBase?Action=DescribeChunk` | knowledgeBaseId、chunkId；响应包含 content、库/文档/片段身份、状态与 updateTime。详情字段未标截断，是采集完整文本的候选来源。[切片详情](https://cloud.baidu.com/doc/qianfan-api/s/Fm7wre5d9) |

三个接口的权限说明均要求 API Key；没有真实账号，尚未验证实际资源权限或费用。上述 API 不授予 Pchat 上传、修改或删除文档的能力。采集应检查分页循环、重复身份、库/文档归属、可用状态和容量上限，并在确认前保持草稿状态。

**当前格式未决：** 列表/详情的 updateTime 示例为秒级数值，search 示例为毫秒级数值；列表类型说明又与示例不一致。仅凭不同示例不能证明统一换算规则。采集器必须保留实际原始值与来源，不能猜单位或将字符串/数字静默互转。未来需要真实账户或官方明确契约证明详情与 search 时间字段的关系；未确认前，严格 adapter 会拒绝不一致结果，不悄悄更新旧清单。完整文本的跨接口一致性也需实测。

## 本切片验证

2026-09-14 01:22，千帆44项测试与已有 DeepSeek41项测试全部通过，providers package 类型检查通过。全仓测试类型检查在01:21通过；01:22 因并行 UI 切片尚未链接 `@pchat/client` 暂时失败，最终集成结果以唯一进度文档为准。

```powershell
. D:\Dev\pchat-env.ps1
pnpm exec vitest run --configLoader runner packages/providers
pnpm --filter @pchat/providers check
pnpm check:tests
```

测试只通过公共 `RAGPort`、网络与 hash seam 验证。覆盖范围、冻结版本、实际文本、缺字段、引用元信息、空结果、HTTP 错误、取消迟到、异常脱敏及尺寸限制。真实召回、译本、时间字段互操作、账户权限、费用和哲学支持度尚未测试。

本切片没有新增依赖、修改持久环境/工具配置或提交 Git；shell 均使用现有 D 盘环境脚本。未修改已验证的 DeepSeek 生产代码。
