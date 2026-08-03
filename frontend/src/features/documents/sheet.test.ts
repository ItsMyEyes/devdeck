import { describe, expect, it } from 'vitest'
import { NS } from './ooxml'
import {
  columnLabel,
  formatExcelDate,
  isDateFormatCode,
  MAX_COLUMNS,
  MAX_ROWS,
  parseCellRef,
  readWorkbook,
} from './sheet'
import { buildZip } from './testZip'
import type { ZipInput } from './testZip'
import { readZip } from './zip'

describe('parseCellRef', () => {
  it('converts A1 notation to 0-based coordinates', () => {
    expect(parseCellRef('A1')).toEqual({ column: 0, row: 0 })
    expect(parseCellRef('B3')).toEqual({ column: 1, row: 2 })
    expect(parseCellRef('Z1')).toEqual({ column: 25, row: 0 })
    expect(parseCellRef('AA1')).toEqual({ column: 26, row: 0 })
    expect(parseCellRef('BC12')).toEqual({ column: 54, row: 11 })
  })

  it('is case-insensitive and rejects malformed refs', () => {
    expect(parseCellRef('aa1')).toEqual({ column: 26, row: 0 })
    expect(parseCellRef('A')).toBeNull()
    expect(parseCellRef('1')).toBeNull()
    expect(parseCellRef('A0')).toBeNull()
    expect(parseCellRef('$A$1')).toBeNull()
  })
})

describe('columnLabel', () => {
  it('is the inverse of parseCellRef for the column part', () => {
    expect(columnLabel(0)).toBe('A')
    expect(columnLabel(25)).toBe('Z')
    expect(columnLabel(26)).toBe('AA')
    expect(columnLabel(51)).toBe('AZ')
    expect(columnLabel(701)).toBe('ZZ')
    for (const index of [0, 25, 26, 54, 701]) {
      expect(parseCellRef(`${columnLabel(index)}1`)?.column).toBe(index)
    }
  })
})

describe('isDateFormatCode', () => {
  it('detects date and time placeholders', () => {
    expect(isDateFormatCode('yyyy-mm-dd')).toBe(true)
    expect(isDateFormatCode('d/m/yy h:mm')).toBe(true)
    expect(isDateFormatCode('[h]:mm:ss')).toBe(true)
  })

  it('ignores letters inside quoted literals, escapes and bracket blocks', () => {
    // "Sold" contains a 'd'; [Red] contains a 'd'; \m is an escaped literal.
    expect(isDateFormatCode('"Sold"#,##0')).toBe(false)
    expect(isDateFormatCode('[Red]#,##0.00')).toBe(false)
    expect(isDateFormatCode('#,##0\\m')).toBe(false)
    expect(isDateFormatCode('0.00%')).toBe(false)
    expect(isDateFormatCode('General')).toBe(false)
  })
})

describe('formatExcelDate', () => {
  it('converts serials using the 1899-12-30 epoch', () => {
    expect(formatExcelDate(45000)).toBe('2023-03-15')
    expect(formatExcelDate(1)).toBe('1899-12-31')
  })

  it('renders a fractional serial as a date and time', () => {
    expect(formatExcelDate(45000.5)).toBe('2023-03-15 12:00')
  })

  it('renders a sub-1 serial as a bare time of day', () => {
    expect(formatExcelDate(0.75)).toBe('18:00')
  })

  it('rejects values that are not dates', () => {
    expect(formatExcelDate(0)).toBeNull()
    expect(formatExcelDate(-5)).toBeNull()
    expect(formatExcelDate(Number.NaN)).toBeNull()
  })
})

// ---- Workbook fixtures ----

const SHARED_STRINGS = `<sst xmlns="${NS.s}" count="4" uniqueCount="4">
  <si><t>Region</t></si>
  <si><t>Revenue</t></si>
  <si><r><t>EM</t></r><r><t>EA</t></r></si>
  <si><t>Signed</t></si>
</sst>`

const STYLES = `<styleSheet xmlns="${NS.s}">
  <numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/></numFmts>
  <cellXfs count="4">
    <xf numFmtId="0"/>
    <xf numFmtId="14"/>
    <xf numFmtId="164"/>
    <xf numFmtId="2"/>
  </cellXfs>
</styleSheet>`

function workbookZip(sheetsXml: string, parts: ZipInput = {}) {
  return buildZip({
    'xl/workbook.xml': `<workbook xmlns="${NS.s}" xmlns:r="${NS.rel}"><sheets>${sheetsXml}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships xmlns="${NS.packageRel}">
      <Relationship Id="rId1" Type="http://x/worksheet" Target="worksheets/sheet1.xml"/>
      <Relationship Id="rId2" Type="http://x/worksheet" Target="worksheets/sheet2.xml"/>
    </Relationships>`,
    'xl/sharedStrings.xml': SHARED_STRINGS,
    'xl/styles.xml': STYLES,
    ...parts,
  })
}

const sheetXml = (rows: string) => `<worksheet xmlns="${NS.s}"><sheetData>${rows}</sheetData></worksheet>`

