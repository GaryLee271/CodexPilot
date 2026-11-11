use std::future::Future;

use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::Context;
use async_trait::async_trait;
use serde_json::Value;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

use crate::settings::{BackendSettings, SettingsStore};
use crate::status::{LaunchStatus, StatusStore};

const BRIDGE_HEALTH_FAILURE_THRESHOLD: u8 = 2;
/// 重注入退避：首次重注入立即执行，此后若桥仍不健康，重注入间隔按
/// 10s → 20s → 40s … 指数增长并封顶。对重注入修不好的失效（如应用更新
/// 改变了页面上下文），避免每 10~15 秒重发一次完整注入脚本（issue #2169）。
const BRIDGE_REINJECT_BACKOFF_BASE_SECS: u64 = 10;
const BRIDGE_REINJECT_BACKOFF_CAP_SECS: u64 = 300;
/// 重注入后紧接着的那次健康检查必然通过（`lastInjectionAt` 还在 5 秒窗口内），
/// 若一见健康就清零，退避会永远停在第一档、根本挡不住周期性重注入（issue #2330）。
/// 必须持续健康满这么久才清零。
const BRIDGE_REINJECT_BACKOFF_RESET_AFTER_SECS: u64 = 60;

/// 看门狗内跟踪重注入退避状态；持续健康一段时间或应用实例更换时重置。
#[derive(Debug, Default)]
struct BridgeReinjectBackoff {
    consecutive_attempts: u32,
    next_allowed_at: Option<std::time::Instant>,
    healthy_since: Option<std::time::Instant>,
}

fn reinject_backoff_delay(consecutive_attempts: u32) -> std::time::Duration {
    let factor = 1u64
        .checked_shl(consecutive_attempts.min(u64::BITS - 1))
        .unwrap_or(u64::MAX);
    std::time::Duration::from_secs(
        BRIDGE_REINJECT_BACKOFF_BASE_SECS
            .saturating_mul(factor)
            .min(BRIDGE_REINJECT_BACKOFF_CAP_SECS),
    )
}

impl BridgeReinjectBackoff {
    fn ready(&self, now: std::time::Instant) -> bool {
        self.next_allowed_at.is_none_or(|deadline| now >= deadline)
    }

    fn record_attempt(&mut self, now: std::time::Instant) {
        let delay = reinject_backoff_delay(self.consecutive_attempts);
        self.next_allowed_at = Some(now + delay);
        self.consecutive_attempts = self.consecutive_attempts.saturating_add(1);
    }

    fn reset(&mut self) {
        self.consecutive_attempts = 0;
        self.next_allowed_at = None;
        self.healthy_since = None;
    }

    /// 观测到一次健康：持续健康满 `BRIDGE_REINJECT_BACKOFF_RESET_AFTER_SECS` 才清零。
    fn observe_healthy(&mut self, now: std::time::Instant) {
        let since = *self.healthy_since.get_or_insert(now);
        if now.saturating_duration_since(since)
            >= std::time::Duration::from_secs(BRIDGE_REINJECT_BACKOFF_RESET_AFTER_SECS)
        {
            self.reset();
        }
    }

    /// 观测到一次不健康：重新计时。
    fn observe_unhealthy(&mut self) {
        self.healthy_since = None;
    }
}
const MACOS_DEBUG_TAKEOVER_WAIT_MS: u64 = 5_000;
const MACOS_DEBUG_TAKEOVER_INTERVAL_MS: u64 = 100;

/// 注入重试的总时长预算（issue #2681）。
///
/// 过去这里只有「最多 120 次」这一个上限，而单次失败本身还要等 CDP 连接超时
/// （实测约 92 秒），于是 Codex 根本没监听调试端口时，启动器会空转三个多小时，
/// 期间界面上一直停在「启动中」。改成按总时长收敛：预算耗尽即判失败并降级，
/// 由上层写入 `running_degraded` 让用户知道增强没生效。
const INJECTION_TOTAL_BUDGET: std::time::Duration = std::time::Duration::from_secs(90);
/// 两次注入尝试之间的间隔；失败很快时用它避免忙等。
const INJECTION_RETRY_INTERVAL: std::time::Duration = std::time::Duration::from_secs(1);
/// 注入失败日志的节流周期：只在第 1 次和之后每隔这么多次各记一条。
///
/// 每次失败都记完整错误串会把诊断日志刷到十几 MB（issue #2681），
/// 而这些记录内容彼此相同，保留首末与次数就够了。
const INJECTION_LOG_EVERY_ATTEMPTS: u32 = 10;

