import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatLocalCopyIndex, localCopyPath, readIndexText, saveLocalCopy } from './local-copies';

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
    expect(readIndexText(formatLocalCopyIndex(index)).index).toEqual(index);
    const damaged = JSON.stringify({
      version: 1,
      copies: {
        [FIRST]: { path: null, savedAt: SAVED_AT.toISOString() },
        '../escape': { path: null, savedAt: SAVED_AT.toISOString() },
        [SECOND]: { path: 'relative', savedAt: 'yesterday' },
      },
    });
    expect(readIndexText(damaged).index).toEqual({
      [FIRST]: { path: null, savedAt: SAVED_AT.toISOString() },
    });
    for (const text of ['', 'x', '[]', JSON.stringify({ version: 2, copies: {} })]) {
      expect(readIndexText(text).index).toEqual({});
    }
  });

  it('writes the copy and records every document, even when saved at the same time', async () => {
    const file = Uint8Array.from([7, 8, 9]);
    await Promise.all([
      saveLocalCopy(folder, FIRST, file, SOURCE, SAVED_AT),
      saveLocalCopy(folder, SECOND, file, null, SAVED_AT),
    ]);
    expect(new Uint8Array(await readFile(join(folder, `${FIRST}.tasklace`)))).toEqual(file);
    const index = readIndexText(await readFile(join(folder, 'index.json'), 'utf8')).index;
    expect(Object.keys(index).sort()).toEqual([FIRST, SECOND]);
    expect((await readdir(folder)).sort()).toEqual(
      [`${FIRST}.tasklace`, `${SECOND}.tasklace`, 'index.json'].sort(),
    );
  });

  it('tells a damaged index apart from a whole or missing one', () => {
    const whole = formatLocalCopyIndex({
      [FIRST]: { path: null, savedAt: SAVED_AT.toISOString() },
    });
    expect(readIndexText(whole).damaged).toBe(false);
    expect(readIndexText('')).toEqual({ index: {}, damaged: false });
    for (const text of ['x', '[]', JSON.stringify({ version: 2, copies: {} })]) {
      expect(readIndexText(text)).toEqual({ index: {}, damaged: true });
    }
    const partly = JSON.stringify({
      version: 1,
      copies: { [FIRST]: { path: null, savedAt: SAVED_AT.toISOString() }, '../x': {} },
    });
    expect(readIndexText(partly).damaged).toBe(true);
  });

  it('keeps a damaged index aside before writing a new one, so that nothing it held is lost', async () => {
    await writeFile(join(folder, 'index.json'), '{"version":1,"copies":{"broken"');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await saveLocalCopy(folder, FIRST, Uint8Array.from([1]), null, SAVED_AT);
      expect(logged).toHaveBeenCalledTimes(1);
    } finally {
      logged.mockRestore();
    }
    const files = await readdir(folder);
    const aside = files.filter((name) => name.startsWith('index.json.damaged-'));
    expect(aside).toHaveLength(1);
    expect(await readFile(join(folder, aside[0] ?? ''), 'utf8')).toBe(
      '{"version":1,"copies":{"broken"',
    );
    const index = readIndexText(await readFile(join(folder, 'index.json'), 'utf8')).index;
    expect(Object.keys(index)).toEqual([FIRST]);
  });

  it('refuses to write a copy under an invalid identifier', async () => {
    await expect(
      saveLocalCopy(folder, '../escape', Uint8Array.from([1]), null, SAVED_AT),
    ).rejects.toThrow();
    expect(await readdir(folder)).toEqual([]);
  });
});
