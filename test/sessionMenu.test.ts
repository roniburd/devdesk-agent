import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

type Item = { command?: string; submenu?: string; group?: string; when?: string };
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
const menus: Record<string, Item[]> = pkg.contributes.menus;

/** The right-click items of a Claude view session row (not inline buttons), in the order VS Code shows them. */
function sessionRowMenu(): string[] {
  return menus['view/item/context']
    .filter((i) => i.when?.includes('view == devdesk.sessions') && i.when.includes('session') && !i.group?.startsWith('inline'))
    .filter((i) => !i.when?.includes('launchable'))
    .sort((a, b) => {
      const [ga, oa] = (a.group ?? '').split('@');
      const [gb, ob] = (b.group ?? '').split('@');
      return ga === gb ? Number(oa) - Number(ob) : ga < gb ? -1 : 1;
    })
    .map((i) => (i.command ?? i.submenu)!);
}

describe("a session's right-click menu", () => {
  it('goes Open, End; Mark as Read/Unread, Tag; See Diff; then the Fork submenu', () => {
    expect([...new Set(sessionRowMenu())]).toEqual([
      'devdesk.sessions.openCard',
      'devdesk.sessions.kill',
      'devdesk.sessions.remove',
      'devdesk.sessions.markRead',
      'devdesk.sessions.markUnread',
      'devdesk.sessions.color',
      'devdesk.sessions.seeDiff',
      'devdesk.sessions.forkMenu',
    ]);
  });

  it('keeps every fork command in its submenu, not at the top level', () => {
    const topLevel = menus['view/item/context'].concat(menus['webview/context'])
      .filter((i) => !i.group?.startsWith('inline'))
      .map((i) => i.command);
    for (const c of ['devdesk.sessions.fork', 'devdesk.sessions.forkWithMode']) {
      expect(topLevel, c).not.toContain(c);
    }
    expect(menus['devdesk.sessions.forkMenu'].map((i) => i.command)).toEqual([
      'devdesk.sessions.fork',
      'devdesk.sessions.forkWithMode',
    ]);
  });

  it('labels the Color submenu Tag, with the label emoji after the word', () => {
    expect(pkg.contributes.submenus).toContainEqual({ id: 'devdesk.sessions.color', label: 'Tag 🏷' });
  });

  it('puts each submenu at most once in a menu (VS Code drops the repeats with a warning)', () => {
    for (const [menu, items] of Object.entries(menus)) {
      const subs = items.map((i) => i.submenu).filter(Boolean);
      expect(subs, menu).toEqual([...new Set(subs)]);
    }
  });
});
