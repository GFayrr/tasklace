import { compareStrings } from '../compare-strings';
import { MAX_HIERARCHY_DEPTH } from '../limits';
import type { Dependency, DependencyId, Project, Tag, TagId, Task, TaskId } from '../model/project';
import type { StructureErrorCode } from '../scheduling/project-structure';
import type { ProjectHeader } from './shared-document';

export interface ProjectState {
  header: ProjectHeader;
  readonly tasks: Map<TaskId, Task>;
  readonly dependencies: Map<DependencyId, Dependency>;
  readonly tags: Map<TagId, Tag>;
  readonly children: Map<TaskId, Set<TaskId>>;
  readonly links: Map<TaskId, Set<DependencyId>>;
  readonly pairs: Map<string, DependencyId>;
  readonly tasksByTag: Map<TagId, Set<TaskId>>;
}

/** Builds an indexed state from a valid project. */
export function createProjectState(project: Project): ProjectState {
  const { tasks, dependencies, tags, ...header } = project;
  const state: ProjectState = {
    header,
    tasks: new Map(),
    dependencies: new Map(),
    tags: new Map(),
    children: new Map(),
    links: new Map(),
    pairs: new Map(),
    tasksByTag: new Map(),
  };
  tasks.forEach((task) => {
    putTask(state, task);
  });
  dependencies.forEach((dependency) => {
    putDependency(state, dependency);
  });
  tags.forEach((tag) => {
    putTag(state, tag);
  });
  return state;
}

/** Turns an indexed state back into a project, lists sorted by identifier as a shared document gives them. */
export function toProject(state: ProjectState): Project {
  const byId = <T extends { readonly id: string }>(items: Iterable<T>): T[] =>
    [...items].sort((left, right) => compareStrings(left.id, right.id));
  return {
    ...state.header,
    tasks: byId(state.tasks.values()),
    dependencies: byId(state.dependencies.values()),
    tags: byId(state.tags.values()),
  };
}

/** Adds or replaces a task and updates the indexes. */
export function putTask(state: ProjectState, task: Task): void {
  removeTask(state, task.id);
  state.tasks.set(task.id, task);
  if (task.parentId !== null) {
    addToIndex(state.children, task.parentId, task.id);
  }
  if (task.kind !== 'summary' && task.tagId !== null) {
    addToIndex(state.tasksByTag, task.tagId, task.id);
  }
}

/** Removes a task and its index entries, keeping its dependencies and children. */
export function removeTask(state: ProjectState, id: TaskId): void {
  const task = state.tasks.get(id);
  if (task === undefined) {
    return;
  }
  state.tasks.delete(id);
  if (task.parentId !== null) {
    removeFromIndex(state.children, task.parentId, id);
  }
  if (task.kind !== 'summary' && task.tagId !== null) {
    removeFromIndex(state.tasksByTag, task.tagId, id);
  }
}

/** Adds or replaces a dependency and updates the indexes. */
export function putDependency(state: ProjectState, dependency: Dependency): void {
  removeDependency(state, dependency.id);
  state.dependencies.set(dependency.id, dependency);
  addToIndex(state.links, dependency.predecessorId, dependency.id);
  addToIndex(state.links, dependency.successorId, dependency.id);
  state.pairs.set(pairKey(dependency), dependency.id);
}

/** Removes a dependency and its index entries. */
export function removeDependency(state: ProjectState, id: DependencyId): void {
  const dependency = state.dependencies.get(id);
  if (dependency === undefined) {
    return;
  }
  state.dependencies.delete(id);
  removeFromIndex(state.links, dependency.predecessorId, id);
  removeFromIndex(state.links, dependency.successorId, id);
  if (state.pairs.get(pairKey(dependency)) === id) {
    state.pairs.delete(pairKey(dependency));
  }
}

/** Adds or replaces a tag. */
export function putTag(state: ProjectState, tag: Tag): void {
  state.tags.set(tag.id, tag);
}

/** Removes a tag, leaving the tasks that use it unchanged. */
export function removeTag(state: ProjectState, id: TagId): void {
  state.tags.delete(id);
}

/** Returns the key identifying the two tasks of a dependency, in order. */
export function pairKey(dependency: Pick<Dependency, 'predecessorId' | 'successorId'>): string {
  return JSON.stringify([dependency.predecessorId, dependency.successorId]);
}

/** Returns the dependencies touching a task, as either predecessor or successor. */
export function dependenciesOf(state: ProjectState, taskId: TaskId): Dependency[] {
  return [...(state.links.get(taskId) ?? [])].flatMap((id) => {
    const dependency = state.dependencies.get(id);
    return dependency === undefined ? [] : [dependency];
  });
}

/** Returns the first problem found by walking up the parents of a task, exactly as the full structure check would, or null. */
export function findAncestorProblem(state: ProjectState, task: Task): StructureErrorCode | null {
  const visited: TaskId[] = [task.id];
  let parentId = task.parentId;
  while (parentId !== null) {
    const parent = state.tasks.get(parentId);
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

/** Counts the ancestors of a task whose chain of parents is known to be valid. */
export function countAncestors(state: ProjectState, task: Task): number {
  let count = 0;
  for (
    let parentId = task.parentId;
    parentId !== null;
    parentId = state.tasks.get(parentId)?.parentId ?? null
  ) {
    count += 1;
  }
  return count;
}

/** Returns how many levels of descendants a task has, zero for a task without children. */
export function subtreeHeight(state: ProjectState, taskId: TaskId): number {
  let height = 0;
  const pending: (readonly [TaskId, number])[] = [[taskId, 0]];
  for (let entry = pending.pop(); entry !== undefined; entry = pending.pop()) {
    const [id, depth] = entry;
    height = Math.max(height, depth);
    for (const child of state.children.get(id) ?? []) {
      pending.push([child, depth + 1]);
    }
  }
  return height;
}

/** Tells whether a task can be reached from another by following dependencies forward. */
export function isReachable(state: ProjectState, from: TaskId, target: TaskId): boolean {
  const visited = new Set<TaskId>([from]);
  const pending: TaskId[] = [from];
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    if (id === target) {
      return true;
    }
    for (const successor of successorsOf(state, id).filter((next) => !visited.has(next))) {
      visited.add(successor);
      pending.push(successor);
    }
  }
  return false;
}

/** Lists the tasks that directly follow a task through a dependency. */
function successorsOf(state: ProjectState, taskId: TaskId): TaskId[] {
  return dependenciesOf(state, taskId)
    .filter((dependency) => dependency.predecessorId === taskId)
    .map((dependency) => dependency.successorId);
}

/** Adds a value to the set stored under a key of an index. */
function addToIndex<K, V>(index: Map<K, Set<V>>, key: K, value: V): void {
  const values = index.get(key) ?? new Set<V>();
  values.add(value);
  index.set(key, values);
}

/** Removes a value from the set stored under a key of an index, dropping empty sets. */
function removeFromIndex<K, V>(index: Map<K, Set<V>>, key: K, value: V): void {
  const values = index.get(key);
  values?.delete(value);
  if (values?.size === 0) {
    index.delete(key);
  }
}
