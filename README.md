# ACB — Agent Context Bridge

**本机**的 Agent 上下文交接工具：把一个正在开发的项目（Git 基线 + 暂存区 + 工作区 + 检查结论 + 你写的说明）
封存成**不可变交接包**，并渲染成一份**接手简报 `HANDOFF.md`**。
下一个 AI Agent 只读这一份文件（约 3 KB）就能接着干 —— 不必重读长聊天记录，不必重新扫仓。

> 起因：多个 Agent 订阅轮流接手时，代价花在"重读记录 + 重新理解现场"。
> 判据：交接好不好用，看接手方读完简报能否直接动手 —— 而不是看包有多完整。
> 范围：只做本机交接。跨电脑（导出文件 / 推 GitHub 分支）不在本产品范围内，代码与协议里都已移除。

## 用哪个入口

| 你是谁 | 怎么做 |
| --- | --- |
| 只想用 | 双击 `release\ACB-win64\ACB.exe`，看根目录 `使用说明.txt` |
| 改代码 | `npm install` → 双击 `开发模式.cmd`（API :5174 + 界面 :5173）。要重新打包 exe 还需先取 Electron 运行时：`HTTPS_PROXY=http://127.0.0.1:7897 node node_modules/electron/install.js` |
| 脚本化 | `npm run cli -- overview \| register \| takeover \| brief \| preview \| create \| restore` |
| Agent 自己调 | HTTP `GET /api/handoff-brief?at=<项目目录>`（地址在 `~/.acb/endpoint.json`）、MCP stdio 桥 `npm run agent:mcp`、或 `POST /api/agent/tool`（16 个 `acb.*` 工具，见 `agent/README.md`） |

## 为什么不是"我自己去另一个 Agent 打一段提示词"

提示词能做两件事：说出意图、领对方去读某个地方。ACB 把这两件事都从人身上拿走了，
剩下的是提示词根本带不了的东西 —— 代码现场本身。

| 交接里要说的事 | 从哪来 | 人要做的 |
| --- | --- | --- |
| 任务是什么 | 最近提交标题 → 兜底分支名 → 改动量占位 | 不对就改一句 |
| 做到哪了 | `git diff` 新增行里真实出现的常量/函数/类名，按文件带 +行/-行 | 不用写 |
| 下一步做什么 | 代码里新留下的 TODO/FIXME 原文（含文件:行号）+ 改了源码却没改的兄弟测试 | 不用写 |
| 上一个 Agent 的想法 | 它自己写进 `<项目>\.acb\NEXT.md` 的便签；不写也有上面三行推断 | 不用写 |
| 下一个 Agent 怎么知道有交接 | `<项目>\AGENTS.md` 里 ACB 维护的接入块 → `.acb\LATEST.md` 指针 → 那份简报 | **不用转述** |
| 被换掉的那个怎么留下交接 | 接入块里写着可直接跑的封存命令（`acb.handoff_create` / CLI），`taskName` 可留空 | **不用点界面** |
| 代码本身 | 基线 bundle + 工作区版 + 暂存版 + 删除/改名 + 空目录 + 链接/执行位，逐文件 SHA-256 | 不用管 |

前四行是"内容不由人写"，中间两行是"话不由人带"，最后一行是一段文字做不到的事：
一段提示词不能把 12 个文件的暂存版与工作区版、3 个删除、1 个改名和 2 个空目录还原出来，
更不能证明还原出来的就是那一份。
每一条推断都带着自己的依据出现在简报里；没证据的地方照实说"没有"，不编。

## 界面：一页，两个动作

没有侧边导航、没有多页路由。整页就是：

- **① 交出去** —— 一块浅色卡片先摆出 ACB 推断出来的任务 / 进度 / 下一步（每行标依据），
  下面只有一个按钮「就这样，生成交接」；想改就展开「我来改 / 补充」。
  完成后绿框报的是**这次在项目里写了什么**：接入块是新增/追加/原样不动，指针是否已重写，
  以及交接简报的绝对路径；「备用：还是想自己粘一段话给下一个 Agent」收在折叠里，
  给不认识 `AGENTS.md` 约定的客户端用。审阅清单（纳入/排除/阻塞/警告）默认收起，
  有阻塞或警告时闸门自动出现在按钮上方，每条都带"出路"。
