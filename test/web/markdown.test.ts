// The page's Markdown (src/web/page/markdown.ts) in jsdom: what each construct becomes, and that text stays text.
import { JSDOM } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inline, renderMarkdown, tableCells } from '../../src/web/page/markdown';

let dom: JSDOM;
beforeAll(() => {
  dom = new JSDOM('<!doctype html><body></body>');
  Object.assign(globalThis, { document: dom.window.document, HTMLElement: dom.window.HTMLElement });
});
afterAll(() => dom.window.close());

/** The rendered nodes as HTML, to compare shapes. */
const html = (nodes: Node[]) => {
  const div = document.createElement('div');
  div.append(...nodes);
  return div.innerHTML;
};
const md = (text: string) => html(renderMarkdown(text));

describe('renderMarkdown', () => {
  it('makes paragraphs, keeping line breaks inside one', () => {
    expect(md('one\ntwo\n\nthree')).toBe('<p class="md-p">one<br>two</p><p class="md-p">three</p>');
  });

  it('makes headings, rules, quotes and code blocks', () => {
    expect(md('## Results')).toBe('<p class="md-h md-h2" role="heading" aria-level="4">Results</p>');
    expect(md('---')).toBe('<hr class="md-rule">');
    expect(md('> said\n> twice')).toBe('<blockquote class="md-quote"><p class="md-p">said<br>twice</p></blockquote>');
    expect(md('```ts\nconst a = "**x**";\n```\nafter')).toBe('<pre class="md-code"><code>const a = "**x**";</code></pre><p class="md-p">after</p>');
  });

  it('makes lists, nested and ordered from their first number', () => {
    expect(md('- a\n- b\n  - b1\n- c')).toBe('<ul class="md-list"><li>a</li><li>b<ul class="md-list"><li>b1</li></ul></li><li>c</li></ul>');
    expect(md('3. three\n4. four')).toBe('<ol class="md-list" start="3"><li>three</li><li>four</li></ol>');
    expect(md('- a\nstill a\n\npara')).toBe('<ul class="md-list"><li>a<br>still a</li></ul><p class="md-p">para</p>');
  });

  it('makes a table that scrolls on its own, with aligned columns and short rows filled', () => {
    expect(md('| a | b |\n|:--|--:|\n| 1 | 2 |\n| 3 |')).toBe(
      '<div class="md-table-wrap"><table class="md-table"><thead><tr><th>a</th><th class="md-right">b</th></tr></thead>' +
        '<tbody><tr><td>1</td><td class="md-right">2</td></tr><tr><td>3</td><td class="md-right"></td></tr></tbody></table></div>',
    );
    expect(tableCells('| a \\| b | c |')).toEqual(['a | b', 'c']);
  });

  it('keeps markup as text', () => {
    expect(md('<img src=x onerror=alert(1)> **<b>hi</b>**')).toBe('<p class="md-p">&lt;img src=x onerror=alert(1)&gt; <strong>&lt;b&gt;hi&lt;/b&gt;</strong></p>');
    expect(md('| <i>x</i> |\n|---|\n| `<s>` |')).toContain('<th>&lt;i&gt;x&lt;/i&gt;</th>');
  });
});

describe('inline', () => {
  it('makes code, bold, italic and web links', () => {
    expect(html(inline('`a*b*` **bold** *it* _it_ [docs](https://x.dev/a)'))).toBe(
      '<code class="md-inline-code">a*b*</code> <strong>bold</strong> <em>it</em> <em>it</em> <a href="https://x.dev/a" target="_blank" rel="noopener noreferrer">docs</a>',
    );
  });

  it('leaves other links, and stars or underscores inside words, as text', () => {
    expect(html(inline('[x](javascript:alert(1)) [y](/etc/passwd)'))).toBe('x) y');
    expect(html(inline('snake_case_name and 2*3*4'))).toBe('snake_case_name and 2*3*4');
  });
});
