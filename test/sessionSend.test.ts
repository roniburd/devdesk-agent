import { describe, expect, it } from 'vitest';
import { claudeIsWorking, claudePromptIsEmpty } from '../src/core/claudePrompt';
import type { SessionCard } from '../src/core/sessions';
import { currentCard, missingArgument, runningSessions, sendBlocker, sessionPicks, WHILE_WORKING } from '../src/core/sessionSend';
import { paneTarget, SEND_KEYS_CHUNK_BYTES, sendKeysArgs, typedLine } from '../src/core/tmux';

const card = (id: string, over: Partial<SessionCard> = {}): SessionCard => ({
  id,
  state: 'idle',
  detail: 'Ready',
  attached: false,
  tmuxSession: `cc-${id}`,
  tmuxPane: '%1',
  tmuxServer: 'devdesk',
  featureName: 'main',
  featureDir: '/w',
  name: `Session ${id}`,
  ...over,
});

describe('paneTarget', () => {
  it('prefers the pane id, else the tmux session’s current pane', () => {
    expect(paneTarget({ tmuxSession: 'cc-main', tmuxPane: '%12' })).toBe('%12');
    expect(paneTarget({ tmuxSession: 'cc-main' })).toBe('=cc-main:');
    expect(paneTarget({ tmuxSession: 'cc-main', tmuxPane: 'nope' })).toBe('=cc-main:');
    expect(paneTarget({})).toBeUndefined();
  });
});

describe('typedLine', () => {
  it('makes one line: no newline would submit early, no control characters', () => {
    expect(typedLine('  /btw why\nis it\r\nslow?\t ')).toBe('/btw why is it slow?');
    expect(typedLine('/rename a\x03b\x1b[Dc')).toBe('/rename ab[Dc');
  });
});

describe('sendKeysArgs', () => {
  it('types the text literally, then presses Enter in a second command', () => {
    expect(sendKeysArgs('%3', '/compact keep the tests')).toEqual({
      type: [['send-keys', '-t', '%3', '-l', '--', '/compact keep the tests']],
      submit: ['send-keys', '-t', '%3', 'Enter'],
    });
  });
  it('keeps key names, a trailing ; and a leading - as text', () => {
    // tmux drops an argument's trailing `;` (a command separator) unless it is escaped: `\;` reaches the pane as `;`.
    expect(sendKeysArgs('=cc-main:', '/rename Enter C-c;').type).toEqual([['send-keys', '-t', '=cc-main:', '-l', '--', '/rename Enter C-c\\;']]);
    expect(sendKeysArgs('%1', '/rename a\\;').type[0].at(-1)).toBe('/rename a\\\\;');
    expect(sendKeysArgs('%1', '-x').type[0].slice(-2)).toEqual(['--', '-x']);
  });
  it('does not end the typed text with a backslash, which Claude Code reads with Enter as "insert a newline"', () => {
    const typed = (text: string) => sendKeysArgs('%1', text).type.map((t) => t.at(-1)).join('');
    expect(typed('/export C:\\out\\')).toBe('/export C:\\out\\ ');
    expect(typed('/btw is the path foo\\\n')).toBe('/btw is the path foo\\ ');
    expect(typed('/btw a\\b')).toBe('/btw a\\b');
    const long = '/btw ' + 'y'.repeat(SEND_KEYS_CHUNK_BYTES * 2) + '\\';
    const pieces = sendKeysArgs('%1', long).type.map((t) => t.at(-1)!);
    expect(pieces.at(-1)!.endsWith('\\ ')).toBe(true);
    expect(pieces.every((p) => Buffer.byteLength(p) <= SEND_KEYS_CHUNK_BYTES)).toBe(true);
  });
  it('flattens line breaks', () => {
    expect(sendKeysArgs('%1', '/btw a\nb').type[0].at(-1)).toBe('/btw a b');
  });
  it('types a long line in pieces tmux accepts (it refuses a command over about 16 KB), then one Enter', () => {
    const long = '/btw ' + 'y'.repeat(20000);
    const { type, submit } = sendKeysArgs('%1', long);
    expect(type.length).toBe(3);
    expect(type.map((t) => t.at(-1)).join('')).toBe(long);
    for (const t of type) {
      expect(t.slice(0, 5)).toEqual(['send-keys', '-t', '%1', '-l', '--']);
      expect(Buffer.byteLength(t.at(-1)!)).toBeLessThanOrEqual(SEND_KEYS_CHUNK_BYTES);
    }
    expect(submit).toEqual(['send-keys', '-t', '%1', 'Enter']);
  });
  it('splits between characters, never inside one, and escapes a piece ending in ;', () => {
    const wide = 'é'.repeat(SEND_KEYS_CHUNK_BYTES); // 2 bytes each
    const pieces = sendKeysArgs('%1', wide).type.map((t) => t.at(-1)!);
    expect(pieces.join('')).toBe(wide);
    expect(pieces.every((p) => Buffer.byteLength(p) <= SEND_KEYS_CHUNK_BYTES)).toBe(true);
    const semi = 'a'.repeat(SEND_KEYS_CHUNK_BYTES - 1) + ';' + 'b';
    expect(sendKeysArgs('%1', semi).type.map((t) => t.at(-1))).toEqual(['a'.repeat(SEND_KEYS_CHUNK_BYTES - 1) + '\\;', 'b']);
  });
  it('rejects other targets', () => {
    expect(() => sendKeysArgs('cc-main', '/x')).toThrow(/not a tmux pane target/);
    expect(() => sendKeysArgs('=a:b:c', '/x')).toThrow();
  });
});

