#![recursion_limit = "256"]

pub mod app_paths;
pub mod assets;
pub mod auto_takeover;
pub mod bridge;
pub mod builtin_takeover;
pub mod cdp;

pub mod codex_app_state;
pub mod codex_home;
pub mod codex_local_storage;
pub mod codex_sqlite;

pub mod dsh_plugins;
pub mod extension_launch;

pub mod diagnostic_log;
pub mod disclaimed_spawn;
pub mod responses_sse;


pub mod http_client;
pub mod install;
pub mod launcher;
pub mod macos_window;
pub mod managed_mcp;
pub mod manager_navigation;
pub mod model_catalog;
pub mod model_suffix;
pub mod models;

pub mod native_browser;
pub mod native_browser_connection;
pub mod native_config;
pub(crate) mod native_fast;
pub(crate) mod native_predictions;
pub mod native_project_sections;
pub mod official_login;
pub mod packaged_launch;
pub mod paths;
pub mod ports;
pub mod protocol_proxy;

pub mod extension_backend;
pub mod extension_codex;
pub mod extension_creator;
pub mod extension_gateway;
pub mod extension_history;
pub mod extension_hooks;
pub mod extension_llm;
pub mod extension_node;
pub mod extension_semver;
pub mod proxy;
pub mod relay_config;
pub mod relay_headers;
pub mod routes;
pub mod settings;
pub mod settings_catalog;
pub mod ssh_remote_loopback;
pub mod status;
pub mod update;
pub mod upstream_model_meta;
pub mod user_scripts;
pub mod version;
pub mod watcher;
// 不加 `#[cfg(windows)]`：模块内部各项已各自标注平台门控，在非 Windows 平台上
// 是一个只含少数无平台依赖项（如 current_process_is_elevated 的桩实现）的空模块。
// 门控在模块级会导致 `if cfg!(windows)` 这类运行时分支在非 Windows 平台找不到符号。
mod windows_integration;
#[cfg(windows)]
mod windows_taskbar;

#[cfg(windows)]
pub fn windows_create_no_window() -> u32 {
    windows_integration::CREATE_NO_WINDOW
}

#[cfg(windows)]
pub fn windows_open_url(url: &str) -> anyhow::Result<()> {
    windows_integration::open_url(url)
}

#[cfg(windows)]
pub fn windows_activate_process_window(process_id: u32) -> bool {
    windows_integration::activate_process_window(process_id)
}

/// 设置 Codex Pilot 任务栏分组、名称和重启入口，保留 Codex 自己的图标。
/// 启动器不再对打包版 Codex 调用：改写包应用的 AppUserModelID 会让任务栏丢失官方图标并单独分组（#2499、#2668）。
#[cfg(windows)]
pub fn windows_apply_codexpilot_taskbar_to_process_window(process_id: u32) -> bool {
    windows_integration::apply_codexpilot_taskbar_to_process_window(process_id)
}

/// 兼容旧调用方；图标参数不再使用，行为与任务栏接口一致。
#[cfg(windows)]
pub fn windows_apply_codexpilot_icon_to_process_window(
    process_id: u32,
    _icon_resource_path: std::path::PathBuf,
) -> bool {
    windows_apply_codexpilot_taskbar_to_process_window(process_id)
}

#[cfg(windows)]
pub fn windows_enumerate_processes() -> Vec<windows_integration::WindowsProcessInfo> {
    windows_integration::enumerate_processes()
}
