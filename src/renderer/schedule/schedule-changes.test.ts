import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { compareStrings } from '../../core/compare-strings';
import type { Project, Task } from '../../core/model/project';
import { failure, success, type Result } from '../../core/result';
import { scheduleProject, type Schedule } from '../../core/scheduling/schedule-project';
import { PROPERTY_TEST_TIMEOUT_MS } from '../../core/testing/arbitraries';
import { richProjectArbitrary } from '../../core/testing/project-arbitrary';
import { link, project, testId, workTask } from '../../core/testing/project-builder';
import type { ConflictLine, DateConflictLine } from '../plan/conflict-lines';
import {
  applyScheduleDelta,
  descriptionAfter,
  descriptionDeltaOf,
  projectAfterDelta,
  projectDeltaOf,
  sameData,
  scheduleDeltaOf,
  scheduleOfTable,
  scheduleTableOf,
} from './schedule-changes';

/** Returns a project whose lists are sorted by identifier, as a session gives them. */
function sorted(input: Project): Project {
  /** Sorts items by identifier. */
  const byId = <Item extends { readonly id: string }>(items: readonly Item[]) =>
    [...items].sort((left, right) => compareStrings(left.id, right.id));
  return {
    ...input,
    tasks: byId(input.tasks),
    dependencies: byId(input.dependencies),
    tags: byId(input.tags),
  };
}

/** Returns the schedule of a project, failing the test when it cannot be computed. */
function scheduleOf(input: Project): Schedule {
  const result = scheduleProject(input);
  if (!result.ok) {
    throw new Error(JSON.stringify(result.error));
  }
  return result.value;
}

const START = project([workTask('a'), workTask('b'), workTask('c')], [link('a', 'b')]);

describe('projectDeltaOf and projectAfterDelta', { timeout: PROPERTY_TEST_TIMEOUT_MS }, () => {
  it('sends nothing but empty lists for the same project, and gives it back as it is', () => {
    const delta = projectDeltaOf(START, START);
    expect(delta).toEqual({
      header: null,
      tasks: { put: [], removed: [] },
      dependencies: { put: [], removed: [] },
      tags: { put: [], removed: [] },
    });
    expect(projectAfterDelta(START, delta)).toEqual(START);
    expect(projectAfterDelta(START, delta).tasks).toBe(START.tasks);
  });

  it('sends the header without its lists once a field changed, and the items put and removed', () => {
    const [kept, , gone] = START.tasks;
    const renamed: Task = { ...workTask('b'), name: 'Renamed' };
    const next = {
      ...START,
      name: 'Other',
      tasks: [kept ?? workTask('a'), renamed, workTask('d')],
      dependencies: [],
    };
    const delta = projectDeltaOf(START, next);
    expect(delta.header).toEqual({ ...next, tasks: [], dependencies: [], tags: [] });
    expect(gone?.id).toBe(testId('c'));
    expect(delta.tasks).toEqual({ put: [workTask('d'), renamed], removed: [testId('c')] });
    expect(delta.dependencies).toEqual({ put: [], removed: [testId('a-b')] });
    expect(projectAfterDelta(START, delta)).toEqual(next);
  });

  it('turns any project into any other through the delta between them', () => {
    fc.assert(
      fc.property(richProjectArbitrary, richProjectArbitrary, (first, second) => {
        const [before, after] = [sorted(first.project), sorted(second.project)];
        expect(projectAfterDelta(before, projectDeltaOf(before, after))).toEqual(after);
      }),
      { numRuns: 50 },
    );
  });
});

