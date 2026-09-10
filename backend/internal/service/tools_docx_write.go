package service

import (
	"archive/zip"
	"bytes"
	"fmt"
	"strconv"
	"strings"
)

// renderDocx builds a .docx file directly as a zipped OOXML package (stdlib
// archive/zip + hand-written XML) -- no pandoc, no third-party docx library.
// This is the "tanpa membuat files rusak" guarantee for exports: every part
// required by the OOXML WordprocessingML spec ([Content_Types].xml, the
// package/document relationships, styles.xml, and one word/media/* entry per
// embedded image) is written explicitly, so the result is a structurally
// valid docx Word can open, not just a non-empty blob.
func renderDocx(blocks []docBlock) ([]byte, error) {
	var body strings.Builder
	var images []docxImageRef
	imgSeq := 0
	linker := newDocxLinker()

	for _, b := range blocks {
		switch b.kind {
		case docBlockHeading:
			body.WriteString(docxParagraphXML(fmt.Sprintf("Heading%d", clampHeadingLevel(b.level)), b.runs, 0, linker))
		case docBlockParagraph:
			if len(b.runs) == 0 {
				continue
			}
			body.WriteString(docxParagraphXML("Normal", b.runs, 0, linker))
		case docBlockBlockquote:
			body.WriteString(docxParagraphXML("Quote", b.runs, 0, linker))
		case docBlockListItem:
			if b.number < 0 {
				body.WriteString(docxParagraphXML("ListParagraph", b.runs, b.level+1, linker))
				continue
			}
			marker := "•   "
			if b.ordered {
				marker = strconv.Itoa(b.number) + ".  "
			}
			runs := append([]docRun{{text: marker}}, b.runs...)
			body.WriteString(docxParagraphXML("ListParagraph", runs, b.level, linker))
		case docBlockCodeBlock:
			body.WriteString(docxCodeBlockXML(b, linker))
		case docBlockTable:
			body.WriteString(docxTableXML(b.rows, linker))
		case docBlockHR:
			body.WriteString(`<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="94A3B8"/></w:pBdr></w:pPr></w:p>` + "\n")
		case docBlockImage:
			if b.image == nil || len(b.image.data) == 0 {
				continue
			}
			imgSeq++
			ref := docxImageRef{id: imgSeq, data: b.image.data, ext: sniffImageExt(b.image.data)}
			cx, cy := docxImageEMU(b.image.widthPx, b.image.heightPx)
			body.WriteString(docxImageXML(ref, cx, cy))
			images = append(images, ref)
		}
	}

	return buildDocxZip(body.String(), images, linker.refs)
}

// docxLinkRef is one hyperlink relationship: OOXML requires a link's target
// URL to live in word/_rels/document.xml.rels, referenced from the body by
// relationship id, rather than appearing inline the way HTML's href does.
type docxLinkRef struct {
	id     int
	target string
}

// docxLinker assigns a stable relationship id to each distinct link target
// seen while walking the document, so two runs pointing at the same URL —
// common for a repeated citation or footer link — share one relationship
// instead of the rels file growing a duplicate per occurrence.
type docxLinker struct {
	ids  map[string]int
	refs []docxLinkRef
}

func newDocxLinker() *docxLinker {
	return &docxLinker{ids: map[string]int{}}
}

func (l *docxLinker) idFor(href string) int {
	if id, ok := l.ids[href]; ok {
		return id
	}
	id := len(l.refs) + 1
	l.ids[href] = id
	l.refs = append(l.refs, docxLinkRef{id: id, target: href})
	return id
}

func clampHeadingLevel(l int) int {
	if l < 1 {
		return 1
	}
	if l > 6 {
		return 6
	}
	return l
}

var xmlTextReplacer = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;")

func xmlEscapeText(s string) string { return xmlTextReplacer.Replace(s) }

// xmlEscapeAttr additionally escapes quotes, which xmlEscapeText's callers
// never need since they only ever write into element text content — but a
// link's href goes into a double-quoted XML attribute, where a literal `"`
// would close it early.
var xmlAttrReplacer = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;")

func xmlEscapeAttr(s string) string { return xmlAttrReplacer.Replace(s) }

func docxParagraphXML(style string, runs []docRun, indentLevel int, linker *docxLinker) string {
	var sb strings.Builder
	sb.WriteString("<w:p><w:pPr>")
	sb.WriteString(`<w:pStyle w:val="` + style + `"/>`)
	if indentLevel > 0 {
		sb.WriteString(fmt.Sprintf(`<w:ind w:left="%d"/>`, indentLevel*360))
	}
	sb.WriteString("</w:pPr>")
	sb.WriteString(docxRunsXML(runs, linker))
	sb.WriteString("</w:p>\n")
	return sb.String()
}

