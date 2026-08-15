#!/usr/bin/env python3
"""Drive the claude CLI, wait past system/init, then send a
control_request with subtype:"set_permission_mode" on the already-running
session and record the control_response (or lack of one).

Shape tried is the one found by `strings $(which claude) | grep -i
permission_mode`:
  {"type":"control_request","request_id":"<uuid>",
   "request":{"subtype":"set_permission_mode","mode":"<mode>"}}
(the CLI's own schema also accepts an optional "ultraplan" bool, omitted
here as not applicable to DevDeck.)

Usage: set_mode.py <outdir> <prompt> <target-mode> [extra claude args...]
"""
import json
import os
import subprocess
import sys
import threading
import time
import uuid

outdir = sys.argv[1]
prompt = sys.argv[2]
target_mode = sys.argv[3]
extra = sys.argv[4:]

os.makedirs(outdir, exist_ok=True)
workdir = os.path.join(outdir, "work")
os.makedirs(workdir, exist_ok=True)

TIMEOUT = float(os.environ.get("TIMEOUT", "60"))

args = [
    "claude",
    "--print",
    "--output-format", "stream-json",
    "--input-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
] + extra

raw_path = os.path.join(outdir, "stdout.ndjson")
log_path = os.path.join(outdir, "log.txt")
raw = open(raw_path, "w")
log = open(log_path, "w")

t0 = time.time()


def note(msg):
    line = f"[{time.time()-t0:7.2f}] {msg}"
    log.write(line + "\n")
    log.flush()
    print(line, flush=True)


note(f"ARGS: {' '.join(args)}")
note(f"CWD: {workdir}")
note(f"TARGET MODE: {target_mode}")

p = subprocess.Popen(
    args,
    cwd=workdir,
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    text=True,
    bufsize=1,
)

stdin_lock = threading.Lock()
done = threading.Event()
init_seen = threading.Event()
set_mode_rid = f"set-mode-{uuid.uuid4()}"
set_mode_sent_at = {"t": None}
set_mode_response_at = {"t": None}


def send(obj):
    data = json.dumps(obj)
    with stdin_lock:
        try:
            p.stdin.write(data + "\n")
            p.stdin.flush()
        except Exception as e:  # pragma: no cover
            note(f"SEND-FAIL {e}")
            return
    note(f"--> STDIN {data}")


def reader():
    for line in p.stdout:
        raw.write(line)
        raw.flush()
        stripped = line.strip()
        if not stripped:
            continue
        try:
            obj = json.loads(stripped)
        except Exception:
            note(f"<-- NONJSON {stripped[:400]}")
            continue
        t = obj.get("type")
        if t == "stream_event":
            ev = obj.get("event", {})
            note(f"<-- stream_event {ev.get('type')}")
            continue
        note(f"<-- {json.dumps(obj)[:2000]}")
        if t == "system" and obj.get("subtype") == "init":
            init_seen.set()
        if t == "control_response":
            resp = obj.get("response", {}) or {}
            if resp.get("request_id") == set_mode_rid:
                set_mode_response_at["t"] = time.time()
                note(f"*** set_permission_mode control_response: {json.dumps(resp)} ***")
        if t == "control_request":
            handle_control(obj)
        if t == "result":
            done.set()


def handle_control(obj):
    req = obj.get("request", {}) or {}
    subtype = req.get("subtype")
    rid = obj.get("request_id") or req.get("request_id")
    if subtype != "can_use_tool":
        send({
            "type": "control_response",
            "response": {"subtype": "success", "request_id": rid, "response": {}},
        })
        return
    body = {"behavior": "allow", "updatedInput": req.get("input", {})}
    send({
        "type": "control_response",
        "response": {"subtype": "success", "request_id": rid, "response": body},
    })


def errreader():
    for line in p.stderr:
        note(f"<== STDERR {line.rstrip()}")


threading.Thread(target=reader, daemon=True).start()
threading.Thread(target=errreader, daemon=True).start()

send({
    "type": "user",
    "message": {"role": "user", "content": [{"type": "text", "text": prompt}]},
})


def send_set_mode_when_ready():
    if not init_seen.wait(timeout=15):
        note("!!! never saw system/init -- sending set_permission_mode anyway")
    time.sleep(0.5)
    set_mode_sent_at["t"] = time.time()
    send({
        "type": "control_request",
        "request_id": set_mode_rid,
        "request": {"subtype": "set_permission_mode", "mode": target_mode},
    })


threading.Thread(target=send_set_mode_when_ready, daemon=True).start()

deadline = time.time() + TIMEOUT
result_at = None
while time.time() < deadline:
    if p.poll() is not None:
        note(f"EXIT code={p.returncode}")
        break
    if done.is_set():
        if result_at is None:
            result_at = time.time()
        elif time.time() - result_at > 3.0:
            note("RESULT seen -- killing")
            p.kill()
            break
    time.sleep(0.3)
else:
    note("TIMEOUT -- killing")
    p.kill()

time.sleep(1.0)
if set_mode_sent_at["t"] is None:
    note("VERDICT: set_permission_mode was never sent")
elif set_mode_response_at["t"] is not None:
    delta = set_mode_response_at["t"] - set_mode_sent_at["t"]
    note(f"VERDICT: control_response for set_permission_mode arrived {delta:.2f}s after send")
else:
    note("VERDICT: NO control_response for set_permission_mode ever arrived")
note("done")
raw.close()
log.close()
