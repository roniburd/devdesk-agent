import { join } from 'node:path';

/**
 * Every tmux hook (tmux 3.8's `show-hooks -g`, `-gw` and `-gp`). DevDesk's tmux server unsets them all after loading
 * the user's tmux config: a hook runs for DevDesk's own clients too (VS Code terminals, the board, the phone), and a
 * hook's failing `run-shell` covers the pane with its error. Names an older tmux doesn't know are skipped (`set -q`).
 */
export const TMUX_HOOKS = [
  'after-bind-key', 'after-capture-pane', 'after-copy-mode', 'after-display-message', 'after-display-panes',
  'after-kill-pane', 'after-list-buffers', 'after-list-clients', 'after-list-keys', 'after-list-panes',
  'after-list-sessions', 'after-list-windows', 'after-load-buffer', 'after-lock-server', 'after-new-session',
  'after-new-window', 'after-paste-buffer', 'after-pipe-pane', 'after-refresh-client', 'after-rename-session',
  'after-rename-window', 'after-resize-pane', 'after-resize-window', 'after-save-buffer', 'after-select-layout',
  'after-select-pane', 'after-select-window', 'after-send-keys', 'after-set-buffer', 'after-set-environment',
  'after-set-hook', 'after-set-option', 'after-show-environment', 'after-show-messages', 'after-show-options',
  'after-split-window', 'after-swap-window', 'after-unbind-key',
  'alert-activity', 'alert-bell', 'alert-silence',
  'client-active', 'client-attached', 'client-closed', 'client-created', 'client-dark-theme', 'client-detached',
  'client-focus-in', 'client-focus-out', 'client-light-theme', 'client-resized', 'client-session-changed',
  'command-error', 'marked-pane-changed',
  'pane-activity', 'pane-bell', 'pane-command-finished', 'pane-command-started', 'pane-created', 'pane-died',
  'pane-exited', 'pane-focus-in', 'pane-focus-out', 'pane-mode-changed', 'pane-mode-entered', 'pane-mode-exited',
  'pane-moved', 'pane-prompt-closed', 'pane-prompt-opened', 'pane-resized', 'pane-set-clipboard', 'pane-shell-prompt',
  'pane-title-changed',
  'session-added-to-group', 'session-closed', 'session-created', 'session-removed-from-group', 'session-renamed',
  'session-window-changed',
  'window-closed', 'window-created', 'window-layout-changed', 'window-linked', 'window-pane-changed', 'window-renamed',
  'window-resized', 'window-unlinked', 'window-unzoomed', 'window-zoomed',
] as const;

/**
 * The config files tmux itself loads, in its order (tmux 3.2+: `/etc/tmux.conf`, `~/.tmux.conf`,
 * `$XDG_CONFIG_HOME/tmux/tmux.conf`, `~/.config/tmux/tmux.conf`), without repeats.
 */
export function userTmuxConfigFiles(home: string, xdgConfigHome?: string): string[] {
  const files = ['/etc/tmux.conf', join(home, '.tmux.conf')];
  if (xdgConfigHome?.trim()) files.push(join(xdgConfigHome.trim(), 'tmux', 'tmux.conf'));
  files.push(join(home, '.config', 'tmux', 'tmux.conf'));
  return [...new Set(files)];
}

/** `path` in tmux config single quotes, which have no escapes: undefined for a path holding a `'` or a line break. */
const tmuxQuote = (path: string) => (/['\n\r]/.test(path) ? undefined : `'${path}'`);

/** The tmux commands that unset every hook (TMUX_HOOKS), each as its arguments. */
export const unsetHookCommands = (): string[][] => TMUX_HOOKS.map((hook) => ['set-option', '-gqu', hook]);

/**
 * DevDesk's tmux config: loads the user's own config files (`source-file -q`: a missing one is skipped), then unsets
 * every hook they set (TMUX_HOOKS). So the user's key bindings, options and theme apply in DevDesk's sessions, but no
 * hook runs for DevDesk's clients. `setting`: the setting that loads another file instead, named in the header.
 */
export function sanitizedTmuxConfig(userFiles: readonly string[], setting: string): string {
  const sources = userFiles.flatMap((file) => {
    const quoted = tmuxQuote(file);
    return quoted ? [`source-file -q ${quoted}`] : [];
  });
  return [
    '# Written by DevDesk for its tmux server; rewritten when DevDesk starts, so edits here are lost.',
    `# To load your own file instead, set ${setting}.`,
    '#',
    '# Your tmux config, as tmux would load it:',
    ...sources,
    '',
    '# Without its hooks: they would also run for DevDesk\'s terminals, the board and the phone.',
    ...unsetHookCommands().map((c) => c.join(' ')),
    '',
  ].join('\n');
}
