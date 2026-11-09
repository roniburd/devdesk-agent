import * as vscode from 'vscode';
import { BoardSessions } from './board/boardSessions';
import { CliListings } from './board/cliListings';
import { dispatch } from './board/dispatch';
import { attachFiles, FileMentions } from './board/fileMentions';
import { startedOutcome } from './board/outcomes';
import type { BoardUi, SubmitOutcome } from './board/types';
import { type BacklogItem, type Launch, launchKey, liveLaunches } from './core/board';
import { BUILTINS, classifySubmission, isPromptKind, spelledText, type Submission, type SubmissionKind, unknownCommandNotice } from './core/builtins';
import {
  aliasChoices,
  allowedModels,
  choiceArgs,
  type ComposeAllowed,
  DEFAULT_CHOICE,
  type LaunchChoice,
  launchPrompt,
  missingWorktree,
  modelChoices,
  type ModelChoice,
  modeTone,
  type ModeTone,
  parseChoice,
  planMode,
  specPrefix,
  typedModels,
} from './core/composer';
import { addDirArgs } from './core/launchFlags';
import { joinArgs, type LaunchMode, pickMode } from './core/modes';
import { promptDecoration } from './core/effort';
import { commandRow, type CommandRow, MAX_STACKED, menuCommands, UNSTACKABLE } from './core/commandMenu';
import { filterCommands, type SlashCommand, withBuiltins } from './core/slashCommands';
import { claudeNeedsTrust } from './claudeTrust';
import { sessionName } from './core/tmux';
import { MementoValue } from './state/mementoState';
import { trustNotice } from './core/trust';
import { promptArg } from './core/shell';
import { boardModels, boardOpensSession, boardPromptPlacement, boardSpecPrompt, sessionsClaudeCommand, sessionsDefaultMode, sessionsModes, sessionsTmuxServer, workspaceRoot } from './config';
import type { SessionCard } from './core/sessions';
import type { SessionsModel } from './sessionsModel';
import { hooksInstalled } from './hooksCommands';
import { startNumbered } from './sessionsCommands';
import type { SessionsTree } from './sessionsTree';
import { newWorktreeLaunchDir, newWorktreeSession, noWorktreesReason, type WorktreeTaskStore } from './worktreeSessions';

export const NO_FOLDER = 'Open a folder to start a session.';
const MAX_COMPLETIONS = 50;
/** `globalState` key of the models typed with `/model` that the pill offers (`BoardComposer.customModels`). */
const CUSTOM_MODELS_KEY = 'devdesk.board.customModels';

/** The composer's choices, posted with the board. */
export interface ComposerInfo {
  /** Why sessions cannot start (no folder open), or empty. */
  notReady: string;
  /** Why Start in offers no new worktree (a plain folder, neither a package workspace nor a git repository), or empty. */
  noWorktrees: string;
  /** Enter opens the new session (`devdesk.board.afterStart`: `session`) instead of staying on the board. */
  opensSession: boolean;
  /** Where the prompt box sits (`devdesk.board.promptPlacement`). */
  placement: 'bottom' | 'top';
  modes: { name: string; description: string; tone: ModeTone }[];
  defaultMode: string;
  /** The model pill's rows, Default first: from the CLI's model picker, `devdesk.board.models`, or Claude's aliases. */
  models: ModelChoice[];
  /**
   * Claude's aliases `models` has no row for (`aliasChoices`), and models typed with `/model` it does not list (all of
   * them when `devdesk.board.models` replaces the list), which the box keeps when chosen; never listed in the pill.
   */
  aliases: ModelChoice[];
  /** The models typed with `/model` the box remembers, which the model pill's **Forget typed models** removes. */
  typedModels: string[];
  /**
   * The CLI's models for main may still come (it is asked, or will be, and has not answered yet): meanwhile the pill
   * keeps a remembered model it does not offer yet, rather than showing Default (and `compose` waits for the answer).
   */
  modelsListing: boolean;
  /** Existing worktrees (main excluded) by name and directory. */
  worktrees: { name: string; dir: string }[];
  /** Directories added with `/add-dir` that the next session gets with `--add-dir` (chips in the box). */
  addDirs: string[];
  /** Goes up each time the `/` list changes (the CLI answered, or a `commands_changed` came): an open `/` menu asks again. */
  commandsVersion: number;
  /** Built-ins (names and aliases, lower case) after which `/` opens no stacked-skills menu: `UNSTACKABLE`. */
  unstackable: readonly string[];
  /** How many skills a message can stack: `MAX_STACKED`. */
  maxStacked: number;
}

