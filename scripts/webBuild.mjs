import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';

// How the web access daemon is bundled: the mobile page (src/web/page/: app.ts bundled for the browser, index.html,
// app.css) inlined as strings into one Node script, dist/web.js (src/web/main.ts), which serves them from memory and
// never reads files at runtime. There is no `external`: a `vscode` import anywhere in the daemon fails the build.
// scripts/build.mjs writes it into dist/; the daemon test builds it into a temporary folder.

/** The page's three assets, as the daemon serves them. */
export async function webPage(root) {
  const page = join(root, 'src/web/page');
  const js = await build({
    entryPoints: [join(page, 'app.ts')],
    absWorkingDir: root,
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2020',
    minify: true,
    write: false,
    logLevel: 'error',
  });
  const [html, css] = await Promise.all([readFile(join(page, 'index.html'), 'utf8'), readFile(join(page, 'app.css'), 'utf8')]);
  return { html, js: js.outputFiles[0].text, css };
}

/** Builds `<outdir>/web.js` (and its source map), the extension's folder being `root`. */
export async function webBuild(root, { outdir, write = true }) {
  const page = await webPage(root);
  return build({
    entryPoints: { web: join(root, 'src/web/main.ts') },
    absWorkingDir: root,
    outdir,
    write,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    sourcemap: true,
    define: { __DEVDESK_WEB_PAGE__: JSON.stringify(page) },
    logLevel: write ? 'info' : 'error',
  });
}
