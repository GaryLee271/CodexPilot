use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use anyhow::Context;
use fs2::FileExt;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

type SettingsChangeListener = Box<dyn Fn() + Send + Sync>;

/// 管理器之外（Codex 设置页经桥接 `/settings/set`）写入设置后的通知钩子。
/// core 不依赖 Tauri：管理器启动时注册监听，再转成界面事件让主窗口重新读取。
/// 管理器自己的保存不走这里，免得刷新冲掉它尚未保存的编辑。
static EXTERNAL_SETTINGS_CHANGE_LISTENER: std::sync::Mutex<Option<SettingsChangeListener>> =
    std::sync::Mutex::new(None);

pub fn set_external_settings_change_listener(listener: impl Fn() + Send + Sync + 'static) {
    if let Ok(mut slot) = EXTERNAL_SETTINGS_CHANGE_LISTENER.lock() {
        *slot = Some(Box::new(listener));
    }
}

pub fn notify_external_settings_change() {
    if let Ok(slot) = EXTERNAL_SETTINGS_CHANGE_LISTENER.lock() {
        if let Some(listener) = slot.as_ref() {
            listener();
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct RelayHeaderKeyValue {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct BackendSettings {
    /// 读取快照的版本，只用于条件保存，不写入 settings.json。
    #[serde(rename = "revision", default, skip_serializing_if = "String::is_empty")]
    pub settings_revision: String,
    #[serde(rename = "codexAppPath", default)]
    pub codex_app_path: String,
    /// 自动接管官方 App：开启后用户自己双击启动官方 App 时由 Codex Pilot 接管并注入。
    #[serde(rename = "codexAppAutoTakeover", default)]
    pub codex_app_auto_takeover: bool,
    /// 已在运行的官方 App 没有调试端口时、「疑似有人在用」的策略：
    /// `defer`（默认：先不动，等空闲或用户手动触发）或 `immediate`（立即重启接管）。
    ///
    /// 显式写默认值而不是留空串：留空串虽然 `ActivePolicy::parse` 也按 `defer` 处理，
    /// 但读配置的人（以及前端默认值）会以为「没设置」，两边容易漂移。
    #[serde(
        rename = "codexAppAutoTakeoverWhenActive",
        default = "default_auto_takeover_when_active"
    )]
    pub codex_app_auto_takeover_when_active: String,
    #[serde(rename = "enhancementsEnabled", default = "default_true")]
    pub enhancements_enabled: bool,
    /// 管理器启动时及运行期间自动检查 Codex Pilot 更新（#1272）。默认开；
    /// 关闭后只在用户手动点「检查更新」时联网检查。
    #[serde(rename = "updateAutoCheck", default = "default_true")]
    pub update_auto_check: bool,
    /// 用户在更新提示里选择「跳过此版本」的版本号（#1272）。只压制该版本及更低版本的自动提示，
    /// 出现更高版本时重新提示；手动检查不受影响。空串表示没有跳过。
    #[serde(rename = "updateSkippedVersion", default)]
    pub update_skipped_version: String,
    #[serde(rename = "codexAppNativeMenuPlacement", default = "default_true")]
    pub codex_app_native_menu_placement: bool,
    #[serde(rename = "codexAppNativeBrowserRequireIdentification", default)]
    pub codex_app_native_browser_require_identification: bool,
    #[serde(rename = "codexAppNativeFastUnlock", default)]
    pub codex_app_native_fast_unlock: bool,
    /// 原生项目分区：默认关闭；API 模式只使用独立本地存储，不关联账号或同步分区。
    #[serde(rename = "codexAppNativeProjectSections", default)]
    pub codex_app_native_project_sections: bool,
    /// 主窗口本地对话标签栏：默认关闭，热切换，标签只保存在客户端本机。
    #[serde(rename = "codexAppConversationTabs", default)]
    pub codex_app_conversation_tabs: bool,
    /// 跨项目会话列表：默认关闭，热切换；数据只读本机会话索引与项目索引。
    #[serde(rename = "codexAppConversationList", default)]
    pub codex_app_conversation_list: bool,
    /// 原生输入预测（实验）：自定义 API 的本机对话使用 Codex 自带的灰字预测与 Tab 接受。默认关。
    #[serde(rename = "codexAppNativePredictions", default)]
    pub codex_app_native_predictions: bool,
    /// 预测专用模型；空串继承源对话，始终使用源对话的供应商。
    #[serde(rename = "codexAppNativePredictionsModel", default)]
    pub codex_app_native_predictions_model: String,
    #[serde(rename = "codexGoalsEnabled", default)]
    pub codex_goals_enabled: bool,
}

impl Default for BackendSettings {
    fn default() -> Self {
        Self {
            settings_revision: String::new(),
            codex_app_path: String::new(),
            codex_app_auto_takeover: false,
            codex_app_auto_takeover_when_active: default_auto_takeover_when_active(),
            enhancements_enabled: true,
            update_auto_check: true,
            update_skipped_version: String::new(),
            codex_app_native_menu_placement: true,
            codex_app_native_browser_require_identification: false,
            codex_app_native_fast_unlock: false,
            codex_app_native_project_sections: false,
            codex_app_conversation_tabs: false,
            codex_app_conversation_list: false,
            codex_app_native_predictions: false,
            codex_app_native_predictions_model: String::new(),
            codex_goals_enabled: false,
        }
    }
}

impl BackendSettings {
    /// 增强功能始终读取 Codex 当前配置，不维护供应商列表。
    pub fn active_relay_profile(&self) -> crate::native_config::CodexConnection {
        crate::native_config::current_profile()
    }
}

pub fn default_true() -> bool {
    true
}

/// 「疑似有人在用」的默认策略：先不动，等空闲或用户手动触发。
pub fn default_auto_takeover_when_active() -> String {
    crate::auto_takeover::ActivePolicy::Defer
        .as_str()
        .to_string()
}

#[derive(Debug, Clone)]
pub struct SettingsStore {
    path: PathBuf,
}

struct SettingsFileLock(File);

impl Drop for SettingsFileLock {
    fn drop(&mut self) {
        // 并发启动子进程可能继承句柄；事务结束时主动解锁，不能只等最后一个句柄关闭。
        let _ = FileExt::unlock(&self.0);
    }
}

/// 配置不应承载无界的转义膨胀或文件内容。超限时只报错，不覆盖原文件。
pub const MAX_SETTINGS_FILE_BYTES: usize = 16 * 1024 * 1024;

fn serialize_settings_bounded(value: &impl serde::Serialize) -> anyhow::Result<Vec<u8>> {
    struct BoundedWriter(Vec<u8>);
    impl Write for BoundedWriter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if bytes.len() > MAX_SETTINGS_FILE_BYTES.saturating_sub(self.0.len()) {
                return Err(std::io::Error::other(
                    "settings 超过 16 MiB 上限，原文件未修改",
                ));
            }
            self.0.extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut writer = BoundedWriter(Vec::new());
    serde_json::to_writer_pretty(&mut writer, value)?;
    Ok(writer.0)
}

impl Default for SettingsStore {
    fn default() -> Self {
        Self::new(crate::paths::default_settings_path())
    }
}

impl SettingsStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    fn write_lock(&self) -> anyhow::Result<SettingsFileLock> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        // 锁文件保持稳定，不能锁会被 atomic rename 替换的 settings inode。
        let path = self.path.with_extension("json.lock");
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(path)?;
        file.lock_exclusive().context("获取设置写锁失败")?;
        Ok(SettingsFileLock(file))
    }

    pub fn revision(&self) -> anyhow::Result<String> {
        Ok(settings_revision(
            self.read_contents()?.as_deref().map(str::as_bytes),
        ))
    }

    /// 读取并归一化增强设置。
    pub fn load(&self) -> anyhow::Result<BackendSettings> {
        let contents = match self.read_contents()? {
            Some(contents) => contents,
            None => {
                let mut settings = BackendSettings::default();
                settings.settings_revision = settings_revision(None);
                return Ok(settings);
            }
        };

        let mut parsed: BackendSettings = serde_json::from_str(&contents).with_context(|| {
            format!(
                "settings {} 解析失败，拒绝退回默认设置以免覆盖用户配置",
                self.path.display()
            )
        })?;
        parsed.settings_revision = settings_revision(Some(contents.as_bytes()));
        Ok(parsed)
    }

    pub fn save(&self, settings: &BackendSettings) -> anyhow::Result<()> {
        self.save_versioned(settings).map(|_| ())
    }

    pub fn save_versioned(&self, settings: &BackendSettings) -> anyhow::Result<String> {
        self.save_with_commit(settings, |_| Ok(()))
    }

    /// 持有同一个跨进程锁发布关联产物；失败时仅恢复仍属于本提交的设置。
    pub fn save_with_commit(
        &self,
        settings: &BackendSettings,
        publish: impl FnOnce(&str) -> anyhow::Result<()>,
    ) -> anyhow::Result<String> {
        self.save_with_prepared_commit(settings, |_| Ok(()), publish)
    }

    pub(crate) fn save_with_prepared_commit(
        &self,
        settings: &BackendSettings,
        prepare: impl FnOnce(&str) -> anyhow::Result<()>,
        publish: impl FnOnce(&str) -> anyhow::Result<()>,
    ) -> anyhow::Result<String> {
        let _lock = self.write_lock()?;
        let revision = self.revision()?;
        if settings.settings_revision != revision
            && !(settings.settings_revision.is_empty() && revision == "missing")
        {
            anyhow::bail!(
                "settings_revision_conflict：设置已被其他操作更新，请重载后合并；原文件未修改"
            );
        }
        let before = self.snapshot_raw_bytes()?;
        let bytes = self.prepare_save_bytes(settings)?;
        let committed = settings_revision(Some(&bytes));
        prepare(&committed)?;
        atomic_write(&self.path, &bytes)?;
        if let Err(error) = publish(&committed) {
            if self.revision()? != committed {
                anyhow::bail!("关联产物发布失败：{error}；设置已被外部修改，未覆盖新数据");
            }
            match before {
                Some(bytes) => atomic_write(&self.path, &bytes)?,
                None => {
                    fs::remove_file(&self.path)?;
                }
            }
            return Err(error).context("关联产物发布失败，设置已恢复");
        }
        Ok(committed)
    }

    fn prepare_save_bytes(&self, settings: &BackendSettings) -> anyhow::Result<Vec<u8>> {
        self.load_raw_object()?;
        serialize_settings_bounded(settings)?;
        let settings = settings.clone();
        let mut next = settings_to_object(&settings);
        next.remove("revision");
        serialize_settings_bounded(&Value::Object(next))
    }

    /// 内部事务的原始字节快照；不得把读错伪装成缺失文件。
    pub(crate) fn snapshot_raw_bytes(&self) -> anyhow::Result<Option<Vec<u8>>> {
        let Some(contents) = self.read_contents()? else {
            return Ok(None);
        };
        let bytes = contents.into_bytes();
        validate_settings_snapshot(&bytes)?;
        Ok(Some(bytes))
    }

    /// 仅供已捕获原始状态的内部事务回滚。
    #[cfg(test)]
    /// None 只能来自事务开始时文件不存在的快照，删除本次新建的 settings 文件。
    pub(crate) fn restore_raw_snapshot(
        &self,
        snapshot: Option<&[u8]>,
        expected_revision: &str,
    ) -> anyhow::Result<()> {
        let _lock = self.write_lock()?;
        if self.revision()? != expected_revision {
            anyhow::bail!("settings_revision_conflict：回滚期间设置已有新变化，未覆盖新数据");
        }
        // 本操作写出的文件也受预算约束；超限的当前文件可能是外部新写入，不能覆盖。
        self.read_contents()?;
        match snapshot {
            Some(bytes) => {
                validate_settings_snapshot(bytes)?;
                atomic_write(&self.path, bytes)
            }
            None => match fs::remove_file(&self.path) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(error) => Err(error).context("恢复缺失 settings 文件状态失败"),
            },
        }
    }

    pub fn update(&self, payload: Value) -> anyhow::Result<BackendSettings> {
        let Value::Object(payload) = payload else {
            return self.load();
        };
        let _lock = self.write_lock()?;
        if let Some(expected) = payload.get("revision") {
            let expected = expected
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("revision 必须是字符串"))?;
            if expected != self.revision()? {
                anyhow::bail!("settings_revision_conflict：设置已被其他操作更新，补丁未应用");
            }
        }

        serialize_settings_bounded(&payload)?;
        let mut raw = self.load_raw_object()?;
        merge_known_setting_fields(&mut raw, &payload);
        serialize_settings_bounded(&raw)?;
        let candidate: BackendSettings = serde_json::from_value(Value::Object(raw.clone()))?;
        let mut settings = candidate;
        raw = settings_to_object(&settings);
        raw.remove("revision");
        let bytes = serialize_settings_bounded(&Value::Object(raw))?;
        atomic_write(&self.path, &bytes)?;
        settings.settings_revision = settings_revision(Some(&bytes));
        Ok(settings)
    }

    fn load_raw_object(&self) -> anyhow::Result<Map<String, Value>> {
        let contents = match self.read_contents()? {
            Some(contents) => contents,
            None => {
                return Ok(settings_to_object(&BackendSettings::default()));
            }
        };

        match serde_json::from_str::<Value>(&contents) {
            Ok(Value::Object(map)) => Ok(map),
            Ok(_) => Err(anyhow::anyhow!(
                "settings {} 顶层不是 JSON 对象，拒绝用默认值覆盖",
                self.path.display()
            )),
            Err(error) => Err(error).with_context(|| {
                format!(
                    "settings {} 解析失败，拒绝用默认值覆盖；请先修复该文件",
                    self.path.display()
                )
            }),
        }
    }

    fn read_contents(&self) -> anyhow::Result<Option<String>> {
        let file = match File::open(&self.path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error).context("failed to open settings"),
        };
        let reject_large_file = || {
            anyhow::anyhow!(
                "settings {} 超过 16 MiB 上限，拒绝读取或覆盖；请保留原文件并先修复",
                self.path.display()
            )
        };
        let length = file.metadata()?.len();
        if length > MAX_SETTINGS_FILE_BYTES as u64 {
            return Err(reject_large_file());
        }
        let mut bytes = Vec::with_capacity(length as usize);
        // metadata 检查后文件仍可能增长，实际读取也必须有上限。
        file.take(MAX_SETTINGS_FILE_BYTES as u64 + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() > MAX_SETTINGS_FILE_BYTES {
            return Err(reject_large_file());
        }
        Ok(Some(
            String::from_utf8(bytes).context("settings 不是有效 UTF-8，原文件未修改")?,
        ))
    }
}

