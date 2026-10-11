// Protocol Module：Project State 组装、校验、Markdown 接手入口渲染
import type { HandoffRecord, ProjectState, VerificationRecord, ResumeReport } from "../../shared/types.js";
import { exclusionInfo } from "./gitutil.js";

export function validateState(s: ProjectState): string[] {
  const errs: string[] = [];
  if (s.protocolVersion !== "0.1") errs.push("协议版本必须为 0.1");
  if (!s.projectId || !s.taskId || !s.snapshotId || !s.handoffId) errs.push("缺少必需身份字段");
  if (!s.sourceDigest.startsWith("src_sha256:")) errs.push("source_digest 格式非法");
  // 不变量 1：一个 State 只绑定一个 Snapshot（字段唯一性已隐含）
  // 不变量 9：代码可恢复 / 测试通过 / 任务完成 分别表达
  if (s.verifications.length > 0 && s.verifications.some((v) => !v.snapshotId)) {
    errs.push("验证记录必须绑定快照");
  }
  // 声明不得表述为已验证
  for (const c of s.claims) {
    if (/已验证|测试已通过/.test(c.text) && !c.evidence) {
      errs.push(`声明"${c.text.slice(0, 20)}…"使用了验证性表述但未关联证据`);
    }
  }
  return errs;
}

/**
 * 接手入口 Markdown：按"下一个 Agent 读完就能动手"的顺序渲染。
 * 机器字段（协议号、包摘要、逐文件 sha256）不进正文 —— 它们在 project-state.json 与 manifest.json 里，
 * 这一份文件的唯一职责是让人/Agent 用一次读取就明白：要做什么、到哪了、改哪些文件、下一步、别碰什么。
 */
