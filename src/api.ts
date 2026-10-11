// 前端 API 层：与本地 ACB 服务通信，类型与后端共享
import type {
  ProjectConfig, HandoffRecord, ResumeReport,
  VerificationRecord, CapturePreview, ResumePreview, JobView, ConflictPolicy,
  PreviewAlert, PreviewFile, PreviewExclusion, ResumeConflict, BridgeOutcome,
} from "../shared/types.js";

const BASE = "/api";

// Electron 桌面壳经 preload 注入的原生对话框与拖放路径解析（浏览器端不存在，用可选属性降级）
declare global {
  interface Window {
    acb?: {
      platform?: string;
      pickFolder?: () => Promise<string | null>;
      getPathForFile?: (file: File) => string;
      /** 用系统默认程序打开本机文件或目录；失败回中文原因 */
      openPath?: (p: string) => Promise<string | null>;
      /** 自绘标题栏的窗口三键（frameless 窗口用，浏览器端不存在） */
      windowControls?: {
        minimize: () => Promise<void>;
        toggleMaximize: () => Promise<boolean>;
        close: () => Promise<void>;
        isMaximized: () => Promise<boolean>;
        onMaximizedChange: (cb: (maximized: boolean) => void) => () => void;
      };
    };
  }
}

/** 桌面壳注入的窗口三键；浏览器端返回 undefined */
export function windowControls(): NonNullable<Window["acb"]>["windowControls"] {
  return window.acb?.windowControls;
}

/** 桌面壳报告的平台；浏览器端返回 undefined（macOS 用系统红绿灯，不渲染自绘三键） */
export function desktopPlatform(): string | undefined {
  return window.acb?.platform;
}

/** 从拖放的 File 取本机路径；非桌面版或取不到时返回 null */
export function pathFromDrop(file: File | undefined | null): string | null {
  const p = file && window.acb?.getPathForFile?.(file);
  return p ? p : null;
}

/**
 * 复制到剪贴板，返回 "已复制" 或一句人话原因。
 * 剪贴板 API 在非安全上下文（比如手工用 IP 访问）会直接不存在或抛错，
 * 这里退回选中文本 + execCommand —— 复制按钮现在只是**备用出口**（主出口是项目里的
 * ACB 接入块：Agent 自己读到，不需要有人粘贴），但一旦它出现在页面上就必须真的能复制。
 */
export async function copyText(text: string): Promise<string> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return "已复制";
    }
  } catch { /* 落到下面的退回路径 */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;opacity:0;top:0;left:0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok ? "已复制" : "复制失败：请在本页文本框里手动全选复制";
  } catch {
    return "复制失败：请在本页文本框里手动全选复制";
  }
}

/** 服务在不在，决定错误提示该说什么：本地 API 掉了要指回启动入口，而不是丢一句 JSON 解析失败 */
async function j<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(BASE + url, { headers: { "Content-Type": "application/json" }, ...init });
  } catch {
    throw new Error("连不上本地 ACB 服务。出路：双击 ACB.exe 重新打开本工具；开发模式请在项目目录跑 npm run dev（API 在 :5174）。");
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`服务返回的不是 JSON（HTTP ${res.status}）。出路：确认只有一个 ACB 服务在跑；开发模式下 /api 需要代理到 :5174。`);
  }
  if (!res.ok) {
    const e = (data as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
    throw new Error(e);
  }
  return data as T;
}

