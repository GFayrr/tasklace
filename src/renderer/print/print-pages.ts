import type { CompiledCalendar } from '../../core/calendar/compile-calendar';
import type { Dependency, Project, TaskId } from '../../core/model/project';
import type { PaperName, PaperOrientation } from '../../core/print/paper';
import {
  MIN_TEXT_POINTS,
  PATH_LINE,
  PATH_MOVE,
  type DrawOrder,
  type PrintDocument,
  type PrintOrder,
  type TextAlign,
  type TextWeight,
} from '../../core/print/print-document';
import {
  LEGEND_GAP,
  PRINT_ROW_HEIGHT,
  printLayout,
  type PrintLayout,
  type PrintLayoutRefusal,
  type PrintPage,
} from '../../core/print/print-layout';
import { failure, success, type Result } from '../../core/result';
import { valueAt } from '../../core/table-value';
import type { Schedule } from '../../core/scheduling/schedule-project';
import { dayIndexOf, startOfDay, type DayIndex, type ProjectHour } from '../../core/time';
import { fillMessage, type Messages } from '../i18n/messages';
import {
  buildPlanOutline,
  groupIncoming,
  NOTHING_COLLAPSED,
  predecessorText,
  type PlanOutline,
} from '../plan/plan-outline';
import { createTableFormatters, floatCells, taskCells } from '../plan/table-format';
import { tagsByName } from '../plan/tag-commands';
import { tagStylesOf, type TagStyle } from '../plan/tag-styles';
import {
  buildScaleTicks,
  createScaleLabels,
  pixelsPerHour,
  ZOOM_LEVELS,
  type ScaleLabels,
  type ZoomLevel,
} from '../plan/time-scale';
import { ROW_HEIGHT } from '../plan/timeline-geometry';
import { paintTimelineBody, type TimelineScene } from '../plan/timeline-painter';
import type { Theme } from '../theme/theme';
import { PrintCanvas, printPattern } from './print-canvas';
import { fitText, type MeasureText } from './print-text';

export type PrintColumn =
  'wbs' | 'start' | 'end' | 'duration' | 'progress' | 'predecessors' | 'floats';

export const PRINT_COLUMNS: readonly PrintColumn[] = [
  'wbs',
  'start',
  'end',
  'duration',
  'progress',
  'predecessors',
  'floats',
];

export type PrintZoomChoice = 'automatic' | ZoomLevel;

export type PrintPeriod =
  | { readonly kind: 'whole' }
  | { readonly kind: 'days'; readonly firstDay: DayIndex; readonly lastDay: DayIndex };

export interface PrintSettings {
  readonly paper: PaperName;
  readonly orientation: PaperOrientation;
  readonly period: PrintPeriod;
  readonly zoom: PrintZoomChoice;
  readonly columns: readonly PrintColumn[];
}

export interface PrintSource {
  readonly project: Project;
  readonly schedule: Schedule;
  readonly calendar: CompiledCalendar;
  readonly theme: Theme;
  readonly messages: Messages;
  readonly locale: string;
  readonly exportedAt: Date;
}

export interface PrintedPlan {
  readonly document: PrintDocument;
  readonly layout: PrintLayout;
  readonly zoom: ZoomLevel;
  readonly period: HourSpan;
}

export type PrintRefusal = PrintLayoutRefusal | 'EMPTY_PERIOD';

interface HourSpan {
  readonly start: ProjectHour;
  readonly end: ProjectHour;
}

interface PrintedColumn {
  readonly header: string;
  readonly cells: readonly string[];
  readonly left: number;
  readonly width: number;
  readonly align: TextAlign;
}

interface ColumnTable {
  readonly width: number;
  readonly columns: readonly PrintedColumn[];
  readonly name: PrintedColumn;
  readonly indents: readonly number[];
  readonly summaryRows: ReadonlySet<number>;
}

interface LegendItem {
  readonly label: string;
  readonly style: TagStyle | null;
  readonly width: number;
}

interface PageContext {
  readonly bandLinks: readonly (readonly Dependency[])[];
  readonly source: PrintSource;
  readonly layout: PrintLayout;
  readonly table: ColumnTable;
  readonly legend: readonly LegendItem[];
  readonly scene: TimelineScene;
  readonly period: HourSpan;
  readonly ticks: (from: ProjectHour, to: ProjectHour) => ReturnType<typeof buildScaleTicks>;
  readonly measure: MeasureText;
}