describe('scheduleDeltaOf and applyScheduleDelta', { timeout: PROPERTY_TEST_TIMEOUT_MS }, () => {
  it('changes a table into the next schedule, floats appearing, changing and disappearing', () => {
    const first = scheduleOf(START);
    const critical = { ...START, options: { ...START.options, criticalPathEnabled: true } };
    const longer = {
      ...critical,
      tasks: [
        workTask('a'),
        {
          ...workTask('b'),
          segments: [{ durationHours: 9, gapDaysBefore: 0, startNoEarlierThan: null }],
        },
        workTask('c'),
      ],
    } as Project;
    const table = scheduleTableOf(first);
    for (const next of [critical, longer, START, project([workTask('a')])]) {
      const before = scheduleOfTable(table);
      const after = scheduleOf(next);
      applyScheduleDelta(table, scheduleDeltaOf(structuredClone(before), after));
      expect(scheduleOfTable(table)).toEqual(after);
    }
  });

  it('sends only what changed, conflicts included only when they did', () => {
    const first = scheduleOf(START);
    const delta = scheduleDeltaOf(first, scheduleOf(START));
    expect(delta).toEqual({
      placements: { put: [], removed: [] },
      summaries: { put: [], removed: [] },
      wbsNumbers: { put: [], removed: [] },
      floats: { kind: 'same' },
      conflicts: null,
      tagConflicts: null,
    });
    const without = scheduleOf(project([workTask('a'), workTask('b')], [link('a', 'b')]));
    expect(scheduleDeltaOf(first, without).placements.removed).toEqual([testId('c')]);
  });

  it('refuses changes to floats a table does not have', () => {
    const table = scheduleTableOf(scheduleOf(START));
    expect(() => {
      applyScheduleDelta(table, {
        ...scheduleDeltaOf(scheduleOf(START), scheduleOf(START)),
        floats: { kind: 'changes', changes: { put: [], removed: [] } },
      });
    }).toThrow('Changes to the floats arrived for a schedule without floats.');
  });

  it('turns the schedule of any project into the schedule of any other', () => {
    fc.assert(
      fc.property(richProjectArbitrary, richProjectArbitrary, (first, second) => {
        const [before, after] = [scheduleProject(first.project), scheduleProject(second.project)];
        if (!before.ok || !after.ok) {
          return;
        }
        const table = scheduleTableOf(structuredClone(before.value));
        applyScheduleDelta(table, structuredClone(scheduleDeltaOf(before.value, after.value)));
        expect(scheduleOfTable(table)).toEqual(after.value);
      }),
      { numRuns: 50 },
    );
  });
});

describe('sameData', () => {
  it('compares primitives, arrays and objects by their data', () => {
    expect([
      sameData(1, 1),
      sameData(Number.NaN, Number.NaN),
      sameData(1, 2),
      sameData(null, null),
      sameData(null, {}),
      sameData({}, null),
      sameData('a', { a: 1 }),
      sameData([1, { a: [2] }], [1, { a: [2] }]),
      sameData([1, 2], [1, 3]),
      sameData([1], { 0: 1 }),
      sameData({ a: 1 }, { a: 1, b: undefined }),
      sameData({ a: 1, c: 2 }, { a: 1, b: 2 }),
    ]).toEqual([true, true, false, true, false, false, false, true, false, false, false, false]);
  });
});

describe('descriptionDeltaOf and descriptionAfter', () => {
  /** Describes a deadline a task misses. */
  const line = (name: string): DateConflictLine => ({
    conflict: { code: 'DEADLINE_MISSED', taskId: testId(name) },
    taskName: name,
    end: 1,
    date: 0,
  });
  const failed = failure(new Error('cannot'));
  /** Gives the lines of the deadlines tasks miss. */
  const lines = (...names: string[]): Result<readonly DateConflictLine[], unknown> =>
    success(names.map(line));
  const people: Result<readonly ConflictLine[], unknown> = success([]);

  it('sends every part whole to a page that holds none, or when a part could not be described, before or now', () => {
    const next = { people, dates: lines('a') };
    expect(descriptionDeltaOf(null, next)).toEqual({
      people: { kind: 'whole', lines: next.people },
      dates: { kind: 'whole', lines: next.dates },
    });
    expect(
      descriptionDeltaOf({ people: failed, dates: lines('a') }, { people, dates: failed }),
    ).toEqual({
      people: { kind: 'whole', lines: lines() },
      dates: { kind: 'whole', lines: failed },
    });
    expect(descriptionAfter(null, descriptionDeltaOf(null, next))).toEqual(next);
  });

  it('sends only the lines that changed, by position, and the new length, which may grow or shrink', () => {
    const before = { people, dates: lines('a', 'b', 'c') };
    for (const dates of [lines('a', 'x', 'c', 'd'), lines('a'), lines()]) {
      const next = { people, dates };
      const delta = descriptionDeltaOf(before, next);
      expect(descriptionAfter(before, delta)).toEqual(next);
    }
    expect(descriptionDeltaOf(before, { people, dates: lines('a', 'x', 'c', 'd') }).dates).toEqual({
      kind: 'changes',
      length: 4,
      put: [
        [1, line('x')],
        [3, line('d')],
      ],
    });
  });

  it('refuses changes to a part the page does not hold or could not describe', () => {
    const delta = descriptionDeltaOf({ people, dates: lines() }, { people, dates: lines() });
    for (const current of [null, { people: failed, dates: lines() }]) {
      expect(() => descriptionAfter(current, delta)).toThrow(
        'The schedule worker sent changes to conflicts the page does not hold.',
      );
    }
  });
});
