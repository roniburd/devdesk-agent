import {
  buildDigest,
  buildRequest,
  parseSearchAnswer,
  recentPrompts,
  SEARCH_PROMPT,
  type SearchAnswer,
  searchCacheKey,
  type SessionDigest,
  type SearchSession,
} from './core/boardSearch';
import { unwrapCallOutput } from './core/insights';
import { headlessClaudeCommand } from './core/shellRun';
import { log } from './log';
import { runInShell } from './shellCall';
import { readTail } from './core/transcriptTail';

/** How much of a transcript's end a search reads for the latest prompts. */
const TAIL_BYTES = 64 * 1024;
/** How long an answer is reused for the same query and sessions. */
const CACHE_MS = 5 * 60_000;
const CACHE_MAX = 20;

export interface BoardSearchOptions {
  model: () => string;
  /** A user's command answering instead of `claude -p`; empty: none. */
  command: () => string;
  /** The Claude binary, in shell syntax. */
  claude: () => string;
  timeoutMs: () => number;
  /** Runs one call; tests replace it. */
  run?: (command: string, input: string, o: { timeoutMs: number; signal: AbortSignal }) => Promise<{ stdout: string; error?: string }>;
  /** A transcript's last lines; tests replace it. */
  readLines?: (path: string) => Promise<readonly string[] | undefined>;
  now?: () => number;
}

export type SearchOutcome = SearchAnswer | { error: string };

/**
 * The Claude Board's ✨ search: one headless call (`claude -p --bare`, or the user's command) over the sessions'
 * digests. One search at a time: a new one, or `cancel()`, kills the running call, whose answer is dropped.
 */
export class BoardSearch {
  private current: AbortController | undefined;
  private readonly cache = new Map<string, { at: number; answer: SearchAnswer }>();

  constructor(private readonly o: BoardSearchOptions) {}

  cancel(): void {
    this.current?.abort();
    this.current = undefined;
  }

  /**
   * The answer, an error, or undefined when a newer search or `cancel()` superseded this one. `extra` digests (past
   * sessions from the history) go after the board's: their ids are answers too, and they are part of the cache key.
   * `found`: where the query's words are in board sessions' transcripts, by session id (their digests' `found`).
   */
  async search(
    query: string,
    sessions: readonly SearchSession[],
    extra: readonly SessionDigest[] = [],
    found: ReadonlyMap<string, string> = new Map(),
  ): Promise<SearchOutcome | undefined> {
    this.cancel();
    const ac = new AbortController();
    this.current = ac;
    const now = (this.o.now ?? Date.now)();
    const readLines = this.o.readLines ?? (async (path: string) => (await readTail(path, TAIL_BYTES))?.lines);
    const boardDigests = await Promise.all(
      sessions.map(async (s) =>
        buildDigest(s, s.card?.transcriptPath ? recentPrompts((await readLines(s.card.transcriptPath)) ?? []) : [], s.session.id && found.get(s.session.id)),
      ),
    );
    if (ac.signal.aborted) return undefined;
    const digests = [...boardDigests, ...extra];
    const custom = this.o.command().trim();
    const model = this.o.model();
    const key = searchCacheKey(custom ? `command ${custom}` : `claude ${model}`, query, digests);
    const hit = this.cache.get(key);
    if (hit && now - hit.at <= CACHE_MS) {
      this.current = undefined;
      return hit.answer;
    }
    const request = JSON.stringify(buildRequest(query, now, digests, !!custom));
    const command = custom || headlessClaudeCommand(this.o.claude(), model, SEARCH_PROMPT);
    const start = Date.now();
    const { stdout, error } = await (this.o.run ?? runInShell)(command, request, { timeoutMs: this.o.timeoutMs(), signal: ac.signal });
    if (ac.signal.aborted) return undefined;
    this.current = undefined;
    const outcome = this.outcome(stdout, error, !!custom, new Set(digests.map((d) => d.id)));
    if ('error' in outcome) log.warn(`board search: ${outcome.error}`);
    else {
      log.info(`board search: ${outcome.matches.length} of ${digests.length} sessions in ${Date.now() - start}ms`);
      this.cache.set(key, { at: now, answer: outcome });
      if (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
    }
    return outcome;
  }

  private outcome(stdout: string, error: string | undefined, custom: boolean, ids: ReadonlySet<string>): SearchOutcome {
    if (error) return { error };
    const unwrapped = custom ? { reply: stdout, error: undefined } : unwrapCallOutput(stdout);
    if (unwrapped.error) return { error: unwrapped.error };
    return parseSearchAnswer(unwrapped.reply ?? '', ids) ?? { error: 'the answer is not the JSON asked for' };
  }
}
