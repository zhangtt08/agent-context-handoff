// 端到端验收测试：脏工作区 → 审阅清单 → 封存（简报自足）→ 还原前预览 → 冲突处理
// → 异目录恢复 → 形态保真（符号链接/可执行位/空目录/非 ASCII）→ 篡改与越界拦住 → 父子谱系
// 源只有一个：本机封存存储里的交接包目录。跨电脑不在验收范围内（本产品只做本机 Agent 交接）。
import { execSync, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { addProject, loadHandoffRecords, loadResumeReports, saveResumeReport, readEndpoint } from "../server/core/store.js";
import { createHandoff } from "../server/core/workflow.js";
import { registerProjectDir } from "../server/core/registry.js";
import { cliCandidateRoots, cliInvocation } from "../server/core/bridge.js";
import { estimateTokens, takeover } from "../server/core/takeover.js";
import { performResume } from "../server/core/resume-flow.js";
import { executeAgentTool, AGENT_TOOLS } from "../server/agent/tools.js";
import { restorePackage, previewPackageResume } from "../server/core/resume.js";
import { checkEntries, buildManifest } from "../server/core/package.js";
import { buildPreview, pathFidelityAlerts } from "../server/core/preview.js";
import {
  isGitRepo, isSafeRelPath, caseCollisions, DEFAULT_EXCLUDES, EXCLUSION_REASONS,
  unquoteGitPath, windowsNameIssues,
} from "../server/core/gitutil.js";
import type { ProjectConfig } from "../shared/types.js";
import {
  isLoopbackAddress, resolveBindHost, assertLoopbackOrigins, hostHeaderAllowed, originAllowed,
} from "../server/core/local-guard.js";

const T = path.join(os.tmpdir(), "acb-e2e-" + Date.now());
let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.error(`FAIL  ${name} ${extra}`); }
}
const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, stdio: "pipe" });

/**
 * 真起一次 MCP stdio 桥（initialize → tools/list → tools/call）。
 * 接口这一层光测核心函数不够：工具表按不按 ACB_MCP_TOOLS 收窄、调用回的是不是紧凑 JSON，
 * 都只活在这个桥里 —— 而 token 成本恰好就记在这两处。
 */
