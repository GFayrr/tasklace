import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_FILE_PATH_LENGTH } from '../core/limits';
import { isMissingFile, isStoredPath, parseStoredJson, readStoredText } from './stored-files';

let folder: string;

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'tasklace-stored-'));
});

afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

describe('readStoredText', () => {
  it('reads a store file, a missing one giving an empty text', async () => {
    await writeFile(join(folder, 'store.json'), '{"a":1}');
    expect(await readStoredText(join(folder, 'store.json'))).toBe('{"a":1}');
    expect(await readStoredText(join(folder, 'missing.json'))).toBe('');
  });

  it('lets any failure other than a missing file through', async () => {
    await expect(readStoredText(folder)).rejects.toMatchObject({ code: 'EISDIR' });
  });
});

describe('parseStoredJson', () => {
  it('parses JSON and gives null for text that is not JSON', () => {
    expect(parseStoredJson('{"paths":[]}')).toEqual({ paths: [] });
    expect(parseStoredJson('')).toBeNull();
    expect(parseStoredJson('{')).toBeNull();
  });

  it('lets an unexpected failure of the parser through', () => {
    const parse = vi.spyOn(JSON, 'parse').mockImplementation(() => {
      throw new RangeError('too deep');
    });
    try {
      expect(() => parseStoredJson('[]')).toThrow('too deep');
    } finally {
      parse.mockRestore();
    }
  });
});

describe('isStoredPath', () => {
  it('accepts only absolute paths of reasonable length without a null character', () => {
    const absolute = resolve('/projects/plan.tasklace');
    expect(isStoredPath(absolute)).toBe(true);
    expect(isStoredPath('plan.tasklace')).toBe(false);
    expect(isStoredPath(`${absolute}\0`)).toBe(false);
    expect(isStoredPath(resolve(`/${'a'.repeat(MAX_FILE_PATH_LENGTH)}`))).toBe(false);
    expect(isStoredPath(42)).toBe(false);
  });
});

describe('isMissingFile', () => {
  it('recognizes only the error of a file that does not exist', () => {
    expect(isMissingFile(Object.assign(new Error('gone'), { code: 'ENOENT' }))).toBe(true);
    expect(isMissingFile(Object.assign(new Error('busy'), { code: 'EBUSY' }))).toBe(false);
    expect(isMissingFile({ code: 'ENOENT' })).toBe(false);
  });
});
