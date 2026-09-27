import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { formatDate, formatDateTime, parseDate, parseDateTime } from './civil-format';
import { PROPERTY_TEST_TIMEOUT_MS } from './testing/arbitraries';
import { END_PROJECT_HOUR, MAX_DAY_INDEX, MIN_DAY_INDEX, MIN_PROJECT_HOUR } from './time';

describe('civil format', { timeout: PROPERTY_TEST_TIMEOUT_MS }, () => {
  it('reads back every hour of the supported period', () => {
    fc.assert(
      fc.property(fc.integer({ min: MIN_PROJECT_HOUR, max: END_PROJECT_HOUR - 1 }), (hour) => {
        expect(parseDateTime(formatDateTime(hour))).toEqual({ ok: true, value: hour });
      }),
    );
  });

  it('reads back every day of the supported period', () => {
    fc.assert(
      fc.property(fc.integer({ min: MIN_DAY_INDEX, max: MAX_DAY_INDEX }), (day) => {
        expect(parseDate(formatDate(day))).toEqual({ ok: true, value: day });
      }),
    );
  });

  it('follows the leap year rules of the Gregorian calendar', () => {
    expect(parseDateTime('2000-02-29T00:00').ok).toBe(true);
    expect(parseDateTime('2100-02-29T00:00').ok).toBe(false);
    expect(parseDate('2024-02-29').ok).toBe(true);
    expect(parseDate('2100-02-29').ok).toBe(false);
  });

  it('writes the first and last hours of the supported period', () => {
    expect(formatDateTime(MIN_PROJECT_HOUR)).toBe('1970-01-01T00:00');
    expect(formatDateTime(END_PROJECT_HOUR - 1)).toBe('2200-12-31T23:00');
    expect(formatDate(MAX_DAY_INDEX)).toBe('2200-12-31');
  });
});
