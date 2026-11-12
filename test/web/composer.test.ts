import { describe, expect, it } from 'vitest';
import type { CliListing } from '../../src/core/cliStream';
import { DEFAULT_MODES } from '../../src/core/modes';
import type { SlashCommand } from '../../src/core/slashCommands';
import { claudeInvocationOf, composerResponse, launchArgs, webModels } from '../../src/core/web/composer';
import { ComposerCache, LISTING_TTL_MS, RETRY_MS } from '../../src/core/web/composerCache';
import type { DaemonConfig } from '../../src/core/web/config';
import { boxAction, slashMenu } from '../../src/core/web/promptBox';
import type { ComposerResponse } from '../../src/core/web/types';

const claude: DaemonConfig['claude'] = { path: 'claude', modeArgs: '--permission-mode auto', env: {}, modes: [...DEFAULT_MODES], defaultMode: 'Auto', models: [], configDir: '/h/.claude' };

const listing: CliListing = {
  commands: [
    { name: 'review', description: 'Review a PR', origin: 'built-in' },
    { name: 'superpowers:brainstorming', description: 'Design first', origin: 'superpowers', aliases: ['brainstorming'] },
    { name: '__internal', description: '', origin: 'built-in' },
  ],
  models: [
    { value: 'default', displayName: 'Default', description: '', efforts: ['low', 'high'] },
    { value: 'global.opus', displayName: 'Opus', description: 'Opus 5.5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { value: 'router', displayName: 'Router', description: 'A Bedrock router', efforts: [] },
  ],
};
const onDisk: SlashCommand[] = [{ name: 'deploy', description: 'Ship it', origin: 'project' }];

describe('composerResponse', () => {
  it('offers the CLI commands, the disk ones it lacks and the built-ins, without internal ones', () => {
    const r = composerResponse({ claude, listing, onDisk, pending: false });
    const names = r.commands.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['review', 'superpowers:brainstorming', 'deploy', 'model', 'plan', 'compact']));
    expect(names).not.toContain('__internal');
    expect(names).not.toContain('workflow-launch-exec');
    expect(r.commands.find((c) => c.name === 'model')).toMatchObject({ category: 'A', origin: 'built-in' });
    expect(r.commands.find((c) => c.name === 'deploy')).toEqual({ name: 'deploy', description: 'Ship it', origin: 'project' });
  });

  it("gives the CLI's models after Default, the modes, the default and the plan mode", () => {
    const r = composerResponse({ claude, listing, onDisk: [], pending: false });
    expect(r.models.map((m) => [m.value, m.label, m.efforts])).toEqual([
      ['Default', 'Default', ['low', 'high']],
      ['global.opus', 'Opus', ['low', 'medium', 'high', 'xhigh', 'max']],
      ['router', 'Router', []],
    ]);
    expect(r.modes.map((m) => m.name)).toEqual(DEFAULT_MODES.map((m) => m.name));
    expect(r).toMatchObject({ defaultMode: 'Auto', planMode: 'Plan', listing: false });
  });

  it("has only the disk commands and Claude's aliases while the CLI has not answered", () => {
    const r = composerResponse({ claude, listing: undefined, onDisk, pending: true });
    expect(r.listing).toBe(true);
    expect(r.models.map((m) => m.value)).toEqual(['Default', 'opus', 'sonnet', 'haiku', 'fable', 'opus[1m]', 'sonnet[1m]', 'fable[1m]']);
    expect(r.commands.map((c) => c.name)).toContain('deploy');
  });

  it('uses devdesk.board.models instead of the CLI list, and the default mode alone when no modes were passed', () => {
    const r = composerResponse({ claude: { path: 'claude', modeArgs: '--x', env: {}, models: ['Default', 'sonnet'] }, listing, onDisk: [], pending: false });
    expect(r.models.map((m) => m.value)).toEqual(['Default', 'sonnet']);
    expect(r.modes).toEqual([{ name: 'Default', description: '--x' }]);
    expect(r.planMode).toBeUndefined();
  });
});

