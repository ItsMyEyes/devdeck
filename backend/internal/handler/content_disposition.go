package handler

import (
	"fmt"
	"strings"
)

// contentDisposition builds an attachment Content-Disposition header for an
// arbitrary, user-controlled filename. The zip handlers hardcode
// `filename="selection.zip"`, but a real repo filename can contain a quote, a
// backslash, a CR/LF (a response-splitting vector), or non-ASCII bytes, so
// both parameters are emitted:
//
//   - `filename=` is a quoted-string that legacy clients read, with every
//     unsafe byte replaced by "_" rather than backslash-escaped — an escape
//     only helps the parsers that implement it, whereas replacement is inert
//     everywhere.
//   - filename* (RFC 5987, UTF-8 charset, empty language) carries the exact
//     original name for every modern client, percent-encoded down to RFC
//     8187's attr-char set.
//
// When RFC 6266 §4.3's rule applies (clients prefer filename* when both are
// present), the sanitized ASCII form is only a fallback, so lossiness there
// costs nothing.
func contentDisposition(name string) string {
	return fmt.Sprintf(
		"attachment; filename=%q; filename*=UTF-8''%s",
		asciiFilename(name),
		rfc5987Encode(name),
	)
}

// asciiFilename reduces name to bytes that are safe inside a quoted-string:
// printable ASCII other than `"` and `\`. Everything else — control
// characters, and every byte of a multi-byte rune — becomes "_", so a name
// that is entirely non-ASCII degrades to a usable placeholder instead of an
// empty quoted-string.
func asciiFilename(name string) string {
	var b strings.Builder
	b.Grow(len(name))
	for i := 0; i < len(name); i++ {
		c := name[i]
		if c < 0x20 || c > 0x7e || c == '"' || c == '\\' {
			b.WriteByte('_')
			continue
		}
		b.WriteByte(c)
	}
	// Only trailing dots/spaces are trimmed: those are the Windows-filename
	// hazard. A leading dot is meaningful — trimming it would rename every
	// dotfile (.gitignore -> gitignore) for the legacy clients this
	// quoted-string exists to serve.
	sanitized := strings.TrimRight(b.String(), " .")
	// All-underscore means nothing of the original name survived (e.g. a
	// control-character-only name), which is less useful than a placeholder.
	if strings.Trim(sanitized, "_") == "" {
		return "download"
	}
	return sanitized
}

// rfc5987Encode percent-encodes name into RFC 8187's attr-char set. It is
// deliberately not url.PathEscape/QueryEscape: those leave characters
// (`$`, `&`, `+`, `=`, `@`, `:`, `;`, `,`) that are not attr-chars and would
// break header parsing, and QueryEscape turns a space into "+".
func rfc5987Encode(name string) string {
	if name == "" {
		return "download"
	}
	const hex = "0123456789ABCDEF"
	var b strings.Builder
	b.Grow(len(name))
	for i := 0; i < len(name); i++ {
		c := name[i]
		if isAttrChar(c) {
			b.WriteByte(c)
			continue
		}
		b.WriteByte('%')
		b.WriteByte(hex[c>>4])
		b.WriteByte(hex[c&0x0f])
	}
	return b.String()
}

func isAttrChar(c byte) bool {
	switch {
	case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
		return true
	}
	return strings.IndexByte("!#$&+-.^_`|~", c) >= 0
}
