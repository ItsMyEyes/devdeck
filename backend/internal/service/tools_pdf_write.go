package service

import (
	"bytes"
	"fmt"
	"strconv"
	"strings"

	"github.com/go-pdf/fpdf"
)

// renderPDF builds a PDF directly from the block IR via go-pdf/fpdf (pure
// Go, no cgo, no LaTeX engine like pandoc's default PDF path needed) --
// walking the same []docBlock the docx exporter consumes, so both formats
// stay in sync with a single markdown-structure implementation.
func renderPDF(blocks []docBlock) ([]byte, error) {
	pdf := fpdf.New("P", "mm", "A4", "")
	pdf.SetMargins(pdfMarginMM, pdfMarginMM, pdfMarginMM)
	pdf.SetAutoPageBreak(true, pdfMarginMM)
	pdf.AddPage()
	pdf.SetFont("Helvetica", "", 11)

	imgSeq := 0
	for _, b := range blocks {
		switch b.kind {
		case docBlockHeading:
			size := pdfHeadingSize(b.level)
			pdf.SetFont("Helvetica", "B", size)
			pdf.MultiCell(0, size*0.5, runsPlainText(b.runs), "", "L", false)
			pdf.SetFont("Helvetica", "", 11)
			pdf.Ln(2)

		case docBlockParagraph:
			if len(b.runs) == 0 {
				continue
			}
			writeInlineRuns(pdf, b.runs, 11)

		case docBlockBlockquote:
			pdf.SetTextColor(71, 85, 105)
			pdf.SetFont("Helvetica", "I", 11)
			pdf.MultiCell(0, 6, runsPlainText(b.runs), "", "L", false)
			pdf.SetFont("Helvetica", "", 11)
			pdf.SetTextColor(0, 0, 0)
			pdf.Ln(2)

		case docBlockListItem:
			left, _, _, _ := pdf.GetMargins()
			indent := float64(b.level) * 6
			marker := "-  "
			if b.ordered {
				marker = strconv.Itoa(b.number) + ".  "
			}
			if b.number < 0 {
				marker = "   "
				indent += 6
			}
			pdf.SetX(left + indent)
			pdf.MultiCell(0, 6, marker+runsPlainText(b.runs), "", "L", false)

		case docBlockCodeBlock:
			if b.lang == "mermaid (unrendered)" {
				pdf.SetFont("Helvetica", "I", 10)
				pdf.MultiCell(0, 5, "Mermaid diagram (could not be rendered -- showing source):", "", "L", false)
			}
			pdf.SetFont("Courier", "", 9)
			pdf.SetFillColor(241, 245, 249)
			pdf.MultiCell(0, 4.5, strings.TrimRight(b.code, "\n"), "", "L", true)
			pdf.SetFont("Helvetica", "", 11)
			pdf.Ln(2)

		case docBlockTable:
			renderPDFTable(pdf, b.rows)

		case docBlockHR:
			y := pdf.GetY()
			left, _, right, _ := pdf.GetMargins()
			pageW, _ := pdf.GetPageSize()
			pdf.SetDrawColor(148, 163, 184)
			pdf.Line(left, y, pageW-right, y)
			pdf.Ln(4)

		case docBlockImage:
			imgSeq++
			renderPDFImage(pdf, b.image, imgSeq)
		}
	}

	var buf bytes.Buffer
	if err := pdf.Output(&buf); err != nil {
		return nil, fmt.Errorf("render pdf: %w", err)
	}
	return buf.Bytes(), nil
}

const pdfMarginMM = 18.0

func pdfHeadingSize(level int) float64 {
	switch clampHeadingLevel(level) {
	case 1:
		return 20
	case 2:
		return 17
	case 3:
		return 15
	case 4:
		return 13
	case 5:
		return 12
	default:
		return 11
	}
}

// writeInlineRuns renders a paragraph's runs with mixed bold/italic/code
// styling by issuing successive Write() calls with the font changed between
// them -- fpdf continues text on the same flowing line (wrapping as needed)
// across calls as long as no Ln() happens in between, which is how the
// original FPDF library composes rich-text paragraphs from plain cells.
func writeInlineRuns(pdf *fpdf.Fpdf, runs []docRun, size float64) {
	for _, r := range runs {
		if r.text == "" {
			continue
		}
		if r.text == "\n" {
			pdf.Ln(size * 0.55)
			continue
		}
		fontFamily := "Helvetica"
		if r.code {
			fontFamily = "Courier"
		}
		style := ""
		if r.bold {
			style += "B"
		}
		if r.italic {
			style += "I"
		}
		pdf.SetFont(fontFamily, style, size)
		pdf.Write(size*0.5, r.text)
	}
	pdf.SetFont("Helvetica", "", size)
	pdf.Ln(size * 0.7)
}