/// Asynchronous callback used by the bridge watchdog to restore a launcher-specific bridge.
///
/// Callers that install a custom [`crate::routes::BridgeContext`] should configure this callback
/// before starting the watchdog. Without one, the watchdog falls back to the core bridge injector.
pub type BridgeReinjector =
    Arc<dyn Fn() -> Pin<Box<dyn Future<Output = anyhow::Result<()>> + Send>> + Send + Sync>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CodexLaunch {
    Process {
        command: Vec<String>,
        wait_strategy: ProcessWaitStrategy,
        macos_cleanup_policy: Option<MacosCleanupPolicy>,
    },
    PackagedActivation {
        app_user_model_id: String,
        arguments: String,
        process_id: Option<u32>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessWaitStrategy {
    TrackedChild,
    ExternalWaitCommand,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MacosCleanupPolicy {
    QuitIfNotPreviouslyRunning,
    SkipQuitBecauseAlreadyRunning,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MacosDebugLaunchAction {
    LaunchNew,
    ReuseRunningDebugApp,
    RestartRunningApp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowsProcessControlStrategy {
    NativeWindowsApi,
}

#[cfg(windows)]
pub fn windows_process_control_strategy() -> WindowsProcessControlStrategy {
    WindowsProcessControlStrategy::NativeWindowsApi
}

impl CodexLaunch {
    /// 启动命令携带的最终端口；包上下文 wrapper 可能改选过端口。
    pub fn debug_port(&self) -> Option<u16> {
        let tokens = match self {
            Self::Process { command, .. } => command.iter().map(String::as_str).collect::<Vec<_>>(),
            Self::PackagedActivation { arguments, .. } => arguments.split_whitespace().collect(),
        };
        let mut ports = tokens.iter().enumerate().filter_map(|(index, token)| {
            token
                .strip_prefix("--remote-debugging-port=")
                .or_else(|| {
                    (*token == "--remote-debugging-port")
                        .then(|| tokens.get(index + 1).copied())
                        .flatten()
                })
                .and_then(|value| value.parse::<u16>().ok())
        });
        let first = ports.next()?;
        (first != 0 && ports.all(|port| port == first)).then_some(first)
    }

    pub fn process_id(&self) -> Option<u32> {
        match self {
            Self::PackagedActivation { process_id, .. } => *process_id,
            Self::Process { .. } => None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct LaunchOptions {
    pub app_dir: Option<PathBuf>,
    pub debug_port: u16,
    pub status_store: StatusStore,
    /// 本次启动使用的状态目录，可隔离本地构建与测试。
    pub state_dir: Option<PathBuf>,
    /// Codex 原生配置目录。
    pub codex_home: Option<PathBuf>,
    /// Codex SQLite 目录。
    pub sqlite_home: Option<PathBuf>,
    /// 由「重启 Codex」发起（issue #2764 后续）：Windows 商店版主 Codex 已在运行却没带
    /// 本次调试端口时，结束它再按正常流程启动。普通「启动 Codex」保持 `false`，
    /// 只提示用户自行退出，不结束用户正在用的 Codex。
    pub replace_blocking_main_instance: bool,
}

impl Default for LaunchOptions {
    fn default() -> Self {
        Self {
            app_dir: None,
            debug_port: 9229,
            status_store: StatusStore::default(),
            state_dir: None,
            codex_home: None,
            sqlite_home: None,
            replace_blocking_main_instance: false,
        }
    }
}

/// 启动目录与显式重启策略。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LaunchInstance {
    /// Codex Pilot 状态目录（`settings.json` / `latest-status.json` / 诊断日志）。
    pub state_dir: Option<PathBuf>,
    /// Codex 配置目录（`CODEX_HOME`）。
    pub codex_home: Option<PathBuf>,
    /// Codex SQLite 目录（`CODEX_SQLITE_HOME`）。
    pub sqlite_home: Option<PathBuf>,
    /// 见 [`LaunchOptions::replace_blocking_main_instance`]。
    pub replace_blocking_main_instance: bool,
}

impl LaunchInstance {
    pub fn from_options(options: &LaunchOptions) -> Self {
        Self {
            state_dir: options.state_dir.clone(),
            codex_home: options.codex_home.clone(),
            sqlite_home: options.sqlite_home.clone(),
            replace_blocking_main_instance: options.replace_blocking_main_instance,
        }
    }
}

#[derive(Clone)]
pub struct LaunchHandle {
    pub debug_port: u16,
    pub app_dir: PathBuf,
    pub launch: CodexLaunch,
    pub status_store: StatusStore,
    status_started_at_ms: u64,
    /// 启用中拓展的启动前后声明：Codex 退出后跑 `launch.after`。
    extension_launches: Vec<(String, Value, crate::extension_launch::ExtensionLaunch)>,
    extension_launch_context: crate::extension_launch::LaunchContext,
    hooks: Arc<dyn LaunchHooks>,
}

impl std::fmt::Debug for LaunchHandle {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("LaunchHandle")
            .field("debug_port", &self.debug_port)
            .field("app_dir", &self.app_dir)
            .field("launch", &self.launch)
            .field("status_store", &self.status_store)
            .finish_non_exhaustive()
    }
}

impl LaunchHandle {
    pub async fn wait_for_codex_exit(&self) -> anyhow::Result<()> {
        let result = self
            .hooks
            .wait_for_codex_exit(&self.launch, self.debug_port)
            .await;
        self.hooks.stop_bridge_watchdog().await;
        self.hooks.stop_native_browser_compatibility().await;
        crate::extension_launch::run_scripts(
            "after",
            &self.extension_launch_context,
            &self.extension_launches,
        )
        .await;
        let (status, message) = match &result {
            Ok(()) => (
                "stopped",
                "Codex target is no longer available; launcher stopped.".to_string(),
            ),
            Err(error) => (
                "failed",
                format!("Codex process monitoring failed: {error:#}"),
            ),
        };
        let _ = crate::diagnostic_log::append_diagnostic_log(
            "launcher.exited",
            serde_json::json!({
                "debug_port": self.debug_port,
                "status": status,
                "message": message,
            }),
        );
        if let Err(error) = save_terminal_launch_status(
            &self.status_store,
            self.status_started_at_ms,
            status,
            &message,
        ) {
            let _ = crate::diagnostic_log::append_diagnostic_log(
                "launcher.exit_status_failed",
                serde_json::json!({ "message": format!("{error:#}") }),
            );
        }
        result
    }
}

fn save_terminal_launch_status(
    store: &StatusStore,
    started_at_ms: u64,
    status: &str,
    message: &str,
) -> anyhow::Result<()> {
    let Some(mut latest) = store.load_latest()? else {
        return Ok(());
    };
    // 重启过程中管理器可能已写入新请求；旧 launcher 不能把它覆盖成 stopped。
    if latest.started_at_ms != started_at_ms {
        return Ok(());
    }
    latest.status = status.to_string();
    latest.message = message.to_string();
    latest.phase = None;
    latest.progress = Some(100);
    store.save_latest(&latest)
}

#[async_trait(?Send)]
pub trait LaunchHooks: Send + Sync {
    fn resolve_app_dir(
        &self,
        app_dir: Option<&Path>,
        settings: &BackendSettings,
    ) -> anyhow::Result<PathBuf>;
    fn select_debug_port(&self, requested: u16) -> u16;
    async fn load_settings(&self) -> anyhow::Result<BackendSettings>;
    fn codex_home_dir(&self) -> PathBuf {
        crate::relay_config::default_codex_home_dir()
    }
    fn state_dir(&self) -> PathBuf {
        crate::paths::default_app_state_dir()
    }

    async fn sanitize_local_storage_model_suffixes(&self, debug_port: u16) {
        crate::codex_local_storage::sanitize_local_storage_model_suffixes_nonfatal(debug_port)
            .await;
    }
    async fn start_native_browser_compatibility(&self, _settings: &BackendSettings) {}
    async fn stop_native_browser_compatibility(&self) {}
    fn cleanup_unsupported_config(&self, _settings: &BackendSettings) -> anyhow::Result<()> {
        Ok(())
    }

    async fn launch_codex(
        &self,
        app_dir: &Path,
        debug_port: u16,
        settings: &BackendSettings,
        extra_args: &[String],
        instance: &LaunchInstance,
    ) -> anyhow::Result<CodexLaunch>;
    async fn bridge_context(
        &self,
        _debug_port: u16,
        _app_dir: &Path,
    ) -> anyhow::Result<Option<crate::routes::BridgeContext>> {
        Ok(None)
    }
    async fn inject(&self, debug_port: u16) -> anyhow::Result<()>;
    /// 被拓展顶替的内置拓展按「关」处理后的设置（见 [`crate::builtin_takeover`]）。测试用的钩子原样返回。
    fn effective_settings(&self, settings: BackendSettings) -> BackendSettings {
        settings
    }
    /// 启用中拓展的启动前后声明（codexpp.json 的 `launch`）。测试用的钩子没有。
    fn extension_launches(&self) -> Vec<(String, Value, crate::extension_launch::ExtensionLaunch)> {
        Vec::new()
    }
    /// 有拓展的页面最早期脚本要求启动后重载一次时，整页重载并等页面就绪。
    async fn reload_for_extension_preloads(&self, _debug_port: u16) -> anyhow::Result<()> {
        Ok(())
    }
    /// 原生模块补丁（Fast、输入预测、项目分区）等待准备就绪后，在主动启动时重载一次页面。
    async fn apply_native_module_patches_on_launch(&self, _debug_port: u16) -> anyhow::Result<()> {
        Ok(())
    }
    async fn inject_bridge(
        &self,
        debug_port: u16,
        _ctx: crate::routes::BridgeContext,
    ) -> anyhow::Result<()> {
        self.inject(debug_port).await
    }
    async fn ensure_injection(&self, debug_port: u16, app_dir: &Path) -> bool {
        let outcome = run_injection_attempts(
            INJECTION_TOTAL_BUDGET,
            INJECTION_RETRY_INTERVAL,
            INJECTION_LOG_EVERY_ATTEMPTS,
            |attempt, message| {
                let _ = crate::diagnostic_log::append_diagnostic_log(
                    "launcher.ensure_injection_retry_failed",
                    serde_json::json!({
                        "debug_port": debug_port,
                        "attempt": attempt,
                        "message": message,
                    }),
                );
            },
            |_attempt| async move {
                match self.bridge_context(debug_port, app_dir).await {
                    Ok(Some(ctx)) => self.inject_bridge(debug_port, ctx).await,
                    Ok(None) => self.inject(debug_port).await,
                    Err(error) => Err(error),
                }
            },
        )
        .await;
        // 只在结束时记一条结论，避免每次失败都刷一整条 JSON（issue #2681）。
        let _ = crate::diagnostic_log::append_diagnostic_log(
            "launcher.ensure_injection_done",
            serde_json::json!({
                "debug_port": debug_port,
                "ready": outcome.ready,
                "attempts": outcome.attempts,
                "elapsed_ms": outcome.elapsed_ms,
                "reason": outcome.reason.as_str(),
                "last_error": outcome.last_error,
            }),
        );
        outcome.ready
    }
    /// 初次启动初始化结束时固定身份（包含注入降级）；watchdog 不能重新绑定实例。
    async fn capture_injected_launch_identity(&self, _debug_port: u16) {}
    async fn start_bridge_watchdog(&self, _debug_port: u16) -> anyhow::Result<()> {
        Ok(())
    }
    async fn write_status(&self, status: &str);
    async fn wait_for_codex_exit(
        &self,
        launch: &CodexLaunch,
        debug_port: u16,
    ) -> anyhow::Result<()>;
    async fn stop_bridge_watchdog(&self);
    async fn terminate_codex(&self, launch: &CodexLaunch);
}

#[derive(Default)]
pub struct DefaultLaunchHooks {
    child: Mutex<Option<Child>>,
    bridge_watchdog: Mutex<Option<BridgeWatchdogRuntime>>,
    bridge_reinjector: Mutex<Option<BridgeReinjector>>,
    #[cfg(windows)]
    packaged_executable: Mutex<Option<PathBuf>>,
    #[cfg(windows)]
    packaged_activation_process: Mutex<Option<crate::windows_integration::TrackedWindowsProcess>>,
    #[cfg(windows)]
    packaged_launch_identity: Mutex<Option<PackagedLaunchIdentity>>,
}

#[cfg(windows)]
#[derive(Default)]
struct PackagedLaunchIdentity {
    browser_id: Option<String>,
    process: Option<crate::windows_integration::TrackedWindowsProcess>,
}

struct BridgeWatchdogRuntime {
    shutdown: tokio::sync::oneshot::Sender<()>,
    task: tokio::task::JoinHandle<()>,
}

pub async fn launch_and_inject(options: LaunchOptions) -> anyhow::Result<LaunchHandle> {
    launch_and_inject_with_hooks(options, DefaultLaunchHooks::shared()).await
}

/// 一次注入重试过程为什么停下（issue #2681）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InjectionStopReason {
    /// 注入成功，可以继续启动流程。
    Succeeded,
    /// 总时长预算耗尽，按失败降级处理。
    BudgetExhausted,
}

impl InjectionStopReason {
    fn as_str(self) -> &'static str {
        match self {
            Self::Succeeded => "succeeded",
            Self::BudgetExhausted => "budget_exhausted",
        }
    }
}

/// 注入重试的结果，供调用方写一条结论日志。
#[derive(Debug, Clone)]
struct InjectionOutcome {
    ready: bool,
    attempts: u32,
    elapsed_ms: u128,
    reason: InjectionStopReason,
    last_error: Option<String>,
}

/// 带总时长预算的注入重试循环（issue #2681）。
///
/// 单次注入失败往往要等 CDP 连接超时（实测约 92 秒），只按次数封顶会让启动器
/// 空转数小时。这里改成到点即停，并把失败日志按 `log_every_attempts` 节流，
/// 既保证「注入失败」能很快反映到界面，也不会把诊断日志刷爆。
///
/// `log_failure` 由调用方注入，是为了让节流行为能在测试里直接数调用次数，
/// 而不必去动进程级的诊断日志路径（那是全局状态，并发测试会互相干扰）。
async fn run_injection_attempts<F, Fut, L>(
    budget: std::time::Duration,
    retry_interval: std::time::Duration,
    log_every_attempts: u32,
    mut log_failure: L,
    mut attempt: F,
) -> InjectionOutcome
where
    F: FnMut(u32) -> Fut,
    Fut: Future<Output = anyhow::Result<()>>,
    L: FnMut(u32, &str),
{
    let started = std::time::Instant::now();
    let deadline = started + budget;
    let log_every_attempts = log_every_attempts.max(1);
    let mut attempts = 0u32;
    let mut last_error: Option<String> = None;

    loop {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            return InjectionOutcome {
                ready: false,
                attempts,
                elapsed_ms: started.elapsed().as_millis(),
                reason: InjectionStopReason::BudgetExhausted,
                last_error,
            };
        }
        attempts += 1;
        match tokio::time::timeout(remaining, attempt(attempts)).await {
            Ok(Ok(())) => {
                return InjectionOutcome {
                    ready: true,
                    attempts,
                    elapsed_ms: started.elapsed().as_millis(),
                    reason: InjectionStopReason::Succeeded,
                    last_error: None,
                };
            }
            Ok(Err(error)) => last_error = Some(error.to_string()),
            // 单次尝试把剩余预算耗光：算超时，不再往下重试。
            Err(_) => {
                last_error = Some(format!(
                    "injection attempt timed out after {} ms of the total budget",
                    budget.as_millis()
                ));
                return InjectionOutcome {
                    ready: false,
                    attempts,
                    elapsed_ms: started.elapsed().as_millis(),
                    reason: InjectionStopReason::BudgetExhausted,
                    last_error,
                };
            }
        }
        // 首次失败立刻记一条，之后每隔 N 次记一条，避免 100+ 条同内容记录。
        if attempts == 1 || attempts % log_every_attempts == 0 {
            log_failure(attempts, last_error.as_deref().unwrap_or_default());
        }
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            return InjectionOutcome {
                ready: false,
                attempts,
                elapsed_ms: started.elapsed().as_millis(),
                reason: InjectionStopReason::BudgetExhausted,
                last_error,
            };
        }
        tokio::time::sleep(remaining.min(retry_interval)).await;
    }
}

pub async fn launch_and_inject_with_hooks<H>(
    options: LaunchOptions,
    hooks: H,
) -> anyhow::Result<LaunchHandle>
where
    H: IntoLaunchHooks,
{
    let hooks = hooks.into_launch_hooks();
    let mut debug_port = hooks.select_debug_port(options.debug_port);
    // 被拓展顶替的内置拓展（原生 Fast、强制中文、Work 视图、原生浏览器兼容……）在这次启动里按「关」处理。
    let settings = hooks.effective_settings(hooks.load_settings().await?);
    let app_dir = hooks.resolve_app_dir(options.app_dir.as_deref(), &settings)?;
    let status_store = options.status_store.clone();
    let mut launched = None;
    let mut keep_launched_on_error = false;
    let mut status_started_at_ms = 0;

    let result: anyhow::Result<LaunchHandle> = async {
        // issue #2244：冷启动 80~110 秒期间既没有 latest-status 阶段，也没有带耗时的
        // 日志，用户无法区分「正在处理」与「已经卡死」。每个前置步骤前后都打一次
        // 阶段标记与耗时。
        let timeline = LaunchTimeline::new(options.status_store.clone());
        timeline.mark("start_native_browser_compatibility", 5);
        hooks.start_native_browser_compatibility(&settings).await;
        let home = hooks.codex_home_dir();
        timeline.mark("cleanup_unsupported_config", 10);
        hooks.cleanup_unsupported_config(&settings)?;
        crate::relay_config::ensure_windows_sandbox_usable_for_current_user(&home)?;
        // 增强仅通过 CDP 桥接运行，不再绑定本地 HTTP 端口。

        // 拓展的启动前脚本与追加的启动参数（codexpp.json 的 `launch`）。
        let extension_launches = hooks.extension_launches();
        let extension_launch_context = crate::extension_launch::LaunchContext {
            codex_home: home.clone(),
            state_dir: hooks.state_dir(),
            app_dir: app_dir.clone(),
        };
        if !extension_launches.is_empty() {
            timeline.mark("extension_launch_before", 68);
            crate::extension_launch::run_scripts(
                "before",
                &extension_launch_context,
                &extension_launches,
            )
            .await;
        }
        let launch_args = crate::extension_launch::merged_launch_args(&extension_launches);
        timeline.mark("launch_codex", 70);
        let launch = hooks
            .launch_codex(
                &app_dir,
                debug_port,
                &settings,
                &launch_args,
                &LaunchInstance::from_options(&options),
            )
            .await?;
        debug_port = launch.debug_port().unwrap_or(debug_port);
        launched = Some(launch.clone());
        keep_launched_on_error = true;
        timeline.mark("launch_codex_done", 80);

        let mut injection_degraded = false;
        if settings.enhancements_enabled {
            timeline.mark("ensure_injection", 85);
            let injection_ready = hooks.ensure_injection(debug_port, &app_dir).await;
            timeline.mark("ensure_injection_done", 95);
            if injection_ready {
                keep_launched_on_error = false;
                if crate::native_predictions::native_modules_requested(&settings)
                    && let Err(error) = hooks
                        .apply_native_module_patches_on_launch(debug_port)
                        .await
                {
                    let _ = crate::diagnostic_log::append_diagnostic_log(
                        "launcher.native_module_patch_failed",
                        serde_json::json!({ "message": error.to_string() }),
                    );
                }
                if let Err(error) = hooks.reload_for_extension_preloads(debug_port).await {
                    let _ = crate::diagnostic_log::append_diagnostic_log(
                        "launcher.extension_preload_reload_failed",
                        serde_json::json!({ "message": error.to_string() }),
                    );
                }
                // 注入成功后页面已加载，此时可以通过 CDP 清理 Electron Local Storage
                // 中残留的带后缀模型名，避免模型选择器继续显示废弃项。
                hooks
                    .sanitize_local_storage_model_suffixes(debug_port)
                    .await;
            } else {
                let degraded = launch_status(
                    "running_degraded",
                    "Codex launched; Codex Pilot enhancements are still waiting for the page bridge.",
                    debug_port,
                    &app_dir,
                );
                options.status_store.save_latest(&degraded)?;
                status_started_at_ms = degraded.started_at_ms;
                hooks.write_status("running_degraded").await;
                injection_degraded = true;
            }
        }

        // 注入降级或只启用协议代理也要固定身份；后台重注入不能为旧启动器换绑实例。
        hooks.capture_injected_launch_identity(debug_port).await;
        if settings.enhancements_enabled && !injection_degraded {
            hooks.start_bridge_watchdog(debug_port).await?;
        }

        if !settings.enhancements_enabled || !injection_degraded {
            timeline.mark("ready", 100);
            let status = launch_status("running", "Codex Pilot launcher ready", debug_port, &app_dir);
            options.status_store.save_latest(&status)?;
            status_started_at_ms = status.started_at_ms;
            hooks.write_status("running").await;
        }

        Ok(LaunchHandle {
            debug_port,
            app_dir: app_dir.clone(),
            launch,
            status_store: status_store.clone(),
            status_started_at_ms,
            extension_launches,
            extension_launch_context,
            hooks: Arc::clone(&hooks),
        })
    }
    .await;

    match result {
        Ok(handle) => Ok(handle),
        Err(error) => {
            hooks.stop_native_browser_compatibility().await;
            hooks.stop_bridge_watchdog().await;
            if let Some(launch) = &launched {
                if !keep_launched_on_error {
                    hooks.terminate_codex(launch).await;
                }
            }
            let message = error.to_string();
            let failure = launch_status("failed", &message, debug_port, &app_dir);
            let _ = status_store.save_latest(&failure);
            hooks.write_status("failed").await;
            Err(error)
        }
    }
}

pub trait IntoLaunchHooks {
    fn into_launch_hooks(self) -> Arc<dyn LaunchHooks>;
}

impl<T> IntoLaunchHooks for &T
where
    T: LaunchHooks + Clone + 'static,
{
    fn into_launch_hooks(self) -> Arc<dyn LaunchHooks> {
        Arc::new(self.clone())
    }
}

impl IntoLaunchHooks for Arc<dyn LaunchHooks> {
    fn into_launch_hooks(self) -> Arc<dyn LaunchHooks> {
        self
    }
}

impl IntoLaunchHooks for DefaultLaunchHooks {
    fn into_launch_hooks(self) -> Arc<dyn LaunchHooks> {
        Arc::new(self)
    }
}

impl DefaultLaunchHooks {
    pub fn shared() -> Arc<dyn LaunchHooks> {
        Arc::new(Self::default())
    }

    /// Configures the launcher-specific callback used by subsequent watchdog reinjections.
    pub async fn set_bridge_reinjector(&self, reinjector: BridgeReinjector) {
        *self.bridge_reinjector.lock().await = Some(reinjector);
    }
}

#[async_trait(?Send)]
impl LaunchHooks for DefaultLaunchHooks {
    fn resolve_app_dir(
        &self,
        app_dir: Option<&Path>,
        settings: &BackendSettings,
    ) -> anyhow::Result<PathBuf> {
        crate::app_paths::resolve_codex_app_dir_with_saved(
            app_dir,
            Some(settings.codex_app_path.as_str()),
        )
        .ok_or_else(|| {
            // issue #2204：原来四种失败原因（不存在 / 是 Codex Pilot 目录 / 无可执行文件 /
            // 纯自动探测落空）共用一句「Codex App directory not found」，用户看不出
            // 该改什么。这里按来源细分，并保留原句前缀以便既有日志检索与用户既有
            // 报障文本仍能对上。
            let saved = settings.codex_app_path.trim();
            let message = crate::app_paths::describe_codex_app_dir_not_found(app_dir, Some(saved));
            let _ = crate::diagnostic_log::append_diagnostic_log(
                "launcher.app_dir_not_found",
                serde_json::json!({
                    "explicit_app_path": app_dir.map(|path| path.to_string_lossy().to_string()),
                    "saved_app_path": saved,
                    "reason": message,
                }),
            );
            anyhow::anyhow!(message)
        })
    }

    fn select_debug_port(&self, requested: u16) -> u16 {
        crate::ports::select_packaged_codex_debug_port(requested)
    }

    async fn load_settings(&self) -> anyhow::Result<BackendSettings> {
        SettingsStore::default().load()
    }

    fn cleanup_unsupported_config(&self, _settings: &BackendSettings) -> anyhow::Result<()> {
        let home = crate::relay_config::default_codex_home_dir();
        crate::relay_config::cleanup_unsupported_approval_policies_in_home(&home)?;
        Ok(())
    }

    async fn launch_codex(
        &self,
        app_dir: &Path,
        debug_port: u16,
        _settings: &BackendSettings,
        extra_args: &[String],
        instance: &LaunchInstance,
    ) -> anyhow::Result<CodexLaunch> {
        let launch_extra_args = normalize_launch_args(extra_args);
        if cfg!(windows) {
            // issue #2789：Codex Pilot 以管理员身份运行时，Codex 会被 Chromium 经 explorer 降权
            // 重启而脱离包上下文，这里补上豁免开关（见 `packaged_launch::DO_NOT_DE_ELEVATE_SWITCH`）。
            // 只影响打包版主实例这条分支；未提权时参数原样不变。
            let elevated = crate::windows_integration::current_process_is_elevated();
            let launch_extra_args =
                crate::packaged_launch::packaged_launch_extra_args(&launch_extra_args, elevated);
            // AUMID 解析留在调用点：它要查系统里的 Store 注册表（#2140），是有副作用
            // 的一步；下面的构造函数只做纯拼接。解析不出来（目录名像包、但系统里没
            // 这个包）就不再走打包激活，继续往下按路径启动——与既有回退路径一致。
            let activation =
                crate::app_paths::packaged_app_user_model_id(app_dir).map(|app_user_model_id| {
                    build_packaged_activation(&app_user_model_id, debug_port, &launch_extra_args)
                });
            if let Some(activation) = activation {
                let CodexLaunch::PackagedActivation {
                    app_user_model_id,
                    arguments,
                    ..
                } = &activation
                else {
                    unreachable!();
                };
                // issue #2764：主 Codex 已经开着（开始菜单 / 托盘）但没带本次调试端口时，
                // 单实例锁在它手里，AUMID 激活和包上下文兜底拉起的进程都会把参数交给它后
                // 立即退出，端口永远等不到。先识别出来：「重启 Codex」结束它再启动，
                // 「启动 Codex」直接给出可操作的提示，都不再空跑兜底。
                #[cfg(windows)]
                {
                    let executable = crate::app_paths::build_codex_executable(app_dir);
                    let blocking = existing_main_instances_blocking_debug_launch(
                        &executable,
                        debug_port,
                        &launch_extra_args,
                    )
                    .await;
                    if !blocking.is_empty() {
                        let _ = crate::diagnostic_log::append_diagnostic_log(
                            "launcher.packaged_existing_main_instance_blocks_launch",
                            serde_json::json!({
                                "app_user_model_id": app_user_model_id,
                                "debug_port": debug_port,
                                "process_ids": blocking,
                                "replace": instance.replace_blocking_main_instance,
                            }),
                        );
                    }
                    // 「重启 Codex」：先请它们退出、再只结束主进程本身（不连树），等退出后走下面的正常激活。
                    if !blocking.is_empty() && instance.replace_blocking_main_instance {
                        stop_main_instances_blocking_debug_launch(
                            &executable,
                            debug_port,
                            &launch_extra_args,
                            blocking,
                        )
                        .await?;
                    } else if !blocking.is_empty() {
                        // 「启动 Codex」：不结束用户正在用的 Codex，只提示怎么退出。
                        let executable_name = executable
                            .file_name()
                            .map(|name| name.to_string_lossy().into_owned())
                            .unwrap_or_else(|| "Codex".to_string());
                        anyhow::bail!(
                            crate::packaged_launch::existing_main_instance_blocks_launch_message(
                                debug_port,
                                &executable_name,
                                &blocking,
                            )
                        );
                    }
                }
                // 激活前留一条记录：日志停在这里就说明卡在激活调用本身（#2795）。
                let _ = crate::diagnostic_log::append_diagnostic_log(
                    "launcher.packaged_activation_begin",
                    serde_json::json!({
                        "app_user_model_id": app_user_model_id,
                        "debug_port": debug_port,
                        "elevated": elevated,
                        "arguments": arguments,
                    }),
                );
                match activate_packaged_app(app_user_model_id, arguments).await {
                    Ok(process_id) => {
                        #[cfg(windows)]
                        {
                            let executable = crate::app_paths::build_codex_executable(app_dir);
                            // 立即持有激活 PID，不能在漫长注入之后再按旧 PID 打开进程。
                            let process =
                                match crate::windows_integration::TrackedWindowsProcess::capture(
                                    process_id,
                                    &executable,
                                ) {
                                    Ok(process) => process,
                                    Err(error) => {
                                        let _ = crate::diagnostic_log::append_diagnostic_log(
                                            "launcher.packaged_process_wait_failed_nonfatal",
                                            serde_json::json!({ "process_id": process_id, "message": format!("{error:#}") }),
                                        );
                                        None
                                    }
                                };
                            // issue #2700：Codex 26.1021 起，带调试参数的 AUMID 激活会让
                            // 进程立即退出、调试端口永不监听。这里短暂观察激活结果，确认
                            // 秒退后改走包上下文 wrapper，而不是空等注入预算耗尽。
                            let verdict = verify_packaged_activation(
                                process_id,
                                process.as_ref(),
                                debug_port,
                            )
                            .await;
                            if verdict
                                == crate::packaged_launch::AumidActivationVerdict::FallbackToPackageContext
                            {
                                let _ = crate::diagnostic_log::append_diagnostic_log(
                                    "launcher.packaged_activation_exited_early",
                                    serde_json::json!({
                                        "app_user_model_id": app_user_model_id,
                                        "activation_pid": process_id,
                                        "debug_port": debug_port,
                                    }),
                                );
                                launch_packaged_main_in_package_context(
                                    app_dir,
                                    app_user_model_id,
                                    debug_port,
                                    &launch_extra_args,
                                )
                                .await?;
                                *self.packaged_executable.lock().await = Some(executable);
                                *self.packaged_activation_process.lock().await = None;
                                *self.packaged_launch_identity.lock().await = None;
                                // 包上下文里拉起的是 cmd.exe，拿不到应用进程 PID；
                                // 退出等待按调试端口归属去发现实际进程。
                                return Ok(CodexLaunch::PackagedActivation {
                                    app_user_model_id: app_user_model_id.clone(),
                                    arguments: arguments.clone(),
                                    process_id: None,
                                });
                            }
                            *self.packaged_executable.lock().await = Some(executable);
                            *self.packaged_activation_process.lock().await = process;
                            *self.packaged_launch_identity.lock().await = None;
                        }
                        // 不改写打包版 Codex 窗口的 AppUserModelID：保留包身份，任务栏才能
                        // 解析官方图标并与原应用合并分组（#2499、#2668）。
                        return Ok(match activation {
                            CodexLaunch::PackagedActivation {
                                app_user_model_id,
                                arguments,
                                ..
                            } => CodexLaunch::PackagedActivation {
                                app_user_model_id,
                                arguments,
                                process_id: Some(process_id),
                            },
                            CodexLaunch::Process { .. } => unreachable!(),
                        });
                    }
                    Err(error) => {
                        // AUMID 激活失败（例如清单 Application Id 变化）时回退到
                        // 直接执行应用，避免整份配置无法启动。
                        let _ = crate::diagnostic_log::append_diagnostic_log(
                            "launcher.packaged_activation_fallback",
                            serde_json::json!({
                                "app_user_model_id": app_user_model_id,
                                "app_dir": app_dir,
                                "error": error.to_string()
                            }),
                        );
                        // 激活调用超时（#2795）：按路径启动同样拿不到包身份，回退没有意义，
                        // 直接给出可操作的提示。
                        if error
                            .downcast_ref::<crate::packaged_launch::AumidActivationTimedOut>()
                            .is_some()
                        {
                            let executable = crate::app_paths::build_codex_executable(app_dir);
                            let executable_name = executable
                                .file_name()
                                .map(|name| name.to_string_lossy().into_owned())
                                .unwrap_or_else(|| "Codex".to_string());
                            anyhow::bail!(
                                crate::packaged_launch::aumid_activation_timed_out_message(
                                    crate::packaged_launch::AUMID_ACTIVATION_CALL_TIMEOUT.as_secs(),
                                    &executable_name,
                                )
                            );
                        }
                        // 提权进程激活打包应用必然失败，按路径启动的进程会因缺少
                        // 包身份立即退出、注入也必然失败；此时必须如实失败并给出
                        // 指引，而不是静默回退导致 latest-status.json 误报 running
                        // （issue #2351）。
                        if let Some(reason) = packaged_activation_fallback_block_reason(
                            crate::windows_integration::current_process_is_elevated(),
                        ) {
                            anyhow::bail!("{reason}（激活错误：{error}）");
                        }
                    }
                }
            }
        }

        if app_dir.extension().and_then(|value| value.to_str()) == Some("app") {
            let launch_action = select_macos_debug_launch_action(
                is_macos_app_running(app_dir).await,
                crate::cdp::endpoint_available(debug_port),
            );
            let cleanup_policy = match launch_action {
                MacosDebugLaunchAction::LaunchNew => MacosCleanupPolicy::QuitIfNotPreviouslyRunning,
                MacosDebugLaunchAction::ReuseRunningDebugApp => {
                    MacosCleanupPolicy::SkipQuitBecauseAlreadyRunning
                }
                MacosDebugLaunchAction::RestartRunningApp => {
                    let _ = crate::diagnostic_log::append_diagnostic_log(
                        "launcher.macos_existing_app_without_cdp_restart_requested",
                        serde_json::json!({
                            "app_dir": app_dir,
                            "debug_port": debug_port
                        }),
                    );
                    quit_macos_app_and_wait(app_dir).await?;
                    MacosCleanupPolicy::QuitIfNotPreviouslyRunning
                }
            };
            let command = build_macos_open_command(app_dir, debug_port, &launch_extra_args);
            let executable = command
                .first()
                .ok_or_else(|| anyhow::anyhow!("macOS open command is empty"))?;
            let child = Command::new(executable)
                .args(&command[1..])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .context("failed to launch macOS Codex app")?;
            *self.child.lock().await = Some(child);
            return Ok(CodexLaunch::Process {
                command,
                wait_strategy: ProcessWaitStrategy::ExternalWaitCommand,
                macos_cleanup_policy: Some(cleanup_policy),
            });
        }

        let command = build_codex_command(app_dir, debug_port, &launch_extra_args);
        let executable = command
            .first()
            .ok_or_else(|| anyhow::anyhow!("Codex command is empty"))?;
        let mut child_command = Command::new(executable);
        child_command
            .args(&command[1..])
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        // 本地构建与测试使用的状态目录显式传给子进程。
        if let Some(state_dir) = instance.state_dir.as_deref() {
            child_command.env(crate::paths::STATE_DIR_ENV, state_dir);
        }
        #[cfg(windows)]
        child_command.creation_flags(crate::windows_integration::CREATE_NO_WINDOW);
        let child = child_command
            .spawn()
            .with_context(|| format!("failed to launch Codex executable {executable}"))?;
        *self.child.lock().await = Some(child);
        Ok(CodexLaunch::Process {
            command,
            wait_strategy: ProcessWaitStrategy::TrackedChild,
            macos_cleanup_policy: None,
        })
    }

    async fn inject(&self, debug_port: u16) -> anyhow::Result<()> {
        retry_injection(debug_port).await
    }

    async fn apply_native_module_patches_on_launch(&self, debug_port: u16) -> anyhow::Result<()> {
        apply_native_module_patches_on_launch(debug_port).await
    }

    fn effective_settings(&self, settings: BackendSettings) -> BackendSettings {
        crate::builtin_takeover::mask_settings(settings)
    }

    fn extension_launches(&self) -> Vec<(String, Value, crate::extension_launch::ExtensionLaunch)> {
        crate::user_scripts::default_user_script_manager()
            .enabled_launches()
            .unwrap_or_default()
    }

    async fn reload_for_extension_preloads(&self, debug_port: u16) -> anyhow::Result<()> {
        let (_, reload) = crate::user_scripts::default_user_script_manager().enabled_preloads()?;
        if reload {
            reload_page_for_extension_preloads(debug_port).await?;
        }
        Ok(())
    }

    async fn capture_injected_launch_identity(&self, debug_port: u16) {
        #[cfg(windows)]
        {
            let mut identity = self.packaged_launch_identity.lock().await;
            if identity.is_some() {
                return;
            }
            let Some(executable) = self.packaged_executable.lock().await.clone() else {
                return;
            };
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
            let mut last_discovery_error = None;
            loop {
                let browser_id = validated_codex_browser_id(debug_port).await;
                let mut process = match crate::windows_integration::capture_debug_listener(
                    debug_port,
                    &executable,
                ) {
                    Ok(process) => process,
                    Err(error) => {
                        let message = format!("{error:#}");
                        if last_discovery_error.as_ref() != Some(&message) {
                            let _ = crate::diagnostic_log::append_diagnostic_log(
                                "launcher.packaged_process_identity_unavailable",
                                serde_json::json!({ "debug_port": debug_port, "message": message }),
                            );
                        }
                        last_discovery_error = Some(message);
                        None
                    }
                };
                let activation = self.packaged_activation_process.lock().await;
                let activation_matches = activation.as_ref().zip(process.as_ref()).is_some_and(
                    |(activation, process)| {
                        activation.process_id == process.process_id
                            && activation.birth_id == process.birth_id
                    },
                );
                drop(activation);
                // target 列表、UUID 和 listener 查询之间可能发生替换；只接受稳定的 Codex UUID。
                let browser_still_matches = if let Some(initial) = browser_id.as_deref() {
                    validated_codex_browser_id(debug_port).await.as_deref() == Some(initial)
                } else {
                    false
                };
                if browser_id.is_some() && !activation_matches && !browser_still_matches {
                    process = None;
                }
                let browser_id = browser_id.filter(|_| browser_still_matches);
                // 无 CDP 页时，已验证可执行文件和句柄的 listener 仍可作为本次进程身份。
                if browser_id.is_some() || process.is_some() {
                    let _ = crate::diagnostic_log::append_diagnostic_log(
                        "launcher.packaged_launch_identity_captured",
                        serde_json::json!({
                            "debug_port": debug_port,
                            "browser_identity_bound": browser_id.is_some(),
                            "process_id": process.as_ref().map(|process| process.process_id),
                            "birth_id": process.as_ref().map(|process| process.birth_id),
                        }),
                    );
                    *identity = Some(PackagedLaunchIdentity {
                        browser_id,
                        process,
                    });
                    return;
                }
                if tokio::time::Instant::now() >= deadline {
                    return;
                }
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            }
        }
        #[cfg(not(windows))]
        let _ = debug_port;
    }
    async fn start_bridge_watchdog(&self, debug_port: u16) -> anyhow::Result<()> {
        // 拓展的定时任务跟着托管后台的这个进程走。
        crate::extension_backend::start_scheduler();
        let bridge_reinjector = self.bridge_reinjector.lock().await.clone();
        let (shutdown, mut shutdown_rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let mut observed_browser_id: Option<String> = None;
            let mut bridge_health_failures = 0u8;
            let mut bridge_reinject_backoff = BridgeReinjectBackoff::default();
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(5));
            loop {
                tokio::select! {
                    _ = &mut shutdown_rx => break,
                    _ = interval.tick() => {
                        let current_browser_id = match crate::cdp::browser_identity(debug_port).await {
                            Ok(identity) => identity.browser_id().ok(),
                            Err(_) => None,
                        };
                        let identity_changed = current_browser_id
                            .as_deref()
                            .is_some_and(|current| {
                                browser_identity_changed(observed_browser_id.as_deref(), current)
                            });
                        if let Some(current) = current_browser_id {
                            observed_browser_id = Some(current);
                        }
                        check_and_reinject_bridge_inner(
                            debug_port,
                            identity_changed,
                            bridge_reinjector.clone(),
                            &mut bridge_health_failures,
                            &mut bridge_reinject_backoff,
                        ).await;
                    }
                }
            }
        });
        if let Some(runtime) = self
            .bridge_watchdog
            .lock()
            .await
            .replace(BridgeWatchdogRuntime { shutdown, task })
        {
            let _ = runtime.shutdown.send(());
            let _ = runtime.task.await;
        }
        Ok(())
    }

    async fn write_status(&self, _status: &str) {}

    async fn wait_for_codex_exit(
        &self,
        launch: &CodexLaunch,
        debug_port: u16,
    ) -> anyhow::Result<()> {
        match launch {
            CodexLaunch::Process { .. } => {
                if let Some(mut child) = self.child.lock().await.take() {
                    let _ = child.wait().await;
                }
            }
            CodexLaunch::PackagedActivation { process_id, .. } => {
                #[cfg(windows)]
                {
                    let executable = self
                        .packaged_executable
                        .lock()
                        .await
                        .take()
                        .context("missing packaged Codex executable identity")?;
                    let activation = self.packaged_activation_process.lock().await.take();
                    let identity = self
                        .packaged_launch_identity
                        .lock()
                        .await
                        .take()
                        .unwrap_or_default();
                    return wait_for_windows_packaged_exit(
                        &executable,
                        *process_id,
                        activation,
                        identity,
                        debug_port,
                    )
                    .await;
                }
                #[cfg(not(windows))]
                if let Some(process_id) = process_id {
                    if let Err(error) = wait_for_windows_process_id(*process_id).await {
                        let _ = crate::diagnostic_log::append_diagnostic_log(
                            "launcher.packaged_process_wait_failed_nonfatal",
                            serde_json::json!({
                                "process_id": process_id,
                                "message": format!("{error:#}")
                            }),
                        );
                    }
                }
            }
        }
        // Another Codex process must not keep this launcher holding the native
        // browser monitor. Directly owned processes and this debug port can.
        //
        // 单次探测失败不足以判定退出：macOS 的 `ps` 采样和 `/json` 探测都会在
        // 进程换代/监听重建的空档里瞬断；过早结束会话会停止桥接看门狗。
        // 传入 Some(...) 包一层，是因为该宽限在 Windows 那条路径上把「进程身份
        // 未知」表示为 None，语义是回落到 cdp_available。
        let mut exit_grace = PackagedExitGrace::default();
        loop {
            let target_alive = owned_launcher_target_alive(
                launcher_owned_process_alive(launch, debug_port),
                crate::cdp::endpoint_available(debug_port),
            );
            if !exit_grace.keep_waiting(Some(target_alive), false, std::time::Instant::now()) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
        Ok(())
    }

    async fn stop_bridge_watchdog(&self) {
        if let Some(runtime) = self.bridge_watchdog.lock().await.take() {
            let _ = runtime.shutdown.send(());
            let _ = runtime.task.await;
        }
    }

    async fn terminate_codex(&self, launch: &CodexLaunch) {
        match launch {
            CodexLaunch::Process {
                wait_strategy: ProcessWaitStrategy::ExternalWaitCommand,
                command,
                macos_cleanup_policy,
            } => {
                if let Some(mut child) = self.child.lock().await.take() {
                    let _ = child.kill().await;
                }
                if let (Some(app_dir), Some(cleanup_policy)) = (
                    macos_app_dir_from_open_command(command),
                    *macos_cleanup_policy,
                ) {
                    let _ = run_macos_cleanup_command(&app_dir, cleanup_policy).await;
                }
            }
            CodexLaunch::Process { .. } => {
                if let Some(mut child) = self.child.lock().await.take() {
                    let _ = child.kill().await;
                }
            }
            CodexLaunch::PackagedActivation {
                process_id: Some(process_id),
                ..
            } => {
                let _ = terminate_windows_process_id(*process_id).await;
            }
            CodexLaunch::PackagedActivation {
                process_id: None, ..
            } => {}
        }
    }
}

/// 系统鼠标的逻辑坐标（与 Electron 的 window.screenX/screenY 同一坐标系）。拓展经 `/system/cursor-position` 读，
/// 用来写出与「桌宠跟随鼠标」等价的功能。只支持 Windows 与 macOS。
pub fn cursor_position() -> anyhow::Result<(i32, i32)> {
    logical_cursor_position()
}

fn logical_cursor_position() -> anyhow::Result<(i32, i32)> {
    #[cfg(windows)]
    {
        return windows_logical_cursor_position();
    }
    #[cfg(target_os = "macos")]
    {
        return macos_logical_cursor_position();
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        anyhow::bail!("logical cursor position is only available on Windows and macOS")
    }
}

/// CoreGraphics 全局坐标：主屏左上为原点、Y 向下、单位是点（DIP），
/// 与 Electron 的 window.screenX/screenY 一致。不要用 NSEvent.mouseLocation（左下原点）。
#[cfg(target_os = "macos")]
fn macos_logical_cursor_position() -> anyhow::Result<(i32, i32)> {
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGPoint {
        x: f64,
        y: f64,
    }
    #[link(name = "CoreGraphics", kind = "framework")]
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CGEventCreate(source: *const std::ffi::c_void) -> *mut std::ffi::c_void;
        fn CGEventGetLocation(event: *mut std::ffi::c_void) -> CGPoint;
        fn CFRelease(cf: *mut std::ffi::c_void);
    }
    unsafe {
        let event = CGEventCreate(std::ptr::null());
        if event.is_null() {
            anyhow::bail!("CGEventCreate failed");
        }
        let point = CGEventGetLocation(event);
        CFRelease(event);
        Ok((point.x.round() as i32, point.y.round() as i32))
    }
}

