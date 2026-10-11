// ACB CLI：register / overview / brief / preview / create / restore
// 与桌面界面走同一批核心 Module，不做第二套规则。
import path from "node:path";
import os from "node:os";
import { listProjects, loadHandoffRecords, getHandoffRecord } from "./core/store.js";
import { createHandoff } from "./core/workflow.js";
import { previewResume, performResume } from "./core/resume-flow.js";
import { buildPreview } from "./core/preview.js";
import { registerProjectDir } from "./core/registry.js";
import { takeover } from "./core/takeover.js";
import type { BridgeOutcome } from "./core/bridge.js";
import type { ProjectConfig, ConflictPolicy } from "../shared/types.js";

const [, , cmd, ...args] = process.argv;

async function pickProject(idOrPath?: string): Promise<ProjectConfig> {
  const all = await listProjects();
  if (idOrPath) {
    const p = all.find((x) => x.projectId === idOrPath || path.resolve(x.path) === path.resolve(idOrPath));
    if (p) return p;
    // 没注册过的目录路径直接登记：走 registry 那一份判定（顺带装上项目侧接入块），
    // 不在 CLI 里自己拼一个 projectId —— 两处各造一次 id 迟早分叉。
    try {
      const { config } = await registerProjectDir(idOrPath);
      console.error(`（${config.name} 之前没注册过，已按目录登记为 ${config.projectId}）`);
      return config;
    } catch (e) {
      throw new Error(`项目未找到：${idOrPath}。出路：acb register <包含代码的项目根目录>（${e instanceof Error ? e.message : String(e)}）`);
    }
  }
  const cwd = path.resolve(process.cwd());
  return all.find((x) => path.resolve(x.path) === cwd) ?? all[all.length - 1]
    ?? (() => { throw new Error("没有已注册项目。出路：acb register <path>"); })();
}

const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

/** 接入块/指针这一步的人类可读结论：写了几行、追加还是原样、为什么没写 */
function bridgeLine(b: BridgeOutcome): string {
  const where = `${b.agentsFile} · ${b.latestFile}`;
  const latestZh = { created: "已写入", updated: "已重写", unchanged: "内容没变" }[b.latest];
  if (b.agents === "skipped") return `  接入：没有改 AGENTS.md —— ${b.reason ?? "按约定跳过"}（指针页${latestZh}）`;
  const verb = b.agents === "created" ? `新写入 ${b.blockLines} 行接入块`
    : b.agents === "appended" ? `在原有内容后追加 ${b.blockLines} 行接入块`
    : b.agents === "updated" ? "更新了接入块" : "接入块已在项目里，未改动";
  return `  接入：${verb} · 指针页${latestZh} → ${where}`;
}

