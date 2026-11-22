import { compareStrings } from '../../core/compare-strings';
import { valueAt } from '../../core/table-value';
import { compareWbsNumbers, formatPredecessors } from '../../core/exchange/csv/task-notations';
import type { Dependency, Task, TaskId } from '../../core/model/project';
import { listChanges, type ListChanges, type Replacement } from '../../core/shared/project-changes';

export const NOTHING_COLLAPSED: ReadonlySet<TaskId> = new Set();

export interface PlanRow {
  readonly task: Task;
  readonly depth: number;
  readonly wbs: string;
  readonly hasChildren: boolean;
  readonly collapsed: boolean;
}

export interface TaskLookup<Value> {
  get(taskId: TaskId): Value | undefined;
  has(taskId: TaskId): boolean;
}

export interface ChildrenLookup {
  get(parentId: TaskId | null): readonly Task[] | undefined;
}

export interface PlanOutline {
  readonly rows: readonly PlanRow[];
  readonly wbsById: TaskLookup<string>;
  readonly rowIndexById: TaskLookup<number>;
  readonly childrenById: ChildrenLookup;
}

interface Slot {
  task: Task;
  wbs: string;
  row: number;
  generation: number;
}

interface OutlineTable {
  readonly slots: Map<TaskId, Slot>;
  readonly groups: Map<TaskId | null, Slot[]>;
  generation: number;
  reflects: readonly Task[];
  folded: ReadonlySet<TaskId>;
}

export interface OutlineTableView {
  readonly slots: ReadonlyMap<TaskId, Readonly<Slot>>;
  readonly groups: ReadonlyMap<TaskId | null, readonly Readonly<Slot>[]>;
  readonly generation: number;
  readonly reflects: readonly Task[];
  readonly folded: ReadonlySet<TaskId>;
}

export interface OutlineBasis {
  readonly tasks: readonly Task[];
  readonly collapsed: ReadonlySet<TaskId>;
  readonly outline: PlanOutline;
  readonly table: OutlineTableView;
}

export interface IncomingLookup {
  get(taskId: TaskId): readonly Dependency[] | undefined;
}

interface IncomingTable {
  readonly groups: Map<TaskId, readonly Dependency[]>;
  reflects: readonly Dependency[];
}

export interface IncomingTableView {
  readonly groups: ReadonlyMap<TaskId, readonly Dependency[]>;
  readonly reflects: readonly Dependency[];
}

export interface IncomingBasis {
  readonly dependencies: readonly Dependency[];
  readonly incoming: IncomingLookup;
  readonly table: IncomingTableView;
}

const outlineTables = new WeakMap<OutlineTableView, OutlineTable>();
const incomingTables = new WeakMap<IncomingTableView, IncomingTable>();
const idsByNumber = new WeakMap<PlanOutline, ReadonlyMap<string, TaskId>>();
const numberedSlots = new WeakMap<PlanOutline, () => readonly Slot[]>();
const HIDDEN_ROW = -1;
const MAX_CHANGES_PLACED_ONE_BY_ONE = 64;

interface Level {
  readonly children: readonly Slot[];
  readonly depth: number;
  readonly prefix: string;
  readonly hidden: boolean;
  next: number;
}

/** Finds the task a WBS number names, hidden tasks included, building the table from numbers to tasks of an outline only at its first lookup, since only typed predecessors need it. */
export function taskIdOfNumber(outline: PlanOutline, wbs: string): TaskId | undefined {
  let table = idsByNumber.get(outline);
  if (table === undefined) {
    const numbered = numberedSlots.get(outline)?.() ?? [];
    table = new Map(numbered.map((slot) => [slot.wbs, slot.task.id]));
    idsByNumber.set(outline, table);
  }
  return table.get(wbs);
}

/** Lists the tasks in the order of the task tree, numbered as in the WBS, the descendants of collapsed summaries being numbered but not shown. */
export function buildPlanOutline(
  tasks: readonly Task[],
  collapsed: ReadonlySet<TaskId>,
): PlanOutline {
  return nextPlanOutline(null, tasks, collapsed).outline;
}

