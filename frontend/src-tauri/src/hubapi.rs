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

fn base(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

pub fn create_body(name: &str, port: u16, key: &str) -> Value {
    json!({ "name": name, "url": base(port), "key": key, "isLocal": true })
}

pub fn patch_body(port: u16, key: &str) -> Value {
    json!({ "url": base(port), "key": key, "isLocal": true })
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
pub async fn wait_healthy(port: u16, timeout: Duration) -> Result<(), String> {
    let client = reqwest::Client::new();
    let url = format!("{}/api/health", base(port));
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

/// Upserts this device's Machine registry entry so terminals/LSP resolve to
/// the local hub. The row id is persisted at <data_dir>/local-machine-id;
/// URL and key change every launch (ephemeral port + key), so an existing id
/// is PATCHed and a missing/stale id falls back to POST.
pub async fn upsert_local_machine(port: u16, key: &str, data_dir: &Path) -> Result<(), String> {
    let client = reqwest::Client::new();
    let id_path = data_dir.join(MACHINE_ID_FILE);

    if let Ok(saved) = std::fs::read_to_string(&id_path) {
        let id = saved.trim();
        if !id.is_empty() {
            let res = client
                .patch(format!("{}/api/machines/{id}", base(port)))
                .bearer_auth(key)
                .json(&patch_body(port, key))
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
        .post(format!("{}/api/machines", base(port)))
        .bearer_auth(key)
        .json(&create_body(&device_name(), port, key))
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
        let create = create_body("mac", 4321, "k");
        assert_eq!(create["name"], "mac");
        assert_eq!(create["url"], "http://127.0.0.1:4321");
        assert_eq!(create["key"], "k");
        assert_eq!(create["isLocal"], true);
        let patch = patch_body(4321, "k");
        assert_eq!(patch["url"], "http://127.0.0.1:4321");
        assert_eq!(patch["key"], "k");
        assert_eq!(patch["isLocal"], true);
        assert!(patch.get("name").is_none(), "PATCH must not rename the machine");
    }
}
