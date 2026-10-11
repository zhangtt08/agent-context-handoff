# ACB · Agent API（personal-agent-hub 标准 v1，就地接入形状 B）

ACB 把自己**现有**的 Express 服务（默认 `127.0.0.1:5174`）直接实现成带 schema 的工具面（只做本机交接，不含跨机传输工具）：
没有第二个进程、没有第二个端口、没有第二份实现。

```
agent/launch.json      启动方式 + ready_port(5174) + ready_path(/api/health)
agent/mcp-server.mjs   MCP stdio 桥（标准模板复制；端口全部来自 env / launch.json，无硬编码）
agent/tools.mjs        注册表的命令行外壳（--list / --manifest / --call / --selftest）
agent/.endpoint        生成物（gitignore）：固定端口启动时写入实际地址，供 MCP 桥与 hub 发现
```

工具契约的实现只有一份：`server/agent/tools.ts`（+ `server/agent/routes.ts` 的 HTTP 外壳、
`server/agent/schema.ts` 的入参校验、`server/agent/errors.ts` 的错误码）。
`agent/tools.mjs` **不重写 handler** —— 它要么打 HTTP（服务在跑），要么 require 同一份编译产物
`dist-server/server/agent/tools.js`。两份 handler 迟早会给出两个不同的数字，那是最难查的缺陷。

## 启动

```bash
npm run agent:serve      # tsx server/main.ts（入口是 main.ts：index.ts 只导出 startServer、不 listen）
npm run agent:mcp        # MCP stdio 桥（服务没起时它按 agent/launch.json 自己拉一个）
node agent/tools.mjs --list
node agent/tools.mjs --selftest      # 逐个真跑只读工具，确认返回的是本机真实数据
```

## HTTP 契约

| 端点 | 形状 |
| --- | --- |
| `GET /api/health` | `{ok:true,data:{project:'acb',version,agent_api:1,uptime_ms,tools,...}}` |
| `GET /api/agent/manifest` | `{ok:true,data:{project,version,base_url,agent_api,tools,conventions}}` |
| `GET /api/agent/tools` | `{ok:true,data:[{name,description,input_schema,risk}]}` |
| `POST /api/agent/tool` | 成功 `{ok:true,data,tool,risk,ms}`；失败 `{ok:false,error:{code,message,hint?,available?}}` |

状态码：入参错、未知工具（带 `error.available` 数组）、需要确认、找不到 → **400**；
只有服务内部故障才是 **500**。四个端点都注册在 SPA 兜底之前，拼错的 `/api/agent/*` 也回 JSON 而不是 HTML。

## 怎么被找到（端口不靠猜）

候选顺序：`AGENT_BASE_URL` → `agent/.endpoint` → `~/.acb/endpoint.json` → `AGENT_DEFAULT_BASE`(5174)，
每个都探一次 `/api/health`，探不通就换下一个。第三份是服务端每次 listen 后写的
（`pid` / `port` / `base_url` / `started_at` / `version`），**桌面版跑随机端口时只有这一条路**；
服务正常关闭时按 pid 收回，不会留一个连不上的地址冒充在线。

## MCP 侧的两个开关（因为工具表本身要进上下文）

- `ACB_MCP_TOOLS=handoff_takeover`：`tools/list` 只登记列出的这几条（可省 `acb.` 前缀）。
  16 条全挂的一次性工具表实测 3319 tokens，比直接把简报丢给 Agent 还贵 —— 这条接口就不该那样用。
  接手角色登记 1 条（表 233 tokens），要它同时能自己收尾再加 `handoff_create`。
- `ACB_MCP_PRETTY=1`：`tools/call` 默认回**紧凑** JSON（缩进是给人看的，模型侧白烧 token）。

成本可复算：仓库根跑 `npm run tokens`（同一把尺子对比"丢文件"与"调接口"，不省就红着退出）。

## 直接走 HTTP 的接法（没有 MCP 也行）

```
GET /api/handoff-brief?at=D%3A%5Cdev%5Cmy-project            # 摘要（默认）
GET /api/handoff-brief?projectId=prj_x&level=files           # 只要文件清单
GET /api/handoff-brief?handoffId=hnd_x&level=brief&format=text  # 简报原文，纯文本
```
令牌：`GET /api/handoff-brief` 属于只读方法，设了 `ACB_LOCAL_TOKEN` 也不需要带；
一旦设了令牌，所有非只读请求（含 `POST /api/agent/tool`，封存/恢复都走这一条）必须带
`x-acb-token`，MCP 桥与 `agent/tools.mjs` 会把同一个环境变量透传过去（见 `server/core/local-guard.ts`）。

