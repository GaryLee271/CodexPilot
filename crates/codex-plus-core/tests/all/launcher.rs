use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use codex_plus_core::app_paths::{
    build_codex_executable, codex_app_version, derive_packaged_app_user_model_id,
    find_bundled_codex_cli, find_latest_codex_app_dir, find_latest_codex_app_dir_from_roots,
    find_linux_codex_app, find_macos_codex_app, normalize_codex_app_path,
    resolve_codex_app_dir_with_saved, user_data_candidates_from,
};
use codex_plus_core::launcher::{
    CodexLaunch, DefaultLaunchHooks, LaunchHooks, LaunchOptions, MacosCleanupPolicy,
    MacosDebugLaunchAction, browser_identity_changed, build_codex_arguments, build_codex_command,
    build_macos_cleanup_command, build_macos_open_command, build_packaged_activation,
    launch_and_inject_with_hooks, select_macos_debug_launch_action,
};
#[cfg(windows)]
use codex_plus_core::launcher::{WindowsProcessControlStrategy, windows_process_control_strategy};
use codex_plus_core::ports::{
    select_packaged_codex_debug_port_with, select_platform_loopback_port_with,
};
use codex_plus_core::settings::BackendSettings;
use codex_plus_core::status::StatusStore;

/// 用真实 HTTP / WebSocket 连接模拟冷启动：端点先不可用，随后页面和补丁依次就绪。
/// 状态序列由用例提供，避免测试依赖机器性能或真实 Codex 的启动速度。
async fn probe_native_module_launch(
    delayed_targets: bool,
    states: Vec<serde_json::Value>,
) -> (anyhow::Result<()>, Vec<String>) {
    use futures_util::{SinkExt, StreamExt};
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio_tungstenite::tungstenite::Message;

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let states = Arc::new(Mutex::new(VecDeque::from(states)));
    let commands = Arc::new(Mutex::new(Vec::new()));
    let received = commands.clone();
    let target_requests = Arc::new(AtomicUsize::new(0));
    let server = tokio::spawn(async move {
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            let states = states.clone();
            let received = received.clone();
            let target_requests = target_requests.clone();
            tokio::spawn(async move {
                let mut buffer = [0; 8192];
                // 保留握手字节给 tungstenite；等完整请求头，不能把分段握手误认作 HTTP 查询。
                loop {
                    let count = stream.peek(&mut buffer).await.unwrap();
                    if count == 0 {
                        return;
                    }
                    if buffer[..count].windows(4).any(|part| part == b"\r\n\r\n") {
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(1)).await;
                }
                if buffer.starts_with(b"GET /json ") {
                    let request = target_requests.fetch_add(1, Ordering::SeqCst);
                    let (status, body) = if delayed_targets && request == 0 {
                        ("503 Service Unavailable", "[]".to_string())
                    } else if delayed_targets && request == 1 {
                        ("200 OK", "[]".to_string())
                    } else {
                        ("200 OK", serde_json::json!([{
                            "id": "main", "type": "page", "title": "Codex", "url": "app://-/index.html",
                            "webSocketDebuggerUrl": format!("ws://127.0.0.1:{port}/devtools/page/main")
                        }]).to_string())
                    };
                    let response = format!(
                        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    stream.read(&mut buffer).await.unwrap();
                    stream.write_all(response.as_bytes()).await.unwrap();
                    return;
                }
                let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
                while let Some(Ok(Message::Text(message))) = socket.next().await {
                    let request: serde_json::Value = serde_json::from_str(&message).unwrap();
                    let method = request["method"].as_str().unwrap();
                    received.lock().unwrap().push(method.to_string());
                    let result = match method {
                        "Runtime.evaluate" => {
                            let mut states = states.lock().unwrap();
                            let state = if states.len() > 1 {
                                states.pop_front().unwrap()
                            } else {
                                states[0].clone()
                            };
                            serde_json::json!({"result": {"type": "string", "value": state.to_string()}})
                        }
                        "Page.reload" => serde_json::json!({}),
                        _ => panic!("unexpected CDP command: {method}"),
                    };
                    socket
                        .send(Message::Text(
                            serde_json::json!({"id": request["id"], "result": result})
                                .to_string()
                                .into(),
                        ))
                        .await
                        .unwrap();
                }
            });
        }
    });
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        DefaultLaunchHooks::default().apply_native_module_patches_on_launch(port),
    )
    .await
    .expect("原生模块启动检查未在预期时间内完成");
    server.abort();
    let commands = commands.lock().unwrap().clone();
    (result, commands)
}

#[tokio::test]
async fn native_module_launch_waits_for_endpoint_page_and_patch_preparation() {
    let _state = crate::common::IsolatedTestState::new();
    let (result, commands) = probe_native_module_launch(
        true,
        vec![
            serde_json::json!({"ready": false, "compiled": false, "failed": false, "appReady": true}),
            serde_json::json!({"ready": true, "compiled": false, "failed": false, "appReady": true}),
            serde_json::json!({"ready": true, "compiled": true, "failed": false, "appReady": true}),
        ],
    )
    .await;
    result.expect("端点暂不可用、页面未出现、补丁仍在准备时都应继续等待");
    assert_eq!(
        commands,
        [
            "Runtime.evaluate",
            "Runtime.evaluate",
            "Page.reload",
            "Runtime.evaluate"
        ]
    );
}

#[tokio::test]
async fn native_module_launch_waits_for_native_shell_before_and_after_reload() {
    let _state = crate::common::IsolatedTestState::new();
    // 复现本机启动轨迹：补丁准备好时原生仍在 loading，模块执行完成后 React 也尚未挂载。
    // 两个阶段都不能把模块标记当作界面就绪，否则会打断首次启动或误报启动成功。
    let (result, commands) = probe_native_module_launch(
        false,
        vec![
            serde_json::json!({"ready": true, "compiled": false, "failed": false, "appReady": false}),
            serde_json::json!({"ready": true, "compiled": false, "failed": false, "appReady": true}),
            serde_json::json!({"ready": true, "compiled": true, "failed": false, "appReady": false}),
            serde_json::json!({"ready": true, "compiled": true, "failed": false, "appReady": true}),
        ],
    )
    .await;
    result.expect("原生界面就绪后应完成一次补丁重载");
    assert_eq!(
        commands,
        [
            "Runtime.evaluate",
            "Runtime.evaluate",
            "Page.reload",
            "Runtime.evaluate",
            "Runtime.evaluate"
        ],
        "首次主界面出现前禁止重载，补丁执行后仍需等待真实主界面"
    );
}

#[tokio::test]
async fn native_module_launch_does_not_reload_compiled_or_unsupported_pages() {
    let _state = crate::common::IsolatedTestState::new();
    for failed in [false, true] {
        let (result, commands) = probe_native_module_launch(
            false,
            vec![serde_json::json!({"ready": true, "compiled": !failed, "failed": failed, "appReady": true})],
        )
        .await;
        assert_eq!(result.is_err(), failed);
        assert_eq!(commands, ["Runtime.evaluate"]);
    }
}

#[test]
fn browser_identity_change_requires_two_distinct_observations() {
    assert!(!browser_identity_changed(None, "browser-a"));
    assert!(!browser_identity_changed(Some("browser-a"), "browser-a"));
    assert!(browser_identity_changed(Some("browser-a"), "browser-b"));
}

#[tokio::test]
async fn fake_launch_does_not_connect_to_cdp_after_successful_injection() {
    let _state = crate::common::IsolatedTestState::new();
    let temp = tempfile::tempdir().unwrap();
    let app_dir = temp.path().join("Codex.app");
    std::fs::create_dir(&app_dir).unwrap();
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let hooks = FakeHooks::new(Arc::new(Mutex::new(Vec::new())));
    let handle = launch_and_inject_with_hooks(
        LaunchOptions {
            app_dir: Some(app_dir),
            debug_port: listener.local_addr().unwrap().port(),
            status_store: StatusStore::new(temp.path().join("status.json")),
            ..LaunchOptions::default()
        },
        &hooks,
    )
    .await
    .unwrap();
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(100), listener.accept())
            .await
            .is_err()
    );
    handle.wait_for_codex_exit().await.unwrap();
}

