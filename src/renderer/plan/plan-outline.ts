import { compareStrings } from '../../core/compare-strings';
import { valueAt } from '../../core/table-value';
import { compareWbsNumbers, formatPredecessors } from '../../core/exchange/csv/task-notations';
import type { Dependency, Task, TaskId } from '../../core/model/project';
import { listChanges, type Replacement } from '../../core/shared/project-changes';

export const NOTHING_COLLAPSED: ReadonlySet<TaskId> = new Set();

export interface PlanRow {
  readonly task: Task;
  readonly depth: number;
  readonly wbs: string;
  readonly hasChildren: boolean;
  readonly collapsed: boolean;
}

export interface PlanOutline {
  readonly rows: readonly PlanRow[];
  readonly wbsById: ReadonlyMap<TaskId, string>;
  readonly rowIndexById: ReadonlyMap<TaskId, number>;
  readonly childrenById: ReadonlyMap<TaskId | null, readonly Task[]>;
}

export interface OutlineBasis {
  readonly tasks: readonly Task[];
  readonly collapsed: ReadonlySet<TaskId>;
  readonly outline: PlanOutline;
}

export interface IncomingBasis {
  readonly dependencies: readonly Dependency[];
  readonly incoming: ReadonlyMap<TaskId, readonly Dependency[]>;
}

const idsByNumber = new WeakMap<PlanOutline, ReadonlyMap<string, TaskId>>();

interface Level {
  readonly children: readonly Task[];
  readonly depth: number;
  readonly prefix: string;
  readonly hidden: boolean;
  next: number;
}

/** Finds the task a WBS number names, hidden tasks included, building the table from numbers to tasks of an outline only at its first lookup, since only typed predecessors need it. */
export function taskIdOfNumber(outline: PlanOutline, wbs: string): TaskId | undefined {
  let table = idsByNumber.get(outline);
  if (table === undefined) {
    table = new Map([...outline.wbsById].map(([id, number]) => [number, id]));
    idsByNumber.set(outline, table);
  }
  return table.get(wbs);
}

/** Lists the tasks in the order of the task tree, numbered as in the WBS, the descendants of collapsed summaries being numbered but not shown. */
export function buildPlanOutline(
  tasks: readonly Task[],
  collapsed: ReadonlySet<TaskId>,
): PlanOutline {
  const childrenById = groupChildren(tasks);
  const rows: PlanRow[] = [];
  const wbsById = new Map<TaskId, string>();
  const rowIndexById = new Map<TaskId, number>();
  const levels: Level[] = [
    { children: childrenById.get(null) ?? [], depth: 0, prefix: '', hidden: false, next: 0 },
  ];
  for (let level = levels.at(-1); level !== undefined; level = levels.at(-1)) {
    const task = level.children[level.next];
    if (task === undefined) {
      levels.pop();
      continue;
    }
    level.next += 1;
    const wbs = `${level.prefix}${String(level.next)}`;
    const children = childrenById.get(task.id) ?? [];
    const isCollapsed = children.length > 0 && collapsed.has(task.id);
    wbsById.set(task.id, wbs);
    if (!level.hidden) {
      rowIndexById.set(task.id, rows.length);
      rows.push({
        task,
        depth: level.depth,
        wbs,
        hasChildren: children.length > 0,
        collapsed: isCollapsed,
      });
    }
    if (children.length > 0) {
      const hidden = level.hidden || isCollapsed;
      levels.push({ children, depth: level.depth + 1, prefix: `${wbs}.`, hidden, next: 0 });
    }
  }
  return { rows, wbsById, rowIndexById, childrenById };
}

/** Gives the outline of the tasks from the outline of an earlier list, reusing it as it is when nothing changed, swapping in the replaced tasks when the tree and the collapsed summaries stay the same, and building it again otherwise. */
export function nextPlanOutline(
  basis: OutlineBasis | null,
  tasks: readonly Task[],
  collapsed: ReadonlySet<TaskId>,
): OutlineBasis {
  if (basis?.tasks === tasks && basis.collapsed === collapsed) {
    return basis;
  }
  const changes = basis === null ? null : listChanges(basis.tasks, tasks);
  const keepsTree =
    basis !== null &&
    changes !== null &&
    basis.collapsed === collapsed &&
    changes.added.length === 0 &&
    changes.removed.length === 0 &&
    changes.replaced.every(keepsPlace);
  const outline = keepsTree
    ? withReplacedTasks(basis.outline, changes.replaced)
    : buildPlanOutline(tasks, collapsed);
  return { tasks, collapsed, outline };
}

/** Tells whether a replaced task keeps its parent and its place among its siblings. */
function keepsPlace({ previous, next }: Replacement<Task>): boolean {
  return previous.parentId === next.parentId && previous.sortKey === next.sortKey;
}

