import { mkdtemp, readdir, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { DEFAULT_CALENDAR } from '../../src/core/calendar/default-calendar';
import { exportProjectCsv } from '../../src/core/exchange/csv/project-csv-export';
import { encodeTasklaceFile, readTasklaceFile } from '../../src/core/file/tasklace-file';
import { MAX_FILE_BYTES } from '../../src/core/limits';
import { createSharedDocument } from '../../src/core/shared/shared-document';
import { readSharedProject } from '../../src/core/shared/shared-project';
import { unwrap } from '../../src/core/testing/arbitraries';
import {
  link,
  project,
  scheduleOrThrow,
  TEST_DOCUMENT_ID,
  workTask,
} from '../../src/core/testing/project-builder';
import { readIndexText } from '../../src/main/local-copies';
import { zlibCompressor } from '../../src/main/zlib-compressor';
import { closeDiscarding, launchApplication } from './application';
import { answerDialogs, askedQuestion, suggestedPath } from './dialogs';

const SAMPLE = project([workTask('a', { name: 'Écrire' }), workTask('b')], [link('a', 'b')]);

let folder: string;
let userData: string;
let application: ElectronApplication;
let page: Page;

test.beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'tasklace-e2e-files-'));
  userData = await mkdtemp(join(tmpdir(), 'tasklace-e2e-data-'));
  application = await launchApplication(userData);
  page = await application.firstWindow();
  await page.waitForLoadState('domcontentloaded');
});

test.afterEach(async () => {
  await closeDiscarding(application, page);
  await rm(folder, { recursive: true, force: true });
  await rm(userData, { recursive: true, force: true });
});

/** Writes the sample project as a .tasklace file. */
async function writeSampleProject(path: string): Promise<Uint8Array> {
  const file = encodeTasklaceFile(createSharedDocument(SAMPLE, TEST_DOCUMENT_ID), zlibCompressor);
  await writeFile(path, file);
  return file;
}

test('opens a project, saves it back to its file and lists it as recent', async () => {
  const path = join(folder, 'Plan.tasklace');
  await writeSampleProject(path);
  await answerDialogs(application, { open: path });
  const outcome = await page.evaluate(async () => {
    const api = window.tasklace;
    const opened = await api?.openProject();
    if (opened?.ok !== true) {
      return { opened };
    }
    const before = await api?.recentProjects();
    const adopted = await api?.adoptProject(opened.value.documentId);
    const saved = await api?.saveProject(opened.value.state);
    return {
      fileName: opened.value.fileName,
      before,
      adopted,
      saved,
      recent: await api?.recentProjects(),
    };
  });
  expect(outcome).toEqual({
    fileName: 'Plan.tasklace',
    before: { ok: true, value: [] },
    adopted: { ok: true, value: null },
    saved: { ok: true, value: { localCopySaved: true } },
    recent: { ok: true, value: [{ name: 'Plan', folder }] },
  });
  const copies = await readdir(join(userData, 'local-copies'));
  expect(copies.sort()).toEqual([`${TEST_DOCUMENT_ID}.tasklace`, 'index.json']);
  expect(await readFile(join(userData, 'local-copies', `${TEST_DOCUMENT_ID}.tasklace`))).toEqual(
    await readFile(path),
  );
});

test('imports a CSV table into a project kept in its local copy until saved as a file', async () => {
  const csv = join(folder, 'Tasks.csv');
  const target = join(folder, 'Tasks.tasklace');
  const format = await page.evaluate(async () => window.tasklace?.regionalFormat());
  if (format === undefined) {
    throw new Error('Missing bridge');
  }
  const table = { ...SAMPLE, calendar: DEFAULT_CALENDAR };
  await writeFile(csv, unwrap(exportProjectCsv(table, scheduleOrThrow(table), format)));
  await answerDialogs(application, { open: csv, save: target });
  const outcome = await page.evaluate(async () => {
    const api = window.tasklace;
    const imported = await api?.importProject('csv');
    if (imported?.ok !== true) {
      return { imported };
    }
    await api?.adoptProject(imported.value.documentId);
    const kept = await api?.saveProject(imported.value.state);
    const savedAs = await api?.saveProjectAs(imported.value.state, 'Tasks');
    return { fileName: imported.value.fileName, warnings: imported.value.warnings, kept, savedAs };
  });
  expect(outcome).toEqual({
    fileName: 'Tasks.csv',
    warnings: [],
    kept: { ok: true, value: { localCopySaved: true } },
    savedAs: { ok: true, value: { localCopySaved: true } },
  });
  expect((await readFile(target)).subarray(0, 4).toString()).toBe('TSKL');
  const { index } = readIndexText(
    await readFile(join(userData, 'local-copies', 'index.json'), 'utf8'),
  );
  expect(Object.values(index)).toMatchObject([{ path: target }]);
});

test('refuses forged and oversized files without loading anything, and a canceled dialog', async () => {
  const forged = join(folder, 'forged.tasklace');
  const huge = join(folder, 'huge.tasklace');
  await writeFile(forged, 'not a project at all');
  await writeFile(huge, '');
  await truncate(huge, MAX_FILE_BYTES + 1);
  const open = async (path: string | null) => {
    await answerDialogs(application, { open: path });
    return page.evaluate(async () => window.tasklace?.openProject());
  };
  expect(await open(forged)).toEqual({ ok: false, error: { code: 'NOT_A_TASKLACE_FILE' } });
  expect(await open(huge)).toEqual({ ok: false, error: { code: 'TOO_LARGE' } });
  expect(await open(null)).toEqual({ ok: false, error: { code: 'CANCELLED' } });
});