const PRINT_SCALE = PRINT_ROW_HEIGHT / ROW_HEIGHT;
const POINTS_PER_PIXEL = 0.75;
const TEXT_SIZE = MIN_TEXT_POINTS;
const TITLE_SIZE = 16;
const REGULAR: TextWeight = 400;
const SEMIBOLD: TextWeight = 600;
const TEXT_BASELINE = 11.5;
const TITLE_BASELINE = 14;
const DATE_BASELINE = 31;
const CELL_PADDING = 4;
const INDENT = 10;
const MAX_NAME_WIDTH = 220;
const SWATCH_WIDTH = 12;
const SWATCH_HEIGHT = 8;
const SWATCH_TOP = 4;
const SWATCH_GAP = 4;
const CRITICAL_KEY_HEIGHT = 3;
const CRITICAL_KEY_TOP = 7;
const LINE_WIDTH = 0.5;
const LABEL_PADDING = 4;
const HOURS_PER_DAY = 24;
const DAYS_PER_WEEK = 7;
const SHORTEST_MONTH_DAYS = 28;
const LONGEST_MONTH_DAYS = 31;
const HOURS_PER_HALF_DAY = 12;
const MONTHS_PER_YEAR = 12;
const SAMPLE_YEAR = 2026;
const MILLISECONDS_PER_HOUR = 3_600_000;
const MIDDLE_OF_MONTH = 15;
const SAMPLE_YEAR_START = Date.UTC(SAMPLE_YEAR, 0, 1) / MILLISECONDS_PER_HOUR;
const SHORTEST_UNIT_HOURS: Readonly<Record<ZoomLevel, number>> = {
  hour: 1,
  day: HOURS_PER_DAY,
  week: HOURS_PER_DAY * DAYS_PER_WEEK,
  month: HOURS_PER_DAY * SHORTEST_MONTH_DAYS,
};
const HALF = 2;

/** Lays a plan out on printed pages and draws all of them, or the first ones up to a limit for a preview: header, scale, columns, timeline rows without today line, selection, deadlines, baseline or conflicts, legend and page numbers. */
export function buildPrintDocument(
  source: PrintSource,
  settings: PrintSettings,
  measure: MeasureText,
  pageLimit: number = Number.POSITIVE_INFINITY,
): Result<PrintedPlan, PrintRefusal> {
  const period = printPeriod(source, settings.period);
  if (period === null) {
    return failure('EMPTY_PERIOD');
  }
  const outline = buildPlanOutline(source.project.tasks, NOTHING_COLLAPSED);
  const table = columnTable(source, settings.columns, outline, measure);
  const labels = createScaleLabels(source.locale);
  const smallestCells = smallestCellWidths(labels, measure);
  const legend = legendItems(source, outline, measure);
  const laid = printLayout({
    paper: settings.paper,
    orientation: settings.orientation,
    rowCount: outline.rows.length,
    columnsWidth: table.width,
    periodHours: period.end - period.start,
    zoom:
      settings.zoom === 'automatic'
        ? { kind: 'automatic', minPointsPerHour: smallestCells.month / SHORTEST_UNIT_HOURS.month }
        : { kind: 'fixed', pointsPerHour: pixelsPerHour(settings.zoom) * POINTS_PER_PIXEL },
    legendWidths: legend.map((item) => item.width),
  });
  if (!laid.ok) {
    return laid;
  }
  const layout = laid.value;
  const zoom =
    settings.zoom === 'automatic'
      ? finestLegibleZoom(smallestCells, layout.pointsPerHour)
      : settings.zoom;
  const context: PageContext = {
    bandLinks: linksByBand(
      source.project.dependencies,
      outline,
      layout.rowsPerPage,
      layout.pageRows,
    ),
    source,
    layout,
    table,
    legend,
    scene: printScene(source, outline, period, layout.pointsPerHour, zoom),
    period,
    ticks: (from, to) => buildScaleTicks(zoom, from, to, labels),
    measure,
  };
  const pages = layout.pages.slice(0, pageLimit).map((page) => pageOrders(context, page));
  return success({
    document: {
      paper: settings.paper,
      orientation: settings.orientation,
      title: source.project.name,
      pages,
    },
    layout,
    zoom,
    period,
  });
}

