# 哲学圆桌 Wikipedia 核验记录

## 状态

- 研究状态：中止（Wikipedia MCP 被 Wikipedia API 限流）。
- 有效人物条目：0。
- 未使用 Web 搜索或任何其他资料来源。
- 未凭模型记忆补写人物、流派、著作或 Mermaid 图。

## Wikipedia MCP 错误证据

执行日期：2026-09-09（Asia/Shanghai）。

1. 初始连通性自检一度返回 `status: success`，端点为 `https://zh.wikipedia.org/w/api.php`，语言为 `zh`；这只证明自检当时成功，不构成任何人物条目证据。
2. 对 19 个候选人物名称执行 `search_wikipedia`，全部返回 `status: no_results`、空 `results`，并附带提示：`No search results found. This could indicate connectivity issues, API errors, or simply no matching articles.`
3. 对人物短名、中文全名和英文名尝试 `get_article`（以康德为例：`康德`、`伊曼努尔·康德`、`Immanuel Kant`），全部返回 `exists: false`，错误字段均为 `https://zh.wikipedia.org/w/api.php`；没有返回摘要、正文、分类、章节或 URL。
4. 对中文全名批量调用 `get_summary`，全部返回同类错误：`Error retrieving summary for '<条目名>': https://zh.wikipedia.org/w/api.php`。
5. 进一步对 `康德` 调用 `get_sections`、`extract_key_facts` 和 `get_links`：章节与链接为空，关键事实返回 `Error extracting key facts for '康德': https://zh.wikipedia.org/w/api.php`。
6. 最后的 `test_wikipedia_connectivity` 明确返回：`status: failed`，`error_type: HTTPError`，错误为 `HTTP 429 from Wikipedia API: 429 Client Error: Too Many Requests`。

## 切换英文后的复测

用户移除中文配置后，于同日再次复测：

1. 语言切换已经生效。`test_wikipedia_connectivity` 报告 `language: en`，端点变为 `https://en.wikipedia.org/w/api.php`。
2. 英文端点仍返回 `HTTP 429 Too Many Requests`；失败请求是 MediaWiki API 的 `action=query&meta=siteinfo` 连通性检查。
3. `search_wikipedia` 查询 `Immanuel Kant` 返回 `status: no_results`、空 `results`，并提示这可能由 connectivity/API errors 引起。由于康德条目显然属于预期检索对象，该响应只能视作 API 失败后的假阴性，不能作为“没有条目”的证据。
4. `get_article` 读取 `Immanuel Kant` 返回 `exists: false`，同时错误字段为 `https://en.wikipedia.org/w/api.php`，且没有摘要、正文、分类、章节或 URL。该结果同样是错误包装，不能作为人物或作品核验依据。
5. 中文和英文配置均在 Wikipedia API 层失败，故问题不是中文条目标题、中文分词或译名造成的；切换语言不能规避当前限流。
6. MCP 能正常接收并执行工具调用，但它依赖的 Wikipedia 上游拒绝请求。部分工具保留了明确的 429，部分工具则把失败降级为 `no_results` 或 `exists: false`，这是本次不能继续批量核验的直接原因。

## 结论

Wikipedia MCP 在中文与英文端点均未取得任何可供核验的人物条目，因此当前无法在“只使用 Wikipedia MCP”的限制下形成证据化的人物—流派—著作映射，也无法可靠生成 Mermaid 分类图。继续请求会扩大限流并产生更多假阴性，已停止重试。
