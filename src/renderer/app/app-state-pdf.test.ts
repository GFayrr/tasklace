import { describe, expect, it, vi } from 'vitest';
import type { PrintDocument } from '../../core/print/print-document';
import { project, workTask } from '../../core/testing/project-builder';
import english from '../locales/en.json';
import { AppState } from './app-state.svelte';
import {
  FIXED_NOW,
  OPENED_DOCUMENT_ID,
  fakeAppContext,
  openedAppOf,
  settle,
} from './testing/fake-app-context';

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
    expect(app.pdfExport).toEqual({ documentId: OPENED_DOCUMENT_ID, exportedAt: FIXED_NOW });
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

  it('writes the PDF kept back made lighter without the browser when asked', async () => {
    const { app, control } = await openedAppOf(PLAN);
    app.openPdfExport();
    control.heldPdfResult = { ok: true, value: { fileName: 'Lighter.pdf' } };
    expect(await app.saveHeldPdf(true)).toBe(true);
    expect(control.calls.filter((call) => call.endsWith('Pdf'))).toEqual(['exportLighterPdf']);
    expect(noticesOf(app)).toEqual([['info', 'Exported to Lighter.pdf.']]);
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

  it('asks the main process to forget the PDF it kept back when the export closes or another project opens, once', async () => {
    const { app, control } = await openedAppOf(PLAN);
    app.closePdfExport();
    app.openPdfExport();
    app.closePdfExport();
    app.closePdfExport();
    app.openPdfExport();
    await app.open();
    await settle();
    expect(control.calls.filter((call) => call === 'discardHeldPdf')).toEqual([
      'discardHeldPdf',
      'discardHeldPdf',
    ]);
  });

  it('logs a PDF kept back that the main process could not forget, whether it answers a failure or the request fails', async () => {
    const { app, control, context } = await openedAppOf(PLAN);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    control.discardResult = { ok: false, error: { code: 'TASK_FAILED' } };
    app.openPdfExport();
    app.closePdfExport();
    await settle();
    const refused = new Error('Refused');
    Object.assign(context.bridge, { discardHeldPdf: () => Promise.reject(refused) });
    app.openPdfExport();
    app.closePdfExport();
    await settle();
    expect(logged.mock.calls).toEqual([
      ['The PDF kept back could not be forgotten:', { code: 'TASK_FAILED' }],
      ['The PDF kept back could not be forgotten:', refused],
    ]);
    logged.mockRestore();
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
