// Workflow Module：编排 捕获→(可选)推断→(可选)验证→封装→封存→项目侧接入；恢复是单独入口
import path from "node:path";
import { ProjectConfig } from "../../shared/types.js";
import { capture, Snapshot } from "./capture.js";
import { runChecks } from "./verify.js";
import { seal } from "./package.js";
import { validateState, renderEntryMarkdown } from "./protocol.js";
import { id, isGitRepo, gitStatus } from "./gitutil.js";
import { recoveryRequirements, fidelityScopePaths, pathFidelityBlockerMessage } from "./preview.js";
import { inferIntent } from "./infer.js";
import { tryInstallBridge, type BridgeOutcome } from "./bridge.js";
import { storeDir, saveHandoffRecord, loadHandoffRecords } from "./store.js";
import type { HandoffRecord, VerificationRecord, ProjectState } from "../../shared/types.js";

export interface CreateHandoffInput {
  /** 留空 = 用推断出来的任务名（分支名 / 最近提交） */
  taskName?: string;
  claimText?: string;
  claimEvidence?: string;
  nextStep?: string;
  runChecks?: boolean;
  parentHandoffIds?: string[];
  /** 打包前审阅清单时用户没确认过的阻塞项（如大小写碰撞）在此拦住 */
  onProgress?: (stage: string, pct: number, message: string) => void;
}

export interface CreateHandoffResult {
  record: HandoffRecord;
  snapshot: { id: string; digest: string; files: number; bytes: number };
  verifications: VerificationRecord[];
  warnings: string[];
  /** 项目侧接入结果（AGENTS.md 接入块 + .acb/LATEST.md 指针）：封存成功后 ACB 干了什么，如实报 */
  bridge: BridgeOutcome;
}

