package telegram

import "testing"

func TestParseCommand(t *testing.T) {
	cases := []struct {
		in       string
		wantName string
		wantArgs int
		wantOK   bool
	}{
		{"/pair 482913", "pair", 1, true},
		{"/model", "model", 0, true},
		// Telegram appends @botname when several bots share a group.
		{"/new@devdeck_bot", "new", 0, true},
		{"restart the api", "", 0, false},
		{"  /skills  ", "skills", 0, true},
		{"tolong jalankan /compact nanti", "", 0, false},
	}
	for _, c := range cases {
		got, ok := ParseCommand(c.in)
		if ok != c.wantOK {
			t.Fatalf("ParseCommand(%q) ok = %v, want %v", c.in, ok, c.wantOK)
		}
		if ok && (got.Name != c.wantName || len(got.Args) != c.wantArgs) {
			t.Fatalf("ParseCommand(%q) = %+v, want %s/%d args", c.in, got, c.wantName, c.wantArgs)
		}
	}
}

func TestNextChatSuffix(t *testing.T) {
	// ::chat-N is allocated client-side today (frontend paneTree.ts:257), so
	// the bridge has to allocate its own. Gaps are not reused: a deleted
	// chat-2 must not have its transcript resurrected under a new binding.
	got := NextChatSuffix([]string{"ssh:c-a1", "ssh:c-a1::chat-2", "other"}, "ssh:c-a1")
	if got != "ssh:c-a1::chat-3" {
		t.Fatalf("NextChatSuffix = %q", got)
	}
	if first := NextChatSuffix([]string{"ssh:c-a1"}, "ssh:c-a1"); first != "ssh:c-a1::chat-2" {
		t.Fatalf("first extra chat = %q, want ::chat-2", first)
	}
}
