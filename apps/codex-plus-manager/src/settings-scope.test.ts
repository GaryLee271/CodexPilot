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

test("设置保留外观与配置文件，移除自定义启动参数", () => {
  const global = functionSource("GlobalSettingsScreen");

  for (const copy of ["外观", "配置备份与迁移", "配置文件路径"]) {
    assert.ok(global.includes(`t("${copy}")`), `应用偏好应包含 ${copy}`);
  }
  assert.doesNotMatch(global, /Codex 供应商设置|Codex 启动参数|Codex 专属设置|打开 Codex 设置/);
  assert.doesNotMatch(text, /OnboardingTour|tourOpen|onboarding-model|新手引导|重新打开引导|app-settings-general|useTrayPanelSetting|useLightweightModeSetting|main_window_release_when_hidden/);
  for (const action of ["actions.setThemePreference", "actions.exportSettings", "actions.importSettings"]) {
    assert.ok(global.includes(action), `应用偏好应保留 ${action}`);
  }

  assert.doesNotMatch(text, /AgentSettingsScreen|codexExtraArgs|inputToCodexExtraArgs|codex-settings-launch-args|launch-args-input/);
});

test("管理器只提供 Codex 增强与配置，不再选择使用模式", () => {
  assert.doesNotMatch(text, /AgentFocusDialog|agentFocusOpen|gatewayNavigationRoutes|toolNavigationRoutes|relayProfilesEnabled/);
  assert.match(text, /id: "settings", get label\(\) \{ return t\("设置"\); \}/);
  assert.doesNotMatch(text, /agentSettings|t\("整体设置"\)/);
  for (const route of ["sessions", "relay", "multiLaunch", "computerUse", "gatewayUsage"]) {
    assert.ok(!text.includes(`id: "${route}"`), route);
  }
  assert.match(functionSource("MaintenanceScreen"), /codex-settings-check/);
});

test("设置收敛为通用、启动与接管、配置与维护、版本更新", () => {
  assert.doesNotMatch(text, /PageSectionNav|settingsSections/);
  assert.match(functionSource("GlobalSettingsScreen"), /compact-preferences-heading/);
  assert.match(functionSource("MaintenanceScreen"), /compact-startup-heading/);
  assert.match(functionSource("App"), /compact-config-heading/);
  assert.match(functionSource("UpdateSettingsScreen"), /app-settings-update/);
  assert.doesNotMatch(text, /AboutScreen|LogsPanel|DiagnosticsPanel|read_latest_logs|clear_logs|copy_diagnostics|refreshLogs|refreshDiagnostics|app-settings-(?:about|logs|diagnostics)|id: "about"/);
  const commands = readFileSync(new URL("../src-tauri/src/commands.rs", import.meta.url), "utf8");
  const backend = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  assert.doesNotMatch(commands + backend, /read_latest_logs|clear_logs|copy_diagnostics|diagnostics_report/);
  assert.match(commands, /pub fn write_diagnostic_event/);
  assert.match(backend, /commands::write_diagnostic_event/);
});

