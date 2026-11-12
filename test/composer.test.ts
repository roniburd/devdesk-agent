import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { CliStreamReader, INITIALIZE_REQUEST_ID } from '../src/core/cliStream';
import {
  aliasChoices,
  allowedModels,
  fileMention,
  choiceArgs,
  DEFAULT_MODELS,
  findModel,
  longContextRow,
  EFFORT_LEVELS,
  launchPrompt,
  missingWorktree,
  modelChoices,
  modelsStartingWith,
  modeTone,
  parseChoice,
  parseCompose,
  parseModels,
  planMode,
  SPEC_INSTRUCTION,
  specPrefix,
} from '../src/core/composer';
import { DEFAULT_MODES } from '../src/core/modes';

const allowed = {
  modes: DEFAULT_MODES.map((m) => m.name),
  defaultMode: 'Bypass (clauded)',
  models: ['Default', 'opus', 'sonnet'],
  worktrees: ['/ws/worktrees/feat-a'],
};

describe('parseCompose', () => {
  it('keeps a message that names the posted choices', () => {
    expect(
      parseCompose(
        { type: 'compose', prompt: '  fix the build  ', where: '/ws/worktrees/feat-a', mode: 'Plan', model: 'opus', effort: 'high', ultracode: true, later: true },
        allowed,
      ),
    ).toEqual({ prompt: 'fix the build', where: '/ws/worktrees/feat-a', mode: 'Plan', model: 'opus', effort: 'high', ultracode: true, later: true });
  });

  it('drops a message without a prompt', () => {
    expect(parseCompose({ prompt: '  ' }, allowed)).toBeUndefined();
    expect(parseCompose({ prompt: 3 }, allowed)).toBeUndefined();
    expect(parseCompose(null, allowed)).toBeUndefined();
  });

  it('falls back on anything it did not offer: the default mode, the first model and effort, main', () => {
    expect(parseCompose({ prompt: 'x', where: '/etc', mode: 'rm -rf', model: 'gpt', effort: 'extreme', ultracode: 'yes', later: 1 }, allowed)).toEqual({
      prompt: 'x',
      where: 'main',
      mode: 'Bypass (clauded)',
      model: 'Default',
      effort: 'Default',
      ultracode: false,
      later: false,
    });
  });

  it('names a new worktree as typed, or leaves it to be named after the prompt', () => {
    expect(parseChoice({ where: 'new', worktreeName: ' fix-it ' }, allowed)).toMatchObject({ where: 'new', worktreeName: 'fix-it' });
    expect(parseChoice({ where: 'new', worktreeName: ' ' }, allowed)).toEqual(expect.not.objectContaining({ worktreeName: expect.anything() }));
    expect(parseChoice({ where: 'new' }, allowed).where).toBe('new');
    expect(parseChoice({ where: 'main', worktreeName: 'ignored' }, allowed)).not.toHaveProperty('worktreeName');
  });
});

describe('missingWorktree', () => {
  it('names a worktree that is not offered, never main, new or a known one', () => {
    expect(missingWorktree({ where: '/ws/worktrees/gone' }, allowed)).toBe('/ws/worktrees/gone');
    expect(missingWorktree({ where: '/ws/worktrees/feat-a' }, allowed)).toBeUndefined();
    expect(missingWorktree({ where: 'main' }, allowed)).toBeUndefined();
    expect(missingWorktree({ where: 'new' }, allowed)).toBeUndefined();
    expect(missingWorktree({}, allowed)).toBeUndefined();
  });
});

describe('choiceArgs', () => {
  it('adds --model and --effort only for non-default choices, quoted', () => {
    expect(choiceArgs({ model: 'Default', effort: 'Default' })).toBe('');
    expect(choiceArgs({ model: 'opus', effort: 'Default' })).toBe("--model 'opus'");
    expect(choiceArgs({ model: "claude-opus-5-5[1m]'", effort: 'max' })).toBe("--model 'claude-opus-5-5[1m]'\\''' --effort 'max'");
  });
});

