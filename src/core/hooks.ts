import { chmod, constants, copyFile, lstat, readdir, readFile, realpath, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { writeFileAtomic } from './atomicWrite';
import { withFileLock } from './fileLock';
import { readTextIfExists } from './json';
import { shellQuote } from './shell';

const HOOK_SCRIPT_NAME = 'devdesk_hook.py';
export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'StopFailure', 'SessionEnd'] as const;

/**
 * The hook script's version, in its second line (`# devdesk-hook-version: N`). One script serves every session on the
 * host, and DevDesk for Claude Code v1 and v2 can both be installed there, each with its own script: a window installs or
 * refreshes its script only when the installed one is not newer (`replacesHookScript`), so a v1 window never puts back
 * v1's script over v2's. Bump it with every change to the script: v1 (`main`) counts in the 100s, v2 (`v2_experiment`)
 * in the 200s, as v2's script handles every event and record v1's does.
 */
export const HOOK_SCRIPT_VERSION = 100;

const HOOK_VERSION_LINE = /^# devdesk-hook-version: (\d+)$/m;

/** The version an installed hook script says it is; 0 for scripts from before versions. */
export function hookScriptVersion(script: string): number {
  const m = HOOK_VERSION_LINE.exec(script);
  return m ? Number.parseInt(m[1], 10) : 0;
}

/** Whether to write `ours` over the installed script (undefined: none installed): it differs and is not newer than ours. */
export function replacesHookScript(installed: string | undefined, ours = HOOK_SCRIPT): boolean {
  if (installed === undefined) return true;
  return installed !== ours && hookScriptVersion(installed) <= hookScriptVersion(ours);
}

/**
 * Python 3.9, standard library only. Writes <state dir>/<session_id>.json with the Claude pid, tmux pane and transcript
 * path; always exits 0 and prints nothing.
 */
