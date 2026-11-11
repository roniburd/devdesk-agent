import { describe, expect, it } from 'vitest';
import { ansiToSpans } from '../../src/core/web/ansi';

const E = '\x1b';

describe('ansiToSpans', () => {
  it('splits plain text into lines', () => {
    expect(ansiToSpans('hello\nworld')).toEqual([[{ text: 'hello' }], [{ text: 'world' }]]);
  });

  it('keeps empty lines inside, drops trailing ones', () => {
    expect(ansiToSpans('a\n\nb\n\n  \n')).toEqual([[{ text: 'a' }], [], [{ text: 'b' }]]);
    expect(ansiToSpans('')).toEqual([]);
    expect(ansiToSpans('\n\n')).toEqual([]);
  });

  it('reads the 16 colours', () => {
    expect(ansiToSpans(`${E}[31mred${E}[39m plain ${E}[92mbright${E}[0m`)).toEqual([
      [{ text: 'red', fg: 1 }, { text: ' plain ' }, { text: 'bright', fg: 10 }],
    ]);
    expect(ansiToSpans(`${E}[44mbg${E}[49m ${E}[103mbb`)).toEqual([[{ text: 'bg', bg: 4 }, { text: ' ' }, { text: 'bb', bg: 11 }]]);
  });

  it('reads 256 colours and truecolor, with ; or :', () => {
    expect(ansiToSpans(`${E}[38;5;208mo${E}[48;5;17mx`)).toEqual([[{ text: 'o', fg: 208 }, { text: 'x', fg: 208, bg: 17 }]]);
    expect(ansiToSpans(`${E}[38;2;255;0;128mt${E}[0m`)).toEqual([[{ text: 't', fg: '#ff0080' }]]);
    expect(ansiToSpans(`${E}[48;2;1;2;3mt`)).toEqual([[{ text: 't', bg: '#010203' }]]);
    expect(ansiToSpans(`${E}[38:5:9mc`)).toEqual([[{ text: 'c', fg: 9 }]]);
    expect(ansiToSpans(`${E}[38:2::10:20:30mc`)).toEqual([[{ text: 'c', fg: '#0a141e' }]]);
  });

  it('drops a malformed extended colour', () => {
    expect(ansiToSpans(`${E}[38;5mx`)).toEqual([[{ text: 'x' }]]);
    expect(ansiToSpans(`${E}[38;5;300mx`)).toEqual([[{ text: 'x' }]]);
    expect(ansiToSpans(`${E}[38;2;1;2mx`)).toEqual([[{ text: 'x' }]]);
  });

  it('turns attributes on and off', () => {
    expect(ansiToSpans(`${E}[1mb${E}[22m${E}[2md${E}[22m${E}[3mi${E}[23m${E}[4mu${E}[24m${E}[7mv${E}[27mn`)).toEqual([
      [{ text: 'b', bold: true }, { text: 'd', dim: true }, { text: 'i', italic: true }, { text: 'u', underline: true }, { text: 'v', inverse: true }, { text: 'n' }],
    ]);
    expect(ansiToSpans(`${E}[1;31mx${E}[mY`)).toEqual([[{ text: 'x', fg: 1, bold: true }, { text: 'Y' }]]);
  });

  it('carries the style across lines', () => {
    expect(ansiToSpans(`${E}[32ma\nb${E}[0m`)).toEqual([[{ text: 'a', fg: 2 }], [{ text: 'b', fg: 2 }]]);
  });

  it('merges runs with the same style', () => {
    expect(ansiToSpans(`${E}[31ma${E}[31mb${E}[1m${E}[22mc`)).toEqual([[{ text: 'abc', fg: 1 }]]);
  });

  it('drops cursor moves, OSC and other escapes', () => {
    expect(ansiToSpans(`${E}[2J${E}[1;1Ha${E}[?25lb${E}]0;title\x07c${E}]8;;https://x${E}\\d${E}(Be${E}=f`)).toEqual([[{ text: 'abcdef' }]]);
  });

  it('drops other control characters', () => {
    expect(ansiToSpans('a\x00b\x07c\rd\x7fe\x9bf')).toEqual([[{ text: 'abcdef' }]]);
    expect(ansiToSpans('a\tb')).toEqual([[{ text: 'a b' }]]);
  });

  it('keeps markup as literal text', () => {
    const evil = `<script>alert("x")</script>&amp;'`;
    expect(ansiToSpans(`${E}[31m${evil}`)).toEqual([[{ text: evil, fg: 1 }]]);
    expect(ansiToSpans('<img src=x onerror=alert(1)>')).toEqual([[{ text: '<img src=x onerror=alert(1)>' }]]);
  });

  it('ignores an unfinished escape at the end', () => {
    expect(ansiToSpans(`a${E}[3`)).toEqual([[{ text: 'a' }]]);
    expect(ansiToSpans(`a${E}`)).toEqual([[{ text: 'a' }]]);
  });

  it('keeps wide characters', () => {
    expect(ansiToSpans('⏺ 日本 ✻')).toEqual([[{ text: '⏺ 日本 ✻' }]]);
  });
});
