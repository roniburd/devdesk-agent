// Claude's replies are Markdown: this turns the common part of it (headings, paragraphs, lists, quotes, code, tables,
// rules; bold, italic, inline code, links) into elements. Like everything on the page, the text only ever goes in as text
// nodes, never as markup, so a reply can't inject HTML. Whatever isn't recognised stays as written.

import { h } from './dom';

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

const blank = (line: string) => line.trim() === '';

/** The cells of a table row: `| a | b |` or `a | b`, with `\|` kept as a pipe. */
export function tableCells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  for (let k = 0; k < s.length; k++) {
    if (s[k] === '\\' && s[k + 1] === '|') {
      cur += '|';
      k++;
    } else if (s[k] === '|') {
      cells.push(cur.trim());
      cur = '';
    } else cur += s[k];
  }
  cells.push(cur.trim());
  return cells;
}

const isTableStart = (lines: readonly string[], i: number) =>
  lines[i].includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-');

/** A line that ends a paragraph: a new block starts on it. */
const startsBlock = (lines: readonly string[], i: number) =>
  FENCE.test(lines[i]) || HEADING.test(lines[i]) || RULE.test(lines[i]) || QUOTE.test(lines[i]) || ITEM.test(lines[i]) || isTableStart(lines, i);

/** Markdown text as block elements. */
export function renderMarkdown(text: string): Node[] {
  return blocks(text.replace(/\r\n?/g, '\n').split('\n'));
}

function blocks(lines: readonly string[]): Node[] {
  const out: Node[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (blank(line)) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const close = new RegExp(`^\\s{0,3}${fence[1][0] === '`' ? '`' : '~'}{${fence[1].length},}\\s*$`);
      const body: string[] = [];
      i++;
      while (i < lines.length && !close.test(lines[i])) body.push(lines[i++]);
      i++;
      out.push(h('pre', { class: 'md-code' }, h('code', { text: body.join('\n') })));
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      // h1/h2 in a reply are section titles, not the page's: they all render at one modest size.
      out.push(h('p', { class: `md-h md-h${heading[1].length}`, attrs: { role: 'heading', 'aria-level': String(Math.min(6, heading[1].length + 2)) } }, ...inline(heading[2])));
      i++;
      continue;
    }
    if (RULE.test(line)) {
      out.push(h('hr', { class: 'md-rule' }));
      i++;
      continue;
    }
    if (isTableStart(lines, i)) {
      const head = tableCells(line);
      const align = tableCells(lines[i + 1]).map((c) => (c.endsWith(':') ? (c.startsWith(':') ? 'center' : 'right') : 'left'));
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && !blank(lines[i]) && lines[i].includes('|')) rows.push(tableCells(lines[i++]));
      const cell = (tag: 'th' | 'td', text: string, col: number) =>
        h(tag, { attrs: align[col] && align[col] !== 'left' ? { class: `md-${align[col]}` } : {} }, ...inline(text));
      const table = h(
        'table',
        { class: 'md-table' },
        h('thead', {}, h('tr', {}, ...head.map((c, col) => cell('th', c, col)))),
        h('tbody', {}, ...rows.map((r) => h('tr', {}, ...head.map((_, col) => cell('td', r[col] ?? '', col))))),
      );
      // A table is wider than a phone: it scrolls sideways on its own, the page doesn't.
      out.push(h('div', { class: 'md-table-wrap' }, table));
      continue;
    }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) body.push(lines[i++].replace(QUOTE, ''));
      out.push(h('blockquote', { class: 'md-quote' }, ...blocks(body)));
      continue;
    }
    if (ITEM.test(line)) {
      const [list, next] = listAt(lines, i);
      out.push(list);
      i = next;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && !blank(lines[i]) && (para.length === 0 || !startsBlock(lines, i))) para.push(lines[i++].trim());
    out.push(h('p', { class: 'md-p' }, ...withBreaks(para)));
  }
  return out;
}

/** A list starting at line `i`, its items' indented lines (nested lists, continuations) parsed as their blocks. */
function listAt(lines: readonly string[], i: number): [HTMLElement, number] {
  const first = ITEM.exec(lines[i]) as RegExpExecArray;
  const indent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const list = ordered ? h('ol', { class: 'md-list' }) : h('ul', { class: 'md-list' });
  if (ordered && parseInt(first[2], 10) !== 1) list.setAttribute('start', String(parseInt(first[2], 10)));
  while (i < lines.length) {
    const m = ITEM.exec(lines[i]);
    if (!m || m[1].length !== indent || /\d/.test(m[2]) !== ordered) break;
    const body = [m[3]];
    const inner = indent + m[2].length + 1;
    i++;
    // The item goes on while lines are indented past its marker, or are a lazy continuation of its text.
    while (i < lines.length) {
      const l = lines[i];
      if (blank(l)) {
        const nextLine = lines[i + 1];
        if (nextLine !== undefined && !blank(nextLine) && nextLine.length - nextLine.trimStart().length >= inner) {
          body.push('');
          i++;
          continue;
        }
        break;
      }
      const lead = l.length - l.trimStart().length;
      const sub = ITEM.exec(l);
      if (lead >= inner || (sub && sub[1].length > indent)) body.push(l.slice(Math.min(lead, inner)));
      else if (!sub && !startsBlock(lines, i)) body.push(l.trim());
      else break;
      i++;
    }
    // A one-paragraph item stays inline (no <p> margins), as tight lists render.
    const parsed = blocks(body);
    const li = h('li');
    if (parsed[0] instanceof HTMLElement && parsed[0].classList.contains('md-p')) {
      li.append(...Array.from(parsed[0].childNodes));
      li.append(...parsed.slice(1));
    } else li.append(...parsed);
    list.append(li);
  }
  return [list, i];
}

function withBreaks(lines: readonly string[]): Node[] {
  const out: Node[] = [];
  lines.forEach((l, n) => {
    if (n > 0) out.push(h('br'));
    out.push(...inline(l));
  });
  return out;
}

// Inline: `code` first (nothing inside it is parsed), then links, **bold**, *italic*.
const INLINE = /(`+)([\s\S]*?[^`])\1(?!`)|\[([^\]\n]+)\]\(([^)\s]+)\)|\*\*([^*\n]+?)\*\*|__([^_\n]+?)__|\*(?![\s*])([^*\n]+?)\*(?![\w*])|_(?![\s_])([^_\n]+?)_(?![\w_])/g;
// *em* and _em_ must not start inside a word (snake_case_names, 2*3*4): the page's browsers may lack regex lookbehind.
const WORD = /[\w*]/;

/** Markdown inline text as nodes. */
export function inline(text: string): Node[] {
  const out: Node[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if ((m[7] !== undefined || m[8] !== undefined) && at > 0 && WORD.test(text[at - 1])) continue;
    if (at > last) out.push(document.createTextNode(text.slice(last, at)));
    last = at + m[0].length;
    if (m[1] !== undefined) out.push(h('code', { class: 'md-inline-code', text: m[2].replace(/^ (.*) $/, '$1') }));
    else if (m[3] !== undefined) {
      // Only web links open: anything else (javascript:, file paths) stays text.
      if (/^https?:\/\//i.test(m[4])) out.push(h('a', { attrs: { href: m[4], target: '_blank', rel: 'noopener noreferrer' } }, ...inline(m[3])));
      else out.push(...inline(m[3]));
    } else if (m[5] !== undefined || m[6] !== undefined) out.push(h('strong', {}, ...inline(m[5] ?? m[6])));
    else out.push(h('em', {}, ...inline(m[7] ?? m[8])));
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)));
  return out;
}
