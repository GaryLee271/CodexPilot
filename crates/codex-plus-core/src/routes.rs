use std::path::PathBuf;
use std::str::FromStr;
use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde_json::{Value, json};

use crate::models::SessionRef;
use crate::settings::{BackendSettings, SettingsStore};
use crate::status::StatusStore;
use crate::user_scripts::UserScriptManager;

pub type UserScriptEvaluator = Arc<dyn Fn(&str, &str) -> anyhow::Result<Value> + Send + Sync>;
pub type DevtoolsOpener = Arc<dyn Fn(&str) -> anyhow::Result<()> + Send + Sync>;

#[derive(Clone)]
pub struct BridgeContext {
    settings: Arc<dyn BridgeSettingsService>,
    runtime: Arc<dyn BridgeRuntimeService>,
    data: Arc<dyn BridgeDataService>,
}

impl BridgeContext {
    #[cfg(test)]
    pub(crate) fn with_test_settings(store: SettingsStore, app_dir: PathBuf) -> Self {
        Self::new(
            Arc::new(CoreSettingsService {
                store,
                app_dir: Some(app_dir.clone()),
            }),
            Arc::new(CoreRuntimeService::new(
                0,
                StatusStore::new(app_dir.join("status.json")),
            )),
            Arc::new(UnavailableDataService),
        )
    }

    pub fn new(
        settings: Arc<dyn BridgeSettingsService>,
        runtime: Arc<dyn BridgeRuntimeService>,
        data: Arc<dyn BridgeDataService>,
    ) -> Self {
        Self {
            settings,
            runtime,
            data,
        }
    }

    pub fn core(runtime: Arc<dyn BridgeRuntimeService>) -> Self {
        Self::core_with_data(runtime, Arc::new(UnavailableDataService))
    }

    pub fn core_with_data(
        runtime: Arc<dyn BridgeRuntimeService>,
        data: Arc<dyn BridgeDataService>,
    ) -> Self {
        Self::new(Arc::new(CoreSettingsService::default()), runtime, data)
    }

    pub fn core_with_data_and_app_dir(
        runtime: Arc<dyn BridgeRuntimeService>,
        data: Arc<dyn BridgeDataService>,
        app_dir: PathBuf,
    ) -> Self {
        Self::new(
            Arc::new(CoreSettingsService::with_app_dir(app_dir)),
            runtime,
            data,
        )
    }
}

#[async_trait]
pub trait BridgeSettingsService: Send + Sync {
    async fn get_settings(&self) -> anyhow::Result<BackendSettings>;
    async fn set_settings(&self, payload: Value) -> anyhow::Result<BackendSettings>;

    async fn codex_app_version(&self) -> anyhow::Result<String> {
        Ok(String::new())
    }
}

#[async_trait]
pub trait BridgeRuntimeService: Send + Sync {
    async fn user_script_inventory(&self) -> anyhow::Result<Value>;
    async fn user_script_inventory_with_runtime_status(
        &self,
        _payload: Value,
    ) -> anyhow::Result<Value> {
        self.user_script_inventory().await
    }
    async fn set_user_script_enabled(&self, key: String, enabled: bool) -> anyhow::Result<Value>;
    async fn reload_user_scripts(&self) -> anyhow::Result<Value>;
    async fn load_user_scripts(&self) -> anyhow::Result<Value> {
        self.user_script_inventory().await
    }
    /// 列出拓展可注入的 Codex 页面。默认关闭，具体 runtime 再接 CDP。
    async fn cdp_targets(&self) -> anyhow::Result<Value> {
        anyhow::bail!("CDP targets are unavailable")
    }
    /// 在指定 Codex 页面执行表达式。默认关闭。
    async fn cdp_evaluate(&self, _payload: Value) -> anyhow::Result<Value> {
        anyhow::bail!("CDP evaluate is unavailable")
    }
    /// 按需开启 app-server 客户端捕获（拓展的 codex/request 中间件需要）。默认不可用。
    async fn request_app_server_client_capture(&self) -> anyhow::Result<Value> {
        anyhow::bail!("app-server client capture is unavailable")
    }
    async fn open_devtools(&self) -> anyhow::Result<Value>;
    async fn open_manager(&self, payload: Value) -> anyhow::Result<Value>;
    async fn open_transient_manager(&self, payload: Value) -> anyhow::Result<Value> {
        self.open_manager(payload).await
    }
    async fn backend_status(&self) -> anyhow::Result<Value>;
    async fn codex_model_catalog(&self) -> anyhow::Result<Value>;
}

