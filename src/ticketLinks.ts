import { homedir } from 'node:os';
import { basename } from 'node:path';
import * as vscode from 'vscode';
import { runBounded } from './core/boundedRun';
import { featureForCwd, type SessionCard } from './core/sessions';
import {
  detectFromPrompt,
  detectFromWorktree,
  enabledProviders,
  githubContext,
  githubTickets,
  isLink,
  jiraTickets,
  linearTickets,
  parseLinks,
  patternTickets,
  serializeLinks,
  sessionTarget,
  TICKET_LINKS_KEY,
  type TicketContext,
  type TicketEntry,
  TicketFetchCache,
  ticketChip,
  ticketHover,
  type TicketInfo,
  type TicketLink,
  type TicketProvider,
  type TicketRun,
  type TicketRef,
  type TicketRegistry,
  ticketRegistry,
  validPatterns,
  withTicketLine,
  worktreeTarget,
} from './core/tickets';
import { workspaceProvider } from './core/workspaceProvider';
import type { Feature } from './core/worktrees';
import { openSettings, ticketsConfig } from './config';
import { log, registerTimedCommand } from './log';
import type { SessionsModel } from './sessionsModel';
import type { ModifiableMemento } from './state/mementoState';

/** What a ticket chip shows: on a worktree row or a board card. */
export interface TicketChip {
  /** `ABC-123 · In progress`. */
  text: string;
  /** The key, title, status and URL, one per line. */
  hover: string;
  url: string;
}

/** What `devdesk ticket` asks (the fields of its `CliRequest`): where it ran, its tmux pane, the key or URL. */
export interface TicketCliRequest {
  cwd: string;
  server?: string;
  pane?: string;
  text?: string;
}

/** What `devdesk ticket` answers (as `CliBridge` prints it). */
export interface TicketCliAnswer {
  ok: boolean;
  message: string;
}

/** Built-in providers, in order: the workspace kind's own trackers, GitHub issues, Jira, Linear (`tickets.ts`). */
function builtInProviders(c: ReturnType<typeof ticketsConfig>): TicketProvider[] {
  return [...(workspaceProvider?.tickets ?? []), githubTickets, jiraTickets(c.jira), linearTickets(c.linear)];
}

/** How long a directory's remotes are kept (Link Ticket… and `devdesk ticket` read them afresh). */
const CONTEXT_MS = 5 * 60_000;

