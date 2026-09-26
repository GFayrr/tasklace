import { describe, expect, it } from 'vitest';
import { DEFAULT_CALENDAR } from '../calendar/default-calendar';
import type { Dependency, Project, Task, WorkTask } from '../model/project';
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
} from '../testing/project-builder';
import { scheduleProject, type Schedule } from './schedule-project';

const ALL_OPTIONS = { criticalPathEnabled: true, dateConstraintsEnabled: true };

/** Formats the start and end of a scheduled task as "start → end". */
function datesOf(schedule: Schedule, taskId: string): string {
  const placement = schedule.placements.get(taskId);
  if (placement === undefined) {
    throw new Error(`Task ${taskId} was not scheduled`);
  }
  return `${format(placement.start)} → ${format(placement.end)}`;
}

/** Schedules tasks and dependencies, then formats the dates of one task. */
function datesAfterScheduling(
  taskId: string,
  tasks: readonly Task[],
  dependencies: readonly Dependency[] = [],
  overrides: Partial<Project> = {},
): string {
  return datesOf(scheduleOrThrow(project(tasks, dependencies, overrides)), taskId);
}

/** Builds a work task of a given duration in hours. */
function taskOf(id: string, durationHours: number, overrides: Partial<WorkTask> = {}): Task {
  return workTask(id, { segments: [{ durationHours, gapDaysBefore: 0 }], ...overrides });
}

describe('scheduleProject: dates', () => {
  it('starts a task without predecessor at the project start', () => {
    expect(datesAfterScheduling('a', [taskOf('a', 7)])).toBe('2026-09-28 09:00 → 2026-09-28 17:00');
  });

  it('never starts a task before the project start, even with an earlier start date', () => {
    const task = taskOf('a', 7, { startNoEarlierThan: at(2026, 9, 1, 9) });
    expect(datesAfterScheduling('a', [task])).toBe('2026-09-28 09:00 → 2026-09-28 17:00');
  });

  it('starts a task at its start date, moved to the next working hour', () => {
    expect(
      datesAfterScheduling('a', [taskOf('a', 7, { startNoEarlierThan: at(2026, 10, 1, 9) })]),
    ).toBe('2026-10-01 09:00 → 2026-10-01 17:00');
    expect(
      datesAfterScheduling('a', [taskOf('a', 1, { startNoEarlierThan: at(2026, 10, 3, 9) })]),
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
    expect(datesAfterScheduling('b', [taskOf('a', 7), taskOf('b', 7)], [dependency])).toBe(
      expected,
    );
  });

  it('delays a shorter task to finish with its finish-to-finish predecessor', () => {
    expect(
      datesAfterScheduling(
        'b',
        [taskOf('a', 7), taskOf('b', 3)],
        [link('a', 'b', 'finishToFinish')],
      ),
    ).toBe('2026-09-28 14:00 → 2026-09-28 17:00');
  });

  it('treats the end of a working day and the start of the next one as the same moment', () => {
    const tasks = [taskOf('a', 7, { startNoEarlierThan: at(2026, 9, 29, 9) }), taskOf('b', 2)];
    expect(datesAfterScheduling('b', tasks, [link('a', 'b', 'startToFinish')])).toBe(
      '2026-09-28 15:00 → 2026-09-28 17:00',
    );
  });

  it('waits for the latest of several predecessors', () => {
    const tasks = [taskOf('a', 7), taskOf('b', 14), taskOf('c', 1)];
    expect(datesAfterScheduling('c', tasks, [link('a', 'c'), link('b', 'c')])).toBe(
      '2026-09-30 09:00 → 2026-09-30 10:00',
    );
  });

  it('places a milestone at the end of its predecessor', () => {
    expect(datesAfterScheduling('m', [taskOf('a', 7), milestone('m')], [link('a', 'm')])).toBe(
      '2026-09-28 17:00 → 2026-09-28 17:00',
    );
  });

  it('makes successors wait for the last block of a split task', () => {
    const tasks = [
      splitTask('a', [
        [7, 0],
        [7, 21],
      ]),
      taskOf('b', 7),
    ];
    expect(datesAfterScheduling('b', tasks, [link('a', 'b')])).toBe(
      '2026-10-20 09:00 → 2026-10-20 17:00',
    );
  });

  it('keeps the gap between blocks when the first block is pushed back', () => {
    const tasks = [
      taskOf('a', 14),
      splitTask('b', [
        [7, 0],
        [7, 7],
      ]),
    ];
    const schedule = scheduleOrThrow(project(tasks, [link('a', 'b')]));
    const segments = schedule.placements.get('b')?.segments.map((segment) => format(segment.start));
    expect(segments).toEqual(['2026-09-30 09:00', '2026-10-07 09:00']);
  });

  it('produces the same schedule whatever the order of tasks and dependencies', () => {
    const tasks = [taskOf('a', 7), taskOf('b', 14), taskOf('c', 3), milestone('m')];
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
      project([taskOf('a', 7, { mustFinishOn: thursdayEvening, deadline: PROJECT_START })]),
    );
    expect(datesOf(schedule, 'a')).toBe('2026-09-28 09:00 → 2026-09-28 17:00');
    expect(schedule.conflicts).toEqual([]);
  });

  it('delays a task so that it finishes on its "must finish on" date', () => {
    const task = taskOf('a', 7, { mustFinishOn: thursdayEvening });
    expect(datesAfterScheduling('a', [task], [], { options: ALL_OPTIONS })).toBe(
      '2026-10-01 09:00 → 2026-10-01 17:00',
    );
  });

  it('places a milestone on its "must finish on" date', () => {
    const marker = milestone('m', { mustFinishOn: thursdayEvening });
    expect(datesAfterScheduling('m', [marker], [], { options: ALL_OPTIONS })).toBe(
      '2026-10-01 17:00 → 2026-10-01 17:00',
    );
  });

  it('reports a "must finish on" date that dependencies make impossible, without moving the task', () => {
    const tasks = [taskOf('a', 7), taskOf('b', 7, { mustFinishOn: at(2026, 9, 28, 12) })];
    const schedule = scheduleOrThrow(project(tasks, [link('a', 'b')], { options: ALL_OPTIONS }));
    expect(datesOf(schedule, 'b')).toBe('2026-09-29 09:00 → 2026-09-29 17:00');
    expect(schedule.conflicts).toEqual([{ code: 'MUST_FINISH_ON_NOT_MET', taskId: 'b' }]);
  });

  it('reports missed deadlines only', () => {
    const tasks = [
      taskOf('late', 7, { deadline: at(2026, 9, 28, 12) }),
      taskOf('onTime', 7, { deadline: at(2026, 9, 28, 17) }),
    ];
    const schedule = scheduleOrThrow(project(tasks, [], { options: ALL_OPTIONS }));
    expect(schedule.conflicts).toEqual([{ code: 'DEADLINE_MISSED', taskId: 'late' }]);
  });

  it('sorts conflicts by task, then by kind', () => {
    const impossible = { mustFinishOn: PROJECT_START, deadline: PROJECT_START };
    const tasks = [taskOf('b', 7, impossible), taskOf('a', 7, impossible)];
    const schedule = scheduleOrThrow(project(tasks, [], { options: ALL_OPTIONS }));
    expect(schedule.conflicts).toEqual([
      { code: 'DEADLINE_MISSED', taskId: 'a' },
      { code: 'MUST_FINISH_ON_NOT_MET', taskId: 'a' },
      { code: 'DEADLINE_MISSED', taskId: 'b' },
      { code: 'MUST_FINISH_ON_NOT_MET', taskId: 'b' },
    ]);
  });
});

