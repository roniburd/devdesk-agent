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
      const other = /^\x1b(\[[0-9;?]*[A-Za-z]|\][^\x07\x1b]*(\x07|\x1b\\)|.)/.exec(line.slice(i));
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

/**
 * What Claude Code (2.1.319 at least) draws right after its composer's glyph: a no-break space (U+00A0), where a
 * prompt echoed in its transcript (`❯ fix the tests`), a dialog's menu (`❯ 1. Yes`) and a shell prompt (p10k,
 * starship) have a plain space. The glyph is `❯`, or `!` in Claude's shell mode.
 */
const COMPOSER_SPACE = '\u00a0';
/** The composer's glyphs: `❯`, `!` in shell mode. (Claude puts a no-break space after its transcript's `⏺` too.) */
const COMPOSER_GLYPHS = new Set(['❯', '!']);

/** The index of `cs`'s composer glyph (its first non-blank cell, the no-break space after it), else -1. */
function composerGlyphAt(cs: Cell[]): number {
  const at = cs.findIndex((c) => c.ch.trim() !== '');
  return at >= 0 && COMPOSER_GLYPHS.has(cs[at].ch) && cs[at + 1]?.ch === COMPOSER_SPACE ? at : -1;
}

/** The index of the last composer line on screen (a glyph and the no-break space, right below a rule), or -1. */
function composerLine(lines: Cell[][]): number {
  for (let i = lines.length - 1; i > 0; i--) if (composerGlyphAt(lines[i]) >= 0 && isRule(lines[i - 1])) return i;
  return -1;
}

/**
 * The index of the last prompt box's first line, right below its top rule: the composer's, else (an older Claude) the
 * last `❯` line there; -1 when no prompt box is on screen.
 */
function promptLine(lines: Cell[][]): number {
  const composer = composerLine(lines);
  if (composer >= 0) return composer;
  for (let i = lines.length - 1; i > 0; i--) if (text(lines[i]).trimStart().startsWith('❯') && isRule(lines[i - 1])) return i;
  return -1;
}

/** The index of the prompt box's bottom rule (the line count when it is off screen), for a box starting at line `start`. */
function boxEnd(lines: Cell[][], start: number): number {
  let end = start + 1;
  while (end < lines.length && !isRule(lines[end])) end++;
  return end;
}

/** What tmux knows of a pane without reading its text, read along with the capture (`paneScreenArgs`). */
export interface PaneFlags {
  /** The pane is in a tmux mode (`#{pane_in_mode}`), as copy mode: keys go to the mode, not to Claude. */
  inMode: boolean;
  /**
   * The program turned bracketed paste on (`#{bracket_paste_flag}`; undefined when this tmux does not tell). Claude
   * does while it reads input (with focus events and palette updates: `ESC[?2004h ESC[?2031h ESC[?1004h`), so with
   * it off nothing reads a prompt. A shell's line editor turns it on too: it does not tell Claude from a shell.
   */
  bracketPaste?: boolean;
  /**
   * Where the program put the terminal's cursor (`#{cursor_x}`, `#{cursor_y}`, from the top of the visible screen).
   * Claude hides it and draws its own (an inverted cell), but parks it at its caret: right after `❯` and the no-break
   * space when nothing is typed before the caret; elsewhere when a dialog takes the keys, or once Claude has exited
   * (its last prompt box can stay on screen above the shell prompt).
   */
  cursor?: { x: number; y: number };
}

/** The tmux format `parsePaneFlags` reads, its fields joined by `sep`. */
export const paneFlagsFormat = (sep: string) => ['#{pane_in_mode}', '#{bracket_paste_flag}', '#{cursor_x}', '#{cursor_y}'].join(sep);

/** The number of fields in `paneFlagsFormat`. */
const FLAG_FIELDS = 4;

