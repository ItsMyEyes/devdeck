#!/usr/bin/env python3
"""End-to-end check of the agent-chat composer against a real, isolated DevDeck.

Boots one `--role both` server on a throwaway HOME + SQLite DB with the fake
`claude` in this directory first on PATH, serves the frontend through Vite,
seeds a workspace/project/root-mode worktree over the REST API, and drives the
chat pane with Playwright (Python). The fake echoes the flags it was launched
with into every reply, so the transcript itself shows which --effort /
--permission-mode / --resume the session actually got.

Asserts:
  1. The Permission pill shows the THREAD's mode after a full reload — it is
     replayed from `thread.runtime-mode-set`, not a per-mount default — and a
     mode picked on a brand-new (draft) thread is committed right away.
  2. Picking Reasoning=Low then sending restarts the session with
     `--effort low` (and the picked `--permission-mode`); a first-turn restart
     never passes `--resume`.
  3. After a reload the Reasoning pill still reads Low (persisted per thread).
  4. Picking Max on a later turn restarts WITH `--resume <session id>`;
     an unchanged-options turn does not restart.
  5. There is no Build/Plan pill in the row.
  6. Error path: an invalid runtime mode over the agent socket is rejected
     with an `{"kind":"error"}` frame and the pill stays on the real mode.

Usage (from the repo root):
    python3 scripts/e2e-agent-chat/run.py
Requires: go, node/npm (frontend deps installed), python3 + playwright with
chromium (`pip install playwright && playwright install chromium`).
Ports: DEVDECK_E2E_API_PORT (default 8977), DEVDECK_E2E_VITE_PORT (5177).
Artifacts (screenshots, logs, fake-claude argv log) land in
$DEVDECK_E2E_OUT (default: a fresh temp dir, printed at the end).
"""
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
OUT = os.environ.get("DEVDECK_E2E_OUT") or tempfile.mkdtemp(prefix="devdeck-e2e-agent-chat-")
HOME = os.path.join(OUT, "home")
SHOTS = os.path.join(OUT, "shots")
LOG = os.path.join(OUT, "fake-claude.log")
REPO = os.path.join(OUT, "repo")
BIN = os.path.join(OUT, "devdeck")
KEY = "e2e-key-123"
API_PORT = int(os.environ.get("DEVDECK_E2E_API_PORT", "8977"))
VITE_PORT = int(os.environ.get("DEVDECK_E2E_VITE_PORT", "5177"))

for d in (os.path.join(HOME, "bin"), SHOTS, REPO):
    os.makedirs(d, exist_ok=True)
shutil.copy(os.path.join(HERE, "fake-claude"), os.path.join(HOME, "bin", "claude"))
os.chmod(os.path.join(HOME, "bin", "claude"), 0o755)
subprocess.run(["git", "init", "-q", REPO], check=True)

print("building server…")
subprocess.run(["go", "build", "-o", BIN, "./cmd/server"], cwd=os.path.join(ROOT, "backend"), check=True)

env = dict(os.environ)
env["HOME"] = HOME
env["PATH"] = os.path.join(HOME, "bin") + ":" + env["PATH"]
env["FAKE_CLAUDE_LOG"] = LOG

procs = []


def stop_all():
    for p in procs:
        try:
            os.killpg(os.getpgid(p.pid), signal.SIGTERM)
        except Exception:
            pass


def wait_port(port, timeout=120):
    end = time.time() + timeout
    while time.time() < end:
        with socket.socket() as s:
            s.settimeout(0.5)
            if s.connect_ex(("127.0.0.1", port)) == 0:
                return
        time.sleep(0.3)
    raise SystemExit(f"port {port} never opened")


