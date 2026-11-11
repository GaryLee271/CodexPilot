use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use codex_plus_core::settings::{BackendSettings, SettingsStore};
use codex_plus_core::status::{LaunchStatus, StatusStore};
use codex_plus_core::user_scripts::UserScriptManager;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::Emitter;

use crate::install::{self, InstallActionResult};

// 扫描快照仅驻留后端内存，不接受前端指定磁盘路径，不开放给扩展路由。

#[derive(Debug, Clone, Serialize)]
pub struct CommandResult<T>
where
    T: Serialize,
{
    pub status: String,
    pub message: String,
    #[serde(flatten)]
    pub payload: T,
}

#[derive(Debug, Clone, Serialize)]
pub struct VersionPayload {
    pub version: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PathState {
    pub status: String,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct OverviewPayload {
    pub codex_app: PathState,
    pub codex_version: Option<String>,
    pub silent_shortcut: PathState,
    pub management_shortcut: PathState,
    pub latest_launch: Option<LaunchStatus>,
    pub runtime_health: crate::runtime_health::RuntimeHealth,
    pub current_version: String,
    pub update_status: String,
    pub settings_path: String,
    pub logs_path: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SettingsPayload {
    pub revision: String,
    pub settings: BackendSettings,
    pub settings_path: String,
    pub builtin_extensions: Value,
}

#[derive(Debug, Clone)]
pub struct LaunchRequest {
    pub app_path: String,
    pub debug_port: u16,
}

impl Default for LaunchRequest {
    fn default() -> Self {
        Self {
            app_path: String::new(),
            debug_port: default_debug_port(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct SettingsExportDocument {
    schema: u8,
    exported_at_ms: u64,
    settings: BackendSettings,
}

#[derive(Debug, Clone, Serialize)]
pub struct WatcherPayload {
    pub enabled: bool,
    pub disabled_flag: String,
    pub start_minimized: bool,
    pub start_codex: bool,
    pub start_codex_on_open: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupPayload {
    pub show_update: bool,
}

#[tauri::command]
pub fn backend_version() -> CommandResult<VersionPayload> {
    ok(
        "后端版本已读取。",
        VersionPayload {
            version: codex_plus_core::version::VERSION.to_string(),
        },
    )
}

#[tauri::command]
pub fn startup_options() -> CommandResult<StartupPayload> {
    ok(
        "启动参数已读取。",
        StartupPayload {
            show_update: startup_should_show_update(),
        },
    )
}

#[tauri::command]
pub fn consume_pending_manager_navigation()
-> Result<Option<codex_plus_core::manager_navigation::ManagerNavigationIntent>, String> {
    codex_plus_core::manager_navigation::consume_pending_manager_navigation()
        .map_err(|error| error.to_string())
}

pub fn startup_should_show_update() -> bool {
    should_show_update(
        std::env::args(),
        std::env::var("CODEX_PLUS_SHOW_UPDATE").ok().as_deref(),
    )
}

fn should_show_update<I, S>(args: I, env_value: Option<&str>) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter().any(|arg| arg.as_ref() == "--show-update") || env_value == Some("1")
}

/// 只查 Codex 桌面端进程还在不在，给前端定期轻量轮询用（#2778：在 Codex 自己的窗口里
/// 退出后，侧栏和顶栏仍显示「运行中 / 停止 Codex」）。不读设置、不探测端口，状态变了
/// 前端再走完整的 `load_overview`。后台任务失败返回 None，前端忽略这一轮。
#[tauri::command]
pub async fn codex_app_running() -> Option<bool> {
    tauri::async_runtime::spawn_blocking(|| {
        !codex_plus_core::watcher::find_codex_processes().is_empty()
    })
    .await
    .ok()
}

#[tauri::command]
pub async fn load_overview() -> CommandResult<OverviewPayload> {
    let payload = tauri::async_runtime::spawn_blocking(load_overview_payload).await;
    let Ok((codex_app_path, entrypoints, latest_launch, runtime_health)) = payload else {
        return failed(
            "概览后台任务失败。",
            OverviewPayload {
                codex_app: path_state(None),
                codex_version: None,
                silent_shortcut: path_state(None),
                management_shortcut: path_state(None),
                latest_launch: None,
                runtime_health: crate::runtime_health::RuntimeHealth::unavailable(),
                current_version: codex_plus_core::version::VERSION.to_string(),
                update_status: "not_checked".to_string(),
                settings_path: codex_plus_core::paths::default_settings_path()
                    .to_string_lossy()
                    .to_string(),
                logs_path: codex_plus_core::paths::default_diagnostic_log_path()
                    .to_string_lossy()
                    .to_string(),
            },
        );
    };
    ok(
        "概览已加载。",
        OverviewPayload {
            codex_version: codex_app_path
                .as_deref()
                .and_then(codex_plus_core::app_paths::codex_app_version),
            codex_app: path_state(codex_app_path),
            silent_shortcut: shortcut_state(entrypoints.silent_shortcut),
            management_shortcut: shortcut_state(entrypoints.management_shortcut),
            latest_launch,
            runtime_health,
            current_version: codex_plus_core::version::VERSION.to_string(),
            update_status: "not_checked".to_string(),
            settings_path: codex_plus_core::paths::default_settings_path()
                .to_string_lossy()
                .to_string(),
            logs_path: codex_plus_core::paths::default_diagnostic_log_path()
                .to_string_lossy()
                .to_string(),
        },
    )
}

#[tauri::command]
pub async fn launch_codex_plus() -> CommandResult<Value> {
    match tauri::async_runtime::spawn_blocking(|| {
        let _guard = match try_acquire_launch_guard() {
            Ok(guard) => guard,
            Err(message) => return failed(message, json!({})),
        };
        spawn_codex_plus_launch(
            LaunchRequest::default(),
            "启动任务已在后台开始，可稍后查看概览状态。",
        )
    })
    .await
    {
        Ok(result) => result,
        Err(error) => failed(&format!("启动后台任务失败：{error}"), json!({})),
    }
}

#[tauri::command]
pub async fn restart_codex_plus() -> CommandResult<Value> {
    match tauri::async_runtime::spawn_blocking(|| {
        restart_codex_plus_blocking(LaunchRequest::default())
    })
    .await
    {
        Ok(result) => result,
        Err(error) => failed(&format!("重启后台任务失败：{error}"), json!({})),
    }
}

static LAUNCH_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

struct LaunchGuard;

impl Drop for LaunchGuard {
    fn drop(&mut self) {
        LAUNCH_IN_PROGRESS.store(false, Ordering::Release);
    }
}

fn try_acquire_launch_guard() -> Result<LaunchGuard, &'static str> {
    LAUNCH_IN_PROGRESS
        .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
        .map(|_| LaunchGuard)
        .map_err(|_| "启动或重启正在进行，请等待本次操作完成。")
}

/// 供自动接管守护线程复用同一把串行锁：它与用户点「启动/重启」必须互斥，
/// 否则会出现两套 launcher 会话抢同一个官方 App。
pub fn try_acquire_launch_guard_for_takeover() -> Result<impl Drop, &'static str> {
    try_acquire_launch_guard()
}

/// 是否有启动/重启在途（判据用，只读）。
pub fn launch_in_progress() -> bool {
    LAUNCH_IN_PROGRESS.load(Ordering::Acquire)
}

/// 自动接管发起的启动：走与「点启动」完全相同的 launcher 链路。
///
/// 与 `start_embedded_launcher` 的唯一区别是入参由守护线程解析，不接受前端传来的
/// 临时状态。
pub fn run_auto_takeover_launch(request: LaunchRequest) -> Result<(), String> {
    if crate::app_is_exiting() {
        return Err("Codex Pilot 正在退出，未启动 Codex".to_string());
    }
    let launch_options = codex_plus_launcher::LaunchOptions {
        app_dir: (!request.app_path.trim().is_empty())
            .then(|| PathBuf::from(request.app_path.trim())),
        debug_port: request.debug_port,
        status_store: StatusStore::default(),
        ..Default::default()
    };
    codex_plus_launcher::start(launch_options).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn load_auto_takeover_state() -> CommandResult<crate::auto_takeover::AutoTakeoverPayload> {
    ok("自动接管状态已加载。", crate::auto_takeover::payload())
}

#[tauri::command]
pub fn take_over_codex_now() -> CommandResult<crate::auto_takeover::AutoTakeoverPayload> {
    match crate::auto_takeover::take_over_now() {
        Ok(()) => ok("已发起接管。", crate::auto_takeover::payload()),
        Err(message) => failed(&message, crate::auto_takeover::payload()),
    }
}

#[tauri::command]
pub fn pause_auto_takeover_for_instance() -> CommandResult<crate::auto_takeover::AutoTakeoverPayload>
{
    match crate::auto_takeover::pause_until_next_instance() {
        Ok(()) => ok(
            "本次不再自动接管，重启官方 App 后恢复。",
            crate::auto_takeover::payload(),
        ),
        Err(message) => failed(&message, crate::auto_takeover::payload()),
    }
}

#[derive(Debug, PartialEq, Eq)]
enum RestartDisposition {
    LaunchOnly,
    StopAndRestart,
}

fn restart_disposition(app_running: bool) -> RestartDisposition {
    if !app_running {
        RestartDisposition::LaunchOnly
    } else {
        RestartDisposition::StopAndRestart
    }
}

fn restart_codex_plus_blocking(request: LaunchRequest) -> CommandResult<Value> {
    let _launch_guard = match try_acquire_launch_guard() {
        Ok(guard) => guard,
        Err(message) => return failed(message, json!({})),
    };
    let request = normalize_launch_request(request);
    // 按本实例的调试端口判定是否在跑。
    // 早先用 `find_codex_processes_for_debug_port`，但它在非 macOS 上返回全部
    // Codex 进程：Windows 上只要有多开实例在跑，就会把「主 Codex 没开」误判成
    // 「已运行」，进而走进重启分支去停进程。
    let app_running = codex_plus_core::cdp::endpoint_available(request.debug_port);
    if restart_disposition(app_running) == RestartDisposition::LaunchOnly {
        // 调试端口不可连不代表 Codex 没在跑：Windows 商店版主 Codex 可能开着却没带端口
        // （issue #2764）。走重启专用的启动，由 launcher 识别并结束它后再启动。
        return spawn_codex_plus_launch_with(
            request,
            "Codex 未运行，已按直接启动方式在后台唤起。",
            start_embedded_launcher_for_restart,
        );
    }
    // 停止 Codex 后清理同进程后台服务，再确认浏览器恢复结果。
    // 先记录停止阶段，让界面在等待期间显示进度（issue #2403）。
    // 该状态带的是当前时间戳，早于后面返回给前端的 launch_started_at_ms，
    // 因此等待完成度判定时会被视作 stale，不会误报成最终结果。
    let _ = StatusStore::default().save_latest(&requested_launch_status_with_phase(
        &request,
        "stopping",
        "正在停止 Codex 并清理后台服务…",
        current_timestamp_ms(),
        "restart_stopping",
        10,
    ));
    let native_browser_shutdown = match stop_codex_plus_for_restart(
        || stop_main_codex_process(request.debug_port),
        codex_plus_launcher::stop,
        wait_native_browser_shutdown,
    ) {
        Ok(shutdown) => shutdown,
        Err(error) => {
            return failed(
                &restart_stop_failure_message(&error),
                json!({"debugPort": request.debug_port}),
            );
        }
    };
    let native_browser_restore_failed = matches!(
        native_browser_shutdown,
        codex_plus_core::native_browser::NativeBrowserShutdown::RestoreFailed
    );
    if native_browser_restore_failed {
        let _ = codex_plus_core::diagnostic_log::append_diagnostic_log(
            "native_browser.cleanup_not_restored",
            json!({"state": "blocked"}),
        );
    }
    let _ = codex_plus_core::diagnostic_log::append_diagnostic_log(
        "manager.restart_requested",
        json!({
            "debug_port": request.debug_port,
            "app_path": request.app_path.trim(),
        }),
    );
    let launch_started_at_ms = current_timestamp_ms();
    if let Err(error) = save_requested_launch_status(
        &request,
        "starting",
        "Codex Pilot launcher is starting",
        launch_started_at_ms,
    ) {
        return failed(
            &format!("记录重启状态失败，未执行重启：{error}"),
            json!({
                "debugPort": request.debug_port,
            }),
        );
    }
    let mut restart_message = "Codex 已请求重启，启动任务正在后台运行。".to_string();
    match start_embedded_launcher_for_restart(&request).map(|_| Vec::<String>::new()) {
        Ok(warnings) => {
            for warning in warnings {
                restart_message.push_str("\n\n");
                restart_message.push_str(&warning);
            }
            let (debug_port, started_at_ms) =
                accepted_launch_identity(&request, launch_started_at_ms);
            CommandResult {
                status: "accepted".to_string(),
                message: restart_message,
                payload: json!({
                    "debugPort": debug_port,
                    "launchStartedAtMs": started_at_ms,
                    "nativeBrowserRestoreFailed": native_browser_restore_failed,
                    "forcedStoppedLauncherCount": 0
                }),
            }
        }
        Err(error) => {
            let message = format!("重启 Codex 失败：{error}");
            let _ =
                save_requested_launch_status(&request, "failed", &message, launch_started_at_ms);
            failed(
                &message,
                json!({
                    "debugPort": request.debug_port,
                    "launchStartedAtMs": launch_started_at_ms,
                    "nativeBrowserRestoreFailed": native_browser_restore_failed
                }),
            )
        }
    }
}

/// 结束主 Codex 进程并确认调试端口已关闭。重启和「停止 Codex」共用。
fn stop_main_codex_process(debug_port: u16) -> anyhow::Result<()> {
    // 主实例在 Windows 上是 AUMID 激活的，命令行未必带调试端口；
    // 这里允许「按端口没匹配到就退回全局结束」，否则会卡在
    // 「Codex 进程尚未退出」。
    #[cfg(windows)]
    codex_plus_core::watcher::stop_codex_processes_for_debug_port_with_fallback(debug_port, true);
    #[cfg(not(windows))]
    codex_plus_core::watcher::stop_codex_processes_for_debug_port_and_wait(debug_port);
    anyhow::ensure!(
        !codex_plus_core::cdp::endpoint_available(debug_port),
        "Codex 进程尚未退出"
    );
    Ok(())
}

fn wait_native_browser_shutdown()
-> anyhow::Result<codex_plus_core::native_browser::NativeBrowserShutdown> {
    codex_plus_core::native_browser::wait_for_monitor_shutdown(std::time::Duration::from_secs(10))
}

/// 侧栏 Codex 行的「停止」：走和重启相同的停止流程（结束进程 → 清理后台服务 → 等浏览器恢复），
/// 只是不再启动新实例。状态记为 stopped / user_stopped，前端据此不把它当成「意外停止」。
#[tauri::command]
pub async fn stop_codex_plus() -> CommandResult<Value> {
    match tauri::async_runtime::spawn_blocking(
        || stop_codex_plus_blocking(LaunchRequest::default()),
    )
    .await
    {
        Ok(result) => result,
        Err(error) => failed(&format!("停止后台任务失败：{error}"), json!({})),
    }
}

fn stop_codex_plus_blocking(request: LaunchRequest) -> CommandResult<Value> {
    let _launch_guard = match try_acquire_launch_guard() {
        Ok(guard) => guard,
        Err(message) => return failed(message, json!({})),
    };
    let request = normalize_launch_request(request);
    if !codex_plus_core::cdp::endpoint_available(request.debug_port) {
        return ok("Codex 没有在运行。", json!({}));
    }
    let _ = StatusStore::default().save_latest(&requested_launch_status_with_phase(
        &request,
        "stopping",
        "正在停止 Codex 并清理后台服务…",
        current_timestamp_ms(),
        "user_stopping",
        10,
    ));
    match stop_codex_plus_for_restart(
        || stop_main_codex_process(request.debug_port),
        codex_plus_launcher::stop,
        wait_native_browser_shutdown,
    ) {
        Ok(_) => {
            let _ = StatusStore::default().save_latest(&requested_launch_status_with_phase(
                &request,
                "stopped",
                "Codex 已停止。",
                current_timestamp_ms(),
                "user_stopped",
                100,
            ));
            ok("Codex 已停止。", json!({}))
        }
        Err(error) => failed(&stop_failure_message(&error), json!({})),
    }
}

fn stop_failure_message(error: &RestartStopError) -> String {
    match error {
        RestartStopError::Codex(error) => format!("Codex 进程尚未确认退出：{error}"),
        RestartStopError::NativeBrowser(error) => {
            format!("Codex 已停止，但原生浏览器文件尚未恢复：{error}")
        }
        RestartStopError::Runtime(error) => {
            format!("Codex 已停止，但后台服务尚未清理完成：{error}")
        }
    }
}

fn stop_codex_plus_for_restart(
    stop_codex: impl FnOnce() -> anyhow::Result<()>,
    stop_runtime: impl FnOnce() -> anyhow::Result<()>,
    wait_native: impl FnOnce() -> anyhow::Result<codex_plus_core::native_browser::NativeBrowserShutdown>,
) -> Result<codex_plus_core::native_browser::NativeBrowserShutdown, RestartStopError> {
    // 后台服务持有浏览器恢复任务。停止服务须等待它清理，不能结束主进程。
    stop_codex().map_err(RestartStopError::Codex)?;
    stop_runtime().map_err(RestartStopError::Runtime)?;
    wait_native().map_err(RestartStopError::NativeBrowser)
}

#[derive(Debug)]
enum RestartStopError {
    Codex(anyhow::Error),
    NativeBrowser(anyhow::Error),
    Runtime(anyhow::Error),
}

fn restart_stop_failure_message(error: &RestartStopError) -> String {
    match error {
        RestartStopError::Codex(error) => {
            format!("Codex 进程尚未确认退出，未清理原生浏览器或启动新实例：{error}")
        }
        RestartStopError::NativeBrowser(error) => {
            let summary = if error
                .downcast_ref::<codex_plus_core::native_browser::NativeBrowserCleanupStillRunning>()
                .is_some()
            {
                "仍在恢复"
            } else {
                "恢复失败"
            };
            format!("Codex 已请求停止，但原生浏览器文件{summary}，未启动新实例：{error}")
        }
        RestartStopError::Runtime(error) => {
            format!("Codex 已请求停止，但后台服务尚未清理完成，未启动新实例：{error}")
        }
    }
}

fn normalize_launch_request(mut request: LaunchRequest) -> LaunchRequest {
    // launcher 收到显式 --app-path 时不会回退自动探测（避免静默启动错误目录），
    // 所以这里先把明显无效的路径摘掉，让它走探测而不是永久失败（#1972）。
    let requested_app_path = request.app_path.trim().to_string();
    if !requested_app_path.is_empty()
        && codex_plus_core::app_paths::normalize_codex_app_path(Path::new(&requested_app_path))
            .is_none()
    {
        let _ = codex_plus_core::diagnostic_log::append_diagnostic_log(
            "manager.launch_app_path_rejected",
            json!({ "app_path": requested_app_path }),
        );
        request.app_path = String::new();
    }
    request
}

fn spawn_codex_plus_launch(request: LaunchRequest, accepted_message: &str) -> CommandResult<Value> {
    spawn_codex_plus_launch_with(request, accepted_message, start_embedded_launcher)
}

fn spawn_codex_plus_launch_with(
    request: LaunchRequest,
    accepted_message: &str,
    start: impl FnOnce(&LaunchRequest) -> anyhow::Result<()>,
) -> CommandResult<Value> {
    let request = normalize_launch_request(request);
    let debug_port = request.debug_port;
    let launch_started_at_ms = current_timestamp_ms();
    let _ = codex_plus_core::diagnostic_log::append_diagnostic_log(
        "manager.launch_requested",
        json!({
            "debug_port": debug_port,
            "app_path": request.app_path.trim()
        }),
    );
    if let Err(error) = save_requested_launch_status(
        &request,
        "starting",
        "Codex Pilot launcher is starting",
        launch_started_at_ms,
    ) {
        return failed(
            &format!("记录启动状态失败，未执行启动：{error}"),
            json!({
                "debugPort": debug_port,
            }),
        );
    }
    match start(&request) {
        Ok(()) => {
            let (debug_port, started_at_ms) =
                accepted_launch_identity(&request, launch_started_at_ms);
            CommandResult {
                status: "accepted".to_string(),
                message: accepted_message.to_string(),
                payload: json!({
                    "debugPort": debug_port,
                    "launchStartedAtMs": started_at_ms
                }),
            }
        }
        Err(error) => {
            let message = format!("启动 Codex 失败：{error}");
            let _ =
                save_requested_launch_status(&request, "failed", &message, launch_started_at_ms);
            failed(
                &message,
                json!({
                    "debugPort": debug_port,
                    "launchStartedAtMs": launch_started_at_ms
                }),
            )
        }
    }
}

fn accepted_launch_identity(request: &LaunchRequest, requested_at: u64) -> (u16, u64) {
    let latest = StatusStore::default().load_latest().ok().flatten();
    launch_identity_from_status(request, requested_at, latest.as_ref())
}

fn launch_identity_from_status(
    request: &LaunchRequest,
    requested_at: u64,
    latest: Option<&LaunchStatus>,
) -> (u16, u64) {
    // 重复启动会激活当前 session，其身份不能被新请求覆盖；端口也可能已自动换位。
    if let Some(latest) =
        latest.filter(|status| matches!(status.status.as_str(), "running" | "running_degraded"))
    {
        (
            latest.debug_port.unwrap_or(request.debug_port),
            latest.started_at_ms,
        )
    } else {
        (request.debug_port, requested_at)
    }
}

fn save_requested_launch_status(
    request: &LaunchRequest,
    status: &str,
    message: &str,
    started_at_ms: u64,
) -> anyhow::Result<()> {
    StatusStore::default().save_latest(&requested_launch_status(
        request,
        status,
        message,
        started_at_ms,
    ))
}

fn requested_launch_status(
    request: &LaunchRequest,
    status: &str,
    message: &str,
    started_at_ms: u64,
) -> LaunchStatus {
    LaunchStatus {
        status: status.to_string(),
        message: message.to_string(),
        started_at_ms,
        debug_port: Some(request.debug_port),
        codex_app: (!request.app_path.trim().is_empty())
            .then(|| request.app_path.trim().to_string()),
        aumid: None,
        phase: None,
        progress: None,
    }
}

/// 停止阶段的状态：带 `phase`/`progress`，让界面在阻塞的十几秒里有明确中间态
/// （issue #2403：此前只有 `starting`，看不出是在处理还是卡死）。
fn requested_launch_status_with_phase(
    request: &LaunchRequest,
    status: &str,
    message: &str,
    started_at_ms: u64,
    phase: &str,
    progress: u8,
) -> LaunchStatus {
    LaunchStatus {
        phase: Some(phase.to_string()),
        progress: Some(progress.min(100)),
        ..requested_launch_status(request, status, message, started_at_ms)
    }
}

fn current_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn start_embedded_launcher(request: &LaunchRequest) -> anyhow::Result<()> {
    start_embedded_launcher_with(request, false)
}

/// 「重启 Codex」专用：允许 launcher 结束挡住本次启动的 Windows 商店版主 Codex
/// （已在运行却没带调试端口，issue #2764）。普通启动只提示用户自行退出。
fn start_embedded_launcher_for_restart(request: &LaunchRequest) -> anyhow::Result<()> {
    start_embedded_launcher_with(request, true)
}

fn start_embedded_launcher_with(
    request: &LaunchRequest,
    replace_blocking_main_instance: bool,
) -> anyhow::Result<()> {
    anyhow::ensure!(!crate::app_is_exiting(), "Codex Pilot 正在退出，未启动 Codex");
    codex_plus_launcher::start(codex_plus_launcher::LaunchOptions {
        app_dir: (!request.app_path.trim().is_empty())
            .then(|| PathBuf::from(request.app_path.trim())),
        debug_port: request.debug_port,
        status_store: StatusStore::default(),
        replace_blocking_main_instance,
        ..Default::default()
    })
}

/// 重新打开管理界面时恢复已有 Codex 的 CDP 桥接与注入，不启动官方应用。
pub fn resume_existing_codex_background(app: tauri::AppHandle, start_if_missing: bool) {
    tauri::async_runtime::spawn_blocking(move || {
        if crate::app_is_exiting() {
            return;
        }
        let settings = SettingsStore::default().load().unwrap_or_default();
        let latest = StatusStore::default().load_latest().unwrap_or(None);
        let options = codex_plus_launcher::LaunchOptions {
            app_dir: codex_plus_core::app_paths::resolve_codex_app_dir_with_saved(
                latest
                    .as_ref()
                    .and_then(|status| status.codex_app.as_deref())
                    .map(Path::new),
                Some(settings.codex_app_path.as_str()),
            ),
            debug_port: latest
                .as_ref()
                .and_then(|status| status.debug_port)
                .unwrap_or_else(default_debug_port),
            status_store: StatusStore::default(),
            ..Default::default()
        };
        match codex_plus_launcher::resume_if_running(options.clone()) {
            Ok(true) => {}
            Ok(false) if start_if_missing => {
                if let Err(error) = codex_plus_launcher::start(options) {
                    let _ = codex_plus_core::diagnostic_log::append_diagnostic_log(
                        "manager.autostart_codex_failed",
                        json!({ "message": error.to_string() }),
                    );
                } else {
                    let _ = codex_plus_core::diagnostic_log::append_diagnostic_log(
                        "manager.autostart_codex_started",
                        json!({}),
                    );
                }
            }
            Ok(false) => {}
            Err(error) => {
                let _ = codex_plus_core::diagnostic_log::append_diagnostic_log(
                    "manager.resume_existing_failed",
                    json!({ "message": error.to_string() }),
                );
            }
        }
        let _ = tauri::Emitter::emit(&app, "runtime-health-changed", ());
    });
}

#[tauri::command]
pub fn query_builtin_model_metadata(slug: String) -> CommandResult<Value> {
    match codex_plus_core::model_suffix::builtin_model_metadata(slug.as_str()) {
        Some(metadata) => ok(
            "内置元数据已匹配。",
            json!({
                "matched": true,
                "source": metadata.source,
                "entry": metadata.entry,
            }),
        ),
        None => {
            // 回退值从 bundled 静态资产首条实时取，不写死——
            // sync_official_models.py 调整首条后这里自动跟随。
            let (fallback_slug, fallback_window) =
                codex_plus_core::model_suffix::fallback_template_info()
                    .unwrap_or_else(|| ("gpt-5.5".to_string(), 272_000));
            ok(
                "未命中内置元数据，生成时回退官方模板。",
                json!({
                    "matched": false,
                    "fallback": {
                        "slug": fallback_slug,
                        "context_window": fallback_window,
                    },
                }),
            )
        }
    }
}

#[tauri::command]
pub fn builtin_model_metadata_index() -> CommandResult<Value> {
    let index = codex_plus_core::model_suffix::builtin_model_metadata_index();
    let count = index.len();
    ok(
        "内置元数据索引已读取。",
        json!({ "entries": index, "count": count }),
    )
}

#[derive(serde::Serialize)]
pub struct NativeBrowserDiagnostics {
    compatibility: codex_plus_core::native_browser::BrowserStatus,
    connection: codex_plus_core::native_browser_connection::ConnectionStatus,
}

#[tauri::command]
pub async fn native_browser_status() -> NativeBrowserDiagnostics {
    let compatibility =
        tauri::async_runtime::spawn_blocking(codex_plus_core::native_browser::read_status)
            .await
            .unwrap_or_else(|_| codex_plus_core::native_browser::BrowserStatus {
                state: "unavailable".into(),
                detail: String::new(),
            });
    let connection = codex_plus_core::native_browser_connection::check_connection().await;
    NativeBrowserDiagnostics {
        compatibility,
        connection,
    }
}

#[tauri::command]
pub fn load_settings() -> CommandResult<SettingsPayload> {
    settings_payload("设置已加载。", "读取增强设置失败")
}

#[tauri::command]
pub fn save_settings(
    mut settings: BackendSettings,
    expected_revision: Option<String>,
) -> CommandResult<SettingsPayload> {
    if let Some(revision) = expected_revision {
        settings.settings_revision = revision;
    }
    let settings = normalize_settings_before_save(settings);
    let store = SettingsStore::default();
    match store.save(&settings) {
        Ok(_) => {
            // 自动接管是常驻行为，保存后立刻生效，不必重启管理器。
            crate::auto_takeover::apply_enabled(settings.codex_app_auto_takeover);
            settings_payload("设置已保存。", "设置保存后重新读取失败")
        }
        Err(error) => failed(
            &format!("保存设置失败：{error}"),
            fallback_settings_payload(),
        ),
    }
}

/// 归一化「Codex 应用路径」。**无效路径一律丢弃，不落库。**
///
/// 之前的写法是 normalize 成功才覆盖、失败就原样保留，于是误选的路径会被存进
/// settings.json。而 launcher 拿到显式 --app-path 且无效时不回退自动探测，
/// 结果就是启动永久失败、只能手改配置文件才能恢复（#1972：用户误选了 Codex Pilot
/// 自己的 codex-pilot.exe，因为文件选择器只按 exe 扩展名过滤）。
///
/// 清空之后 resolve_codex_app_dir_with_saved 会走自动探测，至少还能起来。
fn normalized_codex_app_path_for_save(raw: &str) -> String {
    if raw.trim().is_empty() {
        return String::new();
    }
    codex_plus_core::app_paths::normalize_codex_app_path(Path::new(raw))
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_default()
}

fn normalize_settings_before_save(mut settings: BackendSettings) -> BackendSettings {
    settings.codex_app_path = normalized_codex_app_path_for_save(&settings.codex_app_path);
    settings
}

#[tauri::command]
pub async fn reload_builtin_extensions() -> CommandResult<SettingsPayload> {
    let debug_port = StatusStore::default()
        .load_latest()
        .ok()
        .flatten()
        .and_then(|status| status.debug_port)
        .unwrap_or_else(default_debug_port);
    let manager = default_user_script_manager();
    // 手动改过拓展文件后热重载：顺带让 Codex 钩子条目与拓展声明一致。
    codex_plus_core::extension_hooks::sync_default(&manager);
    match codex_plus_core::user_scripts::reload_live_scripts(debug_port, &manager).await {
        Ok(extensions) => {
            let page_reload = extensions["reload_mode"] == "page";
            let script_failed = extensions["scripts"]
                .as_array()
                .is_some_and(|scripts| scripts.iter().any(|script| script["status"] == "failed"));
            let payload = SettingsPayload {
                revision: SettingsStore::default().revision().unwrap_or_default(),
                settings: SettingsStore::default().load().unwrap_or_default(),
                settings_path: codex_plus_core::paths::default_settings_path()
                    .to_string_lossy()
                    .to_string(),
                builtin_extensions: extensions,
            };
            if script_failed {
                failed("部分脚本执行失败，请查看本地脚本状态。", payload)
            } else {
                ok(
                    if page_reload {
                        "已请求刷新 Codex 页面以安全重载旧脚本。"
                    } else {
                        "内置拓展已热重载。"
                    },
                    payload,
                )
            }
        }
        Err(error) => failed(
            &format!("内置拓展热重载失败：{error}"),
            fallback_settings_payload(),
        ),
    }
}

#[tauri::command]
pub fn set_builtin_extension_enabled(key: String, enabled: bool) -> CommandResult<SettingsPayload> {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return failed("内置拓展 key 不能为空。", fallback_settings_payload());
    }
    let manager = default_user_script_manager();
    let result = manager.set_script_enabled(trimmed, enabled);
    codex_plus_core::extension_hooks::sync_default(&manager);
    match result {
        Ok(_) => settings_payload(
            if enabled {
                "内置拓展已启用。"
            } else {
                "内置拓展已停用。"
            },
            "内置拓展启停失败",
        ),
        Err(error) => failed(
            &format!("内置拓展启停失败：{error}"),
            fallback_settings_payload(),
        ),
    }
}

/// 拉取所有启用仓库的 skill 清单，合并本地安装/启用状态后返回。
///
/// 单个仓库失败（限流、网络、仓库删了）不影响其它仓库，错误单独收集回前端。
#[tauri::command]
pub fn open_external_url(url: String) -> CommandResult<Value> {
    let trimmed = url.trim();
    if !(trimmed.starts_with("https://") || trimmed.starts_with("http://")) {
        return failed("只允许打开 http 或 https 链接。", json!({}));
    }
    match open_url(trimmed) {
        Ok(()) => ok("已在系统浏览器打开链接。", json!({ "url": trimmed })),
        Err(error) => failed(&format!("打开链接失败：{error}"), json!({ "url": trimmed })),
    }
}

#[tauri::command]
pub async fn repair_shortcuts() -> InstallActionResult {
    tauri::async_runtime::spawn_blocking(install::repair_shortcuts)
        .await
        .unwrap_or_else(|error| install_background_failure("修复快捷方式", error))
}

/// 更新提示里的「跳过此版本」（#1272）：只写 settings.json 的 `updateSkippedVersion` 一个键，
/// 不经前端整份表单保存，避免把其他未保存的草稿一起写进去。返回最新设置供前端合并版本号。
#[tauri::command]
pub fn skip_update_version(version: String) -> CommandResult<SettingsPayload> {
    let version = version.trim().to_string();
    if version.is_empty() {
        return failed("要跳过的版本号为空。", fallback_settings_payload());
    }
    match SettingsStore::default().update(json!({ "updateSkippedVersion": version })) {
        Ok(_) => settings_payload(
            &format!("已跳过 {version}，出现更新的版本时再提示。"),
            "保存跳过版本后重新读取设置失败",
        ),
        Err(error) => failed(
            &format!("保存跳过版本失败：{error}"),
            fallback_settings_payload(),
        ),
    }
}

#[tauri::command]
pub async fn check_update() -> CommandResult<Value> {
    match codex_plus_core::update::check_for_update(codex_plus_core::version::VERSION).await {
        Ok(update) => {
            let status = if update.update_available {
                "ok"
            } else {
                "not_checked"
            };
            CommandResult {
                status: status.to_string(),
                message: if update.update_available {
                    "发现可用更新。".to_string()
                } else {
                    "当前已是最新版本。".to_string()
                },
                payload: json!({
                    "currentVersion": update.current_version,
                    "latestVersion": update.latest_version,
                    "releaseSummary": update.release_summary,
                    "assetName": update.asset_name,
                    "assetUrl": update.asset_url,
                    "updateAvailable": update.update_available,
                    "progress": 0
                }),
            }
        }
        Err(error) => failed(
            &format!("检查更新失败：{error}"),
            json!({
                "currentVersion": codex_plus_core::version::VERSION,
                "latestVersion": Value::Null,
                "releaseSummary": "",
                "assetName": Value::Null,
                "assetUrl": Value::Null,
                "updateAvailable": false,
                "progress": 0
            }),
        ),
    }
}

#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
#[tauri::command]
pub async fn perform_update(
    app: tauri::AppHandle,
    release: Option<codex_plus_core::update::Release>,
) -> CommandResult<Value> {
    let emitter = app.clone();
    let result = perform_update_inner(release, move |progress| {
        let _ = emitter.emit("update-progress", progress);
    })
    .await;
    if result.status == "ok" {
        // 返回下载结果后正常退出，安装器等待后台服务清理完成再替换程序。
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(750));
            app.exit(0);
        });
    }
    result
}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
#[tauri::command]
pub async fn perform_update(
    release: Option<codex_plus_core::update::Release>,
) -> CommandResult<Value> {
    perform_update_inner(release, |_| {}).await
}

// 无需 app runtime 的业务核心；其它平台测试不应引入 Wry 析构依赖。
async fn perform_update_inner<F>(
    release: Option<codex_plus_core::update::Release>,
    mut on_progress: F,
) -> CommandResult<Value>
where
    F: FnMut(codex_plus_core::update::UpdateProgress) + Send,
{
    let Some(release) = release else {
        return failed(
            "请先检查更新并选择可下载的 Release asset。",
            json!({
                "currentVersion": codex_plus_core::version::VERSION,
                "progress": 0
            }),
        );
    };
    let download_dir = codex_plus_core::paths::default_app_state_dir().join("updates");
    match codex_plus_core::update::perform_update_with_progress(
        &release,
        &download_dir,
        &mut on_progress,
    )
    .await
    {
        Ok(result) => ok(
            if cfg!(target_os = "macos") {
                "安装包已验证，Codex Pilot 将关闭以安装更新，完成后自动重启；失败时保留旧版。"
            } else {
                "安装包已下载并启动，请按安装向导完成更新。"
            },
            json!({
            "currentVersion": codex_plus_core::version::VERSION,
            "latestVersion": result.release.version,
            "releaseSummary": result.release.body,
            "installedPath": result.installer_path.to_string_lossy(),
            "launched": result.launched,
            "progress": 100
            }),
        ),
        Err(error) => failed(
            &format!("安装更新失败：{error}"),
            json!({
                "currentVersion": codex_plus_core::version::VERSION,
                "latestVersion": release.version,
                "releaseSummary": release.body,
                "progress": 0
            }),
        ),
    }
}

#[tauri::command]
pub fn load_watcher_state() -> CommandResult<WatcherPayload> {
    ok("开机启动状态已加载。", watcher_payload())
}

/// 界面上的「开机打开 Codex Pilot」开关：开启 = 注册并启用，关闭 = 注销并禁用。
#[tauri::command]
pub fn set_watcher_enabled(enabled: bool) -> CommandResult<WatcherPayload> {
    let launcher_path =
        codex_plus_core::install::companion_binary_path(codex_plus_core::install::SILENT_BINARY);
    match codex_plus_core::watcher::set_watcher_enabled(
        enabled,
        &launcher_path,
        default_debug_port(),
    ) {
        Ok(()) if enabled => ok("开机启动已开启。", watcher_payload()),
        Ok(()) => ok("开机启动已关闭。", watcher_payload()),
        Err(error) if enabled => failed(&format!("开启开机启动失败：{error}"), watcher_payload()),
        Err(error) => failed(&format!("关闭开机启动失败：{error}"), watcher_payload()),
    }
}

#[tauri::command]
pub fn set_watcher_start_minimized(minimized: bool) -> CommandResult<WatcherPayload> {
    match codex_plus_core::watcher::set_watcher_start_minimized(minimized) {
        Ok(()) if minimized => ok("开机启动时将自动最小化。", watcher_payload()),
        Ok(()) => ok("已取消开机启动自动最小化。", watcher_payload()),
        Err(error) => failed(
            &format!("设置开机启动自动最小化失败：{error}"),
            watcher_payload(),
        ),
    }
}

#[tauri::command]
pub fn set_watcher_start_codex(start_codex: bool) -> CommandResult<WatcherPayload> {
    match codex_plus_core::watcher::set_watcher_start_codex(start_codex) {
        Ok(()) if start_codex => ok("登录时将自动启动 Codex。", watcher_payload()),
        Ok(()) => ok("已取消登录时自动启动 Codex。", watcher_payload()),
        Err(error) => failed(
            &format!("设置登录时自动启动 Codex 失败：{error}"),
            watcher_payload(),
        ),
    }
}

#[tauri::command]
pub fn set_watcher_start_codex_on_open(enabled: bool) -> CommandResult<WatcherPayload> {
    match codex_plus_core::watcher::set_watcher_start_codex_on_open(enabled) {
        Ok(()) if enabled => ok("打开 Codex Pilot 时将自动启动 Codex。", watcher_payload()),
        Ok(()) => ok("已取消打开 Codex Pilot 时自动启动 Codex。", watcher_payload()),
        Err(error) => failed(
            &format!("设置打开 Codex Pilot 时自动启动失败：{error}"),
            watcher_payload(),
        ),
    }
}

#[tauri::command]
pub fn export_settings(path: String, mut settings: BackendSettings) -> CommandResult<Value> {
    let path = PathBuf::from(path.trim());
    if path.as_os_str().is_empty() {
        return failed("导出路径为空。", json!({}));
    }
    settings.settings_revision.clear();
    let document = SettingsExportDocument {
        schema: 1,
        exported_at_ms: current_timestamp_ms(),
        settings,
    };
    let contents = match serde_json::to_vec_pretty(&document) {
        Ok(contents) => contents,
        Err(error) => return failed(&format!("序列化配置失败：{error}"), json!({})),
    };
    if let Some(parent) = path.parent()
        && let Err(error) = fs::create_dir_all(parent)
    {
        return failed(&format!("创建导出目录失败：{error}"), json!({}));
    }
    match fs::write(&path, contents) {
        Ok(()) => ok(
            "配置已导出。导出文件包含语音等服务配置和敏感信息，请妥善保管。",
            json!({ "path": path.to_string_lossy() }),
        ),
        Err(error) => failed(&format!("写入配置导出文件失败：{error}"), json!({})),
    }
}

#[tauri::command]
pub fn preview_import_settings(path: String) -> CommandResult<SettingsPayload> {
    let path = PathBuf::from(path.trim());
    let bytes = match fs::read(&path) {
        Ok(bytes) if bytes.len() <= 8 * 1024 * 1024 => bytes,
        Ok(_) => return failed("配置导入文件超过 8 MiB 上限。", fallback_settings_payload()),
        Err(error) => {
            return failed(
                &format!("读取配置导入文件失败：{error}"),
                fallback_settings_payload(),
            );
        }
    };
    let value: Value = match serde_json::from_slice(&bytes) {
        Ok(value) => value,
        Err(error) => {
            return failed(
                &format!("配置导入文件不是有效 JSON：{error}"),
                fallback_settings_payload(),
            );
        }
    };
    let mut settings = match settings_from_import(value) {
        Ok(settings) => settings,
        Err(error) => {
            return failed(
                &format!("配置导入文件格式无效：{error}"),
                fallback_settings_payload(),
            );
        }
    };
    let current = match SettingsStore::default().load() {
        Ok(current) => current,
        Err(error) => {
            return failed(
                &format!("读取当前设置失败：{error}"),
                fallback_settings_payload(),
            );
        }
    };
    settings.settings_revision = current.settings_revision;
    ok(
        "配置已读入，界面将自动保存到本机。",
        SettingsPayload {
            revision: settings.settings_revision.clone(),
            settings,
            settings_path: codex_plus_core::paths::default_settings_path()
                .to_string_lossy()
                .to_string(),
            builtin_extensions: builtin_extension_inventory(),
        },
    )
}

fn settings_from_import(value: Value) -> serde_json::Result<BackendSettings> {
    // 仅从当前设置模型解码；退役功能和未知字段不会进入导入草稿。
    let settings = value.get("settings").cloned().unwrap_or(value);
    if !settings.is_object() {
        return Err(serde::de::Error::custom("settings 必须是 JSON 对象"));
    }
    serde_json::from_value(settings)
}

fn settings_file_contents(path: &Path) -> anyhow::Result<Vec<u8>> {
    // 路径迁移同样经过当前模型，不能直接复制旧 JSON 里的退役字段。
    let mut settings = SettingsStore::new(path.to_path_buf()).load()?;
    settings.settings_revision.clear();
    Ok(serde_json::to_vec_pretty(&settings)?)
}

#[tauri::command]
pub fn set_settings_path(path: String) -> CommandResult<SettingsPayload> {
    if codex_plus_core::paths::state_dir_override().is_some() {
        return failed(
            "当前实例使用指定状态目录，不支持修改全局配置文件路径。",
            fallback_settings_payload(),
        );
    }
    let target = PathBuf::from(path.trim());
    if !target.is_absolute() {
        return failed("配置文件路径必须是绝对路径。", fallback_settings_payload());
    }
    let current = codex_plus_core::paths::default_settings_path();
    if current != target && target.exists() {
        return failed(
            "目标配置文件已存在，为避免覆盖文件请先选择新路径。",
            fallback_settings_payload(),
        );
    }
    if current != target {
        let contents = match settings_file_contents(&current) {
            Ok(contents) => contents,
            Err(error) => {
                return failed(
                    &format!("读取当前设置失败：{error}"),
                    fallback_settings_payload(),
                );
            }
        };
        if let Some(parent) = target.parent()
            && let Err(error) = fs::create_dir_all(parent)
        {
            return failed(
                &format!("创建配置目录失败：{error}"),
                fallback_settings_payload(),
            );
        }
        if let Err(error) = fs::write(&target, contents) {
            return failed(
                &format!("复制配置文件失败：{error}"),
                fallback_settings_payload(),
            );
        }
    }
    if let Err(error) = codex_plus_core::paths::set_settings_path_pointer(Some(&target)) {
        if current != target {
            let _ = fs::remove_file(&target);
        }
        return failed(
            &format!("保存配置路径失败：{error}"),
            fallback_settings_payload(),
        );
    }
    settings_payload(
        "配置文件路径已更新；重新打开管理器后所有组件都会使用新路径。",
        "路径更新后重新读取失败",
    )
}

#[tauri::command]
pub fn reset_settings_path() -> CommandResult<SettingsPayload> {
    if codex_plus_core::paths::state_dir_override().is_some() {
        return failed(
            "当前实例使用指定状态目录，不支持修改全局配置文件路径。",
            fallback_settings_payload(),
        );
    }
    let current = codex_plus_core::paths::default_settings_path();
    let target = codex_plus_core::paths::default_app_state_dir().join("settings.json");
    if current != target {
        let contents = match settings_file_contents(&current) {
            Ok(contents) => contents,
            Err(error) => {
                return failed(
                    &format!("读取当前设置失败：{error}"),
                    fallback_settings_payload(),
                );
            }
        };
        // 迁移路径时默认位置会留下一份旧副本；过去这里直接拒绝，迁移过一次就再也
        // 恢复不了默认路径。现在把旧副本改名备份后再写入当前配置，不丢任何内容。
        if target.exists() {
            let backup = target.with_file_name(format!(
                "settings.json.before-reset-{}.bak",
                current_timestamp_ms()
            ));
            if let Err(error) = fs::rename(&target, &backup) {
                return failed(
                    &format!("备份默认位置的旧配置失败：{error}"),
                    fallback_settings_payload(),
                );
            }
        }
        if let Err(error) = fs::create_dir_all(target.parent().unwrap_or(Path::new(".")))
            .map_err(anyhow::Error::from)
            .and_then(|_| codex_plus_core::settings::atomic_write(&target, &contents))
        {
            return failed(
                &format!("恢复默认配置路径失败：{error}"),
                fallback_settings_payload(),
            );
        }
    }
    if let Err(error) = codex_plus_core::paths::set_settings_path_pointer(None) {
        return failed(
            &format!("清除配置路径失败：{error}"),
            fallback_settings_payload(),
        );
    }
    settings_payload("已恢复默认配置文件路径。", "恢复默认路径后重新读取失败")
}

#[tauri::command]
pub fn reset_settings() -> CommandResult<SettingsPayload> {
    let settings = BackendSettings::default();
    match SettingsStore::default().save(&settings) {
        Ok(()) => settings_payload("设置已重置为默认值。", "设置重置后重新读取失败"),
        Err(error) => failed(
            &format!("重置设置失败：{error}"),
            SettingsPayload {
                revision: settings.settings_revision.clone(),
                settings,
                settings_path: codex_plus_core::paths::default_settings_path()
                    .to_string_lossy()
                    .to_string(),
                builtin_extensions: builtin_extension_inventory(),
            },
        ),
    }
}

#[tauri::command]
pub fn write_diagnostic_event(event: String, detail: Value) -> CommandResult<Value> {
    let event = sanitize_manager_event(&event);
    match codex_plus_core::diagnostic_log::append_diagnostic_log(&event, detail) {
        Ok(()) => ok("诊断日志已写入。", json!({})),
        Err(error) => failed(&format!("写入诊断日志失败：{error}"), json!({})),
    }
}

fn sanitize_manager_event(event: &str) -> String {
    let suffix = event
        .trim()
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.') {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    let suffix = suffix.trim_matches(['.', '_', '-']).trim();
    if suffix.is_empty() {
        "manager.ui.event".to_string()
    } else if suffix.starts_with("manager.") {
        suffix.to_string()
    } else {
        format!("manager.ui.{suffix}")
    }
}

fn open_url(url: &str) -> anyhow::Result<()> {
    #[cfg(windows)]
    {
        codex_plus_core::windows_open_url(url)
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(url)
            .spawn()
            .map(|_| ())
            .map_err(|error| anyhow::anyhow!("启动系统浏览器失败：{error}"))
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(url)
            .spawn()
            .map(|_| ())
            .map_err(|error| anyhow::anyhow!("启动系统浏览器失败：{error}"))
    }
}

fn settings_payload(message: &str, failure_context: &str) -> CommandResult<SettingsPayload> {
    match settings_payload_value() {
        Ok(payload) => ok(message, payload),
        Err((error, payload)) => failed(&format!("{failure_context}：{error}"), payload),
    }
}

fn settings_payload_value() -> Result<SettingsPayload, (anyhow::Error, SettingsPayload)> {
    let store = SettingsStore::default();
    let settings_path = codex_plus_core::paths::default_settings_path()
        .to_string_lossy()
        .to_string();
    match store.load() {
        Ok(settings) => Ok(SettingsPayload {
            revision: settings.settings_revision.clone(),
            settings,
            settings_path,
            builtin_extensions: builtin_extension_inventory(),
        }),
        Err(error) => Err((
            error,
            SettingsPayload {
                revision: String::new(),
                settings: BackendSettings::default(),
                settings_path,
                builtin_extensions: builtin_extension_inventory(),
            },
        )),
    }
}

fn fallback_settings_payload() -> SettingsPayload {
    SettingsPayload {
        revision: SettingsStore::default().revision().unwrap_or_default(),
        settings: SettingsStore::default().load().unwrap_or_default(),
        settings_path: codex_plus_core::paths::default_settings_path()
            .to_string_lossy()
            .to_string(),
        builtin_extensions: builtin_extension_inventory(),
    }
}

fn builtin_extension_inventory() -> Value {
    default_user_script_manager()
        .inventory()
        .unwrap_or_else(|error| {
            json!({
                "enabled": true,
                "scripts": [],
                "error": error.to_string()
            })
        })
}

pub(crate) fn default_user_script_manager() -> UserScriptManager {
    // 目录算法统一在 core，启动器、本地代理、钩子分发共用同一份。
    codex_plus_core::user_scripts::default_user_script_manager()
}

fn load_overview_payload() -> (
    Option<PathBuf>,
    install::EntryPointState,
    Option<LaunchStatus>,
    crate::runtime_health::RuntimeHealth,
) {
    let settings = SettingsStore::default().load().unwrap_or_default();
    let latest = StatusStore::default().load_latest().unwrap_or(None);
    let runtime_health = crate::runtime_health::inspect(latest.as_ref());
    (
        codex_plus_core::app_paths::resolve_codex_app_dir_with_saved(
            None,
            Some(settings.codex_app_path.as_str()),
        ),
        install::inspect_entrypoints(),
        latest,
        runtime_health,
    )
}

fn install_background_failure(action: &str, error: impl std::fmt::Display) -> InstallActionResult {
    let state = install::inspect_entrypoints();
    InstallActionResult {
        status: "failed".to_string(),
        message: format!("{action}后台任务失败：{error}"),
        silent_shortcut: state.silent_shortcut,
        management_shortcut: state.management_shortcut,
    }
}

fn watcher_payload() -> WatcherPayload {
    let flag = codex_plus_core::watcher::default_watcher_disabled_flag();
    WatcherPayload {
        enabled: codex_plus_core::watcher::watcher_is_installed() && !flag.exists(),
        disabled_flag: flag.to_string_lossy().to_string(),
        start_minimized: codex_plus_core::watcher::watcher_start_minimized(),
        start_codex: codex_plus_core::watcher::watcher_start_codex(),
        start_codex_on_open: codex_plus_core::watcher::watcher_start_codex_on_open(),
    }
}

fn path_state(path: Option<PathBuf>) -> PathState {
    match path {
        Some(path) => PathState {
            status: "found".to_string(),
            path: Some(path.to_string_lossy().to_string()),
        },
        None => PathState {
            status: "missing".to_string(),
            path: None,
        },
    }
}

fn shortcut_state(shortcut: install::ShortcutState) -> PathState {
    PathState {
        status: if shortcut.installed {
            "installed".to_string()
        } else {
            "missing".to_string()
        },
        path: shortcut.path,
    }
}

pub(crate) fn ok<T: Serialize>(message: &str, payload: T) -> CommandResult<T> {
    CommandResult {
        status: "ok".to_string(),
        message: message.to_string(),
        payload,
    }
}

pub(crate) fn failed<T: Serialize>(message: &str, payload: T) -> CommandResult<T> {
    CommandResult {
        status: "failed".to_string(),
        message: message.to_string(),
        payload,
    }
}

fn default_debug_port() -> u16 {
    9229
}

#[cfg(test)]
mod tests {

    use super::*;

    #[test]
    fn settings_import_export_and_path_transfer_keep_only_current_configuration() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("settings.json");
        let legacy = json!({
            "revision": "old-file-revision",
            "tray_panel": false, "lightweight_on_close": true,
            "weixinConnectEnabled": true, "weixinConnectToken": "retired-test-token",
            "codexAppDreamSkinTheme": "retired", "relayProfiles": [],
            "codexAppThreadIdBadge": true,
            "codexExtraArgs": ["--force_high_performance_gpu"],
            "codexAppPluginMarketplaceUnlock": true,
            "relayContextConfigContents": "[mcp_servers.retired]\ncommand = 'npx'\n",
            "relayCommonConfigContents": "[skills.retired]\nenabled = true\n",
            "dictation": { "enabled": true, "apiKey": "retired-test-key" },
            "codexAppStepwiseEnabled": true, "codexAppStepwiseApiKey": "retired-test-key",
            "codexAppAnswerOutlineEnabled": true,
            "codexAppNativeFastUnlock": true,
            "codexAppNativePredictions": true,
            "codexAppNativePredictionsModel": "fixture-model",
            "codexAppNativeProjectSections": true
        });
        let original = serde_json::to_vec(&legacy).unwrap();
        fs::write(&path, &original).unwrap();
        let check = |value: &Value| {
            for key in [
                "tray_panel",
                "lightweight_on_close",
                "weixinConnectEnabled",
                "weixinConnectToken",
                "codexAppDreamSkinTheme",
                "relayProfiles",
                "codexExtraArgs",
                "codexAppPluginMarketplaceUnlock",
                "relayContextConfigContents",
                "relayCommonConfigContents",
                "dictation",
                "codexAppStepwiseEnabled",
                "codexAppStepwiseApiKey",
                "codexAppThreadIdBadge",
                "codexAppAnswerOutlineEnabled",
            ] {
                assert!(value.get(key).is_none(), "retired field transferred: {key}");
            }
            // 精简后只传递现行增强；旧对话功能的开关不能再被测试当成有效设置。
            assert_eq!(value["codexAppNativeFastUnlock"], true);
            assert_eq!(value["codexAppNativePredictions"], true);
            assert_eq!(value["codexAppNativePredictionsModel"], "fixture-model");
            assert_eq!(value["codexAppNativeProjectSections"], true);
        };
        for document in [legacy.clone(), json!({ "schema": 1, "settings": legacy })] {
            let imported = settings_from_import(document).unwrap();
            check(&serde_json::to_value(&imported).unwrap());
            let export_path = root.path().join("export.json");
            assert_eq!(
                export_settings(export_path.to_string_lossy().into(), imported).status,
                "ok"
            );
            let exported: Value = serde_json::from_slice(&fs::read(export_path).unwrap()).unwrap();
            check(&exported["settings"]);
            assert!(exported["settings"].get("revision").is_none());
        }
        let transferred: Value =
            serde_json::from_slice(&settings_file_contents(&path).unwrap()).unwrap();
        check(&transferred);
        assert!(transferred.get("revision").is_none());
        // 读取、导入和导出均不应修改源文件或落盘导入草稿。
        assert_eq!(fs::read(&path).unwrap(), original);
    }

    #[test]
    fn settings_path_transfer_rejects_malformed_source_without_overwriting_it() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("settings.json");
        let original = b"{ broken json";
        fs::write(&path, original).unwrap();
        assert!(settings_file_contents(&path).is_err());
        assert_eq!(fs::read(&path).unwrap(), original);
        assert!(settings_from_import(json!({ "settings": [] })).is_err());
    }

