import type { TagPattern } from '../tags/tag-appearance';

export const PATTERN_TILE_SIZE = 8;
export const PATTERN_INK_COLOR = '#000000';
export const PATTERN_INK_OPACITY = 0.35;
export const PATTERN_LINE_WIDTH = 1.5;

export type PatternTile =
  | { readonly kind: 'dot'; readonly x: number; readonly y: number; readonly radius: number }
  | {
      readonly kind: 'lines';
      readonly lines: readonly (readonly [number, number, number, number])[];
    };

const DOT_RADIUS = 1.2;
const SIZE = PATTERN_TILE_SIZE;
const HALF = 2;
const MIDDLE = PATTERN_TILE_SIZE / HALF;
const RISING = [0, SIZE, SIZE, 0] as const;
const FALLING = [0, 0, SIZE, SIZE] as const;

const TILES: Readonly<Record<TagPattern, PatternTile>> = {
  dots: { kind: 'dot', x: MIDDLE, y: MIDDLE, radius: DOT_RADIUS },
  diagonal: { kind: 'lines', lines: [RISING] },
  reverseDiagonal: { kind: 'lines', lines: [FALLING] },
  crossHatch: { kind: 'lines', lines: [RISING, FALLING] },
  horizontal: { kind: 'lines', lines: [[0, MIDDLE, SIZE, MIDDLE]] },
  vertical: { kind: 'lines', lines: [[MIDDLE, 0, MIDDLE, SIZE]] },
};

/** Returns what one square tile of a tag pattern holds, a dot or lines from start to end point, so that the screen and the printed page draw the same pattern. */
export function patternTileOf(pattern: TagPattern): PatternTile {
  return TILES[pattern];
}
