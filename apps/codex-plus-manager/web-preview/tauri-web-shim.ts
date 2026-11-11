type CommandResult = {
  status: string;
  message: string;
  [key: string]: unknown;
};

const ok = <T extends Record<string, unknown>>(payload: T = {} as T): CommandResult & T => ({
  status: "ok",
  message: "演示模式",
  ...payload,
});

// 预览只模拟现行设置，不再向表单混入已退役功能。所有状态只在浏览器内存中变化。
const demoSettings = {
  revision: "web-preview",
  codexAppPath: "/Applications/Codex.app",
  codexAppAutoTakeover: false,
  codexAppAutoTakeoverWhenActive: "defer",
  enhancementsEnabled: true,
  updateAutoCheck: false,
  updateSkippedVersion: "",
  codexAppNativeMenuPlacement: true,
  codexAppNativeBrowserRequireIdentification: false,
  codexAppNativeFastUnlock: false,
  codexAppNativePredictions: false,
  codexAppNativeProjectSections: false,
  codexAppConversationTabs: false,
  codexAppConversationList: false,
  codexAppNativePredictionsModel: "",
  codexGoalsEnabled: false,
};
const initialSettings = { ...demoSettings };
const demoWatcher = { enabled: false, start_minimized: false, start_codex: false, start_codex_on_open: false };

const overview = ok({
  codex_app: { status: "found", path: "/Applications/Codex.app" },
  codex_version: "1.10.0",
  silent_shortcut: { status: "installed", path: null },
  management_shortcut: { status: "installed", path: null },
  latest_launch: null,
  runtime_health: {
    codex_app: { status: "stopped", address: null, message: "等待启动" },
    debugger: { status: "disconnected", address: null, message: "等待 Codex 连接" },
  },
  current_version: "0.0.1",
  update_status: "up_to_date",
  settings_path: "演示模式",
  logs_path: "演示模式",
});

const demoUserScripts = { enabled: true, skip_next_start: false, builtins: [], scripts: [] };
const settingsResult = () => ok({ revision: demoSettings.revision, settings: { ...demoSettings }, settings_path: "演示模式", builtin_extensions: demoUserScripts });

export async function invoke<T = unknown>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  switch (command) {
    case "startup_options": return ok({ showUpdate: false }) as T;
    case "consume_pending_manager_navigation": return null as T;
    case "load_overview": return overview as T;
    case "native_browser_status": return {
      compatibility: { state: "not_started", detail: "" },
      connection: { state: "available", browsers: [{ family: "edge", recognized: true, headerEnabled: false }], failedChecks: 0 },
    } as T;
    case "load_settings":
    case "save_settings":
    case "reset_settings":
    case "set_settings_path":
    case "reset_settings_path":
    case "reload_builtin_extensions":
      if (command === "save_settings" && args.settings) {
        Object.assign(demoSettings, args.settings, { revision: `web-preview-${Date.now()}` });
      }
      if (command === "reset_settings") Object.assign(demoSettings, initialSettings);
      return settingsResult() as T;
    case "load_watcher_state": return ok({ ...demoWatcher }) as T;
    case "load_auto_takeover_state": return ok({ running: demoSettings.codexAppAutoTakeover, enabled: demoSettings.codexAppAutoTakeover, state: "idle", platformSupported: true, message: "演示模式" }) as T;
    case "codex_app_running": return (overview.runtime_health.codex_app.status === "running") as T;
    case "launch_codex_plus":
    case "restart_codex_plus": {
      const startedAt = Date.now();
      Object.assign(overview, { latest_launch: { status: "running", phase: "ready", message: "演示模式", started_at_ms: startedAt } });
      overview.runtime_health.codex_app.status = "running";
      overview.runtime_health.debugger.status = "connected";
      return ok({ launchStartedAtMs: startedAt }) as T;
    }
    case "stop_codex_plus":
      overview.runtime_health.codex_app.status = "stopped";
      overview.runtime_health.debugger.status = "disconnected";
      Object.assign(overview, { latest_launch: { status: "stopped", phase: "user_stopped", message: "演示模式", started_at_ms: Date.now() } });
      return ok() as T;
    case "set_watcher_enabled": demoWatcher.enabled = Boolean(args.enabled); return ok({ ...demoWatcher }) as T;
    case "set_watcher_start_minimized": demoWatcher.start_minimized = Boolean(args.minimized); return ok({ ...demoWatcher }) as T;
    case "set_watcher_start_codex": demoWatcher.start_codex = Boolean(args.startCodex); return ok({ ...demoWatcher }) as T;
    case "set_watcher_start_codex_on_open": demoWatcher.start_codex_on_open = Boolean(args.enabled); return ok({ ...demoWatcher }) as T;
    default: return ok() as T;
  }
}

export function convertFileSrc(path: string): string {
  return path;
}