/** Returns the hours printed: the whole plan, or the chosen days, or null for days that end before they start. */
function printPeriod(source: PrintSource, period: PrintPeriod): HourSpan | null {
  const days = period.kind === 'days' ? period : wholePlanDays(source.project, source.schedule);
  return days.lastDay < days.firstDay
    ? null
    : { start: startOfDay(days.firstDay), end: startOfDay(days.lastDay + 1) };
}

/** Returns the days of a plan, from the day of its first start, or of the project start, to the day of its last end. */
export function wholePlanDays(
  project: Project,
  schedule: Schedule,
): { readonly firstDay: DayIndex; readonly lastDay: DayIndex } {
  let first = project.startDate;
  let last = project.startDate;
  for (const placement of schedule.placements.values()) {
    first = Math.min(first, placement.start);
    last = Math.max(last, placement.end);
  }
  const lastDay = last > startOfDay(dayIndexOf(last)) ? dayIndexOf(last) : dayIndexOf(last) - 1;
  const firstDay = dayIndexOf(first);
  return { firstDay, lastDay: Math.max(lastDay, firstDay) };
}

/** Builds the columns printed beside the timeline: the WBS when chosen, the names, always, then the other chosen columns in their usual order, each as wide as its widest text. */
function columnTable(
  source: PrintSource,
  chosen: readonly PrintColumn[],
  outline: PlanOutline,
  measure: MeasureText,
): ColumnTable {
  const { messages, project, schedule, calendar } = source;
  const formatters = createTableFormatters(source.locale);
  const rows = outline.rows;
  const cells = rows.map((row) => taskCells(row.task, schedule, calendar, formatters, messages));
  const showFloats = chosen.includes('floats') && schedule.floats !== null;
  const floats = rows.map((row) =>
    floatCells(schedule.floats?.get(row.task.id), formatters, messages),
  );
  const incoming = groupIncoming(project.dependencies);
  const contents: {
    header: string;
    cells: string[];
    align: TextAlign;
    kind: PrintColumn | 'total' | 'free';
  }[] = [];
  /** Adds a column when it was chosen. */
  const add = (
    kind: PrintColumn | 'total' | 'free',
    header: string,
    values: string[],
    align: TextAlign,
  ) => {
    contents.push({ header, cells: values, align, kind });
  };
  if (chosen.includes('wbs')) {
    add(
      'wbs',
      messages.table.wbs,
      rows.map((row) => row.wbs),
      'start',
    );
  }
  /** Tells whether a column was chosen. */
  const kept = (column: PrintColumn) => chosen.includes(column);
  if (kept('start')) {
    add(
      'start',
      messages.table.start,
      cells.map((cell) => cell.start),
      'start',
    );
  }
  if (kept('end')) {
    add(
      'end',
      messages.table.end,
      cells.map((cell) => cell.end),
      'start',
    );
  }
  if (kept('duration')) {
    add(
      'duration',
      messages.table.duration,
      cells.map((cell) => cell.duration),
      'end',
    );
  }
  if (kept('progress')) {
    add(
      'progress',
      messages.table.progress,
      cells.map((cell) => cell.progress),
      'end',
    );
  }
  if (kept('predecessors')) {
    add(
      'predecessors',
      messages.table.predecessors,
      rows.map((row) => predecessorText(incoming.get(row.task.id), outline.wbsById)),
      'start',
    );
  }
  if (showFloats) {
    add(
      'total',
      messages.table.totalFloat,
      floats.map((cell) => cell.total),
      'end',
    );
    add(
      'free',
      messages.table.freeFloat,
      floats.map((cell) => cell.free),
      'end',
    );
  }
  const indents = rows.map((row) => row.depth * INDENT);
  const summaryRows = new Set(
    rows.flatMap((row, index) => (row.task.kind === 'summary' ? [index] : [])),
  );
  const nameWidth =
    Math.min(
      MAX_NAME_WIDTH,
      Math.max(
        measure(messages.table.name, TEXT_SIZE, SEMIBOLD),
        ...rows.map(
          (row, index) =>
            (indents[index] ?? 0) +
            measure(row.task.name, TEXT_SIZE, summaryRows.has(index) ? SEMIBOLD : REGULAR),
        ),
      ),
    ) +
    CELL_PADDING * HALF;
  let left = 0;
  /** Places a column after those already placed. */
  const place = (
    header: string,
    values: readonly string[],
    align: TextAlign,
    width: number,
  ): PrintedColumn => {
    const column = { header, cells: values, left, width, align };
    left += width;
    return column;
  };
  /** Measures the widest text of a column, its header included. */
  const widthOf = (header: string, values: readonly string[]) =>
    Math.max(
      measure(header, TEXT_SIZE, SEMIBOLD),
      ...values.map((value) => measure(value, TEXT_SIZE, REGULAR)),
    ) +
    CELL_PADDING * HALF;
  const before = contents.filter((content) => content.kind === 'wbs');
  const after = contents.filter((content) => content.kind !== 'wbs');
  const placedBefore = before.map((content) =>
    place(content.header, content.cells, content.align, widthOf(content.header, content.cells)),
  );
  const name = place(
    messages.table.name,
    rows.map((row) => row.task.name),
    'start',
    nameWidth,
  );
  const placedAfter = after.map((content) =>
    place(content.header, content.cells, content.align, widthOf(content.header, content.cells)),
  );
  return {
    width: left,
    columns: [...placedBefore, name, ...placedAfter],
    name,
    indents,
    summaryRows,
  };
}