#[tokio::test]
async fn launch_receipt_status_and_injection_follow_final_wrapper_port() {
    let _state = crate::common::IsolatedTestState::new();
    let temp = tempfile::tempdir().unwrap();
    let app = temp.path().join("Codex.app");
    std::fs::create_dir(&app).unwrap();
    let events = Arc::new(Mutex::new(Vec::new()));
    let hooks = FakeHooks::new(events.clone()).with_launch_result(CodexLaunch::Process {
        command: vec!["ChatGPT.exe".into(), "--remote-debugging-port=19451".into()],
        wait_strategy: codex_plus_core::launcher::ProcessWaitStrategy::ExternalWaitCommand,
        macos_cleanup_policy: None,
    });
    let handle = launch_and_inject_with_hooks(
        LaunchOptions {
            app_dir: Some(app),
            debug_port: 19450,
            status_store: StatusStore::new(temp.path().join("status.json")),
            codex_home: Some(temp.path().join("codex-home")),
            sqlite_home: Some(temp.path().join("sqlite-home")),
            state_dir: Some(temp.path().join("state")),
            replace_blocking_main_instance: false,
        },
        &hooks,
    )
    .await
    .unwrap();
    assert_eq!(handle.debug_port, 19451);
    let status = handle.status_store.load_latest().unwrap().unwrap();
    assert_eq!(status.debug_port, Some(19451));
    assert!(events.lock().unwrap().contains(&"inject:19451".into()));
    assert!(
        !events
            .lock()
            .unwrap()
            .contains(&"inject:19450:19452".into())
    );
}

#[test]
fn app_paths_find_latest_windows_package_prefers_highest_version_app_dir() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(temp.path().join("OpenAI.Codex_1.2.3.0_x64__abc/app")).unwrap();
    std::fs::create_dir_all(temp.path().join("OpenAI.Codex_26.429.8261.0_x64__abc/app")).unwrap();
    std::fs::create_dir_all(temp.path().join("OpenAI.Codex_not-a-version_x64__abc")).unwrap();

    let latest = find_latest_codex_app_dir(temp.path()).unwrap();

    assert_eq!(
        latest,
        temp.path().join("OpenAI.Codex_26.429.8261.0_x64__abc/app")
    );
}

#[test]
fn app_paths_find_latest_windows_package_accepts_chatgpt_desktop_migration() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(temp.path().join("OpenAI.Codex_26.707.3748.0_x64__abc/app")).unwrap();
    std::fs::create_dir_all(
        temp.path()
            .join("OpenAI.ChatGPT-Desktop_1.2026.133.0_x64__abc/app"),
    )
    .unwrap();
    std::fs::create_dir_all(
        temp.path()
            .join("OpenAI.ChatGPT-Desktop_2026.514.421.0_neutral_~_abc/app"),
    )
    .unwrap();

    let latest = find_latest_codex_app_dir(temp.path()).unwrap();

    assert_eq!(
        latest,
        temp.path()
            .join("OpenAI.ChatGPT-Desktop_2026.514.421.0_neutral_~_abc")
            .join("app")
    );
    assert_eq!(
        codex_app_version(&latest).as_deref(),
        Some("2026.514.421.0")
    );
    assert_eq!(
        derive_packaged_app_user_model_id(&latest).as_deref(),
        Some("OpenAI.ChatGPT-Desktop_abc!App")
    );
}

#[test]
fn app_paths_find_latest_windows_package_detects_beta_package() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(
        temp.path()
            .join("OpenAI.CodexBeta_26.527.7698.0_x64__2p2nqsd0c76g0/app"),
    )
    .unwrap();

    let latest = find_latest_codex_app_dir(temp.path()).unwrap();

    assert_eq!(
        latest,
        temp.path()
            .join("OpenAI.CodexBeta_26.527.7698.0_x64__2p2nqsd0c76g0/app")
    );
    assert_eq!(codex_app_version(&latest).as_deref(), Some("26.527.7698.0"));
    assert_eq!(
        derive_packaged_app_user_model_id(&latest).as_deref(),
        Some("OpenAI.CodexBeta_2p2nqsd0c76g0!App")
    );
}

#[test]
fn app_paths_find_latest_windows_package_returns_package_when_app_dir_missing() {
    let temp = tempfile::tempdir().unwrap();
    let package = temp.path().join("OpenAI.Codex_26.429.8261.0_x64__abc");
    std::fs::create_dir_all(&package).unwrap();
    std::fs::write(package.join("ChatGPT.exe"), "").unwrap();

    assert_eq!(find_latest_codex_app_dir(temp.path()).unwrap(), package);
}

#[test]
fn app_paths_find_latest_windows_package_checks_roots_before_fallback() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("WindowsApps");
    std::fs::create_dir_all(root.join("OpenAI.Codex_1.0.0.0_x64__abc/app")).unwrap();
    std::fs::create_dir_all(root.join("OpenAI.Codex_26.513.3673.0_x64__abc/app")).unwrap();

    let latest = find_latest_codex_app_dir_from_roots(&[root]).unwrap();

    assert!(latest.ends_with("OpenAI.Codex_26.513.3673.0_x64__abc/app"));
}

#[cfg(windows)]
#[test]
fn app_paths_keep_explicit_store_path_override_without_re_resolving() {
    let temp = tempfile::tempdir().unwrap();
    let explicit = temp
        .path()
        .join("OpenAI.Codex_26.707.3748.0_x64__abc")
        .join("app");
    std::fs::create_dir_all(&explicit).unwrap();

    let resolved = resolve_codex_app_dir_with_saved(Some(&explicit), None);

    assert_eq!(resolved.as_deref(), Some(explicit.as_path()));
}

#[test]
fn app_paths_find_latest_windows_package_accepts_chatgpt_migration_across_roots() {
    let temp = tempfile::tempdir().unwrap();
    let root_a = temp.path().join("WindowsAppsA");
    let root_b = temp.path().join("WindowsAppsB");
    std::fs::create_dir_all(root_a.join("OpenAI.Codex_26.999.0.0_x64__abc/app")).unwrap();
    std::fs::create_dir_all(root_b.join("OpenAI.ChatGPT-Desktop_1.2026.133.0_x64__abc/app"))
        .unwrap();

    let latest = find_latest_codex_app_dir_from_roots(&[root_a, root_b]).unwrap();

    assert!(latest.ends_with("OpenAI.ChatGPT-Desktop_1.2026.133.0_x64__abc/app"));
}

#[test]
fn app_paths_extracts_codex_version_from_windows_package_app_dir() {
    let app_dir =
        PathBuf::from(r"C:\Program Files\WindowsApps\OpenAI.Codex_26.513.3673.0_x64__abc\app");

    assert_eq!(
        codex_app_version(&app_dir).as_deref(),
        Some("26.513.3673.0")
    );
}

#[test]
fn app_paths_extracts_codex_version_from_portable_version_file() {
    let temp = tempfile::tempdir().unwrap();
    let app_dir = temp.path().join("versions").join("current");
    std::fs::create_dir_all(&app_dir).unwrap();
    std::fs::write(app_dir.join("Codex.exe"), "").unwrap();
    std::fs::write(app_dir.join("version"), "42.1.0\n").unwrap();

    assert_eq!(codex_app_version(&app_dir).as_deref(), Some("42.1.0"));
}

#[test]
fn app_paths_prefers_portable_directory_version_over_internal_version_file() {
    let temp = tempfile::tempdir().unwrap();
    let app_dir = temp.path().join("versions").join("26.519.2736.0");
    std::fs::create_dir_all(&app_dir).unwrap();
    std::fs::write(app_dir.join("Codex.exe"), "").unwrap();
    std::fs::write(app_dir.join("version"), "42.1.0\n").unwrap();

    assert_eq!(
        codex_app_version(&app_dir).as_deref(),
        Some("26.519.2736.0")
    );
}

#[cfg(windows)]
#[test]
fn app_paths_resolves_portable_current_link_to_directory_version() {
    let temp = tempfile::tempdir().unwrap();
    let versions = temp.path().join("versions");
    let target = versions.join("26.519.2736.0");
    let current = versions.join("current");
    std::fs::create_dir_all(&target).unwrap();
    std::fs::write(target.join("Codex.exe"), "").unwrap();
    std::fs::write(target.join("version"), "42.1.0\n").unwrap();
    // Windows 创建目录符号链接需要额外特权；无权限的机器跳过这个环境专用回归。
    if std::os::windows::fs::symlink_dir(&target, &current).is_err() {
        return;
    }

    assert_eq!(
        codex_app_version(&current).as_deref(),
        Some("26.519.2736.0")
    );
}

#[test]
fn app_paths_extracts_codex_version_from_macos_bundle_plist() {
    let temp = tempfile::tempdir().unwrap();
    let app = temp.path().join("OpenAI Codex.app");
    let contents = app.join("Contents");
    std::fs::create_dir_all(&contents).unwrap();
    std::fs::write(
        contents.join("Info.plist"),
        r#"<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>CFBundleVersion</key>
  <string>26.500.0</string>
  <key>CFBundleShortVersionString</key>
  <string>26.513.3673</string>
</dict>
</plist>
"#,
    )
    .unwrap();

    assert_eq!(codex_app_version(&app).as_deref(), Some("26.513.3673"));
}

