import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { commandRow, isInternal, menuCommands, needsArgument, runsFromMenu, slashTrigger } from '../src/core/commandMenu';
import { filterCommands, parseCliCommands, type SlashCommand, withBuiltins } from '../src/core/slashCommands';

/** The `/` list a 2.1.316 CLI gives on Bedrock, with the board's catalog (see cliStream.test.ts). */
const fixture = JSON.parse(readFileSync(new URL('./fixtures/initialize.json', import.meta.url), 'utf8'));
const listed = withBuiltins(parseCliCommands(fixture.response.response.commands)!);
const menu = (query: string, stacked = false) => filterCommands(menuCommands(listed, stacked), query).map(commandRow);
const row = (query: string, label: string, stacked = false) => menu(query, stacked).find((r) => r.label === label);

describe('filterCommands', () => {
  it('matches nothing for a query of only separators, instead of listing every command', () => {
    for (const q of ['_', '-', ':', '--', '_:-']) expect(menu(q)).toEqual([]);
    expect(menu('').length).toBeGreaterThan(0);
  });
});

describe('commandRow', () => {
  it('shows an alias as typed, saying what it stands for, and inserts the name', () => {
    expect(row('cost', '/cost')).toMatchObject({ insert: '/usage ', detail: 'alias of /usage', alias: 'cost', category: 'C', badge: 'session', run: true });
    expect(row('cost', '/usage')).toBeUndefined();
  });

  it('badges what the board does: board (A), session (C), terminal (D), unavailable (E); none for skills', () => {
    expect(row('model', '/model')).toMatchObject({ category: 'A', badge: 'board', run: true, hint: '[model]' });
    expect(row('hooks', '/hooks')).toMatchObject({ category: 'D', badge: 'terminal', run: true });
    expect(row('exit', '/exit')).toMatchObject({ category: 'E', badge: 'unavailable' });
    const skill = row('brainstorm', '/superpowers:brainstorming')!;
    expect(skill.category).toBeUndefined();
    expect(skill.badge).toBeUndefined();
    expect(skill.run).toBeUndefined();
    // A plugin's command already names its origin.
    expect(skill.detail).toBeUndefined();
  });

  it('inserts commands that need an argument instead of running them', () => {
    expect(row('plan', '/plan')).toMatchObject({ category: 'B', hint: '<task>' });
    expect(row('plan', '/plan')!.run).toBeUndefined();
    expect(row('btw', '/btw')!.run).toBeUndefined();
    // An optional argument does not stop Enter, though the CLI's hint says `<…>`.
    expect(row('compact', '/compact')).toMatchObject({ run: true, hint: '<optional custom summarization instructions>' });
    // The board's own commands show what the board accepts, not what Claude would.
    expect(row('effort', '/effort')!.hint).toBe('[low|medium|high|xhigh|max|auto|ultracode [on|off]]');
    expect(row('clear', '/clear')!.hint).toBeUndefined();
  });
});

describe('menu order', () => {
  const builtIn = (q: string) => menu(q).filter((r) => !r.label.includes(':'));

  it('lists names before aliases, so Enter on /u or /s does not run what an alias stands for', () => {
    const u = menu('u').map((r) => r.label);
    expect(u.slice(0, 2)).toEqual(['/update-config', '/usage']);
    // `/update` stands for the blocked `/restart`.
    expect(u.indexOf('/update')).toBeGreaterThan(u.indexOf('/usage'));
    expect(menu('s')[0].label).not.toBe('/settings');
    expect(menu('re')[0].label).not.toBe('/reset');
    // Among the rows that start with `p` (later-word matches such as `/fewer-permission-prompts` come after).
    const p = builtIn('p').filter((r) => r.label.startsWith('/p'));
    const names = p.filter((r) => !r.alias);
    expect(p.slice(0, names.length)).toEqual(names);
  });

  it('orders ties by the label shown', () => {
    for (const q of ['u', 's', 'p', 're']) {
      const rows = builtIn(q);
      // The ones that run before the blocked (E) ones, then names before aliases.
      const runs = rows.filter((r) => r.category !== 'E');
      const blocked = rows.filter((r) => r.category === 'E');
      for (const group of [runs.filter((r) => !r.alias), runs.filter((r) => r.alias), blocked.filter((r) => !r.alias), blocked.filter((r) => r.alias)]) {
        const labels = group.map((r) => r.label);
        // Exact matches and later-word matches rank apart; within names that start with the query, by label.
        const starts = labels.filter((l) => l.slice(1).toLowerCase().replace(/[:_-]/g, '').startsWith(q));
        expect(starts).toEqual([...starts].sort());
      }
    }
  });
});

