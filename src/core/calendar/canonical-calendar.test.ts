import { describe, expect, it } from 'vitest';
import { FRIDAY, MONDAY, WEDNESDAY } from '../time';
import { canonicalCalendar, compareNumbers } from './canonical-calendar';

describe('canonicalCalendar', () => {
  it('sorts each list of a calendar by its values and keeps one of each item', () => {
    expect(
      canonicalCalendar({
        workingWeekdays: [FRIDAY, MONDAY, WEDNESDAY, MONDAY],
        workingTimeRanges: [
          { startHour: 13, endHour: 17 },
          { startHour: 9, endHour: 12 },
          { startHour: 9, endHour: 10 },
        ],
        nonWorkingPeriods: [
          { firstDay: 20_400, lastDay: 20_401 },
          { firstDay: 20_390, lastDay: 20_395 },
          { firstDay: 20_400, lastDay: 20_401 },
          { firstDay: 20_390, lastDay: 20_391 },
        ],
      }),
    ).toEqual({
      workingWeekdays: [MONDAY, WEDNESDAY, FRIDAY],
      workingTimeRanges: [
        { startHour: 9, endHour: 10 },
        { startHour: 9, endHour: 12 },
        { startHour: 13, endHour: 17 },
      ],
      nonWorkingPeriods: [
        { firstDay: 20_390, lastDay: 20_391 },
        { firstDay: 20_390, lastDay: 20_395 },
        { firstDay: 20_400, lastDay: 20_401 },
      ],
    });
  });
});

describe('compareNumbers', () => {
  it('orders lists of numbers by their first differing number', () => {
    expect([
      compareNumbers([1, 5], [2, 0]),
      compareNumbers([2, 5], [2, 3]),
      compareNumbers([2, 3], [2, 3]),
    ]).toEqual([-1, 2, 0]);
  });
});
