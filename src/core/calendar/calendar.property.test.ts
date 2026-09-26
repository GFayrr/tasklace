import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { TimeRange, WorkingCalendar } from '../model/calendar';
import { compileOrThrow, dayOf } from '../testing/civil-time';
import { HOURS_PER_DAY, dayIndexOf, type Weekday } from '../time';
import type { CompiledCalendar } from './compile-calendar';
import { computeTaskSlots } from './task-slots';
import {
  addWorkingHours,
  countWorkingHours,
  nextWorkingHour,
  subtractWorkingHours,
} from './working-time';

const FIRST_TEST_DAY = dayOf(2026, 1, 1);
const MAX_TEST_DURATION_HOURS = 300;
const TEST_SPAN_DAYS = 400;

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

const calendarArbitrary: fc.Arbitrary<WorkingCalendar> = fc.record({
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

const instantArbitrary = fc.integer({
  min: FIRST_TEST_DAY * HOURS_PER_DAY,
  max: (FIRST_TEST_DAY + TEST_SPAN_DAYS) * HOURS_PER_DAY,
});

const durationArbitrary = fc.integer({ min: 1, max: MAX_TEST_DURATION_HOURS });

/** Tells whether the hour starting at an instant is a working hour of the calendar. */
function isWorkingHour(calendar: CompiledCalendar, instant: number): boolean {
  const result = countWorkingHours(calendar, instant, instant + 1);
  return result.ok && result.value === 1;
}

/** Unwraps a result, failing the property when it is an error. */
function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.value;
}

describe('calendar properties', () => {
  it('the next working hour is a working hour, never earlier, with nothing worked in between', () => {
    fc.assert(
      fc.property(calendarArbitrary, instantArbitrary, (calendarInput, instant) => {
        const calendar = compileOrThrow(calendarInput);
        const next = unwrap(nextWorkingHour(calendar, instant));
        expect(next).toBeGreaterThanOrEqual(instant);
        expect(isWorkingHour(calendar, next)).toBe(true);
        expect(unwrap(countWorkingHours(calendar, instant, next))).toBe(0);
      }),
    );
  });

  it('adding then counting working hours gives back the same number of hours', () => {
    fc.assert(
      fc.property(
        calendarArbitrary,
        instantArbitrary,
        durationArbitrary,
        (calendarInput, from, hours) => {
          const calendar = compileOrThrow(calendarInput);
          const end = unwrap(addWorkingHours(calendar, from, hours));
          expect(unwrap(countWorkingHours(calendar, from, end))).toBe(hours);
          expect(isWorkingHour(calendar, end - 1)).toBe(true);
        },
      ),
    );
  });

  it('subtracting what was added leads back to the next working hour', () => {
    fc.assert(
      fc.property(
        calendarArbitrary,
        instantArbitrary,
        durationArbitrary,
        (calendarInput, from, hours) => {
          const calendar = compileOrThrow(calendarInput);
          const end = unwrap(addWorkingHours(calendar, from, hours));
          const start = unwrap(subtractWorkingHours(calendar, end, hours));
          expect(start).toBe(unwrap(nextWorkingHour(calendar, from)));
        },
      ),
    );
  });

  it('task slots only cover working hours, sum to the duration and respect the hours per day', () => {
    fc.assert(
      fc.property(
        calendarArbitrary,
        instantArbitrary,
        durationArbitrary,
        fc.integer({ min: 1, max: HOURS_PER_DAY }),
        (calendarInput, start, durationHours, requestedHoursPerDay) => {
          const calendar = compileOrThrow(calendarInput);
          const hoursPerDay = Math.min(requestedHoursPerDay, calendar.workingHoursOfDay.length);
          const slots = unwrap(
            computeTaskSlots(calendar, { start, durationHours, hoursPerDay, dailyStartHour: null }),
          );
          const hours = slots.flatMap((slot) =>
            Array.from({ length: slot.end - slot.start }, (_value, offset) => slot.start + offset),
          );
          expect(hours).toHaveLength(durationHours);
          expect(hours.every((hour) => isWorkingHour(calendar, hour))).toBe(true);
          expect(
            hours.every((hour, index) => index === 0 || hour > (hours[index - 1] ?? hour)),
          ).toBe(true);
          const hoursByDay = new Map<number, number>();
          hours.forEach((hour) =>
            hoursByDay.set(dayIndexOf(hour), (hoursByDay.get(dayIndexOf(hour)) ?? 0) + 1),
          );
          expect([...hoursByDay.values()].every((count) => count <= hoursPerDay)).toBe(true);
        },
      ),
    );
  });

  it('a full-day task ends exactly where adding its duration in working hours ends', () => {
    fc.assert(
      fc.property(
        calendarArbitrary,
        instantArbitrary,
        durationArbitrary,
        (calendarInput, start, durationHours) => {
          const calendar = compileOrThrow(calendarInput);
          const slots = unwrap(
            computeTaskSlots(calendar, {
              start,
              durationHours,
              hoursPerDay: null,
              dailyStartHour: null,
            }),
          );
          expect(slots.at(-1)?.end).toBe(unwrap(addWorkingHours(calendar, start, durationHours)));
        },
      ),
    );
  });
});
