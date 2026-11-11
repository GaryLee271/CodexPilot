use anyhow::{Context, Result};
pub use codex_plus_core::launcher::LaunchOptions;
use codex_plus_core::launcher::{
    BridgeReinjector, DefaultLaunchHooks, LaunchHandle, LaunchHooks, launch_and_inject_with_hooks,
};
use codex_plus_core::models::SessionRef;
use codex_plus_core::routes::{BridgeContext, BridgeDataService, BridgeRuntimeService};
use codex_plus_core::status::LaunchStatus;
use codex_plus_core::user_scripts::UserScriptManager;
use serde_json::{Value, json};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex, OnceLock, mpsc};

type NavigationHandler = Arc<dyn Fn(Value) -> Result<()> + Send + Sync>;
static NAVIGATION_HANDLER: OnceLock<Mutex<Option<NavigationHandler>>> = OnceLock::new();

/// 显示同一进程中的主窗口；宿主可消费 pending navigation 后通知前端。
pub fn set_navigation_handler(handler: impl Fn(Value) -> Result<()> + Send + Sync + 'static) {
    *NAVIGATION_HANDLER
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = Some(Arc::new(handler));
}

fn show_gui(payload: Value) -> Result<()> {
    let handler = NAVIGATION_HANDLER
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone()
        .context("Codex Pilot 界面尚未初始化")?;
    handler(payload)
}

type SessionReply = mpsc::Sender<Result<()>>;
type SessionFuture = Pin<Box<dyn Future<Output = ()>>>;
#[derive(Clone)]
struct StartupReply {
    reply: SessionReply,
    state: Arc<Mutex<SessionState>>,
}

impl StartupReply {
    fn send(self, result: Result<()>) -> std::result::Result<(), mpsc::SendError<Result<()>>> {
        if result.is_ok() {
            let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
            state.ready = true;
            record_session_probe(&state.options, state.status_started_at_ms);
        }
        self.reply.send(result)
    }
}

struct SessionState {
    ready: bool,
    attach_only: bool,
    options: LaunchOptions,
    requested_at_ms: u64,
    status_started_at_ms: u64,
}

/// 本进程 launcher 会话的只读快照，供自动接管的判据使用。
///
/// 为什么需要它：launcher 被当库链接进管理器进程，`launcher_guard_port()` 的文件锁
/// 在同一进程内自证无效（`try_lock_exclusive` 必然成功），所以「我这边是不是已经有
/// 一个在管的会话」只能从内存态读，不能从锁或端口反推。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionSnapshot {
    /// 本进程当前是否存在已就绪的 launcher 会话。
    pub owned: bool,
    /// 会话是否已就绪（注入流程走完）。
    pub ready: bool,
    /// `latest-status.json` 里的状态（`running` / `running_degraded` / …）。
    pub status: Option<String>,
    pub debug_port: Option<u16>,
    /// 该会话的状态代际，用来判断是不是同一次启动。
    pub started_at_ms: Option<u64>,
}

/// 会话在运行线程里创建，判据在别的线程读；用一个进程级小结构传递即可，
/// 不必把 `Arc<Mutex<SessionState>>` 暴露出去。
static SESSION_PROBE: OnceLock<Mutex<Option<SessionProbe>>> = OnceLock::new();

#[derive(Clone)]
struct SessionProbe {
    debug_port: u16,
    app_dir: Option<std::path::PathBuf>,
    started_at_ms: u64,
}

fn session_probe_slot() -> &'static Mutex<Option<SessionProbe>> {
    SESSION_PROBE.get_or_init(|| Mutex::new(None))
}

fn record_session_probe(options: &LaunchOptions, started_at_ms: u64) {
    let probe = SessionProbe {
        debug_port: options.debug_port,
        app_dir: options.app_dir.clone(),
        started_at_ms,
    };
    *session_probe_slot()
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = Some(probe);
}

fn clear_session_probe() {
    *session_probe_slot()
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = None;
}

type SessionRunner = Arc<
    dyn Fn(LaunchOptions, tokio::sync::oneshot::Receiver<()>, StartupReply) -> SessionFuture
        + Send
        + Sync,
>;
type ActivationRunner =
    Arc<dyn Fn(LaunchOptions, u64) -> Pin<Box<dyn Future<Output = Result<()>>>> + Send + Sync>;

#[derive(Debug)]
struct StartupBusy;

impl std::fmt::Display for StartupBusy {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("Codex 正在启动，请稍候再试")
    }
}

impl std::error::Error for StartupBusy {}

#[derive(Debug)]
struct ReportedLaunchFailure(anyhow::Error);

impl std::fmt::Display for ReportedLaunchFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        std::fmt::Display::fmt(&self.0, formatter)
    }
}

impl std::error::Error for ReportedLaunchFailure {}

enum RuntimeCommand {
    Start(LaunchOptions, u64, bool, SessionReply),
    Stop(SessionReply),
    Shutdown(SessionReply),
}

struct EmbeddedSession {
    stop: tokio::sync::oneshot::Sender<()>,
    thread: std::thread::JoinHandle<()>,
    finished: tokio::sync::oneshot::Receiver<()>,
    state: Arc<Mutex<SessionState>>,
}

impl EmbeddedSession {
    fn is_finished(&mut self) -> bool {
        self.thread.is_finished()
            || !matches!(
                self.finished.try_recv(),
                Err(tokio::sync::oneshot::error::TryRecvError::Empty)
            )
    }

    fn spawn(
        options: LaunchOptions,
        requested_at_ms: u64,
        attach_only: bool,
        ready: SessionReply,
        runner: SessionRunner,
    ) -> Result<Self> {
        let state = Arc::new(Mutex::new(SessionState {
            ready: false,
            attach_only,
            options: options.clone(),
            requested_at_ms,
            status_started_at_ms: requested_at_ms,
        }));
        let ready = StartupReply {
            reply: ready,
            state: state.clone(),
        };
        let (stop, cancelled) = tokio::sync::oneshot::channel();
        let (done, finished) = tokio::sync::oneshot::channel();
        let thread = std::thread::Builder::new()
            .name("codex-plus-session".into())
            .spawn(move || {
                match tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    Ok(runtime) => {
                        tokio::task::LocalSet::new()
                            .block_on(&runtime, runner(options, cancelled, ready));
                        // 核心 CDP 桥接会 spawn 附属任务。销毁 session runtime 后再通知完成，
                        // 避免它们在 GUI 留存期间跨到下次启动。
                        drop(runtime);
                    }
                    Err(error) => {
                        let _ = ready.send(Err(error.into()));
                    }
                }
                let _ = done.send(());
            })?;
        Ok(Self {
            stop,
            thread,
            finished,
            state,
        })
    }

    async fn join(self) -> Result<()> {
        tokio::task::spawn_blocking(move || self.thread.join())
            .await?
            .map_err(|_| anyhow::anyhow!("Codex session 运行时异常退出"))
    }

    async fn stop(self) -> Result<()> {
        let _ = self.stop.send(());
        tokio::task::spawn_blocking(move || self.thread.join())
            .await?
            .map_err(|_| anyhow::anyhow!("Codex session 运行时异常退出"))
    }
}

struct RuntimeWorker {
    commands: tokio::sync::mpsc::UnboundedSender<RuntimeCommand>,
    thread: std::thread::JoinHandle<()>,
}

