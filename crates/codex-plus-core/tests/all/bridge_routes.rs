use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use codex_plus_core::launcher::{
    CodexLaunch, LaunchHooks, LaunchOptions, ProcessWaitStrategy, launch_and_inject_with_hooks,
};
use codex_plus_core::models::SessionRef;
use codex_plus_core::routes::{
    BridgeContext, BridgeDataService, BridgeRuntimeService, BridgeSettingsService,
    CoreRuntimeService, evaluate_extension_cdp, handle_bridge_request,
};
use codex_plus_core::settings::BackendSettings;
use codex_plus_core::status::StatusStore;
use codex_plus_core::user_scripts::UserScriptManager;
use serde_json::{Value, json};

#[tokio::test]
async fn bridge_routes_cover_all_current_paths() {
    let ctx = test_context();

    let cases = [
        ("/settings/get", json!({})),
        (
            "/settings/set",
            json!({"codexAppNativeProjectSections": true}),
        ),
        ("/settings/catalog", json!({})),
        ("/settings/public", json!({})),
        ("/model-catalog/public", json!({})),
        ("/user-scripts/list", json!({})),
        (
            "/user-scripts/set-script-enabled",
            json!({"key": "builtin:paste-fix", "enabled": false}),
        ),
        ("/user-scripts/reload", json!({})),
        ("/user-scripts/load", json!({})),
        ("/cdp/targets", json!({})),
        (
            "/cdp/evaluate",
            json!({"kind":"avatar-overlay","expression":"1"}),
        ),
        ("/devtools/open", json!({})),
        ("/manager/open", json!({})),
        ("/manager/open-transient", json!({})),
        ("/backend/status", json!({})),
        ("/codex-model-catalog", json!({})),
        ("/codex-config-model", json!({})),
        (
            "/llm-proxy",
            json!({"url": "http://example.com", "method": "POST"}),
        ),
        (
            "/thread-usage-history",
            json!({"session_id": "s1", "title": "First"}),
        ),
        (
            "/thread-usage-live",
            json!({"session_id": "s1", "title": "First"}),
        ),
        ("/archived-thread", json!({"title": "Archived"})),
    ];

    for (path, payload) in cases {
        let result = handle_bridge_request(ctx.clone(), path, payload).await;
        assert_ne!(
            result["message"], "Unknown bridge path",
            "{path} should be routed"
        );
    }
}

#[tokio::test]
async fn removed_user_extension_mutation_and_market_routes_are_unavailable() {
    let ctx = test_context();
    for (path, payload) in [
        ("/user-scripts/set-enabled", json!({"enabled": false})),
        ("/user-scripts/delete", json!({"key": "user:a.js"})),
        ("/user-scripts/readme", json!({"key": "user:a.js"})),
        (
            "/user-scripts/set-config",
            json!({"key": "user:a.js", "values": {}}),
        ),
        ("/script-market/list", json!({})),
        ("/script-market/install", json!({"id": "example"})),
    ] {
        let result = handle_bridge_request(ctx.clone(), path, payload).await;
        assert_eq!(result["message"], "Unknown bridge path", "{path}: {result}");
    }
}

#[tokio::test]
async fn retired_bundled_feature_routes_are_unavailable() {
    let ctx = test_context();
    for path in [
        "/agent-pet/catalog",
        "/agent-pet/image",
        "/agent-pet/sound",
        "/agent-pet/import-sound",
        "/image-overlay/image",
        "/whale/media",
        "/whale/full",
        "/whale/balance",
        "/whale/history",
        "/whale/session",
    ] {
        let result = handle_bridge_request(ctx.clone(), path, json!({})).await;
        assert_eq!(result["message"], "Unknown bridge path", "{path}: {result}");
    }
}

#[tokio::test]
async fn cdp_evaluate_rejects_empty_expression_without_touching_cdp() {
    let error = evaluate_extension_cdp(1, &json!({"kind": "avatar-overlay"}))
        .await
        .unwrap_err();
    assert!(error.to_string().contains("expression"), "{error}");
}

#[tokio::test]
async fn cdp_routes_are_wired_for_extensions() {
    let result = handle_bridge_request(test_context(), "/cdp/targets", json!({})).await;
    assert_eq!(result["status"], "failed");
    assert_ne!(result["message"], "Unknown bridge path");
    assert!(
        result["message"]
            .as_str()
            .unwrap_or("")
            .contains("CDP targets"),
        "{}",
        result
    );
}

#[tokio::test]
async fn thread_usage_live_route_returns_recent_token_events() {
    // 内置状态栏走的就是这条路由；它必须与 /thread-usage-history 分开，
    // 因为状态栏按秒级轮询，拿不动全量历史。
    let result = handle_bridge_request(
        test_context(),
        "/thread-usage-live",
        json!({"session_id": "s1", "title": "First"}),
    )
    .await;
    assert_eq!(result["status"], "ok");
    assert_eq!(result["session_id"], "s1");
    assert_eq!(result["events"][0]["cached_input_tokens"], json!(900));
    assert_eq!(result["events"][0]["context_window"], json!(258400));
}

#[tokio::test]
async fn public_settings_route_exposes_active_profile_without_secrets() {
    let _state = crate::common::IsolatedTestState::new();
    let _home = NativeHome::new();
    let ctx = BridgeContext::new(
        Arc::new(FakeSettings::with_settings(BackendSettings::default())),
        Arc::new(FakeRuntime::default()),
        Arc::new(FakeData::default()),
    );

    let result = handle_bridge_request(ctx, "/settings/public", json!({})).await;

    assert_eq!(result["status"], "ok");
    assert_eq!(
        result["codexPlusVersion"],
        json!(codex_plus_core::version::VERSION)
    );
    assert_eq!(result["activeProfile"]["id"], "p1");
    assert_eq!(result["activeProfile"]["name"], "Relay");
    assert_eq!(result["activeProfile"]["model"], "deepseek-v4-pro");
    assert_eq!(result["activeProfile"]["contextWindow"], "1000000");
    assert_eq!(result["activeProfile"]["autoCompactLimit"], "900000");
    assert!(
        result["modelCatalogFingerprint"]
            .as_str()
            .is_some_and(|value| !value.is_empty())
    );
    // 地址、Key、config / auth 内容一概不给拓展。
    let text = result.to_string();
    assert!(!text.contains("secret"), "{text}");
    assert!(result.get("relayProfiles").is_none());
}

