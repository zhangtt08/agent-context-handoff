import { useEffect, useState, type ReactNode } from "react";
import { Minus, Square, Copy, X, Sun, Moon, TriangleAlert, Info, Check } from "lucide-react";
import { windowControls, desktopPlatform, copyText, pathFromDrop, type PreviewAlert } from "../api";

/** 拖放区：拖入文件后回调本机路径（桌面版）；拖悬时显示遮罩提示 */
export function DropArea({ onPath, hint, children }: { onPath: (p: string | null) => void; hint: string; children: ReactNode }) {
  const [drag, setDrag] = useState(false);
  return (
    <div
      className="drop-wrap"
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrag(false); }}
      onDrop={(e) => { e.preventDefault(); setDrag(false); onPath(pathFromDrop(e.dataTransfer.files?.[0])); }}
    >
      {children}
      {drag && <div className="drop-overlay">{hint}</div>}
    </div>
  );
}

function WindowControls() {
  const controls = windowControls();
  const platform = desktopPlatform();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!controls) return;
    let alive = true;
    void controls.isMaximized().then((v) => { if (alive) setMaximized(v); }).catch(() => {});
    const unsubscribe = controls.onMaximizedChange(setMaximized);
    return () => { alive = false; unsubscribe(); };
  }, [controls]);

  if (!controls || platform === "darwin") return null;

  return (
    <div className="win-controls">
      <button type="button" className="win-btn" title="最小化" onClick={() => void controls.minimize().catch(() => {})}>
        <Minus size={15} />
      </button>
      <button type="button" className="win-btn" title={maximized ? "向下还原" : "最大化"} onClick={() => void controls.toggleMaximize().catch(() => {})}>
        {maximized ? <Copy size={13} /> : <Square size={12} />}
      </button>
      <button type="button" className="win-btn close" title="关闭" onClick={() => void controls.close().catch(() => {})}>
        <X size={15} />
      </button>
    </div>
  );
}

/** 页眉：整页唯一的导航位 —— 项目选择 + 换项目/管理 + 主题 + 窗口三键 */
export function Topbar({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    localStorage.getItem("acb-theme") === "dark" ? "dark" : "light");
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("acb-theme", theme);
  }, [theme]);

  const onDoubleClick = (e: React.MouseEvent<HTMLElement>) => {
    if ((e.target as HTMLElement).closest("button, a, input, select")) return;
    void windowControls()?.toggleMaximize().catch(() => {});
  };

  return (
    <header className="topbar" onDoubleClick={onDoubleClick}>
      <div className="logo-mark">ACB</div>
      <div className="crumb">{children}</div>
      <div className="right">
        {actions}
        <button className="icon-btn" title={theme === "light" ? "切换暗色" : "切换亮色"} onClick={() => setTheme(theme === "light" ? "dark" : "light")}>
          {theme === "light" ? <Moon size={15} /> : <Sun size={15} />}
        </button>
      </div>
      <WindowControls />
    </header>
  );
}

export function Panel({ title, step, hint, corner, children, headExtra, style }: {
  title: ReactNode; step?: string; hint?: ReactNode; corner?: boolean;
  children: ReactNode; headExtra?: ReactNode; style?: React.CSSProperties;
}) {
  return (
    <section className={"panel" + (corner ? " cornered" : "")} style={style}>
      <div className="panel-head">
        {step && <span className="step-no">{step}</span>}
        <h3>{title}</h3>
        {headExtra}
        {hint && <span className="head-hint">{hint}</span>}
      </div>
      <div className="panel-body">{children}</div>
    </section>
  );
}

/** 折叠块：默认收起，标题上就给出内容量，不让人靠点开找 */
export function Disclosure({ label, count, open, onToggle, tone, children }: {
  label: ReactNode; count?: ReactNode; open: boolean; onToggle: () => void;
  tone?: string; children: ReactNode;
}) {
  return (
    <div className={"disc " + (open ? "open" : "")}>
      <button type="button" className="disc-head" onClick={onToggle}>
        <span className={"disc-caret" + (open ? " up" : "")}>▸</span>
        <span className="disc-label">{label}</span>
        {count !== undefined && <span className={"badge " + (tone ?? "")}>{count}</span>}
      </button>
      {open && <div className="disc-body">{children}</div>}
    </div>
  );
}

export function AlertCard({ a }: { a: PreviewAlert }) {
  const tone = a.level === "阻塞" ? "block" : a.level === "警告" ? "warn" : "info";
  return (
    <div className={"alert " + tone}>
      <h6>
        {a.level === "提示" ? <Info size={14} className="teal" /> : <TriangleAlert size={14} className={a.level === "阻塞" ? "red" : "amber"} />}
        {a.title}
        <span className={"badge " + (a.level === "阻塞" ? "red" : a.level === "警告" ? "amber" : "teal")} style={{ marginLeft: "auto" }}>{a.level}</span>
      </h6>
      <div className="d">{a.detail}</div>
      <div className="a"><b>出路</b> {a.action}</div>
    </div>
  );
}

/** 复制按钮：一键给出成功/失败，且复制的内容本身可见 */
export function CopyButton({ text, label = "复制", sm = true }: { text: string; label?: string; sm?: boolean }) {
  const [done, setDone] = useState<string | null>(null);
  return (
    <button
      className={"btn " + (sm ? "sm " : "") + (done === "已复制" ? "ok" : "ghost")}
      onClick={() => void copyText(text).then((r) => {
        setDone(r);
        setTimeout(() => setDone(null), 2600);
      })}
    >
      {done === "已复制" ? <><Check size={13} className="green" /> 已复制</>
        : done ? <><TriangleAlert size={13} className="red" /> {done}</>
        : <><Copy size={13} /> {label}</>}
    </button>
  );
}

/** 打开本机文件/目录：桌面版才有，浏览器端整块不渲染 */
export function OpenLink({ path, label }: { path: string; label: string }) {
  const [err, setErr] = useState<string | null>(null);
  if (!window.acb?.openPath) return null;
  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
      <button className="btn sm ghost" title={path}
        onClick={() => void window.acb!.openPath!(path).then((r) => { if (r && r !== "ok") setErr(r); }).catch((e: Error) => setErr(e.message))}>
        {label}
      </button>
      {err && <span className="xs red">{err}</span>}
    </span>
  );
}