impl RuntimeWorker {
    fn spawn(runner: SessionRunner, activate: ActivationRunner) -> Result<Self> {
        let (commands, receiver) = tokio::sync::mpsc::unbounded_channel();
        let (ready, initialized) = mpsc::channel();
        let thread = std::thread::Builder::new()
            .name("codex-plus-runtime".into())
            .spawn(move || {
                let runtime = match tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    Ok(runtime) => runtime,
                    Err(error) => {
                        let _ = ready.send(Err(anyhow::Error::from(error)));
                        return;
                    }
                };
                let _ = ready.send(Ok(()));
                // LaunchHooks 的 future 不要求 Send，始终留在专用线程的 LocalSet。
                tokio::task::LocalSet::new()
                    .block_on(&runtime, runtime_commands(receiver, runner, activate));
            })?;
        if let Err(error) = initialized.recv().context("Codex Pilot 后台运行时初始化失败")? {
            let _ = thread.join();
            return Err(error);
        }
        Ok(Self { commands, thread })
    }
}

enum RuntimeState {
    Idle,
    Running(RuntimeWorker),
    ShuttingDown,
}

impl RuntimeState {
    fn commands_or_start(
        &mut self,
        create: impl FnOnce() -> Result<RuntimeWorker>,
    ) -> Result<tokio::sync::mpsc::UnboundedSender<RuntimeCommand>> {
        if matches!(self, Self::ShuttingDown) {
            anyhow::bail!("Codex Pilot 正在退出，无法启动新的运行时");
        }
        if matches!(self, Self::Idle) {
            *self = Self::Running(create()?);
        }
        match self {
            Self::Running(worker) => Ok(worker.commands.clone()),
            _ => unreachable!("runtime was initialized above"),
        }
    }

    fn begin_shutdown(&mut self) -> Option<RuntimeWorker> {
        // 与 commands_or_start 使用同一把锁。退出后保持终态，阻止已进入 start
        // 但仍在等锁的宿主工作线程重新初始化浏览器兼容事务。
        match std::mem::replace(self, Self::ShuttingDown) {
            Self::Running(worker) => Some(worker),
            Self::Idle | Self::ShuttingDown => None,
        }
    }
}

static RUNTIME_WORKER: OnceLock<Mutex<RuntimeState>> = OnceLock::new();

fn runtime_commands_sender() -> Result<tokio::sync::mpsc::UnboundedSender<RuntimeCommand>> {
    let mut worker = RUNTIME_WORKER
        .get_or_init(|| Mutex::new(RuntimeState::Idle))
        .lock()
        .map_err(|_| anyhow::anyhow!("Codex Pilot 后台运行时锁已损坏"))?;
    worker.commands_or_start(|| {
        RuntimeWorker::spawn(
            Arc::new(|options, stop, ready| Box::pin(run_embedded_session(options, stop, ready))),
            Arc::new(|options, started_at_ms| {
                Box::pin(
                    async move { activate_and_write_running_status(&options, started_at_ms).await },
                )
            }),
        )
    })
}

fn send_runtime_command(command: impl FnOnce(SessionReply) -> RuntimeCommand) -> Result<()> {
    let (reply, result) = mpsc::channel();
    runtime_commands_sender()?
        .send(command(reply))
        .map_err(|_| anyhow::anyhow!("Codex Pilot 后台运行时已退出"))?;
    result.recv().context("Codex Pilot 后台运行时未返回结果")?
}

