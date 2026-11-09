// Where the Claude Board's `/` menu opens in the prompt box: here for the extension's tests and for the board's
// webview (media/board.js imports it, bundled), so both follow one rule. Nothing here may need Node.

/**
 * The `/` word the caret ends (`before` is the text up to it): at the very start, or after whitespace anywhere else
 * (`stacked`, for skills only: after fewer than `maxStacked` `/commands`, or in the middle of the text, `inline`, as
 * Claude Code runs a skill named there too). None when the text starts with commands one of which is in
 * `unstackable`, as only a message's first command runs and these do not start a session on the text. Undefined when
 * the caret is not in one.
 */
export function slashWord(
  before: string,
  unstackable: readonly string[],
  maxStacked: number,
): { start: number; query: string; stacked: boolean; inline?: true } | undefined {
  const first = /^\/([\w:.-]*)$/.exec(before);
  if (first) return { start: 0, query: first[1], stacked: false };
  const word = /(?:^|\s)\/([\w:.-]*)$/.exec(before);
  if (!word) return undefined;
  const start = before.length - word[1].length - 1;
  const prefix = before.slice(0, start);
  const lead = /^(?:\/[\w:.-]+[ \t]+)*/.exec(prefix)![0];
  const leading = lead.match(/\/[\w:.-]+/g) ?? [];
  if (leading.some((c) => unstackable.includes(c.slice(1).toLowerCase()))) return undefined;
  const inline = lead.length < prefix.length || leading.length >= maxStacked;
  return { start, query: word[1], stacked: true, ...(inline ? { inline: true as const } : {}) };
}
