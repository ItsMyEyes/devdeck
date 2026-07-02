// loom terminal gateway — bridges xterm.js (browser) to a real PTY (node-pty).
//
// Protocol
//   client → server : JSON control frames  { t: 'i', d }  (stdin)  |  { t: 'r', cols, rows }  (resize)
//   server → client : raw terminal output  (write straight into xterm)
//
// If node-pty's native module isn't available (e.g. no build toolchain), the
// gateway degrades to a self-contained "agent stream" so the protocol still
// works end to end — the app remains fully usable without a real shell.

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import { WebSocketServer } from 'ws'

const PORT = Number(process.env.TERMINAL_PORT ?? 8788)
const PATH = '/ws/terminal'

// ---- ANSI helpers (for banners + the mock stream) ------------------------
const A = {
  reset: '\x1b[0m',
  dim: '\x1b[38;5;244m',
  blue: '\x1b[38;5;111m',
  green: '\x1b[38;5;114m',
  yellow: '\x1b[38;5;222m',
  red: '\x1b[38;5;210m',
  purple: '\x1b[38;5;183m',
  gray: '\x1b[38;5;102m',
}
const KIND_ANSI = { cmd: A.blue, out: A.dim, ok: A.green, warn: A.yellow, err: A.red, sys: A.gray, file: A.purple }
const MOCK_POOL = [
  ['sys', '● thinking…'],
  ['file', 'edit  src/server/auth/jwt.ts (+18 −4)'],
  ['out', 'ran tool: read_file package.json'],
  ['cmd', '$ pnpm test -- auth.spec.ts'],
  ['ok', '✓ 23 passed (3.1s)'],
  ['out', 'typechecking… 412 files'],
  ['warn', '⚠ unused export "legacyVerify"'],
  ['file', 'create src/server/auth/rotate.ts'],
  ['ok', '✓ lint clean — 0 problems'],
  ['sys', '● searching codebase: "verifyToken"'],
  ['out', '7 matches across 5 files'],
]

// Try to load node-pty once; null if unavailable.
let pty = null
try {
  pty = (await import('node-pty')).default ?? (await import('node-pty'))
  // sanity check the API surface
  if (typeof pty.spawn !== 'function') pty = null
} catch {
  pty = null
}

function log(...args) {
  console.log('[terminal]', ...args)
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, pty: !!pty }))
    return
  }
  res.writeHead(426)
  res.end('Upgrade required')
})

const wss = new WebSocketServer({ server, path: PATH })

wss.on('connection', (ws, req) => {
  // Liveness: half-open TCP connections (laptop sleep, killed tab) never emit
  // 'close', so a periodic ping/pong sweep terminates dead sockets — which then
  // fires 'close' and runs the PTY/interval cleanup below.
  ws.isAlive = true
  ws.on('pong', () => {
    ws.isAlive = true
  })

  const url = new URL(req.url ?? PATH, 'http://localhost')
  const session = url.searchParams.get('session') ?? 'session'
  const cols = clampInt(url.searchParams.get('cols'), 80, 1, 500)
  const rows = clampInt(url.searchParams.get('rows'), 24, 1, 300)

  if (pty) {
    try {
      attachPty(ws, session, cols, rows)
    } catch (err) {
      // A PTY can fail to spawn (locked-down env, missing shell). Never let one
      // bad session take down the gateway — fall back to the mock stream.
      log(`session ${session}: pty spawn failed (${err?.message}); using mock stream`)
      attachMock(ws, session)
    }
  } else {
    attachMock(ws, session)
  }
})

const HEARTBEAT_MS = 30_000
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate()
      continue
    }
    ws.isAlive = false
    try {
      ws.ping()
    } catch {
      /* socket already tearing down */
    }
  }
}, HEARTBEAT_MS)
wss.on('close', () => clearInterval(heartbeat))

process.on('uncaughtException', (err) => log('uncaught:', err?.message ?? err))

server.listen(PORT, () => {
  log(`listening on ws://localhost:${PORT}${PATH}  (pty=${pty ? 'node-pty' : 'mock stream'})`)
})

// -------------------- real PTY --------------------
function pickShell() {
  if (process.platform === 'win32') return process.env.COMSPEC || 'powershell.exe'
  const candidates = [process.env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh'].filter(Boolean)
  for (const s of candidates) {
    try {
      if (fs.existsSync(s)) return s
    } catch {
      /* keep looking */
    }
  }
  return '/bin/sh'
}

function attachPty(ws, session, cols, rows) {
  const shell = pickShell()
  const child = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: os.homedir(),
    env: { ...process.env, TERM: 'xterm-256color', LOOM_SESSION: session },
  })
  log(`session ${session}: spawned ${shell} (pid ${child.pid})`)

  const banner =
    `${A.dim}loom terminal · session ${session} · ${shell}${A.reset}\r\n` +
    `${A.dim}connected to a live PTY on this machine.${A.reset}\r\n\r\n`
  ws.send(banner)

  const onData = child.onData((data) => {
    if (ws.readyState === ws.OPEN) ws.send(data)
  })
  const onExit = child.onExit(({ exitCode }) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(`\r\n${A.dim}[process exited with code ${exitCode}]${A.reset}\r\n`)
      ws.close()
    }
  })

  ws.on('message', (raw) => {
    const frame = parseFrame(raw)
    if (!frame) return
    if (frame.t === 'i' && typeof frame.d === 'string') child.write(frame.d)
    else if (frame.t === 'r') child.resize(clampInt(frame.cols, cols, 1, 500), clampInt(frame.rows, rows, 1, 300))
  })

  ws.on('close', () => {
    onData.dispose()
    onExit.dispose()
    try {
      child.kill()
    } catch {
      /* already gone */
    }
    log(`session ${session}: closed`)
  })
}

// -------------------- mock agent stream (no node-pty) --------------------
function attachMock(ws, session) {
  let buf = ''
  const send = (s) => ws.readyState === ws.OPEN && ws.send(s)
  const prompt = () => send(`\r\n${A.green}loom:${session}${A.reset} ${A.blue}›${A.reset} `)

  send(`${A.dim}loom terminal · session ${session} · simulated agent (node-pty unavailable)${A.reset}\r\n\r\n`)
  let i = 0
  const heartbeat = setInterval(() => {
    const [k, t] = MOCK_POOL[i++ % MOCK_POOL.length]
    send(`${KIND_ANSI[k] ?? A.dim}${t}${A.reset}\r\n`)
  }, 1600)

  prompt()

  ws.on('message', (raw) => {
    const frame = parseFrame(raw)
    if (!frame || frame.t !== 'i' || typeof frame.d !== 'string') return
    for (const ch of frame.d) {
      if (ch === '\r') {
        const cmd = buf.trim()
        buf = ''
        send('\r\n')
        if (cmd) send(`${A.dim}running: ${cmd}${A.reset}\r\n${A.green}✓ done${A.reset}\r\n`)
        prompt()
      } else if (ch === '\x7f') {
        // backspace
        if (buf.length) {
          buf = buf.slice(0, -1)
          send('\b \b')
        }
      } else {
        buf += ch
        send(ch)
      }
    }
  })

  ws.on('close', () => {
    clearInterval(heartbeat)
    log(`session ${session}: mock closed`)
  })
}

// -------------------- utils --------------------
function parseFrame(raw) {
  try {
    return JSON.parse(raw.toString())
  } catch {
    return null
  }
}
function clampInt(v, dflt, min, max) {
  const n = Number.parseInt(String(v ?? ''), 10)
  if (Number.isNaN(n)) return dflt
  return Math.min(max, Math.max(min, n))
}
