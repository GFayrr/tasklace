import { describe, expect, it } from 'vitest';
import { TEST_CALENDAR } from '../testing/test-calendar';
import type { Dependency, Project, Task, WorkTask, TaskId } from '../model/project';
import { at, format } from '../testing/civil-time';
import {
  PROJECT_START,
  link,
  milestone,
  project,
  scheduleOrThrow,
  splitTask,
  summary,
  workTask,
  testId,
} from '../testing/project-builder';
import { scheduleProject, type Schedule } from './schedule-project';

const ALL_OPTIONS = {
  criticalPathEnabled: true,
  dateConstraintsEnabled: true,
  baselineEnabled: false,
  alwaysShowPatterns: false,
};

/** Formats the start and end of a scheduled task as "start → end". */
function datesOf(schedule: Schedule, taskId: TaskId): string {
  const placement = schedule.placements.get(taskId);
  if (placement === undefined) {
    throw new Error(`Task ${taskId} was not scheduled`);
  }
  return `${format(placement.start)} → ${format(placement.end)}`;
}

/** Schedules tasks and dependencies, then formats the dates of one task. */
function datesAfterScheduling(
  taskId: TaskId,
  tasks: readonly Task[],
  dependencies: readonly Dependency[] = [],
  overrides: Partial<Project> = {},
): string {
  return datesOf(scheduleOrThrow(project(tasks, dependencies, overrides)), taskId);
}

/** Builds a work task of a given duration in hours. */
function taskOf(id: TaskId, durationHours: number, overrides: Partial<WorkTask> = {}): Task {
  return workTask(id, {
    segments: [{ durationHours, gapDaysBefore: 0, startNoEarlierThan: null }],
    ...overrides,
  });
}

