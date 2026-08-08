import { describe, expect, it } from 'vitest'
import { documentFormatForPath, isDocumentPath } from './documentKind'

describe('documentFormatForPath', () => {
  it('maps the modern Office formats to a renderable format', () => {
    expect(documentFormatForPath('report.pdf')).toMatchObject({ kind: 'pdf', renderable: true })
    expect(documentFormatForPath('a/b/notes.docx')).toMatchObject({
      kind: 'word',
      renderable: true,
    })
    expect(documentFormatForPath('budget.xlsx')).toMatchObject({ kind: 'excel', renderable: true })
    expect(documentFormatForPath('deck.pptx')).toMatchObject({
      kind: 'powerpoint',
      renderable: true,
    })
  })

  it('covers the macro-enabled and template variants', () => {
    expect(documentFormatForPath('sheet.xlsm')).toMatchObject({ kind: 'excel', renderable: true })
    expect(documentFormatForPath('letter.dotx')).toMatchObject({ kind: 'word', renderable: true })
    expect(documentFormatForPath('show.ppsx')).toMatchObject({
      kind: 'powerpoint',
      renderable: true,
    })
  })

  it('recognises legacy binary formats but marks them unrenderable', () => {
    expect(documentFormatForPath('old.doc')).toMatchObject({ kind: 'word', renderable: false })
    expect(documentFormatForPath('old.xls')).toMatchObject({ kind: 'excel', renderable: false })
    expect(documentFormatForPath('old.ppt')).toMatchObject({
      kind: 'powerpoint',
      renderable: false,
    })
  })

  it('is case-insensitive on the extension', () => {
    expect(documentFormatForPath('SCAN.PDF')).toMatchObject({ kind: 'pdf' })
    expect(documentFormatForPath('Report.DocX')).toMatchObject({ kind: 'word' })
  })

  it('leaves text files - including CSV - to the editor', () => {
    expect(documentFormatForPath('main.go')).toBeNull()
    expect(documentFormatForPath('data.csv')).toBeNull()
    expect(documentFormatForPath('README.md')).toBeNull()
    expect(documentFormatForPath('Makefile')).toBeNull()
  })

  it('does not treat a dot in a folder name as an extension', () => {
    expect(documentFormatForPath('v1.2/README')).toBeNull()
    expect(documentFormatForPath('my.docs/notes')).toBeNull()
  })

  it('treats a dotfile as extension-less', () => {
    expect(documentFormatForPath('.pdf')).toBeNull()
    expect(documentFormatForPath('src/.xlsx')).toBeNull()
  })

  it('isDocumentPath agrees with documentFormatForPath', () => {
    expect(isDocumentPath('a.pptx')).toBe(true)
    expect(isDocumentPath('a.ts')).toBe(false)
  })
})
