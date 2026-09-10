// "Open with an external app" — the file-preview toolbar's and the file
// tree's "Open with default app" action. Writes the file's bytes to a
// private temp location, hands that path to the OS's default handler for its
// extension, and removes the temp copy again once the app that opened it
// closes — so a file downloaded only to be glanced at in Preview/Word/VS
// Code doesn't linger on disk afterward.
//
// "Until it closes" is honoured exactly on macOS and Windows, whose shells
// expose a blocking open (`open -W`, `start /WAIT`) that waits for the
// launched app to quit even when it just handed the document to an
// already-running instance. Linux has no equivalent — xdg-open forks and
// returns immediately no matter what — so there the temp file is instead
// swept up after a generous idle timeout. Every platform also sweeps
// whatever is still on disk when the app itself quits (`cleanup_all`,
// wired into lib.rs's `RunEvent::ExitRequested`/`Exit`), which is what
// catches a wait interrupted by a crash or a forced quit.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
#[cfg(all(unix, not(target_os = "macos")))]
use std::time::Duration;

use tauri::{AppHandle, Manager};

/// Every temp file this session has handed to an external app and not yet
/// confirmed removed, so app shutdown can sweep up anything still on disk.
pub struct OpenWithTempFiles(Mutex<Vec<PathBuf>>);

impl OpenWithTempFiles {
    pub fn new() -> Self {
        Self(Mutex::new(Vec::new()))
    }
}

impl Default for OpenWithTempFiles {
    fn default() -> Self {
        Self::new()
    }
}

/// How long a Linux temp file is kept when there is no way to detect the
/// viewer closing it, before the fallback sweep removes it anyway.
#[cfg(all(unix, not(target_os = "macos")))]
const LINUX_FALLBACK_TTL: Duration = Duration::from_secs(30 * 60);

fn register(app: &AppHandle, path: PathBuf) {
    app.state::<OpenWithTempFiles>().0.lock().unwrap().push(path);
}

/// Each file lives alone in its own randomly-named directory (see
/// `open_with_external`), so removing that parent removes the file too —
/// one filesystem call instead of two, and nothing else is ever placed there.
fn remove_temp_dir(path: &Path) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::remove_dir_all(parent);
    }
}

fn unregister_and_remove(app: &AppHandle, path: &Path) {
    app.state::<OpenWithTempFiles>().0.lock().unwrap().retain(|p| p != path);
    remove_temp_dir(path);
}

/// Sweeps every temp file this session created that is still on disk. See
/// the module doc comment for why this runs on quit regardless of platform.
pub fn cleanup_all(app: &AppHandle) {
    let paths = std::mem::take(&mut *app.state::<OpenWithTempFiles>().0.lock().unwrap());
    for path in paths {
        remove_temp_dir(&path);
    }
}

