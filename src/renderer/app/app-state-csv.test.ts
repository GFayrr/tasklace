import { describe, expect, it, vi } from 'vitest';
import { project, workTask, link } from '../../core/testing/project-builder';
import { AppState } from './app-state.svelte';
import { fakeAppContext, openedProjectOf, settle } from './testing/fake-app-context';

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
});
