import { compileCalendar } from '../calendar/compile-calendar';
import { computeDailyWindow } from '../calendar/task-slots';
import { MAX_DEPENDENCIES, MAX_HIERARCHY_DEPTH, MAX_TAGS, MAX_TASKS } from '../limits';
import type { Dependency, DependencyId, Project, Tag, TagId, Task, TaskId } from '../model/project';
import { failure, success, type Result } from '../result';
import {
  NOMINAL_LIST_LIMITS,
  readProject,
  readProjectShape,
  STORED_VALUE_CODEC,
} from '../validation/read-project';
import type { ValidationIssue, ValidationIssueCode } from '../validation/validation-issues';
import {
  countAncestors,
  dependenciesOf,
  findAncestorProblem,
  isReachable,
  pairKey,
  putDependency,
  putTag,
  putTask,
  removeDependency,
  removeTag,
  removeTask,
  subtreeHeight,
  type ProjectState,
} from './project-state';
import type { ProjectHeader } from './shared-document';

export type SharedOperation =
  | { readonly type: 'putTask'; readonly task: Task }
  | { readonly type: 'removeTasks'; readonly ids: readonly TaskId[] }
  | { readonly type: 'putDependency'; readonly dependency: Dependency }
  | { readonly type: 'removeDependency'; readonly id: DependencyId }
  | { readonly type: 'putTag'; readonly tag: Tag }
  | { readonly type: 'removeTag'; readonly id: TagId }
  | { readonly type: 'updateProject'; readonly fields: Partial<ProjectHeader> };

export interface TouchedItems {
  readonly tasks: Set<TaskId>;
  readonly dependencies: Set<DependencyId>;
  readonly tags: Set<TagId>;
  header: boolean;
}

type Check = Result<TouchedItems, readonly ValidationIssue[]>;

/** Applies an operation to a whole project, the reference that the incremental checks must agree with. */
export function applyOperation(project: Project, operation: SharedOperation): Project {
  switch (operation.type) {
    case 'putTask':
      return {
        ...project,
        tasks: replaceOrAppend(
          project.tasks,
          withKnownTag(operation.task, (id) => project.tags.some((tag) => tag.id === id)),
        ),
      };
    case 'removeTasks': {
      const removed = new Set(operation.ids);
      return {
        ...project,
        tasks: project.tasks.filter((task) => !removed.has(task.id)),
        dependencies: project.dependencies.filter(
          (item) => !removed.has(item.predecessorId) && !removed.has(item.successorId),
        ),
      };
    }
    case 'putDependency':
      return {
        ...project,
        dependencies: replaceOrAppend(project.dependencies, operation.dependency),
      };
    case 'removeDependency':
      return {
        ...project,
        dependencies: project.dependencies.filter((item) => item.id !== operation.id),
      };
    case 'putTag':
      return { ...project, tags: replaceOrAppend(project.tags, operation.tag) };
    case 'removeTag':
      return {
        ...project,
        tags: project.tags.filter((tag) => tag.id !== operation.id),
        tasks: project.tasks.map((task) =>
          task.kind !== 'summary' && task.tagId === operation.id ? { ...task, tagId: null } : task,
        ),
      };
    case 'updateProject':
      return { ...project, ...operation.fields };
  }
}

/** Checks an operation against the indexed state, looking only at what it touches, and applies it to the state when valid. */
export function applyToState(state: ProjectState, operation: SharedOperation): Check {
  switch (operation.type) {
    case 'putTask':
      return putTaskChecked(state, operation.task);
    case 'removeTasks':
      return removeTasksChecked(state, operation.ids);
    case 'putDependency':
      return putDependencyChecked(state, operation.dependency);
    case 'removeDependency':
      removeDependency(state, operation.id);
      return success(touched({ dependencies: [operation.id] }));
    case 'putTag':
      return putTagChecked(state, operation.tag);
    case 'removeTag':
      return success(removeTagApplied(state, operation.id));
    case 'updateProject':
      return updateProjectChecked(state, operation.fields);
  }
}

/** Reads a task, dependency or tag alone within the project fields, validating its own fields only. */
export function readItemShape(
  header: ProjectHeader,
  lists: Partial<
    Pick<Record<keyof Project, readonly unknown[]>, 'tasks' | 'dependencies' | 'tags'>
  >,
): Result<Project, readonly ValidationIssue[]> {
  return readProjectShape(
    { ...header, baseline: null, tasks: [], dependencies: [], tags: [], ...lists },
    STORED_VALUE_CODEC,
    NOMINAL_LIST_LIMITS,
  );
}

