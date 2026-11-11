//! 拓展只读访问 Codex 会话历史：会话列表来自 Codex 的线程表，消息来自会话的 rollout 文件。
//!
//! 全程只读：数据库以只读方式打开（WAL 下用 immutable 兜底），rollout 只读不写。返回的是
//! 整理过的条目（消息、工具调用、工具结果、推理摘要），不含加密推理内容与 Codex 注入的环境上下文。

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::Context;
use rusqlite::{Connection, OpenFlags, params_from_iter};
use serde_json::{Value, json};

/// 一页最多取多少条，防止拓展一次把超长会话全拉进页面。
pub const MAX_PAGE: usize = 500;
/// 单个条目文本的截断长度（工具输出可能极长）。
const MAX_TEXT: usize = 20_000;

/// Codex 注入到用户消息里的上下文块，不是用户自己说的话。
const INJECTED_PREFIXES: &[&str] = &[
    "<environment_context>",
    "<user_instructions>",
    "<permissions instructions>",
    "<turn_aborted>",
    "# AGENTS.md instructions",
];

fn open_readonly(path: &Path) -> anyhow::Result<Connection> {
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY
        | OpenFlags::SQLITE_OPEN_URI
        | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    if let Ok(connection) = Connection::open_with_flags(path, flags) {
        if connection
            .query_row("SELECT count(*) FROM threads", [], |_| Ok(()))
            .is_ok()
        {
            return Ok(connection);
        }
    }
    // WAL 模式下只读连接可能因为写不了 -shm 而打不开：退到 immutable（读到的是已落盘的内容）。
    let uri = format!("file:{}?mode=ro&immutable=1", path.display());
    Connection::open_with_flags(uri, flags)
        .with_context(|| format!("无法只读打开 {}", path.display()))
}

fn table_columns(connection: &Connection) -> anyhow::Result<Vec<String>> {
    let mut statement = connection.prepare("PRAGMA table_info(threads)")?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(columns)
}

fn thread_db(home: &Path) -> anyhow::Result<(Connection, Vec<String>)> {
    for path in crate::codex_sqlite::codex_session_db_paths_from_home(home) {
        if !path.exists() {
            continue;
        }
        if let Ok(connection) = open_readonly(&path) {
            let columns = table_columns(&connection)?;
            if columns.iter().any(|column| column == "id")
                && columns.iter().any(|column| column == "rollout_path")
            {
                return Ok((connection, columns));
            }
        }
    }
    anyhow::bail!("没有找到 Codex 的会话数据库")
}

/// Codex 版本迁移后可能同时留下新旧两个 threads 库，路径顺序靠前的未必是正在写的那个。
/// 会话时间线按「最近更新时间」选库，否则整页都是几个月前的旧数据。
/// 只用于 listRecentThreads，不改 listSessions 的既有取数契约。
fn active_thread_db(home: &Path) -> anyhow::Result<(Connection, Vec<String>)> {
    let mut best: Option<(i64, Connection, Vec<String>)> = None;
    for path in crate::codex_sqlite::codex_session_db_paths_from_home(home) {
        if !path.exists() {
            continue;
        }
        let Ok(connection) = open_readonly(&path) else {
            continue;
        };
        let Ok(columns) = table_columns(&connection) else {
            continue;
        };
        if !columns.iter().any(|column| column == "id")
            || !columns.iter().any(|column| column == "rollout_path")
        {
            continue;
        }
        let updated = if columns.iter().any(|column| column == "updated_at") {
            connection
                .query_row("SELECT max(updated_at) FROM threads", [], |row| row.get::<_, Option<i64>>(0))
                .ok()
                .flatten()
                .unwrap_or(0)
        } else {
            0
        };
        if best.as_ref().map_or(true, |(score, _, _)| updated > *score) {
            best = Some((updated, connection, columns));
        }
    }
    best.map(|(_, connection, columns)| (connection, columns))
        .ok_or_else(|| anyhow::anyhow!("没有找到 Codex 的会话数据库"))
}

/// 线程表里我们会读的列；旧版本缺的列按空值处理。
const THREAD_COLUMNS: &[&str] = &[
    "id",
    "title",
    "cwd",
    "model",
    "created_at",
    "updated_at",
    "archived",
    "first_user_message",
    "rollout_path",
    "git_branch",
];

