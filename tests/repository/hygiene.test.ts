import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const MAX_TEST_FILE_BYTES = 50 * 1024;
const BINARY_PROBE_BYTES = 8_000;
const NULL_BYTE = 0;

/** Lists the existing files of a folder that Git tracks or is about to track. */
function trackedFiles(folder: string): string[] {
  const output = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', folder],
    { encoding: 'utf8' },
  );
  return output.split('\0').filter((path) => path.length > 0 && existsSync(path));
}

/** Tells whether a file looks binary, that is whether its beginning contains a null byte. */
function looksBinary(path: string): boolean {
  const buffer = Buffer.alloc(BINARY_PROBE_BYTES);
  const descriptor = openSync(path, 'r');
  try {
    const bytesRead = readSync(descriptor, buffer, 0, BINARY_PROBE_BYTES, 0);
    return buffer.subarray(0, bytesRead).includes(NULL_BYTE);
  } finally {
    closeSync(descriptor);
  }
}

describe('repository hygiene', () => {
  const files = trackedFiles('tests');

  it('finds the test files', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('keeps every file under tests/ small: large fixtures must be generated with a fixed seed', () => {
    const oversized = files.filter((path) => statSync(path).size > MAX_TEST_FILE_BYTES);
    expect(oversized).toEqual([]);
  });

  it('keeps every file under tests/ as text: binary fixtures must be generated in memory', () => {
    expect(files.filter(looksBinary)).toEqual([]);
  });
});
