import { MAX_FILE_PATH_LENGTH } from '../../core/limits';
import type { CopyKind } from '../setup/setup-service';

export interface CopyPlace {
  readonly kind: CopyKind;
  readonly executable: string;
}

const WINDOWS_PLATFORM = 'win32';
const PORTABLE_EXECUTABLE = 'PORTABLE_EXECUTABLE_FILE';
const FULL_WINDOWS_PATH = /^([A-Za-z]:\\|\\\\)/;

/** Tells whether a value is the full Windows path of a file, from its drive or its network share, of reasonable length and that a command can quote. */
export function isWindowsExecutablePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_FILE_PATH_LENGTH &&
    !value.includes('\0') &&
    !value.includes('"') &&
    FULL_WINDOWS_PATH.test(value)
  );
}

/** Tells which built copy for Windows runs and the executable Windows starts to open its files, the portable one the person keeps rather than its unpacked copy, or returns null for a copy that is not built for Windows. */
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
  if (portable === undefined || portable === '') {
    return { kind: 'installed', executable: executablePath };
  }
  if (!isWindowsExecutablePath(portable)) {
    console.error(
      'The portable executable names itself with a path Tasklace cannot use:',
      portable,
    );
    return null;
  }
  return { kind: 'portable', executable: portable };
}
