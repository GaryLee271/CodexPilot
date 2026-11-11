import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("微信连接与皮肤管理的导航、命令、注入和安装协议均已移除", () => {
  for (const path of [
    "./App.tsx", "./tray-panel-model.ts", "../web-preview/tauri-web-shim.ts",
    "../src-tauri/src/lib.rs", "../src-tauri/src/commands.rs",
    "../../../assets/inject/renderer-inject.js",
    "../../../crates/codex-plus-core/assets/enhancement-settings.json",
    "../../../crates/codex-plus-core/src/user_scripts.rs",
  ]) {
    // 允许源码中的回归断言提到退役功能，运行时代码不能再声明入口。
    const source = read(path).split("#[cfg(test)]")[0];
    assert.doesNotMatch(source, /dream.?skin|weixin/i, path);
  }
  for (const path of ["../src-tauri/Info.plist", "../../../scripts/installer/macos/package-dmg.sh",
    "../../../scripts/installer/linux/build-deb.sh", "../../../scripts/installer/windows/CodexPilot.nsi"]) {
    assert.doesNotMatch(read(path), /dreamskin/i, path);
  }
  const app = read("./App.tsx");
  assert.match(app, /setThemePreference/);
  assert.match(app, /跟随系统/);
  assert.match(app, /浅色/);
  assert.match(app, /深色/);
});


test("MCP 与 Skills 管理页面、命令和托管配置均已移除", () => {
  const app = read("./App.tsx");
  assert.doesNotMatch(app, /McpPage|SkillsPage|id: "(?:context|skills)"|route === "(?:context|skills)"|relayContextConfigContents|ContextEntries/);
  const managementCommands = /refresh_skill_catalog|list_installed_skills|import_(?:ccs|local)_skills|(?:install|update|uninstall)_skill|set_skill_enabled|(?:restore|delete)_skill_backup|(?:upsert|inspect|delete)_skill_repo|(?:list|read_live|sync_live)_context_entries|(?:upsert|delete)_context_entry|(?:parse|build)_mcp_entry|inspect_mcp_startup|(?:preview|import)_mcp_servers_json/;
  for (const path of ["../src-tauri/src/lib.rs", "../src-tauri/src/commands.rs", "../web-preview/tauri-web-shim.ts"]) {
    assert.doesNotMatch(read(path).split("#[cfg(test)]")[0], managementCommands, path);
  }
  const settings = read("../../../crates/codex-plus-core/src/settings.rs").split("#[cfg(test)]")[0];
  assert.doesNotMatch(settings, /relay(?:Context|Common)ConfigContents|relay_(?:context|common)_config_contents/);
  assert.doesNotMatch(read("../../../crates/codex-plus-core/src/lib.rs"), /pub mod skills;/);
});

test("插件市场页面、安装命令、桥接路由和原生市场接管均已移除", () => {
  for (const path of ["./App.tsx", "./enhancement-navigation.ts", "../web-preview/tauri-web-shim.ts",
    "../src-tauri/src/lib.rs", "../src-tauri/src/commands.rs",
    "../../../crates/codex-plus-core/src/lib.rs", "../../../crates/codex-plus-core/src/routes.rs",
    "../../../crates/codex-plus-core/src/settings.rs",
    "../../../crates/codex-plus-core/assets/enhancement-settings.json"]) {
    assert.doesNotMatch(read(path).split("#[cfg(test)]")[0], /PluginMarket|pluginMarket|plugin_market|plugin-market\//, path);
  }
  const renderer = read("../../../assets/inject/renderer-inject.js");
  assert.doesNotMatch(renderer, /PluginMarketplace|pluginMarketplace|plugin-market-unlock|codexPlusPluginNativeIntercept|\/plugin-market\//);
  const manifest = JSON.parse(read("../../../assets/inject/renderer-inject/manifest.json"));
  assert.ok(manifest.fragments.some((entry: { name: string }) => entry.name === "60-session-runtime.js"));
  assert.ok(!manifest.fragments.some((entry: { name: string }) => /plugin-market/.test(entry.name)));
  for (const name of ["sessionRows", "sendCodexPlusDiagnostic", "patchAppServerModelRequestClient"]) {
    assert.match(renderer, new RegExp(`function ${name}\\(`), name);
  }
});
