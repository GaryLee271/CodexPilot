//! 仅供用户主动删除 / 撤销时维护对应会话的侧栏引用；不扫描或修复历史。
use crate::storage::{has_table, json_to_sql_value, select_dicts};
use rusqlite::{Connection, ToSql};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionIndexCleanupCandidate {
    pub id: String,
    pub thread_name: String,
    pub updated_at: String,
}

#[derive(Debug, Clone)]
struct SessionIndexPlan {
    path: PathBuf,
    original_bytes: Vec<u8>,
    original_text: String,
}

fn known_session_index_candidate(line: &str) -> Option<SessionIndexCleanupCandidate> {
    let record = serde_json::from_str::<Value>(line).ok()?;
    let object = record.as_object()?;
    if object.len() != 3
        || !["id", "thread_name", "updated_at"]
            .iter()
            .all(|key| object.contains_key(*key))
    {
        return None;
    }
    let id = object.get("id")?.as_str()?.trim();
    let thread_name = object.get("thread_name")?.as_str()?;
    let updated_at = object.get("updated_at")?.as_str()?;
    if id.is_empty() || updated_at.trim().is_empty() {
        return None;
    }
    Some(SessionIndexCleanupCandidate {
        id: id.to_string(),
        thread_name: thread_name.to_string(),
        updated_at: updated_at.to_string(),
    })
}

fn filtered_session_index_text(
    plan: &SessionIndexPlan,
    selected_ids: &HashSet<String>,
) -> (String, usize) {
    let mut next_text = String::with_capacity(plan.original_text.len());
    let mut removed_entries = 0;
    for segment in plan.original_text.split_inclusive('\n') {
        let (line, line_ending) = split_line_ending(segment);
        let remove = known_session_index_candidate(line)
            .is_some_and(|candidate| selected_ids.contains(&candidate.id));
        if remove {
            removed_entries += 1;
        } else {
            next_text.push_str(line);
            next_text.push_str(line_ending);
        }
    }
    (next_text, removed_entries)
}

/// Return the `session_index.jsonl` lines (without trailing newline) that
/// reference `thread_id`. Used by the delete flow to keep a backup of the
/// entries it is about to remove.
pub fn session_index_lines_for_thread(
    codex_home: &Path,
    thread_id: &str,
) -> anyhow::Result<Vec<String>> {
    let path = codex_home.join("session_index.jsonl");
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = fs::read_to_string(&path)?;
    let mut lines = Vec::new();
    for segment in text.split_inclusive('\n') {
        let (line, _) = split_line_ending(segment);
        if known_session_index_candidate(line).is_some_and(|candidate| candidate.id == thread_id) {
            lines.push(line.to_string());
        }
    }
    Ok(lines)
}

/// Remove every `session_index.jsonl` entry for `thread_id` and write the
/// result back atomically. Returns the number of removed entries.
///
/// Best-effort: returns `Ok(0)` without writing when the file is missing or
/// changed since it was read, so a delete flow never clobbers fresh entries.
pub fn remove_session_index_entry(codex_home: &Path, thread_id: &str) -> anyhow::Result<usize> {
    let path = codex_home.join("session_index.jsonl");
    if !path.exists() {
        return Ok(0);
    }
    let original_bytes = fs::read(&path)?;
    let original_text = String::from_utf8(original_bytes.clone())?;
    let plan = SessionIndexPlan {
        path,
        original_bytes,
        original_text,
    };
    let selected_ids = HashSet::from([thread_id.to_string()]);
    let (next_text, removed_entries) = filtered_session_index_text(&plan, &selected_ids);
    if removed_entries == 0 {
        return Ok(0);
    }
    if fs::read(&plan.path)? != plan.original_bytes {
        return Ok(0);
    }
    codex_plus_core::settings::atomic_write(&plan.path, next_text.as_bytes())?;
    Ok(removed_entries)
}

/// 删除 Codex 侧边栏对线程的本地引用。
///
/// 线程正文由 `state_5.sqlite`/rollout 文件保存，而侧边栏还会从全局状态和
/// `sqlite/codex-dev.db` 的目录缓存读取条目。删除正文时必须同步清理这些缓存，
/// 否则重启后仍会显示一个无法恢复的“幽灵会话”。该操作按 thread id 精确匹配，
/// 可重复执行；缓存不存在或目标不存在均视为成功。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ThreadSidebarCleanupResult {
    pub global_state_entries_removed: usize,
    pub catalog_rows_removed: usize,
}

