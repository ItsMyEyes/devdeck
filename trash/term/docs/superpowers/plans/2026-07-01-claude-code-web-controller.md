# Claude Code Web Controller Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local web app where a browser controls a real Claude Code CLI session through a Node.js WebSocket backend, with full terminal fidelity (colors, interactive prompts) via `node-pty` + `xterm.js`, and resumable sessions that survive a dropped connection.

**Architecture:** Two npm workspaces — `server/` (Express + `ws` + `node-pty`, holding a `sessionId`-keyed registry of running PTYs) and `client/` (Vite + React + TypeScript + shadcn/ui + `xterm.js`). The browser starts a session with a working directory, gets back a `sessionId`, and streams keystrokes/output over a WebSocket. A dropped socket doesn't kill the PTY — it starts a grace timer; reattaching within the grace period replays buffered output and resumes.

**Tech Stack:** Node.js, TypeScript, Express, `ws`, `node-pty`, Vitest (server tests) — Vite, React, TypeScript, shadcn/ui (Tailwind), `xterm.js` + `xterm-addon-fit` (client).

## Global Constraints

- No authentication; server binds to `127.0.0.1` only (localhost dev tool, not network-exposed).
- Exactly one active Claude Code session at a time.
- Session resume grace period: 5 minutes default (`SESSION_GRACE_MS` env var, configurable for testing).
- Output replay buffer: capped at 64KB per session (most recent output only).
- WS protocol is exactly: client sends `start`/`attach`/`input`/`resize`; server sends `started`/`not_found`/`error`/`exit` as JSON control frames, plus raw (non-JSON-wrapped) PTY output frames.
- No automated frontend test suite for v1 — frontend tasks are verified manually (per spec). Server logic is TDD'd with Vitest.
- On Windows, npm installs the `claude` CLI as a `.cmd` shim; `node-pty` does not do shell PATH-extension resolution, so the default command must account for this (see Task 5).

---

## Task 1: Repo scaffold — workspaces, server skeleton, health check

**Files:**
- Create: `package.json` (root)
- Create: `.gitignore` (root)
- Create: `server/package.json`
- Create: `server/tsconfig.json`
- Create: `server/vitest.config.ts`
- Create: `server/src/index.ts`
- Test: `server/test/health.test.ts`

**Interfaces:**
- Produces: a running Express app on `127.0.0.1:<PORT>` with `GET /health` returning `{ ok: true }`. Later tasks replace `index.ts`'s body but keep this route.

- [ ] **Step 1: Create root `package.json`**

```json
{
  "name": "claude-code-web-controller",
  "private": true,
  "workspaces": ["server", "client"],
  "scripts": {
    "dev": "concurrently -n server,client -c blue,green \"npm run dev -w server\" \"npm run dev -w client\""
  },
  "devDependencies": {
    "concurrently": "^8.2.2"
  }
}
```

- [ ] **Step 2: Create root `.gitignore`**

```
node_modules/
dist/
*.log
```

- [ ] **Step 3: Create `server/package.json`**

```json
{
  "name": "server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js",
    "test": "vitest run"
  },
  "dependencies": {
    "express": "^4.19.2",
    "node-pty": "^1.0.0",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/node": "^20.14.10",
    "@types/ws": "^8.5.10",
    "tsx": "^4.16.2",
    "typescript": "^5.5.4",
    "vitest": "^2.0.5"
  }
}
```

- [ ] **Step 4: Create `server/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src"]
}
```

- [ ] **Step 5: Create `server/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 10000,
  },
});
```

- [ ] **Step 6: Create `server/src/index.ts`**

```ts
import express from 'express';
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 8787);

const app = express();
app.get('/health', (_req, res) => res.json({ ok: true }));

const server = createServer(app);

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Server listening on http://127.0.0.1:${PORT}`);
});
```

- [ ] **Step 7: Write the failing test for the health check**

Create `server/test/health.test.ts`:

```ts
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { createServer } from 'node:http';
import express from 'express';

describe('health check', () => {
  let server: ReturnType<typeof createServer>;
  let port: number;

  beforeAll(async () => {
    const app = express();
    app.get('/health', (_req, res) => res.json({ ok: true }));
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as any).port;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('responds with ok: true', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });
});
```

- [ ] **Step 8: Install dependencies and run the test**

Run from repo root:
```bash
npm install
npm run test -w server
```
Expected: PASS (this test builds its own inline server, so it passes even before Step 9).

- [ ] **Step 9: Verify the real server boots**

Run: `npm run dev -w server`
Then in another terminal: `curl http://127.0.0.1:8787/health`
Expected: `{"ok":true}`. Stop the dev server (Ctrl+C).

- [ ] **Step 10: Commit**

```bash
git add package.json .gitignore server/package.json server/tsconfig.json server/vitest.config.ts server/src/index.ts server/test/health.test.ts
git commit -m "chore: scaffold workspaces and server health check"
```

---

## Task 2: RingBuffer utility

**Files:**
- Create: `server/src/ringBuffer.ts`
- Test: `server/test/ringBuffer.test.ts`

**Interfaces:**
- Produces: `class RingBuffer { constructor(maxBytes: number); append(data: string): void; contents(): string }` — used by Task 4's `SessionRegistry` to buffer PTY output for replay.

