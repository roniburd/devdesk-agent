import { join } from 'node:path';
import { buildSync } from 'esbuild';
import { webviewBuild } from '../scripts/webviews.mjs';

const ROOT = join(__dirname, '..');
const bundles = new Map<string, string>();

/**
 * A webview's script as it loads in the webview: `media/<name>.js` bundled with the core modules it imports, the way
 * `npm run build` bundles it into `dist/webview/` (scripts/webviews.mjs), here in memory.
 */
export function webviewScript(name: 'board' | 'usage'): string {
  let code = bundles.get(name);
  if (code === undefined) {
    const { entryPoints, outdir: _outdir, logLevel: _logLevel, ...options } = webviewBuild(ROOT);
    const out = buildSync({ ...options, entryPoints: [entryPoints[name]], write: false, logLevel: 'error' });
    code = out.outputFiles[0].text;
    bundles.set(name, code);
  }
  return code;
}