#[cfg(all(test, target_os = "macos"))]
#[test]
fn macos_logical_cursor_position_uses_points_from_core_graphics() {
    let (x, y) = macos_logical_cursor_position().expect("CGEventGetLocation should succeed");
    let _ = (x, y);
}

#[cfg(windows)]
fn windows_logical_cursor_position() -> anyhow::Result<(i32, i32)> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::HiDpi::{
        DPI_AWARENESS_CONTEXT_UNAWARE_GDISCALED, SetThreadDpiAwarenessContext,
    };
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

    let previous = unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_UNAWARE_GDISCALED) };
    if previous.0.is_null() {
        anyhow::bail!("SetThreadDpiAwarenessContext failed");
    }
    let mut point = POINT::default();
    let result = unsafe { GetCursorPos(&mut point) };
    unsafe {
        SetThreadDpiAwarenessContext(previous);
    }
    result.ok().context("GetCursorPos failed")?;
    Ok((point.x, point.y))
}

fn normalize_launch_args(args: &[String]) -> Vec<String> {
    args.iter()
        .map(|arg| arg.trim())
        .filter(|arg| !arg.is_empty())
        .map(ToString::to_string)
        .collect()
}

pub fn build_codex_arguments(debug_port: u16, extra_args: &[String]) -> Vec<String> {
    let mut args = vec![
        format!("--remote-debugging-port={debug_port}"),
        format!("--remote-allow-origins=http://127.0.0.1:{debug_port}"),
    ];
    args.extend(normalize_launch_args(extra_args));
    args
}

