import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_FILE_PATH_LENGTH } from '../../core/limits';
import { copyPlaceOf, isWindowsExecutablePath } from './this-copy';

const INSTALLED = 'C:\\Users\\Lea\\AppData\\Local\\Programs\\Tasklace\\Tasklace.exe';
const PORTABLE = 'C:\\Users\\Lea\\Downloads\\Tasklace-0.1.0-portable.exe';
const UNPACKED = 'C:\\Users\\Lea\\AppData\\Local\\Temp\\2Abc\\Tasklace.exe';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('copyPlaceOf', () => {
  it('opens files only in a built copy for Windows', () => {
    expect(copyPlaceOf('linux', true, '/opt/Tasklace/tasklace', {})).toBeNull();
    expect(copyPlaceOf('win32', false, INSTALLED, {})).toBeNull();
  });

  it('opens files with the installed executable, or with the portable executable the person keeps rather than its unpacked copy', () => {
    expect(copyPlaceOf('win32', true, INSTALLED, {})).toEqual({
      kind: 'installed',
      executable: INSTALLED,
    });
    expect(copyPlaceOf('win32', true, INSTALLED, { PORTABLE_EXECUTABLE_FILE: '' })).toEqual({
      kind: 'installed',
      executable: INSTALLED,
    });
    expect(copyPlaceOf('win32', true, UNPACKED, { PORTABLE_EXECUTABLE_FILE: PORTABLE })).toEqual({
      kind: 'portable',
      executable: PORTABLE,
    });
  });

  it('refuses and logs a portable or installed executable named by a path it cannot use in a command or a registry file', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const paths = ['Tasklace.exe', 'C:\\Users\\"Lea"\\Tasklace.exe', 'C:\\Lea\r\n[HKEY]\\T.exe'];
    for (const path of paths) {
      expect(copyPlaceOf('win32', true, UNPACKED, { PORTABLE_EXECUTABLE_FILE: path })).toBeNull();
    }
    expect(copyPlaceOf('win32', true, 'C:\\Lea\n\\T.exe', {})).toBeNull();
    expect(error.mock.calls).toEqual([
      ...paths.map((path) => ['The portable executable has a path Tasklace cannot use:', path]),
      ['The installed executable has a path Tasklace cannot use:', 'C:\\Lea\n\\T.exe'],
    ]);
  });
});

describe('isWindowsExecutablePath', () => {
  it('accepts a full path from a drive or a network share, and nothing a command or a registry file could not hold', () => {
    expect(
      [
        PORTABLE,
        'd:\\Tasklace.exe',
        '\\\\school\\apps\\Tasklace.exe',
        `C:\\${'a'.repeat(MAX_FILE_PATH_LENGTH - 3)}`,
        `C:\\${'a'.repeat(MAX_FILE_PATH_LENGTH - 2)}`,
        '\\Tasklace.exe',
        '/opt/Tasklace/tasklace',
        'C:Tasklace.exe',
        'C:\\Lea\0.exe',
        'C:\\Lea\t.exe',
        'C:\\Lea\u007f.exe',
        7,
      ].map(isWindowsExecutablePath),
    ).toEqual([true, true, true, true, false, false, false, false, false, false, false, false]);
  });
});
