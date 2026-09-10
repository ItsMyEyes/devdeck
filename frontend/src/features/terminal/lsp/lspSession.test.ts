import { describe, expect, it, vi } from 'vitest'
import { createLspSessionPool, languageIdForPath, uriHelpers } from './lspSession'

describe('languageIdForPath', () => {
  it('maps known extensions and rejects the rest', () => {
    expect(languageIdForPath('main.go')).toBe('go')
    expect(languageIdForPath('src/App.tsx')).toBe('typescriptreact')
    expect(languageIdForPath('src/util.mjs')).toBe('javascript')
    expect(languageIdForPath('script.py')).toBe('python')
    expect(languageIdForPath('README.md')).toBeNull()
    expect(languageIdForPath('Makefile')).toBeNull()
  })
})

describe('uriHelpers', () => {
  const { documentUri, pathFromUri } = uriHelpers('file:///work/repo')

  it('round-trips a nested path', () => {
    const uri = documentUri('src/features/App.tsx')
    expect(uri).toBe('file:///work/repo/src/features/App.tsx')
    expect(pathFromUri(uri)).toBe('src/features/App.tsx')
  })

  it('round-trips a path with characters that need encoding', () => {
    const uri = documentUri('src/my file (copy).go')
    expect(uri).toBe('file:///work/repo/src/my%20file%20(copy).go')
    expect(pathFromUri(uri)).toBe('src/my file (copy).go')
  })

  it('returns null for uris outside the worktree root', () => {
    expect(pathFromUri('file:///usr/local/go/src/fmt/print.go')).toBeNull()
    expect(pathFromUri('file:///work/repo-other/main.go')).toBeNull()
    expect(pathFromUri('not a uri')).toBeNull()
  })

  // A language server canonicalises the Windows drive letter in every uri it
  // emits — gopls to UPPERcase, vscode-uri-based servers (typescript-language-
  // server, pyright) to lowercase — while the rootUri carries whatever case
  // the worktree path was stored with. Neither case is "right", so both
  // directions have to resolve; before this, the plain string-prefix match
  // rejected the mismatching one outright and clicking a cross-file
  // definition/references result silently did nothing.
  it('matches the worktree root regardless of Windows drive-letter case', () => {
    const windows = uriHelpers('file:///c:/Users/andsy/superapps')
    expect(windows.pathFromUri('file:///C:/Users/andsy/superapps/internal/usecase.go')).toBe(
      'internal/usecase.go',
    )

    const windowsUpper = uriHelpers('file:///C:/Users/andsy/superapps')
    expect(windowsUpper.pathFromUri('file:///c:/Users/andsy/superapps/internal/webhook_usecase.go')).toBe(
      'internal/webhook_usecase.go',
    )
  })
})

