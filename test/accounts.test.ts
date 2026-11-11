import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  accountConfigFile,
  accountDirs,
  accountEnv,
  accountNamed,
  accountOfTranscript,
  configDirOfTranscript,
  DEFAULT_ACCOUNT_NAME,
  defaultAccount,
  normalizeDir,
  parseAccounts,
  pickAccount,
  withEnv,
  worstStatus,
} from '../src/core/accounts';
import { parseKeptChoice } from '../src/core/boardKept';
import { parseChoice } from '../src/core/composer';
import { changedTranscripts } from '../src/core/usage';

const HOME = '/home/me';
const AMBIENT = '/home/me/.claude';

describe('parseAccounts', () => {
  it('is the one default account, Claude’s own config directory, when none is listed', () => {
    for (const raw of [undefined, [], 'x', [{}], [{ name: 'a' }]]) {
      expect(parseAccounts(raw, AMBIENT, HOME)).toEqual([{ name: DEFAULT_ACCOUNT_NAME, configDir: AMBIENT, ambient: true, env: {} }]);
    }
  });

  it('expands ~, normalizes the directory, and marks the one that is Claude’s own as ambient', () => {
    const accounts = parseAccounts(
      [
        { name: ' personal ', configDir: '~/.claude/' },
        { name: 'work', configDir: '~/.claude-work', env: { AWS_PROFILE: 'work', N: 3, BAD_NAME$: 'x', CLAUDE_CONFIG_DIR: '/elsewhere', obj: {} } },
      ],
      AMBIENT,
      HOME,
    );
    expect(accounts).toEqual([
      { name: 'personal', configDir: AMBIENT, ambient: true, env: {} },
      { name: 'work', configDir: '/home/me/.claude-work', ambient: false, env: { AWS_PROFILE: 'work', N: '3' } },
    ]);
  });

  it('skips relative directories and a second account with the same name or directory', () => {
    const accounts = parseAccounts(
      [
        { name: 'a', configDir: '/x/a' },
        { name: 'A', configDir: '/x/b' },
        { name: 'b', configDir: '/x/a/' },
        { name: 'c', configDir: 'relative/dir' },
        { name: 'd', configDir: '/x/d' },
      ],
      AMBIENT,
      HOME,
    );
    expect(accounts.map((a) => a.name)).toEqual(['a', 'd']);
  });
});

describe('picking an account', () => {
  const accounts = parseAccounts(
    [
      { name: 'personal', configDir: '~/.claude' },
      { name: 'Work', configDir: '/w' },
    ],
    AMBIENT,
    HOME,
  );

  it('names one case-insensitively', () => {
    expect(accountNamed(accounts, 'work')?.configDir).toBe('/w');
    expect(accountNamed(accounts, '')).toBeUndefined();
    expect(accountNamed(accounts, 'nope')).toBeUndefined();
  });

  it('defaults to devdesk.claude.defaultAccount, else the first listed', () => {
    expect(defaultAccount(accounts, 'work').name).toBe('Work');
    expect(defaultAccount(accounts, '').name).toBe('personal');
    expect(defaultAccount(accounts, 'gone').name).toBe('personal');
  });

  it('takes the chosen one, else the default (an account removed since)', () => {
    expect(pickAccount(accounts, 'Work', undefined).name).toBe('Work');
    expect(pickAccount(accounts, 'removed', 'work').name).toBe('Work');
    expect(pickAccount(accounts, undefined, undefined).name).toBe('personal');
  });

  it('reads every account’s directory and Claude’s own, once each', () => {
    expect(accountDirs(accounts, AMBIENT)).toEqual([AMBIENT, '/w']);
    expect(accountDirs(parseAccounts([{ name: 'w', configDir: '/w' }], AMBIENT, HOME), AMBIENT)).toEqual(['/w', AMBIENT]);
  });
});

describe('a session’s account from its transcript', () => {
  const accounts = parseAccounts([{ name: 'work', configDir: '/w' }], AMBIENT, HOME);

  it('is the config directory the transcript is in', () => {
    expect(configDirOfTranscript('/w/projects/-ws-app/1234.jsonl')).toBe('/w');
    expect(configDirOfTranscript('/w/projects/-ws-app/1234/subagents/agent-1.jsonl')).toBe('/w');
    expect(configDirOfTranscript('/w/elsewhere/1234.jsonl')).toBeUndefined();
    expect(configDirOfTranscript(undefined)).toBeUndefined();
  });

  it('is the listed account, else one named after the directory (so a resume keeps using it)', () => {
    expect(accountOfTranscript(accounts, '/w/projects/p/s.jsonl', AMBIENT)?.name).toBe('work');
    expect(accountOfTranscript(accounts, `${AMBIENT}/projects/p/s.jsonl`, AMBIENT, () => '~/.claude')).toEqual({ name: '~/.claude', configDir: AMBIENT, ambient: true, env: {} });
    expect(accountOfTranscript(accounts, undefined, AMBIENT)).toBeUndefined();
  });
});

