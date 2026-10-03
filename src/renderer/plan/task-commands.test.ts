import { describe, expect, it } from 'vitest';
import { END_PROJECT_HOUR } from '../../core/time';
import fc from 'fast-check';
import { TEST_CALENDAR } from '../../core/testing/test-calendar';
import type { Project, Task, WorkTask } from '../../core/model/project';
import { createSharedDocument } from '../../core/shared/shared-document';
import { openSharedSession, type SharedSession } from '../../core/shared/shared-session';
import { at, compileOrThrow } from '../../core/testing/civil-time';
import {
  blockLink,
  link,
  milestone,
  project,
  scheduleOrThrow,
  splitTask,
  summary,
  TEST_DOCUMENT_ID,
  workTask,
} from '../../core/testing/project-builder';
import { buildPlanOutline, predecessorText } from './plan-outline';
import {
  deleteTasks,
  indentTask,
  insertTask,
  linkTasks,
  moveBlock,
  moveOnTimeline,
  moveStart,
  moveTask,
  outdentTask,
  renameTask,
  setDuration,
  setEnd,
  setPredecessors,
  setProgress,
  setTag,
  replaceTask,
  setStart,
  stretchEnd,
  stretchOnTimeline,
  toggleMilestone,
  findBlockWaitProblem,
  type Edit,
  type EditContext,
  type LinkEnd,
} from './task-commands';

const CALENDAR = compileOrThrow(TEST_CALENDAR);
const PLAN = project(
  [
    summary('s', { sortKey: 'a' }),
    workTask('a', { parentId: 's', sortKey: 'a' }),
    workTask('b', { parentId: 's', sortKey: 'b' }),
    workTask('c', { sortKey: 'b' }),
    splitTask(
      'd',
      [
        [7, 0],
        [7, 2],
      ],
      { sortKey: 'c' },
    ),
    milestone('m', { sortKey: 'd' }),
  ],
  [link('a', 'b'), link('b', 'c'), link('c', 'd')],
);

/** Returns the task an edit writes, or undefined when it writes none or is refused. */
function writtenTask(edit: Edit): Task | undefined {
  if (!edit.ok) {
    return undefined;
  }
  const operation = edit.value.find((candidate) => candidate.type === 'putTask');
  return operation?.type === 'putTask' ? operation.task : undefined;
}

/** Names a whole task as one end of a link. */
function whole(taskId: string): LinkEnd {
  return { taskId, block: null };
}

/** Opens a session on the sample plan and returns an edit context that follows it. */
function openPlan(plan: Project = PLAN) {
  const opened = openSharedSession(createSharedDocument(plan, TEST_DOCUMENT_ID));
  if (!opened.ok) {
    throw new Error(JSON.stringify(opened.error));
  }
  const session = opened.value;
  let next = 0;
  const context = (): EditContext => {
    const current = session.project();
    return {
      project: current,
      outline: buildPlanOutline(current.tasks, new Set()),
      createId: () => `new${String((next += 1))}`,
      dayHours: 7,
    };
  };
  return { session, context };
}

/** Applies an edit to a session, failing the test when the edit or the session refuses it. */
function applied(session: SharedSession, edit: Edit): void {
  expect(edit.ok).toBe(true);
  if (edit.ok) {
    expect(session.applyAll(edit.value)).toEqual({ ok: true, value: undefined });
  }
}

/** Returns the order of the rows of a session with their WBS numbers. */
function rowsOf(session: SharedSession): string[] {
  return buildPlanOutline(session.project().tasks, new Set()).rows.map(
    (row) => `${row.wbs} ${row.task.id}`,
  );
}

/** Orders the lists of a project by identifier, so that two projects compare by content. */
function normalized(plan: Project): Project {
  const byId = <T extends { readonly id: string }>(items: readonly T[]) =>
    [...items].sort((left, right) => (left.id < right.id ? -1 : 1));
  return {
    ...plan,
    tasks: byId(plan.tasks),
    dependencies: byId(plan.dependencies),
    tags: byId(plan.tags),
  };
}

/** Finds a task of a session. */
function taskOf(session: SharedSession, id: string): Task | undefined {
  return session.project().tasks.find((task) => task.id === id);
}

