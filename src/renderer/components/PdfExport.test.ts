import { flushSync } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../core/model/project';
import { at } from '../../core/testing/civil-time';
import { link, project, workTask } from '../../core/testing/project-builder';
import {
  OPENED_DOCUMENT_ID,
  openedAppOf,
  openedProjectOf,
  settle,
} from '../app/testing/fake-app-context';
import english from '../locales/en.json';
import type { PrintSettings } from '../print/print-pages';
import type { BridgeResult, PdfExport } from '../../preload/bridge-contract';
import App from './App.svelte';
import { button, click, press, render, single } from './testing/render';
import { drawFrames, refuseDrawingContexts } from './testing/timeline-environment';

const TEXT = english.print;
const STORAGE_KEY = `tasklace.printSettings.${OPENED_DOCUMENT_ID}`;
const PLAN: Project = project(
  [
    workTask('a', { name: 'Survey', sortKey: 'a' }),
    workTask('b', { name: 'Writing', sortKey: 'b' }),
  ],
  [link('a', 'b')],
  { name: 'Thesis', startDate: at(2026, 9, 28, 9) },
);

beforeEach(() => {
  window.localStorage.clear();
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { load: () => Promise.resolve([]) },
  });
});

afterEach(() => {
  window.localStorage.clear();
});

/** Opens the sample plan, renders the application and opens the export to PDF from the Export menu, waiting for the printed font. */
async function renderExport(plan: Project = PLAN) {
  const opened = await openedAppOf(plan);
  const root = render(App, { app: opened.app });
  click(button(root, english.toolbar.export));
  const item = [...root.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (candidate) => candidate.textContent.trim() === english.toolbar.exportPdf,
  );
  if (item === undefined) {
    throw new Error('No PDF item in the Export menu');
  }
  click(item);
  await settle();
  flushSync();
  const dialog = single(root, 'dialog.export') as HTMLDialogElement;
  return { ...opened, page: root, root: dialog, dialog };
}

/** Builds a plan of a given number of tasks in a row, named Thesis. */
function longPlan(count: number): Project {
  const tasks = Array.from({ length: count }, (_unused, index) =>
    workTask(`t${String(index)}`, {
      name: `Task ${String(index + 1)}`,
      sortKey: `k${String(index).padStart(3, '0')}`,
    }),
  );
  return project(tasks, [], { name: 'Thesis', startDate: at(2026, 9, 28, 9) });
}

/** Finds a radio button or check box of the export window by the text of its label. */
function choice(root: ParentNode, label: string): HTMLInputElement {
  const found = [...root.querySelectorAll('label')].find(
    (candidate) => candidate.textContent.trim() === label,
  );
  const input = found?.querySelector('input');
  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`No choice ${label}`);
  }
  return input;
}

/** Chooses a radio button or toggles a check box, as a click on it does. */
function pick(input: HTMLInputElement): void {
  input.click();
  flushSync();
}

