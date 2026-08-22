import { describe, expect, it } from 'vitest'
import { documentFormatForPath, isDocumentPath, mediaMimeForPath } from './documentKind'

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

  it('leaves ordinary source and prose to the editor', () => {
    expect(documentFormatForPath('main.go')).toBeNull()
    expect(documentFormatForPath('README.md')).toBeNull()
    expect(documentFormatForPath('Makefile')).toBeNull()
    expect(documentFormatForPath('config.json')).toBeNull()
  })

  it('opens delimited text as a grid but keeps the editor reachable', () => {
    expect(documentFormatForPath('data.csv')).toMatchObject({
      kind: 'csv',
      renderable: true,
      textEditable: true,
    })
    expect(documentFormatForPath('export.tsv')).toMatchObject({ kind: 'csv', textEditable: true })
  })

  it('routes images and video away from the UTF-8 text endpoint', () => {
    for (const path of ['shot.png', 'a/b/photo.JPEG', 'anim.gif', 'icon.webp', 'logo.ico']) {
      expect(documentFormatForPath(path)).toMatchObject({ kind: 'image', renderable: true })
    }
    for (const path of ['clip.mp4', 'screen.mov', 'demo.webm']) {
      expect(documentFormatForPath(path)).toMatchObject({ kind: 'video', renderable: true })
    }
  })

  it('marks the containers no browser decodes as unrenderable', () => {
    expect(documentFormatForPath('movie.mkv')).toMatchObject({ kind: 'video', renderable: false })
    expect(documentFormatForPath('old.avi')).toMatchObject({ kind: 'video', renderable: false })
  })

  it('leaves SVG to the editor - it is text with source worth editing', () => {
    expect(documentFormatForPath('logo.svg')).toBeNull()
  })

  it('gives media a specific MIME type, not a generic one', () => {
    expect(mediaMimeForPath('a.png')).toBe('image/png')
    expect(mediaMimeForPath('a.JPG')).toBe('image/jpeg')
    expect(mediaMimeForPath('a.mov')).toBe('video/quicktime')
    // Not media: the blob is created untyped rather than mislabelled.
    expect(mediaMimeForPath('a.csv')).toBe('')
    expect(mediaMimeForPath('Makefile')).toBe('')
  })

  it('never claims a format is both editable text and unrenderable', () => {
    // textEditable exists so a grid can fall back to the editor; an
    // unrenderable format has no grid to fall back FROM, so the pair is
    // meaningless and would render a dead "Edit as text" button.
    for (const path of ['a.csv', 'a.tsv', 'a.mkv', 'a.doc', 'a.png', 'a.xlsx']) {
      const format = documentFormatForPath(path)
      expect(format).not.toBeNull()
      if (format?.textEditable) expect(format.renderable).toBe(true)
    }
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
