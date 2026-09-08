package service

import (
	"bytes"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"math"
	"strings"

	"golang.org/x/image/font"
	"golang.org/x/image/font/basicfont"
	"golang.org/x/image/math/fixed"
)

// Pure-Go mermaid rendering: no mermaid-cli/Node/Chromium involved. Supports
// the common subset of `graph`/`flowchart` and `sequenceDiagram`. Anything
// else -- or anything that fails to parse -- returns ok=false, and the
// caller falls back to embedding the raw mermaid source as a labeled code
// block instead of failing the export.

type mermaidNode struct {
	id, label string
	shape     byte // '[', '(', '{', or 0 for bare id
}

type mermaidEdge struct {
	from, to, label string
}

type mermaidGraph struct {
	direction string // TD, LR, RL, BT
	order     []string
	nodes     map[string]*mermaidNode
	edges     []mermaidEdge
}

var mermaidFace = basicfont.Face7x13

// renderMermaid parses mermaid source and rasterizes it to a PNG. ok is
// false when the diagram type/syntax isn't one of the supported subsets.
func renderMermaid(src string) (png []byte, ok bool) {
	src = strings.TrimSpace(src)
	if g, ok := parseMermaidFlowchart(src); ok {
		return rasterizeFlowchart(g), true
	}
	if seq, ok := parseMermaidSequence(src); ok {
		return rasterizeSequence(seq), true
	}
	return nil, false
}

func parseMermaidFlowchart(src string) (*mermaidGraph, bool) {
	lines := strings.Split(src, "\n")
	if len(lines) == 0 {
		return nil, false
	}
	head := strings.Fields(strings.TrimSpace(lines[0]))
	if len(head) == 0 {
		return nil, false
	}
	kind := strings.ToLower(head[0])
	if kind != "graph" && kind != "flowchart" {
		return nil, false
	}
	direction := "TD"
	if len(head) > 1 {
		d := strings.ToUpper(head[1])
		if d == "TB" {
			d = "TD"
		}
		if d == "TD" || d == "LR" || d == "RL" || d == "BT" {
			direction = d
		}
	}

	g := &mermaidGraph{direction: direction, nodes: map[string]*mermaidNode{}}
	skipPrefixes := []string{"subgraph", "end", "classdef", "style", "click", "linkstyle", "class "}
	for _, raw := range lines[1:] {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "%%") {
			continue
		}
		skip := false
		lower := strings.ToLower(line)
		for _, p := range skipPrefixes {
			if strings.HasPrefix(lower, p) {
				skip = true
				break
			}
		}
		if skip {
			continue
		}
		edge, ok := parseMermaidEdgeLine(line)
		if !ok {
			continue // unrecognized line: ignore rather than abort the whole diagram
		}
		g.registerNode(edge.fromID, edge.fromLabel, edge.fromShape)
		g.registerNode(edge.toID, edge.toLabel, edge.toShape)
		g.edges = append(g.edges, mermaidEdge{from: edge.fromID, to: edge.toID, label: edge.label})
	}
	if len(g.nodes) == 0 {
		return nil, false
	}
	return g, true
}

func (g *mermaidGraph) registerNode(id, label string, shape byte) {
	if n, ok := g.nodes[id]; ok {
		if label != "" && label != id {
			n.label = label
		}
		if shape != 0 {
			n.shape = shape
		}
		return
	}
	if label == "" {
		label = id
	}
	g.nodes[id] = &mermaidNode{id: id, label: label, shape: shape}
	g.order = append(g.order, id)
}

type mermaidEdgeLine struct {
	fromID, fromLabel string
	fromShape         byte
	toID, toLabel     string
	toShape           byte
	label             string
}

var mermaidArrows = []string{"-.->", "==>", "-->", "---"}

func parseMermaidEdgeLine(line string) (mermaidEdgeLine, bool) {
	arrowIdx, arrowTok := -1, ""
	for _, tok := range mermaidArrows {
		if i := strings.Index(line, tok); i >= 0 && (arrowIdx == -1 || i < arrowIdx) {
			arrowIdx, arrowTok = i, tok
		}
	}
	if arrowIdx == -1 {
		return mermaidEdgeLine{}, false
	}

	left := line[:arrowIdx]
	right := strings.TrimSpace(line[arrowIdx+len(arrowTok):])

	label := ""
	if i := strings.Index(left, " -- "); i >= 0 {
		label = strings.TrimSpace(left[i+4:])
		left = left[:i]
	}
	if strings.HasPrefix(right, "|") {
		if end := strings.Index(right[1:], "|"); end >= 0 {
			label = strings.TrimSpace(right[1 : 1+end])
			right = strings.TrimSpace(right[1+end+1:])
		}
	}

	fromID, fromLabel, fromShape, ok1 := parseMermaidNodeRef(left)
	toID, toLabel, toShape, ok2 := parseMermaidNodeRef(right)
	if !ok1 || !ok2 {
		return mermaidEdgeLine{}, false
	}
	return mermaidEdgeLine{fromID, fromLabel, fromShape, toID, toLabel, toShape, label}, true
}

