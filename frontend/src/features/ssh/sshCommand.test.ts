import { describe, expect, it } from 'vitest'
import { parseSSHCommand } from './sshCommand'

describe('parseSSHCommand', () => {
  it('parses the spec example: destination first, -J after it', () => {
    const parsed = parseSSHCommand('ssh root@10.1.1.1 -J root@2131')
    expect(parsed?.target).toEqual({ user: 'root', host: '10.1.1.1', port: 22 })
    expect(parsed?.jumps).toEqual([{ user: 'root', host: '2131', port: 22 }])
    expect(parsed?.identityFile).toBe(null)
    expect(parsed?.ignoredFlags).toEqual([])
  })

  it('parses a bare user@host with no ssh prefix', () => {
    const parsed = parseSSHCommand('deploy@web.example.com')
    expect(parsed?.target).toEqual({ user: 'deploy', host: 'web.example.com', port: 22 })
    expect(parsed?.jumps).toEqual([])
  })

  it('a destination with no user parses with an empty user', () => {
    const parsed = parseSSHCommand('ssh myhost')
    expect(parsed?.target).toEqual({ user: '', host: 'myhost', port: 22 })
  })

  it('reads -p and -l in both attached and detached spellings', () => {
    expect(parseSSHCommand('ssh -p 2222 host')?.target.port).toBe(2222)
    expect(parseSSHCommand('ssh -p2222 host')?.target.port).toBe(2222)
    expect(parseSSHCommand('ssh -l deploy host')?.target.user).toBe('deploy')
    expect(parseSSHCommand('ssh -ldeploy host')?.target.user).toBe('deploy')
  })

  it('a user@ in the destination beats -l', () => {
    expect(parseSSHCommand('ssh -l ignored root@host')?.target.user).toBe('root')
  })

  it('accepts host:port in the destination, but -p overrides it', () => {
    expect(parseSSHCommand('ssh root@host:2200')?.target.port).toBe(2200)
    expect(parseSSHCommand('ssh -p 22 root@host:2200')?.target.port).toBe(22)
  })

  it('reads -i, including a quoted path with spaces', () => {
    expect(parseSSHCommand('ssh -i ~/.ssh/id_ed25519 root@host')?.identityFile).toBe('~/.ssh/id_ed25519')
    expect(parseSSHCommand('ssh -i "/keys/my key.pem" root@host')?.identityFile).toBe('/keys/my key.pem')
  })

  it('reads a multi-hop comma-separated -J, nearest hop first', () => {
    const parsed = parseSSHCommand('ssh root@target -J a@first:2222,b@second')
    expect(parsed?.jumps).toEqual([
      { user: 'a', host: 'first', port: 2222 },
      { user: 'b', host: 'second', port: 22 },
    ])
  })

  it('a jump hop with no user inherits the target user', () => {
    expect(parseSSHCommand('ssh root@target -J bastion')?.jumps).toEqual([{ user: 'root', host: 'bastion', port: 22 }])
  })

  it('-o consumes its value so it is never mistaken for the destination', () => {
    const parsed = parseSSHCommand('ssh -o StrictHostKeyChecking=no root@host')
    expect(parsed?.target.host).toBe('host')
    expect(parsed?.ignoredFlags).toEqual(['-o'])
  })

  it('unknown valueless flags are recorded once each, deduped', () => {
    const parsed = parseSSHCommand('ssh -A -t -t --config root@host')
    expect(parsed?.target.host).toBe('host')
    expect(parsed?.ignoredFlags).toEqual(['-A', '-t', '--config'])
  })

  it('a remote command after the destination is ignored entirely', () => {
    const parsed = parseSSHCommand('ssh root@host tail -f /var/log/syslog')
    expect(parsed?.target.host).toBe('host')
    expect(parsed?.ignoredFlags).toEqual([])
  })

  it('a multi-colon host is taken verbatim with no port split', () => {
    expect(parseSSHCommand('ssh root@::1')?.target).toEqual({ user: 'root', host: '::1', port: 22 })
  })

  it('returns null when there is no destination', () => {
    expect(parseSSHCommand('ssh -p 22')).toBe(null)
    expect(parseSSHCommand('   ')).toBe(null)
  })

  it('a bare "-" token is recorded verbatim, not as "-undefined"', () => {
    const parsed = parseSSHCommand('ssh - root@host')
    expect(parsed?.target).toEqual({ user: 'root', host: 'host', port: 22 })
    expect(parsed?.ignoredFlags).toEqual(['-'])
  })
})