func docxRunsXML(runs []docRun, linker *docxLinker) string {
	var sb strings.Builder
	for _, r := range runs {
		run := docxRunXML(r)
		if run == "" {
			continue
		}
		if r.href == "" {
			sb.WriteString(run)
			continue
		}
		sb.WriteString(fmt.Sprintf(`<w:hyperlink r:id="rIdLink%d" w:history="1">`, linker.idFor(r.href)))
		sb.WriteString(run)
		sb.WriteString(`</w:hyperlink>`)
	}
	return sb.String()
}

func docxRunXML(r docRun) string {
	if r.text == "" {
		return ""
	}
	if r.text == "\n" {
		return "<w:r><w:br/></w:r>"
	}
	var sb strings.Builder
	sb.WriteString("<w:r>")
	var rpr strings.Builder
	if r.bold {
		rpr.WriteString("<w:b/>")
	}
	if r.italic {
		rpr.WriteString("<w:i/>")
	}
	if r.code {
		rpr.WriteString(`<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>`)
	}
	if r.href != "" {
		// Word's own "Hyperlink" character style, applied by value rather
		// than as a named w:rStyle so a link keeps its color/underline even
		// without adding that style to styles.xml.
		rpr.WriteString(`<w:color w:val="2563EB"/><w:u w:val="single"/>`)
	}
	if rpr.Len() > 0 {
		sb.WriteString("<w:rPr>" + rpr.String() + "</w:rPr>")
	}
	sb.WriteString(`<w:t xml:space="preserve">` + xmlEscapeText(r.text) + `</w:t>`)
	sb.WriteString("</w:r>")
	return sb.String()
}

func docxCodeBlockXML(b docBlock, linker *docxLinker) string {
	var sb strings.Builder
	if b.lang == "mermaid (unrendered)" {
		sb.WriteString(docxParagraphXML("Normal", []docRun{{text: "Mermaid diagram (could not be rendered — showing source):", italic: true}}, 0, linker))
	}
	code := strings.TrimRight(b.code, "\n")
	for _, line := range strings.Split(code, "\n") {
		if line == "" {
			line = " "
		}
		sb.WriteString(docxParagraphXML("CodeBlock", []docRun{{text: line, code: true}}, 0, linker))
	}
	return sb.String()
}

func docxTableXML(rows [][]docCell, linker *docxLinker) string {
	if len(rows) == 0 {
		return ""
	}
	cols := 0
	for _, r := range rows {
		if len(r) > cols {
			cols = len(r)
		}
	}
	if cols == 0 {
		return ""
	}
	colW := 9000 / cols

	var sb strings.Builder
	sb.WriteString(`<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>` +
		`<w:top w:val="single" w:sz="4" w:color="94A3B8"/><w:left w:val="single" w:sz="4" w:color="94A3B8"/>` +
		`<w:bottom w:val="single" w:sz="4" w:color="94A3B8"/><w:right w:val="single" w:sz="4" w:color="94A3B8"/>` +
		`<w:insideH w:val="single" w:sz="4" w:color="94A3B8"/><w:insideV w:val="single" w:sz="4" w:color="94A3B8"/>` +
		`</w:tblBorders></w:tblPr><w:tblGrid>`)
	for i := 0; i < cols; i++ {
		sb.WriteString(fmt.Sprintf(`<w:gridCol w:w="%d"/>`, colW))
	}
	sb.WriteString("</w:tblGrid>\n")

	for ri, row := range rows {
		sb.WriteString("<w:tr>")
		for ci := 0; ci < cols; ci++ {
			var cell docCell
			if ci < len(row) {
				cell = row[ci]
			}
			runs := cell.runs
			if ri == 0 {
				bolded := make([]docRun, len(runs))
				for i, r := range runs {
					r.bold = true
					bolded[i] = r
				}
				runs = bolded
			}
			sb.WriteString(fmt.Sprintf(`<w:tc><w:tcPr><w:tcW w:w="%d" w:type="dxa"/></w:tcPr>`, colW))
			sb.WriteString(docxParagraphXML("Normal", runs, 0, linker))
			sb.WriteString("</w:tc>")
		}
		sb.WriteString("</w:tr>\n")
	}
	sb.WriteString("</w:tbl>\n")
	return sb.String()
}

