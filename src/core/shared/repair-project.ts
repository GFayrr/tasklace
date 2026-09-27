import { compileCalendar, type CompiledCalendar } from '../calendar/compile-calendar';
import { computeDailyWindow } from '../calendar/task-slots';
import { compareStrings } from '../compare-strings';
import { MAX_DEPENDENCIES, MAX_HIERARCHY_DEPTH, MAX_TAGS, MAX_TASKS } from '../limits';
import type { Dependency, Project, Task, TaskId, WorkTask } from '../model/project';
import { analyzeStructureWithinLimits } from '../scheduling/project-structure';

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

type RepairStep = (project: Project) => RepairedProject;

const REPAIR_STEPS: readonly RepairStep[] = [
  trimToLimits,
  clearUnknownTags,
  moveTasksUnderInvalidParents,
  breakHierarchyLoops,
  flattenTooDeepTasks,
  removeInvalidDependencies,
  removeDuplicateDependencies,
  breakDependencyCycles,
  fitDailyPatterns,
];

/** Turns a project whose fields are valid but whose merged content breaks a rule into a valid one, using only identifiers to decide. */
export function repairProject(project: Project): RepairedProject {
  return REPAIR_STEPS.reduce<RepairedProject>(
    (current, step) => {
      const next = step(current.project);
      return { project: next.project, repairs: [...current.repairs, ...next.repairs] };
    },
    { project, repairs: [] },
  );
}

