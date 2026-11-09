import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listProcesses } from '../src/core/processes';
import { isClaudeCommand } from '../src/core/sessions';

// The checked-in wrapper a manual check sets as devdesk.sessions.claudePath: its session must count as running Claude.
describe('e2e/fixtures/fake-claude', () => {
  let child: ChildProcess | undefined;
  afterEach(() => void child?.kill());

  it('runs as a process named claude, so the Claude view sees it running', async () => {
    const log = join(mkdtempSync(join(tmpdir(), 'devdesk-fake-claude-test-')), 'log.jsonl');
    child = spawn(resolve(__dirname, '../e2e/fixtures/fake-claude'), [], {
      env: { ...process.env, DEVDESK_FAKE_CLAUDE_LOG: log },
      stdio: ['pipe', 'ignore', 'inherit'],
    });
    let pid: number | undefined;
    for (let i = 0; i < 100 && pid === undefined; i++) {
      await new Promise((r) => setTimeout(r, 50));
      if (existsSync(log)) pid = (JSON.parse(readFileSync(log, 'utf8').split('\n')[0]) as { pid: number }).pid;
    }
    expect(pid).toBeDefined();
    const table = await listProcesses();
    expect(table!.comm.get(pid!)).toBeDefined();
    expect(isClaudeCommand(table!.comm.get(pid!)!)).toBe(true);
  });
});
