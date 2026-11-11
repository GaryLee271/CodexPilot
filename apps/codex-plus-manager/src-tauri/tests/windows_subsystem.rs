#[cfg(windows)]
#[test]
fn manager_binary_uses_windows_gui_subsystem_in_debug_and_release() {
    let main_rs = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/main.rs"))
        .expect("read manager main.rs");

    assert!(
        main_rs.contains("#![cfg_attr(windows, windows_subsystem = \"windows\")]"),
        "manager binary should not allocate a console window on Windows"
    );
}

#[test]
fn manager_release_binary_uses_embedded_frontend_assets() {
    let cargo_toml = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.toml"))
        .expect("read manager Cargo.toml");

    assert!(
        cargo_toml.contains("custom-protocol"),
        "release manager binary should use Tauri custom protocol instead of devUrl localhost"
    );
}

#[test]
fn manager_uses_single_instance_guard_before_starting_tauri() {
    let lib_rs = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/lib.rs"))
        .expect("read manager lib.rs");

    assert!(lib_rs.contains("acquire_single_instance_guard()"));
    assert!(lib_rs.contains("manager_guard_port"));
    assert!(lib_rs.contains("manager.already_running"));
}

#[test]
fn manager_repeated_launch_activates_existing_window() {
    let lib_rs = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/lib.rs"))
        .expect("read manager lib.rs");

    assert!(lib_rs.contains("focus_existing_manager_window();"));
    assert!(lib_rs.contains("windows_activate_process_window"));
}

#[test]
fn manager_main_window_uses_default_window_icon_explicitly() {
    let lib_rs = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/lib.rs"))
        .expect("read manager lib.rs");

    assert!(lib_rs.contains("main_window_builder"));
    assert!(lib_rs.contains("app.default_window_icon().cloned()"));
    assert!(lib_rs.contains("main_window_builder = main_window_builder.icon(icon)?"));
}

#[test]
fn manager_close_minimizes_to_tray_without_confirmation() {
    let lib_rs = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/lib.rs"))
        .expect("read manager lib.rs");
    let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let app_tsx = manifest_dir.parent().unwrap().join("src/App.tsx");
    let app_tsx = std::fs::read_to_string(&app_tsx).expect("read manager App.tsx");

    assert!(!lib_rs.contains("MessageDialogButtons"));
    assert!(!lib_rs.contains(".dialog()"));
    assert!(!lib_rs.contains("manager://close-requested"));
    assert!(lib_rs.contains("let _ = close_event_window.hide();"));
    assert!(!lib_rs.contains("startup_is_transient()"));
    // 登录启动可以按已有设置隐藏窗口，手动打开仍保持可见。
    assert!(lib_rs.contains("build_main_window(app.handle(), url, !start_minimized)"));
    assert!(lib_rs.contains(".visible(visible)"));
    assert!(lib_rs.contains("codex_plus_launcher::shutdown()"));
    assert!(!app_tsx.contains("CloseConfirmDialog"));
    assert!(lib_rs.contains("manager_exit_app"));
    assert!(lib_rs.contains("manager_hide_to_tray"));
}

#[test]
fn manager_close_hides_and_reuses_the_main_window() {
    let lib_rs = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/lib.rs"))
        .expect("read manager lib.rs");
    let tray_panel_rs =
        std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/tray_panel.rs"))
            .expect("read manager tray_panel.rs");
    let close = lib_rs
        .split("WindowEvent::CloseRequested { api, .. } => {")
        .nth(1)
        .unwrap()
        .split("#[tauri::command]")
        .next()
        .unwrap();
    assert!(close.contains("api.prevent_close()"));
    assert!(close.contains("close_event_window.hide()"));
    assert!(!lib_rs.contains("lightweight"));
    assert!(!lib_rs.contains(".destroy()"));
    assert!(!lib_rs.contains("ensure_main_window"));
    assert!(lib_rs.contains("app_handle.get_webview_window(MAIN_WINDOW_LABEL)"));
    assert_eq!(
        lib_rs.matches("tauri::WebviewWindowBuilder::new(").count(),
        1
    );
    // 托盘固定打开快捷面板；请求仍等主窗口监听就绪。
    assert!(lib_rs.contains(".show_menu_on_left_click(false)"));
    assert!(!tray_panel_rs.contains("SettingsStore"));
    assert!(lib_rs.contains("tray_panel::main_window_prepare"));
    assert!(tray_panel_rs.contains("MAIN_WINDOW_READY.load(Ordering::SeqCst)"));
}

