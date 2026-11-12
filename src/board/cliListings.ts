import * as vscode from 'vscode';
import { listClaude } from '../claudeCommands';
import { claudeConfigDir, claudeDefaultAccount, claudeInvocation, workspaceRoot } from '../config';
import { accountEnv } from '../core/accounts';
import type { CliListing } from '../core/cliStream';
import { discoverSlashCommands, type SlashCommand, withBuiltins, withDiskCommands } from '../core/slashCommands';

/** The CLI is asked for its commands again after this (a plugin or skill was installed meanwhile). */
const COMMANDS_TTL_MS = 5 * 60_000;
/** After the CLI did not answer, it is asked again this soon. */
const RETRY_COMMANDS_MS = 30_000;
/** The skill and command folders are read again after this (a skill was added since): `/` offers it before the CLI is asked again. */
const FOLDER_TTL_MS = 2_000;

/** What the CLI listed for one folder, and when to ask it again. */
interface CacheEntry {
  until: number;
  listing: CliListing | undefined;
  /** What the skill and command folders hold (all `/` has until the CLI answers; then what its list lacks), read at `folderAt`. */
  folder: SlashCommand[] | undefined;
  folderAt: number;
  asking: boolean;
  /** Resolves once this ask has a list, or the CLI did not answer. */
  listed: Promise<void>;
}

/**
 * What the Claude CLI lists (its models and `/` commands) per CLI and folder, asked in the background and kept for a
 * while, with what the skill and command folders hold until it answers. `onChange` runs when a listing arrives, the
 * CLI did not answer, or `clear` was called.
 */
export class CliListings {
  private cache = new Map<string, CacheEntry>();
  private commandsVersion = 0;

  constructor(private readonly onChange: () => void) {}

  /** Goes up each time the `/` list changes (`ComposerInfo.commandsVersion`). */
  get version(): number {
    return this.commandsVersion;
  }

  /** The CLI's last listing for `dir`, if it answered. */
  listing(dir: string): CliListing | undefined {
    return this.cache.get(this.key(dir))?.listing;
  }

  /** Whether the CLI has not listed `dir` yet but may (it is asked, or will be in a trusted workspace). */
  mayList(dir: string): boolean {
    const entry = this.cache.get(this.key(dir));
    return !entry?.listing && (entry ? entry.asking : vscode.workspace.isTrusted);
  }

  /** Resolves once the current ask for `dir` has a list or failed (at once when none was made). */
  async listed(dir: string): Promise<void> {
    await this.cache.get(this.key(dir))?.listed;
  }

  /** Waits for the CLI's first answer for `dir` while it is being asked; true when it waited. */
  async waitForFirstListing(dir: string): Promise<boolean> {
    const entry = this.cache.get(this.key(dir));
    if (entry?.listing || !entry?.asking) return false;
    await entry.listed;
    return true;
  }

  /**
   * Asks the CLI again the next time a list is wanted (the Claude settings its lists came from changed). Each last
   * list stays until the new answer, so the model pill keeps its rows (and the chosen model) meanwhile; an answer to
   * an earlier ask is dropped.
   */
  clear(): void {
    const current = this.key('');
    for (const [key, entry] of this.cache) {
      // Lists of another CLI (its setting changed) are never asked for again.
      if (!key.startsWith(current)) this.cache.delete(key);
      // The skill folders are read again too (`/reload-skills`, or no CLI to list them).
      else this.cache.set(key, { ...entry, folder: undefined, until: 0, asking: false });
    }
    this.commandsVersion++;
    this.onChange();
  }

  /**
   * What `/` offers for sessions in `dir`, with the catalog's built-ins, without waiting for Claude: its last list
   * (and what the folders hold that it lacks), else what the folders hold; the folders are read again after
   * `FOLDER_TTL_MS` (`rescan`: now). A list past `COMMANDS_TTL_MS` (or none) is asked for again in the background;
   * only in a trusted workspace, as the CLI loads the project's settings.
   */
  async commands(dir: string, options: { rescan?: boolean } = {}): Promise<SlashCommand[]> {
    const key = this.key(dir);
    const cached = this.cache.get(key);
    if (!cached || (Date.now() > cached.until && !cached.asking)) this.ask(key, dir, cached);
    const entry = this.cache.get(key)!;
    if (options.rescan || !entry.folder || Date.now() - entry.folderAt > FOLDER_TTL_MS) {
      entry.folder = await folderCommands(dir);
      entry.folderAt = Date.now();
    }
    return withBuiltins(entry.listing ? withDiskCommands(entry.listing.commands, entry.folder) : entry.folder);
  }

  private key(dir: string): string {
    return `${claudeInvocation()}\n${dir}`;
  }

  private ask(key: string, dir: string, previous: CacheEntry | undefined): void {
    let answered!: () => void;
    const entry: CacheEntry = {
      until: Date.now() + COMMANDS_TTL_MS,
      listing: previous?.listing,
      folder: previous?.folder,
      folderAt: previous?.folderAt ?? 0,
      asking: true,
      listed: new Promise((resolve) => (answered = resolve)),
    };
    this.cache.set(key, entry);
    // Each answer (and each later `commands_changed`) shows at once: the models in the pill, the commands in `/`.
    const update = (listing: CliListing) => {
      if (this.cache.get(key) !== entry) return;
      entry.listing = listing;
      answered();
      this.commandsVersion++;
      this.onChange();
    };
    const listed = vscode.workspace.isTrusted ? listClaude(claudeInvocation(), dir, update, accountEnv(claudeDefaultAccount())) : Promise.resolve(undefined);
    void listed.then((listing) => {
      entry.asking = false;
      // A listing `update` already showed as it arrived is not shown again (an open `/` menu would ask twice).
      if (listing) {
        if (listing !== entry.listing) update(listing);
      } else {
        // The CLI did not answer (or may not run here): what the folders hold, and ask it again soon.
        entry.until = Date.now() + RETRY_COMMANDS_MS;
        // The pill stops keeping a remembered model for the CLI's answer.
        if (this.cache.get(key) === entry) this.onChange();
      }
      answered();
    });
  }
}

/** The skills and commands the folders hold; none when they cannot be read. */
async function folderCommands(dir: string): Promise<SlashCommand[]> {
  const dirs = [...new Set([dir, workspaceRoot()].filter((d): d is string => !!d))];
  // The default Claude account's skills and commands, as the CLI lists them for it.
  return discoverSlashCommands(claudeConfigDir(), dirs).catch(() => []);
}
