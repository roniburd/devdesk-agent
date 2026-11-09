import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { ExecError, execText, runCommand, shellCommand } from '../src/core/shellRun';

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

describe('execText', () => {
  it('resolves with stdout', async () => {
    expect(await execText('/bin/sh', ['-c', 'pwd; echo err >&2'], { cwd: '/' })).toBe('/\n');
  });

  it('rejects with the trimmed stderr', async () => {
    await expect(execText('/bin/sh', ['-c', 'echo "  bad thing  " >&2; exit 1'])).rejects.toThrow(/^bad thing$/);
  });

  it('rejects with the error message when there is no stderr', async () => {
    await expect(execText('/bin/sh', ['-c', 'exit 3'])).rejects.toThrow(/^Command failed/);
  });

  it('marks a program killed on timeout', async () => {
    const err = await execText('/bin/sh', ['-c', 'sleep 5'], { timeoutMs: 100 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExecError);
    expect((err as ExecError).killed).toBe(true);
  });

  it('rejects when the program does not exist', async () => {
    await expect(execText('/nonexistent/devdesk-binary', [])).rejects.toThrow(/ENOENT/);
  });
});

describe('shellCommand', () => {
  it('quotes each argument after the binary', () => {
    expect(shellCommand('$HOME/bin/claude', ['-p', 'a b'])).toBe(`$HOME/bin/claude '-p' 'a b'`);
  });
});
