# Spike: Claude's Program Status (OSC 7501) inside tmux

Date: 2026-11-08. Claude Code 2.1.319 (`$HOME/.toolbox/bin/claude`), tmux 3.8, macOS.

## Answer

Yes, with a small wrapper. Claude asks the terminal whether it understands OSC 7501, and only reports its status when
something answers. tmux never answers, and an answer sent later through tmux comes too late. A small PTY relay between
tmux and Claude (`devdesk_status.py`, Python 3 standard library) answers at once. Then Claude reports every state change,
and the relay writes the latest one to a file DevDesk reads.

The pane title is no use as a fallback inside tmux. Claude set it once to `✳ Claude Code` and never animated it, in turns
of 2 s and 12 s.

## What Claude sends

All runs used a throwaway server (`tmux -L osc-spike-<x> -f /dev/null`), a scratch folder, and
`claude --settings '{"disableAllHooks":true}'` so no hook wrote DevDesk state. The variables that tie a child Claude to
its parent (`CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_MESSAGING_SOCKET`, ...) were unset. Raw pane output
came from `tmux pipe-pane -O -t t 'cat > raw.bin'`. Before tmux parses the bytes, `-O` sees all of them, OSCs included.

### Spike A: plain Claude in tmux

At startup Claude sends the probe right before a DA1 query, which serves as its sentinel:

```
1316 ESC ] 7501 ; ? BEL
1325 ESC [ c
```

It sends this once, behind the trust dialog. tmux answers the DA1 and drops the unknown OSC. tmux 3.8 has no handler
for 7501, so the OSC does not reach the outer terminal either. `allow-passthrough` doesn't help, because it only
forwards DCS `tmux;` wrapped sequences, which Claude doesn't send. Claude's binary records the outcome:
`probe: no reply to OSC 7501 ; ?`. It reports no status after that.

The pane title is `#{pane_title}` from OSC 0. It stayed `✳ Claude Code` (`ESC]0;✳ Claude Code BEL`, the only title
OSC in the stream) through two turns. Orca's spinner glyphs (`◐◑◒◓`) never appeared.

### Spike C: answer late through tmux

`pipe-pane -O` fed a watcher that ran `tmux send-keys -H` with the reply as soon as it saw the probe. The reply landed
37 ms after the probe (`1.721 probe`, `1.758 answered`). That was too late, because tmux had already answered the DA1.
Claude reported nothing in a turn, and the reply didn't show up as typed text either. A late answer is ignored.

### Spike B: a PTY relay answers

`python3 -I shim.py log claude ...` runs Claude in a PTY of its own. It copies bytes both ways, and the moment Claude's
output holds `ESC]7501;?` it writes this to Claude's input, ahead of tmux's DA1 reply:

```
ESC ] 7501 ; ? : states=idle,working,done,blocked,error : kinds=permission,question,auth ESC \
```

Observed (seconds since start, OSC bodies):

```
0.739 0;✳ Claude Code
0.836 7501;?
0.901 7501;state=idle:app=claude-code
0.901 0;Claude Code                       <- once answered, Claude drops the ✳ from the title
14.491 7501;state=working:app=claude-code
18.147 7501;state=blocked:app=claude-code:kind=question:msg=YW5zd2VyOiBQaWNrIEEgb3IgQj8gKEEgwrcgQik=
                                          (msg = "answer: Pick A or B? (A · B)", an AskUserQuestion)
33.776 7501;state=working:app=claude-code
36.492 7501;state=done:app=claude-code    <- turn finished
59.242 7501;state=working:app=claude-code
61.919 7501;state=blocked:app=claude-code:kind=permission:msg=YXBwcm92ZSBCYXNoOiB0b3VjaCBzcGlrZS1maWxl
                                          (msg = "approve Bash: touch spike-file")
79.024 7501;state=idle:app=claude-code    <- permission denied with Escape (turn interrupted)
83.009 7501;state=clear                   <- /exit
83.009 0;
```

Once the probe is answered, `pipe-pane -O` sees the same reports, so tmux passes Claude's output through to its parser
untouched. Typing at the prompt sends no report. Claude reports `done` after a finished turn and `idle` after an
interrupted one. The protocol never says whether text is typed at the prompt.

## What DevDesk does with it

See `src/core/programStatus.ts`. The setting `devdesk.sessions.programStatus` is on by default. Then new sessions run
`python3 -I ~/.claude/devdesk/devdesk_status.py <state dir>/status <claude ...>`. The relay writes
`<state dir>/status/<server>-<pane number>.json`, holding the last root report's body, when Claude first sent it (a
repeat keeps the time), the relay's pid and how many child records (subagents) last reported blocked, and deletes the
file when Claude exits. The relay answers the probe and nothing else. It leaves the bytes untouched.

- The 3 s refresh reads that directory: one `readdir` and one small file per relayed session, with no subprocess. A
  card with no hooks (`unknown`) takes the reported state: working, waiting (permission, question or sign-in, with
  Claude's message as its detail), done, idle, or blocked (error). A card with hooks keeps their state, except where
  `src/core/statusMerge.ts` lets the report go first: a wait (or a sign-in) the hooks haven't reported yet, and a
  working or waiting record unchanged for `devdesk.sessions.hooksQuietMinutes` while Claude reports another state.
- "Send to session" and ←: a `working` or `blocked` report says Claude is busy, or a dialog is open, without reading the
  screen. When there is no report, or it says idle or done, `claudePrompt.ts` still decides from the pane (its tmux flags and its screen)
  whether anything is typed.

Costs and limits:

- Every byte to and from Claude passes through one Python process per session. It's idle between bytes. tmux shows the
  pane's command as `python3`. DevDesk already finds Claude by its process tree, so nothing else changes.
- Python 3 must run. DevDesk checks once (`python3 -I -c ''`) and starts Claude directly when it can't. If something
  fails before the relay forks, it runs Claude itself.
- It only wraps the default command (`claudePath` + `claudeArgs`). A full `devdesk.sessions.command` runs as written.
- Sessions started before the setting was turned on, and Claude versions before 2.1.295, report nothing and keep the
  old behavior.

## Reproduce

The scripts used are short. Start a throwaway server, pipe raw output, and run Claude with hooks off:

```sh
tmux -L osc-spike-a -f /dev/null new-session -d -s t -x 120 -y 40 -c /tmp/osc-spike/work \
  "env -u CLAUDECODE -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_MESSAGING_SOCKET $HOME/.toolbox/bin/claude --settings '{\"disableAllHooks\":true}'"
tmux -L osc-spike-a pipe-pane -O -t t 'cat > /tmp/osc-spike/raw-a.bin'
# ...look for \x1b]7501; in raw-a.bin, then:
tmux -L osc-spike-a kill-server
```

For spike B, put `python3 -I ~/.claude/devdesk/devdesk_status.py /tmp/osc-spike/status` before the Claude binary. Then
read `/tmp/osc-spike/status/osc-spike-b-<pane>.json`.
