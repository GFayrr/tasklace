import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../core/model/project';
import type { BridgeResult, OpenedProject } from '../../preload/bridge-contract';
import { scheduleProject } from '../../core/scheduling/schedule-project';
import { at } from '../../core/testing/civil-time';
import {
  milestone,
  project,
  splitTask,
  summary,
  workTask,
} from '../../core/testing/project-builder';
import english from '../locales/en.json';
import { draftFromTask } from '../plan/task-details';
import { setStart } from '../plan/task-commands';
import { AUTOSAVE_DELAY_MS } from '../project/autosave';
import { AppState } from './app-state.svelte';
import { fakeAppContext, openedProjectOf, settle } from './testing/fake-app-context';

const PLAN: Project = project(
  [
    summary('s', { sortKey: 'a' }),
    workTask('a', { parentId: 's' }),
    milestone('m', { sortKey: 'b' }),
  ],
  [],
  { name: 'Thesis' },
);

/** Creates the application state around a fake main process. */
function createApp() {
  const fake = fakeAppContext();
  return { app: new AppState(fake.context), ...fake };
}

/** Creates the application state with a new project open. */
async function withNewProject() {
  const created = createApp();
  await created.app.newProject();
  return created;
}

/** Creates the application state with the sample plan open from its file. */
async function withOpenPlan() {
  const created = createApp();
  created.control.openResult = openedProjectOf(PLAN);
  await created.app.open();
  return created;
}

/** Renames the open project, a change that marks it changed since it was opened. */
async function change(app: AppState, name = 'Changed'): Promise<void> {
  expect(app.rename(name)).toBe(true);
  await settle();
}