describe('adding, deleting and reordering tasks', () => {
  it('adds a one-day task after the selected one, or at the end', () => {
    const { session, context } = openPlan();
    const inserted = insertTask(context(), 'a', 'New task');
    applied(session, { ok: true, value: inserted.operations });
    expect(rowsOf(session).slice(0, 4)).toEqual(['1 s', '1.1 a', '1.2 new1', '1.3 b']);
    expect(taskOf(session, 'new1')).toMatchObject({
      name: 'New task',
      segments: [{ durationHours: 7 }],
    });
    const last = insertTask(context(), null, 'Last');
    applied(session, { ok: true, value: last.operations });
    expect(rowsOf(session).at(-1)).toBe(`5 ${last.taskId}`);
  });

  it('deletes a summary with everything under it and their links', () => {
    const { session, context } = openPlan();
    applied(session, deleteTasks(context(), ['s']));
    expect(rowsOf(session)).toEqual(['1 c', '2 d', '3 m']);
    expect(session.project().dependencies).toEqual([link('c', 'd')]);
    expect(deleteTasks(context(), ['unknown'])).toEqual({ ok: false, error: 'NOT_POSSIBLE' });
  });

  it('moves a task up and down among its siblings only', () => {
    const { session, context } = openPlan();
    applied(session, moveTask(context(), 'b', -1));
    expect(rowsOf(session).slice(0, 3)).toEqual(['1 s', '1.1 b', '1.2 a']);
    expect(moveTask(context(), 'b', -1)).toEqual({ ok: false, error: 'NOT_POSSIBLE' });
    applied(session, moveTask(context(), 'd', 1));
    expect(rowsOf(session).slice(-2)).toEqual(['3 m', '4 d']);
    expect(moveTask(context(), 'd', 1)).toEqual({ ok: false, error: 'NOT_POSSIBLE' });
  });

  it('spreads the keys of siblings again when two of them share a key', () => {
    const tied = project([
      workTask('x', { sortKey: 'k' }),
      workTask('y', { sortKey: 'k' }),
      workTask('z', { sortKey: 'k' }),
    ]);
    const { session, context } = openPlan(tied);
    applied(session, moveTask(context(), 'z', -1));
    expect(rowsOf(session)).toEqual(['1 x', '2 z', '3 y']);
  });
});

describe('indenting and outdenting', () => {
  it('puts a task under the one above, which becomes a summary without links', () => {
    const { session, context } = openPlan();
    applied(session, indentTask(context(), 'd'));
    expect(taskOf(session, 'c')?.kind).toBe('summary');
    expect(taskOf(session, 'd')?.parentId).toBe('c');
    expect(session.project().dependencies).toEqual([link('a', 'b')]);
    expect(rowsOf(session)).toEqual(['1 s', '1.1 a', '1.2 b', '2 c', '2.1 d', '3 m']);
    session.history.undo();
    expect(normalized(session.project())).toEqual(normalized(PLAN));
  });

  it('adds a task at the end of a summary above it', () => {
    const { session, context } = openPlan();
    applied(session, indentTask(context(), 'c'));
    expect(rowsOf(session).slice(0, 4)).toEqual(['1 s', '1.1 a', '1.2 b', '1.3 c']);
    expect(indentTask(context(), 'a')).toEqual({ ok: false, error: 'NOT_POSSIBLE' });
  });

  it('moves a task out of its summary, right after it', () => {
    const { session, context } = openPlan();
    applied(session, outdentTask(context(), 'a'));
    expect(rowsOf(session)).toEqual(['1 s', '1.1 b', '2 a', '3 c', '4 d', '5 m']);
    expect(outdentTask(context(), 'c')).toEqual({ ok: false, error: 'NOT_POSSIBLE' });
  });
});

