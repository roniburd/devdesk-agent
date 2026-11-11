import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tmuxStartCommand } from '../src/core/sessionStart';

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'session-start-test-'));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('tmuxStartCommand', () => {
  it('passes a short command as is', async () => {
    expect(tmuxStartCommand("claude -- 'hi'; exec $SHELL -l", tmp)).toBe("claude -- 'hi'; exec $SHELL -l");
    expect(await readdir(tmp)).toEqual([]);
  });

  it('runs a long command from a private script that removes its folder', async () => {
    const command = `echo ${'x'.repeat(10_000)} > /dev/null; echo ran`;
    const short = tmuxStartCommand(command, tmp);
    const [dir] = await readdir(tmp);
    expect(dir).toMatch(/^devdesk-claude-start-/);
    const file = join(tmp, dir, 'start.sh');
    expect(short).toBe(`. '${file}'`);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).toContain(command);
    expect(execFileSync('/bin/sh', ['-c', short], { encoding: 'utf8' }).trim()).toBe('ran');
    expect(await readdir(tmp)).toEqual([]);
  });
});