#[test]
fn app_paths_user_data_candidates_include_local_and_roaming_variants() {
    let local = PathBuf::from(r"C:\Users\me\AppData\Local");
    let roaming = PathBuf::from(r"C:\Users\me\AppData\Roaming");

    let candidates = user_data_candidates_from(Some(&local), Some(&roaming));

    assert_eq!(
        candidates,
        vec![
            local.join("OpenAI").join("ChatGPT"),
            local.join("OpenAI.ChatGPT-Desktop"),
            local.join("ChatGPT"),
            local.join("OpenAI").join("Codex"),
            local.join("OpenAI.Codex"),
            local.join("Codex"),
            roaming.join("OpenAI").join("ChatGPT"),
            roaming.join("OpenAI.ChatGPT-Desktop"),
            roaming.join("ChatGPT"),
            roaming.join("OpenAI").join("Codex"),
            roaming.join("OpenAI.Codex"),
            roaming.join("Codex"),
        ]
    );
}

#[test]
fn app_paths_find_macos_codex_app_prefers_first_search_root_and_known_names() {
    let temp = tempfile::tempdir().unwrap();
    let system_root = temp.path().join("Applications");
    let user_root = temp.path().join("Users/me/Applications");
    let system_app = system_root.join("OpenAI Codex.app");
    let user_app = user_root.join("Codex.app");
    std::fs::create_dir_all(&system_app).unwrap();
    std::fs::create_dir_all(&user_app).unwrap();

    assert_eq!(
        find_macos_codex_app(&[system_root, user_root]).unwrap(),
        system_app
    );
}

#[test]
fn app_paths_prefers_codex_app_over_chatgpt_app() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("Applications");
    let codex = root.join("Codex.app");
    let chatgpt = root.join("ChatGPT.app");
    std::fs::create_dir_all(&codex).unwrap();
    std::fs::create_dir_all(&chatgpt).unwrap();

    assert_eq!(
        find_macos_codex_app(&[root]).as_deref(),
        Some(codex.as_path())
    );
}

#[test]
fn app_paths_preserves_legacy_macos_candidates_before_chatgpt_app() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("Applications");
    let legacy = root.join("OpenAI Codex.app");
    let chatgpt = root.join("ChatGPT.app");
    std::fs::create_dir_all(&legacy).unwrap();
    std::fs::create_dir_all(&chatgpt).unwrap();

    assert_eq!(
        find_macos_codex_app(&[root]).as_deref(),
        Some(legacy.as_path())
    );
}

#[test]
fn app_paths_build_macos_bundle_executable() {
    let app = PathBuf::from("/Applications/OpenAI Codex.app");

    assert_eq!(
        build_codex_executable(&app),
        PathBuf::from("/Applications/OpenAI Codex.app/Contents/MacOS/Codex")
    );
}

#[test]
fn app_paths_finds_macos_bundled_codex_cli() {
    let temp = tempfile::tempdir().unwrap();
    let app = temp.path().join("ChatGPT.app");
    let cli = app.join("Contents/Resources/codex");
    std::fs::create_dir_all(cli.parent().unwrap()).unwrap();
    std::fs::write(&cli, "").unwrap();

    assert_eq!(find_bundled_codex_cli(&app).as_deref(), Some(cli.as_path()));
}

#[test]
fn app_paths_finds_windows_bundled_codex_cli() {
    let temp = tempfile::tempdir().unwrap();
    let app = temp.path().join("OpenAI.Codex_1.0.0.0_x64__abc/app");
    let cli = app.join("resources/codex.exe");
    std::fs::create_dir_all(cli.parent().unwrap()).unwrap();
    std::fs::write(&cli, "").unwrap();

    assert_eq!(find_bundled_codex_cli(&app).as_deref(), Some(cli.as_path()));
}

#[test]
fn app_paths_returns_none_when_bundled_codex_cli_is_missing() {
    let temp = tempfile::tempdir().unwrap();
    let app = temp.path().join("ChatGPT.app");
    std::fs::create_dir_all(app.join("Contents/Resources")).unwrap();

    assert_eq!(find_bundled_codex_cli(&app), None);
}

#[test]
fn app_paths_finds_chatgpt_bundle_and_uses_its_declared_executable() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("Applications");
    let app = root.join("ChatGPT.app");
    let contents = app.join("Contents");
    let macos = contents.join("MacOS");
    std::fs::create_dir_all(&macos).unwrap();
    std::fs::write(
        contents.join("Info.plist"),
        r#"<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>com.openai.codex</string>
  <key>CFBundleExecutable</key>
  <string>ChatGPT</string>
</dict>
</plist>
"#,
    )
    .unwrap();
    std::fs::write(macos.join("ChatGPT"), "").unwrap();

    assert_eq!(
        find_macos_codex_app(&[root]).as_deref(),
        Some(app.as_path())
    );
    assert_eq!(build_codex_executable(&app), macos.join("ChatGPT"));
}

#[test]
fn app_paths_normalizes_executable_and_package_paths() {
    let temp = tempfile::tempdir().unwrap();
    let portable = temp.path().join("CodexPortable");
    let app = portable.join("app");
    std::fs::create_dir_all(&app).unwrap();
    std::fs::write(app.join("Codex.exe"), "").unwrap();
    std::fs::create_dir(app.join("resources")).unwrap();
    std::fs::write(app.join("resources/app.asar"), "electron").unwrap();

    assert_eq!(
        normalize_codex_app_path(&app.join("Codex.exe")).as_deref(),
        Some(app.as_path())
    );
    assert_eq!(
        normalize_codex_app_path(&portable).as_deref(),
        Some(app.as_path())
    );
}

#[test]
fn app_paths_prefers_chatgpt_entrypoint_when_portable_bundle_contains_codex_shim() {
    let temp = tempfile::tempdir().unwrap();
    let app = temp.path().join("current");
    std::fs::create_dir_all(&app).unwrap();
    std::fs::write(app.join("Codex.exe"), "").unwrap();
    std::fs::write(app.join("ChatGPT.exe"), "").unwrap();

    assert_eq!(build_codex_executable(&app), app.join("ChatGPT.exe"));
}

#[test]
fn app_paths_normalizes_chatgpt_desktop_executable_and_builds_it() {
    let temp = tempfile::tempdir().unwrap();
    let app = temp
        .path()
        .join("OpenAI.Codex_1.2026.133.0_x64__abc")
        .join("app");
    std::fs::create_dir_all(&app).unwrap();
    std::fs::write(app.join("ChatGPT.exe"), "").unwrap();

    assert_eq!(
        normalize_codex_app_path(&app.join("ChatGPT.exe")).as_deref(),
        Some(app.as_path())
    );
    assert_eq!(build_codex_executable(&app), app.join("ChatGPT.exe"));
    assert_eq!(
        derive_packaged_app_user_model_id(&app).as_deref(),
        Some("OpenAI.Codex_abc!App")
    );
}

#[test]
fn app_paths_saved_path_is_used_when_no_explicit_path_is_provided() {
    let temp = tempfile::tempdir().unwrap();
    let app = temp.path().join("Codex.app");
    std::fs::create_dir_all(&app).unwrap();

    assert_eq!(
        resolve_codex_app_dir_with_saved(None, Some(&app.to_string_lossy())).as_deref(),
        Some(app.as_path())
    );
}

#[test]
fn app_paths_rejects_codex_plus_plus_install_dir_as_codex_app() {
    let temp = tempfile::tempdir().unwrap();
    let manager = temp.path().join("Programs").join("Codex Pilot");
    std::fs::create_dir_all(&manager).unwrap();
    // 真实安装根里是产品自己的文件：管理工具二进制 + 卸载器（见 install/windows.rs）。
    std::fs::write(manager.join("codex-pilot-manager.exe"), "").unwrap();
    std::fs::write(manager.join("uninstall.exe"), "").unwrap();

    assert_eq!(normalize_codex_app_path(&manager), None);
    assert_eq!(
        normalize_codex_app_path(&manager.join("codex-pilot-manager.exe")),
        None
    );

    let resolved = resolve_codex_app_dir_with_saved(None, Some(&manager.to_string_lossy()));
    assert_ne!(resolved.as_deref(), Some(manager.as_path()));
}

#[test]
fn app_paths_accepts_real_codex_inside_a_codex_plus_plus_named_directory() {
    // issue #1036：用户把真正的 Codex 放在 C:\codex++ 下，按目录名一刀切会连真
    // Codex 一起拒掉（版本为 null、启动报 failed to launch）。目录名只是线索，
    // 没有本产品文件时应当放行。
    let temp = tempfile::tempdir().unwrap();
    let app_dir = temp.path().join("codex++");
    std::fs::create_dir_all(&app_dir).unwrap();
    std::fs::write(app_dir.join("Codex.exe"), "").unwrap();
    std::fs::create_dir(app_dir.join("resources")).unwrap();
    std::fs::write(app_dir.join("resources/app.asar"), "electron").unwrap();

    assert_eq!(
        normalize_codex_app_path(&app_dir).as_deref(),
        Some(app_dir.as_path())
    );
    assert_eq!(
        normalize_codex_app_path(&app_dir.join("Codex.exe")).as_deref(),
        Some(app_dir.as_path())
    );
}

