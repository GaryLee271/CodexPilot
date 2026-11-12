//! 拓展只读访问会话历史：线程表列表、搜索、rollout 整理与分页。

use codex_plus_core::extension_history::{call, route_at};
use serde_json::{Value, json};
use std::fs;

fn home_with_threads() -> tempfile::TempDir {
    let temp = tempfile::tempdir().unwrap();
    let rollout = temp.path().join("rollout-a.jsonl");
    let lines = [
        json!({"type": "session_meta", "payload": {"id": "t-a"}}),
        json!({"type": "turn_context", "payload": {"turn_id": "turn-1"}}),
        json!({"type": "response_item", "timestamp": "2026-10-30T01:00:00Z", "payload": {"type": "message", "role": "developer", "content": [{"type": "input_text", "text": "系统说明"}]}}),
        json!({"type": "response_item", "payload": {"type": "message", "role": "user", "id": "u1", "content": [
            {"type": "input_text", "text": "<environment_context>cwd</environment_context>"},
            {"type": "input_text", "text": "帮我画图"}]}}),
        json!({"type": "response_item", "payload": {"type": "reasoning", "summary": [{"type": "summary_text", "text": "先想想"}], "encrypted_content": "密文"}}),
        json!({"type": "response_item", "payload": {"type": "function_call", "name": "shell", "arguments": "{\"cmd\":\"ls\"}", "call_id": "c1"}}),
        json!({"type": "response_item", "payload": {"type": "function_call_output", "call_id": "c1", "output": "a.txt"}}),
        json!({"type": "response_item", "payload": {"type": "message", "role": "assistant", "id": "m1", "phase": "final_answer", "content": [{"type": "output_text", "text": "画好了"}]}}),
        json!({"type": "event_msg", "payload": {"type": "token_count", "info": {"total_token_usage": {"total_tokens": 120}, "last_token_usage": {"total_tokens": 20}, "model_context_window": 1000}}}),
        json!({"type": "event_msg", "payload": {"type": "task_complete", "turn_id": "turn-1", "duration_ms": 1500, "last_agent_message": "画好了"}}),
        json!({"type": "event_msg", "payload": {"type": "task_started", "turn_id": "turn-2"}}),
        json!({"type": "response_item", "payload": {"type": "message", "role": "user", "id": "u2", "content": [{"type": "input_text", "text": "再改改"}]}}),
        json!({"type": "event_msg", "payload": {"type": "turn_aborted", "turn_id": "turn-2", "reason": "interrupted"}}),
    ];
    fs::write(&rollout, lines.iter().map(Value::to_string).collect::<Vec<_>>().join("\n") + "\nnot json\n").unwrap();
    let db = rusqlite::Connection::open(temp.path().join("state_5.sqlite")).unwrap();
    db.execute_batch(
        "CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, title TEXT, cwd TEXT, model TEXT, created_at INTEGER, updated_at INTEGER, archived INTEGER, first_user_message TEXT);",
    )
    .unwrap();
    for (id, title, updated, archived, rollout) in [
        ("t-a", "画曲线图", 30, 0, rollout.to_string_lossy().to_string()),
        ("t-b", "修 100% 的 bug", 20, 0, String::new()),
        ("t-c", "旧会话", 10, 1, String::new()),
    ] {
        db.execute(
            "INSERT INTO threads VALUES (?1, ?2, ?3, '/work', 'gpt', 1, ?4, ?5, ?3)",
            rusqlite::params![id, rollout, title, updated, archived],
        )
        .unwrap();
    }
    temp
}

fn ids(value: &Value) -> Vec<String> {
    value.as_array().unwrap().iter().map(|session| session["id"].as_str().unwrap().to_string()).collect()
}

