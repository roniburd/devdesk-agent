import { mkdtempSync, readFileSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileLockBusy, withFileLock } from '../src/core/fileLock';

const dir = () => mkdtempSync(join(tmpdir(), 'devdesk-lock-'));

describe('withFileLock', () => {
  it('runs read-modify-writes one at a time, so none is lost', async () => {
    const file = join(dir(), 'n.txt');
    writeFileSync(file, '0');
    await Promise.all(
      Array.from({ length: 20 }, () =>
        withFileLock(file, async () => {
          const n = Number(readFileSync(file, 'utf8'));
          await new Promise((r) => setTimeout(r, 2));
          writeFileSync(file, String(n + 1));
        }),
      ),
    );
    expect(readFileSync(file, 'utf8')).toBe('20');
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  it('takes over a stale lock and gives up on a fresh one', async () => {
    const file = join(dir(), 'f.json');
    writeFileSync(`${file}.lock`, 'someone');
    await expect(withFileLock(file, async () => 1, { waitMs: 50 })).rejects.toBeInstanceOf(FileLockBusy);
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${file}.lock`, old, old);
    expect(await withFileLock(file, async () => 2, { waitMs: 50 })).toBe(2);
  });

  it('with waitMs 0 gives up at once on a fresh lock and takes over a stale one', async () => {
    const file = join(dir(), 'once.json');
    writeFileSync(`${file}.lock`, 'someone');
    const started = Date.now();
    await expect(withFileLock(file, async () => 1, { waitMs: 0 })).rejects.toBeInstanceOf(FileLockBusy);
    expect(Date.now() - started).toBeLessThan(500);
    expect(readFileSync(`${file}.lock`, 'utf8')).toBe('someone');
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${file}.lock`, old, old);
    expect(await withFileLock(file, async () => 2, { waitMs: 0 })).toBe(2);
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  it('releases the lock when fn throws', async () => {
    const file = join(dir(), 'x.json');
    await expect(withFileLock(file, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(existsSync(`${file}.lock`)).toBe(false);
  });
});