#[test]
fn app_paths_rejects_codex_plus_plus_app_bundle_by_its_macos_executable() {
    // macOS 布局：安装根下是 Codex Pilot.app，Contents/MacOS 里是 bundle 可执行文件名。
    let temp = tempfile::tempdir().unwrap();
    let bundle = temp.path().join("Applications").join("Codex Pilot.app");
    let macos_dir = bundle.join("Contents").join("MacOS");
    std::fs::create_dir_all(&macos_dir).unwrap();
    std::fs::write(macos_dir.join("CodexPilotManager"), "").unwrap();

    assert_eq!(normalize_codex_app_path(&bundle), None);
    assert_eq!(
        normalize_codex_app_path(&macos_dir.join("CodexPilotManager")),
        None
    );
}

#[test]
fn app_paths_reads_version_from_unpacked_manifest_file_name() {
    // issue #1160：免安装/自解包目录（…\Codex\app）没有 MSIX 包目录名也没有
    // version 文件，只有以版本号命名的清单文件。
    let temp = tempfile::tempdir().unwrap();
    let app_dir = temp.path().join("Codex").join("app");
    std::fs::create_dir_all(&app_dir).unwrap();
    std::fs::write(app_dir.join("Codex.exe"), "").unwrap();
    std::fs::write(app_dir.join("149.0.7827.115.manifest"), "").unwrap();

    assert_eq!(
        codex_app_version(&app_dir).as_deref(),
        Some("149.0.7827.115")
    );
}

#[test]
fn app_paths_manifest_version_picks_numerically_highest_and_ignores_noise() {
    let temp = tempfile::tempdir().unwrap();
    let app_dir = temp.path().join("Codex").join("app");
    std::fs::create_dir_all(&app_dir).unwrap();
    std::fs::write(app_dir.join("Codex.exe"), "").unwrap();
    // 字符串比较会把 "115" 判成小于 "20"，必须按数值比较。
    std::fs::write(app_dir.join("149.0.7827.20.manifest"), "").unwrap();
    std::fs::write(app_dir.join("149.0.7827.115.manifest"), "").unwrap();
    // 非版本号命名的清单不能吞进来。
    std::fs::write(app_dir.join("app.manifest"), "").unwrap();
    std::fs::write(app_dir.join("uninstall.manifest"), "").unwrap();

    assert_eq!(
        codex_app_version(&app_dir).as_deref(),
        Some("149.0.7827.115")
    );
}

#[test]
fn app_paths_manifest_version_does_not_override_explicit_version_file() {
    // version 文件是更明确的信号，manifest 只是兜底。
    let temp = tempfile::tempdir().unwrap();
    let app_dir = temp.path().join("versions").join("current");
    std::fs::create_dir_all(&app_dir).unwrap();
    std::fs::write(app_dir.join("Codex.exe"), "").unwrap();
    std::fs::write(app_dir.join("version"), "42.1.0\n").unwrap();
    std::fs::write(app_dir.join("149.0.7827.115.manifest"), "").unwrap();

    assert_eq!(codex_app_version(&app_dir).as_deref(), Some("42.1.0"));
}

#[test]
fn app_paths_rejects_plain_directory_without_codex_executable() {
    let temp = tempfile::tempdir().unwrap();
    let plain = temp.path().join("not-a-codex-app");
    std::fs::create_dir_all(&plain).unwrap();
    std::fs::write(plain.join("readme.txt"), "nope").unwrap();

    assert_eq!(normalize_codex_app_path(&plain), None);
    assert_eq!(normalize_codex_app_path(&plain.join("readme.txt")), None);
}

#[test]
fn app_paths_empty_saved_path_matches_no_saved_path() {
    assert_eq!(
        resolve_codex_app_dir_with_saved(None, Some("")),
        resolve_codex_app_dir_with_saved(None, None)
    );
    assert_eq!(
        resolve_codex_app_dir_with_saved(None, Some("   ")),
        resolve_codex_app_dir_with_saved(None, None)
    );
}

#[test]
fn app_paths_invalid_saved_path_falls_back_instead_of_sticking() {
    let temp = tempfile::tempdir().unwrap();
    let junk = temp.path().join("Codex Pilot");
    std::fs::create_dir_all(&junk).unwrap();

    // 合法独立安装：即使 saved 指向 Codex Pilot，规范化失败后应能落到该候选
    // （通过显式 app_dir 验证回退链之外的合法路径仍可用）
    let standalone = temp.path().join("Programs").join("OpenAI").join("Codex");
    std::fs::create_dir_all(&standalone).unwrap();
    std::fs::write(standalone.join("codex.exe"), "").unwrap();
    std::fs::create_dir(standalone.join("resources")).unwrap();
    std::fs::write(standalone.join("resources/app.asar"), "electron").unwrap();

    assert_eq!(normalize_codex_app_path(&junk), None);
    assert_eq!(
        normalize_codex_app_path(&standalone).as_deref(),
        Some(standalone.as_path())
    );
    assert_eq!(
        resolve_codex_app_dir_with_saved(Some(&standalone), Some(&junk.to_string_lossy()))
            .as_deref(),
        Some(standalone.as_path())
    );
}

#[test]
fn app_paths_rejects_nonexistent_and_empty_directories() {
    let temp = tempfile::tempdir().unwrap();
    // 根本不存在的路径（例如探测生成的候选）不能被误认成应用目录或退回父目录
    let nonexistent = temp.path().join("Codex");
    assert_eq!(normalize_codex_app_path(&nonexistent), None);

    // 即使存在名为 Codex 或 ChatGPT 的空目录，若无有效可执行文件也应拒绝
    let empty_codex = temp.path().join("empty-dir").join("Codex");
    std::fs::create_dir_all(&empty_codex).unwrap();
    assert_eq!(normalize_codex_app_path(&empty_codex), None);
}

/// Linux 的可执行文件名是无扩展名的 `ChatGPT` / `Codex`，而这两个名字只在
/// Linux 构建里被 `is_supported_app_executable_name` / `executable_in_dir`
/// 认作有效，`linux_app_candidates` 的目录扫描也在 `cfg(target_os = "linux")` 内。
/// 因此本测试只在 Linux 上有意义——其他平台上 `normalize_codex_app_path`
/// 正确地返回 None，断言必然失败。
#[cfg(target_os = "linux")]
#[test]
fn app_paths_linux_detects_chatgpt_executable_and_builds_it() {
    let temp = tempfile::tempdir().unwrap();
    let app = temp.path().join("usr").join("lib").join("chatgpt");
    std::fs::create_dir_all(&app).unwrap();
    let bin = app.join("ChatGPT");
    std::fs::write(&bin, "").unwrap();
    std::fs::create_dir(app.join("resources")).unwrap();
    std::fs::write(app.join("resources/app.asar"), "electron").unwrap();
    std::fs::write(app.join("version"), "42.3.0").unwrap();

    // 传入目录
    assert_eq!(
        normalize_codex_app_path(&app).as_deref(),
        Some(app.as_path())
    );
    // 传入可执行文件本身
    assert_eq!(
        normalize_codex_app_path(&bin).as_deref(),
        Some(app.as_path())
    );
    // 版本读取
    assert_eq!(codex_app_version(&app).as_deref(), Some("42.3.0"));
    assert_eq!(build_codex_executable(&app), bin);
}

#[cfg(target_os = "linux")]
#[test]
fn app_paths_linux_finds_codex_app_from_search_roots_avoiding_empty_opt() {
    let temp = tempfile::tempdir().unwrap();
    // 模拟 /opt（空目录）
    let opt = temp.path().join("opt");
    std::fs::create_dir_all(&opt).unwrap();

    // 模拟 /usr/lib/chatgpt/ChatGPT
    let usr_lib = temp.path().join("usr").join("lib");
    let chatgpt_dir = usr_lib.join("chatgpt");
    std::fs::create_dir_all(&chatgpt_dir).unwrap();
    std::fs::write(chatgpt_dir.join("ChatGPT"), "").unwrap();
    std::fs::create_dir(chatgpt_dir.join("resources")).unwrap();
    std::fs::write(chatgpt_dir.join("resources/app.asar"), "electron").unwrap();

    let roots = vec![opt, usr_lib];
    assert_eq!(
        find_linux_codex_app(&roots).as_deref(),
        Some(chatgpt_dir.as_path())
    );
}

#[test]
#[cfg(target_os = "linux")]
fn live_system_resolves_chatgpt_on_linux_when_installed() {
    let resolved = codex_plus_core::app_paths::resolve_codex_app_dir(None);
    if Path::new("/usr/lib/chatgpt").is_dir() {
        assert_eq!(resolved.as_deref(), Some(Path::new("/usr/lib/chatgpt")));
        let exe = codex_plus_core::app_paths::build_codex_executable(&resolved.unwrap());
        assert_eq!(exe, PathBuf::from("/usr/lib/chatgpt/ChatGPT"));
    }
}

