import { describe, expect, it } from 'vitest';
import {
  PATH_CURVE,
  PATH_LINE,
  PATH_MOVE,
  type PrintDocument,
  type PrintOrder,
} from '../../src/core/print/print-document';
import { printLayout } from '../../src/core/print/print-layout';
import { printPageSvg } from '../../src/core/print/print-svg';
import { readPrintDocument } from '../../src/core/print/read-print-document';
import {
  growthRatio,
  LARGE_TASK_COUNT,
  LINEAR_MAX_RATIO,
  SMALL_TASK_COUNT,
} from './measure-growth';

const ROWS_PER_PAGE = 27;
const ROW_HEIGHT = 16;

/** Returns the orders that print one row: its name, its bar with a pattern, and a link to the next row. */
function rowOrders(row: number): PrintOrder[] {
  const y = (row % ROWS_PER_PAGE) * ROW_HEIGHT + 100;
  const shape = { kind: 'rect', x: 200 + (row % 50), y, width: 40, height: 10 } as const;
  return [
    {
      kind: 'text',
      x: 28,
      y: y + 10,
      text: `Task ${String(row)} & co`,
      size: 10,
      weight: 400,
      color: '#1c1b19',
      align: 'start',
    },
    { kind: 'fill', shape, color: '#2a78d6', opacity: 1 },
    { kind: 'pattern', shape, pattern: 'diagonal' },
    {
      kind: 'stroke',
      shape: {
        kind: 'path',
        segments: [
          PATH_MOVE,
          240,
          y + 5,
          PATH_LINE,
          250,
          y + 5,
          PATH_CURVE,
          252,
          y + 5,
          254,
          y + 8,
          254,
          y + 21,
        ],
      },
      color: '#5f5b55',
      opacity: 1,
      width: 1,
      dash: [],
    },
  ];
}

/** Builds a document printing a given number of rows, 27 rows to a page. */
function documentOf(rowCount: number): PrintDocument {
  const pages: PrintOrder[][] = [];
  for (let row = 0; row < rowCount; row += 1) {
    if (row % ROWS_PER_PAGE === 0) {
      pages.push([]);
    }
    pages.at(-1)?.push(...rowOrders(row));
  }
  return { paper: 'a4', orientation: 'landscape', title: 'Growth', pages };
}

describe('growth of printing with the size of the plan', () => {
  it('lays the pages out in time proportional to their number', () => {
    /** Lays out the given number of rows over a long period. */
    const layout = (rowCount: number) => () =>
      printLayout({
        paper: 'a4',
        orientation: 'landscape',
        rowCount,
        columnsWidth: 160,
        periodHours: 24 * 365,
        zoom: { kind: 'automatic', minPointsPerHour: 0.05 },
        legendWidths: [60, 80, 100],
      });
    const ratio = growthRatio(layout(SMALL_TASK_COUNT), layout(LARGE_TASK_COUNT));
    console.info(`Print layout: ×${ratio.toFixed(2)}`);
    expect(ratio).toBeLessThanOrEqual(LINEAR_MAX_RATIO);
  });

  it('checks a document to print in linear time', () => {
    const small = documentOf(SMALL_TASK_COUNT);
    const large = documentOf(LARGE_TASK_COUNT);
    const ratio = growthRatio(
      () => readPrintDocument(small),
      () => readPrintDocument(large),
    );
    console.info(`Print document check: ×${ratio.toFixed(2)}`);
    expect(ratio).toBeLessThanOrEqual(LINEAR_MAX_RATIO);
  });

  it('writes every page as SVG in linear time', () => {
    const small = documentOf(SMALL_TASK_COUNT);
    const large = documentOf(LARGE_TASK_COUNT);
    /** Writes every page of a document as SVG. */
    const writeAll = (document: PrintDocument) => () => {
      document.pages.forEach((_page, index) => printPageSvg(document, index));
    };
    const ratio = growthRatio(writeAll(small), writeAll(large));
    console.info(`Print SVG: ×${ratio.toFixed(2)}`);
    expect(ratio).toBeLessThanOrEqual(LINEAR_MAX_RATIO);
  });
});
