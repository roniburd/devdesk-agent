import type { CliListing } from '../cliStream';
import { menuCommands } from '../commandMenu';
import { aliasChoices, choiceArgs, DEFAULT_CHOICE, EFFORT_LEVELS, modelChoices } from '../composer';
import { DEFAULT_MODE_NAME, joinArgs, type LaunchMode } from '../modes';
import { DEFAULT_CLAUDE_PATH } from '../tmux';
import { type SlashCommand, withBuiltins, withDiskCommands } from '../slashCommands';
import type { DaemonConfig } from './config';
import type { ComposerResponse, NewSessionRequest, WebModel } from './types';

/**
 * What the web page's prompt box offers (`GET api/composer`) and what a new session it starts may choose, as the Claude
 * Board's box does: the `/` commands, the model, effort and mode pills. The daemon passes in what the CLI listed for the
 * folder and what its skill and command folders hold; nothing here runs a program.
 */

type ClaudeConfig = DaemonConfig['claude'];

/** The configured launch modes, or only the default mode's arguments when the config has none. */
export function webModes(claude: ClaudeConfig): LaunchMode[] {
  if (claude.modes?.length) return claude.modes;
  return [{ name: claude.defaultMode || DEFAULT_MODE_NAME, args: claude.modeArgs }];
}

/** The default mode's name: `defaultMode` when it is one of the modes, else the first. */
function defaultModeName(claude: ClaudeConfig, modes: readonly LaunchMode[]): string {
  return modes.find((m) => m.name === claude.defaultMode)?.name ?? modes[0].name;
}

/** The model pill's rows: Default first, then `devdesk.board.models`, else the CLI's rows, else Claude's aliases. */
export function webModels(claude: ClaudeConfig, listing: CliListing | undefined): WebModel[] {
  return modelChoices(claude.models ?? [], listing?.models);
}

/**
 * What the box offers for one folder: the CLI's commands (when it answered) with what the folders hold that it lacks,
 * and the built-ins with their categories; internal commands left out. `listing` is still pending: the page asks again.
 */
export function composerResponse(o: { claude: ClaudeConfig; listing: CliListing | undefined; onDisk: readonly SlashCommand[]; pending: boolean }): ComposerResponse {
  const modes = webModes(o.claude);
  const plan = modes.find((m) => /(^|\s)--permission-mode[ =]plan(\s|$)/.test(m.args));
  const commands = menuCommands(withBuiltins(o.listing ? withDiskCommands(o.listing.commands, o.onDisk) : o.onDisk));
  return {
    commands: commands.map((c) => ({
      name: c.name,
      description: c.description,
      origin: c.origin,
      ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}),
      ...(c.aliases?.length ? { aliases: c.aliases } : {}),
      ...(c.category ? { category: c.category } : {}),
      ...(c.hidden ? { hidden: true } : {}),
    })),
    models: webModels(o.claude, o.listing),
    modes: modes.map((m) => ({ name: m.name, description: m.description ?? m.args })),
    defaultMode: defaultModeName(o.claude, modes),
    ...(plan ? { planMode: plan.name } : {}),
    listing: o.pending,
  };
}

/**
 * The `claude` arguments for a new session's choices, before the prompt: the mode's (the default mode's when none is
 * chosen), then `--model` and `--effort`. Only what the box offers is taken: a mode by its name, a model the pill
 * lists or one of Claude's aliases, an effort level the model offers. Anything else is an error, so the page can never
 * pass arguments of its own.
 */
export function launchArgs(req: Pick<NewSessionRequest, 'mode' | 'model' | 'effort'>, claude: ClaudeConfig, models: readonly WebModel[]): { args: string } | { error: string } {
  const modes = webModes(claude);
  const modeName = req.mode ?? defaultModeName(claude, modes);
  const mode = modes.find((m) => m.name === modeName);
  if (!mode) return { error: `There is no mode named ${modeName}.` };
  const model = req.model || DEFAULT_CHOICE;
  const row = [...models, ...aliasChoices(claude.models ?? [], models)].find((r) => r.value === model);
  if (!row) return { error: `${model} is not one of the models offered.` };
  const effort = req.effort || DEFAULT_CHOICE;
  if (effort !== DEFAULT_CHOICE && !(EFFORT_LEVELS.includes(effort) && row.efforts.includes(effort))) {
    return { error: row.efforts.length ? `${row.label} does not take effort ${effort}.` : `${row.label} takes no effort level.` };
  }
  return { args: joinArgs(mode.args, choiceArgs({ model, effort })) };
}

/** Claude as the daemon asks it for its `/` list: the first word of a full command, else the binary with its arguments. */
export function claudeInvocationOf(claude: Pick<ClaudeConfig, 'command' | 'path' | 'args'>): string {
  const command = claude.command?.trim();
  if (command) return command.split(/\s/)[0];
  return joinArgs(claude.path || DEFAULT_CLAUDE_PATH, claude.args);
}
