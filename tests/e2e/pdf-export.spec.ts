import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { encodeTasklaceFile } from '../../src/core/file/tasklace-file';
import type { Project } from '../../src/core/model/project';
import { createSharedDocument } from '../../src/core/shared/shared-document';
import { at } from '../../src/core/testing/civil-time';
import {
  link,
  milestone,
  project,
  splitTask,
  summary,
  workTask,
} from '../../src/core/testing/project-builder';
import { zlibCompressor } from '../../src/main/zlib-compressor';
import { buildPdfSample } from '../fixtures/pdf-samples';
import { closeDiscarding, launchApplication } from './application';
import { answerDialogs } from './dialogs';
import { readPdfTexts } from './pdf-texts';

const SCREENSHOT_FOLDER = process.env['TASKLACE_SCREENSHOTS'];
const HEAVY_PDF_TIMEOUT_MS = 120_000;
const A3_PORTRAIT = [841.89, 1190.55] as const;
/** Chromium rounds the height of a page by up to 0.55 point, a fifth of a millimetre, whatever the way its size is given. */
const PAGE_SIZE_TOLERANCE = 1;
const DESIGN = { id: 'design', name: 'Design', color: '#2a78d6', representsPersonOrTeam: false };
const DOCUMENTATION = {
  id: 'documentation',
  name: 'Documentation',
  color: '#2a78d7',
  representsPersonOrTeam: false,
};
const PLAN: Project = {
  ...project(
    [
      summary('research', { sortKey: 'a', name: 'Research' }),
      workTask('survey', {
        parentId: 'research',
        sortKey: 'a',
        name: 'Survey design',
        tagId: 'design',
        progressPercent: 60,
      }),
      splitTask(
        'interviews',
        [
          [14, 0],
          [9, 2],
        ],
        { parentId: 'research', sortKey: 'b', name: 'Interviews', tagId: 'documentation' },
      ),
      workTask('writing', {
        sortKey: 'b',
        name: 'Writing',
        segments: [{ durationHours: 36, gapDaysBefore: 0, startNoEarlierThan: null }],
      }),
      milestone('defense', { sortKey: 'c', name: 'Defense' }),
    ],
    [link('survey', 'interviews'), link('interviews', 'writing'), link('writing', 'defense')],
    { tags: [DESIGN, DOCUMENTATION], startDate: at(2026, 9, 28, 8) },
  ),
  name: 'Thesis',
  options: {
    criticalPathEnabled: true,
    dateConstraintsEnabled: false,
    baselineEnabled: false,
    alwaysShowPatterns: false,
  },
};

let folder: string;
let userData: string;
let application: ElectronApplication;
let page: Page;

test.beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'tasklace-e2e-pdf-'));
  userData = await mkdtemp(join(tmpdir(), 'tasklace-e2e-data-'));
  application = await launchApplication(userData);
  page = await application.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator('#app')).toHaveAttribute('data-started', 'true');
  const path = join(folder, 'Thesis.tasklace');
  await writeFile(
    path,
    encodeTasklaceFile(createSharedDocument(PLAN, crypto.randomUUID()), zlibCompressor),
  );
  await answerDialogs(application, { open: path });
  await page.getByRole('button', { name: /Open…/ }).click();
  await expect(page.getByRole('textbox', { name: 'Project name' })).toHaveValue('Thesis');
});

test.afterEach(async () => {
  await closeDiscarding(application, page);
  await rm(folder, { recursive: true, force: true });
  await rm(userData, { recursive: true, force: true });
});

/** Opens the export to PDF from the Export menu and returns its window. */
async function openExport() {
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByRole('menuitem', { name: 'PDF…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Export to PDF' });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Counts the pixels of the preview that are not white paper. */
async function inkedPixels(): Promise<number> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('dialog.export canvas');
    if (canvas === null) {
      return -1;
    }
    const context = canvas.getContext('2d');
    if (context === null) {
      return -1;
    }
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let count = 0;
    for (let index = 0; index < data.length; index += 4) {
      if (
        (data[index] ?? 0) < 250 ||
        (data[index + 1] ?? 0) < 250 ||
        (data[index + 2] ?? 0) < 250
      ) {
        count += 1;
      }
    }
    return count;
  });
}