#[async_trait]
pub trait BridgeDataService: Send + Sync {
    async fn thread_usage_history(&self, session: SessionRef) -> anyhow::Result<Value>;
    /// Codex 输入框下方状态栏的轻量用量快照：只给最近的 token 事件，不返回全量历史。
    /// 内置状态栏和拓展（路由白名单里的只读项）共用。
    async fn thread_usage_live(&self, _session: SessionRef) -> anyhow::Result<Value> {
        Ok(json!({"status": "unavailable", "message": "本机用量快照暂不可用", "events": []}))
    }
    async fn find_archived_thread_by_title(
        &self,
        title: String,
    ) -> anyhow::Result<Option<SessionRef>>;
}

/// 拓展脚本在独立 Codex 页面（例如宠物 overlay）执行表达式。
/// 只走 Runtime.evaluate，且必须指定 kind 或 target_id，避免误打到管理页。
pub const EXTENSION_CDP_EXPRESSION_MAX_BYTES: usize = 256 * 1024;

fn nonempty_payload_str<'a>(payload: &'a Value, key: &str) -> Option<&'a str> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

pub async fn evaluate_extension_cdp(debug_port: u16, payload: &Value) -> anyhow::Result<Value> {
    let expression = nonempty_payload_str(payload, "expression")
        .ok_or_else(|| anyhow::anyhow!("expression 不能为空"))?;
    if expression.len() > EXTENSION_CDP_EXPRESSION_MAX_BYTES {
        anyhow::bail!(
            "expression 超过 {} 字节上限",
            EXTENSION_CDP_EXPRESSION_MAX_BYTES
        );
    }
    let target_id = nonempty_payload_str(payload, "target_id")
        .or_else(|| nonempty_payload_str(payload, "targetId"));
    let kind = nonempty_payload_str(payload, "kind");
    let targets = crate::cdp::list_targets(debug_port).await?;
    let selected = crate::cdp::select_extension_cdp_targets(&targets, target_id, kind)?;
    let mut results = Vec::new();
    for target in selected {
        let websocket = target
            .web_socket_debugger_url
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("CDP 页面没有 WebSocket URL"))?;
        let result = match crate::bridge::evaluate_script_return_by_value(websocket, expression)
            .await
        {
            Ok(response) => json!({
                "id": target.id,
                "ok": true,
                "value": response.pointer("/result/result/value").cloned().unwrap_or(Value::Null),
            }),
            Err(error) => json!({
                "id": target.id,
                "ok": false,
                "error": error.to_string(),
            }),
        };
        results.push(result);
    }
    Ok(json!({ "status": "ok", "results": results }))
}

