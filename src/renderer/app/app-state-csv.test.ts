import { describe, expect, it, vi } from 'vitest';
import { project, workTask, link } from '../../core/testing/project-builder';
import { exportProjectCsv } from '../../core/exchange/csv/project-csv-export';
import { scheduleProject } from '../../core/scheduling/schedule-project';
import { unwrap } from '../../core/testing/arbitraries';
import { setDuration } from '../plan/task-commands';
import english from '../locales/en.json';
import { AppState } from './app-state.svelte';
import { fakeAppContext, FRENCH_FORMAT, openedProjectOf, settle } from './testing/fake-app-context';

const scheduling = vi.hoisted(() => ({ calls: 0 }));

vi.mock('../../core/scheduling/schedule-project', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../core/scheduling/schedule-project')>();
  return {
    ...original,
    scheduleProject: (...values: Parameters<typeof original.scheduleProject>) => {
      scheduling.calls += 1;
      return original.scheduleProject(...values);
    },
  };
});

const PLAN = project([workTask('a'), workTask('b')], [link('a', 'b')], { name: 'Plan' });

describe('a CSV export', () => {
  it('reuses the schedule computed for the project as it is, and computes it again only when it is out of date', async () => {
    const { context, control, scheduler } = fakeAppContext();
    const app = new AppState(context);
    control.openResult = openedProjectOf(PLAN);
    await app.open();
    const computed = scheduling.calls;
    await app.exportFile('csv');
    expect(scheduling.calls).toBe(computed);
    scheduler.automatic = false;
    expect(app.rename('Renamed')).toBe(true);
    await settle();
    await app.exportFile('csv');
    expect(scheduling.calls).toBe(computed + 1);
    const [reused, recomputed] = control.exports.map((exported) => exported.text);
    expect(recomputed).toBe(reused);
  });

  it('exports the dates of the project as it is after a change whose schedule is not computed yet', async () => {
    const { context, control, scheduler } = fakeAppContext();
    const app = new AppState(context);
    control.openResult = openedProjectOf(PLAN);
    await app.open();
    scheduler.automatic = false;
    expect(app.edit((edit) => setDuration(edit, 'b', '30'))).toBe(true);
    await settle();
    const changed = app.project;
    if (changed === null) {
      throw new Error('The plan closed.');
    }
    await app.exportFile('csv');
    const expected = exportProjectCsv(changed, unwrap(scheduleProject(changed)), FRENCH_FORMAT);
    expect(control.exports.map((exported) => exported.text)).toEqual([unwrap(expected)]);
  });

  it('computes again the schedule of a project whose last computation failed, telling it once', async () => {
    const { context, control, scheduler } = fakeAppContext();
    const app = new AppState(context);
    control.openResult = openedProjectOf(PLAN);
    scheduler.automatic = false;
    await app.open();
    const opened = app.project;
    if (opened === null) {
      throw new Error('The plan is not open.');
    }
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      scheduler.listener().scheduled({ ok: false, error: { kind: 'startDate' } }, opened);
      const computed = scheduling.calls;
      await app.exportFile('csv');
      expect(scheduling.calls).toBe(computed + 1);
    } finally {
      logged.mockRestore();
    }
    expect(control.exports.map((exported) => exported.kind)).toEqual(['csv']);
    expect(app.notices.map((notice) => notice.text)).toEqual([
      english.scheduleFailures.startDate,
      english.notices.exported.replace('{file}', 'plan.json'),
    ]);
  });
});