fn validate_settings_snapshot(bytes: &[u8]) -> anyhow::Result<()> {
    if bytes.len() > MAX_SETTINGS_FILE_BYTES {
        anyhow::bail!("settings 快照超过 16 MiB 上限，原文件未修改");
    }
    if !serde_json::from_slice::<Value>(bytes)
        .context("settings 快照不是有效 JSON，原文件未修改")?
        .is_object()
    {
        anyhow::bail!("settings 快照顶层不是 JSON 对象，原文件未修改");
    }
    Ok(())
}

fn merge_known_setting_fields(target: &mut Map<String, Value>, source: &Map<String, Value>) {
    if let Some(value) = source.get("codexAppPath").and_then(Value::as_str) {
        target.insert("codexAppPath".to_string(), Value::String(value.to_string()));
    }
    // 自动接管的开关与策略也走同一份 settings.json；漏掉这两行会让开关「保存了但没生效」。
    if let Some(value) = source.get("codexAppAutoTakeover").and_then(Value::as_bool) {
        target.insert("codexAppAutoTakeover".to_string(), Value::Bool(value));
    }
    if let Some(value) = source
        .get("codexAppAutoTakeoverWhenActive")
        .and_then(Value::as_str)
    {
        target.insert(
            "codexAppAutoTakeoverWhenActive".to_string(),
            Value::String(value.to_string()),
        );
    }
    // 协议代理自动重试：管理器整份保存也会经过 normalize，这里补上部分更新路径，
    // 保证任何走 /settings/set 的调用都不会被静默丢弃。
    // Codex Pilot 更新提醒偏好（#1272）：「跳过此版本」由管理器单独写入，必须在白名单里。
    merge_bool_setting(target, source, "updateAutoCheck");
    if let Some(value) = source.get("updateSkippedVersion").and_then(Value::as_str) {
        target.insert(
            "updateSkippedVersion".to_string(),
            Value::String(value.trim().to_string()),
        );
    }
    // 目录外模型映射开关同上：漏登记会让 /settings/set 补丁「保存了但没生效」。

    if let Some(value) = source.get("enhancementsEnabled").and_then(Value::as_bool) {
        target.insert("enhancementsEnabled".to_string(), Value::Bool(value));
    }
    merge_bool_setting(target, source, "codexAppNativeMenuPlacement");
    merge_bool_setting(target, source, "codexAppNativeBrowserRequireIdentification");
    merge_bool_setting(target, source, "codexAppNativeFastUnlock");
    merge_bool_setting(target, source, "codexAppNativePredictions");
    // 管理器和客户端均通过部分更新保存开关，必须同步登记到合并白名单。
    merge_bool_setting(target, source, "codexAppNativeProjectSections");
    merge_bool_setting(target, source, "codexAppConversationTabs");
    merge_bool_setting(target, source, "codexAppConversationList");
    if let Some(value) = source.get("codexAppNativePredictionsModel").and_then(Value::as_str) {
        target.insert(
            "codexAppNativePredictionsModel".to_string(),
            Value::String(value.trim().to_string()),
        );
    }
    if let Some(value) = source.get("codexGoalsEnabled").and_then(Value::as_bool) {
        target.insert("codexGoalsEnabled".to_string(), Value::Bool(value));
    }
}