#[test]
fn launcher_builds_debug_arguments_and_commands() {
    let app_dir = PathBuf::from(r"C:\Codex\app");

    assert_eq!(
        build_codex_arguments(9229, &[]),
        vec![
            "--remote-debugging-port=9229".to_string(),
            "--remote-allow-origins=http://127.0.0.1:9229".to_string(),
        ]
    );
    let command = build_codex_command(&app_dir, 9229, &[]);
    assert_eq!(command[1], "--remote-debugging-port=9229");
    assert_eq!(command[2], "--remote-allow-origins=http://127.0.0.1:9229");
}

#[test]
fn launcher_does_not_override_codex_app_environment() {
    let source = include_str!("../../src/launcher.rs");

    assert!(!source.contains(".envs(codex_process_environment())"));
    assert!(!source.contains("activate_packaged_app_with_environment"));
    assert!(!source.contains("with_temporary_proxy_environment"));
}

#[test]
fn launcher_uses_all_com_server_contexts_for_packaged_app_activation() {
    let source = include_str!("../../src/launcher.rs");

    assert!(source.contains("CoCreateInstance(&ApplicationActivationManager, None, CLSCTX_ALL)?"));
    assert!(!source.contains("CLSCTX_LOCAL_SERVER"));
}

#[test]
fn launcher_does_not_prepare_projectless_main_window() {
    let source = include_str!("../../src/launcher.rs");

    assert!(!source.contains("prepare_projectless_main_window_nonfatal"));
    assert!(!source.contains("launcher.prelaunch"));
}

#[test]
fn launcher_appends_extra_codex_arguments_after_debug_arguments() {
    let app_dir = PathBuf::from(r"C:\Codex\app");
    let extra_args = vec![
        "--force_high_performance_gpu".to_string(),
        "  ".to_string(),
        "--enable-features=UseOzonePlatform".to_string(),
    ];

    assert_eq!(
        build_codex_arguments(9229, &extra_args),
        vec![
            "--remote-debugging-port=9229".to_string(),
            "--remote-allow-origins=http://127.0.0.1:9229".to_string(),
            "--force_high_performance_gpu".to_string(),
            "--enable-features=UseOzonePlatform".to_string(),
        ]
    );
    let command = build_codex_command(&app_dir, 9229, &extra_args);
    assert_eq!(command[1], "--remote-debugging-port=9229");
    assert_eq!(command[2], "--remote-allow-origins=http://127.0.0.1:9229");
    assert_eq!(command[3], "--force_high_performance_gpu");
    assert_eq!(command[4], "--enable-features=UseOzonePlatform");
}

#[test]
fn launcher_settings_discard_retired_startup_flags() {
    for old_value in [
        serde_json::json!(true),
        serde_json::json!(false),
        serde_json::json!("legacy"),
    ] {
        let settings: BackendSettings = serde_json::from_value(serde_json::json!({
            "codexAppFastStartup": old_value,
            "codexExtraArgs": ["--host-resolver-rules=MAP example.test 127.0.0.1"],
        }))
        .unwrap();
        let saved = serde_json::to_value(&settings).unwrap();
        assert!(saved.get("codexAppFastStartup").is_none());
        assert!(saved.get("codexExtraArgs").is_none());
    }
}

#[test]
fn launcher_constructs_windows_packaged_activation_without_real_app() {
    let app_dir = PathBuf::from(
        r"C:\Program Files\WindowsApps\OpenAI.Codex_26.506.2212.0_x64__2p2nqsd0c76g0\app",
    );

    // 这里验证的是「目录名 → AUMID」这条推导规则；包是否已在系统注册属于另一层
    // （packaged_app_user_model_id，见 app_paths.rs 的单元测试），测试机上无从构造。
    let aumid = derive_packaged_app_user_model_id(&app_dir).unwrap();
    assert_eq!(aumid, "OpenAI.Codex_2p2nqsd0c76g0!App");
    assert_eq!(
        build_packaged_activation(&aumid, 9229, &[]),
        CodexLaunch::PackagedActivation {
            app_user_model_id: "OpenAI.Codex_2p2nqsd0c76g0!App".to_string(),
            arguments: "--remote-debugging-port=9229 --remote-allow-origins=http://127.0.0.1:9229"
                .to_string(),
            process_id: None,
        }
    );
}

#[test]
fn derive_packaged_app_user_model_id_reads_application_id_from_manifest() {
    // 新版 ChatGPT Desktop 可能调整 manifest 中的 Application Id（见 issue #2148）。
    // 这段校验曾被 #2202 的 799ef0c9 静默回退掉，导致 #2308/#2310 的「该进程没有
    // 程序包标识符」；恢复实现时一并恢复测试，避免再次无声丢失。
    let temp = tempfile::tempdir().unwrap();
    let package_dir = temp
        .path()
        .join("OpenAI.ChatGPT-Desktop_1.2026.190.0_x64__2p2nqsd0c76g0");
    let app_dir = package_dir.join("app");
    std::fs::create_dir_all(&app_dir).unwrap();
    std::fs::write(
        package_dir.join("AppxManifest.xml"),
        concat!(
            "<?xml version=\"1.0\" encoding=\"utf-8\"?>",
            "<Package xmlns=\"http://schemas.microsoft.com/appx/manifest/foundation/windows10\"> ",
            "<Applications><Application Id=\"ChatGPTDesktop\" ",
            "Executable=\"app\\ChatGPT.exe\" EntryPoint=\"Windows.FullTrustApplication\"/>",
            "</Applications></Package>"
        ),
    )
    .unwrap();

    assert_eq!(
        derive_packaged_app_user_model_id(&app_dir).as_deref(),
        Some("OpenAI.ChatGPT-Desktop_2p2nqsd0c76g0!ChatGPTDesktop")
    );
}

#[test]
fn derive_packaged_app_user_model_id_falls_back_to_default_id_without_manifest() {
    // manifest 缺失/不可读时保持旧行为（仍使用历史默认值 "App"）。
    let temp = tempfile::tempdir().unwrap();
    let package_dir = temp
        .path()
        .join("OpenAI.Codex_26.506.2212.0_x64__2p2nqsd0c76g0");
    let app_dir = package_dir.join("app");
    std::fs::create_dir_all(&app_dir).unwrap();

    assert_eq!(
        derive_packaged_app_user_model_id(&app_dir).as_deref(),
        Some("OpenAI.Codex_2p2nqsd0c76g0!App")
    );
}

#[test]
fn launcher_packaged_activation_appends_extra_codex_arguments() {
    let app_dir = PathBuf::from(
        r"C:\Program Files\WindowsApps\OpenAI.Codex_26.506.2212.0_x64__2p2nqsd0c76g0\app",
    );
    let extra_args = vec!["--force_high_performance_gpu".to_string()];
    let aumid = derive_packaged_app_user_model_id(&app_dir).unwrap();

    assert_eq!(
        build_packaged_activation(&aumid, 9229, &extra_args),
        CodexLaunch::PackagedActivation {
            app_user_model_id: "OpenAI.Codex_2p2nqsd0c76g0!App".to_string(),
            arguments:
                "--remote-debugging-port=9229 --remote-allow-origins=http://127.0.0.1:9229 --force_high_performance_gpu"
                    .to_string(),
            process_id: None,
        }
    );
}

#[test]
fn launcher_packaged_activation_can_preserve_process_id() {
    let launch = CodexLaunch::PackagedActivation {
        app_user_model_id: "OpenAI.Codex_2p2nqsd0c76g0!App".to_string(),
        arguments: "--remote-debugging-port=9229".to_string(),
        process_id: Some(4242),
    };

    assert_eq!(launch.process_id(), Some(4242));
}

#[test]
fn launcher_keeps_packaged_codex_taskbar_identity_and_icons() {
    let source = include_str!("../../src/launcher.rs");
    // 打包版 Codex 必须保留包自身的 AppUserModelID，否则任务栏白图标且不与原应用合并（#2499、#2668）。
    for forbidden in [
        "apply_codexpilot_taskbar_after_launch",
        "apply_codexpilot_taskbar_to_process_window",
        "apply_codexpilot_window_icon",
        "apply_native_codex_taskbar",
        "apply_codexpilot_icon",
        "windows_apply_codexpilot_icon",
        "WM_SETICON",
        "PKEY_AppUserModel",
        "ImplicitAppShortcuts",
    ] {
        assert!(
            !source.contains(forbidden),
            "launcher must not override Codex icons: {forbidden}"
        );
    }
    for production in [
        include_str!("../../src/windows_integration.rs"),
        include_str!("../../src/windows_taskbar.rs"),
    ] {
        for forbidden in [
            "PKEY_AppUserModel_RelaunchIconResource",
            "WM_SETICON",
            "ImplicitAppShortcuts",
        ] {
            assert!(
                !production.contains(forbidden),
                "integration must not override Codex icons: {forbidden}"
            );
        }
    }
}