/** A row in the composer's `/` or `@` popup: what it shows, and what picking it puts in the prompt (`@` rows use some fields). */
export type Completion = CommandRow;

/** How a prompt for later is started: as saved, in plan mode, or behind the spec instruction. */
export type StartHow = 'start' | 'plan' | 'spec';

/** How `start` launches a session besides the choice. */
export interface StartOptions {
  /** Instead of the choice's mode. */
  mode?: LaunchMode;
  /** Put before the prompt (Spec). */
  prefix?: string;
  /** Adds "ultracode" to the prompt (default: not). Only prompts (F, plain text) get it: see `promptDecoration`. */
  ultracode?: boolean;
  /** More `claude` arguments in shell syntax, after `--model`/`--effort` (`--add-dir '/x'`). */
  extraArgs?: string;
  /** Open the new session's terminal (true) or not, whatever `devdesk.board.afterStart` says (category D opens it). */
  open?: boolean;
  /** The box, for what to tell the user before the launch (Claude will ask to trust the folder). */
  ui?: BoardUi;
  /**
   * The prompt starts a turn (default), so the card shows the session as working on it while Claude starts; false for
   * a command that opens a panel instead (category D).
   */
  turn?: boolean;
}

/**
 * What the Claude Board's composer does on the extension side: its choices, completions, and what a submitted text
 * does (`submit`: classified, then run by its handler in `board/`). `info`, `allowed`, `start`, and what goes by where
 * a session runs (`dirOf`: `classify`, `commands`, `complete`, `attach`) use the worktrees the sessions model knows:
 * `await model.loadFeatures()` first.
 */
export class BoardComposer implements vscode.Disposable {
  /** What the CLI listed (models, `/` commands) per folder. */
  private readonly listings = new CliListings(() => this.changed.fire());
  /**
   * Models typed with `/model` that are not in the list: offered from then on, kept in `globalState` (the user's, in
   * every window) so a reload still offers (and starts saved prompts with) them. Read afresh each time, as another
   * window adds and forgets them too. The extension's own state, never Claude's settings.
   */
  private readonly customModels: MementoValue<string[]>;
  /** The models the board started sessions with, until their session is gone (see `launchedModels`). */
  private launches = new Map<string, Launch>();
  /** Added with `/add-dir`: the next session started gets `--add-dir` for each, then they are gone. */
  private launchDirs: string[] = [];
  private readonly files = new FileMentions();
  private readonly changed = new vscode.EventEmitter<void>();
  /** What `info` returns changed: the CLI answered, or a model was added. */
  readonly onDidChange = this.changed.event;

  constructor(
    readonly model: SessionsModel,
    readonly tree: SessionsTree,
    private readonly tasks: WorktreeTaskStore,
    state: vscode.Memento,
  ) {
    this.sessions = new BoardSessions(model, tree);
    this.customModels = new MementoValue(state, CUSTOM_MODELS_KEY, (kept) =>
      Array.isArray(kept) ? [...new Set(kept.filter((m): m is string => typeof m === 'string' && m.length > 0))] : [],
    );
  }

  /** The running sessions a command can go to: pick one, check its prompt, type into it, open it. */
  readonly sessions: BoardSessions;

