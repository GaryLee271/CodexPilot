//! 只读 Codex 当前配置，供增强功能使用；不维护供应商或登录快照。
use crate::settings::RelayHeaderKeyValue;
use anyhow::{Context, ensure};
use std::{collections::BTreeMap, path::Path};
use toml_edit::{DocumentMut, Item};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum AuthMode {
    #[default]
    Official,
    Api,
}

/// 当前原生连接的临时视图，不序列化到管理器设置中。
#[derive(Clone, Default)]
pub struct CodexConnection {
    pub id: String,
    pub name: String,
    pub model: String,
    pub base_url: String,
    pub api_key: String,
    pub auth_contents: String,
    pub auth_mode: AuthMode,
    pub wire_api: String,
    pub custom_headers: Vec<RelayHeaderKeyValue>,
    pub query_params: BTreeMap<String, String>,
    pub context_window: String,
    pub auto_compact_limit: String,
    pub catalog_contents: String,
    pub model_list: String,
}

impl CodexConnection {
    pub fn uses_no_auth(&self) -> bool {
        self.auth_mode == AuthMode::Api && self.api_key.is_empty()
    }

    pub fn request(&self, client: &reqwest::Client) -> anyhow::Result<reqwest::RequestBuilder> {
        ensure!(
            self.wire_api == "responses",
            "增强模型调用需要 Codex 的 Responses 接口"
        );
        let url = crate::protocol_proxy::responses_url(&self.base_url);
        let mut request = client
            .post(url)
            .query(&self.query_params)
            .header("Accept", "text/event-stream");
        match self.auth_mode {
            AuthMode::Official => {
                let login =
                    crate::official_login::official_login_from_auth_contents(&self.auth_contents)
                        .context("Codex 尚未登录")?;
                ensure!(!login.access_token.is_empty(), "请在 Codex 中刷新登录");
                request = request
                    .bearer_auth(login.access_token)
                    .header("OpenAI-Beta", "responses=experimental")
                    .header("originator", "codex_cli_rs");
                if !login.account_id.is_empty() {
                    request = request.header("chatgpt-account-id", login.account_id);
                }
            }
            AuthMode::Api if !self.api_key.is_empty() => {
                request = request.bearer_auth(&self.api_key)
            }
            _ => {}
        }
        for header in &self.custom_headers {
            let name = reqwest::header::HeaderName::from_bytes(header.key.as_bytes())
                .map_err(|_| anyhow::anyhow!("Codex 自定义请求头名称无效"))?;
            let value = reqwest::header::HeaderValue::from_str(&header.value)
                .map_err(|_| anyhow::anyhow!("Codex 自定义请求头内容无效"))?;
            request = request.header(name, value);
        }
        Ok(request)
    }
}

pub fn current_profile() -> CodexConnection {
    profile_from_home(&crate::codex_home::default_codex_home_dir()).unwrap_or_default()
}

pub fn profile_from_home(home: &Path) -> anyhow::Result<CodexConnection> {
    profile_from_home_with_env(home, |name| std::env::var(name).ok())
}

