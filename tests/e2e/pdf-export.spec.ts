import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
import { closeDiscarding, launchApplication } from './application';
import { answerDialogs } from './dialogs';

const SCREENSHOT_FOLDER = process.env['TASKLACE_SCREENSHOTS'];
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
