import { isPromptKind, type SubmissionKind } from './builtins';
import { DEFAULT_CHOICE, EFFORT_LEVELS } from './composer';

/** What `/effort <arg>` asks the board to do with its effort and Ultracode choices (never Claude's settings). */
export type EffortCommand =
  /** No argument: open the effort row of the model pill. */
  | { kind: 'open' }
  /** Show the current choices. */
  | { kind: 'status' }
  /** A level (`Default` for `auto`). */
  | { kind: 'set'; effort: string }
  /** A real level the chosen model does not offer (`offered`: its levels, none for a model without effort). */
  | { kind: 'unsupported'; level: string; offered: readonly string[] }
  /** `ultracode` (`on`: undefined toggles it). */
  | { kind: 'ultracode'; on?: boolean }
  /** Anything else: why, for the box. */
  | { kind: 'invalid'; reason: string };

/** What `/effort` takes, as Claude Code's `/effort` usage line says it. */
const EFFORT_USAGE = `/effort [${[...EFFORT_LEVELS, 'auto', 'status'].join('|')}] or /effort ultracode [on|off]`;

/**
 * What `/effort <arg>` means for the board, given the levels the chosen model offers besides Default (`ModelChoice.efforts`):
 * `auto` (or `default`) is Default (no `--effort`); a level must be one the model offers; `ultracode [on|off]` is the
 * Ultracode switch (no `on`/`off` toggles it). Case does not matter.
 */
export function parseEffortCommand(arg: string, offered: readonly string[]): EffortCommand {
  const words = arg.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return { kind: 'open' };
  const [first, second, ...rest] = words;
  if (first === 'ultracode') {
    if (rest.length || (second !== undefined && second !== 'on' && second !== 'off')) return { kind: 'invalid', reason: `Use /effort ultracode, /effort ultracode on or /effort ultracode off.` };
    return second === undefined ? { kind: 'ultracode' } : { kind: 'ultracode', on: second === 'on' };
  }
  if (second !== undefined) return { kind: 'invalid', reason: `Use ${EFFORT_USAGE}.` };
  if (first === 'status') return { kind: 'status' };
  if (first === 'auto' || first === DEFAULT_CHOICE.toLowerCase()) return { kind: 'set', effort: DEFAULT_CHOICE };
  if (offered.includes(first)) return { kind: 'set', effort: first };
  if (EFFORT_LEVELS.includes(first)) return { kind: 'unsupported', level: first, offered };
  return { kind: 'invalid', reason: `${first} is not an effort level: use ${EFFORT_USAGE}.` };
}

/**
 * What a new session's first prompt gets besides the text: Ultracode and the Spec prefix apply only to prompts (category F
 * and plain text), never to a command the board handles, so `/model` never becomes `/model\n\nultracode` and Spec never
 * makes `/superpowers:brainstorming /model`.
 */
export function promptDecoration(kind: SubmissionKind, options: { ultracode?: boolean; prefix?: string }): { ultracode: boolean; prefix?: string } {
  if (!isPromptKind(kind)) return { ultracode: false };
  return { ultracode: !!options.ultracode, ...(options.prefix ? { prefix: options.prefix } : {}) };
}
