import { afterEach, describe, expect, it, vi } from 'vitest';
import { project, workTask, testId } from '../../core/testing/project-builder';
import { renameTask, setPredecessors } from '../plan/task-commands';
import { AppState } from './app-state.svelte';
import { fakeAppContext, openedProjectOf, settle } from './testing/fake-app-context';

const broken = vi.hoisted(() => ({ outline: false, incoming: false, calls: [] as string[] }));

vi.mock('../plan/plan-outline', async (importOriginal) => {
  const original = await importOriginal<typeof import('../plan/plan-outline')>();
  return {
    ...original,
    nextPlanOutline: (...args: Parameters<typeof original.nextPlanOutline>) => {
      broken.calls.push(args[0] === null ? 'outline from nothing' : 'outline');
      if (broken.outline && args[0] !== null) {
        broken.outline = false;
        throw new Error('Broken outline');
      }
      return original.nextPlanOutline(...args);
    },
    nextIncoming: (...args: Parameters<typeof original.nextIncoming>) => {
      broken.calls.push(args[0] === null ? 'incoming from nothing' : 'incoming');
      if (broken.incoming && args[0] !== null) {
        broken.incoming = false;
        throw new Error('Broken grouping');
      }
      return original.nextIncoming(...args);
    },
  };
});

const PLAN = project([workTask('a', { sortKey: 'a' }), workTask('b', { sortKey: 'b' })], [], {
  name: 'Thesis',
});

/** Opens a plan in a new application state and reads its outline and grouping once, as the page does. */
async function openedApp() {
  const fake = fakeAppContext();
  const app = new AppState(fake.context);
  fake.control.openResult = openedProjectOf(PLAN);
  await app.open();
  await settle();
  expect(app.outline.rows).toHaveLength(2);
  expect(app.incoming.get(testId('b'))).toBeUndefined();
  broken.calls = [];
  return { app, ...fake };
}

describe('the outline and grouping of the plan', () => {
  afterEach(() => {
    broken.outline = false;
    broken.incoming = false;
  });

  it('builds the outline again from nothing when following a change throws, logging why, then follows changes again', async () => {
    const { app } = await openedApp();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      broken.outline = true;
      expect(app.edit((context) => renameTask(context, testId('a'), 'Read'))).toBe(true);
      expect(app.outline.rows.map((row) => row.task.name)).toEqual(['Read', 'b']);
      expect(app.edit((context) => renameTask(context, testId('b'), 'Write'))).toBe(true);
      expect(app.outline.rows.map((row) => row.task.name)).toEqual(['Read', 'Write']);
      expect(logged.mock.calls).toEqual([
        ['The outline of the plan is built again after an error:', new Error('Broken outline')],
      ]);
    } finally {
      logged.mockRestore();
    }
    expect(broken.calls).toEqual(['outline', 'outline from nothing', 'outline']);
  });

  it('groups the dependencies again from nothing when following a change throws, logging why, then follows changes again', async () => {
    const { app } = await openedApp();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      broken.incoming = true;
      expect(app.edit((context) => setPredecessors(context, testId('b'), '1'))).toBe(true);
      expect(app.incoming.get(testId('b'))?.map((each) => each.predecessorId)).toEqual([
        testId('a'),
      ]);
      expect(app.edit((context) => setPredecessors(context, testId('b'), ''))).toBe(true);
      expect(app.incoming.get(testId('b'))).toBeUndefined();
      expect(logged.mock.calls).toEqual([
        [
          'The dependencies of the plan are grouped again after an error:',
          new Error('Broken grouping'),
        ],
      ]);
    } finally {
      logged.mockRestore();
    }
    expect(broken.calls.filter((call) => call.startsWith('incoming'))).toEqual([
      'incoming',
      'incoming from nothing',
      'incoming',
    ]);
  });

  it('builds the outline and grouping of a newly opened plan from nothing', async () => {
    const { app, control } = await openedApp();
    control.openResult = openedProjectOf(project([workTask('c')], [], { name: 'Other' }));
    await app.open();
    await settle();
    expect(app.outline.rows.map((row) => row.task.id)).toEqual([testId('c')]);
    expect(app.incoming.get(testId('c'))).toBeUndefined();
    expect(broken.calls).toEqual(['outline from nothing', 'incoming from nothing']);
  });
});
