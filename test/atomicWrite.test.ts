import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeFileAtomic } from '../src/core/atomicWrite';

let base: string | undefined;
afterEach(async () => {
  if (base) await rm(base, { recursive: true, force: true });
  base = undefined;
});

describe('writeFileAtomic', () => {
  it('creates the directory, replaces the file and leaves no temporary file', async () => {
    base = await mkdtemp(join(tmpdir(), 'devdesk-atomic-'));
    const file = join(base, 'a', 'b.json');
    await writeFileAtomic(file, 'one');
    await Promise.all([writeFileAtomic(file, 'two', true), writeFileAtomic(file, 'two', true)]);
    expect(await readFile(file, 'utf8')).toBe('two');
    expect(await readdir(join(base, 'a'))).toEqual(['b.json']);
  });
});
