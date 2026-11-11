mod auto_takeover;
mod codex_bridge;
pub mod commands;

pub mod install;

mod runtime_health;
mod shutdown_watchdog;
mod tray_panel;

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, WindowEvent};

pub(crate) const TRAY_ID: &str = "codex_plus_tray";
/// 主窗口的标签；关闭时只隐藏，所有入口复用同一窗口。
pub(crate) const MAIN_WINDOW_LABEL: &str = "main";
/// 主窗口默认加载的页面。
const MAIN_WINDOW_URL: &str = "/index.html";

static APP_EXITING: AtomicBool = AtomicBool::new(false);
static SHUTDOWN_STARTED: AtomicBool = AtomicBool::new(false);
static SHUTDOWN_COMPLETE: AtomicBool = AtomicBool::new(false);
/// 整个退出流程的等待上限，包含清理完成后的最终框架退出。
const SHUTDOWN_WATCHDOG: u64 = 10;
const TRAY_MENU_SHOW: &str = "tray_show_main";
const TRAY_MENU_QUIT: &str = "tray_quit_app";
const MANAGER_NAVIGATION_EVENT: &str = "manager-navigation-requested";

pub(crate) fn app_is_exiting() -> bool {
    APP_EXITING.load(Ordering::SeqCst)
}

fn shutdown_entry_snapshot(code: Option<i32>) -> serde_json::Value {
    serde_json::json!({
        "code": code,
        "appExiting": APP_EXITING.load(Ordering::SeqCst),
        "shutdownStarted": SHUTDOWN_STARTED.load(Ordering::SeqCst),
        "cleanupComplete": SHUTDOWN_COMPLETE.load(Ordering::SeqCst),
        "observedAtMs": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
    })
}

fn record_shutdown_entry(event: &'static str, detail: serde_json::Value) {
    shutdown_watchdog::record_best_effort(move || {
        let _ = codex_plus_core::diagnostic_log::append_diagnostic_log(event, detail);
    });
}

/// Codex 钩子分发：`--codex-plus-hook <事件>`，由 Codex 在对应时机经 shell 调用。
pub fn run_extension_hook(event: &str) -> i32 {
    let manager = commands::default_user_script_manager();
    // 钩子进程不托管后台：服务调用经 Codex 页面桥接转发（钩子不继承管理器环境，按默认状态目录找端口）。
    codex_plus_core::extension_backend::set_remote_bridge_ports(
        codex_bridge::debug_ports(&codex_plus_core::paths::default_app_state_dir()),
    );
    tauri::async_runtime::block_on(codex_plus_core::extension_hooks::run_cli(&manager, event))
}

/// Disable only the two MCP servers owned by the removed user-extension platform.
/// Their configuration entries and any unrelated Codex data remain intact.
fn disable_removed_extension_mcps() {
    let executable = match std::env::current_exe() {
        Ok(executable) => executable,
        Err(error) => {
            let _ = codex_plus_core::diagnostic_log::append_diagnostic_log(
                "extension_platform.disable_mcp_failed",
                serde_json::json!({ "error": error.to_string() }),
            );
            return;
        }
    };
    let home = codex_plus_core::codex_home::default_codex_home_dir();
    let state_dir = codex_plus_core::paths::default_app_state_dir();
    for spec in [
        &codex_plus_core::dsh_plugins::SPEC,
        &codex_plus_core::extension_creator::SPEC,
    ] {
        // 按归属标记停用，也覆盖旧安装路径、旧名称；转换函数会保留同名的其他 MCP。
        if let Err(error) = codex_plus_core::managed_mcp::disable(spec, &home, &executable, &state_dir) {
            let _ = codex_plus_core::diagnostic_log::append_diagnostic_log(
                "extension_platform.disable_mcp_failed",
                serde_json::json!({ "server": spec.server_id, "error": format!("{error:#}") }),
            );
        }
    }
}

/// 宿主调用：`--codex-plus-host-call`，内置拓展后台进程经它访问 Codex Pilot 托管能力。
pub fn run_extension_host_call() -> i32 {
    let manager = commands::default_user_script_manager();
    codex_plus_core::extension_backend::set_remote_bridge_ports(
        codex_bridge::debug_ports(&codex_plus_core::paths::default_app_state_dir()),
    );
    tauri::async_runtime::block_on(codex_plus_core::extension_backend::run_host_call_cli(
        &manager,
    ))
}

