use std::path::{Path, PathBuf};

/// Find active Codex debug ports for the bundled extension backend bridge.
pub(crate) fn debug_ports(state_dir: &Path) -> Vec<u16> {
    let mut ports = Vec::new();
    let mut push = |port: Option<u16>| {
        if let Some(port) = port.filter(|port| *port > 0) {
            if !ports.contains(&port) {
                ports.push(port);
            }
        }
    };
    let latest = |path: PathBuf| {
        codex_plus_core::status::StatusStore::new(path)
            .load_latest()
            .ok()
            .flatten()
            .and_then(|status| status.debug_port)
    };
    push(latest(state_dir.join("latest-status.json")));
    if let Some(base) = directories::BaseDirs::new() {
        push(latest(
            base.home_dir()
                .join(".codex-session-delete/latest-status.json"),
        ));
    }
    push(Some(9229));
    ports
}
