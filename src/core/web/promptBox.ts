import { BUILTINS, classifySubmission, savedLaunchSettingNotice, spelledText, type Submission, typedCommand } from '../builtins';
import { commandRow, type CommandRow, menuCommands, slashTrigger, UNSTACKABLE } from '../commandMenu';
import { filterCommands } from '../commandFilter';
import { DEFAULT_CHOICE, EFFORT_LEVELS, findModel, isClaudeAlias, modelsStartingWith } from '../composer';
import type { SlashCommand } from '../slashCommands';
import type { WebCommand, WebModel } from './types';

// What the web page's prompt box does with what is typed in it, as the Claude Board's box does, without Node or the
// DOM (the page bundles it; the tests run it): which `/` menu rows to show, and what Start does with the text.

/** Built-ins that do nothing in a box that only starts sessions: typed, they say why; the menu leaves them out. */
const NOT_OFFERED = new Set(['resume', 'add-dir']);

/** What the menu offers: what starts a session or sets the pills, not what needs a running session (C) or is blocked (E). */
const startsHere = (c: SlashCommand) => c.category !== 'C' && c.category !== 'E' && !(c.origin === 'built-in' && NOT_OFFERED.has(c.name));

/** The `/` menu rows for the text before the caret, with where the `/word` starts; undefined when no menu opens there. */
export function slashMenu(before: string, commands: readonly WebCommand[], limit = 50): { start: number; rows: CommandRow[] } | undefined {
  const at = slashTrigger(before, UNSTACKABLE);
  if (!at) return undefined;
  const offered = menuCommands(commands as readonly SlashCommand[], at.stacked).filter(startsHere);
  return { start: at.start, rows: filterCommands(offered, at.query, limit).map(commandRow) };
}

/** The pills' choices when Start is pressed. */
export interface BoxChoice {
  mode: string;
  model: string;
  effort: string;
}

/** What Start does with the box's text. */
export type BoxAction =
  /** Start a session on `prompt` (may be empty), in `mode` when given (else the chosen one). */
  | { kind: 'start'; prompt: string; mode?: string }
  /** A pill changes (`/model x`, `/effort x`); the box empties and says `note`. */
  | { kind: 'set'; model?: string; effort?: string; note: string }
  | { kind: 'clear' }
  /** The text stays; the box says `text`. `confirm`: pressing Start again with the same text starts on it anyway. */
  | { kind: 'notice'; text: string; confirm?: boolean };

const webReason = (reason: string | undefined) => (reason ?? 'Web Access does not run this command.').replace(/\bthe board\b/g, 'Web Access');

/** The help `/help` shows. */
export const BOX_HELP =
  'Type a prompt, or / for skills and commands. /model and /effort set the pills, /plan <task> starts in plan mode. ' +
  'Commands for a running session go in its reply box.';

/**
 * What Start does with `text`, given what the box offers and the pills' choices: a prompt, a skill or an interactive
 * command (D, whose panel the new session shows) starts a session on it; `/model` and `/effort` set the pills; `/plan
 * <task>` starts in the plan mode; `/clear` empties the box; anything else says why it does not run here.
 */
export function boxAction(text: string, o: { commands: readonly WebCommand[]; models: readonly WebModel[]; planMode?: string; choice: BoxChoice; confirmed?: boolean }): BoxAction {
  const sub = classifySubmission(text, BUILTINS, o.commands);
  switch (sub.kind) {
    case 'text':
    case 'F':
      return { kind: 'start', prompt: spelledText(text, sub).trim() };
    case 'D':
      return savedLaunchSettingNotice(sub) ? { kind: 'notice', text: webReason(savedLaunchSettingNotice(sub)) } : { kind: 'start', prompt: spelledText(text, sub).trim() };
    case 'A':
      return boardCommand(sub, o);
    case 'B':
      return launchCommand(sub, o.planMode);
    case 'C':
      return { kind: 'notice', text: `${typedCommand(sub)} works in a running session: open it and type it in its reply box.` };
    case 'E':
      return { kind: 'notice', text: `${typedCommand(sub)} does not run from Web Access. ${webReason(sub.builtin?.reason)}` };
    case 'unknown':
      if (o.confirmed) return { kind: 'start', prompt: text.trim() };
      return {
        kind: 'notice',
        text: `${typedCommand(sub)} is not a command, skill or plugin prompt Claude knows here. Press Start again to send it as text anyway (a paid turn).`,
        confirm: true,
      };
  }
}

