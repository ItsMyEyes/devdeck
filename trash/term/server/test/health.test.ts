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