func renderPDFTable(pdf *fpdf.Fpdf, rows [][]docCell) {
	if len(rows) == 0 {
		return
	}
	cols := 0
	for _, r := range rows {
		if len(r) > cols {
			cols = len(r)
		}
	}
	if cols == 0 {
		return
	}

	left, _, right, _ := pdf.GetMargins()
	pageW, _ := pdf.GetPageSize()
	colW := (pageW - left - right) / float64(cols)
	const lineH = 5.0
	const cellPad = 1.5

	for ri, row := range rows {
		style := ""
		if ri == 0 {
			style = "B"
		}
		pdf.SetFont("Helvetica", style, 9)

		cellLines := make([][]string, cols)
		maxLines := 1
		for ci := 0; ci < cols; ci++ {
			var text string
			if ci < len(row) {
				text = runsPlainText(row[ci].runs)
			}
			raw := pdf.SplitLines([]byte(text), colW-2*cellPad)
			lines := make([]string, len(raw))
			for i, l := range raw {
				lines[i] = string(l)
			}
			if len(lines) == 0 {
				lines = []string{""}
			}
			cellLines[ci] = lines
			if len(lines) > maxLines {
				maxLines = len(lines)
			}
		}
		rowH := float64(maxLines)*lineH + 2*cellPad

		y := pdf.GetY()
		x := left
		if ri == 0 {
			pdf.SetFillColor(226, 232, 240)
		} else {
			pdf.SetFillColor(255, 255, 255)
		}
		for ci := 0; ci < cols; ci++ {
			pdf.Rect(x, y, colW, rowH, "FD")
			pdf.SetXY(x+cellPad, y+cellPad)
			pdf.MultiCell(colW-2*cellPad, lineH, strings.Join(cellLines[ci], "\n"), "", "L", false)
			x += colW
		}
		pdf.SetXY(left, y+rowH)
	}
	pdf.SetFont("Helvetica", "", 11)
	pdf.Ln(3)
}

// renderPDFImage embeds an image at the current cursor position, scaled to
// fit the page width. If the image data is malformed, fpdf's internal error
// state would otherwise turn every subsequent draw call into a silent no-op
// -- clearing it here means one bad image degrades to a text placeholder
// instead of truncating the rest of the export.
func renderPDFImage(pdf *fpdf.Fpdf, img *docImage, seq int) {
	if img == nil || len(img.data) == 0 {
		return
	}
	typ := "PNG"
	if bytes.HasPrefix(img.data, []byte{0xFF, 0xD8, 0xFF}) {
		typ = "JPEG"
	}

	name := fmt.Sprintf("img-%d", seq)
	wasOK := pdf.Ok()
	info := pdf.RegisterImageOptionsReader(name, fpdf.ImageOptions{ImageType: typ, ReadDpi: false}, bytes.NewReader(img.data))
	if info == nil || (!pdf.Ok() && wasOK) {
		pdf.ClearError()
		pdf.SetFont("Helvetica", "I", 10)
		pdf.MultiCell(0, 5, "[image could not be embedded]", "", "L", false)
		pdf.SetFont("Helvetica", "", 11)
		return
	}

	left, _, right, _ := pdf.GetMargins()
	pageW, _ := pdf.GetPageSize()
	usable := pageW - left - right

	wMM, hMM := usable, usable*0.6
	if img.widthPx > 0 && img.heightPx > 0 {
		wMM = float64(img.widthPx) * 25.4 / 96.0
		if wMM > usable {
			wMM = usable
		}
		hMM = wMM * float64(img.heightPx) / float64(img.widthPx)
	}

	y := pdf.GetY()
	pageH, _ := pdf.GetPageSize()
	if y+hMM > pageH-pdfMarginMM {
		pdf.AddPage()
		y = pdf.GetY()
	}
	pdf.ImageOptions(name, left, y, wMM, hMM, false, fpdf.ImageOptions{ImageType: typ}, 0, "")
	pdf.SetY(y + hMM + 4)
}
