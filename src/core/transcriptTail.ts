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

export interface BackwardRead {
  /** The file's size when the read started. */
  size: number;
  /** How many bytes were read, from the end. */
  bytes: number;
  /** The read reached the start of the file (and fed its first line). */
  complete: boolean;
}

const NEWLINE = 0x0a;

/**
 * Feeds the lines of a file to `visit` from the last to the first, reading `chunkBytes` at a time from the end, until
 * `visit` returns false, the start of the file, or `maxBytes` read. A line longer than `maxLine` bytes is never decoded
 * (nor held whole): `visit` gets undefined for it instead. Lines are split at bytes, so UTF-8 characters stay whole. A
 * line cut by `maxBytes` is not fed. Each chunk is read on its own `await`, so a long read does not hold the event loop.
 * Undefined when the file cannot be read.
 */
export async function readLinesBackward(
  path: string,
  options: { maxBytes: number; maxLine: number; chunkBytes?: number },
  visit: (line: string | undefined) => boolean,
): Promise<BackwardRead | undefined> {
  const chunkBytes = Math.max(1, options.chunkBytes ?? 4 * 1024 * 1024);
  const feed = (data: Buffer, from: number, to: number): boolean => visit(to - from > options.maxLine ? undefined : data.toString('utf8', from, to));
  let file;
  try {
    file = await open(path, 'r');
  } catch {
    return undefined;
  }
  try {
    const { size } = await file.stat();
    const floor = Math.max(0, size - Math.max(0, options.maxBytes));
    let pos = size;
    /** The end of a line whose start is in an earlier chunk. */
    let carry: Buffer = Buffer.alloc(0);
    /** The line being carried grew too long: drop its bytes up to the newline before it. */
    let skipping = false;
    const stopped = () => ({ size, bytes: size - pos, complete: false });
    while (pos > floor) {
      const start = Math.max(floor, pos - chunkBytes);
      const chunk = Buffer.alloc(pos - start);
      const { bytesRead } = await file.read(chunk, 0, chunk.length, start);
      if (bytesRead < chunk.length) return stopped(); // the file shrank while read
      pos = start;
      let data: Buffer;
      if (skipping) {
        const last = chunk.lastIndexOf(NEWLINE);
        if (last < 0) continue;
        skipping = false;
        if (!visit(undefined)) return stopped();
        data = chunk.subarray(0, last + 1);
      } else data = carry.length ? Buffer.concat([chunk, carry]) : chunk;
      // The lines after each newline, last first; what is before the first newline continues in the earlier chunk.
      let end = data.length;
      for (;;) {
        const nl = end > 0 ? data.lastIndexOf(NEWLINE, end - 1) : -1;
        if (nl < 0) break;
        if (end > nl + 1 && !feed(data, nl + 1, end)) return stopped();
        end = nl;
      }
      skipping = end > options.maxLine;
      carry = skipping ? Buffer.alloc(0) : Buffer.from(data.subarray(0, end));
    }
    if (pos > 0) return stopped();
    // At the start of the file, what is carried is the first line.
    if (skipping) visit(undefined);
    else if (carry.length) feed(carry, 0, carry.length);
    return { size, bytes: size, complete: true };
  } catch {
    return undefined;
  } finally {
    await file.close();
  }
}
