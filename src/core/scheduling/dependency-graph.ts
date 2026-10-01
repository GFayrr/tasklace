import type { Dependency, SchedulableTask } from '../model/project';
import { failure, success, type Result } from '../result';
import { predecessorBlockOf, successorBlockOf, unitCountOf } from './block-links';

export interface UnitDependency {
  readonly dependency: Dependency;
  readonly predecessorUnit: number;
  readonly successorUnit: number;
}

export interface GraphNode {
  readonly index: number;
  readonly task: SchedulableTask;
}

export interface ScheduleUnit {
  readonly index: number;
  readonly taskIndex: number;
  readonly task: SchedulableTask;
  readonly block: number;
  readonly blockTask: SchedulableTask;
  readonly isLast: boolean;
}

export interface DependencyGraph extends ScheduleUnits {
  readonly order: readonly ScheduleUnit[];
  readonly incoming: readonly (readonly UnitDependency[])[];
  readonly outgoing: readonly (readonly UnitDependency[])[];
}

export interface ScheduleUnits {
  readonly units: readonly ScheduleUnit[];
  readonly firstUnitOfTask: readonly (number | undefined)[];
}

/** Orders the blocks so that each comes after the previous block of its task and after what it waits for, or returns the tasks caught in or behind a cycle. */
export function buildDependencyGraph(
  { units, firstUnitOfTask }: ScheduleUnits,
  links: readonly UnitDependency[],
): Result<DependencyGraph, GraphNode[]> {
  const incoming = groupLinks(units.length, links, (link) => link.successorUnit);
  const outgoing = groupLinks(units.length, links, (link) => link.predecessorUnit);
  const remaining = units.map(
    (unit) => (incoming[unit.index]?.length ?? 0) + (unit.block > 0 ? 1 : 0),
  );
  const ready = units.filter((unit) => remaining[unit.index] === 0);
  const order: ScheduleUnit[] = [];
  for (let unit = ready.pop(); unit !== undefined; unit = ready.pop()) {
    order.push(unit);
    for (const link of outgoing[unit.index] ?? []) {
      releaseUnit(link.successorUnit, remaining, units, ready);
    }
    if (!unit.isLast) {
      releaseUnit(unit.index + 1, remaining, units, ready);
    }
  }
  if (order.length < units.length) {
    return failure(blockedTasks(units, remaining));
  }
  return success({ units, order, incoming, outgoing, firstUnitOfTask });
}

/** Lists every block to schedule, a milestone counting as one, task after task, with the index of the first block of each task. */
export function listUnits(nodes: readonly GraphNode[], taskCount: number): ScheduleUnits {
  const units: ScheduleUnit[] = [];
  const firstUnitOfTask = new Array<number | undefined>(taskCount);
  for (const { index, task } of nodes) {
    const blockTasks = blockTasksOf(task);
    firstUnitOfTask[index] = units.length;
    blockTasks.forEach((blockTask, block) => {
      const isLast = block === blockTasks.length - 1;
      units.push({ index: units.length, taskIndex: index, task, block, blockTask, isLast });
    });
  }
  return { units, firstUnitOfTask };
}

/** Returns a task reduced to each of its blocks, to place every block alone with the daily pattern of the task, a task of one block and a milestone being their own single block. */
export function blockTasksOf(task: SchedulableTask): SchedulableTask[] {
  if (task.kind === 'milestone' || task.segments.length === 1) {
    return [task];
  }
  return task.segments.map((segment) => ({
    ...task,
    segments: [{ durationHours: segment.durationHours, gapDaysBefore: 0 }],
  }));
}

/** Joins a valid dependency to the blocks it leaves and leads to. */
export function toUnitDependency(
  dependency: Dependency,
  tasks: { readonly predecessor: SchedulableTask; readonly successor: SchedulableTask },
  firstUnits: { readonly predecessor: number; readonly successor: number },
): UnitDependency {
  return {
    dependency,
    predecessorUnit: predecessorUnitOf(
      dependency,
      firstUnits.predecessor,
      unitCountOf(tasks.predecessor),
    ),
    successorUnit: successorUnitOf(dependency, firstUnits.successor, unitCountOf(tasks.successor)),
  };
}

/** Returns the index in the list of blocks of the block a dependency leaves, from the index of the first block of its task. */
export function predecessorUnitOf(
  dependency: Dependency,
  firstUnit: number,
  unitCount: number,
): number {
  return firstUnit + predecessorBlockOf(dependency, unitCount);
}

/** Returns the index in the list of blocks of the block a dependency leads to, from the index of the first block of its task. */
export function successorUnitOf(
  dependency: Dependency,
  firstUnit: number,
  unitCount: number,
): number {
  return firstUnit + successorBlockOf(dependency, unitCount);
}

/** Decrements the count of what a block still waits for and queues it once it waits for nothing. */
function releaseUnit(
  index: number,
  remaining: number[],
  units: readonly ScheduleUnit[],
  ready: ScheduleUnit[],
): void {
  const count = (remaining[index] ?? 0) - 1;
  remaining[index] = count;
  const unit = units[index];
  if (count === 0 && unit !== undefined) {
    ready.push(unit);
  }
}

/** Lists the tasks with a block that could never be ordered. */
function blockedTasks(units: readonly ScheduleUnit[], remaining: readonly number[]): GraphNode[] {
  const blocked = new Map<number, GraphNode>();
  for (const unit of units) {
    if ((remaining[unit.index] ?? 0) > 0 && !blocked.has(unit.taskIndex)) {
      blocked.set(unit.taskIndex, { index: unit.taskIndex, task: unit.task });
    }
  }
  return [...blocked.values()];
}

/** Groups links by the block index returned by a key function. */
function groupLinks(
  unitCount: number,
  links: readonly UnitDependency[],
  keyOf: (link: UnitDependency) => number,
): UnitDependency[][] {
  const groups = Array.from({ length: unitCount }, (): UnitDependency[] => []);
  for (const link of links) {
    groups[keyOf(link)]?.push(link);
  }
  return groups;
}
