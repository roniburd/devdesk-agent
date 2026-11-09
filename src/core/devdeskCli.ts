import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isFiniteNumber, parseObject } from './json';
import { programStatusFileName } from './programStatus';
import type { SessionCard } from './sessions';
import { isPaneId, isServerName } from './tmux';

/**
 * The `devdesk` command Claude can run in a DevDesk session: it asks the VS Code window that shows the session to open
 * a file, open a diff, or set a note on the session's card. No socket: the command and the windows talk through files
 * in `ipc/` next to the script, a directory only the user can open (0700).
 *
 * - Each window running the extension writes `ipc/windows/<id>.json` (0600): its extension host's pid, a random token,
 *   the folders it shows (its workspace root and worktrees), the tmux panes of its sessions, and when it was last in front.
 * - The command picks one window (the one showing its pane, else the one whose folder holds the path most closely, else
 *   the last one in front) and writes its request to `ipc/requests/<id>/<request id>.json` with that window's token.
 * - The window takes the request by renaming it (so it is handled once), does it, and answers in
 *   `ipc/responses/<request id>.json`, which the command prints.
 */
export const CLI_NAME = 'devdesk';
export const CLI_SCRIPT_NAME = 'devdesk_cli.py';

/** Where the command, its Python script and their IPC directory live: `devdesk` in Claude's config directory. */
export function cliPaths(claudeDir: string) {
  const dir = join(claudeDir, 'devdesk');
  const ipc = join(dir, 'ipc');
  return {
    command: join(dir, CLI_NAME),
    script: join(dir, CLI_SCRIPT_NAME),
    ipc,
    windows: join(ipc, 'windows'),
    requests: (windowId: string) => join(ipc, 'requests', windowId),
    responses: join(ipc, 'responses'),
  };
}

/** The `devdesk` command: runs the Python script in isolated mode (no code from the folder it runs in). */
export const cliWrapper = (python: string) => `#!/bin/sh\n# DevDesk Agents: ${CLI_NAME} --help\nexec ${python} -I "$(dirname "$0")/${CLI_SCRIPT_NAME}" "$@"\n`;

/** What a window writes to `ipc/windows/<id>.json`. */
export interface WindowRecord {
  id: string;
  pid: number;
  token: string;
  /** Folders this window shows: its workspace root and its worktrees (and their symlink-resolved paths). */
  roots: string[];
  /** Its sessions' tmux panes, as `<server>:<pane>` (`devdesk:%12`). */
  panes: string[];
  /** When the window was last in front (ms since the epoch). */
  focusedAt: number;
}

/** A window's sessions' panes as the record lists them, sorted. */
export function windowPanes(cards: readonly Pick<SessionCard, 'tmuxPane' | 'tmuxServer'>[]): string[] {
  const panes = cards.filter((c) => isPaneId(c.tmuxPane)).map((c) => `${c.tmuxServer ?? 'default'}:${c.tmuxPane}`);
  return [...new Set(panes)].sort();
}

export type CliAction = 'open' | 'diff' | 'note';

/** A request from the `devdesk` command, as the window reads it. */
export interface CliRequest {
  id: string;
  action: CliAction;
  /** Where the command ran (absolute). */
  cwd: string;
  /** The tmux server and pane it ran in, when in tmux. */
  server?: string;
  pane?: string;
  /** open and diff: the file (absolute); diff without one: every changed file of the worktree of `cwd`. */
  path?: string;
  /** open: 1-based line and column. */
  line?: number;
  column?: number;
  /** Move the keyboard focus to what opens (by default it stays where it is, as in Claude's terminal). */
  focus: boolean;
  /** note: the text; empty clears the note. */
  text?: string;
}

/** A note's longest text: a card shows one line of it. */
export const MAX_NOTE_LENGTH = 300;
const ACTIONS: ReadonlySet<string> = new Set(['open', 'diff', 'note']);
export const isRequestId = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(s);
const positive = (n: unknown): n is number => isFiniteNumber(n) && Number.isInteger(n) && n >= 1 && n <= 10_000_000;

/**
 * A request file's text as a request, or why it is refused: not JSON, the wrong token (`token` is the window's, written
 * only to its record, which only the user can read), an unknown action, or fields of the wrong kind.
 */
