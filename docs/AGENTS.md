# Agent 接手入口

本目录是 **ACB（Agent Context Bridge）** 的实现仓库：本机项目上下文交接工具，已实现并跑通（界面 + CLI + MCP 工具面 + Electron 便携版）。

先读根目录 `README.md`（做什么、怎么用、安全边界），再按需读：

- 改模块职责、捕获或恢复流程：[总体架构](ARCHITECTURE.md)
- 改状态字段、证据规则、包结构、兼容性：[协议轮廓](PROTOCOL-OUTLINE.md)
- 领域术语：[术语表](CONTEXT.md)；架构取舍：[ADR](adr/)
- 改 Agent 工具面与本机守卫：[../agent/README.md](../agent/README.md)

## 工作约定

1. **界面只有一页。** 新增能力先问"能不能放进 ① 交出去 / ② 接过来 / ③ 记录 这三块里的一个折叠区"，
   不要新开页面或导航入口。判据是用户第一次打开能否不问人就点下去，而不是功能有多齐全。
2. **观测 / 验证记录 / Agent 声明三者分开。** 声明不得写成"已验证"；源端检查结果不得被当成接收端结论。
3. **同一事实只有一处算法。** 预览与恢复、REST 与 Agent 工具必须共用同一份实现
   （`server/core/resume-flow.ts`、`server/core/workflow.ts`、`server/agent/tools.ts`）。
   出现"界面说 12 个文件、实际写 11 个"就是缺陷，不是文案问题。
4. **界面文案里的数字必须等于它声称的那个动作。** 计数、百分比、"已生成/已还原"之类的标签，
   都要能指回一次真实测量；做不到就换成人话 + 标明未测。
5. **改排除/纳入策略要同步简报。** `server/core/protocol.ts` 的接手简报是本项目对外的唯一 Agent 接口，
   它必须自足：读完这一份就能动手（列出改动文件路径、给出可复跑的检查命令原文）。
6. **验收以 `npm test` 为准，不得弱化断言。** 新增行为要补一条能失败的断言（先改坏实现确认它红）。
   `npm run verify` 是发行包体检；改过 `desktop/`、`scripts/pack-desktop.sh` 后需重跑 `npm run package`。
7. **推断必须带依据、必须可失败。** `server/core/infer.ts` 替人写出任务/进度/下一步，
   因此：每条推断都要说得出证据（分支名、提交标题、diff 新增行、TODO 原文、基线里的测试名），
   读不到证据就明说读不到，**绝不允许编一条看起来合理的进度**；
   推断结果不得混进观测或声明两类内容，写进简报时必须带"推断"标记。
   便签 `.acb/NEXT.md` 属于 Agent 声明（`sessionId: "agent_note"`），不是人的声明，也不是事实。
8. **交接不能靠人传话。** `server/core/bridge.ts` 写进项目的两样东西就是为此存在的：
   `AGENTS.md` 里那段接入块（固定文案，只写一次；已存在则末尾追加，人的原文一字不动）
   与 `.acb/LATEST.md` 指针（每次封存/重写，指向当前交接并带着 Agent 自己能跑的封存命令）。
   新增入口时先问"这条路径有没有人不参与也能走通"；只会"生成一段话让人去粘"的能力不算闭环。
   工具自己的脚印必须被认领：`AGENTS.md` 若只有接入块，审阅清单与简报都要标明"这不是你的改动"，
   判据是 `BRIDGE_BLOCK` 的逐行比对（`bridgeOwnsDiff` / `bridgeOwnsContent`），不是文件名匹配，
   掺了人写的句子就必须照实算作用户的改动。

## 本机环境注意（踩过）

- `npm install` 不会自动下载 Electron 运行时；缺 `node_modules/electron/dist` 时执行：
  `HTTPS_PROXY=http://127.0.0.1:7897 node node_modules/electron/install.js`（github 直连被墙）。
- 服务只绑 127.0.0.1，Host/Origin 白名单见 `server/core/local-guard.ts`；开发模式 vite :5173 需
  `ACB_ALLOWED_ORIGINS`，`开发模式.cmd` 已内置。
- 打包产物 `release/ACB-win64/` 与 `dist*`、`node_modules` 都在 `.gitignore` 里；删了可重建。
- 交接包落在**被交接项目**的 `<project>/.acb/store/handoffs/`，不在本仓库里；清理前别按目录名猜归属。
