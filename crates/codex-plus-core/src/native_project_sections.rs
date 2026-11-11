//! API 模式下的原生侧栏分区策略；分区只保存在独立本地命名空间。

use crate::settings::BackendSettings;
use serde::Serialize;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeSettings {
    pub enhancements_enabled: bool,
    pub codex_app_native_project_sections: bool,
    pub native_project_sections_local_api_configured: bool,
}

pub(crate) fn runtime_settings(settings: &BackendSettings) -> RuntimeSettings {
    runtime_settings_with_local_api(
        settings,
        crate::native_fast::local_api_configured_from_home(
            &crate::codex_home::default_codex_home_dir(),
        ),
    )
}

fn runtime_settings_with_local_api(settings: &BackendSettings, local_api: bool) -> RuntimeSettings {
    // 仅投影功能开关与本机 API 判定，不再读取账号分区文件或发布账号候选。
    RuntimeSettings {
        enhancements_enabled: settings.enhancements_enabled,
        codex_app_native_project_sections: settings.codex_app_native_project_sections,
        native_project_sections_local_api_configured: local_api,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_payload_only_contains_local_project_section_policy() {
        let settings = BackendSettings {
            codex_app_native_project_sections: true,
            ..BackendSettings::default()
        };
        assert_eq!(
            serde_json::to_value(runtime_settings_with_local_api(&settings, true)).unwrap(),
            serde_json::json!({
                "enhancementsEnabled": true,
                "codexAppNativeProjectSections": true,
                "nativeProjectSectionsLocalApiConfigured": true,
            })
        );
    }

    #[test]
    fn native_project_sections_alone_requests_module_channel_and_respects_master_switch() {
        let mut settings = BackendSettings::default();
        assert!(!crate::native_predictions::native_modules_requested(
            &settings
        ));
        settings.codex_app_native_project_sections = true;
        assert!(crate::native_predictions::native_modules_requested(
            &settings
        ));
        settings.enhancements_enabled = false;
        assert!(!crate::native_predictions::native_modules_requested(
            &settings
        ));
    }
}
