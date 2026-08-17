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

// readOnlyBinaries are unconditionally read-only regardless of arguments:
// no subcommand of these programs is capable of mutating state.
var readOnlyBinaries = map[string]bool{
	"ls": true, "cat": true, "head": true, "tail": true,
	"grep": true, "egrep": true, "fgrep": true, "rg": true,
	"find": true, "stat": true, "file": true, "wc": true,
	"df": true, "du": true, "free": true, "uptime": true,
	"uname": true, "whoami": true, "id": true, "ps": true,
	"top": true, "journalctl": true, "dmesg": true, "hostname": true,
	"date": true, "env": true, "printenv": true, "ss": true,
	"netstat": true, "ip": true, "ping": true, "nproc": true,
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
		"branch": true, "remote": true,
	},
}

// outputFlaggedBinaries are read-only only when the segment carries none of
// their output-to-file flags.
var outputFlaggedBinaries = map[string]bool{
	"curl": true, "wget": true,
}

var outputFlags = []string{"-o", "-O", "--output", "--remote-name"}

// Classify labels a remote shell command as ClassRead or ClassMutate.
//
// The default is ClassMutate on purpose: this function is deliberately
// conservative. A command it cannot confidently prove is read-only is
// treated as mutating, so the caller gates it behind an approval. Misreading
// a mutation as read-only would let it run unapproved and could cause a
// production incident; misreading a read as mutating only costs the
// operator one extra approval click. When in doubt, this function is wrong
// in the safe direction.
func Classify(command string) Class {
	if strings.TrimSpace(command) == "" {
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

// splitSegments splits a command on the shell control operators |, &&, ||,
// and ; into individual segments to be classified independently.
func splitSegments(command string) []string {
	replacer := strings.NewReplacer("&&", ";", "||", ";", "|", ";")
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
// operators) by its first field.
func isSegmentReadOnly(segment string) bool {
	fields := strings.Fields(segment)
	if len(fields) == 0 {
		return false
	}
	bin := fields[0]

	if readOnlyBinaries[bin] {
		return true
	}

	if allowed, gated := subcommandAllowlist[bin]; gated {
		if len(fields) < 2 {
			return false
		}
		return allowed[fields[1]]
	}

	if outputFlaggedBinaries[bin] {
		for _, f := range fields[1:] {
			for _, flag := range outputFlags {
				if f == flag || strings.HasPrefix(f, flag+"=") {
					return false
				}
			}
		}
		return true
	}

	return false
}