describe('launchPrompt', () => {
  it('puts a slash command prefix on the same line and an instruction above, and Ultracode last', () => {
    expect(launchPrompt('fix it')).toBe('fix it');
    expect(launchPrompt('fix it', { prefix: '/superpowers:brainstorming' })).toBe('/superpowers:brainstorming fix it');
    expect(launchPrompt('fix it', { prefix: 'Spec first.' })).toBe('Spec first.\n\nfix it');
    expect(launchPrompt('fix it', { ultracode: true })).toBe('fix it\n\nultracode');
  });

  it('keeps a skill first behind an instruction prefix, so it still runs (the buried /simplify bug)', () => {
    expect(launchPrompt('/simplify the auth module', { prefix: SPEC_INSTRUCTION })).toBe(`/simplify ${SPEC_INSTRUCTION}\n\nthe auth module`);
    expect(launchPrompt('  /simplify   the auth\nmodule ', { prefix: 'Spec first.', ultracode: true })).toBe('/simplify Spec first.\n\nthe auth\nmodule\n\nultracode');
    expect(launchPrompt('/simplify', { prefix: 'Spec first.' })).toBe('/simplify Spec first.');
    expect(launchPrompt('/usr/bin is slow', { prefix: 'Spec first.' })).toBe('Spec first.\n\n/usr/bin is slow');
    expect(launchPrompt('/simplify the auth module', { prefix: '/superpowers:brainstorming' })).toBe('/superpowers:brainstorming /simplify the auth module');
  });

  it('does not repeat a slash command prefix the prompt already starts with', () => {
    expect(launchPrompt('/superpowers:brainstorming a login page', { prefix: '/superpowers:brainstorming' })).toBe('/superpowers:brainstorming a login page');
    expect(launchPrompt('  /superpowers:brainstorming  ', { prefix: '/superpowers:brainstorming' })).toBe('/superpowers:brainstorming');
    expect(launchPrompt('/superpowers:brainstorming a login page', { prefix: '/superpowers:brainstorming', ultracode: true })).toBe('/superpowers:brainstorming a login page\n\nultracode');
    // Only the same command: a longer name is another one.
    expect(launchPrompt('/superpowers:brainstorming-x a login page', { prefix: '/superpowers:brainstorming' })).toBe('/superpowers:brainstorming /superpowers:brainstorming-x a login page');
  });
});

describe('specPrefix', () => {
  it('uses the setting, else the brainstorming skill when it is there, else an instruction', () => {
    expect(specPrefix(' /my:spec ', ['superpowers:brainstorming'])).toBe('/my:spec');
    expect(specPrefix('', ['review', 'superpowers:brainstorming'])).toBe('/superpowers:brainstorming');
    expect(specPrefix(undefined, ['review'])).toBe(SPEC_INSTRUCTION);
  });
});

describe('parseModels', () => {
  it('keeps non-empty strings once; none when it is not a list', () => {
    expect(parseModels(['Default', ' opus ', 'opus', '', 3])).toEqual(['Default', 'opus']);
    expect(parseModels([])).toEqual([]);
    expect(parseModels('opus')).toEqual([]);
  });
});

