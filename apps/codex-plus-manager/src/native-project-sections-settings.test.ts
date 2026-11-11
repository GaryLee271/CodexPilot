import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import { EN_PLAIN } from "./i18n-en.ts";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const key = "codexAppNativeProjectSections";

test("项目分区为默认关闭的独立开关，两侧设置页说明本地存储和重启要求", () => {
  const catalog = JSON.parse(read("../../../crates/codex-plus-core/assets/enhancement-settings.json"));
  const item = catalog.items.find((entry: { key: string }) => entry.key === key);
  assert.equal(item.builtin, "native-project-sections");
  assert.equal(item.group, "chat");
  assert.deepEqual(item.surfaces, ["manager", "codex"]);
  assert.equal(item.restart, true);
  for (const phrase of ["默认关闭", "API Key", "本机", "独立", "不关联账号或同步数据", "关闭后保留"]) assert.ok(item.description.includes(phrase));
  assert.ok(EN_PLAIN[item.title]);
  assert.ok(EN_PLAIN[item.description]);
  assert.match(read("./App.tsx"), /codexAppNativeProjectSections: boolean;/);
  assert.match(read("./App.tsx"), /codexAppNativeProjectSections: false,/);
  assert.match(read("../web-preview/tauri-web-shim.ts"), /codexAppNativeProjectSections: false,/);
});

test("设置加载和保存只发布本地分区策略，丢弃旧账号关联数据", async () => {
  const publications: Record<string, unknown>[] = [];
  let response = { enhancementsEnabled: true, [key]: true, nativeProjectSectionsLocalApiConfigured: true, codexAppNativeProjectSectionsLinkAccount: true, nativeProjectSectionsLinkedAccountId: "account-a", relayProfiles: [{ secret: "fixture-private" }] };
  const extract = (file: string, name: string) => {
    const body = read(file).match(new RegExp(`^  async function ${name}\\([^]*?^  \\}`, "m"))?.[0];
    assert.ok(body);
    return body;
  };
  const context = vm.createContext({
    window: {
      __CODEX_PLUS_TEST_SERVICE_TIER__: true,
      __codexPlusNativeProjectSections: { runtime: { update: (value: Record<string, unknown>) => publications.push({ ...value }) } },
    },
    codexPlusBackendSettings: {}, codexPlusBackendSettingsSeq: 0, codexPlusBackendSettingsLoaded: false,
    postJson: async () => response, refreshCodexPlusBackendToggles: () => {},
  });
  vm.runInContext([
    extract("../../../assets/inject/renderer-inject/30-backend-settings-state.js", "loadBackendSettingsState"),
    extract("../../../assets/inject/renderer-inject/40-backend-settings.js", "setBackendSetting"),
  ].join("\n"), context);
  assert.equal(await context.loadBackendSettingsState(), true);
  response = { ...response, [key]: false };
  await context.setBackendSetting(key, false);
  assert.deepEqual(publications, [
    { enhancementsEnabled: true, [key]: true, nativeProjectSectionsLocalApiConfigured: true },
    { enhancementsEnabled: true, [key]: false, nativeProjectSectionsLocalApiConfigured: true },
  ]);
});

test("两侧项目分区只提供一个开关，不再读取或展示账号候选", () => {
  const catalog = JSON.parse(read("../../../crates/codex-plus-core/assets/enhancement-settings.json"));
  assert.deepEqual(catalog.items.filter((item: { group: string }) => item.group === "chat").map((item: { key: string }) => item.key), ["codexAppConversationTabs", "codexAppConversationList", key]);
  assert.equal(catalog.items.some((item: { parent?: string }) => item.parent === "native-project-sections"), false);
  assert.doesNotMatch(read("./App.tsx"), /LocalSectionAccount|codexAppNativeProjectSectionsLinkAccount|codexAppNativeProjectSectionsAccountId|native_project_sections_accounts/);
  assert.doesNotMatch(read("../../../assets/inject/renderer-inject/40-backend-settings.js"), /codexPlusSettingsAccount|data-codex-backend-account-setting|data-codex-plus-accounts-refresh/);
  assert.doesNotMatch(read("../src-tauri/src/commands.rs") + read("../src-tauri/src/lib.rs"), /native_project_sections_accounts/);
});
