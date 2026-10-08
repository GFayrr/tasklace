import { compileCalendar, type CompiledCalendar } from '../calendar/compile-calendar';
import { computeDailyWindow } from '../calendar/task-slots';
import { compareStrings } from '../compare-strings';
import {
  MAX_DEPENDENCIES,
  MAX_HIERARCHY_DEPTH,
  MAX_MERGE_REPAIR_ROUNDS,
  MAX_TAGS,
  MAX_TASKS,
} from '../limits';
import type { Dependency, Project, Task, TaskId, WorkTask } from '../model/project';
import { failure, success, type Result } from '../result';
import {
  blockKey,
  blockPairKey,
  isKnownBlock,
  predecessorBlockOf,
  successorBlockOf,
  unitCountOf,
} from '../scheduling/block-links';

export type RepairCode =
  | 'TASK_REMOVED'
  | 'DEPENDENCY_REMOVED'
  | 'BLOCK_LINK_CLEARED'
  | 'TAG_REMOVED'
  | 'TAG_CLEARED'
  | 'MOVED_TO_ROOT'
  | 'HOURS_PER_DAY_REDUCED'
  | 'DAILY_START_HOUR_CLEARED';

export interface Repair {
  readonly code: RepairCode;
  readonly id: string;
}

export interface RepairedProject {
  readonly project: Project;
  readonly repairs: readonly Repair[];
}

interface RepairStepResult extends RepairedProject {
  readonly rounds: number;
}

type RepairStep = (project: Project, remainingRounds: number) => RepairStepResult | null;

const REPAIR_STEPS: readonly RepairStep[] = [
  singleRound(trimToLimits),
  singleRound(clearUnknownTags),
  singleRound(moveTasksUnderInvalidParents),
  (project, remaining) => repeatRepair(project, remaining, findLoopTask, moveOneToRoot),
  (project, remaining) => repeatRepair(project, remaining, findTooDeepTask, moveOneToRoot),
  singleRound(removeInvalidDependencies),
  singleRound(clearUnknownBlocks),
  singleRound(removeDuplicateDependencies),
  breakDependencyCycles,
  singleRound(fitDailyPatterns),
];

/** Turns a project whose fields are valid but whose merged content breaks a rule into a valid one, always making the same choices whatever the order of the data, or refuses when too many rounds of repair are needed. */
export function repairProject(project: Project): Result<RepairedProject, 'TOO_MANY_REPAIRS'> {
  let current: RepairedProject = { project, repairs: [] };
  let usedRounds = 0;
  for (const step of REPAIR_STEPS) {
    const next = step(current.project, MAX_MERGE_REPAIR_ROUNDS - usedRounds);
    if (next === null) {
      return failure('TOO_MANY_REPAIRS');
    }
    usedRounds += next.rounds;
    current = { project: next.project, repairs: [...current.repairs, ...next.repairs] };
  }
  return success(current);
}

/** Wraps a repair done in one pass so that it takes no round of the repair budget. */
function singleRound(repair: (project: Project) => RepairedProject): RepairStep {
  return (project) => ({ ...repair(project), rounds: 0 });
}

/** Repeats a repair while a problem is found, one round per problem, or returns null when the rounds run out. */
function repeatRepair<T>(
  project: Project,
  remainingRounds: number,
  findProblem: (current: Project) => T | null,
  fixProblem: (current: Project, problem: T) => RepairedProject,
): RepairStepResult | null {
  const repairs: Repair[] = [];
  let current = project;
  let rounds = 0;
  for (let problem = findProblem(current); problem !== null; problem = findProblem(current)) {
    if (rounds >= remainingRounds) {
      return null;
    }
    const fixed = fixProblem(current, problem);
    repairs.push(...fixed.repairs);
    current = fixed.project;
    rounds += 1;
  }
  return { project: current, repairs, rounds };
}

