package telegram

import (
	"strings"
)

// This file converts the MARKDOWN an agent actually writes into the
// MarkdownV2 dialect Telegram actually parses. They are not the same
// language, and the gap is the whole reason this file exists:
//
//   - Telegram's bold is *one* asterisk; an agent writes **two**. Passing the
//     agent's text through unchanged renders "**penting**" with the asterisks
//     visible, which is what the HTML-escaping path did before.
//   - Telegram has no headings, no tables and no list syntax at all, so "##"
//     and "- " have to become something it does have (bold, and a bullet).
//   - MarkdownV2 requires a backslash before EVERY one of _*[]()~`>#+-=|{}.!
//     wherever it is not part of an entity. An agent's prose is full of "." and
//     "-", so an unescaped pass-through fails with 400 "can't parse entities"
//     — and because the pump refuses to advance its cursor past a message it
//     could not send, one such failure freezes that thread's mirror forever.
//     That last consequence is why this file is careful rather than clever:
//     the safe direction is always "escape it", never "assume it parses".
//
// Nothing here is provider-specific and nothing does I/O — same contract as
// render.go, and tested the same way.

// mdV2Specials is the exact set Telegram's MarkdownV2 spec requires escaping
// outside an entity. Kept as one string, in the spec's own order, so it can be
// diffed against the documentation without re-deriving anything.
const mdV2Specials = "_*[]()~`>#+-=|{}.!"

// EscapeMarkdownV2 backslash-escapes every character Telegram treats as
// markup. Used for text that must appear LITERALLY — the overwhelming
// majority of any message.
func EscapeMarkdownV2(s string) string {
	var b strings.Builder
	b.Grow(len(s) + len(s)/4)
	for _, r := range s {
		if strings.ContainsRune(mdV2Specials, r) {
			b.WriteByte('\\')
		}
		b.WriteRune(r)
	}
	return b.String()
}

// escapeMarkdownV2Code escapes the two characters that still bite INSIDE a
// code entity. Everything else is literal there, which is exactly why tool
// arguments and command output belong in one.
func escapeMarkdownV2Code(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	return strings.ReplaceAll(s, "`", "\\`")
}

// escapeMarkdownV2Link escapes what bites inside a link's (...) target.
func escapeMarkdownV2Link(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	return strings.ReplaceAll(s, ")", `\)`)
}

// StripMarkdownV2Escapes undoes EscapeMarkdownV2 for the plain-text fallback
// path: with no parse_mode, a backslash is no longer markup but a literal
// character, so an un-stripped fallback reads like source code instead of a
// message. Only backslashes that precede a MarkdownV2 special are removed —
// a backslash in the original text (a Windows path, a regex) is left alone.
func StripMarkdownV2Escapes(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	r := []rune(s)
	for i := 0; i < len(r); i++ {
		if r[i] == '\\' && i+1 < len(r) && strings.ContainsRune(mdV2Specials, r[i+1]) {
			continue
		}
		b.WriteRune(r[i])
	}
	return b.String()
}

// CodeBlockMarkdownV2 wraps s in a fenced code block, escaped for it. Used by
// the renderer for tool arguments, which are JSON and would otherwise be a
// solid wall of characters needing escapes.
func CodeBlockMarkdownV2(s string) string {
	return "```\n" + escapeMarkdownV2Code(s) + "\n```"
}