#[test]
fn local_relaunch_process_pattern_matches_literal_bundle_paths_only() {
    let script =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../scripts/relaunch-local.mjs");
    let fixture = r#"
const fs = require('node:fs');
const assert = require('node:assert/strict');
const source = fs.readFileSync(process.argv[1], 'utf8');
const fn = source.match(/^function localBundleProcessPattern\(bundle\) \{[^]*?^\}/m);
assert.ok(fn);
const pattern = new Function(fn[0] + '; return localBundleProcessPattern;')();
const bundle = '/tmp/work+[fixture]/Codex Pilot.app';
const re = new RegExp(pattern(bundle));
assert.ok(re.test(bundle + '/Contents/MacOS/CodexPilot'));
assert.ok(!re.test('/Applications/Codex Pilot.app/Contents/MacOS/CodexPilot'));
assert.ok(!re.test('/tmp/work+[fixture]/Codexxx.app/Contents/MacOS/CodexPilot'));
assert.ok(!re.test(bundle + '.other/Contents/MacOS/CodexPilot'));
"#;
    let output = std::process::Command::new("node")
        .args(["-e", fixture])
        .arg(script)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn launcher_no_longer_contains_mobile_control_runtime() {
    let launcher_source = include_str!("../../src/launcher.rs");
    let settings_source = include_str!("../../src/settings.rs");
    let workspace_toml = include_str!("../../../../Cargo.toml");

    assert!(!workspace_toml.contains("apps/codex-plus-mobile-relay"));
    assert!(!launcher_source.contains("MobileRelay"));
    assert!(!launcher_source.contains("mobile_relay"));
    assert!(!launcher_source.contains("\"/mobile\""));
    assert!(!launcher_source.contains("CODEX_PLUS_MOBILE"));
    assert!(!settings_source.contains("mobileControl"));
}

#[test]
fn retired_plugin_cache_features_have_no_command_or_startup_entrypoints() {
    let launcher_source = include_str!("../../src/launcher.rs");
    let core_source = include_str!("../../src/lib.rs");
    let launcher_binary_source = include_str!("../../../../apps/codex-plus-launcher/src/main.rs");
    let relay_source = include_str!("../../src/relay_config.rs");
    let command_source =
        include_str!("../../../../apps/codex-plus-manager/src-tauri/src/commands.rs");
    let command_registry = include_str!("../../../../apps/codex-plus-manager/src-tauri/src/lib.rs");

    assert!(!core_source.contains("pub mod plugin_marketplace;"));
    assert!(!launcher_source.contains("ensure_plugin_marketplace_config"));
    assert!(!launcher_binary_source.contains("ensure_plugin_marketplace_config"));
    assert!(!launcher_source.contains("plugin_marketplace::"));
    assert!(!relay_source.contains("plugin_marketplace::"));
    for command in [
        "plugin_marketplace_status",
        "repair_plugin_marketplace",
        "remote_plugin_marketplace_status",
        "repair_remote_plugin_marketplace",
    ] {
        assert!(!command_source.contains(command));
        assert!(!command_registry.contains(command));
    }
    assert!(!core_source.contains("pub mod skills;"));
}

#[test]
fn app_paths_uses_native_windows_package_api_without_powershell() {
    let source =
        std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/app_paths.rs")).unwrap();

    assert!(source.contains("GetPackagesByPackageFamily"));
    assert!(source.contains("GetPackagePathByFullName"));
    assert!(!source.contains("Command::new(\"powershell\")"));
}

#[test]
fn launcher_packaged_activation_does_not_directly_fallback_to_windowsapps_exe() {
    let source = include_str!("../../src/launcher.rs");

    assert!(!source.contains("launcher.packaged_activation_cdp_unready_direct_fallback"));
    assert!(!source.contains("terminate_windows_process_id(process_id).await"));
}

#[cfg(windows)]
#[test]
fn launcher_windows_packaged_process_management_uses_native_api() {
    assert_eq!(
        windows_process_control_strategy(),
        WindowsProcessControlStrategy::NativeWindowsApi
    );
}

#[test]
fn launcher_macos_open_command_waits_for_app_exit() {
    let command = build_macos_open_command(Path::new("/Applications/Codex.app"), 9229, &[]);

    assert_eq!(command[0], "open");
    assert!(command.contains(&"-W".to_string()));
    assert!(command.contains(&"-a".to_string()));
    assert!(command.contains(&"--args".to_string()));
    assert!(command.contains(&"--remote-debugging-port=9229".to_string()));
}

#[test]
fn launcher_macos_open_command_appends_extra_codex_arguments_after_args() {
    let extra_args = vec!["--force_high_performance_gpu".to_string()];
    let command = build_macos_open_command(Path::new("/Applications/Codex.app"), 9229, &extra_args);
    let args_index = command
        .iter()
        .position(|part| part == "--args")
        .expect("macOS command should contain --args");

    assert_eq!(
        &command[args_index + 1..],
        &[
            "--remote-debugging-port=9229".to_string(),
            "--remote-allow-origins=http://127.0.0.1:9229".to_string(),
            "--force_high_performance_gpu".to_string(),
        ]
    );
}

#[test]
fn ports_windows_falls_back_to_ephemeral_when_requested_is_busy() {
    let selected = select_platform_loopback_port_with(9229, true, |_| false, || 43001);

    assert_eq!(selected, 43001);
}

#[test]
fn ports_packaged_debug_falls_back_to_ephemeral_when_requested_is_busy() {
    let selected = select_packaged_codex_debug_port_with(9229, |_| false, |_| false, || 43001);

    assert_eq!(selected, 43001);
}

#[test]
fn ports_packaged_debug_keeps_requested_when_existing_cdp_is_available() {
    let selected = select_packaged_codex_debug_port_with(9229, |_| false, |_| true, || 43001);

    assert_eq!(selected, 9229);
}

#[test]
fn ports_packaged_debug_keeps_requested_when_bindable() {
    let selected = select_packaged_codex_debug_port_with(9229, |_| true, |_| false, || 43001);

    assert_eq!(selected, 9229);
}

/// #247：调试端口被第三方进程（如 macOS 上的 SkyComputerUseService）占用时，
/// 非 Windows 平台也必须改用空闲端口，而不是把请求端口原样交给 Codex。
#[test]
fn ports_packaged_debug_falls_back_even_on_non_windows() {
    let selected = select_packaged_codex_debug_port_with(9229, |_| false, |_| false, || 43001);

    assert_eq!(selected, 43001);
}

#[test]
fn ports_non_windows_keeps_requested_even_when_busy() {
    let selected = select_platform_loopback_port_with(9229, false, |_| false, || 43001);

    assert_eq!(selected, 9229);
}

#[tokio::test]
async fn launch_lifecycle_ignores_retired_extra_args_in_settings() {
    let _state = crate::common::IsolatedTestState::new();
    let temp = tempfile::tempdir().unwrap();
    let app_dir = temp.path().join("Codex.app");
    std::fs::create_dir_all(&app_dir).unwrap();
    let status_store = StatusStore::new(temp.path().join("latest-status.json"));
    let events = Arc::new(Mutex::new(Vec::<String>::new()));
    let settings = serde_json::from_value(serde_json::json!({
        "codexExtraArgs": ["--force_high_performance_gpu"],
    }))
    .unwrap();
    let hooks = FakeHooks::new(events.clone()).with_settings(settings);

    let handle = launch_and_inject_with_hooks(
        LaunchOptions {
            app_dir: Some(app_dir),
            debug_port: 9229,
            status_store,
            ..Default::default()
        },
        &hooks,
    )
    .await
    .unwrap();
    handle.wait_for_codex_exit().await.unwrap();

    let events = events.lock().unwrap();
    assert!(events.contains(&"launch:9229".to_string()));
    assert!(
        !events
            .iter()
            .any(|event| event.contains("--force_high_performance_gpu"))
    );
}

#[tokio::test]
async fn launch_lifecycle_keeps_js_injection_with_legacy_launch_mode() {
    let _state = crate::common::IsolatedTestState::new();
    let temp = tempfile::tempdir().unwrap();
    let app_dir = temp.path().join("Codex.app");
    std::fs::create_dir_all(&app_dir).unwrap();
    let status_store = StatusStore::new(temp.path().join("latest-status.json"));
    let events = Arc::new(Mutex::new(Vec::<String>::new()));
    let legacy_settings: BackendSettings = serde_json::from_value(serde_json::json!({
        "launchMode": "relay",
        "enhancementsEnabled": true,
    }))
    .unwrap();
    let hooks = FakeHooks::new(events.clone()).with_settings(legacy_settings);

    let handle = launch_and_inject_with_hooks(
        LaunchOptions {
            app_dir: Some(app_dir),
            debug_port: 9229,
            status_store,
            ..Default::default()
        },
        &hooks,
    )
    .await
    .unwrap();
    handle.wait_for_codex_exit().await.unwrap();

    assert_eq!(
        *events.lock().unwrap(),
        vec![
            "select-debug:9229",
            "load-settings",
            "launch:9229",
            "inject:9229",
            "status:running",
            "wait-codex",
            "stop-bridge-watchdog",
        ]
    );
}

#[tokio::test]
async fn launch_lifecycle_skips_injection_when_enhancements_disabled() {
    let _state = crate::common::IsolatedTestState::new();
    let temp = tempfile::tempdir().unwrap();
    let app_dir = temp.path().join("Codex.app");
    std::fs::create_dir_all(&app_dir).unwrap();
    let status_store = StatusStore::new(temp.path().join("latest-status.json"));
    let events = Arc::new(Mutex::new(Vec::<String>::new()));
    let hooks = FakeHooks::new(events.clone()).with_settings(BackendSettings {
        enhancements_enabled: false,
        ..BackendSettings::default()
    });

    let handle = launch_and_inject_with_hooks(
        LaunchOptions {
            app_dir: Some(app_dir),
            debug_port: 9229,
            status_store,
            ..Default::default()
        },
        &hooks,
    )
    .await
    .unwrap();
    handle.wait_for_codex_exit().await.unwrap();

    assert_eq!(
        *events.lock().unwrap(),
        vec![
            "select-debug:9229",
            "load-settings",
            "launch:9229",
            "status:running",
            "wait-codex",
            "stop-bridge-watchdog",
        ]
    );
}

#[tokio::test]
async fn launch_lifecycle_enters_degraded_mode_and_retries_when_injection_fails() {
    let _state = crate::common::IsolatedTestState::new();
    let temp = tempfile::tempdir().unwrap();
    let app_dir = temp.path().join("Codex.app");
    std::fs::create_dir_all(&app_dir).unwrap();
    let status_store = StatusStore::new(temp.path().join("latest-status.json"));
    let events = Arc::new(Mutex::new(Vec::<String>::new()));
    let hooks = FakeHooks::new(events.clone()).with_inject_error("inject failed");

    let handle = launch_and_inject_with_hooks(
        LaunchOptions {
            app_dir: Some(app_dir),
            debug_port: 9229,
            status_store: status_store.clone(),
            ..Default::default()
        },
        &hooks,
    )
    .await
    .unwrap();

    assert_eq!(
        *events.lock().unwrap(),
        vec![
            "select-debug:9229",
            "load-settings",
            "launch:9229",
            "inject:9229",
            "status:running_degraded",
        ]
    );
    let status = status_store.load_latest().unwrap().unwrap();
    assert_eq!(status.status, "running_degraded");
    assert!(status.message.contains("Codex launched"));

    handle.wait_for_codex_exit().await.unwrap();
    let events = events.lock().unwrap().clone();
    assert!(events.contains(&"wait-codex".to_string()));
    assert!(events.contains(&"stop-bridge-watchdog".to_string()));
    assert!(!events.contains(&"terminate-codex".to_string()));
}

#[tokio::test]
async fn launch_lifecycle_cleans_watchdog_when_launch_fails() {
    let _state = crate::common::IsolatedTestState::new();
    let temp = tempfile::tempdir().unwrap();
    let app_dir = temp.path().join("Codex.app");
    std::fs::create_dir_all(&app_dir).unwrap();
    let status_store = StatusStore::new(temp.path().join("latest-status.json"));
    let events = Arc::new(Mutex::new(Vec::<String>::new()));
    let hooks = FakeHooks::new(events.clone()).with_launch_error("launch failed");

    let error = launch_and_inject_with_hooks(
        LaunchOptions {
            app_dir: Some(app_dir),
            debug_port: 9229,
            status_store: status_store.clone(),
            ..Default::default()
        },
        &hooks,
    )
    .await
    .unwrap_err();

    assert!(error.to_string().contains("launch failed"));
    assert_eq!(
        *events.lock().unwrap(),
        vec![
            "select-debug:9229",
            "load-settings",
            "launch:9229",
            "stop-bridge-watchdog",
            "status:failed",
        ]
    );
}

#[tokio::test]
async fn launch_lifecycle_cleans_watchdog_and_codex_when_status_save_fails() {
    let _state = crate::common::IsolatedTestState::new();
    let temp = tempfile::tempdir().unwrap();
    let app_dir = temp.path().join("Codex.app");
    std::fs::create_dir_all(&app_dir).unwrap();
    std::fs::write(temp.path().join("status-parent-file"), "not a directory").unwrap();
    let status_store = StatusStore::new(
        temp.path()
            .join("status-parent-file")
            .join("latest-status.json"),
    );
    let events = Arc::new(Mutex::new(Vec::<String>::new()));
    let hooks =
        FakeHooks::new(events.clone()).with_launch_result(CodexLaunch::PackagedActivation {
            app_user_model_id: "OpenAI.Codex_2p2nqsd0c76g0!App".to_string(),
            arguments: "--remote-debugging-port=9229".to_string(),
            process_id: Some(4242),
        });

    let error = launch_and_inject_with_hooks(
        LaunchOptions {
            app_dir: Some(app_dir),
            debug_port: 9229,
            status_store,
            ..Default::default()
        },
        &hooks,
    )
    .await
    .unwrap_err();

    assert!(error.to_string().contains("failed to create directory"));
    assert_eq!(
        *events.lock().unwrap(),
        vec![
            "select-debug:9229",
            "load-settings",
            "launch:9229",
            "inject:9229",
            "stop-bridge-watchdog",
            "terminate-packaged:4242",
            "status:failed",
        ]
    );
}

#[tokio::test]
async fn launch_lifecycle_keeps_packaged_process_id_running_and_retries_when_injection_fails() {
    let _state = crate::common::IsolatedTestState::new();
    let temp = tempfile::tempdir().unwrap();
    let app_dir = temp.path().join("Codex.app");
    std::fs::create_dir_all(&app_dir).unwrap();
    let status_store = StatusStore::new(temp.path().join("latest-status.json"));
    let events = Arc::new(Mutex::new(Vec::<String>::new()));
    let hooks = FakeHooks::new(events.clone())
        .with_launch_result(CodexLaunch::PackagedActivation {
            app_user_model_id: "OpenAI.Codex_2p2nqsd0c76g0!App".to_string(),
            arguments: "--remote-debugging-port=9229".to_string(),
            process_id: Some(4242),
        })
        .with_inject_error("inject failed");

    let handle = launch_and_inject_with_hooks(
        LaunchOptions {
            app_dir: Some(app_dir),
            debug_port: 9229,
            status_store,
            ..Default::default()
        },
        &hooks,
    )
    .await
    .unwrap();

    assert!(
        !events
            .lock()
            .unwrap()
            .contains(&"terminate-packaged:4242".to_string())
    );
    handle.wait_for_codex_exit().await.unwrap();
}

#[tokio::test]
async fn degraded_packaged_launch_captures_identity_before_monitoring_and_keeps_bridge_until_exit()
{
    let _state = crate::common::IsolatedTestState::new();
    let temp = tempfile::tempdir().unwrap();
    let app_dir = temp.path().join("Codex.app");
    std::fs::create_dir_all(&app_dir).unwrap();
    let events = Arc::new(Mutex::new(Vec::<String>::new()));
    let exit = Arc::new(tokio::sync::Notify::new());
    let mut hooks = FakeHooks::new(events.clone())
        .with_launch_result(CodexLaunch::PackagedActivation {
            app_user_model_id: "OpenAI.Codex_2p2nqsd0c76g0!App".to_string(),
            arguments: "--remote-debugging-port=9229".to_string(),
            process_id: None,
        })
        .with_inject_error("renderer is not ready");
    hooks.record_identity_capture = true;
    hooks.wait_until_exit = Some(exit.clone());
    let handle = launch_and_inject_with_hooks(
        LaunchOptions {
            app_dir: Some(app_dir),
            debug_port: 9229,
            status_store: StatusStore::new(temp.path().join("latest-status.json")),
            ..Default::default()
        },
        &hooks,
    )
    .await
    .unwrap();
    assert_eq!(
        events
            .lock()
            .unwrap()
            .iter()
            .filter(|event| *event == "capture-identity:9229")
            .count(),
        1,
    );
    assert_eq!(
        handle.status_store.load_latest().unwrap().unwrap().status,
        "running_degraded"
    );
    let mut waiting = std::pin::pin!(handle.wait_for_codex_exit());
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(10), &mut waiting)
            .await
            .is_err()
    );
    let current = events.lock().unwrap().clone();
    let captured = current
        .iter()
        .position(|event| event == "capture-identity:9229")
        .unwrap();
    let monitor = current
        .iter()
        .position(|event| event == "wait-codex")
        .unwrap();
    assert!(captured < monitor);
    assert!(!current.iter().any(|event| event == "stop-bridge-watchdog"));
    exit.notify_one();
    waiting.await.unwrap();
    assert!(
        events
            .lock()
            .unwrap()
            .iter()
            .any(|event| event == "stop-bridge-watchdog")
    );
    assert_eq!(
        handle.status_store.load_latest().unwrap().unwrap().status,
        "stopped"
    );
}

