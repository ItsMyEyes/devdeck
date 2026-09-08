package service

import (
	"bytes"
	"encoding/base64"
	"image"
	_ "image/png"
	"strings"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	extast "github.com/yuin/goldmark/extension/ast"
	"github.com/yuin/goldmark/parser"
	"github.com/yuin/goldmark/text"
)

// docBlock and docRun are a small intermediate representation that both the
// docx and pdf exporters render from, built once by walking the goldmark AST
// so the two backends don't duplicate markdown-structure logic.

type docBlockKind int

const (
	docBlockParagraph docBlockKind = iota
	docBlockHeading
	docBlockListItem
	docBlockCodeBlock
	docBlockTable
	docBlockImage
	docBlockBlockquote
	docBlockHR
)

type docRun struct {
	text         string
	bold, italic bool
	code         bool
}

type docCell struct {
	runs []docRun
}

type docImage struct {
	data     []byte
	widthPx  int
	heightPx int
}

type docBlock struct {
	kind    docBlockKind
	level   int // heading level (1-6), or list nesting depth (0-based)
	ordered bool
	number  int
	runs    []docRun
	lang    string
	code    string
	rows    [][]docCell
	image   *docImage
}

// parseMarkdownToBlocks parses markdown (GFM: tables/strikethrough) and
// walks the resulting AST into a flat block list. Fenced ```mermaid blocks
// are rendered to PNG inline via the pure-Go mermaid renderer; anything that
// isn't a diagram type it understands falls back to a labeled code block
// instead of failing the export.
func parseMarkdownToBlocks(markdown string) []docBlock {
	source := []byte(markdown)
	md := goldmark.New(
		goldmark.WithExtensions(extension.GFM),
		goldmark.WithParserOptions(parser.WithAutoHeadingID()),
	)
	doc := md.Parser().Parse(text.NewReader(source))

	var blocks []docBlock
	for n := doc.FirstChild(); n != nil; n = n.NextSibling() {
		blocks = append(blocks, blocksFromNode(source, n, 0)...)
	}
	return blocks
}

func blocksFromNode(source []byte, n ast.Node, listDepth int) []docBlock {
	switch v := n.(type) {
	case *ast.Heading:
		return []docBlock{{kind: docBlockHeading, level: v.Level, runs: inlineRuns(source, v, false, false, false)}}

	case *ast.Paragraph:
		if img, ok := soleImageParagraph(source, v); ok {
			return []docBlock{{kind: docBlockImage, image: img}}
		}
		return []docBlock{{kind: docBlockParagraph, runs: inlineRuns(source, v, false, false, false)}}

	case *ast.TextBlock:
		return []docBlock{{kind: docBlockParagraph, runs: inlineRuns(source, v, false, false, false)}}

	case *ast.FencedCodeBlock:
		lang := strings.ToLower(strings.TrimSpace(string(v.Language(source))))
		code := string(v.Text(source))
		if lang == "mermaid" {
			if png, w, h, ok := decodedMermaidPNG(code); ok {
				return []docBlock{{kind: docBlockImage, image: &docImage{data: png, widthPx: w, heightPx: h}}}
			}
			// Unsupported/unparsable diagram: degrade to a labeled code
			// block rather than dropping content or failing the export.
			return []docBlock{{kind: docBlockCodeBlock, lang: "mermaid (unrendered)", code: code}}
		}
		return []docBlock{{kind: docBlockCodeBlock, lang: lang, code: code}}

	case *ast.CodeBlock:
		return []docBlock{{kind: docBlockCodeBlock, code: string(v.Text(source))}}

	case *ast.List:
		var out []docBlock
		ordered := v.IsOrdered()
		num := v.Start
		if num == 0 {
			num = 1
		}
		for item := v.FirstChild(); item != nil; item = item.NextSibling() {
			li, ok := item.(*ast.ListItem)
			if !ok {
				continue
			}
			out = append(out, listItemBlocks(source, li, listDepth, ordered, num)...)
			num++
		}
		return out

	case *extast.Table:
		return []docBlock{{kind: docBlockTable, rows: tableRows(source, v)}}

	case *ast.Blockquote:
		var runs []docRun
		for c := v.FirstChild(); c != nil; c = c.NextSibling() {
			runs = append(runs, inlineRuns(source, c, false, false, false)...)
			if c.NextSibling() != nil {
				runs = append(runs, docRun{text: "\n"})
			}
		}
		return []docBlock{{kind: docBlockBlockquote, runs: runs}}

	case *ast.ThematicBreak:
		return []docBlock{{kind: docBlockHR}}

	default:
		// Unrecognized block kind (e.g. raw HTML block): best-effort as a
		// plain paragraph of its text rather than silently dropping it.
		if txt := strings.TrimSpace(string(n.Text(source))); txt != "" {
			return []docBlock{{kind: docBlockParagraph, runs: []docRun{{text: txt}}}}
		}
		return nil
	}
}