// ToMarkdownV2 converts agent-written markdown to Telegram MarkdownV2.
//
// Block structure is handled line by line and inline structure by
// renderInlineMarkdownV2; anything unrecognized is escaped rather than
// guessed at. Fenced code blocks are lifted out FIRST and never scanned for
// inline markup — a shell heredoc or a diff inside one is not emphasis, and
// treating it as such is how a code block turns into corrupt markup.
func ToMarkdownV2(src string) string {
	var out []string
	lines := strings.Split(strings.ReplaceAll(src, "\r\n", "\n"), "\n")

	inFence := false
	var fence []string
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "```") {
			if inFence {
				out = append(out, "```\n"+escapeMarkdownV2Code(strings.Join(fence, "\n"))+"\n```")
				fence = nil
				inFence = false
			} else {
				inFence = true
			}
			continue
		}
		if inFence {
			fence = append(fence, line)
			continue
		}
		out = append(out, convertBlockLine(line))
	}
	// An unterminated fence is common in streamed output that got cut off
	// mid-block. Close it rather than dropping the content on the floor.
	if inFence && len(fence) > 0 {
		out = append(out, "```\n"+escapeMarkdownV2Code(strings.Join(fence, "\n"))+"\n```")
	}
	return strings.Join(out, "\n")
}

// convertBlockLine maps one line's BLOCK-level markdown onto something
// Telegram has. Telegram supports none of headings, lists or horizontal
// rules, so each becomes the nearest thing it does support.
func convertBlockLine(line string) string {
	trimmed := strings.TrimLeft(line, " \t")
	indent := line[:len(line)-len(trimmed)]

	switch {
	case trimmed == "":
		return ""

	// Horizontal rule — every one of its characters needs escaping, and a row
	// of "\-\-\-" reads worse than the rule it replaces.
	case trimmed == "---" || trimmed == "***" || trimmed == "___":
		return "─────"

	// Headings become bold: Telegram has no heading entity, and leaving the
	// "#" in place would just show a literal hash.
	case strings.HasPrefix(trimmed, "#"):
		level := 0
		for level < len(trimmed) && trimmed[level] == '#' {
			level++
		}
		text := strings.TrimSpace(trimmed[level:])
		if text == "" {
			return ""
		}
		return indent + "*" + renderInlineMarkdownV2(text) + "*"

	// Blockquote is one of the few block entities Telegram DOES have, and its
	// syntax happens to match.
	case strings.HasPrefix(trimmed, "> "):
		return indent + ">" + renderInlineMarkdownV2(trimmed[2:])

	// Bullets: "•" is a plain character needing no escape, unlike "-"/"*"/"+".
	case strings.HasPrefix(trimmed, "- "), strings.HasPrefix(trimmed, "* "), strings.HasPrefix(trimmed, "+ "):
		return indent + "• " + renderInlineMarkdownV2(trimmed[2:])
	}

	// Ordered list: keep the number, escape the "." that follows it (a bare
	// "1." is a MarkdownV2 parse error).
	if rest, n, ok := splitOrderedMarker(trimmed); ok {
		return indent + n + "\\. " + renderInlineMarkdownV2(rest)
	}
	return indent + renderInlineMarkdownV2(trimmed)
}

// splitOrderedMarker recognizes a leading "12. " and returns the text after
// it plus the digits. Digits only — a line starting "v1. something" is prose.
func splitOrderedMarker(s string) (rest, number string, ok bool) {
	i := 0
	for i < len(s) && s[i] >= '0' && s[i] <= '9' {
		i++
	}
	if i == 0 || i >= len(s) || s[i] != '.' {
		return "", "", false
	}
	if i+1 >= len(s) || s[i+1] != ' ' {
		return "", "", false
	}
	return s[i+2:], s[:i], true
}

