/**
 * Plan T13 — the remote-file `@` mention source for SSH threads.
 * `sshMentionSource` is the SSH-side counterpart to `worktreeMentionSource`:
 * same `MentionSource` shape, but it queries
 * `GET /api/ssh/connections/{id}/files/search?pattern=` directly (a plain
 * `fetch`, not `machineRequest`/`request` — SSH threads have no machine to
 * resolve against) and returns the paths **verbatim**. Design spec D7: a
 * mention inserts the path only, so there is nothing here to normalize or
 * enrich — the round-trip from stub response to `search()`'s return value is
 * the whole contract under test.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { sshMentionSource } from '@/features/agent-chat/composerMention'

describe('sshMentionSource', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ['/home/clouduser/deployment-web-internal.yml'],
      })),
    )
  })

  it('queries the SSH file search route and returns paths unchanged', async () => {
    const paths = await sshMentionSource('c-1').search('deploy')
    expect(paths).toEqual(['/home/clouduser/deployment-web-internal.yml'])
    const url = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string
    expect(url).toContain('/api/ssh/connections/c-1/files/search')
    expect(url).toContain('pattern=deploy')
  })
})
