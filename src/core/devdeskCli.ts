import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isFiniteNumber, parseObject } from './json';
import { programStatusFileName } from './programStatus';
import type { SessionCard } from './sessions';
import { isTaskId, type Outcome, type WorkerWhere } from './workers';
import { isPaneId, isServerName } from './tmux';

/**
 * The `devdesk` command Claude can run in a DevDesk session: it asks the VS Code window that shows the session to open
 * a file, open a diff, or set a note on the session's card. No socket: the command and the windows talk through files
 * in `ipc/` next to the script, a directory only the user can open (0700).
 *
 * - Each window running the extension writes `ipc/windows/<id>.json` (0600): its extension host's pid, a random token,
 *   the folders it shows (its workspace root and worktrees), the tmux panes of its sessions, and when it was last in front.
 * - The command picks one window that shows its pane or a folder holding the path (the one showing its pane, else the one
 *   whose folder holds the path most closely, else the last one in front) and writes its request to
 *   `ipc/requests/<id>/<request id>.json` with that window's token. With no such window it fails: only v2 windows write
 *   records, so a session in a v1 window (or in a folder no v2 window has open) is told it needs one.
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

export type CliAction = 'open' | 'diff' | 'note' | 'worker';
/** What `devdesk worker` does: start a worker; from a worker, report or ask; from its coordinator, read, list, answer. */
export type WorkerVerb = 'start' | 'done' | 'ask' | 'check' | 'list' | 'reply';
const WORKER_VERBS: ReadonlySet<string> = new Set(['start', 'done', 'ask', 'check', 'list', 'reply']);

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
  /** note: the text; empty clears the note. worker: the task (start), summary (done), question (ask) or answer (reply). */
  text?: string;
  /** worker: what it does, and its options. */
  verb?: WorkerVerb;
  name?: string;
  taskId?: string;
  outcome?: Outcome;
  where?: WorkerWhere;
  base?: string;
}

/** The longest task, summary, question or answer `devdesk worker` takes. */
export const MAX_WORKER_TEXT = 32 * 1024;
/** A git ref as `--base` takes it: no option, no spaces. */
const isRef = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9_./@^~{}-]{1,200}$/.test(s) && !s.startsWith('-');

/** A note's longest text: a card shows one line of it. */
export const MAX_NOTE_LENGTH = 300;
const ACTIONS: ReadonlySet<string> = new Set(['open', 'diff', 'note', 'worker']);
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
  if (req.action === 'worker') return workerRequest(req, raw);
  return req;
}