describe('scheduleProject: summaries and numbering', () => {
  const tasks: Task[] = [
    summary('phase', { sortKey: 'a' }),
    taskOf('design', 7, { parentId: 'phase', sortKey: 'a', progressPercent: 50 }),
    taskOf('build', 14, { parentId: 'phase', sortKey: 'b' }),
    summary('sub', { parentId: 'phase', sortKey: 'c' }),
    milestone('review', { parentId: 'sub', sortKey: 'a', progressPercent: 100 }),
    milestone('launch', { sortKey: 'b' }),
    summary('empty', { sortKey: 'c' }),
  ];
  const dependencies = [link('design', 'build'), link('build', 'review'), link('review', 'launch')];
  const schedule = scheduleOrThrow(project(tasks, dependencies));

  it('spans each summary from its earliest child start to its latest child end', () => {
    const phase = schedule.summaries.get('phase');
    expect(phase?.start).toBe(at(2026, 9, 28, 9));
    expect(phase?.end).toBe(at(2026, 9, 30, 17));
  });

  it('weights summary progress by duration and ignores milestones next to work', () => {
    expect(schedule.summaries.get('phase')?.progressPercent).toBeCloseTo((7 * 50) / 21);
  });

  it('averages milestones when a summary holds nothing else', () => {
    expect(schedule.summaries.get('sub')?.progressPercent).toBe(100);
  });

  it('gives no dates and no progress to an empty summary', () => {
    expect(schedule.summaries.get('empty')).toEqual({
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
      project([taskOf('b', 1, { sortKey: 'x' }), taskOf('a', 1, { sortKey: 'x' })]),
    );
    expect(Object.fromEntries(tied.wbsNumbers)).toEqual({ a: '1', b: '2' });
  });
});

describe('scheduleProject: critical path', () => {
  const tasks = [taskOf('a', 7), taskOf('b', 14), taskOf('c', 7), taskOf('d', 7)];
  const dependencies = [link('a', 'b'), link('a', 'c'), link('b', 'd'), link('c', 'd')];

  it('is not computed while the option is disabled', () => {
    expect(scheduleOrThrow(project(tasks, dependencies)).floats).toBeNull();
  });

  it('finds the critical chain and the floats of the textbook example', () => {
    const schedule = scheduleOrThrow(
      project(tasks, dependencies, {
        options: { criticalPathEnabled: true, dateConstraintsEnabled: false },
      }),
    );
    const summaryOf = (id: string): [number, number, boolean] | undefined => {
      const taskFloat = schedule.floats?.get(id);
      return (
        taskFloat && [taskFloat.totalFloatHours, taskFloat.freeFloatHours, taskFloat.isCritical]
      );
    };
    expect(summaryOf('a')).toEqual([0, 0, true]);
    expect(summaryOf('b')).toEqual([0, 0, true]);
    expect(summaryOf('c')).toEqual([7, 7, false]);
    expect(summaryOf('d')).toEqual([0, 0, true]);
    expect(format(schedule.floats?.get('c')?.lateStart ?? 0)).toBe('2026-09-30 09:00');
  });

  it('gives a negative float to tasks that cannot meet a deadline', () => {
    const late = [...tasks.slice(0, 3), taskOf('d', 7, { deadline: at(2026, 9, 30, 17) })];
    const schedule = scheduleOrThrow(project(late, dependencies, { options: ALL_OPTIONS }));
    expect(schedule.floats?.get('d')?.totalFloatHours).toBe(-7);
    expect(schedule.floats?.get('a')?.isCritical).toBe(true);
    expect(schedule.conflicts).toEqual([{ code: 'DEADLINE_MISSED', taskId: 'd' }]);
  });

  it('computes floats across start-to-start and finish-to-finish links', () => {
    const mixed = [taskOf('a', 14), taskOf('b', 7), taskOf('c', 3)];
    const schedule = scheduleOrThrow(
      project(mixed, [link('a', 'b', 'startToStart'), link('a', 'c', 'finishToFinish')], {
        options: ALL_OPTIONS,
      }),
    );
    expect(schedule.floats?.get('b')?.totalFloatHours).toBe(7);
    expect(schedule.floats?.get('c')?.totalFloatHours).toBe(0);
  });

  it('marks as critical a task whose start can slip but whose end cannot', () => {
    const schedule = scheduleOrThrow(
      project([taskOf('slow', 2, { hoursPerDay: 1 }), taskOf('short', 1)], [], {
        options: ALL_OPTIONS,
      }),
    );
    expect(schedule.floats?.get('slow')?.isCritical).toBe(true);
    expect(schedule.floats?.get('slow')?.totalFloatHours).toBe(0);
    expect(schedule.floats?.get('short')?.isCritical).toBe(false);
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
      project([], [], { calendar: { ...DEFAULT_CALENDAR, workingWeekdays: [] } }),
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
      project([taskOf('a', 1), taskOf('b', 1)], [link('a', 'b'), link('b', 'a')]),
    );
    expect(!result.ok && result.error.kind).toBe('structure');
  });

  it('reports the task that cannot be placed', () => {
    const result = scheduleProject(project([taskOf('a', 1, { hoursPerDay: 99 })]));
    expect(result).toEqual({
      ok: false,
      error: { kind: 'task', error: { code: 'INVALID_HOURS_PER_DAY', taskId: 'a' } },
    });
  });

  it('reports a task pushed past the horizon by a dependency lag', () => {
    const tasks = [taskOf('a', 1, { startNoEarlierThan: at(2200, 12, 1, 9) }), taskOf('b', 1)];
    const result = scheduleProject(project(tasks, [link('a', 'b', 'finishToStart', 100_000)]));
    expect(result).toEqual({
      ok: false,
      error: { kind: 'task', error: { code: 'BEYOND_PLANNING_HORIZON', taskId: 'b' } },
    });
  });

  it('reports a task pulled before the horizon by a dependency lead', () => {
    const tasks = [taskOf('a', 1, { startNoEarlierThan: at(1970, 1, 5, 9) }), taskOf('b', 1)];
    const result = scheduleProject(
      project(tasks, [link('a', 'b', 'finishToStart', -50)], {
        startDate: at(1970, 1, 1, 9),
        options: ALL_OPTIONS,
      }),
    );
    expect(result).toEqual({
      ok: false,
      error: { kind: 'task', error: { code: 'BEYOND_PLANNING_HORIZON', taskId: 'b' } },
    });
  });
});
