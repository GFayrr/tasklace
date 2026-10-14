import { pageSizeOf, type PageSize } from './paper';
import {
  PATTERN_INK_COLOR,
  PATTERN_INK_OPACITY,
  PATTERN_LINE_WIDTH,
  patternTileCorners,
  patternTileOf,
  type PatternTile,
  type TileCorner,
} from './pattern-tiles';
import {
  pathSegments,
  type DrawOrder,
  type PathSegment,
  type PatternOrder,
  type PrintOrder,
  type PrintShape,
} from './print-document';
import type { CheckedPrintDocument } from './read-print-document';

export const PRINT_FONT_FAMILY = 'Jost Print';

const HUNDREDTHS = 100;
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
type MarkupCharacter = '&' | '<' | '>' | '"' | "'";

const ESCAPES: Readonly<Record<MarkupCharacter, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const MARKUP_CHARACTERS = /[&<>"']/g;

interface PageWriter {
  readonly prefix: string;
  readonly page: PageSize;
  readonly clips: string[];
}

/** Writes one page of a validated document as an SVG image sized in points, its identifiers starting with the page number so that several pages can share one HTML page. */
export function printPageSvg(document: CheckedPrintDocument, pageIndex: number): string {
  const orders = document.pages[pageIndex];
  if (orders === undefined) {
    throw new RangeError(`No page ${String(pageIndex)} to write.`);
  }
  const size = pageSizeOf(document.paper, document.orientation);
  const writer: PageWriter = { prefix: `p${String(pageIndex)}`, page: size, clips: [] };
  const body = orders.map((order) => printOrderSvg(order, writer)).join('');
  const width = svgNumber(size.width);
  const height = svgNumber(size.height);
  return (
    `<svg xmlns="${SVG_NAMESPACE}" width="${width}pt" height="${height}pt" viewBox="0 0 ${width} ${height}"` +
    ` font-family="${PRINT_FONT_FAMILY}" xml:space="preserve">` +
    `${definitionsSvg(writer)}${body}</svg>`
  );
}

/** Escapes the characters that would be read as markup in the text or an attribute of an SVG image. */
export function escapeMarkup(text: string): string {
  return text.replace(MARKUP_CHARACTERS, (character) => ESCAPES[character as MarkupCharacter]);
}

/** Writes a number of points with at most two decimals, never as minus zero or in exponent form within the coordinates a page allows. */
export function svgNumber(value: number): string {
  const rounded = Math.round(value * HUNDREDTHS) / HUNDREDTHS;
  return rounded === 0 ? '0' : String(rounded);
}

/** Writes one order, a clip writing the orders it holds inside its own clip path. */
function printOrderSvg(order: PrintOrder, writer: PageWriter): string {
  if (order.kind !== 'clip') {
    return drawOrderSvg(order, writer);
  }
  return clippedSvg(order.shape, writer, () =>
    order.orders.map((held) => printOrderSvg(held, writer)).join(''),
  );
}

/** Writes some markup kept inside a shape by a clip path of the page, numbered before the markup is written so that clips are numbered in the order of the document. */
function clippedSvg(shape: PrintShape, writer: PageWriter, inner: () => string): string {
  const id = `${writer.prefix}-c${String(writer.clips.length)}`;
  writer.clips.push(`<clipPath id="${id}">${shapeSvg(shape, '')}</clipPath>`);
  return `<g clip-path="url(#${id})">${inner()}</g>`;
}

/** Writes an order that draws. */
function drawOrderSvg(order: DrawOrder, writer: PageWriter): string {
  if (order.kind === 'text') {
    return (
      `<text x="${svgNumber(order.x)}" y="${svgNumber(order.y)}" font-size="${svgNumber(order.size)}"` +
      ` font-weight="${String(order.weight)}" fill="${order.color}" text-anchor="${order.align}">` +
      `${escapeMarkup(order.text)}</text>`
    );
  }
  if (order.kind === 'pattern') {
    return patternOrderSvg(order, writer);
  }
  const opacity = order.opacity < 1 ? ` ${order.kind}-opacity="${svgNumber(order.opacity)}"` : '';
  if (order.kind === 'fill') {
    return shapeSvg(order.shape, `fill="${order.color}"${opacity}`);
  }
  const dash =
    order.dash.length > 0 ? ` stroke-dasharray="${order.dash.map(svgNumber).join(' ')}"` : '';
  return shapeSvg(
    order.shape,
    `fill="none" stroke="${order.color}" stroke-width="${svgNumber(order.width)}"${opacity}${dash}`,
  );
}

/** Writes a rectangle or a path with the paint attributes given, if any. */
function shapeSvg(shape: PrintShape, paint: string): string {
  const attributes = paint === '' ? '' : ` ${paint}`;
  if (shape.kind === 'path') {
    return `<path d="${pathData(shape.segments)}"${attributes}/>`;
  }
  return (
    `<rect x="${svgNumber(shape.x)}" y="${svgNumber(shape.y)}" width="${svgNumber(shape.width)}"` +
    ` height="${svgNumber(shape.height)}"${attributes}/>`
  );
}

/** Writes the flat numbers of a path as SVG path data. */
function pathData(segments: readonly number[]): string {
  return pathSegments(segments).map(segmentData).join('');
}

/** Writes one segment of a path as SVG path data. */
function segmentData(segment: PathSegment): string {
  if (segment.kind === 'close') {
    return 'Z';
  }
  const end = `${svgNumber(segment.x)} ${svgNumber(segment.y)}`;
  if (segment.kind === 'curve') {
    return (
      `C${svgNumber(segment.x1)} ${svgNumber(segment.y1)} ` +
      `${svgNumber(segment.x2)} ${svgNumber(segment.y2)} ${end}`
    );
  }
  return `${segment.kind === 'move' ? 'M' : 'L'}${end}`;
}

/** Writes the clip paths a page uses, or nothing when it uses none. */
function definitionsSvg(writer: PageWriter): string {
  return writer.clips.length === 0 ? '' : `<defs>${writer.clips.join('')}</defs>`;
}

/** Covers a shape with a tag pattern drawn as real lines or dots, tile by tile from the corner of the page as on screen, kept inside the shape and the page, so that the browser never turns it into an image. */
function patternOrderSvg(order: PatternOrder, writer: PageWriter): string {
  const corners = patternTileCorners(order.shape, writer.page);
  if (corners.length === 0) {
    return '';
  }
  const tile = patternTileOf(order.pattern);
  const data = corners.map((corner) => tileData(tile, corner)).join('');
  const ink = `"${PATTERN_INK_COLOR}"`;
  const opacity = `"${svgNumber(PATTERN_INK_OPACITY)}"`;
  const paint =
    tile.kind === 'dot'
      ? `fill=${ink} fill-opacity=${opacity}`
      : `fill="none" stroke=${ink} stroke-opacity=${opacity} stroke-width="${svgNumber(PATTERN_LINE_WIDTH)}"`;
  return clippedSvg(order.shape, writer, () => `<path d="${data}" ${paint}/>`);
}

/** Writes the dot, as two half circles, or the lines of one tile of a pattern at a corner as SVG path data. */
function tileData(tile: PatternTile, [left, top]: TileCorner): string {
  if (tile.kind === 'dot') {
    const radius = svgNumber(tile.radius);
    const diameter = svgNumber(tile.radius + tile.radius);
    const arc = `a${radius} ${radius} 0 1 0`;
    return (
      `M${svgNumber(left + tile.x - tile.radius)} ${svgNumber(top + tile.y)}` +
      `${arc} ${diameter} 0${arc} -${diameter} 0Z`
    );
  }
  return tile.lines
    .map(
      ([x1, y1, x2, y2]) =>
        `M${svgNumber(left + x1)} ${svgNumber(top + y1)}L${svgNumber(left + x2)} ${svgNumber(top + y2)}`,
    )
    .join('');
}
