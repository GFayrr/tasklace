import { describe, expect, it, vi } from 'vitest';
import { MAX_PRINT_PATH_NUMBERS } from '../limits';
import { PATH_CLOSE, PATH_LINE, PATH_MOVE } from './print-document';
import { readPrintDocument } from './read-print-document';

vi.mock('../limits', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../limits')>()),
  MAX_PRINT_DOCUMENT_PATH_NUMBERS: 2_048,
  MAX_PRINT_PATTERN_TILES: 4,
}));

const LONGEST_PATH = [
  PATH_MOVE,
  0,
  0,
  ...Array.from({ length: (MAX_PRINT_PATH_NUMBERS - 4) / 3 }, () => [PATH_LINE, 1, 1]).flat(),
  PATH_CLOSE,
];
const STROKE = {
  kind: 'stroke',
  shape: { kind: 'path', segments: LONGEST_PATH },
  color: '#1c1b19',
  opacity: 1,
  width: 1,
  dash: [],
};
const CLIP = { kind: 'clip', shape: { kind: 'path', segments: [PATH_MOVE, 0, 0] }, orders: [] };

/** Builds an order that covers a rectangle with dots. */
function dots(x: number, width: number) {
  return { kind: 'pattern', shape: { kind: 'rect', x, y: 0, width, height: 8 }, pattern: 'dots' };
}

/** Reads a document of pages holding the given orders and returns the issues it raised, or an empty list when it was accepted. */
function issuesOf(...pages: unknown[][]) {
  const result = readPrintDocument({ paper: 'a4', orientation: 'landscape', title: 'T', pages });
  return result.ok ? [] : result.error;
}

describe('the numbers of paths a printed document may hold', () => {
  it('accepts paths of every page holding exactly as many numbers as a document allows', () => {
    expect(LONGEST_PATH).toHaveLength(MAX_PRINT_PATH_NUMBERS);
    expect(issuesOf([STROKE], [STROKE])).toEqual([]);
  });

  it('counts the path of a clip too, refusing the path that goes beyond the limit by its place', () => {
    expect(issuesOf([STROKE], [CLIP, STROKE])).toEqual([
      { path: 'pages[1][1].shape.segments', code: 'TOO_MANY_ITEMS' },
    ]);
    expect(issuesOf([STROKE], [{ ...CLIP, orders: [STROKE] }])).toEqual([
      { path: 'pages[1][0].orders[0].shape.segments', code: 'TOO_MANY_ITEMS' },
    ]);
  });
});

describe('the pattern tiles a printed document may need', () => {
  it('accepts patterns needing exactly as many tiles as a document allows, over all its pages', () => {
    expect(issuesOf([dots(0, 16)], [dots(0, 16)])).toEqual([]);
  });

  it('refuses the pattern that needs one tile more than the limit, by its place', () => {
    expect(issuesOf([dots(0, 16)], [dots(0, 16), dots(100, 1)])).toEqual([
      { path: 'pages[1][1].shape', code: 'TOO_MANY_ITEMS' },
    ]);
  });

  it('counts only the tiles within the page, from its corner', () => {
    expect(issuesOf([dots(-100, 116), dots(4, 8)], [dots(20_000, 12_000), dots(842, 100)])).toEqual(
      [],
    );
    expect(issuesOf([dots(4, 9)], [dots(4, 9)], [dots(4, 9)])).toEqual([
      { path: 'pages[2][0].shape', code: 'TOO_MANY_ITEMS' },
    ]);
  });

  it('counts no tile on an unknown paper, which is refused anyway', () => {
    const pages = [[dots(0, 800)]];
    expect(readPrintDocument({ paper: 'b5', orientation: 'landscape', title: 'T', pages })).toEqual(
      {
        ok: false,
        error: [{ path: 'paper', code: 'OUT_OF_RANGE' }],
      },
    );
  });
});
