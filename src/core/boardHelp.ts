import { BUILTINS, type Builtin, type Category, type Submission } from './builtins';
import { isInternal } from './commandMenu';

/** What the board does with a command of each category, as `/help` says it. */
const CATEGORY_HELP: Readonly<Record<Category, { title: string; does: string }>> = {
  A: { title: 'Board', does: 'the board does it itself; nothing is sent to Claude' },
  B: { title: 'New session options', does: 'becomes launch options of the next new session (/plan starts it on the task)' },
  C: { title: 'Sent to a running session', does: 'typed into a running session you pick, when its prompt is empty' },
  D: { title: 'Panels', does: 'opens its panel in a running session you pick or a new one, and shows that session' },
  E: { title: 'Not from the board', does: "the board says why it can't run here and starts nothing" },
  F: { title: 'Prompts', does: 'starts a new session with it as the first prompt' },
};

const ORDER: readonly Exclude<Category, 'F'>[] = ['A', 'B', 'C', 'D', 'E'];

/**
 * The board's `/help`: one line per category with its commands (hidden ones left out), then what everything else
 * does. Lines are separated by newlines (the notice keeps them).
 */
export function boardHelp(catalog: readonly Builtin[] = BUILTINS): string {
  const lines = ORDER.map((category) => {
    const names = catalog.filter((b) => b.category === category && !b.hidden).map((b) => `/${b.name}`);
    return names.length ? `${CATEGORY_HELP[category].title} (${CATEGORY_HELP[category].does}): ${names.join(' ')}` : '';
  }).filter(Boolean);
  return [
    "The prompt box's commands:",
    ...lines,
    `Anything else (skills, workflows, /init, /code-review, plain text) ${CATEGORY_HELP.F.does}.`,
    'Type /help <command> for one command.',
  ].join('\n');
}

/** Whether `/help` treats `submission` as not a command: text, unknown, or one of Claude Code's internal commands (never listed). */
export function isUnlisted(submission: Submission): boolean {
  return submission.kind === 'text' || submission.kind === 'unknown' || !submission.command || isInternal(submission.command);
}

/**
 * `/help <command>`: what `submission` (the classified `/<command>`) is and what the board does with it; `description`
 * is the CLI's for commands outside the catalog.
 */
export function commandHelp(submission: Submission, description?: string): string {
  // Plain text (`/usr/bin`, `/?`) keeps its own slash; a command's name has none.
  const word = submission.alias ?? submission.command ?? submission.arg;
  const typed = word.startsWith('/') ? word : `/${word}`;
  if (isUnlisted(submission)) return `${typed} is not a command Claude lists here.`;
  const kind = submission.kind as Category;
  const b = submission.builtin;
  const name = `/${submission.command}`;
  const aliases = b?.aliases.length ? ` (also ${b.aliases.map((a) => `/${a}`).join(', ')})` : '';
  const hint = b?.argumentHint ? ` ${b.argumentHint}` : '';
  const what = (b?.description ?? description)?.trim().replace(/\.$/, '');
  const head = `${name}${hint}${aliases}${what ? `: ${what}` : ''}.`;
  const does = CATEGORY_HELP[kind].does;
  const tail = kind === 'E' && b?.reason ? `In the board: ${does}. ${b.reason}` : `In the board: ${does}.`;
  return `${head} ${tail}`;
}
