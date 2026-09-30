import { mkdtemp, readdir, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { exportProjectCsv } from '../../src/core/exchange/csv/project-csv-export';
import { encodeTasklaceFile } from '../../src/core/file/tasklace-file';
import { MAX_FILE_BYTES } from '../../src/core/limits';
import { createSharedDocument } from '../../src/core/shared/shared-document';
import { unwrap } from '../../src/core/testing/arbitraries';
import {
  link,
  project,
  scheduleOrThrow,
  TEST_DOCUMENT_ID,
  workTask,
} from '../../src/core/testing/project-builder';
import { parseLocalCopyIndex } from '../../src/main/local-copies';
import { zlibCompressor } from '../../src/main/zlib-compressor';
import { answerDialogs } from './dialogs';

const SAMPLE = project([workTask('a', { name: 'Écrire' }), workTask('b')], [link('a', 'b')]);

let folder: string;
let userData: string;
let application: ElectronApplication;
let page: Page;

test.beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'tasklace-e2e-files-'));
  userData = await mkdtemp(join(tmpdir(), 'tasklace-e2e-data-'));
  application = await electron.launch({ args: ['.', `--user-data-dir=${userData}`] });
  page = await application.firstWindow();
  await page.waitForLoadState('domcontentloaded');
});

test.afterEach(async () => {
  await application.close();
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
    const saved = await api?.saveProject(opened.value.state);
    return { name: opened.value.name, saved, recent: await api?.recentProjects() };
  });
  expect(outcome).toEqual({
    name: 'Plan',
    saved: { ok: true, value: null },
    recent: [{ name: 'Plan', folder }],
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
  await writeFile(csv, unwrap(exportProjectCsv(SAMPLE, scheduleOrThrow(SAMPLE), format)));
  await answerDialogs(application, { open: csv, save: target });
  const outcome = await page.evaluate(async () => {
    const api = window.tasklace;
    const imported = await api?.importProject('csv');
    if (imported?.ok !== true) {
      return { imported };
    }
    const kept = await api?.saveProject(imported.value.state);
    const savedAs = await api?.saveProjectAs(imported.value.state);
    return { name: imported.value.name, warnings: imported.value.warnings, kept, savedAs };
  });
  expect(outcome).toEqual({
    name: 'Tasks',
    warnings: [],
    kept: { ok: true, value: null },
    savedAs: { ok: true, value: null },
  });
  expect((await readFile(target)).subarray(0, 4).toString()).toBe('TSKL');
  const index = parseLocalCopyIndex(
    await readFile(join(userData, 'local-copies', 'index.json'), 'utf8'),
  );
  expect(Object.values(index)).toMatchObject([{ path: target }]);
});

test('refuses forged and oversized files without loading anything, and a cancelled dialog', async () => {
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
    await api?.newProject();
    return Promise.all([
      attempt(api?.saveProject('not bytes')),
      attempt(api?.importProject('tasklace')),
      attempt(api?.openRecentProject(99)),
      attempt(api?.exportProject('pdf', 'x')),
    ]);
  });
  expect(refusals).toEqual(['refused', 'refused', 'refused', 'refused']);
});
