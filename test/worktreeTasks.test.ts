import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { SessionCard } from '../src/core/sessions';
import {
  DEFAULT_START_PROMPT,
  failureSummary,
  groupCards,
  parseWorktreeTasks,
  renderStartPrompt,
  serializeWorktreeTasks,
  type WorktreeTask,
  worktreeSlug,
} from '../src/core/worktreeTasks';
import { prefillArg, promptArg, shellQuote } from '../src/core/shell';
import { claudeShellCommand } from '../src/core/tmux';

describe('worktreeSlug', () => {
  it('lowercases and turns runs of other characters into single dashes', () => {
    expect(worktreeSlug('Fix: login times out after 30s!', [])).toBe('fix-login-times-out-after-30s');
  });

  it('cuts long tasks at a dash boundary within 40 characters', () => {
    const slug = worktreeSlug('Add a worktree button to the Claude view that names the worktree after the task', []);
    expect(slug).toBe('add-a-worktree-button-to-the-claude-view');
    expect(slug.length).toBeLessThanOrEqual(40);
  });

  it('cuts mid-word when there is no dash to cut at', () => {
    expect(worktreeSlug('a'.repeat(60), [])).toBe('a'.repeat(40));
  });

  it('falls back to task when nothing usable is left', () => {
    expect(worktreeSlug('???', [])).toBe('task');
    expect(worktreeSlug('日本語', [])).toBe('task');
  });

  it('numbers the slug when it is taken', () => {
    expect(worktreeSlug('Fix login', ['fix-login'])).toBe('fix-login-2');
    expect(worktreeSlug('Fix login', ['fix-login', 'fix-login-2'])).toBe('fix-login-3');
  });

  it('gives names tmux and cc- sessions accept', () => {
    expect(worktreeSlug('über-cool  feature_x', [])).toMatch(/^[a-z0-9-]+$/);
  });
});

describe('renderStartPrompt', () => {
  it('fills {task}, {worktree} and {dir}', () => {
    expect(renderStartPrompt('{worktree} at {dir}: {task} ({task})', { task: 'fix it', worktree: 'fix-it', dir: '/w/fix-it' })).toBe(
      'fix-it at /w/fix-it: fix it (fix it)',
    );
  });

  it('uses the default template when the setting is empty', () => {
    const prompt = renderStartPrompt('', { task: 'fix it', worktree: 'fix-it', dir: '/w/fix-it' });
    expect(prompt).toBe(renderStartPrompt(DEFAULT_START_PROMPT, { task: 'fix it', worktree: 'fix-it', dir: '/w/fix-it' }));
    expect(prompt).toContain('worktree fix-it (/w/fix-it) on: fix it');
  });

  it('does not expand placeholders that appear in the task', () => {
    expect(renderStartPrompt('{task} / {worktree}', { task: 'mention {worktree}', worktree: 'w', dir: '/d' })).toBe('mention {worktree} / w');
  });
});

describe('failureSummary', () => {
  it('drops stack frames so the error itself shows', () => {
    const out = [
      'java.lang.RuntimeException: Invalid workspace configuration file /w/workspace.cfg: Missing \'base\' declaration.',
      '\tat com.example.tool.workspace.WorkspaceConfig.getBaseDeclaration(WorkspaceConfig.java:329)',
      '\tat com.example.tool.cli.worktree.WorktreeCli.main(WorktreeCli.java:68)',
      '\t... 3 more',
      '',
    ].join('\n');
    expect(failureSummary(out)).toBe("java.lang.RuntimeException: Invalid workspace configuration file /w/workspace.cfg: Missing 'base' declaration.");
  });

  it('keeps the last three lines', () => {
    expect(failureSummary('a\nb\nc\nd\n')).toBe('b\nc\nd');
    expect(failureSummary('  \n')).toBe('');
  });
});

describe('promptArg', () => {
  it("puts '--' before the quoted prompt, so one that starts with '-' is not an option", () => {
    expect(promptArg('- fix the bug\n- add tests')).toBe("-- '- fix the bug\n- add tests'");
    expect(promptArg('--model opus please')).toBe("-- '--model opus please'");
  });

  it('drops NUL characters, which no shell word can hold, so the rest of the prompt reaches Claude', () => {
    const out = execFileSync('/bin/sh', ['-c', `printf '%s' ${promptArg('a\u0000b nul').slice(3)}`], { encoding: 'utf8' });
    expect(out).toBe('ab nul');
  });
});

