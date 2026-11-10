import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

/** Every `devdesk.*` setting's contributed default, from package.json. */
const contributed = new Map<string, unknown>();
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
for (const section of [pkg.contributes.configuration].flat()) {
  for (const [key, schema] of Object.entries<{ default?: unknown }>(section.properties)) contributed.set(key.replace(/^devdesk\./, ''), schema.default);
}

/** How the mocked settings answer: as if nothing were set and VS Code had no defaults, or with package.json's defaults. */
let mode: 'unset' | 'contributed' = 'unset';
const reads: { key: string; fallback: unknown; hasFallback: boolean }[] = [];

vi.mock('vscode', () => ({
  window: { createOutputChannel: () => ({ info() {}, warn() {}, error() {}, debug() {}, trace() {}, appendLine() {}, dispose() {} }) },
  workspace: {
    workspaceFolders: undefined,
    getConfiguration: () => ({
      get: (key: string, ...rest: unknown[]) => {
        reads.push({ key, fallback: rest[0], hasFallback: rest.length > 0 });
        if (mode === 'contributed' && contributed.has(key)) return contributed.get(key) ?? rest[0];
        return rest[0];
      },
      update: async () => {},
    }),
  },
  commands: { executeCommand: async () => {} },
  ConfigurationTarget: { Global: 1 },
}));

const config = await import('../src/config');

/** The settings getters: exported functions that take no arguments and return data (not a runner). */
const getters = (Object.entries(config) as [string, unknown][]).filter(
  (e): e is [string, () => unknown] => typeof e[1] === 'function' && e[1].length === 0 && !['cfg', 'sessionsTmux'].includes(e[0]),
);

function call(m: typeof mode, f: () => unknown): unknown {
  mode = m;
  try {
    return f();
  } finally {
    mode = 'unset';
  }
}

describe('config.ts defaults', () => {
  it('finds the getters', () => {
    expect(getters.length).toBeGreaterThan(60);
  });

  it.each(getters)('%s gives the same value with the package.json defaults as with nothing set', (_name, f) => {
    expect(call('contributed', f)).toEqual(call('unset', f));
  });

  it('every fallback passed to a setting read equals its package.json default', () => {
    reads.length = 0;
    for (const [, f] of getters) call('unset', f);
    const read = new Set(reads.map((r) => r.key));
    // The public copy drops the workspace-kind settings from package.json (scripts/public.mjs removeSettings), and still reads them.
    const publicRemoved = new Set(['worktrees.kind', 'worktrees.createCommand', 'worktrees.deleteCommand']);
    expect([...read].filter((k) => !contributed.has(k) && !publicRemoved.has(k))).toEqual([]);
    const differ = reads.filter((r) => r.hasFallback && r.fallback !== contributed.get(r.key)).map((r) => `${r.key}: ${String(r.fallback)} vs ${String(contributed.get(r.key))}`);
    expect([...new Set(differ)]).toEqual([]);
  });
});
