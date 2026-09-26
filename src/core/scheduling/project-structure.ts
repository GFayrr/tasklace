import { MAX_DEPENDENCIES, MAX_HIERARCHY_DEPTH, MAX_LAG_HOURS, MAX_TASKS } from '../limits';
import type { Dependency, DependencyId, Project, Task, TaskId } from '../model/project';
import { failure, success, type Result } from '../result';
import { compareStrings } from '../compare-strings';
import {
  buildDependencyGraph,
  type DependencyGraph,
  type ResolvedDependency,
} from './dependency-graph';

export type StructureErrorCode =
  | 'TOO_MANY_TASKS'
  | 'TOO_MANY_DEPENDENCIES'
  | 'DUPLICATE_TASK_ID'
  | 'UNKNOWN_PARENT'
  | 'PARENT_NOT_SUMMARY'
  | 'HIERARCHY_CYCLE'
  | 'HIERARCHY_TOO_DEEP'
  | 'DUPLICATE_DEPENDENCY_ID'
  | 'UNKNOWN_DEPENDENCY_TASK'
  | 'SELF_DEPENDENCY'
  | 'SUMMARY_DEPENDENCY'
  | 'DUPLICATE_DEPENDENCY'
  | 'INVALID_LAG'
  | 'DEPENDENCY_CYCLE';

export interface StructureError {
  readonly code: StructureErrorCode;
  readonly taskId?: TaskId;
  readonly dependencyId?: DependencyId;
}

export interface ProjectStructure {
  readonly tasks: readonly Task[];
  readonly childrenByParent: ReadonlyMap<TaskId | null, readonly Task[]>;
  readonly graph: DependencyGraph;
}

/** Checks the task tree and the dependency network, then orders tasks for scheduling. */
export function analyzeProjectStructure(
  project: Pick<Project, 'tasks' | 'dependencies'>,
): Result<ProjectStructure, readonly StructureError[]> {
  if (project.tasks.length > MAX_TASKS) {
    return failure([{ code: 'TOO_MANY_TASKS' }]);
  }
  if (project.dependencies.length > MAX_DEPENDENCIES) {
    return failure([{ code: 'TOO_MANY_DEPENDENCIES' }]);
  }
  const { tasks } = project;
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const indexById = new Map(tasks.map((task, index) => [task.id, index]));
  const checked = checkDependencies(project.dependencies, tasks, indexById);
  const errors = [
    ...findDuplicateTaskIds(tasks),
    ...findHierarchyErrors(tasks, tasksById),
    ...checked.errors,
  ];
  if (errors.length > 0) {
    return failure(errors);
  }
  const nodes = tasks.flatMap((task, index) => (task.kind === 'summary' ? [] : [{ index, task }]));
  const graph = buildDependencyGraph(nodes, tasks.length, checked.resolved);
  if (!graph.ok) {
    const blockedIds = graph.error.map((node) => node.task.id).sort(compareStrings);
    return failure(blockedIds.map((taskId) => ({ code: 'DEPENDENCY_CYCLE', taskId })));
  }
  return success({ tasks, childrenByParent: groupByParent(tasks), graph: graph.value });
}

/** Lists the problems that adding a dependency would cause, or nothing when it can be added. */
export function findNewDependencyErrors(
  project: Pick<Project, 'tasks' | 'dependencies'>,
  dependency: Dependency,
): readonly StructureError[] {
  const result = analyzeProjectStructure({
    tasks: project.tasks,
    dependencies: [...project.dependencies, dependency],
  });
  return result.ok ? [] : result.error;
}

/** Reports every task whose identifier is already used by an earlier task. */
function findDuplicateTaskIds(tasks: readonly Task[]): StructureError[] {
  const seen = new Set<TaskId>();
  const errors: StructureError[] = [];
  for (const task of tasks) {
    if (seen.has(task.id)) {
      errors.push({ code: 'DUPLICATE_TASK_ID', taskId: task.id });
    }
    seen.add(task.id);
  }
  return errors;
}

