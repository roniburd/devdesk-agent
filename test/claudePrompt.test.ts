import { describe, expect, it } from 'vitest';
import { claudeIsWorking, claudePromptIsEmpty } from '../src/core/claudePrompt';

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
