import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { MAX_PROJECT_YEAR, MIN_PROJECT_YEAR } from './limits';
import {
  END_PROJECT_HOUR,
  MAX_DAY_INDEX,
  MIN_DAY_INDEX,
  MIN_PROJECT_HOUR,
  dayIndexOf,
  fromProjectHour,
  hourOfDay,
  isProjectHour,
  startOfDay,
  toProjectHour,
  weekdayOf,
} from './time';

describe('toProjectHour', () => {
  it('converts a valid wall-clock date and hour', () => {
    const result = toProjectHour({ year: 1970, month: 1, day: 2, hour: 3 });
    expect(result).toEqual({ ok: true, value: 27 });
  });

  it('accepts the 29th of February of a leap year', () => {
    expect(toProjectHour({ year: 2028, month: 2, day: 29, hour: 0 }).ok).toBe(true);
  });

  it.each([
    ['29th of February of a common year', { year: 2026, month: 2, day: 29, hour: 0 }],
    ['30th of February', { year: 2028, month: 2, day: 30, hour: 0 }],
    ['31st of April', { year: 2026, month: 4, day: 31, hour: 0 }],
    ['day 0', { year: 2026, month: 1, day: 0, hour: 0 }],
    ['negative day', { year: 2026, month: 1, day: -1, hour: 0 }],
    ['month 0', { year: 2026, month: 0, day: 1, hour: 0 }],
    ['month 13', { year: 2026, month: 13, day: 1, hour: 0 }],
    ['hour 24', { year: 2026, month: 1, day: 1, hour: 24 }],
    ['negative hour', { year: 2026, month: 1, day: 1, hour: -1 }],
    ['fractional hour', { year: 2026, month: 1, day: 1, hour: 1.5 }],
    ['NaN year', { year: Number.NaN, month: 1, day: 1, hour: 0 }],
    ['infinite day', { year: 2026, month: 1, day: Number.POSITIVE_INFINITY, hour: 0 }],
    [
      'year before the supported period',
      { year: MIN_PROJECT_YEAR - 1, month: 12, day: 31, hour: 23 },
    ],
    ['year after the supported period', { year: MAX_PROJECT_YEAR + 1, month: 1, day: 1, hour: 0 }],
  ])('rejects %s', (_label, dateTime) => {
    expect(toProjectHour(dateTime)).toEqual({ ok: false, error: 'INVALID_DATE_TIME' });
  });

  it('accepts the first and last hours of the supported period', () => {
    expect(toProjectHour({ year: MIN_PROJECT_YEAR, month: 1, day: 1, hour: 0 })).toEqual({
      ok: true,
      value: MIN_PROJECT_HOUR,
    });
    expect(toProjectHour({ year: MAX_PROJECT_YEAR, month: 12, day: 31, hour: 23 })).toEqual({
      ok: true,
      value: END_PROJECT_HOUR - 1,
    });
  });

  it('round-trips with fromProjectHour for every supported hour', () => {
    fc.assert(
      fc.property(fc.integer({ min: MIN_PROJECT_HOUR, max: END_PROJECT_HOUR - 1 }), (hour) => {
        expect(toProjectHour(fromProjectHour(hour))).toEqual({ ok: true, value: hour });
      }),
    );
  });
});

describe('isProjectHour', () => {
  it.each([MIN_PROJECT_HOUR, END_PROJECT_HOUR - 1, 500_000])('accepts %d', (value) => {
    expect(isProjectHour(value)).toBe(true);
  });

  it.each([
    MIN_PROJECT_HOUR - 1,
    END_PROJECT_HOUR,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ])('rejects %d', (value) => {
    expect(isProjectHour(value)).toBe(false);
  });
});

describe('day helpers', () => {
  it('splits a project hour into a day and an hour of the day', () => {
    const hour = startOfDay(20_000) + 13;
    expect(dayIndexOf(hour)).toBe(20_000);
    expect(hourOfDay(hour)).toBe(13);
  });

  it('keeps the supported day range consistent with the hour range', () => {
    expect(startOfDay(MIN_DAY_INDEX)).toBe(MIN_PROJECT_HOUR);
    expect(startOfDay(MAX_DAY_INDEX + 1)).toBe(END_PROJECT_HOUR);
  });

  it('computes the same weekday as the JavaScript Date object', () => {
    fc.assert(
      fc.property(fc.integer({ min: MIN_DAY_INDEX, max: MAX_DAY_INDEX }), (day) => {
        const expected = new Date(startOfDay(day) * 3_600_000).getUTCDay();
        expect(weekdayOf(day)).toBe(expected);
      }),
    );
  });

  it('computes a valid weekday for negative day indexes', () => {
    expect(weekdayOf(-1)).toBe(3);
  });
});