describe('createLspSessionPool', () => {
  let next = 0
  function fakeSession(status: import('./lspSession').LspStatus = 'ready') {
    next += 1
    return {
      id: `session-${next}`,
      dispose: vi.fn(),
      getStatus: () => status,
    } as unknown as import('./lspSession').LspSession
  }

  it('shares one session between holders and disposes only after the last release', async () => {
    vi.useFakeTimers()
    try {
      const create = vi.fn(async () => fakeSession())
      const pool = createLspSessionPool(30_000)

      const first = await pool.acquire('m1:w1:go', create)
      const second = await pool.acquire('m1:w1:go', create)

      expect(create).toHaveBeenCalledTimes(1)
      expect(first.session).toBe(second.session)

      first.release()
      vi.advanceTimersByTime(60_000)
      expect(first.session.dispose).not.toHaveBeenCalled()

      second.release()
      vi.advanceTimersByTime(30_000)
      expect(first.session.dispose).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores a repeated release from the same holder', async () => {
    const create = vi.fn(async () => fakeSession())
    const pool = createLspSessionPool()

    const first = await pool.acquire('m1:w1:go', create)
    const second = await pool.acquire('m1:w1:go', create)

    first.release()
    first.release()

    expect(second.session.dispose).not.toHaveBeenCalled()
  })

  it('keeps separate sessions per key and recreates once the idle window passes', async () => {
    vi.useFakeTimers()
    try {
      const create = vi.fn(async () => fakeSession())
      const pool = createLspSessionPool(30_000)

      const go = await pool.acquire('m1:w1:go', create)
      const ts = await pool.acquire('m1:w1:typescript', create)
      expect(go.session).not.toBe(ts.session)

      go.release()
      vi.advanceTimersByTime(30_000)
      const goAgain = await pool.acquire('m1:w1:go', create)
      expect(create).toHaveBeenCalledTimes(3)
      expect(goAgain.session).not.toBe(go.session)
    } finally {
      vi.useRealTimers()
    }
  })

  // Disposing the moment the last Go file closes is what made "open a .go
  // file, close it, open another" break every LSP feature: the session's
  // transport shuts down, but `MonacoLspClient` cannot be disposed — its
  // monaco providers stay registered and monaco keeps awaiting them. Holding
  // the session across that gap means the reopen reuses the same client (and
  // skips a gopls restart) instead of stacking a second one on top of a dead
  // first.
  it('reuses the session when a file is reopened inside the idle window', async () => {
    vi.useFakeTimers()
    try {
      const create = vi.fn(async () => fakeSession())
      const pool = createLspSessionPool(30_000)

      const first = await pool.acquire('m1:w1:go', create)
      first.release()
      vi.advanceTimersByTime(29_000)
      const again = await pool.acquire('m1:w1:go', create)

      expect(create).toHaveBeenCalledTimes(1)
      expect(again.session).toBe(first.session)
      expect(first.session.dispose).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('disposes a session that stays idle past the window', async () => {
    vi.useFakeTimers()
    try {
      const create = vi.fn(async () => fakeSession())
      const pool = createLspSessionPool(30_000)

      const first = await pool.acquire('m1:w1:go', create)
      first.release()
      expect(first.session.dispose).not.toHaveBeenCalled()

      vi.advanceTimersByTime(30_000)
      expect(first.session.dispose).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('re-acquiring inside the window cancels the pending disposal', async () => {
    vi.useFakeTimers()
    try {
      const create = vi.fn(async () => fakeSession())
      const pool = createLspSessionPool(30_000)

      const first = await pool.acquire('m1:w1:go', create)
      first.release()
      await pool.acquire('m1:w1:go', create)
      vi.advanceTimersByTime(60_000)

      expect(first.session.dispose).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  // A cached session is only worth reusing while its server is actually
  // answering. One whose socket died while idle would otherwise be handed back
  // to the next file that opens, with no way to recover short of a reload.
  it('replaces a cached session whose language server died', async () => {
    vi.useFakeTimers()
    try {
      const create = vi
        .fn<() => Promise<import('./lspSession').LspSession>>()
        .mockImplementationOnce(async () => fakeSession('error'))
        .mockImplementation(async () => fakeSession())
      const pool = createLspSessionPool(30_000)

      const first = await pool.acquire('m1:w1:go', create)
      first.release()
      const again = await pool.acquire('m1:w1:go', create)

      expect(create).toHaveBeenCalledTimes(2)
      expect(again.session).not.toBe(first.session)
      expect(first.session.dispose).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  // The refcount is no reason to keep a dead session: `FileEditor` keeps every
  // open tab mounted, so a single open `.go` file holds `refs` above zero for
  // as long as it is on screen. Requiring an idle entry meant the replacement
  // above almost never ran — the second, third and fourth Go file opened after
  // a server died all got the same dead session. An errored session's transport
  // is already unusable, so there is nothing live to pull out from under the
  // holders.
  it('replaces an errored session even while editors still hold it', async () => {
    const create = vi
      .fn<() => Promise<import('./lspSession').LspSession>>()
      .mockImplementationOnce(async () => fakeSession('error'))
      .mockImplementation(async () => fakeSession())
    const pool = createLspSessionPool(30_000)

    const held = await pool.acquire('m1:w1:go', create)
    const second = await pool.acquire('m1:w1:go', create)

    expect(create).toHaveBeenCalledTimes(2)
    expect(second.session).not.toBe(held.session)
    expect(held.session.dispose).toHaveBeenCalledTimes(1)
  })

  // The stale holder's release must not reach into the entry that replaced it —
  // decrementing a live session's refcount on someone else's behalf would set it
  // up to be disposed while its own editors are still using it.
  it('ignores a release from a holder whose session was already replaced', async () => {
    vi.useFakeTimers()
    try {
      const create = vi
        .fn<() => Promise<import('./lspSession').LspSession>>()
        .mockImplementationOnce(async () => fakeSession('error'))
        .mockImplementation(async () => fakeSession())
      const pool = createLspSessionPool(30_000)

      const held = await pool.acquire('m1:w1:go', create)
      const fresh = await pool.acquire('m1:w1:go', create)

      held.release()
      vi.advanceTimersByTime(60_000)

      expect(fresh.session.dispose).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not cache a failed session', async () => {
    const create = vi
      .fn<() => Promise<import('./lspSession').LspSession>>()
      .mockRejectedValueOnce(new Error('gopls is not installed'))
      .mockImplementation(async () => fakeSession())
    const pool = createLspSessionPool()

    await expect(pool.acquire('m1:w1:go', create)).rejects.toThrow('gopls is not installed')

    const retry = await pool.acquire('m1:w1:go', create)
    expect(retry.session).toBeDefined()
    expect(create).toHaveBeenCalledTimes(2)
  })
})
