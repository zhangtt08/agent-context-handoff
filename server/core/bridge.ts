// 项目侧接入（bridge）：把"交接"变成这个项目自己的一条约定，而不是人转手粘贴的一段话。
//
// 两个产物，分工是刻意的：
//   <dir>/AGENTS.md      —— 固定几行的接入块，内容不含任何一次交接的可变量，所以只写一次；
//                           每次封存都重写它的话，项目里就会平白多出一处永远在变的 diff。
//   <dir>/.acb/LATEST.md —— 每次封存/还原都重写，指向当前那一份简报，并带上"下一个 Agent
//                           自己封存"的可执行命令。它在 .acb/ 里，按纳入策略本来就不进包。
//
// 为什么必须有这一层：只有文字的话，人和工具没区别 —— 得有人把话带到。接入块写进项目之后，
// 被换掉的那个 Agent 和接手的那个 Agent 都不等人转述：它们打开这个目录就读到了。
//
// 停用：<dir>/.acb/NO-BRIDGE（空文件即可）存在时，AGENTS.md 一个字节都不碰，
// 并把原因回给调用方；界面与命令行都会说这句，不会静默不写。
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { exists } from "./gitutil.js";
import type { BridgeOutcome } from "../../shared/types.js";

// 类型定义只有 shared/types.ts 一份：界面看到的和这里写出去的是同一个形状，不会各自漂移
export type { BridgeOutcome };

const BEGIN = "<!-- ACB:BEGIN -->";
const END = "<!-- ACB:END -->";
export const BRIDGE_OFF_FILE = ".acb/NO-BRIDGE";

/** 接入块：只有指针，没有可变量。改这里等于改所有已接入项目的 AGENTS.md，动手前想清楚。 */
export const BRIDGE_BLOCK: string[] = [
  BEGIN,
  "## ACB 交接：这个项目里可能有做到一半、由别的 Agent 封存的活",
  "- 接手前**先只读** `.acb/LATEST.md`：它会把你带到当前那一份交接简报。不要重读聊天记录，也不要先整仓扫描。",
  "- 你做到一半要被换掉（额度、上下文、订阅切换）时：**当场自己封存**，别等人来复制粘贴一段话给你。",
  "  `.acb/LATEST.md` 里有可直接执行的封存命令；能调 ACB 的 Agent 工具就用 `acb.handoff_create`（要 `confirm:true`，`taskName` 可以留空，ACB 会从分支名、提交标题和 diff 推断）。",
  "- 封存带走的是**代码现场**（暂存区与工作区两版、删除、改名、符号链接、空目录，逐文件 SHA-256），不是文字描述；文字只是它的一小部分。",
  `（这一段由 ACB 自动维护。想停用：删掉标记之间的全部内容，再在项目根建一个空文件 \`${BRIDGE_OFF_FILE}\`，ACB 之后就不会再写这个文件。）`,
  END,
];

const BRIDGE_LINE_SET = new Set(BRIDGE_BLOCK.map(norm));
function norm(s: string): string { return s.trim(); }

/** 这些增删行是否**全部**是 ACB 接入块自己的行（用来把工具的脚印从"你的改动"里分出去） */
export function bridgeOwnsDiff(added: string[], removed: string[]): boolean {
  const lines = [...added, ...removed].map(norm).filter((l) => l !== "");
  if (!lines.length) return false;
  return lines.every((l) => BRIDGE_LINE_SET.has(l));
}

/** 未跟踪文件没有 diff，只能整份比：内容正好等于接入块时才算 ACB 自己写的 */
export function bridgeOwnsContent(text: string): boolean {
  const body = text.replace(/^\uFEFF/, "");
  const lines = body.split("\n").map(norm).filter((l) => l !== "");
  if (!lines.length) return false;
  return lines.every((l) => BRIDGE_LINE_SET.has(l));
}