func parseMermaidNodeRef(s string) (id, label string, shape byte, ok bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return "", "", 0, false
	}
	idx := strings.IndexAny(s, "([{")
	if idx == -1 {
		return s, s, 0, true
	}
	id = strings.TrimSpace(s[:idx])
	if id == "" {
		return "", "", 0, false
	}
	open := s[idx]
	closeCh := map[byte]byte{'[': ']', '(': ')', '{': '}'}[open]
	end := strings.LastIndexByte(s, closeCh)
	if end <= idx {
		return id, id, 0, true
	}
	return id, strings.TrimSpace(s[idx+1 : end]), open, true
}

// --- flowchart rasterization -----------------------------------------------

const (
	mermaidCellW  = 170
	mermaidCellH  = 100
	mermaidBoxPad = 10
	mermaidMargin = 24
)

func layoutFlowchartLayers(g *mermaidGraph) map[string]int {
	indeg := map[string]int{}
	adj := map[string][]string{}
	for _, id := range g.order {
		indeg[id] = 0
	}
	for _, e := range g.edges {
		adj[e.from] = append(adj[e.from], e.to)
		indeg[e.to]++
	}
	layer := map[string]int{}
	var queue []string
	for _, id := range g.order {
		if indeg[id] == 0 {
			layer[id] = 0
			queue = append(queue, id)
		}
	}
	visited := map[string]bool{}
	for len(queue) > 0 {
		id := queue[0]
		queue = queue[1:]
		if visited[id] {
			continue
		}
		visited[id] = true
		for _, next := range adj[id] {
			if layer[next] < layer[id]+1 {
				layer[next] = layer[id] + 1
			}
			queue = append(queue, next)
		}
	}
	// Anything unreached (pure cycle, no indegree-0 entry point) still needs a
	// layer so it renders instead of vanishing.
	for _, id := range g.order {
		if _, ok := layer[id]; !ok {
			layer[id] = 0
		}
	}
	return layer
}

func rasterizeFlowchart(g *mermaidGraph) []byte {
	layer := layoutFlowchartLayers(g)
	byLayer := map[int][]string{}
	maxLayer := 0
	for _, id := range g.order {
		l := layer[id]
		byLayer[l] = append(byLayer[l], id)
		if l > maxLayer {
			maxLayer = l
		}
	}
	maxInLayer := 0
	for _, ids := range byLayer {
		if len(ids) > maxInLayer {
			maxInLayer = len(ids)
		}
	}

	horizontal := g.direction == "LR" || g.direction == "RL"
	layers, perLayer := maxLayer+1, maxInLayer
	var width, height int
	if horizontal {
		width = mermaidMargin*2 + layers*mermaidCellW
		height = mermaidMargin*2 + perLayer*mermaidCellH
	} else {
		width = mermaidMargin*2 + perLayer*mermaidCellW
		height = mermaidMargin*2 + layers*mermaidCellH
	}

	type box struct{ x0, y0, x1, y1 int }
	boxes := map[string]box{}
	for l := 0; l <= maxLayer; l++ {
		ids := byLayer[l]
		displayLayer := l
		if g.direction == "RL" || g.direction == "BT" {
			displayLayer = maxLayer - l
		}
		for pos, id := range ids {
			var cx, cy int
			if horizontal {
				cx = mermaidMargin + displayLayer*mermaidCellW + mermaidCellW/2
				cy = mermaidMargin + pos*mermaidCellH + mermaidCellH/2
			} else {
				cx = mermaidMargin + pos*mermaidCellW + mermaidCellW/2
				cy = mermaidMargin + displayLayer*mermaidCellH + mermaidCellH/2
			}
			label := g.nodes[id].label
			w := measureText(label) + mermaidBoxPad*2
			if w > mermaidCellW-20 {
				w = mermaidCellW - 20
			}
			if w < 60 {
				w = 60
			}
			h := 40
			boxes[id] = box{cx - w/2, cy - h/2, cx + w/2, cy + h/2}
		}
	}

	img := image.NewRGBA(image.Rect(0, 0, width, height))
	draw.Draw(img, img.Bounds(), &image.Uniform{color.White}, image.Point{}, draw.Src)

	navy := color.RGBA{30, 41, 59, 255}
	fill := color.RGBA{224, 231, 255, 255}

	for _, e := range g.edges {
		fb, ok1 := boxes[e.from]
		tb, ok2 := boxes[e.to]
		if !ok1 || !ok2 {
			continue
		}
		fx, fy := (fb.x0+fb.x1)/2, (fb.y0+fb.y1)/2
		tx, ty := (tb.x0+tb.x1)/2, (tb.y0+tb.y1)/2
		start := clipToBox(fx, fy, tx, ty, fb.x0, fb.y0, fb.x1, fb.y1)
		end := clipToBox(tx, ty, fx, fy, tb.x0, tb.y0, tb.x1, tb.y1)
		drawLine(img, start[0], start[1], end[0], end[1], navy)
		drawArrowhead(img, start[0], start[1], end[0], end[1], navy)
		if e.label != "" {
			drawText(img, (start[0]+end[0])/2-measureText(e.label)/2, (start[1]+end[1])/2-4, e.label, navy)
		}
	}
	for _, id := range g.order {
		b := boxes[id]
		fillRect(img, b.x0, b.y0, b.x1, b.y1, fill)
		strokeRect(img, b.x0, b.y0, b.x1, b.y1, navy)
		label := g.nodes[id].label
		drawText(img, b.x0+(b.x1-b.x0-measureText(label))/2, (b.y0+b.y1)/2+4, label, navy)
	}

	var buf bytes.Buffer
	_ = png.Encode(&buf, img)
	return buf.Bytes()
}

