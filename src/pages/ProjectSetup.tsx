import { useEffect, useState } from "react";
import { FolderGit2, FolderOpen, Loader, Plus, Save, Trash2, TriangleAlert, Wrench } from "lucide-react";
import { useProject } from "../state";
import { api, bridgeLineZh, type ProjectConfig } from "../api";

/**
 * 本机设置：项目库（注册/移除）+ 检查命令。
 * 检查命令是唯一"以后会被执行"的配置，所以保存前把要执行的原文亮出来。
 */
export default function ProjectSetup({ onChanged }: { onChanged: () => Promise<void> }) {
  const { projects, active, setActiveId, refresh } = useProject();
  const [cfg, setCfg] = useState<ProjectConfig | null>(null);
  const [name, setName] = useState("");

  const [checks, setChecks] = useState<{ name: string; cmd: string }[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [regPath, setRegPath] = useState("");
  const [delId, setDelId] = useState<string | null>(null);

  useEffect(() => {
    if (!active) { setCfg(null); return; }
    void (async () => {
      try {
        const c = await api.config(active.projectId);
        setCfg(c); setName(c.name); setChecks(c.checks.map((x) => ({ ...x })));
        setErr(null);
      } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    })();
  }, [active]);

  const say = (t: string) => { setMsg(t); setTimeout(() => setMsg(null), 4000); };

  const save = async () => {
    if (!active) return;
    setBusy("save"); setErr(null);
    try {
      const clean = checks.filter((c) => c.name.trim() && c.cmd.trim());
      await api.saveConfig(active.projectId, { name: name.trim() || undefined, checks: clean });
      await refresh();
      say(`已保存：${clean.length} 条检查命令 ${clean.map((c) => c.cmd).join(" / ") || "（无）"}`);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    setBusy(null);
  };

  const register = async (p: string, demo = false) => {
    setBusy(demo ? "demo" : "reg"); setErr(null);
    try {
      const c = demo ? await api.seedDemo() : await api.registerProject(p);
      await refresh();
      setActiveId(c.projectId);
      setRegPath("");
      say(`已加入项目库：${c.name}${c.bridge ? ` · ${bridgeLineZh(c.bridge)}` : ""}`);
      await onChanged();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    setBusy(null);
  };

  const remove = async (id: string) => {
    setBusy("del:" + id); setErr(null);
    try {
      await api.removeProject(id);
      await refresh();
      setDelId(null);
      say("已从项目库移除（项目目录与其中已封存的交接数据一个字节没动，重新注册即可恢复管理）");
      await onChanged();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    setBusy(null);
  };

  return (
    <div className="setup">
      {err && <div className="notice warn" style={{ marginBottom: 12 }}><TriangleAlert size={15} className="red" /><div className="xs red">{err}</div></div>}
      {msg && <div className="notice info" style={{ marginBottom: 12 }}><div className="xs">{msg}</div></div>}

      <div className="su-col">
        <div className="su-title"><FolderGit2 size={14} className="amber" /> 项目库</div>
        <div className="row">
          <input className="acb-input mono" value={regPath} onChange={(e) => setRegPath(e.target.value)}
            placeholder="仓库绝对路径，如 D:\\dev\\my-project（也可直接把文件夹拖到页面上）" />
          {window.acb?.pickFolder && (
            <button className="btn" onClick={() => void window.acb!.pickFolder!().then((d) => { if (d) setRegPath(d); })}>
              <FolderOpen size={14} />
            </button>
          )}
          <button className="btn primary" disabled={!regPath.trim() || busy !== null} onClick={() => void register(regPath.trim())}>
            {busy === "reg" ? <Loader size={13} className="spin" /> : <Plus size={13} />} 注册
          </button>
        </div>
        <div className="xs faint" style={{ margin: "8px 0 10px" }}>
          必须是 Git 仓库；裸仓库会被拒绝并说明原因。
          <button className="btn sm ghost" style={{ marginLeft: 6 }} disabled={busy !== null} onClick={() => void register("", true)}>
            {busy === "demo" ? <Loader size={11} className="spin" /> : <Wrench size={11} />} 生成示例项目练手
          </button>
        </div>
        {projects.map((p) => (
          <div className="pick-row" key={p.projectId}>
            <FolderGit2 size={13} className={p.projectId === active?.projectId ? "amber" : "faint"} />
            <div style={{ flex: 1, minWidth: 0 }} onClick={() => setActiveId(p.projectId)}>
              <b className="small">{p.name}</b>
              {p.projectId === active?.projectId && <span className="badge green" style={{ marginLeft: 6 }}>当前</span>}
              <div className="xs faint mono" style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{p.path}</div>
            </div>
            {delId === p.projectId ? (
              <span className="row" style={{ margin: 0 }}>
                <button className="btn sm ghost" disabled={busy !== null} onClick={() => setDelId(null)}>取消</button>
                <button className="btn sm primary" disabled={busy !== null} onClick={() => void remove(p.projectId)}>
                  {busy === "del:" + p.projectId ? <Loader size={11} className="spin" /> : <Trash2 size={11} />} 确认移除
                </button>
              </span>
            ) : (
              <button className="btn sm ghost" onClick={() => setDelId(p.projectId)}><Trash2 size={11} /></button>
            )}
          </div>
        ))}
      </div>

      <div className="su-col">
        <div className="su-title"><Save size={14} className="amber" /> {active ? `${active.name} 的设置` : "先选一个项目"}</div>
        {!active && <div className="xs muted">左边注册或点选一个项目后，这里就能配置它的检查命令。</div>}
        {cfg && (
          <>
            <label className="fld">
              <span>项目名称</span>
              <input className="acb-input" value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <div className="fld">
              <span>检查命令（每次打包时执行；失败也照样封存，结果写进简报）</span>
              {checks.map((c, i) => (
                <div className="row" key={i} style={{ marginBottom: 6 }}>
                  <input className="acb-input" style={{ width: 150 }} value={c.name} placeholder="名称，如 测试"
                    onChange={(e) => setChecks(checks.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)))} />
                  <input className="acb-input mono" style={{ flex: 1 }} value={c.cmd} placeholder="命令，如 npm test"
                    onChange={(e) => setChecks(checks.map((x, k) => (k === i ? { ...x, cmd: e.target.value } : x)))} />
                  <button className="btn sm ghost" title="删除这条检查" onClick={() => setChecks(checks.filter((_, k) => k !== i))}>
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
              <button className="btn sm ghost" onClick={() => setChecks([...checks, { name: "", cmd: "" }])}>
                <Plus size={12} /> 添加检查
              </button>
            </div>
            <button className="btn primary block" disabled={busy !== null} onClick={() => void save()}>
              {busy === "save" ? <Loader size={14} className="spin" /> : <Save size={14} />} 保存这个项目
            </button>
          </>
        )}
      </div>
    </div>
  );
}
