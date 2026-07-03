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