pub fn build_codex_command(app_dir: &Path, debug_port: u16, extra_args: &[String]) -> Vec<String> {
    let mut command = vec![
        crate::app_paths::build_codex_executable(app_dir)
            .to_string_lossy()
            .to_string(),
    ];
    command.extend(build_codex_arguments(debug_port, extra_args));
    command
}

/// 用已解析好的 AUMID 拼出打包激活命令。
///
/// AUMID 的解析（含「包是否已注册」这一查询，#2140）留在调用点，这里只做纯拼接。
/// 早先本函数直接吃 `app_dir` 并自行解析，导致它在 Windows 上依赖 Store 注册表状态、
/// 无法被测试驱动——测试机上的临时目录永远不算已注册，断言只能拿到 None。
pub fn build_packaged_activation(
    app_user_model_id: &str,
    debug_port: u16,
    extra_args: &[String],
) -> CodexLaunch {
    CodexLaunch::PackagedActivation {
        app_user_model_id: app_user_model_id.to_string(),
        arguments: command_line_arguments(&build_codex_arguments(debug_port, extra_args)),
        process_id: None,
    }
}

/// 包上下文兜底启动后等待调试端口就绪的上限。超过即报错，不再进入 90 秒注入预算。
#[cfg(windows)]
const PACKAGED_CONTEXT_READY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// AUMID 激活后的观察：直到调试端口就绪、确认激活进程秒退、或验证窗口耗尽（issue #2700）。
///
/// 判定逻辑在 `packaged_launch::AumidActivationWatch`（纯函数，有单测）；这里只负责采样。
#[cfg(windows)]
async fn verify_packaged_activation(
    process_id: u32,
    process: Option<&crate::windows_integration::TrackedWindowsProcess>,
    debug_port: u16,
) -> crate::packaged_launch::AumidActivationVerdict {
    use crate::packaged_launch::{AumidActivationVerdict, AumidActivationWatch};
    let mut watch = AumidActivationWatch::new(std::time::Instant::now());
    loop {
        let cdp_ready =
            tokio::task::spawn_blocking(move || crate::cdp::endpoint_available(debug_port))
                .await
                .unwrap_or(false);
        let process_alive = match process {
            Some(process) => process.is_alive().ok(),
            // 激活后进程秒退时 OpenProcess 往往已经失败，拿不到句柄；
            // 退回按进程快照判断该 PID 是否还在。
            None => tokio::task::spawn_blocking(move || {
                crate::windows_integration::enumerate_processes()
                    .iter()
                    .any(|info| info.process_id == process_id)
            })
            .await
            .ok(),
        };
        let verdict = watch.observe(std::time::Instant::now(), cdp_ready, process_alive);
        if verdict != AumidActivationVerdict::Pending {
            return verdict;
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
}

/// 宿主已经等过端口时，`wait_for_instance_ready` 至少再等这么久（判 CDP 页面是否就绪）。
#[cfg(windows)]
const PACKAGED_CONTEXT_READY_MIN_WAIT: std::time::Duration = std::time::Duration::from_secs(5);

/// 与 Codex 主程序同名的进程 PID（仅诊断用：判断 Codex 是「没起来 / 起来又退了」
/// 还是「活着但没开调试端口」，以及回退前 AUMID 激活是否有残留进程）。
#[cfg(windows)]
fn codex_process_ids_for_diagnostics(executable: &Path) -> Vec<u32> {
    let Some(file_name) = executable.file_name().map(|name| name.to_string_lossy()) else {
        return Vec::new();
    };
    crate::windows_integration::enumerate_processes()
        .into_iter()
        .filter(|info| info.exe_file.eq_ignore_ascii_case(&file_name))
        .map(|info| info.process_id)
        .collect()
}

/// 找出会挡住本次带调试端口启动的主 Codex 进程（issue #2764）。
///
/// 只有「调试端口当前没有 Codex 在应答」且「确有没带本次端口的主进程」时才返回非空；
/// 归类逻辑见 `packaged_launch::main_instances_blocking_debug_launch`（纯函数，有单测）。
#[cfg(windows)]
async fn existing_main_instances_blocking_debug_launch(
    executable: &Path,
    debug_port: u16,
    launch_args: &[String],
) -> Vec<u32> {
    let executable = executable.to_path_buf();
    let launch_args = launch_args.to_vec();
    tokio::task::spawn_blocking(move || {
        let candidates = same_package_codex_process_ids(
            &crate::windows_integration::enumerate_processes(),
            &executable,
        );
        if candidates.is_empty() {
            return Vec::new();
        }
        let blocking = crate::packaged_launch::main_instances_blocking_debug_launch(
            candidates,
            debug_port,
            &launch_args,
            crate::windows_integration::process_command_line,
        );
        // 端口上已经有 Codex 在应答时交给原有流程（激活会复用它），不拦。
        if blocking.is_empty() || crate::cdp::endpoint_available(debug_port) {
            return Vec::new();
        }
        blocking
    })
    .await
    .unwrap_or_default()
}

/// 快照里与 `executable` 同名、且属于同一 MSIX 包族的进程 PID。
///
/// 只认同一包族：另装的 ChatGPT 桌面版也叫 ChatGPT.exe，单实例锁互不相干。
#[cfg(windows)]
fn same_package_codex_process_ids(
    processes: &[crate::windows_integration::WindowsProcessInfo],
    executable: &Path,
) -> Vec<u32> {
    let Some(file_name) = executable.file_name().map(|name| name.to_string_lossy()) else {
        return Vec::new();
    };
    let executable_text = executable.to_string_lossy();
    processes
        .iter()
        .filter(|info| info.exe_file.eq_ignore_ascii_case(&file_name))
        .filter(|info| {
            info.executable_path.as_deref().is_some_and(|path| {
                crate::packaged_launch::same_windows_apps_package_family(
                    &path.to_string_lossy(),
                    &executable_text,
                )
            })
        })
        .map(|info| info.process_id)
        .collect()
}

/// 向挡路主进程发 `WM_CLOSE` 后，等它自己退出的宽限期。
///
/// Codex 关窗口可能只是缩到托盘，此时等满宽限期再强制结束；没有可见窗口（只在托盘）时
/// 投递不成功，直接跳过等待。
#[cfg(windows)]
const BLOCKING_MAIN_INSTANCE_GRACEFUL_TIMEOUT_MS: u64 = 5_000;

/// 强制结束挡路主进程后等它退出的上限。`TerminateProcess` 是立即终止，正常一两秒内就退完。
#[cfg(windows)]
const BLOCKING_MAIN_INSTANCE_STOP_TIMEOUT_MS: u64 = 10_000;

/// 主进程退出后，等同包残留进程（Electron 子进程、包内 codex.exe）自行退出的时间。
#[cfg(windows)]
const BLOCKING_MAIN_INSTANCE_LEFTOVER_TIMEOUT_MS: u64 = 2_000;

/// 「重启 Codex」路径：结束挡住本次带调试端口启动的主 Codex（issue #2764 后续）。
///
/// 只结束 [`existing_main_instances_blocking_debug_launch`] 认定的主进程本身，**不按进程树**：
/// 从 Codex 里打开的 VS Code、浏览器、Agent 起的 dev server 都挂在它的树下，不能一起杀。
/// 动手前用新快照再核对一遍（期间进程可能已退出、PID 被复用），然后：
///
/// 1. 先发 `WM_CLOSE`（与自动接管的优雅退出同一做法），给 Codex 落盘的机会，等宽限期；
/// 2. 仍未退出的再 `TerminateProcess`，只结束主进程，Electron 子进程会随它退出；
/// 3. 主进程退出后若还有残留，只清理 `packaged_launch::blocking_main_instance_leftovers`
///    认定的同一 MSIX 包内的 Codex 进程（`ChatGPT.exe` 子进程 / 包内 `codex.exe`）。
#[cfg(windows)]
async fn stop_main_instances_blocking_debug_launch(
    executable: &Path,
    debug_port: u16,
    launch_args: &[String],
    targets: Vec<u32>,
) -> anyhow::Result<()> {
    let executable = executable.to_path_buf();
    let launch_args = launch_args.to_vec();
    tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        use crate::windows_integration::{process_birth_id, terminate_process};

        let processes = crate::windows_integration::enumerate_processes();
        let still_blocking = crate::packaged_launch::main_instances_blocking_debug_launch(
            same_package_codex_process_ids(&processes, &executable),
            debug_port,
            &launch_args,
            crate::windows_integration::process_command_line,
        );
        let self_process_id = std::process::id();
        let targets = targets
            .into_iter()
            .filter(|process_id| *process_id != self_process_id)
            .filter(|process_id| still_blocking.contains(process_id))
            .collect::<Vec<_>>();
        let target_births = targets
            .iter()
            .map(|process_id| (*process_id, process_birth_id(*process_id)))
            .collect::<Vec<_>>();
        // 残留候选要在主进程退出前记下：Windows 不会给孤儿进程改父 PID，但主进程退出后
        // 它的创建时间就读不到了，父子边无法再证实。
        let executable_text = executable.to_string_lossy().into_owned();
        let by_id = processes
            .iter()
            .map(|info| (info.process_id, info))
            .collect::<std::collections::HashMap<_, _>>();
        let edges = processes
            .iter()
            .map(|info| (info.process_id, info.parent_process_id))
            .collect::<Vec<_>>();
        let may_clean = |process_id: u32| -> bool {
            if process_id == self_process_id {
                return false;
            }
            let Some(info) = by_id.get(&process_id) else {
                return false;
            };
            let executable_path = info
                .executable_path
                .as_deref()
                .map(|path| path.to_string_lossy().into_owned());
            crate::packaged_launch::may_clean_up_after_blocking_main_instance(
                &info.exe_file,
                executable_path.as_deref(),
                crate::windows_integration::process_command_line(process_id).as_deref(),
                &executable_text,
            )
        };
        let mut leftover_ids = Vec::new();
        for process_id in &targets {
            leftover_ids.extend(crate::packaged_launch::blocking_main_instance_leftovers(
                *process_id,
                &edges,
                process_birth_id,
                &may_clean,
            ));
        }
        leftover_ids.sort_unstable();
        leftover_ids.dedup();
        leftover_ids.retain(|process_id| !targets.contains(process_id));
        let leftover_births = leftover_ids
            .iter()
            .map(|process_id| (*process_id, process_birth_id(*process_id)))
            .collect::<Vec<_>>();
        let _ = crate::diagnostic_log::append_diagnostic_log(
            "launcher.packaged_existing_main_instance_stopping",
            serde_json::json!({
                "debug_port": debug_port,
                "process_ids": targets,
                "leftover_candidates": leftover_ids,
            }),
        );

        // 1. 优雅退出：WM_CLOSE，等宽限期。
        let close_requested = targets
            .iter()
            .copied()
            .filter(|process_id| crate::windows_integration::request_process_close(*process_id))
            .collect::<Vec<_>>();
        if !close_requested.is_empty() {
            let _ = crate::watcher::wait_for_processes_to_exit(
                &close_requested,
                BLOCKING_MAIN_INSTANCE_GRACEFUL_TIMEOUT_MS,
                crate::watcher::RESTART_STOP_WAIT_INTERVAL_MS,
            );
        }

        // 2. 仍在运行（且确认还是同一个进程）的主进程：只结束它本身，不连树。
        let running = crate::watcher::process_ids_still_running(
            &targets,
            crate::windows_integration::enumerate_processes()
                .into_iter()
                .map(|process| process.process_id),
        );
        let to_force = crate::packaged_launch::processes_still_to_force_stop(
            &target_births
                .iter()
                .copied()
                .filter(|(process_id, _)| running.contains(process_id))
                .collect::<Vec<_>>(),
            process_birth_id,
        );
        let forced = to_force
            .iter()
            .map(|process_id| {
                serde_json::json!({
                    "pid": process_id,
                    "accepted": terminate_process(*process_id),
                })
            })
            .collect::<Vec<_>>();
        let remaining = crate::watcher::wait_for_processes_to_exit(
            &to_force,
            BLOCKING_MAIN_INSTANCE_STOP_TIMEOUT_MS,
            crate::watcher::RESTART_STOP_WAIT_INTERVAL_MS,
        );

        // 3. 主进程都退了：同包残留先等它们自己退，仍在的（同一进程）逐个结束，不连树。
        let mut cleaned = Vec::new();
        if remaining.is_empty() && !leftover_ids.is_empty() {
            let still_running = crate::watcher::wait_for_processes_to_exit(
                &leftover_ids,
                BLOCKING_MAIN_INSTANCE_LEFTOVER_TIMEOUT_MS,
                crate::watcher::RESTART_STOP_WAIT_INTERVAL_MS,
            );
            let recorded = leftover_births
                .iter()
                .copied()
                .filter(|(process_id, _)| still_running.contains(process_id))
                .collect::<Vec<_>>();
            for process_id in
                crate::packaged_launch::processes_still_to_force_stop(&recorded, process_birth_id)
            {
                cleaned.push(serde_json::json!({
                    "pid": process_id,
                    "accepted": terminate_process(process_id),
                }));
            }
        }
        let _ = crate::diagnostic_log::append_diagnostic_log(
            "launcher.packaged_existing_main_instance_stopped",
            serde_json::json!({
                "debug_port": debug_port,
                "process_ids": targets,
                "close_requested": close_requested,
                "forced": forced,
                "leftovers_cleaned": cleaned,
                "remaining_process_ids": remaining,
                "exited": remaining.is_empty(),
            }),
        );
        if !remaining.is_empty() {
            let ids = remaining
                .iter()
                .map(u32::to_string)
                .collect::<Vec<_>>()
                .join(", ");
            anyhow::bail!(
                "已尝试结束没有开启调试端口 {debug_port} 的 Codex 主进程，但 PID {ids} 在 {} 秒内\
                 仍未退出。请在任务管理器里结束所有 Codex 进程后再点「重启 Codex」。",
                BLOCKING_MAIN_INSTANCE_STOP_TIMEOUT_MS / 1000
            );
        }
        Ok(())
    })
    .await
    .map_err(|error| anyhow::anyhow!("结束已运行的 Codex 主进程时后台任务失败：{error}"))?
}