/// Capture the thread-specific sidebar data that is about to be removed.
/// The snapshot is embedded in the normal delete backup so undo can restore only
/// this thread's entries without replacing unrelated global state.
pub fn snapshot_thread_sidebar_references(
    codex_home: &Path,
    thread_id: &str,
) -> anyhow::Result<Value> {
    let thread_id = thread_id.strip_prefix("local:").unwrap_or(thread_id);
    let global_state = snapshot_thread_from_global_state(codex_home, thread_id)?;
    let catalog = snapshot_thread_from_catalog_dbs(codex_home, thread_id)?;
    Ok(json!({
        "thread_id": thread_id,
        "global_state": global_state,
        "catalog": catalog,
    }))
}

/// Restore a previously captured sidebar snapshot. Existing values are kept so
/// an undo cannot overwrite changes made after deletion.
pub fn restore_thread_sidebar_references(
    codex_home: &Path,
    snapshot: &Value,
) -> anyhow::Result<usize> {
    validate_thread_sidebar_snapshot(codex_home, snapshot)?;
    let thread_id = snapshot
        .get("thread_id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut restored = restore_thread_to_global_state(codex_home, thread_id, snapshot)?;
    restored += restore_thread_to_catalog_dbs(codex_home, thread_id, snapshot)?;
    Ok(restored)
}

pub fn validate_thread_sidebar_snapshot(codex_home: &Path, snapshot: &Value) -> anyhow::Result<()> {
    let thread_id = snapshot
        .get("thread_id")
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty())
        .ok_or_else(|| anyhow::anyhow!("sidebar snapshot is missing thread_id"))?;
    if let Some(catalog) = snapshot.get("catalog") {
        let entries = catalog
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("sidebar snapshot catalog must be an array"))?;
        let allowed_paths = sidebar_catalog_db_paths(codex_home)?;
        for entry in entries {
            let table = entry
                .get("table")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("sidebar catalog entry is missing table"))?;
            if !SIDEBAR_CATALOG_TABLES.contains(&table) {
                anyhow::bail!("unsupported sidebar catalog table: {table}");
            }
            let path = entry
                .get("db_path")
                .and_then(Value::as_str)
                .map(PathBuf::from)
                .ok_or_else(|| anyhow::anyhow!("sidebar catalog entry is missing db_path"))?;
            let canonical = fs::canonicalize(&path)?;
            if !allowed_paths.contains(&canonical) {
                anyhow::bail!("sidebar catalog database is not an allowed Codex database");
            }
            let rows = entry
                .get("rows")
                .and_then(Value::as_array)
                .ok_or_else(|| anyhow::anyhow!("sidebar catalog entry rows must be an array"))?;
            for row in rows {
                let row_id = row
                    .get("thread_id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| anyhow::anyhow!("sidebar catalog row is missing thread_id"))?;
                if row_id != thread_id {
                    anyhow::bail!("sidebar catalog row thread_id does not match snapshot");
                }
            }
        }
    }
    Ok(())
}

const SIDEBAR_CATALOG_TABLES: [&str; 3] = [
    "local_thread_catalog",
    "thread_timeline_ledger",
    "local_thread_catalog_scan_entries",
];

fn snapshot_thread_from_global_state(codex_home: &Path, thread_id: &str) -> anyhow::Result<Value> {
    let path = codex_home.join(".codex-global-state.json");
    if !path.exists() {
        return Ok(json!({}));
    }
    let value: Value = serde_json::from_slice(&fs::read(path)?)?;
    let Some(root) = value.as_object() else {
        return Ok(json!({}));
    };
    let mut snapshot = Map::new();
    if let Some(ids) = root.get("projectless-thread-ids").and_then(Value::as_array) {
        let values = ids
            .iter()
            .filter(|value| thread_value_matches(value, thread_id))
            .cloned()
            .collect::<Vec<_>>();
        if !values.is_empty() {
            snapshot.insert("projectless-thread-ids".to_string(), Value::Array(values));
        }
    }
    let mut maps = Map::new();
    for key in [
        "thread-projectless-output-directories",
        "thread-workspace-root-hints",
        "thread-writable-roots",
    ] {
        if let Some(map) = root.get(key).and_then(Value::as_object) {
            let entries = map
                .iter()
                .filter(|(key, _)| thread_key_matches(key, thread_id))
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect::<Map<_, _>>();
            if !entries.is_empty() {
                maps.insert(key.to_string(), Value::Object(entries));
            }
        }
    }
    if !maps.is_empty() {
        snapshot.insert("thread_maps".to_string(), Value::Object(maps));
    }
    if let Some(atom) = root
        .get("electron-persisted-atom-state")
        .and_then(Value::as_object)
    {
        let entries = atom
            .iter()
            .filter(|(key, _)| sidebar_atom_key_matches(key, thread_id))
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect::<Map<_, _>>();
        if !entries.is_empty() {
            snapshot.insert("atom_entries".to_string(), Value::Object(entries));
        }
    }
    Ok(Value::Object(snapshot))
}

