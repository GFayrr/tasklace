import { isQuarterHours } from '../time';
import {
  MAX_DEPENDENCIES,
  MAX_TAGS,
  MAX_HIERARCHY_DEPTH,
  MAX_LAG_HOURS,
  MAX_TASKS,
} from '../limits';
import type { Dependency, DependencyId, Project, Tag, TagId, Task, TaskId } from '../model/project';
import { failure, success, type Result } from '../result';
import { compareStrings } from '../compare-strings';
import {
  buildDependencyGraph,
  type DependencyGraph,
  type ResolvedDependency,
} from './dependency-graph';

type LimitErrorCode = 'TOO_MANY_TASKS' | 'TOO_MANY_DEPENDENCIES' | 'TOO_MANY_TAGS';
type TaskErrorCode =
  | 'DUPLICATE_TASK_ID'
  | 'UNKNOWN_PARENT'
  | 'PARENT_NOT_SUMMARY'
  | 'HIERARCHY_CYCLE'
  | 'HIERARCHY_TOO_DEEP'
  | 'DEPENDENCY_CYCLE';
type DependencyErrorCode =
  | 'DUPLICATE_DEPENDENCY_ID'
  | 'UNKNOWN_DEPENDENCY_TASK'
  | 'SELF_DEPENDENCY'
  | 'SUMMARY_DEPENDENCY'
  | 'DUPLICATE_DEPENDENCY'
  | 'INVALID_LAG';

export type StructureErrorCode =
  LimitErrorCode | TaskErrorCode | DependencyErrorCode | 'DUPLICATE_TAG_ID';

export interface TaskStructureError {
  readonly code: TaskErrorCode;
  readonly list: 'tasks';
  readonly index: number;
  readonly taskId: TaskId;
}

export interface DependencyStructureError {
  readonly code: DependencyErrorCode;
  readonly list: 'dependencies';
  readonly index: number;
  readonly dependencyId: DependencyId;
}

export interface TagStructureError {
  readonly code: 'DUPLICATE_TAG_ID';
  readonly list: 'tags';
  readonly index: number;
  readonly tagId: TagId;
}

export interface LimitStructureError {
  readonly code: LimitErrorCode;
}

export type ItemStructureError = TaskStructureError | DependencyStructureError | TagStructureError;
export type StructureError = ItemStructureError | LimitStructureError;

export interface ProjectStructure {
  readonly tasks: readonly Task[];
  readonly childrenByParent: ReadonlyMap<TaskId | null, readonly Task[]>;
  readonly graph: DependencyGraph;
}

/** Checks the size limits, identifiers, the task tree and the dependency network, then orders tasks for scheduling. */
export function analyzeProjectStructure(
  project: Pick<Project, 'tasks' | 'dependencies' | 'tags'>,
): Result<ProjectStructure, readonly StructureError[]> {
  const limitError = findLimitError(project);
  return limitError === null ? analyzeStructureWithinLimits(project) : failure([limitError]);
}

/** Checks identifiers, the task tree and the dependency network of a project already within the size limits, then orders tasks for scheduling. */
export function analyzeStructureWithinLimits(
  project: Pick<Project, 'tasks' | 'dependencies' | 'tags'>,
): Result<ProjectStructure, readonly ItemStructureError[]> {
  const { tasks } = project;
  const tasksById = new Map<TaskId, Task>();
  const indexById = new Map<TaskId, number>();
  tasks.forEach((task, index) => {
    tasksById.set(task.id, task);
    indexById.set(task.id, index);
  });
  const checked = checkDependencies(project.dependencies, tasks, indexById);
  const errors = [
    ...findDuplicateTaskIds(tasks),
    ...findHierarchyErrors(tasks, tasksById),
    ...checked.errors,
    ...findDuplicateTagIds(project.tags),
  ];
  if (errors.length > 0) {
    return failure(errors);
  }
  const nodes = tasks.flatMap((task, index) => (task.kind === 'summary' ? [] : [{ index, task }]));
  const graph = buildDependencyGraph(nodes, tasks.length, checked.resolved);
  if (!graph.ok) {
    const blocked = [...graph.error].sort((left, right) =>
      compareStrings(left.task.id, right.task.id),
    );
    return failure(
      blocked.map((node): TaskStructureError => ({
        code: 'DEPENDENCY_CYCLE',
        list: 'tasks',
        index: node.index,
        taskId: node.task.id,
      })),
    );
  }
  return success({ tasks, childrenByParent: groupByParent(tasks), graph: graph.value });
}

/** Returns the first size limit exceeded by a project, or null when all are respected. */
function findLimitError(
  project: Pick<Project, 'tasks' | 'dependencies' | 'tags'>,
): LimitStructureError | null {
  if (project.tasks.length > MAX_TASKS) {
    return { code: 'TOO_MANY_TASKS' };
  }
  if (project.dependencies.length > MAX_DEPENDENCIES) {
    return { code: 'TOO_MANY_DEPENDENCIES' };
  }
  return project.tags.length > MAX_TAGS ? { code: 'TOO_MANY_TAGS' } : null;
}

