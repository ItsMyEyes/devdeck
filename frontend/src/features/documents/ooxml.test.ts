import { describe, expect, it } from 'vitest'
import {
  attr,
  children,
  descendants,
  firstChild,
  intAttr,
  isDisplayableImage,
  mediaMimeType,
  NS,
  OoxmlError,
  parseXml,
  readRelationships,
  relsPartFor,
  resolvePart,
  toggleValue,
} from './ooxml'
import { buildZip } from './testZip'
import { readZip } from './zip'

const encode = (xml: string) => new TextEncoder().encode(xml)

describe('resolvePart', () => {
  it('resolves a sibling target against the declaring part', () => {
    expect(resolvePart('xl/workbook.xml', 'worksheets/sheet1.xml')).toBe('xl/worksheets/sheet1.xml')
  })

  it('walks up for a parent-relative target', () => {
    expect(resolvePart('ppt/slides/slide1.xml', '../media/image2.png')).toBe('ppt/media/image2.png')
    expect(resolvePart('ppt/slides/slide1.xml', '../notesSlides/notesSlide1.xml')).toBe(
      'ppt/notesSlides/notesSlide1.xml',
    )
  })

  it('treats a leading slash as package-absolute', () => {
    expect(resolvePart('ppt/slides/slide1.xml', '/ppt/media/image1.png')).toBe('ppt/media/image1.png')
  })

  it('ignores "." segments', () => {
    expect(resolvePart('word/document.xml', './media/a.png')).toBe('word/media/a.png')
  })
})

describe('relsPartFor', () => {
  it('inserts the _rels folder next to the part', () => {
    expect(relsPartFor('word/document.xml')).toBe('word/_rels/document.xml.rels')
    expect(relsPartFor('ppt/slides/slide3.xml')).toBe('ppt/slides/_rels/slide3.xml.rels')
  })
})

describe('parseXml', () => {
  it('throws OoxmlError on malformed XML rather than returning a broken document', () => {
    expect(() => parseXml(encode('<a><b></a>'), 'broken.xml')).toThrow(OoxmlError)
  })
})

describe('namespace-aware lookups', () => {
  const doc = parseXml(
    encode(`<w:document xmlns:w="${NS.w}">
      <w:body>
        <w:p><w:r><w:t>one</w:t></w:r></w:p>
        <w:p><w:r><w:t>two</w:t></w:r></w:p>
      </w:body>
    </w:document>`),
    'document.xml',
  )

  it('children only returns direct children', () => {
    const body = firstChild(doc.documentElement, NS.w, 'body')
    expect(children(body, NS.w, 'p')).toHaveLength(2)
    // `t` is a grandchild of body, so it must not appear.
    expect(children(body, NS.w, 't')).toHaveLength(0)
  })

  it('descendants reaches the whole subtree in document order', () => {
    expect(descendants(doc, NS.w, 't').map((el) => el.textContent)).toEqual(['one', 'two'])
  })

  it('matches a default namespace as well as a prefixed one', () => {
    // xlsx parts declare the main namespace as the default, with no prefix —
    // the same lookups have to work for both shapes.
    const defaulted = parseXml(
      encode(`<worksheet xmlns="${NS.s}"><sheetData><row r="1"/></sheetData></worksheet>`),
      'sheet1.xml',
    )
    const sheetData = firstChild(defaulted.documentElement, NS.s, 'sheetData')
    expect(children(sheetData, NS.s, 'row')).toHaveLength(1)
  })
})

describe('attr', () => {
  const doc = parseXml(
    encode(`<c xmlns="${NS.s}" xmlns:r="${NS.rel}" r:id="rId4" r="A1" t="s" s="3"/>`),
    'cell.xml',
  )
  const cell = doc.documentElement

  it('reads a namespaced attribute by URI', () => {
    expect(attr(cell, NS.rel, 'id')).toBe('rId4')
  })

  it('reads an unprefixed attribute as being in no namespace', () => {
    // `r="A1"` and `r:id="rId4"` coexist on the same element — reading either
    // one by the wrong route silently returns the other.
    expect(attr(cell, null, 'r')).toBe('A1')
    expect(attr(cell, null, 't')).toBe('s')
  })

  it('intAttr parses and rejects non-numeric values', () => {
    expect(intAttr(cell, null, 's')).toBe(3)
    expect(intAttr(cell, null, 't')).toBeNull()
    expect(intAttr(cell, null, 'missing')).toBeNull()
  })
})

describe('toggleValue', () => {
  const parse = (xml: string) => parseXml(encode(xml), 'toggle.xml').documentElement

  it('treats a bare element as true', () => {
    expect(toggleValue(parse(`<w:b xmlns:w="${NS.w}"/>`))).toBe(true)
  })

  it('honours explicit falsey values', () => {
    expect(toggleValue(parse(`<w:b xmlns:w="${NS.w}" w:val="0"/>`))).toBe(false)
    expect(toggleValue(parse(`<w:b xmlns:w="${NS.w}" w:val="false"/>`))).toBe(false)
    expect(toggleValue(parse(`<w:b xmlns:w="${NS.w}" w:val="off"/>`))).toBe(false)
  })

  it('honours explicit truthy values and a missing element', () => {
    expect(toggleValue(parse(`<w:b xmlns:w="${NS.w}" w:val="1"/>`))).toBe(true)
    expect(toggleValue(null)).toBe(false)
  })
})

describe('readRelationships', () => {
  it('resolves internal targets and keeps external ones verbatim', async () => {
    const zip = readZip(
      await buildZip({
        'word/_rels/document.xml.rels': `<Relationships xmlns="${NS.packageRel}">
          <Relationship Id="rId1" Type="http://x/image" Target="media/image1.png"/>
          <Relationship Id="rId2" Type="http://x/hyperlink" Target="https://example.com/docs" TargetMode="External"/>
        </Relationships>`,
      }),
    )

    const rels = await readRelationships(zip, 'word/document.xml')
    expect(rels.get('rId1')).toMatchObject({
      target: 'word/media/image1.png',
      external: false,
    })
    expect(rels.get('rId2')).toMatchObject({
      target: 'https://example.com/docs',
      external: true,
    })
  })

  it('resolves to an empty map when the part has no _rels file', async () => {
    const zip = readZip(await buildZip({ 'word/document.xml': '<a/>' }))
    expect((await readRelationships(zip, 'word/document.xml')).size).toBe(0)
  })
})

describe('media types', () => {
  it('maps common image extensions', () => {
    expect(mediaMimeType('ppt/media/image1.png')).toBe('image/png')
    expect(mediaMimeType('ppt/media/image2.JPG')).toBe('image/jpeg')
    expect(mediaMimeType('ppt/media/image3.svg')).toBe('image/svg+xml')
  })

  it('rejects formats no browser renders', () => {
    expect(isDisplayableImage('ppt/media/image1.png')).toBe(true)
    // Office embeds these routinely; showing them would be a broken <img>.
    expect(isDisplayableImage('ppt/media/image1.emf')).toBe(false)
    expect(isDisplayableImage('ppt/media/image1.wmf')).toBe(false)
    expect(isDisplayableImage('ppt/media/image1.tiff')).toBe(false)
  })
})
