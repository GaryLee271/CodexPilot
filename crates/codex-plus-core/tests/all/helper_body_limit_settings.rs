// 升级兼容：旧 HTTP helper 设置可被读取，但不再成为当前配置或影响增强开关。
use codex_plus_core::settings::SettingsStore;
use serde_json::json;

#[test]
fn retired_http_body_limit_is_ignored_and_enhancement_settings_round_trip() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("settings.json");
    std::fs::write(
        &path,
        serde_json::to_vec(&json!({
            "helperMaxRequestBodyMib": 256,
            "enhancementsEnabled": true,
            "codexAppNativePredictions": true,
            "codexAppNativePredictionsModel": "prediction-model",
            "codexAppNativeProjectSections": true,
        }))
        .unwrap(),
    )
    .unwrap();
    let store = SettingsStore::new(path.clone());
    let settings = store.load().unwrap();
    assert!(settings.codex_app_native_predictions);
    assert!(settings.codex_app_native_project_sections);
    assert_eq!(
        settings.codex_app_native_predictions_model,
        "prediction-model"
    );
    store.save(&settings).unwrap();
    let saved: serde_json::Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    assert!(saved.get("helperMaxRequestBodyMib").is_none());
    assert_eq!(saved["codexAppNativePredictions"], true);
    assert_eq!(saved["codexAppNativeProjectSections"], true);
    assert_eq!(saved["codexAppNativePredictionsModel"], "prediction-model");
}