pub async fn handle_bridge_request(
    ctx: BridgeContext,
    path: &str,
    payload: Value,
) -> serde_json::Value {
    let started = Instant::now();
    let _ = crate::diagnostic_log::append_diagnostic_log(
        "bridge.request",
        json!({
            "path": path,
            "payload_keys": payload
                .as_object()
                .map(|object| object.keys().cloned().collect::<Vec<_>>())
                .unwrap_or_default()
        }),
    );
    let result = match path {
        "/settings/get" => settings_value(&ctx, ctx.settings.get_settings().await).await,
        "/settings/set" => {
            let result = ctx.settings.set_settings(payload.clone()).await;
            // Codex 设置页改了设置：通知管理器重新读取，两边开关保持一致。
            if result.is_ok() {
                crate::settings::notify_external_settings_change();
            }
            settings_value(&ctx, result).await
        }
        // 只读：设置项清单（标题、说明、分组等），注入页据此生成设置行。
        "/settings/catalog" => crate::settings_catalog::enhancement_settings_catalog(),
        // 开放给拓展的设置只读子集：当前供应商的名称、模式、模型与上下文窗口。整份设置（/settings/get）仍不开放。
        "/settings/public" => match ctx.settings.get_settings().await {
            Ok(settings) => {
                let codex_app_version = ctx.settings.codex_app_version().await.unwrap_or_default();
                Ok(public_settings_value(&settings, codex_app_version))
            }
            Err(error) => Err(error),
        },
        "/user-scripts/list" => {
            ctx.runtime
                .user_script_inventory_with_runtime_status(payload.clone())
                .await
        }
        "/user-scripts/set-script-enabled" => {
            let key = payload
                .get("key")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let enabled = payload
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            ctx.runtime.set_user_script_enabled(key, enabled).await
        }
        "/user-scripts/load" => ctx.runtime.load_user_scripts().await,
        "/user-scripts/reload" => ctx.runtime.reload_user_scripts().await,
        "/cdp/targets" => ctx.runtime.cdp_targets().await,
        "/cdp/evaluate" => ctx.runtime.cdp_evaluate(payload.clone()).await,
        // 系统鼠标位置：拓展写「桌宠跟随鼠标」这类功能用（页面里拿不到窗口外的鼠标）。只读。
        "/system/cursor-position" => crate::launcher::cursor_position()
            .map(|(x, y)| json!({ "status": "ok", "x": x, "y": y })),
        // Codex Pilot 内部用：拓展要改写发往 app-server 的请求时补开客户端捕获。不进拓展路由白名单。
        "/extensions/request-capture" => ctx.runtime.request_app_server_client_capture().await,
        // 拓展常驻后台：页面侧 ctx.backend 用。进程由处理桥接的这个进程托管，与具体运行时无关。
        "/extensions/backend/call" => crate::extension_backend::route_call(&payload).await,
        "/extensions/backend/events" => crate::extension_backend::route_events(&payload).await,
        "/extensions/backend/stop" => crate::extension_backend::route_stop(&payload).await,
        "/extensions/services/call" => crate::extension_backend::route_service_call(&payload).await,
        // 拓展自己调模型（ctx.llm）：经协议代理用当前供应商，不跑拓展网关中间件。
        "/extensions/llm/complete" => crate::extension_llm::route_complete(&payload).await,
        "/extensions/llm/models" => crate::extension_llm::route_models(),
        "/extensions/history" => {
            let payload = payload.clone();
            tokio::task::spawn_blocking(move || crate::extension_history::route(&payload))
                .await
                .map_err(anyhow::Error::from)
                .and_then(|result| result)
        }
        "/devtools/open" => ctx.runtime.open_devtools().await,
        "/manager/open" => ctx.runtime.open_manager(payload.clone()).await,
        "/manager/open-transient" => ctx.runtime.open_transient_manager(payload.clone()).await,
        "/backend/status" => ctx.runtime.backend_status().await,
        "/codex-model-catalog" | "/codex-config-model" => ctx.runtime.codex_model_catalog().await,
        // 开放给拓展的模型目录：只给模型列表与每模型元数据（含上下文窗口），去掉来源地址、config 路径。
        "/model-catalog/public" => ctx
            .runtime
            .codex_model_catalog()
            .await
            .map(public_model_catalog_value),
        "/diagnostics/log" => diagnostic_log_value(payload.clone()),
        "/llm-proxy" => llm_proxy_value(payload.clone()).await,
        // 仅 Codex Pilot 原生预测补丁使用；不加入第三方拓展路由白名单。
        "/native-predictions/sample" => match ctx.settings.get_settings().await {
            Ok(settings) => crate::native_predictions::sample(&settings, &payload).await,
            Err(_) => Err(anyhow::anyhow!("无法读取预测设置")),
        },
        "/native-predictions/cancel" => crate::native_predictions::cancel(&payload),
        "/thread-usage-history" => {
            ctx.data
                .thread_usage_history(session_from_payload(&payload))
                .await
        }
        "/thread-usage-live" => {
            ctx.data
                .thread_usage_live(session_from_payload(&payload))
                .await
        }
        "/archived-thread" => {
            let title = payload
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            archived_thread_value(ctx.data.find_archived_thread_by_title(title).await)
        }

        _ => {
            let _ = crate::diagnostic_log::append_diagnostic_log(
                "bridge.unknown_path",
                json!({
                    "path": path
                }),
            );
            return json!({
                "status": "failed",
                "session_id": "",
                "message": "Unknown bridge path"
            });
        }
    };

    let response = result.unwrap_or_else(|error| failed_from_error(&payload, error));
    let _ = crate::diagnostic_log::append_diagnostic_log(
        "bridge.response",
        json!({
            "path": path,
            "elapsed_ms": started.elapsed().as_millis() as u64,
            "status": response.get("status").and_then(Value::as_str).unwrap_or("")
        }),
    );
    response
}

