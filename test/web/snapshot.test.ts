import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionSnapshot, type SnapshotConfig } from '../../src/core/web/snapshot';
import type { HookRecord } from '../../src/core/sessions';
import { fakeTmux, paneLine, processTable } from './fakes';

let tmp: string;
let root: string;
let stateDir: string;
let registryDir: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'web-snapshot-'));
  root = join(tmp, 'repo');
  stateDir = join(tmp, 'state');
  registryDir = join(tmp, 'sessions');
  await mkdir(join(root, '.git'), { recursive: true });
  await mkdir(join(stateDir, 'insights'), { recursive: true });
  await mkdir(registryDir, { recursive: true });
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const NOW = Date.now();
const record = (sessionId: string, over: Partial<HookRecord> = {}): HookRecord => ({
  sessionId,
  pid: 1001,
  tmuxSession: 'cc-main',
  tmuxPane: '%1',
  tmuxServer: 'devdesk',
  cwd: root,
  event: 'PreToolUse',
  state: 'working',
  detail: 'Running Bash',
  updatedAt: NOW - 1000,
  turnStartedAt: NOW - 5000,
  ...over,
});
const writeRecord = (r: HookRecord) => writeFile(join(stateDir, `${r.sessionId}.json`), JSON.stringify(r));

const config = (over: Partial<SnapshotConfig> = {}): SnapshotConfig => ({
  stateDir,
  root,
  scopeDirs: [root],
  scope: 'workspace',
  showAll: false,
  discovery: { claudeWorktrees: false },
  claudeSessionsDirs: [registryDir],
  hooksQuietMs: 120_000,
  insights: true,
  tmux: { bin: 'tmux', server: 'devdesk', options: [], env: {} },
  ...over,
});

/** tmux with `panes` on the devdesk server, Claude (pid 1001, 1002, …) under pane pid 500, 501, …; `alive` pids. */
function deps(panes: string[], alive: number[] = [1001]) {
  const tmux = fakeTmux({ panes });
  const servers: string[] = [];
  return {
    tmux,
    servers,
    deps: {
      tmux: (server: string) => {
        servers.push(server);
        return server === 'devdesk' ? tmux.run : fakeTmux().run;
      },
      listProcesses: async () => processTable([[500, 1, 'zsh'], [1001, 500, 'claude'], [501, 1, 'zsh'], [1002, 501, 'claude'], [502, 1, 'zsh']]),
      alive: (pid: number) => alive.includes(pid),
    },
  };
}

const mainPane = () => paneLine({ session: 'cc-main', pane: '%1', pid: 500, cwd: root });

async function listing(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const name of (await readdir(dir)).sort()) {
    const path = join(dir, name);
    const s = await stat(path);
    out.push(`${name}:${s.size}:${s.mtimeMs}`);
    if (s.isDirectory()) out.push(...(await listing(path)).map((l) => `${name}/${l}`));
  }
  return out;
}

