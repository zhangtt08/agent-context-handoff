// 接手视图（takeover）：让 Agent 一次调用就拿到"该做什么、看哪几个文件"，
// 而且**比直接把 HANDOFF.md 丢给它更省 token** —— 这是这个接口存在的唯一理由。
//
// 三条设计约束都来自那条判据：
//  1. 默认只回摘要（任务、改动路径、下一步、检查结论、需本机补齐的材料），
//     不回简报原文；要原文得显式 level=brief。
//  2. 字段名短、值不重复：不写 "handoffId"/"handoff_id" 两套，不在每个条目上重复同一个标签。
//  3. 列表截断必须带总数（n=），否则调用方以为"就这几个文件"，那比多花 token 更糟。
//
// 简报原文仍是**接手方读代码之前的唯一入口**：这里回的路径就是 .acb/LATEST.md 里那条，
// 两者同源（都从 HandoffRecord.packageDir 推出来），不会一个指新一个指旧。
import path from "node:path";
import { promises as fs } from "node:fs";
import { findProject, loadHandoffRecords, getHandoffRecord, listProjects } from "./store.js";
import { locateHandoff } from "./overview.js";
import { cliInvocation } from "./bridge.js";
import { resolveProjectDir } from "./gitutil.js";
import { assertSafeHandoffId } from "./arg-guard.js";
import type { HandoffRecord, ProjectConfig } from "../../shared/types.js";

export type TakeoverLevel = "summary" | "files" | "brief";

export interface TakeoverQuery {
  handoffId?: string;
  projectId?: string;
  /** 接手 Agent 的工作目录（含子目录）：最省事的一种问法，"我在这儿，我该接什么" */
  at?: string;
  level?: TakeoverLevel;
}

export class TakeoverNotFound extends Error {}
export class TakeoverAmbiguous extends Error {}

/**
 * 摘要里最多列几个文件。这个数就是"摘要有没有上界"的关键：简报会随改动数线性变长，
 * 摘要不会 —— 想看全部文件是 level=files 那一档的事。
 */
export const SUMMARY_FILE_CAP = 12;
const FILE_CAP = SUMMARY_FILE_CAP;

/**
 * token 估算（不是 tokenizer，是**可复算的度量**）：CJK 一字约 1 token，其余 4 字符约 1 token。
 * 用在一句人话里必须说"估算"，别装作是某个模型的精确计数 —— 精确值取决于接手方用哪个模型。
 */
const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uff00-\uffef]/;

export function estimateTokens(s: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of s) {
    if (CJK.test(ch)) cjk++;
    else if (!/\s/.test(ch)) other++;
  }
  return cjk + Math.ceil(other / 4);
}

/** 定位要交接的那一条：三种问法共用一份判据（REST、Agent 工具、CLI 都走这里） */
export async function resolveTakeover(q: TakeoverQuery): Promise<{ project: ProjectConfig; record: HandoffRecord; via: string }> {
  const hid = q.handoffId?.trim();
  if (hid) {
    const located = await locateHandoff(assertSafeHandoffId(hid));
    if (!located) throw new TakeoverNotFound(`没有这条交接：${hid}。出路：level=summary 不带 handoffId，用 at 或 projectId 取最新一条。`);
    return { project: located.project, record: located.record, via: "handoffId" };
  }
  const pid = q.projectId?.trim();
  if (pid) {
    const p = await findProject(pid);
    if (!p) throw new TakeoverNotFound(`项目未注册：${pid}。出路：acb.project_register {"path":"<项目目录>"}，或直接传 at=<项目目录>。`);
    const rec = await latest(p);
    return { project: p, record: rec, via: "projectId" };
  }
  const at = q.at?.trim();
  if (at) {
    const hit = await projectContaining(at);
    if (!hit) {
      const all = await listProjects();
      throw new TakeoverNotFound(
        `这个目录不属于任何已注册项目：${at}。出路：先注册（界面「换项目 / 管理」或 acb.project_register），`
        + `或从这些里面挑：${all.map((p) => `${p.projectId}=${p.path}`).join(" , ") || "（注册表为空）"}`,
      );
    }
    const rec = await latest(hit);
    return { project: hit, record: rec, via: "at" };
  }
  const all = await listProjects();
  if (all.length === 1) {
    const rec = await latest(all[0]);
    return { project: all[0], record: rec, via: "唯一注册项目" };
  }
  throw new TakeoverAmbiguous(
    `没说接手哪一条，本机注册了 ${all.length} 个项目。出路：传 at=<你现在的工作目录>（最省事）、projectId=<prj_…>，或 handoffId=<hnd_…>。`
    + `可选：${all.map((p) => `${p.projectId}=${p.name}`).join(" , ")}`,
  );
}

async function latest(p: ProjectConfig): Promise<HandoffRecord> {
  const rows = await loadHandoffRecords(p.path);
  const rec = rows[0];
  if (!rec) {
    throw new TakeoverNotFound(`项目「${p.name}」本机还没有封存交接。出路：让正在干活的 Agent 自己封存（acb.handoff_create，taskName 可留空），或在界面点「就这样，生成交接」。`);
  }
  return rec;
}

