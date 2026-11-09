import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isFiniteNumber, parseObject } from './json';
import { shellQuote } from './shell';
import type { SessionCard } from './sessions';
import type { PromptScreen } from './sessionSend';
import { DEFAULT_SERVER, isPaneId } from './tmux';

/**
 * Claude Code's Program Status Protocol (OSC 7501, since 2.1.295): Claude reports `idle`, `working`, `blocked` (with a
 * `kind`: permission, question, auth), `done` or `error`, but only once the terminal answers its `ESC]7501;?` probe,
 * which tmux never does. DevDesk runs Claude under PROGRAM_STATUS_SCRIPT, a PTY relay that answers the probe and writes
 * Claude's latest report to a file per tmux pane. See docs/osc-7501-spike.md.
 */
export type ProgramState = 'idle' | 'working' | 'done' | 'blocked' | 'error';
export type BlockedKind = 'permission' | 'question' | 'auth';

/** One report's fields DevDesk uses (child records, `id=`, are not reported). `clear`: the program ended. */
export interface ProgramStatusReport {
  state: ProgramState | 'clear';
  kind?: BlockedKind;
  /** Claude's one-line message ("approve Bash: npm test", "answer: Pick A or B? (A · B)"). */
  msg?: string;
  app?: string;
}

/** A pane's latest report, as the relay wrote it. */
export interface ProgramStatus extends ProgramStatusReport {
  state: ProgramState;
  /** When the relay saw it (ms since the epoch). */
  at: number;
  /** The relay's process: the report is stale once it is gone. */
  pid: number;
}

const STATES: ReadonlySet<string> = new Set(['idle', 'working', 'done', 'blocked', 'error']);
const KINDS: ReadonlySet<string> = new Set(['permission', 'question', 'auth']);
/** The spec caps the whole sequence at 4096 bytes; `ESC ] 7501 ;` and `ESC \` take 9 of them. */
export const MAX_BODY_BYTES = 4087;
const MAX_MSG_ENCODED = 2732;
const MAX_MSG_DECODED = 2048;
const MAX_APP = 32;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const VALUE = /^[A-Za-z0-9_.,+/=-]*$/;
// eslint-disable-next-line no-control-regex -- the spec refuses decoded C0, DEL and C1 controls
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** Base64 `msg` as single-line UTF-8 text; undefined when invalid, too long or holding control characters. */
function decodeMsg(encoded: string): string | undefined {
  if (encoded.length > MAX_MSG_ENCODED || !BASE64.test(encoded) || encoded.replace(/=+$/, '').length % 4 === 1) return undefined;
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length > MAX_MSG_DECODED) return undefined;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
  return CONTROL.test(text) ? undefined : text;
}

/**
 * The body between `ESC]7501;` and its terminator (`state=blocked:app=claude-code:kind=question:msg=<base64>`) as a
 * report; undefined for the probe (`?`), a child record (`id=`), no valid state, or a body over the spec's limits.
 * Malformed pairs are skipped; an invalid `msg` voids the report, as the spec says.
 */
export function parseProgramStatusBody(body: string): ProgramStatusReport | undefined {
  if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES || body.trim() === '?') return undefined;
  const pairs = new Map<string, string>();
  for (const pair of body.split(':')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (key === 'id') return undefined;
    if (key.length > 16 || !/^[a-z]+$/.test(key) || !VALUE.test(value)) continue;
    pairs.set(key, value);
  }
  const state = pairs.get('state');
  if (state !== 'clear' && (state === undefined || !STATES.has(state))) return undefined;
  const report: ProgramStatusReport = { state: state as ProgramStatusReport['state'] };
  const kind = pairs.get('kind');
  if (state === 'blocked' && kind && KINDS.has(kind)) report.kind = kind as BlockedKind;
  const app = pairs.get('app');
  if (app && app.length <= MAX_APP && /^[A-Za-z0-9_.+-]+$/.test(app)) report.app = app;
  const msg = pairs.get('msg');
  if (msg !== undefined) {
    const text = decodeMsg(msg);
    if (text === undefined) return undefined;
    if (text) report.msg = text;
  }
  return report;
}

