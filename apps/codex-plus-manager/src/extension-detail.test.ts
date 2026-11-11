import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const renderer = readFileSync(new URL("../../../assets/inject/renderer-inject.js", import.meta.url), "utf8");
const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const manifest = JSON.parse(readFileSync(new URL("../../../assets/inject/renderer-inject/manifest.json", import.meta.url), "utf8"));

test("用户拓展和随附功能已移除，内置拓展开关保留", () => {
  const fragmentNames = manifest.fragments.map((fragment: { name: string }) => fragment.name);
  assert.ok(!fragmentNames.includes("41-extension-detail.js"));
  assert.doesNotMatch(renderer, /data-codex-extensions-search|data-codex-extensions-select|data-codex-market-install/);
  assert.doesNotMatch(renderer, /function loadScriptMarket\(|postJson\("\/script-market\/(?:list|install)"/);
  assert.match(renderer, /function loadCodexPlusBuiltinInventory\(/);
  assert.match(renderer, /data-codex-builtin-extension/);
  assert.match(renderer, /function setCodexPlusBuiltinExtensionEnabled\(/);
  assert.match(app, /function BuiltinExtensionCardView\(/);
  assert.doesNotMatch(app, /function BuiltinPackageRow\(|Codex Pilot 随附|ExtensionConfigForm|ExtensionManagerPanel/);
});

test("内置拓展开关仍读取运行状态、保存启停并同步当前页面的功能", async () => {
  const source = readFileSync(new URL("../../../assets/inject/renderer-inject/40-backend-settings.js", import.meta.url), "utf8");
  const inventory = source.match(/^  async function loadCodexPlusBuiltinInventory\([^]*?^  \}/m)?.[0];
  const toggle = source.match(/^  async function setCodexPlusBuiltinExtensionEnabled\([^]*?^  \}/m)?.[0];
  assert.ok(inventory && toggle);
  const requests: Array<[string, unknown]> = [];
  let synced = 0;
  let settingsLoaded = 0;
  const window: Record<string, unknown> = {
    __codexPlusUserScripts: { scripts: { "bundled:agent-pet": { status: "loaded" } } },
    __codexPlusSyncBuiltinExtensions: () => { synced++; },
  };
  const runtime = new Function("window", "postJson", "loadBackendSettings", `
    let codexPlusBuiltinInventory = { builtins: [], scripts: [] };
    let codexPlusBuiltinInventoryLoaded = false;
    let refreshed = 0;
    function syncCodexPlusBuiltinExtensionToggles() { refreshed++; }
    ${inventory}
    ${toggle}
    return { load: loadCodexPlusBuiltinInventory, toggle: setCodexPlusBuiltinExtensionEnabled,
      loaded: () => codexPlusBuiltinInventoryLoaded, refreshed: () => refreshed };
  `)(window, async (path: string, payload: unknown) => {
    requests.push([path, payload]);
    return { builtins: [{ id: "paste-fix", enabled: path === "/user-scripts/list" }], scripts: [] };
  }, async () => { settingsLoaded++; });
  await runtime.load();
  assert.equal(runtime.loaded(), true);
  assert.deepEqual(requests[0], ["/user-scripts/list", { runtime_status: { "bundled:agent-pet": { status: "loaded" } } }]);
  await runtime.toggle("paste-fix", false);
  assert.deepEqual(requests[1], ["/user-scripts/set-script-enabled", { key: "builtin:paste-fix", enabled: false }]);
  assert.deepEqual(window.__codexPlusBuiltinExtensionState, { disabled: ["paste-fix"], replacedBy: {} });
  assert.equal(synced, 1);
  assert.equal(settingsLoaded, 1);
  assert.equal(runtime.refreshed(), 3);
});
