import { MAX_FILE_PATH_LENGTH } from '../../core/limits';

declare const WINDOWS_EXECUTABLE: unique symbol;

export type WindowsExecutablePath = string & { readonly [WINDOWS_EXECUTABLE]: true };

export type CopyKind = 'portable' | 'installed';

export interface CopyPlace {
  readonly kind: CopyKind;
  readonly executable: WindowsExecutablePath;
}

const WINDOWS_PLATFORM = 'win32';
const PORTABLE_EXECUTABLE = 'PORTABLE_EXECUTABLE_FILE';
const FULL_WINDOWS_PATH = /^([A-Za-z]:\\|\\\\)/;
const CONTROL_OR_QUOTE = /[\u0000-\u001f\u007f"]/;

/** Tells whether a value is the full Windows path of a file, from its drive or its network share, of reasonable length and without a quote or a control character, so that a command and a registry file can hold it as it is. */
export function isWindowsExecutablePath(value: unknown): value is WindowsExecutablePath {
  return (
    typeof value === 'string' &&
    value.length <= MAX_FILE_PATH_LENGTH &&
    !CONTROL_OR_QUOTE.test(value) &&
    FULL_WINDOWS_PATH.test(value)
  );
}

/** Tells which built copy for Windows runs and the executable that opens its files, the portable one the person keeps rather than its unpacked copy, or returns null, logging a path it cannot use. */
export function copyPlaceOf(
  platform: NodeJS.Platform,
  isPackaged: boolean,
  executablePath: string,
  environment: Readonly<Record<string, string | undefined>>,
): CopyPlace | null {
  if (platform !== WINDOWS_PLATFORM || !isPackaged) {
    return null;
  }
  const portable = environment[PORTABLE_EXECUTABLE];
  const kind: CopyKind = portable === undefined || portable === '' ? 'installed' : 'portable';
  const executable = kind === 'installed' ? executablePath : portable;
  if (!isWindowsExecutablePath(executable)) {
    console.error(`The ${kind} executable has a path Tasklace cannot use:`, executable);
    return null;
  }
  return { kind, executable };
}
