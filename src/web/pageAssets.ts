/** The mobile page (src/web/page/), inlined into dist/web.js by scripts/webBuild.mjs. The daemon serves these strings only. */
export interface PageAssets {
  html: string;
  js: string;
  css: string;
  /** The experimental terminal (src/web/page/term.ts with xterm.js) and xterm.js's stylesheet, loaded only in that view. */
  termJs: string;
  termCss: string;
}

declare const __DEVDESK_WEB_PAGE__: PageAssets | undefined;

/** The fallback is for running the daemon's modules unbundled (in-process tests). */
export const PAGE: PageAssets =
  typeof __DEVDESK_WEB_PAGE__ === 'undefined' ? { html: '<!doctype html><title>DevDesk</title>', js: '', css: '', termJs: '', termCss: '' } : __DEVDESK_WEB_PAGE__;
