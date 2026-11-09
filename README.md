# DevDesk Claude

**Claude Code sessions in VS Code that never die: they run in tmux, so closing VS Code never stops Claude.**

A VS Code extension for people who run several [Claude Code](https://docs.anthropic.com/en/docs/claude-code) sessions at
once, on their own machine or on a remote one over Remote-SSH.

- **[Sessions that never die](#sessions-that-never-die):** close the tab, reload, lose the connection, shut the laptop: Claude keeps working.
- **[Every session at a glance](#every-session-at-a-glance):** the real Claude Code CLI in an editor tab, and a side panel that shows which session needs you, by worktree or as one list, in colors you pick.
- **[Worktrees and their diffs](#worktrees-and-their-diffs):** one session per git worktree, and what each one changed, live.
- **[The Claude Board](#the-claude-board):** every session as a card, in lanes by state, with what each one is doing or asking you.
- **[A prompt box like Claude Code's](#a-prompt-box-like-claude-codes):** start sessions with a mode, a model, `/` commands, `@` files and pasted images.
- **[Token usage](#token-usage):** tokens by day, week and month, per project and worktree or across all projects, and how much came from the cache.

### Sessions that never die

![VS Code attaches to tmux, which keeps one Claude Code per session running](images/how-it-works.png)

**VS Code** shows your sessions, **tmux** keeps them running, **Claude Code** does the work. VS Code is only a window
onto tmux, so whatever happens to it, Claude carries on, and the terminals you had open come back when you return.
Sessions idle for days are parked to free memory, and resume when you open them.

### Every session at a glance

![The Agent Sessions panel with colored sessions by worktree, next to a Claude session asking for permission to edit a file](images/terminal.png)

Each session is the real Claude Code CLI in its own editor tab, with all its keys and slash commands. The side panel
lists every session by worktree, the most urgent first: *needs permission*, *question for you*, *plan to review*,
*working*, *done*, with a dot on the ones you haven't read. **N need you** in the status bar jumps to the next one.
**Fork** a session to try something without losing the conversation.

![The same sessions grouped by worktree, and as one flat list where each row names its worktree](images/sessions-tree-flat.png)

Group the sessions by worktree, or click **List All Sessions** for one flat list, most urgent first. Background work a
session started (a long shell command, a subagent) shows under it. Right-click a session and pick **Color ▸** to tell
sessions apart at a glance: the color shows in the panel and on the board.

### Worktrees and their diffs

![The Worktrees section with a worktree's changed files, and the diff of one of them](images/diff.png)

**New Worktree Session** makes a Claude Code worktree named after your task and starts Claude there. The **Worktrees**
section lists what each worktree changed; click a file for its diff against the main branch or only the uncommitted
part, while Claude is still working. **✕** deletes a worktree you're done with, and its sessions. It works in any git
repository, with every `git worktree` (including Claude Code's own `.claude/worktrees/*`). In a folder that isn't a git
repository, sessions and the board work as usual, all in main, and there are no worktrees.

Leave notes on the lines of a diff, then **Send Notes to Claude**: they go to the worktree's session as one prompt (see
the [manual](MANUAL.md#leave-notes-for-claude-on-a-diff)). Claude can open files and diffs for you too, and put a note
on its card, with the [`devdesk` command](MANUAL.md#16-the-devdesk-command).

### The Claude Board

![The Claude Board: prompts for later, and every session in lanes by state; Needs you cards say what Claude asks](images/board.png)

Every session as a card in lanes, moving on its own as Claude works:

- **Needs you**: what Claude asks, in one line under the kind of ask: a **question** (with the question itself), a
  **permission** to approve, or a **plan to review**, and how long it has been waiting.
- **Working**: what Claude is doing right now, such as *Run 2 of 6 is going*, including background work it started.
- **Done / idle**: finished sessions. Once you've read them, idle, parked and long-done ones move under an *Idle /
  stopped* divider.

A small model (Haiku) titles each card with what the session sets out to do, writes its live status, and a short
summary of where the work stands in the card's hover. Save prompts for later and run them when you're ready with
**▶ Start**, **Plan** or **Spec**. The board works from the keyboard: arrows between cards and lanes, Enter to open a
session. Search the board and past sessions: type to filter, Enter to ask ✨ a model. Open it from the colored board
button at the top right of any editor.

### A prompt box like Claude Code's

![The board's prompt box with the / menu of Claude Code's commands and skills](images/prompt-box.png)

Under the board, a prompt box starts a new session in main, a worktree, or a new worktree, in the background. Pick the
mode (Shift+Tab), the model and effort; `/` lists every command and skill Claude Code has in that folder, `@` mentions
files, and ⌘V pastes images. **⌥⏎** saves the prompt for later instead.

### Token usage

![The board's 📊 popup: today, this week and the last 30 days, then today by worktree, by model and the top sessions](images/usage-popup.png)

**📊** on the board shows today's, this week's and the last 30 days' tokens, and today's by worktree, by model and per
session. **More…** opens **Claude Usage**: tokens by day, week or month, how much was read from the prompt cache, and
how the period splits across your projects (or a project's worktrees). DevDesk keeps the history after Claude Code
deletes old transcripts.

![The Claude Usage page: tokens per week across all projects, new and cached, with the cached share](images/usage.png)

## Requirements

DevDesk Claude runs where your code is: your Mac or Linux machine, or a remote Linux machine you open with
[Remote-SSH](https://code.visualstudio.com/docs/remote/ssh). There it needs:

- **VS Code** 1.95 or newer.
- **[Claude Code](https://docs.anthropic.com/en/docs/claude-code/setup)**, the `claude` CLI, signed in (any account or
  provider Claude Code supports). If it isn't on your `PATH`, set `devdesk.sessions.claudePath`.
- **tmux**. If it's missing, DevDesk offers to install it (`brew install tmux` on macOS, `sudo yum install -y tmux`
  elsewhere; set `devdesk.sessions.tmuxInstallCommand` for `apt` and others).
- **python3**, which runs the small hook script that reports each session's state.

Windows isn't supported directly (tmux doesn't run there); use WSL or a Remote-SSH machine.

## Install

The extension isn't on the VS Code Marketplace. Install the VSIX from the
[latest release](https://github.com/roniburd/devdesk-agent/releases/latest):

```bash
curl -LO https://github.com/roniburd/devdesk-agent/releases/latest/download/devdesk-claude.vsix
code --install-extension devdesk-claude.vsix
```

For a remote machine, open a Remote-SSH window, then in the Extensions view choose **… → Install from VSIX…** (it
installs on the remote), or run the same `code --install-extension` in that window's terminal. Then run
**Developer: Reload Window**.

To update, install the newer VSIX the same way. Your sessions keep running through the update.

## Get started

1. Open a folder (a git repository, or any other folder), then click the **Agent Sessions** icon in the activity bar.
2. Click **Install Claude status hooks…** at the top of the Claude section, so each session can report its state.
   DevDesk backs up `~/.claude/settings.json` first, and keeps your own hooks.
3. Click **+** to start a Claude session, or **New Worktree Session** to describe a task.
4. For the board, turn on `devdesk.board.enabled` (a preview) and run **DevDesk: Open Claude Board**.

## Settings you may want

| Setting | What it does |
|---|---|
| `devdesk.board.enabled` | Turns on the Claude Board. |
| `devdesk.sessions.defaultMode` | The mode new sessions start in (Default, Plan, Accept edits, Auto, Bypass…). |
| `devdesk.sessions.claudeArgs` | Extra Claude arguments for every session, for example `--model opus`. |
| `devdesk.sessions.scope` | `workspace` (default) lists only this window's sessions; `all` also lists other folders' sessions. |
| `devdesk.sessions.notifyWhenWaiting` | Turn the "needs input" notifications on or off. |
| `devdesk.sessions.parkAfterDays` | Days of inactivity before a session is parked (ends, to free memory; opening it resumes it). `0` never parks. |
| `devdesk.sessions.maxLiveSessions` | How many sessions may run before idle ones are parked (12). `0`: no limit. |
| `devdesk.insights.enabled` | The Haiku status lines and summaries on cards and rows. They run through your own Claude Code, and count in your token usage. |

Click the ⚙ in the Claude or Worktrees section, or on the board, to see them all. The [manual](MANUAL.md) describes every
state, setting and behavior in detail, and how to fix a slow or stuck view.

## Privacy

DevDesk talks to no service of its own. It reads Claude Code's local files (transcripts, settings) to show state and
usage, writes its state under `~/.claude/devdesk`, and the insights call Claude through your own `claude` CLI.

## More

- [Manual](MANUAL.md): everything DevDesk Claude does, every setting, troubleshooting.
- [Developing](DEVELOPING.md): building from source, tests, and how to contribute.
- [Issues](https://github.com/roniburd/devdesk-agent/issues): bugs and ideas.

## License

[MIT](LICENSE).