/// 启动官方 Codex 并等待增强初始化完成；宿主应从 blocking 工作线程调用。
/// 连续点击启动时复用当前 session，不创建第二套桥接或 watchdog。
pub fn start(options: LaunchOptions) -> Result<()> {
    let status_options = options.clone();
    let requested_at_ms = requested_launch_timestamp(&status_options);
    let result =
        send_runtime_command(|reply| RuntimeCommand::Start(options, requested_at_ms, false, reply));
    if let Err(error) = &result
        && !error.is::<StartupBusy>()
        && !error.is::<ReportedLaunchFailure>()
    {
        record_launch_failure(&status_options, requested_at_ms, error);
    }
    result
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchReceipt {
    pub debug_port: u16,
    pub app_dir: std::path::PathBuf,
    pub started_at_ms: u64,
}

/// 与 start 相同，但只从已就绪的本进程会话返回实际端口，不读取旧状态文件猜测。
pub fn start_with_receipt(options: LaunchOptions) -> Result<LaunchReceipt> {
    start(options)?;
    let probe = session_probe_slot()
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let probe = probe.as_ref().context("Codex 启动完成后缺少会话回执")?;
    Ok(LaunchReceipt {
        debug_port: probe.debug_port,
        app_dir: probe.app_dir.clone().context("Codex 会话缺少应用目录")?,
        started_at_ms: probe.started_at_ms,
    })
}

/// 只恢复已有 Codex 的后台服务。调试端点不存在时不启动或重启官方应用。
pub fn resume_if_running(options: LaunchOptions) -> Result<bool> {
    if !codex_plus_core::cdp::endpoint_available(options.debug_port) {
        return Ok(false);
    }
    let requested_at_ms = requested_launch_timestamp(&options);
    send_runtime_command(|reply| RuntimeCommand::Start(options, requested_at_ms, true, reply))?;
    Ok(true)
}

/// 释放当前 session 的 CDP 桥接、watchdog 和浏览器兼容状态，保留官方 Codex。
pub fn stop() -> Result<()> {
    send_runtime_command(RuntimeCommand::Stop)
}

/// 退出 Codex Pilot 时清理所有自有服务并等待专用线程退出，保留官方 Codex。
pub fn shutdown() -> Result<()> {
    let mut worker = RUNTIME_WORKER
        .get_or_init(|| Mutex::new(RuntimeState::Idle))
        .lock()
        .map_err(|_| anyhow::anyhow!("Codex Pilot 后台运行时锁已损坏"))?;
    let Some(current) = worker.begin_shutdown() else {
        return Ok(());
    };
    shutdown_worker(current)
}

/// 读会话快照。纯内存读 + 一次状态文件读，无副作用、不会启动任何东西。
pub fn session_snapshot() -> SessionSnapshot {
    let probe = session_probe_slot()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone();
    let latest = codex_plus_core::status::StatusStore::default()
        .load_latest()
        .ok()
        .flatten();
    // status 取状态文件：它是「注入是否降级」的唯一来源（running_degraded）。
    let status = probe
        .as_ref()
        .and(latest.as_ref().map(|latest| latest.status.clone()));
    SessionSnapshot {
        owned: probe.is_some(),
        ready: probe.is_some(),
        status,
        debug_port: probe
            .as_ref()
            .map(|probe| probe.debug_port)
            .or_else(|| latest.as_ref().and_then(|latest| latest.debug_port)),
        started_at_ms: probe
            .as_ref()
            .map(|probe| probe.started_at_ms)
            .or_else(|| latest.as_ref().map(|latest| latest.started_at_ms)),
    }
}

fn shutdown_worker(current: RuntimeWorker) -> Result<()> {
    let (reply, result) = mpsc::channel();
    let sent = current
        .commands
        .send(RuntimeCommand::Shutdown(reply))
        .is_ok();
    let cleanup = if sent {
        result.recv().context("Codex Pilot 后台运行时未返回退出结果")?
    } else {
        Ok(())
    };
    current
        .thread
        .join()
        .map_err(|_| anyhow::anyhow!("Codex Pilot 后台运行时异常退出"))?;
    cleanup
}

async fn runtime_commands(
    mut commands: tokio::sync::mpsc::UnboundedReceiver<RuntimeCommand>,
    runner: SessionRunner,
    activate: ActivationRunner,
) {
    let mut session: Option<EmbeddedSession> = None;
    loop {
        tokio::select! {
            biased;
            command = commands.recv() => {
                match command {
                    Some(RuntimeCommand::Start(options, requested_at_ms, attach_only, ready)) => {
                        if session.as_mut().is_some_and(EmbeddedSession::is_finished) {
                            if let Some(previous) = session.take() { let _ = previous.join().await; }
                            clear_session_probe();
                        }
                        if let Some(current) = &session {
                            let current_options = {
                                let state = current.state.lock().unwrap_or_else(|error| error.into_inner());
                                state.ready.then(|| (state.options.clone(), state.status_started_at_ms))
                            };
                            let result = match current_options {
                                Some((current_options, started_at_ms)) => {
                                    record_session_probe(&current_options, started_at_ms);
                                    if attach_only { Ok(()) } else { activate(current_options, started_at_ms).await }
                                }
                                None => Err(StartupBusy.into()),
                            };
                            let _ = ready.send(result);
                            continue;
                        }
                        match EmbeddedSession::spawn(options, requested_at_ms, attach_only, ready.clone(), runner.clone()) {
                            Ok(current) => session = Some(current),
                            Err(error) => { let _ = ready.send(Err(error)); }
                        }
                    }
                    Some(RuntimeCommand::Stop(reply)) => {
                        let result = match session.take() { Some(current) => current.stop().await, None => Ok(()) };
                        clear_session_probe();
                        let _ = reply.send(result);
                    }
                    Some(RuntimeCommand::Shutdown(reply)) => {
                        let result = match session.take() { Some(current) => current.stop().await, None => Ok(()) };
                        clear_session_probe();
                        let _ = reply.send(result);
                        break;
                    }
                    None => {
                        if let Some(current) = session.take() { let _ = current.stop().await; }
                        clear_session_probe();
                        break;
                    }
                }
            }
            _ = async {
                if let Some(current) = &mut session { let _ = (&mut current.finished).await; }
                else { std::future::pending::<()>().await; }
            } => {
                if let Some(current) = session.take() { let _ = current.join().await; }
                clear_session_probe();
            }
        }
    }
}

#[derive(Clone)]
struct LauncherHooks {
    attach_only: bool,
    core: Arc<DefaultLaunchHooks>,
    data: Arc<LauncherDataService>,
    runtime: Arc<LauncherRuntimeService>,
    bridge_context: Arc<Mutex<Option<BridgeContext>>>,
    browser_monitor: Arc<Mutex<Option<codex_plus_core::native_browser::BrowserMonitor>>>,
    session_state: Option<Arc<Mutex<SessionState>>>,
}

impl Default for LauncherHooks {
    fn default() -> Self {
        Self {
            attach_only: false,
            core: Arc::new(DefaultLaunchHooks::default()),
            data: Arc::new(LauncherDataService::default()),
            runtime: Arc::new(LauncherRuntimeService::new(
                9229,
                default_user_script_manager(),
            )),
            bridge_context: Arc::new(Mutex::new(None)),
            browser_monitor: Arc::new(Mutex::new(None)),
            session_state: None,
        }
    }
}

impl LauncherHooks {
    fn watchdog_bridge_context(&self) -> anyhow::Result<BridgeContext> {
        self.bridge_context
            .lock()
            .map_err(|_| anyhow::anyhow!("bridge context lock poisoned"))?
            .clone()
            .ok_or_else(|| anyhow::anyhow!("bridge context is not initialized"))
    }
}

fn requested_launch_timestamp(options: &LaunchOptions) -> u64 {
    options
        .status_store
        .load_latest()
        .ok()
        .flatten()
        .filter(|latest| latest.status == "starting")
        .map(|latest| latest.started_at_ms)
        .unwrap_or_else(current_timestamp_ms)
}

fn record_launch_failure(options: &LaunchOptions, requested_at_ms: u64, error: &anyhow::Error) {
    let _ = codex_plus_core::diagnostic_log::append_diagnostic_log(
        "launcher.failed",
        json!({ "message": error.to_string() }),
    );
    if options
        .status_store
        .load_latest()
        .ok()
        .flatten()
        .is_some_and(|latest| latest.started_at_ms > requested_at_ms && latest.status != "failed")
    {
        // 旧启动取消后的返回不得把已经保存的新请求覆盖为 failed。
        return;
    }
    let _ = options.status_store.save_latest(&LaunchStatus {
        status: "failed".to_string(),
        message: error.to_string(),
        started_at_ms: requested_at_ms,
        debug_port: Some(options.debug_port),
        codex_app: options
            .app_dir
            .as_ref()
            .map(|path| path.to_string_lossy().to_string()),
        aumid: None,
        ..LaunchStatus::default()
    });
}

async fn run_embedded_session(
    options: LaunchOptions,
    mut stop: tokio::sync::oneshot::Receiver<()>,
    ready: StartupReply,
) {
    let requested_at_ms = ready
        .state
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .requested_at_ms;
    let hooks = LauncherHooks {
        attach_only: ready
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .attach_only,
        session_state: Some(ready.state.clone()),
        ..LauncherHooks::default()
    };
    let mut stopped_by_host = false;
    let mut ready = Some(ready);
    let guard = match acquire_single_instance_guard(options.debug_port) {
        Ok(guard) => guard,
        Err(error) => {
            record_launch_failure(&options, requested_at_ms, &error);
            if let Some(ready) = ready.take() {
                let _ = ready.send(Err(ReportedLaunchFailure(error).into()));
            }
            return;
        }
    };
    // 启动包含 spawn_blocking 的数据库/系统浏览器事务；停止请求要等它们完成，
    // 再销毁 monitor owner，不能直接取消 future 让已开始的系统改写失去恢复句柄。
    let result = match launcher_session(options.clone(), &hooks, &mut ready, guard.is_some()).await
    {
        Ok(Some(handle)) => {
            let (host_stop, result) =
                wait_for_session_exit_or_stop(handle.wait_for_codex_exit(), &mut stop).await;
            stopped_by_host = host_stop;
            result
        }
        Ok(None) => Ok(()),
        Err(error) => Err(error),
    };
    // 启动中取消也要显式清理。不能依赖进程退出，否则 GUI 仍在时桥接任务和系统浏览器会残留。
    hooks.stop_bridge_watchdog().await;
    hooks.stop_native_browser_compatibility().await;
    if stopped_by_host {
        let started_at_ms = hooks
            .session_state
            .as_ref()
            .unwrap()
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .status_started_at_ms;
        if let Err(error) =
            save_stopped_service_status_if_current(&options.status_store, started_at_ms)
        {
            let _ = codex_plus_core::diagnostic_log::append_diagnostic_log(
                "launcher.stop_status_failed",
                json!({ "message": error.to_string() }),
            );
        }
    }
    drop(guard);
    if let Err(error) = result {
        record_launch_failure(&options, requested_at_ms, &error);
        if let Some(ready) = ready.take() {
            let _ = ready.send(Err(ReportedLaunchFailure(error).into()));
        }
    }
}

fn save_stopped_service_status_if_current(
    store: &codex_plus_core::status::StatusStore,
    started_at_ms: u64,
) -> Result<bool> {
    let Some(mut latest) = store.load_latest()? else {
        return Ok(false);
    };
    if latest.started_at_ms != started_at_ms || latest.status == "stopped" {
        // 新的重启请求和自然退出终态都由它们自己的生命周期管理。
        return Ok(false);
    }
    latest.status = "stopped".to_string();
    latest.message = "Codex Pilot 后台增强服务已停止，未关闭官方 Codex。".to_string();
    latest.phase = None;
    latest.progress = None;
    store.save_latest(&latest)?;
    Ok(true)
}

async fn launcher_session(
    options: LaunchOptions,
    hooks: &LauncherHooks,
    ready: &mut Option<StartupReply>,
    owns_guard: bool,
) -> Result<Option<LaunchHandle>> {
    if !owns_guard {
        anyhow::ensure!(
            !hooks.attach_only,
            "已有 Codex Pilot 后台服务正在运行，不能重复恢复"
        );
        if codex_plus_core::watcher::find_codex_processes().is_empty()
            && !codex_plus_core::watcher::cdp_listening(options.debug_port)
        {
            anyhow::bail!("已有 Codex Pilot 启动服务正在运行，请退出旧版本后再启动 Codex");
        }
        let started_at_ms = ready
            .as_ref()
            .map(|reply| {
                reply
                    .state
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .requested_at_ms
            })
            .unwrap_or_else(current_timestamp_ms);
        activate_and_write_running_status(&options, started_at_ms).await?;
        if let Some(ready) = ready.take() {
            let _ = ready.send(Ok(()));
        }
        return Ok(None);
    }
    let started = std::time::Instant::now();
    let handle = launch_and_inject_with_hooks(options, hooks).await?;
    let _ = codex_plus_core::diagnostic_log::append_diagnostic_log(
        "launcher.startup_phase",
        json!({"phase": "launch_and_inject", "elapsed_ms": started.elapsed().as_millis()}),
    );
    if let Some(ready) = ready.take() {
        {
            let mut state = ready
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            state.options.app_dir = Some(handle.app_dir.clone());
            state.options.debug_port = handle.debug_port;
            // 「重启」许可只对这一次启动有效：之后再点「启动」复用本会话激活时，
            // 不能沿用它去结束用户另开的 Codex。
            state.options.replace_blocking_main_instance = false;
            state.status_started_at_ms = handle
                .status_store
                .load_latest()
                .ok()
                .flatten()
                .map(|status| status.started_at_ms)
                .unwrap_or(state.requested_at_ms);
        }
        let _ = ready.send(Ok(()));
    }
    Ok(Some(handle))
}

async fn activate_and_write_running_status(
    options: &LaunchOptions,
    started_at_ms: u64,
) -> Result<()> {
    activate_existing_codex_app(options).await?;
    options.status_store.save_latest(&LaunchStatus {
        status: "running".to_string(),
        message: "Existing Codex instance activated".to_string(),
        started_at_ms,
        debug_port: Some(options.debug_port),
        codex_app: options
            .app_dir
            .as_ref()
            .map(|path| path.to_string_lossy().to_string()),
        aumid: None,
        ..LaunchStatus::default()
    })
}

async fn wait_for_session_exit_or_stop(
    exit: impl std::future::Future<Output = Result<()>>,
    stop: &mut tokio::sync::oneshot::Receiver<()>,
) -> (bool, Result<()>) {
    tokio::select! {
        biased;
        _ = stop => (true, Ok(())),
        result = exit => (false, result),
    }
}

fn current_timestamp_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn acquire_single_instance_guard(
    debug_port: u16,
) -> anyhow::Result<Option<codex_plus_core::ports::LoopbackPortGuard>> {
    match try_acquire_single_instance_guard() {
        Ok(guard) => {
            if let Some(fallback_lock_path) = guard.fallback_path() {
                log_launcher_guard_fallback(fallback_lock_path);
            }
            Ok(Some(guard))
        }
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::AddrInUse
            ) =>
        {
            log_launcher_already_running(debug_port);
            // 锁可能属于另一个 Codex Pilot 主进程；绝不能按旧 launcher 名称终止它。
            Ok(None)
        }
        Err(error) => Err(error)
            .with_context(|| {
                format!(
                    "failed to acquire launcher guard port {}",
                    codex_plus_core::ports::launcher_guard_port()
                )
            })
            .map(Some),
    }
}