fn select_list(columns: &[String]) -> String {
    THREAD_COLUMNS
        .iter()
        .map(|column| {
            if columns.iter().any(|existing| existing == column) {
                (*column).to_string()
            } else {
                format!("NULL AS {column}")
            }
        })
        .collect::<Vec<_>>()
        .join(", ")
}

fn thread_value(row: &rusqlite::Row<'_>) -> rusqlite::Result<(Value, Option<String>)> {
    let text = |index: usize| row.get::<_, Option<String>>(index).ok().flatten();
    let number = |index: usize| row.get::<_, Option<i64>>(index).ok().flatten();
    let rollout = text(8);
    Ok((
        json!({
            "id": text(0).unwrap_or_default(),
            "title": text(1).unwrap_or_default(),
            "cwd": text(2).unwrap_or_default(),
            "model": text(3).unwrap_or_default(),
            "createdAt": number(4),
            "updatedAt": number(5),
            "archived": number(6).unwrap_or(0) != 0,
            "preview": truncate(&text(7).unwrap_or_default(), 200),
            "gitBranch": text(9).unwrap_or_default(),
        }),
        rollout,
    ))
}

/// 会话列表：`{ search?, archived?, limit?, offset? }`，按更新时间倒序。
pub fn list_sessions(home: &Path, query: &Value) -> anyhow::Result<Value> {
    let (connection, columns) = thread_db(home)?;
    list_sessions_in(&connection, &columns, query)
}

fn list_sessions_in(connection: &Connection, columns: &[String], query: &Value) -> anyhow::Result<Value> {
    let has = |column: &str| columns.iter().any(|existing| existing == column);
    let limit = query
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(50)
        .clamp(1, MAX_PAGE as u64) as usize;
    let offset = query.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;
    let mut conditions = Vec::new();
    let mut values: Vec<String> = Vec::new();
    if has("archived") {
        match query.get("archived").and_then(Value::as_bool) {
            Some(true) => conditions.push("archived != 0".to_string()),
            Some(false) | None => conditions.push("(archived = 0 OR archived IS NULL)".to_string()),
        }
    }
    if query.get("excludeSubagents").and_then(Value::as_bool).unwrap_or(false) {
        // 子代理 / 守护进程审视线程不是用户会话：thread_source 标记了就直接排除，
        // 老库没有该列时退回 source 里的 subagent 标记。
        let mut derived = Vec::new();
        if has("thread_source") {
            derived.push(
                "lower(coalesce(thread_source, '')) IN ('subagent', 'guardian_review')".to_string(),
            );
        }
        if has("source") {
            derived.push("trim(coalesce(source, '')) LIKE '{\"subagent%'".to_string());
        }
        if !derived.is_empty() {
            conditions.push(format!("NOT ({})", derived.join(" OR ")));
        }
    }
    if let Some(search) = query
        .get("search")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
    {
        let fields = ["title", "first_user_message", "cwd"]
            .into_iter()
            .filter(|column| has(column))
            .collect::<Vec<_>>();
        if !fields.is_empty() {
            let pattern = format!(
                "%{}%",
                search
                    .replace('\\', "\\\\")
                    .replace('%', "\\%")
                    .replace('_', "\\_")
            );
            conditions.push(format!(
                "({})",
                fields
                    .iter()
                    .map(|column| format!("{column} LIKE ? ESCAPE '\\'"))
                    .collect::<Vec<_>>()
                    .join(" OR ")
            ));
            values.extend(std::iter::repeat_n(pattern, fields.len()));
        }
    }
    let filter = if conditions.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", conditions.join(" AND "))
    };
    let order = if has("updated_at") {
        " ORDER BY updated_at DESC"
    } else {
        ""
    };
    let total: i64 = connection.query_row(
        &format!("SELECT count(*) FROM threads{filter}"),
        params_from_iter(values.iter()),
        |row| row.get(0),
    )?;
    let sql = format!(
        "SELECT {} FROM threads{filter}{order} LIMIT {limit} OFFSET {offset}",
        select_list(&columns)
    );
    let mut statement = connection.prepare(&sql)?;
    let sessions = statement
        .query_map(params_from_iter(values.iter()), thread_value)?
        .filter_map(Result::ok)
        .map(|(session, _)| session)
        .collect::<Vec<_>>();
    Ok(json!({ "sessions": sessions, "total": total, "offset": offset, "limit": limit }))
}

