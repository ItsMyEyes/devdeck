import type { BrowserProxyInfo } from '@/store/useDevDeckStore'
import type { Machine } from '@/store/types'

export type ProxyResolution = { ok: true; proxy: BrowserProxyInfo } | { ok: false; error: string }

/** Resolves (starting if needed) the forward proxy for a machine, without
 *  throwing — `BrowserTile`'s navigate()/selectMachine()/openBookmark() all
 *  call this via `void`, so an unhandled rejection here would silently
 *  strand the tile with no feedback (see the 2026-07-31
 *  browser-tile-bugfixes design spec, bug #1). Every failure path returns
 *  `{ ok: false, error }` instead of throwing. */
export async function resolveProxyForMachine(
  machineId: string,
  machines: Machine[],
  startProxy: (machine: Machine) => Promise<BrowserProxyInfo>,
): Promise<ProxyResolution> {
  const machine = machines.find((m) => m.id === machineId)
  if (!machine) return { ok: false, error: 'Machine not found' }
  try {
    const proxy = await startProxy(machine)
    return { ok: true, proxy }
  } catch (err) {
    return {
      ok: false,
      error: `Could not start browser proxy on ${machine.name}: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
