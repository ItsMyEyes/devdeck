---
name: devops-ssh
description: Operate the remote server this chat is attached to, through DevDeck's devdeck-ssh helper — run commands, read files, list directories, grep and write. Use it for any question about that host: why a service is down, what a config says, what a log shows, or applying a fix.
category: devops
---

# Remote server work over DevDeck's SSH bridge

The operator has an SSH session open to one host and is asking you about it.
You reach that host only through `devdeck-ssh`. Every invocation goes to
DevDeck, which runs it on the connection this chat is bound to. You never pick
the host, never pass credentials, and never call `ssh` yourself.

## The commands

```
devdeck-ssh exec  <command...>                # run a shell command on the host
devdeck-ssh read  <path>                      # file contents
devdeck-ssh list  <path>                      # directory entries
devdeck-ssh grep  <pattern>                   # search file contents on the host
devdeck-ssh write <path>                      # new content on stdin
```

`read`, `list` and `grep` are the ones to reach for. They return structured
output instead of raw terminal noise, and DevDeck can wave them through without
bothering the operator. Use `exec` when the work genuinely is a command —
`systemctl status`, `journalctl`, `docker ps`, `df -h`.

Exit codes:

| Code | Meaning | What you do |
|---|---|---|
| `0` | it worked | carry on |
| `1` | usage, transport or auth failure | the message says which; if the session expired, ask the operator to restart the chat |
| `2` | the remote command ran and exited non-zero | its stdout/stderr are printed above — read them, this is evidence |
| `77` | the operator declined | stop, explain, ask (see below) |

## Reads are free — use them

Nothing you read is gated. There is no budget to protect and no reason to
guess. Before you name a cause, confirm it: check the unit, then its log, then
the config it loads, then the port it should be holding. Chain them.

## Writes pause for a human

Any command that could change the server's state may block while the operator
approves it in the chat UI. The call simply does not return until they answer,
and that can take minutes.

That wait is the design, not a hang. Do not retry the command, do not fork a
second attempt, do not try to smuggle the same effect through a path you think
is unwatched. Wait.

## Exit code 77: the operator said no

77 is a person declining, not a permissions bug. When you see it:

1. Stop the line of work. Do not run the next command in your plan.
2. Say plainly what you tried to run and what you expected it to fix.
3. Ask them how they want to proceed, and offer the alternative you would pick.

Never rephrase a refused action to get around the refusal — no splitting one
`rm` into three, no doing by hand what the script would have done. If the
operator declined a restart, the answer is a conversation, not a workaround.

## Memory persists across sessions

DevDeck automatically retains what happens in this chat and recalls relevant
parts back into later conversations — on this host, and across every other
project on the dashboard. You do not need to re-discover this host's layout
every session; if something looks familiar, it may be because a past session
already worked it out.

When `retain`/`recall`/`reflect` tools are available, reach for them to save
one fact worth keeping on its own — "the deploy script lives at
/opt/deploy/run.sh, not the repo root" — or to check whether a past session
already answered the question in front of you, before spending several
`exec`/`read` calls re-deriving it. Skip this section entirely if those tools
are not present; automatic capture still covers you.

## `.devdeck/session.json`

That file is DevDeck's machine-readable binding for this workspace: how the
helper finds the hub and proves which connection it may touch. It is for the
tooling, not for you. You need nothing out of it. Do not read it, print it,
summarise it, paste it into chat, or hand it to a command.

---

## Worked examples

### Why is a service unhealthy

Start at the unit, follow to its log, end at the config it read. Do not stop at
"it's dead".

```
$ devdeck-ssh exec systemctl status nginx --no-pager
● nginx.service - A high performance web server
     Active: failed (Result: exit-code) since Mon 2026-08-17 09:14:22 UTC
    Process: 8821 ExecStartPre=/usr/sbin/nginx -t (code=exited, status=1)

$ devdeck-ssh exec journalctl -u nginx -n 40 --no-pager
nginx[8821]: [emerg] cannot load certificate "/etc/ssl/site/fullchain.pem":
             BIO_new_file() failed (No such file or directory)

$ devdeck-ssh list /etc/ssl/site
privkey.pem  4096  file
```

Now you know something: the cert half of the pair is missing, the key is
there. Report that, with the three lines that prove it, and ask where
`fullchain.pem` went before you propose replacing anything.

### Read a config file

```
$ devdeck-ssh read /etc/nginx/sites-enabled/api.conf
```

`read` takes no flags — it returns the whole file. For a large one, find the
line first, then pull a window around it with `exec`:

```
$ devdeck-ssh exec grep -rn 'proxy_pass' /etc/nginx
/etc/nginx/sites-enabled/api.conf:31:    proxy_pass http://127.0.0.1:8080;

$ devdeck-ssh exec sed -n '20,45p' /etc/nginx/sites-enabled/api.conf
```

Use bare `grep` when you do not know which directory to look in; it searches
the host and hands back structured matches. Use `exec grep -rn <dir>` when you
do — it is faster and the output is already scoped.

### Tail a log

There is no follow mode — nothing here streams forever. Take a window, and
take another one if you need it.

```
$ devdeck-ssh exec journalctl -u api --since '30 min ago' --no-pager
$ devdeck-ssh exec tail -n 200 /var/log/api/error.log
$ devdeck-ssh exec grep -rn 'ECONNREFUSED' /var/log/api
```

Prefer `--no-pager` and an explicit `-n`/`--since`. An unbounded `journalctl`
returns a wall of text neither of you will read.

### Make a change

Say the evidence points at a worker count that is too low.

```
$ devdeck-ssh read /etc/api/api.env
WORKERS=2
TIMEOUT=30

$ printf 'WORKERS=8\nTIMEOUT=30\n' | devdeck-ssh write /etc/api/api.env
```

`write` is a mutation, so this is where the approval card appears in the chat.
The command sits there until the operator answers. Then:

```
$ devdeck-ssh exec systemctl restart api
$ devdeck-ssh exec systemctl is-active api
active
```

Two mutations, two approvals — expect both, and say what each one is for
before you run it, so the operator can decide without having to ask you.

If the restart comes back 77:

> I tried `systemctl restart api` to pick up `WORKERS=8`, which I'd just
> written to `/etc/api/api.env`. You declined, so the file is changed but the
> running process is still on the old value. Want me to revert the file, or
> would you rather restart it yourself during a window?

That is the whole move: state the action, state the current state of the
world, hand the decision back.