/// 项目归属索引：只读 Codex 全局状态，给会话列表补上原生项目名。
/// 索引缺失、结构变化或文件读失败都只让项目名降级，不影响列表本身。
#[derive(Default)]
struct ProjectIndex {
    projects: HashMap<String, ProjectInfo>,
    roots: Vec<(String, String)>,
    assignments: HashMap<String, String>,
}

struct ProjectInfo {
    name: String,
    kind: String,
}

impl ProjectIndex {
    fn resolve(&self, id: &str, cwd: &str) -> Option<(&str, &ProjectInfo)> {
        // 显式归属优先；老会话大多没有归属记录，再按工作目录匹配项目根路径。
        let project_id = self.assignments.get(id).or_else(|| self.match_root(cwd))?;
        let (key, info) = self.projects.get_key_value(project_id)?;
        Some((key.as_str(), info))
    }

    fn match_root(&self, cwd: &str) -> Option<&String> {
        let path = normalize_path(cwd);
        let mut best: Option<(&String, usize)> = None;
        for (root, id) in &self.roots {
            let matched = path == root.as_str()
                || (path.starts_with(root.as_str()) && path.as_bytes().get(root.len()) == Some(&b'/'));
            if matched && best.map_or(true, |(_, len)| root.len() > len) {
                best = Some((id, root.len()));
            }
        }
        best.map(|(id, _)| id)
    }
}

/// Windows 与 macOS 路径统一成小写斜杠形式，只用于比较，不用于展示。
fn normalize_path(path: &str) -> String {
    path.replace('\\', "/").trim_end_matches('/').to_lowercase()
}

fn directory_name(cwd: &str) -> String {
    cwd.replace('\\', "/")
        .trim_end_matches('/')
        .rsplit('/')
        .find(|part| !part.is_empty())
        .unwrap_or("")
        .to_string()
}

fn project_index(home: &Path) -> ProjectIndex {
    let mut index = ProjectIndex::default();
    let Ok(text) = fs::read_to_string(home.join(".codex-global-state.json")) else {
        return index;
    };
    let Ok(state) = serde_json::from_str::<Value>(&text) else {
        return index;
    };
    let Some(object) = state.as_object() else {
        return index;
    };
    if let Some(projects) = object.get("local-projects").and_then(Value::as_object) {
        for (id, value) in projects {
            let Some(name) = value.get("name").and_then(Value::as_str) else {
                continue;
            };
            if name.is_empty() {
                continue;
            }
            index.projects.insert(
                id.clone(),
                ProjectInfo { name: name.to_string(), kind: "local".to_string() },
            );
            if let Some(roots) = value.get("rootPaths").and_then(Value::as_array) {
                for root in roots.iter().filter_map(Value::as_str) {
                    let normalized = normalize_path(root);
                    if !normalized.is_empty() {
                        index.roots.push((normalized, id.clone()));
                    }
                }
            }
        }
    }
    if let Some(assignments) = object.get("thread-project-assignments").and_then(Value::as_object) {
        for (thread_id, value) in assignments {
            let Some(project_id) = value.get("projectId").and_then(Value::as_str) else {
                continue;
            };
            // 只接受能解析到名字的项目，否则退回按目录匹配。
            if index.projects.contains_key(project_id) {
                index.assignments.insert(thread_id.clone(), project_id.to_string());
            }
        }
    }
    index
}

/// 侧栏会话列表：从最近有更新的 threads 库取数，复用排序、归档过滤与分页，逐条补项目归属。
/// 默认排除子代理 / 守护审视线程——它们不是用户会话，混进来只会是一堆「未命名对话」。
/// 没有项目归属时只给 directory（工作目录名），不按目录名冒充原生项目名。
pub fn list_recent_threads(home: &Path, query: &Value) -> anyhow::Result<Value> {
    let (connection, columns) = active_thread_db(home)?;
    let mut effective = query.clone();
    if effective.get("excludeSubagents").is_none() {
        if let Some(object) = effective.as_object_mut() {
            object.insert("excludeSubagents".into(), Value::Bool(true));
        }
    }
    let mut result = list_sessions_in(&connection, &columns, &effective)?;
    let index = project_index(home);
    if let Some(sessions) = result.get_mut("sessions").and_then(Value::as_array_mut) {
        for session in sessions.iter_mut() {
            let id = session.get("id").and_then(Value::as_str).unwrap_or("").to_string();
            let cwd = session.get("cwd").and_then(Value::as_str).unwrap_or("").to_string();
            let (project_id, project_name, project_kind) = match index.resolve(&id, &cwd) {
                Some((project_id, info)) => (json!(project_id), json!(info.name), json!(info.kind)),
                None => (Value::Null, Value::Null, Value::Null),
            };
            if let Some(map) = session.as_object_mut() {
                map.insert("projectId".into(), project_id);
                map.insert("projectName".into(), project_name);
                map.insert("projectKind".into(), project_kind);
                map.insert("directory".into(), json!(directory_name(&cwd)));
            }
        }
    }
    Ok(result)
}

