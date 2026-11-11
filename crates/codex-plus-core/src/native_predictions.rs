//! 原生输入预测的运行时投影与独立模型采样；供应商地址和凭据只留在 Rust。

mod assets;
pub(crate) use assets::discover_native_assets;

use crate::settings::BackendSettings;
use anyhow::{anyhow, ensure};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::sync::oneshot;
use toml_edit::{DocumentMut, Item};

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeSettings {
    pub enhancements_enabled: bool,
    pub codex_app_native_predictions: bool,
    pub codex_app_native_predictions_model: String,
    /// 当前生效配置是否为本机自定义 API；与原生 Fast 共用同一份判定。
    pub native_predictions_local_api_configured: bool,
}

pub(crate) fn runtime_settings(settings: &BackendSettings) -> RuntimeSettings {
    runtime_settings_with_local_api(
        settings,
        crate::native_fast::local_api_configured_from_home(
            &crate::codex_home::default_codex_home_dir(),
        ),
    )
}

pub(crate) fn runtime_settings_with_local_api(
    settings: &BackendSettings,
    local_api_configured: bool,
) -> RuntimeSettings {
    RuntimeSettings {
        enhancements_enabled: settings.enhancements_enabled,
        codex_app_native_predictions: settings.codex_app_native_predictions,
        codex_app_native_predictions_model: settings
            .codex_app_native_predictions_model
            .trim()
            .to_string(),
        native_predictions_local_api_configured: local_api_configured,
    }
}

/// 任一原生模块补丁开启时才需要模块补丁通道。
pub(crate) fn native_modules_requested(settings: &BackendSettings) -> bool {
    settings.enhancements_enabled
        && (settings.codex_app_native_fast_unlock
            || settings.codex_app_native_predictions
            || settings.codex_app_native_project_sections)
}

const PREDICTION_TIMEOUT: Duration = Duration::from_secs(45);
const MAX_INPUT_BYTES: usize = 64 * 1024;
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const MAX_ACTIVE_REQUESTS: usize = 32;
const MAX_CANCELED_REQUESTS: usize = 128;
const CANCEL_RETENTION: Duration = Duration::from_secs(60);
const PREDICTION_PROMPT: &str = "Predict the next message the user is most likely to type into the composer of this conversation.\nBase it on the whole conversation, especially the assistant's latest reply.\nWrite it in the user's own voice and in the same language the user has been using.\nKeep it to one short, concrete sentence the user could send as-is.\nDo not answer, explain, greet, or speak as the assistant; do not repeat the assistant's text; do not call tools.\nIf there is no confident prediction, use null.\nReturn only JSON matching this schema: {\"type\":\"object\",\"properties\":{\"suggestion\":{\"type\":[\"string\",\"null\"]}},\"required\":[\"suggestion\"],\"additionalProperties\":false}";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SampleRequest {
    request_id: String,
    model_provider: String,
    model: String,
    input: Vec<InputMessage>,
}

#[derive(Deserialize, Serialize)]
struct InputMessage {
    role: InputRole,
    content: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum InputRole {
    User,
    Assistant,
}

#[derive(Default)]
struct Requests {
    // 取消后仍保留槽位直到 future 退出，避免同 ID 重入覆盖旧请求。
    active: HashMap<String, Option<oneshot::Sender<()>>>,
    canceled: HashMap<String, Instant>,
}

fn requests() -> &'static Mutex<Requests> {
    static REQUESTS: OnceLock<Mutex<Requests>> = OnceLock::new();
    REQUESTS.get_or_init(|| Mutex::new(Requests::default()))
}

struct ActiveRequest(String);

impl Drop for ActiveRequest {
    fn drop(&mut self) {
        requests()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .active
            .remove(&self.0);
    }
}

fn valid_request_id(id: &str) -> bool {
    !id.trim().is_empty() && id.len() <= 256 && !id.chars().any(char::is_control)
}

