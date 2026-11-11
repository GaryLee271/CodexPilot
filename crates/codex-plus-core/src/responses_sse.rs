use serde_json::Value;

/// 把一段 Responses SSE 里 `response.completed`（或 `response.incomplete`）携带的完整响应取出来；
/// 后端只给流式结果，客户端要非流式时用它拼回 JSON。
pub fn responses_json_from_sse(body: &[u8]) -> Option<Value> {
    let text = String::from_utf8_lossy(body);
    let mut last = None;
    for block in text.split("\n\n") {
        let data = block
            .lines()
            .filter_map(|line| line.strip_prefix("data:"))
            .map(str::trim_start)
            .collect::<Vec<_>>()
            .join("\n");
        if data.is_empty() || data == "[DONE]" {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&data) else {
            continue;
        };
        if matches!(
            value.get("type").and_then(Value::as_str),
            Some("response.completed" | "response.incomplete" | "response.done")
        ) && let Some(response) = value.get("response")
        {
            last = Some(response.clone());
        }
    }
    last
}
