import { readFile, rename, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { MAX_FILE_PATH_LENGTH, MAX_RENAME_RETRY_MILLISECONDS } from '../core/limits';

export interface Renaming {
  readonly platform: NodeJS.Platform;
  readonly now: () => number;
  readonly wait: (milliseconds: number) => Promise<unknown>;
}

export const SYSTEM_RENAMING: Renaming = {
  platform: process.platform,
  now: () => Date.now(),
  wait,
};
const WINDOWS = 'win32';
const LOCKED_FILE_CODES: ReadonlySet<unknown> = new Set(['EACCES', 'EPERM', 'EBUSY']);
const RENAME_RETRY_STEP_MILLISECONDS = 10;
const MAX_RENAME_RETRY_STEP_MILLISECONDS = 100;

const SYSTEM_ERROR_CODE = /^(E[A-Z0-9]+|UNKNOWN)$/;

/** Reads a small store file of the application as text, a missing file giving an empty text. */
export async function readStoredText(path: string): Promise<string> {
  return readFile(path, 'utf8').catch((error: unknown) => {
    if (isMissingFile(error)) {
      return '';
    }
    throw error;
  });
}

/** Parses the untrusted text of a store file, giving null for text that is not JSON. */
export function parseStoredJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

/** Tells whether a stored value is an absolute path of reasonable length without a null character. */
export function isStoredPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_FILE_PATH_LENGTH &&
    !value.includes('\0') &&
    isAbsolute(value)
  );
}

/** Tells whether a file system error means the file does not exist. */
export function isMissingFile(error: unknown): boolean {
  return isSystemError(error) && error.code === 'ENOENT';
}

/** Tells whether an error comes from the system, such as a missing file or a refused access, by its system error code or the code Windows gives an error it cannot name, rather than from a fault of the program such as an invalid argument. */
export function isSystemError(error: unknown): error is Error & { readonly code: string } {
  const code: unknown = error instanceof Error ? Reflect.get(error, 'code') : undefined;
  return typeof code === 'string' && SYSTEM_ERROR_CODE.test(code);
}

/** Keeps a damaged store file under its name followed by the time in milliseconds, so that what it held can still be recovered, trying again while Windows holds the file, a file the system cannot move being only logged since it is rewritten afterwards. */
export async function setDamagedFileAside(
  path: string,
  now: Date,
  what: string,
  renaming: Renaming = SYSTEM_RENAMING,
): Promise<void> {
  const asidePath = `${path}.damaged-${String(now.getTime())}`;
  try {
    await renameRetrying(path, asidePath, renaming);
    console.error(`${what} was damaged and was kept as ${asidePath}.`);
  } catch (error) {
    if (!isSystemError(error)) {
      throw error;
    }
    console.error(`${what} was damaged, could not be kept aside and is replaced:`, error);
  }
}

/** Renames a file, trying again on Windows while it is refused as locked, as an antivirus or an indexer briefly holds a file just written, waiting a little longer each time within a time limit, and failing with the last error. */
export async function renameRetrying(
  from: string,
  to: string,
  renaming: Renaming = SYSTEM_RENAMING,
): Promise<void> {
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