/** Keeps the tasks, dependencies and tags with the smallest identifiers when a list exceeds its limit. */
function trimToLimits(project: Project): RepairedProject {
  const tasks = keepSmallestIds(project.tasks, MAX_TASKS);
  const dependencies = keepSmallestIds(project.dependencies, MAX_DEPENDENCIES);
  const tags = keepSmallestIds(project.tags, MAX_TAGS);
  return {
    project: { ...project, tasks: tasks.kept, dependencies: dependencies.kept, tags: tags.kept },
    repairs: [
      ...sortedRepairs('TASK_REMOVED', new Set(tasks.removedIds)),
      ...sortedRepairs('DEPENDENCY_REMOVED', new Set(dependencies.removedIds)),
      ...sortedRepairs('TAG_REMOVED', new Set(tags.removedIds)),
    ],
  };
}

/** Splits a list into the items with the smallest identifiers, up to a limit, and the identifiers of the others. */
function keepSmallestIds<T extends { readonly id: string }>(
  items: readonly T[],
  limit: number,
): { readonly kept: readonly T[]; readonly removedIds: readonly string[] } {
  if (items.length <= limit) {
    return { kept: items, removedIds: [] };
  }
  const sorted = [...items].sort((left, right) => compareStrings(left.id, right.id));
  return { kept: sorted.slice(0, limit), removedIds: sorted.slice(limit).map((item) => item.id) };
}

/** Removes the tag of every task that points at a tag that no longer exists. */
function clearUnknownTags(project: Project): RepairedProject {
  const tagIds = new Set(project.tags.map((tag) => tag.id));
  const clearedIds = new Set<TaskId>();
  const tasks = project.tasks.map((task): Task => {
    if (task.kind === 'summary' || task.tagId === null || tagIds.has(task.tagId)) {
      return task;
    }
    clearedIds.add(task.id);
    return { ...task, tagId: null };
  });
  return { project: { ...project, tasks }, repairs: sortedRepairs('TAG_CLEARED', clearedIds) };
}

/** Moves to the root every task whose parent no longer exists or is no longer a summary. */
function moveTasksUnderInvalidParents(project: Project): RepairedProject {
  const tasksById = new Map(project.tasks.map((task) => [task.id, task]));
  const movedIds = new Set(
    project.tasks
      .filter((task) => task.parentId !== null && tasksById.get(task.parentId)?.kind !== 'summary')
      .map((task) => task.id),
  );
  return moveToRoot(project, movedIds);
}

/** Returns the smallest identifier of the first loop found in the task tree, visiting tasks by identifier, or null. */
function findLoopTask(project: Project): TaskId | null {
  const parentById = new Map(project.tasks.map((task) => [task.id, task.parentId]));
  const finished = new Set<TaskId>();
  for (const id of [...parentById.keys()].sort(compareStrings)) {
    const loop = walkToLoop(id, parentById, finished);
    if (loop.length > 0) {
      return [...loop].sort(compareStrings)[0] ?? null;
    }
  }
  return null;
}

/** Follows the parents of a task and returns the tasks of the loop it runs into, or nothing when it reaches the root or an already explored task. */
function walkToLoop(
  startId: TaskId,
  parentById: ReadonlyMap<TaskId, TaskId | null>,
  finished: Set<TaskId>,
): TaskId[] {
  const path: TaskId[] = [];
  const onPath = new Set<TaskId>();
  let id: TaskId | null = startId;
  while (id !== null && !finished.has(id) && !onPath.has(id)) {
    path.push(id);
    onPath.add(id);
    id = parentById.get(id) ?? null;
  }
  path.forEach((visited) => finished.add(visited));
  return id !== null && onPath.has(id) ? path.slice(path.indexOf(id)) : [];
}

/** Returns the smallest identifier among the tasks nested deeper than the limit, or null, in a tree without loops. */
function findTooDeepTask(project: Project): TaskId | null {
  const parentById = new Map(project.tasks.map((task) => [task.id, task.parentId]));
  const depthById = computeDepths(parentById);
  const tooDeep = project.tasks
    .map((task) => task.id)
    .filter((id) => (depthById.get(id) ?? 0) > MAX_HIERARCHY_DEPTH)
    .sort(compareStrings);
  return tooDeep[0] ?? null;
}