// renderInlineMarkdownV2 rewrites inline markdown and escapes everything
// else. Written as an explicit scanner rather than regexps because the rule
// that matters is the DEFAULT one: any byte that is not positively recognized
// as part of an entity gets a backslash. A regexp-replace pass has the
// opposite default — it leaves unmatched text alone — which is precisely how
// an unescaped "." reaches Telegram and 400s the message.
func renderInlineMarkdownV2(s string) string {
	r := []rune(s)
	var b strings.Builder
	b.Grow(len(s) + len(s)/4)

	for i := 0; i < len(r); {
		switch {
		// A backslash in the SOURCE is the author escaping a character; emit
		// that character literally (re-escaped for Telegram), not the slash.
		case r[i] == '\\' && i+1 < len(r):
			b.WriteString(EscapeMarkdownV2(string(r[i+1])))
			i += 2

		case r[i] == '`':
			if end := indexRuneFrom(r, '`', i+1); end > i {
				b.WriteString("`" + escapeMarkdownV2Code(string(r[i+1:end])) + "`")
				i = end + 1
				continue
			}
			b.WriteString("\\`")
			i++

		case hasRunePrefix(r[i:], "**"):
			if end := indexSeqFrom(r, "**", i+2); end > 0 {
				b.WriteString("*" + renderInlineMarkdownV2(string(r[i+2:end])) + "*")
				i = end + 2
				continue
			}
			b.WriteString("\\*")
			i++

		case hasRunePrefix(r[i:], "__"):
			if end := indexSeqFrom(r, "__", i+2); end > 0 {
				b.WriteString("__" + renderInlineMarkdownV2(string(r[i+2:end])) + "__")
				i = end + 2
				continue
			}
			b.WriteString("\\_")
			i++

		case hasRunePrefix(r[i:], "~~"):
			if end := indexSeqFrom(r, "~~", i+2); end > 0 {
				b.WriteString("~" + renderInlineMarkdownV2(string(r[i+2:end])) + "~")
				i = end + 2
				continue
			}
			b.WriteString("\\~")
			i++

		// Single-delimiter emphasis. Telegram's italic is "_", so a source
		// "*italic*" changes delimiter on the way through.
		case r[i] == '*' || r[i] == '_':
			delim := r[i]
			if end := indexRuneFrom(r, delim, i+1); end > i+1 {
				b.WriteString("_" + renderInlineMarkdownV2(string(r[i+1:end])) + "_")
				i = end + 1
				continue
			}
			b.WriteString("\\" + string(delim))
			i++

		case r[i] == '[':
			if label, target, next, ok := scanLink(r, i); ok {
				b.WriteString("[" + renderInlineMarkdownV2(label) + "](" + escapeMarkdownV2Link(target) + ")")
				i = next
				continue
			}
			b.WriteString("\\[")
			i++

		default:
			b.WriteString(EscapeMarkdownV2(string(r[i])))
			i++
		}
	}
	return b.String()
}

// scanLink matches "[label](target)" starting at i. Returns the index just
// past the closing paren. Nested brackets inside the label are not supported
// — an unmatched shape simply falls through to being escaped as text, which
// is the safe direction.
func scanLink(r []rune, i int) (label, target string, next int, ok bool) {
	closeBracket := indexRuneFrom(r, ']', i+1)
	if closeBracket < 0 || closeBracket+1 >= len(r) || r[closeBracket+1] != '(' {
		return "", "", 0, false
	}
	closeParen := indexRuneFrom(r, ')', closeBracket+2)
	if closeParen < 0 {
		return "", "", 0, false
	}
	return string(r[i+1 : closeBracket]), string(r[closeBracket+2 : closeParen]), closeParen + 1, true
}

func indexRuneFrom(r []rune, want rune, from int) int {
	for i := from; i < len(r); i++ {
		if r[i] == want {
			return i
		}
	}
	return -1
}

// indexSeqFrom finds a two-rune sequence. Returns -1 when absent; callers
// treat any non-positive result as "no closing delimiter".
func indexSeqFrom(r []rune, seq string, from int) int {
	s := []rune(seq)
	for i := from; i+len(s) <= len(r); i++ {
		match := true
		for j := range s {
			if r[i+j] != s[j] {
				match = false
				break
			}
		}
		if match {
			return i
		}
	}
	return -1
}

func hasRunePrefix(r []rune, prefix string) bool {
	p := []rune(prefix)
	if len(r) < len(p) {
		return false
	}
	for i := range p {
		if r[i] != p[i] {
			return false
		}
	}
	return true
}
