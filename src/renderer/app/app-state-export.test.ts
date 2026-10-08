import { describe, expect, it, vi } from 'vitest';
import { project, workTask } from '../../core/testing/project-builder';
import english from '../locales/en.json';
import { AppState } from './app-state.svelte';
import { fakeAppContext, openedProjectOf } from './testing/fake-app-context';

const csvExport = vi.hoisted((): { refusal: 'UNKNOWN_BLOCK' | 'SCHEDULE_MISMATCH' } => ({
  refusal: 'UNKNOWN_BLOCK',
}));

vi.mock('../../core/exchange/csv/project-csv-export', () => ({
  exportProjectCsv: () => ({ ok: false, error: csvExport.refusal }),
}));

describe('a CSV export the table refuses', () => {
  it.each(['UNKNOWN_BLOCK', 'SCHEDULE_MISMATCH'] as const)(
    'writes nothing and explains the refusal %s',
    async (refusal) => {
      csvExport.refusal = refusal;
      const { context, control } = fakeAppContext();
      const app = new AppState(context);
      control.openResult = openedProjectOf(project([workTask('a')], [], { name: 'Plan' }));
      await app.open();
      await app.exportFile('csv');
      expect(control.exports).toEqual([]);
      expect(app.notices.map((notice) => [notice.kind, notice.text])).toEqual([
        ['error', english.notices.exportFailed[refusal]],
      ]);
    },
  );
});