test("移除手动启动面板后，运行控制直接调用后端默认入口", async () => {
  assert.doesNotMatch(text, /codex-settings-manual-launch|launchForm|setLaunchForm|onLaunchFormChange|saveManualCodexAppPath|应用路径覆盖|Debug 端口|Helper 端口/);
  const maintenance = functionSource("MaintenanceScreen");
  assert.match(maintenance, /actions\.chooseCodexAppPath/);
  assert.match(maintenance, /actions\.clearCodexAppPath/);

  let command: ts.VariableDeclaration | undefined;
  const find = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(app) === "launchCommand") command = node;
    ts.forEachChild(node, find);
  };
  ts.forEachChild(app, find);
  assert.ok(command);
  const script = ts.transpileModule(`const ${command.getText(app)}; globalThis.execute = launchCommand;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const calls: unknown[][] = [];
  const context = vm.createContext({
    run: (action: () => unknown) => action(),
    call: (...args: unknown[]) => { calls.push(args); return { status: "ok" }; },
  });
  vm.runInContext(script, context);
  for (const name of ["launch_codex_plus", "restart_codex_plus", "stop_codex_plus"]) {
    assert.equal((await context.execute(name)).status, "ok");
  }
  assert.deepEqual(calls, [["launch_codex_plus"], ["restart_codex_plus"], ["stop_codex_plus"]]);
});

test("合并后的设置页按目录顺序渲染，共用一份表单与自动保存", () => {
  const entry = app.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "App");
  assert.ok(entry);
  const elements: Array<ts.JsxOpeningElement | ts.JsxSelfClosingElement> = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) elements.push(node);
    ts.forEachChild(node, visit);
  };
  visit(entry);
  const parts = elements.filter(node => ["GlobalSettingsScreen", "UpdateSettingsScreen", "MaintenanceScreen"].includes(node.tagName.getText(app)));
  assert.deepEqual(parts.map(node => node.tagName.getText(app)), [
    "GlobalSettingsScreen", "MaintenanceScreen", "GlobalSettingsScreen", "MaintenanceScreen", "UpdateSettingsScreen",
  ]);
  const attr = (node: typeof parts[number], name: string) => node.attributes.properties.find(item => ts.isJsxAttribute(item) && item.name.getText(app) === name)?.getText(app);
  for (const node of parts.filter(node => node.tagName.getText(app) === "UpdateSettingsScreen")) {
    assert.equal(attr(node, "form"), "form={settingsForm}");
    assert.equal(attr(node, "onFormChange"), "onFormChange={setSettingsForm}");
  }
  const autosave = elements.filter(node => node.tagName.getText(app) === "SettingsAutoSave");
  assert.equal(autosave.length, 1);
  assert.equal(attr(autosave[0], "form"), "form={settingsForm}");
  assert.ok(autosave[0].pos < parts[0].pos);
  // 保存控制器位于不会随 route 重建的页头内，两个正文均不再创建副本。
  assert.ok(autosave[0].parent && ts.isJsxElement(autosave[0].parent));
  assert.equal(autosave[0].parent.openingElement.tagName.getText(app), "AppHeader");
  assert.doesNotMatch(functionSource("EnhanceScreen"), /SettingsAutoSave|AutoSaveStatus|useEnhanceAutoSave/);
  assert.doesNotMatch(functionSource("GlobalSettingsScreen") + functionSource("UpdateSettingsScreen"), /SettingsAutoSave/);
  assert.match(functionSource("App"), /await navigate\("settings"\)/);
  assert.match(functionSource("App"), /await navigate\(destination.route\)/);
  assert.match(functionSource("App"), /target === "maintenance" \? "settings" : target === "overview" \? "enhance" : target/);
});

test("切页保留共享草稿，已加载设置时不重新读取覆盖待保存内容", async () => {
  let declaration: ts.VariableDeclaration | undefined;
  const find = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(app) === "navigate") declaration = node;
    ts.forEachChild(node, find);
  };
  ts.forEachChild(app, find);
  assert.ok(declaration);
  let reads = 0;
  const context = vm.createContext({
    settingsRef: { current: { settings: { codexAppNativePredictionsModel: "saved" } } },
    setRoute: () => {},
    refreshSettings: async () => { reads++; },
    refreshOverview: async () => {},
    refreshWatcher: async () => {},
    refreshAutoTakeover: async () => {},
  });
  vm.runInContext(ts.transpileModule(`const ${declaration.getText(app)}; globalThis.navigate = navigate;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  await context.navigate("settings");
  await context.navigate("enhance");
  assert.equal(reads, 0);
  context.settingsRef.current = null;
  await context.navigate("enhance");
  assert.equal(reads, 1, "首次尚未加载设置时仍应读取");
});

test("切页刷新消掉草稿后，取消待保存任务并恢复空闲提示", () => {
  let status: { state: string } | undefined;
  const refs: Array<{ current: unknown }> = [];
  let refIndex = 0;
  const effects: Array<() => (() => void) | undefined> = [];
  const timers = new Map<number, () => void>();
  const context = vm.createContext({
    ENHANCE_AUTO_SAVE_DELAY_MS: 500,
    useState: (initial: { state: string }) => {
      status ??= initial;
      return [status, (update: { state: string } | ((previous: { state: string }) => { state: string })) => {
        status = typeof update === "function" ? update(status!) : update;
      }];
    },
    useRef: (initial: unknown) => { const index = refIndex++; return refs[index] ??= { current: initial }; },
    useCallback: (callback: unknown) => callback,
    useEffect: (callback: typeof effects[number]) => { effects.push(callback); },
    window: { setTimeout: (callback: () => void) => { timers.set(1, callback); return 1; }, clearTimeout: (id: number) => timers.delete(id) },
  });
  vm.runInContext(ts.transpileModule(functionSource("useEnhanceAutoSave"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  const render = (dirty: boolean) => {
    refIndex = 0;
    effects.length = 0;
    return context.useEnhanceAutoSave(dirty, {}, () => { throw new Error("No unchanged settings should be saved"); });
  };
  render(true);
  const cleanup = effects[0]();
  assert.equal(status?.state, "pending");
  render(false);
  cleanup?.();
  effects[0]();
  assert.equal(render(false).state, "idle");
  assert.equal(timers.size, 0);
});