fn register_request(id: &str) -> anyhow::Result<(ActiveRequest, oneshot::Receiver<()>)> {
    ensure!(valid_request_id(id), "预测请求 ID 无效");
    let mut requests = requests()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    requests
        .canceled
        .retain(|_, at| at.elapsed() < CANCEL_RETENTION);
    ensure!(!requests.canceled.contains_key(id), "预测请求已取消");
    ensure!(!requests.active.contains_key(id), "预测请求 ID 已在使用");
    ensure!(requests.active.len() < MAX_ACTIVE_REQUESTS, "预测请求过多");
    let (sender, receiver) = oneshot::channel();
    requests.active.insert(id.to_string(), Some(sender));
    Ok((ActiveRequest(id.to_string()), receiver))
}

/// 内部桥接路由：即使功能已经关闭，也能取消先前正在发送的请求。
pub(crate) fn cancel(payload: &Value) -> anyhow::Result<Value> {
    let id = payload
        .get("requestId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    ensure!(valid_request_id(id), "预测请求 ID 无效");
    let mut requests = requests()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let canceled = requests
        .active
        .get_mut(id)
        .and_then(Option::take)
        .is_some_and(|sender| sender.send(()).is_ok());
    // cancel 可以先于 sample 到达；短期墓碑有数量与时间上限。
    requests
        .canceled
        .retain(|_, at| at.elapsed() < CANCEL_RETENTION);
    if requests.canceled.len() >= MAX_CANCELED_REQUESTS && !requests.canceled.contains_key(id) {
        if let Some(oldest) = requests
            .canceled
            .iter()
            .min_by_key(|(_, at)| *at)
            .map(|(id, _)| id.clone())
        {
            requests.canceled.remove(&oldest);
        }
    }
    requests.canceled.insert(id.to_string(), Instant::now());
    Ok(json!({ "status": "ok", "canceled": canceled }))
}

pub(crate) async fn sample(settings: &BackendSettings, payload: &Value) -> anyhow::Result<Value> {
    sample_from_home(
        settings,
        payload,
        &crate::codex_home::default_codex_home_dir(),
    )
    .await
}

async fn sample_from_home(
    settings: &BackendSettings,
    payload: &Value,
    home: &Path,
) -> anyhow::Result<Value> {
    // 所有错误都使用固定文案；不得向 bridge 的错误日志传播 URL、请求头或上游错误体。
    let request: SampleRequest =
        serde_json::from_value(payload.clone()).map_err(|_| anyhow!("预测请求格式无效"))?;
    ensure!(
        settings.enhancements_enabled && settings.codex_app_native_predictions,
        "原生输入预测未开启"
    );
    let model = settings.codex_app_native_predictions_model.trim();
    ensure!(
        !model.is_empty() && model.len() <= 512 && !model.chars().any(char::is_control),
        "未选择有效的预测模型"
    );
    ensure!(request.model.trim() == model, "预测模型设置已变更");
    ensure!(
        !request.input.is_empty() && request.input.len() <= 256,
        "预测上下文无效"
    );
    ensure!(
        request
            .input
            .iter()
            .map(|item| item.content.len())
            .sum::<usize>()
            <= MAX_INPUT_BYTES,
        "预测上下文超过 64 KiB"
    );
    ensure!(
        request
            .input
            .iter()
            .any(|item| !item.content.trim().is_empty()),
        "预测上下文为空"
    );
    let (_active, canceled) = register_request(&request.request_id)?;
    ensure!(
        crate::native_fast::local_api_configured_from_home(home),
        "预测仅支持当前本机自定义 API"
    );
    let connection = provider_connection(home, &request.model_provider)?;
    let mut input = serde_json::to_value(request.input).map_err(|_| anyhow!("预测上下文无效"))?;
    input
        .as_array_mut()
        .expect("serialized input is an array")
        .push(json!({ "role": "user", "content": PREDICTION_PROMPT }));
    let body = crate::extension_llm::request_body(
        &json!({
            "model": model,
            "input": input,
            "maxOutputTokens": 1024,
        }),
        None,
    )
    .map_err(|_| anyhow!("无法构建预测请求"))?;
    tokio::select! {
        biased;
        _ = canceled => Err(anyhow!("预测请求已取消")),
        result = tokio::time::timeout(PREDICTION_TIMEOUT, send_sample(connection, body, model)) => {
            result.map_err(|_| anyhow!("预测请求超时"))?
        }
    }
}

struct ProviderConnection {
    url: reqwest::Url,
    headers: HeaderMap,
}

fn provider_connection(home: &Path, expected_provider: &str) -> anyhow::Result<ProviderConnection> {
    let text = std::fs::read_to_string(home.join("config.toml"))
        .map_err(|_| anyhow!("无法读取预测供应商配置"))?;
    let document = text
        .parse::<DocumentMut>()
        .map_err(|_| anyhow!("预测供应商配置无效"))?;
    let profile = match document.get("profile") {
        None => None,
        Some(profile) => Some(
            profile
                .as_str()
                .and_then(|name| {
                    document
                        .get("profiles")?
                        .as_table_like()?
                        .get(name)?
                        .as_table_like()
                })
                .ok_or_else(|| anyhow!("当前配置档案无效"))?,
        ),
    };
    let provider_id = profile
        .and_then(|profile| profile.get("model_provider"))
        .or_else(|| document.get("model_provider"))
        .and_then(Item::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| anyhow!("未配置预测供应商"))?;
    ensure!(
        provider_id == expected_provider.trim(),
        "对话供应商与当前本机配置不一致"
    );
    let provider = document
        .get("model_providers")
        .and_then(Item::as_table_like)
        .and_then(|providers| providers.get(provider_id))
        .and_then(Item::as_table_like)
        .ok_or_else(|| anyhow!("预测供应商配置无效"))?;
    let base_url = provider
        .get("base_url")
        .and_then(Item::as_str)
        .ok_or_else(|| anyhow!("预测供应商地址无效"))?;
    let mut url = reqwest::Url::parse(&crate::protocol_proxy::responses_url(base_url))
        .map_err(|_| anyhow!("预测供应商地址无效"))?;
    ensure!(
        matches!(url.scheme(), "http" | "https") && url.host_str().is_some(),
        "预测供应商地址无效"
    );
    if let Some(params) = provider.get("query_params") {
        let params = params
            .as_table_like()
            .ok_or_else(|| anyhow!("预测供应商查询参数无效"))?;
        for (name, value) in params.iter() {
            let value = value
                .as_str()
                .ok_or_else(|| anyhow!("预测供应商查询参数无效"))?;
            url.query_pairs_mut().append_pair(name, value);
        }
    }
    let mut headers = HeaderMap::new();
    for (key, environment) in [("http_headers", false), ("env_http_headers", true)] {
        if let Some(values) = provider.get(key) {
            let values = values
                .as_table_like()
                .ok_or_else(|| anyhow!("预测供应商请求头无效"))?;
            for (name, value) in values.iter() {
                let value = value
                    .as_str()
                    .ok_or_else(|| anyhow!("预测供应商请求头无效"))?;
                let value = if environment {
                    let Ok(value) = std::env::var(value) else {
                        continue;
                    };
                    if value.trim().is_empty() {
                        continue;
                    }
                    value
                } else {
                    value.to_string()
                };
                headers.insert(
                    HeaderName::from_bytes(name.as_bytes())
                        .map_err(|_| anyhow!("预测供应商请求头无效"))?,
                    HeaderValue::from_str(&value).map_err(|_| anyhow!("预测供应商请求头无效"))?,
                );
            }
        }
    }
    let token = if let Some(key) = provider.get("env_key") {
        let key = key.as_str().ok_or_else(|| anyhow!("预测供应商认证无效"))?;
        Some(
            std::env::var(key)
                .ok()
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| anyhow!("预测供应商认证不可用"))?,
        )
    } else if let Some(token) = provider
        .get("experimental_bearer_token")
        .and_then(Item::as_str)
        .filter(|value| !value.trim().is_empty())
    {
        Some(token.to_string())
    } else if provider.get("requires_openai_auth").and_then(Item::as_bool) == Some(true) {
        let auth = std::fs::read_to_string(home.join("auth.json"))
            .map_err(|_| anyhow!("预测供应商认证不可用"))?;
        let auth: Value =
            serde_json::from_str(&auth).map_err(|_| anyhow!("预测供应商认证不可用"))?;
        Some(
            auth.get("OPENAI_API_KEY")
                .and_then(Value::as_str)
                .filter(|key| !key.trim().is_empty())
                .ok_or_else(|| anyhow!("预测供应商认证不可用"))?
                .to_string(),
        )
    } else {
        None
    };
    if let Some(token) = token {
        headers.insert(
            reqwest::header::AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {}", token.trim()))
                .map_err(|_| anyhow!("预测供应商认证无效"))?,
        );
    }
    headers
        .entry(reqwest::header::ACCEPT)
        .or_insert(HeaderValue::from_static("text/event-stream"));
    Ok(ProviderConnection { url, headers })
}

