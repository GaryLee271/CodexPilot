import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";
import {
  enhancementCatalog,
  enhancementCatalogStrings,
  enhancementGroup,
  enhancementGroupAnchorId,
  enhancementItem,
  managerBuiltinCards,
  managerBuiltinGroups,
  managerGroupItems,
  type EnhancementPlatform,
} from "./enhancement-catalog.ts";
import { EN_PLAIN } from "./i18n-en.ts";

const appSource = await readFile(new URL("./App.tsx", import.meta.url), "utf8");
const app = ts.createSourceFile("App.tsx", appSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function descendants(node: ts.Node): ts.Node[] {
  const result: ts.Node[] = [];
  const visit = (child: ts.Node) => {
    result.push(child);
    ts.forEachChild(child, visit);
  };
  visit(node);
  return result;
}

function component(name: string): ts.FunctionDeclaration {
  const declaration = app.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration && ts.isFunctionDeclaration(declaration), `missing ${name}`);
  return declaration;
}

function elements(node: ts.Node): Array<ts.JsxOpeningElement | ts.JsxSelfClosingElement> {
  return descendants(node).filter((child): child is ts.JsxOpeningElement | ts.JsxSelfClosingElement =>
    ts.isJsxOpeningElement(child) || ts.isJsxSelfClosingElement(child),
  );
}

function attribute(element: ts.JsxOpeningElement | ts.JsxSelfClosingElement, name: string): string | undefined {
  const property = element.attributes.properties.find((node) => ts.isJsxAttribute(node) && node.name.getText(app) === name);
  if (!property || !ts.isJsxAttribute(property)) return undefined;
  const initializer = property.initializer;
  if (initializer && ts.isJsxExpression(initializer)) return initializer.expression?.getText(app);
  return initializer && ts.isStringLiteral(initializer) ? initializer.text : undefined;
}

function isConditional(node: ts.Node, boundary: ts.Node): boolean {
  for (let parent = node.parent; parent && parent !== boundary; parent = parent.parent) {
    if (ts.isConditionalExpression(parent) || (ts.isBinaryExpression(parent)
      && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken].includes(parent.operatorToken.kind))) return true;
  }
  return false;
}

test("retired enhancements have no settings, navigation or command references in the manager UI", () => {
  const retired = new Set([
    "codexAppZedRemoteOpen", "zedRemoteOpenStrategy", "zedRemoteProjectRegistryEnabled", "zedRemoteSyncToZedSettings",
    "codexAppUpstreamWorktreeCreate", "codexAppNativeMenuLocalization",
    "codexAppFastStartup", "快速启动",
    "dictation", "DictationSettingsPanel", "StepwiseSettingsPanel", "codexAppStepwiseEnabled",
    "codexAppStepwiseBaseUrl", "codexAppStepwiseApiKey", "test_stepwise_settings",
    "download_dictation_local_model", "dictation_local_model_status", "test_dictation_hotkey",
    "codexAppServiceTierControls", "Fast 按钮",
    "ZedRemoteScreen", "ZedRemoteProjectSection", "zedRemote", "list_zed_remote_projects", "open_zed_remote", "forget_zed_remote_project",
    "launchMode", "LaunchMode", "ModeSelector", "saveLaunchMode", "setLaunchMode", "patchMode",
    "repairPluginMarketplace", "refreshRemotePluginMarketplace", "repairRemotePluginMarketplace",
    "PluginMarketplaceRepairResult", "PluginMarketplaceStatusResult", "RemotePluginMarketplaceResult",
    "pluginMarketplaceProgress", "remotePluginMarketplace", "remotePluginMarketplaceProgress",
    "setPluginMarketplaceProgress", "setRemotePluginMarketplace", "setRemotePluginMarketplaceProgress",
    "repair_plugin_marketplace", "plugin_marketplace_status", "remote_plugin_marketplace_status", "repair_remote_plugin_marketplace",
    "修复插件市场", "官方远端插件缓存", "插件市场修复进度", "官方远端插件缓存进度", "释放并注册内置缓存",
  ]);
  const references = descendants(app)
    .filter((node) => ts.isIdentifier(node) || ts.isStringLiteral(node))
    .map((node) => (node as ts.Identifier | ts.StringLiteral).text)
    .filter((name) => retired.has(name));
  assert.deepEqual([...new Set(references)], []);
});

const ENHANCEMENT_COMPONENTS = ["EnhanceScreen", "EnhancementSettingControl", "BuiltinExtensionCardView"];

