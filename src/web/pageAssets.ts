/** The mobile page (src/web/page/), inlined into dist/web.js by scripts/webBuild.mjs. The daemon serves these strings only. */
export interface PageAssets {
  html: string;
  js: string;
  css: string;
}

declare const __DEVDESK_WEB_PAGE__: PageAssets | undefined;

/** The fallback is for running the daemon's modules unbundled (in-process tests). */
export const PAGE: PageAssets =
  typeof __DEVDESK_WEB_PAGE__ === 'undefined' ? { html: '<!doctype html><title>DevDesk</title>', js: '', css: '' } : __DEVDESK_WEB_PAGE__;