def api(method, path, body=None):
    req = urllib.request.Request(
        f"http://127.0.0.1:{API_PORT}{path}", method=method,
        headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"},
        data=json.dumps(body).encode() if body is not None else None,
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        raw = r.read()
        return json.loads(raw) if raw else None


def spawns():
    if not os.path.exists(LOG):
        return []
    return [json.loads(l) for l in open(LOG) if l.strip()]


failures = []


def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond:
        failures.append(msg)


try:
    server_log = open(os.path.join(OUT, "server.log"), "w")
    procs.append(subprocess.Popen(
        [BIN, "--role", "both", "--key", KEY, "--addr", f"127.0.0.1:{API_PORT}",
         "--db", os.path.join(OUT, "hub.db"), "--open=false", "--2fa=false",
         "--public-url", f"http://127.0.0.1:{API_PORT}", "--name", "e2e-both"],
        env=env, stdout=server_log, stderr=subprocess.STDOUT, start_new_session=True))
    wait_port(API_PORT)
    time.sleep(1.5)

    vite_log = open(os.path.join(OUT, "vite.log"), "w")
    venv = dict(os.environ)
    venv["DEVDECK_API_PORT"] = str(API_PORT)
    procs.append(subprocess.Popen(
        ["npm", "--prefix", os.path.join(ROOT, "frontend"), "run", "dev:web", "--",
         "--host", "127.0.0.1", "--port", str(VITE_PORT), "--strictPort"],
        env=venv, stdout=vite_log, stderr=subprocess.STDOUT, start_new_session=True))
    wait_port(VITE_PORT)

    machine = api("GET", "/api/machines")[0]
    ws = api("POST", "/api/workspaces", {"name": "E2E"})
    project = api("POST", f"/api/workspaces/{ws['id']}/projects",
                  {"name": "trace-agent", "path": REPO, "machineId": machine["id"]})
    wt = api("POST", f"/api/projects/{project['id']}/worktrees",
             {"mode": "root", "path": REPO, "agent": "claude", "model": "sonnet"})
    url = f"http://127.0.0.1:{VITE_PORT}/w/{ws['id']}/p/{project['id']}/wt/{wt['id']}"

    from playwright.sync_api import sync_playwright, expect

    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(viewport={"width": 1400, "height": 900})
        console = []
        page.on("console", lambda m: console.append(f"[{m.type}] {m.text}"))
        page.on("pageerror", lambda e: console.append(f"[pageerror] {e}"))

        def settled(name):
            expect(page.get_by_role("textbox").first).to_be_visible(timeout=30000)
            page.wait_for_timeout(2500)
            page.screenshot(path=os.path.join(SHOTS, name))

        page.goto(f"http://127.0.0.1:{VITE_PORT}/?key={KEY}")
        page.wait_for_timeout(1500)
        page.goto(url)
        settled("01-fresh.png")

        check(page.get_by_role("button", name="Build", exact=True).count() == 0, "no Build/Plan pill in the row")
        check(page.get_by_role("button", name="Approval required", exact=True).count() >= 1, "fresh thread shows Approval required")
        check(page.get_by_role("button", name="High · 200k", exact=True).count() >= 1, "fresh thread shows High · 200k")

        # 1. mode picked on a draft thread survives a reload
        page.get_by_role("button", name="Approval required", exact=True).first.click()
        page.get_by_role("button", name=re.compile(r"^Full access")).first.click()
        expect(page.get_by_role("button", name="Full access", exact=True).first).to_be_visible(timeout=5000)
        page.wait_for_timeout(1500)
        page.reload()
        settled("02-after-reload-mode.png")
        check(page.get_by_role("button", name="Full access", exact=True).count() >= 1,
              "after reload the permission pill still reads Full access (replayed thread mode)")
        check(page.get_by_role("button", name="Approval required", exact=True).count() == 0,
              "after reload the pill does NOT fall back to Approval required")

        # 2. Reasoning -> Low, first turn restarts the session without --resume
        n_before = len(spawns())
        page.get_by_role("button", name="High · 200k", exact=True).first.click()
        page.get_by_role("button", name="Low", exact=True).first.click()
        expect(page.get_by_role("button", name="Low · 200k", exact=True).first).to_be_visible(timeout=5000)
        page.get_by_role("textbox").first.click()
        page.keyboard.type("hello there")
        page.keyboard.press("Enter")
        reply = page.get_by_text(re.compile(r"fake-claude reply #1"))
        expect(reply.first).to_be_visible(timeout=30000)
        page.wait_for_timeout(1000)
        page.screenshot(path=os.path.join(SHOTS, "03-first-turn.png"))
        text = reply.first.inner_text()
        check("effort=low" in text, "first reply ran under --effort low")
        check("mode=bypassPermissions" in text, "first reply ran under --permission-mode bypassPermissions (Full access)")
        check("resumed=no" in text, "first-turn restart did NOT pass --resume (no prior turn)")
        sp = spawns()
        check(len(sp) > n_before, "a new claude process was spawned for the changed options")
        last = sp[-1]["argv"] if sp else []
        check("--effort" in last and last[last.index("--effort") + 1] == "low", "argv carries --effort low")

        # 3. reload: Low persisted, mode still Full access, transcript replayed
        page.reload()
        settled("04-after-reload-effort.png")
        check(page.get_by_role("button", name="Low · 200k", exact=True).count() >= 1, "after reload the Reasoning pill still reads Low · 200k")
        check(page.get_by_role("button", name="Full access", exact=True).count() >= 1, "after reload the permission pill still reads Full access")
        check(page.get_by_text(re.compile(r"fake-claude reply #1")).count() >= 1, "transcript replayed the first reply")

        # 4. Max on a later turn -> restart WITH --resume; unchanged -> no restart
        page.get_by_role("button", name="Low · 200k", exact=True).first.click()
        page.get_by_role("button", name="Max", exact=True).first.click()
        expect(page.get_by_role("button", name="Max · 200k", exact=True).first).to_be_visible(timeout=5000)
        page.get_by_role("textbox").first.click()
        page.keyboard.type("again please")
        page.keyboard.press("Enter")
        reply2 = page.get_by_text(re.compile(r"fake-claude reply #\d+: effort=max"))
        expect(reply2.first).to_be_visible(timeout=30000)
        page.wait_for_timeout(800)
        page.screenshot(path=os.path.join(SHOTS, "05-second-turn-max.png"))
        text2 = reply2.first.inner_text()
        check("effort=max" in text2, "second reply ran under --effort max")
        check("resumed=yes" in text2, "second restart resumed the conversation (--resume)")
        sp = spawns()
        check("--resume" in (sp[-1]["argv"] if sp else []), "argv carries --resume on the second restart")

        n = len(spawns())
        page.get_by_role("textbox").first.click()
        page.keyboard.type("third")
        page.keyboard.press("Enter")
        expect(page.get_by_text(re.compile(r"fake-claude reply #2: effort=max")).first).to_be_visible(timeout=30000)
        page.wait_for_timeout(500)
        check(len(spawns()) == n, "an unchanged-options turn did not restart the session")

        # 7. subagents — one folded row for the whole delegated job
        n_before = len(spawns())
        page.get_by_role("textbox").first.click()
        page.keyboard.type("use a subagent for this")
        page.keyboard.press("Enter")
        expect(page.get_by_text(re.compile(r"the subagent finished")).first).to_be_visible(timeout=30000)
        page.wait_for_timeout(800)
        page.screenshot(path=os.path.join(SHOTS, "07-subagent-collapsed.png"))

        # DevDeck must have probed --help and passed the forwarding flag, or
        # the CLI sends no subagent interior at all.
        sp = spawns()
        forwarded = any("--forward-subagent-text" in s["argv"] for s in sp[n_before:] or sp)
        check(forwarded, "the session was started with --forward-subagent-text")

        # The agent is one row: its title is on screen, its interior is not.
        check(page.get_by_text("Count to three").count() >= 1, "the subagent renders as a titled row")
        check(page.get_by_text(re.compile(r"Completed")).count() >= 1, "the subagent row shows its settled status")
        check(page.get_by_text(re.compile(r"3 tools")).count() >= 1, "the subagent row shows what it spent")
        check(
            page.get_by_text(re.compile(r"SUBAGENT-SPEAKS")).count() == 0,
            "the subagent's interior stays folded away from the main transcript",
        )

        # …and one click reveals the whole thing.
        page.get_by_role("button", name=re.compile(r"Count to three")).first.click()
        expect(page.get_by_text(re.compile(r"SUBAGENT-SPEAKS")).first).to_be_visible(timeout=10000)
        page.wait_for_timeout(500)
        page.screenshot(path=os.path.join(SHOTS, "08-subagent-expanded.png"))
        check(page.get_by_text(re.compile(r"SUBAGENT-DONE")).count() >= 1, "expanding shows the subagent's narration")
        check(page.get_by_text(re.compile(r"echo ONE")).count() >= 1, "expanding shows the subagent's tool calls")
        check(
            page.get_by_text(re.compile(r"SUBAGENT-SUMMARY")).count() >= 1,
            "expanding shows the report the subagent gave back",
        )

        # 6. error path
        bad = page.evaluate(
            """([port, key, thread]) => new Promise((resolve) => {
                const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/agent?key=${key}`);
                const frames = [];
                const done = (why) => { try { ws.close(); } catch {} resolve({ why, frames }); };
                const timer = setTimeout(() => done('timeout'), 8000);
                ws.onopen = () => {
                    ws.send(JSON.stringify({ kind: 'hello', threadId: thread, sinceSeq: 999999 }));
                    ws.send(JSON.stringify({ kind: 'command', command: { commandId: 'e2e-bad-' + Date.now(), type: 'thread.runtime-mode.set', threadId: thread, issuedAt: Date.now(), payload: { mode: 'yolo' } } }));
                };
                ws.onmessage = (ev) => { frames.push(ev.data); if (ev.data.includes('"error"')) { clearTimeout(timer); done('error-frame'); } };
                ws.onerror = () => { clearTimeout(timer); done('ws-error'); };
            })""",
            [API_PORT, KEY, wt["id"]],
        )
        check(bad["why"] == "error-frame" and any("invalid runtime mode" in f for f in bad["frames"]),
              "an invalid runtime mode is rejected with an error frame")
        page.wait_for_timeout(1000)
        page.screenshot(path=os.path.join(SHOTS, "06-after-bad-mode.png"))
        check(page.get_by_role("button", name="Full access", exact=True).count() >= 1,
              "the rejected mode left the pill on the thread's real mode")

        # A 502/504 on a proxied request is the Vite dev proxy timing out
        # against the Go server it fronts — harness plumbing, not the app
        # under test, and it shows up on unrelated polling endpoints. Every
        # other console error still fails the run, page errors included.
        def app_fault(entry: str) -> bool:
            if not (entry.startswith("[error]") or entry.startswith("[pageerror]")):
                return False
            proxy_hiccup = "Failed to load resource" in entry and ("502" in entry or "504" in entry)
            return not proxy_hiccup

        errors = [c for c in console if app_fault(c)]
        ignored = [c for c in console if (c.startswith("[error]") or c.startswith("[pageerror]")) and not app_fault(c)]
        if ignored:
            print(f"  (ignored {len(ignored)} dev-proxy transport error(s): {ignored[:2]})")
        check(not errors, f"no browser console errors ({errors[:3]})")
        browser.close()

    print("\nRESULT:", "ALL PASS" if not failures else f"{len(failures)} FAILED: {failures}")
    print("artifacts:", OUT)
    sys.exit(0 if not failures else 1)
finally:
    stop_all()
    time.sleep(1)
