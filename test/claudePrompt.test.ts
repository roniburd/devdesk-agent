import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { claudeIsWorking, claudePromptIsEmpty, claudePromptShown, type PaneFlags, paneScreenArgs, parsePaneFlags, parsePaneScreen } from '../src/core/claudePrompt';

const E = '\x1b';
const rule = `${E}[38;5;244m${'─'.repeat(40)} devdesk-agents ─`;
const bottom = `${E}[38;5;244m${'─'.repeat(56)}`;
/** A Claude Code screen as `tmux capture-pane -p -e` prints it, with `prompt` as the input box's lines. */
const screen = (...prompt: string[]) =>
  [
    ' ▐▛███▛█   Claude Code v2.1.312',
    '',
    rule,
    ...prompt,
    bottom,
    `${E}[39m  ${E}[36mOpus 5.5${E}[38;5;246m | Context: ${E}[32m0%`,
    `  ${E}[38;5;220m⏵⏵${E}[39m ${E}[38;5;220mauto mode on`,
  ].join('\n');

describe('claudePromptIsEmpty', () => {
  it('is true for an empty prompt showing only the cursor', () => {
    expect(claudePromptIsEmpty(screen(`${E}[39m❯ ${E}[7m ${E}[0m`))).toBe(true);
    expect(claudePromptIsEmpty(screen('❯ '))).toBe(true);
  });

  it("is true while Claude's dimmed placeholder shows, first character as the cursor", () => {
    expect(claudePromptIsEmpty(screen(`❯ ${E}[7mT${E}[27m${E}[2mry "fix the tests"${E}[22m`))).toBe(true);
  });

  it('is false with text in the prompt, wherever the cursor is', () => {
    expect(claudePromptIsEmpty(screen(`${E}[39m❯ hello world${E}[7m ${E}[0m`))).toBe(false);
    expect(claudePromptIsEmpty(screen(`${E}[39m❯ hello wo${E}[7mr${E}[0mld`))).toBe(false);
    expect(claudePromptIsEmpty(screen(`${E}[39m❯ ${E}[7mr${E}[0mld`))).toBe(false);
    expect(claudePromptIsEmpty(screen(`❯ ${E}[7mx${E}[0m`))).toBe(false);
  });

  it('is false when the prompt holds only typed spaces before the cursor', () => {
    expect(claudePromptIsEmpty([rule, `❯    ${E}[7m ${E}[0m`, bottom].join('\n'))).toBe(false);
    expect(claudePromptIsEmpty(screen(`${E}[39m❯  ${E}[7m ${E}[0m`))).toBe(false);
    expect(claudePromptIsEmpty(screen('❯ ', `  ${E}[7m ${E}[0m`))).toBe(false);
  });

  it('is false when a later line of a multi-line prompt has text', () => {
    expect(claudePromptIsEmpty(screen('❯ ', `  second line${E}[7m ${E}[0m`))).toBe(false);
  });

  it('is false with no prompt box on screen, such as a menu', () => {
    expect(claudePromptIsEmpty([rule, ' Is this a project you trust?', ' ❯ No, exit', '   Yes, I trust this folder'].join('\n'))).toBe(false);
    expect(claudePromptIsEmpty('user@host ~ % ')).toBe(false);
    expect(claudePromptIsEmpty('')).toBe(false);
  });

  it('uses the last prompt box on screen', () => {
    const scrolled = [rule, '❯ old prompt text', bottom, 'Claude replied.', screen('❯ ')].join('\n');
    expect(claudePromptIsEmpty(scrolled)).toBe(true);
  });
});