export function renderEntryMarkdown(rec: HandoffRecord): string {
  const s = rec.state;
  const L: string[] = [];
  const commit = s.baseline.commit ? s.baseline.commit.slice(0, 7) : "(无提交)";
  const full = s.sourceDigest.split("full:")[1] ?? s.sourceDigest.replace(/^src_sha256:/, "");

  L.push(`# 接手简报 · ${s.taskName}`, "");
  L.push(`> 项目 ${s.projectName} · 交接 \`${s.handoffId}\` · 基线 \`${s.baseline.branch ?? "(无分支)"} @ ${commit}\``);
  L.push(`> 封存于 ${s.createdAt} · 代码指纹 \`${full.slice(0, 16)}…\`（要确认自己面对的是同一份代码时用它）`);
  if (s.parentHandoffIds.length) L.push(`> 接续自：${s.parentHandoffIds.map((p) => `\`${p}\``).join("、")}`);
  L.push("");

  const inf = s.inferred;
  L.push("## 1. 要做什么", "", `- 任务：${s.taskName}`, `- 任务身份：\`${s.taskId}\``);
  if (inf) L.push(`- 任务名来源：${inf.taskSource}（自动推断，人没有手写）`);
  L.push("- 验收条件：源端没有单独登记，以用户口径为准；不确定就先问，别自己定。");
  L.push("");

  L.push("## 2. 上一个 Agent 做到哪了", "");
  const notes = s.claims.filter((c) => c.sessionId === "agent_note");
  const said = s.claims.filter((c) => c.sessionId !== "agent_note");
  for (const c of notes) {
    L.push(`上一个 Agent 在 \`${inf?.agentNotePath ?? ".acb/NEXT.md"}\` 里留下这些话：`, "");
    L.push(...c.text.split("\n").map((x) => "  " + x.replace(/\s+$/, "")));
    L.push("");
  }
  for (const c of said) {
    L.push(`- ${c.text}${c.evidence ? `（证据：${c.evidence}）` : "（无关联证据 —— 这是声明，不是已验证事实）"}`);
    if (c.nextStep) L.push(`  - 它建议的下一步：${c.nextStep}`);
  }
  if (!said.length && !notes.length && inf?.progress?.length) {
    L.push("没人写说明，以下是 ACB 从 diff 里推断出来的（**推断，不是谁交代的**）：", "");
    L.push(...inf.progress);
    L.push("");
  } else if (!said.length && !notes.length) {
    L.push("- 源端没留下文字说明，也没推断出内容：请只看第 3 节改动清单，并在动手前向我复述你的理解。");
  }
  const next = said.find((c) => c.nextStep)?.nextStep;
  if (next) {
    L.push("", `**建议下一步：${next}**`);
  } else if (inf?.nextSteps?.length) {
    L.push("", "**建议下一步（ACB 从代码里的待办标记与未同步测试推断）：**", "");
    L.push(...inf.nextSteps);
  } else {
    L.push("", "**建议下一步：源端未给出；按第 3 节改动清单自行规划，先跟我确认再动手。**");
  }
  L.push("");

  L.push(`## 3. 改动清单（${s.changes.length} 项 · 需要看代码时只打开这些文件）`, "");
  if (s.changes.length === 0) {
    L.push("- 工作区没有未提交改动：本次交接的内容就是上面那个基线提交。");
  } else {
    const zh: Record<string, string> = { modified: "改", added: "新", deleted: "删", renamed: "改名" };
    const ownSet = new Set(s.inferred?.acbOwnEdits ?? []);
    for (const c of s.changes) {
      const where = c.status === "renamed" && c.oldPath ? `${c.oldPath} → ${c.path}` : c.path;
      const shape = c.mode === "120000" ? " [符号链接]" : c.mode === "100755" ? " [可执行位]" : "";
      const own = ownSet.has(c.path) ? "（ACB 自己写的接入块，不属于这次的任务）" : "";
      L.push(`- [${zh[c.status] ?? c.status}]${c.staged ? " [含暂存版]" : ""}${shape} \`${where}\`${own}`);
    }
    if (s.changes.some((c) => c.staged)) {
      L.push("", "> [含暂存版] = 该文件在源端 Git 暂存区里另有一版，两边内容不同；还原时两份分别落地，别当成重复。");
    }
  }
  if (s.emptyDirs?.length) L.push("", `- 空目录 ${s.emptyDirs.length} 个（Git 不保存，还原时单独重建）：${s.emptyDirs.slice(0, 10).map((d) => `\`${d}\``).join("、")}${s.emptyDirs.length > 10 ? " 等" : ""}`);
  L.push("");

  L.push("## 4. 检查结论（源端历史证据，不等于本机已验证）", "");
  if (s.verifications.length === 0) {
    L.push("- 源端未执行任何检查（状态：未执行）。继续动手前，请在本机跑一次项目配置的检查命令。");
  } else {
    for (const v of s.verifications) {
      L.push(`- [${v.result}] ${v.name} · \`${v.cmd}\` · 退出码 ${v.exitCode ?? "-"} · ${v.durationMs}ms${v.result === "失败" && v.logTail ? `\n  末尾日志：\n  \`\`\`\n${v.logTail.split("\n").slice(-6).join("\n")}\n  \`\`\`` : ""}`);
    }
    L.push("", `> 这些结果只证明"该检查在该快照与该环境下"的结果。接手方要在本机复跑一次才算本机结论：${[...new Set(s.verifications.map((v) => "`" + v.cmd + "`"))].join(" / ")}。`);
  }
  L.push("");

  L.push("## 5. 不在包里 / 需要本机补齐", "");
  if (s.recoveryRequirements.length) {
    for (const r of s.recoveryRequirements) L.push(`- ${r}`);
    L.push("", "上面这些是恢复运行必需、但按策略没有进包的材料（凭据类不会随交接传递）。缺就先问我，别去猜。");
  } else if (s.excluded.length) {
    L.push("- 没有需要本机补齐的材料；下面是按策略排除的内容。");
  } else {
    L.push("- 无：本次没有需要本机额外补齐的材料，也没有排除项。");
  }
  if (s.excluded.length) {
    L.push("", "按纳入策略排除（接手方不必等它们出现）：", "");
    for (const e of s.excluded) L.push(`- \`${e}\` —— ${exclusionInfo(e)?.reason ?? "按纳入策略排除"}`);
  }
  L.push("");

  L.push("## 6. 观测到的事实", "");
  if (s.observations.length === 0) {
    L.push("- 无额外观测记录（工作区形态见第 3 节）。");
  } else {
    for (const o of s.observations) L.push(`- [${o.source} · ${o.scope}] ${o.text}`);
  }
  L.push("");

  L.push("## 7. 接手纪律", "");
  if (inf?.sources?.length) L.push("", `本次推断用到的证据：${inf.sources.join(" · ")}。推断不等于事实：对不上就以代码与检查结果为准。`);
  L.push("- 不要重读源端的聊天记录，也不要先整仓扫描：第 2、3 节就是全部上下文。");
  L.push("- 不要把第 4 节的结论当本机已验证；跨环境时先复跑。");
  L.push("- 交接包按设计不可原地修改：发现对不上就重新创建一次交接，别改这个目录里的文件。");
  L.push("- 这个项目已经接了 ACB：`AGENTS.md` 里那段接入块与 `.acb/LATEST.md` 指针是给下一个 Agent 读的。轮到你要被换掉时**自己封存一次**（`acb.handoff_create`，`taskName` 可以留空），别把状态只留在聊天记录里。");
  L.push("");

  L.push("## 8. 机器可读的细节（人不必读）", "");
  L.push("- 完整状态：`acb-state/project-state.json`（观测/验证/声明的结构化记录、能力要求、快照身份）");
  L.push("- 包清单与逐文件 SHA-256：`manifest.json`");
  L.push("- 恢复材料：`payload/work/`（工作区版）、`payload/index/`（暂存版）、`payload/baseline.bundle`（基线历史）");
  L.push(`- 还原到别的目录时，那个目录里另有：\`ACB-HANDOFF.md\` 与 \`ACB-RESUME-REPORT.md\`（逐项对账：一致 / 变更 / 只在包里 / 只在目标）`);
  L.push(`- 快照 ${s.snapshotId} · 包内 ${rec.manifest.entries.length} 条目 · 协议 ${s.protocolVersion} · 工具 ${s.toolVersion}`);
  return L.join("\n");
}

