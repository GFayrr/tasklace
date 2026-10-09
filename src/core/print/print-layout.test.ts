import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MAX_PRINT_PAGES } from '../limits';
import { PAPER_NAMES, PAPER_ORIENTATIONS, pageSizeOf } from './paper';
import {
  FOOTER_LINE_HEIGHT,
  HEADER_HEIGHT,
  LEGEND_GAP,
  MIN_TIMELINE_WIDTH,
  PAGE_MARGIN,
  PAGE_NUMBER_WIDTH,
  PRINT_ROW_HEIGHT,
  SCALE_HEIGHT,
  printLayout,
  wrapLegend,
  type PrintLayout,
  type PrintLayoutRequest,
} from './print-layout';

const A4_LANDSCAPE_WIDTH = 841.89;
const CONTENT_WIDTH = A4_LANDSCAPE_WIDTH - PAGE_MARGIN * 2;
const NAMES_WIDTH = 160;
const TIMELINE_WIDTH = CONTENT_WIDTH - NAMES_WIDTH;
const MONTH_POINTS_PER_HOUR = 40 / (30 * 24);
const HOURS_PER_WEEK = 7 * 24;
const POINT_TOLERANCE = 1 / 1_024;

/** Builds a request for an A4 landscape page with the names column only, changed by the given values. */
function request(changes: Partial<PrintLayoutRequest> = {}): PrintLayoutRequest {
  return {
    paper: 'a4',
    orientation: 'landscape',
    rowCount: 10,
    columnsWidth: NAMES_WIDTH,
    periodHours: HOURS_PER_WEEK,
    zoom: { kind: 'automatic', minPointsPerHour: MONTH_POINTS_PER_HOUR },
    legendWidths: [60, 80],
    ...changes,
  };
}

/** Lays a request out and fails the test when it is refused. */
function layoutOf(changes: Partial<PrintLayoutRequest> = {}): PrintLayout {
  const result = printLayout(request(changes));
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.value;
}

describe('pageSizeOf', () => {
  it.each([
    ['a4', 'portrait', 595.28, 841.89],
    ['a4', 'landscape', 841.89, 595.28],
    ['a3', 'portrait', 841.89, 1190.55],
    ['a3', 'landscape', 1190.55, 841.89],
    ['letter', 'portrait', 612, 792],
    ['letter', 'landscape', 792, 612],
  ] as const)('gives %s %s paper its size in points', (paper, orientation, width, height) => {
    expect(pageSizeOf(paper, orientation)).toEqual({ width, height });
  });
});