export function isBridgePath(rel: string): boolean {
  return /^(AGENTS|CLAUDE)\.md$/i.test(rel.split("/").pop() ?? "") && !rel.includes("/");
}

export interface LatestPointer {
  projectId: string;
  projectName: string;
  /** 这次是封存、还原后的指针，还是刚注册、还没有任何交接 */
  origin: "封存" | "还原" | "注册";
  handoffId?: string;
  taskName?: string;
  sealedAt?: string;
  /** 接手方要读的入口文件（相对 dir 的写法，指针里同时给绝对路径） */
  entryRel?: string;
  integrity?: { entries: number; verified?: number };
  history?: { handoffId: string; taskName: string; sealedAt: string }[];
  /** 还原出来的目录：这两份文件在目标目录里 */
  reportRel?: string;
}

/**
 * 查找"这台机器上可直接跑的 ACB 命令行入口"。
 *
 * 根目录的顺序是刻意的：**先看把进程启动起来的那个文件在哪个目录**，再看模块自身目录，最后才看 cwd。
 * 只按 cwd 找的话，指针里写出来的命令会跟着"谁在哪个目录里敲了这条命令"变：
 * 从源码仓库里跑一次打包用的 cli.cjs，项目指针就会指着 dist-server 那份产物，
 * 而这台机器上换成双击 exe 接手时那条路径根本不存在 —— 指针必须是"这次真正封存用的那个入口"。
 */
export function cliCandidateRoots(): string[] {
  const out: string[] = [];
  const push = (p: string | null | undefined) => { if (p && !out.includes(p)) out.push(p); };
  // 1. 启动这个进程的那个文件所在目录（打包态：resources\app；源码态：<仓库>\server 或 <仓库>\tests）
  push(process.argv[1] ? path.dirname(path.resolve(process.argv[1])) : null);
  // 2. 模块自身所在目录（CommonJS 产物有 __dirname；tsx/ESM 源码里没有，typeof 不抛）
  push(typeof __dirname !== "undefined" ? path.resolve(__dirname) : null);
  // 3. 当前工作目录（npm run cli 时的落点）
  push(path.resolve(process.cwd()));
  return out;
}

const CLI_CANDIDATES: [string, string, string][] = [
  ["cli.cjs", "node", "发行包内的命令行入口"],
  ["cli.js", "node", "编译产物入口"],
  [path.join("server", "cli.js"), "node", "编译产物入口"],
  [path.join("server", "cli.ts"), "npx tsx", "开发态源码入口"],
];

/** roots 可以显式传（测试要钉住查找顺序）；不传就是真实运行时的根目录清单 */
export function cliInvocation(roots: string[] = cliCandidateRoots()): { run: string; via: string } | null {
  for (const root of roots) {
    for (const [rel, runner, via] of CLI_CANDIDATES) {
      const abs = path.join(root, rel);
      if (existsSync(abs)) return { run: `${runner} "${abs}"`, via };
    }
  }
  return null;
}

function sealCommand(projectId: string): { cmd: string; via: string } | null {
  const cli = cliInvocation();
  return cli ? { cmd: `${cli.run} create ${projectId}`, via: cli.via } : null;
}

