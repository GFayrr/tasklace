import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { shapeArbitrary } from '../testing/print-arbitrary';
import { pageSizeOf } from './paper';
import { patternTileCorners, patternTileCount, patternTileOf } from './pattern-tiles';
import { PATH_CLOSE, PATH_CURVE, PATH_MOVE } from './print-document';

const PAGE = pageSizeOf('a4', 'landscape');

/** Builds a rectangle of a given place and size. */
function rect(x: number, y: number, width: number, height: number) {
  return { kind: 'rect', x, y, width, height } as const;
}

describe('the tiles of a pattern', () => {
  it('gives the dot or lines of each tile of a pattern', () => {
    expect(patternTileOf('dots')).toEqual({ kind: 'dot', x: 4, y: 4, radius: 1.2 });
    expect(patternTileOf('crossHatch')).toEqual({
      kind: 'lines',
      lines: [
        [0, 8, 8, 0],
        [0, 0, 8, 8],
      ],
    });
  });

  it('lists the tiles that cover a shape from the corner of the page, row by row', () => {
    expect(patternTileCorners(rect(4, 2, 12, 9), PAGE)).toEqual([
      [0, 0],
      [8, 0],
      [0, 8],
      [8, 8],
    ]);
    expect(patternTileCount(rect(4, 2, 12, 9), PAGE)).toBe(4);
  });

  it('counts the control points of a curve in the box of a path', () => {
    const curve = {
      kind: 'path',
      segments: [PATH_MOVE, 0, 0, PATH_CURVE, 0, 20, 4, 20, 4, 0, PATH_CLOSE],
    } as const;
    expect(patternTileCorners(curve, PAGE)).toEqual([
      [0, 0],
      [0, 8],
      [0, 16],
    ]);
  });

  it('keeps to the page, giving no tile to a shape that misses it, even past a page edge that is no tile edge', () => {
    expect(patternTileCount(rect(-100, -100, 108, 104), PAGE)).toBe(1);
    expect(patternTileCount(rect(842, 0, 100, 8), PAGE)).toBe(0);
    expect(patternTileCorners(rect(842, 0, 100, 8), PAGE)).toEqual([]);
    expect(patternTileCount(rect(0, 596, 8, 100), PAGE)).toBe(0);
    expect(patternTileCount(rect(836, 590, 100, 100), PAGE)).toBe(4);
    expect(patternTileCount(rect(10, 10, 0, 8), PAGE)).toBe(0);
    expect(patternTileCount(rect(0, 0, Number.MIN_VALUE, Number.MIN_VALUE), PAGE)).toBe(1);
    expect(patternTileCorners(rect(0, 0, Number.MIN_VALUE, Number.MIN_VALUE), PAGE)).toEqual([
      [0, 0],
    ]);
  });

  it('counts as many tiles as it lists for any shape', () => {
    fc.assert(
      fc.property(shapeArbitrary, (shape) => {
        expect(patternTileCount(shape, PAGE)).toBe(patternTileCorners(shape, PAGE).length);
      }),
    );
  });
});
