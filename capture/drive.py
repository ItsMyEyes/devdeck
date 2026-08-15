#!/usr/bin/env python3
"""Drive the claude CLI over stream-json stdin/stdout and log every raw line.

Usage: drive.py <outdir> <prompt> [extra claude args...]

Env knobs:
  RESPOND=allow|deny|none   how to answer control_request can_use_tool (default none)
  INIT=1                    send an SDK-style `initialize` control_request first
  TIMEOUT=NN                seconds to run (default 90)
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

RESPOND = os.environ.get("RESPOND", "none")
INIT = os.environ.get("INIT", "") == "1"
TIMEOUT = float(os.environ.get("TIMEOUT", "90"))

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
note(f"RESPOND={RESPOND} INIT={INIT}")

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


def send_interrupt():
    style = os.environ.get("INTERRUPT_STYLE", "devdeck")
    if style == "devdeck":
        # EXACTLY what backend/internal/agentcore/provider/claude/adapter.go
        # InterruptTurn writes today: no top-level request_id.
        send({"type": "control_request", "request": {"subtype": "interrupt"}})
    else:
        send({"type": "control_request", "request_id": "req_int_1",
              "request": {"subtype": "interrupt"}})


def reader():
    for line in p.stdout:
        raw.write(line)
        raw.flush()
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except Exception:
            note(f"<-- NONJSON {line[:400]}")
            continue
        t = obj.get("type")
        if t == "stream_event":
            # too chatty; summarize
            ev = obj.get("event", {})
            note(f"<-- stream_event {ev.get('type')}")
            continue
        note(f"<-- {json.dumps(obj)[:2000]}")
        if t == "control_request":
            handle_control(obj)
        if t == "result":
            done.set()


def handle_control(obj):
    req = obj.get("request", {}) or {}
    subtype = req.get("subtype")
    rid = obj.get("request_id") or req.get("request_id")
    if os.environ.get("INTERRUPT_ON_PERMISSION") == "1" and subtype == "can_use_tool":
        note("!!! permission pending -- sending interrupt now")
        send_interrupt()
    if RESPOND == "none":
        note(f"!!! control_request subtype={subtype} rid={rid} -- NOT ANSWERING")
        return
    if subtype == "can_use_tool":
        if RESPOND == "ask" and req.get("tool_name") == "AskUserQuestion":
            qs = (req.get("input") or {}).get("questions") or []
            answers = {}
            for q in qs:
                opts = q.get("options") or []
                answers[q.get("question")] = opts[0].get("label") if opts else "yes"
            body = {
                "behavior": "allow",
                "updatedInput": {"questions": qs, "answers": answers},
            }
            send({
                "type": "control_response",
                "response": {"subtype": "success", "request_id": rid, "response": body},
            })
            return
        if RESPOND == "allow_bare":
            body = {"behavior": "allow"}
        elif RESPOND == "allow_persist":
            body = {
                "behavior": "allow",
                "updatedInput": req.get("input", {}),
                "updatedPermissions": req.get("permission_suggestions", []),
            }
        elif RESPOND in ("allow", "ask"):
            body = {"behavior": "allow", "updatedInput": req.get("input", {})}
        else:
            body = {"behavior": "deny", "message": "denied by capture harness"}
        send({
            "type": "control_response",
            "response": {"subtype": "success", "request_id": rid, "response": body},
        })
    else:
        send({
            "type": "control_response",
            "response": {"subtype": "success", "request_id": rid, "response": {}},
        })


def errreader():
    for line in p.stderr:
        note(f"<== STDERR {line.rstrip()}")


threading.Thread(target=reader, daemon=True).start()
threading.Thread(target=errreader, daemon=True).start()

if INIT:
    send({
        "type": "control_request",
        "request_id": "req_init_1",
        "request": {"subtype": "initialize", "hooks": {}},
    })
    time.sleep(1.0)

send({
    "type": "user",
    "message": {"role": "user", "content": [{"type": "text", "text": prompt}]},
})

if os.environ.get("INTERRUPT_AFTER"):
    def _later():
        time.sleep(float(os.environ["INTERRUPT_AFTER"]))
        send_interrupt()
    threading.Thread(target=_later, daemon=True).start()

deadline = time.time() + TIMEOUT
result_at = None
while time.time() < deadline:
    if p.poll() is not None:
        note(f"EXIT code={p.returncode}")
        break
    if done.is_set():
        if result_at is None:
            result_at = time.time()
        elif time.time() - result_at > 2.0:
            note("RESULT seen -- killing")
            p.kill()
            break
    time.sleep(0.3)
else:
    note("TIMEOUT -- killing")
    p.kill()

time.sleep(1.0)
note("done")
raw.close()
log.close()