pub fn run() {
    install_panic_logger();
    let _ = codex_plus_core::diagnostic_log::append_diagnostic_log(
        "manager.start",
        serde_json::json!({
            "version": env!("CARGO_PKG_VERSION")
        }),
    );
    let Some(_guard) = acquire_single_instance_guard() else {
        return;
    };
    #[cfg(target_os = "macos")]
    if let Some(root) = codex_plus_core::install::default_install_root() {
        match codex_plus_core::install::macos::migrate_legacy_manager_bundle(&root) {
            Ok(Some(archive)) => {
                let _ = codex_plus_core::diagnostic_log::append_diagnostic_log(
                    "manager.legacy_manager_migrated",
                    serde_json::json!({ "archive": archive }),
                );
            }
            Ok(None) => {}
            Err(error) => {
                let _ = codex_plus_core::diagnostic_log::append_diagnostic_log(
                    "manager.legacy_manager_migration_failed",
                    serde_json::json!({ "message": error.to_string() }),
                );
            }
        }
    }
    // 清理以前自动更新留在 app 同级目录里的 .codex-plus-update-<uuid> 残留（#2774）。
    // 删旧 app 备份要些时间，放后台线程；刚由旧版 helper 完成的更新会在 helper 退出后补跑清掉。
    // 失败只记诊断日志，不影响启动。
    #[cfg(target_os = "macos")]
    std::thread::spawn(codex_plus_core::update::macos::cleanup_stale_update_transactions);
    let show_update = commands::startup_should_show_update();
    let autostart = std::env::args().any(|arg| arg == "--autostart");
    let start_minimized = autostart && codex_plus_core::watcher::watcher_start_minimized();
    let start_codex_at_login = autostart && codex_plus_core::watcher::watcher_start_codex();
    let start_codex_on_open = !autostart && codex_plus_core::watcher::watcher_start_codex_on_open();
    let app_result = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            let _ = MANAGER_APP.set(app.handle().clone());
            let url = if show_update {
                "/index.html?showUpdate=1"
            } else {
                MAIN_WINDOW_URL
            };
            tray_panel::install_ready_listener(app.handle());
            build_main_window(app.handle(), url, !start_minimized)?;
            install_tray(app)?;

            // 停用已移除平台的托管 MCP，并清理 Codex Pilot 自己的拓展钩子条目。
            tauri::async_runtime::spawn_blocking(|| {
                disable_removed_extension_mcps();
                codex_plus_core::extension_hooks::sync_default(
                    &commands::default_user_script_manager(),
                );
            });
            codex_plus_core::settings::set_external_settings_change_listener(
                notify_settings_changed,
            );
            if start_minimized {
                set_manager_activation_policy(app.handle(), false);
            }
            let navigation_app = app.handle().clone();
            codex_plus_launcher::set_navigation_handler(move |_payload| {
                let app = navigation_app.clone();
                navigation_app.run_on_main_thread(move || {
                    show_main_window(&app);
                    let _ = app.emit(MANAGER_NAVIGATION_EVENT, ());
                })?;
                Ok(())
            });
            start_window_activation_listener(app.handle().clone());

            commands::resume_existing_codex_background(
                app.handle().clone(),
                start_codex_at_login || start_codex_on_open,
            );

            // 自动接管官方 App（默认关闭）：设置里开着才起守护线程。
            auto_takeover::start_supervisor();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::backend_version,
            commands::startup_options,
            commands::consume_pending_manager_navigation,
            commands::load_overview,
            commands::codex_app_running,
            commands::launch_codex_plus,
            commands::restart_codex_plus,
            commands::stop_codex_plus,
            commands::load_settings,
            commands::native_browser_status,
            commands::save_settings,
            tray_panel::tray_panel_action,
            tray_panel::main_window_prepare,
            commands::query_builtin_model_metadata,
            commands::builtin_model_metadata_index,
            commands::reload_builtin_extensions,
            commands::set_builtin_extension_enabled,
            commands::open_external_url,
            commands::repair_shortcuts,
            commands::check_update,
            commands::skip_update_version,
            commands::perform_update,
            commands::load_watcher_state,
            commands::set_watcher_enabled,
            commands::set_watcher_start_minimized,
            commands::set_watcher_start_codex,
            commands::set_watcher_start_codex_on_open,
            // 自动接管官方 App：前端 invoke 找不到命令时是运行期静默失败，
            // 没有编译期兜底，所以这三个必须注册在这里（契约测试会守）。
            commands::load_auto_takeover_state,
            commands::take_over_codex_now,
            commands::pause_auto_takeover_for_instance,
            commands::export_settings,
            commands::preview_import_settings,
            commands::set_settings_path,
            commands::reset_settings_path,
            commands::reset_settings,
            commands::write_diagnostic_event,
            manager_exit_app,
            manager_hide_to_tray,
            update_tray_labels
        ])
        .build(tauri::generate_context!());
    match app_result {
        Ok(app) => app.run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { api, code, .. } = &event {
                if code.is_none() && !APP_EXITING.load(Ordering::SeqCst) {
                    // 窗口收起后保持增强服务与托盘运行；仅由明确的退出操作结束进程。
                    api.prevent_exit();
                    return;
                }
                let detail = shutdown_entry_snapshot(*code);
                let start_shutdown = if !SHUTDOWN_COMPLETE.load(Ordering::SeqCst) {
                    api.prevent_exit();
                    !SHUTDOWN_STARTED.swap(true, Ordering::SeqCst)
                } else {
                    false
                };
                if start_shutdown {
                    APP_EXITING.store(true, Ordering::SeqCst);
                    shutdown_watchdog::arm(
                        std::time::Duration::from_secs(SHUTDOWN_WATCHDOG),
                        || {
                            let _ = codex_plus_core::diagnostic_log::append_diagnostic_log(
                                "app.shutdown_watchdog_forced",
                                serde_json::json!({
                                    "waitedSeconds": SHUTDOWN_WATCHDOG,
                                    "cleanupComplete": SHUTDOWN_COMPLETE.load(Ordering::SeqCst),
                                }),
                            );
                        },
                    );
                }
                // 入口状态已采样；首次退出必须先启用兜底，再交给后台写盘。
                record_shutdown_entry("app.exit_requested", detail);
                if start_shutdown {
                    auto_takeover::stop_supervisor();
                    let app = app_handle.clone();
                    tauri::async_runtime::spawn_blocking(move || {
                        // 退出前先等待自有 CLI 任务清理，避免进程退出后遗留执行器。

                        if let Err(error) = codex_plus_launcher::shutdown() {
                            let _ = codex_plus_core::diagnostic_log::append_diagnostic_log(
                                "app.shutdown_failed",
                                serde_json::json!({ "message": error.to_string() }),
                            );
                        }
                        SHUTDOWN_COMPLETE.store(true, Ordering::SeqCst);
                        app.exit(0);
                    });
                }
            }
            #[cfg(target_os = "macos")]
            match event {
                tauri::RunEvent::Reopen { .. } => {
                    show_main_window(app_handle);
                }
                _ => {}
            }

            #[cfg(not(target_os = "macos"))]
            let _ = (app_handle, event);
        }),
        Err(error) => {
            let _ = codex_plus_core::diagnostic_log::append_diagnostic_log(
                "manager.run_failed",
                serde_json::json!({
                    "error": error.to_string()
                }),
            );
        }
    }
}

