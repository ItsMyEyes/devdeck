import { describe, expect, it } from 'vitest'
import { resolveProxyForMachine } from './browserProxy'

const machine = {
  id: 'm1',
  name: 'builder',
  url: 'https://builder.tail1234.ts.net:8989',
  key: 'k',
  isLocal: false,
  signingPublicKey: '',
}

describe('resolveProxyForMachine', () => {
  it('returns ok with the started proxy on success', async () => {
    const result = await resolveProxyForMachine('m1', [machine], async () => ({
      socks5Addr: '1.2.3.4:9',
      httpProxyAddr: '1.2.3.4:10',
    }))
    expect(result).toEqual({ ok: true, proxy: { socks5Addr: '1.2.3.4:9', httpProxyAddr: '1.2.3.4:10' } })
  })

  it('returns a not-found error when the machine id is unknown', async () => {
    const result = await resolveProxyForMachine('missing', [machine], async () => ({ socks5Addr: '', httpProxyAddr: '' }))
    expect(result).toEqual({ ok: false, error: 'Machine not found' })
  })

  it('returns a descriptive error instead of throwing when startProxy rejects', async () => {
    const result = await resolveProxyForMachine('m1', [machine], async () => {
      throw new Error('machine offline')
    })
    expect(result).toEqual({ ok: false, error: 'Could not start browser proxy on builder: machine offline' })
  })
})
