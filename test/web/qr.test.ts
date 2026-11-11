import { describe, expect, it } from 'vitest';
import { formatBits, qrMatrix, qrSvg, qrVersionFor, reedSolomon, versionBits } from '../../src/core/web/qr';

const hex = (s: string) => s.split(' ').map((h) => parseInt(h, 16));
const bin = (n: number, len: number) => n.toString(2).padStart(len, '0');

describe('QR building blocks', () => {
  it('computes the Reed–Solomon ECC of the standard 1-M "HELLO WORLD" example', () => {
    // The data codewords are 32 91 11 120 … in decimal: the first is 0x20.
    expect(reedSolomon(hex('20 5B 0B 78 D1 72 DC 4D 43 40 EC 11 EC 11 EC 11'), 10)).toEqual(hex('C4 23 27 77 EB D7 E7 E2 5D 17'));
  });

  it('gives the format bits for level M (BCH table)', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((m) => bin(formatBits(m), 15))).toEqual([
      '101010000010010',
      '101000100100101',
      '101111001111100',
      '101101101001011',
      '100010111111001',
      '100000011001110',
      '100111110010111',
      '100101010100000',
    ]);
  });

  it('gives the version bits', () => {
    expect(bin(versionBits(7), 18)).toBe('000111110010010100');
    expect(bin(versionBits(10), 18)).toBe('001010010011010011');
  });

  it('picks the smallest version that fits', () => {
    expect(qrVersionFor(1)).toBe(1);
    expect(qrVersionFor(14)).toBe(1);
    expect(qrVersionFor(15)).toBe(2);
    expect(qrVersionFor(50)).toBe(4);
    expect(qrVersionFor(200)).toBe(10);
    expect(qrVersionFor(213)).toBe(10);
    expect(qrVersionFor(214)).toBeUndefined();
  });
});

/** Per version at level M (test copy of the standard's table): ECC per block, data codewords per block. */
const BLOCKS: Record<number, { ecc: number; blocks: number[] }> = {
  1: { ecc: 10, blocks: [16] },
  2: { ecc: 16, blocks: [28] },
  4: { ecc: 18, blocks: [32, 32] },
  7: { ecc: 18, blocks: [31, 31, 31, 31] },
  10: { ecc: 26, blocks: [43, 43, 43, 43, 44] },
};
const ALIGN: Record<number, number[]> = { 1: [], 2: [6, 18], 4: [6, 26], 7: [6, 22, 38], 10: [6, 28, 50] };
const MASK = [
  (x: number, y: number) => (x + y) % 2 === 0,
  (_x: number, y: number) => y % 2 === 0,
  (x: number) => x % 3 === 0,
  (x: number, y: number) => (x + y) % 3 === 0,
  (x: number, y: number) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x: number, y: number) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x: number, y: number) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x: number, y: number) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** Which modules are not data: finders with separators, timing, alignment, format and version areas, the dark module. */
function functionModules(version: number): boolean[][] {
  const n = 17 + 4 * version;
  const f = Array.from({ length: n }, () => new Array<boolean>(n).fill(false));
  const box = (x0: number, y0: number, w: number, h: number) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) f[y][x] = true;
  };
  box(0, 0, 9, 9);
  box(n - 8, 0, 8, 9);
  box(0, n - 8, 9, 8);
  box(6, 0, 1, n);
  box(0, 6, n, 1);
  const c = ALIGN[version];
  const last = c[c.length - 1];
  const corner = (a: number, b: number) => (a === 6 && b === 6) || (a === 6 && b === last) || (a === last && b === 6);
  for (const ax of c) for (const ay of c) if (!corner(ax, ay)) box(ax - 2, ay - 2, 5, 5);
  if (version >= 7) {
    box(n - 11, 0, 3, 6);
    box(0, n - 11, 6, 3);
  }
  return f;
}

