import { describe, expect, it } from 'vitest';
import type { Project, Tag } from '../../core/model/project';
import { scheduleProject } from '../../core/scheduling/schedule-project';
import { at } from '../../core/testing/civil-time';
import { link, project, testId, workTask } from '../../core/testing/project-builder';
import english from '../locales/en.json';
import { describeConflicts } from '../plan/conflict-lines';
import { renameTask, setDuration, setPredecessors } from '../plan/task-commands';
import { AppState } from './app-state.svelte';
import { fakeAppContext, openedProjectOf, settle } from './testing/fake-app-context';
import { workerScheduler } from './testing/worker-scheduler';

const ALICE: Tag = {
  id: testId('alice'),
  name: 'Alice',
  color: '#4a3aa7',
  representsPersonOrTeam: true,
};
const PLAN = project(
  [
    workTask('a', { name: 'Interviews', tagId: ALICE.id, sortKey: 'a' }),
    workTask('b', { name: 'Analysis', tagId: ALICE.id, sortKey: 'b' }),
    workTask('c', { name: 'Writing', sortKey: 'c' }),
  ],
  [link('a', 'c')],
  { name: 'Thesis', tags: [ALICE] },
);
const MOVED = english.settings.tasksMoved;

/** Opens a plan in an application state scheduled by the real scheduler over the real schedule host, whose tables change in place. */
async function openedOnWorker(plan: Project) {
  const fake = fakeAppContext();
  const app = new AppState({ ...fake.context, createScheduler: workerScheduler });
  fake.control.openResult = openedProjectOf(plan);
  await app.open();
  await settle();
  return app;
}

/** Checks that the page shows for its project the schedule and conflicts a full computation gives. */
function expectComputed(app: AppState): void {
  const shown = app.project;
  if (shown === null) {
    throw new Error('No project is open.');
  }
  const full = scheduleProject(shown);
  const described = describeConflicts(full.ok ? full.value : null, shown);
  expect(app.currentSchedule).toEqual({ ok: true, value: full.ok ? full.value : null });
  expect([app.conflictLines, app.dateConflictLines]).toEqual([
    described.people.ok ? described.people.value : [],
    described.dates.ok ? described.dates.value : [],
  ]);
}

describe('the application state on the real scheduler', () => {
  it('shows after each change the schedule and conflicts a full computation gives, though the tables change in place', async () => {
    const app = await openedOnWorker({
      ...PLAN,
      options: { ...PLAN.options, criticalPathEnabled: true },
    });
    expectComputed(app);
    const edits = [
      () => app.edit((context) => renameTask(context, testId('b'), 'Coding')),
      () => app.edit((context) => setDuration(context, testId('a'), '3')),
      () => app.edit((context) => setPredecessors(context, testId('b'), '1')),
      () => app.edit((context) => setPredecessors(context, testId('b'), '')),
      () => app.moveProjectStart('2026-10-12T09:00') === null,
    ];
    for (const edit of edits) {
      expect(edit()).toBe(true);
      await settle();
      expectComputed(app);
    }
  });

  it('counts the tasks a move of the start moved, from starts kept apart from the tables changed in place', async () => {
    const app = await openedOnWorker(
      project(
        [
          workTask('a', { sortKey: 'a' }),
          workTask('b', { sortKey: 'b' }),
          workTask('dated', { sortKey: 'c', startNoEarlierThan: at(2026, 12, 1, 9) }),
        ],
        [link('a', 'b')],
      ),
    );
    expect(app.moveProjectStart('2026-10-12T09:00')).toBeNull();
    await settle();
    expect(app.settings.notice).toBe(MOVED.other.replace('{count}', '2'));
    expect(app.moveProjectStart('2026-10-13T09:00')).toBeNull();
    expect(app.moveProjectStart('2026-10-14T09:00')).toBeNull();
    await settle();
    expect(app.settings.notice).toBe(MOVED.other.replace('{count}', '2'));
  });
});
