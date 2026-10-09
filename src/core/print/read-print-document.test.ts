import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  MAX_PRINT_COORDINATE,
  MAX_PRINT_DASH_LENGTH,
  MAX_PRINT_ORDERS,
  MAX_PRINT_PAGES,
  MAX_PRINT_PATH_NUMBERS,
  MAX_PRINT_TEXT_LENGTH,
} from '../limits';
import { printDocumentArbitrary } from '../testing/print-arbitrary';
import {
  MAX_CLIP_DEPTH,
  MAX_DASH_STEP,
  MAX_STROKE_WIDTH,
  MAX_TEXT_POINTS,
  MIN_TEXT_POINTS,
  PATH_CLOSE,
  PATH_CURVE,
  PATH_LINE,
  PATH_MOVE,
  type PrintDocument,
} from './print-document';
import { readPrintDocument } from './read-print-document';

const RECT = { kind: 'rect', x: 10, y: 20, width: 30, height: 40 };
const FILL = { kind: 'fill', shape: RECT, color: '#2a78d6', opacity: 1 };
const STROKE = {
  kind: 'stroke',
  shape: { kind: 'path', segments: [PATH_MOVE, 0, 0, PATH_LINE, 10, 10, PATH_CLOSE] },
  color: '#1c1b19',
  opacity: 0.5,
  width: 1.5,
  dash: [3, 2],
};
const TEXT = {
  kind: 'text',
  x: 28,
  y: 50,
  text: 'Write the report',
  size: MIN_TEXT_POINTS,
  weight: 400,
  color: '#1c1b19',
  align: 'start',
};
const PATTERN = { kind: 'pattern', shape: RECT, pattern: 'diagonal' };
const CLIP = { kind: 'clip', shape: RECT, orders: [FILL, TEXT] };

/** Builds clips held one inside the other, a given number of levels deep. */
function nestedClip(depth: number): Record<string, unknown> {
  return depth === 1 ? CLIP : { ...CLIP, orders: [nestedClip(depth - 1)] };
}

/** Builds a document whose single page holds the given orders. */
function documentWith(...orders: unknown[]): Record<string, unknown> {
  return { paper: 'a4', orientation: 'landscape', title: 'Thesis', pages: [orders] };
}

/** Reads a document and returns the issues it raised, or an empty list when it was accepted. */
function issuesOf(value: unknown) {
  const result = readPrintDocument(value);
  return result.ok ? [] : result.error;
}