#[test]
fn macos_tray_panel_is_shown_with_rounded_corners() {
    let panel_rs =
        std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/tray_panel.rs"))
            .expect("read tray_panel.rs");

    // 显示之后再裁圆角，阴影才会按圆角轮廓重算。
    let shown = panel_rs
        .find("let _ = window.show();")
        .expect("panel shows the window");
    let rounded = panel_rs
        .find("round_corners(app, &window);")
        .expect("panel rounds its corners");
    assert!(shown < rounded);
    assert!(panel_rs.contains("codex_plus_core::macos_window::round_corners("));
    assert!(panel_rs.contains("app.run_on_main_thread("));
}

#[test]
fn manager_keeps_a_visible_brand_tray_when_hiding_the_macos_dock_icon() {
    let lib_rs = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/lib.rs"))
        .expect("read manager lib.rs");

    assert!(lib_rs.contains("tauri::ActivationPolicy::Accessory"));
    assert!(lib_rs.contains("tauri::ActivationPolicy::Regular"));
    assert!(lib_rs.contains("set_manager_activation_policy(&close_event_app, false)"));
    assert!(lib_rs.contains("set_manager_activation_policy(app_handle, true)"));
    assert!(lib_rs.contains("set_manager_activation_policy(&app_handle, false)"));
    assert!(lib_rs.contains(".icon_as_template(false)"));
    assert!(lib_rs.contains("tauri::include_image!(\"icons/icon.png\")"));
    assert!(lib_rs.contains(".show_menu_on_left_click(false)"));
    assert!(lib_rs.contains(".tooltip(\"Codex Pilot\")"));
}

#[test]
fn tray_single_click_reaches_the_panel_before_double_click_restores_the_window() {
    let lib_rs = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/lib.rs"))
        .expect("read manager lib.rs");
    let panel = lib_rs
        .find("tray_panel::handle_tray_event(tray.app_handle(), &event)")
        .unwrap();
    let show = lib_rs.find("tray_event_shows_main_window(&event)").unwrap();
    assert!(panel < show);
    assert!(lib_rs.contains(".show_menu_on_left_click(false)"));
    assert!(!lib_rs.contains(".show_menu_on_left_click(true)"));
}

#[test]
fn manager_reopens_hidden_window_when_macos_dock_requests_reopen() {
    let lib_rs = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/lib.rs"))
        .expect("read manager lib.rs");

    assert!(lib_rs.contains("tauri::RunEvent::Reopen"));
    assert!(lib_rs.contains("show_main_window(app_handle);"));
}

#[test]
fn manager_second_instance_activates_existing_macos_bundle() {
    let lib_rs = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/lib.rs"))
        .expect("read manager lib.rs");

    assert!(lib_rs.contains("native_application_bundle_from_executable"));
    assert!(!lib_rs.contains("codex_plus_core::install::MANAGER_BUNDLE_ID"));
    assert!(lib_rs.contains("std::process::Command::new(\"/usr/bin/open\")"));
}

#[test]
fn only_the_gui_binary_is_built_with_the_codex_icon() {
    let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let launcher_manifest = manifest_dir
        .parent()
        .and_then(std::path::Path::parent)
        .unwrap()
        .join("codex-plus-launcher/Cargo.toml");
    let launcher = std::fs::read_to_string(&launcher_manifest).expect("read runtime manifest");
    let manager = std::fs::read_to_string(manifest_dir.join("Cargo.toml")).unwrap();
    let config = std::fs::read_to_string(manifest_dir.join("tauri.conf.json")).unwrap();
    assert!(launcher.contains("autobins = false"));
    assert!(launcher.contains("build = false"));
    assert!(!launcher.contains("[[bin]]"));
    assert!(manager.contains("name = \"codex-pilot\""));
    assert!(config.contains("icons/icon.ico"));
}