  /** Runs before `start` launches a session whose terminal opens (the panel makes room for it beside the board). */
  beforeOpen: () => Promise<unknown> = async () => undefined;
  private plainFolder: { root: string | undefined; features: readonly unknown[]; reason: string } | undefined;

  info(): ComposerInfo {
    const modes = sessionsModes();
    const models = this.modelRows();
    return {
      notReady: workspaceRoot() ? '' : NO_FOLDER,
      noWorktrees: this.noWorktrees(workspaceRoot()),
      opensSession: boardOpensSession(),
      placement: boardPromptPlacement(),
      modes: modes.map((m) => ({ name: m.name, description: m.description ?? m.args, tone: modeTone(m) })),
      defaultMode: sessionsDefaultMode().name,
      models,
      aliases: this.unlisted(models),
      typedModels: [...this.customModels.get()],
      modelsListing: this.modelsListing(),
      worktrees: this.worktrees().map((f) => ({ name: f.name, dir: f.dir })),
      addDirs: [...this.launchDirs],
      commandsVersion: this.listings.version,
      unstackable: UNSTACKABLE,
      maxStacked: MAX_STACKED,
    };
  }

  /** Gives the next session started `--add-dir dir`; false when it already has it. */
  addLaunchDir(dir: string): boolean {
    if (this.launchDirs.includes(dir)) return false;
    this.launchDirs = [...this.launchDirs, dir];
    this.changed.fire();
    return true;
  }

  /** Takes back a directory added with `/add-dir` (its chip's ×). */
  removeLaunchDir(dir: string): void {
    if (!this.launchDirs.includes(dir)) return;
    this.launchDirs = this.launchDirs.filter((d) => d !== dir);
    this.changed.fire();
  }

  /** The mode `/plan` and a prompt for later's Plan start in. */
  planMode(): LaunchMode {
    return planMode(sessionsModes());
  }

  /** The model pill's rows: `devdesk.board.models`, else the CLI's (as last listed for main), else Claude's aliases. */
  modelRows(): ModelChoice[] {
    const root = workspaceRoot();
    const listing = root ? this.listings.listing(root) : undefined;
    return modelChoices(boardModels(), listing?.models, [...this.customModels.get()]);
  }

  /** The models the box takes: the pill's rows, then the ones it lacks (`unlisted`), each with the efforts it offers. */
  allowedRows(): ModelChoice[] {
    const rows = this.modelRows();
    return [...rows, ...this.unlisted(rows)];
  }

  /** The models the box takes that the pill's `rows` lack: Claude's aliases, then models typed with `/model`. */
  private unlisted(rows: ModelChoice[]): ModelChoice[] {
    const aliases = aliasChoices(boardModels(), rows);
    return [...aliases, ...typedModels([...rows, ...aliases], [...this.customModels.get()])];
  }

  /** Whether the CLI's models for main are not listed yet but may come (see `ComposerInfo.modelsListing`). */
  private modelsListing(): boolean {
    const root = workspaceRoot();
    if (!root || boardModels().length) return false;
    return this.listings.mayList(root);
  }

  /**
   * Waits until the model pill offers `model` (remembered by the box, or saved with a prompt for later, from the CLI's
   * rows) or the CLI answered for main: while it is asked (after a reload, or when its settings changed), the pill has
   * Claude's aliases only.
   * Returns at once for Default, a model offered (or one of Claude's aliases), or with `devdesk.board.models` set.
   */
  async modelsListed(model: string | undefined): Promise<void> {
    const root = workspaceRoot();
    if (!model || !root || model === DEFAULT_CHOICE || boardModels().length || this.allowedRows().some((r) => r.value === model)) return;
    await this.commands(root);
    await this.listings.listed(root);
  }

  /** Offers `value` in the model pill from now on (typed with `/model`, not in the list). */
  addCustomModel(value: string): void {
    if (this.modelRows().some((r) => r.value === value)) return;
    // On the models saved now: one another window typed since is kept.
    void this.customModels.update((saved) => (saved.includes(value) ? saved : [...saved, value]));
    this.changed.fire();
  }

