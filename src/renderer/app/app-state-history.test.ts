import { describe, expect, it, vi } from 'vitest';
import type { MergeFailure } from '../../core/shared/shared-project';
import { project, workTask } from '../../core/testing/project-builder';
import english from '../locales/en.json';
import { AppState } from './app-state.svelte';
import { fakeAppContext, openedProjectOf } from './testing/fake-app-context';

const refusal = vi.hoisted((): { value: MergeFailure } => ({
  value: { kind: 'invalidProject', issues: [] },
}));

vi.mock('../../core/shared/shared-session', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../core/shared/shared-session')>();
  return {
    ...original,
    openSharedSessionFromState: (
      ...values: Parameters<typeof original.openSharedSessionFromState>
    ) => {
      const opened = original.openSharedSessionFromState(...values);
      if (!opened.ok) {
        return opened;
      }
      const refused = () => ({ ok: false, error: refusal.value }) as const;
      const history = { ...opened.value.history, undo: refused, redo: refused };
      return { ok: true, value: { ...opened.value, history } };
    },
  };
});

/** Opens a small plan in an application state whose undo and redo are refused. */
async function openedApp() {
  const { context, control } = fakeAppContext();
  const app = new AppState(context);
  control.openResult = openedProjectOf(project([workTask('a')], [], { name: 'Plan' }));
  await app.open();
  return app;
}

describe('undo and redo that no longer fit the project', () => {
  it('tells the user that the change cannot be undone or redone, leaving the project as it was and logging why', async () => {
    refusal.value = { kind: 'invalidProject', issues: [] };
    const app = await openedApp();
    const before = app.project;
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      app.undo();
      app.redo();
      expect(logged.mock.calls).toEqual([
        ['The step could not be undone or redone:', refusal.value],
        ['The step could not be undone or redone:', refusal.value],
      ]);
    } finally {
      logged.mockRestore();
    }
    expect(app.project).toBe(before);
    expect(app.notices.map((notice) => [notice.kind, notice.text])).toEqual([
      ['warning', english.notices.undoFailed],
      ['warning', english.notices.redoFailed],
    ]);
  });

  it('reports a repair that failed while undoing as an unexpected error, with its cause', async () => {
    const cause = new Error('repair broken');
    refusal.value = { kind: 'repairFailed', error: cause };
    const app = await openedApp();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      app.undo();
      expect(logged).toHaveBeenCalledWith('Unexpected error:', cause);
    } finally {
      logged.mockRestore();
    }
    expect(app.notices.map((notice) => [notice.kind, notice.text])).toEqual([
      ['error', english.notices.unexpectedError],
    ]);
  });
});
