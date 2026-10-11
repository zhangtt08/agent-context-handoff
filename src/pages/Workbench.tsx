import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Check, FolderGit2, FolderOpen, GitBranchPlus, Info, Loader, Minus, Plus,
  RefreshCw, TriangleAlert, Wrench, Zap,
} from "lucide-react";
import { AlertCard, CopyButton, Disclosure, DropArea, OpenLink, Panel, Topbar } from "../components/Shell";
import { useProject } from "../state";
import {
  agentPrompt, api, bridgeLineZh, fmtBytes, fmtTime, jobResult, outgoingAgentPrompt, waitJob,
  type CapturePreview, type CreateResult, type JobView, type Overview,
} from "../api";
import Takeover from "./Takeover";
import ArchiveList from "./RecordDetail";
import ProjectSetup from "./ProjectSetup";

export default function Workbench() {
  const { projects, active, setActiveId, refresh, loading } = useProject();
  const [ov, setOv] = useState<Overview | null>(null);
  const [preview, setPreview] = useState<CapturePreview | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanErr, setScanErr] = useState<string | null>(null);
  const [manage, setManage] = useState(false);

  const load = useCallback(async () => {
    if (!active) { setOv(null); setPreview(null); return; }
    try { setOv(await api.overview(active.projectId)); } catch { setOv(null); }
  }, [active]);

  const scan = useCallback(async (quiet = false) => {
    if (!active) return;
    if (!quiet) setScanning(true);
    try { setPreview(await api.preview(active.projectId)); setScanErr(null); }
    catch (e) { setPreview(null); setScanErr(e instanceof Error ? e.message : String(e)); }
    setScanning(false);
  }, [active]);

  useEffect(() => {
    void load(); void scan();
    const t = setInterval(() => void load(), 20_000);
    return () => clearInterval(t);
  }, [load, scan]);

  if (loading) {
    return (
      <>
        <Topbar>读取本机项目…</Topbar>
        <div className="content"><span className="muted"><Loader size={15} className="spin amber" /> 正在读本机项目注册表</span></div>
      </>
    );
  }

  if (!projects.length) return <FirstRun onRegistered={refresh} />;

  return (
    <>
      <Topbar actions={
        <button className={"btn sm " + (manage ? "primary" : "ghost")} onClick={() => setManage(!manage)}>
          <FolderGit2 size={13} /> 换项目 / 管理
        </button>
      }>
        <select
          value={active?.projectId ?? ""}
          onChange={(e) => setActiveId(e.target.value)}
          title="当前项目"
        >
          {projects.map((p) => <option key={p.projectId} value={p.projectId}>{p.name}</option>)}
        </select>
        <span className="crumb-sep">·</span>
        <span className="mono faint" title={active?.path}>{active?.path}</span>
        {ov && <>
          <span className="crumb-sep">·</span>
          <span className="mono xs">{ov.branch ?? "(无分支)"}@{ov.commit?.slice(0, 7) ?? "无提交"}</span>
          <span className={"badge " + (ov.stats.changes ? "amber" : "teal")} style={{ marginLeft: 4 }}>
            {ov.stats.changes ? `${ov.stats.changes} 处未提交改动` : "工作区干净"}
          </span>
        </>}
      </Topbar>

      <DropAreaWrapper onAdded={async () => { await refresh(); await load(); }}>
        <div className="content">
          <div className="lede">
            <b>怎么用（就这两块，没有人肉传话）：</b>
            <div className="lede-list">
              <span><b>① 交出去</b> 什么都不用写 —— ACB 从分支、提交与 diff 里推断出交接内容 → 点「就这样，生成交接」→ 指针写进项目里的 <span className="mono">.acb\LATEST.md</span>。</span>
              <span><b>② 接过来 / 回到某次交接</b> 把本项目某一次封存的状态还原到一个新目录再看 —— 绝不动你现在的工作区。</span>
              <span><b>Agent 侧不需要你转述</b> 项目 <span className="mono">AGENTS.md</span> 里有一段 ACB 维护的接入块：接手的先读指针，干到一半的自己封存（能调工具就用 <span className="mono">acb.handoff_create</span>）。</span>
            </div>
          </div>

          {manage && (
            <Panel title="项目与本机设置" step="⚙" style={{ marginBottom: 18 }}>
              <ProjectSetup onChanged={async () => { await refresh(); await load(); await scan(true); }} />
            </Panel>
          )}

          <div className="grid2">
            <HandoffSection
              preview={preview} scanning={scanning} scanErr={scanErr}
              onRescan={() => void scan()} onChanged={async () => { await load(); await scan(true); }}
            />
            <Takeover
              ov={ov} onDone={async () => { await load(); await scan(true); }}
            />
          </div>

          {ov && ov.handoffs.length > 0 && (
            <Panel title="本项目的交接记录" step="③" hint={`最近 ${Math.min(ov.handoffs.length, 6)} 条 · 共 ${ov.handoffs.length} 条`} style={{ marginTop: 18 }}>
              <ArchiveList items={ov.handoffs.slice(0, 6).map((h) => ({
                id: h.handoffId, taskName: h.taskName,
                meta: `${fmtTime(h.sealedAt)} · 快照 ${h.snapshot}`,
                badges: [h.verify].map((b) => ({ label: b.label, tone: b.tone })),
              }))} />
              {ov.forksList.length > 0 && (
                <div className="notice warn" style={{ marginTop: 12 }}>
                  <TriangleAlert size={15} className="amber" />
                  <div className="xs">
                    {ov.forksList.map((f) => <span key={f.parent}>父交接 <span className="mono">{f.parent}</span> 有 {f.children.length} 个后继（各自接续过）；</span>)}
                    <span className="muted">分叉不会被自动合并 —— 继续前先确认这次要接的是哪一条。</span>
                  </div>
                </div>
              )}
              <div className="xs faint" style={{ marginTop: 10 }}>
                封存之后的交接不可原地更新：新的进度会产生新的交接，父子关系在这里保留。删除项目只动本机注册表，不删盘上数据。
              </div>
            </Panel>
          )}
        </div>
      </DropAreaWrapper>
    </>
  );
}

