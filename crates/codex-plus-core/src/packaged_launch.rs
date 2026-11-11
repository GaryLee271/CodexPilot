//! Windows Codex 的 MSIX 包上下文启动与进程就绪判定。
//! AUMID 激活失败时，可在包上下文中启动原生 Codex，并保留其默认数据目录。
//! 纯脚本与进程判定有跨平台测试；激活路径仅在 Windows 可用。

use std::path::{Path, PathBuf};
#[cfg(windows)]
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::{Context, bail};

/// `Invoke-CommandInDesktopPackage` 没有报回进程 PID 时的返回值。
///
/// 该 cmdlet 的返回值不是文档化契约（见模块头），调用方不能把它当成 Codex 应用进程：
/// 真正的应用进程要用「谁在监听调试端口」去发现（launcher 已有 `capture_debug_listener`）。
pub const UNKNOWN_PROCESS_ID: u32 = 0;

/// 激活命令的整体超时。powershell 正常是秒级返回；卡死说明环境异常，交给 fallback。
///
/// 必须大于 [`HOST_PORT_WAIT_SECS`]：要求 PowerShell 宿主等端口时，它最多多活这么久。
#[cfg(windows)]
const ACTIVATION_TIMEOUT: Duration = Duration::from_secs(30);

/// 要求 PowerShell 宿主等待调试端口时的上限（秒），见 [`activation_script`]。
pub const HOST_PORT_WAIT_SECS: u64 = 20;

/// 不能从 Codex Pilot 进程一路继承给 Codex 的环境变量（issue #2764）。
///
/// AUMID 激活（开始菜单同款）由系统代为创建进程，拿的是用户默认环境；包上下文兜底则是
/// Codex Pilot → powershell → cmd → Codex 逐级继承，Codex Pilot 进程环境里的东西会被带进 Codex。
/// 这里只列「会让 Electron 不按桌面应用启动」的运行时开关：
/// - `ELECTRON_RUN_AS_NODE`：exe 退化成 Node，遇到 `--remote-debugging-port` 直接报错退出；
/// - `ELECTRON_NO_ASAR`：关掉 asar 支持，应用包读不出来；
/// - `NODE_OPTIONS`：主进程按它预加载脚本 / 解析 Node 参数，非法值直接退出。
///
/// `CODEX_HOME` / `CODEX_PLUS_STATE_DIR` 等**不**在此列：用户有意设置时，开始菜单启动的
/// Codex 同样看得到它们，清掉反而让两条启动路径不一致。
pub const SCRUBBED_CODEX_ENV_VARS: [&str; 3] =
    ["ELECTRON_RUN_AS_NODE", "ELECTRON_NO_ASAR", "NODE_OPTIONS"];

/// 当前环境里出现了哪些需要清掉的变量。只返回变量名、不读值，供诊断日志使用。
pub fn present_scrubbed_env_vars(is_set: impl Fn(&str) -> bool) -> Vec<&'static str> {
    SCRUBBED_CODEX_ENV_VARS
        .iter()
        .copied()
        .filter(|name| is_set(name))
        .collect()
}

/// wrapper 里清掉 [`SCRUBBED_CODEX_ENV_VARS`]：不管 cmd 从哪条链继承了环境，
/// `start` 出来的 Codex 都拿不到这些开关。`set "X="` 在 cmd 里就是删除变量。
fn push_env_scrub_lines(script: &mut String) {
    for name in SCRUBBED_CODEX_ENV_VARS {
        script.push_str(&format!("set \"{name}=\"\r\n"));
    }
}

/// Chromium「提权启动时自动降权重启」的豁免开关（issue #2789 #2764）。
///
/// Chromium 在 Windows 上发现浏览器进程以「拆分令牌的提权部分」运行（UAC 开启、管理员
/// 「以管理员身份运行」）时，会经 `base::win::RunDeElevated` 由 explorer 以普通权限重新
/// 拉起自己并让当前进程退出，重启出来的进程带上本开关防止循环（`chrome_main_delegate.cc`
/// 的 `MaybeAutoDeElevate`，开关定义在 `chrome/common/chrome_switches.h` 的
/// `kDoNotDeElevateOnLaunch`）。Codex 的 Windows 版基于含 chrome 层的 Chromium 外壳，
/// 主进程 JS 也在读这个开关（`hasDoNotDeElevateSwitch`），说明这条逻辑在 Codex 里生效。
///
/// 对 Codex Pilot 的影响：Codex Pilot 被以管理员身份运行时，包上下文 wrapper 拉起的 Codex 继承
/// 提权令牌，Chromium 随即经 explorer 降权重启——重启出来的进程不再处于 MSIX 包上下文
/// （没有包身份），也拿不到 wrapper 设置的环境；表现就是「出现过 1 个 Codex 进程，随后
/// 一个不剩、调试端口始终不监听」。所以 Codex Pilot 提权时显式带上本开关，让 Codex 留在
/// 包上下文里启动（与 Codex Pilot 同权限）。未提权时 Chromium 本来就不会降权，不加。
pub const DO_NOT_DE_ELEVATE_SWITCH: &str = "--do-not-de-elevate";

/// 打包版主实例的启动附加参数：Codex Pilot 提权运行时补上 [`DO_NOT_DE_ELEVATE_SWITCH`]
/// （纯函数）。用户自己已经写了该开关时不重复添加；未提权时原样返回。
pub fn packaged_launch_extra_args(extra_args: &[String], elevated: bool) -> Vec<String> {
    let mut args = extra_args.to_vec();
    let already_present = args.iter().any(|arg| {
        arg.trim()
            .split('=')
            .next()
            .is_some_and(|name| name.eq_ignore_ascii_case(DO_NOT_DE_ELEVATE_SWITCH))
    });
    if elevated && !already_present {
        args.push(DO_NOT_DE_ELEVATE_SWITCH.to_string());
    }
    args
}

/// `IApplicationActivationManager::ActivateApplication` 的调用上限（issue #2795）。
///
/// 正常几秒内返回。#2795 的日志停在 `launch_codex` 阶段十几分钟没有下文，同时任务管理器里
/// 有一个「已挂起」、内存 0.1 MB 的 Codex 进程——激活调用原先没有超时，一旦卡住 Codex Pilot
/// 就一直停在「启动 Codex」、没有任何报错。超过上限即放弃本次激活并给出提示。
pub const AUMID_ACTIVATION_CALL_TIMEOUT: Duration = Duration::from_secs(20);

/// AUMID 激活调用超时（见 [`AUMID_ACTIVATION_CALL_TIMEOUT`]），供调用方 `downcast_ref` 区分。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AumidActivationTimedOut {
    pub seconds: u64,
}

impl std::fmt::Display for AumidActivationTimedOut {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Windows 激活 Codex（ActivateApplication）{} 秒内没有返回",
            self.seconds
        )
    }
}

impl std::error::Error for AumidActivationTimedOut {}

/// AUMID 激活调用超时后给用户看的提示（纯函数）。
pub fn aumid_activation_timed_out_message(seconds: u64, executable_name: &str) -> String {
    format!(
        "启动 Codex 失败：Windows 激活 Codex {seconds} 秒内没有返回。\
         可能是系统里残留了「已挂起」的 Codex 进程（任务管理器「进程」页里 ChatGPT / Codex \
         状态显示为已挂起、内存只有零点几 MB）。请在任务管理器「详细信息」页结束所有 \
         {executable_name} 进程（或注销 / 重启电脑）后，再点「启动 Codex」。"
    )
}

/// CDP 就绪轮询间隔。
const READY_POLL_INTERVAL: Duration = Duration::from_millis(250);

/// 包上下文启动的结果。
///
/// 本模块不持有全局状态，字段由调用方组装/读取。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackagedContextLaunch {
    /// 实际使用的 AUMID（`<PackageFamilyName>!<AppId>`）。
    pub app_user_model_id: String,
    /// 写在实例目录里的 wrapper 脚本路径。
    pub wrapper_path: PathBuf,
    /// 激活时 cmdlet 报回的 PID；报不回来时是 `Some`/`None` 由调用方决定如何填，
    /// 见 [`PackagedContextLaunch::known_process_id`] 与 [`UNKNOWN_PROCESS_ID`]。
    pub process_id: Option<u32>,
}

impl PackagedContextLaunch {
    /// 只有拿到真实 PID 时才返回 `Some`：用于过滤 cmdlet 未报回时的哨兵值。
    pub fn known_process_id(&self) -> Option<u32> {
        self.process_id.filter(|id| *id != UNKNOWN_PROCESS_ID)
    }
}

/// 拆出 AUMID 里的 PackageFamilyName 与 Application Id。
///
/// AUMID 的形状是 `<PackageFamilyName>!<AppId>`（见 `app_paths::packaged_app_user_model_id`）。
/// 这里只做形状校验，不查系统里的注册状态——「包是否已注册」由调用方在解析 AUMID 时确认
/// （`app_paths::packaged_app_user_model_id` 会查 `GetPackagesByPackageFamily`，拿未注册包的
/// AUMID 去激活会报 0x80073CF1，见 issue #2140）。
pub fn split_app_user_model_id(app_user_model_id: &str) -> anyhow::Result<(String, String)> {
    let trimmed = app_user_model_id.trim();
    let Some((package_family_name, app_id)) = trimmed.split_once('!') else {
        bail!("AUMID 缺少 `!` 分隔符（期望 `<PackageFamilyName>!<AppId>`）：{trimmed}");
    };
    if package_family_name.is_empty() || app_id.is_empty() || app_id.contains('!') {
        bail!("AUMID 形状不合法（期望 `<PackageFamilyName>!<AppId>`）：{trimmed}");
    }
    Ok((package_family_name.to_string(), app_id.to_string()))
}

/// Codex 包上下文启动脚本文件名。
pub const MAIN_WRAPPER_FILE_NAME: &str = "packaged-launch-main.cmd";