fn try_acquire_single_instance_guard() -> std::io::Result<codex_plus_core::ports::LoopbackPortGuard>
{
    codex_plus_core::ports::acquire_resilient_loopback_port_guard(
        codex_plus_core::ports::launcher_guard_port(),
    )
}

fn log_launcher_guard_fallback(fallback_lock_path: &Path) {
    let _ = codex_plus_core::diagnostic_log::append_diagnostic_log(
        "launcher.guard_fallback",
        json!({
            "requested_guard_port": codex_plus_core::ports::launcher_guard_port(),
            "fallback_lock_path": fallback_lock_path
        }),
    );
}

async fn activate_existing_codex_app(options: &LaunchOptions) -> anyhow::Result<()> {
    let hooks = LauncherHooks::default();
    let settings = hooks.load_settings().await?;
    let app_dir = hooks.resolve_app_dir(options.app_dir.as_deref(), &settings)?;
    let launch_result = hooks
        .launch_codex(
            &app_dir,
            options.debug_port,
            &settings,
            &[],
            &codex_plus_core::launcher::LaunchInstance::from_options(&options),
        )
        .await;
    // 复用后台服务也属于用户主动启动；已有资源补丁由原服务持有，
    // 这里只执行与完整启动相同的首次应用检查，不能重新创建桥接或 watchdog。
    // 项目分区也依赖模块预载；仅开分区时同样需要等待原服务准备完成并应用补丁。
    if settings.enhancements_enabled
        && (settings.codex_app_native_fast_unlock
            || settings.codex_app_native_predictions
            || settings.codex_app_native_project_sections)
        && let Ok(launch) = &launch_result
        && let Err(error) = hooks
            .apply_native_module_patches_on_launch(
                launch.debug_port().unwrap_or(options.debug_port),
            )
            .await
    {
        let _ = codex_plus_core::diagnostic_log::append_diagnostic_log(
            "launcher.native_module_patch_failed",
            json!({"message": error.to_string(), "phase": "activate_existing"}),
        );
    }
    let process_ids = codex_plus_core::watcher::find_codex_processes();
    #[cfg(windows)]
    let activated = process_ids
        .iter()
        .copied()
        .any(codex_plus_core::windows_activate_process_window);
    #[cfg(not(windows))]
    let activated = false;
    let _ = codex_plus_core::diagnostic_log::append_diagnostic_log(
        "launcher.activate_existing_codex",
        json!({
            "app_dir": app_dir.to_string_lossy(),
            "debug_port": options.debug_port,
            "process_ids": process_ids,
            "activated": activated,
            "launch_ok": launch_result.is_ok(),
            "launch_error": launch_result.as_ref().err().map(|error| error.to_string())
        }),
    );
    launch_result.map(|_| ())
}

fn log_launcher_already_running(debug_port: u16) {
    let _ = codex_plus_core::diagnostic_log::append_diagnostic_log(
        "launcher.already_running",
        json!({
            "guard_port": codex_plus_core::ports::launcher_guard_port(),
            "debug_port": debug_port
        }),
    );
}

#[async_trait::async_trait(?Send)]
impl LaunchHooks for LauncherHooks {
    fn resolve_app_dir(
        &self,
        app_dir: Option<&std::path::Path>,
        settings: &codex_plus_core::settings::BackendSettings,
    ) -> anyhow::Result<std::path::PathBuf> {
        self.core.resolve_app_dir(app_dir, settings)
    }

    fn select_debug_port(&self, requested: u16) -> u16 {
        if self.attach_only {
            requested
        } else {
            self.core.select_debug_port(requested)
        }
    }

    async fn load_settings(&self) -> anyhow::Result<codex_plus_core::settings::BackendSettings> {
        self.core.load_settings().await
    }

    async fn start_native_browser_compatibility(
        &self,
        settings: &codex_plus_core::settings::BackendSettings,
    ) {
        let started = std::time::Instant::now();
        let monitor = codex_plus_core::native_browser::start_monitor(
            settings.enhancements_enabled
                && settings.codex_app_native_browser_require_identification,
        )
        .await;
        *self
            .browser_monitor
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = monitor;
        let _ = codex_plus_core::diagnostic_log::append_diagnostic_log(
            "launcher.startup_phase",
            json!({"phase": "native_browser", "elapsed_ms": started.elapsed().as_millis()}),
        );
    }

    async fn stop_native_browser_compatibility(&self) {
        let monitor = self
            .browser_monitor
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        if let Some(monitor) = monitor {
            monitor.stop().await;
        }
    }

    fn cleanup_unsupported_config(
        &self,
        settings: &codex_plus_core::settings::BackendSettings,
    ) -> anyhow::Result<()> {
        self.core.cleanup_unsupported_config(settings)
    }