- **② 接过来 / 回到某次交接** —— 从本项目已封存的交接里挑一条 → 还原到一个**新目录**：
  先「预览」（不写盘）看清将写入多少、撞了哪些，再落地。还原给出四态判定（可继续 / 需要配置环境 /
  需要重新验证 / 恢复被阻塞）、逐项对账（一致 / 变更 / 只在包里 / 只在目标），
  并在目标目录写 `ACB-HANDOFF.md` 与 `ACB-RESUME-REPORT.md`，同时装好接入块与指针 ——
  在那个目录里打开的 Agent 同样不需要有人领。
  **不提供"就地覆盖当前工作区"** —— 那会毁掉没封存过的改动。
- **③ 本项目的交接记录** —— 每条一行，点开才实测包完整性（逐条目 SHA-256），
  内含观测 / 验证记录 / Agent 声明三栏分列与父子谱系。
- **换项目 / 管理**（右上角）—— 注册、移除、检查命令；注册这一步就会在项目里装上接入块。

## 项目侧接入（这是"不用当传声筒"的那一半）

`server/core/bridge.ts` 只写两样东西，判据和写法都刻意收窄：

- `<项目>\AGENTS.md`：**一段固定八行的接入块**（`<!-- ACB:BEGIN -->` 到 `<!-- ACB:END -->`）。
  内容不含任何一次交接的可变量，所以只写一次 —— 每次封存都重写它的话，项目里就会多出一处永远在变的 diff。
  已存在的 AGENTS.md 只在末尾追加这一段，人写的原文一字不动；标记残缺（有 BEGIN 没 END）时不改文件并说明原因。
- `<项目>\.acb\LATEST.md`：每次封存/还原都重写。写当前是哪条交接、任务名、简报入口，
  以及**那个 Agent 自己能跑的封存命令**（打包态是 `node "…\cli.cjs" create <projectId>`，
  参数全 ASCII —— 这台机器的 shell 会把中文参数转坏，所以自封存这条路上不该出现现编的中文句子）。

停用：删掉标记之间那段，再建一个空文件 `<项目>\.acb\NO-BRIDGE`；此后 AGENTS.md 一个字节都不改，
指针照写（界面与 CLI 都会说明"为什么没写"）。反过来，如果 AGENTS.md 里只有这段接入块，
审阅清单与简报都会标明"这是 ACB 自己写的，不是你的改动"；一旦掺了人写的句子就不再这么算 ——
判据是把增删行与接入块逐行比对，不是看文件名。

## 接手接口（HTTP / MCP / CLI 同一份判据）

`server/core/takeover.ts` 是"Agent 直接问"的那一层，三条入口共用它，不各写一遍"接手哪一条"：

| 入口 | 形状 |
| --- | --- |
| HTTP | `GET /api/handoff-brief?at=<项目或子目录>`（也收 `projectId` / `handoffId`；`level=summary\|files\|brief`；`format=text` 回纯简报） |
| Agent 工具 | `acb.handoff_takeover`（`{"at":"D:\\dev\\x"}`） |
| CLI | `acb takeover <目录> [--level …]`，输出末尾直接印两边 token |

服务地址写在 `~/.acb/endpoint.json`（桌面版跑随机端口也写），MCP 桥与 CLI 外壳按
`AGENT_BASE_URL → agent/.endpoint → endpoint.json → 默认 5174` 逐个探 `/api/health`，
探不通就换下一个 —— 陈旧条目只会自己被跳过，不会把人带错地方。

**判据是"比丢文件省 token"，所以这条判据被做成了可复算的命令**：`npm run tokens`
（本机实测：简报全文 1193 → 摘要 276（23%）→ 只要文件清单 27（2%）；
MCP 只登记接手那一条时总成本 509（43%）；60 个改动文件的大现场里摘要占简报 19%）。
摘要这一侧有上界（文件列表 12 条 + 计数），简报没有，所以现场越大省得越多。
反过来说清楚一件事：MCP 若把 16 条工具全挂上，一次性工具表就要 3319 tokens，比丢文件还贵 ——
所以文档里写的是 `ACB_MCP_TOOLS=handoff_takeover` 按需登记，而不是"接上就更好"。
返回里 `cost` 两个数（本次摘要 vs 简报原文）随答案一起给，接口不省了调用方立刻看得见。

