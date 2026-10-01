import {
  nextWorkingHour,
  shiftWorkingHours,
  signedWorkingHoursBetween,
} from '../calendar/working-time';
import type { SchedulableTask } from '../model/project';
import { failure, success, type Result } from '../result';
import { dayIndexOf, startOfDay, type ProjectHour } from '../time';
import type { DependencyGraph, ScheduleUnit, UnitDependency } from './dependency-graph';
import {
  constrainsSuccessorStart,
  dependencyAnchor,
  gapBefore,
  usesPredecessorStart,
  type PlacementsByIndex,
  type SchedulingContext,
  type TaskPlacementError,
} from './forward-pass';
import { placeTaskLatest, type PlacementErrorCode, type ScheduledSegment } from './task-placement';

export interface TaskFloat {
  readonly lateStart: ProjectHour;
  readonly lateFinish: ProjectHour;
  readonly totalFloatHours: number;
  readonly freeFloatHours: number;
  readonly isCritical: boolean;
}

export type FloatsByIndex = readonly (TaskFloat | undefined)[];

type SpansByUnit = readonly (ScheduledSegment | undefined)[];

interface LateBounds {
  readonly latestStart: ProjectHour;
  readonly latestEnd: ProjectHour;
}

/** Computes the latest placement of every block, then the floats and the critical flag of every task. */
export function runBackwardPass(
  context: SchedulingContext,
  graph: DependencyGraph,
  earlyPlacements: PlacementsByIndex,
): Result<FloatsByIndex, TaskPlacementError> {
  const projectEnd = earlyPlacements.reduce(
    (latest, placement) => Math.max(latest, placement?.end ?? latest),
    Number.NEGATIVE_INFINITY,
  );
  const lateBlocks = new Array<ScheduledSegment | undefined>(graph.units.length);
  for (const unit of [...graph.order].reverse()) {
    const late = placeLate(context, unit, graph.outgoing[unit.index] ?? [], lateBlocks, projectEnd);
    if (!late.ok) {
      return failure({ code: late.error, taskId: unit.task.id });
    }
    lateBlocks[unit.index] = late.value;
  }
  const earlyBlocks = blocksOf(graph, earlyPlacements);
  return collectFloats(context, graph, { early: earlyBlocks, late: lateBlocks }, projectEnd);
}

/** Places one block as late as the next block of its task, its successors, the project end and the advanced constraints of its task allow. */
function placeLate(
  context: SchedulingContext,
  unit: ScheduleUnit,
  outgoing: readonly UnitDependency[],
  lateBlocks: SpansByUnit,
  projectEnd: ProjectHour,
): Result<ScheduledSegment, PlacementErrorCode> {
  const bounds = computeLateBounds(context, unit, outgoing, lateBlocks, projectEnd);
  if (!bounds.ok) {
    return bounds;
  }
  const { latestStart, latestEnd } = bounds.value;
  const placed = placeTaskLatest(context.calendar, unit.blockTask, latestStart, latestEnd);
  return placed.ok ? success({ start: placed.value.start, end: placed.value.end }) : placed;
}

