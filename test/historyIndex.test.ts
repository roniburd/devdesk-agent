import { describe, expect, it } from 'vitest';
import {
  applyLine,
  emptyEntry,
  encodeProjectDir,
  ENTRY_TEXT_MAX,
  entryInScope,
  entryTitle,
  HEAD_TEXT_MAX,
  HistoryScan,
  launchCwd,
  LINE_MAX,
  parseHistoryFile,
  projectDirsInScope,
} from '../src/core/historyIndex';

const at = (s: number) => new Date(Date.UTC(2026, 10, 1, 0, 0, s)).toISOString();
const user = (text: unknown, o: Record<string, unknown> = {}) => JSON.stringify({ type: 'user', sessionId: 's1', cwd: '/w/app', timestamp: at(1), message: { content: text }, ...o });
const claude = (content: unknown[], o: Record<string, unknown> = {}) => JSON.stringify({ type: 'assistant', timestamp: at(2), message: { content }, ...o });

function scan(lines: string[]) {
  const s = new HistoryScan();
  s.feed(`${lines.join('\n')}\n`);
  return s.entry;
}

describe('applyLine', () => {
  it('keeps prompts, text replies, files edited and tool names; skips meta, tool results, thinking and sidechains', () => {
    const e = scan([
      user('Fix the parser test'),
      user('meta', { isMeta: true }),
      user([{ type: 'tool_result', content: 'big output' }]),
      claude([{ type: 'thinking', thinking: 'secret' }, { type: 'text', text: 'Looking at it.' }, { type: 'tool_use', name: 'Edit', input: { file_path: '/w/app/src/parser.ts' } }]),
      claude([{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }]),
      claude([{ type: 'tool_use', name: 'NotebookEdit', input: { notebook_path: '/w/app/n.ipynb' } }]),
      claude([{ type: 'text', text: 'subagent text' }], { isSidechain: true }),
      user('subagent prompt', { isSidechain: true }),
    ]);
    expect(e.turns).toEqual([
      { role: 'user', text: 'Fix the parser test' },
      { role: 'claude', text: 'Looking at it.' },
    ]);
    expect(e.files).toEqual(['/w/app/src/parser.ts', '/w/app/n.ipynb']);
    expect(e.tools).toEqual(['Edit', 'Bash', 'NotebookEdit']);
    expect(e.sessionId).toBe('s1');
    expect(e.cwd).toBe('/w/app');
    expect(e.firstAt).toBe(Date.parse(at(1)));
    expect(e.lastAt).toBe(Date.parse(at(2)));
  });

  it('reads titles and the recap', () => {
    const e = scan([
      user('first prompt'),
      JSON.stringify({ type: 'ai-title', aiTitle: 'Parser fix' }),
      JSON.stringify({ type: 'custom-title', customTitle: 'My parser work' }),
      JSON.stringify({ type: 'system', subtype: 'away_summary', content: 'Fixed and released.' }),
    ]);
    expect(e.aiTitle).toBe('Parser fix');
    expect(e.customTitle).toBe('My parser work');
    expect(e.recap).toBe('Fixed and released.');
    expect(entryTitle(e)).toBe('My parser work');
    expect(entryTitle(scan([user('x'.repeat(200))])).length).toBeLessThanOrEqual(80);
    expect(entryTitle(emptyEntry())).toBe('(untitled session)');
  });

  it('keeps the first 16 KB and the latest text within 64 KB; cuts one huge turn', () => {
    const e = emptyEntry();
    for (let i = 0; i < 200; i++) applyLine(e, user(`turn ${i} ${'x'.repeat(1000)}`));
    expect(e.chars).toBeLessThanOrEqual(ENTRY_TEXT_MAX);
    expect(e.turns[0].text.startsWith('turn 0 ')).toBe(true);
    expect(e.turns.at(-1)!.text.startsWith('turn 199 ')).toBe(true);
    expect(e.turns.slice(0, e.head).reduce((n, t) => n + t.text.length, 0)).toBeLessThanOrEqual(HEAD_TEXT_MAX);
    expect(e.turns.some((t) => t.text.startsWith('turn 100 '))).toBe(false);
    const big = emptyEntry();
    applyLine(big, user('y'.repeat(100_000)));
    expect(big.turns[0].text.length).toBe(16 * 1024);
  });

  it('skips non-JSON lines and lines longer than LINE_MAX without parsing them', () => {
    const e = scan(['not json {', `{"type":"user","message":{"content":"${'z'.repeat(LINE_MAX)}"}}`, '\u0000\u0001garbage']);
    expect(e.turns).toEqual([]);
  });

  it('keeps at most 50 files and 30 tool names, without repeats, the latest ones', () => {
    const e = emptyEntry();
    for (let i = 0; i < 60; i++) applyLine(e, claude([{ type: 'tool_use', name: 'Edit', input: { file_path: `/f${i}` } }, { type: 'tool_use', name: `T${i % 40}`, input: {} }]));
    applyLine(e, claude([{ type: 'tool_use', name: 'Write', input: { file_path: '/f59' } }]));
    expect(e.files.length).toBe(50);
    expect(e.files.at(-1)).toBe('/f59');
    expect(new Set(e.files).size).toBe(50);
    expect(e.tools.length).toBe(30);
  });
});