#[derive(Default)]
pub struct CoreSettingsService {
    store: SettingsStore,
    app_dir: Option<PathBuf>,
}

impl CoreSettingsService {
    fn with_app_dir(app_dir: PathBuf) -> Self {
        Self {
            store: SettingsStore::default(),
            app_dir: Some(app_dir),
        }
    }
}

#[async_trait]
impl BridgeSettingsService for CoreSettingsService {
    async fn get_settings(&self) -> anyhow::Result<BackendSettings> {
        self.store.load()
    }

    async fn set_settings(&self, payload: Value) -> anyhow::Result<BackendSettings> {
        self.store.update(payload)
    }

    async fn codex_app_version(&self) -> anyhow::Result<String> {
        if let Some(app_dir) = self.app_dir.as_deref() {
            return Ok(crate::app_paths::codex_app_version(app_dir).unwrap_or_default());
        }
        let settings = self.store.load().unwrap_or_default();
        let app_dir = crate::app_paths::resolve_codex_app_dir_with_saved(
            None,
            Some(settings.codex_app_path.as_str()),
        );
        Ok(app_dir
            .as_deref()
            .and_then(crate::app_paths::codex_app_version)
            .unwrap_or_default())
    }
}

#[derive(Clone)]
pub struct CoreRuntimeService {
    debug_port: u16,
    status_store: StatusStore,
    user_scripts: Option<UserScriptManager>,
    websocket_url: Option<String>,
    user_script_evaluator: Option<UserScriptEvaluator>,
    devtools_opener: Option<DevtoolsOpener>,
    devtools_target_id: Option<String>,
}

impl CoreRuntimeService {
    pub fn new(debug_port: u16, status_store: StatusStore) -> Self {
        Self {
            debug_port,
            status_store,
            user_scripts: None,
            websocket_url: None,
            user_script_evaluator: None,
            devtools_opener: None,
            devtools_target_id: None,
        }
    }

    pub fn with_user_scripts(mut self, user_scripts: UserScriptManager) -> Self {
        self.user_scripts = Some(user_scripts);
        self
    }

    pub fn with_websocket_url(mut self, websocket_url: impl Into<String>) -> Self {
        self.websocket_url = Some(websocket_url.into());
        self
    }

    pub fn with_user_script_evaluator(mut self, evaluator: UserScriptEvaluator) -> Self {
        self.user_script_evaluator = Some(evaluator);
        self
    }

    pub fn with_devtools_opener(mut self, opener: DevtoolsOpener) -> Self {
        self.devtools_opener = Some(opener);
        self
    }

    pub fn with_devtools_target_id(mut self, target_id: impl Into<String>) -> Self {
        self.devtools_target_id = Some(target_id.into());
        self
    }
}

#[async_trait]
impl BridgeRuntimeService for CoreRuntimeService {
    async fn user_script_inventory(&self) -> anyhow::Result<Value> {
        match &self.user_scripts {
            Some(user_scripts) => user_scripts.inventory(),
            None => Ok(empty_user_script_inventory()),
        }
    }

