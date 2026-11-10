import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';

/** The webviews' styles and images. */
const MEDIA = ['media'];
/** Their scripts, bundled from `media/*.js` (scripts/webviews.mjs). */
const SCRIPTS = ['dist', 'webview'];

/**
 * A webview's options: scripts on, and only the extension's `media/` folder and the webviews' scripts load (`extra`:
 * e.g. `retainContextWhenHidden`).
 */
export function webviewOptions<T extends object = object>(extensionUri: vscode.Uri, extra?: T): vscode.WebviewOptions & T {
  const localResourceRoots = [vscode.Uri.joinPath(extensionUri, ...MEDIA), vscode.Uri.joinPath(extensionUri, ...SCRIPTS)];
  return { enableScripts: true, ...extra, localResourceRoots } as vscode.WebviewOptions & T;
}

export interface WebviewPage {
  /** The stylesheet, in `media/`, and the script, bundled from `media/<js>` into `dist/webview/`. */
  css: string;
  js: string;
  title: string;
  /** The `<body>`'s markup (the script tag goes after it), and its attributes (` data-x="…"`, with the leading space). */
  body: string;
  bodyAttrs?: string;
}

/**
 * A webview's page: its markup, one stylesheet and one script (the only one that runs, by nonce), under a policy that
 * loads nothing else.
 */
export function webviewPage(webview: vscode.Webview, extensionUri: vscode.Uri, page: WebviewPage): string {
  const nonce = randomBytes(16).toString('base64');
  const uri = (...path: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...path));
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; img-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uri(...MEDIA, page.css)}">
<title>${page.title}</title>
</head>
<body${page.bodyAttrs ?? ''}>
${page.body}
<script nonce="${nonce}" src="${uri(...SCRIPTS, page.js)}"></script>
</body>
</html>`;
}