    async fn launch_codex(
        &self,
        app_dir: &Path,
        debug_port: u16,
        settings: &codex_plus_core::settings::BackendSettings,
        extra_args: &[String],
        instance: &codex_plus_core::launcher::LaunchInstance,
    ) -> anyhow::Result<codex_plus_core::launcher::CodexLaunch> {
        if self.attach_only {
            anyhow::ensure!(
                codex_plus_core::cdp::endpoint_available(debug_port),
                "恢复后台服务时 Codex 调试连接已断开"
            );
            return Ok(codex_plus_core::launcher::CodexLaunch::Process {
                command: Vec::new(),
                wait_strategy: codex_plus_core::launcher::ProcessWaitStrategy::ExternalWaitCommand,
                macos_cleanup_policy: Some(
                    codex_plus_core::launcher::MacosCleanupPolicy::SkipQuitBecauseAlreadyRunning,
                ),
            });
        }
        self.core
            .launch_codex(app_dir, debug_port, settings, extra_args, instance)
            .await
    }

    async fn bridge_context(
        &self,
        debug_port: u16,
        app_dir: &Path,
    ) -> anyhow::Result<Option<BridgeContext>> {
        self.runtime.set_debug_port(debug_port);
        let ctx = BridgeContext::core_with_data_and_app_dir(
            self.runtime.clone(),
            self.data.clone(),
            app_dir.to_path_buf(),
        );
        *self
            .bridge_context
            .lock()
            .map_err(|_| anyhow::anyhow!("bridge context lock poisoned"))? = Some(ctx.clone());
        Ok(Some(ctx))
    }

    async fn inject_bridge(&self, debug_port: u16, ctx: BridgeContext) -> anyhow::Result<()> {
        inject_with_context(debug_port, ctx, self.runtime.clone()).await
    }

    async fn inject(&self, debug_port: u16) -> anyhow::Result<()> {
        self.core.inject(debug_port).await
    }

    async fn apply_native_module_patches_on_launch(&self, debug_port: u16) -> anyhow::Result<()> {
        // 恢复后台服务只补回桥接，不刷新用户正在使用的页面。
        if self.attach_only {
            return Ok(());
        }
        self.core
            .apply_native_module_patches_on_launch(debug_port)
            .await
    }

    async fn capture_injected_launch_identity(&self, debug_port: u16) {
        self.core.capture_injected_launch_identity(debug_port).await;
    }

    async fn start_bridge_watchdog(&self, debug_port: u16) -> anyhow::Result<()> {
        let ctx = self.watchdog_bridge_context()?;
        let runtime = self.runtime.clone();
        let reinjector: BridgeReinjector = Arc::new(move || {
            let ctx = ctx.clone();
            let runtime = runtime.clone();
            Box::pin(async move { inject_with_context(debug_port, ctx, runtime).await })
        });
        self.core.set_bridge_reinjector(reinjector).await;
        self.core.start_bridge_watchdog(debug_port).await
    }

    async fn write_status(&self, status: &str) {
        self.core.write_status(status).await;
    }

    async fn wait_for_codex_exit(
        &self,
        launch: &codex_plus_core::launcher::CodexLaunch,
        debug_port: u16,
    ) -> anyhow::Result<()> {
        let result = self.core.wait_for_codex_exit(launch, debug_port).await;
        if let Some(state) = &self.session_state {
            state
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .ready = false;
        }
        result
    }

    async fn stop_bridge_watchdog(&self) {
        self.core.stop_bridge_watchdog().await;
    }

    async fn terminate_codex(&self, launch: &codex_plus_core::launcher::CodexLaunch) {
        if !self.attach_only {
            self.core.terminate_codex(launch).await;
        }
    }
}

#[derive(Debug, Clone)]
struct LauncherDataService {
    db_path: PathBuf,
    backup_dir: PathBuf,
}

impl Default for LauncherDataService {
    fn default() -> Self {
        Self {
            db_path: default_codex_db_path(),
            backup_dir: codex_plus_core::paths::default_app_state_dir().join("backups"),
        }
    }
}

#[async_trait::async_trait]
impl BridgeDataService for LauncherDataService {
    async fn thread_usage_history(&self, session: SessionRef) -> anyhow::Result<Value> {
        let adapter = self.storage_adapter();
        tokio::task::spawn_blocking(move || adapter.codex_thread_usage_history(&session))
            .await
            .map_err(|error| anyhow::anyhow!("thread usage history task failed: {error}"))
    }

    async fn thread_usage_live(&self, session: SessionRef) -> anyhow::Result<Value> {
        let adapter = self.storage_adapter();
        tokio::task::spawn_blocking(move || adapter.codex_thread_usage_live(&session))
            .await
            .map_err(|error| anyhow::anyhow!("thread usage live task failed: {error}"))
    }

    async fn find_archived_thread_by_title(
        &self,
        title: String,
    ) -> anyhow::Result<Option<SessionRef>> {
        let adapter = self.storage_adapter();
        tokio::task::spawn_blocking(move || adapter.find_archived_thread_by_title(&title))
            .await
            .map_err(|error| anyhow::anyhow!("archived lookup task failed: {error}"))
    }
}

impl LauncherDataService {
    fn candidate_db_paths(&self) -> Vec<PathBuf> {
        let mut paths = vec![self.db_path.clone()];
        for path in codex_plus_core::codex_sqlite::codex_session_db_paths_from_home(
            &codex_plus_core::codex_sqlite::default_codex_home_dir(),
        ) {
            if !paths.iter().any(|candidate| candidate == &path) {
                paths.push(path);
            }
        }
        paths
    }

    fn storage_adapter(&self) -> codex_plus_data::SQLiteStorageAdapter {
        let allowed_db_paths = self.candidate_db_paths();
        codex_plus_data::SQLiteStorageAdapter::new(
            self.db_path.clone(),
            codex_plus_data::BackupStore::new(self.backup_dir.clone()),
        )
        .with_allowed_db_paths(allowed_db_paths)
        .with_codex_home(codex_plus_core::codex_sqlite::default_codex_home_dir())
    }
}

struct LauncherRuntimeService {
    debug_port: Mutex<u16>,
    websocket_url: Mutex<Option<String>>,
    user_scripts: UserScriptManager,
}

impl LauncherRuntimeService {
    fn new(debug_port: u16, user_scripts: UserScriptManager) -> Self {
        Self {
            debug_port: Mutex::new(debug_port),
            websocket_url: Mutex::new(None),
            user_scripts,
        }
    }

    fn set_debug_port(&self, debug_port: u16) {
        *self.debug_port.lock().unwrap() = debug_port;
    }

    fn set_websocket_url(&self, websocket_url: &str) {
        *self.websocket_url.lock().unwrap() = Some(websocket_url.to_string());
    }
}

#[async_trait::async_trait]
impl BridgeRuntimeService for LauncherRuntimeService {
    async fn user_script_inventory(&self) -> anyhow::Result<Value> {
        self.user_scripts.inventory()
    }

    async fn user_script_inventory_with_runtime_status(
        &self,
        payload: Value,
    ) -> anyhow::Result<Value> {
        self.user_scripts
            .inventory_with_runtime_status(payload.get("runtime_status"))
    }

    async fn set_user_script_enabled(&self, key: String, enabled: bool) -> anyhow::Result<Value> {
        let result = self.user_scripts.set_script_enabled(&key, enabled);
        // 与管理器一致：拓展带的钩子 / Codex 资产跟着启停写回 Codex 配置。
        codex_plus_core::extension_hooks::sync_default(&self.user_scripts);
        result?;
        self.user_scripts.inventory()
    }