  /** Forgets the models typed with `/model` (the model pill's **Forget typed models**): a typo is not offered forever. */
  forgetCustomModels(): void {
    if (!this.customModels.get().length) return;
    void this.customModels.set([]);
    this.changed.fire();
  }

  /** What a compose message or saved prompt may choose. */
  allowed(): ComposeAllowed {
    return {
      modes: sessionsModes().map((m) => m.name),
      defaultMode: sessionsDefaultMode().name,
      ...allowedModels(this.allowedRows()),
      worktrees: this.worktrees().map((f) => f.dir),
    };
  }

  /** What `text` is for a session in `where`: a command of a category, an unknown one, or a prompt. */
  async classify(text: string, where: string): Promise<Submission> {
    // Only a command needs the list (which may ask the CLI).
    if (!text.trimStart().startsWith('/')) return classifySubmission(text, BUILTINS, []);
    // The folders read afresh: a skill added since the CLI listed them is not called unknown.
    const submission = classifySubmission(text, BUILTINS, await this.commands(where, { rescan: true }));
    if (submission.kind !== 'unknown') return submission;
    // Until the CLI listed its commands, the folders miss its bundled skills and MCP prompts (`/init`, `/review`): wait
    // for its answer before calling a command unknown. Still not listed (it did not answer, or the workspace is not
    // trusted, where it is not asked): unknown all the same, as sent it would cost a model turn ("Send as text anyway").
    const dir = this.dirOf(where);
    if (dir !== undefined && (await this.listings.waitForFirstListing(dir))) return classifySubmission(text, BUILTINS, await this.commands(where));
    return submission;
  }

  /**
   * Runs what the box submitted: classified (or as `options.as` says, such as `F` for "Send as text anyway"), then
   * handled by its command's or category's handler (`board/dispatch.ts`).
   */
  async submit(text: string, choice: LaunchChoice, ui: BoardUi, options: { as?: SubmissionKind } = {}): Promise<SubmitOutcome> {
    const trimmed = text.trim();
    const classified = await this.classify(trimmed, choice.where);
    const submission = options.as ? { ...classified, kind: options.as } : classified;
    return dispatch({ text: trimmed, submission, choice, composer: this, ui });
  }

  /**
   * Starts a prompt for later with its saved choice (checked against today's), in plan mode, or behind the spec prefix
   * (both for prompts only: a saved command runs as if submitted; an unknown one warns, and its "Send as text anyway"
   * keeps Plan or Spec). True when it is done and leaves the lane.
   */
  async startSaved(item: BacklogItem, how: StartHow, ui: BoardUi): Promise<boolean> {
    const saved = item.choice?.model;
    // Saved from the CLI's rows: they may not be listed yet (a reload, or the CLI's settings changed).
    await this.modelsListed(saved);
    // Saved when the pill offered Claude's aliases (before it listed the CLI's models): `allowed` still takes it.
    const allowed = this.allowed();
    const missing = missingWorktree(item.choice ?? {}, allowed);
    // Never run a prompt meant for a worktree in main instead.
    if (missing) throw new Error(`The worktree ${missing} is not there any more: Edit the prompt to pick where it starts.`);
    // Nor on another model than the one saved.
    if (saved && !allowed.models.includes(saved)) throw new Error(`The model ${saved} is not offered any more: Edit the prompt to pick its model.`);
    const choice = parseChoice(item.choice ?? {}, allowed);
    const submission = await this.classify(item.prompt, choice.where);
    if (how !== 'start' && submission.kind === 'unknown') {
      // As the unknown-command handler does, but sent as text it still starts as Plan or Spec said.
      const asText = { ...submission, kind: 'F' as const };
      ui.notice({
        text: unknownCommandNotice(submission),
        tone: 'warning',
        actions: [{ label: 'Send as text anyway', run: async () => startedOutcome(await this.startPrompt(item.prompt, asText, choice, how, ui)) }],
      });
      return false;
    }
    if (how === 'start' || !isPromptKind(submission.kind)) {
      const outcome = await dispatch({ text: item.prompt.trim(), submission, choice, composer: this, ui, fromCard: true });
      if (outcome.error) throw new Error(outcome.error);
      return outcome.clear;
    }
    return this.startPrompt(item.prompt, submission, choice, how, ui);
  }

