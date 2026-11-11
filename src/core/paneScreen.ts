import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { claudeIsWorking, claudePromptIsEmpty, claudePromptShown, paneScreenArgs, parsePaneScreen } from './claudePrompt';
import { findDescendant, listProcesses, type ProcessTable } from './processes';
import { isClaudeCommand } from './sessions';
import type { PromptScreen } from './sessionSend';
import { commandLine, commandParts, FIELD_SEP, isShellCommand, pastedText, pasteArgs, pasteBufferName, pasteSubmitDelayMs, type TmuxRunner, typeArgs } from './tmux';

/** Reading a Claude session's tmux pane, and typing into it: what the Claude Board and web access do to a session. */

/**
 * Whether Claude runs in a pane whose process is `pid` and whose foreground command tmux names `command`: a Claude
 * process under it (tmux names a `claude; exec $SHELL -l` wrapper shell `sh` while Claude runs), else, when the process
 * list cannot be read, a foreground command that is not a shell.
 */
export async function claudeRunsIn(pid: number, command: string, list: () => Promise<ProcessTable | undefined> = listProcesses): Promise<boolean> {
  const procs = Number.isInteger(pid) && pid > 0 ? await list() : undefined;
  if (procs) return findDescendant(procs, pid, isClaudeCommand) !== undefined;
  return isClaudeCommand(command) || (command !== '' && !isShellCommand(command));
}

/**
 * The pane's capture (`capture-pane -p -e`, with its colours) and what it shows: Claude's prompt empty (no question or
 * dialog open), Claude in a turn, the pane in a tmux mode (copy mode), Claude exited (its old prompt box can stay above
 * the shell prompt). The screen and the pane's flags (tmux mode, bracketed paste, cursor) come from one tmux call, so
 * they agree. Claude is looked for after the capture, so a capture taken while it still ran is not taken for its prompt
 * once gone. Throws what tmux throws (see `tmuxTargetGone`).
 */
export async function readPaneScreen(
  tmux: TmuxRunner,
  target: string,
  list: () => Promise<ProcessTable | undefined> = listProcesses,
): Promise<{ capture: string; screen: Required<PromptScreen>; promptShown: boolean }> {
  const out = await tmux(paneScreenArgs(target, FIELD_SEP, ['#{pane_pid}', '#{pane_current_command}']));
  const { capture, flags, extra } = parsePaneScreen(out, FIELD_SEP);
  const [pid, command = ''] = extra;
  return {
    capture,
    promptShown: claudePromptShown(capture),
    screen: {
      empty: claudePromptIsEmpty(capture, flags),
      working: claudeIsWorking(capture),
      exited: !(await claudeRunsIn(Number(pid), command.trim(), list)),
      inMode: flags?.inMode ?? false,
    },
  };
}

/** What the pane shows (see `readPaneScreen`). */
export async function readPromptScreen(tmux: TmuxRunner, target: string, list: () => Promise<ProcessTable | undefined> = listProcesses): Promise<PromptScreen> {
  return (await readPaneScreen(tmux, target, list)).screen;
}

export interface TypeOptions {
  /** Where the file tmux loads the text from goes (os.tmpdir()). */
  tmpDir: string;
  /** How long Claude gets to take in a paste before Enter (`devdesk.board.pasteSettleMs`). */
  settleMs: number;
  /** Text that is not a `/command` keeps its line breaks (a bracketed paste of several lines is one prompt). */
  multiline?: boolean;
}

/**
 * Enters `text` (as one command line: `commandLine`) at Claude's prompt in pane `target`: the `/name ` before an
 * argument typed, the rest as one bracketed paste through a tmux paste buffer of its own (`commandParts`), then Enter
 * once Claude has taken it in (`o.settleMs`, and more for a long paste). With `o.multiline`, text that is not a
 * `/command` keeps its line breaks (only a `/command` must be one line).
 */
export async function typeIntoPane(tmux: TmuxRunner, target: string, text: string, o: TypeOptions): Promise<void> {
  const keepLines = o.multiline && !text.trimStart().startsWith('/');
  const { lead, rest } = keepLines ? { lead: '', rest: pastedText(text).replace(/\\$/, '\\ ') } : commandParts(commandLine(text));
  // A file only this user reads, gone once loaded: tmux reads it, as an argument this long would be too long for it.
  const dir = await mkdtemp(join(o.tmpDir, 'devdesk-send-'));
  const { load, paste, drop, submit } = pasteArgs(target, pasteBufferName(randomBytes(8).toString('hex')), join(dir, 'text'));
  try {
    await writeFile(load.at(-1)!, rest, { mode: 0o600 });
    await tmux(load);
    try {
      if (lead) await tmux(typeArgs(target, lead));
      await tmux(paste);
    } catch (err) {
      await tmux(drop).catch(() => undefined);
      throw err;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  await new Promise((r) => setTimeout(r, pasteSubmitDelayMs(o.settleMs, Buffer.byteLength(rest))));
  await tmux(submit);
}
