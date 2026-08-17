// devdeck-ssh is the helper binary a coding-agent CLI shells out to when its
// chat thread is bound to an SSH connection (sibling of cmd/mcp-server). The
// agent process has no SSH client of its own and no way to reach the remote
// host except through this program, which turns each subcommand into one
// authenticated HTTP call against DevDeck's own
// /api/agent-tools/ssh/* routes on the hub's loopback address.
//
// Its audience is a language model reading its stdout/stderr and exit code,
// not a person: every message here is written to be unambiguous to that
// reader, and to say plainly what it should do next.
//
// Session resolution: $DEVDECK_SSH_SESSION if set, else
// ./.devdeck/session.json relative to the process's working directory — the
// per-thread workspace sshthread.Seed creates and the agent is spawned into.
//
// Exit codes: 0 ok · 1 usage, transport, or auth failure · 2 the remote
// command itself exited non-zero (its stdout/stderr are still printed
// first) · 77 the operator declined the action.
package main

import (
	"fmt"
	"io"
	"os"
	"strings"
)

// usage is printed to stderr on any usage error. It documents exactly the
// five subcommands SKILL.md and AGENTS.md promise an agent — no more, no
// less.
const usage = `usage:
  devdeck-ssh exec  <command...>
  devdeck-ssh read  <path>
  devdeck-ssh list  <path>
  devdeck-ssh grep  <pattern>
  devdeck-ssh write <path>     # content on stdin`

func main() {
	os.Exit(run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
}

// run dispatches one subcommand and returns the process's exit code. It
// takes its I/O as parameters (rather than reading os.Stdin/os.Stdout
// directly) purely so it stays testable without an os.Exit in the way;
// main is the only caller in production.
func run(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprintln(stderr, usage)
		return 1
	}
	sub, rest := args[0], args[1:]
	switch sub {
	case "exec", "read", "list", "grep", "write":
		// recognised — fall through to session resolution below.
	default:
		fmt.Fprintf(stderr, "devdeck-ssh: unknown command %q\n%s\n", sub, usage)
		return 1
	}

	cwd, err := os.Getwd()
	if err != nil {
		fmt.Fprintf(stderr, "devdeck-ssh: %v\n", err)
		return 1
	}
	b, err := loadBinding(cwd)
	if err != nil {
		fmt.Fprintf(stderr, "devdeck-ssh: %v\n", err)
		return 1
	}
	c := newClient(b)

	switch sub {
	case "exec":
		return runExec(c, rest, stdout, stderr)
	case "read":
		return runRead(c, rest, stdout, stderr)
	case "list":
		return runList(c, rest, stdout, stderr)
	case "grep":
		return runGrep(c, rest, stdout, stderr)
	case "write":
		return runWrite(c, rest, stdin, stdout, stderr)
	}
	panic("unreachable")
}

// runExec joins every remaining argument into one command string — the
// remote shell interprets it, pipelines and redirection included. That is
// intentional (design §6): scoping and quoting are the shell's job, and
// every command still passes through the server-side classifier and
// approval gate before it runs. Stdout/stderr are always printed, even on a
// non-zero remote exit (exit code 2) or a denial (77), so the agent sees
// exactly what SKILL.md tells it to expect.
func runExec(c *client, args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprintln(stderr, "devdeck-ssh exec: a command is required")
		return 1
	}
	command := strings.Join(args, " ")
	res, code, err := c.exec(command)
	fmt.Fprint(stdout, res.Stdout)
	fmt.Fprint(stderr, res.Stderr)
	if err != nil {
		fmt.Fprintf(stderr, "devdeck-ssh: %v\n", err)
	}
	return code
}

// runRead prints a remote file's contents to stdout verbatim.
func runRead(c *client, args []string, stdout, stderr io.Writer) int {
	if len(args) != 1 {
		fmt.Fprintln(stderr, "devdeck-ssh read: exactly one path is required")
		return 1
	}
	res, code, err := c.read(args[0])
	if err != nil {
		fmt.Fprintf(stderr, "devdeck-ssh: %v\n", err)
		return code
	}
	fmt.Fprint(stdout, res.Content)
	return code
}

// runList prints a remote directory's entries, one per line, as
// "name<TAB>size<TAB>file|dir".
func runList(c *client, args []string, stdout, stderr io.Writer) int {
	if len(args) != 1 {
		fmt.Fprintln(stderr, "devdeck-ssh list: exactly one path is required")
		return 1
	}
	res, code, err := c.list(args[0])
	if err != nil {
		fmt.Fprintf(stderr, "devdeck-ssh: %v\n", err)
		return code
	}
	if len(res.Entries) == 0 {
		fmt.Fprintln(stdout, "(empty directory)")
		return code
	}
	for _, e := range res.Entries {
		kind := "file"
		if e.IsDir {
			kind = "dir"
		}
		fmt.Fprintf(stdout, "%s\t%d\t%s\n", e.Name, e.Size, kind)
	}
	return code
}

// runGrep prints every match as "path:line: text", one per line — familiar
// grep -n shape. A truncated result gets a trailing note on stderr so it
// doesn't get mistaken for a matched line; an empty result says so
// explicitly rather than printing nothing, since silence and "not gated
// yet" would otherwise look the same.
func runGrep(c *client, args []string, stdout, stderr io.Writer) int {
	if len(args) != 1 {
		fmt.Fprintln(stderr, "devdeck-ssh grep: exactly one pattern is required")
		return 1
	}
	res, code, err := c.grep(args[0])
	if err != nil {
		fmt.Fprintf(stderr, "devdeck-ssh: %v\n", err)
		return code
	}
	total := 0
	for _, f := range res.Files {
		for _, m := range f.Matches {
			fmt.Fprintf(stdout, "%s:%d: %s\n", f.Path, m.Line, m.Text)
			total++
		}
	}
	switch {
	case total == 0:
		fmt.Fprintln(stdout, "(no matches)")
	case res.Truncated:
		fmt.Fprintln(stderr, "devdeck-ssh: results were truncated; narrow the pattern for a complete list")
	}
	return code
}

// runWrite reads new file content from stdin and overwrites path with it —
// always a mutation, so this call may block on an approval card before it
// returns.
func runWrite(c *client, args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	if len(args) != 1 {
		fmt.Fprintln(stderr, "devdeck-ssh write: exactly one path is required")
		return 1
	}
	content, err := io.ReadAll(stdin)
	if err != nil {
		fmt.Fprintf(stderr, "devdeck-ssh: read stdin: %v\n", err)
		return 1
	}
	res, code, err := c.write(args[0], string(content))
	if err != nil {
		fmt.Fprintf(stderr, "devdeck-ssh: %v\n", err)
		return code
	}
	fmt.Fprintf(stdout, "wrote %d bytes to %s\n", len(res.Content), res.Path)
	return code
}
