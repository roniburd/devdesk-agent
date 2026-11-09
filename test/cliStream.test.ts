import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CliStreamReader, INITIALIZE_REQUEST, INITIALIZE_REQUEST_ID, parseCliModels } from '../src/core/cliStream';

/** A real `initialize` answer from Claude Code 2.1.316 on Bedrock (account id and home directory replaced). */
const fixture = JSON.parse(readFileSync(new URL('./fixtures/initialize.json', import.meta.url), 'utf8'));
const answer = (requestId = INITIALIZE_REQUEST_ID) => JSON.stringify({ ...fixture, response: { ...fixture.response, request_id: requestId } });
const changed = (commands: unknown[]) => JSON.stringify({ type: 'system', subtype: 'commands_changed', commands, session_id: 's', uuid: 'u' });

describe('CliStreamReader', () => {
  it('reads the initialize answer however stdout is split, with its commands, models and version', () => {
    const reader = new CliStreamReader();
    const stream = ['{"type":"system","subtype":"hook_started"}', 'not json', answer(), ''].join('\n');
    const events = [];
    for (let i = 0; i < stream.length; i += 997) events.push(...reader.push(stream.slice(i, i + 997)));
    expect(events).toEqual(['initialized']);
    const listing = reader.listing!;
    expect(listing.version).toBe('2.1.316');
    // 113 listed, less the internal __remote-workflow.
    expect(listing.commands).toHaveLength(112);
    expect(listing.commands.find((c) => c.name === 'usage')).toMatchObject({ aliases: ['cost', 'stats'], origin: 'built-in' });
    expect(listing.commands.find((c) => c.name === 'superpowers:brainstorming')).toMatchObject({ aliases: ['brainstorming'], origin: 'superpowers' });
    expect(listing.commands.some((c) => c.name.startsWith('__'))).toBe(false);
    expect(listing.models).toHaveLength(18);
  });

  it('keeps each model row by its exact value, with its own effort levels', () => {
    const models = new CliStreamReader();
    models.push(`${answer()}\n`);
    const byValue = Object.fromEntries(models.listing!.models.map((m) => [m.value, m]));
    expect(byValue['global.anthropic.claude-opus-5-5[1m]']).toEqual({
      value: 'global.anthropic.claude-opus-5-5[1m]',
      displayName: 'Opus (1M context)',
      description: 'Opus 5.5 · Recommended · Best for everyday, complex tasks',
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    });
    expect(byValue['claude-opus-5-5'].description).toBe('Opus 5.5 at 200K context');
    expect(byValue['claude-sonnet-4-6'].efforts).toEqual(['low', 'medium', 'high', 'max']);
    const router = models.listing!.models.find((m) => m.displayName === 'Auto model router')!;
    expect(router.efforts).toEqual([]);
  });

  it('takes the commands of each later commands_changed event', () => {
    const reader = new CliStreamReader();
    // Before the answer, an event is older than it.
    expect(reader.push(`${changed([{ name: 'early' }])}\n`)).toEqual([]);
    reader.push(`${answer()}\n`);
    const late = [...fixture.response.response.commands, { name: 'github:pr-summary', description: '(MCP) Summarize a pull request', aliases: [] }];
    expect(reader.push(`${changed(late)}\n`)).toEqual(['commandsChanged']);
    expect(reader.listing!.commands).toHaveLength(113);
    expect(reader.listing!.commands.find((c) => c.name === 'github:pr-summary')).toMatchObject({ origin: 'github', description: 'Summarize a pull request' });
    expect(reader.listing!.models).toHaveLength(18);
  });

  it("ignores other requests' answers and remembers a failed initialize", () => {
    const reader = new CliStreamReader();
    expect(reader.push(`${answer('someone-else')}\n`)).toEqual([]);
    expect(reader.listing).toBeUndefined();
    reader.push(`${JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: INITIALIZE_REQUEST_ID, error: 'not logged in' } })}\n`);
    expect(reader.error).toBe('not logged in');
    expect(reader.listing).toBeUndefined();
  });

  it('reads a last line without a newline at the end', () => {
    const reader = new CliStreamReader();
    expect(reader.push(answer())).toEqual([]);
    expect(reader.end()).toEqual(['initialized']);
  });

  it('asks with the id it matches', () => {
    expect(INITIALIZE_REQUEST.request_id).toBe(INITIALIZE_REQUEST_ID);
    expect(INITIALIZE_REQUEST.request.subtype).toBe('initialize');
  });
});

describe('parseCliModels', () => {
  it('skips rows without a value and duplicates; names a row by its value when it has no name', () => {
    expect(parseCliModels([{ value: 'x', supportsEffort: false, supportedEffortLevels: ['low'] }, { value: 'x' }, { displayName: 'none' }, null])).toEqual([
      { value: 'x', displayName: 'x', description: '', efforts: [] },
    ]);
    expect(parseCliModels('nope')).toEqual([]);
  });
});
