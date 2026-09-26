import {
  nextWorkingHour,
  shiftWorkingHours,
  signedWorkingHoursBetween,
} from '../calendar/working-time';
import type { SchedulableTask } from '../model/project';
import { failure, success, type Result } from '../result';
import type { ProjectHour } from '../time';
import type { DependencyGraph, ResolvedDependency } from './dependency-graph';
import {
  constrainsSuccessorStart,
  dependencyAnchor,
  usesPredecessorStart,
  type PlacementsByIndex,
  type SchedulingContext,
  type TaskPlacementError,
} from './forward-pass';
import { placeTaskLatest, type Placement, type PlacementErrorCode } from './task-placement';

export interface TaskFloat {
  readonly lateStart: ProjectHour;
  readonly lateFinish: ProjectHour;
  readonly totalFloatHours: number;
  readonly freeFloatHours: number;
  readonly isCritical: boolean;
}

export type FloatsByIndex = readonly (TaskFloat | undefined)[];

interface LateBounds {
  readonly latestStart: ProjectHour;
  readonly latestEnd: ProjectHour;
}

/** Computes the latest placement, the floats and the critical flag of every task. */
export function runBackwardPass(
  context: SchedulingContext,
  graph: DependencyGraph,
  earlyPlacements: PlacementsByIndex,
): Result<FloatsByIndex, TaskPlacementError> {
  const projectEnd = earlyPlacements.reduce(
    (latest, placement) => Math.max(latest, placement?.end ?? latest),
    Number.NEGATIVE_INFINITY,
  );
  const latePlacements = new Array<Placement | undefined>(earlyPlacements.length);
  for (const { index, task } of [...graph.order].reverse()) {
    const outgoing = graph.outgoing[index] ?? [];
    const late = placeLate(context, task, outgoing, latePlacements, projectEnd);
    if (!late.ok) {
      return failure({ code: late.error, taskId: task.id });
    }
    latePlacements[index] = late.value;
  }
  return collectFloats(context, graph, earlyPlacements, latePlacements, projectEnd);
}

/** Places one task as late as its successors, the project end and its advanced constraints allow. */
function placeLate(
  context: SchedulingContext,
  task: SchedulableTask,
  outgoing: readonly ResolvedDependency[],
  latePlacements: PlacementsByIndex,
  projectEnd: ProjectHour,
): Result<Placement, PlacementErrorCode> {
  const bounds = computeLateBounds(context, task, outgoing, latePlacements, projectEnd);
  if (!bounds.ok) {
    return bounds;
  }
  const { latestStart, latestEnd } = bounds.value;
  return placeTaskLatest(context.calendar, task, latestStart, latestEnd);
}

/** Combines the project end, advanced constraints and successors into latest start and end bounds. */
function computeLateBounds(
  context: SchedulingContext,
  task: SchedulableTask,
  outgoing: readonly ResolvedDependency[],
  latePlacements: PlacementsByIndex,
  projectEnd: ProjectHour,
): Result<LateBounds, PlacementErrorCode> {
  let latestEnd = Math.min(projectEnd, ...advancedEndLimits(context, task));
  let latestStart = latestEnd;
  for (const { dependency, successorIndex } of outgoing) {
    const successor = latePlacements[successorIndex];
    if (successor === undefined) {
      return failure('INVALID_INSTANT');
    }
    const anchor = constrainsSuccessorStart(dependency) ? successor.start : successor.end;
    const limit = shiftWorkingHours(context.calendar, anchor, -dependency.lagHours);
    if (!limit.ok) {
      return limit;
    }
    if (usesPredecessorStart(dependency)) {
      latestStart = Math.min(latestStart, latestEquivalentStart(context, limit.value));
    } else {
      latestEnd = Math.min(latestEnd, limit.value);
    }
  }
  return success({ latestStart, latestEnd });
}

/** Moves a start limit forward to the next working hour, which is the same moment in working time. */
function latestEquivalentStart(context: SchedulingContext, limit: ProjectHour): ProjectHour {
  const next = nextWorkingHour(context.calendar, limit);
  return next.ok ? next.value : limit;
}