    async fn set_user_script_enabled(&self, key: String, enabled: bool) -> anyhow::Result<Value> {
        match &self.user_scripts {
            Some(user_scripts) => {
                let result = user_scripts.set_script_enabled(&key, enabled);
                // 与管理器一致：拓展带的钩子 / Codex 资产跟着启停写回 Codex 配置。
                crate::extension_hooks::sync_default(user_scripts);
                result?;
                user_scripts.inventory()
            }
            None => Ok(empty_user_script_inventory()),
        }
    }

    async fn load_user_scripts(&self) -> anyhow::Result<Value> {
        if let (Some(user_scripts), Some(websocket_url), Some(evaluator)) = (
            &self.user_scripts,
            self.websocket_url.as_deref(),
            &self.user_script_evaluator,
        ) {
            evaluator(websocket_url, &user_scripts.build_initial_bundle()?)?;
        } else {
            anyhow::bail!("Codex 页面尚未连接");
        }
        self.user_script_inventory().await
    }

    async fn reload_user_scripts(&self) -> anyhow::Result<Value> {
        if let (Some(user_scripts), Some(websocket_url), Some(evaluator)) = (
            &self.user_scripts,
            self.websocket_url.as_deref(),
            &self.user_script_evaluator,
        ) {
            let bundle = user_scripts.build_reload_bundle()?;
            evaluator(websocket_url, &bundle)?;
        } else {
            anyhow::bail!("Codex 页面尚未连接");
        }
        self.user_script_inventory().await
    }

    async fn cdp_targets(&self) -> anyhow::Result<Value> {
        crate::cdp::list_extension_cdp_targets(self.debug_port).await
    }

    async fn cdp_evaluate(&self, payload: Value) -> anyhow::Result<Value> {
        evaluate_extension_cdp(self.debug_port, &payload).await
    }

    async fn request_app_server_client_capture(&self) -> anyhow::Result<Value> {
        let websocket_url = self
            .websocket_url
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("Codex 页面尚未连接"))?;
        let started = crate::bridge::request_app_server_client_capture(websocket_url);
        Ok(json!({ "status": "ok", "started": started }))
    }

    async fn open_devtools(&self) -> anyhow::Result<Value> {
        let target_id = self
            .devtools_target_id
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("No DevTools target configured"))?;
        let url = devtools_url(self.debug_port, target_id);
        if let Some(opener) = &self.devtools_opener {
            opener(&url)?;
        }
        Ok(json!({
            "status": "ok",
            "target_id": target_id,
            "url": url
        }))
    }

    async fn open_manager(&self, payload: Value) -> anyhow::Result<Value> {
        let navigation =
            crate::manager_navigation::save_pending_manager_navigation_from_payload(&payload)?;
        let target = crate::install::open_or_activate_manager().map_err(|error| {
            crate::manager_navigation::rollback_pending_manager_navigation_after_launch_failure(
                navigation.as_ref(),
                error,
            )
        })?;
        Ok(json!({
            "status": "ok",
            "path": target,
            "navigation": navigation
        }))
    }

    async fn open_transient_manager(&self, payload: Value) -> anyhow::Result<Value> {
        let navigation =
            crate::manager_navigation::save_pending_manager_navigation_from_payload(&payload)?;
        let target = crate::install::spawn_companion(
            crate::install::MANAGER_BINARY,
            ["--transient"],
        )
        .map_err(|error| {
            crate::manager_navigation::rollback_pending_manager_navigation_after_launch_failure(
                navigation.as_ref(),
                error,
            )
        })?;
        Ok(json!({
            "status": "ok",
            "path": target,
            "navigation": navigation
        }))
    }

    async fn backend_status(&self) -> anyhow::Result<Value> {
        let _ = self.status_store.load_latest();
        let _ = crate::diagnostic_log::append_diagnostic_log(
            "bridge.backend_status_ok",
            json!({
                "debug_port": self.debug_port,
                "version": crate::version::VERSION
            }),
        );
        Ok(json!({"status": "ok", "message": "后端已连接", "version": crate::version::VERSION}))
    }

    async fn codex_model_catalog(&self) -> anyhow::Result<Value> {
        Ok(crate::model_catalog::read_codex_model_catalog().await)
    }
}

