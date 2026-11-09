import { describe, expect, it } from 'vitest';
import { formatReviewNote, quoteNote, reviewPrompt, sortedNotes } from '../src/core/reviewNotes';

describe('review notes', () => {
  it('quote the text on one line, so a note cannot end its own quote', () => {
    expect(quoteNote(' say "hi"\nand \\n ')).toBe('"say \\"hi\\"\\nand \\\\n"');
  });

  it('name the file, the line or lines, and the comment', () => {
    expect(formatReviewNote({ path: 'src/a.ts', line: 12, text: 'rename this' })).toBe('File: src/a.ts\nLine: 12\nUser comment: "rename this"');
    expect(formatReviewNote({ path: 'b.ts', line: 3, endLine: 3, text: 'x' })).toContain('\nLine: 3\n');
    expect(formatReviewNote({ path: 'b.ts', line: 3, endLine: 7, text: 'x' })).toContain('\nLines: 3-7\n');
  });

  it('go in file and line order, without empty ones', () => {
    const notes = [
      { path: 'b.ts', line: 1, text: 'b1' },
      { path: 'a.ts', line: 9, text: 'a9' },
      { path: 'a.ts', line: 2, text: 'a2' },
      { path: 'a.ts', line: 5, text: '  ' },
    ];
    expect(sortedNotes(notes).map((n) => n.text)).toEqual(['a2', 'a9', 'b1']);
  });

  it('make one prompt, the same for the same notes', () => {
    const notes = [
      { path: 'b.ts', line: 1, text: 'second' },
      { path: 'a.ts', line: 2, text: 'first' },
    ];
    const prompt = reviewPrompt(notes);
    expect(prompt).toBe(
      'Review notes on your changes (2 notes). Address each one:\n\nFile: a.ts\nLine: 2\nUser comment: "first"\n\nFile: b.ts\nLine: 1\nUser comment: "second"',
    );
    expect(reviewPrompt([...notes].reverse())).toBe(prompt);
    expect(reviewPrompt([notes[0]])).toMatch(/^Review notes on your changes \(1 note\)/);
  });
});
