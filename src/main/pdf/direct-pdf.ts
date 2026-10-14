import PDFDocument from 'pdfkit';
import { MAX_PDF_BYTES } from '../../core/limits';
import { pageSizeOf, type PageSize } from '../../core/print/paper';
import {
  pathSegments,
  TEXT_WEIGHTS,
  type DrawOrder,
  type PrintOrder,
  type PrintShape,
  type TextWeight,
} from '../../core/print/print-document';
import type { CheckedPrintDocument } from '../../core/print/read-print-document';
import {
  PATTERN_INK_COLOR,
  PATTERN_INK_OPACITY,
  PATTERN_LINE_WIDTH,
  patternTileCorners,
  patternTileOf,
  type PatternTile,
} from '../../core/print/pattern-tiles';
import type { TagPattern } from '../../core/tags/tag-appearance';

export type PrintFonts = Readonly<Record<TextWeight, string>>;

/** A refusal of a document whose PDF made without the browser would be larger than a PDF may be. */
export class TooLargePdf extends Error {
  /** Tells how many bytes the PDF was allowed. */
  constructor(readonly limit: number) {
    super(`The lighter PDF would be larger than ${String(limit)} bytes.`);
    this.name = 'TooLargePdf';
  }
}

/** A refusal of a document holding a character that the printed weights of Jost do not have, which a PDF made without the browser would leave blank. */
export class MissingCharacter extends Error {
  /** Tells which character the printed font lacks. */
  constructor(readonly character: string) {
    super(
      `The printed font has no glyph for U+${(character.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}.`,
    );
    this.name = 'MissingCharacter';
  }
}

interface GlyphSource {
  readonly _font?: {
    readonly font?: { readonly hasGlyphForCodePoint?: (codePoint: number) => boolean };
  };
}

interface Drawing {
  readonly pdf: PDFKit.PDFDocument;
  readonly page: PageSize;
}

const PRODUCER = 'Tasklace';
const HALF = 2;

