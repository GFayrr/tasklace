import { describe, expect, it } from 'vitest';
import { TEST_CALENDAR } from '../testing/test-calendar';
import { MAX_SEGMENTS_PER_TASK, MAX_SEGMENT_GAP_DAYS } from '../limits';
import type { SchedulableTask } from '../model/project';
import { at, compileOrThrow, format } from '../testing/civil-time';
import { milestone, splitTask, workTask } from '../testing/project-builder';
import { END_PROJECT_HOUR } from '../time';
import {
  placeTask,
  placeTaskEarliest,
  placeTaskLatest,
  type Placement,
  type PlacementErrorCode,
  computePlacementSlots,
} from './task-placement';
import type { Result } from '../result';

const calendar = compileOrThrow(TEST_CALENDAR);
const MONDAY_9 = at(2026, 9, 28, 9);

/** Describes a placement as its blocks, each written "start → end", or returns its error code. */
function describePlacement(result: Result<Placement, PlacementErrorCode>): string[] | string {
  if (!result.ok) {
    return result.error;
  }
  return result.value.segments.map(
    (segment) => `${format(segment.start)} → ${format(segment.end)}`,
  );
}

/** Places a task from an instant and describes the result. */
function place(task: SchedulableTask, start = MONDAY_9): string[] | string {
  return describePlacement(placeTask(calendar, task, start));
}

describe('placeTask', () => {
  it('places a milestone exactly at the given instant, even outside working hours', () => {
    const result = placeTask(calendar, milestone('m'), at(2026, 10, 3, 20));
    expect(result).toEqual({
      ok: true,
      value: { start: at(2026, 10, 3, 20), end: at(2026, 10, 3, 20), segments: [] },
    });
  });

  it('places a one-block task like its time slots', () => {
    expect(place(workTask('a', { segments: [{ durationHours: 10, gapDaysBefore: 0 }] }))).toEqual([
      '2026-09-28 09:00 → 2026-09-29 12:00',
    ]);
  });

  it('resumes the second block the given number of days after the first one ends', () => {
    expect(
      place(
        splitTask('a', [
          [7, 0],
          [7, 21],
        ]),
      ),
    ).toEqual(['2026-09-28 09:00 → 2026-09-28 17:00', '2026-10-19 09:00 → 2026-10-19 17:00']);
  });

  it('counts the gap from the last day of a block that spans several days', () => {
    expect(
      place(
        splitTask('a', [
          [10, 0],
          [2, 1],
        ]),
      ),
    ).toEqual(['2026-09-28 09:00 → 2026-09-29 12:00', '2026-09-30 09:00 → 2026-09-30 11:00']);
  });

  it('moves a block landing on a weekend to the next working hour', () => {
    expect(
      place(
        splitTask('a', [
          [7, 0],
          [1, 5],
        ]),
      ),
    ).toEqual(['2026-09-28 09:00 → 2026-09-28 17:00', '2026-10-05 09:00 → 2026-10-05 10:00']);
  });

  it('applies the hours per day of the task to every block', () => {
    const task = splitTask(
      'a',
      [
        [4, 0],
        [4, 7],
      ],
      { hoursPerDay: 2 },
    );
    const placed = placeTask(calendar, task, MONDAY_9);
    const slots = placed.ok ? computePlacementSlots(calendar, task, placed.value) : placed;
    expect(slots.ok && slots.value.map((blockSlots) => blockSlots.length)).toEqual([2, 2]);
    expect(place(task)).toEqual([
      '2026-09-28 09:00 → 2026-09-29 11:00',
      '2026-10-06 09:00 → 2026-10-07 11:00',
    ]);
  });

  it('accepts the maximum number of blocks and the maximum gap', () => {
    const blocks = Array.from(
      { length: MAX_SEGMENTS_PER_TASK },
      (_value, index): [number, number] => [1, index === 0 ? 0 : 1],
    );
    expect(placeTask(calendar, splitTask('a', blocks), MONDAY_9).ok).toBe(true);
    expect(
      placeTask(
        calendar,
        splitTask('b', [
          [1, 0],
          [1, MAX_SEGMENT_GAP_DAYS],
        ]),
        MONDAY_9,
      ).ok,
    ).toBe(true);
  });

  it.each<[string, readonly [number, number][]]>([
    ['no block', []],
    ['a gap before the first block', [[7, 1]]],
    [
      'a zero gap between blocks',
      [
        [7, 0],
        [7, 0],
      ],
    ],
    [
      'a negative gap',
      [
        [7, 0],
        [7, -3],
      ],
    ],
    [
      'a fractional gap',
      [
        [7, 0],
        [7, 1.5],
      ],
    ],
    [
      'a gap above the maximum',
      [
        [7, 0],
        [7, MAX_SEGMENT_GAP_DAYS + 1],
      ],
    ],
    ['a zero-hour block', [[0, 0]]],
    ['a negative block', [[-4, 0]]],
    ['a block that is not a whole quarter hour', [[1.3, 0]]],
    ['a NaN block', [[Number.NaN, 0]]],
    [
      'too many blocks',
      Array.from({ length: MAX_SEGMENTS_PER_TASK + 1 }, (_value, index): [number, number] => [
        1,
        index === 0 ? 0 : 1,
      ]),
    ],
  ])('rejects %s', (_label, blocks) => {
    expect(place(splitTask('a', blocks))).toBe('INVALID_SEGMENTS');
  });

  it('reports invalid hours per day and invalid start instants', () => {
    expect(place(workTask('a', { hoursPerDay: 9 }))).toBe('INVALID_HOURS_PER_DAY');
    expect(place(workTask('a'), Number.NaN)).toBe('INVALID_INSTANT');
    expect(place(milestone('m'), END_PROJECT_HOUR)).toBe('INVALID_INSTANT');
  });

  it('fails when a later block would start past the horizon', () => {
    const task = splitTask('a', [
      [1, 0],
      [1, MAX_SEGMENT_GAP_DAYS],
    ]);
    expect(place(task, at(2200, 6, 1, 9))).toBe('BEYOND_PLANNING_HORIZON');
  });

  it('fails when a later block would end past the horizon', () => {
    const task = splitTask('a', [
      [1, 0],
      [100, 1],
    ]);
    expect(place(task, at(2200, 12, 29, 9))).toBe('BEYOND_PLANNING_HORIZON');
  });
});

