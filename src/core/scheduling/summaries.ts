import type { Task, TaskId } from '../model/project';
import type { ProjectHour } from '../time';
import type { Placement } from './task-placement';

export type SummarySchedule =
  | { readonly start: null; readonly end: null; readonly progressPercent: null }
  | { readonly start: ProjectHour; readonly end: ProjectHour; readonly progressPercent: number };

interface Aggregate {
  readonly start: ProjectHour | null;
  readonly end: ProjectHour | null;
  readonly workHours: number;
  readonly weightedProgress: number;
  readonly milestoneCount: number;
  readonly milestoneProgress: number;
}

const EMPTY_AGGREGATE: Aggregate = {
  start: null,
  end: null,
  workHours: 0,
  weightedProgress: 0,
  milestoneCount: 0,
  milestoneProgress: 0,
};

/** Computes the dates and progress of every summary task from its descendants. */
export function computeSummaries(
  tasks: readonly Task[],
  childrenByParent: ReadonlyMap<TaskId | null, readonly Task[]>,
  placements: ReadonlyMap<TaskId, Placement>,
): ReadonlyMap<TaskId, SummarySchedule> {
  const aggregates = new Map<TaskId, Aggregate>();
  const summaries = new Map<TaskId, SummarySchedule>();
  for (const task of tasks) {
    if (task.kind === 'summary') {
      const aggregate = aggregateTask(task, childrenByParent, placements, aggregates);
      summaries.set(task.id, toSummarySchedule(aggregate));
    }
  }
  return summaries;
}

/** Aggregates a task and its descendants, reusing aggregates already computed. */
function aggregateTask(
  task: Task,
  childrenByParent: ReadonlyMap<TaskId | null, readonly Task[]>,
  placements: ReadonlyMap<TaskId, Placement>,
  aggregates: Map<TaskId, Aggregate>,
): Aggregate {
  const known = aggregates.get(task.id);
  if (known !== undefined) {
    return known;
  }
  const aggregate =
    task.kind === 'summary'
      ? (childrenByParent.get(task.id) ?? [])
          .map((child) => aggregateTask(child, childrenByParent, placements, aggregates))
          .reduce(combineAggregates, EMPTY_AGGREGATE)
      : aggregateLeaf(task, placements.get(task.id));
  aggregates.set(task.id, aggregate);
  return aggregate;
}

/** Builds the aggregate of a work task or milestone from its placement. */
function aggregateLeaf(task: Exclude<Task, { kind: 'summary' }>, placement?: Placement): Aggregate {
  if (placement === undefined) {
    return EMPTY_AGGREGATE;
  }
  if (task.kind === 'milestone') {
    return {
      ...EMPTY_AGGREGATE,
      start: placement.start,
      end: placement.end,
      milestoneCount: 1,
      milestoneProgress: task.progressPercent,
    };
  }
  const workHours = task.segments.reduce((total, segment) => total + segment.durationHours, 0);
  return {
    ...EMPTY_AGGREGATE,
    start: placement.start,
    end: placement.end,
    workHours,
    weightedProgress: workHours * task.progressPercent,
  };
}

/** Merges two aggregates: earliest start, latest end and summed progress weights. */
function combineAggregates(left: Aggregate, right: Aggregate): Aggregate {
  return {
    start: pickDate(left.start, right.start, Math.min),
    end: pickDate(left.end, right.end, Math.max),
    workHours: left.workHours + right.workHours,
    weightedProgress: left.weightedProgress + right.weightedProgress,
    milestoneCount: left.milestoneCount + right.milestoneCount,
    milestoneProgress: left.milestoneProgress + right.milestoneProgress,
  };
}

/** Picks between two optional dates, ignoring missing ones. */
function pickDate(
  left: ProjectHour | null,
  right: ProjectHour | null,
  pick: (first: number, second: number) => number,
): ProjectHour | null {
  if (left === null) {
    return right;
  }
  return right === null ? left : pick(left, right);
}

/** Turns an aggregate into dates and a duration-weighted progress, milestones counting only alone, a summary with nothing dated inside having neither, and a dated summary without work holding at least one milestone. */
function toSummarySchedule(aggregate: Aggregate): SummarySchedule {
  const { start, end, workHours, weightedProgress, milestoneCount, milestoneProgress } = aggregate;
  if (start === null || end === null) {
    return { start: null, end: null, progressPercent: null };
  }
  const progressPercent =
    workHours > 0 ? weightedProgress / workHours : milestoneProgress / milestoneCount;
  return { start, end, progressPercent };
}