/// 主实例的包上下文兜底启动（issue #2700）：AUMID 激活后进程秒退时，改用
/// `Invoke-CommandInDesktopPackage` wrapper 带同一份参数拉起 exe，并等待调试端口就绪。
///
/// issue #2764：同一份 wrapper 在用户的交互式 PowerShell 里能拉起 Codex，从 Codex Pilot 里却
/// 不行。对照差异做了三处收敛：PowerShell 宿主激活后继续存活到端口可连（不再立刻退出）、
/// 去掉会经 powershell → cmd 继承给 Codex 的 Electron/Node 运行时开关、按系统路径调用
/// powershell.exe；并把激活的退出码、输出、命令形状与前后的 Codex 进程写进诊断日志。
///
/// 任一步失败都直接返回 Err，让用户立即看到错误，而不是空等注入预算耗尽。
#[cfg(windows)]
async fn launch_packaged_main_in_package_context(
    app_dir: &Path,
    app_user_model_id: &str,
    debug_port: u16,
    extra_args: &[String],
) -> anyhow::Result<()> {
    let executable = crate::app_paths::build_codex_executable(app_dir);
    let arguments = build_codex_arguments(debug_port, extra_args);
    let wrapper_path = crate::packaged_launch::prepare_main_instance_wrapper(
        &crate::paths::default_app_state_dir(),
        &executable,
        &arguments,
    )?;
    // 只记变量名，不记值。
    let scrubbed_env =
        crate::packaged_launch::present_scrubbed_env_vars(|name| std::env::var_os(name).is_some());
    let elevated = crate::windows_integration::current_process_is_elevated();
    let codex_pids_before = codex_process_ids_for_diagnostics(&executable);
    // 宿主等端口期间顺带观察同名进程：区分「Codex 根本没起来」与「起来后又退了」。
    let watch_process = executable
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned());
    // wrapper 轨迹只认这之后写下的，避免把上一次的当成这次执行过。
    let activation_started_at = std::time::SystemTime::now();
    let activation = match crate::packaged_launch::activate_in_package_context_with_report(
        app_user_model_id,
        &wrapper_path,
        Some(debug_port),
        watch_process.as_deref(),
    )
    .await
    {
        Ok(activation) => activation,
        Err(error) => {
            let _ = crate::diagnostic_log::append_diagnostic_log(
                "launcher.packaged_context_main_launch",
                serde_json::json!({
                    "app_user_model_id": app_user_model_id,
                    "wrapper_path": wrapper_path,
                    "debug_port": debug_port,
                    "ready": false,
                    "error": format!("{error:#}"),
                    "elevated": elevated,
                    "scrubbed_env": scrubbed_env,
                    "codex_pids_before": codex_pids_before,
                    "wrapper_trace": crate::packaged_launch::read_main_wrapper_trace(
                        &wrapper_path,
                        activation_started_at,
                    ),
                }),
            );
            // 带上完整错误链：issue #2747 只看到外层一句话，根因被吞掉了。
            anyhow::bail!("Codex 通过 AUMID 激活后立即退出，改用包上下文启动也失败：{error:#}");
        }
    };
    // 宿主已经等过端口时只补一段短等待，总时长与原先的 30 秒上限保持一致。
    let ready_timeout = PACKAGED_CONTEXT_READY_TIMEOUT
        .saturating_sub(std::time::Duration::from_millis(activation.elapsed_ms))
        .max(PACKAGED_CONTEXT_READY_MIN_WAIT);
    let ready = tokio::task::spawn_blocking(move || {
        crate::packaged_launch::wait_for_instance_ready(debug_port, ready_timeout)
    })
    .await
    .unwrap_or(false);
    let codex_pids_after = codex_process_ids_for_diagnostics(&executable);
    // 宿主观察期间新出现过的进程（不在回退前的快照里）。
    let codex_pids_new_in_host = activation.seen_process_ids.as_ref().map(|seen| {
        seen.iter()
            .copied()
            .filter(|id| !codex_pids_before.contains(id))
            .collect::<Vec<_>>()
    });
    let wrapper_trace =
        crate::packaged_launch::read_main_wrapper_trace(&wrapper_path, activation_started_at);
    let _ = crate::diagnostic_log::append_diagnostic_log(
        "launcher.packaged_context_main_launch",
        serde_json::json!({
            "app_user_model_id": app_user_model_id,
            "wrapper_path": wrapper_path,
            "debug_port": debug_port,
            "ready": ready,
            "cmd_pid": (activation.process_id != crate::packaged_launch::UNKNOWN_PROCESS_ID)
                .then_some(activation.process_id),
            "port_ready_in_host": activation.port_ready_in_host,
            "host": activation.host,
            "exit_code": activation.exit_code,
            "activation_elapsed_ms": activation.elapsed_ms,
            "activation_output": activation.output,
            "command": activation.command,
            "elevated": elevated,
            "scrubbed_env": scrubbed_env,
            "codex_pids_before": codex_pids_before,
            "codex_pids_after": codex_pids_after,
            "codex_pids_seen_in_host": activation.seen_process_ids,
            "codex_pids_new_in_host": codex_pids_new_in_host,
            "wrapper_trace": wrapper_trace,
        }),
    );
    if !ready {
        anyhow::bail!(
            "Codex 通过 AUMID 激活后立即退出，改用包上下文启动后 {} 秒内调试端口 {debug_port} 仍未就绪\
             （宿主内端口{}，{}，当前 Codex 进程 {} 个；详见 codex-plus.log 的 launcher.packaged_context_main_launch）",
            PACKAGED_CONTEXT_READY_TIMEOUT.as_secs(),
            match activation.port_ready_in_host {
                Some(true) => "曾可连接",
                Some(false) => "始终不可连接",
                None => "状态未知",
            },
            crate::packaged_launch::package_context_launch_observation(
                codex_pids_new_in_host.as_deref(),
                wrapper_trace.is_some(),
            ),
            codex_pids_after.len()
        );
    }
    Ok(())
}

fn codex_plus_default_codex_home() -> PathBuf {
    crate::codex_home::default_codex_home_dir()
}

async fn retry_injection(debug_port: u16) -> anyhow::Result<()> {
    let mut last_error = None;
    for _ in 0..20 {
        match try_inject(debug_port).await {
            Ok(()) => return Ok(()),
            Err(error) => {
                last_error = Some(error);
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            }
        }
    }
    Err(last_error.unwrap_or_else(|| anyhow::anyhow!("Codex injection failed")))
}

pub async fn check_and_reinject_bridge(debug_port: u16) -> bool {
    // This one-shot entry point preserves its historical immediate-repair behavior.
    let mut health_failures = BRIDGE_HEALTH_FAILURE_THRESHOLD.saturating_sub(1);
    let mut backoff = BridgeReinjectBackoff::default();
    check_and_reinject_bridge_inner(debug_port, false, None, &mut health_failures, &mut backoff)
        .await
}

pub fn browser_identity_changed(previous: Option<&str>, current: &str) -> bool {
    previous.is_some_and(|previous| previous != current)
}

fn owned_launcher_target_alive(owned_process_alive: bool, debug_port_open: bool) -> bool {
    owned_process_alive || debug_port_open
}

#[cfg(any(windows, test))]
async fn validated_codex_browser_id(debug_port: u16) -> Option<String> {
    let targets = crate::cdp::list_targets(debug_port).await.ok()?;
    crate::cdp::pick_injectable_codex_page_target(&targets).ok()?;
    crate::cdp::browser_identity(debug_port)
        .await
        .ok()?
        .browser_id()
        .ok()
}

/// 目标「探不到」时的宽限：连续不足 3 次探测失败、或距首次失败不足 10 秒，
/// 都仍继续等待。
///
/// Windows 打包版的中转进程和 macOS 的监听重建都可能让单次探测闪断。
/// 只有持续找不到目标才结束会话，避免误停仍在使用的 CDP 桥接与看门狗。
///
/// 「同端口的新实例不能为旧 launcher 续命」这条约束仍然成立：宽限是有限次的，
/// 真退出只是晚约 10 秒被发现。
#[derive(Default)]
struct PackagedExitGrace {
    missing_since: Option<std::time::Instant>,
    missed_probes: u32,
}

impl PackagedExitGrace {
    fn keep_waiting(
        &mut self,
        process_alive: Option<bool>,
        cdp_available: bool,
        now: std::time::Instant,
    ) -> bool {
        // 已捕获进程退出后，同端口的新实例不能为旧 launcher 续命。
        if process_alive.unwrap_or(cdp_available) {
            self.missing_since = None;
            self.missed_probes = 0;
            return true;
        }
        self.missed_probes = self.missed_probes.saturating_add(1);
        let since = *self.missing_since.get_or_insert(now);
        self.missed_probes < 3
            || now.saturating_duration_since(since) < std::time::Duration::from_secs(10)
    }
}

#[cfg(any(windows, test))]
fn activation_process_is_startup_evidence(alive: bool, elapsed: std::time::Duration) -> bool {
    // AUMID 有时返回仍存活的中转进程；它只能给实际调试进程有限的出现时间。
    alive && elapsed < std::time::Duration::from_secs(30)
}

#[cfg(any(windows, test))]
struct PackagedBrowserBinding {
    initial_id: Option<String>,
    replaced: bool,
}

#[cfg(any(windows, test))]
impl PackagedBrowserBinding {
    fn owns(&mut self, current_id: Option<&str>) -> bool {
        if self.replaced {
            return false;
        }
        match (self.initial_id.as_deref(), current_id) {
            (Some(initial), Some(current)) if initial == current => true,
            (Some(_), Some(_)) => {
                self.replaced = true;
                false
            }
            _ => false,
        }
    }
}

