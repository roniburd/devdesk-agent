import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';

export const BOARD_TITLE = 'Claude Board';

/**
 * The board's page: its markup, `media/board.css` and `media/board.js` (the only script, by nonce). `test/boardWebview.test.ts`
 * loads the `<body>` from this file.
 */
export function boardHtml(webview: vscode.Webview, extensionUri: vscode.Uri, placement: string): string {
  const nonce = randomBytes(16).toString('base64');
  const media = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', file));
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; img-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media('board.css')}">
<title>${BOARD_TITLE}</title>
</head>
<body data-placement="${placement}">
<header class="bar">
  <h1>${BOARD_TITLE}</h1>
  <span class="chip needs" id="needs" hidden></span>
  <span class="chip" id="working" hidden></span>
  <span class="spacer"></span>
  <div class="search" role="search">
    <input id="search" type="search" maxlength="500" spellcheck="false" autocomplete="off" placeholder="Search sessions…" aria-label="Search sessions; Enter asks a model (✨)" aria-describedby="search-banner">
    <button class="ghost ask" id="ask" title="Ask ✨: find sessions by what they are about (⏎)" aria-label="Ask a model to find sessions">✨</button>
  </div>
  <label class="filter">Worktree <select id="filter"><option value="">All</option></select></label>
  <button class="ghost" id="cardline" title="Show what Claude is doing or asks on Working and Needs you cards" aria-label="One line on Working and Needs you cards" aria-pressed="true">☰</button>
  <button class="ghost" id="stats" title="Token usage" aria-label="Token usage" aria-expanded="false" aria-controls="stats-pop">📊</button>
  <button class="ghost" id="settings" title="Claude Board settings" aria-label="Claude Board settings"></button>
  <div class="stats-pop" id="stats-pop" role="dialog" aria-label="Token usage" hidden></div>
</header>
<div class="search-banner" id="search-banner" role="status" hidden></div>
<main id="lanes" aria-live="polite"><p class="loading">Loading Claude sessions…</p></main>
<div class="pane" id="pane" data-tone="default">
<div class="square">
<section class="composer" id="composer" data-tone="default" aria-label="Start a new Claude session">
  <div class="editing" id="editing" hidden>Editing a prompt for later <button class="link" id="cancel-edit">Cancel</button></div>
  <div class="notice" id="notice" role="status" hidden></div>
  <div class="adddirs" id="adddirs" aria-label="Directories the next session can also work in" hidden></div>
  <textarea id="prompt" rows="3" aria-label="Prompt for a new Claude session" aria-controls="popup" aria-autocomplete="list" aria-expanded="false" aria-describedby="arghint"
    placeholder="Start a new session: ask Claude anything (/ for commands and skills, @ for files, paste images, ⌥⏎ to save it for later)"></textarea>
  <div class="arghint" id="arghint" aria-live="polite" hidden></div>
  <div class="popup" id="popup" role="listbox" aria-label="Completions" hidden></div>
  <div class="footer">
    <button class="icon" id="plus" title="Add" aria-label="Add files or context"></button>
    <button class="icon" id="slash" title="Show command menu (/)" aria-label="Show skills and commands"></button>
    <button class="pill" id="where" aria-haspopup="listbox" aria-label="Where the session starts"></button>
    <input class="wtname" id="wtname" hidden placeholder="name (else from the prompt)" aria-label="New worktree name" spellcheck="false">
    <button class="pill" id="model" title="Switch model" aria-haspopup="listbox" aria-label="Model and effort"></button>
    <span class="spacer"></span>
    <span class="error" id="cerror" role="alert" hidden></span>
    <button class="icon mode" id="mode" aria-haspopup="listbox" aria-label="Permission mode"></button>
    <button class="pill later" id="later">Later <kbd>⌥⏎</kbd></button>
    <button class="send" id="send"></button>
  </div>
</section>
<div class="hint" id="hint"><kbd>Enter</kbd> starts a session here <kbd id="hint-later">⌥⏎</kbd> saves it for later <kbd>/</kbd> commands and skills<span id="hint-nav"><span id="hint-cards"><kbd id="hint-cards-key">↑</kbd> cards</span> <kbd>←</kbd> sessions<span id="hint-earlier"> <kbd id="hint-history">⌥↑</kbd> earlier prompts</span></span></div>
</div>
</div>
<script nonce="${nonce}" src="${media('board.js')}"></script>
</body>
</html>`;
}