describe('the export to PDF', () => {
  it('opens from the Export menu, dated now, with the default settings and a preview of its single page', async () => {
    const { app, root, dialog } = await renderExport();
    expect(dialog.open).toBe(true);
    expect(app.pdfExport).toEqual({
      documentId: OPENED_DOCUMENT_ID,
      exportedAt: new Date(2026, 8, 28, 10),
    });
    expect(choice(root, TEXT.a4).checked).toBe(true);
    expect(choice(root, TEXT.landscape).checked).toBe(true);
    expect(choice(root, TEXT.automatic).checked).toBe(true);
    expect(single(root, '.caption').textContent).toBe('Preview · page 1 of 1');
    expect(single(root, 'canvas').getAttribute('aria-label')).toBe(TEXT.previewLabel);
    const drawn = drawFrames();
    expect(drawn.filter((call) => call.name === 'fillText').map((call) => call.args[0])).toContain(
      'Survey',
    );
    expect(button(root, TEXT.export).disabled).toBe(false);
  });

  it('names the period of the whole plan and the zoom the automatic choice picked', async () => {
    const { root } = await renderExport();
    expect(choice(root, 'Whole project (Sep 28, 2026 – Sep 29, 2026)').checked).toBe(true);
    expect([...root.querySelectorAll('small')].map((hint) => hint.textContent)).toEqual([
      'Automatic fits the period on the fewest pages: Day here.',
      TEXT.floatsHint,
    ]);
  });

  it('remembers the settings chosen for the project and opens with them the next time', async () => {
    const { app, root, dialog } = await renderExport();
    pick(choice(root, TEXT.a3));
    pick(choice(root, TEXT.portrait));
    pick(choice(root, english.zoom.week));
    pick(choice(root, english.table.wbs));
    pick(choice(root, TEXT.progress));
    pick(choice(root, english.table.wbs));
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null')).toEqual({
      paper: 'a3',
      orientation: 'portrait',
      period: { kind: 'whole' },
      zoom: 'week',
      columns: ['progress'],
    });
    click(button(root, TEXT.cancel));
    expect(dialog.open).toBe(false);
    app.openPdfExport();
    await settle();
    flushSync();
    expect(choice(root, TEXT.a3).checked).toBe(true);
    expect(choice(root, TEXT.progress).checked).toBe(true);
  });

  it('prints chosen days, keeps them when a date cannot be read, and explains days that end before they start', async () => {
    const { root } = await renderExport();
    pick(choice(root, TEXT.days));
    const first = single(root, `input[aria-label="${TEXT.firstDay}"]`) as HTMLInputElement;
    const last = single(root, `input[aria-label="${TEXT.lastDay}"]`) as HTMLInputElement;
    expect([first.value, last.value]).toEqual(['2026-09-28', '2026-09-29']);
    first.value = '';
    first.dispatchEvent(new Event('change', { bubbles: true }));
    flushSync();
    expect(
      (JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null') as PrintSettings).period,
    ).toEqual({
      kind: 'days',
      firstDay: 20_724,
      lastDay: 20_725,
    });
    first.value = '2026-10-05';
    first.dispatchEvent(new Event('change', { bubbles: true }));
    flushSync();
    expect(single(root, '[role="status"]').textContent).toBe(TEXT.refusals.EMPTY_PERIOD);
    pick(choice(root, 'Whole project (Sep 28, 2026 – Sep 29, 2026)'));
    expect(root.querySelector('[role="status"]')).toBeNull();
  });

  it('exports every page of the plan, then tells the file written and closes', async () => {
    const { app, root, control } = await renderExport(longPlan(40));
    click(button(root, TEXT.export));
    await settle();
    flushSync();
    const [sent] = control.pdfExports;
    expect(sent?.name).toBe('Thesis');
    expect(sent?.document.pages).toHaveLength(2);
    expect(sent?.document.title).toBe('Thesis');
    expect(app.pdfExport).toBeNull();
    expect(app.notices.map((notice) => notice.text)).toEqual(['Exported to Thesis.pdf.']);
  });

  it('says a PDF is heavier than expected and writes it as it is when asked', async () => {
    const { app, root, control } = await renderExport();
    control.pdfResult = { ok: true, value: { kind: 'heavy', bytes: 1_400_000, pages: 12 } };
    click(button(root, TEXT.export));
    await settle();
    flushSync();
    expect(single(root, '[role="alert"]').textContent.trim()).toBe(
      'This PDF weighs about 1.4 MB for 12 pages, more than expected. Tasklace can write a lighter one directly, with the same pages.',
    );
    expect(() => button(root, TEXT.export)).toThrow();
    click(button(root, TEXT.exportAsItIs));
    await settle();
    flushSync();
    expect(control.calls.filter((call) => call === 'saveHeldPdf')).toEqual(['saveHeldPdf']);
    expect(app.pdfExport).toBeNull();
  });

  it('writes the lighter PDF made without the browser when asked', async () => {
    const { app, root, control } = await renderExport();
    control.pdfResult = { ok: true, value: { kind: 'heavy', bytes: 1_400_000, pages: 12 } };
    click(button(root, TEXT.export));
    await settle();
    flushSync();
    click(button(root, TEXT.exportLighter));
    await settle();
    flushSync();
    expect(control.calls.filter((call) => call.endsWith('Pdf'))).toEqual([
      'exportPdf',
      'exportLighterPdf',
    ]);
    expect(app.notices.map((notice) => notice.text)).toEqual(['Exported to Thesis.pdf.']);
    expect(app.pdfExport).toBeNull();
  });

  it('writes a smaller heavy PDF in kilobytes, and forgets it once a setting changes', async () => {
    const { root, control } = await renderExport();
    control.pdfResult = { ok: true, value: { kind: 'heavy', bytes: 600_000, pages: 1 } };
    click(button(root, TEXT.export));
    await settle();
    flushSync();
    expect(single(root, '[role="alert"]').textContent.trim()).toBe(
      'This PDF weighs about 600 kB for 1 page, more than expected. Tasklace can write a lighter one directly, with the same pages.',
    );
    pick(choice(root, TEXT.a3));
    expect(root.querySelector('[role="alert"]')).toBeNull();
    expect(button(root, TEXT.export).disabled).toBe(false);
  });

  it('says the PDF is being made, its buttons waiting, until the main process answers', async () => {
    const { root, context } = await renderExport();
    let answer: (value: BridgeResult<PdfExport>) => void = () => undefined;
    Object.assign(context.bridge, {
      exportPdf: () =>
        new Promise<BridgeResult<PdfExport>>((resolve) => {
          answer = resolve;
        }),
    });
    click(button(root, TEXT.export));
    flushSync();
    expect(single(root, '[role="status"]').textContent).toBe(TEXT.making);
    expect(button(root, TEXT.export).disabled).toBe(true);
    answer({ ok: false, error: { code: 'CANCELLED' } });
    await settle();
    flushSync();
    expect(root.querySelector('[role="status"]')).toBeNull();
  });

  it('moves the last day printed', async () => {
    const { root } = await renderExport();
    pick(choice(root, TEXT.days));
    const last = single(root, `input[aria-label="${TEXT.lastDay}"]`) as HTMLInputElement;
    last.value = '2026-10-02';
    last.dispatchEvent(new Event('change', { bubbles: true }));
    flushSync();
    expect(
      (JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null') as PrintSettings).period,
    ).toEqual({ kind: 'days', firstDay: 20_724, lastDay: 20_728 });
  });

  it('says the preview cannot be drawn when only its canvas refuses to draw', async () => {
    const { root } = await renderExport();
    refuseDrawingContexts();
    pick(choice(root, TEXT.a3));
    expect(single(root, '[role="status"]').textContent).toBe(TEXT.previewUnavailable);
  });

  it('offers the float columns only with the critical path on, and says so', async () => {
    const plain = await renderExport();
    expect(() => choice(plain.root, TEXT.floats)).toThrow(`No choice ${TEXT.floats}`);
    expect(single(plain.root, 'fieldset:last-child small').textContent).toBe(TEXT.floatsHint);
    const critical = await renderExport({
      ...PLAN,
      options: { ...PLAN.options, criticalPathEnabled: true },
    });
    expect(choice(critical.root, TEXT.floats).checked).toBe(false);
  });

  it('says why the plan cannot be printed: columns too wide for the paper', async () => {
    const long = { ...PLAN, tasks: PLAN.tasks.map((task) => ({ ...task, name: 'N'.repeat(400) })) };
    const { root } = await renderExport(long);
    pick(choice(root, TEXT.portrait));
    for (const label of [
      english.table.wbs,
      english.table.start,
      english.table.end,
      english.table.duration,
      TEXT.progress,
      english.table.predecessors,
    ]) {
      pick(choice(root, label));
    }
    expect(single(root, '[role="status"]').textContent).toBe(TEXT.refusals.NO_ROOM_FOR_TIMELINE);
  });

  it('waits while the dates of the plan are being worked out', async () => {
    const { app, root, scheduler } = await renderExport();
    scheduler.automatic = false;
    app.addTask();
    flushSync();
    expect(single(root, '[role="status"]').textContent).toBe(TEXT.waiting);
  });

  it('says the preview cannot be drawn when the page cannot draw on a canvas', async () => {
    refuseDrawingContexts();
    const { root } = await renderExport();
    expect(single(root, '[role="status"]').textContent).toBe(TEXT.previewUnavailable);
  });

  it('says the preview cannot be drawn when the printed font cannot be loaded, and writes why in the log', async () => {
    const failure = new Error('Font refused');
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { load: () => Promise.reject(failure) },
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { root } = await renderExport();
    expect(single(root, '[role="status"]').textContent).toBe(TEXT.previewUnavailable);
    expect(logged.mock.calls).toEqual([['The printed font could not be loaded:', failure]]);
  });

  it('closes with the close button and with Escape, keeping no content once closed, and ignores the shortcuts of the plan while open', async () => {
    const { app, root, dialog } = await renderExport();
    const tasks = app.project?.tasks.length;
    press(dialog, 'Insert');
    expect(app.project?.tasks.length).toBe(tasks);
    click(button(root, TEXT.close));
    expect([dialog.open, app.pdfExport]).toEqual([false, null]);
    expect(dialog.childElementCount).toBe(0);
    app.openPdfExport();
    flushSync();
    dialog.dispatchEvent(new Event('cancel'));
    flushSync();
    expect(app.pdfExport).toBeNull();
  });

  it('closes when another project is opened', async () => {
    const { app, control } = await renderExport();
    control.openResult = openedProjectOf({ ...PLAN, name: 'Other' });
    await app.open();
    await settle();
    expect(app.pdfExport).toBeNull();
  });
});
