import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compileCalendar } from '../calendar/compile-calendar';
import { countWorkingHours } from '../calendar/working-time';
import {
  calendarArbitrary,
  instantArbitrary,
  PROPERTY_TEST_TIMEOUT_MS,
  unwrap,
} from '../testing/arbitraries';
import { at, compileOrThrow } from '../testing/civil-time';
import { TEST_CALENDAR } from '../testing/test-calendar';
import { END_PROJECT_HOUR } from '../time';
import { endVarianceDays } from './end-variance';

const CALENDAR = compileOrThrow(TEST_CALENDAR);
const FROZEN = at(2026, 9, 28, 17);

describe('endVarianceDays', () => {
  it.each([
    ['two working days late', at(2026, 9, 30, 17), 2],
    ['the same end', FROZEN, 0],
    ['one working day early across a weekend', at(2026, 9, 25, 17), -1],
    ['an hour late, rounded up to a quarter of a 7-hour day', at(2026, 9, 29, 10), 0.25],
    ['three hours late across a night', at(2026, 9, 29, 12), 0.5],
  ])('counts %s', (_label, end, days) => {
    expect(endVarianceDays(CALENDAR, FROZEN, end)).toEqual({ ok: true, value: days });
  });

  it('shows any gap of working time as at least a quarter of a day, with its sign', () => {
    expect(endVarianceDays(CALENDAR, FROZEN, at(2026, 9, 28, 16) + 0.75)).toEqual({
      ok: true,
      value: -0.25,
    });
    expect(endVarianceDays(CALENDAR, FROZEN, at(2026, 9, 29, 9) + 0.25)).toEqual({
      ok: true,
      value: 0.25,
    });
  });

  it('ignores the hours outside the working time', () => {
    expect(endVarianceDays(CALENDAR, FROZEN, at(2026, 9, 29, 8))).toEqual({ ok: true, value: 0 });
    expect(endVarianceDays(CALENDAR, at(2026, 10, 3, 12), at(2026, 10, 5, 9))).toEqual({
      ok: true,
      value: 0,
    });
  });

  it('refuses an end outside the supported years', () => {
    expect(endVarianceDays(CALENDAR, FROZEN, END_PROJECT_HOUR + 1)).toEqual({
      ok: false,
      error: 'INVALID_INSTANT',
    });
    expect(endVarianceDays(CALENDAR, END_PROJECT_HOUR + 1, FROZEN)).toEqual({
      ok: false,
      error: 'INVALID_INSTANT',
    });
  });
});

describe('endVarianceDays on any calendar', () => {
  const pairs = fc.record({
    calendar: calendarArbitrary,
    first: instantArbitrary,
    second: instantArbitrary,
    third: instantArbitrary,
  });

  it(
    'is the opposite when the two ends swap, follows the working hours and never shrinks a gap to zero',
    { timeout: PROPERTY_TEST_TIMEOUT_MS },
    () => {
      fc.assert(
        fc.property(pairs, ({ calendar: input, first, second, third }) => {
          const compiled = compileCalendar(input);
          fc.pre(compiled.ok);
          const calendar = unwrap(compiled);
          const forward = unwrap(endVarianceDays(calendar, first, second));
          const backward = unwrap(endVarianceDays(calendar, second, first));
          expect(Object.is(backward, forward === 0 ? 0 : -forward)).toBe(true);
          const [low, high] = first <= second ? [first, second] : [second, first];
          const hours = unwrap(countWorkingHours(calendar, low, high));
          const magnitude = Math.abs(forward);
          expect(magnitude === 0).toBe(hours === 0);
          if (hours > 0) {
            const exact = hours / calendar.workingHoursPerDay;
            expect(magnitude).toBe(Math.max(Math.round(exact * 4), 1) / 4);
          }
          const [near, far] = second <= third ? [second, third] : [third, second];
          expect(unwrap(endVarianceDays(calendar, first, far))).toBeGreaterThanOrEqual(
            unwrap(endVarianceDays(calendar, first, near)),
          );
        }),
      );
    },
  );
});
