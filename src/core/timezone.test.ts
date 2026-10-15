import { describe, it, expect } from 'vitest';
import { addDays, assertTimezone, dayIn, instantAt, wallClock } from './timezone.js';

describe('timezone helpers', () => {
  it('reads the wall clock of a zone', () => {
    expect(wallClock(new Date('2026-10-12T03:30:00Z'), 'America/Tegucigalpa')).toEqual({ day: '2026-10-11', minutes: 21 * 60 + 30 });
    expect(dayIn(new Date('2026-10-12T03:30:00Z'), 'UTC')).toBe('2026-10-12');
  });

  it('turns a wall clock time back into an instant', () => {
    expect(instantAt('2026-10-12', 6 * 60, 'America/Tegucigalpa')).toEqual(new Date('2026-10-12T12:00:00Z'));
    expect(instantAt('2026-12-31', 24 * 60, 'UTC')).toEqual(new Date('2027-01-01T00:00:00Z'));
  });

  it('adds calendar days across months', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('rejects a name that is not a time zone', () => {
    expect(assertTimezone('America/Tegucigalpa')).toBe('America/Tegucigalpa');
    expect(() => assertTimezone('Honduras')).toThrow(/EXPLORE_TIMEZONE inválida/);
  });
});
