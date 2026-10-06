import { describe, expect, it } from 'vitest';
import { MIN_PROJECT_YEAR } from '../../core/limits';
import type { Project } from '../../core/model/project';
import { success } from '../../core/result';
import { link, project, workTask } from '../../core/testing/project-builder';
import english from '../locales/en.json';
import { toggleProjectOption } from '../plan/project-commands';
import { AppState } from './app-state.svelte';
import { fakeAppContext, openedProjectOf, settle } from './testing/fake-app-context';

const START = 490_896;
const NOTICE = {
  one: english.notices.unknownFloats.one.replace('{firstYear}', String(MIN_PROJECT_YEAR)),
  other: english.notices.unknownFloats.other.replace('{firstYear}', String(MIN_PROJECT_YEAR)),
};

/** Builds a block of a work task. */
function block(durationHours: number, gapDaysBefore: number) {
  return { durationHours, gapDaysBefore, startNoEarlierThan: null };
}

/** Builds a project whose calendar works a quarter hour a week and whose last task must finish on the project start, so that the latest dates of the tasks it waits for fall before the supported years. */
function sparse(waiting: readonly string[]): Project {
  return {
    ...project(
      [
        ...waiting.map((id) => workTask(id, { segments: [block(0.25, 0)] })),
        workTask('report', {
          segments: [block(19.5, 0), block(27.5, 8), block(21.5, 8)],
          mustFinishOn: START,
        }),
      ],
      waiting.map((id) => link(id, 'report', 'finishToStart', 13.75)),
      {
        startDate: START,
        options: {
          criticalPathEnabled: true,
          dateConstraintsEnabled: true,
          alwaysShowPatterns: false,
        },
      },
    ),
    calendar: {
      workingWeekdays: [5],
      workingTimeRanges: [{ startHour: 4.25, endHour: 4.5 }],
      nonWorkingPeriods: [],
    },
  };
}

/** Opens a plan in an application state. */
async function openedApp(plan: Project) {
  const fake = fakeAppContext();
  const app = new AppState(fake.context);
  fake.control.openResult = openedProjectOf(plan);
  await app.open();
  await settle();
  return { app, ...fake };
}

/** Returns the texts of the messages shown. */
function noticeTexts(app: AppState): string[] {
  return app.notices.map((notice) => notice.text);
}

describe('floats that cannot be worked out', () => {
  it('are told once in a lasting message, replaced when their count changes and removed once none is left', async () => {
    const { app } = await openedApp(sparse(['a']));
    expect(app.schedule?.floats?.get('a')?.totalFloatHours).toBeNull();
    expect(app.notices.map((notice) => [notice.kind, notice.text, notice.lasting])).toEqual([
      ['warning', NOTICE.one.replace('{count}', '1'), true],
    ]);
    const shown = app.notices[0]?.id;
    expect(app.rename('Renamed')).toBe(true);
    await settle();
    expect(app.notices.map((notice) => notice.id)).toEqual([shown]);
    const waiting = workTask('b', { segments: [block(0.25, 0)], sortKey: 'b' });
    expect(
      app.tryEdit(() =>
        success([
          { type: 'putTask', task: waiting },
          { type: 'putDependency', dependency: link('b', 'report', 'finishToStart', 13.75) },
        ]),
      ),
    ).toBeNull();
    await settle();
    expect(noticeTexts(app)).toEqual([NOTICE.other.replace('{count}', '2')]);
    expect(
      app.editSettings((context) => toggleProjectOption(context, 'criticalPathEnabled')),
    ).toBeNull();
    await settle();
    expect(app.notices).toEqual([]);
  });

  it('stay dismissed while their count stays the same, and are told again once it changes', async () => {
    const { app } = await openedApp(sparse(['a']));
    app.dismiss(app.notices[0]?.id ?? -1);
    expect(app.notices).toEqual([]);
    expect(app.rename('Renamed')).toBe(true);
    await settle();
    expect(app.notices).toEqual([]);
    const waiting = workTask('b', { segments: [block(0.25, 0)], sortKey: 'b' });
    expect(
      app.tryEdit(() =>
        success([
          { type: 'putTask', task: waiting },
          { type: 'putDependency', dependency: link('b', 'report', 'finishToStart', 13.75) },
        ]),
      ),
    ).toBeNull();
    await settle();
    expect(noticeTexts(app)).toEqual([NOTICE.other.replace('{count}', '2')]);
  });

  it('are forgotten when the schedule fails, which shows its own message', async () => {
    const { app, scheduler } = await openedApp(sparse(['a']));
    expect(app.notices).toHaveLength(1);
    scheduler.automatic = false;
    expect(app.rename('Renamed')).toBe(true);
    await settle();
    const latest = app.project;
    if (latest === null) {
      throw new Error('The plan closed.');
    }
    scheduler.listener().scheduled({ ok: false, error: { kind: 'startDate' } }, latest);
    expect(noticeTexts(app)).toEqual([english.scheduleFailures.startDate]);
  });

  it('are forgotten when another project opens', async () => {
    const { app, control } = await openedApp(sparse(['a']));
    expect(app.notices).toHaveLength(1);
    control.openResult = openedProjectOf(project([workTask('z')]));
    await app.open();
    await settle();
    expect(app.notices).toEqual([]);
  });
});
