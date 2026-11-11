use std::path::{Path, PathBuf};

use crate::native_config::CodexConnection;
use serde_json::Value;
use std::collections::HashSet;
use toml_edit::{DocumentMut, Item, Table, TableLike};

pub fn default_codex_home_dir() -> PathBuf {
    crate::codex_home::default_codex_home_dir()
}

pub fn set_codex_goals_feature_in_home(home: &Path, enabled: bool) -> anyhow::Result<()> {
    std::fs::create_dir_all(home)?;
    let config_path = home.join("config.toml");
    let existing = std::fs::read_to_string(&config_path).unwrap_or_default();
    let updated = match parse_toml_document(&existing) {
        Ok(mut doc) => {
            if enabled {
                let features = table_mut_or_insert(&mut doc, "features")?;
                features["goals"] = toml_edit::value(true);
            } else if let Some(features) = table_mut_if_exists(&mut doc, "features") {
                features.remove("goals");
                if features.is_empty() {
                    doc.as_table_mut().remove("features");
                }
            }
            ensure_trailing_newline(doc.to_string())
        }
        Err(_) => set_codex_goals_feature_text_fallback(&existing, enabled),
    };
    crate::settings::atomic_write(&config_path, updated.as_bytes())
}

fn set_codex_goals_feature_text_fallback(existing: &str, enabled: bool) -> String {
    let mut kept = Vec::new();
    let mut skipping_features = false;

    for line in existing.lines() {
        let trimmed = line.trim();
        if trimmed == "[features]" {
            skipping_features = true;
            continue;
        }
        if skipping_features && trimmed.starts_with('[') && trimmed.ends_with(']') {
            skipping_features = false;
        }
        if !skipping_features {
            kept.push(line);
        }
    }

    let mut updated = kept.join("\n").trim_end().to_string();
    if enabled {
        if !updated.is_empty() {
            updated.push_str("\n\n");
        }
        updated.push_str("[features]\ngoals = true");
    }
    ensure_trailing_newline(updated)
}

fn table_mut_or_insert<'a>(doc: &'a mut DocumentMut, key: &str) -> anyhow::Result<&'a mut Table> {
    if !doc.as_table().contains_key(key) {
        doc[key] = toml_edit::table();
    }
    if doc.get(key).and_then(Item::as_table).is_none() {
        doc[key] = toml_edit::table();
    }
    doc.get_mut(key)
        .and_then(Item::as_table_mut)
        .ok_or_else(|| anyhow::anyhow!("{key} 必须是 TOML table"))
}

fn table_mut_if_exists<'a>(doc: &'a mut DocumentMut, key: &str) -> Option<&'a mut Table> {
    doc.get_mut(key).and_then(Item::as_table_mut)
}

fn parse_toml_document(contents: &str) -> anyhow::Result<DocumentMut> {
    let contents = contents.trim_start_matches('\u{feff}');
    if contents.trim().is_empty() {
        Ok(DocumentMut::new())
    } else {
        // 解析错误不带原文（那一行可能是 Key），只报行列。
        contents
            .parse::<DocumentMut>()
            .map_err(|error| anyhow::anyhow!("config.toml TOML syntax error at {:?}", error.span()))
    }
}

fn normalize_text_toml(contents: String) -> String {
    let trimmed = contents.trim();
    if trimmed.is_empty() {
        String::new()
    } else {
        ensure_trailing_newline(trimmed.to_string())
    }
}

pub fn normalize_config_text(contents: &str) -> String {
    normalize_duplicate_toml_text(contents)
}

/// 把可能含重复表头/重复根键的文本，折叠成一份合法、去重的 TOML。
///
/// 历史实现是逐行文本去重：按表头整行字符串匹配，撞见第二次出现的 `[header]`
/// 就把该表体整段丢弃。这在语义上是错的——`[mcp_servers.node_repl]`（带正确的
/// `.env` 子表）和其后一个裸的 `[mcp_servers]`（空表头，来自历史脚本/手改残留）
/// 是两个不同的表头字符串，行级去重完全看不到它们其实是同一棵 TOML 树上的父子
/// 关系；反过来，若两次出现的是同一个表头但各自只写了部分字段，行级去重会把后一
/// 份连同它独有的字段整段丢弃，而不是把两份合并。真实故障（Codex `config.toml`
/// 反复复现 `invalid transport`）就是这条路径把裸 env 变量和 `.env` 子表的残留
/// 一起原样保留进了最终文件。
///
/// 改成按顶层表头切块 + 用已有的 `merge_toml_table_like` 做语义合并：每块单独
/// 解析成 `DocumentMut`（块内容本身必须是合法 TOML），后出现的块合并进先出现的
/// 同名表（标量后写覆盖前写，子表递归合并、不清空），根键重复时也是后写覆盖。
/// 任何一块解析失败就说明输入本身已经坏到不是逐块可解析的程度，退回历史的逐行
/// 丢弃策略，不让这次修复反而让原本能跑的输入报错。
fn normalize_duplicate_toml_text(contents: &str) -> String {
    match merge_duplicate_toml_blocks(contents) {
        Some(merged) => normalize_optional_toml(merged),
        None => normalize_duplicate_toml_text_line_fallback(contents),
    }
}