- [ ] **Step 1: Write the failing tests**

Create `server/test/ringBuffer.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { RingBuffer } from '../src/ringBuffer.js';

describe('RingBuffer', () => {
  it('returns everything appended while under the cap', () => {
    const buffer = new RingBuffer(1024);
    buffer.append('hello ');
    buffer.append('world');
    expect(buffer.contents()).toBe('hello world');
  });

  it('evicts the oldest chunks once the cap is exceeded', () => {
    const buffer = new RingBuffer(10);
    buffer.append('0123456789'); // exactly 10 bytes
    buffer.append('X'); // pushes total to 11 bytes, must evict the first chunk
    expect(buffer.contents()).toBe('X');
  });

  it('starts empty', () => {
    const buffer = new RingBuffer(1024);
    expect(buffer.contents()).toBe('');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -w server`
Expected: FAIL with "Cannot find module '../src/ringBuffer.js'"

- [ ] **Step 3: Implement `RingBuffer`**

Create `server/src/ringBuffer.ts`:

```ts
export class RingBuffer {
  private chunks: string[] = [];
  private totalBytes = 0;

  constructor(private readonly maxBytes: number) {}

  append(data: string): void {
    this.chunks.push(data);
    this.totalBytes += Buffer.byteLength(data, 'utf8');

    while (this.totalBytes > this.maxBytes && this.chunks.length > 1) {
      const removed = this.chunks.shift();
      if (removed !== undefined) {
        this.totalBytes -= Buffer.byteLength(removed, 'utf8');
      }
    }
  }

  contents(): string {
    return this.chunks.join('');
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -w server`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add server/src/ringBuffer.ts server/test/ringBuffer.test.ts
git commit -m "feat: add RingBuffer for capped output replay"
```

---

## Task 3: SessionRegistry — createSession with cwd validation

**Files:**
- Create: `server/src/sessionRegistry.ts`
- Test: `server/test/sessionRegistry.test.ts`

**Interfaces:**
- Consumes: `RingBuffer` from Task 2 (`new RingBuffer(maxBytes: number)`).
- Produces: `interface Session { id: string; pty: IPty; outputBuffer: RingBuffer; killTimer: NodeJS.Timeout | null; socket: WebSocketLike | null }`, `interface SessionRegistryOptions { command: string; args: string[]; graceMs: number }`, `class SessionRegistry { constructor(options: SessionRegistryOptions); createSession(cwd: string): Session; has(sessionId: string): boolean; size(): number }`. Task 4 adds `attach`, `detach`, `write`, `resize` to this same class. Task 5 consumes `SessionRegistry` directly, including `size()` to enforce the single-active-session constraint.

- [ ] **Step 1: Write the failing tests**

Create `server/test/sessionRegistry.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionRegistry } from '../src/sessionRegistry.js';

describe('SessionRegistry.createSession', () => {
  let tmpDir: string | undefined;
  let registry: SessionRegistry;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects a working directory that does not exist', () => {
    registry = new SessionRegistry({ command: process.execPath, args: [], graceMs: 1000 });
    const missingDir = join(tmpdir(), 'ccwc-does-not-exist-xyz');
    expect(() => registry.createSession(missingDir)).toThrow(/does not exist/);
  });

  it('spawns a process and delivers its output through onData', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ccwc-'));
    registry = new SessionRegistry({
      command: process.execPath,
      args: ['-e', "process.stdout.write('hello-from-pty')"],
      graceMs: 1000,
    });

    const session = registry.createSession(tmpDir);
    const received: string[] = [];
    session.pty.onData((data) => received.push(data));

    await vi.waitFor(() => {
      expect(received.join('')).toContain('hello-from-pty');
    });
  });

  it('tracks the session as present until it exits', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ccwc-'));
    registry = new SessionRegistry({
      command: process.execPath,
      args: ['-e', "process.exit(0)"],
      graceMs: 1000,
    });

    const session = registry.createSession(tmpDir);
    expect(registry.has(session.id)).toBe(true);

    await vi.waitFor(() => {
      expect(registry.has(session.id)).toBe(false);
    });
  });

  it('reports size() as the count of tracked sessions', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ccwc-'));
    registry = new SessionRegistry({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 10000)'],
      graceMs: 1000,
    });

    expect(registry.size()).toBe(0);
    const session = registry.createSession(tmpDir);
    expect(registry.size()).toBe(1);
    session.pty.kill();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -w server`
Expected: FAIL with "Cannot find module '../src/sessionRegistry.js'"

- [ ] **Step 3: Implement `SessionRegistry.createSession`**

Create `server/src/sessionRegistry.ts`:

```ts
import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { RingBuffer } from './ringBuffer.js';

const OUTPUT_BUFFER_MAX_BYTES = 64 * 1024;

export interface WebSocketLike {
  send(data: string): void;
}

export interface Session {
  id: string;
  pty: IPty;
  outputBuffer: RingBuffer;
  killTimer: NodeJS.Timeout | null;
  socket: WebSocketLike | null;
}

export interface SessionRegistryOptions {
  command: string;
  args: string[];
  graceMs: number;
}