struct UnavailableDataService;

#[async_trait]
impl BridgeDataService for UnavailableDataService {

    async fn thread_usage_history(&self, session: SessionRef) -> anyhow::Result<Value> {
        Ok(json!({
            "status": "failed",
            "session_id": session.session_id,
            "message": "Thread usage history service is not wired in core launcher hooks",
            "history": []
        }))
    }

    async fn find_archived_thread_by_title(
        &self,
        _title: String,
    ) -> anyhow::Result<Option<SessionRef>> {
        Ok(None)
    }
}

fn settings_payload_value(
    settings: BackendSettings,
    codex_app_version: String,
) -> anyhow::Result<Value> {
    let native_fast = crate::native_fast::runtime_settings(&settings);
    // 页面心跳比较这两项，发拓展事件 relayProfile/switched、modelCatalog/changed（见 40-backend-settings.js）。
    let active_relay_profile_public = public_active_relay_profile(&settings);
    let catalog_fingerprint = model_catalog_fingerprint(&settings);
    let mut value = serde_json::to_value(settings)?;
    fn remove_named_keys(value: &mut Value) {
        match value {
            Value::Object(object) => {
                object.remove("apiKeys");
                for child in object.values_mut() {
                    remove_named_keys(child);
                }
            }
            Value::Array(array) => {
                for child in array {
                    remove_named_keys(child);
                }
            }
            _ => {}
        }
    }
    remove_named_keys(&mut value);
    if let Some(object) = value.as_object_mut() {
        object.insert(
            "codexAppVersion".to_string(),
            Value::String(codex_app_version),
        );
        object.insert(
            "activeRelayProfilePublic".to_string(),
            active_relay_profile_public,
        );
        object.insert(
            "modelCatalogFingerprint".to_string(),
            Value::String(catalog_fingerprint),
        );
        object.insert(
            "nativeFastLocalApiConfigured".to_string(),
            Value::Bool(native_fast.native_fast_local_api_configured),
        );
        // 原生输入预测与 Fast 共用同一份本机自定义 API 判定，只读一次 config.toml。
        object.insert(
            "nativePredictionsLocalApiConfigured".to_string(),
            Value::Bool(native_fast.native_fast_local_api_configured),
        );
        // 分区与预测共用后端身份检测，渲染侧不读取供应商地址或认证内容。
        object.insert(
            "nativeProjectSectionsLocalApiConfigured".to_string(),
            Value::Bool(native_fast.native_fast_local_api_configured),
        );
    }
    Ok(value)
}

/// 当前供应商里拓展能看的部分（`/settings/public` 与设置载荷的 `activeRelayProfilePublic` 共用）。
/// 只有名称、模式、模型和窗口这类展示用字段：不含地址、Key、config.toml / auth.json 内容。
fn public_active_relay_profile(settings: &BackendSettings) -> Value {
    let profile = settings.active_relay_profile();
    json!({
        "id": profile.id,
        "name": profile.name,
        "authMode": if profile.auth_mode == crate::native_config::AuthMode::Api { "api" } else { "official" },

        "model": crate::relay_config::relay_profile_model(&profile),
        "contextWindow": profile.context_window,
        "autoCompactLimit": profile.auto_compact_limit,

    })
}