describe('editing cells', () => {
  it('renames a task and refuses an empty name', () => {
    const { session, context } = openPlan();
    applied(session, renameTask(context(), 'a', '  Plan  '));
    expect(taskOf(session, 'a')?.name).toBe('Plan');
    expect(renameTask(context(), 'a', '  ')).toEqual({ ok: false, error: 'INVALID_NAME' });
  });

  it('reads durations in hours or working days, turning zero into a milestone and back', () => {
    const { session, context } = openPlan();
    applied(session, setDuration(context(), 'a', '2d'));
    expect(taskOf(session, 'a')).toMatchObject({ segments: [{ durationHours: 14 }] });
    applied(session, setDuration(context(), 'a', '1 h 30'));
    expect(taskOf(session, 'a')).toMatchObject({ segments: [{ durationHours: 1.5 }] });
    applied(session, setDuration(context(), 'a', '0'));
    expect(taskOf(session, 'a')?.kind).toBe('milestone');
    applied(session, setDuration(context(), 'a', '5 h'));
    expect(taskOf(session, 'a')).toMatchObject({ kind: 'task', segments: [{ durationHours: 5 }] });
    applied(session, setDuration(context(), 'd', '20'));
    expect(taskOf(session, 'd')).toMatchObject({
      segments: [
        { durationHours: 7 },
        { durationHours: 13, gapDaysBefore: 2, startNoEarlierThan: null },
      ],
    });
    expect(setDuration(context(), 'd', '7')).toEqual({ ok: false, error: 'INVALID_DURATION' });
    expect(setDuration(context(), 'a', 'soon')).toEqual({ ok: false, error: 'INVALID_DURATION' });
    expect(setDuration(context(), 's', '3')).toEqual({ ok: false, error: 'NOT_POSSIBLE' });
  });

  it('reads a start date only as ISO, with or without a time, an empty text removing it', () => {
    const { session, context } = openPlan();
    applied(session, setStart(context(), 'c', '2026-10-05 14:00'));
    expect(taskOf(session, 'c')).toMatchObject({ startNoEarlierThan: at(2026, 10, 5, 14) });
    applied(session, setStart(context(), 'c', '2026-10-06'));
    expect(taskOf(session, 'c')).toMatchObject({ startNoEarlierThan: at(2026, 10, 6) });
    applied(session, setStart(context(), 'c', ' '));
    expect(taskOf(session, 'c')).toMatchObject({ startNoEarlierThan: null });
    applied(session, setStart(context(), 'c', '2026-10-07T09:45'));
    expect(taskOf(session, 'c')).toMatchObject({ startNoEarlierThan: at(2026, 10, 7, 9) + 0.75 });
    for (const text of [
      '2026-02-31',
      '05/10/2026',
      '2026/10/05',
      '2026-10-05 9:00',
      '2026-10-05 09:10',
    ]) {
      expect(setStart(context(), 'c', text)).toEqual({ ok: false, error: 'INVALID_DATE' });
    }
  });

  it('sets the end of a task through the duration of its last block, or moves a milestone', () => {
    const { session, context } = openPlan();
    const placed = { lastBlockStart: at(2026, 9, 28, 9), calendar: CALENDAR };
    applied(session, setEnd(context(), 'c', '2026-09-28 11:30', placed));
    expect(taskOf(session, 'c')).toMatchObject({ segments: [{ durationHours: 2.5 }] });
    applied(session, setEnd(context(), 'c', '2026-09-29', placed));
    expect(taskOf(session, 'c')).toMatchObject({ segments: [{ durationHours: 14 }] });
    expect(setEnd(context(), 'c', '2026-09-28 08:00', placed)).toEqual({
      ok: false,
      error: 'INVALID_END',
    });
    expect(setEnd(context(), 'c', 'soon', placed)).toEqual({
      ok: false,
      error: 'INVALID_DATE',
    });
    applied(session, setEnd(context(), 'm', '2026-10-02 15:00', placed));
    expect(taskOf(session, 'm')).toMatchObject({ startNoEarlierThan: at(2026, 10, 2, 15) });
  });

  it('moves the project start to the day of a task placed before it', () => {
    const { session, context } = openPlan();
    applied(session, setStart(context(), 'c', '2026-09-21 10:15'));
    expect(session.project().startDate).toBe(at(2026, 9, 21));
    expect(taskOf(session, 'c')).toMatchObject({ startNoEarlierThan: at(2026, 9, 21, 10) + 0.25 });
    applied(session, moveStart(context(), 'm', at(2026, 9, 14, 9)));
    expect(session.project().startDate).toBe(at(2026, 9, 14));
    session.history.undo();
    expect(session.project().startDate).toBe(at(2026, 9, 21));
  });

  it('reads a whole progress from 0 to 100', () => {
    const { session, context } = openPlan();
    applied(session, setProgress(context(), 'a', '45 %'));
    expect(taskOf(session, 'a')).toMatchObject({ progressPercent: 45 });
    for (const text of ['101', '-1', '4.5', 'half', '']) {
      expect(setProgress(context(), 'a', text)).toEqual({ ok: false, error: 'INVALID_PROGRESS' });
    }
    expect(setProgress(context(), 's', '10')).toEqual({ ok: false, error: 'NOT_POSSIBLE' });
  });

  it('replaces predecessors, keeping the identifiers of the links that stay', () => {
    const { session, context } = openPlan();
    applied(session, setPredecessors(context(), 'c', '1.1SS+2h, 1.2'));
    const incoming = session
      .project()
      .dependencies.filter((dependency) => dependency.successorId === 'c');
    expect(incoming).toContainEqual(link('b', 'c'));
    expect(incoming).toContainEqual({
      id: 'new1',
      predecessorId: 'a',
      predecessorBlock: null,
      successorId: 'c',
      successorBlock: null,
      type: 'startToStart',
      lagHours: 2,
    });
    applied(session, setPredecessors(context(), 'c', ''));
    expect(
      session.project().dependencies.filter((dependency) => dependency.successorId === 'c'),
    ).toEqual([]);
    expect(setPredecessors(context(), 'c', '9')).toEqual({
      ok: false,
      error: 'UNKNOWN_TASK_NUMBER',
    });
    expect(setPredecessors(context(), 'c', '1.1, 1.1FF')).toEqual({
      ok: false,
      error: 'INVALID_PREDECESSORS',
    });
    expect(setPredecessors(context(), 'c', 'soon')).toEqual({
      ok: false,
      error: 'INVALID_PREDECESSORS',
    });
  });

  it('lets the session refuse a link that would close a loop', () => {
    const { session, context } = openPlan();
    const edit = setPredecessors(context(), 'a', '1.2');
    expect(edit.ok && session.applyAll(edit.value).ok).toBe(false);
    expect(normalized(session.project())).toEqual(normalized(PLAN));
  });

  it('gives a task a known tag or none, never to a summary', () => {
    const tagged = project(PLAN.tasks, PLAN.dependencies, {
      tags: [{ id: 'design', name: 'Design', color: '#2a78d6', representsPersonOrTeam: false }],
    });
    const { session, context } = openPlan(tagged);
    applied(session, setTag(context(), 'a', 'design'));
    expect(taskOf(session, 'a')).toMatchObject({ tagId: 'design' });
    applied(session, setTag(context(), 'a', null));
    expect(taskOf(session, 'a')).toMatchObject({ tagId: null });
    expect(setTag(context(), 'a', 'unknown')).toEqual({ ok: false, error: 'NOT_POSSIBLE' });
    expect(setTag(context(), 's', 'design')).toEqual({ ok: false, error: 'NOT_POSSIBLE' });
  });

  it('replaces a task by its edited version, moving the project start when needed', () => {
    const { session, context } = openPlan();
    const task = taskOf(session, 'c');
    if (task?.kind !== 'task') {
      throw new Error('c');
    }
    applied(
      session,
      replaceTask(context(), { ...task, name: 'C', startNoEarlierThan: at(2026, 9, 21, 10) }),
    );
    expect(taskOf(session, 'c')).toMatchObject({ name: 'C' });
    expect(session.project().startDate).toBe(at(2026, 9, 21));
    expect(replaceTask(context(), workTask('unknown'))).toEqual({
      ok: false,
      error: 'NOT_POSSIBLE',
    });
  });

  it('turns a work task into a milestone and back', () => {
    const { session, context } = openPlan();
    applied(session, toggleMilestone(context(), 'c'));
    expect(taskOf(session, 'c')?.kind).toBe('milestone');
    applied(session, toggleMilestone(context(), 'c'));
    expect(taskOf(session, 'c')).toMatchObject({ kind: 'task', segments: [{ durationHours: 7 }] });
    expect(toggleMilestone(context(), 's')).toEqual({ ok: false, error: 'NOT_POSSIBLE' });
  });
});