/** Computes the depth of every task, a root task having depth 1, without recursion so that long chains stay safe. */
function computeDepths(parentById: ReadonlyMap<TaskId, TaskId | null>): Map<TaskId, number> {
  const depthById = new Map<TaskId, number>();
  for (const startId of parentById.keys()) {
    const path: TaskId[] = [];
    const onPath = new Set<TaskId>();
    let id: TaskId | null = startId;
    while (id !== null && !depthById.has(id) && !onPath.has(id)) {
      path.push(id);
      onPath.add(id);
      id = parentById.get(id) ?? null;
    }
    let depth = id === null ? 0 : (depthById.get(id) ?? 0);
    for (const visited of path.reverse()) {
      depth += 1;
      depthById.set(visited, depth);
    }
  }
  return depthById;
}

/** Moves one task to the root of the task tree. */
function moveOneToRoot(project: Project, id: TaskId): RepairedProject {
  return moveToRoot(project, new Set([id]));
}

/** Moves a set of tasks to the root of the task tree and reports each move. */
function moveToRoot(project: Project, ids: ReadonlySet<TaskId>): RepairedProject {
  const tasks = project.tasks.map((task): Task =>
    ids.has(task.id) ? { ...task, parentId: null } : task,
  );
  return { project: { ...project, tasks }, repairs: sortedRepairs('MOVED_TO_ROOT', ids) };
}

/** Removes every dependency whose tasks no longer exist, are the same task or include a summary. */
function removeInvalidDependencies(project: Project): RepairedProject {
  const kindById = new Map(project.tasks.map((task) => [task.id, task.kind]));
  /** Tells whether a task exists and can carry a link, that is whether it is not a summary. */
  const isLinkable = (id: TaskId): boolean => {
    const kind = kindById.get(id);
    return kind !== undefined && kind !== 'summary';
  };
  const removed = project.dependencies.filter(
    (dependency) =>
      dependency.predecessorId === dependency.successorId ||
      !isLinkable(dependency.predecessorId) ||
      !isLinkable(dependency.successorId),
  );
  return removeDependencies(project, new Set(removed.map((dependency) => dependency.id)));
}

/** Points every link that names a block its task no longer has at the whole task instead. */
function clearUnknownBlocks(project: Project): RepairedProject {
  const taskById = new Map(project.tasks.map((task) => [task.id, task]));
  /** Tells whether a task exists and has the block a link names. */
  const isKnown = (taskId: TaskId, block: number | null): boolean => {
    const task = taskById.get(taskId);
    return task !== undefined && isKnownBlock(task, block);
  };
  const cleared = new Set<string>();
  const dependencies = project.dependencies.map((dependency): Dependency => {
    const predecessorBlock = isKnown(dependency.predecessorId, dependency.predecessorBlock)
      ? dependency.predecessorBlock
      : null;
    const successorBlock = isKnown(dependency.successorId, dependency.successorBlock)
      ? dependency.successorBlock
      : null;
    if (
      predecessorBlock === dependency.predecessorBlock &&
      successorBlock === dependency.successorBlock
    ) {
      return dependency;
    }
    cleared.add(dependency.id);
    return { ...dependency, predecessorBlock, successorBlock };
  });
  return {
    project: { ...project, dependencies },
    repairs: sortedRepairs('BLOCK_LINK_CLEARED', cleared),
  };
}

/** Keeps only the dependency with the smallest identifier between the same two tasks or blocks. */
function removeDuplicateDependencies(project: Project): RepairedProject {
  const keptPairs = new Set<string>();
  const byId = [...project.dependencies].sort((left, right) => compareStrings(left.id, right.id));
  const removedIds = new Set<string>();
  for (const dependency of byId) {
    const pair = blockPairKey(dependency);
    if (keptPairs.has(pair)) {
      removedIds.add(dependency.id);
    }
    keptPairs.add(pair);
  }
  return removeDependencies(project, removedIds);
}