#[test]
fn windows_binaries_run_as_invoker_without_administrator_privileges() {
    let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let manager_build =
        std::fs::read_to_string(manifest_dir.join("build.rs")).expect("read manager build.rs");
    let windows_manifest = std::fs::read_to_string(manifest_dir.join("windows-app-manifest.xml"))
        .expect("read windows app manifest");
    let launcher_build = manifest_dir
        .parent()
        .and_then(std::path::Path::parent)
        .unwrap()
        .join("codex-plus-launcher/build.rs");
    let launcher_build = std::fs::read_to_string(&launcher_build).expect("read launcher build.rs");
    let windows_installer = manifest_dir
        .parent()
        .and_then(std::path::Path::parent)
        .and_then(std::path::Path::parent)
        .unwrap()
        .join("scripts/installer/windows/CodexPilot.nsi");
    let windows_installer =
        std::fs::read_to_string(&windows_installer).expect("read windows installer");

    assert!(manager_build.contains("windows-app-manifest.xml"));
    assert!(launcher_build.contains("windows-app-manifest.xml"));
    // Elevated launcher processes also elevate Codex, so Explorer file drops are blocked by UIPI.
    assert!(windows_manifest.contains("asInvoker"));
    assert!(!windows_manifest.contains("requireAdministrator"));
    assert!(windows_manifest.contains("Microsoft.Windows.Common-Controls"));
    assert!(windows_installer.contains("RequestExecutionLevel user"));
    assert!(!windows_installer.contains("RequestExecutionLevel admin"));
}

#[test]
fn windows_entrypoints_register_codexpilot_url_protocol() {
    let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let windows_install = manifest_dir
        .parent()
        .and_then(std::path::Path::parent)
        .and_then(std::path::Path::parent)
        .unwrap()
        .join("crates/codex-plus-core/src/install/windows.rs");
    let windows_install =
        std::fs::read_to_string(&windows_install).expect("read windows install source");

    assert!(windows_install.contains("Software\\Classes\\codexpilot"));
    assert!(windows_install.contains("URL Protocol"));
    assert!(windows_install.contains("%1"));
}

#[test]
fn manager_launch_button_uses_the_embedded_runtime() {
    let commands_rs =
        std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/commands.rs"))
            .expect("read manager commands.rs");

    let body = commands_rs
        .split("fn start_embedded_launcher(")
        .nth(1)
        .unwrap()
        .split("#[tauri::command]")
        .next()
        .unwrap();
    assert!(body.contains("codex_plus_launcher::start"));
    assert!(!body.contains("spawn_companion"));
    assert!(!body.contains("Command::new"));
}

#[test]
fn macos_packager_builds_one_visible_native_gui_with_legacy_update_shim() {
    let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let packager = manifest_dir
        .parent()
        .and_then(std::path::Path::parent)
        .and_then(std::path::Path::parent)
        .unwrap()
        .join("scripts/installer/macos/package-dmg.sh");
    let script = std::fs::read_to_string(&packager).expect("read macOS packager");

    assert!(script.contains("<key>LSUIElement</key>"));
    assert!(script.contains("ARCH=\"${2:-$(uname -m)}\""));
    assert!(script.contains("BINARY_DIR=\"${BINARY_DIR:-$ROOT/target/release}\""));
    assert!(script.contains("CodexPilot-${VERSION}-macos-${ARCH}.dmg"));
    assert!(script.contains(
        "create_app \"Codex Pilot\" \"CodexPilot\" \"$BINARY_DIR/codex-pilot\" \"com.garylee271.codexpilot\" \"false\""
    ));
    assert!(script.contains(
        "create_app \"Codex Pilot 管理工具\" \"CodexPilotManager\" \"$BINARY_DIR/codex-plus-legacy-shim\" \"com.garylee271.codexpilot.manager\" \"true\""
    ));
    assert!(script.contains("printf '%s\\n' \"Codex Pilot 管理工具.app\" > \"$STAGE/.hidden\""));
    assert!(script.contains("chflags hidden \"$STAGE/Codex Pilot 管理工具.app\""));
    assert!(script.contains("set visible of item \"Codex Pilot 管理工具.app\" to false"));
    assert!(script.contains("<key>CodexPlusUnifiedApp</key>"));
}

