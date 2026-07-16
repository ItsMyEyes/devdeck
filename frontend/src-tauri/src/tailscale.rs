//! Derives this device's Tailscale-reachable public URL for runtime
//! self-registration: `tailscale status --self --json` -> `.Self.DNSName`
//! -> `https://<dnsname>` (trailing dot stripped, no port -- matches
//! `--enable-tailscale-serve`, which fronts the app on the tailnet's
//! implicit port 443). See
//! docs/superpowers/specs/2026-07-16-desktop-remote-runtime-self-registration-design.md.

use serde::Deserialize;

#[derive(Deserialize)]
struct StatusSelf {
    #[serde(rename = "DNSName")]
    dns_name: String,
}

#[derive(Deserialize)]
struct Status {
    #[serde(rename = "Self")]
    self_: StatusSelf,
}

/// Parses `tailscale status --self --json` output into a public URL.
fn parse_dns_name(json: &[u8]) -> Result<String, String> {
    let status: Status =
        serde_json::from_slice(json).map_err(|e| format!("parse tailscale status: {e}"))?;
    let dns = status.self_.dns_name.trim_end_matches('.');
    if dns.is_empty() {
        return Err("tailscale status: empty DNSName".into());
    }
    Ok(format!("https://{dns}"))
}

/// Runs `tailscale status --self --json` and derives this device's
/// tailnet-reachable public URL. Fails if the `tailscale` binary is
/// missing, the command errors, or the node isn't logged in (no DNSName).
pub async fn public_url() -> Result<String, String> {
    let output = tokio::process::Command::new("tailscale")
        .args(["status", "--self", "--json"])
        .output()
        .await
        .map_err(|e| format!("run tailscale status: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "tailscale status exited with {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    parse_dns_name(&output.stdout)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_dns_name_and_strips_trailing_dot() {
        let json = br#"{"Self":{"DNSName":"my-mac.tail1234.ts.net."}}"#;
        assert_eq!(
            parse_dns_name(json),
            Ok("https://my-mac.tail1234.ts.net".to_string())
        );
    }

    #[test]
    fn rejects_missing_self_field() {
        let json = br#"{"Peer":{}}"#;
        assert!(parse_dns_name(json).is_err());
    }

    #[test]
    fn rejects_empty_dns_name() {
        let json = br#"{"Self":{"DNSName":""}}"#;
        assert!(parse_dns_name(json).is_err());
    }
}
