import { describe, expect, it } from 'vitest';
import { ForkCopier, forkCut, forkName, forkResumeArgs, picksModel, rewindPlan, rewindWrites, worktreeFiles } from '../src/core/forkTurn';
import { promptOf, type Turn, TurnParser } from '../src/core/turnChanges';

const line = (o: unknown) => JSON.stringify(o);
const prompt = (uuid: string, text: string) => line({ type: 'user', uuid, sessionId: 'old', message: { role: 'user', content: text } });
const edit = (id: string, path: string, old: string, neu: string, original?: string) => [
  line({ type: 'assistant', uuid: `a-${id}`, sessionId: 'old', message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id, name: 'Edit', input: { file_path: path, old_string: old, new_string: neu } }] } }),
  line({ type: 'user', uuid: `r-${id}`, sessionId: 'old', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] }, toolUseResult: { filePath: path, oldString: old, newString: neu, ...(original !== undefined ? { originalFile: original } : {}) } }),
];
const create = (id: string, path: string, content: string) => [
  line({ type: 'assistant', uuid: `a-${id}`, sessionId: 'old', message: { content: [{ type: 'tool_use', id, name: 'Write', input: { file_path: path, content } }] } }),
  line({ type: 'user', uuid: `r-${id}`, sessionId: 'old', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] }, toolUseResult: { type: 'create', filePath: path, content, originalFile: null } }),
];

function parse(lines: string[]): Turn[] {
  const parser = new TurnParser();
  for (const l of lines) parser.object(JSON.parse(l));
  return parser.turns;
}

/** Three turns: 1 edits a.ts; 2 edits a.ts again and b.ts; 3 creates c.ts. */
const transcript = [
  prompt('p1', 'one'),
  ...edit('e1', '/r/a.ts', 'x', 'y', 'let x;\n'),
  prompt('p2', 'two'),
  ...edit('e2', '/r/a.ts', 'y', 'z', 'let y;\n'),
  ...edit('e3', '/r/b.ts', 'old', 'new', 'old\n'),
  prompt('p3', 'three'),
  ...create('w1', '/r/c.ts', 'export {};\n'),
];

describe('TurnParser', () => {
  it('keeps each prompt’s uuid', () => {
    expect(parse(transcript).map((t) => t.uuid)).toEqual(['p1', 'p2', 'p3']);
  });
});

describe('forkCut', () => {
  it('cuts before the next turn’s prompt; the last turn forks the whole conversation', () => {
    const turns = parse(transcript);
    expect(forkCut(turns, 0)).toEqual({ cut: 'p2', last: false });
    expect(forkCut(turns, 2)).toEqual({ last: true });
    expect(forkCut([{ ...turns[0] }, { ...turns[1], uuid: undefined }], 0)).toBeUndefined();
  });
});

describe('ForkCopier', () => {
  const copy = (lines: string[], cut: string | undefined) => {
    const out: string[] = [];
    const c = new ForkCopier('old', 'new', cut, (l) => out.push(l), (o) => promptOf(o) !== undefined);
    for (const l of lines) if (!c.line(l)) break;
    c.end();
    return { out, c };
  };

  it('copies up to the cut, under the new session id, counting the turns and keeping the model', () => {
    const snapshot = line({ type: 'file-history-snapshot', messageId: 'p2', snapshot: {} });
    const { out, c } = copy([...transcript.slice(0, 3), snapshot, '', ...transcript.slice(3)], 'p2');
    expect(c.found).toBe(true);
    expect(c.turns).toBe(1);
    expect(c.model).toBe('claude-opus-5-5');
    expect(out.map((l) => JSON.parse(l).uuid)).toEqual(['p1', 'a-e1', 'r-e1']);
    expect(out.every((l) => JSON.parse(l).sessionId === 'new')).toBe(true);
  });

  it('without a cut, copies everything, the bookkeeping at the end too', () => {
    const tail = line({ type: 'last-prompt', sessionId: 'old', lastPrompt: 'three' });
    const { out, c } = copy([...transcript, tail], undefined);
    expect(c.found).toBe(false);
    expect(c.turns).toBe(3);
    expect(out).toHaveLength(transcript.length + 1);
    expect(JSON.parse(out.at(-1)!)).toEqual({ type: 'last-prompt', sessionId: 'new', lastPrompt: 'three' });
  });

  it('says when the cut is not there', () => {
    expect(copy(transcript, 'nope').c.found).toBe(false);
  });
});

