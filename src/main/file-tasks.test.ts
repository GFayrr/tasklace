import { DEFAULT_CALENDAR } from '../core/calendar/default-calendar';
import { mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Y from 'yjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportProjectCsv } from '../core/exchange/csv/project-csv-export';
import { exportProjectJson } from '../core/exchange/project-json';
import { encodeTasklaceFile, encodeTasklaceState } from '../core/file/tasklace-file';
import { MAX_FILE_BYTES } from '../core/limits';
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
import { isResultOf, runFileTask, type FileTaskResult, type LoadedProject } from './file-tasks';
import { readIndexText } from './local-copies';
import { zlibCompressor } from './zlib-compressor';

const NAMING = { untitled: 'Untitled project', fromFile: 'From the file' };
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

const SAVED_WITH_COPY = { ok: true, value: { kind: 'saved', localCopySaved: true } };

/** Returns the project a task loaded, failing the test when it failed or loaded nothing. */
function loadedOf(result: FileTaskResult): LoadedProject {
  const value = unwrap(result);
  if (value.kind !== 'loaded') {
    throw new Error('Nothing was loaded');
  }
  return value;
}

/** Reads the local copy index kept in a folder. */
async function indexIn(copies: string) {
  return readIndexText(await readFile(join(copies, 'index.json'), 'utf8')).index;
}

/** Runs a task while silencing, and returning, what it logs as errors. */
async function quietly(task: () => Promise<FileTaskResult>) {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    return { result: await task(), logged: logged.mock.calls.map((call) => String(call[0])) };
  } finally {
    logged.mockRestore();
  }
}

/** Opens a Yjs state as a shared document. */
function documentOf(state: Uint8Array): Y.Doc {
  const document = new Y.Doc();
  Y.applyUpdate(document, state);
  return document;
}

