use anyhow::Context;

fn apply_configured_ca_certificate(
    mut builder: reqwest::ClientBuilder,
) -> anyhow::Result<reqwest::ClientBuilder> {
    let Some(value) = std::env::var_os("CODEX_CA_CERTIFICATE") else {
        return Ok(builder);
    };
    let value = value.to_string_lossy().trim().to_string();
    if value.is_empty() {
        return Ok(builder);
    }
    let pem = if value.contains("BEGIN CERTIFICATE") {
        value.into_bytes()
    } else {
        std::fs::read(&value)
            .with_context(|| format!("读取 CODEX_CA_CERTIFICATE 指定的证书文件失败：{value}"))?
    };
    let certificate =
        reqwest::Certificate::from_pem(&pem).context("CODEX_CA_CERTIFICATE 不是有效的 PEM 证书")?;
    builder = builder.add_root_certificate(certificate);
    Ok(builder)
}

/// 建 client 时实际用哪种代理。
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum ProxyChoice {
    /// 供应商设成直连：系统代理、PAC 和代理环境变量一律不用（#2760）。
    Direct,
    /// 显式代理（供应商设置 / 系统代理 / 代理环境变量）。
    Explicit(String),
    /// 都没有：交给 reqwest 默认的系统代理处理。
    Auto,
}

fn resolve_proxy_choice(proxy_override: Option<&str>, target_url: Option<&str>) -> ProxyChoice {
    if proxy_override.is_some_and(|value| value.trim().eq_ignore_ascii_case("direct")) {
        return ProxyChoice::Direct;
    }
    proxy_override
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        // 已知目标地址时按 URL 求值，Windows PAC / 自动检测代理才能生效（#1329）
        .or_else(|| match target_url {
            Some(url) => crate::proxy::detect_system_proxy_for_url(url),
            None => crate::proxy::detect_system_proxy(),
        })
        .or_else(|| std::env::var("HTTPS_PROXY").ok())
        .or_else(|| std::env::var("https_proxy").ok())
        .or_else(|| std::env::var("ALL_PROXY").ok())
        .or_else(|| std::env::var("all_proxy").ok())
        .map_or(ProxyChoice::Auto, ProxyChoice::Explicit)
}

/// 除 UA 与代理外的 client 构建参数。
#[derive(Default)]
struct ClientOptions {
    connect_timeout: Option<std::time::Duration>,
    total_timeout: Option<std::time::Duration>,
    redirect: Option<reqwest::redirect::Policy>,
    pool_idle_timeout: Option<std::time::Duration>,
}

fn build_client_with_proxy_choice(
    user_agent: &str,
    proxy: &ProxyChoice,
    options: ClientOptions,
) -> anyhow::Result<reqwest::Client> {
    let ua = if user_agent.trim().is_empty() {
        format!("CodexPilot/{}", env!("CARGO_PKG_VERSION"))
    } else {
        user_agent.trim().to_string()
    };
    let mut builder = reqwest::Client::builder().user_agent(ua);
    if let Some(timeout) = options.connect_timeout {
        builder = builder.connect_timeout(timeout);
    }
    if let Some(timeout) = options.total_timeout {
        builder = builder.timeout(timeout);
    }
    if let Some(policy) = options.redirect {
        builder = builder.redirect(policy);
    }
    if let Some(timeout) = options.pool_idle_timeout {
        builder = builder.pool_idle_timeout(timeout);
    }
    match proxy {
        ProxyChoice::Direct => builder = builder.no_proxy(),
        ProxyChoice::Explicit(proxy) => {
            // 显式代理会关掉 reqwest 自带的 NO_PROXY 处理，这里补回来；回环地址始终直连
            let no_proxy = reqwest::NoProxy::from_env()
                .or_else(|| reqwest::NoProxy::from_string("localhost,127.0.0.1,::1"));
            builder = builder.proxy(reqwest::Proxy::all(proxy.as_str())?.no_proxy(no_proxy));
        }
        ProxyChoice::Auto => {}
    }
    Ok(apply_configured_ca_certificate(builder)?.build()?)
}