/// 当前供应商的模型目录指纹：决定 Codex 模型目录的字段（模型列表、每模型窗口 / 压缩 / 元数据、聚合成员、换供应商）
/// 变了它就变。页面比较前后两次的值发 `modelCatalog/changed`；只用来判断「变没变」，不承诺跨版本稳定。
fn model_catalog_fingerprint(settings: &BackendSettings) -> String {
    use std::hash::{Hash, Hasher};
    let profile = settings.active_relay_profile();
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    (
        profile.id.as_str(),
        profile.name.as_str(),
        crate::relay_config::relay_profile_model(&profile),
        profile.catalog_contents.as_str(),
        profile.context_window.as_str(),
        profile.auto_compact_limit.as_str(),
    )
        .hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

/// `/settings/public`：拓展可读的设置子集。
fn public_settings_value(settings: &BackendSettings, codex_app_version: String) -> Value {
    json!({
        "status": "ok",
        "codexPlusVersion": crate::version::VERSION,
        "codexAppVersion": codex_app_version,
        "enhancementsEnabled": settings.enhancements_enabled,

        "activeProfile": public_active_relay_profile(settings),
        "modelCatalogFingerprint": model_catalog_fingerprint(settings),
    })
}

/// `/model-catalog/public` 保留的字段。`sources`（带供应商地址）、`path`（本机 config 路径）、`responses_api` 不给拓展。
const PUBLIC_MODEL_CATALOG_KEYS: &[&str] = &[
    "status",
    "message",
    "service_tier",
    "model",
    "model_provider",
    "codex_model_provider",
    "provider_name",
    "default_model",
    "models",
    "modelMetadata",
];

fn public_model_catalog_value(catalog: Value) -> Value {
    let mut public = serde_json::Map::new();
    if let Some(object) = catalog.as_object() {
        for key in PUBLIC_MODEL_CATALOG_KEYS {
            if let Some(value) = object.get(*key) {
                public.insert((*key).to_string(), value.clone());
            }
        }
    }
    Value::Object(public)
}

async fn settings_value(
    ctx: &BridgeContext,
    result: anyhow::Result<BackendSettings>,
) -> anyhow::Result<Value> {
    let settings = result?;
    let codex_app_version = ctx.settings.codex_app_version().await.unwrap_or_default();
    settings_payload_value(settings, codex_app_version)
}



async fn llm_proxy_value(payload: Value) -> anyhow::Result<Value> {
    let url = validate_llm_proxy_url(
        payload
            .get("url")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    )?;
    let method = payload
        .get("method")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("POST");
    if !method.eq_ignore_ascii_case("POST") {
        anyhow::bail!("LLM Bridge 仅支持 POST 请求");
    }

    let timeout_ms = payload
        .get("timeout_ms")
        .and_then(Value::as_u64)
        .unwrap_or(60_000)
        .clamp(1_000, 60_000);
    let body = payload
        .get("body")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if body.len() > 1_048_576 {
        anyhow::bail!("LLM Bridge 请求体过大");
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(timeout_ms))
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    let response = client
        .post(url)
        .headers(llm_proxy_headers(&payload)?)
        .body(body)
        .send()
        .await?;
    let http_status = response.status().as_u16();
    let ok = response.status().is_success();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    if let Some(length) = response.content_length() {
        if length > 4 * 1024 * 1024 {
            anyhow::bail!("LLM Bridge 响应体过大");
        }
    }
    let bytes = response.bytes().await?;
    if bytes.len() > 4 * 1024 * 1024 {
        anyhow::bail!("LLM Bridge 响应体过大");
    }
    let body_text = String::from_utf8_lossy(&bytes).to_string();
    let body_json = if content_type
        .split(';')
        .next()
        .map(str::trim)
        .is_some_and(|value| value.eq_ignore_ascii_case("application/json"))
    {
        serde_json::from_slice::<Value>(&bytes).ok()
    } else {
        None
    };

    Ok(json!({
        "status": "ok",
        "http_status": http_status,
        "ok": ok,
        "body_text": body_text,
        "body_json": body_json,
    }))
}

fn validate_llm_proxy_url(raw: &str) -> anyhow::Result<reqwest::Url> {
    let url = reqwest::Url::parse(raw.trim()).map_err(|_| anyhow::anyhow!("Base URL 格式无效"))?;
    if url.scheme() != "https" {
        anyhow::bail!("Base URL 必须使用 HTTPS");
    }
    if !url.username().is_empty() || url.password().is_some() {
        anyhow::bail!("Base URL 不得包含用户名或密码");
    }
    let host = url
        .host_str()
        .ok_or_else(|| anyhow::anyhow!("Base URL 缺少主机名"))?;
    if is_blocked_llm_proxy_host(host) {
        anyhow::bail!("Base URL 不得指向本机或私有网络");
    }
    Ok(url)
}

fn is_blocked_llm_proxy_host(host: &str) -> bool {
    let host = host
        .trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_lowercase();
    if host.is_empty()
        || host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
    {
        return true;
    }
    if let Ok(ip) = std::net::IpAddr::from_str(&host) {
        return match ip {
            std::net::IpAddr::V4(ip) => {
                ip.is_loopback()
                    || ip.is_private()
                    || ip.is_link_local()
                    || ip.is_multicast()
                    || ip.is_broadcast()
                    || ip.is_documentation()
                    || ip.octets()[0] == 0
                    || ip.octets()[0] == 100 && (64..=127).contains(&ip.octets()[1])
            }
            std::net::IpAddr::V6(ip) => {
                ip.is_loopback()
                    || ip.is_unspecified()
                    || ip.is_multicast()
                    || (ip.segments()[0] & 0xfe00) == 0xfc00
                    || (ip.segments()[0] & 0xffc0) == 0xfe80
            }
        };
    }
    false
}

fn llm_proxy_headers(payload: &Value) -> anyhow::Result<HeaderMap> {
    let mut headers = HeaderMap::new();
    let Some(raw_headers) = payload.get("headers").and_then(Value::as_object) else {
        return Ok(headers);
    };
    for (name, value) in raw_headers {
        if !is_allowed_llm_proxy_header(name) {
            continue;
        }
        let Some(value) = value.as_str() else {
            continue;
        };
        let header_name = HeaderName::from_bytes(name.as_bytes())?;
        let header_value = HeaderValue::from_str(value)?;
        headers.insert(header_name, header_value);
    }
    Ok(headers)
}

fn is_allowed_llm_proxy_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "accept"
            | "api-key"
            | "anthropic-beta"
            | "anthropic-version"
            | "authorization"
            | "content-type"
            | "openai-organization"
            | "openai-project"
            | "x-api-key"
    )
}