pub(crate) fn profile_from_home_with_env(
    home: &Path,
    env: impl Fn(&str) -> Option<String>,
) -> anyhow::Result<CodexConnection> {
    let config =
        std::fs::read_to_string(home.join("config.toml")).context("无法读取 Codex 配置")?;
    let doc = config
        .parse::<DocumentMut>()
        .map_err(|_| anyhow::anyhow!("Codex 配置格式无效"))?;
    let active = doc
        .get("profile")
        .and_then(Item::as_str)
        .and_then(|name| doc.get("profiles")?.get(name));
    let read = |key: &str| {
        active
            .and_then(|profile| profile.get(key))
            .or_else(|| doc.get(key))
    };
    let provider_id = read("model_provider")
        .and_then(Item::as_str)
        .unwrap_or("openai");
    let provider = doc
        .get("model_providers")
        .and_then(|providers| providers.get(provider_id));
    let provider_str = |key| provider.and_then(|p| p.get(key)).and_then(Item::as_str);
    let auth = std::fs::read_to_string(home.join("auth.json")).unwrap_or_default();
    let auth_value: serde_json::Value = serde_json::from_str(&auth).unwrap_or_default();
    let key = if let Some(name) = provider_str("env_key") {
        env(name).context("Codex 配置所需的密钥环境变量未设置")?
    } else if let Some(key) = provider_str("experimental_bearer_token") {
        key.to_string()
    } else {
        auth_value
            .get("OPENAI_API_KEY")
            .and_then(serde_json::Value::as_str)
            .filter(|key| !key.trim().is_empty())
            .map(str::to_string)
            .unwrap_or_default()
    };
    let requires_official = provider
        .and_then(|p| p.get("requires_openai_auth"))
        .and_then(Item::as_bool)
        .unwrap_or(false);
    let api = !requires_official
        && (provider_id != "openai" || !key.is_empty() || provider_str("base_url").is_some());
    let mut headers = BTreeMap::new();
    for (table, from_env) in [("http_headers", false), ("env_http_headers", true)] {
        if let Some(values) = provider
            .and_then(|p| p.get(table))
            .and_then(Item::as_table_like)
        {
            for (name, value) in values.iter() {
                let Some(value) = value.as_str() else {
                    continue;
                };
                if let Some(value) = if from_env {
                    env(value)
                } else {
                    Some(value.to_string())
                } {
                    headers.insert(name.to_string(), value);
                }
            }
        }
    }
    let mut query_params = BTreeMap::new();
    if let Some(values) = provider
        .and_then(|p| p.get("query_params"))
        .and_then(Item::as_table_like)
    {
        for (name, value) in values.iter() {
            if let Some(value) = value.as_str() {
                query_params.insert(name.to_string(), value.to_string());
            }
        }
    }
    let catalog_contents = read("model_catalog_json")
        .and_then(Item::as_str)
        .and_then(|path| std::fs::read_to_string(home.join(path)).ok())
        .unwrap_or_default();
    let number = |key| {
        read(key)
            .and_then(Item::as_integer)
            .map(|value| value.to_string())
            .unwrap_or_default()
    };
    Ok(CodexConnection {
        id: provider_id.to_string(),
        name: provider_str("name").unwrap_or(provider_id).to_string(),
        model: read("model")
            .and_then(Item::as_str)
            .unwrap_or_default()
            .to_string(),
        base_url: provider_str("base_url")
            .unwrap_or(if api {
                "https://api.openai.com/v1"
            } else {
                "https://chatgpt.com/backend-api/codex"
            })
            .to_string(),
        api_key: if requires_official {
            String::new()
        } else {
            key
        },
        auth_contents: auth,
        auth_mode: if api {
            AuthMode::Api
        } else {
            AuthMode::Official
        },
        wire_api: provider_str("wire_api").unwrap_or("responses").to_string(),
        custom_headers: headers
            .into_iter()
            .map(|(name, value)| RelayHeaderKeyValue { key: name, value })
            .collect(),
        query_params,
        context_window: number("model_context_window"),
        auto_compact_limit: number("model_auto_compact_token_limit"),
        model_list: serde_json::from_str::<serde_json::Value>(&catalog_contents)
            .ok()
            .and_then(|catalog| catalog["models"].as_array().cloned())
            .unwrap_or_default()
            .iter()
            .filter_map(|m| m["slug"].as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        catalog_contents,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn home(config: &str, auth: &str) -> tempfile::TempDir {
        let home = tempfile::tempdir().unwrap();
        std::fs::write(home.path().join("config.toml"), config).unwrap();
        std::fs::write(home.path().join("auth.json"), auth).unwrap();
        home
    }

    #[test]
    fn selected_profile_resolves_native_model_headers_query_and_catalog_without_writes() {
        let config = r#"model = 'root-model'
model_provider = 'unused'
profile = 'work'
[profiles.work]
model = 'selected-model'
model_provider = 'fixture'
model_catalog_json = 'catalog.json'
[model_providers.fixture]
name = 'Fixture'
base_url = 'http://127.0.0.1:1234/v1'
env_key = 'FIXTURE_KEY'
http_headers = { X-Tenant = 'tenant' }
env_http_headers = { X-Secret = 'FIXTURE_HEADER' }
query_params = { api-version = 'preview' }
"#;
        let home = home(config, "{}");
        std::fs::write(
            home.path().join("catalog.json"),
            json!({"models":[{"slug":"selected-model"}]}).to_string(),
        )
        .unwrap();
        let connection = profile_from_home_with_env(home.path(), |name| match name {
            "FIXTURE_KEY" => Some("fake-key".into()),
            "FIXTURE_HEADER" => Some("fake-header".into()),
            _ => None,
        })
        .unwrap();
        assert_eq!(connection.id, "fixture");
        assert_eq!(connection.model, "selected-model");
        assert_eq!(connection.auth_mode, AuthMode::Api);
        assert_eq!(connection.model_list, "selected-model");
        let request = connection
            .request(&reqwest::Client::new())
            .unwrap()
            .build()
            .unwrap();
        assert_eq!(request.headers()["authorization"], "Bearer fake-key");
        assert_eq!(request.headers()["x-secret"], "fake-header");
        assert_eq!(request.headers()["x-tenant"], "tenant");
        assert_eq!(request.url().query(), Some("api-version=preview"));
        assert_eq!(
            std::fs::read_to_string(home.path().join("config.toml")).unwrap(),
            config
        );
        assert_eq!(
            std::fs::read_to_string(home.path().join("auth.json")).unwrap(),
            "{}"
        );
    }

    #[test]
    fn native_login_and_api_keys_select_the_expected_authentication() {
        let official = home(
            "model = 'official'",
            r#"{"tokens":{"access_token":"fake-oauth","account_id":"fixture-account"}}"#,
        );
        let connection = profile_from_home_with_env(official.path(), |_| None).unwrap();
        assert_eq!(connection.auth_mode, AuthMode::Official);
        let request = connection
            .request(&reqwest::Client::new())
            .unwrap()
            .build()
            .unwrap();
        assert_eq!(request.headers()["authorization"], "Bearer fake-oauth");
        assert_eq!(request.headers()["chatgpt-account-id"], "fixture-account");
        let api = home("model = 'api'", r#"{"OPENAI_API_KEY":"fake-api"}"#);
        let connection = profile_from_home_with_env(api.path(), |_| None).unwrap();
        assert_eq!(connection.auth_mode, AuthMode::Api);
        assert_eq!(connection.base_url, "https://api.openai.com/v1");
        assert_eq!(connection.api_key, "fake-api");
    }

    #[test]
    fn missing_environment_key_never_falls_back_to_another_account() {
        let home = home(
            "model_provider = 'fixture'\n[model_providers.fixture]\nenv_key = 'MISSING'",
            r#"{"OPENAI_API_KEY":"unrelated-key"}"#,
        );
        assert!(profile_from_home_with_env(home.path(), |_| None).is_err());
        std::fs::write(
            home.path().join("config.toml"),
            "private_value = 'never-echo",
        )
        .unwrap();
        assert!(
            !profile_from_home_with_env(home.path(), |_| None)
                .err()
                .unwrap()
                .to_string()
                .contains("never-echo")
        );
    }

    #[tokio::test]
    async fn extension_llm_calls_the_native_responses_endpoint_and_preserves_session_files() {
        use wiremock::{
            Mock, MockServer, ResponseTemplate,
            matchers::{body_partial_json, header, method, path, query_param},
        };
        let server = MockServer::start().await;
        let home = home(
            &format!(
                "model = 'root'\nprofile = 'work'\n[profiles.work]\nmodel = 'selected'\nmodel_provider = 'fixture'\n[model_providers.fixture]\nbase_url = '{}'\nexperimental_bearer_token = 'fake-key'\nhttp_headers = {{ X-Tenant = 'tenant' }}\nquery_params = {{ version = 'preview' }}\n",
                server.uri()
            ),
            "{}",
        );
        let sessions = home.path().join("sessions");
        std::fs::create_dir(&sessions).unwrap();
        let session = sessions.join("fixture.jsonl");
        std::fs::write(&session, "untouched session content\n").unwrap();
        Mock::given(method("POST")).and(path("/v1/responses"))
            .and(header("authorization", "Bearer fake-key"))
            .and(header("x-tenant", "tenant"))
            .and(query_param("version", "preview"))
            .and(body_partial_json(json!({"model":"selected","stream":true})))
            .respond_with(ResponseTemplate::new(200).insert_header("content-type","text/event-stream")
                .set_body_string("data: {\"type\":\"response.output_text.delta\",\"delta\":\"hello\"}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"model\":\"selected\",\"output\":[{\"type\":\"message\",\"content\":[{\"text\":\"hello\"}]}]}}\n\n"))
            .expect(1).mount(&server).await;
        let mut deltas = Vec::new();
        let result = crate::extension_llm::stream_from_home(
            &json!({"input":"test"}),
            home.path(),
            |delta| deltas.push(delta),
        )
        .await
        .unwrap();
        assert_eq!(result["text"], "hello");
        assert_eq!(result["model"], "selected");
        assert_eq!(deltas[0]["text"], "hello");
        assert_eq!(
            std::fs::read_to_string(session).unwrap(),
            "untouched session content\n"
        );
        assert_eq!(
            std::fs::read_to_string(home.path().join("auth.json")).unwrap(),
            "{}"
        );
    }
}
