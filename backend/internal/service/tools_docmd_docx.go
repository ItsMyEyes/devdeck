package service

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"fmt"
	"io"
	"strconv"
	"strings"
)

// docx (and pptx) are just zipped XML -- OOXML -- so reading them back needs
// no third-party library, only stdlib archive/zip + encoding/xml.

type docxRun struct {
	Text string `xml:"t"`
}

type docxRPr struct {
	B *struct{} `xml:"b"`
	I *struct{} `xml:"i"`
}

type docxRunFull struct {
	RPr  *docxRPr   `xml:"rPr"`
	Text []string   `xml:"t"`
	Tab  []struct{} `xml:"tab"`
	Br   []struct{} `xml:"br"`
}

type docxHyperlink struct {
	Runs []docxRunFull `xml:"r"`
}

type docxPStyle struct {
	Val string `xml:"val,attr"`
}

type docxNumPr struct {
	// presence alone (regardless of children) marks the paragraph as a list item
}

type docxPPr struct {
	PStyle *docxPStyle `xml:"pStyle"`
	NumPr  *docxNumPr  `xml:"numPr"`
}

type docxParagraph struct {
	PPr        *docxPPr        `xml:"pPr"`
	Runs       []docxRunFull   `xml:"r"`
	Hyperlinks []docxHyperlink `xml:"hyperlink"`
}

type docxCell struct {
	Paragraphs []docxParagraph `xml:"p"`
}

type docxTableRow struct {
	Cells []docxCell `xml:"tc"`
}

type docxTable struct {
	Rows []docxTableRow `xml:"tr"`
}

// docxToMarkdown reads word/document.xml out of the docx zip and renders its
// paragraphs and tables to markdown, in document order (a token-stream walk,
// since encoding/xml's normal unmarshal-into-struct loses sibling ordering
// between different element types like <w:p> and <w:tbl>).
func docxToMarkdown(data []byte) (string, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return "", fmt.Errorf("open docx: %w", err)
	}
	body, err := readZipEntry(zr, "word/document.xml")
	if err != nil {
		return "", fmt.Errorf("read document.xml: %w", err)
	}
	md, err := docxBodyToMarkdown(body)
	if err != nil {
		return "", fmt.Errorf("parse document.xml: %w", err)
	}
	if strings.TrimSpace(md) == "" {
		return "", &UnsupportedFormatError{Format: ".docx", Reason: "document has no extractable text"}
	}
	return md, nil
}

func readZipEntry(zr *zip.Reader, name string) ([]byte, error) {
	for _, f := range zr.File {
		if f.Name == name {
			rc, err := f.Open()
			if err != nil {
				return nil, err
			}
			defer rc.Close()
			return io.ReadAll(rc)
		}
	}
	return nil, fmt.Errorf("%s not found in archive", name)
}

func docxBodyToMarkdown(xmlData []byte) (string, error) {
	dec := xml.NewDecoder(bytes.NewReader(xmlData))
	var sb strings.Builder
	for {
		tok, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", err
		}
		se, ok := tok.(xml.StartElement)
		if !ok {
			continue
		}
		switch se.Name.Local {
		case "p":
			var p docxParagraph
			if err := dec.DecodeElement(&p, &se); err != nil {
				return "", err
			}
			sb.WriteString(docxParagraphToMarkdown(p))
		case "tbl":
			var tbl docxTable
			if err := dec.DecodeElement(&tbl, &se); err != nil {
				return "", err
			}
			sb.WriteString(docxTableToMarkdown(tbl))
		}
	}
	return sb.String(), nil
}

func docxParagraphText(p docxParagraph) string {
	var sb strings.Builder
	for _, r := range p.Runs {
		for _, t := range r.Text {
			sb.WriteString(t)
		}
		if len(r.Tab) > 0 {
			sb.WriteString("\t")
		}
	}
	for _, h := range p.Hyperlinks {
		for _, r := range h.Runs {
			for _, t := range r.Text {
				sb.WriteString(t)
			}
		}
	}
	return sb.String()
}

var docxHeadingLevel = map[string]int{
	"title":    1,
	"heading1": 1, "heading2": 2, "heading3": 3,
	"heading4": 4, "heading5": 5, "heading6": 6,
	"heading7": 6, "heading8": 6, "heading9": 6,
}

