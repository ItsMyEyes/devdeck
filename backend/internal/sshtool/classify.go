// Package sshtool provides the pure-function policy pieces used by the SSH
// DevOps chat feature: classifying remote shell commands as read-only or
// mutating, and minting the process-lifetime tokens that authenticate the
// agent's calls back into DevDeck's own HTTP API.
package sshtool

import "strings"

// Class labels a remote shell command as either read-only or state-changing.
type Class string

const (
	// ClassRead means the command only observes remote state.
	ClassRead Class = "read"
	// ClassMutate means the command may change remote state, or its effect
	// could not be established with confidence.
	ClassMutate Class = "mutate"
)

// readOnlyBinaries are read-only regardless of arguments: no flag or
// subcommand of these programs changes state.
//
// Membership here is a strong claim, and several binaries that look like they
// belong were deliberately moved out after they were shown to mutate on one
// flag — see denyTokenBinaries. `env` was removed outright: it runs whatever
// program follows its assignments, so it is only ever as safe as its
// argument, which is a different question than the one this map answers.
var readOnlyBinaries = map[string]bool{
	"ls": true, "cat": true, "head": true, "tail": true,
	"grep": true, "egrep": true, "fgrep": true, "rg": true,
	"stat": true, "file": true, "wc": true,
	"df": true, "du": true, "free": true, "uptime": true,
	"uname": true, "whoami": true, "id": true, "ps": true,
	"top": true, "hostname": true, "printenv": true,
	"netstat": true, "ping": true, "nproc": true,
	"lsblk": true, "lsof": true, "sensors": true,
}

// subcommandAllowlist lists, per binary, the second words that keep the
// command read-only. Any other second word (or none) makes the segment
// mutating.
var subcommandAllowlist = map[string]map[string]bool{
	"systemctl": {
		"status": true, "show": true, "list-units": true,
		"list-unit-files": true, "is-active": true, "is-enabled": true,
		"cat": true,
	},
	"docker": {
		"ps": true, "logs": true, "inspect": true, "images": true,
		"stats": true, "top": true, "version": true, "info": true,
	},
	"kubectl": {
		"get": true, "describe": true, "logs": true, "top": true,
		"version": true, "explain": true,
	},
	"git": {
		"status": true, "log": true, "diff": true, "show": true,
	},
}

// denyTokenBinaries are read-only for their everyday use and destructive with
// one particular flag or subcommand word. The binary alone proves nothing, so
// each listed token disqualifies the whole segment wherever it appears.
//
// This is the shape the plain allowlist got wrong: `find` deletes with
// -delete, `ip` takes an interface down with `set`, `journalctl` destroys the
// audit trail it is supposed to show, and `dmesg -C` erases the kernel ring
// buffer an operator is usually mid-way through reading.
var denyTokenBinaries = map[string][]string{
	"find": {
		"-delete", "-exec", "-execdir", "-ok", "-okdir",
		"-fls", "-fprint", "-fprint0", "-fprintf",
	},
	"date": {"-s", "--set", "--file"},
	"journalctl": {
		"--vacuum-size", "--vacuum-time", "--vacuum-files",
		"--rotate", "--flush", "--sync", "--relinquish-var",
		"--smart-relinquish-var", "--setup-keys",
	},
	"dmesg": {"-C", "--clear", "-c", "--read-clear"},
	"ss":    {"-K", "--kill"},
	"ip": {
		"set", "add", "del", "delete", "change", "replace",
		"flush", "append", "prepend", "up", "down",
	},
}

// shortDenyLetters catches a deny flag hiding inside a bundled short-flag
// group, which exact-match token comparison never sees: `dmesg -Cw` clears
// the buffer just as `dmesg -C` does.
var shortDenyLetters = map[string]string{
	"dmesg": "Cc",
	"ss":    "K",
	"date":  "s",
}

// curlReadOnlyLongFlags is an ALLOWLIST, not a blocklist. curl's ways of
// writing to disk or pushing data outnumber its ways of merely fetching
// (-o, -O, -T, -d, --upload-file, --data-*, -X POST, --output-dir, …), and a
// blocklist of the four most famous ones was defeated by every alternate
// spelling. Anything unrecognised here means mutate, matching this file's
// stated philosophy.
var curlReadOnlyLongFlags = map[string]bool{
	"--silent": true, "--show-error": true, "--fail": true,
	"--location": true, "--include": true, "--head": true,
	"--insecure": true, "--verbose": true, "--max-time": true,
	"--connect-timeout": true, "--header": true, "--user-agent": true,
	"--compressed": true, "--retry": true, "--no-progress-meter": true,
	"--url": true, "--resolve": true, "--http1.1": true, "--http2": true,
}

// curlReadOnlyShortLetters are the single-dash flags that keep curl a read.
// Bundles are checked letter by letter, so `-fsSL` passes and `-sO` does not.
// Note the omissions: o, O, T, d, X, F.
//
// `H` is here because `--header` is on the long allowlist above and `-H` is
// the same flag — leaving it out gated `curl -H 'Accept: …' <url>`, an
// entirely ordinary read, while the spelled-out form went through.
const curlReadOnlyShortLetters = "sSfLiIkvm#H"