export const HOOK_SCRIPT = String.raw`#!/usr/bin/env python3
# devdesk-hook-version: 100
"""DevDesk Agents: records Claude Code session state for the VS Code Claude Sessions panel."""
import json
import os
import re
import subprocess
import sys
import tempfile
import time

STATE_DIR = os.environ.get('DEVDESK_STATE_DIR') or os.path.expanduser('~/.claude/devdesk/state')
ENDED_DIR = os.path.join(STATE_DIR, 'ended')
SHELLS = ('sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'tcsh')


def tmux_session(pane):
    if not pane:
        return None
    try:
        # DevDesk sets DEVDESK_TMUX in its sessions when devdesk.sessions.tmuxPath names another binary.
        out = subprocess.run([os.environ.get('DEVDESK_TMUX') or 'tmux', 'display-message', '-p', '-t', pane, '#{session_name}'],
                             capture_output=True, text=True, timeout=2)
        return out.stdout.strip() or None
    except Exception:
        return None


def claude_pid():
    """Claude runs hooks through a shell, so skip shell parents to reach the Claude process."""
    pid = os.getppid()
    for _ in range(3):
        try:
            out = subprocess.run(['ps', '-o', 'ppid=,comm=', '-p', str(pid)],
                                 capture_output=True, text=True, timeout=2).stdout.split(None, 1)
        except Exception:
            return pid
        if len(out) < 2 or os.path.basename(out[1].strip()).lstrip('-') not in SHELLS:
            return pid
        pid = int(out[0])
    return pid


def last_reply(path):
    """The last assistant text in the transcript (read from its tail), for the card's detail."""
    try:
        with open(path, 'rb') as f:
            f.seek(0, 2)
            f.seek(max(0, f.tell() - 262144))
            lines = f.read().decode('utf-8', 'replace').splitlines()
    except Exception:
        return ''
    for line in reversed(lines):
        try:
            entry = json.loads(line)
        except Exception:
            continue
        if not isinstance(entry, dict) or entry.get('type') != 'assistant' or entry.get('isSidechain'):
            continue
        content = (entry.get('message') or {}).get('content')
        if isinstance(content, str):
            text = content.strip()
        else:
            text = ' '.join(b.get('text') or '' for b in content or [] if isinstance(b, dict) and b.get('type') == 'text').strip()
        if text:
            return text
    return ''


# Closing markdown and quotes after a final "?": emphasis, code (backtick), quotes, brackets.
QUESTION_TAIL = '*_"\')]' + chr(96)


def ends_with_question(text):
    """The reply's last line is a question: Claude finished its turn by asking something in prose."""
    lines = [line for line in str(text or '').splitlines() if line.strip()]
    return bool(lines) and lines[-1].strip().rstrip(QUESTION_TAIL).endswith('?')


EDIT_TOOLS = ('Edit', 'MultiEdit', 'Write', 'NotebookEdit')


def first_line(value):
    lines = str(value or '').strip().splitlines()
    return lines[0][:200] if lines else ''


def tool_detail(tool, tool_input, cwd):
    """What a tool call is doing, for the card: "Running Bash: npm test", "Editing src/a.ts"."""
    inp = tool_input if isinstance(tool_input, dict) else {}
    path = str(inp.get('file_path') or inp.get('notebook_path') or '')
    if path.startswith(cwd.rstrip('/') + '/'):
        path = path[len(cwd.rstrip('/')) + 1:]
    if tool == 'Bash' and first_line(inp.get('command')):
        return 'Running Bash: ' + first_line(inp.get('command'))
    if tool in EDIT_TOOLS and path:
        return 'Editing ' + path
    if tool == 'Read' and path:
        return 'Reading ' + path
    if tool in ('Grep', 'Glob') and first_line(inp.get('pattern')):
        return 'Searching ' + first_line(inp.get('pattern'))
    if tool in ('Task', 'Agent') and first_line(inp.get('description')):
        return 'Running agent: ' + first_line(inp.get('description'))
    if tool == 'WebFetch' and first_line(inp.get('url')):
        return 'Fetching ' + first_line(inp.get('url'))
    return 'Running ' + tool


def previous(path):
    try:
        with open(path) as f:
            value = json.load(f)
        return value if isinstance(value, dict) else {}
    except Exception:
        return {}


def main():
    data = json.load(sys.stdin)
    sid = str(data.get('session_id') or '')
    if not sid or '/' in sid or sid.startswith('.'):
        return
    event = str(data.get('hook_event_name') or '')
    path = os.path.join(STATE_DIR, sid + '.json')
    if event == 'SessionEnd':
        # Keep the session as ended so it can be resumed, unless /clear goes on in the same terminal, or DevDesk parked
        # it (an ended record newer than its last activity says why it ended).
        prev = previous(path)
        if prev.get('sessionId') == sid and data.get('reason') != 'clear':
            ended = os.path.join(ENDED_DIR, sid + '.json')
            if not (previous(ended).get('endedAt') or 0) >= (prev.get('updatedAt') or 0):
                prev['endedAt'] = int(time.time() * 1000)
                prev['endReason'] = 'exited'
                write_json(ended, prev)
        try:
            os.remove(path)
        except OSError:
            pass
        return
    if event == 'SessionStart':
        # Resumed: it runs again.
        try:
            os.remove(os.path.join(ENDED_DIR, sid + '.json'))
        except OSError:
            pass
    prev = {} if event == 'SessionStart' else previous(path)
    prompt = str(prev.get('prompt') or '')
    tool = str(data.get('tool_name') or 'a tool')
    cwd = str(data.get('cwd') or os.getcwd())
    tool_input = data.get('tool_input')
    # The last file Claude edited: shows the worktree a session builds in even when its cwd stays in main.
    last_edit = str(prev.get('lastEditPath') or '') or None
    if event == 'PreToolUse' and tool in EDIT_TOOLS and isinstance(tool_input, dict):
        edited = str(tool_input.get('file_path') or tool_input.get('notebook_path') or '')
        if edited.startswith('/'):
            last_edit = edited
    transcript = str(data.get('transcript_path') or prev.get('transcriptPath') or '')
    asks = False
    now = int(time.time() * 1000)
    # When the current turn started and, once it finished, ended: DevDesk's insights are matched to a turn by these.
    turn_started = prev.get('turnStartedAt') if isinstance(prev.get('turnStartedAt'), int) else None
    turn_ended = prev.get('turnEndedAt') if isinstance(prev.get('turnEndedAt'), int) else None
    if event == 'UserPromptSubmit':
        turn_started, turn_ended = now, None
        submitted = str(data.get('prompt') or '')
        # A background task's result, a system reminder or a subagent's hand-back Claude Code submits itself: keep the
        # user's last prompt.
        if not re.match(r'\s*(Another Claude session sent a message:\s*)?<(task-notification>|system-reminder>|agent-message[\s>])', submitted):
            prompt = submitted[:300]
        state, detail = 'working', 'Thinking'
    elif event == 'PreToolUse' and tool == 'AskUserQuestion':
        questions = (data.get('tool_input') or {}).get('questions') or [{}]
        state, detail = 'waiting', 'Asking: ' + str(questions[0].get('question') or 'a question')[:300]
    elif event == 'PreToolUse' and tool == 'ExitPlanMode':
        state, detail = 'waiting', 'Plan ready for your review'
    elif event in ('PreToolUse', 'PostToolUse'):
        state, detail = 'working', tool_detail(tool, tool_input, cwd)
    elif event == 'Notification':
        message = str(data.get('message') or '')
        kind = data.get('notification_type')
        if kind == 'idle_prompt' or message.startswith('Claude is waiting for your input'):
            # The idle reminder after Stop: keep showing the finished reply.
            state = 'done'
            detail = str(prev.get('detail') or '') if prev.get('state') == 'done' else ''
            detail = detail or 'Waiting for your next prompt'
            asks = prev.get('state') == 'done' and prev.get('asksQuestion') is True
        elif kind in ('permission_prompt', 'elicitation_dialog') or (not kind and message.startswith('Claude needs your')):
            state, detail = 'waiting', (message or 'Claude needs your input')[:300]
            prev_detail = str(prev.get('detail') or '')
            if prev.get('state') == 'waiting' and (prev_detail.startswith('Asking: ') or prev_detail == 'Plan ready for your review'):
                # Claude Code also sends a permission prompt for AskUserQuestion and ExitPlanMode: keep the question.
                detail = prev_detail
        elif prev.get('state') in ('working', 'waiting', 'done', 'idle', 'blocked'):
            # Not a question for this session (a background job finished or needs input, a login succeeded): keep the state.
            state, detail = prev['state'], str(prev.get('detail') or '')
            asks = prev.get('asksQuestion') is True
        else:
            state, detail = 'idle', 'Ready'
    elif event == 'Stop':
        reply = last_reply(transcript) if transcript else ''
        state, detail = 'done', reply[:300] or 'Finished'
        asks = ends_with_question(reply)
        turn_ended = now
    elif event == 'StopFailure':
        # The turn ended on an error: error is its kind (rate_limit, unknown, ...), error_details the message.
        error = data.get('error') or ''
        if isinstance(error, dict):
            error = error.get('message') or error.get('type') or ''
        details = first_line(data.get('error_details'))
        error = first_line(error)
        text = error + ': ' + details if error and details and error != 'unknown' else details or error
        state, detail = 'blocked', text[:300] or 'Stopped by an error'
    else:
        state, detail = 'idle', 'Ready'
    # A record from an older script has no turn times: start the turn now, or end it when the last record ended it.
    if state == 'working' and turn_started is None:
        turn_started = now
    if state == 'done' and turn_ended is None:
        turn_ended = prev.get('updatedAt') if prev.get('state') == 'done' and isinstance(prev.get('updatedAt'), int) else now
    pane = os.environ.get('TMUX_PANE') if os.environ.get('TMUX') else None
    # $TMUX is "<socket path>,<pid>,<session>"; the socket file name is the server's -L name ("default" without -L).
    server = os.path.basename(os.environ.get('TMUX', '').split(',')[0]) if pane else None
    pid = prev.get('pid')
    record = {
        'sessionId': sid,
        'pid': pid if isinstance(pid, int) and pid > 1 else claude_pid(),
        'tmuxSession': tmux_session(pane),
        'tmuxPane': pane or None,
        'tmuxServer': server or None,
        'cwd': cwd,
        'lastEditPath': last_edit,
        'transcriptPath': transcript or None,
        'event': event,
        'notificationType': str(data.get('notification_type') or '') or None if event == 'Notification' else None,
        'state': state,
        'detail': detail,
        'asksQuestion': asks if state == 'done' else None,
        'prompt': prompt,
        'turnStartedAt': turn_started,
        'turnEndedAt': turn_ended if state == 'done' else None,
        'updatedAt': now,
    }
    write_json(path, record)


def write_json(path, value):
    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=directory, suffix='.tmp')
    with os.fdopen(fd, 'w') as f:
        json.dump(value, f)
    os.replace(tmp, path)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
`;

