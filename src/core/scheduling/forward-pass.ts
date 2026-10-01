import type { CompiledCalendar } from '../calendar/compile-calendar';
import { compareStrings } from '../compare-strings';
import { shiftWorkingHours } from '../calendar/working-time';
import type { Dependency, SchedulableTask, TaskId } from '../model/project';
import { failure, success, type Result } from '../result';
import { dayIndexOf, QUARTER_HOUR, startOfDay, type ProjectHour } from '../time';
import type { DependencyGraph, ScheduleUnit, UnitDependency } from './dependency-graph';
import {
  placeTaskEarliest,
  placeTaskLatest,
  type Placement,
  type PlacementErrorCode,
  type ScheduledSegment,
} from './task-placement';

export interface SchedulingContext {
  readonly calendar: CompiledCalendar;
  readonly projectStart: ProjectHour;
  readonly dateConstraintsEnabled: boolean;
}

export type SchedulingConflictCode = 'MUST_FINISH_ON_NOT_MET' | 'DEADLINE_MISSED';

export interface SchedulingConflict {
  readonly code: SchedulingConflictCode;
  readonly taskId: TaskId;
}

export interface TaskPlacementError {
  readonly code: PlacementErrorCode;
  readonly taskId: TaskId;
}

export type PlacementsByIndex = readonly (Placement | undefined)[];

export interface ForwardPassResult {
  readonly placements: PlacementsByIndex;
  readonly conflicts: readonly SchedulingConflict[];
  readonly keptStarts: ReadonlyMap<TaskId, ProjectHour>;
}

const NO_REQUESTED_STARTS: ReadonlyMap<TaskId, ProjectHour> = new Map();

interface Bounds {
  readonly earliestStart: ProjectHour;
  readonly earliestEnd: ProjectHour | null;
}

/** Computes the earliest placement of every task, block after block in the dependency order, a requested start replacing the start date of its task and being kept only where the task would otherwise start earlier. */
export function runForwardPass(
  context: SchedulingContext,
  graph: DependencyGraph,
  requestedStarts: ReadonlyMap<TaskId, ProjectHour> = NO_REQUESTED_STARTS,
): Result<ForwardPassResult, TaskPlacementError> {
  const blocks = new Array<Placement | undefined>(graph.units.length);
  const placements = new Array<Placement | undefined>(graph.firstUnitOfTask.length);
  const conflicts: SchedulingConflict[] = [];
  const keptStarts = new Map<TaskId, ProjectHour>();
  for (const unit of graph.order) {
    const incoming = graph.incoming[unit.index] ?? [];
    const requested = unit.block === 0 ? requestedStarts.get(unit.task.id) : undefined;
    const placed =
      requested === undefined
        ? scheduleUnit(context, unit, incoming, blocks)
        : scheduleRequestedStart(context, unit, incoming, blocks, requested, keptStarts);
    if (!placed.ok) {
      return failure({ code: placed.error, taskId: unit.task.id });
    }
    blocks[unit.index] = placed.value;
    const placement = finishedPlacement(graph, unit, blocks);
    if (!placement.ok) {
      return failure({ code: placement.error, taskId: unit.task.id });
    }
    if (placement.value !== null) {
      placements[unit.taskIndex] = placement.value;
      conflicts.push(...findConflicts(context, unit.task, placement.value));
    }
  }
  return success({ placements, conflicts: sortConflicts(conflicts), keptStarts });
}

/** Tells whether a dependency starts from the start of its predecessor rather than its end. */
export function usesPredecessorStart(dependency: Dependency): boolean {
  return dependency.type === 'startToStart' || dependency.type === 'startToFinish';
}

/** Returns the instant a dependency starts from: the start or the end of the task or block it leaves. */
export function dependencyAnchor(
  dependency: Dependency,
  predecessor: ScheduledSegment,
): ProjectHour {
  return usesPredecessorStart(dependency) ? predecessor.start : predecessor.end;
}

/** Tells whether a dependency constrains the start of its successor rather than its end. */
export function constrainsSuccessorStart(dependency: Dependency): boolean {
  return dependency.type === 'finishToStart' || dependency.type === 'startToStart';
}

/** Returns the earliest instant a block may resume after the previous block of its task: right after it, and not before the start of the day its gap in days leads to. */
export function resumeAfter(previous: ScheduledSegment, gapDays: number): ProjectHour {
  const lastDay = dayIndexOf(previous.end - QUARTER_HOUR);
  return Math.max(previous.end, startOfDay(lastDay + gapDays));
}

/** Returns the gap in days a block of a work task keeps after the previous one. */
export function gapBefore(task: SchedulableTask, block: number): number {
  return task.kind === 'task' ? (task.segments[block]?.gapDaysBefore ?? 0) : 0;
}

/** Returns the placement of a task once its last block is placed, or null while blocks of it are still to place. */
function finishedPlacement(
  graph: DependencyGraph,
  unit: ScheduleUnit,
  blocks: readonly (Placement | undefined)[],
): Result<Placement | null, PlacementErrorCode> {
  if (!unit.isLast) {
    return success(null);
  }
  const placed = blocks[unit.index];
  if (unit.block === 0 && placed !== undefined) {
    return success(placed);
  }
  return assemblePlacement(graph, unit, blocks);
}

