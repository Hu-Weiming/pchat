# 百度千帆 RAG 接入预研

调研日期：2026-09-12。状态：候选工程方案，尚未做真实鉴权或语料验证；本文不修改产品规则，也不将真实接入加入 P1 验收。

## 建议接入边界

首个百度 adapter 建议调用独立知识库检索 `POST https://qianfan.baidubce.com/v2/knowledgebases/search`。它接收查询和知识库 ID，返回片段；旧 `/v2/knowledgebases/query` 已在官方文档标为旧接口。[知识库检索](https://cloud.baidu.com/doc/qianfan-api/s/5mgq9zd5a)、[旧接口](https://cloud.baidu.com/doc/qianfan-api/s/5m7x37ohy)

千帆 Responses 的 `knowledge_search` 是模型响应的内置工具；应用 API 则管理千帆应用会话。基于 Pchat 已确认的检索与生成分离边界，本项目优先使用独立检索，生成继续通过 `ModelPort`，不将上述会话形态作为首个 `RAGPort` adapter。[内置知识库搜索](https://cloud.baidu.com/doc/qianfan-docs/s/rmi7glkjs)、[新建应用对话](https://cloud.baidu.com/doc/qianfan-api/s/zm7vrwf5p)

## 已核实的 API 事实

- 鉴权为 `Authorization: Bearer <API Key>`。千帆 API Key 不需要调用方实现签名算法；可分别配置主账号与子用户权限。[认证鉴权](https://cloud.baidu.com/doc/qianfan/s/Kmh4sutww)
- 查询支持文本；范围由 `knowledgebase_ids` 限定。可按文档 ID 或标签过滤；可配置全文、向量、混合检索和重排。最终 `top_k` 为 1–40。返回包含请求标识、片段 ID、文本及可选评分、文档信息和更新时间。图谱切片的来源元数据更少。[知识库检索](https://cloud.baidu.com/doc/qianfan-api/s/5mgq9zd5a)
- 检索响应的公开字段未承诺作品版本、译者、稳定章节定位、内容哈希或可指定的不可变资料库版本。文档字段表与示例对 `update_time` 的类型也不一致，需在接入时以边界校验和实际响应确认。[知识库检索](https://cloud.baidu.com/doc/qianfan-api/s/5mgq9zd5a)

## 对 Pchat 的含义与待验证项

以下是结合仓库规则作出的工程判断，而非百度能力承诺：

- `RAGPort` 使用供应商无关的资料范围、查询与证据结构；百度 adapter 映射为知识库 ID。将来开发机服务实现同一 port。每个人物仍使用独立且冻结的资料范围；不能用检索相关性替代资料隔离。
- `connectionId` 经 Host 允许清单调用已登记端点，由 Host 注入凭证；Key 不进入 Harness、普通协议、日志或测试快照。资料仍按不可信内容处理。
- 历史依据必须保存实际使用文本、来源定位、校验值与已知版本。供应商片段 ID 或更新时间不能自动证明译本、稳定定位或不可变版本。元数据不足时按现有产品规则降为概述。
- 暂定关闭图谱和上下文扩展，仅建立文本证据路径。检索参数是以后使用真实哲学资料校准的配置默认，不写死为产品规则。
- 尚未核实账号开通权限、实际费用及额度、解析质量、引文定位完整性、资料更新时的版本隔离。填 Key 本身不足以证明可正式使用，仍需准备知识库和样本完成在线验收。

项目依据：[产品共识](../PCHAT-CURRENT-PRODUCT-CONSENSUS.md)、[运行不变量](../RUNTIME-INVARIANTS.md)、[安全模型](../PCHAT-SECURITY-THREAT-MODEL.md)、[架构方案](../PCHAT-CURRENT-HARNESS-ARCHITECTURE-AND-IMPLEMENTATION-PLAN.md)。

## 需要用户确认的范围

只需确认：本次 Goal 是否仅完成 P1，或在 P1 后追加通过假 HTTP 响应验证的离线 adapter；以及资料是否由用户在百度控制台上传建库、Pchat 首版仅检索。具体 `/search` API 选择可采用上述默认，无需额外让用户决定 API 细节。

本次仅阅读公开文档并写入本笔记，没有调用供应商 API 或安装工具。Shell 仅设置当次进程 `TEMP`、`TMP` 为 `D:\Dev\temp\pchat`；没有修改持久环境或工具配置。
