import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  PROPERTY_TEST_TIMEOUT_MS,
  calendarArbitrary,
  durationArbitrary,
  instantArbitrary,
  unwrap,
} from '../testing/arbitraries';
import { compileOrThrow } from '../testing/civil-time';
import {
  END_PROJECT_HOUR,
  HOURS_PER_DAY,
  MAX_DAY_INDEX,
  MIN_DAY_INDEX,
  dayIndexOf,
  weekdayOf,
  QUARTER_HOUR,
  fromQuarters,
  toQuarters,
} from '../time';
import type { CompiledCalendar } from './compile-calendar';
import { computeSegmentBounds, computeTaskSlots } from './task-slots';
import {
  addWorkingHours,
  countWorkingHours,
  isWorkingDay,
  nextWorkingHour,
  subtractWorkingHours,
} from './working-time';

/** Tells whether the quarter hour starting at an instant is worked in the calendar. */
function isWorkingHour(calendar: CompiledCalendar, instant: number): boolean {
  const result = countWorkingHours(calendar, instant, instant + QUARTER_HOUR);
  return result.ok && result.value === QUARTER_HOUR;
}

describe('calendar properties', { timeout: PROPERTY_TEST_TIMEOUT_MS }, () => {
  it('marks exactly the worked weekdays outside non-working periods as working days', () => {
    fc.assert(
      fc.property(
        calendarArbitrary,
        fc.array(fc.integer({ min: MIN_DAY_INDEX, max: MAX_DAY_INDEX }), { maxLength: 50 }),
        (calendarInput, randomDays) => {
          const calendar = compileOrThrow(calendarInput);
          const periodEdges = calendarInput.nonWorkingPeriods.flatMap((period) => [
            period.firstDay - 1,
            period.firstDay,
            period.lastDay,
            period.lastDay + 1,
          ]);
          const edges = [MIN_DAY_INDEX, MIN_DAY_INDEX + 6, MAX_DAY_INDEX - 6, MAX_DAY_INDEX];
          const days = [...edges, ...periodEdges, ...randomDays];
          for (const day of days) {
            const expected =
              calendarInput.workingWeekdays.includes(weekdayOf(day)) &&
              !calendarInput.nonWorkingPeriods.some(
                (period) => period.firstDay <= day && day <= period.lastDay,
              );
            expect(isWorkingDay(calendar, day)).toBe(expected);
          }
        },
      ),
    );
  });

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
          expect(isWorkingHour(calendar, end - QUARTER_HOUR)).toBe(true);
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
          const hoursPerDay =
            calendar.workingHoursPerDay < 1
              ? null
              : Math.min(requestedHoursPerDay, calendar.workingHoursPerDay);
          const slots = unwrap(
            computeTaskSlots(calendar, { start, durationHours, hoursPerDay, dailyStartHour: null }),
          );
          const hours = slots.flatMap((slot) =>
            Array.from(
              { length: toQuarters(slot.end - slot.start) },
              (_value, offset) => slot.start + fromQuarters(offset),
            ),
          );
          expect(hours).toHaveLength(toQuarters(durationHours));
          expect(hours.every((hour) => isWorkingHour(calendar, hour))).toBe(true);
          expect(
            hours.every((hour, index) => index === 0 || hour > (hours[index - 1] ?? hour)),
          ).toBe(true);
          const hoursByDay = new Map<number, number>();
          hours.forEach((hour) =>
            hoursByDay.set(dayIndexOf(hour), (hoursByDay.get(dayIndexOf(hour)) ?? 0) + 1),
          );
          const dailyLimit = toQuarters(hoursPerDay ?? calendar.workingHoursPerDay);
          expect([...hoursByDay.values()].every((count) => count <= dailyLimit)).toBe(true);
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

  it('computes the bounds of a block directly exactly like its first and last slots, errors included', () => {
    const startArbitrary = fc.oneof(
      instantArbitrary,
      fc.integer({ min: END_PROJECT_HOUR - HOURS_PER_DAY * 30, max: END_PROJECT_HOUR - 1 }),
    );
    fc.assert(
      fc.property(
        calendarArbitrary,
        startArbitrary,
        fc.oneof(durationArbitrary, fc.integer({ min: 1, max: 5_000 })),
        fc.option(fc.integer({ min: 1, max: HOURS_PER_DAY })),
        fc.option(fc.integer({ min: 0, max: HOURS_PER_DAY - 1 })),
        (calendarInput, start, durationHours, hoursPerDay, dailyStartHour) => {
          const calendar = compileOrThrow(calendarInput);
          const placement = { start, durationHours, hoursPerDay, dailyStartHour };
          const slots = computeTaskSlots(calendar, placement);
          const bounds = computeSegmentBounds(calendar, placement);
          const first = slots.ok ? slots.value[0] : undefined;
          const last = slots.ok ? slots.value.at(-1) : undefined;
          expect(bounds).toEqual(
            slots.ok ? { ok: true, value: { start: first?.start, end: last?.end } } : slots,
          );
        },
      ),
    );
  });
});
