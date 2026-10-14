import type { PageSize } from './paper';
import { patternTileCount } from './pattern-tiles';
import type { PrintOrder, PrintShape } from './print-document';

export interface PrintCost {
  readonly orders: number;
  readonly pathNumbers: number;
  readonly tiles: number;
}

const NO_COST: PrintCost = { orders: 0, pathNumbers: 0, tiles: 0 };

/** Counts the orders of a list, those inside its clips included, the numbers of all their paths and the tiles of their patterns on a page, as the limits of a document count them. */
export function printCostOf(orders: readonly PrintOrder[], page: PageSize): PrintCost {
  let count = orders.length;
  let pathNumbers = 0;
  let tiles = 0;
  for (const order of orders) {
    pathNumbers += order.kind === 'text' ? 0 : shapeNumbers(order.shape);
    tiles += order.kind === 'pattern' ? patternTileCount(order.shape, page) : 0;
    const inner = order.kind === 'clip' ? printCostOf(order.orders, page) : NO_COST;
    count += inner.orders;
    pathNumbers += inner.pathNumbers;
    tiles += inner.tiles;
  }
  return { orders: count, pathNumbers, tiles };
}

/** Returns how many numbers a shape counts against the numbers of paths a document may hold, none for a rectangle. */
function shapeNumbers(shape: PrintShape): number {
  return shape.kind === 'path' ? shape.segments.length : 0;
}
