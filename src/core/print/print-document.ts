import type { TagPattern } from '../tags/tag-appearance';
import type { PaperName, PaperOrientation } from './paper';

export const PATH_MOVE = 0;
export const PATH_LINE = 1;
export const PATH_CURVE = 2;
export const PATH_CLOSE = 3;

export const MIN_TEXT_POINTS = 10;
export const MAX_TEXT_POINTS = 32;
export const MAX_STROKE_WIDTH = 64;
export const MAX_DASH_STEP = 256;

export type TextAlign = 'start' | 'middle' | 'end';

const REGULAR_WEIGHT = 400;
const MEDIUM_WEIGHT = 500;
const SEMIBOLD_WEIGHT = 600;

export type TextWeight = typeof REGULAR_WEIGHT | typeof MEDIUM_WEIGHT | typeof SEMIBOLD_WEIGHT;

export const TEXT_ALIGNS: readonly TextAlign[] = ['start', 'middle', 'end'];

export const TEXT_WEIGHTS: readonly TextWeight[] = [REGULAR_WEIGHT, MEDIUM_WEIGHT, SEMIBOLD_WEIGHT];

export interface RectShape {
  readonly kind: 'rect';
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PathShape {
  readonly kind: 'path';
  readonly segments: readonly number[];
}

export type PrintShape = RectShape | PathShape;

export interface FillOrder {
  readonly kind: 'fill';
  readonly shape: PrintShape;
  readonly color: string;
  readonly opacity: number;
}

export interface StrokeOrder {
  readonly kind: 'stroke';
  readonly shape: PrintShape;
  readonly color: string;
  readonly opacity: number;
  readonly width: number;
  readonly dash: readonly number[];
}

export interface PatternOrder {
  readonly kind: 'pattern';
  readonly shape: PrintShape;
  readonly pattern: TagPattern;
}

export interface TextOrder {
  readonly kind: 'text';
  readonly x: number;
  readonly y: number;
  readonly text: string;
  readonly size: number;
  readonly weight: TextWeight;
  readonly color: string;
  readonly align: TextAlign;
}

export type DrawOrder = FillOrder | StrokeOrder | PatternOrder | TextOrder;

export interface ClipOrder {
  readonly kind: 'clip';
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly orders: readonly DrawOrder[];
}

export type PrintOrder = DrawOrder | ClipOrder;

export interface PrintDocument {
  readonly paper: PaperName;
  readonly orientation: PaperOrientation;
  readonly title: string;
  readonly pages: readonly (readonly PrintOrder[])[];
}

export type PathSegment =
  | { readonly kind: 'move' | 'line'; readonly x: number; readonly y: number }
  | {
      readonly kind: 'curve';
      readonly x1: number;
      readonly y1: number;
      readonly x2: number;
      readonly y2: number;
      readonly x: number;
      readonly y: number;
    }
  | { readonly kind: 'close' };

const POINT_COORDINATES = 2;
const CURVE_COORDINATES = 6;
const COORDINATES_OF_OPERATION: readonly number[] = [
  POINT_COORDINATES,
  POINT_COORDINATES,
  CURVE_COORDINATES,
  0,
];

/** Returns how many coordinates follow a path operation, or null for a number that is no operation. */
export function coordinatesAfter(operation: number): number | null {
  return Number.isInteger(operation) ? (COORDINATES_OF_OPERATION[operation] ?? null) : null;
}

/** Reads the flat numbers of a path, each operation followed by its coordinates, as a list of segments, throwing on numbers that a validated path never holds. */
export function pathSegments(segments: readonly number[]): PathSegment[] {
  const read: PathSegment[] = [];
  let index = 0;
  while (index < segments.length) {
    const operation = segments[index] ?? Number.NaN;
    const count = coordinatesAfter(operation);
    if (count === null || index + count >= segments.length) {
      throw new RangeError(`Invalid path operation at ${String(index)}.`);
    }
    read.push(segmentAt(segments, index + 1, operation));
    index += count + 1;
  }
  return read;
}

/** Builds the segment of a known path operation from the coordinates that start at an index. */
function segmentAt(segments: readonly number[], start: number, operation: number): PathSegment {
  if (operation === PATH_CLOSE) {
    return { kind: 'close' };
  }
  const [
    x1 = Number.NaN,
    y1 = Number.NaN,
    x2 = Number.NaN,
    y2 = Number.NaN,
    x = Number.NaN,
    y = Number.NaN,
  ] = segments.slice(start, start + CURVE_COORDINATES);
  if (operation === PATH_CURVE) {
    return { kind: 'curve', x1, y1, x2, y2, x, y };
  }
  return { kind: operation === PATH_MOVE ? 'move' : 'line', x: x1, y: y1 };
}