    /// 进程级全局状态的测试锁。
    ///
    /// 不止保护 `CODEX_HOME`：`paths::set_settings_path_for_tests`、
    /// `GROK_HOME` 同样是进程级的，两个测试并行跑就会互相把对方的值冲掉
    /// （表现为「单独跑过、全量跑挂」）。凡是动这几样的测试都必须先拿这把锁。

    #[test]
    fn native_browser_diagnostics_keeps_connection_independent_from_patch_status() {
        let result = NativeBrowserDiagnostics {
            compatibility: codex_plus_core::native_browser::BrowserStatus {
                state: "runtime_unverified".into(),
                detail: "Legacy runtime mismatch".into(),
            },
            connection: codex_plus_core::native_browser_connection::ConnectionStatus {
                state: "available".into(),
                failed_checks: 0,
                browsers: vec![
                    codex_plus_core::native_browser_connection::ConnectedBrowser {
                        family: "edge".into(),
                        header_enabled: Some(true),
                        recognized: true,
                    },
                ],
            },
        };
        let json = serde_json::to_value(result).unwrap();
        assert_eq!(json["compatibility"]["state"], "runtime_unverified");
        assert_eq!(json["connection"]["state"], "available");
        assert_eq!(json["connection"]["browsers"][0]["headerEnabled"], true);
        assert_eq!(json["connection"]["failedChecks"], 0);
    }

