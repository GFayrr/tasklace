import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { TEST_CALENDAR } from '../../core/testing/test-calendar';
import type { RegionalFormat } from '../../core/exchange/csv/regional-format';
import type { Project, Task } from '../../core/model/project';
import { createSharedDocument } from '../../core/shared/shared-document';
import { openSharedSession, type SharedSession } from '../../core/shared/shared-session';
import { at, compileOrThrow } from '../../core/testing/civil-time';
import {
  link,
  milestone,
  project,
  splitTask,
  summary,
  TEST_DOCUMENT_ID,
  workTask,
} from '../../core/testing/project-builder';
import { buildPlanOutline } from './plan-outline';
import {
  deleteTasks,
  indentTask,
  insertTask,
  linkTasks,
  moveStart,
  moveTask,
  outdentTask,
  parseDuration,
  renameTask,
  setDuration,
  setPredecessors,
  setProgress,
  setStart,
  stretchEnd,
  toggleMilestone,
  type Edit,
  type EditContext,
} from './task-commands';

const FRENCH: RegionalFormat = {
  listSeparator: ';',
  dateOrder: 'dayMonthYear',
  dateSeparator: '/',
  twelveHourClock: false,
};
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
    expect(inserted.ok).toBe(true);
    if (!inserted.ok) {
      return;
    }
    applied(session, { ok: true, value: inserted.value.operations });
    expect(rowsOf(session).slice(0, 4)).toEqual(['1 s', '1.1 a', '1.2 new1', '1.3 b']);
    expect(taskOf(session, 'new1')).toMatchObject({
      name: 'New task',
      segments: [{ durationHours: 7 }],
    });
    const last = insertTask(context(), null, 'Last');
    if (last.ok) {
      applied(session, { ok: true, value: last.value.operations });
    }
    expect(rowsOf(session).at(-1)).toBe(`5 ${last.ok ? last.value.taskId : ''}`);
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
    applied(session, setDuration(context(), 'a', '0'));
    expect(taskOf(session, 'a')?.kind).toBe('milestone');
    applied(session, setDuration(context(), 'a', '5 h'));
    expect(taskOf(session, 'a')).toMatchObject({ kind: 'task', segments: [{ durationHours: 5 }] });
    applied(session, setDuration(context(), 'd', '20'));
    expect(taskOf(session, 'd')).toMatchObject({
      segments: [{ durationHours: 7 }, { durationHours: 13, gapDaysBefore: 2 }],
    });
    expect(setDuration(context(), 'd', '7')).toEqual({ ok: false, error: 'INVALID_DURATION' });
    expect(setDuration(context(), 'a', 'soon')).toEqual({ ok: false, error: 'INVALID_DURATION' });
    expect(setDuration(context(), 's', '3')).toEqual({ ok: false, error: 'NOT_POSSIBLE' });
  });

  it.each([
    ['14', 14],
    ['14h', 14],
    ['14 H', 14],
    ['2d', 14],
    ['1,5d', 11],
    ['0.5 d', 4],
    ['0', 0],
    ['-3', null],
    ['1e3', null],
    ['', null],
    ['1'.repeat(80), null],
  ])('reads the duration %j as %s hours', (text, expected) => {
    expect(parseDuration(text, 7)).toBe(expected);
  });

  it('reads a start date in the regional format or as ISO, an empty text removing it', () => {
    const { session, context } = openPlan();
    applied(session, setStart(context(), 'c', '05/10/2026 14:00', FRENCH));
    expect(taskOf(session, 'c')).toMatchObject({ startNoEarlierThan: at(2026, 10, 5, 14) });
    applied(session, setStart(context(), 'c', '2026-10-06', FRENCH));
    expect(taskOf(session, 'c')).toMatchObject({ startNoEarlierThan: at(2026, 10, 6) });
    applied(session, setStart(context(), 'c', ' ', FRENCH));
    expect(taskOf(session, 'c')).toMatchObject({ startNoEarlierThan: null });
    expect(setStart(context(), 'c', '31/02/2026', FRENCH)).toEqual({
      ok: false,
      error: 'INVALID_DATE',
    });
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
      successorId: 'c',
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

  it('turns a work task into a milestone and back', () => {
    const { session, context } = openPlan();
    applied(session, toggleMilestone(context(), 'c'));
    expect(taskOf(session, 'c')?.kind).toBe('milestone');
    applied(session, toggleMilestone(context(), 'c'));
    expect(taskOf(session, 'c')).toMatchObject({ kind: 'task', segments: [{ durationHours: 7 }] });
    expect(toggleMilestone(context(), 's')).toEqual({ ok: false, error: 'NOT_POSSIBLE' });
  });
});

describe('dragging on the timeline', () => {
  it('asks a moved task not to start before its new place', () => {
    const { session, context } = openPlan();
    applied(session, moveStart(context(), 'm', at(2026, 10, 12)));
    expect(taskOf(session, 'm')).toMatchObject({ startNoEarlierThan: at(2026, 10, 12) });
    expect(moveStart(context(), 's', 0)).toEqual({ ok: false, error: 'NOT_POSSIBLE' });
  });

  it('stretches the last block to end at an instant, keeping at least one hour', () => {
    const { session, context } = openPlan();
    applied(session, stretchEnd(context(), 'c', at(2026, 9, 28, 9), at(2026, 9, 29, 17), CALENDAR));
    expect(taskOf(session, 'c')).toMatchObject({ segments: [{ durationHours: 14 }] });
    applied(session, stretchEnd(context(), 'c', at(2026, 9, 28, 9), at(2026, 9, 27), CALENDAR));
    expect(taskOf(session, 'c')).toMatchObject({ segments: [{ durationHours: 1 }] });
    expect(stretchEnd(context(), 'm', 0, 1, CALENDAR)).toEqual({
      ok: false,
      error: 'NOT_POSSIBLE',
    });
  });

  it('links two different tasks from the end of the first to the start of the second', () => {
    const { session, context } = openPlan();
    applied(session, linkTasks(context(), 'a', 'm'));
    expect(session.project().dependencies).toContainEqual({
      id: 'new1',
      predecessorId: 'a',
      successorId: 'm',
      type: 'finishToStart',
      lagHours: 0,
    });
    expect(linkTasks(context(), 'a', 'a')).toEqual({ ok: false, error: 'NOT_POSSIBLE' });
  });
});

describe('any sequence of structural edits', () => {
  it('keeps a valid project that the session accepts, or is refused without change', () => {
    const edits = fc.array(
      fc.tuple(
        fc.constantFrom('insert', 'delete', 'indent', 'outdent', 'up', 'down', 'milestone'),
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
              ? (() => {
                  const inserted = insertTask(current, id, 'New');
                  return inserted.ok ? { ok: true, value: inserted.value.operations } : inserted;
                })()
              : kind === 'delete'
                ? deleteTasks(current, [id])
                : kind === 'indent'
                  ? indentTask(current, id)
                  : kind === 'outdent'
                    ? outdentTask(current, id)
                    : kind === 'milestone'
                      ? toggleMilestone(current, id)
                      : moveTask(current, id, kind === 'up' ? -1 : 1);
          if (edit.ok) {
            expect(session.applyAll(edit.value).ok).toBe(true);
          }
        }
        const outline = buildPlanOutline(session.project().tasks, new Set());
        expect(outline.rows).toHaveLength(session.project().tasks.length);
      }),
    );
  });
});
