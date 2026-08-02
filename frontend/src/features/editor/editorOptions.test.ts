import { describe, expect, it } from 'vitest'
import { buildEditorOptions } from './editorOptions'

describe('buildEditorOptions', () => {
  it('turns on IDE chrome in VS Code mode', () => {
    const options = buildEditorOptions(true)
    expect(options.minimap?.enabled).toBe(true)
    expect(options.stickyScroll?.enabled).toBe(true)
    expect(options.folding).toBe(true)
    expect(options.glyphMargin).toBe(true)
    expect(options.occurrencesHighlight).toBe('singleFile')
    expect(options.renderLineHighlight).toBe('all')
    expect(options.matchBrackets).toBe('always')
  })

  it('stays minimal when VS Code mode is off', () => {
    const options = buildEditorOptions(false)
    expect(options.minimap?.enabled).toBe(false)
    expect(options.stickyScroll?.enabled).toBe(false)
    expect(options.folding).toBe(false)
    expect(options.glyphMargin).toBe(false)
    expect(options.occurrencesHighlight).toBe('off')
    expect(options.renderLineHighlight).toBe('line')
    expect(options.matchBrackets).toBe('near')
  })

  it('keeps line numbers on in both modes', () => {
    expect(buildEditorOptions(true).lineNumbers).toBe('on')
    expect(buildEditorOptions(false).lineNumbers).toBe('on')
  })

  it('lets callers override any option', () => {
    const options = buildEditorOptions(false, { readOnly: true, wordWrap: 'on' })
    expect(options.readOnly).toBe(true)
    expect(options.wordWrap).toBe('on')
    expect(options.minimap?.enabled).toBe(false)
  })
})