// clipToBox moves the point (fromX,fromY) toward (toX,toY) until it reaches
// the edge of the given box, so arrows start/end at box borders rather than
// centers.
func clipToBox(fromX, fromY, toX, toY, x0, y0, x1, y1 int) [2]int {
	dx, dy := float64(toX-fromX), float64(toY-fromY)
	if dx == 0 && dy == 0 {
		return [2]int{fromX, fromY}
	}
	halfW, halfH := float64(x1-x0)/2, float64(y1-y0)/2
	tx, ty := math.Inf(1), math.Inf(1)
	if dx != 0 {
		tx = halfW / math.Abs(dx)
	}
	if dy != 0 {
		ty = halfH / math.Abs(dy)
	}
	t := math.Min(tx, ty)
	return [2]int{fromX + int(dx*t), fromY + int(dy*t)}
}

// --- sequence diagram --------------------------------------------------

type mermaidSeqMsg struct {
	from, to, label string
	dashed          bool
}

type mermaidSequence struct {
	participants []string
	messages     []mermaidSeqMsg
}

func parseMermaidSequence(src string) (*mermaidSequence, bool) {
	lines := strings.Split(src, "\n")
	if len(lines) == 0 {
		return nil, false
	}
	if !strings.HasPrefix(strings.ToLower(strings.TrimSpace(lines[0])), "sequencediagram") {
		return nil, false
	}
	seq := &mermaidSequence{}
	seen := map[string]bool{}
	ensure := func(name string) {
		if !seen[name] {
			seen[name] = true
			seq.participants = append(seq.participants, name)
		}
	}
	arrows := []struct {
		tok    string
		dashed bool
	}{{"-->>", true}, {"->>", false}, {"-->", true}, {"->", false}}

	for _, raw := range lines[1:] {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "%%") {
			continue
		}
		lower := strings.ToLower(line)
		if strings.HasPrefix(lower, "participant ") || strings.HasPrefix(lower, "actor ") {
			rest := strings.TrimSpace(line[strings.IndexByte(line, ' ')+1:])
			if i := strings.Index(strings.ToLower(rest), " as "); i >= 0 {
				rest = strings.TrimSpace(rest[:i])
			}
			ensure(rest)
			continue
		}
		colon := strings.Index(line, ":")
		if colon == -1 {
			continue
		}
		head := strings.TrimSpace(line[:colon])
		msgText := strings.TrimSpace(line[colon+1:])

		var tok string
		dashed := false
		idx := -1
		for _, a := range arrows {
			if i := strings.Index(head, a.tok); i >= 0 && (idx == -1 || i < idx) {
				idx, tok, dashed = i, a.tok, a.dashed
			}
		}
		if idx == -1 {
			continue
		}
		from := strings.TrimSpace(head[:idx])
		to := strings.TrimSpace(head[idx+len(tok):])
		if from == "" || to == "" {
			continue
		}
		ensure(from)
		ensure(to)
		seq.messages = append(seq.messages, mermaidSeqMsg{from: from, to: to, label: msgText, dashed: dashed})
	}
	if len(seq.participants) == 0 || len(seq.messages) == 0 {
		return nil, false
	}
	return seq, true
}

