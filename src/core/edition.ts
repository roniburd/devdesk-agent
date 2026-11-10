/*
 * DevDesk for Claude Code ships as two extensions that you install side by side and switch between in the Extensions view:
 * v1 (`roniburd.devdesk-claude`, this one, from `main`) and v2 (`roniburd.devdesk-claude-beta`, from `v2_experiment`).
 * They contribute the same commands, views and settings, so only one may run in a window: v1 steps aside for v2.
 */

/** The v1 extension: this one. */
export const V1_ID = 'roniburd.devdesk-claude';
/** The v2 extension. */
export const V2_ID = 'roniburd.devdesk-claude-beta';
/** The Extensions view search showing both versions. */
export const VERSIONS_SEARCH = '@installed devdesk-claude';

/** What v1 says when it does not start because v2 is enabled in the same window, or undefined when v2 is not. */
export function stepAsideMessage(v2Enabled: boolean): string | undefined {
  return v2Enabled
    ? 'DevDesk for Claude Code v1 is not running because DevDesk for Claude Code (v2) is enabled in this window. Disable one of them in the Extensions view.'
    : undefined;
}
