use codex_plus_core::{
    assets,
    settings::{BackendSettings, SettingsStore},
};

#[test]
fn retired_features_pass_injection_regressions() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    // 复用独立的注入回归；管理器测试由 ui_issue_regressions 统一执行，避免重复。
    let output = std::process::Command::new("node")
        .arg("--test")
        .arg("assets/inject/retired-features.test.cjs")
        .current_dir(root)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "renderer regressions failed\n{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn retained_settings_roundtrip_without_weixin_or_skin_fields_and_runtime() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("settings.json");
    let store = SettingsStore::new(path.clone());
    let mut settings = BackendSettings::default();
    settings.codex_app_native_project_sections = true;
    store.save(&settings).unwrap();
    let loaded = store.load().unwrap();
    assert!(loaded.codex_app_native_project_sections);
    let persisted = std::fs::read_to_string(&path).unwrap().to_lowercase();
    assert!(!persisted.contains("weixin"));
    assert!(!persisted.contains("dreamskin"));
    let script = assets::renderer_script().to_lowercase();
    assert!(!script.contains("weixin"));
    assert!(!script.contains("dreamskin"));
    assert!(!script.contains("dream-skin"));
    assert!(script.contains("codexappnativeprojectsections"));
}

#[test]
fn settings_save_and_patch_discard_retired_fields_without_changing_retained_values() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("settings.json");
    let store = SettingsStore::new(path.clone());
    let legacy = serde_json::json!({
        "codexAppSessionDelete": true,
        "codexAppSessionDeleteSkipConfirm": true,
        "codexAppSideChatSave": true,
        "codexAppTurnRewind": true,
        "codexAppDisableWorkView": true,
        "codexAppMarkdownExport": true,
        "codexAppPasteFix": true,
        "codexAppForceChineseLocale": true,
        "codexAppCapacityAutoRetry": true,
        "codexAppThreadIdBadge": true,
        "codexAppConversationView": true,
        "codexAppThreadScrollRestore": true,
        "codexAppAnswerOutlineEnabled": true,
        "codexAppPetRealMouseLook": true,
        "codexAppActivityOverlayRight": true,
        "codexAppStandaloneQuotaUnlock": true,
        "tray_panel": false,
        "lightweight_on_close": true,
        "trayPanel": false,
        "lightweightOnClose": true,
        "weixinConnectEnabled": true,
        "weixinConnectToken": "retired-test-token",
        "codexAppDreamSkinThemeConfig": { "background": "retired" },
        "managerMode": "gateway",
        "relayProfiles": [{ "id": "retired" }],
        "computerUseEnabled": true,
        "sessionAutoRepairEnabled": true,
        "codexAppNativeProjectSections": true,
        "codexExtraArgs": ["--force_high_performance_gpu"],
        "codexAppPluginMarketplaceUnlock": true,
        "codexAppModelWhitelistUnlock": true,
        "relayContextConfigContents": "[mcp_servers.retired]\ncommand = 'npx'\n",
        "relayCommonConfigContents": "[skills.retired]\nenabled = true\n",
        "dictation": { "enabled": true, "apiKey": "retired-test-key" },
        "codexAppStepwiseEnabled": true, "codexAppStepwiseApiKey": "retired-test-key",
        "codexAppNativeProjectSectionsLinkAccount": true,
        "codexAppNativeProjectSectionsAccountId": "local-account-id"
    });
    let retired: Vec<_> = legacy
        .as_object()
        .unwrap()
        .keys()
        .filter(|key| key.as_str() != "codexAppNativeProjectSections")
        .cloned()
        .collect();
    for patch in [false, true] {
        std::fs::write(&path, serde_json::to_vec(&legacy).unwrap()).unwrap();
        if patch {
            // 即使补丁再次传来退役开关，也不能恢复可配置行为。
            store
                .update(serde_json::json!({
                    "tray_panel": false, "lightweight_on_close": true,
                    "codexExtraArgs": ["--force_high_performance_gpu"],
                    "codexAppPluginMarketplaceUnlock": true,
                    "codexAppModelWhitelistUnlock": true,
                    "relayContextConfigContents": "[mcp_servers.retired]\ncommand = 'npx'\n",
                    "relayCommonConfigContents": "[skills.retired]\nenabled = true\n",
                    "codexAppPetRealMouseLook": true,
                    "codexAppActivityOverlayRight": true,
                    "codexAppStandaloneQuotaUnlock": true,
                    "codexAppSessionDelete": true,
                    "codexAppSessionDeleteSkipConfirm": true,
                    "codexAppSideChatSave": true,
                    "codexAppTurnRewind": true,
                    "codexAppDisableWorkView": true,
                    "codexAppMarkdownExport": true,
                    "codexAppPasteFix": true,
                    "codexAppForceChineseLocale": true,
                    "codexAppCapacityAutoRetry": true,
                    "codexAppThreadIdBadge": true,
                    "codexAppConversationView": true,
                    "codexAppThreadScrollRestore": true,
                    "codexAppAnswerOutlineEnabled": true,
                    "codexAppNativeProjectSections": true,
                    "codexAppNativeProjectSectionsLinkAccount": true,
                    "codexAppNativeProjectSectionsAccountId": "local-account-id"
                }))
                .unwrap();
        } else {
            let loaded = store.load().unwrap();
            store.save(&loaded).unwrap();
        }
        let saved: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        for key in &retired {
            assert!(saved.get(key).is_none(), "retired field persisted: {key}");
        }
        assert_eq!(saved["codexAppNativeProjectSections"], true);
        assert!(saved.get("revision").is_none());
    }
}
