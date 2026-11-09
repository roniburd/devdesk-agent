import { describe, expect, it } from 'vitest';
import { parseBoardMessage } from '../src/board/messages';
import { KEPT_KEYS } from '../src/board/projectState';
import { HISTORY_MAX, parseHistory, parseKeep, parseKeptChoice, rememberPrompt, TEXT_MAX } from '../src/core/boardKept';
import { projectFolder } from './boardProjectFolder';

describe('what the board keeps for a project folder: parsing', () => {
  it('keeps the known choice fields of the right type', () => {
    expect(parseKeptChoice({ model: 'opus', effort: 'high', mode: 'Plan', ultracode: true, extra: 1 })).toEqual({ model: 'opus', effort: 'high', mode: 'Plan', ultracode: true });
    expect(parseKeptChoice({ model: 3, effort: '', ultracode: 'yes' })).toEqual({});
    expect(parseKeptChoice(undefined)).toEqual({});
  });

  it('keeps the last 50 earlier prompts, strings only', () => {
    const many = Array.from({ length: 60 }, (_, i) => `p${i}`);
    expect(parseHistory([...many, 4, ''])).toEqual(many.slice(-HISTORY_MAX));
    expect(parseHistory('x')).toEqual([]);
  });

  it('remembers a prompt at the end, not twice in a row, capped', () => {
    expect(rememberPrompt(['a'], ' b ')).toEqual(['a', 'b']);
    expect(rememberPrompt(['a', 'b'], 'b')).toEqual(['a', 'b']);
    expect(rememberPrompt(['a', 'b'], '  ')).toEqual(['a', 'b']);
    expect(rememberPrompt(['a', 'b', 'c'], 'd', 3)).toEqual(['b', 'c', 'd']);
  });

  it('checks a keep message field by field', () => {
    expect(parseKeep({ choice: { model: 'opus', bogus: 1 }, draft: 'x', remember: ' y ', filter: 'feat-a', query: '' })).toEqual({
      choice: { model: 'opus' },
      draft: 'x',
      remember: 'y',
      filter: 'feat-a',
      query: '',
    });
    expect(parseKeep({ draft: 'x'.repeat(TEXT_MAX + 5) })?.draft).toHaveLength(TEXT_MAX);
    expect(parseKeep({ choice: { model: 5 }, remember: '  ', draft: 7 })).toBeUndefined();
    expect(parseBoardMessage({ type: 'keep', draft: '' })).toEqual({ type: 'keep', draft: '' });
    expect(parseBoardMessage({ type: 'keep' })).toBeUndefined();
  });
});

describe('BoardProjectState', () => {
  it('restores only what is saved', () => {
    expect(projectFolder().kept.restore()).toEqual({});
    expect(projectFolder({ effort: 'low', query: 'auth' }).kept.restore()).toEqual({ choice: { effort: 'low' }, query: 'auth' });
  });

  it('applies each change to what is saved now, so another window on the folder keeps its own', async () => {
    const folder = projectFolder();
    await folder.kept.keep({ choice: { model: 'opus' } });
    // Another window on the same folder changed the effort meanwhile.
    folder.values.set(KEPT_KEYS.choice, { model: 'opus', effort: 'max' });
    await folder.kept.keep({ choice: { mode: 'Plan' } });
    expect(folder.kept.restore().choice).toEqual({ model: 'opus', effort: 'max', mode: 'Plan' });
    await folder.kept.keep({ remember: 'one' });
    folder.values.set(KEPT_KEYS.history, ['one', 'two']);
    await folder.kept.keep({ remember: 'three' });
    expect(folder.kept.restore().history).toEqual(['one', 'two', 'three']);
    await folder.kept.keep({ filter: 'feat-a' });
    await folder.kept.keep({ query: 'auth' });
    expect(folder.kept.restore()).toMatchObject({ filter: 'feat-a', query: 'auth' });
  });

  it('caps the earlier prompts at 50', async () => {
    const folder = projectFolder();
    for (let i = 0; i < 55; i++) await folder.kept.keep({ remember: `p${i}` });
    const history = folder.kept.restore().history!;
    expect(history).toHaveLength(50);
    expect(history[0]).toBe('p5');
  });
});