/** Puts replaced tasks in the rows and sibling groups of an outline whose tree they keep, its numbers and row indices staying the same. */
function withReplacedTasks(
  outline: PlanOutline,
  replaced: readonly Replacement<Task>[],
): PlanOutline {
  const rows = outline.rows.slice();
  const copies = new Map<TaskId | null, Task[]>();
  for (const { next } of replaced) {
    const index = outline.rowIndexById.get(next.id);
    if (index !== undefined) {
      rows[index] = { ...valueAt(rows, index), task: next };
    }
    const siblings =
      copies.get(next.parentId) ?? (outline.childrenById.get(next.parentId) ?? []).slice();
    copies.set(next.parentId, siblings);
    siblings[siblingIndex(siblings, next)] = next;
  }
  const childrenById = new Map([...outline.childrenById, ...copies]);
  const updated = { ...outline, rows, childrenById };
  const numbers = idsByNumber.get(outline);
  if (numbers !== undefined) {
    idsByNumber.set(updated, numbers);
  }
  return updated;
}

/** Finds by halving where a task with the same identifier, parent and sort key sits among siblings sorted by sort key then identifier. */
function siblingIndex(siblings: readonly Task[], task: Task): number {
  let low = 0;
  let high = siblings.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const order = compareSiblings(valueAt(siblings, middle), task);
    if (order === 0) {
      return middle;
    }
    low = order < 0 ? middle + 1 : low;
    high = order < 0 ? high : middle - 1;
  }
  throw new Error(`The task ${task.id} is not among the children of its parent.`);
}

/** Gives the dependencies grouped by the task they lead to from the grouping of an earlier list, reusing it when the list is the same and grouping again only the tasks a changed dependency leads to. */
export function nextIncoming(
  basis: IncomingBasis | null,
  dependencies: readonly Dependency[],
): IncomingBasis {
  if (basis?.dependencies === dependencies) {
    return basis;
  }
  if (basis === null) {
    return { dependencies, incoming: groupIncoming(dependencies) };
  }
  const { added, replaced, removed } = listChanges(basis.dependencies, dependencies);
  const gone = new Set([...removed, ...replaced.map(({ previous }) => previous)]);
  const arriving = [...added, ...replaced.map(({ next }) => next)];
  const successors = new Set([...gone, ...arriving].map((dependency) => dependency.successorId));
  const incoming = new Map(basis.incoming);
  for (const successor of successors) {
    const kept = (incoming.get(successor) ?? []).filter((dependency) => !gone.has(dependency));
    const list = kept.concat(arriving.filter((dependency) => dependency.successorId === successor));
    list.sort((left, right) => compareStrings(left.id, right.id));
    if (list.length === 0) {
      incoming.delete(successor);
    } else {
      incoming.set(successor, list);
    }
  }
  return { dependencies, incoming };
}

/** Groups the dependencies by the task they lead to, so that the predecessors of a row are found at once. */
export function groupIncoming(
  dependencies: readonly Dependency[],
): ReadonlyMap<TaskId, readonly Dependency[]> {
  const grouped = new Map<TaskId, Dependency[]>();
  for (const dependency of dependencies) {
    const list = grouped.get(dependency.successorId);
    if (list === undefined) {
      grouped.set(dependency.successorId, [dependency]);
    } else {
      list.push(dependency);
    }
  }
  return grouped;
}

/** Writes the predecessors of a task, or of one of its blocks, in the notation of the task table, by WBS number in WBS order. */
export function predecessorText(
  incoming: readonly Dependency[] | undefined,
  wbsById: ReadonlyMap<TaskId, string>,
  block: number | null = null,
): string {
  if (incoming === undefined) {
    return '';
  }
  const references = incoming
    .filter((dependency) => dependency.successorBlock === block)
    .map((dependency) => ({
      wbs: wbsById.get(dependency.predecessorId) ?? '',
      block: dependency.predecessorBlock,
      type: dependency.type,
      lagHours: dependency.lagHours,
    }));
  references.sort(
    (left, right) =>
      compareWbsNumbers(left.wbs, right.wbs) || (left.block ?? -1) - (right.block ?? -1),
  );
  return formatPredecessors(references);
}

/** Groups tasks under their parent, each group sorted by sort key then identifier. */
function groupChildren(tasks: readonly Task[]): Map<TaskId | null, Task[]> {
  const groups = new Map<TaskId | null, Task[]>();
  for (const task of tasks) {
    const siblings = groups.get(task.parentId) ?? [];
    siblings.push(task);
    groups.set(task.parentId, siblings);
  }
  groups.forEach((siblings) => {
    siblings.sort(compareSiblings);
  });
  return groups;
}

/** Orders two siblings by sort key, then by identifier. */
function compareSiblings(left: Task, right: Task): number {
  return compareStrings(left.sortKey, right.sortKey) || compareStrings(left.id, right.id);
}

/** Returns the set of collapsed summaries with one summary opened or closed. */
export function toggledSummary(collapsed: ReadonlySet<TaskId>, id: TaskId): ReadonlySet<TaskId> {
  const next = new Set(collapsed);
  if (!next.delete(id)) {
    next.add(id);
  }
  return next;
}

/** Returns the set of collapsed summaries without the summaries that hide a task, the same set when none hides it. */
export function withAncestorsOpen(
  collapsed: ReadonlySet<TaskId>,
  tasks: readonly Task[],
  id: TaskId,
): ReadonlySet<TaskId> {
  const parents = new Map(tasks.map((task) => [task.id, task.parentId]));
  const next = new Set(collapsed);
  for (let parent = parents.get(id); parent !== undefined && parent !== null;) {
    next.delete(parent);
    parent = parents.get(parent);
  }
  return next.size === collapsed.size ? collapsed : next;
}