type docxImageRef struct {
	id   int
	data []byte
	ext  string
}

// docxImageEMU converts pixel dimensions to EMUs (914400 per inch, so 9525
// per pixel at the conventional 96dpi), capping width so an oversized
// diagram doesn't blow out the page.
func docxImageEMU(wPx, hPx int) (int64, int64) {
	if wPx <= 0 || hPx <= 0 {
		wPx, hPx = 400, 300
	}
	const maxW = 600
	if wPx > maxW {
		hPx = hPx * maxW / wPx
		wPx = maxW
	}
	const emuPerPx = 9525
	return int64(wPx) * emuPerPx, int64(hPx) * emuPerPx
}

func sniffImageExt(data []byte) string {
	if bytes.HasPrefix(data, []byte("\x89PNG\r\n\x1a\n")) {
		return "png"
	}
	if bytes.HasPrefix(data, []byte{0xFF, 0xD8, 0xFF}) {
		return "jpeg"
	}
	return "png"
}

func docxImageXML(ref docxImageRef, cx, cy int64) string {
	rid := fmt.Sprintf("rIdImg%d", ref.id)
	return fmt.Sprintf(`<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">`+
		`<wp:extent cx="%d" cy="%d"/><wp:effectExtent l="0" t="0" r="0" b="0"/>`+
		`<wp:docPr id="%d" name="Picture %d"/>`+
		`<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>`+
		`<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">`+
		`<pic:pic><pic:nvPicPr><pic:cNvPr id="%d" name="image%d.%s"/><pic:cNvPicPr/></pic:nvPicPr>`+
		`<pic:blipFill><a:blip r:embed="%s"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`+
		`<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="%d" cy="%d"/></a:xfrm>`+
		`<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>`+
		`</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`+"\n",
		cx, cy, ref.id, ref.id, ref.id, ref.id, ref.ext, rid, cx, cy)
}

func buildDocxZip(bodyXML string, images []docxImageRef, links []docxLinkRef) ([]byte, error) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)

	write := func(name string, content []byte) error {
		w, err := zw.Create(name)
		if err != nil {
			return err
		}
		_, err = w.Write(content)
		return err
	}

	contentTypes := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Default Extension="jpeg" ContentType="image/jpeg"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`
	if err := write("[Content_Types].xml", []byte(contentTypes)); err != nil {
		return nil, err
	}

	rootRels := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`
	if err := write("_rels/.rels", []byte(rootRels)); err != nil {
		return nil, err
	}

	var docRels strings.Builder
	docRels.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`)
	for _, img := range images {
		docRels.WriteString(fmt.Sprintf(`<Relationship Id="rIdImg%d" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image%d.%s"/>`, img.id, img.id, img.ext))
	}
	for _, link := range links {
		// TargetMode="External" is what tells Word this Target is a URL to
		// open, not a path to another part inside this same package.
		docRels.WriteString(fmt.Sprintf(`<Relationship Id="rIdLink%d" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="%s" TargetMode="External"/>`, link.id, xmlEscapeAttr(link.target)))
	}
	docRels.WriteString("</Relationships>")
	if err := write("word/_rels/document.xml.rels", []byte(docRels.String())); err != nil {
		return nil, err
	}

	document := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ` +
		`xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ` +
		`xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
		`xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" ` +
		`xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
		`<w:body>` + bodyXML +
		`<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>` +
		`</w:body></w:document>`
	if err := write("word/document.xml", []byte(document)); err != nil {
		return nil, err
	}

	if err := write("word/styles.xml", []byte(docxStylesXML)); err != nil {
		return nil, err
	}

	for _, img := range images {
		if err := write(fmt.Sprintf("word/media/image%d.%s", img.id, img.ext), img.data); err != nil {
			return nil, err
		}
	}

	if err := zw.Close(); err != nil {
		return nil, fmt.Errorf("finalize docx zip: %w", err)
	}
	return buf.Bytes(), nil
}

const docxStylesXML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="200" w:after="100"/></w:pPr><w:rPr><w:b/><w:sz w:val="30"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="160" w:after="80"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading5"><w:name w:val="heading 5"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="22"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading6"><w:name w:val="heading 6"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:i/><w:sz w:val="22"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="360"/></w:pPr><w:rPr><w:i/><w:color w:val="475569"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="CodeBlock"><w:name w:val="Code Block"/><w:basedOn w:val="Normal"/><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="20"/></w:rPr></w:style>
</w:styles>`
