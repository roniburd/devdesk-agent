import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { webBuild } from './webBuild.mjs';
import { webviewBuild } from './webviews.mjs';

// Bundles the extension into dist/extension.js, the usage worker it starts into dist/usageWorker.js, and the webviews'
// scripts into dist/webview/ (scripts/webviews.mjs), and the web access daemon, with its page, into dist/web.js
// (scripts/webBuild.mjs); run from anywhere.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
await build({
  entryPoints: { extension: join(root, 'src/extension.ts'), usageWorker: join(root, 'src/usageWorker.ts') },
  outdir: join(root, 'dist'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  sourcemap: true,
  logLevel: 'info',
});
await build(webviewBuild(root));
await webBuild(root, { outdir: join(root, 'dist') });
