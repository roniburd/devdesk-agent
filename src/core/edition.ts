import { basename, dirname, join } from 'node:path';

/*
 * DevDesk Claude ships as two extensions that you install side by side and switch between in the Extensions view:
 * v1 (`roniburd.devdesk-claude`, from `main`) and v2 (`roniburd.devdesk-claude-beta`, from `v2_experiment`). They
 * contribute the same commands, views and settings, so only one may be enabled in a window.
 */

/** The v1 extension. */
export const V1_ID = 'roniburd.devdesk-claude';
/** The v2 extension: this one. */
export const V2_ID = 'roniburd.devdesk-claude-beta';
/** How this version names the read marks it saves (`readMarks.ts`). */
export const EDITION_TAG = 'v2';
/** This extension's ID, for `@ext:` settings queries. */
export const EXTENSION_ID = V2_ID;
/** The Extensions view search showing both versions. */
export const VERSIONS_SEARCH = '@installed devdesk-claude';

/**
 * The storage folder v1 uses where VS Code gave this extension `own` (its `globalStorageUri` or `storageUri`): the
 * sibling folder named after v1. Both versions keep their files (prompts for later, worktree tasks) there, so
 * switching versions keeps them. `own` is returned unchanged when it is not named after this extension.
 */
export function sharedStorageDir(own: string, ownId = EXTENSION_ID): string {
  return basename(own).toLowerCase() === ownId.toLowerCase() ? join(dirname(own), V1_ID) : own;
}

/** A view v2 contributes; its `.focus` command exists only while VS Code has the view registered. */
export const PROBE_VIEW = 'devdesk.sessions';

/** The first v1 release that runs when v2 is enabled too (earlier ones step aside for v2). */
export const V1_STAYS_FROM = '1.3.0';

/** Whether `version` (`major.minor.patch`, any pre-release tag ignored) is `from` or later. */
export function versionAtLeast(version: string, from: string): boolean {
  const parts = (v: string) => v.split('-')[0].split('.').map((n) => Number.parseInt(n, 10) || 0);
  const [a, b] = [parts(version), parts(from)];
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
}

/**
 * What v2 tells the user when it starts: what is wrong and the one button that fixes it. `stepAside`: v2 does not
 * start (v1 runs in this window).
 */
export interface EditionNotice {
  kind: 'stepAside' | 'bothEnabled' | 'reload';
  message: string;
  action: 'Show Extensions' | 'Reload Window';
}

/**
 * What v2 says when it starts, or undefined when all is well. `v1Version`: the version of v1 when it is enabled in this
 * window too. Only one may run, and v1 does: from `V1_STAYS_FROM` it runs, so v2 steps aside; an earlier v1 steps aside
 * itself, but VS Code may still show its views instead of v2's. `viewsRegistered`: VS Code has v2's views. They go
 * missing when v1 was enabled as the window loaded (VS Code rejects the second extension's views, settings and menus
 * with the same IDs) and was disabled afterwards: VS Code registers them again only when the window reloads, not on
 * Restart Extensions.
 */
export function editionNotice(v1Version: string | undefined, viewsRegistered: boolean): EditionNotice | undefined {
  if (v1Version !== undefined && versionAtLeast(v1Version, V1_STAYS_FROM)) {
    return {
      kind: 'stepAside',
      message: 'DevDesk Claude v2 is not running because DevDesk Claude v1 is enabled in this window. To use v2, disable "DevDesk Claude" in the Extensions view, then reload the window.',
      action: 'Show Extensions',
    };
  }
  if (v1Version !== undefined) {
    return {
      kind: 'bothEnabled',
      message: 'DevDesk Claude v1 is also enabled in this window, so v2 cannot show its views. Disable "DevDesk Claude" in the Extensions view, then reload the window.',
      action: 'Show Extensions',
    };
  }
  if (!viewsRegistered) {
    return {
      kind: 'reload',
      message: "DevDesk Claude v2's views and settings load only when the window loads, so they are missing after switching versions. Reload the window to show them.",
      action: 'Reload Window',
    };
  }
  return undefined;
}

/** What DevDesk Claude: Switch Version… says next to the Extensions view it opens. */
export const SWITCH_HINT =
  'Enable one DevDesk Claude version and disable the other, then reload the window. Restart Extensions is not enough: VS Code loads the views only when the window loads.';
