import type { CompiledCalendar } from '../../core/calendar/compile-calendar';
import { isWorkingDay } from '../../core/calendar/working-time';
import type { DayRange } from '../../core/model/calendar';
import type { Dependency, TagId, TaskId } from '../../core/model/project';
import type { Schedule } from '../../core/scheduling/schedule-project';
import type { TagPattern } from '../../core/tags/tag-appearance';
import {
  dayIndexOf,
  fromQuarters,
  HOURS_PER_DAY,
  QUARTER_HOUR,
  QUARTERS_PER_DAY,
  startOfDay,
  type ProjectHour,
} from '../../core/time';
import type { Theme } from '../theme/theme';
import type { PlanRow } from './plan-outline';
import { paleColor, type TagStyle } from './tag-styles';
import type { ScaleTicks, ZoomLevel } from './time-scale';
import {
  LINK_HANDLE_RADIUS,
  linkHandleCenter,
  linkHandles,
  type DragPreview,
} from './timeline-gestures';
import {
  BAR_HEIGHT,
  dependencyArrow,
  hourAt,
  MILESTONE_SIZE,
  ROW_HEIGHT,
  rowShape,
  SUMMARY_HEIGHT,
  xOf,
  type Point,
  type RowShape,
  type TimelineFrame,
} from './timeline-geometry';

