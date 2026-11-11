import type { BuiltinExtensionCard, EnhancementSettingItem } from "./enhancement-catalog";
import type { CodexLaunchState } from "./CodexLaunchButton";
import type { TrayRequest, TrayResult } from "./tray-panel-model";
import type { CSSProperties, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { open, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { CheckCircle2, ChevronDown, Copy, Download, Info, RefreshCw, Settings, SlidersHorizontal, AppWindow, Bug, TriangleAlert, CircleX, Trash2, X } from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { Badge as UiBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeBrowserStatusView, nativeBrowserConsent } from "./native-browser-settings";

import { rebaseSettingsEdits } from "./settings-rebase";

import { Switch } from "./ManagerControls";
import { MAIN_WINDOW_READY_EVENT, parseTrayRequest, TRAY_REQUEST_EVENT, TRAY_RESULT_EVENT } from "./tray-panel-model";
import { AppSelect } from "./AppSelect";
import { AppDialogHost, appConfirm } from "./app-dialog";

import { noticeDuration, noticeTone } from "./notice-model";

import { CodexLaunchButton } from "./CodexLaunchButton";

import "./ToolPages.css";

import { ReleaseNotes } from "./ReleaseNotes";
import { UPDATE_CHECK_INTERVAL_MS, UpdateNotifications, updatePreferencesFrom } from "./update-notification";

import { managerNavigationDestination, type ManagerNavigationIntent } from "./enhancement-navigation";
import { builtinSettingValue, enhancementGroupAnchorId, enhancementItem, enhancementPlatformFromUserAgent, isEnhancementItemMasterGated, managerBuiltinCards, managerBuiltinGroups, withBuiltinSetting } from "./enhancement-catalog";

import { resolveLaunchStatus, launchCompletionNotice } from "./launch-status";
import { subscribeLanguage, getLanguage, setLanguage, t, tf } from "@/i18n";

import { applyResolvedTheme, loadThemePreference, resolveTheme, storeThemePreference, systemPrefersDark, watchSystemTheme, type ThemePreference } from "./theme-mode";

const isWindowsPlatform = /\bWindows\b/i.test(navigator.userAgent);
// macOS 使用内容延伸的窗口样式，侧栏顶部为原生窗口按钮留出安全区域。
const isMacOSPlatform = /\bMacintosh\b|\bMac OS X\b/i.test(navigator.userAgent);
// 增强清单按平台过滤，Windows 浏览器兼容不会出现在 macOS / Linux。
const enhancementPlatform = enhancementPlatformFromUserAgent(navigator.userAgent);

type Status = "ok" | "failed" | "not_implemented" | "not_checked" | string;

type CommandResult<T> = T & {
  status: Status;
  message: string;
};

type PathState = {
  status: string;
  path: string | null;
};

type LaunchStatus = {
  status: string;
  message: string;
  /** 阶段；运行控制中的主动停止写入 user_stopped，用来和意外退出区分。 */
  phase?: string | null;
  started_at_ms: number;
  debug_port: number | null;
  codex_app: string | null;
  aumid: string | null;
};

type RuntimeServiceState = { status: string; address: string | null; message: string };

type OverviewResult = CommandResult<{
  codex_app: PathState;
  codex_version: string | null;
  silent_shortcut: PathState;
  management_shortcut: PathState;
  latest_launch: LaunchStatus | null;
  runtime_health: { codex_app: RuntimeServiceState; debugger: RuntimeServiceState };
  current_version: string;
  update_status: string;
  settings_path: string;
  logs_path: string;
}>;

type LaunchCommandResult = CommandResult<{
  launchStartedAtMs?: number;
  nativeBrowserRestoreFailed?: boolean;
}>;

type BackendSettings = {
  revision?: string;
  codexAppPath: string;
  /** 自动接管官方 App（与 Rust `codex_app_auto_takeover` 对应）。 */
  codexAppAutoTakeover: boolean;
  codexAppAutoTakeoverWhenActive: string;

  /** 启动时及运行期间自动检查 Codex Pilot 更新（#1272），默认开。 */
  updateAutoCheck?: boolean;
  /** 更新提示里「跳过此版本」记下的版本（#1272）。 */
  updateSkippedVersion?: string;

  enhancementsEnabled: boolean;

  codexAppNativeMenuPlacement: boolean;
  codexAppNativeBrowserRequireIdentification: boolean;
  codexAppNativeFastUnlock: boolean;
  /** 原生输入预测（实验）：自定义 API 的本机对话使用 Codex 自带的灰字预测与 Tab 接受，默认关。 */
  codexAppNativePredictions: boolean;
  /** API 模式项目分区：仅使用独立本地存储，不关联账号，重启 Codex 后生效。 */
  codexAppNativeProjectSections: boolean;
  /** 本地对话标签栏：热切换，关闭后保留本机标签与顺序。 */
  codexAppConversationTabs: boolean;
  /** 跨项目会话列表：按最近更新时间统一列出会话，热切换。 */
  codexAppConversationList: boolean;
  /** 输入预测模型；空值跟随当前对话，使用对话原供应商。 */
  codexAppNativePredictionsModel: string;

  codexGoalsEnabled: boolean;
};

type BuiltinExtension = {
  id: string;
  key: string;
  name: string;
  description: string;
  group?: string;
  enabled: boolean;
  replacedBy?: string | null;
  /** 启停读写的设置字段；没有时启停记在用户脚本配置里。 */
  setting?: string | null;
  params?: string[];
  restartRequired?: boolean;
  replaceable?: boolean;
};

type BuiltinExtensionInventory = {
  builtins?: BuiltinExtension[];
};

type SettingsResult = CommandResult<{
  revision: string;
  settings: BackendSettings;
  settings_path: string;
  builtin_extensions: BuiltinExtensionInventory;
}>;

type DesktopCodexCliResult = CommandResult<{
  path: string | null;
}>;

type TaskProgress = {
  active: boolean;
  percent: number;
  message: string;
  indeterminate?: boolean;
  failed?: boolean;
};

type UpdateStage = "downloading" | "writing" | "launching";

type UpdateProgressEvent = {
  stage: UpdateStage;
  downloadedBytes: number;
  totalBytes: number | null;
  percent: number | null;
  elapsedMs: number;
};

type WatcherResult = CommandResult<{
  enabled: boolean;
  disabled_flag: string;
  start_minimized: boolean;
  start_codex: boolean;
  start_codex_on_open: boolean;
}>;

// 与 Rust 侧 `auto_takeover::AutoTakeoverPayload`（rename_all = "camelCase"）逐字段对齐。
// 少一个字段的表现是「状态行永远空白」，所以两边要一起改。
type AutoTakeoverResult = CommandResult<{
  state: string;
  enabled: boolean;
  platformSupported: boolean;
  activePolicy: string;
  lastTakeoverAtMs?: number | null;
  lastReason?: string | null;
  lastError?: string | null;
  actualDebugPort?: number | null;
  appRunning?: boolean | null;
  sessionOwned: boolean;
  sessionStatus?: string | null;
  restartsLastHour: number;
  restartsTotal: number;
  pausedInstance?: string | null;
  running: boolean;
}>;

type InstallResult = CommandResult<{
  silent_shortcut: { installed: boolean; path: string | null };
  management_shortcut: { installed: boolean; path: string | null };
}>;

type UpdateResult = CommandResult<{
  currentVersion: string;
  latestVersion?: string | null;
  releaseSummary?: string;
  assetName?: string | null;
  assetUrl?: string | null;
  updateAvailable?: boolean;
  installedPath?: string;
  progress?: number;
}>;

type StartupResult = CommandResult<{
  showUpdate: boolean;
}>;

/** 当前管理目标固定为 Codex。 */

/** Codex Pilot 自己的 logo：与应用图标（src-tauri/icons/icon.png）同一张图。 */
const APP_LOGO_URL = new URL("./assets/codex-pilot-logo.png", import.meta.url).href;

type Route = "enhance" | "settings";
// 托盘等旧入口仍可传入旧页面名，统一映射到当前两个页面。
type NavigationTarget = Route | "overview" | "maintenance";
type Theme = "dark" | "light";

const MANAGER_NAVIGATION_EVENT = "manager-navigation-requested";

const routes: Array<{ id: Route; label: string; icon: LucideIcon }> = [
{ id: "enhance", get label() { return t("增强"); }, icon: SlidersHorizontal },
{ id: "settings", get label() { return t("设置"); }, icon: Settings }];

const codexRunningPollMs = 5_000;

const defaultSettings: BackendSettings = {
  codexAppPath: "",
  codexAppAutoTakeover: false,
  codexAppAutoTakeoverWhenActive: "defer",

  updateAutoCheck: true,
  updateSkippedVersion: "",

  enhancementsEnabled: true,

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

export function App() {
  useSyncExternalStore(subscribeLanguage, getLanguage, getLanguage);
  const [themePreference, setThemePreference] = useState<ThemePreference>(() => loadThemePreference());
  const [systemDark, setSystemDark] = useState(() => systemPrefersDark());
  const theme: Theme = resolveTheme(themePreference, systemDark);
  const [route, setRoute] = useState<Route>(() => loadInitialRoute());
  /** 打开设置时要滚到的分组。 */
  const [settingsFocus, setSettingsFocus] = useState<string | null>(() => initialSettingsFocus());
  const [notice, setNotice] = useState<{ title: string; message: string; status?: Status } | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<{
    title: string;
    message: string;
    confirmText: string;
    cancelText: string;
    resolve: (confirmed: boolean) => void;
  } | null>(null);

  const [overview, setOverview] = useState<OverviewResult | null>(null);
  const [settings, setSettings] = useState<SettingsResult | null>(null);
  // 外部改设置时要拿「上次读到的设置」与当前编辑比对，监听回调里读这个 ref 拿最新值。
  const settingsRef = useRef<SettingsResult | null>(null);
  settingsRef.current = settings;

  const [watcher, setWatcher] = useState<WatcherResult | null>(null);
  const [update, setUpdate] = useState<UpdateResult | null>(null);
  const [updatePrompt, setUpdatePrompt] = useState<UpdateResult | null>(null);
  const updateNotifications = useRef(new UpdateNotifications());
  const updateCheckPending = useRef<{ manual: boolean } | null>(null);
  const updateInstallPending = useRef(false);
  // 更新提醒偏好以已保存的设置为准；草稿里的开关等自动保存落盘后才生效。
  useEffect(() => {
    if (settings) updateNotifications.current.setPreferences(updatePreferencesFrom(settings.settings));
  }, [settings]);
  const [updateInstallProgress, setUpdateInstallProgress] = useState<TaskProgress>({
    active: false,
    percent: 0,
    message: t("尚未运行安装包更新。"),
  });
  const prevLaunchStatusRef = useRef<string | null>(null);
  const overviewRequestSequence = useRef(0);
  const launchPendingRef = useRef(false);
  const [launchPending, setLaunchPending] = useState(false);

  const [settingsForm, setSettingsForm] = useState<BackendSettings>({ ...defaultSettings });

  const [autoTakeover, setAutoTakeoverState] = useState<AutoTakeoverResult | null>(null);
  const settingsDirty = useMemo(
    () => Boolean(settings && !backendSettingsEqual(settingsForm, settings.settings)),
    [settings, settingsForm],
  );

  const call = <T,>(command: string, args?: Record<string, unknown>) => {
    const snapshot = args?.settings as BackendSettings | undefined;
    return invoke<T>(command, command === "save_settings"
      ? { ...args, expectedRevision: snapshot?.revision || "" }
      : args).then((result) => {
        const response = result as { message?: string };
        if (command === "save_settings" && response?.message?.includes("settings_revision_conflict")) {
          // 所有保存调用都保留当前草稿，不能把失败响应当成新表单回填。
          throw new Error(response.message);
        }
        return result;
      });
  };

  const logDiagnostic = (event: string, detail: Record<string, unknown> = {}) => {
    void invoke("write_diagnostic_event", { event, detail }).catch(() => {});
  };

  const run = async <T,>(task: () => Promise<T>): Promise<T | null> => {
    try {
      return await task();
    } catch (error) {
      showNotice(t("调用失败"), stringifyError(error), "failed");
      return null;
    }
  };

  const refreshOverview = async (silent = false) => {
    const requestSequence = ++overviewRequestSequence.current;
    const result = await run(() => call<OverviewResult>("load_overview"));
    if (result && requestSequence === overviewRequestSequence.current) {
      // 崩溃检测：进程从运行状态变为停止/失败 → 弹出通知
      const prev = prevLaunchStatusRef.current;
      const current = result.latest_launch?.status;
      // 用户主动停止不算意外退出。
      const stoppedByUser = result.latest_launch?.phase === "user_stopped";
      if (prev && prev === "running" && current && !stoppedByUser && (current === "stopped" || current === "failed" || current === "crashed")) {
        showNotice(t("Codex 意外停止"), tf("进程状态：{0}。是否要重新启动？", [current]), "failed");
      }
      prevLaunchStatusRef.current = current ?? null;
      setOverview(result);
      if (!silent) showResultNotice(t("概览已检查"), result, { silentSuccess: true });
    }
  };

  const refreshSettings = async (silent = false) => {
    const result = await run(() => call<SettingsResult>("load_settings"));
    if (result) {
      setSettings(result);
      const normalized = normalizeSettings(result.settings);
      setSettingsForm(normalized);

      if (!silent) showResultNotice(t("设置已加载"), result, { silentSuccess: true });
      return normalized;
    }
    return null;
  };

  const reloadBuiltinExtensions = async (silent = false) => {
    const result = await run(() => call<SettingsResult>("reload_builtin_extensions"));
    if (result) {
      setSettings(result);
      showResultNotice(t("内置拓展"), result, { silentSuccess: silent });
    }
  };

  /// 启停单个拓展后热重载，Codex 页面才会真的装上 / 卸下它（与整体开关、保存配置一致）。
  const setBuiltinExtensionEnabled = async (key: string, enabled: boolean) => {
    const result = await run(() => call<SettingsResult>("set_builtin_extension_enabled", { key, enabled }));
    if (result) {
      setSettings(result);
      if (isSuccessStatus(result.status)) await reloadBuiltinExtensions();
      else showResultNotice(t("内置拓展"), result);
    }
  };

  const refreshWatcher = async (silent = false) => {
    const result = await run(() => call<WatcherResult>("load_watcher_state"));
    if (result) {
      setWatcher(result);
      if (!silent) showResultNotice(t("Watcher 状态"), result, { silentSuccess: true });
    }
  };

  /**
   * 读取自动接管状态。总开关关闭时不探测：守护线程本来就不工作，
   * 读到的只会是「未运行」，徒增一次 IPC。
   */
  const refreshAutoTakeover = async (silent = false) => {
    if (settings && !settings.settings.codexAppAutoTakeover) {
      setAutoTakeoverState(null);
      return;
    }
    const result = await run(() => call<AutoTakeoverResult>("load_auto_takeover_state"));
    if (result) {
      setAutoTakeoverState(result);
      if (!silent) showResultNotice(t("自动接管状态"), result, { silentSuccess: true });
    }
  };

  /** 开关必须走既有设置保存链路，才能在设置文件里持久化并被守护线程读到。 */
  const setAutoTakeover = async (enabled: boolean) => {
    if (!settings) return;
    const saved = await saveSettingsValue({ ...settings.settings, codexAppAutoTakeover: enabled }, false);
    if (!saved) return;
    setSettings((current) => (current ? { ...current, settings: saved } : current));
    if (enabled) {
      await refreshAutoTakeover(true);
    } else {
      setAutoTakeoverState(null);
    }
  };

  const runAutoTakeoverCommand = async (command: string) => {
    const result = await run(() => call<AutoTakeoverResult>(command));
    if (result) {
      setAutoTakeoverState(result);
      showResultNotice(t("自动接管"), result, { silentSuccess: false });
    }
  };

  const navigate = async (target: NavigationTarget) => {
    // 保留托盘和历史导航的入口语义，概览内容现在直接呈现在增强页。
    const next: Route = target === "maintenance" ? "settings" : target === "overview" ? "enhance" : target;
    setRoute(next);
    if (next === "enhance") await refreshOverview(true);

    // 两页共用表单与页头的保存任务；已有设置由变更事件同步，切页不重载待保存草稿。
    if (!settingsRef.current) await refreshSettings(true);
    if (next === "settings") {
      await refreshOverview(true);
      await refreshWatcher(true);
      await refreshAutoTakeover(true);
    }
  };
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  const consumePendingManagerNavigation = async (): Promise<boolean> => {
    try {
      const navigation = await invoke<ManagerNavigationIntent | null>("consume_pending_manager_navigation");
      if (!navigation) return false;
      const destination = managerNavigationDestination(navigation);
      await navigate(destination.route);
      return true;
    } catch (error) {
      logDiagnostic("manager.navigation_failed", { error: stringifyError(error) });
    }
    return false;
  };

  /** 启动 Codex；返回是否确认启动成功（托盘面板据此决定要不要把主窗口叫出来看提示）。 */
  const launch = async (): Promise<boolean> => {
    if (launchPendingRef.current) return false;
    launchPendingRef.current = true;
    setLaunchPending(true);
    try {
      const result = await launchCommand("launch_codex_plus");
      if (!result) return false;
      if (!isSuccessStatus(result.status)) {
        showNotice(t("启动任务"), result.message, result.status);
        return false;
      }
      showNotice(t("启动任务"), t("正在等待 Codex 启动结果…"), "accepted");
      const completion = await waitForLaunchCompletion(result.launchStartedAtMs);
      showLaunchCompletionNotice(t("启动任务"), completion, result.launchStartedAtMs);
      return Boolean(
        completion
        && resolveLaunchStatus(completion.latest_launch, result.launchStartedAtMs ?? 0) === "success",
      );
    } finally {
      launchPendingRef.current = false;
      setLaunchPending(false);
    }
  };

  const restart = async () => {
    if (launchPendingRef.current) return false;
    launchPendingRef.current = true;
    setLaunchPending(true);
    try {
      const result = await launchCommand("restart_codex_plus");
      if (!result) return false;
      if (!isSuccessStatus(result.status)) {
        showNotice(t("重启 Codex"), result.message, result.status);
        return false;
      }
      showNotice(
        t("重启 Codex"),
        result.nativeBrowserRestoreFailed
          ? t("原生浏览器文件恢复失败，仍会继续启动。")
          : t("正在等待 Codex 重新启动…"),
        result.nativeBrowserRestoreFailed ? "failed" : "accepted",
      );
      const completion = await waitForLaunchCompletion(result.launchStartedAtMs);
      showLaunchCompletionNotice(t("重启 Codex"), completion, result.launchStartedAtMs);
      const succeeded = Boolean(
        completion
        && resolveLaunchStatus(completion.latest_launch, result.launchStartedAtMs ?? 0) === "success",
      );
      return succeeded;
    } finally {
      launchPendingRef.current = false;
      setLaunchPending(false);
    }
  };

  /** 停止主 Codex，和重启共用停止流程。 */
  const stopCodex = async (): Promise<boolean> => {
    if (launchPendingRef.current) return false;
    launchPendingRef.current = true;
    setLaunchPending(true);
    try {
      const result = await launchCommand("stop_codex_plus");
      if (result) showNotice(t("停止 Codex"), result.message, result.status);
      await refreshOverview(true);
      return Boolean(result && isSuccessStatus(result.status));
    } finally {
      launchPendingRef.current = false;
      setLaunchPending(false);
    }
  };

  const launchCommand = async (command: "launch_codex_plus" | "restart_codex_plus" | "stop_codex_plus") => {
    const result = await run(() => call<LaunchCommandResult>(command));
    return result;
  };

  const waitForLaunchCompletion = async (requestStartedAtMs?: number) => {
    if (!requestStartedAtMs) {
      await refreshOverview(true);
      return null;
    }
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const result = await run(() => call<OverviewResult>("load_overview"));
      if (result) {
        setOverview(result);
        const resolution = resolveLaunchStatus(result.latest_launch, requestStartedAtMs);
        if (resolution === "success" || resolution === "failed") return result;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 400));
    }
    await refreshOverview(true);
    return null;
  };

  const showLaunchCompletionNotice = (title: string, result: OverviewResult | null, requestedAt?: number) => {
    const notice = launchCompletionNotice(result?.latest_launch ?? null, requestedAt ?? 0);
    showNotice(title, t(notice.message), notice.status);
  };

  const repairShortcuts = async () => {
    const result = await run(() => call<InstallResult>("repair_shortcuts"));
    if (result) {
      showNotice(t("快捷方式修复"), result.message, result.status);
      await refreshOverview(true);
    }
  };

  const setWatcherEnabled = async (enabled: boolean) => {
    const result = await run(() => call<WatcherResult>("set_watcher_enabled", { enabled }));
    if (result) {
      setWatcher(result);
      showNotice(t("开机打开 Codex Pilot"), result.message, result.status);
    }
  };

  const setWatcherStartMinimized = async (minimized: boolean) => {
    const result = await run(() => call<WatcherResult>("set_watcher_start_minimized", { minimized }));
    if (result) {
      setWatcher(result);
      showNotice(t("开机启动自动最小化"), result.message, result.status);
    }
  };

  const setWatcherStartCodex = async (startCodex: boolean) => {
    const result = await run(() => call<WatcherResult>("set_watcher_start_codex", { startCodex }));
    if (result) {
      setWatcher(result);
      showNotice(t("登录时自动启动 Codex"), result.message, result.status);
    }
  };

  const setWatcherStartCodexOnOpen = async (enabled: boolean) => {
    const result = await run(() => call<WatcherResult>("set_watcher_start_codex_on_open", { enabled }));
    if (result) {
      setWatcher(result);
      showNotice(t("打开 Codex Pilot 时自动启动 Codex"), result.message, result.status);
    }
  };

  // 启动时的后台检查早于设置加载：先单独读一次更新偏好，避免漏掉「跳过此版本」和「关闭自动检查」。
  const ensureUpdatePreferences = async () => {
    try {
      const result = await call<SettingsResult>("load_settings");
      if (!updateNotifications.current.preferencesLoaded) updateNotifications.current.setPreferences(updatePreferencesFrom(result.settings));
    } catch {
      // 读不到设置时按默认（自动检查、不跳过）继续，不打扰用户。
    }
  };

  const checkUpdate = async (silent = false) => {
    if (silent) {
      if (!updateNotifications.current.preferencesLoaded) await ensureUpdatePreferences();
      // 关闭「启动时自动检查更新」后，启动与定时的后台检查都不再联网；手动检查不受影响。
      if (!updateNotifications.current.autoCheckEnabled()) return;
    }
    if (updateInstallPending.current) return;
    if (updateCheckPending.current) {
      // 手动检查复用正在进行的后台请求，但仍按用户主动检查显示结果。
      if (!silent) updateCheckPending.current.manual = true;
      return;
    }
    const request = { manual: !silent };
    updateCheckPending.current = request;
    try {
      const result = await call<UpdateResult>("check_update");
      // 后台检查失败时保留上次可用的安装包，手动检查仍显示错误。
      if (request.manual || result.status !== "failed") setUpdate(result);
      if (updateNotifications.current.shouldPrompt(result, request.manual)) {
        setUpdatePrompt(result);
      } else if (request.manual) {
        showNotice(t("GitHub Release 检查"), result.message, result.status);
      }
    } catch (error) {
      if (request.manual) showNotice(t("GitHub Release 检查"), stringifyError(error), "failed");
    } finally {
      updateCheckPending.current = null;
    }
  };

  const closeUpdatePrompt = () => {
    if (updatePrompt?.latestVersion) updateNotifications.current.dismiss(updatePrompt.latestVersion);
    setUpdatePrompt(null);
  };

  // 「跳过此版本」：本次会话立即生效，并只把这一个键写进 settings.json；
  // 写完只合并该键和版本号，别处没保存的草稿保持不动。
  const skipUpdateVersion = async (version: string) => {
    updateNotifications.current.skipVersion(version);
    setUpdatePrompt(null);
    try {
      const result = await call<SettingsResult>("skip_update_version", { version });
      if (!isSuccessStatus(result.status)) {
        showNotice(t("跳过此版本"), result.message, "failed");
        return;
      }
      const fresh = normalizeSettings(result.settings);
      setSettings(result);
      setSettingsForm((current) => ({ ...current, updateSkippedVersion: fresh.updateSkippedVersion, revision: fresh.revision }));
    } catch (error) {
      showNotice(t("跳过此版本"), stringifyError(error), "failed");
    }
  };

  const performUpdate = async (selectedUpdate = update) => {
    if (updateInstallPending.current) return;
    const release =
      selectedUpdate?.latestVersion && selectedUpdate.assetName && selectedUpdate.assetUrl
        ? {
            version: selectedUpdate.latestVersion,
            url: "",
            body: selectedUpdate.releaseSummary ?? "",
            asset_name: selectedUpdate.assetName,
            asset_url: selectedUpdate.assetUrl,
          }
        : null;
    if (!release) {
      showNotice(t("更新安装"), t("请先检查更新并选择可下载的 Release asset。"), "failed");
      return;
    }
    updateInstallPending.current = true;
    setUpdateInstallProgress({
      active: true,
      percent: 0,
      indeterminate: true,
      message: t("正在准备下载安装包…"),
    });
    const fallbackTimer = window.setTimeout(() => {
      setUpdateInstallProgress((current) =>
        current.active && current.indeterminate
          ? { ...current, message: t("更新包仍在处理中，请保持窗口打开；完成后会自动更新状态。") }
          : current,
      );
    }, 15_000);
    let unlisten: (() => void) | null = null;
    try {
      unlisten = await listen<UpdateProgressEvent>("update-progress", (event) => {
        const progress = event.payload;
        const message =
          progress.stage === "downloading"
            ? t("正在下载安装包…")
            : progress.stage === "writing"
              ? t("正在写入安装包并准备安装…")
              : t("正在启动安装器…");
        setUpdateInstallProgress({
          active: true,
          percent: progress.stage === "downloading" ? (progress.percent ?? 0) : 0,
          indeterminate: progress.stage !== "downloading" || progress.percent == null,
          message,
        });
      });
      const result = await run(() => call<UpdateResult>("perform_update", { release }));
      if (result) {
        setUpdate({ ...selectedUpdate!, ...result });
        setUpdateInstallProgress({
          active: false,
          percent: result.progress ?? 100,
          indeterminate: false,
          message: result.message,
          failed: result.status === "failed",
        });
        showNotice(t("更新安装"), result.message, result.status);
      } else {
        setUpdateInstallProgress({
          active: false,
          percent: 100,
          indeterminate: false,
          message: t("安装包更新失败，请查看错误提示后重试。"),
          failed: true,
        });
      }
    } catch (error) {
      const message = stringifyError(error);
      setUpdateInstallProgress({ active: false, percent: 0, indeterminate: false, message, failed: true });
      showNotice(t("更新安装"), message, "failed");
    } finally {
      updateInstallPending.current = false;
      window.clearTimeout(fallbackTimer);
      unlisten?.();
    }
  };

  const saveSettingsValue = async (next: BackendSettings, silent = true) => {
    const normalized = normalizeSettings(next);
    const result = await run(() => call<SettingsResult>("save_settings", { settings: normalized }));
    if (result && isSuccessStatus(result.status)) {
      const saved = normalizeSettings(result.settings);
      setSettings(result);
      setSettingsForm(saved);
      if (!silent) showNotice(t("设置保存"), result.message, result.status);
      return saved;
    }
    if (result) showNotice(t("设置保存"), result.message, result.status);
    // 保留草稿供用户重载后合并，不能拿最新版本号自动重试旧快照。
    return null;
  };

  /// 自动保存：不弹成功提示；校验不过就不保存，把原因交给页面显示，避免输入到一半就弹窗。
  ///
  /// 保存期间用户又改了表单时，保留新草稿、只同步版本号（否则下一次保存会撞版本冲突），
  /// 草稿仍是「有修改」，由页面下一轮再存。
  const autoSaveSettings = async (snapshot: BackendSettings): Promise<AutoSaveOutcome> => {
    const normalized = normalizeSettings(snapshot);
    try {
      const result = await call<SettingsResult>("save_settings", { settings: normalized });
      if (!isSuccessStatus(result.status)) return { status: "failed", message: result.message };
      const saved = normalizeSettings(result.settings);
      setSettings(result);
      setSettingsForm((current) => (backendSettingsEqual(current, snapshot) ? saved : { ...current, revision: saved.revision }));
      return { status: "saved" };
    } catch (error) {
      return { status: "failed", message: stringifyError(error) };
    }
  };

  const exportSettings = async () => {
    try {
      const selected = await saveDialog({
        title: t("导出 Codex Pilot 配置"),
        defaultPath: "codex-pilot-settings.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!selected) return;
      const result = await run(() => call<CommandResult<{ path: string }>>("export_settings", {
        path: selected,
        settings: normalizeSettings(settingsForm),
      }));
      if (result) showNotice(t("导出 Codex Pilot 配置"), result.message, result.status);
    } catch (error) {
      showNotice(t("导出 Codex Pilot 配置"), stringifyError(error), "failed");
    }
  };

  const importSettings = async () => {
    try {
      const selected = await open({
        title: t("导入 Codex Pilot 配置"),
        multiple: false,
        directory: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (typeof selected !== "string" || !selected.trim()) return;
      const result = await run(() => call<SettingsResult>("preview_import_settings", { path: selected }));
      if (!result || !isSuccessStatus(result.status)) {
        if (result) showNotice(t("导入 Codex Pilot 配置"), result.message, result.status);
        return;
      }
      setSettings(settings ?? result);
      setSettingsForm(normalizeSettings(result.settings));
      showNotice(t("导入 Codex Pilot 配置"), result.message, "ok");
    } catch (error) {
      showNotice(t("导入 Codex Pilot 配置"), stringifyError(error), "failed");
    }
  };

  const chooseSettingsPath = async () => {
    try {
      const selected = await saveDialog({
        title: t("选择配置文件路径"),
        defaultPath: "settings.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!selected) return;
      const result = await run(() => call<SettingsResult>("set_settings_path", { path: selected }));
      if (result) {
        if (isSuccessStatus(result.status)) {
          setSettings(result);
          setSettingsForm(normalizeSettings(result.settings));
        }
        showNotice(t("配置文件路径"), result.message, result.status);
      }
    } catch (error) {
      showNotice(t("配置文件路径"), stringifyError(error), "failed");
    }
  };

  const resetSettingsPath = async () => {
    const result = await run(() => call<SettingsResult>("reset_settings_path"));
    if (result) {
      if (isSuccessStatus(result.status)) {
        setSettings(result);
        setSettingsForm(normalizeSettings(result.settings));
      }
      showNotice(t("配置文件路径"), result.message, result.status);
    }
  };

  const copyText = async (text: string, message: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (error) {
      showNotice(t("复制失败"), stringifyError(error), "failed");
    }
  };

  const openExternalUrl = async (url: string) => {
    const result = await run(() => call<CommandResult<Record<string, unknown>>>("open_external_url", { url }));
    if (result) {
      showResultNotice(t("打开链接"), result, { silentSuccess: true });
    }
  };

  const showNotice = (title: string, message: string, status?: Status) => {
    setNotice({ title, message: t(message), status });
  };

  const showResultNotice = (
    title: string,
    result: Pick<CommandResult<unknown>, "message" | "status">,
    options: { silentSuccess?: boolean } = {},
  ) => {
    if (options.silentSuccess && isSuccessStatus(result.status)) return;
    showNotice(title, result.message, result.status);
  };

  useEffect(() => {

    void (async () => {
      const startup = await run(() => call<StartupResult>("startup_options"));
      const handledNavigation = await consumePendingManagerNavigation();
      if (!handledNavigation && startup?.showUpdate) {
        setSettingsFocus("app-settings-update");
        await navigate("settings");
        void checkUpdate(false);
      } else {
        void checkUpdate(true);
      }
      await Promise.all([refreshOverview(true), handledNavigation ? Promise.resolve() : refreshSettings(true)]);
    })();
  }, []);

  useEffect(() => {
    // 长期开着管理器也能发现更新；后台检查失败不打扰当前操作。
    const timer = window.setInterval(() => void checkUpdate(true), UPDATE_CHECK_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let disposed = false;
    let stopListening: (() => void) | undefined;
    void listen(MANAGER_NAVIGATION_EVENT, () => {
      if (!disposed) void consumePendingManagerNavigation();
    }).then((unlisten) => {
      if (disposed) {
        unlisten();
      } else {
        stopListening = unlisten;
      }
    });
    return () => {
      disposed = true;
      stopListening?.();
    };
  }, []);

  // 托盘快捷面板发来的请求：打开某页、启动 / 重启 / 停止 Codex。
  // 复用主窗口现有流程（校验、冲突弹窗、等待启动结果），做完给面板回一个结果；
  // 没成功时把主窗口叫出来，失败提示是在主窗口里弹的。
  // 监听只注册一次，处理函数每次渲染更新到 ref 里，读到的总是最新状态。
  const trayRequestHandlerRef = useRef<(request: TrayRequest) => Promise<TrayResult>>(async (request) => ({ id: request.id, ok: false }));
  trayRequestHandlerRef.current = async (request: TrayRequest): Promise<TrayResult> => {
    const revealMainWindow = () => void invoke("tray_panel_action", { action: "open" }).catch(() => {});
    if (request.kind === "navigate") {

      await navigate(request.route);
      return { id: request.id, ok: true };
    }
    const done = request.kind === "launch" ? await launch() : request.kind === "restart" ? await restart() : await stopCodex();
    if (!done) revealMainWindow();
    return { id: request.id, ok: done };
  };

  useEffect(() => {
    let disposed = false;
    let stopListening: (() => void) | undefined;
    void listen<unknown>(TRAY_REQUEST_EVENT, (event) => {
      const request = parseTrayRequest(event.payload);
      if (disposed || !request) return;
      void trayRequestHandlerRef.current(request)
        .catch((error): TrayResult => ({ id: request.id, ok: false, message: stringifyError(error) }))
        .then((result) => emit(TRAY_RESULT_EVENT, result))
        .catch(() => {});
    }).then((unlisten) => {
      if (disposed) {
        unlisten();
      } else {
        stopListening = unlisten;
        // 告诉后端监听已就绪，避免启动期间遗漏快捷面板请求。
        void emit(MAIN_WINDOW_READY_EVENT).catch(() => {});
      }
    });
    return () => {
      disposed = true;
      stopListening?.();
    };
  }, []);

  useEffect(() => {
    if (getLanguage() === "en") {
      void invoke("update_tray_labels", {
        showLabel: "Show window",
        quitLabel: "Quit",
        windowTitle: "Codex Pilot",
      });
    }
  }, []);

  useEffect(() => watchSystemTheme(setSystemDark), []);

  useEffect(() => {
    applyResolvedTheme(theme);
  }, [theme]);

  useEffect(() => {
    storeThemePreference(themePreference);
  }, [themePreference]);

  useEffect(() => {
    const refresh = () => { void refreshOverview(true); };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);

  // 重新读取并把尚未保存的编辑叠上去，免得用旧设置整份写回或撞上 revision 冲突。
  useEffect(() => {
    let disposed = false;
    let stopListening: (() => void) | undefined;
    const syncExternalSettings = async () => {
      let result: SettingsResult;
      try {
        result = await call<SettingsResult>("load_settings");
      } catch {
        return;
      }
      if (disposed || !isSuccessStatus(result.status)) return;
      const previous = settingsRef.current?.settings;
      const latest = normalizeSettings(result.settings);
      setSettings(result);
      setSettingsForm((current) => (previous
        ? rebaseSettingsEdits(normalizeSettings(current), normalizeSettings(previous), latest)
        : latest));
    };
    void listen("codex-plus-settings-changed", () => {
      if (!disposed) void syncExternalSettings();
    }).then((unlisten) => {
      if (disposed) unlisten();
      else stopListening = unlisten;
    });
    return () => {
      disposed = true;
      stopListening?.();
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let stopListening: (() => void) | undefined;
    void listen("runtime-health-changed", () => {
      if (!disposed) void refreshOverview(true);
    }).then((unlisten) => {
      if (disposed) unlisten();
      else {
        stopListening = unlisten;
        // 先订阅再读取，覆盖后台恢复早于监听安装完成的情况。
        void refreshOverview(true);
      }
    });
    return () => {
      disposed = true;
      stopListening?.();
    };
  }, []);

  const saveCodexAppPath = async (appPath: string) => {
    const next = { ...settingsForm, codexAppPath: appPath };
    const result = await run(() => call<SettingsResult>("save_settings", { settings: next }));
    if (result) {
      setSettings(result);
      const normalized = normalizeSettings(result.settings);
      setSettingsForm(normalized);
      await refreshOverview(true);
    }
    return result;
  };

  const actions = useMemo(
    // 连接详情的刷新只查运行状态，不重新加载设置，避免覆盖正在编辑的草稿。
    () => ({refreshCurrent: () => refreshOverview(true),
launch,
restart,
stopCodex,
repairShortcuts,
checkUpdate,
performUpdate,
autoSaveSettings,
exportSettings,
importSettings,
chooseSettingsPath,
resetSettingsPath,
chooseCodexAppPath: async (mode: "folder" | "file") => {
        let selected: unknown;
        try {
          selected = await open(
            mode === "folder"
              ? { directory: true, multiple: false, title: t("选择 Codex 应用目录") }
              : {
                  directory: false,
                  multiple: false,
                  title: t("选择 Codex.exe 或 Codex.app"),
                  filters: [{ name: t("Codex 应用"), extensions: ["exe", "app"] }],
                },
          );
        } catch (error) {
          // Surface plugin failures (e.g. missing capability permission) so the
          // buttons no longer appear unresponsive — see #345.
          const message = error instanceof Error ? error.message : String(error);
          showNotice(t("Codex 应用路径"), tf("打开选择器失败：{0}", [message]), "failed");
          return;
        }
        if (typeof selected === "string" && selected.trim()) {
          const result = await saveCodexAppPath(selected.trim());
          if (result) {
            showNotice(t("Codex 应用路径"), t("应用路径已保存，之后启动会自动复用。"), result.status);
          }
        }
      },
clearCodexAppPath: async () => {
        const next = { ...settingsForm, codexAppPath: "" };
        const result = await run(() => call<SettingsResult>("save_settings", { settings: next }));
        if (result) {
          setSettings(result);
          setSettingsForm(normalizeSettings(result.settings));
          showNotice(t("Codex 应用路径"), t("已清除保存路径，后续启动会回到自动探测。"), result.status);
          await refreshOverview(true);
        }
      },
reloadBuiltinExtensions,
setBuiltinExtensionEnabled,
openExternalUrl,
showMessage: async (title: string, message: string, status?: Status) => showNotice(title, message, status),
checkHealth: async () => {
        await refreshOverview(true);

        await refreshWatcher(true);
        showNotice(t("检查完成"), t("已刷新 Codex 应用、入口和 Watcher 状态。"), "ok");
      },
setWatcherEnabled,
setWatcherStartMinimized,
setWatcherStartCodex,
setWatcherStartCodexOnOpen,
setAutoTakeover,
refreshAutoTakeover: () => refreshAutoTakeover(false),
takeOverNow: () => runAutoTakeoverCommand("take_over_codex_now"),
pauseAutoTakeover: () => runAutoTakeoverCommand("pause_auto_takeover_for_instance"),
setThemePreference}),
    [route, settingsForm, settings, overview, update, updateInstallProgress.active, theme, getLanguage()],
  );
  const codexAppRunning = overview?.runtime_health?.codex_app?.status === "running";
  // Codex 可能在它自己的窗口里被退出，既不经过 Codex Pilot 也不触发窗口聚焦（#2778）。
  // 窗口可见时每 5 秒只查一次进程是否还在，和当前显示不一致再完整刷新概览。
  useEffect(() => {
    let disposed = false;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void invoke<boolean | null>("codex_app_running")
        .then((running) => {
          if (!disposed && typeof running === "boolean" && running !== codexAppRunning) void refreshOverview(true);
        })
        .catch(() => undefined);
    }, codexRunningPollMs);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [codexAppRunning]);
  // 运行控制只在侧栏提供入口，与运行状态共用现有后端流程。

  const codexLaunch: CodexLaunchState = {
    running: codexAppRunning,
    busy: launchPending,
    unavailableReason: overview?.codex_app?.status === "missing"
      ? t("没有找到 Codex 应用，请先安装 Codex")
      : null,
    onLaunch: () => void actions.launch(),
    onRestart: () => void actions.restart(),
    onStop: () => void actions.stopCodex(),
  };
  return (
    <div className={`shell compact-shell ${theme}${isMacOSPlatform ? " platform-macos" : ""}`}>
      <CompactSidebar
        route={route}
        onNavigate={(next) => void navigate(next)}
        launch={codexLaunch}
      />
      <main className="workspace" id="manager-workspace">
        <AppHeader route={route}>
          <SettingsAutoSave dirty={settingsDirty} form={settingsForm} actions={actions} />
        </AppHeader>
        <section
          className="screen"
          key={route}
        >

          {route === "enhance" ? (
            <div className="compact-home">
            <OverviewScreen overview={overview} actions={actions} running={codexAppRunning} enhancementsEnabled={settingsForm.enhancementsEnabled} />
            <EnhanceScreen
              form={settingsForm}
              onFormChange={setSettingsForm}
              builtins={settings?.builtin_extensions?.builtins ?? []}
              actions={actions}
            />
            </div>
          ) : null}

          {route === "settings" ? (
            <div className="settings-page codex-settings-page compact-settings">
                <AppSettingsFocus focus={settingsFocus} onDone={() => setSettingsFocus(null)} />
                  <GlobalSettingsScreen
                    section="appearance"
                    settings={settings}
                    theme={theme}
                    themePreference={themePreference}
                    actions={actions}
                  />
                <MaintenanceScreen section="startup" overview={overview} watcher={watcher} autoTakeover={autoTakeover} settings={settings} actions={actions} />
                <section className="compact-config-group" aria-labelledby="compact-config-heading">
                  <h2 id="compact-config-heading">{t("配置与维护")}</h2>
                  <GlobalSettingsScreen section="config" settings={settings} theme={theme} themePreference={themePreference} actions={actions} />
                  <MaintenanceScreen section="maintenance" overview={overview} watcher={watcher} autoTakeover={autoTakeover} settings={settings} actions={actions} />
                </section>
                <UpdateSettingsScreen
                    form={settingsForm}
                    onFormChange={setSettingsForm}
                    overview={overview}
                    update={update}
                    updateInstallProgress={updateInstallProgress}
                    actions={actions}
                  />
            </div>
          ) : null}
        </section>
      </main>
      {updatePrompt ? (
        <UpdateDialog
          update={updatePrompt}
          progress={updateInstallProgress}
          onClose={closeUpdatePrompt}
          onSkipVersion={() => {
            if (updatePrompt.latestVersion) void skipUpdateVersion(updatePrompt.latestVersion);
          }}
          onMuteToday={() => {
            updateNotifications.current.muteToday();
            setUpdatePrompt(null);
          }}
          onUpdate={() => void performUpdate(updatePrompt)}
          onOpenUrl={(url) => void openExternalUrl(url)}
        />
      ) : null}
      {notice ? (
        <NoticeDialog
          key={`${notice.title}-${notice.message}-${notice.status ?? ""}`}
          notice={notice}
          onClose={() => setNotice(null)}
        />
      ) : null}
      <AppDialogHost />
      {confirmDialog ? (
        <ConfirmDialog
          confirm={confirmDialog}
          onCancel={() => {
            confirmDialog.resolve(false);
            setConfirmDialog(null);
          }}
          onConfirm={() => {
            confirmDialog.resolve(true);
            setConfirmDialog(null);
          }}
        />
      ) : null}

    </div>
  );
}

type AutoSaveOutcome = { status: "saved" } | { status: "invalid" | "failed"; message: string };

type Actions = {refreshCurrent: () => Promise<void>;
launch: () => Promise<boolean>;
restart: () => Promise<boolean>;
stopCodex: () => Promise<boolean>;
repairShortcuts: () => Promise<void>;
checkUpdate: () => Promise<void>;
performUpdate: () => Promise<void>;
autoSaveSettings: (settings: BackendSettings) => Promise<AutoSaveOutcome>;
exportSettings: () => Promise<void>;
importSettings: () => Promise<void>;
chooseSettingsPath: () => Promise<void>;
resetSettingsPath: () => Promise<void>;
chooseCodexAppPath: (mode: "folder" | "file") => Promise<void>;
clearCodexAppPath: () => Promise<void>;
reloadBuiltinExtensions: () => Promise<void>;
setBuiltinExtensionEnabled: (key: string, enabled: boolean) => Promise<void>;
openExternalUrl: (url: string) => Promise<void>;
showMessage: (title: string, message: string, status?: Status) => Promise<void>;
setWatcherEnabled: (enabled: boolean) => Promise<void>;
setWatcherStartMinimized: (minimized: boolean) => Promise<void>;
setWatcherStartCodex: (startCodex: boolean) => Promise<void>;
setWatcherStartCodexOnOpen: (enabled: boolean) => Promise<void>;
setAutoTakeover: (enabled: boolean) => Promise<void>;
refreshAutoTakeover: () => Promise<void>;
takeOverNow: () => Promise<void>;
pauseAutoTakeover: () => Promise<void>;
setThemePreference: (preference: ThemePreference) => void;
checkHealth: () => Promise<void>;};

/** 连接摘要依据进程、增强开关与 CDP 状态；不再把已移除的 HTTP 服务作为就绪条件。 */
function runtimeSummary(overview: OverviewResult | null, running: boolean, enhancementsEnabled = true): { tone: string; message: string } {
  if (!overview) return { tone: "idle", message: t("正在检查运行状态…") };
  if (overview.codex_app.status === "missing") return { tone: "error", message: t("未找到 Codex 应用") };
  if (!running) return { tone: "idle", message: t("Codex 未运行") };
  if (!enhancementsEnabled) return { tone: "idle", message: t("增强已关闭") };
  const { debugger: debuggerState } = overview.runtime_health;
  if (debuggerState.status === "connected") {
    return { tone: "success", message: t("运行中 · 增强已连接") };
  }
  const failed = ["failed", "degraded"].includes(debuggerState.status);
  return failed
    ? { tone: "error", message: t("运行中 · 增强连接异常") }
    : { tone: "warning", message: t("运行中 · 等待增强连接") };
}

function OverviewScreen({overview, actions, running, enhancementsEnabled}: {overview: OverviewResult | null; actions: Actions; running: boolean; enhancementsEnabled: boolean}) {
  const health = healthItems(overview);
  const summary = runtimeSummary(overview, running, enhancementsEnabled);
  const [refreshing, setRefreshing] = useState(false);
  // 只刷新连接状态，保留正在编辑的增强草稿；等待期间禁用按钮，避免重复请求。
  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try { await actions.refreshCurrent(); }
    finally { setRefreshing(false); }
  };
  return (
    <section className="compact-runtime" aria-label={t("Codex 运行状态")}>
      <div className="compact-runtime-header">
        <div>
          <h2>Codex</h2>
          <p className="compact-runtime-status" data-tone={summary.tone} role="status">
            <span className="compact-status-dot" aria-hidden="true" />{summary.message}
            {overview?.codex_version ? <span className="compact-codex-version">{overview.codex_version}</span> : null}
          </p>
        </div>
      </div>
      {/* 应用路径与调试连接始终可见；保留完整路径和异常说明，长文本在卡片内换行。 */}
      <section className="compact-connection" aria-labelledby="compact-connection-heading" aria-busy={refreshing}>
        <div className="compact-connection-heading">
          <h3 id="compact-connection-heading">{t("连接详情")}</h3>
          <Button className="compact-icon-button" size="icon" variant="ghost" disabled={refreshing} onClick={() => void refresh()} aria-label={t("刷新状态")} title={t("刷新状态")}>
            <RefreshCw aria-hidden="true" className={refreshing ? "animate-spin" : ""} />
          </Button>
        </div>
        <div className="connection-grid">{health.map((item) => (
          <article className="connection-card" key={item.title}>
            <div className="connection-card-header">
              <span className={`connection-card-icon ${statusClass(item.status)}`} aria-hidden="true"><item.icon /></span>
              <Badge status={item.status} />
            </div>
            <h4>{item.title}</h4>
            <p>{item.detail}</p>
          </article>
        ))}</div>
      </section>
    </section>
  );
}

/** 增强页改动后多久自动保存：开关点完马上存，文本框停止输入后再存。 */
const ENHANCE_AUTO_SAVE_DELAY_MS = 500;

type AutoSaveState =
  | { state: "idle" | "pending" | "saving" | "saved" }
  | { state: "invalid" | "failed"; message: string; retry: () => void };

/// 两页共用的自动保存，由页头组件持有。
///
/// - 防抖：同一轮连续改动只存一次；
/// - 同一时间只有一个保存在途，期间的改动等它回来后再存（App 会同步版本号并触发下一轮）；
/// - 控制器卸载时还有没存的改动就立即补存一次；普通切页保留同一份草稿和任务。
function useEnhanceAutoSave(
  dirty: boolean,
  form: BackendSettings,
  save: (settings: BackendSettings) => Promise<AutoSaveOutcome>,
): AutoSaveState {
  const [status, setStatus] = useState<AutoSaveState>({ state: "idle" });
  const savingRef = useRef(false);
  const latest = useRef({ dirty, form, save });
  latest.current = { dirty, form, save };

  const flush = useCallback(async () => {
    if (savingRef.current) return;
    const { dirty: pending, form: snapshot, save: persist } = latest.current;
    if (!pending) return;
    savingRef.current = true;
    setStatus({ state: "saving" });
    const outcome = await persist(snapshot);
    savingRef.current = false;
    setStatus(outcome.status === "saved"
      ? { state: "saved" }
      : { state: outcome.status, message: outcome.message, retry: () => void flush() });
  }, []);

  useEffect(() => {
    if (!dirty) {
      // 切页或外部刷新可能先消掉草稿并取消计时器，此时不能一直停留在“等待保存”。
      setStatus((current) => ["pending", "invalid", "failed"].includes(current.state) ? { state: "idle" } : current);
      return;
    }
    setStatus((current) => (current.state === "saving" || current.state === "invalid" ? current : { state: "pending" }));
    const timer = window.setTimeout(() => void flush(), ENHANCE_AUTO_SAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [dirty, form, flush]);

  useEffect(() => () => {
    if (latest.current.dirty && !savingRef.current) void latest.current.save(latest.current.form);
  }, []);

  return status;
}

function AutoSaveStatus({ state }: { state: AutoSaveState }) {
  if (state.state === "invalid" || state.state === "failed") {
    return (
      <>
        <span className="is-error" role="alert" title={state.message}>
          {state.state === "invalid" ? tf("未保存：{0}", [t(state.message)]) : tf("自动保存失败：{0}", [t(state.message)])}
        </span>
        {state.state === "failed" ? (
          <Button onClick={state.retry} size="sm" variant="secondary">
            <RefreshCw className="h-4 w-4" />
            {t("重试")}
          </Button>
        ) : null}
      </>
    );
  }
  const label = state.state === "saving" ? t("正在保存…")
    : state.state === "pending" ? t("即将自动保存…")
      : t("改动会自动保存");
  return (
    <span className={state.state === "saved" || state.state === "idle" ? "" : "is-dirty"} role="status">
      {state.state === "saved" ? <CheckCircle2 className="h-3.5 w-3.5" /> : null}
      {state.state === "saved" ? t("已自动保存") : label}
    </span>
  );
}

/// 页头统一托管两页的自动保存与反馈，切页不会重建保存任务或重复发起写入。
function SettingsAutoSave({ dirty, form, actions, className = "" }: {
  dirty: boolean;
  form: BackendSettings;
  actions: Actions;
  className?: string;
}) {
  const state = useEnhanceAutoSave(dirty, form, actions.autoSaveSettings);
  return (
    <div className={`enhance-save-actions settings-autosave ${className}`}>
      <AutoSaveStatus state={state} />
    </div>
  );
}

function EnhanceScreen({
  form,
  onFormChange,
  builtins,
  actions,
}: {
  form: BackendSettings;
  onFormChange: (value: BackendSettings) => void;
  /** 后台给的内置拓展现状（顶替、没有设置字段的启停）。 */
  builtins: BuiltinExtension[];
  actions: Actions;
}) {
  const setEnhanceFlag = (key: keyof BackendSettings, value: boolean) => onFormChange({ ...form, [key]: value });
  const masterEnabled = form.enhancementsEnabled;
  const masterItem = enhancementItem("enhancementsEnabled");
  // 开关的标题、说明、分组都来自设置项清单；这里只保留一处定制：
  // Windows 原生浏览器兼容开启前要确认，并在开关后面跟一块补丁状态。
  const renderSetting = (item: EnhancementSettingItem) => {
    if (item.key === "codexAppNativeBrowserRequireIdentification") {
      return (
        <Fragment key={item.key}>
          <EnhancementSettingControl
            item={item}
            form={form}
            onFormChange={onFormChange}
            masterEnabled={masterEnabled}
            onToggle={(value) => void (async () => {
              if (value && !(await appConfirm(nativeBrowserConsent(), { title: t(item.title), confirmText: t("开启") }))) return;
              setEnhanceFlag("codexAppNativeBrowserRequireIdentification", value);
            })()}
          />
          <NativeBrowserStatusView />
        </Fragment>
      );
    }
    return <EnhancementSettingControl key={item.key} item={item} form={form} onFormChange={onFormChange} masterEnabled={masterEnabled} />;
  };
  const builtinStates = new Map(builtins.map((builtin) => [builtin.id, builtin]));
  const renderBuiltin = (card: BuiltinExtensionCard) => (
    <BuiltinExtensionCardView
      key={card.id}
      card={card}
      form={form}
      onFormChange={onFormChange}
      masterEnabled={masterEnabled}
      state={builtinStates.get(card.id)}
      renderSetting={renderSetting}
      actions={actions}
    />
  );
  return (
    <section className="settings-page enhance-page compact-enhancements" aria-labelledby="compact-enhancements-heading">
      {/* 此处只呈现分区标题与总开关；自动保存反馈统一显示在页头。 */}
      <div className="enhance-master-bar" id="enhance-page-controls">
        <h2 id="compact-enhancements-heading">{t("增强")}</h2>
        <label className="enhance-master-switch">
          <input
            checked={form.enhancementsEnabled}
            onChange={(event) => onFormChange({ ...form, enhancementsEnabled: event.currentTarget.checked })}
            type="checkbox"
          />
          <ToggleVisual />
          <span>
            <strong>{t(masterItem.title)}</strong>
          </span>
        </label>
      </div>
            <div className="compact-feature-list">
              {/* 保留旧分组锚点兼容现有定位，但不再渲染分组标题和多级导航。 */}
              {managerBuiltinGroups().map((group) => (
                <div className="compact-feature-group" key={group.id} id={enhancementGroupAnchorId(group)}>
                  {managerBuiltinCards(group.id, enhancementPlatform).map(renderBuiltin)}
                </div>
              ))}
            </div>
    </section>
  );
}

/// 一个内置拓展的卡片：开关（就是对应的设置项；没有设置项的记在用户脚本配置里）、
/// 被拓展顶替时的提示，以及打开后显示的子选项。
function BuiltinExtensionCardView({
  card,
  form,
  onFormChange,
  masterEnabled,
  state,
  renderSetting,
  actions,
}: {
  card: BuiltinExtensionCard;
  form: BackendSettings;
  onFormChange: (value: BackendSettings) => void;
  masterEnabled: boolean;
  state?: BuiltinExtension;
  renderSetting: (item: EnhancementSettingItem) => ReactNode;
  actions: Actions;
}) {
  const { item, entry } = card;
  const gated = item ? isEnhancementItemMasterGated(item) : true;
  const disabled = gated && !masterEnabled;
  let on: boolean;
  let control: ReactNode;
  if (item?.control === "select") {
    // 下拉型：开关写 builtinOn / builtinOff，具体选项在打开后作为参数选。
    const key = item.key as keyof BackendSettings;
    const value = String(form[key] ?? "");
    on = value !== "" && value !== (item.builtinOff ?? "off");
    control = (
      <FeatureToggle
        title={t(item.title)}
        detail={t(item.description)}
        checked={on}
        disabled={disabled}
        onChange={(checked) => onFormChange({ ...form, [key]: checked ? item.builtinOn ?? "" : item.builtinOff ?? "off" })}
      />
    );
  } else if (item) {
    on = form[item.key as keyof BackendSettings] === true;
    control = renderSetting(item);
  } else if (entry?.setting) {
    const setting = entry.setting;
    on = builtinSettingValue(form, setting) === true;
    control = (
      <FeatureToggle
        title={t(entry.title)}
        detail={t(entry.description)}
        checked={on}
        disabled={disabled}
        onChange={(checked) => onFormChange(withBuiltinSetting(form, setting, checked))}
      />
    );
  } else {
    on = state?.enabled ?? true;
    control = (
      <FeatureToggle
        title={t(entry?.title ?? card.id)}
        detail={t(entry?.description ?? "")}
        checked={on}
        disabled={disabled}
        onChange={(checked) => void actions.setBuiltinExtensionEnabled(`builtin:${card.id}`, checked)}
      />
    );
  }
  const selectOptions = item?.control === "select" ? (item.options ?? []).filter((option) => option.value !== (item.builtinOff ?? "off")) : [];
  return (
    <div className="builtin-card" data-builtin-id={card.id}>
      {control}
      {state?.replacedBy ? (
        <small className="builtin-card-note">{tf("已被 {0} 顶替", [state.replacedBy.replace(/^user:/, "")])}</small>
      ) : null}
      {on && (card.params.length || selectOptions.length) ? (
        <div className="builtin-card-params">
          {item?.control === "select" ? (
            <AppSelect<string>
              ariaLabel={t(item.title)}
              value={String(form[item.key as keyof BackendSettings] ?? "")}
              disabled={disabled}
              onChange={(value) => onFormChange({ ...form, [item.key]: value })}
              options={selectOptions.map((option) => ({ value: option.value, label: t(option.label) }))}
            />
          ) : null}
          {card.params.map((param) => (
            <EnhancementSettingControl key={param.key} item={param} form={form} onFormChange={onFormChange} masterEnabled={masterEnabled} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

type BooleanSettingKey = { [K in keyof BackendSettings]-?: BackendSettings[K] extends boolean ? K : never }[keyof BackendSettings];

/// 按设置项清单渲染一个增强设置：bool 是开关卡，select 是带下拉的卡片。
/// 受总开关控制的项在增强关闭时禁用，文案直接使用共享清单。
function EnhancementSettingControl({
  item,
  form,
  onFormChange,
  masterEnabled,
  onToggle,
}: {
  item: EnhancementSettingItem;
  form: BackendSettings;
  onFormChange: (value: BackendSettings) => void;
  masterEnabled: boolean;
  /** 需要在写入前插入确认等步骤时覆盖默认写入。 */
  onToggle?: (value: boolean) => void;
}) {
  const disabled = isEnhancementItemMasterGated(item) && !masterEnabled;
  const detail = t(item.managerSummary ?? item.description);
  if (item.control === "model") {
    const key = item.key as keyof BackendSettings;
    const models: string[] = [];
    const listId = `enhancement-models-${item.key}`;
    const placeholder = item.placeholder || "跟随当前对话";
    const modelDisabled = disabled || (item.parent === "native-predictions" && !form.codexAppNativePredictions);
    return (
      <div className={`feature-toggle ${modelDisabled ? "disabled" : ""}`}>
        <span>
          <strong>{t(item.title)}</strong>
          <small>{detail}</small>
        </span>
        <div className="w-48 min-w-0 max-w-full">
          <Input
            aria-label={t(item.title)}
            value={String(form[key] ?? "")}
            disabled={modelDisabled}
            placeholder={t(placeholder)}
            list={listId}
            spellCheck={false}
            onChange={(event) => onFormChange({ ...form, [key]: event.currentTarget.value })}
          />
          <datalist id={listId}>
            {models.map((model) => <option key={model} value={model} />)}
          </datalist>
        </div>
      </div>
    );
  }
  if (item.control === "select") {
    const key = item.key as keyof BackendSettings;
    return (
      <div className={`feature-toggle ${disabled ? "disabled" : ""}`}>
        <span>
          <strong>{t(item.title)}</strong>
          <small>{detail}</small>
        </span>
        <AppSelect<string>
          ariaLabel={t(item.title)}
          value={String(form[key] ?? "")}
          disabled={disabled}
          onChange={(value) => onFormChange({ ...form, [key]: value })}
          options={(item.options ?? []).map((option) => ({ value: option.value, label: t(option.label) }))}
        />
      </div>
    );
  }
  const key = item.key as BooleanSettingKey;
  return (
    <FeatureToggle
      title={t(item.title)}
      detail={detail}
      checked={form[key]}
      disabled={disabled}
      restartRequired={item.restart}
      onChange={onToggle ?? ((value) => onFormChange({ ...form, [key]: value }))}
    />
  );
}

/** 同一套维护能力按频率分两处呈现，所有动作仍调用原来的后端命令。 */
function MaintenanceScreen({ section, overview, watcher, autoTakeover, settings, actions }: {
  section: "startup" | "maintenance";
  overview: OverviewResult | null;
  watcher: WatcherResult | null;
  autoTakeover: AutoTakeoverResult | null;
  settings: SettingsResult | null;
  actions: Actions;
}) {
  const savedCodexAppPath = settings?.settings.codexAppPath ?? "";
  if (section === "maintenance") return (
    <>
      <SettingsFold sectionId="codex-settings-app-path" title={t("Codex 应用路径")}>
        <div className="status-table">
          <StatusRow title={t("保存路径")} status={savedCodexAppPath ? "ok" : "not_checked"} path={savedCodexAppPath || null} />
          <StatusRow title={t("当前识别")} status={overview?.codex_app.status} path={overview?.codex_app.path} />
        </div>
        <Toolbar>
          <Button onClick={() => void actions.chooseCodexAppPath("folder")}>{t("选择应用目录")}</Button>
          <Button variant="secondary" onClick={() => void actions.chooseCodexAppPath("file")}>{t("选择应用文件")}</Button>
          <Button variant="secondary" onClick={() => void actions.clearCodexAppPath()}>{t("清除保存路径")}</Button>
        </Toolbar>
      </SettingsFold>
      <SettingsFold sectionId="codex-settings-check" title={t("检查与修复")}>
        <div className="status-table">
          <StatusRow title={t("Codex 应用")} status={overview?.codex_app.status} path={overview?.codex_app.path} />
          <StatusRow title={t("Codex Pilot 应用入口")} status={overview?.management_shortcut.status} path={overview?.management_shortcut.path} />
          <StatusRow title={t("开机打开 Codex Pilot")} status={watcher?.enabled ? "ok" : "disabled"} path={watcher?.disabled_flag} />
        </div>
        <Toolbar>
          <Button onClick={() => void actions.checkHealth()}>{t("检查")}</Button>
          <Button variant="secondary" onClick={() => void actions.repairShortcuts()}>{t("修复快捷方式")}</Button>
        </Toolbar>
      </SettingsFold>
    </>
  );
  return (
    <section className="compact-startup-section" aria-labelledby="compact-startup-heading">
      <h2 id="compact-startup-heading">{t("启动与接管")}</h2>
      <Panel id="codex-settings-startup" className="compact-startup-panel">
        <CardContent>
          <label className="switch-row">
            <input checked={Boolean(watcher?.enabled)} disabled={!watcher} onChange={(event) => void actions.setWatcherEnabled(event.currentTarget.checked)} type="checkbox" />
            <span><strong>{t("登录时自动打开")}</strong><small>{t("登录系统后打开 Codex Pilot。")}</small></span>
            <ToggleVisual />
          </label>
          <label className="switch-row">
            <input checked={Boolean(watcher?.start_codex_on_open)} disabled={!watcher} onChange={(event) => void actions.setWatcherStartCodexOnOpen(event.currentTarget.checked)} type="checkbox" />
            <span><strong>{t("打开 Codex Pilot 时自动启动 Codex")}</strong><small>{t("仅手动打开 Codex Pilot 时生效；已有 Codex 会先恢复，不会重复启动。")}</small></span>
            <ToggleVisual />
          </label>
          <div id="codex-settings-takeover">
            <label className="switch-row">
              <input checked={Boolean(settings?.settings.codexAppAutoTakeover)} disabled={!settings} onChange={(event) => void actions.setAutoTakeover(event.currentTarget.checked)} type="checkbox" />
              <span><strong>{t("自动接管官方 App")}</strong><small>{t("你自己启动官方 App 时注入增强；必要时会重启 Codex。")}</small></span>
              <ToggleVisual />
            </label>
            {settings?.settings.codexAppAutoTakeover ? (
              <SettingsFold title={t("接管状态")} className="compact-takeover-detail" issue={autoTakeover?.lastError}>
                <div className="status-table">
                  <StatusRow title={t("接管状态")} status={autoTakeover?.state === "degraded" ? "failed" : autoTakeover?.running ? "ok" : "disabled"} path={autoTakeover?.state === "degraded" ? t("已降级") : autoTakeover?.running ? t("监听中") : t("未运行")} />
                  <StatusRow title={t("官方 App")} status={autoTakeover?.appRunning ? "ok" : "disabled"} path={autoTakeover?.appRunning ? t("运行中") : t("未运行")} />
                  <StatusRow title={t("调试端口")} status={autoTakeover?.actualDebugPort ? "ok" : "not_checked"} path={autoTakeover?.actualDebugPort ? String(autoTakeover.actualDebugPort) : null} />
                </div>
                {autoTakeover?.pausedInstance ? <p className="hint">{t("本次已跳过自动接管，重启官方 App 后恢复。")}</p> : null}
                {autoTakeover?.lastError ? <p className="hint">{autoTakeover.lastError}</p> : null}
                {autoTakeover?.lastTakeoverAtMs ? <p className="hint">{tf("上次接管：{0}", [new Date(autoTakeover.lastTakeoverAtMs).toLocaleString()])}</p> : null}
                {autoTakeover?.platformSupported ? null : <p className="hint">{t("自动接管目前只支持 macOS 和 Linux。")}</p>}
                <Toolbar>
                  <Button variant="secondary" onClick={() => void actions.takeOverNow()}>{t("立即接管")}</Button>
                  <Button variant="secondary" onClick={() => void actions.pauseAutoTakeover()}>{t("本次不接管")}</Button>
                  <Button variant="secondary" onClick={() => void actions.refreshAutoTakeover()}>{t("刷新状态")}</Button>
                </Toolbar>
              </SettingsFold>
            ) : null}
          </div>
          {/* 登录启动的附属选项仍分别保存，只是从主列表收进低频折叠区。 */}
          <SettingsFold title={t("更多启动选项")} className="compact-more-startup">
            <label className="switch-row">
              <input checked={Boolean(watcher?.start_codex)} disabled={!watcher} onChange={(event) => void actions.setWatcherStartCodex(event.currentTarget.checked)} type="checkbox" />
              <span><strong>{t("登录时自动启动 Codex")}</strong><small>{t("仅在登录启动 Codex Pilot 时生效。")}</small></span>
              <ToggleVisual />
            </label>
            <label className="switch-row">
              <input checked={Boolean(watcher?.start_minimized)} disabled={!watcher} onChange={(event) => void actions.setWatcherStartMinimized(event.currentTarget.checked)} type="checkbox" />
              <span><strong>{t("启动时自动最小化")}</strong><small>{t("仅登录启动时隐藏到托盘；手动打开 Codex Pilot 仍显示主窗口。")}</small></span>
              <ToggleVisual />
            </label>
          </SettingsFold>
        </CardContent>
      </Panel>
    </section>
  );
}

function UpdateSettingsScreen({
  overview,
  update,
  updateInstallProgress,
  actions,
  form,
  onFormChange,
}: {
  form: BackendSettings;
  onFormChange: (value: BackendSettings) => void;
  overview: OverviewResult | null;
  update: UpdateResult | null;
  updateInstallProgress: TaskProgress;
  actions: Actions;
}) {
  return (
    <section id="app-settings-update" aria-labelledby="compact-update-heading">
      <h2 id="compact-update-heading">{t("版本与更新")}</h2>
      <p className="compact-section-description">{t("从 GaryLee271/CodexPilot 的 GitHub Release 检查更新，无需登录")}</p>
      <Panel>
        <CardContent>
          {/* 一行摘要 + 操作；发布说明在下面，下载进度只在下载时出现。 */}
          <div className="app-update-summary">
            <div className="app-update-copy">
              <strong>Codex Pilot {overview?.current_version ?? update?.currentVersion ?? "-"}</strong>
              <span data-tone={update?.updateAvailable ? "new" : undefined}>
                {update?.updateAvailable && update.latestVersion
                  ? tf("有新版本 {0}", [update.latestVersion])
                  : update?.latestVersion
                    ? t("已是最新版本")
                    : t("尚未检查更新")}
                {update?.updateAvailable && update.assetName ? ` · ${update.assetName}` : ""}
              </span>
            </div>
            <div className="app-update-actions">
              <Button onClick={() => void actions.checkUpdate()} variant={update?.updateAvailable ? "secondary" : "default"}>{t("检查更新")}</Button>
              {update?.updateAvailable ? (
                <Button disabled={updateInstallProgress.active} onClick={() => void actions.performUpdate()}>
                  {updateInstallProgress.active ? t("正在下载安装包…") : t("下载并运行安装包")}
                </Button>
              ) : null}
            </div>
          </div>
          {/* 由设置页统一自动保存更新偏好。 */}
          <div className="global-settings-list app-update-preferences">
            <div className="global-setting-row">
              <div className="global-setting-copy">
                <strong>{t("启动时自动检查更新")}</strong>
                <span>{t("打开 Codex Pilot 时及运行期间每隔几小时在后台检查新版本并提示。关闭后不再自动检查，仍可随时点「检查更新」。")}</span>
              </div>
              <div className="global-setting-actions">
                <Switch label={t("启动时自动检查更新")} on={form.updateAutoCheck !== false} onToggle={() => onFormChange({ ...form, updateAutoCheck: form.updateAutoCheck === false })} />
              </div>
            </div>
          </div>
          {update?.updateAvailable && update.releaseSummary ? (
            <details className="app-update-notes">
              <summary>{tf("{0} 更新说明", [update.latestVersion ?? ""])}</summary>
              <ReleaseNotes markdown={update.releaseSummary} onOpenUrl={(url) => void actions.openExternalUrl(url)} />
            </details>
          ) : null}
          <TaskProgressBox completedTitle={t("上次更新结果")} progress={updateInstallProgress} title={t("安装包更新进度")} />
        </CardContent>
      </Panel>
    </section>
  );
}

/// 设置页最前面的应用外观与配置文件分组。
function GlobalSettingsScreen({ section, settings, theme, themePreference, actions }: {
  section: "appearance" | "config";
  settings: SettingsResult | null;
  theme: Theme;
  themePreference: ThemePreference;
  actions: Actions;
}) {
  const settingsPath = settings?.settings_path ?? "";
  if (section === "config") return (
    <SettingsFold sectionId="app-settings-config" title={t("配置文件")}>
      <div className="global-settings-list">
        <div className="global-setting-row">
          <div className="global-setting-copy"><strong>{t("配置备份与迁移")}</strong><span>{t("导入或导出当前增强与管理器设置，导入后自动保存。")}</span></div>
          <div className="global-setting-actions">
            <Button size="sm" variant="secondary" onClick={() => void actions.exportSettings()}>{t("导出配置")}</Button>
            <Button size="sm" variant="secondary" onClick={() => void actions.importSettings()}>{t("导入配置")}</Button>
          </div>
        </div>
        <div className="global-setting-row">
          <div className="global-setting-copy"><strong>{t("配置文件路径")}</strong><code className="global-setting-path" title={settingsPath}>{settingsPath || "—"}</code><span>{t("只迁移 settings.json；日志、备份和运行状态仍留在原状态目录。更换后建议重新打开管理器。")}</span></div>
          <div className="global-setting-actions">
            <Button size="sm" variant="secondary" onClick={() => void actions.chooseSettingsPath()}>{t("选择路径")}</Button>
            <Button size="sm" variant="secondary" onClick={() => void actions.resetSettingsPath()}>{t("恢复默认路径")}</Button>
          </div>
        </div>
      </div>
    </SettingsFold>
  );
  return (
    <section className="compact-preferences" aria-labelledby="compact-preferences-heading">
      <h2 id="compact-preferences-heading">{t("通用")}</h2>
      <Panel id="app-settings-appearance">
        <CardContent className="global-settings-list">
          <div className="global-setting-row">
            <div className="global-setting-copy"><strong>{t("外观")}</strong><span>{themePreference === "system" ? `${t("跟随系统外观，当前为")}${theme === "dark" ? t("深色") : t("浅色")}${t("模式。")}` : `${t("当前为")}${theme === "dark" ? t("深色") : t("浅色")}${t("模式。")}`}</span></div>
            <div className="global-setting-actions"><div aria-label={t("界面主题")} className="segmented" role="group">
              {([["light", t("浅色")], ["dark", t("深色")], ["system", t("跟随系统")]] as const).map(([value, label]) => (
                <button aria-pressed={themePreference === value} className={themePreference === value ? "active" : ""} key={value} onClick={() => actions.setThemePreference(value)} type="button">{label}</button>
              ))}
            </div></div>
          </div>
          <div className="global-setting-row">
            <div className="global-setting-copy"><strong>{t("界面语言")}</strong></div>
            <div className="global-setting-actions"><AppSelect<"zh" | "en"> ariaLabel={t("界面语言")} value={getLanguage()} onChange={setLanguage} options={[{value: "zh", label: "简体中文"}, {value: "en", label: "English"}]} /></div>
          </div>
        </CardContent>
      </Panel>
    </section>
  );
}

/** 低频设置折叠；只有显式 sectionId 才持久化展开偏好，连接异常不保存为长期偏好。 */
function SettingsFold({ title, children, className = "", bodyClassName = "", issue, sectionId, defaultOpen = false }: {
  title: string;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  issue?: string | null;
  sectionId?: string;
  defaultOpen?: boolean;
}) {
  const preferenceKey = sectionId ? `codex-plus-settings-fold:${sectionId}` : null;
  const [open, setOpen] = useState(() => {
    if (issue) return true;
    try {
      const stored = preferenceKey ? window.localStorage.getItem(preferenceKey) : null;
      if (stored === "true" || stored === "false") return stored === "true";
    } catch {
      // 本地存储不可用时仍能正常展开设置。
    }
    return defaultOpen;
  });
  const previousIssue = useRef(issue);
  useEffect(() => {
    // 同一项错误更新文字时不抢回用户刚收起的面板，新出现的错误才展开。
    if (issue && !previousIssue.current) setOpen(true);
    previousIssue.current = issue;
  }, [issue]);
  return (
    <details id={sectionId} className={`compact-fold ${className}`.trim()} data-section={sectionId} open={open} onToggle={(event) => {
      const next = event.currentTarget.open;
      if (next === open) return;
      setOpen(next);
      if (preferenceKey) {
        try { window.localStorage.setItem(preferenceKey, String(next)); } catch { /* 偏好不可写不影响编辑。 */ }
      }
    }}>
      <summary className="compact-fold-summary">
        <ChevronDown aria-hidden="true" className="compact-fold-chevron h-4 w-4" />
        <strong>{title}</strong>
        {issue ? <span className="compact-fold-issue" title={issue}>{t("需要检查")}</span> : null}
      </summary>
      <div className={`compact-fold-body ${bodyClassName}`.trim()}>{children}</div>
    </details>
  );
}

function FeatureToggle({
  title,
  detail,
  checked,
  disabled = false,
  restartRequired = false,
  onChange,
}: {
  title: string;
  detail: string;
  checked: boolean;
  disabled?: boolean;
  restartRequired?: boolean;
  onChange: (value: boolean) => void;
}) {
  // 「（实验）」从标题里拿出来做成小标签；说明里写了要重启 Codex 的，标题旁加「需重启」。
  const experimental = EXPERIMENTAL_TITLE.test(title);
  const needsRestart = restartRequired || RESTART_HINT.test(detail);
  return (
    <label className={`feature-toggle ${disabled ? "disabled" : ""}`}>
      <input
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
        type="checkbox"
      />
      <span>
        <strong>
          {experimental ? title.replace(EXPERIMENTAL_TITLE, "") : title}
          {experimental ? <em className="feature-tag" data-tone="experimental">{t("实验")}</em> : null}
          {needsRestart ? <em className="feature-tag">{t("需重启")}</em> : null}
        </strong>
        <small>{detail}</small>
      </span>
      <ToggleVisual />
    </label>
  );
}

/** 打开设置页时滚到指定分组（例如启动时提示更新 → 版本与更新），滚完清掉。 */
function AppSettingsFocus({ focus, onDone }: { focus: string | null; onDone: () => void }) {
  useEffect(() => {
    if (!focus) return;
    const frame = window.requestAnimationFrame(() => {
      revealSettingsSection(focus);
      onDone();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focus, onDone]);
  return null;
}

/** 原生 details 的展开同步发生；先展开外层，隐藏的目标才能正确参与布局和滚动。 */
function revealSettingsSection(focus: string) {
  const target = document.getElementById(focus);
  if (!target) return;
  const ancestors: HTMLElement[] = [];
  for (let node: HTMLElement | null = target; node; node = node.parentElement) ancestors.push(node);
  for (const node of ancestors.reverse()) if (node.tagName === "DETAILS") (node as HTMLDetailsElement).open = true;
  target.scrollIntoView({ block: "start" });
}

const EXPERIMENTAL_TITLE = /\s*(?:（实验性?）|\(experimental\))$/i;
const RESTART_HINT = /重启 ?Codex|重新启动 ?Codex|下次启动 ?Codex|restart(?:ing)? Codex|relaunch/i;

function ToggleVisual() {
  return (
    <span aria-hidden="true" className="toggle-switch-visual">
      <span className="toggle-switch-thumb" />
    </span>
  );
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function formatProgressPercent(value: number): string {
  if (!Number.isFinite(value)) return "0.00";
  return Math.min(100, Math.max(0, value)).toFixed(2);
}

function UpdateDialog({ update, progress, onClose, onSkipVersion, onMuteToday, onUpdate, onOpenUrl }: {
  update: UpdateResult;
  progress: TaskProgress;
  onClose: () => void;
  onSkipVersion: () => void;
  onMuteToday: () => void;
  onUpdate: () => void;
  onOpenUrl: (url: string) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => { if (dialog?.open) dialog.close(); };
  }, []);

  return (
    <dialog className="modal-card update-dialog" ref={dialogRef} aria-labelledby="update-dialog-title" aria-describedby="update-dialog-description" onCancel={(event) => { event.preventDefault(); onClose(); }}>
      <div className="modal-head">
        <div>
          <h2 id="update-dialog-title">{tf("发现新版本 {0}", [update.latestVersion ?? ""])}</h2>
          <p id="update-dialog-description">{tf("当前版本 {0}", [update.currentVersion])}</p>
        </div>
        <button className="toast-close" onClick={onClose} type="button" aria-label={t("关闭更新提示")}>×</button>
      </div>
      <div className="update-dialog-body">
        <ReleaseNotes markdown={update.releaseSummary || t("发现可用更新。")} onOpenUrl={onOpenUrl} />
      </div>
      <TaskProgressBox completedTitle={t("上次更新结果")} progress={progress} title={t("安装包更新进度")} />
      <p className="update-dialog-hint">{t("也可随时在设置的“版本与更新”中检查和安装更新。")}</p>
      {!update.assetName || !update.assetUrl ? <p className="update-dialog-hint">{t("此版本暂未提供适用于当前系统的安装包。")}</p> : null}
      <Toolbar className="update-dialog-actions">
        <Button autoFocus disabled={progress.active || !update.assetName || !update.assetUrl} onClick={onUpdate}>
          <Download className="h-4 w-4" />
          {progress.active ? t("正在下载安装包…") : t("立即更新")}
        </Button>
        <Button variant="secondary" onClick={onClose}>{t("关闭提示")}</Button>
        <Button variant="ghost" onClick={onMuteToday}>{t("今日不再提示")}</Button>
        <Button variant="ghost" onClick={onSkipVersion}>{t("跳过此版本")}</Button>
      </Toolbar>
    </dialog>
  );
}

/**
 * 右下角的提示卡：左侧状态色条 + 图标，按成功 / 警告 / 失败 / 信息分色。
 * 鼠标停在卡片上时暂停倒计时；失败提示停留更久，并可一键复制详情。
 */
function NoticeDialog({
  notice,
  onClose,
}: {
  notice: { title: string; message: string; status?: Status };
  onClose: () => void;
}) {
  const tone = noticeTone(notice.status);
  const duration = noticeDuration(tone, notice.message);
  const [paused, setPaused] = useState(false);
  const [copied, setCopied] = useState(false);
  const remaining = useRef(duration);

  useEffect(() => {
    if (paused) return;
    const startedAt = Date.now();
    const timer = window.setTimeout(onClose, Math.max(0, remaining.current));
    return () => {
      window.clearTimeout(timer);
      remaining.current -= Date.now() - startedAt;
    };
    // onClose 每次渲染都是新函数，倒计时只随暂停状态变化。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused]);

  const Icon = tone === "error" ? CircleX : tone === "warning" ? TriangleAlert : tone === "info" ? Info : CheckCircle2;
  const copyDetails = () => {
    void navigator.clipboard?.writeText(`${notice.title}\n${notice.message}`).then(() => setCopied(true)).catch(() => undefined);
  };

  return (
    <div className="toast-wrap" role={tone === "error" ? "alert" : "status"} aria-live={tone === "error" ? "assertive" : "polite"}>
      <div
        className="toast-card"
        data-tone={tone}
        onBlur={() => setPaused(false)}
        onFocus={() => setPaused(true)}
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
      >
        <span className="toast-icon"><Icon aria-hidden="true" /></span>
        <div className="toast-body">
          <h2>{notice.title}</h2>
          {notice.message ? <p>{notice.message}</p> : null}
          {tone === "error" && notice.message ? (
            <button className="toast-action" onClick={copyDetails} type="button">
              {copied ? <CheckCircle2 aria-hidden="true" /> : <Copy aria-hidden="true" />}
              {copied ? t("已复制") : t("复制详情")}
            </button>
          ) : null}
        </div>
        <button aria-label={t("关闭提示")} className="toast-dismiss" onClick={onClose} type="button">
          <X aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

function ConfirmDialog({
  confirm,
  onConfirm,
  onCancel,
}: {
  confirm: { title: string; message: string; confirmText: string; cancelText: string };
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal-card confirm-modal">
        <div className="modal-head">
          <div>
            <h2>{confirm.title}</h2>
          </div>
          <button className="toast-close" onClick={onCancel} type="button">×</button>
        </div>
        <div className="confirm-modal-body">
          <p className="modal-message">{confirm.message}</p>
        </div>
        <Toolbar className="confirm-modal-actions">
          <Button onClick={onConfirm}>
            <Trash2 className="h-4 w-4" />
            {confirm.confirmText}
          </Button>
          <Button onClick={onCancel} variant="secondary">{confirm.cancelText}</Button>
        </Toolbar>
      </div>
    </div>
  );
}

function TaskProgressBox({ progress, title, completedTitle = t("上次修复结果") }: { progress: TaskProgress; title: string; completedTitle?: string }) {
  if (!progress.active && progress.percent <= 0 && !progress.failed) return null;
  return (
    <div className="provider-sync-progress task-progress" data-active={progress.active}>
      <div className="provider-sync-progress-head">
        <strong>{progress.active ? title : completedTitle}</strong>
        <span>{progress.indeterminate || progress.failed ? null : `${formatProgressPercent(progress.percent)}%`}</span>
      </div>
      {!progress.failed ? <div
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={progress.indeterminate ? undefined : progress.percent}
        className="provider-sync-progress-bar"
        data-indeterminate={progress.indeterminate ? "true" : undefined}
        role="progressbar"
      >
        <div
          className="provider-sync-progress-fill"
          style={progress.indeterminate ? undefined : { width: `${progress.percent}%` }}
        />
      </div> : null}
      <small>{progress.message}</small>
    </div>
  );
}

function Panel({ children, fill = false, className = "", id }: { children: React.ReactNode; fill?: boolean; className?: string; id?: string }) {
  return (
    <Card className={`panel ${fill ? "fill" : ""} ${className}`} id={id}>
      {children}
    </Card>
  );
}

/// 设置行：左边标题 + 一句短说明，右边控件；长说明放进悬停提示（`detail`）。
/// `stacked` 时控件放到说明下方，给状态码编辑、多行输入这类宽控件用。
function SettingRow({ title, description, detail, stacked = false, children }: {
  title: ReactNode;
  description?: ReactNode;
  detail?: string;
  stacked?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={`setting-row${stacked ? " setting-row-stacked" : ""}`} title={detail}>
      <div className="setting-row-copy">
        <strong>{title}</strong>
        {description ? <span>{description}</span> : null}
      </div>
      {children ? <div className="setting-row-control">{children}</div> : null}
    </div>
  );
}

function Toolbar({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`toolbar ${className}`.trim()}>{children}</div>;
}

const SIDEBAR_DEFAULT_WIDTH = 192;
const SIDEBAR_MIN_WIDTH = 160;
const SIDEBAR_MAX_WIDTH = 320;
const SIDEBAR_CONTENT_MIN_WIDTH = 480;
const SIDEBAR_WIDTH_STORAGE_KEY = "codex-plus-manager-sidebar-width";

/** 为正文预留空间；无效偏好回到默认值，窗口变窄时也不能把侧栏拖出边界。 */
function clampSidebarWidth(width: number, availableWidth: number): number {
  const maximum = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, availableWidth - SIDEBAR_CONTENT_MIN_WIDTH));
  return Math.round(Math.max(SIDEBAR_MIN_WIDTH, Math.min(maximum, Number.isFinite(width) ? width : SIDEBAR_DEFAULT_WIDTH)));
}

function loadSidebarWidth(): number {
  try {
    const stored = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    return clampSidebarWidth(stored === null || stored.trim() === "" ? SIDEBAR_DEFAULT_WIDTH : Number(stored), window.innerWidth);
  } catch {
    // 偏好不可读时仍允许拖动，宽度仅在当前窗口内生效。
    return clampSidebarWidth(SIDEBAR_DEFAULT_WIDTH, window.innerWidth);
  }
}

/** 运行按钮固定在底部；宽度偏好只保存在管理器本机，不参与增强配置的自动保存。 */
function CompactSidebar({ route, onNavigate, launch }: {
  route: Route;
  onNavigate: (route: Route) => void;
  launch: CodexLaunchState;
}) {
  const sidebarRef = useRef<HTMLElement>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const [width, setWidth] = useState(loadSidebarWidth);
  const [availableWidth, setAvailableWidth] = useState(() => window.innerWidth);
  const [resizing, setResizing] = useState(false);

  useEffect(() => {
    const shell = sidebarRef.current?.parentElement;
    if (!shell) return;
    const observer = new ResizeObserver(() => setAvailableWidth(shell.clientWidth));
    setAvailableWidth(shell.clientWidth);
    observer.observe(shell);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setWidth((current) => clampSidebarWidth(current, availableWidth));
  }, [availableWidth]);

  useEffect(() => {
    // 拖动时先更新布局，停下后再记住宽度，避免每次指针移动都同步写入存储。
    const timer = window.setTimeout(() => {
      try { window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(width)); } catch { /* 偏好不可写不影响调整。 */ }
    }, 200);
    return () => window.clearTimeout(timer);
  }, [width]);

  const resize = (next: number) => setWidth(clampSidebarWidth(next, availableWidth));
  const finishResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setResizing(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return (
    <aside className="compact-sidebar" ref={sidebarRef} data-resizing={resizing} style={{ "--manager-sidebar-width": `${width}px` } as CSSProperties}>
      <div className="compact-sidebar-drag" data-tauri-drag-region aria-hidden="true" />
      <button className="compact-brand" onClick={() => onNavigate("enhance")} type="button" aria-label={t("返回增强页")}>
        <img alt="" src={APP_LOGO_URL} /><strong>Codex Pilot</strong>
      </button>
      <nav className="compact-navigation" aria-label={t("主导航")}>
        {routes.map((item) => <button key={item.id} className={route === item.id ? "active" : ""} aria-label={item.label} aria-current={route === item.id ? "page" : undefined} onClick={() => onNavigate(item.id)} type="button"><item.icon className="h-4 w-4" aria-hidden="true" /><span>{item.label}</span></button>)}
      </nav>
      <footer className="compact-sidebar-footer" aria-label={t("Codex 运行控制")}>
        <CodexLaunchButton size="sm" state={launch} />
      </footer>
      <div
        className="compact-sidebar-resize"
        role="separator"
        tabIndex={0}
        aria-orientation="vertical"
        aria-label={t("调整侧栏宽度")}
        aria-controls="manager-workspace"
        aria-valuemin={SIDEBAR_MIN_WIDTH}
        aria-valuemax={clampSidebarWidth(SIDEBAR_MAX_WIDTH, availableWidth)}
        aria-valuenow={width}
        title={t("拖动调整侧栏宽度，双击恢复默认")}
        onPointerDown={(event) => {
          if (event.button !== 0 || !event.isPrimary) return;
          event.preventDefault();
          // 捕获指针后移出手柄仍能连续拖动；手柄独立于 macOS 的窗口拖动区域。
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width };
          setResizing(true);
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (drag?.pointerId === event.pointerId) resize(drag.startWidth + event.clientX - drag.startX);
        }}
        onPointerUp={finishResize}
        onPointerCancel={(event) => {
          if (dragRef.current?.pointerId === event.pointerId) resize(dragRef.current.startWidth);
          finishResize(event);
        }}
        onLostPointerCapture={finishResize}
        onDoubleClick={() => resize(SIDEBAR_DEFAULT_WIDTH)}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 24 : 8;
          const next = event.key === "ArrowLeft" ? width - step : event.key === "ArrowRight" ? width + step
            : event.key === "Home" ? SIDEBAR_MIN_WIDTH : event.key === "End" ? SIDEBAR_MAX_WIDTH
              : event.key === "Enter" ? SIDEBAR_DEFAULT_WIDTH : null;
          if (next === null) return;
          event.preventDefault();
          resize(next);
        }}
      />
    </aside>
  );
}

/** 页头首行并排显示小图标与菜单名，第二行保留唯一的自动保存反馈；空白区域可拖动。 */
function AppHeader({ route, children }: {
  route: Route;
  children?: ReactNode;
}) {
  const current = routes.find((item) => item.id === route) ?? routes[0];
  const Icon = current.icon;
  return (
    <header className="compact-header" data-tauri-drag-region>
      <h1 data-tauri-drag-region>
        <span className="compact-header-icon" aria-hidden="true" data-tauri-drag-region><Icon /></span>
        {current.label}
      </h1>
      {children}
    </header>
  );
}

function Field({ label, children, className = "" }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <Label className={`field ${className}`}>
      <span>{label}</span>
      {children}
    </Label>
  );
}

function StatusRow({ title, status = "unknown", path }: { title: string; status?: string; path?: string | null }) {
  return (
    <div className="status-row">
      <span>{title}</span>
      <Badge status={status} />
      <code>{path || t("未记录路径")}</code>
    </div>
  );
}

function Badge({ status }: { status: string }) {
  return <UiBadge className={statusClass(status)} variant="secondary">{statusLabel(status)}</UiBadge>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function statusLabel(status: string) {
  const labels: Record<string, string> = {
    found: t("已找到"),
    missing: t("缺失"),
    installed: t("已安装"),
    ok: t("正常"),
    running: t("运行中"),
    running_degraded: t("运行中（增强等待中）"),
    degraded: t("已降级"),
    starting: t("启动中"),
    failed: t("失败"),
    archived: t("已归档"),
    accepted: t("已受理"),
    not_checked: t("未检查"),
    not_implemented: t("未实现"),
    disabled: t("已禁用"),
    stopped: t("未运行"),
    waiting: t("等待启动"),
    off: t("未启用"),
    connected: t("已连接"),
    disconnected: t("未连接"),
    unknown: t("未知"),
  };
  return labels[status] ?? status;
}

function statusClass(status: string) {
  if (["found", "installed", "ok", "running", "running_degraded", "connected"].includes(status)) return "good";
  if (status === "waiting" || status === "off") return "idle";
  if (["failed", "missing"].includes(status)) return "bad";
  return "warn";
}

function isSuccessStatus(status?: Status) {
  return status === "ok" || status === "accepted";
}

/// 后端「降级但流程可继续」的状态。目前用于回填跳过（live config.toml 语法
/// 错误，issue #618）：要在提示用户的同时继续执行，不能当成失败中断。

/// 仅展示 Codex 应用与 CDP 调试连接，不依赖已移除的 HTTP 服务。
function healthItems(overview: OverviewResult | null): Array<{ title: string; status: string; ok: boolean; detail: string; icon: LucideIcon }> {
  const serviceItem = (title: string, state: RuntimeServiceState | undefined, icon: LucideIcon) => ({
    title,
    status: state?.status ?? "not_checked",
    ok: ["running", "connected", "disabled"].includes(state?.status ?? ""),
    detail: state ? [state.address, t(state.message)].filter(Boolean).join(" · ") : t("等待状态检查"),
    icon,
  });
  const debuggerState = overview?.runtime_health?.debugger;
  const codexRunning = overview?.runtime_health?.codex_app?.status === "running";
  const debuggerHealth = debuggerState && debuggerState.status !== "connected" && !codexRunning
    ? {
      title: t("调试连接状态"),
      status: "waiting",
      ok: true,
      detail: [debuggerState.address, t("Codex 未运行，启动后自动连接")].filter(Boolean).join(" · "),
      icon: Bug,
    }
    : serviceItem(t("调试连接状态"), debuggerState, Bug);
  return [
    {
      title: t("Codex 应用"),
      status: overview?.codex_app.status ?? "not_checked",
      ok: overview?.codex_app.status === "found",
      detail: overview?.codex_app.path || t("尚未检查 Codex 应用路径。"),
      icon: AppWindow,
    },
    debuggerHealth,
  ];
}

function normalizeSettings(settings: BackendSettings): BackendSettings {
  return { ...defaultSettings, ...settings };
}

function backendSettingsEqual(left: BackendSettings, right: BackendSettings): boolean {
  const { revision: _leftRevision, ...leftValues } = normalizeSettings(left);
  const { revision: _rightRevision, ...rightValues } = normalizeSettings(right);
  return JSON.stringify(leftValues) === JSON.stringify(rightValues);
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function parsePort(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : fallback;
}

/** 协议取值归一化：认不出的值一律回退 Responses，避免脏数据把上游写成直连。 */

/** Anthropic 认证字段：只允许 `x-api-key` 与 `authorization`，缺省用前者。 */

/** 思考模式：只认四个取值，其余（含空串）按 auto。 */

/** Anthropic 的 `max_tokens` 兜底值：空/非法按 0（用内置 8192），上限 200000。 */

/// 列表标签用的短协议名：卡片空间小，「转 Responses」留在编辑页里说明。

/// 接入方式标签的配色分组。

/// 网址只显示主机名；解析不了就原样返回。

/// 解析模型后缀语法，如 deepseek-v4-flash[1M] -> { slug: "deepseek-v4-flash", window: 1000000 }
/// 非法或没有后缀时返回原串作为 slug。剥离与换算统一走 model-metadata.ts 的
/// suffixWindowString/modelSlugFromRowName，避免两处实现对「什么算合法后缀」
/// 的判断分叉。

// 创建时选定类型；重新创建草稿时不沿用另一类的路由、权重或测试模型。

function stringifyError(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function loadInitialRoute(): Route {return "enhance";}

/** 启动时要看更新，就滚到版本与更新。 */
function initialSettingsFocus(): string | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  return params.get("showUpdate") === "1" ? "app-settings-update" : null;
}