/// 生成 Codex 包上下文启动脚本，作为 AUMID 激活失败后的兜底。
/// 保留原生数据目录，参数使用 AUMID 激活时相同的调试与附加参数。
pub fn build_main_instance_wrapper_script(
    executable: &Path,
    args: &[String],
) -> anyhow::Result<String> {
    let executable_literal = batch_path_literal(executable)?;
    let executable_dir = executable
        .parent()
        .filter(|dir| !dir.as_os_str().is_empty())
        .map(batch_path_literal)
        .transpose()?;
    let arguments = args
        .iter()
        .map(|arg| batch_argument_literal(arg))
        .collect::<anyhow::Result<Vec<_>>>()?;

    let mut script = String::new();
    script.push_str("@echo off\r\n");
    script.push_str("setlocal\r\n");
    // issue #2764：包上下文里的 cmd 输出拿不到，失败时分不清「wrapper 根本没执行」还是
    // 「start 执行了但 Codex 起来又退了」。这里只往 wrapper 旁写两行轨迹（时间 + start 的
    // errorlevel），不重定向 start 那一行，Codex 的标准输出/错误与原来一致。
    // `%~dpn0` 是本脚本去掉扩展名的完整路径，不用把路径（可能含中文）写进脚本。
    script.push_str(&format!(
        ">\"%~dpn0{MAIN_WRAPPER_TRACE_SUFFIX}\" echo [%DATE% %TIME%] wrapper started\r\n"
    ));
    push_env_scrub_lines(&mut script);
    if let Some(dir) = executable_dir {
        // 与多开 wrapper 一致：尽力切到 exe 所在目录，失败时 cmd 继续执行下一行。
        script.push_str(&format!("cd /d \"{dir}\"\r\n"));
    }
    let mut start_line = format!("start \"\" /b \"{executable_literal}\"");
    for argument in &arguments {
        start_line.push(' ');
        start_line.push_str(argument);
    }
    script.push_str(&start_line);
    script.push_str("\r\n");
    script.push_str(&format!(
        ">>\"%~dpn0{MAIN_WRAPPER_TRACE_SUFFIX}\" echo [%DATE% %TIME%] start errorlevel=%ERRORLEVEL%\r\n"
    ));
    script.push_str("endlocal\r\n");
    Ok(script)
}

/// 主实例 wrapper 轨迹文件的后缀：`packaged-launch-main.cmd` → `packaged-launch-main.trace.log`。
const MAIN_WRAPPER_TRACE_SUFFIX: &str = ".trace.log";

/// 主实例 wrapper 写下的执行轨迹（见 [`build_main_instance_wrapper_script`]）。
pub fn main_wrapper_trace_path(wrapper_path: &Path) -> PathBuf {
    wrapper_path.with_extension(MAIN_WRAPPER_TRACE_SUFFIX.trim_start_matches('.'))
}

/// 读取本次启动写下的 wrapper 轨迹供诊断日志使用（只截取有限长度）。
///
/// 文件不存在、或修改时间早于 `written_since`（上一次留下的）都返回 `None`，
/// 即「这次 wrapper 没有执行到第一行」。
pub fn read_main_wrapper_trace(
    wrapper_path: &Path,
    written_since: std::time::SystemTime,
) -> Option<String> {
    let path = main_wrapper_trace_path(wrapper_path);
    let modified = std::fs::metadata(&path).ok()?.modified().ok()?;
    // 文件系统时间精度有限（FAT 2 秒），留一点余量。
    let threshold = written_since
        .checked_sub(Duration::from_secs(2))
        .unwrap_or(written_since);
    if modified < threshold {
        return None;
    }
    let bytes = std::fs::read(&path).ok()?;
    Some(truncate_chars(
        String::from_utf8_lossy(&bytes).trim(),
        ACTIVATION_OUTPUT_LIMIT,
    ))
}

/// 包上下文兜底没等到端口时，把观察结果压成一句话放进报错（纯函数）。
///
/// `new_process_ids`：宿主观察期间新出现过的 Codex 进程（`None` 表示没观察到结果）；
/// `wrapper_ran`：本次 wrapper 是否写下了轨迹。
pub fn package_context_launch_observation(
    new_process_ids: Option<&[u32]>,
    wrapper_ran: bool,
) -> String {
    let wrapper = if wrapper_ran {
        "wrapper 已执行"
    } else {
        "未见 wrapper 执行轨迹"
    };
    match new_process_ids {
        Some([]) => format!("{wrapper}，期间未出现新的 Codex 进程"),
        Some(ids) => format!("{wrapper}，期间出现过 {} 个新 Codex 进程", ids.len()),
        None => wrapper.to_string(),
    }
}

/// 已在运行的同名 Codex 进程，按命令行归类（issue #2764）。
///
/// Codex（Electron）同一份用户数据目录只允许一个主进程：新启动的进程拿不到单实例锁时，
/// 会把命令行转交给已有主进程后立即退出。主 Codex 已经从开始菜单 / 托盘开着、却没带本次
/// 的调试端口时，AUMID 激活与包上下文兜底拉起的进程都会这样秒退，调试端口永远等不到。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExistingCodexProcess {
    /// Electron 子进程（renderer / gpu / utility / crashpad，命令行带 `--type=`）。
    Child,
    /// 带 `--user-data-dir` 的隔离实例（多开）：单实例锁各自独立，不挡主实例。
    IsolatedInstance,
    /// 主实例，且已带本次要用的调试端口：交给原有流程复用。
    MainWithDebugPort,
    /// 主实例，没带本次调试端口（没带或带的是别的端口）：新启动会被它接管后退出。
    MainWithoutDebugPort,
    /// 命令行读不到：无法判断，按不阻挡处理。
    Unknown,
}

/// 按命令行给已在运行的 Codex 进程归类（纯函数）。
#[cfg(any(windows, test))]
pub fn classify_existing_codex_process(
    command_line: Option<&str>,
    debug_port: u16,
) -> ExistingCodexProcess {
    let Some(command_line) = command_line else {
        return ExistingCodexProcess::Unknown;
    };
    let mut tokens = command_line
        .split_whitespace()
        .map(|token| token.trim_matches('"'));
    if tokens.clone().any(|token| token.starts_with("--type=")) {
        return ExistingCodexProcess::Child;
    }
    if tokens.any(|token| token.starts_with("--user-data-dir")) {
        return ExistingCodexProcess::IsolatedInstance;
    }
    if crate::watcher::debug_port_from_command_line(command_line) == Some(debug_port) {
        ExistingCodexProcess::MainWithDebugPort
    } else {
        ExistingCodexProcess::MainWithoutDebugPort
    }
}

/// 会挡住本次带调试端口启动的主实例进程 PID（纯逻辑，读命令行通过参数注入）。
///
/// 只认「确定是没带本次端口的主进程」：命令行读不到、子进程、多开实例都不算，宁漏不误——
/// 误判的代价是用户明明能启动却被拦下。本次启动自带 `--user-data-dir`（用户在附加参数里
/// 指定了数据目录）时，与默认目录的主实例不共用单实例锁，直接返回空。
#[cfg(any(windows, test))]
pub fn main_instances_blocking_debug_launch(
    candidates: impl IntoIterator<Item = u32>,
    debug_port: u16,
    launch_args: &[String],
    mut command_line: impl FnMut(u32) -> Option<String>,
) -> Vec<u32> {
    if launch_args
        .iter()
        .any(|arg| arg.trim_start_matches('"').starts_with("--user-data-dir"))
    {
        return Vec::new();
    }
    let mut ids = candidates
        .into_iter()
        .filter(|process_id| {
            classify_existing_codex_process(command_line(*process_id).as_deref(), debug_port)
                == ExistingCodexProcess::MainWithoutDebugPort
        })
        .collect::<Vec<_>>();
    ids.sort_unstable();
    ids.dedup();
    ids
}

/// 两个 exe 路径是否属于同一个 MSIX 包族（同名 + 同发布者，版本 / 架构可以不同）。
///
/// 只按 exe 名匹配会把另装的 ChatGPT 桌面版（同样叫 `ChatGPT.exe`、单实例锁互不相干）
/// 也当成 Codex；更新后旧版本目录里还在跑的 Codex 则应当算同一个包族。
/// 任一路径不在 `WindowsApps` 下或解析不出包全名时返回 false（宁漏不误）。
pub fn same_windows_apps_package_family(left: &str, right: &str) -> bool {
    match (
        windows_apps_package_family(left),
        windows_apps_package_family(right),
    ) {
        (Some(left), Some(right)) => left == right,
        _ => false,
    }
}

/// 从 `…\WindowsApps\<Name>_<Version>_<Arch>_<ResourceId>_<PublisherId>\…` 取出
/// `(name, publisher_id)`（小写）。包名本身不含 `_`。
fn windows_apps_package_family(path: &str) -> Option<(String, String)> {
    let normalized = path.replace('/', "\\").to_ascii_lowercase();
    let (_, after) = normalized.split_once("\\windowsapps\\")?;
    let package_full_name = after.split('\\').next()?;
    let segments = package_full_name.split('_').collect::<Vec<_>>();
    if segments.len() < 5 {
        return None;
    }
    let name = segments.first()?.to_string();
    let publisher_id = segments.last()?.to_string();
    (!name.is_empty() && !publisher_id.is_empty()).then_some((name, publisher_id))
}

/// 已有主实例挡住启动时给用户看的提示。
pub fn existing_main_instance_blocks_launch_message(
    debug_port: u16,
    executable_name: &str,
    process_ids: &[u32],
) -> String {
    let ids = process_ids
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "检测到 Codex 已在运行，但没有开启调试端口 {debug_port}（主进程 PID {ids}）。\
         Codex 同时只允许一个主实例，Codex Pilot 再启动的实例会把请求交给它后立即退出，无法注入。\
         请先完全退出 Codex：关掉窗口后若托盘里还有 Codex 图标，右键选择退出；\
         或在任务管理器里结束所有 {executable_name} 进程。然后再点「启动 Codex」。\
         也可以点「重启 Codex」，由 Codex Pilot 结束它并重新启动。"
    )
}

/// 挡路主进程退出后，可以顺带清理的残留进程（纯逻辑，平台调用全部注入；issue #2764 后续）。
///
/// 「重启 Codex」只结束检测认定的主进程本身，不按进程树（`taskkill /T`）结束：从 Codex
/// 里打开的 VS Code、浏览器、Agent 起的 dev server 等都挂在它的进程树下，不能一起杀掉。
/// Electron 子进程正常会随主进程退出；万一有残留，只允许清理这里返回的进程：
///
/// - 从 `target` 出发、只经过「可清理」的进程向下走：遇到不可清理的进程（终端、编辑器、
///   浏览器……）就停下，它和它的整棵子树都不碰；
/// - 每条父子边都要用创建时间证实（子进程不早于父进程创建），防 PID 复用把无关进程算进来；
/// - `may_clean` 由调用方按 [`may_clean_up_after_blocking_main_instance`] 判断。
///
/// `processes` 是进程快照里的 `(pid, 父 pid)`，`birth` 读进程创建时间（读不到返回 `None`）。
/// 返回值已排序、去重，不含 `target` 本身。
#[cfg(any(windows, test))]
pub fn blocking_main_instance_leftovers(
    target: u32,
    processes: &[(u32, u32)],
    mut birth: impl FnMut(u32) -> Option<u64>,
    mut may_clean: impl FnMut(u32) -> bool,
) -> Vec<u32> {
    if target == 0 {
        return Vec::new();
    }
    let mut visited = std::collections::HashSet::from([target]);
    let mut queue = std::collections::VecDeque::from([target]);
    let mut leftovers = Vec::new();
    while let Some(parent) = queue.pop_front() {
        let parent_birth = birth(parent);
        for &(process_id, parent_process_id) in processes {
            if parent_process_id != parent || process_id == 0 || visited.contains(&process_id) {
                continue;
            }
            let verified_child = match (parent_birth, birth(process_id)) {
                (Some(parent_birth), Some(child_birth)) => child_birth >= parent_birth,
                _ => false,
            };
            if !verified_child || !may_clean(process_id) {
                continue;
            }
            visited.insert(process_id);
            queue.push_back(process_id);
            leftovers.push(process_id);
        }
    }
    leftovers.sort_unstable();
    leftovers
}