/** Lists the problems that adding a dependency would cause, or nothing when it can be added. */
export function findNewDependencyErrors(
  project: Pick<Project, 'tasks' | 'dependencies' | 'tags'>,
  dependency: Dependency,
): readonly StructureError[] {
  const result = analyzeProjectStructure({
    tasks: project.tasks,
    tags: project.tags,
    dependencies: [...project.dependencies, dependency],
  });
  return result.ok ? [] : result.error;
}

/** Reports every task whose identifier is already used by an earlier task. */
function findDuplicateTaskIds(tasks: readonly Task[]): TaskStructureError[] {
  const seen = new Set<TaskId>();
  const errors: TaskStructureError[] = [];
  tasks.forEach((task, index) => {
    if (seen.has(task.id)) {
      errors.push({ code: 'DUPLICATE_TASK_ID', list: 'tasks', index, taskId: task.id });
    }
    seen.add(task.id);
  });
  return errors;
}

/** Reports every tag whose identifier is already used by an earlier tag. */
function findDuplicateTagIds(tags: readonly Tag[]): TagStructureError[] {
  const seen = new Set<TagId>();
  const errors: TagStructureError[] = [];
  tags.forEach((tag, index) => {
    if (seen.has(tag.id)) {
      errors.push({ code: 'DUPLICATE_TAG_ID', list: 'tags', index, tagId: tag.id });
    }
    seen.add(tag.id);
  });
  return errors;
}

/** Reports unknown or invalid parents, loops in the task tree and trees that are too deep. */
function findHierarchyErrors(
  tasks: readonly Task[],
  tasksById: ReadonlyMap<TaskId, Task>,
): TaskStructureError[] {
  const errors: TaskStructureError[] = [];
  tasks.forEach((task, index) => {
    const code = findParentChainError(task, tasksById);
    if (code !== null) {
      errors.push({ code, list: 'tasks', index, taskId: task.id });
    }
  });
  return errors;
}

/** Walks up the parents of a task and returns the first problem found on the way. */
function findParentChainError(
  task: Task,
  tasksById: ReadonlyMap<TaskId, Task>,
): TaskErrorCode | null {
  if (task.parentId === null) {
    return null;
  }
  const visited: TaskId[] = [task.id];
  let parentId: TaskId | null = task.parentId;
  while (parentId !== null) {
    const parent = tasksById.get(parentId);
    if (parent === undefined) {
      return 'UNKNOWN_PARENT';
    }
    if (parent.kind !== 'summary') {
      return 'PARENT_NOT_SUMMARY';
    }
    if (visited.includes(parent.id)) {
      return 'HIERARCHY_CYCLE';
    }
    if (visited.length >= MAX_HIERARCHY_DEPTH) {
      return 'HIERARCHY_TOO_DEEP';
    }
    visited.push(parent.id);
    parentId = parent.parentId;
  }
  return null;
}

/** Resolves dependencies to task indices and reports duplicated, dangling, reflexive, summary-linked, repeated and badly lagged ones. */
function checkDependencies(
  dependencies: readonly Dependency[],
  tasks: readonly Task[],
  indexById: ReadonlyMap<TaskId, number>,
): { readonly errors: DependencyStructureError[]; readonly resolved: ResolvedDependency[] } {
  const seenIds = new Set<DependencyId>();
  const seenPairs = new Set<number>();
  const errors: DependencyStructureError[] = [];
  const resolved: ResolvedDependency[] = [];
  dependencies.forEach((dependency, index) => {
    const predecessorIndex = indexById.get(dependency.predecessorId) ?? -1;
    const successorIndex = indexById.get(dependency.successorId) ?? -1;
    const pairKey = predecessorIndex * tasks.length + successorIndex;
    const code = seenIds.has(dependency.id)
      ? 'DUPLICATE_DEPENDENCY_ID'
      : (findDependencyError(dependency, tasks[predecessorIndex], tasks[successorIndex]) ??
        (seenPairs.has(pairKey) ? 'DUPLICATE_DEPENDENCY' : null));
    if (code === null) {
      resolved.push({ dependency, predecessorIndex, successorIndex });
      seenPairs.add(pairKey);
    } else {
      errors.push({ code, list: 'dependencies', index, dependencyId: dependency.id });
    }
    seenIds.add(dependency.id);
  });
  return { errors, resolved };
}

/** Returns the problem of a single dependency considered on its own, if any. */
function findDependencyError(
  dependency: Dependency,
  predecessor: Task | undefined,
  successor: Task | undefined,
): DependencyErrorCode | null {
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
  return isQuarterHours(lagHours) && Math.abs(lagHours) <= MAX_LAG_HOURS ? null : 'INVALID_LAG';
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
