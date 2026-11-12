import { type ChildProcessByStdio, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import { isPaneId, serverArgs } from '../core/tmux';
import { captureCommand, ControlParser, cursorCommand, firstFrame, reclaimCommand, resizeCommand, sendKeysCommands, type TermSize } from '../core/web/terminal';

/**
 * The experimental web terminal's tmux side: one control-mode client (`tmux -C attach-session -t <pane>`) per open
 * terminal page. It sizes the window to the page, sends the pane's first frame and then its live output, and types
 * what the page sends into that pane only (send-keys -H). The client ends when the page goes, when the session ends,
 * or after IDLE_MS without input, so a forgotten phone does not keep the desktop's window small.
 */

/** At most this many terminals at once, across every page. */
export const MAX_TERMINALS = 4;
/** A terminal with no input or resize for this long is closed (the page offers to reconnect). */
export const IDLE_MS = 10 * 60_000;
/** A control client that does not answer its first commands in this long is given up. */
const START_TIMEOUT_MS = 10_000;

export interface TerminalSink {
  /** Bytes for xterm.js, in order. */
  data(bytes: Uint8Array): void;
  /** The terminal is over: the session ended, tmux went away, or it sat idle. */
  end(reason: string): void;
}

export interface TerminalSetup {
  bin: string;
  server: string;
  /** Passed with -f only on `configServer` (as main.ts runs tmux). */
  configFile?: string;
  configServer?: string;
  log: (line: string) => void;
  idleMs?: number;
}

type Child = ChildProcessByStdio<Writable, Readable, Readable>;

class Terminal {
  readonly id = randomBytes(12).toString('base64url');
  private child: Child;
  private parser: ControlParser;
  private replies: Array<(lines: string[], error: boolean) => void> = [];
  /** Output after the capture and before the first frame went out, sent right after it. */
  private pending: Uint8Array[] = [];
  private idle: NodeJS.Timeout | undefined;
  private closed = false;
  private live = false;
  /** 'before': output the capture will show anyway, dropped; 'held': after the capture, kept for after the first frame. */
  private phase: 'before' | 'held' | 'live' = 'before';

  constructor(
    readonly pane: string,
    private size: TermSize,
    private readonly sink: TerminalSink,
    private readonly s: TerminalSetup,
    private readonly onClose: (t: Terminal) => void,
  ) {
    const args = serverArgs(s.server, ['-C', 'attach-session', '-t', pane], s.server === s.configServer ? s.configFile : undefined);
    this.child = spawn(s.bin, args, { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    this.parser = new ControlParser({
      output: (p, bytes) => {
        if (p !== this.pane || this.closed) return;
        if (this.phase === 'live') sink.data(bytes);
        else if (this.phase === 'held') this.pending.push(bytes);
      },
      reply: (lines, error) => this.replies.shift()?.(lines, error),
      exit: (reason) => this.close(reason ? `tmux: ${reason}` : 'The session ended.'),
    });
    this.child.stdout.setEncoding('latin1');
    this.child.stdout.on('data', (c: string) => this.parser.push(c));
    this.child.stderr.setEncoding('utf8');
    let err = '';
    this.child.stderr.on('data', (c: string) => (err = (err + c).slice(-500)));
    this.child.on('error', (e) => this.close(`cannot run tmux: ${e.message}`));
    this.child.on('exit', () => this.close(err.trim() ? `tmux: ${err.trim()}` : 'The session ended.'));
    this.child.stdin.on('error', () => this.close('tmux went away.'));
    this.touch();
  }

  /** Sizes the window, then sends the first frame. Rejects when tmux does not answer. */
  async start(): Promise<void> {
    const timeout = setTimeout(() => this.close('tmux did not answer.'), START_TIMEOUT_MS);
    try {
      await this.command(resizeCommand(this.size));
      // tmux applies the size before it answers the next command, so the capture is at the page's width.
      // Replies and %output come in one ordered stream: output after the capture's reply is held from then on (set
      // while parsing, not after the await, which runs only once the whole chunk is parsed).
      const capture = await this.command(captureCommand(this.pane), () => (this.phase = 'held'));
      const cursor = await this.command(cursorCommand(this.pane));
      if (this.closed) return;
      this.sink.data(firstFrame(capture.slice(0, this.size.rows), cursor[0] ?? ''));
      for (const b of this.pending.splice(0)) this.sink.data(b);
      this.phase = 'live';
      this.live = true;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** One command line; resolves with its reply lines (an error reply rejects). */
  private command(line: string, onReply?: () => void): Promise<string[]> {
    if (this.closed) return Promise.reject(new Error('the terminal is closed'));
    return new Promise((resolve, reject) => {
      this.replies.push((lines, error) => {
        if (error) return reject(new Error(lines.join(' ') || 'tmux refused the command'));
        onReply?.();
        resolve(lines);
      });
      this.child.stdin.write(`${line}\n`);
    });
  }

  private touch(): void {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.close('Closed after 10 minutes without typing. Reconnect to go on.'), this.s.idleMs ?? IDLE_MS);
  }

  /** Types `data` (what xterm.js gave, UTF-8) into the pane, after taking the window's size back from the desktop. */
  async input(data: string): Promise<void> {
    if (!this.live) throw new Error('the terminal is not ready');
    this.touch();
    await this.command(reclaimCommand(this.pane));
    for (const c of sendKeysCommands(this.pane, new TextEncoder().encode(data))) await this.command(c);
  }

  async resize(size: TermSize): Promise<void> {
    this.touch();
    this.size = size;
    await this.command(resizeCommand(size));
    await this.command(reclaimCommand(this.pane));
  }

  close(reason = 'Closed.'): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.idle);
    for (const r of this.replies.splice(0)) r([reason], true);
    // Closing stdin detaches the control client; the kill is in case tmux does not notice.
    this.child.stdin.end();
    const kill = setTimeout(() => this.child.kill(), 1000);
    kill.unref();
    this.child.once('exit', () => clearTimeout(kill));
    this.sink.end(reason);
    this.onClose(this);
  }
}

export class TerminalHub {
  private readonly terms = new Map<string, Terminal>();

  constructor(private readonly s: Omit<TerminalSetup, 'server'>) {}

  get size(): number {
    return this.terms.size;
  }

  /**
   * Opens a terminal on `pane` of tmux server `server`: 'busy' at MAX_TERMINALS, else its id once the first frame is
   * sent. Throws when tmux cannot attach (the sink gets end() too).
   */
  async open(server: string, pane: string, size: TermSize, sink: TerminalSink): Promise<string | 'busy'> {
    if (!isPaneId(pane)) throw new Error(`not a tmux pane id: ${pane}`);
    if (this.terms.size >= MAX_TERMINALS) return 'busy';
    const t = new Terminal(pane, size, sink, { ...this.s, server }, (x) => this.terms.delete(x.id));
    this.terms.set(t.id, t);
    try {
      await t.start();
    } catch (err) {
      t.close((err as Error).message);
      throw err;
    }
    return t.id;
  }

  /** The open terminal `id` on `pane`, or undefined (closed, or another session's). */
  get(id: string, pane: string): Pick<Terminal, 'input' | 'resize'> | undefined {
    const t = this.terms.get(id);
    return t && t.pane === pane ? t : undefined;
  }

  close(id: string): void {
    this.terms.get(id)?.close();
  }

  closeAll(): void {
    for (const t of [...this.terms.values()]) t.close('Web access stopped.');
  }
}