function boardCommand(sub: Submission, o: { models: readonly WebModel[]; choice: BoxChoice }): BoxAction {
  switch (sub.command) {
    case 'model': {
      if (!sub.arg) return { kind: 'notice', text: `The model is ${labelOf(o.models, o.choice.model)}. Pick another with the model pill, or type /model <name>.` };
      const row = findModel(o.models, sub.arg);
      if (row) return { kind: 'set', model: row.value, note: `Model: ${row.label}.` };
      if (isClaudeAlias(sub.arg)) return { kind: 'set', model: sub.arg.toLowerCase(), note: `Model: ${sub.arg.toLowerCase()}.` };
      const some = modelsStartingWith(o.models, sub.arg);
      const which = (some.length ? some : o.models).map((r) => r.label).join(', ');
      return { kind: 'notice', text: `No single model is called ${sub.arg}. ${some.length ? 'It could be' : 'The models are'}: ${which}.` };
    }
    case 'effort': {
      const row = o.models.find((r) => r.value === o.choice.model);
      const offered = row?.efforts ?? EFFORT_LEVELS;
      const want = sub.arg.toLowerCase();
      if (!want) return { kind: 'notice', text: `The effort is ${o.choice.effort}. Pick another with the effort pill, or type /effort <level>.` };
      if (want === 'auto' || want === 'default') return { kind: 'set', effort: DEFAULT_CHOICE, note: 'Effort: Default.' };
      if (offered.includes(want)) return { kind: 'set', effort: want, note: `Effort: ${want}.` };
      if (!offered.length) return { kind: 'notice', text: `${row?.label ?? 'This model'} takes no effort level.` };
      return { kind: 'notice', text: `The effort levels are ${offered.join(', ')}, or auto.` };
    }
    case 'clear':
      return { kind: 'clear' };
    case 'help':
      return { kind: 'notice', text: BOX_HELP };
    case 'resume':
      return { kind: 'notice', text: 'Pick a session from the list to open it.' };
    default:
      return { kind: 'notice', text: `${typedCommand(sub)} does not run from Web Access.` };
  }
}

function launchCommand(sub: Submission, planMode: string | undefined): BoxAction {
  if (sub.command === 'plan') {
    if (!sub.arg) return { kind: 'notice', text: 'Type the task after /plan: /plan <task>.' };
    if (!planMode) return { kind: 'notice', text: 'No mode in devdesk.sessions.modes starts Claude in plan mode.' };
    return { kind: 'start', prompt: sub.arg, mode: planMode };
  }
  return { kind: 'notice', text: `${typedCommand(sub)} does not run from Web Access: start that session from the Claude Board.` };
}

function labelOf(models: readonly WebModel[], value: string): string {
  return models.find((m) => m.value === value)?.label ?? value;
}

// ---- A running session's reply box ----

/**
 * What a board-native (A) built-in does when typed into a running session: Claude runs it, so the menu says what Claude
 * does. The others (`/help`, `/resume`) and the launch flags (B) are the board's, and the reply box leaves them out.
 */
const IN_SESSION: Readonly<Record<string, string>> = {
  model: "Set this session's model",
  effort: "Set this session's effort level",
  clear: "Clear this session's conversation and start fresh",
};

const runsInSession = (c: SlashCommand) => c.category !== 'E' && c.category !== 'B' && (c.category !== 'A' || c.name in IN_SESSION);

/**
 * The `/` menu rows for a running session's reply box, for the text before the caret: what Claude runs in a session
 * (C, D, skills and prompts, and `/model`, `/effort`, `/clear`), not what is blocked (E) or only the board does. Its rows
 * have no category or badge (all of them go to the session), and a command that needs no argument runs when picked.
 */
export function replyMenu(before: string, commands: readonly WebCommand[], limit = 50): { start: number; rows: CommandRow[] } | undefined {
  const at = slashTrigger(before, UNSTACKABLE);
  if (!at) return undefined;
  const offered = menuCommands(commands as readonly SlashCommand[], at.stacked)
    .filter(runsInSession)
    .map((c) => (c.category === 'A' ? { ...c, category: 'C' as const, description: IN_SESSION[c.name] } : c));
  return {
    start: at.start,
    rows: filterCommands(offered, at.query, limit).map((m) => {
      const { category: _category, badge: _badge, ...row } = commandRow(m);
      return row;
    }),
  };
}

/** What Send does with a running session's reply: type it in (a command spelled as Claude knows it), or say why not. */
export type ReplyAction = { kind: 'send'; text: string } | { kind: 'notice'; text: string };

/** A blocked (E) command says why and is not sent; anything else goes to the session as typed, which runs it there. */
export function replyAction(text: string, commands: readonly WebCommand[]): ReplyAction {
  const sub = classifySubmission(text, BUILTINS, commands);
  if (sub.kind === 'E') return { kind: 'notice', text: `${typedCommand(sub)} does not run from Web Access. ${webReason(sub.builtin?.reason)}` };
  return { kind: 'send', text: spelledText(text, sub) };
}