/// 挡路主进程退出后残留的某个进程能否由 Codex Pilot 结束（纯函数）。
///
/// 只认同一 MSIX 包内的 Codex 自家进程：
/// - 与 Codex 同名（`ChatGPT.exe`）的 Electron 子进程（命令行带 `--type=`）；
/// - 包内自带的 `codex.exe`（Codex 拉起的 app-server）。
///
/// 路径读不到、不在同一包族（另装的 ChatGPT 桌面版、用户自己装的 codex CLI）、
/// 同名但不是子进程（多开实例、别的主进程、读不到命令行）、其他任何程序一律不碰。
#[cfg(any(windows, test))]
pub fn may_clean_up_after_blocking_main_instance(
    exe_file: &str,
    executable_path: Option<&str>,
    command_line: Option<&str>,
    codex_executable: &str,
) -> bool {
    if !executable_path.is_some_and(|path| same_windows_apps_package_family(path, codex_executable))
    {
        return false;
    }
    let codex_file_name = codex_executable
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or(codex_executable);
    if exe_file.eq_ignore_ascii_case(codex_file_name) {
        return classify_existing_codex_process(command_line, 0) == ExistingCodexProcess::Child;
    }
    exe_file.eq_ignore_ascii_case("codex.exe")
}

/// 等待期过后仍需强制结束的进程（纯函数，读创建时间通过参数注入）。
///
/// `recorded` 是动手前记下的 `(pid, 创建时间)`，调用方只传仍在运行的那些。等待期间
/// 原进程可能已退出、PID 被别的进程复用：记录过创建时间的，必须与现在读到的一致才算
/// 同一个进程；当时就读不到创建时间的（只有主进程本身可能出现）保持原判断。
#[cfg(any(windows, test))]
pub fn processes_still_to_force_stop(
    recorded: &[(u32, Option<u64>)],
    mut birth: impl FnMut(u32) -> Option<u64>,
) -> Vec<u32> {
    recorded
        .iter()
        .filter(|(process_id, recorded_birth)| match recorded_birth {
            Some(recorded_birth) => birth(*process_id) == Some(*recorded_birth),
            None => true,
        })
        .map(|(process_id, _)| *process_id)
        .collect()
}

/// [`build_main_instance_wrapper_script`] + 写入 `<state_dir>/packaged-launch-main.cmd`。
pub fn prepare_main_instance_wrapper(
    state_dir: &Path,
    executable: &Path,
    args: &[String],
) -> anyhow::Result<PathBuf> {
    let script = build_main_instance_wrapper_script(executable, args)?;
    std::fs::create_dir_all(state_dir)
        .with_context(|| format!("创建状态目录失败：{}", state_dir.display()))?;
    let path = state_dir.join(MAIN_WRAPPER_FILE_NAME);
    std::fs::write(&path, script.as_bytes())
        .with_context(|| format!("写入主实例包上下文 wrapper 失败：{}", path.display()))?;
    Ok(path)
}

/// 单个命令行参数写进 `.cmd` 的字面量。
///
/// `%` 写成 `%%`；含空白或 cmd 元字符（`& | < > ^ ( )`）时整体加双引号，避免被 cmd 当成
/// 管道/重定向。参数里的双引号与换行无法安全转义，直接拒绝。
fn batch_argument_literal(arg: &str) -> anyhow::Result<String> {
    if arg.contains('"') || arg.contains('\r') || arg.contains('\n') || arg.contains('\0') {
        bail!("启动参数包含无法写进启动脚本的字符（引号或换行）：{arg}");
    }
    let escaped = arg.replace('%', "%%");
    let needs_quotes = escaped.is_empty()
        || escaped
            .chars()
            .any(|ch| ch.is_whitespace() || matches!(ch, '&' | '|' | '<' | '>' | '^' | '(' | ')'));
    Ok(if needs_quotes {
        format!("\"{escaped}\"")
    } else {
        escaped
    })
}

/// AUMID 激活后的验证窗口：窗口内既没开放调试端口、激活进程也一直活着，就不再判定，
/// 交回原有注入流程（保持旧行为）。
pub const AUMID_ACTIVATION_VERIFY_WINDOW: Duration = Duration::from_secs(15);

/// 激活进程退出后，再给调试端口这么久的出现时间才判定激活失败：
/// 防止「中转进程退出、真正进程稍后才监听」被误判。
pub const AUMID_ACTIVATION_EXIT_GRACE: Duration = Duration::from_secs(2);

/// AUMID 激活后单次观察的结论。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AumidActivationVerdict {
    /// 调试端口已就绪，激活成功。
    Ready,
    /// 继续观察。
    Pending,
    /// 激活进程已退出且调试端口始终没出现：改用包上下文 wrapper 启动（issue #2700）。
    FallbackToPackageContext,
    /// 窗口耗尽但进程仍在（或无法判断）：不回退，交回原有注入流程，避免双开。
    Inconclusive,
}

/// AUMID 激活结果的判定器（纯逻辑，时间由调用方注入，可在任意平台单测）。
///
/// `process_alive` 为 `None` 表示这一轮无法判断激活进程是否存活；无法判断时绝不回退，
/// 只按窗口耗尽处理。
#[derive(Debug, Clone)]
pub struct AumidActivationWatch {
    started_at: Instant,
    exited_since: Option<Instant>,
}

impl AumidActivationWatch {
    pub fn new(started_at: Instant) -> Self {
        Self {
            started_at,
            exited_since: None,
        }
    }

    pub fn observe(
        &mut self,
        now: Instant,
        cdp_ready: bool,
        process_alive: Option<bool>,
    ) -> AumidActivationVerdict {
        if cdp_ready {
            return AumidActivationVerdict::Ready;
        }
        match process_alive {
            Some(false) => {
                let since = *self.exited_since.get_or_insert(now);
                if now.saturating_duration_since(since) >= AUMID_ACTIVATION_EXIT_GRACE {
                    return AumidActivationVerdict::FallbackToPackageContext;
                }
                // 已确认退出时不受总窗口限制，等退出宽限走完再给结论。
                return AumidActivationVerdict::Pending;
            }
            Some(true) => self.exited_since = None,
            None => {}
        }
        if now.saturating_duration_since(self.started_at) >= AUMID_ACTIVATION_VERIFY_WINDOW {
            AumidActivationVerdict::Inconclusive
        } else {
            AumidActivationVerdict::Pending
        }
    }
}

/// 拼出在包上下文里执行 wrapper 的 PowerShell 脚本（纯函数，可在 macOS 上单测）。
///
/// 核心是
/// `Invoke-CommandInDesktopPackage -PackageFamilyName '<PFN>' -AppId '<AppId>' -Command 'cmd.exe'
/// -Args '/d /c "<wrapper>"' -PreventBreakaway`，外加：
/// - 前置 `$ErrorActionPreference = 'Stop'`：失败要变成非零退出码，否则会被当成激活成功；
/// - 输出 UTF-8 并打 `HOST=` 标记（PowerShell 版本 / 是否 64 位），cmdlet 抛错时打 `ERROR=`
///   标记（异常类型、HRESULT、消息）后 `exit 1`，下次失败能直接从日志看出原因（issue #2747）；
/// - 仅在 cmdlet 真报回 `Id` 时输出 `PID=` 标记；
/// - `wait_port` 为 `Some` 时，PowerShell 宿主激活后继续存活，直到该回环端口可连接或
///   [`HOST_PORT_WAIT_SECS`] 秒耗尽，再输出 `PORT_READY=1/0`。issue #2764 的对照实验里，
///   同一份 wrapper 在「宿主一直存活」的交互式 PowerShell 里能拉起 Codex，而 Codex Pilot 的宿主
///   激活后立刻退出；这里让宿主活过 Codex 的启动阶段，与可用的形态保持一致。
///
/// 所有动态值都走 PowerShell 单引号字面量，内部的 `'` 按 `''` 转义。
/// 只做形状校验与转义，不查注册表、不碰系统状态。
pub fn activation_script(
    app_user_model_id: &str,
    wrapper_path: &Path,
    wait_port: Option<u16>,
) -> anyhow::Result<String> {
    activation_script_watching(app_user_model_id, wrapper_path, wait_port, None)
}

/// 同 [`activation_script`]；`watch_process` 为进程名（不带 `.exe`）时，宿主等端口期间
/// 顺带记下见过的同名进程，最后输出 `SEEN_PIDS=`（issue #2764：区分「Codex 根本没起来」
/// 与「起来后又退了」）。不等端口时忽略。
pub fn activation_script_watching(
    app_user_model_id: &str,
    wrapper_path: &Path,
    wait_port: Option<u16>,
    watch_process: Option<&str>,
) -> anyhow::Result<String> {
    let (package_family_name, app_id) = split_app_user_model_id(app_user_model_id)?;
    activation_script_for(
        &package_family_name,
        &app_id,
        wrapper_path,
        wait_port,
        watch_process,
    )
}

fn activation_script_for(
    package_family_name: &str,
    app_id: &str,
    wrapper_path: &Path,
    wait_port: Option<u16>,
    watch_process: Option<&str>,
) -> anyhow::Result<String> {
    let package_family_name = powershell_literal(package_family_name)?;
    let app_id = powershell_literal(app_id)?;
    let wrapper = powershell_literal(&path_text(wrapper_path)?)?;
    let watch_process = watch_process
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(powershell_literal)
        .transpose()?;

    let mut script = String::new();
    // cmdlet 报错时让 powershell.exe 以非零码退出；否则「激活失败」会被当成成功，调用方
    // 就不会走 fallback，用户侧表现是点了没反应。
    script.push_str("$ErrorActionPreference = 'Stop'; ");
    // 输出重定向到日志文件时默认按 OEM 代码页编码，中文错误会变乱码；设置失败也不影响激活。
    script.push_str("try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}; ");
    script.push_str("\"HOST=$($PSVersionTable.PSVersion);X64=$([Environment]::Is64BitProcess)\"; ");
    script.push_str("try { $created = Invoke-CommandInDesktopPackage ");
    script.push_str(&format!(
        "-PackageFamilyName '{package_family_name}' -AppId '{app_id}' "
    ));
    script.push_str("-Command 'cmd.exe' ");
    script.push_str(&format!("-Args '/d /c \"{wrapper}\"' "));
    script.push_str("-PreventBreakaway } ");
    script.push_str(
        "catch { \"ERROR=$($_.Exception.GetType().FullName) \
         0x$('{0:X8}' -f $_.Exception.HResult): $($_.Exception.Message)\"; exit 1 }; ",
    );
    // 返回值不是文档化契约（见模块头）：只有真报回带 Id 的对象时才输出 PID 标记，
    // 解析侧只认这个前缀，避免把无关数字当成 PID。
    script.push_str("if ($created -and $created.Id) { \"PID=$($created.Id)\" }");
    if let Some(port) = wait_port.filter(|port| *port != 0) {
        // 等端口期间每轮记下同名进程（只诊断用，失败不影响激活）。
        let (seen_init, seen_sample, seen_report) = match &watch_process {
            Some(name) => (
                "$seen = @{}; ".to_string(),
                format!(
                    "try {{ Get-Process -Name '{name}' -ErrorAction SilentlyContinue | \
                     ForEach-Object {{ $seen[$_.Id] = 1 }} }} catch {{}}; "
                ),
                "; \"SEEN_PIDS=$(@($seen.Keys | Sort-Object) -join ',')\"".to_string(),
            ),
            None => (String::new(), String::new(), String::new()),
        };
        // 只看端口能否连上（Codex 是否已启动）；是不是 Codex 的 CDP 由调用方再判。
        script.push_str(&format!(
            "; {seen_init}$ready = $false; $deadline = [DateTime]::UtcNow.AddSeconds({HOST_PORT_WAIT_SECS}); \
             while (-not $ready -and [DateTime]::UtcNow -lt $deadline) {{ \
             {seen_sample}$client = New-Object System.Net.Sockets.TcpClient; \
             try {{ $ready = $client.ConnectAsync('127.0.0.1', {port}).Wait(500) -and $client.Connected }} \
             catch {{}} finally {{ $client.Close() }}; \
             if (-not $ready) {{ Start-Sleep -Milliseconds 250 }} }}; \
             \"PORT_READY=$([int]$ready)\"{seen_report}"
        ));
    }
    Ok(script)
}