fn diagnostic_log_value(payload: Value) -> anyhow::Result<Value> {
    let event = payload
        .get("event")
        .and_then(Value::as_str)
        .map(sanitize_diagnostic_event)
        .unwrap_or_else(|| "event".to_string());
    crate::diagnostic_log::append_diagnostic_log(&format!("renderer.{event}"), payload)?;
    Ok(json!({
        "status": "ok",
        "message": "日志已记录"
    }))
}

fn sanitize_diagnostic_event(event: &str) -> String {
    let sanitized = event
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.') {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    if sanitized.is_empty() {
        "event".to_string()
    } else {
        sanitized
    }
}

fn archived_thread_value(result: anyhow::Result<Option<SessionRef>>) -> anyhow::Result<Value> {
    Ok(match result? {
        Some(session) => json!({"session_id": session.session_id, "title": session.title}),
        None => json!({"session_id": "", "title": ""}),
    })
}

fn failed_from_error(payload: &Value, error: anyhow::Error) -> Value {
    json!({
        "status": "failed",
        "session_id": payload
            .get("session_id")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        "message": error.to_string()
    })
}

fn session_from_payload(payload: &Value) -> SessionRef {
    let parse_host = |value: &Value| {
        value
            .as_str()
            .map(str::trim)
            .filter(|host| !host.is_empty())
            .map(ToString::to_string)
    };
    // 双名称不一致同样属于未知来源，不能通过优先读取某个字段放宽归属。
    let host_id = match (payload.get("host_id"), payload.get("hostId")) {
        (Some(left), Some(right)) => {
            let left = parse_host(left);
            let right = parse_host(right);
            if left == right { left } else { None }
        }
        (Some(value), None) | (None, Some(value)) => parse_host(value),
        _ => None,
    };
    SessionRef {
        session_id: payload
            .get("session_id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        title: payload
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        host_id,
    }
}

pub fn devtools_url(debug_port: u16, target_id: &str) -> String {
    format!(
        "http://127.0.0.1:{debug_port}/devtools/inspector.html?ws=127.0.0.1:{debug_port}/devtools/page/{target_id}"
    )
}

fn empty_user_script_inventory() -> Value {
    json!({
        "enabled": true,
        "scripts": []
    })
}