/// 按不带前导空白的 `[table]` / `[[array_table]]` 行、以及根级重复键，切成若干
/// 独立可解析的 TOML 片段，再逐块 parse 后语义合并。
///
/// 只按表头切块不够：`model = "a"\nmodel = "b"\n` 两行根键都落在同一个块里，
/// 直接喂给 `DocumentMut::parse` 会因为 TOML 语法本身不允许根级重复键而整体
/// 解析失败。所以还要在「当前块的根级部分已经出现过这个 key」时，先切出一个
/// 新块，让后一次赋值单独成块参与合并（合并语义是后写覆盖前写）。
fn merge_duplicate_toml_blocks(contents: &str) -> Option<DocumentMut> {
    let mut blocks: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut current_in_root = true;
    let mut current_root_keys: HashSet<String> = HashSet::new();
    // 当前块的表头路径。父表头与它的真子表必须留在同一块里一起解析：子表
    // 如果单独成块，toml_edit 会把父级数组表隐式降级成普通表，合并阶段整棵
    // 数组表被覆盖，外层表头随之不再打印。
    let mut current_header_path: Option<String> = None;
    // 当前块内已声明过的标准表（非数组表）路径。同一个块里重复声明同一个
    // 标准表会让整块 TOML 解析失败，随后整体退回逐行去重、丢掉后出现的字段。
    let mut current_declared_headers: HashSet<String> = HashSet::new();

    for line in contents.lines() {
        let trimmed = line.trim();
        let is_new_table_header = trimmed.starts_with('[') && trimmed.ends_with(']');

        if is_new_table_header {
            let header_path = toml_header_path_of_line(trimmed);
            let is_strict_child = match (current_header_path.as_deref(), header_path) {
                (Some(parent), Some(child)) => is_strict_toml_child_path(parent, child),
                _ => false,
            };
            let is_array_table = trimmed.starts_with("[[");
            // 同一块里重复声明同一个标准表会让整块解析失败（真实故障：两个
            // [mcp_servers.node_repl] 各写一部分键），随后整体退回逐行去重，
            // 把后出现的那段字段整段丢掉。数组表允许重复声明，不参与判定。
            let is_repeated_standard_table = match header_path {
                Some(path) if !is_array_table => current_declared_headers.contains(path),
                _ => false,
            };

            if !is_strict_child || is_repeated_standard_table {
                if !current.trim().is_empty() {
                    blocks.push(std::mem::take(&mut current));
                }
                current_in_root = false;
                current_root_keys.clear();
                current_declared_headers.clear();
                current_header_path = header_path.map(str::to_string);
            }
            if let Some(path) = header_path {
                if !is_array_table {
                    current_declared_headers.insert(path.to_string());
                }
            }
        } else if current_in_root && !trimmed.is_empty() && !trimmed.starts_with('#') {
            if let Some((key, _)) = trimmed.split_once('=') {
                let key = key.trim().to_string();
                if !key.is_empty() && !current_root_keys.insert(key) {
                    // 同一个根键在当前块里再次出现：先把当前块切出去，
                    // 让这一行作为新块的第一行，参与合并时以「后写」身份覆盖前值。
                    if !current.trim().is_empty() {
                        blocks.push(std::mem::take(&mut current));
                    }
                    current_root_keys.clear();
                }
            }
        }

        current.push_str(line);
        current.push('\n');
    }
    if !current.trim().is_empty() {
        blocks.push(current);
    }

    let mut merged = DocumentMut::new();
    for block in blocks {
        if let Ok(block_doc) = block.parse::<DocumentMut>() {
            merge_toml_table_like(merged.as_table_mut(), block_doc.as_table());
            continue;
        }
        // 单块解析失败时只降级这一块（块内逐行去重后再试），而不是让整体退回
        // 全局逐行去重，避免一处坏块把其它块里已经解析好的字段一起丢掉。
        let repaired = dedupe_duplicate_headers_within_block(&block);
        let block_doc: DocumentMut = repaired.parse().ok()?;
        merge_toml_table_like(merged.as_table_mut(), block_doc.as_table());
    }
    Some(merged)
}

