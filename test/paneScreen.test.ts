import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { claudeRunsIn, readPaneScreen, readPromptScreen, typeIntoPane } from '../src/core/paneScreen';
import { DIALOG_SCREEN, EMPTY_SCREEN, fakeTmux, processTable, WORKING_SCREEN } from './web/fakes';

const claudeUnder100 = async () => processTable([[100, 1, 'sh'], [101, 100, 'claude']]);
const shellOnly = async () => processTable([[100, 1, 'zsh']]);
const noTable = async () => undefined;

describe('claudeRunsIn', () => {
  it('looks for Claude under the pane process', async () => {
    expect(await claudeRunsIn(100, 'sh', claudeUnder100)).toBe(true);
    expect(await claudeRunsIn(100, 'claude', shellOnly)).toBe(false);
  });

  it('falls back to the command name without a process table', async () => {
    expect(await claudeRunsIn(100, 'claude', noTable)).toBe(true);
    expect(await claudeRunsIn(100, '2.1.3', noTable)).toBe(true);
    expect(await claudeRunsIn(100, 'node', noTable)).toBe(true);
    expect(await claudeRunsIn(100, 'zsh', noTable)).toBe(false);
    expect(await claudeRunsIn(100, '', noTable)).toBe(false);
  });

  it('does not list processes for a bad pid', async () => {
    let listed = false;
    const list = async () => {
      listed = true;
      return processTable([]);
    };
    expect(await claudeRunsIn(NaN, 'claude', list)).toBe(true);
    expect(listed).toBe(false);
  });
});

describe('readPromptScreen', () => {
  it('reads an empty prompt', async () => {
    const tmux = fakeTmux({ capture: EMPTY_SCREEN });
    expect(await readPromptScreen(tmux.run, '%3', claudeUnder100)).toEqual({ empty: true, working: false, exited: false, inMode: false });
    expect(tmux.calls).toHaveLength(1);
    expect(tmux.calls[0].slice(0, 6)).toEqual(['capture-pane', '-p', '-e', '-t', '%3', ';']);
    expect(tmux.calls[0].slice(6, 10)).toEqual(['display-message', '-p', '-t', '%3']);
  });

  it('reads a working session, a dialog, copy mode and an exit', async () => {
    expect(await readPromptScreen(fakeTmux({ capture: WORKING_SCREEN }).run, '%3', claudeUnder100)).toMatchObject({ working: true });
    expect(await readPromptScreen(fakeTmux({ capture: DIALOG_SCREEN }).run, '%3', claudeUnder100)).toMatchObject({ empty: false, working: false });
    expect(await readPromptScreen(fakeTmux({ inMode: true }).run, '%3', claudeUnder100)).toMatchObject({ inMode: true });
    expect(await readPromptScreen(fakeTmux({}).run, '%3', shellOnly)).toMatchObject({ exited: true });
  });

  it('gives the capture too', async () => {
    const { capture } = await readPaneScreen(fakeTmux({ capture: 'hello' }).run, '%3', claudeUnder100);
    expect(capture).toBe('hello');
  });

  it('throws what tmux throws', async () => {
    await expect(readPromptScreen(fakeTmux({ fail: { 'capture-pane': "can't find pane: %3" } }).run, '%3', claudeUnder100)).rejects.toThrow(/can't find pane/);
  });
});

describe('typeIntoPane', () => {
  const o = (settleMs: number) => ({ tmpDir: tmpdir(), settleMs });

  it('pastes the text as one line through a buffer of its own, then presses Enter after the delay', async () => {
    const tmux = fakeTmux();
    const start = Date.now();
    await typeIntoPane(tmux.run, '%3', 'hello\nworld', o(20));
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
    expect(tmux.calls.map((c) => c[0])).toEqual(['load-buffer', 'paste-buffer', 'send-keys']);
    expect(tmux.calls[0][2]).toMatch(/^devdesk-send-[0-9a-f]+$/);
    expect(tmux.calls.at(-1)).toEqual(['send-keys', '-t', '%3', 'Enter']);
  });

  it('types a /command before pasting its argument', async () => {
    const tmux = fakeTmux();
    await typeIntoPane(tmux.run, '%3', '/rename fix the build', o(0));
    expect(tmux.calls.map((c) => c[0])).toEqual(['load-buffer', 'send-keys', 'paste-buffer', 'send-keys']);
    expect(tmux.calls[1]).toEqual(['send-keys', '-t', '%3', '-l', '--', '/rename ']);
  });

  it('refuses a bad target', async () => {
    await expect(typeIntoPane(fakeTmux().run, 'cc-main', 'x', o(0))).rejects.toThrow();
  });
});
