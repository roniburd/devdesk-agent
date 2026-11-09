import { describe, expect, it, vi } from 'vitest';
import type { BoardSearchOptions } from '../src/boardSearch';
import type { SearchSession } from '../src/core/boardSearch';

// The runner logs through `./log`, which needs a `vscode` output channel.
vi.mock('vscode', () => ({
  window: { createOutputChannel: () => ({ info() {}, warn() {}, error() {}, debug() {}, trace() {}, appendLine() {}, dispose() {} }) },
}));

const { BoardSearch } = await import('../src/boardSearch');

const session = (id: string, transcriptPath?: string): SearchSession => ({
  laneTitle: 'Needs you',
  session: { id, title: `Session ${id}`, worktree: 'main', lookLabel: 'QUESTION FOR YOU', ago: '5m', insight: '', search: { all: '', wt: '', is: '' } } as never,
  card: { id, state: 'waiting', detail: '', attached: false, prompt: `prompt of ${id}`, transcriptPath } as never,
});

type Call = { command: string; input: string; signal: AbortSignal };

function runner(o: Partial<BoardSearchOptions> & { answer?: (c: Call) => Promise<{ stdout: string; error?: string }> } = {}) {
  const calls: Call[] = [];
  const search = new BoardSearch({
    model: () => 'haiku',
    command: () => '',
    claude: () => '/bin/claude',
    timeoutMs: () => 30_000,
    readLines: async () => [JSON.stringify({ type: 'user', message: { content: 'from the transcript' } })],
    now: () => Date.UTC(2026, 10, 2),
    run: (command, input, r) => {
      const call = { command, input, signal: r.signal };
      calls.push(call);
      return o.answer ? o.answer(call) : Promise.resolve({ stdout: JSON.stringify({ is_error: false, result: '{"matches":[{"id":"a","reason":"auth"}]}' }) });
    },
    ...o,
  });
  return { search, calls };
}

