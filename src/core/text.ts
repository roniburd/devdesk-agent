/** `s` cut to at most `max` characters, ending in `…` when cut. */
export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** `s` on one line: runs of whitespace become one space, ends trimmed. */
export const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** `s` on one line, cut to `max` characters; undefined when it is empty. */
export function clip(s: string | undefined, max: number): string | undefined {
  const t = s ? oneLine(s) : '';
  return t ? truncate(t, max) : undefined;
}