fn merge_bool_setting(target: &mut Map<String, Value>, source: &Map<String, Value>, key: &str) {
    if let Some(value) = source.get(key).and_then(Value::as_bool) {
        target.insert(key.to_string(), Value::Bool(value));
    }
}

fn settings_to_object(settings: &BackendSettings) -> Map<String, Value> {
    match serde_json::to_value(settings).unwrap_or_else(|_| Value::Object(Map::new())) {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

fn settings_revision(bytes: Option<&[u8]>) -> String {
    bytes
        .map(|bytes| format!("sha256:{:x}", Sha256::digest(bytes)))
        .unwrap_or_else(|| "missing".to_string())
}

/// 逐级解析软链接（最多 16 层，防环），返回最终目标路径；不是软链接时返回 None。
fn resolve_symlink_target(path: &Path) -> Option<PathBuf> {
    let mut current = path.to_path_buf();
    let mut resolved = false;
    for _ in 0..16 {
        let Ok(metadata) = fs::symlink_metadata(&current) else {
            break;
        };
        if !metadata.file_type().is_symlink() {
            break;
        }
        let Ok(target) = fs::read_link(&current) else {
            break;
        };
        current = if target.is_absolute() {
            target
        } else {
            current
                .parent()
                .map(|parent| parent.join(&target))
                .unwrap_or(target)
        };
        resolved = true;
    }
    resolved.then_some(current)
}

pub fn atomic_write(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    atomic_write_with(path, |file| file.write_all(bytes))
}

/// 流式原子写入：内容由 `write_contents` 直接写进临时文件，调用方不必先把
/// 完整字节拼在内存里。大文件（如历史会话的 rollout JSONL）走这条路径。
pub fn atomic_write_with(
    path: &Path,
    write_contents: impl FnOnce(&mut File) -> std::io::Result<()>,
) -> anyhow::Result<()> {
    // 目标是软链接时（常见于把 ~/.codex/config.toml 链到 dotfiles 仓库），
    // 原子替换要落在链接指向的真实文件上；直接 rename 会把链接本身换成普通文件，
    // 链接被悄悄断开，dotfiles 里的原文件不再更新。
    let resolved = resolve_symlink_target(path);
    let path = resolved.as_deref().unwrap_or(path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create directory {}", parent.display()))?;
    }

    // 保留原文件权限：临时文件默认权限不一定和它一致。
    let existing_permissions = match fs::metadata(path) {
        Ok(metadata) => Some(metadata.permissions()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => {
            return Err(error)
                .with_context(|| format!("failed to read permissions for {}", path.display()));
        }
    };
    let temp_path = temp_path_for(path);
    let write_result = (|| -> std::io::Result<()> {
        let mut temp_file = File::create(&temp_path)?;
        write_contents(&mut temp_file)?;
        temp_file.flush()?;
        if let Some(permissions) = existing_permissions {
            temp_file.set_permissions(permissions)?;
        }
        // rename 前必须落盘：只 flush 时内容可能还在页缓存里，断电或蓝屏后会留下
        // 已经替换成功、内容却全是 NUL 的 config.toml（#2450）。
        temp_file.sync_all()?;
        Ok(())
    })();
    if let Err(error) = write_result {
        let _ = fs::remove_file(&temp_path);
        return Err(error)
            .with_context(|| format!("failed to write temp file {}", temp_path.display()));
    }
    if let Err(error) = replace_file(&temp_path, path) {
        let _ = fs::remove_file(&temp_path);
        return Err(error).with_context(|| {
            format!(
                "failed to replace {} with {}",
                path.display(),
                temp_path.display()
            )
        });
    }
    Ok(())
}

#[cfg(not(windows))]
fn replace_file(source: &Path, target: &Path) -> anyhow::Result<()> {
    fs::rename(source, target)?;
    Ok(())
}

#[cfg(windows)]
fn replace_file(source: &Path, target: &Path) -> anyhow::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };
    use windows::core::PCWSTR;

    let source = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let target = target
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    // Codex 客户端 / 杀毒软件可能短暂持有目标文件的读句柄，MoveFileExW 会以
    // ERROR_ACCESS_DENIED / ERROR_SHARING_VIOLATION 失败。一次失败就让整次
    // 供应商切换报错对用户表现为「无法切换和保存供应商」（#2601 / #2500 /
    // #2612）。短退避重试几次，仍失败再把错误上抛。
    let mut last_error = None;
    for attempt in 0..6 {
        match unsafe {
            MoveFileExW(
                PCWSTR(source.as_ptr()),
                PCWSTR(target.as_ptr()),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        } {
            Ok(()) => return Ok(()),
            Err(error) => last_error = Some(error),
        }
        std::thread::sleep(std::time::Duration::from_millis(50 * (attempt + 1)));
    }
    Err(last_error
        .map(anyhow::Error::from)
        .unwrap_or_else(|| anyhow::anyhow!("替换文件失败")))
}

fn temp_path_for(path: &Path) -> PathBuf {
    let mut temp_path = path.to_path_buf();
    let extension = path.extension().and_then(|value| value.to_str());
    temp_path.set_extension(match extension {
        Some(extension) => format!("{extension}.tmp"),
        None => "tmp".to_string(),
    });
    temp_path
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[cfg(unix)]
    #[test]
    fn atomic_write_keeps_symlink_and_updates_its_target() {
        let temp = tempfile::tempdir().unwrap();
        let dotfiles = temp.path().join("dotfiles");
        std::fs::create_dir_all(&dotfiles).unwrap();
        let target = dotfiles.join("config.toml");
        std::fs::write(&target, "model = \"old\"\n").unwrap();
        let home = temp.path().join(".codex");
        std::fs::create_dir_all(&home).unwrap();
        let link = home.join("config.toml");
        std::os::unix::fs::symlink("../dotfiles/config.toml", &link).unwrap();

        atomic_write(&link, b"model = \"new\"\n").unwrap();

        assert!(
            std::fs::symlink_metadata(&link)
                .unwrap()
                .file_type()
                .is_symlink(),
            "软链接不能被替换成普通文件"
        );
        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            "model = \"new\"\n"
        );
        let leftovers: Vec<_> = std::fs::read_dir(&home)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.file_name())
            .collect();
        assert_eq!(
            leftovers.len(),
            1,
            "链接所在目录不应残留临时文件：{leftovers:?}"
        );
    }
    /// 每次新建一个随机命名的空目录。不能用「进程号 + 计数器」命名：目录不会删除，
    /// 进程号复用后会撞上上次留下的 settings.json，保存时报 settings_revision_conflict。
    fn temp_dir() -> std::path::PathBuf {
        tempfile::Builder::new()
            .prefix("codex-plus-core-settings-test-")
            .tempdir()
            .unwrap()
            .keep()
    }

    #[test]
    fn atomic_write_replaces_existing_file_and_removes_temp_file() {
        let dir = temp_dir();
        let path = dir.join("settings.json");
        std::fs::write(&path, b"old").unwrap();

        atomic_write(&path, b"new").unwrap();

        assert_eq!(std::fs::read(&path).unwrap(), b"new");
        assert!(!dir.join("settings.json.tmp").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn settings_deserialize_discards_retired_codex_extra_args() {
        let settings: BackendSettings = serde_json::from_str(
            r#"{"codexExtraArgs":["--force_high_performance_gpu"," --ignored-trimmed-by-ui "]}"#,
        )
        .unwrap();

        let saved = serde_json::to_value(settings).unwrap();
        assert!(saved.get("codexExtraArgs").is_none());
    }

    fn normalized_default_settings() -> BackendSettings {
        // Keep expected values independent of the production normalizer.
        BackendSettings::default()
    }

    #[test]
    fn settings_store_load_missing_file_returns_default() {
        let dir = temp_dir();
        let store = SettingsStore::new(dir.join("settings.json"));

        let mut expected = normalized_default_settings();
        expected.settings_revision = "missing".into();
        assert_eq!(store.load().unwrap(), expected);
    }

    /// 坏 JSON 不再静默退回默认设置：解析失败必须报错，避免拿默认值把磁盘上的
    /// 供应商列表覆盖掉。原文件内容必须原样保留。
    #[test]
    fn settings_store_load_bad_json_returns_error_and_keeps_file() {
        let dir = temp_dir();
        let path = dir.join("settings.json");
        std::fs::write(&path, "{bad json").unwrap();
        let store = SettingsStore::new(path.clone());

        let error = store
            .load()
            .expect_err("坏 JSON 必须报错，而不是退回默认值");
        assert!(
            error.to_string().contains("解析失败"),
            "错误信息应指出解析失败，实际是: {error}"
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{bad json");
        assert!(store.save(&BackendSettings::default()).is_err());
        assert!(store.update(json!({"providerSyncEnabled": false})).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{bad json");
    }

    #[test]
    fn settings_store_rejects_oversized_existing_file_without_overwriting() {
        let dir = temp_dir();
        let path = dir.join("settings.json");
        let mut file = File::create(&path).unwrap();
        file.write_all(b"keep-original").unwrap();
        file.set_len(MAX_SETTINGS_FILE_BYTES as u64 + 1).unwrap();
        let store = SettingsStore::new(path.clone());

        for error in [
            store.load().unwrap_err(),
            store.save(&BackendSettings::default()).unwrap_err(),
            store
                .update(json!({"providerSyncEnabled": false}))
                .unwrap_err(),
            store.snapshot_raw_bytes().unwrap_err(),
            store
                .restore_raw_snapshot(Some(b"{}".as_slice()), "invalid")
                .unwrap_err(),
        ] {
            assert!(error.to_string().contains("16 MiB"));
        }
        assert_eq!(
            fs::metadata(&path).unwrap().len(),
            MAX_SETTINGS_FILE_BYTES as u64 + 1
        );
        let mut prefix = [0_u8; 13];
        File::open(&path).unwrap().read_exact(&mut prefix).unwrap();
        assert_eq!(&prefix, b"keep-original");
    }

    #[test]
    fn settings_store_prediction_model_round_trip() {
        let dir = temp_dir();
        let path = dir.join("settings.json");
        let store = SettingsStore::new(path.clone());
        assert!(
            store
                .load()
                .unwrap()
                .codex_app_native_predictions_model
                .is_empty()
        );
        let updated = store
            .update(json!({
                "codexAppNativePredictions": true,
                "codexAppNativePredictionsModel": "  vendor/fast-model  ",
            }))
            .unwrap();
        assert_eq!(
            updated.codex_app_native_predictions_model,
            "vendor/fast-model"
        );
        assert!(updated.codex_app_native_predictions);
        assert_eq!(
            store.load().unwrap().codex_app_native_predictions_model,
            "vendor/fast-model"
        );
        store
            .update(json!({ "codexAppNativePredictionsModel": "   " }))
            .unwrap();
        let saved = store.load().unwrap();
        assert!(saved.codex_app_native_predictions_model.is_empty());
        assert!(saved.codex_app_native_predictions);
    }

    #[test]
    fn settings_store_update_removes_obsolete_setting_fields() {
        let dir = temp_dir();
        let path = dir.join("settings.json");
        let store = SettingsStore::new(path.clone());
        std::fs::write(
            &path,
            r#"{"providerSyncEnabled":false,"codexAppPluginAutoExpand":true,"computerUseGuardEnabled":true,"customField":1}"#,
        )
        .unwrap();

        store
            .update(json!({
                "providerSyncEnabled": true
            }))
            .unwrap();
        let saved: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();

        assert!(saved.get("codexAppPluginAutoExpand").is_none());
        assert!(saved.get("computerUseGuardEnabled").is_none());
        assert!(saved.get("customField").is_none());
    }

    #[test]
    fn settings_store_update_discards_retired_codex_extra_args_and_unknown_fields() {
        let dir = temp_dir();
        let path = dir.join("settings.json");
        let store = SettingsStore::new(path.clone());
        std::fs::write(
            &path,
            r#"{"codexExtraArgs":["--old-flag"],"codexAppNativeProjectSections":true,"customField":{"nested":true}}"#,
        )
        .unwrap();

        let updated = store
            .update(json!({
                "codexExtraArgs": ["--force_high_performance_gpu", "--enable-features=UseOzonePlatform"]
            }))
            .unwrap();
        let saved: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();

        assert!(
            serde_json::to_value(&updated)
                .unwrap()
                .get("codexExtraArgs")
                .is_none()
        );
        assert!(saved.get("codexExtraArgs").is_none());
        assert!(updated.codex_app_native_project_sections);
        assert_eq!(saved["codexAppNativeProjectSections"], true);
        assert!(saved.get("customField").is_none());
    }

    #[test]
    fn raw_settings_snapshot_restores_original_bytes_and_rejects_invalid_input() {
        let dir = temp_dir();
        let path = dir.join("settings.json");
        let original = b"{\n \"providerSyncEnabled\":false,\"unknownFutureField\":{\"x\":1}}\n";
        fs::write(&path, original).unwrap();
        let store = SettingsStore::new(path.clone());
        let snapshot = store.snapshot_raw_bytes().unwrap();
        fs::write(&path, b"{\"providerSyncEnabled\":true}").unwrap();
        store
            .restore_raw_snapshot(snapshot.as_deref(), &store.revision().unwrap())
            .unwrap();
        assert_eq!(fs::read(&path).unwrap(), original);
        for invalid in [b"{broken".as_slice(), b"[]".as_slice()] {
            assert!(
                store
                    .restore_raw_snapshot(Some(invalid), &store.revision().unwrap())
                    .is_err()
            );
            assert_eq!(fs::read(&path).unwrap(), original);
        }
        let oversized = vec![b' '; MAX_SETTINGS_FILE_BYTES + 1];
        assert!(
            store
                .restore_raw_snapshot(Some(&oversized), &store.revision().unwrap())
                .is_err()
        );
        assert_eq!(fs::read(&path).unwrap(), original);
    }

    #[test]
    fn raw_settings_snapshot_restores_a_previously_absent_file() {
        let dir = temp_dir();
        let path = dir.join("settings.json");
        let store = SettingsStore::new(path.clone());
        assert!(store.snapshot_raw_bytes().unwrap().is_none());
        store.save(&BackendSettings::default()).unwrap();
        store
            .restore_raw_snapshot(None, &store.revision().unwrap())
            .unwrap();
        assert!(!path.exists());
    }

    // 自动接管的两个设置字段必须走既有 settings.json 链路持久化：
    // 守护线程在另一个线程里读同一个文件，写不进就等于开关无效。
    #[test]
    fn auto_takeover_settings_round_trip_through_settings_file() {
        let temp = tempfile::tempdir().unwrap();
        let store = SettingsStore::new(temp.path().join("settings.json"));

        let initial = BackendSettings::default();
        assert!(!initial.codex_app_auto_takeover);
        assert_eq!(
            initial.codex_app_auto_takeover_when_active,
            default_auto_takeover_when_active()
        );
        assert_eq!(initial.codex_app_auto_takeover_when_active, "defer");
        store.save(&initial).unwrap();

        let updated = store
            .update(json!({
                "codexAppAutoTakeover": true,
                "codexAppAutoTakeoverWhenActive": "immediate"
            }))
            .unwrap();
        assert!(updated.codex_app_auto_takeover);
        assert_eq!(updated.codex_app_auto_takeover_when_active, "immediate");

        // 重新读盘：字段名必须与前端/守护线程约定的一致（camelCase）。
        let reloaded = store.load().unwrap();
        assert!(reloaded.codex_app_auto_takeover);
        assert_eq!(reloaded.codex_app_auto_takeover_when_active, "immediate");
    }
}
