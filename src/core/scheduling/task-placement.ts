import type { CompiledCalendar } from '../calendar/compile-calendar';
import {
  computeSegmentBounds,
  computeTaskSlots,
  type TaskSlotsErrorCode,
  type TimeSlot,
} from '../calendar/task-slots';
import { lastWorkingHourEnd, subtractWorkingHours } from '../calendar/working-time';
import { MAX_SEGMENTS_PER_TASK, MAX_SEGMENT_GAP_DAYS } from '../limits';
import type { SchedulableTask, TaskSegment, WorkTask } from '../model/project';
import { failure, success, type Result } from '../result';
import { blockResumption } from './block-links';
import {
  END_PROJECT_HOUR,
  MIN_PROJECT_HOUR,
  QUARTER_HOUR,
  fromQuarters,
  isProjectHour,
  isQuarterHours,
  toQuarters,
  type ProjectHour,
} from '../time';

const HALF = 2;

export interface ScheduledSegment {
  readonly start: ProjectHour;
  readonly end: ProjectHour;
}

export interface Placement extends ScheduledSegment {
  readonly segments: readonly ScheduledSegment[];
}

export type PlacementErrorCode = TaskSlotsErrorCode | 'INVALID_SEGMENTS';

type PlacementResult = Result<Placement, PlacementErrorCode>;

/** Places a task as early as possible from an instant, block after block. */
export function placeTask(
  calendar: CompiledCalendar,
  task: SchedulableTask,
  earliestStart: ProjectHour,
): PlacementResult {
  if (!isProjectHour(earliestStart)) {
    return failure('INVALID_INSTANT');
  }
  if (task.kind === 'milestone') {
    return success({ start: earliestStart, end: earliestStart, segments: [] });
  }
  if (!hasValidSegments(task.segments)) {
    return failure('INVALID_SEGMENTS');
  }
  return placeSegments(calendar, task, earliestStart);
}

/** Places a task at the earliest start that respects a start bound and an optional end bound. */
export function placeTaskEarliest(
  calendar: CompiledCalendar,
  task: SchedulableTask,
  earliestStart: ProjectHour,
  earliestEnd: ProjectHour | null,
): PlacementResult {
  const first = placeTask(calendar, task, earliestStart);
  if (!first.ok || earliestEnd === null || first.value.end >= earliestEnd) {
    return first;
  }
  const workingEnd = lastWorkingHourEnd(calendar, earliestEnd);
  const endBound = workingEnd.ok ? workingEnd.value : earliestEnd;
  if (task.kind === 'milestone') {
    return placeTask(calendar, task, Math.max(earliestStart, endBound));
  }
  if (first.value.end >= endBound) {
    return first;
  }
  if (worksContinuously(calendar, task)) {
    const start = subtractWorkingHours(calendar, endBound, totalDurationHours(task));
    return start.ok ? placeTask(calendar, task, Math.max(earliestStart, start.value)) : start;
  }
  const boundary = findFirstStartWhere(
    calendar,
    task,
    earliestStart,
    endBound,
    (placement) => placement.end >= endBound,
  );
  return boundary.ok ? placeTask(calendar, task, boundary.value) : boundary;
}

/** Places a task at the latest start that still starts and ends no later than the given bounds. */
export function placeTaskLatest(
  calendar: CompiledCalendar,
  task: SchedulableTask,
  latestStart: ProjectHour,
  latestEnd: ProjectHour,
): PlacementResult {
  if (task.kind === 'milestone') {
    return placeTask(calendar, task, Math.min(latestStart, latestEnd));
  }
  const direct = worksContinuously(calendar, task)
    ? latestContinuousStart(calendar, task, latestStart, latestEnd)
    : null;
  if (direct !== null) {
    return placeTask(calendar, task, direct);
  }
  const upperBound = Math.min(latestEnd, END_PROJECT_HOUR - QUARTER_HOUR);
  const firstLate = findFirstStartWhere(
    calendar,
    task,
    MIN_PROJECT_HOUR,
    upperBound,
    (placement) => placement.start > latestStart || placement.end > latestEnd,
  );
  if (!firstLate.ok) {
    return firstLate;
  }
  return placeTask(calendar, task, Math.max(firstLate.value - QUARTER_HOUR, MIN_PROJECT_HOUR));
}

/** Computes on demand the exact working time slots of every block of a placed work task, refusing a placement with a block the task does not have. */
export function computePlacementSlots(
  calendar: CompiledCalendar,
  task: WorkTask,
  placement: Placement,
): Result<TimeSlot[][], PlacementErrorCode> {
  const slotsByBlock: TimeSlot[][] = [];
  for (const [index, segment] of placement.segments.entries()) {
    const block = task.segments[index];
    if (block === undefined) {
      return failure('INVALID_SEGMENTS');
    }
    const slots = computeTaskSlots(calendar, {
      start: segment.start,
      durationHours: block.durationHours,
      hoursPerDay: task.hoursPerDay,
      dailyStartHour: task.dailyStartHour,
    });
    if (!slots.ok) {
      return slots;
    }
    slotsByBlock.push(slots.value);
  }
  return success(slotsByBlock);
}

