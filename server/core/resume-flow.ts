// 恢复流程：REST 路由（POST /api/resume/preview、POST /api/resume）与 Agent 工具
// （acb.handoff_preview_resume / acb.resume_restore）共用这一份"定位封存包 → 执行 → 落报告"。
//
// 为什么必须共用：预览说"会写 12 个文件"而恢复实际写了 11 个，是因为两条路径各自认了一次源。
// 这一类"同一个事实两个算法"的分叉曾经让恢复静默丢掉文件而回执全绿，别再开第二份。
import { findProject, loadHandoffRecords, getHandoffRecord, saveResumeReport } from "./store.js";
import { restorePackage, previewPackageResume } from "./resume.js";
import { tryInstallBridge, type BridgeOutcome } from "./bridge.js";
import { resolveProjectDir } from "./gitutil.js";
import { assertNoControl, assertSafeHandoffId } from "./arg-guard.js";
import type { ConflictPolicy, ProjectConfig, ResumePreview, ResumeReport } from "../../shared/types.js";

export interface ResumeRequest {
  /** 交接封存在哪个项目里 */
  projectId: string;
  /** 留空 = 该项目最新一条封存 */
  handoffId?: string;
  targetDir: string;
  onConflict?: ConflictPolicy;
}

export interface ResolvedPackage {
  packageDir: string;
  handoffId: string;
  targetDir: string;
  source: string;
  onConflict?: ConflictPolicy;
}

/** 找到本机封存存储里的那条交接（唯一的源：项目目录下的 .acb/store/handoffs/<id>） */
export async function resolveRestoreSource(b: ResumeRequest): Promise<{ pkg: ResolvedPackage; project: ProjectConfig }> {
  if (!b.projectId) throw new Error("缺少项目：先注册并选择要接手的项目");
  const p = await findProject(b.projectId);
  if (!p) throw new Error(`项目未注册：${b.projectId}（在「换项目 / 管理」里重新注册该项目目录）`);
  if (!b.targetDir?.trim()) throw new Error("缺少目标目录：写一个新目录的路径（ACB 默认不覆盖已有工作）");
  const targetDir = resolveProjectDir(assertNoControl(b.targetDir.trim(), "targetDir"));

  const hid = b.handoffId?.trim() || (await loadHandoffRecords(p.path))[0]?.handoffId;
  if (!hid) throw new Error(`项目「${p.name}」本机还没有封存过交接：先在「① 交出去」生成一次`);
  // handoffId 会被拼进 <project>/.acb/store/handoffs/<id>/ —— 先按 ID 形态判死，
  // 否则 ?handoffId=../../.. 就是拿着本机服务的钥匙去读注册表外面的文件
  const safeHid = assertSafeHandoffId(hid);
  const rec = await getHandoffRecord(p.path, safeHid);
  if (!rec) throw new Error(`本机封存存储里没有这条交接 ${safeHid}：确认选对项目，或重新创建一次交接`);

  return {
    pkg: { packageDir: rec.packageDir, handoffId: safeHid, targetDir, source: `本机封存 · ${p.name}/${safeHid}`, onConflict: b.onConflict },
    project: p,
  };
}

/** 还原前的差异预览：整包校验 + 与目标目录比对，不写任何用户目录 */
export async function previewResume(b: ResumeRequest): Promise<ResumePreview> {
  const { pkg } = await resolveRestoreSource(b);
  return previewPackageResume(pkg);
}

/** 真正动手恢复并落 Resume Report（报告是恢复的一部分，不是调用方的作业） */
export async function performResume(
  b: ResumeRequest,
  onProgress?: (stage: string, pct: number, message: string) => void,
): Promise<{ report: ResumeReport; taskName: string; bridge: BridgeOutcome | null }> {
  const { pkg, project } = await resolveRestoreSource(b);
  const r = await restorePackage({ ...pkg, ...(onProgress ? { onProgress } : {}) });
  await saveResumeReport(r.report);
  // 只有真写了代码才在目标目录装接入块：被阻塞的那次一个字节都没落盘，也不该去改别人的目录
  const bridge = r.report.codeRestored
    ? await tryInstallBridge(r.report.targetDir, {
        projectId: project.projectId,
        projectName: `${project.name}（还原到此目录）`,
        origin: "还原",
        handoffId: r.report.handoffId,
        taskName: r.state.taskName,
        sealedAt: r.state.createdAt,
        entryRel: "ACB-HANDOFF.md",
        reportRel: "ACB-RESUME-REPORT.md",
        integrity: r.report.entryCount === undefined ? undefined
          : { entries: r.report.entryCount, verified: r.report.verifiedCount },
      }, "还原")
    : null;
  return { report: r.report, taskName: r.state.taskName, bridge };
}
