import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUILTINS, classifySubmission } from '../src/core/builtins';
import { menuCommands } from '../src/core/commandMenu';
import {
  discoverSlashCommands,
  enabledPlugins,
  filterCommands,
  parseCliCommands,
  parseFrontMatter,
  type SlashCommand,
  withBuiltins,
  withDiskCommands,
} from '../src/core/slashCommands';

describe('parseCliCommands', () => {
  it("lists the CLI's commands with their origin and aliases", () => {
    const found = parseCliCommands([
      { name: 'superpowers:brainstorming', description: '(superpowers) Design first', argumentHint: '', aliases: ['brainstorming'] },
      { name: 'orders', description: 'Orders team skill (user)', argumentHint: '<stack>' },
      { name: 'review-pr', description: 'Review it (project)' },
      { name: 'compact', description: 'Clear history but keep a summary', aliases: ['compact', 3] },
      { name: '__remote-workflow', description: 'internal' },
      { description: 'no name' },
    ])!;
    const byName = Object.fromEntries(found.map((c) => [c.name, c]));
    expect(byName['superpowers:brainstorming']).toEqual({ name: 'superpowers:brainstorming', description: 'Design first', origin: 'superpowers', aliases: ['brainstorming'] });
    expect(byName.orders).toEqual({ name: 'orders', description: 'Orders team skill', origin: 'user', argumentHint: '<stack>' });
    expect(byName['review-pr'].origin).toBe('project');
    expect(byName.compact).toEqual({ name: 'compact', description: 'Clear history but keep a summary', origin: 'built-in' });
    expect(byName['__remote-workflow']).toBeUndefined();
    expect(found.map((c) => c.name)).toEqual(found.map((c) => c.name).sort((a, b) => a.localeCompare(b)));
  });

  it('is undefined for what is not a list', () => {
    expect(parseCliCommands('nope')).toBeUndefined();
    expect(parseCliCommands(undefined)).toBeUndefined();
  });
});