    #[test]
    fn requested_launch_status_identifies_the_current_request() {
        let request = LaunchRequest {
            app_path: "C:/Program Files/Codex".to_string(),
            debug_port: 9333,
        };

        let status = requested_launch_status(&request, "starting", "starting", 12345);

        assert_eq!(status.status, "starting");
        assert_eq!(status.message, "starting");
        assert_eq!(status.started_at_ms, 12345);
        assert_eq!(status.debug_port, Some(9333));
        assert_eq!(status.codex_app.as_deref(), Some("C:/Program Files/Codex"));
    }

    #[test]
    fn repeated_activation_returns_the_current_session_identity_and_actual_ports() {
        let request = launch_request();
        let current = LaunchStatus {
            status: "running".into(),
            started_at_ms: 123,
            debug_port: Some(9333),
            ..LaunchStatus::default()
        };
        assert_eq!(
            launch_identity_from_status(&request, 456, Some(&current)),
            (9333, 123)
        );
        let starting = LaunchStatus {
            status: "starting".into(),
            ..current
        };
        assert_eq!(
            launch_identity_from_status(&request, 456, Some(&starting)),
            (request.debug_port, 456)
        );
    }

    #[test]
    fn requested_launch_status_omits_an_unresolved_app_path() {
        let request = LaunchRequest {
            app_path: "  ".to_string(),
            debug_port: 9229,
        };

        let status = requested_launch_status(&request, "starting", "starting", 1);

        assert_eq!(status.codex_app, None);
    }