const UNKNOWN_FLOAT = {
  lateStart: null,
  lateFinish: null,
  totalFloatHours: null,
  freeFloatHours: null,
  isCritical: true,
} as const;
describe('scheduleProject: dates', () => {
  it('starts a task without predecessor at the project start', () => {
    expect(datesAfterScheduling(testId('a'), [taskOf(testId('a'), 7)])).toBe(
      '2026-09-28 09:00 → 2026-09-28 17:00',
    );
  });

  it('never starts a task before the project start, even with an earlier start date', () => {
    const task = taskOf(testId('a'), 7, { startNoEarlierThan: at(2026, 9, 1, 9) });
    expect(datesAfterScheduling(testId('a'), [task])).toBe('2026-09-28 09:00 → 2026-09-28 17:00');
  });

  it('starts a task at its start date, moved to the next working hour', () => {
    expect(
      datesAfterScheduling(testId('a'), [
        taskOf(testId('a'), 7, { startNoEarlierThan: at(2026, 10, 1, 9) }),
      ]),
    ).toBe('2026-10-01 09:00 → 2026-10-01 17:00');
    expect(
      datesAfterScheduling(testId('a'), [
        taskOf(testId('a'), 1, { startNoEarlierThan: at(2026, 10, 3, 9) }),
      ]),
    ).toBe('2026-10-05 09:00 → 2026-10-05 10:00');
  });

  it.each<[string, Dependency, string]>([
    ['finish-to-start', link('a', 'b'), '2026-09-29 09:00 → 2026-09-29 17:00'],
    [
      'finish-to-start with a lag',
      link('a', 'b', 'finishToStart', 2),
      '2026-09-29 11:00 → 2026-09-30 11:00',
    ],
    [
      'finish-to-start with a lead',
      link('a', 'b', 'finishToStart', -2),
      '2026-09-28 15:00 → 2026-09-29 15:00',
    ],
    [
      'start-to-start with a lag',
      link('a', 'b', 'startToStart', 3),
      '2026-09-28 13:00 → 2026-09-29 12:00',
    ],
    ['finish-to-finish', link('a', 'b', 'finishToFinish'), '2026-09-28 09:00 → 2026-09-28 17:00'],
    [
      'finish-to-finish with a lag',
      link('a', 'b', 'finishToFinish', 7),
      '2026-09-29 09:00 → 2026-09-29 17:00',
    ],
  ])('applies a %s dependency', (_label, dependency, expected) => {
    expect(
      datesAfterScheduling(
        testId('b'),
        [taskOf(testId('a'), 7), taskOf(testId('b'), 7)],
        [dependency],
      ),
    ).toBe(expected);
  });

  it('delays a shorter task to finish with its finish-to-finish predecessor', () => {
    expect(
      datesAfterScheduling(
        testId('b'),
        [taskOf(testId('a'), 7), taskOf(testId('b'), 3)],
        [link('a', 'b', 'finishToFinish')],
      ),
    ).toBe('2026-09-28 14:00 → 2026-09-28 17:00');
  });

  it('treats the end of a working day and the start of the next one as the same moment', () => {
    const tasks = [
      taskOf(testId('a'), 7, { startNoEarlierThan: at(2026, 9, 29, 9) }),
      taskOf(testId('b'), 2),
    ];
    expect(datesAfterScheduling(testId('b'), tasks, [link('a', 'b', 'startToFinish')])).toBe(
      '2026-09-28 15:00 → 2026-09-28 17:00',
    );
  });

  it('waits for the latest of several predecessors', () => {
    const tasks = [taskOf(testId('a'), 7), taskOf(testId('b'), 14), taskOf(testId('c'), 1)];
    expect(datesAfterScheduling(testId('c'), tasks, [link('a', 'c'), link('b', 'c')])).toBe(
      '2026-09-30 09:00 → 2026-09-30 10:00',
    );
  });

  it('places a milestone at the end of its predecessor', () => {
    expect(
      datesAfterScheduling(testId('m'), [taskOf(testId('a'), 7), milestone('m')], [link('a', 'm')]),
    ).toBe('2026-09-28 17:00 → 2026-09-28 17:00');
  });

  it('makes successors wait for the last block of a split task', () => {
    const tasks = [
      splitTask('a', [
        [7, 0],
        [7, 21],
      ]),
      taskOf(testId('b'), 7),
    ];
    expect(datesAfterScheduling(testId('b'), tasks, [link('a', 'b')])).toBe(
      '2026-10-20 09:00 → 2026-10-20 17:00',
    );
  });

  it('keeps the gap between blocks when the first block is pushed back', () => {
    const tasks = [
      taskOf(testId('a'), 14),
      splitTask('b', [
        [7, 0],
        [7, 7],
      ]),
    ];
    const schedule = scheduleOrThrow(project(tasks, [link('a', 'b')]));
    const segments = schedule.placements
      .get(testId('b'))
      ?.segments.map((segment) => format(segment.start));
    expect(segments).toEqual(['2026-09-30 09:00', '2026-10-07 09:00']);
  });

  it('produces the same schedule whatever the order of tasks and dependencies', () => {
    const tasks = [
      taskOf(testId('a'), 7),
      taskOf(testId('b'), 14),
      taskOf(testId('c'), 3),
      milestone('m'),
    ];
    const dependencies = [
      link('a', 'b'),
      link('a', 'c', 'startToStart', 2),
      link('b', 'm'),
      link('c', 'm'),
    ];
    const forward = scheduleOrThrow(project(tasks, dependencies, { options: ALL_OPTIONS }));
    const backward = scheduleOrThrow(
      project([...tasks].reverse(), [...dependencies].reverse(), { options: ALL_OPTIONS }),
    );
    expect(new Map([...backward.placements].sort())).toEqual(
      new Map([...forward.placements].sort()),
    );
    expect(new Map([...(backward.floats ?? [])].sort())).toEqual(
      new Map([...(forward.floats ?? [])].sort()),
    );
  });
});

