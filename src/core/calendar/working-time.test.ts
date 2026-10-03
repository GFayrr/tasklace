import { describe, expect, it } from 'vitest';
import { MAX_TASK_DURATION_HOURS } from '../limits';
import { at, compileOrThrow, dayOf, format } from '../testing/civil-time';
import {
  END_PROJECT_HOUR,
  MAX_DAY_INDEX,
  MIN_DAY_INDEX,
  MIN_PROJECT_HOUR,
  MONDAY,
  WEDNESDAY,
} from '../time';
import { TEST_CALENDAR } from '../testing/test-calendar';
import {
  addWorkingHours,
  countWorkingHours,
  isWorkingDay,
  lastWorkingHourEnd,
  nextWorkingDay,
  nextWorkingHour,
  previousWorkingDay,
  signedWorkingHoursBetween,
  subtractWorkingHours,
} from './working-time';

const calendar = compileOrThrow(TEST_CALENDAR);

const calendarWithHolidays = compileOrThrow({
  ...TEST_CALENDAR,
  nonWorkingPeriods: [
    { firstDay: dayOf(2026, 10, 1), lastDay: dayOf(2026, 10, 2) },
    { firstDay: dayOf(2026, 10, 5), lastDay: dayOf(2026, 10, 9) },
  ],
});

/** Formats a successful result, or returns its error code, for readable assertions. */
function formatResult(result: { ok: true; value: number } | { ok: false; error: string }): string {
  return result.ok ? format(result.value) : result.error;
}

describe('nextWorkingDay and previousWorkingDay', () => {
  it('keep a working day unchanged', () => {
    const monday = dayOf(2026, 9, 28);
    expect(nextWorkingDay(calendar, monday)).toBe(monday);
    expect(previousWorkingDay(calendar, monday)).toBe(monday);
  });

  it('skip the weekend in both directions', () => {
    expect(nextWorkingDay(calendar, dayOf(2026, 9, 26))).toBe(dayOf(2026, 9, 28));
    expect(previousWorkingDay(calendar, dayOf(2026, 9, 27))).toBe(dayOf(2026, 9, 25));
  });

  it('skip non-working periods and the weekends that follow them', () => {
    expect(nextWorkingDay(calendarWithHolidays, dayOf(2026, 10, 1))).toBe(dayOf(2026, 10, 12));
    expect(previousWorkingDay(calendarWithHolidays, dayOf(2026, 10, 9))).toBe(dayOf(2026, 9, 30));
  });

  it('return null when no working day exists before the horizon', () => {
    const blocked = compileOrThrow({
      ...TEST_CALENDAR,
      nonWorkingPeriods: [{ firstDay: MIN_DAY_INDEX, lastDay: MAX_DAY_INDEX }],
    });
    expect(nextWorkingDay(blocked, dayOf(2026, 1, 1))).toBeNull();
    expect(previousWorkingDay(blocked, dayOf(2026, 1, 1))).toBeNull();
  });

  it('clamp days outside the supported range', () => {
    expect(nextWorkingDay(calendar, MIN_DAY_INDEX - 10)).toBe(MIN_DAY_INDEX);
    expect(nextWorkingDay(calendar, MAX_DAY_INDEX + 1)).toBeNull();
    expect(previousWorkingDay(calendar, MIN_DAY_INDEX - 1)).toBeNull();
    expect(previousWorkingDay(calendar, MAX_DAY_INDEX + 10)).toBe(
      previousWorkingDay(calendar, MAX_DAY_INDEX),
    );
  });
});

describe('nextWorkingHour', () => {
  it.each([
    ['a working hour', at(2026, 9, 28, 10), '2026-09-28 10:00'],
    ['the lunch break', at(2026, 9, 28, 12), '2026-09-28 13:00'],
    ['the night before work', at(2026, 9, 28, 3), '2026-09-28 09:00'],
    ['the end of the working day', at(2026, 9, 28, 17), '2026-09-29 09:00'],
    ['a Friday evening', at(2026, 10, 2, 20), '2026-10-05 09:00'],
    ['a Saturday', at(2026, 10, 3, 11), '2026-10-05 09:00'],
  ])('from %s', (_label, instant, expected) => {
    expect(formatResult(nextWorkingHour(calendar, instant))).toBe(expected);
  });

  it('skips non-working periods', () => {
    expect(formatResult(nextWorkingHour(calendarWithHolidays, at(2026, 9, 30, 17)))).toBe(
      '2026-10-12 09:00',
    );
  });

  it.each([Number.NaN, 1.3, MIN_PROJECT_HOUR - 1, END_PROJECT_HOUR, Number.POSITIVE_INFINITY])(
    'rejects the invalid instant %d',
    (instant) => {
      expect(nextWorkingHour(calendar, instant)).toEqual({ ok: false, error: 'INVALID_INSTANT' });
    },
  );

  it('fails past the last working hour of the horizon', () => {
    expect(nextWorkingHour(calendar, END_PROJECT_HOUR - 1)).toEqual({
      ok: false,
      error: 'BEYOND_PLANNING_HORIZON',
    });
  });
});

