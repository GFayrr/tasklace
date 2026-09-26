import { describe, expect, it } from 'vitest';
import { MAX_NON_WORKING_PERIODS, MAX_WORKING_TIME_RANGES } from '../limits';
import type { DayRange, TimeRange, WorkingCalendar } from '../model/calendar';
import { MAX_DAY_INDEX, MIN_DAY_INDEX, MONDAY, SATURDAY, SUNDAY, type Weekday } from '../time';
import { compileOrThrow, dayOf } from '../testing/civil-time';
import { compileCalendar } from './compile-calendar';
import { DEFAULT_CALENDAR } from './default-calendar';
import { isWorkingDay } from './working-time';

/** Builds a calendar from the default one with some fields replaced. */
function calendarWith(overrides: Partial<WorkingCalendar>): WorkingCalendar {
  return { ...DEFAULT_CALENDAR, ...overrides };
}

describe('compileCalendar', () => {
  it('compiles the default calendar into Monday–Friday, 09:00–12:00 and 13:00–17:00', () => {
    const calendar = compileOrThrow(DEFAULT_CALENDAR);
    expect(calendar.workingHoursOfDay).toEqual([9, 10, 11, 13, 14, 15, 16]);
    const week = Array.from({ length: 7 }, (_value, offset) => dayOf(2026, 9, 27) + offset);
    expect(week.map((day) => isWorkingDay(calendar, day))).toEqual([
      false,
      true,
      true,
      true,
      true,
      true,
      false,
    ]);
  });

  it('accepts a single working day per week and a single working hour', () => {
    const result = compileCalendar(
      calendarWith({
        workingWeekdays: [SUNDAY],
        workingTimeRanges: [{ startHour: 23, endHour: 24 }],
      }),
    );
    expect(result.ok && result.value.workingHoursOfDay).toEqual([23]);
  });

  it('accepts every day of the week and the whole day', () => {
    const everyDay: Weekday[] = [0, 1, 2, 3, 4, 5, 6];
    const result = compileCalendar(
      calendarWith({
        workingWeekdays: everyDay,
        workingTimeRanges: [{ startHour: 0, endHour: 24 }],
      }),
    );
    expect(result.ok && result.value.workingHoursOfDay).toHaveLength(24);
  });

  it('sorts working hours given as unsorted, adjacent ranges', () => {
    const result = compileCalendar(
      calendarWith({
        workingTimeRanges: [
          { startHour: 14, endHour: 16 },
          { startHour: 8, endHour: 10 },
          { startHour: 10, endHour: 11 },
        ],
      }),
    );
    expect(result.ok && result.value.workingHoursOfDay).toEqual([8, 9, 10, 14, 15]);
  });

  it('handles overlapping, touching, nested and unsorted non-working periods', () => {
    const calendar = compileOrThrow({
      workingWeekdays: [0, 1, 2, 3, 4, 5, 6],
      workingTimeRanges: [{ startHour: 9, endHour: 17 }],
      nonWorkingPeriods: [
        { firstDay: 30, lastDay: 31 },
        { firstDay: 10, lastDay: 12 },
        { firstDay: 13, lastDay: 15 },
        { firstDay: 11, lastDay: 14 },
        { firstDay: 20, lastDay: 20 },
        { firstDay: 40, lastDay: 50 },
        { firstDay: 42, lastDay: 44 },
      ],
    });
    const nonWorkingDays = Array.from({ length: 60 }, (_value, day) => day).filter(
      (day) => !isWorkingDay(calendar, day),
    );
    expect(nonWorkingDays).toEqual([
      10, 11, 12, 13, 14, 15, 20, 30, 31, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50,
    ]);
  });

  it('accepts periods on the very first and last supported days', () => {
    const result = compileCalendar(
      calendarWith({ nonWorkingPeriods: [{ firstDay: MIN_DAY_INDEX, lastDay: MAX_DAY_INDEX }] }),
    );
    expect(result.ok).toBe(true);
  });

  describe('rejects', () => {
    it.each<[string, readonly Weekday[], string]>([
      ['no working weekday', [], 'NO_WORKING_WEEKDAY'],
      ['a weekday above Saturday', [7 as Weekday], 'INVALID_WEEKDAY'],
      ['a negative weekday', [-1 as Weekday], 'INVALID_WEEKDAY'],
      ['a fractional weekday', [1.5 as Weekday], 'INVALID_WEEKDAY'],
      ['a NaN weekday', [Number.NaN as Weekday], 'INVALID_WEEKDAY'],
      ['a duplicated weekday', [MONDAY, SATURDAY, MONDAY], 'DUPLICATE_WEEKDAY'],
    ])('%s', (_label, workingWeekdays, code) => {
      const result = compileCalendar(calendarWith({ workingWeekdays }));
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error.map((error) => error.code)).toEqual([code]);
    });

    it.each<[string, readonly TimeRange[], string]>([
      ['no working time range', [], 'NO_WORKING_TIME_RANGE'],
      ['an empty range', [{ startHour: 9, endHour: 9 }], 'INVALID_WORKING_TIME_RANGE'],
      ['a reversed range', [{ startHour: 12, endHour: 9 }], 'INVALID_WORKING_TIME_RANGE'],
      [
        'a range ending after midnight',
        [{ startHour: 20, endHour: 25 }],
        'INVALID_WORKING_TIME_RANGE',
      ],
      ['a negative range', [{ startHour: -2, endHour: 3 }], 'INVALID_WORKING_TIME_RANGE'],
      ['a fractional range', [{ startHour: 9.5, endHour: 12 }], 'INVALID_WORKING_TIME_RANGE'],
      ['a NaN range', [{ startHour: Number.NaN, endHour: 12 }], 'INVALID_WORKING_TIME_RANGE'],
      ['a huge range', [{ startHour: 0, endHour: 1e12 }], 'INVALID_WORKING_TIME_RANGE'],
      [
        'overlapping ranges',
        [
          { startHour: 9, endHour: 12 },
          { startHour: 11, endHour: 14 },
        ],
        'OVERLAPPING_WORKING_TIME_RANGES',
      ],
      [
        'too many ranges',
        Array.from({ length: MAX_WORKING_TIME_RANGES + 1 }, () => ({ startHour: 0, endHour: 1 })),
        'TOO_MANY_WORKING_TIME_RANGES',
      ],
    ])('%s', (_label, workingTimeRanges, code) => {
      const result = compileCalendar(calendarWith({ workingTimeRanges }));
      expect(!result.ok && result.error.map((error) => error.code)).toEqual([code]);
    });

    it.each<[string, readonly DayRange[], string]>([
      ['a reversed period', [{ firstDay: 10, lastDay: 9 }], 'INVALID_NON_WORKING_PERIOD'],
      [
        'a period before the supported range',
        [{ firstDay: MIN_DAY_INDEX - 1, lastDay: 5 }],
        'INVALID_NON_WORKING_PERIOD',
      ],
      [
        'a period after the supported range',
        [{ firstDay: 5, lastDay: MAX_DAY_INDEX + 1 }],
        'INVALID_NON_WORKING_PERIOD',
      ],
      ['a fractional period', [{ firstDay: 1.5, lastDay: 3 }], 'INVALID_NON_WORKING_PERIOD'],
      ['a NaN period', [{ firstDay: 1, lastDay: Number.NaN }], 'INVALID_NON_WORKING_PERIOD'],
      [
        'too many periods',
        Array.from({ length: MAX_NON_WORKING_PERIODS + 1 }, (_value, index) => ({
          firstDay: index,
          lastDay: index,
        })),
        'TOO_MANY_NON_WORKING_PERIODS',
      ],
    ])('%s', (_label, nonWorkingPeriods, code) => {
      const result = compileCalendar(calendarWith({ nonWorkingPeriods }));
      expect(!result.ok && result.error.map((error) => error.code)).toEqual([code]);
    });

    it('reports every error at once, with the index of the faulty entry', () => {
      const result = compileCalendar({
        workingWeekdays: [MONDAY, 9 as Weekday],
        workingTimeRanges: [
          { startHour: 9, endHour: 12 },
          { startHour: 15, endHour: 14 },
        ],
        nonWorkingPeriods: [{ firstDay: 3, lastDay: 1 }],
      });
      expect(!result.ok && result.error).toEqual([
        { code: 'INVALID_WEEKDAY', index: 1 },
        { code: 'INVALID_WORKING_TIME_RANGE', index: 1 },
        { code: 'INVALID_NON_WORKING_PERIOD', index: 0 },
      ]);
    });
  });
});