export function parseCliRequest(text: string, token: string): CliRequest | { error: string } {
  const raw = parseObject(text);
  if (!raw) return { error: 'not a request' };
  if (typeof raw.token !== 'string' || raw.token !== token) return { error: 'wrong token' };
  if (!isRequestId(raw.id)) return { error: 'no request id' };
  if (typeof raw.action !== 'string' || !ACTIONS.has(raw.action)) return { error: `unknown action ${String(raw.action)}` };
  if (typeof raw.cwd !== 'string' || !raw.cwd.startsWith('/')) return { error: 'no folder' };
  const req: CliRequest = { id: raw.id, action: raw.action as CliAction, cwd: raw.cwd, focus: raw.focus === true };
  if (isServerName(raw.server)) req.server = raw.server;
  if (isPaneId(raw.pane)) req.pane = raw.pane;
  if (raw.path !== undefined && raw.path !== null) {
    if (typeof raw.path !== 'string' || !raw.path.startsWith('/')) return { error: 'the path is not absolute' };
    req.path = raw.path;
  }
  if (positive(raw.line)) req.line = raw.line;
  if (positive(raw.column)) req.column = raw.column;
  if (typeof raw.text === 'string') req.text = raw.text;
  if (req.action === 'open' && !req.path) return { error: 'open needs a file' };
  if (req.action === 'note' && !req.pane) return { error: 'devdesk note works only in a tmux session' };
  return req;
}

/** The note as a card shows it: one line, at most MAX_NOTE_LENGTH characters, no control characters. */
export function noteText(text: string): string {
  // eslint-disable-next-line no-control-regex -- control characters would reach the board
  const line = text.replace(/[\r\n\t]+/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
  return line.length > MAX_NOTE_LENGTH ? `${line.slice(0, MAX_NOTE_LENGTH - 1)}…` : line;
}

/** Where the notes Claude set on its cards are kept: `notes` in the sessions state directory. */
export const notesDirIn = (stateDir: string) => join(stateDir, 'notes');
/** A pane's note file (`devdesk-12.json` for `%12` on server `devdesk`), named as the Program Status relay names its files. */
export const noteFileName = programStatusFileName;

/** A note file's text (`{"text": "...", "at": ms}`) as a note; undefined when invalid or empty. */
export function parseNoteFile(text: string): { text: string; at: number } | undefined {
  const raw = parseObject(text);
  if (!raw || typeof raw.text !== 'string' || !isFiniteNumber(raw.at)) return undefined;
  const note = noteText(raw.text);
  return note ? { text: note, at: raw.at } : undefined;
}

/** The notes in `dir`, by file name. */
export async function readNotes(dir: string): Promise<Map<string, { text: string; at: number }>> {
  const notes = new Map<string, { text: string; at: number }>();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return notes;
  }
  await Promise.all(
    names
      .filter((n) => /^[A-Za-z0-9_.-]+-\d+\.json$/.test(n))
      .map(async (n) => {
        try {
          const note = parseNoteFile(await readFile(join(dir, n), 'utf8'));
          if (note) notes.set(n, note);
        } catch {
          // gone meanwhile
        }
      }),
  );
  return notes;
}

/** Every card with its pane's note (`notes` by file name, from readNotes). */
export function cardsWithNotes(cards: SessionCard[], notes: ReadonlyMap<string, { text: string }>): SessionCard[] {
  if (!notes.size) return cards;
  return cards.map((c) => {
    const name = noteFileName(c.tmuxServer, c.tmuxPane);
    const note = name ? notes.get(name) : undefined;
    return note ? { ...c, note: note.text } : c;
  });
}

/**
 * Note files to delete: those of panes no longer there on a tmux server that was listed (`listed`: server name to its
 * panes' ids). A server not listed (another one's notes) keeps its notes.
 */
export function staleNotes(names: Iterable<string>, listed: ReadonlyMap<string, readonly string[]>): string[] {
  const live = new Set<string>();
  for (const [server, panes] of listed) for (const p of panes) live.add(noteFileName(server, p) ?? '');
  const prefixes = [...listed.keys()].map((s) => `${s.replace(/[^A-Za-z0-9_.-]/g, '_')}-`);
  return [...names].filter((n) => !live.has(n) && prefixes.some((p) => n.startsWith(p) && /^\d+\.json$/.test(n.slice(p.length))));
}

export const SKILL_NAME = 'devdesk';
/** The first line after the front matter: tells DevDesk's own skill file from one the user wrote. */
const SKILL_MARK = '<!-- Written by DevDesk Claude (devdesk.cli.installSkill); it rewrites this file. -->';
export const isOurSkill = (text: string) => text.includes(SKILL_MARK);

