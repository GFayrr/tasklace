import { describe, expect, it, vi } from 'vitest';
import { project, workTask } from '../../core/testing/project-builder';
import english from '../locales/en.json';
import { AppState } from './app-state.svelte';
import { fakeAppContext, openedProjectOf } from './testing/fake-app-context';

vi.mock('../../core/shared/shared-session', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../core/shared/shared-session')>();
  return {
    ...original,
    openSharedSession: (...values: Parameters<typeof original.openSharedSession>) => {
      const opened = original.openSharedSession(...values);
      if (!opened.ok) {
        return opened;
      }
      const refused = () => ({ ok: false, error: { kind: 'invalidProject', issues: [] } }) as const;
      const history = { ...opened.value.history, undo: refused, redo: refused };
      return { ok: true, value: { ...opened.value, history } };
    },
  };
});

describe('undo and redo that no longer fit the project', () => {
  it('tells the user that the change cannot be undone or redone, leaving the project as it was', async () => {
    const { context, control } = fakeAppContext();
    const app = new AppState(context);
    control.openResult = openedProjectOf(project([workTask('a')], [], { name: 'Plan' }));
    await app.open();
    const before = app.project;
    app.undo();
    app.redo();
    expect(app.project).toBe(before);
    expect(app.notices.map((notice) => [notice.kind, notice.text])).toEqual([
      ['warning', english.notices.undoFailed],
      ['warning', english.notices.redoFailed],
    ]);
  });
});
