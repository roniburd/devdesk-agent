/** A color the user can give a session by hand (right-click **Tag 🏷 ▸** on its row or board card). */
export interface SessionColor {
  id: string;
  label: string;
  /** The theme color its label is drawn in. */
  themeColor: string;
  /** The square before its name in the Color submenu. */
  square: string;
}

export const SESSION_COLORS: readonly SessionColor[] = [
  { id: 'red', label: 'Red', themeColor: 'charts.red', square: '🟥' },
  { id: 'orange', label: 'Orange', themeColor: 'charts.orange', square: '🟧' },
  { id: 'yellow', label: 'Yellow', themeColor: 'charts.yellow', square: '🟨' },
  { id: 'green', label: 'Green', themeColor: 'charts.green', square: '🟩' },
  { id: 'blue', label: 'Blue', themeColor: 'charts.blue', square: '🟦' },
  { id: 'purple', label: 'Purple', themeColor: 'charts.purple', square: '🟪' },
];

/** How many session colors are kept (the oldest set are dropped first). */
export const SESSION_COLORS_LIMIT = 500;

export function sessionColor(id: string | undefined): SessionColor | undefined {
  return id === undefined ? undefined : SESSION_COLORS.find((c) => c.id === id);
}

export function isSessionColorId(v: unknown): v is string {
  return typeof v === 'string' && sessionColor(v) !== undefined;
}

/**
 * A session row's decoration: the read-state one (`readDecoration`) with the user's color, if any, as the label color.
 * A color set by hand wins over greying a read row.
 */
export function rowDecoration(
  read: { badge?: string; color?: string; tooltip: string } | undefined,
  colorId: string | undefined,
): { badge?: string; color?: string; tooltip: string } | undefined {
  const color = sessionColor(colorId);
  if (!color) return read;
  return { ...(read?.badge ? { badge: read.badge } : {}), color: color.themeColor, tooltip: read ? `${read.tooltip} · ${color.label}` : color.label };
}

/** The command of a session's right-click **Tag 🏷 ▸** submenu that gives it `color` (undefined: No Color). */
export function colorCommand(color: string | undefined): string {
  return `devdesk.sessions.color.${color ?? 'none'}`;
}
