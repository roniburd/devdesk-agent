import { describe, expect, it } from 'vitest';
import { DETAIL_TAIL_BYTES, DETAIL_TURNS, transcriptTurns } from '../../src/core/web/transcript';

const user = (content: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ type: 'user', message: { role: 'user', content }, ...extra });
const assistant = (content: unknown[], extra: Record<string, unknown> = {}) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content }, ...extra });

describe('transcriptTurns', () => {
  it('lists prompts, replies and one line per tool call', () => {
    const lines = [
      user('fix the build'),
      assistant([{ type: 'text', text: 'Looking.' }, { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }]),
      user([{ type: 'tool_result', content: 'ok' }]),
      assistant([{ type: 'tool_use', name: 'Read', input: { file_path: '/w/a.ts' } }]),
      assistant([{ type: 'text', text: 'Fixed.' }]),
      user([{ type: 'text', text: 'thanks' }]),
    ];
    expect(transcriptTurns(lines)).toEqual([
      { kind: 'user', text: 'fix the build' },
      { kind: 'assistant', text: 'Looking.' },
      { kind: 'tool', text: '- Bash npm test' },
      { kind: 'tool', text: '- Read /w/a.ts' },
      { kind: 'assistant', text: 'Fixed.' },
      { kind: 'user', text: 'thanks' },
    ]);
  });

  it('skips sidechains, meta lines, tool results, injected prompts and command wrappers', () => {
    const lines = [
      user('subagent task', { isSidechain: true }),
      assistant([{ type: 'text', text: 'subagent reply' }], { isSidechain: true }),
      user('caveat', { isMeta: true }),
      user([{ type: 'tool_result', content: 'output' }]),
      user('<task-notification>done</task-notification>'),
      user('<command-name>/clear</command-name>'),
      user([{ type: 'text', text: '<system-reminder>x</system-reminder>' }]),
      assistant([{ type: 'text', text: '   ' }, { type: 'thinking', thinking: 'hmm' }]),
      JSON.stringify({ type: 'system', content: 'x' }),
      user('real'),
    ];
    expect(transcriptTurns(lines)).toEqual([{ kind: 'user', text: 'real' }]);
  });

  it('ignores a line cut by the tail read, and blank lines', () => {
    const lines = ['ontent":"half a line"}}', '', user('after')];
    expect(transcriptTurns(lines)).toEqual([{ kind: 'user', text: 'after' }]);
  });

  it('keeps the last entries', () => {
    const lines = Array.from({ length: 10 }, (_, i) => user(`p${i}`));
    expect(transcriptTurns(lines, 3).map((t) => t.text)).toEqual(['p7', 'p8', 'p9']);
    expect(DETAIL_TURNS).toBe(40);
    expect(DETAIL_TAIL_BYTES).toBe(262144);
    expect(transcriptTurns(Array.from({ length: 50 }, (_, i) => user(`p${i}`)))).toHaveLength(40);
  });

  it('caps long text', () => {
    const [turn] = transcriptTurns([assistant([{ type: 'text', text: 'x'.repeat(5000) }])]);
    expect(turn.text.length).toBe(4000);
    expect(turn.text.endsWith('…')).toBe(true);
  });

  it('keeps text exactly, markup included (the page renders it as text)', () => {
    expect(transcriptTurns([user('<b>hi</b> & "you"')])).toEqual([]);
    expect(transcriptTurns([user('say <b>hi</b> & "you"')])).toEqual([{ kind: 'user', text: 'say <b>hi</b> & "you"' }]);
  });
});
