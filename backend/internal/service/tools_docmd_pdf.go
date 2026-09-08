package service

import (
	"bytes"
	"fmt"
	"sort"
	"strings"

	"github.com/ledongthuc/pdf"
)

// pdfLine is one visual line of a PDF page: its glyphs (already left-to-right
// sorted) and the largest font size among them, which is the signal used to
// recover heading structure -- PDF has no notion of "heading", only text
// drawn in a bigger font.
type pdfLine struct {
	y       int64
	maxSize float64
	text    strings.Builder
}

// pdfToMarkdown extracts text from a PDF via github.com/ledongthuc/pdf (pure
// Go) and reconstructs heading structure from font-size geometry: lines drawn
// in a noticeably larger font than the page's body text become markdown
// headings, mirroring what pymupdf4llm did for the Python-based converter
// this replaces. Returns an UnsupportedFormatError if the PDF has no
// extractable text (e.g. a scanned/image-only PDF) rather than a silent
// empty success.
func pdfToMarkdown(data []byte) (string, error) {
	r, err := pdf.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return "", fmt.Errorf("open pdf: %w", err)
	}

	var sb strings.Builder
	for i := 1; i <= r.NumPage(); i++ {
		page := r.Page(i)
		if page.V.IsNull() {
			continue
		}
		pageMD, err := pdfPageToMarkdown(page)
		if err != nil {
			continue // a single malformed page shouldn't sink the whole document
		}
		if pageMD != "" {
			if sb.Len() > 0 {
				sb.WriteString("\n")
			}
			sb.WriteString(pageMD)
		}
	}

	text := sb.String()
	if strings.TrimSpace(text) == "" {
		return "", &UnsupportedFormatError{Format: ".pdf", Reason: "no extractable text (scanned/image PDF)"}
	}
	return text, nil
}

func pdfPageToMarkdown(page pdf.Page) (string, error) {
	content := page.Content()
	if len(content.Text) == 0 {
		return "", nil
	}

	lines := groupPDFTextIntoLines(content.Text)
	if len(lines) == 0 {
		return "", nil
	}

	bodySize := modePDFFontSize(lines)

	var sb strings.Builder
	for _, ln := range lines {
		text := strings.TrimSpace(ln.text.String())
		if text == "" {
			continue
		}
		switch {
		case bodySize > 0 && ln.maxSize >= bodySize*1.6:
			sb.WriteString("# " + text + "\n\n")
		case bodySize > 0 && ln.maxSize >= bodySize*1.25:
			sb.WriteString("## " + text + "\n\n")
		case bodySize > 0 && ln.maxSize >= bodySize*1.1:
			sb.WriteString("### " + text + "\n\n")
		default:
			sb.WriteString(text + "\n\n")
		}
	}
	return sb.String(), nil
}

// groupPDFTextIntoLines buckets glyphs into visual lines by Y coordinate
// (rounded to the nearest point, which tolerates the sub-point kerning jitter
// real PDFs have) and orders each line left-to-right by X.
func groupPDFTextIntoLines(texts []pdf.Text) []*pdfLine {
	byY := make(map[int64]*pdfLine)
	var order []int64
	for _, t := range texts {
		if t.S == "\n" {
			continue
		}
		y := int64(t.Y + 0.5)
		if ln, ok := byY[y]; ok {
			if t.FontSize > ln.maxSize {
				ln.maxSize = t.FontSize
			}
		} else {
			byY[y] = &pdfLine{y: y, maxSize: t.FontSize}
			order = append(order, y)
		}
	}

	sortedTexts := make(pdf.TextHorizontal, 0, len(texts))
	for _, t := range texts {
		if t.S != "\n" {
			sortedTexts = append(sortedTexts, t)
		}
	}
	sort.SliceStable(sortedTexts, func(i, j int) bool {
		yi, yj := int64(sortedTexts[i].Y+0.5), int64(sortedTexts[j].Y+0.5)
		if yi != yj {
			return yi > yj // top of page first
		}
		return sortedTexts[i].X < sortedTexts[j].X
	})
	for _, t := range sortedTexts {
		y := int64(t.Y + 0.5)
		byY[y].text.WriteString(t.S)
	}

	sort.Slice(order, func(i, j int) bool { return order[i] > order[j] })
	lines := make([]*pdfLine, 0, len(order))
	for _, y := range order {
		lines = append(lines, byY[y])
	}
	return lines
}

// modePDFFontSize returns the most common line font size on the page, taken
// as the body-text baseline that heading sizes are compared against.
func modePDFFontSize(lines []*pdfLine) float64 {
	counts := make(map[float64]int)
	best, bestCount := 0.0, 0
	for _, ln := range lines {
		counts[ln.maxSize]++
		if counts[ln.maxSize] > bestCount {
			best, bestCount = ln.maxSize, counts[ln.maxSize]
		}
	}
	return best
}
