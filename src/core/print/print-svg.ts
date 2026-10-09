import type { TagPattern } from '../tags/tag-appearance';
import { pageSizeOf } from './paper';
import {
  PATTERN_INK_COLOR,
  PATTERN_INK_OPACITY,
  PATTERN_LINE_WIDTH,
  PATTERN_TILE_SIZE,
  patternTileOf,
} from './pattern-tiles';
import {
  pathSegments,
  type DrawOrder,
  type PathSegment,
  type PrintDocument,
  type PrintOrder,
  type PrintShape,
} from './print-document';

export const PRINT_FONT_FAMILY = 'Jost';

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
  readonly patterns: Set<TagPattern>;
  readonly clips: string[];
}

/** Writes one page of a validated document as an SVG image sized in points, its identifiers starting with the page number so that several pages can share one HTML page. */
export function printPageSvg(document: PrintDocument, pageIndex: number): string {
  const orders = document.pages[pageIndex];
  if (orders === undefined) {
    throw new RangeError(`No page ${String(pageIndex)} to write.`);
  }
  const size = pageSizeOf(document.paper, document.orientation);
  const writer: PageWriter = { prefix: `p${String(pageIndex)}`, patterns: new Set(), clips: [] };
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
  const id = `${writer.prefix}-c${String(writer.clips.length)}`;
  writer.clips.push(
    `<clipPath id="${id}"><rect x="${svgNumber(order.x)}" y="${svgNumber(order.y)}"` +
      ` width="${svgNumber(order.width)}" height="${svgNumber(order.height)}"/></clipPath>`,
  );
  const inner = order.orders.map((drawn) => drawOrderSvg(drawn, writer)).join('');
  return `<g clip-path="url(#${id})">${inner}</g>`;
}

/** Writes an order that draws, noting the patterns it uses. */
function drawOrderSvg(order: DrawOrder, writer: PageWriter): string {
  if (order.kind === 'text') {
    return (
      `<text x="${svgNumber(order.x)}" y="${svgNumber(order.y)}" font-size="${svgNumber(order.size)}"` +
      ` font-weight="${String(order.weight)}" fill="${order.color}" text-anchor="${order.align}">` +
      `${escapeMarkup(order.text)}</text>`
    );
  }
  if (order.kind === 'pattern') {
    writer.patterns.add(order.pattern);
    return shapeSvg(order.shape, `fill="url(#${writer.prefix}-${order.pattern})"`);
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

/** Writes a rectangle or a path with the paint attributes given. */
function shapeSvg(shape: PrintShape, paint: string): string {
  if (shape.kind === 'path') {
    return `<path d="${pathData(shape.segments)}" ${paint}/>`;
  }
  return (
    `<rect x="${svgNumber(shape.x)}" y="${svgNumber(shape.y)}" width="${svgNumber(shape.width)}"` +
    ` height="${svgNumber(shape.height)}" ${paint}/>`
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

/** Writes the clip paths and patterns a page uses, or nothing when it uses none. */
function definitionsSvg(writer: PageWriter): string {
  if (writer.clips.length === 0 && writer.patterns.size === 0) {
    return '';
  }
  const patterns = [...writer.patterns].map((pattern) => patternSvg(pattern, writer.prefix));
  return `<defs>${writer.clips.join('')}${patterns.join('')}</defs>`;
}

/** Writes a tag pattern as a tile repeated from the corner of the page, drawn like the tile of the timeline on screen. */
function patternSvg(pattern: TagPattern, prefix: string): string {
  const tile = patternTileOf(pattern);
  const size = svgNumber(PATTERN_TILE_SIZE);
  const ink = `"${PATTERN_INK_COLOR}"`;
  const opacity = svgNumber(PATTERN_INK_OPACITY);
  const content =
    tile.kind === 'dot'
      ? `<circle cx="${svgNumber(tile.x)}" cy="${svgNumber(tile.y)}" r="${svgNumber(tile.radius)}"` +
        ` fill=${ink} fill-opacity="${opacity}"/>`
      : `<path d="${tile.lines.map(([x1, y1, x2, y2]) => `M${svgNumber(x1)} ${svgNumber(y1)}L${svgNumber(x2)} ${svgNumber(y2)}`).join('')}"` +
        ` fill="none" stroke=${ink} stroke-opacity="${opacity}" stroke-width="${svgNumber(PATTERN_LINE_WIDTH)}"/>`;
  return (
    `<pattern id="${prefix}-${pattern}" width="${size}" height="${size}"` +
    ` patternUnits="userSpaceOnUse">${content}</pattern>`
  );
}