/** Returns the texts of the messages shown. */
function noticeTexts(app: AppState): string[] {
  return app.notices.map((notice) => notice.text);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('new projects', () => {
  it('starts an untitled project, schedules it and shows it saved in its local copy only', async () => {
    const { app } = await withNewProject();
    expect(app.project?.name).toBe(english.projects.untitled);
    expect(app.schedule).not.toBeNull();
    expect(app.hasFile).toBe(false);
    expect(app.saveStatus).toBe('saved');
    expect(app.openedCount).toBe(1);
    expect(app.notices).toEqual([]);
  });

  it('tells why a new project could not be created, keeping the open one', async () => {
    const { app, control } = await withNewProject();
    const before = app.project;
    control.newDocumentId = 'not an identifier';
    await app.newProject();
    expect(app.project).toBe(before);
    expect(noticeTexts(app)).toEqual([english.fileErrors.INVALID_PROJECT]);
  });
});

describe('closing a project', () => {
  it('lets an untouched project or one with a file close without asking', async () => {
    const { app } = await withNewProject();
    expect(await app.readyToClose()).toBe(true);
    const opened = await withOpenPlan();
    await change(opened.app);
    expect(await opened.app.readyToClose()).toBe(true);
    expect(opened.app.closePrompt).toBeNull();
  });

  it('asks before closing a changed project without file, and follows the answer', async () => {
    const { app, control } = await withNewProject();
    await change(app);
    for (const [choice, expected] of [
      ['cancel', false],
      ['discard', true],
    ] as const) {
      const ready = app.readyToClose();
      await settle();
      expect(app.closePrompt?.reason).toBe('unsaved');
      app.closePrompt?.answer(choice);
      expect(await ready).toBe(expected);
      expect(app.closePrompt).toBeNull();
    }
    const saving = app.readyToClose();
    await settle();
    app.closePrompt?.answer('save');
    expect(await saving).toBe(true);
    expect(control.saved).toEqual([{ as: true, name: 'Changed' }]);
    expect(app.hasFile).toBe(true);
  });

  it('keeps the project open when saving it before closing is cancelled', async () => {
    const { app, control } = await withNewProject();
    await change(app);
    control.saveAsResult = { ok: false, error: { code: 'CANCELLED' } };
    const ready = app.readyToClose();
    await settle();
    app.closePrompt?.answer('save');
    expect(await ready).toBe(false);
    expect(app.notices).toEqual([]);
  });

  it('never shows two questions at once, asking the second once the first is answered, each with its own answer', async () => {
    const { app } = await withNewProject();
    await change(app);
    const first = app.readyToClose();
    const second = app.prepareClose();
    await settle();
    const firstPrompt = app.closePrompt;
    firstPrompt?.answer('cancel');
    await settle();
    expect(app.closePrompt).not.toBeNull();
    expect(app.closePrompt).not.toBe(firstPrompt);
    app.closePrompt?.answer('discard');
    expect(await Promise.all([first, second])).toEqual([false, true]);
    expect(app.closePrompt).toBeNull();
  });

  it('closes at once without saving a project without file the user chooses not to keep', async () => {
    const { app, control } = await withNewProject();
    await change(app);
    const closing = app.prepareClose();
    await settle();
    app.closePrompt?.answer('discard');
    expect(await closing).toBe(true);
    expect(control.calls.filter((call) => call.startsWith('save'))).toEqual([]);
  });

  it('logs an unexpected failure of the last save, then asks what to do', async () => {
    const { app, control } = await withOpenPlan();
    await change(app);
    control.saveResult = new Error('bridge gone');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const closing = app.prepareClose();
      await settle();
      expect(app.closePrompt).toMatchObject({
        reason: 'saveFailed',
        detail: english.fileErrors.TASK_FAILED,
      });
      app.closePrompt?.answer('cancel');
      expect(await closing).toBe(false);
      expect(logged).toHaveBeenCalledWith(
        'The project could not be saved before closing:',
        new Error('bridge gone'),
      );
    } finally {
      logged.mockRestore();
    }
  });

  it('saves before closing, and keeps the window open after a failed save unless the user decides', async () => {
    const { app, control } = await withOpenPlan();
    expect(await app.prepareClose()).toBe(true);
    await change(app);
    control.saveResult = { ok: false, error: { code: 'WRITE_FAILED' } };
    for (const [choice, expected] of [
      ['cancel', false],
      ['discard', true],
    ] as const) {
      const closing = app.prepareClose();
      await settle();
      expect(app.closePrompt).toMatchObject({
        reason: 'saveFailed',
        detail: english.fileErrors.WRITE_FAILED,
      });
      app.closePrompt?.answer(choice);
      expect(await closing).toBe(expected);
    }
    const elsewhere = app.prepareClose();
    await settle();
    app.closePrompt?.answer('save');
    expect(await elsewhere).toBe(true);
    expect(control.calls.filter((call) => call === 'saveProjectAs')).toHaveLength(1);
  });

  it('keeps the window open when saving elsewhere after a failed save is cancelled or fails too', async () => {
    const { app, control } = await withOpenPlan();
    await change(app);
    control.saveResult = { ok: false, error: { code: 'WRITE_FAILED' } };
    for (const saveAsResult of [
      { ok: false, error: { code: 'CANCELLED' } },
      { ok: false, error: { code: 'WRITE_FAILED' } },
    ] as const) {
      control.saveAsResult = saveAsResult;
      const closing = app.prepareClose();
      await settle();
      app.closePrompt?.answer('save');
      expect(await closing).toBe(false);
    }
  });

  it('rejects the preparation to close when saving elsewhere throws, for the page to report it', async () => {
    const { app, control, context } = await withOpenPlan();
    await change(app);
    control.saveResult = { ok: false, error: { code: 'WRITE_FAILED' } };
    Object.assign(context.bridge, {
      saveProjectAs: () => Promise.reject(new Error('bridge gone')),
    });
    const closing = app.prepareClose();
    await settle();
    app.closePrompt?.answer('save');
    await expect(closing).rejects.toThrow('bridge gone');
  });

  it('does not close when the question about a project without file is cancelled', async () => {
    const { app } = await withNewProject();
    await change(app);
    const closing = app.prepareClose();
    await settle();
    app.closePrompt?.answer('cancel');
    expect(await closing).toBe(false);
  });
});

