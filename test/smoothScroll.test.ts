import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BOUND_KEYS, joinCommands, savedBindings, scrollLines, smoothBindings, steps } from '../src/core/smoothScroll';

const tmuxAvailable = spawnSync('tmux', ['-V']).status === 0;

describe('scrollLines', () => {
  it('rounds and clamps to 1..10, defaulting to 3', () => {
    expect([scrollLines(1), scrollLines(2.6), scrollLines(0), scrollLines(50)]).toEqual([1, 3, 1, 10]);
    expect([scrollLines(undefined), scrollLines('5'), scrollLines(Number.NaN)]).toEqual([3, 3, 3]);
  });
});

describe('steps', () => {
  it('scrolls one line at a time with a pause between lines', () => {
    expect(steps('up', 1)).toBe('send-keys -X scroll-up');
    expect(steps('down', 3)).toBe('send-keys -X scroll-down ; run-shell -d 0.004 ; send-keys -X scroll-down ; run-shell -d 0.004 ; send-keys -X scroll-down');
  });
});

describe('smoothBindings', () => {
  it('binds the wheel in the root and both copy-mode tables', () => {
    const binds = smoothBindings(2);
    expect(binds.map((b) => `${b[2]} ${b[3]}`)).toEqual([
      'root WheelUpPane',
      'copy-mode WheelUpPane',
      'copy-mode WheelDownPane',
      'copy-mode-vi WheelUpPane',
      'copy-mode-vi WheelDownPane',
    ]);
    expect(binds[0][4]).toContain('{ send-keys -M } { copy-mode -e ; send-keys -X scroll-up ;');
    expect(binds[2][4]).toBe('select-pane ; send-keys -X scroll-down ; run-shell -d 0.004 ; send-keys -X scroll-down');
  });
});

describe('joinCommands', () => {
  it('separates commands with ;', () => {
    expect(joinCommands([['a', '1'], ['b'], ['c']])).toEqual(['a', '1', ';', 'b', ';', 'c']);
  });
});

describe('savedBindings', () => {
  it('keeps each listed bind-key line, and unbinds a key that had none', () => {
    const listed = ['bind-key -T root WheelUpPane send-keys -M\n', undefined, '', 'bind-key  -T copy-mode-vi WheelUpPane select-pane', 'x'];
    expect(savedBindings(listed)).toEqual([
      'bind-key -T root WheelUpPane send-keys -M',
      'unbind-key -T copy-mode WheelUpPane',
      'unbind-key -T copy-mode WheelDownPane',
      'bind-key  -T copy-mode-vi WheelUpPane select-pane',
      'unbind-key -T copy-mode-vi WheelDownPane',
    ]);
  });
});

describe.skipIf(!tmuxAvailable)('with a real tmux server', () => {
  it('accepts the bindings, and the saved lines bring the old ones back', () => {
    const server = `devdesk-test-smooth-${process.pid}`;
    const tmux = (args: string[]) => execFileSync('tmux', ['-L', server, '-f', '/dev/null', ...args], { encoding: 'utf8' });
    const list = () => BOUND_KEYS.map(({ table, key }) => tmux(['list-keys', '-T', table, key]));
    const dir = mkdtempSync(join(tmpdir(), 'devdesk-smooth-test-'));
    try {
      tmux(['new-session', '-d', '-s', 't', 'sleep 30']);
      tmux(['bind-key', '-T', 'copy-mode', 'WheelDownPane', 'send-keys -X -N 2 scroll-down']); // a user's own binding
      const before = list();
      const saved = savedBindings(before);
      tmux(joinCommands(smoothBindings(3)));
      expect(tmux(['list-keys', '-T', 'copy-mode', 'WheelUpPane'])).toContain('send-keys -X scroll-up \\; run-shell -d 0.004 \\; send-keys -X scroll-up');
      const file = join(dir, 'b.conf');
      writeFileSync(file, `${saved.join('\n')}\n`);
      tmux(['source-file', file]);
      expect(list()).toEqual(before);
    } finally {
      spawnSync('tmux', ['-L', server, 'kill-server']);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
