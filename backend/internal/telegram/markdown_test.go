package telegram

import (
	"strings"
	"testing"
)

// The failure this whole file exists to prevent: an unescaped special
// character reaches Telegram, the send 400s with "can't parse entities", and
// the pump — which never advances its cursor past a message it could not send
// — freezes that thread's mirror permanently. So the DEFAULT for anything not
// positively recognized as markup must be "escaped".
func TestProseSpecialCharactersAreAllEscaped(t *testing.T) {
	got := ToMarkdownV2("Deploy selesai (v1.2.3) - 4 file berubah. Cek log!")
	for _, ch := range []string{"(", ")", "-", ".", "!"} {
		if strings.Contains(got, ch) && !strings.Contains(got, `\`+ch) {
			t.Fatalf("%q left unescaped in %q", ch, got)
		}
	}
}

func TestBoldBecomesSingleAsterisk(t *testing.T) {
	// The single most common miss: an agent writes **bold**, Telegram's bold
	// is one asterisk, and passing it through shows the asterisks literally.
	got := ToMarkdownV2("ini **penting** sekali")
	if !strings.Contains(got, "*penting*") {
		t.Fatalf("bold not converted: %q", got)
	}
	if strings.Contains(got, "**penting**") {
		t.Fatalf("double asterisk survived: %q", got)
	}
}

func TestItalicUsesUnderscoreWhicheverDelimiterTheSourceUsed(t *testing.T) {
	for _, src := range []string{"kata *miring* di sini", "kata _miring_ di sini"} {
		got := ToMarkdownV2(src)
		if !strings.Contains(got, "_miring_") {
			t.Fatalf("italic not converted for %q: %q", src, got)
		}
	}
}

func TestHeadingBecomesBoldBecauseTelegramHasNoHeadings(t *testing.T) {
	got := ToMarkdownV2("## Ringkasan")
	if !strings.Contains(got, "*Ringkasan*") {
		t.Fatalf("heading not bolded: %q", got)
	}
	if strings.Contains(got, "#") {
		t.Fatalf("literal hash left in: %q", got)
	}
}

func TestBulletsBecomeADotThatNeedsNoEscaping(t *testing.T) {
	got := ToMarkdownV2("- satu\n- dua")
	if !strings.Contains(got, "• satu") || !strings.Contains(got, "• dua") {
		t.Fatalf("bullets not converted: %q", got)
	}
	// A literal "-" would have to be escaped; "•" does not, which is the
	// point of substituting it.
	if strings.Contains(got, `\-`) {
		t.Fatalf("bullet left an escaped dash behind: %q", got)
	}
}

func TestOrderedListKeepsItsNumberAndEscapesTheDot(t *testing.T) {
	got := ToMarkdownV2("1. pertama")
	if !strings.Contains(got, `1\. pertama`) {
		t.Fatalf("ordered marker wrong: %q", got)
	}
}

// Code blocks are the reason tool output is readable at all, and the one
// place where the content must NOT be scanned for emphasis — a diff or a
// shell heredoc is full of *, _ and ` that are not markup.
func TestFencedCodeBlockIsPreservedVerbatim(t *testing.T) {
	got := ToMarkdownV2("jalankan:\n```sh\nrm -rf /tmp/*.log && echo \"done_now\"\n```\nselesai")
	if !strings.Contains(got, "rm -rf /tmp/*.log") {
		t.Fatalf("code block content was altered: %q", got)
	}
	if strings.Contains(got, `\_now`) {
		t.Fatalf("code block was scanned for emphasis: %q", got)
	}
	if !strings.HasPrefix(strings.Split(got, "\n")[1], "```") {
		t.Fatalf("fence missing: %q", got)
	}
}

// Streamed output regularly stops mid-block. Dropping the buffered lines
// would lose transcript, which is the one thing the mirror must never do.
func TestUnterminatedFenceIsClosedRatherThanDropped(t *testing.T) {
	got := ToMarkdownV2("output:\n```\nbaris satu\nbaris dua")
	if !strings.Contains(got, "baris dua") {
		t.Fatalf("unterminated fence dropped its content: %q", got)
	}
	if strings.Count(got, "```")%2 != 0 {
		t.Fatalf("fence left unbalanced: %q", got)
	}
}

func TestInlineCodeEscapesOnlyWhatBitesInsideIt(t *testing.T) {
	got := ToMarkdownV2("pakai `git commit -m \"pesan.\"` ya")
	if !strings.Contains(got, "`git commit -m \"pesan.\"`") {
		t.Fatalf("inline code was over-escaped: %q", got)
	}
}

func TestLinkKeepsItsTarget(t *testing.T) {
	got := ToMarkdownV2("lihat [docs](https://example.com/a_b)")
	if !strings.Contains(got, "](https://example.com/a_b)") {
		t.Fatalf("link target mangled: %q", got)
	}
}

// An unmatched delimiter is the classic source of "can't parse entities": the
// entity never closes and Telegram rejects the whole message.
func TestUnmatchedDelimitersAreEscapedNotEmitted(t *testing.T) {
	for _, src := range []string{"harga 5 * 3", "nilai_variabel saja", "tanda ` sendirian", "kurung [ saja"} {
		got := ToMarkdownV2(src)
		if !strings.Contains(got, `\`) {
			t.Fatalf("unmatched delimiter in %q was not escaped: %q", src, got)
		}
	}
}

func TestCodeBlockHelperEscapesBackticksInContent(t *testing.T) {
	got := CodeBlockMarkdownV2("echo `date`")
	if !strings.Contains(got, "\\`date\\`") {
		t.Fatalf("backticks in content not escaped: %q", got)
	}
}

// Every escape must be a backslash followed by the ORIGINAL character — a
// doubled or misplaced one shows up as a stray "\" in the chat.
func TestEscapeIsExactlyOneBackslashPerSpecial(t *testing.T) {
	got := EscapeMarkdownV2("a.b")
	if got != `a\.b` {
		t.Fatalf("EscapeMarkdownV2(\"a.b\") = %q", got)
	}
	if EscapeMarkdownV2("plain") != "plain" {
		t.Fatalf("ordinary text was altered")
	}
}