test('refuses bridge messages whose content is not valid', async () => {
  const refusals = await page.evaluate(async () => {
    const api = window.tasklace;
    const attempt = (action: Promise<unknown> | undefined) =>
      Promise.resolve(action).then(
        () => 'accepted',
        () => 'refused',
      );
    const documentId = await api?.newProject();
    await api?.adoptProject(documentId ?? '');
    return Promise.all([
      attempt(api?.adoptProject('../escape')),
      attempt(api?.saveProject('not bytes')),
      attempt(api?.importProject('tasklace')),
      attempt(api?.openRecentProject(99)),
      attempt(api?.exportProject('pdf', 'x', 'Plan')),
      attempt(api?.exportProject('json', '{}', 'x'.repeat(10_000))),
      attempt(
        Reflect.apply(api?.saveProjectAs ?? (() => undefined), api, [new Uint8Array([1]), 42]),
      ),
    ]);
  });
  expect(refusals).toEqual(Array.from({ length: 7 }, () => 'refused'));
});

test('exports with the extension added and the project name suggested, asking before replacing what the extension leads to', async () => {
  const chosen = join(folder, 'out');
  const exportAs = async (replace: boolean) => {
    await answerDialogs(application, { save: chosen, replace });
    return page.evaluate(async () => {
      const api = window.tasklace;
      await api?.newProject();
      return api?.exportProject('json', '{}', 'Launch: plan');
    });
  };
  expect(await exportAs(false)).toEqual({ ok: true, value: { fileName: 'out.json' } });
  expect(await suggestedPath(application)).toBe('Launch  plan.json');
  expect(await readFile(`${chosen}.json`, 'utf8')).toBe('{}');
  await writeFile(`${chosen}.json`, 'kept');
  expect(await exportAs(false)).toEqual({ ok: false, error: { code: 'CANCELLED' } });
  expect(await askedQuestion(application)).toBe(
    'out.json already exists. Do you want to replace it?',
  );
  expect(await readFile(`${chosen}.json`, 'utf8')).toBe('kept');
  expect(await exportAs(true)).toEqual({ ok: true, value: { fileName: 'out.json' } });
  expect(await readFile(`${chosen}.json`, 'utf8')).toBe('{}');
});

test('tells what was exported and imported, naming an untitled imported project after its file', async () => {
  const exported = join(folder, 'Shared plan');
  await page.getByRole('button', { name: 'New project' }).first().click();
  await page.getByRole('button', { name: 'Add task' }).click();
  await page.keyboard.press('Enter');
  await answerDialogs(application, { save: exported });
  await page.getByRole('button', { name: 'Export' }).click();
  await page.getByRole('menuitem', { name: 'JSON file…' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Exported to Shared plan.json.' }),
  ).toBeVisible();
  await answerDialogs(application, { open: `${exported}.json` });
  await page.getByRole('button', { name: 'Import' }).click();
  await page.getByRole('menuitem', { name: 'JSON file…' }).click();
  const prompt = page.getByRole('dialog', { name: 'Save this project?' });
  await prompt.getByRole('button', { name: "Don't save" }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Imported Shared plan.json: 1 task.' }),
  ).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Project name' })).toHaveValue('Shared plan');
});

test('saves as next to the current file under the project name, asking before replacing a project file', async () => {
  const path = join(folder, 'Plan.tasklace');
  await writeSampleProject(path);
  const chosen = join(folder, 'Copy');
  await writeFile(`${chosen}.tasklace`, 'kept');
  const saveAs = async (replace: boolean) => {
    await answerDialogs(application, { open: path, save: chosen, replace });
    return page.evaluate(async () => {
      const api = window.tasklace;
      const opened = await api?.openProject();
      if (opened?.ok !== true) {
        return opened;
      }
      await api?.adoptProject(opened.value.documentId);
      return api?.saveProjectAs(opened.value.state, 'Plan v2');
    });
  };
  expect(await saveAs(false)).toEqual({ ok: false, error: { code: 'CANCELLED' } });
  expect(await suggestedPath(application)).toBe(join(folder, 'Plan v2.tasklace'));
  expect(await readFile(`${chosen}.tasklace`, 'utf8')).toBe('kept');
  expect(await saveAs(true)).toEqual({ ok: true, value: { localCopySaved: true } });
  expect((await readFile(`${chosen}.tasklace`)).subarray(0, 4).toString()).toBe('TSKL');
});

/** Reads the name of the project a .tasklace file holds, or null while it cannot be read. */
async function projectNameIn(path: string): Promise<string | null> {
  const read = readTasklaceFile(await readFile(path), zlibCompressor);
  const project = read.ok ? readSharedProject(read.value) : null;
  return project?.ok === true ? project.value.name : null;
}

test('saves a changed project to its file and its local copy a little after the change', async () => {
  const path = join(folder, 'Plan.tasklace');
  await writeSampleProject(path);
  await expect(page.locator('#app')).toHaveAttribute('data-started', 'true');
  await answerDialogs(application, { open: path });
  await page.getByRole('button', { name: /^Open…/ }).click();
  const field = page.getByRole('textbox', { name: 'Project name' });
  await expect(field).toHaveValue(SAMPLE.name);
  await field.fill('Plan, renamed');
  await field.press('Enter');
  await expect(page.getByRole('status').filter({ hasText: 'Unsaved changes' })).toBeVisible();
  await expect.poll(() => projectNameIn(path)).toBe('Plan, renamed');
  await expect(page.getByRole('status').filter({ hasText: 'All changes saved' })).toBeVisible();
  expect(await readFile(join(userData, 'local-copies', `${TEST_DOCUMENT_ID}.tasklace`))).toEqual(
    await readFile(path),
  );
});
