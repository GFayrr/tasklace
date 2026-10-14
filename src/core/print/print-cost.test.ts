import { describe, expect, it } from 'vitest';
import { pageSizeOf } from './paper';
import { printCostOf } from './print-cost';
import { PATH_CLOSE, PATH_LINE, PATH_MOVE } from './print-document';

const PAGE = pageSizeOf('a4', 'landscape');

describe('printCostOf', () => {
  it('counts the orders inside clips, the numbers of every path and the tiles of every pattern on the page, rectangles and texts adding no number', () => {
    const rect = { kind: 'rect', x: 0, y: 0, width: 1, height: 1 } as const;
    const wide = { kind: 'rect', x: 4, y: 0, width: 16, height: 8 } as const;
    const path = {
      kind: 'path',
      segments: [PATH_MOVE, 0, 0, PATH_LINE, 1, 1, PATH_CLOSE],
    } as const;
    const text = {
      kind: 'text',
      x: 0,
      y: 0,
      text: 'Plan',
      size: 10,
      weight: 400,
      color: '#000000',
      align: 'start',
    } as const;
    const fill = { kind: 'fill', shape: path, color: '#000000', opacity: 1 } as const;
    expect(
      printCostOf(
        [
          fill,
          text,
          { kind: 'pattern', shape: rect, pattern: 'dots' },
          {
            kind: 'clip',
            shape: path,
            orders: [
              fill,
              {
                kind: 'clip',
                shape: rect,
                orders: [fill, { kind: 'pattern', shape: wide, pattern: 'dots' }],
              },
            ],
          },
        ],
        PAGE,
      ),
    ).toEqual({ orders: 8, pathNumbers: 7 * 4, tiles: 1 + 3 });
    expect(printCostOf([], PAGE)).toEqual({ orders: 0, pathNumbers: 0, tiles: 0 });
  });
});