## 交接简报里有什么

按"读完就能动手"的顺序渲染（`server/core/protocol.ts`）：要做什么 → 上一个 Agent 做到哪了（声明与证据分开标）
→ 改动清单（逐条列出文件路径与状态，接手方只需打开这些）→ 检查结论（含可复跑的命令原文）
→ 不在包里/需本机补齐 → 观测事实 → 接手纪律（含"轮到你就自己封存"）→ 机器可读细节（state/manifest/payload 的入口）。

## 流程与代码位置

`capture → verify → seal → restore`，一台机器上的本地模块化单体，没有服务端中间人。

```
shared/types.ts     前后端共用的协议类型
server/core/        capture / verify / protocol / package / resume / store / overview
server/core/infer.ts 从分支名、提交标题、diff 新增行、TODO、未同步测试里推断交接内容
server/core/bridge.ts 项目侧接入：AGENTS.md 接入块与 .acb/LATEST.md 指针（注册/封存/还原三处都会写）
server/core/takeover.ts Agent 接手视图：摘要 / 文件清单 / 简报原文三档，HTTP、Agent 工具、CLI 共用一份判据
server/index.ts     Express API（只绑 127.0.0.1；:5174 或随机端口）
server/agent/       16 个 acb.* 工具的同一份实现（HTTP 与 MCP 共用，risk+confirm 集中设闸）
src/                单页界面（Workbench + Takeover + RecordDetail + ProjectSetup）
desktop/            Electron 壳（进程内起服务 + 原生对话框 + 打开文件 + 拖放取路径）
tests/e2e.ts        端到端验收（153 项断言，只在系统临时目录里跑）
docs/               架构、协议轮廓、术语表、ADR
```

交接包落在**被交接项目**的 `<project>/.acb/store/handoffs/<id>/`：
`HANDOFF.md`（接手简报）、`acb-state/project-state.json`、`manifest.json`（逐文件 SHA-256）、
`payload/work`（工作区版）、`payload/index`（暂存版）、`payload/baseline.bundle`（基线历史）。

## 安全边界（如实说明）

- 只绑回环，Host/Origin 白名单按固定字面量判定（不拿请求自己的 Host 当基准）；可选本机令牌 `ACB_LOCAL_TOKEN`。
- **ACB 会往被交接的项目根写东西**，这是它唯一碰业务目录的地方：`AGENTS.md` 里它自己那一段（标记之间）
  与 `.acb\LATEST.md`。每次写什么都在界面/CLI 里报出来，可用 `.acb\NO-BRIDGE` 完全关掉；
  这段文字是给 Agent 读的约定，ACB 自己从不执行它，交接包里的任何内容也从不被执行。
- 包内内容永不作为命令执行；检查只跑本机项目自己配置的命令，且写入这些命令是唯一的 exec 入口（带 confirm）。
- 默认排除 `.env*`、`node_modules/`、`dist/`、`.acb/` 等；排除项逐条给原因，凭据类写进"恢复要求"而不是静默丢弃。
  目录型排除会折成一条并标命中数，避免排除清单淹没真正要看的文件。
- 已提交进 Git 历史的凭据挡不住 —— 作为警告点名，需人工确认后才允许打包。
- 还原前逐条目实算 SHA-256；清单里的路径当不可信数据（`..`、盘符、UNC、仅大小写不同的路径一律拦住）。
- 封存与还原都不动源端分支、HEAD、暂存区与工作区。
- 交接包不可原地修改：新证据产生新交接，父子关系保留。
- 不支持 LFS 与 submodule。

## 验证

```bash
npm test        # 端到端验收：153 项断言，只在系统临时目录里跑（ACB_HOME 隔离，不碰 ~/.acb）
npm run typecheck
npm run lint
npm run package # 产出 release/ACB-win64（双击 ACB.exe）
npm run verify  # 发行包体检：必需文件、版本一致、包不比源码旧、包内服务起得来、守卫生效
```

MIT License · 本机运行，无云端中间人