#[tokio::test]
async fn settings_payload_fingerprint_follows_model_catalog_fields() {
    let _state = crate::common::IsolatedTestState::new();
    let home = NativeHome::new();
    let read = |model_list: &str| {
        let ctx = BridgeContext::new(
            Arc::new(FakeSettings::with_settings({
                home.write_catalog(model_list);
                BackendSettings::default()
            })),
            Arc::new(FakeRuntime::default()),
            Arc::new(FakeData::default()),
        );
        async move { handle_bridge_request(ctx, "/settings/get", json!({})).await }
    };
    let first = read("deepseek-v4-pro[1M]").await;
    let same = read("deepseek-v4-pro[1M]").await;
    let changed = read("deepseek-v4-pro[1M]\ndeepseek-v4-flash").await;

    // 页面心跳比较这两项发 relayProfile/switched、modelCatalog/changed。
    assert_eq!(first["activeRelayProfilePublic"]["id"], "p1");
    assert!(first["activeRelayProfilePublic"].get("baseUrl").is_none());
    assert_eq!(
        first["modelCatalogFingerprint"],
        same["modelCatalogFingerprint"]
    );
    assert_ne!(
        first["modelCatalogFingerprint"],
        changed["modelCatalogFingerprint"]
    );
}

#[tokio::test]
async fn public_model_catalog_route_drops_sources_and_paths() {
    struct CatalogRuntime(FakeRuntime);
    #[async_trait]
    impl BridgeRuntimeService for CatalogRuntime {
        async fn user_script_inventory(&self) -> anyhow::Result<Value> {
            self.0.user_script_inventory().await
        }
        async fn set_user_script_enabled(
            &self,
            key: String,
            enabled: bool,
        ) -> anyhow::Result<Value> {
            self.0.set_user_script_enabled(key, enabled).await
        }
        async fn reload_user_scripts(&self) -> anyhow::Result<Value> {
            self.0.reload_user_scripts().await
        }
        async fn open_devtools(&self) -> anyhow::Result<Value> {
            self.0.open_devtools().await
        }
        async fn open_manager(&self, payload: Value) -> anyhow::Result<Value> {
            self.0.open_manager(payload).await
        }
        async fn backend_status(&self) -> anyhow::Result<Value> {
            self.0.backend_status().await
        }
        async fn codex_model_catalog(&self) -> anyhow::Result<Value> {
            Ok(json!({
                "status": "ok",
                "path": "/Users/someone/.codex/config.toml",
                "model": "deepseek-v4-pro",
                "default_model": "deepseek-v4-pro",
                "model_provider": "p1",
                "provider_name": "Relay",
                "service_tier": "",
                "models": ["deepseek-v4-pro"],
                "modelMetadata": {"deepseek-v4-pro": {"contextWindow": 1_000_000}},
                "sources": [{"base_url": "https://secret-relay.example/v1"}],
                "responses_api": {"status": "unknown"}
            }))
        }
    }
    let ctx = BridgeContext::new(
        Arc::new(FakeSettings::default()),
        Arc::new(CatalogRuntime(FakeRuntime::default())),
        Arc::new(FakeData::default()),
    );

    let result = handle_bridge_request(ctx, "/model-catalog/public", json!({})).await;

    assert_eq!(result["status"], "ok");
    assert_eq!(result["models"], json!(["deepseek-v4-pro"]));
    assert_eq!(
        result["modelMetadata"]["deepseek-v4-pro"]["contextWindow"],
        json!(1_000_000)
    );
    assert!(result.get("sources").is_none());
    assert!(result.get("path").is_none());
    assert!(result.get("responses_api").is_none());
    assert!(!result.to_string().contains("secret"));
}

#[tokio::test]
async fn llm_proxy_rejects_local_addresses() {
    let ctx = test_context();

    let result = handle_bridge_request(
        ctx,
        "/llm-proxy",
        json!({
            "url": "https://127.0.0.1/v1/chat/completions",
            "method": "POST",
            "headers": {"Authorization": "Bearer sk-test"},
            "body": "{}"
        }),
    )
    .await;

    assert_eq!(result["status"], json!("failed"));
    assert_eq!(result["message"], json!("Base URL 不得指向本机或私有网络"));
}

#[tokio::test]
async fn llm_proxy_requires_https() {
    let ctx = test_context();

    let result = handle_bridge_request(
        ctx,
        "/llm-proxy",
        json!({
            "url": "http://api.example.com/v1/chat/completions",
            "method": "POST",
            "body": "{}"
        }),
    )
    .await;

    assert_eq!(result["status"], json!("failed"));
    assert_eq!(result["message"], json!("Base URL 必须使用 HTTPS"));
}

#[tokio::test]
async fn llm_proxy_rejects_non_post_methods() {
    let ctx = test_context();

    let result = handle_bridge_request(
        ctx,
        "/llm-proxy",
        json!({
            "url": "https://api.example.com/v1/chat/completions",
            "method": "GET",
            "body": "{}"
        }),
    )
    .await;

    assert_eq!(result["status"], json!("failed"));
    assert_eq!(result["message"], json!("LLM Bridge 仅支持 POST 请求"));
}

