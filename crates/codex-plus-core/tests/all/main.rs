//! codex-plus-core 集成测试的统一入口。
//!
//! 这些文件原本各是一个独立测试程序，每个都要把整个 core 和依赖完整链接一次，
//! cargo 还会逐个串行执行；合并成一个程序后只链接一次，各文件的用例在同一进程里并行。
//!
//! 合并带来的约束：
//! - 改进程级状态（设置路径覆盖、诊断日志路径、`CODEX_HOME` 等环境变量）的用例，
//!   一律先拿 [`common::global_state_lock`]，不要再在单个文件里另起一把锁。
//! - 需要独占进程的环境变量或单例用例仍单独放在 `tests/` 下。
//!
//! 只跑某个文件的用例：`cargo test -p codex-plus-core --test all relay_config::`

mod common;

mod auto_takeover_live;
mod bridge_routes;
mod builtin_extensions;
mod bundled_builtins;
mod bundled_extensions;
mod cdp_bridge;
mod codex_app_state;
mod codex_sqlite;
mod conversation_tabs;
mod conversation_list;
mod diagnostic_log;
mod extension_backend;
mod extension_codex;
mod extension_creator;
mod extension_gateway;
mod extension_history;
mod extension_hooks;
mod extension_launch;
mod extension_llm;
mod extension_manager_page;
mod extension_readme;
mod extension_semver;
mod extension_tool_pipeline;
mod helper_body_limit_settings;
mod installers;
mod issue_renderer_regressions;
mod launcher;
mod model_catalog;
mod model_suffix;
mod native_browser_settings;
mod native_fast_settings;
mod native_fast_unlock;
mod native_predictions;
mod native_project_sections;
mod retired_layout;
mod ssh_remote_loopback;
mod ui_issue_regressions;
mod update_reminder_settings;
mod updater;
mod user_scripts_reload;
mod watcher;
mod windows_console_spawn;

mod retired_integrations;