// Classify labels a remote shell command as ClassRead or ClassMutate.
//
// The default is ClassMutate on purpose: this function is deliberately
// conservative. A command it cannot confidently prove is read-only is
// treated as mutating, so the caller gates it behind an approval. Misreading
// a mutation as read-only would let it run unapproved and could cause a
// production incident; misreading a read as mutating only costs the
// operator one extra approval click. When in doubt, this function is wrong
// in the safe direction.
//
// wget appears in none of the tables above, and that is the decision, not an
// omission: wget writes a file with no flags at all, so there is no useful
// read-only form of it to allow.
func Classify(command string) Class {
	if strings.TrimSpace(command) == "" {
		return ClassMutate
	}

	// A newline separates statements exactly as `;` does, and strings.Fields
	// treats it as ordinary whitespace — so a command carrying one would have
	// only its first line classified and the rest waved through. Rather than
	// teach every downstream check about control characters, refuse them: a
	// legitimate diagnostic never needs one, and a shell metacharacter smuggled
	// past the splitter is the one failure this whole function exists to
	// prevent. Tab is allowed; it is only ever whitespace.
	if hasControlCharacter(command) {
		return ClassMutate
	}

	if strings.ContainsAny(command, "><`") || strings.Contains(command, "$(") {
		return ClassMutate
	}
	if containsSudoToken(command) {
		return ClassMutate
	}

	segments := splitSegments(command)
	if len(segments) == 0 {
		return ClassMutate
	}
	for _, seg := range segments {
		if !isSegmentReadOnly(seg) {
			return ClassMutate
		}
	}
	return ClassRead
}

// hasControlCharacter reports whether s contains any control character other
// than tab — newline and carriage return above all, which are statement
// separators the segment splitter would otherwise never see.
func hasControlCharacter(s string) bool {
	for _, r := range s {
		if r == '\t' {
			continue
		}
		if r < 0x20 || r == 0x7f {
			return true
		}
	}
	return false
}

// containsSudoToken reports whether "sudo" appears as a standalone token in
// the command, not merely as a substring of another word.
func containsSudoToken(command string) bool {
	for _, field := range strings.Fields(command) {
		if field == "sudo" {
			return true
		}
	}
	return false
}

// splitSegments splits a command on the shell control operators |, &&, ||, &
// and ; into individual segments to be classified independently.
//
// The replacer's order is load-bearing: && and || must be consumed before the
// single-character & and | they contain, or `&&` would split into two empty
// halves and `a & b` — a background job, every bit as much a second statement
// as `a ; b` — would go unnoticed.
func splitSegments(command string) []string {
	replacer := strings.NewReplacer("&&", ";", "||", ";", "&", ";", "|", ";")
	raw := strings.Split(replacer.Replace(command), ";")
	segments := make([]string, 0, len(raw))
	for _, seg := range raw {
		seg = strings.TrimSpace(seg)
		if seg == "" {
			continue
		}
		segments = append(segments, seg)
	}
	return segments
}

// isSegmentReadOnly classifies a single pipeline segment (no control
// operators) by its first field and, where the binary demands it, by its
// remaining fields.
func isSegmentReadOnly(segment string) bool {
	fields := strings.Fields(segment)
	if len(fields) == 0 {
		return false
	}
	bin := fields[0]

	if readOnlyBinaries[bin] {
		return true
	}

	if denyTokens, gated := denyTokenBinaries[bin]; gated {
		return !hasDenyToken(bin, fields[1:], denyTokens)
	}

	if allowed, gated := subcommandAllowlist[bin]; gated {
		if len(fields) < 2 {
			return false
		}
		return allowed[fields[1]]
	}

	if bin == "curl" {
		return curlFieldsReadOnly(fields[1:])
	}

	return false
}

// hasDenyToken reports whether any argument disqualifies a denyTokenBinaries
// segment — matching a token exactly, as `token=value`, or as one letter of a
// bundled short-flag group.
func hasDenyToken(bin string, args, denyTokens []string) bool {
	letters := shortDenyLetters[bin]
	for _, arg := range args {
		for _, tok := range denyTokens {
			if arg == tok || strings.HasPrefix(arg, tok+"=") {
				return true
			}
		}
		if letters == "" || !strings.HasPrefix(arg, "-") || strings.HasPrefix(arg, "--") {
			continue
		}
		if strings.ContainsAny(arg[1:], letters) {
			return true
		}
	}
	return false
}

// curlFieldsReadOnly reports whether every flag in a curl segment is on the
// read-only allowlist. Non-flag arguments (URLs, and the values belonging to
// flags like --header) are ignored: they cannot make curl write on their own.
func curlFieldsReadOnly(args []string) bool {
	for _, arg := range args {
		if !strings.HasPrefix(arg, "-") || arg == "-" {
			continue
		}
		if strings.HasPrefix(arg, "--") {
			name := arg
			if i := strings.IndexByte(arg, '='); i >= 0 {
				name = arg[:i]
			}
			if !curlReadOnlyLongFlags[name] {
				return false
			}
			continue
		}
		for _, letter := range arg[1:] {
			if !strings.ContainsRune(curlReadOnlyShortLetters, letter) {
				return false
			}
		}
	}
	return true
}
