// Infer Module：从 Git 与 diff 里**自动推断**交接内容，让人不必手写任务与现状。
//
// 为什么要这一层：如果交接要求人手写"任务 / 做到哪 / 下一步"，那它和"自己另开一个 Agent 打一段
// 提示词"没有区别。ACB 的价值在于这些内容来自证据 —— 分支名、最近提交、diff 里真实新增的符号、
// 上一个 Agent 留在代码里的 TODO、改了源码却没改的测试。
//
// 三条纪律：
//  1. 每条推断都带来源，简报里如实标"推断"，不冒充事实，也不冒充 Agent 的声明；
//  2. 只读必要字节（单文件上限 + 总上限），大仓库不能被"看一眼"拖死；
//  3. 拿不到证据就明说拿不到，绝不编一句看起来像那么回事的进度。
import { promises as fs } from "node:fs";
import path from "node:path";
import { git, gitStatus, isExcluded } from "./gitutil.js";
import { bridgeOwnsContent, bridgeOwnsDiff, isBridgePath } from "./bridge.js";
import type { GitStatus } from "./gitutil.js";

/** 单个文件最多读这么多字节来找线索（再大的文件只看头部） */
const FILE_READ_CAP = 64 * 1024;
/** 一次推断最多读多少个未跟踪文件 */
const UNTRACKED_READ_CAP = 120;
/** 每条清单最多列几项，剩下的说"等 N 项" */
const LIST_CAP = 8;

const TODO_RE = /\b(TODO|FIXME|XXX|HACK|待办|未完成|待实现)\b[:：]?\s*(.+)/i;
const SYMBOL_RES: [RegExp, string][] = [
  [/^\s*(?:export\s+)?(?:default\s+)?function\s+(\w+)/, "函数"],
  [/^\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/, "类"],
  [/^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=/, "常量"],
  [/^\s*(?:export\s+)?(?:async\s+)?def\s+(\w+)/, "函数"],
  [/^\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/, "函数"],
  [/^\s*(?:export\s+)?(?:interface|type|enum)\s+(\w+)/, "类型"],
  [/^\s*(?:func\s+\(\w+\s+\*?\w+\)\s+)?func\s+(\w+)/, "函数"],
];
/** 改了源码但没动的同名测试文件候选形态（覆盖 src 与 tests/ 镜像两类常见布局） */
const TEST_PATTERNS = (base: string, dir: string, ext: string) => {
  const leaf = dir ? `${dir}/` : "";
  const bare = ext; // 形如 ".ts"
  const noDot = ext.replace(/^\./, "");
  return [
    `${leaf}${base}.test${bare}`, `${leaf}${base}.spec${bare}`, `${leaf}${base}_test${bare}`, `${leaf}test_${base}${bare}`,
    `tests/${leaf}${base}.test${bare}`, `tests/${leaf}${base}.spec${bare}`,
    `tests/${base}.test${bare}`, `tests/${base}.spec${bare}`,
    `test/${base}.test${bare}`, `test/${base}.spec${bare}`, `__tests__/${base}.test${bare}`, `__tests__/${base}.spec${bare}`,
    `test/${leaf}${base}.test${bare}`, `test/${leaf}${base}.spec${bare}`, `test/${leaf}${base}${bare}`,
    `__tests__/${leaf}${base}.test${bare}`, `__tests__/${base}.spec${bare}`,
    `tests/${base}.${noDot}.test${bare}`, `tests/${base}_test${bare}`, `tests/${base}.spec${bare}`,
    `src/${base}.test${bare}`, `spec/${leaf}${base}_spec${bare}`,
  ];
};

export interface Inferred {
  /** 一句话任务（推断自分支名与最近提交） */
  taskName: string;
  taskSource: string;
  /** "做到哪了"的逐条事实（来自 diff） */
  progress: string[];
  /** "建议下一步"的逐条线索（TODO / 未同步测试 / 失败检查由调用方补） */
  nextSteps: string[];
  /** 上一个 Agent 留在 .acb/NEXT.md 里的原文（有就优先采纳） */
  agentNote?: { path: string; text: string };
  /**
   * 这几个文件的改动只有 ACB 自己写的接入块（AGENTS.md / CLAUDE.md）。
   * 不点明的话它会伪装成"这次任务改了什么"，而它其实是工具的脚印。
   */
  acbOwnEdits: string[];
  /** 这次推断用到的证据种类，界面与简报都要如实列出 */
  sources: string[];
}