/** Removes, cycle after cycle, the dependency with the greatest identifier of each loop through the blocks of the tasks, re-examining only the blocks still caught behind a loop, or returns null when the rounds run out. */
function breakDependencyCycles(project: Project, remainingRounds: number): RepairStepResult | null {
  const { units, edges } = blockNetwork(project);
  let blocked = findBlockedUnits(units, edges);
  let left = edgesWithin(blocked, edges);
  const removedIds = new Set<string>();
  for (let cycle = findCycle(blocked, left); cycle !== null; cycle = findCycle(blocked, left)) {
    if (removedIds.size >= remainingRounds) {
      return null;
    }
    const greatest = cycle.reduce((kept, edge) =>
      compareStrings(edge.id, kept.id) > 0 ? edge : kept,
    );
    removedIds.add(greatest.id);
    left = left.filter((edge) => edge.id !== greatest.id);
    blocked = findBlockedUnits(blocked, left);
    left = edgesWithin(blocked, left);
  }
  return { ...removeDependencies(project, removedIds), rounds: removedIds.size };
}

interface BlockEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
}

/** Lists every block of the linkable tasks and the edges between them: from each block to the next block of its task, which has an empty identifier, and along each dependency. */
function blockNetwork(project: Project): {
  readonly units: Set<string>;
  readonly edges: BlockEdge[];
} {
  const countById = new Map(
    project.tasks.flatMap((task) =>
      task.kind === 'summary' ? [] : [[task.id, unitCountOf(task)] as const],
    ),
  );
  const units = new Set<string>();
  const edges: BlockEdge[] = [];
  countById.forEach((count, taskId) => {
    for (let block = 0; block < count; block += 1) {
      units.add(blockKey(taskId, block));
      if (block > 0) {
        edges.push({ id: '', from: blockKey(taskId, block - 1), to: blockKey(taskId, block) });
      }
    }
  });
  for (const dependency of project.dependencies) {
    const fromCount = countById.get(dependency.predecessorId);
    const toCount = countById.get(dependency.successorId);
    if (fromCount !== undefined && toCount !== undefined) {
      edges.push({
        id: dependency.id,
        from: blockKey(dependency.predecessorId, predecessorBlockOf(dependency, fromCount)),
        to: blockKey(dependency.successorId, successorBlockOf(dependency, toCount)),
      });
    }
  }
  return { units, edges };
}

/** Keeps the edges whose two blocks both belong to a set. */
function edgesWithin(units: ReadonlySet<string>, edges: readonly BlockEdge[]): BlockEdge[] {
  return edges.filter((edge) => units.has(edge.from) && units.has(edge.to));
}

/** Returns the blocks that can never be ordered because they are in or behind a loop, by peeling off blocks without remaining predecessors. */
function findBlockedUnits(units: ReadonlySet<string>, edges: readonly BlockEdge[]): Set<string> {
  const remaining = new Map<string, number>([...units].map((unit) => [unit, 0]));
  const outgoing = new Map<string, string[]>();
  for (const edge of edgesWithin(units, edges)) {
    remaining.set(edge.to, (remaining.get(edge.to) ?? 0) + 1);
    const successors = outgoing.get(edge.from) ?? [];
    successors.push(edge.to);
    outgoing.set(edge.from, successors);
  }
  const ready = [...remaining].flatMap(([unit, count]) => (count === 0 ? [unit] : []));
  for (let unit = ready.pop(); unit !== undefined; unit = ready.pop()) {
    remaining.delete(unit);
    releaseSuccessors(outgoing.get(unit) ?? [], remaining, ready);
  }
  return new Set(remaining.keys());
}

/** Decrements the remaining predecessors of each successor and queues those left with none. */
function releaseSuccessors(
  successors: readonly string[],
  remaining: Map<string, number>,
  ready: string[],
): void {
  for (const successor of successors) {
    const count = (remaining.get(successor) ?? 0) - 1;
    remaining.set(successor, count);
    if (count === 0) {
      ready.push(successor);
    }
  }
}