#[test]
fn launcher_macos_cleanup_command_targets_specific_app_bundle() {
    let command = build_macos_cleanup_command(
        Path::new("/Applications/OpenAI Codex.app"),
        MacosCleanupPolicy::QuitIfNotPreviouslyRunning,
    )
    .expect("cleanup command should be allowed");

    assert_eq!(command[0], "osascript");
    assert!(command.iter().any(|part| part.contains("OpenAI Codex")));
    assert!(!command.iter().any(|part| part == "Codex"));
}

#[test]
fn launcher_macos_cleanup_is_skipped_when_app_was_already_running() {
    let command = build_macos_cleanup_command(
        Path::new("/Applications/OpenAI Codex.app"),
        MacosCleanupPolicy::SkipQuitBecauseAlreadyRunning,
    );

    assert_eq!(command, None);
}

#[test]
fn launcher_macos_debug_launch_starts_when_app_is_not_running() {
    assert_eq!(
        select_macos_debug_launch_action(false, false),
        MacosDebugLaunchAction::LaunchNew
    );
}

#[test]
fn launcher_macos_debug_launch_reuses_existing_codex_cdp_instance() {
    assert_eq!(
        select_macos_debug_launch_action(true, true),
        MacosDebugLaunchAction::ReuseRunningDebugApp
    );
}

