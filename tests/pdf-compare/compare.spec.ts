import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { compileCalendar } from '../../src/core/calendar/compile-calendar';
import { encodeTasklaceFile } from '../../src/core/file/tasklace-file';
import type { Project } from '../../src/core/model/project';
import type { PrintDocument } from '../../src/core/print/print-document';
import { createSharedDocument } from '../../src/core/shared/shared-document';
import { checkedOrThrow } from '../../src/core/testing/print-arbitrary';
import { scheduleOrThrow } from '../../src/core/testing/project-builder';
import { writeDirectPdf } from '../../src/main/pdf/direct-pdf';
import { zlibCompressor } from '../../src/main/zlib-compressor';
import type { BridgeResult, PdfExport } from '../../src/preload/bridge-contract';
import messages from '../../src/renderer/locales/en.json' with { type: 'json' };
import { buildPrintDocument, type PrintSettings } from '../../src/renderer/print/print-pages';
import type { MeasureText } from '../../src/renderer/print/print-text';
import { SAND_GRAPHITE } from '../../src/renderer/theme/sand-graphite';
import { closeDiscarding, launchApplication } from '../e2e/application';
import { answerDialogs } from '../e2e/dialogs';
import { buildPdfSample, PDF_SAMPLE_SIZES, type PdfSampleSize } from '../fixtures/pdf-samples';

interface Row {
  readonly sample: string;
  readonly settings: string;
  readonly pages: number;
  readonly chromiumBytes: number;
  readonly heavy: boolean;
  readonly directBytes: number | null;
}

const OUTPUT_FOLDER = join(import.meta.dirname, '../../pdf-compare');
const FONT_FOLDER = join(import.meta.dirname, '../../out/renderer/fonts');
const FONTS = {
  400: join(FONT_FOLDER, 'jost-print-400.ttf'),
  500: join(FONT_FOLDER, 'jost-print-500.ttf'),
  600: join(FONT_FOLDER, 'jost-print-600.ttf'),
} as const;
const AVERAGE_CHARACTER_EM = 0.5;
const KILOBYTE = 1_024;
const PERCENT = 100;
const COMPARED_SETTINGS: readonly { readonly label: string; readonly settings: PrintSettings }[] = [
  {
    label: 'A4 landscape, automatic zoom',
    settings: {
      paper: 'a4',
      orientation: 'landscape',
      period: { kind: 'whole' },
      zoom: 'automatic',
      columns: [],
    },
  },
  {
    label: 'A3 landscape, automatic zoom',
    settings: {
      paper: 'a3',
      orientation: 'landscape',
      period: { kind: 'whole' },
      zoom: 'automatic',
      columns: [],
    },
  },
  {
    label: 'A4 landscape, week zoom, WBS and dates',
    settings: {
      paper: 'a4',
      orientation: 'landscape',
      period: { kind: 'whole' },
      zoom: 'week',
      columns: ['wbs', 'start', 'end'],
    },
  },
  {
    label: 'A4 portrait, day zoom',
    settings: {
      paper: 'a4',
      orientation: 'portrait',
      period: { kind: 'whole' },
      zoom: 'day',
      columns: [],
    },
  },
];

let application: ElectronApplication;
let page: Page;

/** Measures a text from an average width of its characters, close enough to Jost to compare the two engines on the same pages. */
const measure: MeasureText = (text, size) => Array.from(text).length * size * AVERAGE_CHARACTER_EM;

test.beforeAll(async () => {
  await rm(OUTPUT_FOLDER, { recursive: true, force: true });
  await mkdir(OUTPUT_FOLDER, { recursive: true });
  application = await launchApplication(await mkdtemp(join(tmpdir(), 'tasklace-pdf-compare-')));
  page = await application.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator('#app')).toHaveAttribute('data-started', 'true');
});

test.afterAll(async () => {
  await closeDiscarding(application, page);
});

/** Builds the pages of a sample plan with some settings, as the export window does. */
function documentOf(plan: Project, settings: PrintSettings): PrintDocument {
  const calendar = compileCalendar(plan.calendar);
  if (!calendar.ok) {
    throw new Error('The sample calendar does not compile.');
  }
  const built = buildPrintDocument(
    {
      project: plan,
      schedule: scheduleOrThrow(plan),
      calendar: calendar.value,
      theme: SAND_GRAPHITE,
      messages,
      locale: 'en-US',
      exportedAt: new Date(Date.UTC(2026, 9, 13)),
    },
    settings,
    measure,
  );
  if (!built.ok) {
    throw new Error(`The sample could not be printed: ${built.error}`);
  }
  return built.value.document;
}

