import { describe, expect, it, vi } from 'vitest';
import type { Tag } from '../../core/model/project';
import { at } from '../../core/testing/civil-time';
import {
  link,
  milestone,
  project,
  scheduleOrThrow,
  summary,
  workTask,
} from '../../core/testing/project-builder';
import english from '../locales/en.json';
import { toggleProjectOption } from '../plan/project-commands';
import { draftFromTask } from '../plan/task-details';
import { AppState } from './app-state.svelte';
import { fakeAppContext, openedProjectOf, settle } from './testing/fake-app-context';

const ALICE: Tag = { id: 'alice', name: 'Alice', color: '#4a3aa7', representsPersonOrTeam: true };
const OPTIONS = {
  criticalPathEnabled: false,
  dateConstraintsEnabled: true,
  baselineEnabled: false,
  alwaysShowPatterns: false,
};
const PLAN = project(
  [
    summary('s', { sortKey: 'a' }),
    workTask('writing', {
      name: 'Writing',
      parentId: 's',
      sortKey: 'a',
      deadline: at(2026, 9, 28, 12),
    }),
    milestone('defense', { name: 'Defense', sortKey: 'b', mustFinishOn: at(2026, 9, 28, 10) }),
    workTask('free', { name: 'Free', sortKey: 'c', tagId: 'alice' }),
    workTask('busy', { name: 'Busy', sortKey: 'd', tagId: 'alice' }),
  ],
  [link('writing', 'defense')],
  { tags: [ALICE], options: OPTIONS },
);
const WRITING_END = at(2026, 9, 28, 17);

/** Opens the plan, where Writing misses its deadline, Defense cannot finish on its date and Alice works twice at once. */
async function openedApp() {
  const fake = fakeAppContext();
  const app = new AppState(fake.context);
  fake.control.openResult = openedProjectOf(PLAN);
  await app.open();
  await settle();
  return { app, ...fake };
}

