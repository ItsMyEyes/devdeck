import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from './createApp.js';

const PORT = Number(process.env.PORT ?? 8787);
const GRACE_MS = Number(process.env.SESSION_GRACE_MS ?? 5 * 60 * 1000);

// On Windows, node-pty needs the exact executable filename (including
// extension) - it doesn't do the PATHEXT-style resolution a shell would.
// The `claude` CLI ships as claude.exe (native installer), claude.cmd (npm
// global install), or bare `claude` (WSL/npm on some setups), so search PATH
// for whichever one actually exists rather than guessing.
function resolveClaudeCommand(): string {
  if (process.env.CLAUDE_COMMAND) return process.env.CLAUDE_COMMAND;
  if (process.platform !== 'win32') return 'claude';

  const pathDirs = (process.env.PATH ?? '').split(';').filter(Boolean);
  for (const ext of ['.exe', '.cmd', '']) {
    for (const dir of pathDirs) {
      if (existsSync(join(dir, `claude${ext}`))) {
        return `claude${ext}`;
      }
    }
  }
  return 'claude.exe';
}

const CLAUDE_COMMAND = resolveClaudeCommand();

const { server } = createApp({
  registryOptions: { command: CLAUDE_COMMAND, args: [], graceMs: GRACE_MS },
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Server listening on http://127.0.0.1:${PORT}`);
});
