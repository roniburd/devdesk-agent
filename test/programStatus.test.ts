import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cardsWithProgramStatus,
  cardWithProgramStatus,
  MAX_BODY_BYTES,
  parseProgramStatusBody,
  parseProgramStatusFile,
  PROGRAM_STATUS_SCRIPT,
  programStatusBusy,
  programStatusFileName,
  programStatusWrapper,
  readCardProgramStatus,
  readProgramStatuses,
  screenWithProgramStatus,
  type ProgramStatus,
} from '../src/core/programStatus';
import type { SessionCard } from '../src/core/sessions';
import { sendBlocker } from '../src/core/sessionSend';
import { claudeShellCommand } from '../src/core/tmux';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

describe('parseProgramStatusBody', () => {
  it('reads what Claude Code 2.1.319 sends', () => {
    expect(parseProgramStatusBody('state=idle:app=claude-code')).toEqual({ state: 'idle', app: 'claude-code' });
    expect(parseProgramStatusBody('state=working:app=claude-code')).toEqual({ state: 'working', app: 'claude-code' });
    expect(parseProgramStatusBody('state=blocked:app=claude-code:kind=question:msg=YW5zd2VyOiBQaWNrIEEgb3IgQj8gKEEgwrcgQik=')).toEqual({
      state: 'blocked',
      app: 'claude-code',
      kind: 'question',
      msg: 'answer: Pick A or B? (A · B)',
    });
    expect(parseProgramStatusBody('state=blocked:app=claude-code:kind=permission:msg=YXBwcm92ZSBCYXNoOiB0b3VjaCBzcGlrZS1maWxl')?.msg).toBe(
      'approve Bash: touch spike-file',
    );
    expect(parseProgramStatusBody('state=clear')).toEqual({ state: 'clear' });
  });

  it('ignores the probe, child records, and reports without a valid state', () => {
    expect(parseProgramStatusBody('?')).toBeUndefined();
    expect(parseProgramStatusBody(' ? ')).toBeUndefined();
    expect(parseProgramStatusBody('state=working:id=agent-1')).toBeUndefined();
    expect(parseProgramStatusBody('app=claude-code')).toBeUndefined();
    expect(parseProgramStatusBody('state=sleeping')).toBeUndefined();
    expect(parseProgramStatusBody('')).toBeUndefined();
  });

  it('keeps a kind only on blocked, and skips malformed pairs', () => {
    expect(parseProgramStatusBody('state=working:kind=permission')).toEqual({ state: 'working' });
    expect(parseProgramStatusBody('state=blocked:kind=nap')).toEqual({ state: 'blocked' });
    expect(parseProgramStatusBody('state=done:app=bad app:junk:x=y z')).toEqual({ state: 'done' });
  });

  it('voids a report whose msg is invalid, and drops an over-long body', () => {
    expect(parseProgramStatusBody('state=working:msg=a')).toBeUndefined();
    expect(parseProgramStatusBody('state=working:msg=a=b')).toBeUndefined();
    // A pair outside the grammar is skipped, not the report.
    expect(parseProgramStatusBody('state=working:msg=@@@')).toEqual({ state: 'working' });
    expect(parseProgramStatusBody(`state=working:msg=${b64('line\nbreak')}`)).toBeUndefined();
    expect(parseProgramStatusBody(`state=working:msg=${b64('x'.repeat(2049))}`)).toBeUndefined();
    expect(parseProgramStatusBody(`state=working:msg=${b64('x'.repeat(2048))}`)?.msg).toHaveLength(2048);
    expect(parseProgramStatusBody(`state=working:app=${'a'.repeat(MAX_BODY_BYTES)}`)).toBeUndefined();
  });
});

