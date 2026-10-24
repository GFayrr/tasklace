import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requireDocumentId } from '../core/shared/shared-document';

const asideFailure = vi.hoisted((): { error: Error | null; busy: number } => ({
  error: null,
  busy: 0,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  /** Renames a file, failing when a damaged index is set aside while the test asks for that failure, and refusing a file held by Windows as many times as asked. */
  const rename = (from: string, to: string): Promise<void> => {
    if (asideFailure.busy > 0) {
      asideFailure.busy -= 1;
      return Promise.reject(Object.assign(new Error('resource busy'), { code: 'EBUSY' }));
    }
    return asideFailure.error !== null && to.includes('.damaged-')
      ? Promise.reject(asideFailure.error)
      : original.rename(from, to);
  };
  return { ...original, rename };
});

const { readIndexText, saveLocalCopy, setLocalCopyAside } = await import('./local-copies');
const { setDamagedFileAside } = await import('./stored-files');

const DOCUMENT = requireDocumentId('00000000-0000-4000-8000-000000000001');
const SAVED_AT = new Date(Date.UTC(2026, 8, 30, 10));
const DAMAGED = '{"version":1,"copies":{"broken"';

let folder: string;

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'tasklace-copies-'));
  await writeFile(join(folder, 'index.json'), DAMAGED);
});

afterEach(async () => {
  asideFailure.error = null;
  asideFailure.busy = 0;
  await rm(folder, { recursive: true, force: true });
});

/** Makes setting the damaged index aside fail with an error. */
function failSettingAside(error: Error): void {
  asideFailure.error = error;
}

/** Builds a renaming on Windows whose clock moves only by the waits it records. */
function windowsRenaming() {
  const waits: number[] = [];
  let clock = 0;
  return {
    platform: 'win32' as const,
    waits,
    now: () => clock,
    wait: (milliseconds: number) => {
      waits.push(milliseconds);
      clock += milliseconds;
      return Promise.resolve();
    },
  };
}

describe('a file set aside while Windows briefly holds it', () => {
  it('sets a local copy aside once Windows lets go of it', async () => {
    await writeFile(join(folder, `${DOCUMENT}.tasklace`), 'copy');
    asideFailure.busy = 2;
    const renaming = windowsRenaming();
    const aside = await setLocalCopyAside(folder, DOCUMENT, SAVED_AT, renaming);
    expect([aside, renaming.waits, await readFile(aside ?? '', 'utf8')]).toEqual([
      join(folder, `${DOCUMENT}.set-aside-2026-09-30T10-00-00-000Z.tasklace`),
      [10, 20],
      'copy',
    ]);
  });

  it('keeps a damaged store file aside once Windows lets go of it', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    asideFailure.busy = 1;
    const renaming = windowsRenaming();
    const path = join(folder, 'index.json');
    await setDamagedFileAside(path, SAVED_AT, 'The test file', renaming);
    const aside = `${path}.damaged-${String(SAVED_AT.getTime())}`;
    expect([logged.mock.calls, renaming.waits, await readFile(aside, 'utf8')]).toEqual([
      [[`The test file was damaged and was kept as ${aside}.`]],
      [10],
      DAMAGED,
    ]);
    logged.mockRestore();
  });
});

describe('a damaged local copy index that cannot be kept aside', () => {
  it('is logged, then replaced by an index holding its well-formed entries', async () => {
    const refusal = Object.assign(new Error('read-only file system'), { code: 'EROFS' });
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
