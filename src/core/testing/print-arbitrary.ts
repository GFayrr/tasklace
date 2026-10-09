import fc from 'fast-check';
import { MAX_PRINT_COORDINATE } from '../limits';
import { PAPER_NAMES, PAPER_ORIENTATIONS } from '../print/paper';
import {
  MAX_TEXT_POINTS,
  MIN_TEXT_POINTS,
  PATH_CLOSE,
  PATH_CURVE,
  PATH_LINE,
  PATH_MOVE,
  TEXT_ALIGNS,
  TEXT_WEIGHTS,
  type ClipOrder,
  type DrawOrder,
  type PrintDocument,
  type PrintOrder,
  type PrintShape,
} from '../print/print-document';
import { TAG_PATTERNS } from '../tags/tag-appearance';

const PAGE_SPAN = 1_200;

/** Generates a coordinate around a page, now and then far out to its allowed limits. */
export const coordinateArbitrary = fc.oneof(
  { weight: 4, arbitrary: fc.double({ min: -100, max: PAGE_SPAN, noNaN: true }) },
  { weight: 1, arbitrary: fc.constantFrom(-MAX_PRINT_COORDINATE, MAX_PRINT_COORDINATE) },
);

const colorArbitrary = fc
  .integer({ min: 0, max: 0xffffff })
  .map((value) => `#${value.toString(16).padStart(6, '0')}`);

/** Generates a text written on a page, markup characters and letters beyond Latin included. */
export const printTextArbitrary = fc
  .string({
    unit: fc.constantFrom('a', 'Z', ' ', '&', '<', '>', '"', "'", 'é', '漢', '😀'),
    minLength: 1,
    maxLength: 40,
  })
  .filter((text) => text.trim() !== '');

const pathArbitrary = fc
  .array(
    fc.oneof(
      fc.tuple(coordinateArbitrary, coordinateArbitrary).map(([x, y]) => [PATH_LINE, x, y]),
      fc
        .array(coordinateArbitrary, { minLength: 6, maxLength: 6 })
        .map((points) => [PATH_CURVE, ...points]),
      fc.tuple(coordinateArbitrary, coordinateArbitrary).map(([x, y]) => [PATH_MOVE, x, y]),
      fc.constant([PATH_CLOSE]),
    ),
    { maxLength: 8 },
  )
  .chain((rest) =>
    fc
      .tuple(coordinateArbitrary, coordinateArbitrary)
      .map(([x, y]) => ({ kind: 'path' as const, segments: [PATH_MOVE, x, y, ...rest.flat()] })),
  );

const rectArbitrary = fc
  .record({
    x: fc.double({ min: -100, max: PAGE_SPAN, noNaN: true }),
    y: fc.double({ min: -100, max: PAGE_SPAN, noNaN: true }),
    width: fc.double({ min: 0, max: PAGE_SPAN, noNaN: true }),
    height: fc.double({ min: 0, max: PAGE_SPAN, noNaN: true }),
  })
  .map((box) => ({ kind: 'rect' as const, ...box }));

const shapeArbitrary: fc.Arbitrary<PrintShape> = fc.oneof(rectArbitrary, pathArbitrary);

/** Generates any order that draws, with every kind of shape, paint and text. */
export const drawOrderArbitrary: fc.Arbitrary<DrawOrder> = fc.oneof(
  fc.record({
    kind: fc.constant('fill' as const),
    shape: shapeArbitrary,
    color: colorArbitrary,
    opacity: fc.double({ min: 0, max: 1, noNaN: true }),
  }),
  fc.record({
    kind: fc.constant('stroke' as const),
    shape: shapeArbitrary,
    color: colorArbitrary,
    opacity: fc.double({ min: 0, max: 1, noNaN: true }),
    width: fc.double({ min: 0.25, max: 8, noNaN: true }),
    dash: fc.array(fc.double({ min: 0.5, max: 12, noNaN: true }), { maxLength: 4 }),
  }),
  fc.record({
    kind: fc.constant('pattern' as const),
    shape: shapeArbitrary,
    pattern: fc.constantFrom(...TAG_PATTERNS),
  }),
  fc.record({
    kind: fc.constant('text' as const),
    x: coordinateArbitrary,
    y: coordinateArbitrary,
    text: printTextArbitrary,
    size: fc.double({ min: MIN_TEXT_POINTS, max: MAX_TEXT_POINTS, noNaN: true }),
    weight: fc.constantFrom(...TEXT_WEIGHTS),
    color: colorArbitrary,
    align: fc.constantFrom(...TEXT_ALIGNS),
  }),
);

const clipArbitrary: fc.Arbitrary<ClipOrder> = fc
  .tuple(rectArbitrary, fc.array(drawOrderArbitrary, { maxLength: 4 }))
  .map(([{ x, y, width, height }, orders]) => ({ kind: 'clip', x, y, width, height, orders }));

const orderArbitrary: fc.Arbitrary<PrintOrder> = fc.oneof(
  { weight: 4, arbitrary: drawOrderArbitrary },
  { weight: 1, arbitrary: clipArbitrary },
);

/** Generates a valid document to print, with up to three pages of any orders. */
export const printDocumentArbitrary: fc.Arbitrary<PrintDocument> = fc.record({
  paper: fc.constantFrom(...PAPER_NAMES),
  orientation: fc.constantFrom(...PAPER_ORIENTATIONS),
  title: printTextArbitrary,
  pages: fc.array(fc.array(orderArbitrary, { maxLength: 6 }), { minLength: 1, maxLength: 3 }),
});
