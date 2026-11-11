import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("管理器不再显示随附功能，也不再注册其配置面板命令", () => {
  const app = read("./App.tsx");
  assert.doesNotMatch(app, /BuiltinPackageRow|builtinPackages|Codex Pilot 随附|ExtensionManagerPanel|ExtensionConfigForm|WhaleBalanceSettings/);
  const lib = read("../src-tauri/src/lib.rs");
  assert.doesNotMatch(lib, /commands::(?:extension_manager_page|extension_manager_asset|extension_page_call|extension_manager_backend_call|set_extension_config|update_extension_config_live),/);
});

test("随附功能的后端模块、素材和专用路由不进入生产入口", () => {
  const core = read("../../../crates/codex-plus-core/src/lib.rs");
  const data = read("../../../crates/codex-plus-data/src/lib.rs");
  const assets = read("../../../crates/codex-plus-core/src/assets.rs");
  const api = read("../../../assets/inject/renderer-inject/91-extension-api.js");
  assert.doesNotMatch(core, /pub mod (?:agent_pet|bundled_extensions|whale|whale_full);/);
  assert.doesNotMatch(data, /pub mod whale_(?:history|usage);/);
  assert.doesNotMatch(assets, /include_(?:str|bytes)!\([^)]*(?:agent-pet|whale|image-overlay|typing-effects|usage-statusline|request-status)/);
  assert.doesNotMatch(api, /"\/(?:agent-pet|whale|image-overlay)\//);
});

test("原生桌宠鼠标跟随和活动条布局已从内置增强清单退役", () => {
  const catalog = JSON.parse(read("../../../crates/codex-plus-core/assets/enhancement-settings.json"));
  const keys = catalog.items.map((item: { key: string }) => item.key);
  assert.ok(!keys.includes("codexAppPetRealMouseLook"));
  assert.ok(!keys.includes("codexAppActivityOverlayRight"));
  const app = read("./App.tsx");
  assert.match(app, /function BuiltinExtensionCardView\(/);
  assert.match(app, /setBuiltinExtensionEnabled\(`builtin:\$\{card\.id\}`/);
});
