import { describe, expect, it } from 'vitest';
import { claudeIsWorking, claudePromptIsEmpty } from '../src/core/claudePrompt';
import type { SessionCard } from '../src/core/sessions';
import { currentCard, missingArgument, runningSessions, sendBlocker, sessionPicks, WHILE_WORKING } from '../src/core/sessionSend';
import { commandLine, commandParts, INERT_ESCAPE, paneTarget, PASTE_BYTES_PER_MS, pasteArgs, pasteBufferName, pastedText, pasteSubmitDelayMs, typeArgs, typedLine } from '../src/core/tmux';

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

describe('pastedText', () => {
  it('defuses ESC bytes, so a paste cannot end early or move the cursor', () => {
    expect(pastedText('a\x1b[201~b\x1b')).toBe(`a${INERT_ESCAPE}[201~b${INERT_ESCAPE}`);
    expect(pastedText('/rename esc\x1b[31mred')).toBe('/rename esc<ESC>[31mred');
  });
  it('keeps line breaks (as \\n) and tabs, drops other control characters', () => {
    expect(pastedText('a\r\nb\rc\nd\te\x03f\x7fg\x00')).toBe('a\nb\nc\nd\tefg');
  });
  it('keeps everything else as it is: quotes, $, backticks, ;, key names, unicode', () => {
    const text = `$HOME \`uname\` "q" 'q' ; \\; Enter C-c ✓ -x`;
    expect(pastedText(text)).toBe(text);
  });
});

describe('commandLine', () => {
  it('is one line, as Claude runs a pasted /command only on one line', () => {
    expect(commandLine('  /btw why\nis it\r\nslow?\t ')).toBe('/btw why is it slow?');
    expect(commandLine('/rename a\x1b[Db')).toBe('/rename a<ESC>[Db');
  });
  it('does not end with a backslash, which Claude Code reads with Enter as "insert a newline"', () => {
    expect(commandLine('/export C:\\out\\')).toBe('/export C:\\out\\ ');
    expect(commandLine('/btw is the path foo\\\n')).toBe('/btw is the path foo\\ ');
    expect(commandLine('/btw a\\b')).toBe('/btw a\\b');
  });
  it('keeps a trailing ; and key names as text (a paste reads nothing as a key)', () => {
    expect(commandLine('/rename Enter C-c;')).toBe('/rename Enter C-c;');
  });
});

describe('pasteArgs', () => {
  it('loads the file into its own buffer, pastes it bracketed and deletes it, then Enter on its own', () => {
    expect(pasteArgs('%3', 'devdesk-send-ab12', '/tmp/x/text')).toEqual({
      load: ['load-buffer', '-b', 'devdesk-send-ab12', '/tmp/x/text'],
      paste: ['paste-buffer', '-d', '-p', '-b', 'devdesk-send-ab12', '-t', '%3'],
      drop: ['delete-buffer', '-b', 'devdesk-send-ab12'],
      submit: ['send-keys', '-t', '%3', 'Enter'],
    });
    expect(pasteArgs('=cc-main:', 'b', 'f').paste.at(-1)).toBe('=cc-main:');
  });
  it('rejects other targets', () => {
    expect(() => pasteArgs('cc-main', 'b', 'f')).toThrow(/not a tmux pane target/);
    expect(() => pasteArgs('=a:b:c', 'b', 'f')).toThrow();
  });
});

describe('commandParts', () => {
  it('types /name before an argument, and pastes the argument', () => {
    expect(commandParts('/rename a b ; c')).toEqual({ lead: '/rename ', rest: 'a b ; c' });
    expect(commandParts('/plugin:skill-x do it')).toEqual({ lead: '/plugin:skill-x ', rest: 'do it' });
    expect(commandParts('/btw ' + 'y'.repeat(20000)).rest.length).toBe(20000);
  });
  it('pastes a line with no argument, or not a command, whole', () => {
    expect(commandParts('/cost')).toEqual({ lead: '', rest: '/cost' });
    expect(commandParts('/cost ')).toEqual({ lead: '', rest: '/cost ' });
    expect(commandParts('hello there')).toEqual({ lead: '', rest: 'hello there' });
    expect(commandParts('/we$ird x')).toEqual({ lead: '', rest: '/we$ird x' });
  });
});

describe('typeArgs', () => {
  it('types literally', () => {
    expect(typeArgs('%2', '/rename ')).toEqual(['send-keys', '-t', '%2', '-l', '--', '/rename ']);
  });
  it('refuses a trailing ; (tmux would read a command separator) and other targets', () => {
    expect(() => typeArgs('%2', 'a;')).toThrow();
    expect(() => typeArgs('cc-main', 'a')).toThrow(/not a tmux pane target/);
  });
});

describe('pasteBufferName', () => {
  it('names a DevDesk buffer, unique by its suffix', () => {
    expect(pasteBufferName('0a1b')).toBe('devdesk-send-0a1b');
    expect(pasteBufferName('a')).not.toBe(pasteBufferName('b'));
    expect(() => pasteBufferName('a b')).toThrow();
    expect(() => pasteBufferName('')).toThrow();
  });
});

describe('pasteSubmitDelayMs', () => {
  it('is the settle delay, and 1 ms more per 4 KB pasted', () => {
    expect(pasteSubmitDelayMs(500, 0)).toBe(500);
    expect(pasteSubmitDelayMs(500, 1)).toBe(501);
    expect(pasteSubmitDelayMs(500, PASTE_BYTES_PER_MS * 10)).toBe(510);
    expect(pasteSubmitDelayMs(0, 20000)).toBe(5);
  });
  it('takes a negative or broken setting as 0', () => {
    expect(pasteSubmitDelayMs(-5, 0)).toBe(0);
    expect(pasteSubmitDelayMs(Number.NaN, 4096)).toBe(1);
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
