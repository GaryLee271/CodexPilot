use codex_plus_core::status::LaunchStatus;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct ServiceState {
    pub status: &'static str,
    pub address: Option<String>,
    pub message: &'static str,
}

#[derive(Debug, Clone, Serialize)]
pub struct RuntimeHealth {
    pub codex_app: ServiceState,
    pub debugger: ServiceState,
}

impl RuntimeHealth {
    pub fn unavailable() -> Self {
        let state = ServiceState {
            status: "not_checked",
            address: None,
            message: "等待状态检查",
        };
        Self {
            codex_app: state.clone(),
            debugger: state,
        }
    }
}

/// 仅检查 Codex 进程与 CDP 端点；增强不再启动或探测本地 HTTP 服务。
pub fn inspect(latest: Option<&LaunchStatus>) -> RuntimeHealth {
    inspect_with(
        latest,
        !codex_plus_core::watcher::find_codex_processes().is_empty(),
        codex_plus_core::cdp::endpoint_available,
    )
}

fn inspect_with(
    latest: Option<&LaunchStatus>,
    codex_running: bool,
    debugger_check: impl Fn(u16) -> bool,
) -> RuntimeHealth {
    let debug_port = latest.and_then(|s| s.debug_port).unwrap_or(9229);
    let debugger_ok = debugger_check(debug_port);
    RuntimeHealth {
        codex_app: ServiceState {
            status: if codex_running { "running" } else { "stopped" },
            address: None,
            message: if codex_running {
                "Codex APP 正在运行"
            } else {
                "Codex APP 未运行"
            },
        },
        debugger: ServiceState {
            status: if debugger_ok {
                "connected"
            } else {
                "disconnected"
            },
            address: Some(format!("http://127.0.0.1:{debug_port}")),
            message: if debugger_ok {
                "Codex 调试端点已连接"
            } else {
                "Codex 调试端点未连接"
            },
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persisted_running_status_does_not_make_an_unreachable_debugger_healthy() {
        let old = LaunchStatus {
            status: "running".into(),
            debug_port: Some(9333),
            ..LaunchStatus::default()
        };
        let health = inspect_with(Some(&old), false, |port| {
            assert_eq!(port, 9333);
            false
        });
        assert_eq!(health.codex_app.status, "stopped");
        assert_eq!(health.debugger.status, "disconnected");
    }

    #[test]
    fn app_running_is_independent_from_the_debugger_connection() {
        let running = inspect_with(None, true, |_| false);
        assert_eq!(running.codex_app.status, "running");
        assert_eq!(running.debugger.status, "disconnected");
        let stopped = inspect_with(None, false, |_| false);
        assert_eq!(stopped.codex_app.status, "stopped");
    }

    #[test]
    fn connected_debugger_needs_no_http_helper_status() {
        let health = inspect_with(None, true, |port| {
            assert_eq!(port, 9229);
            true
        });
        assert_eq!(health.debugger.status, "connected");
        let payload = serde_json::to_value(health).unwrap();
        assert!(payload.get("local_server").is_none());
    }
}
