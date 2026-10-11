/**
 * ACB Agent 能力注册表（契约：personal-agent-hub/docs/AGENT_API_STANDARD.md v1）。
 *
 * 三条硬规矩（改这里之前先读）：
 *  1. 每个 handler 调的都是本项目**已有的核心模块**（store / workflow / resume /
 *     verify / preview / package），与网页按同一个按钮走同一条代码路径。绝不在这里返回写死的
 *     样例数据 —— Agent 读到的数字必须和用户在界面上看到的是同一份。
 *  2. `input_schema` 就是公布出去的契约，schema.ts 的校验器直接读它（单一来源，不会漂移）。
 *  3. `risk` 如实标注：exec/destructive 一律要 `confirm:true`，缺了就在**这一份文件里**
 *     统一拒绝（executeAgentTool 里判一次），不指望每个 handler 自己记得。
 *
 * 只读面优先；写/exec 面只在"确实有用且明确设了闸门"的地方开：
 * 注册项目、封存交接、恢复、移除注册。删除真实数据（包目录、目标工作区）不暴露为工具。
 */
import path from "node:path";
import {
  listProjects, removeProject, findProject, loadHandoffRecords,
  loadResumeReports, storageNotices, registryPath, reportsPath,
} from "../core/store.js";
import { createHandoff } from "../core/workflow.js";
import { previewResume, performResume, type ResumeRequest } from "../core/resume-flow.js";
import { buildPreview } from "../core/preview.js";
import { takeover, TakeoverAmbiguous, TakeoverNotFound } from "../core/takeover.js";
import { getJob } from "../core/jobs.js";
import {
  buildProjectOverview, locateHandoff, measureIntegrity, requireGitProject,
  OverviewNotFound, HandoffNotFound,
} from "../core/overview.js";
import { registerProjectDir, saveProjectConfig, ProjectNotRegistered, type ConfigPatch } from "../core/registry.js";
import { UnsafeArgumentError } from "../core/arg-guard.js";
import { isGitRepo } from "../core/gitutil.js";
import { resolveBindHost } from "../core/local-guard.js";
import { AgentError } from "./errors.js";
import { validateAgentInput, type JsonSchema } from "./schema.js";

export const AGENT_PROJECT_ID = "acb";
export const AGENT_API_VERSION = 1;

export interface AgentContext {
  /** 服务进程启动时刻（uptime_ms 的分母，与 GET /api/health 同一口径） */
  bootedAt: number;
  /** 实际监听端口（Host/Origin 校验用的同一个值） */
  port: number;
}

export type AgentRisk = "read" | "write" | "exec" | "destructive";

