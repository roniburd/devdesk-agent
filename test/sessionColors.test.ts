import { describe, expect, it } from 'vitest';
import { colorCommand, isSessionColorId, rowDecoration, SESSION_COLORS, sessionColor } from '../src/core/sessionColors';

describe('session colors', () => {
  it('knows its colors by id', () => {
    expect(sessionColor('red')?.themeColor).toBe('charts.red');
    expect(sessionColor('nope')).toBeUndefined();
    expect(sessionColor(undefined)).toBeUndefined();
    expect(isSessionColorId('blue')).toBe(true);
    expect(isSessionColorId('magenta')).toBe(false);
    expect(isSessionColorId(3)).toBe(false);
    expect(new Set(SESSION_COLORS.map((c) => c.id)).size).toBe(SESSION_COLORS.length);
  });

  it('keeps the read decoration when there is no color', () => {
    const read = { color: 'descriptionForeground', tooltip: 'Read' };
    expect(rowDecoration(read, undefined)).toBe(read);
    expect(rowDecoration(undefined, 'unknown')).toBeUndefined();
  });

  it('colors the label over the read greying and keeps the unread badge', () => {
    expect(rowDecoration({ color: 'descriptionForeground', tooltip: 'Read' }, 'green')).toEqual({ color: 'charts.green', tooltip: 'Read · Green' });
    expect(rowDecoration({ badge: '●', tooltip: 'Unread' }, 'red')).toEqual({ badge: '●', color: 'charts.red', tooltip: 'Unread · Red' });
    expect(rowDecoration(undefined, 'blue')).toEqual({ color: 'charts.blue', tooltip: 'Blue' });
  });

  it('names the Color submenu commands', () => {
    expect(colorCommand('red')).toBe('devdesk.sessions.color.red');
    expect(colorCommand(undefined)).toBe('devdesk.sessions.color.none');
  });
});
