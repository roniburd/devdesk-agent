import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BOUND_KEYS, EVENTS_OPTION, joinCommands, savedBindings, scroll, scrollLines, smoothBindings, steps } from '../src/core/smoothScroll';

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

describe('scroll', () => {
  it('is the one-line steps without acceleration', () => {
    expect(scroll('up', 2, false)).toBe(steps('up', 2));
  });

  it('counts the event for a moment, then jumps further the more events came in, fastest first', () => {
    const s = scroll('down', 2, true);
    expect(s.startsWith(`set -pF ${EVENTS_OPTION} "#{e|+:`)).toBe(true);
    expect(s).toContain(`run-shell -b -d 0.15 -C "set -pF -t #{pane_id} ${EVENTS_OPTION} '##{e|-:##{${EVENTS_OPTION}},1}'"`);
    const jumps = [...s.matchAll(/>=:#\{@devdesk-wheel-events\},(\d+)\}" \{ send-keys -X -N (\d+) scroll-down/g)].map((m) => [+m[1], +m[2]]);
    expect(jumps).toEqual([[12, 12], [8, 8], [4, 4]]);
    expect(s.endsWith(`{ ${steps('down', 2)} } } }`)).toBe(true);
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

  it('with acceleration, quick wheel events scroll further, and an event after a pause one line', async () => {
    const server = `devdesk-test-accel-${process.pid}`;
    const tmux = (args: string[]) => execFileSync('tmux', ['-L', server, '-f', '/dev/null', ...args], { encoding: 'utf8' });
    const dir = mkdtempSync(join(tmpdir(), 'devdesk-accel-test-'));
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    try {
      tmux(['new-session', '-d', '-s', 't', '-x', '80', '-y', '20', 'seq 1 3000; sleep 30']);
      for (let i = 0; i < 100 && Number(tmux(['display-message', '-p', '-t', 't', '#{history_size}']).trim()) < 1900; i++) await sleep(50);
      const event = join(dir, 'event.conf');
      writeFileSync(event, `${scroll('up', 1, true, 1.5)}\n`); // events count for 1.5 s: the burst below fits on a slow machine
      const wheel = () => tmux(['source-file', '-t', 't', event]);
      const position = () => Number(tmux(['display-message', '-p', '-t', 't', '#{scroll_position}']).trim());
      tmux(['copy-mode', '-t', 't']);
      tmux(joinCommands(Array.from({ length: 8 }, () => ['source-file', '-t', 't', event]))); // 8 events at once
      expect(position()).toBe(3 * 1 + 4 * 2 + 4); // events 1-3: 1 line each, 4-7: 2 each, 8: 4
      await sleep(1800); // the events no longer count
      expect(tmux(['show-options', '-pv', '-t', 't', EVENTS_OPTION]).trim()).toBe('0');
      const before = position();
      wheel();
      expect(position() - before).toBe(1);
    } finally {
      spawnSync('tmux', ['-L', server, 'kill-server']);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
