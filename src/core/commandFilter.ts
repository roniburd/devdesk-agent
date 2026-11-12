import type { SlashCommand } from './slashCommands';

// The `/` menu's matching, without Node imports: the board's extension side and the web access page (bundled for the
// browser) both use it.

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
