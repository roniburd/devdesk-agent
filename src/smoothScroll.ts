import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { sessionsSmoothScroll, sessionsSmoothScrollAcceleration, sessionsSmoothScrollLines, sessionsTmux } from './config';
import { BOUND_KEYS, joinCommands, savedBindings, savedOption, smoothBindings } from './core/smoothScroll';
import { log } from './log';

/** One apply at a time: a second change waits for the first, so two never save the bindings the other just made. */
let applying: Promise<void> = Promise.resolve();

/**
 * Applies `devdesk.sessions.smoothScroll` to DevDesk's running tmux server. On: saves the wheel bindings it replaces
 * (once) and binds the wheel. Off: loads the saved bindings back. Does nothing when no server runs; a session started
 * later applies it again (`applySmoothScrollWhenUp`).
 */
export function applySmoothScroll(): Promise<void> {
  applying = applying.then(apply, apply);
  return applying;
}

async function apply(): Promise<void> {
  const tmux = sessionsTmux();
  try {
    const show = (i: number) => tmux(['show-options', '-sqv', savedOption(i)]).then((v) => v.replace(/\n$/, ''));
    const saved = await Promise.all(BOUND_KEYS.map((_, i) => show(i))).catch(() => undefined);
    if (!saved) return; // no server
    const isSaved = saved.some(Boolean);
    if (sessionsSmoothScroll()) {
      if (!isSaved) {
        const listed = await Promise.all(BOUND_KEYS.map(({ table, key }) => tmux(['list-keys', '-T', table, key]).catch(() => undefined)));
        await tmux(joinCommands(savedBindings(listed).map((line, i) => ['set-option', '-s', savedOption(i), line])));
      }
      await tmux(joinCommands(smoothBindings(sessionsSmoothScrollLines(), sessionsSmoothScrollAcceleration())));
    } else if (isSaved) {
      await restore(saved.filter(Boolean).join('\n'));
      await tmux(joinCommands(BOUND_KEYS.map((_, i) => ['set-option', '-su', savedOption(i)])));
    }
  } catch (err) {
    log.warn(`smooth scroll: ${(err as Error).message}`);
  }
}

/** Loads `lines` (tmux config lines) into DevDesk's tmux server, through a private temporary file. */
async function restore(lines: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'devdesk-smooth-scroll-'));
  try {
    const file = join(dir, 'bindings.conf');
    await writeFile(file, `${lines}\n`, { mode: 0o600 });
    await sessionsTmux()(['source-file', file]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * After DevDesk starts session `session` (possibly starting its tmux server): applies smooth scrolling once the server
 * answers, so a server that starts with smooth scrolling on gets the bindings. Gives up after a few seconds.
 */
export async function applySmoothScrollWhenUp(session: string): Promise<void> {
  if (!sessionsSmoothScroll()) return;
  const tmux = sessionsTmux();
  for (let i = 0; i < 50; i++) {
    if (await tmux(['has-session', '-t', `=${session}`]).then(() => true, () => false)) return applySmoothScroll();
    await new Promise((r) => setTimeout(r, 100));
  }
}

export function registerSmoothScroll(): vscode.Disposable[] {
  void applySmoothScroll();
  return [
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (['smoothScroll', 'smoothScrollLines', 'smoothScrollAcceleration'].some((k) => e.affectsConfiguration(`devdesk.sessions.${k}`))) void applySmoothScroll();
    }),
  ];
}
