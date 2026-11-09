import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from './atomicWrite';
import { changeSettings, type HookFileResult, type Settings } from './hooks';
import { isFiniteNumber, parseObject, readTextIfExists } from './json';
import { shellQuote } from './shell';

/**
 * Claude's plan limits (5-hour and weekly) for the 📊 popup, from DevDesk's status line. Claude Code gives the status
 * line command a JSON payload on stdin whose `rate_limits` holds `five_hour` and `seven_day`, each with
 * `used_percentage` (0-100) and `resets_at` (Unix seconds). It does so only for Claude.ai subscriptions (Pro, Max),
 * after the first reply; hooks and transcripts don't carry them. DevDesk's script records them in
 * `<state dir>/rate-limits.json`, then runs the status line you had (with the same stdin) or prints a short line.
 */
const SCRIPT_NAME = 'devdesk_statusline.py';
export const RATE_LIMITS_FILE = 'rate-limits.json';

/**
 * Python 3.9, standard library only. Fail-open: whatever goes wrong recording, your status line still runs. Records at
 * most every 15 s while the numbers stay the same (Claude Code runs the status line several times a second).
 */
export const STATUSLINE_SCRIPT = String.raw`#!/usr/bin/env python3
"""DevDesk Agents: records Claude's plan limits for the Claude Board, then shows your status line."""
import json
import os
import subprocess
import sys
import tempfile
import time

STATE_DIR = os.environ.get('DEVDESK_STATE_DIR') or os.path.expanduser('~/.claude/devdesk/state')
LIMITS = os.path.join(STATE_DIR, 'rate-limits.json')
MIN_INTERVAL_MS = 15000


def number(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) and value == value else None


def window(value):
    if not isinstance(value, dict):
        return None
    used = number(value.get('used_percentage'))
    if used is None:
        used = number(value.get('utilization'))
    if used is None:
        return None
    out = {'usedPercentage': used}
    resets = value.get('resets_at')
    if number(resets) is not None:
        out['resetsAt'] = resets
    elif isinstance(resets, str) and resets.strip():
        out['resetsAt'] = resets.strip()[:64]
    return out


def previous():
    try:
        with open(LIMITS) as f:
            value = json.load(f)
        return value if isinstance(value, dict) else {}
    except Exception:
        return {}


def record(data):
    limits = data.get('rate_limits')
    if not isinstance(limits, dict):
        return
    five, seven = window(limits.get('five_hour')), window(limits.get('seven_day'))
    if not five and not seven:
        return
    now = int(time.time() * 1000)
    prev = previous()
    at = prev.get('updatedAt')
    if prev.get('fiveHour') == five and prev.get('sevenDay') == seven and isinstance(at, int) and 0 <= now - at < MIN_INTERVAL_MS:
        return
    os.makedirs(STATE_DIR, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=STATE_DIR, suffix='.tmp')
    try:
        with os.fdopen(fd, 'w') as f:
            json.dump({'fiveHour': five, 'sevenDay': seven, 'sessionId': str(data.get('session_id') or '')[:256] or None, 'updatedAt': now}, f)
        os.replace(tmp, LIMITS)
    except Exception:
        try:
            os.remove(tmp)
        except OSError:
            pass


def short_line(data):
    """Without a status line of yours: the model, the context used and the plan limits."""
    model = data.get('model') if isinstance(data.get('model'), dict) else {}
    parts = [str(model.get('display_name') or model.get('id') or 'Claude')]
    context = data.get('context_window') if isinstance(data.get('context_window'), dict) else {}
    if number(context.get('used_percentage')) is not None:
        parts.append('context %d%%' % round(context['used_percentage']))
    limits = data.get('rate_limits') if isinstance(data.get('rate_limits'), dict) else {}
    for key, label in (('five_hour', '5h'), ('seven_day', '7d')):
        w = window(limits.get(key))
        if w:
            parts.append('%s %d%%' % (label, round(w['usedPercentage'])))
    return ' · '.join(parts)


def main():
    raw = sys.stdin.buffer.read()
    try:
        data = json.loads(raw.decode('utf-8', 'replace'))
        data = data if isinstance(data, dict) else {}
    except Exception:
        data = {}
    try:
        record(data)
    except Exception:
        pass
    command = os.environ.get('DEVDESK_STATUSLINE_USER')
    if not command:
        print(short_line(data))
        return
    os.environ.pop('DEVDESK_STATUSLINE_USER', None)
    sys.stdout.flush()
    if len(raw) < 16384:
        # Your command takes this process's place (Claude Code's timeout reaches it), reading the same stdin from a pipe.
        r, w = os.pipe()
        os.write(w, raw)
        os.close(w)
        os.dup2(r, 0)
        os.close(r)
        os.execv('/bin/sh', ['/bin/sh', '-c', command])
    sys.exit(subprocess.run(['/bin/sh', '-c', command], input=raw).returncode)


if __name__ == '__main__':
    main()
`;

