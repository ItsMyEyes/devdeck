import type { DBEngine } from '@/store/types'
import { DB_ENGINE_COLOR } from './dbColors'

/** Small colored badge identifying a connection's engine — shared between
 *  the connection gallery card and the connection dialog's drawer header. A
 *  standalone file (not inlined in DatabaseModule.tsx) specifically so
 *  DBConnectionDialog can import it without creating a circular import
 *  (DatabaseModule already imports DBConnectionDialog). */
export function EngineGlyph({ engine, size = 32 }: { engine: DBEngine; size?: number }) {
  const label = engine === 'postgres' ? 'PG' : engine === 'mysql' ? 'My' : 'lite'
  const color = DB_ENGINE_COLOR[engine]
  return (
    <span
      className="flex flex-none items-center justify-center rounded-[10px] border font-mono text-[10px] font-semibold"
      style={{ width: size, height: size, color, background: `${color}18`, borderColor: `${color}44` }}
    >
      {label}
    </span>
  )
}
