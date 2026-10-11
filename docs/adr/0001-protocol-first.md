> **v0.2 现状（2026-10-08）**：本产品已收敛为"只做本机 Agent 交接"，跨电脑传输（GitHub 交接分支 / 自包含文件导出）连同其取舍一并撤下。本记录保留为历史决策依据。

---
status: proposed
---

# 让交接协议独立于 Agent 与 Harness

Agent Context Bridge 的价值依赖不同模型、Harness 和 Session 能读取相同状态。采用版本化 JSON 作为权威状态表达，并生成通用 Markdown 接手入口；特定 Agent 集成位于协议之外。相比直接搬运某个 Harness 的聊天记录，此选择需要单独维护协议契约，但使交接的身份、证据与兼容性不依赖该 Harness。

这是 v0.1 的推荐架构方向，正式协议在实现阶段细化。
