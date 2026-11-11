use codex_plus_core::assets;
use codex_plus_core::bridge::{self, BRIDGE_BINDING_NAME};
use codex_plus_core::cdp::{
    CdpTarget, is_avatar_overlay_page_target, is_primary_codex_page_target,
    is_quick_chat_page_target, list_targets, pick_injectable_codex_page_target, pick_page_target,
    validate_cdp_websocket_url,
};

use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use std::future::Future;
use std::io::Write;
use std::net::SocketAddr;
use std::pin::Pin;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Notify, oneshot};
use tokio_tungstenite::accept_async;
use tokio_tungstenite::tungstenite::Message;

fn target(id: &str, kind: &str, title: &str, url: &str, websocket_url: Option<&str>) -> CdpTarget {
    CdpTarget {
        id: id.to_string(),
        target_type: kind.to_string(),
        title: title.to_string(),
        url: url.to_string(),
        web_socket_debugger_url: websocket_url.map(str::to_string),
    }
}

#[test]
fn bridge_script_defines_expected_globals_and_binding() {
    let script = bridge::build_bridge_script(BRIDGE_BINDING_NAME);

    assert!(script.contains("window.__codexSessionDeleteBridge"));
    assert!(script.contains("window.__codexSessionDeleteResolve"));
    assert!(script.contains("window.__codexSessionDeleteReject"));
    assert!(script.contains("codexSessionDeleteV2"));
    assert!(script.contains("previousCallbacks"));
    assert!(script.contains("桥接已重新连接"));
    assert!(script.contains("Number.isFinite(window.__codexSessionDeleteSeq)"));
}

#[test]
fn screenshot_command_uses_png_from_surface() {
    assert_eq!(
        bridge::capture_screenshot_params(),
        json!({
            "format": "png",
            "fromSurface": true,
            "captureBeyondViewport": false
        })
    );
}

