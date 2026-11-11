import { chmod, constants, copyFile, lstat, readdir, readFile, realpath, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { writeFileAtomic } from './atomicWrite';
import { withFileLock } from './fileLock';
import { readTextIfExists } from './json';
import { shellQuote } from './shell';

const HOOK_SCRIPT_NAME = 'devdesk_hook.py';
/**
 * The hook events DevDesk always installs. A Claude Code that does not know an event in settings.json rejects the whole
 * file, user hooks included, so each event here must be known to every Claude Code DevDesk supports: StopFailure is
 * the newest (2.1.78); PermissionRequest (2.0.45) and PostToolUseFailure (2.0.56) are older.
 */
export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'Stop',
  'StopFailure',
  'SessionEnd',
] as const;

/** Hook events DevDesk installs only when `claude --version` says Claude Code knows them, with the first version that does. */
export const VERSIONED_HOOK_EVENTS: readonly { event: string; since: string }[] = [
  // An MCP server's input form (elicitation) and its answer: the form is a wait, its result ends it. An older Claude Code
  // still shows the form as a Notification (elicitation_dialog), which stays the fallback.
  { event: 'Elicitation', since: '2.1.63' },
  { event: 'ElicitationResult', since: '2.1.63' },
  // A /compact the user runs ends without a Stop (trigger "manual"); an automatic one stays inside the turn. PreCompact is
  // left out: it also fires for a compaction that is then aborted.
  { event: 'PostCompact', since: '2.1.76' },
  // It lists each settled tool call, so it ends a permission wait Claude denied itself (no Post hook runs for those).
  { event: 'PostToolBatch', since: '2.1.118' },
  // The live subagent roster (`subagents` in the record). SubagentStart is in 2.0.43 and SubagentStop much older, but
  // before 2.1.311 SubagentStop also ran about twice a minute for each subagent still running, so both start there.
  { event: 'SubagentStart', since: '2.1.311' },
  { event: 'SubagentStop', since: '2.1.311' },
  // A teammate of an agent team going idle: in 2.1.33, with the teammate's agent_id from 2.1.290.
  { event: 'TeammateIdle', since: '2.1.290' },
];

/** The `x.y.z` in `claude --version`'s output, or undefined. */
export function parseClaudeVersion(output: string): string | undefined {
  return /\b\d+\.\d+\.\d+/.exec(output)?.[0];
}

function versionAtLeast(version: string, floor: string): boolean {
  const a = version.split('.').map(Number);
  const b = floor.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
}

/** The hook events to install for Claude Code `version` (undefined when unknown: only HOOK_EVENTS). */
export function hookEvents(version?: string): string[] {
  return [...HOOK_EVENTS, ...VERSIONED_HOOK_EVENTS.filter((v) => version !== undefined && versionAtLeast(version, v.since)).map((v) => v.event)];
}

/**
 * The hook script's version, in its second line (`# devdesk-hook-version: N`). One script serves every session on the
 * host, and DevDesk Claude v1 and v2 can both be installed there, each with its own script: a window installs or
 * refreshes its script only when the installed one is not newer (`replacesHookScript`), so a v1 window never puts back
 * v1's script over v2's. Bump it with every change to the script: v1 (`main`) counts in the 100s, v2 (`v2_experiment`)
 * in the 200s, as v2's script handles every event and record v1's does.
 */
export const HOOK_SCRIPT_VERSION = 201;

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
# devdesk-hook-version: 201
"""DevDesk Agents: records Claude Code session state for the VS Code Claude Sessions panel."""
import json
import os
import re
import sys
import time

# subprocess and tempfile are not imported here: loading them takes about as long as the rest of the script, and most
# events need neither (see run).

