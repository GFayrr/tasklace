import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { compareStrings } from '../../core/compare-strings';
import type { Project, Tag, Task } from '../../core/model/project';
import { failure, success, type Result } from '../../core/result';
import { scheduleProject, type Schedule } from '../../core/scheduling/schedule-project';
import { PROPERTY_TEST_TIMEOUT_MS } from '../../core/testing/arbitraries';
import { richProjectArbitrary } from '../../core/testing/project-arbitrary';
import { link, project, testId, workTask } from '../../core/testing/project-builder';
import {
  describeConflicts,
  type ConflictLine,
  type DateConflictLine,
} from '../plan/conflict-lines';
import { HOURS_PER_DAY } from '../../core/time';
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
    expect(delta.header).toEqual({
      name: 'Other',
      startDate: START.startDate,
      calendar: START.calendar,
      options: START.options,
      baseline: START.baseline,
    });
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
      placements: { kind: 'placements', ids: [], numbers: new Float64Array(0), removed: [] },
      summaries: { put: [], removed: [] },
      wbsNumbers: { put: [], removed: [] },
      floats: { kind: 'same' },
      conflicts: null,
      tagConflicts: { kind: 'same' },
    });
    const without = scheduleOf(project([workTask('a'), workTask('b')], [link('a', 'b')]));
    expect(scheduleDeltaOf(first, without).placements.removed).toEqual([testId('c')]);
  });

  it('refuses changes to floats a table does not have', () => {
    const table = scheduleTableOf(scheduleOf(START));
    expect(() => {
      applyScheduleDelta(table, {
        ...scheduleDeltaOf(scheduleOf(START), scheduleOf(START)),
        floats: {
          kind: 'changes',
          changes: { kind: 'floats', ids: [], numbers: new Float64Array(0), removed: [] },
        },
      });
    }).toThrow('Changes to the floats arrived for a schedule without floats.');
  });

  it('refuses summaries and numbers whose keys cannot be task identifiers', () => {
    const same = scheduleDeltaOf(scheduleOf(START), scheduleOf(START));
    const notAnId = 'The schedule worker sent a value that is not a task identifier.';
    for (const table of ['summaries', 'wbsNumbers'] as const) {
      expect(() => {
        applyScheduleDelta(scheduleTableOf(scheduleOf(START)), {
          ...same,
          [table]: { put: [[7, '1']], removed: [] },
        });
      }).toThrow(notAnId);
      expect(() => {
        applyScheduleDelta(scheduleTableOf(scheduleOf(START)), {
          ...same,
          [table]: { put: [], removed: [null] },
        });
      }).toThrow(notAnId);
    }
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
  it('refuses changed lines that leave a line without a value or sit outside the lines', () => {
    const before = { people, dates: lines('a', 'b') };
    /** Applies changes of the lines of dates to the lines held before. */
    const after = (length: number, put: readonly (readonly [number, DateConflictLine])[]) => () =>
      descriptionAfter(before, {
        people: { kind: 'changes', length: 0, put: [] },
        dates: { kind: 'changes', length, put },
      });
    const holes = 'The schedule worker sent changed conflicts that leave lines without a value.';
    expect(after(4, [[3, line('d')]])).toThrow(holes);
    expect(
      after(4, [
        [2, line('c')],
        [2, line('c')],
      ]),
    ).toThrow(holes);
    expect(after(-1, [])).toThrow(holes);
    expect(after(3, [[3, line('d')]])).toThrow(
      'The schedule worker changed the line 3 of 3 lines of conflicts.',
    );
    expect(after(3, [[-1, line('d')]])).toThrow(
      'The schedule worker changed the line -1 of 3 lines of conflicts.',
    );
    expect(after(3, [[0.5, line('d')]])).toThrow(
      'The schedule worker changed the line 0.5 of 3 lines of conflicts.',
    );
    expect(after(3, [[2, line('c')]])().dates).toEqual(lines('a', 'b', 'c'));
  });
});

describe('conflicts whose times alone change', () => {
  const ALICE: Tag = {
    id: testId('alice'),
    name: 'Alice',
    color: '#4a3aa7',
    representsPersonOrTeam: true,
  };
  const PLAN = project(
    [
      workTask('a', { name: 'Interviews', tagId: 'alice' }),
      workTask('b', { name: 'Analysis', tagId: 'alice' }),
      workTask('c', { tagId: 'alice' }),
    ],
    [],
    { tags: [ALICE] },
  );
  const LATER = { ...PLAN, startDate: PLAN.startDate + HOURS_PER_DAY };

  /** Gives the schedule and the description of the conflicts of a project. */
  const computed = (input: Project) => {
    const schedule = scheduleOf(input);
    return { schedule, description: describeConflicts(schedule, input) };
  };

  it('sends only the times of the conflicts and of their lines when the project start moves, which give the page the full computation', () => {
    const before = computed(PLAN);
    const after = computed(LATER);
    expect(after.schedule.tagConflicts.conflicts).toHaveLength(1);
    const delta = scheduleDeltaOf(before.schedule, after.schedule);
    const described = descriptionDeltaOf(before.description, after.description);
    const times = Float64Array.from(
      after.schedule.tagConflicts.conflicts.flatMap((conflict) => [conflict.start, conflict.end]),
    );
    expect([delta.tagConflicts, described.people]).toEqual([
      { kind: 'times', times },
      { kind: 'times', times },
    ]);
    const table = scheduleTableOf(before.schedule);
    applyScheduleDelta(table, structuredClone(delta));
    expect(scheduleOfTable(table)).toEqual(after.schedule);
    expect(descriptionAfter(before.description, structuredClone(described))).toEqual(
      after.description,
    );
  });

  it('sends the whole report and the lines changed once the tasks of a conflict change, and the lines alone once a name changes', () => {
    const before = computed(PLAN);
    const fewer = { ...LATER, tasks: LATER.tasks.filter((task) => task.id !== testId('c')) };
    const renamed = {
      ...PLAN,
      tasks: PLAN.tasks.map((task) =>
        task.id === testId('a') ? { ...task, name: 'Talks' } : task,
      ),
    };
    const otherTasks = computed(fewer);
    const otherName = computed(renamed);
    expect(scheduleDeltaOf(before.schedule, otherTasks.schedule).tagConflicts).toEqual({
      kind: 'whole',
      report: otherTasks.schedule.tagConflicts,
    });
    expect(descriptionDeltaOf(before.description, otherTasks.description).people.kind).toBe(
      'changes',
    );
    expect(scheduleDeltaOf(before.schedule, otherName.schedule).tagConflicts).toEqual({
      kind: 'same',
    });
    expect(descriptionDeltaOf(before.description, otherName.description).people.kind).toBe(
      'changes',
    );
  });

  it('refuses new times for lines the page does not hold or could not describe', () => {
    const delta = descriptionDeltaOf(computed(PLAN).description, computed(LATER).description);
    for (const current of [null, { people: failure(new Error('cannot')), dates: success([]) }]) {
      expect(() => descriptionAfter(current, delta)).toThrow(
        'The schedule worker sent changes to conflicts the page does not hold.',
      );
    }
  });
});