#[test]
fn session_queries_list_filter_and_search_read_only() {
    let _guard = crate::common::global_state_lock();
    let home = home_with_threads();
    let home = home.path();
    assert_eq!(ids(&call(home, "listSessions", &json!({})).unwrap()), ["t-a", "t-b"], "新到旧，默认不含归档");
    assert_eq!(ids(&call(home, "listSessions", &json!({"archived": true})).unwrap()), ["t-c"]);
    assert_eq!(ids(&call(home, "filterSessions", &json!({"cwd": "/wo", "createdAfter": 1})).unwrap()), ["t-a", "t-b"]);
    assert_eq!(ids(&call(home, "filterSessions", &json!({"id": "t-b"})).unwrap()), ["t-b"]);
    assert_eq!(ids(&call(home, "filterSessions", &json!({"id": "t-c"})).unwrap()), ["t-c"], "按 id 查不受归档状态限制");
    assert_eq!(ids(&call(home, "filterSessions", &json!({"cwd": "/work", "archived": true})).unwrap()), ["t-c"]);
    assert_eq!(call(home, "readTitle", &json!("t-a")).unwrap(), "画曲线图");

    // % 按字面量匹配，不当通配符；游标分页。
    let found = call(home, "searchSessions", &json!({"query": "100%"})).unwrap();
    assert_eq!(ids(&found["items"]), ["t-b"]);
    assert!(found["nextCursor"].is_null());
    let first = call(home, "searchSessions", &json!({"query": "", "limit": 1})).unwrap();
    assert_eq!(ids(&first["items"]), ["t-a"]);
    let second = call(home, "searchSessions", &json!({"query": "", "limit": 1, "cursor": first["nextCursor"]})).unwrap();
    assert_eq!(ids(&second["items"]), ["t-b"]);

    // 路由包一层 { status, result }；未知方法、缺 id 报错。
    let routed = route_at(home, &json!({"method": "readTitle", "params": {"id": "t-b"}})).unwrap();
    assert_eq!(routed["result"], "修 100% 的 bug");
    assert!(call(home, "deleteSession", &json!("t-a")).unwrap_err().to_string().contains("没有方法"));
    assert!(call(home, "readSession", &json!({})).unwrap_err().to_string().contains("缺少会话 id"));
    assert!(call(home, "readSession", &json!("t-b")).unwrap_err().to_string().contains("没有 rollout"));
}