/// 单块级别的降级：在这一个块内部按整行表头字符串去重，保留首次出现的表头
/// 及其表体，丢弃重复表头与它后面的表体。只在整块解析失败时对该块使用，
/// 不改变其它块已经解析好的结果。
fn dedupe_duplicate_headers_within_block(block: &str) -> String {
    let mut seen_headers = HashSet::new();
    let mut kept = Vec::new();
    let mut skipping_duplicate_table = false;
    for line in block.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            skipping_duplicate_table = !seen_headers.insert(trimmed.to_string());
            if skipping_duplicate_table {
                continue;
            }
            kept.push(line);
            continue;
        }
        if skipping_duplicate_table {
            continue;
        }
        kept.push(line);
    }
    kept.join("\n")
}

/// 取出表头行括号里的路径；不是表头行时返回 None。
fn toml_header_path_of_line(trimmed: &str) -> Option<&str> {
    let inner = if let Some(rest) = trimmed.strip_prefix("[[") {
        rest.strip_suffix("]]")?
    } else if let Some(rest) = trimmed.strip_prefix('[') {
        rest.strip_suffix(']')?
    } else {
        return None;
    };
    let path = inner.trim();
    if path.is_empty() { None } else { Some(path) }
}

/// 子表路径判定必须按点分段多出一级，而不是字符串前缀。
fn is_strict_toml_child_path(parent: &str, child: &str) -> bool {
    match child.strip_prefix(parent) {
        Some(rest) => rest.strip_prefix('.').is_some_and(|tail| !tail.is_empty()),
        None => false,
    }
}

/// 逐块合并失败时的保底路径：原历史实现，逐行文本去重（丢弃后出现的重复表头/
/// 根键），保证至少不比修复前更差。
fn normalize_duplicate_toml_text_line_fallback(contents: &str) -> String {
    let mut seen_root_keys = HashSet::new();
    let mut seen_headers = HashSet::new();
    let mut kept = Vec::new();
    let mut skipping_duplicate_table = false;
    let mut in_root = true;

    for line in contents.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            in_root = false;
            skipping_duplicate_table = !seen_headers.insert(trimmed.to_string());
            if skipping_duplicate_table {
                continue;
            }
            kept.push(line);
            continue;
        }

        if skipping_duplicate_table {
            continue;
        }

        if in_root && !trimmed.is_empty() && !trimmed.starts_with('#') {
            if let Some((key, _)) = trimmed.split_once('=') {
                let key = key.trim();
                if !key.is_empty() && !key.contains('.') && !seen_root_keys.insert(key.to_string())
                {
                    continue;
                }
            }
        }

        kept.push(line);
    }

    normalize_text_toml(kept.join("\n"))
}

/// Normal-user launches cannot complete the elevated native Windows sandbox
/// setup. Downgrade only that case; an elevated process keeps the user's mode.
pub fn ensure_windows_sandbox_usable_for_current_user(home: &Path) -> anyhow::Result<bool> {
    ensure_windows_sandbox_usable_with(home, windows_process_is_elevated())
}

