import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { enhancementCatalog, enhancementCatalogStrings, enhancementItem } from "./enhancement-catalog.ts";
import { EN_PLAIN } from "./i18n-en.ts";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const app = read("./App.tsx");
const renderer = read("../../../assets/inject/renderer-inject/40-backend-settings.js");
const item = enhancementItem("codexAppNativePredictionsModel");
const key = item.key;
const extract = (source: string, name: string) => {
  const body = source.match(new RegExp(`^  function ${name}\\([^]*?^  \\}`, "m"))?.[0];
  assert.ok(body, name);
  return body;
};

test("prediction model is an optional translated child setting on both surfaces", () => {
  assert.equal(item.parent, "native-predictions");
  assert.equal(item.control, "model");
  assert.equal(item.title, "预测输入模型");
  assert.equal(item.placeholder, "跟随当前对话");
  assert.deepEqual(item.surfaces, ["manager", "codex"]);
  for (const phrase of ["留空跟随当前对话", "仅覆盖输入预测", "原供应商", "不改变主对话"]) {
    assert.ok(item.description.includes(phrase), phrase);
  }
  for (const text of [item.title, item.description, item.placeholder!]) {
    assert.ok(enhancementCatalogStrings().includes(text));
    assert.ok(EN_PLAIN[text], text);
  }
  assert.match(app, /codexAppNativePredictionsModel: string;/);
  assert.match(app, /codexAppNativePredictionsModel: "",/);
  assert.match(read("../web-preview/tauri-web-shim.ts"), /codexAppNativePredictionsModel: "",/);
});

type Node = { type: string; props: Record<string, any>; children: Node[] };
function nodes(node: Node): Node[] {
  return [node, ...node.children.flat(Infinity).filter((child): child is Node => !!child && typeof child === "object" && "type" in child).flatMap(nodes)];
}

