import { describe, expect, it } from 'vitest';
import { CSV_COLUMN_ORDER, CSV_HEADERS, readHeader } from './csv-columns';

const LONGEST_HEADER = 64;
const QUICK_MILLISECONDS = 50;

describe('readHeader', () => {
  it.each(CSV_COLUMN_ORDER)('recognizes the exported header of the %s column', (column) => {
    expect(readHeader(CSV_HEADERS[column])).toEqual({ kind: 'column', column });
  });

  it.each([
    ['  name  ', 'name'],
    ['DURATION', 'duration'],
    ['Duration (hours)', 'duration'],
    ['Duration(H)', 'duration'],
    ['Progress ( % )', 'progress'],
    ['Name (task)', 'name'],
  ] as const)('recognizes %j as the %s column', (header, column) => {
    expect(readHeader(header)).toEqual({ kind: 'column', column });
  });

  it.each([
    ['Duration (days)', 'duration'],
    ['Duration (min)', 'duration'],
    ['Progress (ratio)', 'progress'],
  ] as const)('refuses %j, whose unit the %s column does not count in', (header, column) => {
    expect(readHeader(header)).toEqual({ kind: 'unsupportedUnit', column });
  });

  it.each(['Owner', '', 'Name (a) (b)', 'Name )', 'Duration (h'])('does not know %j', (header) => {
    expect(readHeader(header)).toEqual({ kind: 'unknown' });
  });

  it('reads a header of the longest allowed length and leaves a longer one unread', () => {
    expect(readHeader('Name'.padEnd(LONGEST_HEADER, ' '))).toEqual({
      kind: 'column',
      column: 'name',
    });
    expect(readHeader('Name'.padEnd(LONGEST_HEADER + 1, ' '))).toEqual({ kind: 'unknown' });
  });

  it('leaves a huge header unread at once instead of running a pattern over it', () => {
    const start = performance.now();
    expect(readHeader('('.repeat(1_000_000))).toEqual({ kind: 'unknown' });
    expect(readHeader(`${' '.repeat(1_000_000)}x`)).toEqual({ kind: 'unknown' });
    expect(performance.now() - start).toBeLessThan(QUICK_MILLISECONDS);
  });
});
