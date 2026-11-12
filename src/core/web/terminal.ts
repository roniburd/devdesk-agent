import { isPaneId } from '../tmux';

/**
 * The experimental web terminal (`devdesk.web.sessionView: terminal-experimental`): a tmux control-mode client
 * (`tmux -C attach-session`) per open page, its pane's output streamed to xterm.js in the browser, and what the page
 * types sent back with `send-keys -H` to that one pane (never through tmux's key table, so the prefix key does
 * nothing). This file is the pure part: the control-mode protocol, the commands sent, and the first frame.
 */

/** The page's terminal size is clamped to this (tmux refuses 0, and a huge size would only waste the pane). */
export const TERM_MIN_COLS = 20;
export const TERM_MAX_COLS = 400;
export const TERM_MIN_ROWS = 5;
export const TERM_MAX_ROWS = 200;
/** One input request carries at most this many UTF-8 bytes (a paste bigger than this is refused). */
export const MAX_TERM_INPUT_BYTES = 16384;
/** Bytes per `send-keys -H` command line, so a paste never makes one huge command. */
export const SEND_KEYS_CHUNK = 256;

export interface TermSize {
  cols: number;
  rows: number;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n)));

/** A size from untrusted numbers (query string, JSON body), clamped; undefined when either is not a finite number. */
export function termSizeOf(cols: unknown, rows: unknown): TermSize | undefined {
  const c = typeof cols === 'string' && cols.trim() !== '' ? Number(cols) : cols;
  const r = typeof rows === 'string' && rows.trim() !== '' ? Number(rows) : rows;
  if (typeof c !== 'number' || typeof r !== 'number' || !Number.isFinite(c) || !Number.isFinite(r)) return undefined;
  return { cols: clamp(c, TERM_MIN_COLS, TERM_MAX_COLS), rows: clamp(r, TERM_MIN_ROWS, TERM_MAX_ROWS) };
}

const assertPane = (pane: string) => {
  if (!isPaneId(pane)) throw new Error(`not a tmux pane id: ${pane}`);
};

/** Makes this control client's size the window's: `refresh-client -C WxH`. */
export const resizeCommand = (s: TermSize) => `refresh-client -C ${s.cols}x${s.rows}`;

/**
 * Makes this client the window's latest, so the window takes its size again after the desktop's client took it back
 * (tmux's `window-size latest` follows the client that last typed; keys sent with send-keys don't count as typing).
 */
export const reclaimCommand = (pane: string) => {
  assertPane(pane);
  return `switch-client -t ${pane}`;
};

/** The visible screen with colours, then where the cursor is. */
export const captureCommand = (pane: string) => {
  assertPane(pane);
  return `capture-pane -p -e -t ${pane}`;
};
export const cursorCommand = (pane: string) => {
  assertPane(pane);
  return `display-message -p -t ${pane} '#{cursor_x} #{cursor_y}'`;
};

/** `bytes` typed into `pane` as `send-keys -H` command lines, SEND_KEYS_CHUNK bytes each. */
export function sendKeysCommands(pane: string, bytes: Uint8Array): string[] {
  assertPane(pane);
  const out: string[] = [];
  for (let i = 0; i < bytes.length; i += SEND_KEYS_CHUNK) {
    const hex = Array.from(bytes.subarray(i, i + SEND_KEYS_CHUNK), (b) => b.toString(16).padStart(2, '0'));
    out.push(`send-keys -t ${pane} -H ${hex.join(' ')}`);
  }
  return out;
}

/**
 * A control-mode `%output` value as bytes: tmux escapes every byte below 32 and the backslash as `\ooo` (three octal
 * digits); everything else is the byte itself. `value` is the line read as latin1, so each char is one byte.
 */
export function decodeOutput(value: string): Uint8Array {
  const out = new Uint8Array(value.length);
  let n = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c === 0x5c && i + 3 < value.length && /^[0-7]{3}$/.test(value.slice(i + 1, i + 4))) {
      out[n++] = parseInt(value.slice(i + 1, i + 4), 8) & 0xff;
      i += 3;
    } else out[n++] = c & 0xff;
  }
  return out.subarray(0, n);
}

/** One line from the control client, as it matters here. */
export type ControlLine =
  | { kind: 'output'; pane: string; bytes: Uint8Array }
  | { kind: 'begin' }
  | { kind: 'end'; error: boolean }
  | { kind: 'exit'; reason: string }
  | { kind: 'other' };

/** Classifies one control-mode line (latin1, no trailing newline). Inside a %begin…%end block, lines are a command's output. */
export function parseControlLine(line: string): ControlLine {
  if (line.startsWith('%output ')) {
    const sp = line.indexOf(' ', 8);
    if (sp < 0) return { kind: 'other' };
    return { kind: 'output', pane: line.slice(8, sp), bytes: decodeOutput(line.slice(sp + 1)) };
  }
  if (line.startsWith('%begin ')) return { kind: 'begin' };
  if (line.startsWith('%end ')) return { kind: 'end', error: false };
  if (line.startsWith('%error ')) return { kind: 'end', error: true };
  if (line === '%exit' || line.startsWith('%exit ')) return { kind: 'exit', reason: line.slice(6) };
  return { kind: 'other' };
}

/**
 * Splits the control client's output into command replies and notifications. Replies arrive in the order the commands
 * were written, each as `%begin`, its lines, `%end` (or `%error`); notifications (`%output`, `%exit`, …) come between.
 * tmux answers the attach itself with one empty block first, so `expectAttachReply` drops it.
 */
export class ControlParser {
  private buf = '';
  private block: string[] | undefined;
  private skipFirst: boolean;

  constructor(
    private readonly on: {
      output(pane: string, bytes: Uint8Array): void;
      reply(lines: string[], error: boolean): void;
      exit(reason: string): void;
    },
    expectAttachReply = true,
  ) {
    this.skipFirst = expectAttachReply;
  }

  /** `chunk`: stdout as latin1. */
  push(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).replace(/\r$/, '');
      this.buf = this.buf.slice(nl + 1);
      this.line(line);
    }
  }

  private line(line: string): void {
    if (this.block) {
      const p = line.startsWith('%end ') || line.startsWith('%error ') ? parseControlLine(line) : undefined;
      if (p?.kind === 'end') {
        const lines = this.block;
        this.block = undefined;
        if (this.skipFirst) this.skipFirst = false;
        else this.on.reply(lines, p.error);
      } else this.block.push(line);
      return;
    }
    const p = parseControlLine(line);
    if (p.kind === 'begin') this.block = [];
    else if (p.kind === 'output') this.on.output(p.pane, p.bytes);
    else if (p.kind === 'exit') this.on.exit(p.reason);
  }
}

/**
 * What xterm.js is sent first: clear, the captured screen (capture-pane lines are latin1 bytes of UTF-8, rows joined by
 * CRLF so each starts at column 0), then the cursor where tmux has it. `cursor`: `display-message` reply `"x y"`.
 */
export function firstFrame(capture: readonly string[], cursor: string): Uint8Array {
  const [x, y] = cursor.trim().split(/\s+/).map(Number);
  const head = '\x1b[0m\x1b[H\x1b[2J';
  const move = Number.isInteger(x) && Number.isInteger(y) ? `\x1b[0m\x1b[${y + 1};${x + 1}H` : '\x1b[0m';
  const text = head + capture.join('\r\n') + move;
  return Uint8Array.from(text, (c) => c.charCodeAt(0) & 0xff);
}
