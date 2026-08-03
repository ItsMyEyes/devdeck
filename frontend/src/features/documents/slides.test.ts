import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NS } from './ooxml'
import { readPresentation, slideIsEmpty } from './slides'
import { buildZip } from './testZip'
import type { ZipInput } from './testZip'
import { readZip } from './zip'

const SLIDE_HEADER = `<p:sld xmlns:p="${NS.p}" xmlns:a="${NS.a}" xmlns:r="${NS.rel}">`

const slide = (shapesXml: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>${SLIDE_HEADER}<p:cSld><p:spTree>${shapesXml}</p:spTree></p:cSld></p:sld>`

const shape = (placeholder: string | null, paragraphsXml: string, name = 'Shape') => `
  <p:sp>
    <p:nvSpPr>
      <p:cNvPr id="2" name="${name}"/>
      <p:nvPr>${placeholder ? `<p:ph type="${placeholder}"/>` : ''}</p:nvPr>
    </p:nvSpPr>
    <p:txBody>${paragraphsXml}</p:txBody>
  </p:sp>`

const para = (text: string, level?: number) =>
  `<a:p>${level === undefined ? '' : `<a:pPr lvl="${level}"/>`}<a:r><a:t>${text}</a:t></a:r></a:p>`

function deck(slides: ZipInput, sldIdList: string, parts: ZipInput = {}) {
  return buildZip({
    'ppt/presentation.xml': `<p:presentation xmlns:p="${NS.p}" xmlns:r="${NS.rel}"><p:sldIdLst>${sldIdList}</p:sldIdLst></p:presentation>`,
    ...slides,
    ...parts,
  })
}

const PRESENTATION_RELS = `<Relationships xmlns="${NS.packageRel}">
  <Relationship Id="rId1" Type="http://x/slide" Target="slides/slide1.xml"/>
  <Relationship Id="rId2" Type="http://x/slide" Target="slides/slide2.xml"/>
</Relationships>`

describe('readPresentation', () => {
  it('rejects a zip that is not a presentation', async () => {
    const zip = readZip(await buildZip({ 'word/document.xml': '<a/>' }))
    await expect(readPresentation(zip)).rejects.toThrow(/not look like a PowerPoint file/)
  })

  it('reads titles and body bullets with their outline levels', async () => {
    const zip = readZip(
      await deck(
        {
          'ppt/slides/slide1.xml': slide(
            shape('ctrTitle', para('Roadmap'), 'Title 1') +
              shape(
                'body',
                // The empty paragraph is PowerPoint's vertical spacer and must
                // not become a blank bullet.
                para('Ship the viewer') + para('PDF first', 1) + '<a:p/>',
                'Body 2',
              ),
          ),
        },
        `<p:sldId id="256" r:id="rId1"/>`,
        { 'ppt/_rels/presentation.xml.rels': PRESENTATION_RELS },
      ),
    )

    const { slides } = await readPresentation(zip)
    expect(slides).toHaveLength(1)
    expect(slides[0]).toMatchObject({ number: 1, title: 'Roadmap' })
    expect(slides[0].bullets).toEqual([
      { text: 'Ship the viewer', level: 0 },
      { text: 'PDF first', level: 1 },
    ])
  })

  it('orders slides by sldIdLst, not by part filename', async () => {
    const zip = readZip(
      await deck(
        {
          'ppt/slides/slide1.xml': slide(shape('title', para('Second'))),
          'ppt/slides/slide2.xml': slide(shape('title', para('First'))),
        },
        // rId2 (slide2.xml) is listed first — a reordered deck.
        `<p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId1"/>`,
        { 'ppt/_rels/presentation.xml.rels': PRESENTATION_RELS },
      ),
    )

    const { slides } = await readPresentation(zip)
    expect(slides.map((s) => [s.number, s.title])).toEqual([
      [1, 'First'],
      [2, 'Second'],
    ])
  })

  it('falls back to filename order when the relationship graph is unusable', async () => {
    const zip = readZip(
      await deck(
        {
          'ppt/slides/slide1.xml': slide(shape('title', para('One'))),
          'ppt/slides/slide2.xml': slide(shape('title', para('Two'))),
          'ppt/slides/slide10.xml': slide(shape('title', para('Ten'))),
        },
        '',
      ),
    )
    // Numeric, not lexicographic — slide10 sorts after slide2.
    expect((await readPresentation(zip)).slides.map((s) => s.title)).toEqual(['One', 'Two', 'Ten'])
  })

  it('treats a non-placeholder text box as body content', async () => {
    const zip = readZip(
      await deck(
        { 'ppt/slides/slide1.xml': slide(shape(null, para('Free-floating note'), 'TextBox 3')) },
        `<p:sldId id="256" r:id="rId1"/>`,
        { 'ppt/_rels/presentation.xml.rels': PRESENTATION_RELS },
      ),
    )
    const [first] = (await readPresentation(zip)).slides
    expect(first.title).toBe('')
    expect(first.bullets).toEqual([{ text: 'Free-floating note', level: 0 }])
  })

  it('demotes a second title shape to body text rather than overwriting the title', async () => {
    const zip = readZip(
      await deck(
        {
          'ppt/slides/slide1.xml': slide(
            shape('title', para('Real title')) + shape('title', para('Stray title box')),
          ),
        },
        `<p:sldId id="256" r:id="rId1"/>`,
        { 'ppt/_rels/presentation.xml.rels': PRESENTATION_RELS },
      ),
    )
    const [first] = (await readPresentation(zip)).slides
    expect(first.title).toBe('Real title')
    expect(first.bullets).toEqual([{ text: 'Stray title box', level: 0 }])
  })

  it('reads tables out of a graphic frame', async () => {
    const cell = (text: string) => `<a:tc><a:txBody>${para(text)}</a:txBody></a:tc>`
    const zip = readZip(
      await deck(
        {
          'ppt/slides/slide1.xml': slide(`
            <p:graphicFrame><a:graphic><a:graphicData><a:tbl>
              <a:tr>${cell('Quarter')}${cell('Revenue')}</a:tr>
              <a:tr>${cell('Q1')}${cell('1,204')}</a:tr>
            </a:tbl></a:graphicData></a:graphic></p:graphicFrame>`),
        },
        `<p:sldId id="256" r:id="rId1"/>`,
        { 'ppt/_rels/presentation.xml.rels': PRESENTATION_RELS },
      ),
    )
    expect((await readPresentation(zip)).slides[0].tables).toEqual([
      {
        rows: [
          ['Quarter', 'Revenue'],
          ['Q1', '1,204'],
        ],
      },
    ])
  })

  it('reads speaker notes from the notes slide', async () => {
    const zip = readZip(
      await deck(
        { 'ppt/slides/slide1.xml': slide(shape('title', para('Roadmap'))) },
        `<p:sldId id="256" r:id="rId1"/>`,
        {
          'ppt/_rels/presentation.xml.rels': PRESENTATION_RELS,
          'ppt/slides/_rels/slide1.xml.rels': `<Relationships xmlns="${NS.packageRel}">
            <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/>
          </Relationships>`,
          'ppt/notesSlides/notesSlide1.xml': `<p:notes xmlns:p="${NS.p}" xmlns:a="${NS.a}"><p:cSld><p:spTree>
            ${shape('sldNum', para('3'), 'Slide Number')}
            ${shape('body', para('Mention the zip reader.') + para('Then demo it.'), 'Notes')}
          </p:spTree></p:cSld></p:notes>`,
        },
      ),
    )
    // Only the body placeholder is the presenter's notes — the slide-number
    // placeholder is chrome.
    expect((await readPresentation(zip)).slides[0].notes).toBe(
      'Mention the zip reader.\nThen demo it.',
    )
  })

  it('reports an image-only slide as empty when it has no media either', async () => {
    const zip = readZip(
      await deck(
        { 'ppt/slides/slide1.xml': slide('') },
        `<p:sldId id="256" r:id="rId1"/>`,
        { 'ppt/_rels/presentation.xml.rels': PRESENTATION_RELS },
      ),
    )
    expect(slideIsEmpty((await readPresentation(zip)).slides[0])).toBe(true)
  })
})