/** Writes a checked document as a PDF without the browser, drawn as its SVG is, texts in Jost Print embedded as subsets, in time linear in the orders and pattern tiles, refusing a character the font lacks or a PDF too large. */
export async function writeDirectPdf(
  document: CheckedPrintDocument,
  fonts: PrintFonts,
  compress = true,
): Promise<Uint8Array> {
  const size = pageSizeOf(document.paper, document.orientation);
  const pdf = new PDFDocument({
    autoFirstPage: false,
    compress,
    font: fonts[400],
    info: { Title: document.title, Creator: PRODUCER, Producer: PRODUCER },
  });
  for (const weight of TEXT_WEIGHTS) {
    pdf.registerFont(fontName(weight), fonts[weight]);
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  const finished = new Promise<void>((resolve, reject) => {
    pdf.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_PDF_BYTES) {
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    pdf.on('end', resolve);
    pdf.on('error', reject);
  });
  const drawing: Drawing = { pdf, page: size };
  for (const orders of document.pages) {
    pdf.addPage({ size: [size.width, size.height], margin: 0 });
    for (const order of orders) {
      drawOrder(drawing, order);
    }
  }
  pdf.end();
  await finished;
  if (bytes > MAX_PDF_BYTES) {
    throw new TooLargePdf(MAX_PDF_BYTES);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

/** Returns the name a Jost Print weight is registered under in the PDF document. */
function fontName(weight: TextWeight): string {
  return `Jost Print ${String(weight)}`;
}

/** Draws one order, a clip drawing the orders it holds inside its shape. */
function drawOrder(drawing: Drawing, order: PrintOrder): void {
  const { pdf } = drawing;
  if (order.kind !== 'clip') {
    drawDrawing(drawing, order);
    return;
  }
  pdf.save();
  trace(pdf, order.shape);
  pdf.clip();
  for (const held of order.orders) {
    drawOrder(drawing, held);
  }
  pdf.restore();
}

/** Draws an order that fills, strokes, covers with a pattern or writes, its color, width and dash being set before its path is traced, since the PDF format requires a path to be painted right after it. */
function drawDrawing(drawing: Drawing, order: DrawOrder): void {
  const { pdf } = drawing;
  if (order.kind === 'text') {
    pdf.font(fontName(order.weight)).fontSize(order.size).fillColor(order.color, 1);
    checkCharacters(pdf, order.text);
    const width = pdf.widthOfString(order.text);
    const shift = order.align === 'start' ? 0 : order.align === 'middle' ? width / HALF : width;
    pdf.text(order.text, order.x - shift, order.y, { baseline: 'alphabetic', lineBreak: false });
    return;
  }
  if (order.kind === 'pattern') {
    drawPattern(drawing, order.shape, order.pattern);
    return;
  }
  if (order.kind === 'fill') {
    pdf.fillColor(order.color, order.opacity);
    trace(pdf, order.shape);
    pdf.fill();
    return;
  }
  pdf.lineWidth(order.width).strokeColor(order.color, order.opacity);
  if (order.dash.length > 0) {
    pdf.dash(order.dash);
  }
  trace(pdf, order.shape);
  pdf.stroke();
  pdf.undash();
}

/** Throws when the current font lacks a character of a text, read from the font PDFKit loaded since PDFKit offers no public way to ask, failing loudly if a new version of PDFKit no longer holds it there. */
function checkCharacters(pdf: PDFKit.PDFDocument, text: string): void {
  const font = (pdf as unknown as GlyphSource)._font?.font;
  const hasGlyph = font?.hasGlyphForCodePoint?.bind(font);
  if (hasGlyph === undefined) {
    throw new TypeError('PDFKit no longer tells which characters its font holds.');
  }
  const missing = Array.from(text).find((character) => !hasGlyph(character.codePointAt(0) ?? 0));
  if (missing !== undefined) {
    throw new MissingCharacter(missing);
  }
}

/** Traces the shape of an order as the current path. */
function trace(pdf: PDFKit.PDFDocument, shape: PrintShape): void {
  if (shape.kind === 'rect') {
    pdf.rect(shape.x, shape.y, shape.width, shape.height);
    return;
  }
  for (const segment of pathSegments(shape.segments)) {
    if (segment.kind === 'close') {
      pdf.closePath();
    } else if (segment.kind === 'curve') {
      pdf.bezierCurveTo(segment.x1, segment.y1, segment.x2, segment.y2, segment.x, segment.y);
    } else if (segment.kind === 'move') {
      pdf.moveTo(segment.x, segment.y);
    } else {
      pdf.lineTo(segment.x, segment.y);
    }
  }
}

/** Covers a shape with a tag pattern drawn as real lines or dots, tile by tile from the corner of the page as the SVG does, kept inside the shape and the page, a checked document never needing more tiles than allowed. */
function drawPattern(drawing: Drawing, shape: PrintShape, pattern: TagPattern): void {
  const { pdf } = drawing;
  const tile = patternTileOf(pattern);
  const corners = patternTileCorners(shape, drawing.page);
  pdf.save();
  trace(pdf, shape);
  pdf.clip();
  if (tile.kind === 'dot') {
    pdf.fillColor(PATTERN_INK_COLOR, PATTERN_INK_OPACITY);
  } else {
    pdf.lineWidth(PATTERN_LINE_WIDTH).strokeColor(PATTERN_INK_COLOR, PATTERN_INK_OPACITY);
  }
  for (const [left, top] of corners) {
    traceTile(pdf, tile, left, top);
  }
  if (tile.kind === 'dot') {
    pdf.fill();
  } else {
    pdf.stroke();
  }
  pdf.restore();
}

/** Adds to the current path the dot or the lines of one tile of a pattern at a corner. */
function traceTile(pdf: PDFKit.PDFDocument, tile: PatternTile, left: number, top: number): void {
  if (tile.kind === 'dot') {
    pdf.circle(left + tile.x, top + tile.y, tile.radius);
    return;
  }
  for (const [x1, y1, x2, y2] of tile.lines) {
    pdf.moveTo(left + x1, top + y1).lineTo(left + x2, top + y2);
  }
}
