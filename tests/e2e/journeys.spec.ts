import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { exportProjectCsv } from '../../src/core/exchange/csv/project-csv-export';
import { encodeTasklaceFile, readTasklaceFile } from '../../src/core/file/tasklace-file';
import type { Project } from '../../src/core/model/project';
import { createSharedDocument } from '../../src/core/shared/shared-document';
import { readSharedProject } from '../../src/core/shared/shared-project';
import { unwrap } from '../../src/core/testing/arbitraries';
import { link, project, scheduleOrThrow, workTask } from '../../src/core/testing/project-builder';
import { zlibCompressor } from '../../src/main/zlib-compressor';
import { closeDiscarding, launchApplication } from './application';
import { answerDialogs } from './dialogs';
import { addTask, tableTexts, taskRow, typeInCell } from './table';

const DURATION_COLUMN = 2;
const START_COLUMN = 3;
const END_COLUMN = 4;
const PROGRESS_COLUMN = 5;
const PREDECESSORS_COLUMN = 6;
const MILESTONE_LABEL = 'Turn into a milestone, a key date with no duration, or back into a task';

let folder: string;
let userData: string;
let application: ElectronApplication;
let page: Page;

test.beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'tasklace-e2e-journeys-'));
  userData = await mkdtemp(join(tmpdir(), 'tasklace-e2e-data-'));
  await launch();
});

test.afterEach(async () => {
  await closeDiscarding(application, page);
  await rm(folder, { recursive: true, force: true });
  await rm(userData, { recursive: true, force: true });
});

/** Launches the application on the user data folder of the test and waits until its interface runs. */
async function launch(): Promise<void> {
  application = await launchApplication(userData);
  page = await application.firstWindow();
  await page.setViewportSize({ width: 1440, height: 800 });
  await expect(page.locator('#app')).toHaveAttribute('data-started', 'true');
}

/** Reads the project a .tasklace file holds, failing the test when it cannot be read. */
async function projectIn(path: string): Promise<Project> {
  const document = unwrap(readTasklaceFile(await readFile(path), zlibCompressor));
  return unwrap(readSharedProject(document));
}

/** Writes a small project named after its file, under its own document identifier. */
async function writeProject(name: string): Promise<string> {
  const path = join(folder, `${name}.tasklace`);
  const named = { ...project([workTask('a'), workTask('b')], [link('a', 'b')]), name };
  const document = createSharedDocument(named, crypto.randomUUID());
  await writeFile(path, encodeTasklaceFile(document, zlibCompressor));
  return path;
}

/** Saves the open project with Ctrl+S, through Save as when it has no file yet, and waits until it is saved. */
async function save(path: string): Promise<void> {
  await answerDialogs(application, { save: path });
  await page.keyboard.press('Control+s');
  await expect(page.getByText('All changes saved')).toBeVisible();
}

/** Opens a file from the Open menu of the toolbar. */
async function openFromMenu(path: string): Promise<void> {
  await answerDialogs(application, { open: path });
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Open a file…' }).click();
}

/** Returns the name of the open project. */
function projectName() {
  return page.getByRole('textbox', { name: 'Project name' });
}

test('keeps a whole project, milestone included, across a restart of the application', async () => {
  const path = join(folder, 'Thesis.tasklace');
  await page.getByRole('button', { name: /New project/ }).click();
  await projectName().fill('Thesis');
  await projectName().press('Enter');
  await addTask(page, 'Research');
  await addTask(page, 'Writing');
  await addTask(page, 'Defense');
  await typeInCell(page, 'Writing', DURATION_COLUMN, '2d');
  await typeInCell(page, 'Writing', PREDECESSORS_COLUMN, '1');
  await typeInCell(page, 'Defense', PREDECESSORS_COLUMN, '2');
  await typeInCell(page, 'Research', PROGRESS_COLUMN, '40');
  await taskRow(page, 'Defense').getByRole('gridcell').nth(1).click();
  await page.getByRole('button', { name: MILESTONE_LABEL }).click();
  await expect(taskRow(page, 'Defense').getByRole('gridcell').nth(DURATION_COLUMN)).toHaveText(
    '0 h',
  );
  await save(path);
  const shown = await tableTexts(page);
  const saved = await projectIn(path);
  expect(saved.name).toBe('Thesis');
  expect(
    [...saved.tasks]
      .sort((left, right) => (left.sortKey < right.sortKey ? -1 : 1))
      .map((task) => [task.name, task.kind, task.kind === 'summary' ? null : task.progressPercent]),
  ).toEqual([
    ['Research', 'task', 40],
    ['Writing', 'task', 0],
    ['Defense', 'milestone', 0],
  ]);
  expect(saved.dependencies).toHaveLength(2);

  await closeDiscarding(application, page);
  await launch();
  const recent = page.getByRole('region', { name: 'Recent projects' }).getByRole('button');
  await expect(recent).toHaveText([`Thesis ${folder}`]);
  await recent.click();
  await expect(projectName()).toHaveValue('Thesis');
  await expect(page.getByText('All changes saved')).toBeVisible();
  expect(await tableTexts(page)).toEqual(shown);
  expect(await projectIn(path)).toEqual(saved);
});