describe('opening and importing', () => {
  it('opens a project from its file, its schedule following, and lists the recent projects', async () => {
    const { app, control } = createApp();
    control.recent = [{ name: 'Thesis', folder: '/projects' }];
    control.openResult = openedProjectOf(PLAN);
    await app.open();
    expect(byId(app.project?.tasks ?? [])).toEqual(byId(PLAN.tasks));
    expect(app.hasFile).toBe(true);
    expect(app.schedule).toEqual(unwrapSchedule(app.project));
    expect(app.recentProjects).toEqual(control.recent);
    await app.openRecent(0);
    expect(control.calls.filter((call) => call === 'openRecentProject')).toHaveLength(1);
  });

  it('tells why a file could not be opened, with the detailed problems', async () => {
    const { app, control } = createApp();
    control.openResult = {
      ok: false,
      error: { code: 'INVALID_PROJECT', issues: [{ path: 'tasks[0].name', code: 'EMPTY_TEXT' }] },
    };
    await app.open();
    expect(app.project).toBeNull();
    expect(app.notices).toEqual([
      {
        id: 1,
        kind: 'error',
        text: english.fileErrors.INVALID_PROJECT,
        report: {
          title: english.report.fileFailed,
          entries: [`Task 1, name: ${english.issues.EMPTY_TEXT}`],
        },
        lasting: true,
      },
    ]);
  });

  it('says nothing when the user cancels', async () => {
    const { app } = createApp();
    await app.open();
    expect(app.notices).toEqual([]);
  });

  it('tells how many tasks an import brought, and lists its warnings', async () => {
    const { app, control } = createApp();
    control.openResult = openedProjectOf(PLAN, {
      fileName: 'plan.csv',
      warnings: [{ path: 'rows[3].end', code: 'END_DIFFERS' }],
    });
    await app.importFile('csv');
    expect(app.hasFile).toBe(false);
    expect(app.notices.map((notice) => [notice.kind, notice.text, notice.report])).toEqual([
      [
        'warning',
        'Imported with 1 warning.',
        {
          title: english.report.importWarnings,
          entries: [`Row 3, end: ${english.issues.END_DIFFERS}`],
        },
      ],
      ['info', 'Imported plan.csv: 3 tasks.', null],
    ]);
  });

  it('opens nothing when the user keeps the changed project', async () => {
    const { app, control } = await withNewProject();
    await change(app);
    for (const action of [
      () => app.open(),
      () => app.openRecent(0),
      () => app.importFile('json'),
      () => app.newProject(),
    ]) {
      const acting = action();
      await settle();
      app.closePrompt?.answer('cancel');
      await acting;
    }
    expect(control.calls.filter((call) => /open|import/i.test(call))).toEqual([]);
    expect(app.project?.name).toBe('Changed');
  });
});

describe('saving and exporting', () => {
  it('saves to its file, or asks where for a project without file, then lists the recent projects', async () => {
    const { app, control } = await withNewProject();
    await app.save();
    expect(control.saved).toEqual([{ as: true, name: english.projects.untitled }]);
    expect(app.hasFile).toBe(true);
    await app.save();
    expect(control.saved).toEqual([
      { as: true, name: english.projects.untitled },
      { as: false, name: english.projects.untitled },
    ]);
    control.saveResult = { ok: false, error: { code: 'WRITE_FAILED' } };
    await app.save();
    expect(noticeTexts(app)).toEqual([english.fileErrors.WRITE_FAILED]);
  });

  it('exports the project as JSON or CSV under its name, and tells the file written', async () => {
    const { app, control } = await withOpenPlan();
    await app.exportFile('json');
    control.exportResult = { ok: true, value: { fileName: 'plan.csv' } };
    await app.exportFile('csv');
    expect(control.exports.map((exported) => [exported.kind, exported.name])).toEqual([
      ['json', 'Thesis'],
      ['csv', 'Thesis'],
    ]);
    expect(control.exports[1]?.text.startsWith('﻿')).toBe(true);
    expect(control.calls.filter((call) => call === 'regionalFormat')).toHaveLength(1);
    expect(noticeTexts(app)).toEqual(['Exported to plan.json.', 'Exported to plan.csv.']);
  });

  it('exports nothing without a project, and tells why a write failed', async () => {
    const empty = createApp();
    await empty.app.exportFile('json');
    expect(empty.control.exports).toEqual([]);
    const { app, control } = await withOpenPlan();
    control.exportResult = { ok: false, error: { code: 'WRITE_FAILED' } };
    await app.exportFile('json');
    expect(noticeTexts(app)).toEqual([english.fileErrors.WRITE_FAILED]);
  });

  it('refuses a CSV export of a project that cannot be scheduled', async () => {
    const { app, control } = await withOpenPlan();
    const broken = project(
      [
        workTask('long', {
          segments: [{ durationHours: 100_000, gapDaysBefore: 0, startNoEarlierThan: null }],
        }),
      ],
      [],
      { name: 'Too long', startDate: at(2199, 6, 1) },
    );
    control.openResult = openedProjectOf(broken);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await app.open();
      app.dismiss(app.notices[0]?.id ?? -1);
      await app.exportFile('csv');
      expect(logged).toHaveBeenLastCalledWith('The schedule could not be computed:', {
        kind: 'task',
        error: { code: 'BEYOND_PLANNING_HORIZON', taskId: 'long' },
      });
    } finally {
      logged.mockRestore();
    }
    expect(control.exports).toEqual([]);
    expect(app.notices.map((notice) => [notice.text, notice.report])).toEqual([
      [
        english.scheduleFailures.task.replace('{name}', 'long'),
        {
          title: english.report.scheduleFailed,
          entries: [english.issues.BEYOND_PLANNING_HORIZON],
        },
      ],
    ]);
  });

  it('reports a failed automatic save in a message', async () => {
    const { app, control } = await withOpenPlan();
    vi.useFakeTimers();
    control.saveResult = { ok: false, error: { code: 'WRITE_FAILED' } };
    expect(app.rename('Changed')).toBe(true);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(noticeTexts(app)).toEqual([english.fileErrors.WRITE_FAILED]);
    expect(app.saveStatus).toBe('failed');
  });
});