/** A relay's status file (`{"body": "...", "at": ms, "pid": n}`) as a status; undefined when invalid or `clear`. */
export function parseProgramStatusFile(text: string): ProgramStatus | undefined {
  const raw = parseObject(text);
  if (!raw || typeof raw.body !== 'string') return undefined;
  const { at, pid } = raw;
  if (!isFiniteNumber(at) || !isFiniteNumber(pid) || !Number.isInteger(pid) || pid <= 0) return undefined;
  const report = parseProgramStatusBody(raw.body);
  if (!report || report.state === 'clear') return undefined;
  return { ...report, state: report.state, at, pid };
}

/** Where the relay writes each pane's status: `status` in the sessions state directory. */
export const programStatusDirIn = (stateDir: string) => join(stateDir, 'status');

/** The status file of tmux pane `paneId` on `server` (`devdesk-12.json` for `%12`), as the relay names it. */
export function programStatusFileName(server: string | undefined, paneId: string | undefined): string | undefined {
  if (!isPaneId(paneId)) return undefined;
  return `${(server ?? DEFAULT_SERVER).replace(/[^A-Za-z0-9_.-]/g, '_')}-${paneId.slice(1)}.json`;
}

/** The live statuses in `dir`, by file name; a status whose relay is gone (`alive` false) is left out. */
export async function readProgramStatuses(dir: string, alive: (pid: number) => boolean): Promise<Map<string, ProgramStatus>> {
  const statuses = new Map<string, ProgramStatus>();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return statuses;
  }
  await Promise.all(
    names
      .filter((n) => /^[A-Za-z0-9_.-]+-\d+\.json$/.test(n))
      .map(async (n) => {
        const status = await readProgramStatusFile(join(dir, n));
        if (status && alive(status.pid)) statuses.set(n, status);
      }),
  );
  return statuses;
}

