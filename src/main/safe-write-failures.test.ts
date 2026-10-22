import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const faults = vi.hoisted(
  (): {
    sync: Error | null;
    close: Error | null;
    rename: Error | null;
    renames: Error[];
    remove: Error | null;
    stat: Error | null;
  } => ({ sync: null, close: null, rename: null, renames: [], remove: null, stat: null }),
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
  const rename = (from: string, to: string): Promise<void> => {
    const fault = faults.renames.shift() ?? faults.rename;
    return fault === null ? original.rename(from, to) : Promise.reject(fault);
  };
  /** Examines a file, failing when the test asks for it. */
  const examine = (...values: Parameters<typeof original.stat>) =>
    faults.stat === null ? original.stat(...values) : Promise.reject(faults.stat);
  /** Removes a file, failing when the test asks for it, the real file being removed in every case. */
  const removeFile = async (...values: Parameters<typeof original.rm>): Promise<void> => {
    await original.rm(...values);
    if (faults.remove !== null) {
      throw faults.remove;
    }
  };
  return { ...original, open, rename, rm: removeFile, stat: examine };
});

const { writeFileSafely } = await import('./safe-write');
type Renaming = import('./safe-write').Renaming;

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
  faults.renames = [];
  faults.remove = null;
  faults.stat = null;
  await rm(folder, { recursive: true, force: true });
});

/** Creates an error of the system with a code, as Node gives them. */
function systemError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

/** Builds a renaming on a platform whose clock moves only by the waits it records. */
function renamingOn(platform: NodeJS.Platform): Renaming & { readonly waits: number[] } {
  const waits: number[] = [];
  let clock = 0;
  return {
    platform,
    waits,
    now: () => clock,
    wait: (milliseconds) => {
      waits.push(milliseconds);
      clock += milliseconds;
      return Promise.resolve();
    },
  };
}

/** Writes the target safely, returning the error it failed with and what it logged. */
async function failedWrite(
  renaming: Renaming = renamingOn('linux'),
): Promise<{ readonly error: unknown; readonly logged: unknown[][] }> {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  let error: unknown = null;
  try {
    await writeFileSafely(target, 'new', renaming);
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

describe('writeFileSafely when Windows holds a file for a moment', () => {
  /** Gives the waits between tries until the time limit, ten milliseconds longer each time up to a tenth of a second. */
  const waitsUntilTheLimit = (): number[] => {
    const waits: number[] = [];
    for (let total = 0; total < 8_192; total += waits.at(-1) ?? 0) {
      waits.push(Math.min((waits.length + 1) * 10, 100));
    }
    return waits;
  };

  it('tries the rename again while it is refused as locked, then writes the file', async () => {
    const windows = renamingOn('win32');
    faults.renames = [systemError('EPERM'), systemError('EBUSY'), systemError('EACCES')];
    await writeFileSafely(target, 'new', windows);
    expect([await readFile(target, 'utf8'), await readdir(folder), windows.waits]).toEqual([
      'new',
      ['project.tasklace'],
      [10, 20, 30],
    ]);
  });

  it('gives the last refusal once the time limit is reached, keeping the target and removing the temporary file', async () => {
    const windows = renamingOn('win32');
    const last = systemError('EBUSY');
    faults.rename = last;
    const { error } = await failedWrite(windows);
    expect([error, windows.waits, await readFile(target, 'utf8'), await readdir(folder)]).toEqual([
      last,
      waitsUntilTheLimit(),
      KEPT,
      ['project.tasklace'],
    ]);
  });

  it('fails at once for another error, on another system, and over a folder', async () => {
    const windows = renamingOn('win32');
    const linux = renamingOn('linux');
    const full = systemError('ENOSPC');
    faults.renames = [full];
    const other = await failedWrite(windows);
    const denied = systemError('EPERM');
    faults.renames = [denied];
    const elsewhere = await failedWrite(linux);
    faults.renames = [denied];
    await rm(target);
    await mkdir(target);
    const folderTarget = await failedWrite(windows);
    expect([other.error, elsewhere.error, folderTarget.error, windows.waits, linux.waits]).toEqual([
      full,
      denied,
      denied,
      [],
      [],
    ]);
  });

  it('tries again when the target cannot be examined, but throws an error of the program met while examining it', async () => {
    const windows = renamingOn('win32');
    faults.renames = [systemError('EPERM')];
    faults.stat = systemError('EACCES');
    await writeFileSafely(target, 'new', windows);
    const fault = new TypeError('a fault of the program');
    faults.renames = [systemError('EPERM')];
    faults.stat = fault;
    const { error } = await failedWrite(windows);
    expect([windows.waits, await readFile(target, 'utf8'), error]).toEqual([[10], 'new', fault]);
  });
});
