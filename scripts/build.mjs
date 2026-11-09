import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Bundles the extension into dist/extension.js, and the usage worker it starts into dist/usageWorker.js; run from anywhere.
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