export interface Viewport {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface TimelineScene {
  readonly frame: TimelineFrame;
  readonly zoom: ZoomLevel;
  readonly rows: readonly PlanRow[];
  readonly rowIndexById: ReadonlyMap<TaskId, number>;
  readonly schedule: Schedule | null;
  readonly dependencies: readonly Dependency[];
  readonly calendar: CompiledCalendar | null;
  readonly nonWorkingPeriods: readonly DayRange[];
  readonly theme: Theme;
  readonly tagStyles: ReadonlyMap<TagId, TagStyle>;
  readonly conflictTaskIds: ReadonlySet<TaskId>;
  readonly selectedTaskId: TaskId | null;
  readonly today: ProjectHour;
  readonly preview: DragPreview | null;
  readonly patternFor: (pattern: TagPattern) => CanvasPattern | null;
}

export interface RowRange {
  readonly first: number;
  readonly last: number;
}

export interface HourInterval {
  readonly start: ProjectHour;
  readonly end: ProjectHour;
}

interface PixelInterval {
  readonly start: number;
  readonly end: number;
}

interface BarLook {
  readonly color: string;
  readonly pale: string;
  readonly pattern: CanvasPattern | null;
  readonly top: number;
  readonly outlined: boolean;
}

const HALF = 2;
const BAR_RADIUS = 5;
const SUMMARY_TIP = 6;
const ARROW_HEAD = 5;
const ARROW_WIDTH = 1.5;
const OUTLINE_WIDTH = 2;
const TODAY_WIDTH = 2;
const PREVIEW_DASH = [4, 3];
const HALF_PIXEL = 0.5;
const DAY_OFF_HEIGHT = 6;
const SPLIT_GAP_DASH = [2, 3];
const BLOCK_TARGET_MARGIN = 3;
const SPLIT_GAP_WIDTH = 1.5;
const SCALE_ROW_HEIGHT = 24;
const LABEL_PADDING = 6;
const UPPER_FONT = '600 12px Jost, "Segoe UI", sans-serif';
const LOWER_FONT = '11px Jost, "Segoe UI", sans-serif';

/** Returns the rows that a viewport shows, at least partly. */
export function visibleRows(viewport: Viewport, rowCount: number): RowRange {
  const first = Math.max(0, Math.floor(viewport.top / ROW_HEIGHT));
  const last = Math.min(rowCount - 1, Math.floor((viewport.top + viewport.height) / ROW_HEIGHT));
  return { first, last };
}

/** Lists the non-working periods between two instants: whole days off and, at the hour zoom, the hours outside the working hours; at the month zoom, where a day is only a few pixels wide, only the periods off entered by the user. */
export function nonWorkingIntervals(
  calendar: CompiledCalendar,
  periods: readonly DayRange[],
  from: ProjectHour,
  to: ProjectHour,
  zoom: ZoomLevel,
): HourInterval[] {
  if (zoom === 'month') {
    return mergeIntervals(
      [...periods]
        .sort((left, right) => left.firstDay - right.firstDay)
        .map((period) => ({
          start: startOfDay(period.firstDay),
          end: startOfDay(period.lastDay + 1),
        }))
        .filter((interval) => interval.end > from && interval.start < to),
    );
  }
  const intervals: HourInterval[] = [];
  for (let day = dayIndexOf(from); startOfDay(day) < to; day += 1) {
    const dayStart = startOfDay(day);
    if (!isWorkingDay(calendar, day)) {
      intervals.push({ start: dayStart, end: dayStart + HOURS_PER_DAY });
    } else if (zoom === 'hour') {
      intervals.push(...offHours(calendar.workingQuartersOfDay, dayStart));
    }
  }
  return mergeIntervals(intervals);
}

/** Splits a time span into the parts on working days and the whole days off between them, such as a weekend inside a task. */
export function splitAtDaysOff(
  calendar: CompiledCalendar,
  start: ProjectHour,
  end: ProjectHour,
): { readonly parts: HourInterval[]; readonly daysOff: HourInterval[] } {
  const parts: HourInterval[] = [];
  const daysOff: HourInterval[] = [];
  let partStart = start;
  for (let day = dayIndexOf(start); startOfDay(day) < end; day += 1) {
    if (isWorkingDay(calendar, day)) {
      continue;
    }
    const offStart = Math.max(start, startOfDay(day));
    const offEnd = Math.min(end, startOfDay(day + 1));
    if (offStart > partStart) {
      parts.push({ start: partStart, end: offStart });
    }
    daysOff.push({ start: offStart, end: offEnd });
    partStart = offEnd;
  }
  if (partStart < end) {
    parts.push({ start: partStart, end });
  }
  return { parts, daysOff: mergeIntervals(daysOff) };
}

/** Draws the rows of the timeline that a viewport shows: non-working periods, selection, bars, links and the today line. */
export function paintTimelineBody(
  context: CanvasRenderingContext2D,
  scene: TimelineScene,
  viewport: Viewport,
): void {
  context.save();
  context.fillStyle = scene.theme.surface;
  context.fillRect(0, 0, viewport.width, viewport.height);
  context.translate(-viewport.left, -viewport.top);
  paintNonWorking(context, scene, viewport);
  const range = visibleRows(viewport, scene.rows.length);
  paintRowLines(context, scene, viewport, range);
  const shapes = visibleShapes(scene, range);
  paintSelection(context, scene, viewport);
  paintArrows(context, scene, range);
  shapes.forEach((shape) => {
    paintShape(context, scene, shape);
  });
  paintLinkHandles(context, scene, shapes);
  paintPreview(context, scene);
  paintToday(context, scene, viewport);
  context.restore();
}

/** Draws the two rows of labels of the time scale, the labels of long periods staying in view. */
export function paintTimelineHeader(
  context: CanvasRenderingContext2D,
  scene: TimelineScene,
  viewport: Viewport,
  ticks: ScaleTicks,
): void {
  const { theme, frame } = scene;
  context.save();
  context.fillStyle = theme.background;
  context.fillRect(0, 0, viewport.width, viewport.height);
  context.translate(-viewport.left, 0);
  context.strokeStyle = theme.border;
  context.lineWidth = 1;
  context.textBaseline = 'middle';
  context.font = UPPER_FONT;
  context.fillStyle = theme.text;
  for (const tick of ticks.upper) {
    const start = xOf(frame, tick.start);
    const end = xOf(frame, tick.end);
    verticalLine(context, end, 0, SCALE_ROW_HEIGHT);
    const labelX = Math.max(start, viewport.left) + LABEL_PADDING;
    if (labelX + context.measureText(tick.label).width < end - LABEL_PADDING) {
      context.fillText(tick.label, labelX, SCALE_ROW_HEIGHT / HALF);
    }
  }
  context.font = LOWER_FONT;
  context.fillStyle = theme.textSecondary;
  context.textAlign = 'center';
  for (const tick of ticks.lower) {
    const start = xOf(frame, tick.start);
    const end = xOf(frame, tick.end);
    verticalLine(context, start, SCALE_ROW_HEIGHT, SCALE_ROW_HEIGHT * HALF);
    if (context.measureText(tick.label).width + LABEL_PADDING < end - start) {
      context.fillText(tick.label, (start + end) / HALF, SCALE_ROW_HEIGHT * 1.5);
    }
  }
  context.beginPath();
  context.moveTo(viewport.left, SCALE_ROW_HEIGHT + 0.5);
  context.lineTo(viewport.left + viewport.width, SCALE_ROW_HEIGHT + 0.5);
  context.moveTo(viewport.left, viewport.height - 0.5);
  context.lineTo(viewport.left + viewport.width, viewport.height - 0.5);
  context.stroke();
  context.restore();
}

/** Shades the days off and, at the hour zoom, the hours outside the working hours. */
function paintNonWorking(
  context: CanvasRenderingContext2D,
  scene: TimelineScene,
  viewport: Viewport,
): void {
  if (scene.calendar === null) {
    return;
  }
  const from = hourAt(scene.frame, viewport.left);
  const to = hourAt(scene.frame, viewport.left + viewport.width);
  context.fillStyle = scene.theme.nonWorking;
  const intervals = nonWorkingIntervals(
    scene.calendar,
    scene.nonWorkingPeriods,
    from,
    to,
    scene.zoom,
  );
  for (const interval of intervals) {
    const start = xOf(scene.frame, interval.start);
    context.fillRect(start, viewport.top, xOf(scene.frame, interval.end) - start, viewport.height);
  }
}

/** Draws a thin line under each visible row. */
function paintRowLines(
  context: CanvasRenderingContext2D,
  scene: TimelineScene,
  viewport: Viewport,
  range: RowRange,
): void {
  context.strokeStyle = scene.theme.gridLine;
  context.lineWidth = 1;
  context.beginPath();
  for (let row = range.first; row <= range.last; row += 1) {
    const y = (row + 1) * ROW_HEIGHT - 0.5;
    context.moveTo(viewport.left, y);
    context.lineTo(viewport.left + viewport.width, y);
  }
  context.stroke();
}

/** Highlights the row of the selected task. */
function paintSelection(
  context: CanvasRenderingContext2D,
  scene: TimelineScene,
  viewport: Viewport,
): void {
  const row =
    scene.selectedTaskId === null ? undefined : scene.rowIndexById.get(scene.selectedTaskId);
  if (row === undefined) {
    return;
  }
  context.fillStyle = scene.theme.selection;
  context.fillRect(viewport.left, row * ROW_HEIGHT, viewport.width, ROW_HEIGHT - 1);
}

/** Computes the shapes of the visible rows. */
function visibleShapes(scene: TimelineScene, range: RowRange): RowShape[] {
  const shapes: RowShape[] = [];
  for (let index = range.first; index <= range.last; index += 1) {
    const shape = shapeAt(scene, index);
    if (shape !== null) {
      shapes.push(shape);
    }
  }
  return shapes;
}

/** Computes the shape of one row, or null when the row has no dates yet. */
function shapeAt(scene: TimelineScene, index: number): RowShape | null {
  const row = scene.rows[index];
  return row === undefined || scene.schedule === null
    ? null
    : rowShape(row, index, scene.schedule, scene.frame);
}

/** Draws one bar, milestone or summary, outlined when its task is in a person or team conflict. */
function paintShape(
  context: CanvasRenderingContext2D,
  scene: TimelineScene,
  shape: RowShape,
): void {
  const top = shape.row * ROW_HEIGHT;
  if (shape.kind === 'summary') {
    paintSummary(context, scene.theme.text, shape.start, shape.end, top);
    return;
  }
  const task = scene.rows[shape.row]?.task;
  const tagId = task !== undefined && task.kind !== 'summary' ? task.tagId : null;
  const style = tagId === null ? undefined : scene.tagStyles.get(tagId);
  const outlined = scene.conflictTaskIds.has(shape.taskId);
  if (shape.kind === 'milestone') {
    paintMilestone(context, style?.color ?? scene.theme.text, shape.x, top);
    return;
  }
  const color = style?.color ?? scene.theme.bar;
  const pale = style?.pale ?? paleColor(scene.theme.bar);
  const pattern = style?.pattern == null ? null : scene.patternFor(style.pattern);
  const barTop = top + (ROW_HEIGHT - BAR_HEIGHT) / HALF;
  shape.segments.slice(1).forEach((segment, index) => {
    const previous = shape.segments[index];
    const gapStart = previous === undefined ? segment.x : previous.x + previous.width;
    paintSplitGap(context, color, gapStart, segment.x, top + ROW_HEIGHT / HALF);
  });
  const bar = { color, pale, pattern, top: barTop, outlined };
  for (const segment of shape.segments) {
    const fillEnd = segment.x + segment.filled;
    const pieces = piecesOf(scene, segment.x, segment.x + segment.width);
    pieces.daysOff.forEach((dayOff) => {
      context.fillStyle = pale;
      context.fillRect(
        dayOff.start,
        top + (ROW_HEIGHT - DAY_OFF_HEIGHT) / HALF,
        dayOff.end - dayOff.start,
        DAY_OFF_HEIGHT,
      );
    });
    pieces.parts.forEach((part) => {
      paintBarPart(context, scene, bar, part, fillEnd);
    });
  }
}

/** Splits the horizontal extent of a block into the parts worked and the days off it spans, in pixels. */
function piecesOf(
  scene: TimelineScene,
  left: number,
  right: number,
): { readonly parts: readonly PixelInterval[]; readonly daysOff: readonly PixelInterval[] } {
  if (scene.calendar === null) {
    return { parts: [{ start: left, end: right }], daysOff: [] };
  }
  const split = splitAtDaysOff(
    scene.calendar,
    hourAt(scene.frame, left),
    hourAt(scene.frame, right),
  );
  const toPixels = (interval: HourInterval): PixelInterval => ({
    start: xOf(scene.frame, interval.start),
    end: xOf(scene.frame, interval.end),
  });
  return { parts: split.parts.map(toPixels), daysOff: split.daysOff.map(toPixels) };
}

/** Draws one worked part of a block: pale ground, progress up to its end, pattern, outline and conflict outline. */
function paintBarPart(
  context: CanvasRenderingContext2D,
  scene: TimelineScene,
  bar: BarLook,
  part: PixelInterval,
  fillEnd: number,
): void {
  const width = Math.max(part.end - part.start, 1);
  context.save();
  roundedRectangle(context, part.start, bar.top, width, BAR_HEIGHT);
  context.clip();
  context.fillStyle = bar.pale;
  context.fillRect(part.start, bar.top, width, BAR_HEIGHT);
  context.fillStyle = bar.color;
  context.fillRect(
    part.start,
    bar.top,
    Math.max(0, Math.min(fillEnd, part.end) - part.start),
    BAR_HEIGHT,
  );
  if (bar.pattern !== null) {
    context.fillStyle = bar.pattern;
    context.fillRect(part.start, bar.top, width, BAR_HEIGHT);
  }
  context.restore();
  context.strokeStyle = bar.color;
  context.lineWidth = 1;
  roundedRectangle(
    context,
    part.start + HALF_PIXEL,
    bar.top + HALF_PIXEL,
    Math.max(width - 1, 1),
    BAR_HEIGHT - 1,
  );
  context.stroke();
  if (bar.outlined) {
    context.strokeStyle = scene.theme.error;
    context.lineWidth = OUTLINE_WIDTH;
    roundedRectangle(
      context,
      part.start - 1,
      bar.top - 1,
      width + OUTLINE_WIDTH,
      BAR_HEIGHT + OUTLINE_WIDTH,
    );
    context.stroke();
  }
}

/** Draws the pause between two blocks of a split task as a dotted line. */
function paintSplitGap(
  context: CanvasRenderingContext2D,
  color: string,
  start: number,
  end: number,
  middle: number,
): void {
  context.save();
  context.setLineDash(SPLIT_GAP_DASH);
  context.strokeStyle = color;
  context.lineWidth = SPLIT_GAP_WIDTH;
  context.beginPath();
  context.moveTo(start, middle);
  context.lineTo(end, middle);
  context.stroke();
  context.restore();
}

/** Draws a summary as a thin bar with a tip at each end. */
function paintSummary(
  context: CanvasRenderingContext2D,
  color: string,
  start: number,
  end: number,
  top: number,
): void {
  const barTop = top + (ROW_HEIGHT - SUMMARY_HEIGHT) / HALF - SUMMARY_TIP / HALF;
  context.fillStyle = color;
  context.fillRect(start, barTop, Math.max(end - start, 1), SUMMARY_HEIGHT);
  context.beginPath();
  context.moveTo(start, barTop + SUMMARY_HEIGHT);
  context.lineTo(start + SUMMARY_TIP, barTop + SUMMARY_HEIGHT);
  context.lineTo(start, barTop + SUMMARY_HEIGHT + SUMMARY_TIP);
  context.moveTo(end, barTop + SUMMARY_HEIGHT);
  context.lineTo(end - SUMMARY_TIP, barTop + SUMMARY_HEIGHT);
  context.lineTo(end, barTop + SUMMARY_HEIGHT + SUMMARY_TIP);
  context.fill();
}

/** Draws a milestone as a diamond centred on its date. */
function paintMilestone(
  context: CanvasRenderingContext2D,
  color: string,
  x: number,
  top: number,
): void {
  const middle = top + ROW_HEIGHT / HALF;
  const half = MILESTONE_SIZE / HALF;
  context.fillStyle = color;
  context.beginPath();
  context.moveTo(x, middle - half);
  context.lineTo(x + half, middle);
  context.lineTo(x, middle + half);
  context.lineTo(x - half, middle);
  context.closePath();
  context.fill();
}

/** Draws the arrows of the dependencies that cross the visible rows. */
function paintArrows(
  context: CanvasRenderingContext2D,
  scene: TimelineScene,
  range: RowRange,
): void {
  context.strokeStyle = scene.theme.textSecondary;
  context.fillStyle = scene.theme.textSecondary;
  context.lineWidth = ARROW_WIDTH;
  for (const dependency of scene.dependencies) {
    const from = scene.rowIndexById.get(dependency.predecessorId);
    const to = scene.rowIndexById.get(dependency.successorId);
    if (
      from === undefined ||
      to === undefined ||
      Math.max(from, to) < range.first ||
      Math.min(from, to) > range.last
    ) {
      continue;
    }
    const fromShape = shapeAt(scene, from);
    const toShape = shapeAt(scene, to);
    if (fromShape !== null && toShape !== null) {
      paintArrow(context, dependencyArrow(dependency, fromShape, toShape));
    }
  }
}

/** Draws a polyline ending with an arrow head. */
function paintArrow(context: CanvasRenderingContext2D, points: readonly Point[]): void {
  const [first, ...rest] = points;
  const last = points.at(-1);
  const beforeLast = points.at(-2);
  if (first === undefined || last === undefined || beforeLast === undefined) {
    return;
  }
  context.beginPath();
  context.moveTo(first.x, first.y);
  rest.forEach((point) => {
    context.lineTo(point.x, point.y);
  });
  context.stroke();
  const direction = Math.sign(last.x - beforeLast.x) || 1;
  context.beginPath();
  context.moveTo(last.x, last.y);
  context.lineTo(last.x - direction * ARROW_HEAD, last.y - ARROW_HEAD);
  context.lineTo(last.x - direction * ARROW_HEAD, last.y + ARROW_HEAD);
  context.closePath();
  context.fill();
}

/** Draws the handles of the selected task from which a link is dragged: one at the end of each block but the last, and one after the bar. */
function paintLinkHandles(
  context: CanvasRenderingContext2D,
  scene: TimelineScene,
  shapes: readonly RowShape[],
): void {
  const shape = shapes.find((candidate) => candidate.taskId === scene.selectedTaskId);
  if (shape === undefined || shape.kind === 'summary') {
    return;
  }
  context.fillStyle = scene.theme.surface;
  context.strokeStyle = scene.theme.action;
  context.lineWidth = OUTLINE_WIDTH;
  for (const { center } of linkHandles(shape)) {
    context.beginPath();
    context.arc(center.x, center.y, LINK_HANDLE_RADIUS, 0, Math.PI * HALF);
    context.fill();
    context.stroke();
  }
}

/** Draws the line of a dragged link and the row, and the block, it would be dropped on. */
function paintLinkPreview(
  context: CanvasRenderingContext2D,
  scene: TimelineScene,
  preview: Extract<DragPreview, { kind: 'link' }>,
): void {
  const from = linkHandleCenter(preview.shape, preview.block);
  context.beginPath();
  context.moveTo(from.x, from.y);
  context.lineTo(preview.pointer.x, preview.pointer.y);
  context.stroke();
  if (preview.targetRow === null) {
    return;
  }
  const top = preview.targetRow * ROW_HEIGHT;
  context.strokeRect(0, top + 1, xOf(scene.frame, scene.frame.end), ROW_HEIGHT - 2);
  const target = shapeAt(scene, preview.targetRow);
  const block =
    preview.targetBlock === null || target?.kind !== 'task'
      ? undefined
      : target.segments[preview.targetBlock];
  if (block !== undefined) {
    const barTop = top + (ROW_HEIGHT - BAR_HEIGHT) / HALF - BLOCK_TARGET_MARGIN;
    const height = BAR_HEIGHT + BLOCK_TARGET_MARGIN * HALF;
    context.strokeRect(
      block.x - BLOCK_TARGET_MARGIN,
      barTop,
      block.width + BLOCK_TARGET_MARGIN * HALF,
      height,
    );
  }
}

/** Draws where a dragged bar or link would go, as a dashed outline. */
function paintPreview(context: CanvasRenderingContext2D, scene: TimelineScene): void {
  const preview = scene.preview;
  if (preview === null) {
    return;
  }
  context.save();
  context.setLineDash(PREVIEW_DASH);
  context.strokeStyle = scene.theme.action;
  context.lineWidth = OUTLINE_WIDTH;
  const top = preview.shape.row * ROW_HEIGHT;
  if (preview.kind === 'link') {
    paintLinkPreview(context, scene, preview);
  } else if (preview.shape.kind === 'milestone') {
    const half = MILESTONE_SIZE / HALF;
    const x = preview.shape.x + preview.offset;
    const middle = top + ROW_HEIGHT / HALF;
    context.beginPath();
    context.moveTo(x, middle - half);
    context.lineTo(x + half, middle);
    context.lineTo(x, middle + half);
    context.lineTo(x - half, middle);
    context.closePath();
    context.stroke();
  } else if (preview.shape.kind === 'task') {
    const moving = preview.kind === 'move';
    const start = preview.shape.start + (moving ? preview.offset : 0);
    const end = Math.max(preview.shape.end + preview.offset, preview.shape.start + 1);
    const width = moving ? preview.shape.end - preview.shape.start : end - start;
    roundedRectangle(context, start, top + (ROW_HEIGHT - BAR_HEIGHT) / HALF, width, BAR_HEIGHT);
    context.stroke();
  }
  context.restore();
}

/** Draws the vertical line of the current time. */
function paintToday(
  context: CanvasRenderingContext2D,
  scene: TimelineScene,
  viewport: Viewport,
): void {
  context.fillStyle = scene.theme.error;
  context.fillRect(
    xOf(scene.frame, scene.today) - TODAY_WIDTH / HALF,
    viewport.top,
    TODAY_WIDTH,
    viewport.height,
  );
}

/** Traces a rectangle with rounded corners. */
function roundedRectangle(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  context.beginPath();
  context.roundRect(x, y, width, height, Math.min(BAR_RADIUS, width / HALF));
}

/** Draws a crisp vertical line of one pixel. */
function verticalLine(
  context: CanvasRenderingContext2D,
  x: number,
  top: number,
  bottom: number,
): void {
  context.beginPath();
  context.moveTo(Math.round(x) + 0.5, top);
  context.lineTo(Math.round(x) + 0.5, bottom);
  context.stroke();
}

/** Lists the quarter hours of a working day that are not worked, as intervals. */
function offHours(workingQuarters: readonly number[], dayStart: ProjectHour): HourInterval[] {
  const working = new Set(workingQuarters);
  const intervals: HourInterval[] = [];
  for (let quarter = 0; quarter < QUARTERS_PER_DAY; quarter += 1) {
    const start = fromQuarters(quarter);
    if (!working.has(start)) {
      intervals.push({ start: dayStart + start, end: dayStart + start + QUARTER_HOUR });
    }
  }
  return intervals;
}

/** Joins intervals that follow one another. */
function mergeIntervals(intervals: readonly HourInterval[]): HourInterval[] {
  const merged: HourInterval[] = [];
  for (const interval of intervals) {
    const last = merged.at(-1);
    if (last?.end === interval.start) {
      merged[merged.length - 1] = { start: last.start, end: interval.end };
    } else {
      merged.push(interval);
    }
  }
  return merged;
}
