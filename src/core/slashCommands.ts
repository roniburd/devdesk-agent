import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { BUILTINS, type Builtin, type Category } from './builtins';
import { readJson } from './json';

/** A skill or command Claude Code offers as `/name`, for the board composer's `/` menu. */
export interface SlashCommand {
  /** Without the slash: `review`, `superpowers:brainstorming`, `frontend:deploy`. */
  name: string;
  description: string;
  argumentHint?: string;
  /** `project`, `user`, `built-in`, or the plugin's name. */
  origin: string;
  /** Other names it answers to (`cost` and `stats` for `usage`; a plugin skill's short name). */
  aliases?: readonly string[];
  /** How the board handles it, for built-ins the catalog knows (see `core/builtins.ts`); absent means F. */
  category?: Category;
  /** Offered in the `/` menu only when its full name or an alias is typed. */
  hidden?: boolean;
}

/** `description:` and `argument-hint:` (and `name:`) from a Markdown file's front matter, else its first text line as description. */
export function parseFrontMatter(text: string): { name?: string; description: string; argumentHint?: string } {
  const lines = text.split(/\r?\n/);
  const fields: Record<string, string> = {};
  let body = 0;
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
    if (end > 0) {
      const head = lines.slice(1, end);
      head.forEach((line, i) => {
        const m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
        if (!m) return;
        let value = m[2].trim();
        // A YAML block scalar (`|`, `>-`, …): the indented lines after it, joined into one line.
        if (/^[|>][+-]?$/.test(value)) {
          const block: string[] = [];
          for (const next of head.slice(i + 1)) {
            if (next.trim() && !/^\s/.test(next)) break;
            block.push(next.trim());
          }
          value = block.filter(Boolean).join(' ');
        }
        fields[m[1].toLowerCase()] = value.replace(/^(['"])(.*)\1$/, '$2');
      });
      body = end + 1;
    }
  }
  const first = lines.slice(body).find((l) => l.trim() && !l.trim().startsWith('#'))?.trim() ?? '';
  return {
    ...(fields.name ? { name: fields.name } : {}),
    description: fields.description || first,
    ...(fields['argument-hint'] ? { argumentHint: fields['argument-hint'] } : {}),
  };
}

async function list(dir: string): Promise<{ name: string; isDir: boolean }[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  // A symlink (dotfiles managers make them) is what it points to; a dangling one is neither.
  const isDir = async (e: (typeof entries)[number]) => (e.isSymbolicLink() ? (await stat(join(dir, e.name)).catch(() => undefined))?.isDirectory() ?? false : e.isDirectory());
  return Promise.all(entries.map(async (e) => ({ name: e.name, isDir: await isDir(e) })));
}

/** The command a Markdown file describes, named `name` (a skill: its front matter's name when it has one); undefined when unreadable. */
async function command(file: string, name: string, origin: string, prefix: string, skill = false): Promise<SlashCommand | undefined> {
  const text = await readFile(file, 'utf8').catch(() => undefined);
  if (text === undefined) return undefined;
  const fm = parseFrontMatter(text);
  return { name: `${prefix}${(skill && fm.name) || name}`, description: fm.description, ...(fm.argumentHint ? { argumentHint: fm.argumentHint } : {}), origin };
}

const found = (list: (SlashCommand | undefined)[]) => list.filter((c): c is SlashCommand => !!c);

/** `<dir>/<name>/SKILL.md` skills; a name in the front matter wins over the directory's. */
async function skills(dir: string, prefix: string, origin: string): Promise<SlashCommand[]> {
  const entries = (await list(dir)).filter((e) => e.isDir);
  return found(await Promise.all(entries.map((e) => command(join(dir, e.name, 'SKILL.md'), e.name, origin, prefix, true))));
}

/** `<dir>/**\/*.md` commands; sub-directories join the name with `:` (`frontend/deploy.md` is `frontend:deploy`). */
async function commands(dir: string, prefix: string, origin: string, depth = 0): Promise<SlashCommand[]> {
  const entries = await list(dir);
  const [files, nested] = await Promise.all([
    Promise.all(entries.filter((e) => !e.isDir && e.name.endsWith('.md')).map((e) => command(join(dir, e.name), e.name.slice(0, -3), origin, prefix))),
    Promise.all(entries.filter((e) => e.isDir && depth < 3).map((e) => commands(join(dir, e.name), `${prefix}${e.name}:`, origin, depth + 1))),
  ]);
  return [...found(files), ...nested.flat()];
}

/** Install paths of the plugins `<claudeDir>/settings.json` enables, by plugin name (`superpowers@official` → `superpowers`). */
export async function enabledPlugins(claudeDir: string): Promise<Map<string, string>> {
  const installed = (await readJson(join(claudeDir, 'plugins', 'installed_plugins.json')))?.plugins;
  const enabled = (await readJson(join(claudeDir, 'settings.json')))?.enabledPlugins;
  const result = new Map<string, string>();
  if (!installed || typeof installed !== 'object' || !enabled || typeof enabled !== 'object') return result;
  for (const [key, entries] of Object.entries(installed as Record<string, unknown>)) {
    if ((enabled as Record<string, unknown>)[key] !== true || !Array.isArray(entries)) continue;
    const path = (entries[0] as { installPath?: unknown } | undefined)?.installPath;
    if (typeof path === 'string' && path) result.set(key.split('@')[0], path);
  }
  return result;
}

/**
 * The skills and commands Claude Code offers in `projectDirs` (their `.claude/`, which win over the user's), the user's
 * `<claudeDir>`, and enabled plugins (`plugin:name`), sorted by name. Unreadable files and directories are skipped.
 */
export async function discoverSlashCommands(claudeDir: string, projectDirs: readonly string[]): Promise<SlashCommand[]> {
  const plugins = await enabledPlugins(claudeDir);
  const groups = await Promise.all([
    ...projectDirs.flatMap((d) => [skills(join(d, '.claude', 'skills'), '', 'project'), commands(join(d, '.claude', 'commands'), '', 'project')]),
    skills(join(claudeDir, 'skills'), '', 'user'),
    commands(join(claudeDir, 'commands'), '', 'user'),
    ...[...plugins].flatMap(([name, path]) => [skills(join(path, 'skills'), `${name}:`, name), commands(join(path, 'commands'), `${name}:`, name)]),
  ]);
  const byName = new Map<string, SlashCommand>();
  for (const c of groups.flat()) if (!byName.has(c.name)) byName.set(c.name, c);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** One `/` menu row: the command, and the alias the query matched when it was not the name. */
export interface CommandMatch {
  command: SlashCommand;
  alias?: string;
}

/** Lower case without `:`, `_` and `-`. */
const squash = (s: string) => s.toLowerCase().replace(/[:_-]/g, '');

/**
 * How well `name` matches the squashed query `q` (`:_-` ignored): 0 exact, 1 a prefix of the name, 2 a prefix from a later
 * word on; else undefined, as the middle of a word does not match (`st` does not find `fast`). A name that starts with
 * the query beats one with a later word that does, so `mode` lists `model` before `auto-mode-setup`.
 */
function rank(name: string, q: string, exact: string): number | undefined {
  const lower = name.toLowerCase();
  if (lower === exact) return 0;
  const words = lower.split(/[:_-]/);
  // A prefix ignoring separators, of the whole name (`reloadsk`) or from a later word on (`skills`), finds `reload-skills`.
  if (words.join('').startsWith(q)) return 1;
  return words.some((_, i) => words.slice(i).join('').startsWith(q)) ? 2 : undefined;
}

/**
 * Commands matching `query` (typed after `/`) by name or alias, never in the middle of a word (`:`, `_` and `-`
 * ignored), at most `limit`, ordered by:
 * - exact match, then a prefix of the name, then a prefix from a later word on (a plugin skill's bare name, which the
 *   CLI lists as its alias, counts as a later word);
 * - built-ins first, so fifty plugin skills named `Acme…` do not push `/autocompact` past `limit` for `a`;
 * - runnable before blocked (E), so `mo` + Enter runs `/model`, not the explanation of `/mobile`;
 * - names before aliases, then by the label shown, so `u` lists `/usage` before `/update` (an alias of the blocked `/restart`).
 * A hidden command shows only on an exact match. With no query: every command (no `limit`, so all can be scrolled to),
 * built-ins first, as a plugin can bring a hundred skills that would push `/model` and `/clear` out of reach.
 */
export function filterCommands(all: readonly SlashCommand[], query: string, limit = 50): CommandMatch[] {
  const q = squash(query);
  const exact = query.toLowerCase();
  // A query of only separators (`_`, `--`) names nothing: it is not the empty query that lists every command.
  if (!q && query) return [];
  if (!q) {
    const shown = all.filter((c) => !c.hidden);
    const builtIn = (c: SlashCommand) => c.origin === 'built-in';
    return [...shown.filter(builtIn), ...shown.filter((c) => !builtIn(c))].map((command) => ({ command }));
  }
  const ranked: { match: CommandMatch; rank: number; blocked: number; skill: number; label: string }[] = [];
  all.forEach((command) => {
    let best: { rank: number; alias?: string } | undefined;
    const byName = rank(command.name, q, exact);
    if (byName !== undefined) best = { rank: byName };
    for (const alias of command.aliases ?? []) {
      let r = rank(alias, q, exact);
      // A plugin skill's bare name (`brainstorming` for `superpowers:brainstorming`) is a later word of its name: it does
      // not rank with the names that start with the query.
      if (r === 1 && command.name.toLowerCase().endsWith(`:${alias.toLowerCase()}`)) r = 2;
      // The name wins a tie: an alias shows only when it matched better.
      if (r !== undefined && (!best || r < best.rank)) best = { rank: r, alias };
    }
    if (!best || (command.hidden && best.rank !== 0)) return;
    ranked.push({ match: { command, ...(best.alias ? { alias: best.alias } : {}) }, rank: best.rank, blocked: command.category === 'E' ? 1 : 0, skill: command.origin === 'built-in' ? 0 : 1, label: (best.alias ?? command.name).toLowerCase() });
  });
  return ranked
    .sort((a, b) => a.rank - b.rank || a.skill - b.skill || a.blocked - b.blocked || Number(!!a.match.alias) - Number(!!b.match.alias) || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
    .slice(0, limit)
    .map((r) => r.match);
}

/**
 * Commands from a CLI `commands` list (the `initialize` answer or a `commands_changed` event), sorted by name; undefined
 * when it is not a list. A plugin's commands are `plugin:name`; a description's trailing `(user)` or `(project)` becomes
 * the origin, else it is built in. Internal ones (`__name`) are left out.
 */
export function parseCliCommands(listed: unknown): SlashCommand[] | undefined {
  if (!Array.isArray(listed)) return undefined;
  const byName = new Map<string, SlashCommand>();
  for (const c of listed as { name?: unknown; description?: unknown; argumentHint?: unknown; aliases?: unknown }[]) {
    if (typeof c?.name !== 'string' || !c.name || c.name.startsWith('_')) continue;
    const text = typeof c.description === 'string' ? c.description : '';
    const scope = /\s*\((user|project)\)$/.exec(text);
    const colon = c.name.indexOf(':');
    const plugin = colon > 0 ? c.name.slice(0, colon) : undefined;
    let description = scope ? text.slice(0, scope.index) : text;
    // A plugin's descriptions start with `(plugin)`, which its name already says.
    if (plugin) description = description.replace(/^\([^)]*\)\s*/, '');
    const origin = plugin ?? scope?.[1] ?? 'built-in';
    const hint = typeof c.argumentHint === 'string' && c.argumentHint.trim() ? { argumentHint: c.argumentHint.trim() } : {};
    const aliases = Array.isArray(c.aliases) ? c.aliases.filter((a): a is string => typeof a === 'string' && !!a && a !== c.name) : [];
    byName.set(c.name, { name: c.name, description, origin, ...hint, ...(aliases.length ? { aliases } : {}) });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The CLI's `listed` commands, then what the skill and command folders hold (`onDisk`) that it lacks by name or alias:
 * a skill added since the CLI listed the folder, until it is asked again. Sorted by name.
 */
export function withDiskCommands(listed: readonly SlashCommand[], onDisk: readonly SlashCommand[]): SlashCommand[] {
  const taken = new Set(listed.flatMap((c) => [c.name, ...(c.aliases ?? [])]));
  const added = onDisk.filter((c) => !taken.has(c.name));
  return added.length ? [...listed, ...added].sort((a, b) => a.name.localeCompare(b.name)) : [...listed];
}

/**
 * `commands` with the catalog's built-ins: each one the list has gets its category (and the catalog's aliases and
 * hidden flag added to the CLI's); the ones it lacks (the CLI lists only what works headless) are added, except a blocked
 * (E) one whose name a user's or project's command has. Sorted by name.
 */
export function withBuiltins(commands: readonly SlashCommand[], catalog: readonly Builtin[] = BUILTINS): SlashCommand[] {
  const byName = new Map(commands.map((c) => [c.name, c]));
  const theirs = (name: string) => {
    const c = byName.get(name);
    return !!c && c.origin !== 'built-in';
  };
  for (const b of catalog) {
    // A blocked built-in (removed, turned off, not on Bedrock) gives way to a user's or project's command of its name
    // or alias: that is what Claude runs.
    if (b.category === 'E' && theirs(b.name)) continue;
    const listed = byName.get(b.name);
    const aliases = [...new Set([...(listed?.aliases ?? []), ...b.aliases.filter((a) => b.category !== 'E' || !theirs(a))])];
    // What the board does itself (A, B) takes the catalog's hint and description: the CLI's say what Claude would do
    // (`/clear [name]`: "Clear conversation history"), not what the board does (empty the box).
    const own = b.category === 'A' || b.category === 'B';
    const argumentHint = own ? b.argumentHint : (listed?.argumentHint ?? b.argumentHint);
    byName.set(b.name, {
      name: b.name,
      description: own ? b.description : listed?.description || b.description,
      origin: 'built-in',
      ...(argumentHint ? { argumentHint } : {}),
      ...(aliases.length ? { aliases } : {}),
      category: b.category,
      ...(b.hidden ? { hidden: true } : {}),
    });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
