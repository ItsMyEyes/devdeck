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
}