export interface AgentTool {
  name: string;
  description: string;
  input_schema: JsonSchema;
  risk: AgentRisk;
  handler: (input: Record<string, unknown>, ctx: AgentContext) => Promise<unknown>;
  /**
   * 额外的确认判据：risk 是 read/write 但这次调用实质上写入了"以后会被执行的东西"时，
   * 由它把 confirm 要求补上（例：project_config_save 带 checks 参数）。
   * exec/destructive 不需要写它 —— executeAgentTool 无条件要求 confirm。
   */
  needsConfirm?: (input: Record<string, unknown>) => string | null;
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function str(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}
function reqStr(input: Record<string, unknown>, key: string): string {
  const v = str(input, key);
  if (!v) throw new AgentError("bad_input", `「${key}」不能为空`);
  return v;
}
function num(input: Record<string, unknown>, key: string): number | undefined {
  const v = input[key];
  return typeof v === "number" ? v : undefined;
}
function bool(input: Record<string, unknown>, key: string): boolean {
  return input[key] === true;
}

/** 列表截断：带 total 与 truncated，绝不悄悄砍掉一半让调用方以为是全量 */
function clip<T>(items: T[], max: number): { rows: T[]; total: number; truncated: boolean } {
  return { rows: items.slice(0, max), total: items.length, truncated: items.length > max };
}

const EMPTY_INPUT: JsonSchema = { type: "object", additionalProperties: false, properties: {}, required: [] };

/** 风险说明统一口径：读就是读，写会说什么被改了，exec/destructive 要点名 confirm */
function confirmNote(what: string): string {
  return `必须显式传 confirm:true 才会执行：${what}`;
}

/* ------------------------------------------------------------------ *
 * 只读面
 * ------------------------------------------------------------------ */

async function storageStatusHandler(_input: Record<string, unknown>, ctx: AgentContext) {
  let bind: string | null = null;
  try {
    bind = resolveBindHost();
  } catch {
    bind = null;      // 配置成了非回环地址：启动时已经拒绝，这里如实报"读不出来"
  }
  return {
    registry: registryPath(),
    resumeReports: reportsPath(),
    bind_host: bind,
    listening_port: ctx.port,
    /** 令牌只在服务进程的环境里，这里只回答"有没有启用"，绝不回显值 */
    local_token_required: Boolean(process.env.ACB_LOCAL_TOKEN?.trim()),
    /** 存储层读到过哪些坏文件（损坏时 API 也会带同一份警告，不会静默当成空库） */
    warnings: storageNotices(),
  };
}

async function projectsListHandler() {
  const list = await listProjects();
  // dirAvailable = 注册指向的目录还在且还是个 Git 工作区。没有这一栏时，"注册表里有 3 个
  // 项目"与"其中 2 个的文件夹早被挪走了"看起来一模一样，而调用方只有真去调详情才会撞上。
  const probed = await Promise.all(list.map(async (p) => ({
    projectId: p.projectId,
    name: p.name,
    path: p.path,
    dirAvailable: await isGitRepo(p.path),
    checksConfigured: p.checks?.length ?? 0,
  })));
  return {
    count: probed.length,
    unavailable: probed.filter((p) => !p.dirAvailable).map((p) => `${p.projectId} (${p.path})`),
    warnings: storageNotices().map((n) => `${n.file}：${n.reason}`),
    projects: probed,
  };
}

async function projectOverviewHandler(input: Record<string, unknown>) {
  return await buildProjectOverview(reqStr(input, "projectId"));
}

async function handoffsListHandler(input: Record<string, unknown>) {
  const projectId = reqStr(input, "projectId");
  const p = await findProject(projectId);
  if (!p) throw new AgentError("not_found", `项目未注册：${projectId}`, "先 acb.projects_list 看注册表里有什么");
  const limit = num(input, "limit") ?? 20;
  const records = await loadHandoffRecords(p.path);
  const rows = records.map((r) => ({
    handoffId: r.handoffId,
    taskName: r.state.taskName,
    sealedAt: r.sealedAt,
    changes: r.state.changes.length,
    sourceDigest: r.state.sourceDigest,
    briefPath: path.join(r.packageDir, "HANDOFF.md"),
    verifications: r.state.verifications.length,
    parentHandoffIds: r.state.parentHandoffIds,
  }));
  const c = clip(rows, Math.max(1, Math.min(200, limit)));
  return { projectId, projectName: p.name, ...c, note: c.truncated ? `共 ${c.total} 条，已截断到 ${c.rows.length} 条` : undefined };
}

async function handoffDetailHandler(input: Record<string, unknown>) {
  const located = await locateHandoff(reqStr(input, "handoffId"));
  if (!located) throw new AgentError("not_found", `交接不存在：${input.handoffId}`, "用 acb.handoffs_list 看本机注册项目各封存了哪些交接");
  const { record: r, project, children } = located;
  const s = r.state;
  return {
    handoffId: r.handoffId,
    project: { projectId: project.projectId, name: project.name, path: project.path },
    task: { taskId: s.taskId, taskName: s.taskName, sessionId: s.sessionId },
    sealedAt: r.sealedAt,
    createdAt: s.createdAt,
    baseline: s.baseline,
    sourceDigest: s.sourceDigest,
    changeCount: s.changes.length,
    changes: clip(s.changes, 200),
    excluded: clip(s.excluded, 100),
    recoveryRequirements: s.recoveryRequirements,
    verifications: s.verifications.map((v) => ({ name: v.name, result: v.result, exitCode: v.exitCode, durationMs: v.durationMs })),
    claims: s.claims,

    children,
    packageDir: r.packageDir,
    briefPath: path.join(r.packageDir, "HANDOFF.md"),
    environment: s.environment,
    capabilities: s.capabilities,
  };
}

async function handoffIntegrityHandler(input: Record<string, unknown>) {
  const located = await locateHandoff(reqStr(input, "handoffId"));
  if (!located) throw new AgentError("not_found", `交接不存在：${input.handoffId}`);
  return await measureIntegrity(located.record);
}

async function handoffPreviewHandler(input: Record<string, unknown>) {
  const projectId = reqStr(input, "projectId");
  // 与 REST 预览、总览同一个目录检查（server/core/overview.ts 的 requireGitProject）：
  // 目录已被移动/删除时要说得出是哪个路径，而不是让 git 在一个不存在的 cwd 上
  // 报一句 "spawn git ENOENT"（那句话点名的是 git，不是真正的原因）。
  const p = await requireGitProject(projectId);
  const full = await buildPreview(p);
  // 清单可能上万条：给总数与体积，逐条只给前 200，避免把调用方的上下文撑爆
  return {
    ...full,
    included: clip(full.included, 200),
    excluded: clip(full.excluded, 100),
    baselineSecrets: clip(full.baselineSecrets, 50),
    emptyDirs: clip(full.emptyDirs, 100),
  };
}

async function resumeReportsHandler(input: Record<string, unknown>) {
  const limit = num(input, "limit") ?? 20;
  const reports = await loadResumeReports();
  const rows = reports.map((r) => ({
    reportId: r.reportId,
    handoffId: r.handoffId,
    source: r.source,
    targetDir: r.targetDir,
    at: r.at,
    verdict: r.verdict,
    digestMatch: r.digestMatch,
    codeRestored: r.codeRestored,
    blockingGaps: r.gaps.filter((g) => g.blocking).map((g) => g.title),
    error: r.error,
  }));
  return clip(rows, Math.max(1, Math.min(100, limit)));
}

async function handoffTakeoverHandler(input: Record<string, unknown>) {
  // 与 REST 的 GET /api/handoff-brief 同一份判据（server/core/takeover.ts）：
  // 两处各写一遍"接手哪一条"，就会出现界面说接 A、Agent 调到 B。
  return await takeover({
    handoffId: str(input, "handoffId"),
    projectId: str(input, "projectId"),
    at: str(input, "at"),
    level: (str(input, "level") as "summary" | "files" | "brief" | undefined) ?? "summary",
  });
}

async function jobStatusHandler(input: Record<string, unknown>) {
  const j = getJob(reqStr(input, "jobId"));
  if (!j) throw new AgentError("not_found", `任务不存在或已过期（完成后保留 20 分钟）：${input.jobId}`, "重新发起一次即可，已封存的交接不受影响");
  return j;
}

/* ------------------------------------------------------------------ *
 * 写入面（gated）
 * ------------------------------------------------------------------ */

async function projectRegisterHandler(input: Record<string, unknown>) {
  const { config, alreadyRegistered, bridge } = await registerProjectDir(reqStr(input, "path"), str(input, "name"));
  return { registered: true, project: config, alreadyRegistered, bridge };
}

async function projectConfigSaveHandler(input: Record<string, unknown>) {
  const patch: ConfigPatch = { name: str(input, "name") };
  if (input.checks !== undefined) patch.checks = input.checks as unknown[];
  const project = await saveProjectConfig(reqStr(input, "projectId"), patch);
  return { saved: true, project };
}

async function handoffCreateHandler(input: Record<string, unknown>, ctx: AgentContext) {
  // 封存要在项目目录里跑 git，所以这里要的是同一道目录检查（不是"注册在不在"那么轻）
  const p = await requireGitProject(reqStr(input, "projectId"));
  // taskName 可省：留空就用 ACB 从分支名/提交标题/diff 推断出来的那一句。
  // 这一条是给"正在干活的 Agent 自己封存"用的 —— 它不该为了封存现编一句人类文案。
  const out = await createHandoff(p, {
    taskName: str(input, "taskName"),
    claimText: str(input, "claimText"),
    claimEvidence: str(input, "claimEvidence"),
    nextStep: str(input, "nextStep"),
    runChecks: bool(input, "runChecks"),
    parentHandoffIds: Array.isArray(input.parentHandoffIds) ? input.parentHandoffIds.filter((x): x is string => typeof x === "string") : [],
  });
  return {
    handoffId: out.record.handoffId,
    projectId: p.projectId,
    taskName: out.record.state.taskName,
    taskSource: out.record.state.inferred?.taskSource ?? "调用方给的任务名",
    briefPath: path.join(out.record.packageDir, "HANDOFF.md"),
    snapshot: out.snapshot,
    verifications: out.verifications.map((v) => ({ name: v.name, result: v.result, exitCode: v.exitCode })),
    warnings: out.warnings,
    packageDir: out.record.packageDir,
    sealedAt: out.record.sealedAt,
    /** 项目里因此多了什么：AGENTS.md 接入块与 .acb/LATEST.md 指针（下一个 Agent 自己读的地方） */
    bridge: out.bridge,
    uptimeMsOfService: Date.now() - ctx.bootedAt,
  };
}

function resumeRequestFrom(input: Record<string, unknown>): ResumeRequest {
  return {
    projectId: reqStr(input, "projectId"),
    handoffId: str(input, "handoffId"),
    targetDir: reqStr(input, "targetDir"),
    onConflict: (str(input, "onConflict") ?? "abort") as ResumeRequest["onConflict"],
  };
}

async function resumePreviewHandler(input: Record<string, unknown>) {
  return await previewResume(resumeRequestFrom(input));
}

async function resumeRestoreHandler(input: Record<string, unknown>) {
  const out = await performResume(resumeRequestFrom(input));
  return {
    reportId: out.report.reportId,
    verdict: out.report.verdict,
    digestMatch: out.report.digestMatch,
    codeRestored: out.report.codeRestored,
    targetDir: out.report.targetDir,
    taskName: out.taskName,
    steps: out.report.steps,
    gaps: out.report.gaps,
    error: out.report.error,
    /** 还原成功时在目标目录装好的接入块与指针（被阻塞的那次是 null，一个字节都没写） */
    bridge: out.bridge,
  };
}

async function projectRemoveHandler(input: Record<string, unknown>) {
  const projectId = reqStr(input, "projectId");
  const p = await findProject(projectId);
  if (!p) throw new AgentError("not_found", `项目未注册：${projectId}`);
  await removeProject(projectId);
  return { removed: true, projectId, name: p.name, path: p.path, note: "只移除注册表条目；项目目录与 <project>/.acb/store 里的交接包一个字节都没动，重新注册即可再看" };
}

/* ------------------------------------------------------------------ *
 * 注册表
 * ------------------------------------------------------------------ */

export const AGENT_TOOLS: AgentTool[] = [
  {
    name: "acb.storage_status",
    description:
      "什么时候用：怀疑「看到的数据是空的/不对」时先看这一条。返回注册表与报告文件路径、实际绑定的回环地址与端口、是否要求本机令牌、以及存储层读到过的坏文件警告（损坏的文件只会被降级成空清单并点名，不会静默）。不写任何东西。",
    risk: "read",
    input_schema: EMPTY_INPUT,
    handler: storageStatusHandler,
  },
  {
    name: "acb.projects_list",
    description: "什么时候用：要知道本机有哪些项目可以交接（这是找 projectId 的第一站）。返回每个项目的 id、名称、目录、已配置检查条数，以及目录还在不在（注册表里的项目可能被移动过）。数据来自 ~/.acb/projects.json。",
    risk: "read",
    input_schema: EMPTY_INPUT,
    handler: projectsListHandler,
  },
  {
    name: "acb.project_overview",
    description: "什么时候用：要看某个项目当前 Git 状态与交接概况。返回分支/提交、脏工作区计数（含排除策略）、任务分组、最近 10 条交接、分叉列表。与首页状态条同源同算法。",
    risk: "read",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: { projectId: { type: "string", minLength: 1, maxLength: 200, description: "项目 id（acb.projects_list 里的 projectId）或项目目录绝对路径" } },
      required: ["projectId"],
    },
    handler: projectOverviewHandler,
  },
  {
    name: "acb.handoffs_list",
    description: "什么时候用：列出某项目本机封存的交接（id、任务名、封存时间、改动条数、简报路径、验证条数、父交接）。分页上限 200。",
    risk: "read",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        projectId: { type: "string", minLength: 1, maxLength: 200, description: "项目 id" },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 20, description: "最多返回多少条" },
      },
      required: ["projectId"],
    },
    handler: handoffsListHandler,
  },
  {
    name: "acb.handoff_detail",
    description: "什么时候用：要接手某条交接。返回任务与声明、基线、改动清单（截断到 200 并给总数）、排除项与恢复要求、验证记录、子交接、包目录与简报路径。",
    risk: "read",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: { handoffId: { type: "string", minLength: 1, maxLength: 100, description: "交接 id（hnd_…）" } },
      required: ["handoffId"],
    },
    handler: handoffDetailHandler,
  },
  {
    name: "acb.handoff_takeover",
    description:
      "接手第一条：一次拿到任务、该看哪几个文件、下一步、检查结论、需本机补齐的材料（比读 HANDOFF.md 省 token）。"
      + "at=<工作目录> 或 projectId / handoffId；level=summary|files|brief。",
    risk: "read",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        at: { type: "string", maxLength: 500, description: "接手方所在目录（可以是子目录）" },
        projectId: { type: "string", maxLength: 200, description: "项目 id" },
        handoffId: { type: "string", maxLength: 100, description: "指定某条交接" },
        level: { type: "string", enum: ["summary", "files", "brief"], default: "summary", description: "要多少：摘要 / 只要文件清单 / 简报全文" },
      },
      required: [],
    },
    handler: handoffTakeoverHandler,
  },
  {
    name: "acb.handoff_integrity",
    description: "什么时候用：接手前确认包没坏。逐条比对 manifest.json 里每个文件的 SHA-256，返回条目数/通过数/坏条目。只读磁盘。",
    risk: "read",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: { handoffId: { type: "string", minLength: 1, maxLength: 100, description: "交接 id" } },
      required: ["handoffId"],
    },
    handler: handoffIntegrityHandler,
  },
  {
    name: "acb.handoff_preview",
    description: "什么时候用：封存前看清「会带哪些文件、为什么排除某些文件、有什么阻塞项」。跑的是打包前审阅清单（只探测磁盘，不写文件）。长列表按 200/100/50 截断并给总数。",
    risk: "read",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: { projectId: { type: "string", minLength: 1, maxLength: 200, description: "项目 id" } },
      required: ["projectId"],
    },
    handler: handoffPreviewHandler,
  },
  {
    name: "acb.resume_reports",
    description: "什么时候用：想知道上一次把交接还原到某个目录时恢复到什么程度、还缺什么。返回恢复报告列表（结论、指纹是否一致、阻塞项、错误）。默认 20 条，上限 100。",
    risk: "read",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: { limit: { type: "integer", minimum: 1, maximum: 100, default: 20, description: "最多返回多少条报告" } },
      required: [],
    },
    handler: resumeReportsHandler,
  },
  {
    name: "acb.job_status",
    description: "什么时候用：封存有异步版本（POST /api/projects/:id/handoffs?async），进度靠 jobId 查。返回阶段、百分比、消息、结果或失败原因。",
    risk: "read",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: { jobId: { type: "string", minLength: 1, maxLength: 100, description: "任务 id（job_…）" } },
      required: ["jobId"],
    },
    handler: jobStatusHandler,
  },
  {
    name: "acb.project_register",
    description: "什么时候用：要把一个本地 Git 仓库登记进 ACB。与界面「选择文件夹」和 CLI 的 register 走同一条路径：会做工作区/裸仓库判定，误选 .git 时自动改用项目根。除注册表条目外还会在项目里写两样东西：<项目>/.acb/LATEST.md（交接指针）与 AGENTS.md 里那段 ACB 接入块（项目不存在该文件时才新建，存在就只在末尾补一段，标记之间的内容才归 ACB 管）。想完全不碰 AGENTS.md：先建一个空文件 <项目>/.acb/NO-BRIDGE 再注册。",
    risk: "write",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string", minLength: 1, maxLength: 500, description: "项目根目录绝对路径（必须是 Git 工作区）" },
        name: { type: "string", minLength: 1, maxLength: 120, description: "显示名；留空取目录名" },
      },
      required: ["path"],
    },
    handler: projectRegisterHandler,
  },
  {
    name: "acb.project_config_save",
    description:
      "什么时候用：改项目名，或配置检查命令。注意 checks[].cmd 是「以后会被执行的内容」，所以带 checks 时必须显式 confirm:true（这是本项目唯一的命令执行入口，界面里就是右上角「换项目 / 管理」）。",
    risk: "write",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        projectId: { type: "string", minLength: 1, maxLength: 200, description: "项目 id" },
        name: { type: "string", minLength: 1, maxLength: 120, description: "新的显示名（可省）" },
        checks: {
          type: "array",
          maxItems: 50,
          description: "检查命令清单；每条 {name,cmd,timeoutMs?}",
          items: {
            type: "object",
            properties: {
              name: { type: "string", minLength: 1, maxLength: 120 },
              cmd: { type: "string", minLength: 1, maxLength: 2000 },
              timeoutMs: { type: "integer", minimum: 1, maximum: 600000 },
            },
            required: ["name", "cmd"],
            additionalProperties: false,
          },
        },
        confirm: { type: "boolean", description: "带 checks（写入会被执行的命令）时必须为 true" },
      },
      required: ["projectId"],
    },
    needsConfirm: (input) => {
      // 空串在 schema 校验阶段就按"未填"处理，所以这里只会收到非空 checks；
      // 写入待执行命令是唯一需要额外确认的情形
      if (input.checks !== undefined) return "这次调用要写入的检查命令以后会在检查阶段被执行";
      return null;
    },
    handler: projectConfigSaveHandler,
  },
  {
    name: "acb.handoff_preview_resume",
    description: "什么时候用：把本机某次封存还原到别的目录之前，先看清会发生什么（整包校验 + 与目标目录比对）。一个字节都不写用户目录，是还原前的必读一步。",
    risk: "read",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        projectId: { type: "string", minLength: 1, maxLength: 200, description: "交接封存在哪个项目里" },
        handoffId: { type: "string", maxLength: 100, description: "留空 = 该项目最新一条封存" },
        targetDir: { type: "string", minLength: 1, maxLength: 500, description: "目标目录（推荐空目录）" },
        onConflict: { type: "string", enum: ["abort", "skip", "overwrite"], default: "abort", description: "撞车策略，默认不覆盖" },
      },
      required: ["projectId", "targetDir"],
    },
    handler: resumePreviewHandler,
  },
  {
    name: "acb.handoff_create",
    description:
      "把当前脏工作区封存成不可变交接包（也可由正在干活的 Agent 在被换掉前自己调用）。"
      + "taskName 可留空，用 ACB 从分支名/提交标题/diff 推断的结果。"
      + confirmNote("写 <project>/.acb/store 下的包目录与记录，并可能更新项目根 AGENTS.md 里 ACB 自己那一段；runChecks 时执行项目配置的命令") + "。",
    risk: "exec",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        projectId: { type: "string", minLength: 1, maxLength: 200, description: "项目 id" },
        taskName: { type: "string", maxLength: 200, description: "一句下一个 Agent 能看懂的话；留空 = 用 ACB 推断出来的任务名" },
        claimText: { type: "string", maxLength: 2000, description: "工作声明（可省）" },
        claimEvidence: { type: "string", maxLength: 2000, description: "证据说明（可省）" },
        nextStep: { type: "string", maxLength: 2000, description: "建议下一步（可省）" },
        runChecks: { type: "boolean", default: false, description: "是否执行已配置检查（失败也如实封存）" },
        parentHandoffIds: { type: "array", maxItems: 20, items: { type: "string", maxLength: 100 }, description: "父交接 id" },
        confirm: { type: "boolean", description: "必须为 true：确认封存交接（必要时含执行检查）" },
      },
      required: ["projectId"],
    },
    handler: handoffCreateHandler,
  },
  {
    name: "acb.resume_restore",
    description: `什么时候用：把交接恢复到目标目录（先整包校验，再重建基线，再分别恢复暂存与工作区）。${confirmNote("会向目标目录写文件；onConflict=overwrite 还会替换目标里已有的同名文件——默认 abort 会在非空目录前停下")}`,
    risk: "destructive",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        projectId: { type: "string", minLength: 1, maxLength: 200, description: "交接封存在哪个项目里" },
        handoffId: { type: "string", maxLength: 100, description: "留空 = 该项目最新一条封存" },
        targetDir: { type: "string", minLength: 1, maxLength: 500, description: "目标目录" },
        onConflict: { type: "string", enum: ["abort", "skip", "overwrite"], default: "abort", description: "撞车策略" },
        confirm: { type: "boolean", description: "必须为 true：确认写目标目录" },
      },
      required: ["projectId", "targetDir"],
    },
    handler: resumeRestoreHandler,
  },
  {
    name: "acb.project_remove",
    description: `什么时候用：不再跟踪某个项目。${confirmNote("会从注册表里移除这一条（项目目录与 <project>/.acb/store 里的交接包不动，重新注册即可再看）")}`,
    risk: "destructive",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        projectId: { type: "string", minLength: 1, maxLength: 200, description: "项目 id" },
        confirm: { type: "boolean", description: "必须为 true：确认从注册表移除" },
      },
      required: ["projectId"],
    },
    handler: projectRemoveHandler,
  },
];