describe('parseProgramStatusFile', () => {
  it('reads the relay’s file', () => {
    expect(parseProgramStatusFile(JSON.stringify({ body: 'state=working:app=claude-code', at: 5, pid: 42 }))).toEqual({
      state: 'working',
      app: 'claude-code',
      at: 5,
      pid: 42,
    });
    // How many subagents report blocked (a newer relay); none, or a broken count, leaves it out.
    expect(parseProgramStatusFile(JSON.stringify({ body: 'state=working', at: 5, pid: 42, blocked: 2 }))?.blockedChildren).toBe(2);
    for (const blocked of [0, -1, 1.5, '2']) expect(parseProgramStatusFile(JSON.stringify({ body: 'state=working', at: 5, pid: 42, blocked }))).not.toHaveProperty('blockedChildren');
  });

  it('rejects broken files and the cleared state', () => {
    expect(parseProgramStatusFile('{')).toBeUndefined();
    expect(parseProgramStatusFile(JSON.stringify({ body: 'state=clear', at: 5, pid: 42 }))).toBeUndefined();
    expect(parseProgramStatusFile(JSON.stringify({ body: 'state=idle', at: 'x', pid: 42 }))).toBeUndefined();
    expect(parseProgramStatusFile(JSON.stringify({ body: 'state=idle', at: 5, pid: 0 }))).toBeUndefined();
  });
});

describe('programStatusFileName', () => {
  it('names a pane’s file after its server and pane number', () => {
    expect(programStatusFileName('devdesk', '%12')).toBe('devdesk-12.json');
    expect(programStatusFileName(undefined, '%3')).toBe('default-3.json');
    expect(programStatusFileName('devdesk', 'cc-main')).toBeUndefined();
    expect(programStatusFileName('devdesk', undefined)).toBeUndefined();
  });
});

const card = (over: Partial<SessionCard> = {}): SessionCard => ({
  id: 'tmux:devdesk:%4',
  state: 'unknown',
  detail: 'Install Claude status hooks to see what Claude is doing',
  attached: false,
  tmuxSession: 'cc-main',
  tmuxPane: '%4',
  tmuxServer: 'devdesk',
  ...over,
});
const status = (over: Partial<ProgramStatus>): ProgramStatus => ({ state: 'idle', at: 1000, pid: 1, ...over });

describe('cardWithProgramStatus', () => {
  it('gives a session without hooks Claude’s state', () => {
    expect(cardWithProgramStatus(card(), status({ state: 'working' }))).toMatchObject({ state: 'working', detail: 'Working', updatedAt: 1000 });
    expect(cardWithProgramStatus(card(), status({ state: 'blocked', kind: 'permission', msg: 'approve Bash: ls' }))).toMatchObject({
      state: 'waiting',
      detail: 'approve Bash: ls',
    });
    expect(cardWithProgramStatus(card(), status({ state: 'blocked', kind: 'auth' }))).toMatchObject({ state: 'waiting', detail: 'Waiting for you to sign in' });
    expect(cardWithProgramStatus(card(), status({ state: 'blocked' }))).toMatchObject({ state: 'waiting' });
    expect(cardWithProgramStatus(card(), status({ state: 'done' }))).toMatchObject({ state: 'done' });
    expect(cardWithProgramStatus(card(), status({ state: 'idle' }))).toMatchObject({ state: 'idle' });
    expect(cardWithProgramStatus(card(), status({ state: 'error', msg: 'API error' }))).toMatchObject({ state: 'blocked', detail: 'API error' });
  });

  it('leaves hook state, and cards without a status, alone', () => {
    const hooked = card({ state: 'done', detail: 'Finished' });
    expect(cardWithProgramStatus(hooked, status({ state: 'working' }))).toBe(hooked);
    const plain = card();
    expect(cardWithProgramStatus(plain, undefined)).toBe(plain);
  });

  it('matches cards to statuses by server and pane', () => {
    const cards = [card(), card({ id: 'b', tmuxPane: '%5' }), card({ id: 'c', tmuxPane: '%4', tmuxServer: 'other' })];
    const out = cardsWithProgramStatus(cards, new Map([['devdesk-4.json', status({ state: 'working' })]]));
    expect(out.map((c) => c.state)).toEqual(['working', 'unknown', 'unknown']);
    expect(cardsWithProgramStatus(cards, new Map())).toBe(cards);
  });
});

