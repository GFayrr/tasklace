import { afterEach, describe, expect, it, vi } from 'vitest';
import { project, workTask } from '../../core/testing/project-builder';
import english from '../locales/en.json';
import { draftFromTask } from '../plan/task-details';
import { AppState } from './app-state.svelte';
import { fakeAppContext, openedProjectOf } from './testing/fake-app-context';

const compiling = vi.hoisted(() => ({ broken: false }));

vi.mock('../../core/calendar/compile-calendar', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../core/calendar/compile-calendar')>();
  return {
    ...original,
    compileCalendar: (...values: Parameters<typeof original.compileCalendar>) =>
      compiling.broken
        ? { ok: false, error: 'NO_WORKING_DAY' }
        : original.compileCalendar(...values),
  };
});

afterEach(() => {
  compiling.broken = false;
});

const LOG = 'The calendar of the open project cannot be compiled; the change is refused.';
const PLAN = project(
  [
    workTask('a', {
      segments: [
        { durationHours: 2, gapDaysBefore: 0, startNoEarlierThan: null },
        { durationHours: 2, gapDaysBefore: 1, startNoEarlierThan: null },
      ],
    }),
  ],
  [],
  { name: 'Plan' },
);

/** Opens the plan in an application state, then breaks the compilation of its calendar. */
async function openedWithBrokenCalendar() {
  const { context, control } = fakeAppContext();
  const app = new AppState(context);
  control.openResult = openedProjectOf(PLAN);
  await app.open();
  compiling.broken = true;
  return app;
}

/** Runs an action with the error output silenced, returning what it logged. */
function logged(action: () => void): unknown[][] {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    action();
    return spy.mock.calls;
  } finally {
    spy.mockRestore();
  }
}

describe('changes to a project whose calendar cannot be compiled', () => {
  it('refuses them and logs why, instead of guessing the length of a working day', async () => {
    const app = await openedWithBrokenCalendar();
    expect(app.calendar).toBeNull();
    const before = app.project;
    let refusal: string | null = null;
    expect(
      logged(() => {
        refusal = app.tryEdit(() => ({ ok: true, value: [] }));
      }),
    ).toEqual([[LOG]]);
    expect(refusal).toBe(english.editErrors.NOT_POSSIBLE);
    expect(
      logged(() => {
        app.addTask();
      }),
    ).toEqual([[LOG]]);
    expect(app.project).toBe(before);
    expect(app.notices.map((notice) => notice.text)).toEqual([english.editErrors.NOT_POSSIBLE]);
  });

  it('adds no block and offers no daily start time in the details panel, and refuses to save waits', async () => {
    const app = await openedWithBrokenCalendar();
    const task = app.project?.tasks[0];
    if (task === undefined) {
      throw new Error('The plan has no task.');
    }
    app.openDetails('a');
    const draft = draftFromTask(task, () => '', app.detailsBasis('a'));
    let added = draft;
    expect(logged(() => (added = app.withAddedBlock(draft)))).toEqual([[LOG]]);
    expect(added).toBe(draft);
    expect(app.worksPartOfDay({ ...draft, hoursPerDay: '1' })).toBe(false);
    let saved: string | null = null;
    expect(logged(() => (saved = app.saveDetails(draft)))).toEqual([[LOG]]);
    expect(saved).toBe(english.editErrors.NOT_POSSIBLE);
  });
});
