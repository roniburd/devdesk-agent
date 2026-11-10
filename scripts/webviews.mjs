// How the webviews' scripts are bundled: each `media/<name>.js` (with the core modules it imports) into one browser
// script, `dist/webview/<name>.js`, that the webview loads. scripts/build.mjs writes them; the jsdom tests bundle the
// same way in memory (test/webviewScript.ts).
export const WEBVIEWS = ['board', 'usage'];

/** esbuild options for the webviews, the extension's folder being `root`. */
export const webviewBuild = (root) => ({
  entryPoints: Object.fromEntries(WEBVIEWS.map((name) => [name, `media/${name}.js`])),
  outdir: `${root}/dist/webview`,
  absWorkingDir: root,
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  logLevel: 'info',
});