/** Measures, for each zoom, the narrowest cell of the lower row of the time scale that still holds its widest label. */
function smallestCellWidths(
  labels: ScaleLabels,
  measure: MeasureText,
): Readonly<Record<ZoomLevel, number>> {
  /** Returns the width a cell needs to hold the widest of some labels. */
  const cellFor = (texts: readonly string[]) =>
    Math.max(...texts.map((text) => measure(text, TEXT_SIZE, REGULAR))) + LABEL_PADDING * HALF;
  const hours = Array.from({ length: HOURS_PER_DAY }, (_unused, hour) =>
    labels.hourOfDay(SAMPLE_YEAR_START + hour),
  );
  const days = Array.from({ length: LONGEST_MONTH_DAYS }, (_unused, day) =>
    labels.dayOfMonth(SAMPLE_YEAR_START + day * HOURS_PER_DAY + HOURS_PER_HALF_DAY),
  );
  const months = Array.from({ length: MONTHS_PER_YEAR }, (_unused, month) =>
    labels.monthOfYear(Date.UTC(SAMPLE_YEAR, month, MIDDLE_OF_MONTH) / MILLISECONDS_PER_HOUR),
  );
  return { hour: cellFor(hours), day: cellFor(days), week: cellFor(days), month: cellFor(months) };
}

/** Returns the finest zoom whose labels fit their cells at a scale, or the month zoom when none does. */
function finestLegibleZoom(
  cells: Readonly<Record<ZoomLevel, number>>,
  pointsPerHour: number,
): ZoomLevel {
  return (
    ZOOM_LEVELS.find((zoom) => SHORTEST_UNIT_HOURS[zoom] * pointsPerHour >= cells[zoom]) ?? 'month'
  );
}

/** Lists the tags the plan uses, sorted by name, then the key of the critical path when it is on, with the width each takes in the legend. */
function legendItems(
  source: PrintSource,
  outline: PlanOutline,
  measure: MeasureText,
): LegendItem[] {
  const used = new Set(
    outline.rows.flatMap((row) =>
      row.task.kind === 'task' && row.task.tagId !== null ? [row.task.tagId] : [],
    ),
  );
  const styles = tagStylesOf(source.project);
  /** Measures the width a legend item takes: its swatch, a gap and its label. */
  const width = (label: string) => SWATCH_WIDTH + SWATCH_GAP + measure(label, TEXT_SIZE, REGULAR);
  const items: LegendItem[] = tagsByName(source.project.tags, source.locale)
    .filter((tag) => used.has(tag.id))
    .map((tag) => ({ label: tag.name, style: styles.get(tag.id) ?? null, width: width(tag.name) }));
  if (source.schedule.floats !== null) {
    const label = source.messages.status.critical;
    items.push({ label, style: null, width: width(label) });
  }
  return items;
}