/** Puts together the placement of a split task once its last block is placed, every earlier block having been placed before it. */
function assemblePlacement(
  graph: DependencyGraph,
  last: ScheduleUnit,
  blocks: readonly (Placement | undefined)[],
): Result<Placement, PlacementErrorCode> {
  const first = graph.firstUnitOfTask[last.taskIndex];
  const placed = first === undefined ? [] : blocks.slice(first, last.index + 1);
  const spans = placed.flatMap((block) =>
    block === undefined ? [] : [{ start: block.start, end: block.end }],
  );
  const [firstSpan] = spans;
  const lastSpan = spans.at(-1);
  if (firstSpan === undefined || lastSpan === undefined || spans.length !== placed.length) {
    return failure('INVALID_INSTANT');
  }
  return success({ start: firstSpan.start, end: lastSpan.end, segments: spans });
}

/** Places a block without any start date, then again with the requested start as its start date when it would otherwise start earlier, recording that start as kept. */
function scheduleRequestedStart(
  context: SchedulingContext,
  unit: ScheduleUnit,
  incoming: readonly UnitDependency[],
  blocks: readonly (Placement | undefined)[],
  requested: ProjectHour,
  keptStarts: Map<TaskId, ProjectHour>,
): Result<Placement, PlacementErrorCode> {
  const withoutStart = { ...unit, task: { ...unit.task, startNoEarlierThan: null } };
  const free = scheduleUnit(context, withoutStart, incoming, blocks);
  if (!free.ok || free.value.start >= requested) {
    return free;
  }
  keptStarts.set(unit.task.id, requested);
  const withStart = { ...unit, task: { ...unit.task, startNoEarlierThan: requested } };
  return scheduleUnit(context, withStart, incoming, blocks);
}

/** Places one block at its earliest position, then applies the "must finish on" constraint of its task to its last block. */
function scheduleUnit(
  context: SchedulingContext,
  unit: ScheduleUnit,
  incoming: readonly UnitDependency[],
  blocks: readonly (Placement | undefined)[],
): Result<Placement, PlacementErrorCode> {
  const bounds = computeBounds(context, unit, incoming, blocks);
  if (!bounds.ok) {
    return bounds;
  }
  const { earliestStart, earliestEnd } = bounds.value;
  const alone = unit.blockTask;
  const earliest = placeTaskEarliest(context.calendar, alone, earliestStart, earliestEnd);
  const mustFinishOn =
    unit.isLast && context.dateConstraintsEnabled ? unit.task.mustFinishOn : null;
  if (!earliest.ok || mustFinishOn === null || earliest.value.end >= mustFinishOn) {
    return earliest;
  }
  return placeTaskLatest(context.calendar, alone, mustFinishOn, mustFinishOn);
}

/** Combines the project start and the task start date, or the resumption after the previous block, with every incoming dependency into bounds. */
function computeBounds(
  context: SchedulingContext,
  unit: ScheduleUnit,
  incoming: readonly UnitDependency[],
  blocks: readonly (Placement | undefined)[],
): Result<Bounds, PlacementErrorCode> {
  const previous = unit.block === 0 ? undefined : blocks[unit.index - 1];
  if (unit.block > 0 && previous === undefined) {
    return failure('INVALID_INSTANT');
  }
  let earliestStart =
    previous === undefined
      ? Math.max(context.projectStart, unit.task.startNoEarlierThan ?? context.projectStart)
      : resumeAfter(previous, gapBefore(unit.task, unit.block));
  let earliestEnd: ProjectHour | null = null;
  for (const link of incoming) {
    const bound = dependencyBound(context, link, blocks);
    if (!bound.ok) {
      return bound;
    }
    if (constrainsSuccessorStart(link.dependency)) {
      earliestStart = Math.max(earliestStart, bound.value);
    } else {
      earliestEnd = Math.max(earliestEnd ?? bound.value, bound.value);
    }
  }
  return success({ earliestStart, earliestEnd });
}

/** Computes the instant a dependency imposes on its successor, lag included. */
function dependencyBound(
  context: SchedulingContext,
  link: UnitDependency,
  blocks: readonly (Placement | undefined)[],
): Result<ProjectHour, PlacementErrorCode> {
  const predecessor = blocks[link.predecessorUnit];
  if (predecessor === undefined) {
    return failure('INVALID_INSTANT');
  }
  const anchor = dependencyAnchor(link.dependency, predecessor);
  return shiftWorkingHours(context.calendar, anchor, link.dependency.lagHours);
}

/** Lists the advanced date constraints a placed task fails to meet. */
function findConflicts(
  context: SchedulingContext,
  task: SchedulableTask,
  placement: Placement,
): SchedulingConflict[] {
  if (!context.dateConstraintsEnabled) {
    return [];
  }
  const conflicts: SchedulingConflict[] = [];
  if (task.mustFinishOn !== null && placement.end > task.mustFinishOn) {
    conflicts.push({ code: 'MUST_FINISH_ON_NOT_MET', taskId: task.id });
  }
  if (task.deadline !== null && placement.end > task.deadline) {
    conflicts.push({ code: 'DEADLINE_MISSED', taskId: task.id });
  }
  return conflicts;
}

/** Sorts conflicts by task then by kind so that results never depend on input order. */
function sortConflicts(conflicts: readonly SchedulingConflict[]): SchedulingConflict[] {
  return [...conflicts].sort((left, right) =>
    left.taskId === right.taskId
      ? compareStrings(left.code, right.code)
      : compareStrings(left.taskId, right.taskId),
  );
}