describe('launchArgs', () => {
  const models = webModels(claude, listing);

  it("is the default mode's arguments with nothing chosen", () => {
    expect(launchArgs({}, claude, models)).toEqual({ args: '--permission-mode auto' });
  });

  it('takes a listed mode, model and effort, quoted', () => {
    expect(launchArgs({ mode: 'Plan', model: 'global.opus', effort: 'max' }, claude, models)).toEqual({ args: "--permission-mode plan --model 'global.opus' --effort 'max'" });
    expect(launchArgs({ model: 'opus[1m]' }, claude, models)).toEqual({ args: "--permission-mode auto --model 'opus[1m]'" });
  });

  it('refuses anything not offered, so the page cannot pass arguments of its own', () => {
    expect(launchArgs({ mode: 'Root' }, claude, models)).toHaveProperty('error');
    expect(launchArgs({ model: "x'; rm -rf ~" }, claude, models)).toHaveProperty('error');
    expect(launchArgs({ model: '--dangerously-skip-permissions' }, claude, models)).toHaveProperty('error');
    expect(launchArgs({ model: 'global.opus', effort: 'turbo' }, claude, models)).toHaveProperty('error');
    expect(launchArgs({ model: 'router', effort: 'low' }, claude, models)).toEqual({ error: 'Router takes no effort level.' });
    expect(launchArgs({ effort: 'max' }, claude, models)).toEqual({ error: 'Default does not take effort max.' });
  });
});

describe('claudeInvocationOf', () => {
  it("is a full command's first word, else the binary with its arguments", () => {
    expect(claudeInvocationOf({ command: 'clauded --x; exec zsh' })).toBe('clauded');
    expect(claudeInvocationOf({ path: '/bin/claude', args: '--verbose' })).toBe('/bin/claude --verbose');
    expect(claudeInvocationOf({})).toBe('$HOME/.toolbox/bin/claude');
  });
});

describe('ComposerCache', () => {
  const setup = () => {
    let now = 0;
    const asks: string[] = [];
    let answer: ((l: CliListing | undefined) => void) | undefined;
    const cache = new ComposerCache({
      list: (dir) => {
        asks.push(dir);
        return new Promise((r) => (answer = r));
      },
      disk: async () => onDisk,
      now: () => now,
    });
    return { cache, asks, answer: (l: CliListing | undefined) => answer!(l), at: (t: number) => (now = t) };
  };
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it('asks the CLI once per folder, pending until it answers, then keeps the listing for 5 minutes', async () => {
    const c = setup();
    expect(await c.cache.get('/w')).toEqual({ listing: undefined, onDisk, pending: true });
    await c.cache.get('/w');
    expect(c.asks).toEqual(['/w']);
    c.answer(listing);
    await tick();
    expect(await c.cache.get('/w')).toMatchObject({ listing, pending: false });
    expect(c.cache.listing('/w')).toBe(listing);
    c.at(LISTING_TTL_MS - 1);
    await c.cache.get('/w');
    expect(c.asks).toHaveLength(1);
    c.at(LISTING_TTL_MS + 1);
    expect(await c.cache.get('/w')).toMatchObject({ listing, pending: false });
    expect(c.asks).toHaveLength(2);
  });

  it('asks again after 30 s when the CLI did not answer', async () => {
    const c = setup();
    await c.cache.get('/w');
    c.answer(undefined);
    await tick();
    expect(await c.cache.get('/w')).toMatchObject({ pending: false });
    c.at(RETRY_MS + 1);
    await c.cache.get('/w');
    expect(c.asks).toHaveLength(2);
  });
});