fn install_tray<R: tauri::Runtime>(app: &tauri::App<R>) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, TRAY_MENU_SHOW, "显示主窗口", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, TRAY_MENU_QUIT, "退出程序", true, None::<&str>)?;
    let tray_menu = Menu::with_items(app, &[&show_item, &quit_item])?;

    let mut tray_builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&tray_menu)
        .tooltip("Codex Pilot")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            TRAY_MENU_SHOW => {
                show_main_window(app);
            }
            TRAY_MENU_QUIT => {
                record_shutdown_entry("app.tray_quit", shutdown_entry_snapshot(None));
                APP_EXITING.store(true, Ordering::SeqCst);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // 左键单击固定打开快捷面板，双击唤起主窗口。
            if tray_panel::handle_tray_event(tray.app_handle(), &event) {
                return;
            }
            if tray_event_shows_main_window(&event) {
                show_main_window(tray.app_handle());
            }
        });

    #[cfg(target_os = "macos")]
    {
        // 使用项目原有云朵图标；系统按 18pt 显示，不加标题占据菜单栏空间。
        // 禁用模板模式以保留品牌渐变颜色。
        tray_builder = tray_builder.icon(macos_tray_icon()).icon_as_template(false);
    }
    #[cfg(not(target_os = "macos"))]
    if let Some(icon) = app.default_window_icon().cloned() {
        tray_builder = tray_builder.icon(icon);
    }

    // Tauri 的资源表持有托盘对象，局部句柄释放不会移除菜单栏入口。
    let _ = tray_builder.build(app)?;
    Ok(())
}

