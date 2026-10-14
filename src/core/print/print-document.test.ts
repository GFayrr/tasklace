import { describe, expect, it } from 'vitest';
import {
  PATH_CLOSE,
  PATH_CURVE,
  PATH_LINE,
  PATH_MOVE,
  coordinatesAfter,
  pathSegments,
  printCostOf,
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

describe('printCostOf', () => {
  it('counts the orders inside clips and the numbers of every path, rectangles and texts adding none', () => {
    const rect = { kind: 'rect', x: 0, y: 0, width: 1, height: 1 } as const;
    const path = {
      kind: 'path',
      segments: [PATH_MOVE, 0, 0, PATH_LINE, 1, 1, PATH_CLOSE],
    } as const;
    const text = {
      kind: 'text',
      x: 0,
      y: 0,
      text: 'Plan',
      size: 10,
      weight: 400,
      color: '#000000',
      align: 'start',
    } as const;
    const fill = { kind: 'fill', shape: path, color: '#000000', opacity: 1 } as const;
    expect(
      printCostOf([
        fill,
        text,
        { kind: 'pattern', shape: rect, pattern: 'dots' },
        {
          kind: 'clip',
          shape: path,
          orders: [fill, { kind: 'clip', shape: rect, orders: [fill] }],
        },
      ]),
    ).toEqual({ orders: 7, pathNumbers: 7 * 4 });
    expect(printCostOf([])).toEqual({ orders: 0, pathNumbers: 0 });
  });
});