describe('editing', () => {
  it('renames the project, ignoring an empty or unchanged name, and tells why a name is refused', async () => {
    const { app } = await withNewProject();
    expect(app.rename('  ')).toBe(false);
    expect(app.rename(english.projects.untitled)).toBe(false);
    expect(app.rename('x'.repeat(10_000))).toBe(false);
    expect(noticeTexts(app)).toEqual([english.editErrors.TOO_LONG]);
    expect(app.rename('  Launch  ')).toBe(true);
    await settle();
    expect(app.project?.name).toBe('Launch');
  });

  it('refuses to rename or edit without a project', () => {
    const { app } = createApp();
    expect(app.rename('Plan')).toBe(false);
    expect(app.tryEdit(() => ({ ok: true, value: [] }))).toBe(english.editErrors.NOT_POSSIBLE);
  });

  it('applies an edit, or tells why it was refused', async () => {
    const { app } = await withOpenPlan();
    expect(app.edit(() => ({ ok: false, error: 'INVALID_DATE' }))).toBe(false);
    expect(noticeTexts(app)).toEqual([english.editErrors.INVALID_DATE]);
    const unnamed = { ...workTask('a', { parentId: 's' }), name: '' };
    expect(app.edit(() => ({ ok: true, value: [{ type: 'putTask', task: unnamed }] }))).toBe(false);
    expect(noticeTexts(app)).toEqual([english.editErrors.INVALID_DATE, english.issues.EMPTY_TEXT]);
    expect(app.edit((context) => setStart(context, 'a', '2026-09-29 10:00'))).toBe(true);
    expect(app.project?.tasks.find((task) => task.id === 'a')).toMatchObject({
      startNoEarlierThan: at(2026, 9, 29, 10),
    });
    expect(app.canUndo).toBe(true);
  });

  it('moves the project start back for a task placed before it, and says so', async () => {
    const { app } = await withOpenPlan();
    expect(app.edit((context) => setStart(context, 'a', '2026-09-21 09:00'))).toBe(true);
    expect(app.project?.startDate).toBe(at(2026, 9, 21));
    expect(noticeTexts(app)).toEqual([
      'The project now starts on Sep 21, 2026, so that this task can start earlier.',
    ]);
  });

  it('adds a task after the selected one, selects it and asks to edit its name', async () => {
    const { app } = await withOpenPlan();
    app.selectedTaskId = 'a';
    app.addTask();
    expect(app.selectedTaskId).toBe('id1');
    expect(app.editRequest).toEqual({ taskId: 'id1', column: 'name' });
    expect(app.project?.tasks.find((task) => task.id === 'id1')).toMatchObject({
      name: english.table.newTask,
      parentId: 's',
    });
    const empty = createApp();
    empty.app.addTask();
    expect(empty.app.project).toBeNull();
  });

  it('deletes the selected task, selecting the row that takes its place, and does nothing without selection', async () => {
    const { app } = await withOpenPlan();
    app.deleteSelected();
    expect(app.project?.tasks).toHaveLength(3);
    app.selectedTaskId = 's';
    app.deleteSelected();
    expect(app.project?.tasks.map((task) => task.id)).toEqual(['m']);
    expect(app.selectedTaskId).toBe('m');
    app.deleteSelected();
    expect(app.project?.tasks).toEqual([]);
    expect(app.selectedTaskId).toBeNull();
  });

  it('edits the selected task only', async () => {
    const { app } = await withOpenPlan();
    const build = vi.fn(() => ({ ok: true, value: [] }) as const);
    app.editSelected(build);
    expect(build).not.toHaveBeenCalled();
    app.selectedTaskId = 'a';
    app.editSelected(build);
    expect(build).toHaveBeenCalledWith(expect.anything(), 'a');
  });

  it('undoes and redoes local changes, and does nothing without a project', async () => {
    const empty = createApp();
    empty.app.undo();
    empty.app.redo();
    const { app } = await withOpenPlan();
    await change(app, 'Renamed');
    app.undo();
    await settle();
    expect(app.project?.name).toBe('Thesis');
    expect(app.canRedo).toBe(true);
    app.redo();
    await settle();
    expect(app.project?.name).toBe('Renamed');
    expect(app.notices).toEqual([]);
  });

  it('opens and closes summaries, from the keyboard only for summaries', async () => {
    const { app } = await withOpenPlan();
    app.setSummaryOpen('s', false);
    expect(app.collapsed.has('s')).toBe(true);
    app.setSummaryOpen('s', false);
    expect(app.collapsed.has('s')).toBe(true);
    app.setSummaryOpen('s', true);
    expect(app.collapsed.has('s')).toBe(false);
    app.setSummaryOpen('a', false);
    expect(app.collapsed.has('a')).toBe(false);
    app.toggleSummary('s');
    expect(app.collapsed.has('s')).toBe(true);
  });

  it('runs the keyboard commands', async () => {
    const { app, control } = await withOpenPlan();
    await change(app, 'Renamed');
    await app.run('undo');
    await settle();
    expect(app.project?.name).toBe('Thesis');
    await app.run('redo');
    await settle();
    expect(app.project?.name).toBe('Renamed');
    await app.run('save');
    await app.run('saveAs');
    await app.run('open');
    await app.run('newProject');
    expect(
      control.calls.filter((call) => call !== 'recentProjects' && call !== 'adoptProject'),
    ).toEqual([
      'openProject',
      'saveProject',
      'saveProjectAs',
      'saveProject',
      'openProject',
      'newProject',
    ]);
  });
});