/** Returns the end limits set by the "must finish on" date and the deadline, when enabled. */
function advancedEndLimits(context: SchedulingContext, task: SchedulableTask): ProjectHour[] {
  if (!context.dateConstraintsEnabled) {
    return [];
  }
  return [task.mustFinishOn, task.deadline].filter((limit) => limit !== null);
}

/** Derives the total float, free float and critical flag of every task from both placements. */
function collectFloats(
  context: SchedulingContext,
  graph: DependencyGraph,
  earlyPlacements: PlacementsByIndex,
  latePlacements: PlacementsByIndex,
  projectEnd: ProjectHour,
): Result<FloatsByIndex, TaskPlacementError> {
  const floats = new Array<TaskFloat | undefined>(earlyPlacements.length);
  for (const { index, task } of graph.order) {
    const early = earlyPlacements[index];
    const late = latePlacements[index];
    const outgoing = graph.outgoing[index] ?? [];
    const taskFloat =
      early === undefined || late === undefined
        ? failure('INVALID_INSTANT' as const)
        : computeTaskFloat(context, { early, late }, outgoing, earlyPlacements, projectEnd);
    if (!taskFloat.ok) {
      return failure({ code: taskFloat.error, taskId: task.id });
    }
    floats[index] = taskFloat.value;
  }
  return success(floats);
}

/** Computes the floats of one task from its early and late placements. */
function computeTaskFloat(
  context: SchedulingContext,
  { early, late }: { readonly early: Placement; readonly late: Placement },
  outgoing: readonly ResolvedDependency[],
  earlyPlacements: PlacementsByIndex,
  projectEnd: ProjectHour,
): Result<TaskFloat, PlacementErrorCode> {
  const totalFloat = computeTotalFloat(context, early, late);
  if (!totalFloat.ok) {
    return totalFloat;
  }
  const freeFloat = computeFreeFloat(context, early, outgoing, earlyPlacements, projectEnd);
  if (!freeFloat.ok) {
    return freeFloat;
  }
  return success({
    lateStart: late.start,
    lateFinish: late.end,
    totalFloatHours: totalFloat.value,
    freeFloatHours: Math.min(freeFloat.value, totalFloat.value),
    isCritical: totalFloat.value <= 0,
  });
}

/** Computes the total float as the smaller of the start float and the finish float. */
function computeTotalFloat(
  context: SchedulingContext,
  early: Placement,
  late: Placement,
): Result<number, PlacementErrorCode> {
  const startFloat = signedWorkingHoursBetween(context.calendar, early.start, late.start);
  if (!startFloat.ok) {
    return startFloat;
  }
  const finishFloat = signedWorkingHoursBetween(context.calendar, early.end, late.end);
  return finishFloat.ok ? success(Math.min(startFloat.value, finishFloat.value)) : finishFloat;
}

/** Computes how long a task can slip without delaying the early placement of any successor. */
function computeFreeFloat(
  context: SchedulingContext,
  early: Placement,
  outgoing: readonly ResolvedDependency[],
  earlyPlacements: PlacementsByIndex,
  projectEnd: ProjectHour,
): Result<number, PlacementErrorCode> {
  if (outgoing.length === 0) {
    return signedWorkingHoursBetween(context.calendar, early.end, projectEnd);
  }
  let freeFloat = Number.POSITIVE_INFINITY;
  for (const link of outgoing) {
    const slack = dependencySlack(context, link, early, earlyPlacements);
    if (!slack.ok) {
      return slack;
    }
    freeFloat = Math.min(freeFloat, slack.value);
  }
  return success(freeFloat);
}

/** Measures the working hours between what a dependency requires and where its successor is. */
function dependencySlack(
  context: SchedulingContext,
  { dependency, successorIndex }: ResolvedDependency,
  early: Placement,
  earlyPlacements: PlacementsByIndex,
): Result<number, PlacementErrorCode> {
  const successor = earlyPlacements[successorIndex];
  if (successor === undefined) {
    return failure('INVALID_INSTANT');
  }
  const bound = shiftWorkingHours(
    context.calendar,
    dependencyAnchor(dependency, early),
    dependency.lagHours,
  );
  if (!bound.ok) {
    return bound;
  }
  const target = constrainsSuccessorStart(dependency) ? successor.start : successor.end;
  return signedWorkingHoursBetween(context.calendar, bound.value, target);
}