/** Tells whether a task works every working hour of its working days, so that each block covers all working time between its bounds. */
export function worksFullDays(calendar: CompiledCalendar, task: WorkTask): boolean {
  const [firstWorkingHour] = calendar.workingQuartersOfDay;
  return (
    (task.hoursPerDay === null || task.hoursPerDay === calendar.workingHoursPerDay) &&
    (task.dailyStartHour === null || task.dailyStartHour <= firstWorkingHour)
  );
}

/** Tells whether a task always works consecutive working hours, so that its start follows from its end. */
function worksContinuously(calendar: CompiledCalendar, task: WorkTask): boolean {
  return task.segments.length === 1 && worksFullDays(calendar, task);
}

/** Computes directly the latest start of a continuously worked task, or null when out of range. */
function latestContinuousStart(
  calendar: CompiledCalendar,
  task: WorkTask,
  latestStart: ProjectHour,
  latestEnd: ProjectHour,
): ProjectHour | null {
  const byEnd = subtractWorkingHours(calendar, latestEnd, totalDurationHours(task));
  const byStart = subtractWorkingHours(calendar, latestStart + QUARTER_HOUR, QUARTER_HOUR);
  return byEnd.ok && byStart.ok ? Math.min(byEnd.value, byStart.value) : null;
}

/** Sums the durations of every block of a work task. */
function totalDurationHours(task: WorkTask): number {
  return task.segments.reduce((total, segment) => total + segment.durationHours, 0);
}

/** Finds by binary search, among the quarter hours of a range, the first start whose placement satisfies a monotonic predicate. */
function findFirstStartWhere(
  calendar: CompiledCalendar,
  task: WorkTask,
  low: ProjectHour,
  high: ProjectHour,
  predicate: (placement: Placement) => boolean,
): Result<ProjectHour, PlacementErrorCode> {
  let lastFalse = toQuarters(low) - 1;
  let firstTrue = toQuarters(high);
  while (firstTrue - lastFalse > 1) {
    const middle = Math.floor((lastFalse + firstTrue) / HALF);
    const placement = placeTask(calendar, task, fromQuarters(middle));
    if (!placement.ok) {
      return placement;
    }
    if (predicate(placement.value)) {
      firstTrue = middle;
    } else {
      lastFalse = middle;
    }
  }
  return success(fromQuarters(firstTrue));
}

/** Tells whether a task has a supported number of blocks with valid durations and gaps. */
function hasValidSegments(segments: readonly TaskSegment[]): boolean {
  if (segments.length === 0 || segments.length > MAX_SEGMENTS_PER_TASK) {
    return false;
  }
  return segments.every(
    (segment, index) =>
      isQuarterHours(segment.durationHours) &&
      segment.durationHours >= QUARTER_HOUR &&
      isValidGap(segment.gapDaysBefore, index === 0),
  );
}

/** Tells whether a gap before a block is valid: none for the first block, whole days for the others, zero meaning right after the previous block. */
function isValidGap(gapDays: number, isFirstSegment: boolean): boolean {
  if (isFirstSegment) {
    return gapDays === 0;
  }
  return Number.isInteger(gapDays) && gapDays >= 0 && gapDays <= MAX_SEGMENT_GAP_DAYS;
}

/** Places every block of a work task, each one resuming no earlier than its gap in days after the previous one, nor before its own start date, and never before the previous one ends. */
function placeSegments(
  calendar: CompiledCalendar,
  task: WorkTask,
  earliestStart: ProjectHour,
): PlacementResult {
  const segments: ScheduledSegment[] = [];
  let resumeFrom = earliestStart;
  for (const segment of task.segments) {
    const previous = segments.at(-1);
    if (previous !== undefined) {
      resumeFrom = blockResumption(previous.end, segment);
    }
    const placed = placeSegment(calendar, task, segment, resumeFrom);
    if (!placed.ok) {
      return placed;
    }
    segments.push(placed.value);
  }
  const first = segments[0];
  const last = segments.at(-1);
  if (first === undefined || last === undefined) {
    return failure('INVALID_SEGMENTS');
  }
  return success({ start: first.start, end: last.end, segments });
}

/** Places a single block of a work task from an instant. */
function placeSegment(
  calendar: CompiledCalendar,
  task: WorkTask,
  segment: TaskSegment,
  start: ProjectHour,
): Result<ScheduledSegment, PlacementErrorCode> {
  if (start >= END_PROJECT_HOUR) {
    return failure('BEYOND_PLANNING_HORIZON');
  }
  return computeSegmentBounds(calendar, {
    start,
    durationHours: segment.durationHours,
    hoursPerDay: task.hoursPerDay,
    dailyStartHour: task.dailyStartHour,
  });
}
