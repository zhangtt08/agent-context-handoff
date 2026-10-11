import { useCallback, useEffect, useState } from "react";
import { Eye, Loader, RefreshCw, TriangleAlert } from "lucide-react";
import { CopyButton, Disclosure, OpenLink } from "../components/Shell";
import { agentPrompt, api, fmtTime, shortDigest, type HandoffRecord } from "../api";

type Detail = { record: HandoffRecord; project: { name: string; path: string }; children: string[] };
type Integrity = { ok: boolean; entryCount: number; verifiedCount: number; broken: string[]; label: string };

/** 交接档案列表：一条交接一行，点行才展开并实测包完整性（逐条目 SHA-256） */
export default function ArchiveList({ items, title }: {
  title?: string;
  items: { id: string; taskName?: string; meta?: string; badges?: { label: string; tone: string }[] }[];
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [extra, setExtra] = useState<string[]>([]);
  const known = new Map(items.map((i) => [i.id, i]));
  const ids = [...new Set([...items.map((i) => i.id), ...extra])];

  return (
    <div>
      {title && <div className="xs muted" style={{ margin: "10px 0 6px" }}>{title}</div>}
      {ids.map((id) => {
        const it = known.get(id);
        return (
          <Disclosure key={id}
            label={<>
              {it?.taskName ? <b>{it.taskName}</b> : null}
              <span className="mono" style={{ marginLeft: it?.taskName ? 8 : 0 }}>{id}</span>
              {it?.meta && <span className="xs faint" style={{ marginLeft: 8 }}>{it.meta}</span>}
            </>}
            open={openId === id} onToggle={() => setOpenId(openId === id ? null : id)}
            count={it?.badges?.length ? <span className="row" style={{ margin: 0, gap: 5 }}>{it.badges.map((b) => <span key={b.label} className={"badge " + b.tone}>{b.label}</span>)}</span> : "档案"}
            tone={openId === id ? "amber" : ""}
          >
            <Body id={id} onOpenOther={(p) => { if (!ids.includes(p)) setExtra((x) => [...x, p]); setOpenId(p); }} />
          </Disclosure>
        );
      })}
    </div>
  );
}

function Body({ id, onOpenOther }: { id: string; onOpenOther: (id: string) => void }) {
  const [data, setData] = useState<Detail | null>(null);
  const [integrity, setIntegrity] = useState<Integrity | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    setErr(null);
    try { setData(await api.handoff(id)); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); return; }
    try { setIntegrity(await api.integrity(id)); } catch { setIntegrity(null); }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  if (err) return <div className="xs red">{err}</div>;
  if (!data) return <div className="xs muted" style={{ padding: "10px 0" }}><Loader size={13} className="spin amber" /> 正在读取档案并逐条目实算 SHA-256…</div>;

  const s = data.record.state;
  const briefPath = `${data.record.packageDir}\\HANDOFF.md`;
  const prompt = agentPrompt(briefPath, s.taskName);

  return (
    <div>
      <div className="row" style={{ marginBottom: 10 }}>
        <CopyButton text={prompt} label="（备用）复制这段话给下一个 Agent" />
        <OpenLink path={briefPath} label="打开简报" />
        <OpenLink path={data.record.packageDir} label="打开包目录" />
        <button className="btn sm ghost" onClick={() => void load()}><RefreshCw size={12} /> 重读</button>
      </div>

      <dl className="kv">
        <dt>任务</dt><dd>{s.taskName} <span className="mono xs faint">（{s.taskId}）</span></dd>
        <dt>项目身份</dt><dd className="mono">{s.projectName} · {s.projectId}</dd>
        <dt>快照</dt><dd className="mono">{s.snapshotId}（不可变）· {s.changes.length} 项改动</dd>
        <dt>代码指纹</dt><dd className="mono amber">{shortDigest(s.sourceDigest)}</dd>
        <dt>基线</dt><dd className="mono">{s.baseline.branch ?? "(无)"} @ {s.baseline.commit?.slice(0, 7) ?? "无"}</dd>
        <dt>形态</dt><dd className="mono xs">
          链接 {s.changes.filter((c) => c.mode === "120000").length} · 可执行 {s.changes.filter((c) => c.mode === "100755").length} ·
          删除 {s.changes.filter((c) => c.status === "deleted").length} · 重命名 {s.changes.filter((c) => c.status === "renamed").length} · 暂存 {s.changes.filter((c) => c.staged).length}
        </dd>
        <dt>排除</dt><dd className="xs muted">{s.excluded.length ? s.excluded.join("、") : "无排除项"}</dd>
        <dt>必需能力</dt><dd className="mono xs">{s.capabilities.join(" · ")}</dd>
        <dt>接续自</dt><dd className="mono xs">{s.parentHandoffIds.length ? s.parentHandoffIds.join("、") : "—（这是链条的第一条）"}</dd>
        <dt>后继</dt><dd className="mono xs">{data.children.length ? data.children.join("、") : "—"}</dd>
      </dl>

      {s.parentHandoffIds.length > 0 && (
        <div className="row" style={{ marginTop: 8 }}>
          {s.parentHandoffIds.map((p) => (
            <button key={p} className="btn sm ghost" onClick={() => onOpenOther(p)}><Eye size={12} /> 打开父交接 {p}</button>
          ))}
          {data.children.map((c) => (
            <button key={c} className="btn sm ghost" onClick={() => onOpenOther(c)}><Eye size={12} /> 后继 {c}</button>
          ))}
        </div>
      )}

      <div className={"badge " + (integrity ? (integrity.ok ? "green" : "red") : "")} style={{ margin: "12px 0 6px" }}>
        {integrity ? integrity.label : "完整性核对中…"}
      </div>
      <div className="xs faint">
        {integrity ? `逐条目实算 ${integrity.verifiedCount}/${integrity.entryCount} 通过` : ""} ·
        包按设计不可原地修改：不通过就在本机重新创建一次交接，而不是改包里的文件。
      </div>
      {integrity && !integrity.ok && (
        <div className="xs red" style={{ marginTop: 4 }}>未通过条目：{integrity.broken.slice(0, 5).join("、")}{integrity.broken.length > 5 ? " 等" : ""}</div>
      )}

      {s.recoveryRequirements.length > 0 && (
        <div className="notice warn" style={{ marginTop: 10 }}>
          <TriangleAlert size={15} className="amber" />
          <div className="xs"><b className="amber">接手这边需本机补齐：</b>{s.recoveryRequirements.join("；")}</div>
        </div>
      )}

      <div className="trust3">
        <TrustCol kind="teal" head="观测" sub="来自 Git / 文件系统 / 环境的事实" items={s.observations.map((o) => ({
          main: o.text, meta: `${fmtTime(o.at)} · ${o.source} · ${o.scope}`,
        }))} empty="无观测记录。" />
        <TrustCol kind="green" head="验证记录" sub="绑定该快照的检查结果" items={s.verifications.map((v) => ({
          main: `${v.name} · ${v.result}${v.exitCode !== null ? ` · 退出码 ${v.exitCode}` : ""}`,
          meta: `${v.snapshotId} · ${v.durationMs}ms`, tail: v.logTail, bad: v.result !== "通过" && v.result !== "未执行",
        }))} empty="本次未执行检查（如实记为未执行）。" />
        <TrustCol kind="amber" head="Agent 声明" sub="工作解释与建议，不等同验证" items={s.claims.map((c) => ({
          main: c.text + (c.nextStep ? ` → 下一步：${c.nextStep}` : ""),
          meta: `${c.sessionId} · ${fmtTime(c.at)}${c.evidence ? ` · 证据：${c.evidence}` : ""}`, badge: c.evidence ? "关联证据" : "待确认",
          badgeTone: c.evidence ? "green" : "amber",
        }))} empty="无声明记录。" />
      </div>

    </div>
  );
}

function TrustCol({ kind, head, sub, items, empty }: {
  kind: "teal" | "green" | "amber"; head: string; sub: string; empty: string;
  items: { main: string; meta: string; tail?: string; bad?: boolean; badge?: string; badgeTone?: string }[];
}) {
  return (
    <div className="tcol">
      <div className={"trust-head hl-" + kind}><span className="t">{head}</span><span className="c">{items.length}</span></div>
      <div className="xs faint" style={{ padding: "6px 12px 0" }}>{sub}</div>
      <div className="trust-body">
        {items.length === 0 && <div className="xs faint">{empty}</div>}
        {items.map((it, i) => (
          <div className={"tcard " + kind + (it.bad ? " bad" : "")} key={i}>
            {it.main}
            {it.badge && <span className={"badge " + it.badgeTone} style={{ marginLeft: 6 }}>{it.badge}</span>}
            <div className="meta">{it.meta}</div>
            {it.tail && (
              <details className="xs faint" style={{ marginTop: 6 }}>
                <summary style={{ cursor: "pointer" }}>日志尾部</summary>
                <pre className="mono xs" style={{ whiteSpace: "pre-wrap", marginTop: 6 }}>{it.tail}</pre>
              </details>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