/** 分支名 → 人话：去掉常见前缀与工单号，把 -/_ 换成空格 */
function branchPhrase(branch: string): string {
  return branch
    .replace(/^(feat|feature|fix|hotfix|chore|docs|refactor|test|ci|build|perf|wip|issue|bug)[-/:]*/i, "")
    .replace(/^(\d+[-_]|#\d+)/, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface DiffFile { path: string; added: string[]; removedLines: string[]; todoHits: { line: number; text: string }[] }

/** 解析 `git diff -U0`：只取新增行与 TODO 所在行号，不保留整份内容 */
function parseDiff(out: string): Map<string, DiffFile> {
  const map = new Map<string, DiffFile>();
  let cur: DiffFile | null = null;
  let newLine = 0;
  for (const raw of out.split("\n")) {
    if (raw.startsWith("diff --git ")) { cur = null; continue; }
    if (raw.startsWith("+++ ")) {
      const p = raw.slice(4).trim();
      const rel = p.startsWith("b/") ? p.slice(2) : p;
      if (rel === "/dev/null") { cur = null; continue; }
      cur = { path: rel, added: [], removedLines: [], todoHits: [] };
      map.set(rel, cur);
      continue;
    }
    if (raw.startsWith("--- ")) continue;
    if (raw.startsWith("@@")) {
      const m = /@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      newLine = m ? Number(m[1]) : newLine;
      continue;
    }
    if (!cur) continue;
    if (raw.startsWith("+")) {
      const body = raw.slice(1);
      cur.added.push(body);
      const t = TODO_RE.exec(body);
      if (t) cur.todoHits.push({ line: newLine, text: `${t[1].toUpperCase()}: ${t[2].trim().slice(0, 160)}` });
      newLine++;
    } else if (raw.startsWith("-")) {
      cur.removedLines.push(raw.slice(1));
    }
  }
  return map;
}

function symbolsOf(lines: string[]): string[] {
  const out: string[] = [];
  for (const l of lines) {
    for (const [re, kind] of SYMBOL_RES) {
      const m = re.exec(l);
      if (m && !out.includes(`${kind} ${m[1]}`)) { out.push(`${kind} ${m[1]}`); break; }
    }
    if (out.length >= LIST_CAP) break;
  }
  return out;
}

/** 上一个 Agent 留下的便签：这是本项目里唯一"由写代码的人主动交代"的内容，优先级最高 */
export async function readAgentNote(projectPath: string): Promise<{ path: string; text: string } | undefined> {
  const p = path.join(projectPath, ".acb", "NEXT.md");
  try {
    const text = (await fs.readFile(p, "utf8")).trim();
    if (!text) return undefined;
    return { path: p, text: text.slice(0, 4000) };
  } catch {
    return undefined;
  }
}

/** 未跟踪的新文件：diff 里没有，只能自己读头部找线索 */
async function readUntracked(projectPath: string, files: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const f of files.slice(0, UNTRACKED_READ_CAP)) {
    try {
      const st = await fs.stat(path.join(projectPath, f));
      if (!st.isFile() || st.size > 2 * 1024 * 1024) continue;
      const buf = await fs.readFile(path.join(projectPath, f), "utf8");
      out.set(f, buf.slice(0, FILE_READ_CAP));
    } catch { /* 读不到就算了，不因此失败 */ }
  }
  return out;
}

export async function inferIntent(projectPath: string, st: GitStatus, baselinePaths: string[]): Promise<Inferred> {
  const sources: string[] = [];
  const entries = st.entries.filter((e) => !isExcluded(e.path) && !e.path.startsWith(".acb/"));
  const changed = new Set(entries.map((e) => e.path));

  /* 1. 任务名：分支名 + 最近提交 */
  let taskName = "";
  let taskSource = "";
  const subjects: string[] = [];
  if (st.commit) {
    try {
      const log = await git(["log", "-n", "3", "--format=%s"], { cwd: projectPath });
      subjects.push(...log.split("\n").map((s) => s.trim()).filter(Boolean));
      sources.push(`最近 ${subjects.length} 条提交标题`);
    } catch { /* 无历史 */ }
  }
  const named = st.branch && !/^(main|master|HEAD|develop|trunk)$/.test(st.branch) ? branchPhrase(st.branch) : "";
  // 提交标题优先：它通常是"这次到底在干什么"；分支名常常是个 slug，只配当兜底
  const usableSubject = subjects.find((x) => x.length >= 6 && !/^(wip|fix|update|misc|test|init|\.|临时|占位)$/i.test(x.trim()));
  const usableBranch = named.length >= 4 && !/^(tmp|temp|test|wip)$/i.test(named);
  if (usableSubject) {
    taskName = usableSubject;
    taskSource = `最近提交「${usableSubject.slice(0, 40)}」` + (usableBranch ? `（分支 ${st.branch}）` : "");
  } else if (usableBranch) {
    taskName = named;
    taskSource = `分支名 ${st.branch}`;
  }
  if (!taskName) {
    taskName = `继续处理 ${entries.length} 处未提交改动`;
    taskSource = "分支名与提交标题都给不出目标，按改动量占位";
  } else if (subjects.length && taskSource.startsWith("分支名") && subjects[0] !== taskName) {
    taskSource += `；最近提交「${subjects[0].slice(0, 40)}」`;
  }

  /* 2. 做到哪了：diff 里真实新增的符号 */
  const progress: string[] = [];
  const tracked = entries.filter((e) => e.x !== "?");
  let diffMap = new Map<string, DiffFile>();
  if (tracked.length && st.commit) {
    try {
      diffMap = parseDiff(await git(["diff", "--no-color", "-U0", "HEAD", "--", ...tracked.map((e) => e.path)], { cwd: projectPath }));
      sources.push("git diff 新增行");
    } catch { /* 路径太多或 git 拒绝，退化成只报文件名 */ }
  }
  const untrackedPaths = entries.filter((e) => e.x === "?").map((e) => e.path);
  const untrackedContent = await readUntracked(projectPath, untrackedPaths);
  if (untrackedContent.size) sources.push("新文件内容头部");

  /* 2.0 ACB 自己的脚印：AGENTS.md / CLAUDE.md 里若只有接入块那几行，就不是这次的进度。
   * 判据是逐行比对 BRIDGE_BLOCK（只有 bridge.ts 一份），不是"文件名看起来像"。 */
  const acbOwnEdits: string[] = [];
  for (const e of entries) {
    if (!isBridgePath(e.path)) continue;
    const d = diffMap.get(e.path);
    const owned = d
      ? bridgeOwnsDiff(d.added, d.removedLines)
      : bridgeOwnsContent(untrackedContent.get(e.path) ?? "");
    if (owned) acbOwnEdits.push(e.path);
  }
  const ownSet = new Set(acbOwnEdits);
  if (acbOwnEdits.length) sources.push(`${acbOwnEdits.length} 个接入块文件逐行比对`);

  const added = entries.filter((e) => e.x === "?" && !ownSet.has(e.path)).map((e) => e.path);
  const deleted = entries.filter((e) => e.y === "D" || e.x === "D").map((e) => e.path);
  const renamed = entries.filter((e) => e.oldPath).map((e) => `${e.oldPath} → ${e.path}`);
  const modified = entries.filter((e) => (e.x === "M" || e.y === "M") && !e.oldPath && !ownSet.has(e.path)).map((e) => e.path);

  const perFile = (p: string): string => {
    const d = diffMap.get(p);
    const syms = d ? symbolsOf(d.added) : symbolsOf((untrackedContent.get(p) ?? "").split("\n"));
    const bits: string[] = [];
    if (d) bits.push(`+${d.added.length}/-${d.removedLines.length}`);
    else if (untrackedContent.has(p)) bits.push("新文件");
    if (syms.length) bits.push(syms.slice(0, 4).join("、") + (syms.length > 4 ? ` 等 ${syms.length} 处` : ""));
    return bits.length ? `  - ${p}（${bits.join("，")}）` : `  - ${p}`;
  };
  const pushGroup = (title: string, list: string[]) => {
    if (!list.length) return;
    progress.push(`${title} ${list.length} 个：`);
    progress.push(...list.slice(0, LIST_CAP).map(perFile));
    if (list.length > LIST_CAP) progress.push(`  -… 另有 ${list.length - LIST_CAP} 个`);
  };
  pushGroup("修改", modified);
  pushGroup("新增", added);
  if (acbOwnEdits.length) {
    progress.push(`ACB 自己写的接入块 ${acbOwnEdits.length} 个：${acbOwnEdits.join("、")}（不是这次的任务，是工具的脚印）`);
  }
  if (deleted.length) progress.push(`删除 ${deleted.length} 个：${deleted.slice(0, LIST_CAP).join("、")}${deleted.length > LIST_CAP ? " 等" : ""}`);
  if (renamed.length) progress.push(`改名 ${renamed.length} 个：${renamed.slice(0, LIST_CAP).join("；")}${renamed.length > LIST_CAP ? " 等" : ""}`);
  if (!entries.length) progress.push("工作区没有未提交改动：这次交接的内容就是基线提交本身。");

  /* 3. 建议下一步：代码里留下的 TODO > 改了源码没改测试 > 无信号 */
  const nextSteps: string[] = [];
  const todos: string[] = [];
  for (const [p, d] of diffMap) for (const t of d.todoHits) todos.push(`${p}:${t.line} ${t.text}`);
  for (const [p, content] of untrackedContent) {
    content.split("\n").forEach((l, i) => {
      const m = TODO_RE.exec(l);
      if (m) todos.push(`${p}:${i + 1} ${m[1].toUpperCase()}: ${m[2].trim().slice(0, 160)}`);
    });
  }
  if (todos.length) {
    nextSteps.push(`代码里留着 ${todos.length} 处待办标记（这是上一个 Agent 自己写下的）：`);
    nextSteps.push(...todos.slice(0, LIST_CAP).map((t) => `  - ${t}`));
    if (todos.length > LIST_CAP) nextSteps.push(`  -… 另有 ${todos.length - LIST_CAP} 处`);
    sources.push("新增行里的 TODO/FIXME");
  }
  const allKnown = new Set([...baselinePaths, ...changed]);
  const staleTests: string[] = [];
  for (const src of [...modified, ...added]) {
    const m = /^(.*)\/([^/]+)\.(ts|tsx|js|jsx|py|go|rs|java)$/.exec(src);
    if (!m) continue;
    for (const cand of TEST_PATTERNS(m[2], m[1], "." + m[3])) {
      if (baselinePaths.includes(cand) && !changed.has(cand)) { staleTests.push(`${src} 改了，但 ${cand} 没动（推断）`); break; }
      if (allKnown.has(cand) && !changed.has(cand)) { staleTests.push(`${src} 改了，但 ${cand} 没动（推断）`); break; }
    }
  }
  if (staleTests.length) {
    nextSteps.push(`这些测试文件可能得跟着改（推断，不是事实）：`);
    nextSteps.push(...staleTests.slice(0, LIST_CAP).map((t) => `  - ${t}`));
    if (staleTests.length > LIST_CAP) nextSteps.push(`  -… 另有 ${staleTests.length - LIST_CAP} 组`);
    sources.push("源码/测试同名的启发式比对");
  }
  if (!nextSteps.length) {
    nextSteps.push(st.commit
      ? "没有可推断的下一步信号（代码里没有待办标记，也没发现改了源码没改测试）：让接手 Agent 先读改动清单，再跟我确认要做什么。"
      : "仓库还没有提交：先确认基线要不要先提交一次，再继续。");
  }

  const agentNote = await readAgentNote(projectPath);
  if (agentNote) sources.push(".acb/NEXT.md 便签");

  return { taskName, taskSource, progress, nextSteps, agentNote, acbOwnEdits, sources };
}

/** 预览与打包共用：状态里没现成的 GitStatus，就自己取一次 */
export async function inferForProject(projectPath: string, baselinePaths: string[]): Promise<Inferred> {
  return inferIntent(projectPath, await gitStatus(projectPath), baselinePaths);
}
