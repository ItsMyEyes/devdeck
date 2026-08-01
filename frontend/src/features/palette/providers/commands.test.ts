import { describe, expect, it } from 'vitest'
import { matchVerb, sshCommandPreview, verbHintItems } from '@/features/palette/providers/commands'

describe('matchVerb', () => {
  it('returns null for a bare verb with no argument', () => {
    expect(matchVerb('ssh')).toBeNull()
  })

  it('returns null for a verb followed only by whitespace', () => {
    expect(matchVerb('ssh   ')).toBeNull()
  })

  it('matches a verb with an argument', () => {
    expect(matchVerb('ssh root@10.1.1.4')).toEqual({
      verb: expect.objectContaining({ name: 'ssh' }),
      arg: 'root@10.1.1.4',
    })
  })

  it('resolves the agents-new alias to agent-new', () => {
    expect(matchVerb('agents-new acme/api')?.verb.name).toBe('agent-new')
  })

  it('resolves the open alias to browser', () => {
    expect(matchVerb('open github.com')?.verb.name).toBe('browser')
  })

  it('returns null for an unknown leading word', () => {
    expect(matchVerb('deploy everything')).toBeNull()
  })

  it('is case-insensitive on the verb but preserves argument casing', () => {
    expect(matchVerb('SSH Root@Host')).toEqual({
      verb: expect.objectContaining({ name: 'ssh' }),
      arg: 'Root@Host',
    })
  })
})

describe('verbHintItems', () => {
  it('offers the ssh template while the verb name is being typed', () => {
    expect(verbHintItems('ss').map((i) => i.title)).toContain('ssh <ssh command | host>')
  })

  it('offers a completion string so ghost text can render', () => {
    expect(verbHintItems('ag')[0].completion).toBe('agent-new ')
  })

  it('offers nothing for an empty query', () => {
    expect(verbHintItems('')).toEqual([])
  })

  it('offers nothing once an argument has been typed', () => {
    expect(verbHintItems('ssh root@host')).toEqual([])
  })

  it('offers nothing for a word matching no verb', () => {
    expect(verbHintItems('zzz')).toEqual([])
  })
})

describe('sshCommandPreview', () => {
  it('summarises target and jump chain', () => {
    const preview = sshCommandPreview('root@10.10.10.5 -J root@10.10.1.1')
    expect(preview?.summary).toContain('root@10.10.10.5:22')
    expect(preview?.summary).toContain('root@10.10.1.1')
  })

  it('reports unknown flags as ignored rather than failing', () => {
    const preview = sshCommandPreview('root@10.10.10.5 -X -Q cipher')
    expect(preview).not.toBeNull()
    expect(preview?.ignored.length).toBeGreaterThan(0)
  })

  it('returns null for an unparseable argument', () => {
    // `parseSSHCommand` only returns null when there is no destination token
    // at all (see sshCommand.test.ts's own null case, `'ssh -p 22'`) — any
    // bare token, however garbled, is accepted as a hostname. `'!!!'` would
    // therefore not exercise this path; flags-only input does.
    expect(sshCommandPreview('-p 22')).toBeNull()
  })
})
