import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  calendarArbitrary,
  durationArbitrary,
  instantArbitrary,
  unwrap,
} from '../testing/arbitraries';
import { compileOrThrow } from '../testing/civil-time';
import { HOURS_PER_DAY, dayIndexOf } from '../time';
import type { CompiledCalendar } from './compile-calendar';
import { computeTaskSlots } from './task-slots';
import {
  addWorkingHours,
  countWorkingHours,
  nextWorkingHour,
  subtractWorkingHours,
} from './working-time';

/** Tells whether the hour starting at an instant is a working hour of the calendar. */
function isWorkingHour(calendar: CompiledCalendar, instant: number): boolean {
  const result = countWorkingHours(calendar, instant, instant + 1);
  return result.ok && result.value === 1;
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
