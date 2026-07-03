import { describe, it, expect, afterEach } from 'vitest';
import { vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionRegistry } from '../src/sessionRegistry.js';

// On Windows, node-pty's ConPTY backend can hold a brief handle on a
// process's cwd even after the tracked child is confirmed killed/exited
// (pseudoconsole/conhost teardown races the fs call). Retry to absorb that
// OS-level timing race instead of flaking the whole suite.
async function cleanupTmpDir(dir: string): Promise<void> {
  const attempts = 5;
  for (let i = 0; i < attempts; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (i === attempts - 1) throw err;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

describe('SessionRegistry.createSession', () => {
  let tmpDir: string | undefined;
  let registry: SessionRegistry;

  afterEach(async () => {
    if (tmpDir) await cleanupTmpDir(tmpDir);
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

    await vi.waitFor(
      () => {
        expect(registry.has(session.id)).toBe(false);
      },
      { timeout: 3000 }
    );
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

describe('SessionRegistry.attach/detach', () => {
  let tmpDir: string | undefined;
  let registry: SessionRegistry;

  afterEach(async () => {
    if (tmpDir) await cleanupTmpDir(tmpDir);
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
