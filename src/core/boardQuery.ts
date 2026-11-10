// The Claude Board's as-you-type search matcher: here for the extension (`boardSearch.ts` re-exports it) and for the
// board's webview (media/board.js imports it, bundled), so both match alike. Nothing here may need Node.

/** Lowercase, accents removed (whitespace kept): `foldText` without the collapsing, also used a character at a time. */
export const foldChars = (s: string): string => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** Lowercase, accents removed, whitespace collapsed: what queries and card texts are compared as. */
export function foldText(s: string): string {
  return foldChars(s).replace(/\s+/g, ' ').trim();
}

/** A card's texts as the matcher reads them: everything, the worktree name, and its lane, look and state. */
export interface SearchFields {
  all: string;
  wt: string;
  is: string;
}

/** One word of a query: `wt:name` looks at the worktree only, `is:state` at the state only, any other word at everything. */
export interface QueryTerm {
  field: keyof SearchFields;
  text: string;
}

export function parseQuery(query: string): QueryTerm[] {
  return foldText(query)
    .split(' ')
    .filter(Boolean)
    .flatMap((word): QueryTerm[] => {
      const m = /^(wt|is):(.*)$/.exec(word);
      if (!m) return [{ field: 'all', text: word }];
      return m[2] ? [{ field: m[1] as 'wt' | 'is', text: m[2] }] : [];
    });
}

/** Every term is a substring of its field; true with no terms. */
export function matchesQuery(fields: SearchFields | undefined, terms: readonly QueryTerm[]): boolean {
  // A field missing (data the webview got) matches nothing.
  return terms.every((t) => (fields?.[t.field] ?? '').includes(t.text));
}

export function searchFields(o: {
  title: string;
  worktree: string;
  laneTitle: string;
  lookLabel: string;
  state: string;
  model?: string;
  texts: readonly (string | undefined)[];
}): SearchFields {
  const is = foldText(`${o.laneTitle} ${o.lookLabel} ${o.state}`);
  const wt = foldText(o.worktree);
  const all = foldText([o.title, ...o.texts.filter(Boolean), o.worktree, is, o.model ?? ''].join(' '));
  return { all, wt, is };
}
