import {
  nextWorkingHour,
  shiftWorkingHours,
  signedWorkingHoursBetween,
} from '../calendar/working-time';
import type { SchedulableTask } from '../model/project';
import { failure, success, type Result } from '../result';
import { valueAt } from '../table-value';
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

export interface KnownTaskFloat {
  readonly lateStart: ProjectHour;
  readonly lateFinish: ProjectHour;
  readonly totalFloatHours: number;
  readonly freeFloatHours: number;
  readonly isCritical: boolean;
}

/** The floats of a task that would have to start before the first supported year to keep the project on time: its total float, and so its free float, are negative by an unknown amount, which makes it critical. */
export interface UnknownTaskFloat {
  readonly lateStart: null;
  readonly lateFinish: null;
  readonly totalFloatHours: null;
  readonly freeFloatHours: null;
  readonly isCritical: true;
}

export type TaskFloat = KnownTaskFloat | UnknownTaskFloat;

export type FloatsByIndex = readonly (TaskFloat | undefined)[];

const UNKNOWN = 'unknown';
const UNKNOWN_FLOAT: UnknownTaskFloat = {
  lateStart: null,
  lateFinish: null,
  totalFloatHours: null,
  freeFloatHours: null,
  isCritical: true,
};

type SpansByUnit = readonly (ScheduledSegment | undefined)[];

type LateSpan = ScheduledSegment | typeof UNKNOWN;

type LateSpansByUnit = readonly (LateSpan | undefined)[];

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
  const lateBlocks = new Array<LateSpan | undefined>(graph.units.length);
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

/** Places one block as late as its next block, its successors, the project end and the advanced constraints of its task allow, or marks it unknown when that place falls before the first supported year or precedes an unknown block. */
function placeLate(
  context: SchedulingContext,
  unit: ScheduleUnit,
  outgoing: readonly UnitDependency[],
  lateBlocks: LateSpansByUnit,
  projectEnd: ProjectHour,
): Result<LateSpan, PlacementErrorCode> {
  const bounds = computeLateBounds(context, unit, outgoing, lateBlocks, projectEnd);
  if (!bounds.ok) {
    return unknownBeforeHorizon(bounds.error);
  }
  if (bounds.value === UNKNOWN) {
    return success(UNKNOWN);
  }
  const { latestStart, latestEnd } = bounds.value;
  const placed = placeTaskLatest(context.calendar, unit.blockTask, latestStart, latestEnd);
  return placed.ok
    ? success({ start: placed.value.start, end: placed.value.end })
    : unknownBeforeHorizon(placed.error);
}

/** Turns a failure to place a block late into an unknown place when it comes from dates before the first supported year, and keeps any other failure. */
function unknownBeforeHorizon(code: PlacementErrorCode): Result<LateSpan, PlacementErrorCode> {
  return code === 'BEYOND_PLANNING_HORIZON' ? success(UNKNOWN) : failure(code);
}

