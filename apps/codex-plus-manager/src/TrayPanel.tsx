/** 只提供 Codex 状态与增强入口，不读取供应商、用量或会话。 */
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { t } from "./i18n";
import { codexEnhanced, codexState, TRAY_REQUEST_EVENT, TRAY_RESULT_EVENT, TRAY_ROUTES, type TrayOverview, type TrayRequest, type TrayResult, type TrayRoute } from "./tray-panel-model";
import { applyResolvedTheme, loadThemePreference, resolveTheme, systemPrefersDark, watchSystemTheme } from "./theme-mode";
import "./TrayPanel.css";

const labels: Record<TrayRoute, string> = {overview: "概览", enhance: "内置拓展", settings: "设置"};
export function TrayPanel() {
  const [overview, setOverview] = useState<TrayOverview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef<string | null>(null);
  const timeout = useRef<number | null>(null);
  const load = () => invoke<TrayOverview>("load_overview").then(setOverview).catch(() => {});
  useEffect(() => {
    const theme = () => applyResolvedTheme(resolveTheme(loadThemePreference(), systemPrefersDark()));
    theme(); void load();
    const timer = window.setInterval(() => {if (document.visibilityState === "visible") void load();}, 5000);
    const stopTheme = watchSystemTheme(theme);
    window.addEventListener("storage", theme); window.addEventListener("focus", load);
    let disposed = false; let stop: (() => void) | undefined;
    void listen<TrayResult>(TRAY_RESULT_EVENT, ({payload}) => {
      if (pending.current !== payload.id) return;
      pending.current = null; setBusy(false);
      if (timeout.current) window.clearTimeout(timeout.current);
      if (!payload.ok) setError(payload.message || t("没有完成，详情见主窗口。"));
      void load();
    }).then(unlisten => {if(disposed) unlisten(); else stop = unlisten;});
    return () => {disposed = true; stop?.(); stopTheme(); window.clearInterval(timer); if(timeout.current) window.clearTimeout(timeout.current); window.removeEventListener("storage", theme); window.removeEventListener("focus", load);};
  }, []);
  // 托盘只保留未运行时的启动入口，停止和重启统一移至主窗口左下角。
  const requestLaunch = async () => {
    if (pending.current) return;
    const id = crypto.randomUUID(); pending.current = id; setBusy(true); setError("");
    timeout.current = window.setTimeout(() => {if(pending.current === id) {pending.current = null;setBusy(false);setError(t("主窗口没有回应，请打开 Codex Pilot 查看。"));}}, 90_000) as unknown as number;
    try {await invoke("main_window_prepare"); await emit(TRAY_REQUEST_EVENT, {id,kind: "launch"} satisfies TrayRequest);}
    catch(e) {pending.current = null;setBusy(false);if(timeout.current) window.clearTimeout(timeout.current);setError(String(e));}
  };
  const openRoute = async (route: TrayRoute) => {
    try {await invoke("main_window_prepare");await emit(TRAY_REQUEST_EVENT, {id: crypto.randomUUID(),kind: "navigate",route} satisfies TrayRequest);}
    finally {void invoke("tray_panel_action", {action: "open"});}
  };
  const state = codexState(overview);
  return <div className="tray-panel"><header className="tp-head"><strong>Codex Pilot</strong><button onClick={() => void load()}>{t("刷新")}</button></header><main className="tp-body"><section className="tp-card"><h3>Codex {overview?.codex_version}</h3><p>{state === "running" ? t("运行中") : state === "missing" ? t("未找到 Codex") : state === "unknown" ? t("检查中…") : t("未运行")}</p><p>{codexEnhanced(overview) ? t("增强功能已生效") : t("增强功能未连接")}</p>{state !== "running" ? <div className="tp-actions"><button disabled={busy || state === "missing" || state === "unknown"} onClick={() => void requestLaunch()}>{t("启动 Codex")}</button></div> : null}</section>{error ? <p role="alert">{error}</p> : null}<nav className="tp-quick-links">{TRAY_ROUTES.map(route => <button key={route} onClick={() => void openRoute(route)}>{t(labels[route])}</button>)}</nav></main><footer className="tp-foot"><button onClick={() => void invoke("tray_panel_action",{action:"open"})}>{t("打开 Codex Pilot")}</button><button onClick={() => void invoke("tray_panel_action",{action:"quit"})}>{t("退出")}</button></footer></div>;
}