describe('SessionSnapshot', () => {
  it('gives a card for a record in a pane, with its feature', async () => {
    await writeRecord(record('s1'));
    const d = deps([mainPane()]);
    const cards = await new SessionSnapshot(config(), d.deps).cards();
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ id: 's1', state: 'working', tmuxPane: '%1', tmuxSession: 'cc-main', tmuxServer: 'devdesk', featureName: 'main', featureDir: root });
    expect(d.servers).toEqual(['devdesk']);
  });

  it('leaves out a session whose Claude process is gone', async () => {
    await writeRecord(record('s1'));
    const cards = await new SessionSnapshot(config(), deps([mainPane()], []).deps).cards();
    expect(cards.map((c) => c.id)).not.toContain('s1');
  });

  it('leaves out sessions outside the root in workspace scope, keeps them in scope all', async () => {
    await writeRecord(record('s1'));
    await writeRecord(record('far', { pid: 1002, tmuxSession: 'other', tmuxPane: '%2', cwd: '/elsewhere' }));
    const panes = [mainPane(), paneLine({ session: 'other', pane: '%2', pid: 501, cwd: '/elsewhere' })];
    const alive = [1001, 1002];
    expect((await new SessionSnapshot(config(), deps(panes, alive).deps).cards()).map((c) => c.id)).toEqual(['s1']);
    expect((await new SessionSnapshot(config({ scope: 'all' }), deps(panes, alive).deps).cards()).map((c) => c.id).sort()).toEqual(['far', 's1']);
  });

  it('leaves out stopped sessions', async () => {
    const shellOnly = paneLine({ session: 'cc-done', pane: '%3', pid: 502, command: 'zsh', cwd: root });
    const cards = await new SessionSnapshot(config(), deps([shellOnly]).deps).cards();
    expect(cards).toEqual([]);
  });

  it('leaves out sessions on other tmux servers unless it shows all', async () => {
    await writeRecord(record('s1', { tmuxServer: null }));
    const d = deps([]);
    expect(await new SessionSnapshot(config(), d.deps).cards()).toEqual([]);
    const all = deps([]);
    await new SessionSnapshot(config({ showAll: true }), all.deps).cards();
    expect(all.servers.sort()).toEqual(['default', 'devdesk']);
  });

  it("adds Claude's name from the registry", async () => {
    await writeRecord(record('s1'));
    await writeFile(join(registryDir, '1001.json'), JSON.stringify({ pid: 1001, sessionId: 's1', name: 'Fix the build', nameSource: 'user' }));
    const [card] = await new SessionSnapshot(config(), deps([mainPane()]).deps).cards();
    expect(card).toMatchObject({ name: 'Fix the build', nameByUser: true });
  });

  it("reads every Claude account's registry", async () => {
    const work = join(tmp, 'work-sessions');
    await mkdir(work, { recursive: true });
    await writeRecord(record('s1'));
    await writeFile(join(work, '1001.json'), JSON.stringify({ pid: 1001, sessionId: 's1', name: 'Work task', nameSource: 'user' }));
    const [card] = await new SessionSnapshot(config({ claudeSessionsDirs: [registryDir, work] }), deps([mainPane()]).deps).cards();
    expect(card).toMatchObject({ name: 'Work task' });
  });

  it("shows Claude's own report (Program Status) for a session without hooks, and the note Claude set", async () => {
    await mkdir(join(stateDir, 'status'), { recursive: true });
    await mkdir(join(stateDir, 'notes'), { recursive: true });
    await writeFile(join(stateDir, 'status', 'devdesk-1.json'), JSON.stringify({ body: 'state=working:app=claude-code', at: NOW - 100, pid: 1001 }));
    await writeFile(join(stateDir, 'notes', 'devdesk-1.json'), JSON.stringify({ text: 'Waiting on CI', at: NOW - 100 }));
    const cards = await new SessionSnapshot(config(), deps([paneLine({ session: 'cc-main', pane: '%1', pid: 500, command: 'claude', cwd: root })]).deps).cards();
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ state: 'working', tmuxPane: '%1' });
    expect(JSON.stringify(cards[0])).toContain('Waiting on CI');
  });

  it('adds the insight: live status while working, the ask while waiting', async () => {
    const r = record('s1');
    await writeRecord(r);
    await writeFile(join(stateDir, 'insights', 's1.json'), JSON.stringify({ statusFor: r.turnStartedAt, status: 'Editing files', title: 'Build fix' }));
    const snapshot = new SessionSnapshot(config(), deps([mainPane()]).deps);
    expect((await snapshot.cards())[0]).toMatchObject({ liveStatus: 'Editing files', insightTitle: 'Build fix' });

    const waiting = record('s1', { state: 'waiting', detail: 'Needs permission', updatedAt: NOW - 500 });
    await writeRecord(waiting);
    await writeFile(join(stateDir, 'insights', 's1.json'), JSON.stringify({ askFor: waiting.updatedAt, ask: 'May I run rm -rf build?' }));
    expect((await snapshot.cards())[0]).toMatchObject({ state: 'waiting', askSummary: 'May I run rm -rf build?' });
  });

  it('skips insights when they are off', async () => {
    const r = record('s1');
    await writeRecord(r);
    await writeFile(join(stateDir, 'insights', 's1.json'), JSON.stringify({ statusFor: r.turnStartedAt, status: 'Editing files' }));
    const [card] = await new SessionSnapshot(config({ insights: false }), deps([mainPane()]).deps).cards();
    expect(card.liveStatus).toBeUndefined();
  });

  it('never writes into the state dir, even for dead records', async () => {
    await writeRecord(record('s1'));
    await writeRecord(record('dead', { pid: 4242, tmuxPane: '%9' }));
    const before = await listing(stateDir);
    const snapshot = new SessionSnapshot(config(), deps([mainPane()]).deps);
    await snapshot.cards();
    await snapshot.cards();
    await new Promise((r) => setTimeout(r, 50));
    expect(await listing(stateDir)).toEqual(before);
  });

  it('shares one read between calls made at once', async () => {
    await writeRecord(record('s1'));
    const d = deps([mainPane()]);
    const snapshot = new SessionSnapshot(config(), d.deps);
    const [a, b] = await Promise.all([snapshot.cards(), snapshot.cards()]);
    expect(a).toBe(b);
    expect(d.tmux.calls.filter((c) => c[0] === 'list-panes')).toHaveLength(1);
  });

  it('lists the features, main first, and none without a root', async () => {
    const snapshot = new SessionSnapshot(config(), deps([]).deps);
    expect((await snapshot.features()).map((f) => [f.name, f.isMain])).toEqual([['main', true]]);
    expect(await new SessionSnapshot(config({ root: undefined }), deps([]).deps).features()).toEqual([]);
  });

  it('lists the tmux session names', async () => {
    const snapshot = new SessionSnapshot(config(), deps([mainPane(), paneLine({ session: 'cc-main-2', pane: '%4', pid: 9, cwd: root })]).deps);
    expect(await snapshot.sessionNames()).toEqual(['cc-main', 'cc-main-2']);
  });
});
