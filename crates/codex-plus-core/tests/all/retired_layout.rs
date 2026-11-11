use codex_plus_core::settings::{BackendSettings, SettingsStore};
use serde_json::json;

#[test]
fn retired_layout_flag_is_ignored_without_affecting_other_enhancements() {
    let settings: BackendSettings = serde_json::from_value(json!({
        "codexAppCustomLayoutEnabled": true,
        "enhancementsEnabled": true,
        "codexAppNativePredictions": true,
        "codexAppWhaleWidgetEnabled": true,
        "codexAppTypingEffect": "stars",
        "codexAppNativeProjectSections": true,
        "codexAppSessionShare": false,
    }))
    .unwrap();
    assert!(settings.codex_app_native_predictions);
    // 旧用量挂件开关直接丢弃，不迁移为宠物开关。
    assert!(
        serde_json::to_value(&settings)
            .unwrap()
            .get("agentPet")
            .is_none()
    );
    assert!(settings.codex_app_native_project_sections);
    let serialized = serde_json::to_value(settings).unwrap();
    // 会话分享已下线（后端早已没有 /share/create），旧开关读入后丢弃。
    assert!(serialized.get("codexAppSessionShare").is_none());
    assert!(serialized.get("codexAppCustomLayoutEnabled").is_none());
    assert_eq!(serialized["codexAppNativePredictions"], true);
    assert!(serialized.get("codexAppWhaleWidgetEnabled").is_none());
    assert!(serialized.get("codexAppTypingEffect").is_none());
}

#[test]
fn saving_old_settings_and_partial_updates_never_reintroduce_the_retired_flag() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("settings.json");
    std::fs::write(
        &path,
        serde_json::to_vec(&json!({
            "codexAppCustomLayoutEnabled": true,
            "codexAppNativePredictions": true,
            "codexAppWhaleWidgetEnabled": true,
            "codexAppTypingEffect": "stars",
            "codexAppNativeProjectSections": true,
            "codexAppSessionShare": true,
        }))
        .unwrap(),
    )
    .unwrap();
    let store = SettingsStore::new(path.clone());
    let loaded = store.load().unwrap();
    assert!(
        serde_json::to_value(&loaded)
            .unwrap()
            .get("agentPet")
            .is_none()
    );
    store.save(&loaded).unwrap();
    let saved: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert!(saved.get("codexAppCustomLayoutEnabled").is_none());
    assert!(saved.get("codexAppSessionShare").is_none());
    assert!(saved.get("codexAppWhaleWidgetEnabled").is_none());
    assert!(saved.get("agentPet").is_none());
    let updated = store
        .update(json!({
            "codexAppCustomLayoutEnabled": true,
            "codexAppTypingEffect": "rainbow",
            "codexAppNativeProjectSections": false,
        }))
        .unwrap();
    assert!(updated.codex_app_native_predictions);
    assert!(
        serde_json::to_value(&updated)
            .unwrap()
            .get("agentPet")
            .is_none()
    );
    assert!(!updated.codex_app_native_project_sections);
    assert_eq!(store.load().unwrap(), updated);
    let saved: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert!(saved.get("codexAppCustomLayoutEnabled").is_none());
    assert_eq!(saved["codexAppNativePredictions"], true);
    assert!(saved.get("codexAppWhaleWidgetEnabled").is_none());
    assert!(saved.get("agentPet").is_none());
    assert!(saved.get("codexAppTypingEffect").is_none());
}
