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

// On Windows, node-pty's ConPTY backend emits its own terminal-negotiation
// escape sequences (e.g. "[?9001h[?1004h") as the *first* onData
// chunk, with the child process's actual output following in a later chunk.
// Accumulate raw (non-JSON) messages until the expected text shows up instead
// of assuming it's in the very next single message.
function waitForRawOutputContaining(socket: WebSocket, needle: string): Promise<string> {
  return new Promise((resolve) => {
    let acc = '';
    const onMessage = (raw: unknown) => {
      acc += (raw as { toString(): string }).toString();
      if (acc.includes(needle)) {
        socket.off('message', onMessage);
        resolve(acc);
      }
    };
    socket.on('message', onMessage);
  });
}

// Same ConPTY-cwd-handle race documented in sessionRegistry.test.ts: the
// pseudoconsole/conhost teardown can briefly hold the working directory open
// even after the tracked child has exited, so rmSync right away can EPERM.
// Here it's compounded by the socket-close -> detach() grace timer (up to the
// test's own graceMs, e.g. 1000ms) delaying the actual pty.kill(), so the
// retry budget must comfortably exceed that grace period.
async function cleanupTmpDir(dir: string): Promise<void> {
  const attempts = 20;
  for (let i = 0; i < attempts; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (i === attempts - 1) throw err;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
}

describe('createApp WebSocket protocol', () => {
  let server: ReturnType<typeof createApp>['server'];
  let tmpDir: string | undefined;

  afterEach(async () => {
    if (tmpDir) await cleanupTmpDir(tmpDir);
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

    const output = await waitForRawOutputContaining(socket, 'hi');
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
