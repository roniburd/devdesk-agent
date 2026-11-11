/**
 * A small QR code encoder for the web access URL, so a phone can open it from the screen: byte mode, error correction
 * level M, versions 1–10 (up to 213 bytes), the best of the 8 masks by the standard's penalty rules. Follows ISO/IEC
 * 18004; no dependency.
 */

/** Per version 1–10 at level M: ECC codewords per block, and the data codewords of each block (short blocks first). */
const BLOCKS_M: readonly { ecc: number; blocks: readonly number[] }[] = [
  { ecc: 10, blocks: [16] },
  { ecc: 16, blocks: [28] },
  { ecc: 26, blocks: [44] },
  { ecc: 18, blocks: [32, 32] },
  { ecc: 24, blocks: [43, 43] },
  { ecc: 16, blocks: [27, 27, 27, 27] },
  { ecc: 18, blocks: [31, 31, 31, 31] },
  { ecc: 22, blocks: [38, 38, 39, 39] },
  { ecc: 22, blocks: [36, 36, 36, 37, 37] },
  { ecc: 26, blocks: [43, 43, 43, 43, 44] },
];

/** Alignment pattern centres per version (none for version 1). */
const ALIGNMENT: readonly (readonly number[])[] = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

export const QR_MAX_VERSION = 10;

const dataCodewords = (version: number) => BLOCKS_M[version - 1].blocks.reduce((a, b) => a + b, 0);
const countBits = (version: number) => (version <= 9 ? 8 : 16);

// GF(256) with the QR polynomial x^8 + x^4 + x^3 + x^2 + 1.
function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

/** The Reed–Solomon error correction codewords of `data` (`degree` of them). */
export function reedSolomon(data: readonly number[], degree: number): number[] {
  // The generator polynomial (x - 2^0)(x - 2^1)…(x - 2^(degree-1)), leading 1 dropped.
  const divisor = new Array<number>(degree).fill(0);
  divisor[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      divisor[j] = gfMultiply(divisor[j], root);
      if (j + 1 < degree) divisor[j] ^= divisor[j + 1];
    }
    root = gfMultiply(root, 2);
  }
  const result = new Array<number>(degree).fill(0);
  for (const b of data) {
    const factor = b ^ (result.shift() as number);
    result.push(0);
    for (let i = 0; i < degree; i++) result[i] ^= gfMultiply(divisor[i], factor);
  }
  return result;
}