describe('HistoryScan', () => {
  it('records the launch folder: the cwd matching its projects folder, else the first; the last cwd stays cwd', () => {
    const lines = (cwds: string[]) => `${cwds.map((cwd, i) => user(`p${i}`, { cwd })).join('\n')}\n`;
    const s = new HistoryScan(undefined, 0, encodeProjectDir('/w/app'));
    s.feed(lines(['/w/app/sub', '/w/app', '/w/app/sub/deeper']));
    expect(s.entry.startCwd).toBe('/w/app');
    expect(s.entry.cwd).toBe('/w/app/sub/deeper');
    expect(launchCwd(s.entry)).toBe('/w/app');
    const other = new HistoryScan(undefined, 0, '-somewhere-else');
    other.feed(lines(['/w/app/a', '/w/app/b']));
    expect(other.entry.startCwd).toBe('/w/app/a');
    // Resumed, the folder still decides.
    const first = new HistoryScan(undefined, 0, encodeProjectDir('/w/app'));
    first.feed(lines(['/w/app/sub']));
    const again = HistoryScan.resume({ size: 0, mtimeMs: 0, offset: first.settled, mark: '', entry: first.entry }, encodeProjectDir('/w/app'));
    again.feed(lines(['/w/app']));
    expect(again.entry.startCwd).toBe('/w/app');
    // An old index file's entry has no startCwd: its cwd it is.
    expect(launchCwd({ ...emptyEntry(), cwd: '/w/app/x' })).toBe('/w/app/x');
  });

  it('settles at the end of the last complete line and resumes from a saved entry', () => {
    const s = new HistoryScan();
    s.feed(`${user('one')}\n${user('two').slice(0, 10)}`);
    expect(s.entry.turns.length).toBe(1);
    expect(s.settled).toBe(user('one').length + 1);
    const again = new HistoryScan(s.entry, s.settled);
    again.feed(`${user('two')}\n`);
    expect(again.entry.turns.map((t) => t.text)).toEqual(['one', 'two']);
    expect(again.offset).toBe(s.settled + user('two').length + 1);
  });

  it('does not buffer a line longer than LINE_MAX across chunks (it is skipped anyway), and reads the next one', () => {
    const s = new HistoryScan();
    s.feed(`${user('before')}\n`);
    const mb = Buffer.alloc(1024 * 1024, 'a');
    for (let i = 0; i < 4; i++) s.feed(mb);
    // Past the long line's start: nothing of it waits in memory, and a resume would not read it again.
    expect(s.settled).toBeGreaterThan(user('before').length + 1 + LINE_MAX);
    s.feed(mb);
    s.feed(`tail"}\n${user('after')}\n`);
    expect(s.entry.turns.map((t) => t.text)).toEqual(['before', 'after']);
  });

  it('resumes a saved transcript on a copy of its entry, leaving the saved one as it was', () => {
    const s = new HistoryScan();
    s.feed(`${user('one')}\n${claude([{ type: 'tool_use', name: 'Edit', input: { file_path: '/a' } }])}\n`);
    const saved = { size: s.offset, mtimeMs: 0, offset: s.settled, mark: '', entry: s.entry };
    const before = structuredClone(saved.entry);
    const again = HistoryScan.resume(saved);
    again.feed(`${user('two')}\n${claude([{ type: 'tool_use', name: 'Write', input: { file_path: '/b' } }])}\n`);
    expect(again.offset).toBe(saved.offset + Buffer.byteLength(`${user('two')}\n${claude([{ type: 'tool_use', name: 'Write', input: { file_path: '/b' } }])}\n`));
    expect(again.entry.turns.map((t) => t.text)).toEqual(['one', 'two']);
    expect(again.entry.files).toEqual(['/a', '/b']);
    expect(again.entry.tools).toEqual(['Edit', 'Write']);
    expect(saved.entry).toEqual(before);
  });

  it('measures LINE_MAX in bytes, before decoding: a complete line of multi-byte text over it is skipped', () => {
    const s = new HistoryScan();
    const wide = user('é'.repeat(LINE_MAX / 2 + 10)); // fewer characters than LINE_MAX, more bytes
    expect(wide.length).toBeLessThan(LINE_MAX);
    s.feed(`${user('before')}\n${wide}\n${user('after')}\n`);
    expect(s.entry.turns.map((t) => t.text)).toEqual(['before', 'after']);
    expect(s.offset).toBe(Buffer.byteLength(`${user('before')}\n${wide}\n${user('after')}\n`));
  });

  it('settles before a line whose chunk ends mid UTF-8 character, and reads it whole when resumed', () => {
    const line = Buffer.from(`${user('café ☕ done')}\n`);
    const cut = line.indexOf(Buffer.from('☕')) + 1; // inside the 3-byte character
    const s = new HistoryScan();
    s.feed(Buffer.from(`${user('one')}\n`));
    s.feed(line.subarray(0, cut));
    expect(s.settled).toBe(user('one').length + 1);
    const again = new HistoryScan(s.entry, s.settled);
    again.feed(line);
    expect(again.entry.turns.map((t) => t.text)).toEqual(['one', 'café ☕ done']);
  });
});

