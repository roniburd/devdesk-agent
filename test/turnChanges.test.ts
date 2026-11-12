import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readLinesBackward } from '../src/core/transcriptTail';
import { applyEdits, promptOf, SNIPPET_SEPARATOR, type Turn, turnFiles, TurnParser, turnPaths, undoEdits } from '../src/core/turnChanges';
import { readRecentTurns } from '../src/core/turnChangesRead';

let n = 0;
const at = () => new Date(Date.UTC(2026, 10, 9, 10, 0, n++)).toISOString();
const line = (o: unknown) => `${JSON.stringify(o)}\n`;
const prompt = (text: string, extra: Record<string, unknown> = {}) => line({ type: 'user', timestamp: at(), message: { role: 'user', content: text }, ...extra });
const use = (id: string, name: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  line({ type: 'assistant', timestamp: at(), message: { content: [{ type: 'tool_use', id, name, input }] }, ...extra });
const result = (id: string, toolUseResult: unknown, isError = false, extra: Record<string, unknown> = {}) =>
  line({ type: 'user', timestamp: at(), message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: 'ok' }] }, toolUseResult, ...extra });
const reply = (text: string) => line({ type: 'assistant', timestamp: at(), message: { content: [{ type: 'text', text }] } });

/** An Edit call and its successful result, as Claude Code writes them. */
const edit = (id: string, path: string, old: string, neu: string, original: string | null, all = false) =>
  use(id, 'Edit', { file_path: path, old_string: old, new_string: neu, replace_all: all }) +
  result(id, { filePath: path, oldString: old, newString: neu, originalFile: original, replaceAll: all, structuredPatch: [] });
const write = (id: string, path: string, content: string, original: string | null) =>
  use(id, 'Write', { file_path: path, content }) + result(id, { type: original === null ? 'create' : 'update', filePath: path, content, originalFile: original, structuredPatch: [] });

function parse(text: string, subagent = false): Turn[] {
  const parser = new TurnParser(subagent);
  for (const l of text.split('\n').filter(Boolean)) parser.object(JSON.parse(l));
  return parser.turns;
}
const noDisk = () => undefined;

describe('applyEdits / undoEdits', () => {
  it('replaces the first occurrence, or all with replace_all, and undoes it', () => {
    expect(applyEdits('a b a', [{ old: 'a', new: 'x', all: false }])).toBe('x b a');
    expect(applyEdits('a b a', [{ old: 'a', new: 'x', all: true }])).toBe('x b x');
    expect(undoEdits('x b x', [{ old: 'a', new: 'x', all: true }])).toBe('a b a');
    expect(undoEdits('x b a', [{ old: 'a', new: 'x', all: false }])).toBe('a b a');
  });

  it('takes $ patterns literally', () => {
    expect(applyEdits('cost', [{ old: 'cost', new: "$& $' $1", all: false }])).toBe("$& $' $1");
  });

  it('fails on a missing old string, and on an undo it cannot be sure of', () => {
    expect(applyEdits('abc', [{ old: 'z', new: 'y', all: false }])).toBeUndefined();
    expect(undoEdits('x x', [{ old: 'a', new: 'x', all: false }]), 'new text twice').toBeUndefined();
    expect(undoEdits('abc', [{ old: 'a', new: '', all: false }]), 'deleted text').toBeUndefined();
    expect(undoEdits('abc', [{ old: 'a', new: 'z', all: false }])).toBeUndefined();
  });

  it('applies and undoes several edits in order (MultiEdit)', () => {
    const edits = [
      { old: 'one', new: 'two', all: false },
      { old: 'two', new: 'three', all: false },
    ];
    expect(applyEdits('one', edits)).toBe('three');
    expect(undoEdits('three', edits)).toBe('one');
  });
});