/** Reads `paneFlagsFormat`'s fields (already split); undefined when they are not tmux's answer to it. */
export function parsePaneFlags(fields: readonly string[]): PaneFlags | undefined {
  const [inMode, paste, x, y] = fields.map((f) => f.trim());
  const num = (v: string | undefined) => (v !== undefined && /^\d+$/.test(v) ? Number(v) : undefined);
  if (num(inMode) === undefined) return undefined;
  const cx = num(x);
  const cy = num(y);
  return {
    inMode: inMode !== '0',
    bracketPaste: paste === '1' ? true : paste === '0' ? false : undefined,
    cursor: cx !== undefined && cy !== undefined ? { x: cx, y: cy } : undefined,
  };
}

/**
 * tmux arguments that capture `target`'s visible screen (`capture-pane -p -e`) and print its flags (`paneFlagsFormat`,
 * then the `extra` format fields, all joined by `sep`) as one more line, in one call: tmux runs both commands before it
 * reads more of the pane's output, so the flags describe the screen captured.
 */
export function paneScreenArgs(target: string, sep: string, extra: readonly string[] = []): string[] {
  return ['capture-pane', '-p', '-e', '-t', target, ';', 'display-message', '-p', '-t', target, [paneFlagsFormat(sep), ...extra].join(sep)];
}

/** Splits `paneScreenArgs`' output into the capture, the pane's flags (undefined when unreadable) and the extra fields. */
export function parsePaneScreen(output: string, sep: string): { capture: string; flags?: PaneFlags; extra: string[] } {
  const body = output.endsWith('\n') ? output.slice(0, -1) : output;
  const nl = body.lastIndexOf('\n');
  const fields = body.slice(nl + 1).split(sep);
  return { capture: nl < 0 ? '' : body.slice(0, nl), flags: parsePaneFlags(fields.slice(0, FLAG_FIELDS)), extra: fields.slice(FLAG_FIELDS) };
}

/**
 * True when Claude Code's prompt, in a `tmux capture-pane -p -e` capture of its pane, holds no text, so what is typed
 * now lands at an empty prompt. `flags` is what tmux tells of the pane, read in the same call (`paneScreenArgs`). False
 * when the pane is in a tmux mode or no prompt box is on screen, such as while a dialog or menu is open. In order:
 * 1. the pane's flags: in a tmux mode, or with bracketed paste off (nothing reads a prompt), it is not;
 * 2. Claude's composer, `❯` and a no-break space right below a rule (Claude 2.1.319 and later): the caret (the cursor
 *    tmux reports, else the inverted cell) is right after them, with nothing but blanks and Claude's dimmed
 *    placeholder after it in the box. With the cursor elsewhere, a dialog has the keys, Claude has gone back to the
 *    shell, or text is typed before the caret. Shell mode (`!` for `❯`) is not an empty prompt;
 * 3. else (an older Claude, with a plain space after `❯`): the `❯` line right below the input box's top rule, and any
 *    lines up to the bottom rule, show nothing but the inverted cursor right after `❯ ` (so typed spaces count as
 *    text) and Claude's dimmed placeholder (whose first character Claude draws as the inverted cursor).
 */
export function claudePromptIsEmpty(capture: string, flags?: PaneFlags): boolean {
  if (flags?.inMode || flags?.bracketPaste === false) return false;
  const lines = capture.split('\n').map(cells);
  const composer = composerLine(lines);
  if (composer < 0) return legacyPromptIsEmpty(lines);
  const line = lines[composer];
  const glyph = composerGlyphAt(line);
  if (line[glyph].ch !== '❯') return false;
  const caret = glyph + 2;
  if (flags?.cursor ? flags.cursor.y !== composer || flags.cursor.x !== caret : !line[caret]?.inverse) return false;
  const after = [...line.slice(caret), ...lines.slice(composer + 1, boxEnd(lines, composer)).flat()];
  // The caret's cell holds a space, or the placeholder's first character (the rest of the placeholder dimmed).
  const placeholder = after.slice(1).some((c) => c.dim && c.ch.trim());
  return after.every((c, i) => c.dim || !c.ch.trim() || (i === 0 && placeholder));
}

/** `claudePromptIsEmpty` for a screen without Claude's composer signature (a Claude older than the no-break space). */
function legacyPromptIsEmpty(lines: Cell[][]): boolean {
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
