import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CATEGORIES } from '../src/board/dispatch';

const manual = readFileSync(join(__dirname, '..', 'MANUAL.md'), 'utf8');

describe('MANUAL.md', () => {
  it('documents every command the board runs itself or turns into launch arguments', () => {
    const commands = [...Object.keys(CATEGORIES.A.commands), ...Object.keys(CATEGORIES.B.commands)];
    expect(commands).toContain('plan');
    expect(commands.filter((c) => !manual.includes(`\`/${c}`))).toEqual([]);
  });

  it('says /plan <task> starts without Ultracode or Spec, and that Plan and Spec do not apply to a saved command', () => {
    expect(manual).toMatch(/`\/plan <task>`[^\n]*without Ultracode or Spec/);
    expect(manual).toMatch(/saved command[^\n]*runs as saved/);
  });
});

describe('settings that make a window act on the whole machine', () => {
  // Every window parks all of the machine's sessions and prunes the shared state files: a value from one folder's
  // settings would act on every other folder's sessions and files.
  const HOST_WIDE = [
    'devdesk.sessions.parkAfterDays',
    'devdesk.sessions.parkReadAfterMinutes',
    'devdesk.sessions.maxLiveSessions',
    'devdesk.sessions.parkBelowFreeMemoryPercent',
    'devdesk.sessions.idleMinutes',
    'devdesk.usage.historyDays',
    'devdesk.usage.historyMaxMB',
    'devdesk.diagnostics.keepDays',
    'devdesk.boardSearch.historyMaxSessions',
  ];
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
  const properties: Record<string, { scope?: string }> = Object.assign({}, ...[pkg.contributes.configuration].flat().map((c: { properties: object }) => c.properties));

  it('are machine-scoped', () => {
    expect(HOST_WIDE.filter((k) => properties[k]?.scope !== 'machine')).toEqual([]);
  });

  it('are marked machine in the All settings table', () => {
    expect(HOST_WIDE.filter((k) => !manual.includes(`| \`${k}\` | *machine*`))).toEqual([]);
  });
});

describe('the Color submenu', () => {
  it('lists No Color first (VS Code orders menu groups by name)', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
    const items: { command: string; group: string }[] = pkg.contributes.menus['devdesk.sessions.color'];
    const groupOf = (item: { group: string }) => item.group.split('@')[0];
    const none = items.find((i) => i.command === 'devdesk.sessions.color.none')!;
    expect(items.filter((i) => i !== none && groupOf(i) <= groupOf(none))).toEqual([]);
  });
});
