package handler

import "testing"

func TestContentDispositionEscapesHostileNames(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{
			name:  "plain ascii",
			input: "report.pdf",
			want:  `attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`,
		},
		{
			// A leading dot is not the trailing-dot hazard, and stripping it
			// would silently rename every dotfile for clients that read only
			// the quoted-string parameter.
			name:  "dotfile keeps its leading dot in both parameters",
			input: ".gitignore",
			want:  `attachment; filename=".gitignore"; filename*=UTF-8''.gitignore`,
		},
		{
			name:  "trailing dots and spaces are still stripped",
			input: "report.pdf. ",
			want:  `attachment; filename="report.pdf"; filename*=UTF-8''report.pdf.%20`,
		},
		{
			name:  "double quote would close the quoted-string early",
			input: `we"ird.txt`,
			want:  `attachment; filename="we_ird.txt"; filename*=UTF-8''we%22ird.txt`,
		},
		{
			name:  "backslash would escape the closing quote",
			input: `we\ird.txt`,
			want:  `attachment; filename="we_ird.txt"; filename*=UTF-8''we%5Cird.txt`,
		},
		{
			name:  "newline would split the response header",
			input: "evil\r\nX-Injected: 1.txt",
			want:  `attachment; filename="evil__X-Injected: 1.txt"; filename*=UTF-8''evil%0D%0AX-Injected%3A%201.txt`,
		},
		{
			// One "_" per UTF-8 byte, not per rune — the ASCII form is only a
			// legacy fallback, so a faithful transliteration isn't worth it.
			name:  "non-ascii survives only in the RFC 5987 parameter",
			input: "résumé.pdf",
			want:  `attachment; filename="r__sum__.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf`,
		},
		{
			name:  "cjk name",
			input: "报告.txt",
			want:  `attachment; filename="______.txt"; filename*=UTF-8''%E6%8A%A5%E5%91%8A.txt`,
		},
		{
			name:  "name that sanitizes away entirely falls back to download",
			input: "\x00\x01",
			want:  `attachment; filename="download"; filename*=UTF-8''%00%01`,
		},
		{
			name:  "empty name falls back to download in both parameters",
			input: "",
			want:  `attachment; filename="download"; filename*=UTF-8''download`,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := contentDisposition(tt.input); got != tt.want {
				t.Errorf("contentDisposition(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

// A header value containing CR or LF is the one outcome that turns a filename
// into a response-splitting vector, so it is asserted separately from the
// exact-string table above.
func TestContentDispositionNeverEmitsBareCRLF(t *testing.T) {
	for _, name := range []string{"a\nb", "a\rb", "a\r\nb", "\n", "ok.txt"} {
		got := contentDisposition(name)
		for _, c := range got {
			if c == '\r' || c == '\n' {
				t.Errorf("contentDisposition(%q) = %q contains a raw CR/LF", name, got)
				break
			}
		}
	}
}