describe('the details panel', () => {
  it('opens the details of a task, or of the selected task', async () => {
    const { app } = await withOpenPlan();
    app.openDetails();
    expect(app.detailsTaskId).toBeNull();
    app.openDetails('a');
    expect([app.selectedTaskId, app.detailsTaskId]).toEqual(['a', 'a']);
  });

  it('describes what a block waits for and what the panel was opened on', async () => {
    const { app } = await withOpenPlan();
    expect(app.blockWaitText('a', 0)).toBe('');
    expect(app.detailsBasis('a')).not.toBe('');
    const empty = createApp();
    expect(empty.app.detailsBasis('a')).toBe('');
  });
});

describe('schedules and messages', () => {
  it('ignores a schedule computed for an older version of the project', async () => {
    const { app, scheduler } = await withOpenPlan();
    scheduler.automatic = false;
    await change(app, 'Newer');
    const older = scheduler.requests[0];
    if (older === undefined) {
      throw new Error('No request');
    }
    const before = app.schedule;
    scheduler.listener().scheduled(scheduleProject(older), older);
    expect(app.schedule).toBe(before);
  });

  it('tells that a schedule could not be computed or updated', async () => {
    const { app, scheduler } = await withOpenPlan();
    const opened = app.project;
    if (opened === null) {
      throw new Error('No project');
    }
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      scheduler.listener().scheduled({ ok: false, error: { kind: 'startDate' } }, opened);
      expect(app.schedule).toBeNull();
      expect(logged).toHaveBeenCalledWith('The schedule could not be computed:', {
        kind: 'startDate',
      });
      scheduler.listener().failed(new Error('worker gone'));
    } finally {
      logged.mockRestore();
    }
    expect(app.notices.map((notice) => [notice.text, notice.report, notice.lasting])).toEqual([
      [english.scheduleFailures.startDate, null, false],
      [english.notices.scheduleStopped, null, true],
    ]);
  });

  it('shows a message again with its latest details instead of keeping the older ones', async () => {
    const { app, control } = createApp();
    const failedWith = (path: string) =>
      ({
        ok: false,
        error: { code: 'INVALID_PROJECT', issues: [{ path, code: 'EMPTY_TEXT' }] },
      }) as const;
    control.openResult = failedWith('tasks[0].name');
    await app.open();
    const first = app.notices[0];
    control.openResult = failedWith('tasks[1].name');
    await app.open();
    expect(app.notices).toHaveLength(1);
    expect(app.notices[0]?.id).not.toBe(first?.id);
    expect(app.notices[0]?.report?.entries).toEqual([`Task 2, name: ${english.issues.EMPTY_TEXT}`]);
  });

  it('tells once per part that the timeline or its patterns cannot be drawn', () => {
    const { app } = createApp();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      app.reportDrawingProblem('patterns');
      app.dismiss(app.notices[0]?.id ?? -1);
      app.reportDrawingProblem('patterns');
      app.reportDrawingProblem('timeline');
      app.reportDrawingProblem('timeline');
      expect(logged).toHaveBeenCalledTimes(2);
    } finally {
      logged.mockRestore();
    }
    expect(noticeTexts(app)).toEqual([english.notices.drawingUnavailable.timeline]);
  });

  it('shows a message once, lets it be dismissed, and opens and closes its details', () => {
    const { app } = createApp();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      app.reportUnexpectedError(new Error('x'));
      app.reportUnexpectedError(new Error('y'));
      app.reportPickerUnavailable(new Error('z'));
    } finally {
      logged.mockRestore();
    }
    expect(app.notices.map((notice) => [notice.kind, notice.text])).toEqual([
      ['error', english.notices.unexpectedError],
      ['warning', english.notices.pickerUnavailable],
    ]);
    const report = { title: 'Title', entries: ['One'] };
    app.openReport(report);
    expect(app.report).toBe(report);
    app.closeReport();
    expect(app.report).toBeNull();
    app.dismiss(app.notices[0]?.id ?? -1);
    expect(noticeTexts(app)).toEqual([english.notices.pickerUnavailable]);
  });

  it('names the tasks adjusted when a project is opened', async () => {
    const { app, control } = createApp();
    const withMissingTag = project([workTask('a', { name: 'Write', tagId: 'gone' })], [], {
      name: 'Plan',
    });
    control.openResult = openedProjectOf(withMissingTag);
    await app.open();
    expect(app.notices.map((notice) => notice.report)).toEqual([
      {
        title: english.report.repairs,
        entries: [`Task “Write”: ${english.repairCodes.TAG_CLEARED}`],
      },
    ]);
  });
});

