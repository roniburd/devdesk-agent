import { colorCommand, SESSION_COLORS } from './sessionColors';

/**
 * The Color submenu's contributions in package.json, made from `SESSION_COLORS` by `npm run color-menu`
 * (`scripts/color-menu.mjs`): for each color, a command and a `.current` copy titled with a ✓ that shows instead
 * while the session already has that color; then No Color. All are hidden from the command palette.
 */

interface Contribution {
  command: string;
  [key: string]: string;
}

const PREFIX = 'devdesk.sessions.color.';

/** The color commands in submenu order, each with its title, menu group and the `when` clause it shows under. */
function colorItems(): { command: string; title: string; group: string; when: string }[] {
  return [
    ...SESSION_COLORS.flatMap((c, i) => {
      const has = `viewItem =~ /\\bcolor-${c.id}\\b/ || sessionColor == '${c.id}'`;
      const group = `colors@${i + 1}`;
      return [
        { command: colorCommand(c.id), title: `${c.square} ${c.label}`, group, when: `!(${has})` },
        { command: `${colorCommand(c.id)}.current`, title: `${c.square} ${c.label} ✓`, group, when: has },
      ];
    }),
    // VS Code orders menu groups by name, so No Color's group sorts before the colors'.
    { command: colorCommand(undefined), title: 'No Color', group: '0_none@1', when: 'viewItem =~ /\\bcolor-/ || sessionColor' },
  ];
}

/** Replaces the run of Color commands in `list` (where its first one is, else at the end) with `items`. */
function spliceColors(list: Contribution[], items: Contribution[]): Contribution[] {
  const isColor = (c: Contribution) => c.command.startsWith(PREFIX);
  const at = list.findIndex(isColor);
  const rest = list.filter((c) => !isColor(c));
  const index = at < 0 ? rest.length : at;
  return [...rest.slice(0, index), ...items, ...rest.slice(index)];
}

/** The parts of a package.json the Color submenu is in. */
export interface ColorMenuPackage {
  contributes: { commands: Contribution[]; menus: Record<string, Contribution[]> };
}

/** `pkg` (a parsed package.json, changed in place) with its Color submenu contributions made from `SESSION_COLORS`. */
export function withColorMenu<T extends ColorMenuPackage>(pkg: T): T {
  const items = colorItems();
  const contributes = pkg.contributes;
  contributes.commands = spliceColors(
    contributes.commands,
    items.map((i) => ({ command: i.command, title: i.title, category: 'Worktrees' })),
  );
  contributes.menus.commandPalette = spliceColors(
    contributes.menus.commandPalette,
    items.map((i) => ({ command: i.command, when: 'false' })),
  );
  contributes.menus['devdesk.sessions.color'] = items.map((i) => ({ command: i.command, group: i.group, when: i.when }));
  return pkg;
}
