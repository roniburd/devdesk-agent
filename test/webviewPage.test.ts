// The webviews' pages (the board's and the Claude Usage page's), as the extension builds them, compared with golden
// files (`test/fixtures/webviewPage/*.html`), and their scripts as bundled.
import { describe, expect, it, vi } from 'vitest';

vi.mock('node:crypto', async (orig) => ({ ...(await orig<typeof import('node:crypto')>()), randomBytes: (n: number) => Buffer.alloc(n, 7) }));

const created: { options: unknown; webview: FakeWebview }[] = [];
type FakeWebview = { cspSource: string; html: string; asWebviewUri(u: { path: string }): string; onDidReceiveMessage(): { dispose(): void } };
const webview = (): FakeWebview => ({
  cspSource: 'vscode-resource:',
  html: '',
  asWebviewUri: (u) => `vscode-resource:${u.path}`,
  onDidReceiveMessage: () => ({ dispose() {} }),
});

vi.mock('vscode', () => {
  const Uri = { file: (path: string) => ({ path }), joinPath: (u: { path: string }, ...parts: string[]) => ({ path: [u.path, ...parts].join('/') }) };
  const disposable = () => ({ dispose() {} });
  return {
    Uri,
    ViewColumn: { Active: -1 },
    window: {
      createOutputChannel: () => ({ info() {}, warn() {}, error() {}, debug() {}, trace() {}, appendLine() {}, dispose() {} }),
      createWebviewPanel: (_type: string, _title: string, _column: number, options: unknown) => {
        const w = webview();
        created.push({ options, webview: w });
        return { webview: w, onDidDispose: disposable, onDidChangeViewState: disposable, reveal() {}, dispose() {} };
      },
    },
  };
});

const vscode = await import('vscode');
const { boardHtml } = await import('../src/board/html');
const { UsagePanel } = await import('../src/usagePanel');

const ext = vscode.Uri.file('/ext');

describe('the webview pages', () => {
  it("builds the board's page as before", async () => {
    await expect(boardHtml(webview() as never, ext, 'top')).toMatchFileSnapshot('fixtures/webviewPage/board.html');
  });

  it("builds the Claude Usage page, with the webview's options, as before", async () => {
    const noEvent = () => ({ dispose() {} });
    const panel = new UsagePanel(ext, { onProgress: noEvent, snapshot: () => new Promise(() => {}) } as never, { onDidChange: noEvent, get: () => ({ kind: 'all' }), windowPlace: () => undefined } as never);
    panel.open();
    const { options, webview: w } = created[created.length - 1];
    expect(options).toEqual({ enableScripts: true, localResourceRoots: [{ path: '/ext/media' }, { path: '/ext/dist/webview' }] });
    await expect(w.html).toMatchFileSnapshot('fixtures/webviewPage/usage.html');
  });
});

describe("the webviews' scripts", () => {
  it('bundle the core modules they share with the extension, not copies', async () => {
    const { webviewScript } = await import('./webviewScript');
    expect(webviewScript('board')).toContain('// src/core/boardQuery.ts');
    expect(webviewScript('board')).toContain('// src/core/usageProgress.ts');
    expect(webviewScript('board')).toContain('// src/core/slashTrigger.ts');
    expect(webviewScript('usage')).toContain('// src/core/usageProgress.ts');
    // Nothing for Node gets into a browser script.
    for (const name of ['board', 'usage'] as const) expect(webviewScript(name)).not.toMatch(/require\(|["']node:/);
  });
});
