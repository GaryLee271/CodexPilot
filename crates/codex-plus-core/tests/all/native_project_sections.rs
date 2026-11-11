use codex_plus_core::settings::{BackendSettings, SettingsStore};
use std::process::Command;

#[test]
fn native_project_sections_defaults_off_and_persists_opt_in() {
    let dir = tempfile::tempdir().unwrap();
    let store = SettingsStore::new(dir.path().join("settings.json"));
    assert!(!BackendSettings::default().codex_app_native_project_sections);
    assert!(!store.load().unwrap().codex_app_native_project_sections);
    store
        .update(serde_json::json!({ "codexAppNativeProjectSections": true }))
        .unwrap();
    assert!(store.load().unwrap().codex_app_native_project_sections);
    // 其它设置的部分更新不能覆盖已选分区策略；非法类型也不能变相关闭开关。
    store
        .update(serde_json::json!({ "codexAppNativeProjectSections": "false", "codexAppNativePredictions": true }))
        .unwrap();
    let persisted = store.load().unwrap();
    assert!(persisted.codex_app_native_project_sections);
    assert!(persisted.codex_app_native_predictions);
    store
        .update(serde_json::json!({ "codexAppNativeProjectSections": false }))
        .unwrap();
    assert!(!store.load().unwrap().codex_app_native_project_sections);
}

#[test]
fn native_project_sections_rewriter_and_local_storage_policy_pass_renderer_tests() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../assets/inject/native-project-sections.test.cjs");
    let output = Command::new("node")
        .arg("--test")
        .arg(path)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn retired_account_link_settings_are_ignored_and_removed_on_save_or_patch() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.json");
    let legacy = serde_json::json!({
        "codexAppNativeProjectSections": true,
        "codexAppNativeProjectSectionsLinkAccount": true,
        "codexAppNativeProjectSectionsAccountId": "account-a",
    });
    std::fs::write(&path, legacy.to_string()).unwrap();
    let store = SettingsStore::new(path.clone());
    let loaded = store.load().unwrap();
    assert!(loaded.codex_app_native_project_sections);
    // 旧关联字段不参与运行，正常保存时随已退役字段一起丢弃，不迁移账号分区数据。
    let serialized = serde_json::to_value(&loaded).unwrap();
    for key in [
        "codexAppNativeProjectSectionsLinkAccount",
        "codexAppNativeProjectSectionsAccountId",
    ] {
        assert!(serialized.get(key).is_none());
    }
    store.save(&loaded).unwrap();
    store.update(legacy).unwrap();
    let saved: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(saved["codexAppNativeProjectSections"], true);
    assert!(
        saved
            .get("codexAppNativeProjectSectionsLinkAccount")
            .is_none()
    );
    assert!(saved.get("codexAppNativeProjectSectionsAccountId").is_none());
}
