import { describe, expect, it } from 'vitest'
import { jsonParseMarker } from './jsonMarkers'

describe('jsonParseMarker', () => {
  it('returns null for valid JSON', () => {
    expect(jsonParseMarker('{"a": 1}')).toBeNull()
  })

  it('returns null for empty input', () => {
    expect(jsonParseMarker('   ')).toBeNull()
  })

  it('reports the line of a syntax error', () => {
    const marker = jsonParseMarker('{\n  "a": 1,\n  "b" 2\n}')
    expect(marker).not.toBeNull()
    expect(marker!.line).toBe(3)
    expect(marker!.message).toBeTruthy()
  })

  it('reports line 1 when the error is on the first line', () => {
    const marker = jsonParseMarker('{ "a" 1 }')
    expect(marker!.line).toBe(1)
  })

  it('defaults to line 1 when the engine gives no position', () => {
    const marker = jsonParseMarker('{')
    expect(marker!.line).toBeGreaterThanOrEqual(1)
  })
})