describe('claudeIsWorking', () => {
  const spinner = `${E}[38;5;174m✻${E}[39m ${E}[38;5;174mPondering…${E}[39m ${E}[2m(12s · ↓ 1.2k tokens · esc to interrupt)${E}[22m`;
  const box = (...above: string[]) => [...above, rule, `❯ ${E}[7m ${E}[0m`, bottom, '  ⏵⏵ auto mode on'].join('\n');

  it('is true while the spinner shows above the (empty) prompt box, a todo list in between too', () => {
    const capture = box('⏺ Running the tests.', '', spinner, '');
    expect(claudePromptIsEmpty(capture)).toBe(true);
    expect(claudeIsWorking(capture)).toBe(true);
    expect(claudeIsWorking(box('✶ Cogitating…', '  ⎿  ☐ Fix the tests', '     ☐ Update the docs', ''))).toBe(true);
  });

  it('is true when only the "esc to interrupt" hint shows, below the box', () => {
    expect(claudeIsWorking([rule, '❯ ', bottom, '  esc to interrupt'].join('\n'))).toBe(true);
  });

  it('is false at an idle prompt, after a finished turn, or with no prompt box', () => {
    expect(claudeIsWorking(screen('❯ '))).toBe(false);
    expect(claudeIsWorking(box('⏺ Done.', '', '✻ Worked for 1m 3s', ''))).toBe(false);
    expect(claudeIsWorking(spinner)).toBe(false);
  });

  it('is false at an idle prompt whose transcript mentions "esc to interrupt" or shows a bullet with an ellipsis', () => {
    const transcript = [
      '> What does esc to interrupt mean in the status line?',
      '',
      '⏺ It is the hint Claude shows while it works ("esc to interrupt"):',
      '  * Building…',
      '  * Testing…',
      '',
      '✻ Worked for 3s',
      '',
    ];
    expect(claudeIsWorking(box(...transcript))).toBe(false);
    expect(claudeIsWorking(box('⏺ Done.', '', '> what does esc to interrupt do?', ''))).toBe(false);
  });
});

/**
 * Real captures of Claude Code 2.1.319 in a 120x40 tmux pane (`capture-pane -p -e`; banner text and paths replaced),
 * with what `display-message -p` reported for the pane at the same moment (`flags.json`).
 */
const NBSP = '\u00a0';
type Recorded = { inMode: number; bracketPaste: number; cursorX: number; cursorY: number };
const recorded = JSON.parse(readFileSync(new URL('./fixtures/claudePrompt/flags.json', import.meta.url), 'utf8')) as Record<string, Recorded>;
const capture = (name: string) => readFileSync(new URL(`./fixtures/claudePrompt/${name}.txt`, import.meta.url), 'utf8');
const flagsOf = (name: string): PaneFlags => {
  const r = recorded[name];
  return parsePaneFlags([r.inMode, r.bracketPaste, r.cursorX, r.cursorY].map(String))!;
};
const emptyComposer = `❯${NBSP}${E}[7m ${E}[0m`;

describe('claudePromptIsEmpty on real Claude Code captures', () => {
  const cases: [string, boolean][] = [
    ['empty', true],
    ['idle-after-turn', true],
    // Claude keeps the composer open and empty while it works: `claudeIsWorking` tells.
    ['working', true],
    ['text', false],
    ['text-cursor-mid', false],
    ['text-cursor-home', false],
    ['spaces', false],
    ['multiline', false],
    ['slash-menu', false],
    ['shell-mode', false],
    ['copy-mode', false],
    ['permission-dialog', false],
    ['question-dialog', false],
    ['trust-dialog', false],
    ['after-exit', false],
  ];
  it.each(cases)('%s: %s with the pane flags', (name, empty) => {
    expect(claudePromptIsEmpty(capture(name), flagsOf(name))).toBe(empty);
  });

  // Copy mode shows the screen beneath it: only the flags tell.
  it.each(cases.filter(([name]) => name !== 'copy-mode'))('%s: %s from the capture alone', (name, empty) => {
    expect(claudePromptIsEmpty(capture(name))).toBe(empty);
  });

  it("draws the composer as `❯` and a no-break space, the transcript's prompts with a plain space", () => {
    expect(capture('empty')).toContain(emptyComposer);
    expect(capture('idle-after-turn')).toContain(`❯ ${E}[38;5;231mReply with only the word hi`);
  });

  it('is false once Claude exited, its empty prompt box still above the shell prompt, as the cursor shows', () => {
    // As after Ctrl+C twice at an empty prompt: the last box stays on screen, the shell prompt below it.
    const stale = capture('after-exit').replace(`❯${NBSP}${E}[38;5;153m/exit${E}[7m${E}[39m ${E}[0m`, emptyComposer);
    expect(stale).not.toBe(capture('after-exit'));
    expect(claudePromptIsEmpty(stale, flagsOf('after-exit'))).toBe(false);
    // Without the cursor, the box looks like a live empty prompt.
    expect(claudePromptIsEmpty(stale)).toBe(true);
  });

  it('is false while the pane is in copy mode or bracketed paste is off, whatever the screen shows', () => {
    expect(claudePromptIsEmpty(capture('empty'), { ...flagsOf('empty'), inMode: true })).toBe(false);
    expect(claudePromptIsEmpty(capture('empty'), { ...flagsOf('empty'), bracketPaste: false })).toBe(false);
    expect(claudePromptIsEmpty(capture('empty'), { ...flagsOf('empty'), bracketPaste: undefined })).toBe(true);
  });

  it('is false when the cursor is not at the caret right after `❯ `', () => {
    expect(claudePromptIsEmpty(capture('empty'), { ...flagsOf('empty'), cursor: { x: 3, y: 11 } })).toBe(false);
    expect(claudePromptIsEmpty(capture('empty'), { ...flagsOf('empty'), cursor: { x: 2, y: 12 } })).toBe(false);
    expect(claudePromptIsEmpty(capture('empty'), { inMode: false })).toBe(true);
  });

  it("is true while Claude's dimmed placeholder shows after the caret", () => {
    const placeholder = capture('empty').replace(emptyComposer, `❯${NBSP}${E}[7mT${E}[27m${E}[2mry "fix the tests"${E}[22m`);
    expect(placeholder).not.toBe(capture('empty'));
    expect(claudePromptIsEmpty(placeholder, flagsOf('empty'))).toBe(true);
    expect(claudePromptIsEmpty(placeholder)).toBe(true);
  });

  it('falls back to the older parser when the composer has a plain space (Claude before the no-break space)', () => {
    const older = (name: string) => capture(name).replaceAll(`❯${NBSP}`, '❯ ');
    expect(claudePromptIsEmpty(older('empty'), flagsOf('empty'))).toBe(true);
    expect(claudePromptIsEmpty(older('text'), flagsOf('text'))).toBe(false);
    expect(claudePromptIsEmpty(older('spaces'), flagsOf('spaces'))).toBe(false);
    expect(claudePromptIsEmpty(older('copy-mode'), flagsOf('copy-mode'))).toBe(false);
  });
});