async fn send_sample(
    connection: ProviderConnection,
    body: Value,
    model: &str,
) -> anyhow::Result<Value> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(PREDICTION_TIMEOUT)
        .build()
        .map_err(|_| anyhow!("无法建立预测连接"))?;
    let mut response = client
        .post(connection.url)
        .headers(connection.headers)
        .json(&body)
        .send()
        .await
        .map_err(|_| anyhow!("预测供应商请求失败"))?;
    ensure!(response.status().is_success(), "预测供应商请求失败");
    ensure!(
        response
            .content_length()
            .is_none_or(|length| length <= MAX_RESPONSE_BYTES as u64),
        "预测响应过大"
    );
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| anyhow!("读取预测响应失败"))?
    {
        ensure!(
            bytes.len().saturating_add(chunk.len()) <= MAX_RESPONSE_BYTES,
            "预测响应过大"
        );
        bytes.extend_from_slice(&chunk);
    }
    let reply = crate::extension_llm::parse_reply(&bytes);
    ensure!(
        reply.get("error").is_none_or(Value::is_null),
        "预测供应商返回错误"
    );
    ensure!(
        reply
            .get("toolCalls")
            .and_then(Value::as_array)
            .is_none_or(Vec::is_empty),
        "预测供应商返回了工具调用"
    );
    let text = reply
        .get("text")
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty())
        .ok_or_else(|| anyhow!("预测供应商未返回文本"))?;
    let actual_model = reply
        .get("model")
        .and_then(Value::as_str)
        .filter(|model| !model.trim().is_empty())
        .unwrap_or(model);
    Ok(json!({
        "text": text,
        "model": actual_model,
        "inputTokens": reply.pointer("/usage/input_tokens").or_else(|| reply.pointer("/usage/prompt_tokens")).and_then(Value::as_u64),
        "cachedInputTokens": reply.pointer("/usage/input_tokens_details/cached_tokens").or_else(|| reply.pointer("/usage/prompt_tokens_details/cached_tokens")).and_then(Value::as_u64),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn sample_settings() -> BackendSettings {
        BackendSettings {
            enhancements_enabled: true,
            codex_app_native_predictions: true,
            codex_app_native_predictions_model: "prediction-model".to_string(),
            ..BackendSettings::default()
        }
    }

    fn sample_payload() -> Value {
        json!({
            "requestId": uuid::Uuid::new_v4().to_string(),
            "modelProvider": "fixture",
            "model": "prediction-model",
            "input": [
                {"role":"user", "content":"请帮我检查这个实现"},
                {"role":"assistant", "content":"已经检查，可以继续补充测试。"},
            ],
        })
    }

    fn fixture_home(server: &MockServer, api_key_login: bool) -> tempfile::TempDir {
        let directory = tempfile::tempdir().unwrap();
        let token = if api_key_login {
            ""
        } else {
            "experimental_bearer_token = 'fixture-only-token'\n"
        };
        std::fs::write(directory.path().join("config.toml"), format!(
            "profile = 'local'\nmodel_provider = 'wrong-root-provider'\n[profiles.local]\nmodel_provider = 'fixture'\n[model_providers.fixture]\nbase_url = '{}/v1'\nwire_api = 'responses'\nrequires_openai_auth = {}\n{}http_headers = {{ x-prediction-fixture = 'fixture-header' }}\nquery_params = {{ api-version = 'fixture-version' }}\n",
            server.uri(), api_key_login, token,
        )).unwrap();
        if api_key_login {
            std::fs::write(
                directory.path().join("auth.json"),
                r#"{"OPENAI_API_KEY":"fixture-only-auth-key","auth_mode":"apikey"}"#,
            )
            .unwrap();
        }
        directory
    }

    fn response_fixture() -> Value {
        json!({
            "object":"response", "model":"actual-upstream-model",
            "output":[{"type":"message", "content":[{"type":"output_text", "text":"{\"suggestion\":\"继续补充测试\"}"}]}],
            "usage":{"input_tokens":42,"input_tokens_details":{"cached_tokens":17}},
        })
    }

    #[tokio::test]
    async fn sample_sends_selected_model_and_only_text_to_effective_profile() {
        let server = MockServer::start().await;
        let home = fixture_home(&server, false);
        let response = json!({"type":"response.completed", "response":response_fixture()});
        Mock::given(method("POST"))
            .and(path("/v1/responses"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_string(format!("data: {response}\n\ndata: [DONE]\n\n")),
            )
            .expect(1)
            .mount(&server)
            .await;
        let payload = sample_payload();
        let result = sample_from_home(&sample_settings(), &payload, home.path())
            .await
            .unwrap();
        assert_eq!(result["model"], "actual-upstream-model");
        assert_eq!(result["inputTokens"], 42);
        assert_eq!(result["cachedInputTokens"], 17);
        assert_eq!(result["text"], "{\"suggestion\":\"继续补充测试\"}");
        let requests = server.received_requests().await.unwrap();
        let outbound = &requests[0];
        assert_eq!(
            outbound.headers["authorization"],
            "Bearer fixture-only-token"
        );
        assert_eq!(outbound.headers["x-prediction-fixture"], "fixture-header");
        assert!(
            outbound
                .url
                .query_pairs()
                .any(|(key, value)| key == "api-version" && value == "fixture-version")
        );
        let body: Value = serde_json::from_slice(&outbound.body).unwrap();
        assert_eq!(body["model"], "prediction-model");
        assert_eq!(body["max_output_tokens"], 1024);
        assert_eq!(body["stream"], true);
        assert_eq!(body["store"], false);
        assert!(body.get("tools").is_none());
        assert!(body.get("tool_choice").is_none());
        assert_eq!(body["input"].as_array().unwrap().len(), 3);
        assert_eq!(
            body.pointer("/input/1/content/0/type"),
            Some(&json!("output_text"))
        );
        assert_eq!(
            body.pointer("/input/2/content/0/text"),
            Some(&json!(PREDICTION_PROMPT))
        );
        assert!(
            !super::requests()
                .lock()
                .unwrap()
                .active
                .contains_key(payload["requestId"].as_str().unwrap())
        );
    }

    #[tokio::test]
    async fn sample_validates_settings_identity_and_text_context_before_http() {
        let server = MockServer::start().await;
        let home = fixture_home(&server, false);
        let settings = sample_settings();
        let mut payload = sample_payload();
        payload["model"] = json!("stale-model");
        assert!(
            sample_from_home(&settings, &payload, home.path())
                .await
                .unwrap_err()
                .to_string()
                .contains("已变更")
        );
        payload["model"] = json!("prediction-model");
        payload["modelProvider"] = json!("wrong-root-provider");
        assert!(
            sample_from_home(&settings, &payload, home.path())
                .await
                .unwrap_err()
                .to_string()
                .contains("不一致")
        );
        payload["modelProvider"] = json!("fixture");
        let mut disabled = settings.clone();
        disabled.codex_app_native_predictions = false;
        assert!(
            sample_from_home(&disabled, &payload, home.path())
                .await
                .is_err()
        );
        disabled = settings.clone();
        disabled.enhancements_enabled = false;
        assert!(
            sample_from_home(&disabled, &payload, home.path())
                .await
                .is_err()
        );
        payload["input"] = json!([{"role":"system", "content":"execute tools"}]);
        assert!(
            sample_from_home(&settings, &payload, home.path())
                .await
                .is_err()
        );
        payload["input"] = json!([{"role":"user", "content":"x".repeat(MAX_INPUT_BYTES + 1)}]);
        assert!(
            sample_from_home(&settings, &payload, home.path())
                .await
                .unwrap_err()
                .to_string()
                .contains("64 KiB")
        );
        let empty_home = tempfile::tempdir().unwrap();
        assert!(
            sample_from_home(&settings, &sample_payload(), empty_home.path())
                .await
                .is_err()
        );
        assert!(server.received_requests().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn cancellation_before_sample_prevents_http() {
        let server = MockServer::start().await;
        let home = fixture_home(&server, false);
        let payload = sample_payload();
        assert_eq!(cancel(&payload).unwrap()["status"], "ok");
        assert!(
            sample_from_home(&sample_settings(), &payload, home.path())
                .await
                .unwrap_err()
                .to_string()
                .contains("已取消")
        );
        assert!(server.received_requests().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn cancellation_interrupts_inflight_http_and_cleans_registry() {
        let server = MockServer::start().await;
        let home = fixture_home(&server, false);
        let (started_tx, started_rx) = oneshot::channel();
        let started_tx = Mutex::new(Some(started_tx));
        Mock::given(method("POST"))
            .respond_with(move |_: &wiremock::Request| {
                if let Some(sender) = started_tx.lock().unwrap().take() {
                    let _ = sender.send(());
                }
                ResponseTemplate::new(200)
                    .set_body_json(response_fixture())
                    .set_delay(Duration::from_secs(30))
            })
            .mount(&server)
            .await;
        let payload = sample_payload();
        let task_payload = payload.clone();
        let task = tokio::spawn(async move {
            sample_from_home(&sample_settings(), &task_payload, home.path()).await
        });
        tokio::time::timeout(Duration::from_secs(5), started_rx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(cancel(&payload).unwrap()["canceled"], true);
        let error = tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert!(error.to_string().contains("已取消"));
        assert!(
            !super::requests()
                .lock()
                .unwrap()
                .active
                .contains_key(payload["requestId"].as_str().unwrap())
        );
    }

    #[tokio::test]
    async fn sample_uses_fixture_api_key_login_and_sanitizes_upstream_errors() {
        let server = MockServer::start().await;
        let home = fixture_home(&server, true);
        Mock::given(method("POST"))
            .respond_with(
                ResponseTemplate::new(401)
                    .set_body_string("fixture-only-auth-key upstream diagnostic"),
            )
            .mount(&server)
            .await;
        let error = sample_from_home(&sample_settings(), &sample_payload(), home.path())
            .await
            .unwrap_err()
            .to_string();
        assert_eq!(error, "预测供应商请求失败");
        let requests = server.received_requests().await.unwrap();
        assert_eq!(
            requests[0].headers["authorization"],
            "Bearer fixture-only-auth-key"
        );
        server.reset().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200).set_body_json(
                json!({"error":{"message":"fixture-only-auth-key upstream diagnostic"}}),
            ))
            .mount(&server)
            .await;
        let error = sample_from_home(&sample_settings(), &sample_payload(), home.path())
            .await
            .unwrap_err()
            .to_string();
        assert_eq!(error, "预测供应商返回错误");
    }

    #[test]
    fn projection_contains_only_feature_flags() {
        let mut settings = BackendSettings::default();
        assert!(!settings.codex_app_native_predictions);
        assert!(!native_modules_requested(&settings));
        settings.codex_app_native_predictions = true;
        assert!(native_modules_requested(&settings));
        settings.enhancements_enabled = false;
        assert!(!native_modules_requested(&settings));
        settings.enhancements_enabled = true;
        assert_eq!(
            serde_json::to_value(runtime_settings_with_local_api(&settings, true)).unwrap(),
            json!({
                "enhancementsEnabled": true,
                "codexAppNativePredictions": true,
                "codexAppNativePredictionsModel": "",
                "nativePredictionsLocalApiConfigured": true,
            })
        );
        settings.codex_app_native_predictions = false;
        settings.codex_app_native_fast_unlock = true;
        assert!(native_modules_requested(&settings));
    }
}