#[test]
fn injection_script_uses_cdp_bridge_without_http_helper() {
    let script = assets::injection_script();

    assert!(script.contains("!window.electronBridge"));
    assert!(script.contains(r#"!/^app:\/\/\-\//i.test(window.location.href)"#));
    assert!(!script.contains("window.__CODEX_SESSION_DELETE_HELPER__"));
    assert!(!script.contains("http://127.0.0.1:57321"));
    assert!(!script.contains("window.__CODEX_PLUS_SPONSOR_IMAGES__"));
    assert!(script.contains("window.__CODEX_PLUS_VERSION__"));
    assert!(script.contains(codex_plus_core::version::VERSION));
    assert!(!script.contains("discord.gg"));
    assert!(!script.contains("t.me/"));
    assert!(!script.contains("data-codex-plus-discord"));
}

/// 原生导航延迟挂载时补画用户拓展，保留有界重试。
#[test]
fn injection_script_retries_extension_nav_after_startup() {
    let script = assets::injection_script();

    assert!(script.contains("scheduleExtensionNavStartupRetry"));
    let scan_at = script.find("\n  scan();").expect("startup scan call");
    let retry_at = script
        .find("\n  scheduleExtensionNavStartupRetry();")
        .expect("startup retry call");
    assert!(retry_at > scan_at);
    assert!(script.contains("clearInterval(window.__codexPlusSidebarNavRetryTimer)"));
    assert!(script.contains("attempts > 20"));
    assert!(!script.contains("function installCodexPlusSidebarNavigation("));
    assert!(!script.contains("function installCodexPlusRailNavigation("));
}

/// Codex 设置页的设置行按 /settings/catalog 清单生成：断言清单让该项在 Codex 显示，
/// 并且注入脚本能把清单 key 映射回本页的设置 key（生成 data-codex-plus-setting）。
fn assert_codex_setting_row(script: &str, backend_key: &str, local_key: &str) -> serde_json::Value {
    let catalog = codex_plus_core::settings_catalog::enhancement_settings_catalog().unwrap();
    let item = catalog["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["key"] == backend_key)
        .cloned()
        .unwrap_or_else(|| panic!("{backend_key} 不在设置项清单里"));
    assert!(
        item["surfaces"]
            .as_array()
            .unwrap()
            .iter()
            .any(|surface| surface == "codex"),
        "{backend_key} 应在 Codex 设置页显示"
    );
    assert!(script.contains(&format!("{local_key}: \"{backend_key}\"")));
    assert!(script.contains(r#"data-codex-plus-setting="${escapeHtml(localKey)}""#));
    assert!(script.contains(r#"postJson("/settings/catalog", {})"#));
    item
}

#[test]
fn injection_script_no_longer_carries_the_image_overlay() {
    let script = assets::injection_script();
    assert!(!script.contains("__CODEX_PLUS_IMAGE_OVERLAY__"));
    assert!(!script.contains("function installCodexPlusImageOverlay"));
}

#[test]
fn rejects_non_loopback_cdp_websocket() {
    let error =
        validate_cdp_websocket_url("ws://example.com:9222/devtools/page/1", 9222).unwrap_err();

    assert!(error.to_string().contains("loopback"));
}

#[test]
fn rejects_mismatched_cdp_websocket_port() {
    let error =
        validate_cdp_websocket_url("ws://127.0.0.1:9333/devtools/page/1", 9222).unwrap_err();

    assert!(error.to_string().contains("port"));
}

#[test]
fn validates_ipv4_and_ipv6_loopback_cdp_websockets() {
    validate_cdp_websocket_url("ws://127.0.0.1:9222/devtools/page/1", 9222).unwrap();
    validate_cdp_websocket_url("ws://[::1]:9222/devtools/page/1", 9222).unwrap();
}

#[test]
fn rejects_cdp_websocket_with_wrong_scheme_or_missing_port() {
    assert!(validate_cdp_websocket_url("http://127.0.0.1:9222/devtools/page/1", 9222).is_err());
    assert!(validate_cdp_websocket_url("ws://127.0.0.1/devtools/page/1", 9222).is_err());
}

#[test]
fn injection_script_marks_diagnostic_build_and_reports_script_loaded() {
    let script = assets::injection_script();

    assert!(script.contains("window.__CODEX_PLUS_BUILD__"));
    assert!(script.contains(codex_plus_core::assets::DIAGNOSTIC_BUILD_ID));
    assert!(script.contains("script_loaded"));
    assert!(script.contains("data-codex-plus-build"));
}

#[test]
fn injection_script_does_not_include_recommendations_or_ad_fetching() {
    let script = assets::injection_script();

    assert!(!script.contains("推荐内容"));
    assert!(!script.contains("fetchCodexPlusAds"));
    assert!(!script.contains("ads.codexpp.cc"));
    assert!(!script.contains("Ad-List"));
}

#[test]
fn injection_script_times_out_backend_bridge_calls_without_http_fallback() {
    let script = assets::injection_script();

    assert!(script.contains("await withBackendTimeout(request)"));
    assert!(!script.contains("fetchBackendStatusFromHelper"));
    assert!(script.contains("recordCodexPlusBridgeSuccess"));
    assert!(script.contains("lastSuccessAt"));
    assert!(script.contains("codexPlusBackendCheckInFlight"));
    assert!(script.contains("CODEX_PLUS_BACKEND_FAILURE_THRESHOLD = 3"));
    assert!(script.contains("codexPlusBackendGeneration !== window.__codexPlusBackendGeneration"));
    assert!(script.contains("__codexPlusBackendHeartbeatGeneration"));
    assert!(script.contains("clearInterval(window.__codexPlusBackendHeartbeat)"));
    assert!(!script.contains("await withBackendTimeout(postJson(\"/backend/status\", {}))"));
    assert!(script.contains("backend_bridge_timeout"));
    assert!(!script.contains("/backend/repair"));
    assert!(!script.contains("backend_status_bridge_failed_http_fallback_ok"));
    assert!(!script.contains("backend_status_bridge_and_http_failed"));
}

#[test]
fn injection_script_keeps_one_backend_heartbeat_per_generation() {
    let script = assets::injection_script();
    let start = script
        .find("function scheduleBackendHeartbeat()")
        .expect("backend heartbeat scheduler should exist");
    let end = script[start..]
        .find("\n  async function loadCodexPlusBuiltinInventory")
        .map(|offset| start + offset)
        .expect("backend heartbeat scheduler should have an end marker");
    let scheduler = &script[start..end];
    let scheduler_json = serde_json::to_string(scheduler).expect("scheduler should serialize");
    let harness = format!(
        r#"
const vm = require("node:vm");
const source = {scheduler};
const runCase = (generation, heartbeat, heartbeatGeneration, expected) => {{
  let timers = 0;
  let clears = 0;
  let checks = 0;
  const context = {{
    window: {{
      __codexPlusBackendGeneration: generation,
      __codexPlusBackendHeartbeat: heartbeat,
      __codexPlusBackendHeartbeatGeneration: heartbeatGeneration,
    }},
    codexPlusBackendGeneration: generation,
    setInterval: () => ++timers,
    clearInterval: () => ++clears,
    checkBackendStatus: () => ++checks,
  }};
  vm.runInNewContext(source + "\nthis.run = scheduleBackendHeartbeat;", context);
  context.run();
  context.run();
  const actual = {{ timers, clears, checks }};
  if (JSON.stringify(actual) !== JSON.stringify(expected)) process.exit(1);
}};
runCase(1, null, null, {{ timers: 1, clears: 0, checks: 1 }});
runCase(1, 99, 1, {{ timers: 0, clears: 0, checks: 0 }});
runCase(2, 99, 1, {{ timers: 1, clears: 1, checks: 1 }});
"#,
        scheduler = scheduler_json
    );
    let output = Command::new("node")
        .arg("-e")
        .arg(harness)
        .output()
        .expect("node should run heartbeat scheduler harness");
    assert!(
        output.status.success(),
        "heartbeat scheduler harness failed\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn injection_script_uses_one_enhancement_behavior() {
    let script = assets::injection_script();

    assert!(!script.contains("兼容增强"));
    assert!(!script.contains("完整增强"));
    assert!(!script.contains("data-relay-unneeded"));
    assert!(!script.contains("codexPlusBackendSettings.launchMode"));
}

#[test]
fn injection_script_defers_backend_mapped_toggles_until_settings_load() {
    let script = assets::injection_script();

    assert!(script.contains("const codexPlusBackendMappedSettings = new Set"));
    assert!(
        script
            .contains("codexPlusBackendMappedSettings.has(key) && !codexPlusBackendSettingsLoaded")
    );
    assert!(script.contains("button.dataset.pending = String(waitsForBackend)"));
    assert!(script.contains(
        "button.disabled = waitsForBackend || button.dataset.relayUnneeded === \"true\""
    ));
    assert!(script.contains("toggle.disabled || toggle.dataset.pending === \"true\""));
}

#[test]
fn injection_script_ignores_stale_backend_settings_responses() {
    let script = assets::injection_script();

    assert!(script.contains("let codexPlusBackendSettingsSeq = 0"));
    assert!(script.contains("const seq = codexPlusBackendSettingsSeq"));
    assert!(script.contains("if (seq !== codexPlusBackendSettingsSeq)"));
    assert!(script.contains("const seq = ++codexPlusBackendSettingsSeq"));
    assert!(script.contains("if (seq === codexPlusBackendSettingsSeq)"));
}

#[test]
fn injection_script_omits_force_install_unlock_loop() {
    let script = assets::injection_script();

    assert!(!script.contains("codex-force-install-unlocked"));
    assert!(!script.contains("codexForcePluginInstallRefreshIntervalMs"));
    assert!(!script.contains("refreshForcePluginInstallUnlockLoop"));
    assert!(!script.contains("__codexForcePluginInstallRefreshTimer"));
}

#[test]
fn injection_script_loads_backend_settings_before_initial_scan() {
    let script = assets::injection_script();
    let startup_call = script
        .rfind("void loadBackendSettingsForStartup();")
        .expect("script should load backend settings on startup");
    let footer = &script[startup_call..];
    let initial_scan = footer
        .find("scan();")
        .expect("script should perform an initial scan");
    let footer_marker = footer
        .find("window.removeEventListener(\"resize\"")
        .expect("script should continue bootstrapping after the initial scan");

    assert!(initial_scan < footer_marker);
    assert!(script.contains("if (attempt < 60)"));
}

#[test]
fn injection_script_heartbeat_syncs_backend_settings() {
    let script = assets::injection_script();

    // 心跳在健康时顺带刷新后端设置，让 manager 侧的改动能传播到已运行窗口（issue #2221）。
    assert!(script.contains("function syncBackendSettingsFromHeartbeat"));
    assert!(script.contains("syncBackendSettingsInFlight"));
    assert!(script.contains("void syncBackendSettingsFromHeartbeat();"));
    // 跟着设置走的功能由内置拓展订阅 settings/loaded（由保留的拓展自行订阅设置事件）。
    // 心跳还带上变了的设置字段名，并比较供应商发 relayProfile/switched、modelCatalog/changed。
    assert!(script.contains("emitCodexPlusSettingsLoaded(\"heartbeat\", "));
    assert!(script.contains("emitCodexPlusRelaySettingsEvents(previous, next)"));
    assert!(!script.contains("function codexPlusActivityOverlayExtension"));
}

#[test]
fn usage_status_line_and_proxy_request_status_left_the_injection_script() {
    let script = assets::injection_script();

    // 两者已改成官方拓展包（assets/extensions/usage-statusline、proxy-request-status），见 bundled_builtins.rs；
    // 注入脚本里不再有它们的代码、设置开关和内置拓展项，也不再自己轮询 /thread-usage-live、/proxy-status。
    for gone in [
        "codexPlusUsageState",
        "codexPlusProxyStatusState",
        "usageStatusLine:",
        "proxyRequestStatus:",
        "__CODEX_PLUS_USAGE_STATUSLINE_SYNC__",
        "postJson(\"/thread-usage-live\"",
        "postJson(\"/proxy-status\"",
        "id: \"usage-statusline\"",
        "id: \"proxy-request-status\"",
    ] {
        assert!(!script.contains(gone), "注入脚本里还有 {gone}");
    }
}

#[test]
fn injection_script_recovers_a_stalled_codex_boot_shell() {
    let script = assets::injection_script();

    // 空壳判定依据：有 #root、长不出 <main>、且里头一个字都没有。
    assert!(script.contains("function bootShellRecoveryStuck"));
    assert!(script.contains("function bootShellRecoverySettled"));
    assert!(script.contains("document.querySelector(\"main\")"));
    assert!(script.contains("root.innerText.trim() === \"\""));

    // 只刷主页面：活动悬浮层 / quick-chat 带 initialRoute，本来就没有 <main>。
    assert!(script.contains("function bootShellRecoveryAppliesHere"));
    assert!(script.contains("/[?&]initialRoute=/"));
    // 宽限要足够长，才能把「启动慢」和「真卡死」分开。
    assert!(script.contains("bootShellRecoveryGraceMs = 20000"));
    // 限次靠 sessionStorage + 冷却：写不进去就宁可不刷，避免刷新循环。
    assert!(script.contains("bootShellRecoveryCooldownMs = 60000"));
    assert!(script.contains("window.sessionStorage.getItem(bootShellRecoveryStorageKey)"));
    assert!(script.contains("window.sessionStorage.setItem(bootShellRecoveryStorageKey"));
    // 触发过要能从 codex-plus.log 复盘。
    assert!(script.contains("boot_shell_recovery_reload"));
    assert!(script.contains("window.location.reload();"));
    // 模块末尾必须真的装上，否则整段是死代码。
    assert!(script.contains("installBootShellRecovery();"));
}

#[test]
fn injection_script_keeps_session_action_buttons_in_pr_style() {
    let script = assets::injection_script();

    assert!(script.contains("actionButtonClass = \"codex-session-action-button\""));
    // 优先套用同一行原生置顶 / 归档按钮的类名与 data-* 属性；兜底样式只在没套上时生效，
    // 悬停只提亮文字色、不铺底色，也不再从原生静止态抄颜色变量。
    assert!(script.contains("function syncNativeSessionActionStyle(row)"));
    assert!(script.contains(".${actionButtonClass}:not([data-codex-native-style]) {"));
    assert!(script.contains("background: transparent;"));
    assert!(script.contains("var(--color-text-secondary-ghost-hover,"));
    assert!(!script.contains("--codex-session-action-hover-background"));
    assert!(script.contains("cursor: default;"));
}

#[test]
fn injection_script_reads_catalog_without_model_unlock_or_grouping() {
    let script = assets::injection_script();
    assert!(script.contains("/codex-model-catalog"));
    assert!(script.contains("function loadCodexModelCatalog("));
    assert!(script.contains("function ensureCodexAppServerClient("));
    assert!(script.contains("codexAppServerModelRequestPatchVersion = \"30\""));
    for retired in [
        "function patchModelArray(",
        "function patchStatsigModelDynamicConfig(",
        "function patchStatsigModelWhitelist(",
        "function patchModelJsonResponse(",
        "function scheduleCodexModelWhitelistRefresh(",
        "function codexPlusModelPickerGroupsExtension(",
        "data-codex-plus-model-groups",
    ] {
        assert!(
            !script.contains(retired),
            "retired model behavior: {retired}"
        );
    }
}

#[test]
fn app_server_client_preserves_native_models_and_turn_requests() {
    let temp = tempfile::tempdir().unwrap();
    let harness_path = temp.path().join("native-models.cjs");
    // 执行真实客户端补丁，覆盖实例和原型两条采集路径；旧设置不得恢复模型改写。
    std::fs::write(&harness_path, r#"
const assert = require("node:assert/strict");
const fs = require("node:fs");
const source = fs.readFileSync(process.argv[2], "utf8");
const execute = new Function("window", "registerNativeHostClient", "codexAppServerModelRequestPatchVersion",
  "codexPlusExtensionInterceptors", "codexPlusRunWaterfall", "codexSettingStorageFromModule",
  "codexStateApiFromModule", "codexServiceTierDispatcherFromModule", "codexPlusSettings", "sendCodexPlusDiagnostic", "codexPlusExtensionWantsRequestMiddleware", source);
(async () => {
  for (const feature of ["sessionDelete", "sideChatSave", "turnRewind"]) {
    for (const prototype of [false, true]) {
      const window = { __CODEX_PLUS_TEST_SERVICE_TIER__: true };
      const interceptors = new Map();
      let exchanges = 0;
      execute(window, () => {}, "30", interceptors,
        async (_name, exchange) => ({ ...exchange, send: () => { exchanges++; return exchange.send(); } }),
        () => null, () => null, () => null,
        () => ({ [feature]: true, modelWhitelistUnlock: true }), () => {}, () => true);
      const api = window.__codexPlusServiceTierTest;
      api.setModelCatalog({ model: "custom-model", models: ["custom-model"],
        modelMetadata: { "native-old": {}, "native-new": {} } });
      const native = { data: [{ model: "native-hidden", hidden: true, isDefault: true }], nextCursor: "next" };
      const snapshot = JSON.stringify(native);
      const calls = [];
      class Client {
        constructor() { this.hostId = "local"; }
        async sendRequest(method, params, options) { calls.push({ method, params, options }); return native; }
      }
      if (prototype) {
        window.__codexPlusAppServerClientClass = Client;
        assert.equal(api.installAppServerClientPrototypePatch(), true);
      }
      const client = new Client();
      if (!prototype) assert.equal(api.patchAppServerClient(client), true);
      const params = Object.freeze({ includeHidden: false, cursor: null, limit: 2 });
      const options = Object.freeze({ priority: "critical" });
      assert.equal(await client.sendRequest("model/list", params, options), native);
      assert.equal(calls[0].params, params);
      assert.equal(calls[0].options, options);
      const remote = Object.freeze({ hostId: "ssh:host", method: "model/list", params });
      assert.equal(await client.sendRequest("send-cli-request-for-host", remote), native);
      assert.equal(calls[1].params, remote);
      await client.sendRequest("thread/start", { threadId: "thread", model: "native-old" });
      await client.sendRequest("turn/start", { threadId: "thread", model: "native-new" });
      assert.deepEqual(calls.map(({ method }) => method), ["model/list", "send-cli-request-for-host", "thread/start", "turn/start"]);
      assert.equal(JSON.stringify(native), snapshot);
      // 第三方拓展仍能通过交换中间件包住原生请求，模型结果保持原样。
      interceptors.set("codex/exchange", []);
      assert.equal(await client.sendRequest("model/list", params), native);
      assert.equal(exchanges, 1);
      assert.equal(JSON.stringify(native), snapshot);
    }
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
"#).unwrap();
    let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../assets/inject/renderer-inject/70-model-catalog.js");
    let output = Command::new("node")
        .arg(&harness_path)
        .arg(source)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "native model harness failed\n{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn injection_script_retires_legacy_fast_controls_and_preserves_native_unlock() {
    let script = assets::injection_script();
    for retired in [
        "data-codex-plus-setting=\"serviceTierControls\"",
        "data-codex-service-tier-global-fast",
        "toggleCodexServiceTierFromBadge",
        "setCodexThreadServiceTierMode",
        "applyCodexServiceTierRequestOnly",
    ] {
        assert!(
            !script.contains(retired),
            "retired legacy Fast behavior: {retired}"
        );
    }
    assert_codex_setting_row(&script, "codexAppNativeFastUnlock", "nativeFastUnlock");
    assert!(script.contains("__codexPlusNativeFastUnlock"));
    assert!(script.contains("codexAppNativeFastUnlock"));
    assert!(script.contains("serviceTiers"));
    assert!(script.contains("locateCodexAppServerClientBreakpoint"));
    assert!(script.contains("installCodexAppServerClientPrototypePatch"));
}

#[test]
fn injection_script_discovers_vscode_api_asset_without_hardcoded_hash() {
    let script = assets::injection_script();

    assert!(script.contains("function loadCodexAppModule(namePart)"));
    assert!(script.contains("loadCodexAppModule(assetPrefix)"));
    assert!(script.contains("codexAppAssetUrlFromScriptText"));
    assert!(script.contains("fetch(src"));
    assert!(!script.contains("vscode-api-Dc9pX2Bc.js"));
    assert!(!script.contains("import(\"./assets/vscode-api-"));
}

#[test]
fn injection_script_discovers_app_server_request_clients_without_hardcoded_hash() {
    let script = assets::injection_script();

    assert!(script.contains("loadAppServerRequestCandidates"));
    assert!(script.contains("appServerFallbackAssetUrls"));
    assert!(script.contains("[\"use-host-config-\", \"app-server-manager-signals-\"]"));
    assert!(script.contains("loadOptionalCodexAppModule(assetPrefix)"));
    assert!(script.contains("candidateCount: candidates.length"));
    assert!(script.contains("discovery:"));
    // Keep legacy lookup as first attempt, but never hardcode the old hashed filename.
    assert!(
        !script.contains("app-server-manager-signals-C1h8B-R-.js")
            || script.contains("refreshRecentConversationsForHost")
    );
}

#[test]
fn injection_script_leaves_new_threads_to_the_codex_app() {
    let script = assets::injection_script();

    assert!(!script.contains("installCodexProjectlessNewTaskButtons"));
    assert!(!script.contains("loadCodexAppModule(\"projectless-thread-\")"));
    assert!(!script.contains("projectless_thread_start_overridden"));
    assert!(!script.contains("projectless_app_server_start_overridden"));
    assert!(!script.contains("projectless_main_window_home_route_cleared"));
    assert!(!script.contains("hotkey-window-projectless-default-enabled"));
    assert!(script.contains("installCodexServiceTierDispatcherPatch"));
    assert!(script.contains("installAppServerModelRequestPatch"));
    assert!(script.contains("originalSendRequest(method, params, options)"));
}

#[test]
fn manager_ui_omits_plugin_auto_expand() {
    let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(std::path::Path::parent)
        .expect("core crate should live under crates/codex-plus-core");
    let source = std::fs::read_to_string(repo.join("apps/codex-plus-manager/src/App.tsx")).unwrap();

    assert!(!source.contains("codexAppPluginAutoExpand"));
    assert!(!source.contains("插件列表全量展示"));
}

#[test]
fn cdp_target_deserializes_websocket_field() {
    let target: CdpTarget = serde_json::from_value(json!({
        "id": "page-1",
        "type": "page",
        "title": "Codex",
        "url": "https://codex.test",
        "webSocketDebuggerUrl": "ws://debug",
    }))
    .expect("target should deserialize");

    assert_eq!(target.target_type, "page");
    assert_eq!(
        target.web_socket_debugger_url.as_deref(),
        Some("ws://debug")
    );
}

#[test]
fn runtime_evaluate_params_sets_expected_flags() {
    let params = bridge::runtime_evaluate_params("1 + 1");

    assert_eq!(params["expression"], "1 + 1");
    assert_eq!(params["awaitPromise"], false);
    assert_eq!(params["allowUnsafeEvalBlockedByCSP"], true);
}

#[test]
fn runtime_evaluate_params_return_by_value_sets_flag() {
    let params = bridge::runtime_evaluate_params_return_by_value("({hello:\"world\"})");

    assert_eq!(params["returnByValue"], true);
    assert_eq!(params["awaitPromise"], false);
    assert_eq!(params["allowUnsafeEvalBlockedByCSP"], true);
}

#[test]
fn runtime_evaluate_params_can_await_promise_for_bridge_health_checks() {
    let params = bridge::runtime_evaluate_params_with_await_promise("Promise.resolve(true)", true);

    assert_eq!(params["expression"], "Promise.resolve(true)");
    assert_eq!(params["awaitPromise"], true);
    assert_eq!(params["allowUnsafeEvalBlockedByCSP"], true);
}

#[test]
fn bridge_health_check_script_uses_persisted_real_probe_result() {
    let script = bridge::bridge_health_check_script();

    assert!(script.contains("__codexSessionDeleteBridge"));
    assert!(script.contains("__codexPlusBridgeHealth"));
    assert!(script.contains("lastSuccessAt"));
    assert!(script.contains("lastInjectionAt"));
    assert!(script.contains("lastAttemptAt"));
    assert!(!script.contains("/backend/status"));
}

#[test]
fn bridge_health_check_script_rejects_stale_bridge_after_failed_requests() {
    let script = serde_json::to_string(bridge::bridge_health_check_script())
        .expect("health script should serialize");
    let harness = format!(
        r#"
const vm = require("node:vm");
const source = {script};
const bridge = () => Promise.resolve({{ status: "failed" }});
const run = (health, hasBridge = true) => vm.runInNewContext(source, {{
  window: {{ __codexSessionDeleteBridge: hasBridge ? bridge : null, __codexPlusBridgeHealth: health }},
}});
const now = Date.now();
if (run({{ lastInjectionAt: 0, lastSuccessAt: 1 }}) !== false) process.exit(1);
if (run({{ lastInjectionAt: 0, lastSuccessAt: now }}) !== true) process.exit(2);
if (run({{ lastInjectionAt: now, lastSuccessAt: 0 }}) !== true) process.exit(3);
if (run({{ lastInjectionAt: now - 6000, lastSuccessAt: 0 }}) !== false) process.exit(4);
if (run({{ lastInjectionAt: 1, lastSuccessAt: now - 16000 }}) !== false) process.exit(5);
if (run({{ lastInjectionAt: 0, lastSuccessAt: 0, lastAttemptAt: now }}) !== true) process.exit(7);
if (run({{ lastInjectionAt: 1, lastSuccessAt: now - 16000, lastAttemptAt: now - 16000 }}) !== false) process.exit(8);
if (run({{ lastInjectionAt: now, lastSuccessAt: now }}, false) !== false) process.exit(6);
"#,
        script = script
    );
    let output = Command::new("node")
        .arg("-e")
        .arg(harness)
        .output()
        .expect("node should run bridge health harness");
    assert!(
        output.status.success(),
        "bridge health harness failed\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn bridge_result_expressions_json_escape_inputs() {
    let resolve = bridge::resolve_bridge_expression("request\"1", &json!({"status": "ok"}))
        .expect("resolve expression should build");
    let reject = bridge::reject_bridge_expression("request\"1", "bad \"value\"")
        .expect("reject expression should build");

    assert_eq!(
        resolve,
        r#"window.__codexSessionDeleteResolve("request\"1", {"status":"ok"})"#
    );
    assert_eq!(
        reject,
        r#"window.__codexSessionDeleteReject("request\"1", "bad \"value\"")"#
    );
}

#[test]
fn pick_page_target_prefers_codex_title_or_url() {
    let targets = vec![
        target(
            "first",
            "page",
            "Other",
            "https://example.test",
            Some("ws://first"),
        ),
        target(
            "second",
            "page",
            "Codex",
            "https://example.test",
            Some("ws://second"),
        ),
        target(
            "third",
            "page",
            "Other",
            "https://codex.test",
            Some("ws://third"),
        ),
    ];

    let picked = pick_page_target(&targets).expect("target should be selected");

    assert_eq!(picked.id, "second");
}

#[test]
fn pick_page_target_leniently_falls_back_to_first_injectable_page() {
    let targets = vec![
        target(
            "browser",
            "browser",
            "Codex",
            "https://codex.test",
            Some("ws://browser"),
        ),
        target(
            "first",
            "page",
            "Other",
            "https://example.test",
            Some("ws://first"),
        ),
        target(
            "second",
            "page",
            "Other 2",
            "https://example.test/2",
            Some("ws://second"),
        ),
    ];

    let picked = pick_page_target(&targets).expect("target should be selected");

    assert_eq!(picked.id, "first");
}

#[test]
fn pick_page_target_rejects_non_pages_and_pages_without_websocket() {
    let targets = vec![
        target(
            "browser",
            "browser",
            "Codex",
            "https://codex.test",
            Some("ws://browser"),
        ),
        target("page-no-ws", "page", "Codex", "https://codex.test", None),
    ];

    let error = pick_page_target(&targets).expect_err("no injectable page should be selected");

    assert!(
        error
            .to_string()
            .contains("No injectable page target found")
    );
}

#[test]
fn pick_injectable_codex_page_target_rejects_non_codex_pages() {
    let targets = vec![
        target(
            "browser",
            "browser",
            "Codex",
            "https://codex.test",
            Some("ws://browser"),
        ),
        target(
            "other-page",
            "page",
            "Other App",
            "https://example.test",
            Some("ws://other"),
        ),
    ];

    let error = pick_injectable_codex_page_target(&targets)
        .expect_err("non-Codex page must not be selected for injection");

    assert!(
        error
            .to_string()
            .contains("No injectable Codex page target found")
    );
}

#[test]
fn pick_injectable_codex_page_target_ignores_embedded_browser_page_named_codex() {
    let targets = vec![
        target(
            "browser-pr",
            "page",
            "Fix Codex Pilot menu anchoring · Pull Request",
            "https://github.com/BigPizzaV3/CodexPlusPlus/pull/1743",
            Some("ws://browser-pr"),
        ),
        target(
            "main",
            "page",
            "Codex",
            "app://-/index.html",
            Some("ws://main"),
        ),
    ];

    let picked = pick_injectable_codex_page_target(&targets)
        .expect("Codex app page should win over embedded browser content");

    assert_eq!(picked.id, "main");
}

#[test]
fn pick_injectable_codex_page_target_ignores_standalone_manager() {
    let targets = vec![
        target(
            "manager",
            "page",
            "Codex Pilot 管理工具",
            "http://127.0.0.1:1420/",
            Some("ws://manager"),
        ),
        target(
            "main",
            "page",
            "Codex",
            "app://-/index.html",
            Some("ws://main"),
        ),
    ];

    let picked = pick_injectable_codex_page_target(&targets)
        .expect("native Codex app page should win over the standalone manager");

    assert_eq!(picked.id, "main");
}

#[test]
fn pick_injectable_codex_page_target_rejects_embedded_browser_only_page() {
    let targets = vec![target(
        "browser-pr",
        "page",
        "Fix Codex Pilot menu anchoring · Pull Request",
        "https://github.com/BigPizzaV3/CodexPlusPlus/pull/1743",
        Some("ws://browser-pr"),
    )];

    let error = pick_injectable_codex_page_target(&targets)
        .expect_err("embedded browser content must not be selected for injection");

    assert!(
        error
            .to_string()
            .contains("No injectable Codex page target found")
    );
}

#[test]
fn pick_injectable_codex_page_target_accepts_chatgpt_desktop_page() {
    let targets = vec![target(
        "chatgpt",
        "page",
        "ChatGPT",
        "https://chatgpt.com/",
        Some("ws://chatgpt"),
    )];

    let picked = pick_injectable_codex_page_target(&targets)
        .expect("ChatGPT desktop page should be selected");

    assert_eq!(picked.id, "chatgpt");
}

#[test]
fn pick_injectable_codex_page_target_accepts_chatgpt_desktop_error_page() {
    let targets = vec![target(
        "chatgpt-error",
        "page",
        "ChatGPT",
        "data:text/html;charset=utf-8,%3Ctitle%3EChatGPT%3C/title%3E",
        Some("ws://chatgpt-error"),
    )];

    let picked = pick_injectable_codex_page_target(&targets)
        .expect("ChatGPT desktop error page should be selected");

    assert_eq!(picked.id, "chatgpt-error");
}

#[test]
fn pick_injectable_codex_page_target_prefers_app_main_over_incidental_codex_page() {
    let targets = vec![
        target(
            "help",
            "page",
            "Using Codex with your ChatGPT plan",
            "https://help.openai.com/en/articles/using-codex",
            Some("ws://help"),
        ),
        target(
            "main",
            "page",
            "Codex",
            "app://-/index.html",
            Some("ws://main"),
        ),
    ];

    let picked = pick_injectable_codex_page_target(&targets)
        .expect("the exact app main renderer should win regardless of target order");

    assert_eq!(picked.id, "main");
}

#[test]
fn avatar_overlay_target_detection_is_narrow() {
    let overlay = target(
        "avatar",
        "page",
        "ChatGPT Avatar Overlay",
        "app://-/index.html?initialRoute=%2Favatar-overlay",
        Some("ws://avatar"),
    );
    let main = target(
        "main",
        "page",
        "ChatGPT",
        "https://chatgpt.com/",
        Some("ws://main"),
    );

    assert!(is_avatar_overlay_page_target(&overlay));
    assert!(!is_primary_codex_page_target(&overlay));
    assert!(!is_avatar_overlay_page_target(&main));
    assert!(is_primary_codex_page_target(&main));
    assert!(!is_avatar_overlay_page_target(&target(
        "external",
        "page",
        "avatar-overlay",
        "https://example.test/avatar-overlay",
        Some("ws://external"),
    )));
}

#[test]
fn primary_target_selection_skips_v1_and_v2_overlay_candidates() {
    let targets = vec![
        target(
            "v1-overlay",
            "page",
            "Codex",
            "app://-/index.html?initialRoute=%2Favatar-overlay",
            Some("ws://v1"),
        ),
        target(
            "v2-overlay",
            "page",
            "Codex",
            "app://-/index.html?initialRoute=/avatar-overlay",
            Some("ws://v2"),
        ),
        target(
            "main",
            "page",
            "Codex",
            "app://-/index.html",
            Some("ws://main"),
        ),
    ];

    let selected = pick_injectable_codex_page_target(&targets).unwrap();

    assert_eq!(selected.id, "main");
}

#[test]
fn quick_chat_target_detection_is_narrow() {
    for url in [
        "app://-/index.html?initialRoute=%2Fchatgpt%2Fquick-chat",
        "app://-/index.html?initialRoute=/chatgpt/quick-chat",
        "app://-/index.html?initialRoute=%2Fchatgpt%2Fquick-chat-prewarm",
        "app://-/index.html?initialRoute=/chatgpt/quick-chat-prewarm",
        "app://-/index.html?initialRoute=%2Fchatgpt%2Fquick-chat%2Fconversation-123",
        "app://-/index.html?initialRoute=/chatgpt/quick-chat/conversation-123",
    ] {
        let quick_chat = target("quick-chat", "page", "Codex", url, Some("ws://quick-chat"));

        assert!(is_quick_chat_page_target(&quick_chat));
        assert!(!is_primary_codex_page_target(&quick_chat));
    }

    assert!(!is_quick_chat_page_target(&target(
        "external",
        "page",
        "Codex",
        "https://example.test/chatgpt/quick-chat-prewarm",
        Some("ws://external"),
    )));
    assert!(!is_quick_chat_page_target(&target(
        "other-param",
        "page",
        "Codex",
        "app://-/index.html?next=initialRoute%3D%252Fchatgpt%252Fquick-chat-prewarm",
        Some("ws://other-param"),
    )));
    assert!(!is_quick_chat_page_target(&target(
        "similar-route",
        "page",
        "Codex",
        "app://-/index.html?initialRoute=%2Fchatgpt%2Fquick-chatty",
        Some("ws://similar-route"),
    )));
}

#[test]
fn primary_target_selection_skips_quick_chat_candidate() {
    let targets = vec![
        target(
            "quick-chat",
            "page",
            "Codex",
            "app://-/index.html?initialRoute=%2Fchatgpt%2Fquick-chat%2Fconversation-123",
            Some("ws://quick-chat"),
        ),
        target(
            "quick-chat-prewarm",
            "page",
            "Codex",
            "app://-/index.html?initialRoute=%2Fchatgpt%2Fquick-chat-prewarm",
            Some("ws://quick-chat-prewarm"),
        ),
        target(
            "main",
            "page",
            "Codex",
            "app://-/index.html",
            Some("ws://main"),
        ),
    ];

    let selected = pick_injectable_codex_page_target(&targets).unwrap();

    assert_eq!(selected.id, "main");
}

#[test]
fn quick_chat_only_target_is_not_injectable_as_codex_main_page() {
    let targets = vec![target(
        "quick-chat",
        "page",
        "Codex",
        "app://-/index.html?initialRoute=%2Fchatgpt%2Fquick-chat-prewarm",
        Some("ws://quick-chat"),
    )];

    let error = pick_injectable_codex_page_target(&targets)
        .expect_err("Quick Chat helper renderer must not be selected for injection");

    assert!(
        error
            .to_string()
            .contains("No injectable Codex page target found")
    );
}

#[test]
fn pick_injectable_codex_page_target_requires_websocket() {
    let targets = vec![target("codex", "page", "Codex", "https://codex.test", None)];

    let error = pick_injectable_codex_page_target(&targets)
        .expect_err("Codex page without websocket must not be selected for injection");

    assert!(
        error
            .to_string()
            .contains("No injectable Codex page target found")
    );
}

#[tokio::test]
async fn list_targets_can_query_ipv6_loopback_cdp_endpoint() {
    // Windows 环境可能禁用 IPv6 loopback 访问；不可用时跳过这个环境专用回归。
    let probe_listener = TcpListener::bind("[::1]:0")
        .await
        .expect("IPv6 loopback listener should bind");
    let probe_addr = probe_listener.local_addr().unwrap();
    if TcpStream::connect(probe_addr).await.is_err() {
        return;
    }
    drop(probe_listener);

    let listener = TcpListener::bind("[::1]:0")
        .await
        .expect("IPv6 loopback listener should bind");
    let port = listener.local_addr().unwrap().port();
    let body = serde_json::to_vec(&json!([
        {
            "id": "page-1",
            "type": "page",
            "title": "Codex",
            "url": "app://-/index.html",
            "webSocketDebuggerUrl": format!("ws://[::1]:{port}/devtools/page/page-1"),
        }
    ]))
    .unwrap();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.expect("request should arrive");
        let mut request = [0_u8; 1024];
        let _ = stream.readable().await;
        let _ = stream.try_read(&mut request);
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        stream
            .try_write(response.as_bytes())
            .expect("response headers should write");
        stream.try_write(&body).expect("response body should write");
    });

    let targets = list_targets(port)
        .await
        .expect("CDP target query should fall back to IPv6 loopback");

    assert_eq!(targets.len(), 1);
    assert_eq!(targets[0].id, "page-1");
    server.await.expect("server task should complete");
}

#[tokio::test]
async fn install_bridge_routes_binding_while_waiting_for_command_response() {
    ensure_bridge_test_settings();
    // 诊断日志路径是进程级状态，与其它测试模块串行。
    let _state = crate::common::global_state_lock();
    let temp = tempfile::tempdir().unwrap();
    let log_path = temp.path().join("codex-plus.log");
    codex_plus_core::diagnostic_log::set_diagnostic_log_path_for_tests(Some(log_path.clone()));
    let (url, request_rx) = spawn_cdp_server(|mut socket| async move {
        for expected_id in 1..=4 {
            let command = recv_json(&mut socket).await;
            assert_eq!(command["id"], expected_id);
            send_json(&mut socket, json!({ "id": expected_id, "result": {} })).await;
        }

        let evaluate = recv_json(&mut socket).await;
        assert_eq!(evaluate["id"], 5);
        assert_eq!(evaluate["method"], "Runtime.evaluate");
        send_json(
            &mut socket,
            json!({
                "method": "Runtime.bindingCalled",
                "params": {
                    "payload": serde_json::to_string(&json!({
                        "id": "request-1",
                        "path": "delete",
                        "payload": { "target": "session" },
                    })).unwrap(),
                },
            }),
        )
        .await;
        send_json(&mut socket, json!({ "id": 5, "result": {} })).await;

        let response = recv_json(&mut socket).await;
        assert_eq!(response["method"], "Runtime.evaluate");
        assert!(
            response["params"]["expression"]
                .as_str()
                .expect("expression should be string")
                .contains("__codexSessionDeleteResolve")
        );
        send_json(&mut socket, json!({ "id": response["id"], "result": {} })).await;
        close_socket(&mut socket).await;
    })
    .await;

    let handled = Arc::new(AtomicBool::new(false));
    let handler = {
        let handled = Arc::clone(&handled);
        Arc::new(move |path: String, payload: serde_json::Value| {
            let handled = Arc::clone(&handled);
            Box::pin(async move {
                assert_eq!(path, "delete");
                assert_eq!(payload["target"], "session");
                handled.store(true, Ordering::SeqCst);
                Ok(json!({ "status": "ok" }))
            })
                as Pin<Box<dyn Future<Output = anyhow::Result<serde_json::Value>> + Send>>
        })
    };

    tokio::time::timeout(
        Duration::from_secs(2),
        install_test_bridge(&url, BRIDGE_BINDING_NAME, handler, &[]),
    )
    .await
    .expect("bridge should not hang while processing interleaved binding call")
    .expect("bridge should keep processing interleaved binding call");
    request_rx
        .await
        .expect("server task should finish without panicking");
    assert!(handled.load(Ordering::SeqCst));
    let contents = std::fs::read_to_string(&log_path).unwrap();
    assert!(contents.contains("bridge.resolve_start"));
    assert!(contents.contains("bridge.resolve_ok"));
    codex_plus_core::diagnostic_log::set_diagnostic_log_path_for_tests(None);
}

#[tokio::test]
async fn install_bridge_immediately_evaluates_new_document_scripts() {
    let (url, request_rx) = spawn_cdp_server(|mut socket| async move {
        for expected_id in 1..=5 {
            let command = recv_json(&mut socket).await;
            assert_eq!(command["id"], expected_id);
            send_json(&mut socket, json!({ "id": expected_id, "result": {} })).await;
        }

        let add_main = recv_json(&mut socket).await;
        assert_eq!(add_main["method"], "Page.addScriptToEvaluateOnNewDocument");
        assert_eq!(add_main["params"]["source"], "window.mainInjected = true;");
        send_json(&mut socket, json!({ "id": add_main["id"], "result": {} })).await;

        let eval_main = recv_json(&mut socket).await;
        assert_eq!(eval_main["method"], "Runtime.evaluate");
        assert_eq!(
            eval_main["params"]["expression"],
            "window.mainInjected = true;"
        );
        send_json(&mut socket, json!({ "id": eval_main["id"], "result": {} })).await;

        let add_user = recv_json(&mut socket).await;
        assert_eq!(add_user["method"], "Page.addScriptToEvaluateOnNewDocument");
        assert_eq!(add_user["params"]["source"], "window.userInjected = true;");
        send_json(&mut socket, json!({ "id": add_user["id"], "result": {} })).await;

        let eval_user = recv_json(&mut socket).await;
        assert_eq!(eval_user["method"], "Runtime.evaluate");
        assert_eq!(
            eval_user["params"]["expression"],
            "window.userInjected = true;"
        );
        send_json(&mut socket, json!({ "id": eval_user["id"], "result": {} })).await;

        close_socket(&mut socket).await;
    })
    .await;

    tokio::time::timeout(
        Duration::from_secs(2),
        install_test_bridge(
            &url,
            BRIDGE_BINDING_NAME,
            noop_handler(),
            &[
                "window.mainInjected = true;".to_string(),
                "window.userInjected = true;".to_string(),
            ],
        ),
    )
    .await
    .expect("bridge should not hang while evaluating new document scripts")
    .expect("bridge should evaluate new document scripts immediately");
    request_rx
        .await
        .expect("server task should finish without panicking");
}

#[tokio::test]
async fn install_bridge_returns_after_installing_and_keeps_message_pump_alive() {
    let (url, request_rx) = spawn_cdp_server(|mut socket| async move {
        for expected_id in 1..=5 {
            let command = recv_json(&mut socket).await;
            assert_eq!(command["id"], expected_id);
            send_json(&mut socket, json!({ "id": expected_id, "result": {} })).await;
        }

        let add_script = recv_json(&mut socket).await;
        assert_eq!(
            add_script["method"],
            "Page.addScriptToEvaluateOnNewDocument"
        );
        send_json(&mut socket, json!({ "id": add_script["id"], "result": {} })).await;

        let eval_script = recv_json(&mut socket).await;
        assert_eq!(eval_script["method"], "Runtime.evaluate");
        send_json(
            &mut socket,
            json!({ "id": eval_script["id"], "result": {} }),
        )
        .await;

        send_json(
            &mut socket,
            json!({
                "method": "Runtime.bindingCalled",
                "params": {
                    "payload": serde_json::to_string(&json!({
                        "id": "after-return",
                        "path": "status",
                        "payload": {},
                    })).unwrap(),
                },
            }),
        )
        .await;

        let resolve = recv_json(&mut socket).await;
        assert!(
            resolve["params"]["expression"]
                .as_str()
                .expect("expression should be string")
                .contains("after-return")
        );
        send_json(&mut socket, json!({ "id": resolve["id"], "result": {} })).await;
        close_socket(&mut socket).await;
    })
    .await;

    let handled = Arc::new(AtomicBool::new(false));
    let handler = {
        let handled = Arc::clone(&handled);
        Arc::new(move |_path: String, _payload: serde_json::Value| {
            let handled = Arc::clone(&handled);
            Box::pin(async move {
                handled.store(true, Ordering::SeqCst);
                Ok(json!({ "status": "ok" }))
            })
                as Pin<Box<dyn Future<Output = anyhow::Result<serde_json::Value>> + Send>>
        })
    };

    tokio::time::timeout(
        Duration::from_secs(2),
        install_test_bridge(
            &url,
            BRIDGE_BINDING_NAME,
            handler,
            &["window.ready = true;".to_string()],
        ),
    )
    .await
    .expect("bridge install should return after setup")
    .expect("bridge install should succeed");

    request_rx
        .await
        .expect("server task should finish without panicking");
    assert!(handled.load(Ordering::SeqCst));
}

#[tokio::test]
async fn install_bridge_command_error_mentions_method_and_id() {
    let (url, request_rx) = spawn_cdp_server(|mut socket| async move {
        let command = recv_json(&mut socket).await;
        assert_eq!(command["method"], "Runtime.enable");
        send_json(
            &mut socket,
            json!({
                "id": command["id"],
                "error": { "code": -32000, "message": "Runtime disabled" },
            }),
        )
        .await;
        close_socket(&mut socket).await;
    })
    .await;

    let handler = noop_handler();
    let error = tokio::time::timeout(
        Duration::from_secs(2),
        install_test_bridge(&url, BRIDGE_BINDING_NAME, handler, &[]),
    )
    .await
    .expect("bridge should not hang on CDP error response")
    .expect_err("CDP error response should fail install");
    let message = error.to_string();

    request_rx
        .await
        .expect("server task should finish without panicking");
    assert!(message.contains("Runtime.enable"), "{message}");
    assert!(message.contains("id 1"), "{message}");
    assert!(message.contains("Runtime disabled"), "{message}");
}

#[tokio::test]
async fn install_bridge_rejects_bad_payload_with_id_and_continues_after_unparseable_payload() {
    let (url, request_rx) = spawn_cdp_server(|mut socket| async move {
        for expected_id in 1..=5 {
            let command = recv_json(&mut socket).await;
            assert_eq!(command["id"], expected_id);
            send_json(&mut socket, json!({ "id": expected_id, "result": {} })).await;
        }

        send_json(
            &mut socket,
            json!({
                "method": "Runtime.bindingCalled",
                "params": { "payload": "{\"id\":\"bad-1\",\"payload\":{}" },
            }),
        )
        .await;
        send_json(
            &mut socket,
            json!({
                "method": "Runtime.bindingCalled",
                "params": { "payload": "not json" },
            }),
        )
        .await;
        send_json(
            &mut socket,
            json!({
                "method": "Runtime.bindingCalled",
                "params": {
                    "payload": serde_json::to_string(&json!({
                        "id": "ok-1",
                        "path": "delete",
                        "payload": {},
                    })).unwrap(),
                },
            }),
        )
        .await;

        let reject = recv_json(&mut socket).await;
        assert!(
            reject["params"]["expression"]
                .as_str()
                .expect("expression should be string")
                .contains("__codexSessionDeleteReject")
        );
        assert!(
            reject["params"]["expression"]
                .as_str()
                .expect("expression should be string")
                .contains("bad-1")
        );
        send_json(&mut socket, json!({ "id": reject["id"], "result": {} })).await;

        let resolve = recv_json(&mut socket).await;
        assert!(
            resolve["params"]["expression"]
                .as_str()
                .expect("expression should be string")
                .contains("__codexSessionDeleteResolve")
        );
        assert!(
            resolve["params"]["expression"]
                .as_str()
                .expect("expression should be string")
                .contains("ok-1")
        );
        send_json(&mut socket, json!({ "id": resolve["id"], "result": {} })).await;
        close_socket(&mut socket).await;
    })
    .await;

    tokio::time::timeout(
        Duration::from_secs(2),
        install_test_bridge(&url, BRIDGE_BINDING_NAME, noop_handler(), &[]),
    )
    .await
    .expect("bridge should not hang after bad payload")
    .expect("bad payloads should not terminate the bridge loop");
    request_rx
        .await
        .expect("server task should finish without panicking");
}

#[tokio::test]
async fn install_bridge_queues_consecutive_bindings_without_recursive_dispatch() {
    let (url, request_rx) = spawn_cdp_server(|mut socket| async move {
        for expected_id in 1..=5 {
            let command = recv_json(&mut socket).await;
            assert_eq!(command["id"], expected_id);
            send_json(&mut socket, json!({ "id": expected_id, "result": {} })).await;
        }

        for request_id in ["first", "second", "third"] {
            send_json(
                &mut socket,
                json!({
                    "method": "Runtime.bindingCalled",
                    "params": {
                        "payload": serde_json::to_string(&json!({
                            "id": request_id,
                            "path": "delete",
                            "payload": { "request": request_id },
                        })).unwrap(),
                    },
                }),
            )
            .await;
        }

        let first = recv_json(&mut socket).await;
        assert_eq!(first["method"], "Runtime.evaluate");
        assert_expression_contains_request(&first, "first");
        let second = recv_json(&mut socket).await;
        assert_eq!(second["method"], "Runtime.evaluate");
        assert_expression_contains_request(&second, "second");
        assert_ne!(second["id"], first["id"]);

        let third = recv_json(&mut socket).await;
        assert_eq!(third["method"], "Runtime.evaluate");
        assert_expression_contains_request(&third, "third");
        assert_ne!(third["id"], first["id"]);
        assert_ne!(third["id"], second["id"]);

        close_socket(&mut socket).await;
    })
    .await;

    let handler = Arc::new(|_path: String, payload: serde_json::Value| {
        Box::pin(async move { Ok(json!({ "status": "ok", "request": payload["request"] })) })
            as Pin<Box<dyn Future<Output = anyhow::Result<serde_json::Value>> + Send>>
    });

    tokio::time::timeout(
        Duration::from_secs(2),
        install_test_bridge(&url, BRIDGE_BINDING_NAME, handler, &[]),
    )
    .await
    .expect("bridge should not hang while draining queued binding calls")
    .expect("bridge should process queued binding calls");
    request_rx
        .await
        .expect("server task should finish without panicking");
}

#[tokio::test]
async fn install_bridge_does_not_wait_for_resolve_runtime_evaluate_ack() {
    let (url, request_rx) = spawn_cdp_server(|mut socket| async move {
        for expected_id in 1..=5 {
            let command = recv_json(&mut socket).await;
            assert_eq!(command["id"], expected_id);
            send_json(&mut socket, json!({ "id": expected_id, "result": {} })).await;
        }

        send_json(
            &mut socket,
            json!({
                "method": "Runtime.bindingCalled",
                "params": {
                    "payload": serde_json::to_string(&json!({
                        "id": "first",
                        "path": "/backend/status",
                        "payload": {},
                    })).unwrap(),
                },
            }),
        )
        .await;
        let first_resolve = recv_json(&mut socket).await;
        assert_eq!(first_resolve["method"], "Runtime.evaluate");
        assert_expression_contains_request(&first_resolve, "first");

        send_json(
            &mut socket,
            json!({
                "method": "Runtime.bindingCalled",
                "params": {
                    "payload": serde_json::to_string(&json!({
                        "id": "second",
                        "path": "/backend/status",
                        "payload": {},
                    })).unwrap(),
                },
            }),
        )
        .await;
        let second_resolve =
            tokio::time::timeout(Duration::from_millis(500), recv_json(&mut socket))
                .await
                .expect(
                    "second resolve should be sent without waiting for first Runtime.evaluate ack",
                );
        assert_eq!(second_resolve["method"], "Runtime.evaluate");
        assert_expression_contains_request(&second_resolve, "second");
        close_socket(&mut socket).await;
    })
    .await;

    let handler = Arc::new(|_path: String, _payload: serde_json::Value| {
        Box::pin(async { Ok(json!({ "status": "ok" })) })
            as Pin<Box<dyn Future<Output = anyhow::Result<serde_json::Value>> + Send>>
    });

    tokio::time::timeout(
        Duration::from_secs(2),
        install_test_bridge(&url, BRIDGE_BINDING_NAME, handler, &[]),
    )
    .await
    .expect("bridge install should not wait for resolve ack")
    .expect("bridge install should survive missing resolve ack");
    request_rx
        .await
        .expect("server task should finish without panicking");
}

#[tokio::test]
async fn install_bridge_keeps_status_responsive_while_generate_is_pending() {
    let generate_started = Arc::new(Notify::new());
    let release_generate = Arc::new(Notify::new());
    let server_generate_started = Arc::clone(&generate_started);
    let server_release_generate = Arc::clone(&release_generate);
    let (url, request_rx) = spawn_cdp_server(move |mut socket| async move {
        acknowledge_bridge_install(&mut socket).await;

        send_json(
            &mut socket,
            json!({
                "method": "Runtime.bindingCalled",
                "params": {
                    "payload": serde_json::to_string(&json!({
                        "id": "generate",
                        "path": "/bridge-test/slow-request",
                        "payload": {},
                    })).unwrap(),
                },
            }),
        )
        .await;
        tokio::time::timeout(
            Duration::from_millis(500),
            server_generate_started.notified(),
        )
        .await
        .expect("generate handler should start before the status probe");

        send_json(
            &mut socket,
            json!({
                "method": "Runtime.bindingCalled",
                "params": {
                    "payload": serde_json::to_string(&json!({
                        "id": "status",
                        "path": "/backend/status",
                        "payload": {},
                    })).unwrap(),
                },
            }),
        )
        .await;

        let status_resolve =
            tokio::time::timeout(Duration::from_millis(500), recv_json(&mut socket))
                .await
                .expect("status should resolve while generate remains pending");
        assert_eq!(status_resolve["method"], "Runtime.evaluate");
        assert_expression_contains_request(&status_resolve, "status");

        server_release_generate.notify_one();
        let generate_resolve = recv_json(&mut socket).await;
        assert_eq!(generate_resolve["method"], "Runtime.evaluate");
        assert_expression_contains_request(&generate_resolve, "generate");
        close_socket(&mut socket).await;
    })
    .await;

    let handler_generate_started = Arc::clone(&generate_started);
    let handler_release_generate = Arc::clone(&release_generate);
    let handler = Arc::new(move |path: String, _payload: serde_json::Value| {
        let generate_started = Arc::clone(&handler_generate_started);
        let release_generate = Arc::clone(&handler_release_generate);
        Box::pin(async move {
            if path == "/bridge-test/slow-request" {
                generate_started.notify_one();
                release_generate.notified().await;
            }
            Ok(json!({ "status": "ok", "path": path }))
        }) as Pin<Box<dyn Future<Output = anyhow::Result<serde_json::Value>> + Send>>
    });

    tokio::time::timeout(
        Duration::from_secs(2),
        install_test_bridge(&url, BRIDGE_BINDING_NAME, handler, &[]),
    )
    .await
    .expect("bridge install should return while generate is pending")
    .expect("bridge install should start the concurrent message pump");
    request_rx
        .await
        .expect("server task should finish without panicking");
}

#[tokio::test]
async fn superseded_bridge_session_stops_answering_binding_calls() {
    let (url, stale_rx, fresh_rx) = spawn_two_session_cdp_server().await;

    install_test_bridge(&url, BRIDGE_BINDING_NAME, noop_handler(), &[])
        .await
        .expect("first bridge install should succeed");
    install_test_bridge(&url, BRIDGE_BINDING_NAME, noop_handler(), &[])
        .await
        .expect("second bridge install should succeed");

    let stale_resolved = stale_rx
        .await
        .expect("stale server task should finish without panicking");
    assert!(
        !stale_resolved,
        "superseded session must not resolve bridge requests"
    );
    fresh_rx
        .await
        .expect("fresh server task should finish without panicking");
}

/// 被顶替的旧会话不能依赖"socket 再收到消息"来发现 generation 过期：
/// bridge 失效场景下旧 socket 不会再有任何消息（binding 事件只投递给最新会话），
/// 旧会话必须靠 generation 轮询在一个间隔内主动关闭，否则会带着
/// Runtime.enable 订阅与脚本注册无限期滞留（issue #2169 的会话堆积来源）。
#[tokio::test]
async fn superseded_bridge_session_closes_socket_without_incoming_messages() {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("test listener should bind");
    let address = listener.local_addr().expect("listener should have address");
    let url = websocket_url(address);
    let (stale_closed_tx, stale_closed_rx) = oneshot::channel();
    let (fresh_alive_tx, fresh_alive_rx) = oneshot::channel();

    tokio::spawn(async move {
        let (stale_stream, _) = listener
            .accept()
            .await
            .expect("stale client should connect");
        let mut stale = accept_async(stale_stream)
            .await
            .expect("stale websocket should upgrade");
        acknowledge_bridge_install(&mut stale).await;

        let (fresh_stream, _) = listener
            .accept()
            .await
            .expect("fresh client should connect");
        let mut fresh = accept_async(fresh_stream)
            .await
            .expect("fresh websocket should upgrade");
        acknowledge_bridge_install(&mut fresh).await;

        // 旧会话会先移除自己注册的 new-document 脚本，再由 generation 轮询关闭 socket。
        let stale_cleanup = tokio::time::timeout(
            bridge::BRIDGE_GENERATION_POLL_INTERVAL + Duration::from_millis(1500),
            async {
                let mut removed = false;
                loop {
                    match recv_text_message(&mut stale).await {
                        Some(text) => {
                            let message: serde_json::Value = serde_json::from_str(&text)
                                .expect("bridge cleanup message should be JSON");
                            if message["method"] == "Page.removeScriptToEvaluateOnNewDocument" {
                                removed = true;
                            }
                        }
                        None => break removed,
                    }
                }
            },
        )
        .await
        .unwrap_or(false);
        let _ = stale_closed_tx.send(stale_cleanup);

        // 新会话不受影响，仍应正常应答 binding 调用。
        send_json(
            &mut fresh,
            json!({
                "method": "Runtime.bindingCalled",
                "params": {
                    "payload": serde_json::to_string(&json!({
                        "id": "fresh",
                        "path": "/backend/status",
                        "payload": {},
                    })).unwrap(),
                },
            }),
        )
        .await;
        let fresh_resolved =
            tokio::time::timeout(Duration::from_secs(2), recv_text_message(&mut fresh))
                .await
                .is_ok_and(|message| {
                    message.is_some_and(|text| text.contains("__codexSessionDeleteResolve"))
                });
        let _ = fresh_alive_tx.send(fresh_resolved);
    });

    install_test_bridge(&url, BRIDGE_BINDING_NAME, noop_handler(), &[])
        .await
        .expect("first bridge install should succeed");
    install_test_bridge(&url, BRIDGE_BINDING_NAME, noop_handler(), &[])
        .await
        .expect("second bridge install should succeed");

    assert!(
        stale_closed_rx
            .await
            .expect("stale server task should finish without panicking"),
        "superseded session must close its socket without any incoming message"
    );
    assert!(
        fresh_alive_rx
            .await
            .expect("fresh server task should finish without panicking"),
        "fresh session must keep resolving bridge requests"
    );
}

#[tokio::test]
async fn failed_bridge_reinstall_keeps_existing_session_current() {
    let (url, active_rx, failed_rx) = spawn_failed_reinstall_cdp_server().await;

    install_test_bridge(&url, BRIDGE_BINDING_NAME, noop_handler(), &[])
        .await
        .expect("first bridge install should succeed");
    let error = install_test_bridge(&url, BRIDGE_BINDING_NAME, noop_handler(), &[])
        .await
        .expect_err("second bridge install should fail");
    assert!(error.to_string().contains("Runtime.addBinding"));

    assert!(
        active_rx
            .await
            .expect("active server task should finish without panicking"),
        "failed reinstall must not supersede the existing bridge session"
    );
    failed_rx
        .await
        .expect("failed reinstall server task should finish without panicking");
}

type TestSocket = tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>;

async fn spawn_two_session_cdp_server() -> (String, oneshot::Receiver<bool>, oneshot::Receiver<()>)
{
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("test listener should bind");
    let address = listener.local_addr().expect("listener should have address");
    let (stale_tx, stale_rx) = oneshot::channel();
    let (fresh_tx, fresh_rx) = oneshot::channel();

    tokio::spawn(async move {
        let (stale_stream, _) = listener
            .accept()
            .await
            .expect("stale client should connect");
        let mut stale = accept_async(stale_stream)
            .await
            .expect("stale websocket should upgrade");
        acknowledge_bridge_install(&mut stale).await;

        let (fresh_stream, _) = listener
            .accept()
            .await
            .expect("fresh client should connect");
        let mut fresh = accept_async(fresh_stream)
            .await
            .expect("fresh websocket should upgrade");
        acknowledge_bridge_install(&mut fresh).await;

        send_json(
            &mut stale,
            json!({
                "method": "Runtime.bindingCalled",
                "params": {
                    "payload": serde_json::to_string(&json!({
                        "id": "stale",
                        "path": "/backend/status",
                        "payload": {},
                    })).unwrap(),
                },
            }),
        )
        .await;

        let stale_resolved =
            tokio::time::timeout(Duration::from_millis(500), recv_text_message(&mut stale))
                .await
                .is_ok_and(|message| message.is_some_and(|text| text.contains("Runtime.evaluate")));
        let _ = stale_tx.send(stale_resolved);
        close_socket(&mut fresh).await;
        let _ = fresh_tx.send(());
    });

    (websocket_url(address), stale_rx, fresh_rx)
}

async fn spawn_failed_reinstall_cdp_server()
-> (String, oneshot::Receiver<bool>, oneshot::Receiver<()>) {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("test listener should bind");
    let address = listener.local_addr().expect("listener should have address");
    let (active_tx, active_rx) = oneshot::channel();
    let (failed_tx, failed_rx) = oneshot::channel();

    tokio::spawn(async move {
        let (active_stream, _) = listener
            .accept()
            .await
            .expect("active client should connect");
        let mut active = accept_async(active_stream)
            .await
            .expect("active websocket should upgrade");
        acknowledge_bridge_install(&mut active).await;

        let (failed_stream, _) = listener
            .accept()
            .await
            .expect("failed client should connect");
        let mut failed = accept_async(failed_stream)
            .await
            .expect("failed websocket should upgrade");
        for expected_id in 1..=2 {
            let command = recv_json(&mut failed).await;
            assert_eq!(command["id"], expected_id);
            send_json(&mut failed, json!({ "id": expected_id, "result": {} })).await;
        }
        let add_binding = recv_json(&mut failed).await;
        assert_eq!(add_binding["id"], 3);
        assert_eq!(add_binding["method"], "Runtime.addBinding");
        send_json(
            &mut failed,
            json!({
                "id": 3,
                "error": { "code": -32000, "message": "binding install failed" }
            }),
        )
        .await;
        close_socket(&mut failed).await;
        let _ = failed_tx.send(());

        send_json(
            &mut active,
            json!({
                "method": "Runtime.bindingCalled",
                "params": {
                    "payload": serde_json::to_string(&json!({
                        "id": "active",
                        "path": "/backend/status",
                        "payload": {},
                    })).unwrap(),
                },
            }),
        )
        .await;
        let active_resolved =
            tokio::time::timeout(Duration::from_millis(500), recv_json(&mut active))
                .await
                .is_ok_and(|message| {
                    message["method"] == "Runtime.evaluate"
                        && message["params"]["expression"]
                            .as_str()
                            .is_some_and(|expression| expression.contains("active"))
                });
        let _ = active_tx.send(active_resolved);
        close_socket(&mut active).await;
    });

    (websocket_url(address), active_rx, failed_rx)
}

async fn acknowledge_bridge_install(socket: &mut TestSocket) {
    for expected_id in 1..=5 {
        let command = recv_json(socket).await;
        assert_eq!(command["id"], expected_id);
        let result = if expected_id == 4 {
            json!({ "identifier": "bridge-script-test" })
        } else {
            json!({})
        };
        send_json(socket, json!({ "id": expected_id, "result": result })).await;
    }
}

async fn recv_text_message(socket: &mut TestSocket) -> Option<String> {
    match socket.next().await {
        Some(Ok(Message::Text(text))) => Some(text.to_string()),
        _ => None,
    }
}

#[tokio::test]
async fn extension_cdp_evaluate_returns_objects_and_arrays_by_value() {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("cdp listener should bind");
    let port = listener.local_addr().expect("listener address").port();
    let websocket = format!("ws://127.0.0.1:{port}/devtools/page/overlay");
    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                break;
            };
            let websocket = websocket.clone();
            tokio::spawn(async move {
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                let mut peeked = [0_u8; 2048];
                let peeked_len = stream.peek(&mut peeked).await.unwrap_or(0);
                let head = String::from_utf8_lossy(&peeked[..peeked_len]);
                if head.contains("GET /json") {
                    let mut buf = vec![0_u8; 4096];
                    let _ = stream.read(&mut buf).await;
                    let body = json!([{
                        "id": "overlay",
                        "type": "page",
                        "title": "overlay",
                        "url": "app://-/index.html?initialRoute=%2Favatar-overlay",
                        "webSocketDebuggerUrl": websocket,
                    }])
                    .to_string();
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = stream.write_all(response.as_bytes()).await;
                    return;
                }
                let mut socket = accept_async(stream)
                    .await
                    .expect("websocket should upgrade");
                let command = recv_json(&mut socket).await;
                assert_eq!(command["method"], "Runtime.evaluate");
                let by_value = command["params"]["returnByValue"] == true;
                let expression = command["params"]["expression"].as_str().unwrap_or("");
                // 不带 returnByValue 时，V8 对对象只回 objectId，value 为空。
                let remote = if !by_value {
                    json!({ "type": "object", "objectId": "obj-1" })
                } else if expression.contains('[') {
                    json!({ "type": "object", "value": [1, "two"] })
                } else {
                    json!({ "type": "object", "value": { "hello": "world" } })
                };
                send_json(
                    &mut socket,
                    json!({ "id": command["id"], "result": { "result": remote } }),
                )
                .await;
                close_socket(&mut socket).await;
            });
        }
    });

    let object = codex_plus_core::routes::evaluate_extension_cdp(
        port,
        &json!({ "kind": "avatar-overlay", "expression": "({hello:\"world\"})" }),
    )
    .await
    .expect("object evaluation should succeed");
    assert_eq!(object["results"][0]["ok"], true);
    assert_eq!(object["results"][0]["value"]["hello"], "world");

    let array = codex_plus_core::routes::evaluate_extension_cdp(
        port,
        &json!({ "kind": "avatar-overlay", "expression": "[1, \"two\"]" }),
    )
    .await
    .expect("array evaluation should succeed");
    assert_eq!(array["results"][0]["ok"], true);
    assert_eq!(array["results"][0]["value"], json!([1, "two"]));
}

async fn spawn_cdp_server<F, Fut>(handler: F) -> (String, oneshot::Receiver<()>)
where
    F: FnOnce(TestSocket) -> Fut + Send + 'static,
    Fut: Future<Output = ()> + Send + 'static,
{
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("test listener should bind");
    let address = listener.local_addr().expect("listener should have address");
    let (done_tx, done_rx) = oneshot::channel();

    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.expect("client should connect");
        let socket = accept_async(stream)
            .await
            .expect("websocket should upgrade");
        handler(socket).await;
        let _ = done_tx.send(());
    });

    (websocket_url(address), done_rx)
}

fn websocket_url(address: SocketAddr) -> String {
    format!("ws://{address}")
}

async fn recv_json(socket: &mut TestSocket) -> serde_json::Value {
    let message = socket
        .next()
        .await
        .expect("client should send message")
        .expect("message should be readable");
    let Message::Text(text) = message else {
        panic!("expected text websocket message");
    };
    serde_json::from_str(&text).expect("message should be JSON")
}

async fn send_json(socket: &mut TestSocket, value: serde_json::Value) {
    socket
        .send(Message::Text(value.to_string().into()))
        .await
        .expect("message should send");
}

fn assert_expression_contains_request(command: &serde_json::Value, request_id: &str) {
    let expression = command["params"]["expression"]
        .as_str()
        .expect("expression should be string");
    assert!(
        expression.contains("__codexSessionDeleteResolve"),
        "{expression}"
    );
    assert!(expression.contains(request_id), "{expression}");
}

async fn close_socket(socket: &mut TestSocket) {
    socket.close(None).await.expect("websocket should close");
    let _ = tokio::time::timeout(Duration::from_millis(200), socket.next()).await;
}

async fn install_test_bridge(
    websocket_url: &str,
    binding_name: &str,
    handler: bridge::BridgeHandler,
    new_document_scripts: &[String],
) -> anyhow::Result<()> {
    ensure_bridge_test_settings();
    bridge::install_bridge(websocket_url, binding_name, handler, new_document_scripts).await
}

/// 桥接模拟协议使用缺省开关，不能受本机用户已开启的 Fast 等设置影响。
/// 目录保留到进程结束，供安装后启动的后台任务继续读取。
/// 会取共享锁：已持锁的用例要在取锁之前先调用它，否则首次初始化会自锁。
fn ensure_bridge_test_settings() {
    static SETTINGS_DIR: OnceLock<tempfile::TempDir> = OnceLock::new();
    SETTINGS_DIR.get_or_init(|| {
        // 别的模块的用例可能正持锁临时覆盖设置路径，等它复原后再设，免得被它的复原冲掉。
        let _state = crate::common::global_state_lock();
        let dir = tempfile::tempdir().unwrap();
        codex_plus_core::paths::set_settings_path_for_tests(Some(dir.path().join("settings.json")));
        dir
    });
}

fn noop_handler() -> bridge::BridgeHandler {
    Arc::new(|_, _| {
        Box::pin(async { Ok(json!({ "status": "ok" })) })
            as Pin<Box<dyn Future<Output = anyhow::Result<serde_json::Value>> + Send>>
    })
}

#[test]
fn app_server_client_capture_condition_targets_class_handle() {
    assert_eq!(
        bridge::app_server_client_capture_condition(),
        "!window.__codexPlusAppServerClientClass"
    );
}

#[test]
fn parse_app_server_client_capture_location_reads_renderer_report() {
    let report = json!({
        "urlRegex": "app://-/assets/app-initial-abc123.js",
        "lineNumber": 1796_u64,
        "columnNumber": 87512_u64,
    });
    let (url_regex, line, column) = bridge::parse_app_server_client_capture_location(
        &serde_json::Value::String(report.to_string()),
    )
    .expect("renderer report should parse");
    assert_eq!(url_regex, "app://-/assets/app-initial-abc123.js");
    assert_eq!(line, 1796);
    assert_eq!(column, 87512);
    assert!(bridge::parse_app_server_client_capture_location(&json!("null")).is_none());
    assert!(bridge::parse_app_server_client_capture_location(&json!("{}")).is_none());
    assert!(bridge::parse_app_server_client_capture_location(&json!("")).is_none());
}

#[test]
fn injection_script_has_no_retired_remote_worktree_entrypoints() {
    let script = assets::injection_script();
    for removed in [
        "installUpstreamBranchDropdownAdapter",
        "annotateBranchMenuWorktreeUsage",
        "data-codex-branch-worktree-path",
        "/upstream-worktree/",
        "/zed-remote/",
    ] {
        assert!(!script.contains(removed), "retired entrypoint: {removed}");
    }
}

#[test]
fn injection_script_preserves_native_menu_placement_without_language_rewrites() {
    let script = assets::injection_script();
    assert!(script.contains("nativeMenuPlacement"));
    assert!(!script.contains("codexMenuLocalizationMap"));
    assert!(!script.contains("function localizeCodexMenus"));
    assert!(!script.contains("localizeCodexMenus();"));
}