describe('scope', () => {
  it('encodes folders as Claude does', () => {
    expect(encodeProjectDir('/Users/me/dev/my.app_x y')).toBe('-Users-me-dev-my-app-x-y');
  });

  it('picks the workspace folder and its worktrees, or every folder', () => {
    const names = ['-w-app', '-w-app--claude-worktrees-feat', '-w-app-worktrees-b', '-w-app-old', '-other'];
    expect(projectDirsInScope(names, '/w/app', 'workspace')).toEqual(['-w-app', '-w-app--claude-worktrees-feat', '-w-app-worktrees-b', '-w-app-old']);
    expect(projectDirsInScope(names, '/w/app', 'all')).toEqual(names);
    expect(projectDirsInScope(names, undefined, 'workspace')).toEqual([]);
  });

  it('keeps an entry only when its cwd is the root or below it (a shared prefix is not enough)', () => {
    const e = (cwd?: string) => ({ ...emptyEntry(), cwd });
    expect(entryInScope(e('/w/app'), '/w/app', 'workspace')).toBe(true);
    expect(entryInScope(e('/w/app/.claude/worktrees/feat'), '/w/app', 'workspace')).toBe(true);
    expect(entryInScope(e('/w/app-old'), '/w/app', 'workspace')).toBe(false);
    expect(entryInScope(e(undefined), '/w/app', 'workspace')).toBe(false);
    expect(entryInScope(e('/elsewhere'), '/w/app', 'all')).toBe(true);
    // Launched in the workspace, then cd'd out of it (or the other way round): still the workspace's.
    expect(entryInScope({ ...e('/tmp'), startCwd: '/w/app' }, '/w/app', 'workspace')).toBe(true);
    expect(entryInScope({ ...e('/w/app/sub'), startCwd: '/elsewhere' }, '/w/app', 'workspace')).toBe(true);
  });

  it('reads a root with a trailing slash as the folder, and a symlinked root by its resolved path too', () => {
    const names = ['-w-app', '-w-app-old', '-real-app', '-real-app--claude-worktrees-f', '-other'];
    expect(projectDirsInScope(names, '/w/app/', 'workspace')).toEqual(['-w-app', '-w-app-old']);
    expect(projectDirsInScope(names, '/w/app', 'workspace', '/real/app')).toEqual(['-w-app', '-w-app-old', '-real-app', '-real-app--claude-worktrees-f']);
    const e = (cwd?: string) => ({ ...emptyEntry(), cwd });
    expect(entryInScope(e('/w/app/sub'), '/w/app/', 'workspace')).toBe(true);
    expect(entryInScope(e('/real/app/.claude/worktrees/f'), '/w/app', 'workspace', '/real/app')).toBe(true);
    expect(entryInScope(e('/real/app-old'), '/w/app', 'workspace', '/real/app')).toBe(false);
  });
});

