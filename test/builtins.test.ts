import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BUILTINS, classifySubmission, isPromptKind, type KnownCommand } from '../src/core/builtins';

const known: KnownCommand[] = [
  { name: 'superpowers:brainstorming', aliases: ['brainstorming'] },
  { name: 'code-review', aliases: ['review'] },
  { name: 'deep-research' },
  { name: 'init' },
];
const classify = (text: string) => classifySubmission(text, BUILTINS, known);

describe('BUILTINS', () => {
  it('names each command and alias once', () => {
    const names = BUILTINS.flatMap((b) => [b.name, ...b.aliases]);
    expect(new Set(names).size).toBe(names.length);
  });

  it('keeps removed and unavailable commands only as blocked, with a reason', () => {
    for (const name of ['vim', 'pr-comments', 'fast', 'design', 'login', 'logout']) {
      const b = BUILTINS.find((c) => c.name === name);
      expect(b?.category, name).toBe('E');
      expect(b?.reason, name).toBeTruthy();
    }
    expect(BUILTINS.filter((b) => b.category === 'E' && !b.reason)).toEqual([]);
    // Bundled prompt skills (review is /code-review's alias) are the CLI's, not the catalog's.
    expect(BUILTINS.some((b) => b.name === 'review' || b.aliases.includes('review'))).toBe(false);
  });

  it('has the categories the board handles', () => {
    const of = (name: string) => BUILTINS.find((b) => b.name === name)?.category;
    expect(['model', 'effort', 'clear', 'help', 'resume'].map(of)).toEqual(['A', 'A', 'A', 'A', 'A']);
    expect(['plan', 'add-dir'].map(of)).toEqual(['B', 'B']);
    expect(['compact', 'usage', 'rename', 'diff'].map(of)).toEqual(['C', 'C', 'C', 'C']);
    expect(['permissions', 'config', 'plugin', 'tui'].map(of)).toEqual(['D', 'D', 'D', 'D']);
  });

  it('has a category for every built-in the CLI lists that is not a prompt', () => {
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/initialize.json', import.meta.url), 'utf8'));
    const cli: { name: string; builtin?: boolean }[] = fixture.response.response.commands;
    // Bundled skills, workflows and prompt commands (REPORT.md section 5): category F, by design not in the catalog.
    const prompts = new Set(['deep-research', 'dataviz', 'update-config', 'verify', 'debug', 'code-review', 'simplify', 'batch',
      'fewer-permission-prompts', 'doctor', 'loop', 'claude-api', 'workflow-authoring', 'run', 'run-skill-generator',
      'plugin-authoring', 'init', 'security-review', 'insights', 'team-onboarding']);
    // `/__remote-workflow` cannot be typed as a command: names start with a letter or number.
    const missing = cli.filter((c) => c.builtin && !prompts.has(c.name) && !c.name.startsWith('_') && !BUILTINS.some((b) => b.name === c.name)).map((c) => c.name);
    expect(missing).toEqual([]);
    expect(classify('/autocompact 200000')).toMatchObject({ kind: 'C', command: 'autocompact', arg: '200000' });
    expect(classify('/peers')).toMatchObject({ kind: 'C', command: 'list-agents', alias: 'peers' });
    expect(classify('/auto-mode-setup').kind).toBe('E');
  });

  // Interactive built-ins the CLI leaves out of its headless list: without a row they read as unknown, with a warning
  // about a paid turn, and "Send as text anyway" ran them in a new session on an empty conversation.
  it.each([
    ['/branch try-it', 'D', 'branch'],
    ['/import codex', 'D', 'import'],
    ['/advisor opus', 'D', 'advisor'],
    ['/subtask look at the logs', 'C', 'subtask'],
    ['/background', 'E', 'background'],
    ['/bg', 'E', 'background'],
    ['/workflows', 'E', 'workflows'],
  ])('has a category for %s, which the CLI does not list headless', (text, kind, command) => {
    const s = classifySubmission(text, BUILTINS, []);
    expect(s).toMatchObject({ kind, command });
    if (kind === 'E') expect(s.builtin?.reason).toBeTruthy();
  });
});

describe('classifySubmission', () => {
  it('treats text that does not start with a command as a prompt', () => {
    expect(classify('fix the build')).toEqual({ kind: 'text', arg: 'fix the build' });
    expect(classify('  please run /model later ')).toEqual({ kind: 'text', arg: 'please run /model later' });
    expect(classify('/usr/bin/env is missing').kind).toBe('text');
    expect(classify('/').kind).toBe('text');
    expect(classify('').kind).toBe('text');
  });

  it('warns on a /name with letters outside ASCII instead of reading it as a prompt', () => {
    expect(classify('/café explain')).toMatchObject({ kind: 'unknown', command: 'café', arg: 'explain' });
    expect(classify('/model—sonnet')).toMatchObject({ kind: 'unknown', command: 'model—sonnet' });
    expect(classify('/日本語')).toMatchObject({ kind: 'unknown', command: '日本語' });
    expect(classify('/usr/bin/café is missing').kind).toBe('text');
  });

  it('finds built-ins by name and alias, with what follows as the argument', () => {
    expect(classify('/model')).toMatchObject({ kind: 'A', command: 'model', arg: '' });
    expect(classify('/model   ')).toMatchObject({ kind: 'A', command: 'model', arg: '' });
    expect(classify('/model sonnet')).toMatchObject({ kind: 'A', command: 'model', arg: 'sonnet' });
    expect(classify('/model claude-opus-5-5[1m]')).toMatchObject({ kind: 'A', arg: 'claude-opus-5-5[1m]' });
    expect(classify('/effort ultracode on')).toMatchObject({ kind: 'A', command: 'effort', arg: 'ultracode on' });
    expect(classify('/cost')).toMatchObject({ kind: 'C', command: 'usage', alias: 'cost', arg: '' });
    expect(classify('/new')).toMatchObject({ kind: 'A', command: 'clear', alias: 'new' });
    expect(classify('/Model Opus').command).toBe('model');
    expect(classify('/plan migrate the db\nto v2')).toMatchObject({ kind: 'B', command: 'plan', arg: 'migrate the db\nto v2' });
    expect(classify('/login')).toMatchObject({ kind: 'E', command: 'login' });
    expect(classify('/login').builtin?.reason).toBeTruthy();
  });

  it('passes skills, workflows and prompt commands through, by name or alias', () => {
    expect(classify('/superpowers:brainstorming a cache')).toEqual({ kind: 'F', command: 'superpowers:brainstorming', arg: 'a cache' });
    expect(classify('/brainstorming a cache')).toMatchObject({ kind: 'F', command: 'superpowers:brainstorming', alias: 'brainstorming' });
    expect(classify('/review 123')).toMatchObject({ kind: 'F', command: 'code-review', alias: 'review', arg: '123' });
    // Stacked skills: the first decides.
    expect(classify('/deep-research /init why')).toMatchObject({ kind: 'F', command: 'deep-research', arg: '/init why' });
  });

  it('calls anything else unknown, as typed', () => {
    expect(classify('/doesnotexist now')).toEqual({ kind: 'unknown', command: 'doesnotexist', arg: 'now' });
    expect(classifySubmission('/init', BUILTINS, []).kind).toBe('unknown');
  });

  it('says which kinds are prompts (Ultracode and Spec apply)', () => {
    expect(['F', 'text'].every((k) => isPromptKind(k as 'F'))).toBe(true);
    expect(['A', 'B', 'C', 'D', 'E', 'unknown'].some((k) => isPromptKind(k as 'A'))).toBe(false);
  });
});
