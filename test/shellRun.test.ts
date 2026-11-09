import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { runCommand, shellCommand } from '../src/core/shellRun';

describe('runCommand', () => {
  it('passes env and collects stdout and stderr', async () => {
    const r = await runCommand('/bin/sh', ['-c', 'echo "$X"; echo err >&2'], { cwd: tmpdir(), env: { X: 'hi' }, timeoutMs: 10_000 });
    expect(r).toEqual({ ok: true, output: 'hi\nerr\n' });
  });

  it('reports a failure with the error message when there is no stderr', async () => {
    const r = await runCommand('/bin/sh', ['-c', 'exit 3'], { cwd: tmpdir(), timeoutMs: 10_000 });
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/Command failed/);
  });
});

describe('shellCommand', () => {
  it('quotes each argument after the binary', () => {
    expect(shellCommand('$HOME/bin/claude', ['-p', 'a b'])).toBe(`$HOME/bin/claude '-p' 'a b'`);
  });
});
