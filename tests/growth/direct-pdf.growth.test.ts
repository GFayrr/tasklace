import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PrintDocument, PrintOrder } from '../../src/core/print/print-document';
import { checkedOrThrow } from '../../src/core/testing/print-arbitrary';
import { printFontsIn } from '../../src/main/pdf-export';
import { writeDirectPdf } from '../../src/main/pdf/direct-pdf';
import { LARGE_TASK_COUNT, LINEAR_MAX_RATIO, SMALL_TASK_COUNT } from './measure-growth';

const FONTS = printFontsIn(join(import.meta.dirname, '../../src/renderer/public/fonts'));
const ROWS_PER_PAGE = 27;
const ROW_HEIGHT = 16;
const MEASURED_ASYNC_RUNS = 3;

/** Returns the orders that print one row: its name, its bar with a pattern and the outline of the bar. */
function rowOrders(row: number): PrintOrder[] {
  const y = (row % ROWS_PER_PAGE) * ROW_HEIGHT + 100;
  const shape = { kind: 'rect', x: 200 + (row % 50), y, width: 40, height: 9 } as const;
  return [
    {
      kind: 'text',
      x: 28,
      y: y + 11,
      text: `Task ${String(row)}`,
      size: 10,
      weight: 400,
      color: '#1c1b19',
      align: 'start',
    },
    { kind: 'fill', shape, color: '#2a78d6', opacity: 1 },
    { kind: 'pattern', shape, pattern: 'diagonal' },
    { kind: 'stroke', shape, color: '#2a78d6', opacity: 1, width: 0.5, dash: [] },
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

/** Returns the median time an asynchronous operation takes over a few runs, after one run to warm up. */
async function medianAsyncDuration(run: () => Promise<unknown>): Promise<number> {
  await run();
  const durations: number[] = [];
  for (let index = 0; index < MEASURED_ASYNC_RUNS; index += 1) {
    const start = performance.now();
    await run();
    durations.push(performance.now() - start);
  }
  return durations.sort((left, right) => left - right)[Math.floor(MEASURED_ASYNC_RUNS / 2)] ?? 0;
}

describe('growth of writing a PDF without the browser with the size of the plan', () => {
  it('writes the PDF in linear time', async () => {
    const small = checkedOrThrow(documentOf(SMALL_TASK_COUNT));
    const large = checkedOrThrow(documentOf(LARGE_TASK_COUNT));
    const ratio =
      (await medianAsyncDuration(() => writeDirectPdf(large, FONTS))) /
      (await medianAsyncDuration(() => writeDirectPdf(small, FONTS)));
    console.info(`Direct PDF: ×${ratio.toFixed(2)}`);
    expect(ratio).toBeLessThanOrEqual(LINEAR_MAX_RATIO);
  });
});