/// 按条件筛会话：条件下推到 SQL，不受「最近 500 条」限制。
/// `{ id?, cwd?（前缀）, archived?, createdAfter?, createdBefore?, limit? }`
fn filter_sessions(home: &Path, options: &Value) -> anyhow::Result<Value> {
    let (connection, columns) = thread_db(home)?;
    let has = |column: &str| columns.iter().any(|existing| existing == column);
    let mut conditions = Vec::new();
    let mut values: Vec<rusqlite::types::Value> = Vec::new();
    if let Some(id) = options.get("id").and_then(Value::as_str) {
        conditions.push("id = ?".to_string());
        values.push(id.to_string().into());
    }
    if has("archived") {
        match options.get("archived").and_then(Value::as_bool) {
            Some(true) => conditions.push("archived != 0".to_string()),
            Some(false) => conditions.push("(archived = 0 OR archived IS NULL)".to_string()),
            // 按 id 精确查时不限归档状态；其余默认只看未归档。
            None if options.get("id").is_some() => {}
            None => conditions.push("(archived = 0 OR archived IS NULL)".to_string()),
        }
    }
    if let (Some(cwd), true) = (options.get("cwd").and_then(Value::as_str), has("cwd")) {
        conditions.push("cwd LIKE ? ESCAPE '\\'".to_string());
        values.push(
            format!(
                "{}%",
                cwd.replace('\\', "\\\\")
                    .replace('%', "\\%")
                    .replace('_', "\\_")
            )
            .into(),
        );
    }
    if has("created_at") {
        if let Some(after) = options.get("createdAfter").and_then(Value::as_i64) {
            conditions.push("created_at >= ?".to_string());
            values.push(after.into());
        }
        if let Some(before) = options.get("createdBefore").and_then(Value::as_i64) {
            conditions.push("created_at < ?".to_string());
            values.push(before.into());
        }
    }
    let limit = options
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(MAX_PAGE as u64)
        .clamp(1, MAX_PAGE as u64);
    let filter = if conditions.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", conditions.join(" AND "))
    };
    let order = if has("updated_at") {
        " ORDER BY updated_at DESC"
    } else {
        ""
    };
    let sql = format!(
        "SELECT {} FROM threads{filter}{order} LIMIT {limit}",
        select_list(&columns)
    );
    let mut statement = connection.prepare(&sql)?;
    let sessions = statement
        .query_map(params_from_iter(values.iter()), thread_value)?
        .filter_map(Result::ok)
        .map(|(session, _)| session)
        .collect::<Vec<_>>();
    Ok(Value::Array(sessions))
}

fn find_thread(home: &Path, id: &str) -> anyhow::Result<(Value, Option<PathBuf>)> {
    let (connection, columns) = thread_db(home)?;
    let sql = format!(
        "SELECT {} FROM threads WHERE id = ?1",
        select_list(&columns)
    );
    let (session, rollout) = connection
        .query_row(&sql, [id], thread_value)
        .map_err(|_| anyhow::anyhow!("没有找到会话 {id}"))?;
    Ok((
        session,
        rollout.filter(|path| !path.is_empty()).map(PathBuf::from),
    ))
}

/// 单个会话的元信息。
pub fn get_session(home: &Path, id: &str) -> anyhow::Result<Value> {
    Ok(find_thread(home, id)?.0)
}

fn truncate(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    let mut cut = text.chars().take(limit).collect::<String>();
    cut.push('…');
    cut
}

