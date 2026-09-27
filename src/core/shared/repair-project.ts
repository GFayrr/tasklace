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

export type RepairCode =
  | 'TASK_REMOVED'
  | 'DEPENDENCY_REMOVED'
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

/** Keeps only the dependency with the smallest identifier between the same two tasks. */
function removeDuplicateDependencies(project: Project): RepairedProject {
  const keptPairs = new Set<string>();
  const byId = [...project.dependencies].sort((left, right) => compareStrings(left.id, right.id));
  const removedIds = new Set<string>();
  for (const dependency of byId) {
    const pair = JSON.stringify([dependency.predecessorId, dependency.successorId]);
    if (keptPairs.has(pair)) {
      removedIds.add(dependency.id);
    }
    keptPairs.add(pair);
  }
  return removeDependencies(project, removedIds);
}

/** Removes, cycle after cycle, the dependency with the greatest identifier of each dependency cycle, re-examining only the tasks still blocked by a cycle, or returns null when the rounds run out. */
function breakDependencyCycles(project: Project, remainingRounds: number): RepairStepResult | null {
  const linkable = new Set(
    project.tasks.filter((task) => task.kind !== 'summary').map((task) => task.id),
  );
  let blocked = findBlockedTasks(linkable, project.dependencies);
  let links = linksWithin(blocked, project.dependencies);
  const removedIds = new Set<string>();
  for (let cycle = findCycle(blocked, links); cycle !== null; cycle = findCycle(blocked, links)) {
    if (removedIds.size >= remainingRounds) {
      return null;
    }
    const greatest = cycle.reduce((kept, dependency) =>
      compareStrings(dependency.id, kept.id) > 0 ? dependency : kept,
    );
    removedIds.add(greatest.id);
    const left = links.filter((link) => link.id !== greatest.id);
    blocked = findBlockedTasks(blocked, left);
    links = linksWithin(blocked, left);
  }
  return { ...removeDependencies(project, removedIds), rounds: removedIds.size };
}

/** Keeps the dependencies whose two tasks both belong to a set. */
function linksWithin(tasks: ReadonlySet<TaskId>, links: readonly Dependency[]): Dependency[] {
  return links.filter((link) => tasks.has(link.predecessorId) && tasks.has(link.successorId));
}

/** Returns the tasks that can never be ordered because they are in or behind a dependency cycle, by peeling off tasks without remaining predecessors. */
function findBlockedTasks(tasks: ReadonlySet<TaskId>, links: readonly Dependency[]): Set<TaskId> {
  const remaining = new Map<TaskId, number>([...tasks].map((id) => [id, 0]));
  const outgoing = new Map<TaskId, TaskId[]>();
  for (const link of linksWithin(tasks, links)) {
    remaining.set(link.successorId, (remaining.get(link.successorId) ?? 0) + 1);
    const successors = outgoing.get(link.predecessorId) ?? [];
    successors.push(link.successorId);
    outgoing.set(link.predecessorId, successors);
  }
  const ready = [...remaining].flatMap(([id, count]) => (count === 0 ? [id] : []));
  for (let id = ready.pop(); id !== undefined; id = ready.pop()) {
    remaining.delete(id);
    releaseSuccessors(outgoing.get(id) ?? [], remaining, ready);
  }
  return new Set(remaining.keys());
}

/** Decrements the remaining predecessors of each successor and queues those left with none. */
function releaseSuccessors(
  successors: readonly TaskId[],
  remaining: Map<TaskId, number>,
  ready: TaskId[],
): void {
  for (const successor of successors) {
    const count = (remaining.get(successor) ?? 0) - 1;
    remaining.set(successor, count);
    if (count === 0) {
      ready.push(successor);
    }
  }
}

/** Returns the dependencies of one cycle, found by walking back from the blocked task with the smallest identifier along the incoming dependency with the smallest identifier, or null when no cycle is left. */
function findCycle(
  blocked: ReadonlySet<TaskId>,
  links: readonly Dependency[],
): readonly [Dependency, ...Dependency[]] | null {
  const incoming = new Map<TaskId, Dependency>();
  for (const link of [...links].sort((left, right) => compareStrings(left.id, right.id))) {
    if (!incoming.has(link.successorId)) {
      incoming.set(link.successorId, link);
    }
  }
  const start = [...blocked].sort(compareStrings)[0];
  return start === undefined ? null : walkBackToCycle(start, incoming);
}

/** Follows one incoming dependency after another from a blocked task and returns the dependencies of the cycle it reaches, or null. */
function walkBackToCycle(
  start: TaskId,
  incoming: ReadonlyMap<TaskId, Dependency>,
): readonly [Dependency, ...Dependency[]] | null {
  const stepByTask = new Map<TaskId, number>();
  const path: Dependency[] = [];
  let taskId: TaskId | undefined = start;
  while (taskId !== undefined && !stepByTask.has(taskId)) {
    stepByTask.set(taskId, path.length);
    const dependency = incoming.get(taskId);
    if (dependency !== undefined) {
      path.push(dependency);
    }
    taskId = dependency?.predecessorId;
  }
  const [first, ...rest] = taskId === undefined ? [] : path.slice(stepByTask.get(taskId));
  return first === undefined ? null : [first, ...rest];
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
  const hoursPerWorkingDay = calendar.workingHoursOfDay.length;
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