/** 最长前缀匹配：注册了 <repo> 与 <repo>/packages/x 时，从子目录问要拿到更近的那个 */
async function projectContaining(at: string): Promise<ProjectConfig | null> {
  const target = normalize(at);
  const all = await listProjects();
  let best: { p: ProjectConfig; len: number } | null = null;
  for (const p of all) {
    const root = normalize(p.path);
    if (target === root || target.startsWith(root + "/")) {
      if (!best || root.length > best.len) best = { p, len: root.length };
    }
  }
  return best?.p ?? null;
}

function normalize(p: string): string {
  try {
    return resolveProjectDir(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  } catch {
    return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  }
}

const ZH: Record<string, string> = { modified: "M", added: "A", deleted: "D", renamed: "R" };

/** 摘要视图：字段名短、值不重复；列表截断带总数 */
export function summaryView(project: ProjectConfig, record: HandoffRecord) {
  const s = record.state;
  const files = s.changes.slice(0, FILE_CAP).map((c) => ({
    p: c.path,
    s: ZH[c.status] ?? c.status,
    ...(c.staged ? { i: 1 } : {}),
    ...(c.mode === "120000" ? { l: 1 } : c.mode === "100755" ? { x: 1 } : {}),
    ...(c.oldPath ? { from: c.oldPath } : {}),
  }));
  const cli = cliInvocation();
  return {
    hnd: s.handoffId,
    task: s.taskName,
    proj: project.name,
    path: project.path,
    branch: s.baseline.branch ?? "(无分支)",
    commit: s.baseline.commit?.slice(0, 7) ?? null,
    digest: (s.sourceDigest.split("full:")[1] ?? s.sourceDigest).slice(0, 12),
    n: s.changes.length,
    files,
    more: s.changes.length > files.length ? s.changes.length - files.length : 0,
    next: (s.inferred?.nextSteps ?? []).slice(0, 6).map(short),
    said: s.claims.filter((c) => c.sessionId !== "sess_web" || c.nextStep).slice(0, 2)
      .map((c) => ({ who: c.sessionId === "agent_note" ? "上一个 Agent" : "人", t: short(c.text) })),
    checks: s.verifications.map((v) => ({ n: v.name, r: v.result, cmd: v.cmd })),
    need: s.recoveryRequirements,
    excluded: s.excluded.length,
    emptyDirs: s.emptyDirs?.length ?? 0,
    sealedAt: s.createdAt,
    // 相对路径：绝对路径里那串目录重复三遍，纯烧 token（path 字段已经给过一次了）
    brief: path.relative(project.path, path.join(record.packageDir, "HANDOFF.md")).replace(/\\/g, "/"),
    seal: cli ? `${cli.run} create ${project.projectId}` : null,
    note: "next=推断、checks=源端历史证据，都不等于本机已验证；全文用 level=brief",
  };
}

function short(t: string): string {
  const one = t.replace(/\s+/g, " ").trim();
  return one.length > 160 ? one.slice(0, 157) + "…" : one;
}

/** files 视图：只回答"我该打开哪几个文件"，这是最省的一档 */
export function filesView(record: HandoffRecord) {
  const s = record.state;
  return {
    hnd: s.handoffId,
    n: s.changes.length,
    files: s.changes.map((c) => (c.status === "renamed" && c.oldPath ? `${c.oldPath}→${c.path}` : c.path)),
  };
}

/** 原文视图：给没有文件系统访问的客户端用；同时把"这值多少钱"如实报出来 */
export async function briefView(record: HandoffRecord) {
  const file = path.join(record.packageDir, "HANDOFF.md");
  const text = await fs.readFile(file, "utf8").catch(() => null);
  if (text === null) throw new TakeoverNotFound(`读不到简报：${file}（包目录被移动过？出路：重新封存一次）`);
  return { hnd: record.state.handoffId, briefPath: file, bytes: Buffer.byteLength(text), tokens: estimateTokens(text), markdown: text };
}

export async function takeover(q: TakeoverQuery): Promise<Record<string, unknown>> {
  const { project, record, via } = await resolveTakeover(q);
  const level: TakeoverLevel = q.level ?? "summary";
  if (level === "brief") return { via, level, ...(await briefView(record)) };
  if (level === "files") return { via, level, ...filesView(record) };
  const body = summaryView(project, record);
  // 同一份数据到底省了多少：把估算值随答案一起给出，调用方不必自己算，我也没法拿话术糊过去
  const json = JSON.stringify(body);
  return { via, level, ...body, cost: { tokens: estimateTokens(json), briefTokens: estimateTokens(await mdOf(record)) } };
}

async function mdOf(record: HandoffRecord): Promise<string> {
  return await fs.readFile(path.join(record.packageDir, "HANDOFF.md"), "utf8").catch(() => "");
}
