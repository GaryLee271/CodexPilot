/** Codex 托盘状态与主窗口操作协议。 */
export type TrayOverview = {
  status?: string;
  codex_app?: { status: string; path: string | null } | null;
  codex_version?: string | null;
  runtime_health?: {
    codex_app?: { status: string } | null;
    debugger?: { status: string } | null;
  } | null;
};

export type CodexState = "unknown" | "missing" | "stopped" | "running";

export function codexState(overview: TrayOverview | null): CodexState {
  if (!overview) return "unknown";
  if (overview.codex_app?.status === "missing") return "missing";
  const status = overview.runtime_health?.codex_app?.status;
  if (status === "running") return "running";
  if (!status || status === "not_checked") return "unknown";
  return "stopped";
}

/** Codex 在运行且 Codex Pilot 的调试连接已连上（增强功能生效）。 */
export function codexEnhanced(overview: TrayOverview | null): boolean {
  return codexState(overview) === "running" && overview?.runtime_health?.debugger?.status === "connected";
}

/** 面板发给主窗口的请求（主窗口执行后回一个结果）。 */
export type TrayRequest =
  | { id: string; kind: "navigate"; route: TrayRoute }
  | { id: string; kind: "launch" | "restart" | "stop" };

export type TrayResult = { id: string; ok: boolean; message?: string };

/** 面板能直接打开的主窗口页面。 */
export const TRAY_ROUTES = ["overview", "enhance", "settings"] as const;
export type TrayRoute = (typeof TRAY_ROUTES)[number];

export function isTrayRoute(value: unknown): value is TrayRoute {
  return typeof value === "string" && (TRAY_ROUTES as readonly string[]).includes(value);
}

export const TRAY_REQUEST_EVENT = "codex-plus-tray-request";
export const TRAY_RESULT_EVENT = "codex-plus-tray-result";
/** 主窗口注册好 TRAY_REQUEST_EVENT 监听后发出（后端据此判断重建的主窗口能否接收请求，#2677）。 */
export const MAIN_WINDOW_READY_EVENT = "codex-plus-main-window-ready";

/** 校验主窗口收到的请求，字段不对的一律丢掉。 */
export function parseTrayRequest(value: unknown): TrayRequest | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || !raw.id) return null;
  if (raw.kind === "navigate") return isTrayRoute(raw.route) ? { id: raw.id, kind: "navigate", route: raw.route } : null;
  if (raw.kind === "launch" || raw.kind === "restart" || raw.kind === "stop") return { id: raw.id, kind: raw.kind };
  return null;
}