/** Sorts tasks by identifier, the order in which a shared document gives them back. */
function byId(tasks: Project['tasks']): Project['tasks'] {
  return [...tasks].sort((left, right) => left.id.localeCompare(right.id));
}

/** Computes the schedule of a project, failing the test when it cannot be computed. */
function unwrapSchedule(plan: Project | null) {
  const schedule = plan === null ? null : scheduleProject(plan);
  if (schedule?.ok !== true) {
    throw new Error('No schedule');
  }
  return schedule.value;
}

describe('saving the details panel', () => {
  const SPLIT_PLAN: Project = project(
    [
      workTask('a'),
      splitTask('b', [
        [7, 0],
        [7, 1],
      ]),
    ],
    [],
    { name: 'Split' },
  );

  /** Opens the split plan with the details panel of a task open, and returns its draft. */
  async function detailsOf(id: string) {
    const created = createApp();
    created.control.openResult = openedProjectOf(SPLIT_PLAN);
    await created.app.open();
    created.app.openDetails(id);
    const task = created.app.project?.tasks.find((candidate) => candidate.id === id);
    if (task === undefined) {
      throw new Error(id);
    }
    const draft = draftFromTask(
      task,
      (block) => created.app.blockWaitText(id, block),
      created.app.detailsBasis(id),
    );
    return { ...created, draft };
  }

  it('applies the panel to its task and closes it', async () => {
    const { app, draft } = await detailsOf('a');
    expect(app.saveDetails({ ...draft, name: 'Write' })).toBeNull();
    await settle();
    expect(app.detailsTaskId).toBeNull();
    expect(app.project?.tasks.find((task) => task.id === 'a')?.name).toBe('Write');
  });

  it('keeps the panel open with the reason when a field cannot be read', async () => {
    const { app, draft } = await detailsOf('a');
    expect(app.saveDetails({ ...draft, progress: 'half' })).toBe(
      english.editErrors.INVALID_PROGRESS,
    );
    expect(app.detailsTaskId).toBe('a');
  });

  it('refuses a panel whose task changed or disappeared meanwhile', async () => {
    const { app, draft } = await detailsOf('a');
    expect(app.saveDetails({ ...draft, basis: 'older' })).toBe(english.editErrors.TASK_CHANGED);
    app.detailsTaskId = 'gone';
    expect(app.saveDetails(draft)).toBe(english.editErrors.NOT_POSSIBLE);
  });

  it('names the block whose start date cannot be read, or whose wait names nothing', async () => {
    const { app, draft } = await detailsOf('b');
    const [first, second] = draft.blocks;
    if (first === undefined || second === undefined) {
      throw new Error('Missing block');
    }
    expect(app.saveDetails({ ...draft, blocks: [first, { ...second, start: 'soon' }] })).toBe(
      `Block 2: ${english.editErrors.INVALID_DATE}`,
    );
    expect(app.saveDetails({ ...draft, blocks: [first, { ...second, waitsFor: '9' }] })).toBe(
      `Block 2: ${english.editErrors.UNKNOWN_TASK_NUMBER}`,
    );
    expect(app.saveDetails({ ...draft, blocks: [first, { ...second, waitsFor: '1' }] })).toBeNull();
  });
});