describe('a session’s environment', () => {
  const [personal, work] = parseAccounts(
    [
      { name: 'personal', configDir: '~/.claude', env: { A: '1' } },
      { name: 'work', configDir: '/w', env: { AWS_PROFILE: "it's" } },
    ],
    AMBIENT,
    HOME,
  );

  it('sets CLAUDE_CONFIG_DIR only for an account that is not Claude’s own', () => {
    expect(accountEnv(personal)).toEqual({ A: '1' });
    expect(accountEnv(work)).toEqual({ AWS_PROFILE: "it's", CLAUDE_CONFIG_DIR: '/w' });
    expect(accountEnv(undefined)).toEqual({});
  });

  it('exports it, quoted, in front of the whole command', () => {
    expect(withEnv('claude; exec $SHELL -l', accountEnv(work))).toBe(`export AWS_PROFILE='it'\\''s' CLAUDE_CONFIG_DIR='/w'; claude; exec $SHELL -l`);
    expect(withEnv('claude', {})).toBe('claude');
    expect(withEnv('claude', { 'bad name': 'x' })).toBe('claude');
  });

  it('reads trust from the account’s .claude.json, or the configured file for Claude’s own', () => {
    expect(accountConfigFile(personal, '/home/me/.claude.json')).toBe('/home/me/.claude.json');
    expect(accountConfigFile(work, '/home/me/.claude.json')).toBe('/w/.claude.json');
  });
});

describe('the board’s account choice', () => {
  const allowed = { modes: ['Default'], defaultMode: 'Default', models: ['Default'], worktrees: [], accounts: ['personal', 'work'] };

  it('keeps a listed account, and drops one that is not (any more) or when there is only one', () => {
    expect(parseChoice({ account: 'work' }, allowed).account).toBe('work');
    expect(parseChoice({ account: 'gone' }, allowed).account).toBeUndefined();
    expect(parseChoice({ account: 'work' }, { ...allowed, accounts: ['work'] }).account).toBeUndefined();
    expect(parseChoice({}, allowed).account).toBeUndefined();
  });

  it('is remembered per project folder with the other choices; choices saved before accounts still load', () => {
    expect(parseKeptChoice({ model: 'opus', account: 'work' })).toEqual({ model: 'opus', account: 'work' });
    expect(parseKeptChoice({ model: 'opus' })).toEqual({ model: 'opus' });
    expect(parseKeptChoice({ account: 3 })).toEqual({});
  });
});

describe('helpers', () => {
  it('normalizes directories', () => {
    expect(normalizeDir('~', HOME)).toBe(HOME);
    expect(normalizeDir('/a//b/', HOME)).toBe('/a/b');
    expect(normalizeDir('/', HOME)).toBe('/');
    expect(normalizeDir('', HOME)).toBeUndefined();
    expect(normalizeDir(3, HOME)).toBeUndefined();
  });

  it('reports the status that needs the most doing', () => {
    expect(worstStatus(['installed', 'missing', 'outdated'])).toBe('missing');
    expect(worstStatus(['installed', 'outdated'])).toBe('outdated');
    expect(worstStatus(['installed'])).toBe('installed');
    expect(worstStatus([])).toBe('installed');
  });
});

describe('reading every account’s transcripts', () => {
  it('lists the changed transcripts of each projects folder', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devdesk-accounts-'));
    try {
      for (const [dir, id] of [
        ['personal', 'a'],
        ['work', 'b'],
      ]) {
        await mkdir(join(root, dir, 'projects', '-ws'), { recursive: true });
        await writeFile(join(root, dir, 'projects', '-ws', `${id}.jsonl`), `${JSON.stringify({ timestamp: '2026-11-01T10:00:00Z' })}\n`);
      }
      const files = await changedTranscripts([join(root, 'personal', 'projects'), join(root, 'work', 'projects'), join(root, 'missing')], 0);
      expect(files.map((f) => f.sessionId).sort()).toEqual(['a', 'b']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
