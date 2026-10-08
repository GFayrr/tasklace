import { describe, expect, it } from 'vitest';
import { scheduleProject } from '../../core/scheduling/schedule-project';
import type { Project } from '../../core/model/project';
import { at } from '../../core/testing/civil-time';
import { HOURS_PER_DAY } from '../../core/time';
import { link, project, workTask } from '../../core/testing/project-builder';
import type { BridgeResult, OpenedProject } from '../../preload/bridge-contract';
import english from '../locales/en.json';
import { removeTimeRange, setTimeRange, setWorkingWeekday } from '../plan/project-commands';
import { AppState } from './app-state.svelte';
import { fakeAppContext, openedAppOf, openedProjectOf, settle } from './testing/fake-app-context';

const PLAN = project(
  [
    workTask('a', { name: 'Interviews', hoursPerDay: 6 }),
    workTask('b', { name: 'Analysis' }),
    workTask('c', {
      name: 'Writing',
      hoursPerDay: 2,
      dailyStartHour: 14,
      startNoEarlierThan: at(2026, 10, 26, 9),
    }),
  ],
  [link('a', 'b')],
  { name: 'Thesis' },
);
const MOVED = english.settings.tasksMoved;

/** Opens the plan in an application state. */
function openedApp() {
  return openedAppOf(PLAN);
}

/** Returns the open project, failing the test when there is none. */
function openProject(app: AppState): Project {
  if (app.project === null) {
    throw new Error('The plan closed.');
  }
  return app.project;
}

/** Hands the schedule of the open project to the application, as a manual scheduler would. */
function deliverSchedule(app: AppState, listener: ReturnType<typeof fakeAppContext>['scheduler']) {
  const latest = openProject(app);
  const computed = scheduleProject(latest);
  if (!computed.ok) {
    throw new Error(JSON.stringify(computed.error));
  }
  listener.listener().scheduled(computed, latest);
}

describe('opening the project settings', () => {
  it('opens only with a project, by its method or its shortcut, and closes clearing the message', async () => {
    const empty = new AppState(fakeAppContext().context);
    empty.openSettings();
    expect(empty.settings.isOpen).toBe(false);
    const { app } = await openedApp();
    const resets = app.settings.resets;
    await app.run('openSettings');
    expect([app.settings.isOpen, app.settings.resets]).toEqual([true, resets + 1]);
    expect(app.moveProjectStart('2026-10-05T09:00')).toBeNull();
    await settle();
    expect(app.settings.notice).toBe(MOVED.other.replace('{count}', '2'));
    app.settings.close();
    expect([app.settings.isOpen, app.settings.notice, app.settings.resets]).toEqual([
      false,
      null,
      resets + 2,
    ]);
  });

  it('closes when another project opens, forgetting what they showed', async () => {
    const { app, control } = await openedApp();
    app.openSettings();
    expect(app.moveProjectStart('2026-10-05T09:00')).toBeNull();
    await settle();
    control.openResult = openedProjectOf(project([workTask('z')], [], { name: 'Next' }));
    await app.open();
    expect([app.project?.name, app.settings.isOpen, app.settings.notice]).toEqual([
      'Next',
      false,
      null,
    ]);
  });

  it('stays open once when a refused value holds them, until a change is applied', async () => {
    const { app } = await openedApp();
    app.openSettings();
    app.settings.hold();
    expect(app.settings.closeUnlessHeld()).toBe(false);
    expect(app.settings.isOpen).toBe(true);
    expect(app.settings.closeUnlessHeld()).toBe(true);
    expect(app.settings.isOpen).toBe(false);
    app.openSettings();
    expect(app.editSettings((context) => removeTimeRange(context, 1))).not.toBeNull();
    expect(app.settings.closeUnlessHeld()).toBe(true);
    app.openSettings();
    app.settings.hold();
    expect(app.editSettings((context) => setWorkingWeekday(context, 6, true))).toBeNull();
    expect(app.settings.closeUnlessHeld()).toBe(true);
    app.openSettings();
    app.settings.hold();
    app.settings.close();
    app.openSettings();
    expect(app.settings.closeUnlessHeld()).toBe(true);
  });
});

describe('renaming the project from its settings', () => {
  it('renames it, changes nothing for the same name, and explains an empty name', async () => {
    const { app } = await openedApp();
    expect(app.renameFromSettings(' Master thesis ')).toBeNull();
    expect(app.project?.name).toBe('Master thesis');
    const renamed = app.project;
    expect(app.renameFromSettings('Master thesis')).toBeNull();
    expect(app.project).toBe(renamed);
    expect(app.renameFromSettings('  ')).toBe(english.issues.EMPTY_TEXT);
    expect(app.project).toBe(renamed);
    expect(app.notices).toEqual([]);
  });
});