/// `powershell.exe` 的参数（`-Command` 之后整段脚本作为一个参数传入，避免二次引用解析）。
///
/// `-ExecutionPolicy Bypass` 只作用于本进程，避免机器策略影响 Appx 模块的自动加载；
/// 与 `claude_localization` 里调用 PowerShell 的形状一致。
#[cfg(any(windows, test))]
fn activation_powershell_arguments(script: &str) -> Vec<String> {
    vec![
        "-NoProfile".to_string(),
        "-NonInteractive".to_string(),
        "-ExecutionPolicy".to_string(),
        "Bypass".to_string(),
        "-Command".to_string(),
        script.to_string(),
    ]
}

/// 系统自带 Windows PowerShell 的绝对路径；拿不到 `SystemRoot` 时退回按 PATH 查找。
///
/// 不依赖 PATH：Codex Pilot 进程的 PATH 可能与用户交互式 shell 不同（issue #2764 的差异排查项）。
#[cfg(any(windows, test))]
fn windows_powershell_path(system_root: Option<&std::ffi::OsStr>) -> PathBuf {
    match system_root.filter(|root| !root.is_empty()) {
        Some(root) => PathBuf::from(root)
            .join("System32")
            .join("WindowsPowerShell")
            .join("v1.0")
            .join("powershell.exe"),
        None => PathBuf::from("powershell.exe"),
    }
}

/// 激活输出（stdout + stderr）落盘的位置：与 wrapper 同目录、同主名。
///
/// 用文件而不是管道：包上下文里的 cmd / Codex 若继承了输出句柄，管道会一直等不到 EOF，
/// 宿主进程早已退出、调用方却卡到超时；文件句柄被继承也不会阻塞任何人。
pub fn activation_log_path(wrapper_path: &Path) -> PathBuf {
    wrapper_path.with_extension("activation.log")
}

/// 包上下文激活的结果与诊断信息（只含包身份、路径、端口与 PowerShell 输出，不含凭据）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PackageContextActivation {
    /// cmdlet 报回的 PID；没报回时是 [`UNKNOWN_PROCESS_ID`]。
    pub process_id: u32,
    /// 要求宿主等端口时的 `PORT_READY` 标记；没要求或没输出时为 `None`。
    pub port_ready_in_host: Option<bool>,
    /// 宿主等端口期间见过的同名进程（`SEEN_PIDS=` 标记）；没要求观察或没输出时为 `None`，
    /// 观察了但一个都没见到时是空列表。
    pub seen_process_ids: Option<Vec<u32>>,
    /// `HOST=` 标记：PowerShell 版本与位数。
    pub host: Option<String>,
    /// powershell.exe 退出码。
    pub exit_code: Option<i32>,
    /// 从拉起 powershell 到它退出的耗时。
    pub elapsed_ms: u64,
    /// 截断后的 PowerShell 输出（stdout + stderr）。
    pub output: String,
    /// 实际执行的命令：PowerShell 路径 + 参数。
    pub command: Vec<String>,
}

/// 诊断日志里保留的 PowerShell 输出上限（字符）。
const ACTIVATION_OUTPUT_LIMIT: usize = 2000;

impl PackageContextActivation {
    /// 由 powershell 的退出码与输出组装结果（纯函数，可在任意平台单测）。
    pub fn from_output(
        command: Vec<String>,
        exit_code: Option<i32>,
        elapsed_ms: u64,
        output: &str,
    ) -> Self {
        // 切到 UTF-8 输出时 .NET 可能先写 BOM，不去掉的话第一行标记会认不出来。
        let output = output.trim_start_matches('\u{feff}');
        Self {
            process_id: parse_reported_process_id(output).unwrap_or(UNKNOWN_PROCESS_ID),
            port_ready_in_host: activation_marker(output, "PORT_READY=").and_then(|value| {
                match value {
                    "1" => Some(true),
                    "0" => Some(false),
                    _ => None,
                }
            }),
            seen_process_ids: parse_seen_process_ids(output),
            host: activation_marker(output, "HOST=").map(str::to_string),
            exit_code,
            elapsed_ms,
            output: truncate_chars(output.trim(), ACTIVATION_OUTPUT_LIMIT),
            command,
        }
    }

