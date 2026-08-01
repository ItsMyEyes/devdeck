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
})

describe('createLspSessionPool', () => {
  let next = 0
  function fakeSession() {
    next += 1
    return { id: `session-${next}`, dispose: vi.fn() } as unknown as import('./lspSession').LspSession
  }

  it('shares one session between holders and disposes only on the last release', async () => {
    const create = vi.fn(async () => fakeSession())
    const pool = createLspSessionPool()

    const first = await pool.acquire('m1:w1:go', create)
    const second = await pool.acquire('m1:w1:go', create)

    expect(create).toHaveBeenCalledTimes(1)
    expect(first.session).toBe(second.session)

    first.release()
    expect(first.session.dispose).not.toHaveBeenCalled()

    second.release()
    expect(first.session.dispose).toHaveBeenCalledTimes(1)
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

  it('keeps separate sessions per key and recreates after full release', async () => {
    const create = vi.fn(async () => fakeSession())
    const pool = createLspSessionPool()

    const go = await pool.acquire('m1:w1:go', create)
    const ts = await pool.acquire('m1:w1:typescript', create)
    expect(go.session).not.toBe(ts.session)

    go.release()
    const goAgain = await pool.acquire('m1:w1:go', create)
    expect(create).toHaveBeenCalledTimes(3)
    expect(goAgain.session).not.toBe(go.session)
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
