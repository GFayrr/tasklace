import { flushSync } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../core/model/project';
import type { AppContext } from '../app/app-state.svelte';
import { at } from '../../core/testing/civil-time';
import { link, project, workTask, testId } from '../../core/testing/project-builder';
import {
  OPENED_DOCUMENT_ID,
  openedAppOf,
  openedProjectOf,
  settle,
} from '../app/testing/fake-app-context';
import english from '../locales/en.json';
import type { PrintSettings } from '../print/print-pages';
import type { BridgeResult, PdfExport } from '../../preload/bridge-contract';
import { SAND_GRAPHITE } from '../theme/sand-graphite';
import type { Theme } from '../theme/theme';
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
    value: { load: () => Promise.resolve([{ status: 'loaded' }]) },
  });
});

afterEach(() => {
  window.localStorage.clear();
  limits.orders = null;
});

const limits = vi.hoisted(() => ({ orders: null as number | null }));

vi.mock('../../core/limits', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../core/limits')>();
  return {
    ...original,
    get MAX_PRINT_ORDERS() {
      return limits.orders ?? original.MAX_PRINT_ORDERS;
    },
  };
});

/** Opens the sample plan, renders the application and opens the export to PDF from the Export menu, waiting for the printed font. */
async function renderExport(plan: Project = PLAN, overrides: Partial<AppContext> = {}) {
  const opened = await openedAppOf(plan, overrides);
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

/** Builds a plan of a given number of unlinked tasks, one per row, named Thesis. */
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
    expect(drawn.filter((call) => call.name === 'fillText').map((call) => call.args[0])).toEqual([
      'Thesis',
      'Exported Sep 28, 2026',
      'September 2026',
      '28',
      '29',
      'Name',
      'Survey',
      'Writing',
      'Page 1 of 1',
    ]);
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
    expect(
      (JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null') as PrintSettings).period,
    ).toEqual({ kind: 'days', firstDay: 20_731, lastDay: 20_725 });
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
    /** Tells whether each group of settings can be changed. */
    const groupsDisabled = () =>
      [...root.querySelectorAll('fieldset')].map((group) => group.disabled);
    expect(groupsDisabled()).toEqual([false, false, false, false]);
    click(button(root, TEXT.export));
    flushSync();
    expect(single(root, '[role="status"]').textContent).toBe(TEXT.making);
    expect(button(root, TEXT.export).disabled).toBe(true);
    expect(groupsDisabled()).toEqual([true, true, true, true]);
    answer({ ok: false, error: { code: 'CANCELLED' } });
    await settle();
    flushSync();
    expect(root.querySelector('[role="status"]')).toBeNull();
    expect(groupsDisabled()).toEqual([false, false, false, false]);
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

  it('says the preview cannot be drawn when only its canvas refuses to draw, the export staying possible', async () => {
    const { root, control } = await renderExport();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    refuseDrawingContexts();
    pick(choice(root, TEXT.a3));
    expect(single(root, '[role="status"]').textContent).toBe(TEXT.previewUnavailable);
    expect(logged.mock.calls).toEqual([
      ['The preview could not be drawn: the canvas gave no drawing context.'],
    ]);
    click(button(root, TEXT.export));
    await settle();
    expect(control.pdfExports).toHaveLength(1);
  });

  it('refuses a date outside the years handled or none, putting back the day chosen and saying why until a day is chosen again', async () => {
    const { root } = await renderExport();
    pick(choice(root, TEXT.days));
    const first = single(root, `input[aria-label="${TEXT.firstDay}"]`) as HTMLInputElement;
    const last = single(root, `input[aria-label="${TEXT.lastDay}"]`) as HTMLInputElement;
    expect([first.min, first.max, last.min, last.max]).toEqual([
      '2020-01-01',
      '2200-12-31',
      '2020-01-01',
      '2200-12-31',
    ]);
    const shown = [first.value, last.value];
    first.value = '2019-12-31';
    first.dispatchEvent(new Event('change', { bubbles: true }));
    last.value = '';
    last.dispatchEvent(new Event('change', { bubbles: true }));
    flushSync();
    expect([first.value, last.value]).toEqual(shown);
    expect(
      (JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null') as PrintSettings).period,
    ).toEqual({ kind: 'days', firstDay: 20_724, lastDay: 20_725 });
    expect(single(root, '.days + [role="alert"]').textContent).toBe(TEXT.dayOutOfYears);
    first.value = '2026-09-29';
    first.dispatchEvent(new Event('change', { bubbles: true }));
    flushSync();
    expect(root.querySelectorAll('.days + [role="alert"]')).toHaveLength(0);
  });

  it('prints with the settings chosen when the local storage is refused, warning that they will not be remembered', async () => {
    const refusal = new DOMException('Storage is disabled.', 'SecurityError');
    const storage = vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw refusal;
    });
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { root, control } = await renderExport();
      pick(choice(root, TEXT.a3));
      click(button(root, TEXT.export));
      await settle();
      expect(control.pdfExports.map((exported) => exported.document.paper)).toEqual(['a3']);
      expect(warned.mock.calls).toEqual([
        ['The width of the table will not be remembered:', refusal],
        ['The print settings will not be remembered:', refusal],
      ]);
    } finally {
      storage.mockRestore();
      warned.mockRestore();
    }
  });

  it('draws the patterns of close tags in the preview, reporting once that this computer cannot draw them', async () => {
    const tags = [
      { id: testId('design'), name: 'Design', color: '#2A78D6', representsPersonOrTeam: false },
      { id: testId('near'), name: 'Near', color: '#2A78D7', representsPersonOrTeam: false },
    ];
    const tagged = project(
      [
        workTask('a', { name: 'Survey', sortKey: 'a', tagId: testId('design') }),
        workTask('b', { name: 'Writing', sortKey: 'b', tagId: testId('near') }),
      ],
      [],
      { name: 'Thesis', startDate: at(2026, 9, 28, 9), tags },
    );
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { app, root } = await renderExport(tagged);
      pick(choice(root, TEXT.a3));
      expect(logged.mock.calls).toEqual([
        ['The patterns could not be drawn: the canvas gave no drawing context or pattern.'],
      ]);
      expect(app.notices.map((notice) => notice.text)).toEqual([
        english.notices.drawingUnavailable.patterns,
      ]);
    } finally {
      logged.mockRestore();
    }
  });

  it('says the plan cannot be printed while its dates cannot be worked out', async () => {
    const late = project(
      [
        workTask('a', {
          name: 'Survey',
          startNoEarlierThan: at(2200, 12, 31, 9),
          segments: [{ durationHours: 70, gapDaysBefore: 0, startNoEarlierThan: null }],
        }),
      ],
      [],
      { name: 'Thesis', startDate: at(2026, 9, 28, 9) },
    );
    const { root } = await renderExport(late);
    expect(single(root, '[role="status"]').textContent).toBe(TEXT.scheduleFailed);
    expect(button(root, TEXT.export).disabled).toBe(true);
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

  it('says the plan cannot be printed when the page cannot measure texts on a canvas, and writes why in the log', async () => {
    refuseDrawingContexts();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { root } = await renderExport();
    expect(single(root, '[role="status"]').textContent).toBe(TEXT.measureUnavailable);
    expect(button(root, TEXT.export).disabled).toBe(true);
    expect(logged.mock.calls.slice(-1)).toEqual([
      ['Printed texts cannot be measured: the canvas gave no drawing context.'],
    ]);
  });

  it.each([
    ['cannot be loaded', () => Promise.reject(new Error('Font refused')), 'Font refused'],
    [
      'is declared in no weight',
      () => Promise.resolve([]),
      'The page declares no Jost Print font of weight 400, 500, 600.',
    ],
  ])(
    'says the plan cannot be printed when the printed font %s, and writes why in the log',
    async (_case, load, reason) => {
      Object.defineProperty(document, 'fonts', { configurable: true, value: { load } });
      const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const { root } = await renderExport();
      expect(single(root, '[role="status"]').textContent).toBe(TEXT.measureUnavailable);
      expect(button(root, TEXT.export).disabled).toBe(true);
      expect(logged.mock.calls).toEqual([
        ['The printed font could not be loaded:', new Error(reason)],
      ]);
    },
  );

  it('says the plan cannot be printed while its dates cannot be updated, rather than waiting for ever', async () => {
    const { app, root, scheduler } = await renderExport();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failure = new Error('Worker lost');
    scheduler.automatic = false;
    app.addTask();
    scheduler.listener().failed(failure);
    flushSync();
    expect(single(root, '[role="status"]').textContent).toBe(TEXT.scheduleStopped);
    expect(button(root, TEXT.export).disabled).toBe(true);
    expect(logged.mock.calls).toEqual([['The schedule could not be computed:', failure]]);
  });

  it('says the pages could not be drawn, writing why in the log, rather than leaving the window stuck', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const theme = Object.fromEntries(
      Object.keys(SAND_GRAPHITE).map((key) => [key, 'hsl(0 0% 50%)']),
    ) as unknown as Theme;
    const { root } = await renderExport(PLAN, { theme });
    expect(single(root, '[role="status"]').textContent).toBe(TEXT.notDrawn);
    expect(button(root, TEXT.export).disabled).toBe(true);
    expect(logged.mock.calls.at(-1)?.[0]).toBe('The printed pages could not be drawn:');
    expect(logged.mock.calls.at(-1)?.[1]).toEqual(
      new TypeError('Unknown color to print: hsl(0 0% 50%)'),
    );
  });

  it('explains pages refused only once all of them are drawn, sending nothing, until a setting changes', async () => {
    const { root, control } = await renderExport(longPlan(40));
    limits.orders = 1;
    click(button(root, TEXT.export));
    await settle();
    flushSync();
    expect(control.pdfExports).toEqual([]);
    expect(single(root, '[role="status"]').textContent).toBe(TEXT.refusals.TOO_DETAILED);
    limits.orders = null;
    pick(choice(root, TEXT.a3));
    expect(root.querySelector('[role="status"]')).toBeNull();
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