fn snapshot_thread_from_catalog_dbs(codex_home: &Path, thread_id: &str) -> anyhow::Result<Value> {
    let mut entries = Vec::new();
    for path in codex_plus_core::codex_sqlite::codex_thread_reference_db_paths_from_home(codex_home)
    {
        if !path.exists() {
            continue;
        }
        let db = Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        for table in SIDEBAR_CATALOG_TABLES {
            let columns = table_columns(&db, table)?;
            if !columns.contains("thread_id") {
                continue;
            }
            let rows = select_dicts(
                &db,
                &format!("SELECT * FROM {table} WHERE thread_id = ?1"),
                &[&thread_id],
            )?;
            if !rows.is_empty() {
                entries.push(json!({
                    "db_path": path.to_string_lossy(),
                    "table": table,
                    "rows": rows,
                }));
            }
        }
    }
    Ok(Value::Array(entries))
}

fn restore_thread_to_global_state(
    codex_home: &Path,
    _thread_id: &str,
    snapshot: &Value,
) -> anyhow::Result<usize> {
    let global = snapshot.get("global_state").unwrap_or(&Value::Null);
    if !global.is_object() {
        return Ok(0);
    }
    let path = codex_home.join(".codex-global-state.json");
    let original_bytes = if path.exists() {
        fs::read(&path)?
    } else {
        Vec::new()
    };
    let mut state = if original_bytes.is_empty() {
        json!({})
    } else {
        serde_json::from_slice::<Value>(&original_bytes)?
    };
    let Some(root) = state.as_object_mut() else {
        return Ok(0);
    };
    let mut restored = 0usize;
    if let Some(values) = global
        .get("projectless-thread-ids")
        .and_then(Value::as_array)
    {
        let ids = root
            .entry("projectless-thread-ids")
            .or_insert_with(|| Value::Array(Vec::new()));
        if let Some(ids) = ids.as_array_mut() {
            for value in values {
                if !ids.iter().any(|existing| existing == value) {
                    ids.push(value.clone());
                    restored += 1;
                }
            }
        }
    }
    if let Some(maps) = global.get("thread_maps").and_then(Value::as_object) {
        restored += restore_missing_map_entries(root, maps);
    }
    if let Some(entries) = global.get("atom_entries").and_then(Value::as_object) {
        let atom = root
            .entry("electron-persisted-atom-state")
            .or_insert_with(|| Value::Object(Map::new()));
        if let Some(atom) = atom.as_object_mut() {
            for (key, value) in entries {
                if !atom.contains_key(key) {
                    atom.insert(key.clone(), value.clone());
                    restored += 1;
                }
            }
        }
    }
    if restored == 0 {
        return Ok(0);
    }
    if path.exists() && fs::read(&path)? != original_bytes {
        anyhow::bail!(".codex-global-state.json changed while restoring sidebar state");
    }
    codex_plus_core::settings::atomic_write(
        &path,
        serde_json::to_string_pretty(&state)?.as_bytes(),
    )?;
    Ok(restored)
}

fn restore_missing_map_entries(root: &mut Map<String, Value>, maps: &Map<String, Value>) -> usize {
    let mut restored = 0usize;
    for (key, entries) in maps {
        let value = root
            .entry(key.clone())
            .or_insert_with(|| Value::Object(Map::new()));
        if let (Some(target), Some(entries)) = (value.as_object_mut(), entries.as_object()) {
            for (entry_key, entry_value) in entries {
                if !target.contains_key(entry_key) {
                    target.insert(entry_key.clone(), entry_value.clone());
                    restored += 1;
                }
            }
        }
    }
    restored
}