/** Gives the outline of the tasks from the one of an earlier list, one record per task: the same if nothing changed, the replaced tasks swapped in if the tree and folds stay, else numbered again, an older basis being refused. */
export function nextPlanOutline(
  basis: OutlineBasis | null,
  tasks: readonly Task[],
  collapsed: ReadonlySet<TaskId>,
): OutlineBasis {
  if (
    basis !== null &&
    (basis.table.reflects !== basis.tasks || basis.table.folded !== basis.collapsed)
  ) {
    throw new Error('An outline was given after a newer one had changed the records they share.');
  }
  if (basis?.tasks === tasks && basis.collapsed === collapsed) {
    return basis;
  }
  if (basis === null) {
    const table = tableOf(tasks, collapsed);
    return { tasks, collapsed, table, outline: walkedOutline(table) };
  }
  const table = ownTable(outlineTables, basis.table);
  const changes = listChanges(basis.tasks, tasks);
  const keepsTree =
    basis.collapsed === collapsed &&
    changes.added.length === 0 &&
    changes.removed.length === 0 &&
    changes.replaced.every(keepsPlace);
  const placedOneByOne = !keepsTree && changeCount(changes) <= MAX_CHANGES_PLACED_ONE_BY_ONE;
  if (placedOneByOne) {
    takeOutLeavingSlots(table, changes);
  }
  updateSlots(table, changes);
  table.reflects = tasks;
  table.folded = collapsed;
  if (placedOneByOne) {
    placeArrivingSlots(table, changes);
  }
  const outline = keepsTree
    ? withReplacedTasks(basis.outline, table, changes.replaced)
    : walkedOutline(placedOneByOne ? table : regroupSlots(table, changes));
  return { tasks, collapsed, table, outline };
}

/** Makes one record per task and groups the records under their parent, each group sorted by sort key then identifier. */
function tableOf(tasks: readonly Task[], collapsed: ReadonlySet<TaskId>): OutlineTable {
  const slots = new Map<TaskId, Slot>();
  const groups = new Map<TaskId | null, Slot[]>();
  for (const task of tasks) {
    const slot = { task, wbs: '', row: HIDDEN_ROW, generation: 0 };
    slots.set(task.id, slot);
    const siblings = groups.get(task.parentId) ?? [];
    siblings.push(slot);
    groups.set(task.parentId, siblings);
  }
  groups.forEach((siblings) => {
    siblings.sort(compareSlots);
  });
  const table = { slots, groups, generation: 0, reflects: tasks, folded: collapsed };
  outlineTables.set(table, table);
  return table;
}

/** Gives the table this module changes in place behind the view a basis shows, throwing on a table it did not make. */
function ownTable<View extends object, Table>(tables: WeakMap<View, Table>, view: View): Table {
  const table = tables.get(view);
  if (table === undefined) {
    throw new Error('This table was not made by the outline of the plan.');
  }
  return table;
}

/** Forgets the records of removed tasks, makes records for added ones and puts each replaced task in its record. */
function updateSlots(table: OutlineTable, { added, replaced, removed }: ListChanges<Task>): void {
  for (const task of removed) {
    table.slots.delete(task.id);
  }
  for (const task of added) {
    table.slots.set(task.id, { task, wbs: '', row: HIDDEN_ROW, generation: 0 });
  }
  for (const { next } of replaced) {
    slotOf(table, next.id).task = next;
  }
}

/** Returns the record of a task the table must hold. */
function slotOf(table: OutlineTable, id: TaskId): Slot {
  const slot = table.slots.get(id);
  if (slot === undefined) {
    throw new Error(`The outline holds no record of the task ${id}.`);
  }
  return slot;
}

/** Counts the tasks a change of the list adds, replaces or removes. */
function changeCount({ added, replaced, removed }: ListChanges<Task>): number {
  return added.length + replaced.length + removed.length;
}

/** Takes the records of removed and replaced tasks out of their groups, found by halving while every record still holds the task the groups were sorted by. */
function takeOutLeavingSlots(table: OutlineTable, { replaced, removed }: ListChanges<Task>): void {
  for (const task of [...removed, ...replaced.map(({ previous }) => previous)]) {
    const siblings = table.groups.get(task.parentId) ?? [];
    const index = slotPosition(siblings, task);
    if (siblings[index]?.task !== task) {
      throw new Error(`The task ${task.id} is not among the children of its parent.`);
    }
    siblings.splice(index, 1);
    if (siblings.length === 0) {
      table.groups.delete(task.parentId);
    }
  }
}