describe('needsArgument and runsFromMenu', () => {
  it('tells a required argument from an optional one', () => {
    expect(needsArgument('<task>')).toBe(true);
    expect(needsArgument(' <path>')).toBe(true);
    expect(needsArgument('[model]')).toBe(false);
    expect(needsArgument(undefined)).toBe(false);
  });

  it('runs A, C and D commands from the menu, and E ones, whose explanation then shows at once', () => {
    const c = (category: SlashCommand['category'], name = 'x'): SlashCommand => ({ name, description: '', origin: 'built-in', category });
    expect(['A', 'B', 'C', 'D', 'E', 'F', undefined].map((k) => runsFromMenu(c(k as SlashCommand['category'])))).toEqual([true, false, true, true, true, false, false]);
    expect(runsFromMenu(c('C', 'btw'))).toBe(false);
  });

  it('runs blocked (E) built-ins from the menu, so Enter on /login shows why at once', () => {
    expect(row('login', '/login')).toMatchObject({ category: 'E', badge: 'unavailable', run: true });
    expect(row('exit', '/exit')).toMatchObject({ category: 'E', run: true });
  });
});

describe('menuCommands', () => {
  it('lists names that start with the query before a later word, and no substrings', () => {
    const labels = (q: string, stacked = false) => menu(q, stacked).map((r) => r.label);
    expect(labels('mode')[0]).toBe('/model');
    // What runs before the blocked (E) `/restart` and `/exit`, then names before aliases (`/reset` stands for `/clear`).
    expect(labels('res').slice(0, 3)).toEqual(['/resume', '/reset', '/restart']);
    expect(labels('ex').slice(0, 2)).toEqual(['/export', '/exit']);
    expect(labels('mo')[0]).toBe('/model');
    // The built-ins before any plugin skill, even one whose bare name starts with the query (`codedeploy-triage`).
    const co = labels('co');
    const firstCore = co.findIndex((l) => l.startsWith('/acme-'));
    expect(firstCore).toBeGreaterThan(0);
    for (const l of ['/compact', '/context', '/cost', '/config']) {
      expect(co).toContain(l);
      expect(co.indexOf(l)).toBeLessThan(firstCore);
    }
    expect(labels('st')[0]).toBe('/status');
    // Only the start of a word matches, as MANUAL.md says: not the middle of one.
    expect(labels('st')).not.toContain('/fast');
    expect(labels('st')).not.toContain('/restart');
    expect(labels('us')).not.toContain('/focus');
    expect(labels('us')).toContain('/usage');
    expect(labels('cod', true)[0]).toBe('/code-review');
  });

  it('keeps the built-ins a one-letter query finds, though fifty plugin skills start with it', () => {
    const labels = menu('a').map((r) => r.label);
    for (const l of ['/add-dir', '/agents', '/autocompact', '/auto-mode-setup', '/allowed-tools']) expect(labels).toContain(l);
    // Built-ins first among the names that start with the query; plugin skills after them.
    const firstCore = labels.findIndex((l) => l.startsWith('/acme-'));
    expect(labels.indexOf('/allowed-tools')).toBeLessThan(firstCore);
  });

  it('lists every command for a bare /, built-ins before skills', () => {
    const labels = menu('').map((r) => r.label);
    expect(labels).toEqual(expect.arrayContaining(['/model', '/clear', '/compact', '/help', '/superpowers:brainstorming']));
    expect(labels).toHaveLength(menuCommands(listed).filter((c) => !c.hidden).length);
    const firstCore = labels.findIndex((l) => l.startsWith('/acme-'));
    expect(labels.indexOf('/workflow-authoring')).toBeLessThan(firstCore);
    expect(labels.slice(0, 3)).toEqual(['/add-dir', '/advisor', '/agents']);
  });

  it('never offers internal commands, not even by their full name', () => {
    expect(isInternal('__remote-workflow')).toBe(true);
    expect(isInternal('workflow-launch-exec')).toBe(true);
    expect(isInternal('workflow')).toBe(false);
    expect(menu('workflow-launch-exec').map((r) => r.label)).not.toContain('/workflow-launch-exec');
    expect(menu('').some((r) => r.label.startsWith('/__'))).toBe(false);
  });

  it('hides what the wrapper turns off until the full name is typed', () => {
    expect(menu('log').map((r) => r.label)).not.toContain('/login');
    expect(row('login', '/login')).toMatchObject({ badge: 'unavailable' });
  });

  it('offers only skills and prompt commands after other commands (stacked)', () => {
    const stacked = menu('', true);
    expect(stacked.length).toBeGreaterThan(0);
    expect(stacked.every((r) => !r.category)).toBe(true);
    expect(row('brainstorm', '/superpowers:brainstorming', true)).toBeDefined();
    expect(row('model', '/model', true)).toBeUndefined();
  });
});