#[test]
fn recent_threads_carry_project_names_and_paging() {
    let _guard = crate::common::global_state_lock();
    let temp = home_with_threads();
    let home = temp.path();
    let db = rusqlite::Connection::open(home.join("state_5.sqlite")).unwrap();
    db.execute("UPDATE threads SET cwd = '/work/alpha/src' WHERE id = 't-a'", []).unwrap();
    db.execute("UPDATE threads SET cwd = '/work/beta' WHERE id = 't-b'", []).unwrap();
    db.execute("UPDATE threads SET cwd = '/work/other' WHERE id = 't-c'", []).unwrap();
    // 会话列表要显示当前分支，并默认滤掉子代理线程。
    db.execute_batch(
        "ALTER TABLE threads ADD COLUMN git_branch TEXT;
         ALTER TABLE threads ADD COLUMN thread_source TEXT;
         ALTER TABLE threads ADD COLUMN source TEXT;",
    )
    .unwrap();
    db.execute(
        "UPDATE threads SET git_branch = 'main', thread_source = 'user', source = 'vscode' WHERE id = 't-a'",
        [],
    )
    .unwrap();
    db.execute(
        "UPDATE threads SET git_branch = 'codex/feature', thread_source = 'user', source = 'vscode' WHERE id = 't-b'",
        [],
    )
    .unwrap();
    for (id, updated, source) in [
        ("t-s", 40, r#"{"subagent":{"thread_spawn":{"depth":1}}}"#),
        ("t-m", 50, r#"{"subagent":"memory_consolidation"}"#),
    ] {
        db.execute(
            "INSERT INTO threads (id, rollout_path, title, cwd, model, created_at, updated_at, archived, first_user_message, thread_source, source)
             VALUES (?1, '', '', '/work/alpha', 'gpt', 1, ?2, 0, '', NULL, ?3)",
            rusqlite::params![id, updated, source],
        )
        .unwrap();
    }
    drop(db);
    fs::write(
        home.join(".codex-global-state.json"),
        json!({
            "local-projects": {
                "p-alpha": {"id": "p-alpha", "name": "Alpha", "rootPaths": ["/work/alpha"]},
                "p-beta": {"id": "p-beta", "name": "Beta", "rootPaths": ["/work/beta"]}
            },
            "thread-project-assignments": {
                "t-b": {"projectKind": "local", "projectId": "p-beta"}
            }
        })
        .to_string(),
    )
    .unwrap();

    let page = call(home, "listRecentThreads", &json!({"limit": 1})).unwrap();
    assert_eq!(page["total"].as_u64(), Some(2), "默认排除归档与子代理线程");
    assert_eq!(page["offset"].as_u64(), Some(0));
    assert_eq!(page["limit"].as_u64(), Some(1));
    assert_eq!(page["sessions"][0]["id"], "t-a");
    assert_eq!(page["sessions"][0]["projectId"], "p-alpha", "老会话按 cwd 前缀匹配项目");
    assert_eq!(page["sessions"][0]["projectName"], "Alpha");
    assert_eq!(page["sessions"][0]["projectKind"], "local");
    assert_eq!(page["sessions"][0]["gitBranch"], "main", "带上当前分支");

    let second = call(home, "listRecentThreads", &json!({"limit": 1, "offset": 1})).unwrap();
    assert_eq!(second["sessions"][0]["id"], "t-b", "按 updated_at 倒序分页");
    assert_eq!(second["sessions"][0]["projectName"], "Beta", "显式归属优先");
    assert_eq!(second["sessions"][0]["gitBranch"], "codex/feature");

    // 显式关掉过滤时子代理线程仍在库里，证明是筛选而不是丢数据。
    let all = call(home, "listRecentThreads", &json!({"excludeSubagents": false})).unwrap();
    assert_eq!(all["total"].as_u64(), Some(4));

    let archived = call(home, "listRecentThreads", &json!({"archived": true})).unwrap();
    assert!(archived["sessions"][0]["projectName"].is_null(), "无项目归属时不冒充项目名");
    assert_eq!(archived["sessions"][0]["directory"], "other");

    fs::remove_file(home.join(".codex-global-state.json")).unwrap();
    let plain = call(home, "listRecentThreads", &json!({})).unwrap();
    assert_eq!(plain["sessions"].as_array().unwrap().len(), 2);
    assert!(plain["sessions"][0]["projectName"].is_null(), "全局状态缺失只降级，不报错");
    assert_eq!(plain["sessions"][0]["directory"], "src");
}

#[test]
fn recent_threads_use_the_session_name_not_the_first_message() {
    let _guard = crate::common::global_state_lock();
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path();
    let db = rusqlite::Connection::open(home.join("state_5.sqlite")).unwrap();
    db.execute_batch(
        "CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, title TEXT, cwd TEXT,
         model TEXT, created_at INTEGER, updated_at INTEGER, archived INTEGER,
         first_user_message TEXT, git_branch TEXT, name TEXT);",
    )
    .unwrap();
    // Codex 把首条用户消息原文写进 title，真正的会话名在 name 列。
    let first_message = format!("帮我\n重构  登录页\n{}", "并且把测试补齐 ".repeat(40));
    for (id, title, name, updated) in [
        ("t-named", first_message.as_str(), "重构登录页", 30),
        ("t-long", first_message.as_str(), "", 20),
        ("t-empty", "", "", 10),
    ] {
        db.execute(
            "INSERT INTO threads (id, rollout_path, title, cwd, model, created_at, updated_at,
             archived, first_user_message, git_branch, name)
             VALUES (?1, '', ?2, '/work', 'gpt', 1, ?3, 0, ?2, 'main', ?4)",
            rusqlite::params![id, title, updated, name],
        )
        .unwrap();
    }
    drop(db);

    let page = call(home, "listRecentThreads", &json!({})).unwrap();
    let sessions = page["sessions"].as_array().unwrap();
    let get = |id: &str| sessions.iter().find(|session| session["id"] == id).unwrap();
    assert_eq!(get("t-named")["name"], "重构登录页");
    assert_eq!(get("t-named")["displayTitle"], "重构登录页", "显示用标题优先取会话名");
    assert_eq!(get("t-named")["title"].as_str(), Some(first_message.as_str()), "title 原值不变，拓展契约不改");
    // 没有会话名时才退回首条消息，且必须折叠空白并限长。
    assert_eq!(get("t-long")["name"], "");
    let fallback = get("t-long")["displayTitle"].as_str().unwrap();
    assert!(fallback.starts_with("帮我 重构 登录页 并且把测试补齐"), "折叠换行与多余空白");
    assert_eq!(fallback.chars().count(), 121, "120 字 + 省略号，不能把几万字符塞给前端");
    assert_eq!(get("t-empty")["displayTitle"].as_str(), Some(""), "两者都空时交给前端显示未命名");
    let found = call(home, "searchSessions", &json!({"query": "重构登录页"})).unwrap();
    assert_eq!(ids(&found["items"]), ["t-named"], "会话名也要能搜到");

    // 旧库没有 name 列：select_list 补 NULL，只降级不报错。
    let legacy = home_with_threads();
    let old = call(legacy.path(), "listRecentThreads", &json!({})).unwrap();
    assert_eq!(old["sessions"][0]["name"], "");
    assert_eq!(old["sessions"][0]["displayTitle"], "画曲线图");
}