export class SessionRegistry {
  private sessions = new Map<string, Session>();

  constructor(private readonly options: SessionRegistryOptions) {}

  createSession(cwd: string): Session {
    if (!existsSync(cwd)) {
      throw new Error(`Working directory does not exist: ${cwd}`);
    }

    const shellPty = pty.spawn(this.options.command, this.options.args, {
      name: 'xterm-color',
      cols: 80,
      rows: 24,
      cwd,
      env: process.env as Record<string, string>,
    });

    const session: Session = {
      id: randomUUID(),
      pty: shellPty,
      outputBuffer: new RingBuffer(OUTPUT_BUFFER_MAX_BYTES),
      killTimer: null,
      socket: null,
    };

    shellPty.onData((data) => {
      session.outputBuffer.append(data);
      session.socket?.send(data);
    });

    shellPty.onExit(({ exitCode }) => {
      session.socket?.send(JSON.stringify({ type: 'exit', code: exitCode }));
      this.sessions.delete(session.id);
    });

    this.sessions.set(session.id, session);
    return session;
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  size(): number {
    return this.sessions.size;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -w server`
Expected: PASS (all tests in the file)

- [ ] **Step 5: Commit**

```bash
git add server/src/sessionRegistry.ts server/test/sessionRegistry.test.ts
git commit -m "feat: add SessionRegistry.createSession with cwd validation"
```

---

## Task 4: SessionRegistry — attach/detach, grace timer, buffer replay

**Files:**
- Modify: `server/src/sessionRegistry.ts`
- Modify: `server/test/sessionRegistry.test.ts`

**Interfaces:**
- Consumes: `Session`, `SessionRegistry` from Task 3.
- Produces: adds to `SessionRegistry`: `attach(sessionId: string, socket: WebSocketLike): Session | null`, `detach(sessionId: string): void`, `write(sessionId: string, data: string): void`, `resize(sessionId: string, cols: number, rows: number): void`. Task 5's `createApp.ts` calls all of these.

- [ ] **Step 1: Write the failing tests**

Append to `server/test/sessionRegistry.test.ts` (inside a new `describe` block, same file):

```ts
describe('SessionRegistry.attach/detach', () => {
  let tmpDir: string | undefined;
  let registry: SessionRegistry;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('kills the process after the grace period once detached and not reattached', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ccwc-'));
    registry = new SessionRegistry({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 10000)'],
      graceMs: 50,
    });

    const session = registry.createSession(tmpDir);
    const exited = vi.fn();
    session.pty.onExit(exited);

    registry.detach(session.id);

    await vi.waitFor(() => {
      expect(exited).toHaveBeenCalled();
    });
    expect(registry.has(session.id)).toBe(false);
  });

  it('cancels the kill timer and replays buffered output on attach', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ccwc-'));
    registry = new SessionRegistry({
      command: process.execPath,
      args: ['-e', "process.stdout.write('buffered-output'); setTimeout(() => {}, 10000)"],
      graceMs: 50,
    });

    const session = registry.createSession(tmpDir);
    await vi.waitFor(() => {
      expect(session.outputBuffer.contents()).toContain('buffered-output');
    });

    registry.detach(session.id);

    const received: string[] = [];
    const fakeSocket = { send: (data: string) => received.push(data) };
    const attached = registry.attach(session.id, fakeSocket);

    expect(attached).not.toBeNull();
    expect(received.join('')).toContain('buffered-output');

    // Wait past the original grace period to prove the timer was cancelled.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(registry.has(session.id)).toBe(true);

    session.pty.kill();
  });

  it('returns null when attaching to an unknown session id', () => {
    registry = new SessionRegistry({ command: process.execPath, args: [], graceMs: 1000 });
    const fakeSocket = { send: () => {} };
    expect(registry.attach('does-not-exist', fakeSocket)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -w server`
Expected: FAIL — `registry.detach is not a function`

- [ ] **Step 3: Implement `attach`, `detach`, `write`, `resize`**

Add to `server/src/sessionRegistry.ts`, inside the `SessionRegistry` class (after `has`):

```ts
  attach(sessionId: string, socket: WebSocketLike): Session | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    if (session.killTimer) {
      clearTimeout(session.killTimer);
      session.killTimer = null;
    }
    session.socket = socket;

    const buffered = session.outputBuffer.contents();
    if (buffered) {
      socket.send(buffered);
    }
    return session;
  }

  detach(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.socket = null;
    session.killTimer = setTimeout(() => {
      session.pty.kill();
      this.sessions.delete(sessionId);
    }, this.options.graceMs);
  }

  write(sessionId: string, data: string): void {
    this.sessions.get(sessionId)?.pty.write(data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.sessions.get(sessionId)?.pty.resize(cols, rows);
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -w server`
Expected: PASS (all tests in the file)

- [ ] **Step 5: Commit**

```bash
git add server/src/sessionRegistry.ts server/test/sessionRegistry.test.ts
git commit -m "feat: add session attach/detach with grace-period resume"
```

---

## Task 5: WebSocket protocol wiring (createApp + index.ts)

**Files:**
- Create: `server/src/createApp.ts`
- Modify: `server/src/index.ts`
- Test: `server/test/createApp.test.ts`

**Interfaces:**
- Consumes: `SessionRegistry`, `SessionRegistryOptions` from Tasks 3–4.
- Produces: `function createApp(options: { registryOptions: SessionRegistryOptions }): { server: http.Server; registry: SessionRegistry }`. This is the last server-side piece; `index.ts` is now just env-var wiring + `server.listen`.

- [ ] **Step 1: Write the failing tests**

Create `server/test/createApp.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/createApp.js';

function waitForMessage(socket: WebSocket): Promise<any> {
  return new Promise((resolve) => {
    socket.once('message', (raw) => {
      const text = raw.toString();
      try {
        resolve(JSON.parse(text));
      } catch {
        resolve(text);
      }
    });
  });
}

describe('createApp WebSocket protocol', () => {
  let server: ReturnType<typeof createApp>['server'];
  let tmpDir: string | undefined;

  afterEach(async () => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  it('starts a session, streams output, and reports exit', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ccwc-'));
    ({ server } = createApp({
      registryOptions: {
        command: process.execPath,
        args: ['-e', "process.stdout.write('hi'); process.exit(0)"],
        graceMs: 1000,
      },
    }));

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as any).port;

    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((resolve) => socket.once('open', resolve));

    socket.send(JSON.stringify({ type: 'start', cwd: tmpDir }));

    const started = await waitForMessage(socket);
    expect(started.type).toBe('started');
    expect(typeof started.sessionId).toBe('string');

    const output = await waitForMessage(socket);
    expect(output).toContain('hi');

    const exitMsg = await waitForMessage(socket);
    expect(exitMsg.type).toBe('exit');

    socket.close();
  });

  it('reports an error for a nonexistent working directory', async () => {
    ({ server } = createApp({
      registryOptions: { command: process.execPath, args: [], graceMs: 1000 },
    }));

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as any).port;

    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((resolve) => socket.once('open', resolve));

    socket.send(
      JSON.stringify({ type: 'start', cwd: join(tmpdir(), 'ccwc-does-not-exist-xyz') })
    );

    const errorMsg = await waitForMessage(socket);
    expect(errorMsg.type).toBe('error');

    socket.close();
  });

  it('rejects a second start while a session is already running', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ccwc-'));
    ({ server } = createApp({
      registryOptions: {
        command: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 10000)'],
        graceMs: 1000,
      },
    }));

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as any).port;

    const firstSocket = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((resolve) => firstSocket.once('open', resolve));
    firstSocket.send(JSON.stringify({ type: 'start', cwd: tmpDir }));
    await waitForMessage(firstSocket); // 'started'

    const secondSocket = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((resolve) => secondSocket.once('open', resolve));
    secondSocket.send(JSON.stringify({ type: 'start', cwd: tmpDir }));

    const reply = await waitForMessage(secondSocket);
    expect(reply.type).toBe('error');

    firstSocket.close();
    secondSocket.close();
  });

  it('replies not_found when attaching to an unknown session id', async () => {
    ({ server } = createApp({
      registryOptions: { command: process.execPath, args: [], graceMs: 1000 },
    }));

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as any).port;

    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((resolve) => socket.once('open', resolve));

    socket.send(JSON.stringify({ type: 'attach', sessionId: 'no-such-id' }));

    const reply = await waitForMessage(socket);
    expect(reply.type).toBe('not_found');

    socket.close();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -w server`
Expected: FAIL with "Cannot find module '../src/createApp.js'"

- [ ] **Step 3: Implement `createApp.ts`**

Create `server/src/createApp.ts`:

```ts
import express from 'express';
import { createServer, type Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { SessionRegistry, type SessionRegistryOptions } from './sessionRegistry.js';

export interface AppOptions {
  registryOptions: SessionRegistryOptions;
}

export interface App {
  server: Server;
  registry: SessionRegistry;
}

export function createApp(options: AppOptions): App {
  const app = express();
  app.get('/health', (_req, res) => res.json({ ok: true }));

  const server = createServer(app);
  const wss = new WebSocketServer({ server });
  const registry = new SessionRegistry(options.registryOptions);

  wss.on('connection', (socket: WebSocket) => {
    let boundSessionId: string | null = null;

    socket.on('message', (raw) => {
      let message: any;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (message.type === 'start') {
        if (registry.size() > 0) {
          socket.send(
            JSON.stringify({ type: 'error', message: 'A session is already running.' })
          );
          return;
        }
        try {
          const session = registry.createSession(message.cwd);
          session.socket = socket;
          boundSessionId = session.id;
          socket.send(JSON.stringify({ type: 'started', sessionId: session.id }));
        } catch (err) {
          socket.send(JSON.stringify({ type: 'error', message: (err as Error).message }));
        }
        return;
      }

      if (message.type === 'attach') {
        const session = registry.attach(message.sessionId, socket);
        if (!session) {
          socket.send(JSON.stringify({ type: 'not_found' }));
          return;
        }
        boundSessionId = session.id;
        return;
      }

      if (message.type === 'input' && boundSessionId) {
        registry.write(boundSessionId, message.data);
        return;
      }

      if (message.type === 'resize' && boundSessionId) {
        registry.resize(boundSessionId, message.cols, message.rows);
      }
    });

    socket.on('close', () => {
      if (boundSessionId) {
        registry.detach(boundSessionId);
      }
    });
  });

  return { server, registry };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -w server`
Expected: PASS (all tests in the file)

- [ ] **Step 5: Rewrite `index.ts` as thin env-var wiring**

Replace the contents of `server/src/index.ts`:

```ts
import { createApp } from './createApp.js';

const PORT = Number(process.env.PORT ?? 8787);
const GRACE_MS = Number(process.env.SESSION_GRACE_MS ?? 5 * 60 * 1000);
// npm installs the `claude` CLI as a .cmd shim on Windows; node-pty does not
// do shell PATH-extension resolution the way a shell would, so it must be
// named explicitly there.
const CLAUDE_COMMAND =
  process.env.CLAUDE_COMMAND ?? (process.platform === 'win32' ? 'claude.cmd' : 'claude');

const { server } = createApp({
  registryOptions: { command: CLAUDE_COMMAND, args: [], graceMs: GRACE_MS },
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Server listening on http://127.0.0.1:${PORT}`);
});
```

- [ ] **Step 6: Run the full server test suite**

Run: `npm run test -w server`
Expected: PASS (all tests across all files)

- [ ] **Step 7: Manually verify the real server + real `claude` end to end**

Run: `npm run dev -w server`
In another terminal, use a WebSocket CLI (e.g. `npx wscat -c ws://127.0.0.1:8787`) or a scratch Node script to send `{"type":"start","cwd":"C:\\Users\\andsy\\Documents\\Sandbox\\term"}` and confirm you receive a `started` message followed by real Claude Code CLI output. Stop the dev server (Ctrl+C).

- [ ] **Step 8: Commit**

```bash
git add server/src/createApp.ts server/src/index.ts server/test/createApp.test.ts
git commit -m "feat: wire WebSocket protocol (start/attach/input/resize) to SessionRegistry"
```

---

## Task 6: Client scaffold (Vite + React + TS + Tailwind + shadcn/ui + xterm)

**Files:**
- Create: `client/` (via `npm create vite@latest`)
- Modify: `client/tailwind.config.js`, `client/src/index.css`, `client/tsconfig.json`, `client/vite.config.ts` (path alias)
- Create: `client/components.json` (via shadcn init)

**Interfaces:**
- Produces: a Vite dev server serving a default React page at `http://localhost:5173`, with the `@/*` import alias resolving to `client/src/*`, Tailwind classes working, and `Button`/`Input` available at `@/components/ui/button` and `@/components/ui/input`. Later tasks add app-specific components under `client/src`.

- [ ] **Step 1: Scaffold the Vite React-TS project**

From repo root:
```bash
npm create vite@latest client -- --template react-ts
cd client
npm install
```

- [ ] **Step 2: Install Tailwind**

From `client/`:
```bash
npm install -D tailwindcss postcss autoprefixer
npx tailwindcss init -p
```

- [ ] **Step 3: Configure Tailwind content globs**

Edit `client/tailwind.config.js` so `content` is:
```js
content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
```

- [ ] **Step 4: Add Tailwind directives**

Replace the top of `client/src/index.css` with:
```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

- [ ] **Step 5: Configure the `@/*` path alias**

In `client/tsconfig.json` (or `client/tsconfig.app.json` if Vite generated a split config — add `baseUrl`/`paths` to whichever file holds `compilerOptions` for `src/`), add:
```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": { "@/*": ["./src/*"] }
  }
}
```

In `client/vite.config.ts`, add the matching resolver:
```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
});
```

- [ ] **Step 6: Initialize shadcn/ui and add the components we need**

From `client/`:
```bash
npx shadcn@latest init -d -y
npx shadcn@latest add button input -y
```
Confirm `client/src/components/ui/button.tsx` and `client/src/components/ui/input.tsx` now exist.

- [ ] **Step 7: Install xterm.js**

From `client/`:
```bash
npm install xterm xterm-addon-fit
```

- [ ] **Step 8: Manually verify the dev server**

From `client/`: `npm run dev`
Open `http://localhost:5173` in a browser. Expected: the default Vite+React starter page loads with Tailwind's base styles applied (no console errors).
Stop the dev server (Ctrl+C).

- [ ] **Step 9: Commit**

```bash
git add client
git commit -m "chore: scaffold Vite + React + Tailwind + shadcn/ui client"
```

---

## Task 7: Shared protocol types + localStorage helpers

**Files:**
- Create: `client/src/lib/protocol.ts`
- Create: `client/src/lib/storage.ts`

**Interfaces:**
- Produces: `type ClientMessage = { type: 'start'; cwd: string } | { type: 'attach'; sessionId: string } | { type: 'input'; data: string } | { type: 'resize'; cols: number; rows: number }`, `type ServerControlMessage = { type: 'started'; sessionId: string } | { type: 'not_found' } | { type: 'error'; message: string } | { type: 'exit'; code: number }`, and `getStoredSessionId/setStoredSessionId/clearStoredSessionId/getLastCwd/setLastCwd`. Consumed by Tasks 8–10.

- [ ] **Step 1: Create `client/src/lib/protocol.ts`**

```ts
export type ClientMessage =
  | { type: 'start'; cwd: string }
  | { type: 'attach'; sessionId: string }
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number };

export type ServerControlMessage =
  | { type: 'started'; sessionId: string }
  | { type: 'not_found' }
  | { type: 'error'; message: string }
  | { type: 'exit'; code: number };
```

- [ ] **Step 2: Create `client/src/lib/storage.ts`**

```ts
const SESSION_ID_KEY = 'ccwc:sessionId';
const LAST_CWD_KEY = 'ccwc:lastCwd';

export function getStoredSessionId(): string | null {
  return window.localStorage.getItem(SESSION_ID_KEY);
}

export function setStoredSessionId(sessionId: string): void {
  window.localStorage.setItem(SESSION_ID_KEY, sessionId);
}

export function clearStoredSessionId(): void {
  window.localStorage.removeItem(SESSION_ID_KEY);
}

export function getLastCwd(): string {
  return window.localStorage.getItem(LAST_CWD_KEY) ?? '';
}

export function setLastCwd(cwd: string): void {
  window.localStorage.setItem(LAST_CWD_KEY, cwd);
}
```

- [ ] **Step 3: Verify the project still builds**

From `client/`: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add client/src/lib/protocol.ts client/src/lib/storage.ts
git commit -m "feat: add shared WS protocol types and localStorage helpers"
```

---

## Task 8: SessionForm component

**Files:**
- Create: `client/src/components/SessionForm.tsx`
- Modify: `client/src/App.tsx` (temporary wiring for manual verification — Task 10 replaces this)

**Interfaces:**
- Consumes: `getLastCwd`, `setLastCwd` from Task 7; shadcn `Button`/`Input` from Task 6.
- Produces: `function SessionForm(props: { onStart: (cwd: string) => void; errorMessage: string | null }): JSX.Element`. Consumed by Task 10's `App.tsx`.

- [ ] **Step 1: Create `client/src/components/SessionForm.tsx`**

```tsx
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { getLastCwd, setLastCwd } from '@/lib/storage';

interface SessionFormProps {
  onStart: (cwd: string) => void;
  errorMessage: string | null;
}

export function SessionForm({ onStart, errorMessage }: SessionFormProps) {
  const [cwd, setCwd] = useState(() => getLastCwd());

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = cwd.trim();
    if (!trimmed) return;
    setLastCwd(trimmed);
    onStart(trimmed);
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3 max-w-md mx-auto mt-24">
      <label htmlFor="cwd" className="text-sm font-medium">
        Working directory
      </label>
      <Input
        id="cwd"
        value={cwd}
        onChange={(event) => setCwd(event.target.value)}
        placeholder="C:\path\to\project"
      />
      {errorMessage && <p className="text-sm text-red-600">{errorMessage}</p>}
      <Button type="submit">Start session</Button>
    </form>
  );
}
```

- [ ] **Step 2: Temporarily wire it into `App.tsx` to verify visually**

Replace the contents of `client/src/App.tsx`:

```tsx
import { SessionForm } from '@/components/SessionForm';

export function App() {
  return (
    <SessionForm
      errorMessage={null}
      onStart={(cwd) => console.log('start requested for', cwd)}
    />
  );
}
```

- [ ] **Step 3: Manually verify**

From `client/`: `npm run dev`. Open `http://localhost:5173`. Expected: a centered form with a "Working directory" label, a text input pre-filled with any previously saved value (empty on first run), and a "Start session" button. Type a path, click Start, and confirm the browser console logs `start requested for <path>`. Refresh the page and confirm the input is now pre-filled with that path (localStorage persistence).
Stop the dev server (Ctrl+C).

- [ ] **Step 4: Commit**

```bash
git add client/src/components/SessionForm.tsx client/src/App.tsx
git commit -m "feat: add SessionForm component"
```

---

## Task 9: useWebSocket hook + Terminal component

**Files:**
- Create: `client/src/hooks/useWebSocket.ts`
- Create: `client/src/components/Terminal.tsx`
- Modify: `client/src/App.tsx` (temporary wiring for manual verification — Task 10 replaces this)

**Interfaces:**
- Consumes: `ClientMessage`, `ServerControlMessage` from Task 7.
- Produces: `function useWebSocket(opts: { url: string; onControlMessage: (m: ServerControlMessage) => void; onRawOutput: (data: string) => void }): { status: 'idle' | 'connecting' | 'open' | 'closed'; connect: () => void; send: (m: ClientMessage) => void; close: () => void }` and `function Terminal(props: { wsUrl: string; sessionId: string | null; cwd: string | null; onStarted: (sessionId: string) => void; onExit: (code: number) => void; onNotFound: () => void }): JSX.Element`. Consumed by Task 10's `App.tsx`.

- [ ] **Step 1: Create `client/src/hooks/useWebSocket.ts`**

```ts
import { useCallback, useRef, useState } from 'react';
import type { ClientMessage, ServerControlMessage } from '@/lib/protocol';

export type ConnectionStatus = 'idle' | 'connecting' | 'open' | 'closed';

interface UseWebSocketOptions {
  url: string;
  onControlMessage: (message: ServerControlMessage) => void;
  onRawOutput: (data: string) => void;
}

export function useWebSocket({ url, onControlMessage, onRawOutput }: UseWebSocketOptions) {
  const socketRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>('idle');

  const connect = useCallback(() => {
    setStatus('connecting');
    const socket = new WebSocket(url);
    socketRef.current = socket;

    socket.onopen = () => setStatus('open');
    socket.onclose = () => setStatus('closed');
    socket.onmessage = (event) => {
      const raw = String(event.data);
      try {
        const parsed = JSON.parse(raw) as ServerControlMessage;
        if (parsed && typeof parsed.type === 'string') {
          onControlMessage(parsed);
          return;
        }
      } catch {
        // Not JSON: this is raw PTY output, handled below.
      }
      onRawOutput(raw);
    };
  }, [url, onControlMessage, onRawOutput]);

  const send = useCallback((message: ClientMessage) => {
    socketRef.current?.send(JSON.stringify(message));
  }, []);

  const close = useCallback(() => {
    socketRef.current?.close();
    socketRef.current = null;
  }, []);

  return { status, connect, send, close };
}
```

- [ ] **Step 2: Create `client/src/components/Terminal.tsx`**

```tsx
import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import 'xterm/css/xterm.css';
import { useWebSocket } from '@/hooks/useWebSocket';
import type { ServerControlMessage } from '@/lib/protocol';

interface TerminalProps {
  wsUrl: string;
  sessionId: string | null;
  cwd: string | null;
  onStarted: (sessionId: string) => void;
  onExit: (code: number) => void;
  onNotFound: () => void;
}

export function Terminal({ wsUrl, sessionId, cwd, onStarted, onExit, onNotFound }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  const handleControlMessage = (message: ServerControlMessage) => {
    if (message.type === 'started') onStarted(message.sessionId);
    if (message.type === 'not_found') onNotFound();
    if (message.type === 'exit') onExit(message.code);
    if (message.type === 'error') xtermRef.current?.writeln(`\r\n[error] ${message.message}`);
  };

  const handleRawOutput = (data: string) => {
    xtermRef.current?.write(data);
  };

  const { status, connect, send, close } = useWebSocket({
    url: wsUrl,
    onControlMessage: handleControlMessage,
    onRawOutput: handleRawOutput,
  });

  useEffect(() => {
    if (!containerRef.current) return;

    const xterm = new XTerm({ cursorBlink: true, convertEol: true });
    const fitAddon = new FitAddon();
    xterm.loadAddon(fitAddon);
    xterm.open(containerRef.current);
    fitAddon.fit();
    xtermRef.current = xterm;
    fitAddonRef.current = fitAddon;

    xterm.onData((data) => send({ type: 'input', data }));

    const handleResize = () => {
      fitAddon.fit();
      send({ type: 'resize', cols: xterm.cols, rows: xterm.rows });
    };
    window.addEventListener('resize', handleResize);
    connect();

    return () => {
      window.removeEventListener('resize', handleResize);
      close();
      xterm.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (status !== 'open') return;
    if (sessionId) {
      send({ type: 'attach', sessionId });
    } else if (cwd) {
      send({ type: 'start', cwd });
    }
    if (fitAddonRef.current && xtermRef.current) {
      fitAddonRef.current.fit();
      send({ type: 'resize', cols: xtermRef.current.cols, rows: xtermRef.current.rows });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  return <div ref={containerRef} className="h-screen w-screen p-2" />;
}
```

- [ ] **Step 3: Temporarily wire it into `App.tsx` to verify visually**

Replace the contents of `client/src/App.tsx`:

```tsx
import { Terminal } from '@/components/Terminal';

export function App() {
  return (
    <Terminal
      wsUrl="ws://localhost:8787"
      sessionId={null}
      cwd="."
      onStarted={(id) => console.log('started', id)}
      onExit={(code) => console.log('exit', code)}
      onNotFound={() => console.log('not found')}
    />
  );
}
```

- [ ] **Step 4: Manually verify against the real server**

Terminal 1: `npm run dev -w server`
Terminal 2: `npm run dev -w client`, open `http://localhost:5173`
Expected: a full-screen terminal appears and a real Claude Code session starts in the repo root (`.`), with visible output and the ability to type commands that Claude Code responds to. Trigger a permission-requiring action and confirm the interactive prompt renders and is answerable via keyboard. Stop both dev servers (Ctrl+C).

- [ ] **Step 5: Commit**

```bash
git add client/src/hooks/useWebSocket.ts client/src/components/Terminal.tsx client/src/App.tsx
git commit -m "feat: add useWebSocket hook and Terminal component"
```

---

## Task 10: App.tsx — full state machine with resume and exit handling

**Files:**
- Modify: `client/src/App.tsx`

**Interfaces:**
- Consumes: `SessionForm` (Task 8), `Terminal` (Task 9), `getStoredSessionId/setStoredSessionId/clearStoredSessionId` (Task 7), shadcn `Button` (Task 6).
- Produces: the final `App` component — no further tasks consume it.

- [ ] **Step 1: Replace `client/src/App.tsx` with the full state machine**

```tsx
import { useState } from 'react';
import { SessionForm } from '@/components/SessionForm';
import { Terminal } from '@/components/Terminal';
import { Button } from '@/components/ui/button';
import { getStoredSessionId, setStoredSessionId, clearStoredSessionId } from '@/lib/storage';

const WS_URL = import.meta.env.VITE_WS_URL ?? 'ws://localhost:8787';

type Phase =
  | { kind: 'idle'; errorMessage: string | null }
  | { kind: 'starting'; cwd: string }
  | { kind: 'attaching'; sessionId: string }
  | { kind: 'running'; sessionId: string }
  | { kind: 'exited'; code: number };

export function App() {
  const [phase, setPhase] = useState<Phase>(() => {
    const existing = getStoredSessionId();
    return existing
      ? { kind: 'attaching', sessionId: existing }
      : { kind: 'idle', errorMessage: null };
  });

  function handleStart(cwd: string) {
    setPhase({ kind: 'starting', cwd });
  }

  function handleStarted(sessionId: string) {
    setStoredSessionId(sessionId);
    setPhase({ kind: 'running', sessionId });
  }

  function handleExit(code: number) {
    clearStoredSessionId();
    setPhase({ kind: 'exited', code });
  }

  function handleNotFound() {
    clearStoredSessionId();
    setPhase({ kind: 'idle', errorMessage: 'Previous session is no longer available.' });
  }

  if (phase.kind === 'idle') {
    return <SessionForm onStart={handleStart} errorMessage={phase.errorMessage} />;
  }

  if (phase.kind === 'exited') {
    return (
      <div className="flex flex-col items-center gap-4 mt-24">
        <p>Session ended (exit code {phase.code}).</p>
        <Button onClick={() => setPhase({ kind: 'idle', errorMessage: null })}>
          Start a new session
        </Button>
      </div>
    );
  }

  const sessionId =
    phase.kind === 'attaching' || phase.kind === 'running' ? phase.sessionId : null;
  const cwd = phase.kind === 'starting' ? phase.cwd : null;

  return (
    <Terminal
      wsUrl={WS_URL}
      sessionId={sessionId}
      cwd={cwd}
      onStarted={handleStarted}
      onExit={handleExit}
      onNotFound={handleNotFound}
    />
  );
}
```

- [ ] **Step 2: Manually verify the new-session path**

Terminal 1: `npm run dev -w server`
Terminal 2: `npm run dev -w client`, open `http://localhost:5173`
Expected: the SessionForm appears first. Enter the repo path, click Start. Expected: the terminal appears and a real Claude Code session runs.

- [ ] **Step 3: Manually verify the resume path**

While the session from Step 2 is running, refresh the browser tab (within 5 minutes).
Expected: the page skips the form (since `localStorage` has a `sessionId`), goes straight to the terminal, and recent output is replayed before live streaming resumes — confirm by scrolling/checking that prior output is visible, not a blank terminal.

- [ ] **Step 4: Manually verify the exit path**

In the running terminal, exit Claude Code (e.g. `/exit` or Ctrl+D per its own interface).
Expected: the app shows "Session ended (exit code N)." with a "Start a new session" button; clicking it returns to the form.

- [ ] **Step 5: Manually verify the not-found path**

Set a short grace period for this check only: stop the server, restart it with `SESSION_GRACE_MS=2000 npm run dev -w server` (from repo root, or `cross-env`-style inline for your shell), start a session, close the browser tab, wait 5+ seconds, reopen `http://localhost:5173`.
Expected: the app attempts to attach, receives `not_found`, clears the stored session id, and shows the form with the message "Previous session is no longer available." Restart the server normally afterward (without the env var) once done.

- [ ] **Step 6: Commit**

```bash
git add client/src/App.tsx
git commit -m "feat: wire full session state machine with resume and exit handling"
```

---

## Task 11: Root dev script verification + usage notes

**Files:**
- Modify: `README.md` (create if absent)

**Interfaces:**
- None — this task only verifies the root `npm run dev` script created in Task 1 actually boots both workspaces together, and documents usage.

- [ ] **Step 1: Create `README.md` at repo root**

```markdown
# Claude Code Web Controller

Local web UI that starts and controls a real Claude Code CLI session through
a browser terminal.

## Run

    npm install
    npm run dev

This starts the server (`http://127.0.0.1:8787`) and the client
(`http://localhost:5173`) together. Open the client URL, enter a working
directory, and click Start.

## Environment variables (server)

- `PORT` - server port (default 8787)
- `SESSION_GRACE_MS` - how long a session survives after a dropped
  connection before being killed (default 300000 = 5 minutes)
- `CLAUDE_COMMAND` - override the Claude Code CLI command (default `claude`,
  or `claude.cmd` on Windows)
```

- [ ] **Step 2: Verify the combined dev script**

From repo root: `npm run dev`
Expected: both the server and client start, with labeled (`server`/`client`) interleaved log output from `concurrently`. Open `http://localhost:5173` and confirm a full session start → interact → exit cycle works as in Task 10's manual checks. Stop with Ctrl+C (should stop both processes).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: add usage README"
```