const SPLIT_WITH_WAIT = project(
  [
    workTask('a', { sortKey: 'a' }),
    splitTask(
      'd',
      [
        [7, 0],
        [7, 1],
      ],
      { sortKey: 'b' },
    ),
  ],
  [blockLink('a', 'd', { to: 1 })],
);

/** Returns a work task of a session, failing the test when it is not one. */
function workTaskOf(session: SharedSession, id: string): WorkTask {
  const task = taskOf(session, id);
  if (task?.kind !== 'task') {
    throw new Error(`Missing work task ${id}`);
  }
  return task;
}

describe('moving a later block alone', () => {
  it('asks the block not to start before the instant, its gap becoming the days since the previous block', () => {
    const { session, context } = openPlan(SPLIT_WITH_WAIT);
    applied(
      session,
      moveBlock(context(), 'd', 1, {
        start: at(2026, 10, 2, 14),
        previousEnd: at(2026, 9, 28, 17),
      }),
    );
    expect(workTaskOf(session, 'd').segments[1]).toEqual({
      durationHours: 7,
      gapDaysBefore: 4,
      startNoEarlierThan: at(2026, 10, 2, 14),
    });
    applied(
      session,
      moveBlock(context(), 'd', 1, {
        start: at(2026, 9, 28, 15),
        previousEnd: at(2026, 9, 28, 17),
      }),
    );
    expect(workTaskOf(session, 'd').segments[1]).toMatchObject({
      gapDaysBefore: 0,
      startNoEarlierThan: null,
    });
  });

  it('moves the dates of the later blocks with the task when its whole bar moves', () => {
    const dated = project([
      splitTask('d', [
        [7, 0],
        [7, 1, at(2026, 10, 5, 13)],
      ]),
    ]);
    const { session, context } = openPlan(dated);
    applied(session, moveStart(context(), 'd', at(2026, 9, 30, 9), at(2026, 9, 28, 9)));
    expect(workTaskOf(session, 'd')).toMatchObject({
      startNoEarlierThan: at(2026, 9, 30, 9),
      segments: [{ startNoEarlierThan: null }, { startNoEarlierThan: at(2026, 10, 7, 13) }],
    });
    applied(session, moveStart(context(), 'd', at(2026, 10, 1, 9)));
    expect(workTaskOf(session, 'd').segments[1]?.startNoEarlierThan).toBe(at(2026, 10, 7, 13));
  });

  it('chooses on the timeline between moving a later block, moving the whole task, and refusing what the schedule no longer shows', () => {
    const { session, context } = openPlan(SPLIT_WITH_WAIT);
    const placement = scheduleOrThrow(session.project()).placements.get('d');
    const later = (from: number) => from + 24;
    const asked = writtenTask(moveOnTimeline(context(), 'd', 1, placement, later));
    expect(asked).toMatchObject({
      segments: [
        { startNoEarlierThan: null },
        { startNoEarlierThan: (placement?.segments[1]?.start ?? 0) + 24 },
      ],
    });
    const whole = writtenTask(moveOnTimeline(context(), 'd', null, placement, later));
    expect(whole).toMatchObject({ startNoEarlierThan: (placement?.start ?? 0) + 24 });
    const notPossible = { ok: false, error: 'NOT_POSSIBLE' };
    expect(moveOnTimeline(context(), 'd', 4, placement, later)).toEqual(notPossible);
    expect(moveOnTimeline(context(), 'd', 1, undefined, later)).toEqual(notPossible);
  });

  it('stretches the bar dropped on the timeline, and refuses without its placement or the calendar', () => {
    const { session, context } = openPlan();
    const placement = scheduleOrThrow(session.project()).placements.get('c');
    const stretched = stretchOnTimeline(
      context(),
      'c',
      { placement, calendar: CALENDAR },
      (end) => end + 24,
    );
    expect(writtenTask(stretched)).toMatchObject({ segments: [{ durationHours: 14 }] });
    const notPossible = { ok: false, error: 'NOT_POSSIBLE' };
    const later = (end: number) => end + 24;
    expect(
      stretchOnTimeline(context(), 'c', { placement: undefined, calendar: CALENDAR }, later),
    ).toEqual(notPossible);
    expect(stretchOnTimeline(context(), 'c', { placement, calendar: null }, later)).toEqual(
      notPossible,
    );
  });

  it('refuses the first block, a block the task does not have, and a task that is not split', () => {
    const { context } = openPlan(SPLIT_WITH_WAIT);
    const notPossible = { ok: false, error: 'NOT_POSSIBLE' };
    const hour = at(2026, 10, 2, 14);
    expect(moveBlock(context(), 'd', 0, { start: hour, previousEnd: hour })).toEqual(notPossible);
    expect(moveBlock(context(), 'd', 2, { start: hour, previousEnd: hour })).toEqual(notPossible);
    expect(moveBlock(context(), 'a', 1, { start: hour, previousEnd: hour })).toEqual(notPossible);
  });
});