    async fn load_user_scripts(&self) -> anyhow::Result<Value> {
        let websocket_url = self
            .websocket_url
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| anyhow::anyhow!("Codex 页面尚未连接"))?;
        codex_plus_core::user_scripts::load_scripts_at(&websocket_url, &self.user_scripts).await
    }

    async fn reload_user_scripts(&self) -> anyhow::Result<Value> {
        let websocket_url = self
            .websocket_url
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| anyhow::anyhow!("Codex 页面尚未连接"))?;
        codex_plus_core::user_scripts::reload_scripts_at(&websocket_url, &self.user_scripts).await
    }

    async fn cdp_targets(&self) -> anyhow::Result<Value> {
        let debug_port = *self.debug_port.lock().unwrap();
        codex_plus_core::cdp::list_extension_cdp_targets(debug_port).await
    }

    async fn cdp_evaluate(&self, payload: Value) -> anyhow::Result<Value> {
        let debug_port = *self.debug_port.lock().unwrap();
        codex_plus_core::routes::evaluate_extension_cdp(debug_port, &payload).await
    }

    async fn request_app_server_client_capture(&self) -> anyhow::Result<Value> {
        let websocket_url = self
            .websocket_url
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| anyhow::anyhow!("Codex 页面尚未连接"))?;
        let started = codex_plus_core::bridge::request_app_server_client_capture(&websocket_url);
        Ok(serde_json::json!({ "status": "ok", "started": started }))
    }

    async fn open_devtools(&self) -> anyhow::Result<Value> {
        let debug_port = *self.debug_port.lock().unwrap();
        let targets = codex_plus_core::cdp::list_targets(debug_port).await?;
        let target = codex_plus_core::cdp::pick_page_target(&targets)?;
        let url = codex_plus_core::routes::devtools_url(debug_port, &target.id);
        open_url(&url)?;
        Ok(json!({
            "status": "ok",
            "target_id": target.id,
            "url": url
        }))
    }

    async fn open_manager(&self, payload: Value) -> anyhow::Result<Value> {
        let navigation =
            codex_plus_core::manager_navigation::save_pending_manager_navigation_from_payload(
                &payload,
            )?;
        show_gui(payload)
            .map_err(|error| anyhow::anyhow!("打开 Codex Pilot 界面失败：{error}"))
            .map_err(|error| {
                codex_plus_core::manager_navigation::rollback_pending_manager_navigation_after_launch_failure(
                    navigation.as_ref(),
                    error,
                )
            })?;
        Ok(json!({
            "status": "ok",
            "path": std::env::current_exe().ok(),
            "navigation": navigation
        }))
    }

    async fn open_transient_manager(&self, payload: Value) -> anyhow::Result<Value> {
        self.open_manager(payload).await
    }

    async fn backend_status(&self) -> anyhow::Result<Value> {
        Ok(
            json!({"status": "ok", "message": "后端已连接", "version": codex_plus_core::version::VERSION}),
        )
    }

    async fn codex_model_catalog(&self) -> anyhow::Result<Value> {
        Ok(codex_plus_core::model_catalog::read_codex_model_catalog().await)
    }
}

async fn inject_with_context(
    debug_port: u16,
    ctx: BridgeContext,
    runtime: Arc<LauncherRuntimeService>,
) -> anyhow::Result<()> {
    let mut last_error = None;
    for _ in 0..20 {
        match try_inject_with_context(debug_port, ctx.clone(), runtime.clone()).await {
            Ok(()) => return Ok(()),
            Err(error) => {
                last_error = Some(error);
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            }
        }
    }

    Err(last_error.unwrap_or_else(|| anyhow::anyhow!("Codex injection failed")))
}

async fn try_inject_with_context(
    debug_port: u16,
    ctx: BridgeContext,
    runtime: Arc<LauncherRuntimeService>,
) -> anyhow::Result<()> {
    let targets = codex_plus_core::cdp::list_targets(debug_port).await?;
    let target = codex_plus_core::cdp::pick_injectable_codex_page_target(&targets)?;
    let websocket_url = target
        .web_socket_debugger_url
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("selected CDP target has no websocket URL"))?;
    runtime.set_websocket_url(websocket_url);
    let settings = codex_plus_core::settings::SettingsStore::default()
        .load()
        .unwrap_or_default();
    let script = codex_plus_core::assets::injection_script_with_settings(&settings);
    let new_document_scripts = vec![
        script,
        codex_plus_core::user_scripts::BOOTSTRAP_SCRIPT.to_string(),
    ];
    codex_plus_core::bridge::install_bridge(
        websocket_url,
        codex_plus_core::bridge::BRIDGE_BINDING_NAME,
        Arc::new(move |path, payload| {
            let ctx = ctx.clone();
            Box::pin(async move {
                Ok(codex_plus_core::routes::handle_bridge_request(ctx, &path, payload).await)
            })
        }),
        &new_document_scripts,
    )
    .await
}

fn default_codex_db_path() -> PathBuf {
    codex_plus_core::codex_sqlite::codex_session_db_path()
}

fn open_url(url: &str) -> anyhow::Result<()> {
    #[cfg(windows)]
    {
        codex_plus_core::windows_open_url(url)
            .map_err(|error| anyhow::anyhow!("failed to open DevTools URL: {error}"))
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(url)
            .spawn()
            .map(|_| ())
            .map_err(|error| anyhow::anyhow!("failed to open DevTools URL: {error}"))
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(url)
            .spawn()
            .map(|_| ())
            .map_err(|error| anyhow::anyhow!("failed to open DevTools URL: {error}"))
    }

    #[cfg(not(any(windows, target_os = "macos", unix)))]
    {
        let _ = url;
        anyhow::bail!("opening DevTools URL is not supported on this platform")
    }
}

