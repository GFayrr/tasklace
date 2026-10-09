import {
  MAX_PRINT_COORDINATE,
  MAX_PRINT_DASH_LENGTH,
  MAX_PRINT_ORDERS,
  MAX_PRINT_PAGES,
  MAX_PRINT_PATH_NUMBERS,
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
import { PAPER_NAMES, PAPER_ORIENTATIONS } from './paper';
import {
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

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface Budget {
  left: number;
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
  clip: ['kind', 'x', 'y', 'width', 'height', 'orders'],
};
const MAX_BOX_SIDE = MAX_PRINT_COORDINATE + MAX_PRINT_COORDINATE;

/** Reads a document to print sent by the interface, which is not trusted, checking every order against the format and its limits and refusing the whole document on the first order that breaks them. */
export function readPrintDocument(value: unknown): Result<PrintDocument, ValidationIssues> {
  const issues = createIssueList();
  const record = readRecord({ value, path: '' }, issues, DOCUMENT_KEYS);
  if (record === undefined) {
    return failure(requireIssues(issues.issues));
  }
  const paper = readEnum(childField(record, 'paper', ''), issues, PAPER_NAMES);
  const orientation = readEnum(childField(record, 'orientation', ''), issues, PAPER_ORIENTATIONS);
  const title = readText(childField(record, 'title', ''), issues, MAX_PRINT_TEXT_LENGTH);
  const pages = readPages(childField(record, 'pages', '').value, issues);
  if (
    paper === undefined ||
    orientation === undefined ||
    title === undefined ||
    pages === undefined ||
    issues.issues.length > 0
  ) {
    return failure(requireIssues(issues.issues));
  }
  return success({ paper, orientation, title, pages });
}

/** Reads the pages of a document within the limits of pages and orders, reporting the first refused value with its full path. */
function readPages(value: unknown, issues: IssueList): PrintOrder[][] | undefined {
  const pages = readArray({ value, path: 'pages' }, issues, MAX_PRINT_PAGES);
  if (pages === undefined) {
    return undefined;
  }
  if (pages.length === 0) {
    issues.add('pages', 'EMPTY_LIST');
    return undefined;
  }
  const budget: Budget = { left: MAX_PRINT_ORDERS };
  try {
    return pages.map((page, index) =>
      within(`[${String(index)}]`, () => readOrderList(page, budget, false)),
    );
  } catch (error) {
    if (!(error instanceof RefusedValue)) {
      throw error;
    }
    issues.add(`pages${error.place}`, error.code);
    return undefined;
  }
}

/** Reads a list of orders within what is left of the budget of orders, checking its length before any of its orders and refusing a clip inside a clip. */
function readOrderList(value: unknown, budget: Budget, insideClip: boolean): PrintOrder[] {
  if (!Array.isArray(value)) {
    return refuse('', 'WRONG_TYPE');
  }
  if (value.length > budget.left) {
    return refuse('', 'TOO_MANY_ITEMS');
  }
  budget.left -= value.length;
  return value.map((order: unknown, index) =>
    within(`[${String(index)}]`, () => readOrder(order, budget, insideClip)),
  );
}

/** Reads one order, which must have exactly the keys of its kind. */
function readOrder(value: unknown, budget: Budget, insideClip: boolean): PrintOrder {
  const record = readObject(value, '');
  const kind = record['kind'];
  if (
    typeof kind !== 'string' ||
    !Object.hasOwn(ORDER_KEYS, kind) ||
    (insideClip && kind === 'clip')
  ) {
    return refuse('kind', 'OUT_OF_RANGE');
  }
  const orderKind = kind as PrintOrder['kind'];
  checkKeys(record, ORDER_KEYS[orderKind]);
  if (orderKind === 'clip') {
    const box = readBox(record);
    const orders = within('.orders', () => readOrderList(record['orders'], budget, true));
    return { kind: orderKind, ...box, orders: orders as DrawOrder[] };
  }
  return readDrawOrder(record, orderKind);
}

/** Reads an order that draws, every one of its keys being known to be there. */
function readDrawOrder(record: UnknownRecord, kind: DrawOrder['kind']): DrawOrder {
  if (kind === 'text') {
    return readTextOrder(record);
  }
  const shape = within('.shape', () => readShape(record['shape']));
  if (kind === 'pattern') {
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

/** Reads the shape an order fills, strokes or covers with a pattern. */
function readShape(value: unknown): PrintShape {
  const record = readObject(value, '');
  const kind = record['kind'];
  if (kind === 'path') {
    checkKeys(record, PATH_KEYS);
    return { kind, segments: readSegments(record['segments']) };
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

/** Reads the flat numbers of a path, which starts with a move and holds whole operations with coordinates in range. */
function readSegments(value: unknown): number[] {
  if (!Array.isArray(value) || value.length > MAX_PRINT_PATH_NUMBERS || value[0] !== PATH_MOVE) {
    return refuse('segments', 'OUT_OF_RANGE');
  }
  const numbers: unknown[] = value;
  let index = 0;
  while (index < numbers.length) {
    const count = coordinatesAfter(numbers[index] as number);
    if (count === null || index + count >= numbers.length) {
      return refuse('segments', 'OUT_OF_RANGE');
    }
    if (!numbers.slice(index + 1, index + 1 + count).every(isCoordinate)) {
      return refuse('segments', 'OUT_OF_RANGE');
    }
    index += count + 1;
  }
  return [...(numbers as number[])];
}

/** Reads the dash of a stroke, a short list of lengths that are all above zero. */
function readDash(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return refuse('dash', 'WRONG_TYPE');
  }
  if (value.length > MAX_PRINT_DASH_LENGTH) {
    return refuse('dash', 'TOO_MANY_ITEMS');
  }
  const steps: unknown[] = value;
  if (!steps.every((step) => typeof step === 'number' && step > 0 && step <= MAX_DASH_STEP)) {
    return refuse('dash', 'OUT_OF_RANGE');
  }
  return [...(steps as number[])];
}

/** Reads a value of a record that must be one of a list of choices. */
function readChoice<T>(record: UnknownRecord, key: string, choices: readonly T[]): T {
  const value = record[key];
  return choices.includes(value as T) ? (value as T) : refuse(key, 'OUT_OF_RANGE');
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
function isCoordinate(value: unknown): boolean {
  return (
    typeof value === 'number' && value >= -MAX_PRINT_COORDINATE && value <= MAX_PRINT_COORDINATE
  );
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
