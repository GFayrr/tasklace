import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Y from 'yjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeTasklaceState } from '../core/file/tasklace-file';
import { createSharedDocument } from '../core/shared/shared-document';
import { project, TEST_DOCUMENT_ID, workTask } from '../core/testing/project-builder';
import { runFileTask } from './file-tasks';
import { zlibCompressor } from './zlib-compressor';

const limits = vi.hoisted(() => ({ fileBytes: Number.POSITIVE_INFINITY }));

vi.mock('../core/limits', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../core/limits')>()),
  get MAX_FILE_BYTES() {
    return limits.fileBytes;
  },
}));

const SAVED_AT = new Date(Date.UTC(2026, 8, 30, 10));
const GOOD_CONTENT = 'The good file';
const STATE = Y.encodeStateAsUpdate(
  createSharedDocument(project([workTask('a'), workTask('b')]), TEST_DOCUMENT_ID),
);

let folder: string;

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'tasklace-limits-'));
  limits.fileBytes = Number.POSITIVE_INFINITY;
});

afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

describe('saving a project larger than a project file may be', () => {
  it('writes neither the file nor its local copy that could not be opened again, keeping the good file and logging why', async () => {
    const path = join(folder, 'plan.tasklace');
    await writeFile(path, GOOD_CONTENT);
    const copies = join(folder, 'copies');
    limits.fileBytes = 64;
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = await runFileTask({
      kind: 'saveProject',
      path,
      state: STATE,
      documentId: TEST_DOCUMENT_ID,
      localCopyFolder: copies,
      savedAt: SAVED_AT,
    });
    const lines = logged.mock.calls;
    logged.mockRestore();
    expect(result).toEqual({ ok: false, error: { code: 'TOO_LARGE_TO_SAVE' } });
    const bytes = encodeTasklaceState(STATE, zlibCompressor).length;
    expect(lines).toEqual([
      [
        `The project was not saved: its file would weigh ${String(bytes)} bytes, more than the 64 a project file may weigh to be opened again.`,
      ],
    ]);
    expect(await readFile(path, 'utf8')).toBe(GOOD_CONTENT);
    expect(await readdir(folder)).toEqual(['plan.tasklace']);
  });

  it('writes a project whose file weighs exactly as much as a project file may', async () => {
    const path = join(folder, 'plan.tasklace');
    const copies = join(folder, 'copies');
    const task = {
      kind: 'saveProject',
      path,
      state: STATE,
      documentId: TEST_DOCUMENT_ID,
      localCopyFolder: copies,
      savedAt: SAVED_AT,
    } as const;
    expect(await runFileTask(task)).toEqual({
      ok: true,
      value: { kind: 'saved', localCopySaved: true },
    });
    limits.fileBytes = (await readFile(path)).length;
    expect(await runFileTask(task)).toEqual({
      ok: true,
      value: { kind: 'saved', localCopySaved: true },
    });
  });
});