describe('readPrintDocument', () => {
  it('accepts every kind of order and gives back the same document', () => {
    const document = documentWith(FILL, STROKE, TEXT, PATTERN, CLIP);
    expect(readPrintDocument(document)).toEqual({ ok: true, value: document });
  });

  it('gives back copies that hold no property the document did not need', () => {
    const result = readPrintDocument(documentWith(FILL));
    expect(result.ok && result.value.pages[0]?.[0]).not.toBe(FILL);
  });

  it('accepts any valid document unchanged', () => {
    fc.assert(
      fc.property(printDocumentArbitrary, (document: PrintDocument) => {
        expect(readPrintDocument(document)).toEqual({ ok: true, value: document });
      }),
    );
  });

  it.each([
    ['a value that is no object', null, [{ path: '', code: 'WRONG_TYPE' }]],
    ['an array', [], [{ path: '', code: 'WRONG_TYPE' }]],
    [
      'a missing field and an unknown one',
      { paper: 'a4', orientation: 'landscape', pages: [[]], extra: 1 },
      [
        { path: 'extra', code: 'UNKNOWN_FIELD' },
        { path: 'title', code: 'MISSING_FIELD' },
      ],
    ],
    [
      'an unknown paper and orientation',
      { ...documentWith(), paper: 'a5', orientation: 'diagonal' },
      [
        { path: 'paper', code: 'OUT_OF_RANGE' },
        { path: 'orientation', code: 'OUT_OF_RANGE' },
      ],
    ],
    [
      'a title with a line break',
      { ...documentWith(), title: 'One\nTwo' },
      [{ path: 'title', code: 'INVALID_TEXT' }],
    ],
    ['no page', { ...documentWith(), pages: [] }, [{ path: 'pages', code: 'EMPTY_LIST' }]],
    [
      'pages that are no list',
      { ...documentWith(), pages: {} },
      [{ path: 'pages', code: 'WRONG_TYPE' }],
    ],
    [
      'a page that is no list',
      { ...documentWith(), pages: [{}] },
      [{ path: 'pages[0]', code: 'WRONG_TYPE' }],
    ],
  ])('refuses %s', (_name, value, issues) => {
    expect(issuesOf(value)).toEqual(issues);
  });

  it('refuses more pages than the limit', () => {
    const pages = Array.from({ length: MAX_PRINT_PAGES + 1 }, () => []);
    expect(issuesOf({ ...documentWith(), pages })).toEqual([
      { path: 'pages', code: 'TOO_MANY_ITEMS' },
    ]);
    expect(issuesOf({ ...documentWith(), pages: pages.slice(1) })).toEqual([]);
  });

  it('counts the orders of every page and clip against the limit before reading the orders of a list', () => {
    /** Builds a list of values that are no order, refused as soon as one is read. */
    const unread = (length: number) => new Array<null>(length).fill(null);
    expect(issuesOf({ ...documentWith(), pages: [unread(MAX_PRINT_ORDERS + 1)] })).toEqual([
      { path: 'pages[0]', code: 'TOO_MANY_ITEMS' },
    ]);
    const left = MAX_PRINT_ORDERS - 1 - CLIP.orders.length;
    expect(issuesOf({ ...documentWith(), pages: [[CLIP], unread(left + 1)] })).toEqual([
      { path: 'pages[1]', code: 'TOO_MANY_ITEMS' },
    ]);
    expect(issuesOf({ ...documentWith(), pages: [[CLIP], unread(left)] })).toEqual([
      { path: 'pages[1][0]', code: 'WRONG_TYPE' },
    ]);
    /** Builds a clip holding a list of values that are no order. */
    const clipOf = (length: number) => ({ ...CLIP, orders: unread(length) });
    expect(issuesOf(documentWith(clipOf(MAX_PRINT_ORDERS)))).toEqual([
      { path: 'pages[0][0].orders', code: 'TOO_MANY_ITEMS' },
    ]);
    expect(issuesOf(documentWith(clipOf(MAX_PRINT_ORDERS - 1)))).toEqual([
      { path: 'pages[0][0].orders[0]', code: 'WRONG_TYPE' },
    ]);
  });

  it('stops at the first page that breaks the format, naming the order and its field', () => {
    const broken = { ...FILL, color: 'red' };
    expect(issuesOf({ ...documentWith(), pages: [[FILL], [FILL, broken], [broken]] })).toEqual([
      { path: 'pages[1][1].color', code: 'INVALID_COLOR' },
    ]);
  });

  it.each([
    ['an order that is no object', 1, '', 'WRONG_TYPE'],
    ['an order made by a class', new Date(0), '', 'WRONG_TYPE'],
    ['an unknown kind', { ...FILL, kind: 'blur' }, 'kind', 'OUT_OF_RANGE'],
    ['a kind that is no text', { ...FILL, kind: 3 }, 'kind', 'OUT_OF_RANGE'],
    ['an inherited kind', { ...FILL, kind: 'toString' }, 'kind', 'OUT_OF_RANGE'],
    [
      'a missing field',
      { kind: 'fill', shape: RECT, color: '#000000' },
      'opacity',
      'MISSING_FIELD',
    ],
    ['an unknown field', { ...FILL, filter: 'blur(2px)' }, 'filter', 'UNKNOWN_FIELD'],
    ['a shape that is no object', { ...FILL, shape: [] }, 'shape', 'WRONG_TYPE'],
    ['an unknown shape', { ...FILL, shape: { kind: 'circle' } }, 'shape.kind', 'OUT_OF_RANGE'],
    [
      'a shape missing a field',
      { ...FILL, shape: { kind: 'rect', x: 0, y: 0, width: 1 } },
      'shape.height',
      'MISSING_FIELD',
    ],
    [
      'a shape with an unknown field',
      { ...FILL, shape: { ...RECT, rx: 3 } },
      'shape.rx',
      'UNKNOWN_FIELD',
    ],
    [
      'a coordinate that is no number',
      { ...FILL, shape: { ...RECT, x: '1' } },
      'shape.x',
      'WRONG_TYPE',
    ],
    [
      'a coordinate that is not a number',
      { ...FILL, shape: { ...RECT, y: Number.NaN } },
      'shape.y',
      'OUT_OF_RANGE',
    ],
    [
      'a coordinate beyond the limit',
      { ...FILL, shape: { ...RECT, x: -MAX_PRINT_COORDINATE - 1 } },
      'shape.x',
      'OUT_OF_RANGE',
    ],
    ['a negative width', { ...FILL, shape: { ...RECT, width: -1 } }, 'shape.width', 'OUT_OF_RANGE'],
    [
      'a rectangle reaching beyond the limit across',
      { ...FILL, shape: { ...RECT, x: MAX_PRINT_COORDINATE, width: 1 } },
      'shape.width',
      'OUT_OF_RANGE',
    ],
    [
      'a rectangle reaching beyond the limit down',
      { ...FILL, shape: { ...RECT, y: MAX_PRINT_COORDINATE, height: 1 } },
      'shape.height',
      'OUT_OF_RANGE',
    ],
    ['a color by name', { ...FILL, color: 'red' }, 'color', 'INVALID_COLOR'],
    ['a color with transparency', { ...FILL, color: '#00000080' }, 'color', 'INVALID_COLOR'],
    ['a color that is no text', { ...FILL, color: 0 }, 'color', 'INVALID_COLOR'],
    ['an opacity above one', { ...FILL, opacity: 1.5 }, 'opacity', 'OUT_OF_RANGE'],
    ['a stroke of no width', { ...STROKE, width: 0 }, 'width', 'OUT_OF_RANGE'],
    ['a stroke too wide', { ...STROKE, width: MAX_STROKE_WIDTH + 1 }, 'width', 'OUT_OF_RANGE'],
    ['a dash that is no list', { ...STROKE, dash: 3 }, 'dash', 'WRONG_TYPE'],
    [
      'a dash too long',
      { ...STROKE, dash: Array.from({ length: MAX_PRINT_DASH_LENGTH + 1 }, () => 1) },
      'dash',
      'TOO_MANY_ITEMS',
    ],
    ['a dash step of zero', { ...STROKE, dash: [3, 0] }, 'dash', 'OUT_OF_RANGE'],
    ['a dash step too long', { ...STROKE, dash: [MAX_DASH_STEP + 1] }, 'dash', 'OUT_OF_RANGE'],
    ['a dash step that is no number', { ...STROKE, dash: ['3'] }, 'dash', 'OUT_OF_RANGE'],
    ['an unknown pattern', { ...PATTERN, pattern: 'waves' }, 'pattern', 'OUT_OF_RANGE'],
    [
      'a text below the smallest printed size',
      { ...TEXT, size: MIN_TEXT_POINTS - 0.5 },
      'size',
      'OUT_OF_RANGE',
    ],
    [
      'a text above the largest printed size',
      { ...TEXT, size: MAX_TEXT_POINTS + 1 },
      'size',
      'OUT_OF_RANGE',
    ],
    ['an unknown weight', { ...TEXT, weight: 900 }, 'weight', 'OUT_OF_RANGE'],
    ['an unknown alignment', { ...TEXT, align: 'justify' }, 'align', 'OUT_OF_RANGE'],
    ['a text with a control character', { ...TEXT, text: 'a\u0007b' }, 'text', 'INVALID_TEXT'],
    ['a text with half a character', { ...TEXT, text: 'a\uD800b' }, 'text', 'INVALID_TEXT'],
    ['an empty text', { ...TEXT, text: ' ' }, 'text', 'EMPTY_TEXT'],
    [
      'a text too long',
      { ...TEXT, text: 'a'.repeat(MAX_PRINT_TEXT_LENGTH + 1) },
      'text',
      'TOO_LONG',
    ],
    [
      'a text placed beyond the limit',
      { ...TEXT, y: MAX_PRINT_COORDINATE * 2 },
      'y',
      'OUT_OF_RANGE',
    ],
    [
      'a clip deeper than the limit',
      nestedClip(MAX_CLIP_DEPTH + 1),
      `${'orders[0].'.repeat(MAX_CLIP_DEPTH)}kind`,
      'OUT_OF_RANGE',
    ],
    ['a clip whose orders are no list', { ...CLIP, orders: {} }, 'orders', 'WRONG_TYPE'],
    [
      'a clip beyond the limit',
      { ...CLIP, shape: { ...RECT, x: Number.POSITIVE_INFINITY } },
      'shape.x',
      'OUT_OF_RANGE',
    ],
    [
      'a clip of an unknown shape',
      { ...CLIP, shape: { kind: 'circle' } },
      'shape.kind',
      'OUT_OF_RANGE',
    ],
  ])('refuses %s', (_name, order, field, code) => {
    expect(issuesOf(documentWith(FILL, order))).toEqual([
      { path: `pages[0][1]${field === '' ? '' : `.${field}`}`, code },
    ]);
  });

  it('accepts clips nested down to the limit, of a rectangle or a path', () => {
    const path = { kind: 'path', segments: [PATH_MOVE, 0, 0, PATH_LINE, 5, 5, PATH_CLOSE] };
    const document = documentWith(nestedClip(MAX_CLIP_DEPTH), { ...CLIP, shape: path });
    expect(readPrintDocument(document)).toEqual({ ok: true, value: document });
  });

  it('accepts a text of the longest length and of the extreme printed sizes', () => {
    const longest = { ...TEXT, text: 'a'.repeat(MAX_PRINT_TEXT_LENGTH), size: MAX_TEXT_POINTS };
    expect(issuesOf(documentWith(longest, { ...TEXT, size: MIN_TEXT_POINTS }))).toEqual([]);
  });

  it('accepts a rectangle that ends exactly at the limit', () => {
    const shape = { ...RECT, x: MAX_PRINT_COORDINATE - 1, width: 1, y: -MAX_PRINT_COORDINATE };
    expect(issuesOf(documentWith({ ...FILL, shape }))).toEqual([]);
  });

  it.each([
    ['no number', []],
    ['a start that is no move', [PATH_LINE, 0, 0]],
    ['an unknown operation', [PATH_MOVE, 0, 0, 7, 1, 1]],
    ['an operation that is no whole number', [PATH_MOVE, 0, 0, 0.5, 1, 1]],
    ['a cut operation', [PATH_MOVE, 0, 0, PATH_CURVE, 1, 2, 3]],
    ['a coordinate that is no number', [PATH_MOVE, 0, '0']],
    ['a coordinate beyond the limit', [PATH_MOVE, 0, MAX_PRINT_COORDINATE + 1]],
    [
      'too many numbers',
      [PATH_MOVE, 0, 0, ...Array.from({ length: MAX_PRINT_PATH_NUMBERS }, () => PATH_CLOSE)],
    ],
    ['no list', 'M0 0'],
  ])('refuses a path with %s', (_name, segments) => {
    const order = { ...FILL, shape: { kind: 'path', segments } };
    expect(issuesOf(documentWith(order))).toEqual([
      { path: 'pages[0][0].shape.segments', code: 'OUT_OF_RANGE' },
    ]);
  });

  it('accepts a path of the longest length, with every operation', () => {
    const operations = [PATH_LINE, 1, 1, PATH_CURVE, 1, 2, 3, 4, 5, 6, PATH_CLOSE];
    const segments = [PATH_MOVE, 0, 0, ...operations];
    const filled = [
      ...segments,
      ...Array.from({ length: MAX_PRINT_PATH_NUMBERS - segments.length }, () => PATH_CLOSE),
    ];
    expect(issuesOf(documentWith({ ...FILL, shape: { kind: 'path', segments: filled } }))).toEqual(
      [],
    );
  });

  it('lets through an error that is no refusal, never hiding it as an issue', () => {
    const failing = {
      get kind(): string {
        throw new Error('Unexpected read.');
      },
    };
    expect(() => readPrintDocument(documentWith(CLIP, { ...CLIP, orders: [failing] }))).toThrow(
      'Unexpected read.',
    );
  });

  it('never throws on a valid document with one value replaced by anything', () => {
    fc.assert(
      fc.property(printDocumentArbitrary, fc.anything(), fc.nat(), (document, value, pick) => {
        const json = JSON.parse(JSON.stringify(document)) as Record<string, unknown>;
        const page = (json['pages'] as unknown[][])[0] ?? [];
        if (page.length > 0) {
          page[pick % page.length] = value;
        } else {
          json['title'] = value;
        }
        expect(() => readPrintDocument(json)).not.toThrow();
      }),
    );
  });
});