export async function createHandoff(cfg: ProjectConfig, input: CreateHandoffInput): Promise<CreateHandoffResult> {
  if (!(await isGitRepo(cfg.path))) {
    throw new Error(`目录不是 Git 仓库: ${cfg.path}（请先在「换项目 / 管理」里重新注册，或在本机 git init 后再来）`);
  }
  const warnings: string[] = [];
  const onProgress = input.onProgress;
  onProgress?.("捕获快照", 10, "正在扫描工作区");
  const snap: Snapshot = await capture(cfg.projectId, cfg.path, onProgress);

  // 推断先行：人什么都不写也能得到一份有内容的交接（这是本工具区别于"自己打提示词"的地方）
  onProgress?.("推断交接内容", 45, "正在从分支名、提交标题与 diff 里推断任务与进度");
  const inferred = await inferIntent(cfg.path, await gitStatus(cfg.path), snap.baselinePaths);
  const taskName = (input.taskName ?? "").trim() || inferred.taskName;
  if (!taskName) throw new Error("给不出任务名：既没填，分支名与提交标题也推不出来。出路：随便写一句你正在做的事。");

  // 路径形态判据与审阅清单共用同一份：改动 + 基线树一起看，
  // 否则"界面说阻塞、CLI/接口照样打出包"，而那个包在 Windows 上必然静默覆盖
  const blocker = pathFidelityBlockerMessage(fidelityScopePaths(snap.files.map((f) => f.path), snap.baselinePaths));
  if (blocker) throw new Error(blocker);

  let verifications: VerificationRecord[] = [];
  if (input.runChecks && cfg.checks.length > 0) {
    onProgress?.("执行检查", 55, `正在执行 ${cfg.checks.length} 条已配置检查（失败也会如实封存）`);
    const { records } = await runChecks(cfg.path, snap, cfg.checks, (i, total, name) =>
      onProgress?.("执行检查", 55 + Math.round((i / total) * 15), `检查 ${i + 1}/${total}：${name}`));
    verifications = records;
  } else if (input.runChecks && cfg.checks.length === 0) {
    warnings.push("项目未配置检查命令，验证状态保持为未执行；可在「换项目 / 管理」里添加后重试");
  }

  const taskId = "tsk_" + Buffer.from(taskName).toString("hex").slice(0, 8);
  const state: ProjectState = {
    protocolVersion: "0.1",
    projectId: cfg.projectId,
    projectName: cfg.name,
    taskId,
    taskName,
    sessionId: "sess_" + id("s").split("_")[1],
    snapshotId: snap.snapshotId,
    sourceDigest: snap.digest,
    handoffId: id("hnd"),
    parentHandoffIds: input.parentHandoffIds ?? [],
    createdAt: new Date().toISOString(),
    toolVersion: "acb 0.2.0",
    baseline: snap.baseline,
    changes: snap.files.map((f) => ({
      path: f.path, status: f.status, staged: f.indexContent !== null,
      oldPath: f.oldPath, mode: f.mode,
    })),
    untrackedIncluded: snap.files.filter((f) => f.status === "added").map((f) => f.path),
    excluded: snap.excluded,
    environment: { os: `${process.platform}`, runtime: `node ${process.version}`, git: ">=2.20" },
    observations: snap.observations,
    verifications,
    // 便签优先：上一个 Agent 自己写下的话，比任何推断都更接近它的意图
    claims: [
      ...(input.claimText
        ? [{ sessionId: "sess_web", at: new Date().toISOString(), text: input.claimText, nextStep: input.nextStep, evidence: input.claimEvidence }]
        : input.nextStep
          ? [{ sessionId: "sess_web", at: new Date().toISOString(), text: "（无工作声明）", nextStep: input.nextStep }]
          : []),
      ...(inferred.agentNote && !input.claimText
        ? [{ sessionId: "agent_note", at: new Date().toISOString(), text: inferred.agentNote.text.slice(0, 1200) }]
        : []),
    ],
    recoveryRequirements: recoveryRequirements(snap.excluded),
    capabilities: ["git"],
    emptyDirs: snap.emptyDirs,
    inferred: {
      taskSource: inferred.taskSource,
      progress: inferred.progress,
      nextSteps: inferred.nextSteps,
      ...(inferred.agentNote ? { agentNotePath: inferred.agentNote.path } : {}),
      acbOwnEdits: inferred.acbOwnEdits,
      sources: inferred.sources,
    },
  };

  const errs = validateState(state);
  if (errs.length) throw new Error("状态校验失败: " + errs.join("; "));

  onProgress?.("封装封存", 78, "正在写出包内材料与清单");
  const record = await seal(
    state,
    snap.files.map((f) => ({ path: f.path, workContent: f.workContent, indexContent: f.indexContent, mode: f.mode })),
    storeDir(cfg.path),
    cfg.path,
    onProgress,
  );
  await saveHandoffRecord(cfg.path, record);
  onProgress?.("接入项目", 96, "正在把交接指针写进项目，让下一个 Agent 自己读到");
  const bridge = await writeBridge(cfg, record);
  onProgress?.("完成", 99, "交接已封存");
  return {
    record,
    bridge,
    snapshot: {
      id: snap.snapshotId, digest: snap.digest, files: snap.files.length,
      bytes: snap.files.reduce((s, f) => s + f.bytes, 0),
    },
    verifications,
    warnings,
  };
}

export { renderEntryMarkdown };

/**
 * 把这次交接的指针写进项目本身：`<项目>/.acb/LATEST.md` 每次封存重写，`AGENTS.md` 里那段接入块
 * 只写一次。这一步失败不影响已经封好的包（包是不可变的，指针只是入口），所以只如实返回结果。
 */
async function writeBridge(cfg: ProjectConfig, record: HandoffRecord): Promise<BridgeOutcome> {
  const entry = path.join(record.packageDir, "HANDOFF.md");
  const records = await loadHandoffRecords(cfg.path).catch(() => [] as HandoffRecord[]);
  return await tryInstallBridge(cfg.path, {
    projectId: cfg.projectId,
    projectName: cfg.name,
    origin: "封存",
    handoffId: record.handoffId,
    taskName: record.state.taskName,
    sealedAt: record.sealedAt,
    entryRel: path.relative(cfg.path, entry),
    integrity: { entries: record.manifest.entries.length },
    history: records.slice(0, 5).map((r) => ({ handoffId: r.handoffId, taskName: r.state.taskName, sealedAt: r.sealedAt })),
  }, "封存");
}
