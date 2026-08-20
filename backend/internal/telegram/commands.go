package telegram

import (
	"fmt"
	"strconv"
	"strings"
)

// ParsedCommand is one recognized Telegram slash command with its raw
// argument words. Recognized Names, handled by the bridge: "pair", "init",
// "new", "resume", "model", "agents", "permissions", "skills", "compact",
// "stop", "status", "unpublish". Unlike "pair", "init" is NOT a pre-auth command — it binds a
// destination to a thread whose agent can run shell commands on production
// servers, so the bridge still requires the sender be on the allowlist.
// ParseCommand itself does not check Name against that list — deciding what
// an unrecognized-but-well-formed command means (typo vs. future feature) is
// the bridge's call, not the parser's.
type ParsedCommand struct {
	Name string
	Args []string
}

// ParseCommand recognizes a Telegram slash command out of raw message text.
// Pure string parsing: no I/O, no lookups, nothing provider-specific.
//
// A "/" that is not at the very start of the TRIMMED text is not a command
// at all — "tolong jalankan /compact nanti" is an ordinary sentence that
// happens to mention a command, not the command itself, and must fall
// through to the plain-text path (a normal turn) rather than being parsed.
func ParseCommand(text string) (ParsedCommand, bool) {
	trimmed := strings.TrimSpace(text)
	if !strings.HasPrefix(trimmed, "/") {
		return ParsedCommand{}, false
	}
	fields := strings.Fields(trimmed)
	if len(fields) == 0 {
		return ParsedCommand{}, false
	}

	word := fields[0]
	// Telegram appends @botname to the command word whenever several bots
	// share a group, so "/new@devdeck_bot" and "/new" must parse identically.
	if at := strings.IndexByte(word, '@'); at >= 0 {
		word = word[:at]
	}
	name := strings.ToLower(strings.TrimPrefix(word, "/"))
	if name == "" {
		return ParsedCommand{}, false
	}
	return ParsedCommand{Name: name, Args: fields[1:]}, true
}

// NextChatSuffix reimplements, server-side, the extra-chat-pane numbering
// the frontend allocates client-side today (createAgentChatPane in
// frontend/src/features/terminal/paneTree.ts:257, nextFreeThreadKey in
// frontend/src/features/agent-chat/SessionsPanel.tsx:93). The bridge needs
// its own allocator because /new can be typed from Telegram, where there is
// no frontend pane tree to consult.
//
// base is the primary thread id (e.g. "ssh:c-a1"); extra panes are
// base+"::chat-"+N. The bare base is implicitly chat 1, so the first extra
// is ::chat-2. NextChatSuffix takes the MAXIMUM N seen in existing, not the
// first free slot: gaps are not reused, because a deleted chat-2's
// transcript must not be resurrected under a freshly issued binding that
// happens to reuse its id.
func NextChatSuffix(existing []string, base string) string {
	prefix := base + "::chat-"
	max := 1 // the bare base counts as chat 1
	for _, id := range existing {
		suffix, ok := strings.CutPrefix(id, prefix)
		if !ok {
			continue
		}
		n, err := strconv.Atoi(suffix)
		if err != nil {
			continue
		}
		if n > max {
			max = n
		}
	}
	return fmt.Sprintf("%s%d", prefix, max+1)
}
