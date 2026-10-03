import { readFile } from 'node:fs/promises';
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
