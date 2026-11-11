use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OfficialLogin {
    pub access_token: String,
    pub refresh_token: String,
    pub account_id: String,
}

/// 从 auth.json 文本解析 ChatGPT 登录；没有 tokens 段或全为空时返回 None。
pub fn official_login_from_auth_contents(contents: &str) -> Option<OfficialLogin> {
    let value: Value = serde_json::from_str(contents).ok()?;
    official_login_from_auth_value(&value)
}

fn official_login_from_auth_value(value: &Value) -> Option<OfficialLogin> {
    let tokens = value.get("tokens")?;
    let access_token = string_field(tokens, "access_token");
    let refresh_token = string_field(tokens, "refresh_token");
    if access_token.is_empty() && refresh_token.is_empty() {
        return None;
    }
    Some(OfficialLogin {
        access_token,
        refresh_token,
        account_id: account_id_from_tokens(tokens),
    })
}

fn string_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or_default()
        .to_string()
}

/// account id 是 chatgpt-account-id 请求头的值；优先 tokens.account_id，
/// 缺失时从 id_token / access_token 的 claims 取（旧版 auth.json 没有顶层字段）。
fn account_id_from_tokens(tokens: &Value) -> String {
    let direct = string_field(tokens, "account_id");
    if !direct.is_empty() {
        return direct;
    }
    for key in ["id_token", "access_token"] {
        let token = string_field(tokens, key);
        if token.is_empty() {
            continue;
        }
        if let Some(claims) = jwt_claims(&token) {
            if let Some(id) = claims
                .get("https://api.openai.com/auth")
                .and_then(|auth| auth.get("chatgpt_account_id"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                return id.to_string();
            }
        }
    }
    String::new()
}

fn jwt_claims(token: &str) -> Option<Value> {
    let payload = token.split('.').nth(1)?;
    use base64::Engine;
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.as_bytes())
        .ok()
        .or_else(|| {
            base64::engine::general_purpose::URL_SAFE
                .decode(payload.as_bytes())
                .ok()
        })?;
    serde_json::from_slice(&decoded).ok()
}
