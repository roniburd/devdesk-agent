// The Screen tab: the pane capture as `ScreenLine[]` (see core/web/ansi.ts) turned into spans. Text goes in through
// `textContent` and colours through the CSSOM (`el.style`), which `Content-Security-Policy: default-src 'self'` allows.
import type { ScreenLine, Span } from '../../core/web/types';

const CUBE = [0, 95, 135, 175, 215, 255];
const hex2 = (n: number) => n.toString(16).padStart(2, '0');

/**
 * A span colour as CSS: 0–15 from the page's terminal palette (`--ansi-<n>`, which follows light/dark), 16–231 the
 * xterm 6×6×6 cube, 232–255 the grey ramp, `#rrggbb` as is. Anything else: undefined (the default colour).
 */
export function cssColor(c: number | string | undefined): string | undefined {
  if (typeof c === 'string') return /^#[0-9a-f]{6}$/i.test(c) ? c : undefined;
  if (typeof c !== 'number' || !Number.isInteger(c) || c < 0 || c > 255) return undefined;
  if (c < 16) return `var(--ansi-${c})`;
  if (c >= 232) {
    const v = 8 + 10 * (c - 232);
    return `#${hex2(v)}${hex2(v)}${hex2(v)}`;
  }
  const i = c - 16;
  return `#${hex2(CUBE[Math.floor(i / 36)])}${hex2(CUBE[Math.floor(i / 6) % 6])}${hex2(CUBE[i % 6])}`;
}

function spanEl(s: Span): HTMLSpanElement {
  const el = document.createElement('span');
  el.textContent = s.text;
  let fg = cssColor(s.fg);
  let bg = cssColor(s.bg);
  if (s.inverse) [fg, bg] = [bg ?? 'var(--screen-bg)', fg ?? 'var(--screen-fg)'];
  if (fg) el.style.color = fg;
  if (bg) el.style.backgroundColor = bg;
  if (s.bold) el.style.fontWeight = '700';
  if (s.dim) el.style.opacity = '0.6';
  if (s.italic) el.style.fontStyle = 'italic';
  if (s.underline) el.style.textDecoration = 'underline';
  return el;
}

/** One `<div>` per screen line (an empty line keeps its height), each holding its styled spans. */
export function renderScreen(target: HTMLElement, lines: ScreenLine[]): void {
  const rows = lines.map((line) => {
    const row = document.createElement('div');
    row.className = 'row';
    if (line.length === 0) row.textContent = ' ';
    for (const s of line) row.append(spanEl(s));
    return row;
  });
  target.replaceChildren(...rows);
}