test('lists the recent projects latest first, opens one and explains a recent file that is gone', async () => {
  const [alpha, beta, gamma] = await Promise.all(
    ['Alpha', 'Beta', 'Gamma'].map((name) => writeProject(name)),
  );
  if (alpha === undefined || beta === undefined || gamma === undefined) {
    throw new Error('Missing project files');
  }
  await answerDialogs(application, { open: alpha });
  await page.getByRole('button', { name: /Open…/ }).click();
  await expect(projectName()).toHaveValue('Alpha');
  await openFromMenu(beta);
  await expect(projectName()).toHaveValue('Beta');
  await openFromMenu(gamma);
  await expect(projectName()).toHaveValue('Gamma');

  const open = page.getByRole('button', { name: 'Open', exact: true });
  const items = page.getByRole('menuitem');
  await open.click();
  await expect(items).toHaveText(['Open a file…', /^Gamma/, /^Beta/, /^Alpha/]);
  await items.filter({ hasText: 'Alpha' }).click();
  await expect(projectName()).toHaveValue('Alpha');
  await open.click();
  await expect(items).toHaveText(['Open a file…', /^Alpha/, /^Gamma/, /^Beta/]);

  await rm(beta);
  await items.filter({ hasText: 'Beta' }).click();
  await expect(page.getByRole('alert')).toContainText(
    'This file could not be read. Check that it still exists and that you are allowed to open it.',
  );
  await expect(projectName()).toHaveValue('Alpha');
});

test('exports a CSV table through the menu and imports it back into the same plan', async () => {
  const path = join(folder, 'Plan.tasklace');
  const table = join(folder, 'Plan.csv');
  await page.getByRole('button', { name: /New project/ }).click();
  await addTask(page, 'Écrire');
  await addTask(page, 'Relire');
  await typeInCell(page, 'Écrire', DURATION_COLUMN, '14');
  await typeInCell(page, 'Relire', PREDECESSORS_COLUMN, '1');
  await save(path);
  const shown = await tableTexts(page);

  await answerDialogs(application, { save: table });
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByRole('menuitem', { name: 'CSV table…' }).click();
  await expect(page.getByText('Exported to Plan.csv.')).toBeVisible();
  const format = await page.evaluate(() => window.tasklace?.regionalFormat());
  if (format === undefined) {
    throw new Error('Missing bridge');
  }
  const planned = await projectIn(path);
  const written = await readFile(table, 'utf8');
  expect(written.startsWith('﻿')).toBe(true);
  expect(written).toBe(unwrap(exportProjectCsv(planned, scheduleOrThrow(planned), format)));

  await answerDialogs(application, { open: table });
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await page.getByRole('menuitem', { name: 'CSV table…' }).click();
  await expect(page.getByText('Imported Plan.csv: 2 tasks.')).toBeVisible();
  await expect(page.getByText('Kept on this computer only')).toBeVisible();
  expect(await tableTexts(page)).toEqual(shown);
});

test('moves the project start and adds a day off from the settings, then undoes both', async () => {
  await page.getByRole('button', { name: /New project/ }).click();
  await addTask(page, 'Work');
  await typeInCell(page, 'Work', DURATION_COLUMN, '18');
  /** Returns a cell of the row of the task Work. */
  const cell = (column: number) => taskRow(page, 'Work').getByRole('gridcell').nth(column);
  const before = [await cell(START_COLUMN).innerText(), await cell(END_COLUMN).innerText()];

  await page.getByRole('button', { name: 'Project settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Project settings' });
  const start = settings.getByLabel('Project start');
  await start.fill('2030-01-07T08:00');
  await start.press('Enter');
  await expect(settings.getByText('The new project start moved 1 task.')).toBeVisible();
  await settings.getByRole('tab', { name: 'Calendar' }).click();
  await settings.getByRole('button', { name: 'Add a day or a period off' }).click();
  const firstDay = settings.getByLabel('First day off of period 1');
  await firstDay.fill('2030-01-08');
  await firstDay.press('Enter');
  await settings.getByRole('button', { name: 'Done' }).click();
  await expect(cell(START_COLUMN)).toHaveText('2030-01-07 08:00');
  await expect(cell(END_COLUMN)).toHaveText('2030-01-09 17:00');

  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await expect(cell(END_COLUMN)).toHaveText('2030-01-08 17:00');
  await page.keyboard.press('Control+z');
  await expect(cell(START_COLUMN)).toHaveText(before[0] ?? '');
  await expect(cell(END_COLUMN)).toHaveText(before[1] ?? '');
});
