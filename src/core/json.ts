import { open, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** `text` parsed as JSON when it is an object (or array), else undefined. */
export function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** The text of the file at `path`; undefined when it does not exist. Throws when it exists but cannot be read. */
export async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

/** The JSON object in the file at `path`; undefined when it is missing, unreadable or not an object. */
export async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    return parseObject(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Each file in `dir` whose name passes `accept`, as `parse` reads it; unreadable files and those `parse` rejects or throws on are skipped. */
export async function readJsonFiles<T>(dir: string, accept: (name: string) => boolean, parse: (text: string) => T | undefined | Promise<T | undefined>): Promise<T[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const values = await Promise.all(
    names.filter(accept).map(async (n) => {
      try {
        return await parse(await readFile(join(dir, n), 'utf8'));
      } catch {
        return undefined;
      }
    }),
  );
  return values.filter((v): v is Awaited<T> => v !== undefined);
}

export const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** `v` when it is a positive number, else 0 (a token count). */
export const positiveNumber = (v: unknown): number => (isFiniteNumber(v) && v > 0 ? v : 0);

const NEWLINE = 0x0a;

/**
 * The lines of a file that only grows (a transcript), fed as it grows. A trailing partial line waits for the next chunk;
 * lines are split at bytes, so a UTF-8 character cut between chunks stays whole. Empty lines are skipped.
 */
export abstract class LineScan {
  /** How many bytes of the file were fed. */
  offset = 0;
  /** A partial line longer than this is dropped, and the rest of it skipped up to its newline (Infinity: never). */
  protected maxLine = Infinity;
  private rest: Buffer = Buffer.alloc(0);
  private skipping = false;

  feed(chunk: Buffer | string): void {
    let bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    this.offset += bytes.length;
    if (this.skipping) {
      const newline = bytes.indexOf(NEWLINE);
      if (newline < 0) return;
      this.skipping = false;
      bytes = bytes.subarray(newline + 1);
    }
    const data = this.rest.length ? Buffer.concat([this.rest, bytes]) : bytes;
    const end = data.lastIndexOf(NEWLINE);
    // A huge line grows `rest` chunk by chunk (each concat copies it all): drop it instead.
    const keep = (tail: Buffer) => {
      this.skipping = tail.length > this.maxLine;
      this.rest = this.skipping ? Buffer.alloc(0) : Buffer.from(tail);
    };
    if (end < 0) return keep(data);
    keep(data.subarray(end + 1));
    // Split at bytes, so a line over `maxLine` is dropped before it is decoded.
    for (let start = 0; start <= end; ) {
      const newline = data.indexOf(NEWLINE, start);
      if (newline > start && newline - start <= this.maxLine) this.line(data.toString('utf8', start, newline));
      start = newline + 1;
    }
  }

  /** Bytes fed up to the end of the last complete line: where to read again from to see the partial line whole. */
  get settled(): number {
    return this.offset - this.rest.length;
  }

  protected abstract line(line: string): void;
}

const CHUNK = 4 * 1024 * 1024;

/**
 * A `LineScan` per file, kept across reads so each read feeds only what was appended since the last one. A file that
 * shrank (rewritten) is scanned again from the start.
 */
export class GrowingFiles<S extends LineScan> {
  private readonly scans = new Map<string, S>();
  private touched = new Set<string>();

  constructor(private readonly create: () => S) {}

  /** The file's scan as last read, without reading it. */
  peek(path: string): S | undefined {
    return this.scans.get(path);
  }

  /** The file's scan, up to its current end; what was read before when it is gone or unreadable (undefined if nothing was). */
  async read(path: string): Promise<S | undefined> {
    this.touched.add(path);
    let scan = this.scans.get(path);
    try {
      const file = await open(path, 'r');
      try {
        const { size } = await file.stat();
        if (!scan || size < scan.offset) {
          scan = this.create();
          this.scans.set(path, scan);
        }
        while (scan.offset < size) {
          const buffer = Buffer.alloc(Math.min(CHUNK, size - scan.offset));
          const { bytesRead } = await file.read(buffer, 0, buffer.length, scan.offset);
          if (!bytesRead) break;
          scan.feed(buffer.subarray(0, bytesRead));
        }
      } finally {
        await file.close();
      }
    } catch {
      // Gone or unreadable: keep what was read before.
    }
    return scan;
  }

  /** Forgets files not read since the last call (sessions that went away). */
  prune(): void {
    for (const path of this.scans.keys()) if (!this.touched.has(path)) this.scans.delete(path);
    this.touched = new Set();
  }

  /** Forgets a file (read again from the start next time). */
  forget(path: string): void {
    this.scans.delete(path);
  }

  /** Forgets every file not in `keep`. */
  retain(keep: ReadonlySet<string>): void {
    for (const path of this.scans.keys()) if (!keep.has(path)) this.scans.delete(path);
  }
}