test("conversation tabs share both settings surfaces and apply without a restart", () => {
  const item = enhancementCatalog.items.find((entry) => entry.key === "codexAppConversationTabs");
  assert.ok(item);
  assert.deepEqual(item.surfaces, ["manager", "codex"]);
  assert.equal(item.group, "chat");
  assert.equal(item.restart, undefined);
  assert.match(appSource, /codexAppConversationTabs: boolean;/);
  assert.match(appSource, /codexAppConversationTabs: false,/);
});

function settingControls(node: ts.Node) {
  return elements(node).filter((element) => element.tagName.getText(app) === "EnhancementSettingControl");
}

test("unified enhancements use the master switch", () => {
  // 开关统一经 EnhancementSettingControl 渲染：受总开关控制的项在增强关闭时禁用。
  const control = component("EnhancementSettingControl");
  const disabled = descendants(control).find((node) => ts.isVariableDeclaration(node) && node.name.getText(app) === "disabled");
  assert.ok(disabled && ts.isVariableDeclaration(disabled));
  assert.equal(disabled.initializer?.getText(app), "isEnhancementItemMasterGated(item) && !masterEnabled");
  for (const element of elements(control).filter((candidate) => ["FeatureToggle", "AppSelect"].includes(candidate.tagName.getText(app)))) {
    assert.equal(attribute(element, "disabled"), "disabled");
  }
  // 开关卡在 EnhanceScreen（renderSetting），子选项在内置拓展卡片里，都按总开关状态禁用。
  for (const name of ["EnhanceScreen", "BuiltinExtensionCardView"]) {
    const placements = settingControls(component(name));
    assert.ok(placements.length > 0, `${name} renders catalog settings`);
    for (const placement of placements) assert.equal(attribute(placement, "masterEnabled"), "masterEnabled");
  }
  for (const item of enhancementCatalog.items) {
    const unmanaged = ["enhancementsEnabled", "providerSyncEnabled"].includes(item.key);
    assert.equal(item.masterGated !== false, !unmanaged, `${item.key} master gating`);
  }

  assert.ok(!enhancementCatalog.groups.some((group) => ["pet", "appearance", "standalone"].includes(group.id)));

});

