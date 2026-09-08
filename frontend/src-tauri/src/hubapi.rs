//! Minimal REST client for the sidecar hub: health wait + machine upsert.

use std::path::Path;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{json, Value};

const MACHINE_ID_FILE: &str = "local-machine-id";

#[derive(Deserialize)]
struct MachineResp {
    id: String,
}

/// Base URL the desktop shell uses to reach its own hub.
///
/// `host` is the address that hub is actually reachable at — loopback for a
/// loopback or all-interfaces bind, and the bound address itself when the
/// operator has pinned the hub to one specific interface, which leaves
/// 127.0.0.1 with nothing listening on it. See `reachable_host` in lib.rs.
fn base(host: &str, port: u16) -> String {
    format!("http://{host}:{port}")
}

pub fn create_body(name: &str, host: &str, port: u16, key: &str) -> Value {
    json!({ "name": name, "url": base(host, port), "key": key, "isLocal": true })
}

pub fn patch_body(host: &str, port: u16, key: &str) -> Value {
    json!({ "url": base(host, port), "key": key, "isLocal": true })
}

/// Hostname as the machine display name; falls back to a constant.
pub fn device_name() -> String {
    std::process::Command::new("hostname")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "This device".to_string())
}

/// Polls GET /api/health (public route) until 200 or the deadline passes.
pub async fn wait_healthy(host: &str, port: u16, timeout: Duration) -> Result<(), String> {
    let client = reqwest::Client::new();
    let url = format!("{}/api/health", base(host, port));
    let deadline = Instant::now() + timeout;
    loop {
        match client
            .get(&url)
            .timeout(Duration::from_secs(2))
            .send()
            .await
        {
            Ok(res) if res.status().is_success() => return Ok(()),
            _ if Instant::now() >= deadline => {
                return Err(format!(
                    "devdeck-server did not become healthy within {}s",
                    timeout.as_secs()
                ))
            }
            _ => tokio::time::sleep(Duration::from_millis(250)).await,
        }
    }
}

/// Confirms the server answering at `host:port` is the child this shell just
/// spawned, and not some other DevDeck that happens to hold the port.
///
/// `/api/health` cannot answer this — it is public, so a stranger's hub passes
/// it just as happily. This sends the child's own per-launch key at an
/// authenticated route instead: only our child was started with that key, so a
/// 401 is positive proof we are talking to someone else.
///
/// Worth a dedicated check rather than letting `upsert_local_machine` fail,
/// because that failure surfaced as "create local machine: 401 Unauthorized"
/// — which reads as a broken credential, sending you looking at auth code
/// rather than at the two servers sharing a port. See `port_has_a_server` in
/// sidecar.rs for how they come to share one.
pub async fn verify_own_hub(host: &str, port: u16, key: &str) -> Result<(), String> {
    let res = reqwest::Client::new()
        .get(format!("{}/api/machines", base(host, port)))
        .bearer_auth(key)
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .map_err(|e| format!("verify hub identity: {e}"))?;
    if res.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err(format!(
            "port {port} is already served by another DevDeck hub (it rejected this launch's key). \
             Quit the other DevDeck — or the `make dev` hub — and start this one again."
        ));
    }
    Ok(())
}

/// Upserts this device's Machine registry entry so terminals/LSP resolve to
/// the local hub. The row id is persisted at <data_dir>/local-machine-id;
/// URL and key change every launch (ephemeral port + key), so an existing id
/// is PATCHed and a missing/stale id falls back to POST.
pub async fn upsert_local_machine(
    host: &str,
    port: u16,
    key: &str,
    data_dir: &Path,
) -> Result<(), String> {
    let client = reqwest::Client::new();
    let id_path = data_dir.join(MACHINE_ID_FILE);

    if let Ok(saved) = std::fs::read_to_string(&id_path) {
        let id = saved.trim();
        if !id.is_empty() {
            let res = client
                .patch(format!("{}/api/machines/{id}", base(host, port)))
                .bearer_auth(key)
                .json(&patch_body(host, port, key))
                .send()
                .await;
            if let Ok(res) = res {
                if res.status().is_success() {
                    return Ok(());
                }
            }
            // Stale id (e.g. machine row deleted): fall through and recreate.
        }
    }

    let created: MachineResp = client
        .post(format!("{}/api/machines", base(host, port)))
        .bearer_auth(key)
        .json(&create_body(&device_name(), host, port, key))
        .send()
        .await
        .map_err(|e| format!("create local machine: {e}"))?
        .error_for_status()
        .map_err(|e| format!("create local machine: {e}"))?
        .json()
        .await
        .map_err(|e| format!("parse machine response: {e}"))?;

    std::fs::write(&id_path, &created.id).map_err(|e| format!("save machine id: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_name_is_never_empty() {
        assert!(!device_name().trim().is_empty());
    }

    #[test]
    fn machine_bodies_have_the_contract_fields() {
        let create = create_body("mac", "127.0.0.1", 4321, "k");
        assert_eq!(create["name"], "mac");
        assert_eq!(create["url"], "http://127.0.0.1:4321");
        assert_eq!(create["key"], "k");
        assert_eq!(create["isLocal"], true);
        let patch = patch_body("127.0.0.1", 4321, "k");
        assert_eq!(patch["url"], "http://127.0.0.1:4321");
        assert_eq!(patch["key"], "k");
        assert_eq!(patch["isLocal"], true);
        assert!(patch.get("name").is_none(), "PATCH must not rename the machine");
    }

    /// A hub pinned to one interface has nothing listening on loopback, so
    /// the machine row must carry the address it is actually reachable at.
    #[test]
    fn machine_bodies_follow_a_pinned_bind_host() {
        let create = create_body("mac", "192.168.1.24", 8989, "k");
        assert_eq!(create["url"], "http://192.168.1.24:8989");
        let patch = patch_body("192.168.1.24", 8989, "k");
        assert_eq!(patch["url"], "http://192.168.1.24:8989");
    }
}