/** A link to any web page that no provider recognised: its last path part is its key. */
function plainUrlRef(input: string): TicketRef | undefined {
  try {
    const u = new URL(input.trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined;
    const last = u.pathname.split('/').filter(Boolean).pop();
    return { system: 'url', key: last ? decodeURIComponent(last).slice(0, 40) : u.hostname, url: u.toString() };
  } catch {
    return undefined;
  }
}

/**
 * The tickets linked to worktrees and sessions: kept in the host's shared state (`TICKET_LINKS_KEY`, both DevDesk Claude
 * versions see them), found in worktree names, branches and first prompts (`devdesk.tickets.autoDetect`), linked by
 * hand (Link Ticket…) or by Claude (`devdesk ticket`), and read (title, status) by the providers that can, at most every
 * `devdesk.tickets.refreshMinutes` each.
 */
export class TicketLinks implements vscode.Disposable {
  private registryCache: { registry: TicketRegistry; config: string } | undefined;
  /** Each directory's GitHub repository (from `git remote -v`), for `#123`. */
  private readonly contexts = new Map<string, { context: Promise<TicketContext>; at: number }>();
  /** Worktrees and sessions already looked at for a ticket in this window. */
  private readonly detected = new Set<string>();
  private readonly cache: TicketFetchCache;
  private readonly changed = new vscode.EventEmitter<void>();
  /** A link, or what was read about one, changed. */
  readonly onDidChange = this.changed.event;
  private readonly subscriptions: vscode.Disposable[] = [];
  private saidPatterns = '';

  constructor(
    private readonly state: ModifiableMemento,
    private readonly sessions: SessionsModel,
    private readonly run: TicketRun = runBounded,
  ) {
    this.cache = new TicketFetchCache((ref) => this.fetchNow(ref), () => ticketsConfig().refreshMs);
    this.subscriptions.push(
      this.changed,
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration('devdesk.tickets') && !e.affectsConfiguration('devdesk.checks.ghPath')) return;
        this.registryCache = undefined;
        this.cache.clear();
        this.detected.clear();
        this.changed.fire();
      }),
      sessions.onDidChange((cards) => this.onCards(cards)),
      registerTimedCommand('devdesk.tickets.link', (arg?: unknown, input?: unknown, title?: unknown) =>
        this.linkCommand(arg, typeof input === 'string' ? input : undefined, typeof title === 'string' ? title : undefined),
      ),
      registerTimedCommand('devdesk.tickets.open', (arg?: unknown) => this.openCommand(arg)),
      registerTimedCommand('devdesk.tickets.unlink', (arg?: unknown) => this.unlinkCommand(arg)),
      registerTimedCommand('devdesk.tickets.refresh', () => this.refreshAll()),
      registerTimedCommand('devdesk.tickets.openSettings', () => openSettings('devdesk.tickets')),
    );
  }

  /** The providers on now, rebuilt when the settings change. */
  registry(): TicketRegistry {
    const c = ticketsConfig();
    const key = JSON.stringify(c);
    if (this.registryCache?.config === key) return this.registryCache.registry;
    const { patterns, problems } = validPatterns(c.patterns);
    if (problems.length && problems.join() !== this.saidPatterns) log.warn(`devdesk.tickets.patterns: ${problems.join('; ')}`);
    this.saidPatterns = problems.join();
    const registry = ticketRegistry(enabledProviders(builtInProviders(c), patterns.map(patternTickets), c.providers));
    this.registryCache = { registry, config: key };
    return registry;
  }

  /** The saved entries, parsed once per saved value (the shared Memento returns the same object until it changes). */
  private entries(): Map<string, TicketEntry> {
    const raw = this.state.get<unknown>(TICKET_LINKS_KEY);
    if (!this.parsed || this.parsed.raw !== raw) this.parsed = { raw, entries: parseLinks(raw) };
    return this.parsed.entries;
  }
  private parsed: { raw: unknown; entries: Map<string, TicketEntry> } | undefined;

  /** The link of a target (`worktreeTarget`, `sessionTarget`), if any. */
  link(target: string): TicketLink | undefined {
    const e = this.entries().get(target);
    return isLink(e) ? e : undefined;
  }

  /** A worktree's link. */
  forWorktree(dir: string): TicketLink | undefined {
    return ticketsConfig().enabled ? this.link(worktreeTarget(dir)) : undefined;
  }

  /** A session's link: its own, else its worktree's. */
  forCard(card: Pick<SessionCard, 'id' | 'sessionId' | 'featureDir'>): TicketLink | undefined {
    if (!ticketsConfig().enabled) return undefined;
    return this.link(sessionTarget(card.sessionId ?? card.id)) ?? (card.featureDir ? this.link(worktreeTarget(card.featureDir)) : undefined);
  }

  /** What a link's chip shows. */
  chip(link: TicketLink | undefined): TicketChip | undefined {
    if (!link) return undefined;
    return { text: ticketChip(link), hover: ticketHover(link, this.registry().provider(link.system)?.label), url: link.url };
  }

  /** `prompt` with its worktree's ticket after it, when `devdesk.tickets.includeInPrompt` is on. */
  promptFor(dir: string, prompt: string): string {
    return ticketsConfig().includeInPrompt ? withTicketLine(prompt, this.forWorktree(dir)) : prompt;
  }

  /** Every link, by target (the tests). */
  all(): Record<string, TicketLink> {
    return Object.fromEntries([...this.entries()].filter((e): e is [string, TicketLink] => isLink(e[1])));
  }

  /** Sets (or, with undefined, marks unlinked) the target's entry; `onlyIfNone`: unless it has one already. */
  private async save(target: string, entry: TicketEntry | undefined, onlyIfNone = false): Promise<boolean> {
    let saved = false;
    await this.state.modify(TICKET_LINKS_KEY, (raw) => {
      const links = parseLinks(raw);
      if (onlyIfNone && links.has(target)) return raw;
      saved = true;
      if (entry) links.set(target, entry);
      else links.delete(target);
      return serializeLinks(links);
    });
    if (saved) this.changed.fire();
    return saved;
  }

  /** Links `ref` to `target`, and reads its title and status in the background. */
  async linkTo(target: string, ref: TicketRef, source: TicketLink['source'], title?: string, onlyIfNone = false): Promise<TicketLink | undefined> {
    const link: TicketLink = { ...ref, source, at: Date.now(), ...(title?.trim() ? { title: title.trim() } : {}) };
    if (!(await this.save(target, link, onlyIfNone))) return undefined;
    log.info(`tickets: linked ${ref.key} (${ref.system}) to ${target} (${source})`);
    void this.refresh(link);
    return link;
  }

  /** Removes the target's link; auto-detection leaves it alone afterwards. */
  async unlink(target: string): Promise<void> {
    await this.save(target, { unlinked: true, at: Date.now() });
  }

  /** The GitHub repository of `dir`, for `#123` (cached per directory). */
  contextFor(dir: string | undefined, fresh = false): Promise<TicketContext> {
    if (!dir) return Promise.resolve({});
    const kept = this.contexts.get(dir);
    if (kept && !fresh && Date.now() - kept.at < CONTEXT_MS) return kept.context;
    const context = this.run('git', ['remote', '-v'], { cwd: dir, timeoutMs: 5000, maxBytes: 64 * 1024 }).then(
      (r) => (r.code === 0 ? githubContext(r.stdout) : {}),
      () => ({}),
    );
    this.contexts.set(dir, { context, at: Date.now() });
    return context;
  }

  /** The ticket a pasted key or URL names, with `dir`'s repository for `#123`; any other web page as a plain link. */
  async parse(input: string, dir?: string): Promise<TicketRef | undefined> {
    return this.registry().parse(input, await this.contextFor(dir, true)) ?? plainUrlRef(input);
  }

  // ---- Auto-detection -------------------------------------------------------------------------------------------

  /** The branch checked out in `dir` (its first package's, in a package workspace). */
  private async branchOf(feature: Feature): Promise<string | undefined> {
    const dir = feature.packages[0]?.dir ?? feature.dir;
    const r = await this.run('git', ['branch', '--show-current'], { cwd: dir, timeoutMs: 5000, maxBytes: 4096 });
    return r.code === 0 ? r.stdout.trim() || undefined : undefined;
  }

  /** Links the listed worktrees (not the workspace itself) to the ticket their name or branch names, once each. */
  async detectWorktrees(features: readonly Feature[]): Promise<void> {
    const c = ticketsConfig();
    if (!c.enabled || !c.autoDetect) return;
    const entries = this.entries();
    for (const f of features) {
      const target = worktreeTarget(f.dir);
      if (f.isMain || this.detected.has(target) || entries.has(target)) continue;
      this.detected.add(target);
      const ctx = await this.contextFor(f.packages[0]?.dir ?? f.dir);
      const ref = detectFromWorktree(this.registry(), { name: f.name, branch: await this.branchOf(f) }, ctx);
      if (ref) await this.linkTo(target, ref, 'auto', undefined, true);
    }
    void this.refreshDue();
  }

  /** Links each new session to the ticket its first prompt names (once per session), unless it has a link. */
  private onCards(cards: readonly SessionCard[]): void {
    const c = ticketsConfig();
    if (!c.enabled || !c.autoDetect) return;
    const entries = this.entries();
    for (const card of cards) {
      if (!card.sessionId || !card.prompt) continue;
      const target = sessionTarget(card.sessionId);
      if (this.detected.has(target)) continue;
      this.detected.add(target);
      if (entries.has(target)) continue;
      void this.contextFor(card.featureDir ?? card.cwd).then(async (ctx) => {
        const ref = detectFromPrompt(this.registry(), card.prompt, ctx);
        // The worktree's ticket already: nothing to add on the session.
        if (!ref || (card.featureDir && this.link(worktreeTarget(card.featureDir))?.url === ref.url)) return;
        await this.linkTo(target, ref, 'auto', undefined, true);
      });
    }
  }

  // ---- Fetching -------------------------------------------------------------------------------------------------

  private async fetchNow(ref: TicketRef): Promise<TicketInfo | undefined> {
    const provider = this.registry().provider(ref.system);
    if (!provider?.fetch) return undefined;
    const c = ticketsConfig();
    const dir = Object.entries(this.all()).find(([t, l]) => l.url === ref.url && t.startsWith('worktree:'))?.[0].slice('worktree:'.length);
    return provider.fetch(ref, { run: this.run, cwd: dir ?? homedir(), timeoutMs: c.timeoutMs, gh: c.gh });
  }

  /** Reads a link's title and status (cached), and saves them on every target linked to it. */
  async refresh(link: TicketRef, force = false): Promise<void> {
    const c = ticketsConfig();
    if (!c.enabled || !c.fetch || !this.registry().provider(link.system)?.fetch) return;
    const r = await this.cache.get(link, force);
    if ('error' in r) {
      log.warn(`tickets: cannot read ${link.key}: ${r.error}`);
      return;
    }
    if (!r.info) return;
    const info = r.info;
    let changed = false;
    await this.state.modify(TICKET_LINKS_KEY, (raw) => {
      const links = parseLinks(raw);
      for (const [target, e] of links) {
        if (!isLink(e) || e.url !== link.url) continue;
        const next: TicketLink = { ...e, title: info.title, status: info.status, fetchedAt: r.at };
        if (info.assignee) next.assignee = info.assignee;
        else delete next.assignee;
        if (JSON.stringify(next) === JSON.stringify({ ...e, fetchedAt: r.at })) continue;
        links.set(target, next);
        changed = true;
      }
      return changed ? serializeLinks(links) : raw;
    });
    if (changed) this.changed.fire();
  }

  /** Reads the links due (one at a time), in the background. */
  async refreshDue(): Promise<void> {
    const seen = new Set<string>();
    for (const l of Object.values(this.all())) {
      if (seen.has(l.url) || !this.cache.due(l)) continue;
      seen.add(l.url);
      await this.refresh(l);
    }
  }

  /** Refresh Tickets: reads every link again now. */
  async refreshAll(): Promise<void> {
    const seen = new Set<string>();
    for (const l of Object.values(this.all())) {
      if (seen.has(l.url)) continue;
      seen.add(l.url);
      await this.refresh(l, true);
    }
  }

  /** Fetches done so far (the tests check the cache holds). */
  get fetches(): number {
    return this.cache.fetches;
  }

  // ---- Commands -------------------------------------------------------------------------------------------------

  /**
   * What a command acts on: a board card (`{ sessionId }`), a Claude view session row, a Worktrees view row, a worktree
   * directory, or (with none) a worktree picked.
   */
  private async targetOf(arg: unknown): Promise<{ target: string; name: string; dir?: string } | undefined> {
    const o = arg as { sessionId?: unknown; kind?: unknown; feature?: Feature; card?: SessionCard } | undefined;
    if (o && typeof o === 'object') {
      if (typeof o.sessionId === 'string') {
        const card = this.sessions.find(o.sessionId);
        if (card) return { target: sessionTarget(card.sessionId ?? card.id), name: 'this session', dir: card.featureDir ?? card.cwd };
      }
      if (o.kind === 'session' && o.card) return { target: sessionTarget(o.card.sessionId ?? o.card.id), name: 'this session', dir: o.card.featureDir ?? o.card.cwd };
      if (o.kind === 'feature' && o.feature?.dir) return { target: worktreeTarget(o.feature.dir), name: o.feature.name, dir: o.feature.dir };
    }
    if (typeof arg === 'string') return { target: worktreeTarget(arg), name: basename(arg), dir: arg };
    const features = await this.sessions.loadFeatures();
    if (features.length === 1) return { target: worktreeTarget(features[0].dir), name: features[0].name, dir: features[0].dir };
    const pick = await vscode.window.showQuickPick(
      features.map((f) => ({ label: f.name, description: this.forWorktree(f.dir)?.key ?? f.dir, feature: f })),
      { title: 'Which worktree?' },
    );
    return pick && { target: worktreeTarget(pick.feature.dir), name: pick.feature.name, dir: pick.feature.dir };
  }

  /** The link a command's target shows: its own, else (a session) its worktree's. */
  private shownLink(target: string, dir: string | undefined): TicketLink | undefined {
    return this.link(target) ?? (target.startsWith('session:') && dir ? this.link(worktreeTarget(dir)) : undefined);
  }

  /**
   * **Link Ticket…**: asks for a key or URL (`input` given: none asked), and, for a ticket its provider can't read,
   * a title (optional). Returns the link.
   */
  async linkCommand(arg: unknown, input?: string, title?: string): Promise<TicketLink | undefined> {
    const where = await this.targetOf(arg);
    if (!where) return undefined;
    const ctx = await this.contextFor(where.dir, true);
    const registry = this.registry();
    const current = this.link(where.target);
    const text =
      input ??
      (await vscode.window.showInputBox({
        title: `Link a ticket to ${where.name}`,
        prompt: 'A ticket key (ABC-123, #123) or its URL',
        value: current?.url ?? '',
        ignoreFocusOut: true,
        validateInput: (v) => (!v.trim() || registry.parse(v, ctx) || plainUrlRef(v) ? undefined : 'Not a ticket key or URL this window knows: paste its URL, or add a pattern (devdesk.tickets.patterns).'),
      }));
    if (!text?.trim()) return undefined;
    const ref = registry.parse(text, ctx) ?? plainUrlRef(text);
    if (!ref) {
      void vscode.window.showWarningMessage(`${text.trim()} is not a ticket key or URL DevDesk recognises.`);
      return undefined;
    }
    const canFetch = ticketsConfig().fetch && !!registry.provider(ref.system)?.fetch;
    const name =
      title ??
      (input !== undefined || canFetch
        ? undefined
        : await vscode.window.showInputBox({ title: `${ref.key}: its title (optional)`, prompt: "DevDesk can't read this ticket's title; type it to show it on the chip", ignoreFocusOut: true }));
    return this.linkTo(where.target, ref, 'manual', name);
  }

  /** **Open Ticket**: the target's ticket in the browser. */
  async openCommand(arg: unknown): Promise<string | undefined> {
    const where = await this.targetOf(arg);
    const link = where && this.shownLink(where.target, where.dir);
    if (!link) {
      if (where) void vscode.window.showInformationMessage(`No ticket is linked to ${where.name}.`);
      return undefined;
    }
    await vscode.env.openExternal(vscode.Uri.parse(link.url));
    return link.url;
  }

  /** **Unlink Ticket**. */
  async unlinkCommand(arg: unknown): Promise<boolean> {
    const where = await this.targetOf(arg);
    if (!where || !this.link(where.target)) return false;
    await this.unlink(where.target);
    return true;
  }

  // ---- devdesk ticket -------------------------------------------------------------------------------------------

  /**
   * `devdesk ticket <key|url>` from a session: links it to the session, and to its worktree (not the workspace itself)
   * when that has none; `--clear` unlinks the session; no argument prints the session's ticket.
   */
  async handleCli(req: TicketCliRequest): Promise<TicketCliAnswer> {
    if (!ticketsConfig().enabled) return { ok: false, message: 'tickets are off in this VS Code window (devdesk.tickets.enabled)' };
    const card = req.pane ? this.sessions.current.find((c) => c.tmuxPane === req.pane && (!req.server || (c.tmuxServer ?? 'default') === req.server)) : undefined;
    const feature = featureForCwd(await this.sessions.loadFeatures(), req.cwd);
    const sessionKey = card ? sessionTarget(card.sessionId ?? card.id) : undefined;
    const text = (req.text ?? '').trim();
    if (!text) {
      const link = (sessionKey && this.link(sessionKey)) || (feature && this.link(worktreeTarget(feature.dir)));
      return { ok: true, message: link ? ticketHover(link, this.registry().provider(link.system)?.label) : 'No ticket is linked to this session or its worktree.' };
    }
    if (text === '--clear') {
      if (sessionKey && this.link(sessionKey)) await this.unlink(sessionKey);
      else if (feature && !feature.isMain && this.link(worktreeTarget(feature.dir))) await this.unlink(worktreeTarget(feature.dir));
      else return { ok: true, message: 'No ticket was linked to this session.' };
      return { ok: true, message: 'Unlinked the ticket.' };
    }
    const ref = await this.parse(text, feature?.dir ?? req.cwd);
    if (!ref) return { ok: false, message: `${text} is not a ticket key or URL DevDesk recognises (paste its URL)` };
    const targets = [
      ...(sessionKey ? [sessionKey] : []),
      ...(feature && !feature.isMain && !this.link(worktreeTarget(feature.dir)) ? [worktreeTarget(feature.dir)] : []),
    ];
    if (!targets.length) return { ok: false, message: 'devdesk ticket needs a DevDesk session (in tmux) or a worktree' };
    for (const t of targets) await this.linkTo(t, ref, 'cli');
    return { ok: true, message: `Linked ${ref.key} (${ref.url}) to ${targets.map((t) => (t.startsWith('session:') ? 'this session' : `worktree ${feature!.name}`)).join(' and ')}.` };
  }

  dispose(): void {
    for (const d of this.subscriptions) d.dispose();
  }
}