describe('scheduleProject: advanced date constraints', () => {
  const thursdayEvening = at(2026, 10, 1, 17);

  it('ignores "must finish on" and deadlines while the option is disabled', () => {
    const schedule = scheduleOrThrow(
      project([taskOf(testId('a'), 7, { mustFinishOn: thursdayEvening, deadline: PROJECT_START })]),
    );
    expect(datesOf(schedule, testId('a'))).toBe('2026-09-28 09:00 → 2026-09-28 17:00');
    expect(schedule.conflicts).toEqual([]);
  });

  it('delays a task so that it finishes on its "must finish on" date', () => {
    const task = taskOf(testId('a'), 7, { mustFinishOn: thursdayEvening });
    expect(datesAfterScheduling(testId('a'), [task], [], { options: ALL_OPTIONS })).toBe(
      '2026-10-01 09:00 → 2026-10-01 17:00',
    );
  });

  it('places a milestone on its "must finish on" date', () => {
    const marker = milestone('m', { mustFinishOn: thursdayEvening });
    expect(datesAfterScheduling(testId('m'), [marker], [], { options: ALL_OPTIONS })).toBe(
      '2026-10-01 17:00 → 2026-10-01 17:00',
    );
  });

  it('reports a "must finish on" date that dependencies make impossible, without moving the task', () => {
    const tasks = [
      taskOf(testId('a'), 7),
      taskOf(testId('b'), 7, { mustFinishOn: at(2026, 9, 28, 12) }),
    ];
    const schedule = scheduleOrThrow(project(tasks, [link('a', 'b')], { options: ALL_OPTIONS }));
    expect(datesOf(schedule, testId('b'))).toBe('2026-09-29 09:00 → 2026-09-29 17:00');
    expect(schedule.conflicts).toEqual([{ code: 'MUST_FINISH_ON_NOT_MET', taskId: testId('b') }]);
  });

  it('reports missed deadlines only', () => {
    const tasks = [
      taskOf(testId('late'), 7, { deadline: at(2026, 9, 28, 12) }),
      taskOf(testId('onTime'), 7, { deadline: at(2026, 9, 28, 17) }),
    ];
    const schedule = scheduleOrThrow(project(tasks, [], { options: ALL_OPTIONS }));
    expect(schedule.conflicts).toEqual([{ code: 'DEADLINE_MISSED', taskId: testId('late') }]);
  });

  it('sorts conflicts by task, then by kind', () => {
    const impossible = { mustFinishOn: PROJECT_START, deadline: PROJECT_START };
    const tasks = [taskOf(testId('b'), 7, impossible), taskOf(testId('a'), 7, impossible)];
    const schedule = scheduleOrThrow(project(tasks, [], { options: ALL_OPTIONS }));
    expect(schedule.conflicts).toEqual([
      { code: 'DEADLINE_MISSED', taskId: testId('a') },
      { code: 'MUST_FINISH_ON_NOT_MET', taskId: testId('a') },
      { code: 'DEADLINE_MISSED', taskId: testId('b') },
      { code: 'MUST_FINISH_ON_NOT_MET', taskId: testId('b') },
    ]);
  });
});

describe('scheduleProject: summaries and numbering', () => {
  const tasks: Task[] = [
    summary('phase', { sortKey: 'a' }),
    taskOf(testId('design'), 7, { parentId: testId('phase'), sortKey: 'a', progressPercent: 50 }),
    taskOf(testId('build'), 14, { parentId: testId('phase'), sortKey: 'b' }),
    summary('sub', { parentId: testId('phase'), sortKey: 'c' }),
    milestone('review', { parentId: testId('sub'), sortKey: 'a', progressPercent: 100 }),
    milestone('launch', { sortKey: 'b' }),
    summary('empty', { sortKey: 'c' }),
  ];
  const dependencies = [link('design', 'build'), link('build', 'review'), link('review', 'launch')];
  const schedule = scheduleOrThrow(project(tasks, dependencies));

  it('spans each summary from its earliest child start to its latest child end', () => {
    const phase = schedule.summaries.get(testId('phase'));
    expect(phase?.start).toBe(at(2026, 9, 28, 9));
    expect(phase?.end).toBe(at(2026, 9, 30, 17));
  });

  it('weights summary progress by duration and ignores milestones next to work', () => {
    expect(schedule.summaries.get(testId('phase'))?.progressPercent).toBeCloseTo((7 * 50) / 21);
  });

  it('averages milestones when a summary holds nothing else', () => {
    expect(schedule.summaries.get(testId('sub'))?.progressPercent).toBe(100);
  });

  it('gives no dates and no progress to an empty summary', () => {
    expect(schedule.summaries.get(testId('empty'))).toEqual({
      start: null,
      end: null,
      progressPercent: null,
    });
  });

  it('numbers tasks by position in the tree', () => {
    expect(Object.fromEntries(schedule.wbsNumbers)).toEqual({
      phase: '1',
      design: '1.1',
      build: '1.2',
      sub: '1.3',
      review: '1.3.1',
      launch: '2',
      empty: '3',
    });
  });

  it('breaks sort key ties with task identifiers', () => {
    const tied = scheduleOrThrow(
      project([taskOf(testId('b'), 1, { sortKey: 'x' }), taskOf(testId('a'), 1, { sortKey: 'x' })]),
    );
    expect(Object.fromEntries(tied.wbsNumbers)).toEqual({ a: '1', b: '2' });
  });
});

