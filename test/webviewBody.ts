import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A webview page's markup, from the `BODY` of the source file that builds it (`src/board/html.ts`,
 * `src/usagePanel.ts`), as a document for jsdom; its `${…}` placeholders are left empty.
 */
export function webviewBody(file: string): string {
  const src = readFileSync(join(__dirname, '..', file), 'utf8');
  const body = /\nconst BODY = `([\s\S]*?)`;\n/.exec(src)![1];
  return `<!DOCTYPE html><html><body>${body.replace(/\$\{[^}]*\}/g, '')}</body></html>`;
}
