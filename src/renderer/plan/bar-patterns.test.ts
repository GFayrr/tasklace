import { describe, expect, it, vi } from 'vitest';
import type { TagPattern } from '../../core/tags/tag-appearance';
import { createPatternCache, drawPatternTile, PATTERN_TILE_SIZE } from './bar-patterns';
import { callsOf, recordingCanvas } from './testing/recording-canvas';

const SIZE = PATTERN_TILE_SIZE;
const MIDDLE = SIZE / 2;

/** Draws one tile of a pattern and returns the lines it traced, as start and end points. */
function linesOf(pattern: TagPattern): number[][] {
  const { context, calls } = recordingCanvas();
  drawPatternTile(context, pattern);
  const moves = callsOf(calls, 'moveTo');
  const lines = callsOf(calls, 'lineTo');
  return moves.map((move, index) => [
    ...(move.args as number[]),
    ...((lines[index]?.args ?? []) as number[]),
  ]);
}

describe('drawPatternTile', () => {
  it.each([
    ['diagonal', [[0, SIZE, SIZE, 0]]],
    ['reverseDiagonal', [[0, 0, SIZE, SIZE]]],
    [
      'crossHatch',
      [
        [0, SIZE, SIZE, 0],
        [0, 0, SIZE, SIZE],
      ],
    ],
    ['horizontal', [[0, MIDDLE, SIZE, MIDDLE]]],
    ['vertical', [[MIDDLE, 0, MIDDLE, SIZE]]],
  ] as const)('traces the lines of the %s pattern on a cleared tile', (pattern, lines) => {
    expect(linesOf(pattern)).toEqual(lines);
  });

  it('draws the dots pattern as a filled dot in the middle of the tile', () => {
    const { context, calls } = recordingCanvas();
    drawPatternTile(context, 'dots');
    expect(callsOf(calls, 'clearRect')[0]?.args).toEqual([0, 0, SIZE, SIZE]);
    expect(callsOf(calls, 'arc')[0]?.args.slice(0, 2)).toEqual([MIDDLE, MIDDLE]);
    expect(callsOf(calls, 'fill')).toHaveLength(1);
    expect(callsOf(calls, 'stroke')).toEqual([]);
  });
});

describe('createPatternCache', () => {
  /** Builds a tile whose drawing context can be withheld. */
  function tileFactory(withContext: boolean) {
    const tiles: { width: number; height: number }[] = [];
    /** Creates a pattern tile whose drawing context the test can refuse. */
    const create = () => {
      const { context } = recordingCanvas();
      const tile = { width: 0, height: 0, getContext: () => (withContext ? context : null) };
      tiles.push(tile);
      return tile as unknown as HTMLCanvasElement;
    };
    return { create, tiles };
  }

  it('draws each pattern once on a tile of the pattern size and reuses it', () => {
    const { create, tiles } = tileFactory(true);
    const made: unknown[] = [];
    const target = {
      createPattern: () => {
        const pattern = { id: made.length };
        made.push(pattern);
        return pattern;
      },
    };
    const failed = vi.fn();
    const patternFor = createPatternCache(
      create,
      () => target as unknown as CanvasRenderingContext2D,
      failed,
    );
    const first = patternFor('dots');
    expect(patternFor('dots')).toBe(first);
    expect(patternFor('vertical')).not.toBe(first);
    expect(tiles).toEqual([
      expect.objectContaining({ width: SIZE, height: SIZE }),
      expect.objectContaining({ width: SIZE, height: SIZE }),
    ]);
    expect(failed).not.toHaveBeenCalled();
  });

  it('gives no pattern without a drawing context or a canvas to use it on, telling so and trying again later', () => {
    const failed = vi.fn();
    expect(createPatternCache(tileFactory(false).create, () => null, failed)('dots')).toBeNull();
    expect(failed).toHaveBeenCalledTimes(1);
    const { create, tiles } = tileFactory(true);
    let target: { createPattern: () => object | null } | null = null;
    const patternFor = createPatternCache(
      create,
      () => target as unknown as CanvasRenderingContext2D,
      failed,
    );
    expect(patternFor('dots')).toBeNull();
    target = { createPattern: () => null };
    expect(patternFor('dots')).toBeNull();
    expect(failed).toHaveBeenCalledTimes(3);
    target = { createPattern: () => ({ id: 'late' }) };
    expect(patternFor('dots')).toEqual({ id: 'late' });
    expect(tiles).toHaveLength(3);
  });
});