    /// issue #2403：停止阶段要给出可判断的中间态（phase + progress），
    /// 否则十几秒的阻塞等待在界面上和「卡死」无法区分。
    #[test]
    fn stopping_status_carries_phase_and_progress() {
        let request = launch_request();

        let status = requested_launch_status_with_phase(
            &request,
            "stopping",
            "正在停止旧实例",
            12345,
            "restart_stopping",
            10,
        );

        assert_eq!(status.status, "stopping");
        assert_eq!(status.phase.as_deref(), Some("restart_stopping"));
        assert_eq!(status.progress, Some(10));
        // 中间态仍要带上请求标识，供「最近启动」判断是否属于本次重启。
        assert_eq!(status.started_at_ms, 12345);
        assert_eq!(status.debug_port, Some(request.debug_port));
    }

    /// 进度百分比必须收敛到 0~100，越界值不能写进状态文件。
    #[test]
    fn stopping_status_clamps_progress() {
        let request = launch_request();

        let status =
            requested_launch_status_with_phase(&request, "stopping", "msg", 1, "phase", 250);

        assert_eq!(status.progress, Some(100));
    }

    /// 普通启动状态不带阶段信息，保持既有行为（进度字段为 None）。
    #[test]
    fn plain_launch_status_has_no_phase() {
        let status = requested_launch_status(&launch_request(), "starting", "starting", 1);

        assert_eq!(status.phase, None);
        assert_eq!(status.progress, None);
    }