describe('block edits refused with a reason', () => {
  it('refuses to merge two different links when a split task loses its blocks or becomes a milestone', () => {
    const plan = project(SPLIT_WITH_WAIT.tasks, [
      blockLink('a', 'd', { to: 1 }, 'startToStart', 4),
      blockLink('a', 'd', {}),
    ]);
    const { session, context } = openPlan(plan);
    const task = workTaskOf(session, 'd');
    expect(toggleMilestone(context(), 'd')).toEqual({ ok: false, error: 'LINKS_WOULD_MERGE' });
    const lastOnly = task.segments.slice(1).map((segment) => ({ ...segment, gapDaysBefore: 0 }));
    expect(
      replaceTask(context(), { ...task, segments: lastOnly }, [{ origin: 1, waitsFor: '1SS+4h' }]),
    ).toEqual({ ok: false, error: 'LINKS_WOULD_MERGE' });
  });

  it('refuses blocks that do not match the task or change the order of its blocks', () => {
    const { session, context } = openPlan(SPLIT_WITH_WAIT);
    const task = workTaskOf(session, 'd');
    const notPossible = { ok: false, error: 'NOT_POSSIBLE' };
    expect(replaceTask(context(), task, [{ origin: 0, waitsFor: '' }])).toEqual(notPossible);
    expect(
      replaceTask(context(), task, [
        { origin: 1, waitsFor: '' },
        { origin: 0, waitsFor: '' },
      ]),
    ).toEqual(notPossible);
    expect(
      replaceTask(context(), task, [
        { origin: null, waitsFor: '' },
        { origin: 0, waitsFor: '' },
      ]),
    ).toEqual(notPossible);
  });

  it('keeps what the last block waited for once it is the only block, unless its waits were changed', () => {
    const { session, context } = openPlan(SPLIT_WITH_WAIT);
    const task = workTaskOf(session, 'd');
    const single = {
      ...task,
      segments: task.segments.slice(1).map((segment) => ({ ...segment, gapDaysBefore: 0 })),
    };
    expect(replaceTask(context(), single, [{ origin: 1, waitsFor: '' }])).toEqual({
      ok: false,
      error: 'WAITS_NEED_TWO_BLOCKS',
    });
    applied(session, replaceTask(context(), single, [{ origin: 1, waitsFor: '1' }]));
    expect(session.project().dependencies).toEqual([
      { ...blockLink('a', 'd', { to: 1 }), successorBlock: null },
    ]);
  });

  it('tells which block names a task or block that does not exist', () => {
    const { context } = openPlan(SPLIT_WITH_WAIT);
    const waits = (second: string) => [
      { origin: 0, waitsFor: '' },
      { origin: 1, waitsFor: second },
    ];
    expect(findBlockWaitProblem(context(), waits('1'))).toBeNull();
    expect(findBlockWaitProblem(context(), waits('9'))).toEqual({
      block: 1,
      error: 'UNKNOWN_TASK_NUMBER',
    });
    expect(findBlockWaitProblem(context(), waits('soon'))).toEqual({
      block: 1,
      error: 'INVALID_PREDECESSORS',
    });
    expect(findBlockWaitProblem(context(), waits('2#3'))).toEqual({
      block: 1,
      error: 'UNKNOWN_BLOCK',
    });
  });

  it('refuses a gesture on a block a split task does not have, and reads a block of a task that is not split as the whole task', () => {
    const { session, context } = openPlan(SPLIT_WITH_WAIT);
    expect(linkTasks(context(), { taskId: 'd', block: 5 }, { taskId: 'a', block: null })).toEqual({
      ok: false,
      error: 'UNKNOWN_BLOCK',
    });
    applied(session, linkTasks(context(), { taskId: 'a', block: 3 }, { taskId: 'd', block: 0 }));
    expect(session.project().dependencies).toContainEqual(
      expect.objectContaining({ id: 'new1', predecessorBlock: null, successorBlock: null }),
    );
  });

  it('writes a block that the whole task stands for anyway as the whole task', () => {
    const { session, context } = openPlan();
    applied(session, setPredecessors(context(), 'm', '3#2'));
    expect(session.project().dependencies).toContainEqual(
      expect.objectContaining({ predecessorId: 'd', predecessorBlock: null, successorId: 'm' }),
    );
  });
});

