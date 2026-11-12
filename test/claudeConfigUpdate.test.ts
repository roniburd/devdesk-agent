import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { updateClaudeConfig } from '../src/core/claudeConfigUpdate';

const dir = () => mkdtempSync(join(tmpdir(), 'devdesk-claude-config-'));
const addKey = (json: unknown) => ({ ...(json as object), added: true });

describe('updateClaudeConfig', () => {
  it("writes the change with Claude's formatting and the file's permissions, keeping every other key, and frees the lock", async () => {
    const file = join(dir(), '.claude.json');
    writeFileSync(file, JSON.stringify({ a: 1, projects: { '/x': { y: [1] } } }));
    chmodSync(file, 0o600);
    expect(await updateClaudeConfig(file, addKey)).toBe('written');
    const text = readFileSync(file, 'utf8');
    expect(JSON.parse(text)).toEqual({ a: 1, projects: { '/x': { y: [1] } }, added: true });
    expect(text).toBe(JSON.stringify({ a: 1, projects: { '/x': { y: [1] } }, added: true }, null, 2));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(existsSync(`${file}.lock`)).toBe(false);
    expect(readdirSync(join(file, '..'))).toEqual(['.claude.json']);
  });

  it('changes nothing when the update says so, or the file is missing or not JSON', async () => {
    const d = dir();
    const file = join(d, '.claude.json');
    expect(await updateClaudeConfig(file, addKey)).toBe('missing');
    expect(existsSync(file)).toBe(false);
    writeFileSync(file, '{"a":1}');
    expect(await updateClaudeConfig(file, () => undefined)).toBe('unchanged');
    expect(readFileSync(file, 'utf8')).toBe('{"a":1}');
    writeFileSync(file, '{"a":');
    expect(await updateClaudeConfig(file, addKey)).toBe('unreadable');
    expect(readFileSync(file, 'utf8')).toBe('{"a":');
    expect(readdirSync(d)).toEqual(['.claude.json']);
  });

  it("waits for Claude's lock, and gives up while Claude holds it (never taking it over)", async () => {
    const file = join(dir(), '.claude.json');
    writeFileSync(file, '{}');
    mkdirSync(`${file}.lock`);
    expect(await updateClaudeConfig(file, addKey, { waitMs: 60 })).toBe('busy');
    expect(existsSync(`${file}.lock`)).toBe(true);
    setTimeout(() => rmdirSync(`${file}.lock`), 50);
    expect(await updateClaudeConfig(file, addKey, { waitMs: 2000 })).toBe('written');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ added: true });
  });

  it('reads again when the file changes between the read and the write, so the other change stays', async () => {
    const file = join(dir(), '.claude.json');
    writeFileSync(file, JSON.stringify({ n: 0 }));
    let writes = 0;
    const result = await updateClaudeConfig(file, addKey, {
      beforeWrite: async () => {
        // Claude writing without the lock, once.
        if (writes++ === 0) writeFileSync(file, JSON.stringify({ n: 1, other: 'kept' }));
      },
    });
    expect(result).toBe('written');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ n: 1, other: 'kept', added: true });
  });

  it('backs off when the file keeps changing', async () => {
    const file = join(dir(), '.claude.json');
    writeFileSync(file, JSON.stringify({ n: 0 }));
    let n = 0;
    const result = await updateClaudeConfig(file, addKey, { attempts: 3, beforeWrite: async () => writeFileSync(file, JSON.stringify({ n: ++n })) });
    expect(result).toBe('changed');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ n: 3 });
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  it('writes through a link to the file it points at, keeping the link', async () => {
    const d = dir();
    const real = join(d, 'real.json');
    const file = join(d, '.claude.json');
    writeFileSync(real, '{}');
    symlinkSync(real, file);
    expect(await updateClaudeConfig(file, addKey)).toBe('written');
    expect(JSON.parse(readFileSync(real, 'utf8'))).toEqual({ added: true });
    expect(statSync(file).isFile()).toBe(true);
    expect(readdirSync(d).sort()).toEqual(['.claude.json', 'real.json']);
  });

  it('runs concurrent updates one at a time, so none is lost', async () => {
    const file = join(dir(), '.claude.json');
    writeFileSync(file, '{}');
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => updateClaudeConfig(file, (json) => ({ ...(json as object), [`k${i}`]: i }), { waitMs: 5000 })),
    );
    expect(results.every((r) => r === 'written')).toBe(true);
    expect(Object.keys(JSON.parse(readFileSync(file, 'utf8'))).sort()).toEqual(Array.from({ length: 10 }, (_, i) => `k${i}`).sort());
  });
});
