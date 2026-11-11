use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

const APP_STATE_DIR: &str = ".codex-session-delete";
const SETTINGS_FILE: &str = "settings.json";
const SETTINGS_PATH_POINTER_FILE: &str = "settings.path";
const LATEST_STATUS_FILE: &str = "latest-status.json";
const DIAGNOSTIC_LOG_FILE: &str = "codex-plus.log";
const PENDING_MANAGER_NAVIGATION_FILE: &str = "pending-manager-navigation.json";

/// 显式指定状态目录，用于本地构建和测试隔离。
pub const STATE_DIR_ENV: &str = "CODEX_PLUS_STATE_DIR";

/// 解析显式状态目录覆盖；未设置或设置为空时返回 `None`。
pub fn state_dir_override_from(value: Option<&std::ffi::OsStr>) -> Option<PathBuf> {
    let value = value?;
    let text = value.to_string_lossy();
    let trimmed = text.trim();
    (!trimmed.is_empty()).then(|| PathBuf::from(trimmed))
}

pub fn state_dir_override() -> Option<PathBuf> {
    state_dir_override_from(std::env::var_os(STATE_DIR_ENV).as_deref())
}

pub fn default_app_state_dir() -> PathBuf {
    // 本地构建和测试使用显式目录，避免写入日常使用的设置。
    if let Some(state_dir) = state_dir_override() {
        return state_dir;
    }

    default_state_base_dir()
}

fn default_state_base_dir() -> PathBuf {
    if let Some(home_dir) = directories::BaseDirs::new().map(|dirs| dirs.home_dir().to_path_buf()) {
        return home_dir.join(APP_STATE_DIR);
    }
    PathBuf::from(APP_STATE_DIR)
}

pub fn settings_path_pointer_path() -> PathBuf {
    default_state_base_dir().with_file_name(SETTINGS_PATH_POINTER_FILE)
}

fn read_settings_path_pointer() -> Option<PathBuf> {
    let path = settings_path_pointer_path();
    let contents = fs::read_to_string(path).ok()?;
    let target = PathBuf::from(contents.trim());
    target.is_absolute().then_some(target)
}

pub fn set_settings_path_pointer(target: Option<&Path>) -> std::io::Result<()> {
    // 使用显式状态目录时不修改全局配置路径指针。
    if state_dir_override().is_some() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "当前实例使用指定状态目录，不支持修改全局配置文件路径",
        ));
    }
    let pointer = settings_path_pointer_path();
    match target {
        Some(target) => {
            if let Some(parent) = pointer.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::write(pointer, target.to_string_lossy().as_bytes())
        }
        None => match fs::remove_file(pointer) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error),
        },
    }
}

pub fn default_settings_path() -> PathBuf {
    if let Some(path) = settings_path_for_tests() {
        return path;
    }
    if state_dir_override().is_none()
        && let Some(path) = read_settings_path_pointer()
    {
        return path;
    }
    default_app_state_dir().join(SETTINGS_FILE)
}

pub fn default_latest_status_path() -> PathBuf {
    default_app_state_dir().join(LATEST_STATUS_FILE)
}

pub fn default_diagnostic_log_path() -> PathBuf {
    default_app_state_dir().join(DIAGNOSTIC_LOG_FILE)
}

pub fn default_pending_manager_navigation_path() -> PathBuf {
    default_app_state_dir().join(PENDING_MANAGER_NAVIGATION_FILE)
}

fn settings_path_for_tests() -> Option<PathBuf> {
    SETTINGS_PATH_FOR_TESTS
        .get_or_init(|| Mutex::new(None))
        .lock()
        .ok()
        .and_then(|path| path.clone())
}

static SETTINGS_PATH_FOR_TESTS: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();

#[cfg(test)]
static SETTINGS_PATH_TEST_GUARD: OnceLock<Mutex<()>> = OnceLock::new();

#[cfg(test)]
pub(crate) fn settings_path_test_guard() -> std::sync::MutexGuard<'static, ()> {
    SETTINGS_PATH_TEST_GUARD
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap()
}