describe('scheduleProject: critical path', () => {
  const tasks = [
    taskOf(testId('a'), 7),
    taskOf(testId('b'), 14),
    taskOf(testId('c'), 7),
    taskOf(testId('d'), 7),
  ];
  const dependencies = [link('a', 'b'), link('a', 'c'), link('b', 'd'), link('c', 'd')];

  it('is not computed while the option is disabled', () => {
    expect(scheduleOrThrow(project(tasks, dependencies)).floats).toBeNull();
  });

  it('finds the critical chain and the floats of the textbook example', () => {
    const schedule = scheduleOrThrow(
      project(tasks, dependencies, {
        options: {
          criticalPathEnabled: true,
          dateConstraintsEnabled: false,
          baselineEnabled: false,
          alwaysShowPatterns: false,
        },
      }),
    );
    /** Returns the total float, free float and critical flag of a task, or nothing for a task without float. */
    const summaryOf = (id: TaskId): [number | null, number | null, boolean] | undefined => {
      const taskFloat = schedule.floats?.get(id);
      return (
        taskFloat && [taskFloat.totalFloatHours, taskFloat.freeFloatHours, taskFloat.isCritical]
      );
    };
    expect(summaryOf(testId('a'))).toEqual([0, 0, true]);
    expect(summaryOf(testId('b'))).toEqual([0, 0, true]);
    expect(summaryOf(testId('c'))).toEqual([7, 7, false]);
    expect(summaryOf(testId('d'))).toEqual([0, 0, true]);
    expect(format(schedule.floats?.get(testId('c'))?.lateStart ?? 0)).toBe('2026-09-30 09:00');
  });

  it('gives a negative float to tasks that cannot meet a deadline', () => {
    const late = [...tasks.slice(0, 3), taskOf(testId('d'), 7, { deadline: at(2026, 9, 30, 17) })];
    const schedule = scheduleOrThrow(project(late, dependencies, { options: ALL_OPTIONS }));
    expect(schedule.floats?.get(testId('d'))?.totalFloatHours).toBe(-7);
    expect(schedule.floats?.get(testId('a'))?.isCritical).toBe(true);
    expect(schedule.conflicts).toEqual([{ code: 'DEADLINE_MISSED', taskId: testId('d') }]);
  });

  it('computes floats across start-to-start and finish-to-finish links', () => {
    const mixed = [taskOf(testId('a'), 14), taskOf(testId('b'), 7), taskOf(testId('c'), 3)];
    const schedule = scheduleOrThrow(
      project(mixed, [link('a', 'b', 'startToStart'), link('a', 'c', 'finishToFinish')], {
        options: ALL_OPTIONS,
      }),
    );
    expect(schedule.floats?.get(testId('b'))?.totalFloatHours).toBe(7);
    expect(schedule.floats?.get(testId('c'))?.totalFloatHours).toBe(0);
  });

  it('marks as critical a task whose start can slip but whose end cannot', () => {
    const schedule = scheduleOrThrow(
      project([taskOf(testId('slow'), 2, { hoursPerDay: 1 }), taskOf(testId('short'), 1)], [], {
        options: ALL_OPTIONS,
      }),
    );
    expect(schedule.floats?.get(testId('slow'))?.isCritical).toBe(true);
    expect(schedule.floats?.get(testId('slow'))?.totalFloatHours).toBe(0);
    expect(schedule.floats?.get(testId('short'))?.isCritical).toBe(false);
  });

  it('handles an empty project', () => {
    const schedule = scheduleOrThrow(project([], [], { options: ALL_OPTIONS }));
    expect(schedule.floats?.size).toBe(0);
    expect(schedule.placements.size).toBe(0);
  });
});