describe('BoardSearch', () => {
  it('asks claude -p headless with the digests on stdin, and returns the checked answer', async () => {
    const { search, calls } = runner();
    expect(await search.search('auth', [session('a', '/t/a.jsonl'), session('b')])).toEqual({ matches: [{ id: 'a', reason: 'auth' }] });
    expect(calls[0].command).toMatch(/^\/bin\/claude '-p' '--bare' '--model' 'haiku' '--output-format' 'json' '--system-prompt' /);
    expect(calls[0].command).toMatch(/'--tools' '' '--strict-mcp-config' '--no-session-persistence'$/);
    const request = JSON.parse(calls[0].input);
    expect(request.instructions).toBeUndefined();
    expect(request.query).toBe('auth');
    expect(request.sessions.map((s: { id: string }) => s.id)).toEqual(['a', 'b']);
    expect(request.sessions[0].prompts).toEqual(['prompt of a', 'from the transcript']);
  });

  it('tells the model where a board session has the words in its whole transcript (`found`)', async () => {
    const { search, calls } = runner();
    await search.search('V2434592101', [session('a'), session('b')], [], new Map([['b', 'this is the ticket: V2434592101']]));
    const sessions = JSON.parse(calls[0].input).sessions;
    expect(sessions[0].found).toBeUndefined();
    expect(sessions[1].found).toBe('this is the ticket: V2434592101');
    expect(calls[0].command).toContain('`found`');
  });

  it('runs the custom command instead, with the instructions in the request, and reads its stdout as the answer', async () => {
    const { search, calls } = runner({ command: () => '~/bin/ollama-search', answer: async () => ({ stdout: '{"matches":[{"id":"b","reason":"local"}],"note":"one"}' }) });
    expect(await search.search('q', [session('a'), session('b')])).toEqual({ matches: [{ id: 'b', reason: 'local' }], note: 'one' });
    expect(calls[0].command).toBe('~/bin/ollama-search');
    expect(JSON.parse(calls[0].input).instructions).toMatch(/Answer with JSON only/);
  });

  it('reports a failed call, a claude error and an answer that is not the asked JSON', async () => {
    expect(await runner({ answer: async () => ({ stdout: '', error: 'exited with 127: not found' }) }).search.search('q', [session('a')])).toEqual({ error: 'exited with 127: not found' });
    expect(await runner({ answer: async () => ({ stdout: '{"is_error":true,"result":"rate limited"}' }) }).search.search('q', [session('a')])).toEqual({ error: 'rate limited' });
    expect(await runner({ command: () => 'x', answer: async () => ({ stdout: '' }) }).search.search('q', [session('a')])).toEqual({ error: 'the answer is not the JSON asked for' });
  });

  it('a new search cancels the running one, whose answer is dropped', async () => {
    let release!: () => void;
    const { search, calls } = runner({
      answer: (c) =>
        calls.length === 1
          ? new Promise((r) => {
              release = () => r({ stdout: JSON.stringify({ result: '{"matches":[{"id":"a"}]}' }) });
              c.signal.addEventListener('abort', release);
            })
          : Promise.resolve({ stdout: JSON.stringify({ result: '{"matches":[{"id":"b"}]}' }) }),
    });
    const first = search.search('one', [session('a'), session('b')]);
    await new Promise((r) => setTimeout(r, 0));
    const second = search.search('two', [session('a'), session('b')]);
    expect(calls[0].signal.aborted).toBe(true);
    expect(await first).toBeUndefined();
    expect(await second).toEqual({ matches: [{ id: 'b', reason: '' }] });
  });

  it('cancel() aborts the running call and drops its answer', async () => {
    const { search, calls } = runner({ answer: (c) => new Promise((r) => c.signal.addEventListener('abort', () => r({ stdout: '', error: 'cancelled' }))) });
    const p = search.search('q', [session('a')]);
    await new Promise((r) => setTimeout(r, 0));
    search.cancel();
    expect(calls[0].signal.aborted).toBe(true);
    expect(await p).toBeUndefined();
  });

  it('reuses an answer for 5 minutes, not after, and never caches errors', async () => {
    let now = Date.UTC(2026, 10, 2);
    const { search, calls } = runner({ now: () => now });
    await search.search('auth', [session('a')]);
    await search.search('  AUTH ', [session('a')]);
    expect(calls.length).toBe(1);
    now += 5 * 60_000 + 1;
    await search.search('auth', [session('a')]);
    expect(calls.length).toBe(2);

    const failing = runner({ answer: async () => ({ stdout: '', error: 'boom' }) });
    await failing.search.search('q', [session('a')]);
    await failing.search.search('q', [session('a')]);
    expect(failing.calls.length).toBe(2);
  });

  it('passes the timeout setting to the call', async () => {
    let seen = 0;
    const { search } = runner({ timeoutMs: () => 1234, run: async (_c, _i, o) => ((seen = o.timeoutMs), { stdout: '{"result":"{\\"matches\\":[]}"}' }) });
    await search.search('q', [session('a')]);
    expect(seen).toBe(1234);
  });

  it('sends extra (history) digests after the board ones, accepts their ids, and keys the cache on them', async () => {
    const answer = async () => ({ stdout: JSON.stringify({ is_error: false, result: '{"matches":[{"id":"h1","reason":"old one"},{"id":"zz"}]}' }) });
    const { search, calls } = runner({ answer });
    const h1 = { id: 'h1', title: 'Old', worktree: 'main', state: 'History: ended', ago: '3d', prompts: ['p'] };
    expect(await search.search('q', [session('a')], [h1])).toEqual({ matches: [{ id: 'h1', reason: 'old one' }] });
    expect(JSON.parse(calls[0].input).sessions.map((s: { id: string }) => s.id)).toEqual(['a', 'h1']);
    await search.search('q', [session('a')], [{ ...h1, title: 'Changed' }]);
    expect(calls.length).toBe(2);
  });
});