    #[test]
    fn backend_version_returns_structured_payload() {
        let result = backend_version();

        assert_eq!(result.status, "ok");
        assert!(!result.payload.version.is_empty());
    }

    #[test]
    fn restart_only_stops_an_app_that_is_running() {
        assert_eq!(restart_disposition(false), RestartDisposition::LaunchOnly);
        assert_eq!(
            restart_disposition(true),
            RestartDisposition::StopAndRestart
        );
    }

    #[test]
    fn restart_and_launch_share_a_single_flight_guard() {
        let first = try_acquire_launch_guard().unwrap();
        assert!(try_acquire_launch_guard().is_err());
        drop(first);
        assert!(try_acquire_launch_guard().is_ok());
    }

    #[test]
    fn startup_options_returns_structured_payload() {
        let result = startup_options();

        assert_eq!(result.status, "ok");
    }

    #[test]
    fn startup_options_honors_show_update_environment() {
        unsafe {
            std::env::set_var("CODEX_PLUS_SHOW_UPDATE", "1");
        }

        let result = startup_options();

        unsafe {
            std::env::remove_var("CODEX_PLUS_SHOW_UPDATE");
        }

        assert_eq!(result.status, "ok");
        assert!(result.payload.show_update);
    }

    #[test]
    fn startup_options_honors_show_update_argument() {
        assert!(should_show_update(
            ["codex-pilot-manager.exe", "--show-update"],
            None
        ));
    }