describe('date conflicts in the application state', () => {
  it('describes the dates not met and counts them with the person or team conflicts', async () => {
    const { app } = await openedApp();
    expect(app.dateConflictLines).toEqual([
      {
        conflict: { code: 'DEADLINE_MISSED', taskId: 'writing' },
        taskName: 'Writing',
        end: WRITING_END,
        date: at(2026, 9, 28, 12),
      },
      {
        conflict: { code: 'MUST_FINISH_ON_NOT_MET', taskId: 'defense' },
        taskName: 'Defense',
        end: WRITING_END,
        date: at(2026, 9, 28, 10),
      },
    ]);
    expect(app.conflictCount).toBe(3);
    const empty = new AppState(fakeAppContext().context);
    expect([empty.dateConflictLines, empty.conflictCount]).toEqual([[], 0]);
  });

  it('keeps the list open while only dates are not met, and closes it once they all are', async () => {
    const { app } = await openedApp();
    expect(
      app.editSettings((context) => toggleProjectOption(context, 'dateConstraintsEnabled')),
    ).toBeNull();
    await settle();
    expect(app.conflictCount).toBe(1);
    app.undo();
    await settle();
    app.select('busy');
    app.deleteSelected();
    await settle();
    expect([app.conflictLines, app.conflictCount]).toEqual([[], 2]);
    app.toggleConflicts();
    expect(app.conflictsOpen).toBe(true);
    expect(
      app.editSettings((context) => toggleProjectOption(context, 'dateConstraintsEnabled')),
    ).toBeNull();
    await settle();
    expect([app.conflictCount, app.conflictsOpen]).toEqual([0, false]);
  });

  it('marks no task, tells the user and logs why when the dates not met cannot be described', async () => {
    const { app, scheduler } = await openedApp();
    const opened = app.project;
    if (opened === null) {
      throw new Error('No project');
    }
    const schedule = scheduleOrThrow(opened);
    const broken = {
      ...schedule,
      conflicts: [{ code: 'DEADLINE_MISSED' as const, taskId: 'ghost' }],
    };
    app.toggleConflicts();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      scheduler.listener().scheduled({ ok: true, value: broken }, opened);
      expect(logged.mock.calls).toEqual([
        [
          'The dates not met could not be described:',
          new Error('A conflict is about the unknown task ghost.'),
        ],
      ]);
    } finally {
      logged.mockRestore();
    }
    expect([app.dateConflictLines, app.conflictCount, app.conflictsOpen]).toEqual([[], 1, true]);
    expect(app.notices.map((notice) => [notice.kind, notice.text])).toEqual([
      ['error', english.notices.dateConflictsUnavailable],
    ]);
  });

  it('shows a date conflict by selecting its task, opening its summary and asking to show its end', async () => {
    const { app } = await openedApp();
    app.setSummaryOpen('s', false);
    const line = app.dateConflictLines[0];
    if (line === undefined) {
      throw new Error('No date conflict');
    }
    app.showDateConflict(line);
    expect([app.selectedTaskId, app.collapsed.has('s')]).toEqual(['writing', false]);
    expect(app.revealRequest).toEqual({ taskId: 'writing', hour: WRITING_END });
  });

  it('asks to wait when the task of a date conflict was deleted meanwhile', async () => {
    const { app, scheduler } = await openedApp();
    const line = app.dateConflictLines[1];
    if (line === undefined) {
      throw new Error('No date conflict');
    }
    scheduler.automatic = false;
    app.select('defense');
    app.deleteSelected();
    await settle();
    app.takeRevealRequest();
    app.showDateConflict(line);
    expect(app.revealRequest).toBeNull();
    expect(app.notices.map((notice) => [notice.kind, notice.text])).toEqual([
      ['warning', english.editErrors.SCHEDULE_PENDING],
    ]);
  });

  it('refuses the details panel when date constraints were turned on or off while it was open', async () => {
    const { app } = await openedApp();
    const task = app.project?.tasks.find((candidate) => candidate.id === 'free');
    if (task === undefined) {
      throw new Error('Missing task');
    }
    const draft = draftFromTask(task, () => '', app.detailsBasis('free'));
    expect(
      app.editSettings((context) => toggleProjectOption(context, 'dateConstraintsEnabled')),
    ).toBeNull();
    await settle();
    app.openDetails('free');
    expect(app.saveDetails({ ...draft, deadline: '2026-10-02T15:00' })).toBe(
      english.editErrors.TASK_CHANGED,
    );
    expect(app.project?.tasks.find((candidate) => candidate.id === 'free')).toBe(task);
  });

  it('saves the date constraints of the details panel only while they are turned on', async () => {
    const { app } = await openedApp();
    const task = app.project?.tasks.find((candidate) => candidate.id === 'free');
    if (task === undefined) {
      throw new Error('Missing task');
    }
    const draft = draftFromTask(task, () => '', app.detailsBasis('free'));
    app.openDetails('free');
    expect(app.saveDetails({ ...draft, deadline: 'soon' })).toBe(
      english.editErrors.INVALID_DEADLINE,
    );
    expect(app.saveDetails({ ...draft, deadline: '2026-10-02T15:00' })).toBeNull();
    await settle();
    const saved = app.project?.tasks.find((candidate) => candidate.id === 'free');
    expect(saved?.kind === 'task' && saved.deadline).toBe(at(2026, 10, 2, 15));
    expect(
      app.editSettings((context) => toggleProjectOption(context, 'dateConstraintsEnabled')),
    ).toBeNull();
    await settle();
    if (saved === undefined) {
      throw new Error('Missing task');
    }
    app.openDetails('free');
    const hidden = draftFromTask(saved, () => '', app.detailsBasis('free'));
    expect(app.saveDetails({ ...hidden, deadline: '', name: 'Kept' })).toBeNull();
    await settle();
    expect(app.project?.tasks.find((candidate) => candidate.id === 'free')).toMatchObject({
      name: 'Kept',
      deadline: at(2026, 10, 2, 15),
    });
  });
});