describe('runningSessions', () => {
  it('keeps running sessions in tmux in main or a worktree, those in the preferred folder first', () => {
    const cards = [
      card('a', { featureDir: '/w' }),
      card('b', { featureDir: '/w/worktrees/feat', featureName: 'feat' }),
      card('stopped', { state: 'stopped' }),
      // A parked (or exited, crashed) row can keep the tmux session Claude exited to: no Claude to type into.
      card('parked', { state: 'parked', endReason: 'parked' }),
      card('exited', { state: 'parked', endReason: 'exited', featureDir: '/w/worktrees/feat', featureName: 'feat' }),
      card('notmux', { tmuxSession: undefined, tmuxPane: undefined }),
      card('outside', { featureDir: undefined, featureName: undefined }),
      card('c', { featureDir: '/w/worktrees/feat', featureName: 'feat', state: 'working' }),
    ];
    expect(runningSessions(cards).map((c) => c.id)).toEqual(['a', 'b', 'c']);
    expect(runningSessions(cards, '/w/worktrees/feat').map((c) => c.id)).toEqual(['b', 'c', 'a']);
    expect(runningSessions([])).toEqual([]);
  });
});

describe('sessionPicks', () => {
  it('shows the title, then the worktree and state, then where it runs', () => {
    const now = 1_000_000_000;
    const [pick] = sessionPicks([card('a', { state: 'working', detail: 'Running Bash', updatedAt: now - 120_000 })], now, 'devdesk');
    expect(pick.label).toBe('Session a');
    expect(pick.description).toBe('main · WORKING · 2m ago');
    expect(pick.detail).toContain('tmux cc-a');
    expect(pick.detail).toContain('Running Bash');
    expect(pick.card.id).toBe('a');
  });
  it('tells apart sessions with the same title (no hooks, in the same folder) by when they started, else their tmux session', () => {
    const now = 1_000_000_000;
    const hookless = (id: string, over: Partial<SessionCard> = {}) =>
      card(id, { name: undefined, cwd: '/w/src/PkgA', state: 'unknown', detail: 'Install Claude status hooks', ...over });
    const picks = sessionPicks([hookless('a', { startedAt: now - 5 * 60_000 }), hookless('b', { startedAt: now - 2 * 3600_000 }), hookless('c')], now, 'devdesk');
    expect(picks.map((p) => p.label)).toEqual(['Claude in PkgA', 'Claude in PkgA', 'Claude in PkgA']);
    expect(picks[0].description).toContain('started 5m ago');
    expect(picks[1].description).toContain('started 2h ago');
    expect(picks[2].description).toContain('cc-c');
    // A session with a title of its own needs nothing more.
    expect(sessionPicks([card('a', { startedAt: now - 60_000 })], now)[0].description).toBe('main · READY');
  });
  it('tells apart named sessions with the same name by their last prompt', () => {
    const picks = sessionPicks([card('a', { name: 'Fix', prompt: 'fix the alarms' }), card('b', { name: 'Fix', prompt: 'fix the build' })], 0);
    expect(picks[0].description).toContain('fix the alarms');
    expect(picks[1].description).toContain('fix the build');
  });
});