    #[test]
    fn overview_contains_expected_operational_fields() {
        let result = tauri::async_runtime::block_on(load_overview());

        assert_eq!(result.status, "ok");
        assert!(!result.payload.current_version.is_empty());
        assert!(
            result.payload.codex_version.is_none()
                || result
                    .payload
                    .codex_version
                    .as_deref()
                    .is_some_and(|version| !version.is_empty())
        );
        assert!(matches!(
            result.payload.codex_app.status.as_str(),
            "found" | "missing"
        ));
        assert!(matches!(
            result.payload.silent_shortcut.status.as_str(),
            "installed" | "missing"
        ));
    }

    #[test]
    fn update_install_requires_release_payload() {
        let result = tauri::async_runtime::block_on(perform_update_inner(None, |_| {}));

        assert_eq!(result.status, "failed");
        assert!(result.message.contains("请先检查更新"));
    }

    #[test]
    fn watcher_state_returns_disabled_flag_path() {
        let result = load_watcher_state();

        assert_eq!(result.status, "ok");
        assert!(result.payload.disabled_flag.contains("watcher.disabled"));
    }

    #[test]
    fn tray_menu_only_has_show_and_quit_in_both_languages() {
        let source =
            std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/lib.rs")).unwrap();

        assert!(source.contains("Menu::with_items(app, &[&show_item, &quit_item])"));
        assert!(source.contains("Menu::with_items(&app, &[&show, &quit])"));
        assert!(!source.contains("tray_apply_dream_skin"));
        assert!(!source.contains("apply_dream_skin_from_tray"));
    }