/** Prints a document with Chromium through the bridge of the application and writes it, as it is when it is heavy, telling its size and whether the guard kept it back. */
async function printWithChromium(
  document: PrintDocument,
  path: string,
): Promise<{ readonly heavy: boolean }> {
  await answerDialogs(application, { save: path });
  const answer: BridgeResult<PdfExport> | undefined = await page.evaluate(
    (sent) => window.tasklace?.exportPdf(sent, 'Sample'),
    document,
  );
  if (answer?.ok !== true) {
    throw new Error(`Chromium could not print the sample: ${JSON.stringify(answer)}`);
  }
  if (answer.value.kind === 'exported') {
    return { heavy: false };
  }
  const kept = await page.evaluate(() => window.tasklace?.saveHeldPdf());
  if (kept?.ok !== true) {
    throw new Error(`The heavy PDF could not be written: ${JSON.stringify(kept)}`);
  }
  return { heavy: true };
}

/** Opens a sample plan in the application and exports it through the export window with its default settings, returning the size of the PDF. */
async function exportThroughWindow(plan: Project, size: PdfSampleSize): Promise<number> {
  const folder = await mkdtemp(join(tmpdir(), 'tasklace-pdf-sample-'));
  const source = join(folder, `${plan.name}.tasklace`);
  await writeFile(
    source,
    encodeTasklaceFile(createSharedDocument(plan, crypto.randomUUID()), zlibCompressor),
  );
  await answerDialogs(application, { open: source });
  const welcome = page.getByRole('button', { name: /Open…/ });
  if (await welcome.isVisible()) {
    await welcome.click();
  } else {
    await page.getByRole('button', { name: 'Open', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Open a file…' }).click();
  }
  await expect(page.getByRole('textbox', { name: 'Project name' })).toHaveValue(plan.name);
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByRole('menuitem', { name: 'PDF…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Export to PDF' });
  const file = `${size} - window.pdf`;
  await answerDialogs(application, { save: join(OUTPUT_FOLDER, file) });
  await dialog.getByRole('button', { name: 'Export PDF…' }).click();
  const asItIs = dialog.getByRole('button', { name: 'Export as it is…' });
  await expect(page.getByText(`Exported to ${file}.`).or(asItIs)).toBeVisible({ timeout: 120_000 });
  if (await asItIs.isVisible()) {
    await asItIs.click();
    await expect(page.getByText(`Exported to ${file}.`)).toBeVisible();
  }
  return (await stat(join(OUTPUT_FOLDER, file))).size;
}

/** Writes the table of the comparison as Markdown. */
function summaryOf(rows: readonly Row[], window: readonly (readonly [string, number])[]): string {
  const lines = [
    '# PDF export comparison',
    '',
    'Same pages printed by Chromium (main engine) and by PDFKit (the lighter PDF).',
    '',
    '| Sample | Settings | Pages | Chromium | Per page | Guard | PDFKit | Gain |',
    '| --- | --- | ---: | ---: | ---: | --- | ---: | ---: |',
    ...rows.map((row) => {
      const gain =
        row.directBytes === null
          ? ''
          : `${String(Math.round((1 - row.directBytes / row.chromiumBytes) * PERCENT))} %`;
      return `| ${row.sample} | ${row.settings} | ${String(row.pages)} | ${kilobytes(row.chromiumBytes)} | ${kilobytes(row.chromiumBytes / row.pages)} | ${row.heavy ? 'kept back' : 'written'} | ${row.directBytes === null ? '' : kilobytes(row.directBytes)} | ${gain} |`;
    }),
    '',
    'Exported through the export window with its default settings:',
    '',
    ...window.map(([sample, bytes]) => `- ${sample}: ${kilobytes(bytes)}`),
    '',
  ];
  return lines.join('\n');
}

/** Writes a number of bytes in kilobytes. */
function kilobytes(bytes: number): string {
  return `${(bytes / KILOBYTE).toFixed(1)} KB`;
}

test('prints the three sample plans with both engines and writes the comparison', async () => {
  const rows: Row[] = [];
  const window: [string, number][] = [];
  for (const size of PDF_SAMPLE_SIZES) {
    const plan = buildPdfSample(size);
    window.push([plan.name, await exportThroughWindow(plan, size)]);
    for (const [index, compared] of COMPARED_SETTINGS.entries()) {
      const document = checkedOrThrow(documentOf(plan, compared.settings));
      const chromiumPath = join(OUTPUT_FOLDER, `${size} - ${String(index + 1)} - chromium.pdf`);
      const directPath = join(OUTPUT_FOLDER, `${size} - ${String(index + 1)} - pdfkit.pdf`);
      const { heavy } = await printWithChromium(document, chromiumPath);
      await writeFile(directPath, await writeDirectPdf(document, FONTS));
      rows.push({
        sample: plan.name,
        settings: compared.label,
        pages: document.pages.length,
        chromiumBytes: (await readFile(chromiumPath)).length,
        heavy,
        directBytes: (await stat(directPath)).size,
      });
    }
  }
  const summary = summaryOf(rows, window);
  await writeFile(join(OUTPUT_FOLDER, 'summary.md'), summary);
  console.info(summary);
});