  /** Starts a saved prompt in plan mode (Plan) or behind the spec prefix (Spec). */
  private async startPrompt(prompt: string, submission: Submission, choice: LaunchChoice, how: 'plan' | 'spec', ui: BoardUi): Promise<boolean> {
    const mode = how === 'plan' ? this.planMode() : undefined;
    const spec = how === 'spec' ? specPrefix(boardSpecPrompt(), (await this.commands(choice.where)).map((c) => c.name)) : undefined;
    return this.start(spelledText(prompt, submission), choice, { mode, ...promptDecoration(submission.kind, { ultracode: choice.ultracode, prefix: spec }), ui });
  }

  /**
   * Completions for `/` (skills and commands; `stacked`: after other commands, skills only) or `@` (files) as typed so
   * far, for where the session will run.
   */
  async complete(kind: '/' | '@', query: string, where: string, options: { stacked?: boolean } = {}): Promise<Completion[]> {
    if (kind === '/') {
      return filterCommands(menuCommands(await this.commands(where), options.stacked), query, MAX_COMPLETIONS).map(commandRow);
    }
    const base = this.dirOf(where);
    return base ? this.files.complete(base, query, MAX_COMPLETIONS) : [];
  }

  /** Asks for files to attach; their `@` mentions, relative to where the session runs when inside it. */
  attach(where: string): Promise<string> {
    return attachFiles(this.dirOf(where));
  }

  /**
   * Starts Claude on `prompt` where `choice` says, in its mode (or `options.mode`), with its model and effort (and
   * `options.extraArgs`); true when it started.
   */
  async start(prompt: string, choice: LaunchChoice, options: StartOptions = {}): Promise<boolean> {
    const root = workspaceRoot();
    if (!root) throw new Error(NO_FOLDER);
    // Checks before a launch go here, or in a handler before it calls start.
    const feature = this.worktrees().find((f) => f.dir === choice.where) ?? { name: 'main', dir: root, isMain: true };
    // Untrusted: the session must open. A new worktree's session is checked where it starts (its package for a Claude
    // Code worktree), which is known only once the worktree is made.
    // Claude asks to trust the folder first, and reports no turn until answered: its card shows as it is meanwhile.
    let asksTrust = false;
    const untrusted = async (dir: string) => (asksTrust = await this.warnIfUntrusted(dir, options.ui));
    const open = options.open ?? boardOpensSession();
    const launchMode = options.mode ?? pickMode(sessionsModes(), choice.mode);
    // The directories added with /add-dir go to this launch only.
    const dirs = this.launchDirs;
    const extraArgs = joinArgs(choiceArgs(choice), addDirArgs(dirs), options.extraArgs ?? '');
    const text = launchPrompt(prompt, { ultracode: options.ultracode === true, prefix: options.prefix });
    const launched = this.launched(choice.model, options.turn === false ? undefined : prompt, () => asksTrust);
    let started = true;
    if (choice.where === 'new') {
      const noWorktrees = noWorktreesReason(root);
      if (noWorktrees) throw new Error(noWorktrees);
      if (open) await this.beforeOpen();
      started = await newWorktreeSession(this.model, this.tree, this.tasks, prompt, { name: choice.worktreeName, prompt: text, mode: launchMode, extraArgs, open, started: launched, untrusted });
    } else {
      const opens = (await untrusted(feature.dir)) || open;
      if (opens) await this.beforeOpen();
      await startNumbered(this.model, this.tree, sessionName(feature), feature.dir, sessionsClaudeCommand(joinArgs(extraArgs, promptArg(text)), launchMode), opens, launched);
    }
    if (started && dirs.length) {
      this.launchDirs = this.launchDirs.filter((d) => !dirs.includes(d));
      this.changed.fire();
    }
    return started;
  }