    fn launch_request() -> LaunchRequest {
        LaunchRequest::default()
    }

    #[test]
    fn restart_stops_codex_then_runtime_before_checking_native_cleanup() {
        let events = std::cell::RefCell::new(Vec::new());
        stop_codex_plus_for_restart(
            || {
                events.borrow_mut().push("codex");
                Ok(())
            },
            || {
                events.borrow_mut().push("runtime");
                Ok(())
            },
            || {
                events.borrow_mut().push("cleanup");
                Ok(codex_plus_core::native_browser::NativeBrowserShutdown::Ready)
            },
        )
        .unwrap();
        assert_eq!(*events.borrow(), ["codex", "runtime", "cleanup"]);
    }

    #[test]
    fn restore_failure_is_reported_after_runtime_has_stopped() {
        let stopped = std::cell::Cell::new(false);
        let shutdown = stop_codex_plus_for_restart(
            || Ok(()),
            || {
                stopped.set(true);
                Ok(())
            },
            || Ok(codex_plus_core::native_browser::NativeBrowserShutdown::RestoreFailed),
        )
        .unwrap();
        assert!(stopped.get());
        assert_eq!(
            shutdown,
            codex_plus_core::native_browser::NativeBrowserShutdown::RestoreFailed
        );
    }

    #[test]
    fn restart_stop_errors_name_the_step_that_failed() {
        let browser = restart_stop_failure_message(&RestartStopError::NativeBrowser(
            anyhow::Error::new(codex_plus_core::native_browser::NativeBrowserCleanupStillRunning),
        ));
        let runtime = restart_stop_failure_message(&RestartStopError::Runtime(anyhow::anyhow!(
            "runtime still exiting"
        )));
        assert!(browser.contains("原生浏览器文件仍在恢复"));
        assert!(runtime.contains("后台服务尚未清理完成"));
        assert!(!runtime.contains("原生浏览器文件仍在恢复"));
        let codex = restart_stop_failure_message(&RestartStopError::Codex(anyhow::anyhow!(
            "app remains running"
        )));
        assert!(codex.contains("Codex 进程尚未确认退出"));
        let failed = restart_stop_failure_message(&RestartStopError::NativeBrowser(
            anyhow::anyhow!("Invalid native cleanup receipt"),
        ));
        assert!(failed.contains("原生浏览器文件恢复失败"));
    }

