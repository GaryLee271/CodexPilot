//! 只读发现 Rspack 的预测和项目分区候选块；不执行源码、不解包或改写客户端。

use anyhow::{Context, ensure};
use serde_json::Value;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

pub(crate) fn discover_native_assets(
    settings: &crate::settings::BackendSettings,
) -> anyhow::Result<Vec<String>> {
    ensure!(
        settings.enhancements_enabled
            && (settings.codex_app_native_predictions
                || settings.codex_app_native_project_sections
                || settings.codex_app_native_fast_unlock),
        "原生模块增强未开启"
    );
    let app =
        crate::app_paths::resolve_codex_app_dir_with_saved(None, Some(&settings.codex_app_path))
            .context("未找到 Codex 客户端")?;
    let archive = [
        "Contents/Resources/app.asar",
        "resources/app.asar",
        "Resources/app.asar",
    ]
    .iter()
    .map(|relative| app.join(relative))
    .find(|path| path.is_file())
    .context("未找到 Codex 客户端资源")?;
    // 分区可独立开启；只读扫描按功能挑选候选，不再依赖预测开关带入同一个入口块。
    discover_archive(
        &archive,
        settings.codex_app_native_predictions,
        settings.codex_app_native_project_sections,
        settings.codex_app_native_fast_unlock,
    )
}

fn numeric_chunk(name: &str) -> bool {
    let Some((id, hash)) = name
        .strip_suffix(".js")
        .and_then(|name| name.split_once('.'))
    else {
        return false;
    };
    !id.is_empty()
        && id.bytes().all(|c| c.is_ascii_digit())
        && !hash.is_empty()
        && hash.len() <= 64
        && hash.bytes().all(|c| c.is_ascii_hexdigit())
}

fn native_candidate(source: &str, predictions: bool, sections: bool, fast: bool) -> bool {
    (predictions
        && (source.contains("requestUserMessagePrediction")
            || (source.contains("4290031608")
                && source.contains("cumberbatch-has-accepted-prediction-1"))
            || (source.contains("cumberbatch-availability")
                && source.contains("settings.general.messagePredictions.label"))))
        || (sections
            && source.contains("sidebar-custom-sections-v3")
            && source.contains("savedCustomSections")
            && source.contains("authenticatedAccountId"))
        // Fast 的四个门控在 Rspack 里分散到不同块，UI / 请求门控的模块还会被复制多份，
        // 所以按门控锚点宽松取候选；完整结构与副本完整性仍由注入脚本逐块校验。
        || (fast
            && (source.contains("serviceTierAccess:")
                || (source.contains("personalAccessToken") && source.contains("query.setData"))
                || (source.contains("readServiceTier") && source.contains("writeServiceTier"))
                || (source.contains("submissionOptions")
                    && source.contains("getHostId")
                    && source.contains("getAccount"))))
}