export const api = {
  listProjects: () => j<ProjectConfig[]>("/projects"),
  registerProject: (path: string, name?: string) =>
    j<ProjectConfig & { alreadyRegistered?: boolean; bridge?: BridgeOutcome }>("/projects", { method: "POST", body: JSON.stringify({ path, name }) }),
  removeProject: (id: string) => j<{ ok: boolean }>(`/projects/${id}`, { method: "DELETE" }),
  seedDemo: () => j<ProjectConfig & { bridge?: BridgeOutcome }>("/demo/seed", { method: "POST" }),

  overview: (id: string) => j<Overview>(`/projects/${id}/overview`),
  config: (id: string) => j<ProjectConfig>(`/projects/${id}/config`),
  saveConfig: (id: string, patch: Partial<Pick<ProjectConfig, "checks" | "name">>) =>
    j<ProjectConfig>(`/projects/${id}/config`, { method: "PUT", body: JSON.stringify(patch) }),

  /** 打包前审阅清单（只探测磁盘，不写文件） */
  preview: (id: string) => j<CapturePreview>(`/projects/${id}/preview`),
  /** 异步打包：立即拿 jobId，进度走 job() */
  createHandoff: (id: string, input: {
    /** 留空 = 用 ACB 从分支名与提交标题推断出来的任务名 */
    taskName?: string; claimText?: string; claimEvidence?: string; nextStep?: string;
    runChecks?: boolean; parentHandoffIds?: string[];
  }) => j<{ jobId: string }>(`/projects/${id}/handoffs`, { method: "POST", body: JSON.stringify({ ...input, async: true }) }),

  job: (jobId: string) => j<JobView>(`/jobs/${jobId}`),
  integrity: (id: string) => j<{ handoffId: string; ok: boolean; entryCount: number; verifiedCount: number; broken: string[]; label: string }>(`/handoffs/${id}/integrity`),

  handoff: (id: string) => j<{ record: HandoffRecord; project: ProjectConfig; children: string[] }>(`/handoffs/${id}`),

  /** 还原前预览：目标目录撞了什么、包里有什么、完整性如何 */
  resumePreview: (input: ResumeInput) => j<ResumePreview>(
    "/resume/preview", { method: "POST", body: JSON.stringify(input) }),
  resume: (input: ResumeInput) =>
    j<{ report: ResumeReport; taskName?: string; bridge?: BridgeOutcome | null } | { jobId: string }>("/resume", { method: "POST", body: JSON.stringify({ ...input, async: true }) }),
  resumeReports: () => j<ResumeReport[]>("/resume/reports"),
};

export interface ResumeInput {
  projectId: string;
  /** 留空 = 该项目最新一条封存 */
  handoffId?: string;
  targetDir: string;
  onConflict?: ConflictPolicy;
}

/** 轮询作业直到结束：一次一跳，服务挂了也能退出而不是永远转圈 */
export async function waitJob(jobId: string, onTick?: (j: JobView) => void, timeoutMs = 30 * 60_000): Promise<JobView> {
  const started = Date.now();
  for (;;) {
    const view = await api.job(jobId);
    onTick?.(view);
    if (view.state !== "进行中") return view;
    if (Date.now() - started > timeoutMs) {
      throw new Error("任务超过 30 分钟仍未结束。出路：确认磁盘与 git 还在工作（大仓库的 bundle 可能很慢），或换一个更小的范围先提交一次。");
    }
    await new Promise((r) => setTimeout(r, 350));
  }
}

/** 把作业结果收成可用类型 */
export function jobResult<T>(view: JobView): T {
  if (view.state !== "完成") throw new Error(view.error ?? view.message);
  return view.result as T;
}

// ---- Overview 数据形状（与后端 /projects/:id/overview 对齐） ----
export interface OverviewTask {
  taskId: string;
  taskName: string;
  status: string;
  latestHandoff: string;
  handoffTime: string;
  handoffs: { id: string; at: string }[];
}
export interface OverviewHandoff {
  handoffId: string;
  taskName: string;
  sealedAt: string;
  snapshot: string;
  verify: { label: string; tone: string };
  briefPath: string;
}
export interface Overview {
  config: ProjectConfig;
  branch: string | null;
  commit: string | null;
  dirty: {
    staged: number; unstaged: number; untracked: number; total: number;
    excluded: { label: string; reason: string; kind: string }[];
    env: { os: string; node: string };
  };
  stats: { changes: number; activeTasks: number; forks: number; failedChecks: number };
  tasks: OverviewTask[];
  handoffs: OverviewHandoff[];
  forksList: { parent: string; children: string[] }[];
}
export interface CreateResult {
  record: HandoffRecord;
  snapshot: { id: string; digest: string; files: number; bytes: number };
  verifications: VerificationRecord[];
  warnings: string[];
  /** 这次在项目里写了什么（AGENTS.md 接入块 + .acb/LATEST.md 指针） */
  bridge: BridgeOutcome;
}