    #[test]
    fn stop_errors_name_the_step_without_mentioning_a_new_instance() {
        // 侧栏「停止 Codex」不会启动新实例，提示里不能出现「未启动新实例」这类重启用语。
        let codex = stop_failure_message(&RestartStopError::Codex(anyhow::anyhow!(
            "app remains running"
        )));
        let runtime = stop_failure_message(&RestartStopError::Runtime(anyhow::anyhow!(
            "runtime still exiting"
        )));
        let browser =
            stop_failure_message(&RestartStopError::NativeBrowser(anyhow::anyhow!("receipt")));
        assert!(codex.contains("Codex 进程尚未确认退出"));
        assert!(runtime.contains("后台服务尚未清理完成"));
        assert!(browser.contains("原生浏览器文件尚未恢复"));
        for message in [codex, runtime, browser] {
            assert!(!message.contains("新实例"), "{message}");
        }
    }

    #[test]
    fn restart_does_not_continue_when_runtime_cleanup_fails() {
        let result = stop_codex_plus_for_restart(
            || Ok(()),
            || anyhow::bail!("runtime still running"),
            || panic!("must not continue before runtime cleanup"),
        );
        assert!(matches!(result, Err(RestartStopError::Runtime(_))));
    }

    #[test]
    fn restart_does_not_cleanup_if_app_stop_fails() {
        let result = stop_codex_plus_for_restart(
            || anyhow::bail!("app remains running"),
            || panic!("must not stop runtime"),
            || panic!("must not wait on cleanup"),
        );
        assert!(matches!(result, Err(RestartStopError::Codex(_))));
    }

    #[test]
    fn open_external_url_rejects_non_http_urls() {
        let result = open_external_url("file:///C:/Windows/win.ini".to_string());

        assert_eq!(result.status, "failed");
        assert!(result.message.contains("只允许打开 http 或 https 链接"));
    }
}