STATE_DIR = os.environ.get('DEVDESK_STATE_DIR') or os.path.expanduser('~/.claude/devdesk/state')
ENDED_DIR = os.path.join(STATE_DIR, 'ended')
SHELLS = ('sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'tcsh')


def tmux_session(pane, server):
    """
    The tmux session of the pane Claude runs in. DevDesk tags the sessions it starts with their name and server
    (DEVDESK_TMUX_SESSION, DEVDESK_TMUX_SERVER), so their hooks need not ask tmux; a session started elsewhere asks.
    """
    if not pane:
        return None
    tagged = os.environ.get('DEVDESK_TMUX_SESSION')
    # The server must match: a tmux server started inside a DevDesk session inherits its tags.
    if tagged and os.environ.get('DEVDESK_TMUX_SERVER') == server:
        return tagged
    try:
        # DevDesk sets DEVDESK_TMUX in its sessions when devdesk.sessions.tmuxPath names another binary.
        return run([os.environ.get('DEVDESK_TMUX') or 'tmux', 'display-message', '-p', '-t', pane, '#{session_name}']).strip() or None
    except Exception:
        return None


def run(argv):
    """A program's output; imports subprocess only when a hook needs to run one."""
    import subprocess
    return subprocess.run(argv, capture_output=True, text=True, timeout=2).stdout


def parent_of(pid):
    """A process's parent pid and command name: from /proc where there is one (no fork), else from ps."""
    try:
        with open('/proc/%d/stat' % pid) as f:
            stat = f.read()
        # "<pid> (<comm>) <state> <ppid> ...": the name can hold spaces and parentheses, so cut at the last ")".
        return int(stat[stat.rindex(')') + 2:].split()[1]), stat[stat.index('(') + 1:stat.rindex(')')]
    except Exception:
        pass
    out = run(['ps', '-o', 'ppid=,comm=', '-p', str(pid)]).split(None, 1)
    return (int(out[0]), out[1].strip()) if len(out) == 2 else (None, '')


def claude_pid():
    """Claude runs hooks through a shell, so skip shell parents to reach the Claude process."""
    pid = os.getppid()
    for _ in range(3):
        try:
            parent, name = parent_of(pid)
        except Exception:
            return pid
        if parent is None or os.path.basename(name).lstrip('-') not in SHELLS:
            return pid
        pid = parent
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


def short_id(value):
    """A tool_use_id or agent_id from the payload, or None when it is missing or malformed."""
    if isinstance(value, str) and 0 < len(value.strip()) <= 256:
        return value.strip()
    return None


# Tools that wait for you by themselves, and the kind of wait each is.
WAIT_TOOLS = {'AskUserQuestion': 'question', 'ExitPlanMode': 'plan'}
WAIT_KINDS = ('question', 'plan', 'permission', 'elicitation')
RECORD_STATES = ('working', 'done', 'idle', 'blocked')
# SessionStart sources that start a new Claude process or conversation (none from an older Claude Code); 'compact' goes
# on with the same one.
SESSION_BOUNDARIES = ('startup', 'resume', 'clear', None)
# The prompt Claude Code submits itself after compacting, to carry on from the summary.
COMPACT_CONTINUATION = re.compile(r'\s*This session is being continued from a previous conversation', re.I)
# How many open waits a record keeps (the newest): more at once means several agents asking together.
MAX_WAITS = 4


def wait_detail(tool, tool_input, cwd):
    inp = tool_input if isinstance(tool_input, dict) else {}
    if tool == 'AskUserQuestion':
        questions = inp.get('questions')
        first = questions[0] if isinstance(questions, list) and questions and isinstance(questions[0], dict) else {}
        return 'Asking: ' + str(first.get('question') or 'a question')[:300]
    if tool == 'ExitPlanMode':
        return 'Plan ready for your review'
    return ('Needs permission: ' + tool_detail(tool, tool_input, cwd))[:300]


def old_wait_kind(detail):
    """The kind of a wait an older script recorded, which it only said in the detail."""
    if detail.startswith('Asking:'):
        return 'question'
    if detail.startswith('Plan ready'):
        return 'plan'
    return 'permission' if re.search('permission', detail, re.I) else 'elicitation'


def wait_frame(value):
    if not isinstance(value, dict) or value.get('kind') not in WAIT_KINDS:
        return None
    frame = {'kind': value['kind'], 'detail': str(value.get('detail') or '')[:300],
             'since': value['since'] if isinstance(value.get('since'), int) else 0}
    for key in ('toolUseId', 'toolName', 'agentId', 'elicitation'):
        if short_id(value.get(key)):
            frame[key] = short_id(value.get(key))
    return frame


def open_waits(prev):
    """
    What the session waits for you on, oldest first (the last one shows), and the state to go back to once all are
    answered (None: back to working). A record from an older script has one wait without ids.
    """
    if prev.get('state') != 'waiting':
        return [], None
    top = wait_frame(prev.get('wait'))
    if top is None:
        detail = str(prev.get('detail') or '')
        return [{'kind': old_wait_kind(detail), 'detail': detail, 'since': prev.get('updatedAt') or 0}], None
    below = prev.get('waitsBelow') if isinstance(prev.get('waitsBelow'), list) else []
    base = prev.get('stateBeforeWait')
    base = base if isinstance(base, dict) and base.get('state') in RECORD_STATES else None
    return [f for f in map(wait_frame, below) if f] + [top], base


def snapshot(prev):
    """The state a subagent's wait displaces, to go back to once it is answered."""
    if prev.get('state') not in RECORD_STATES:
        return None
    return {'state': prev['state'], 'detail': str(prev.get('detail') or ''), 'asksQuestion': prev.get('asksQuestion') is True,
            'turnEndedAt': prev.get('turnEndedAt') if isinstance(prev.get('turnEndedAt'), int) else None,
            'errorKind': kept_error_kind(prev)}


def kept_error_kind(prev):
    """The error kind of a record (or snapshot) whose blocked state is kept; None from an older script."""
    kind = prev.get('errorKind')
    return kind if isinstance(kind, str) and kind else None


def elicitation_key(data):
    """Which MCP input form an Elicitation or ElicitationResult is about: its id is unique only within its server."""
    server = str(data.get('mcp_server_name') or '')
    eid = short_id(data.get('elicitation_id'))
    return (json.dumps([server, eid]) if eid else 'elicitation:' + server)[:256]


def unkeyed(wait):
    """A wait known by no tool call or form (an older script or Claude Code, a notification): the next tool event ends it."""
    return not wait.get('toolUseId') and not wait.get('elicitation')


def settled_ids(data, event, tool_use):
    """The tool calls this event says are over: a PostToolBatch lists each, a Post hook names its own."""
    if event == 'PostToolBatch':
        calls = data.get('tool_calls')
        ids = [short_id(c.get('tool_use_id')) for c in calls if isinstance(c, dict)] if isinstance(calls, list) else []
        return set(i for i in ids if i)
    if event in ('PostToolUse', 'PostToolUseFailure') and tool_use:
        return {tool_use}
    return set()


# The events that only change the subagent roster, never what the session itself shows.
ROSTER_EVENTS = ('SubagentStart', 'SubagentStop', 'TeammateIdle')
# How many subagents a roster keeps: past that, the longest stopped go first.
MAX_ROSTER = 64


def ms_or_none(value):
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def roster_of(prev):
    """
    The session's live subagents by agent_id, as the subagent hooks saw them: type, teammate name, when it first started
    and last started (runningSince), and when it stopped or (a teammate) went idle since. resumed: it started again
    after it had stopped. Malformed entries are dropped.
    """
    value = prev.get('subagents')
    out = {}
    if not isinstance(value, dict):
        return out
    for key, entry in value.items():
        if not short_id(key) or not isinstance(entry, dict):
            continue
        clean = {k: ms_or_none(entry.get(k)) for k in ('startedAt', 'runningSince', 'stoppedAt', 'idleAt')}
        for k in ('type', 'name'):
            clean[k] = str(entry[k])[:100] if isinstance(entry.get(k), str) and entry[k] else None
        clean['resumed'] = entry.get('resumed') is True
        out[key] = clean
    return out


def trimmed(roster):
    if len(roster) <= MAX_ROSTER:
        return roster
    # Running ones stay; of the rest, the most recently active.
    def rank(item):
        e = item[1]
        return (e['stoppedAt'] is None and e['idleAt'] is None, max(e['stoppedAt'] or 0, e['idleAt'] or 0, e['runningSince'] or 0))
    return dict(sorted(roster.items(), key=rank, reverse=True)[:MAX_ROSTER])


def roster_event(path, prev, data, event, sid):
    """
    A subagent started (or a teammate took a new message), stopped, or a teammate went idle: updates the roster and
    keeps everything else the record says. Without a record yet, nothing: the session's next event writes one.
    """
    if prev.get('sessionId') != sid or prev.get('state') not in RECORD_STATES + ('waiting',):
        return
    agent = short_id(data.get('agent_id'))
    if not agent:
        return
    roster = roster_of(prev)
    now = int(time.time() * 1000)
    kind = str(data.get('agent_type') or '')[:100] or None
    entry = roster.get(agent)
    if event == 'SubagentStart':
        if entry is None:
            entry = {'type': kind, 'name': None, 'startedAt': now, 'resumed': False}
        else:
            # Started again: resumed after it stopped, or a teammate taking a new message after it went idle.
            entry['resumed'] = entry['resumed'] or entry['stoppedAt'] is not None or entry['idleAt'] is not None
            entry['type'] = kind or entry['type']
        entry.update({'runningSince': now, 'stoppedAt': None, 'idleAt': None})
    elif event == 'SubagentStop':
        if entry is None:
            if not kind:
                # One of Claude Code's own agents (a prompt suggestion, /btw) it did not start a subagent for.
                return
            entry = {'type': kind, 'name': None, 'startedAt': None, 'runningSince': None, 'idleAt': None, 'resumed': False}
        entry['stoppedAt'] = now
    else:
        name = str(data.get('teammate_name') or '')[:100] or None
        if entry is None:
            entry = {'type': kind, 'name': name, 'startedAt': None, 'runningSince': None, 'stoppedAt': None, 'resumed': False}
        entry['name'] = name or entry['name']
        entry['idleAt'] = now
    roster[agent] = entry
    prev['subagents'] = trimmed(roster)
    write_json(path, prev)


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
    prev = previous(path)
    if event in ROSTER_EVENTS:
        roster_event(path, prev, data, event, sid)
        return
    worker = short_id(data.get('agent_id'))
    if event == 'PreToolUse' and worker and prev.get('sessionId') == sid:
        roster = roster_of(prev)
        if roster.get(worker, {}).get('stoppedAt') is not None:
            # A new tool call of a subagent after its SubagentStop (another hook kept it going): it still runs. Written at
            # once, as this event may change nothing else.
            roster[worker]['stoppedAt'] = None
            prev['subagents'] = roster
            write_json(path, prev)
    # A new Claude process (started, resumed, or a /clear's new session) starts clean: no waits, turn or prompt left
    # from before, what an earlier process started cannot still run (sessionStartedAt), and no subagent of it is in the
    # roster. A compaction keeps all.
    boundary = event == 'SessionStart' and data.get('source') in SESSION_BOUNDARIES
    if event == 'SessionStart':
        if short_id(data.get('agent_id')):
            # A subagent's own start: the session itself goes on.
            return
        if not boundary and prev.get('sessionId') == sid:
            return
        # Resumed: it runs again.
        try:
            os.remove(os.path.join(ENDED_DIR, sid + '.json'))
        except OSError:
            pass
        prev = {}
    if event == 'PostCompact' and data.get('trigger') != 'manual':
        # An automatic compaction happens inside a turn, which goes on.
        return
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
    error_kind = None
    now = int(time.time() * 1000)
    # When the current turn started and, once it finished, ended: DevDesk's insights are matched to a turn by these.
    turn_started = prev.get('turnStartedAt') if isinstance(prev.get('turnStartedAt'), int) else None
    turn_ended = prev.get('turnEndedAt') if isinstance(prev.get('turnEndedAt'), int) else None
    # Waits are told apart by the tool call they belong to (tool_use_id), and by the subagent that asks (agent_id).
    waits, base = open_waits(prev)
    tool_use, agent = short_id(data.get('tool_use_id')), short_id(data.get('agent_id'))
    new_wait = None
    if event == 'UserPromptSubmit' and COMPACT_CONTINUATION.match(str(data.get('prompt') or '')):
        # The summary Claude Code submits after compacting: not a prompt of the user's, and no new turn.
        return
    if event == 'UserPromptSubmit':
        turn_started, turn_ended = now, None
        submitted = str(data.get('prompt') or '')
        # A background task's result, a system reminder or a subagent's hand-back Claude Code submits itself: keep the
        # user's last prompt.
        if not re.match(r'\s*(Another Claude session sent a message:\s*)?<(task-notification>|system-reminder>|agent-message[\s>])', submitted):
            prompt = submitted[:300]
        state, detail = 'working', 'Thinking'
        waits = []
    elif event in ('PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PostToolBatch'):
        if event == 'PreToolUse' and tool in WAIT_TOOLS:
            new_wait = {'kind': WAIT_TOOLS[tool], 'detail': wait_detail(tool, tool_input, cwd)}
        if waits and unkeyed(waits[-1]):
            # A wait without a tool call id (an older script or Claude Code, a notification): any tool event ends it.
            ended, waits = waits, []
        else:
            # A wait ends when its own tool call does, or (PreToolUse) when the agent that asked moves on. A parallel
            # tool finishing, or another agent's activity, leaves it waiting.
            settled = settled_ids(data, event, tool_use)
            # An MCP form ends only with its result (a parallel tool can start while it is open).
            def over(w):
                return w.get('toolUseId') in settled or (event == 'PreToolUse' and w.get('agentId') == agent and not w.get('elicitation'))
            ended, waits = [w for w in waits if over(w)], [w for w in waits if not over(w)]
        if new_wait:
            state, detail = 'waiting', new_wait['detail']
        elif waits:
            if not ended:
                return
            state, detail = 'waiting', waits[-1]['detail']
        elif ended and base:
            # A subagent's wait was answered: back to what the session showed before it.
            state, detail, asks, turn_ended = base['state'], base['detail'], base.get('asksQuestion') is True, base.get('turnEndedAt')
            error_kind = kept_error_kind(base)
        elif ended:
            state, detail = 'working', 'Thinking' if event == 'PostToolBatch' else tool_detail(tool, tool_input, cwd)
        elif event == 'PostToolBatch' or (agent and prev.get('state') in ('done', 'idle', 'blocked')):
            # Nothing waited; a background subagent's tools do not make a finished session working again.
            return
        else:
            state, detail = 'working', tool_detail(tool, tool_input, cwd)
    elif event == 'PermissionRequest':
        if tool_use and any(w.get('toolUseId') == tool_use for w in waits):
            # Claude Code asks permission for AskUserQuestion and ExitPlanMode too: the question or plan stays one.
            return
        new_wait = {'kind': WAIT_TOOLS.get(tool, 'permission'), 'detail': wait_detail(tool, tool_input, cwd)}
        state, detail = 'waiting', new_wait['detail']
    elif event == 'Elicitation':
        # An MCP server's input form, inside a tool call or outside any turn: the session waits for your input.
        server = str(data.get('mcp_server_name') or '') or 'An MCP server'
        message = first_line(data.get('message'))
        new_wait = {'kind': 'elicitation', 'detail': (server + ': ' + message if message else server + ' needs your input')[:300],
                    'elicitation': elicitation_key(data)}
        state, detail = 'waiting', new_wait['detail']
    elif event == 'ElicitationResult':
        # The form was answered, declined or cancelled: back to what the session showed before it (or the next wait).
        key = elicitation_key(data)
        def over(w):
            return w['kind'] == 'elicitation' and (w.get('elicitation') == key or unkeyed(w))
        if not any(over(w) for w in waits):
            return
        waits = [w for w in waits if not over(w)]
        if waits:
            state, detail = 'waiting', waits[-1]['detail']
        elif base:
            state, detail, asks, turn_ended = base['state'], base['detail'], base.get('asksQuestion') is True, base.get('turnEndedAt')
            error_kind = kept_error_kind(base)
        else:
            state, detail = 'working', 'Thinking'
    elif event == 'Notification':
        message = str(data.get('message') or '')
        kind = data.get('notification_type')
        if kind == 'idle_prompt' or message.startswith('Claude is waiting for your input'):
            if waits:
                # Still waiting on you: the reminder changes nothing.
                return
            # The idle reminder after Stop: keep showing the finished reply.
            state = 'done'
            detail = str(prev.get('detail') or '') if prev.get('state') == 'done' else ''
            detail = detail or 'Waiting for your next prompt'
            asks = prev.get('state') == 'done' and prev.get('asksQuestion') is True
        elif kind in ('permission_prompt', 'elicitation_dialog') or (not kind and message.startswith('Claude needs your')):
            if waits:
                # The dialog of a wait already recorded (a PermissionRequest, a question or a plan): keep it.
                return
            new_wait = {'kind': 'elicitation' if kind == 'elicitation_dialog' else 'permission', 'detail': (message or 'Claude needs your input')[:300]}
            state, detail = 'waiting', new_wait['detail']
        elif prev.get('state') in ('working', 'waiting', 'done', 'idle', 'blocked'):
            # Not a question for this session (a background job finished or needs input, a login succeeded): keep the state.
            state, detail = prev['state'], str(prev.get('detail') or '')
            asks = prev.get('asksQuestion') is True
            error_kind = kept_error_kind(prev)
        else:
            state, detail = 'idle', 'Ready'
    elif event == 'Stop':
        reply = last_reply(transcript) if transcript else ''
        state, detail = 'done', reply[:300] or 'Finished'
        asks = ends_with_question(reply)
        turn_ended = now
    elif event == 'PostCompact':
        # A /compact the user ran ends without a Stop: done, with nothing to answer.
        state, detail = 'done', 'Compacted the conversation'
        turn_ended = now
    elif event == 'StopFailure':
        # The turn ended on an error: error is its kind (rate_limit, unknown, ...), error_details the message.
        error = data.get('error') or ''
        # Its kind alone (rate_limit, overloaded_error, unknown): the word the error starts with, or the error's type.
        kind = re.match(r'([a-z][a-z0-9_]*)(?::|$)', first_line(error.get('type') if isinstance(error, dict) else error))
        error_kind = kind.group(1)[:64] if kind else None
        if isinstance(error, dict):
            error = error.get('message') or error.get('type') or ''
        details = first_line(data.get('error_details'))
        error = first_line(error)
        text = error + ': ' + details if error and details and error != 'unknown' else details or error
        state, detail = 'blocked', text[:300] or 'Stopped by an error'
    else:
        state, detail = 'idle', 'Ready'
    if new_wait:
        new_wait['since'] = now
        for key, value in (('toolUseId', tool_use), ('toolName', str(data.get('tool_name') or '') or None), ('agentId', agent)):
            if value:
                new_wait[key] = value[:256]
        if waits and unkeyed(waits[-1]):
            # A wait without an id is the same dialog, now known by its tool call; a question keeps its text.
            replaced = waits.pop()
            if replaced['kind'] == new_wait['kind'] and replaced['kind'] in ('question', 'plan') and replaced.get('detail'):
                new_wait['detail'] = detail = replaced['detail']
        if not waits:
            # A subagent's wait keeps what the session showed, to go back to; the lead's ends in its next tool step.
            # An MCP form keeps it too (from its Elicitation or its notification): it can come outside any turn.
            # (A dialog now known by its id keeps the state its notification displaced.)
            base = (snapshot(prev) or base) if agent or new_wait['kind'] == 'elicitation' else None
        waits = (waits + [new_wait])[-MAX_WAITS:]
    if state != 'waiting' or not waits:
        waits, base = [], None
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
        'tmuxSession': tmux_session(pane, server),
        'tmuxPane': pane or None,
        'tmuxServer': server or None,
        'cwd': cwd,
        'lastEditPath': last_edit,
        'transcriptPath': transcript or None,
        'event': event,
        'notificationType': str(data.get('notification_type') or '') or None if event == 'Notification' else None,
        'state': state,
        'detail': detail,
        # What a waiting session waits on: kind (question, plan, permission, elicitation), toolUseId, toolName, agentId,
        # elicitation (which MCP form).
        'wait': waits[-1] if waits else None,
        'waitsBelow': waits[:-1] or None,
        'stateBeforeWait': base,
        'asksQuestion': asks if state == 'done' else None,
        # What error ended the turn (StopFailure's kind: rate_limit, overloaded_error, unknown, ...).
        'errorKind': error_kind if state == 'blocked' else None,
        'prompt': prompt,
        'turnStartedAt': turn_started,
        'turnEndedAt': turn_ended if state == 'done' else None,
        # When this Claude process started the session (SessionStart): what the transcript shows started before is over.
        'sessionStartedAt': now if boundary else prev.get('sessionStartedAt') if isinstance(prev.get('sessionStartedAt'), int) else None,
        # The live subagent roster (see roster_of); kept until a new Claude process starts the session.
        'subagents': roster_of(prev) or None,
        'updatedAt': now,
    }
    write_json(path, record)