function manager() {
  const source = ts.createSourceFile("App.tsx", app, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = (name: string) => {
    const node = source.statements.find((entry) => ts.isFunctionDeclaration(entry) && entry.name?.text === name);
    assert.ok(node, name);
    return node.getText(source);
  };
  const code = ts.transpileModule(declaration("EnhancementSettingControl"), {
    compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const context = vm.createContext({
    React: { createElement: (type: string, props: object, ...children: Node[]) => ({ type, props, children }) },
    Input: "Input",
    isEnhancementItemMasterGated: (entry: typeof item) => entry.masterGated !== false,
    t: (value: string) => `translated:${value}`,
  });
  vm.runInContext(code, context);
  const form = {
    enhancementsEnabled: true, codexAppNativePredictions: true, [key]: "custom/private-model",
    activeRelayId: "active",
    relayProfiles: [
      { id: "other", model: "wrong-provider", modelList: "wrong-model" },
      { id: "active", model: "main[1M]", modelList: "main[256K]\r\nfast[128k],vendor[preview]\ninvalid[0]" },
    ],
  };
  let saved: typeof form | undefined;
  const render = () => context.EnhancementSettingControl({
    item, form, masterEnabled: form.enhancementsEnabled, onFormChange: (value: typeof form) => { saved = value; },
  }) as Node;
  return { form, render, saved: () => saved };
}

test("manager model input allows custom text and follows both switches", () => {
  const fixture = manager();
  let tree = nodes(fixture.render());
  let input = tree.find((entry) => entry.type === "Input")!;
  const list = tree.find((entry) => entry.type === "datalist")!;
  assert.equal(input.props.value, "custom/private-model");
  assert.equal(input.props.list, list.props.id);
  assert.equal(input.props["aria-label"], `translated:${item.title}`);
  assert.equal(input.props.placeholder, `translated:${item.placeholder}`);
  assert.deepEqual(tree.filter((entry) => entry.type === "option").map((entry) => entry.props.value), []);
  input.props.onChange({ currentTarget: { value: "my/unlisted-model" } });
  assert.equal(fixture.saved()?.[key], "my/unlisted-model");
  input.props.onChange({ currentTarget: { value: "" } });
  assert.equal(fixture.saved()?.[key], "");
  for (const [master, predictions] of [[true, true], [false, true], [true, false]]) {
    fixture.form.enhancementsEnabled = master;
    fixture.form.codexAppNativePredictions = predictions;
    tree = nodes(fixture.render());
    input = tree.find((entry) => entry.type === "Input")!;
    assert.equal(input.props.disabled, !master || !predictions);
  }
});

function injected() {
  const settings: Record<string, any> = {
    enhancementsEnabled: true, codexAppNativePredictions: true, [key]: "saved/custom-model",
    activeRelayId: "active", activeRelayProfilePublic: { model: "main[1M]" },
    relayProfiles: [
      { id: "other", model: "wrong-provider", modelList: "wrong-model" },
      { id: "active", model: "main[1M]", modelList: "main[256K],fast[128k]\nquoted\"model\nvendor[preview]\ninvalid[0]" },
    ],
  };
  class Input {
    value = "initial";
    disabled = false;
    list = { innerHTML: "" };
    getAttribute = () => key;
    closest = (selector: string) => selector === "input[data-codex-backend-model-setting]" ? this : null;
  }
  const input = new Input();
  const document = {
    activeElement: null as Input | null,
    querySelectorAll: (selector: string) => selector === "input[data-codex-backend-model-setting]" ? [input] : [],
  };
  const saved: Array<[string, string]> = [];
  const context = vm.createContext({
    codexPlusBackendSettings: settings, codexPlusSettingsCatalog: enhancementCatalog, document,
    Element: Input,
    escapeHtml: (value: string) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!),
    codexPlusSettingsCatalogDescription: (entry: typeof item) => entry.description,
    renderCodexPlusSettingsCatalogTitle: (entry: typeof item) => entry.title,
    syncCodexPlusSettingsCatalogDescriptions: () => {},
    setBackendSetting: (field: string, value: string) => { saved.push([field, value]); },
  });
  vm.runInContext([
    "codexPlusSettingsModelNames", "codexPlusSettingsModelDisabled", "renderCodexPlusSettingsModelOptions",
    "syncCodexPlusSettingsModelInputs", "renderCodexPlusSettingsCatalogRow", "syncCodexPlusBackendToggleButtons",
  ].map((name) => extract(renderer, name)).join("\n"), context);
  const change = renderer.match(/overlay\.addEventListener\("change", \(event\) => \{([^]*?)\n    \}, true\);/)?.[1];
  assert.ok(change);
  vm.runInContext(`function changeModel(event) {${change}\n}`, context);
  return { context, settings, document, input, saved };
}

test("injected model suggestions prefer the catalog and fall back to the active provider safely", () => {
  const { context } = injected();
  assert.deepEqual(Array.from(context.codexPlusSettingsModelNames()), ["main", "fast", 'quoted"model', "vendor[preview]", "invalid[0]"]);
  context.codexPlusModelNames = () => ["catalog[1M]", "catalog[256K]", "catalog-fast[64K]"];
  assert.deepEqual(Array.from(context.codexPlusSettingsModelNames()), ["catalog", "catalog-fast"]);
  context.codexPlusModelNames = () => [];
  const html = context.renderCodexPlusSettingsCatalogRow(item, { param: true });
  assert.match(html, /<input type="text"/);
  assert.match(html, /aria-label="预测输入模型"/);
  assert.match(html, /placeholder="跟随当前对话"/);
  assert.match(html, /value="saved\/custom-model"/);
  assert.match(html, /<datalist id="codex-plus-setting-models-codexAppNativePredictionsModel"/);
  assert.match(html, /value="quoted&quot;model"/);
  assert.doesNotMatch(html, /wrong-model|wrong-provider| disabled/);
});

test("injected heartbeat preserves focused drafts, updates saved models and enforces both switches", () => {
  const { context, settings, document, input } = injected();
  context.syncCodexPlusBackendToggleButtons();
  assert.equal(input.value, "saved/custom-model");
  assert.match(input.list.innerHTML, /value="fast"/);
  document.activeElement = input;
  input.value = "editing/custom-model";
  settings[key] = "changed-in-manager";
  context.syncCodexPlusBackendToggleButtons();
  assert.equal(input.value, "editing/custom-model");
  document.activeElement = null;
  context.syncCodexPlusBackendToggleButtons();
  assert.equal(input.value, "changed-in-manager");
  for (const [master, predictions] of [[true, true], [false, true], [true, false]]) {
    settings.enhancementsEnabled = master;
    settings.codexAppNativePredictions = predictions;
    context.syncCodexPlusBackendToggleButtons();
    assert.equal(input.disabled, !master || !predictions);
    assert.equal(context.renderCodexPlusSettingsCatalogRow(item).includes(" disabled"), !master || !predictions);
  }
  settings.codexAppNativePredictions = true;
  settings[key] = "";
  context.syncCodexPlusBackendToggleButtons();
  assert.equal(input.value, "");
});

test("injected change persists custom and empty model strings through setBackendSetting", () => {
  const { context, input, saved } = injected();
  input.value = "my/custom-model";
  context.changeModel({ target: input });
  input.value = "";
  context.changeModel({ target: input });
  input.disabled = true;
  input.value = "should-not-save";
  context.changeModel({ target: input });
  assert.deepEqual(saved, [[key, "my/custom-model"], [key, ""]]);
});