/** Returns the dependencies of one loop, found by walking back from the blocked block with the smallest key along the incoming edge with the smallest identifier, the edge to the next block of a task coming first, or null when no loop is left. */
function findCycle(
  blocked: ReadonlySet<string>,
  edges: readonly BlockEdge[],
): readonly [BlockEdge, ...BlockEdge[]] | null {
  const incoming = new Map<string, BlockEdge>();
  for (const edge of [...edges].sort((left, right) => compareStrings(left.id, right.id))) {
    if (!incoming.has(edge.to)) {
      incoming.set(edge.to, edge);
    }
  }
  const start = [...blocked].sort(compareStrings)[0];
  const loop = start === undefined ? null : walkBackToCycle(start, incoming);
  const [first, ...rest] = (loop ?? []).filter((edge) => edge.id !== '');
  return first === undefined ? null : [first, ...rest];
}

/** Follows one incoming edge after another from a blocked block and returns the edges of the loop it reaches, or null. */
function walkBackToCycle(
  start: string,
  incoming: ReadonlyMap<string, BlockEdge>,
): BlockEdge[] | null {
  const stepByUnit = new Map<string, number>();
  const path: BlockEdge[] = [];
  let unit: string | undefined = start;
  while (unit !== undefined && !stepByUnit.has(unit)) {
    stepByUnit.set(unit, path.length);
    const edge = incoming.get(unit);
    if (edge !== undefined) {
      path.push(edge);
    }
    unit = edge?.from;
  }
  return unit === undefined ? null : path.slice(stepByUnit.get(unit));
}

/** Removes a set of dependencies and reports each removal. */
function removeDependencies(project: Project, ids: ReadonlySet<string>): RepairedProject {
  const dependencies = project.dependencies.filter((dependency) => !ids.has(dependency.id));
  return {
    project: { ...project, dependencies },
    repairs: sortedRepairs('DEPENDENCY_REMOVED', ids),
  };
}

/** Reduces hours per day to the working day and clears daily start hours that no longer fit the calendar. */
function fitDailyPatterns(project: Project): RepairedProject {
  const calendar = compileCalendar(project.calendar);
  if (!calendar.ok) {
    return { project, repairs: [] };
  }
  const fitted = project.tasks.map((task) =>
    task.kind === 'task' ? fitDailyPattern(task, calendar.value) : { task, repairs: [] },
  );
  return {
    project: { ...project, tasks: fitted.map((item) => item.task) },
    repairs: fitted
      .flatMap((item) => item.repairs)
      .sort((left, right) => compareStrings(left.id, right.id)),
  };
}

/** Fits the daily working pattern of one work task into the calendar. */
export function fitDailyPattern(
  task: WorkTask,
  calendar: CompiledCalendar,
): { readonly task: Task; readonly repairs: readonly Repair[] } {
  const hoursPerWorkingDay = calendar.workingHoursPerDay;
  const tooManyHours = task.hoursPerDay !== null && task.hoursPerDay > hoursPerWorkingDay;
  const reduced = tooManyHours ? { ...task, hoursPerDay: hoursPerWorkingDay } : task;
  const window = computeDailyWindow(calendar, reduced);
  const cleared = window.ok ? reduced : { ...reduced, dailyStartHour: null };
  const repairs: Repair[] = [];
  if (tooManyHours) {
    repairs.push({ code: 'HOURS_PER_DAY_REDUCED', id: task.id });
  }
  if (!window.ok) {
    repairs.push({ code: 'DAILY_START_HOUR_CLEARED', id: task.id });
  }
  return { task: cleared, repairs };
}

/** Builds one repair per identifier, sorted by identifier. */
function sortedRepairs(code: RepairCode, ids: ReadonlySet<string>): Repair[] {
  return [...ids].sort(compareStrings).map((id) => ({ code, id }));
}