  /**
   * Remembers (or, for Default, forgets) the model a session started with, by its name on DevDesk's tmux server, and
   * shows its card as working on `prompt` (a first turn) while Claude starts, when DevDesk's hooks will report the turn
   * and Claude does not ask to trust the folder first.
   */
  private launched(model: string, prompt: string | undefined, asksTrust: () => boolean): (session: string) => void {
    const server = sessionsTmuxServer();
    const label = this.modelRows().find((r) => r.value === model)?.label ?? model;
    const reported = prompt?.trim() ? hooksInstalled().catch(() => false) : Promise.resolve(false);
    return (session) => {
      if (!asksTrust()) void reported.then((yes) => yes && this.model.expectTurn(server, session, prompt!));
      const key = launchKey(server, session);
      if (model === DEFAULT_CHOICE) this.launches.delete(key);
      else this.launches.set(key, { model: label, at: Date.now() });
    };
  }

  /** The models the board started the `cards`' sessions with (by `launchKey`); forgets sessions that are gone. */
  launchedModels(cards: readonly SessionCard[]): Map<string, string> {
    const listed = new Set(cards.filter((c) => c.tmuxSession).map((c) => launchKey(c.tmuxServer, c.tmuxSession!)));
    this.launches = liveLaunches(this.launches, listed, Date.now());
    return new Map([...this.launches].map(([key, l]) => [key, l.model]));
  }

  /**
   * When Claude has not trusted `dir` yet, says so in the box (or a VS Code warning without one) and returns true: the
   * session asks first, so it must open for the user to answer (the board never answers for them).
   */
  private async warnIfUntrusted(dir: string, ui: BoardUi | undefined): Promise<boolean> {
    if (!(await claudeNeedsTrust(dir))) return false;
    const text = trustNotice(dir);
    if (ui) ui.notice({ text, tone: 'warning' });
    else void vscode.window.showWarningMessage(text);
    return true;
  }

  /**
   * `noWorktreesReason(root)`, kept until the root changes or worktrees are discovered again (it walks the file system,
   * and `info` runs on every board post).
   */
  private noWorktrees(root: string | undefined): string {
    const features = this.model.featureList;
    const known = this.plainFolder;
    if (known && known.root === root && known.features === features) return known.reason;
    this.plainFolder = { root, features, reason: noWorktreesReason(root) };
    return this.plainFolder.reason;
  }

  private worktrees() {
    return this.model.featureList.filter((f) => !f.isMain);
  }

  /**
   * The directory a session for `where` runs in: main (the workspace root) or an existing worktree; for a new one,
   * where New Worktree Session starts Claude (the package of a Claude Code worktree), as far as known before it runs.
   */
  dirOf(where: string): string | undefined {
    const root = workspaceRoot();
    if (where === 'new' && root) return newWorktreeLaunchDir(root, this.model.featureList.find((f) => f.isMain)?.packages ?? []);
    return this.worktrees().find((f) => f.dir === where)?.dir ?? root;
  }

  /** Asks the CLI again the next time a list is wanted (the Claude settings its lists came from changed): `CliListings.clear`. */
  clearCommands(): void {
    this.listings.clear();
  }

  /** What `/` offers for sessions in `where` (`CliListings.commands`), without waiting for Claude. */
  async commands(where: string, options: { rescan?: boolean } = {}): Promise<SlashCommand[]> {
    const dir = this.dirOf(where);
    return dir ? this.listings.commands(dir, options) : withBuiltins([]);
  }

  dispose(): void {
    this.changed.dispose();
  }
}
