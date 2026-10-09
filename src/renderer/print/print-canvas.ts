import {
  PATH_CLOSE,
  PATH_CURVE,
  PATH_LINE,
  PATH_MOVE,
  coordinatesAfter,
  type ClipOrder,
  type PrintOrder,
  type PrintShape,
} from '../../core/print/print-document';
import { valueAt } from '../../core/table-value';
import type { TagPattern } from '../../core/tags/tag-appearance';

export interface PrintBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

type Paint =
  | { readonly kind: 'color'; readonly color: string; readonly opacity: number }
  | { readonly kind: 'pattern'; readonly pattern: TagPattern };

interface DrawingState {
  fill: Paint;
  stroke: Paint;
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: number;
  dash: readonly number[];
  scaleX: number;
  scaleY: number;
  shiftX: number;
  shiftY: number;
  clipDepth: number;
  hidden: boolean;
}

interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

const BLACK: Paint = { kind: 'color', color: '#000000', opacity: 1 };
const HEX_COLOR = /^#([0-9a-f]{6})$/i;
const RGB_COLOR =
  /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(\d*\.?\d+)\s*)?\)$/i;
const HEX_RADIX = 16;
const CHANNEL_DIGITS = 2;
const CHANNEL_MAXIMUM = 255;
const BLEED = 8;
const QUARTER_TURN = Math.PI / 2;
const FULL_TURN = Math.PI * 2;
const ARC_CONTROL_FACTOR = 4 / 3;
const QUARTER = 4;
const HALF = 2;
const SAME_POINT = 0.01;
const patterns = new WeakMap<object, TagPattern>();
const RECORDED_COORDINATES = [PATH_MOVE, PATH_LINE, PATH_CURVE, PATH_CLOSE].map(
  (operation) => coordinatesAfter(operation) ?? 0,
);

/** Returns a stand-in for the canvas pattern of a tag pattern, which a print canvas turns into a pattern order. */
export function printPattern(pattern: TagPattern): CanvasPattern {
  const token = Object.freeze({});
  patterns.set(token, pattern);
  return token as CanvasPattern;
}