function fmtWhen(iso: string): string {
  const d = new Date(iso).getTime();
  if (!Number.isFinite(d)) return iso;
  const diff = (Date.now() - d) / 1000;
  if (diff >= 0 && diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  return iso;
}

export function renderLatest(t: LatestPointer, dir: string): string {
  const L: string[] = [];
  const cli = cliInvocation();
  L.push("# 最新交接 · 指针（ACB 每次封存或还原都会重写这一页）", "");
  L.push(`- 项目：${t.projectName}（\`${t.projectId}\`） · 这一页的来源：${t.origin}`);
  if (t.handoffId) {
    L.push(`- 当前交接：\`${t.handoffId}\`${t.taskName ? ` · 任务「${t.taskName}」` : ""}${t.sealedAt ? ` · ${fmtWhen(t.sealedAt)}封存` : ""}`);
  }
  if (t.entryRel) {
    L.push("", "## 接手请只读这些", "");
    L.push(`- \`${t.entryRel}\`（本目录内：${path.join(dir, t.entryRel)}）`);
    if (t.reportRel) L.push(`- \`${t.reportRel}\`（逐项对账：一致 / 变更 / 只在包里 / 只在目标）`);
    if (t.integrity) {
      L.push(t.integrity.verified === undefined
        ? `- 包清单：${t.integrity.entries} 条，每条一个 SHA-256（\`manifest.json\`）；这是封存时算出来的，接手前实测复核用 acb.handoff_integrity。`
        : `- 完整性：清单 ${t.integrity.entries} 条，本次实测逐条 SHA-256 通过 ${t.integrity.verified} 条。`);
    }
    L.push("- 需要看代码时只打开入口文件「改动清单」里列出的那些；包内还有 `acb-state/project-state.json` 与 `manifest.json`（机器可读，人不必读）。");
    L.push(cli
      ? `- 想少花 token：别读整份简报，跑一次 \`${cli.run} takeover "${dir}"\`（或 MCP 工具 \`acb.handoff_takeover\`，input {"at":"本目录"}）—— 回的是摘要，返回里的 cost 就是"这次 vs 简报原文"两个实测数。`
      : "- 想少花 token：用 MCP 工具 `acb.handoff_takeover`（input {\"at\":\"本目录\"}）拿摘要，不必读整份简报。");
  }

  L.push("", "## 你做到一半要被换掉时：自己封存，不要等人转述", "");
  if (t.origin === "还原") {
    // 还原出来的目录还没有自己的项目 id：拿源项目 id 封存会打到源工作区，那是另一个现场
    L.push("- 这个目录是从别处还原出来的工作区，还没有自己的 ACB 项目 id。先注册它（一次就够）：");
    L.push("  ```");
    L.push(`  ${cli ? `${cli.run} register "${dir}"` : `<ACB 命令行入口> register "${dir}"`}`);
    L.push("  ```");
    L.push("  它会打印一个新的 `prj_…`；接着就跑（任务名同样可以留空）：");
    L.push("  ```");
    L.push(`  ${cli ? `${cli.run}` : "<ACB 命令行入口>"} create <新的 prj_…>`);
    L.push("  ```");
    L.push("- 不想走命令行：双击 `ACB.exe` → 「换项目 / 管理」里选这个目录注册，再点「就这样，生成交接」。");
    L.push("  注册这一条的参数里有目录路径：路径含中文时在这台机器的 shell 里会被转坏，那种情况用界面点一下（「换项目 / 管理」→ 选择文件夹）。");
  } else {
    const cmd = sealCommand(t.projectId);
    if (cmd) {
      L.push(`- 本机命令（${cmd.via}，需要 Node）：`);
      L.push("  ```");
      L.push(`  ${cmd.cmd}`);
      L.push("  ```");
      L.push("  任务名留空 = 由 ACB 从分支名、提交标题和 diff 推断，你不用在这里现编一句话。");
      L.push("  这条命令的参数全是 ASCII：中文参数在这台机器的 shell 里会被转坏，所以别在这里现写中文任务名。");
    } else {
      L.push("- 本机没找到命令行入口，就用界面：双击 `ACB.exe` → 「就这样，生成交接」。");
    }
    L.push(`- 能调用 ACB 的 Agent 工具（MCP）就用 \`acb.handoff_create\`，input 形如 \`{"projectId":"${t.projectId}","confirm":true}\`。`);
  }
  if (t.history?.length) {
    L.push("", `## 本机已封存（最近 ${t.history.length} 条）`, "");
    for (const h of t.history) L.push(`- \`${h.handoffId}\` ${h.taskName} · ${fmtWhen(h.sealedAt)}`);
  }
  L.push("", "---", "", `这一页由 ACB 生成，每次封存都会重写。不想让 ACB 改项目里的 AGENTS.md：删掉那段接入块，再建一个空文件 \`${BRIDGE_OFF_FILE}\`。`);
  return L.join("\n") + "\n";
}

/** 结果对象的初始形态；installBridge 与 tryInstallBridge 共用同一个对象，异常时也能保住已发生的步骤 */
export function newBridgeOutcome(dir: string): BridgeOutcome {
  return {
    agentsFile: path.join(dir, "AGENTS.md"),
    latestFile: path.join(dir, ".acb", "LATEST.md"),
    agents: "unchanged",
    latest: "unchanged",
    blockLines: BRIDGE_BLOCK.length,
  };
}

/**
 * 写指针 + 装接入块。任何一步失败都只影响这一步，封存本身已经完成 —— 交接包不会因为
 * 项目根不可写就作废，所以调用方用 tryInstallBridge 拿结果，而不是等这里抛异常。
 */
export async function installBridge(dir: string, t: LatestPointer, progress?: BridgeOutcome): Promise<BridgeOutcome> {
  const outcome = progress ?? newBridgeOutcome(dir);
  const { agentsFile, latestFile } = outcome;

  const md = renderLatest(t, dir);
  const before = await fs.readFile(latestFile, "utf8").catch(() => null);
  if (before !== md) {
    await fs.mkdir(path.dirname(latestFile), { recursive: true });
    await fs.writeFile(latestFile, md, "utf8");
    outcome.latest = before === null ? "created" : "updated";
  }

  if (await exists(path.join(dir, ".acb", "NO-BRIDGE"))) {
    outcome.agents = "skipped";
    outcome.reason = `项目里有空文件 \`${BRIDGE_OFF_FILE}\`，按停用约定没有动 AGENTS.md`;
    return outcome;
  }

  const cur = await fs.readFile(agentsFile, "utf8").catch(() => null);
  if (cur === null) {
    await fs.writeFile(agentsFile, BRIDGE_BLOCK.join("\n") + "\n", "utf8");
    outcome.agents = "created";
    return outcome;
  }

  const eol = cur.includes("\r\n") ? "\r\n" : "\n";
  const block = BRIDGE_BLOCK.join(eol);
  const b = cur.indexOf(BEGIN);
  const e = cur.indexOf(END);
  if (b >= 0 && e < b) {
    outcome.agents = "skipped";
    outcome.reason = "AGENTS.md 里的 ACB 标记不完整（有开始标记、没有结束标记），没有自动改这个文件；请把半截标记删掉再接";
    return outcome;
  }
  if (b < 0) {
    const next = cur.replace(/\s+$/, "") + eol + eol + block + eol;
    await fs.writeFile(agentsFile, next, "utf8");
    outcome.agents = "appended";
    return outcome;
  }
  const after = cur.slice(e + END.length);
  const next = cur.slice(0, b) + block + after;
  if (next === cur) return outcome;
  await fs.writeFile(agentsFile, next, "utf8");
  outcome.agents = "updated";
  return outcome;
}

/**
 * 接入这一步失败不能让主流程失败：注册不该因为项目根不可写而报错，封存不该因为指针没写上
 * 而作废（包已经封好了）。所以这里把异常收成一个如实的结果，由调用方原样打给用户看 ——
 * 已经写成功的那一步不会被说成"没写"，因为 outcome 对象是同一个。
 */
export async function tryInstallBridge(dir: string, t: LatestPointer, what: string): Promise<BridgeOutcome> {
  const progress = newBridgeOutcome(dir);
  try {
    return await installBridge(dir, t, progress);
  } catch (e) {
    progress.reason = `${what}要写接入块/指针时失败了：${e instanceof Error ? e.message : String(e)}。`
      + `${what}本身已经完成；下一个 Agent 得由人领到入口文件。`;
    return progress;
  }
}