/** Sorts the links into the rows of pages whose rows they reach or cross, so that each page looks only at its own links, in time proportional to the links and the rows of pages each one spans. */
function linksByBand(
  dependencies: readonly Dependency[],
  outline: PlanOutline,
  rowsPerPage: number,
  bandCount: number,
): Dependency[][] {
  const bands = Array.from({ length: bandCount }, (): Dependency[] => []);
  for (const dependency of dependencies) {
    const from = outline.rowIndexById.get(dependency.predecessorId);
    const to = outline.rowIndexById.get(dependency.successorId);
    if (from === undefined || to === undefined) {
      continue;
    }
    const last = Math.floor(Math.max(from, to) / rowsPerPage);
    for (let band = Math.floor(Math.min(from, to) / rowsPerPage); band <= last; band += 1) {
      bands[band]?.push(dependency);
    }
  }
  return bands;
}

/** Builds the scene of the timeline as printed: white paper, every row unfolded, nothing but bars, links, days off and the critical underline. */
function printScene(
  source: PrintSource,
  outline: PlanOutline,
  period: HourSpan,
  pointsPerHour: number,
  zoom: ZoomLevel,
): TimelineScene {
  return {
    frame: { origin: period.start, end: period.end, pixelsPerHour: pointsPerHour / PRINT_SCALE },
    zoom,
    rows: outline.rows,
    rowIndexById: outline.rowIndexById,
    schedule: source.schedule,
    dependencies: source.project.dependencies,
    calendar: source.calendar,
    nonWorkingPeriods: source.project.calendar.nonWorkingPeriods,
    theme: source.theme,
    tagStyles: tagStylesOf(source.project),
    conflictTaskIds: new Set<TaskId>(),
    deadlines: null,
    baseline: null,
    selectedTaskId: null,
    today: null,
    showFloatLines: false,
    preview: null,
    patternFor: printPattern,
  };
}

/** Draws one page: header, time scale, columns, timeline rows and footer. */
function pageOrders(context: PageContext, page: PrintPage): PrintOrder[] {
  return [
    ...headerOrders(context),
    ...scaleOrders(context, page),
    ...columnOrders(context, page),
    ...bodyOrders(context, page),
    ...gridOrders(context, page),
    ...footerOrders(context, page),
  ];
}

/** Writes the title of the project and the date of the export at the top of a page. */
function headerOrders(context: PageContext): DrawOrder[] {
  const { frame } = context.layout;
  const { source, measure } = context;
  const date = new Intl.DateTimeFormat(source.locale, { dateStyle: 'medium' }).format(
    source.exportedAt,
  );
  const title = fitText(source.project.name, frame.width, TITLE_SIZE, SEMIBOLD, measure);
  return [
    text(context, title, frame.left, frame.headerTop + TITLE_BASELINE, {
      size: TITLE_SIZE,
      weight: SEMIBOLD,
    }),
    text(
      context,
      fillMessage(source.messages.print.exported, { date }),
      frame.left,
      frame.headerTop + DATE_BASELINE,
      {
        color: source.theme.textSecondary,
      },
    ),
  ].flat();
}