/** Combines the project end, advanced constraints, the next block and successors into latest bounds, unknown when one of those blocks is unknown, a lead that could only limit the block after the last supported year being left out. */
function computeLateBounds(
  context: SchedulingContext,
  unit: ScheduleUnit,
  outgoing: readonly UnitDependency[],
  lateBlocks: LateSpansByUnit,
  projectEnd: ProjectHour,
): Result<LateBounds | typeof UNKNOWN, PlacementErrorCode> {
  const advanced = unit.isLast ? advancedEndLimits(context, unit.task) : [];
  let latestEnd = Math.min(projectEnd, ...advanced);
  const next = knownLateSpans(unit.isLast ? [] : [unit.index + 1], lateBlocks);
  const successors = knownLateSpans(
    outgoing.map((link) => link.successorUnit),
    lateBlocks,
  );
  if (!next.ok || !successors.ok) {
    return failure('INVALID_INSTANT');
  }
  if (next.value === UNKNOWN || successors.value === UNKNOWN) {
    return success(UNKNOWN);
  }
  for (const nextBlock of next.value) {
    latestEnd = Math.min(
      latestEnd,
      latestEndBefore(nextBlock.start, gapBefore(unit.task, unit.block + 1)),
    );
  }
  let latestStart = latestEnd;
  for (const [position, { dependency }] of outgoing.entries()) {
    const successor = valueAt(successors.value, position);
    const anchor = constrainsSuccessorStart(dependency) ? successor.start : successor.end;
    const limit = shiftWorkingHours(context.calendar, anchor, -dependency.lagHours);
    if (!limit.ok && limit.error === 'BEYOND_PLANNING_HORIZON' && dependency.lagHours < 0) {
      continue;
    }
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

/** Returns the late places of some blocks, or unknown when one of them is unknown, failing when one has not been placed yet. */
function knownLateSpans(
  units: readonly number[],
  lateBlocks: LateSpansByUnit,
): Result<readonly ScheduledSegment[] | typeof UNKNOWN, PlacementErrorCode> {
  const spans: ScheduledSegment[] = [];
  let unknown = false;
  for (const index of units) {
    const span = lateBlocks[index];
    if (span === undefined) {
      return failure('INVALID_INSTANT');
    }
    unknown ||= span === UNKNOWN;
    if (span !== UNKNOWN) {
      spans.push(span);
    }
  }
  return success(unknown ? UNKNOWN : spans);
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
  spans: { readonly early: SpansByUnit; readonly late: LateSpansByUnit },
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

/** Computes the floats of one task: the smallest total float of its blocks and the smallest slack of their outgoing links, or of the time left until the project end, both unknown and the task critical when a block has no known late place. */
function computeTaskFloat(
  context: SchedulingContext,
  graph: DependencyGraph,
  spans: { readonly early: SpansByUnit; readonly late: LateSpansByUnit },
  units: { readonly first: number; readonly last: number },
  projectEnd: ProjectHour,
): Result<TaskFloat, PlacementErrorCode> {
  if (units.first > units.last) {
    return failure('INVALID_INSTANT');
  }
  const indexes = Array.from(
    { length: units.last - units.first + 1 },
    (_unused, offset) => units.first + offset,
  );
  const early = knownEarlySpans(indexes, spans.early);
  if (!early.ok) {
    return early;
  }
  const freeFloat = computeTaskFreeFloat(
    context,
    graph,
    spans.early,
    indexes,
    early.value,
    projectEnd,
  );
  if (!freeFloat.ok) {
    return freeFloat;
  }
  const late = knownLateSpans(indexes, spans.late);
  if (!late.ok) {
    return late;
  }
  if (late.value === UNKNOWN) {
    return success(UNKNOWN_FLOAT);
  }
  let totalFloat = Number.POSITIVE_INFINITY;
  for (const [offset, lateBlock] of late.value.entries()) {
    const blockFloat = computeTotalFloat(context, valueAt(early.value, offset), lateBlock);
    if (!blockFloat.ok) {
      return blockFloat;
    }
    totalFloat = Math.min(totalFloat, blockFloat.value);
  }
  return success({
    lateStart: valueAt(late.value, 0).start,
    lateFinish: valueAt(late.value, late.value.length - 1).end,
    totalFloatHours: totalFloat,
    freeFloatHours: Math.min(freeFloat.value, totalFloat),
    isCritical: totalFloat <= 0,
  });
}

/** Returns the early places of some blocks, failing when one has not been placed. */
function knownEarlySpans(
  units: readonly number[],
  early: SpansByUnit,
): Result<readonly ScheduledSegment[], PlacementErrorCode> {
  const spans: ScheduledSegment[] = [];
  for (const index of units) {
    const span = early[index];
    if (span === undefined) {
      return failure('INVALID_INSTANT');
    }
    spans.push(span);
  }
  return success(spans);
}

/** Computes the smallest slack of the links leaving the blocks of a task, or the time left from its end until the project end when no link leaves. */
function computeTaskFreeFloat(
  context: SchedulingContext,
  graph: DependencyGraph,
  earlyBlocks: SpansByUnit,
  indexes: readonly number[],
  blocks: readonly ScheduledSegment[],
  projectEnd: ProjectHour,
): Result<number, PlacementErrorCode> {
  let freeFloat = Number.POSITIVE_INFINITY;
  let hasLinks = false;
  for (const [offset, index] of indexes.entries()) {
    const outgoing = graph.outgoing[index] ?? [];
    hasLinks ||= outgoing.length > 0;
    const slack = computeFreeFloat(context, valueAt(blocks, offset), outgoing, earlyBlocks);
    if (!slack.ok) {
      return slack;
    }
    freeFloat = Math.min(freeFloat, slack.value);
  }
  return hasLinks
    ? success(freeFloat)
    : signedWorkingHoursBetween(
        context.calendar,
        valueAt(blocks, blocks.length - 1).end,
        projectEnd,
      );
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