/** Adds or replaces a task after checking its fields, its place in the tree, its dependencies and its daily pattern. */
function putTaskChecked(state: ProjectState, input: Task): Check {
  const shape = readItemShape(state.header, { tasks: [input] });
  const [read] = shape.ok ? shape.value.tasks : [];
  const task = read === undefined ? undefined : withKnownTag(read, (id) => state.tags.has(id));
  if (task === undefined) {
    return failure(relocate(shape.ok ? [] : shape.error, 'tasks[0]', `tasks.${input.id}`));
  }
  const previous = state.tasks.get(task.id);
  if (previous === undefined && state.tasks.size >= MAX_TASKS) {
    return refuse('tasks', 'TOO_MANY_ITEMS');
  }
  putTask(state, task);
  const problem = findTaskProblem(state, task);
  if (problem !== null) {
    restoreTask(state, task.id, previous);
    return refuse(`tasks.${task.id}`, problem);
  }
  return success(touched({ tasks: [task.id] }));
}

/** Returns the first structural problem a task already placed in the state causes, or null. */
export function findTaskProblem(state: ProjectState, task: Task): ValidationIssueCode | null {
  const ancestorProblem = findAncestorProblem(state, task);
  if (ancestorProblem !== null) {
    return ancestorProblem;
  }
  if (countAncestors(state, task) + subtreeHeight(state, task.id) >= MAX_HIERARCHY_DEPTH) {
    return 'HIERARCHY_TOO_DEEP';
  }
  if (task.kind !== 'summary' && (state.children.get(task.id)?.size ?? 0) > 0) {
    return 'PARENT_NOT_SUMMARY';
  }
  if (task.kind === 'summary' && dependenciesOf(state, task.id).length > 0) {
    return 'SUMMARY_DEPENDENCY';
  }
  return task.kind === 'task' ? findDailyPatternProblem(state, task) : null;
}

/** Returns the problem of a work task whose daily pattern does not fit the project calendar, or null. */
function findDailyPatternProblem(
  state: ProjectState,
  task: Extract<Task, { kind: 'task' }>,
): ValidationIssueCode | null {
  const calendar = compileCalendar(state.header.calendar);
  if (!calendar.ok) {
    return null;
  }
  const window = computeDailyWindow(calendar.value, task);
  return window.ok ? null : window.error;
}

/** Puts back the previous version of a task, or removes it when it is new. */
function restoreTask(state: ProjectState, id: TaskId, previous: Task | undefined): void {
  if (previous === undefined) {
    removeTask(state, id);
  } else {
    putTask(state, previous);
  }
}

/** Removes tasks with their dependencies, refusing when a remaining task still has one of them as parent. */
function removeTasksChecked(state: ProjectState, ids: readonly TaskId[]): Check {
  const removed = new Set(ids.filter((id) => state.tasks.has(id)));
  const orphan = [...removed]
    .flatMap((id) => [...(state.children.get(id) ?? [])])
    .find((child) => !removed.has(child));
  if (orphan !== undefined) {
    return refuse(`tasks.${orphan}`, 'UNKNOWN_PARENT');
  }
  const dependencyIds = [...removed].flatMap((id) => [...(state.links.get(id) ?? [])]);
  dependencyIds.forEach((id) => {
    removeDependency(state, id);
  });
  removed.forEach((id) => {
    removeTask(state, id);
  });
  return success(touched({ tasks: [...removed], dependencies: dependencyIds }));
}

/** Adds or replaces a dependency after checking its fields, its tasks, its pair and that it closes no cycle. */
function putDependencyChecked(state: ProjectState, input: Dependency): Check {
  const shape = readItemShape(state.header, { dependencies: [input] });
  const [dependency] = shape.ok ? shape.value.dependencies : [];
  if (dependency === undefined) {
    return failure(
      relocate(shape.ok ? [] : shape.error, 'dependencies[0]', `dependencies.${input.id}`),
    );
  }
  const previous = state.dependencies.get(dependency.id);
  if (previous === undefined && state.dependencies.size >= MAX_DEPENDENCIES) {
    return refuse('dependencies', 'TOO_MANY_ITEMS');
  }
  removeDependency(state, dependency.id);
  const problem = findDependencyProblem(state, dependency);
  if (problem !== null) {
    if (previous !== undefined) {
      putDependency(state, previous);
    }
    return refuse(`dependencies.${dependency.id}`, problem);
  }
  putDependency(state, dependency);
  return success(touched({ dependencies: [dependency.id] }));
}

