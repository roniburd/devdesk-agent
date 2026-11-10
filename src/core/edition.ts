/*
 * DevDesk for Claude Code ships as two extensions that you install side by side and switch between in the Extensions view:
 * v1 (`roniburd.devdesk-claude`, this one, from `main`) and v2 (`roniburd.devdesk-claude-beta`, from `v2_experiment`).
 * They contribute the same commands, views and settings, so only one may run in a window: when both are enabled, v1
 * runs and v2 steps aside (v1 up to 1.2 stepped aside for v2 instead).
 */

/** The v1 extension: this one. */
export const V1_ID = 'roniburd.devdesk-claude';
/** The v2 extension. */
export const V2_ID = 'roniburd.devdesk-claude-beta';
/** The Extensions view search showing both versions. */
export const VERSIONS_SEARCH = '@installed devdesk-claude';
