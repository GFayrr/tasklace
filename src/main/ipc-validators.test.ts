import { describe, expect, it } from 'vitest';
import { MAX_CSV_TEXT_UTF16_UNITS, MAX_RECENT_PROJECTS } from '../core/limits';
import {
  readExchangeKind,
  readExportText,
  readProjectState,
  readRecentIndex,
} from './ipc-validators';

describe('bridge message validators', () => {
  it('accepts a non-empty state within the limit only', () => {
    const state = Uint8Array.from([1]);
    expect(readProjectState(state)).toBe(state);
    for (const value of [new Uint8Array(0), [1], 'x', null, new ArrayBuffer(1), { length: 1 }]) {
      expect(readProjectState(value)).toBeNull();
    }
  });

  it('accepts only the known exchange kinds', () => {
    expect(readExchangeKind('json')).toBe('json');
    expect(readExchangeKind('csv')).toBe('csv');
    for (const value of ['JSON', 'tasklace', '', null, 1, ['csv']]) {
      expect(readExchangeKind(value)).toBeNull();
    }
  });

  it('accepts export texts within the import limit of their kind', () => {
    expect(readExportText('a', 'csv')).toBe('a');
    expect(readExportText(1, 'json')).toBeNull();
    expect(readExportText(' '.repeat(MAX_CSV_TEXT_UTF16_UNITS), 'csv')).not.toBeNull();
    expect(readExportText(' '.repeat(MAX_CSV_TEXT_UTF16_UNITS + 1), 'csv')).toBeNull();
  });

  it('accepts only the positions of the recent list', () => {
    expect(readRecentIndex(0)).toBe(0);
    expect(readRecentIndex(MAX_RECENT_PROJECTS - 1)).toBe(MAX_RECENT_PROJECTS - 1);
    for (const value of [-1, MAX_RECENT_PROJECTS, 0.5, '0', null, Number.NaN]) {
      expect(readRecentIndex(value)).toBeNull();
    }
  });
});
