import { describe, expect, it } from 'vitest';
import { RestoreHold } from '../src/core/restoreHold';

const T0 = 1_800_000_000_000;
const S = 1000;
const LIMITS = { maxMs: 120 * S, graceMs: 60 * S };

describe('RestoreHold', () => {
  it('holds nothing before a restore starts', () => {
    const hold = new RestoreHold(LIMITS);
    expect(hold.parkingWaits(T0)).toBe(false);
    expect(hold.holds('devdesk', 'cc-main', T0)).toBe(false);
  });

  it('makes parking wait while the saved terminals are being restored', () => {
    const hold = new RestoreHold(LIMITS);
    hold.start([{ server: 'devdesk', session: 'cc-main' }], T0);
    expect(hold.parkingWaits(T0 + 5 * S)).toBe(true);
    expect(hold.holds('devdesk', 'cc-main', T0 + 5 * S)).toBe(true);
  });

  it('keeps the restored sessions for the grace period after the restore, so their terminals attach first', () => {
    const hold = new RestoreHold(LIMITS);
    hold.start([{ server: 'devdesk', session: 'cc-main' }], T0);
    hold.finish(T0 + 10 * S);
    expect(hold.parkingWaits(T0 + 10 * S)).toBe(false);
    expect(hold.holds('devdesk', 'cc-main', T0 + 69 * S)).toBe(true);
    expect(hold.holds('devdesk', 'cc-other', T0 + 11 * S)).toBe(false);
    expect(hold.holds('other', 'cc-main', T0 + 11 * S)).toBe(false);
  });

  it('lets go of every saved session after the grace period, so a stale entry (a crash, another window that closed) never keeps one from parking', () => {
    const hold = new RestoreHold(LIMITS);
    hold.start([{ server: 'devdesk', session: 'cc-stale' }], T0);
    hold.finish(T0 + 10 * S);
    expect(hold.holds('devdesk', 'cc-stale', T0 + 71 * S)).toBe(false);
  });

  it('gives up after maxMs when a restore never finishes (a hung tmux)', () => {
    const hold = new RestoreHold(LIMITS);
    hold.start([{ server: 'devdesk', session: 'cc-main' }], T0);
    expect(hold.parkingWaits(T0 + 121 * S)).toBe(false);
    expect(hold.holds('devdesk', 'cc-main', T0 + 121 * S)).toBe(false);
  });

  it('holds nothing when there was nothing to restore', () => {
    const hold = new RestoreHold(LIMITS);
    hold.start([], T0);
    expect(hold.parkingWaits(T0 + S)).toBe(false);
  });
});
