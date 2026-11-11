//! Codex 原生 API 端点拼接。

pub fn responses_url(base_url: &str) -> String {
    let skip_version_prefix = base_url.trim().ends_with('#');
    let base = base_url.trim().trim_end_matches('#').trim_end_matches('/');
    if base.to_ascii_lowercase().ends_with("/responses") {
        return base.to_string();
    }
    let origin_only = base
        .split_once("://")
        .map_or(!base.contains('/'), |(_, rest)| !rest.contains('/'));
    let mut url = if skip_version_prefix || has_version_suffix(base) || !origin_only {
        format!("{base}/responses")
    } else {
        format!("{base}/v1/responses")
    };
    while url.contains("/v1/v1") {
        url = url.replace("/v1/v1", "/v1");
    }
    url
}

pub fn audio_transcriptions_url(base_url: &str) -> String {
    let skip_version_prefix = base_url.trim().ends_with('#');
    let base = base_url.trim().trim_end_matches('#').trim_end_matches('/');
    if base.to_ascii_lowercase().ends_with("/audio/transcriptions") {
        return base.to_string();
    }
    let origin_only = base
        .split_once("://")
        .map_or(!base.contains('/'), |(_, rest)| !rest.contains('/'));
    let mut url = if skip_version_prefix || has_version_suffix(base) || !origin_only {
        format!("{base}/audio/transcriptions")
    } else {
        format!("{base}/v1/audio/transcriptions")
    };
    while url.contains("/v1/v1") {
        url = url.replace("/v1/v1", "/v1");
    }
    url
}

pub fn models_url(base_url: &str) -> String {
    let skip_version_prefix = base_url.trim().ends_with('#');
    let mut base = base_url
        .trim()
        .trim_end_matches('#')
        .trim_end_matches('/')
        .to_string();
    if base.to_ascii_lowercase().ends_with("/chat/completions") {
        base.truncate(base.len() - "/chat/completions".len());
    }
    if base.to_ascii_lowercase().ends_with("/models") {
        return base;
    }
    let origin_only = base
        .split_once("://")
        .map_or(!base.contains('/'), |(_, rest)| !rest.contains('/'));
    let mut url = if skip_version_prefix || has_version_suffix(&base) || !origin_only {
        format!("{base}/models")
    } else {
        format!("{base}/v1/models")
    };
    while url.contains("/v1/v1") {
        url = url.replace("/v1/v1", "/v1");
    }
    url
}

pub(crate) fn has_version_suffix(base_url: &str) -> bool {
    let segment = base_url.rsplit('/').next().unwrap_or(base_url);
    let Some(rest) = segment.strip_prefix('v') else {
        return false;
    };
    rest.chars().next().is_some_and(|ch| ch.is_ascii_digit())
}