describe('readWorkbook', () => {
  it('rejects a zip that is not a workbook', async () => {
    const zip = readZip(await buildZip({ 'word/document.xml': '<a/>' }))
    await expect(readWorkbook(zip)).rejects.toThrow(/not look like an Excel workbook/)
  })

  it('reads every cell type into a dense grid', async () => {
    const zip = readZip(
      await workbookZip(`<sheet name="Summary" sheetId="1" r:id="rId1"/>`, {
        'xl/worksheets/sheet1.xml': sheetXml(`
          <row r="1">
            <c r="A1" t="s"><v>0</v></c>
            <c r="B1" t="s"><v>1</v></c>
            <c r="C1" t="inlineStr"><is><t>Signed</t></is></c>
          </row>
          <row r="2">
            <c r="A2" t="s"><v>2</v></c>
            <c r="B2"><v>1204.5</v></c>
            <c r="C2" s="1"><v>45000</v></c>
          </row>
          <row r="4">
            <c r="A4" t="b"><v>1</v></c>
            <c r="B4" t="e"><v>#DIV/0!</v></c>
            <c r="C4" t="str"><v>cached result</v></c>
          </row>`),
      }),
    )

    const { sheets } = await readWorkbook(zip)
    expect(sheets).toHaveLength(1)
    expect(sheets[0].name).toBe('Summary')
    expect(sheets[0].rows).toEqual([
      ['Region', 'Revenue', 'Signed'],
      // Shared string 2 is split across two runs — they must concatenate.
      ['EMEA', '1204.5', '2023-03-15'],
      // Row 3 is absent from the file; the grid still has a row for it.
      ['', '', ''],
      ['TRUE', '#DIV/0!', 'cached result'],
    ])
  })

  it('formats dates only for cells whose style says so', async () => {
    const zip = readZip(
      await workbookZip(`<sheet name="Dates" sheetId="1" r:id="rId1"/>`, {
        'xl/worksheets/sheet1.xml': sheetXml(`
          <row r="1">
            <c r="A1" s="0"><v>45000</v></c>
            <c r="B1" s="1"><v>45000</v></c>
            <c r="C1" s="2"><v>45000</v></c>
            <c r="D1" s="3"><v>45000</v></c>
          </row>`),
      }),
    )

    const [sheet] = (await readWorkbook(zip)).sheets
    // General and the "0.00" number format stay numeric; the built-in date
    // format (14) and the custom yyyy-mm-dd (164) become dates.
    expect(sheet.rows[0]).toEqual(['45000', '2023-03-15', '2023-03-15', '45000'])
  })

  it('reads ISO date cells verbatim', async () => {
    const zip = readZip(
      await workbookZip(`<sheet name="ISO" sheetId="1" r:id="rId1"/>`, {
        'xl/worksheets/sheet1.xml': sheetXml(
          `<row r="1"><c r="A1" t="d"><v>2024-06-01T09:30:00</v></c></row>`,
        ),
      }),
    )
    expect((await readWorkbook(zip)).sheets[0].rows[0][0]).toBe('2024-06-01T09:30:00')
  })

  it('keeps multiple sheets in workbook order and skips hidden ones', async () => {
    const zip = readZip(
      await workbookZip(
        `<sheet name="Summary" sheetId="1" r:id="rId1"/>
         <sheet name="Lookups" sheetId="2" state="hidden" r:id="rId2"/>`,
        {
          'xl/worksheets/sheet1.xml': sheetXml(`<row r="1"><c r="A1"><v>1</v></c></row>`),
          'xl/worksheets/sheet2.xml': sheetXml(`<row r="1"><c r="A1"><v>2</v></c></row>`),
        },
      ),
    )
    const { sheets } = await readWorkbook(zip)
    expect(sheets.map((sheet) => sheet.name)).toEqual(['Summary'])
  })

  it('handles a workbook with no shared strings or styles', async () => {
    const zip = readZip(
      await buildZip({
        'xl/workbook.xml': `<workbook xmlns="${NS.s}" xmlns:r="${NS.rel}"><sheets><sheet name="Bare" sheetId="1" r:id="rId1"/></sheets></workbook>`,
        'xl/_rels/workbook.xml.rels': `<Relationships xmlns="${NS.packageRel}">
          <Relationship Id="rId1" Type="http://x/worksheet" Target="worksheets/sheet1.xml"/>
        </Relationships>`,
        'xl/worksheets/sheet1.xml': sheetXml(`<row r="1"><c r="A1"><v>42</v></c></row>`),
      }),
    )
    expect((await readWorkbook(zip)).sheets[0].rows).toEqual([['42']])
  })

  it('positions cells by their ref rather than their order in the row', async () => {
    const zip = readZip(
      await workbookZip(`<sheet name="Sparse" sheetId="1" r:id="rId1"/>`, {
        'xl/worksheets/sheet1.xml': sheetXml(
          `<row r="1"><c r="A1"><v>1</v></c><c r="D1"><v>4</v></c></row>`,
        ),
      }),
    )
    const [sheet] = (await readWorkbook(zip)).sheets
    expect(sheet.columnCount).toBe(4)
    expect(sheet.rows[0]).toEqual(['1', '', '', '4'])
  })

  it('clips oversized sheets and reports the real extent', async () => {
    const rows = Array.from(
      { length: MAX_ROWS + 10 },
      (_, index) => `<row r="${index + 1}"><c r="A${index + 1}"><v>${index}</v></c></row>`,
    ).join('')
    const zip = readZip(
      await workbookZip(`<sheet name="Big" sheetId="1" r:id="rId1"/>`, {
        'xl/worksheets/sheet1.xml': sheetXml(rows),
      }),
    )

    const [sheet] = (await readWorkbook(zip)).sheets
    expect(sheet.rows).toHaveLength(MAX_ROWS)
    expect(sheet.truncated).toBe(true)
    expect(sheet.totalRows).toBe(MAX_ROWS + 10)
    expect(sheet.columnCount).toBeLessThanOrEqual(MAX_COLUMNS)
  })

  it('rejects a workbook whose sheets cannot be resolved', async () => {
    const zip = readZip(
      await buildZip({
        'xl/workbook.xml': `<workbook xmlns="${NS.s}" xmlns:r="${NS.rel}"><sheets><sheet name="Gone" sheetId="1" r:id="rIdMissing"/></sheets></workbook>`,
      }),
    )
    await expect(readWorkbook(zip)).rejects.toThrow(/no readable sheets/)
  })
})