test("enhancement switches come only from the settings catalog", () => {
  // 管理器里不能再写死一份开关文案：清单中的标题/说明不得以 t("字面量") 出现在增强页组件里。
  const catalogStrings = new Set(enhancementCatalogStrings());
  for (const name of ENHANCEMENT_COMPONENTS) {
    const node = component(name);
    assert.deepEqual(elements(node).filter((element) => element.tagName.getText(app) === "FeatureToggle"
      && /^t\("/.test(attribute(element, "title") ?? "")).map((element) => attribute(element, "title")), [], `${name} has a hard-coded switch`);
    const literals = descendants(node).filter(ts.isCallExpression)
      .filter((call) => call.expression.getText(app) === "t" && call.arguments[0] && ts.isStringLiteral(call.arguments[0]))
      .map((call) => (call.arguments[0] as ts.StringLiteral).text)
      .filter((text) => catalogStrings.has(text));
    assert.deepEqual(literals, [], `${name} duplicates catalog text`);
  }
  for (const item of enhancementCatalog.items) {
    assert.ok(!appSource.includes(`t("${item.description}")`), `${item.key} description is duplicated in App.tsx`);
  }
  assert.match(appSource, /<strong>\{t\(masterItem\.title\)\}<\/strong>/);
});

test("every manager-visible catalog item has exactly one place in the manager", () => {
  // 每个开关是一个内置拓展卡片，子选项挂在所属卡片下；总开关与会话修复开关各在原处。
  for (const platform of ["windows", "macos", "linux"] as const) {
    const cards = managerBuiltinGroups().flatMap((group) => managerBuiltinCards(group.id, platform));
    const placed = [
      ...cards.flatMap((card) => [...(card.item ? [card.item.key] : []), ...card.params.map((param) => param.key)]),
      "enhancementsEnabled",
    ];
    const expected = enhancementCatalog.items
      .filter((item) => item.surfaces.includes("manager") && (!item.platforms || item.platforms.includes(platform)))
      .map((item) => item.key);
    assert.deepEqual([...placed].sort(), [...expected].sort(), `manager switches on ${platform} must match the catalog`);
    assert.equal(new Set(placed).size, placed.length);
    // 清单顶层的内置拓展（桌宠等）也各有一张卡片。
    const ids = cards.map((card) => card.id);
    for (const entry of enhancementCatalog.builtins) assert.ok(ids.includes(entry.id), `${entry.id} has a card`);
    assert.equal(new Set(ids).size, ids.length);
  }
  // 分类标题移除，旧锚点保留；卡片继续来自平台过滤后的同一份清单。
  assert.deepEqual(managerBuiltinGroups().map(enhancementGroupAnchorId), ["enhance-group-plugins", "enhance-group-chat"]);
  const enhance = component("EnhanceScreen");
  assert.doesNotMatch(enhance.getText(app), /PageSectionNav|FeatureGroup/);
  assert.ok(elements(enhance).some((element) => attribute(element, "id") === "enhancementGroupAnchorId(group)"));
  assert.ok(descendants(enhance).some((node) => ts.isCallExpression(node)
    && node.expression.getText(app) === "managerBuiltinCards(group.id, enhancementPlatform).map"));
});

test("every catalog string the manager shows has an English translation", () => {
  const missing = enhancementCatalogStrings().filter((text) => !EN_PLAIN[text]);
  assert.deepEqual(missing, []);
});

test("enhancements share the form and save action", () => {
  const autosave = component("SettingsAutoSave");
  const calls = descendants(autosave).filter(ts.isCallExpression);
  assert.ok(
    calls.some((node) => node.expression.getText(app) === "useEnhanceAutoSave"
      && node.arguments.map((arg) => arg.getText(app)).join(", ") === "dirty, form, actions.autoSaveSettings"),
    "the shared header must save the form for both pages",
  );

  for (const name of ["GlobalSettingsScreen", "UpdateSettingsScreen"]) {
    const settings = component(name);
    assert.ok(!elements(settings).some((element) => ["DictationSettingsPanel", "StepwiseSettingsPanel"].includes(element.tagName.getText(app))));
    assert.ok(!descendants(settings).some((node) => ts.isPropertyAccessExpression(node)
      && (/^form\.dictation(?:\.|$)/.test(node.getText(app)) || /^form\.codexApp(?:Stepwise|AnswerOutline)/.test(node.getText(app)))));
  }
});

test("enhancement settings use the single persistent save status in the header", () => {
  const enhance = component("EnhanceScreen");
  // 增强正文不再持有保存控制器或提示，切页共用页头的同一份任务。
  assert.equal(elements(enhance).filter((element) => attribute(element, "onClick")?.includes("actions.saveSettings(")).length, 0);
  assert.doesNotMatch(enhance.getText(app), /AutoSaveStatus|useEnhanceAutoSave|SettingsAutoSave/);
  const autosave = component("SettingsAutoSave");
  const status = elements(autosave).filter((element) => element.tagName.getText(app) === "AutoSaveStatus");
  assert.equal(status.length, 1);
  assert.equal(attribute(status[0], "state"), "state");
  assert.equal(isConditional(status[0], autosave), false);
  const controllers = elements(component("App")).filter((element) => element.tagName.getText(app) === "SettingsAutoSave");
  assert.equal(controllers.length, 1);
  assert.equal(isConditional(controllers[0], component("App")), false);

  // 校验不过时不保存也不弹窗，交给页面显示；保存期间的改动保留草稿并同步版本号。
  const autoSave = appSource.slice(appSource.indexOf("const autoSaveSettings = async"), appSource.indexOf("const exportSettings"));
  assert.doesNotMatch(autoSave, /showNotice\(/);
  assert.match(autoSave, /backendSettingsEqual\(current, snapshot\) \? saved : \{ \.\.\.current, revision: saved\.revision \}/);
});

test("native Fast unlock is the only Fast enhancement toggle and keeps the provider support notice", () => {
  const nativeFast = enhancementItem("codexAppNativeFastUnlock");
  assert.equal(nativeFast.control, "bool");
  assert.equal(nativeFast.title, "原生 Fast 强制解锁");
  assert.notEqual(nativeFast.masterGated, false, "原生 Fast 受增强总开关控制");
  assert.match(nativeFast.description, /纯 API Key.*原生 Fast.*供应商决定/);
  assert.ok(managerBuiltinGroups().some((group) => group.id === nativeFast.group));
  assert.ok(nativeFast.surfaces.includes("manager") && nativeFast.surfaces.includes("codex"));
  assert.deepEqual(enhancementCatalog.items.filter((item) => /Fast/.test(item.title)).map((item) => item.key), ["codexAppNativeFastUnlock"]);
  assert.ok(!enhancementCatalog.items.some((item) => item.key === "codexAppServiceTierControls"));
  assert.match(appSource, /codexAppNativeFastUnlock: false,/);
});
