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

/** The warning v2 shows when v1 is enabled in the same window, or undefined when it is not. */
export function bothEnabledWarning(v1Enabled: boolean): string | undefined {
  return v1Enabled
    ? 'DevDesk Claude v1 is also enabled in this window. Only one version can run: disable "DevDesk Claude" in the Extensions view, then restart extensions.'
    : undefined;
}
