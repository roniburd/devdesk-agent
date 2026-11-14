import { basename, dirname, join } from 'node:path';

/*
 * DevDesk for Claude Code is v2, `roniburd.devdesk-claude`, from `main`. v1 lives on as `roniburd.devdesk-claude-v1`
 * (from the `v1` branch), and v2's prototypes (up to 2.1.0-prototype.28) were `roniburd.devdesk-claude-beta`. All
 * three contribute the same commands, views and settings, so only one may run in a window: v2 always runs, and the
 * other two step aside for it.
 */

/** The v2 extension: this one. */
export const V2_ID = 'roniburd.devdesk-claude';
/** The v1 extension, since 1.14.0 (v1 was `roniburd.devdesk-claude` before v2 took that ID). */
export const V1_ID = 'roniburd.devdesk-claude-v1';
/** v2's prototypes, 2.1.0-prototype.1 to .28, from when v2 was an experiment next to v1. */
export const BETA_ID = 'roniburd.devdesk-claude-beta';
/** How this version names the read marks it saves (`readMarks.ts`). */
export const EDITION_TAG = 'v2';
/** This extension's ID, for `@ext:` settings queries. */
export const EXTENSION_ID = V2_ID;
/** The extension whose storage folders every version keeps its shared files in: v2's. */
export const SHARED_STORAGE_ID = V2_ID;
/** The Extensions view search showing every version. */
export const VERSIONS_SEARCH = '@installed devdesk-claude';

/**
 * The shared storage folder where VS Code gave extension `ownId` the folder `own` (its `globalStorageUri` or
 * `storageUri`): the sibling folder named after `SHARED_STORAGE_ID`, which for v2 is `own` itself. Every version keeps
 * its files (prompts for later, worktree tasks, `shared-state.json`) there, so switching versions keeps them. `own` is
 * returned unchanged when it is not named after `ownId`.
 */
export function sharedStorageDir(own: string, ownId = EXTENSION_ID): string {
  return basename(own).toLowerCase() === ownId.toLowerCase() ? join(dirname(own), SHARED_STORAGE_ID) : own;
}

/**
 * Web access: v1 and v2 each run a daemon of their own, as both can be installed on one host, each running in its own
 * windows, and they share the sessions state directory (`devdesk.sessions.stateDir`). So v2 listens on its own default
 * port, keeps its daemon's files (`web.json`, `config.json`, `seen.json`, the log, the restart lock) in a folder of its
 * own there, and names its default tunnel apart: a v1 and a v2 daemon run side by side, and neither stops, restarts or
 * reads the other's.
 */
export const WEB_ACCESS = {
  /** `devdesk.web.port`'s default (v1: 7690). */
  port: 7691,
  /** The daemon's folder in the sessions state directory (v1: `web`). */
  dirName: 'web-v2',
  /** The name the default tunnel command gives its tunnel, before `-{host}` (v1: `devdesk-v1`). */
  tunnelName: 'devdesk',
} as const;

/** A view v2 contributes; its `.focus` command exists only while VS Code has the view registered. */
export const PROBE_VIEW = 'devdesk.sessions';

/** Whether `version` (`major.minor.patch`, any pre-release tag ignored) is `from` or later. */
export function versionAtLeast(version: string, from: string): boolean {
  const parts = (v: string) => v.split('-')[0].split('.').map((n) => Number.parseInt(n, 10) || 0);
  const [a, b] = [parts(version), parts(from)];
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
}

/** What v2 tells the user when it starts: what is wrong and the one button that fixes it. v2 always runs. */
export interface EditionNotice {
  kind: 'otherEnabled' | 'reload';
  message: string;
  action: 'Show Extensions' | 'Reload Window';
}

/** The other versions enabled in this window, by name for the user ("DevDesk Claude v1"). */
export type OtherVersions = { v1?: boolean; beta?: boolean };

/**
 * What v2 says when it starts, or undefined when all is well. `others`: the other versions enabled in this window too.
 * They step aside for v2 (v1 from 1.14.0, the prototypes because v2 has the ID they made way for), but VS Code may
 * still show their views instead of v2's, so v2 asks to disable them. `viewsRegistered`: VS Code has v2's views. They
 * go missing when another version was enabled as the window loaded (VS Code rejects the second extension's views,
 * settings and menus with the same IDs) and was disabled afterwards: VS Code registers them again only when the window
 * reloads, not on Restart Extensions.
 */
export function editionNotice(others: OtherVersions, viewsRegistered: boolean): EditionNotice | undefined {
  const names = [others.v1 && '"DevDesk for Claude Code (v1)"', others.beta && '"DevDesk Claude (v2)", the v2 prototype,'].filter(Boolean);
  if (names.length) {
    return {
      kind: 'otherEnabled',
      message: `${names.join(' and ')} ${names.length > 1 ? 'are' : 'is'} also enabled in this window, so DevDesk for Claude Code may not show its views. Disable or uninstall ${names.length > 1 ? 'them' : 'it'} in the Extensions view, then reload the window.`,
      action: 'Show Extensions',
    };
  }
  if (!viewsRegistered) {
    return {
      kind: 'reload',
      message: "DevDesk for Claude Code's views and settings load only when the window loads, so they are missing after switching versions. Reload the window to show them.",
      action: 'Reload Window',
    };
  }
  return undefined;
}

/** What DevDesk Claude: Switch Version… says next to the Extensions view it opens. */
export const SWITCH_HINT =
  'Enable one DevDesk for Claude Code version and disable the others, then reload the window. Restart Extensions is not enough: VS Code loads the views only when the window loads.';
