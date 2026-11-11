use codex_plus_core::settings::SettingsStore;
use serde_json::{Value, json};
use std::fs;

#[test]
fn retired_bundled_settings_are_dropped_while_other_enhancements_are_preserved() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("settings.json");
    let retired = json!({
        "agentPet":{"enabled":true,"kind":"whaleWidget"},
        "codexAppWhaleBalanceProtocol":"custom",
        "codexAppWhaleBalancePath":"/balance",
        "codexAppWhaleBalanceField":"balance",
        "codexAppWhaleBalanceCurrency":"USD",
        "codexAppWhaleBalanceScale":1,
        "codexAppImageOverlayEnabled":true,
        "codexAppImageOverlayPath":"/tmp/picture.png",
        "codexAppImageOverlayOpacity":35,
        "codexAppImageOverlayFitMode":"fit",
        "codexAppTypingEffect":"stars",
        "codexAppUsageStatusLine":true
    });
    let mut original = retired.clone();
    original["codexAppNativeProjectSections"] = json!(true);
    original["codexAppNativePredictions"] = json!(true);
    fs::write(&path, original.to_string()).unwrap();
    let store = SettingsStore::new(path.clone());
    let settings = store.load().unwrap();
    assert!(settings.codex_app_native_project_sections);
    assert!(settings.codex_app_native_predictions);
    store.save(&settings).unwrap();
    let saved: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    for key in retired.as_object().unwrap().keys() {
        assert!(saved.get(key).is_none(), "{key}");
    }
    store.update(retired.clone()).unwrap();
    let saved: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    for key in retired.as_object().unwrap().keys() {
        assert!(saved.get(key).is_none(), "{key}");
    }
    assert_eq!(saved["codexAppNativeProjectSections"], true);
    assert_eq!(saved["codexAppNativePredictions"], true);
}