fn default_user_script_manager() -> UserScriptManager {
    // 目录算法统一在 core，管理器、本地代理、钩子分发共用同一份。
    codex_plus_core::user_scripts::default_user_script_manager()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launcher_uses_single_instance_guard_before_launching() {
        let source = include_str!("main.rs");

        assert!(source.contains("acquire_single_instance_guard(options.debug_port)"));
        assert!(source.contains("launcher_guard_port"));
        assert!(source.contains("launcher.already_running"));
        assert!(source.contains("Existing Codex instance activated"));
        assert!(source.contains("status: \"failed\".to_string()"));
    }

    #[test]
    fn occupied_session_guard_does_not_terminate_another_gui_process() {
        let source = include_str!("main.rs");
        let start = source.find("fn acquire_single_instance_guard(").unwrap();
        let end = source[start..]
            .find("fn try_acquire_single_instance_guard()")
            .unwrap()
            + start;
        let body = &source[start..end];
        assert!(body.contains("std::io::ErrorKind::WouldBlock | std::io::ErrorKind::AddrInUse"));
        assert!(!body.contains("stop_launcher_processes"));
        assert!(body.contains("Ok(None)"));
    }

    fn send_test_command(
        worker: &RuntimeWorker,
        command: impl FnOnce(SessionReply) -> RuntimeCommand,
    ) -> Result<()> {
        let (reply, result) = mpsc::channel();
        worker.commands.send(command(reply)).unwrap();
        result
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("runtime command timed out")
    }

    fn test_start_command(options: LaunchOptions, reply: SessionReply) -> RuntimeCommand {
        RuntimeCommand::Start(options, 100, false, reply)
    }

    #[tokio::test]
    async fn restore_attaches_without_launching_and_preserves_requested_ports() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 1024];
            stream.read(&mut request).unwrap();
            let body = format!(
                r#"[{{"id":"codex","type":"page","title":"Codex","url":"app://-/index.html","webSocketDebuggerUrl":"ws://127.0.0.1:{port}/devtools/page/1"}}]"#
            );
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .unwrap();
        });
        let hooks = LauncherHooks {
            attach_only: true,
            ..Default::default()
        };
        assert_eq!(hooks.select_debug_port(port), port);
        // 路径不可执行也能附着，证明恢复不会走启动官方应用的分支。
        let launch = hooks
            .launch_codex(
                Path::new("/missing-codex"),
                port,
                &codex_plus_core::settings::BackendSettings::default(),
                &[],
                &codex_plus_core::launcher::LaunchInstance::default(),
            )
            .await
            .unwrap();
        assert_eq!(
            launch,
            codex_plus_core::launcher::CodexLaunch::Process {
                command: Vec::new(),
                wait_strategy: codex_plus_core::launcher::ProcessWaitStrategy::ExternalWaitCommand,
                macos_cleanup_policy: Some(
                    codex_plus_core::launcher::MacosCleanupPolicy::SkipQuitBecauseAlreadyRunning
                ),
            }
        );
        server.join().unwrap();
    }

    #[tokio::test]
    async fn restore_does_not_launch_if_the_debugger_disappears() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let hooks = LauncherHooks {
            attach_only: true,
            ..Default::default()
        };
        let error = hooks
            .launch_codex(
                Path::new("/missing-codex"),
                port,
                &codex_plus_core::settings::BackendSettings::default(),
                &[],
                &codex_plus_core::launcher::LaunchInstance::default(),
            )
            .await
            .unwrap_err();
        assert!(error.to_string().contains("调试连接已断开"));
        assert!(
            !resume_if_running(LaunchOptions {
                debug_port: port,
                ..Default::default()
            })
            .unwrap()
        );
    }

    #[test]
    fn restore_mode_reaches_the_session_and_repeated_restore_does_not_activate_codex() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let restored = Arc::new(AtomicUsize::new(0));
        let count = restored.clone();
        let worker = RuntimeWorker::spawn(
            Arc::new(move |_, stop, ready| {
                assert!(ready.state.lock().unwrap().attach_only);
                count.fetch_add(1, Ordering::SeqCst);
                Box::pin(async move {
                    ready.send(Ok(())).unwrap();
                    let _ = stop.await;
                })
            }),
            Arc::new(|_, _| panic!("restoration must not activate or restart Codex")),
        )
        .unwrap();
        for _ in 0..2 {
            send_test_command(&worker, |reply| {
                RuntimeCommand::Start(LaunchOptions::default(), 100, true, reply)
            })
            .unwrap();
        }
        assert_eq!(restored.load(Ordering::SeqCst), 1);
        send_test_command(&worker, RuntimeCommand::Shutdown).unwrap();
        worker.thread.join().unwrap();
    }

    #[test]
    fn shutdown_rejects_a_concurrent_start_waiting_for_the_worker_lock() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let creations = Arc::new(AtomicUsize::new(0));
        let state = Arc::new(Mutex::new(RuntimeState::Idle));
        let mut exiting = state.lock().unwrap();
        exiting
            .commands_or_start(|| {
                creations.fetch_add(1, Ordering::SeqCst);
                RuntimeWorker::spawn(
                    Arc::new(|_, stop, ready| {
                        Box::pin(async move {
                            let _ = ready.send(Ok(()));
                            let _ = stop.await;
                        })
                    }),
                    Arc::new(|_, _| Box::pin(async { Ok(()) })),
                )
            })
            .unwrap();

        let (entered, waiting) = mpsc::channel();
        let caller_state = state.clone();
        let caller_creations = creations.clone();
        let pending_start = std::thread::spawn(move || {
            // 模拟已通过宿主退出预检查、正在等待 worker 锁的启动任务。
            entered.send(()).unwrap();
            caller_state.lock().unwrap().commands_or_start(|| {
                caller_creations.fetch_add(1, Ordering::SeqCst);
                anyhow::bail!("unexpected runtime creation after shutdown")
            })
        });
        waiting
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        shutdown_worker(exiting.begin_shutdown().unwrap()).unwrap();
        drop(exiting);
        let rejected = pending_start.join().unwrap().unwrap_err();
        assert!(rejected.to_string().contains("正在退出"));
        assert_eq!(creations.load(Ordering::SeqCst), 1);
        assert!(matches!(*state.lock().unwrap(), RuntimeState::ShuttingDown));
    }

    #[test]
    fn shutdown_of_an_idle_runtime_is_permanent_without_spawning_a_worker() {
        let mut state = RuntimeState::Idle;
        assert!(state.begin_shutdown().is_none());
        assert!(state.begin_shutdown().is_none());
        let rejected = state.commands_or_start(|| panic!("shutdown must not initialize a runtime"));
        assert!(rejected.unwrap_err().to_string().contains("正在退出"));
    }

    #[test]
    fn embedded_runtime_deduplicates_start_and_waits_for_cleanup_before_restarting() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let launched = Arc::new(AtomicUsize::new(0));
        let cleaned = Arc::new(AtomicUsize::new(0));
        let activations = Arc::new(AtomicUsize::new(0));
        let connections_dropped = Arc::new(AtomicUsize::new(0));
        struct ConnectionGuard(Arc<AtomicUsize>);
        impl Drop for ConnectionGuard {
            fn drop(&mut self) {
                self.0.fetch_add(1, Ordering::SeqCst);
            }
        }
        let runner: SessionRunner = {
            let launched = launched.clone();
            let cleaned = cleaned.clone();
            let connections_dropped = connections_dropped.clone();
            Arc::new(move |_, stop, ready| {
                let launched = launched.clone();
                let cleaned = cleaned.clone();
                let connections_dropped = connections_dropped.clone();
                Box::pin(async move {
                    // Rc 横跨 await，验证宿主无需把 ?Send hook future 送进多线程 executor。
                    let local = std::rc::Rc::new(1);
                    launched.fetch_add(*local, Ordering::SeqCst);
                    tokio::spawn(async move {
                        let _connection = ConnectionGuard(connections_dropped);
                        std::future::pending::<()>().await;
                    });
                    tokio::task::yield_now().await;
                    ready.send(Ok(())).unwrap();
                    let _ = stop.await;
                    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                    cleaned.fetch_add(*local, Ordering::SeqCst);
                })
            })
        };
        let activated = activations.clone();
        let worker = RuntimeWorker::spawn(
            runner,
            Arc::new(move |options, started_at_ms| {
                assert_eq!(options.debug_port, LaunchOptions::default().debug_port);
                assert_eq!(started_at_ms, 100);
                activated.fetch_add(1, Ordering::SeqCst);
                Box::pin(async { Ok(()) })
            }),
        )
        .unwrap();
        send_test_command(&worker, |reply| {
            test_start_command(LaunchOptions::default(), reply)
        })
        .unwrap();
        send_test_command(&worker, |reply| {
            test_start_command(
                LaunchOptions {
                    debug_port: 9999,
                    ..LaunchOptions::default()
                },
                reply,
            )
        })
        .unwrap();
        assert_eq!(launched.load(Ordering::SeqCst), 1);
        assert_eq!(activations.load(Ordering::SeqCst), 1);
        send_test_command(&worker, RuntimeCommand::Stop).unwrap();
        assert_eq!(cleaned.load(Ordering::SeqCst), 1);
        assert_eq!(connections_dropped.load(Ordering::SeqCst), 1);
        send_test_command(&worker, |reply| {
            test_start_command(LaunchOptions::default(), reply)
        })
        .unwrap();
        assert_eq!(launched.load(Ordering::SeqCst), 2);
        send_test_command(&worker, RuntimeCommand::Shutdown).unwrap();
        worker.thread.join().unwrap();
        assert_eq!(cleaned.load(Ordering::SeqCst), 2);
        assert_eq!(connections_dropped.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn embedded_runtime_can_stop_a_pending_session_without_exiting_the_gui_runtime() {
        let runner: SessionRunner = Arc::new(|_, stop, ready| {
            Box::pin(async move {
                let _ = stop.await;
                let _ = ready.send(Err(anyhow::anyhow!("cancelled")));
            })
        });
        let worker =
            RuntimeWorker::spawn(runner, Arc::new(|_, _| Box::pin(async { Ok(()) }))).unwrap();
        let (ready, pending) = mpsc::channel();
        worker
            .commands
            .send(test_start_command(LaunchOptions::default(), ready))
            .unwrap();
        send_test_command(&worker, RuntimeCommand::Stop).unwrap();
        assert_eq!(
            pending.recv().unwrap().unwrap_err().to_string(),
            "cancelled"
        );
        // 同一条命令通道仍可服务，不随 Codex session 生命周期退出。
        send_test_command(&worker, RuntimeCommand::Stop).unwrap();
        send_test_command(&worker, RuntimeCommand::Shutdown).unwrap();
        worker.thread.join().unwrap();
    }

    #[test]
    fn stop_waits_for_started_initialization_and_busy_does_not_start_another_session() {
        let (finish_initialization, initialization) = tokio::sync::oneshot::channel();
        let initialization = Arc::new(Mutex::new(Some(initialization)));
        let (entered, initializations) = mpsc::channel();
        let runner: SessionRunner = Arc::new(move |_, stop, ready| {
            let initialization = initialization.lock().unwrap().take().expect("one session");
            let entered = entered.clone();
            Box::pin(async move {
                entered.send(()).unwrap();
                initialization.await.unwrap();
                let _ = ready.send(Ok(()));
                let _ = stop.await;
            })
        });
        let worker =
            RuntimeWorker::spawn(runner, Arc::new(|_, _| Box::pin(async { Ok(()) }))).unwrap();
        let (ready, pending) = mpsc::channel();
        worker
            .commands
            .send(test_start_command(LaunchOptions::default(), ready))
            .unwrap();
        initializations
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        let busy = send_test_command(&worker, |reply| {
            test_start_command(LaunchOptions::default(), reply)
        })
        .unwrap_err();
        assert!(busy.is::<StartupBusy>());
        let (stopped, cleanup) = mpsc::channel();
        worker.commands.send(RuntimeCommand::Stop(stopped)).unwrap();
        assert!(matches!(cleanup.try_recv(), Err(mpsc::TryRecvError::Empty)));
        finish_initialization.send(()).unwrap();
        pending
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap()
            .unwrap();
        cleanup
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap()
            .unwrap();
        send_test_command(&worker, RuntimeCommand::Shutdown).unwrap();
        worker.thread.join().unwrap();
    }

    #[test]
    fn launch_failure_keeps_request_identity_and_does_not_overwrite_a_newer_start() {
        let temp = tempfile::tempdir().unwrap();
        let options = LaunchOptions {
            app_dir: Some(PathBuf::from("/test/Codex.app")),
            debug_port: 9333,
            status_store: codex_plus_core::status::StatusStore::new(
                temp.path().join("latest.json"),
            ),
            ..LaunchOptions::default()
        };
        let request = LaunchStatus {
            status: "starting".into(),
            started_at_ms: 100,
            ..LaunchStatus::default()
        };
        options.status_store.save_latest(&request).unwrap();
        record_launch_failure(&options, 99, &anyhow::anyhow!("old failure"));
        assert_eq!(
            options.status_store.load_latest().unwrap().unwrap(),
            request
        );
        record_launch_failure(&options, 100, &anyhow::anyhow!("launch failed"));
        let failed = options.status_store.load_latest().unwrap().unwrap();
        assert_eq!(failed.status, "failed");
        assert_eq!(failed.started_at_ms, 100);
        assert_eq!(failed.debug_port, Some(9333));
        assert_eq!(failed.codex_app, Some("/test/Codex.app".into()));
    }

    #[test]
    fn manual_service_stop_marks_its_session_stopped_without_overwriting_new_requests() {
        let temp = tempfile::tempdir().unwrap();
        let store = codex_plus_core::status::StatusStore::new(temp.path().join("latest.json"));
        let running = LaunchStatus {
            status: "running".into(),
            started_at_ms: 100,
            debug_port: Some(9333),
            phase: Some("ready".into()),
            progress: Some(100),
            ..LaunchStatus::default()
        };
        store.save_latest(&running).unwrap();
        assert!(save_stopped_service_status_if_current(&store, 100).unwrap());
        let stopped = store.load_latest().unwrap().unwrap();
        assert_eq!(stopped.status, "stopped");
        assert_eq!(stopped.started_at_ms, 100);
        assert_eq!(stopped.debug_port, Some(9333));
        assert!(stopped.message.contains("后台增强服务已停止"));
        assert!(stopped.message.contains("未关闭官方 Codex"));
        assert_eq!(stopped.phase, None);
        assert_eq!(stopped.progress, None);
        assert!(!save_stopped_service_status_if_current(&store, 100).unwrap());
        assert_eq!(store.load_latest().unwrap().unwrap(), stopped);

        for status in ["starting", "stopping"] {
            let next_request = LaunchStatus {
                status: status.into(),
                started_at_ms: 200,
                phase: Some("stop_processes".into()),
                ..LaunchStatus::default()
            };
            store.save_latest(&next_request).unwrap();
            assert!(!save_stopped_service_status_if_current(&store, 100).unwrap());
            assert_eq!(store.load_latest().unwrap().unwrap(), next_request);
        }
    }

    #[tokio::test]
    async fn navigation_routes_show_the_same_embedded_gui_window() {
        let navigations = Arc::new(Mutex::new(Vec::new()));
        let received = navigations.clone();
        set_navigation_handler(move |payload| {
            received.lock().unwrap().push(payload);
            Ok(())
        });
        let runtime = LauncherRuntimeService::new(9229, default_user_script_manager());
        runtime.open_manager(json!({})).await.unwrap();
        runtime.open_transient_manager(json!({})).await.unwrap();
        assert_eq!(*navigations.lock().unwrap(), vec![json!({}), json!({})]);
        *NAVIGATION_HANDLER.get().unwrap().lock().unwrap() = None;
    }

    #[tokio::test]
    async fn launcher_hooks_forward_native_fast_instead_of_using_the_default_noop() {
        let hooks = LauncherHooks::default();
        // 没有 CDP 端点时核心实现会返回错误；trait 默认的空实现则错误地成功。
        let result = hooks.apply_native_module_patches_on_launch(0).await;
        assert!(
            result.is_err(),
            "native Fast hook must reach the core launcher"
        );
    }

    #[tokio::test]
    async fn background_recovery_does_not_apply_or_reload_native_fast() {
        let hooks = LauncherHooks {
            attach_only: true,
            ..LauncherHooks::default()
        };
        // 后台恢复不访问 CDP，因此相同的不可用端点也应成功跳过。
        hooks
            .apply_native_module_patches_on_launch(0)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn watchdog_reuses_bridge_context_with_data_service() {
        let test_dir = std::env::temp_dir().join(format!(
            "codex-plus-launcher-watchdog-test-{}",
            std::process::id()
        ));
        let hooks = LauncherHooks {
            attach_only: false,
            core: Arc::new(DefaultLaunchHooks::default()),
            data: Arc::new(LauncherDataService {
                db_path: test_dir.join("state.sqlite"),
                backup_dir: test_dir.join("backups"),
            }),
            runtime: Arc::new(LauncherRuntimeService::new(
                9229,
                UserScriptManager::new(
                    test_dir.join("builtin"),
                    test_dir.join("user"),
                    test_dir.join("settings.json"),
                ),
            )),
            bridge_context: Arc::new(Mutex::new(None)),
            browser_monitor: Arc::new(Mutex::new(None)),
            session_state: None,
        };

        hooks.bridge_context(9229, &test_dir).await.unwrap();
        let ctx = hooks.watchdog_bridge_context().unwrap();
        let result =
            codex_plus_core::routes::handle_bridge_request(ctx, "/backend/status", json!({})).await;

        assert_ne!(result["message"], "Unknown bridge path");
    }
}