describe('screenWithProgramStatus', () => {
  const idleScreen = { empty: true, working: false };
  it('trusts Claude’s report for a turn or an open dialog', () => {
    expect(screenWithProgramStatus(idleScreen, status({ state: 'working' }))).toEqual({ empty: false, working: true });
    expect(screenWithProgramStatus(idleScreen, status({ state: 'blocked', kind: 'question' }))).toEqual({ empty: false, working: false });
    // The spinner scrape saw a turn that has ended: Claude says it is done.
    expect(screenWithProgramStatus({ empty: true, working: true }, status({ state: 'done' }))).toEqual({ empty: true, working: false });
  });

  it('leaves typed text to the screen, and everything to it without a report', () => {
    expect(screenWithProgramStatus({ empty: false, working: false }, status({ state: 'idle' }))).toEqual({ empty: false, working: false });
    const screen = { empty: true, working: true, inMode: true };
    expect(screenWithProgramStatus(screen, undefined)).toBe(screen);
  });

  it('feeds sendBlocker', () => {
    const c = card({ state: 'idle', name: 'S' });
    expect(sendBlocker(c, 'compact', screenWithProgramStatus(idleScreen, status({ state: 'working' })))).toMatch(/is working/);
    expect(sendBlocker(c, 'compact', screenWithProgramStatus(idleScreen, status({ state: 'blocked' })))).toMatch(/not at an empty prompt/);
    expect(sendBlocker(c, 'compact', screenWithProgramStatus(idleScreen, status({ state: 'idle' })))).toBeUndefined();
  });

  it('programStatusBusy', () => {
    expect(programStatusBusy(status({ state: 'working' }))).toBe(true);
    expect(programStatusBusy(status({ state: 'blocked' }))).toBe(true);
    expect(programStatusBusy(status({ state: 'done' }))).toBe(false);
    expect(programStatusBusy(undefined)).toBe(false);
  });
});

describe('reading status files', () => {
  let dir = '';
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = '';
  });

  it('reads the live statuses, leaving out those whose relay is gone and other files', async () => {
    dir = await mkdtemp(join(tmpdir(), 'devdesk-status-'));
    await writeFile(join(dir, 'devdesk-1.json'), JSON.stringify({ body: 'state=working', at: 1, pid: 10 }));
    await writeFile(join(dir, 'devdesk-2.json'), JSON.stringify({ body: 'state=idle', at: 1, pid: 11 }));
    await writeFile(join(dir, 'devdesk-3.json.99.tmp'), JSON.stringify({ body: 'state=idle', at: 1, pid: 10 }));
    await writeFile(join(dir, 'devdesk-4.json'), 'garbage');
    const statuses = await readProgramStatuses(dir, (pid) => pid === 10);
    expect([...statuses.keys()]).toEqual(['devdesk-1.json']);
    expect(await readCardProgramStatus(dir, { tmuxServer: 'devdesk', tmuxPane: '%1' }, () => true)).toMatchObject({ state: 'working' });
    expect(await readCardProgramStatus(dir, { tmuxServer: 'devdesk', tmuxPane: '%2' }, () => false)).toBeUndefined();
    expect(await readCardProgramStatus(dir, { tmuxServer: 'devdesk' }, () => true)).toBeUndefined();
  });

  it('reads nothing from a missing directory', async () => {
    expect((await readProgramStatuses(join(tmpdir(), 'devdesk-no-such-dir-xyz'), () => true)).size).toBe(0);
  });
});

