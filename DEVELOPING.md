# Developing DevDesk Claude

This guide is for people who want to build DevDesk Claude from source, change it, or send a fix. To learn what the
extension does, read the [README](README.md) and the [manual](MANUAL.md) first.

## Where the code comes from

This repository is published from a larger development repository, one snapshot commit per release. Pull requests
are welcome here: a change that is merged is carried over to the development repository and comes back in the next
release. Please open an [issue](https://github.com/roniburd/devdesk-agent/issues) first for anything bigger than a
small fix.

## Set up

You need Node 20 or newer, `tmux` and `python3` (for the hook script's tests), and git.

```bash
git clone https://github.com/roniburd/devdesk-agent.git
cd devdesk-agent
npm install
```

## The edit loop

Run all four before you call a change done:

| Command | What it does |
|---|---|
| `npm test` | Unit tests (Vitest) of the pure logic in `src/core/` and `src/board/`, and of the webviews in `media/` (with jsdom). |
| `npm run typecheck` | `tsc` over the sources and tests. |
| `npm run build` | Bundles the extension with esbuild into `dist/extension.js` (and the usage worker into `dist/usageWorker.js`). |
| `npm run package` | Builds, then packages `dist/devdesk-claude.vsix`. |

While you work, run only what you touch: `npx vitest run test/board.test.ts`, or `npx vitest` for watch mode.

## Try a change in VS Code

Run the extension from your checkout in a separate VS Code window, with a profile of its own so your usual VS Code isn't
touched:

```bash
npm run build
code --extensionDevelopmentPath="$PWD" --user-data-dir /tmp/devdesk-dev --new-window ~/some/git/repo
```

After an edit, run `npm run build` again, then **Developer: Reload Window** in that window. Logs are in
**Output → DevDesk**.

By default the dev window uses your real Claude and your real tmux server, so its sessions mix with yours. Set these in
the dev window's user settings to keep it apart:

| Setting | Value | Why |
|---|---|---|
| `devdesk.sessions.tmuxServer` | `devdesk-dev` | Dev sessions run on their own tmux server: your real sessions don't show up, and **✕** or parking can't end them. |
| `devdesk.sessions.claudePath` | `<checkout>/e2e/fixtures/fake-claude` | Sessions run a fake Claude: no model calls, no cost, instant start. It runs no status hooks, so its sessions show **NO STATUS**. |
| `devdesk.insights.enabled` | `false` | No insight calls. |
| `devdesk.board.enabled` | `true` | Turns on the Claude Board, a preview. |
| `devdesk.diagnostics.debugLog` | `true` | Debug lines in **Output → DevDesk**. |
| `devdesk.sessions.parkAfterDays` | `0` | DevDesk never parks dev sessions under you. |

Status hooks are global: they live in `~/.claude/settings.json`, not in the dev window's profile. Don't change
`devdesk.sessions.stateDir` in a dev window: DevDesk would offer to reinstall the hooks, and that changes them for your
real sessions too.

## Find your way in the code

| Where | What it is |
|---|---|
| `src/extension.ts` | Activation: creates the views and the board, registers the commands. |
| `src/config.ts` | Reads every setting, one function each, with its default. Always read settings through it. |
| `src/migrate.ts` | Copies renamed settings once (`MIGRATED_SETTINGS`). |
| `src/core/` | Pure logic, no VS Code: tmux, sessions, hooks, worktrees, git, the board, usage. Unit-tested. |
| `src/sessions*.ts`, `src/claudeSessions.ts` | The Claude view, its commands, read and unread, the Claude terminals. |
| `src/worktreesView.ts`, `src/featuresTree.ts`, `src/worktreeDiffs.ts` | The Worktrees view and its diffs. |
| `src/reviewComments.ts`, `src/core/reviewNotes.ts` | Notes for Claude on diff lines (VS Code comments), and the prompt they make. |
| `src/devdeskCli.ts`, `src/core/devdeskCli.ts` | The `devdesk` command Claude runs (a Python script), and this window's end of it: its record and the requests it takes, through files in `~/.claude/devdesk/ipc`. |
| `src/boardPanel.ts`, `src/boardComposer.ts`, `src/board/` | The Claude Board and its prompt box. |
| `media/` | The webviews' scripts and styles: `board.js`, `usage.js`. |
| `src/log.ts` | The **DevDesk** output channel. |

`src/core/workspaceProvider.ts` is where the development repository plugs in support for other kinds of multi-package
workspaces; in this repository it has none, so DevDesk works with git repositories and plain folders.

### Add a setting

1. Contribute it in `package.json`, named `devdesk.<feature>.<name>`. A setting that runs a program or names a path uses
   `"scope": "machine"`, so a repository's workspace settings can't change what runs.
2. Read it through one function in `src/config.ts`. An empty string means the default. Expand a leading `~`.
3. Make a change take effect without a reload: listen to `onDidChangeConfiguration`.
4. List it in the [All settings](MANUAL.md#18-all-settings) table of the manual.

### Where state lives

Several windows run the extension at once (local windows, Remote-SSH ones, several on one machine), so state is shared:

- Never keep shared state in a field and write the copy back whole: another window's change in between is lost.
- Every read-modify-write of a file goes through `JsonFileStore.update` (`src/state/jsonFileStore.ts`) or
  `withFileLock` (`src/core/fileLock.ts`). Write files with `writeFileAtomic`.
- Anything that grows gets a cap or a cleanup.

## Board search with a local model

`devdesk.boardSearch.command` runs a program or script that reads the search on stdin and prints the answer (see
MANUAL.md). DevDesk runs it as `exec <command>`, so put pipes in a script. With [Ollama](https://ollama.com) and `jq`:

```sh
#!/bin/sh
# ~/bin/devdesk-search-ollama: answers the Claude Board's ✨ search with a local model.
req=$(cat)
printf '%s' "$req" | jq '{model: "qwen2.5:7b", stream: false, format: "json",
  messages: [{role: "system", content: .instructions}, {role: "user", content: (del(.instructions) | tojson)}]}' |
  curl -s http://127.0.0.1:11434/api/chat -d @- | jq -r .message.content
```

`chmod +x` it and set `devdesk.boardSearch.command` to `~/bin/devdesk-search-ollama`.

## Troubleshooting

- **My change doesn't show in the dev window.** It runs `dist/extension.js`: run `npm run build`, then
  **Developer: Reload Window**.
- **Dev sessions show my real sessions.** Set `devdesk.sessions.tmuxServer` to `devdesk-dev` in the dev window.
- **The extension host runs out of memory.** **Output → DevDesk** shows `heap … MB of … MB` warnings that name the
  operations in flight. The log is under `~/Library/Application Support/Code/logs` on macOS, and
  `~/.vscode-server/data/logs` on a Remote-SSH machine; crash reports are in `~/.cache/devdesk/diagnostics`.
