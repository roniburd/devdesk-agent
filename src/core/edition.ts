import { basename, dirname, join } from 'node:path';

/*
 * DevDesk for Claude Code ships as v2, `roniburd.devdesk-claude` from `main`, and this v1, `roniburd.devdesk-claude-v1`
 * from the `v1` branch (up to 1.13.0 v1 was `roniburd.devdesk-claude`, and v2's prototypes `roniburd.devdesk-claude-beta`).
 * They contribute the same commands, views and settings, so only one may run in a window: when v2 is enabled too, v1
 * steps aside for it.
 */

/** The v1 extension: this one. */
export const V1_ID = 'roniburd.devdesk-claude-v1';
/** The v2 extension. */
export const V2_ID = 'roniburd.devdesk-claude';
/** This extension's ID, for `@ext:` settings queries. */
export const EXTENSION_ID = V1_ID;
/** The extension whose storage folders both versions keep their shared files in: v2's (v1's own up to 1.13.0). */
export const SHARED_STORAGE_ID = V2_ID;
/** How this version names the read marks it saves (`readMarks.ts`). */
export const EDITION_TAG = 'v1';
/** The Extensions view search showing both versions. */
export const VERSIONS_SEARCH = '@installed devdesk-claude';

/**
 * The shared storage folder where VS Code gave this extension `own` (its `globalStorageUri` or `storageUri`): the
 * sibling folder named after `SHARED_STORAGE_ID`. Both versions keep their files (prompts for later, worktree tasks,
 * `shared-state.json`) there, so switching versions keeps them. `own` is returned unchanged when it is not named after
 * `ownId`.
 */
export function sharedStorageDir(own: string, ownId = EXTENSION_ID): string {
  return basename(own).toLowerCase() === ownId.toLowerCase() ? join(dirname(own), SHARED_STORAGE_ID) : own;
}

/** What v1 says when it steps aside because v2 is enabled in this window too. */
export const STEP_ASIDE_MESSAGE =
  'DevDesk for Claude Code (v1) is not running because DevDesk for Claude Code v2 is enabled in this window. To use v1, disable "DevDesk for Claude Code" in the Extensions view, then reload the window.';