describe('scheduleProject: failures', () => {
  it('reports an invalid calendar', () => {
    const result = scheduleProject(
      project([], [], { calendar: { ...TEST_CALENDAR, workingWeekdays: [] } }),
    );
    expect(result).toEqual({
      ok: false,
      error: { kind: 'calendar', errors: [{ code: 'NO_WORKING_WEEKDAY' }] },
    });
  });

  it('reports an invalid project start date', () => {
    expect(scheduleProject(project([], [], { startDate: Number.NaN }))).toEqual({
      ok: false,
      error: { kind: 'startDate' },
    });
  });

  it('reports structural problems', () => {
    const result = scheduleProject(
      project([taskOf(testId('a'), 1), taskOf(testId('b'), 1)], [link('a', 'b'), link('b', 'a')]),
    );
    expect(!result.ok && result.error.kind).toBe('structure');
  });

  it('reports the task that cannot be placed', () => {
    const result = scheduleProject(project([taskOf(testId('a'), 1, { hoursPerDay: 99 })]));
    expect(result).toEqual({
      ok: false,
      error: { kind: 'task', error: { code: 'INVALID_HOURS_PER_DAY', taskId: testId('a') } },
    });
  });

  it('reports a task pushed past the horizon by a dependency lag', () => {
    const tasks = [
      taskOf(testId('a'), 1, { startNoEarlierThan: at(2200, 12, 1, 9) }),
      taskOf(testId('b'), 1),
    ];
    const result = scheduleProject(project(tasks, [link('a', 'b', 'finishToStart', 100_000)]));
    expect(result).toEqual({
      ok: false,
      error: { kind: 'task', error: { code: 'BEYOND_PLANNING_HORIZON', taskId: testId('b') } },
    });
  });

  it('reports a task pulled before the horizon by a dependency lead', () => {
    const tasks = [
      taskOf(testId('a'), 1, { startNoEarlierThan: at(2020, 1, 6, 9) }),
      taskOf(testId('b'), 1),
    ];
    const result = scheduleProject(
      project(tasks, [link('a', 'b', 'finishToStart', -50)], {
        startDate: at(2020, 1, 1, 9),
        options: ALL_OPTIONS,
      }),
    );
    expect(result).toEqual({
      ok: false,
      error: { kind: 'task', error: { code: 'BEYOND_PLANNING_HORIZON', taskId: testId('b') } },
    });
  });

  it('dates a summary from its dated children only, an empty summary after them adding nothing', () => {
    const plan = project([
      summary('outer', { sortKey: 'a' }),
      workTask('work', { parentId: testId('outer'), sortKey: 'b' }),
      summary('empty', { parentId: testId('outer'), sortKey: 'c' }),
    ]);
    const schedule = scheduleOrThrow(plan);
    const work = schedule.placements.get(testId('work'));
    expect(schedule.summaries.get(testId('empty'))).toEqual({
      start: null,
      end: null,
      progressPercent: null,
    });
    expect(schedule.summaries.get(testId('outer'))).toEqual({
      start: work?.start,
      end: work?.end,
      progressPercent: 0,
    });
  });

  it('leaves out a lead that would only limit a task after the last supported year', () => {
    /** Builds a plan of two tasks linked with a long lead, starting at a given date. */
    const planFrom = (startDate: number): Project =>
      project([workTask('a'), workTask('b')], [link('a', 'b', 'finishToStart', -60)], {
        startDate,
        options: {
          criticalPathEnabled: true,
          dateConstraintsEnabled: false,
          baselineEnabled: false,
          alwaysShowPatterns: false,
        },
      });
    /** Returns the floats and critical flags of the two tasks of a plan. */
    const summary = (plan: Project) => {
      const floats = scheduleOrThrow(plan).floats;
      return [testId('a'), testId('b')].map((id) => {
        const taskFloat = floats?.get(id);
        return [taskFloat?.totalFloatHours, taskFloat?.freeFloatHours, taskFloat?.isCritical];
      });
    };
    expect(summary(planFrom(at(2200, 12, 26)))).toEqual([
      [0, 0, true],
      [0, 0, true],
    ]);
    expect(summary(planFrom(at(2100, 12, 27)))).toEqual(summary(planFrom(at(2200, 12, 26))));
  });

  it('passes an unknown float on to every task before it, and to no other task', () => {
    /** Builds a plan with the critical path and the date constraints on, starting at the first supported week. */
    const constrained = (tasks: Project['tasks'], dependencies: Project['dependencies']) =>
      project(tasks, dependencies, {
        startDate: at(2020, 1, 6, 9),
        options: {
          criticalPathEnabled: true,
          dateConstraintsEnabled: true,
          baselineEnabled: false,
          alwaysShowPatterns: false,
        },
      });
    const plan = constrained(
      [
        workTask('a'),
        workTask('b'),
        workTask('c', {
          segments: [{ durationHours: 200, gapDaysBefore: 0, startNoEarlierThan: null }],
          mustFinishOn: at(2020, 1, 6, 10),
        }),
        milestone('m'),
        workTask('free', {
          segments: [{ durationHours: 7, gapDaysBefore: 0, startNoEarlierThan: null }],
        }),
        workTask('part', {
          hoursPerDay: 2,
          segments: [{ durationHours: 20, gapDaysBefore: 0, startNoEarlierThan: null }],
          mustFinishOn: at(2020, 1, 6, 10),
        }),
      ],
      [link('a', 'b'), link('b', 'c', 'startToStart'), link('m', 'c')],
    );
    const floats = scheduleOrThrow(plan).floats;
    for (const id of [testId('a'), testId('b'), testId('c'), testId('m'), testId('part')]) {
      expect(floats?.get(id)).toEqual(UNKNOWN_FLOAT);
    }
    expect(floats?.get(testId('free'))).toEqual({
      lateStart: 439334,
      lateFinish: 439358,
      totalFloatHours: 200,
      freeFloatHours: 200,
      isCritical: false,
    });
  });

  it('gives an unknown float to a split task when only its first block would start before the first supported year', () => {
    const plan = project(
      [
        workTask('split', {
          segments: [
            { durationHours: 100, gapDaysBefore: 0, startNoEarlierThan: null },
            { durationHours: 7, gapDaysBefore: 30, startNoEarlierThan: null },
          ],
          mustFinishOn: at(2020, 2, 14, 17),
        }),
      ],
      [],
      {
        startDate: at(2020, 1, 6, 9),
        options: {
          criticalPathEnabled: true,
          dateConstraintsEnabled: true,
          baselineEnabled: false,
          alwaysShowPatterns: false,
        },
      },
    );
    expect(scheduleOrThrow(plan).floats?.get(testId('split'))).toEqual(UNKNOWN_FLOAT);
  });

  it('gives an unknown float, critical, to a task that would have to start before the first supported year', () => {
    const plan = project(
      [
        workTask('a', {
          segments: [{ durationHours: 200, gapDaysBefore: 0, startNoEarlierThan: null }],
          mustFinishOn: at(2020, 1, 6, 10),
        }),
        workTask('split', {
          segments: [
            { durationHours: 100, gapDaysBefore: 0, startNoEarlierThan: null },
            { durationHours: 100, gapDaysBefore: 1, startNoEarlierThan: null },
          ],
          mustFinishOn: at(2020, 1, 6, 10),
        }),
      ],
      [],
      {
        startDate: at(2020, 1, 6, 9),
        options: {
          criticalPathEnabled: true,
          dateConstraintsEnabled: true,
          baselineEnabled: false,
          alwaysShowPatterns: false,
        },
      },
    );
    const floats = scheduleOrThrow(plan).floats;
    for (const id of [testId('a'), testId('split')]) {
      expect(floats?.get(id)).toEqual(UNKNOWN_FLOAT);
    }
  });
});
