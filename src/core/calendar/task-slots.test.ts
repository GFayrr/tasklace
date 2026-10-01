import { describe, expect, it } from 'vitest';
import { MAX_TASK_DURATION_HOURS } from '../limits';
import { at, compileOrThrow, format } from '../testing/civil-time';
import { END_PROJECT_HOUR } from '../time';
import { TEST_CALENDAR } from '../testing/test-calendar';
import { computeTaskSlots, type TaskPlacement, type TimeSlot } from './task-slots';

const calendar = compileOrThrow(TEST_CALENDAR);

/** Builds a task placement with full working days unless told otherwise. */
function placement(overrides: Partial<TaskPlacement>): TaskPlacement {
  return {
    start: at(2026, 9, 28, 9),
    durationHours: 7,
    hoursPerDay: null,
    dailyStartHour: null,
    ...overrides,
  };
}

/** Formats slots as "start → end" strings for readable assertions. */
function formatSlots(slots: readonly TimeSlot[]): string[] {
  return slots.map((slot) => `${format(slot.start)} → ${format(slot.end)}`);
}

/** Computes slots and formats them, failing the test on error. */
function slotsOf(overrides: Partial<TaskPlacement>): string[] {
  const result = computeTaskSlots(calendar, placement(overrides));
  if (!result.ok) {
    throw new Error(result.error);
  }
  return formatSlots(result.value);
}

describe('computeTaskSlots', () => {
  it('reproduces the example of the specification (10 h at 4 h/day from Tuesday 11:00)', () => {
    expect(slotsOf({ start: at(2026, 9, 29, 11), durationHours: 10, hoursPerDay: 4 })).toEqual([
      '2026-09-29 11:00 → 2026-09-29 12:00',
      '2026-09-29 13:00 → 2026-09-29 16:00',
      '2026-09-30 09:00 → 2026-09-30 12:00',
      '2026-09-30 13:00 → 2026-09-30 14:00',
      '2026-10-01 09:00 → 2026-10-01 11:00',
    ]);
  });

  it('fills whole working days by default', () => {
    expect(slotsOf({ durationHours: 14 })).toEqual([
      '2026-09-28 09:00 → 2026-09-28 12:00',
      '2026-09-28 13:00 → 2026-09-28 17:00',
      '2026-09-29 09:00 → 2026-09-29 12:00',
      '2026-09-29 13:00 → 2026-09-29 17:00',
    ]);
  });

  it('uses the daily start hour on following days', () => {
    expect(slotsOf({ durationHours: 5, hoursPerDay: 3, dailyStartHour: 14 })).toEqual([
      '2026-09-28 14:00 → 2026-09-28 17:00',
      '2026-09-29 14:00 → 2026-09-29 16:00',
    ]);
  });

  it('never starts before the daily start hour on the first day', () => {
    expect(
      slotsOf({ start: at(2026, 9, 28, 9), durationHours: 2, hoursPerDay: 2, dailyStartHour: 15 }),
    ).toEqual(['2026-09-28 15:00 → 2026-09-28 17:00']);
  });

  it('starts at the next working hour when placed on a non-working instant', () => {
    expect(slotsOf({ start: at(2026, 10, 3, 10), durationHours: 1 })).toEqual([
      '2026-10-05 09:00 → 2026-10-05 10:00',
    ]);
  });

  it('crosses weekends', () => {
    expect(slotsOf({ start: at(2026, 10, 2, 16), durationHours: 2 })).toEqual([
      '2026-10-02 16:00 → 2026-10-02 17:00',
      '2026-10-05 09:00 → 2026-10-05 10:00',
    ]);
  });

  it('returns no slot for a zero-hour task', () => {
    expect(slotsOf({ durationHours: 0 })).toEqual([]);
  });

  it('supports the maximum duration', () => {
    const result = computeTaskSlots(
      calendar,
      placement({ start: at(2026, 1, 1), durationHours: MAX_TASK_DURATION_HOURS, hoursPerDay: 7 }),
    );
    expect(result.ok && result.value.length).toBeGreaterThan(0);
  });

  it.each([-1, 0.3, Number.NaN, MAX_TASK_DURATION_HOURS + 1])(
    'rejects the invalid duration %d',
    (durationHours) => {
      expect(computeTaskSlots(calendar, placement({ durationHours }))).toEqual({
        ok: false,
        error: 'INVALID_DURATION',
      });
    },
  );

  it.each([0, -2, 2.3, 8, Number.NaN])('rejects %d hours per day', (hoursPerDay) => {
    expect(computeTaskSlots(calendar, placement({ hoursPerDay }))).toEqual({
      ok: false,
      error: 'INVALID_HOURS_PER_DAY',
    });
  });

  it.each([
    ['a negative hour', -1, 1],
    ['hour 24', 24, 1],
    ['a time that is not a whole quarter hour', 9.1, 1],
    ['an hour leaving too few working hours', 16, 2],
    ['an hour after the working day', 18, 1],
    ['an hour past the first working hour for a full-day task', 10, null],
  ])('rejects a daily start at %s', (_label, dailyStartHour, hoursPerDay) => {
    expect(computeTaskSlots(calendar, placement({ dailyStartHour, hoursPerDay }))).toEqual({
      ok: false,
      error: 'INVALID_DAILY_START_HOUR',
    });
  });

  it('rejects an invalid start instant', () => {
    expect(computeTaskSlots(calendar, placement({ start: Number.NaN }))).toEqual({
      ok: false,
      error: 'INVALID_INSTANT',
    });
  });

  it('fails when the task cannot start before the horizon', () => {
    expect(computeTaskSlots(calendar, placement({ start: END_PROJECT_HOUR - 1 }))).toEqual({
      ok: false,
      error: 'BEYOND_PLANNING_HORIZON',
    });
  });

  it('fails when the task cannot end before the horizon', () => {
    const result = computeTaskSlots(
      calendar,
      placement({ start: at(2200, 12, 30, 9), durationHours: 100 }),
    );
    expect(result).toEqual({ ok: false, error: 'BEYOND_PLANNING_HORIZON' });
  });
});
