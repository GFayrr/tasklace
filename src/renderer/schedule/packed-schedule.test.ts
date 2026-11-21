import { describe, expect, it } from 'vitest';
import { MAX_SEGMENTS_PER_TASK } from '../../core/limits';
import type { TaskId } from '../../core/model/project';
import type { TaskFloat } from '../../core/scheduling/backward-pass';
import type { Placement } from '../../core/scheduling/task-placement';
import type { TagConflict } from '../../core/tags/tag-conflicts';
import {
  milestone,
  project,
  scheduleOrThrow,
  splitTask,
  testId,
  workTask,
} from '../../core/testing/project-builder';
import { END_PROJECT_HOUR, MIN_PROJECT_HOUR } from '../../core/time';
import {
  differOnlyByTimes,
  packedBuffers,
  packFloats,
  packPlacements,
  packTimes,
  unpackFloats,
  unpackPlacements,
  withTimes,
  type PackedEntries,
} from './packed-schedule';

const PLAN = project([
  workTask('a'),
  splitTask('b', [
    [3, 0],
    [2, 1],
  ]),
  milestone('m'),
]);
const HOUR = MIN_PROJECT_HOUR + 24;
const KNOWN: TaskFloat = {
  lateStart: HOUR,
  lateFinish: HOUR + 8,
  totalFloatHours: -1.25,
  freeFloatHours: 0,
  isCritical: true,
};
const SLACK: TaskFloat = { ...KNOWN, totalFloatHours: 4, freeFloatHours: 2.5, isCritical: false };
const UNKNOWN: TaskFloat = {
  lateStart: null,
  lateFinish: null,
  totalFloatHours: null,
  freeFloatHours: null,
  isCritical: true,
};
const CONFLICT: TagConflict = {
  tagId: testId('alice'),
  start: HOUR,
  end: HOUR + 2,
  taskIds: [testId('a'), testId('b')],
};

/** Writes packed entries by hand, as a worker of this application never would. */
function packed(
  ids: readonly unknown[],
  numbers: readonly number[],
  removed: readonly unknown[] = [],
) {
  return { ids, numbers: Float64Array.from(numbers), removed } as PackedEntries;
}

/** Reads packed placements into a new table, giving the error it throws. */
function placementsRefusal(entries: PackedEntries): unknown {
  try {
    unpackPlacements(entries, new Map());
  } catch (error) {
    return error;
  }
  return null;
}

describe('packed placements', () => {
  it('reads back the placements written, blocks and milestones included, and removes the identifiers removed', () => {
    const placements = [...scheduleOrThrow(PLAN).placements];
    const table = new Map<TaskId, Placement>([
      [testId('gone'), { start: HOUR, end: HOUR, segments: [] }],
    ]);
    const entries = packPlacements(placements, [testId('gone')]);
    expect(entries.ids).toEqual([testId('a'), testId('b'), testId('m')]);
    expect(entries.numbers).toHaveLength(3 + 2 + (3 + 4) + 3);
    unpackPlacements(structuredClone(entries), table);
    expect(table).toEqual(new Map(placements));
  });

  it.each([
    [
      'ends too soon',
      packed([testId('a')], [HOUR, HOUR]),
      'The schedule worker sent a packed list that ends too soon.',
    ],
    [
      'is longer than its entries',
      packed([testId('a')], [HOUR, HOUR, 0, HOUR]),
      'The schedule worker sent a packed list longer than its entries.',
    ],
    [
      'holds a time that is not whole quarter hours',
      packed([testId('a')], [HOUR + 0.1, HOUR, 0]),
      `The schedule worker sent ${String(HOUR + 0.1)}, which is not a number of hours.`,
    ],
    [
      'holds an hour before the years handled',
      packed([testId('a')], [MIN_PROJECT_HOUR - 1, HOUR, 0]),
      `The schedule worker sent the hour ${String(MIN_PROJECT_HOUR - 1)}, outside the years handled.`,
    ],
    [
      'holds an hour after the years handled',
      packed([testId('a')], [HOUR, END_PROJECT_HOUR + 1, 0]),
      `The schedule worker sent the hour ${String(END_PROJECT_HOUR + 1)}, outside the years handled.`,
    ],
    [
      'counts more blocks than a task may have',
      packed([testId('a')], [HOUR, HOUR, MAX_SEGMENTS_PER_TASK + 1]),
      `The schedule worker sent the count ${String(MAX_SEGMENTS_PER_TASK + 1)}, outside 0 to ${String(MAX_SEGMENTS_PER_TASK)}.`,
    ],
    [
      'counts blocks below none',
      packed([testId('a')], [HOUR, HOUR, -1]),
      `The schedule worker sent the count -1, outside 0 to ${String(MAX_SEGMENTS_PER_TASK)}.`,
    ],
    [
      'counts part of a block',
      packed([testId('a')], [HOUR, HOUR, 0.5]),
      `The schedule worker sent the count 0.5, outside 0 to ${String(MAX_SEGMENTS_PER_TASK)}.`,
    ],
    [
      'puts a value that is not a task identifier',
      packed(['not an id'], [HOUR, HOUR, 0]),
      'The schedule worker sent a value that is not a task identifier.',
    ],
    [
      'removes a value that is not a task identifier',
      packed([], [], [7]),
      'The schedule worker sent a value that is not a task identifier.',
    ],
  ])('refuses a list that %s', (_case, entries, message) => {
    expect(placementsRefusal(entries)).toEqual(new Error(message));
  });
});

