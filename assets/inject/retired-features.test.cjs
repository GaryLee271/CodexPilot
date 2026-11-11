const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const vm = require("node:vm");
const source = readFileSync(`${__dirname}/renderer-inject.js`, "utf8");

test("retired project enhancements have no UI, dispatch or scanner entry", () => {
  assert.doesNotMatch(source, /data-codex-plus-setting="(?:zedRemoteOpen|upstreamWorktreeCreate)"/);
  assert.doesNotMatch(source, /data-codex-upstream-worktree-open/);
  assert.doesNotMatch(source, /(?:postJson|bridgeCall)\("\/(?:zed-remote|upstream-worktree)\//);
  assert.doesNotMatch(source, /function (?:installUpstream\w+|openUpstreamWorktreeDialog|refreshZedRemote\w+|scheduleZedRemote\w+)\(/);
  assert.doesNotMatch(source, /upstreamBranchDefaultsCache|codexUpstreamBranchSelection|codexUpstreamProjectContext/);

  // 已发布的类名只保留兼容声明，没有入口或事件处理。
  assert.match(source, /zedRemoteButtonClass = "codex-zed-remote-button"/);
  assert.match(source, /upstreamWorktreeDialogClass = "codex-upstream-worktree-dialog"/);
  assert.doesNotMatch(source, /function installCodexRemoteSessionRecoveryListener\(/);
  assert.match(source, /sessionShareButtonClass = "codex-session-share-button"/);
  // 会话分享（按钮、导入监听、开关）已整体下线。
  assert.doesNotMatch(source, /function (?:installSessionShareButton|createSessionShare|installSessionShareImportListener)\(/);
  // 会话行「…」菜单里的原地复制 / 自动重命名已整体下线，函数与入口都不该回来。
  assert.doesNotMatch(source, /function (?:activateSessionCopyMenuItem|activateSessionAutoRenameMenuItem)\(/);
});

test("old backend switches cannot enable retired features", () => {
  const style = readFileSync(`${__dirname}/renderer-inject/10-style.js`, "utf8");
  const begin = style.indexOf("  function defaultCodexPlusSettings()");
  const end = style.indexOf("  function setCodexPlusSetting(", begin);
  assert.ok(begin >= 0 && end > begin);
  const context = vm.createContext({
    window: {}, localStorage: { getItem: () => JSON.stringify({ petRealMouseLook: true, activityOverlayRight: true, sessionDelete: true, sessionDeleteSkipConfirm: true, sideChatSave: true, turnRewind: true, markdownExport: true, pasteFix: true, threadIdBadge: true, threadScrollRestore: true, conversationView: true, conversationViewMaxWidth: 1200, answerOutline: true, capacityAutoRetry: true, capacityAutoRetryMaxAttempts: 200, capacityAutoRetryIntervalSeconds: 1 }) },
    conversationViewDefaultWidth: 900, codexPlusSettingsKey: "fixture",
    codexPlusBackendSettings: {
      enhancementsEnabled: true,
      codexAppZedRemoteOpen: true, codexAppUpstreamWorktreeCreate: true,
      codexAppNativeMenuTranslation: true, codexAppSessionShare: true,
      codexAppPluginMarketplaceUnlock: true,
      codexAppNativeMenuPlacement: false, codexAppStepwiseEnabled: true,
      codexAppAnswerOutlineEnabled: true, dictation: { enabled: true },
    },
  });
  vm.runInContext(`${style.slice(begin, end)}\nglobalThis.result = codexPlusSettings();`, context);
  for (const key of ["zedRemoteOpen", "upstreamWorktreeCreate", "nativeMenuTranslation", "sessionShare", "pluginMarketplaceUnlock", "stepwise", "dictation", "sessionDelete", "sessionDeleteSkipConfirm", "sideChatSave", "turnRewind", "markdownExport", "pasteFix", "threadIdBadge", "threadScrollRestore", "conversationView", "conversationViewMaxWidth", "capacityAutoRetry", "capacityAutoRetryMaxAttempts", "capacityAutoRetryIntervalSeconds", "petRealMouseLook", "activityOverlayRight"]) {
    assert.equal(Object.hasOwn(context.result, key), false, key);
  }
  assert.equal(context.result.nativeMenuPlacement, false, "menu placement keeps its independent mapping");
  assert.equal(Object.hasOwn(context.result, "answerOutline"), false);
});

test("retired fast startup flags cannot change native fetch or Statsig initialization", () => {
  const prelude = readFileSync(`${__dirname}/renderer-inject/00-prelude.js`, "utf8");
  const end = prelude.indexOf("  const buttonClass =");
  assert.ok(end > 0);
  const fetch = async () => "native response";
  const initializeAsync = async () => "native initialization";
  const unexpectedCalls = [];
  const client = {
    initializeAsync,
    loadingStatus: "Loading",
    $emt: (...args) => unexpectedCalls.push(args),
  };
  const window = {
    __CODEX_PLUS_FAST_STARTUP__: { enabled: true, statsigTimeoutMs: 100 },
    __STATSIG__: { firstInstance: client },
    fetch,
    setTimeout: (...args) => unexpectedCalls.push(args),
    setInterval: (...args) => unexpectedCalls.push(args),
  };
  vm.runInNewContext(`${prelude.slice(0, end)}\n})();`, {
    window,
    navigator: { userAgent: "test" },
    process: { versions: { node: "fixture" } },
  });
  assert.equal(window.fetch, fetch);
  assert.equal(client.initializeAsync, initializeAsync);
  assert.equal(client.loadingStatus, "Loading");
  assert.deepEqual(unexpectedCalls, []);
  assert.doesNotMatch(source, /installCodexPlusFastStartup|__CODEX_PLUS_FAST_STARTUP__|__codexPlusFastStartup|statsigTimeoutMs/);
  // 模型列表交回原生处理，不再借 Statsig 动态配置追加或过滤模型。
  assert.doesNotMatch(source, /function patchStatsigModelDynamicConfig\(/);
  assert.doesNotMatch(source, /function patchStatsigModelWhitelist\(/);
});

test("chat catalog exposes tabs and API sections without restoring retired conversation tools", () => {
  const catalog = JSON.parse(readFileSync(`${__dirname}/../../crates/codex-plus-core/assets/enhancement-settings.json`, "utf8"));
  assert.deepEqual(catalog.items.filter((item) => item.group === "chat").map((item) => item.key), [
    "codexAppConversationTabs",
    "codexAppConversationList",
    "codexAppNativeProjectSections",
  ]);
  assert.equal(catalog.builtins.some((item) => item.group === "chat"), false);
  assert.doesNotMatch(source, /ambient-suggestions-enabled|data-codex-app-ambient-suggestions/);
  assert.doesNotMatch(source, /function (?:openDeleteConfirmForRow|exportMarkdown|installCodexPlusForceChineseLocale|syncCodexPlusTurnRewind|syncCodexPlusCapacityAutoRetry|refreshConversationView|refreshThreadIdBadges|installThreadScrollRouteHooks|codexPlusSessionTitleExtension)\(/);
});

test("retired pet, appearance and standalone categories have no configurable runtime", () => {
  const catalog = JSON.parse(readFileSync(`${__dirname}/../../crates/codex-plus-core/assets/enhancement-settings.json`, "utf8"));
  assert.deepEqual(catalog.groups.map((group) => group.id), ["core", "plugins", "chat"]);
  assert.deepEqual(catalog.builtins, []);
  assert.doesNotMatch(source, /function (?:codexPlusInstanceIdentityExtension|codexPlusActivityOverlayExtension|syncOfficialUsagePolicy|rewriteOfficialUsageStatus|startOfficialUsageWindowBlock)\(/);
  assert.doesNotMatch(source, /codexAppPetRealMouseLook|codexAppActivityOverlayRight|codexAppStandaloneQuotaUnlock/);
});
