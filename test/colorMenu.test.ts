import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type ColorMenuPackage, withColorMenu } from '../src/core/colorMenu';
import { SESSION_COLORS } from '../src/core/sessionColors';

const text = readFileSync(join(__dirname, '..', 'package.json'), 'utf8');

describe('the Color submenu in package.json', () => {
  it('is what npm run color-menu writes from SESSION_COLORS', () => {
    expect(`${JSON.stringify(withColorMenu(JSON.parse(text)), null, 2)}\n`).toBe(text);
  });

  it('has a command, a .current copy and a menu item per color, and No Color', () => {
    const pkg = JSON.parse(text);
    const submenu: { command: string }[] = pkg.contributes.menus['devdesk.sessions.color'];
    expect(submenu).toHaveLength(SESSION_COLORS.length * 2 + 1);
  });

  it('puts the colors where the first color command was, and adds them at the end when there are none', () => {
    const pkg: ColorMenuPackage = {
      contributes: {
        commands: [{ command: 'a' }, { command: 'devdesk.sessions.color.old' }, { command: 'b' }],
        menus: { commandPalette: [{ command: 'x', when: 'false' }] },
      },
    };
    const out = withColorMenu(pkg);
    expect(out.contributes.commands.map((c) => c.command)).toEqual(['a', ...out.contributes.menus['devdesk.sessions.color'].map((c) => c.command), 'b']);
    expect(out.contributes.menus.commandPalette[0]).toEqual({ command: 'x', when: 'false' });
    expect(out.contributes.menus.commandPalette.at(-1)).toEqual({ command: 'devdesk.sessions.color.none', when: 'false' });
  });
});
