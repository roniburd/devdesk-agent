/** What a Claude terminal's tab says: the session's board title, short enough to keep the tab row narrow. */

/**
 * The session as its tab says it before it has a title: the name without `cc-` for cc- sessions on DevDesk's tmux
 * server (`main-39`, as the Worktrees view says it). Other sessions get `<full name> (tmux)`, or `(your tmux)` /
 * `(tmux <server>)` on another server. cc- names never contain spaces or parentheses, so no two sessions share one.
 */
export function sessionLabel(tmuxSession: string, server: string, devdeskServer: string, defaultServer: string): string {
  if (server !== devdeskServer) return `${tmuxSession} (${server === defaultServer ? 'your tmux' : `tmux ${server}`})`;
  return tmuxSession.startsWith('cc-') ? tmuxSession.slice(3) : `${tmuxSession} (tmux)`;
}

/** `title` on one line, cut to `max` characters with an ellipsis (at a word's end when one is near); undefined when empty. */
export function clipTitle(title: string | undefined, max: number): string | undefined {
  const line = title?.replace(/\s+/g, ' ').trim();
  if (!line) return undefined;
  if (line.length <= max) return line;
  const cut = line.slice(0, Math.max(1, max - 1));
  const space = line[cut.length] === ' ' ? cut.length : cut.lastIndexOf(' ');
  return `${(space >= max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * A Claude terminal's name: the session's title cut to `max` characters, else (no title yet, or `max` 0) `label`. A
 * title another open Claude terminal already has (in `taken`) gets ` · <label>`, so each tab names one session.
 */
export function terminalName(title: string | undefined, label: string, max: number, taken: ReadonlySet<string>): string {
  const clipped = max > 0 ? clipTitle(title, max) : undefined;
  if (!clipped || clipped === label) return label;
  return taken.has(clipped) ? `${clipped} · ${label}` : clipped;
}