describe('addWorkingHours', () => {
  it.each([
    ['zero hours', at(2026, 9, 28, 3), 0, '2026-09-28 03:00'],
    ['one hour', at(2026, 9, 28, 9), 1, '2026-09-28 10:00'],
    ['hours across the lunch break', at(2026, 9, 28, 11), 2, '2026-09-28 14:00'],
    ['exactly one working day', at(2026, 9, 28, 9), 7, '2026-09-28 17:00'],
    ['one working day plus one hour', at(2026, 9, 28, 9), 8, '2026-09-29 10:00'],
    ['hours across a weekend', at(2026, 10, 2, 16), 2, '2026-10-05 10:00'],
    ['hours from a non-working instant', at(2026, 10, 3, 0), 1, '2026-10-05 10:00'],
    ['a full working week', at(2026, 9, 28, 9), 35, '2026-10-02 17:00'],
  ])('adds %s', (_label, from, hours, expected) => {
    expect(formatResult(addWorkingHours(calendar, from, hours))).toBe(expected);
  });

  it('skips non-working periods', () => {
    expect(formatResult(addWorkingHours(calendarWithHolidays, at(2026, 9, 30, 16), 2))).toBe(
      '2026-10-12 10:00',
    );
  });

  it('supports the maximum task duration', () => {
    const result = addWorkingHours(calendar, at(2026, 1, 1), MAX_TASK_DURATION_HOURS);
    expect(result.ok).toBe(true);
  });

  it.each([-1, 0.3, Number.NaN, Number.POSITIVE_INFINITY, MAX_TASK_DURATION_HOURS + 1])(
    'rejects the invalid hour count %d',
    (hours) => {
      expect(addWorkingHours(calendar, at(2026, 1, 1), hours)).toEqual({
        ok: false,
        error: 'INVALID_HOURS',
      });
    },
  );

  it('rejects an invalid instant', () => {
    expect(addWorkingHours(calendar, Number.NaN, 1)).toEqual({
      ok: false,
      error: 'INVALID_INSTANT',
    });
  });

  it('fails when the result falls past the horizon', () => {
    const lastYear = at(2200, 12, 1);
    expect(addWorkingHours(calendar, lastYear, MAX_TASK_DURATION_HOURS)).toEqual({
      ok: false,
      error: 'BEYOND_PLANNING_HORIZON',
    });
  });
});

describe('subtractWorkingHours', () => {
  it.each([
    ['zero hours', at(2026, 9, 28, 3), 0, '2026-09-28 03:00'],
    ['one hour', at(2026, 9, 28, 10), 1, '2026-09-28 09:00'],
    ['hours across the lunch break', at(2026, 9, 28, 14), 2, '2026-09-28 11:00'],
    ['exactly one working day', at(2026, 9, 28, 17), 7, '2026-09-28 09:00'],
    ['hours from the start of a day', at(2026, 9, 29, 9), 1, '2026-09-28 16:00'],
    ['hours across a weekend', at(2026, 10, 5, 10), 2, '2026-10-02 16:00'],
    ['hours from a non-working instant', at(2026, 10, 4, 12), 1, '2026-10-02 16:00'],
  ])('subtracts %s', (_label, to, hours, expected) => {
    expect(formatResult(subtractWorkingHours(calendar, to, hours))).toBe(expected);
  });

  it('skips non-working periods', () => {
    expect(formatResult(subtractWorkingHours(calendarWithHolidays, at(2026, 10, 12, 10), 2))).toBe(
      '2026-09-30 16:00',
    );
  });

  it('rejects invalid input', () => {
    expect(subtractWorkingHours(calendar, Number.NaN, 1)).toEqual({
      ok: false,
      error: 'INVALID_INSTANT',
    });
    expect(subtractWorkingHours(calendar, at(2026, 1, 1), -3)).toEqual({
      ok: false,
      error: 'INVALID_HOURS',
    });
  });

  it('fails when the result falls before the horizon', () => {
    expect(subtractWorkingHours(calendar, at(2020, 1, 6, 12), 100)).toEqual({
      ok: false,
      error: 'BEYOND_PLANNING_HORIZON',
    });
  });
});