fn restore_thread_to_catalog_dbs(
    codex_home: &Path,
    _thread_id: &str,
    snapshot: &Value,
) -> anyhow::Result<usize> {
    let Some(entries) = snapshot.get("catalog").and_then(Value::as_array) else {
        return Ok(0);
    };
    let allowed_paths = sidebar_catalog_db_paths(codex_home)?;
    let mut restored_total = 0usize;
    for entry in entries {
        let path = PathBuf::from(entry["db_path"].as_str().unwrap_or_default());
        let canonical = fs::canonicalize(&path)?;
        if !allowed_paths.contains(&canonical) {
            anyhow::bail!("sidebar catalog database is not an allowed Codex database");
        }
        let table = entry["table"].as_str().unwrap_or_default();
        let rows = entry["rows"].as_array().cloned().unwrap_or_default();
        let mut db = Connection::open(&path)?;
        let tx = db.transaction()?;
        if !has_table(&tx, table)? {
            tx.commit()?;
            continue;
        }
        let columns = table_columns(&tx, table)?;
        if !columns.contains("thread_id") {
            tx.commit()?;
            continue;
        }
        let mut restored = 0usize;
        for row in rows {
            if let Some(row) = row.as_object() {
                restored += insert_row_ignore(&tx, table, row)?;
            }
        }
        if restored > 0 {
            let metadata_columns = table_columns(&tx, "local_thread_catalog_metadata")?;
            update_local_catalog_metadata(&tx, &metadata_columns, restored)?;
        }
        tx.commit()?;
        restored_total += restored;
    }
    Ok(restored_total)
}

fn insert_row_ignore(
    db: &Connection,
    table: &str,
    row: &Map<String, Value>,
) -> anyhow::Result<usize> {
    let columns: Vec<&String> = row.keys().collect();
    if columns.is_empty() {
        return Ok(0);
    }
    let quoted = columns
        .iter()
        .map(|column| format!("\"{}\"", column.replace('\"', "\"\"")))
        .collect::<Vec<_>>()
        .join(", ");
    let marks = (0..columns.len())
        .map(|index| format!("?{}", index + 1))
        .collect::<Vec<_>>()
        .join(", ");
    let values = columns
        .iter()
        .map(|column| json_to_sql_value(&row[*column]))
        .collect::<Vec<_>>();
    let refs = values
        .iter()
        .map(|value| value as &dyn ToSql)
        .collect::<Vec<_>>();
    Ok(db.execute(
        &format!("INSERT OR IGNORE INTO \"{table}\" ({quoted}) VALUES ({marks})"),
        refs.as_slice(),
    )?)
}

fn sidebar_catalog_db_paths(codex_home: &Path) -> anyhow::Result<HashSet<PathBuf>> {
    Ok(
        codex_plus_core::codex_sqlite::codex_thread_reference_db_paths_from_home(codex_home)
            .into_iter()
            .filter_map(|path| fs::canonicalize(path).ok())
            .collect(),
    )
}

fn thread_value_matches(value: &Value, thread_id: &str) -> bool {
    value
        .as_str()
        .is_some_and(|value| value == thread_id || value == format!("local:{thread_id}"))
}

fn thread_key_matches(key: &str, thread_id: &str) -> bool {
    key == thread_id || key == format!("local:{thread_id}")
}

fn sidebar_atom_key_matches(key: &str, thread_id: &str) -> bool {
    let encoded_local = format!("local%3A{thread_id}");
    [
        format!("thread-client-id-v1:{thread_id}"),
        format!("thread-client-id-v1:{encoded_local}"),
        format!("thread-reference-capability:{thread_id}"),
        format!("thread-reference-capability:{encoded_local}"),
    ]
    .iter()
    .any(|candidate| key == candidate)
}

pub fn remove_thread_sidebar_references(
    codex_home: &Path,
    thread_id: &str,
) -> anyhow::Result<ThreadSidebarCleanupResult> {
    let thread_id = thread_id.strip_prefix("local:").unwrap_or(thread_id);
    let (global_state_entries_removed, global_error) =
        match remove_thread_from_global_state(codex_home, thread_id) {
            Ok(count) => (count, None),
            Err(error) => (0, Some(error)),
        };
    let (catalog_rows_removed, catalog_error) =
        match remove_thread_from_catalog_dbs(codex_home, thread_id) {
            Ok(count) => (count, None),
            Err(error) => (0, Some(error)),
        };
    if let Some(error) = global_error {
        return Err(error);
    }
    if let Some(error) = catalog_error {
        return Err(error);
    }
    Ok(ThreadSidebarCleanupResult {
        global_state_entries_removed,
        catalog_rows_removed,
    })
}

