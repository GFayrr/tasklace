import { describe, expect, it } from 'vitest';
import {
  PATH_CLOSE,
  PATH_CURVE,
  PATH_LINE,
  PATH_MOVE,
  coordinatesAfter,
  pathSegments,
} from './print-document';

describe('coordinatesAfter', () => {
  it.each([
    [PATH_MOVE, 2],
    [PATH_LINE, 2],
    [PATH_CURVE, 6],
    [PATH_CLOSE, 0],
    [4, null],
    [-1, null],
    [0.5, null],
    [Number.NaN, null],
  ])('gives operation %d %s coordinates', (operation, count) => {
    expect(coordinatesAfter(operation)).toBe(count);
  });
});

describe('pathSegments', () => {
  it('reads every operation with its coordinates', () => {
    expect(
      pathSegments([PATH_MOVE, 1, 2, PATH_LINE, 3, 4, PATH_CURVE, 5, 6, 7, 8, 9, 10, PATH_CLOSE]),
    ).toEqual([
      { kind: 'move', x: 1, y: 2 },
      { kind: 'line', x: 3, y: 4 },
      { kind: 'curve', x1: 5, y1: 6, x2: 7, y2: 8, x: 9, y: 10 },
      { kind: 'close' },
    ]);
  });

  it('reads no segment from no number', () => {
    expect(pathSegments([])).toEqual([]);
  });

  it.each([
    ['an unknown operation', [PATH_MOVE, 0, 0, 9], 3],
    ['a cut operation', [PATH_MOVE, 0, 0, PATH_LINE, 1], 3],
    ['a cut first operation', [PATH_MOVE], 0],
  ])('throws on %s, which a validated path never holds', (_name, segments, index) => {
    expect(() => pathSegments(segments)).toThrow(`Invalid path operation at ${String(index)}.`);
  });
});
