import { useCallback, useEffect, useState } from "react";
import {
  Check, History, Info, Loader, OctagonX, RefreshCw, RotateCcw, Search,
  TriangleAlert, Wrench,
} from "lucide-react";
import { AlertCard, CopyButton, Disclosure, OpenLink, Panel } from "../components/Shell";
import { useProject } from "../state";
import {
  agentPrompt, api, bridgeLineZh, fmtBytes, fmtTime, jobResult, waitJob,
  type BridgeOutcome, type ConflictPolicy, type JobView, type Overview, type ResumePreview, type ResumeReport,
} from "../api";

/**
 * ② 接过来 / 回到某次交接：源只有一个 —— 本项目 .acb/store 里已封存的交接。
 * 还原目标永远是"另一个目录"：就地覆盖会毁掉没封存过的工作，这条边界不给开关。
 */
export default function Takeover({ ov, onDone }: { ov: Overview | null; onDone: () => Promise<void> }) {
  const { active } = useProject();
  const [handoffId, setHandoffId] = useState("");
  const [targetDir, setTargetDir] = useState("");
  const [onConflict, setOnConflict] = useState<ConflictPolicy>("abort");
  const [strategyOpen, setStrategyOpen] = useState(false);

  const [preview, setPreview] = useState<ResumePreview | null>(null);
  const [preBusy, setPreBusy] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);

  const [job, setJob] = useState<JobView | null>(null);
  const [report, setReport] = useState<ResumeReport | null>(null);
  const [bridge, setBridge] = useState<BridgeOutcome | null>(null);
  const [reports, setReports] = useState<ResumeReport[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [stepOpen, setStepOpen] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);

  const loadReports = useCallback(async () => {
    try { setReports(await api.resumeReports()); } catch { /* 历史报告取不到不阻塞主流程 */ }
  }, []);
  useEffect(() => { void loadReports(); }, [loadReports]);
  useEffect(() => { setPreview(null); }, [handoffId, targetDir, active?.projectId]);

  const chosen = ov?.handoffs.find((h) => h.handoffId === handoffId.trim()) ?? ov?.handoffs[0] ?? null;
  const req = () => ({
    projectId: active?.projectId ?? "",
    handoffId: handoffId.trim() || undefined,
    targetDir: targetDir.trim(),
  });
  const canPreview = !!active && !!targetDir.trim() && (!!chosen || !ov?.handoffs.length);

  const doPreview = async () => {
    setPreBusy(true); setErr(null); setPreview(null); setPreviewOpen(true);
    try { setPreview(await api.resumePreview(req())); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    setPreBusy(false);
  };

  const blockers = (preview?.alerts ?? []).filter((a) => a.level === "阻塞");
  const conflicts = preview?.conflicts ?? [];
  const needChoice = conflicts.length > 0 && onConflict === "abort";
  const canRestore = canPreview && !preBusy && !busy && blockers.length === 0 && !needChoice && !!preview;

  const run = async () => {
    setBusy(true); setErr(null); setReport(null); setBridge(null); setJob(null);
    try {
      const r = await api.resume({ ...req(), onConflict });
      if (!("jobId" in r)) { setReport(r.report ?? null); setBridge(r.bridge ?? null); }
      else {
        const view = await waitJob(r.jobId, setJob);
        if (view.state === "失败") throw new Error(`${view.error}${view.remedy ? ` 出路：${view.remedy}` : ""}`);
        const out = jobResult<{ report: ResumeReport; bridge?: BridgeOutcome | null }>(view);
        setReport(out.report);
        setBridge(out.bridge ?? null);
      }
      await loadReports();
      await onDone();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    setBusy(false);
  };

  const brief = report?.entryMarkdownPath;
  const prompt = brief && report ? agentPrompt(brief, preview?.taskName ?? report.handoffId, report.targetDir) : "";

  return (
    <Panel title="接过来 / 回到某次交接" step="②"
      hint={<span className="xs faint">本机封存里挑一条，还原到一个新目录</span>}
      style={{ marginBottom: 18 }}
    >
      <div className="xs muted" style={{ marginBottom: 12 }}>
        同一台电脑上换 Agent 继续做<b>不用这里</b>：代码就在原地，新 Agent 打开项目会先读 <span className="mono">.acb{'\\'}LATEST.md</span>。
        这里用于<b>把某次封存的状态取出来再看一遍</b>：还原到一个新目录，绝不动你现在的工作区
        （就地覆盖会毁掉没封存过的改动，所以这个工具不提供这个开关）。
      </div>

      <div className="fld">
        <span>要接哪一条交接</span>
        <select
          value={handoffId}
          onChange={(e) => setHandoffId(e.target.value)}
          style={{ width: "100%", background: "var(--panel-2)", color: "var(--ink)", border: "1px solid var(--line)", padding: "8px 11px", fontFamily: "var(--mono)", fontSize: 12.5 }}
        >
          <option value="">{ov?.handoffs.length ? `最新一条 · ${ov.handoffs[0].handoffId}（${ov.handoffs[0].taskName}）` : "本项目还没有封存交接"}</option>
          {(ov?.handoffs ?? []).map((h) => (
            <option key={h.handoffId} value={h.handoffId}>{h.handoffId} · {h.taskName} · {fmtTime(h.sealedAt)}</option>
          ))}
        </select>
      </div>

      <div className="fld">
        <span>还原到哪个目录（建议新目录；ACB 默认不覆盖已有工作）</span>
        <div className="row">
          <input className="acb-input mono" value={targetDir} onChange={(e) => setTargetDir(e.target.value)}
            placeholder={active ? `${active.path}-接手` : "D:\\dev\\my-project-接手"} />
          {window.acb?.pickFolder && (
            <button className="btn" onClick={() => void window.acb!.pickFolder!().then((d) => { if (d) setTargetDir(d); })}>
              <Search size={14} /> 选目录
            </button>
          )}
        </div>
        {!ov?.handoffs.length && (
          <div className="xs faint" style={{ marginTop: 5 }}>
            本项目还没有封存过交接：先在 ① 生成一次；要接<b>别的目录</b>封存的交接，先在「换项目 / 管理」里把那个项目注册进来。
          </div>
        )}
      </div>

      {conflicts.length > 0 && (
        <div className="fld">
          <span>目标目录里已有 {conflicts.length} 个同名文件，其中 {conflicts.filter((c) => !c.identical).length} 个内容不同 —— 怎么处理？</span>
          <div className="row">
            {([["abort", "停止，不动它"], ["skip", "跳过已存在的"], ["overwrite", "用包内版本覆盖"]] as const).map(([v, label]) => (
              <button key={v} className={"btn sm " + (onConflict === v ? "primary" : "ghost")} onClick={() => setOnConflict(v)}>{label}</button>
            ))}
          </div>
          <div className="xs faint" style={{ marginTop: 5 }}>选「覆盖」会用包内版本替换目标里内容不同的同名文件，只在确认那批文件属于本次交接时用。</div>
        </div>
      )}
      {preview && conflicts.length === 0 && (
        <Disclosure label="目标目录撞车时的处理方式" open={strategyOpen} onToggle={() => setStrategyOpen(!strategyOpen)}
          count={onConflict === "abort" ? "默认：停止不覆盖" : onConflict === "skip" ? "跳过已存在" : "覆盖"} tone={onConflict === "overwrite" ? "red" : ""}>
          <div className="row">
            {([["abort", "停止，不动它"], ["skip", "跳过已存在的"], ["overwrite", "用包内版本覆盖"]] as const).map(([v, label]) => (
              <button key={v} className={"btn sm " + (onConflict === v ? "primary" : "ghost")} onClick={() => setOnConflict(v)}>{label}</button>
            ))}
          </div>
        </Disclosure>
      )}

      {err && <div className="notice warn" style={{ marginTop: 12 }}><TriangleAlert size={15} className="red" /><div className="xs red">{err}</div></div>}

      <div className="row" style={{ marginTop: 14 }}>
        <button className="btn" disabled={!canPreview || preBusy} onClick={() => void doPreview()}>
          {preBusy ? <Loader size={15} className="spin" /> : <Search size={15} />} 先预览（不写盘）
        </button>
        <button className="btn primary" style={{ flex: 1, justifyContent: "center" }} disabled={!canRestore} onClick={() => void run()}>
          {busy ? <Loader size={15} className="spin" /> : <RotateCcw size={15} />}
          {busy ? "还原中…" : !active ? "先选项目" : !targetDir.trim() ? "先填目标目录" : needChoice ? "先选撞车处理方式"
            : blockers.length ? `${blockers.length} 条阻塞，暂不还原` : preview ? "确认预览 → 还原到该目录" : "先点左边「先预览」"}
        </button>
      </div>

      {busy && job && (
        <div className="pbar" style={{ marginTop: 12 }}>
          <div className="t"><Loader size={14} className="spin amber" /> {job.stage}<span className="no">{job.pct}%</span></div>
          <div className="track"><i style={{ width: `${job.pct}%` }} /></div>
          <div className="m">{job.message}</div>
        </div>
      )}

      {preview && (
        <Disclosure label={`还原前预览：${preview.willWrite} 个文件 · ${fmtBytes(preview.totalBytes)} · 完整性 ${preview.verifiedCount}/${preview.entryCount}`}
          open={previewOpen} onToggle={() => setPreviewOpen(!previewOpen)} tone={preview.integrityOk ? "green" : "red"}>
          <dl className="kv" style={{ gridTemplateColumns: "96px 1fr" }}>
            <dt>项目/任务</dt><dd>{preview.projectName} · {preview.taskName}</dd>
            <dt>交接</dt><dd className="mono">{preview.handoffId}</dd>
            <dt>封存于</dt><dd className="mono">{fmtTime(preview.sealedAt)} · 协议 {preview.protocolVersion}</dd>
            <dt>来源</dt><dd className="mono" style={{ wordBreak: "break-all" }}>{preview.source}</dd>
            <dt>包完整性</dt><dd><span className={"badge " + (preview.integrityOk ? "green" : "red")}>{preview.verifiedCount}/{preview.entryCount} 条目 SHA-256 通过</span></dd>
            <dt>将写入</dt><dd className="mono">{preview.willWrite} 文件 · {fmtBytes(preview.totalBytes)}{preview.willDelete ? ` · 保持删除 ${preview.willDelete}` : ""}</dd>
            <dt>暂存材料</dt><dd className="mono">{preview.stagedCount} 项独立恢复</dd>
            <dt>基线历史</dt><dd className="mono">{preview.baselineAvailable ? "bundle 可用" : "缺 bundle"}</dd>
            {preview.symlinkCount > 0 && <><dt>符号链接</dt><dd className="mono">{preview.symlinkCount} 个待重建</dd></>}
            <dt>源端环境</dt><dd className="mono">{preview.sourceEnv.os} / {preview.sourceEnv.runtime}</dd>
            {(preview.onlyInTargetCount ?? 0) > 0 && (
              <><dt>目录里原有的</dt><dd className="xs muted">{preview.onlyInTargetCount} 项不属于本次交接，还原不碰它们{preview.onlyInTarget?.length ? `：${preview.onlyInTarget.slice(0, 3).join("、")}${(preview.onlyInTargetCount ?? 0) > preview.onlyInTarget.length ? " 等" : ""}` : ""}</dd></>
            )}
          </dl>
          {conflicts.length > 0 && (
            <>
              <div className="xs muted" style={{ margin: "10px 0 5px" }}>撞车清单（{conflicts.length} 项，{conflicts.filter((c) => !c.identical).length} 项内容不同）</div>
              <div className="scope-list" style={{ maxHeight: 150 }}>
                {conflicts.map((c) => (
                  <div className="scope-row" key={c.path}>
                    <span className="p" title={c.path}>{c.path}</span>
                    <span className="b">{c.identical ? "内容相同" : `包 ${fmtBytes(c.packageBytes)} / 本机 ${fmtBytes(c.targetBytes)}`}</span>
                    <span className={"badge " + (c.identical ? "teal" : "red")}>{c.identical ? "可跳过" : "会被覆盖"}</span>
                  </div>
                ))}
              </div>
            </>
          )}
          {preview.alerts.map((a, i) => <div style={{ marginTop: 8 }} key={i}><AlertCard a={a} /></div>)}
        </Disclosure>
      )}

      {report && (
        <div className="outcome">
          <Verdict report={report} />
          {brief && (
            <div className="brief-box">
              <div className="bb-title">接手这一步：还原目录里已经装好 ACB 接入</div>
              <div className="xs" style={{ padding: "2px 0 6px" }}>
                {bridge ? bridgeLineZh(bridge) : "本次没有写接入块"}。
                在这个目录里打开的 Agent 会先读 <span className="mono">.acb{'\\'}LATEST.md</span>，
                再由它指向 <span className="mono">ACB-HANDOFF.md</span>；不需要你把话带到。
              </div>
              <div className="bb-acts">
                <OpenLink path={brief} label="打开简报" />
                <OpenLink path={report.targetDir} label="打开还原目录" />
              </div>
              <Disclosure label="备用：还是想自己粘一段话给接手的 Agent" open={pasteOpen} onToggle={() => setPasteOpen(!pasteOpen)}>
                <textarea className="acb-input mono prompt-text" readOnly rows={8} value={prompt} onFocus={(e) => e.currentTarget.select()} />
                <div className="bb-acts">
                  <CopyButton text={prompt} label="复制这段话" />
                </div>
                <div className="xs faint">给不认识 <span className="mono">AGENTS.md</span> 的客户端用。还原出来的目录里另有 <span className="mono">ACB-RESUME-REPORT.md</span>，那是逐项对账的回执。</div>
              </Disclosure>
            </div>
          )}
          {!brief && report.error && (
            <div className="notice warn" style={{ marginTop: 10 }}><TriangleAlert size={15} className="red" /><div className="xs red">{report.error}</div></div>
          )}
          <Receipt report={report} />
          <Disclosure label={`还原流程回放（${report.steps.length} 步）与差异清单（${report.gaps.length} 项）`} open={stepOpen} onToggle={() => setStepOpen(!stepOpen)}
            tone={report.gaps.some((g) => g.blocking) ? "red" : "teal"}>
            <div className="resume-steps">
              {report.steps.map((s, i) => (
                <div className={"rstep " + (s.ok ? "ok" : "cur")} key={i}>
                  <div className="ic">{s.ok ? <Check size={14} /> : <TriangleAlert size={14} className="red" />}</div>
                  <div><h5>{s.title}</h5><p>{s.detail}</p></div>
                </div>
              ))}
            </div>
            {report.gaps.length > 0 && (
              <>
                <div className="xs muted" style={{ margin: "8px 0 4px" }}>差异与补齐动作</div>
                {report.gaps.map((g, i) => (
                  <div className="pick-row" key={i} style={{ alignItems: "flex-start" }}>
                    {g.blocking ? <TriangleAlert size={14} className="red" /> : <Info size={14} className="teal" />}
                    <div style={{ flex: 1 }}><b className="small">{g.title}</b><div className="xs muted">{g.detail}</div></div>
                    <span className={"badge " + (g.blocking ? "red" : "teal")}>{g.blocking ? "阻塞运行" : "提示"}</span>
                  </div>
                ))}
              </>
            )}
            <div className="xs faint" style={{ marginTop: 8 }}>
              完整报告也写进了还原目录：<span className="mono">ACB-RESUME-REPORT.md</span>。源端的通过记录是历史证据，接手前在本机复跑一次检查。
            </div>
          </Disclosure>
        </div>
      )}

      <ReportList reports={reports} />
    </Panel>
  );
}

/** 四态判定条：还原完成后一眼知道"能不能直接继续" */
function Verdict({ report }: { report: ResumeReport }) {
  const icon = {
    可继续: <Check size={15} className="green" />,
    需要配置环境: <Wrench size={15} className="amber" />,
    需要重新验证: <RefreshCw size={15} className="amber" />,
    恢复被阻塞: <OctagonX size={15} className="red" />,
  };
  return (
    <div className="verdict">
      {(["可继续", "需要配置环境", "需要重新验证", "恢复被阻塞"] as const).map((v) => (
        <div className={"v" + (report.verdict === v ? " sel" : "")} key={v}>
          <div className="t">{icon[v]} {v}</div>
          <div className="d">
            {report.verdict === v
              ? `${fmtTime(report.at)} · ${report.digestMatch === null ? "未比对指纹" : report.digestMatch ? "代码指纹一致" : "代码指纹不一致"}`
              : v === "可继续" ? "代码一致且材料齐备" : v === "恢复被阻塞" ? "未落地，见停止原因" : "见差异清单"}
          </div>
        </div>
      ))}
    </div>
  );
}

/** 完整性回执：清单条目 / 实际核对 / 写入 / 基线对账，四个数一一对上才算完整 */
function Receipt({ report }: { report: ResumeReport }) {
  const [open, setOpen] = useState(false);
  const incomplete = (report.receipt?.onlyInPackageCount ?? 0) > 0;
  return (
    <Disclosure label={`校验回执：核对 ${report.verifiedCount ?? "-"}/${report.entryCount ?? "-"} · 写入 ${report.restoredCount ?? "-"} · 基线 ${report.baselineWritten ?? "-"}/${report.baselineExpected ?? "-"}`}
      open={open} onToggle={() => setOpen(!open)} tone={incomplete ? "red" : report.digestMatch ? "green" : "amber"}>
      {report.receipt && (
        <div className="scope-list">
          {([
            ["一致（目标里本来就有，逐字节相同）", report.receipt.identical, ""],
            ["变更（目标里内容不同、按「覆盖」替换）", report.receipt.overwritten, ""],
            ["空目录重建", report.receipt.emptyDirsRestored, ""],
            [`只在包里 · ${report.receipt.onlyInPackageCount} 项未落地`, report.receipt.onlyInPackageCount, "red"],
            ["只在目标 · 本机自己的文件", report.receipt.onlyInTargetCount, ""],
          ] as const).map(([label, n, tone]) => (
            <div className="scope-row" key={label} style={{ gridTemplateColumns: "1fr auto" }}>
              <span className="p" style={{ fontFamily: "var(--sans)" }}>{label}</span>
              <span className={"badge " + tone}>{n}</span>
            </div>
          ))}
        </div>
      )}
      {report.receipt && report.receipt.onlyInPackage.length > 0 && (
        <div className="xs red" style={{ marginTop: 6 }}>
          「只在包里」不为空说明这次还原并不完整，逐条原因：{report.receipt.onlyInPackage.slice(0, 3).join("；")}{report.receipt.onlyInPackage.length > 3 ? " 等" : ""}
        </div>
      )}
      {report.baselineSkipped && report.baselineSkipped.length > 0 && (
        <div className="xs red" style={{ marginTop: 6 }}>基线未落地 {report.baselineSkipped.length} 个：{report.baselineSkipped.slice(0, 3).join("、")}</div>
      )}
      <div className="xs faint" style={{ marginTop: 6 }}>
        这几个数取自包内清单与目标目录的实测比对，不是估算；"将写入"与"写入"对不上时这里就会露出来。
      </div>
    </Disclosure>
  );
}

function ReportList({ reports }: { reports: ResumeReport[] }) {
  const [open, setOpen] = useState(false);
  if (reports.length === 0) return null;
  return (
    <Disclosure label={`本机接手历史（${reports.length} 次还原）`} open={open} onToggle={() => setOpen(!open)} count="记录" tone="">
      <div className="scope-list" style={{ maxHeight: 190 }}>
        {reports.slice(0, 8).map((r) => (
          <div className="scope-row" key={r.reportId} style={{ gridTemplateColumns: "1fr auto auto" }}>
            <div style={{ minWidth: 0 }}>
              <div className="p" title={r.targetDir}>{r.handoffId}</div>
              <div className="why mono">{r.targetDir}</div>
            </div>
            <span className="b">{fmtTime(r.at)}</span>
            <span className={"badge " + (r.verdict === "可继续" ? "green" : r.verdict === "恢复被阻塞" ? "red" : "amber")}>{r.verdict}</span>
          </div>
        ))}
      </div>
      <div className="xs faint" style={{ marginTop: 6 }}>
        <History size={11} style={{ verticalAlign: -1 }} /> 报告存在本机（<span className="mono">~/.acb/resume-reports.json</span>）；这一格只读历史，不会重新跑还原。
      </div>
    </Disclosure>
  );
}