#[cfg(windows)]
async fn wait_for_windows_packaged_exit(
    executable: &Path,
    activation_pid: Option<u32>,
    activation: Option<crate::windows_integration::TrackedWindowsProcess>,
    identity: PackagedLaunchIdentity,
    debug_port: u16,
) -> anyhow::Result<()> {
    use crate::windows_integration::{TrackedWindowsProcess, capture_debug_listener};
    let mut tracked = identity.process;
    let mut browser = PackagedBrowserBinding {
        initial_id: identity.browser_id,
        replaced: false,
    };
    let mut grace = PackagedExitGrace::default();
    let mut last_discovery_error: Option<String> = None;
    let started_waiting = std::time::Instant::now();
    loop {
        let mut owned_browser = false;
        if tracked.is_none() {
            let current_browser_id = if browser.initial_id.is_some() && !browser.replaced {
                crate::cdp::browser_identity(debug_port)
                    .await
                    .ok()
                    .and_then(|identity| identity.browser_id().ok())
            } else {
                None
            };
            owned_browser = browser.owns(current_browser_id.as_deref());
            let discovery = if browser.replaced {
                Ok(None)
            } else {
                capture_debug_listener(debug_port, executable).map(|process| {
                    process.filter(|process| {
                        // 重新查询只能沿用初始 browser，或启动时已持有的同一个内核进程。
                        owned_browser
                            || activation.as_ref().is_some_and(|activation| {
                                activation.process_id == process.process_id
                                    && activation.birth_id == process.birth_id
                            })
                    })
                })
            };
            let discovery = match discovery {
                Ok(Some(process)) => {
                    let activation_matches = activation.as_ref().is_some_and(|activation| {
                        activation.process_id == process.process_id
                            && activation.birth_id == process.birth_id
                    });
                    if !activation_matches {
                        let confirmation = crate::cdp::browser_identity(debug_port)
                            .await
                            .ok()
                            .and_then(|identity| identity.browser_id().ok());
                        owned_browser = browser.owns(confirmation.as_deref());
                    }
                    Ok((activation_matches || owned_browser).then_some(process))
                }
                other => other,
            };
            match discovery {
                Ok(Some(process)) => {
                    let _ = crate::diagnostic_log::append_diagnostic_log(
                        "launcher.packaged_process_tracked",
                        serde_json::json!({ "debug_port": debug_port, "process_id": process.process_id, "birth_id": process.birth_id, "activation_pid": activation_pid }),
                    );
                    tracked = Some(process);
                }
                Ok(None) => {}
                Err(error) => {
                    let message = format!("{error:#}");
                    if last_discovery_error.as_deref() != Some(&message) {
                        let _ = crate::diagnostic_log::append_diagnostic_log(
                            "launcher.packaged_process_identity_unavailable",
                            serde_json::json!({ "debug_port": debug_port, "message": message }),
                        );
                    }
                    last_discovery_error = Some(message);
                }
            }
        }
        let process_alive = if let Some(process) = &tracked {
            Some(process.is_alive()?)
        } else if browser.replaced {
            Some(false)
        } else {
            // AUMID PID 只作等待实际 listener 出现期间的退路，不能替换已捕获主进程。
            activation
                .as_ref()
                .map(TrackedWindowsProcess::is_alive)
                .transpose()?
                .filter(|alive| {
                    activation_process_is_startup_evidence(*alive, started_waiting.elapsed())
                })
        };
        if !grace.keep_waiting(process_alive, owned_browser, std::time::Instant::now()) {
            let _ = crate::diagnostic_log::append_diagnostic_log(
                "launcher.packaged_target_exited",
                serde_json::json!({
                    "debug_port": debug_port,
                    "activation_pid": activation_pid,
                    "process_id": tracked.as_ref().map(|process| process.process_id),
                    "process_alive": process_alive,
                    "owned_browser_available": owned_browser,
                    "browser_identity_bound": browser.initial_id.is_some(),
                    "browser_replaced": browser.replaced,
                    "missed_probes": grace.missed_probes,
                    "grace_ms": 10000,
                    "identity_error": last_discovery_error,
                    "activation_grace_ms": 30000,
                }),
            );
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
}

/// macOS `open` is not the app's parent, so its tracked child exits immediately.
/// Match the exact debug port in the app process command line instead.
#[cfg(target_os = "macos")]
fn launcher_owned_process_alive(launch: &CodexLaunch, debug_port: u16) -> bool {
    matches!(
        launch,
        CodexLaunch::Process {
            wait_strategy: ProcessWaitStrategy::ExternalWaitCommand,
            ..
        }
    ) && !crate::watcher::find_macos_codex_processes_for_debug_port(debug_port).is_empty()
}

#[cfg(target_os = "linux")]
fn launcher_owned_process_alive(launch: &CodexLaunch, debug_port: u16) -> bool {
    matches!(
        launch,
        CodexLaunch::Process {
            wait_strategy: ProcessWaitStrategy::ExternalWaitCommand,
            ..
        }
    ) && !crate::watcher::find_codex_processes_for_debug_port(debug_port).is_empty()
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn launcher_owned_process_alive(_launch: &CodexLaunch, _debug_port: u16) -> bool {
    false
}

fn should_reinject_after_health_result(
    healthy: Option<bool>,
    browser_identity_changed: bool,
    health_failures: &mut u8,
) -> bool {
    let Some(healthy) = healthy else {
        *health_failures = 0;
        return false;
    };
    if healthy {
        *health_failures = 0;
        return false;
    }
    if browser_identity_changed {
        *health_failures = BRIDGE_HEALTH_FAILURE_THRESHOLD;
    } else {
        *health_failures = health_failures.saturating_add(1);
    }
    *health_failures >= BRIDGE_HEALTH_FAILURE_THRESHOLD
}

async fn check_and_reinject_bridge_inner(
    debug_port: u16,
    browser_identity_changed: bool,
    bridge_reinjector: Option<BridgeReinjector>,
    health_failures: &mut u8,
    backoff: &mut BridgeReinjectBackoff,
) -> bool {
    let healthy = if browser_identity_changed {
        Some(false)
    } else {
        match bridge_health_ok(debug_port).await {
            Ok(healthy) => Some(healthy),
            Err(error) => {
                let _ = crate::diagnostic_log::append_diagnostic_log(
                    "bridge.health_check_failed",
                    serde_json::json!({
                        "debug_port": debug_port,
                        "message": error.to_string()
                    }),
                );
                // A CDP timeout only means that the renderer did not answer
                // this probe in time. The bridge heartbeat is the source of
                // truth for actual availability; do not reinject on an
                // indeterminate CDP result or a busy page will cause churn.
                None
            }
        }
    };
    match healthy {
        // 持续健康一段时间才清掉退避（见 BRIDGE_REINJECT_BACKOFF_RESET_AFTER_SECS）；
        // 探测不确定时不改变退避状态。失效计数由 should_reinject_* 统一管理。
        Some(true) => backoff.observe_healthy(std::time::Instant::now()),
        None => {}
        Some(false) => backoff.observe_unhealthy(),
    }
    if !should_reinject_after_health_result(healthy, browser_identity_changed, health_failures) {
        return false;
    }
    if browser_identity_changed {
        // 应用实例更换：旧退避针对的是旧页面，新页面需要立即注入。
        backoff.reset();
    }
    let now = std::time::Instant::now();
    if !backoff.ready(now) {
        let _ = crate::diagnostic_log::append_diagnostic_log(
            "bridge.reinject_backoff_skipped",
            serde_json::json!({
                "debug_port": debug_port,
                "consecutive_reinjections": backoff.consecutive_attempts,
                "next_reinject_allowed_in_ms": backoff
                    .next_allowed_at
                    .map(|deadline| deadline.saturating_duration_since(now).as_millis() as u64),
            }),
        );
        return false;
    }
    backoff.record_attempt(now);

    let _ = crate::diagnostic_log::append_diagnostic_log(
        "bridge.reinject_start",
        serde_json::json!({
            "debug_port": debug_port,
            "browser_identity_changed": browser_identity_changed,
            "consecutive_health_failures": *health_failures
        }),
    );
    let default_reinjector: BridgeReinjector =
        Arc::new(move || Box::pin(async move { retry_injection(debug_port).await }));
    let reinject_result = run_bridge_reinjector(bridge_reinjector, default_reinjector).await;
    match reinject_result {
        Ok(()) => {
            let _ = crate::diagnostic_log::append_diagnostic_log(
                "bridge.reinject_ok",
                serde_json::json!({
                    "debug_port": debug_port,
                }),
            );
            *health_failures = 0;
            true
        }
        Err(error) => {
            let _ = crate::diagnostic_log::append_diagnostic_log(
                "bridge.reinject_failed",
                serde_json::json!({
                    "debug_port": debug_port,
                    "message": error.to_string()
                }),
            );
            false
        }
    }
}

async fn run_bridge_reinjector(
    bridge_reinjector: Option<BridgeReinjector>,
    default_reinjector: BridgeReinjector,
) -> anyhow::Result<()> {
    match bridge_reinjector {
        Some(reinject) => reinject().await,
        None => default_reinjector().await,
    }
}

async fn bridge_health_ok(debug_port: u16) -> anyhow::Result<bool> {
    let targets = crate::cdp::list_targets(debug_port).await?;
    let target = crate::cdp::pick_injectable_codex_page_target(&targets)?;
    let websocket_url = target
        .web_socket_debugger_url
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("selected CDP target has no websocket URL"))?;
    let result = crate::bridge::evaluate_script_with_await_promise(
        websocket_url,
        crate::bridge::bridge_health_check_script(),
        true,
    )
    .await?;
    Ok(runtime_evaluate_result_is_true(&result))
}

fn runtime_evaluate_result_is_true(result: &Value) -> bool {
    result
        .get("result")
        .and_then(|result| result.get("result"))
        .and_then(|result| result.get("value"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

async fn try_inject(debug_port: u16) -> anyhow::Result<()> {
    let targets = crate::cdp::list_targets(debug_port).await?;
    let target = crate::cdp::pick_injectable_codex_page_target(&targets)?;
    let websocket_url = target
        .web_socket_debugger_url
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("selected CDP target has no websocket URL"))?;
    let settings =
        crate::builtin_takeover::mask_settings(SettingsStore::default().load().unwrap_or_default());
    let mut scripts = vec![crate::assets::injection_script_with_settings(&settings)];
    // 拓展的页面最早期脚本（codexpp.json 的 `preload`）：增强开着时随新文档脚本一起登记，在 Codex 自己的脚本之前执行。
    if settings.enhancements_enabled
        && let Ok((entries, _)) =
            crate::user_scripts::default_user_script_manager().enabled_preloads()
        && let Some(preload) = crate::extension_launch::preload_document_script(&entries)
    {
        scripts.push(preload);
    }
    let ctx = crate::routes::BridgeContext::core(Arc::new(crate::routes::CoreRuntimeService::new(
        debug_port,
        StatusStore::default(),
    )));
    crate::bridge::install_bridge(
        websocket_url,
        crate::bridge::BRIDGE_BINDING_NAME,
        Arc::new(move |path, payload| {
            let ctx = ctx.clone();
            Box::pin(
                async move { Ok(crate::routes::handle_bridge_request(ctx, &path, payload).await) },
            )
        }),
        &scripts,
    )
    .await
}

/// 拓展的页面最早期脚本要赶在第一份文档的 Codex 脚本之前：启动后整页重载一次，等页面就绪。
async fn reload_page_for_extension_preloads(debug_port: u16) -> anyhow::Result<()> {
    let targets = crate::cdp::list_targets(debug_port).await?;
    let target = crate::cdp::pick_injectable_codex_page_target(&targets)?;
    let websocket_url = target
        .web_socket_debugger_url
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("selected CDP target has no websocket URL"))?;
    crate::bridge::send_cdp_command(websocket_url, "Page.reload", serde_json::json!({})).await?;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
    while tokio::time::Instant::now() < deadline {
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        if let Ok(result) =
            crate::bridge::evaluate_script(websocket_url, "document.readyState").await
            && result
                .pointer("/result/result/value")
                .and_then(Value::as_str)
                == Some("complete")
        {
            let _ = crate::diagnostic_log::append_diagnostic_log(
                "launcher.extension_preload_reloaded",
                serde_json::json!({ "debug_port": debug_port }),
            );
            return Ok(());
        }
    }
    anyhow::bail!("拓展 preload 重载后页面 30 秒内没有就绪")
}

// 仅在用户启动 Codex 的流程里重载一次；心跳重注入不重载正在使用的页面。
async fn apply_native_module_patches_on_launch(debug_port: u16) -> anyhow::Result<()> {
    anyhow::ensure!(debug_port != 0, "Codex 调试端口不能为 0");
    let probe = "JSON.stringify({ready:window.__codexPlusNativeFastAssetPatchReady===true,compiled:window.__codexPlusNativeFastCompiled==='v1',failed:['unsupported','failed'].includes(window.__codexPlusNativeFastPatchState),appReady:!!document.querySelector('[data-app-shell-main-surface]')})";
    // 复用后台服务时，launch_codex 返回不代表新进程的 CDP 或 watchdog 重注入已经就绪。
    // 每轮重新发现主页面，覆盖端口拒连、页面尚未出现和页面换代；准备完成前绝不能提前重载。
    // 补丁块准备完成不代表原生首次启动完成，必须等主界面挂载，避免重载打断初始化握手。
    // 60 秒同时容纳客户端冷启动与最多 30 秒的模块准备，整个等待有界，避免阻塞启动服务。
    let (websocket_url, compiled) =
        tokio::time::timeout(std::time::Duration::from_secs(60), async {
            loop {
                let result = async {
                    let targets = crate::cdp::list_targets(debug_port).await?;
                    let target = crate::cdp::pick_injectable_codex_page_target(&targets)?;
                    let websocket_url =
                        target.web_socket_debugger_url.as_deref().ok_or_else(|| {
                            anyhow::anyhow!("selected CDP target has no websocket URL")
                        })?;
                    let result = crate::bridge::evaluate_script(websocket_url, probe).await?;
                    anyhow::Ok((
                        websocket_url.to_owned(),
                        native_module_launch_state(&result),
                    ))
                }
                .await;
                if let Ok((websocket_url, state)) = result {
                    if state.compiled && state.app_ready {
                        return anyhow::Ok((websocket_url, true));
                    }
                    anyhow::ensure!(!state.failed, "当前 Codex 资产不支持原生模块补丁，保留原生界面");
                    if state.prepared && state.app_ready {
                        return anyhow::Ok((websocket_url, false));
                    }
                }
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            }
        })
        .await
        .context("等待 Codex 主界面和原生模块补丁就绪超时（60 秒），保留原生界面")??;
    if compiled {
        return Ok(());
    }
    crate::bridge::send_cdp_command(
        &websocket_url,
        "Page.reload",
        serde_json::json!({ "ignoreCache": true }),
    )
    .await?;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
    while tokio::time::Instant::now() < deadline {
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        if let Ok(result) = crate::bridge::evaluate_script(&websocket_url, probe).await {
            let state = native_module_launch_state(&result);
            anyhow::ensure!(!state.failed, "当前 Codex 资产不支持原生模块补丁，保留原生界面");
            // 完成标记位于模块工厂注册之后，React 可能仍在 loading；不能据此报告启动成功。
            if state.compiled && state.app_ready {
                let _ = crate::diagnostic_log::append_diagnostic_log(
                    "launcher.native_module_patch_ready",
                    serde_json::json!({ "debug_port": debug_port }),
                );
                return Ok(());
            }
        }
    }
    anyhow::bail!("当前 Codex 版本未完成原生模块补丁加载，保留原生界面")
}

#[derive(Default)]
struct NativeModuleLaunchState {
    prepared: bool,
    compiled: bool,
    failed: bool,
    app_ready: bool,
}

fn native_module_launch_state(result: &Value) -> NativeModuleLaunchState {
    let Some(text) = result
        .pointer("/result/result/value")
        .and_then(Value::as_str)
    else {
        return NativeModuleLaunchState::default();
    };
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        return NativeModuleLaunchState::default();
    };
    NativeModuleLaunchState {
        prepared: value.get("ready").and_then(Value::as_bool) == Some(true),
        compiled: value.get("compiled").and_then(Value::as_bool) == Some(true),
        failed: value.get("failed").and_then(Value::as_bool) == Some(true),
        app_ready: value.get("appReady").and_then(Value::as_bool) == Some(true),
    }
}

pub fn build_macos_open_command(
    app_dir: &Path,
    debug_port: u16,
    extra_args: &[String],
) -> Vec<String> {
    let mut command = vec![
        "open".to_string(),
        "-W".to_string(),
        "-a".to_string(),
        app_dir.to_string_lossy().to_string(),
        "--args".to_string(),
    ];
    command.extend(build_codex_arguments(debug_port, extra_args));
    command
}

pub fn build_macos_cleanup_command(
    app_dir: &Path,
    policy: MacosCleanupPolicy,
) -> Option<Vec<String>> {
    if policy == MacosCleanupPolicy::SkipQuitBecauseAlreadyRunning {
        return None;
    }
    let app_name = app_dir
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("Codex");
    Some(vec![
        "osascript".to_string(),
        "-e".to_string(),
        format!(
            r#"tell application "{}" to quit"#,
            app_name.replace('"', "\\\"")
        ),
    ])
}

pub fn select_macos_debug_launch_action(
    app_running: bool,
    codex_cdp_available: bool,
) -> MacosDebugLaunchAction {
    match (app_running, codex_cdp_available) {
        (false, _) => MacosDebugLaunchAction::LaunchNew,
        (true, true) => MacosDebugLaunchAction::ReuseRunningDebugApp,
        (true, false) => MacosDebugLaunchAction::RestartRunningApp,
    }
}

async fn run_macos_cleanup_command(
    app_dir: &Path,
    policy: MacosCleanupPolicy,
) -> anyhow::Result<()> {
    let Some(command) = build_macos_cleanup_command(app_dir, policy) else {
        return Ok(());
    };
    let Some(executable) = command.first() else {
        return Ok(());
    };
    let _ = Command::new(executable)
        .args(&command[1..])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .with_context(|| format!("failed to request macOS app quit for {}", app_dir.display()))?;
    Ok(())
}

async fn quit_macos_app_and_wait(app_dir: &Path) -> anyhow::Result<()> {
    run_macos_cleanup_command(app_dir, MacosCleanupPolicy::QuitIfNotPreviouslyRunning).await?;
    let deadline = tokio::time::Instant::now()
        + std::time::Duration::from_millis(MACOS_DEBUG_TAKEOVER_WAIT_MS);
    while is_macos_app_running(app_dir).await {
        if tokio::time::Instant::now() >= deadline {
            anyhow::bail!(
                "macOS app did not exit before debug relaunch: {}",
                app_dir.display()
            );
        }
        tokio::time::sleep(std::time::Duration::from_millis(
            MACOS_DEBUG_TAKEOVER_INTERVAL_MS,
        ))
        .await;
    }
    let _ = crate::diagnostic_log::append_diagnostic_log(
        "launcher.macos_existing_app_without_cdp_stopped",
        serde_json::json!({
            "app_dir": app_dir
        }),
    );
    Ok(())
}

fn macos_app_dir_from_open_command(command: &[String]) -> Option<PathBuf> {
    let app_index = command.iter().position(|part| part == "-a")?;
    command.get(app_index + 1).map(PathBuf::from)
}

async fn is_macos_app_running(app_dir: &Path) -> bool {
    if !cfg!(target_os = "macos") {
        return false;
    }
    let app_name = app_dir
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("Codex");
    let script = format!(
        r#"application "{}" is running"#,
        app_name.replace('"', "\\\"")
    );
    let Ok(output) = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .await
    else {
        return false;
    };
    output.status.success()
        && String::from_utf8_lossy(&output.stdout)
            .trim()
            .eq_ignore_ascii_case("true")
}

#[cfg(windows)]
async fn terminate_windows_process_id(process_id: u32) -> anyhow::Result<()> {
    tokio::task::spawn_blocking(move || terminate_windows_process_id_blocking(process_id))
        .await
        .context("Windows process termination task failed")?
}

#[cfg(windows)]
fn terminate_windows_process_id_blocking(process_id: u32) -> anyhow::Result<()> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE, TerminateProcess,
    };

    unsafe {
        let handle = OpenProcess(
            PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION,
            false,
            process_id,
        )
        .with_context(|| format!("failed to open Windows process id {process_id}"))?;
        let terminate_result = TerminateProcess(handle, 1);
        let _ = CloseHandle(handle);
        terminate_result
            .with_context(|| format!("failed to terminate Windows process id {process_id}"))?;
    }
    Ok(())
}