/** The 15 format bits (level M, `mask`), BCH-coded and masked, most significant first. */
export function formatBits(mask: number): number {
  const data = (0b00 << 3) | mask; // level M is 00
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

/** The 18 version bits (versions 7 and up), BCH-coded. */
export function versionBits(version: number): number {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

const bit = (x: number, i: number) => ((x >>> i) & 1) !== 0;

/** The smallest version that holds `n` bytes in byte mode, or undefined when none up to 10 does. */
export function qrVersionFor(n: number): number | undefined {
  for (let v = 1; v <= QR_MAX_VERSION; v++) if (4 + countBits(v) + 8 * n <= dataCodewords(v) * 8) return v;
  return undefined;
}

/** The data codewords, padded, then split into blocks with their ECC, interleaved. */
function codewords(bytes: Uint8Array, version: number): number[] {
  const bits: boolean[] = [];
  const push = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push(bit(value, i));
  };
  push(0b0100, 4);
  push(bytes.length, countBits(version));
  for (const b of bytes) push(b, 8);
  const capacity = dataCodewords(version) * 8;
  push(0, Math.min(4, capacity - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | (b ? 1 : 0), 0));

  const { ecc, blocks } = BLOCKS_M[version - 1];
  const split: number[][] = [];
  let at = 0;
  for (const size of blocks) {
    split.push(data.slice(at, at + size));
    at += size;
  }
  const eccs = split.map((b) => reedSolomon(b, ecc));
  const out: number[] = [];
  const longest = Math.max(...blocks);
  for (let i = 0; i < longest; i++) for (const b of split) if (i < b.length) out.push(b[i]);
  for (let i = 0; i < ecc; i++) for (const e of eccs) out.push(e[i]);
  return out;
}

const MASKS: readonly ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

class QrSymbol {
  readonly size: number;
  readonly dark: boolean[][];
  readonly fixed: boolean[][];

  constructor(readonly version: number) {
    this.size = 17 + 4 * version;
    this.dark = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.fixed = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.drawFunctionPatterns();
  }

  private set(x: number, y: number, dark: boolean): void {
    this.dark[y][x] = dark;
    this.fixed[y][x] = true;
  }

  private drawFunctionPatterns(): void {
    const n = this.size;
    for (let i = 0; i < n; i++) {
      this.set(6, i, i % 2 === 0);
      this.set(i, 6, i % 2 === 0);
    }
    for (const [cx, cy] of [
      [3, 3],
      [n - 4, 3],
      [3, n - 4],
    ]) {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || x >= n || y < 0 || y >= n) continue;
          const d = Math.max(Math.abs(dx), Math.abs(dy));
          this.set(x, y, d !== 2 && d !== 4);
        }
      }
    }
    const centres = ALIGNMENT[this.version - 1];
    const last = centres.length - 1;
    for (let i = 0; i < centres.length; i++) {
      for (let j = 0; j < centres.length; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) this.set(centres[i] + dx, centres[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
    this.drawFormat(0); // reserves the format areas; drawn again with the chosen mask
    if (this.version >= 7) {
      const bits = versionBits(this.version);
      for (let i = 0; i < 18; i++) {
        const a = n - 11 + (i % 3);
        const b = Math.floor(i / 3);
        this.set(a, b, bit(bits, i));
        this.set(b, a, bit(bits, i));
      }
    }
  }

  drawFormat(mask: number): void {
    const n = this.size;
    const bits = formatBits(mask);
    for (let i = 0; i <= 5; i++) this.set(8, i, bit(bits, i));
    this.set(8, 7, bit(bits, 6));
    this.set(8, 8, bit(bits, 7));
    this.set(7, 8, bit(bits, 8));
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(bits, i));
    for (let i = 0; i < 8; i++) this.set(n - 1 - i, 8, bit(bits, i));
    for (let i = 8; i < 15; i++) this.set(8, n - 15 + i, bit(bits, i));
    this.set(8, n - 8, true); // the dark module
  }

  drawCodewords(data: readonly number[]): void {
    const n = this.size;
    let i = 0;
    for (let right = n - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < n; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? n - 1 - vert : vert;
          if (this.fixed[y][x] || i >= data.length * 8) continue;
          this.dark[y][x] = bit(data[i >>> 3], 7 - (i & 7));
          i++;
        }
      }
    }
  }

  applyMask(mask: number): void {
    const m = MASKS[mask];
    for (let y = 0; y < this.size; y++) for (let x = 0; x < this.size; x++) if (!this.fixed[y][x] && m(x, y)) this.dark[y][x] = !this.dark[y][x];
  }

  /** The standard's penalty score (N1–N4): lower is easier to scan. */
  penalty(): number {
    const n = this.size;
    const d = this.dark;
    let score = 0;
    const lines: boolean[][] = [...d, ...d.map((_, x) => d.map((row) => row[x]))];
    const finderLike = [true, false, true, true, true, false, true];
    for (const line of lines) {
      for (let i = 0; i < n; ) {
        let j = i;
        while (j < n && line[j] === line[i]) j++;
        if (j - i >= 5) score += 3 + (j - i - 5);
        i = j;
      }
      for (let i = 0; i + 7 <= n; i++) {
        if (!finderLike.every((v, k) => line[i + k] === v)) continue;
        const lightBefore = i >= 4 && [1, 2, 3, 4].every((k) => !line[i - k]);
        const lightAfter = i + 11 <= n && [7, 8, 9, 10].every((k) => !line[i + k]);
        if (lightBefore) score += 40;
        if (lightAfter) score += 40;
      }
    }
    for (let y = 0; y + 1 < n; y++) {
      for (let x = 0; x + 1 < n; x++) {
        const c = d[y][x];
        if (c === d[y][x + 1] && c === d[y + 1][x] && c === d[y + 1][x + 1]) score += 3;
      }
    }
    const darkCount = d.reduce((a, row) => a + row.filter(Boolean).length, 0);
    const total = n * n;
    score += (Math.ceil(Math.abs(darkCount * 20 - total * 10) / total) - 1) * 10;
    return score;
  }
}

/** QR modules (true = dark) for `text` as UTF-8 bytes: byte mode, ECC M, smallest version 1–10, best of the 8 masks. Throws when too long (> 213 bytes). */
export function qrMatrix(text: string): boolean[][] {
  const bytes = new TextEncoder().encode(text);
  const version = qrVersionFor(bytes.length);
  if (version === undefined) throw new Error(`too long for a QR code here: ${bytes.length} bytes (at most 213)`);
  const data = codewords(bytes, version);
  let best: QrSymbol | undefined;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const s = new QrSymbol(version);
    s.drawCodewords(data);
    s.applyMask(mask);
    s.drawFormat(mask);
    const score = s.penalty();
    if (score < bestScore) {
      best = s;
      bestScore = score;
    }
  }
  return (best as QrSymbol).dark.map((row) => [...row]);
}

/** An SVG (4-module quiet zone, black on white, shape-rendering crispEdges) of qrMatrix(text). */
export function qrSvg(text: string, moduleSize = 6): string {
  const m = qrMatrix(text);
  const quiet = 4;
  const size = m.length + 2 * quiet;
  const px = size * moduleSize;
  let path = '';
  m.forEach((row, y) => row.forEach((dark, x) => dark && (path += `M${x + quiet},${y + quiet}h1v1h-1z`)));
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">` +
    `<rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`
  );
}
