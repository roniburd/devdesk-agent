import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addStatusLine,
  installStatusLineInto,
  isOurStatusLine,
  limitsView,
  parseRateLimits,
  readRateLimits,
  readStatusLineStatus,
  readUserStatusLine,
  refreshStatusLineScript,
  removeStatusLine,
  removeStatusLineFrom,
  spanText,
  statusLineCommand,
  STATUSLINE_SCRIPT,
  statusLineStatusOf,
  wrappedCommand,
} from '../src/core/statusLine';

const SCRIPT = '/home/u/.claude/devdesk/devdesk_statusline.py';
const STATE = '/home/u/.claude/devdesk/state';
const USER = `"/home/u/bin/my status" --label 'it''s'`;

/** A payload as Claude Code 2.1 sends its status line (a Claude.ai subscription: with `rate_limits`). */
const payload = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    session_id: 's1',
    model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
    context_window: { used_percentage: 4, context_window_size: 1000000 },
    rate_limits: { five_hour: { used_percentage: 42.4, resets_at: 1794220000 }, seven_day: { used_percentage: 18, resets_at: 1794600000 } },
    ...extra,
  });

describe('status line command', () => {
  it('runs the script alone, or wraps your command and runs it when the script is missing', () => {
    expect(statusLineCommand(SCRIPT, STATE)).toBe(
      `if [ -f '${SCRIPT}' ] && command -v python3 >/dev/null 2>&1; then DEVDESK_STATE_DIR='${STATE}' exec python3 -I '${SCRIPT}'; fi; exit 0`,
    );
    const wrapped = statusLineCommand(SCRIPT, STATE, USER);
    expect(wrapped.startsWith(`u='"/home/u/bin/my status" --label '\\''it'\\'''\\''s'\\'''; `)).toBe(true);
    expect(wrapped.endsWith(`DEVDESK_STATUSLINE_USER="$u" exec python3 -I '${SCRIPT}'; fi; exec /bin/sh -c "$u"`)).toBe(true);
    expect(wrappedCommand(wrapped)).toBe(USER);
    expect(wrappedCommand(statusLineCommand(SCRIPT, STATE))).toBeUndefined();
    expect(isOurStatusLine(wrapped)).toBe(true);
    expect(isOurStatusLine(USER)).toBe(false);
  });

  it('keeps your status line (and its other keys) inside DevDesk’s, and gives it back on removal', () => {
    const mine = { model: 'opus', statusLine: { type: 'command', command: USER, refreshInterval: 300, padding: 1 } };
    const added = addStatusLine(mine, SCRIPT, STATE);
    expect(added).toEqual({ model: 'opus', statusLine: { type: 'command', command: statusLineCommand(SCRIPT, STATE, USER), refreshInterval: 300, padding: 1 } });
    expect(mine.statusLine.command).toBe(USER);
    // Reinstalling (another state dir) keeps the wrapped command; it never wraps itself.
    const again = addStatusLine(added, SCRIPT, '/other');
    expect((again.statusLine as { command: string }).command).toBe(statusLineCommand(SCRIPT, '/other', USER));
    expect(removeStatusLine(again)).toEqual(mine);
    // None before: none after.
    const none = addStatusLine({ model: 'opus' }, SCRIPT, STATE);
    expect(none.statusLine).toEqual({ type: 'command', command: statusLineCommand(SCRIPT, STATE) });
    expect(removeStatusLine(none)).toEqual({ model: 'opus' });
    // Someone else's status line is left alone.
    expect(removeStatusLine(mine)).toBe(mine);
  });

  it('refuses a status line that is not a command', () => {
    expect(() => addStatusLine({ statusLine: 'echo hi' }, SCRIPT, STATE)).toThrow(/not an object/);
    expect(() => addStatusLine({ statusLine: { type: 'static', text: 'x' } }, SCRIPT, STATE)).toThrow(/type static/);
  });

  it('tells installed, outdated and missing apart', () => {
    const dir = '/home/u/.claude';
    expect(statusLineStatusOf({}, dir, STATE)).toBe('missing');
    expect(statusLineStatusOf({ statusLine: { type: 'command', command: USER } }, dir, STATE)).toBe('missing');
    const s = addStatusLine({ statusLine: { type: 'command', command: USER } }, SCRIPT, STATE);
    expect(statusLineStatusOf(s, dir, STATE)).toBe('installed');
    expect(statusLineStatusOf(s, dir, '/elsewhere')).toBe('outdated');
  });
});