/// 左键单击由快捷面板消费；双击统一唤起主窗口，右键留给菜单。
fn tray_event_shows_main_window(event: &TrayIconEvent) -> bool {
    matches!(
        event,
        TrayIconEvent::DoubleClick {
            button: MouseButton::Left,
            ..
        }
    )
}

#[cfg(any(target_os = "macos", test))]
fn macos_tray_icon() -> tauri::image::Image<'static> {
    tauri::include_image!("icons/icon.png")
}

#[cfg(test)]
mod tray_tests {
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent, TrayIconId};
    use tauri::{PhysicalPosition, Rect};

    #[test]
    fn macos_tray_preserves_the_brand_icons_colour_and_transparency() {
        let icon = super::macos_tray_icon();
        assert_eq!(icon.width(), icon.height());
        assert!(icon.width() > 0);
        assert!(
            icon.rgba()
                .chunks_exact(4)
                .any(|pixel| pixel[3] > 0 && pixel[2] > pixel[0])
        );
        assert!(icon.rgba().chunks_exact(4).any(|pixel| pixel[3] == 0));
    }

    fn click(button: MouseButton, button_state: MouseButtonState) -> TrayIconEvent {
        TrayIconEvent::Click {
            id: TrayIconId::new(super::TRAY_ID),
            position: PhysicalPosition::default(),
            rect: Rect::default(),
            button,
            button_state,
        }
    }

    fn double_click(button: MouseButton) -> TrayIconEvent {
        TrayIconEvent::DoubleClick {
            id: TrayIconId::new(super::TRAY_ID),
            position: PhysicalPosition::default(),
            rect: Rect::default(),
            button,
        }
    }

    // 单击留给快捷面板，只有左键双击唤起主窗口。
    #[test]
    fn only_left_double_click_restores_the_main_window() {
        assert!(!super::tray_event_shows_main_window(&click(
            MouseButton::Left,
            MouseButtonState::Up
        )));
        assert!(!super::tray_event_shows_main_window(&click(
            MouseButton::Right,
            MouseButtonState::Up
        )));
        assert!(!super::tray_event_shows_main_window(&click(
            MouseButton::Middle,
            MouseButtonState::Up
        )));
        assert!(!super::tray_event_shows_main_window(&click(
            MouseButton::Left,
            MouseButtonState::Down
        )));
        assert!(super::tray_event_shows_main_window(&double_click(
            MouseButton::Left
        )));
        assert!(!super::tray_event_shows_main_window(&double_click(
            MouseButton::Right
        )));
        assert!(!super::tray_event_shows_main_window(
            &TrayIconEvent::Enter {
                id: TrayIconId::new(super::TRAY_ID),
                position: PhysicalPosition::default(),
                rect: Rect::default(),
            }
        ));
    }
}

/// 按 tauri.conf.json 里 main 窗口的配置创建主窗口（标题、尺寸、最小尺寸、图标），并挂上窗口事件。
/// 只在应用启动时创建，关闭窗口时保留界面。
fn build_main_window<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    url: &str,
    visible: bool,
) -> tauri::Result<tauri::WebviewWindow<R>> {
    let mut main_window_builder = tauri::WebviewWindowBuilder::new(
        app,
        MAIN_WINDOW_LABEL,
        tauri::WebviewUrl::App(url.into()),
    )
    .title("Codex Pilot")
    .visible(visible)
    .focused(visible)
    // 为窄侧栏预留宽度，正文仍可完整操作；配置与实际创建尺寸保持一致。
    .inner_size(1000.0, 760.0)
    .min_inner_size(820.0, 600.0);
    // macOS 内容延伸到窗口顶部，移除独立系统标题栏，同时保留原生窗口按钮。
    // 位置与前端侧栏的 40px 拖动区域配套，不能遮住导航或品牌按钮。
    #[cfg(target_os = "macos")]
    {
        main_window_builder = main_window_builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            .traffic_light_position(tauri::LogicalPosition::new(16.0, 16.0));
    }
    if let Some(icon) = app.default_window_icon().cloned() {
        main_window_builder = main_window_builder.icon(icon)?;
    }
    let main_window = main_window_builder.build()?;
    register_main_window_events(main_window.clone());
    Ok(main_window)
}