pub fn set_settings_path_for_tests(path: Option<PathBuf>) -> Option<PathBuf> {
    SETTINGS_PATH_FOR_TESTS
        .get_or_init(|| Mutex::new(None))
        .lock()
        .ok()
        .and_then(|mut current| std::mem::replace(&mut *current, path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_settings_path_uses_app_state_directory() {
        let _guard = settings_path_test_guard();
        let path = default_settings_path();

        assert_eq!(path, default_app_state_dir().join(SETTINGS_FILE));
    }

    #[test]
    fn settings_path_pointer_accepts_only_absolute_targets() {
        let dir = tempfile::tempdir().unwrap();
        let pointer = dir.path().join("settings.path");
        // 用 tempdir 生成绝对路径；写死 /tmp/... 在 Windows 上没有盘符，不算绝对路径
        let target = dir.path().join("codex-settings.json");
        fs::write(&pointer, format!("{}\n", target.display())).unwrap();
        let absolute = fs::read_to_string(&pointer).unwrap();
        assert!(PathBuf::from(absolute.trim()).is_absolute());

        fs::write(&pointer, "relative/settings.json\n").unwrap();
        assert!(!PathBuf::from(fs::read_to_string(pointer).unwrap().trim()).is_absolute());
    }

    #[test]
    fn default_latest_status_path_uses_app_state_directory() {
        let _guard = settings_path_test_guard();
        let path = default_latest_status_path();

        assert_eq!(path, default_app_state_dir().join(LATEST_STATUS_FILE));
    }

    #[test]
    fn default_diagnostic_log_path_uses_app_state_directory() {
        let _guard = settings_path_test_guard();
        let path = default_diagnostic_log_path();

        assert_eq!(path, default_app_state_dir().join(DIAGNOSTIC_LOG_FILE));
    }

    #[test]
    fn default_pending_manager_navigation_path_uses_app_state_directory() {
        let _guard = settings_path_test_guard();
        let path = default_pending_manager_navigation_path();

        assert_eq!(
            path,
            default_app_state_dir().join(PENDING_MANAGER_NAVIGATION_FILE)
        );
    }

    // 状态目录覆盖不依赖平台的 HOME 解析。
    #[test]
    fn state_dir_override_accepts_non_empty_paths_only() {
        assert_eq!(
            state_dir_override_from(Some(std::ffi::OsStr::new("/tmp/instance-state"))),
            Some(PathBuf::from("/tmp/instance-state"))
        );
        assert_eq!(
            state_dir_override_from(Some(std::ffi::OsStr::new("  /tmp/padded  "))),
            Some(PathBuf::from("/tmp/padded"))
        );
        assert_eq!(
            state_dir_override_from(Some(std::ffi::OsStr::new(""))),
            None
        );
        assert_eq!(
            state_dir_override_from(Some(std::ffi::OsStr::new("   "))),
            None
        );
        assert_eq!(state_dir_override_from(None), None);
    }

    #[test]
    fn default_app_state_dir_honours_explicit_override() {
        // `CODEX_PLUS_STATE_DIR` 是进程级环境变量，用作用域守卫保证并行测试看不到它。
        let _guard = settings_path_test_guard();
        let previous = default_app_state_dir();
        let scope = StateDirEnvScope::set("/tmp/codex-plus-instance-state");

        assert_eq!(
            default_app_state_dir(),
            PathBuf::from("/tmp/codex-plus-instance-state")
        );

        drop(scope);
        assert_eq!(default_app_state_dir(), previous);
    }

    /// 测试用：临时设置 `CODEX_PLUS_STATE_DIR`，Drop 时恢复原值。
    struct StateDirEnvScope {
        previous: Option<std::ffi::OsString>,
    }

    impl StateDirEnvScope {
        fn set(value: &str) -> Self {
            let previous = std::env::var_os(STATE_DIR_ENV);
            unsafe { std::env::set_var(STATE_DIR_ENV, value) };
            Self { previous }
        }
    }

    impl Drop for StateDirEnvScope {
        fn drop(&mut self) {
            match self.previous.take() {
                Some(previous) => unsafe { std::env::set_var(STATE_DIR_ENV, previous) },
                None => unsafe { std::env::remove_var(STATE_DIR_ENV) },
            }
        }
    }
}