#[cfg(not(windows))]
async fn wait_for_windows_process_id(process_id: u32) -> anyhow::Result<()> {
    anyhow::bail!("cannot wait for Windows process id {process_id} on this platform")
}

#[cfg(not(windows))]
async fn terminate_windows_process_id(process_id: u32) -> anyhow::Result<()> {
    anyhow::bail!("cannot terminate Windows process id {process_id} on this platform")
}

fn launch_status(status: &str, message: &str, debug_port: u16, app_dir: &Path) -> LaunchStatus {
    LaunchStatus {
        status: status.to_string(),
        message: message.to_string(),
        started_at_ms: now_ms(),
        debug_port: Some(debug_port),
        codex_app: Some(app_dir.to_string_lossy().to_string()),
        aumid: crate::app_paths::packaged_app_user_model_id(app_dir),
        // 终态不再是「某个进行中的阶段」；进度固定 100 便于 manager 判断已结束。
        phase: None,
        progress: Some(100),
    }
}

/// 启动阶段埋点（issue #2244）。
///
/// 把每个前置步骤写进 `latest-status.json` 的 `phase`/`progress`，同时往
/// `codex-plus.log` 记一条带「距启动开始多少毫秒」的日志。冷启动慢的时候，
/// 用户与维护者由此能直接指出卡在哪一步，而不用靠进程采样反推。
struct LaunchTimeline {
    status_store: StatusStore,
    started: std::time::Instant,
}

impl LaunchTimeline {
    fn new(status_store: StatusStore) -> Self {
        Self {
            status_store,
            started: std::time::Instant::now(),
        }
    }