#[test]
fn github_release_workflow_builds_one_universal_macos_dmg() {
    let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let workflow = manifest_dir
        .parent()
        .and_then(std::path::Path::parent)
        .and_then(std::path::Path::parent)
        .unwrap()
        .join(".github/workflows/release-assets.yml");
    let workflow = std::fs::read_to_string(&workflow).expect("read release assets workflow");

    // 通用包：单个 job 在两个 target 上各编一遍，由 build-universal.sh
    // 用 lipo 合并。两个架构的 std 都要装。
    assert!(workflow.contains("macos-14"));
    assert!(workflow.contains("x86_64-apple-darwin,aarch64-apple-darwin"));
    assert!(workflow.contains("build-universal.sh \"$VERSION\""));

    // 分架构的 matrix 形态不应再出现，否则会回到「用户自己挑架构」的老问题。
    assert!(!workflow.contains("matrix.arch"));
    assert!(!workflow.contains("macos-15-intel"));
}

#[test]
fn github_release_workflow_uploads_static_latest_json() {
    let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let workflow = manifest_dir
        .parent()
        .and_then(std::path::Path::parent)
        .and_then(std::path::Path::parent)
        .unwrap()
        .join(".github/workflows/release-assets.yml");
    let workflow = std::fs::read_to_string(&workflow).expect("read release assets workflow");

    assert!(workflow.contains("latest-json:"));
    assert!(workflow.contains("latest.json"));
    assert!(workflow.contains("gh release upload \"$TAG\" latest.json --clobber"));
}

#[test]
fn manager_window_keeps_its_default_and_minimum_size() {
    let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let lib_rs = std::fs::read_to_string(manifest_dir.join("src/lib.rs")).unwrap();
    let tauri_conf = std::fs::read_to_string(manifest_dir.join("tauri.conf.json")).unwrap();
    // 精简后的双页布局使用同一组窗口尺寸，Rust 创建路径与 Tauri 声明必须保持一致。
    assert!(lib_rs.contains(".inner_size(1000.0, 760.0)"));
    assert!(lib_rs.contains(".min_inner_size(820.0, 600.0)"));
    assert!(tauri_conf.contains("\"width\": 1000"));
    assert!(tauri_conf.contains("\"height\": 760"));
    assert!(tauri_conf.contains("\"minWidth\": 820"));
    assert!(tauri_conf.contains("\"minHeight\": 600"));
}

#[test]
fn manager_no_longer_exposes_mobile_control() {
    let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let app_tsx = manifest_dir.parent().unwrap().join("src/App.tsx");
    let app_tsx = std::fs::read_to_string(&app_tsx).expect("read manager App.tsx");

    assert!(!app_tsx.contains("mobileControl"));
    assert!(!app_tsx.contains("手机控制"));
    assert!(!app_tsx.contains("mobileRelayServers"));
    assert!(!app_tsx.contains("MobileControlScreen"));
}

#[test]
fn manager_ui_no_longer_exposes_command_wrapper_or_startup_marketplace_prompt() {
    let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let app_tsx = manifest_dir.parent().unwrap().join("src/App.tsx");
    let app_tsx = std::fs::read_to_string(&app_tsx).expect("read manager App.tsx");

    assert!(!app_tsx.contains("启用 Codex 命令包装器"));
    assert!(!app_tsx.contains("修复后端"));
    assert!(!app_tsx.contains("repairBackend"));
    assert!(!app_tsx.contains("await checkPluginMarketplacePrompt()"));
}

#[test]
fn manager_update_install_keeps_visible_progress_bar() {
    let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let app_tsx = manifest_dir.parent().unwrap().join("src/App.tsx");
    let app_tsx = std::fs::read_to_string(&app_tsx).expect("read manager App.tsx");

    assert!(app_tsx.contains("下载并运行安装包"));
    assert!(app_tsx.contains("updateInstallProgress"));
    assert!(app_tsx.contains("安装包更新进度"));
    assert!(app_tsx.contains("completedTitle={t(\"上次更新结果\")}"));
    assert!(app_tsx.contains("progress={updateInstallProgress}"));
    assert!(app_tsx.contains("listen<UpdateProgressEvent>(\"update-progress\""));
    assert!(app_tsx.contains("data-indeterminate"));
    assert!(app_tsx.contains("正在写入安装包并准备安装"));
    assert!(app_tsx.contains("正在启动安装器"));
    assert!(!app_tsx.contains("current.percent + 0.2"));
    assert!(!app_tsx.contains("下载或启动耗时较长"));
}