describe('links to and from blocks', () => {
  it('writes the predecessors of one block, with blocks of other tasks, apart from those of the task', () => {
    const { session, context } = openPlan();
    applied(session, setPredecessors(context(), 'd', '1.1SS+1h', 1));
    applied(session, setPredecessors(context(), 'm', '3#1'));
    const links = session.project().dependencies;
    expect(links).toContainEqual(link('c', 'd'));
    expect(links).toContainEqual(
      expect.objectContaining({ predecessorId: 'a', successorId: 'd', successorBlock: 1 }),
    );
    expect(links).toContainEqual(
      expect.objectContaining({ predecessorId: 'd', predecessorBlock: 0, successorId: 'm' }),
    );
    expect(setPredecessors(context(), 'm', '3#3')).toEqual({ ok: false, error: 'UNKNOWN_BLOCK' });
    expect(setPredecessors(context(), 'm', '2#1')).toEqual({ ok: false, error: 'UNKNOWN_BLOCK' });
    expect(setPredecessors(context(), 'c', '1.1', 0)).toEqual({ ok: false, error: 'NOT_POSSIBLE' });
  });

  it('moves the links of the blocks that stay when a block is removed, and drops those of the removed block', () => {
    const plan = project(
      [
        workTask('a', { sortKey: 'a' }),
        splitTask(
          'd',
          [
            [7, 0],
            [7, 1],
            [7, 1],
          ],
          { sortKey: 'b' },
        ),
        workTask('e', { sortKey: 'c' }),
      ],
      [blockLink('a', 'd', { to: 1 }), blockLink('d', 'e', { from: 2 })],
    );
    const { session, context } = openPlan(plan);
    const task = taskOf(session, 'd');
    if (task?.kind !== 'task') {
      throw new Error('Missing task');
    }
    const kept = [task.segments[0], task.segments[2]].filter((segment) => segment !== undefined);
    applied(
      session,
      replaceTask(context(), { ...task, segments: kept }, [
        { origin: 0, waitsFor: '' },
        { origin: 2, waitsFor: '1' },
      ]),
    );
    const links = normalized(session.project()).dependencies;
    expect(links.map((dependency) => dependency.id)).not.toContain('a-d_1');
    expect(links).toEqual([
      { ...blockLink('d', 'e', { from: 2 }), predecessorBlock: 1 },
      expect.objectContaining({ predecessorId: 'a', successorId: 'd', successorBlock: 1 }),
    ]);
  });

  it('points the links of the blocks at the whole task once one block is left, keeping one link per pair', () => {
    const plan = project(
      [
        workTask('a', { sortKey: 'a' }),
        splitTask(
          'd',
          [
            [7, 0],
            [7, 1],
          ],
          { sortKey: 'b' },
        ),
      ],
      [blockLink('a', 'd', { to: 1 }), { ...blockLink('a', 'd', {}), id: 'z' }],
    );
    const { session, context } = openPlan(plan);
    const task = taskOf(session, 'd');
    if (task?.kind !== 'task') {
      throw new Error('Missing task');
    }
    applied(
      session,
      replaceTask(context(), { ...task, segments: task.segments.slice(0, 1) }, [
        { origin: 0, waitsFor: '' },
      ]),
    );
    expect(session.project().dependencies.map((dependency) => dependency.id)).toEqual(['z']);
  });

  it('points the links of the blocks at the whole task when a split task becomes a milestone', () => {
    const plan = project(
      [
        workTask('a', { sortKey: 'a' }),
        splitTask(
          'd',
          [
            [7, 0],
            [7, 1],
          ],
          { sortKey: 'b' },
        ),
      ],
      [blockLink('a', 'd', { to: 1 })],
    );
    const { session, context } = openPlan(plan);
    applied(session, toggleMilestone(context(), 'd'));
    expect(session.project().dependencies).toEqual([
      { ...blockLink('a', 'd', { to: 1 }), successorBlock: null },
    ]);
  });
});