describe('packed floats', () => {
  it('reads back known, critical and unknown floats, and removes the identifiers removed', () => {
    const floats: readonly (readonly [TaskId, TaskFloat])[] = [
      [testId('a'), KNOWN],
      [testId('b'), SLACK],
      [testId('c'), UNKNOWN],
    ];
    const entries = packFloats(floats, [testId('gone')]);
    expect(entries.numbers).toHaveLength(6 + 6 + 1);
    const table = new Map<TaskId, TaskFloat>([[testId('gone'), KNOWN]]);
    unpackFloats(structuredClone(entries), table);
    expect(table).toEqual(new Map(floats));
  });

  it('refuses a mark that is neither an unknown nor a known float, and a list too long', () => {
    expect(() => {
      unpackFloats(packed([testId('a')], [2]), new Map());
    }).toThrow('The schedule worker sent the count 2, outside 0 to 1.');
    expect(() => {
      unpackFloats(packed([testId('a')], [0, 0]), new Map());
    }).toThrow('The schedule worker sent a packed list longer than its entries.');
  });
});

describe('packed times of conflicts', () => {
  it('tells conflicts that differ only by their times from those whose tag or tasks changed', () => {
    const moved = { ...CONFLICT, start: HOUR + 1, end: HOUR + 3 };
    expect([
      differOnlyByTimes(CONFLICT, moved),
      differOnlyByTimes(CONFLICT, { ...moved, tagId: testId('bob') }),
      differOnlyByTimes(CONFLICT, { ...moved, taskIds: [testId('a')] }),
      differOnlyByTimes(CONFLICT, { ...moved, taskIds: [testId('a'), testId('c')] }),
    ]).toEqual([true, false, false, false]);
  });

  it('gives the conflicts their new times, in order, and refuses times for another number of conflicts', () => {
    const later = { ...CONFLICT, tagId: testId('bob'), start: HOUR + 4, end: HOUR + 6 };
    const times = packTimes([CONFLICT, later]);
    expect(withTimes([later, CONFLICT], structuredClone(times))).toEqual([
      { ...later, start: CONFLICT.start, end: CONFLICT.end },
      { ...CONFLICT, start: later.start, end: later.end },
    ]);
    expect(() => withTimes([CONFLICT], times)).toThrow(
      'The schedule worker sent the times of another number of conflicts.',
    );
    expect(() => withTimes([CONFLICT], Float64Array.from([HOUR, 0.3]))).toThrow(
      'The schedule worker sent 0.3, which is not a number of hours.',
    );
  });
});

describe('packedBuffers', () => {
  it('lists the buffer of each packed list given, leaving out the parts without one', () => {
    const first = new Float64Array(2);
    const second = new Float64Array(0);
    expect(packedBuffers([first, null, second])).toEqual([first.buffer, second.buffer]);
  });
});