/** Returns the problem a new dependency would cause among the other dependencies, or null. */
export function findDependencyProblem(
  state: ProjectState,
  dependency: Dependency,
): ValidationIssueCode | null {
  const predecessor = state.tasks.get(dependency.predecessorId);
  const successor = state.tasks.get(dependency.successorId);
  if (predecessor === undefined || successor === undefined) {
    return 'UNKNOWN_DEPENDENCY_TASK';
  }
  if (predecessor.id === successor.id) {
    return 'SELF_DEPENDENCY';
  }
  if (predecessor.kind === 'summary' || successor.kind === 'summary') {
    return 'SUMMARY_DEPENDENCY';
  }
  if (state.pairs.has(pairKey(dependency))) {
    return 'DUPLICATE_DEPENDENCY';
  }
  return isReachable(state, successor.id, predecessor.id) ? 'DEPENDENCY_CYCLE' : null;
}

/** Adds or replaces a tag after checking its fields. */
function putTagChecked(state: ProjectState, input: Tag): Check {
  const shape = readItemShape(state.header, { tags: [input] });
  const [tag] = shape.ok ? shape.value.tags : [];
  if (tag === undefined) {
    return failure(relocate(shape.ok ? [] : shape.error, 'tags[0]', `tags.${input.id}`));
  }
  if (!state.tags.has(tag.id) && state.tags.size >= MAX_TAGS) {
    return refuse('tags', 'TOO_MANY_ITEMS');
  }
  putTag(state, tag);
  return success(touched({ tags: [tag.id] }));
}

/** Removes a tag and clears it from the tasks that used it. */
function removeTagApplied(state: ProjectState, id: TagId): TouchedItems {
  const taskIds = [...(state.tasksByTag.get(id) ?? [])];
  taskIds.forEach((taskId) => {
    const task = state.tasks.get(taskId);
    if (task !== undefined && task.kind !== 'summary') {
      putTask(state, { ...task, tagId: null });
    }
  });
  removeTag(state, id);
  return touched({ tags: [id], tasks: taskIds });
}

/** Changes project fields after checking them, and every daily pattern when the calendar changes. */
function updateProjectChecked(state: ProjectState, fields: Partial<ProjectHeader>): Check {
  const header = { ...state.header, ...fields };
  const read = readProject(
    {
      ...header,
      baseline: fields.baseline === undefined ? null : header.baseline,
      tasks: [],
      dependencies: [],
      tags: [],
    },
    STORED_VALUE_CODEC,
  );
  if (!read.ok) {
    return failure(read.error);
  }
  const previous = state.header;
  state.header = { ...read.value, baseline: header.baseline };
  const problem = fields.calendar === undefined ? null : findCalendarProblem(state);
  if (problem !== null) {
    state.header = previous;
    return failure([problem]);
  }
  return success({ ...touched({}), header: true });
}

/** Returns the first work task whose daily pattern no longer fits the calendar, as an issue, or null. */
function findCalendarProblem(state: ProjectState): ValidationIssue | null {
  for (const task of state.tasks.values()) {
    const problem = task.kind === 'task' ? findDailyPatternProblem(state, task) : null;
    if (problem !== null) {
      return { path: `tasks.${task.id}`, code: problem };
    }
  }
  return null;
}

/** Removes from a task a tag that does not exist, since a shared document never points at a missing tag. */
export function withKnownTag(task: Task, isKnownTag: (id: TagId) => boolean): Task {
  if (task.kind === 'summary' || task.tagId === null || isKnownTag(task.tagId)) {
    return task;
  }
  return { ...task, tagId: null };
}

/** Replaces the item with the same identifier, or appends the item when there is none. */
function replaceOrAppend<T extends { readonly id: string }>(items: readonly T[], item: T): T[] {
  return items.some((candidate) => candidate.id === item.id)
    ? items.map((candidate) => (candidate.id === item.id ? item : candidate))
    : [...items, item];
}

/** Builds the list of items an operation touched. */
function touched(items: {
  readonly tasks?: readonly TaskId[];
  readonly dependencies?: readonly DependencyId[];
  readonly tags?: readonly TagId[];
}): TouchedItems {
  return {
    tasks: new Set(items.tasks),
    dependencies: new Set(items.dependencies),
    tags: new Set(items.tags),
    header: false,
  };
}

/** Builds a refusal with a single issue. */
function refuse(path: string, code: ValidationIssueCode): Check {
  return failure([{ path, code }]);
}

/** Moves issues found on an item read alone to the location of that item in the project. */
function relocate(
  issues: readonly ValidationIssue[],
  from: string,
  to: string,
): readonly ValidationIssue[] {
  return issues.map((issue) =>
    issue.path.startsWith(from) ? { ...issue, path: to + issue.path.slice(from.length) } : issue,
  );
}