func rasterizeSequence(seq *mermaidSequence) []byte {
	const laneW = 160
	const topPad = 50
	const rowH = 44
	width := mermaidMargin*2 + laneW*len(seq.participants)
	height := topPad + rowH*(len(seq.messages)+1) + mermaidMargin

	img := image.NewRGBA(image.Rect(0, 0, width, height))
	draw.Draw(img, img.Bounds(), &image.Uniform{color.White}, image.Point{}, draw.Src)

	navy := color.RGBA{30, 41, 59, 255}
	fill := color.RGBA{224, 231, 255, 255}
	gray := color.RGBA{148, 163, 184, 255}

	laneX := map[string]int{}
	for i, p := range seq.participants {
		x := mermaidMargin + i*laneW + laneW/2
		laneX[p] = x
		w := measureText(p) + mermaidBoxPad*2
		fillRect(img, x-w/2, 12, x+w/2, 40, fill)
		strokeRect(img, x-w/2, 12, x+w/2, 40, navy)
		drawText(img, x-measureText(p)/2, 30, p, navy)
		drawLine(img, x, 40, x, height-mermaidMargin, gray)
	}

	y := topPad + rowH/2
	for _, m := range seq.messages {
		fx, tx := laneX[m.from], laneX[m.to]
		drawLine(img, fx, y, tx, y, navy)
		drawArrowhead(img, fx, y, tx, y, navy)
		if m.label != "" {
			lx := fx + (tx-fx)/2 - measureText(m.label)/2
			drawText(img, lx, y-6, m.label, navy)
		}
		y += rowH
	}

	var buf bytes.Buffer
	_ = png.Encode(&buf, img)
	return buf.Bytes()
}

// --- drawing primitives (stdlib image/draw only, no cgo, no font files) ---

func fillRect(img *image.RGBA, x0, y0, x1, y1 int, c color.Color) {
	draw.Draw(img, image.Rect(x0, y0, x1, y1), &image.Uniform{c}, image.Point{}, draw.Src)
}

func strokeRect(img *image.RGBA, x0, y0, x1, y1 int, c color.Color) {
	drawLine(img, x0, y0, x1, y0, c)
	drawLine(img, x1, y0, x1, y1, c)
	drawLine(img, x1, y1, x0, y1, c)
	drawLine(img, x0, y1, x0, y0, c)
}

// drawLine is a standard Bresenham line rasterizer.
func drawLine(img *image.RGBA, x0, y0, x1, y1 int, c color.Color) {
	dx, dy := abs(x1-x0), -abs(y1-y0)
	sx, sy := sign(x1-x0), sign(y1-y0)
	err := dx + dy
	x, y := x0, y0
	for {
		if x >= 0 && y >= 0 && x < img.Bounds().Dx() && y < img.Bounds().Dy() {
			img.Set(x, y, c)
		}
		if x == x1 && y == y1 {
			break
		}
		e2 := 2 * err
		if e2 >= dy {
			err += dy
			x += sx
		}
		if e2 <= dx {
			err += dx
			y += sy
		}
	}
}

func drawArrowhead(img *image.RGBA, fromX, fromY, toX, toY int, c color.Color) {
	angle := math.Atan2(float64(toY-fromY), float64(toX-fromX))
	const size = 8
	for _, a := range []float64{angle + math.Pi - 0.4, angle + math.Pi + 0.4} {
		x := toX + int(size*math.Cos(a))
		y := toY + int(size*math.Sin(a))
		drawLine(img, toX, toY, x, y, c)
	}
}

func drawText(img *image.RGBA, x, y int, text string, c color.Color) {
	d := &font.Drawer{
		Dst:  img,
		Src:  &image.Uniform{c},
		Face: mermaidFace,
		Dot:  fixed.P(x, y),
	}
	d.DrawString(text)
}

func measureText(text string) int {
	return font.MeasureString(mermaidFace, text).Round()
}

func abs(v int) int {
	if v < 0 {
		return -v
	}
	return v
}

func sign(v int) int {
	if v < 0 {
		return -1
	}
	if v > 0 {
		return 1
	}
	return 0
}