describe('changing the calendar', () => {
  it('applies a change that fits every task, and computes the schedule again', async () => {
    const { app } = await openedApp();
    const before = app.schedule?.placements.get('a')?.start ?? Number.NaN;
    expect(app.editSettings((context) => setWorkingWeekday(context, 1, false))).toBeNull();
    expect(app.project?.calendar.workingWeekdays).toEqual([2, 3, 4, 5]);
    await settle();
    expect(app.schedule?.placements.get('a')?.start).toBe(before + HOURS_PER_DAY);
  });

  it('names the task whose hours per day a shorter working day cannot hold, keeping the calendar', async () => {
    const { app } = await openedApp();
    const before = app.project?.calendar;
    expect(app.editSettings((context) => removeTimeRange(context, 1))).toBe(
      english.settings.hoursPerDayTooLong.replace('{name}', 'Interviews').replace('{hours}', '6 h'),
    );
    expect(app.project?.calendar).toBe(before);
  });

  it('names the task whose daily start leaves it too few hours in a shorter working day', async () => {
    const { app } = await openedApp();
    expect(
      app.editSettings((context) => setTimeRange(context, 0, { start: '08:00', end: '12:00' })),
    ).toBeNull();
    expect(
      app.editSettings((context) => setTimeRange(context, 1, { start: '13:00', end: '15:00' })),
    ).toBe(
      english.settings.dailyStartTooLate.replace('{name}', 'Writing').replace('{time}', '14:00'),
    );
  });

  it('explains any other refusal by the problem of the calendar', async () => {
    const { app } = await openedApp();
    for (const day of [1, 2, 3, 4] as const) {
      expect(app.editSettings((context) => setWorkingWeekday(context, day, false))).toBeNull();
    }
    expect(app.editSettings((context) => setWorkingWeekday(context, 5, false))).toBe(
      english.issues.NO_WORKING_WEEKDAY,
    );
    expect(
      app.editSettings((context) => setTimeRange(context, 0, { start: '12:00', end: '09:00' })),
    ).toBe(english.issues.INVALID_WORKING_TIME_RANGE);
    expect(
      app.editSettings((context) => setTimeRange(context, 0, { start: '08:00', end: '14:00' })),
    ).toBe(english.issues.OVERLAPPING_WORKING_TIME_RANGES);
    expect(app.editSettings((context) => setTimeRange(context, 0, { start: '9', end: '' }))).toBe(
      english.editErrors.INVALID_TIME,
    );
  });

  it('refuses without project, and while a file action runs', async () => {
    const empty = new AppState(fakeAppContext().context);
    expect(empty.editSettings((context) => setWorkingWeekday(context, 6, true))).toBe(
      english.editErrors.NOT_POSSIBLE,
    );
    const { app, context } = await openedApp();
    let finish: (result: BridgeResult<OpenedProject>) => void = () => undefined;
    Object.assign(context.bridge, {
      openProject: () =>
        new Promise<BridgeResult<OpenedProject>>((resolve) => {
          finish = resolve;
        }),
    });
    const opening = app.open();
    await settle();
    expect(app.editSettings((edit) => setWorkingWeekday(edit, 6, true))).toBe(
      english.fileErrors.BUSY,
    );
    expect(app.moveProjectStart('2026-10-12T09:00')).toBe(english.fileErrors.BUSY);
    expect(app.renameFromSettings('During')).toBe(english.fileErrors.BUSY);
    finish({ ok: false, error: { code: 'CANCELLED' } });
    await opening;
    expect(app.project?.calendar.workingWeekdays).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('moving the project start', () => {
  it('tells how many tasks moved once the new schedule is known, without the notice of a task moving it', async () => {
    const { app } = await openedApp();
    expect(app.moveProjectStart('2026-10-12T09:00')).toBeNull();
    expect(app.project?.startDate).toBe(at(2026, 10, 12, 9));
    await settle();
    expect(app.settings.notice).toBe(MOVED.other.replace('{count}', '2'));
    expect(app.moveProjectStart('2026-10-13T09:00')).toBeNull();
    await settle();
    expect(app.settings.notice).toBe(MOVED.other.replace('{count}', '2'));
    expect(app.moveProjectStart('2026-09-21T09:00')).toBeNull();
    await settle();
    expect(app.project?.startDate).toBe(at(2026, 9, 21, 9));
    expect(app.settings.notice).toBe(MOVED.other.replace('{count}', '2'));
    expect(app.notices).toEqual([]);
  });

  it('counts a single task in the singular', async () => {
    const fake = fakeAppContext();
    const app = new AppState(fake.context);
    fake.control.openResult = openedProjectOf(project([workTask('only')]));
    await app.open();
    expect(app.moveProjectStart('2026-10-05T09:00')).toBeNull();
    await settle();
    expect(app.settings.notice).toBe(MOVED.one.replace('{count}', '1'));
  });

  it('counts none when every task keeps its own date', async () => {
    const fake = fakeAppContext();
    const app = new AppState(fake.context);
    fake.control.openResult = openedProjectOf(
      project([workTask('dated', { startNoEarlierThan: at(2026, 12, 1, 9) })]),
    );
    await app.open();
    expect(app.moveProjectStart('2026-10-05T09:00')).toBeNull();
    await settle();
    expect(app.settings.notice).toBe(MOVED.other.replace('{count}', '0'));
  });

  it('refuses a date that cannot be read or is not on a quarter hour, telling no move afterwards', async () => {
    const { app } = await openedApp();
    for (const text of ['next week', '2026-10-19T09:10']) {
      expect(app.moveProjectStart(text)).toBe(english.editErrors.INVALID_DATE);
    }
    expect(app.editSettings((context) => setWorkingWeekday(context, 6, true))).toBeNull();
    await settle();
    expect(app.settings.notice).toBeNull();
  });

  it('tells nothing when the schedule shown was not up to date before the move', async () => {
    const { app, scheduler } = await openedApp();
    scheduler.automatic = false;
    expect(app.rename('Changed')).toBe(true);
    await settle();
    expect(app.moveProjectStart('2026-10-12T09:00')).toBeNull();
    await settle();
    deliverSchedule(app, scheduler);
    expect(app.settings.notice).toBeNull();
  });

  it('counts from the schedule before a series of moves made before any new schedule', async () => {
    const { app, scheduler } = await openedApp();
    scheduler.automatic = false;
    expect(app.moveProjectStart('2026-10-12T09:00')).toBeNull();
    expect(app.moveProjectStart('2026-10-19T09:00')).toBeNull();
    expect(app.moveProjectStart('later')).toBe(english.editErrors.INVALID_DATE);
    deliverSchedule(app, scheduler);
    expect(app.settings.notice).toBe(MOVED.other.replace('{count}', '2'));
  });

  it('tells nothing when another change comes before the new schedule', async () => {
    const { app, scheduler } = await openedApp();
    scheduler.automatic = false;
    expect(app.moveProjectStart('2026-10-12T09:00')).toBeNull();
    expect(app.editSettings((context) => setWorkingWeekday(context, 6, true))).toBeNull();
    deliverSchedule(app, scheduler);
    expect(app.settings.notice).toBeNull();
  });

  it('shows in the settings why the schedule failed, forgets the move, and clears the reason once computed', async () => {
    const { app, scheduler } = await openedApp();
    scheduler.automatic = false;
    app.openSettings();
    expect(app.moveProjectStart('2026-10-12T09:00')).toBeNull();
    scheduler.listener().scheduled({ ok: false, error: { kind: 'startDate' } }, openProject(app));
    expect(app.settings.alert).toBe(english.scheduleFailures.startDate);
    expect(app.notices.map((notice) => notice.text)).toEqual([english.scheduleFailures.startDate]);
    expect(app.editSettings((context) => setWorkingWeekday(context, 6, true))).toBeNull();
    deliverSchedule(app, scheduler);
    expect([app.settings.alert, app.settings.notice]).toEqual([null, null]);
  });

  it('shows in the open settings that the scheduler stopped, and nothing in closed ones', async () => {
    const { app, scheduler } = await openedApp();
    scheduler.automatic = false;
    scheduler.listener().failed(new Error('Worker lost'));
    expect(app.settings.alert).toBeNull();
    app.openSettings();
    expect(app.moveProjectStart('2026-10-12T09:00')).toBeNull();
    scheduler.listener().failed(new Error('Worker lost'));
    expect(app.settings.alert).toBe(english.notices.scheduleStopped);
    deliverSchedule(app, scheduler);
    expect([app.settings.alert, app.settings.notice]).toEqual([null, null]);
  });

  it('forgets what the settings showed on undo and redo', async () => {
    const { app } = await openedApp();
    app.openSettings();
    expect(app.moveProjectStart('2026-10-12T09:00')).toBeNull();
    await settle();
    const resets = app.settings.resets;
    app.undo();
    await settle();
    expect([app.project?.startDate, app.settings.notice, app.settings.resets]).toEqual([
      PLAN.startDate,
      null,
      resets + 1,
    ]);
    app.redo();
    await settle();
    expect([app.project?.startDate, app.settings.notice, app.settings.resets]).toEqual([
      at(2026, 10, 12, 9),
      null,
      resets + 2,
    ]);
  });
});
