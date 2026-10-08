import { compareStrings } from '../compare-strings';
import { MAX_HIERARCHY_DEPTH } from '../limits';
import type { Dependency, DependencyId, Project, Tag, TagId, Task, TaskId } from '../model/project';
import {
  blockKey,
  blockPairKey,
  predecessorBlockOf,
  successorBlockOf,
  unitCountOf,
} from '../scheduling/block-links';
import type { StructureErrorCode } from '../scheduling/project-structure';
import type { ProjectHeader } from './shared-document';

interface ReachedBlock {
  readonly taskId: TaskId;
  readonly block: number;
  readonly origin: number;
}

const NOT_THE_TASK = -1;

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
  /** Returns items ordered by identifier. */
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
  state.pairs.set(blockPairKey(dependency), dependency.id);
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
  if (state.pairs.get(blockPairKey(dependency)) === id) {
    state.pairs.delete(blockPairKey(dependency));
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

/** Tells whether a dependency closes a loop, by searching a path from the block it leads to back to the block it leaves, a task missing from the state counting as a loop so that nothing doubtful is accepted. */
export function closesCycle(state: ProjectState, dependency: Dependency): boolean {
  const predecessor = state.tasks.get(dependency.predecessorId);
  const successor = state.tasks.get(dependency.successorId);
  if (predecessor === undefined || successor === undefined) {
    return true;
  }
  const target = blockKey(predecessor.id, predecessorBlockOf(dependency, unitCountOf(predecessor)));
  const start = blockKey(successor.id, successorBlockOf(dependency, unitCountOf(successor)));
  const visited = new Set<string>([start]);
  const pending = [
    { taskId: successor.id, block: successorBlockOf(dependency, unitCountOf(successor)) },
  ];
  for (let unit = pending.pop(); unit !== undefined; unit = pending.pop()) {
    if (blockKey(unit.taskId, unit.block) === target) {
      return true;
    }
    const unseen = nextBlocks(state, unit.taskId, unit.block).filter(
      (next) => !visited.has(blockKey(next.taskId, next.block)),
    );
    unseen.forEach((next) => visited.add(blockKey(next.taskId, next.block)));
    pending.push(...unseen);
  }
  return false;
}

/** Tells whether some loop goes through the blocks of a task, in a single search that remembers, for every block reached, the highest block of the task it comes from. */
export function loopsThroughTask(state: ProjectState, task: Task): boolean {
  const highestOrigin = new Map<string, number>();
  const pending: ReachedBlock[] = [];
  for (let block = 0; block < unitCountOf(task); block += 1) {
    highestOrigin.set(blockKey(task.id, block), block);
    pending.push({ taskId: task.id, block, origin: block });
  }
  for (let reached = pending.pop(); reached !== undefined; reached = pending.pop()) {
    const next = reachedFrom(state, task, reached, highestOrigin);
    if (next === null) {
      return true;
    }
    pending.push(...next);
  }
  return false;
}

/** Lists the blocks a reached block leads to whose highest origin grows, or returns null when one of them is a block of the task not after that origin. */
function reachedFrom(
  state: ProjectState,
  task: Task,
  reached: ReachedBlock,
  highestOrigin: Map<string, number>,
): ReachedBlock[] | null {
  const grown: ReachedBlock[] = [];
  for (const next of nextBlocks(state, reached.taskId, reached.block)) {
    const own = next.taskId === task.id ? next.block : NOT_THE_TASK;
    if (own !== NOT_THE_TASK && reached.origin >= own) {
      return null;
    }
    const origin = Math.max(reached.origin, own);
    const key = blockKey(next.taskId, next.block);
    if ((highestOrigin.get(key) ?? NOT_THE_TASK) < origin) {
      highestOrigin.set(key, origin);
      grown.push({ ...next, origin });
    }
  }
  return grown;
}

/** Lists the blocks that directly follow a block: the next block of its task and the blocks its dependencies lead to. */
function nextBlocks(
  state: ProjectState,
  taskId: TaskId,
  block: number,
): { readonly taskId: TaskId; readonly block: number }[] {
  const task = state.tasks.get(taskId);
  const count = task === undefined ? 0 : unitCountOf(task);
  const next = block + 1 < count ? [{ taskId, block: block + 1 }] : [];
  for (const dependency of dependenciesOf(state, taskId)) {
    const successor = state.tasks.get(dependency.successorId);
    const leaves = predecessorBlockOf(dependency, count);
    if (dependency.predecessorId === taskId && leaves === block && successor !== undefined) {
      next.push({
        taskId: successor.id,
        block: successorBlockOf(dependency, unitCountOf(successor)),
      });
    }
  }
  return next;
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
