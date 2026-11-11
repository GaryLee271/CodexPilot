#![cfg_attr(windows, windows_subsystem = "windows")]

fn main() {
    let args: Vec<_> = std::env::args_os().collect();
    if args
        .get(1)
        .is_some_and(|arg| {
            arg == "--codex-plus-dsh-mcp"
                || arg == "--codex-plus-extension-mcp"
                || arg == "--codex-plus-plugin-mcp"
        })
    {
        eprintln!("Codex Pilot 用户拓展工具已移除，请重启 Codex 使停用设置生效。");
        std::process::exit(1);
    }
    // Codex 钩子分发：拓展在 codexpp.json 里声明的 hooks 都经这一条命令运行，stdout 写合并后的决定。
    if args
        .get(1)
        .is_some_and(|arg| arg == codex_plus_core::extension_hooks::HOOK_FLAG)
    {
        let event = args
            .get(2)
            .and_then(|arg| arg.to_str())
            .unwrap_or_default()
            .to_string();
        std::process::exit(codex_plus_manager_lib::run_extension_hook(&event));
    }
    if args
        .get(1)
        .is_some_and(|arg| arg == codex_plus_core::extension_backend::HOST_CALL_FLAG)
    {
        std::process::exit(codex_plus_manager_lib::run_extension_host_call());
    }
    #[cfg(target_os = "macos")]
    if launched_from_legacy_manager_compat_bundle() {
        // 旧版更新器要求 DMG 中有第二个 manager bundle，并会在替换后打开它。
        // 兼容壳只满足身份校验；让真正的统一 Codex Pilot app 接管界面。
        return;
    }
    // 开机启动也只打开界面；禁用开机项不影响用户主动双击。
    if should_skip_autostart(
        std::env::args(),
        codex_plus_core::watcher::default_watcher_disabled_flag().exists(),
    ) {
        return;
    }
    #[cfg(target_os = "macos")]
    {
        let args: Vec<_> = std::env::args_os().collect();
        if args
            .get(1)
            .is_some_and(|arg| arg == "--apply-codex-plus-update")
        {
            let result = if args.len() == 3 {
                codex_plus_core::update::macos::run_update_helper(std::path::Path::new(&args[2]))
            } else {
                Err(anyhow::anyhow!(
                    "更新 helper 需要且仅接受一个计划文件路径。"
                ))
            };
            if let Err(error) = result {
                eprintln!("更新 helper 失败：{error:#}");
                let _ = codex_plus_core::diagnostic_log::append_diagnostic_log(
                    "update.macos.helper_failed",
                    serde_json::json!({ "message": error.to_string() }),
                );
                std::process::exit(1);
            }
            return;
        }
    }
    if std::env::args().any(|arg| arg == "--show-update") {
        unsafe {
            std::env::set_var("CODEX_PLUS_SHOW_UPDATE", "1");
        }
    }
    codex_plus_manager_lib::run();
}

#[cfg(target_os = "macos")]
fn launched_from_legacy_manager_compat_bundle() -> bool {
    std::env::current_exe()
        .ok()
        .map(|path| path.to_string_lossy().contains("Codex Pilot 管理工具.app"))
        .unwrap_or(false)
}

fn should_skip_autostart(args: impl IntoIterator<Item = String>, disabled: bool) -> bool {
    disabled && args.into_iter().any(|arg| arg == "--autostart")
}

#[cfg(test)]
mod tests {
    use super::should_skip_autostart;

    #[test]
    fn disabling_login_startup_still_allows_opening_the_gui() {
        for args in [
            vec!["codex-pilot"],
            vec!["codex-pilot", "--background"],
            vec!["codex-pilot", "--helper-only"],
        ] {
            assert!(!should_skip_autostart(
                args.into_iter().map(String::from),
                true
            ));
        }
        assert!(should_skip_autostart(
            ["codex-pilot", "--autostart"].map(String::from),
            true
        ));
        assert!(!should_skip_autostart(
            ["codex-pilot", "--autostart"].map(String::from),
            false
        ));
    }
}