async function mcpProbe(port: number, at: string, only: string[]): Promise<{
  toolNames: string[]; callText: string; listChars: number;
}> {
  const root = process.cwd();
  const child = spawn("node", [path.join(root, "agent", "mcp-server.mjs")], {
    cwd: root,
    env: { ...process.env, AGENT_BASE_URL: `http://127.0.0.1:${port}`, ...(only.length ? { ACB_MCP_TOOLS: only.join(",") } : {}) },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const pending = new Map<number, (v: { result?: unknown; error?: unknown }) => void>();
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buf += chunk;
    let i = buf.indexOf("\n");
    while (i >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      i = buf.indexOf("\n");
      if (!line) continue;
      let msg: { id?: number; result?: unknown; error?: unknown };
      try { msg = JSON.parse(line); } catch { continue; }
      if (typeof msg.id === "number") { pending.get(msg.id)?.(msg); pending.delete(msg.id); }
    }
  });
  let seq = 0;
  const rpc = (method: string, params?: unknown) => new Promise<{ result?: unknown }>((res, rej) => {
    const id = ++seq;
    const timer = setTimeout(() => rej(new Error(`MCP ${method} 超时`)), 25_000);
    pending.set(id, (v) => { clearTimeout(timer); res(v as { result?: unknown }); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  try {
    await rpc("initialize", { protocolVersion: "2.2.0", capabilities: {}, clientInfo: { name: "acb-e2e", version: "0" } });
    const list = await rpc("tools/list") as { result?: { tools?: { name: string }[] } };
    const names = (list.result?.tools ?? []).map((t) => t.name);
    const call = await rpc("tools/call", { name: "acb.handoff_takeover", arguments: { at } }) as
      { result?: { content?: { text?: string }[] } };
    return { toolNames: names, callText: call.result?.content?.[0]?.text ?? "", listChars: JSON.stringify(list.result?.tools ?? []).length };
  } finally {
    child.kill();
  }
}
const sha256FileLocal = async (p: string) => crypto.createHash("sha256").update(await fs.readFile(p)).digest("hex");
/** 系统临时目录里 ACB 检查用过的物化目录名（只读列举，用于"用完即清"断言） */
const checkDirs = async (): Promise<string[]> => {
  try { return (await fs.readdir(os.tmpdir())).filter((f) => f.startsWith("acb-check-")); }
  catch { return []; }
};

async function main() {
  console.log("E2E 测试目录:", T);
  await fs.mkdir(T, { recursive: true });
  process.env.ACB_HOME = path.join(T, "acb-home"); // 注册表/报告隔离，不污染 ~/.acb

  // ========== 1. 造一个脏工作区 ==========
  const repo = path.join(T, "repoA");
  await fs.mkdir(path.join(repo, "src"), { recursive: true });
  sh("git init -q && git config user.email t@t && git config user.name t", repo);
  await fs.writeFile(path.join(repo, "README.md"), "# demo\n");
  await fs.writeFile(path.join(repo, "src", "a.ts"), "export const a = 1;\n");
  await fs.writeFile(path.join(repo, "obsolete.txt"), "old\n");
  sh("git add -A && git commit -qm init", repo);
  // 已暂存修改
  await fs.writeFile(path.join(repo, "src", "a.ts"), "export const a = 2;\n");
  await fs.writeFile(path.join(repo, "src", "b.ts"), "export const b = 1;\n");
  sh("git add src/a.ts src/b.ts", repo);
  // 同文件未暂存修改（工作区版本 ≠ 暂存版本）
  await fs.writeFile(path.join(repo, "src", "a.ts"), "export const a = 3;\n");
  // 新文件（未跟踪）
  await fs.writeFile(path.join(repo, "tests.ts"), "it(\"x\", () => {});\n");
  // 已暂存删除（文件已提交，暂存其删除）
  sh("git rm -q --cached obsolete.txt", repo);
  await fs.rm(path.join(repo, "obsolete.txt"), { force: true });
  check("仓库就绪（含暂存/未暂存/新文件/删除）", await isGitRepo(repo));

  // ========== 2. 注册 + 创建交接 ==========
  const cfg: ProjectConfig = {
    projectId: "prj_e2e01", name: "e2e-repo", path: repo,
    checks: [
      { name: "检查通过项", cmd: `node -e "console.log(\\"ok\\")"` },
      { name: "检查失败项", cmd: `node -e "process.exit(1)"` },
    ],
  };
  await addProject(cfg);
  const created = await createHandoff(cfg, {
    taskName: "修复登录超时",
    claimText: "超时参数已从 3s 调整为 8s",
    claimEvidence: "检查通过项",
    nextStep: "接手后先在本机复跑失败检查",
    runChecks: true,
  });
  const rec = created.record;
  check("创建交接成功", rec.handoffId.startsWith("hnd_"));
  check("快照指纹存在", rec.state.sourceDigest.startsWith("src_sha256:"));
  check("验证记录 2 条（1 通过 1 失败）", rec.state.verifications.length === 2
    && rec.state.verifications.filter((v) => v.result === "通过").length === 1
    && rec.state.verifications.filter((v) => v.result === "失败").length === 1);
  check("纳入范围含新增/修改/删除", rec.state.changes.some((c) => c.status === "added")
    && rec.state.changes.some((c) => c.status === "modified")
    && rec.state.changes.some((c) => c.status === "deleted"));
  check("同文件暂存材料独立存在（a.ts）", rec.state.changes.find((c) => c.path === "src/a.ts")?.staged === true);
  check("state 校验通过（seal 前已校验）", rec.state.protocolVersion === "0.1");

  // 接手简报必须自足：下一个 Agent 只读这一份文件就能定位改动、知道下一步、知道复跑哪条命令
  const briefMd = await fs.readFile(path.join(rec.packageDir, "HANDOFF.md"), "utf8");
  check("简报逐条列出改动文件路径", briefMd.includes("`src/a.ts`") && briefMd.includes("`tests.ts`")
    && briefMd.includes("`obsolete.txt`"), `len=${briefMd.length}`);
  check("简报给出建议下一步原文", briefMd.includes("接手后先在本机复跑失败检查"));
  check("简报给出可复跑的检查命令", briefMd.includes("console.log") && briefMd.includes("process.exit(1)"));
  check("简报区分声明与已验证（无证据时标为待确认口径）", briefMd.includes("检查通过项")
    && !/已验证/.test(briefMd.slice(0, briefMd.indexOf("## 4"))));

  // 幂等：再次创建同一内容的新交接（不同 id），用于分叉测试跳过——改为直接测 republish

  // ========== 4. 本机还原到另一个目录（封存过程不动源端工作区） ==========
  const statusAtCreate = (sh("git status --porcelain", repo)).toString();
  const headAtCreate = (sh("git rev-parse --abbrev-ref HEAD", repo)).toString().trim();
  const restoreDir = path.join(T, "repoB");
  const { report } = await restorePackage({ packageDir: rec.packageDir, handoffId: rec.handoffId, targetDir: restoreDir, source: "本机封存" });
  await saveResumeReport(report);
  check("恢复完成", report.codeRestored === true && report.digestMatch === true);
  check("工作区内容恢复（a.ts 为未暂存版本）", (await fs.readFile(path.join(restoreDir, "src", "a.ts"), "utf8")).includes("a = 3"));
  check("新文件恢复（tests.ts）", await fs.access(path.join(restoreDir, "tests.ts")).then(() => true).catch(() => false));
  check("删除语义保持（obsolete.txt 不存在）", !(await fs.access(path.join(restoreDir, "obsolete.txt")).then(() => true).catch(() => false)));
  // 同文件暂存版与工作区版分别恢复： porcelain 首字符（index 状态）非空格、次字符（worktree）为 M
  const stB = (sh("git status --porcelain", restoreDir)).toString();
  const aLine = stB.split("\n").find((l) => l.trim().endsWith("src/a.ts")) ?? "";
  check("暂存/未暂存分离恢复", aLine.length >= 2 && aLine[0] !== " " && aLine[1] === "M", `status=${JSON.stringify(aLine)}`);
  // 基线历史由 bundle 重建：HEAD 有提交，且暂存的删除语义保持
  check("基线历史已重建（HEAD 有提交）", (sh("git log --oneline -1", restoreDir)).toString().trim().length > 0);
  check("暂存删除语义保持（obsolete.txt）", stB.includes("D  obsolete.txt"), `status=${JSON.stringify(stB)}`);
  // 基线未改动文件应原样存在于工作区且不出现在 status（README.md 仅存在于基线提交）
  check("基线未改动文件保持原样", await fs.access(path.join(restoreDir, "README.md")).then(() => true).catch(() => false)
    && !stB.includes("README.md"));
  check("失败检查如实进入报告判定", report.verdict === "需要重新验证");
  check("封存与还原都不动源端工作区", (sh("git status --porcelain", repo)).toString() === statusAtCreate,
    (sh("git status --porcelain", repo)).toString());
  check("封存与还原都不动源端分支", (sh("git rev-parse --abbrev-ref HEAD", repo)).toString().trim() === headAtCreate);
  check("还原目录自带接手简报", await fs.access(path.join(restoreDir, "ACB-HANDOFF.md")).then(() => true).catch(() => false));

  // ========== 6. 电脑 B 接续：从恢复目录创建子交接（父子关系） ==========
  const cfgB: ProjectConfig = { projectId: "prj_e2e02", name: "e2e-repo-B", path: restoreDir, checks: [] };
  await addProject(cfgB);
  await fs.writeFile(path.join(restoreDir, "src", "c.ts"), "export const c = 1;\n");
  const child = await createHandoff(cfgB, { taskName: "修复登录超时（电脑 B 接续）", parentHandoffIds: [rec.handoffId], runChecks: false });
  check("子交接保留父关系", child.record.state.parentHandoffIds.includes(rec.handoffId));

  // ========== 7. 本机存储恢复路径 ==========
  const restoreDir2 = path.join(T, "repoC");
  const { report: report2 } = await restorePackage({ packageDir: rec.packageDir, targetDir: restoreDir2, source: "本机存储" });
  await saveResumeReport(report2);
  check("本机存储恢复同样一致（交接 ID 可省，以包内为准）", report2.digestMatch === true);
  check("恢复回执带条目数与写入数", report2.entryCount !== undefined && report2.restoredCount !== undefined && (report2.restoredCount ?? 0) > 0);

  // ========== 7.2 封存包不被还原消费；材料被篡改时在写盘前就停住 ==========
  const again = await restorePackage({ packageDir: rec.packageDir, targetDir: path.join(T, "repoReconsume"), source: "本机封存（再还原一次）" });
  check("还原不消费封存包：同一条再还原一次仍然指纹一致", again.report.digestMatch === true);
  const tamperDir = path.join(T, "repoTamper");
  const tamperedFile = path.join(rec.packageDir, "payload", "work", "src", "a.ts");
  const keepBytes = await fs.readFile(tamperedFile);
  await fs.writeFile(tamperedFile, "恢复材料被改过一个字节");
  const tamperRes = await restorePackage({ packageDir: rec.packageDir, targetDir: tamperDir, source: "本机封存（已篡改）" });
  await fs.writeFile(tamperedFile, keepBytes);
  check("材料被篡改时完整性核对不通过", (tamperRes.report.verifiedCount ?? 0) < (tamperRes.report.entryCount ?? 0),
    `verified=${tamperRes.report.verifiedCount}/${tamperRes.report.entryCount}`);
  check("篡改包在写盘前就被拦住（判定恢复被阻塞）", tamperRes.report.verdict === "恢复被阻塞");
  check("被拦住时没有写出目标目录", (await fs.readdir(tamperDir).then((f) => f.length).catch(() => 0)) === 0);

  // ========== 7.3 还原前预览与冲突处理 ==========
  const conflictDir = path.join(T, "repoConflict");
  await fs.mkdir(path.join(conflictDir, "src"), { recursive: true });
  await fs.writeFile(path.join(conflictDir, "src", "a.ts"), "本机已改，不能被覆盖\n");
  const pre = await previewPackageResume({ packageDir: rec.packageDir, targetDir: conflictDir, source: "本机封存" });
  check("预览报告完整性与将写入数", pre.integrityOk === true && pre.willWrite > 0 && pre.entryCount === pre.verifiedCount);
  check("预览不写盘（目标目录里那个文件还是原样）",
    (await fs.readFile(path.join(conflictDir, "src", "a.ts"), "utf8")).includes("不能被覆盖"));
  check("预览列出撞车项", pre.conflicts.some((c) => c.path === "src/a.ts" && !c.identical));
  const abortRes = await restorePackage({ packageDir: rec.packageDir, targetDir: conflictDir, source: "本机封存", onConflict: "abort" });
  check("冲突默认停止不覆盖（判定为恢复被阻塞）", abortRes.report.verdict === "恢复被阻塞"
    && abortRes.report.gaps.some((g) => g.blocking && /冲突/.test(g.title)));
  const skipRes = await restorePackage({ packageDir: rec.packageDir, targetDir: conflictDir, source: "本机封存", onConflict: "skip" });
  check("「跳过已存在」保留本机文件", skipRes.report.digestMatch !== true
    && (await fs.readFile(path.join(conflictDir, "src", "a.ts"), "utf8")).includes("不能被覆盖"));
  const owDir = path.join(T, "repoOverwrite");
  await fs.mkdir(path.join(owDir, "src"), { recursive: true });
  await fs.writeFile(path.join(owDir, "src", "a.ts"), "旧内容\n");
  const owRes = await restorePackage({ packageDir: rec.packageDir, targetDir: owDir, source: "本机封存", onConflict: "overwrite" });
  check("「用包内覆盖」还原成功且指纹一致", owRes.report.digestMatch === true
    && (await fs.readFile(path.join(owDir, "src", "a.ts"), "utf8")).includes("a = 3"));

  // ========== 7.4 填错交接 ID 被拒绝并说清怎么办 ==========
  let idMismatchMsg = "";
  try {
    await restorePackage({ packageDir: rec.packageDir, handoffId: "hnd_deadbeef", targetDir: path.join(T, "repoId"), source: "本机封存" });
  } catch (e) { idMismatchMsg = String((e as Error).message); }
  check("包内 ID 与请求 ID 不一致时拒绝并给出出路", /不一致/.test(idMismatchMsg) && /留空/.test(idMismatchMsg));

  // ========== 7.5 清单里的路径穿越被挡 ==========
  const pkgCopy = path.join(T, "pkgEvil");
  await fs.cp(rec.packageDir, pkgCopy, { recursive: true });
  const evilManifest = JSON.parse(await fs.readFile(path.join(pkgCopy, "manifest.json"), "utf8"));
  evilManifest.entries.push({ path: "../../evil.txt", sha256: "0".repeat(64), size: 1 });
  await fs.writeFile(path.join(pkgCopy, "manifest.json"), JSON.stringify(evilManifest));
  const evilCheck = await checkEntries(pkgCopy, evilManifest);
  check("清单里的 ../ 路径判为不安全条目", evilCheck.ok === false && evilCheck.broken.some((b) => b.includes("evil.txt")));
  check("isSafeRelPath 挡绝对路径/盘符/UNC", !isSafeRelPath("/etc/passwd") && !isSafeRelPath("C:\\Windows\\x") && !isSafeRelPath("\\\\srv\\share\\x") && isSafeRelPath("src/a.ts"));

  // ========== 7.6 排除规则表与规则本体一致（防漂移） ==========
  check("EXCLUSION_REASONS 与 DEFAULT_EXCLUDES 一一对应",
    EXCLUSION_REASONS.length === DEFAULT_EXCLUDES.length
    && EXCLUSION_REASONS.every((x, i) => x.re.source === DEFAULT_EXCLUDES[i].source));

  // ========== 7.7 形态保真：符号链接与可执行位跨机不丢 ==========
  const repoM = path.join(T, "repoMode");
  await fs.mkdir(path.join(repoM, "src"), { recursive: true });
  sh("git init -q && git config user.email t@t && git config user.name t", repoM);
  await fs.writeFile(path.join(repoM, "README.md"), "# m\n");
  sh("git add -A && git commit -qm base", repoM);
  await fs.writeFile(path.join(repoM, "run.sh"), "#!/bin/sh\necho hi\n");
  sh("git add run.sh && git update-index --chmod=+x run.sh", repoM);
  await fs.writeFile(path.join(repoM, "src", "link.ts"), "src/../src/a.ts");
  const linkBlob = sh("git hash-object -w src/link.ts", repoM).toString().trim();
  sh(`git update-index --add --cacheinfo 120000,${linkBlob},src/link.ts`, repoM);
  const cfgM: ProjectConfig = { projectId: "prj_mode", name: "mode-repo", path: repoM, checks: [] };
  await addProject(cfgM);
  const createdM = await createHandoff(cfgM, { taskName: "模式保真", runChecks: false });
  const execChange = createdM.record.state.changes.find((c) => c.path === "run.sh");
  const linkChange = createdM.record.state.changes.find((c) => c.path === "src/link.ts");
  check("可执行位以 100755 进入交接状态", execChange?.mode === "100755", JSON.stringify(execChange));
  check("符号链接以 120000 进入交接状态（不再被当成普通文件）", linkChange?.mode === "120000", JSON.stringify(linkChange));
  const modeDir = path.join(T, "repoModeRestored");
  const rM = await restorePackage({ packageDir: createdM.record.packageDir, targetDir: modeDir, source: "本机封存" });
  check("形态保真的包恢复后代码指纹一致（符号链接不会造成假阴性）", rM.report.digestMatch === true,
    rM.report.steps.find((s) => s.title === "代码指纹复算")?.detail ?? "");
  const idxAfter = sh("git ls-files -s", modeDir).toString();
  check("恢复后的索引保留 120000 模式", /^120000\s+[0-9a-f]{40}\s+\d+\s+src\/link\.ts$/m.test(idxAfter), idxAfter);
  check("恢复后的索引保留 100755 模式", /^100755\s+[0-9a-f]{40}\s+\d+\s+run\.sh$/m.test(idxAfter), idxAfter);
  const linkPlaceholder = rM.report.gaps.find((g) => /符号链接退化/.test(g.title));
  console.log(`      （本机符号链接：${linkPlaceholder ? `无创建权限，退化为普通文件并如实登记 —— ${linkPlaceholder.detail}` : "已按链接目标重建"}）`);

  // ========== 7.8 审阅清单：排除原因、历史凭据告警、大文件提示 ==========
  const prevM = await buildPreview(cfgM);
  check("预览给出纳入条目与体积", prevM.included.length > 0 && prevM.includedBytes >= 0);
  check("预览标注符号链接形态", prevM.included.some((f) => f.kind === "symlink"));

  const repoS = path.join(T, "repoSecret");
  await fs.mkdir(repoS, { recursive: true });
  sh("git init -q && git config user.email t@t && git config user.name t", repoS);
  await fs.writeFile(path.join(repoS, ".env"), "API_KEY=real-secret-never-commit\n");
  await fs.writeFile(path.join(repoS, "server.key"), "-----BEGIN PRIVATE KEY-----\n");
  await fs.writeFile(path.join(repoS, "app.js"), "export const a = 1;\n");
  sh("git add -A && git commit -qm base", repoS);
  await fs.writeFile(path.join(repoS, ".env.local"), "LOCAL=1\n");
  await fs.writeFile(path.join(repoS, "app.js"), "export const a = 2;\n");
  const cfgS: ProjectConfig = { projectId: "prj_secret", name: "secret-repo", path: repoS, checks: [] };
  await addProject(cfgS);
  const prevS = await buildPreview(cfgS);
  check("工作区新增的 .env.local 被排除并说明原因",
    prevS.excluded.some((e) => e.path === ".env.local" && e.kind === "凭据" && /不带出这台电脑/.test(e.reason)));
  check("已提交进历史的凭据被点名（排除策略挡不住历史）",
    prevS.baselineSecrets.includes(".env") && prevS.baselineSecrets.includes("server.key"), JSON.stringify(prevS.baselineSecrets));
  check("历史凭据告警给出可执行出路",
    prevS.alerts.some((a) => a.level === "警告" && /Git 历史/.test(a.title) && a.action.length > 10));
  const createdS = await createHandoff(cfgS, { taskName: "凭据默认排除", runChecks: false });
  check("凭据不进包且写入恢复要求",
    createdS.record.state.excluded.includes(".env.local")
    && createdS.record.state.recoveryRequirements.some((r) => r.includes(".env.local"))
    && !createdS.record.state.changes.some((c) => c.path === ".env.local"));
  // 刚封存的那条交接就躺在项目里的 .acb/ 下：目录型排除必须折成一条，
  // 否则排除清单会随交接次数线性变长，把真正要看的 .env 埋掉
  const prevS2 = await buildPreview(cfgS);
  check("目录型排除折叠成一条并给出命中数",
    prevS2.excluded.some((e) => e.path === ".acb/" && /命中 \d+ 个文件/.test(e.reason))
    && !prevS2.excluded.some((e) => e.path.startsWith(".acb/store/")), JSON.stringify(prevS2.excluded.map((e) => e.path)));
  check("折叠不影响逐条列出的凭据", prevS2.excluded.some((e) => e.path === ".env.local" && e.kind === "凭据"));

  // ========== 7.9 大小写碰撞：单测 + 真仓库拦住 ==========
  const col = caseCollisions(["src/A.ts", "src/a.ts", "src/b.ts"]);
  check("caseCollisions 认出仅大小写不同的路径组", col.length === 1 && col[0].length === 2, JSON.stringify(col));
  const repoC2 = path.join(T, "repoCase");
  await fs.mkdir(repoC2, { recursive: true });
  sh("git init -q && git config user.email t@t && git config user.name t", repoC2);
  await fs.writeFile(path.join(repoC2, "README.md"), "# c\n");
  sh("git add -A && git commit -qm base", repoC2);
  // 复现"仓库在 Linux 上写着 A.ts 与 a.ts，拿到 Windows 上只能落一个"的形状：
  // 索引里两个路径都在，工作区只有一个真文件
  await fs.writeFile(path.join(repoC2, "A.ts"), "export const v = 1;\n");
  sh("git add A.ts && git commit -qm A", repoC2);
  const aBlob = sh("git hash-object -w A.ts", repoC2).toString().trim();
  sh(`git update-index --add --cacheinfo 100644,${aBlob},a.ts`, repoC2);
  await fs.writeFile(path.join(repoC2, "A.ts"), "export const v = 2;\n");
  const cfgC2: ProjectConfig = { projectId: "prj_case", name: "case-repo", path: repoC2, checks: [] };
  await addProject(cfgC2);
  const stC2 = sh("git status --porcelain", repoC2).toString();
  let caseMsg = "";
  try { await createHandoff(cfgC2, { taskName: "大小写冲突", runChecks: false }); }
  catch (e) { caseMsg = String((e as Error).message); }
  check("现场就绪：索引里同时有 A.ts 与 a.ts", /A\.ts/.test(stC2) && /a\.ts/.test(stC2), stC2);
  check("仅大小写不同的路径会让打包停下来（Windows 恢复会静默覆盖）", /大小写/.test(caseMsg) && /改名/.test(caseMsg), caseMsg);

  // ========== 7.10 非 ASCII 基线文件 / 目录链接 / 空目录的跨机保真 ==========
  // 现场自己造：git 默认 core.quotePath=true，非 ASCII 路径在 ls-tree/ls-files 的普通输出里
  // 是 "\344\270\255…" 引用串；按那种串去拼路径会得到本机不存在的路径，
  // 于是中文名文件被静默跳过、而回执写着"基线已重建"。这一节就是钉住这条。
  const repoU = path.join(T, "repoUni");
  await fs.mkdir(path.join(repoU, "src", "\u6587\u6863"), { recursive: true });
  await fs.mkdir(path.join(repoU, "\u5360\u4f4d"), { recursive: true });   // 空目录：Git 不保存
  await fs.mkdir(path.join(repoU, "logs"), { recursive: true });           // 又一个空目录
  sh("git init -q && git config user.email t@t && git config user.name t", repoU);
  await fs.writeFile(path.join(repoU, "README.md"), "# u\n");
  await fs.writeFile(path.join(repoU, "\u4e2d\u6587\u6587\u4ef6.md"), "# \u4e2d\u6587\u547d\u540d\n");
  await fs.writeFile(path.join(repoU, "src", "\u6587\u6863", "\u63a5\u53e3.ts"), "export const api = 1;\n");
  await fs.writeFile(path.join(repoU, "run.sh"), "#!/bin/sh\n");
  sh("git add -A && git commit -qm base", repoU);
  // 指向目录的符号链接：与 7.7 同一手法（索引里记 120000，内容就是目标文本）
  await fs.writeFile(path.join(repoU, "\u6307\u5411\u6e90\u7801"), "src");
  const dirBlob = sh("git hash-object -w -- \u6307\u5411\u6e90\u7801", repoU).toString().trim();
  sh("git update-index --add --cacheinfo 120000," + dirBlob + ",\u6307\u5411\u6e90\u7801", repoU);
  sh("git update-index --chmod=+x run.sh", repoU);
  await fs.writeFile(path.join(repoU, "src", "mod.ts"), "export const m = 1;\n");
  await fs.writeFile(path.join(repoU, "src", "\u6587\u6863", "\u65b0\u589e.ts"), "export const n = 2;\n");
  await fs.writeFile(path.join(repoU, ".env"), "SECRET=keep-on-this-machine\n");
  const cfgU: ProjectConfig = { projectId: "prj_uni", name: "unicode-repo", path: repoU, checks: [] };
  await addProject(cfgU);
  const prevU = await buildPreview(cfgU);
  check("\u975e ASCII \u8def\u5f84\u5728\u5ba1\u9605\u6e05\u5355\u91cc\u662f\u771f\u5b9e\u540d\u5b57\uff08\u4e0d\u662f\u516b\u8fdb\u5236\u5f15\u7528\u4e32\uff09",
    prevU.included.some((f) => f.path === "src/\u6587\u6863/\u65b0\u589e.ts") && !prevU.included.some((f) => f.path.includes("\\34")),
    JSON.stringify(prevU.included.map((f) => f.path)));
  check("\u7a7a\u76ee\u5f55\u88ab\u8bc6\u522b\u5e76\u5199\u8fdb\u5ba1\u9605\u6e05\u5355",
    prevU.emptyDirs.includes("\u5360\u4f4d") && prevU.emptyDirs.includes("logs"), JSON.stringify(prevU.emptyDirs));
  check("\u7a7a\u76ee\u5f55\u544a\u8b66\u8bf4\u660e\u4e86 Git \u4e0d\u4fdd\u5b58\u5b83\u4eec",
    prevU.alerts.some((a) => /\u7a7a\u76ee\u5f55/.test(a.title)), JSON.stringify(prevU.alerts.map((a) => a.title)));
  const createdU = await createHandoff(cfgU, { taskName: "\u975e ASCII \u4e0e\u7a7a\u76ee\u5f55\u4fdd\u771f", runChecks: false });
  check("\u7a7a\u76ee\u5f55\u8fdb\u5165\u4ea4\u63a5\u72b6\u6001", (createdU.record.state.emptyDirs ?? []).length >= 2, JSON.stringify(createdU.record.state.emptyDirs));
  const uniDir = path.join(T, "repoUniRestored");
  const rU = await restorePackage({ packageDir: createdU.record.packageDir, targetDir: uniDir, source: "本机封存" });
  check("\u4e2d\u6587\u540d\u57fa\u7ebf\u6587\u4ef6\u771f\u7684\u843d\u5230\u4e86\u76ee\u5f55", await fs.stat(path.join(uniDir, "\u4e2d\u6587\u6587\u4ef6.md")).then(() => true).catch(() => false));
  check("\u4e2d\u6587\u76ee\u5f55\u4e0b\u7684\u57fa\u7ebf\u6587\u4ef6\u843d\u5730", await fs.stat(path.join(uniDir, "src", "\u6587\u6863", "\u63a5\u53e3.ts")).then(() => true).catch(() => false));
  const stU = sh("git status --porcelain", uniDir).toString();
  check("\u6062\u590d\u540e git \u770b\u4e0d\u5230\u6b8b\u7f3a\uff08\u6ca1\u6709\u5de5\u4f5c\u533a\u5220\u9664\uff09", !/^. D /.test(stU), stU);
  check("\u7a7a\u76ee\u5f55\u5728\u63a5\u6536\u7aef\u91cd\u5efa",
    (await fs.stat(path.join(uniDir, "\u5360\u4f4d")).then((s) => s.isDirectory()).catch(() => false))
    && (await fs.stat(path.join(uniDir, "logs")).then((s) => s.isDirectory()).catch(() => false)));
  check("\u76ee\u5f55\u7b26\u53f7\u94fe\u63a5\u4fdd\u7559 120000 \u6a21\u5f0f",
    /^120000\s+[0-9a-f]{40}\s+\d+\s+\u6307\u5411\u6e90\u7801$/m.test(sh("git -c core.quotepath=false ls-files -s", uniDir).toString()),
    sh("git -c core.quotepath=false ls-files -s", uniDir).toString());
  const dirLinkLstat = await fs.lstat(path.join(uniDir, "\u6307\u5411\u6e90\u7801")).catch(() => null);
  const dirLinkReported = rU.report.steps.some((s) => /\u76ee\u5f55\u8054\u63a5|\u7b26\u53f7\u94fe\u63a5/.test(s.title))
    || rU.report.gaps.some((g) => /\u7b26\u53f7\u94fe\u63a5/.test(g.title));
  console.log(`      \uff08\u76ee\u5f55\u94fe\u63a5\u5f62\u6001\uff1a${dirLinkLstat?.isSymbolicLink() ? "\u5df2\u6309\u94fe\u63a5\u91cd\u5efa" : dirLinkLstat ? "\u9000\u5316\u4e3a\u666e\u901a\u6587\u4ef6\uff08\u672c\u673a\u65e0\u7279\u6743\uff09" : "\u672a\u843d\u5730"}\uff09`);
  check("\u76ee\u5f55\u94fe\u63a5\u8981\u4e48\u662f\u94fe\u63a5\u3001\u8981\u4e48\u5982\u5b9e\u62a5\u544a\uff0c\u4e0d\u80fd\u9759\u9ed8",
    !!dirLinkLstat && (dirLinkLstat.isSymbolicLink() || dirLinkReported));
  check("\u53ef\u6267\u884c\u4f4d\u5728\u4e2d\u6587\u8def\u5f84\u4ed3\u5e93\u91cc\u4e5f\u4e0d\u4e22",
    /^100755\s+[0-9a-f]{40}\s+\d+\s+run\.sh$/m.test(sh("git ls-files -s", uniDir).toString()));
  check("\u5f62\u6001\u4fdd\u771f\u7684\u5305\u6062\u590d\u540e\u6307\u7eb9\u4e00\u81f4", rU.report.digestMatch === true,
    rU.report.steps.find((s) => s.title === "\u4ee3\u7801\u6307\u7eb9\u590d\u7b97")?.detail ?? "");
  check("\u57fa\u7ebf\u7269\u5316\u7ed9\u51fa\u9884\u671f/\u5b9e\u9645/\u672a\u843d\u5730\u4e09\u4e2a\u6570",
    (rU.report.baselineExpected ?? 0) >= 3 && rU.report.baselineWritten === rU.report.baselineExpected
    && (rU.report.baselineSkipped ?? []).length === 0,
    JSON.stringify({ exp: rU.report.baselineExpected, w: rU.report.baselineWritten, skip: rU.report.baselineSkipped }));
  check("\u51ed\u636e\u4e0d\u4f1a\u88ab\u5e26\u5230\u63a5\u6536\u7aef", !await fs.stat(path.join(uniDir, ".env")).then(() => true).catch(() => false));
  const uniBaselineStep = rU.report.steps.find((s) => s.title === "\u57fa\u7ebf\u7269\u5316");
  check("\u57fa\u7ebf\u56de\u6267\u6587\u6848\u70b9\u51fa\u4e86\u94fe\u63a5\u4e0e\u6267\u884c\u4f4d\u7684\u6570\u91cf",
    !!uniBaselineStep && /120000|100755|\u7b26\u53f7\u94fe\u63a5|\u53ef\u6267\u884c/.test(uniBaselineStep.detail), uniBaselineStep?.detail ?? "");

  // ========== 7.11 \u9010\u9879\u56de\u6267\uff1a\u53ea\u5728\u76ee\u6807\u7684\u672c\u673a\u6587\u4ef6\u5fc5\u987b\u770b\u89c1 ==========
  const leftoverDir = path.join(T, "repoLeftover");
  await fs.mkdir(leftoverDir, { recursive: true });
  await fs.writeFile(path.join(leftoverDir, "\u672c\u673a\u65e7\u6587\u4ef6.txt"), "\u8fd9\u662f\u63a5\u6536\u7535\u8111\u81ea\u5df1\u7684\u4e1c\u897f\n");
  const preL = await previewPackageResume({ packageDir: createdU.record.packageDir, targetDir: leftoverDir, source: "本机封存" });
  check("\u9884\u89c8\u5c31\u80fd\u770b\u89c1\u300c\u53ea\u5728\u76ee\u6807\u300d\u7684\u672c\u673a\u6587\u4ef6",
    (preL.onlyInTarget ?? []).includes("\u672c\u673a\u65e7\u6587\u4ef6.txt"), JSON.stringify(preL.onlyInTarget));
  check("\u9884\u89c8\u62ff\u5230\u4e86\u57fa\u7ebf\u6e05\u5355\uff08\u80fd\u533a\u5206\u5305\u5185\u5bb9\u4e0e\u672c\u673a\u6587\u4ef6\uff09",
    preL.baselineListed === true && (preL.baselineMissingInTarget ?? 0) >= 3,
    JSON.stringify({ listed: preL.baselineListed, missing: preL.baselineMissingInTarget, total: preL.packagePathCount }));
  const rL = await restorePackage({ packageDir: createdU.record.packageDir, targetDir: leftoverDir, source: "本机封存", onConflict: "skip" });
  check("\u56de\u6267\u5217\u51fa\u300c\u53ea\u5728\u76ee\u6807\u300d\u7684\u672c\u673a\u6587\u4ef6",
    (rL.report.receipt?.onlyInTarget ?? []).includes("\u672c\u673a\u65e7\u6587\u4ef6.txt"), JSON.stringify(rL.report.receipt));
  check("\u300c\u53ea\u5728\u76ee\u6807\u300d\u4e0d\u628a\u4ea4\u63a5\u5185\u5bb9\u7b97\u8fdb\u53bb",
    !(rL.report.receipt?.onlyInTarget ?? []).includes("README.md"));
  check("\u6062\u590d\u62a5\u544a\u6b63\u6587\u91cc\u6709\u9010\u9879\u5bf9\u8d26\u4e00\u680f",
    (await fs.readFile(path.join(leftoverDir, "ACB-RESUME-REPORT.md"), "utf8")).includes("\u53ea\u5728\u76ee\u6807"));

  // ========== 7.12 \u78b0\u649e\u5305\u5728\u672c\u673a\u8fd8\u539f\uff1a\u5199\u5165\u524d\u62e6\u4f4f\uff0c\u800c\u4e0d\u662f\u6253\u5b8c\u518d\u62a5\u6307\u7eb9\u4e0d\u4e00\u81f4 ==========
  // \u73b0\u573a\u81ea\u5df1\u9020\uff1a\u590d\u5236\u4e00\u4efd\u5df2\u5c01\u5b58\u7684\u5305\uff0c\u5f80\u72b6\u6001\u91cc\u63d2\u4e00\u4e2a\u4e0e\u73b0\u6709\u6587\u4ef6\u53ea\u5dee\u5927\u5c0f\u5199\u7684\u8def\u5f84\uff0c
  // \u518d\u91cd\u5efa manifest\uff08\u5426\u5219\u5148\u6302\u5728\u5b8c\u6574\u6027\u4e0a\uff0c\u5c31\u6d4b\u4e0d\u5230\u78b0\u649e\u5224\u636e\uff09\u3002
  const evilPkg = path.join(T, "pkgCaseCollide");
  await fs.cp(createdU.record.packageDir, evilPkg, { recursive: true });
  const evilStatePath = path.join(evilPkg, "acb-state", "project-state.json");
  const evilState = JSON.parse(await fs.readFile(evilStatePath, "utf8"));
  const victim = evilState.changes.find((c: { path: string }) => /mod\.ts$/.test(c.path)) ?? evilState.changes[0];
  evilState.changes.push({ ...victim, path: victim.path.replace("mod.ts", "MOD.ts"), staged: false });
  await fs.writeFile(evilStatePath, JSON.stringify(evilState, null, 2));
  const collisionManifest = await buildManifest(evilPkg, evilState);
  await fs.writeFile(path.join(evilPkg, "manifest.json"), JSON.stringify(collisionManifest, null, 2));
  const collideDir = path.join(T, "repoCollide");
  const rCol = await restorePackage({ packageDir: evilPkg, targetDir: collideDir, source: "\u672c\u673a\u5b58\u50a8\uff08\u4f2a\u9020\u78b0\u649e\u5305\uff09" });
  check("\u4f2a\u9020\u540e\u5305\u5b8c\u6574\u6027\u4ecd\u901a\u8fc7\uff08\u6d4b\u7684\u662f\u78b0\u649e\u5224\u636e\u4e0d\u662f\u635f\u574f\u5224\u636e\uff09",
    rCol.report.steps.some((s) => s.title === "\u6062\u590d\u524d\u6821\u9a8c" && s.ok),
    JSON.stringify(rCol.report.steps[1]));
  check("\u78b0\u649e\u5305\u5728\u5199\u5165\u524d\u88ab\u62e6\u4f4f\uff08\u4e00\u4e2a\u5b57\u8282\u90fd\u6ca1\u5199\uff09",
    rCol.report.verdict === "\u6062\u590d\u88ab\u963b\u585e" && (rCol.report.restoredCount ?? -1) === 0
    && !(await fs.stat(path.join(collideDir, "README.md")).then(() => true).catch(() => false)),
    JSON.stringify({ verdict: rCol.report.verdict, restored: rCol.report.restoredCount }));
  check("\u62e6\u4f4f\u7406\u7531\u70b9\u540d\u5927\u5c0f\u5199\u5e76\u7ed9\u51fa\u4e24\u6761\u51fa\u8def",
    /大小写/.test(rCol.report.gaps.map((g) => g.title + g.detail).join(" "))
    && /\u533a\u5206\u5927\u5c0f\u5199|\u6539\u540d/.test(rCol.report.gaps.map((g) => g.detail).join(" ")),
    JSON.stringify(rCol.report.gaps));

  // ========== 7.13 \u8def\u5f84\u5224\u636e\u51fd\u6570\u81ea\u8eab\uff08\u4e0d\u9760\u672c\u673a\u73af\u5883\u6070\u5de7\u6ee1\u8db3\uff09 ==========
  check("unquoteGitPath \u8fd8\u539f git \u7688\u516b\u8fdb\u5236\u5f15\u7528\u4e32",
    unquoteGitPath('"\\344\\270\\255\\346\\226\\207\\346\\226\\207\\344\\273\\266.md"') === "\u4e2d\u6587\u6587\u4ef6.md"
    && unquoteGitPath('"a\\tb"') === "a\tb"
    && unquoteGitPath("src/plain.ts") === "src/plain.ts",
    unquoteGitPath('"\\344\\270\\255\\346\\226\\207\\346\\226\\207\\344\\273\\266.md"'));
  check("windowsNameIssues \u8ba4\u51fa\u4fdd\u7559\u8bbe\u5907\u540d\u4e0e\u7ed3\u5c3e\u70b9/\u7a7a\u683c",
    windowsNameIssues("src/nul").length === 1 && windowsNameIssues("a/COM1.log").length === 1
    && windowsNameIssues("bad dir ./x").length > 0 && windowsNameIssues("src/main.ts").length === 0,
    JSON.stringify([windowsNameIssues("src/nul"), windowsNameIssues("a/COM1.log"), windowsNameIssues("src/main.ts")]));
  check("pathFidelityAlerts \u628a\u4e0d\u53ef\u547d\u540d\u8def\u5f84\u5217\u4e3a\u8b66\u544a\uff08\u4e0d\u9759\u9ed8\u5e26\u8fc7\uff09",
    pathFidelityAlerts(["src/nul", "ok.ts"]).some((a) => a.level === "\u8b66\u544a" && /Windows/.test(a.title)),
    JSON.stringify(pathFidelityAlerts(["src/nul"])));
  check("pathFidelityAlerts \u70b9\u540d\u8d85\u957f\u8def\u5f84",
    pathFidelityAlerts(["a/b", "x".repeat(300)], "C:\\dev\\p").some((a) => /260/.test(a.title)));
  check("pathFidelityAlerts \u7684\u963b\u585e\u5224\u636e\u4e0e\u6253\u5305\u5165\u53e3\u540c\u4e00\u4e2a\uff08\u4e0d\u662f\u4e24\u5957\u89c4\u5219\uff09",
    pathFidelityAlerts(["src/A.ts", "src/a.ts"]).every((a) => a.level === "\u963b\u585e")
    && pathFidelityAlerts(["src/A.ts", "src/a.ts"]).length >= 1);

  // ========== 7.15 自动推断：人不写任务与现状，交接也得有内容 ==========
  const repoI = path.join(T, "repoInfer");
  await fs.mkdir(path.join(repoI, "src", "auth"), { recursive: true });
  await fs.mkdir(path.join(repoI, "tests"), { recursive: true });
  const shI = (c: string) => execSync(c, { cwd: repoI, stdio: "pipe" }).toString();
  shI("git init -q -b feat/login-timeout");
  shI("git config user.email i@i.local && git config user.name infer");
  await fs.writeFile(path.join(repoI, "src/auth/session.ts"), "export const TIMEOUT = 3000;\n");
  await fs.writeFile(path.join(repoI, "tests/session.test.ts"), "test('login', () => {});\n");
  shI("git add -A && git commit -qm \"调整登录超时并加重试\"");
  await fs.writeFile(path.join(repoI, "src/auth/session.ts"),
    "export const TIMEOUT_MS = 8000;\nexport function retryWithBackoff(n: number) {\n  // TODO: 退避上限还没定\n  return n * 2;\n}\n");
  await fs.writeFile(path.join(repoI, "src/auth/retry.ts"), "export const MAX_RETRY = 3;\n");
  const cfgI: ProjectConfig = { projectId: "prj_infer", name: "infer-repo", path: repoI, checks: [] };
  await addProject(cfgI);
  const prevI = await buildPreview(cfgI);
  check("预览带来自现场的推断任务名", prevI.inferred.taskName === "调整登录超时并加重试"
    && /最近提交/.test(prevI.inferred.taskSource), JSON.stringify(prevI.inferred).slice(0, 200));
  check("推断出新增的符号（不用人写\"我改了什么\"）",
    prevI.inferred.progress.some((p) => p.includes("TIMEOUT_MS")) && prevI.inferred.progress.some((p) => p.includes("retryWithBackoff")),
    prevI.inferred.progress.join(" / "));
  check("把代码里的 TODO 当成下一步线索（上一个 Agent 自己留的话）",
    prevI.inferred.nextSteps.some((n) => /TODO/.test(n) && n.includes("退避上限还没定")));
  check("改了源码没改测试被点名，且标明是推断",
    prevI.inferred.nextSteps.some((n) => n.includes("tests/session.test.ts") && /推断/.test(n)));
  const noName = await createHandoff(cfgI, { runChecks: false });
  check("不填任务名也能封存，任务名来自推断", noName.record.state.taskName === "调整登录超时并加重试"
    && noName.record.state.taskName !== "未命名任务");
  check("简报里如实标注任务名是推断来的",
    (await fs.readFile(path.join(noName.record.packageDir, "HANDOFF.md"), "utf8")).includes("任务名来源"));
  await fs.mkdir(path.join(repoI, ".acb"), { recursive: true });
  await fs.writeFile(path.join(repoI, ".acb/NEXT.md"), "还差退避上限；先跑 tests/session.test.ts 再动 retry.ts。\n");
  const withNote = await createHandoff(cfgI, { runChecks: false });
  check("上一个 Agent 的便签被采纳为声明", withNote.record.state.claims.some((c) => c.sessionId === "agent_note"
    && c.text.includes("还差退避上限")));
  const noteMd = await fs.readFile(path.join(withNote.record.packageDir, "HANDOFF.md"), "utf8");
  check("简报把便签原文放进\"做到哪了\"", noteMd.includes("还差退避上限") && noteMd.includes(".acb/NEXT.md"));
  check("便签不作为人的声明混入（会话身份单列）",
    !withNote.record.state.claims.some((c) => c.sessionId === "sess_web"));

  // ========== 7.16 项目侧接入：交接由项目里的 Agent 自己读到，人不转述任何文字 ==========
  // 这一块是"工具 vs 提示词"的分界：如果交接只能靠人粘一段话，那 ACB 就只是个提示词生成器。
  // 所以断言的目标是"没有人参与也走得通"：注册即装接入块、封存重写指针、Agent 零输入自封存、
  // 还原出来的目录同样自读；同时工具的脚印不能伪装成用户的改动。
  const repoJ = path.join(T, "repoBridge");
  await fs.mkdir(path.join(repoJ, "src"), { recursive: true });
  const shJ = (c: string) => execSync(c, { cwd: repoJ, stdio: "pipe" }).toString();
  // 文件缺失要变成一条 FAIL，而不是把整个套件炸在这里（炸了的变异不算"证明了它能失败"）
  const readOr = async (p: string) => await fs.readFile(p, "utf8").catch(() => "（文件不存在）");
  shJ("git init -q -b feat/bridge-check");
  shJ("git config user.email j@j.local && git config user.name bridge");
  await fs.writeFile(path.join(repoJ, "src/a.ts"), "export const a = 1;\n");
  shJ("git add -A && git commit -qm \"接入块检查\"");
  await fs.writeFile(path.join(repoJ, "src/a.ts"), "export const a = 2;\n");
  const regJ = await registerProjectDir(repoJ, "bridge-repo");
  const agentsJ = path.join(repoJ, "AGENTS.md");
  const latestJ = path.join(repoJ, ".acb", "LATEST.md");
  check("注册就在项目里装上接入块与指针（没有人教过任何 Agent）",
    regJ.bridge.agents === "created" && regJ.bridge.latest === "created"
    && (await readOr(agentsJ)).includes("ACB:BEGIN")
    && (await readOr(latestJ)).includes("create " + regJ.config.projectId),
    JSON.stringify(regJ.bridge));

  // 指针里那条自封存命令必须是"这次真正在跑的那个入口"，不能跟着敲命令的人站在哪个目录变：
  // 从源码树里跑一次发行包的 cli，就把 dist-server 写进项目指针，双击 exe 接手时那条路径根本不存在。
  const cliRoots = cliCandidateRoots();
  check("入口查找以启动本进程的那个文件为先，cwd 只作最后兜底",
    cliRoots[0] === path.dirname(path.resolve(process.argv[1] ?? ""))
    && cliRoots[cliRoots.length - 1] === path.resolve(process.cwd()), JSON.stringify(cliRoots));
  const cliRootsProbe = path.join(T, "cli-roots");
  await fs.mkdir(path.join(cliRootsProbe, "pkg"), { recursive: true });
  await fs.mkdir(path.join(cliRootsProbe, "empty"), { recursive: true });
  await fs.writeFile(path.join(cliRootsProbe, "pkg", "cli.cjs"), "");
  const picked = cliInvocation([path.join(cliRootsProbe, "pkg"), cliRootsProbe]);
  check("指针里的入口按清单第一个命中，一个都没有时如实说没有（不是猜一个）",
    picked?.run === `node "${path.join(cliRootsProbe, "pkg", "cli.cjs")}"`
    && cliInvocation([path.join(cliRootsProbe, "empty")]) === null, JSON.stringify(picked));

  const sJ1 = await createHandoff(regJ.config, { runChecks: false });
  const sJ2 = await createHandoff(regJ.config, { runChecks: false });
  const agentsTwice = await readOr(agentsJ);
  check("反复封存：接入块只有一份，指针每封一次重写一次",
    (agentsTwice.match(/ACB:BEGIN/g) ?? []).length === 1
    && sJ1.bridge.agents === "unchanged" && sJ2.bridge.agents === "unchanged" && sJ2.bridge.latest === "updated",
    JSON.stringify(sJ1.bridge) + JSON.stringify(sJ2.bridge));
  const latestAfter = await readOr(latestJ);
  check("指针说的是最新那次封存，不是历史里最旧的那条",
    latestAfter.includes("当前交接：`" + sJ2.record.handoffId + "`")
    && !latestAfter.includes("当前交接：`" + sJ1.record.handoffId + "`"));

  const agentsBytesBefore = await fs.readFile(agentsJ).catch(() => Buffer.alloc(0));
  await fs.writeFile(path.join(repoJ, ".acb", "NO-BRIDGE"), "");
  const sJ3 = await createHandoff(regJ.config, { runChecks: false });
  check("项目里有 .acb/NO-BRIDGE 时 AGENTS.md 一个字节都不改，指针照写",
    sJ3.bridge.agents === "skipped" && /NO-BRIDGE/.test(sJ3.bridge.reason ?? "")
    && Buffer.compare(agentsBytesBefore, await fs.readFile(agentsJ)) === 0
    && sJ3.bridge.latest === "updated", JSON.stringify(sJ3.bridge));
  await fs.rm(path.join(repoJ, ".acb", "NO-BRIDGE"), { force: true });

  await fs.writeFile(agentsJ, "我的说明\n<!-- ACB:BEGIN -->\n半截标记没有结束\n");
  const sJ4 = await createHandoff(regJ.config, { runChecks: false });
  const halfKept = await readOr(agentsJ);
  check("标记残缺时不改文件，并说得出是哪个标记",
    sJ4.bridge.agents === "skipped" && /标记不完整/.test(sJ4.bridge.reason ?? "")
    && halfKept.includes("半截标记没有结束"), JSON.stringify(sJ4.bridge));

  // 人写的 AGENTS.md 不能被吃掉：接入块追加在后面，原文一字不少
  await fs.writeFile(agentsJ, "我自己的项目说明：先跑 make lint\n");
  const regK = await registerProjectDir(repoJ, "bridge-repo");
  const mergedAgents = await readOr(agentsJ);
  check("已有 AGENTS.md 时只追加一段，人的原文一字不动",
    regK.bridge.agents === "appended" && mergedAgents.startsWith("我自己的项目说明：先跑 make lint")
    && (mergedAgents.match(/ACB:BEGIN/g) ?? []).length === 1);

  // 工具的脚印不能伪装成用户的改动（判据是逐行比对，不是文件名）
  await fs.writeFile(agentsJ, (await readOr(agentsJ)).replace(/^我自己的项目说明：先跑 make lint\n+/, ""));
  const prevJ = await buildPreview(regJ.config);
  check("只有接入块的 AGENTS.md 被认成工具脚印，不进进度",
    prevJ.inferred.acbOwnEdits.includes("AGENTS.md")
    && !prevJ.inferred.progress.some((p) => /^\s*-\s*AGENTS\.md/.test(p))
    && prevJ.inferred.progress.some((p) => p.includes("ACB 自己写的接入块")),
    prevJ.inferred.progress.join(" / "));
  check("审阅清单单列一条提示：这不是你的改动",
    prevJ.alerts.some((a) => a.level === "提示" && /ACB 自己写的/.test(a.title) && a.action.includes("NO-BRIDGE")));
  const sJ5 = await createHandoff(regJ.config, { runChecks: false });
  check("简报里也标明这一项是 ACB 写的接入块",
    (await fs.readFile(path.join(sJ5.record.packageDir, "HANDOFF.md"), "utf8"))
      .includes("（ACB 自己写的接入块，不属于这次的任务）"));
  // 反过来：人往同一个文件里加了内容，就不能再算工具的脚印
  await fs.writeFile(agentsJ, (await readOr(agentsJ)) + "\n人手补了一句：记得改 Makefile\n");
  const prevJ2 = await buildPreview(regJ.config);
  check("混了人手内容的 AGENTS.md 不再算工具脚印（不是按文件名放行）",
    !prevJ2.inferred.acbOwnEdits.includes("AGENTS.md")
    && prevJ2.inferred.progress.some((p) => /AGENTS\.md/.test(p)));
  await fs.writeFile(agentsJ, (await readOr(agentsJ)).replace(/\n人手补了一句：记得改 Makefile\n$/, ""));

  // Agent 侧：一个字段都不填也要能自己封存（这是"被换掉之前自己交接"的那条路）
  const selfSeal = await executeAgentTool("acb.handoff_create",
    { projectId: regJ.config.projectId, confirm: true }, { bootedAt: Date.now(), port: 5174 });
  const selfData = selfSeal.data as { taskName: string; taskSource: string; briefPath: string; bridge: { latest: string } };
  check("Agent 零输入自封存：任务名来自推断，简报路径与接入结果都回得来",
    !!selfData.taskName && selfData.taskName !== "未命名任务" && !!selfData.briefPath
    && selfData.bridge.latest === "updated", JSON.stringify(selfData).slice(0, 200));
  let noConfirmCode = "";
  try { await executeAgentTool("acb.handoff_create", { projectId: regJ.config.projectId }, { bootedAt: Date.now(), port: 5174 }); }
  catch (e) { noConfirmCode = (e as { code?: string }).code ?? ""; }
  check("自封存仍然要 confirm:true（写项目这件事不由工具替人决定）", noConfirmCode === "confirm_required", noConfirmCode);

  // 还原出来的目录同样自读
  const targetJ = path.join(T, "repoBridge-target");
  const resJ = await performResume({ projectId: regJ.config.projectId, targetDir: targetJ });
  const latestT = await readOr(path.join(targetJ, ".acb", "LATEST.md"));
  const agentsT = await readOr(path.join(targetJ, "AGENTS.md"));
  check("还原出来的目录里接入块到位（随包带过来，指针是新建的）",
    resJ.bridge !== null && resJ.bridge.agents === "unchanged" && resJ.bridge.latest === "created"
    && agentsT.includes("ACB:BEGIN") && latestT.includes("ACB-HANDOFF.md"),
    JSON.stringify(resJ.bridge));
  check("还原指针里的完整性数字就是实测的那条，且教它先注册再自封存",
    latestT.includes(`实测逐条 SHA-256 通过 ${resJ.report.verifiedCount} 条`)
    && latestT.includes("register \"" + targetJ + "\"")
    && latestT.includes("create <新的 prj_")
    && !latestT.includes("「封存」那一节"), latestT.slice(0, 300));

  // ========== 7.17 接手接口：一次调用拿到摘要，而且必须比"直接丢简报"省 token ==========
  // 判据是用户给的那条：接口不省 token 就没意义。所以这里不只测"能返回"，
  // 而是把两边成本放进同一次断言里 —— 摘要变胖了，这条就红。
  type TakeoverOut = {
    via: string; level: string; hnd: string; task: string; proj: string; path: string; n: number;
    files: { p: string; s: string }[]; more: number; next: string[]; need: string[]; checks: unknown[];
    seal: string | null; brief: string; markdown?: string; tokens?: number;
    cost?: { tokens: number; briefTokens: number };
  };
  const asTk = (o: Record<string, unknown>) => o as unknown as TakeoverOut;
  const latestI = (await loadHandoffRecords(repoI))[0];
  const tko = asTk(await takeover({ at: path.join(repoI, "src", "auth") }));
  check("at=<子目录> 就能问出该接哪一条（Agent 只知道自己在哪儿）",
    tko.via === "at" && tko.hnd === latestI.handoffId && tko.proj === "infer-repo", JSON.stringify(tko).slice(0, 160));
  check("摘要带着动手要用的四件事：任务 / 文件 / 下一步 / 需本机补齐",
    !!tko.task && Array.isArray(tko.files) && tko.files.length > 0 && Array.isArray(tko.next) && Array.isArray(tko.need));
  check("摘要自报两边成本，且确实比简报原文省",
    !!tko.cost && tko.cost.tokens > 0 && tko.cost.tokens < tko.cost.briefTokens, JSON.stringify(tko.cost));
  const tkf = asTk(await takeover({ projectId: "prj_infer", level: "files" }));
  check("files 档只回文件清单，条数等于改动数（不悄悄砍）",
    tkf.files.length === tkf.n && tkf.n === latestI.state.changes.length, `${tkf.files.length}/${tkf.n}`);
  const tkb = asTk(await takeover({ handoffId: latestI.handoffId, level: "brief" }));
  check("brief 档回的是那份简报原文，不是二手摘要",
    !!tkb.markdown && tkb.markdown.startsWith("# 接手简报")
    && tkb.markdown === await fs.readFile(path.join(latestI.packageDir, "HANDOFF.md"), "utf8"));
  check("brief 档把原文成本如实算出来（丢文件这条路值多少）",
    (tkb.tokens ?? 0) > 0 && estimateTokens(tkb.markdown ?? "") === tkb.tokens);
  check("摘要里连自己封存的命令都给（读完就知道下一步怎么收尾）",
    !!tko.seal && tko.seal.includes("create prj_infer"), String(tko.seal));
  let amb = "";
  try { await takeover({}); } catch (e) { amb = e instanceof Error ? e.message : String(e); }
  check("没说过在哪、接哪条：要参数而不是猜一条", /at=|projectId=|handoffId=/.test(amb) && amb.includes("出路"), amb.slice(0, 160));
  let noAt = "";
  try { await takeover({ at: path.join(T, "没注册过的目录") }); } catch (e) { noAt = e instanceof Error ? e.message : String(e); }
  check("未注册目录：说得出没注册，并把可选项列出来", noAt.includes("不属于任何已注册项目") && noAt.includes("prj_"), noAt.slice(0, 160));
  let noHnd = "";
  try { await takeover({ projectId: "prj_gone2" }); } catch (e) { noHnd = e instanceof Error ? e.message : String(e); }
  check("未注册项目这条也给出路（project_register / 直接传 at）", noHnd.includes("出路"), noHnd.slice(0, 160));

  // ========== 8. 损坏包被阻止 ==========
  const brokenPkg = path.join(T, "broken-pkg");
  await fs.cp(rec.packageDir, brokenPkg, { recursive: true });
  await fs.writeFile(path.join(brokenPkg, "manifest.json"), Buffer.from("corrupted!!"));
  let blocked = false;
  let blockedWhy = "";
  try {
    await restorePackage({ packageDir: brokenPkg, targetDir: path.join(T, "repoD"), source: "损坏副本" });
  } catch (e) { blocked = true; blockedWhy = String((e as Error).message); }
  check("损坏包在写入目标前被阻止", blocked
    && (await fs.readdir(path.join(T, "repoD")).then((f) => f.length).catch(() => 0)) === 0, blockedWhy);
  check("损坏包说得出是包结构读不出来", /结构不完整/.test(blockedWhy), blockedWhy);

  // ========== 9. 恢复报告落盘 ==========
  const reports = await loadResumeReports();
  check("Resume Report 已保存", reports.length >= 2);

  // ========== 10. 服务层与本机守卫 ==========
  // 上面九节全在核心函数上跑，一个 HTTP 请求都没发过 —— 于是"npm run dev 指向
  // server/index.ts，而那个模块只 export startServer、从不 listen"这种缺陷能在全绿
  // 的情况下活着。这一节把服务真起一次，并钉住四件事：入口形状、Origin/Host 矩阵、
  // "目录不见了"的分类（404 而不是 500）、以及 Agent 能力面与界面同源。
  check("isLoopbackAddress 认 127.x 与 ::1", isLoopbackAddress("127.0.0.1") && isLoopbackAddress("[::1]") && !isLoopbackAddress("localhost") && !isLoopbackAddress("0.0.0.0"));
  let bindThrew = false;
  try { resolveBindHost({ ACB_BIND_HOST: "0.0.0.0" }); } catch { bindThrew = true; }
  check("非回环的 ACB_BIND_HOST 拒绝启动（不是静默接受）", bindThrew);
  let originThrew = false;
  try { assertLoopbackOrigins("http://evil.example.com"); } catch { originThrew = true; }
  check("ACB_ALLOWED_ORIGINS 里的外来源拒绝启动", originThrew && assertLoopbackOrigins("http://localhost:5173").length === 1);
  check("Host 头按固定字面量清单判，不比请求自己", hostHeaderAllowed("127.0.0.1:5174", 5174) && !hostHeaderAllowed("evil.example:5174", 5174) && !hostHeaderAllowed("127.0.0.1:5175", 5174));
  // 省略端口的写法合法（RFC 9110 按 URI 默认端口）；但外域无论带不带端口都要拒。
  // 这一条是发行包体检逼出来的：客户端发 `Host: 127.0.0.1` 时守卫视健康检查为 403。
  check("省略端口的回环 Host 放行，外域仍然拒", hostHeaderAllowed("127.0.0.1", 5174) && hostHeaderAllowed("localhost", 5174) && hostHeaderAllowed("[::1]", 5174) && !hostHeaderAllowed("evil.example", 5174) && !hostHeaderAllowed("acb.example.com:5174", 5174) && !hostHeaderAllowed(undefined, 5174));
  check("Origin 只放本服务源，额外项要显式登记", originAllowed("http://localhost:5174", 5174) && originAllowed("http://localhost:5173", 5174, ["http://localhost:5173"]) && !originAllowed("http://localhost:5173", 5174) && !originAllowed("https://localhost:5174", 5174));

  // 守卫在 index.ts 装载时读 ACB_ALLOWED_ORIGINS，所以必须在 import 之前设好 —— 用 await import
  process.env.ACB_ALLOWED_ORIGINS = "http://localhost:5173";
  const { startServer } = await import("../server/index.js");
  const handle = await startServer(0);
  check("startServer 回句柄而不是端口号（桌面壳读 handle.port/close）",
    typeof handle === "object" && typeof handle.port === "number" && handle.port > 0 && typeof handle.close === "function");
  const base = `http://127.0.0.1:${handle.port}`;
  try {
    const health = await fetch(`${base}/api/health`);
    const hb = await health.json() as { ok?: boolean; data?: { tools?: number } };
    check("GET /api/health 通，且报的是工具注册表的真数", health.status === 200 && hb.ok === true && (hb.data?.tools ?? 0) === AGENT_TOOLS.length, `tools=${hb.data?.tools}`);
    check("响应不带 CORS 放行头（这个服务没有跨源调用方）", health.headers.get("access-control-allow-origin") === null);
    check("外来 Origin 403", (await fetch(`${base}/api/health`, { headers: { origin: "https://evil.example.com" } })).status === 403);
    check("登记过的回环开发源（vite:5173）放行", (await fetch(`${base}/api/health`, { headers: { origin: "http://localhost:5173" } })).status === 200);
    check("没登记的另一个本机端口仍被拒", (await fetch(`${base}/api/health`, { headers: { origin: "http://localhost:5999" } })).status === 403);
    // 解析层的失败形状：落到 Express 默认处理器会回一页 HTML，Agent 只能报"服务坏了"。
    // 甲方探针在真产物上抓到过一次（400 + `<!DOCTYPE html>`），这两条把它钉住。
    const junk = await fetch(`${base}/api/agent/tool`, { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
    const jb = await junk.json().catch(() => null) as { ok?: boolean; error?: { code?: string } } | null;
    check("畸形 JSON 回契约 JSON 错误体，不是 HTML 错误页", junk.status === 400 && jb?.ok === false && jb?.error?.code === "bad_json", `status=${junk.status} body=${JSON.stringify(jb)?.slice(0, 80)}`);
    const big = await fetch(`${base}/api/agent/tool`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tool: "acb.storage_status", input: { pad: "x".repeat(5 * 1024 * 1024) } }) });
    const bbody = await big.json().catch(() => null) as { ok?: boolean; error?: { code?: string } } | null;
    check("超大 body 回 413 的 JSON 而不是 HTML", big.status === 413 && bbody?.ok === false && bbody?.error?.code === "too_large", `status=${big.status}`);

    const manifest = await fetch(`${base}/api/agent/manifest`);
    const mb = await manifest.json() as { data?: { tools?: { name: string }[] } };
    check("/api/agent/manifest 交出工具表", manifest.status === 200 && (mb.data?.tools?.length ?? 0) === AGENT_TOOLS.length && mb.data!.tools!.some((t) => t.name === "acb.handoff_takeover"));
    const toolNames = (mb.data?.tools ?? []).map((x) => x.name);
    check("跨电脑工具已从能力面撤下（发布与远端列表都不再暴露）",
      !toolNames.some((x) => /publish|remote/i.test(x)), toolNames.join(","));
    // ---------- 接手接口：REST / Agent 工具 / MCP 桥三条入口，同一份判据 ----------
    const restTk = await (await fetch(`${base}/api/handoff-brief?at=${encodeURIComponent(repoI)}`)).json();
    const toolTk = await executeAgentTool("acb.handoff_takeover", { at: repoI }, { bootedAt: Date.now(), port: handle.port });
    check("REST 与 Agent 工具回的是同一份接手摘要（判据只有一处）",
      JSON.stringify(restTk) === JSON.stringify(toolTk.data), JSON.stringify(restTk).slice(0, 120));
    const txt = await fetch(`${base}/api/handoff-brief?handoffId=${restTk.hnd}&level=brief&format=text`);
    const txtBody = await txt.text();
    check("format=text 回纯简报，连 JSON 壳都不留",
      (txt.headers.get("content-type") ?? "").includes("text/markdown") && txtBody.startsWith("# 接手简报"));
    const noArg = await fetch(`${base}/api/handoff-brief`);
    const goneProj = await fetch(`${base}/api/handoff-brief?projectId=prj_没这个项目`);
    check("接手端点分类：缺参数 400、找不到 404（不是 500）",
      noArg.status === 400 && goneProj.status === 404, `${noArg.status}/${goneProj.status}`);
    const ep = await readEndpoint();
    check("发现文件写的是这次真实监听的端口（桌面版随机端口也找得到）",
      ep?.port === handle.port && ep?.base_url === base && ep?.pid === process.pid, JSON.stringify(ep));
    const lean = await mcpProbe(handle.port, repoI, ["handoff_takeover", "handoff_create"]);
    const full = await mcpProbe(handle.port, repoI, []);
    check("MCP 桥按 ACB_MCP_TOOLS 只登记要用的两条（工具表也要进上下文）",
      lean.toolNames.length === 2 && lean.toolNames[0] === "acb.handoff_takeover"
      && full.toolNames.length === AGENT_TOOLS.length, JSON.stringify(lean.toolNames));
    check("MCP tools/call 回紧凑 JSON（缩进给人看，模型侧白烧 token）",
      lean.callText.startsWith("{") && !lean.callText.includes("\n  ")
      && JSON.parse(lean.callText).hnd === restTk.hnd, lean.callText.slice(0, 120));
    check("全量工具表确实比精简版贵（所以要收窄，别口头说省）",
      full.listChars > lean.listChars * 4, `${full.listChars}/${lean.listChars}`);

    // 调用形状是 {tool, input}（见 server/agent/routes.ts 的 POST /api/agent/tool）
    const unknown = await fetch(`${base}/api/agent/tool`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool: "acb.不存在", input: {} }),
    });
    const ub = await unknown.json() as { error?: { code?: string; available?: string[] } };
    check("未知工具是 400+unknown_tool，不是 500", unknown.status === 400 && ub.error?.code === "unknown_tool", `${unknown.status} ${ub.error?.code}`);
    check("unknown_tool 带机器可读的可用清单", Array.isArray(ub.error?.available) && (ub.error?.available?.length ?? 0) === AGENT_TOOLS.length);

    // 注册还在、目录被挪走：调用方能自己修好的失败 → 404 并点名是哪个路径。
    // 报 500 的话，Agent 会以为服务坏了去重试，而重试一万次也不会好。
    const gone = path.join(T, "moved-away");
    await addProject({ projectId: "prj_gone", name: "被挪走的项目", path: gone, checks: [] } as ProjectConfig);
    const ov = await fetch(`${base}/api/projects/prj_gone/overview`);
    const ovBody = await ov.json() as { error?: string };
    const ovMsg = ovBody.error ?? "";
    check("目录不见了 → 404（不是 500）", ov.status === 404, `HTTP ${ov.status}`);
    check("失败说得出是哪个目录、也给出路", ovMsg.includes(gone) && /出路|重新注册/.test(ovMsg), ovMsg.slice(0, 70));
    const listed = await fetch(`${base}/api/agent/tool`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool: "acb.projects_list", input: {} }),
    });
    const lb = await listed.json() as { data?: { projects?: { projectId: string; dirAvailable?: boolean }[] } };
    const row = lb.data?.projects?.find((p) => p.projectId === "prj_gone");
    check("陈行注册表在列表里就露面（dirAvailable=false）", row?.dirAvailable === false, JSON.stringify(row));
    const prevTool = await fetch(`${base}/api/agent/tool`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool: "acb.project_overview", input: { projectId: "prj_gone" } }),
    });
    const prevBody = await prevTool.json() as { error?: { code?: string; message?: string } };
    check("同一条失败在 Agent 侧是 not_found，不是 internal_error", prevTool.status === 400 && prevBody.error?.code === "not_found", `${prevTool.status} ${prevBody.error?.code}`);
    check("Agent 侧那条也带着路径与出路", (prevBody.error?.message ?? "").includes(gone), (prevBody.error?.message ?? "").slice(0, 70));
  } finally {
    await handle.close();
    check("服务关完后发现文件收回（不留一个连不上的地址冒充在线）", (await readEndpoint()) === null);
  }

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  if (fail > 0) process.exitCode = 1;
}

try {
  await main();
} catch (e) {
  console.error("E2E 异常:", e);
  process.exitCode = 1;
} finally {
  await fs.rm(T, { recursive: true, force: true }); // 无论成败都清理测试临时目录
}