fn register_main_window_events<R: tauri::Runtime>(window: tauri::WebviewWindow<R>) {
    let event_window = window.clone();
    let close_event_window = event_window.clone();
    let close_event_app = event_window.app_handle().clone();
    let focus_event_window = event_window.clone();

    event_window.on_window_event(move |event| match event {
        WindowEvent::Focused(true) => {
            // 外部实例通过 Win32 ShowWindow 唤起时，Tao 的 VISIBLE 标记可能仍为 false。
            // 同步框架状态，否则后续 hide() 会被当作重复操作而跳过。
            #[cfg(windows)]
            let _ = focus_event_window.show();
            let _ = focus_event_window.emit(MANAGER_NAVIGATION_EVENT, ());
        }
        WindowEvent::CloseRequested { api, .. } => {
            if APP_EXITING.load(Ordering::SeqCst) {
                return;
            }

            api.prevent_close();
            // Windows 上 Tao 的 VISIBLE 标记可能停在 false（窗口曾被 Win32 直接显示
            // 或隐藏），此时 hide() 会被框架当成重复操作跳过，窗口既不关闭也不隐藏
            // （issue #1542）。先强制同步为可见再隐藏，保证 hide() 真正执行。
            #[cfg(windows)]
            let _ = close_event_window.show();
            let _ = close_event_window.hide();
            set_manager_activation_policy(&close_event_app, false);
        }
        _ => {}
    });
}

#[tauri::command]
fn manager_exit_app<R: tauri::Runtime>(app: tauri::AppHandle<R>) {
    record_shutdown_entry("app.manager_exit_app", shutdown_entry_snapshot(None));
    APP_EXITING.store(true, Ordering::SeqCst);
    app.exit(0);
}

#[tauri::command]
fn manager_hide_to_tray<R: tauri::Runtime>(window: tauri::WebviewWindow<R>) {
    let app_handle = window.app_handle();
    let _ = window.hide();
    set_manager_activation_policy(&app_handle, false);
}

#[tauri::command]
fn update_tray_labels<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    show_label: String,
    quit_label: String,
    window_title: String,
) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let show_item = MenuItem::with_id(&app, TRAY_MENU_SHOW, &show_label, true, None::<&str>);
        let quit_item = MenuItem::with_id(&app, TRAY_MENU_QUIT, &quit_label, true, None::<&str>);
        if let (Ok(show), Ok(quit)) = (show_item, quit_item) {
            if let Ok(menu) = Menu::with_items(&app, &[&show, &quit]) {
                let _ = tray.set_menu(Some(menu));
            }
        }
    }
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.set_title(&window_title);
    }
}

/// 托盘快捷面板的「打开 Codex Pilot」。
pub(crate) fn show_main_window_from<R: tauri::Runtime>(app_handle: &tauri::AppHandle<R>) {
    show_main_window(app_handle);
}

/// 托盘快捷面板的「退出」：与托盘菜单的退出一致。
pub(crate) fn request_app_exit<R: tauri::Runtime>(app_handle: &tauri::AppHandle<R>) {
    APP_EXITING.store(true, Ordering::SeqCst);
    app_handle.exit(0);
}