export function renderReportMarkdown(r: ResumeReport): string {
  const L: string[] = [];
  L.push(`# 恢复报告 · ${r.handoffId}`, "");
  L.push(`> 总体判定：**${r.verdict}** · 代码恢复：${r.codeRestored ? "成功" : "失败"} · 指纹比对：${r.digestMatch === null ? "未执行" : r.digestMatch ? "一致 ✓" : "不一致 ✗"}`);
  L.push(`> 目标目录：\`${r.targetDir}\` · 恢复时间 ${r.at}`, "");
  if (r.entryCount !== undefined || r.restoredCount !== undefined) {
    L.push("## 完整性回执", "");
    if (r.entryCount !== undefined) L.push(`- 包清单条目：${r.entryCount} 个${r.verifiedCount !== undefined ? ` · 逐条 SHA-256 核对通过 ${r.verifiedCount} 个` : ""}`);
    if (r.restoredCount !== undefined) L.push(`- 写入目标目录：${r.restoredCount} 个文件`);
    if (r.baselineExpected !== undefined) L.push(`- 基线物化：应 ${r.baselineExpected} 个路径 · 实际写入 ${r.baselineWritten ?? 0} 个${r.baselineSkipped?.length ? ` · 未落地 ${r.baselineSkipped.length} 个` : ""}`);
    if (r.baselineSkipped?.length) for (const p of r.baselineSkipped.slice(0, 20)) L.push(`  - 未落地：${p}`);
    L.push("");
  }
  if (r.receipt) {
    const rc = r.receipt;
    L.push("## 逐项对账", "");
    L.push(`- 一致（目标里本来就有、逐字节相同）：${rc.identical} 项`);
    L.push(`- 变更（目标里内容不同、按「覆盖」策略替换）：${rc.overwritten} 项`);
    L.push(`- 只在包里（没有落到目标目录）：${rc.onlyInPackageCount} 项${rc.onlyInPackage.length ? ` —— ${rc.onlyInPackage.slice(0, 20).join("；")}` : ""}`);
    L.push(`- 只在目标（本机自己的文件，本次未触碰）：${rc.onlyInTargetCount} 项${rc.onlyInTarget.length ? ` —— ${rc.onlyInTarget.slice(0, 20).join("、")}` : ""}`);
    L.push(`- 空目录重建：${rc.emptyDirsRestored} 个`);
    L.push("", "以上四类的判据来自包内清单与目标目录的实测比对；「只在包里」不为空时说明这次还原并不完整，逐条给出原因。", "");
  }
  L.push("## 恢复步骤", "", ...r.steps.map((s) => `- [${s.ok ? "x" : " "}] ${s.title} — ${s.detail}`), "");
  if (r.gaps.length) {
    L.push("## 差异与补齐动作", "", ...r.gaps.map((g) => `- ${g.blocking ? "[阻塞]" : "[提示]"} [${g.kind}] ${g.title} — ${g.detail}`), "");
  }
  if (r.error) L.push("## 停止原因", "", `- ${r.error}`, "");
  return L.join("\n");
}

/** 观测/验证/声明的事实分离校验：验证结果不得从声明推断 */
export function summarizeVerify(records: VerificationRecord[]): { pass: number; fail: number; other: number } {
  const pass = records.filter((v) => v.result === "通过").length;
  const fail = records.filter((v) => v.result === "失败" || v.result === "超时" || v.result === "执行器错误").length;
  return { pass, fail, other: records.length - pass - fail };
}