describe('unexpected failures of the main process', () => {
  it('tells that an automatic save stopped unexpectedly, and asks before closing', async () => {
    const created = createApp();
    Object.assign(created.context.bridge, {
      saveProject: () => Promise.reject(new Error('bridge gone')),
    });
    const app = new AppState(created.context);
    created.control.openResult = openedProjectOf(PLAN);
    await app.open();
    await change(app);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const closing = app.prepareClose();
      await settle();
      expect(app.closePrompt).toMatchObject({
        reason: 'saveFailed',
        detail: english.fileErrors.TASK_FAILED,
      });
      app.closePrompt?.answer('discard');
      expect(await closing).toBe(true);
    } finally {
      logged.mockRestore();
    }
  });
});

describe('one file action at a time', () => {
  it('keeps the open project unchanged while another one opens, then changes the new one again', async () => {
    const { app, control, context } = await withOpenPlan();
    await change(app, 'Before');
    let finish: (result: BridgeResult<OpenedProject>) => void = () => undefined;
    Object.assign(context.bridge, {
      openProject: () =>
        new Promise<BridgeResult<OpenedProject>>((resolve) => {
          finish = resolve;
        }),
    });
    const opening = app.open();
    await settle();
    expect(app.fileActionRunning).toBe(true);
    const before = app.project;
    expect(app.tryEdit((edit) => setStart(edit, 'a', '2026-09-29 10:00'))).toBe(
      english.fileErrors.BUSY,
    );
    app.selectedTaskId = 'a';
    app.addTask();
    app.deleteSelected();
    expect(app.rename('During')).toBe(false);
    app.undo();
    app.redo();
    await settle();
    expect(app.project).toBe(before);
    expect(app.project?.name).toBe('Before');
    expect(noticeTexts(app)).toEqual([english.fileErrors.BUSY]);
    const savedBefore = control.calls.filter((call) => call === 'saveProject').length;
    finish(openedProjectOf(project([workTask('z')], [], { name: 'Next' })));
    await opening;
    expect(app.fileActionRunning).toBe(false);
    expect(app.project?.name).toBe('Next');
    expect(control.calls.filter((call) => call === 'saveProject')).toHaveLength(savedBefore);
    expect(app.rename('Next, renamed')).toBe(true);
  });

  it('lets the project change again once a file action fails', async () => {
    const { app, control } = await withOpenPlan();
    control.openResult = { ok: false, error: { code: 'READ_FAILED' } };
    await app.open();
    expect(app.fileActionRunning).toBe(false);
    expect(app.rename('After a failure')).toBe(true);
  });

  it('refuses an opening or an export asked while another opening runs, telling the user', async () => {
    const { app, control, context } = await withOpenPlan();
    const before = app.project;
    let finish: (result: BridgeResult<OpenedProject>) => void = () => undefined;
    Object.assign(context.bridge, {
      openProject: () => {
        control.calls.push('openProject');
        return new Promise<BridgeResult<OpenedProject>>((resolve) => {
          finish = resolve;
        });
      },
    });
    const first = app.open();
    await settle();
    await app.open();
    await app.exportFile('json');
    expect(app.project).toBe(before);
    finish(openedProjectOf(project([workTask('z')], [], { name: 'Next' })));
    await first;
    expect(control.calls.filter((call) => call === 'openProject')).toHaveLength(2);
    expect(control.exports).toEqual([]);
    expect(noticeTexts(app)).toEqual([english.fileErrors.BUSY]);
    expect(app.project?.name).toBe('Next');
  });

  it('keeps the open project and tells why when it cannot be saved before a new one', async () => {
    const { app, control } = await withOpenPlan();
    await change(app);
    control.saveResult = { ok: false, error: { code: 'WRITE_FAILED' } };
    const before = app.project;
    await app.newProject();
    expect(app.project).toBe(before);
    expect(noticeTexts(app)).toEqual([
      english.fileErrors.WRITE_FAILED,
      english.fileErrors.UNSAVED_PROJECT,
    ]);
  });
});