describe('placeTaskEarliest', () => {
  const threeHours = workTask('a', { segments: [{ durationHours: 3, gapDaysBefore: 0 }] });

  it('keeps the earliest placement when it already ends late enough', () => {
    const result = placeTaskEarliest(calendar, threeHours, MONDAY_9, at(2026, 9, 28, 10));
    expect(describePlacement(result)).toEqual(['2026-09-28 09:00 → 2026-09-28 12:00']);
  });

  it('delays a task until it ends no earlier than the end bound', () => {
    const result = placeTaskEarliest(calendar, threeHours, MONDAY_9, at(2026, 9, 28, 17));
    expect(describePlacement(result)).toEqual(['2026-09-28 14:00 → 2026-09-28 17:00']);
  });

  it('places a milestone on its end bound', () => {
    const result = placeTaskEarliest(calendar, milestone('m'), MONDAY_9, at(2026, 9, 29, 12));
    expect(result.ok && format(result.value.start)).toBe('2026-09-29 12:00');
  });

  it('propagates placement errors', () => {
    const result = placeTaskEarliest(calendar, threeHours, Number.NaN, MONDAY_9);
    expect(result).toEqual({ ok: false, error: 'INVALID_INSTANT' });
  });

  it('computes the start of a continuously worked task directly from its end bound', () => {
    const result = placeTaskEarliest(
      calendar,
      threeHours,
      at(2200, 12, 31, 9),
      END_PROJECT_HOUR - 1,
    );
    expect(describePlacement(result)).toEqual(['2200-12-31 14:00 → 2200-12-31 17:00']);
  });

  it('propagates errors met while searching', () => {
    const oneHourPerDay = workTask('a', {
      segments: [{ durationHours: 2, gapDaysBefore: 0 }],
      hoursPerDay: 1,
    });
    const result = placeTaskEarliest(
      calendar,
      oneHourPerDay,
      at(2200, 12, 30, 9),
      END_PROJECT_HOUR - 1,
    );
    expect(result).toEqual({ ok: false, error: 'BEYOND_PLANNING_HORIZON' });
  });
});

describe('placeTaskLatest', () => {
  const threeHours = workTask('a', { segments: [{ durationHours: 3, gapDaysBefore: 0 }] });

  it('ends a task at the last working hour before the end bound', () => {
    const tuesday9 = at(2026, 9, 29, 9);
    const result = placeTaskLatest(calendar, threeHours, tuesday9, tuesday9);
    expect(describePlacement(result)).toEqual(['2026-09-28 14:00 → 2026-09-28 17:00']);
  });

  it('respects a latest start earlier than what the end bound allows', () => {
    const result = placeTaskLatest(calendar, threeHours, at(2026, 9, 28, 10), at(2026, 9, 29, 17));
    expect(describePlacement(result)).toEqual(['2026-09-28 10:00 → 2026-09-28 14:00']);
  });

  it('places a milestone on the earlier of its two bounds', () => {
    const result = placeTaskLatest(calendar, milestone('m'), at(2026, 9, 30), at(2026, 9, 29));
    expect(result.ok && format(result.value.start)).toBe('2026-09-29 00:00');
  });

  it('propagates errors met while searching', () => {
    const result = placeTaskLatest(calendar, workTask('a', { hoursPerDay: 0 }), MONDAY_9, MONDAY_9);
    expect(result).toEqual({ ok: false, error: 'INVALID_HOURS_PER_DAY' });
  });
});
