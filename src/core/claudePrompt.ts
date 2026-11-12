/** One screen cell of a `tmux capture-pane -e` line, with the styles that matter for Claude's prompt. */
interface Cell {
  ch: string;
  dim: boolean;
  inverse: boolean;
}

/** Splits a captured line into cells, following SGR escapes (`ESC[...m`) for dim (2/22) and inverse (7/27). */
function cells(line: string): Cell[] {
  const out: Cell[] = [];
  let dim = false;
  let inverse = false;
  for (let i = 0; i < line.length; ) {
    const sgr = /^\x1b\[([0-9;:]*)m/.exec(line.slice(i));
    if (sgr) {
      const params = sgr[1] === '' ? [0] : sgr[1].split(/[;:]/).map(Number);
      for (let p = 0; p < params.length; p++) {
        const n = params[p];
        // 38/48/58 carry a colour (`5;N` or `2;R;G;B`) that is not a style.
        if (n === 38 || n === 48 || n === 58) p += params[p + 1] === 5 ? 2 : 4;
        else if (n === 0) dim = inverse = false;
        else if (n === 2) dim = true;
        else if (n === 22) dim = false;
        else if (n === 7) inverse = true;
        else if (n === 27) inverse = false;
      }
      i += sgr[0].length;
      continue;
    }
    if (line[i] === '\x1b') {
      // Any other escape sequence carries no text.
      const other = /^\x1b(\[[0-9;?]*[A-Za-z]|\][^\x07]*\x07|.)/.exec(line.slice(i));
      i += other ? other[0].length : 1;
      continue;
    }
    const ch = String.fromCodePoint(line.codePointAt(i)!);
    out.push({ ch, dim, inverse });
    i += ch.length;
  }
  return out;
}

const text = (cs: Cell[]) => cs.map((c) => c.ch).join('');
const isRule = (cs: Cell[]) => text(cs).trimStart().startsWith('─');

/** The index of the last prompt box's `❯` line (right below its top rule), or -1 when no prompt box is on screen. */
function promptLine(lines: Cell[][]): number {
  for (let i = lines.length - 1; i > 0; i--) if (text(lines[i]).trimStart().startsWith('❯') && isRule(lines[i - 1])) return i;
  return -1;
}

/** The index of the prompt box's bottom rule (the line count when it is off screen), for a box starting at line `start`. */
function boxEnd(lines: Cell[][], start: number): number {
  let end = start + 1;
  while (end < lines.length && !isRule(lines[end])) end++;
  return end;
}

/**
 * True when Claude Code's prompt, in a `tmux capture-pane -p -e` capture of its pane, holds no text: the `❯` line right
 * below the input box's top rule, and any lines up to the bottom rule, show nothing but the cursor and Claude's dimmed
 * placeholder (whose first character Claude draws as the inverted cursor), with the cursor right after `❯ ` (so typed
 * spaces count as text). False when no prompt box is on screen, such as while a dialog or menu is open.
 */
export function claudePromptIsEmpty(capture: string): boolean {
  const lines = capture.split('\n').map(cells);
  const start = promptLine(lines);
  if (start < 0) return false;
  const box = lines.slice(start, boxEnd(lines, start)).flat();
  const prompt = box.slice(box.findIndex((c) => c.ch === '❯') + 1);
  const cursor = prompt.findIndex((c) => c.inverse);
  // Claude draws one space after `❯`, then the cursor: any cell between them (a typed space, or a typed newline's
  // indent) is text, which the command would be typed after.
  if (cursor > 1) return false;
  const placeholder = cursor >= 0 && prompt.slice(cursor + 1).some((c) => c.dim && c.ch.trim());
  return prompt.every((c, i) => c.dim || !c.ch.trim() || (i === cursor && placeholder));
}

/**
 * True when Claude Code's prompt box shows in a `tmux capture-pane -p -e` capture of its pane, empty or not. False while
 * a dialog or menu (a permission prompt, a choice) takes its place: what Claude waits for then is a key, not text.
 */
export function claudePromptShown(capture: string): boolean {
  return promptLine(capture.split('\n').map(cells)) >= 0;
}

/** How many lines above the prompt box's top rule Claude's spinner may sit (its todo list can show in between). */
const SPINNER_REACH = 12;
/**
 * Claude's spinner while it works: at the start of the line, a glyph, then a verb with an ellipsis
 * (`✻ Pondering… (12s · esc to interrupt)`). Not indented, unlike a list item in Claude's reply (`  * Building…`).
 */
const SPINNER = /^[·✢✳✶✻✽*]\s+\S+…/;

/**
 * True when a `tmux capture-pane -p -e` capture of Claude Code's pane shows Claude in a turn: its spinner as the last
 * line above the last prompt box (but for blank or indented lines, as its todo list or a tip), or its "esc to interrupt"
 * hint below the box. Claude keeps the prompt box open (and empty) while it works, so `claudePromptIsEmpty` cannot
 * tell; without status hooks (a card in state `unknown`), this does. The transcript above the spinner's place is not
 * looked at: a prompt or reply there may mention "esc to interrupt", or list `  * Building…`, while Claude is idle.
 */
export function claudeIsWorking(capture: string): boolean {
  const lines = capture.split('\n').map(cells);
  const start = promptLine(lines);
  if (start < 0) return false;
  if (lines.slice(boxEnd(lines, start) + 1).some((cs) => /esc to interrupt/i.test(text(cs)))) return true;
  for (let i = start - 2; i >= Math.max(0, start - 1 - SPINNER_REACH); i--) {
    const t = text(lines[i]);
    if (!t.trim() || /^\s/.test(t)) continue;
    return SPINNER.test(t);
  }
  return false;
}