describe('modelChoices', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/initialize.json', import.meta.url), 'utf8'));
  fixture.response.request_id = INITIALIZE_REQUEST_ID;
  const reader = new CliStreamReader();
  reader.push(`${JSON.stringify(fixture)}\n`);
  const cli = reader.listing!.models;

  it("offers the CLI's rows by exact value after Default, without the CLI's own default row", () => {
    const rows = modelChoices([], cli);
    expect(rows[0]).toEqual({ value: 'Default', label: 'Default', description: 'The model in your Claude settings', efforts: [...EFFORT_LEVELS] });
    expect(rows.map((r) => r.value)).not.toContain('default');
    expect(rows).toHaveLength(18);
    expect(rows.find((r) => r.value === 'global.anthropic.claude-opus-5-5[1m]')?.label).toBe('Opus (1M context)');
    expect(rows.find((r) => r.value === 'claude-sonnet-4-6')?.efforts).not.toContain('xhigh');
    expect(rows.find((r) => r.label === 'Auto model router')?.efforts).toEqual([]);
  });

  it("uses devdesk.board.models instead, with the CLI's names where it has them; Claude's aliases without either", () => {
    expect(modelChoices(['sonnet', 'my-model'], cli)).toEqual([
      { value: 'sonnet', label: 'Sonnet', description: 'Sonnet 5.5 · Efficient for routine tasks', efforts: [...EFFORT_LEVELS] },
      { value: 'my-model', label: 'my-model', description: '', efforts: [...EFFORT_LEVELS] },
    ]);
    expect(modelChoices([], undefined).map((r) => r.value)).toEqual(DEFAULT_MODELS);
    expect(modelChoices([], []).map((r) => r.value)).toEqual(DEFAULT_MODELS);
  });

  it("falls back to Claude's aliases and their [1m] variants when the CLI lists no models", () => {
    expect(modelChoices([], undefined).map((r) => r.value)).toEqual(['Default', 'opus', 'sonnet', 'haiku', 'fable', 'opus[1m]', 'sonnet[1m]', 'fable[1m]']);
  });

  it("takes Claude's aliases the CLI rows lack, with every effort, unless devdesk.board.models lists the models", () => {
    const rows = modelChoices([], cli);
    const aliases = aliasChoices([], rows);
    expect(aliases.map((r) => r.value)).toContain('opus');
    expect(aliases.map((r) => r.value)).not.toContain('sonnet');
    const ok = { ...allowed, ...allowedModels([...rows, ...aliases]) };
    expect(parseChoice({ model: 'opus', effort: 'high' }, ok)).toMatchObject({ model: 'opus', effort: 'high' });
    expect(aliasChoices(['my-model'], modelChoices(['my-model'], cli))).toEqual([]);
  });

  it('adds models typed with /model once', () => {
    const rows = modelChoices([], undefined, ['opusplan', 'opus']);
    expect(rows.map((r) => r.value)).toEqual([...DEFAULT_MODELS, 'opusplan']);
    expect(rows.at(-1)?.description).toBe('Typed with /model');
  });

  it('adds no models typed with /model to devdesk.board.models, which replaces the list', () => {
    expect(modelChoices(['Default', 'opus'], undefined, ['opus[1m]', 'opsu']).map((r) => r.value)).toEqual(['Default', 'opus']);
  });

  it("keeps an effort only when the chosen model offers it, and the [1m] value in --model", () => {
    const rows = modelChoices([], cli);
    const ok = { ...allowed, ...allowedModels(rows) };
    expect(parseChoice({ model: 'claude-sonnet-4-6', effort: 'xhigh' }, ok)).toMatchObject({ model: 'claude-sonnet-4-6', effort: 'Default' });
    expect(parseChoice({ model: 'claude-sonnet-4-6', effort: 'max' }, ok).effort).toBe('max');
    const router = rows.find((r) => r.label === 'Auto model router')!.value;
    expect(parseChoice({ model: router, effort: 'high' }, ok).effort).toBe('Default');
    const opus = parseChoice({ model: 'global.anthropic.claude-opus-5-5[1m]', effort: 'xhigh' }, ok);
    expect(choiceArgs(opus)).toBe("--model 'global.anthropic.claude-opus-5-5[1m]' --effort 'xhigh'");
  });

  it('finds the row /model means: by value, Default, name, or the only name starting so', () => {
    const rows = modelChoices([], cli);
    const find = (want: string) => findModel(rows, want)?.value;
    expect(find('global.anthropic.claude-opus-5-5[1m]')).toBe('global.anthropic.claude-opus-5-5[1m]');
    expect(find('CLAUDE-OPUS-5')).toBe('claude-opus-5');
    expect(find('default')).toBe('Default');
    expect(find('Default')).toBe('Default');
    // The name the model pill shows for Default, and the one it used to show.
    expect(find('Model')).toBe('Default');
    expect(find('Default model')).toBe('Default');
    expect(find('default  MODEL')).toBe('Default');
    expect(find('opus')).toBe('claude-opus-5-5');
    expect(find('Opus (1M context)')).toBe('global.anthropic.claude-opus-5-5[1m]');
    expect(find('opus 1m')).toBe('global.anthropic.claude-opus-5-5[1m]');
    expect(find('opus 4.8 1m')).toBe('claude-opus-4-8[1m]');
    expect(find('sonnet 4.6')).toBe('claude-sonnet-4-6');
    // Several names start so, or none: not a row.
    expect(find('opus 4')).toBeUndefined();
    expect(find('opusplan')).toBeUndefined();
    expect(find('auto')).toBeUndefined();
    expect(modelsStartingWith(rows, 'auto').map((r) => r.label)).toEqual(['Auto model router', 'Auto model router (1M context)']);
    expect(modelsStartingWith(rows, 'opus[1m]')).toEqual([]);
    // A [1m] alias is its model's 1M-context row, in any case, as `opus` is the Opus row.
    expect(find('opus[1m]')).toBe('global.anthropic.claude-opus-5-5[1m]');
    expect(find('OPUS[1M]')).toBe('global.anthropic.claude-opus-5-5[1m]');
    expect(find('sonnet[1m]')).toBe(rows.find((r) => r.label === 'Sonnet (1M context)')?.value);
    expect(modelsStartingWith(rows, 'OPUS[1M]')).toEqual([]);
    // Claude's other aliases go to --model as typed.
    expect(find('fable[1m]')).toBeUndefined();
    expect(find('(')).toBeUndefined();
  });

  it("names a model's 1M-context row", () => {
    const rows = modelChoices([], cli);
    const row = (label: string) => rows.find((r) => r.label === label)!;
    expect(longContextRow(rows, row('Opus'))?.value).toBe('global.anthropic.claude-opus-5-5[1m]');
    expect(longContextRow(rows, row('Opus (1M context)'))).toBeUndefined();
    expect(longContextRow(rows, row('Haiku'))).toBeUndefined();
    expect(longContextRow(rows, row('Default'))).toBeUndefined();
  });
});

describe('modeTone', () => {
  it('tints plan, permission-skipping, auto-edit and other modes like Claude Code', () => {
    const tone = (name: string) => modeTone(DEFAULT_MODES.find((m) => m.name === name)!);
    expect(tone('Plan')).toBe('plan');
    expect(tone('Bypass (clauded)')).toBe('danger');
    expect(tone('Auto')).toBe('danger');
    expect(tone('Accept edits')).toBe('edits');
    expect(tone('Manual')).toBe('default');
    expect(tone('Default')).toBe('default');
  });

  it('finds the mode Plan starts in, else Claude plan mode', () => {
    expect(planMode(DEFAULT_MODES).name).toBe('Plan');
    expect(planMode([{ name: 'Mine', args: '--verbose' }])).toEqual({ name: 'Plan', args: '--permission-mode plan' });
  });
});

describe('fileMention', () => {
  it('quotes a path with whitespace, as Attach file and the @ menu insert it', () => {
    expect(fileMention('src/a.ts')).toBe('@src/a.ts ');
    expect(fileMention('my notes.md')).toBe('@"my notes.md" ');
    expect(fileMention('docs/tab\there.md')).toBe('@"docs/tab\there.md" ');
  });
});