fn ensure_windows_sandbox_usable_with(home: &Path, process_elevated: bool) -> anyhow::Result<bool> {
    if process_elevated {
        return Ok(false);
    }
    // elevated 只在「首次初始化」时需要管理员权限；初始化完成后普通进程也能用。
    // 过去不看初始化状态一律降级，已经完成初始化的用户每次经 Codex Pilot 启动都被改回
    // unelevated，反而触发 `CreateProcessSecurityEnvironment failed`（#2615）。
    if windows_elevated_sandbox_setup_present(home) {
        return Ok(false);
    }
    let config_path = home.join("config.toml");
    let existing = match std::fs::read_to_string(&config_path) {
        Ok(existing) => existing,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    let mut doc = parse_toml_document(&existing)?;
    let Some(windows) = doc.get_mut("windows").and_then(Item::as_table_mut) else {
        return Ok(false);
    };
    let elevated = windows
        .get("sandbox")
        .and_then(Item::as_str)
        .is_some_and(|value| value.eq_ignore_ascii_case("elevated"));
    if !elevated {
        return Ok(false);
    }
    windows["sandbox"] = toml_edit::value("unelevated");
    crate::settings::atomic_write(&config_path, normalize_optional_toml(doc).as_bytes())?;
    // 这是替用户改写了他的配置，留一条诊断记录，方便排障时回溯。
    let _ = crate::diagnostic_log::append_diagnostic_log(
        "launcher.windows_sandbox_downgraded",
        serde_json::json!({
            "home": home.to_string_lossy(),
            "from": "elevated",
            "to": "unelevated",
            "reason": "current process is not elevated; native sandbox setup would report updateRequired",
        }),
    );
    Ok(true)
}

/// Codex 的 Windows 沙箱初始化产物是否齐全：`.sandbox/setup_marker.json` 与
/// `.sandbox-secrets/sandbox_users.json` 都存在、都带 `version` 且两者一致
/// （与 Codex `sandbox_setup_is_complete` 的判据一致）。不写死 Codex 的
/// SETUP_VERSION：版本升级后由 Codex 自己提示重新初始化，这里不替用户改配置。
fn windows_elevated_sandbox_setup_present(home: &Path) -> bool {
    let version = |path: PathBuf| -> Option<u64> {
        let text = std::fs::read_to_string(path).ok()?;
        serde_json::from_str::<Value>(&text)
            .ok()?
            .get("version")?
            .as_u64()
    };
    match (
        version(home.join(".sandbox").join("setup_marker.json")),
        version(home.join(".sandbox-secrets").join("sandbox_users.json")),
    ) {
        (Some(marker), Some(users)) => marker == users,
        _ => false,
    }
}

#[cfg(windows)]
fn windows_process_is_elevated() -> bool {
    use windows::Win32::UI::Shell::IsUserAnAdmin;

    unsafe { IsUserAnAdmin().as_bool() }
}

#[cfg(not(windows))]
fn windows_process_is_elevated() -> bool {
    true
}

fn remove_unsupported_approval_policies(doc: &mut DocumentMut) -> bool {
    let mut changed = false;
    if doc.get("approval_policy").and_then(Item::as_str) == Some("untrusted") {
        doc.as_table_mut().remove("approval_policy");
        changed = true;
    }
    if let Some(profiles) = doc.get_mut("profiles").and_then(Item::as_table_mut) {
        for (_, profile) in profiles.iter_mut() {
            let Some(profile) = profile.as_table_mut() else {
                continue;
            };
            if profile.get("approval_policy").and_then(Item::as_str) == Some("untrusted") {
                profile.remove("approval_policy");
                changed = true;
            }
        }
    }
    changed
}

pub fn cleanup_unsupported_approval_policies_in_home(home: &Path) -> anyhow::Result<bool> {
    let config_path = home.join("config.toml");
    let existing = match std::fs::read_to_string(&config_path) {
        Ok(existing) => existing,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    let mut doc = parse_toml_document(&existing)?;
    if !remove_unsupported_approval_policies(&mut doc) {
        return Ok(false);
    }
    crate::settings::atomic_write(&config_path, normalize_optional_toml(doc).as_bytes())?;
    Ok(true)
}

fn merge_toml_item(target: &mut Item, source: &Item) {
    if let Some(source_table) = source.as_table_like() {
        if let Some(target_table) = target.as_table_like_mut() {
            merge_toml_table_like(target_table, source_table);
            return;
        }
    }

    *target = source.clone();
}

fn merge_toml_table_like(target: &mut dyn TableLike, source: &dyn TableLike) {
    for (key, source_item) in source.iter() {
        match target.get_mut(key) {
            Some(target_item) => merge_toml_item(target_item, source_item),
            None => {
                target.insert(key, source_item.clone());
            }
        }
    }
}

fn normalize_optional_toml(doc: DocumentMut) -> String {
    let contents = doc.to_string();
    if contents.trim().is_empty() {
        String::new()
    } else {
        ensure_trailing_newline(contents)
    }
}

pub fn relay_profile_model(profile: &CodexConnection) -> String {
    profile.model.clone()
}

pub fn relay_profile_base_url(profile: &CodexConnection) -> String {
    profile.base_url.clone()
}

pub fn relay_profile_api_key(profile: &CodexConnection) -> String {
    profile.api_key.clone()
}

fn ensure_trailing_newline(mut contents: String) -> String {
    if !contents.ends_with('\n') {
        contents.push('\n');
    }
    contents
}

pub fn root_key_string(contents: &str, key: &str) -> Option<String> {
    root_key_value(contents, key).map(unquote_toml_string)
}

fn root_key_value<'a>(contents: &'a str, key: &str) -> Option<&'a str> {
    for line in contents.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            return None;
        }
        if trimmed.starts_with('#') || trimmed.is_empty() {
            continue;
        }
        let Some((name, value)) = trimmed.split_once('=') else {
            continue;
        };
        if name.trim() == key {
            return Some(value);
        }
    }
    None
}

fn unquote_toml_string(value: &str) -> String {
    let value = value.trim();
    value
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
        .or_else(|| {
            value
                .strip_prefix('\'')
                .and_then(|value| value.strip_suffix('\''))
        })
        .unwrap_or(value)
        .to_string()
}