describe('readPresentation images', () => {
  beforeEach(() => {
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:slide-image'),
      revokeObjectURL: vi.fn(),
    })
  })

  const pictureDeck = (target: string, media: ZipInput) =>
    deck(
      {
        'ppt/slides/slide1.xml': slide(`
          <p:pic>
            <p:nvPicPr><p:cNvPr id="4" name="Picture 4" descr="Architecture diagram"/></p:nvPicPr>
            <p:blipFill><a:blip r:embed="rId7"/></p:blipFill>
          </p:pic>`),
      },
      `<p:sldId id="256" r:id="rId1"/>`,
      {
        'ppt/_rels/presentation.xml.rels': PRESENTATION_RELS,
        'ppt/slides/_rels/slide1.xml.rels': `<Relationships xmlns="${NS.packageRel}">
          <Relationship Id="rId7" Type="http://x/image" Target="${target}"/>
        </Relationships>`,
        ...media,
      },
    )

  it('resolves slide pictures to object URLs with alt text', async () => {
    const zip = readZip(
      await pictureDeck('../media/image1.png', { 'ppt/media/image1.png': new Uint8Array([9, 9]) }),
    )
    const presentation = await readPresentation(zip)

    expect(presentation.slides[0].images).toEqual([
      { url: 'blob:slide-image', alt: 'Architecture diagram' },
    ])
    presentation.release()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:slide-image')
  })

  it('skips media a browser cannot display', async () => {
    const zip = readZip(
      await pictureDeck('../media/chart.wmf', { 'ppt/media/chart.wmf': new Uint8Array([1]) }),
    )
    expect((await readPresentation(zip)).slides[0].images).toEqual([])
  })
})
