import { describe, expect, it } from 'vitest'
import { BROWSER_LOAD_TIMEOUT_MS, httpLoadError, httpStatusLabel, timeoutLoadError } from './browserLoadError'

describe('httpStatusLabel', () => {
  it('names the statuses an operator actually sees', () => {
    expect(httpStatusLabel(404)).toBe('404 Not Found')
    expect(httpStatusLabel(504)).toBe('504 Gateway Timeout')
  })

  it('falls back to the status class for codes it has no name for', () => {
    expect(httpStatusLabel(599)).toBe('599 Server Error')
    expect(httpStatusLabel(451)).toBe('451 Client Error')
  })
})

describe('httpLoadError', () => {
  it('blames the site when the site is what answered', () => {
    const error = httpLoadError(404)
    expect(error.kind).toBe('http')
    expect(error.status).toBe(404)
    expect(error.detail).toContain('404 Not Found')
  })

  // A DevDeck-side failure arrives with a message from the proxy's own error
  // page, and must not read as "the site returned this" — the site was never
  // reached.
  it('blames DevDeck when the proxy is what failed', () => {
    const error = httpLoadError(502, 'the site could not be reached')
    expect(error.kind).toBe('proxy')
    expect(error.detail).toBe('The site could not be reached. (502 Bad Gateway)')
  })

  it('leaves an already-punctuated proxy message alone', () => {
    expect(httpLoadError(504, 'It timed out.').detail).toBe('It timed out. (504 Gateway Timeout)')
  })
})

describe('timeoutLoadError', () => {
  it('reports the wait in seconds', () => {
    expect(timeoutLoadError(30_000).detail).toContain('30 seconds')
    expect(timeoutLoadError().kind).toBe('timeout')
  })

  // The server-side ResponseHeaderTimeout is 20s (browser_proxy.go); a client
  // timer that fired first would replace the proxy's specific 504 reason with
  // this generic one.
  it('waits longer than the proxy s own response-header timeout', () => {
    expect(BROWSER_LOAD_TIMEOUT_MS).toBeGreaterThan(20_000)
  })
})