/** Reports unknown or invalid parents, loops in the task tree and trees that are too deep. */
function findHierarchyErrors(
  tasks: readonly Task[],
  tasksById: ReadonlyMap<TaskId, Task>,
): StructureError[] {
  const errors: StructureError[] = [];
  for (const task of tasks) {
    const code = findParentChainError(task, tasksById);
    if (code !== null) {
      errors.push({ code, taskId: task.id });
    }
  }
  return errors;
}

/** Walks up the parents of a task and returns the first problem found on the way. */
function findParentChainError(
  task: Task,
  tasksById: ReadonlyMap<TaskId, Task>,
): StructureErrorCode | null {
  if (task.parentId === null) {
    return null;
  }
  const visited = new Set<TaskId>([task.id]);
  let parentId: TaskId | null = task.parentId;
  while (parentId !== null) {
    const parent = tasksById.get(parentId);
    if (parent === undefined) {
      return 'UNKNOWN_PARENT';
    }
    if (parent.kind !== 'summary') {
      return 'PARENT_NOT_SUMMARY';
    }
    if (visited.has(parent.id)) {
      return 'HIERARCHY_CYCLE';
    }
    if (visited.size >= MAX_HIERARCHY_DEPTH) {
      return 'HIERARCHY_TOO_DEEP';
    }
    visited.add(parent.id);
    parentId = parent.parentId;
  }
  return null;
}

/** Resolves dependencies to task indices and reports duplicated, dangling, reflexive, summary-linked, repeated and badly lagged ones. */
function checkDependencies(
  dependencies: readonly Dependency[],
  tasks: readonly Task[],
  indexById: ReadonlyMap<TaskId, number>,
): { readonly errors: StructureError[]; readonly resolved: ResolvedDependency[] } {
  const seenIds = new Set<DependencyId>();
  const seenPairs = new Set<number>();
  const errors: StructureError[] = [];
  const resolved: ResolvedDependency[] = [];
  for (const dependency of dependencies) {
    const predecessorIndex = indexById.get(dependency.predecessorId) ?? -1;
    const successorIndex = indexById.get(dependency.successorId) ?? -1;
    const pairKey = predecessorIndex * tasks.length + successorIndex;
    const code = seenIds.has(dependency.id)
      ? 'DUPLICATE_DEPENDENCY_ID'
      : (findDependencyError(dependency, tasks[predecessorIndex], tasks[successorIndex]) ??
        (seenPairs.has(pairKey) ? 'DUPLICATE_DEPENDENCY' : null));
    if (code === null) {
      resolved.push({ dependency, predecessorIndex, successorIndex });
    } else {
      errors.push({ code, dependencyId: dependency.id });
    }
    seenIds.add(dependency.id);
    seenPairs.add(pairKey);
  }
  return { errors, resolved };
}

/** Returns the problem of a single dependency considered on its own, if any. */
function findDependencyError(
  dependency: Dependency,
  predecessor: Task | undefined,
  successor: Task | undefined,
): StructureErrorCode | null {
  if (predecessor === undefined || successor === undefined) {
    return 'UNKNOWN_DEPENDENCY_TASK';
  }
  if (predecessor.id === successor.id) {
    return 'SELF_DEPENDENCY';
  }
  if (predecessor.kind === 'summary' || successor.kind === 'summary') {
    return 'SUMMARY_DEPENDENCY';
  }
  const { lagHours } = dependency;
  return Number.isInteger(lagHours) && Math.abs(lagHours) <= MAX_LAG_HOURS ? null : 'INVALID_LAG';
}

/** Groups tasks by parent identifier, top-level tasks being grouped under null. */
function groupByParent(tasks: readonly Task[]): Map<TaskId | null, Task[]> {
  const groups = new Map<TaskId | null, Task[]>();
  for (const task of tasks) {
    const group = groups.get(task.parentId);
    if (group === undefined) {
      groups.set(task.parentId, [task]);
    } else {
      group.push(task);
    }
  }
  return groups;
}
