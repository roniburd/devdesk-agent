import { open } from 'node:fs/promises';

/** The last `bytes` of a file as text, where it starts, and the file's size and mtime; undefined when unreadable. */
export async function readTailText(path: string, bytes: number): Promise<{ text: string; start: number; size: number; mtimeMs: number } | undefined> {
  try {
    const file = await open(path, 'r');
    try {
      const { size, mtimeMs } = await file.stat();
      const start = Math.max(0, size - bytes);
      const buffer = Buffer.alloc(size - start);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
      return { text: buffer.subarray(0, bytesRead).toString('utf8'), start, size, mtimeMs };
    } finally {
      await file.close();
    }
  } catch {
    return undefined;
  }
}

/** The last `bytes` of a transcript as lines (the first, cut mid-line, dropped), and the file's size; undefined when unreadable. */
export async function readTail(path: string, bytes: number): Promise<{ lines: string[]; bytes: number } | undefined> {
  const tail = await readTailText(path, bytes);
  if (!tail) return undefined;
  const lines = tail.text.split('\n');
  if (tail.start > 0) lines.shift(); // cut mid-line
  return { lines: lines.filter(Boolean), bytes: tail.size };
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
