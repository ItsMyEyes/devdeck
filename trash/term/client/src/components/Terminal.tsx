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
