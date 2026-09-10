import { describe, expect, it } from 'vitest'
import { canOpenWithExternalApp } from './openWithExternal'

describe('canOpenWithExternalApp', () => {
  it('is false on the web, where there is no Tauri shell to open a local app', () => {
    expect(canOpenWithExternalApp({} as Pick<Window, never>)).toBe(false)
  })

  it('is true inside the desktop shell', () => {
    const win = { __TAURI_INTERNALS__: {} } as unknown as Pick<Window, never>
    expect(canOpenWithExternalApp(win)).toBe(true)
  })
})