fn build_proxied_client_with_timeouts(
    user_agent: &str,
    proxy_override: Option<&str>,
    target_url: Option<&str>,
    connect_timeout: Option<std::time::Duration>,
    total_timeout: Option<std::time::Duration>,
    redirect: Option<reqwest::redirect::Policy>,
) -> anyhow::Result<reqwest::Client> {
    build_client_with_proxy_choice(
        user_agent,
        &resolve_proxy_choice(proxy_override, target_url),
        ClientOptions {
            connect_timeout,
            total_timeout,
            redirect,
            pool_idle_timeout: None,
        },
    )
}

/// 转发上游用的 client 最多缓存几个（按 UA × 代理 × 环境区分，一般只有个位数）。
/// 缓存 client 里空闲连接最多留多久。比 reqwest 默认的 90 秒短：一轮对话里相邻请求
/// 通常只隔几秒，30 秒足够复用；空闲更久的连接可能已被中转 / NAT 悄悄断开，不再拿来用。

fn build_proxied_client(
    user_agent: &str,
    proxy_override: Option<&str>,
) -> anyhow::Result<reqwest::Client> {
    build_proxied_client_with_timeouts(user_agent, proxy_override, None, None, None, None)
}

/// 走系统代理 / 环境变量代理的 client，并显式指定连接与总超时。
/// 更新下载这类外部请求都应走这里（#1329）。
pub fn proxied_client_with_timeouts(
    user_agent: &str,
    connect_timeout: std::time::Duration,
    total_timeout: std::time::Duration,
) -> anyhow::Result<reqwest::Client> {
    build_proxied_client_with_timeouts(
        user_agent,
        None,
        None,
        Some(connect_timeout),
        Some(total_timeout),
        None,
    )
}

/// 同 `proxied_client_with_timeouts`，但按目标地址解析系统代理，
/// Windows 上配置了 PAC 脚本或「自动检测设置」时也能拿到实际代理。
/// 脚本市场、主题市场这类固定访问 GitHub raw 的请求走这里（#1329 / #1339）。
pub fn proxied_client_for_url_with_timeouts(
    user_agent: &str,
    target_url: &str,
    connect_timeout: std::time::Duration,
    total_timeout: std::time::Duration,
) -> anyhow::Result<reqwest::Client> {
    build_proxied_client_with_timeouts(
        user_agent,
        None,
        Some(target_url),
        Some(connect_timeout),
        Some(total_timeout),
        None,
    )
}

/// 同 `proxied_client_for_url_with_timeouts`，并指定重定向策略。
/// 用于需要自己限定跳转次数与协议的下载（例如 Agent 桌宠取图只允许 https）。
pub fn proxied_client_for_url_with_redirect(
    user_agent: &str,
    target_url: &str,
    connect_timeout: std::time::Duration,
    total_timeout: std::time::Duration,
    redirect: reqwest::redirect::Policy,
) -> anyhow::Result<reqwest::Client> {
    build_proxied_client_with_timeouts(
        user_agent,
        None,
        Some(target_url),
        Some(connect_timeout),
        Some(total_timeout),
        Some(redirect),
    )
}

pub fn proxied_client(user_agent: &str) -> anyhow::Result<reqwest::Client> {
    build_proxied_client(user_agent, None)
}

/// VLM 专用 HTTP client（带超时）。
/// 不复用通用 proxied_client，避免 VLM 服务无响应时永久阻塞整个代理。
pub fn vlm_http_client() -> anyhow::Result<reqwest::Client> {
    vlm_http_client_with_timeout(
        std::time::Duration::from_secs(5),
        std::time::Duration::from_secs(30),
    )
}

pub(crate) fn vlm_http_client_with_timeout(
    connect: std::time::Duration,
    total: std::time::Duration,
) -> anyhow::Result<reqwest::Client> {
    Ok(apply_configured_ca_certificate(
        reqwest::Client::builder()
            .user_agent(format!("CodexPilot-VLM/{}", env!("CARGO_PKG_VERSION")))
            .connect_timeout(connect)
            .timeout(total),
    )?
    .build()?)
}
