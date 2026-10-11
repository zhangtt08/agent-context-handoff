// 入参注入防线：本机路径、交接 ID、包内相对路径
//
// 为什么需要（2026-10-05 验收判为 BLOCKER，跨电脑分支删除后本机分支同样成立）：
// targetDir / handoffId / path 都来自 HTTP body 或 Agent 工具入参，随后被拼进文件路径或 git argv。
// argv 里没有 shell，`;rm -rf` 这类写法本来就没用，但两类输入仍然致命：
//   1. 控制字符与换行 —— 换行能把一条参数伪造成两条 ref；
//   2. `..`、盘符、UNC —— 拼进 path.join 就能写到目标目录外面。
// 判据一律用固定形态白名单，绝不拿输入自己的片段当基准。
import { isSafeRelPath } from "./gitutil.js";

export class UnsafeArgumentError extends Error {
  constructor(value: string, why: string, remedy: string) {
    super(`不安全的入参「${clip(value)}」：${why}。出路：${remedy}`);
    this.name = "UnsafeArgumentError";
  }
}

function clip(v: string): string {
  return v.length > 120 ? v.slice(0, 120) + "…" : v;
}

/** 控制字符与换行：路径或 ID 里出现它们一律是伪造 */
function hasControl(v: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(v);
}

/** 路径类入参（targetDir / 目录名）不是 git 参数，但同样要挡控制字符 */
export function assertNoControl(v: string, field: string): string {
  if (hasControl(v)) throw new UnsafeArgumentError(v, `${field} 含控制字符`, "换成正常路径");
  return v;
}

/** 交接 ID 形态：它会被拼进 <project>/.acb/store/handoffs/<id>/，所以先按形态判死再拼 */
export function assertSafeHandoffId(raw: unknown, field = "handoffId"): string {
  const v = typeof raw === "string" ? raw.trim() : "";
  if (!/^hnd_[A-Za-z0-9]+$/.test(v)) {
    throw new UnsafeArgumentError(String(raw ?? ""), `${field} 应形如 hnd_<十六进制>，收到的是别的东西`, "留空则取本项目最新一条，或从「本项目的交接记录」里复制 ID");
  }
  return v;
}

/** 包内相对路径守卫：resume 按清单写盘时，路径来自包内 manifest，必须当不可信数据处理 */
export function assertSafeRelPath(p: string, field = "path"): string {
  if (!isSafeRelPath(p)) throw new UnsafeArgumentError(p, `${field} 不是干净的项目相对路径`, "用不带 .. 与盘符的相对路径");
  return p;
}
