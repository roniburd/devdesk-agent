/**
 * Applies `changes` (a value to set, or undefined to remove) to `saved`, keeping every other entry as saved, and keeps
 * at most `limit` entries: the changed ones first, then the saved ones in their order. Used to save only what this
 * window changed into state other windows change too, instead of writing back a whole copy read earlier.
 */
export function applyEntries<V>(
  saved: readonly (readonly [string, V])[],
  changes: ReadonlyMap<string, V | undefined>,
  limit = Number.POSITIVE_INFINITY,
): [string, V][] {
  const out: [string, V][] = [];
  for (const [id, value] of changes) if (value !== undefined && out.length < limit) out.push([id, value]);
  for (const [id, value] of saved) {
    if (out.length >= limit) break;
    if (!changes.has(id)) out.push([id, value]);
  }
  return out;
}

/** The entries of `next` that differ from `before` (undefined for those removed): what to pass to `applyEntries`. */
export function changedEntries<V>(before: ReadonlyMap<string, V>, next: ReadonlyMap<string, V>): Map<string, V | undefined> {
  const changes = new Map<string, V | undefined>();
  for (const [id, value] of next) if (before.get(id) !== value) changes.set(id, value);
  for (const id of before.keys()) if (!next.has(id)) changes.set(id, undefined);
  return changes;
}