describe('status line settings file', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'devdesk-sl-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('installs with a backup, keeps the rest of settings.json, and removes back to it', async () => {
    const before = { model: 'opus', hooks: { Stop: [] }, statusLine: { type: 'command', command: USER, refreshInterval: 300 } };
    await writeFile(join(home, 'settings.json'), JSON.stringify(before));
    const state = join(home, 'state');
    expect(await readStatusLineStatus(home, state)).toBe('missing');
    expect(await readUserStatusLine(home)).toBe(USER);
    const r = await installStatusLineInto(home, new Date(2026, 0, 2, 3, 4, 5), state);
    expect(r).toMatchObject({ changed: true, backup: join(home, 'settings.json.devdesk-backup-20260102030405') });
    expect(JSON.parse(await readFile(r.backup!, 'utf8'))).toEqual(before);
    expect(await readFile(join(home, 'devdesk', 'devdesk_statusline.py'), 'utf8')).toBe(STATUSLINE_SCRIPT);
    expect(((await stat(join(home, 'devdesk', 'devdesk_statusline.py'))).mode & 0o777).toString(8)).toBe('755');
    expect(await readStatusLineStatus(home, state)).toBe('installed');
    expect(await readUserStatusLine(home)).toBe(USER);
    expect(await installStatusLineInto(home, new Date(), state)).toEqual({ changed: false });
    await removeStatusLineFrom(home, new Date(2026, 0, 2, 3, 4, 6));
    expect(JSON.parse(await readFile(join(home, 'settings.json'), 'utf8'))).toEqual(before);
    expect(await removeStatusLineFrom(home, new Date())).toEqual({ changed: false });
  });

  it('leaves invalid settings alone', async () => {
    await writeFile(join(home, 'settings.json'), '{ not json');
    await expect(installStatusLineInto(home, new Date(), join(home, 'state'))).rejects.toThrow(/not valid JSON/);
    expect(await readFile(join(home, 'settings.json'), 'utf8')).toBe('{ not json');
    expect(await readStatusLineStatus(home, join(home, 'state'))).toBe('missing');
  });

  it('refreshes an older installed script only', async () => {
    expect(await refreshStatusLineScript(home)).toBe(false);
    await mkdir(join(home, 'devdesk'));
    await writeFile(join(home, 'devdesk', 'devdesk_statusline.py'), 'old');
    expect(await refreshStatusLineScript(home)).toBe(true);
    expect(await refreshStatusLineScript(home)).toBe(false);
  });
});