type Settings = Record<string, unknown>;
interface HookEntry {
  type?: string;
  command?: string;
  [key: string]: unknown;
}
interface HookGroup {
  hooks?: HookEntry[];
  [key: string]: unknown;
}

/**
 * The command Claude Code runs (via `sh -c`) for each hook event. It always exits 0 and prints nothing, even when the
 * script is missing, because a non-zero exit (python's 2 for a missing file) would block Claude.
 */
export function hookCommand(scriptPath: string, stateDir: string): string {
  const script = shellQuote(scriptPath);
  return `[ -f ${script} ] && DEVDESK_STATE_DIR=${shellQuote(stateDir)} python3 -I ${script} >/dev/null 2>&1; exit 0`;
}

const isOurs = (h: unknown): boolean => typeof (h as HookEntry)?.command === 'string' && (h as HookEntry).command!.includes(HOOK_SCRIPT_NAME);
const groupHasOurs = (g: HookGroup): boolean => Array.isArray(g?.hooks) && g.hooks.some(isOurs);

function hookMap(settings: Settings): Record<string, unknown> | undefined {
  const h = settings.hooks;
  return h && typeof h === 'object' && !Array.isArray(h) ? (h as Record<string, unknown>) : undefined;
}

const groupHas = (command: string) => (g: HookGroup): boolean =>
  Array.isArray(g?.hooks) && g.hooks.some((h) => (h as HookEntry)?.command === command);

