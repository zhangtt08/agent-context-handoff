// token 对账（scripts/token-report.ts）：证明或推翻"这条接口比直接丢文件省 token"。
// 用法：npm run tokens [-- --keep]
//
// 为什么要有这个脚本而不是我说省就省：用户的判据是"接口必须比把 HANDOFF.md 直接丢给 Agent
// 更省，不然无意义"。那这句话就得能被一条命令打脸。度量是同一种估算（CJK 一字 ≈ 1 token，
// 其余 4 字符 ≈ 1 token）—— 不同模型的精确计数不同，但**两边用同一把尺子**，比值可比。
//
// 四条路径一起算，因为 MCP 那条有一笔常被忽略的固定开销：工具表要进上下文。
import { execSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { addProject } from "../server/core/store.js";
import { createHandoff } from "../server/core/workflow.js";
import { estimateTokens, takeover, SUMMARY_FILE_CAP } from "../server/core/takeover.js";
import { AGENT_TOOLS } from "../server/agent/tools.js";
import type { ProjectConfig } from "../shared/types.js";

const KEEP = process.argv.includes("--keep");
const T = path.join(os.tmpdir(), "acb-tokens-" + Date.now());

/** 造一个"有代表性"的现场：几个改动文件、一条待办、一次检查、一个凭据排除项 */
async function fixture(): Promise<{ cfg: ProjectConfig; briefPath: string }> {
  const repo = path.join(T, "repo");
  await fs.mkdir(path.join(repo, "src", "auth"), { recursive: true });
  await fs.mkdir(path.join(repo, "tests"), { recursive: true });
  const sh = (c: string) => execSync(c, { cwd: repo, stdio: "pipe" }).toString();
  sh("git init -q -b feat/login-timeout");
  sh("git config user.email t@t.local && git config user.name tok");
  await fs.writeFile(path.join(repo, "src/auth/session.ts"), "export const TIMEOUT = 3000;\n");
  await fs.writeFile(path.join(repo, "src/auth/middleware.ts"), "export const guard = () => true;\n");
  await fs.writeFile(path.join(repo, "tests/session.test.ts"), "test('login', () => {});\n");
  await fs.writeFile(path.join(repo, "README.md"), "# demo\n\n一个用来量 token 的项目。\n");
  sh("git add -A && git commit -qm \"把登录超时从 3s 调到 8s 并补重试\"");
  await fs.writeFile(path.join(repo, "src/auth/session.ts"),
    "export const TIMEOUT_MS = 8000;\nexport function retryWithBackoff(n: number) {\n  // TODO: 退避上限还没定，先按 2 的幂\n  return n * 2;\n}\n");
  await fs.writeFile(path.join(repo, "src/auth/retry.ts"), "export const MAX_RETRY = 3;\nexport const BACKOFF_BASE = 2;\n");
  await fs.writeFile(path.join(repo, ".env"), "API_KEY=super-secret-value\n");
  sh("git add src/auth/session.ts");
  await fs.writeFile(path.join(repo, "src/auth/session.ts"), "export const TIMEOUT_MS = 8500;\n");
  const cfg: ProjectConfig = {
    projectId: "prj_tokens", name: "tokens-repo", path: repo,
    checks: [{ name: "typecheck", cmd: "node -e \"process.exit(0)\"" }],
  };
  await addProject(cfg);
  const out = await createHandoff(cfg, { runChecks: true });
  return { cfg, briefPath: path.join(out.record.packageDir, "HANDOFF.md") };
}

/** MCP 客户端真正会进上下文的那份工具表（与 agent/mcp-server.mjs 的 tools/list 同一个形状） */
function mcpSchemaTokens(only: string[] = []): number {
  const keep = only.length
    ? AGENT_TOOLS.filter((t) => only.some((w) => t.name === w || t.name === `acb.${w}`))
    : AGENT_TOOLS;
  const list = keep.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.input_schema,
    annotations: { readOnlyHint: t.risk === "read", destructiveHint: false, openWorldHint: false },
  }));
  return estimateTokens(JSON.stringify(list));
}

/** 第二个现场：改动文件很多的那一类。摘要的成本有界（文件列表截到 40 条），简报没有上界 */
async function bigFixture(): Promise<{ cfg: ProjectConfig; briefPath: string }> {
  const repo = path.join(T, "repo-big");
  await fs.mkdir(path.join(repo, "src"), { recursive: true });
  const sh = (c: string) => execSync(c, { cwd: repo, stdio: "pipe" }).toString();
  sh("git init -q -b feat/bulk");
  sh("git config user.email t@t.local && git config user.name tok");
  for (let i = 0; i < 20; i++) await fs.writeFile(path.join(repo, "src", `m${i}.ts`), `export const v${i} = ${i};\n`);
  sh("git add -A && git commit -qm \"批量改造\"");
  for (let i = 0; i < 60; i++) {
    const f = i < 20 ? path.join(repo, "src", `m${i}.ts`) : path.join(repo, "src", `n${i}.ts`);
    await fs.writeFile(f, `export const w${i} = ${i};\nexport function fn_${i}(x: number) { return x + ${i}; }\n`);
  }
  const cfg: ProjectConfig = { projectId: "prj_big", name: "big-repo", path: repo, checks: [] };
  await addProject(cfg);
  const out = await createHandoff(cfg, { runChecks: false });
  return { cfg, briefPath: path.join(out.record.packageDir, "HANDOFF.md") };
}