describe('the launch command', () => {
  it('puts the relay before the binary, never into a full command', () => {
    const wrapper = programStatusWrapper('python3', '/h/.claude/devdesk/devdesk_status.py', '/h/state/status');
    expect(wrapper).toBe("'python3' -I '/h/.claude/devdesk/devdesk_status.py' '/h/state/status'");
    expect(claudeShellCommand({ args: '--model opus', wrapper }, '--resume x')).toBe(`${wrapper} $HOME/.toolbox/bin/claude --model opus --resume x; exec $SHELL -l`);
    expect(claudeShellCommand({ wrapper: '' })).toBe('$HOME/.toolbox/bin/claude; exec $SHELL -l');
  });
});

const pythonRuns = spawnSync('python3', ['-I', '-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)']).status === 0;

/**
 * A stand-in for Claude, run by the relay in its pseudo-terminal: sends the probe split across two writes, waits for the
 * reply and echoes it in hex, sends reports (one split, then the same again, child records, an over-long body), then
 * exits on input.
 */
const FAKE_CLAUDE = String.raw`
import os, select, sys, termios, time, tty
tty.setraw(0)
def out(b):
    os.write(1, b)
out(b'hello \x1b]75'); time.sleep(0.2); out(b'01;?\x07\x1b[c')
r, _, _ = select.select([0], [], [], 5)
reply = os.read(0, 4096) if r else b''
out(b'REPLY=' + reply.hex().encode() + b'\r\n')
out(b'\x1b]7501;state=work'); time.sleep(0.2); out(b'ing:app=claude-code\x1b\\')
out(b'FIRST\r\n')
time.sleep(0.5)
out(b'\x1b]7501;state=working:app=claude-code\x07')
out(b'\x1b]7501;state=blocked:id=agent-1\x07')
out(b'\x1b]7501;state=blocked:id=agent-2\x07')
out(b'\x1b]7501;state=idle:id=agent-2\x07')
out(b'\x1b]7501;state=idle:app=' + b'a' * 5000 + b'\x07')
out(b'WROTE\r\n')
select.select([0], [], [], 10)
os.read(0, 16)
out(b'BYE\r\n')
`;

describe.skipIf(!pythonRuns)('the relay script (python3)', () => {
  let dir = '';
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = '';
  });

  it('answers the probe, records root reports, passes output through, removes its file at exit', async () => {
    dir = await mkdtemp(join(tmpdir(), 'devdesk-relay-'));
    const script = join(dir, 'devdesk_status.py');
    const fake = join(dir, 'fake_claude.py');
    const file = join(dir, 'status', 'pane.json');
    await writeFile(script, PROGRAM_STATUS_SCRIPT);
    await writeFile(fake, FAKE_CLAUDE);
    const child = spawn('python3', ['-I', script, join(dir, 'status'), 'python3', '-I', fake], {
      env: { ...process.env, DEVDESK_STATUS_FILE: file },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    const seen = (text: string) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${text}; got ${JSON.stringify(output)}`)), 10_000);
        const check = () => {
          if (output.includes(text)) {
            clearTimeout(timer);
            resolve();
          }
        };
        child.stdout.on('data', (d: Buffer) => {
          output += d.toString('latin1');
          check();
        });
        check();
      });
    await seen('FIRST');
    const firstSeen = Date.now();
    await seen('WROTE');
    const reply = Buffer.from('\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\').toString('hex');
    expect(output).toContain(`REPLY=${reply}`);
    // Bytes pass through untouched, the probe included.
    expect(output).toContain('hello \x1b]7501;?\x07\x1b[c');
    const written = parseProgramStatusFile(await readFile(file, 'utf8'));
    expect(written).toMatchObject({ state: 'working', app: 'claude-code', pid: child.pid, blockedChildren: 1 });
    // The repeated report kept the time Claude started working.
    expect(written!.at).toBeLessThanOrEqual(firstSeen);
    const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
    child.stdin.write('q');
    await seen('BYE');
    expect(await exited).toBe(0);
    expect(existsSync(file)).toBe(false);
  }, 20_000);
});