/** 拖入项目文件夹即注册：整页只有一个入口，不需要先点"管理"再点"注册" */
function DropAreaWrapper({ onAdded, children }: { onAdded: () => Promise<void>; children: ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null);
  const say = (t: string) => { setMsg(t); setTimeout(() => setMsg((m) => (m === t ? null : m)), 7000); };
  return (
    <DropArea onPath={async (p) => {
      if (!p) { say("桌面版才能通过拖放识别文件夹路径；请用「换项目 / 管理」里的选择文件夹"); return; }
      try { await api.registerProject(p); say(`已注册：${p}`); await onAdded(); }
      catch (e) { say(e instanceof Error ? e.message : String(e)); }
    }} hint="松手，注册这个项目并开始交接">
      {msg && <div className="drop-msg">{msg}</div>}
      {children}
    </DropArea>
  );
}

/** 首次使用：整页就一个动作 —— 把项目文件夹拖进来（或选文件夹） */
function FirstRun({ onRegistered }: { onRegistered: () => Promise<void> }) {
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState<"reg" | "demo" | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const register = async (p: string, demo = false) => {
    setBusy(demo ? "demo" : "reg"); setErr(null);
    try {
      if (demo) await api.seedDemo(); else await api.registerProject(p);
      await onRegistered();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    setBusy(null);
  };

  return (
    <DropArea onPath={(p) => { if (p) { setPath(p); void register(p); } }} hint="松手，注册这个项目">
      <Topbar>第一次使用 · 选一个项目</Topbar>
      <div className="content">
        <div className="firstrun">
          <h1>把项目文件夹<b>拖进来</b></h1>
          <p className="muted">
            需要是一个 Git 仓库（<span className="mono">.git</span> 目录在就行）。ACB 全程在本机运行：
            服务只绑 127.0.0.1，不联网、不上传任何代码。
          </p>
          <div className="fr-row">
            <input className="acb-input mono" value={path} onChange={(e) => setPath(e.target.value)}
              placeholder="或粘贴仓库绝对路径，如 D:\\dev\\my-project" />
            {window.acb?.pickFolder && (
              <button className="btn" onClick={() => void window.acb!.pickFolder!().then((d) => { if (d) setPath(d); })}>
                <FolderOpen size={14} /> 选择文件夹
              </button>
            )}
            <button className="btn primary" disabled={!path.trim() || busy !== null} onClick={() => void register(path.trim())}>
              {busy === "reg" ? <Loader size={14} className="spin" /> : <Plus size={14} />} 注册这个项目
            </button>
          </div>
          {err && <div className="notice warn" style={{ marginTop: 14 }}><TriangleAlert size={15} className="red" /><div className="xs red">{err}</div></div>}
          <div className="xs faint" style={{ marginTop: 18 }}>
            手上没有合适的仓库？
            <button className="btn sm ghost" style={{ marginLeft: 8 }} disabled={busy !== null} onClick={() => void register("", true)}>
              {busy === "demo" ? <Loader size={12} className="spin" /> : <Wrench size={12} />} 生成一个示例项目练手
            </button>
            <span style={{ marginLeft: 8 }}>（在系统临时目录里造一个含暂存/未暂存/新文件/删除的脏工作区，跑完可直接删）</span>
          </div>
        </div>
      </div>
    </DropArea>
  );
}

/** ① 交出去：两个输入框 + 一个按钮；审阅清单与阻塞闸门保留，但只在有问题时需要展开看 */
function HandoffSection({ preview, scanning, scanErr, onRescan, onChanged }: {
  preview: CapturePreview | null; scanning: boolean;
  scanErr: string | null; onRescan: () => void; onChanged: () => Promise<void>;
}) {
  const { active } = useProject();
  const [taskName, setTaskName] = useState("");
  const [note, setNote] = useState("");
  const [nextStep, setNextStep] = useState("");
  const [evidence, setEvidence] = useState("");
  const [runChecks, setRunChecks] = useState(true);
  const [ackWarn, setAckWarn] = useState(false);
  const [scopeOpen, setScopeOpen] = useState(false);
  const [tab, setTab] = useState<"in" | "out">("in");
  const [extraOpen, setExtraOpen] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);

  const [job, setJob] = useState<JobView | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<CreateResult | null>(null);

  useEffect(() => { setResult(null); setJob(null); setAckWarn(false); }, [active?.projectId]);

  const blockers = (preview?.alerts ?? []).filter((a) => a.level === "阻塞");
  const warnings = (preview?.alerts ?? []).filter((a) => a.level === "警告");
  const needsAck = warnings.length > 0 && !ackWarn;
  const inferred = preview?.inferred ?? null;
  const edited = !!(taskName.trim() || note.trim() || nextStep.trim() || evidence.trim());
  const canPack = !!active && !!preview && !scanning && !busy && blockers.length === 0 && !needsAck;

  const briefPath = result ? `${result.record.packageDir}\\HANDOFF.md` : "";
  const prompt = result ? agentPrompt(briefPath, result.record.state.taskName) : "";

  const pack = async () => {
    if (!active) return;
    setBusy(true); setErr(null); setResult(null); setJob(null);
    try {
      const { jobId } = await api.createHandoff(active.projectId, {
        taskName: taskName.trim() || undefined,
        claimText: note.trim() || undefined,
        claimEvidence: evidence.trim() || undefined,
        nextStep: nextStep.trim() || undefined,
        runChecks,
      });
      const view = await waitJob(jobId, setJob);
      if (view.state === "失败") throw new Error(`${view.error}${view.remedy ? `\n出路：${view.remedy}` : ""}`);
      setResult(jobResult<CreateResult>(view));
      setTaskName(""); setNote(""); setNextStep(""); setEvidence("");
      await onChanged();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    setBusy(false);
  };

  const checks = active?.checks.length ?? 0;

  const state = useMemo(() => {
    if (busy) return { t: "正在打包封存", tone: "amber" as const };
    if (result) return { t: "已生成交接 · 项目里的 Agent 自己会读到", tone: "green" as const };
    if (!preview) return { t: "等待扫描工作区", tone: "" as const };
    if (blockers.length) return { t: `${blockers.length} 条阻塞，需先处理`, tone: "red" as const };
    if (needsAck) return { t: `${warnings.length} 条警告待确认`, tone: "amber" as const };
    return { t: "审阅通过，可以打包", tone: "teal" as const };
  }, [busy, result, preview, blockers.length, needsAck, warnings.length]);

  return (
    <Panel title="交出去" step="①" corner
      hint={<span className={"badge " + state.tone}>{state.t}</span>}
      headExtra={
        <button className="btn sm ghost" title="重新扫描当前工作区" disabled={busy || scanning} onClick={onRescan}>
          {scanning ? <Loader size={12} className="spin" /> : <RefreshCw size={12} />}
        </button>
      }
      style={{ marginBottom: 18 }}
    >
      {inferred ? (
        <div className="inferred">
          <div className="if-head">
            <Zap size={13} className="amber" />
            <b>ACB 已经从现场推断出来这些</b>
            <span className="xs faint">（分支名 · 提交标题 · diff 新增行 · 代码里的待办 · 未同步的测试）</span>
          </div>
          <div className="if-row">
            <span className="if-k">任务</span>
            <div className="if-v">
              <b>{taskName.trim() || inferred.taskName}</b>
              <div className="xs faint">依据：{inferred.taskSource}{edited ? " · 已被你改写" : ""}</div>
            </div>
          </div>
          <div className="if-row">
            <span className="if-k">做到哪</span>
            <div className="if-v">
              {note.trim() ? (
                <b>{note.trim().split("\n")[0]}{note.trim().includes("\n") ? " …（你写的）" : "（你写的）"}</b>
              ) : (
                <ul className="if-ul">
                  {inferred.progress.slice(0, 5).map((p, i) => <li key={i} className="mono xs">{p.trim()}</li>)}
                  {inferred.progress.length > 5 && <li className="xs faint">…共 {inferred.progress.length} 行，展开下方「我来改」看全部</li>}
                </ul>
              )}
            </div>
          </div>
          <div className="if-row">
            <span className="if-k">下一步</span>
            <div className="if-v">
              {nextStep.trim() ? <b>{nextStep.trim()}（你写的）</b> : (
                <ul className="if-ul">
                  {inferred.nextSteps.slice(0, 4).map((p, i) => <li key={i} className="xs">{p.trim()}</li>)}
                </ul>
              )}
            </div>
          </div>
          {inferred.agentNote && (
            <div className="if-note">
              已采纳上一个 Agent 自己写下的便签 <span className="mono xs">{inferred.agentNote.path}</span>
              （它还在原地；改它或删它都会影响下一次交接）
            </div>
          )}
          <div className="row" style={{ marginTop: 10 }}>
            <CopyButton text={outgoingAgentPrompt(active?.path ?? "")} label="（可选）催现在干活的 Agent 自己写份交接说明" />
            <span className="xs faint">不催也行：项目里的 <span className="mono">AGENTS.md</span> 已经写了该由它自己封存</span>
          </div>
        </div>
      ) : (
        <div className="xs muted" style={{ marginBottom: 12 }}>{scanning ? "正在推断任务与进度…" : "还没拿到推断结果，点右上重新扫描。"}</div>
      )}

      <Disclosure label="我来改 / 补充（可选）" open={extraOpen} onToggle={() => setExtraOpen(!extraOpen)}
        count={edited ? "已改写" : "留空就用推断结果"} tone={edited ? "amber" : ""}>
        <label className="fld">
          <span>任务（留空 = 用推断的「{inferred?.taskName ?? "…"}」）</span>
          <input className="acb-input" value={taskName} onChange={(e) => setTaskName(e.target.value)}
            placeholder={inferred?.taskName ?? "例：把登录超时从 3s 调到 8s 并补重试"} />
        </label>
        <label className="fld">
          <span>现在做到哪了（留空 = 用上面推断的改动内容）</span>
          <textarea className="acb-input" rows={3} value={note} onChange={(e) => setNote(e.target.value)}
            placeholder="只有你知道的部分：为什么这么改、哪里是半成品" />
        </label>
        <label className="fld">
          <span>建议下一步（留空 = 用推断出的待办与未同步测试）</span>
          <input className="acb-input" value={nextStep} onChange={(e) => setNextStep(e.target.value)}
            placeholder="例：更新 retry.spec.ts 后重跑 npm test" />
        </label>

        <label className="fld" style={{ marginBottom: 8 }}>
          <span>关联证据（可选，让声明从"待确认"变成有依据）</span>
          <input className="acb-input" value={evidence} onChange={(e) => setEvidence(e.target.value)}
            placeholder="例：auth 套件 38 项通过" />
        </label>
        {checks > 0 ? (
          <div className="check-row" style={{ cursor: "pointer" }} onClick={() => setRunChecks(!runChecks)}>
            <div className={"ck" + (runChecks ? " on" : "")}>{runChecks ? <Check size={12} /> : <Minus size={12} />}</div>
            <div><b className="small">打包时执行这 {checks} 条检查</b><div className="xs faint mono">失败也照样封存，失败本身就是交接内容</div></div>
            <span className="badge">{runChecks ? "执行" : "跳过"}</span>
          </div>
        ) : (
          <div className="xs muted">还没配置检查命令。可在上方「换项目 / 管理」里添加（如 npm test、npm run build）—— 配好后每次打包会自动跑，结果写进简报。</div>
        )}
      </Disclosure>

      <Disclosure label="会带上什么 / 排除了什么" open={scopeOpen} onToggle={() => setScopeOpen(!scopeOpen)}
        tone={blockers.length ? "red" : "amber"}
        count={preview ? `${preview.included.length} 纳入 · ${preview.excluded.length} 排除 · ${preview.alerts.length} 提示` : scanning ? "扫描中" : "未扫描"}>
        {scanErr && <div className="notice warn"><TriangleAlert size={15} className="red" /><div className="xs red">清单取不到：{scanErr} —— 修好后点上面「重新扫描」，不要绕过这一步直接打包。</div></div>}
        {scanning && !preview && <div className="xs muted"><Loader size={13} className="spin amber" /> 正在探测工作区形态（只 stat，不读文件内容）…</div>}
        {preview && (
          <>
            <div className="seg">
              <button className={tab === "in" ? "on" : ""} onClick={() => setTab("in")}>纳入 {preview.included.length} 项 · {fmtBytes(preview.includedBytes)}</button>
              <button className={tab === "out" ? "on" : ""} onClick={() => setTab("out")}>排除 {preview.excluded.length} 项</button>
            </div>
            <div className="scope-list">
              {tab === "in" && (
                <>
                  {preview.included.length === 0 && <div className="xs muted" style={{ padding: 12 }}>工作区没有未提交改动 —— 本次只封存基线提交。</div>}
                  {preview.included.map((f) => (
                    <div className="scope-row" key={f.path}>
                      <span className="p" title={f.path}>{f.path}</span>
                      <span className="b">{f.status}{f.staged ? "+暂存" : ""}{f.kind === "symlink" ? " · 链接" : f.kind === "executable" ? " · 可执行" : ""}</span>
                      <span className="b">{f.status === "deleted" ? "删除" : fmtBytes(f.bytes)}</span>
                    </div>
                  ))}
                </>
              )}
              {tab === "out" && (
                <>
                  {preview.excluded.length === 0 && <div className="xs muted" style={{ padding: 12 }}>没有排除项 —— 未提交改动全部进包。</div>}
                  {preview.excluded.map((e) => (
                    <div className="scope-row" key={e.path} style={{ gridTemplateColumns: "1fr auto" }}>
                      <div style={{ minWidth: 0 }}>
                        <div className="p" title={e.path}>{e.path}</div>
                        <div className="why">{e.reason}</div>
                      </div>
                      <span className={"badge " + (e.kind === "凭据" ? "red" : "")}>{e.kind}</span>
                    </div>
                  ))}
                </>
              )}
            </div>
            <div className="xs faint" style={{ marginTop: 8 }}>
              {preview.bundleNote} 基线 {preview.baseline.branch ?? "(无)"}@{preview.baseline.commit?.slice(0, 7) ?? "无"} · 仓库约 {fmtBytes(preview.baseline.repoBytesApprox)}
              {preview.emptyDirs.length > 0 && <> · 空目录 {preview.emptyDirs.length} 个单独重建{preview.emptyDirsTruncated ? "（扫描已达上限，列表可能不完整）" : ""}</>}
            </div>
          </>
        )}
        {preview && preview.alerts.length > 0 && (
          <div className="xs faint" style={{ marginTop: 8 }}>
            共 {preview.alerts.length} 条提示，已列在上方「审阅结论」里，每条都带出路。
          </div>
        )}
      </Disclosure>

      {preview && (blockers.length > 0 || warnings.length > 0) && !result && (
        <div style={{ marginTop: 12 }}>
          <div className="xs muted" style={{ marginBottom: 6 }}>
            审阅结论：{blockers.length ? <span className="red" style={{ fontWeight: 600 }}>{blockers.length} 条阻塞 · </span> : null}
            {warnings.length ? <span className="amber" style={{ fontWeight: 600 }}>{warnings.length} 条警告 · </span> : null}
            每条都给了出路，处理完再打包（ACB 不碰你的业务文件：它只写 <span className="mono">.acb/</span> 目录，以及 AGENTS.md 里那段自己维护的接入块）。
          </div>
          {[...blockers, ...warnings].map((a, i) => <AlertCard key={i} a={a} />)}
          {warnings.length > 0 && (
            <div className="check-row" style={{ cursor: "pointer", marginTop: 4 }} onClick={() => setAckWarn(!ackWarn)}>
              <div className={"ck" + (ackWarn ? " on" : "")}>{ackWarn ? <Check size={12} /> : <Minus size={12} />}</div>
              <div><b className="small">我已确认这 {warnings.length} 条警告</b><div className="xs faint">历史提交里的凭据无法由打包环节排除，这个确认由你承担</div></div>
              <span className="badge">{ackWarn ? "已确认" : "待确认"}</span>
            </div>
          )}
        </div>
      )}
      {scanErr && !preview && <div className="notice warn" style={{ marginTop: 12 }}><TriangleAlert size={15} className="red" /><div className="xs red">{scanErr}</div></div>}

      {busy && job && (
        <div className="pbar" style={{ marginTop: 12 }}>
          <div className="t"><Loader size={14} className="spin amber" /> {job.stage}<span className="no">{job.pct}%</span></div>
          <div className="track"><i style={{ width: `${job.pct}%` }} /></div>
          <div className="m">{job.message}</div>
        </div>
      )}
      {err && <div className="notice warn" style={{ marginTop: 12 }}><TriangleAlert size={15} className="red" /><div className="xs red">{err}</div></div>}

      <button className="btn primary block big" style={{ marginTop: 14 }} disabled={!canPack} onClick={() => void pack()}>
        {busy ? <Loader size={16} className="spin" /> : <GitBranchPlus size={16} />}
        {busy ? "打包中…" : !preview ? (scanErr ? "先按上面的问题处理" : "正在扫描工作区…") : blockers.length ? `${blockers.length} 条阻塞，处理后才能打包` : needsAck ? "先勾选「我已确认警告」" : result ? (edited ? "用我改过的内容，再生成一次" : "再生成一次交接") : (edited ? "用我改过的内容，生成交接" : "就这样，生成交接")}
      </button>

      {result && (
        <div className="outcome">
          <div className="oc-head">
            <Check size={16} className="green" />
            <b>交接已生成，而且已经接进这个项目</b>
            <span className="mono xs faint">{result.record.handoffId}</span>
            <span className="xs faint" style={{ marginLeft: "auto" }}>{fmtTime(result.record.sealedAt)} · 快照 {result.snapshot.id} · {fmtBytes(result.snapshot.bytes)}</span>
          </div>

          <div className="notice" style={{ marginTop: 4 }}>
            <div className="xs">
              <b>下一个 Agent 不用你转述：</b>{bridgeLineZh(result.bridge)}。
              它打开这个项目就读到 <span className="mono">.acb\LATEST.md</span> 指向的这份简报；
              做到一半要被换掉的那个 Agent，也一样按这段里的命令自己封存。
            </div>
            <div className="xs faint mono" style={{ marginTop: 4 }}>{result.bridge.latestFile}</div>
          </div>

          <div className="brief-box">
            <div className="bb-title">交接简报（这次带走的现场）</div>
            <div className="xs mono" style={{ padding: "2px 0 6px" }}>{briefPath}</div>
            <div className="bb-acts">
              <OpenLink path={briefPath} label="打开交接简报" />
              <OpenLink path={result.record.packageDir} label="打开所在目录" />
            </div>
            <Disclosure label="备用：还是想自己粘一段话给下一个 Agent" open={pasteOpen} onToggle={() => setPasteOpen(!pasteOpen)} tone="">
              <div className="xs faint" style={{ marginBottom: 6 }}>
                更省 token 的接法是让下一个 Agent 自己调接口拿摘要（省多少可复算：仓库根跑 <span className="mono">npm run tokens</span>）：
                <span className="mono"> GET http://127.0.0.1:&lt;端口&gt;/api/handoff-brief?at={active?.path ?? "&lt;项目目录&gt;"}</span>
                　端口写在 <span className="mono">~\.acb\endpoint.json</span>；MCP 客户端就登记 <span className="mono">acb.handoff_takeover</span> 一条。
              </div>
              <textarea className="acb-input mono prompt-text" readOnly rows={8} value={prompt} onFocus={(e) => e.currentTarget.select()} />
              <div className="bb-acts">
                <CopyButton text={prompt} label="复制这段话" />
              </div>
              <div className="xs faint">给不认识 <span className="mono">AGENTS.md</span> 的客户端用（比如只吃单条消息的网页版）。用不上也没关系：接入块说的就是同一件事，而且它不需要有人在场。</div>
            </Disclosure>
          </div>

          <div className="xs muted" style={{ marginTop: 10 }}>
            同一个项目、同一个目录，换 Agent 继续做时<b className="amber">不需要还原</b>：代码就在这儿。
            想回到这次封存的状态，去 ② 还原到一个新目录看。
          </div>

          <CheckList result={result} />
          <ArchiveList title="这条交接的完整档案（点开展开：观测 / 验证 / 声明 / 谱系）"
            items={[{ id: result.record.handoffId }]} />
        </div>
      )}
    </Panel>
  );
}

/** 检查结果：失败也如实列出，并说明它不妨碍封存 */
function CheckList({ result }: { result: CreateResult }) {
  const [open, setOpen] = useState(false);
  const passed = result.verifications.filter((v) => v.result === "通过").length;
  return (
    <Disclosure label={`检查结论：${result.verifications.length ? `${passed} 通过 / ${result.verifications.length - passed} 未通过` : "未执行检查"}`}
      open={open} onToggle={() => setOpen(!open)} tone={result.verifications.length && passed === result.verifications.length ? "green" : "amber"}>
      {result.verifications.length === 0 && (
        <div className="xs muted">本次未执行检查（状态如实记为「未执行」）。{result.warnings[0] ?? ""}</div>
      )}
      {result.verifications.map((v) => (
        <div className="check-row" key={v.checkId}>
          {v.result === "通过" ? <Check size={15} className="green" /> : <Info size={15} className={v.result === "失败" || v.result === "执行器错误" ? "red" : "faint"} />}
          <div><b className="small">{v.name}</b><div className="xs faint mono">{v.cmd} · {v.result} · 退出码 {v.exitCode ?? "-"} · {v.durationMs}ms</div></div>
          <span className={"badge " + (v.result === "通过" ? "green" : v.result === "失败" || v.result === "执行器错误" ? "red" : "")}>{v.result}</span>
        </div>
      ))}
      {result.verifications.length > 0 && (
        <div className="xs faint" style={{ marginTop: 8 }}>
          失败测试同样是有效交接内容：这些结论只证明"该检查在该快照与该环境上的结果"，接手方在自己的机器上复跑前不算已验证。
        </div>
      )}
    </Disclosure>
  );
}
