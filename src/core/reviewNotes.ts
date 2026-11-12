/** A note the user left on a line (or lines) of a file in a Worktrees view diff. */
export interface ReviewNote {
  /** The file, relative to its worktree (as Claude, running there, names it). */
  path: string;
  /** 1-based first and last line; `endLine` is left out or equal for one line. */
  line: number;
  endLine?: number;
  text: string;
}

/** The note's text on one quoted line: backslashes, quotes and line breaks escaped, so a note cannot end its own quote. */
export function quoteNote(text: string): string {
  const escaped = text.trim().replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t');
  return `"${escaped}"`;
}

/** One note as Claude reads it: `File: <path>`, `Line: <n>` (or `Lines: <a>-<b>`), `User comment: "<text>"`. */
export function formatReviewNote(n: ReviewNote): string {
  const where = n.endLine !== undefined && n.endLine !== n.line ? `Lines: ${n.line}-${n.endLine}` : `Line: ${n.line}`;
  return [`File: ${n.path}`, where, `User comment: ${quoteNote(n.text)}`].join('\n');
}

/** Notes in file order (path, then line), with empty ones left out. */
export function sortedNotes(notes: readonly ReviewNote[]): ReviewNote[] {
  return notes
    .filter((n) => n.text.trim())
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line || (a.endLine ?? a.line) - (b.endLine ?? b.line)));
}

/** The prompt that sends the notes to Claude: a line saying what they are, then each note, a blank line between them. */
export function reviewPrompt(notes: readonly ReviewNote[]): string {
  const sorted = sortedNotes(notes);
  const intro = `Review notes on your changes (${sorted.length === 1 ? '1 note' : `${sorted.length} notes`}). Address each one:`;
  return [intro, ...sorted.map(formatReviewNote)].join('\n\n');
}