/// 所有「打开主窗口」的入口（托盘、Dock、二次启动、导航请求、快捷面板）都走这里：
/// 显示并聚焦已创建的主窗口。必须在主线程调用。
fn show_main_window<R: tauri::Runtime>(app_handle: &tauri::AppHandle<R>) {
    tray_panel::hide(app_handle);
    let Some(window) = app_handle.get_webview_window(MAIN_WINDOW_LABEL) else {
        return;
    };
    set_manager_activation_policy(app_handle, true);
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

#[cfg(target_os = "macos")]
fn set_manager_activation_policy<R: tauri::Runtime>(
    app_handle: &tauri::AppHandle<R>,
    main_window_visible: bool,
) {
    // 关闭窗口收起到菜单栏；重新打开窗口时才恢复 Dock 图标。
    let policy = if main_window_visible {
        tauri::ActivationPolicy::Regular
    } else {
        tauri::ActivationPolicy::Accessory
    };
    let _ = app_handle.set_activation_policy(policy);
}

#[cfg(not(target_os = "macos"))]
fn set_manager_activation_policy<R: tauri::Runtime>(
    _app_handle: &tauri::AppHandle<R>,
    _main_window_visible: bool,
) {
}

/// Restores and focuses an existing manager window on desktop platforms.
pub fn focus_existing_manager_window() {
    // 锁持有者在主进程内消费请求，Linux 及隐藏窗口也能重新打开。
    let path = window_activation_request_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let request = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
        .to_string();
    let _ = std::fs::write(path, request);
    #[cfg(windows)]
    {
        let current_process_id = std::process::id();
        for process in codex_plus_core::windows_enumerate_processes() {
            if process.process_id == current_process_id {
                continue;
            }
            if ["codex-pilot.exe", "codex-pilot-manager.exe"]
                .iter()
                .any(|name| process.exe_file.eq_ignore_ascii_case(name))
                && codex_plus_core::windows_activate_process_window(process.process_id)
            {
                break;
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        if let Ok(executable) = std::env::current_exe()
            && let Ok(app) =
                codex_plus_core::install::macos::native_application_bundle_from_executable(
                    &executable,
                )
        {
            let _ = std::process::Command::new("/usr/bin/open")
                .arg(app)
                .status();
        }
    }
}

fn window_activation_request_path() -> std::path::PathBuf {
    codex_plus_core::paths::default_app_state_dir().join(format!(
        "window-activation-{}.request",
        codex_plus_core::ports::manager_guard_port()
    ))
}

fn start_window_activation_listener(app: tauri::AppHandle) {
    let path = window_activation_request_path();
    let mut previous = std::fs::read(&path).unwrap_or_default();
    std::thread::spawn(move || {
        while !SHUTDOWN_STARTED.load(Ordering::SeqCst) {
            std::thread::sleep(std::time::Duration::from_millis(300));
            let current = std::fs::read(&path).unwrap_or_default();
            if !current.is_empty() && current != previous {
                previous = current;
                let app = app.clone();
                let handle = app.clone();
                let _ = handle.run_on_main_thread(move || {
                    show_main_window(&app);
                    let _ = app.emit(MANAGER_NAVIGATION_EVENT, ());
                });
            }
        }
    });
}

fn install_panic_logger() {
    std::panic::set_hook(Box::new(|panic_info| {
        let payload = panic_info
            .payload()
            .downcast_ref::<&str>()
            .map(|message| (*message).to_string())
            .or_else(|| panic_info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "非字符串 panic payload".to_string());
        let location = panic_info.location().map(|location| {
            serde_json::json!({
                "file": location.file(),
                "line": location.line(),
                "column": location.column()
            })
        });
        let _ = codex_plus_core::diagnostic_log::append_diagnostic_log(
            "manager.panic",
            serde_json::json!({
                "payload": payload,
                "location": location
            }),
        );
    }));
}

fn acquire_single_instance_guard() -> Option<codex_plus_core::ports::LoopbackPortGuard> {
    match codex_plus_core::ports::acquire_resilient_loopback_port_guard(
        codex_plus_core::ports::manager_guard_port(),
    ) {
        Ok(guard) => {
            if let Some(fallback_lock_path) = guard.fallback_path() {
                let _ = codex_plus_core::diagnostic_log::append_diagnostic_log(
                    "manager.guard_fallback",
                    serde_json::json!({
                        "requested_guard_port": codex_plus_core::ports::manager_guard_port(),
                        "fallback_lock_path": fallback_lock_path
                    }),
                );
            }
            Some(guard)
        }
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::AddrInUse | std::io::ErrorKind::WouldBlock
            ) =>
        {
            let _ = codex_plus_core::diagnostic_log::append_diagnostic_log(
                "manager.already_running",
                serde_json::json!({
                    "guard_port": codex_plus_core::ports::manager_guard_port()
                }),
            );
            focus_existing_manager_window();
            None
        }
        Err(error) => {
            let _ = codex_plus_core::diagnostic_log::append_diagnostic_log(
                "manager.guard_failed",
                serde_json::json!({
                    "guard_port": codex_plus_core::ports::manager_guard_port(),
                    "error": error.to_string()
                }),
            );
            match std::net::TcpListener::bind(("127.0.0.1", 0)) {
                Ok(listener) => Some(codex_plus_core::ports::LoopbackPortGuard::listener(
                    listener,
                )),
                Err(fallback_error) => {
                    let _ = codex_plus_core::diagnostic_log::append_diagnostic_log(
                        "manager.guard_fallback_failed",
                        serde_json::json!({
                            "error": fallback_error.to_string()
                        }),
                    );
                    None
                }
            }
        }
    }
}

/// 增强设置变化后通知管理器窗口合并当前草稿。
pub(crate) fn notify_settings_changed() {
    if let Some(app) = MANAGER_APP.get() {
        let _ = app.emit("codex-plus-settings-changed", ());
    }
}
static MANAGER_APP: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();