fn remove_thread_from_global_state(codex_home: &Path, thread_id: &str) -> anyhow::Result<usize> {
    let path = codex_home.join(".codex-global-state.json");
    if !path.exists() {
        return Ok(0);
    }
    let original_bytes = fs::read(&path)?;
    let mut state: Value = serde_json::from_slice(&original_bytes)?;
    let Some(root) = state.as_object_mut() else {
        return Ok(0);
    };
    let mut removed = 0usize;
    if let Some(ids) = root
        .get_mut("projectless-thread-ids")
        .and_then(Value::as_array_mut)
    {
        let before = ids.len();
        ids.retain(|value| !thread_value_matches(value, thread_id));
        removed += before.saturating_sub(ids.len());
    }
    for key in [
        "thread-projectless-output-directories",
        "thread-workspace-root-hints",
        "thread-writable-roots",
    ] {
        if let Some(map) = root.get_mut(key).and_then(Value::as_object_mut) {
            for candidate in [thread_id, &format!("local:{thread_id}")] {
                if map.remove(candidate).is_some() {
                    removed += 1;
                }
            }
        }
    }
    if let Some(atom) = root
        .get_mut("electron-persisted-atom-state")
        .and_then(Value::as_object_mut)
    {
        let encoded_local = format!("local%3A{thread_id}");
        let client_id = format!("thread-client-id-v1:{thread_id}");
        let client_id_encoded = format!("thread-client-id-v1:{encoded_local}");
        let reference_capability = format!("thread-reference-capability:{thread_id}");
        let reference_capability_encoded = format!("thread-reference-capability:{encoded_local}");
        let keys = atom
            .keys()
            .filter(|key| {
                *key == &client_id
                    || *key == &client_id_encoded
                    || *key == &reference_capability
                    || *key == &reference_capability_encoded
            })
            .cloned()
            .collect::<Vec<_>>();
        for key in keys {
            atom.remove(&key);
            removed += 1;
        }
    }
    if removed == 0 {
        return Ok(0);
    }
    if fs::read(&path)? != original_bytes {
        anyhow::bail!(".codex-global-state.json changed while deleting thread {thread_id}");
    }
    codex_plus_core::settings::atomic_write(
        &path,
        serde_json::to_string_pretty(&state)?.as_bytes(),
    )?;
    Ok(removed)
}

fn remove_thread_from_catalog_dbs(codex_home: &Path, thread_id: &str) -> anyhow::Result<usize> {
    let mut removed_total = 0usize;
    for path in codex_plus_core::codex_sqlite::codex_thread_reference_db_paths_from_home(codex_home)
    {
        if !path.exists() {
            continue;
        }
        let mut db = Connection::open(&path)?;
        db.busy_timeout(std::time::Duration::from_millis(500))?;
        let tx = db.transaction()?;
        let mut removed = 0usize;
        for table in [
            "local_thread_catalog",
            "thread_timeline_ledger",
            "local_thread_catalog_scan_entries",
        ] {
            let columns = table_columns(&tx, table)?;
            if !columns.contains("thread_id") {
                continue;
            }
            removed += tx.execute(
                &format!("DELETE FROM {table} WHERE thread_id = ?1"),
                [thread_id],
            )?;
        }
        if removed > 0 {
            let metadata_columns = table_columns(&tx, "local_thread_catalog_metadata")?;
            if metadata_columns.contains("catalog_revision") {
                tx.execute(
                    "UPDATE local_thread_catalog_metadata SET catalog_revision = catalog_revision + ?1",
                    [removed as i64],
                )?;
            }
        }
        tx.commit()?;
        removed_total += removed;
    }
    Ok(removed_total)
}

/// Append previously removed `session_index.jsonl` lines back (undo flow).
/// Lines whose `id` already exists are skipped. Returns the number of
/// appended lines. A changed file is reported as a conflict.
pub fn restore_session_index_entries(codex_home: &Path, lines: &[String]) -> anyhow::Result<usize> {
    let Some(plan) = plan_session_index_restore(codex_home, lines)? else {
        return Ok(0);
    };
    let staged = stage_session_index_restore(&plan)?;
    let result = publish_session_index_restore(&plan, &staged);
    let _ = fs::remove_file(&staged);
    result?;
    Ok(plan.appended)
}

/// 在恢复数据库前检查索引是否可读、可解析，以及同目录是否能持久化恢复内容。
pub(crate) fn preflight_restore_session_index_entries(
    codex_home: &Path,
    lines: &[String],
) -> anyhow::Result<()> {
    if let Some(plan) = plan_session_index_restore(codex_home, lines)? {
        let staged = stage_session_index_restore(&plan)?;
        fs::remove_file(staged)?;
    }
    Ok(())
}