describe('parseHistoryFile', () => {
  it('reads a saved file and treats anything else as empty', () => {
    const file = { version: 1, transcripts: { '/p/a.jsonl': { size: 10, mtimeMs: 5, offset: 10, mark: 'ab', entry: emptyEntry() } } };
    expect(parseHistoryFile(JSON.stringify(file))).toEqual(file);
    for (const bad of ['', 'nope', '{"version":2,"transcripts":{}}', '{"version":1}', '{"version":1,"transcripts":{"x":{"size":"1"}}}']) {
      expect(parseHistoryFile(bad).transcripts).toEqual({});
    }
  });

  it('drops hand-edited elements and fields of the wrong type instead of keeping them to crash later', () => {
    const entry = {
      ...emptyEntry(),
      sessionId: 7,
      cwd: '/w/app',
      customTitle: { x: 1 },
      lastAt: 'soon',
      turns: [1, null, { role: 'user', text: 'kept' }, { role: 'other', text: 'x' }, { role: 'claude', text: 5 }],
      files: ['/a', 3, null],
      tools: [{}, 'Edit'],
    };
    const file = { version: 1, transcripts: { '/p/a.jsonl': { size: 10, mtimeMs: 5, offset: 10, mark: 'ab', entry } } };
    const e = parseHistoryFile(JSON.stringify(file)).transcripts['/p/a.jsonl'].entry;
    expect(e.turns).toEqual([{ role: 'user', text: 'kept' }]);
    expect(e.files).toEqual(['/a']);
    expect(e.tools).toEqual(['Edit']);
    expect(e.sessionId).toBeUndefined();
    expect(e.customTitle).toBeUndefined();
    expect(e.lastAt).toBeUndefined();
    expect(e.cwd).toBe('/w/app');
    expect(entryTitle(e)).toBe('kept');
  });
});

describe('applyLine memory', () => {
  it('keeps only the capped text of a huge prompt, not the whole prompt (a slice would hold its parent string)', async () => {
    const { setFlagsFromString } = await import('node:v8');
    const { runInNewContext } = await import('node:vm');
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    const { emptyEntry } = await import('../src/core/historyIndex');
    const entries = [];
    gc();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 100; i++) {
      const e = emptyEntry();
      // A different 1 MB prompt each time (not one string shared by all).
      const prompt = `${i} ${'x'.repeat(1024 * 1024)}`;
      applyLine(e, JSON.stringify({ type: 'user', message: { content: `  ${prompt}` } }));
      applyLine(e, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: `  ${prompt}` }] } }));
      applyLine(e, JSON.stringify({ type: 'system', subtype: 'away_summary', content: `  ${prompt}` }));
      entries.push(e);
    }
    gc();
    const grownMB = (process.memoryUsage().heapUsed - before) / 1024 / 1024;
    expect(entries[0].turns.length).toBe(2);
    // 100 entries × (two 16 KB turns + a recap) is about 10 MB; holding the parents would be 300 MB.
    expect(grownMB).toBeLessThan(60);
  });
});