describe('the prompt box', () => {
  const info: ComposerResponse = composerResponse({ claude, listing, onDisk, pending: false });
  const o = { commands: info.commands, models: info.models, planMode: info.planMode, choice: { mode: 'Auto', model: 'Default', effort: 'Default' } };

  it('opens the / menu at the start and for stacked skills, filtered', () => {
    const all = slashMenu('/', info.commands)!;
    expect(all.start).toBe(0);
    expect(all.rows.length).toBeGreaterThan(20);
    expect(slashMenu('/mod', info.commands)!.rows[0]).toMatchObject({ label: '/model', insert: '/model ', category: 'A', badge: 'board' });
    expect(slashMenu('/brain', info.commands)!.rows[0]).toMatchObject({ label: '/superpowers:brainstorming', insert: '/superpowers:brainstorming ' });
    const stacked = slashMenu('/deploy /', info.commands)!;
    expect(stacked.start).toBe(8);
    expect(stacked.rows.every((r) => !r.category)).toBe(true);
    expect(slashMenu('fix it', info.commands)).toBeUndefined();
    // Only what this box can do: no running-session or blocked commands, no /resume or /add-dir.
    const names = slashMenu('/', info.commands)!.rows.map((r) => r.label);
    expect(names).toEqual(expect.arrayContaining(['/model', '/effort', '/plan', '/permissions', '/review']));
    for (const n of ['/compact', '/exit', '/resume', '/add-dir']) expect(names).not.toContain(n);
  });

  it('starts on a prompt, a skill or an interactive command', () => {
    expect(boxAction('fix the tests', o)).toEqual({ kind: 'start', prompt: 'fix the tests' });
    expect(boxAction('', o)).toEqual({ kind: 'start', prompt: '' });
    expect(boxAction('/BRAINSTORMING a cache', o)).toEqual({ kind: 'start', prompt: '/brainstorming a cache' });
    expect(boxAction('/permissions', o)).toEqual({ kind: 'start', prompt: '/permissions' });
  });

  it('sets the pills with /model and /effort', () => {
    expect(boxAction('/model opus', o)).toEqual({ kind: 'set', model: 'global.opus', note: 'Model: Opus.' });
    expect(boxAction('/model sonnet', o)).toEqual({ kind: 'set', model: 'sonnet', note: 'Model: sonnet.' });
    expect(boxAction('/model nope', o)).toMatchObject({ kind: 'notice' });
    expect(boxAction('/effort high', o)).toEqual({ kind: 'set', effort: 'high', note: 'Effort: high.' });
    expect(boxAction('/effort auto', o)).toEqual({ kind: 'set', effort: 'Default', note: 'Effort: Default.' });
    expect(boxAction('/effort max', o)).toEqual({ kind: 'notice', text: 'The effort levels are low, high, or auto.' });
    expect(boxAction('/effort low', { ...o, choice: { ...o.choice, model: 'router' } })).toEqual({ kind: 'notice', text: 'Router takes no effort level.' });
  });

  it('starts /plan <task> in the plan mode, and clears with /clear', () => {
    expect(boxAction('/plan add a cache', o)).toEqual({ kind: 'start', prompt: 'add a cache', mode: 'Plan' });
    expect(boxAction('/plan', o)).toMatchObject({ kind: 'notice' });
    expect(boxAction('/plan x', { ...o, planMode: undefined })).toMatchObject({ kind: 'notice' });
    expect(boxAction('/clear', o)).toEqual({ kind: 'clear' });
  });

  it("says why a running session's, a blocked or an unknown command does not start, and sends an unknown one when confirmed", () => {
    expect(boxAction('/compact', o)).toEqual({ kind: 'notice', text: '/compact works in a running session: open it and type it in its reply box.' });
    expect(boxAction('/exit', o)).toMatchObject({ kind: 'notice', text: expect.stringContaining('does not run from Web Access') });
    expect(boxAction('/add-dir /x', o)).toMatchObject({ kind: 'notice' });
    expect(boxAction('/frobnicate', o)).toMatchObject({ kind: 'notice', confirm: true });
    expect(boxAction('/frobnicate', { ...o, confirmed: true })).toEqual({ kind: 'start', prompt: '/frobnicate' });
  });
});