describe('withBuiltins', () => {
  it("gives the CLI's built-ins their category, and adds the ones it does not list", () => {
    const merged = withBuiltins([
      { name: 'usage', description: 'Show session cost', origin: 'built-in', aliases: ['cost', 'stats'] },
      { name: 'deep-research', description: 'Research', origin: 'built-in' },
    ]);
    const byName = Object.fromEntries(merged.map((c) => [c.name, c]));
    expect(byName.usage).toEqual({ name: 'usage', description: 'Show session cost', origin: 'built-in', aliases: ['cost', 'stats'], category: 'C' });
    expect(byName['deep-research'].category).toBeUndefined();
    expect(byName.help).toMatchObject({ category: 'A', origin: 'built-in' });
    expect(byName.vim).toMatchObject({ category: 'E', hidden: true });
    expect(merged.length).toBe(BUILTINS.length + 1);
  });

  it("keeps a user's or project's command named like a blocked (E) built-in the CLI does not have", () => {
    const all = withBuiltins(parseCliCommands([
      { name: 'pr-comments', description: 'My PR comments (user)' },
      { name: 'design', description: 'Design a page (project)' },
      { name: 'bug', description: 'File a bug (user)' },
      { name: 'status', description: 'My status (user)' },
    ])!);
    const byName = Object.fromEntries(all.map((c) => [c.name, c]));
    expect(byName['pr-comments']).toEqual({ name: 'pr-comments', description: 'My PR comments', origin: 'user' });
    expect(byName.design).toEqual({ name: 'design', description: 'Design a page', origin: 'project' });
    // The blocked built-in loses the alias the user's command took; the others stay.
    expect(byName.feedback.category).toBe('E');
    expect(byName.feedback.aliases ?? []).not.toContain('bug');
    expect(byName.bug.origin).toBe('user');
    // Only E gives way: a built-in the board handles stays the board's.
    expect(byName.status).toMatchObject({ origin: 'built-in', category: 'C' });
    expect(filterCommands(all, 'pr').map((m) => m.command.name)).toContain('pr-comments');
    expect(classifySubmission('/pr-comments 123', BUILTINS, all)).toMatchObject({ kind: 'F', command: 'pr-comments', arg: '123' });
    expect(classifySubmission('/design login page', BUILTINS, all)).toMatchObject({ kind: 'F', command: 'design' });
    expect(classifySubmission('/bug it crashed', BUILTINS, all)).toMatchObject({ kind: 'F', command: 'bug' });
    expect(classifySubmission('/vim', BUILTINS, all).kind).toBe('E');
    expect(classifySubmission('/status', BUILTINS, all).kind).toBe('C');
  });
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'slash-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function put(path: string, text: string): Promise<void> {
  await mkdir(dirname(join(dir, path)), { recursive: true });
  await writeFile(join(dir, path), text);
}

describe('parseFrontMatter', () => {
  it('reads name, description and argument hint, unquoted', () => {
    expect(parseFrontMatter('---\nname: deploy\ndescription: "Ship it"\nargument-hint: [stage]\n---\n# Deploy\nbody')).toEqual({
      name: 'deploy',
      description: 'Ship it',
      argumentHint: '[stage]',
    });
  });

  it('joins a YAML block scalar description into one line', () => {
    expect(parseFrontMatter('---\nname: x\ndescription: >-\n  Query metrics\n  for a team.\nother: y\n---\n')).toEqual({ name: 'x', description: 'Query metrics for a team.' });
    expect(parseFrontMatter('---\ndescription: |\n  One\n\n  Two\n---\n').description).toBe('One Two');
  });

  it('falls back to the first line that is not a heading', () => {
    expect(parseFrontMatter('# Title\n\nReview the diff.\nMore.')).toEqual({ description: 'Review the diff.' });
    expect(parseFrontMatter('---\nother: x\n---\nDo it')).toEqual({ description: 'Do it' });
  });
});

describe('discoverSlashCommands', () => {
  it('lists project, user and enabled plugin skills and commands; the project wins over the user', async () => {
    const claude = join(dir, 'home', '.claude');
    await put('home/.claude/skills/orders/SKILL.md', '---\ndescription: User orders\n---\n');
    await put('home/.claude/skills/shared/SKILL.md', '---\ndescription: User shared\n---\n');
    await put('home/.claude/commands/frontend/deploy.md', '---\ndescription: Deploy the frontend\nargument-hint: <stage>\n---\n');
    await put('ws/.claude/skills/shared/SKILL.md', '---\ndescription: Project shared\n---\n');
    await put('ws/.claude/commands/review.md', 'Review the change.');
    await put('plugins/sp/skills/brainstorming/SKILL.md', '---\nname: brainstorming\ndescription: Design first\n---\n');
    await put('plugins/off/skills/nope/SKILL.md', '---\ndescription: Disabled\n---\n');
    await put(
      'home/.claude/plugins/installed_plugins.json',
      JSON.stringify({ plugins: { 'superpowers@official': [{ installPath: join(dir, 'plugins/sp') }], 'off@official': [{ installPath: join(dir, 'plugins/off') }] } }),
    );
    await put('home/.claude/settings.json', JSON.stringify({ enabledPlugins: { 'superpowers@official': true, 'off@official': false } }));

    const found = await discoverSlashCommands(claude, [join(dir, 'ws')]);
    expect(found.map((c) => [c.name, c.origin, c.description])).toEqual([
      ['frontend:deploy', 'user', 'Deploy the frontend'],
      ['orders', 'user', 'User orders'],
      ['review', 'project', 'Review the change.'],
      ['shared', 'project', 'Project shared'],
      ['superpowers:brainstorming', 'superpowers', 'Design first'],
    ]);
    expect(found.find((c) => c.name === 'frontend:deploy')?.argumentHint).toBe('<stage>');
  });

  it('follows symlinked commands and skills (dotfiles managers make them)', async () => {
    await put('dotfiles/deploy.md', '---\ndescription: Linked command\n---\n');
    await put('dotfiles/linked/SKILL.md', '---\ndescription: Linked skill\n---\n');
    await mkdir(join(dir, 'home/.claude/commands'), { recursive: true });
    await mkdir(join(dir, 'home/.claude/skills'), { recursive: true });
    await symlink(join(dir, 'dotfiles/deploy.md'), join(dir, 'home/.claude/commands/deploy.md'));
    await symlink(join(dir, 'dotfiles/linked'), join(dir, 'home/.claude/skills/linked'));
    await symlink(join(dir, 'nowhere'), join(dir, 'home/.claude/commands/dangling.md'));
    const found = await discoverSlashCommands(join(dir, 'home/.claude'), []);
    expect(found.map((c) => [c.name, c.description])).toEqual([
      ['deploy', 'Linked command'],
      ['linked', 'Linked skill'],
    ]);
  });

  it('finds nothing (and does not fail) when there is nothing to read', async () => {
    expect(await discoverSlashCommands(join(dir, 'missing'), [join(dir, 'nowhere')])).toEqual([]);
    expect(await enabledPlugins(join(dir, 'missing'))).toEqual(new Map());
  });
});

describe('filterCommands', () => {
  const all: SlashCommand[] = ['code-review', 'review', 'superpowers:brainstorming', 'superpowers:writing-plans', 'orders-cr-review'].map((name) => ({
    name,
    description: '',
    origin: 'user',
  }));
  const names = (q: string, list = all) => filterCommands(list, q).map((m) => m.command.name);

  it('lists name prefixes first, then later-word prefixes, and nothing else', () => {
    expect(names('rev')).toEqual(['review', 'code-review', 'orders-cr-review']);
    expect(names('writ')).toEqual(['superpowers:writing-plans']);
    // The middle of a word does not match.
    expect(names('storm')).toEqual([]);
    expect(names('iew')).toEqual([]);
    expect(filterCommands(all, 'r', 2)).toHaveLength(2);
    // A bare `/` lists everything, built-ins first.
    const mixed: SlashCommand[] = [...all, { name: 'model', description: '', origin: 'built-in' }];
    expect(names('', mixed)).toEqual(['model', ...all.map((c) => c.name)]);
    expect(filterCommands(mixed, '', 2)).toHaveLength(6);
  });

  it('ignores : _ and - between words, and puts an exact match first', () => {
    const list = withBuiltins([]);
    expect(names('reloadsk', list)).toEqual(['reload-skills']);
    expect(names('skills', list)).toEqual(['skills', 'reload-skills']);
    expect(names('add_dir', list)).toEqual(['add-dir']);
    expect(names('review')).toEqual(['review', 'code-review', 'orders-cr-review']);
  });

  it('matches aliases, saying which', () => {
    const list = withBuiltins([]);
    expect(filterCommands(list, 'cost')).toEqual([{ command: list.find((c) => c.name === 'usage'), alias: 'cost' }]);
    expect(filterCommands(list, 'new')[0]).toMatchObject({ command: { name: 'clear' }, alias: 'new' });
    // A name match needs no alias.
    expect(filterCommands(list, 'clear')[0]).toEqual({ command: list.find((c) => c.name === 'clear') });
  });

  it('shows hidden commands only for their full name or alias', () => {
    const list = withBuiltins([]);
    expect(names('', list)).not.toContain('heapdump');
    expect(names('heap', list)).toEqual([]);
    expect(names('heapdump', list)).toEqual(['heapdump']);
    expect(names('vi', list)).not.toContain('vim');
    expect(names('bug', list)).toEqual(['feedback']);
  });

  it('lists the built-ins that run before the blocked (E) ones that match as well', () => {
    const list = menuCommands(withBuiltins(parseCliCommands([{ name: 'model' }, { name: 'compact' }, { name: 'mobile' }, { name: 'cd' }])!));
    expect(filterCommands(list, 'mo')[0].command.name).toBe('model');
    const c = names('c', list);
    expect(list.find((x) => x.name === c[0])?.category).not.toBe('E');
    expect(c.indexOf('compact')).toBeLessThan(c.indexOf('cd'));
    // An exact match still comes first.
    expect(names('cd', list)[0]).toBe('cd');
  });
});

describe('withDiskCommands', () => {
  it("adds what the folders hold that the CLI's list lacks by name or alias, sorted", () => {
    const listed: SlashCommand[] = [
      { name: 'superpowers:brainstorming', description: 'Design first', origin: 'superpowers', aliases: ['brainstorming'] },
      { name: 'review', description: 'From the CLI', origin: 'project' },
    ];
    const onDisk: SlashCommand[] = [
      { name: 'abe3-late', description: 'Added since', origin: 'project' },
      { name: 'brainstorming', description: 'Short name', origin: 'user' },
      { name: 'review', description: 'From the folder', origin: 'project' },
    ];
    const merged = withDiskCommands(listed, onDisk);
    expect(merged.map((c) => c.name)).toEqual(['abe3-late', 'review', 'superpowers:brainstorming']);
    expect(merged.find((c) => c.name === 'review')?.description).toBe('From the CLI');
    expect(classifySubmission('/abe3-late do it', BUILTINS, withBuiltins(merged)).kind).toBe('F');
  });
});
