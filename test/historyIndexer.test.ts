import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { encodeProjectDir } from '../src/core/historyIndex';
import { buildDocs } from '../src/core/historySearch';
import { HistoryIndexer, historyFilePath, UNUSED_INDEX_MS, unusedHistoryFiles } from '../src/historyIndexer';

const user = (id: string, text: string, cwd = '/w/app') => `${JSON.stringify({ type: 'user', sessionId: id, cwd, timestamp: new Date().toISOString(), message: { content: text } })}\n`;

function setup() {
  const base = mkdtempSync(join(tmpdir(), 'hist-'));
  const projects = join(base, 'projects');
  const state = join(base, 'state');
  const dir = (cwd: string) => {
    const d = join(projects, encodeProjectDir(cwd));
    mkdirSync(d, { recursive: true });
    return d;
  };
  const make = (o: Partial<ConstructorParameters<typeof HistoryIndexer>[0]> = {}) =>
    new HistoryIndexer({ enabled: () => true, scope: () => 'workspace', days: () => 90, root: () => '/w/app', projectsDir: () => projects, stateDir: () => state, minIntervalMs: 0, ...o });
  return { base, projects, state, dir, make };
}

describe('HistoryIndexer', () => {
  it('indexes only the newest historyMaxSessions transcripts, and logs what it read and left out', async () => {
    const s = setup();
    const d = s.dir('/w/app');
    for (const [n, age] of [['old', 3], ['mid', 2], ['new', 1]] as const) {
      const path = join(d, `${n}.jsonl`);
      writeFileSync(path, user(n, `${n} work`));
      const t = new Date(Date.now() - age * 60_000);
      utimesSync(path, t, t);
    }
    const lines: string[] = [];
    let tracked = 0;
    const ix = s.make({ maxSessions: () => 2, info: (m) => lines.push(m), track: () => (tracked++, () => tracked--) });
    await ix.refresh();
    expect(ix.entries().map((e) => e.sessionId).sort()).toEqual(['mid', 'new']);
    expect(tracked).toBe(0);
    expect(lines[0]).toMatch(/^history: 2 transcripts for \/w\/app .*2 new or changed .*1 older ones left out \(devdesk.boardSearch.historyMaxSessions 2\)/);
    expect(lines[1]).toMatch(/^history: saved 2 sessions to .* read 2 transcripts, .* heap /);
    lines.length = 0;
    await ix.refresh(true);
    // Nothing to read: a minute's run says nothing.
    expect(lines).toEqual([]);
  });

  it('indexes the workspace transcripts, not other folders, and saves the index', async () => {
    const s = setup();
    writeFileSync(join(s.dir('/w/app'), 'a.jsonl'), user('a', 'fix the parser'));
    writeFileSync(join(s.dir('/w/app/.claude/worktrees/feat'), 'f.jsonl'), user('f', 'feature work', '/w/app/.claude/worktrees/feat'));
    writeFileSync(join(s.dir('/other'), 'o.jsonl'), user('o', 'other repo', '/other'));
    const ix = s.make();
    await ix.refresh();
    expect(ix.entries().map((e) => e.sessionId).sort()).toEqual(['a', 'f']);
    expect(ix.status()).toEqual({ indexed: 2, total: 2, building: false });
    expect(existsSync(historyFilePath(s.state, '/w/app', 'workspace', 90))).toBe(true);
    const again = s.make();
    await again.refresh();
    expect(again.entries().length).toBe(2);
  });

  it.skipIf(process.platform === 'win32')('keeps the index private: the file 0600, its folder 0700', async () => {
    const s = setup();
    writeFileSync(join(s.dir('/w/app'), 'a.jsonl'), user('a', 'secret words'));
    await s.make().refresh();
    const file = historyFilePath(s.state, '/w/app', 'workspace', 90);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(s.state, 'history')).mode & 0o777).toBe(0o700);
  });

  it('records the launch folder of a session whose later records cd into a subfolder', async () => {
    const s = setup();
    const path = join(s.dir('/w/app'), 'a.jsonl');
    writeFileSync(path, user('a', 'start', '/w/app') + user('a', 'in sub', '/w/app/sub'));
    const ix = s.make();
    await ix.refresh();
    expect(ix.entries()[0]).toMatchObject({ startCwd: '/w/app', cwd: '/w/app/sub' });
    appendFileSync(path, user('a', 'deeper', '/w/app/sub/deeper'));
    await ix.refresh(true);
    expect(ix.entries()[0]).toMatchObject({ startCwd: '/w/app', cwd: '/w/app/sub/deeper' });
    const again = s.make();
    await again.refresh();
    expect(again.entries()[0].startCwd).toBe('/w/app');
  });

  it('keeps no text of a sibling folder\'s transcripts (a shared prefix), and does not read them again unchanged', async () => {
    const s = setup();
    writeFileSync(join(s.dir('/w/app'), 'a.jsonl'), user('a', 'mine'));
    const sibling = join(s.dir('/w/app-old'), 'o.jsonl');
    writeFileSync(sibling, user('o', 'sibling words', '/w/app-old'));
    const ix = s.make();
    await ix.refresh();
    expect(ix.entries().map((e) => e.sessionId)).toEqual(['a']);
    expect(ix.status()).toEqual({ indexed: 1, total: 1, building: false });
    const file = historyFilePath(s.state, '/w/app', 'workspace', 90);
    expect(readFileSync(file, 'utf8')).not.toContain('sibling words');
    const past = new Date(Date.now() - 60_000);
    utimesSync(file, past, past);
    await ix.refresh(true);
    expect(statSync(file).mtimeMs).toBe(past.getTime());
    // It moves into the workspace (a later cwd): read again in full.
    appendFileSync(sibling, user('o', 'now here', '/w/app/sub'));
    await ix.refresh(true);
    expect(ix.entries().find((e) => e.sessionId === 'o')?.turns.map((t) => t.text)).toEqual(['sibling words', 'now here']);
  });

  it('indexes a symlinked root by the resolved path Claude records', async () => {
    const s = setup();
    const real = join(s.base, 'real', 'app');
    mkdirSync(real, { recursive: true });
    const link = join(s.base, 'link');
    symlinkSync(join(s.base, 'real'), link);
    const resolved = realpathSync(real);
    writeFileSync(join(s.dir(resolved), 'a.jsonl'), user('a', 'in the real folder', resolved));
    const ix = s.make({ root: () => join(link, 'app') });
    await ix.refresh();
    expect(ix.entries().map((e) => e.sessionId)).toEqual(['a']);
    expect(ix.realRoot).toBe(resolved);
  });

  it('reads only what was appended, and a partial last line once it is complete', async () => {
    const s = setup();
    const path = join(s.dir('/w/app'), 'a.jsonl');
    const second = user('a', 'second prompt');
    writeFileSync(path, user('a', 'first prompt') + second.slice(0, 20));
    const ix = s.make();
    await ix.refresh();
    expect(ix.entries()[0].turns.map((t) => t.text)).toEqual(['first prompt']);
    appendFileSync(path, second.slice(20));
    await ix.refresh(true);
    expect(ix.entries()[0].turns.map((t) => t.text)).toEqual(['first prompt', 'second prompt']);
  });

  it('gives a grown transcript a new entry and leaves the previous one as it was (cached docs see the change)', async () => {
    const s = setup();
    const path = join(s.dir('/w/app'), 'a.jsonl');
    writeFileSync(path, user('a', 'first prompt'));
    const ix = s.make();
    await ix.refresh();
    const [before] = ix.entries();
    appendFileSync(path, user('a', 'second prompt'));
    await ix.refresh(true);
    const [after] = ix.entries();
    expect(after).not.toBe(before);
    expect(before.turns.map((t) => t.text)).toEqual(['first prompt']);
    expect(after.turns.map((t) => t.text)).toEqual(['first prompt', 'second prompt']);
  });

  it('keeps the saved entry when a transcript cannot be read for a moment, and drops it once it is gone', async () => {
    const s = setup();
    const path = join(s.dir('/w/app'), 'a.jsonl');
    writeFileSync(path, user('a', 'first prompt'));
    const warnings: string[] = [];
    const ix = s.make({ warn: (m) => warnings.push(m) });
    await ix.refresh();
    appendFileSync(path, user('a', 'second prompt'));
    chmodSync(path, 0o000);
    try {
      await ix.refresh(true);
    } finally {
      chmodSync(path, 0o644);
    }
    expect(warnings.length).toBe(1);
    expect(ix.entries().map((e) => e.turns.map((t) => t.text))).toEqual([['first prompt']]);
    await ix.refresh(true);
    expect(ix.entries().map((e) => e.turns.length)).toEqual([2]);
    rmSync(path);
    await ix.refresh(true);
    expect(ix.entries()).toEqual([]);
  });

  it('reads a transcript again from the start when it shrank or was rewritten in place', async () => {
    const s = setup();
    const path = join(s.dir('/w/app'), 'a.jsonl');
    writeFileSync(path, user('a', 'old one') + user('a', 'old two'));
    const ix = s.make();
    await ix.refresh();
    writeFileSync(path, user('a', 'new 1'));
    await ix.refresh(true);
    expect(ix.entries()[0].turns.map((t) => t.text)).toEqual(['new 1']);
    const same = user('a', 'XXX one') + user('a', 'old two');
    writeFileSync(path, same.replace('XXX', 'new'));
    utimesSync(path, new Date(), new Date(Date.now() + 5000));
    await ix.refresh(true);
    expect(ix.entries()[0].turns.map((t) => t.text)).toEqual(['new one', 'old two']);
  });

  it('skips transcripts older than historyDays and drops ones that disappeared', async () => {
    const s = setup();
    const old = join(s.dir('/w/app'), 'old.jsonl');
    writeFileSync(old, user('old', 'ancient'));
    const past = new Date(Date.now() - 100 * 86_400_000);
    utimesSync(old, past, past);
    writeFileSync(join(s.dir('/w/app'), 'new.jsonl'), user('new', 'fresh'));
    const ix = s.make();
    await ix.refresh();
    expect(ix.entries().map((e) => e.sessionId)).toEqual(['new']);
  });

  it('survives garbage, a huge line and an unreadable file', async () => {
    const s = setup();
    writeFileSync(join(s.dir('/w/app'), 'bad.jsonl'), `garbage\n${'{"x":"'}${'y'.repeat(3 * 1024 * 1024)}"}\n${user('bad', 'still here')}`);
    mkdirSync(join(s.dir('/w/app'), 'dir.jsonl'));
    const ix = s.make();
    await ix.refresh();
    expect(ix.entries().map((e) => e.turns.map((t) => t.text))).toEqual([['still here']]);
  });

  it('lets one window index: a fresh lock means another window does it; a stale one is taken over', async () => {
    const s = setup();
    writeFileSync(join(s.dir('/w/app'), 'a.jsonl'), user('a', 'x'));
    const file = historyFilePath(s.state, '/w/app', 'workspace', 90);
    mkdirSync(join(s.state, 'history'), { recursive: true });
    writeFileSync(`${file}.lock`, '');
    const ix = s.make();
    await ix.refresh();
    expect(ix.entries()).toEqual([]);
    const stale = new Date(Date.now() - 10 * 60_000);
    utimesSync(`${file}.lock`, stale, stale);
    await ix.refresh(true);
    expect(ix.entries().length).toBe(1);
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  it('is empty when off, and has no workspace scope without a root', async () => {
    const s = setup();
    writeFileSync(join(s.dir('/w/app'), 'a.jsonl'), user('a', 'x'));
    const off = s.make({ enabled: () => false });
    await off.refresh();
    expect(off.entries()).toEqual([]);
    const noRoot = s.make({ root: () => undefined });
    await noRoot.refresh();
    expect(noRoot.entries()).toEqual([]);
  });

  it('shares a refresh in flight and waits minIntervalMs between refreshes', async () => {
    const s = setup();
    writeFileSync(join(s.dir('/w/app'), 'a.jsonl'), user('a', 'x'));
    const ix = s.make({ minIntervalMs: 60_000 });
    await Promise.all([ix.refresh(), ix.refresh()]);
    appendFileSync(join(s.dir('/w/app'), 'a.jsonl'), user('a', 'y'));
    await ix.refresh();
    expect(ix.entries()[0].turns.length).toBe(1);
    await ix.refresh(true);
    expect(ix.entries()[0].turns.length).toBe(2);
    expect(JSON.parse(readFileSync(historyFilePath(s.state, '/w/app', 'workspace', 90), 'utf8')).version).toBe(1);
  });

  it('runs again when the settings change during a run (days lowered, scope switched)', async () => {
    const s = setup();
    const old = join(s.dir('/w/app'), 'old.jsonl');
    writeFileSync(old, user('old', 'ten days ago'));
    const past = new Date(Date.now() - 10 * 86_400_000);
    utimesSync(old, past, past);
    writeFileSync(join(s.dir('/w/app'), 'new.jsonl'), user('new', 'today'));
    writeFileSync(join(s.dir('/other'), 'o.jsonl'), user('o', 'elsewhere', '/other'));
    let days = 90;
    let scope: 'workspace' | 'all' = 'workspace';
    const ix = s.make({ days: () => days, scope: () => scope, minIntervalMs: 60_000 });
    let step = 0;
    ix.onDidChange(() => {
      if (!ix.status().building) return;
      step++;
      if (step === 1) days = 5; // while the first run reads
    });
    await ix.refresh();
    expect(ix.entries().map((e) => e.sessionId)).toEqual(['new']);
    const running = ix.refresh(true);
    scope = 'all';
    await running;
    expect(ix.entries().map((e) => e.sessionId).sort()).toEqual(['new', 'o']);
  });

  it('reads a transcript appended to while it is read up to the size listed, and the rest next time', async () => {
    const s = setup();
    const path = join(s.dir('/w/app'), 'a.jsonl');
    const big = 'x'.repeat(1024 * 1024);
    writeFileSync(path, user('a', 'first') + user('a', big) + user('a', 'last before'));
    const ix = s.make();
    let appended = false;
    ix.onDidChange(() => {
      // Listed and building: the transcript grows between its chunks.
      if (ix.status().building && !appended) {
        appended = true;
        appendFileSync(path, user('a', 'during the read'));
      }
    });
    await ix.refresh();
    expect(appended).toBe(true);
    expect(ix.entries()[0].turns.map((t) => t.text.slice(0, 20))).toEqual(['first', 'x'.repeat(16 * 1024).slice(0, 20), 'last before']);
    await ix.refresh(true);
    expect(ix.entries()[0].turns.map((t) => t.text).at(-1)).toBe('during the read');
    expect(ix.entries()[0].turns.length).toBe(4);
  });

  it('two indexers on one state dir at the same moment: one indexes, the other reads what it saved next time', async () => {
    const s = setup();
    for (let i = 0; i < 5; i++) writeFileSync(join(s.dir('/w/app'), `f${i}.jsonl`), user(`f${i}`, 'x'));
    const a = s.make();
    const b = s.make();
    await Promise.all([a.refresh(), b.refresh()]);
    const counts = [a.entries().length, b.entries().length].sort();
    expect(counts).toEqual([0, 5]);
    const file = historyFilePath(s.state, '/w/app', 'workspace', 90);
    expect(existsSync(`${file}.lock`)).toBe(false);
    expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')).transcripts).length).toBe(5);
    await Promise.all([a.refresh(true), b.refresh(true)]);
    expect([a.entries().length, b.entries().length]).toEqual([5, 5]);
  });

  it('rebuilds an index file that was truncated, hand-edited to bad JSON, or of another version', async () => {
    const s = setup();
    writeFileSync(join(s.dir('/w/app'), 'a.jsonl'), user('a', 'kept'));
    const file = historyFilePath(s.state, '/w/app', 'workspace', 90);
    await s.make().refresh();
    const good = readFileSync(file, 'utf8');
    for (const bad of [good.slice(0, good.length / 2), '{"version": 1, "transcripts": [}', JSON.stringify({ ...JSON.parse(good), version: 2 })]) {
      writeFileSync(file, bad);
      const ix = s.make();
      await ix.refresh();
      expect(ix.entries().map((e) => e.turns[0]?.text)).toEqual(['kept']);
      expect(JSON.parse(readFileSync(file, 'utf8')).version).toBe(1);
    }
  });

  it('switches between the workspace index and the all-folders one, and back', async () => {
    const s = setup();
    writeFileSync(join(s.dir('/w/app'), 'a.jsonl'), user('a', 'x'));
    writeFileSync(join(s.dir('/other'), 'o.jsonl'), user('o', 'y', '/other'));
    let scope: 'workspace' | 'all' = 'workspace';
    const ix = s.make({ scope: () => scope });
    await ix.refresh();
    expect(ix.entries().map((e) => e.sessionId)).toEqual(['a']);
    scope = 'all';
    await ix.refresh(true);
    expect(ix.entries().map((e) => e.sessionId).sort()).toEqual(['a', 'o']);
    scope = 'workspace';
    await ix.refresh(true);
    expect(ix.entries().map((e) => e.sessionId)).toEqual(['a']);
    expect(existsSync(historyFilePath(s.state, undefined, 'all', 90))).toBe(true);
  });

  it('keeps one all-folders index per historyDays, so windows with different days do not drop each other\'s transcripts', async () => {
    const s = setup();
    writeFileSync(join(s.dir('/w/app'), 'new.jsonl'), user('new', 'x'));
    const old = join(s.dir('/other'), 'old.jsonl');
    writeFileSync(old, user('old', 'y', '/other'));
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000);
    utimesSync(old, tenDaysAgo, tenDaysAgo);
    await s.make({ scope: () => 'all', days: () => 90 }).refresh();
    await s.make({ scope: () => 'all', days: () => 7 }).refresh();
    expect(historyFilePath(s.state, undefined, 'all', 7)).not.toBe(historyFilePath(s.state, undefined, 'all', 90));
    const wide = JSON.parse(readFileSync(historyFilePath(s.state, undefined, 'all', 90), 'utf8')) as { transcripts: Record<string, unknown> };
    expect(Object.keys(wide.transcripts)).toContain(old);
    const narrow = JSON.parse(readFileSync(historyFilePath(s.state, undefined, 'all', 7), 'utf8')) as { transcripts: Record<string, unknown> };
    expect(Object.keys(narrow.transcripts)).not.toContain(old);
  });

  it('names the transcript an entry was read from', async () => {
    const s = setup();
    const path = join(s.dir('/w/app'), 'a.jsonl');
    writeFileSync(path, user('a', 'x'));
    const ix = s.make();
    await ix.refresh();
    expect(ix.transcripts().find((t) => t.entry === ix.entries()[0])?.path).toBe(path);
    const copy = { ...ix.entries()[0] };
    expect(ix.transcripts().find((t) => t.entry === copy)).toBeUndefined();
  });

  it('bumps its revision when the index is replaced, not when a refresh finds nothing new', async () => {
    const s = setup();
    const path = join(s.dir('/w/app'), 'a.jsonl');
    writeFileSync(path, user('a', 'x'));
    const ix = s.make();
    await ix.refresh();
    const first = ix.revision;
    await ix.refresh(true);
    expect(ix.revision).toBe(first);
    appendFileSync(path, user('a', 'y'));
    await ix.refresh(true);
    expect(ix.revision).toBeGreaterThan(first);
  });

  it('a new revision rebuilds the docs, folding again only the transcript that changed', async () => {
    const s = setup();
    const a = join(s.dir('/w/app'), 'a.jsonl');
    writeFileSync(a, user('a', 'alpha'));
    writeFileSync(join(s.dir('/w/app'), 'b.jsonl'), user('b', 'beta'));
    const ix = s.make();
    await ix.refresh();
    const build = () => buildDocs(ix.transcripts(), { root: '/w/app', scope: 'workspace', worktreeOf: () => 'main' });
    const byId = (docs: ReturnType<typeof build>) => new Map(docs.map((d) => [d.id, d]));
    const before = byId(build());
    const revision = ix.revision;
    appendFileSync(a, user('a', 'gamma'));
    await ix.refresh(true);
    expect(ix.revision).not.toBe(revision);
    const after = byId(build());
    expect(after.get('b')!.fields).toBe(before.get('b')!.fields);
    expect(after.get('a')!.fields).not.toBe(before.get('a')!.fields);
    expect(after.get('a')!.fields.prompts).toBe('alpha gamma');
  });

  it('lets go of the index on release and loads it again on the next refresh, even within minIntervalMs', async () => {
    const s = setup();
    writeFileSync(join(s.dir('/w/app'), 'a.jsonl'), user('a', 'x'));
    const ix = s.make({ minIntervalMs: 60_000 });
    await ix.refresh();
    expect(ix.entries().length).toBe(1);
    const revision = ix.revision;
    ix.release();
    expect(ix.entries()).toEqual([]);
    expect(ix.revision).toBeGreaterThan(revision);
    await ix.refresh();
    expect(ix.entries().map((e) => e.turns[0].text)).toEqual(['x']);
  });

  it('released during a run: still saves what it read, but does not keep it in memory', async () => {
    const s = setup();
    for (let i = 0; i < 6; i++) writeFileSync(join(s.dir('/w/app'), `f${i}.jsonl`), user(`f${i}`, 'x'));
    const ix = s.make();
    let released = false;
    ix.onDidChange(() => {
      if (!released) ix.release(); // building started: the board closed
      released = true;
    });
    await ix.refresh();
    expect(ix.entries()).toEqual([]);
    const file = historyFilePath(s.state, '/w/app', 'workspace', 90);
    expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')).transcripts).length).toBe(6);
    await ix.refresh();
    expect(ix.entries().length).toBe(6);
  });

  it('does not rewrite the index file when nothing changed', async () => {
    const s = setup();
    writeFileSync(join(s.dir('/w/app'), 'a.jsonl'), user('a', 'x'));
    const ix = s.make();
    await ix.refresh();
    const file = historyFilePath(s.state, '/w/app', 'workspace', 90);
    const past = new Date(Date.now() - 60_000);
    utimesSync(file, past, past);
    const mtime = statSync(file).mtimeMs;
    await ix.refresh(true);
    expect(statSync(file).mtimeMs).toBe(mtime);
    appendFileSync(join(s.dir('/w/app'), 'a.jsonl'), user('a', 'y'));
    await ix.refresh(true);
    expect(statSync(file).mtimeMs).not.toBe(mtime);
  });

  it('keeps its lock fresh during a run and removes only a lock that still holds its token', async () => {
    const s = setup();
    for (let i = 0; i < 20; i++) writeFileSync(join(s.dir('/w/app'), `f${i}.jsonl`), user(`f${i}`, 'x'));
    const lock = `${historyFilePath(s.state, '/w/app', 'workspace', 90)}.lock`;
    const ix = s.make();
    const old = new Date(Date.now() - 10 * 60_000);
    let emits = 0;
    let touched = false;
    ix.onDidChange(() => {
      emits++;
      if (emits === 2) utimesSync(lock, old, old); // building started; the lock goes stale
      if (emits === 3) {
        // 10 files later the run has refreshed it
        touched = Date.now() - statSync(lock).mtimeMs < 60_000;
        writeFileSync(lock, 'another window');
      }
    });
    await ix.refresh();
    expect(touched).toBe(true);
    expect(readFileSync(lock, 'utf8')).toBe('another window');
  });

  it('keeps the previous index when disposed during a run', async () => {
    const s = setup();
    for (let i = 0; i < 6; i++) writeFileSync(join(s.dir('/w/app'), `f${i}.jsonl`), user(`f${i}`, 'x'));
    await s.make().refresh();
    const file = historyFilePath(s.state, '/w/app', 'workspace', 90);
    const before = readFileSync(file, 'utf8');
    for (let i = 0; i < 6; i++) appendFileSync(join(s.dir('/w/app'), `f${i}.jsonl`), user(`f${i}`, 'y'));
    const ix = s.make();
    ix.onDidChange(() => ix.dispose());
    await ix.refresh();
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('picks unused index files, left-over temporary files and locks to remove, never the one in use', () => {
    const now = 100 * UNUSED_INDEX_MS;
    const old = now - UNUSED_INDEX_MS;
    const files = [
      { name: 'mine.json', mtimeMs: 0 },
      { name: 'mine.json.lock', mtimeMs: 0 },
      { name: 'other.json', mtimeMs: old },
      { name: 'recent.json', mtimeMs: now - 1000 },
      { name: 'all-90d.json', mtimeMs: old - 1 },
      { name: 'x.json.123.tmp', mtimeMs: now - 2 * 86_400_000 },
      { name: 'y.json.123.tmp', mtimeMs: now - 1000 },
      { name: 'z.json.lock', mtimeMs: now - 2 * 86_400_000 },
      { name: 'notes.txt', mtimeMs: 0 },
    ];
    expect(unusedHistoryFiles(files, 'mine.json', now).sort()).toEqual(['all-90d.json', 'other.json', 'x.json.123.tmp', 'z.json.lock']);
  });

  it('removes index files no window has written for a while, but not one another window is writing', async () => {
    const s = setup();
    writeFileSync(join(s.dir('/w/app'), 'a.jsonl'), user('a', 'x'));
    const history = join(s.state, 'history');
    mkdirSync(history, { recursive: true });
    const old = new Date(Date.now() - UNUSED_INDEX_MS - 60_000);
    const unused = join(history, 'unused.json');
    const busy = join(history, 'busy.json');
    const recent = join(history, 'recent.json');
    for (const f of [unused, busy, recent]) writeFileSync(f, '{}');
    for (const f of [unused, busy]) utimesSync(f, old, old);
    writeFileSync(`${busy}.lock`, 'another window');
    const lines: string[] = [];
    const ix = s.make({ info: (m) => lines.push(m) });
    await ix.refresh();
    expect(existsSync(unused)).toBe(false);
    expect(existsSync(busy)).toBe(true);
    expect(existsSync(recent)).toBe(true);
    expect(existsSync(historyFilePath(s.state, '/w/app', 'workspace', 90))).toBe(true);
    expect(lines.some((l) => l.includes(`removed ${unused}`))).toBe(true);
    // Once a day: a second run leaves a newly unused file alone.
    writeFileSync(unused, '{}');
    utimesSync(unused, old, old);
    await ix.refresh(true);
    expect(existsSync(unused)).toBe(true);
  });

  it('does not clean up while another window holds its own index lock', async () => {
    const s = setup();
    writeFileSync(join(s.dir('/w/app'), 'a.jsonl'), user('a', 'x'));
    const history = join(s.state, 'history');
    mkdirSync(history, { recursive: true });
    const unused = join(history, 'unused.json');
    writeFileSync(unused, '{}');
    const old = new Date(Date.now() - UNUSED_INDEX_MS - 60_000);
    utimesSync(unused, old, old);
    writeFileSync(`${historyFilePath(s.state, '/w/app', 'workspace', 90)}.lock`, 'another window');
    await s.make().refresh();
    expect(existsSync(unused)).toBe(true);
  });

  it('shows the saved entries again when history is turned off and on', async () => {
    const s = setup();
    writeFileSync(join(s.dir('/w/app'), 'a.jsonl'), user('a', 'x'));
    let on = true;
    const ix = s.make({ enabled: () => on });
    await ix.refresh();
    on = false;
    await ix.refresh(true);
    expect(ix.entries()).toEqual([]);
    on = true;
    const file = historyFilePath(s.state, '/w/app', 'workspace', 90);
    writeFileSync(`${file}.lock`, ''); // another window indexes: we only read what it saved
    await ix.refresh(true);
    expect(ix.entries().length).toBe(1);
  });
});

// Wall-clock timings and sizes: run alone (`npm run test:perf`).
describe.skipIf(!process.env.DEVDESK_PERF)('HistoryIndexer performance', () => {
  it('indexes 1000 transcripts and a 200 MB one, keeps the index file small, and refreshes fast when nothing changed', async () => {
    const s = setup();
    const d = s.dir('/w/app');
    const words = 'lorem ipsum dolor sit amet consectetur adipiscing elit '.repeat(18);
    const reply = (text: string) => `${JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { content: [{ type: 'text', text }] } })}\n`;
    for (let i = 0; i < 1000; i++) {
      const lines: string[] = [];
      for (let k = 0; k < 70; k++) lines.push(k % 2 ? reply(`${words} ${i}-${k}`) : user(`s${i}`, `${words} ${i}-${k}`));
      writeFileSync(join(d, `s${i}.jsonl`), lines.join(''));
    }
    const big = join(d, 'big.jsonl');
    const block = Array.from({ length: 2000 }, (_, k) => (k % 2 ? reply(words) : user('big', words))).join('');
    writeFileSync(big, '');
    while (statSync(big).size < 200 * 1024 * 1024) appendFileSync(big, block);
    const ix = s.make();
    const t0 = performance.now();
    await ix.refresh();
    const t1 = performance.now();
    await ix.refresh(true);
    const t2 = performance.now();
    const size = statSync(historyFilePath(s.state, '/w/app', 'workspace', 90)).size;
    console.log(`first index ${(t1 - t0).toFixed(0)} ms, unchanged refresh ${(t2 - t1).toFixed(0)} ms, index file ${(size / 1024 / 1024).toFixed(1)} MB, heap ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(0)} MB`);
    expect(ix.entries().length).toBe(1001);
    expect(ix.entries().find((e) => e.sessionId === 'big')!.chars).toBeLessThanOrEqual(64 * 1024);
    expect(size).toBeLessThan(1001 * 70 * 1024);
    expect(t2 - t1).toBeLessThan(2000);
  }, 300_000);
});
