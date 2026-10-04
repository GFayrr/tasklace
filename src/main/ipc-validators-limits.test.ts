import { describe, expect, it, vi } from 'vitest';
import { readExportText, readProjectState } from './ipc-validators';

vi.mock('../core/limits', async (importOriginal) => {
  const original = await importOriginal<typeof import('../core/limits')>();
  return {
    ...original,
    MAX_UNCOMPRESSED_BYTES: 3,
    MAX_PROJECT_TEXT_UTF16_UNITS: 4,
    MAX_CSV_TEXT_UTF16_UNITS: 2,
  };
});

describe('bridge message validators at their limits', () => {
  it('accepts a state up to the uncompressed size limit and refuses one byte more', () => {
    const largest = Uint8Array.from([1, 2, 3]);
    expect(readProjectState(largest)).toBe(largest);
    expect(readProjectState(Uint8Array.from([1, 2, 3, 4]))).toBeNull();
  });

  it('holds a JSON export to the project text limit and a CSV export to the table limit', () => {
    expect(readExportText('abcd', 'json')).toBe('abcd');
    expect(readExportText('abcde', 'json')).toBeNull();
    expect(readExportText('ab', 'csv')).toBe('ab');
    expect(readExportText('abc', 'csv')).toBeNull();
  });
});
