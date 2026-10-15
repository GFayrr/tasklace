import {
  MAX_PRINT_COORDINATE,
  MAX_PRINT_DASH_LENGTH,
  MAX_PRINT_DOCUMENT_PATH_NUMBERS,
  MAX_PRINT_ORDERS,
  MAX_PRINT_PAGES,
  MAX_PRINT_PATH_NUMBERS,
  MAX_PRINT_PATTERN_TILES,
  MAX_PRINT_TEXT_LENGTH,
} from '../limits';
import { failure, success, type Result } from '../result';
import { isHexColor } from '../tags/color-vision';
import { TAG_PATTERNS } from '../tags/tag-appearance';
import {
  createIssueList,
  requireIssues,
  type IssueList,
  type ValidationIssueCode,
  type ValidationIssues,
} from '../validation/validation-issues';
import {
  childField,
  readArray,
  readEnum,
  readRecord,
  readText,
  type UnknownRecord,
} from '../validation/value-readers';
import { PAPER_NAMES, PAPER_ORIENTATIONS, pageSizeOf, type PageSize } from './paper';
import { patternTileCount } from './pattern-tiles';
import {
  MAX_CLIP_DEPTH,
  MAX_DASH_STEP,
  MAX_STROKE_WIDTH,
  MAX_TEXT_POINTS,
  MIN_TEXT_POINTS,
  PATH_MOVE,
  TEXT_ALIGNS,
  TEXT_WEIGHTS,
  coordinatesAfter,
  type DrawOrder,
  type PrintDocument,
  type PrintOrder,
  type PrintShape,
  type TextAlign,
  type TextOrder,
  type TextWeight,
} from './print-document';
import { isOneOf } from '../one-of';

declare const CHECKED: unique symbol;

/** A document to print that `readPrintDocument` accepted, the only kind printing and writing a PDF take. */
export type CheckedPrintDocument = PrintDocument & { readonly [CHECKED]: true };

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface Budget {
  readonly page: PageSize;
  orders: number;
  pathNumbers: number;
  tiles: number;
}

/** A refusal of a value, its place written relative to the value being read, so that the path is built only when a value is refused. */
class RefusedValue extends Error {
  /** Records where, from the value being read, a refused value sits and why it is refused. */
  constructor(
    readonly place: string,
    readonly code: ValidationIssueCode,
  ) {
    super(`${place} ${code}`);
  }
}

const DOCUMENT_KEYS = ['paper', 'orientation', 'title', 'pages'];
const RECT_KEYS = ['kind', 'x', 'y', 'width', 'height'];
const PATH_KEYS = ['kind', 'segments'];
const ORDER_KEYS: Readonly<Record<PrintOrder['kind'], readonly string[]>> = {
  fill: ['kind', 'shape', 'color', 'opacity'],
  stroke: ['kind', 'shape', 'color', 'opacity', 'width', 'dash'],
  pattern: ['kind', 'shape', 'pattern'],
  text: ['kind', 'x', 'y', 'text', 'size', 'weight', 'color', 'align'],
  clip: ['kind', 'shape', 'orders'],
};
const MAX_BOX_SIDE = MAX_PRINT_COORDINATE + MAX_PRINT_COORDINATE;
const NO_PAGE: PageSize = { width: 0, height: 0 };

/** Reads a document to print sent by the interface, which is not trusted, checking every order against the format and its limits and refusing the whole document on the first order that breaks them. */
export function readPrintDocument(value: unknown): Result<CheckedPrintDocument, ValidationIssues> {
  const issues = createIssueList();
  const record = readRecord({ value, path: '' }, issues, DOCUMENT_KEYS);
  if (record === undefined) {
    return failure(requireIssues(issues.issues));
  }
  const paper = readEnum(childField(record, 'paper', ''), issues, PAPER_NAMES);
  const orientation = readEnum(childField(record, 'orientation', ''), issues, PAPER_ORIENTATIONS);
  const title = readText(childField(record, 'title', ''), issues, MAX_PRINT_TEXT_LENGTH);
  const page =
    paper === undefined || orientation === undefined ? NO_PAGE : pageSizeOf(paper, orientation);
  const pages = readPages(childField(record, 'pages', '').value, issues, page);
  if (
    paper === undefined ||
    orientation === undefined ||
    title === undefined ||
    pages === undefined ||
    issues.issues.length > 0
  ) {
    return failure(requireIssues(issues.issues));
  }
  const document: PrintDocument = { paper, orientation, title, pages };
  return success(document as CheckedPrintDocument);
}

