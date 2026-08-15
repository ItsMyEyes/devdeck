#!/bin/bash
# Permission-mode matrix. Each run: Bash echo + Write file, answering allow.
cd /private/tmp/claude-501/-Users-kiyora-Documents-explorer-agent-enginer-kiyora-dev/4db33ffa-0ccf-44f5-952c-916e64d0312e/scratchpad/capture || exit 1
P="Do these two things directly with no commentary and no planning: 1) run the shell command: echo hi   2) create a file named a.txt containing the single letter x"
BASE="--safe-mode --model sonnet"

run() {
  name="$1"; shift
  echo "===== RUN $name : $* ====="
  TIMEOUT=70 RESPOND=allow python3 drive.py "m_$name" "$P" $BASE "$@" > "m_$name.console" 2>&1
  echo "--- control_requests seen:"
  grep -o '"type": "control_request".*' "m_$name/log.txt" | head -10
  echo "--- permission_denied systems:"
  grep -o '"subtype": "permission_denied"[^}]*' "m_$name/log.txt" | head -5
  echo "--- init permissionMode:"
  grep -o '"permissionMode": "[a-zA-Z]*"' "m_$name/log.txt" | head -2
  echo "--- files:"
  ls "m_$name/work" 2>/dev/null
  echo
}

run stdio_default   --permission-prompt-tool stdio
run stdio_manual    --permission-prompt-tool stdio --permission-mode manual
run stdio_dontask   --permission-prompt-tool stdio --permission-mode dontAsk
run stdio_accept    --permission-prompt-tool stdio --permission-mode acceptEdits
run stdio_auto      --permission-prompt-tool stdio --permission-mode auto
run stdio_bypass    --permission-prompt-tool stdio --permission-mode bypassPermissions
run stdio_plan      --permission-prompt-tool stdio --permission-mode plan
run nostdio_manual  --permission-mode manual
run nostdio_dontask --permission-mode dontAsk
echo "MATRIX DONE"
