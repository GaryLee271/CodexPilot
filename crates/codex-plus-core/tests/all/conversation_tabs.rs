use codex_plus_core::settings::{BackendSettings, SettingsStore};

#[test]
fn conversation_tabs_default_off_and_partial_updates_preserve_the_switch() {
    let root = tempfile::tempdir().unwrap();
    let store = SettingsStore::new(root.path().join("settings.json"));
    assert!(!BackendSettings::default().codex_app_conversation_tabs);
    store
        .update(serde_json::json!({"codexAppConversationTabs": true}))
        .unwrap();
    // 两侧设置页都会发送部分更新，非法值和其它开关不能覆盖标签栏选项。
    store
        .update(serde_json::json!({"codexAppConversationTabs": "false", "codexAppNativeProjectSections": true}))
        .unwrap();
    let saved = store.load().unwrap();
    assert!(saved.codex_app_conversation_tabs);
    assert!(saved.codex_app_native_project_sections);
    store
        .update(serde_json::json!({"codexAppConversationTabs": false}))
        .unwrap();
    assert!(!store.load().unwrap().codex_app_conversation_tabs);
}

#[test]
fn conversation_tabs_renderer_interactions_and_lifecycle_pass() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let output = std::process::Command::new("node")
        .args(["--test", "assets/inject/conversation-tabs.test.cjs"])
        .current_dir(root)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
