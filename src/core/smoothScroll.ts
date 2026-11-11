/**
 * Smooth wheel scrolling in DevDesk's tmux server (setting `devdesk.sessions.smoothScroll`, experimental).
 *
 * With `mouse on`, tmux scrolls a pane itself: by default each wheel event jumps 5 lines. These bindings scroll
 * `lines` lines per wheel event instead, one line at a time with a short pause between them, all inside tmux (no
 * process per event). Before binding, DevDesk saves each binding it replaces in a server option (`savedOption`), and
 * turning the setting off loads them back: tmux's defaults, or the user's own from their tmux config.
 */

/**
 * The tmux server option holding the binding DevDesk replaced for BOUND_KEYS[i], as a tmux config line; unset when
 * smooth scrolling is off. One option per key: tmux 3.3 prints a newline in an option's value as `_`.
 */
export const savedOption = (i: number) => `@devdesk-smooth-scroll-saved-${i}`;

/** The pause between two one-line steps, in seconds: short, so a fast trackpad flick doesn't queue up. */
export const STEP_PAUSE_S = 0.004;

export const MIN_LINES = 1;
export const MAX_LINES = 10;
export const DEFAULT_LINES = 3;

/** The copy-mode key tables: tmux uses one or the other depending on `mode-keys`. */
const COPY_TABLES = ['copy-mode', 'copy-mode-vi'] as const;

/** The keys DevDesk binds, by table. */
export const BOUND_KEYS: readonly { table: string; key: string }[] = [
  { table: 'root', key: 'WheelUpPane' },
  ...COPY_TABLES.flatMap((table) => [
    { table, key: 'WheelUpPane' },
    { table, key: 'WheelDownPane' },
  ]),
];

/** Lines per wheel event, a whole number in [MIN_LINES, MAX_LINES]. */
export function scrollLines(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_LINES;
  return Math.min(MAX_LINES, Math.max(MIN_LINES, Math.round(value)));
}

/** `lines` one-line scrolls in `direction`, with a pause between them, as one tmux command string. */
export function steps(direction: 'up' | 'down', lines: number): string {
  const step = `send-keys -X scroll-${direction}`;
  return Array.from({ length: scrollLines(lines) }, () => step).join(` ; run-shell -d ${STEP_PAUSE_S} ; `);
}

/** As in tmux's default: the wheel goes to the program when it wants the mouse (or is full screen), else enters copy mode. */
const PASS_THROUGH = '#{||:#{alternate_on},#{pane_in_mode},#{mouse_any_flag}}';

/** One `bind-key` as tmux arguments; the command is a single string tmux parses. */
const bind = (table: string, key: string, command: string): string[] => ['bind-key', '-T', table, key, command];

/** Joins tmux commands into one invocation (`;`-separated arguments). */
export const joinCommands = (commands: string[][]): string[] => commands.flatMap((c, i) => (i ? [';', ...c] : c));

/** The bindings that make the wheel scroll `lines` lines per event, smoothly (in BOUND_KEYS order). */
export function smoothBindings(lines: number): string[][] {
  return BOUND_KEYS.map(({ table, key }) => {
    const direction = key === 'WheelUpPane' ? 'up' : 'down';
    if (table === 'root') return bind(table, key, `if-shell -F "${PASS_THROUGH}" { send-keys -M } { copy-mode -e ; ${steps('up', lines)} }`);
    return bind(table, key, `select-pane ; ${steps(direction, lines)}`);
  });
}

/**
 * The tmux config lines that bring back the bindings DevDesk replaces: for each of BOUND_KEYS, what
 * `tmux list-keys -T <table> <key>` printed (a `bind-key` line), or `unbind-key` when the key had no binding.
 */
export function savedBindings(listed: readonly (string | undefined)[]): string[] {
  return BOUND_KEYS.map(({ table, key }, i) => {
    const line = listed[i]?.split('\n').find((l) => l.trim().startsWith('bind-key'));
    return line?.trim() ?? `unbind-key -T ${table} ${key}`;
  });
}