    /// 激活失败时给用户看的一句话：优先 `ERROR=` 标记，其次第一行非标记的非空输出。
    pub fn failure_detail(&self) -> String {
        activation_marker(&self.output, "ERROR=")
            .map(str::to_string)
            .or_else(|| {
                let unmarked = self
                    .output
                    .lines()
                    .filter(|line| {
                        let line = line.trim_start();
                        !["HOST=", "PID=", "PORT_READY=", "SEEN_PIDS="]
                            .iter()
                            .any(|marker| line.starts_with(marker))
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                first_non_empty_line(&unmarked)
            })
            .unwrap_or_else(|| "（无错误输出）".to_string())
    }
}

/// 在 MSIX 包上下文里执行 wrapper，返回激活时拿到的进程 PID。
///
/// Windows 实现调用
/// `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Invoke-CommandInDesktopPackage …"`；
/// 非 Windows 平台返回 Err（原因见模块头的「平台约定」）。
///
/// 返回值：cmdlet 报回了 `Id` 时是它的 PID，否则是 [`UNKNOWN_PROCESS_ID`]。**不要**把它当成
/// Codex 应用进程：cmdlet 创建的是包上下文里的 `cmd.exe`，它启动应用后很快退出，应用进程要
/// 按调试端口归属去发现。也不要因为它不可用就判激活失败——真正的判据是
/// [`wait_for_instance_ready`]。
pub async fn activate_in_package_context(
    app_user_model_id: &str,
    wrapper_path: &Path,
) -> anyhow::Result<u32> {
    activate_in_package_context_with_report(app_user_model_id, wrapper_path, None, None)
        .await
        .map(|activation| activation.process_id)
}

/// 同 [`activate_in_package_context`]，但返回完整诊断，并可要求 PowerShell 宿主等待
/// `wait_port` 可连接后再退出，并在等待期间观察名为 `watch_process` 的进程
/// （见 [`activation_script_watching`]）。
pub async fn activate_in_package_context_with_report(
    app_user_model_id: &str,
    wrapper_path: &Path,
    wait_port: Option<u16>,
    watch_process: Option<&str>,
) -> anyhow::Result<PackageContextActivation> {
    activate_in_package_context_impl(app_user_model_id, wrapper_path, wait_port, watch_process)
        .await
}

#[cfg(windows)]
async fn activate_in_package_context_impl(
    app_user_model_id: &str,
    wrapper_path: &Path,
    wait_port: Option<u16>,
    watch_process: Option<&str>,
) -> anyhow::Result<PackageContextActivation> {
    let (package_family_name, app_id) = split_app_user_model_id(app_user_model_id)?;
    let wrapper_path = wrapper_path.to_path_buf();
    let watch_process = watch_process.map(str::to_string);
    if !wrapper_path.is_file() {
        bail!(
            "包上下文 wrapper 不存在，无法激活：{}",
            wrapper_path.display()
        );
    }

    let activation = tokio::task::spawn_blocking(move || {
        activate_in_package_context_blocking(
            &package_family_name,
            &app_id,
            &wrapper_path,
            wait_port,
            watch_process.as_deref(),
        )
    });
    tokio::time::timeout(ACTIVATION_TIMEOUT, activation)
        .await
        .with_context(|| {
            format!(
                "包上下文激活超时（{} 秒），已放弃本次激活",
                ACTIVATION_TIMEOUT.as_secs()
            )
        })?
        .context("包上下文激活任务异常退出")?
}

#[cfg(not(windows))]
async fn activate_in_package_context_impl(
    _app_user_model_id: &str,
    _wrapper_path: &Path,
    _wait_port: Option<u16>,
    _watch_process: Option<&str>,
) -> anyhow::Result<PackageContextActivation> {
    bail!("包上下文激活仅在 Windows 上可用（MSIX 包身份是 Windows 专有机制）")
}

#[cfg(windows)]
fn activate_in_package_context_blocking(
    package_family_name: &str,
    app_id: &str,
    wrapper_path: &Path,
    wait_port: Option<u16>,
    watch_process: Option<&str>,
) -> anyhow::Result<PackageContextActivation> {
    use std::os::windows::process::CommandExt;

    let script = activation_script_for(
        package_family_name,
        app_id,
        wrapper_path,
        wait_port,
        watch_process,
    )?;
    let powershell = windows_powershell_path(std::env::var_os("SystemRoot").as_deref());
    let arguments = activation_powershell_arguments(&script);
    let log_path = activation_log_path(wrapper_path);
    // 日志只是诊断：建不出来（例如被上一次的进程占着）就丢弃输出，不影响激活本身。
    let (stdout, stderr) = match std::fs::File::create(&log_path)
        .and_then(|log| log.try_clone().map(|log_for_stderr| (log, log_for_stderr)))
    {
        Ok((log, log_for_stderr)) => (Stdio::from(log), Stdio::from(log_for_stderr)),
        Err(_) => (Stdio::null(), Stdio::null()),
    };

    let mut command = Command::new(&powershell);
    command
        .args(&arguments)
        .stdin(Stdio::null())
        .stdout(stdout)
        .stderr(stderr)
        .creation_flags(crate::windows_integration::CREATE_NO_WINDOW);
    // issue #2764：这些开关会经 powershell → cmd 一路传给 Codex，先在源头去掉。
    for name in SCRUBBED_CODEX_ENV_VARS {
        command.env_remove(name);
    }

    let started_at = Instant::now();
    let status = command
        .spawn()
        .with_context(|| format!("启动 {} 执行包上下文激活失败", powershell.display()))?
        .wait()
        .context("等待 powershell.exe 执行包上下文激活失败")?;
    let elapsed_ms = u64::try_from(started_at.elapsed().as_millis()).unwrap_or(u64::MAX);
    let output = std::fs::read(&log_path)
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .unwrap_or_default();

    let mut command_shape = vec![powershell.to_string_lossy().into_owned()];
    command_shape.extend(arguments);
    let activation =
        PackageContextActivation::from_output(command_shape, status.code(), elapsed_ms, &output);
    if !status.success() {
        bail!(
            "Invoke-CommandInDesktopPackage 激活失败（退出码 {}，{} ms）：{}；完整输出见 {}",
            activation
                .exit_code
                .map(|code| code.to_string())
                .unwrap_or_else(|| "unknown".to_string()),
            activation.elapsed_ms,
            activation.failure_detail(),
            log_path.display()
        );
    }
    Ok(activation)
}

/// 该实例是否已就绪：CDP 端口能连上并返回 Codex 页面 == 启动成功。
///
/// 判据用 `cdp::endpoint_available`（要求 `/json` 里确实有 Codex 的页面目标），不是「端口
/// 被占用」——端口被无关进程占着不算就绪。`timeout` 为 0 表示只探一次。
///
/// 注意：每次探测本身最长会阻塞约 600ms（连接 + 读取各 300ms），所以总时长可能略微超过
/// `timeout`；这是同步阻塞函数，在 async 上下文里应放到 `spawn_blocking` 里调。
pub fn wait_for_instance_ready(debug_port: u16, timeout: Duration) -> bool {
    wait_for_instance_ready_with(
        debug_port,
        timeout,
        crate::cdp::endpoint_available,
        READY_POLL_INTERVAL,
    )
}

/// [`wait_for_instance_ready`] 的核心。探测与轮询间隔以参数注入，便于确定性地单测。
fn wait_for_instance_ready_with(
    debug_port: u16,
    timeout: Duration,
    is_ready: impl Fn(u16) -> bool,
    poll_interval: Duration,
) -> bool {
    if debug_port == 0 {
        return false;
    }
    let now = Instant::now();
    let Some(deadline) = now.checked_add(timeout) else {
        return is_ready(debug_port);
    };
    loop {
        if is_ready(debug_port) {
            return true;
        }
        let now = Instant::now();
        if now >= deadline {
            return false;
        }
        std::thread::sleep(poll_interval.min(deadline.saturating_duration_since(now)));
    }
}

/// 路径写进 `.cmd` 的字面量：`%` 必须写成 `%%`，否则 cmd 会当变量展开。
///
/// 双引号/换行是 Windows 路径的非法字符，出现即拒绝，避免脚本被注入（也避免赋值的引号
/// 被提前闭合）。`!` 不需要转义：脚本只 `setlocal`，没开 delayedexpansion。
fn batch_path_literal(path: &Path) -> anyhow::Result<String> {
    Ok(path_text(path)?.replace('%', "%%"))
}

/// 路径 → 字符串，并挡掉无法安全拼进脚本的字符。
fn path_text(path: &Path) -> anyhow::Result<String> {
    let text = path.to_string_lossy();
    if text.is_empty() {
        bail!("路径不能为空");
    }
    if text.contains('"') || text.contains('\r') || text.contains('\n') {
        bail!("路径包含无法写进启动脚本的字符（引号或换行）：{text}");
    }
    Ok(text.into_owned())
}

/// PowerShell 单引号字符串字面量：内部的 `'` 用 `''` 转义。
fn powershell_literal(value: &str) -> anyhow::Result<String> {
    if value.is_empty() {
        bail!("PowerShell 参数不能为空");
    }
    if value.contains('\r') || value.contains('\n') || value.contains('\0') {
        bail!("PowerShell 参数包含不可见控制字符，拒绝拼进命令：{value}");
    }
    Ok(value.replace('\'', "''"))
}

/// 只认 `PID=<数字>` 这一种输出，避免把 cmdlet 的其它数字输出误当成进程号。
fn parse_reported_process_id(stdout: &str) -> Option<u32> {
    stdout.lines().find_map(|line| {
        line.trim()
            .strip_prefix("PID=")
            .and_then(|value| value.trim().parse::<u32>().ok())
            .filter(|id| *id != UNKNOWN_PROCESS_ID)
    })
}

/// 解析 `SEEN_PIDS=1,2,3`。标记存在但为空表示「观察了、没见到」，返回空列表；
/// 无法解析的片段跳过。
fn parse_seen_process_ids(output: &str) -> Option<Vec<u32>> {
    let value = output
        .lines()
        .find_map(|line| line.trim().strip_prefix("SEEN_PIDS="))?;
    let mut ids = value
        .split(',')
        .filter_map(|part| part.trim().parse::<u32>().ok())
        .filter(|id| *id != UNKNOWN_PROCESS_ID)
        .collect::<Vec<_>>();
    ids.sort_unstable();
    ids.dedup();
    Some(ids)
}

/// 取第一行以 `key` 开头的标记值（去掉首尾空白）；值为空视为没有。
fn activation_marker<'a>(output: &'a str, key: &str) -> Option<&'a str> {
    output.lines().find_map(|line| {
        line.trim()
            .strip_prefix(key)
            .map(str::trim)
            .filter(|value| !value.is_empty())
    })
}

fn first_non_empty_line(text: &str) -> Option<String> {
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
}

