import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const text = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const app = ts.createSourceFile("App.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function functionSource(name: string) {
  const declaration = app.statements.find(
    (statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  assert.ok(declaration, `${name} should exist`);
  return declaration.getText(app);
}

test("连接详情常驻展示两类状态卡片，标题旁使用刷新图标", () => {
  const screen = functionSource("OverviewScreen");
  const items = functionSource("healthItems");
  for (const title of ["Codex 应用", "调试连接状态"]) assert.ok(items.includes(`t("${title}")`));
  assert.doesNotMatch(items, /协议转换|供应商|local_server|本地服务器状态/);
  assert.match(screen, /connection-grid/);
  assert.match(screen, /<article className="connection-card"/);
  assert.doesNotMatch(screen, /SettingsFold|<details|CodexLaunchButton/);
  assert.match(screen, /<h3 id="compact-connection-heading">/);
  assert.match(screen, /aria-label=\{t\("刷新状态"\)\}/);
  assert.match(screen, /<RefreshCw/);
  assert.match(screen, /disabled=\{refreshing\}/);
  assert.match(screen, /actions.refreshCurrent/);
});

test("轻量摘要区分未运行、等待连接和增强就绪，不把进程运行当成连接成功", () => {
  const context = vm.createContext({ t: (text: string) => text });
  vm.runInContext(ts.transpileModule(functionSource("runtimeSummary"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  const overview = (debuggerState = "connected", app = "found") => ({
    codex_app: { status: app }, runtime_health: { debugger: { status: debuggerState } },
  });
  assert.equal(context.runtimeSummary(null, false).tone, "idle");
  assert.equal(context.runtimeSummary(overview(), false).message, "Codex 未运行");
  assert.equal(context.runtimeSummary(overview(), true).tone, "success");
  assert.equal(context.runtimeSummary(overview("disconnected"), true).tone, "warning");
  assert.equal(context.runtimeSummary(overview("failed"), true).tone, "error");
  assert.equal(context.runtimeSummary(overview("degraded"), true).tone, "error");
  assert.equal(context.runtimeSummary(overview("connected", "missing"), false).tone, "error");
  // 关闭增强后，调试端口仍可访问也不应显示增强已连接。
  assert.equal(context.runtimeSummary(overview(), true, false).message, "增强已关闭");
});

test("maintenance retains application entrypoint checks and repairs", () => {
  const screen = functionSource("MaintenanceScreen");
  assert.match(screen, /management_shortcut/);
  assert.match(screen, /actions\.checkHealth\(\)/);
  assert.match(screen, /actions\.repairShortcuts\(\)/);
});

test("settings exposes reviewed configuration export and draft import", () => {
  const screen = functionSource("GlobalSettingsScreen");
  assert.match(screen, /actions\.exportSettings\(\)/);
  assert.match(screen, /actions\.importSettings\(\)/);
  const entry = functionSource("App");
  assert.match(entry, /call<CommandResult<\{ path: string \}>>\("export_settings"/);
  assert.match(entry, /call<SettingsResult>\("preview_import_settings"/);
  assert.match(entry, /call<SettingsResult>\("set_settings_path"/);
  assert.match(entry, /call<SettingsResult>\("reset_settings_path"/);
});

test("maintenance no longer offers the removed entrypoint management panel", () => {
  const screen = functionSource("MaintenanceScreen");
  assert.doesNotMatch(screen, /入口管理|安装入口|卸载入口|修复入口|卸载时移除 Codex Pilot 托管数据/);
  assert.doesNotMatch(screen, /actions\.installEntrypoints|actions\.uninstallEntrypoints|removeOwnedData/);
  const entry = functionSource("App");
  assert.doesNotMatch(entry, /install_entrypoints|uninstall_entrypoints|removeOwnedData|installEntrypoints|uninstallEntrypoints/);
});

test("maintenance drives login startup and auto-takeover with switches", () => {
  const screen = functionSource("MaintenanceScreen");
  assert.match(screen, /switch-row/);
  assert.match(screen, /actions\.setWatcherEnabled\(event\.currentTarget\.checked\)/);
  assert.match(screen, /actions\.setWatcherStartCodex\(event\.currentTarget\.checked\)/);
  assert.match(screen, /actions\.setWatcherStartCodexOnOpen\(event\.currentTarget\.checked\)/);
  assert.match(screen, /actions\.setAutoTakeover\(event\.currentTarget\.checked\)/);
  // 开关取代了这两组按钮，别再退回去。
  assert.doesNotMatch(
    screen,
    /actions\.(installWatcher|uninstallWatcher|enableWatcher|disableWatcher)|设置开机启动|移除开机启动|关闭自动接管/,
  );
});

test("watcher switch command is wired through invoke, handler and backend", () => {
  const entry = functionSource("App");
  assert.match(entry, /call<WatcherResult>\("set_watcher_enabled", \{ enabled \}\)/);
  const lib = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  assert.match(lib, /commands::set_watcher_enabled,/);
  const commands = readFileSync(new URL("../src-tauri/src/commands.rs", import.meta.url), "utf8");
  assert.match(commands, /pub fn set_watcher_enabled\(enabled: bool\)/);
  assert.match(commands, /pub fn set_watcher_start_codex\(start_codex: bool\)/);
  assert.match(commands, /pub fn set_watcher_start_codex_on_open\(enabled: bool\)/);
  assert.match(lib, /commands::set_watcher_start_codex,/);
  assert.match(lib, /commands::set_watcher_start_codex_on_open,/);
});
