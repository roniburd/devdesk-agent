import { describe, expect, it } from 'vitest';
import { tunnelNameIgnored } from '../../src/core/web/config';

describe('tunnelNameIgnored', () => {
  it('is true when a tunnel name is set and the command has no {host}', () => {
    expect(tunnelNameIgnored({ tunnelCommand: 'tunnel create {port} --name devdesk-mac --allow {user}', tunnelName: 'cloud' })).toBe(true);
  });
  it('is false when the command has {host}, no tunnel name is set, or no tunnel runs', () => {
    expect(tunnelNameIgnored({ tunnelCommand: 'tunnel create {port} --name devdesk-{host}', tunnelName: 'cloud' })).toBe(false);
    expect(tunnelNameIgnored({ tunnelCommand: 'tunnel create {port} --name devdesk-mac', tunnelName: '' })).toBe(false);
    expect(tunnelNameIgnored({ tunnelCommand: '', tunnelName: 'cloud' })).toBe(false);
  });
});
