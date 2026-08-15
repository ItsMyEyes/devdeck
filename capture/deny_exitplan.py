#!/usr/bin/env python3
"""Drive the claude CLI to trigger ExitPlanMode, then deny that specific
control_request with the EXACT verbatim message DevDeck's parse.go uses
(planCapturedDenyMessage), and observe whether a terminal "result" line
still arrives. Every other can_use_tool control_request (should not occur
in plan mode before ExitPlanMode, but just in case) is allowed so the
session isn't blocked on something unrelated.

Usage: deny_exitplan.py <outdir> <prompt> [extra claude args...]
"""
import json
import os
import subprocess
import sys
import threading
import time

outdir = sys.argv[1]
prompt = sys.argv[2]
extra = sys.argv[3:]

os.makedirs(outdir, exist_ok=True)
workdir = os.path.join(outdir, "work")
os.makedirs(workdir, exist_ok=True)

TIMEOUT = float(os.environ.get("TIMEOUT", "90"))

DENY_MESSAGE = (
    "The client captured your proposed plan. Stop here and wait for the "
    "user's feedback or implementation request in a later turn."
)

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
note("MODE: deny ExitPlanMode with verbatim planCapturedDenyMessage; allow anything else")

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
result_seen_at = {"t": None}
denied_at = {"t": None}
post_deny_lines = {"n": 0}


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
        if denied_at["t"] is not None:
            post_deny_lines["n"] += 1
        if t == "stream_event":
            ev = obj.get("event", {})
            note(f"<-- stream_event {ev.get('type')}")
            continue
        note(f"<-- {json.dumps(obj)[:2000]}")
        if t == "control_request":
            handle_control(obj)
        if t == "result":
            note("*** RESULT LINE OBSERVED ***")
            result_seen_at["t"] = time.time()
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
    tool_name = req.get("tool_name")
    if tool_name == "ExitPlanMode":
        note(f"*** DENYING ExitPlanMode control_request rid={rid} with verbatim message ***")
        denied_at["t"] = time.time()
        body = {"behavior": "deny", "message": DENY_MESSAGE}
    else:
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
if denied_at["t"] is None:
    note("VERDICT: never saw an ExitPlanMode control_request to deny")
elif result_seen_at["t"] is not None:
    delta = result_seen_at["t"] - denied_at["t"]
    note(f"VERDICT: result line arrived {delta:.2f}s after the deny; {post_deny_lines['n']} lines followed the deny in total")
else:
    note(f"VERDICT: NO result line arrived after the deny within the {TIMEOUT}s window; {post_deny_lines['n']} lines followed the deny -- thread would hang without a defensive idle-dispatch")
note("done")
raw.close()
log.close()