describe('prefillArg', () => {
  it('passes the draft quoted to --prefill, an option (not behind --)', () => {
    expect(prefillArg("fix the bug\nin 'auth'")).toBe(`--prefill 'fix the bug\nin '\\''auth'\\'''`);
    const out = execFileSync('/bin/sh', ['-c', `printf '%s' ${prefillArg('$HOME `x` "q"').slice('--prefill '.length)}`], { encoding: 'utf8' });
    expect(out).toBe('$HOME `x` "q"');
  });

  it('stays among the options of a full command, before its prompt and after its binary', () => {
    expect(claudeShellCommand({ command: 'claude --x; exec $SHELL -l' }, `--model opus ${prefillArg('draft')}`)).toBe("claude --model opus --prefill 'draft' --x; exec $SHELL -l");
  });
});

describe('shellQuote', () => {
  it('single-quotes, escaping single quotes', () => {
    expect(shellQuote("it's $HOME `x`")).toBe(`'it'\\''s $HOME \`x\`'`);
  });
});

describe('worktree task records', () => {
  const task: WorktreeTask = { task: 'Fix login', worktree: 'fix-login', kind: 'workspace', dir: '/ws/worktrees/fix-login', createdAt: 5 };

  it('round-trips', () => {
    expect(parseWorktreeTasks(serializeWorktreeTasks({ [task.dir]: task }))).toEqual({ [task.dir]: task });
  });

  it('ignores malformed files and entries', () => {
    expect(parseWorktreeTasks('not json')).toEqual({});
    expect(parseWorktreeTasks('[1]')).toEqual({});
    expect(parseWorktreeTasks(JSON.stringify({ '/x': { task: 3 }, [task.dir]: task }))).toEqual({ [task.dir]: task });
  });

  it('keys by the record dir, not the JSON key', () => {
    expect(parseWorktreeTasks(JSON.stringify({ '/elsewhere': task }))).toEqual({ [task.dir]: task });
  });
});

describe('groupCards', () => {
  const root = '/ws';
  const features = [
    { name: 'main', dir: root, isMain: true },
    { name: 'feat-a', dir: `${root}/worktrees/feat-a`, isMain: false },
    { name: 'feat-b', dir: `${root}/worktrees/feat-b`, isMain: false },
    { name: 'feat-c', dir: `${root}/worktrees/feat-c`, isMain: false },
  ];
  const card = (id: string, featureDir: string | undefined, updatedAt: number): SessionCard =>
    ({
      id,
      state: 'done',
      updatedAt,
      attached: false,
      featureDir,
      featureName: features.find((f) => f.dir === featureDir)?.name,
    }) as SessionCard;

  it('orders worktrees by their most urgent session (the first of the attention-ordered cards), main included', () => {
    const cards = [card('a1', features[1].dir, 10), card('m', root, 1), card('x', undefined, 50), card('b1', features[2].dir, 30), card('a2', features[1].dir, 20)];
    const groups = groupCards(cards, features, {});
    expect(groups.map((g) => [g.name, g.cards.map((c) => c.id)])).toEqual([
      ['feat-a', ['a1', 'a2']],
      ['main', ['m']],
      ['no worktree', ['x']],
      ['feat-b', ['b1']],
    ]);
    expect(groups[1].isMain).toBe(true);
    expect(groups[2].dir).toBeUndefined();
  });

  it('lists worktrees with a task record but no session after the others, newest task first', () => {
    const tasks = {
      [features[3].dir]: { task: 'Do C', worktree: 'feat-c', kind: 'workspace' as const, dir: features[3].dir, createdAt: 40 },
      [features[2].dir]: { task: 'Do B', worktree: 'feat-b', kind: 'workspace' as const, dir: features[2].dir, createdAt: 5 },
    };
    const groups = groupCards([card('a1', features[1].dir, 10)], features, tasks);
    expect(groups.map((g) => [g.name, g.task, g.cards.length])).toEqual([
      ['feat-a', undefined, 1],
      ['feat-c', 'Do C', 0],
      ['feat-b', 'Do B', 0],
    ]);
  });

  it('skips main without sessions and task records of worktrees that are gone', () => {
    const gone = `${root}/worktrees/gone`;
    expect(groupCards([], features, { [gone]: { task: 'x', worktree: 'gone', kind: 'workspace', dir: gone, createdAt: 1 } })).toEqual([]);
  });

  it('keeps a session whose worktree was not discovered under its own group', () => {
    const c = { ...card('z', '/ws/worktrees/new', 3), featureName: 'new' };
    expect(groupCards([c], features, {}).map((g) => [g.name, g.dir])).toEqual([['new', '/ws/worktrees/new']]);
  });
});