/** True when every event in HOOK_EVENTS has an entry whose command is exactly `command`. */
export function hasHooks(settings: Settings, command: string): boolean {
  const hooks = hookMap(settings);
  return !!hooks && HOOK_EVENTS.every((e) => Array.isArray(hooks[e]) && (hooks[e] as HookGroup[]).some(groupHas(command)));
}

/** True when any event has a DevDesk entry, whatever its format. */
function hasAnyHooks(settings: Settings): boolean {
  const hooks = hookMap(settings);
  return !!hooks && Object.values(hooks).some((v) => Array.isArray(v) && (v as HookGroup[]).some(groupHasOurs));
}

/** Drops the DevDesk entries `keep` rejects (all by default); groups left empty go too, other hooks stay. */
function dropOurs(groups: HookGroup[], keep: (h: HookEntry) => boolean = () => false): HookGroup[] {
  return groups.flatMap((g) => {
    if (!groupHasOurs(g)) return [g];
    const kept = g.hooks!.filter((h) => !isOurs(h) || keep(h));
    if (kept.length === g.hooks!.length) return [g];
    return kept.length ? [{ ...g, hooks: kept }] : [];
  });
}

/** Ensures one DevDesk entry with `command` per event, upgrading older DevDesk entries in place; other hooks are kept. */
export function addHooks(settings: Settings, command: string): Settings {
  const next = structuredClone(settings);
  const hooks = hookMap(next) ?? {};
  for (const event of HOOK_EVENTS) {
    // DevDesk entries of an older format or state dir are replaced.
    const groups = dropOurs(Array.isArray(hooks[event]) ? (hooks[event] as HookGroup[]) : [], (h) => h.command === command);
    if (!groups.some(groupHas(command))) groups.push({ hooks: [{ type: 'command', command, timeout: 5 }] });
    hooks[event] = groups;
  }
  next.hooks = hooks;
  return next;
}

export function removeHooks(settings: Settings): Settings {
  const next = structuredClone(settings);
  const hooks = hookMap(next);
  if (!hooks) return next;
  for (const [event, value] of Object.entries(hooks)) {
    if (!Array.isArray(value)) continue;
    const groups = dropOurs(value as HookGroup[]);
    if (groups.length) hooks[event] = groups;
    else delete hooks[event];
  }
  if (Object.keys(hooks).length === 0) delete next.hooks;
  return next;
}

export function backupStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export interface HookFileResult {
  changed: boolean;
  backup?: string;
}

/**
 * The functions below take Claude Code's config directory (`claudeDir`: `$CLAUDE_CONFIG_DIR`, else `~/.claude`, see
 * `claudeConfigDir()`), where Claude Code reads `settings.json`; the hook script is kept in its `devdesk` folder.
 */
const settingsFile = (claudeDir: string) => join(claudeDir, 'settings.json');

/** How many `settings.json.devdesk-backup-*` files are kept (the newest). */
export const KEEP_BACKUPS = 5;

async function readSettings(path: string): Promise<{ text?: string; settings: Settings }> {
  const text = await readTextIfExists(path);
  if (text === undefined) return { settings: {} };
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return { text, settings: parsed as Settings };
  } catch {
    throw new Error(`${path} is not valid JSON; nothing was changed`);
  }
}

/** Follows a symlinked settings file so the link itself is kept; a missing file resolves to itself. */
async function resolveTarget(path: string): Promise<string> {
  try {
    return (await lstat(path)).isSymbolicLink() ? await realpath(path) : path;
  } catch {
    return path;
  }
}

