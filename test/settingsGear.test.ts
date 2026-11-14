import { describe, expect, it } from 'vitest';
import { settingsGearCommand } from '../src/core/settingsGear';

describe('settingsGearCommand', () => {
  it('opens the user settings in a local window', () => {
    expect(settingsGearCommand(undefined, '@ext:x devdesk.web')).toEqual(['workbench.action.openSettings', { query: '@ext:x devdesk.web' }]);
  });
  it('opens the remote settings, which list machine-scoped settings, in a remote window', () => {
    expect(settingsGearCommand('ssh-remote', '@ext:x devdesk.web')).toEqual(['workbench.action.openRemoteSettings', { query: '@ext:x devdesk.web' }]);
  });
});