const USER_PREFIX = /^u=('(?:[^']|'\\'')*'); /;

/**
 * The command Claude Code runs (`sh -c`) for the status line. `userCommand`, the status line you had, is kept in it
 * (as `u=…`, readable in settings.json, and given back on removal). When the script or python3 is missing, it runs your
 * command alone (or prints nothing), so the status line never breaks.
 */
export function statusLineCommand(scriptPath: string, stateDir: string, userCommand?: string): string {
  const script = shellQuote(scriptPath);
  const run = `if [ -f ${script} ] && command -v python3 >/dev/null 2>&1; then DEVDESK_STATE_DIR=${shellQuote(stateDir)}`;
  if (!userCommand) return `${run} exec python3 -I ${script}; fi; exit 0`;
  return `u=${shellQuote(userCommand)}; ${run} DEVDESK_STATUSLINE_USER="$u" exec python3 -I ${script}; fi; exec /bin/sh -c "$u"`;
}

/** True when `command` is DevDesk's status line command (of any version or state directory). */
export const isOurStatusLine = (command: unknown): command is string => typeof command === 'string' && command.includes(SCRIPT_NAME);

/** The status line command of yours that DevDesk's `command` runs, or undefined when it runs none. */
export function wrappedCommand(command: string): string | undefined {
  const m = USER_PREFIX.exec(command);
  return m ? m[1].slice(1, -1).replace(/'\\''/g, "'") : undefined;
}

function statusLineOf(settings: Settings): Record<string, unknown> | undefined {
  const s = settings.statusLine;
  return s && typeof s === 'object' && !Array.isArray(s) ? (s as Record<string, unknown>) : undefined;
}

/**
 * `settings` with DevDesk's status line, keeping yours to run after it (and its other keys, like `refreshInterval`
 * and `padding`). Reinstalling over DevDesk's keeps the command it wraps. Throws on a status line that is not a command.
 */
export function addStatusLine(settings: Settings, scriptPath: string, stateDir: string): Settings {
  const next = structuredClone(settings);
  const current = statusLineOf(next);
  if (settings.statusLine !== undefined && !current) throw new Error('its statusLine is not an object; nothing was changed');
  if (current && current.type !== undefined && current.type !== 'command') throw new Error(`its statusLine is of type ${String(current.type)}, not command; nothing was changed`);
  const existing = typeof current?.command === 'string' && current.command.trim() ? current.command : undefined;
  const user = existing && isOurStatusLine(existing) ? wrappedCommand(existing) : existing;
  next.statusLine = { ...current, type: 'command', command: statusLineCommand(scriptPath, stateDir, user) };
  return next;
}

/** `settings` without DevDesk's status line: the one it wrapped comes back, or none. Another status line is kept. */
export function removeStatusLine(settings: Settings): Settings {
  const current = statusLineOf(settings);
  if (!current || !isOurStatusLine(current.command)) return settings;
  const next = structuredClone(settings);
  const user = wrappedCommand(current.command);
  if (user) next.statusLine = { ...current, command: user };
  else delete next.statusLine;
  return next;
}

export type StatusLineStatus = 'installed' | 'outdated' | 'missing';

const scriptFile = (claudeDir: string) => join(claudeDir, 'devdesk', SCRIPT_NAME);

/** `installed`: DevDesk's status line runs the current script for `stateDir`; `outdated`: an older one of DevDesk's. */
export function statusLineStatusOf(settings: Settings, claudeDir: string, stateDir: string): StatusLineStatus {
  const command = statusLineOf(settings)?.command;
  if (!isOurStatusLine(command)) return 'missing';
  return command === statusLineCommand(scriptFile(claudeDir), stateDir, wrappedCommand(command)) ? 'installed' : 'outdated';
}

export async function readStatusLineStatus(claudeDir: string, stateDir: string): Promise<StatusLineStatus> {
  const settings = parseObject((await readTextIfExists(join(claudeDir, 'settings.json')).catch(() => undefined)) ?? '');
  return settings ? statusLineStatusOf(settings, claudeDir, stateDir) : 'missing';
}

/** The status line command `settings.json` in `claudeDir` has now (not DevDesk's), for the install prompt. */
export async function readUserStatusLine(claudeDir: string): Promise<string | undefined> {
  const settings = parseObject((await readTextIfExists(join(claudeDir, 'settings.json')).catch(() => undefined)) ?? '');
  const command = settings && statusLineOf(settings)?.command;
  if (typeof command !== 'string' || !command.trim()) return undefined;
  return isOurStatusLine(command) ? wrappedCommand(command) : command;
}

export function installStatusLineInto(claudeDir: string, now: Date, stateDir: string): Promise<HookFileResult> {
  return changeSettings(claudeDir, now, async (settings) => {
    const next = addStatusLine(settings, scriptFile(claudeDir), stateDir);
    await writeFileAtomic(scriptFile(claudeDir), STATUSLINE_SCRIPT, true, 0o755);
    return next;
  });
}

export function removeStatusLineFrom(claudeDir: string, now: Date): Promise<HookFileResult> {
  return changeSettings(claudeDir, now, async (settings, text) => (text === undefined ? undefined : removeStatusLine(settings)));
}

/** Rewrites an installed status line script that differs from STATUSLINE_SCRIPT (see `refreshHookScript`). */
export async function refreshStatusLineScript(claudeDir: string): Promise<boolean> {
  const script = scriptFile(claudeDir);
  let current: string;
  try {
    current = await readFile(script, 'utf8');
  } catch {
    return false;
  }
  if (current === STATUSLINE_SCRIPT) return false;
  await writeFileAtomic(script, STATUSLINE_SCRIPT, true, 0o755);
  return true;
}

// ---- Reading what the script recorded ---------------------------------------------------------------------------

export interface LimitWindow {
  usedPercentage: number;
  /** Epoch ms, when known. */
  resetsAt?: number;
}

export interface RateLimits {
  fiveHour?: LimitWindow;
  sevenDay?: LimitWindow;
  /** Epoch ms of the status line run that recorded them. */
  updatedAt: number;
}

/** Epoch ms from `resets_at`: Unix seconds (as documented), ms, or a date string. */
function resetTime(value: unknown): number | undefined {
  if (isFiniteNumber(value)) return value > 1e12 ? value : value * 1000;
  if (typeof value === 'string') {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : undefined;
  }
  return undefined;
}

function parseWindow(value: unknown): LimitWindow | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const o = value as Record<string, unknown>;
  if (!isFiniteNumber(o.usedPercentage)) return undefined;
  const resetsAt = resetTime(o.resetsAt);
  return { usedPercentage: Math.max(0, o.usedPercentage), ...(resetsAt !== undefined ? { resetsAt } : {}) };
}