#[test]
fn recent_threads_follow_the_active_session_database() {
    let _guard = crate::common::global_state_lock();
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path();
    fs::create_dir_all(home.join("sqlite")).unwrap();
    let schema = "CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, title TEXT, cwd TEXT, updated_at INTEGER, archived INTEGER);";
    // 路径优先的 sqlite/ 子目录里是几个月前就不再写入的旧库。
    let stale = rusqlite::Connection::open(home.join("sqlite/state_5.sqlite")).unwrap();
    stale.execute_batch(schema).unwrap();
    stale.execute("INSERT INTO threads VALUES ('old', '', '旧会话', '/work', 10, 0)", []).unwrap();
    drop(stale);
    // Codex 当前实际写入的是 legacy 位置的库。
    let live = rusqlite::Connection::open(home.join("state_5.sqlite")).unwrap();
    live.execute_batch(schema).unwrap();
    live.execute("INSERT INTO threads VALUES ('new', '', '新会话', '/work', 900, 0)", []).unwrap();
    drop(live);
    fs::write(
        home.join(".codex-global-state.json"),
        json!({"local-projects": {"p": {"id": "p", "name": "Work", "rootPaths": ["/work"]}}}).to_string(),
    )
    .unwrap();

    let result = call(home, "listRecentThreads", &json!({})).unwrap();
    assert_eq!(result["sessions"][0]["id"], "new", "按最近更新时间选库，不能按路径顺序取旧数据");
    assert_eq!(result["sessions"][0]["projectName"], "Work");
    assert_eq!(result["total"].as_u64(), Some(1));
    // 既有 listSessions 仍按路径顺序，第三方拓展契约不变。
    assert_eq!(call(home, "listSessions", &json!({})).unwrap()[0]["id"], "old");
}