/** A drawing context that records what the timeline draws as print orders in points, dropping what falls outside the printed area and refusing any drawing call it does not know. */
export class PrintCanvas {
  readonly #lists: PrintOrder[][] = [[]];
  readonly #saved: DrawingState[] = [];
  readonly #box: Box;
  #path: number[] = [];
  #pathBox: Box | null = null;
  #state: DrawingState = {
    fill: BLACK,
    stroke: BLACK,
    fillStyle: '#000000',
    strokeStyle: '#000000',
    lineWidth: 1,
    dash: [],
    scaleX: 1,
    scaleY: 1,
    shiftX: 0,
    shiftY: 0,
    clipDepth: 0,
    hidden: false,
  };

  /** Prepares a canvas whose drawings are kept only where they reach the printed area, a little bleed included. */
  constructor(area: PrintBounds) {
    this.#box = {
      left: area.x - BLEED,
      top: area.y - BLEED,
      right: area.x + area.width + BLEED,
      bottom: area.y + area.height + BLEED,
    };
    Object.preventExtensions(this);
  }

  /** Returns this canvas as the drawing context the timeline painter expects. */
  get context(): CanvasRenderingContext2D {
    return this as unknown as CanvasRenderingContext2D;
  }

  /** Returns the orders recorded so far, clips left open being closed. */
  orders(): PrintOrder[] {
    this.#closeClips(0);
    return valueAt(this.#lists, 0);
  }

  /** Returns the fill style last set. */
  get fillStyle(): unknown {
    return this.#state.fillStyle;
  }

  /** Sets the paint of the next fills, a color or a tag pattern. */
  set fillStyle(value: unknown) {
    this.#state.fill = paintOf(value);
    this.#state.fillStyle = value;
  }

  /** Returns the stroke style last set. */
  get strokeStyle(): unknown {
    return this.#state.strokeStyle;
  }

  /** Sets the color of the next strokes, refusing a pattern. */
  set strokeStyle(value: unknown) {
    const paint = paintOf(value);
    if (paint.kind === 'pattern') {
      throw new TypeError('A printed line cannot be drawn with a pattern.');
    }
    this.#state.stroke = paint;
    this.#state.strokeStyle = value;
  }

  /** Returns the width of the next strokes, before scaling. */
  get lineWidth(): number {
    return this.#state.lineWidth;
  }

  /** Sets the width of the next strokes, before scaling. */
  set lineWidth(value: number) {
    this.#state.lineWidth = value;
  }

  /** Keeps the drawing state, restored by the next restore. */
  save(): void {
    this.#saved.push({ ...this.#state });
  }

  /** Brings back the last kept drawing state, ending the clips set since. */
  restore(): void {
    const saved = this.#saved.pop();
    if (saved === undefined) {
      return;
    }
    this.#closeClips(saved.clipDepth);
    this.#state = saved;
  }

  /** Moves the origin of the next drawings. */
  translate(x: number, y: number): void {
    this.#state.shiftX += this.#state.scaleX * x;
    this.#state.shiftY += this.#state.scaleY * y;
  }

  /** Scales the next drawings, lines and dashes included. */
  scale(x: number, y: number): void {
    this.#state.scaleX *= x;
    this.#state.scaleY *= y;
  }

  /** Sets the dash of the next strokes, before scaling. */
  setLineDash(dash: readonly number[]): void {
    this.#state.dash = [...dash];
  }

  /** Starts a new path. */
  beginPath(): void {
    this.#path = [];
    this.#pathBox = null;
  }

  /** Starts a new part of the path at a point. */
  moveTo(x: number, y: number): void {
    this.#addPoints(PATH_MOVE, [x, y]);
  }

  /** Adds a straight line to a point. */
  lineTo(x: number, y: number): void {
    this.#ensureStart(x, y);
    this.#addPoints(PATH_LINE, [x, y]);
  }

  /** Closes the current part of the path. */
  closePath(): void {
    if (this.#path.length > 0) {
      this.#path.push(PATH_CLOSE);
    }
  }

  /** Adds a clockwise arc of a circle, drawn as curves of at most a quarter turn each. */
  arc(x: number, y: number, radius: number, start: number, end: number): void {
    const sweep = Math.min(end - start, FULL_TURN);
    const pieces = Math.max(1, Math.ceil(sweep / QUARTER_TURN));
    const step = sweep / pieces;
    /** Returns the point of the circle at an angle. */
    const pointAt = (angle: number) => [x + radius * Math.cos(angle), y + radius * Math.sin(angle)];
    const [startX = x, startY = y] = pointAt(start);
    if (this.#path.length === 0) {
      this.moveTo(startX, startY);
    } else if (!this.#endsAt(startX, startY)) {
      this.lineTo(startX, startY);
    }
    const control = ARC_CONTROL_FACTOR * Math.tan(step / QUARTER) * radius;
    for (let piece = 0; piece < pieces; piece += 1) {
      const from = start + piece * step;
      const to = from + step;
      this.#addPoints(PATH_CURVE, [
        x + radius * Math.cos(from) - control * Math.sin(from),
        y + radius * Math.sin(from) + control * Math.cos(from),
        x + radius * Math.cos(to) + control * Math.sin(to),
        y + radius * Math.sin(to) - control * Math.cos(to),
        x + radius * Math.cos(to),
        y + radius * Math.sin(to),
      ]);
    }
  }

  /** Adds a rectangle with corners rounded by one radius, as a closed part of the path. */
  roundRect(x: number, y: number, width: number, height: number, radius: number): void {
    const corner = Math.max(0, Math.min(radius, Math.abs(width) / HALF, Math.abs(height) / HALF));
    const right = x + width;
    const bottom = y + height;
    this.moveTo(x + corner, y);
    this.lineTo(right - corner, y);
    this.#corner(right - corner, y + corner, corner, -QUARTER_TURN);
    this.lineTo(right, bottom - corner);
    this.#corner(right - corner, bottom - corner, corner, 0);
    this.lineTo(x + corner, bottom);
    this.#corner(x + corner, bottom - corner, corner, QUARTER_TURN);
    this.lineTo(x, y + corner);
    this.#corner(x + corner, y + corner, corner, Math.PI);
    this.closePath();
  }

  /** Fills the current path with the fill paint. */
  fill(): void {
    this.#paint(this.#pathShape(), this.#state.fill, null);
  }

  /** Strokes the current path with the stroke color, width and dash. */
  stroke(): void {
    this.#paint(this.#pathShape(), this.#state.stroke, this.#strokeLook());
  }

  /** Fills a rectangle with the fill paint. */
  fillRect(x: number, y: number, width: number, height: number): void {
    this.#paint(this.#rectShape(x, y, width, height), this.#state.fill, null);
  }

  /** Strokes the outline of a rectangle with the stroke color, width and dash. */
  strokeRect(x: number, y: number, width: number, height: number): void {
    this.#paint(this.#rectShape(x, y, width, height), this.#state.stroke, this.#strokeLook());
  }

  /** Keeps the next drawings inside the current path until the state is restored, hiding them when the path lies outside the printed area. */
  clip(): void {
    const shape = this.#pathShape();
    if (shape === null || this.#state.hidden) {
      this.#state.hidden = true;
      return;
    }
    const clip: ClipOrder = { kind: 'clip', shape, orders: [] };
    this.#current().push(clip);
    this.#lists.push(clip.orders as PrintOrder[]);
    this.#state.clipDepth += 1;
  }

  /** Adds a quarter of a circle around a center, starting at an angle. */
  #corner(centerX: number, centerY: number, radius: number, start: number): void {
    if (radius > 0) {
      this.arc(centerX, centerY, radius, start, start + QUARTER_TURN);
    }
  }

  /** Tells whether the path ends at a point given before placing on the page, within a hundredth of a point. */
  #endsAt(x: number, y: number): boolean {
    const pageX = this.#state.shiftX + this.#state.scaleX * x;
    const pageY = this.#state.shiftY + this.#state.scaleY * y;
    const lastX = valueAt(this.#path, this.#path.length - HALF);
    const lastY = valueAt(this.#path, this.#path.length - 1);
    return Math.abs(lastX - pageX) < SAME_POINT && Math.abs(lastY - pageY) < SAME_POINT;
  }

  /** Starts the path at a point when a line is drawn before any move, as a canvas does. */
  #ensureStart(x: number, y: number): void {
    if (this.#path.length === 0) {
      this.moveTo(x, y);
    }
  }

  /** Adds an operation of the path with its points, placed on the page. */
  #addPoints(operation: number, points: readonly number[]): void {
    this.#path.push(operation);
    for (let index = 0; index < points.length; index += HALF) {
      const x = this.#state.shiftX + this.#state.scaleX * valueAt(points, index);
      const y = this.#state.shiftY + this.#state.scaleY * valueAt(points, index + 1);
      this.#path.push(x, y);
      this.#pathBox = grow(this.#pathBox, x, y);
    }
  }

  /** Returns the current path kept within the printed area, or null when it does not reach it. */
  #pathShape(): PrintShape | null {
    const box = this.#pathBox;
    if (box === null || !overlaps(box, this.#box)) {
      return null;
    }
    return { kind: 'path', segments: clampPath(this.#path, this.#box) };
  }

  /** Returns a rectangle placed on the page and cut to the printed area, or null when it does not reach it. */
  #rectShape(x: number, y: number, width: number, height: number): PrintShape | null {
    const { scaleX, scaleY, shiftX, shiftY } = this.#state;
    const firstX = shiftX + scaleX * x;
    const secondX = shiftX + scaleX * (x + width);
    const firstY = shiftY + scaleY * y;
    const secondY = shiftY + scaleY * (y + height);
    const left = Math.max(Math.min(firstX, secondX), this.#box.left);
    const right = Math.min(Math.max(firstX, secondX), this.#box.right);
    const top = Math.max(Math.min(firstY, secondY), this.#box.top);
    const bottom = Math.min(Math.max(firstY, secondY), this.#box.bottom);
    if (right <= left || bottom <= top) {
      return null;
    }
    return { kind: 'rect', x: left, y: top, width: right - left, height: bottom - top };
  }

  /** Returns the width and dash of a stroke, scaled like the drawing. */
  #strokeLook(): { readonly width: number; readonly dash: number[] } {
    const scale = Math.abs(this.#state.scaleX);
    return {
      width: this.#state.lineWidth * scale,
      dash: this.#state.dash.map((step) => step * scale),
    };
  }

  /** Records a fill or a stroke of a shape, unless the shape or its paint shows nothing. */
  #paint(
    shape: PrintShape | null,
    paint: Paint,
    stroke: { readonly width: number; readonly dash: number[] } | null,
  ): void {
    if (shape === null || this.#state.hidden) {
      return;
    }
    if (paint.kind === 'pattern') {
      this.#current().push({ kind: 'pattern', shape, pattern: paint.pattern });
      return;
    }
    if (paint.opacity === 0 || (stroke !== null && stroke.width === 0)) {
      return;
    }
    const { color, opacity } = paint;
    this.#current().push(
      stroke === null
        ? { kind: 'fill', shape, color, opacity }
        : { kind: 'stroke', shape, color, opacity, width: stroke.width, dash: stroke.dash },
    );
  }

  /** Returns the list that receives the next orders, inside the innermost open clip. */
  #current(): PrintOrder[] {
    return valueAt(this.#lists, this.#lists.length - 1);
  }

  /** Ends the clips opened beyond a depth, dropping those that hold nothing. */
  #closeClips(depth: number): void {
    while (this.#lists.length - 1 > depth) {
      const closed = this.#lists.pop();
      const parent = this.#current();
      if (closed?.length === 0) {
        parent.pop();
      }
    }
  }
}

/** Reads a canvas color or pattern as a print paint, throwing on a style that printing does not know. */
function paintOf(value: unknown): Paint {
  if (typeof value === 'object' && value !== null) {
    const pattern = patterns.get(value);
    if (pattern === undefined) {
      throw new TypeError('Only tag patterns can be printed.');
    }
    return { kind: 'pattern', pattern };
  }
  const text = String(value).trim();
  const hex = HEX_COLOR.exec(text);
  if (hex !== null) {
    return { kind: 'color', color: text.toLowerCase(), opacity: 1 };
  }
  const rgb = RGB_COLOR.exec(text);
  if (rgb === null) {
    throw new TypeError(`Unknown color to print: ${text}`);
  }
  const [, red = '', green = '', blue = '', alpha = '1'] = rgb;
  const channels = [red, green, blue].map((channel) => Number(channel));
  const opacity = Number(alpha);
  if (channels.some((channel) => channel > CHANNEL_MAXIMUM) || opacity > 1) {
    throw new TypeError(`Unknown color to print: ${text}`);
  }
  const color = `#${channels.map((channel) => channel.toString(HEX_RADIX).padStart(CHANNEL_DIGITS, '0')).join('')}`;
  return { kind: 'color', color, opacity };
}

/** Grows a box, or starts one, so that it holds a point. */
function grow(box: Box | null, x: number, y: number): Box {
  if (box === null) {
    return { left: x, top: y, right: x, bottom: y };
  }
  return {
    left: Math.min(box.left, x),
    top: Math.min(box.top, y),
    right: Math.max(box.right, x),
    bottom: Math.max(box.bottom, y),
  };
}

/** Tells whether two boxes share at least a point. */
function overlaps(first: Box, second: Box): boolean {
  return (
    first.left <= second.right &&
    second.left <= first.right &&
    first.top <= second.bottom &&
    second.top <= first.bottom
  );
}

/** Keeps every point of a path within a box, walking the path once, operations unchanged. */
function clampPath(path: readonly number[], box: Box): number[] {
  const clamped: number[] = [];
  let index = 0;
  while (index < path.length) {
    const operation = valueAt(path, index);
    clamped.push(operation);
    const end = index + 1 + coordinateCountOf(operation);
    for (let point = index + 1; point < end; point += HALF) {
      clamped.push(
        Math.min(Math.max(valueAt(path, point), box.left), box.right),
        Math.min(Math.max(valueAt(path, point + 1), box.top), box.bottom),
      );
    }
    index = end;
  }
  return clamped;
}

/** Returns how many coordinates follow an operation that this canvas recorded, all of which are known. */
function coordinateCountOf(operation: number): number {
  return valueAt(RECORDED_COORDINATES, operation);
}
