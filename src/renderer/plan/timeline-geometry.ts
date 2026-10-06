import type { Dependency, Project, Task, TaskId } from '../../core/model/project';
import type { Schedule } from '../../core/scheduling/schedule-project';
import { constrainsSuccessorStart, usesPredecessorStart } from '../../core/scheduling/forward-pass';
import { HOURS_PER_DAY, type ProjectHour } from '../../core/time';
import type { PlanRow } from './plan-outline';

export const ROW_HEIGHT = 34;
export const BAR_HEIGHT = 20;
export const SUMMARY_HEIGHT = 8;
export const MILESTONE_SIZE = 16;
export const ARROW_GAP = 8;

const PERCENT = 100;
const HALF = 2;
const LEAD_DAYS = 7;
const TRAIL_DAYS = 30;
const MINIMUM_DAYS = 60;
const MAXIMUM_TIMELINE_PIXELS = 2 ** 24;

export interface TimelineFrame {
  readonly origin: ProjectHour;
  readonly end: ProjectHour;
  readonly pixelsPerHour: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface BarSegment {
  readonly x: number;
  readonly width: number;
  readonly filled: number;
}

export type RowShape =
  | {
      readonly kind: 'task';
      readonly taskId: TaskId;
      readonly row: number;
      readonly segments: readonly BarSegment[];
      readonly start: number;
      readonly end: number;
    }
  | {
      readonly kind: 'milestone';
      readonly taskId: TaskId;
      readonly row: number;
      readonly x: number;
    }
  | {
      readonly kind: 'summary';
      readonly taskId: TaskId;
      readonly row: number;
      readonly start: number;
      readonly end: number;
    };

/** Chooses the period the timeline covers: from a week before the earliest of the project start, today and the deadlines shown, to a month after the latest of the task ends, the project start, today and the deadlines shown, at least two months, and never wider than a canvas can scroll, a far deadline giving way so that the project always stays in view. */
export function timelineFrame(
  projectStart: ProjectHour,
  schedule: Schedule | null,
  today: ProjectHour,
  pixelsPerHour: number,
  deadlines: readonly ProjectHour[],
): TimelineFrame {
  const maximumSpan = Math.floor(MAXIMUM_TIMELINE_PIXELS / pixelsPerHour);
  let projectLast = Math.max(projectStart, today);
  for (const placement of schedule?.placements.values() ?? []) {
    projectLast = Math.max(projectLast, placement.end);
  }
  const projectFirst = Math.min(projectStart, today);
  let earliest = projectFirst;
  let latest = projectLast;
  for (const deadline of deadlines) {
    earliest = Math.min(earliest, deadline);
    latest = Math.max(latest, deadline);
  }
  const keepsProject = startOfDayHour(trailingDay(projectLast) - maximumSpan) + HOURS_PER_DAY;
  const origin = Math.min(leadingDay(projectFirst), Math.max(leadingDay(earliest), keepsProject));
  const last = Math.max(latest, origin + MINIMUM_DAYS * HOURS_PER_DAY);
  const end = Math.min(trailingDay(last), origin + maximumSpan);
  return { origin, end, pixelsPerHour };
}

/** Returns the start of the day a week before an instant, where the timeline may begin. */
function leadingDay(hour: ProjectHour): ProjectHour {
  return startOfDayHour(hour) - LEAD_DAYS * HOURS_PER_DAY;
}

/** Returns the start of the day a month after an instant, where the timeline may end. */
function trailingDay(hour: ProjectHour): ProjectHour {
  return startOfDayHour(hour) + TRAIL_DAYS * HOURS_PER_DAY;
}

/** Returns the horizontal position of an instant on the timeline. */
export function xOf(frame: TimelineFrame, hour: ProjectHour): number {
  return (hour - frame.origin) * frame.pixelsPerHour;
}

/** Returns the instant at a horizontal position of the timeline. */
export function hourAt(frame: TimelineFrame, x: number): number {
  return frame.origin + x / frame.pixelsPerHour;
}

/** Returns the vertical middle of a row. */
export function rowMiddle(row: number): number {
  return row * ROW_HEIGHT + ROW_HEIGHT / HALF;
}

/** Computes the shape a scheduled row takes on the timeline, or null while it has no dates. */
export function rowShape(
  row: PlanRow,
  index: number,
  schedule: Schedule,
  frame: TimelineFrame,
): RowShape | null {
  const { task } = row;
  if (task.kind === 'summary') {
    const dates = schedule.summaries.get(task.id);
    if (dates?.start == null) {
      return null;
    }
    const start = xOf(frame, dates.start);
    return { kind: 'summary', taskId: task.id, row: index, start, end: xOf(frame, dates.end) };
  }
  const placement = schedule.placements.get(task.id);
  if (placement === undefined) {
    return null;
  }
  if (task.kind === 'milestone') {
    return { kind: 'milestone', taskId: task.id, row: index, x: xOf(frame, placement.start) };
  }
  const durations = task.segments.map((segment) => segment.durationHours);
  const segments = fillSegments(
    placement.segments.map((segment) => ({
      x: xOf(frame, segment.start),
      width: (segment.end - segment.start) * frame.pixelsPerHour,
    })),
    durations,
    task.progressPercent,
  );
  return {
    kind: 'task',
    taskId: task.id,
    row: index,
    segments,
    start: xOf(frame, placement.start),
    end: xOf(frame, placement.end),
  };
}

/** Routes the arrow of a dependency from the side of the task or block it leaves to the side of the task or block it constrains, around the bars. */
export function dependencyArrow(
  dependency: Dependency,
  from: RowShape,
  to: RowShape,
): readonly Point[] {
  const fromRight = !usesPredecessorStart(dependency);
  const toLeft = constrainsSuccessorStart(dependency);
  const start = {
    x: blockEdge(from, dependency.predecessorBlock, fromRight),
    y: rowMiddle(from.row),
  };
  const end = { x: blockEdge(to, dependency.successorBlock, !toLeft), y: rowMiddle(to.row) };
  const outX = start.x + (fromRight ? ARROW_GAP : -ARROW_GAP);
  const inX = end.x + (toLeft ? -ARROW_GAP : ARROW_GAP);
  const direct = toLeft ? outX <= inX : outX >= inX;
  if (direct) {
    return [start, { x: outX, y: start.y }, { x: outX, y: end.y }, end];
  }
  const between = to.row > from.row ? to.row * ROW_HEIGHT : (to.row + 1) * ROW_HEIGHT;
  return [
    start,
    { x: outX, y: start.y },
    { x: outX, y: between },
    { x: inX, y: between },
    { x: inX, y: end.y },
    end,
  ];
}

/** Returns the left or right edge of a block of a shape, or of the whole shape when no block is named or the shape does not show it. */
function blockEdge(shape: RowShape, block: number | null, right: boolean): number {
  const segment = block === null || shape.kind !== 'task' ? undefined : shape.segments[block];
  if (segment === undefined) {
    return right ? shapeEnd(shape) : shapeStart(shape);
  }
  return right ? segment.x + segment.width : segment.x;
}

/** Returns the left edge of a shape. */
export function shapeStart(shape: RowShape): number {
  return shape.kind === 'milestone' ? shape.x - MILESTONE_SIZE / HALF : shape.start;
}

/** Returns the right edge of a shape. */
export function shapeEnd(shape: RowShape): number {
  return shape.kind === 'milestone' ? shape.x + MILESTONE_SIZE / HALF : shape.end;
}

/** Fills the blocks of a task in order with its progress, each block weighing its duration. */
function fillSegments(
  bars: readonly { readonly x: number; readonly width: number }[],
  durations: readonly number[],
  progressPercent: number,
): BarSegment[] {
  const total = durations.reduce((sum, hours) => sum + hours, 0);
  let remaining = (total * progressPercent) / PERCENT;
  return bars.map((bar, index) => {
    const hours = durations[index] ?? 0;
    const share = hours === 0 ? 0 : Math.min(1, Math.max(0, remaining / hours));
    remaining -= hours;
    return { ...bar, filled: bar.width * share };
  });
}

/** Returns midnight of the day of an instant. */
function startOfDayHour(hour: ProjectHour): ProjectHour {
  return Math.floor(hour / HOURS_PER_DAY) * HOURS_PER_DAY;
}

/** Lists the deadlines of the tasks and milestones of a project. */
export function deadlinesOf(project: Project): ProjectHour[] {
  const deadlines: ProjectHour[] = [];
  for (const task of project.tasks) {
    const deadline = deadlineOf(task);
    if (deadline !== null) {
      deadlines.push(deadline);
    }
  }
  return deadlines;
}

/** Returns the deadline of a task or milestone, or null for a summary or a task without one. */
export function deadlineOf(task: Task): ProjectHour | null {
  return task.kind === 'summary' ? null : task.deadline;
}
