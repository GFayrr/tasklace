import { describe, expect, it } from 'vitest';
import { MAX_TAGS } from '../limits';
import type { Dependency, Tag, Task, WorkTask } from '../model/project';
import { analyzeProjectStructure } from '../scheduling/project-structure';
import { at, format } from '../testing/civil-time';
import {
  link,
  milestone,
  project,
  scheduleOrThrow,
  splitTask,
  workTask,
} from '../testing/project-builder';
import type { TagConflict } from './tag-conflicts';

const ALICE: Tag = { id: 'alice', name: 'Alice', color: '#2a78d6', representsPersonOrTeam: true };
const BOB: Tag = { id: 'bob', name: 'Bob', color: '#eb6834', representsPersonOrTeam: true };
const DESIGN: Tag = {
  id: 'design',
  name: 'Design',
  color: '#1baf7a',
  representsPersonOrTeam: false,
};
const TAGS = [ALICE, BOB, DESIGN];

/** Builds a work task of a given duration with a tag and optional overrides. */
function tagged(
  id: string,
  tagId: string,
  durationHours: number,
  overrides: Partial<WorkTask> = {},
): Task {
  return workTask(id, { segments: [{ durationHours, gapDaysBefore: 0 }], tagId, ...overrides });
}

/** Describes a conflict as "tag start → end tasks" for readable assertions. */
function describeConflict(conflict: TagConflict): string {
  const tasks = conflict.taskIds.join(',');
  return `${conflict.tagId} ${format(conflict.start)} → ${format(conflict.end)} ${tasks}`;
}

/** Schedules tasks with the test tags and describes each conflict found. */
function conflictsOf(tasks: readonly Task[], dependencies: readonly Dependency[] = []): string[] {
  const schedule = scheduleOrThrow(project(tasks, dependencies, { tags: TAGS }));
  return schedule.tagConflicts.conflicts.map(describeConflict);
}

describe('detectTagConflicts', () => {
  it('reports two tasks of the same person running at the same time, across the lunch break', () => {
    expect(conflictsOf([tagged('a', 'alice', 7), tagged('b', 'alice', 7)])).toEqual([
      'alice 2026-09-28 09:00 → 2026-09-28 17:00 a,b',
    ]);
  });

  it('merges a conflict over nights and weekends into one period', () => {
    expect(conflictsOf([tagged('a', 'alice', 42), tagged('b', 'alice', 42)])).toEqual([
      'alice 2026-09-28 09:00 → 2026-10-05 17:00 a,b',
    ]);
  });

  it('groups every task involved in one continuous conflict', () => {
    const tasks = [
      tagged('a', 'alice', 14),
      tagged('b', 'alice', 7, { startNoEarlierThan: at(2026, 9, 29, 9) }),
      tagged('c', 'alice', 7, { startNoEarlierThan: at(2026, 9, 29, 13) }),
    ];
    expect(conflictsOf(tasks)).toEqual(['alice 2026-09-29 09:00 → 2026-09-29 17:00 a,b,c']);
  });

  it('keeps separate conflicts when working time separates them', () => {
    const tasks = [
      tagged('a', 'alice', 2),
      tagged('b', 'alice', 2),
      tagged('c', 'alice', 1, { startNoEarlierThan: at(2026, 9, 28, 15) }),
      tagged('d', 'alice', 1, { startNoEarlierThan: at(2026, 9, 28, 15) }),
    ];
    expect(conflictsOf(tasks)).toEqual([
      'alice 2026-09-28 09:00 → 2026-09-28 11:00 a,b',
      'alice 2026-09-28 15:00 → 2026-09-28 16:00 c,d',
    ]);
  });

  it('ignores tasks that follow each other exactly', () => {
    expect(
      conflictsOf([tagged('a', 'alice', 7), tagged('b', 'alice', 7)], [link('a', 'b')]),
    ).toEqual([]);
  });

  it('ignores category tags, different people and tasks without tags', () => {
    const tasks = [
      tagged('a', 'design', 7),
      tagged('b', 'design', 7),
      tagged('c', 'alice', 7),
      tagged('d', 'bob', 7),
      workTask('e'),
    ];
    expect(conflictsOf(tasks)).toEqual([]);
  });

  it('never reports milestones, which take no time', () => {
    const tasks = [
      tagged('a', 'alice', 7),
      milestone('m', { tagId: 'alice', startNoEarlierThan: at(2026, 9, 28, 11) }),
    ];
    expect(conflictsOf(tasks)).toEqual([]);
  });

  it('lets another task of the same person fit in the gap of a split task', () => {
    const tasks = [
      splitTask(
        'a',
        [
          [7, 0],
          [7, 14],
        ],
        { tagId: 'alice' },
      ),
      tagged('b', 'alice', 35, { startNoEarlierThan: at(2026, 9, 29, 9) }),
    ];
    expect(conflictsOf(tasks)).toEqual([]);
  });

  it('reports only the hours that really overlap for tasks working a few hours a day', () => {
    const tasks = [
      tagged('morning', 'alice', 6, { hoursPerDay: 3 }),
      tagged('afternoon', 'alice', 8, { hoursPerDay: 4, dailyStartHour: 13 }),
    ];
    expect(conflictsOf(tasks)).toEqual([]);
  });

  it('sorts conflicts by tag, then by start', () => {
    const tasks = [
      tagged('b1', 'bob', 1),
      tagged('b2', 'bob', 1),
      tagged('a1', 'alice', 1, { startNoEarlierThan: at(2026, 9, 29, 9) }),
      tagged('a2', 'alice', 1, { startNoEarlierThan: at(2026, 9, 29, 9) }),
      tagged('a3', 'alice', 1),
      tagged('a4', 'alice', 1),
    ];
    expect(conflictsOf(tasks)).toEqual([
      'alice 2026-09-28 09:00 → 2026-09-28 10:00 a3,a4',
      'alice 2026-09-29 09:00 → 2026-09-29 10:00 a1,a2',
      'bob 2026-09-28 09:00 → 2026-09-28 10:00 b1,b2',
    ]);
  });

  it('treats a task pointing to a deleted tag as untagged and reports it', () => {
    const tasks = [
      tagged('ghost1', 'deleted', 7),
      tagged('ghost2', 'deleted', 7),
      tagged('a', 'alice', 7),
    ];
    const schedule = scheduleOrThrow(project(tasks, [], { tags: TAGS }));
    expect(schedule.tagConflicts).toEqual({
      conflicts: [],
      tasksWithUnknownTag: ['ghost1', 'ghost2'],
    });
  });
});

describe('tag structure', () => {
  it('rejects duplicated tag identifiers', () => {
    const result = analyzeProjectStructure({
      tasks: [],
      dependencies: [],
      tags: [ALICE, { ...BOB, id: 'alice' }],
    });
    expect(result).toEqual({
      ok: false,
      error: [{ code: 'DUPLICATE_TAG_ID', list: 'tags', index: 1, tagId: 'alice' }],
    });
  });

  it('rejects too many tags', () => {
    const tags = Array.from({ length: MAX_TAGS + 1 }, (_value, index) => ({
      ...DESIGN,
      id: `t${String(index)}`,
    }));
    const result = analyzeProjectStructure({ tasks: [], dependencies: [], tags });
    expect(result).toEqual({ ok: false, error: [{ code: 'TOO_MANY_TAGS' }] });
  });
});