test('previews the first printed page of the plan and remembers the settings for the project', async () => {
  const dialog = await openExport();
  await expect(dialog.getByText('Preview · page 1 of 1')).toBeVisible();
  await expect(dialog.getByRole('radio', { name: 'A4' })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: 'Floats' })).not.toBeChecked();
  await expect.poll(inkedPixels).toBeGreaterThan(1_000);
  if (SCREENSHOT_FOLDER !== undefined) {
    await page.screenshot({ path: join(SCREENSHOT_FOLDER, 'pdf-export.png') });
  }

  await dialog.getByText('A3', { exact: true }).click();
  await dialog.getByText('Month', { exact: true }).click();
  await dialog.getByRole('checkbox', { name: 'Floats' }).check();
  await expect(dialog.getByText('Preview · page 1 of 1')).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();

  const reopened = await openExport();
  await expect(reopened.getByRole('radio', { name: 'A3' })).toBeChecked();
  await expect(reopened.getByRole('radio', { name: 'Month' })).toBeChecked();
  await expect(reopened.getByRole('checkbox', { name: 'Floats' })).toBeChecked();
  await page.keyboard.press('Escape');
  await expect(reopened).toBeHidden();
});

/** Counts the pages of a PDF from the page objects it declares. */
function pageCount(pdf: Buffer): number {
  return (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
}

test('writes the plan as a PDF of vector pages with the Jost typeface embedded, its title and texts reading back', async () => {
  const path = join(folder, 'Thesis.pdf');
  const dialog = await openExport();
  await answerDialogs(application, { save: path });
  await dialog.getByRole('button', { name: 'Export PDF…' }).click();
  await expect(page.getByText('Exported to Thesis.pdf.')).toBeVisible();
  await expect(dialog).toBeHidden();
  const pdf = await readFile(path);
  expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  expect(pageCount(pdf)).toBe(1);
  expect(pdf.toString('latin1')).toMatch(/\/BaseFont\s*\/[A-Z]{6}\+Jost/);
  const { title, texts } = readPdfTexts(pdf);
  const [heading, exported, ...rest] = texts;
  expect([title, heading]).toEqual(['Thesis', 'Thesis']);
  expect(exported).toMatch(/^Exported \S/);
  expect(rest).toEqual([
    'September 2026',
    'October 2026',
    ...['28', '29', '30'],
    ...Array.from({ length: 12 }, (_unused, day) => String(day + 1)),
    'Name',
    'Research',
    'Survey design',
    'Interviews',
    'Writing',
    'Defense',
    'Design',
    'Documentation',
    'Critical',
    'Page 1 of 1',
  ]);
});

test('prints a long plan on as many PDF pages as the preview announces, with no blank page', async () => {
  const path = join(folder, 'Long.pdf');
  const long = {
    ...project(
      Array.from({ length: 60 }, (_unused, index) =>
        workTask(`t${String(index)}`, {
          name: `Task ${String(index + 1)}`,
          sortKey: `k${String(index).padStart(3, '0')}`,
        }),
      ),
    ),
    name: 'Long plan',
  };
  const source = join(folder, 'Long plan.tasklace');
  await writeFile(
    source,
    encodeTasklaceFile(createSharedDocument(long, crypto.randomUUID()), zlibCompressor),
  );
  await answerDialogs(application, { open: source });
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Open a file…' }).click();
  await expect(page.getByRole('textbox', { name: 'Project name' })).toHaveValue('Long plan');
  const dialog = await openExport();
  await expect(dialog.getByText('Preview · page 1 of 3')).toBeVisible();
  await answerDialogs(application, { save: path });
  await dialog.getByRole('button', { name: 'Export PDF…' }).click();
  await expect(page.getByText('Exported to Long.pdf.')).toBeVisible();
  expect(pageCount(await readFile(path))).toBe(3);
});

test('writes a heavy PDF again without the browser in the file worker, with the same pages and Jost embedded', async () => {
  test.setTimeout(HEAVY_PDF_TIMEOUT_MS);
  const path = join(folder, 'Lighter.pdf');
  await answerDialogs(application, { save: path });
  const answers = await page.evaluate(async () => {
    const bridge = window.tasklace;
    if (bridge === undefined) {
      return null;
    }
    const orders = Array.from({ length: 200_000 }, (_unused, index) => ({
      kind: 'fill' as const,
      shape: {
        kind: 'rect' as const,
        x: (index % 400) * 2,
        y: (Math.floor(index / 400) % 250) * 2,
        width: 1.5,
        height: 1.5,
      },
      color: `#${((index * 2_654_435) % 16_777_216).toString(16).padStart(6, '0')}`,
      opacity: 1,
    }));
    const text = {
      kind: 'text' as const,
      x: 28,
      y: 580,
      text: 'Heavy plan',
      size: 10,
      weight: 400 as const,
      color: '#1c1b19',
      align: 'start' as const,
    };
    const heavy = await bridge.exportPdf(
      {
        paper: 'a4',
        orientation: 'landscape',
        title: 'Heavy plan',
        pages: [[...orders, text], [text]],
      },
      'Heavy plan',
    );
    const lighter = await bridge.exportLighterPdf();
    return { heavy, lighter };
  });
  expect(answers?.heavy).toMatchObject({ ok: true, value: { kind: 'heavy', pages: 2 } });
  expect(answers?.lighter).toEqual({ ok: true, value: { fileName: 'Lighter.pdf' } });
  const pdf = await readFile(path);
  expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  expect(pageCount(pdf)).toBe(2);
  expect(pdf.toString('latin1')).toMatch(/\/BaseFont\s*\/[A-Z]{6}\+Jost-Book/);
  const heavyBytes =
    answers?.heavy.ok === true && answers.heavy.value.kind === 'heavy'
      ? answers.heavy.value.bytes
      : 0;
  expect(pdf.length).toBeLessThan(heavyBytes);
});

/** Lists the page sizes of a PDF in points, rounded to a tenth, from the media boxes it declares. */
function pageSizes(pdf: Buffer): number[][] {
  return [
    ...pdf.toString('latin1').matchAll(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/g),
  ].map(([, width = '0', height = '0']) => [
    Math.round(Number(width) * 10) / 10,
    Math.round(Number(height) * 10) / 10,
  ]);
}

test('prints a chosen period at a chosen zoom on portrait A3 pages, as many as the preview announces', async () => {
  const plan = buildPdfSample('medium');
  const source = join(folder, `${plan.name}.tasklace`);
  await writeFile(
    source,
    encodeTasklaceFile(createSharedDocument(plan, crypto.randomUUID()), zlibCompressor),
  );
  await answerDialogs(application, { open: source });
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Open a file…' }).click();
  await expect(page.getByRole('textbox', { name: 'Project name' })).toHaveValue(plan.name);
  const dialog = await openExport();
  await dialog.getByText('A3', { exact: true }).click();
  await dialog.getByText('Portrait', { exact: true }).click();
  await dialog.getByText('Week', { exact: true }).click();
  await dialog.getByText('From – to', { exact: true }).click();
  const last = dialog.getByLabel('Last day printed');
  await last.fill('2026-11-27');
  await last.dispatchEvent('change');
  const caption = dialog.getByText(/^Preview · page 1 of \d+$/);
  await expect(caption).toBeVisible();
  const announced = Number(/of (\d+)$/.exec((await caption.textContent()) ?? '')?.[1]);
  const path = join(folder, 'Medium.pdf');
  await answerDialogs(application, { save: path });
  await dialog.getByRole('button', { name: 'Export PDF…' }).click();
  await expect(page.getByText('Exported to Medium.pdf.')).toBeVisible({ timeout: 60_000 });
  const pdf = await readFile(path);
  expect(pageCount(pdf)).toBe(announced);
  const sizes = pageSizes(pdf);
  expect(sizes).toHaveLength(announced);
  for (const [width = 0, height = 0] of sizes) {
    expect(Math.abs(width - A3_PORTRAIT[0])).toBeLessThanOrEqual(PAGE_SIZE_TOLERANCE);
    expect(Math.abs(height - A3_PORTRAIT[1])).toBeLessThanOrEqual(PAGE_SIZE_TOLERANCE);
  }
});