describe('sendBlocker', () => {
  const idle = { empty: true, working: false };
  it('lets a command through at an empty prompt', () => {
    expect(sendBlocker(card('a'), 'compact', idle)).toBeUndefined();
    expect(sendBlocker(card('a', { state: 'done' }), 'rename', idle)).toBeUndefined();
    expect(sendBlocker(card('a', { state: 'unknown' }), 'compact', idle)).toBeUndefined();
  });
  it('says why when the prompt has text or a dialog is open', () => {
    expect(sendBlocker(card('a'), 'compact', { empty: false, working: false })).toMatch(/"Session a" is not at an empty prompt.*send \/compact again/);
  });
  it('waits for a working session, except for commands that leave the conversation alone', () => {
    const working = card('a', { state: 'working' });
    expect(sendBlocker(working, 'compact', idle)).toBe('"Session a" is working: send /compact when it is done.');
    for (const c of WHILE_WORKING) expect(sendBlocker(working, c, idle)).toBeUndefined();
    expect(sendBlocker(working, 'btw', { empty: false, working: false })).toMatch(/not at an empty prompt/);
  });
  it('says the pane is scrolled back when tmux shows it in copy mode (keys would go to copy mode, not Claude)', () => {
    const scrolled = { empty: true, working: false, inMode: true };
    expect(sendBlocker(card('a'), 'compact', scrolled)).toMatch(/"Session a" is scrolled back \(tmux copy mode\).*send \/compact again/);
    expect(sendBlocker(card('a'), 'btw', scrolled)).toMatch(/copy mode/);
  });
  it('waits when the screen shows Claude in a turn, for a session without hooks (state unknown)', () => {
    const E = '\x1b';
    const rule = `${E}[38;5;244m${'─'.repeat(40)}`;
    const capture = [
      '⏺ Running the tests.',
      '',
      `${E}[38;5;174m✻${E}[39m ${E}[38;5;174mPondering…${E}[39m ${E}[2m(12s · ↓ 1.2k tokens · esc to interrupt)${E}[22m`,
      '',
      rule,
      `❯ ${E}[7m ${E}[0m`,
      rule,
      '  ⏵⏵ auto mode on',
    ].join('\n');
    const screen = { empty: claudePromptIsEmpty(capture), working: claudeIsWorking(capture) };
    const unknown = card('a', { state: 'unknown' });
    expect(sendBlocker(unknown, 'compact', screen)).toBe('"Session a" is working: send /compact when it is done.');
    expect(sendBlocker(unknown, 'btw', screen)).toBeUndefined();
  });
});

describe('missingArgument', () => {
  it('is true only for a required argument left out', () => {
    expect(missingArgument('<question>', '')).toBe(true);
    expect(missingArgument('<question>', 'why?')).toBe(false);
    expect(missingArgument('[instructions]', '')).toBe(false);
    expect(missingArgument(undefined, '')).toBe(false);
  });
});

describe('currentCard', () => {
  const picked = card('tmux:devdesk:%1', { state: 'unknown' });
  it('finds the card by id', () => {
    const now = { ...picked, state: 'idle' as const };
    expect(currentCard([card('x', { tmuxPane: '%2' }), now], picked)).toBe(now);
  });
  it('finds the card of the same pane on the same server when its id changed (a hook gave it its session id)', () => {
    const now = card('sid-1', { state: 'working' });
    expect(currentCard([card('x', { tmuxPane: '%2' }), now], picked)).toBe(now);
  });
  it('does not match a pane of another server, and keeps the picked card when nothing matches', () => {
    expect(currentCard([card('sid-1', { tmuxServer: 'other' })], picked)).toBe(picked);
    expect(currentCard([], picked)).toBe(picked);
  });
});