/** Puts the records of added and replaced tasks in the groups of their parents, where halving finds their place. */
function placeArrivingSlots(table: OutlineTable, { added, replaced }: ListChanges<Task>): void {
  for (const task of [...added, ...replaced.map(({ next }) => next)]) {
    const siblings = table.groups.get(task.parentId) ?? [];
    siblings.splice(slotPosition(siblings, task), 0, slotOf(table, task.id));
    table.groups.set(task.parentId, siblings);
  }
}

/** Finds by halving the first position of a sorted group whose task does not sort before a task. */
function slotPosition(siblings: readonly Slot[], task: Task): number {
  let low = 0;
  let high = siblings.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (compareTasks(valueAt(siblings, middle).task, task) < 0) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

/** Sorts again only the groups of records a task joins or leaves, removing a group left empty. */
function regroupSlots(
  table: OutlineTable,
  { added, replaced, removed }: ListChanges<Task>,
): OutlineTable {
  const leaving = new Set<TaskId>(
    [...removed, ...replaced.map(({ next }) => next)].map((task) => task.id),
  );
  const arriving = [...added, ...replaced.map(({ next }) => next)];
  const parents = new Set([
    ...removed.map((task) => task.parentId),
    ...replaced.flatMap(({ previous, next }) => [previous.parentId, next.parentId]),
    ...added.map((task) => task.parentId),
  ]);
  for (const parentId of parents) {
    const siblings = (table.groups.get(parentId) ?? [])
      .filter((slot) => !leaving.has(slot.task.id))
      .concat(
        arriving.filter((task) => task.parentId === parentId).map((task) => slotOf(table, task.id)),
      );
    siblings.sort(compareSlots);
    if (siblings.length === 0) {
      table.groups.delete(parentId);
    } else {
      table.groups.set(parentId, siblings);
    }
  }
  return table;
}

/** Walks the groups of records from the root down under a new generation, writing in each reached record its number and row, and listing the rows of the tasks no collapsed summary hides. */
function walkedOutline(table: OutlineTable): PlanOutline {
  table.generation += 1;
  const { groups, generation, folded } = table;
  const rows: PlanRow[] = [];
  const numbered: Slot[] = [];
  const levels: Level[] = [
    { children: groups.get(null) ?? [], depth: 0, prefix: '', hidden: false, next: 0 },
  ];
  for (let level = levels.at(-1); level !== undefined; level = levels.at(-1)) {
    const slot = level.children[level.next];
    if (slot === undefined) {
      levels.pop();
      continue;
    }
    level.next += 1;
    const { task } = slot;
    const wbs = `${level.prefix}${String(level.next)}`;
    const children = groups.get(task.id) ?? [];
    const isCollapsed = children.length > 0 && folded.has(task.id);
    slot.wbs = wbs;
    slot.generation = generation;
    slot.row = level.hidden ? HIDDEN_ROW : rows.length;
    numbered.push(slot);
    if (!level.hidden) {
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
  return outlineOver(table, rows, generation, () => numbered);
}

/** Makes an outline whose numbers and rows are those of the records stamped with its generation, its children being read live from the groups the next outline changes. */
function outlineOver(
  table: OutlineTable,
  rows: readonly PlanRow[],
  generation: number,
  numbered: () => readonly Slot[],
): PlanOutline {
  /** Returns the record of a task the walk of this generation reached. */
  const reached = (taskId: TaskId): Slot | undefined => {
    const slot = table.slots.get(taskId);
    return slot?.generation === generation ? slot : undefined;
  };
  const outline: PlanOutline = {
    rows,
    wbsById: {
      get: (taskId) => reached(taskId)?.wbs,
      has: (taskId) => reached(taskId) !== undefined,
    },
    rowIndexById: {
      get: (taskId) => shownRow(reached(taskId)),
      has: (taskId) => shownRow(reached(taskId)) !== undefined,
    },
    childrenById: { get: (parentId) => table.groups.get(parentId)?.map((slot) => slot.task) },
  };
  numberedSlots.set(outline, numbered);
  return outline;
}

/** Returns the row of a reached record, or nothing for a record a collapsed summary hides. */
function shownRow(slot: Slot | undefined): number | undefined {
  return slot === undefined || slot.row === HIDDEN_ROW ? undefined : slot.row;
}

/** Tells whether a replaced task keeps its parent and its place among its siblings. */
function keepsPlace({ previous, next }: Replacement<Task>): boolean {
  return previous.parentId === next.parentId && previous.sortKey === next.sortKey;
}

/** Puts replaced tasks, already in their records, in the rows of an outline whose tree they keep, its numbers and rows staying the same. */
function withReplacedTasks(
  outline: PlanOutline,
  table: OutlineTable,
  replaced: readonly Replacement<Task>[],
): PlanOutline {
  const rows = outline.rows.slice();
  for (const { next } of replaced) {
    const index = outline.rowIndexById.get(next.id);
    if (index !== undefined) {
      rows[index] = { ...valueAt(rows, index), task: next };
    }
  }
  const numbered = numberedSlots.get(outline) ?? (() => []);
  const updated = outlineOver(table, rows, table.generation, numbered);
  const numbers = idsByNumber.get(outline);
  if (numbers !== undefined) {
    idsByNumber.set(updated, numbers);
  }
  return updated;
}

/** Groups the dependencies by the task they lead to in the one table kept since the first grouping, changed in place for the tasks a changed link leads to, so that every lookup given reads it live, an older basis being refused. */
export function nextIncoming(
  basis: IncomingBasis | null,
  dependencies: readonly Dependency[],
): IncomingBasis {
  if (basis !== null && basis.table.reflects !== basis.dependencies) {
    throw new Error(
      'A grouping of the dependencies was given after a newer one had changed its table.',
    );
  }
  if (basis?.dependencies === dependencies) {
    return basis;
  }
  const table =
    basis === null ? incomingTableOf(dependencies) : ownTable(incomingTables, basis.table);
  if (basis !== null) {
    regroupIncoming(table.groups, listChanges(basis.dependencies, dependencies));
  }
  table.reflects = dependencies;
  const { groups } = table;
  return { dependencies, table, incoming: { get: (taskId) => groups.get(taskId) } };
}

/** Makes the table of the dependencies grouped by the task they lead to, which later groupings change in place. */
function incomingTableOf(dependencies: readonly Dependency[]): IncomingTable {
  const table = { groups: groupedIncoming(dependencies), reflects: dependencies };
  incomingTables.set(table, table);
  return table;
}

/** Groups again, in a table of dependencies by the task they lead to, the lists of the tasks a changed dependency leads to or used to lead to. */
function regroupIncoming(
  table: Map<TaskId, readonly Dependency[]>,
  { added, replaced, removed }: ListChanges<Dependency>,
): void {
  const gone = new Set([...removed, ...replaced.map(({ previous }) => previous)]);
  const arriving = [...added, ...replaced.map(({ next }) => next)];
  const successors = new Set([...gone, ...arriving].map((dependency) => dependency.successorId));
  for (const successor of successors) {
    const kept = (table.get(successor) ?? []).filter((dependency) => !gone.has(dependency));
    const list = kept.concat(arriving.filter((dependency) => dependency.successorId === successor));
    list.sort((left, right) => compareStrings(left.id, right.id));
    if (list.length === 0) {
      table.delete(successor);
    } else {
      table.set(successor, list);
    }
  }
}

/** Groups the dependencies by the task they lead to, so that the predecessors of a row are found at once. */
export function groupIncoming(
  dependencies: readonly Dependency[],
): ReadonlyMap<TaskId, readonly Dependency[]> {
  return groupedIncoming(dependencies);
}

/** Groups the dependencies by the task they lead to in a table that can later be changed in place. */
function groupedIncoming(dependencies: readonly Dependency[]): Map<TaskId, readonly Dependency[]> {
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
  wbsById: TaskLookup<string>,
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

/** Orders two records of siblings by the sort key of their tasks, then by identifier. */
function compareSlots(left: Slot, right: Slot): number {
  return compareTasks(left.task, right.task);
}

/** Orders two sibling tasks by sort key, then by identifier. */
function compareTasks(left: Task, right: Task): number {
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