/** The `devdesk worker` part of a request, or why it is refused. */
function workerRequest(req: CliRequest, raw: Record<string, unknown>): CliRequest | { error: string } {
  if (typeof raw.verb !== 'string' || !WORKER_VERBS.has(raw.verb)) return { error: `unknown worker command ${String(raw.verb)}` };
  const verb = raw.verb as WorkerVerb;
  req.verb = verb;
  if (req.text !== undefined && req.text.length > MAX_WORKER_TEXT) return { error: `the text is longer than ${MAX_WORKER_TEXT} characters` };
  if (raw.taskId !== undefined && raw.taskId !== null) {
    if (!isTaskId(raw.taskId)) return { error: `not a task id: ${String(raw.taskId)}` };
    req.taskId = raw.taskId;
  }
  const text = req.text?.trim() ?? '';
  if ((verb === 'start' || verb === 'check' || verb === 'list') && !req.pane) return { error: `devdesk worker ${verb} works only in a DevDesk Claude session (in tmux)` };
  switch (verb) {
    case 'start': {
      const name = typeof raw.name === 'string' ? raw.name.trim() : '';
      if (!name || name.length > 60) return { error: 'devdesk worker start needs --name (at most 60 characters)' };
      if (!text) return { error: 'devdesk worker start needs --task' };
      req.name = name;
      req.where = raw.where === 'current' ? 'current' : 'new';
      if (raw.base !== undefined && raw.base !== null) {
        if (!isRef(raw.base)) return { error: `not a git ref: ${String(raw.base)}` };
        if (req.where === 'current') return { error: '--base needs --worktree new' };
        req.base = raw.base;
      }
      return req;
    }
    case 'done':
      if (raw.outcome !== 'succeeded' && raw.outcome !== 'failed') return { error: 'devdesk worker done needs --outcome succeeded or --outcome failed' };
      if (!text) return { error: 'devdesk worker done needs --summary' };
      req.outcome = raw.outcome;
      return req;
    case 'ask':
      return text ? req : { error: 'devdesk worker ask <question>' };
    case 'reply':
      if (!req.taskId) return { error: 'devdesk worker reply needs --task <id>' };
      return text ? req : { error: 'devdesk worker reply --task <id> <answer>' };
    default:
      return req;
  }
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
description: Show the user something in their VS Code editor from a DevDesk session - open a file at a line, open a diff of a file or of all changed files, or set a short note on this session's card on the Claude Board - and start worker sessions on parts of a task and get their reports. Use when the user asks to see, open or review a file or your changes, when a status note would help them follow the work, when the user asks for workers or to split a task across sessions or worktrees, or when your first prompt says you are a DevDesk worker.
allowed-tools: Bash(${q}:*)
---
${SKILL_MARK}

# devdesk: the user's VS Code window

You run in a DevDesk session that a VS Code window shows. \`${q}\` asks that window to show the user something.
It prints what it did, or why it could not (exit status 1).
Every command here, workers too, needs a VS Code window running DevDesk Claude v2 with this folder (or worktree) open.
"no VS Code window running DevDesk Claude v2 has ... open" means there is none (a DevDesk Claude v1 window does not
count): tell the user once and go on without the command.

\`\`\`bash
${q} open <file>[:<line>[:<column>]] [--focus]   # open a file, at a line (and column)
${q} diff [<file>] [--focus]                      # diff a file vs mainline; no file: all changed files of this worktree
${q} note <text>                                  # a one-line note on this session's card on the Claude Board
${q} note --clear                                 # remove the note
\`\`\`

- Files open without taking the keyboard focus from the user's terminal. Pass \`--focus\` only when the user asked to look at it now.
- Open files and diffs when the user asks to see them, or once at the end of a task to point at what to review; not after every edit.
- A note says where the work stands in a few words ("waiting for CI", "3 of 5 tests fixed"). Clear it when it no longer holds.

## Coordinator and workers

\`${q} worker\` starts other Claude sessions (workers) on parts of your task and gets their results back.
If your first prompt says you are a worker and names a task id, follow it: ask with \`worker ask\`, report once with
\`worker done\`, and end your turn after each.

\`\`\`bash
${q} worker start --name <short-name> --task "<self-contained spec>" [--worktree new|current] [--base <ref>]
${q} worker check                          # unread reports and questions (marks them read)
${q} worker list                           # each worker's status: working, waiting, idle, ended, succeeded, failed
${q} worker reply --task <id> "<answer>"   # answer a worker's question
\`\`\`

- Split only when the parts are independent and each is worth a session of its own (a separate package, a separate
  fix, a review); for small or tightly coupled steps, do the work yourself or use your own subagents.
- Write each \`--task\` so a fresh session can do it alone: the goal, the files or package, constraints, what it may
  change, and what proves it is done. Use \`@file\` for a long spec.
- \`--worktree new\` (the default) gives each worker its own worktree, so workers that edit files do not collide.
  Use \`--worktree current\` only for read-only work (reviews, investigations) in your worktree.
- Start every independent worker, tell the user what you started, then **end your turn**. Never poll, sleep or loop on
  \`worker list\`: when workers report, DevDesk types "You have N worker messages" at your prompt.
- When told so, run \`worker check\` and act on each message: answer questions with \`worker reply\` when the
  answer follows from the task (otherwise ask the user), and steer or replace a worker that stopped without reporting.
- When every worker has reported, tell the user per worker: outcome, evidence, what is left (worktree names, so they
  can review the changes).
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

  devdesk worker --help         coordinator and worker sessions: start workers, report, ask, read

What opens leaves the keyboard focus where it is, unless --focus.
"""
WORKER_USAGE = """usage: devdesk worker <command> [options]

From a coordinator session:
  devdesk worker start --name <name> --task <text|@file> [--worktree new|current] [--base <ref>]
                                start a Claude worker session on the task (in a new worktree by default,
                                made from <ref> when given); prints its task id at once
  devdesk worker check          print the workers' unread messages (and mark them read)
  devdesk worker list           each worker's task id, name and status
  devdesk worker reply --task <id> <answer>
                                answer a worker's question (typed into it once it waits at its prompt)

From a worker session (its first prompt names its task id):
  devdesk worker done --task <id> --outcome succeeded|failed --summary <text>
                                report the result to the coordinator, once, then end the turn
  devdesk worker ask --task <id> <question>
                                ask the coordinator, then end the turn: the answer is typed in
"""
WORKER_OPTIONS = {'--name': 'name', '--task': 'task', '--worktree': 'where', '--base': 'base', '--outcome': 'outcome', '--summary': 'summary', '--question': 'question'}
MAX_TEXT = 32 * 1024


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
    if action not in ('open', 'diff', 'note', 'worker'):
        fail('unknown command %r (devdesk --help)' % action, 2)
    if action == 'worker':
        return parse_worker(rest)
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


def read_text(value):
    if not value.startswith('@'):
        return value
    try:
        with open(value[1:], encoding='utf-8') as f:
            return f.read()
    except OSError as e:
        fail('cannot read %s: %s' % (value[1:], e.strerror))


def parse_worker(rest):
    if not rest or rest[0] in ('-h', '--help', 'help'):
        sys.stdout.write(WORKER_USAGE)
        sys.exit(0)
    verb, args = rest[0], rest[1:]
    if verb not in ('start', 'done', 'ask', 'check', 'list', 'reply'):
        fail('unknown worker command %r (devdesk worker --help)' % verb, 2)
    opts = {}
    words = []
    i = 0
    while i < len(args):
        arg = args[i]
        key, eq, value = arg.partition('=')
        if arg == '--':
            words.extend(args[i + 1:])
            break
        if key in WORKER_OPTIONS:
            if not eq:
                if i + 1 >= len(args):
                    fail('%s needs a value (devdesk worker --help)' % key, 2)
                value = args[i + 1]
                i += 1
            opts[WORKER_OPTIONS[key]] = value
        elif arg.startswith('--'):
            fail('unknown option %s (devdesk worker --help)' % arg, 2)
        else:
            words.append(arg)
        i += 1
    rest_text = ' '.join(words).strip()
    req = {'action': 'worker', 'verb': verb, 'focus': False}
    if verb == 'start':
        req['text'] = read_text(opts.get('task') or rest_text)
        if opts.get('name'):
            req['name'] = opts['name']
        req['where'] = opts.get('where', 'new')
        if req['where'] not in ('new', 'current'):
            fail('--worktree is new or current', 2)
        if opts.get('base'):
            req['base'] = opts['base']
        if not req['text'].strip() or not opts.get('name'):
            fail('devdesk worker start --name <name> --task <text|@file>', 2)
    else:
        if opts.get('task'):
            req['taskId'] = opts['task']
        if verb == 'done':
            req['outcome'] = opts.get('outcome', '')
            req['text'] = read_text(opts.get('summary') or rest_text)
            if req['outcome'] not in ('succeeded', 'failed') or not req['text'].strip():
                fail('devdesk worker done --task <id> --outcome succeeded|failed --summary <text>', 2)
        elif verb == 'ask':
            req['text'] = read_text(opts.get('question') or rest_text)
            if not req['text'].strip():
                fail('devdesk worker ask --task <id> <question>', 2)
        elif verb == 'reply':
            req['text'] = read_text(rest_text)
            if not req['text'].strip() or not opts.get('task'):
                fail('devdesk worker reply --task <id> <answer>', 2)
    if len(req.get('text', '')) > MAX_TEXT:
        fail('the text is longer than %d characters' % MAX_TEXT, 2)
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
    scored = [x for x in scored if x[0] > 0]
    scored.sort(key=lambda x: (x[0], x[1]), reverse=True)
    return scored[0][2] if scored else None


NO_WINDOW = ('no VS Code window running DevDesk Claude v2 has %s open. The devdesk command needs a DevDesk Claude v2 '
             'window with this folder (or worktree) open; DevDesk Claude v1 windows do not take its requests.')


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
        fail(NO_WINDOW % (req.get('path') or req['cwd']))
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