describe('promptOf', () => {
  it('reads typed prompts and slash commands, not tool results, ! commands, meta lines or sidechains', () => {
    expect(promptOf({ type: 'user', message: { content: 'fix  the\nbug' } })).toBe('fix the bug');
    expect(promptOf({ type: 'user', message: { content: [{ type: 'text', text: 'look' }, { type: 'image' }] } })).toBe('look');
    expect(promptOf({ type: 'user', message: { content: '<command-name>/review</command-name>\n<command-args>12</command-args>' } })).toBe('/review 12');
    expect(promptOf({ type: 'user', message: { content: '<task-notification><status>completed</status></task-notification>' } })).toBe('(a background task finished)');
    expect(promptOf({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x' }] } })).toBeUndefined();
    expect(promptOf({ type: 'user', message: { content: '<bash-input>ls</bash-input>' } })).toBeUndefined();
    expect(promptOf({ type: 'user', message: { content: '<local-command-stdout>ok</local-command-stdout>' } })).toBeUndefined();
    expect(promptOf({ type: 'user', message: { content: '[Request interrupted by user]' } })).toBeUndefined();
    expect(promptOf({ type: 'user', isMeta: true, message: { content: 'caveat' } })).toBeUndefined();
    expect(promptOf({ type: 'user', isSidechain: true, message: { content: 'subagent task' } })).toBeUndefined();
    expect(promptOf({ type: 'assistant', message: { content: 'hi' } })).toBeUndefined();
  });
});

describe('TurnParser and turnFiles', () => {
  it('splits turns at prompts and rebuilds an Edit from the whole file the result carries', () => {
    const turns = parse(
      prompt('first') + edit('e1', '/r/a.ts', 'let x = 1', 'let x = 2', 'let x = 1;\nend\n') + reply('done') + prompt('second') + reply('nothing to do'),
    );
    expect(turns.map((t) => [t.prompt, turnPaths(t)])).toEqual([
      ['first', ['/r/a.ts']],
      ['second', []],
    ]);
    expect(turnFiles(turns, 0, noDisk)).toEqual([{ path: '/r/a.ts', before: 'let x = 1;\nend\n', after: 'let x = 2;\nend\n', source: 'transcript', byAgent: false }]);
  });

  it('applies replace_all and several edits of one file in order', () => {
    const original = 'a\na\nb\n';
    const turns = parse(prompt('p') + edit('e1', '/f', 'a', 'c', original, true) + edit('e2', '/f', 'b', 'd', 'c\nc\nb\n'));
    expect(turnFiles(turns, 0, noDisk)[0]).toMatchObject({ before: original, after: 'c\nc\nd\n', source: 'transcript' });
  });

  it('reads MultiEdit calls', () => {
    const input = { file_path: '/m', edits: [{ old_string: 'x', new_string: 'y' }, { old_string: 'q', new_string: 'r', replace_all: true }] };
    const turns = parse(prompt('p') + use('m1', 'MultiEdit', input) + result('m1', { filePath: '/m', edits: input.edits, originalFileContents: 'x q q' }));
    expect(turnFiles(turns, 0, noDisk)[0]).toMatchObject({ before: 'x q q', after: 'y r r', source: 'transcript' });
  });

  it('shows a Write that created a file against nothing, and one over a file against what it had', () => {
    const turns = parse(prompt('p') + write('w1', '/new', 'hello\n', null) + write('w2', '/old', 'v2\n', 'v1\n'));
    expect(turnFiles(turns, 0, noDisk).map((f) => [f.path, f.before, f.after, f.source])).toEqual([
      ['/new', '', 'hello\n', 'transcript'],
      ['/old', 'v1\n', 'v2\n', 'transcript'],
    ]);
  });

  it('leaves out failed calls: an error result, or a result that is only the error', () => {
    const turns = parse(
      prompt('p') +
        use('e1', 'Edit', { file_path: '/a', old_string: 'x', new_string: 'y' }) +
        result('e1', 'Error: String to replace not found in file.', true) +
        use('e2', 'Write', { file_path: '/b', content: 'z' }) +
        result('e2', 'Error: File has not been read yet.') +
        use('e3', 'Edit', { file_path: '/c', old_string: 'x', new_string: 'y' }),
    );
    expect(turnPaths(turns[0])).toEqual([]);
  });

  it('rebuilds a file from disk by undoing this turn’s and later turns’ edits when the transcript has no whole copy', () => {
    const turns = parse(prompt('one') + edit('e1', '/f', 'alpha', 'beta', null) + prompt('two') + edit('e2', '/f', 'gamma', 'delta', null));
    const disk = (p: string) => (p === '/f' ? 'beta\ndelta\n' : undefined);
    expect(turnFiles(turns, 0, disk)[0]).toMatchObject({ before: 'alpha\ngamma\n', after: 'beta\ngamma\n', source: 'disk' });
    expect(turnFiles(turns, 1, disk)[0]).toMatchObject({ before: 'beta\ngamma\n', after: 'beta\ndelta\n', source: 'disk' });
  });

  it('uses what an earlier turn knew of the file, and a later edit’s copy as the state after the turn', () => {
    const turns = parse(prompt('one') + write('w1', '/f', 'a\n', null) + prompt('two') + edit('e2', '/f', 'a', 'b', null) + prompt('three') + edit('e3', '/f', 'b', 'c', 'b\n'));
    expect(turnFiles(turns, 1, noDisk)[0]).toMatchObject({ before: 'a\n', after: 'b\n', source: 'transcript' });
  });

  it('falls back to the edited parts when neither the transcript nor the disk can rebuild the file', () => {
    const turns = parse(prompt('p') + edit('e1', '/f', 'x', 'y', null) + edit('e2', '/f', 'u', 'v', null));
    const file = turnFiles(turns, 0, () => 'changed by someone else')[0];
    expect(file).toMatchObject({ before: `x${SNIPPET_SEPARATOR}u`, after: `y${SNIPPET_SEPARATOR}v`, source: 'snippets' });
    expect(file.note).toMatch(/edited parts/);
  });

  it('shows the edited lines with their context when the result has its hunks', () => {
    const structuredPatch = [{ oldStart: 7, oldLines: 3, newStart: 7, newLines: 3, lines: [' before', '-x', '+y', ' after'] }];
    const turns = parse(prompt('p') + use('e1', 'Edit', { file_path: '/f', old_string: 'x', new_string: 'y' }) + result('e1', { filePath: '/f', oldString: 'x', newString: 'y', originalFile: null, structuredPatch }));
    expect(turnFiles(turns, 0, noDisk)[0]).toMatchObject({ before: '⋯ line 7\nbefore\nx\nafter', after: '⋯ line 7\nbefore\ny\nafter', source: 'snippets' });
  });

  it('shows a Write over a file of unknown text against an empty before, with a note', () => {
    const turns = parse(prompt('p') + use('w1', 'Write', { file_path: '/f', content: 'new' }) + result('w1', {}));
    const file = turnFiles(turns, 0, () => 'new')[0];
    expect(file).toMatchObject({ before: '', after: 'new', source: 'snippets' });
    expect(file.note).toMatch(/written whole/);
  });

  it('counts sidechain edits in the transcript in the turn, and their prompts start no turn', () => {
    const turns = parse(
      prompt('main') +
        prompt('subagent task', { isSidechain: true }) +
        use('s1', 'Edit', { file_path: '/s', old_string: 'a', new_string: 'b' }, { isSidechain: true }) +
        result('s1', { filePath: '/s', oldString: 'a', newString: 'b', originalFile: 'a' }, false, { isSidechain: true }),
    );
    expect(turns).toHaveLength(1);
    expect(turnFiles(turns, 0, noDisk)[0]).toMatchObject({ path: '/s', after: 'b', byAgent: true });
  });

  it('records the subagents a turn started', () => {
    const turns = parse(prompt('p') + use('t1', 'Agent', { description: 'd' }) + result('t1', { agentId: 'abc', status: 'completed' }));
    expect(turns[0].agents).toEqual(['abc']);
  });

  it('marks edits read before any prompt as a partial turn', () => {
    const turns = parse(edit('e1', '/f', 'a', 'b', 'a') + prompt('next'));
    expect(turns.map((t) => [t.prompt, t.partial])).toEqual([
      ['', true],
      ['next', false],
    ]);
  });
});

describe('readLinesBackward', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'devdesk-turns-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('feeds lines last first across chunk edges, keeping UTF-8 characters whole', async () => {
    const path = join(dir, 'f');
    await writeFile(path, 'first\nsécond ✓\nthird\n');
    const seen: (string | undefined)[] = [];
    const read = await readLinesBackward(path, { maxBytes: 1000, maxLine: 1000, chunkBytes: 3 }, (l) => (seen.push(l), true));
    expect(seen).toEqual(['third', 'sécond ✓', 'first']);
    expect(read).toMatchObject({ complete: true });
  });

  it('skips a line longer than maxLine without holding it, wherever it is', async () => {
    const path = join(dir, 'f');
    const huge = 'x'.repeat(5000);
    await writeFile(path, `${huge}\nsmall\n${huge}\nlast\n`);
    const seen: (string | undefined)[] = [];
    await readLinesBackward(path, { maxBytes: 100_000, maxLine: 100, chunkBytes: 64 }, (l) => (seen.push(l), true));
    expect(seen).toEqual(['last', undefined, 'small', undefined]);
  });

  it('stops at maxBytes or when visit says so, without feeding the line cut', async () => {
    const path = join(dir, 'f');
    await writeFile(path, 'aaaa\nbbbb\ncccc\n');
    const seen: (string | undefined)[] = [];
    const read = await readLinesBackward(path, { maxBytes: 8, maxLine: 100, chunkBytes: 3 }, (l) => (seen.push(l), true));
    expect(seen).toEqual(['cccc']);
    expect(read).toMatchObject({ complete: false });
    const one: (string | undefined)[] = [];
    await readLinesBackward(path, { maxBytes: 100, maxLine: 100 }, (l) => (one.push(l), false));
    expect(one).toEqual(['cccc']);
  });

  it('is undefined for a missing file', async () => {
    expect(await readLinesBackward(join(dir, 'none'), { maxBytes: 10, maxLine: 10 }, () => true)).toBeUndefined();
  });
});