#[test]
fn session_events_follow_the_event_log_shape() {
    let _guard = crate::common::global_state_lock();
    let home = home_with_threads();
    let home = home.path();
    let read = call(home, "readSession", &json!("t-a")).unwrap();
    assert_eq!(read["session"]["title"], "画曲线图");
    let events = read["events"].as_array().unwrap();
    let kinds = events.iter().map(|event| event["type"].as_str().unwrap()).collect::<Vec<_>>();
    assert_eq!(kinds, [
        "turn/start", "user/message", "assistant/reasoning", "tool/call", "tool/result", "assistant/message",
        "token/usage", "turn/complete",
        "turn/start", "user/message", "turn/aborted",
    ]);
    assert!(events.iter().enumerate().all(|(index, event)| event["seq"] == index), "seq 连续");
    assert_eq!(events[1]["data"]["text"], "帮我画图", "去掉开发者消息与环境上下文");
    assert_eq!(events[1]["data"]["turn"], "turn-1");
    assert_eq!(events[3]["data"]["name"], "shell");
    assert_eq!(events[4]["data"]["output"], "a.txt");
    assert_eq!(events[5]["data"]["phase"], "final_answer");
    assert_eq!(events[6]["data"]["contextWindow"], 1000);
    assert_eq!(events[7]["data"], json!({"turn": "turn-1", "durationMs": 1500, "lastMessage": "画好了"}));
    assert_eq!(events[9]["data"]["turn"], "turn-2");
    assert_eq!(events[10]["data"]["reason"], "interrupted");
    assert!(!read.to_string().contains("密文"), "不返回加密推理");

    let messages = call(home, "listEvents", &json!({"id": "t-a", "types": ["user/message", "assistant/message"], "fromEnd": true, "limit": 2})).unwrap();
    let texts = messages.as_array().unwrap().iter().map(|event| event["data"]["text"].as_str().unwrap()).collect::<Vec<_>>();
    assert_eq!(texts, ["画好了", "再改改"]);
    let filtered = call(home, "filterEvents", &json!({"id": "t-a", "text": "A.TXT"})).unwrap();
    assert_eq!(filtered[0]["type"], "tool/result", "文本检索不分大小写");
    let window = call(home, "readEvent", &json!({"sessionId": "t-a", "seq": 3, "before": 1, "after": 1})).unwrap();
    assert_eq!(window.as_array().unwrap().iter().map(|event| event["seq"].as_u64().unwrap()).collect::<Vec<_>>(), [2, 3, 4]);
    let hits = call(home, "searchEvents", &json!({"query": "再改"})).unwrap();
    assert_eq!(hits["items"][0]["sessionId"], "t-a");
    assert_eq!(hits["items"][0]["event"]["seq"], 9);
}

#[test]
fn cached_events_refresh_when_the_rollout_grows() {
    let _guard = crate::common::global_state_lock();
    let home = home_with_threads();
    let home = home.path();
    let before = call(home, "readEventsSince", &json!({"sessionId": "t-a", "seq": 9})).unwrap();
    assert_eq!(before.as_array().unwrap().len(), 2, "seq 9、10");
    // 往 rollout 追加一条助手消息：缓存按修改时间与大小失效，增量读取能拿到新事件。
    let rollout = home.join("rollout-a.jsonl");
    let mut content = std::fs::read_to_string(&rollout).unwrap();
    content.push_str(&json!({"type": "response_item", "payload": {"type": "message", "role": "assistant", "id": "m2", "content": [{"type": "output_text", "text": "改好了"}]}}).to_string());
    content.push('\n');
    std::fs::write(&rollout, content).unwrap();
    let after = call(home, "readEventsSince", &json!({"sessionId": "t-a", "seq": 11})).unwrap();
    assert_eq!(after[0]["type"], "assistant/message");
    assert_eq!(after[0]["data"]["text"], "改好了");
    assert_eq!(after[0]["seq"], 11);
    let all = call(home, "searchEvents", &json!({"query": "改好"})).unwrap();
    assert_eq!(all["items"][0]["event"]["seq"], 11, "全量搜索看到新内容");
}
