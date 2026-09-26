import fc from 'fast-check';
import type { Result } from '../result';
import type { TimeRange, WorkingCalendar } from '../model/calendar';
import { HOURS_PER_DAY, type Weekday } from '../time';
import { dayOf } from './civil-time';

export const FIRST_TEST_DAY = dayOf(2026, 1, 1);
const MAX_TEST_DURATION_HOURS = 300;
export const TEST_SPAN_DAYS = 400;

/** Turns a set of hours of the day into the smallest list of continuous ranges. */
function hoursToRanges(hours: readonly number[]): TimeRange[] {
  const ranges: TimeRange[] = [];
  for (const hour of [...hours].sort((left, right) => left - right)) {
    const last = ranges.at(-1);
    if (last?.endHour === hour) {
      ranges[ranges.length - 1] = { startHour: last.startHour, endHour: hour + 1 };
    } else {
      ranges.push({ startHour: hour, endHour: hour + 1 });
    }
  }
  return ranges;
}

export const calendarArbitrary: fc.Arbitrary<WorkingCalendar> = fc.record({
  workingWeekdays: fc
    .uniqueArray(fc.integer({ min: 0, max: 6 }), { minLength: 1, maxLength: 7 })
    .map((weekdays) => weekdays as Weekday[]),
  workingTimeRanges: fc
    .uniqueArray(fc.integer({ min: 0, max: HOURS_PER_DAY - 1 }), { minLength: 1, maxLength: 24 })
    .map(hoursToRanges),
  nonWorkingPeriods: fc.array(
    fc
      .record({
        offset: fc.integer({ min: 0, max: TEST_SPAN_DAYS }),
        length: fc.integer({ min: 0, max: 20 }),
      })
      .map(({ offset, length }) => ({
        firstDay: FIRST_TEST_DAY + offset,
        lastDay: FIRST_TEST_DAY + offset + length,
      })),
    { maxLength: 10 },
  ),
});

export const instantArbitrary = fc.integer({
  min: FIRST_TEST_DAY * HOURS_PER_DAY,
  max: (FIRST_TEST_DAY + TEST_SPAN_DAYS) * HOURS_PER_DAY,
});

export const durationArbitrary = fc.integer({ min: 1, max: MAX_TEST_DURATION_HOURS });

/** Unwraps a result, failing the property when it is an error. */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(JSON.stringify(result.error));
  }
  return result.value;
}
