import { DEFAULT_CALENDAR } from '../core/calendar/default-calendar';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Y from 'yjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportProjectCsv } from '../core/exchange/csv/project-csv-export';
import { exportProjectJson } from '../core/exchange/project-json';
import { encodeTasklaceFile } from '../core/file/tasklace-file';
import { createSharedDocument, readDocumentId } from '../core/shared/shared-document';
import { readSharedProject } from '../core/shared/shared-project';
import { unwrap } from '../core/testing/arbitraries';
import {
  link,
  project,
  scheduleOrThrow,
  TEST_DOCUMENT_ID,
  workTask,
} from '../core/testing/project-builder';
import { runFileTask, type FileTaskResult, type LoadedProject } from './file-tasks';
import { parseLocalCopyIndex } from './local-copies';
import { zlibCompressor } from './zlib-compressor';

const NEW_DOCUMENT_ID = '00000000-0000-4000-8000-00000000000f';
const SAMPLE = project([workTask('a', { name: 'Écrire' }), workTask('b')], [link('a', 'b')]);
const FRENCH = {
  listSeparator: ';',
  dateOrder: 'dayMonthYear',
  dateSeparator: '/',
  twelveHourClock: false,
} as const;
const SAVED_AT = Date.UTC(2026, 8, 30, 10);

let folder: string;

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'tasklace-tasks-'));
});

afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

/** Returns the project a task loaded, failing the test when it failed or loaded nothing. */
function loadedOf(result: FileTaskResult): LoadedProject {
  const value = unwrap(result);
  if (value === null) {
    throw new Error('Nothing was loaded');
  }
  return value;
}

/** Opens a Yjs state as a shared document. */
function documentOf(state: Uint8Array): Y.Doc {
  const document = new Y.Doc();
  Y.applyUpdate(document, state);
  return document;
}

describe('file tasks', () => {
  it('saves a project and its local copy, then opens it back unchanged', async () => {
    const path = join(folder, 'plan.tasklace');
    const source = createSharedDocument(SAMPLE, TEST_DOCUMENT_ID);
    const state = Y.encodeStateAsUpdate(source);
    const copies = join(folder, 'copies');
    await mkdir(copies);
    expect(
      await runFileTask({
        kind: 'saveProject',
        path,
        state,
        documentId: TEST_DOCUMENT_ID,
        localCopyFolder: copies,
        savedAt: SAVED_AT,
      }),
    ).toEqual({ ok: true, value: null });
    const opened = loadedOf(await runFileTask({ kind: 'openProject', path }));
    expect(opened.documentId).toBe(TEST_DOCUMENT_ID);
    expect(readSharedProject(documentOf(opened.state))).toEqual(readSharedProject(source));
    expect(await readFile(join(copies, `${TEST_DOCUMENT_ID}.tasklace`))).toEqual(
      await readFile(path),
    );
    const index = parseLocalCopyIndex(await readFile(join(copies, 'index.json'), 'utf8'));
    expect(index[TEST_DOCUMENT_ID]).toEqual({ path, savedAt: new Date(SAVED_AT).toISOString() });
  });

  it('imports JSON and CSV into new documents under the given identifier', async () => {
    const jsonPath = join(folder, 'plan.json');
    const csvPath = join(folder, 'plan.csv');
    await writeFile(jsonPath, `﻿${exportProjectJson(SAMPLE)}`);
    const table = { ...SAMPLE, calendar: DEFAULT_CALENDAR };
    await writeFile(csvPath, unwrap(exportProjectCsv(table, scheduleOrThrow(table), FRENCH)));
    const json = loadedOf(
      await runFileTask({ kind: 'importJson', path: jsonPath, documentId: NEW_DOCUMENT_ID }),
    );
    expect(readDocumentId(documentOf(json.state))).toBe(NEW_DOCUMENT_ID);
    expect(unwrap(readSharedProject(documentOf(json.state))).tasks).toHaveLength(2);
    const options = { format: FRENCH, projectName: 'Plan', fallbackStart: SAMPLE.startDate };
    const csv = loadedOf(
      await runFileTask({ kind: 'importCsv', path: csvPath, documentId: NEW_DOCUMENT_ID, options }),
    );
    expect(unwrap(readSharedProject(documentOf(csv.state))).name).toBe('Plan');
    expect(csv.warnings).toEqual([]);
  });

  it('reports a missing file, text that is not UTF-8, an invalid import and a forged project file', async () => {
    const missing = join(folder, 'missing.tasklace');
    const latin1 = join(folder, 'latin1.json');
    const broken = join(folder, 'broken.json');
    const forged = join(folder, 'forged.tasklace');
    await writeFile(latin1, Uint8Array.from([0x7b, 0xe9, 0x7d]));
    await writeFile(broken, '{"format":"tasklace"');
    const file = encodeTasklaceFile(createSharedDocument(SAMPLE, TEST_DOCUMENT_ID), zlibCompressor);
    file[file.length - 1] = (file[file.length - 1] ?? 0) ^ 1;
    await writeFile(forged, file);
    expect(await runFileTask({ kind: 'openProject', path: missing })).toEqual({
      ok: false,
      error: { code: 'READ_FAILED' },
    });
    expect(
      await runFileTask({ kind: 'importJson', path: latin1, documentId: NEW_DOCUMENT_ID }),
    ).toEqual({
      ok: false,
      error: { code: 'INVALID_ENCODING' },
    });
    expect(
      await runFileTask({ kind: 'importJson', path: broken, documentId: NEW_DOCUMENT_ID }),
    ).toEqual({
      ok: false,
      error: { code: 'INVALID_IMPORT', issues: [{ path: '', code: 'INVALID_JSON' }] },
    });
    expect(await runFileTask({ kind: 'openProject', path: forged })).toEqual({
      ok: false,
      error: { code: 'CORRUPTED' },
    });
  });

  it('keeps a project without file in its local copy only', async () => {
    const state = Y.encodeStateAsUpdate(createSharedDocument(SAMPLE, TEST_DOCUMENT_ID));
    const task = {
      kind: 'saveProject',
      path: null,
      state,
      documentId: TEST_DOCUMENT_ID,
      localCopyFolder: folder,
      savedAt: SAVED_AT,
    } as const;
    expect(await runFileTask(task)).toEqual({ ok: true, value: null });
    const index = parseLocalCopyIndex(await readFile(join(folder, 'index.json'), 'utf8'));
    expect(index[TEST_DOCUMENT_ID]?.path).toBeNull();
    const opened = loadedOf(
      await runFileTask({
        kind: 'openProject',
        path: join(folder, `${TEST_DOCUMENT_ID}.tasklace`),
      }),
    );
    expect(opened.documentId).toBe(TEST_DOCUMENT_ID);
  });

  it('reports a project that cannot be written', async () => {
    const state = Y.encodeStateAsUpdate(createSharedDocument(SAMPLE, TEST_DOCUMENT_ID));
    const task = {
      kind: 'saveProject',
      path: join(folder, 'missing-folder', 'plan.tasklace'),
      state,
      documentId: TEST_DOCUMENT_ID,
      localCopyFolder: folder,
      savedAt: SAVED_AT,
    } as const;
    expect(await runFileTask(task)).toEqual({ ok: false, error: { code: 'WRITE_FAILED' } });
  });
});