fn enhancement_settings_catalog_file() -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("assets")
        .join("enhancement-settings.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

#[tokio::test]
async fn settings_catalog_route_returns_the_single_catalog_file() {
    // 注入页的设置行只从这条路由取文案；返回的必须就是管理器 import 的那份 JSON。
    let result = handle_bridge_request(test_context(), "/settings/catalog", json!({})).await;
    assert_eq!(result, enhancement_settings_catalog_file());
    assert!(
        result["items"]
            .as_array()
            .is_some_and(|items| !items.is_empty())
    );
}

#[test]
fn settings_catalog_items_map_to_real_backend_settings() {
    // 清单里的 key 就是 /settings/set 写入的字段：拼错或字段被删时这里先失败，
    // 不会等到用户在 Codex 里点了开关才发现没存上。
    let catalog = enhancement_settings_catalog_file();
    let defaults = serde_json::to_value(BackendSettings::default()).unwrap();
    let groups: Vec<&str> = catalog["groups"]
        .as_array()
        .unwrap()
        .iter()
        .map(|group| group["id"].as_str().unwrap())
        .collect();
    let mut keys = std::collections::HashSet::new();
    for item in catalog["items"].as_array().unwrap() {
        let key = item["key"].as_str().unwrap();
        assert!(keys.insert(key), "{key} 在清单里重复");
        assert!(
            groups.contains(&item["group"].as_str().unwrap()),
            "{key} 引用了不存在的分组"
        );
        let value = defaults
            .get(key)
            .unwrap_or_else(|| panic!("{key} 不是 BackendSettings 字段"));
        match item["control"].as_str().unwrap() {
            "bool" => assert!(value.is_boolean(), "{key} 应为布尔字段"),
            "model" | "account" => assert!(value.is_string(), "{key} 应为字符串"),
            "select" => {
                let options: Vec<&str> = item["options"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|option| option["value"].as_str().unwrap())
                    .collect();
                assert!(
                    options.contains(&value.as_str().unwrap()),
                    "{key} 的默认值不在选项里"
                );
            }
            other => panic!("{key} 使用了未知控件类型 {other}"),
        }
    }
}

#[tokio::test]
async fn settings_get_includes_runtime_codex_app_version() {
    let ctx = BridgeContext::new(
        Arc::new(FakeSettings::with_codex_app_version("26.601.21317")),
        Arc::new(FakeRuntime::default()),
        Arc::new(FakeData::default()),
    );

    let result = handle_bridge_request(ctx, "/settings/get", json!({})).await;

    assert_eq!(result["codexAppVersion"], json!("26.601.21317"));
    assert!(result.get("codexAppPluginMarketplaceUnlock").is_none());
    assert_eq!(result.get("codexAppForcePluginInstall"), None);
    assert_eq!(result["codexAppNativeProjectSections"], json!(false));
}

#[tokio::test]
async fn settings_set_notifies_external_settings_change_listener() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static NOTIFIED: AtomicUsize = AtomicUsize::new(0);
    codex_plus_core::settings::set_external_settings_change_listener(|| {
        NOTIFIED.fetch_add(1, Ordering::SeqCst);
    });
    let before = NOTIFIED.load(Ordering::SeqCst);

    let result = handle_bridge_request(
        test_context(),
        "/settings/set",
        json!({"codexAppNativeProjectSections": true}),
    )
    .await;

    assert_eq!(result["codexAppNativeProjectSections"], json!(true));
    // 同进程其它用例也可能写设置，只断言至少通知了一次。
    assert!(
        NOTIFIED.load(Ordering::SeqCst) > before,
        "Codex 写入设置后应通知管理器"
    );
}

#[tokio::test]
async fn settings_set_does_not_persist_runtime_codex_app_version() {
    let settings = Arc::new(FakeSettings::with_codex_app_version("26.601.21317"));
    let ctx = BridgeContext::new(
        settings.clone(),
        Arc::new(FakeRuntime::default()),
        Arc::new(FakeData::default()),
    );

    let result = handle_bridge_request(
        ctx,
        "/settings/set",
        json!({
            "codexAppVersion": "1.2.3",
            "codexAppPluginMarketplaceUnlock": false
        }),
    )
    .await;

    assert_eq!(result["codexAppVersion"], json!("26.601.21317"));
    assert!(result.get("codexAppPluginMarketplaceUnlock").is_none());

    let persisted = settings.settings.lock().unwrap().clone();
    let persisted_value = serde_json::to_value(persisted).unwrap();
    assert!(persisted_value.get("codexAppVersion").is_none());
}

#[tokio::test]
async fn bridge_context_core_with_app_dir_exposes_runtime_codex_app_version() {
    let temp = tempfile::tempdir().unwrap();
    let app_dir = temp
        .path()
        .join("OpenAI.Codex_26.601.21317.0_x64__abc")
        .join("app");
    std::fs::create_dir_all(&app_dir).unwrap();
    std::fs::write(app_dir.join("Codex.exe"), "").unwrap();
    let ctx = BridgeContext::core_with_data_and_app_dir(
        Arc::new(FakeRuntime::default()),
        Arc::new(FakeData::default()),
        app_dir,
    );

    let result = handle_bridge_request(ctx, "/settings/get", json!({})).await;

    assert_eq!(result["codexAppVersion"], json!("26.601.21317.0"));
}

#[tokio::test]
async fn unknown_bridge_path_preserves_empty_session_id_shape() {
    let result = handle_bridge_request(
        test_context(),
        "/missing",
        json!({"session_id": "should-not-leak"}),
    )
    .await;

    assert_eq!(
        result,
        json!({
            "status": "failed",
            "session_id": "",
            "message": "Unknown bridge path"
        })
    );
}