/** 接入块这一步的人话结论：写了/追加/没动/为什么没动，界面和 CLI 说同一句话 */
export function bridgeLineZh(b: BridgeOutcome | null | undefined): string {
  if (!b) return "";
  const latestZh = { created: "已写入指针", updated: "已重写指针", unchanged: "指针内容没变" }[b.latest];
  if (b.agents === "skipped") return `没有改 AGENTS.md —— ${b.reason ?? "按约定跳过"}（${latestZh}）`;
  const verb = b.agents === "created" ? `新写入 ${b.blockLines} 行接入块`
    : b.agents === "appended" ? `在原有内容后追加 ${b.blockLines} 行接入块`
    : b.agents === "updated" ? "更新了接入块" : "接入块已在项目里，未改动";
  return `${verb} · ${latestZh}`;
}

/**
 * 交给"当前这个 Agent"的话（备用出口）：让它把意图写进 .acb/NEXT.md，再由人点一下生成交接。
 * 主出口是项目里的接入块 —— 它已经写了同样这件事，所以这个按钮只是"催一下"。
 */
export function outgoingAgentPrompt(projectPath: string): string {
  const note = projectPath.replace(/\\/g, "/").replace(/\/+$/, "") + "/.acb/NEXT.md";
  return [
    `你在接手维护这个项目：${projectPath}`,
    "你即将被换掉（额度、上下文或订阅切换）。请把你脑子里的信息落到一个文件里，别留在聊天记录里：",
    note,
    "内容四段，每段一两行，写给一个完全没有上下文的 Agent 看：",
    "1) 目标：这次到底要做完什么，怎样算完成；",
    "2) 已完成：改了哪些文件、为什么这么改（写相对路径）；",
    "3) 下一步：它该先动哪个文件、注意什么坑；",
    "4) 别碰：不要改的文件/目录、不要动的依赖、不要重跑的耗时命令。",
    "写完这个文件就停下，不要再改业务代码。",
    "然后二选一：能调用 ACB 的 Agent 工具（acb.handoff_create）就直接自己封存；不能就让人在 ACB 里点一下「就这样，生成交接」。",
  ].join("\n");
}

export function fmtTime(iso: string): string {
  const d = new Date(iso);
  const now = Date.now();
  const diff = (now - d.getTime()) / 1000;
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  return d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function shortDigest(s: string): string {
  const full = s.split("full:")[1];
  if (!full) return s;
  return `src_sha256:${full.slice(0, 12)}…${full.slice(-4)}`;
}

/**
 * 交给下一个 Agent 的话（备用出口，用在没有 AGENTS.md 约定的客户端里）。
 * 只要求读一份简报，明确禁止重读聊天记录与整仓扫描 —— 这正是用户要解决的 token 消耗问题。
 */
export function agentPrompt(briefPath: string, taskName: string, restoredDir?: string): string {
  const where = restoredDir ? `项目目录：${restoredDir}\n` : "";
  return [
    `接手一个做到一半的任务：「${taskName}」。`,
    where + `进度、改动清单、已有证据和下一步都在这一份交接简报里，请先只读它：`,
    briefPath,
    `要求：`,
    `1. 不要重读历史聊天记录，也不要先整仓扫描；需要看代码时只打开简报「改动清单」里列出的文件。`,
    `2. 按简报「建议下一步」继续做；阻塞项和需本机补齐的材料已写在简报里，缺就直接问我。`,
    `3. 简报里的检查结论是上一个 Agent 的历史证据，不算本机结果；要继续前在本机复跑一次检查。`,
    `4. 读完先用 3 行以内复述：任务目标 / 现在到哪了 / 你打算做什么，确认无误再动手。`,
  ].join("\n");
}

export type {
  HandoffRecord, ProjectConfig, ResumeReport, VerificationRecord,
  CapturePreview, ResumePreview, JobView, PreviewAlert, PreviewFile, PreviewExclusion, ResumeConflict, ConflictPolicy,
  BridgeOutcome,
};
