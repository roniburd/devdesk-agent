import type { CliListing } from '../cliStream';
import type { SlashCommand } from '../slashCommands';

/** The CLI is asked again after this (a plugin or skill was installed meanwhile), as the Claude Board does. */
export const LISTING_TTL_MS = 5 * 60_000;
/** After the CLI did not answer, it is asked again this soon. */
export const RETRY_MS = 30_000;
/** The skill and command folders are read again after this. */
export const DISK_TTL_MS = 2_000;

export interface ComposerCacheDeps {
  /** Asks the Claude CLI in `dir` for its commands and models; undefined when it did not answer. */
  list(dir: string): Promise<CliListing | undefined>;
  /** The skills and commands on disk for `dir`. */
  disk(dir: string): Promise<SlashCommand[]>;
  now(): number;
}

interface Entry {
  listing: CliListing | undefined;
  /** When to ask the CLI again. */
  until: number;
  asking: boolean;
  onDisk: SlashCommand[] | undefined;
  diskAt: number;
}

/**
 * What the Claude CLI lists per folder for the web page's prompt box, asked in the background (one ask per folder at a
 * time) and kept for `LISTING_TTL_MS`; until it answers, the box has the skill and command folders' commands and
 * Claude's aliases. A listing stays in use while it is asked again.
 */
export class ComposerCache {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly d: ComposerCacheDeps) {}

  /** What there is for `dir` now; `pending` while the CLI is being asked and has not answered once yet. */
  async get(dir: string): Promise<{ listing: CliListing | undefined; onDisk: SlashCommand[]; pending: boolean }> {
    const e = this.entry(dir);
    this.refresh(dir, e);
    const now = this.d.now();
    if (!e.onDisk || now - e.diskAt > DISK_TTL_MS) {
      e.onDisk = await this.d.disk(dir).catch(() => e.onDisk ?? []);
      e.diskAt = now;
    }
    return { listing: e.listing, onDisk: e.onDisk, pending: e.asking && !e.listing };
  }

  /** The listing `dir` has now, without asking (for checking a new session's model). */
  listing(dir: string): CliListing | undefined {
    return this.entries.get(dir)?.listing;
  }

  private entry(dir: string): Entry {
    let e = this.entries.get(dir);
    if (!e) {
      e = { listing: undefined, until: 0, asking: false, onDisk: undefined, diskAt: 0 };
      this.entries.set(dir, e);
    }
    return e;
  }

  private refresh(dir: string, e: Entry): void {
    if (e.asking || this.d.now() < e.until) return;
    e.asking = true;
    void this.d
      .list(dir)
      .catch(() => undefined)
      .then((listing) => {
        e.asking = false;
        if (listing) e.listing = listing;
        e.until = this.d.now() + (listing ? LISTING_TTL_MS : RETRY_MS);
      });
  }
}