describe('local copies and recent projects', () => {
  it('warns when a save wrote the file but not its copy on this computer', async () => {
    const { app, control } = await withOpenPlan();
    control.saveResult = { ok: true, value: { localCopySaved: false } };
    await app.save();
    expect(app.saveStatus).toBe('saved');
    expect(app.notices.map((notice) => [notice.kind, notice.text])).toEqual([
      ['warning', english.notices.localCopyFailed],
    ]);
  });

  it('keeps the previous recent projects and warns when the main process cannot read them', async () => {
    const { app, control } = await withOpenPlan();
    control.recent = [{ name: 'Thesis', folder: '/projects' }];
    await app.loadRecentProjects();
    control.recent = 'unreadable';
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await app.loadRecentProjects();
      expect(logged).toHaveBeenCalledWith('The recent projects could not be loaded:', {
        code: 'READ_FAILED',
      });
    } finally {
      logged.mockRestore();
    }
    expect(app.recentProjects).toEqual([{ name: 'Thesis', folder: '/projects' }]);
    expect(noticeTexts(app)).toEqual([english.notices.recentUnavailable]);
  });

  it('keeps the previous recent projects and warns when they cannot be loaded, the save still succeeding', async () => {
    const { app, control } = await withOpenPlan();
    control.recent = [{ name: 'Thesis', folder: '/projects' }];
    await app.loadRecentProjects();
    control.recent = new Error('bridge gone');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await app.save();
      expect(logged).toHaveBeenCalledWith(
        'The recent projects could not be loaded:',
        new Error('bridge gone'),
      );
    } finally {
      logged.mockRestore();
    }
    expect(app.saveStatus).toBe('saved');
    expect(app.recentProjects).toEqual([{ name: 'Thesis', folder: '/projects' }]);
    expect(noticeTexts(app)).toEqual([english.notices.recentUnavailable]);
  });

  it('keeps the open project when the main process does not adopt the one opened', async () => {
    const { app, control } = await withOpenPlan();
    const before = app.project;
    control.openResult = openedProjectOf(project([workTask('z')], [], { name: 'Other' }));
    control.adoptResult = { ok: false, error: { code: 'TASK_FAILED' } };
    await app.open();
    expect(app.project).toBe(before);
    expect(noticeTexts(app)).toEqual([english.fileErrors.TASK_FAILED]);
  });
});

describe('the state without a project', () => {
  it('has no rows, no calendar and nothing a block waits for', () => {
    const { app } = createApp();
    expect(app.outline.rows).toEqual([]);
    expect(app.calendar).toBeNull();
    expect(app.blockWaitText('a', 1)).toBe('');
  });
});

describe('failures of automatic saves', () => {
  it('tells that an automatic save stopped unexpectedly, logging why', async () => {
    const created = createApp();
    Object.assign(created.context.bridge, {
      saveProject: () => Promise.reject(new Error('bridge gone')),
    });
    const app = new AppState(created.context);
    created.control.openResult = openedProjectOf(PLAN);
    await app.open();
    vi.useFakeTimers();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(app.rename('Changed')).toBe(true);
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
      expect(logged).toHaveBeenCalledWith(new Error('bridge gone'));
    } finally {
      logged.mockRestore();
    }
    expect(noticeTexts(app)).toEqual([english.fileErrors.TASK_FAILED]);
  });
});