describe('dragging on the timeline', () => {
  it('asks a moved task not to start before its new place', () => {
    const { session, context } = openPlan();
    applied(session, moveStart(context(), 'm', at(2026, 10, 12)));
    expect(taskOf(session, 'm')).toMatchObject({ startNoEarlierThan: at(2026, 10, 12) });
    expect(moveStart(context(), 's', 0)).toEqual({ ok: false, error: 'NOT_POSSIBLE' });
  });

  it('stretches the last block to end at an instant, keeping at least a quarter hour', () => {
    const { session, context } = openPlan();
    applied(session, stretchEnd(context(), 'c', at(2026, 9, 28, 9), at(2026, 9, 29, 17), CALENDAR));
    expect(taskOf(session, 'c')).toMatchObject({ segments: [{ durationHours: 14 }] });
    applied(session, stretchEnd(context(), 'c', at(2026, 9, 28, 9), at(2026, 9, 27), CALENDAR));
    expect(taskOf(session, 'c')).toMatchObject({ segments: [{ durationHours: 0.25 }] });
    expect(stretchEnd(context(), 'm', 0, 1, CALENDAR)).toEqual({
      ok: false,
      error: 'NOT_POSSIBLE',
    });
  });

  it('refuses to stretch a bar to an end the calendar does not cover', () => {
    const { context } = openPlan();
    expect(stretchEnd(context(), 'c', at(2026, 9, 28, 9), END_PROJECT_HOUR, CALENDAR)).toEqual({
      ok: false,
      error: 'OUT_OF_RANGE',
    });
  });

  it('links two different tasks from the end of the first to the start of the second', () => {
    const { session, context } = openPlan();
    applied(session, linkTasks(context(), whole('a'), whole('m')));
    expect(session.project().dependencies).toContainEqual({
      id: 'new1',
      predecessorId: 'a',
      predecessorBlock: null,
      successorId: 'm',
      successorBlock: null,
      type: 'finishToStart',
      lagHours: 0,
    });
    expect(linkTasks(context(), whole('a'), whole('a'))).toEqual({
      ok: false,
      error: 'NOT_POSSIBLE',
    });
  });

  it('links from a block or to a block of a split task, a block another task lacks meaning the whole task', () => {
    const { session, context } = openPlan();
    applied(session, linkTasks(context(), { taskId: 'd', block: 0 }, { taskId: 'm', block: 1 }));
    applied(session, linkTasks(context(), whole('a'), { taskId: 'd', block: 1 }));
    expect(session.project().dependencies).toContainEqual(
      expect.objectContaining({ predecessorId: 'd', predecessorBlock: 0, successorBlock: null }),
    );
    expect(session.project().dependencies).toContainEqual(
      expect.objectContaining({ predecessorId: 'a', successorId: 'd', successorBlock: 1 }),
    );
  });
});