def write_json(path, value):
    """Writes atomically. A failed write (a full disk, an unwritable directory) raises and leaves no temporary file."""
    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    # A name only this process uses (as tempfile.mkstemp would make, without loading tempfile).
    tmp = '%s.%d.%d.tmp' % (path, os.getpid(), time.monotonic_ns())
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, 'w') as f:
            json.dump(value, f)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


if __name__ == '__main__':
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
`;

export type Settings = Record<string, unknown>;
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

/** True when every event in `events` has an entry whose command is exactly `command`. */
export function hasHooks(settings: Settings, command: string, events: readonly string[] = HOOK_EVENTS): boolean {
  const hooks = hookMap(settings);
  return !!hooks && events.every((e) => Array.isArray(hooks[e]) && (hooks[e] as HookGroup[]).some(groupHas(command)));
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

/**
 * Ensures one DevDesk entry with `command` per event in `events`, upgrading older DevDesk entries in place, and drops
 * DevDesk entries from other events (one this Claude Code does not know); other hooks are kept.
 */
export function addHooks(settings: Settings, command: string, events: readonly string[] = HOOK_EVENTS): Settings {
  const next = structuredClone(settings);
  const hooks = hookMap(next) ?? {};
  for (const [event, value] of Object.entries(hooks)) {
    if (events.includes(event) || !Array.isArray(value)) continue;
    const groups = dropOurs(value as HookGroup[]);
    if (groups.length) hooks[event] = groups;
    else delete hooks[event];
  }
  for (const event of events) {
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
export async function changeSettings(claudeDir: string, now: Date, change: (settings: Settings, text: string | undefined) => Promise<Settings | undefined>): Promise<HookFileResult> {
  const path = await resolveTarget(settingsFile(claudeDir));
  return withFileLock(path, async () => {
    const { text, settings } = await readSettings(path);
    const next = await change(settings, text);
    if (!next || JSON.stringify(next) === JSON.stringify(settings)) return { changed: false };
    return writeSettings(path, text, next, now);
  });
}

/** `claudeVersion`: what `claude --version` says (see `hookEvents`); undefined installs only the events every version knows. */
export function installHooksInto(claudeDir: string, now: Date, stateDir: string, claudeVersion?: string): Promise<HookFileResult> {
  return changeSettings(claudeDir, now, async (settings) => {
    const script = scriptFile(claudeDir);
    // A newer script (another DevDesk Claude version's) stays: it handles these events too.
    if (replacesHookScript(await readFile(script, 'utf8').catch(() => undefined))) await writeFileAtomic(script, HOOK_SCRIPT, true, 0o755);
    return addHooks(settings, hookCommand(script, stateDir), hookEvents(claudeVersion));
  });
}

export function removeHooksFrom(claudeDir: string, now: Date): Promise<HookFileResult> {
  return changeSettings(claudeDir, now, async (settings, text) => (text === undefined ? undefined : removeHooks(settings)));
}

export type HooksStatus = 'installed' | 'outdated' | 'missing';

/**
 * `installed`: every event for `claudeVersion` (see `hookEvents`) runs the expected command for `stateDir`; `outdated`:
 * some other DevDesk entries exist.
 */
export async function readHooksStatus(claudeDir: string, stateDir: string, claudeVersion?: string): Promise<HooksStatus> {
  let settings: Settings;
  try {
    settings = (await readSettings(settingsFile(claudeDir))).settings;
  } catch {
    return 'missing';
  }
  if (hasHooks(settings, hookCommand(scriptFile(claudeDir), stateDir), hookEvents(claudeVersion))) return 'installed';
  return hasAnyHooks(settings) ? 'outdated' : 'missing';
}

export async function readHooksInstalled(claudeDir: string, stateDir: string, claudeVersion?: string): Promise<boolean> {
  return (await readHooksStatus(claudeDir, stateDir, claudeVersion)) === 'installed';
}

/**
 * Rewrites an installed hook script that differs from HOOK_SCRIPT and is not newer (`replacesHookScript`), so upgrading
 * the extension upgrades the script without reinstalling hooks. Does nothing when the script was never installed, or
 * is newer (the other DevDesk Claude version's). True if rewritten.
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
