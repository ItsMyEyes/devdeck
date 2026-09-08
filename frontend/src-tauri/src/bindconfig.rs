//! Persisted bind-address choice for this device's sidecars.
//!
//! The desktop shell used to hard-code `127.0.0.1` for both the local hub and
//! the background remote-mode runtime, so a hub could only ever be reached
//! from the machine hosting it — the Tailscale path was the single supported
//! way to expose it, and when that path failed there was nothing else to try.
//! This module stores an operator-chosen bind host so the same sidecars can
//! listen on all interfaces (or one specific address) instead.
//!
//! Stored separately from `hub-mode.json` on purpose: hub mode is a first-run
//! decision that gates which code path runs at all, while this is a setting
//! adjusted later from Settings › Network, and clearing one must not clear
//! the other.

use std::net::{IpAddr, Ipv4Addr, UdpSocket};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const BIND_FILE: &str = "bind.json";

/// Loopback — the default, and the only host reachable solely from this
/// machine.
pub const LOOPBACK: &str = "127.0.0.1";
/// Every interface. What an operator wants when reaching the hub from another
/// device on the same network.
pub const ALL_INTERFACES: &str = "0.0.0.0";

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredBind {
    host: String,
}

/// One dialable IPv4 address on this device, for the Settings picker.
#[derive(Debug, Clone, Serialize)]
pub struct Interface {
    pub name: String,
    pub ip: String,
}

fn bind_path(data_dir: &Path) -> PathBuf {
    data_dir.join(BIND_FILE)
}

/// Rejects anything that isn't a bare IP address. Hostnames are refused
/// rather than resolved: this string is passed straight to the Go server's
/// `--addr`, where a name that resolves to an address this machine does not
/// hold is a fatal bind error and takes the sidecar's respawn loop with it.
pub fn validate(host: &str) -> Result<(), String> {
    if host.trim().is_empty() {
        return Err("bind address is required".into());
    }
    match host.parse::<IpAddr>() {
        Ok(_) => Ok(()),
        Err(_) => Err(format!(
            "{host:?} is not an IP address — use 127.0.0.1, 0.0.0.0, or one of this device's addresses"
        )),
    }
}

/// True for any loopback address, so callers can treat 127.0.0.1 and ::1
/// alike when deciding whether a bind is exposed off-device.
pub fn is_loopback(host: &str) -> bool {
    host.parse::<IpAddr>().map(|ip| ip.is_loopback()).unwrap_or(false)
}

/// Reads the saved bind host. A missing, unreadable, corrupt, or invalid file
/// reads as LOOPBACK — the safe default, since the alternative on a bad parse
/// would be silently exposing a hub the operator never asked to expose.
pub fn load(data_dir: &Path) -> String {
    let Ok(contents) = std::fs::read_to_string(bind_path(data_dir)) else {
        return LOOPBACK.to_string();
    };
    let Ok(stored) = serde_json::from_str::<StoredBind>(&contents) else {
        return LOOPBACK.to_string();
    };
    if validate(&stored.host).is_err() {
        return LOOPBACK.to_string();
    }
    stored.host
}

pub fn save(data_dir: &Path, host: &str) -> Result<(), String> {
    validate(host)?;
    let json = serde_json::to_string(&StoredBind { host: host.to_string() })
        .expect("StoredBind always serializes");
    std::fs::write(bind_path(data_dir), json).map_err(|e| format!("save bind config: {e}"))
}

/// This device's up, non-loopback IPv4 addresses.
///
/// IPv4-only and link-local-free by design: these are offered as things to
/// bind to and then to hand another person as a URL, and neither a v6
/// link-local (which needs a zone index to dial) nor a 169.254 autoconf
/// address survives that trip.
/// The address the OS would actually source outbound traffic from — the one a
/// peer on the network reaches this machine on.
///
/// UDP "connect" is a pure routing-table lookup: it is connectionless, so no
/// packet is sent and the destination need not exist or be reachable. Mirrors
/// `outboundIP` in backend/cmd/server/advertise.go.
fn primary_ip() -> Option<Ipv4Addr> {
    let sock = UdpSocket::bind(("0.0.0.0", 0)).ok()?;
    sock.connect(("8.8.8.8", 80)).ok()?;
    match sock.local_addr().ok()?.ip() {
        IpAddr::V4(v4) if !v4.is_loopback() && !v4.is_unspecified() => Some(v4),
        _ => None,
    }
}