func listItemBlocks(source []byte, li *ast.ListItem, depth int, ordered bool, number int) []docBlock {
	var out []docBlock
	first := true
	for c := li.FirstChild(); c != nil; c = c.NextSibling() {
		switch c.(type) {
		case *ast.List:
			out = append(out, blocksFromNode(source, c, depth+1)...)
			first = false
		default:
			runs := inlineRuns(source, c, false, false, false)
			if first {
				out = append(out, docBlock{kind: docBlockListItem, level: depth, ordered: ordered, number: number, runs: runs})
				first = false
			} else if len(runs) > 0 {
				// Continuation paragraph inside the same list item.
				out = append(out, docBlock{kind: docBlockListItem, level: depth, ordered: ordered, number: -1, runs: runs})
			}
		}
	}
	return out
}

func tableRows(source []byte, tbl *extast.Table) [][]docCell {
	var rows [][]docCell
	for r := tbl.FirstChild(); r != nil; r = r.NextSibling() {
		var cells []docCell
		for c := r.FirstChild(); c != nil; c = c.NextSibling() {
			cells = append(cells, docCell{runs: inlineRuns(source, c, false, false, false)})
		}
		rows = append(rows, cells)
	}
	return rows
}

// soleImageParagraph reports whether a paragraph's only content is a single
// image, in which case it renders as a block-level image rather than an
// inline "[image: ...]" run.
func soleImageParagraph(source []byte, p *ast.Paragraph) (*docImage, bool) {
	first := p.FirstChild()
	if first == nil || first.NextSibling() != nil {
		return nil, false
	}
	img, ok := first.(*ast.Image)
	if !ok {
		return nil, false
	}
	dest := string(img.Destination)
	data, w, h, ok := decodeDataURLImage(dest)
	if !ok {
		return nil, false
	}
	return &docImage{data: data, widthPx: w, heightPx: h}, true
}

func decodeDataURLImage(dest string) (data []byte, w, h int, ok bool) {
	// Only data: URLs are embeddable without a network fetch; anything else
	// (http(s) links, relative paths) is left as regular inline text via the
	// default inline-run handling instead.
	if !strings.HasPrefix(dest, "data:") {
		return nil, 0, 0, false
	}
	i := strings.Index(dest, ",")
	if i == -1 {
		return nil, 0, 0, false
	}
	meta, payload := dest[:i], dest[i+1:]
	if !strings.Contains(meta, "base64") {
		return nil, 0, 0, false
	}
	raw, err := base64.StdEncoding.DecodeString(payload)
	if err != nil {
		return nil, 0, 0, false
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(raw))
	if err != nil {
		return nil, 0, 0, false
	}
	return raw, cfg.Width, cfg.Height, true
}

func decodedMermaidPNG(src string) (data []byte, w, h int, ok bool) {
	pngBytes, ok := renderMermaid(src)
	if !ok {
		return nil, 0, 0, false
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(pngBytes))
	if err != nil {
		return nil, 0, 0, false
	}
	return pngBytes, cfg.Width, cfg.Height, true
}

// inlineRuns walks inline children collecting text runs with style flags.
// Unrecognized inline node kinds fall back to Node.Text(), which is
// deprecated upstream but reliable enough for best-effort extraction.
func inlineRuns(source []byte, n ast.Node, bold, italic, code bool) []docRun {
	var runs []docRun
	for c := n.FirstChild(); c != nil; c = c.NextSibling() {
		switch v := c.(type) {
		case *ast.Text:
			if val := string(v.Value(source)); val != "" {
				runs = append(runs, docRun{text: val, bold: bold, italic: italic, code: code})
			}
			if v.SoftLineBreak() {
				runs = append(runs, docRun{text: " "})
			} else if v.HardLineBreak() {
				runs = append(runs, docRun{text: "\n"})
			}
		case *ast.Emphasis:
			b, i := bold, italic
			if v.Level >= 2 {
				b = true
			} else {
				i = true
			}
			runs = append(runs, inlineRuns(source, v, b, i, code)...)
		case *ast.CodeSpan:
			runs = append(runs, inlineRuns(source, v, bold, italic, true)...)
		case *ast.Image:
			alt := strings.TrimSpace(string(c.Text(source)))
			runs = append(runs, docRun{text: "[image: " + alt + "]", italic: true})
		case *ast.AutoLink, *ast.Link, *ast.String, *ast.RawHTML:
			if txt := string(c.Text(source)); txt != "" {
				runs = append(runs, docRun{text: txt, bold: bold, italic: italic, code: code})
			} else {
				runs = append(runs, inlineRuns(source, c, bold, italic, code)...)
			}
		default:
			runs = append(runs, inlineRuns(source, c, bold, italic, code)...)
		}
	}
	return runs
}

func runsPlainText(runs []docRun) string {
	var sb strings.Builder
	for _, r := range runs {
		sb.WriteString(r.text)
	}
	return sb.String()
}
