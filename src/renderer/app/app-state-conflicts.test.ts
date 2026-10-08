import { describe, expect, it, vi } from 'vitest';
import type { Tag } from '../../core/model/project';
import { project, scheduleOrThrow, summary, workTask } from '../../core/testing/project-builder';
import { removeTag, setTagRepresentsPerson } from '../plan/tag-commands';
import english from '../locales/en.json';
import { AppState } from './app-state.svelte';
import { fakeAppContext, openedAppOf, openedProjectOf, settle } from './testing/fake-app-context';

const ALICE: Tag = { id: 'alice', name: 'Alice', color: '#4a3aa7', representsPersonOrTeam: true };
const PLAN = project(
  [
    summary('s', { sortKey: 'a' }),
    workTask('interviews', { parentId: 's', tagId: 'alice', sortKey: 'a' }),
    workTask('analysis', { tagId: 'alice', sortKey: 'b' }),
  ],
  [],
  { tags: [ALICE] },
);

/** Opens the plan in an application state. */
function openedApp() {
  return openedAppOf(PLAN);
}

describe('the list of conflicts', () => {
  it('opens and closes, and never shows without any conflict', async () => {
    const { app } = await openedApp();
    expect(app.schedule?.tagConflicts.conflicts).toHaveLength(1);
    expect(app.conflictsOpen).toBe(false);
    app.toggleConflicts();
    expect(app.conflictsOpen).toBe(true);
    app.toggleConflicts();
    expect(app.conflictsOpen).toBe(false);
    app.toggleConflicts();
    expect(app.editSettings((context) => setTagRepresentsPerson(context, 'alice', false))).toBe(
      null,
    );
    await settle();
    expect(app.conflictsOpen).toBe(false);
    app.toggleConflicts();
    expect(app.conflictsOpen).toBe(false);
  });

  it('shows a conflict by selecting its first task, opening its summary and asking to show its start', async () => {
    const { app } = await openedApp();
    app.setSummaryOpen('s', false);
    const conflict = app.schedule?.tagConflicts.conflicts[0];
    if (conflict === undefined) {
      throw new Error('No conflict');
    }
    expect(conflict.taskIds).toEqual(['analysis', 'interviews']);
    app.showConflict({ ...conflict, taskIds: ['interviews', 'analysis'] });
    expect([app.selectedTaskId, app.collapsed.has('s')]).toEqual(['interviews', false]);
    expect(app.revealRequest).toEqual({ taskId: 'interviews', hour: conflict.start });
    app.takeRevealRequest();
    app.showConflict({ ...conflict, taskIds: [] });
    expect([app.selectedTaskId, app.revealRequest]).toEqual(['interviews', null]);
  });

  it('forgets the list and the request when another project opens', async () => {
    const { app, control } = await openedApp();
    app.toggleConflicts();
    const conflict = app.schedule?.tagConflicts.conflicts[0];
    if (conflict === undefined) {
      throw new Error('No conflict');
    }
    app.showConflict(conflict);
    control.openResult = openedProjectOf(PLAN);
    await app.open();
    await settle();
    expect([app.conflictsOpen, app.revealRequest]).toEqual([false, null]);
  });

  it('describes the conflicts with the project the schedule was computed for, until the next one comes', async () => {
    const { app, scheduler } = await openedApp();
    const before = app.conflictLines;
    expect(before.map((line) => [line.tagName, line.taskNames])).toEqual([
      ['Alice', ['analysis', 'interviews']],
    ]);
    scheduler.automatic = false;
    expect(app.editSettings((context) => removeTag(context, 'alice'))).toBeNull();
    await settle();
    expect(app.project?.tags).toEqual([]);
    expect(app.conflictLines).toEqual(before);
    const latest = app.project;
    if (latest === null) {
      throw new Error('The plan closed.');
    }
    scheduler.listener().scheduled({ ok: true, value: scheduleOrThrow(latest) }, latest);
    expect(app.conflictLines).toEqual([]);
    expect(new AppState(fakeAppContext().context).conflictLines).toEqual([]);
  });

  it('closes the list for good once no conflict is left, not reopening it on the next one', async () => {
    const { app } = await openedApp();
    app.toggleConflicts();
    expect(app.conflictsOpen).toBe(true);
    expect(app.editSettings((context) => setTagRepresentsPerson(context, 'alice', false))).toBe(
      null,
    );
    await settle();
    expect(app.conflictsOpen).toBe(false);
    expect(app.editSettings((context) => setTagRepresentsPerson(context, 'alice', true))).toBe(
      null,
    );
    await settle();
    expect([app.conflictLines.length, app.conflictsOpen]).toEqual([1, false]);
  });

  it('shows the first task of a conflict that is still there, and asks to wait when none is', async () => {
    const { app, scheduler } = await openedApp();
    const conflict = app.schedule?.tagConflicts.conflicts[0];
    if (conflict === undefined) {
      throw new Error('No conflict');
    }
    scheduler.automatic = false;
    app.select('analysis');
    app.deleteSelected();
    await settle();
    app.showConflict(conflict);
    expect([app.selectedTaskId, app.revealRequest]).toEqual([
      'interviews',
      { taskId: 'interviews', hour: conflict.start },
    ]);
    app.takeRevealRequest();
    app.showConflict({ ...conflict, taskIds: ['analysis'] });
    expect([app.selectedTaskId, app.revealRequest]).toEqual(['interviews', null]);
    expect(app.notices.map((notice) => [notice.kind, notice.text])).toEqual([
      ['warning', english.editErrors.SCHEDULE_PENDING],
    ]);
  });

  it('lists no conflict, tells the user and logs why when the conflicts cannot be described', async () => {
    const { app, scheduler } = await openedApp();
    const opened = app.project;
    if (opened === null) {
      throw new Error('No project');
    }
    const schedule = scheduleOrThrow(opened);
    const conflict = { tagId: 'ghost', start: 0, end: 1, taskIds: ['analysis'] };
    const broken = {
      ...schedule,
      tagConflicts: { ...schedule.tagConflicts, conflicts: [conflict] },
    };
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      scheduler.listener().scheduled({ ok: true, value: broken }, opened);
      expect(logged.mock.calls).toEqual([
        [
          'The conflicts of people and teams could not be described:',
          new Error('A conflict is about the unknown tag ghost.'),
        ],
      ]);
    } finally {
      logged.mockRestore();
    }
    expect([app.conflictLines, app.conflictCount]).toEqual([[], 0]);
    expect(app.notices.map((notice) => [notice.kind, notice.text])).toEqual([
      ['error', english.notices.peopleConflictsUnavailable],
    ]);
  });

  it('shows nothing without a project', () => {
    const app = new AppState(fakeAppContext().context);
    app.showConflict({ tagId: 'alice', start: 0, end: 1, taskIds: ['a'] });
    expect([app.selectedTaskId, app.revealRequest]).toEqual([null, null]);
  });
});
