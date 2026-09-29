import type { CompiledCalendar } from '../calendar/compile-calendar';
import { compareStrings } from '../compare-strings';
import { shiftWorkingHours } from '../calendar/working-time';
import type { Dependency, SchedulableTask, TaskId } from '../model/project';
import { failure, success, type Result } from '../result';
import type { ProjectHour } from '../time';
import type { DependencyGraph, ResolvedDependency } from './dependency-graph';
import {
  placeTaskEarliest,
  placeTaskLatest,
  type Placement,
  type PlacementErrorCode,
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

/** Computes the earliest placement of every task, following the dependency order, a requested start replacing the start date of its task and being kept only where the task would otherwise start earlier. */
export function runForwardPass(
  context: SchedulingContext,
  graph: DependencyGraph,
  requestedStarts: ReadonlyMap<TaskId, ProjectHour> = NO_REQUESTED_STARTS,
): Result<ForwardPassResult, TaskPlacementError> {
  const placements = new Array<Placement | undefined>(graph.incoming.length);
  const conflicts: SchedulingConflict[] = [];
  const keptStarts = new Map<TaskId, ProjectHour>();
  for (const { index, task } of graph.order) {
    const incoming = graph.incoming[index] ?? [];
    const requested = requestedStarts.get(task.id);
    const placed =
      requested === undefined
        ? scheduleTask(context, task, incoming, placements)
        : scheduleRequestedStart(context, task, incoming, placements, requested, keptStarts);
    if (!placed.ok) {
      return failure({ code: placed.error, taskId: task.id });
    }
    placements[index] = placed.value;
    conflicts.push(...findConflicts(context, task, placed.value));
  }
  return success({ placements, conflicts: sortConflicts(conflicts), keptStarts });
}

/** Tells whether a dependency starts from the start of its predecessor rather than its end. */
export function usesPredecessorStart(dependency: Dependency): boolean {
  return dependency.type === 'startToStart' || dependency.type === 'startToFinish';
}

/** Returns the instant a dependency starts from: the start or the end of its predecessor. */
export function dependencyAnchor(dependency: Dependency, predecessor: Placement): ProjectHour {
  return usesPredecessorStart(dependency) ? predecessor.start : predecessor.end;
}

/** Tells whether a dependency constrains the start of its successor rather than its end. */
export function constrainsSuccessorStart(dependency: Dependency): boolean {
  return dependency.type === 'finishToStart' || dependency.type === 'startToStart';
}

/** Places a task without any start date, then again with the requested start as its start date when it would otherwise start earlier, recording that start as kept. */
function scheduleRequestedStart(
  context: SchedulingContext,
  task: SchedulableTask,
  incoming: readonly ResolvedDependency[],
  placements: PlacementsByIndex,
  requested: ProjectHour,
  keptStarts: Map<TaskId, ProjectHour>,
): Result<Placement, PlacementErrorCode> {
  const free = scheduleTask(context, { ...task, startNoEarlierThan: null }, incoming, placements);
  if (!free.ok || free.value.start >= requested) {
    return free;
  }
  keptStarts.set(task.id, requested);
  return scheduleTask(context, { ...task, startNoEarlierThan: requested }, incoming, placements);
}

/** Places one task at its earliest position, then applies its "must finish on" constraint. */
function scheduleTask(
  context: SchedulingContext,
  task: SchedulableTask,
  incoming: readonly ResolvedDependency[],
  placements: PlacementsByIndex,
): Result<Placement, PlacementErrorCode> {
  const bounds = computeBounds(context, task, incoming, placements);
  if (!bounds.ok) {
    return bounds;
  }
  const { earliestStart, earliestEnd } = bounds.value;
  const earliest = placeTaskEarliest(context.calendar, task, earliestStart, earliestEnd);
  if (!earliest.ok || !context.dateConstraintsEnabled || task.mustFinishOn === null) {
    return earliest;
  }
  if (earliest.value.end >= task.mustFinishOn) {
    return earliest;
  }
  return placeTaskLatest(context.calendar, task, task.mustFinishOn, task.mustFinishOn);
}

/** Combines the project start, the task start date and every incoming dependency into bounds. */
function computeBounds(
  context: SchedulingContext,
  task: SchedulableTask,
  incoming: readonly ResolvedDependency[],
  placements: PlacementsByIndex,
): Result<Bounds, PlacementErrorCode> {
  let earliestStart = Math.max(
    context.projectStart,
    task.startNoEarlierThan ?? context.projectStart,
  );
  let earliestEnd: ProjectHour | null = null;
  for (const link of incoming) {
    const bound = dependencyBound(context, link, placements);
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
  link: ResolvedDependency,
  placements: PlacementsByIndex,
): Result<ProjectHour, PlacementErrorCode> {
  const predecessor = placements[link.predecessorIndex];
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