describe('status line script', () => {
  let dir: string;
  let script: string;
  let state: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'devdesk-slscript-'));
    script = join(dir, 'devdesk_statusline.py');
    state = join(dir, 'state');
    await writeFile(script, STATUSLINE_SCRIPT);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Runs the status line as Claude Code does: `sh -c <command>` with the payload on stdin. */
  const run = (input: string, user?: string, scriptPath = script) =>
    spawnSync('/bin/sh', ['-c', statusLineCommand(scriptPath, state, user)], { input, encoding: 'utf8', env: { ...process.env } });
  const recorded = async () => JSON.parse(await readFile(join(state, 'rate-limits.json'), 'utf8'));

  it('records the limits and prints a short line without a status line of yours', async () => {
    const r = run(payload());
    expect(r).toMatchObject({ status: 0, stdout: 'Opus 5.5 · context 4% · 5h 42% · 7d 18%\n' });
    expect(await recorded()).toMatchObject({
      fiveHour: { usedPercentage: 42.4, resetsAt: 1794220000 },
      sevenDay: { usedPercentage: 18, resetsAt: 1794600000 },
      sessionId: 's1',
    });
  });

  it('runs your status line with the same stdin and prints only its output', async () => {
    const user = `cat > ${join(dir, 'seen.json')}; printf 'mine: %s' "$DEVDESK_STATUSLINE_USER"; exit 3`;
    const input = payload();
    const r = run(input, user);
    expect(r.stdout).toBe('mine: ');
    expect(await readFile(join(dir, 'seen.json'), 'utf8')).toBe(input);
    expect((await recorded()).fiveHour.usedPercentage).toBe(42.4);
    // A payload too big for a pipe write goes through a child process instead.
    const big = payload({ padding: 'x'.repeat(40000) });
    expect(run(big, user).stdout).toBe('mine: ');
    expect(await readFile(join(dir, 'seen.json'), 'utf8')).toBe(big);
  });

  it('records at most every 15 s while the numbers stay the same', async () => {
    run(payload());
    const first = (await recorded()).updatedAt as number;
    // Pretend the record is 5 s old: the same numbers leave it.
    await writeFile(join(state, 'rate-limits.json'), JSON.stringify({ ...(await recorded()), updatedAt: Date.now() - 5000 }));
    run(payload());
    expect((await recorded()).updatedAt).toBeLessThan(first);
    // New numbers are written at once.
    run(payload({ rate_limits: { five_hour: { used_percentage: 50, resets_at: 1794220000 } } }));
    expect(await recorded()).toMatchObject({ fiveHour: { usedPercentage: 50 }, sevenDay: null });
    // 20 s old: written again.
    await writeFile(join(state, 'rate-limits.json'), JSON.stringify({ ...(await recorded()), updatedAt: Date.now() - 20000 }));
    run(payload({ rate_limits: { five_hour: { used_percentage: 50, resets_at: 1794220000 } } }));
    expect(Date.now() - (await recorded()).updatedAt).toBeLessThan(5000);
    expect((await readdir(state)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('records nothing without rate limits (an API key or Bedrock) and never fails', async () => {
    expect(run(payload({ rate_limits: undefined }))).toMatchObject({ status: 0, stdout: 'Opus 5.5 · context 4%\n' });
    expect(run('not json')).toMatchObject({ status: 0, stdout: 'Claude\n' });
    expect(run(payload({ rate_limits: { five_hour: { used_percentage: 'lots' } } }))).toMatchObject({ status: 0 });
    await expect(readdir(state)).rejects.toThrow();
    // The state directory can't be made: your status line still shows.
    await writeFile(join(dir, 'blocker'), 'x');
    const blocked = spawnSync('/bin/sh', ['-c', statusLineCommand(script, join(dir, 'blocker', 'state'), 'echo still')], { input: payload(), encoding: 'utf8' });
    expect(blocked).toMatchObject({ status: 0, stdout: 'still\n' });
  });

  it('runs your status line alone when the script is gone', () => {
    expect(run(payload(), 'echo fallback', join(dir, 'missing.py'))).toMatchObject({ status: 0, stdout: 'fallback\n' });
    expect(run(payload(), undefined, join(dir, 'missing.py'))).toMatchObject({ status: 0, stdout: '' });
  });

  it('is read back for the popup', async () => {
    run(payload());
    const limits = await readRateLimits(state);
    expect(limits).toMatchObject({ fiveHour: { usedPercentage: 42.4, resetsAt: 1794220000000 }, sevenDay: { usedPercentage: 18, resetsAt: 1794600000000 } });
  });
});

describe('plan limits view', () => {
  const now = Date.UTC(2026, 10, 8, 12, 0, 0);

  it('parses what the script wrote, tolerating seconds, ms and dates', () => {
    expect(parseRateLimits('nope')).toBeUndefined();
    expect(parseRateLimits(JSON.stringify({ updatedAt: now, fiveHour: null, sevenDay: null }))).toBeUndefined();
    expect(parseRateLimits(JSON.stringify({ updatedAt: now, fiveHour: { usedPercentage: 'x' } }))).toBeUndefined();
    expect(
      parseRateLimits(
        JSON.stringify({ updatedAt: now, fiveHour: { usedPercentage: 10, resetsAt: now / 1000 + 60 }, sevenDay: { usedPercentage: -3, resetsAt: '2026-11-10T00:00:00Z' } }),
      ),
    ).toEqual({ updatedAt: now, fiveHour: { usedPercentage: 10, resetsAt: now + 60_000 }, sevenDay: { usedPercentage: 0, resetsAt: Date.UTC(2026, 10, 10) } });
    expect(parseRateLimits(JSON.stringify({ updatedAt: now, sevenDay: { usedPercentage: 5, resetsAt: now + 1 } }))).toEqual({
      updatedAt: now,
      sevenDay: { usedPercentage: 5, resetsAt: now + 1 },
    });
  });

  it('shows % used and when each window resets; drops windows that have reset', () => {
    expect(limitsView(undefined, now)).toBeUndefined();
    const view = limitsView(
      { updatedAt: now - 30_000, fiveHour: { usedPercentage: 42.6, resetsAt: now + 125 * 60_000 }, sevenDay: { usedPercentage: 140, resetsAt: now + (3 * 24 + 4) * 3600_000 } },
      now,
    );
    expect(view).toEqual({
      asOf: '',
      rows: [
        { label: '5-hour', percent: 43, percentText: '43%', resetsText: 'resets in 2 h 5 min', resetsAt: now + 125 * 60_000 },
        { label: 'Weekly', percent: 100, percentText: '100%', resetsText: 'resets in 3 d 4 h', resetsAt: now + (3 * 24 + 4) * 3600_000 },
      ],
    });
    const later = limitsView({ updatedAt: now - 7 * 60_000, fiveHour: { usedPercentage: 90, resetsAt: now - 1 }, sevenDay: { usedPercentage: 20 } }, now);
    expect(later).toEqual({ asOf: 'as of 7 min ago', rows: [{ label: 'Weekly', percent: 20, percentText: '20%', resetsText: '' }] });
    expect(limitsView({ updatedAt: now, fiveHour: { usedPercentage: 1, resetsAt: now } }, now)).toBeUndefined();
  });

  it('writes spans short', () => {
    expect(spanText(0)).toBe('1 min');
    expect(spanText(59 * 60_000)).toBe('59 min');
    expect(spanText(60 * 60_000)).toBe('1 h');
    expect(spanText(25 * 3600_000)).toBe('1 d 1 h');
    expect(spanText(48 * 3600_000)).toBe('2 d');
  });
});