async function main() {
  switch (cmd) {
    case "register": {
      // 走 registry 那一条路径（与界面「选择文件夹」、Agent 工具 acb.project_register 同源）：
      // 裸仓库判定、重复注册复用同一个 projectId、以及项目侧接入块，都只有一份实现。
      const { config, alreadyRegistered, bridge } = await registerProjectDir(args[0] ?? ".", args[1]);
      console.log(`已注册 ${config.name} → ${config.projectId}（${config.path}）${alreadyRegistered ? " · 已存在，复用同一个 id" : ""}`);
      console.log(bridgeLine(bridge));
      break;
    }
    case "overview": {
      const p = await pickProject(args[0]);
      const records = await loadHandoffRecords(p.path);
      console.log(`项目 ${p.name}（${p.projectId}）· 检查命令 ${p.checks.length} 条 · 本机封存交接 ${records.length} 个`);
      for (const r of records.slice(0, 8)) {
        console.log(`  ${r.handoffId} · ${r.state.taskName} · ${r.state.changes.length} 文件 · 封存于 ${r.sealedAt}`);
      }
      break;
    }
    /** 把最新（或指定）交接的简报路径打出来：这就是要交给下一个 Agent 的唯一一份文件 */
    case "brief": {
      const p = await pickProject(args[0]);
      const hid = args[1];
      const rec = hid
        ? await getHandoffRecord(p.path, hid)
        : (await loadHandoffRecords(p.path))[0];
      if (!rec) throw new Error(`项目「${p.name}」本机还没有封存交接。出路：acb create ${p.projectId}（任务名可以留空，ACB 会从分支名/提交标题/diff 推断）`);
      console.log(path.join(rec.packageDir, "HANDOFF.md"));
      break;
    }
    case "preview": {
      const p = await pickProject(args[0]);
      const v = await buildPreview(p);
      console.log(`基线 ${v.baseline.branch ?? "(无)"} @ ${v.baseline.commit?.slice(0, 7) ?? "无"} · 纳入 ${v.included.length} 项 ${v.includedBytes} B · ${v.bundleNote}`);
      for (const f of v.included) console.log(`  + ${f.path} [${f.status}${f.staged ? "/暂存" : ""}] ${f.kind} ${f.bytes}B`);
      for (const e of v.excluded) console.log(`  - ${e.path} 排除：${e.reason}`);
      for (const a of v.alerts) console.log(`  ! [${a.level}] ${a.title} — ${a.detail}\n      出路：${a.action}`);
      if (v.alerts.some((a) => a.level === "阻塞")) process.exitCode = 1;
      break;
    }
    case "create": {
      const p = await pickProject(args[0]);
      // 任务名可以不给：给了就用人的，没给就用 ACB 从分支名/提交标题/diff 推断的那句。
      // 命令行参数在这台机器的 shell 里会被转坏中文，所以"不写"才是这条路的默认用法。
      const taskName = args[1];
      const r = await createHandoff(p, { taskName, claimText: args[2], runChecks: flag("checks") === undefined ? false : true });
      console.log(`已封存 ${r.record.handoffId}（快照 ${r.snapshot.id}，${r.snapshot.files} 文件 / ${r.snapshot.bytes} B，清单 ${r.record.manifest.entries.length} 条）`);
      console.log(`任务名：${r.record.state.taskName}（来源：${r.record.state.inferred?.taskSource ?? "人写的"}）`);
      console.log(`接手简报：${path.join(r.record.packageDir, "HANDOFF.md")}`);
      console.log(bridgeLine(r.bridge));
      for (const v of r.verifications) console.log(`  检查 ${v.name}: ${v.result}`);
      for (const w of r.warnings) console.log(`  提示：${w}`);
      break;
    }
    /**
     * 接手用的一条命令：给"能跑命令的 Agent"最省 token 的那条路（没有 MCP 的 schema 开销）。
     * 输出是紧凑 JSON，末尾直接给出这次花了多少 token、简报原文要多少 —— 省不省不用我说。
     */
    case "takeover": {
      const level = (flag("level") ?? "summary") as "summary" | "files" | "brief";
      const at = args[0] && !args[0].startsWith("--") ? args[0] : process.cwd();
      const out = await takeover({ at, level });
      const text = JSON.stringify(out);
      process.stdout.write(text + "\n");
      const cost = out.cost as { tokens?: number; briefTokens?: number } | undefined;
      if (level === "brief") console.error(`[acb] 简报全文 ${out.tokens} tokens（估算）：这是"丢文件"那条路的成本`);
      else console.error(`[acb] 本次摘要 ${cost?.tokens} tokens vs 简报原文 ${cost?.briefTokens} tokens（估算，同一把尺子）`);
      break;
    }
    case "restore": {
      const p = await pickProject(args[0]);
      const handoffId = args[1];
      const targetDir = path.resolve(args[2] ?? path.join(os.tmpdir(), "acb-restore"));
      const conflictArg = flag("conflict") as string | undefined;
      // `--conflict preview` 不是恢复策略而是"只看不写"的另一种模式，所以不能塞进 ConflictPolicy
      // （那是落盘分支，编译器按联合类型判等，塞进去只会得到一个永远不成立的比较）。
      if (conflictArg === "preview") {
        const v = await previewResume({ projectId: p.projectId, handoffId, targetDir });
        console.log(`预览：完整性 ${v.verifiedCount}/${v.entryCount} · 将写入 ${v.willWrite} 项 · 撞车 ${v.conflicts.length} 项 → ${targetDir}`);
        for (const a of v.alerts) console.log(`  ! [${a.level}] ${a.title} — ${a.action}`);
        break;
      }
      const onConflict = (conflictArg as ConflictPolicy | undefined) ?? "abort";
      const { report, bridge } = await performResume({ projectId: p.projectId, handoffId, targetDir, onConflict });
      console.log(`${report.verdict} · 指纹一致 ${report.digestMatch} · 写入 ${report.restoredCount}/${report.entryCount} → ${targetDir}`);
      if (bridge) console.log(bridgeLine(bridge));
      for (const s of report.steps) console.log(`  [${s.ok ? "x" : " "}] ${s.title} — ${s.detail}`);
      for (const g of report.gaps) console.log(`  [${g.kind}${g.blocking ? "·阻塞" : ""}] ${g.title} — ${g.detail}`);
      if (report.verdict === "恢复被阻塞") process.exitCode = 1;
      break;
    }
    default:
      console.log(`ACB — Agent Context Bridge CLI（本机项目交接）

  acb register <path> [name]              注册项目（必须是 Git 工作区）并装上项目侧接入块
  acb overview [project]                  项目与本机封存的交接
  acb brief [project] [id]                打印接手简报 HANDOFF.md 的路径（交给下一个 Agent 就读它）
  acb takeover [目录] [--level summary|files|brief]
                                          Agent 接手用的紧凑摘要（默认 summary，比读简报原文省 token）
                                          输出末尾那行就是两边实测 token 对比
  acb preview [project]                   打包前审阅清单（纳入/排除及原因、凭据告警）
  acb create [project] [task] [claim]     封存一次交接；task 留空 = 用 ACB 从分支名/提交标题/diff 推断的那句
  acb restore [project] [id] [dir] [--conflict abort|skip|overwrite]
                                          把某次封存还原到一个目录；--conflict preview 只看差异不写盘
  --checks                                create 时执行项目里配置的检查（失败也如实封存）

  交接包落在 <project>/.acb/store/handoffs/<id>/；退出码非零 = 有阻塞项，可直接用于脚本判断。
  每次 register/create/restore 都会重写 <项目>/.acb/LATEST.md（交接指针），并在 AGENTS.md 里维护一段接入块：
  项目里的 Agent 由此自己读到该接手什么、自己封存该做什么，不需要任何人粘贴一段提示词。
  不想让 ACB 改 AGENTS.md：删掉那段，再建一个空文件 <项目>/.acb/NO-BRIDGE。
`);
  }
}

main().catch((e) => {
  console.error("[acb] 错误:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