/** The Claude Code skill that tells Claude about the `devdesk` command at `command`. */
export function skillText(command: string): string {
  const q = command.includes(' ') ? `"${command}"` : command;
  return `---
name: ${SKILL_NAME}
description: Show the user something in their VS Code editor from a DevDesk session - open a file at a line, open a diff of a file or of all changed files, or set a short note on this session's card on the Claude Board. Use when the user asks to see, open or review a file or your changes, or when a status note would help them follow the work.
allowed-tools: Bash(${q}:*)
---
${SKILL_MARK}

# devdesk: the user's VS Code window

You run in a DevDesk session that a VS Code window shows. \`${q}\` asks that window to show the user something.
It prints what it did, or why it could not (exit status 1).

\`\`\`bash
${q} open <file>[:<line>[:<column>]] [--focus]   # open a file, at a line (and column)
${q} diff [<file>] [--focus]                      # diff a file vs mainline; no file: all changed files of this worktree
${q} note <text>                                  # a one-line note on this session's card on the Claude Board
${q} note --clear                                 # remove the note
\`\`\`

- Files open without taking the keyboard focus from the user's terminal. Pass \`--focus\` only when the user asked to look at it now.
- Open files and diffs when the user asks to see them, or once at the end of a task to point at what to review; not after every edit.
- A note says where the work stands in a few words ("waiting for CI", "3 of 5 tests fixed"). Clear it when it no longer holds.
`;
}

/**
 * Python 3.9, standard library only: the `devdesk` command (`devdesk --help`). It finds its window among the records in
 * `ipc/windows` (owned by the user, with a live pid), writes its request there with the window's token, and waits for
 * the answer.
 */