/** `rate-limits.json` as the script writes it, or undefined. */
export function parseRateLimits(text: string): RateLimits | undefined {
  const o = parseObject(text);
  if (!o || !isFiniteNumber(o.updatedAt)) return undefined;
  const fiveHour = parseWindow(o.fiveHour);
  const sevenDay = parseWindow(o.sevenDay);
  if (!fiveHour && !sevenDay) return undefined;
  return { ...(fiveHour ? { fiveHour } : {}), ...(sevenDay ? { sevenDay } : {}), updatedAt: o.updatedAt };
}

export async function readRateLimits(stateDir: string): Promise<RateLimits | undefined> {
  const text = await readTextIfExists(join(stateDir, RATE_LIMITS_FILE)).catch(() => undefined);
  return text === undefined ? undefined : parseRateLimits(text);
}

export interface LimitRow {
  label: string;
  /** Rounded, 0-100. */
  percent: number;
  percentText: string;
  /** `resets in 2 h 5 min`, or empty when unknown. */
  resetsText: string;
  /** The reset time as a date, for the tooltip. */
  resetsAt?: number;
}

export interface LimitsView {
  rows: LimitRow[];
  /** `as of 5 min ago` when the numbers are older than a minute, else empty. */
  asOf: string;
}

/** `5 min`, `2 h 5 min`, `3 d 4 h`. */
export function spanText(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

/**
 * The 📊 popup's plan limits at `now`. A window whose reset time has passed has started again, at a use DevDesk does not
 * know until Claude replies: it is left out. Undefined when nothing is left.
 */
export function limitsView(limits: RateLimits | undefined, now: number): LimitsView | undefined {
  if (!limits) return undefined;
  const rows: LimitRow[] = [];
  for (const [label, w] of [
    ['5-hour', limits.fiveHour],
    ['Weekly', limits.sevenDay],
  ] as const) {
    if (!w || (w.resetsAt !== undefined && w.resetsAt <= now)) continue;
    const percent = Math.min(100, Math.round(w.usedPercentage));
    rows.push({
      label,
      percent,
      percentText: `${percent}%`,
      resetsText: w.resetsAt !== undefined ? `resets in ${spanText(w.resetsAt - now)}` : '',
      ...(w.resetsAt !== undefined ? { resetsAt: w.resetsAt } : {}),
    });
  }
  if (!rows.length) return undefined;
  const age = now - limits.updatedAt;
  return { rows, asOf: age >= 60_000 ? `as of ${spanText(age)} ago` : '' };
}