/** Combines the project end, advanced constraints, the next block and successors into latest start and end bounds. */
function computeLateBounds(
  context: SchedulingContext,
  unit: ScheduleUnit,
  outgoing: readonly UnitDependency[],
  lateBlocks: SpansByUnit,
  projectEnd: ProjectHour,
): Result<LateBounds, PlacementErrorCode> {
  const advanced = unit.isLast ? advancedEndLimits(context, unit.task) : [];
  let latestEnd = Math.min(projectEnd, ...advanced);
  const next = unit.isLast ? undefined : lateBlocks[unit.index + 1];
  if (!unit.isLast && next === undefined) {
    return failure('INVALID_INSTANT');
  }
  if (next !== undefined) {
    latestEnd = Math.min(
      latestEnd,
      latestEndBefore(next.start, gapBefore(unit.task, unit.block + 1)),
    );
  }
  let latestStart = latestEnd;
  for (const { dependency, successorUnit } of outgoing) {
    const successor = lateBlocks[successorUnit];
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

/** Returns the latest end of a block that still lets the next block of its task start at the given instant, given the gap in days between them. */
function latestEndBefore(nextStart: ProjectHour, gapDays: number): ProjectHour {
  return Math.min(nextStart, startOfDay(dayIndexOf(nextStart) - gapDays + 1));
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

/** Lists the early time span of every block from the early placements of the tasks, a milestone spanning its own instant. */
function blocksOf(
  graph: DependencyGraph,
  placements: PlacementsByIndex,
): (ScheduledSegment | undefined)[] {
  return graph.units.map((unit) => {
    const placement = placements[unit.taskIndex];
    return unit.task.kind === 'milestone' ? placement : placement?.segments[unit.block];
  });
}

/** Derives the total float, free float and critical flag of every task from the early and late spans of its blocks. */
function collectFloats(
  context: SchedulingContext,
  graph: DependencyGraph,
  spans: { readonly early: SpansByUnit; readonly late: SpansByUnit },
  projectEnd: ProjectHour,
): Result<FloatsByIndex, TaskPlacementError> {
  const floats = new Array<TaskFloat | undefined>(graph.firstUnitOfTask.length);
  for (const unit of graph.units) {
    if (!unit.isLast) {
      continue;
    }
    const first = graph.firstUnitOfTask[unit.taskIndex];
    if (first === undefined) {
      return failure({ code: 'INVALID_INSTANT', taskId: unit.task.id });
    }
    const taskFloat = computeTaskFloat(
      context,
      graph,
      spans,
      { first, last: unit.index },
      projectEnd,
    );
    if (!taskFloat.ok) {
      return failure({ code: taskFloat.error, taskId: unit.task.id });
    }
    floats[unit.taskIndex] = taskFloat.value;
  }
  return success(floats);
}

/** Computes the floats of one task: the smallest total float of its blocks, and the smallest slack of the links leaving them, or the time left until the project end when none leaves. */
function computeTaskFloat(
  context: SchedulingContext,
  graph: DependencyGraph,
  spans: { readonly early: SpansByUnit; readonly late: SpansByUnit },
  units: { readonly first: number; readonly last: number },
  projectEnd: ProjectHour,
): Result<TaskFloat, PlacementErrorCode> {
  let totalFloat = Number.POSITIVE_INFINITY;
  let freeFloat = Number.POSITIVE_INFINITY;
  let hasLinks = false;
  for (let index = units.first; index <= units.last; index += 1) {
    const early = spans.early[index];
    const late = spans.late[index];
    if (early === undefined || late === undefined) {
      return failure('INVALID_INSTANT');
    }
    const blockFloat = computeTotalFloat(context, early, late);
    if (!blockFloat.ok) {
      return blockFloat;
    }
    totalFloat = Math.min(totalFloat, blockFloat.value);
    const outgoing = graph.outgoing[index] ?? [];
    hasLinks ||= outgoing.length > 0;
    const slack = computeFreeFloat(context, early, outgoing, spans.early);
    if (!slack.ok) {
      return slack;
    }
    freeFloat = Math.min(freeFloat, slack.value);
  }
  const lastEarly = spans.early[units.last];
  const firstLate = spans.late[units.first];
  const lastLate = spans.late[units.last];
  if (lastEarly === undefined || firstLate === undefined || lastLate === undefined) {
    return failure('INVALID_INSTANT');
  }
  if (!hasLinks) {
    const toEnd = signedWorkingHoursBetween(context.calendar, lastEarly.end, projectEnd);
    if (!toEnd.ok) {
      return toEnd;
    }
    freeFloat = toEnd.value;
  }
  return success({
    lateStart: firstLate.start,
    lateFinish: lastLate.end,
    totalFloatHours: totalFloat,
    freeFloatHours: Math.min(freeFloat, totalFloat),
    isCritical: totalFloat <= 0,
  });
}

/** Computes the total float of a block as the smaller of its start float and its finish float. */
function computeTotalFloat(
  context: SchedulingContext,
  early: ScheduledSegment,
  late: ScheduledSegment,
): Result<number, PlacementErrorCode> {
  const startFloat = signedWorkingHoursBetween(context.calendar, early.start, late.start);
  if (!startFloat.ok) {
    return startFloat;
  }
  const finishFloat = signedWorkingHoursBetween(context.calendar, early.end, late.end);
  return finishFloat.ok ? success(Math.min(startFloat.value, finishFloat.value)) : finishFloat;
}

/** Computes how long a block can slip without delaying the early placement of any successor, or an unlimited value when it has none. */
function computeFreeFloat(
  context: SchedulingContext,
  early: ScheduledSegment,
  outgoing: readonly UnitDependency[],
  earlyBlocks: SpansByUnit,
): Result<number, PlacementErrorCode> {
  let freeFloat = Number.POSITIVE_INFINITY;
  for (const link of outgoing) {
    const slack = dependencySlack(context, link, early, earlyBlocks);
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
  { dependency, successorUnit }: UnitDependency,
  early: ScheduledSegment,
  earlyBlocks: SpansByUnit,
): Result<number, PlacementErrorCode> {
  const successor = earlyBlocks[successorUnit];
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
