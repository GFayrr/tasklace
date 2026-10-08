import { describe, expect, it, vi } from 'vitest';
import { project, workTask } from '../../core/testing/project-builder';
import english from '../locales/en.json';
import { AppState } from './app-state.svelte';
import { fakeAppContext, openedProjectOf } from './testing/fake-app-context';

vi.mock('../../core/limits', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../core/limits')>();
  return { ...original, MAX_TASKS: 2 };
});

describe('adding a task to a project at its limit', () => {
  it('tells why, keeping the selection and asking no name to be typed for a task never created', async () => {
    const { context, control } = fakeAppContext();
    const app = new AppState(context);
    control.openResult = openedProjectOf(
      project([workTask('a'), workTask('b')], [], { name: 'Full' }),
    );
    await app.open();
    app.select('a');
    const before = app.project;
    app.addTask();
    expect(app.project).toBe(before);
    expect(app.selectedTaskId).toBe('a');
    expect(app.editRequest).toBeNull();
    expect(app.notices.map((notice) => notice.text)).toEqual([english.editErrors.TOO_MANY_ITEMS]);
  });
});