#[tokio::test]
async fn settings_routes_use_settings_service() {
    let _state = crate::common::IsolatedTestState::new();
    let home = NativeHome::new();
    std::fs::write(home.temp.path().join("config.toml"), "").unwrap();
    let ctx = test_context();

    let updated = handle_bridge_request(
        ctx.clone(),
        "/settings/set",
        json!({"codexAppNativeProjectSections": true, "codexAppNativeProjectSectionsLinkAccount": true, "codexAppNativeFastUnlock": true, "codexAppNativePredictions": true}),
    )
    .await;
    let loaded = handle_bridge_request(ctx, "/settings/get", json!({})).await;

    assert_eq!(updated["codexAppNativeProjectSections"], true);
    assert_eq!(updated["codexAppNativeFastUnlock"], true);
    assert!(updated.get("codexAppServiceTierControls").is_none());
    assert_eq!(updated["codexAppNativePredictions"], true);
    assert!(updated.get("codexAppNativeProjectSectionsLinkAccount").is_none());
    assert!(updated.get("nativeProjectSectionsAccounts").is_none());
    assert!(updated.get("nativeProjectSectionsLinkedAccountId").is_none());
    assert_eq!(loaded, updated);
}

#[tokio::test]
async fn runtime_routes_keep_builtin_extension_inventory_and_reload() {
    let ctx = test_context();

    let listed = handle_bridge_request(ctx.clone(), "/user-scripts/list", json!({})).await;
    let script = handle_bridge_request(
        ctx.clone(),
        "/user-scripts/set-script-enabled",
        json!({"key": "builtin:paste-fix", "enabled": false}),
    )
    .await;
    let loaded = handle_bridge_request(ctx.clone(), "/user-scripts/load", json!({})).await;
    let reloaded = handle_bridge_request(ctx, "/user-scripts/reload", json!({})).await;

    assert_eq!(listed["enabled"], true);
    assert_eq!(listed["scripts"][0]["key"], "builtin:paste-fix");
    assert_eq!(script["scripts"][0]["enabled"], false);
    assert_eq!(reloaded["reloaded"], true);
    assert_eq!(loaded["reloaded"], false);
    assert_eq!(reloaded["scripts"][0]["key"], "builtin:paste-fix");
}

#[tokio::test]
async fn runtime_status_devtools_repair_and_ads_routes_are_dispatched() {
    let _state = crate::common::IsolatedTestState::new();
    let home = NativeHome::new();
    std::fs::write(home.temp.path().join("config.toml"), "").unwrap();
    let runtime = Arc::new(FakeRuntime::default());
    let ctx = BridgeContext::new(
        Arc::new(FakeSettings::default()),
        runtime.clone(),
        Arc::new(FakeData::default()),
    );

    assert_eq!(
        handle_bridge_request(ctx.clone(), "/devtools/open", json!({})).await,
        json!({"status": "ok", "opened": true})
    );
    let manager_payload = json!({"page": "enhance"});
    assert_eq!(
        handle_bridge_request(ctx.clone(), "/manager/open", manager_payload.clone()).await,
        json!({"status": "ok", "opened": "manager"})
    );
    assert_eq!(*runtime.manager_payload.lock().unwrap(), manager_payload);

    let transient_payload = json!({"page": "settings"});
    assert_eq!(
        handle_bridge_request(
            ctx.clone(),
            "/manager/open-transient",
            transient_payload.clone(),
        )
        .await,
        json!({"status": "ok", "opened": "manager-transient"})
    );
    assert_eq!(*runtime.manager_payload.lock().unwrap(), transient_payload);
    assert_eq!(
        handle_bridge_request(ctx.clone(), "/backend/status", json!({})).await,
        json!({"status": "ok", "message": "后端已连接", "version": codex_plus_core::version::VERSION})
    );
}

#[tokio::test]
async fn data_routes_forward_payloads_to_data_service() {
    let ctx = test_context();

    assert_eq!(
        handle_bridge_request(
            ctx.clone(),
            "/thread-usage-history",
            json!({"session_id": "s1", "title": "First"}),
        )
        .await,
        json!({
            "status": "ok",
            "session_id": "s1",
            "history": [
                {
                    "source": "rollout-history",
                    "conversation_id": "local:s1",
                    "turn_id": "turn-1",
                    "observed_at": "2026-06-02T05:00:00Z",
                    "usage": {
                        "inputTokens": 1200,
                        "outputTokens": 120,
                        "totalTokens": 1320,
                        "cachedTokens": 900,
                        "cacheReadTokens": 0,
                        "cacheCreationTokens": 0,
                        "contextUsed": 1320,
                        "contextLimit": 258400,
                        "hasBreakdown": true
                    }
                }
            ]
        })
    );
    assert_eq!(
        handle_bridge_request(
            ctx.clone(),
            "/archived-thread",
            json!({"title": "Archived"})
        )
        .await,
        json!({"session_id": "archived-1", "title": "Archived"})
    );
}

#[tokio::test]
async fn user_script_manager_scans_and_persists_inventory_shape() {
    let temp = tempfile::tempdir().unwrap();
    let builtin_dir = temp.path().join("builtin");
    let user_dir = temp.path().join("user");
    std::fs::create_dir_all(&builtin_dir).unwrap();
    std::fs::write(builtin_dir.join("demo.js"), "window.demo = true;").unwrap();
    std::fs::create_dir_all(&user_dir).unwrap();
    std::fs::write(user_dir.join("a.js"), "window.a = true;").unwrap();
    std::fs::write(user_dir.join("ignore.txt"), "not js").unwrap();
    let manager = UserScriptManager::new(
        builtin_dir.clone(),
        user_dir.clone(),
        temp.path().join("user_scripts.json"),
    );

    let listed = manager.inventory().unwrap();
    manager.set_global_enabled(false).unwrap();
    let disabled = manager.inventory().unwrap();
    manager.set_script_enabled("user:a.js", false).unwrap();
    let script_disabled = manager.inventory().unwrap();
    manager.delete_user_script("user:a.js").unwrap();
    let deleted = manager.inventory().unwrap();

    assert_eq!(listed["enabled"], true);
    assert_eq!(
        listed["builtin_dir"].as_str().unwrap(),
        builtin_dir.to_string_lossy()
    );
    assert_eq!(
        listed["user_dir"].as_str().unwrap(),
        user_dir.to_string_lossy()
    );
    assert_eq!(listed["scripts"][0]["key"], "builtin:demo.js");
    assert_eq!(listed["scripts"][0]["source"], "builtin");
    assert_eq!(listed["scripts"][0]["enabled"], true);
    assert_eq!(listed["scripts"][0]["status"], "not_loaded");
    assert_eq!(listed["scripts"][0]["error"], "");
    assert_eq!(listed["scripts"][1]["key"], "user:a.js");
    assert_eq!(disabled["enabled"], false);
    assert_eq!(disabled["scripts"][0]["status"], "disabled");
    assert_eq!(script_disabled["scripts"][1]["enabled"], false);
    assert_eq!(deleted["scripts"].as_array().unwrap().len(), 1);
    assert!(!user_dir.join("a.js").exists());
    assert_eq!(
        serde_json::from_str::<Value>(
            &std::fs::read_to_string(temp.path().join("user_scripts.json")).unwrap()
        )
        .unwrap(),
        json!({"enabled": false, "scripts": {}})
    );
}