fn discover_archive(
    path: &Path,
    predictions: bool,
    sections: bool,
    fast: bool,
) -> anyhow::Result<Vec<String>> {
    let mut file = std::fs::File::open(path)?;
    let length = file.metadata()?.len();
    let mut prefix = [0u8; 16];
    file.read_exact(&mut prefix)?;
    let word = |offset| u32::from_le_bytes(prefix[offset..offset + 4].try_into().unwrap()) as u64;
    let header_size = word(4);
    let json_size = word(12);
    ensure!(
        word(0) == 4
            && json_size <= 16 * 1024 * 1024
            && json_size
                .checked_add(8)
                .is_some_and(|size| size <= header_size)
            && header_size
                .checked_add(8)
                .is_some_and(|size| size <= length),
        "原生资源索引无效"
    );
    let base = 8 + header_size;
    let mut header = vec![0; json_size as usize];
    file.read_exact(&mut header)?;
    let header: Value = serde_json::from_slice(&header)?;
    let chunks = header
        .pointer("/files/webview/files/assets/files/async/files")
        .and_then(Value::as_object)
        .context("原生资源不含 Rspack 模块")?;
    ensure!(chunks.len() <= 16_384, "原生资源索引过大");
    let mut urls = Vec::new();
    let mut scanned = 0u64;
    for (name, entry) in chunks {
        if !numeric_chunk(name) {
            continue;
        }
        ensure!(
            entry.get("unpacked") != Some(&Value::Bool(true)) && entry.get("link").is_none(),
            "原生资源块不在归档内"
        );
        let size = entry
            .get("size")
            .and_then(Value::as_u64)
            .context("原生资源块大小无效")?;
        ensure!(size <= 24 * 1024 * 1024, "原生资源块过大");
        scanned = scanned.checked_add(size).context("原生资源大小无效")?;
        ensure!(scanned <= 768 * 1024 * 1024, "原生资源总量过大");
        let offset = entry
            .get("offset")
            .and_then(Value::as_str)
            .and_then(|value| value.parse::<u64>().ok())
            .context("原生资源偏移无效")?;
        let start = base.checked_add(offset).context("原生资源偏移溢出")?;
        ensure!(
            start.checked_add(size).is_some_and(|end| end <= length),
            "原生资源越界"
        );
        file.seek(SeekFrom::Start(start))?;
        let mut source = vec![0; size as usize];
        file.read_exact(&mut source)?;
        if native_candidate(std::str::from_utf8(&source)?, predictions, sections, fast) {
            urls.push(format!("app://-/assets/async/{name}"));
            ensure!(urls.len() <= 32, "原生候选资源过多");
        }
    }
    ensure!(!urls.is_empty(), "未找到已启用的原生模块");
    Ok(urls)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Write;

    fn archive(entries: &[(&str, &str)]) -> tempfile::NamedTempFile {
        let mut offset = 0;
        let files = entries
            .iter()
            .map(|(name, source)| {
                let entry = json!({"size":source.len(),"offset":offset.to_string()});
                offset += source.len();
                (name.to_string(), entry)
            })
            .collect::<serde_json::Map<_, _>>();
        let header = serde_json::to_vec(
            &json!({"files":{"webview":{"files":{"assets":{"files":{"async":{"files":files}}}}}}}),
        )
        .unwrap();
        let padded = (header.len() + 3) & !3;
        let mut file = tempfile::NamedTempFile::new().unwrap();
        for word in [
            4,
            (8 + padded) as u32,
            (4 + padded) as u32,
            header.len() as u32,
        ] {
            file.write_all(&word.to_le_bytes()).unwrap();
        }
        file.write_all(&header).unwrap();
        file.write_all(&vec![0; padded - header.len()]).unwrap();
        for (_, source) in entries {
            file.write_all(source.as_bytes()).unwrap();
        }
        file
    }

    #[test]
    fn discovers_numeric_prediction_candidates_without_running_source() {
        let file = archive(&[
            (
                "11.abc123.js",
                "throw Error('must not run');requestUserMessagePrediction",
            ),
            (
                "22.def456.js",
                "4290031608 cumberbatch-has-accepted-prediction-1",
            ),
            (
                "33.123abc.js",
                "cumberbatch-availability settings.general.messagePredictions.label",
            ),
            ("44.456def.js", "export const unrelated = 1;"),
            ("../escape.js", "requestUserMessagePrediction"),
        ]);
        assert_eq!(
            discover_archive(file.path(), true, false, false).unwrap(),
            vec![
                "app://-/assets/async/11.abc123.js",
                "app://-/assets/async/22.def456.js",
                "app://-/assets/async/33.123abc.js",
            ]
        );
    }

    #[test]
    fn discovers_project_sections_when_predictions_are_disabled() {
        let file = archive(&[
            ("11.abc123.js", "requestUserMessagePrediction"),
            (
                "22.def456.js",
                "sidebar-custom-sections-v3 savedCustomSections authenticatedAccountId",
            ),
            ("33.123abc.js", "sidebar-custom-sections-v3"),
        ]);
        assert_eq!(
            discover_archive(file.path(), false, true, false).unwrap(),
            vec!["app://-/assets/async/22.def456.js"]
        );
        assert_eq!(discover_archive(file.path(), true, true, false).unwrap().len(), 2);
    }

    #[test]
    fn rejects_truncated_archive_and_invalid_header_lengths() {
        let file = archive(&[("11.abc123.js", "requestUserMessagePrediction")]);
        file.as_file()
            .set_len(file.as_file().metadata().unwrap().len() - 1)
            .unwrap();
        assert!(discover_archive(file.path(), true, false, false).is_err());
        let mut file = tempfile::NamedTempFile::new().unwrap();
        file.write_all(&[255; 16]).unwrap();
        assert!(discover_archive(file.path(), true, false, false).is_err());
    }

    #[test]
    fn discovers_split_fast_gates_and_every_duplicated_copy() {
        let file = archive(&[
            (
                "11.abc123.js",
                r#"let a={serviceTierAccess:x,isLoading:y};"#,
            ),
            (
                "22.def456.js",
                r#"if("chatgpt"!==n&&"personalAccessToken"!==n)return null;t.query.setData(s.b9,{authMethod:n,hostId:t},a)"#,
            ),
            (
                "33.123abc.js",
                r#"async readServiceTier(e){...},async writeServiceTier(e,t){...}"#,
            ),
            (
                "44.456def.js",
                r#"let d=u.submissionOptions,h=d?.executionHostId??e.getHostId();e.getAccount({priority:"critical"})"#,
            ),
            // 只是门控的消费方：锚点会把它带进来，但注入脚本按完整结构校验后不会改写它。
            ("55.789abc.js", r#"let{serviceTierAccess:oa}=(0,H.U)(e1)"#),
            ("66.abcdef.js", "export const unrelated = 1;"),
        ]);
        assert_eq!(
            discover_archive(file.path(), false, false, true).unwrap(),
            vec![
                "app://-/assets/async/11.abc123.js",
                "app://-/assets/async/22.def456.js",
                "app://-/assets/async/33.123abc.js",
                "app://-/assets/async/44.456def.js",
                "app://-/assets/async/55.789abc.js",
            ]
        );
        assert!(discover_archive(file.path(), true, true, false).is_err());
    }

    #[test]
    fn checks_installed_archive_when_requested() {
        // 可选只读实包验证；CI 不依赖用户机器上的客户端。
        let Some(path) = std::env::var_os("CODEX_NATIVE_PREDICTIONS_ASAR") else {
            return;
        };
        let urls = discover_archive(Path::new(&path), true, true, false).unwrap();
        assert!(urls.len() >= 4, "安装包应包含四类预测候选模块");
        let sections = discover_archive(Path::new(&path), false, true, false).unwrap();
        assert_eq!(sections.len(), 1, "仅开启分区时也应唯一发现分区模块");
        let fast = discover_archive(Path::new(&path), false, false, true).unwrap();
        assert!(fast.len() >= 8, "Fast 的四个门控分散在多块且存在副本");
        assert!(
            urls.iter()
                .all(|url| url.starts_with("app://-/assets/async/"))
        );
    }
}
