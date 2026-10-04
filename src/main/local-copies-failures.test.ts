import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const asideFailure = vi.hoisted((): { error: Error | null } => ({ error: null }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  const rename = (from: string, to: string): Promise<void> =>
    asideFailure.error !== null && to.includes('.damaged-')
      ? Promise.reject(asideFailure.error)
      : original.rename(from, to);
  return { ...original, rename };
});

const { readIndexText, saveLocalCopy } = await import('./local-copies');

const DOCUMENT = '00000000-0000-4000-8000-000000000001';
const SAVED_AT = new Date(Date.UTC(2026, 8, 30, 10));
const DAMAGED = '{"version":1,"copies":{"broken"';

let folder: string;

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'tasklace-copies-'));
  await writeFile(join(folder, 'index.json'), DAMAGED);
});

afterEach(async () => {
  asideFailure.error = null;
  await rm(folder, { recursive: true, force: true });
});

/** Makes setting the damaged index aside fail with an error. */
function failSettingAside(error: Error): void {
  asideFailure.error = error;
}

describe('a damaged local copy index that cannot be kept aside', () => {
  it('is logged, then replaced by an index holding its well-formed entries', async () => {
    const refusal = Object.assign(new Error('access denied'), { code: 'EACCES' });
    failSettingAside(refusal);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await saveLocalCopy(folder, DOCUMENT, Uint8Array.from([1]), null, SAVED_AT);
      expect(logged).toHaveBeenCalledWith(
        'The local copy index was damaged, could not be kept aside and is replaced:',
        refusal,
      );
    } finally {
      logged.mockRestore();
    }
    const index = readIndexText(await readFile(join(folder, 'index.json'), 'utf8'));
    expect(index).toEqual({
      index: { [DOCUMENT]: { path: null, savedAt: SAVED_AT.toISOString() } },
      damaged: false,
    });
    expect((await readdir(folder)).filter((name) => name.includes('.damaged-'))).toEqual([]);
  });

  it('stops the save when the failure is not an error of the system', async () => {
    failSettingAside(new Error('program fault'));
    await expect(
      saveLocalCopy(folder, DOCUMENT, Uint8Array.from([1]), null, SAVED_AT),
    ).rejects.toThrow('program fault');
    expect(await readFile(join(folder, 'index.json'), 'utf8')).toBe(DAMAGED);
  });
});