const REFUSABLE_EDITS: ReadonlySet<string> = new Set(['linkBlock', 'dropBlock']);
const EXPECTED_BLOCK_REFUSALS: ReadonlySet<string> = new Set([
  'NOT_POSSIBLE',
  'UNKNOWN_BLOCK',
  'LINKS_WOULD_MERGE',
  'WAITS_NEED_TWO_BLOCKS',
  'DEPENDENCY_CYCLE',
  'SUMMARY_DEPENDENCY',
  'DUPLICATE_DEPENDENCY',
]);

/** Builds an edit of the blocks of a task: a link from the first block of the split task to it, or the removal of its first block, or one more block waiting for nothing, every other block keeping what it waits for. */
function blockEdit(context: EditContext, kind: string, id: string): Edit {
  const task = context.project.tasks.find((candidate) => candidate.id === id);
  if (kind === 'linkBlock') {
    return linkTasks(context, { taskId: 'd', block: 0 }, { taskId: id, block: 1 });
  }
  if (task?.kind !== 'task') {
    return { ok: false, error: 'NOT_POSSIBLE' };
  }
  const incoming = context.project.dependencies.filter((link) => link.successorId === id);
  const blocks = task.segments.map((_segment, origin) => ({
    origin,
    waitsFor: predecessorText(incoming, context.outline.wbsById, origin),
  }));
  if (kind === 'addBlock') {
    return replaceTask(
      context,
      {
        ...task,
        segments: [
          ...task.segments,
          { durationHours: 2, gapDaysBefore: 0, startNoEarlierThan: null },
        ],
      },
      [...blocks, { origin: null, waitsFor: '' }],
    );
  }
  const [first, ...rest] = task.segments;
  if (first === undefined || rest.length === 0) {
    return { ok: false, error: 'NOT_POSSIBLE' };
  }
  const segments = rest.map((segment, index) =>
    index === 0 ? { ...segment, gapDaysBefore: 0 } : segment,
  );
  return replaceTask(context, { ...task, segments }, blocks.slice(1));
}

describe('any sequence of structural edits', () => {
  it('keeps a valid project that the session accepts, or is refused without change', () => {
    const edits = fc.array(
      fc.tuple(
        fc.constantFrom(
          'insert',
          'delete',
          'indent',
          'outdent',
          'up',
          'down',
          'milestone',
          'linkBlock',
          'dropBlock',
          'addBlock',
        ),
        fc.constantFrom('s', 'a', 'b', 'c', 'd', 'm', 'new1', 'new2'),
      ),
      { maxLength: 12 },
    );
    fc.assert(
      fc.property(edits, (steps) => {
        const { session, context } = openPlan();
        for (const [kind, id] of steps) {
          const current = context();
          const edit: Edit =
            kind === 'insert'
              ? { ok: true, value: insertTask(current, id, 'New').operations }
              : kind === 'delete'
                ? deleteTasks(current, [id])
                : kind === 'indent'
                  ? indentTask(current, id)
                  : kind === 'outdent'
                    ? outdentTask(current, id)
                    : kind === 'milestone'
                      ? toggleMilestone(current, id)
                      : kind === 'up' || kind === 'down'
                        ? moveTask(current, id, kind === 'up' ? -1 : 1)
                        : blockEdit(current, kind, id);
          const before = normalized(session.project());
          const applied = edit.ok ? session.applyAll(edit.value) : null;
          if (edit.ok && !REFUSABLE_EDITS.has(kind)) {
            expect(applied?.ok).toBe(true);
          }
          const refusal = edit.ok
            ? applied?.ok === false
              ? applied.error[0]?.code
              : null
            : edit.error;
          if (REFUSABLE_EDITS.has(kind) && refusal !== null) {
            expect(EXPECTED_BLOCK_REFUSALS.has(refusal ?? '')).toBe(true);
          }
          if (applied?.ok !== true) {
            expect(normalized(session.project())).toEqual(before);
          }
        }
        const outline = buildPlanOutline(session.project().tasks, new Set());
        expect(outline.rows).toHaveLength(session.project().tasks.length);
      }),
    );
  });
});