describe('countWorkingHours', () => {
  it.each([
    ['an empty interval', at(2026, 9, 28, 10), at(2026, 9, 28, 10), 0],
    ['one working day', at(2026, 9, 28, 0), at(2026, 9, 29, 0), 7],
    ['a partial day across lunch', at(2026, 9, 28, 11), at(2026, 9, 28, 14), 2],
    ['a full week with a weekend', at(2026, 9, 28, 0), at(2026, 10, 5, 0), 35],
    ['a weekend only', at(2026, 10, 3, 0), at(2026, 10, 5, 0), 0],
  ])('counts %s', (_label, from, to, expected) => {
    expect(countWorkingHours(calendar, from, to)).toEqual({ ok: true, value: expected });
  });

  it('ignores non-working periods', () => {
    expect(countWorkingHours(calendarWithHolidays, at(2026, 9, 28), at(2026, 10, 13))).toEqual({
      ok: true,
      value: 7 * 4,
    });
  });

  it('counts the whole supported period without failing', () => {
    expect(countWorkingHours(calendar, MIN_PROJECT_HOUR, END_PROJECT_HOUR - 1).ok).toBe(true);
  });

  it('rejects a reversed interval and invalid instants', () => {
    expect(countWorkingHours(calendar, at(2026, 9, 29), at(2026, 9, 28))).toEqual({
      ok: false,
      error: 'INVALID_INTERVAL',
    });
    expect(countWorkingHours(calendar, at(2026, 9, 29), Number.NaN)).toEqual({
      ok: false,
      error: 'INVALID_INSTANT',
    });
  });
});

describe('unusual calendars', () => {
  it('handles a one-day week with a night shift', () => {
    const nightShift = compileOrThrow({
      workingWeekdays: [WEDNESDAY],
      workingTimeRanges: [{ startHour: 22, endHour: 24 }],
      nonWorkingPeriods: [],
    });
    expect(formatResult(addWorkingHours(nightShift, at(2026, 9, 28), 3))).toBe('2026-10-07 23:00');
  });

  it('handles a calendar working only on Mondays with holidays on every Monday of a month', () => {
    const mondays = compileOrThrow({
      workingWeekdays: [MONDAY],
      workingTimeRanges: [{ startHour: 8, endHour: 9 }],
      nonWorkingPeriods: [{ firstDay: dayOf(2026, 10, 1), lastDay: dayOf(2026, 10, 31) }],
    });
    expect(formatResult(nextWorkingHour(mondays, at(2026, 10, 1)))).toBe('2026-11-02 08:00');
  });
});

describe('instants at the edges of the supported period', () => {
  it('has no working day outside the supported period', () => {
    expect(isWorkingDay(calendar, MIN_DAY_INDEX - 1)).toBe(false);
    expect(isWorkingDay(calendar, MAX_DAY_INDEX + 1)).toBe(false);
    expect(isWorkingDay(calendar, dayOf(2026, 9, 28))).toBe(true);
    expect(isWorkingDay(calendar, dayOf(2026, 9, 27))).toBe(false);
  });

  it('finds the end of the last working quarter hour, and none before the first working day', () => {
    expect(lastWorkingHourEnd(calendar, at(2026, 9, 28, 20))).toEqual({
      ok: true,
      value: at(2026, 9, 28, 17),
    });
    expect(lastWorkingHourEnd(calendar, MIN_PROJECT_HOUR).ok).toBe(false);
  });

  it('counts working hours backwards, and reports an instant outside the supported period either way', () => {
    expect(signedWorkingHoursBetween(calendar, at(2026, 9, 29, 9), at(2026, 9, 28, 9))).toEqual({
      ok: true,
      value: -7,
    });
    expect(signedWorkingHoursBetween(calendar, END_PROJECT_HOUR, at(2026, 9, 28, 9)).ok).toBe(
      false,
    );
    expect(signedWorkingHoursBetween(calendar, at(2026, 9, 28, 9), END_PROJECT_HOUR).ok).toBe(
      false,
    );
  });
});