/** Reads the pages of a document within the limits of pages, orders, numbers of paths and pattern tiles on its paper, none on an unknown paper, a hole in a list being read as a missing value, reporting the first refused value. */
function readPages(value: unknown, issues: IssueList, page: PageSize): PrintOrder[][] | undefined {
  const pages = readArray({ value, path: 'pages' }, issues, MAX_PRINT_PAGES);
  if (pages === undefined) {
    return undefined;
  }
  if (pages.length === 0) {
    issues.add('pages', 'EMPTY_LIST');
    return undefined;
  }
  const budget: Budget = {
    page,
    orders: MAX_PRINT_ORDERS,
    pathNumbers: MAX_PRINT_DOCUMENT_PATH_NUMBERS,
    tiles: MAX_PRINT_PATTERN_TILES,
  };
  try {
    return Array.from(pages, (page, index) =>
      within(`[${String(index)}]`, () => readOrderList(page, budget, 0)),
    );
  } catch (error) {
    if (!(error instanceof RefusedValue)) {
      throw error;
    }
    issues.add(`pages${error.place}`, error.code);
    return undefined;
  }
}

/** Reads a list of orders within what is left of the budget of orders, checking its length before any of its orders, inside a given number of clips. */
function readOrderList(value: unknown, budget: Budget, clipDepth: number): PrintOrder[] {
  if (!Array.isArray(value)) {
    return refuse('', 'WRONG_TYPE');
  }
  if (value.length > budget.orders) {
    return refuse('', 'TOO_MANY_ITEMS');
  }
  budget.orders -= value.length;
  return Array.from(value, (order: unknown, index) =>
    within(`[${String(index)}]`, () => readOrder(order, budget, clipDepth)),
  );
}

/** Reads one order, which must have exactly the keys of its kind, a clip never lying deeper than the limit. */
function readOrder(value: unknown, budget: Budget, clipDepth: number): PrintOrder {
  const record = readObject(value, '');
  const kind = record['kind'];
  if (!isOrderKind(kind) || (kind === 'clip' && clipDepth >= MAX_CLIP_DEPTH)) {
    return refuse('kind', 'OUT_OF_RANGE');
  }
  const orderKind = kind;
  checkKeys(record, ORDER_KEYS[orderKind]);
  if (orderKind === 'clip') {
    const shape = within('.shape', () => readShape(record['shape'], budget));
    const orders = within('.orders', () => readOrderList(record['orders'], budget, clipDepth + 1));
    return { kind: orderKind, shape, orders };
  }
  return readDrawOrder(record, orderKind, budget);
}

/** Reads an order that draws, every one of its keys being known to be there, its path and the tiles of its pattern counted against what is left of their budgets. */
function readDrawOrder(record: UnknownRecord, kind: DrawOrder['kind'], budget: Budget): DrawOrder {
  if (kind === 'text') {
    return readTextOrder(record);
  }
  const shape = within('.shape', () => readShape(record['shape'], budget));
  if (kind === 'pattern') {
    budget.tiles -= patternTileCount(shape, budget.page);
    if (budget.tiles < 0) {
      return refuse('shape', 'TOO_MANY_ITEMS');
    }
    return { kind, shape, pattern: readChoice(record, 'pattern', TAG_PATTERNS) };
  }
  const color = readColor(record['color']);
  const opacity = readNumber(record, 'opacity', 0, 1);
  if (kind === 'fill') {
    return { kind, shape, color, opacity };
  }
  const width = readNumber(record, 'width', 0, MAX_STROKE_WIDTH);
  if (width === 0) {
    return refuse('width', 'OUT_OF_RANGE');
  }
  return { kind, shape, color, opacity, width, dash: readDash(record['dash']) };
}

/** Reads an order that writes a line of text, never smaller than the smallest size a printed page allows. */
function readTextOrder(record: UnknownRecord): TextOrder {
  const x = readCoordinate(record, 'x');
  const y = readCoordinate(record, 'y');
  const issues = createIssueList();
  const text = readText({ value: record['text'], path: 'text' }, issues, MAX_PRINT_TEXT_LENGTH);
  if (text === undefined) {
    return refuse('text', requireIssues(issues.issues)[0].code);
  }
  return {
    kind: 'text',
    x,
    y,
    text,
    size: readNumber(record, 'size', MIN_TEXT_POINTS, MAX_TEXT_POINTS),
    weight: readChoice<TextWeight>(record, 'weight', TEXT_WEIGHTS),
    color: readColor(record['color']),
    align: readChoice<TextAlign>(record, 'align', TEXT_ALIGNS),
  };
}

/** Reads the shape an order fills, strokes, covers with a pattern or clips to, the numbers of a path counted against what is left of the budget. */
function readShape(value: unknown, budget: Budget): PrintShape {
  const record = readObject(value, '');
  const kind = record['kind'];
  if (kind === 'path') {
    checkKeys(record, PATH_KEYS);
    return { kind, segments: readSegments(record['segments'], budget) };
  }
  if (kind !== 'rect') {
    return refuse('kind', 'OUT_OF_RANGE');
  }
  checkKeys(record, RECT_KEYS);
  return { kind, ...readBox(record) };
}

