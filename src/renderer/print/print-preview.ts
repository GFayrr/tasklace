import {
  pathSegments,
  type DrawOrder,
  type PrintOrder,
  type PrintShape,
  type TextAlign,
} from '../../core/print/print-document';
import { PRINT_FONT_FAMILY } from '../../core/print/print-svg';
import type { PageSize } from '../../core/print/paper';
import type { TagPattern } from '../../core/tags/tag-appearance';

const PAPER_COLOR = '#ffffff';
const HEX_RADIX = 16;
const CHANNEL_DIGITS = 2;
const RED_START = 1;
const GREEN_START = 3;
const BLUE_START = 5;
const CANVAS_ALIGN: Readonly<Record<TextAlign, CanvasTextAlign>> = {
  start: 'left',
  middle: 'center',
  end: 'right',
};

/** Draws a printed page on a canvas at a scale from points to pixels, on white paper, as the PDF will show it, every length of the page, text sizes included, being in points. */
export function paintPrintPage(
  context: CanvasRenderingContext2D,
  orders: readonly PrintOrder[],
  size: PageSize,
  scale: number,
  patternFor: (pattern: TagPattern) => CanvasPattern | null,
): void {
  context.save();
  context.scale(scale, scale);
  context.fillStyle = PAPER_COLOR;
  context.fillRect(0, 0, size.width, size.height);
  context.textBaseline = 'alphabetic';
  for (const order of orders) {
    paintOrder(context, order, patternFor);
  }
  context.restore();
}

/** Draws one order, a clip drawing the orders it holds inside its shape. */
function paintOrder(
  context: CanvasRenderingContext2D,
  order: PrintOrder,
  patternFor: (pattern: TagPattern) => CanvasPattern | null,
): void {
  if (order.kind !== 'clip') {
    paintDrawing(context, order, patternFor);
    return;
  }
  context.save();
  trace(context, order.shape);
  context.clip();
  for (const held of order.orders) {
    paintOrder(context, held, patternFor);
  }
  context.restore();
}

/** Draws an order that fills, strokes, covers with a pattern or writes. */
function paintDrawing(
  context: CanvasRenderingContext2D,
  order: DrawOrder,
  patternFor: (pattern: TagPattern) => CanvasPattern | null,
): void {
  if (order.kind === 'text') {
    context.font = `${String(order.weight)} ${String(order.size)}px ${PRINT_FONT_FAMILY}`;
    context.fillStyle = order.color;
    context.textAlign = CANVAS_ALIGN[order.align];
    context.fillText(order.text, order.x, order.y);
    return;
  }
  trace(context, order.shape);
  if (order.kind === 'pattern') {
    const pattern = patternFor(order.pattern);
    if (pattern !== null) {
      context.fillStyle = pattern;
      context.fill();
    }
    return;
  }
  if (order.kind === 'fill') {
    context.fillStyle = withOpacity(order.color, order.opacity);
    context.fill();
    return;
  }
  context.strokeStyle = withOpacity(order.color, order.opacity);
  context.lineWidth = order.width;
  context.setLineDash(order.dash);
  context.stroke();
  context.setLineDash([]);
}

/** Traces the shape of an order as the current path. */
function trace(context: CanvasRenderingContext2D, shape: PrintShape): void {
  context.beginPath();
  if (shape.kind === 'rect') {
    context.rect(shape.x, shape.y, shape.width, shape.height);
    return;
  }
  for (const segment of pathSegments(shape.segments)) {
    if (segment.kind === 'close') {
      context.closePath();
    } else if (segment.kind === 'curve') {
      context.bezierCurveTo(segment.x1, segment.y1, segment.x2, segment.y2, segment.x, segment.y);
    } else if (segment.kind === 'move') {
      context.moveTo(segment.x, segment.y);
    } else {
      context.lineTo(segment.x, segment.y);
    }
  }
}

/** Writes a #rrggbb color with an opacity as a canvas color. */
function withOpacity(color: string, opacity: number): string {
  if (opacity === 1) {
    return color;
  }
  /** Reads one channel of the color from its two hexadecimal digits. */
  const channel = (start: number) =>
    Number.parseInt(color.slice(start, start + CHANNEL_DIGITS), HEX_RADIX);
  return `rgba(${String(channel(RED_START))}, ${String(channel(GREEN_START))}, ${String(channel(BLUE_START))}, ${String(opacity)})`;
}
