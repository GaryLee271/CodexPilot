use codex_plus_core::settings::{BackendSettings, SettingsStore};

#[test]
fn conversation_list_switch_is_independent_from_tabs() {
    let root = tempfile::tempdir().unwrap();
    let store = SettingsStore::new(root.path().join("settings.json"));
    assert!(!BackendSettings::default().codex_app_conversation_list);
    store
        .update(serde_json::json!({"codexAppConversationList": true}))
        .unwrap();
    // 两侧设置页都发部分更新：非法值与另一个开关都不能覆盖列表选项。
    store
        .update(serde_json::json!({"codexAppConversationList": "false", "codexAppConversationTabs": true}))
        .unwrap();
    let saved = store.load().unwrap();
    assert!(saved.codex_app_conversation_list);
    assert!(saved.codex_app_conversation_tabs);
    store
        .update(serde_json::json!({"codexAppConversationList": false}))
        .unwrap();
    let saved = store.load().unwrap();
    assert!(!saved.codex_app_conversation_list);
    assert!(saved.codex_app_conversation_tabs, "关列表不应影响标签栏开关");
}

#[test]
fn conversation_list_renderer_and_backend_contract_pass() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let output = std::process::Command::new("node")
        .args(["--test", "assets/inject/conversation-list.test.cjs"])
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