/** Keeps the tasks, dependencies and tags with the smallest identifiers when a list exceeds its limit. */
function trimToLimits(project: Project): RepairedProject {
  const tasks = keepSmallestIds(project.tasks, MAX_TASKS);
  const dependencies = keepSmallestIds(project.dependencies, MAX_DEPENDENCIES);
  const tags = keepSmallestIds(project.tags, MAX_TAGS);
  return {
    project: { ...project, tasks: tasks.kept, dependencies: dependencies.kept, tags: tags.kept },
    repairs: [
      ...tasks.removedIds.map((id) => ({ code: 'TASK_REMOVED' as const, id })),
      ...dependencies.removedIds.map((id) => ({ code: 'DEPENDENCY_REMOVED' as const, id })),
      ...tags.removedIds.map((id) => ({ code: 'TAG_REMOVED' as const, id })),
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
  const cleared = project.tasks.filter(
    (task) => task.kind !== 'summary' && task.tagId !== null && !tagIds.has(task.tagId),
  );
  const clearedIds = new Set(cleared.map((task) => task.id));
  const tasks = project.tasks.map((task) =>
    clearedIds.has(task.id) && task.kind !== 'summary' ? { ...task, tagId: null } : task,
  );
  return {
    project: { ...project, tasks },
    repairs: sortedRepairs('TAG_CLEARED', clearedIds),
  };
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

/** Moves to the root, loop after loop, the task with the smallest identifier of each loop in the task tree. */
function breakHierarchyLoops(project: Project): RepairedProject {
  const repairs: RepairedProject[] = [];
  let current = project;
  for (let loopTaskId = findLoopTask(current); loopTaskId !== null;) {
    const moved = moveToRoot(current, new Set([loopTaskId]));
    repairs.push(moved);
    current = moved.project;
    loopTaskId = findLoopTask(current);
  }
  return { project: current, repairs: repairs.flatMap((step) => step.repairs) };
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

/** Follows the parents of a task and returns the tasks of the loop it runs into, or nothing when it reaches the root. */
function walkToLoop(
  startId: TaskId,
  parentById: ReadonlyMap<TaskId, TaskId | null>,
  finished: Set<TaskId>,
): TaskId[] {
  const path: TaskId[] = [];
  let id: TaskId | null = startId;
  while (id !== null && !finished.has(id) && !path.includes(id)) {
    path.push(id);
    id = parentById.get(id) ?? null;
  }
  path.forEach((visited) => finished.add(visited));
  return id !== null && path.includes(id) ? path.slice(path.indexOf(id)) : [];
}

/** Moves to the root, one at a time, the too deep task with the smallest identifier until the tree fits the depth limit. */
function flattenTooDeepTasks(project: Project): RepairedProject {
  const repairs: RepairedProject[] = [];
  let current = project;
  for (let deepTaskId = findTooDeepTask(current); deepTaskId !== null;) {
    const moved = moveToRoot(current, new Set([deepTaskId]));
    repairs.push(moved);
    current = moved.project;
    deepTaskId = findTooDeepTask(current);
  }
  return { project: current, repairs: repairs.flatMap((step) => step.repairs) };
}

/** Returns the smallest identifier among the tasks nested deeper than the limit, or null, in a tree without loops. */
function findTooDeepTask(project: Project): TaskId | null {
  const parentById = new Map(project.tasks.map((task) => [task.id, task.parentId]));
  const depthById = new Map<TaskId, number>();
  const depthOf = (id: TaskId): number => {
    const known = depthById.get(id);
    if (known !== undefined) {
      return known;
    }
    const parentId = parentById.get(id) ?? null;
    const depth = parentId === null ? 1 : depthOf(parentId) + 1;
    depthById.set(id, depth);
    return depth;
  };
  const tooDeep = project.tasks
    .map((task) => task.id)
    .filter((id) => depthOf(id) > MAX_HIERARCHY_DEPTH)
    .sort(compareStrings);
  return tooDeep[0] ?? null;
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
  const keptByPair = new Map<string, Dependency>();
  const byId = [...project.dependencies].sort((left, right) => compareStrings(left.id, right.id));
  const removedIds = new Set<string>();
  for (const dependency of byId) {
    const pair = JSON.stringify([dependency.predecessorId, dependency.successorId]);
    if (keptByPair.has(pair)) {
      removedIds.add(dependency.id);
    } else {
      keptByPair.set(pair, dependency);
    }
  }
  return removeDependencies(project, removedIds);
}

/** Removes, cycle after cycle, the dependency with the greatest identifier of each dependency cycle. */
function breakDependencyCycles(project: Project): RepairedProject {
  const repairs: RepairedProject[] = [];
  let current = project;
  for (let cycle = findDependencyCycle(current); cycle.length > 0;) {
    const greatest = [...cycle].sort((left, right) => compareStrings(right.id, left.id))[0];
    const removed = removeDependencies(
      current,
      new Set(greatest === undefined ? [] : [greatest.id]),
    );
    repairs.push(removed);
    current = removed.project;
    cycle = findDependencyCycle(current);
  }
  return { project: current, repairs: repairs.flatMap((step) => step.repairs) };
}

/** Returns the dependencies of one cycle, found by walking back from the blocked task with the smallest identifier, or nothing. */
function findDependencyCycle(project: Project): Dependency[] {
  const structure = analyzeStructureWithinLimits(project);
  const blocked = new Set(
    structure.ok
      ? []
      : structure.error.flatMap((error) =>
          error.code === 'DEPENDENCY_CYCLE' ? [error.taskId] : [],
        ),
  );
  const incoming = new Map<TaskId, Dependency>();
  const byId = [...project.dependencies].sort((left, right) => compareStrings(left.id, right.id));
  for (const dependency of byId.filter((item) => blocked.has(item.predecessorId))) {
    if (blocked.has(dependency.successorId) && !incoming.has(dependency.successorId)) {
      incoming.set(dependency.successorId, dependency);
    }
  }
  const start = [...blocked].sort(compareStrings)[0];
  return start === undefined ? [] : walkBackToCycle(start, incoming);
}

/** Follows one incoming dependency after another from a blocked task and returns those that close a cycle. */
function walkBackToCycle(start: TaskId, incoming: ReadonlyMap<TaskId, Dependency>): Dependency[] {
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
  return taskId === undefined ? [] : path.slice(stepByTask.get(taskId));
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
function fitDailyPattern(
  task: WorkTask,
  calendar: CompiledCalendar,
): { readonly task: Task; readonly repairs: readonly Repair[] } {
  const hoursPerWorkingDay = calendar.workingHoursOfDay.length;
  const tooManyHours = task.hoursPerDay !== null && task.hoursPerDay > hoursPerWorkingDay;
  const reduced = tooManyHours ? { ...task, hoursPerDay: hoursPerWorkingDay } : task;
  const window = computeDailyWindow(calendar, reduced);
  const cleared = window.ok ? reduced : { ...reduced, dailyStartHour: null };
  const repairs: Repair[] = [
    ...(tooManyHours ? [{ code: 'HOURS_PER_DAY_REDUCED' as const, id: task.id }] : []),
    ...(window.ok ? [] : [{ code: 'DAILY_START_HOUR_CLEARED' as const, id: task.id }]),
  ];
  return { task: cleared, repairs };
}

/** Builds one repair per identifier, sorted by identifier. */
function sortedRepairs(code: RepairCode, ids: ReadonlySet<string>): Repair[] {
  return [...ids].sort(compareStrings).map((id) => ({ code, id }));
}