/// Reverses the frontend's `encodeURIComponent(name)` — the filename rides a
/// request header (see `open_with_external`), which must be ASCII, so the
/// frontend percent-encodes it and this undoes that rather than pulling in a
/// URL-encoding crate for one call site. Operates on bytes throughout so a
/// malformed sequence can never land a slice on a non-UTF-8 char boundary.
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(hi), Some(lo)) = (hi, lo) {
                out.push((hi * 16 + lo) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Strips any path structure from a name the frontend supplies — it only
/// ever needs to survive as the final path segment (so the OS's file-type
/// association and the opened app's own window title stay sensible), never
/// as a way to escape the temp directory this file is written into.
fn safe_file_name(name: &str) -> String {
    let base = Path::new(name)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    if base.is_empty() {
        "file".to_string()
    } else {
        base
    }
}

/// A short random token for this open's private temp directory, so two
/// concurrent opens of same-named files (or two opens of the same file)
/// never collide. Reuses `getrandom` rather than adding a uuid crate for one
/// call site — same approach as `sidecar::generate_key`.
fn random_token() -> String {
    let mut buf = [0u8; 16];
    getrandom::fill(&mut buf).expect("os rng unavailable");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(target_os = "macos")]
fn wait_for_close(path: &Path) {
    // `-n`: always launch a new instance, even if the app is already running
    // — without it, `-W` would wait on whichever instance handled the
    // request, which may be one that was already open before this file and
    // will outlive it. `-W` then blocks until that instance quits. For a
    // single-instance app (Preview, TextEdit) macOS still only ever runs one
    // process, so this waits for the whole app to quit rather than just the
    // one document window — the closest available approximation of "until
    // this file is closed" on this platform.
    let _ = std::process::Command::new("open").arg("-W").arg("-n").arg(path).status();
}

#[cfg(target_os = "windows")]
fn wait_for_close(path: &Path) {
    // `start`'s own first quoted argument is a window title, not the
    // command — the empty "" here is that title, so `path` is read as the
    // command to run. `/WAIT` blocks cmd until the launched app exits.
    let _ = std::process::Command::new("cmd")
        .args(["/C", "start", "", "/WAIT"])
        .arg(path)
        .status();
}

#[cfg(all(unix, not(target_os = "macos")))]
fn wait_for_close(path: &Path) {
    // xdg-open forks the real viewer and returns immediately, whether or not
    // it just handed the file to an already-running instance — Linux has no
    // "wait for this document's window to close" primitive to fall back on.
    // Fire it and fall back to a timed sweep instead of leaking the temp
    // copy for the rest of the session.
    let _ = std::process::Command::new("xdg-open").arg(path).status();
    std::thread::sleep(LINUX_FALLBACK_TTL);
}

/// Writes the invoke's raw request body to a fresh temp directory and hands
/// it to the OS's default app for its extension, then removes it again once
/// that app closes — see the module doc comment for exactly what "closes"
/// means per platform.
///
/// Takes `tauri::ipc::Request` directly (rather than typed JSON args) so the
/// file's bytes cross IPC as the raw body instead of a JSON number array,
/// which would otherwise inflate a multi-megabyte document 3-4x and cost a
/// slow parse on both ends. The filename rides a header instead, since a
/// raw-body invoke carries no other named arguments.
///
/// Deliberately synchronous rather than `async fn`: Tauri spawns async
/// commands onto a task that must outlive the call, which requires every
/// argument to be `'static` — `Request<'_>` borrows from the invoke call and
/// cannot satisfy that. Everything this does (a filesystem write, spawning
/// the wait-and-delete thread) is non-blocking enough to run inline.
#[tauri::command]
pub fn open_with_external(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(data) = request.body() else {
        return Err("expected raw file bytes".to_string());
    };
    let encoded_name = request
        .headers()
        .get("x-devdeck-filename")
        .and_then(|value| value.to_str().ok())
        .ok_or("missing x-devdeck-filename header")?;
    let name = safe_file_name(&percent_decode(encoded_name));

    let dir = std::env::temp_dir().join("devdeck-open-with").join(random_token());
    std::fs::create_dir_all(&dir).map_err(|e| format!("create temp folder: {e}"))?;
    let path = dir.join(&name);
    std::fs::write(&path, data).map_err(|e| format!("write temp file: {e}"))?;
    register(&app, path.clone());

    std::thread::spawn(move || {
        wait_for_close(&path);
        unregister_and_remove(&app, &path);
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{percent_decode, safe_file_name};

    #[test]
    fn percent_decode_reverses_encode_uri_component() {
        assert_eq!(percent_decode("report.docx"), "report.docx");
        assert_eq!(percent_decode("final%20report.docx"), "final report.docx");
        assert_eq!(percent_decode("re%CC%81sume%CC%81.pdf"), "re\u{0301}sume\u{0301}.pdf");
    }

    #[test]
    fn safe_file_name_strips_path_structure() {
        assert_eq!(safe_file_name("report.docx"), "report.docx");
        assert_eq!(safe_file_name("../../etc/passwd"), "passwd");
        assert_eq!(safe_file_name("a/b/c.txt"), "c.txt");
        assert_eq!(safe_file_name(""), "file");
        assert_eq!(safe_file_name(".."), "file");
    }
}