/// 按字符截断（不切坏多字节字符），超出时以 `…` 结尾。
fn truncate_chars(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    let mut truncated: String = text.chars().take(limit).collect();
    truncated.push('…');
    truncated
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::STATE_DIR_ENV;
    use std::cell::Cell;
    use std::io::{Read, Write};
    use std::net::{Ipv4Addr, TcpListener};
    use std::thread;

    const AUMID: &str = "OpenAI.Codex_2p2nqsd0c76g0!App";
    /// Windows 形式的路径只在字面量断言里用：macOS 上 `Path::parent()` 按 `/` 切分，
    /// 对 `C:\a\b.exe` 取不到目录，所以涉及 `cd /d` 的用例一律用 `/` 分隔的路径。
    const WINDOWS_EXE: &str =
        r"C:\Program Files\WindowsApps\OpenAI.Codex_1.2.3_x64__2p2nqsd0c76g0\app\ChatGPT.exe";

    /// 写死端口号会让测试在「该端口恰好被并行跑的其它测试/进程占着」时假失败，
    /// 所以每次现取一个空闲回环端口。
    fn free_port() -> u16 {
        let port = crate::ports::find_available_loopback_port();
        assert!(port > 0, "测试环境应能分配空闲回环端口");
        port
    }

    #[test]
    fn activation_script_targets_the_package_family_name_and_app_id() {
        let script =
            activation_script(AUMID, Path::new(r"C:\state dir\packaged-launch.cmd"), None).unwrap();

        assert!(script.contains("-PackageFamilyName 'OpenAI.Codex_2p2nqsd0c76g0'"));
        assert!(script.contains("-AppId 'App'"));
        assert!(script.contains("-Command 'cmd.exe'"));
        assert!(script.contains(r#"-Args '/d /c "C:\state dir\packaged-launch.cmd"'"#));
        assert!(script.contains("-PreventBreakaway"));
        assert!(script.contains("$ErrorActionPreference = 'Stop'"));
        // 脚本里只允许出现包身份、路径与 PID 标记：不能带凭据。
        let lowered = script.to_ascii_lowercase();
        assert!(!lowered.contains("auth.json"));
        assert!(!lowered.contains("token"));
        assert!(!lowered.contains("api_key"));
    }

    #[test]
    fn activation_script_escapes_single_quotes_in_the_wrapper_path() {
        let script = activation_script(AUMID, Path::new(r"C:\Users\O'Brien\w.cmd"), None).unwrap();

        assert!(script.contains(r#"-Args '/d /c "C:\Users\O''Brien\w.cmd"'"#));
    }

    #[test]
    fn activation_script_rejects_malformed_aumids() {
        let wrapper = Path::new("w.cmd");
        for aumid in [
            "",
            "OpenAI.Codex_2p2nqsd0c76g0",
            "!App",
            "OpenAI.Codex_2p2nqsd0c76g0!",
            "OpenAI.Codex_2p2nqsd0c76g0!App!Extra",
        ] {
            assert!(
                activation_script(aumid, wrapper, None).is_err(),
                "AUMID 应当被拒绝：{aumid}"
            );
        }
    }

    #[test]
    fn activation_powershell_arguments_match_the_non_interactive_form() {
        assert_eq!(
            activation_powershell_arguments("Get-Date"),
            vec![
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                "Get-Date"
            ]
        );
    }

    #[test]
    fn activation_script_reports_host_and_cmdlet_errors_without_waiting_by_default() {
        let script = activation_script(AUMID, Path::new(r"C:\s\w.cmd"), None).unwrap();

        assert!(script.contains("\"HOST=$($PSVersionTable.PSVersion);X64="));
        // cmdlet 抛错要带上异常类型 / HRESULT / 消息，并以非零码退出（issue #2747 丢了原因）。
        assert!(script.contains("try { $created = Invoke-CommandInDesktopPackage "));
        assert!(script.contains("\"ERROR=$($_.Exception.GetType().FullName) 0x$('{0:X8}' -f"));
        assert!(script.contains("exit 1 }"));
        assert!(script.contains("[Console]::OutputEncoding = [System.Text.Encoding]::UTF8"));
        // 多开路径不要求宿主等端口：激活后立即退出，保持原行为。
        assert!(!script.contains("PORT_READY"));
        assert!(!script.contains("TcpClient"));
        assert!(script.ends_with("if ($created -and $created.Id) { \"PID=$($created.Id)\" }"));
    }

    #[test]
    fn activation_script_keeps_the_host_alive_until_the_debug_port_listens() {
        let script = activation_script(AUMID, Path::new(r"C:\s\w.cmd"), Some(9229)).unwrap();

        let pid_marker = script.find("\"PID=$($created.Id)\"").unwrap();
        let wait = script
            .find("ConnectAsync('127.0.0.1', 9229).Wait(500)")
            .unwrap();
        assert!(pid_marker < wait, "先报 PID，再在宿主里等端口");
        assert!(script.contains(&format!(
            "[DateTime]::UtcNow.AddSeconds({HOST_PORT_WAIT_SECS})"
        )));
        assert!(script.ends_with("\"PORT_READY=$([int]$ready)\""));
        // 端口 0 没有意义，不生成等待段。
        let no_wait = activation_script(AUMID, Path::new(r"C:\s\w.cmd"), Some(0)).unwrap();
        assert!(!no_wait.contains("PORT_READY"));
    }

    #[test]
    fn host_port_wait_fits_inside_the_activation_timeout() {
        // 宿主等端口的时长必须留出 PowerShell 启动的余量，否则正常启动也会被判超时。
        const { assert!(HOST_PORT_WAIT_SECS + 5 <= 30) };
    }

    #[test]
    fn powershell_path_prefers_the_system_copy_over_path_lookup() {
        let path = windows_powershell_path(Some(std::ffi::OsStr::new(r"C:\Windows")));
        let components: Vec<_> = path
            .components()
            .map(|part| part.as_os_str().to_string_lossy().into_owned())
            .collect();
        assert!(components.ends_with(&[
            "System32".to_string(),
            "WindowsPowerShell".to_string(),
            "v1.0".to_string(),
            "powershell.exe".to_string(),
        ]));
        assert_eq!(
            windows_powershell_path(None),
            PathBuf::from("powershell.exe")
        );
        assert_eq!(
            windows_powershell_path(Some(std::ffi::OsStr::new(""))),
            PathBuf::from("powershell.exe")
        );
    }

    #[test]
    fn activation_log_sits_next_to_the_wrapper() {
        let wrapper = Path::new("state").join(MAIN_WRAPPER_FILE_NAME);
        assert_eq!(
            activation_log_path(&wrapper),
            Path::new("state").join("packaged-launch-main.activation.log")
        );
    }

    #[test]
    fn activation_report_parses_markers_from_the_host_output() {
        let output = "HOST=5.1.26100.1;X64=True\r\nPID=111628\r\nPORT_READY=0\r\n";
        let report = PackageContextActivation::from_output(
            vec!["powershell.exe".to_string()],
            Some(0),
            1234,
            output,
        );
        assert_eq!(report.process_id, 111628);
        assert_eq!(report.host.as_deref(), Some("5.1.26100.1;X64=True"));
        assert_eq!(report.port_ready_in_host, Some(false));
        assert_eq!(report.exit_code, Some(0));
        assert_eq!(report.elapsed_ms, 1234);

        let ready = PackageContextActivation::from_output(Vec::new(), Some(0), 0, "PORT_READY=1");
        assert_eq!(ready.port_ready_in_host, Some(true));
        assert_eq!(ready.process_id, UNKNOWN_PROCESS_ID);
        let silent = PackageContextActivation::from_output(Vec::new(), Some(0), 0, "");
        assert_eq!(silent.port_ready_in_host, None);
        assert_eq!(silent.host, None);
        // UTF-8 输出可能带 BOM：第一行的标记照样要认出来。
        let with_bom = PackageContextActivation::from_output(
            Vec::new(),
            Some(0),
            0,
            "\u{feff}HOST=5.1;X64=True",
        );
        assert_eq!(with_bom.host.as_deref(), Some("5.1;X64=True"));
    }

    #[test]
    fn activation_failure_detail_prefers_the_error_marker_over_other_lines() {
        let report = PackageContextActivation::from_output(
            Vec::new(),
            Some(1),
            10,
            "HOST=5.1;X64=True\r\nERROR=System.UnauthorizedAccessException 0x80070005: 拒绝访问。\r\n",
        );
        assert_eq!(
            report.failure_detail(),
            "System.UnauthorizedAccessException 0x80070005: 拒绝访问。"
        );

        // 没有 ERROR 标记时跳过 HOST 等标记行，取真正的错误输出。
        let stderr_only = PackageContextActivation::from_output(
            Vec::new(),
            Some(1),
            10,
            "HOST=5.1;X64=True\r\n\r\nInvoke-CommandInDesktopPackage : 无法识别\r\n",
        );
        assert_eq!(
            stderr_only.failure_detail(),
            "Invoke-CommandInDesktopPackage : 无法识别"
        );
        let empty = PackageContextActivation::from_output(Vec::new(), Some(1), 10, "HOST=5.1");
        assert_eq!(empty.failure_detail(), "（无错误输出）");
    }

    #[test]
    fn activation_report_truncates_long_output_on_char_boundaries() {
        let long = "错".repeat(ACTIVATION_OUTPUT_LIMIT + 10);
        let report = PackageContextActivation::from_output(Vec::new(), Some(1), 0, &long);
        assert_eq!(report.output.chars().count(), ACTIVATION_OUTPUT_LIMIT + 1);
        assert!(report.output.ends_with('…'));
        assert_eq!(truncate_chars("短", 5), "短");
    }

    #[test]
    fn scrubbed_env_vars_cover_electron_node_mode_and_keep_codex_identity() {
        for name in ["ELECTRON_RUN_AS_NODE", "ELECTRON_NO_ASAR", "NODE_OPTIONS"] {
            assert!(SCRUBBED_CODEX_ENV_VARS.contains(&name), "{name}");
        }
        // 用户有意设置的 Codex 数据目录 / Codex Pilot 状态目录不能被清掉。
        for name in ["CODEX_HOME", "CODEX_SQLITE_HOME", STATE_DIR_ENV, "PATH"] {
            assert!(!SCRUBBED_CODEX_ENV_VARS.contains(&name), "{name}");
        }
        assert_eq!(
            present_scrubbed_env_vars(|name| name == "NODE_OPTIONS" || name == "PATH"),
            vec!["NODE_OPTIONS"]
        );
        assert!(present_scrubbed_env_vars(|_| false).is_empty());
    }

    #[test]
    fn elevated_packaged_launch_keeps_codex_from_de_elevating() {
        let extra = vec!["--lang=zh-CN".to_string()];
        // 未提权：参数原样不变。
        assert_eq!(packaged_launch_extra_args(&extra, false), extra);
        // 提权：补上 Chromium 的降权豁免开关（issue #2789）。
        assert_eq!(
            packaged_launch_extra_args(&extra, true),
            vec![
                "--lang=zh-CN".to_string(),
                "--do-not-de-elevate".to_string()
            ]
        );
        // 用户已写过（大小写、首尾空白不同）时不重复添加。
        let user = vec![" --Do-Not-De-Elevate ".to_string()];
        assert_eq!(packaged_launch_extra_args(&user, true), user);
        // 只认完整开关名，前缀相同的别的开关不算。
        let similar = vec!["--do-not-de-elevate-later".to_string()];
        assert_eq!(packaged_launch_extra_args(&similar, true).len(), 2);
    }

    #[test]
    fn elevated_main_wrapper_passes_do_not_de_elevate_to_codex() {
        let args = packaged_launch_extra_args(&[], true);
        let mut launch_args = vec!["--remote-debugging-port=9229".to_string()];
        launch_args.extend(args);
        let script =
            build_main_instance_wrapper_script(Path::new(r"C:\app\ChatGPT.exe"), &launch_args)
                .unwrap();
        assert!(script.contains(
            "start \"\" /b \"C:\\app\\ChatGPT.exe\" --remote-debugging-port=9229 --do-not-de-elevate\r\n"
        ));
    }

    #[test]
    fn aumid_activation_timeout_is_typed_and_actionable() {
        let error = anyhow::Error::new(AumidActivationTimedOut { seconds: 20 });
        assert_eq!(
            error.downcast_ref::<AumidActivationTimedOut>(),
            Some(&AumidActivationTimedOut { seconds: 20 })
        );
        assert!(error.to_string().contains("20 秒内没有返回"));
        let message = aumid_activation_timed_out_message(20, "ChatGPT.exe");
        assert!(message.contains("20 秒"));
        assert!(message.contains("已挂起"));
        assert!(message.contains("ChatGPT.exe"));
        assert!(AUMID_ACTIVATION_CALL_TIMEOUT >= Duration::from_secs(10));
    }

    #[test]
    fn main_wrapper_clears_scrubbed_environment_before_starting_codex() {
        let script = build_main_instance_wrapper_script(
            Path::new(r"C:\app\ChatGPT.exe"),
            &["--remote-debugging-port=9229".to_string()],
        )
        .unwrap();
        let start = script.find("start \"\" /b").unwrap();
        for name in SCRUBBED_CODEX_ENV_VARS {
            let clear = script.find(&format!("set \"{name}=\"\r\n")).unwrap();
            assert!(clear < start);
        }
    }

    #[test]
    fn reported_process_id_requires_the_explicit_pid_marker() {
        assert_eq!(parse_reported_process_id("PID=4321\r\n"), Some(4321));
        assert_eq!(
            parse_reported_process_id("noise\r\n  PID=77  \r\n"),
            Some(77)
        );
        // 没有标记的裸数字、非数字、哨兵 0 都不算 PID。
        assert_eq!(parse_reported_process_id("4321"), None);
        assert_eq!(parse_reported_process_id("PID=abc"), None);
        assert_eq!(parse_reported_process_id("PID=0"), None);
        assert_eq!(parse_reported_process_id(""), None);
    }

    #[test]
    fn first_non_empty_line_skips_blank_lines() {
        assert_eq!(
            first_non_empty_line("\r\n  \r\n激活失败\r\n"),
            Some("激活失败".to_string())
        );
        assert_eq!(first_non_empty_line("   \r\n"), None);
    }

    #[test]
    fn known_process_id_filters_the_unknown_sentinel() {
        let launch = PackagedContextLaunch {
            app_user_model_id: AUMID.to_string(),
            wrapper_path: PathBuf::from("w.cmd"),
            process_id: Some(UNKNOWN_PROCESS_ID),
        };
        assert_eq!(launch.known_process_id(), None);

        let launch = PackagedContextLaunch {
            process_id: Some(4242),
            ..launch
        };
        assert_eq!(launch.known_process_id(), Some(4242));
    }

    #[test]
    fn instance_ready_polls_until_the_endpoint_answers() {
        let probes = Cell::new(0);

        let ready = wait_for_instance_ready_with(
            9229,
            Duration::from_millis(500),
            |_| {
                probes.set(probes.get() + 1);
                probes.get() >= 3
            },
            Duration::from_millis(1),
        );

        assert!(ready);
        assert_eq!(probes.get(), 3);
    }

    #[test]
    fn instance_ready_keeps_probing_until_the_deadline() {
        let probes = Cell::new(0);

        let ready = wait_for_instance_ready_with(
            9229,
            Duration::from_millis(30),
            |_| {
                probes.set(probes.get() + 1);
                false
            },
            Duration::from_millis(1),
        );

        assert!(!ready);
        assert!(probes.get() > 1);
    }

    #[test]
    fn instance_ready_probes_exactly_once_when_timeout_is_zero() {
        for answer in [false, true] {
            let probes = Cell::new(0);
            let ready = wait_for_instance_ready_with(
                9229,
                Duration::ZERO,
                |_| {
                    probes.set(probes.get() + 1);
                    answer
                },
                Duration::from_millis(1),
            );
            assert_eq!(ready, answer);
            assert_eq!(probes.get(), 1);
        }
    }

    #[test]
    fn instance_ready_rejects_a_zero_port() {
        assert!(!wait_for_instance_ready(0, Duration::from_millis(10)));
    }

    fn serve_cdp_once(build_body: impl FnOnce(u16) -> String) -> (u16, thread::JoinHandle<()>) {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let body = build_body(port);
        let handle = thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut request = [0_u8; 1024];
                let _ = stream.read(&mut request);
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes());
            }
        });
        (port, handle)
    }

    #[test]
    fn instance_ready_accepts_a_real_codex_cdp_endpoint() {
        let (port, server) = serve_cdp_once(|port| {
            format!(
                r#"[{{"id":"codex","type":"page","title":"Codex","url":"app://-/index.html","webSocketDebuggerUrl":"ws://127.0.0.1:{port}/devtools/page/1"}}]"#
            )
        });

        assert!(wait_for_instance_ready(port, Duration::from_secs(2)));
        server.join().unwrap();
    }

    #[test]
    fn instance_ready_rejects_an_ordinary_http_endpoint() {
        // 端口上确实有 HTTP 服务、但不是 Codex 的 CDP：不能判成就绪。
        let (port, server) = serve_cdp_once(|_| r#"{"status":"ok"}"#.to_string());

        assert!(!wait_for_instance_ready(port, Duration::from_millis(300)));
        server.join().unwrap();
    }

    #[test]
    fn main_instance_wrapper_starts_exe_with_debug_args_and_no_instance_env() {
        let script = build_main_instance_wrapper_script(
            Path::new(r"C:\Program Files\WindowsApps\OpenAI.Codex_1_x64__p\app\ChatGPT.exe"),
            &[
                "--remote-debugging-port=9229".to_string(),
                "--remote-allow-origins=http://127.0.0.1:9229".to_string(),
                r"--user-data-dir=C:\Users\a b\100%\x&y".to_string(),
            ],
        )
        .unwrap();

        assert!(script.contains("\r\n"));
        assert!(!script.contains("CODEX_PLUS_MULTI_INSTANCE"));
        assert!(!script.contains("CODEX_HOME"));
        assert!(!script.contains(STATE_DIR_ENV));
        assert!(script.contains(
            "start \"\" /b \"C:\\Program Files\\WindowsApps\\OpenAI.Codex_1_x64__p\\app\\ChatGPT.exe\" \
             --remote-debugging-port=9229 --remote-allow-origins=http://127.0.0.1:9229 \
             \"--user-data-dir=C:\\Users\\a b\\100%%\\x&y\"\r\n"
        ));
    }

    #[test]
    fn main_instance_wrapper_rejects_quotes_in_arguments() {
        let error = build_main_instance_wrapper_script(
            Path::new(r"C:\app\ChatGPT.exe"),
            &["--flag=\"x\" & calc".to_string()],
        )
        .unwrap_err();
        assert!(format!("{error:#}").contains("引号"));
    }

    #[test]
    fn prepare_main_instance_wrapper_writes_separate_file() {
        let temp = tempfile::tempdir().unwrap();
        let path = prepare_main_instance_wrapper(
            temp.path(),
            Path::new(r"C:\app\ChatGPT.exe"),
            &["--remote-debugging-port=9229".to_string()],
        )
        .unwrap();
        assert_eq!(path, temp.path().join(MAIN_WRAPPER_FILE_NAME));
        assert!(
            std::fs::read_to_string(path)
                .unwrap()
                .contains("--remote-debugging-port=9229")
        );
    }

    #[test]
    fn aumid_watch_reports_ready_as_soon_as_cdp_is_available() {
        let start = Instant::now();
        let mut watch = AumidActivationWatch::new(start);
        assert_eq!(
            watch.observe(start, true, Some(false)),
            AumidActivationVerdict::Ready
        );
    }

    #[test]
    fn aumid_watch_falls_back_after_activation_process_exits_without_cdp() {
        // issue #2700：激活进程秒退、9229 不监听 → 退出宽限后改走包上下文。
        let start = Instant::now();
        let mut watch = AumidActivationWatch::new(start);
        let exited = start + Duration::from_millis(500);
        assert_eq!(
            watch.observe(exited, false, Some(false)),
            AumidActivationVerdict::Pending
        );
        assert_eq!(
            watch.observe(exited + Duration::from_secs(1), false, Some(false)),
            AumidActivationVerdict::Pending
        );
        assert_eq!(
            watch.observe(exited + AUMID_ACTIVATION_EXIT_GRACE, false, Some(false)),
            AumidActivationVerdict::FallbackToPackageContext
        );
    }

    #[test]
    fn aumid_watch_does_not_fall_back_when_cdp_appears_during_exit_grace() {
        // 中转进程退出、真正进程稍后监听：不能误判为激活失败。
        let start = Instant::now();
        let mut watch = AumidActivationWatch::new(start);
        assert_eq!(
            watch.observe(start, false, Some(false)),
            AumidActivationVerdict::Pending
        );
        assert_eq!(
            watch.observe(start + Duration::from_secs(1), true, Some(false)),
            AumidActivationVerdict::Ready
        );
    }

    #[test]
    fn aumid_watch_keeps_old_behavior_when_process_stays_alive() {
        let start = Instant::now();
        let mut watch = AumidActivationWatch::new(start);
        assert_eq!(
            watch.observe(start + Duration::from_secs(5), false, Some(true)),
            AumidActivationVerdict::Pending
        );
        assert_eq!(
            watch.observe(start + AUMID_ACTIVATION_VERIFY_WINDOW, false, Some(true)),
            AumidActivationVerdict::Inconclusive
        );
    }

    #[test]
    fn aumid_watch_never_falls_back_when_liveness_is_unknown() {
        let start = Instant::now();
        let mut watch = AumidActivationWatch::new(start);
        assert_eq!(
            watch.observe(start + Duration::from_secs(1), false, None),
            AumidActivationVerdict::Pending
        );
        assert_eq!(
            watch.observe(start + AUMID_ACTIVATION_VERIFY_WINDOW, false, None),
            AumidActivationVerdict::Inconclusive
        );
    }

    #[test]
    fn aumid_watch_resets_exit_grace_when_process_is_seen_alive_again() {
        let start = Instant::now();
        let mut watch = AumidActivationWatch::new(start);
        watch.observe(start, false, Some(false));
        watch.observe(start + Duration::from_secs(1), false, Some(true));
        assert_eq!(
            watch.observe(start + Duration::from_secs(3), false, Some(false)),
            AumidActivationVerdict::Pending
        );
    }

    const STORE_EXE: &str = r#""C:\Program Files\WindowsApps\OpenAI.Codex_26.1023.6621.0_x64__2p2nqsd0c76g0\app\ChatGPT.exe""#;

    #[test]
    fn existing_codex_processes_are_classified_by_command_line() {
        // 开始菜单 / 托盘里开着的主进程：没有任何调试参数。
        assert_eq!(
            classify_existing_codex_process(Some(STORE_EXE), 9229),
            ExistingCodexProcess::MainWithoutDebugPort
        );
        // 带的是别的端口，同样占着单实例锁。
        assert_eq!(
            classify_existing_codex_process(
                Some(&format!("{STORE_EXE} --remote-debugging-port=9333")),
                9229
            ),
            ExistingCodexProcess::MainWithoutDebugPort
        );
        assert_eq!(
            classify_existing_codex_process(
                Some(&format!(
                    "{STORE_EXE} --remote-debugging-port=9229 --remote-allow-origins=http://127.0.0.1:9229"
                )),
                9229
            ),
            ExistingCodexProcess::MainWithDebugPort
        );
        assert_eq!(
            classify_existing_codex_process(
                Some(&format!(
                    "{STORE_EXE} --type=renderer --user-data-dir=\"C:\\x\" --remote-debugging-port=9333"
                )),
                9229
            ),
            ExistingCodexProcess::Child
        );
        assert_eq!(
            classify_existing_codex_process(
                Some(&format!(
                    "{STORE_EXE} --remote-debugging-port=9442 \"--user-data-dir=C:\\Users\\a b\\multi\""
                )),
                9229
            ),
            ExistingCodexProcess::IsolatedInstance
        );
        assert_eq!(
            classify_existing_codex_process(None, 9229),
            ExistingCodexProcess::Unknown
        );
    }

    #[test]
    fn only_main_processes_without_the_debug_port_block_the_launch() {
        let command_lines = |pid: u32| -> Option<String> {
            match pid {
                // 主进程（无调试端口）
                28480 => Some(STORE_EXE.to_string()),
                // 它的子进程
                28524 => Some(format!("{STORE_EXE} --type=gpu-process")),
                28568 => Some(format!("{STORE_EXE} --type=renderer")),
                // 多开实例
                30000 => Some(format!(
                    "{STORE_EXE} --remote-debugging-port=9442 --user-data-dir=C:\\m"
                )),
                // 读不到命令行
                _ => None,
            }
        };
        assert_eq!(
            main_instances_blocking_debug_launch(
                [28568, 28480, 28524, 30000, 31144, 28480],
                9229,
                &[],
                command_lines
            ),
            vec![28480]
        );
        // 本次启动自带数据目录时，与默认目录的主实例互不影响。
        assert!(
            main_instances_blocking_debug_launch(
                [28480],
                9229,
                &["--user-data-dir=C:\\custom".to_string()],
                command_lines
            )
            .is_empty()
        );
        // 已带本次端口的主实例交给原有流程复用，不拦。
        assert!(
            main_instances_blocking_debug_launch([1], 9229, &[], |_| Some(format!(
                "{STORE_EXE} --remote-debugging-port=9229"
            )))
            .is_empty()
        );
        // 命令行全都读不到：宁漏不误。
        assert!(main_instances_blocking_debug_launch([1, 2], 9229, &[], |_| None).is_empty());
    }

    #[test]
    fn package_family_match_ignores_version_but_not_other_packages() {
        let ours = r"C:\Program Files\WindowsApps\OpenAI.Codex_26.1023.6621.0_x64__2p2nqsd0c76g0\app\ChatGPT.exe";
        // 更新后旧版本目录里还在跑的 Codex：同一包族。
        assert!(same_windows_apps_package_family(
            r"c:\program files\windowsapps\openai.codex_26.1021.3705.0_x64__2p2nqsd0c76g0\app\ChatGPT.exe",
            ours
        ));
        // 另装的 ChatGPT 桌面版同样叫 ChatGPT.exe，但不是同一个包。
        assert!(!same_windows_apps_package_family(
            r"C:\Program Files\WindowsApps\OpenAI.ChatGPT-Desktop_1.2025.1.0_x64__2p2nqsd0c76g0\app\ChatGPT.exe",
            ours
        ));
        // 不在 WindowsApps 下、或包全名不完整：不认。
        assert!(!same_windows_apps_package_family(
            r"D:\Codex\ChatGPT.exe",
            ours
        ));
        assert!(!same_windows_apps_package_family(
            r"C:\Program Files\WindowsApps\OpenAI.Codex\app\ChatGPT.exe",
            ours
        ));
    }

    #[test]
    fn blocking_instance_message_tells_the_user_how_to_quit_codex() {
        let message =
            existing_main_instance_blocks_launch_message(9229, "ChatGPT.exe", &[28480, 31144]);
        assert!(message.contains("9229"));
        assert!(message.contains("28480, 31144"));
        assert!(message.contains("ChatGPT.exe"));
        assert!(message.contains("托盘"));
        assert!(message.contains("重启 Codex"));
    }

    #[test]
    fn leftovers_after_blocking_main_instance_never_include_foreign_subtrees() {
        // 28480：挡路主进程；28524 / 28568：Electron 子进程；29000：包内 codex.exe；
        // 31000：从 Codex 里打开的 VS Code；31100：VS Code 起的 node（dev server）；
        // 32000：Codex 终端里的 pwsh，32100：pwsh 里跑的同包 codex.exe（用户自己起的）。
        let processes = [
            (28480, 4000),
            (28524, 28480),
            (28568, 28480),
            (29000, 28524),
            (31000, 28480),
            (31100, 31000),
            (32000, 28480),
            (32100, 32000),
            (50000, 1),
        ];
        let birth = |pid: u32| -> Option<u64> {
            match pid {
                28480 => Some(100),
                4000 | 1 | 50000 => Some(1),
                _ => Some(pid as u64),
            }
        };
        let cleanable = |pid: u32| matches!(pid, 28524 | 28568 | 29000 | 32100);
        // 只沿可清理的进程向下走：VS Code / pwsh 及其子树一个都不碰，主进程本身也不在里面。
        assert_eq!(
            blocking_main_instance_leftovers(28480, &processes, birth, cleanable),
            vec![28524, 28568, 29000]
        );
        // PID 复用：父 PID 指向主进程、却比它更早创建的无关进程，不算残留。
        let reused = [(28480, 4000), (777, 28480)];
        assert!(
            blocking_main_instance_leftovers(
                28480,
                &reused,
                |pid| Some(if pid == 777 { 5 } else { 100 }),
                |_| true
            )
            .is_empty()
        );
        // 创建时间读不到：父子关系无法证实，同样不算。
        assert!(
            blocking_main_instance_leftovers(
                28480,
                &reused,
                |pid| (pid == 28480).then_some(100),
                |_| true
            )
            .is_empty()
        );
        // 目标是 0、父子关系成环（快照里 PID 复用造成）：都能正常结束。
        assert!(blocking_main_instance_leftovers(0, &processes, birth, |_| true).is_empty());
        assert_eq!(
            blocking_main_instance_leftovers(
                1,
                &[(1, 2), (2, 1)],
                |pid| Some(pid as u64),
                |_| true
            ),
            vec![2]
        );
    }

    #[test]
    fn only_codex_processes_of_the_same_package_may_be_cleaned_up() {
        let codex = r"C:\Program Files\WindowsApps\OpenAI.Codex_26.1023.6621.0_x64__2p2nqsd0c76g0\app\ChatGPT.exe";
        let bundled_cli = r"C:\Program Files\WindowsApps\OpenAI.Codex_26.1023.6621.0_x64__2p2nqsd0c76g0\app\resources\codex.exe";
        let other_package = r"C:\Program Files\WindowsApps\OpenAI.ChatGPT-Desktop_1.2025.1.0_x64__2p2nqsd0c76g0\app\ChatGPT.exe";
        let allowed = |exe: &str, path: Option<&str>, command_line: Option<&str>| {
            may_clean_up_after_blocking_main_instance(exe, path, command_line, codex)
        };
        // 同包族的 Electron 子进程、包内 codex.exe：可以清理。
        assert!(allowed(
            "ChatGPT.exe",
            Some(codex),
            Some(&format!("{STORE_EXE} --type=renderer"))
        ));
        assert!(allowed(
            "codex.exe",
            Some(bundled_cli),
            Some("codex.exe app-server")
        ));
        // 多开实例、另一个主进程、读不到命令行：都不能动。
        assert!(!allowed(
            "ChatGPT.exe",
            Some(codex),
            Some(&format!(
                "{STORE_EXE} --remote-debugging-port=9442 --user-data-dir=C:\\m"
            ))
        ));
        assert!(!allowed("ChatGPT.exe", Some(codex), Some(STORE_EXE)));
        assert!(!allowed("chatgpt.exe", Some(codex), None));
        // 另装的 ChatGPT 桌面版、路径读不到：不能动。
        assert!(!allowed(
            "ChatGPT.exe",
            Some(other_package),
            Some("ChatGPT.exe --type=renderer")
        ));
        assert!(!allowed(
            "ChatGPT.exe",
            None,
            Some(&format!("{STORE_EXE} --type=gpu-process"))
        ));
        // 包外的程序（用户装的 codex CLI、VS Code、node、浏览器、Codex Pilot 自身）：一律不碰。
        assert!(!allowed(
            "codex.exe",
            Some(r"C:\Users\me\AppData\Roaming\npm\node_modules\@openai\codex\codex.exe"),
            None
        ));
        assert!(!allowed("codex.exe", None, None));
        assert!(!allowed(
            "Code.exe",
            Some(r"C:\Users\me\AppData\Local\Programs\Microsoft VS Code\Code.exe"),
            None
        ));
        assert!(!allowed(
            "node.exe",
            Some(r"C:\Program Files\nodejs\node.exe"),
            None
        ));
        assert!(!allowed(
            "CodexPilot.exe",
            Some(r"C:\Program Files\Codex Pilot\CodexPilot.exe"),
            None
        ));
    }

    #[test]
    fn force_stop_skips_processes_whose_pid_was_reused_while_waiting() {
        let recorded = [(100, Some(10)), (200, Some(20)), (300, None)];
        // 100 未变；200 已退出、PID 被创建时间不同的进程复用；300 当时就读不到创建时间。
        let birth = |pid: u32| match pid {
            100 => Some(10),
            200 => Some(99),
            _ => None,
        };
        assert_eq!(
            processes_still_to_force_stop(&recorded, birth),
            vec![100, 300]
        );
        // 现在读不到创建时间（进程刚退出）：记录过的就不再强杀。
        assert_eq!(
            processes_still_to_force_stop(&[(100, Some(10))], |_| None),
            Vec::<u32>::new()
        );
    }

    #[test]
    fn main_instance_wrapper_traces_start_and_errorlevel_next_to_itself() {
        let script = build_main_instance_wrapper_script(
            Path::new(r"C:\app\ChatGPT.exe"),
            &["--remote-debugging-port=9229".to_string()],
        )
        .unwrap();
        let started = script
            .find(">\"%~dpn0.trace.log\" echo [%DATE% %TIME%] wrapper started\r\n")
            .unwrap();
        let start = script.find("start \"\" /b ").unwrap();
        let errorlevel = script
            .find(">>\"%~dpn0.trace.log\" echo [%DATE% %TIME%] start errorlevel=%ERRORLEVEL%\r\n")
            .unwrap();
        assert!(started < start && start < errorlevel);
        // start 那一行不重定向：Codex 的标准输出 / 错误保持原样。
        let start_line = script[start..].lines().next().unwrap();
        assert!(!start_line.contains('>'));
        assert!(script.ends_with("endlocal\r\n"));
    }

    #[test]
    fn wrapper_trace_is_only_read_when_written_by_this_launch() {
        let temp = tempfile::tempdir().unwrap();
        let wrapper = temp.path().join(MAIN_WRAPPER_FILE_NAME);
        let trace = main_wrapper_trace_path(&wrapper);
        assert_eq!(trace, temp.path().join("packaged-launch-main.trace.log"));

        let before = std::time::SystemTime::now();
        assert_eq!(read_main_wrapper_trace(&wrapper, before), None);
        std::fs::write(&trace, "[x] wrapper started\r\n[x] start errorlevel=0\r\n").unwrap();
        assert_eq!(
            read_main_wrapper_trace(&wrapper, before).as_deref(),
            Some("[x] wrapper started\r\n[x] start errorlevel=0")
        );
        // 上一次留下的轨迹不算这次执行过。
        let later = std::time::SystemTime::now() + Duration::from_secs(60);
        assert_eq!(read_main_wrapper_trace(&wrapper, later), None);
    }

    #[test]
    fn activation_script_can_watch_codex_processes_while_waiting_for_the_port() {
        let script = activation_script_watching(
            AUMID,
            Path::new(r"C:\s\w.cmd"),
            Some(9229),
            Some("ChatGPT"),
        )
        .unwrap();
        let init = script.find("$seen = @{}; $ready = $false;").unwrap();
        let sample = script
            .find("Get-Process -Name 'ChatGPT' -ErrorAction SilentlyContinue")
            .unwrap();
        let connect = script.find("ConnectAsync('127.0.0.1', 9229)").unwrap();
        assert!(init < sample && sample < connect);
        assert!(script.ends_with(
            "\"PORT_READY=$([int]$ready)\"; \"SEEN_PIDS=$(@($seen.Keys | Sort-Object) -join ',')\""
        ));
        // 进程名同样走单引号字面量转义。
        let quoted =
            activation_script_watching(AUMID, Path::new(r"C:\s\w.cmd"), Some(9229), Some("a'b"))
                .unwrap();
        assert!(quoted.contains("Get-Process -Name 'a''b'"));
        // 不等端口（多开）时不观察。
        let no_wait =
            activation_script_watching(AUMID, Path::new(r"C:\s\w.cmd"), None, Some("ChatGPT"))
                .unwrap();
        assert!(!no_wait.contains("SEEN_PIDS"));
        assert!(!no_wait.contains("Get-Process"));
        // 原入口保持原样。
        let plain = activation_script(AUMID, Path::new(r"C:\s\w.cmd"), Some(9229)).unwrap();
        assert!(!plain.contains("SEEN_PIDS"));
    }

    #[test]
    fn activation_report_parses_seen_process_ids() {
        let report = PackageContextActivation::from_output(
            Vec::new(),
            Some(0),
            0,
            "HOST=5.1;X64=True\r\nPORT_READY=0\r\nSEEN_PIDS=31144,x,28480,0\r\n",
        );
        assert_eq!(report.seen_process_ids, Some(vec![28480, 31144]));
        let none_seen = PackageContextActivation::from_output(
            Vec::new(),
            Some(0),
            0,
            "PORT_READY=0\r\nSEEN_PIDS=",
        );
        assert_eq!(none_seen.seen_process_ids, Some(Vec::new()));
        // 标记行不算错误输出。
        assert_eq!(none_seen.failure_detail(), "（无错误输出）");
        let not_watched =
            PackageContextActivation::from_output(Vec::new(), Some(0), 0, "PORT_READY=1");
        assert_eq!(not_watched.seen_process_ids, None);
    }

    #[test]
    fn package_context_observation_summarizes_wrapper_and_new_processes() {
        assert_eq!(
            package_context_launch_observation(Some(&[]), false),
            "未见 wrapper 执行轨迹，期间未出现新的 Codex 进程"
        );
        assert_eq!(
            package_context_launch_observation(Some(&[1, 2, 3]), true),
            "wrapper 已执行，期间出现过 3 个新 Codex 进程"
        );
        assert_eq!(
            package_context_launch_observation(None, true),
            "wrapper 已执行"
        );
    }
}
