import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at } from '../../core/testing/civil-time';
import { project, scheduleOrThrow, summary, workTask } from '../../core/testing/project-builder';
import english from '../locales/en.json';
import { toggleProjectOption } from '../plan/project-commands';
import { setDuration } from '../plan/task-commands';
import { AppState } from './app-state.svelte';
import { fakeAppContext, openedProjectOf, settle } from './testing/fake-app-context';

const NOW = new Date(2026, 9, 6, 10, 40);
const PLAN = project(
  [
    summary('empty', { sortKey: 'a' }),
    workTask('a', { sortKey: 'b' }),
    workTask('b', { sortKey: 'c' }),
  ],
  [],
  {
    options: {
      criticalPathEnabled: false,
      dateConstraintsEnabled: false,
      baselineEnabled: true,
      alwaysShowPatterns: false,
    },
  },
);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

/** Opens the plan, whose baseline is turned on but not set, in an application state. */
async function openedApp() {
  const fake = fakeAppContext();
  const app = new AppState({ ...fake.context, now: () => new Date() });
  fake.control.openResult = openedProjectOf(PLAN);
  await app.open();
  await settle();
  return { app, ...fake };
}

describe('the baseline in the application state', () => {
  it('freezes the plan as it is now, taken at the current quarter hour, and shows it by task', async () => {
    const { app } = await openedApp();
    expect(app.shownBaseline).toBeNull();
    expect(app.setBaseline()).toBeNull();
    await settle();
    const schedule = scheduleOrThrow(PLAN);
    const entry = (id: string) => {
      const placement = schedule.placements.get(id);
      return { taskId: id, start: placement?.start, end: placement?.end, durationHours: 7 };
    };
    expect(app.project?.baseline).toEqual({
      takenAt: at(2026, 10, 6, 10) + 0.5,
      entries: [entry('a'), entry('b')],
    });
    expect([...(app.shownBaseline?.entries() ?? [])]).toEqual([
      ['a', entry('a')],
      ['b', entry('b')],
    ]);
    expect(app.notices).toEqual([]);
  });

  it('hides the baseline while it is turned off, keeping it, and clears it on demand, Ctrl+Z bringing it back', async () => {
    const { app } = await openedApp();
    expect(app.setBaseline()).toBeNull();
    await settle();
    const baseline = app.project?.baseline;
    expect(
      app.editSettings((context) => toggleProjectOption(context, 'baselineEnabled')),
    ).toBeNull();
    expect([app.shownBaseline, app.project?.baseline]).toEqual([null, baseline]);
    app.undo();
    expect(app.clearBaseline()).toBeNull();
    expect([app.shownBaseline, app.project?.baseline]).toEqual([null, null]);
    app.undo();
    await settle();
    expect(app.project?.baseline).toEqual(baseline);
  });

  it('refuses to freeze dates that are still being computed, that stopped or that could not be computed', async () => {
    const { app, scheduler } = await openedApp();
    scheduler.automatic = false;
    expect(
      app.editSettings((context) => toggleProjectOption(context, 'criticalPathEnabled')),
    ).toBeNull();
    expect(app.setBaseline()).toBe(english.editErrors.SCHEDULE_PENDING);
    const opened = app.project;
    if (opened === null) {
      throw new Error('No project');
    }
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      scheduler.listener().failed(new Error('stopped'));
      expect(app.setBaseline()).toBe(english.editErrors.SCHEDULE_STOPPED);
      const failure = { kind: 'startDate' } as const;
      scheduler.listener().scheduled({ ok: false, error: failure }, opened);
      expect(app.setBaseline()).toBe(english.editErrors.SCHEDULE_FAILED);
      expect(logged.mock.calls.at(-1)).toEqual(['The schedule could not be computed:', failure]);
    } finally {
      logged.mockRestore();
    }
    expect([app.project?.baseline, app.baselineNotice]).toEqual([null, null]);
  });

  it('refuses to date a baseline with a clock outside the supported years, logging it', async () => {
    const fake = fakeAppContext();
    const wrong = new Date(2250, 0, 1, 9);
    const app = new AppState({ ...fake.context, now: () => wrong });
    fake.control.openResult = openedProjectOf(PLAN);
    await app.open();
    await settle();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(app.setBaseline()).toBe(english.editErrors.CLOCK_OUT_OF_RANGE);
      expect(logged.mock.calls).toEqual([
        ['The clock is outside the supported years; the baseline is refused:', wrong],
      ]);
    } finally {
      logged.mockRestore();
    }
    expect(app.project?.baseline).toBeNull();
  });

  it('tells in the settings how many tasks could not be frozen, logging them, never counting an empty summary', async () => {
    const { app, scheduler } = await openedApp();
    const opened = app.project;
    if (opened === null) {
      throw new Error('No project');
    }
    const schedule = scheduleOrThrow(opened);
    const placements = new Map([...schedule.placements].filter(([id]) => id === 'empty'));
    scheduler.listener().scheduled({ ok: true, value: { ...schedule, placements } }, opened);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(app.setBaseline()).toBeNull();
      expect(logged.mock.calls).toEqual([
        [
          'Tasks could not be frozen in the baseline:',
          [
            { taskId: 'a', reason: 'NO_DATES' },
            { taskId: 'b', reason: 'NO_DATES' },
          ],
        ],
      ]);
    } finally {
      logged.mockRestore();
    }
    expect(app.project?.baseline?.entries).toEqual([]);
    expect(app.baselineNotice).toBe(english.notices.baselineSkipped.other.replace('{count}', '2'));
    expect(app.notices).toEqual([]);
    expect(app.clearBaseline()).toBeNull();
    expect(app.baselineNotice).toBeNull();
  });

  it('replaces the baseline with the plan as it is now, Ctrl+Z bringing back the first one', async () => {
    const { app } = await openedApp();
    expect(app.setBaseline()).toBeNull();
    await settle();
    const first = app.project?.baseline;
    expect(app.edit((context) => setDuration(context, 'b', '14'))).toBe(true);
    await settle();
    expect(app.setBaseline()).toBeNull();
    await settle();
    const later = scheduleOrThrow(app.project ?? PLAN).placements.get('b');
    expect(app.project?.baseline?.entries.find((entry) => entry.taskId === 'b')).toEqual({
      taskId: 'b',
      start: later?.start,
      end: later?.end,
      durationHours: 14,
    });
    app.undo();
    await settle();
    expect(app.project?.baseline).toEqual(first);
  });
});
