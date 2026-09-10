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

/// Extra well-known Tailscale CLI locations beyond $PATH — notably the
/// official macOS Tailscale.app, which (unlike a Homebrew install) does not
/// symlink a `tailscale` shim onto PATH unless the operator explicitly runs
/// its "Install Tailscale command line tool" menu action. Mirrors
/// backend/internal/detect/detect.go's ResolveTailscale.
fn fallback_paths() -> &'static [&'static str] {
    if cfg!(target_os = "macos") {
        &[
            "/opt/homebrew/bin/tailscale",
            "/usr/local/bin/tailscale",
            "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        ]
    } else {
        &["/usr/local/bin/tailscale", "/usr/bin/tailscale"]
    }
}

/// True if `bin` is a file in any directory listed in `path_var` (a
/// PATH-style, platform-separator-joined string). Takes PATH as a parameter
/// rather than reading the environment directly so it's deterministically
/// testable.
fn is_on_path(bin: &str, path_var: &str) -> bool {
    std::env::split_paths(path_var).any(|dir| dir.join(bin).is_file())
}

/// Resolves the tailscale CLI: $PATH first (the common case, e.g. a
/// Homebrew install picked up via the user's shell profile), then
/// fallback_paths() in order. A GUI-launched process (this desktop app)
/// often inherits a PATH too small to find a CLI a terminal shell would —
/// falls back to the bare name, unchanged from before, when nothing
/// resolves, so the caller's exec still surfaces the real "not found" error.
fn resolve_binary() -> String {
    let on_path = std::env::var_os("PATH")
        .and_then(|p| p.into_string().ok())
        .is_some_and(|p| is_on_path("tailscale", &p));
    if on_path {
        return "tailscale".to_string();
    }
    for p in fallback_paths() {
        if std::path::Path::new(p).is_file() {
            return p.to_string();
        }
    }
    "tailscale".to_string()
}

/// Builds `tailscale status --self --json` so the CLI answers as a CLI.
///
/// The macOS Tailscale.app ships its GUI binary AS the CLI (the
/// fallback_paths() entry above), and that binary decides whether it was run
/// from a terminal or opened as an app by looking for SHLVL — the variable
/// every shell sets, and the only marker it has. This process is launched by
/// LaunchServices and has none, so the CLI concludes it was double-clicked,
/// tries to start the GUI, and reports the failure by printing
/// "The Tailscale GUI failed to start: ... (Tailscale.CLIError error 3.)" to
/// STDOUT while exiting 0 — so public_url()'s success check passes and
/// parse_dns_name then fails on a node that is perfectly signed in. The
/// preflight this feeds decides whether the sidecar gets
/// `--enable-tailscale-serve` at all, so without SHLVL the installed app can
/// never expose itself on the tailnet, while `tauri dev` (spawned via `sh -c`,
/// which sets SHLVL) always could. Mirrors
/// backend/internal/detect/detect.go's TailscaleCommand, whose doc comment
/// carries the full chain.
fn status_command(bin: &str) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(bin);
    cmd.args(["status", "--self", "--json"]);
    // Value is irrelevant — the CLI only tests for a non-empty one — so it is
    // set unconditionally rather than preserving an inherited SHLVL, keeping
    // the behaviour identical whoever launched us.
    cmd.env("SHLVL", "1");
    cmd
}

/// Runs `tailscale status --self --json` and derives this device's
/// tailnet-reachable public URL. Fails if the `tailscale` binary is
/// missing, the command errors, or the node isn't logged in (no DNSName).
pub async fn public_url() -> Result<String, String> {
    let bin = resolve_binary();
    let output = status_command(&bin)
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

    #[test]
    fn is_on_path_finds_binary_in_listed_dir() {
        let dir = std::env::temp_dir().join(format!("devdeck-tailscale-test-found-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("tailscale"), "#!/bin/sh\n").unwrap();
        assert!(is_on_path("tailscale", &dir.to_string_lossy()));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn is_on_path_false_when_not_present() {
        let dir = std::env::temp_dir().join(format!("devdeck-tailscale-test-empty-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!is_on_path("tailscale", &dir.to_string_lossy()));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The macOS Tailscale.app CLI answers as a GUI launcher, not a CLI,
    /// unless SHLVL is set — see status_command. This process is launched by
    /// LaunchServices and inherits none, so it has to be added explicitly;
    /// `tauri dev` inherits one from `sh -c`, which is the only reason the bug
    /// is invisible in development.
    #[test]
    fn status_command_sets_shlvl() {
        let cmd = status_command("/Applications/Tailscale.app/Contents/MacOS/Tailscale");
        let shlvl = cmd
            .as_std()
            .get_envs()
            .find(|(k, _)| *k == std::ffi::OsStr::new("SHLVL"))
            .map(|(_, v)| v);

        match shlvl {
            None => panic!(
                "status_command did not set SHLVL; the app-bundle CLI will try to launch the GUI \
                 and print a non-JSON error on stdout while exiting 0"
            ),
            // Some(None) is an explicit REMOVAL of the variable, which the CLI
            // reads the same as absent.
            Some(v) => assert!(
                v.is_some_and(|v| !v.is_empty()),
                "SHLVL must be set to a non-empty value, got {v:?}"
            ),
        }
    }

    #[test]
    fn status_command_asks_for_self_json() {
        let cmd = status_command("tailscale");
        let args: Vec<_> = cmd.as_std().get_args().collect();
        assert_eq!(args, ["status", "--self", "--json"]);
    }

    #[test]
    fn fallback_paths_includes_macos_app_bundle_on_macos() {
        if cfg!(target_os = "macos") {
            assert!(fallback_paths().contains(&"/Applications/Tailscale.app/Contents/MacOS/Tailscale"));
        } else {
            assert!(!fallback_paths().is_empty());
        }
    }
}