#[test]
fn launcher_macos_debug_launch_restarts_existing_non_cdp_instance() {
    assert_eq!(
        select_macos_debug_launch_action(true, false),
        MacosDebugLaunchAction::RestartRunningApp
    );
}

#[tokio::test]
async fn launch_exit_saves_failed_terminal_state_with_complete_error_chain() {
    let _state = crate::common::IsolatedTestState::new();
    let temp = tempfile::tempdir().unwrap();
    let app_dir = temp.path().join("Codex.app");
    std::fs::create_dir_all(&app_dir).unwrap();
    let mut hooks = FakeHooks::new(Arc::new(Mutex::new(Vec::new())));
    hooks.wait_error = true;
    let handle = launch_and_inject_with_hooks(
        LaunchOptions {
            app_dir: Some(app_dir),
            debug_port: 9229,
            status_store: StatusStore::new(temp.path().join("latest-status.json")),
            ..Default::default()
        },
        &hooks,
    )
    .await
    .unwrap();
    assert!(handle.wait_for_codex_exit().await.is_err());
    let terminal = handle.status_store.load_latest().unwrap().unwrap();
    assert_eq!(terminal.status, "failed");
    assert!(terminal.message.contains("monitoring Codex process"));
    assert!(terminal.message.contains("native process handle failed"));
    assert_eq!(terminal.phase, None);
}

#[derive(Clone)]
struct FakeHooks {
    directory: Arc<tempfile::TempDir>,
    events: Arc<Mutex<Vec<String>>>,
    settings: BackendSettings,
    launch_result: CodexLaunch,
    launch_error: Option<String>,
    inject_error: Option<String>,
    wait_error: bool,
    captured_launch_identity: Arc<Mutex<bool>>,
    record_identity_capture: bool,
    wait_until_exit: Option<Arc<tokio::sync::Notify>>,
}

impl FakeHooks {
    fn new(events: Arc<Mutex<Vec<String>>>) -> Self {
        Self {
            directory: Arc::new(tempfile::tempdir().unwrap()),
            events,
            settings: BackendSettings::default(),
            launch_result: CodexLaunch::Process {
                command: vec!["codex".to_string()],
                wait_strategy: codex_plus_core::launcher::ProcessWaitStrategy::TrackedChild,
                macos_cleanup_policy: None,
            },
            launch_error: None,
            inject_error: None,
            wait_error: false,
            captured_launch_identity: Arc::new(Mutex::new(false)),
            record_identity_capture: false,
            wait_until_exit: None,
        }
    }

    fn with_settings(mut self, settings: BackendSettings) -> Self {
        self.settings = settings;
        self
    }

    fn with_launch_result(mut self, launch_result: CodexLaunch) -> Self {
        self.launch_result = launch_result;
        self
    }

    fn with_inject_error(mut self, message: &str) -> Self {
        self.inject_error = Some(message.to_string());
        self
    }

    fn with_launch_error(mut self, message: &str) -> Self {
        self.launch_error = Some(message.to_string());
        self
    }

    fn event(&self, event: impl Into<String>) {
        self.events.lock().unwrap().push(event.into());
    }
}

#[async_trait::async_trait(?Send)]
impl LaunchHooks for FakeHooks {
    fn codex_home_dir(&self) -> PathBuf {
        self.directory.path().to_path_buf()
    }

    fn state_dir(&self) -> PathBuf {
        self.directory.path().join("state")
    }

    async fn sanitize_local_storage_model_suffixes(&self, _debug_port: u16) {}

    fn resolve_app_dir(
        &self,
        app_dir: Option<&Path>,
        _settings: &BackendSettings,
    ) -> anyhow::Result<PathBuf> {
        app_dir
            .map(Path::to_path_buf)
            .ok_or_else(|| anyhow::anyhow!("missing app dir"))
    }

    fn select_debug_port(&self, requested: u16) -> u16 {
        self.event(format!("select-debug:{requested}"));
        requested
    }

    async fn load_settings(&self) -> anyhow::Result<BackendSettings> {
        self.event("load-settings");
        Ok(self.settings.clone())
    }

    async fn start_native_browser_compatibility(&self, settings: &BackendSettings) {
        if settings.codex_app_native_browser_require_identification {
            self.event(format!(
                "native-browser:start:{}",
                settings.enhancements_enabled
            ));
        }
    }

    async fn stop_native_browser_compatibility(&self) {
        if self
            .settings
            .codex_app_native_browser_require_identification
        {
            self.event("native-browser:stop");
        }
    }

    async fn launch_codex(
        &self,
        app_dir: &Path,
        debug_port: u16,
        _settings: &BackendSettings,
        extra_args: &[String],
        _instance: &codex_plus_core::launcher::LaunchInstance,
    ) -> anyhow::Result<CodexLaunch> {
        assert!(app_dir.ends_with("Codex.app"));
        let launch_detail = if extra_args.is_empty() {
            format!("launch:{debug_port}")
        } else {
            format!("launch:{debug_port}:{}", extra_args.join(","))
        };
        self.event(launch_detail);
        if let Some(message) = &self.launch_error {
            anyhow::bail!(message.clone());
        }
        Ok(self.launch_result.clone())
    }

    async fn inject(&self, debug_port: u16) -> anyhow::Result<()> {
        self.event(format!("inject:{debug_port}"));
        if let Some(message) = &self.inject_error {
            anyhow::bail!(message.clone());
        }
        Ok(())
    }

    async fn ensure_injection(&self, debug_port: u16, _app_dir: &Path) -> bool {
        self.event(format!("inject:{debug_port}"));
        self.inject_error.is_none()
    }

    async fn apply_native_module_patches_on_launch(&self, debug_port: u16) -> anyhow::Result<()> {
        self.event(format!("native-modules:{debug_port}"));
        Ok(())
    }

    async fn capture_injected_launch_identity(&self, debug_port: u16) {
        *self.captured_launch_identity.lock().unwrap() = true;
        if self.record_identity_capture {
            self.event(format!("capture-identity:{debug_port}"));
        }
    }

    async fn start_bridge_watchdog(&self, _debug_port: u16) -> anyhow::Result<()> {
        Ok(())
    }

    async fn write_status(&self, status: &str) {
        self.event(format!("status:{status}"));
    }

    async fn wait_for_codex_exit(
        &self,
        _launch: &CodexLaunch,
        _debug_port: u16,
    ) -> anyhow::Result<()> {
        self.event("wait-codex");
        if self.record_identity_capture {
            assert!(
                *self.captured_launch_identity.lock().unwrap(),
                "monitoring must use the launch identity even after injection failure"
            );
        }
        if let Some(exit) = &self.wait_until_exit {
            exit.notified().await;
        }
        if self.wait_error {
            return Err(
                anyhow::anyhow!("native process handle failed").context("monitoring Codex process")
            );
        }
        Ok(())
    }

    async fn stop_bridge_watchdog(&self) {
        self.event("stop-bridge-watchdog");
    }

    async fn terminate_codex(&self, launch: &CodexLaunch) {
        if let Some(process_id) = launch.process_id() {
            self.event(format!("terminate-packaged:{process_id}"));
        } else {
            self.event("terminate-codex");
        }
    }
}