describe('slashTrigger', () => {
  it('finds the / word at the very start', () => {
    expect(slashTrigger('/')).toEqual({ start: 0, query: '', stacked: false });
    expect(slashTrigger('/rev')).toEqual({ start: 0, query: 'rev', stacked: false });
    expect(slashTrigger('/superpowers:bra')).toEqual({ start: 0, query: 'superpowers:bra', stacked: false });
  });

  it('finds a stacked skill after other commands, up to six in all', () => {
    expect(slashTrigger('/review /sec')).toEqual({ start: 8, query: 'sec', stacked: true });
    expect(slashTrigger('/a /b /')).toEqual({ start: 6, query: '', stacked: true });
    expect(slashTrigger('/a /b /c /d /e /f')).toEqual({ start: 15, query: 'f', stacked: true });
    expect(slashTrigger('/a /b /c /d /e /f /g')).toEqual({ start: 18, query: 'g', stacked: true, inline: true });
  });

  it('finds a skill in the middle of the text, after whitespace', () => {
    expect(slashTrigger('fix it then /simp')).toEqual({ start: 12, query: 'simp', stacked: true, inline: true });
    expect(slashTrigger('fix /usr')).toEqual({ start: 4, query: 'usr', stacked: true, inline: true });
    expect(slashTrigger('/review fix /se')).toEqual({ start: 12, query: 'se', stacked: true, inline: true });
    expect(slashTrigger('first line\n/')).toEqual({ start: 11, query: '', stacked: true, inline: true });
  });

  it('is not a command inside a word or a path', () => {
    expect(slashTrigger('and/or')).toBeUndefined();
    expect(slashTrigger('see src/core')).toBeUndefined();
    expect(slashTrigger('fix /usr/bin')).toBeUndefined();
    expect(slashTrigger('/review ')).toBeUndefined();
    expect(slashTrigger('/usr/bin')).toBeUndefined();
    expect(slashTrigger('')).toBeUndefined();
  });

  it('stacks only after skills, not after a built-in the board handles (/clear /, /model /, /exit /)', () => {
    expect(slashTrigger('/clear /')).toBeUndefined();
    expect(slashTrigger('/model /')).toBeUndefined();
    expect(slashTrigger('/exit /')).toBeUndefined();
    expect(slashTrigger('/Quit /si')).toBeUndefined();
    expect(slashTrigger('/review /clear /')).toBeUndefined();
    expect(slashTrigger('/review /simplify /')).toEqual({ start: 18, query: '', stacked: true });
    expect(slashTrigger('/model fix it /si')).toBeUndefined();
    expect(slashTrigger('/btw why /si')).toBeUndefined();
  });
});