struct SessionIndexRestorePlan {
    path: PathBuf,
    original: Option<Vec<u8>>,
    next: Vec<u8>,
    appended: usize,
}

fn read_session_index_snapshot(path: &Path) -> anyhow::Result<Option<Vec<u8>>> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
        Ok(metadata) if !metadata.is_file() => {
            anyhow::bail!("session_index.jsonl is not a regular file")
        }
        Ok(_) => Ok(Some(fs::read(path)?)),
    }
}

fn plan_session_index_restore(
    codex_home: &Path,
    lines: &[String],
) -> anyhow::Result<Option<SessionIndexRestorePlan>> {
    if lines.is_empty() {
        return Ok(None);
    }
    let path = codex_home.join("session_index.jsonl");
    let original = read_session_index_snapshot(&path)?;
    let original_text = String::from_utf8(original.clone().unwrap_or_default())?;
    let mut existing_ids = HashSet::new();
    for segment in original_text.split_inclusive('\n') {
        let (line, _) = split_line_ending(segment);
        if let Some(candidate) = known_session_index_candidate(line) {
            existing_ids.insert(candidate.id);
        }
    }
    let mut next_text = original_text;
    if !next_text.is_empty() && !next_text.ends_with('\n') {
        next_text.push('\n');
    }
    let mut appended = 0usize;
    for line in lines {
        if let Some(candidate) = known_session_index_candidate(line) {
            if existing_ids.contains(&candidate.id) {
                continue;
            }
            existing_ids.insert(candidate.id);
        }
        next_text.push_str(line);
        next_text.push('\n');
        appended += 1;
    }
    if appended == 0 {
        return Ok(None);
    }
    Ok(Some(SessionIndexRestorePlan {
        path,
        original,
        next: next_text.into_bytes(),
        appended,
    }))
}

fn stage_session_index_restore(plan: &SessionIndexRestorePlan) -> anyhow::Result<PathBuf> {
    let parent = plan
        .path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("session index has no parent"))?;
    let staged = parent.join(format!(
        ".session-index-restore-{}",
        uuid::Uuid::new_v4().simple()
    ));
    let result = (|| -> anyhow::Result<()> {
        let mut output = crate::backup::new_private_file(&staged)?;
        output.write_all(&plan.next)?;
        output.sync_all()?;
        Ok(())
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&staged);
        return Err(error);
    }
    Ok(staged)
}

fn publish_session_index_restore(
    plan: &SessionIndexRestorePlan,
    staged: &Path,
) -> anyhow::Result<()> {
    if read_session_index_snapshot(&plan.path)? != plan.original {
        anyhow::bail!("session_index.jsonl changed while restoring deleted entries");
    }
    if plan.original.is_none() {
        // 不存在时只能条件创建；不能覆盖预检后并发新建的索引。
        fs::hard_link(staged, &plan.path)?;
    } else {
        fs::rename(staged, &plan.path)?;
    }
    crate::backup::sync_directory(plan.path.parent().unwrap())?;
    Ok(())
}

fn split_line_ending(segment: &str) -> (&str, &str) {
    if let Some(line) = segment.strip_suffix("\r\n") {
        (line, "\r\n")
    } else if let Some(line) = segment.strip_suffix('\n') {
        (line, "\n")
    } else {
        (segment, "")
    }
}

fn table_columns(db: &Connection, table: &str) -> anyhow::Result<HashSet<String>> {
    let mut stmt = db.prepare(&format!(
        "PRAGMA table_info(\"{}\")",
        table.replace('"', "\"\"")
    ))?;
    Ok(stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<HashSet<_>>>()?)
}

fn update_local_catalog_metadata(
    tx: &rusqlite::Transaction<'_>,
    columns: &HashSet<String>,
    inserted: usize,
) -> anyhow::Result<()> {
    if !columns.contains("catalog_revision") {
        return Ok(());
    }
    let affected = tx.execute(
        "UPDATE local_thread_catalog_metadata SET catalog_revision = catalog_revision + ?1",
        [inserted as i64],
    )?;
    if affected == 0 && columns.contains("id") {
        tx.execute(
            "INSERT INTO local_thread_catalog_metadata (id, catalog_revision) VALUES (1, ?1)",
            [inserted as i64],
        )?;
    }
    Ok(())
}
