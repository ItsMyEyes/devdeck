import { describe, expect, it } from 'vitest'
import { buildJumpHostRequest, defaultJumpHostDraft, isJumpHostDraftValid, type JumpHostDraft } from './jumpHostDraft'

function passwordDraft(overrides: Partial<JumpHostDraft> = {}): JumpHostDraft {
  return { ...defaultJumpHostDraft(), host: 'bastion.example.com', username: 'deploy', password: 'hunter2', ...overrides }
}

describe('jumpHostDraft', () => {
  it('defaultJumpHostDraft starts on port 22, password auth, everything else blank', () => {
    expect(defaultJumpHostDraft()).toEqual({
      host: '',
      port: '22',
      username: '',
      authType: 'password',
      password: '',
      privateKey: '',
      privateKeyPath: '',
      passphrase: '',
    })
  })

  it('a fully filled-in password draft is valid', () => {
    expect(isJumpHostDraftValid(passwordDraft())).toBe(true)
  })

  it('blank host is invalid', () => {
    expect(isJumpHostDraftValid(passwordDraft({ host: '  ' }))).toBe(false)
  })

  it('blank username is invalid', () => {
    expect(isJumpHostDraftValid(passwordDraft({ username: '' }))).toBe(false)
  })

  it('port 0 is invalid', () => {
    expect(isJumpHostDraftValid(passwordDraft({ port: '0' }))).toBe(false)
  })

  it('port 65536 is invalid', () => {
    expect(isJumpHostDraftValid(passwordDraft({ port: '65536' }))).toBe(false)
  })

  it('non-numeric port is invalid', () => {
    expect(isJumpHostDraftValid(passwordDraft({ port: 'abc' }))).toBe(false)
  })

  it('password auth with an empty password is invalid', () => {
    expect(isJumpHostDraftValid(passwordDraft({ password: '' }))).toBe(false)
  })

  it('privatekey auth with neither key nor path is invalid', () => {
    expect(isJumpHostDraftValid(passwordDraft({ authType: 'privatekey', password: '' }))).toBe(false)
  })

  it('privatekey auth with a pasted key is valid', () => {
    expect(isJumpHostDraftValid(passwordDraft({ authType: 'privatekey', password: '', privateKey: '-----BEGIN...' }))).toBe(true)
  })

  it('privatekey auth with only a path is valid', () => {
    expect(
      isJumpHostDraftValid(passwordDraft({ authType: 'privatekey', password: '', privateKeyPath: '~/.ssh/id_ed25519' })),
    ).toBe(true)
  })

  it('buildJumpHostRequest names the connection after the trimmed host, ungrouped, single hop', () => {
    const body = buildJumpHostRequest(passwordDraft({ host: '  bastion.example.com  ', port: '2222' }))
    expect(body.name).toBe('bastion.example.com')
    expect(body.host).toBe('bastion.example.com')
    expect(body.group).toBe('')
    expect(body.port).toBe(2222)
    expect(body.executorMachineId).toBe(null)
    expect(body.jumpConnectionId).toBe(null)
  })

  it('buildJumpHostRequest for password auth carries the password, not key fields', () => {
    const body = buildJumpHostRequest(passwordDraft({ password: 'hunter2' }))
    expect(body.password).toBe('hunter2')
    expect(body.privateKey).toBeUndefined()
    expect(body.privateKeyPath).toBeUndefined()
    expect(body.passphrase).toBeUndefined()
  })

  it('buildJumpHostRequest for privatekey auth carries the key and passphrase, not password', () => {
    const body = buildJumpHostRequest(
      passwordDraft({ authType: 'privatekey', password: '', privateKey: 'PEMDATA', passphrase: 'shh' }),
    )
    expect(body.privateKey).toBe('PEMDATA')
    expect(body.passphrase).toBe('shh')
    expect(body.password).toBeUndefined()
  })

  it('buildJumpHostRequest prefers a pasted privateKey over privateKeyPath when both are set', () => {
    const body = buildJumpHostRequest(
      passwordDraft({ authType: 'privatekey', password: '', privateKey: 'PEMDATA', privateKeyPath: '~/.ssh/id_ed25519' }),
    )
    expect(body.privateKey).toBe('PEMDATA')
    expect(body.privateKeyPath).toBeUndefined()
  })
})