    /// 进入某个阶段。状态写入与日志写入都是 best-effort：埋点失败绝不能
    /// 影响启动本身。
    fn mark(&self, phase: &str, progress: u8) {
        let elapsed_ms = self.started.elapsed().as_millis() as u64;
        let _ = self.status_store.save_phase(phase, progress);
        let _ = crate::diagnostic_log::append_diagnostic_log(
            "launcher.phase",
            serde_json::json!({
                "phase": phase,
                "progress": progress,
                "elapsed_ms": elapsed_ms,
            }),
        );
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn command_line_arguments(args: &[String]) -> String {
    args.iter()
        .map(|arg| quote_windows_argument(arg))
        .collect::<Vec<_>>()
        .join(" ")
}

fn quote_windows_argument(arg: &str) -> String {
    if !arg.is_empty() && !arg.bytes().any(|byte| matches!(byte, b' ' | b'\t' | b'"')) {
        return arg.to_string();
    }
    let mut output = String::from("\"");
    let mut backslashes = 0;
    for ch in arg.chars() {
        match ch {
            '\\' => backslashes += 1,
            '"' => {
                output.push_str(&"\\".repeat(backslashes * 2 + 1));
                output.push('"');
                backslashes = 0;
            }
            _ => {
                output.push_str(&"\\".repeat(backslashes));
                output.push(ch);
                backslashes = 0;
            }
        }
    }
    output.push_str(&"\\".repeat(backslashes * 2));
    output.push('"');
    output
}

#[cfg(not(windows))]
pub async fn activate_packaged_app(
    _app_user_model_id: &str,
    _arguments: &str,
) -> anyhow::Result<u32> {
    anyhow::bail!("Packaged app activation is only supported on Windows")
}

/// 提权运行时禁止「AUMID 激活失败 → 按路径直接启动」回退的原因；
/// 非提权返回 None 以保留回退（兜底清单 Application Id 变化等场景）。
///
/// 提权进程无法激活 MSIX 打包应用，按路径启动的进程会因缺少包身份
/// （APPMODEL_ERROR_NO_PACKAGE）立即退出，注入也必然失败；此时必须如实失败
/// 并给出指引，而不是静默回退导致 latest-status.json 误报 running（issue #2351）。
///
/// 不加 `#[cfg(windows)]`：调用点在 `if cfg!(windows)` 的运行时分支里，
/// 全平台都要编译到这个函数（纯逻辑，无平台依赖）。
fn packaged_activation_fallback_block_reason(is_elevated: bool) -> Option<&'static str> {
    if is_elevated {
        Some(
            "Codex 打包应用激活失败，且 Codex Pilot 当前以管理员（提权）身份运行：\
             Windows 不允许提权进程激活 MSIX 打包应用，按路径启动的进程会因缺少\
             包身份立即退出。请取消可执行文件「属性 → 兼容性 → 以管理员身份运行\
             此程序」的勾选（或清除 AppCompatFlags\\Layers 中的 RUNASADMIN 标记），\
             然后以普通权限重新启动 Codex Pilot",
        )
    } else {
        None
    }
}

#[cfg(windows)]
pub async fn activate_packaged_app(
    app_user_model_id: &str,
    arguments: &str,
) -> anyhow::Result<u32> {
    let app_user_model_id = app_user_model_id.to_string();
    let arguments = arguments.to_string();
    let activation = tokio::task::spawn_blocking(move || {
        activate_packaged_app_blocking(&app_user_model_id, &arguments)
    });
    // issue #2795：ActivateApplication 可能一直不返回，必须有上限；超时后阻塞线程留给系统，
    // 启动流程如实报错，不再无声地停在「启动 Codex」。
    let timeout = crate::packaged_launch::AUMID_ACTIVATION_CALL_TIMEOUT;
    match tokio::time::timeout(timeout, activation).await {
        Ok(result) => result.context("packaged app activation task failed")?,
        Err(_) => Err(anyhow::Error::new(
            crate::packaged_launch::AumidActivationTimedOut {
                seconds: timeout.as_secs(),
            },
        )),
    }
}

#[cfg(windows)]
fn activate_packaged_app_blocking(app_user_model_id: &str, arguments: &str) -> anyhow::Result<u32> {
    use windows::Win32::System::Com::{
        CLSCTX_ALL, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx, CoUninitialize,
    };
    use windows::Win32::UI::Shell::{ApplicationActivationManager, IApplicationActivationManager};
    use windows::core::HSTRING;

    unsafe {
        let coinit = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let should_uninitialize = coinit.is_ok();
        coinit.ok().or_else(|error| {
            const RPC_E_CHANGED_MODE: i32 = -2147417850;
            if error.code().0 == RPC_E_CHANGED_MODE {
                Ok(())
            } else {
                Err(error)
            }
        })?;

        let result: windows::core::Result<u32> = (|| {
            let manager: IApplicationActivationManager =
                CoCreateInstance(&ApplicationActivationManager, None, CLSCTX_ALL)?;
            let process_id = manager.ActivateApplication(
                &HSTRING::from(app_user_model_id),
                &HSTRING::from(arguments),
                windows::Win32::UI::Shell::ACTIVATEOPTIONS(0),
            )?;
            Ok(process_id)
        })();

        if should_uninitialize {
            CoUninitialize();
        }
        result.map_err(Into::into)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    // 提权分支依赖 issue #2351 的手动复现步骤验收（勾选兼容性「以管理员身份运行」
    // 后应得到指引错误）。这里不断言当前进程的提权状态：GitHub 的 Windows runner
    // 本身就以提权令牌运行，断言「CI shell 非提权」必然失败。
    #[test]
    fn elevated_activation_failure_blocks_path_fallback_with_guidance() {
        let reason = packaged_activation_fallback_block_reason(true)
            .expect("elevated activation failure must block the path fallback");
        assert!(reason.contains("管理员"));
        assert!(reason.contains("以普通权限"));
    }

    #[test]
    fn unelevated_activation_failure_keeps_path_fallback() {
        assert!(packaged_activation_fallback_block_reason(false).is_none());
    }

    fn counted_reinjector(calls: Arc<AtomicUsize>) -> BridgeReinjector {
        Arc::new(move || {
            let calls = calls.clone();
            Box::pin(async move {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
        })
    }

    #[test]
    fn owned_launcher_exit_follows_its_debug_port_not_other_codex_processes() {
        assert!(owned_launcher_target_alive(false, true));
        assert!(!owned_launcher_target_alive(false, false));
    }

    #[test]
    fn owned_launcher_waits_for_its_codex_process_when_cdp_is_unavailable() {
        assert!(owned_launcher_target_alive(true, false));
    }

    /// macOS 退出等待的回归护栏：一次探测瞬断不能判成「Codex 已退出」。
    ///
    /// 会话退出会停止桥接看门狗，因此不能因一次探测失败误结束仍在使用的增强。
    #[test]
    fn exit_wait_survives_a_single_transient_probe_miss() {
        let now = std::time::Instant::now();
        let mut grace = PackagedExitGrace::default();
        // 探到目标：正常续命。
        assert!(grace.keep_waiting(Some(true), false, now));
        // 瞬断一次：仍在等待。
        assert!(grace.keep_waiting(Some(false), false, now + std::time::Duration::from_secs(2)));
        // 恢复：计数复位，之后再有瞬断也照样给宽限。
        assert!(grace.keep_waiting(Some(true), false, now + std::time::Duration::from_secs(4)));
        assert!(grace.keep_waiting(Some(false), false, now + std::time::Duration::from_secs(6)));
    }

    /// 与上一条互补：真退出必须被有限次探测判出，不能因为宽限而永久续命。
    ///
    /// 宽限条件是「不足 3 次探测失败 **或** 距首次失败不足 10 秒」，两者取宽，
    /// 所以持续探不到时约 10 秒才结束等待——晚一点，但一定会结束。
    #[test]
    fn exit_wait_still_ends_after_sustained_misses() {
        let now = std::time::Instant::now();
        let mut grace = PackagedExitGrace::default();
        assert!(grace.keep_waiting(Some(false), false, now));
        assert!(grace.keep_waiting(Some(false), false, now + std::time::Duration::from_secs(2)));
        // 4 秒：探测次数已超，但仍在 10 秒窗口内，继续等。
        assert!(grace.keep_waiting(Some(false), false, now + std::time::Duration::from_secs(4)));
        // 越过 10 秒窗口：结束等待。
        assert!(!grace.keep_waiting(Some(false), false, now + std::time::Duration::from_secs(12)));
    }

    /// cdp_available 仍要能独立续命：进程身份没捕获到时靠它兜底。
    #[test]
    fn exit_wait_keeps_alive_on_cdp_alone() {
        let now = std::time::Instant::now();
        let mut grace = PackagedExitGrace::default();
        assert!(grace.keep_waiting(None, true, now));
        assert!(grace.keep_waiting(None, true, now + std::time::Duration::from_secs(60)));
    }

    #[test]
    fn packaged_launcher_survives_one_failed_cdp_probe_after_activation_pid_disappears() {
        let now = std::time::Instant::now();
        let mut grace = PackagedExitGrace::default();
        assert!(grace.keep_waiting(None, false, now));
        assert!(grace.keep_waiting(None, true, now + std::time::Duration::from_secs(2)));
    }

    #[test]
    fn packaged_launcher_waits_for_exact_process_without_cdp() {
        let now = std::time::Instant::now();
        let mut grace = PackagedExitGrace::default();
        for seconds in [0, 10, 60, 3600] {
            assert!(grace.keep_waiting(
                Some(true),
                false,
                now + std::time::Duration::from_secs(seconds)
            ));
        }
        assert_eq!(grace.missed_probes, 0);
    }

    #[test]
    fn packaged_launcher_exits_after_bounded_continuous_absence() {
        let now = std::time::Instant::now();
        let mut grace = PackagedExitGrace::default();
        for seconds in [0, 2, 4, 6, 8] {
            assert!(grace.keep_waiting(None, false, now + std::time::Duration::from_secs(seconds)));
        }
        assert!(!grace.keep_waiting(None, false, now + std::time::Duration::from_secs(10)));
    }

    #[test]
    fn packaged_launcher_does_not_follow_another_instance_after_its_process_exits() {
        let now = std::time::Instant::now();
        let mut grace = PackagedExitGrace::default();
        assert!(grace.keep_waiting(Some(true), true, now));
        assert!(grace.keep_waiting(Some(false), true, now));
        assert!(grace.keep_waiting(Some(false), true, now + std::time::Duration::from_secs(2)));
        assert!(!grace.keep_waiting(Some(false), true, now + std::time::Duration::from_secs(10)));
    }

    #[test]
    fn packaged_launcher_recovery_resets_exit_grace() {
        let now = std::time::Instant::now();
        let mut grace = PackagedExitGrace::default();
        assert!(grace.keep_waiting(None, false, now));
        assert!(grace.keep_waiting(None, true, now + std::time::Duration::from_secs(8)));
        assert!(grace.keep_waiting(None, false, now + std::time::Duration::from_secs(20)));
        assert_eq!(grace.missed_probes, 1);
    }

    #[test]
    fn packaged_activation_pid_alone_cannot_keep_launcher_alive_indefinitely() {
        assert!(activation_process_is_startup_evidence(
            true,
            std::time::Duration::from_secs(29)
        ));
        assert!(!activation_process_is_startup_evidence(
            true,
            std::time::Duration::from_secs(30)
        ));
        assert!(!activation_process_is_startup_evidence(
            false,
            std::time::Duration::ZERO
        ));
    }

    #[test]
    fn packaged_browser_fallback_after_discovery_error_and_dead_activation_rejects_replacement() {
        let now = std::time::Instant::now();
        let mut binding = PackagedBrowserBinding {
            initial_id: Some("original".to_string()),
            replaced: false,
        };
        let mut grace = PackagedExitGrace::default();
        // discovery 失败，没有真实句柄，activation 已退出后原路径降级为 None。
        let process_alive = Some(false).filter(|alive| *alive);
        for seconds in [0, 2, 4, 6, 8] {
            assert!(grace.keep_waiting(
                process_alive,
                binding.owns(Some("replacement")),
                now + std::time::Duration::from_secs(seconds)
            ));
        }
        assert!(!grace.keep_waiting(
            process_alive,
            binding.owns(Some("replacement")),
            now + std::time::Duration::from_secs(10)
        ));
    }

    #[test]
    fn packaged_browser_fallback_without_initial_identity_is_bounded() {
        let now = std::time::Instant::now();
        let mut binding = PackagedBrowserBinding {
            initial_id: None,
            replaced: false,
        };
        let mut grace = PackagedExitGrace::default();
        assert!(grace.keep_waiting(None, binding.owns(Some("unbound")), now));
        assert!(grace.keep_waiting(
            None,
            binding.owns(Some("unbound")),
            now + std::time::Duration::from_secs(2)
        ));
        assert!(!grace.keep_waiting(
            None,
            binding.owns(Some("unbound")),
            now + std::time::Duration::from_secs(10)
        ));
    }

    #[tokio::test]
    async fn packaged_browser_capture_rejects_other_browsers_before_reading_their_identity() {
        for (url, accepted) in [("chrome://newtab", false), ("app://-/index.html", true)] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let requests = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
            let recorded = requests.clone();
            let server = tokio::spawn(async move {
                for _ in 0..if accepted { 2 } else { 1 } {
                    let (mut stream, _) = listener.accept().await.unwrap();
                    let mut request = [0; 4096];
                    let count = stream.read(&mut request).await.unwrap();
                    let request = String::from_utf8_lossy(&request[..count]);
                    let path = request.split_whitespace().nth(1).unwrap().to_string();
                    recorded.lock().unwrap().push(path.clone());
                    let body = if path == "/json/version" {
                        serde_json::json!({ "Browser":"Chrome/fixture", "webSocketDebuggerUrl":format!("ws://127.0.0.1:{port}/devtools/browser/fixture-browser") })
                    } else {
                        serde_json::json!([{ "id":"page", "type":"page", "title":"fixture", "url":url,
                            "webSocketDebuggerUrl":format!("ws://127.0.0.1:{port}/devtools/page/fixture-page") }])
                    }.to_string();
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    stream.write_all(response.as_bytes()).await.unwrap();
                }
            });
            let identity = validated_codex_browser_id(port).await;
            server.await.unwrap();
            assert_eq!(identity.as_deref(), accepted.then_some("fixture-browser"));
            assert_eq!(
                requests.lock().unwrap().as_slice(),
                if accepted {
                    &["/json", "/json/version"][..]
                } else {
                    &["/json"][..]
                }
            );
        }
    }

    #[test]
    fn packaged_browser_fallback_after_discovery_error_keeps_only_same_initial_browser() {
        let now = std::time::Instant::now();
        let mut binding = PackagedBrowserBinding {
            initial_id: Some("original".to_string()),
            replaced: false,
        };
        let mut grace = PackagedExitGrace::default();
        let process_alive = Some(false).filter(|alive| *alive);
        for seconds in [0, 10, 60, 3600] {
            assert!(grace.keep_waiting(
                process_alive,
                binding.owns(Some("original")),
                now + std::time::Duration::from_secs(seconds)
            ));
        }
        assert!(!binding.owns(None));
        assert!(binding.owns(Some("original")));
        assert!(!binding.owns(Some("replacement")));
        assert!(
            !binding.owns(Some("original")),
            "实例替换后不能重新绑定旧 ID"
        );
    }

    #[test]
    fn degraded_packaged_launch_keeps_its_captured_browser_after_activation_grace_expires() {
        let now = std::time::Instant::now();
        let mut binding = PackagedBrowserBinding {
            initial_id: Some("captured-degraded-browser".to_string()),
            replaced: false,
        };
        let mut grace = PackagedExitGrace::default();
        for seconds in [0, 10, 30, 60, 3600] {
            let elapsed = std::time::Duration::from_secs(seconds);
            let activation_alive =
                Some(false).filter(|alive| activation_process_is_startup_evidence(*alive, elapsed));
            assert!(grace.keep_waiting(
                activation_alive,
                binding.owns(Some("captured-degraded-browser")),
                now + elapsed,
            ));
        }
        assert_eq!(grace.missed_probes, 0);
    }

    #[test]
    fn packaged_tracked_process_remains_authoritative_when_browser_probe_fails() {
        let now = std::time::Instant::now();
        let mut binding = PackagedBrowserBinding {
            initial_id: Some("original".to_string()),
            replaced: false,
        };
        let mut grace = PackagedExitGrace::default();
        assert!(grace.keep_waiting(Some(true), binding.owns(None), now));
        assert!(grace.keep_waiting(Some(true), binding.owns(Some("replacement")), now));
        assert!(grace.keep_waiting(
            Some(true),
            false,
            now + std::time::Duration::from_secs(3600)
        ));
    }

    #[test]
    fn terminal_status_preserves_run_identity_and_clears_in_progress_phase() {
        let temp = tempfile::tempdir().unwrap();
        let store = StatusStore::new(temp.path().join("status.json"));
        store
            .save_latest(&LaunchStatus {
                status: "running".to_string(),
                started_at_ms: 10,
                phase: Some("ready".to_string()),
                debug_port: Some(9229),
                ..LaunchStatus::default()
            })
            .unwrap();
        save_terminal_launch_status(&store, 10, "stopped", "Codex exited").unwrap();
        let status = store.load_latest().unwrap().unwrap();
        assert_eq!(status.status, "stopped");
        assert_eq!(status.message, "Codex exited");
        assert_eq!(status.started_at_ms, 10);
        assert_eq!(status.debug_port, Some(9229));
        assert_eq!(status.phase, None);
    }

    #[test]
    fn old_launcher_terminal_status_cannot_overwrite_new_restart_request() {
        let temp = tempfile::tempdir().unwrap();
        let store = StatusStore::new(temp.path().join("status.json"));
        let next_request = LaunchStatus {
            status: "starting".to_string(),
            started_at_ms: 20,
            ..LaunchStatus::default()
        };
        store.save_latest(&next_request).unwrap();
        save_terminal_launch_status(&store, 10, "stopped", "old process exited").unwrap();
        assert_eq!(store.load_latest().unwrap(), Some(next_request));
    }

    #[test]
    fn bridge_health_failures_reinject_only_after_consecutive_unhealthy_results() {
        let mut failures = 0;
        assert!(!should_reinject_after_health_result(
            Some(false),
            false,
            &mut failures
        ));
        assert_eq!(failures, 1);
        assert!(should_reinject_after_health_result(
            Some(false),
            false,
            &mut failures
        ));
        assert_eq!(failures, BRIDGE_HEALTH_FAILURE_THRESHOLD);
        assert!(!should_reinject_after_health_result(
            Some(true),
            false,
            &mut failures
        ));
        assert_eq!(failures, 0);

        failures = 1;
        assert!(!should_reinject_after_health_result(
            None,
            false,
            &mut failures
        ));
        assert_eq!(failures, 0);
        assert!(should_reinject_after_health_result(
            Some(false),
            true,
            &mut failures
        ));
    }

    #[test]
    fn reinject_backoff_delay_doubles_and_caps() {
        assert_eq!(
            reinject_backoff_delay(0),
            std::time::Duration::from_secs(10)
        );
        assert_eq!(
            reinject_backoff_delay(1),
            std::time::Duration::from_secs(20)
        );
        assert_eq!(
            reinject_backoff_delay(2),
            std::time::Duration::from_secs(40)
        );
        assert_eq!(
            reinject_backoff_delay(4),
            std::time::Duration::from_secs(160)
        );
        assert_eq!(
            reinject_backoff_delay(5),
            std::time::Duration::from_secs(300)
        );
        assert_eq!(
            reinject_backoff_delay(32),
            std::time::Duration::from_secs(300)
        );
    }

    #[test]
    fn reinject_backoff_blocks_until_deadline_and_resets_on_recovery() {
        let now = std::time::Instant::now();
        let mut backoff = BridgeReinjectBackoff::default();
        assert!(backoff.ready(now), "首次重注入应立即允许");

        backoff.record_attempt(now);
        assert_eq!(backoff.consecutive_attempts, 1);
        assert!(!backoff.ready(now), "重注入后应进入退避窗口");
        assert!(backoff.ready(now + reinject_backoff_delay(0)));

        backoff.record_attempt(now + reinject_backoff_delay(0));
        assert_eq!(backoff.consecutive_attempts, 2);
        assert!(!backoff.ready(now + reinject_backoff_delay(0)));
        assert!(backoff.ready(now + reinject_backoff_delay(0) + reinject_backoff_delay(1)));

        backoff.reset();
        assert_eq!(backoff.consecutive_attempts, 0);
        assert!(backoff.ready(now), "健康恢复后应立即允许重注入");
    }

    #[test]
    fn reinject_backoff_resets_only_after_sustained_health() {
        let now = std::time::Instant::now();
        let reset_after = std::time::Duration::from_secs(BRIDGE_REINJECT_BACKOFF_RESET_AFTER_SECS);
        let mut backoff = BridgeReinjectBackoff::default();

        backoff.record_attempt(now);
        backoff.observe_healthy(now + std::time::Duration::from_secs(1));
        assert_eq!(
            backoff.consecutive_attempts, 1,
            "注入后立刻健康不应清零退避，否则退避永远停在第一档"
        );

        backoff.observe_healthy(now + std::time::Duration::from_secs(30));
        assert_eq!(backoff.consecutive_attempts, 1, "未满阈值不应清零");

        // 中途出现一次不健康，重新计时。
        backoff.observe_unhealthy();
        let restart = now + std::time::Duration::from_secs(40);
        backoff.observe_healthy(restart);
        backoff.observe_healthy(now + std::time::Duration::from_secs(1) + reset_after);
        assert_eq!(
            backoff.consecutive_attempts, 1,
            "不健康之后必须从新起点重新计时"
        );

        backoff.observe_healthy(restart + reset_after);
        assert_eq!(backoff.consecutive_attempts, 0, "持续健康满阈值后应清零");
        assert!(backoff.healthy_since.is_none());
        assert!(backoff.ready(restart + reset_after));
    }

    #[tokio::test]
    async fn bridge_reinjector_prefers_launcher_callback() {
        let launcher_calls = Arc::new(AtomicUsize::new(0));
        let default_calls = Arc::new(AtomicUsize::new(0));

        run_bridge_reinjector(
            Some(counted_reinjector(launcher_calls.clone())),
            counted_reinjector(default_calls.clone()),
        )
        .await
        .unwrap();

        assert_eq!(launcher_calls.load(Ordering::SeqCst), 1);
        assert_eq!(default_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn bridge_reinjector_falls_back_to_core_callback() {
        let default_calls = Arc::new(AtomicUsize::new(0));

        run_bridge_reinjector(None, counted_reinjector(default_calls.clone()))
            .await
            .unwrap();

        assert_eq!(default_calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn injection_stops_when_total_budget_is_exhausted() {
        // 每次尝试都卡住：总预算耗尽后必须返回，而不是跑满次数上限（issue #2681）。
        let outcome = run_injection_attempts(
            Duration::from_millis(120),
            Duration::from_millis(10),
            10,
            |_attempt, _message| {},
            |_attempt| async {
                tokio::time::sleep(Duration::from_secs(30)).await;
                anyhow::bail!("should never finish");
            },
        )
        .await;

        assert!(!outcome.ready);
        assert_eq!(outcome.reason, InjectionStopReason::BudgetExhausted);
        assert_eq!(outcome.attempts, 1, "单次尝试吃光预算后不应再重试");
        assert!(
            outcome
                .last_error
                .as_deref()
                .unwrap_or_default()
                .contains("timed out"),
            "应记录超时原因，实际 {:?}",
            outcome.last_error
        );
        assert!(
            outcome.elapsed_ms < 3_000,
            "总耗时必须收敛到预算量级，实际 {} ms",
            outcome.elapsed_ms
        );
    }

    #[tokio::test]
    async fn injection_succeeds_on_later_attempt() {
        let mut calls = 0;
        let outcome = run_injection_attempts(
            Duration::from_secs(5),
            Duration::from_millis(1),
            10,
            |_attempt, _message| {},
            |_attempt| {
                calls += 1;
                let attempt = calls;
                async move {
                    if attempt < 3 {
                        anyhow::bail!("cdp not ready yet");
                    }
                    Ok(())
                }
            },
        )
        .await;

        assert!(outcome.ready);
        assert_eq!(outcome.reason, InjectionStopReason::Succeeded);
        assert_eq!(outcome.attempts, 3);
    }

    #[tokio::test]
    async fn injection_failure_logging_is_throttled() {
        let logged_attempts = std::sync::Arc::new(std::sync::Mutex::new(Vec::<u32>::new()));
        let logged = logged_attempts.clone();

        let outcome = run_injection_attempts(
            Duration::from_millis(400),
            Duration::from_millis(1),
            10,
            |attempt, message| {
                assert!(message.contains("connect refused"));
                logged.lock().unwrap().push(attempt);
            },
            |_attempt| async { anyhow::bail!("connect refused") },
        )
        .await;

        assert!(!outcome.ready);
        assert!(outcome.attempts >= 20, "失败很快时应尝试足够多次");
        let logged = logged_attempts.lock().unwrap();
        // 首次 + 每 10 次一条；关键是不能随尝试次数线性增长。
        assert_eq!(logged.first().copied(), Some(1));
        assert_eq!(logged.len(), 1 + (outcome.attempts as usize / 10));
        assert!(
            logged.len() * 5 < outcome.attempts as usize,
            "{} 次尝试只应记少量日志，实际 {} 条",
            outcome.attempts,
            logged.len()
        );
    }
}
