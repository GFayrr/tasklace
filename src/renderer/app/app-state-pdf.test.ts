import { describe, expect, it } from 'vitest';
import type { PrintDocument } from '../../core/print/print-document';
import { project, workTask } from '../../core/testing/project-builder';
import english from '../locales/en.json';
import { AppState } from './app-state.svelte';
import { fakeAppContext, openedAppOf } from './testing/fake-app-context';

const DOCUMENT: PrintDocument = {
  paper: 'a4',
  orientation: 'landscape',
  title: 'Thesis',
  pages: [[]],
};
const PLAN = project([workTask('a')], [], { name: 'Thesis' });

/** Lists the kind and text of the messages shown. */
function noticesOf(app: AppState): [string, string][] {
  return app.notices.map((notice) => [notice.kind, notice.text]);
}

describe('exporting to PDF from the application state', () => {
  it('sends the document with the name of the project, tells the file written and closes the export', async () => {
    const { app, control } = await openedAppOf(PLAN);
    app.openPdfExport();
    expect(await app.exportPdf(DOCUMENT)).toBeNull();
    expect(control.pdfExports).toEqual([{ document: DOCUMENT, name: 'Thesis' }]);
    expect(noticesOf(app)).toEqual([['info', 'Exported to Thesis.pdf.']]);
    expect(app.pdfExport).toBeNull();
  });

  it('returns the size of a PDF kept back for being heavy, the export staying open and nothing told', async () => {
    const { app, control } = await openedAppOf(PLAN);
    app.openPdfExport();
    control.pdfResult = { ok: true, value: { kind: 'heavy', bytes: 1_400_000, pages: 12 } };
    expect(await app.exportPdf(DOCUMENT)).toEqual({ bytes: 1_400_000, pages: 12 });
    expect(noticesOf(app)).toEqual([]);
    expect(app.pdfExport).not.toBeNull();
  });

  it('writes the PDF kept back when asked, telling the file and closing the export', async () => {
    const { app, control } = await openedAppOf(PLAN);
    app.openPdfExport();
    control.heldPdfResult = { ok: true, value: { fileName: 'Heavy.pdf' } };
    expect(await app.saveHeldPdf()).toBe(true);
    expect(control.calls.filter((call) => call === 'saveHeldPdf')).toEqual(['saveHeldPdf']);
    expect(noticesOf(app)).toEqual([['info', 'Exported to Heavy.pdf.']]);
    expect(app.pdfExport).toBeNull();
  });

  it('tells nothing when the user cancels the choice of the file, the export staying open', async () => {
    const { app, control } = await openedAppOf(PLAN);
    app.openPdfExport();
    control.heldPdfResult = { ok: false, error: { code: 'CANCELLED' } };
    expect(await app.saveHeldPdf()).toBe(false);
    control.pdfResult = { ok: false, error: { code: 'CANCELLED' } };
    expect(await app.exportPdf(DOCUMENT)).toBeNull();
    expect(noticesOf(app)).toEqual([]);
    expect(app.pdfExport).not.toBeNull();
  });

  it('explains a PDF too large to be written, and any other failure as for the other exports', async () => {
    const { app, control } = await openedAppOf(PLAN);
    control.pdfResult = { ok: false, error: { code: 'TOO_LARGE' } };
    await app.exportPdf(DOCUMENT);
    control.heldPdfResult = { ok: false, error: { code: 'WRITE_FAILED' } };
    await app.saveHeldPdf();
    expect(noticesOf(app)).toEqual([
      ['error', english.print.tooLarge],
      ['error', english.fileErrors.WRITE_FAILED],
    ]);
  });

  it('exports nothing without a project', async () => {
    const { context, control } = fakeAppContext();
    const app = new AppState(context);
    expect(await app.exportPdf(DOCUMENT)).toBeNull();
    app.openPdfExport();
    expect(app.pdfExport).toBeNull();
    expect(control.pdfExports).toEqual([]);
  });
});