async function backupFile(path: string, now: Date): Promise<string> {
  const base = `${path}.devdesk-backup-${backupStamp(now)}`;
  for (let i = 0; ; i++) {
    const candidate = i === 0 ? base : `${base}-${i}`;
    try {
      await copyFile(path, candidate, constants.COPYFILE_EXCL);
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
}

/**
 * The backups among `names` (a directory's entries) of the settings file named `settingsName` to remove so that only the
 * newest `keep` are left. Names sort by their stamp, then by the `-<n>` added for backups made in the same second.
 */
export function backupsToPrune(names: readonly string[], settingsName: string, keep = KEEP_BACKUPS): string[] {
  const prefix = `${settingsName}.devdesk-backup-`;
  const key = (name: string): [string, number] => {
    const m = /^(\d+)(?:-(\d+))?$/.exec(name.slice(prefix.length));
    return m ? [m[1], Number(m[2] ?? 0)] : ['', 0];
  };
  const backups = names.filter((n) => n.startsWith(prefix));
  backups.sort((a, b) => {
    const [sa, na] = key(a);
    const [sb, nb] = key(b);
    return sa === sb ? na - nb : sa < sb ? -1 : 1;
  });
  return backups.slice(0, Math.max(0, backups.length - keep));
}

async function pruneBackups(path: string): Promise<void> {
  const dir = dirname(path);
  const names = await readdir(dir).catch(() => []);
  for (const name of backupsToPrune(names, basename(path))) await unlink(join(dir, name)).catch(() => undefined);
}

async function writeSettings(path: string, text: string | undefined, settings: Settings, now: Date): Promise<HookFileResult> {
  let backup: string | undefined;
  if (text !== undefined) backup = await backupFile(path, now);
  const mode = text !== undefined ? (await stat(path)).mode & 0o7777 : undefined;
  await writeFileAtomic(path, `${JSON.stringify(settings, null, 2)}\n`, true, mode);
  // The new file's mode was narrowed by the umask: give it the old one exactly.
  if (mode !== undefined) await chmod(path, mode);
  if (backup) await pruneBackups(path);
  return backup ? { changed: true, backup } : { changed: true };
}

const scriptFile = (claudeDir: string) => join(claudeDir, 'devdesk', HOOK_SCRIPT_NAME);

/**
 * Reads `settings.json`, applies `change` and writes the result, under a lock every window respects (two windows
 * installing at once would otherwise drop one's change, or Claude Code's).
 */
async function changeSettings(claudeDir: string, now: Date, change: (settings: Settings, text: string | undefined) => Promise<Settings | undefined>): Promise<HookFileResult> {
  const path = await resolveTarget(settingsFile(claudeDir));
  return withFileLock(path, async () => {
    const { text, settings } = await readSettings(path);
    const next = await change(settings, text);
    if (!next || JSON.stringify(next) === JSON.stringify(settings)) return { changed: false };
    return writeSettings(path, text, next, now);
  });
}

export function installHooksInto(claudeDir: string, now: Date, stateDir: string): Promise<HookFileResult> {
  return changeSettings(claudeDir, now, async (settings) => {
    const script = scriptFile(claudeDir);
    // A newer script (another DevDesk for Claude Code version's) stays: it handles these events too.
    if (replacesHookScript(await readFile(script, 'utf8').catch(() => undefined))) await writeFileAtomic(script, HOOK_SCRIPT, true, 0o755);
    return addHooks(settings, hookCommand(script, stateDir));
  });
}

export function removeHooksFrom(claudeDir: string, now: Date): Promise<HookFileResult> {
  return changeSettings(claudeDir, now, async (settings, text) => (text === undefined ? undefined : removeHooks(settings)));
}

export type HooksStatus = 'installed' | 'outdated' | 'missing';

/** `installed`: every event runs the expected command for `stateDir`; `outdated`: some other DevDesk entries exist. */
export async function readHooksStatus(claudeDir: string, stateDir: string): Promise<HooksStatus> {
  let settings: Settings;
  try {
    settings = (await readSettings(settingsFile(claudeDir))).settings;
  } catch {
    return 'missing';
  }
  if (hasHooks(settings, hookCommand(scriptFile(claudeDir), stateDir))) return 'installed';
  return hasAnyHooks(settings) ? 'outdated' : 'missing';
}

export async function readHooksInstalled(claudeDir: string, stateDir: string): Promise<boolean> {
  return (await readHooksStatus(claudeDir, stateDir)) === 'installed';
}

/**
 * Rewrites an installed hook script that differs from HOOK_SCRIPT and is not newer (`replacesHookScript`), so upgrading
 * the extension upgrades the script without reinstalling hooks. Does nothing when the script was never installed, or
 * is newer (the other DevDesk for Claude Code version's). True if rewritten.
 */
export async function refreshHookScript(claudeDir: string): Promise<boolean> {
  const script = scriptFile(claudeDir);
  let current: string;
  try {
    current = await readFile(script, 'utf8');
  } catch {
    return false;
  }
  if (!replacesHookScript(current)) return false;
  // A unique temporary name: several windows activating at once each rewrite it.
  await writeFileAtomic(script, HOOK_SCRIPT, true, 0o755);
  return true;
}
