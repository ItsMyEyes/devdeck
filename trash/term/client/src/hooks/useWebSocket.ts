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
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify(message));
    }
  }, []);

  const close = useCallback(() => {
    socketRef.current?.close();
    socketRef.current = null;
  }, []);

  return { status, connect, send, close };
}
