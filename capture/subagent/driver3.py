#!/usr/bin/env python3
"""Drive `claude` headless with stream-json in/out, forcing a Task subagent.
Keeps stdin open until a terminal {"type":"result"} frame arrives."""
import json
import os
import subprocess
import sys
import threading
import time

OUT = sys.argv[1] if len(sys.argv) > 1 else "capture-task.ndjson"
PROMPT = sys.argv[2] if len(sys.argv) > 2 else (
    "Use the Task tool to launch exactly one subagent with subagent_type "
    "general-purpose. Give it this prompt: 'Reply with the single word BANANA "
    "and nothing else.' Then tell me what it said."
)
TIMEOUT = float(os.environ.get("CAP_TIMEOUT", "180"))
WORK = os.path.dirname(os.path.abspath(OUT))

cmd = [
    "claude",
    "--print",
    "--output-format", "stream-json",
    "--input-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode", "bypassPermissions",
    "--max-turns", "12",
]
if os.environ.get("FWD"):
    cmd.append("--forward-subagent-text")

print("CMD:", " ".join(cmd), file=sys.stderr)
proc = subprocess.Popen(
    cmd,
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    cwd=WORK,
    text=True,
    bufsize=1,
)

done = threading.Event()
lines = []


def reader():
    with open(OUT, "w") as fh:
        for line in proc.stdout:
            fh.write(line)
            fh.flush()
            lines.append(line)
            try:
                obj = json.loads(line)
            except Exception:
                continue
            t = obj.get("type")
            if t == "result":
                print("GOT RESULT frame; subtype=%s" % obj.get("subtype"), file=sys.stderr)
                done.set()
    done.set()


errbuf = []


def errreader():
    for line in proc.stderr:
        errbuf.append(line)
        sys.stderr.write("STDERR: " + line)


threading.Thread(target=reader, daemon=True).start()
threading.Thread(target=errreader, daemon=True).start()

msg = {
    "type": "user",
    "message": {"role": "user", "content": [{"type": "text", "text": PROMPT}]},
}
proc.stdin.write(json.dumps(msg) + "\n")
proc.stdin.flush()
print("sent user message, waiting...", file=sys.stderr)

ok = done.wait(TIMEOUT)
if not ok:
    print("TIMEOUT after %ss" % TIMEOUT, file=sys.stderr)
try:
    proc.stdin.close()
except Exception:
    pass
try:
    proc.wait(timeout=20)
except Exception:
    proc.kill()

print("lines captured: %d -> %s" % (len(lines), os.path.abspath(OUT)), file=sys.stderr)
sys.exit(0 if ok else 2)