describe('printLayout', () => {
  it('fits a small plan on one page, stretching the whole period over the width of the timeline', () => {
    const layout = layoutOf();
    expect(layout.pageColumns).toBe(1);
    expect(layout.pageRows).toBe(1);
    expect(layout.pointsPerHour).toBe(TIMELINE_WIDTH / HOURS_PER_WEEK);
    expect(layout.pages).toEqual([
      { number: 1, firstRow: 0, rowCount: 10, timelineStart: 0, timelineWidth: TIMELINE_WIDTH },
    ]);
  });

  it('places the header, the scale, the rows and a one-line footer from the margins', () => {
    const { frame } = layoutOf();
    expect(frame).toEqual({
      page: { width: A4_LANDSCAPE_WIDTH, height: 595.28 },
      left: PAGE_MARGIN,
      width: CONTENT_WIDTH,
      headerTop: PAGE_MARGIN,
      scaleTop: PAGE_MARGIN + HEADER_HEIGHT,
      rowsTop: PAGE_MARGIN + HEADER_HEIGHT + SCALE_HEIGHT,
      footerTop: 595.28 - PAGE_MARGIN - FOOTER_LINE_HEIGHT,
      timelineLeft: PAGE_MARGIN + NAMES_WIDTH,
      timelineWidth: TIMELINE_WIDTH,
      legendWidth: CONTENT_WIDTH - PAGE_NUMBER_WIDTH,
      legendLines: [[0, 1]],
    });
  });

  it.each([
    ['a4', 27],
    ['letter', 28],
    ['a3', 43],
  ] as const)(
    'holds rows of text at least 10 points high on %s landscape paper: %i rows',
    (paper, rows) => {
      expect(layoutOf({ paper }).rowsPerPage).toBe(rows);
    },
  );

  it('keeps a plan without tasks on one page', () => {
    expect(layoutOf({ rowCount: 0 }).pages).toEqual([
      { number: 1, firstRow: 0, rowCount: 0, timelineStart: 0, timelineWidth: TIMELINE_WIDTH },
    ]);
  });

  it('turns to a grid of pages one below the other when the rows do not fit', () => {
    const layout = layoutOf({ rowCount: 60 });
    expect(layout.pageRows).toBe(3);
    expect(layout.pages.map((page) => [page.number, page.firstRow, page.rowCount])).toEqual([
      [1, 0, 27],
      [2, 27, 27],
      [3, 54, 6],
    ]);
  });

  it('keeps the smallest legible scale and spreads a long period over pages side by side', () => {
    const periodHours = 2 * 365 * 24;
    const layout = layoutOf({ periodHours });
    const totalWidth = periodHours * MONTH_POINTS_PER_HOUR;
    expect(layout.pointsPerHour).toBe(MONTH_POINTS_PER_HOUR);
    expect(layout.pageColumns).toBe(Math.ceil(totalWidth / TIMELINE_WIDTH));
    expect(layout.pages.at(-1)?.timelineWidth).toBe(
      totalWidth - (layout.pageColumns - 1) * TIMELINE_WIDTH,
    );
  });

  it('reads a grid row of pages by row of pages, every page repeating its rows across the period', () => {
    const layout = layoutOf({ rowCount: 30, zoom: { kind: 'fixed', pointsPerHour: 10 } });
    expect(layout.pageColumns).toBe(3);
    expect(layout.pages.map((page) => [page.number, page.firstRow, page.timelineStart])).toEqual([
      [1, 0, 0],
      [2, 0, TIMELINE_WIDTH],
      [3, 0, TIMELINE_WIDTH * 2],
      [4, 27, 0],
      [5, 27, TIMELINE_WIDTH],
      [6, 27, TIMELINE_WIDTH * 2],
    ]);
  });

  it('leaves the end of the page empty for a chosen zoom narrower than the page', () => {
    const layout = layoutOf({ zoom: { kind: 'fixed', pointsPerHour: 1 } });
    expect(layout.pointsPerHour).toBe(1);
    expect(layout.pages).toEqual([
      { number: 1, firstRow: 0, rowCount: 10, timelineStart: 0, timelineWidth: HOURS_PER_WEEK },
    ]);
  });

  it('adds no page for a period that ends a hair beyond the width of a page, the page taking it all', () => {
    const pointsPerHour = (TIMELINE_WIDTH + POINT_TOLERANCE / 2) / HOURS_PER_WEEK;
    const layout = layoutOf({ zoom: { kind: 'fixed', pointsPerHour } });
    expect(layout.pageColumns).toBe(1);
    expect(layout.pages[0]?.timelineWidth).toBe(HOURS_PER_WEEK * pointsPerHour);
  });

  it('gives the legend the lines it needs, which leaves fewer rows on each page', () => {
    const layout = layoutOf({ legendWidths: Array.from({ length: 12 }, () => 120) });
    expect(layout.frame.legendLines).toHaveLength(3);
    expect(layout.rowsPerPage).toBe(25);
  });

  it('refuses columns that leave too narrow a timeline', () => {
    expect(printLayout(request({ columnsWidth: CONTENT_WIDTH - MIN_TIMELINE_WIDTH }))).toEqual({
      ok: true,
      value: expect.any(Object) as unknown,
    });
    expect(printLayout(request({ columnsWidth: CONTENT_WIDTH - MIN_TIMELINE_WIDTH + 1 }))).toEqual({
      ok: false,
      error: 'NO_ROOM_FOR_TIMELINE',
    });
  });

  it('refuses a legend that leaves no room for a single row', () => {
    const legendWidths = Array.from({ length: 30 }, () => CONTENT_WIDTH);
    expect(printLayout(request({ legendWidths }))).toEqual({
      ok: false,
      error: 'NO_ROOM_FOR_ROWS',
    });
  });

  it('refuses more pages than the limit, before laying any of them out', () => {
    const rowsForLimit = 27 * MAX_PRINT_PAGES;
    expect(printLayout(request({ rowCount: rowsForLimit })).ok).toBe(true);
    expect(printLayout(request({ rowCount: rowsForLimit + 1 }))).toEqual({
      ok: false,
      error: 'TOO_MANY_PAGES',
    });
    expect(
      printLayout(request({ periodHours: 1e6, zoom: { kind: 'fixed', pointsPerHour: 1e300 } })),
    ).toEqual({ ok: false, error: 'TOO_MANY_PAGES' });
  });

  it.each([
    ['a negative number of rows', { rowCount: -1 }],
    ['a fractional number of rows', { rowCount: 1.5 }],
    ['an empty period', { periodHours: 0 }],
    ['an endless period', { periodHours: Number.POSITIVE_INFINITY }],
    ['a zero zoom', { zoom: { kind: 'fixed', pointsPerHour: 0 } }],
    ['a zero smallest zoom', { zoom: { kind: 'automatic', minPointsPerHour: 0 } }],
    ['negative columns', { columnsWidth: -1 }],
    ['columns of no width', { columnsWidth: Number.NaN }],
    ['a negative legend item', { legendWidths: [-1] }],
  ] as const)('throws on %s, which the interface never asks for', (_name, changes) => {
    expect(() => printLayout(request(changes as Partial<PrintLayoutRequest>))).toThrow(
      'Invalid print layout request.',
    );
  });

  it('puts every row on one row of pages and every point of the period on one column of pages, the same on every row', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...PAPER_NAMES),
        fc.constantFrom(...PAPER_ORIENTATIONS),
        fc.integer({ min: 0, max: 2_000 }),
        fc.double({ min: 0.25, max: 20_000, noNaN: true }),
        fc.option(fc.double({ min: 0.01, max: 50, noNaN: true }), { nil: null }),
        (paper, orientation, rowCount, periodHours, fixed) => {
          const zoom =
            fixed === null
              ? ({ kind: 'automatic', minPointsPerHour: MONTH_POINTS_PER_HOUR } as const)
              : ({ kind: 'fixed', pointsPerHour: fixed } as const);
          const result = printLayout(
            request({ paper, orientation, rowCount, periodHours, zoom, columnsWidth: 120 }),
          );
          if (!result.ok) {
            expect(result.error).toBe('TOO_MANY_PAGES');
            return;
          }
          const layout = result.value;
          expect(layout.pages).toHaveLength(layout.pageColumns * layout.pageRows);
          expect(layout.pages.map((page) => page.number)).toEqual(
            layout.pages.map((_page, index) => index + 1),
          );
          const firstColumn = layout.pages.filter((page) => page.timelineStart === 0);
          expect(firstColumn.reduce((sum, page) => sum + page.rowCount, 0)).toBe(rowCount);
          firstColumn.forEach((page, index) => {
            expect(page.firstRow).toBe(index * layout.rowsPerPage);
          });
          const firstRow = layout.pages.slice(0, layout.pageColumns);
          let covered = 0;
          for (const [index, page] of firstRow.entries()) {
            expect(page.timelineStart).toBe(index * layout.frame.timelineWidth);
            expect(page.timelineWidth).toBeGreaterThan(0);
            expect(page.timelineWidth).toBeLessThanOrEqual(
              layout.frame.timelineWidth + POINT_TOLERANCE,
            );
            covered += page.timelineWidth;
          }
          expect(covered).toBeCloseTo(periodHours * layout.pointsPerHour, 6);
          layout.pages.forEach((page, index) => {
            const sameColumn = firstRow[index % layout.pageColumns];
            expect([page.timelineStart, page.timelineWidth]).toEqual([
              sameColumn?.timelineStart,
              sameColumn?.timelineWidth,
            ]);
          });
          expect(layout.frame.rowsTop + layout.rowsPerPage * PRINT_ROW_HEIGHT).toBeLessThanOrEqual(
            layout.frame.footerTop,
          );
        },
      ),
    );
  });
});

describe('wrapLegend', () => {
  it('keeps one empty line when there is no item', () => {
    expect(wrapLegend([], 100)).toEqual([[]]);
  });

  it('fills each line in order, a gap between items, and starts a new line for an item that does not fit', () => {
    expect(wrapLegend([40, 40, 40], 40 * 2 + LEGEND_GAP)).toEqual([[0, 1], [2]]);
    expect(wrapLegend([40, 40, 40], 40 * 2 + LEGEND_GAP - 1)).toEqual([[0], [1], [2]]);
  });

  it('gives an item wider than a line a line of its own', () => {
    expect(wrapLegend([10, 500, 10], 100)).toEqual([[0], [1], [2]]);
  });
});
