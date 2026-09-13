# Pchat 文档索引

本目录只保留当前有效的设计、验证和资料审计文档。文档出现局部重复时，以下职责边界决定哪一份具有权威性。

正式开发从 [`DEVELOPMENT-HANDOFF.md`](./DEVELOPMENT-HANDOFF.md) 开始；该文档说明当前实现、阶段任务、验收条件和开发环境约束。

当前实施进度、验证证据与提交记录统一见 [`DEVELOPMENT-PROGRESS.md`](./DEVELOPMENT-PROGRESS.md)。P1 工作流与状态表见 [`P1-WORKFLOW.md`](./P1-WORKFLOW.md)，后续优化计划见 [`P2-P5-IMPLEMENTATION-PLAN.md`](./P2-P5-IMPLEMENTATION-PLAN.md)。

本机构建命令、D 盘输出与缓存配置见 [`BUILDING.md`](./BUILDING.md)。

## 产品与架构

- [`PCHAT-CURRENT-PRODUCT-CONSENSUS.md`](./PCHAT-CURRENT-PRODUCT-CONSENSUS.md)：已经确认的产品目标、范围和行为。
- [`PCHAT-CURRENT-HARNESS-ARCHITECTURE-AND-IMPLEMENTATION-PLAN.md`](./PCHAT-CURRENT-HARNESS-ARCHITECTURE-AND-IMPLEMENTATION-PLAN.md)：当前技术架构与实施顺序。
- [`RUNTIME-INVARIANTS.md`](./RUNTIME-INVARIANTS.md)：实现必须持续满足的运行时规则；与架构计划冲突时，应先停止编码并修订两份文档。
- [`PCHAT-SECURITY-THREAT-MODEL.md`](./PCHAT-SECURITY-THREAT-MODEL.md)：安全边界、威胁和发布阻断条件。
- [`P0-VALIDATION-REPORT.md`](./P0-VALIDATION-REPORT.md)：P0 技术路线的实测结果，不用于替代架构规范。

## 哲学资料审计

- [`PHILOSOPHY-ROUNDTABLE-WIKIPEDIA-AUDIT-PART-1.md`](./PHILOSOPHY-ROUNDTABLE-WIKIPEDIA-AUDIT-PART-1.md)：第一组思想家、传统与代表作的 Wikipedia 核验。
- [`PHILOSOPHY-ROUNDTABLE-WIKIPEDIA-AUDIT-PART-2.md`](./PHILOSOPHY-ROUNDTABLE-WIKIPEDIA-AUDIT-PART-2.md)：第二组思想家、思想阶段与代表作的 Wikipedia 核验。
- [`PHILOSOPHY-EPUB-LEGAL-SOURCE-AUDIT.md`](./PHILOSOPHY-EPUB-LEGAL-SOURCE-AUDIT.md)：可合法获取的 EPUB 来源和版权限制。

此前因 Wikipedia API 限流而产生、且没有有效人物条目的失败记录已删除。后续成功核验文档已经取代它。

## 领域词汇

仓库根目录的 [`CONTEXT.md`](../CONTEXT.md) 只定义领域概念和术语，不记录技术实现与阶段进度。
