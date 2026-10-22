import { randomUUID } from 'node:crypto';
import { open, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { MAX_RENAME_RETRY_MILLISECONDS } from '../core/limits';
import { isSystemError } from './stored-files';

export interface Renaming {
  readonly platform: NodeJS.Platform;
  readonly now: () => number;
  readonly wait: (milliseconds: number) => Promise<unknown>;
}

const SYSTEM_RENAMING: Renaming = { platform: process.platform, now: () => Date.now(), wait };
const WINDOWS = 'win32';
const LOCKED_FILE_CODES: ReadonlySet<unknown> = new Set(['EACCES', 'EPERM', 'EBUSY']);
const RENAME_RETRY_STEP_MILLISECONDS = 10;
const MAX_RENAME_RETRY_STEP_MILLISECONDS = 100;

/** Writes content to a file without ever leaving it half written: into a temporary file beside it, forced to disk, then renamed over it, the temporary file being removed on failure, a failed removal only logged. */
export async function writeFileSafely(
  path: string,
  content: Uint8Array | string,
  renaming: Renaming = SYSTEM_RENAMING,
): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeAndSync(temporary, content);
    await renameRetrying(temporary, path, renaming);
  } catch (error) {
    await rm(temporary, { force: true }).catch((removal: unknown) => {
      console.error(`The temporary file ${temporary} could not be removed:`, removal);
    });
    throw error;
  }
}

/** Creates a new file, writes content into it, forces it to disk and closes it, a file that cannot be closed after a failed write being logged so that the error given stays that of the write. */
async function writeAndSync(path: string, content: Uint8Array | string): Promise<void> {
  const handle = await open(path, 'wx');
  try {
    await handle.writeFile(content);
    await handle.sync();
  } catch (error) {
    await handle.close().catch((closing: unknown) => {
      console.error('The temporary file could not be closed after a failed write:', closing);
    });
    throw error;
  }
  await handle.close();
}

/** Renames a file, trying again on Windows while it is refused as locked, as an antivirus or an indexer briefly holds a file just written, waiting a little longer each time within a time limit, and failing with the last error. */
async function renameRetrying(from: string, to: string, renaming: Renaming): Promise<void> {
  const start = renaming.now();
  let step = 0;
  for (;;) {
    const failed = await renameOrFailure(from, to);
    if (failed === null) {
      return;
    }
    if (!(await mayRetry(failed.error, to, renaming, start))) {
      throw failed.error;
    }
    step = Math.min(step + RENAME_RETRY_STEP_MILLISECONDS, MAX_RENAME_RETRY_STEP_MILLISECONDS);
    await renaming.wait(step);
  }
}

/** Renames a file, giving the error it failed with, or null once renamed. */
async function renameOrFailure(
  from: string,
  to: string,
): Promise<{ readonly error: unknown } | null> {
  try {
    await rename(from, to);
    return null;
  } catch (error) {
    return { error };
  }
}

/** Tells whether a refused rename may be tried again: on Windows only, for an error of a locked file, within the time limit, and never over a folder, which no wait makes replaceable. */
async function mayRetry(
  error: unknown,
  to: string,
  renaming: Renaming,
  start: number,
): Promise<boolean> {
  const isLocked = LOCKED_FILE_CODES.has(Reflect.get(Object(error), 'code'));
  const inTime = renaming.now() - start < MAX_RENAME_RETRY_MILLISECONDS;
  return renaming.platform === WINDOWS && isLocked && inTime && !(await isFolder(to));
}

/** Tells whether a path leads to a folder, a path the system cannot examine, such as a missing one, counting as none. */
async function isFolder(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (!isSystemError(error)) {
      throw error;
    }
    return false;
  }
}
