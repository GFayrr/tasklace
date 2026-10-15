import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const faults = vi.hoisted(
  (): {
    sync: Error | null;
    close: Error | null;
    rename: Error | null;
    remove: Error | null;
  } => ({ sync: null, close: null, rename: null, remove: null }),
);

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  /** Opens a file whose forcing to disk and closing fail when the test asks for it, the real file being closed in every case. */
  const open = async (...values: Parameters<typeof original.open>) => {
    const handle = await original.open(...values);
    return {
      writeFile: (content: Uint8Array | string) => handle.writeFile(content),
      sync: () => (faults.sync === null ? handle.sync() : Promise.reject(faults.sync)),
      close: async () => {
        await handle.close();
        if (faults.close !== null) {
          throw faults.close;
        }
      },
    };
  };
  /** Renames a file, failing when the test asks for it. */
  const rename = (from: string, to: string): Promise<void> =>
    faults.rename === null ? original.rename(from, to) : Promise.reject(faults.rename);
  /** Removes a file, failing when the test asks for it, the real file being removed in every case. */
  const removeFile = async (...values: Parameters<typeof original.rm>): Promise<void> => {
    await original.rm(...values);
    if (faults.remove !== null) {
      throw faults.remove;
    }
  };
  return { ...original, open, rename, rm: removeFile };
});

const { writeFileSafely } = await import('./safe-write');

const KEPT = 'kept';

let folder: string;
let target: string;

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'tasklace-safe-write-failures-'));
  target = join(folder, 'project.tasklace');
  await writeFile(target, KEPT);
});

afterEach(async () => {
  faults.sync = null;
  faults.close = null;
  faults.rename = null;
  faults.remove = null;
  await rm(folder, { recursive: true, force: true });
});

/** Creates an error of the system with a code, as Node gives them. */
function systemError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

/** Writes the target safely, returning the error it failed with and what it logged. */
async function failedWrite(): Promise<{ readonly error: unknown; readonly logged: unknown[][] }> {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  let error: unknown = null;
  try {
    await writeFileSafely(target, 'new');
  } catch (caught) {
    error = caught;
  }
  const calls = [...logged.mock.calls];
  logged.mockRestore();
  return { error, logged: calls };
}

describe('writeFileSafely when the system fails', () => {
  it('gives the error of a write that could not be forced to disk, not that of closing the file afterwards, which is logged', async () => {
    const full = systemError('ENOSPC');
    const busy = systemError('EBUSY');
    faults.sync = full;
    faults.close = busy;
    expect(await failedWrite()).toEqual({
      error: full,
      logged: [['The temporary file could not be closed after a failed write:', busy]],
    });
    expect(await readFile(target, 'utf8')).toBe(KEPT);
    expect(await readdir(folder)).toEqual(['project.tasklace']);
  });

  it('gives the error of a file that could not be closed once written, never replacing the target', async () => {
    const busy = systemError('EBUSY');
    faults.close = busy;
    expect(await failedWrite()).toEqual({ error: busy, logged: [] });
    expect(await readFile(target, 'utf8')).toBe(KEPT);
    expect(await readdir(folder)).toEqual(['project.tasklace']);
  });

  it('gives the error of a rename, not that of removing the temporary file afterwards, which is logged', async () => {
    const denied = systemError('EPERM');
    const locked = systemError('EBUSY');
    faults.rename = denied;
    faults.remove = locked;
    const { error, logged } = await failedWrite();
    expect(error).toBe(denied);
    expect(logged).toHaveLength(1);
    const [[text, removal]] = logged as [[string, unknown]];
    expect(removal).toBe(locked);
    expect(text).toMatch(
      /^The temporary file .+\.project\.tasklace\.[0-9a-f-]{36}\.tmp could not be removed:$/,
    );
    expect(await readFile(target, 'utf8')).toBe(KEPT);
  });
});
