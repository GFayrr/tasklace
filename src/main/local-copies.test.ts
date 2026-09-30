import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  formatLocalCopyIndex,
  localCopyPath,
  parseLocalCopyIndex,
  saveLocalCopy,
} from './local-copies';

const FIRST = '00000000-0000-4000-8000-000000000001';
const SECOND = '00000000-0000-4000-8000-000000000002';
const SOURCE = resolve('/projects/plan.tasklace');
const SAVED_AT = new Date(Date.UTC(2026, 8, 30, 10));

let folder: string;

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'tasklace-copies-'));
});

afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

describe('local copies', () => {
  it('keeps a copy only under a valid document identifier', () => {
    expect(localCopyPath(folder, FIRST)).toBe(join(folder, `${FIRST}.tasklace`));
    for (const identifier of [
      '../escape',
      `${FIRST}/../x`,
      'A0000000-0000-4000-8000-000000000001',
      '',
    ]) {
      expect(localCopyPath(folder, identifier)).toBeNull();
    }
  });

  it('reads back the index it writes and drops damaged entries', () => {
    const index = { [FIRST]: { path: SOURCE, savedAt: SAVED_AT.toISOString() } };
    expect(parseLocalCopyIndex(formatLocalCopyIndex(index))).toEqual(index);
    const damaged = JSON.stringify({
      version: 1,
      copies: {
        [FIRST]: { path: null, savedAt: SAVED_AT.toISOString() },
        '../escape': { path: null, savedAt: SAVED_AT.toISOString() },
        [SECOND]: { path: 'relative', savedAt: 'yesterday' },
      },
    });
    expect(parseLocalCopyIndex(damaged)).toEqual({
      [FIRST]: { path: null, savedAt: SAVED_AT.toISOString() },
    });
    for (const text of ['', 'x', '[]', JSON.stringify({ version: 2, copies: {} })]) {
      expect(parseLocalCopyIndex(text)).toEqual({});
    }
  });

  it('writes the copy and records every document, even when saved at the same time', async () => {
    const file = Uint8Array.from([7, 8, 9]);
    await Promise.all([
      saveLocalCopy(folder, FIRST, file, SOURCE, SAVED_AT),
      saveLocalCopy(folder, SECOND, file, null, SAVED_AT),
    ]);
    expect(new Uint8Array(await readFile(join(folder, `${FIRST}.tasklace`)))).toEqual(file);
    const index = parseLocalCopyIndex(await readFile(join(folder, 'index.json'), 'utf8'));
    expect(Object.keys(index).sort()).toEqual([FIRST, SECOND]);
    expect((await readdir(folder)).sort()).toEqual(
      [`${FIRST}.tasklace`, `${SECOND}.tasklace`, 'index.json'].sort(),
    );
  });

  it('refuses to write a copy under an invalid identifier', async () => {
    await expect(
      saveLocalCopy(folder, '../escape', Uint8Array.from([1]), null, SAVED_AT),
    ).rejects.toThrow();
    expect(await readdir(folder)).toEqual([]);
  });
});