async function readProgramStatusFile(path: string): Promise<ProgramStatus | undefined> {
  try {
    return parseProgramStatusFile(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/** The live status of the card's pane, read from `dir` now; undefined without one. */
export async function readCardProgramStatus(
  dir: string,
  card: Pick<SessionCard, 'tmuxServer' | 'tmuxPane'>,
  alive: (pid: number) => boolean,
): Promise<ProgramStatus | undefined> {
  const name = programStatusFileName(card.tmuxServer, card.tmuxPane);
  const status = name ? await readProgramStatusFile(join(dir, name)) : undefined;
  return status && alive(status.pid) ? status : undefined;
}

const KIND_DETAIL: Record<BlockedKind, string> = {
  permission: 'Waiting for your approval',
  question: 'Waiting for your answer',
  auth: 'Waiting for you to sign in',
};

/**
 * The card a status gives a session without hooks (state `unknown`): working; waiting (blocked on a permission, a
 * question or a sign-in, which needs you); done or idle at the prompt; blocked (an error). Claude's message is the
 * detail. Cards with hook state keep it: hooks say more (the prompt, the tool, the reply).
 */
export function cardWithProgramStatus(card: SessionCard, status: ProgramStatus | undefined): SessionCard {
  if (!status || card.state !== 'unknown') return card;
  const base = { ...card, updatedAt: status.at };
  switch (status.state) {
    case 'working':
      return { ...base, state: 'working', detail: status.msg ?? 'Working' };
    case 'blocked':
      return { ...base, state: 'waiting', detail: status.msg ?? (status.kind ? KIND_DETAIL[status.kind] : 'Waiting for you') };
    case 'error':
      return { ...base, state: 'blocked', detail: status.msg ?? 'Error' };
    case 'done':
      return { ...base, state: 'done', detail: status.msg ?? 'Finished its turn' };
    case 'idle':
      return { ...base, state: 'idle', detail: status.msg ?? 'At the prompt' };
  }
}

/** Every card with its pane's status (`statuses` by file name, from readProgramStatuses). */
export function cardsWithProgramStatus(cards: SessionCard[], statuses: ReadonlyMap<string, ProgramStatus>): SessionCard[] {
  if (!statuses.size) return cards;
  return cards.map((c) => {
    const name = programStatusFileName(c.tmuxServer, c.tmuxPane);
    return name ? cardWithProgramStatus(c, statuses.get(name)) : c;
  });
}

/**
 * What a capture of the pane showed (`screen`), corrected by Claude's own report when there is one: `working` and
 * `blocked` mean a turn runs or a dialog (permission, question) is open, so nothing can be typed in; `idle`, `done`
 * and `error` mean no turn runs. Whether text is typed at the prompt only the screen tells (the protocol never says).
 */
export function screenWithProgramStatus(screen: PromptScreen, status: ProgramStatus | undefined): PromptScreen {
  if (!status) return screen;
  if (status.state === 'working') return { ...screen, working: true, empty: false };
  if (status.state === 'blocked') return { ...screen, working: false, empty: false };
  return { ...screen, working: false };
}

/** True when the status alone shows Claude cannot take typed text now (no screen capture needed). */
export const programStatusBusy = (status: ProgramStatus | undefined) => status?.state === 'working' || status?.state === 'blocked';

/** The command prefix that runs Claude under the relay `script`, writing statuses to `dir`. */
export const programStatusWrapper = (python: string, script: string, dir: string) => `${shellQuote(python)} -I ${shellQuote(script)} ${shellQuote(dir)}`;

export const PROGRAM_STATUS_SCRIPT_NAME = 'devdesk_status.py';

/**
 * Python 3.9, standard library only. Runs a command (Claude) in a pseudo-terminal of its own, copying bytes both ways
 * untouched; answers OSC 7501 probes in Claude's output at once (before the DA1 query Claude sends after the probe
 * reaches tmux and is answered), and writes the latest root report to <dir>/<tmux server>-<pane number>.json (or
 * $DEVDESK_STATUS_FILE), removed when the command ends. Outside tmux, or if anything fails before the command starts,
 * it runs the command itself.
 */
export const PROGRAM_STATUS_SCRIPT = String.raw`#!/usr/bin/env python3
"""DevDesk Agents: runs Claude Code in a PTY that answers its Program Status (OSC 7501) probe, and records its status."""
import fcntl
import json
import os
import pty
import select
import signal
import sys
import termios
import time
import tty

INTRO = b'\x1b]7501;'
REPLY = INTRO + b'?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\'
MAX_BODY = 4087
ENDS = (0x07, 0x1b, 0x18, 0x1a)  # BEL, ESC (ST or another escape), CAN and SUB (abort)


def status_path(directory):
    explicit = os.environ.get('DEVDESK_STATUS_FILE')
    if explicit:
        return explicit
    pane = os.environ.get('TMUX_PANE', '')
    sock = os.environ.get('TMUX', '').split(',')[0]
    if not sock or not pane.startswith('%') or not pane[1:].isdigit():
        return None
    server = ''.join(c if c.isalnum() or c in '_.-' else '_' for c in os.path.basename(sock)) or 'default'
    return os.path.join(directory, '%s-%s.json' % (server, pane[1:]))


class Scanner:
    """Finds OSC 7501 bodies in a byte stream, also when a sequence is split across reads."""

    def __init__(self):
        self.pending = b''

    def feed(self, data):
        buf = self.pending + data
        self.pending = b''
        bodies = []
        i = 0
        while True:
            start = buf.find(INTRO, i)
            if start < 0:
                for k in range(min(len(INTRO) - 1, len(buf)), 0, -1):
                    if INTRO.startswith(buf[-k:]):
                        self.pending = buf[-k:]
                        break
                return bodies
            body = start + len(INTRO)
            j = body
            while j < len(buf) and j - body <= MAX_BODY and buf[j] not in ENDS:
                j += 1
            if j - body > MAX_BODY:
                i = body  # over the spec's cap: dropped
                continue
            if j >= len(buf) or (buf[j] == 0x1b and j + 1 >= len(buf)):
                self.pending = buf[start:]  # not terminated yet
                return bodies
            if buf[j] in (0x07, 0x1b):
                bodies.append(buf[body:j])
            i = j + 1


def is_child_record(body):
    return any(pair.split(b'=', 1)[0].strip() == b'id' for pair in body.split(b':') if b'=' in pair)


def write_status(path, body):
    try:
        os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
        tmp = '%s.%d.tmp' % (path, os.getpid())
        with open(tmp, 'w') as f:
            json.dump({'body': body.decode('ascii', 'replace'), 'at': int(time.time() * 1000), 'pid': os.getpid()}, f)
        os.replace(tmp, path)
    except Exception:
        pass


def remove(path):
    try:
        os.unlink(path)
    except Exception:
        pass


def write_all(fd, data):
    while data:
        data = data[os.write(fd, data):]


class Hangup(Exception):
    pass


def hangup(*_):
    raise Hangup()


def main():
    if len(sys.argv) < 3:
        sys.stderr.write('usage: devdesk_status.py <status dir> <command> [args...]\n')
        return 2
    argv = sys.argv[2:]
    path = status_path(sys.argv[1])
    if path is None:
        os.execvp(argv[0], argv)
    try:
        pid, fd = pty.fork()
    except Exception:
        os.execvp(argv[0], argv)
    if pid == 0:
        try:
            os.execvp(argv[0], argv)
        except Exception as err:
            sys.stderr.write('%s: %s\n' % (argv[0], err))
        os._exit(127)

    interactive = os.isatty(0)

    def resize(*_):
        try:
            fcntl.ioctl(fd, termios.TIOCSWINSZ, fcntl.ioctl(0, termios.TIOCGWINSZ, b'\0' * 8))
        except Exception:
            pass

    saved = None
    if interactive:
        resize()
        signal.signal(signal.SIGWINCH, resize)
        saved = termios.tcgetattr(0)
        tty.setraw(0)
    signal.signal(signal.SIGHUP, hangup)
    signal.signal(signal.SIGTERM, hangup)
    scanner = Scanner()
    inputs = [0, fd]
    reaped = None
    code = 0
    try:
        while True:
            ready = select.select(inputs, [], [])[0]
            if fd in ready:
                try:
                    data = os.read(fd, 65536)
                except OSError:
                    data = b''
                if not data:
                    break
                for body in scanner.feed(data):
                    if body.strip() == b'?':
                        write_all(fd, REPLY)
                    elif not is_child_record(body):
                        write_status(path, body)
                write_all(1, data)
            if 0 in ready:
                try:
                    data = os.read(0, 65536)
                except OSError:
                    data = b''
                if not data:
                    inputs.remove(0)
                    continue
                # Ctrl+Z stops Claude in its own terminal, where nothing would resume it: the next key does.
                if reaped is None:
                    try:
                        changed, status = os.waitpid(pid, os.WNOHANG | os.WUNTRACED)
                        if changed == pid and os.WIFSTOPPED(status):
                            os.kill(pid, signal.SIGCONT)
                        elif changed == pid:
                            reaped = status
                    except Exception:
                        pass
                write_all(fd, data)
        code = os.waitstatus_to_exitcode(reaped if reaped is not None else os.waitpid(pid, 0)[1])
    except Hangup:
        try:
            os.kill(pid, signal.SIGHUP)
        except Exception:
            pass
        code = 129
    finally:
        remove(path)
        if saved is not None:
            try:
                termios.tcsetattr(0, termios.TCSAFLUSH, saved)
            except Exception:
                pass
    return code


if __name__ == '__main__':
    sys.exit(main())
`;