const row = (label: string, tokens: number, base: number) =>
  console.log(`  ${label.padEnd(38)} ${String(tokens).padStart(6)} tokens   ${base ? ((tokens / base) * 100).toFixed(0).padStart(4) + "%" : "基准"}`);

const asNum = (v: unknown) => (typeof v === "number" ? v : Number(v) || 0);

async function main() {
  await fs.mkdir(T, { recursive: true });
  process.env.ACB_HOME = path.join(T, "acb-home");
  const { cfg, briefPath } = await fixture();
  const brief = await fs.readFile(briefPath, "utf8");
  const base = estimateTokens(brief);

  const summary = await takeover({ at: cfg.path, level: "summary" });
  const files = await takeover({ at: cfg.path, level: "files" });
  const summaryTokens = estimateTokens(JSON.stringify(summary));
  const filesTokens = estimateTokens(JSON.stringify(files));
  const fullSchema = mcpSchemaTokens();
  // 接手这一个角色只需要一条工具：handoff_takeover。要它同时能自己收尾，再加 handoff_create。
  const leanSchema = mcpSchemaTokens(["handoff_takeover"]);
  const twoSchema = mcpSchemaTokens(["handoff_takeover", "handoff_create"]);
  const toolCallTokens = estimateTokens(JSON.stringify(summary));

  console.log(`\ntoken 对账（估算：CJK 1 字 ≈ 1，其余 4 字符 ≈ 1；两边同一把尺子）`);
  console.log(`现场：${cfg.path}`);
  console.log("");
  row("A 直接丢 HANDOFF.md 全文（基准）", base, 0);
  row("B HTTP/CLI 摘要（level=summary）", summaryTokens, base);
  row("C HTTP/CLI 只要文件清单（files）", filesTokens, base);
  row("D MCP 全量工具表（16 条，一次性）", fullSchema, base);
  row("E MCP 只登记接手（1 条，一次性）", leanSchema, base);
  row("F MCP 接手 = E + 一次调用", leanSchema + toolCallTokens, base);
  row("F2 MCP 接手+自封存 = 两条 + 一次调用", twoSchema + toolCallTokens, base);
  row("G MCP 全量 = D + 一次调用", fullSchema + toolCallTokens, base);
  console.log("");
  console.log(`  简报里那些字段本来就在：改动 ${String((summary as { n: number }).n)} 项 · 排除 ${String((summary as { excluded: number }).excluded)} 项 · 检查 ${String((summary as { checks: unknown[] }).checks.length)} 条`);
  console.log(`  结论看 F 与 A：MCP 那条路要把工具表一起算，所以接手角色只登记 acb.handoff_takeover 一条。`);

  const big = await bigFixture();
  const bigBrief = await fs.readFile(big.briefPath, "utf8");
  const bigBase = estimateTokens(bigBrief);
  const bigSum = asNum((await takeover({ at: big.cfg.path, level: "summary" }) as { cost: { tokens: number } }).cost.tokens);
  const bigFiles = asNum((await takeover({ at: big.cfg.path, level: "files" }) as { n: number }).n);
  console.log(`\n大现场（${bigFiles} 个改动文件）：简报 ${bigBase} tokens vs 摘要 ${bigSum} tokens（${((bigSum / bigBase) * 100).toFixed(0)}%）`);
  console.log(`  摘要这一侧有上界（文件列表最多 ${SUMMARY_FILE_CAP} 条 + 计数），简报没有 —— 现场越大，这条接口省得越多。\n`);

  const bad: string[] = [];
  // "省一点"不算省：MCP 那条要连工具表一起算，门槛定在丢文件成本的 70% 以下，
  // 否则这条接口不值得为它多配一个 MCP 客户端。
  if (!(summaryTokens < base * 0.6)) bad.push(`摘要没省到简报的 60%：${summaryTokens} / ${base}`);
  if (!(filesTokens < summaryTokens)) bad.push(`文件清单档没比摘要更省：${filesTokens} >= ${summaryTokens}`);
  if (!(leanSchema + toolCallTokens < base * 0.7)) bad.push(`MCP 精简路径总成本没省到丢文件的 70%：${leanSchema + toolCallTokens} / ${base}`);
  if (!(bigSum < bigBase * 0.25)) bad.push(`大现场下摘要没省到简报的 25%：${bigSum} / ${bigBase}`);
  if (fullSchema + toolCallTokens >= base) {
    console.log(`\n注意：MCP 挂全量 ${AGENT_TOOLS.length} 条工具时总成本 ${fullSchema + toolCallTokens} tokens ≥ 丢文件 ${base} —— `
      + `所以 使用说明 里写的是 ACB_MCP_TOOLS 只登记要用的那几条（或直接走 HTTP/CLI）。`);
  }
  if (bad.length) {
    console.error("\n不省 token，这条接口就不该存在：");
    for (const b of bad) console.error("  · " + b);
    process.exitCode = 1;
  } else {
    console.log("\n判据通过：摘要 / 文件清单 / 精简 MCP 三条路都比直接丢简报省。");
  }
  if (!KEEP) await fs.rm(T, { recursive: true, force: true });
  else console.log("现场留在:", T);
}

main().catch((e) => {
  console.error("[acb] 度量失败:", e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exitCode = 1;
});
