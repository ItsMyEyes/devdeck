import { beforeEach, describe, expect, it, vi } from 'vitest'
import { paragraphText, readDocx } from './docx'
import type { DocxParagraph } from './docx'
import { NS } from './ooxml'
import { buildZip } from './testZip'
import type { ZipInput } from './testZip'
import { readZip } from './zip'

const DOCUMENT_HEADER = `<w:document xmlns:w="${NS.w}" xmlns:r="${NS.rel}" xmlns:a="${NS.a}">`

function docxWith(bodyXml: string, extra: ZipInput = {}) {
  return buildZip({
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?>${DOCUMENT_HEADER}<w:body>${bodyXml}</w:body></w:document>`,
    ...extra,
  })
}

const NUMBERING = `<w:numbering xmlns:w="${NS.w}">
  <w:abstractNum w:abstractNumId="0">
    <w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl>
    <w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl>
  </w:abstractNum>
  <w:abstractNum w:abstractNumId="1">
    <w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl>
  </w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
  <w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`

const paragraphs = (blocks: Awaited<ReturnType<typeof readDocx>>['blocks']) =>
  blocks.filter((block): block is DocxParagraph => block.kind === 'paragraph')

describe('readDocx', () => {
  it('rejects a zip that is not a Word document', async () => {
    const zip = readZip(await buildZip({ 'xl/workbook.xml': '<a/>' }))
    await expect(readDocx(zip)).rejects.toThrow(/not look like a Word document/)
  })

  it('reads headings, body text and inline emphasis', async () => {
    const zip = readZip(
      await docxWith(`
        <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Quarterly Report</w:t></w:r></w:p>
        <w:p><w:pPr><w:pStyle w:val="Heading3"/></w:pPr><w:r><w:t>Revenue</w:t></w:r></w:p>
        <w:p>
          <w:r><w:t xml:space="preserve">Revenue was </w:t></w:r>
          <w:r><w:rPr><w:b/></w:rPr><w:t>up 12%</w:t></w:r>
          <w:r><w:t xml:space="preserve"> this quarter.</w:t></w:r>
        </w:p>`),
    )
    const { blocks } = await readDocx(zip)
    const found = paragraphs(blocks)

    expect(found[0].heading).toBe(1)
    expect(paragraphText(found[0])).toBe('Quarterly Report')
    expect(found[1].heading).toBe(3)
    expect(found[2].heading).toBe(0)
    expect(paragraphText(found[2])).toBe('Revenue was up 12% this quarter.')
    expect(found[2].runs.map((run) => [run.text, run.bold])).toEqual([
      ['Revenue was ', false],
      ['up 12%', true],
      [' this quarter.', false],
    ])
  })

  it('treats the Title style as a level-1 heading', async () => {
    const zip = readZip(
      await docxWith(
        `<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Cover</w:t></w:r></w:p>`,
      ),
    )
    expect(paragraphs((await readDocx(zip)).blocks)[0].heading).toBe(1)
  })

  it('merges adjacent runs that share formatting', async () => {
    // Word splits a styled sentence across many runs for rsid/spell-check
    // bookkeeping; without merging this renders as one span per fragment.
    const zip = readZip(
      await docxWith(`<w:p>
        <w:r><w:t>Hel</w:t></w:r><w:r><w:t>lo </w:t></w:r>
        <w:r><w:rPr><w:i/></w:rPr><w:t>wo</w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>rld</w:t></w:r>
      </w:p>`),
    )
    const runs = paragraphs((await readDocx(zip)).blocks)[0].runs
    expect(runs).toHaveLength(2)
    expect(runs[0]).toMatchObject({ text: 'Hello ', italic: false })
    expect(runs[1]).toMatchObject({ text: 'world', italic: true })
  })

  it('reads underline as a style, not a toggle', async () => {
    const zip = readZip(
      await docxWith(`
        <w:p><w:r><w:rPr><w:u w:val="single"/></w:rPr><w:t>under</w:t></w:r></w:p>
        <w:p><w:r><w:rPr><w:u w:val="none"/></w:rPr><w:t>plain</w:t></w:r></w:p>`),
    )
    const found = paragraphs((await readDocx(zip)).blocks)
    expect(found[0].runs[0].underline).toBe(true)
    expect(found[1].runs[0].underline).toBe(false)
  })

  it('converts breaks, tabs and non-breaking hyphens to text', async () => {
    const zip = readZip(
      await docxWith(
        `<w:p><w:r><w:t>Line one</w:t><w:br/><w:t>Line two</w:t><w:tab/><w:t>tabbed</w:t><w:noBreakHyphen/><w:t>x</w:t></w:r></w:p>`,
      ),
    )
    expect(paragraphText(paragraphs((await readDocx(zip)).blocks)[0])).toBe(
      'Line one\nLine two\ttabbed-x',
    )
  })

  it('classifies list levels and distinguishes ordered from bulleted', async () => {
    const zip = readZip(
      await docxWith(
        `
        <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Bullet</w:t></w:r></w:p>
        <w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Nested</w:t></w:r></w:p>
        <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr><w:r><w:t>Step one</w:t></w:r></w:p>
        <w:p><w:r><w:t>Plain</w:t></w:r></w:p>`,
        { 'word/numbering.xml': NUMBERING },
      ),
    )
    const found = paragraphs((await readDocx(zip)).blocks)

    expect(found[0]).toMatchObject({ listLevel: 0, ordered: false })
    expect(found[1]).toMatchObject({ listLevel: 1, ordered: false })
    expect(found[2]).toMatchObject({ listLevel: 0, ordered: true })
    // -1 is "not a list item" — distinct from level 0.
    expect(found[3].listLevel).toBe(-1)
  })

  it('finds list membership declared on the paragraph style, not the paragraph', async () => {
    // What Word's ribbon list buttons and python-docx both produce: the
    // paragraph carries only <w:pStyle>, and the numbering reference lives on
    // the style. Reading only inline w:numPr renders these as plain text.
    const zip = readZip(
      await docxWith(
        `
        <w:p><w:pPr><w:pStyle w:val="ListBullet"/></w:pPr><w:r><w:t>Bulleted</w:t></w:r></w:p>
        <w:p><w:pPr><w:pStyle w:val="ListNumber"/></w:pPr><w:r><w:t>Numbered</w:t></w:r></w:p>
        <w:p><w:pPr><w:pStyle w:val="MyBullet"/></w:pPr><w:r><w:t>Inherited</w:t></w:r></w:p>`,
        {
          'word/numbering.xml': NUMBERING,
          'word/styles.xml': `<w:styles xmlns:w="${NS.w}">
            <w:style w:type="paragraph" w:styleId="ListBullet">
              <w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr>
            </w:style>
            <w:style w:type="paragraph" w:styleId="ListNumber">
              <w:pPr><w:numPr><w:numId w:val="2"/></w:numPr></w:pPr>
            </w:style>
            <w:style w:type="paragraph" w:styleId="MyBullet">
              <w:basedOn w:val="ListBullet"/>
            </w:style>
          </w:styles>`,
        },
      ),
    )
    const found = paragraphs((await readDocx(zip)).blocks)

    expect(found[0]).toMatchObject({ listLevel: 0, ordered: false })
    expect(found[1]).toMatchObject({ listLevel: 0, ordered: true })
    // Resolved through w:basedOn.
    expect(found[2]).toMatchObject({ listLevel: 0, ordered: false })
  })

  it('honours numId 0 as an explicit opt-out of a list-carrying style', async () => {
    const zip = readZip(
      await docxWith(
        `<w:p>
          <w:pPr><w:pStyle w:val="ListBullet"/><w:numPr><w:numId w:val="0"/></w:numPr></w:pPr>
          <w:r><w:t>Not a bullet</w:t></w:r>
        </w:p>`,
        {
          'word/numbering.xml': NUMBERING,
          'word/styles.xml': `<w:styles xmlns:w="${NS.w}">
            <w:style w:type="paragraph" w:styleId="ListBullet">
              <w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr>
            </w:style>
          </w:styles>`,
        },
      ),
    )
    expect(paragraphs((await readDocx(zip)).blocks)[0].listLevel).toBe(-1)
  })

  it('does not loop on a cyclic basedOn chain', async () => {
    const zip = readZip(
      await docxWith(`<w:p><w:pPr><w:pStyle w:val="A"/></w:pPr><w:r><w:t>Text</w:t></w:r></w:p>`, {
        'word/styles.xml': `<w:styles xmlns:w="${NS.w}">
          <w:style w:styleId="A"><w:basedOn w:val="B"/></w:style>
          <w:style w:styleId="B"><w:basedOn w:val="A"/></w:style>
        </w:styles>`,
      }),
    )
    expect(paragraphs((await readDocx(zip)).blocks)[0].listLevel).toBe(-1)
  })

  it('falls back to unordered when numbering.xml is absent', async () => {
    const zip = readZip(
      await docxWith(
        `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr><w:r><w:t>Item</w:t></w:r></w:p>`,
      ),
    )
    expect(paragraphs((await readDocx(zip)).blocks)[0]).toMatchObject({
      listLevel: 0,
      ordered: false,
    })
  })

  it('attaches external hyperlink targets to their runs', async () => {
    const zip = readZip(
      await docxWith(
        `<w:p><w:hyperlink r:id="rId9"><w:r><w:t>DevDeck docs</w:t></w:r></w:hyperlink></w:p>`,
        {
          'word/_rels/document.xml.rels': `<Relationships xmlns="${NS.packageRel}">
            <Relationship Id="rId9" Type="http://x/hyperlink" Target="https://example.com/docs" TargetMode="External"/>
          </Relationships>`,
        },
      ),
    )
    expect(paragraphs((await readDocx(zip)).blocks)[0].runs[0]).toMatchObject({
      text: 'DevDeck docs',
      href: 'https://example.com/docs',
    })
  })

  it('keeps hyperlink text in reading order alongside plain runs', async () => {
    const zip = readZip(
      await docxWith(
        `<w:p>
          <w:r><w:t xml:space="preserve">See </w:t></w:r>
          <w:hyperlink r:id="rId9"><w:r><w:t>the docs</w:t></w:r></w:hyperlink>
          <w:r><w:t xml:space="preserve"> for more.</w:t></w:r>
        </w:p>`,
        {
          'word/_rels/document.xml.rels': `<Relationships xmlns="${NS.packageRel}">
            <Relationship Id="rId9" Type="http://x/hyperlink" Target="https://example.com" TargetMode="External"/>
          </Relationships>`,
        },
      ),
    )
    expect(paragraphText(paragraphs((await readDocx(zip)).blocks)[0])).toBe(
      'See the docs for more.',
    )
  })

  it('reads tables as rows of cells of paragraphs', async () => {
    const zip = readZip(
      await docxWith(`<w:tbl>
        <w:tr>
          <w:tc><w:p><w:r><w:t>Region</w:t></w:r></w:p></w:tc>
          <w:tc><w:p><w:r><w:t>Total</w:t></w:r></w:p></w:tc>
        </w:tr>
        <w:tr>
          <w:tc><w:p><w:r><w:t>EMEA</w:t></w:r></w:p></w:tc>
          <w:tc><w:p><w:r><w:t>1,204</w:t></w:r></w:p></w:tc>
        </w:tr>
      </w:tbl>`),
    )
    const { blocks } = await readDocx(zip)
    expect(blocks).toHaveLength(1)
    const table = blocks[0]
    if (table.kind !== 'table') throw new Error('expected a table block')

    expect(table.rows).toHaveLength(2)
    expect(table.rows.map((row) => row.map((cell) => paragraphText(cell[0])))).toEqual([
      ['Region', 'Total'],
      ['EMEA', '1,204'],
    ])
  })
})

describe('readDocx images', () => {
  beforeEach(() => {
    // jsdom implements neither of these; the parser hands out object URLs for
    // embedded media, so they have to be stubbed to exercise that path.
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:docx-image'),
      revokeObjectURL: vi.fn(),
    })
  })

  const withImage = (relTarget: string, media: ZipInput) =>
    docxWith(
      `<w:p><w:r><w:drawing>
        <wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">
          <wp:docPr id="1" name="Picture 1" descr="Revenue chart"/>
          <a:graphic><a:graphicData><a:blip r:embed="rId5"/></a:graphicData></a:graphic>
        </wp:inline>
      </w:drawing></w:r></w:p>`,
      {
        'word/_rels/document.xml.rels': `<Relationships xmlns="${NS.packageRel}">
          <Relationship Id="rId5" Type="http://x/image" Target="${relTarget}"/>
        </Relationships>`,
        ...media,
      },
    )

  it('resolves an embedded image to an object URL with its alt text', async () => {
    const zip = readZip(
      await withImage('media/image1.png', { 'word/media/image1.png': new Uint8Array([1, 2, 3]) }),
    )
    const doc = await readDocx(zip)
    const [paragraph] = paragraphs(doc.blocks)

    expect(paragraph.images).toEqual([{ url: 'blob:docx-image', alt: 'Revenue chart' }])
    doc.release()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:docx-image')
  })

  it('skips media a browser cannot display', async () => {
    const zip = readZip(
      await withImage('media/diagram.emf', { 'word/media/diagram.emf': new Uint8Array([1]) }),
    )
    const doc = await readDocx(zip)
    expect(paragraphs(doc.blocks)[0].images).toEqual([])
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('skips a relationship whose media part is missing from the archive', async () => {
    const zip = readZip(await withImage('media/image1.png', {}))
    const doc = await readDocx(zip)
    expect(paragraphs(doc.blocks)[0].images).toEqual([])
  })
})