## 工具清单（16 个，全部 `acb.` 前缀）

只读（10）——不写任何字节：

| 名称 | 真实能力 |
| --- | --- |
| `acb.handoff_takeover` | **接手第一条该调的**：`at=<工作目录>`（或 projectId / handoffId）→ 任务、该看哪几个文件、下一步、检查结论、需本机补齐的材料，外加 `cost`（本次摘要 vs 简报原文的 token 估算）。`level=summary\|files\|brief` |
| `acb.storage_status` | 注册表/报告路径、绑定地址与端口、是否要令牌、存储层坏文件警告（`server/core/store.ts`） |
| `acb.projects_list` | `~/.acb/projects.json` |
| `acb.project_overview` | 与总览页同一份 `server/core/overview.ts`（git status + 任务分组 + 分叉判定） |
| `acb.handoffs_list` | `<project>/.acb/store/handoffs/*/record.json` |
| `acb.handoff_detail` | 单条交接的 state / 观测 / 验证记录 / 声明 / 子交接 / 包目录 |
| `acb.handoff_integrity` | `verifyPackage()`：逐条目实测 SHA-256 |
| `acb.handoff_preview` | `buildPreview()`：打包前审阅清单（含排除原因、阻塞项） |
| `acb.resume_reports` | `~/.acb/resume-reports.json` |
| `acb.job_status` | 异步封存/恢复作业的进度表 |

写入（2）：`acb.project_register`（write；除注册表条目外还在项目里写 `.acb/LATEST.md` 指针与
`AGENTS.md` 里那段 ACB 接入块 —— 项目里先建一个空文件 `.acb/NO-BRIDGE` 就不会碰 AGENTS.md）、
`acb.project_config_save`（write，带 `checks` 时要 `confirm`，
因为写进去的是**以后会被执行的命令**）。

执行（2）：`acb.handoff_create`（`taskName` 可以留空，留空即用 ACB 从分支名/提交标题/diff 推断出来的那句 ——
被换掉之前自己交接的那个 Agent 不该被迫现编一句人类文案）、`acb.resume_restore`（destructive）。
移除（1）：`acb.project_remove`（destructive，只动注册表条目，不删盘上任何东西）。

`risk` 为 `exec` / `destructive` 的工具在 `confirm !== true` 时一律拒绝，返回
`400 {code:'confirm_required'}`。这条判定写在 `executeAgentTool()` 里**集中做一次**，
不指望每个 handler 自己记得 —— 新增一个 exec 工具却忘了设闸门，是最危险也最没人注意的失效方式。

## 安全边界（这一节是这轮验收加的，改守卫前必读）

- **只监听 127.0.0.1**。`ACB_BIND_HOST` 可以覆盖，但值必须是字面回环地址（`127.0.0.1`、`::1`、
  127/8 段），否则服务**拒绝启动**。
- **Host 头白名单**：只接受 `127.0.0.1:<port>` / `localhost:<port>` / `[::1]:<port>`，
  判据是固定字面量清单，**不拿请求自己的 Host 当基准**（那是 DNS 重绑定的正解：
  `evil.example` 解析到 127.0.0.1 之后，请求确实来自回环，但它来自另一个源）。
- **Origin/Referer**：存在时必须等于本服务自己的回环源，否则 403 `forbidden_origin`。
- **本机令牌**：`ACB_LOCAL_TOKEN` 一旦设置，所有非 GET 请求必须带 `x-acb-token`（定时安全比较）。
  MCP 桥与 `agent/tools.mjs` 会把同一个环境变量透传过去；值只待在进程环境里，不进代码、不进日志。
- 服务端**从不**回 `Access-Control-Allow-Origin: *`：这个服务没有跨源调用方。
- 开发模式（vite :5173 代理到 :5174）需要放行 5173：`开发模式.cmd` 已经内置
  `ACB_ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173`。手工 `npm run dev` 时自己设一次。
  这一项**只接受回环源**，非回环值会让服务拒绝启动。
- `agent/tools.mjs` 在服务没起时会直连本地模块执行：那绕过的是网络入口的三道闸门，
  但**不是提权** —— 能执行这条命令的进程本来就有当前用户的文件权限，与 `npm run cli` 同一档；
  confirm 闸门仍然在同一份注册表里生效。

## 个人 Agent Hub 注册

`personal-agent-hub/config/catalog.json` 的 `acb` 条目按标准 v1 登记：`api.health=/api/health`、
`agent_api`（工具数与单入口）、四个契约端点进 `reads`、`POST /api/agent/tool` 进 `writes`。
调用方一律读 `agent/.endpoint` 或 `AGENT_BASE_URL`，不硬编码端口。
