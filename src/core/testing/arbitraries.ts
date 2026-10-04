import fc from 'fast-check';
import type { Result } from '../result';
import type { TimeRange, WorkingCalendar } from '../model/calendar';
import {
  fromQuarters,
  HOURS_PER_DAY,
  QUARTER_HOUR,
  QUARTERS_PER_DAY,
  toQuarters,
  type Weekday,
} from '../time';
import { dayOf } from './civil-time';

export const PROPERTY_TEST_TIMEOUT_MS = 30_000;

/** Generates any order of a list, each item kept once. */
export function permutationOf<T>(items: readonly T[]): fc.Arbitrary<T[]> {
  return fc.shuffledSubarray([...items], { minLength: items.length, maxLength: items.length });
}
export const CONVERGENCE_TEST_TIMEOUT_MS = 120_000;

export const FIRST_TEST_DAY = dayOf(2026, 1, 1);
const MAX_TEST_DURATION_HOURS = 300;
export const TEST_SPAN_DAYS = 400;

/** Turns a set of quarter hours of the day into the smallest list of continuous ranges. */
function quartersToRanges(quarters: readonly number[]): TimeRange[] {
  const ranges: TimeRange[] = [];
  for (const quarter of [...quarters].sort((left, right) => left - right)) {
    const start = fromQuarters(quarter);
    const last = ranges.at(-1);
    if (last?.endHour === start) {
      ranges[ranges.length - 1] = { startHour: last.startHour, endHour: start + QUARTER_HOUR };
    } else {
      ranges.push({ startHour: start, endHour: start + QUARTER_HOUR });
    }
  }
  return ranges;
}

/** Generates numbers of hours made of whole quarter hours between two bounds. */
export function quarterHoursArbitrary(min: number, max: number): fc.Arbitrary<number> {
  return fc
    .integer({ min: toQuarters(min), max: toQuarters(max) })
    .map((quarters) => fromQuarters(quarters));
}

export const calendarArbitrary: fc.Arbitrary<WorkingCalendar> = fc.record({
  workingWeekdays: fc
    .uniqueArray(fc.integer({ min: 0, max: 6 }), { minLength: 1, maxLength: 7 })
    .map((weekdays) => weekdays as Weekday[]),
  workingTimeRanges: fc
    .uniqueArray(fc.integer({ min: 0, max: QUARTERS_PER_DAY - 1 }), {
      minLength: 1,
      maxLength: QUARTERS_PER_DAY,
    })
    .map(quartersToRanges),
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

export const instantArbitrary = quarterHoursArbitrary(
  FIRST_TEST_DAY * HOURS_PER_DAY,
  (FIRST_TEST_DAY + TEST_SPAN_DAYS) * HOURS_PER_DAY,
);

export const durationArbitrary = quarterHoursArbitrary(QUARTER_HOUR, MAX_TEST_DURATION_HOURS);

/** Unwraps a result, failing the property when it is an error. */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(JSON.stringify(result.error));
  }
  return result.value;
}