fn content_text(content: &Value) -> String {
    content
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|block| match block.get("type").and_then(Value::as_str)? {
            "input_text" | "output_text" | "text" => block
                .get("text")
                .and_then(Value::as_str)
                .map(str::to_string),
            "input_image" => Some("[图片]".to_string()),
            _ => None,
        })
        .filter(|text| {
            let trimmed = text.trim_start();
            !trimmed.is_empty()
                && !INJECTED_PREFIXES
                    .iter()
                    .any(|prefix| trimmed.starts_with(prefix))
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn output_text(output: &Value) -> String {
    match output {
        Value::String(text) => text.clone(),
        Value::Array(_) => content_text(output),
        Value::Object(object) => object
            .get("content")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| output.to_string()),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// 把 rollout 整理成事件日志：`{ type, seq, time, data }`，seq 从 0 连续编号。
/// 类型：`turn/start`、`user/message`、`assistant/message`、`assistant/reasoning`、`tool/call`、`tool/result`、
/// `turn/complete`（含耗时）、`turn/aborted`（含原因）、`token/usage`、`session/compacted`。
fn rollout_events(path: &Path) -> anyhow::Result<Vec<Value>> {
    let content = std::fs::read_to_string(path)
        .with_context(|| format!("无法读取 rollout {}", path.display()))?;
    let mut events = Vec::new();
    let mut turn = String::new();
    let push = |events: &mut Vec<Value>, kind: &str, time: &str, data: Value| {
        let seq = events.len();
        events.push(json!({ "type": kind, "seq": seq, "time": time, "data": data }));
    };
    for line in content.lines() {
        let Ok(event) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let payload = &event["payload"];
        let time = event
            .get("timestamp")
            .and_then(Value::as_str)
            .unwrap_or_default();
        match (event["type"].as_str(), payload["type"].as_str()) {
            (Some("turn_context"), _) | (Some("event_msg"), Some("task_started")) => {
                if let Some(id) = payload["turn_id"].as_str().filter(|id| *id != turn) {
                    turn = id.to_string();
                    push(&mut events, "turn/start", time, json!({ "turn": turn }));
                }
            }
            (Some("response_item"), Some("message")) => {
                let role = payload["role"].as_str().unwrap_or_default();
                if role != "user" && role != "assistant" {
                    continue;
                }
                let text = content_text(&payload["content"]);
                if text.trim().is_empty() {
                    continue;
                }
                let mut data = json!({ "turn": turn, "id": payload["id"].as_str().unwrap_or_default(), "text": truncate(&text, MAX_TEXT) });
                if role == "assistant" {
                    data["phase"] = payload.get("phase").cloned().unwrap_or(Value::Null);
                }
                push(
                    &mut events,
                    if role == "user" {
                        "user/message"
                    } else {
                        "assistant/message"
                    },
                    time,
                    data,
                );
            }
            (Some("response_item"), Some(kind @ ("function_call" | "custom_tool_call"))) => {
                let input = if kind == "function_call" {
                    &payload["arguments"]
                } else {
                    &payload["input"]
                };
                let input = input
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| input.to_string());
                push(
                    &mut events,
                    "tool/call",
                    time,
                    json!({
                        "turn": turn, "name": payload["name"].as_str().unwrap_or_default(),
                        "callId": payload["call_id"].as_str().unwrap_or_default(), "input": truncate(&input, MAX_TEXT),
                    }),
                );
            }
            (Some("response_item"), Some("function_call_output" | "custom_tool_call_output")) => {
                push(
                    &mut events,
                    "tool/result",
                    time,
                    json!({
                        "turn": turn, "callId": payload["call_id"].as_str().unwrap_or_default(),
                        "output": truncate(&output_text(&payload["output"]), MAX_TEXT),
                    }),
                );
            }
            (Some("event_msg"), Some("task_complete")) => {
                push(
                    &mut events,
                    "turn/complete",
                    time,
                    json!({
                        "turn": payload["turn_id"].as_str().unwrap_or(&turn),
                        "durationMs": payload.get("duration_ms").cloned().unwrap_or(Value::Null),
                        "lastMessage": truncate(payload["last_agent_message"].as_str().unwrap_or_default(), MAX_TEXT),
                    }),
                );
            }
            (Some("event_msg"), Some("turn_aborted")) => {
                push(
                    &mut events,
                    "turn/aborted",
                    time,
                    json!({
                        "turn": payload["turn_id"].as_str().unwrap_or(&turn),
                        "reason": payload.get("reason").cloned().unwrap_or(Value::Null),
                    }),
                );
            }
            (Some("event_msg"), Some("token_count")) => {
                if let Some(info) = payload.get("info").filter(|info| !info.is_null()) {
                    push(
                        &mut events,
                        "token/usage",
                        time,
                        json!({
                            "turn": turn,
                            "total": info.get("total_token_usage").cloned().unwrap_or(Value::Null),
                            "last": info.get("last_token_usage").cloned().unwrap_or(Value::Null),
                            "contextWindow": info.get("model_context_window").cloned().unwrap_or(Value::Null),
                        }),
                    );
                }
            }
            (Some("compacted"), _) | (Some("event_msg"), Some("context_compacted")) => {
                push(
                    &mut events,
                    "session/compacted",
                    time,
                    json!({ "turn": turn }),
                );
            }
            (Some("response_item"), Some("reasoning")) => {
                let summary = payload["summary"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|part| part.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("\n\n");
                if !summary.trim().is_empty() {
                    push(
                        &mut events,
                        "assistant/reasoning",
                        time,
                        json!({ "turn": turn, "text": truncate(&summary, MAX_TEXT) }),
                    );
                }
            }
            _ => {}
        }
    }
    Ok(events)
}

/// 解析结果缓存：rollout 路径 → (修改时间, 大小, 事件)。文件没变就不重新解析；
/// 订阅会话（每隔几秒增量读）和全量搜索都靠它。条目上限防止长期占用过多内存。
const EVENT_CACHE_LIMIT: usize = 64;
type CachedEvents = (std::time::SystemTime, u64, std::sync::Arc<Vec<Value>>);
static EVENT_CACHE: std::sync::LazyLock<
    std::sync::Mutex<(
        std::collections::HashMap<PathBuf, CachedEvents>,
        std::collections::VecDeque<PathBuf>,
    )>,
> = std::sync::LazyLock::new(Default::default);

fn cached_rollout_events(path: &Path) -> anyhow::Result<std::sync::Arc<Vec<Value>>> {
    let meta =
        std::fs::metadata(path).with_context(|| format!("无法读取 rollout {}", path.display()))?;
    let stamp = (meta.modified().unwrap_or(std::time::UNIX_EPOCH), meta.len());
    {
        let cache = EVENT_CACHE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some((modified, len, events)) = cache.0.get(path) {
            if (*modified, *len) == stamp {
                return Ok(events.clone());
            }
        }
    }
    let events = std::sync::Arc::new(rollout_events(path)?);
    let mut cache = EVENT_CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let (map, order) = &mut *cache;
    if map
        .insert(path.to_path_buf(), (stamp.0, stamp.1, events.clone()))
        .is_none()
    {
        order.push_back(path.to_path_buf());
    }
    while order.len() > EVENT_CACHE_LIMIT {
        if let Some(oldest) = order.pop_front() {
            map.remove(&oldest);
        }
    }
    Ok(events)
}

fn session_events(home: &Path, id: &str) -> anyhow::Result<(Value, Vec<Value>)> {
    let (session, rollout) = find_thread(home, id)?;
    let rollout = rollout.with_context(|| format!("会话 {id} 没有 rollout 文件"))?;
    Ok((session, cached_rollout_events(&rollout)?.as_ref().clone()))
}

/// 事件里可供文本检索的内容。
fn event_text(event: &Value) -> String {
    let data = &event["data"];
    ["text", "input", "output", "name"]
        .iter()
        .filter_map(|key| data.get(*key).and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n")
}

fn type_filter(params: &Value) -> Option<Vec<String>> {
    match params.get("types") {
        Some(Value::String(kind)) => Some(vec![kind.clone()]),
        Some(Value::Array(kinds)) => Some(
            kinds
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect(),
        ),
        _ => None,
    }
}

fn matches_types(event: &Value, types: &Option<Vec<String>>) -> bool {
    types.as_ref().is_none_or(|types| {
        types
            .iter()
            .any(|kind| event["type"].as_str() == Some(kind.as_str()))
    })
}

/// 轻量事件：长文本只留前 200 字，供列表浏览。
fn lightweight(mut event: Value) -> Value {
    if let Some(data) = event.get_mut("data").and_then(Value::as_object_mut) {
        for key in ["text", "input", "output"] {
            if let Some(text) = data.get(key).and_then(Value::as_str) {
                let short = truncate(text, 200);
                data.insert(key.to_string(), json!(short));
            }
        }
    }
    event
}

fn page(params: &Value, default_limit: usize) -> (usize, usize) {
    let limit = params
        .get("limit")
        .and_then(Value::as_u64)
        .map(|limit| limit as usize)
        .unwrap_or(default_limit)
        .clamp(1, MAX_PAGE);
    let offset = params
        .get("cursor")
        .and_then(|cursor| {
            cursor
                .as_str()
                .and_then(|text| text.parse().ok())
                .or_else(|| cursor.as_u64())
        })
        .or_else(|| params.get("offset").and_then(Value::as_u64))
        .unwrap_or(0) as usize;
    (offset, limit)
}

fn lowercase_contains(haystack: &str, needle: &str) -> bool {
    haystack.to_lowercase().contains(&needle.to_lowercase())
}

/// 按方法名分派，方法与参数形状对齐会话查询服务：
/// - `listSessions({ archived?, limit?, offset? })` → 会话数组（新到旧）
/// - `listRecentThreads({ archived?, limit?, offset?, excludeSubagents? })` → `{ sessions, total, offset, limit }`，
///   会话带项目归属与 gitBranch；默认排除子代理线程
/// - `filterSessions({ id?, cwd?, archived?, createdAfter?, createdBefore?, limit? })` → 会话数组
/// - `readSession(id)` → `{ session, events }`
/// - `readTitle(id)` → 标题字符串
/// - `listEvents(id, { types?, offset?, limit?, fromEnd? })` → 轻量事件数组
/// - `filterEvents(id, { types?, text?, limit? })` → 事件数组
/// - `readEvent({ sessionId, seq, before?, after? })` → 以 seq 为中心的事件窗口
/// - `readEventsSince({ sessionId, seq, limit? })` → seq 及之后的完整事件（订阅会话用）
/// - `searchSessions({ query, limit?, cursor? })` → `{ items, nextCursor }`
/// - `searchEvents({ query, sessionId?, types?, limit?, cursor? })` → `{ items: [{ sessionId, event }], nextCursor }`
pub fn call(home: &Path, method: &str, params: &Value) -> anyhow::Result<Value> {
    let id_param = || -> anyhow::Result<String> {
        params
            .as_str()
            .or_else(|| params.get("id").and_then(Value::as_str))
            .or_else(|| params.get("sessionId").and_then(Value::as_str))
            .filter(|id| !id.is_empty())
            .map(str::to_string)
            .context("缺少会话 id")
    };
    let options = params
        .get("options")
        .cloned()
        .unwrap_or_else(|| params.clone());
    Ok(match method {
        "listSessions" => list_sessions(home, &options)?["sessions"].take(),
        "listRecentThreads" => list_recent_threads(home, &options)?,
        "filterSessions" => filter_sessions(home, &options)?,
        "readSession" => {
            let (session, events) = session_events(home, &id_param()?)?;
            json!({ "session": session, "events": events })
        }
        "readTitle" => get_session(home, &id_param()?)?["title"].take(),
        "listEvents" => {
            let (_, events) = session_events(home, &id_param()?)?;
            let types = type_filter(&options);
            let events = events
                .into_iter()
                .filter(|event| matches_types(event, &types))
                .collect::<Vec<_>>();
            let (offset, limit) = page(&options, 100);
            let total = events.len();
            let offset = offset.min(total);
            let (start, end) = if options
                .get("fromEnd")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                ((total - offset).saturating_sub(limit), total - offset)
            } else {
                (offset, (offset + limit).min(total))
            };
            Value::Array(
                events
                    .into_iter()
                    .skip(start)
                    .take(end - start)
                    .map(lightweight)
                    .collect(),
            )
        }
        "filterEvents" => {
            let (_, events) = session_events(home, &id_param()?)?;
            let types = type_filter(&options);
            let text = options
                .get("text")
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty());
            let limit = options
                .get("limit")
                .and_then(Value::as_u64)
                .unwrap_or(MAX_PAGE as u64) as usize;
            Value::Array(
                events
                    .into_iter()
                    .filter(|event| matches_types(event, &types))
                    .filter(|event| {
                        text.is_none_or(|text| lowercase_contains(&event_text(event), text))
                    })
                    .take(limit)
                    .collect(),
            )
        }
        "readEventsSince" => {
            let (_, events) = session_events(home, &id_param()?)?;
            let seq = options.get("seq").and_then(Value::as_u64).unwrap_or(0) as usize;
            let limit = options
                .get("limit")
                .and_then(Value::as_u64)
                .unwrap_or(MAX_PAGE as u64)
                .min(MAX_PAGE as u64) as usize;
            Value::Array(events.into_iter().skip(seq).take(limit).collect())
        }
        "readEvent" => {
            let (_, events) = session_events(home, &id_param()?)?;
            let seq = options
                .get("seq")
                .and_then(Value::as_u64)
                .context("缺少 seq")? as usize;
            let before = options
                .get("before")
                .and_then(Value::as_u64)
                .unwrap_or(0)
                .min(50) as usize;
            let after = options
                .get("after")
                .and_then(Value::as_u64)
                .unwrap_or(0)
                .min(50) as usize;
            if seq >= events.len() {
                anyhow::bail!("会话里没有 seq {seq}");
            }
            let start = seq.saturating_sub(before);
            let end = (seq + after + 1).min(events.len());
            Value::Array(events[start..end].to_vec())
        }
        "searchSessions" => {
            let query = options
                .get("query")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let (offset, limit) = page(&options, 20);
            let found = list_sessions(
                home,
                &json!({ "search": query, "archived": options.get("archived"), "limit": limit, "offset": offset }),
            )?;
            let total = found["total"].as_u64().unwrap_or(0) as usize;
            let next = (offset + limit < total).then(|| (offset + limit).to_string());
            json!({ "items": found["sessions"], "nextCursor": next })
        }
        "searchEvents" => {
            let query = options
                .get("query")
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
                .context("缺少 query")?;
            let types = type_filter(&options);
            let (offset, limit) = page(&options, 20);
            // 不给 sessionId 时按新到旧扫全部会话（archived: true 时扫归档的），找够一页就停；解析结果有缓存。
            let sessions = match options.get("sessionId").and_then(Value::as_str) {
                Some(id) => vec![id.to_string()],
                None => all_session_ids(
                    home,
                    options
                        .get("archived")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                )?,
            };
            let mut matches = Vec::new();
            for id in sessions {
                let Ok((_, events)) = session_events(home, &id) else {
                    continue;
                };
                for event in events {
                    if matches_types(&event, &types)
                        && lowercase_contains(&event_text(&event), query)
                    {
                        matches.push(json!({ "sessionId": id, "event": lightweight(event) }));
                    }
                }
                if matches.len() > offset + limit {
                    break;
                }
            }
            let next = (matches.len() > offset + limit).then(|| (offset + limit).to_string());
            json!({ "items": matches.into_iter().skip(offset).take(limit).collect::<Vec<_>>(), "nextCursor": next })
        }
        other => anyhow::bail!("会话查询没有方法 {other}"),
    })
}

/// 全部会话 id（新到旧），不受单页上限限制。
fn all_session_ids(home: &Path, archived: bool) -> anyhow::Result<Vec<String>> {
    let (connection, columns) = thread_db(home)?;
    let has = |column: &str| columns.iter().any(|existing| existing == column);
    let filter = if has("archived") {
        if archived {
            " WHERE archived != 0"
        } else {
            " WHERE (archived = 0 OR archived IS NULL)"
        }
    } else {
        ""
    };
    let order = if has("updated_at") {
        " ORDER BY updated_at DESC"
    } else {
        ""
    };
    let mut statement = connection.prepare(&format!("SELECT id FROM threads{filter}{order}"))?;
    let ids = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .filter_map(Result::ok)
        .collect();
    Ok(ids)
}

/// 桥接路由 `/extensions/history`：`{ method, params }`。
pub fn route(payload: &Value) -> anyhow::Result<Value> {
    route_at(&crate::codex_sqlite::default_codex_home_dir(), payload)
}

pub fn route_at(home: &Path, payload: &Value) -> anyhow::Result<Value> {
    let method = payload
        .get("method")
        .and_then(Value::as_str)
        .context("缺少方法名")?;
    let result = call(home, method, payload.get("params").unwrap_or(&Value::Null))?;
    Ok(json!({ "status": "ok", "result": result }))
}
