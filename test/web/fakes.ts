import { FIELD_SEP, type TmuxRunner } from '../../src/core/tmux';
import type { ProcessTable } from '../../src/core/processes';

/** Fakes for the web access tests: Claude's screen as tmux captures it, a tmux runner, a process table. */

const E = '\x1b';
const rule = `${E}[38;5;244m${'─'.repeat(40)} devdesk-agents ─`;
const bottom = `${E}[38;5;244m${'─'.repeat(56)}`;

/** A Claude Code screen as `tmux capture-pane -p -e` prints it, with `prompt` as the input box's lines and `above` over the box. */
export const claudeScreen = (prompt: string[] = [`❯ ${E}[7m ${E}[0m`], above: string[] = []) =>
  [' ▐▛███▛█   Claude Code v2.1.312', '', ...above, rule, ...prompt, bottom, `  ${E}[38;5;220m⏵⏵${E}[39m ${E}[38;5;220mauto mode on`].join('\n');

/** Claude at an empty prompt. */
export const EMPTY_SCREEN = claudeScreen();
/** Claude in a turn: its spinner over the (empty) box. */
export const WORKING_SCREEN = claudeScreen(undefined, ['✻ Pondering… (12s · esc to interrupt)', '']);
/** A permission dialog: no prompt box. */
export const DIALOG_SCREEN = [rule, ' Do you want to run this command?', ' ❯ 1. Yes', '   2. No'].join('\n');

export interface FakeTmux {
  run: TmuxRunner;
  calls: string[][];
}

/**
 * A tmux runner answering `capture-pane` with `capture` (and, as `paneScreenArgs` asks, the pane's flags, pid and command), `display-message` with the pane's pid, mode and command, and
 * `list-panes` with `panes` (LIST_FORMAT lines); `fail` makes a command (by name) throw that message. Everything else
 * answers ''.
 */
export function fakeTmux(o: { capture?: string; pid?: number; inMode?: boolean; command?: string; panes?: string[]; sessions?: string[]; fail?: Record<string, string> } = {}): FakeTmux {
  const calls: string[][] = [];
  const run: TmuxRunner = async (args) => {
    calls.push(args);
    const cmd = args[0];
    // tmux runs `;`-separated commands in one call: any of them can fail it.
    const failed = args.find((a, i) => (i === 0 || args[i - 1] === ';') && o.fail?.[a]);
    if (failed) throw new Error(o.fail![failed]);
    // paneScreenArgs: the capture, then the pane's flags (mode, bracketed paste, cursor) and its pid and command.
    if (cmd === 'capture-pane' && args.includes(';')) {
      return `${o.capture ?? EMPTY_SCREEN}\n${[o.inMode ? '1' : '0', '1', '', '', String(o.pid ?? 100), o.command ?? 'sh'].join(FIELD_SEP)}\n`;
    }
    if (cmd === 'capture-pane') return o.capture ?? EMPTY_SCREEN;
    if (cmd === 'display-message') return `${o.pid ?? 100}${FIELD_SEP}${o.inMode ? '1' : '0'}${FIELD_SEP}${o.command ?? 'sh'}\n`;
    if (cmd === 'list-panes') return (o.panes ?? []).map((l) => `${l}\n`).join('');
    if (cmd === 'list-sessions') return (o.sessions ?? []).map((l) => `${l}\n`).join('');
    return '';
  };
  return { run, calls };
}

/** A pane line as `list-panes -F LIST_FORMAT` prints it. */
export const paneLine = (p: { session: string; pane: string; pid: number; command?: string; cwd: string; attached?: boolean }) =>
  [p.session, p.attached ? '1' : '0', p.pane, p.command ?? 'sh', String(p.pid), p.cwd].join(FIELD_SEP);

/** A process table from pid, parent pid, command name triples. */
export function processTable(rows: [number, number, string][]): ProcessTable {
  const children = new Map<number, number[]>();
  const comm = new Map<number, string>();
  for (const [pid, ppid, name] of rows) {
    comm.set(pid, name);
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  return { children, comm };
}