func docxParagraphToMarkdown(p docxParagraph) string {
	text := strings.TrimSpace(docxParagraphText(p))
	if text == "" {
		return ""
	}
	if p.PPr != nil && p.PPr.PStyle != nil {
		key := strings.ToLower(strings.ReplaceAll(p.PPr.PStyle.Val, " ", ""))
		if level, ok := docxHeadingLevel[key]; ok {
			return strings.Repeat("#", level) + " " + text + "\n\n"
		}
	}
	if p.PPr != nil && p.PPr.NumPr != nil {
		return "- " + text + "\n"
	}
	return text + "\n\n"
}

func docxTableToMarkdown(tbl docxTable) string {
	if len(tbl.Rows) == 0 {
		return ""
	}
	rows := make([][]string, 0, len(tbl.Rows))
	for _, row := range tbl.Rows {
		cells := make([]string, 0, len(row.Cells))
		for _, cell := range row.Cells {
			var parts []string
			for _, p := range cell.Paragraphs {
				if t := strings.TrimSpace(docxParagraphText(p)); t != "" {
					parts = append(parts, t)
				}
			}
			cells = append(cells, strings.Join(parts, " "))
		}
		rows = append(rows, cells)
	}
	return rowsToMarkdownTable(rows) + "\n"
}

// pptx: each slide is ppt/slides/slideN.xml. We extract text runs in
// document order and treat the first title-placeholder shape's text as the
// slide heading.

type pptxTextBody struct {
	Paragraphs []pptxParagraph `xml:"p"`
}

type pptxParagraph struct {
	Runs []pptxRun `xml:"r"`
}

type pptxRun struct {
	Text string `xml:"t"`
}

type pptxPlaceholder struct {
	Type string `xml:"type,attr"`
}

type pptxNvSpPr struct {
	PH *pptxPlaceholder `xml:"nvPr>ph"`
}

type pptxShape struct {
	NvSpPr   pptxNvSpPr   `xml:"nvSpPr"`
	TextBody pptxTextBody `xml:"txBody"`
}

func pptxToMarkdown(data []byte) (string, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return "", fmt.Errorf("open pptx: %w", err)
	}

	var slideNames []string
	for _, f := range zr.File {
		if strings.HasPrefix(f.Name, "ppt/slides/slide") && strings.HasSuffix(f.Name, ".xml") {
			slideNames = append(slideNames, f.Name)
		}
	}
	sortSlideNames(slideNames)
	if len(slideNames) == 0 {
		return "", &UnsupportedFormatError{Format: ".pptx", Reason: "no slides found"}
	}

	var sb strings.Builder
	for i, name := range slideNames {
		body, err := readZipEntry(zr, name)
		if err != nil {
			continue
		}
		slideMD, err := pptxSlideToMarkdown(body)
		if err != nil || strings.TrimSpace(slideMD) == "" {
			continue
		}
		if i > 0 {
			sb.WriteString("\n---\n\n")
		}
		sb.WriteString(slideMD)
	}

	md := sb.String()
	if strings.TrimSpace(md) == "" {
		return "", &UnsupportedFormatError{Format: ".pptx", Reason: "presentation has no extractable text"}
	}
	return md, nil
}

// sortSlideNames orders slideN.xml by numeric N, not lexicographically
// (slide2.xml must sort before slide10.xml).
func sortSlideNames(names []string) {
	num := func(name string) int {
		base := strings.TrimSuffix(strings.TrimPrefix(name, "ppt/slides/slide"), ".xml")
		n, _ := strconv.Atoi(base)
		return n
	}
	for i := 1; i < len(names); i++ {
		for j := i; j > 0 && num(names[j-1]) > num(names[j]); j-- {
			names[j-1], names[j] = names[j], names[j-1]
		}
	}
}

func pptxSlideToMarkdown(xmlData []byte) (string, error) {
	dec := xml.NewDecoder(bytes.NewReader(xmlData))
	var sb strings.Builder
	first := true
	for {
		tok, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", err
		}
		se, ok := tok.(xml.StartElement)
		if !ok || se.Name.Local != "sp" {
			continue
		}
		var shape pptxShape
		if err := dec.DecodeElement(&shape, &se); err != nil {
			return "", err
		}
		isTitle := shape.NvSpPr.PH != nil && (shape.NvSpPr.PH.Type == "title" || shape.NvSpPr.PH.Type == "ctrTitle")
		for _, p := range shape.TextBody.Paragraphs {
			var line strings.Builder
			for _, r := range p.Runs {
				line.WriteString(r.Text)
			}
			text := strings.TrimSpace(line.String())
			if text == "" {
				continue
			}
			if isTitle && first {
				sb.WriteString("## " + text + "\n\n")
				first = false
			} else {
				sb.WriteString("- " + text + "\n")
			}
		}
	}
	return sb.String(), nil
}