describe('claudeIsWorking on real Claude Code captures', () => {
  it('is true during a turn, false at an idle prompt, in a dialog, or after Claude exited', () => {
    expect(claudeIsWorking(capture('working'))).toBe(true);
    for (const name of ['empty', 'idle-after-turn', 'text', 'permission-dialog', 'question-dialog', 'after-exit']) expect(claudeIsWorking(capture(name)), name).toBe(false);
  });
});

describe('paneScreenArgs and parsePaneScreen', () => {
  const SEP = '|^|';
  it('captures the pane and prints its flags, then the extra fields, in one tmux call', () => {
    expect(paneScreenArgs('=s:', SEP, ['#{pane_pid}'])).toEqual([
      'capture-pane', '-p', '-e', '-t', '=s:', ';', 'display-message', '-p', '-t', '=s:',
      '#{pane_in_mode}|^|#{bracket_paste_flag}|^|#{cursor_x}|^|#{cursor_y}|^|#{pane_pid}',
    ]);
  });

  it('splits the capture (blank lines kept) from the flags line', () => {
    const out = `\nline 1\n❯${NBSP}\n\n0|^|1|^|2|^|1|^|4242|^|claude\n`;
    expect(parsePaneScreen(out, SEP)).toEqual({
      capture: `\nline 1\n❯${NBSP}\n`,
      flags: { inMode: false, bracketPaste: true, cursor: { x: 2, y: 1 } },
      extra: ['4242', 'claude'],
    });
  });

  it('leaves out what an older tmux does not report', () => {
    expect(parsePaneScreen('x\n1|^||^|3|^|4\n', SEP).flags).toEqual({ inMode: true, bracketPaste: undefined, cursor: { x: 3, y: 4 } });
    expect(parsePaneScreen('x\n0|^|1|^||^|\n', SEP).flags).toEqual({ inMode: false, bracketPaste: true, cursor: undefined });
    expect(parsePaneScreen('x\nnot flags\n', SEP).flags).toBeUndefined();
  });
});

describe('claudePromptShown', () => {
  it('is true with the prompt box on screen, empty or with text typed', () => {
    expect(claudePromptShown(screen(`${E}[39m❯ ${E}[7m ${E}[0m`))).toBe(true);
    expect(claudePromptShown(screen(`${E}[39m❯ ytou 1${E}[7m ${E}[0m`))).toBe(true);
  });

  it('is false while a dialog takes the prompt box’s place', () => {
    const dialog = [
      ' Do you want to proceed?',
      ' ❯ 1. Yes',
      '   2. Yes, and don’t ask again',
      '   3. No, and tell Claude what to do differently (esc)',
    ].join('\n');
    expect(claudePromptShown(dialog)).toBe(false);
  });

  it('is true with the composer on screen (real captures), false while a dialog takes its place', () => {
    for (const name of ['empty', 'idle-after-turn', 'working', 'text']) expect(claudePromptShown(capture(name)), name).toBe(true);
    for (const name of ['permission-dialog', 'question-dialog']) expect(claudePromptShown(capture(name)), name).toBe(false);
  });
});