export const CLI_SCRIPT = String.raw`#!/usr/bin/env python3
"""DevDesk Agents: asks the VS Code window that shows this Claude session to open a file, a diff, or set a card note."""
import json
import os
import re
import secrets
import stat
import sys
import time

IPC = os.path.join(os.path.dirname(os.path.realpath(__file__)), 'ipc')
ANSWER_SECONDS = 30
TAKEN_SECONDS = 5
USAGE = """usage: devdesk <command> [options]

Asks the VS Code window that shows this session (DevDesk Claude) to:

  devdesk open <file>[:<line>[:<column>]] [--line N] [--column N] [--focus]
                                open a file, at a line and column (1-based)
  devdesk diff [<file>] [--focus]
                                open a diff of the file against the Worktrees view's base;
                                without a file, of every changed file of this worktree
  devdesk note <text>           set a one-line note on this session's card on the Claude Board
  devdesk note --clear          remove it

What opens leaves the keyboard focus where it is, unless --focus.
"""


def fail(message, code=1):
    sys.stderr.write('devdesk: %s\n' % message)
    sys.exit(code)


def tmux_place():
    pane = os.environ.get('TMUX_PANE', '')
    sock = os.environ.get('TMUX', '').split(',')[0]
    server = os.path.basename(sock) if sock else ''
    if not re.match(r'^%\d+$', pane) or not re.match(r'^[A-Za-z0-9_.-]+$', server):
        return None, None
    return server, pane


def number(flag, value):
    if value is None or not value.isdigit() or int(value) < 1:
        fail('%s needs a number from 1' % flag, 2)
    return int(value)


def parse(argv):
    if not argv or argv[0] in ('-h', '--help', 'help'):
        sys.stdout.write(USAGE)
        sys.exit(0)
    action, rest = argv[0], argv[1:]
    if action not in ('open', 'diff', 'note'):
        fail('unknown command %r (devdesk --help)' % action, 2)
    req = {'action': action, 'focus': False}
    if action == 'note':
        text = ' '.join(rest).strip()
        req['text'] = '' if text == '--clear' else text
        if not req['text'] and text != '--clear':
            fail('devdesk note <text>, or devdesk note --clear', 2)
        return req
    words = []
    i = 0
    while i < len(rest):
        arg = rest[i]
        if arg == '--focus':
            req['focus'] = True
        elif arg in ('--line', '--column'):
            req[arg[2:]] = number(arg, rest[i + 1] if i + 1 < len(rest) else None)
            i += 1
        elif arg == '--':
            words.extend(rest[i + 1:])
            break
        elif arg.startswith('--'):
            fail('unknown option %s (devdesk --help)' % arg, 2)
        else:
            words.append(arg)
        i += 1
    if len(words) > 1:
        fail('one file at a time', 2)
    if not words:
        if action == 'open':
            fail('devdesk open <file>[:<line>[:<column>]]', 2)
        return req
    path = words[0]
    if not os.path.exists(path):
        m = re.match(r'^(.*?):(\d+)(?::(\d+))?$', path)
        if m and os.path.exists(m.group(1)):
            path = m.group(1)
            req.setdefault('line', int(m.group(2)))
            if m.group(3):
                req.setdefault('column', int(m.group(3)))
    if action == 'open' and not os.path.isfile(path):
        fail('no file %s' % path)
    req['path'] = os.path.abspath(path)
    return req


def private_dir(path):
    try:
        st = os.lstat(path)
    except OSError:
        return False
    return stat.S_ISDIR(st.st_mode) and st.st_uid == os.getuid() and not (st.st_mode & 0o077)


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return False
    except OSError:
        return False


def windows():
    d = os.path.join(IPC, 'windows')
    if not private_dir(IPC) or not private_dir(d):
        return []
    found = []
    for name in sorted(os.listdir(d)):
        if not name.endswith('.json'):
            continue
        path = os.path.join(d, name)
        try:
            st = os.lstat(path)
            if not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid():
                continue
            with open(path) as f:
                w = json.load(f)
        except Exception:
            continue
        if not isinstance(w, dict) or not isinstance(w.get('id'), str) or not isinstance(w.get('token'), str):
            continue
        if not isinstance(w.get('pid'), int) or not alive(w['pid']):
            continue
        found.append(w)
    return found


def within(path, root):
    root = root.rstrip('/') or '/'
    return path == root or path.startswith(root if root == '/' else root + '/')


def score(w, paths, pane_key):
    s = 0
    if pane_key and pane_key in (w.get('panes') or []):
        s += 1000000
    best = -1
    for root in w.get('roots') or []:
        if isinstance(root, str) and any(within(p, root) for p in paths):
            best = max(best, len(root))
    if best >= 0:
        s += 1 + best
    return s


def pick(found, req, pane_key):
    target = req.get('path') or req['cwd']
    paths = {target, os.path.realpath(target)}
    scored = [(score(w, paths, pane_key), w.get('focusedAt') or 0, w) for w in found]
    if req['action'] != 'note':
        scored = [x for x in scored if x[0] > 0]
    scored.sort(key=lambda x: (x[0], x[1]), reverse=True)
    return scored[0][2] if scored else None


def write_private(path, data):
    tmp = os.path.join(os.path.dirname(path), '.%s.tmp' % os.path.basename(path))
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as f:
        json.dump(data, f)
    os.replace(tmp, path)


def main(argv):
    req = parse(argv)
    req['cwd'] = os.getcwd()
    server, pane = tmux_place()
    if server:
        req['server'], req['pane'] = server, pane
    if req['action'] == 'note' and not pane:
        fail('devdesk note works only in a tmux session (a DevDesk Claude session)')
    w = pick(windows(), req, '%s:%s' % (server, pane) if pane else None)
    if not w:
        fail('no VS Code window with DevDesk Claude shows %s' % (req.get('path') or req['cwd']))
    req['id'] = secrets.token_hex(12)
    req['token'] = w['token']
    requests = os.path.join(IPC, 'requests', w['id'])
    if not private_dir(requests):
        fail('the VS Code window does not take requests now')
    path = os.path.join(requests, req['id'] + '.json')
    answer = os.path.join(IPC, 'responses', req['id'] + '.json')
    write_private(path, req)
    start = time.time()
    while time.time() - start < ANSWER_SECONDS:
        if os.path.exists(answer):
            time.sleep(0.02)
            try:
                with open(answer) as f:
                    res = json.load(f)
            except Exception:
                continue
            try:
                os.unlink(answer)
            except OSError:
                pass
            message = str(res.get('message') or '')
            if res.get('ok'):
                if message:
                    sys.stdout.write(message + '\n')
                return 0
            fail(message or 'the VS Code window could not do it')
        if time.time() - start > TAKEN_SECONDS and os.path.exists(path):
            try:
                os.unlink(path)
            except OSError:
                pass
            fail('the VS Code window did not take the request (is it busy, or is devdesk.cli.enabled off?)')
        time.sleep(0.05)
    fail('no answer from the VS Code window')


if __name__ == '__main__':
    try:
        sys.exit(main(sys.argv[1:]))
    except KeyboardInterrupt:
        sys.exit(130)
`;
