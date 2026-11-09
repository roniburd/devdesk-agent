import { open } from 'node:fs/promises';

/** The last `bytes` of a transcript as lines (the first, cut mid-line, dropped), and the file's size; undefined when unreadable. */
export async function readTail(path: string, bytes: number): Promise<{ lines: string[]; bytes: number } | undefined> {
  try {
    const file = await open(path, 'r');
    try {
      const { size } = await file.stat();
      const start = Math.max(0, size - bytes);
      const buffer = Buffer.alloc(size - start);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
      const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
      if (start > 0) lines.shift(); // cut mid-line
      return { lines: lines.filter(Boolean), bytes: size };
    } finally {
      await file.close();
    }
  } catch {
    return undefined;
  }
}

/** The first `bytes` of a transcript as whole lines (the last, cut mid-line, dropped); empty when unreadable. */
export async function readHead(path: string, bytes: number): Promise<string[]> {
  try {
    const file = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(bytes);
      const { bytesRead } = await file.read(buffer, 0, bytes, 0);
      const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
      if (bytesRead === bytes) lines.pop(); // cut mid-line
      return lines.filter(Boolean);
    } finally {
      await file.close();
    }
  } catch {
    return [];
  }
}