/// This device's up, non-loopback IPv4 addresses, the routable one first.
///
/// IPv4-only and link-local-free by design: these are offered as things to
/// bind to and then to hand another person as a URL, and neither a v6
/// link-local (which needs a zone index to dial) nor a 169.254 autoconf
/// address survives that trip.
///
/// Ordered by the routing table rather than by address, because callers take
/// the FIRST entry as "the address to show". A plain sort ranks these as text,
/// so a machine with VM bridges and container networks (10.211.55.2 from
/// Parallels, 10.88.67.54 from a container runtime) surfaced a virtual adapter
/// nobody can reach ahead of the real LAN address — "10.211…" sorts before
/// "10.28…" one character at a time.
pub fn interfaces() -> Vec<Interface> {
    let Ok(addrs) = if_addrs::get_if_addrs() else {
        return Vec::new();
    };
    let mut out: Vec<Interface> = addrs
        .into_iter()
        .filter(|a| !a.is_loopback())
        .filter_map(|a| match a.addr.ip() {
            IpAddr::V4(v4) if !v4.is_link_local() && !v4.is_unspecified() => Some(Interface {
                name: a.name,
                ip: v4.to_string(),
            }),
            _ => None,
        })
        .collect();
    out.sort_by(|a, b| a.ip.cmp(&b.ip));
    out.dedup_by(|a, b| a.ip == b.ip);
    if let Some(primary) = primary_ip().map(|ip| ip.to_string()) {
        if let Some(at) = out.iter().position(|i| i.ip == primary) {
            let real = out.remove(at);
            out.insert(0, real);
        }
    }
    out
}

/// The address to actually show an operator for a given bind host: a specific
/// host is already the answer, while ALL_INTERFACES has to be resolved to a
/// concrete interface before it can be typed into another device's browser.
/// None when nothing routable exists (loopback bind, or an offline machine).
pub fn display_host(host: &str) -> Option<String> {
    if is_loopback(host) {
        return None;
    }
    match host.parse::<IpAddr>() {
        Ok(ip) if !ip.is_unspecified() => Some(host.to_string()),
        _ => interfaces().first().map(|i| i.ip.clone()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(suffix: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("devdeck-bindconfig-test-{}-{suffix}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn load_defaults_to_loopback_when_no_file() {
        let dir = temp_dir("none");
        assert_eq!(load(&dir), LOOPBACK);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn save_then_load_roundtrips() {
        let dir = temp_dir("roundtrip");
        save(&dir, ALL_INTERFACES).unwrap();
        assert_eq!(load(&dir), ALL_INTERFACES);
        save(&dir, "192.168.1.24").unwrap();
        assert_eq!(load(&dir), "192.168.1.24");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A corrupt file must not expose the hub — it reads as loopback, the
    /// same as no file at all.
    #[test]
    fn load_falls_back_to_loopback_on_corrupt_file() {
        let dir = temp_dir("corrupt");
        std::fs::write(bind_path(&dir), "{not json").unwrap();
        assert_eq!(load(&dir), LOOPBACK);
        std::fs::write(bind_path(&dir), r#"{"host":"not-an-ip"}"#).unwrap();
        assert_eq!(load(&dir), LOOPBACK);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn validate_rejects_hostnames_and_blanks() {
        assert!(validate("127.0.0.1").is_ok());
        assert!(validate("0.0.0.0").is_ok());
        assert!(validate("192.168.1.24").is_ok());
        assert!(validate("::").is_ok());
        assert!(validate("").is_err());
        assert!(validate("   ").is_err());
        // A hostname would be a fatal --addr for the Go side.
        assert!(validate("localhost").is_err());
        assert!(validate("my-mac.tail1234.ts.net").is_err());
    }

    #[test]
    fn save_refuses_an_invalid_host() {
        let dir = temp_dir("invalid");
        assert!(save(&dir, "localhost").is_err());
        assert!(!bind_path(&dir).exists(), "nothing should be written");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn is_loopback_covers_v4_and_v6() {
        assert!(is_loopback("127.0.0.1"));
        assert!(is_loopback("127.0.0.53"));
        assert!(is_loopback("::1"));
        assert!(!is_loopback("0.0.0.0"));
        assert!(!is_loopback("192.168.1.24"));
    }

    #[test]
    fn display_host_is_none_for_loopback_and_itself_for_a_specific_ip() {
        assert_eq!(display_host("127.0.0.1"), None);
        assert_eq!(display_host("192.168.1.24"), Some("192.168.1.24".to_string()));
    }

    #[test]
    fn interfaces_never_include_loopback_or_link_local() {
        for iface in interfaces() {
            let ip: std::net::Ipv4Addr = iface.ip.parse().expect("interfaces() emits IPv4 only");
            assert!(!ip.is_loopback(), "{ip} is loopback");
            assert!(!ip.is_link_local(), "{ip} is link-local");
            assert!(!ip.is_unspecified(), "{ip} is unspecified");
        }
    }

    /// The regression: callers show `interfaces()[0]` as "the address to
    /// reach this hub at", and a text sort put a Parallels/container adapter
    /// there instead of the routable LAN address.
    #[test]
    fn interfaces_lead_with_the_routable_address() {
        let list = interfaces();
        let Some(primary) = primary_ip() else {
            return; // offline runner: nothing routable to rank first
        };
        let primary = primary.to_string();
        if list.iter().any(|i| i.ip == primary) {
            assert_eq!(
                list[0].ip, primary,
                "the routing table's own address must lead, got {:?}",
                list.iter().map(|i| &i.ip).collect::<Vec<_>>()
            );
        }
    }

    /// display_host feeds the same "reach it here" string, so it must agree
    /// with the ordering above rather than re-deriving its own answer.
    #[test]
    fn display_host_for_all_interfaces_is_the_routable_address() {
        if let (Some(primary), false) = (primary_ip(), interfaces().is_empty()) {
            assert_eq!(display_host(ALL_INTERFACES), Some(primary.to_string()));
        }
    }
}
