import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Writes the Color submenu's commands and menu items into package.json from SESSION_COLORS (src/core/colorMenu.ts);
// with --check, only says whether package.json is up to date. Run from anywhere: `npm run color-menu`.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = await build({ entryPoints: [join(root, 'src/core/colorMenu.ts')], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'error' });
const { withColorMenu } = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
const file = join(root, 'package.json');
const before = readFileSync(file, 'utf8');
const after = `${JSON.stringify(withColorMenu(JSON.parse(before)), null, 2)}\n`;
if (process.argv.includes('--check')) {
  if (after !== before) {
    console.error('package.json: the Color submenu is out of date; run npm run color-menu');
    process.exit(1);
  }
} else if (after !== before) {
  writeFileSync(file, after);
  console.log('package.json: Color submenu updated');
} else {
  console.log('package.json: Color submenu already up to date');
}
