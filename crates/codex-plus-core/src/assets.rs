use serde_json::json;

use crate::settings::BackendSettings;

const RENDERER_SCRIPT: &str = include_str!("../../../assets/inject/renderer-inject.js");
const NATIVE_FAST_UNLOCK_SCRIPT: &str =
    include_str!("../../../assets/inject/native-fast-unlock.js");
const NATIVE_PREDICTIONS_SCRIPT: &str =
    include_str!("../../../assets/inject/native-predictions.js");
pub const DIAGNOSTIC_BUILD_ID: &str = "diag-20260518-1";

pub fn renderer_script() -> &'static str {
    RENDERER_SCRIPT
}

pub fn native_fast_unlock_script() -> &'static str {
    NATIVE_FAST_UNLOCK_SCRIPT
}

pub fn native_predictions_script() -> &'static str {
    NATIVE_PREDICTIONS_SCRIPT
}

pub fn native_project_sections_script() -> &'static str {
    include_str!("../../../assets/inject/native-project-sections.js")
}

pub fn injection_script() -> String {
    injection_script_with_settings(&BackendSettings::default())
}

fn renderer_after_document_ready(script: &str) -> String {
    format!(
        "(()=>{{const start=()=>{{{script}\n}};if(document.body)start();else document.addEventListener('DOMContentLoaded',start,{{once:true}});}})();"
    )
}

pub fn injection_script_with_settings(settings: &BackendSettings) -> String {
    // 原生模块补丁的新文档脚本需要 Page.enable；DOM 增强必须等正常文档就绪，不能访问空的根节点。
    let renderer_runtime = if crate::native_predictions::native_modules_requested(settings) {
        renderer_after_document_ready(renderer_script())
    } else {
        renderer_script().to_string()
    };
    format!(
        "window.__CODEX_PLUS_VERSION__ = {};\nwindow.__CODEX_PLUS_BUILD__ = {};\n{}",
        serde_json::to_string(crate::version::VERSION).expect("version should serialize"),
        serde_json::to_string(DIAGNOSTIC_BUILD_ID).expect("build id should serialize"),
        format!(
            "{}\n{}",
            format!(
                "{}\nwindow.__codexPlusNativeFastUnlock.runtime.update({});\n{}\nwindow.__codexPlusNativePredictions.runtime.update({});\n{}\nwindow.__codexPlusNativeProjectSections.runtime.update({});",
                native_fast_unlock_script(),
                json!(crate::native_fast::runtime_settings(settings)),
                native_predictions_script(),
                json!(crate::native_predictions::runtime_settings(settings)),
                native_project_sections_script(),
                json!(crate::native_project_sections::runtime_settings(settings)),
            ),
            renderer_runtime
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_fast_renderer_waits_for_dom_and_reinjection_runs_immediately() {
        let wrapped = renderer_after_document_ready("window.started=(window.started||0)+1;");
        let test = format!(
            r#"
          const vm=require('node:vm'),assert=require('node:assert/strict');
          for(const ready of [false,true]){{
            let listener;
            const window={{}},document={{body:ready?{{}}:null,addEventListener:(name,callback,options)=>{{
              assert.equal(name,'DOMContentLoaded');assert.equal(options.once,true);listener=callback;
            }}}};
            vm.runInNewContext({},{{window,document}});
            assert.equal(window.started,ready?1:undefined);
            if(!ready){{document.body={{}};listener();assert.equal(window.started,1);}}
          }}
        "#,
            serde_json::to_string(&wrapped).unwrap()
        );
        let output = std::process::Command::new("node")
            .arg("-e")
            .arg(test)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn injection_does_not_project_retired_plugin_cache() {
        let script = injection_script_with_settings(&BackendSettings::default());
        assert!(!script.contains("window.__CODEX_PLUS_PLUGIN_MARKETPLACES__ ="));
    }

    #[test]
    fn pet_media_is_not_embedded_in_the_injection_script() {
        // 已移除的随附桌宠引擎与素材不再嵌入注入脚本。
        let script = injection_script();
        assert!(!script.contains("__CODEX_PLUS_WHALE_ENGINE__"));
        assert!(!script.contains("__CODEX_PLUS_WHALE_ASSETS__"));
        assert!(!script.contains("__CODEX_PLUS_AGENT_PET_SOUNDS__"));
    }
}