export function listAgentTools(): { name: string; description: string; input_schema: JsonSchema; risk: AgentRisk }[] {
  return AGENT_TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema, risk: t.risk }));
}

/** 服务内部用的名字集合：路由层据此判断"这个工具存在吗" */
export function agentToolNames(): string[] {
  return AGENT_TOOLS.map((t) => t.name);
}

/**
 * POST /api/agent/tool 的唯一执行入口：查名字 → 按公布的 schema 校验 → confirm 闸门 → 调真实能力。
 *
 * confirm 闸门放在这里而不是每个 handler 里：新增一个 exec 工具时"忘记要求确认"
 * 是最危险的失效方式，而它恰好没人会注意到。集中判一次，就少一处会腐烂的地方。
 */
export async function executeAgentTool(
  toolName: unknown,
  rawInput: unknown,
  ctx: AgentContext,
): Promise<{ tool: string; risk: AgentRisk; data: unknown }> {
  if (typeof toolName !== "string" || !toolName.trim()) {
    throw new AgentError(
      "bad_input",
      '请求体必须形如 {tool:"acb.projects_list",input:{…}}；tool 字段缺失或不是字符串。',
      "先 GET /api/agent/tools 拿准确的工具名与 input_schema。",
    );
  }
  const tool = AGENT_TOOLS.find((t) => t.name === toolName);
  if (!tool) {
    throw new AgentError(
      "unknown_tool",
      `没有名为「${toolName}」的工具。本机可用：${AGENT_TOOLS.map((t) => t.name).join(", ")}`,
      "工具名带 acb. 前缀，清单来自 GET /api/agent/tools。",
    );
  }
  const input = validateAgentInput(tool.input_schema, rawInput);

  const needReason = tool.risk === "exec" || tool.risk === "destructive"
    ? `这是 ${tool.risk} 工具`
    : tool.needsConfirm?.(input) ?? null;
  if (needReason && input.confirm !== true) {
    throw new AgentError(
      "confirm_required",
      `「${tool.name}」需要显式确认：${needReason}，而本次 input 里没有 confirm:true。`,
      `确实要做就再调一次并把 confirm 设为 true：{"tool":"${tool.name}","input":{…"confirm":true}}。想先看清后果请用只读工具（如 acb.handoff_preview_resume / acb.handoff_preview）。`,
    );
  }

  let data: unknown;
  try {
    data = await tool.handler(input, ctx);
  } catch (e) {
    if (e instanceof AgentError) throw e;
    throw classifyCoreError(e);
  }
  return { tool: tool.name, risk: tool.risk, data };
}

/**
 * 核心模块抛的错 → 契约错误码。判据首先是**类型**，不是中文句子正则：
 * 未注册/找不到是调用方能自己修好的（not_found），git 参数白名单命中是 bad_input，
 * 其余（磁盘炸了、git 崩了、代码有缺陷）才是 internal_error/500。
 * 只有一类兜底仍按文本判：本项目给人看的失败一律带"出路："（见各核心模块与 remedy），
 * 那是"你可以照这句话改输入"的意思，不是服务器坏了。
 */
export function classifyCoreError(e: unknown): AgentError {
  if (e instanceof AgentError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  if (e instanceof TakeoverAmbiguous || e instanceof UnsafeArgumentError) return new AgentError("bad_input", msg);
  if (e instanceof OverviewNotFound || e instanceof HandoffNotFound || e instanceof ProjectNotRegistered
    || e instanceof TakeoverNotFound) {
    return new AgentError("not_found", msg);
  }
  if (/出路[：:]/.test(msg)) return new AgentError("bad_input", msg);
  return new AgentError("internal_error", `工具执行失败：${msg}`);
}
