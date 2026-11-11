import type { ScreenLine, Span } from './types';

/**
 * A tmux pane capture (`capture-pane -p -e`) as styled text runs for the page's Screen tab. The result is data, never
 * markup: the page puts each run's text in with `textContent` and its colours with `el.style`, so pane text cannot
 * inject HTML whatever it holds.
 */

type Style = Omit<Span, 'text'>;

const ESC = '\x1b';
const BEL = '\x07';

const hex = (n: number) => n.toString(16).padStart(2, '0');
const byte = (s: string | undefined) => (s !== undefined && /^\d{1,3}$/.test(s) && Number(s) <= 255 ? Number(s) : undefined);

/** `38;5;n` / `38;2;r;g;b` (also with `:`) from `params` at `i` (the 38/48): the colour and how many params it used. */
function extendedColour(params: string[], i: number): { colour?: number | string; used: number } {
  const p = params[i];
  // Colon form: one parameter, `38:5:n` or `38:2:[colourspace]:r:g:b`.
  if (p.includes(':')) {
    const sub = p.split(':');
    if (sub[1] === '5') return { colour: byte(sub[2]), used: 1 };
    if (sub[1] === '2') {
      const rgb = sub.length >= 6 ? sub.slice(3, 6) : sub.slice(2, 5);
      const [r, g, b] = rgb.map(byte);
      return { colour: r !== undefined && g !== undefined && b !== undefined ? `#${hex(r)}${hex(g)}${hex(b)}` : undefined, used: 1 };
    }
    return { used: 1 };
  }
  if (params[i + 1] === '5') {
    if (i + 2 >= params.length) return { used: params.length - i };
    return { colour: byte(params[i + 2]), used: 3 };
  }
  if (params[i + 1] === '2') {
    if (i + 4 >= params.length) return { used: params.length - i };
    const [r, g, b] = params.slice(i + 2, i + 5).map(byte);
    return { colour: r !== undefined && g !== undefined && b !== undefined ? `#${hex(r)}${hex(g)}${hex(b)}` : undefined, used: 5 };
  }
  return { used: 1 };
}

/** `style` after SGR `params` (`ESC [ <params> m`). */
function applySgr(style: Style, paramText: string): Style {
  const s: Style = { ...style };
  const params = paramText === '' ? ['0'] : paramText.split(';');
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    const base = p.split(':')[0];
    const n = base === '' ? 0 : Number(base);
    if (!Number.isInteger(n)) continue;
    if (n === 38 || n === 48) {
      const { colour, used } = extendedColour(params, i);
      if (colour !== undefined) {
        if (n === 38) s.fg = colour;
        else s.bg = colour;
      }
      i += used - 1;
      continue;
    }
    if (n === 0) {
      for (const k of Object.keys(s) as (keyof Style)[]) delete s[k];
    } else if (n === 1) s.bold = true;
    else if (n === 2) s.dim = true;
    else if (n === 3) s.italic = true;
    else if (n === 4) {
      if (p === '4:0') delete s.underline;
      else s.underline = true;
    } else if (n === 7) s.inverse = true;
    else if (n === 22) {
      delete s.bold;
      delete s.dim;
    } else if (n === 23) delete s.italic;
    else if (n === 24) delete s.underline;
    else if (n === 27) delete s.inverse;
    else if (n >= 30 && n <= 37) s.fg = n - 30;
    else if (n >= 90 && n <= 97) s.fg = n - 90 + 8;
    else if (n === 39) delete s.fg;
    else if (n >= 40 && n <= 47) s.bg = n - 40;
    else if (n >= 100 && n <= 107) s.bg = n - 100 + 8;
    else if (n === 49) delete s.bg;
  }
  return s;
}

const KEYS: readonly (keyof Style)[] = ['fg', 'bg', 'bold', 'dim', 'italic', 'underline', 'inverse'];
const sameStyle = (a: Style, b: Style) => KEYS.every((k) => a[k] === b[k]);

/** A copy of `style` with only the attributes it sets, in a fixed key order. */
function styleCopy(style: Style): Style {
  const out: Style = {};
  for (const k of KEYS) if (style[k] !== undefined) (out as Record<string, unknown>)[k] = style[k];
  return out;
}

/**
 * SGR 0/1/2/3/4/7/22/23/24/27, 30–37/90–97/39, 40–47/100–107/49, 38;5;n / 48;5;n, 38;2;r;g;b / 48;2;r;g;b. Other
 * escapes (CSI, OSC, single) dropped; other control chars dropped (a tab becomes a space); adjacent same-style text
 * merged; trailing empty lines dropped. The style carries from one line to the next, as tmux writes it.
 */
export function ansiToSpans(capture: string): ScreenLine[] {
  const lines: ScreenLine[] = [];
  let line: ScreenLine = [];
  let style: Style = {};
  let text = '';
  /** Ends the pending text as a run in the current style (merged into the last run when that has the same style). */
  const flush = () => {
    if (!text) return;
    const last = line.at(-1);
    if (last && sameStyle(last, style)) last.text += text;
    else line.push({ text, ...styleCopy(style) });
    text = '';
  };
  const setStyle = (next: Style) => {
    if (!sameStyle(next, style)) flush();
    style = next;
  };
  const n = capture.length;
  for (let i = 0; i < n; i++) {
    const ch = capture[i];
    if (ch === ESC) {
      const next = capture[i + 1];
      if (next === '[') {
        // CSI: parameter bytes 0x30–0x3f, intermediates 0x20–0x2f, one final byte 0x40–0x7e.
        let j = i + 2;
        while (j < n && capture.charCodeAt(j) >= 0x30 && capture.charCodeAt(j) <= 0x3f) j++;
        const params = capture.slice(i + 2, j);
        while (j < n && capture.charCodeAt(j) >= 0x20 && capture.charCodeAt(j) <= 0x2f) j++;
        if (j >= n) break; // unfinished at the end
        if (capture[j] === 'm' && /^[\d;:]*$/.test(params)) setStyle(applySgr(style, params));
        i = j;
      } else if (next === ']' || next === 'P' || next === '_' || next === '^') {
        // OSC / DCS / APC / PM: up to BEL or ST (ESC \).
        let j = i + 2;
        while (j < n && capture[j] !== BEL && !(capture[j] === ESC && capture[j + 1] === '\\')) j++;
        i = j >= n ? n : capture[j] === BEL ? j : j + 1;
      } else if (next !== undefined && '()*+-./#%'.includes(next)) {
        i += 2; // charset designation and the like: ESC, one intermediate, one final
      } else {
        i += 1; // ESC and one character (or ESC at the very end)
      }
      continue;
    }
    if (ch === '\n') {
      flush();
      lines.push(line);
      line = [];
      continue;
    }
    if (ch === '\t') {
      text += ' ';
      continue;
    }
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) continue;
    text += ch;
  }
  flush();
  lines.push(line);
  while (lines.length && lines[lines.length - 1].every((s) => !s.text.trim())) lines.pop();
  return lines;
}