/** Reads a rectangle whose corners all stay within the coordinates a page allows. */
function readBox(record: UnknownRecord): Box {
  const x = readCoordinate(record, 'x');
  const y = readCoordinate(record, 'y');
  const width = readNumber(record, 'width', 0, MAX_BOX_SIDE);
  const height = readNumber(record, 'height', 0, MAX_BOX_SIDE);
  if (x + width > MAX_PRINT_COORDINATE) {
    return refuse('width', 'OUT_OF_RANGE');
  }
  if (y + height > MAX_PRINT_COORDINATE) {
    return refuse('height', 'OUT_OF_RANGE');
  }
  return { x, y, width, height };
}

/** Reads the flat numbers of a path, which starts with a move and holds whole operations with coordinates in range, within what is left of the numbers of paths of the document. */
function readSegments(value: unknown, budget: Budget): number[] {
  if (!Array.isArray(value) || value.length > MAX_PRINT_PATH_NUMBERS || value[0] !== PATH_MOVE) {
    return refuse('segments', 'OUT_OF_RANGE');
  }
  if (value.length > budget.pathNumbers) {
    return refuse('segments', 'TOO_MANY_ITEMS');
  }
  budget.pathNumbers -= value.length;
  const numbers: unknown[] = Array.from(value);
  const read: number[] = [];
  while (read.length < numbers.length) {
    const operation = numbers[read.length];
    const count = typeof operation === 'number' ? coordinatesAfter(operation) : null;
    const coordinates = numbers.slice(read.length + 1, read.length + 1 + (count ?? 0));
    if (
      typeof operation !== 'number' ||
      count === null ||
      coordinates.length < count ||
      !coordinates.every(isCoordinate)
    ) {
      return refuse('segments', 'OUT_OF_RANGE');
    }
    read.push(operation, ...coordinates);
  }
  return read;
}

/** Reads the dash of a stroke, a short list of lengths that are all above zero. */
function readDash(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return refuse('dash', 'WRONG_TYPE');
  }
  if (value.length > MAX_PRINT_DASH_LENGTH) {
    return refuse('dash', 'TOO_MANY_ITEMS');
  }
  const steps: unknown[] = Array.from(value);
  if (
    !steps.every(
      (step): step is number => typeof step === 'number' && step > 0 && step <= MAX_DASH_STEP,
    )
  ) {
    return refuse('dash', 'OUT_OF_RANGE');
  }
  return [...steps];
}

/** Reads a value of a record that must be one of a list of choices. */
function readChoice<T>(record: UnknownRecord, key: string, choices: readonly T[]): T {
  const value = record[key];
  return isOneOf(choices, value) ? value : refuse(key, 'OUT_OF_RANGE');
}

/** Reads a color written #RRGGBB. */
function readColor(value: unknown): string {
  return typeof value === 'string' && isHexColor(value) ? value : refuse('color', 'INVALID_COLOR');
}

/** Reads a coordinate on a page, within the range that every PDF reader handles. */
function readCoordinate(record: UnknownRecord, key: string): number {
  return readNumber(record, key, -MAX_PRINT_COORDINATE, MAX_PRINT_COORDINATE);
}

/** Reads a number of a record between two bounds, both included, which refuses a number that is not finite. */
function readNumber(record: UnknownRecord, key: string, min: number, max: number): number {
  const value = record[key];
  if (typeof value !== 'number') {
    return refuse(key, 'WRONG_TYPE');
  }
  return value >= min && value <= max ? value : refuse(key, 'OUT_OF_RANGE');
}

/** Reads a plain object, as produced by copying a message between processes. */
function readObject(value: unknown, key: string): UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return refuse(key, 'WRONG_TYPE');
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return refuse(key, 'WRONG_TYPE');
  }
  return value as UnknownRecord;
}

/** Refuses a record that lacks a key of its kind, the first missing key first, or that holds another key. */
function checkKeys(record: UnknownRecord, keys: readonly string[]): void {
  const missing = keys.find((key) => !Object.hasOwn(record, key));
  if (missing !== undefined) {
    refuse(missing, 'MISSING_FIELD');
  }
  const extra = Object.keys(record).find((key) => !keys.includes(key));
  if (extra !== undefined) {
    refuse(extra, 'UNKNOWN_FIELD');
  }
}

/** Tells whether a value is a coordinate within the range a page allows. */
function isCoordinate(value: unknown): value is number {
  return (
    typeof value === 'number' && value >= -MAX_PRINT_COORDINATE && value <= MAX_PRINT_COORDINATE
  );
}

/** Tells whether a text names a kind of drawing order. */
function isOrderKind(kind: unknown): kind is PrintOrder['kind'] {
  return typeof kind === 'string' && Object.hasOwn(ORDER_KEYS, kind);
}

/** Reads a value inside another, placing any refusal it raises under the place of that value. */
function within<T>(place: string, read: () => T): T {
  try {
    return read();
  } catch (error) {
    throw error instanceof RefusedValue
      ? new RefusedValue(`${place}${error.place}`, error.code)
      : error;
  }
}

/** Refuses a value at a key of the value being read, the empty key standing for that value itself. */
function refuse(key: string, code: ValidationIssueCode): never {
  throw new RefusedValue(key === '' ? '' : `.${key}`, code);
}