describe('readRecentTurns', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'devdesk-turns-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const limits = { turns: 10, maxBytes: 1 << 20, maxLine: 1 << 20, chunkBytes: 50 };

  it('reads only the last turns, and adds the edits of the subagents a turn started, in time order', async () => {
    const transcript = join(dir, 's.jsonl');
    const subagents = join(dir, 's', 'subagents');
    await mkdir(subagents, { recursive: true });
    const head = prompt('old') + edit('e0', '/o', 'a', 'b', 'a') + prompt('new') + edit('e1', '/m', 'a', 'b', 'a') + use('t1', 'Agent', { description: 'helper' });
    // The subagent's edits (in its own transcript) are made before the main session's next edit.
    await writeFile(join(subagents, 'agent-h1.jsonl'), prompt('do it', { isSidechain: true }) + edit('h-e1', '/s', 'x', 'y', 'x'));
    await writeFile(transcript, head + result('t1', { agentId: 'h1', status: 'completed' }) + edit('e2', '/m', 'b', 'c', 'b'));
    const turns = await readRecentTurns(transcript, { ...limits, turns: 1 });
    expect(turns?.map((t) => t.prompt)).toEqual(['new']);
    expect(turns?.[0].ops.map((o) => [o.path, !!o.agent])).toEqual([
      ['/m', false],
      ['/s', true],
      ['/m', false],
    ]);
    const all = await readRecentTurns(transcript, limits);
    expect(all?.map((t) => [t.prompt, turnPaths(t)])).toEqual([
      ['old', ['/o']],
      ['new', ['/m', '/s']],
    ]);
  });

  it('marks the turn cut by maxBytes partial, and one with a line too long to read', async () => {
    const transcript = join(dir, 's.jsonl');
    const big = 'z'.repeat(4000);
    await writeFile(transcript, prompt('long ago') + edit('e0', '/o', 'a', 'b', big) + prompt('recent') + write('w1', '/n', big, null) + edit('e1', '/x', 'a', 'b', 'a'));
    const cut = await readRecentTurns(transcript, { ...limits, maxBytes: 700 });
    expect(cut?.map((t) => [t.prompt, t.partial])).toEqual([['', true]]);
    const skipped = await readRecentTurns(transcript, { ...limits, maxLine: 1000 });
    expect(skipped?.map((t) => [t.prompt, t.partial, turnPaths(t)])).toEqual([
      ['long ago', true, []],
      ['recent', true, ['/x']],
    ]);
  });
});
