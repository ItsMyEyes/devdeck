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
