import { MAX_PRINT_PAGES, UNITS_PER_KIBI } from '../limits';
import { failure, success, type Result } from '../result';
import { pageSizeOf, type PageSize, type PaperName, type PaperOrientation } from './paper';

export const PAGE_MARGIN = 28;
export const HEADER_HEIGHT = 40;
export const PRINT_ROW_HEIGHT = 16;
const SCALE_ROWS = 2;
export const SCALE_HEIGHT = PRINT_ROW_HEIGHT * SCALE_ROWS;
export const FOOTER_GAP = 8;
export const FOOTER_LINE_HEIGHT = 16;
export const PAGE_NUMBER_WIDTH = 80;
export const LEGEND_GAP = 12;
export const MIN_TIMELINE_WIDTH = 128;

const POINT_TOLERANCE = 1 / UNITS_PER_KIBI;
const SIDES = 2;

export type PrintZoom =
  | { readonly kind: 'automatic'; readonly minPointsPerHour: number }
  | { readonly kind: 'fixed'; readonly pointsPerHour: number };

export interface PrintLayoutRequest {
  readonly paper: PaperName;
  readonly orientation: PaperOrientation;
  readonly rowCount: number;
  readonly columnsWidth: number;
  readonly periodHours: number;
  readonly zoom: PrintZoom;
  readonly legendWidths: readonly number[];
}

export interface PrintFrame {
  readonly page: PageSize;
  readonly left: number;
  readonly width: number;
  readonly headerTop: number;
  readonly scaleTop: number;
  readonly rowsTop: number;
  readonly footerTop: number;
  readonly timelineLeft: number;
  readonly timelineWidth: number;
  readonly legendWidth: number;
  readonly legendLines: readonly (readonly number[])[];
}

export interface PrintPage {
  readonly number: number;
  readonly firstRow: number;
  readonly rowCount: number;
  readonly timelineStart: number;
  readonly timelineWidth: number;
}

export interface PrintLayout {
  readonly frame: PrintFrame;
  readonly pointsPerHour: number;
  readonly rowsPerPage: number;
  readonly pageColumns: number;
  readonly pageRows: number;
  readonly pages: readonly PrintPage[];
}

export type PrintLayoutRefusal = 'NO_ROOM_FOR_TIMELINE' | 'NO_ROOM_FOR_ROWS' | 'TOO_MANY_PAGES';

/** Lays a plan out on pages with text at its printed size: one page when all fits, else a grid read row of pages by row of pages, each repeating the columns and the scale, the last column taking the rest of the period, in time linear in the pages. */
export function printLayout(request: PrintLayoutRequest): Result<PrintLayout, PrintLayoutRefusal> {
  checkRequest(request);
  const frame = printFrame(request);
  if (frame.timelineWidth < MIN_TIMELINE_WIDTH) {
    return failure('NO_ROOM_FOR_TIMELINE');
  }
  const rowsPerPage = Math.floor((frame.footerTop - FOOTER_GAP - frame.rowsTop) / PRINT_ROW_HEIGHT);
  if (rowsPerPage < 1) {
    return failure('NO_ROOM_FOR_ROWS');
  }
  const pointsPerHour = pointsPerHourOf(request.zoom, frame.timelineWidth / request.periodHours);
  const totalWidth = request.periodHours * pointsPerHour;
  const pageColumns = Math.max(1, Math.ceil((totalWidth - POINT_TOLERANCE) / frame.timelineWidth));
  const pageRows = Math.max(1, Math.ceil(request.rowCount / rowsPerPage));
  if (pageColumns * pageRows > MAX_PRINT_PAGES) {
    return failure('TOO_MANY_PAGES');
  }
  const pages: PrintPage[] = [];
  for (let row = 0; row < pageRows; row += 1) {
    const firstRow = row * rowsPerPage;
    for (let column = 0; column < pageColumns; column += 1) {
      const timelineStart = column * frame.timelineWidth;
      pages.push({
        number: pages.length + 1,
        firstRow,
        rowCount: Math.min(rowsPerPage, request.rowCount - firstRow),
        timelineStart,
        timelineWidth:
          column === pageColumns - 1 ? totalWidth - timelineStart : frame.timelineWidth,
      });
    }
  }
  return success({ frame, pointsPerHour, rowsPerPage, pageColumns, pageRows, pages });
}

/** Places the header, the time scale, the rows and the footer on a page, the footer growing with the lines the legend needs. */
function printFrame(request: PrintLayoutRequest): PrintFrame {
  const page = pageSizeOf(request.paper, request.orientation);
  const width = page.width - PAGE_MARGIN * SIDES;
  const legendWidth = width - PAGE_NUMBER_WIDTH;
  const legendLines = wrapLegend(request.legendWidths, legendWidth);
  const footerTop = page.height - PAGE_MARGIN - legendLines.length * FOOTER_LINE_HEIGHT;
  const scaleTop = PAGE_MARGIN + HEADER_HEIGHT;
  return {
    page,
    left: PAGE_MARGIN,
    width,
    headerTop: PAGE_MARGIN,
    scaleTop,
    rowsTop: scaleTop + SCALE_HEIGHT,
    footerTop,
    timelineLeft: PAGE_MARGIN + request.columnsWidth,
    timelineWidth: width - request.columnsWidth,
    legendWidth,
    legendLines,
  };
}

/** Wraps the items of the legend into lines of a given width, in order, an item wider than a line standing alone on its line, and returns one empty line when there is no item. */
export function wrapLegend(
  itemWidths: readonly number[],
  lineWidth: number,
): (readonly number[])[] {
  let line: number[] = [];
  const lines: number[][] = [line];
  let used = 0;
  itemWidths.forEach((itemWidth, index) => {
    const needed = line.length === 0 ? itemWidth : used + LEGEND_GAP + itemWidth;
    if (line.length > 0 && needed > lineWidth) {
      line = [index];
      lines.push(line);
      used = itemWidth;
      return;
    }
    line.push(index);
    used = needed;
  });
  return lines;
}

/** Returns the points an hour takes: the chosen zoom, or for the automatic zoom the width that fits the whole period on the page, never below the smallest legible scale. */
function pointsPerHourOf(zoom: PrintZoom, fittingPointsPerHour: number): number {
  return zoom.kind === 'fixed'
    ? zoom.pointsPerHour
    : Math.max(fittingPointsPerHour, zoom.minPointsPerHour);
}

/** Throws when a request holds values that the interface never asks for, a programming error rather than a choice of the user. */
function checkRequest(request: PrintLayoutRequest): void {
  const scale =
    request.zoom.kind === 'fixed' ? request.zoom.pointsPerHour : request.zoom.minPointsPerHour;
  const valid =
    Number.isSafeInteger(request.rowCount) &&
    request.rowCount >= 0 &&
    isPositive(request.periodHours) &&
    isPositive(scale) &&
    Number.isFinite(request.columnsWidth) &&
    request.columnsWidth >= 0 &&
    request.legendWidths.every((itemWidth) => Number.isFinite(itemWidth) && itemWidth >= 0);
  if (!valid) {
    throw new RangeError('Invalid print layout request.');
  }
}

/** Tells whether a value is a finite number above zero. */
function isPositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}
