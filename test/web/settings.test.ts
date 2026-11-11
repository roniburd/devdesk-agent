import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const properties: Record<string, { scope?: string }> = Object.assign({}, ...[pkg.contributes.configuration].flat().map((c: { properties: object }) => c.properties));
const manual = readFileSync(join(ROOT, 'MANUAL.md'), 'utf8');

describe('web access settings', () => {
  // Who may use web access and what it runs: a repository's workspace settings must not change them (a
  // `.vscode/settings.json` setting auth to loopback would turn the identity check off behind the tunnel).
  const MACHINE = ['tunnel', 'auth', 'identityHeader', 'allowedUsers', 'publicHost', 'tunnelCommand', 'cloudflare.team', 'cloudflare.audience', 'ngrok.oauthProvider'].map(
    (k) => `devdesk.web.${k}`,
  );

  it('that decide who may use it or what runs are machine-scoped', () => {
    expect(MACHINE.filter((k) => properties[k]?.scope !== 'machine')).toEqual([]);
  });

  it('are marked machine in the All settings table', () => {
    expect(MACHINE.filter((k) => !manual.includes(`| \`${k}\` | *machine*`))).toEqual([]);
  });
});
