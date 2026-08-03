import { useEffect, useState } from 'react'

/**
 * Runs an async parse over downloaded bytes and exposes it as a
 * loading/ready/error triple.
 *
 * Every document parser here is async (inflating zip entries goes through
 * `DecompressionStream`), so this cannot be a `useMemo`. It also cannot be a
 * react-query query without inventing a cache key for a byte array — and the
 * bytes are already cached one layer up by `useFileBytesTarget`, so caching
 * the parse too would only pin two copies of a large document in memory.
 *
 * `release` handles parsers that hand out object URLs (docx/pptx images): it
 * runs when the bytes change and on unmount, so switching tabs does not leak
 * every image the previous document embedded.
 */
export interface AsyncParseState<T> {
  status: 'loading' | 'ready' | 'error'
  data?: T
  error?: string
}

export function useAsyncParse<T>(
  bytes: Uint8Array | undefined,
  parse: (bytes: Uint8Array) => Promise<T>,
  release?: (value: T) => void,
): AsyncParseState<T> {
  const [state, setState] = useState<AsyncParseState<T>>({ status: 'loading' })

  useEffect(() => {
    if (!bytes) {
      setState({ status: 'loading' })
      return
    }

    let cancelled = false
    let parsed: T | undefined
    setState({ status: 'loading' })

    parse(bytes)
      .then((value) => {
        parsed = value
        // Losing the race means this document is already off-screen; release
        // immediately rather than waiting for a cleanup that already ran.
        if (cancelled) {
          release?.(value)
          return
        }
        setState({ status: 'ready', data: value })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setState({
          status: 'error',
          error: error instanceof Error ? error.message : 'Could not read this document',
        })
      })

    return () => {
      cancelled = true
      if (parsed !== undefined) release?.(parsed)
    }
    // `parse` and `release` are defined at module scope by every caller, so
    // the bytes are the only real dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bytes])

  return state
}
