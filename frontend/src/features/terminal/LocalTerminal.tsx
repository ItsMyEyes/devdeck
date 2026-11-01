import { useEffect, useState } from 'react'
import { getLocalRuntime } from '@/features/desktop/desktopBridge'
import { Terminal } from '@/features/terminal/Terminal'
import type { Machine } from '@/store/types'

export function LocalTerminal({ session, onExit }: { session: string; onExit: () => void }) {
  const [machine, setMachine] = useState<Machine | null>(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let cancelled = false
    setError('')
    getLocalRuntime().then(({ url, key }) => {
      if (!cancelled) setMachine({ id: 'desktop-local', name: 'Local', url, key, isLocal: true, signingPublicKey: '' })
    }).catch(() => {
      if (!cancelled) setError('Local runtime is unavailable. Check the desktop runtime and try again.')
    })
    return () => { cancelled = true }
  }, [attempt])
  if (error) return <div role="alert" className="p-4 text-sm text-devdeck-fg">{error} <button type="button" className="underline" onClick={() => setAttempt((n) => n + 1)}>Retry</button></div>
  if (!machine) return <div className="p-4 text-sm text-devdeck-fg-2">Connecting to local runtime…</div>
  return <Terminal session={session} machine={machine} directLocal onExit={onExit} />
}