describe('rewindPlan', () => {
  const turns = parse(transcript);
  const disk = (files: Record<string, string>) => (p: string) => files[p];

  it('puts back what Claude changed after the turn, deletes what it created, when the files are still as Claude left them', () => {
    const plan = rewindPlan(turns, 0, disk({ '/r/a.ts': 'let z;\n', '/r/b.ts': 'new\n', '/r/c.ts': 'export {};\n' }));
    expect(plan).toEqual([
      { path: '/r/a.ts', action: 'restore', content: 'let y;\n', expected: 'let z;\n' },
      { path: '/r/b.ts', action: 'restore', content: 'old\n', expected: 'new\n' },
      { path: '/r/c.ts', action: 'delete', expected: 'export {};\n' },
    ]);
    expect(rewindWrites(plan)).toHaveLength(3);
  });

  it('leaves alone a file changed since Claude wrote it, or one already as it was', () => {
    const plan = rewindPlan(turns, 1, disk({ '/r/c.ts': 'export {}; // mine\n' }));
    expect(plan).toEqual([{ path: '/r/c.ts', action: 'changed' }]);
    expect(rewindPlan(turns, 1, disk({}))).toEqual([{ path: '/r/c.ts', action: 'same' }]);
    expect(rewindPlan(turns, 0, disk({ '/r/a.ts': 'let y;\n', '/r/b.ts': 'mine\n' })).map((f) => f.action)).toEqual(['same', 'changed', 'same']);
  });

  it('cannot tell a file whose text then the transcript does not have', () => {
    const partial = parse([prompt('p1', 'one'), ...edit('e1', '/r/a.ts', 'x', 'y'), prompt('p2', 'two'), ...edit('e2', '/r/a.ts', 'y', 'z')]);
    expect(rewindPlan(partial, 0, disk({ '/r/a.ts': 'z' }))).toEqual([{ path: '/r/a.ts', action: 'unknown' }]);
  });

  it('works out the text then from the earlier edits when the later one has no copy of the file', () => {
    const t = parse([prompt('p1', 'one'), ...edit('e1', '/r/a.ts', 'x', 'y', 'x1'), prompt('p2', 'two'), ...edit('e2', '/r/a.ts', 'y', 'z')]);
    expect(rewindPlan(t, 0, disk({ '/r/a.ts': 'z1' }))).toEqual([{ path: '/r/a.ts', action: 'restore', content: 'y1', expected: 'z1' }]);
  });

  it('is empty for the last turn', () => {
    expect(rewindPlan(turns, 2, disk({}))).toEqual([]);
  });
});

describe('worktreeFiles', () => {
  it('copies every file Claude changed as the original has it, rewound by the plan, inside the worktree only', () => {
    const t = parse([...transcript, prompt('p4', 'four'), ...edit('e4', '/elsewhere/x.ts', 'a', 'b', 'a')]);
    const now = { '/r/a.ts': 'let z;\n', '/r/b.ts': 'mine\n', '/r/c.ts': 'export {};\n', '/elsewhere/x.ts': 'b' };
    const plan = rewindPlan(t, 1, (p) => now[p as keyof typeof now]);
    expect(worktreeFiles(t, plan, '/r', (p) => now[p as keyof typeof now])).toEqual([
      { rel: 'a.ts', content: 'let z;\n', rewound: false },
      { rel: 'b.ts', content: 'mine\n', rewound: false },
      { rel: 'c.ts', content: null, rewound: true },
    ]);
  });
});

describe('fork arguments', () => {
  it('resumes the copy, named, on the original model unless the launch picks one', () => {
    expect(forkResumeArgs('n-1', forkName('Fix it', 2), 'claude-opus-5-5', '')).toBe(`--resume n-1 --name 'forked from “Fix it” at turn 2' --model 'claude-opus-5-5'`);
    expect(forkResumeArgs('n-1', "it's", 'm', '--model sonnet')).toBe(`--resume n-1 --name 'it'\\''s'`);
    expect(forkResumeArgs('n-1', 'x', undefined, '')).toBe(`--resume n-1 --name 'x'`);
    expect(() => forkResumeArgs('a b', 'x', undefined, '')).toThrow();
  });

  it('knows when arguments pick a model', () => {
    expect(picksModel('--model opus')).toBe(true);
    expect(picksModel('--effort max --model=opus')).toBe(true);
    expect(picksModel('--models x')).toBe(false);
    expect(picksModel(undefined)).toBe(false);
  });
});
