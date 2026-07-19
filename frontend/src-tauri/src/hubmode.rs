//! Persisted first-run choice: run the bundled sidecar locally, or connect
//! to a hub the operator already hosts elsewhere. See
//! docs/superpowers/specs/2026-07-14-hub-runtime-dual-role-and-polling-design.md.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const MODE_FILE: &str = "hub-mode.json";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "lowercase")]
pub enum HubMode {
    Local,
    Remote { url: String, key: String },
}

fn mode_path(data_dir: &Path) -> PathBuf {
    data_dir.join(MODE_FILE)
}

/// Reads the saved choice, if any. None means first run (or a corrupt/
/// missing file, treated the same as first run rather than a fatal error).
pub fn load(data_dir: &Path) -> Option<HubMode> {
    let contents = std::fs::read_to_string(mode_path(data_dir)).ok()?;
    serde_json::from_str(&contents).ok()
}

pub fn save(data_dir: &Path, mode: &HubMode) -> std::io::Result<()> {
    let json = serde_json::to_string(mode).expect("HubMode always serializes");
    std::fs::write(mode_path(data_dir), json)
}

/// Removes the saved choice so the next launch shows the choice screen
/// again. Missing file is not an error (nothing to clear).
pub fn clear(data_dir: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(mode_path(data_dir)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(suffix: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("devdeck-hubmode-test-{}-{suffix}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn load_returns_none_when_no_file() {
        let dir = temp_dir("none");
        assert_eq!(load(&dir), None);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn save_then_load_roundtrips_local() {
        let dir = temp_dir("local");
        save(&dir, &HubMode::Local).unwrap();
        assert_eq!(load(&dir), Some(HubMode::Local));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn save_then_load_roundtrips_remote() {
        let dir = temp_dir("remote");
        let mode = HubMode::Remote {
            url: "https://hub.tail-xxxx.ts.net".into(),
            key: "hubkey123".into(),
        };
        save(&dir, &mode).unwrap();
        assert_eq!(load(&dir), Some(mode));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn clear_removes_saved_mode_and_is_idempotent() {
        let dir = temp_dir("clear");
        save(&dir, &HubMode::Local).unwrap();
        clear(&dir).unwrap();
        assert_eq!(load(&dir), None);
        clear(&dir).unwrap(); // missing file: still Ok
        std::fs::remove_dir_all(&dir).ok();
    }
}