/** Reads `m` back: its format (mask), then the data bytes, checking every block's ECC. */
function decode(m: boolean[][], version: number): { mask: number; text: string } {
  const n = m.length;
  expect(n).toBe(17 + 4 * version);
  // Format, first copy: (8,0..5), (8,7), (8,8), (7,8), (5..0, 8): bit i at these positions.
  const pos: [number, number][] = [];
  for (let i = 0; i <= 5; i++) pos.push([8, i]);
  pos.push([8, 7], [8, 8], [7, 8]);
  for (let i = 9; i < 15; i++) pos.push([14 - i, 8]);
  let format = 0;
  pos.forEach(([x, y], i) => (format |= (m[y][x] ? 1 : 0) << i));
  const mask = [0, 1, 2, 3, 4, 5, 6, 7].find((k) => formatBits(k) === format);
  expect(mask).toBeDefined();
  // Second copy agrees.
  let second = 0;
  for (let i = 0; i < 8; i++) second |= (m[8][n - 1 - i] ? 1 : 0) << i;
  for (let i = 8; i < 15; i++) second |= (m[n - 15 + i][8] ? 1 : 0) << i;
  expect(second).toBe(format);
  expect(m[n - 8][8]).toBe(true);

  const fixed = functionModules(version);
  const bits: boolean[] = [];
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < n; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const y = ((right + 1) & 2) === 0 ? n - 1 - vert : vert;
        if (!fixed[y][x]) bits.push(m[y][x] !== MASK[mask as number](x, y));
      }
    }
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | (b ? 1 : 0), 0));
  const { ecc, blocks } = BLOCKS[version];
  const data = blocks.map(() => [] as number[]);
  let k = 0;
  for (let i = 0; i < Math.max(...blocks); i++) for (let b = 0; b < blocks.length; b++) if (i < blocks[b]) data[b].push(bytes[k++]);
  const eccs = blocks.map(() => [] as number[]);
  for (let i = 0; i < ecc; i++) for (let b = 0; b < blocks.length; b++) eccs[b].push(bytes[k++]);
  data.forEach((d, b) => expect(reedSolomon(d, ecc)).toEqual(eccs[b]));

  const stream = data.flat().flatMap((b) => bin(b, 8).split('').map((c) => c === '1'));
  const read = (from: number, len: number) => stream.slice(from, from + len).reduce((a, b) => (a << 1) | (b ? 1 : 0), 0);
  expect(read(0, 4)).toBe(0b0100);
  const cc = version <= 9 ? 8 : 16;
  const count = read(4, cc);
  const out = Array.from({ length: count }, (_, i) => read(4 + cc + 8 * i, 8));
  return { mask: mask as number, text: new TextDecoder().decode(new Uint8Array(out)) };
}

const finderAt = (m: boolean[][], x0: number, y0: number) => {
  for (let y = 0; y < 7; y++) {
    for (let x = 0; x < 7; x++) {
      const d = Math.max(Math.abs(x - 3), Math.abs(y - 3));
      expect(m[y0 + y][x0 + x]).toBe(d !== 2);
    }
  }
};

describe('qrMatrix', () => {
  it.each([
    ['short', 'https://a.ex', 1],
    ['17 bytes', 'https://a.example', 2],
    ['50 bytes', `https://${'x'.repeat(42)}`, 4],
    ['version 7', `https://${'y'.repeat(100)}`, 7],
    ['200 bytes', `https://${'z'.repeat(192)}`, 10],
    ['non-ASCII', 'https://ex.example/€ü', 2],
  ])('encodes %s so it reads back', (_name, text, version) => {
    const m = qrMatrix(text);
    const n = 17 + 4 * version;
    expect(m).toHaveLength(n);
    expect(m.every((row) => row.length === n)).toBe(true);
    finderAt(m, 0, 0);
    finderAt(m, n - 7, 0);
    finderAt(m, 0, n - 7);
    for (let i = 8; i < n - 8; i++) {
      expect(m[6][i]).toBe(i % 2 === 0);
      expect(m[i][6]).toBe(i % 2 === 0);
    }
    expect(decode(m, version).text).toBe(text);
  });

  it('writes the version information from version 7', () => {
    const m = qrMatrix(`https://${'y'.repeat(100)}`);
    const n = m.length;
    const bits = versionBits(7);
    for (let i = 0; i < 18; i++) {
      const on = ((bits >>> i) & 1) === 1;
      expect(m[Math.floor(i / 3)][n - 11 + (i % 3)]).toBe(on);
      expect(m[n - 11 + (i % 3)][Math.floor(i / 3)]).toBe(on);
    }
  });

  it('throws past 213 bytes', () => {
    expect(() => qrMatrix('x'.repeat(213))).not.toThrow();
    expect(() => qrMatrix('x'.repeat(214))).toThrow(/too long/);
  });
});

describe('qrSvg', () => {
  it('draws black modules on white with a quiet zone', () => {
    const svg = qrSvg('https://a.ex');
    const size = 21 + 8;
    expect(svg).toMatch(new RegExp(`^<svg xmlns="http://www.w3.org/2000/svg" width="${size * 6}" height="${size * 6}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">`));
    expect(svg).toContain('fill="#fff"');
    expect(svg).toContain('M4,4h1v1h-1z');
    expect(svg).not.toContain('a.ex');
    expect(qrSvg('https://a.ex', 2)).toContain(`width="${size * 2}"`);
  });
});
