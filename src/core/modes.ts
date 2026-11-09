/** A way to start Claude Code: a name and the arguments it adds, in shell syntax. */
export interface LaunchMode {
  name: string;
  args: string;
  description?: string;
}

/** The modes `devdesk.sessions.modes` ships with: Claude's permission modes, plus the `clauded` alias. */
export const DEFAULT_MODES: readonly LaunchMode[] = [
  { name: 'Default', args: '', description: "Claude's own default (your settings' defaultMode)" },
  { name: 'Manual', args: '--permission-mode manual', description: 'Ask before every tool that needs permission' },
  { name: 'Accept edits', args: '--permission-mode acceptEdits', description: 'Edit files without asking' },
  { name: 'Auto', args: '--permission-mode auto', description: 'A classifier approves safe actions' },
  { name: 'Plan', args: '--permission-mode plan', description: 'Read and plan only, no changes' },
  { name: "Don't ask", args: '--permission-mode dontAsk', description: 'Deny anything not pre-approved, never prompt' },
  { name: 'Bypass (clauded)', args: '--dangerously-skip-permissions', description: 'Skip all permission checks' },
];

export const DEFAULT_MODE_NAME = 'Default';

/** The modes in a `devdesk.sessions.modes` value; entries without a name or with non-string fields are dropped. */
export function parseModes(value: unknown): LaunchMode[] {
  if (!Array.isArray(value)) return [...DEFAULT_MODES];
  const modes: LaunchMode[] = [];
  for (const v of value) {
    if (!v || typeof v !== 'object') continue;
    const { name, args, description } = v as Record<string, unknown>;
    if (typeof name !== 'string' || !name.trim()) continue;
    if (args !== undefined && typeof args !== 'string') continue;
    if (description !== undefined && typeof description !== 'string') continue;
    if (modes.some((m) => m.name === name.trim())) continue;
    modes.push({ name: name.trim(), args: (args ?? '').trim(), ...(description ? { description } : {}) });
  }
  return modes;
}

/**
 * The mode named `name` (case-insensitive), else the first mode, else Claude without extra arguments: a renamed or
 * deleted default mode never stops sessions from starting.
 */
export function pickMode(modes: readonly LaunchMode[], name: string | undefined): LaunchMode {
  const wanted = name?.trim().toLowerCase();
  return (wanted && modes.find((m) => m.name.toLowerCase() === wanted)) || modes[0] || { name: DEFAULT_MODE_NAME, args: '' };
}

/** Joins argument strings, skipping empty ones. */
export const joinArgs = (...parts: (string | undefined)[]) => parts.map((p) => p?.trim()).filter(Boolean).join(' ');
