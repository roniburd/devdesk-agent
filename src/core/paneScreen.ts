import { claudeIsWorking, claudePromptIsEmpty, claudePromptShown } from './claudePrompt';
import { findDescendant, listProcesses, type ProcessTable } from './processes';
import { isClaudeCommand } from './sessions';
import type { PromptScreen } from './sessionSend';
import { FIELD_SEP, isShellCommand, sendKeysArgs, type TmuxRunner } from './tmux';

/** Reading a Claude session's tmux pane, and typing into it: what the Claude Board and web access do to a session. */

/** How long Claude gets to show what was typed (and its `/` menu) before Enter submits it. */
export const SUBMIT_DELAY_MS = 150;

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
 * the shell prompt). Claude is looked for after the capture, so a capture taken while it still ran is not taken for its
 * prompt once gone. Throws what tmux throws (see `tmuxTargetGone`).
 */
export async function readPaneScreen(
  tmux: TmuxRunner,
  target: string,
  list: () => Promise<ProcessTable | undefined> = listProcesses,
): Promise<{ capture: string; screen: Required<PromptScreen>; promptShown: boolean }> {
  const capture = await tmux(['capture-pane', '-p', '-e', '-t', target]);
  const format = `#{pane_pid}${FIELD_SEP}#{pane_in_mode}${FIELD_SEP}#{pane_current_command}`;
  const [pid, inMode, command = ''] = (await tmux(['display-message', '-p', '-t', target, format])).trim().split(FIELD_SEP);
  return {
    capture,
    promptShown: claudePromptShown(capture),
    screen: {
      empty: claudePromptIsEmpty(capture),
      working: claudeIsWorking(capture),
      exited: !(await claudeRunsIn(Number(pid), command, list)),
      inMode: inMode === '1',
    },
  };
}

/** What the pane shows (see `readPaneScreen`). */
export async function readPromptScreen(tmux: TmuxRunner, target: string, list: () => Promise<ProcessTable | undefined> = listProcesses): Promise<PromptScreen> {
  return (await readPaneScreen(tmux, target, list)).screen;
}

/** Types `text` (as one line) into pane `target` and presses Enter `delayMs` later, as if typed in its terminal. */
export async function typeIntoPane(tmux: TmuxRunner, target: string, text: string, delayMs = SUBMIT_DELAY_MS): Promise<void> {
  const { type, submit } = sendKeysArgs(target, text);
  for (const piece of type) await tmux(piece);
  await new Promise((r) => setTimeout(r, delayMs));
  await tmux(submit);
}