/** Writes the two rows of the time scale over the timeline of a page, each label kept within its period and the page. */
function scaleOrders(context: PageContext, page: PrintPage): PrintOrder[] {
  const { frame } = context.layout;
  const { theme } = context.source;
  const start = context.period.start + page.timelineStart / context.layout.pointsPerHour;
  const end = start + page.timelineWidth / context.layout.pointsPerHour;
  const ticks = context.ticks(start, end);
  /** Places an instant across the timeline of the page. */
  const xOf = (hour: ProjectHour) =>
    frame.timelineLeft + (hour - start) * context.layout.pointsPerHour;
  const pageRight = frame.timelineLeft + page.timelineWidth;
  const lowerTop = frame.scaleTop + PRINT_ROW_HEIGHT;
  const orders: DrawOrder[] = [];
  for (const tick of ticks.upper) {
    const left = Math.max(xOf(tick.start), frame.timelineLeft);
    const right = Math.min(xOf(tick.end), pageRight);
    orders.push(line(theme.border, right, frame.scaleTop, right, lowerTop));
    const label = fitText(
      tick.label,
      right - left - LABEL_PADDING * HALF,
      TEXT_SIZE,
      SEMIBOLD,
      context.measure,
    );
    orders.push(
      ...text(context, label, left + LABEL_PADDING, frame.scaleTop + TEXT_BASELINE, {
        weight: SEMIBOLD,
      }),
    );
  }
  for (const tick of ticks.lower) {
    const left = xOf(tick.start);
    const right = xOf(tick.end);
    if (left >= frame.timelineLeft) {
      orders.push(line(theme.border, left, lowerTop, left, frame.rowsTop));
    }
    const shownLeft = Math.max(left, frame.timelineLeft);
    const shownRight = Math.min(right, pageRight);
    if (
      context.measure(tick.label, TEXT_SIZE, REGULAR) + LABEL_PADDING * HALF <=
      shownRight - shownLeft
    ) {
      orders.push(
        ...text(context, tick.label, (shownLeft + shownRight) / HALF, lowerTop + TEXT_BASELINE, {
          color: theme.textSecondary,
          align: 'middle',
        }),
      );
    }
  }
  return orders;
}

/** Writes the headers and the cells of the printed columns for the rows of a page, names indented by level and summaries in bold. */
function columnOrders(context: PageContext, page: PrintPage): DrawOrder[] {
  const { frame } = context.layout;
  const { table, measure } = context;
  const orders: DrawOrder[] = [];
  const headerBaseline = frame.scaleTop + PRINT_ROW_HEIGHT + TEXT_BASELINE;
  for (const column of table.columns) {
    const inner = column.width - CELL_PADDING * HALF;
    const x =
      column.align === 'end'
        ? frame.left + column.left + column.width - CELL_PADDING
        : frame.left + column.left + CELL_PADDING;
    orders.push(
      ...text(
        context,
        fitText(column.header, inner, TEXT_SIZE, SEMIBOLD, measure),
        x,
        headerBaseline,
        { weight: SEMIBOLD, align: column.align },
      ),
    );
    for (let offset = 0; offset < page.rowCount; offset += 1) {
      const row = page.firstRow + offset;
      const isName = column === table.name;
      const indent = isName ? (table.indents[row] ?? 0) : 0;
      const weight = isName && table.summaryRows.has(row) ? SEMIBOLD : REGULAR;
      const value = fitText(column.cells[row] ?? '', inner - indent, TEXT_SIZE, weight, measure);
      const baseline = frame.rowsTop + offset * PRINT_ROW_HEIGHT + TEXT_BASELINE;
      orders.push(...text(context, value, x + indent, baseline, { weight, align: column.align }));
    }
  }
  return orders;
}

/** Draws the rows of the timeline of a page with the painter of the screen, scaled to the printed rows and kept within the timeline of the page. */
function bodyOrders(context: PageContext, page: PrintPage): PrintOrder[] {
  const { frame } = context.layout;
  const area = {
    x: frame.timelineLeft,
    y: frame.rowsTop,
    width: page.timelineWidth,
    height: page.rowCount * PRINT_ROW_HEIGHT,
  };
  const canvas = new PrintCanvas(area);
  const drawing = canvas.context;
  drawing.beginPath();
  drawing.roundRect(area.x, area.y, area.width, area.height, 0);
  drawing.clip();
  drawing.translate(area.x, area.y);
  drawing.scale(PRINT_SCALE, PRINT_SCALE);
  const band = Math.floor(page.firstRow / context.layout.rowsPerPage);
  const scene = { ...context.scene, dependencies: context.bandLinks[band] ?? [] };
  paintTimelineBody(drawing, scene, {
    left: page.timelineStart / PRINT_SCALE,
    top: page.firstRow * ROW_HEIGHT,
    width: page.timelineWidth / PRINT_SCALE,
    height: page.rowCount * ROW_HEIGHT,
  });
  return canvas.orders();
}

