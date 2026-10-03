import { readFile, rename } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { MAX_FILE_PATH_LENGTH } from '../core/limits';

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

/** Tells whether an error comes from the system, such as a missing file or a refused access, rather than from a fault of the program. */
export function isSystemError(error: unknown): error is Error & { readonly code: string } {
  return error instanceof Error && typeof Reflect.get(error, 'code') === 'string';
}

/** Keeps a damaged store file under its name followed by the time in milliseconds, so that what it held can still be recovered, a file that cannot be moved being only logged since it is rewritten afterwards. */
export async function setDamagedFileAside(path: string, now: Date, what: string): Promise<void> {
  const asidePath = `${path}.damaged-${String(now.getTime())}`;
  try {
    await rename(path, asidePath);
    console.error(`${what} was damaged and was kept as ${asidePath}.`);
  } catch (error) {
    if (!isSystemError(error)) {
      throw error;
    }
    console.error(`${what} was damaged, could not be kept aside and is replaced:`, error);
  }
}