#[tokio::test]
async fn user_script_inventory_merges_renderer_runtime_status() {
    let temp = tempfile::tempdir().unwrap();
    let builtin_dir = temp.path().join("builtin");
    let user_dir = temp.path().join("user");
    std::fs::create_dir_all(&builtin_dir).unwrap();
    std::fs::create_dir_all(&user_dir).unwrap();
    std::fs::write(user_dir.join("loaded.js"), "window.loaded = true;").unwrap();
    std::fs::write(user_dir.join("failed.js"), "throw new Error('boom');").unwrap();
    let manager =
        UserScriptManager::new(builtin_dir, user_dir, temp.path().join("user_scripts.json"));
    let runtime_status = json!({
        "user:loaded.js": {"status": "loaded", "error": ""},
        "user:failed.js": {"status": "failed", "error": "boom"}
    });

    let inventory = manager
        .inventory_with_runtime_status(Some(&runtime_status))
        .unwrap();
    let scripts = inventory["scripts"].as_array().unwrap();
    let loaded = scripts
        .iter()
        .find(|script| script["key"] == "user:loaded.js")
        .unwrap();
    let failed = scripts
        .iter()
        .find(|script| script["key"] == "user:failed.js")
        .unwrap();

    assert_eq!(loaded["status"], "loaded");
    assert_eq!(loaded["error"], "");
    assert_eq!(failed["status"], "failed");
    assert_eq!(failed["error"], "boom");
}

