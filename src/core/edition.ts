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

/** What v2 tells the user when it starts: what is wrong and the one button that fixes it. */
export interface EditionNotice {
  kind: 'bothEnabled' | 'reload';
  message: string;
  action: 'Show Extensions' | 'Reload Window';
}

/**
 * What v2 says when it starts, or undefined when all is well. `v1Enabled`: v1 is enabled in this window too.
 * `viewsRegistered`: VS Code has v2's views. They go missing when v1 was enabled as the window loaded (VS Code rejects
 * the second extension's views, settings and menus with the same IDs) and was disabled afterwards: VS Code registers
 * them again only when the window reloads, not on Restart Extensions.
 */
export function editionNotice(v1Enabled: boolean, viewsRegistered: boolean): EditionNotice | undefined {
  if (v1Enabled) {
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