describe('file tasks', () => {
  it('saves a project and its local copy, creating the folder of the copies, then opens it back unchanged', async () => {
    const path = join(folder, 'plan.tasklace');
    const source = createSharedDocument(SAMPLE, TEST_DOCUMENT_ID);
    const state = Y.encodeStateAsUpdate(source);
    const copies = join(folder, 'copies', 'nested');
    expect(
      await runFileTask({
        kind: 'saveProject',
        path,
        state,
        documentId: TEST_DOCUMENT_ID,
        localCopyFolder: copies,
        savedAt: SAVED_AT,
      }),
    ).toEqual(SAVED_WITH_COPY);
    const opened = loadedOf(await runFileTask({ kind: 'openProject', path }));
    expect(opened.documentId).toBe(TEST_DOCUMENT_ID);
    expect(readSharedProject(documentOf(opened.state))).toEqual(readSharedProject(source));
    expect(await readFile(join(copies, `${TEST_DOCUMENT_ID}.tasklace`))).toEqual(
      await readFile(path),
    );
    const index = await indexIn(copies);
    expect(index[TEST_DOCUMENT_ID]).toEqual({ path, savedAt: new Date(SAVED_AT).toISOString() });
  });

  it('imports JSON and CSV into new documents under the given identifier', async () => {
    const jsonPath = join(folder, 'plan.json');
    const csvPath = join(folder, 'plan.csv');
    await writeFile(jsonPath, `﻿${exportProjectJson(SAMPLE)}`);
    const table = { ...SAMPLE, calendar: DEFAULT_CALENDAR };
    await writeFile(csvPath, unwrap(exportProjectCsv(table, scheduleOrThrow(table), FRENCH)));
    const json = loadedOf(
      await runFileTask({
        kind: 'importJson',
        path: jsonPath,
        documentId: NEW_DOCUMENT_ID,
        naming: NAMING,
      }),
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

  it('names an imported JSON project after its file only while it bears the untitled name', async () => {
    const untitledPath = join(folder, 'untitled.json');
    const namedPath = join(folder, 'named.json');
    await writeFile(untitledPath, exportProjectJson({ ...SAMPLE, name: NAMING.untitled }));
    await writeFile(namedPath, exportProjectJson({ ...SAMPLE, name: 'Launch' }));
    const nameOf = async (path: string) => {
      const imported = loadedOf(
        await runFileTask({
          kind: 'importJson',
          path,
          documentId: NEW_DOCUMENT_ID,
          naming: NAMING,
        }),
      );
      return unwrap(readSharedProject(documentOf(imported.state))).name;
    };
    expect(await nameOf(untitledPath)).toBe(NAMING.fromFile);
    expect(await nameOf(namedPath)).toBe('Launch');
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
      await runFileTask({
        kind: 'importJson',
        path: latin1,
        documentId: NEW_DOCUMENT_ID,
        naming: NAMING,
      }),
    ).toEqual({
      ok: false,
      error: { code: 'INVALID_ENCODING' },
    });
    expect(
      await runFileTask({
        kind: 'importJson',
        path: broken,
        documentId: NEW_DOCUMENT_ID,
        naming: NAMING,
      }),
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
    expect(await runFileTask(task)).toEqual(SAVED_WITH_COPY);
    expect((await indexIn(folder))[TEST_DOCUMENT_ID]?.path).toBeNull();
    const opened = loadedOf(
      await runFileTask({
        kind: 'openProject',
        path: join(folder, `${TEST_DOCUMENT_ID}.tasklace`),
      }),
    );
    expect(opened.documentId).toBe(TEST_DOCUMENT_ID);
  });

  it('reports a project that cannot be written, logging why, and still writes its local copy', async () => {
    const state = Y.encodeStateAsUpdate(createSharedDocument(SAMPLE, TEST_DOCUMENT_ID));
    const task = {
      kind: 'saveProject',
      path: join(folder, 'missing-folder', 'plan.tasklace'),
      state,
      documentId: TEST_DOCUMENT_ID,
      localCopyFolder: folder,
      savedAt: SAVED_AT,
    } as const;
    const { result, logged } = await quietly(() => runFileTask(task));
    expect(result).toEqual({ ok: false, error: { code: 'WRITE_FAILED' } });
    expect(logged).toEqual(['The project file could not be written:']);
    const opened = loadedOf(
      await runFileTask({
        kind: 'openProject',
        path: join(folder, `${TEST_DOCUMENT_ID}.tasklace`),
      }),
    );
    expect(opened.documentId).toBe(TEST_DOCUMENT_ID);
  });

  it('saves a project whose local copy cannot be written, telling so, since its file is written', async () => {
    const path = join(folder, 'plan.tasklace');
    const blocking = join(folder, 'a-file');
    await writeFile(blocking, '');
    const state = Y.encodeStateAsUpdate(createSharedDocument(SAMPLE, TEST_DOCUMENT_ID));
    const task = {
      kind: 'saveProject',
      path,
      state,
      documentId: TEST_DOCUMENT_ID,
      localCopyFolder: join(blocking, 'copies'),
      savedAt: SAVED_AT,
    } as const;
    const { result, logged } = await quietly(() => runFileTask(task));
    expect(result).toEqual({ ok: true, value: { kind: 'saved', localCopySaved: false } });
    expect(logged).toEqual(['The local copy could not be written:']);
    expect(loadedOf(await runFileTask({ kind: 'openProject', path })).documentId).toBe(
      TEST_DOCUMENT_ID,
    );
  });

  it('fails to save a project without file whose local copy cannot be written, since nothing was written', async () => {
    const blocking = join(folder, 'a-file');
    await writeFile(blocking, '');
    const state = Y.encodeStateAsUpdate(createSharedDocument(SAMPLE, TEST_DOCUMENT_ID));
    const task = {
      kind: 'saveProject',
      path: null,
      state,
      documentId: TEST_DOCUMENT_ID,
      localCopyFolder: join(blocking, 'copies'),
      savedAt: SAVED_AT,
    } as const;
    const { result } = await quietly(() => runFileTask(task));
    expect(result).toEqual({ ok: false, error: { code: 'WRITE_FAILED' } });
  });

  it('reports an import of a file that is gone, and the problems of a table that cannot be imported', async () => {
    const options = { format: FRENCH, projectName: 'Plan', fallbackStart: SAMPLE.startDate };
    expect(
      await runFileTask({
        kind: 'importCsv',
        path: join(folder, 'gone.csv'),
        documentId: NEW_DOCUMENT_ID,
        options,
      }),
    ).toEqual({ ok: false, error: { code: 'READ_FAILED' } });
    const broken = join(folder, 'broken.csv');
    await writeFile(broken, 'Name;Duration\nWrite;soon\n');
    const imported = await runFileTask({
      kind: 'importCsv',
      path: broken,
      documentId: NEW_DOCUMENT_ID,
      options,
    });
    if (imported.ok || imported.error.code !== 'INVALID_IMPORT') {
      throw new Error('The table should have been refused as an invalid import');
    }
    expect(imported.error.issues).toEqual([{ path: 'rows[2].duration', code: 'INVALID_NUMBER' }]);
  });

  it('refuses a project file whose shared document carries no identifier', async () => {
    const document = createSharedDocument(SAMPLE, TEST_DOCUMENT_ID);
    document.getMap('project').delete('documentId');
    const path = join(folder, 'anonymous.tasklace');
    await writeFile(path, encodeTasklaceState(Y.encodeStateAsUpdate(document), zlibCompressor));
    expect(await runFileTask({ kind: 'openProject', path })).toEqual({
      ok: false,
      error: {
        code: 'INVALID_PROJECT',
        issues: [{ path: 'documentId', code: 'MISSING_FIELD' }],
      },
    });
  });

  it('reads only regular files, refusing a folder, and refuses a file larger than its limit through the same handle', async () => {
    expect(await runFileTask({ kind: 'openProject', path: folder })).toEqual({
      ok: false,
      error: { code: 'READ_FAILED' },
    });
    const huge = join(folder, 'huge.tasklace');
    await writeFile(huge, '');
    await truncate(huge, MAX_FILE_BYTES + 1);
    expect(await runFileTask({ kind: 'openProject', path: huge })).toEqual({
      ok: false,
      error: { code: 'TOO_LARGE' },
    });
  });

  it('never writes a state of another document, a broken state or an invalid project', async () => {
    const path = join(folder, 'plan.tasklace');
    const save = (state: Uint8Array) =>
      runFileTask({
        kind: 'saveProject',
        path,
        state,
        documentId: TEST_DOCUMENT_ID,
        localCopyFolder: folder,
        savedAt: SAVED_AT,
      });
    const other = Y.encodeStateAsUpdate(createSharedDocument(SAMPLE, NEW_DOCUMENT_ID));
    expect(await save(other)).toEqual({ ok: false, error: { code: 'WRONG_DOCUMENT' } });
    expect(await save(Uint8Array.from([1, 2, 3]))).toEqual({
      ok: false,
      error: { code: 'INVALID_STATE', issues: [] },
    });
    const broken = createSharedDocument(SAMPLE, TEST_DOCUMENT_ID);
    broken.getMap('project').set('name', 42);
    expect(await save(Y.encodeStateAsUpdate(broken))).toEqual({
      ok: false,
      error: { code: 'INVALID_STATE', issues: [{ path: 'name', code: 'WRONG_TYPE' }] },
    });
    await expect(readFile(path)).rejects.toThrow(/ENOENT/);
    await expect(readFile(join(folder, `${TEST_DOCUMENT_ID}.tasklace`))).rejects.toThrow(/ENOENT/);
  });
});

describe('isResultOf', () => {
  it('accepts a failure, and a success only of the kind its task gives', () => {
    const opening = { kind: 'openProject', path: '/plan.tasklace' } as const;
    const saving = {
      kind: 'saveProject',
      path: null,
      state: Uint8Array.of(),
      documentId: TEST_DOCUMENT_ID,
      localCopyFolder: '/copies',
      savedAt: 0,
    } as const;
    const loaded = { ok: true, value: { kind: 'loaded' } };
    const saved = { ok: true, value: { kind: 'saved' } };
    const failed = { ok: false, error: { code: 'TASK_FAILED' } };
    expect([loaded, saved, failed].map((value) => isResultOf(opening, value))).toEqual([
      true,
      false,
      true,
    ]);
    expect([loaded, saved, failed].map((value) => isResultOf(saving, value))).toEqual([
      false,
      true,
      true,
    ]);
    expect(
      [null, 'ok', { ok: 'yes' }, { ok: true }].map((value) => isResultOf(opening, value)),
    ).toEqual([false, false, false, false]);
  });
});