#[tokio::test]
async fn user_script_manager_deletes_user_script_and_rejects_builtin_delete() {
    let temp = tempfile::tempdir().unwrap();
    let builtin_dir = temp.path().join("builtin");
    let user_dir = temp.path().join("user");
    std::fs::create_dir_all(&builtin_dir).unwrap();
    std::fs::write(builtin_dir.join("demo.js"), "window.demo = true;").unwrap();
    std::fs::create_dir_all(&user_dir).unwrap();
    std::fs::write(user_dir.join("demo.js"), "window.demo = true;").unwrap();
    let manager = UserScriptManager::new(
        builtin_dir,
        user_dir.clone(),
        temp.path().join("user_scripts.json"),
    );
    manager.set_script_enabled("user:demo.js", false).unwrap();

    let error = manager.delete_user_script("builtin:demo.js").unwrap_err();
    assert!(error.to_string().contains("only user scripts"));
    manager.delete_user_script("user:demo.js").unwrap();

    assert!(!user_dir.join("demo.js").exists());
    let saved = serde_json::from_str::<Value>(
        &std::fs::read_to_string(temp.path().join("user_scripts.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(saved["scripts"], json!({}));
}
#[tokio::test]
async fn core_runtime_reload_evaluates_enabled_user_bundle_and_status_is_ok() {
    let _state = crate::common::IsolatedTestState::new();
    let home = NativeHome::new();
    std::fs::write(home.temp.path().join("config.toml"), "").unwrap();
    let temp = tempfile::tempdir().unwrap();
    let builtin_dir = temp.path().join("builtin");
    std::fs::create_dir_all(&builtin_dir).unwrap();
    std::fs::write(builtin_dir.join("demo.js"), "window.demo = true;").unwrap();
    let manager = UserScriptManager::new(
        builtin_dir,
        temp.path().join("user"),
        temp.path().join("user_scripts.json"),
    );
    let evaluated = Arc::new(Mutex::new(Vec::<String>::new()));
    let runtime = CoreRuntimeService::new(9229, StatusStore::default())
        .with_user_scripts(manager)
        .with_user_script_evaluator({
            let evaluated = evaluated.clone();
            Arc::new(move |websocket_url, script| {
                evaluated
                    .lock()
                    .unwrap()
                    .push(format!("{websocket_url}:{script}"));
                Ok(json!({"status": "ok"}))
            })
        })
        .with_websocket_url("ws://page");
    let ctx = BridgeContext::new(
        Arc::new(FakeSettings::default()),
        Arc::new(runtime),
        Arc::new(FakeData::default()),
    );

    let status = handle_bridge_request(ctx.clone(), "/backend/status", json!({})).await;
    let loaded = handle_bridge_request(ctx.clone(), "/user-scripts/load", json!({})).await;
    let reloaded = handle_bridge_request(ctx, "/user-scripts/reload", json!({})).await;

    assert_eq!(
        status,
        json!({"status": "ok", "message": "后端已连接", "version": codex_plus_core::version::VERSION})
    );
    assert_eq!(reloaded["scripts"][0]["key"], "builtin:demo.js");
    assert_eq!(loaded["scripts"][0]["key"], "builtin:demo.js");
    let evaluated = evaluated.lock().unwrap();
    assert_eq!(evaluated.len(), 2);
    assert!(evaluated[0].starts_with("ws://page:"));
    assert!(evaluated[0].contains("window.demo = true;"));
    assert!(!evaluated[0].contains(".prepareReload();"));
    assert!(evaluated[1].contains(".prepareReload();"));
}

#[tokio::test]
async fn core_runtime_open_devtools_uses_inspector_url_opener() {
    let opened = Arc::new(Mutex::new(Vec::<String>::new()));
    let runtime = CoreRuntimeService::new(9229, StatusStore::default())
        .with_devtools_opener({
            let opened = opened.clone();
            Arc::new(move |url| {
                opened.lock().unwrap().push(url.to_string());
                Ok(())
            })
        })
        .with_devtools_target_id("page-1");
    let ctx = BridgeContext::core_with_data(Arc::new(runtime), Arc::new(FakeData::default()));

    let result = handle_bridge_request(ctx, "/devtools/open", json!({})).await;

    assert_eq!(result["status"], "ok");
    assert_eq!(result["target_id"], "page-1");
    assert_eq!(
        opened.lock().unwrap().as_slice(),
        ["http://127.0.0.1:9229/devtools/inspector.html?ws=127.0.0.1:9229/devtools/page/page-1"]
    );
}

#[tokio::test]
async fn core_runtime_manager_route_attempts_to_open_manager_binary() {
    let ctx = BridgeContext::core(Arc::new(CoreRuntimeService::new(
        9229,
        StatusStore::default(),
    )));

    let result = handle_bridge_request(ctx, "/manager/open", json!({})).await;

    assert_ne!(result["message"], "管理工具启动未接入当前运行时");
}

#[tokio::test]
async fn bridge_backend_status_writes_diagnostic_log() {
    // 诊断日志路径是进程级状态，与其它测试模块串行。
    let _state = crate::common::global_state_lock();
    let temp = tempfile::tempdir().unwrap();
    let log_path = temp.path().join("codex-plus.log");
    codex_plus_core::diagnostic_log::set_diagnostic_log_path_for_tests(Some(log_path.clone()));
    let ctx = BridgeContext::core(Arc::new(CoreRuntimeService::new(
        9229,
        StatusStore::default(),
    )));

    let result = handle_bridge_request(ctx, "/backend/status", json!({})).await;

    assert_eq!(result["status"], "ok");
    let contents = std::fs::read_to_string(&log_path).unwrap();
    assert!(contents.contains("bridge.request"));
    assert!(contents.contains("bridge.backend_status_ok"));
    assert!(contents.contains("/backend/status"));
    codex_plus_core::diagnostic_log::set_diagnostic_log_path_for_tests(None);
}

#[test]
fn user_script_manager_tolerates_bad_config_fields_and_updates_atomically() {
    let temp = tempfile::tempdir().unwrap();
    let config_path = temp.path().join("user_scripts.json");
    std::fs::write(
        &config_path,
        r#"{"enabled":"not bool","scripts":{"user:a.js":false,"user:b.js":"bad"},"custom":true}"#,
    )
    .unwrap();
    let manager = UserScriptManager::new(
        temp.path().join("builtin"),
        temp.path().join("user"),
        config_path.clone(),
    );

    assert_eq!(manager.load_config().enabled, true);
    assert_eq!(manager.load_config().scripts.get("user:a.js"), Some(&false));
    assert!(!manager.load_config().scripts.contains_key("user:b.js"));

    manager.set_script_enabled("user:c.js", false).unwrap();
    let saved = serde_json::from_str::<Value>(&std::fs::read_to_string(config_path).unwrap())
        .expect("config should remain valid JSON");

    assert_eq!(saved["enabled"], true);
    assert_eq!(saved["scripts"]["user:a.js"], false);
    assert_eq!(saved["scripts"]["user:c.js"], false);
}


#[tokio::test]
async fn launch_lifecycle_uses_hook_supplied_bridge_context_for_injection() {
    let _state = crate::common::IsolatedTestState::new();
    let temp = tempfile::tempdir().unwrap();
    let debug_listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let debug_port = debug_listener.local_addr().unwrap().port();
    let app_dir = temp.path().join("Codex.app");
    std::fs::create_dir_all(&app_dir).unwrap();
    let events = Arc::new(Mutex::new(Vec::<String>::new()));
    let hooks = ContextHooks {
        directory: Arc::new(tempfile::tempdir().unwrap()),
        events: events.clone(),
    };

    launch_and_inject_with_hooks(
        LaunchOptions {
            app_dir: Some(app_dir),
            debug_port,
            status_store: StatusStore::new(temp.path().join("latest-status.json")),
            ..Default::default()
        },
        &hooks,
    )
    .await
    .unwrap();

    assert_eq!(
        *events.lock().unwrap(),
        vec![
            format!("bridge-context:{debug_port}"),
            format!("inject-bridge:{debug_port}"),
            format!("sanitize-local-storage:{debug_port}"),
            format!("watchdog:{debug_port}"),
            "status:running".to_string(),
        ]
    );
    debug_listener.set_nonblocking(true).unwrap();
    assert_eq!(
        debug_listener.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
}

fn test_context() -> BridgeContext {
    BridgeContext::new(
        Arc::new(FakeSettings::default()),
        Arc::new(FakeRuntime::default()),
        Arc::new(FakeData::default()),
    )
}

struct FakeSettings {
    settings: Mutex<BackendSettings>,
    codex_app_version: Mutex<String>,
}

impl Default for FakeSettings {
    fn default() -> Self {
        Self {
            settings: Mutex::new(BackendSettings::default()),
            codex_app_version: Mutex::new(String::new()),
        }
    }
}

impl FakeSettings {
    fn with_settings(settings: BackendSettings) -> Self {
        Self {
            settings: Mutex::new(settings),
            ..Self::default()
        }
    }

    fn with_codex_app_version(version: &str) -> Self {
        Self {
            codex_app_version: Mutex::new(version.to_string()),
            ..Self::default()
        }
    }
}

#[async_trait]
impl BridgeSettingsService for FakeSettings {
    async fn get_settings(&self) -> anyhow::Result<BackendSettings> {
        Ok(self.settings.lock().unwrap().clone())
    }

    async fn set_settings(&self, payload: Value) -> anyhow::Result<BackendSettings> {
        let current = self.settings.lock().unwrap().clone();
        let mut raw = serde_json::to_value(current).unwrap();
        let raw = raw.as_object_mut().unwrap();
        if let Some(value) = payload
            .get("codexAppNativeProjectSections")
            .and_then(Value::as_bool)
        {
            raw.insert("codexAppNativeProjectSections".to_string(), json!(value));
        }
        if let Some(value) = payload.get("enhancementsEnabled").and_then(Value::as_bool) {
            raw.insert("enhancementsEnabled".to_string(), json!(value));
        }
        for key in [
            "codexAppMarkdownExport",
            "codexAppNativeProjectSections",
            "codexAppConversationView",
            "codexAppThreadScrollRestore",
            "codexAppNativeMenuPlacement",
            "codexAppNativeFastUnlock",
            "codexAppNativePredictions",
        ] {
            if let Some(value) = payload.get(key).and_then(Value::as_bool) {
                raw.insert(key.to_string(), json!(value));
            }
        }
        if let Some(value) = payload.get("relayBaseUrl").and_then(Value::as_str) {
            raw.insert("relayBaseUrl".to_string(), json!(value));
        }
        if let Some(value) = payload.get("relayApiKey").and_then(Value::as_str) {
            raw.insert("relayApiKey".to_string(), json!(value));
        }
        let updated: BackendSettings = serde_json::from_value(Value::Object(raw.clone())).unwrap();
        *self.settings.lock().unwrap() = updated.clone();
        Ok(updated)
    }

    async fn codex_app_version(&self) -> anyhow::Result<String> {
        Ok(self.codex_app_version.lock().unwrap().clone())
    }
}

struct FakeRuntime {
    script_enabled: Mutex<bool>,
    manager_payload: Mutex<Value>,
}

impl Default for FakeRuntime {
    fn default() -> Self {
        Self {
            script_enabled: Mutex::new(true),
            manager_payload: Mutex::new(json!({})),
        }
    }
}

#[async_trait]
impl BridgeRuntimeService for FakeRuntime {
    async fn user_script_inventory(&self) -> anyhow::Result<Value> {
        Ok(self.inventory(false))
    }

    async fn set_user_script_enabled(&self, key: String, enabled: bool) -> anyhow::Result<Value> {
        assert_eq!(key, "builtin:paste-fix");
        *self.script_enabled.lock().unwrap() = enabled;
        Ok(self.inventory(false))
    }

    async fn reload_user_scripts(&self) -> anyhow::Result<Value> {
        Ok(self.inventory(true))
    }

    async fn open_devtools(&self) -> anyhow::Result<Value> {
        Ok(json!({"status": "ok", "opened": true}))
    }

    async fn open_manager(&self, payload: Value) -> anyhow::Result<Value> {
        *self.manager_payload.lock().unwrap() = payload;
        Ok(json!({"status": "ok", "opened": "manager"}))
    }

    async fn open_transient_manager(&self, payload: Value) -> anyhow::Result<Value> {
        *self.manager_payload.lock().unwrap() = payload;
        Ok(json!({"status": "ok", "opened": "manager-transient"}))
    }

    async fn backend_status(&self) -> anyhow::Result<Value> {
        Ok(
            json!({"status": "ok", "message": "后端已连接", "version": codex_plus_core::version::VERSION}),
        )
    }

    async fn codex_model_catalog(&self) -> anyhow::Result<Value> {
        Ok(json!({
            "status": "ok",
            "model": "qwen3-coder",
            "default_model": "qwen3-coder",
            "model_provider": "relay",
            "provider_name": "Relay",
            "models": ["qwen3-coder"],
            "sources": []
        }))
    }
}

impl FakeRuntime {
    fn inventory(&self, reloaded: bool) -> Value {
        json!({
            "enabled": true,
            "reloaded": reloaded,
            "scripts": [
                {"key": "builtin:paste-fix", "name": "Codex Pilot 内置拓展", "enabled": *self.script_enabled.lock().unwrap()}
            ]
        })
    }
}

struct FakeData;

impl Default for FakeData {
    fn default() -> Self {
        Self
    }
}

#[async_trait]
impl BridgeDataService for FakeData {
    async fn thread_usage_live(&self, session: SessionRef) -> anyhow::Result<Value> {
        Ok(json!({
            "status": "ok",
            "session_id": session.session_id,
            "events": [
                {
                    "t": "2026-06-02T05:00:00Z",
                    "input_tokens": 1200,
                    "cached_input_tokens": 900,
                    "output_tokens": 120,
                    "reasoning_output_tokens": 40,
                    "total_tokens": 1320,
                    "context_window": 258400,
                    "turn_output_tokens": 120
                }
            ]
        }))
    }

    async fn thread_usage_history(&self, session: SessionRef) -> anyhow::Result<Value> {
        Ok(json!({
            "status": "ok",
            "session_id": session.session_id,
            "history": [
                {
                    "source": "rollout-history",
                    "conversation_id": "local:s1",
                    "turn_id": "turn-1",
                    "observed_at": "2026-06-02T05:00:00Z",
                    "usage": {
                        "inputTokens": 1200,
                        "outputTokens": 120,
                        "totalTokens": 1320,
                        "cachedTokens": 900,
                        "cacheReadTokens": 0,
                        "cacheCreationTokens": 0,
                        "contextUsed": 1320,
                        "contextLimit": 258400,
                        "hasBreakdown": true
                    }
                }
            ]
        }))
    }

    async fn find_archived_thread_by_title(
        &self,
        title: String,
    ) -> anyhow::Result<Option<SessionRef>> {
        Ok(Some(SessionRef {
            session_id: "archived-1".to_string(),
            title,
            host_id: None,
        }))
    }
}

#[derive(Clone)]
struct ContextHooks {
    directory: Arc<tempfile::TempDir>,
    events: Arc<Mutex<Vec<String>>>,
}

impl ContextHooks {
    fn event(&self, event: impl Into<String>) {
        self.events.lock().unwrap().push(event.into());
    }
}

#[async_trait(?Send)]
impl LaunchHooks for ContextHooks {
    fn codex_home_dir(&self) -> std::path::PathBuf {
        self.directory.path().to_path_buf()
    }

    fn state_dir(&self) -> std::path::PathBuf {
        self.directory.path().join("state")
    }

    async fn sanitize_local_storage_model_suffixes(&self, debug_port: u16) {
        self.event(format!("sanitize-local-storage:{debug_port}"));
    }

    fn resolve_app_dir(
        &self,
        app_dir: Option<&std::path::Path>,
        _settings: &BackendSettings,
    ) -> anyhow::Result<std::path::PathBuf> {
        app_dir
            .map(std::path::Path::to_path_buf)
            .ok_or_else(|| anyhow::anyhow!("missing app dir"))
    }

    fn select_debug_port(&self, requested: u16) -> u16 {
        requested
    }

    async fn load_settings(&self) -> anyhow::Result<BackendSettings> {
        Ok(BackendSettings::default())
    }

    async fn launch_codex(
        &self,
        _app_dir: &std::path::Path,
        _debug_port: u16,
        _settings: &BackendSettings,
        _extra_args: &[String],
        _instance: &codex_plus_core::launcher::LaunchInstance,
    ) -> anyhow::Result<CodexLaunch> {
        Ok(CodexLaunch::Process {
            command: vec!["codex".to_string()],
            wait_strategy: ProcessWaitStrategy::TrackedChild,
            macos_cleanup_policy: None,
        })
    }

    async fn bridge_context(
        &self,
        debug_port: u16,
        _app_dir: &std::path::Path,
    ) -> anyhow::Result<Option<BridgeContext>> {
        self.event(format!("bridge-context:{debug_port}"));
        Ok(Some(test_context()))
    }

    async fn inject(&self, _debug_port: u16) -> anyhow::Result<()> {
        anyhow::bail!("legacy inject should not run when bridge context is supplied")
    }

    async fn inject_bridge(&self, debug_port: u16, _ctx: BridgeContext) -> anyhow::Result<()> {
        self.event(format!("inject-bridge:{debug_port}"));
        Ok(())
    }

    async fn start_bridge_watchdog(&self, debug_port: u16) -> anyhow::Result<()> {
        self.event(format!("watchdog:{debug_port}"));
        Ok(())
    }

    async fn write_status(&self, status: &str) {
        self.event(format!("status:{status}"));
    }

    async fn wait_for_codex_exit(
        &self,
        _launch: &CodexLaunch,
        _debug_port: u16,
    ) -> anyhow::Result<()> {
        Ok(())
    }

    async fn stop_bridge_watchdog(&self) {}

    async fn terminate_codex(&self, _launch: &CodexLaunch) {}
}

#[tokio::test]
async fn retired_feature_routes_are_unavailable() {
    let ctx = test_context();
    for path in [
        "/dictation/status",
        "/dictation/transcribe",
        "/dictation/cancel",
        "/stepwise/settings",
        "/stepwise/generate",
        "/stepwise/test",
        "/ads",
        "/plugin-market/list",
        "/plugin-market/install",
        "/plugin-market/install-status",
        "/plugin-market/native",
        "/zed-remote/status",
        "/zed-remote/resolve-host",
        "/zed-remote/fallback-request",
        "/zed-remote/open",
        "/zed-remote/projects",
        "/zed-remote/remember-project",
        "/zed-remote/forget-project",
        "/upstream-worktree/status",
        "/upstream-worktree/defaults",
        "/upstream-worktree/prepare",
        "/upstream-worktree/create",
    ] {
        let result = handle_bridge_request(ctx.clone(), path, json!({})).await;
        assert_eq!(result["status"], "failed", "{path}");
        assert!(
            result["message"]
                .as_str()
                .unwrap()
                .contains("Unknown bridge path"),
            "{path}: {result}"
        );
    }
}

struct NativeHome {
    temp: tempfile::TempDir,
    previous: Option<std::ffi::OsString>,
}
impl NativeHome {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(
            temp.path().join("config.toml"),
            r#"model = "deepseek-v4-pro"
model_provider = "p1"
model_context_window = 1000000
model_auto_compact_token_limit = 900000
model_catalog_json = "catalog.json"
[model_providers.p1]
name = "Relay"
base_url = "https://secret-relay.example/v1"
experimental_bearer_token = "sk-secret-key"
"#,
        )
        .unwrap();
        let previous = std::env::var_os("CODEX_HOME");
        unsafe {
            std::env::set_var("CODEX_HOME", temp.path());
        }
        let fixture = Self { temp, previous };
        fixture.write_catalog("deepseek-v4-pro[1M]");
        fixture
    }
    fn write_catalog(&self, list: &str) {
        let models: Vec<_> = list.lines().map(|id| json!({"slug":id})).collect();
        std::fs::write(
            self.temp.path().join("catalog.json"),
            json!({"models":models}).to_string(),
        )
        .unwrap();
    }
}
impl Drop for NativeHome {
    fn drop(&mut self) {
        unsafe {
            match self.previous.take() {
                Some(value) => std::env::set_var("CODEX_HOME", value),
                None => std::env::remove_var("CODEX_HOME"),
            }
        }
    }
}

#[tokio::test]
async fn retired_chat_feature_routes_are_unavailable() {
    let ctx = test_context();
    // 旧页面和旧配置也不能再调用退役的会话写入能力。
    for path in [
        "/delete",
        "/undo",
        "/export-markdown",
        "/side-chat/source",
        "/side-chat/save",
        "/answer-outline/settings",
    ] {
        let result = handle_bridge_request(
            ctx.clone(),
            path,
            json!({"session_id": "s1", "host_id": "local"}),
        )
        .await;
        assert_eq!(result["message"], "Unknown bridge path", "{path}");
    }
}
