import type { TagPattern } from '../tags/tag-appearance';
import type { PageSize } from './paper';
import { pathSegments, type PathSegment, type PrintShape } from './print-document';

export const PATTERN_TILE_SIZE = 8;
export const PATTERN_INK_COLOR = '#000000';
export const PATTERN_INK_OPACITY = 0.35;
export const PATTERN_LINE_WIDTH = 1.5;

export type TileCorner = readonly [number, number];

interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

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

/** Lists the top left corners of the tiles of a pattern that cover a shape within a page, tiles starting at the corner of the page, in time linear in the tiles and the numbers of the shape. */
export function patternTileCorners(shape: PrintShape, page: PageSize): TileCorner[] {
  const box = tiledBox(shape, page);
  const corners: TileCorner[] = [];
  for (let top = box.top; top < box.bottom; top += PATTERN_TILE_SIZE) {
    for (let left = box.left; left < box.right; left += PATTERN_TILE_SIZE) {
      corners.push([left, top]);
    }
  }
  return corners;
}

/** Counts the tiles of a pattern that cover a shape within a page without listing them, in time linear in the numbers of the shape. */
export function patternTileCount(shape: PrintShape, page: PageSize): number {
  const box = tiledBox(shape, page);
  return tileSteps(box.left, box.right) * tileSteps(box.top, box.bottom);
}

/** Returns how many tiles lie from a first tile edge up to an end, at least one before any end however close, none when the end comes first. */
function tileSteps(start: number, end: number): number {
  return end > start ? Math.max(1, Math.ceil((end - start) / PATTERN_TILE_SIZE)) : 0;
}

/** Returns the part of the box of a shape that lies within a page, its left and top moved back to the edges of the tiles, or an empty box when the shape misses the page. */
function tiledBox(shape: PrintShape, page: PageSize): Box {
  const box = boxOf(shape);
  const left = Math.max(box.left, 0);
  const top = Math.max(box.top, 0);
  const right = Math.min(box.right, page.width);
  const bottom = Math.min(box.bottom, page.height);
  if (right <= left || bottom <= top) {
    return { left: 0, top: 0, right: 0, bottom: 0 };
  }
  return {
    left: Math.floor(left / PATTERN_TILE_SIZE) * PATTERN_TILE_SIZE,
    top: Math.floor(top / PATTERN_TILE_SIZE) * PATTERN_TILE_SIZE,
    right,
    bottom,
  };
}

/** Returns the box that holds a shape. */
function boxOf(shape: PrintShape): Box {
  if (shape.kind === 'rect') {
    return {
      left: shape.x,
      top: shape.y,
      right: shape.x + shape.width,
      bottom: shape.y + shape.height,
    };
  }
  let box: Box = {
    left: Number.POSITIVE_INFINITY,
    top: Number.POSITIVE_INFINITY,
    right: Number.NEGATIVE_INFINITY,
    bottom: Number.NEGATIVE_INFINITY,
  };
  for (const segment of pathSegments(shape.segments)) {
    for (const [x, y] of pointsOf(segment)) {
      box = {
        left: Math.min(box.left, x),
        top: Math.min(box.top, y),
        right: Math.max(box.right, x),
        bottom: Math.max(box.bottom, y),
      };
    }
  }
  return box;
}

/** Lists the points of a segment of a path, control points of a curve included, since a curve stays within them. */
function pointsOf(segment: PathSegment): (readonly [number, number])[] {
  if (segment.kind === 'close') {
    return [];
  }
  if (segment.kind === 'curve') {
    return [
      [segment.x1, segment.y1],
      [segment.x2, segment.y2],
      [segment.x, segment.y],
    ];
  }
  return [[segment.x, segment.y]];
}