/** Draws the lines that frame the columns: under the scale, between the columns and the timeline, and under each row of the columns. */
function gridOrders(context: PageContext, page: PrintPage): DrawOrder[] {
  const { frame } = context.layout;
  const { theme } = context.source;
  const right = frame.timelineLeft + page.timelineWidth;
  const bottom = frame.rowsTop + page.rowCount * PRINT_ROW_HEIGHT;
  const orders = [
    line(theme.border, frame.left, frame.rowsTop, right, frame.rowsTop),
    line(theme.border, frame.timelineLeft, frame.scaleTop, frame.timelineLeft, bottom),
  ];
  for (let offset = 1; offset <= page.rowCount; offset += 1) {
    const y = frame.rowsTop + offset * PRINT_ROW_HEIGHT;
    orders.push(line(theme.gridLine, frame.left, y, frame.timelineLeft, y));
  }
  return orders;
}

/** Writes the legend and the number of the page at the bottom of a page. */
function footerOrders(context: PageContext, page: PrintPage): DrawOrder[] {
  const { frame } = context.layout;
  const { source } = context;
  const orders: DrawOrder[] = [];
  frame.legendLines.forEach((items, lineIndex) => {
    const top = frame.footerTop + lineIndex * PRINT_ROW_HEIGHT;
    let x = frame.left;
    for (const index of items) {
      const item = valueAt(context.legend, index);
      orders.push(...swatchOrders(source.theme, item, x, top));
      orders.push(
        ...text(
          context,
          fitText(
            item.label,
            frame.legendWidth - SWATCH_WIDTH - SWATCH_GAP,
            TEXT_SIZE,
            REGULAR,
            context.measure,
          ),
          x + SWATCH_WIDTH + SWATCH_GAP,
          top + TEXT_BASELINE,
          {},
        ),
      );
      x += item.width + LEGEND_GAP;
    }
  });
  const pageText = fillMessage(source.messages.print.page, {
    page: String(page.number),
    count: String(context.layout.pages.length),
  });
  orders.push(
    ...text(context, pageText, frame.left + frame.width, frame.footerTop + TEXT_BASELINE, {
      align: 'end',
      color: source.theme.textSecondary,
    }),
  );
  return orders;
}

/** Draws the swatch of a legend item: the color and pattern of a tag, or the underline of the critical path. */
function swatchOrders(theme: Theme, item: LegendItem, x: number, top: number): DrawOrder[] {
  if (item.style === null) {
    return [fill(theme.action, x, top + CRITICAL_KEY_TOP, SWATCH_WIDTH, CRITICAL_KEY_HEIGHT)];
  }
  const shape = {
    kind: 'rect',
    x,
    y: top + SWATCH_TOP,
    width: SWATCH_WIDTH,
    height: SWATCH_HEIGHT,
  } as const;
  const swatch: DrawOrder[] = [
    { kind: 'fill', shape, color: item.style.color.toLowerCase(), opacity: 1 },
  ];
  if (item.style.pattern !== null) {
    swatch.push({ kind: 'pattern', shape, pattern: item.style.pattern });
  }
  return swatch;
}

/** Writes a line of text at the printed size, or nothing for an empty text. */
function text(
  context: PageContext,
  value: string,
  x: number,
  y: number,
  look: {
    readonly size?: number;
    readonly weight?: TextWeight;
    readonly color?: string;
    readonly align?: TextAlign;
  },
): DrawOrder[] {
  if (value.trim() === '') {
    return [];
  }
  return [
    {
      kind: 'text',
      x,
      y,
      text: value,
      size: look.size ?? TEXT_SIZE,
      weight: look.weight ?? REGULAR,
      color: (look.color ?? context.source.theme.text).toLowerCase(),
      align: look.align ?? 'start',
    },
  ];
}

/** Draws a thin straight line in a color. */
function line(color: string, x1: number, y1: number, x2: number, y2: number): DrawOrder {
  return {
    kind: 'stroke',
    shape: { kind: 'path', segments: [PATH_MOVE, x1, y1, PATH_LINE, x2, y2] },
    color: color.toLowerCase(),
    opacity: 1,
    width: LINE_WIDTH,
    dash: [],
  };
}

/** Fills a rectangle with a color. */
function fill(color: string, x: number, y: number, width: number, height: number): DrawOrder {
  return {
    kind: 'fill',
    shape: { kind: 'rect', x, y, width, height },
    color: color.toLowerCase(),
    opacity: 1,
  };
}
